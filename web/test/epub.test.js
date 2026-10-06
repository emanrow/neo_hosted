'use strict';

// The EPUB polish on its own (web/public/web-epub.js is also a CommonJS
// module): the chosen face as font files in the manifest and the stylesheet,
// the drop cap, and an EPUB left alone when there is nothing to add.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { polishEntries, DROPCAP_CSS } = require('../public/web-epub');

const entries = () => [
  { path: 'mimetype', content: 'application/epub+zip', store: true },
  { path: 'OEBPS/content.opf', content: '<package><manifest>\n<item id="css" href="style.css" media-type="text/css"/>\n</manifest><spine/></package>' },
  { path: 'OEBPS/style.css', content: 'body { font-family: serif; }\np.first { text-indent: 0; }\n' },
  { path: 'OEBPS/ch1.xhtml', content: '<p class="first">Words.</p>' }
];
const faces = [
  { file: 'libron-latin-400-normal.woff2', base64: 'AAAA', weight: '400', style: 'normal' },
  { file: 'libron-latin-400-italic.woff2', base64: 'BBBB', weight: '400', style: 'italic' },
  { file: '../evil/../libron-latin-700-normal.woff2?v=1', base64: 'CCCC', weight: '700', style: 'normal' }
];

describe('the EPUB polish', () => {
  test('lays the face in as files, manifest items and @font-face rules, with the body set in it', () => {
    const out = polishEntries(entries(), { family: 'Libron', faces, dropcap: false });
    const fonts = out.filter((e) => e.path.startsWith('OEBPS/fonts/'));
    assert.deepEqual(fonts.map((e) => e.path), ['OEBPS/fonts/libron-latin-400-normal.woff2', 'OEBPS/fonts/libron-latin-400-italic.woff2', 'OEBPS/fonts/libron-latin-700-normal.woff2'], 'file names are basenames, query and all stripped');
    assert.ok(fonts.every((e) => e.base64 === true));
    const opf = out.find((e) => e.path === 'OEBPS/content.opf').content;
    assert.ok(opf.includes('<item id="font-1" href="fonts/libron-latin-400-normal.woff2" media-type="font/woff2"/>'));
    assert.ok(opf.includes('<item id="font-3" href="fonts/libron-latin-700-normal.woff2" media-type="font/woff2"/>\n</manifest>'), 'items sit inside the manifest');
    const css = out.find((e) => e.path === 'OEBPS/style.css').content;
    assert.ok(css.startsWith('@font-face { font-family: "Libron"; src: url("fonts/libron-latin-400-normal.woff2"); font-weight: 400; font-style: normal; }'));
    assert.ok(css.includes('font-style: italic; }'));
    assert.ok(css.includes('\nbody { font-family: "Libron", serif; }\nbody { font-family: serif; }'), 'the face rule comes before the stylesheet it overrides');
    assert.ok(!css.includes('first-letter'));
    assert.equal(out[0].path, 'mimetype', 'the mimetype entry stays first');
  });

  test('a drop cap opens chapters unless the editor hides it', () => {
    const on = polishEntries(entries(), { dropcap: true });
    assert.ok(on.find((e) => e.path === 'OEBPS/style.css').content.endsWith(DROPCAP_CSS));
    assert.ok(DROPCAP_CSS.includes('p.first:not(.dialogue)::first-letter'), 'speech keeps its indent');
    const off = polishEntries(entries(), { dropcap: false });
    assert.equal(off.find((e) => e.path === 'OEBPS/style.css').content, entries()[2].content);
  });

  test('a system face, a face with no files, or an unknown layout leaves the EPUB as it was', () => {
    const plain = entries();
    assert.deepEqual(polishEntries(plain, { family: 'Georgia', faces: [] }), plain);
    assert.deepEqual(polishEntries(plain, { family: 'Libron', faces: [{ file: 'x.exe', base64: 'AAAA' }] }), plain, 'only font files go in');
    assert.deepEqual(polishEntries(plain, { family: '', faces }), plain);
    const other = [{ path: 'docx/document.xml', content: '<w:document/>' }];
    assert.deepEqual(polishEntries(other, { family: 'Libron', faces, dropcap: true }), other);
    assert.equal(plain[2].content, entries()[2].content, 'the input is never changed');
  });
});
