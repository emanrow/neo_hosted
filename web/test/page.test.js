'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { buildHostedPage, inlineJSON, PAGE_CSP } = require('../lib/page');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

describe('the hosted page', () => {
  test('is the desktop index.html with the hosted pieces slotted in', () => {
    const html = buildHostedPage({ indexHtml, i18n: { locale: 'fr', dict: { Shelf: 'Étagère' }, base: {} }, hostedConfig: { email: 'w@x.y' } });
    assert.ok(!html.includes('Content-Security-Policy'), 'the meta policy is gone; the header carries it');
    assert.ok(!html.includes('id="dragstrip"'));
    const order = ['/web/web.css', 'id="neo-i18n"', 'id="neo-hosted-config"', '/jszip.min.js', 'src="i18n.js"', '/web/web-bridge.js', 'src="covers.js"', 'src="app.js"', '/web/web-menu.js', '/web/web-history.js', '/web/web-branches.js', '/web/web-share.js', '/web/web-feedback.js', '/web/web-timeline.js', '/web/web-mindmap.js', '/web/web-mobile.js']
      .map((needle) => html.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), 'every piece is present');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'bridge before app.js, menu after');
    assert.ok(html.includes('"Étagère"'));
    assert.ok(html.includes('<div id="bookshelf-view">'), 'the rest of the page is untouched');
    assert.ok(html.indexOf('<meta name="viewport"') < html.indexOf('href="styles.css"'), 'a phone is told the page width before the styles load');
  });

  test('inline data cannot close its own script element', () => {
    assert.equal(inlineJSON({ s: '</script><script>alert(1)' }), '{"s":"\\u003c/script>\\u003cscript>alert(1)"}');
  });

  test('a changed upstream marker fails loudly', () => {
    assert.throws(() => buildHostedPage({ indexHtml: indexHtml.replace('<script src="app.js"></script>', ''), i18n: {}, hostedConfig: {} }), /appScript/);
  });

  test('the policy keeps scripts to the site itself', () => {
    assert.match(PAGE_CSP, /script-src 'self';/);
    assert.ok(!/script-src[^;]*unsafe/.test(PAGE_CSP));
  });
});
