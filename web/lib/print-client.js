'use strict';

// The app's end of the PDF printer (print/): one call that sends a book's
// export HTML over Railway's private network and gets the PDF back. The
// printer is optional; without NEO_PRINT_URL the bridge opens the browser's
// print view instead, and `enabled` is the only question server.js asks.

const { HttpError } = require('./http');

const RENDER_TIMEOUT_MS = 6 * 60 * 1000;   // the printer's own limits plus its queue

/**
 * @param {{ url: string, secret: string }} printer  from config.printer
 * @param {{ fetch?: Function }} [deps]               a stand-in fetch for the tests
 */
function createPrintClient(printer, deps = {}) {
  const doFetch = deps.fetch || fetch;
  return {
    enabled: true,
    /**
     * @param {string} html   the whole export document, fonts and cover inside it
     * @param {{ lang?: string, trim?: string }} [opts]
     * @returns {Promise<{ pdf: Buffer, pages: number, paged: boolean }>}
     * Throws an HttpError the route can pass on: 502 when the printer is
     * unreachable or failed, 504 when it took too long.
     */
    async render(html, opts = {}) {
      const query = new URLSearchParams();
      if (opts.lang) query.set('lang', opts.lang);
      if (opts.trim) query.set('trim', opts.trim);
      let res;
      try {
        res = await doFetch(`${printer.url}/render?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/html; charset=utf-8', Authorization: `Bearer ${printer.secret}` },
          body: html,
          signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
        });
      } catch (err) {
        if (err && err.name === 'TimeoutError') throw new HttpError(504, 'The printer took too long');
        throw new HttpError(502, `The printer could not be reached: ${(err && err.message) || err}`);
      }
      if (!res.ok) throw new HttpError(502, `The printer answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return {
        pdf: Buffer.from(await res.arrayBuffer()),
        pages: Number(res.headers.get('x-neo-pages')) || 0,
        paged: res.headers.get('x-neo-paged') !== '0'
      };
    }
  };
}

const NO_PRINT_CLIENT = { enabled: false, render: async () => { throw new HttpError(503, 'No PDF printer is configured'); } };

module.exports = { createPrintClient, NO_PRINT_CLIENT, RENDER_TIMEOUT_MS };
