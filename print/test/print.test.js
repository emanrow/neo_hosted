'use strict';

// The printer end to end: the secret, the limits, and, when a Chromium is
// at hand (CHROMIUM_PATH, or Debian's /usr/bin/chromium), a small book
// rendered to a PDF with its pages counted and its contents page numbered.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, test, before, after } = require('node:test');

const { createApp, loadConfig, secretMatches, createGate } = require('../server');
const { bookStyles, TRIMS } = require('../book');

const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const haveChromium = fs.existsSync(chromiumPath);

const BOOK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>A Small Book</title>
<style>body { font-family: serif; } .chapter { page-break-before: always; } .contents { page-break-before: always; }
.contents a { display: flex; } .contents .toc-t { flex: 1; }
@page { @bottom-center { content: counter(page); } } @page front { @bottom-center { content: none; } } .titlepage, .contents { page: front; }</style></head>
<body><div class="titlepage"><h1>A Small Book</h1><p class="auth">Ada Example</p></div>
<nav class="contents"><h2 class="hd">Contents</h2><ol>
<li><a href="#s1"><span class="toc-t">One</span><span class="toc-pg" data-for="s1"></span></a></li>
<li><a href="#s2"><span class="toc-t">Two</span><span class="toc-pg" data-for="s2"></span></a></li></ol></nav>
<section class="chapter" id="s1"><h2 class="hd">One</h2>${'<p>The lighthouse keeper counted the ships as they passed, each one a small lantern on the black water.</p>'.repeat(120)}</section>
<section class="chapter" id="s2"><h2 class="hd">Two</h2><p>The end.</p></section></body></html>`;

describe('the printer', () => {
  test('refuses to boot without a secret unless NEO_DEV=1, and insists on a long one', () => {
    assert.throws(() => loadConfig({}), /NEO_PRINT_SECRET/);
    assert.throws(() => loadConfig({ NEO_PRINT_SECRET: 'short' }), /16 characters/);
    assert.equal(loadConfig({ NEO_DEV: '1' }).secret, '');
    assert.equal(loadConfig({ NEO_PRINT_SECRET: 'a'.repeat(32), NEO_PRINT_CONCURRENCY: '3' }).concurrency, 3);
  });

  test('compares the secret in constant time and lets a laptop with none in', () => {
    assert.ok(secretMatches('open-sesame-open', 'open-sesame-open'));
    assert.ok(!secretMatches('open-sesame-nope', 'open-sesame-open'));
    assert.ok(!secretMatches('', 'open-sesame-open'));
    assert.ok(secretMatches('anything', ''));
  });

  test('the gate runs at most N at once and the rest in order', async () => {
    const through = createGate(2);
    let running = 0;
    let peak = 0;
    const order = [];
    await Promise.all([1, 2, 3, 4].map((n) => through(async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(n); running -= 1;
    })));
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  test('every trim size makes a page with mirrored margins and its own type size', () => {
    for (const name of Object.keys(TRIMS)) {
      const css = bookStyles(name);
      assert.match(css, /@page \{ size: [^;]+; margin: /, name);
      assert.match(css, /@page :left \{ margin-left: ([\d.]+)in; margin-right: ([\d.]+)in; \}/, name);
      assert.match(css, /--book-type-size: [\d.]+pt/, name);
      assert.ok(TRIMS[name].contentWidthIn > 3 && TRIMS[name].contentHeightIn > 5, `${name} leaves room for words`);
    }
    assert.equal(bookStyles('no-such-trim'), bookStyles('5.5x8.5'), 'an unknown name gets the default');
  });
});

describe('the printer over HTTP', { skip: haveChromium ? false : `no Chromium at ${chromiumPath}` }, () => {
  const app = createApp({ secret: 'open-sesame-open', chromiumPath, concurrency: 1 });
  let base = '';
  before(() => new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; resolve(); })));
  after(() => app.close());

  const render = (body, { secret = 'open-sesame-open', query = '' } = {}) => fetch(base + '/render' + query, { method: 'POST', headers: { 'Content-Type': 'text/html', Authorization: 'Bearer ' + secret }, body });

  test('answers the health check and turns strangers away', async () => {
    assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
    assert.equal((await render(BOOK, { secret: 'wrong-wrong-wrong' })).status, 401);
    assert.equal((await render('just words')).status, 400, 'a fragment is not a book');
    assert.equal((await render(BOOK, { query: '?trim=tabloid' })).status, 400, 'an unknown trim');
    assert.equal((await render(BOOK, { query: '?scene=fleuron' })).status, 400, 'an unknown scene break');
    assert.equal((await fetch(base + '/nowhere')).status, 404);
  });

  test('renders a book: a PDF of the trim size, paginated by Paged.js, with the contents page numbered', async () => {
    const res = await render(BOOK, { query: '?lang=en&trim=6x9&scene=ornament' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-neo-paged'), '1');
    const pages = Number(res.headers.get('x-neo-pages'));
    assert.ok(pages >= 6, `a long chapter makes several pages (got ${pages})`);
    const pdf = Buffer.from(await res.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    // 6 × 9 in at 72 points to the inch
    const bytes = pdf.toString('latin1');
    assert.match(bytes, /\/MediaBox \[0 0 432 648\]/, 'the page is the trim size');
    // the exporter's own body margin once pushed the first page onto a second sheet, and every contents number was off by one
    assert.equal((bytes.match(/\/Type \/Page[^s]/g) || []).length, pages, 'Chromium printed exactly the pages Paged.js laid out');
  });
});
