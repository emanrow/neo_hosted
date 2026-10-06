'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { prepareForPrint, pageSizeFrom, DEFAULT_SIZE } = require('../lib/prepare');

// the shape app.js's buildHtml gives a contents entry (keep in step with it)
const tocEntry = (num, label) => `<li class="lv0 t-chapter"><a href="#s${num}"><span class="toc-t">${label}</span><span class="toc-pg" data-for="s${num}"></span></a></li>`;
const page = (body) => `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>T</title>\n<style>@page { @bottom-center { content: counter(page); } }</style></head><body>${body}</body></html>`;

describe('page sizes', () => {
  test('named sheets and unit pairs pass, anything else is refused before it reaches a stylesheet', () => {
    assert.equal(pageSizeFrom('').size, DEFAULT_SIZE);
    assert.equal(pageSizeFrom(' Letter ').size, 'Letter');
    assert.equal(pageSizeFrom('5.5in 8.5in').size, '5.5in 8.5in');
    assert.equal(pageSizeFrom('148mm 210mm').size, '148mm 210mm');
    for (const bad of ['Tabloid', 'A4;', '6in', '6 9', 'A4 } body { display: none', '5.5in 8.5in landscape']) {
      assert.match(pageSizeFrom(bad).error, /Unknown page size/, bad);
    }
  });
});

describe('preparing an export for Paged.js', () => {
  test('adds the sheet before the book\'s own rules, zeroes the body margin and hooks the end of layout', () => {
    const out = prepareForPrint(page('<p>Hi</p>'), { size: 'Letter' });
    const sheet = out.indexOf('@page { size: Letter; margin: 1in; }');
    assert.ok(sheet > 0 && sheet < out.indexOf('@bottom-center'), 'the sheet comes first, so the export\'s @page rules win');
    assert.ok(out.includes('html, body { margin: 0 !important'));
    assert.ok(out.includes('window.__neoPrintPages = flow.total'));
    assert.ok(out.includes('target-counter(attr(data-href url), page)'));
    assert.ok(!out.includes('paged.polyfill'), 'Paged.js is added by the renderer, not inlined');
  });

  test('gives each contents entry the anchor it points at, so its number can be read from the page it lands on', () => {
    const out = prepareForPrint(page(`<nav class="contents"><ol>${tocEntry(2, 'One')}${tocEntry(3, 'Two &amp; more')}</ol></nav>`));
    assert.ok(out.includes('<span class="toc-pg" data-for="s2" data-href="#s2">'));
    assert.ok(out.includes('<span class="toc-t">Two &amp; more</span><span class="toc-pg" data-for="s3" data-href="#s3">'));
    assert.ok(out.includes('@page { size: A4;'), 'A4 unless asked otherwise');
  });

  test('refuses anything but a whole page and a known size', () => {
    assert.throws(() => prepareForPrint('<p>fragment</p>'), /whole web page/);
    assert.throws(() => prepareForPrint(page(''), { size: 'A4; }' }), /Bad page size/);
  });
});
