'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { buildHostedPage, inlineJSON, assetVersionFor, versionAssets, PAGE_CSP } = require('../lib/page');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

describe('the hosted page', () => {
  test('is the desktop index.html with the hosted pieces slotted in', () => {
    const html = buildHostedPage({ indexHtml, i18n: { locale: 'fr', dict: { Shelf: 'Étagère' }, base: {} }, hostedConfig: { email: 'w@x.y' } });
    assert.ok(!html.includes('Content-Security-Policy'), 'the meta policy is gone; the header carries it');
    assert.ok(!html.includes('id="dragstrip"'));
    const order = ['/web/web.css', 'id="neo-i18n"', 'id="neo-hosted-config"', '/jszip.min.js', 'src="i18n.js"', '/web/web-bridge.js', 'src="covers.js"', 'src="app.js"', '/web/web-menu.js', '/web/web-history.js', '/web/web-branches.js', '/web/web-share.js', '/web/web-feedback.js', '/web/web-timeline.js', '/web/web-mindmap.js', '/web/web-map.js', '/web/web-handwriting.js', '/web/web-mobile.js']
      .map((needle) => html.indexOf(needle));
    assert.ok(order.every((i) => i >= 0), 'every piece is present');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'bridge before app.js, menu after');
    assert.ok(html.includes('"Étagère"'));
    assert.ok(html.includes('<div id="bookshelf-view">'), 'the rest of the page is untouched');
    assert.ok(html.indexOf('<meta name="viewport"') < html.indexOf('href="styles.css"'), 'a phone is told the page width before the styles load');
  });

  test('every script and stylesheet URL carries the deploy fingerprint, so a plain reload sees a deploy', () => {
    const html = buildHostedPage({ indexHtml, i18n: {}, hostedConfig: {}, assetVersion: 'abc123' });
    for (const url of ['styles.css', 'i18n.js', 'covers.js', 'app.js', '/jszip.min.js', '/web/web.css', '/web/web-bridge.js', '/web/web-menu.js', '/web/web-mobile.js']) {
      assert.ok(html.includes(`"${url}?v=abc123"`), url + ' is versioned');
    }
    assert.ok(!html.includes('.js"'), 'no script is left bare');
    assert.equal(versionAssets('<a href="https://example.com/x.js">', 'v1'), '<a href="https://example.com/x.js?v=v1">', 'any same-markup URL is fine to version; the page only loads from itself');
    assert.equal(versionAssets('<script src="app.js"></script>', ''), '<script src="app.js"></script>', 'no version, no change');
  });

  test('the fingerprint follows the files it is made from', () => {
    const here = path.join(__dirname, '..', 'public');
    const a = assetVersionFor([path.join(here, 'web.css'), path.join(here, 'web-menu.js')]);
    assert.match(a, /^[0-9a-f]{10}$/);
    assert.equal(a, assetVersionFor([path.join(here, 'web.css'), path.join(here, 'web-menu.js')]), 'stable across calls');
    assert.notEqual(a, assetVersionFor([path.join(here, 'web.css')]), 'a different set of files, a different version');
    assert.equal(assetVersionFor([path.join(here, 'nope.css')]).length, 10, 'a missing file is skipped, not fatal');
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
