'use strict';

// The app's end of the PDF printer (print/): one call that sends a book's
// export HTML over Railway's private network and gets the PDF back. The
// printer is optional; without NEO_PRINT_URL the bridge opens the browser's
// print view instead, and `enabled` is the only question server.js asks.

const { HttpError } = require('./http');

const RENDER_TIMEOUT_MS = 6 * 60 * 1000;   // the printer's own limits plus its queue

/**
 * What the export dialog offers, by the names the printer knows (print/book.js
 * is the other copy; print-client.test.js keeps the two lists the same). The
 * labels are translated in the page.
 */
const PRINT_CHOICES = {
  trims: [
    { value: '5.5x8.5', label: '5.5 × 8.5 in (trade paperback)' },
    { value: '6x9', label: '6 × 9 in' },
    { value: 'a5', label: 'A5' },
    { value: 'letter', label: 'Letter' },
    { value: 'a4', label: 'A4' }
  ],
  scenes: [
    { value: 'asterisks', label: 'Three asterisks' },
    { value: 'ornament', label: 'An ornament' },
    { value: 'blank', label: 'A blank line' }
  ],
  defaults: { trim: '5.5x8.5', scene: 'asterisks' }
};

/** The writer's print settings with only the choices the printer knows kept; the rest fall back on the defaults. */
function printSettingsFrom(saved) {
  const allowed = (list, value) => list.some((o) => o.value === value) ? value : null;
  return {
    trim: allowed(PRINT_CHOICES.trims, saved && saved.trim) || PRINT_CHOICES.defaults.trim,
    scene: allowed(PRINT_CHOICES.scenes, saved && saved.scene) || PRINT_CHOICES.defaults.scene
  };
}

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
     * @param {{ lang?: string, trim?: string, scene?: string, layout?: 'book'|'sheet' }} [opts]  a sheet (a chart) brings its own @page and skips the book's styles
     * @returns {Promise<{ pdf: Buffer, pages: number, paged: boolean }>}
     * Throws an HttpError the route can pass on: 502 when the printer is
     * unreachable or failed, 504 when it took too long.
     */
    async render(html, opts = {}) {
      const query = new URLSearchParams();
      if (opts.lang) query.set('lang', opts.lang);
      if (opts.trim) query.set('trim', opts.trim);
      if (opts.scene) query.set('scene', opts.scene);
      if (opts.layout) query.set('layout', opts.layout);
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

module.exports = { createPrintClient, NO_PRINT_CLIENT, PRINT_CHOICES, printSettingsFrom, RENDER_TIMEOUT_MS };
