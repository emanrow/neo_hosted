'use strict';

// NEO, hosted: the PDF printer, as its own service.
//
// The web server (web/server.js) answers File → Export → PDF by posting the
// export's HTML here and handing the bytes back to the browser. This process
// is headless Chromium and Paged.js behind two routes, and nothing else:
//
//   GET  /healthz          ok
//   POST /render?size=A4   Authorization: Bearer <NEO_PRINT_SECRET>
//                          body: the export's HTML (text/html)
//                          → application/pdf, X-Pages: how many
//
//   PORT                   Railway sets it. Default 8081.
//   NEO_PRINT_SECRET       Required: the word the web server must present.
//   NEO_PRINT_CONCURRENCY  Books laid out at the same time. Default 2.
//   NEO_PRINT_TIMEOUT_MS   A book that takes longer is given up on. Default 180000.
//   CHROMIUM_PATH          A Chromium to use instead of Playwright's own (a laptop).
//
// It keeps nothing: no words are written to disk, no log line carries any
// (sizes and timings only). docs/print-service.md says how it is deployed.

const http = require('node:http');
const crypto = require('node:crypto');
const { createRenderer } = require('./lib/renderer');
const { pageSizeFrom } = require('./lib/prepare');

const BODY_LIMIT = 48 * 1024 * 1024;   // a whole book with its fonts and cover inlined

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'That book is too large to print here')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sendJSON = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

/** The secret compared in constant time, so a wrong one is as slow as a right one. */
function authorized(req, secret) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/**
 * The server, not yet listening. `deps.renderer` lets a test stand in for Chromium.
 * @param {{ secret: string, chromiumPath?: string, concurrency?: number, timeoutMs?: number, log?: function }} config
 */
function createPrintApp(config, deps = {}) {
  if (!config.secret || config.secret.length < 16) throw new Error('NEO_PRINT_SECRET is not set (16+ characters); the web server presents it on every book');
  const log = config.log || ((line) => console.log(`[print] ${line}`));
  const renderer = deps.renderer || createRenderer({ chromiumPath: config.chromiumPath, concurrency: config.concurrency, timeoutMs: config.timeoutMs, log });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    if (req.method !== 'POST' || url.pathname !== '/render') throw new HttpError(404, 'Not found');
    if (!authorized(req, config.secret)) throw new HttpError(401, 'The print secret is missing or wrong');
    const { size, error } = pageSizeFrom(url.searchParams.get('size'));
    if (error) throw new HttpError(400, error);
    const html = (await readBody(req, BODY_LIMIT)).toString('utf8');
    if (!/^\s*<!doctype html/i.test(html)) throw new HttpError(400, 'A whole web page is needed');
    const { pdf, pages } = await renderer.render(html, { size });
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'X-Pages': String(pages), 'Cache-Control': 'no-store' });
    res.end(pdf);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`render failed: ${err.message}`);
      if (!res.headersSent) sendJSON(res, status, { ok: false, error: status === 500 ? 'The book could not be printed' : err.message });
      else res.destroy();
    });
  });
  server.requestTimeout = 0;   // a long book takes a while to arrive and longer to print
  server.headersTimeout = 60000;

  return { server, renderer, close: async () => { await renderer.close(); server.close(); } };
}

function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT) || 8081,
    secret: env.NEO_PRINT_SECRET || '',
    chromiumPath: env.CHROMIUM_PATH || '',
    concurrency: Number(env.NEO_PRINT_CONCURRENCY) || 2,
    timeoutMs: Number(env.NEO_PRINT_TIMEOUT_MS) || 180000
  };
}

if (require.main === module) {
  const config = configFromEnv();
  let app;
  try { app = createPrintApp(config); } catch (err) { console.error(err.message); process.exit(1); }
  app.server.listen(config.port, () => console.log(`NEO print listening on :${config.port}  concurrency: ${config.concurrency}  timeout: ${config.timeoutMs} ms`));
  const stop = () => { app.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createPrintApp, configFromEnv, BODY_LIMIT };
