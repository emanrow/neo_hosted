'use strict';

// Pictures in a chapter (web/public/web-figures.js): where they sit among the
// paragraphs the exports keep, how they are laid into the export data, and
// how the EPUB and the export HTML carry them. The page side (the upload,
// the caret, the stylesheet) is covered by the smoke and epubcheck runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const figures = require('../public/web-figures.js');

const para = (text, extra = {}) => ({ sceneBreak: false, text, ...extra });
const exported = (text) => ({ sceneBreak: false, poetry: false, flush: false, text, runs: [], align: '', html: `<p>${text}</p>` });

test('a picture sits before the next kept paragraph, or stands in for its caption', () => {
  const placed = figures.placeFigures([
    para('One.'),
    para('', { figure: { file: 'fig-1.jpg', size: '600x400' } }),      // no caption: inserted before "Two."
    para('   '),                                                       // a blank line the export drops
    para('Two.'),
    { sceneBreak: true, text: '' },
    para('A hill at dusk', { figure: { file: 'fig-2.png', size: '' } }),  // captioned: kept as a paragraph, replaced
    para('Three.'),
    para('x', { figure: { file: '../etc/passwd', size: '' } })         // not a name NEO made
  ]);
  assert.deepEqual(placed, [
    { index: 1, replace: false, figure: { file: 'fig-1.jpg', size: '600x400', caption: '' } },
    { index: 3, replace: true, figure: { file: 'fig-2.png', size: '', caption: 'A hill at dusk' } }
  ]);
  assert.deepEqual(figures.placeFigures([]), []);
});

test('the figures land in the export data where the chapter has them', () => {
  const section = { num: 3, chId: 'ch-1', paras: [exported('One.'), exported('Two.'), exported('A hill at dusk'), exported('Three.')] };
  const placed = figures.placeFigures([
    para('One.'), para('', { figure: { file: 'fig-1.jpg', size: '600x400' } }), para('Two.'),
    para('A hill at dusk', { figure: { file: 'fig-2.png', size: '' } }), para('Three.')
  ]);
  const laid = figures.layIntoSection(section, placed, (f) => '/library/b/' + f.file);
  assert.deepEqual(laid.map((l) => l.at), [1, 3]);
  assert.deepEqual(section.paras.map((p) => p.text), ['One.', '', 'Two.', 'A hill at dusk', 'Three.']);
  assert.equal(section.paras[1].html, '<figure class="figure"><img src="/library/b/fig-1.jpg" alt="" width="600" height="400"></figure>');
  assert.equal(section.paras[3].html, '<figure class="figure"><img src="/library/b/fig-2.png" alt="A hill at dusk"><figcaption>A hill at dusk</figcaption></figure>');
  assert.equal(section.paras[3].figure.file, 'fig-2.png');
  // a caption that no longer matches its paragraph is left as words
  const other = { num: 4, paras: [exported('Changed.')] };
  assert.deepEqual(figures.layIntoSection(other, [{ index: 0, replace: true, figure: { file: 'fig-9.jpg', caption: 'Old caption' } }], () => 'x'), []);
  assert.equal(other.paras[0].html, '<p>Changed.</p>');
});

test('the EPUB gets the image files, their manifest items and a <figure> for each laid paragraph', () => {
  const entries = [
    { path: 'mimetype', content: 'application/epub+zip', store: true },
    { path: 'OEBPS/content.opf', content: '<manifest>\n<item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>\n</manifest>' },
    { path: 'OEBPS/style.css', content: 'body { font-family: serif; }' },
    { path: 'OEBPS/ch3.xhtml', content: '<section epub:type="chapter"><h1>Three</h1><p class="byline">by me</p>\n<p class="first">One.</p>\n<p></p>\n<p>Two.</p>\n<p>A hill at dusk</p>\n<p>Three.</p>\n</section>' }
  ];
  const layouts = [{ num: 3, laid: [{ at: 1, figure: { file: 'fig-1.jpg', size: '600x400', caption: '' } }, { at: 3, figure: { file: 'fig-2.png', size: '', caption: 'A hill at dusk' } }] }];
  const out = figures.epubEntries(entries, layouts, { 'fig-1.jpg': 'AAAA', 'fig-2.png': 'BBBB' });
  const ch = out.find((e) => e.path === 'OEBPS/ch3.xhtml').content;
  assert.equal(ch, '<section epub:type="chapter"><h1>Three</h1><p class="byline">by me</p>\n<p class="first">One.</p>\n'
    + '<figure class="figure"><img src="images/fig-1.jpg" alt="" width="600" height="400"/></figure>\n<p>Two.</p>\n'
    + '<figure class="figure"><img src="images/fig-2.png" alt="A hill at dusk"/><figcaption>A hill at dusk</figcaption></figure>\n<p>Three.</p>\n</section>');
  assert.deepEqual(out.filter((e) => e.path.startsWith('OEBPS/images/')), [
    { path: 'OEBPS/images/fig-1.jpg', content: 'AAAA', base64: true },
    { path: 'OEBPS/images/fig-2.png', content: 'BBBB', base64: true }
  ]);
  const opf = out.find((e) => e.path === 'OEBPS/content.opf').content;
  assert.match(opf, /<item id="fig-1" href="images\/fig-1.jpg" media-type="image\/jpeg"\/>\n<item id="fig-2" href="images\/fig-2.png" media-type="image\/png"\/>\n<\/manifest>/);
  assert.ok(out.find((e) => e.path === 'OEBPS/style.css').content.endsWith(figures.EXPORT_CSS));
  assert.equal(entries[3].content.includes('<figure'), false, 'the input is not changed');
  // a picture whose bytes did not arrive stays as its caption, and nothing else is added
  const kept = figures.epubEntries(entries, layouts, {});
  assert.equal(kept.find((e) => e.path === 'OEBPS/ch3.xhtml').content, entries[3].content);
  assert.equal(kept.length, entries.length);
});

test('the export HTML takes the bytes in and the figure styles in its head', async () => {
  const html = '<html><head><title>x</title></head><body><figure class="figure"><img src="/library/b/fig-1.jpg" alt=""></figure><p>Words</p><figure class="figure"><img src="/library/b/fig-1.jpg" alt=""></figure></body></html>';
  const asked = [];
  const out = await figures.inlineHtml(html, (file, url) => { asked.push([file, url]); return Promise.resolve('data:image/jpeg;base64,AAAA'); });
  assert.deepEqual(asked, [['fig-1.jpg', '/library/b/fig-1.jpg'], ['fig-1.jpg', '/library/b/fig-1.jpg']]);
  assert.equal((out.match(/src="data:image\/jpeg;base64,AAAA"/g) || []).length, 2);
  assert.ok(out.includes('<style>\n' + figures.EXPORT_CSS + '</style>\n</head>'));
  const plain = '<html><head></head><body><p>No pictures</p></body></html>';
  assert.equal(await figures.inlineHtml(plain, () => { throw new Error('not asked'); }), plain);
  // bytes that never came leave the URL, which the page can still fetch
  const left = await figures.inlineHtml(html, () => Promise.resolve(null));
  assert.equal((left.match(/src="\/library\/b\/fig-1.jpg"/g) || []).length, 2);
});
