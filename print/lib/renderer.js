'use strict';

// One warm Chromium, a fresh browser context per book, a few at a time.
//
// The page a writer sends is self-contained (fonts and the cover are data:
// URLs), so every network request from inside it is refused: the HTML a
// signed-in writer posts runs as script here only through Paged.js, and it
// cannot reach anything beside the page it is. The sandbox is off because
// the container runs Chromium as an unprivileged user with no SUID helper;
// nothing else lives in this service.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { prepareForPrint } = require('./prepare');

const PAGED_JS = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js'), 'utf8');

/** A gate that lets `limit` renders run at once and queues the rest. */
function semaphore(limit) {
  let running = 0;
  const waiting = [];
  const release = () => { running--; const next = waiting.shift(); if (next) { running++; next(); } };
  return {
    acquire: () => new Promise((resolve) => {
      if (running < limit) { running++; resolve(release); } else waiting.push(() => resolve(release));
    }),
    get pending() { return waiting.length; },
    get running() { return running; }
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.chromiumPath]  an executable to use instead of Playwright's own
 * @param {number} [opts.concurrency]   books laid out at the same time (default 2)
 * @param {number} [opts.timeoutMs]     a book that takes longer than this is given up on (default 180 s)
 * @param {function} [opts.log]
 */
function createRenderer({ chromiumPath, concurrency = 2, timeoutMs = 180000, log = () => {} } = {}) {
  const gate = semaphore(concurrency);
  let browserPromise = null;

  async function browser() {
    if (!browserPromise) {
      browserPromise = chromium.launch({
        ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      }).then((b) => {
        b.on('disconnected', () => { browserPromise = null; log('chromium exited; the next book starts it again'); });
        return b;
      }).catch((err) => { browserPromise = null; throw err; });
    }
    return browserPromise;
  }

  /** The book as PDF bytes, with the page count Paged.js arrived at. */
  async function render(html, { size } = {}) {
    const prepared = prepareForPrint(html, { size });
    const release = await gate.acquire();
    const started = Date.now();
    let context = null;
    try {
      context = await (await browser()).newContext({ javaScriptEnabled: true });
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(prepared, { waitUntil: 'load', timeout: timeoutMs });
      await page.addScriptTag({ content: PAGED_JS });
      await page.waitForFunction(() => typeof window.__neoPrintPages === 'number', null, { timeout: timeoutMs });
      const pages = await page.evaluate(() => window.__neoPrintPages);
      // chapter headings become the PDF's bookmarks and the text is tagged
      // for screen readers, as the desktop's printToPDF does
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: false, outline: true, tagged: true, timeout: timeoutMs });
      log(`rendered ${pages} pages in ${Date.now() - started} ms, ${pdf.length} bytes`);
      return { pdf, pages };
    } finally {
      if (context) await context.close().catch(() => {});
      release();
    }
  }

  async function close() {
    const b = browserPromise;
    browserPromise = null;
    if (b) await (await b).close().catch(() => {});
  }

  return { render, close, get busy() { return gate.running; }, get queued() { return gate.pending; } };
}

module.exports = { createRenderer, PAGED_JS };
