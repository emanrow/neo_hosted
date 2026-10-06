'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { after, before, describe, test } = require('node:test');

const { createPrintApp, BODY_LIMIT } = require('../server');

const SECRET = 'a-print-secret-for-the-tests';
const page = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;

// a renderer that keeps what it was asked and answers with a recognisable PDF
const seen = [];
const stub = {
  render: async (html, opts) => { seen.push({ html, opts }); return { pdf: Buffer.from('%PDF-1.7 stub'), pages: 7 }; },
  close: async () => {}
};
const app = createPrintApp({ secret: SECRET, log: () => {} }, { renderer: stub });
let base;
const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, { method, headers, body });
const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'text/html' };

before(() => new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; resolve(); })));
after(() => app.close());

describe('the print service', () => {
  test('refuses to start without a secret', () => {
    assert.throws(() => createPrintApp({ secret: '' }, { renderer: stub }), /NEO_PRINT_SECRET/);
    assert.throws(() => createPrintApp({ secret: 'short' }, { renderer: stub }), /NEO_PRINT_SECRET/);
  });

  test('answers the health check and nothing else without the secret', async () => {
    assert.equal(await (await call('GET', '/healthz')).text(), 'ok');
    assert.equal((await call('GET', '/render')).status, 404);
    const noAuth = await call('POST', '/render', { body: page(''), headers: { 'Content-Type': 'text/html' } });
    assert.equal(noAuth.status, 401);
    const wrong = await call('POST', '/render', { body: page(''), headers: { ...auth, Authorization: 'Bearer ' + SECRET.slice(0, -1) + 'x' } });
    assert.equal(wrong.status, 401);
    assert.equal(seen.length, 0, 'nothing reached the renderer');
  });

  test('prints a whole page in the size asked for and says how many pages it made', async () => {
    const res = await call('POST', '/render?size=Letter', { body: page('<p>Words.</p>'), headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-pages'), '7');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.7 stub');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].opts.size, 'Letter');
    assert.ok(seen[0].html.includes('<p>Words.</p>'));
  });

  test('refuses a fragment, a bad size and a body past the limit', async () => {
    assert.equal((await call('POST', '/render', { body: '<p>no</p>', headers: auth })).status, 400);
    const size = await call('POST', '/render?size=Tabloid', { body: page(''), headers: auth });
    assert.equal(size.status, 400);
    assert.match((await size.json()).error, /Unknown page size/);
    const big = await call('POST', '/render', { body: Buffer.alloc(BODY_LIMIT + 1, 0x20), headers: auth }).catch(() => null);
    assert.ok(big === null || big.status === 413, 'too large is refused or cut off');
    assert.equal(seen.length, 1, 'none of them reached the renderer');
  });
});

// With a Chromium at hand (Playwright's own, or CHROMIUM_PATH), the real
// renderer lays out a small book: the folio and the contents numbers come
// from Paged.js, the bookmarks from Chromium.
const chromiumPath = process.env.CHROMIUM_PATH || '';
const haveChromium = chromiumPath ? fs.existsSync(chromiumPath) : (() => { try { return fs.existsSync(require('playwright-core').chromium.executablePath()); } catch { return false; } })();

describe('the real renderer', { skip: haveChromium ? false : 'no Chromium here (set CHROMIUM_PATH)' }, () => {
  const { createRenderer } = require('../lib/renderer');
  const renderer = createRenderer({ chromiumPath: chromiumPath || undefined, log: () => {} });
  after(() => renderer.close());

  test('lays a book out into pages, numbers the contents and bookmarks the chapters', async () => {
    const para = '<p>' + 'The light failed early that winter, and the house on the hill kept its lamps lit from four in the afternoon. '.repeat(6) + '</p>';
    const chapter = (n, title) => `<section class="chapter" id="s${n}"><h2 class="hd">${title}</h2>${para.repeat(14)}</section>`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Lamps</title><style>
  body { max-width: 620px; margin: 40px auto; font-size: 13pt; line-height: 1.7; }
  .titlepage { margin: 30vh 0 20vh; text-align: center; page-break-after: always; }
  .chapter { page-break-before: always; }
  .contents { page-break-before: always; }
  .contents .toc-pg { width: 3em; display: inline-block; text-align: right; }
  @page { @bottom-center { content: counter(page); } }
  @page front { @bottom-center { content: none; } }
  .titlepage, .contents { page: front; }
</style></head><body>
<div class="titlepage"><h1>Lamps</h1></div>
<nav class="contents"><h2 class="hd">Contents</h2><ol>
  <li><a href="#s2"><span class="toc-t">One</span><span class="toc-pg" data-for="s2"></span></a></li>
  <li><a href="#s3"><span class="toc-t">Two</span><span class="toc-pg" data-for="s3"></span></a></li>
</ol></nav>
${chapter(2, 'One')}${chapter(3, 'Two')}
</body></html>`;
    const { pdf, pages } = await renderer.render(html, { size: 'A5' });
    assert.ok(pages >= 6, `a title page, a contents page and two chapters of several pages each (${pages})`);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const text = pdf.toString('latin1');
    assert.ok(/\/MediaBox \[0 0 4(?:19|20)(?:\.\d+)? 59[45](?:\.\d+)?\]/.test(text), 'A5 sheets (Chromium rounds the points its own way)');
    assert.ok(text.includes('/Outlines'), 'the chapters are bookmarks');
    // a second book right after the first reuses the browser
    const again = await renderer.render(html, { size: 'Letter' });
    assert.ok(again.pages < pages, 'Letter holds more words per page than A5');
  });
});
