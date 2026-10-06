'use strict';

// Pictures in a chapter (web/public/web-figures.js): where they sit among the
// paragraphs the exports keep, how they are laid into the export data with
// their mark, and how the EPUB, the Word file and the export HTML carry
// them. The page side (the upload, the caret, the stylesheet) is covered by
// the smoke and epubcheck runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const figures = require('../public/web-figures.js');

const { MARK_OPEN: O, MARK_CLOSE: C } = figures;
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

test('the figures land in the export data where the chapter has them, each with its mark', () => {
  const section = { num: 3, chId: 'ch-1', paras: [exported('One.'), exported('Two.'), exported('A hill at dusk'), exported('Three.')] };
  const placed = figures.placeFigures([
    para('One.'), para('', { figure: { file: 'fig-1.jpg', size: '600x400' } }), para('Two.'),
    para('A hill at dusk', { figure: { file: 'fig-2.png', size: '' } }), para('Three.')
  ]);
  const laid = figures.layIntoSection(section, placed, (f) => '/library/b/' + f.file);
  assert.deepEqual(laid.map((l) => l.at), [1, 3]);
  assert.deepEqual(section.paras.map((p) => p.text), ['One.', '', 'Two.', 'A hill at dusk', 'Three.']);
  assert.equal(section.paras[1].html, `<figure class="figure"><span class="fig-mark" hidden>${O}fig-1.jpg|600x400${C}</span><img src="/library/b/fig-1.jpg" alt="" width="600" height="400"></figure>`);
  assert.equal(section.paras[3].html, `<figure class="figure"><span class="fig-mark" hidden>${O}fig-2.png|${C}</span><img src="/library/b/fig-2.png" alt="A hill at dusk"><figcaption>A hill at dusk</figcaption></figure>`);
  assert.equal(section.paras[3].figure.file, 'fig-2.png');
  assert.deepEqual(figures.markedFiles(section.paras.map((p) => p.html).join('')), ['fig-1.jpg', 'fig-2.png']);
  // a caption that no longer matches its paragraph is left as words
  const other = { num: 4, paras: [exported('Changed.')] };
  assert.deepEqual(figures.layIntoSection(other, [{ index: 0, replace: true, figure: { file: 'fig-9.jpg', caption: 'Old caption' } }], () => 'x'), []);
  assert.equal(other.paras[0].html, '<p>Changed.</p>');
});

// what app.js's builders make of a marked paragraph: the mark and the caption as words
const xhtml = `<section epub:type="chapter"><h1>Three</h1><p class="byline">by me</p>\n<p class="first">One.</p>\n<p>${O}fig-1.jpg|600x400${C}</p>\n<p>Two.</p>\n<p>${O}fig-2.png|${C}A hill at <em>dusk</em></p>\n<p>Three.</p>\n</section>`;

test('the EPUB gets the image files, their manifest items and a <figure> for each marked paragraph', () => {
  const entries = [
    { path: 'mimetype', content: 'application/epub+zip', store: true },
    { path: 'OEBPS/content.opf', content: '<manifest>\n<item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>\n</manifest>' },
    { path: 'OEBPS/style.css', content: 'body { font-family: serif; }' },
    { path: 'OEBPS/ch3.xhtml', content: xhtml }
  ];
  const out = figures.epubEntries(entries, { 'fig-1.jpg': 'AAAA', 'fig-2.png': 'BBBB' });
  const ch = out.find((e) => e.path === 'OEBPS/ch3.xhtml').content;
  assert.equal(ch, '<section epub:type="chapter"><h1>Three</h1><p class="byline">by me</p>\n<p class="first">One.</p>\n'
    + '<figure class="figure"><img src="images/fig-1.jpg" alt="" width="600" height="400"/></figure>\n<p>Two.</p>\n'
    + '<figure class="figure"><img src="images/fig-2.png" alt="A hill at dusk"/><figcaption>A hill at <em>dusk</em></figcaption></figure>\n<p>Three.</p>\n</section>');
  assert.deepEqual(out.filter((e) => e.path.startsWith('OEBPS/images/')), [
    { path: 'OEBPS/images/fig-1.jpg', content: 'AAAA', base64: true },
    { path: 'OEBPS/images/fig-2.png', content: 'BBBB', base64: true }
  ]);
  const opf = out.find((e) => e.path === 'OEBPS/content.opf').content;
  assert.match(opf, /<item id="fig-1" href="images\/fig-1.jpg" media-type="image\/jpeg"\/>\n<item id="fig-2" href="images\/fig-2.png" media-type="image\/png"\/>\n<\/manifest>/);
  assert.ok(out.find((e) => e.path === 'OEBPS/style.css').content.endsWith(figures.EXPORT_CSS));
  assert.equal(entries[3].content.includes('<figure'), false, 'the input is not changed');
  // a picture whose bytes did not arrive stays as its caption, mark gone, and nothing else is added
  const kept = figures.epubEntries(entries, {});
  assert.equal(kept.find((e) => e.path === 'OEBPS/ch3.xhtml').content, xhtml.split(O).join('').replace(/fig-1\.jpg\|600x400|fig-2\.png\|/g, ''));
  assert.equal(kept.length, entries.length);
});

test('the Word file gets an inline drawing and a centred caption for each marked paragraph, with its media, relationship and content type', () => {
  const p = (inner, pPr = '<w:pPr><w:ind w:firstLine="480"/></w:pPr>') => `<w:p>${pPr}${inner}</w:p>`;
  const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + p(run('One.')) + p(run(`${O}fig-1.jpg|600x400${C}`)) + p(run('Two.')) + p(run(`${O}fig-2.png|${C}A hill at `) + `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">dusk</w:t></w:r>`) + p(run('Three.'))
    + '\n<w:sectPr/>\n</w:body></w:document>';
  const entries = [
    { path: '[Content_Types].xml', content: '<Types>\n<Default Extension="rels" ContentType="x"/>\n<Default Extension="xml" ContentType="application/xml"/>\n<Override PartName="/word/document.xml" ContentType="y"/>\n</Types>' },
    { path: 'word/_rels/document.xml.rels', content: '<Relationships>\n<Relationship Id="rId1" Type="s" Target="styles.xml"/>\n</Relationships>' },
    { path: 'word/document.xml', content: docXml },
    { path: 'word/styles.xml', content: '<w:styles/>' }
  ];
  const out = figures.docxEntries(entries, { 'fig-1.jpg': 'AAAA', 'fig-2.png': 'BBBB' });
  const doc = out.find((e) => e.path === 'word/document.xml').content;
  assert.ok(doc.includes('xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'), 'the drawing namespaces are declared');
  assert.ok(doc.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'));
  const drawings = doc.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g);
  assert.equal(drawings.length, 2);
  assert.match(drawings[0], /<wp:extent cx="5715000" cy="3810000"\/>/, '600 by 400 px at 96 dpi');
  assert.match(drawings[0], /<a:blip r:embed="rIdFig1"\/>/);
  assert.match(drawings[0], /<wp:docPr id="1" name="Picture 1" descr=""\/>/);
  assert.match(drawings[1], /<wp:docPr id="2" name="Picture 2" descr="A hill at dusk"\/>/);
  assert.match(drawings[1], /<a:blip r:embed="rIdFig2"\/>/);
  // the captionless picture's empty paragraph is gone; the caption keeps its runs and is centred
  assert.equal(doc.includes(`${O}`), false, 'no mark is left');
  assert.ok(doc.includes('</w:drawing></w:r></w:p><w:p><w:pPr><w:ind w:firstLine="480"/></w:pPr><w:r><w:t xml:space="preserve">Two.</w:t></w:r></w:p>'), 'the first picture stands alone before Two.');
  assert.ok(doc.includes('</w:drawing></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:r><w:t xml:space="preserve">A hill at </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">dusk</w:t></w:r></w:p>'), 'the caption follows its picture');
  assert.deepEqual(out.filter((e) => e.path.startsWith('word/media/')), [
    { path: 'word/media/fig-1.jpg', content: 'AAAA', base64: true },
    { path: 'word/media/fig-2.png', content: 'BBBB', base64: true }
  ]);
  const rels = out.find((e) => e.path === 'word/_rels/document.xml.rels').content;
  assert.match(rels, /<Relationship Id="rIdFig1" Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/image" Target="media\/fig-1.jpg"\/>\n<Relationship Id="rIdFig2" [^>]*Target="media\/fig-2.png"\/>\n<\/Relationships>/);
  const types = out.find((e) => e.path === '[Content_Types].xml').content;
  assert.match(types, /<Default Extension="jpg" ContentType="image\/jpeg"\/>\n<Default Extension="png" ContentType="image\/png"\/>\n<Override/);
  assert.equal(entries[2].content, docXml, 'the input is not changed');
  // a tall picture is held to the page, a wide one to the text width
  assert.deepEqual(figures.docxExtent({ width: 2000, height: 1000 }), { cx: 5943600, cy: 2971800 });
  assert.deepEqual(figures.docxExtent({ width: 1000, height: 3000 }), { cx: 2438400, cy: 7315200 });
  assert.deepEqual(figures.docxExtent(null), { cx: 3657600, cy: 2743200 });
  // without bytes, the mark goes and the caption stays a paragraph
  const kept = figures.docxEntries(entries, {});
  const keptDoc = kept.find((e) => e.path === 'word/document.xml').content;
  assert.equal(keptDoc.includes('<w:drawing>'), false);
  assert.equal(keptDoc.includes(O), false);
  assert.ok(keptDoc.includes(p(run('One.')) + p(run('Two.'))), 'the captionless picture left no empty paragraph');
  assert.equal(kept.length, entries.length);
});

test('the export HTML takes the bytes in, drops the marks and puts the figure styles in its head', async () => {
  const fig = (src) => `<figure class="figure"><span class="fig-mark" hidden>${O}fig-1.jpg|${C}</span><img src="${src}" alt=""></figure>`;
  const html = `<html><head><title>x</title></head><body>${fig('/library/b/fig-1.jpg')}<p>Words</p>${fig('/library/b/fig-1.jpg')}</body></html>`;
  const asked = [];
  const out = await figures.inlineHtml(html, (file, url) => { asked.push([file, url]); return Promise.resolve('data:image/jpeg;base64,AAAA'); });
  assert.deepEqual(asked, [['fig-1.jpg', '/library/b/fig-1.jpg'], ['fig-1.jpg', '/library/b/fig-1.jpg']]);
  assert.equal((out.match(/src="data:image\/jpeg;base64,AAAA"/g) || []).length, 2);
  assert.equal(out.includes('fig-mark'), false, 'the marks are gone');
  assert.equal(out.includes(O), false);
  assert.ok(out.includes('<style>\n' + figures.EXPORT_CSS + '</style>\n</head>'));
  const plain = '<html><head></head><body><p>No pictures</p></body></html>';
  assert.equal(await figures.inlineHtml(plain, () => { throw new Error('not asked'); }), plain);
  // bytes that never came leave the URL, which the page can still fetch
  const left = await figures.inlineHtml(html, () => Promise.resolve(null));
  assert.equal((left.match(/src="\/library\/b\/fig-1.jpg"/g) || []).length, 2);
  // the mark span as a browser serialises it (hidden="") goes too
  assert.equal((await figures.inlineHtml(html.replace(/ hidden>/g, ' hidden="">'), () => Promise.resolve(null))).includes('fig-mark'), false);
});
