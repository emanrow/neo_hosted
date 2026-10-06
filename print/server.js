'use strict';

// neo-print: the hosted edition's PDF printer. One headless Chromium, with
// Paged.js laying the book out as pages, behind a single route the app
// calls over Railway's private network. The app (web/server.js) sends the
// export HTML app.js built, the same document the Web Page and EPUB
// exports come from, and gets the PDF back. Nothing is kept here.
//
//   node print/server.js            (NEO_PRINT_SECRET set, or NEO_DEV=1)
//
// Routes
//   POST /render?lang=<code>&trim=<name>&scene=<name>   text/html in → application/pdf out
//        Authorization: Bearer <NEO_PRINT_SECRET>
//        X-Neo-Pages on the answer: how many pages the book made
//   GET  /healthz                          ok
//
// Environment
//   PORT                   Railway sets it. Default 8080.
//   NEO_PRINT_SECRET       The word the app must present. Required unless NEO_DEV=1.
//   CHROMIUM_PATH          The browser binary. Default /usr/bin/chromium (the image's).
//   NEO_PRINT_CONCURRENCY  Books rendered at once; the rest queue. Default 2.
//
// The page never fetches anything: every request Chromium would make for the
// document (a font, an image, a script) is refused, so the book must carry
// its own, as app.js's exporter makes it (fonts and covers as data: URLs).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { bookStyles, TRIMS, DEFAULT_TRIM, SCENES, DEFAULT_SCENE } = require('./book');

// (the package's exports map hides dist/, so the file is found by path)
const PAGED_JS = path.join(__dirname, 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js');
const BODY_LIMIT = 64 * 1024 * 1024;              // a long novel with four embedded font weights and a cover
const LOAD_TIMEOUT_MS = 60 * 1000;
const LAYOUT_TIMEOUT_MS = 180 * 1000;             // Paged.js on a very long book
const PDF_TIMEOUT_MS = 120 * 1000;

function loadConfig(env = process.env) {
  const dev = env.NEO_DEV === '1';
  const secret = String(env.NEO_PRINT_SECRET || '').trim();
  if (!secret && !dev) throw new Error('NEO_PRINT_SECRET is not set; give the app and this service the same one. Generate it with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  if (secret && secret.length < 16) throw new Error('NEO_PRINT_SECRET should be at least 16 characters');
  return {
    dev,
    port: Number(env.PORT) || 8080,
    secret,
    chromiumPath: env.CHROMIUM_PATH || '/usr/bin/chromium',
    concurrency: Math.max(1, Number(env.NEO_PRINT_CONCURRENCY) || 2)
  };
}

/** Equal-length, constant-time comparison of the presented secret with ours. */
function secretMatches(presented, secret) {
  if (!secret) return true;                       // a NEO_DEV laptop with none set
  const a = crypto.createHash('sha256').update(String(presented || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The whole body, or a 413. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** At most `limit` renders at once; the rest wait their turn in order. */
function createGate(limit) {
  let running = 0;
  const waiting = [];
  const release = () => { running -= 1; const next = waiting.shift(); if (next) next(); };
  return async function through(work) {
    if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try { return await work(); } finally { release(); }
  };
}

/**
 * The browser, started on the first book and started again if it dies.
 * One Chromium serves every render; each book gets its own page.
 */
function createBrowserKeeper(chromiumPath) {
  let browser = null;
  let starting = null;
  const launch = () => puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    // the image runs as a plain user in a container without user namespaces
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--export-tagged-pdf']
  });
  return {
    async get() {
      if (browser && browser.connected) return browser;
      if (!starting) starting = launch().then((b) => { browser = b; starting = null; return b; }, (err) => { starting = null; throw err; });
      return starting;
    },
    async close() { if (browser) { try { await browser.close(); } catch { /* already gone */ } browser = null; } }
  };
}

/**
 * Lay the book out and print it.
 *
 * Paged.js runs first (page geometry from book.css, running page numbers,
 * the contents page's numbers through target-counter); if it throws on a
 * book, Chromium prints the document unpaginated rather than answering
 * with nothing, and `paged` says which happened. The viewport is the page's
 * content box, so the exporter's `vh` paddings (a dedication a third of
 * the way down, the copyright at the foot) mean a share of the printed page.
 */
async function renderBook(browser, html, { lang, trim, scene } = {}) {
  const geometry = TRIMS[trim] || TRIMS[DEFAULT_TRIM];
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (r) => { if (r.url().startsWith('data:')) r.continue(); else r.abort(); });
    await page.setViewport({ width: Math.round(geometry.contentWidthIn * 96), height: Math.round(geometry.contentHeightIn * 96) });
    page.setDefaultTimeout(LAYOUT_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await page.evaluate(({ code, sceneClass }) => {
      if (code) document.documentElement.lang = code;
      document.body.classList.add(sceneClass);
    }, { code: String(lang || '').slice(0, 12), sceneClass: `scene-${SCENES[scene] ? scene : DEFAULT_SCENE}` });
    await page.addStyleTag({ content: bookStyles(trim) });
    await page.evaluate(() => document.fonts.ready);
    let pages = 0;
    let paged = true;
    try {
      await page.evaluate(() => { window.PagedConfig = { auto: false }; });
      await page.addScriptTag({ path: PAGED_JS });
      pages = await page.evaluate(() => window.PagedPolyfill.preview().then((flow) => flow.total));
    } catch (err) {
      paged = false;
      console.error(`[print] Paged.js gave up on this book, printing it unpaginated: ${err && err.message}`);
    }
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true, timeout: PDF_TIMEOUT_MS });
    return { pdf: Buffer.from(pdf), pages, paged };
  } finally {
    await page.close().catch(() => {});
  }
}

function createApp(config, deps = {}) {
  const keeper = deps.keeper || createBrowserKeeper(config.chromiumPath);
  const gate = createGate(config.concurrency);

  async function handleRender(url, req, res) {
    const auth = String(req.headers.authorization || '');
    if (!secretMatches(auth.replace(/^Bearer\s+/i, ''), config.secret)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Wrong or missing NEO_PRINT_SECRET'); return; }
    const html = (await readBody(req, BODY_LIMIT)).toString('utf8');
    if (!/<html[\s>]/i.test(html.slice(0, 2000))) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Send the book as a whole HTML document'); return; }
    const trim = String(url.searchParams.get('trim') || DEFAULT_TRIM);
    if (!TRIMS[trim]) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(`Unknown trim size; one of ${Object.keys(TRIMS).join(', ')}`); return; }
    const scene = String(url.searchParams.get('scene') || DEFAULT_SCENE);
    if (!SCENES[scene]) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(`Unknown scene break; one of ${Object.keys(SCENES).join(', ')}`); return; }
    const started = Date.now();
    const { pdf, pages, paged } = await gate(async () => renderBook(await keeper.get(), html, { lang: url.searchParams.get('lang'), trim, scene }));
    console.log(`[print] ${trim} ${scene} ${pages || '?'} pages, ${pdf.length} bytes, ${Date.now() - started} ms${paged ? '' : ', unpaginated'}`);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'X-Neo-Pages': String(pages), 'X-Neo-Paged': paged ? '1' : '0' });
    res.end(pdf);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
      if (req.method === 'POST' && url.pathname === '/render') return await handleRender(url, req, res);
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (err) {
      const status = (err && err.status) || 500;
      if (status >= 500) console.error('[print] render failed:', err && err.stack || err);
      if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(String((err && err.message) || err)); }
      else res.destroy();
    }
  });
  server.requestTimeout = LOAD_TIMEOUT_MS + LAYOUT_TIMEOUT_MS + PDF_TIMEOUT_MS + 30 * 1000;
  server.headersTimeout = 60 * 1000;

  return { server, close: async () => { await new Promise((resolve) => server.close(resolve)); await keeper.close(); } };
}

function main() {
  const config = loadConfig();
  if (!fs.existsSync(config.chromiumPath)) { console.error(`neo-print: no browser at ${config.chromiumPath} (set CHROMIUM_PATH)`); process.exit(1); }
  const app = createApp(config);
  // no host: Node binds every address, IPv6 included, which Railway's private network needs
  app.server.listen(config.port, () => {
    console.log(`neo-print listening on :${config.port}, ${config.concurrency} at a time, ${config.secret ? 'secret set' : 'NO SECRET (NEO_DEV)'}, trims ${Object.keys(TRIMS).join(' ')}`);
  });
  const stop = () => app.close().then(() => process.exit(0), () => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { createApp, loadConfig, renderBook, secretMatches, createGate, BODY_LIMIT, PAGED_JS };
