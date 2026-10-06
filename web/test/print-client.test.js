'use strict';

// The web server's side of the PDF printer: what it sends, what it makes of
// the answer, and the settings that turn it on.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createPrinter, NO_PRINTER } = require('../lib/print-client');
const { loadConfig } = require('../lib/config');

const service = { url: 'http://neo-print.internal:8081', secret: 'the-shared-secret-word' };
const page = '<!DOCTYPE html><html><body><p>Words.</p></body></html>';

describe('the print client', () => {
  test('posts the page with the secret and the size, and reads the PDF and its page count back', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, headers: new Headers({ 'x-pages': '42' }), arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 ok').buffer };
    };
    const printer = createPrinter(service, { fetch });
    assert.equal(printer.enabled, true);
    const { pdf, pages } = await printer.render(page, { size: '5.5in 8.5in' });
    assert.equal(pages, 42);
    assert.equal(pdf.toString(), '%PDF-1.7 ok');
    assert.equal(calls[0].url, 'http://neo-print.internal:8081/render?size=5.5in%208.5in');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer the-shared-secret-word');
    assert.equal(calls[0].init.body, page);
  });

  test('a printer that is down, fails, or refuses the book is an error the page can show, with its own status kept where it is the book\'s', async () => {
    const down = createPrinter(service, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.render(page), (err) => err.status === 502 && /not answering/.test(err.message));
    const broken = createPrinter(service, { fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'Chromium fell over' }) }) });
    await assert.rejects(broken.render(page), (err) => err.status === 502 && !/Chromium/.test(err.message), 'the printer\'s own failures are not the writer\'s to read');
    const tooBig = createPrinter(service, { fetch: async () => ({ ok: false, status: 413, json: async () => ({ error: 'That book is too large to print here' }) }) });
    await assert.rejects(tooBig.render(page), (err) => err.status === 413 && /too large/.test(err.message));
  });

  test('without a printer the render is a 503 the bridge turns into the print view', async () => {
    assert.equal(NO_PRINTER.enabled, false);
    await assert.rejects(NO_PRINTER.render(page), (err) => err.status === 503);
  });

  test('the two settings come together or not at all', () => {
    const base = { NEO_DEV: '1' };
    assert.equal(loadConfig(base).print, null);
    assert.deepEqual(loadConfig({ ...base, NEO_PRINT_URL: 'http://neo-print.railway.internal:8081/', NEO_PRINT_SECRET: 'sixteen-characters-long' }).print,
      { url: 'http://neo-print.railway.internal:8081', secret: 'sixteen-characters-long' });
    assert.throws(() => loadConfig({ ...base, NEO_PRINT_URL: 'http://neo-print:8081' }), /NEO_PRINT_SECRET/);
    assert.throws(() => loadConfig({ ...base, NEO_PRINT_URL: 'http://neo-print:8081', NEO_PRINT_SECRET: 'short' }), /NEO_PRINT_SECRET/);
    assert.throws(() => loadConfig({ ...base, NEO_PRINT_URL: 'neo-print:8081', NEO_PRINT_SECRET: 'sixteen-characters-long' }), /http/);
  });
});
