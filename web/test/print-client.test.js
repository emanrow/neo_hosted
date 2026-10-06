'use strict';

// The app's end of the printer: what it sends, what it makes of the answer,
// and the HttpErrors it turns failures into, with a stand-in fetch.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createPrintClient, NO_PRINT_CLIENT, PRINT_CHOICES, printSettingsFrom } = require('../lib/print-client');
const printerBook = require('../../print/book');

const printer = { url: 'http://neo-print.internal:8080', secret: 'open-sesame-open' };
const answer = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
  arrayBuffer: async () => Buffer.from(body),
  text: async () => String(body)
});

describe('the print client', () => {
  test('sends the document with the secret, the language and the trim, and reads the page count back', async () => {
    const sent = [];
    const client = createPrintClient(printer, { fetch: async (url, init) => { sent.push({ url, init }); return answer(200, '%PDF-1.4', { 'x-neo-pages': '212', 'x-neo-paged': '1' }); } });
    assert.equal(client.enabled, true);
    const out = await client.render('<html><body>A book</body></html>', { lang: 'fr', trim: 'a5', scene: 'blank' });
    assert.equal(out.pdf.toString(), '%PDF-1.4');
    assert.equal(out.pages, 212);
    assert.equal(out.paged, true);
    assert.equal(sent[0].url, 'http://neo-print.internal:8080/render?lang=fr&trim=a5&scene=blank');
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers.Authorization, 'Bearer open-sesame-open');
    assert.equal(sent[0].init.body, '<html><body>A book</body></html>');
    assert.ok(sent[0].init.signal instanceof AbortSignal, 'with a timeout');
    await client.render('<html><body>A chart</body></html>', { lang: 'en', layout: 'sheet' });
    assert.equal(sent[1].url, 'http://neo-print.internal:8080/render?lang=en&layout=sheet', 'a sheet goes up with no trim');
  });

  test('a printer that is down, slow or unhappy becomes an HttpError the route can pass on', async () => {
    const down = createPrintClient(printer, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.render('<html></html>'), (err) => err.status === 502 && /ECONNREFUSED/.test(err.message));
    const slow = createPrintClient(printer, { fetch: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
    await assert.rejects(slow.render('<html></html>'), (err) => err.status === 504);
    const unhappy = createPrintClient(printer, { fetch: async () => answer(401, 'Wrong or missing NEO_PRINT_SECRET') });
    await assert.rejects(unhappy.render('<html></html>'), (err) => err.status === 502 && /401.*NEO_PRINT_SECRET/.test(err.message));
    const unpaged = createPrintClient(printer, { fetch: async () => answer(200, '%PDF-1.4', { 'x-neo-paged': '0' }) });
    assert.equal((await unpaged.render('<html></html>')).paged, false, 'Chromium alone printed it');
  });

  test('the choices the page offers are the names the printer knows', () => {
    assert.deepEqual(PRINT_CHOICES.trims.map((o) => o.value), Object.keys(printerBook.TRIMS));
    for (const o of PRINT_CHOICES.trims) {
      const trim = printerBook.TRIMS[o.value];
      for (const k of ['contentWidthIn', 'contentHeightIn', 'type', 'leading']) assert.ok(Math.abs(o[k] - trim[k]) < 1e-9, `${o.value} ${k} matches the printer (${o[k]} vs ${trim[k]})`);
    }
    assert.deepEqual(PRINT_CHOICES.scenes.map((o) => o.value), Object.keys(printerBook.SCENES));
    assert.equal(PRINT_CHOICES.defaults.trim, printerBook.DEFAULT_TRIM);
    assert.equal(PRINT_CHOICES.defaults.scene, printerBook.DEFAULT_SCENE);
    assert.deepEqual(printSettingsFrom(undefined), PRINT_CHOICES.defaults);
    assert.deepEqual(printSettingsFrom({ trim: '6x9', scene: 'nope' }), { trim: '6x9', scene: 'asterisks' });
  });

  test('without a printer, the client says so and renders nothing', async () => {
    assert.equal(NO_PRINT_CLIENT.enabled, false);
    await assert.rejects(NO_PRINT_CLIENT.render('<html></html>'), (err) => err.status === 503);
  });
});
