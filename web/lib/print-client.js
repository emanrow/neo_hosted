'use strict';

// The web server's side of the PDF printer (print/, its own service): one
// POST with the export's HTML, the PDF back. Nothing is rendered here; with
// no printer configured the bridge opens the browser's print view instead.

const { HttpError } = require('./http');

/** What stands in for the printer when NEO_PRINT_URL is unset. */
const NO_PRINTER = {
  enabled: false,
  render: async () => { throw new HttpError(503, 'No PDF printer is set up on this server'); }
};

/**
 * @param {{ url: string, secret: string }} service  from config.print
 * @param {{ fetch?: function }} [deps]               a stub fetch for tests
 */
function createPrinter(service, { fetch = globalThis.fetch } = {}) {
  const endpoint = (size) => `${service.url}/render?size=${encodeURIComponent(size)}`;

  /** The book as PDF bytes and its page count; a printer that is down or refuses is an HttpError the page can show. */
  async function render(html, { size } = {}) {
    let res;
    try {
      res = await fetch(endpoint(size || 'A4'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${service.secret}`, 'Content-Type': 'text/html; charset=utf-8' },
        body: html
      });
    } catch {
      throw new HttpError(502, 'The PDF printer is not answering');
    }
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).error || ''; } catch { /* not a JSON refusal */ }
      // what the printer says about the book (too large, a bad size) is the writer's to hear; its own failures are not
      if (res.status === 413 || res.status === 400) throw new HttpError(res.status, reason || 'The PDF printer refused the book');
      throw new HttpError(502, `The PDF printer failed (${res.status})`);
    }
    return { pdf: Buffer.from(await res.arrayBuffer()), pages: Number(res.headers.get('x-pages')) || 0 };
  }

  return { enabled: true, render };
}

module.exports = { createPrinter, NO_PRINTER };
