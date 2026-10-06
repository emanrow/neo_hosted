'use strict';

// Footnotes (web/public/web-footnotes.js): the mark a call carries through
// the editor's builders, and how each export finishes it: the web page's
// calls and notes, the EPUB's noterefs and asides, Word's real footnotes,
// plain text's and Markdown's [n]. The pad, the caret and the counter are
// covered by the epubcheck run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fn = require('../public/web-footnotes.js');

const A = fn.markOf('a1b2c');
const B = fn.markOf('zz9zz');
const notes = { a1b2c: { text: 'The first note, with <angles> & an ampersand.' }, zz9zz: { text: 'The second.' } };

test('a mark names its note in private-use characters only, and reads back', () => {
  assert.equal(fn.decodeId(fn.encodeId('a1b2c')), 'a1b2c');
  assert.ok(/^[-]+$/.test(A), 'nothing a word counter or a spellcheck would take for a word');
  assert.deepEqual(fn.markedIds(`one${A} two${B} three${A}`), ['a1b2c', 'zz9zz', 'a1b2c']);
  assert.deepEqual(fn.markedIds('plain'), []);
});

test('the web page gets numbered calls, notes for the printer and a list at the chapter\'s end', () => {
  const html = `<html><head><title>x</title></head><body>\n<section class="chapter" id="s1"><h2 class="hd">One</h2>\n<p class="first">Winter${A}, and the house${B}.</p>\n</section>\n<section class="chapter" id="s2"><p>Again${B}.</p>\n</section>\n<section class="page dedication" id="s3"><p>For them.</p></section></body></html>`;
  const out = fn.htmlWithNotes(html, notes);
  assert.ok(out.includes('<p class="first">Winter<sup class="fn-ref" id="fnref-a1b2c"><a href="#fn-a1b2c">1</a></sup><span class="fn-note">The first note, with &lt;angles&gt; &amp; an ampersand.</span>, and the house<sup class="fn-ref" id="fnref-zz9zz"><a href="#fn-zz9zz">2</a></sup><span class="fn-note">The second.</span>.</p>'));
  assert.ok(out.includes('<aside class="fn-endnotes"><ol><li id="fn-a1b2c">The first note, with &lt;angles&gt; &amp; an ampersand. <a href="#fnref-a1b2c">↩</a></li><li id="fn-zz9zz">The second. <a href="#fnref-zz9zz">↩</a></li></ol></aside>\n</section>'));
  assert.ok(out.includes('<p>Again<sup class="fn-ref" id="fnref-zz9zz"><a href="#fn-zz9zz">1</a></sup>'), 'numbers start again in the next chapter');
  assert.equal((out.match(/<aside class="fn-endnotes">/g) || []).length, 2);
  assert.ok(out.includes('<style>\n' + fn.EXPORT_CSS + '</style>\n</head>'));
  assert.equal(out.includes(''), false, 'no mark is left');
  assert.ok(out.includes('<section class="page dedication" id="s3"><p>For them.</p></section>'), 'a section without notes is as it was');
  const plain = '<html><head></head><body><section><p>No notes</p></section></body></html>';
  assert.equal(fn.htmlWithNotes(plain, notes), plain);
  // a call to a note that does not exist is dropped
  assert.equal(fn.htmlWithNotes(`<html><head></head><body><section><p>Lost${fn.markOf('nope1')} call</p></section></body></html>`, notes), '<html><head></head><body><section><p>Lost call</p></section></body></html>');
});

test('the EPUB gets noteref calls and footnote asides at the end of the chapter\'s section', () => {
  const entries = [
    { path: 'OEBPS/style.css', content: 'body { }' },
    { path: 'OEBPS/ch1.xhtml', content: `<html><body><section epub:type="chapter"><h1>One</h1>\n<p class="first">Winter${A}, and the house${B}.</p>\n</section></body></html>` },
    { path: 'OEBPS/ch2.xhtml', content: '<html><body><section epub:type="chapter"><p>Nothing here.</p></section></body></html>' }
  ];
  const out = fn.epubEntries(entries, notes);
  const ch1 = out.find((e) => e.path === 'OEBPS/ch1.xhtml').content;
  assert.ok(ch1.includes('Winter<sup class="fn-ref" id="fnref-a1b2c"><a epub:type="noteref" href="#fn-a1b2c">1</a></sup>, and the house<sup class="fn-ref" id="fnref-zz9zz"><a epub:type="noteref" href="#fn-zz9zz">2</a></sup>.</p>'));
  assert.ok(ch1.endsWith('\n<aside epub:type="footnote" class="fn-note" id="fn-a1b2c"><p>1. The first note, with &lt;angles&gt; &amp; an ampersand.</p></aside>\n<aside epub:type="footnote" class="fn-note" id="fn-zz9zz"><p>2. The second.</p></aside>\n</section></body></html>'));
  assert.equal(out.find((e) => e.path === 'OEBPS/ch2.xhtml').content, entries[2].content);
  assert.ok(out.find((e) => e.path === 'OEBPS/style.css').content.includes('sup.fn-ref'));
  assert.equal(entries[1].content.includes('<aside'), false, 'the input is not changed');
});

test('the Word file gets real footnotes: a reference run in the text and word/footnotes.xml', () => {
  const run = (text, rPr = '') => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const docXml = `<w:document xmlns:w="x"><w:body><w:p><w:pPr></w:pPr>${run(`Winter${A}, and `)}${run(`the house${B}.`, '<w:rPr><w:i/></w:rPr>')}</w:p></w:body></w:document>`;
  const entries = [
    { path: '[Content_Types].xml', content: '<Types>\n<Override PartName="/word/document.xml" ContentType="y"/>\n</Types>' },
    { path: 'word/_rels/document.xml.rels', content: '<Relationships>\n<Relationship Id="rId1" Type="s" Target="styles.xml"/>\n</Relationships>' },
    { path: 'word/document.xml', content: docXml }
  ];
  const out = fn.docxEntries(entries, notes);
  const doc = out.find((e) => e.path === 'word/document.xml').content;
  assert.equal(doc, '<w:document xmlns:w="x"><w:body><w:p><w:pPr></w:pPr>'
    + run('Winter') + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>' + run(', and ')
    + run('the house', '<w:rPr><w:i/></w:rPr>') + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r>' + run('.', '<w:rPr><w:i/></w:rPr>')
    + '</w:p></w:body></w:document>');
  const notesXml = out.find((e) => e.path === 'word/footnotes.xml').content;
  assert.ok(notesXml.includes('<w:footnote w:type="separator" w:id="-1">'));
  assert.ok(notesXml.includes('<w:footnote w:id="1"><w:p>'));
  assert.ok(notesXml.includes('<w:footnoteRef/></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve"> The first note, with &lt;angles&gt; &amp; an ampersand.</w:t>'));
  assert.ok(notesXml.includes('<w:footnote w:id="2">'));
  assert.ok(out.find((e) => e.path === 'word/_rels/document.xml.rels').content.includes('<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>\n</Relationships>'));
  assert.ok(out.find((e) => e.path === '[Content_Types].xml').content.includes('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>\n</Types>'));
  assert.equal(entries[2].content, docXml, 'the input is not changed');
  // without any mark nothing is added
  const same = fn.docxEntries([{ path: 'word/document.xml', content: '<w:document/>' }, entries[0], entries[1]], notes);
  assert.equal(same.length, 3);
});

test('plain text and Markdown get [n] calls and the notes at the end', () => {
  assert.equal(fn.txtWithNotes(`WINTER\n\nThe house${A} on the hill${B}.\n\n`, notes), 'WINTER\n\nThe house[1] on the hill[2].\n\n\nNOTES\n\n[1] The first note, with <angles> & an ampersand.\n[2] The second.\n');
  assert.equal(fn.txtWithNotes(`The house${A}.`, notes, 'ANMERKUNGEN'), 'The house[1].\n\n\nANMERKUNGEN\n\n[1] The first note, with <angles> & an ampersand.\n');
  assert.equal(fn.mdWithNotes(`# Winter\n\nThe house${A} on the hill${B}.\n`, notes), '# Winter\n\nThe house[^1] on the hill[^2].\n\n[^1]: The first note, with <angles> & an ampersand.\n[^2]: The second.\n');
  assert.equal(fn.txtWithNotes('No notes.\n', notes), 'No notes.\n');
  assert.equal(fn.mdWithNotes(`Lost${fn.markOf('nope1')}.`, notes), 'Lost.');
});
