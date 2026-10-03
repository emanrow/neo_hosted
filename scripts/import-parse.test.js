'use strict';

// The manuscript parser on its own: the module main.js and web/server.js
// both require, fed buffers rather than files, so the desktop path is
// covered without Electron.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const JSZip = require('jszip');

const { importBuffer, importFile, isImportable, IMPORT_EXTENSIONS, CHAPTER_WORDS, docxParagraphToMarkdown } = require('../import-parse');

const text = (s) => Buffer.from(s, 'utf8');
const prose = (chapter) => chapter.paras.filter((p) => p.text).map((p) => p.text);

/** A .docx with just enough inside for the parser: document.xml and, when given, styles.xml. */
async function docx(paragraphs, { styles } = {}) {
  const zip = new JSZip();
  const body = paragraphs.map((p) => `<w:p>${p}</w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`);
  if (styles) zip.file('word/styles.xml', styles);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const run = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t>${t}</w:t></w:r>`;

describe('what counts as a manuscript', () => {
  test('the three extensions, in any case, anywhere in a path', () => {
    assert.deepEqual(IMPORT_EXTENSIONS, ['docx', 'txt', 'md']);
    assert.ok(isImportable('Novel.docx'));
    assert.ok(isImportable('/Users/w/Desktop/NOTES.TXT'));
    assert.ok(isImportable('upload:3/draft.md'));
    assert.equal(isImportable('cover.png'), false);
    assert.equal(isImportable('novel.docx.bak'), false);
    assert.equal(isImportable(null), false);
  });

  test('CHAPTER_WORDS knows headings in NEO\'s languages and leaves prose alone', () => {
    for (const h of ['Chapter 1', 'Prologue', 'Chapitre 3', 'Capítulo 2', 'Kapitel 4', 'Hoofdstuk 1', 'Rozdział 2', 'Capitolul 1', 'Глава 1', 'Κεφάλαιο 1']) {
      assert.ok(CHAPTER_WORDS.test(h), h);
    }
    assert.equal(CHAPTER_WORDS.test('Chapters of my life'), false, 'a longer word is not the heading word');
    assert.equal(CHAPTER_WORDS.test('Capitol Hill was quiet.'), false, 'Romanian "Capitol" only before a number');
  });
});

describe('plain text and markdown', () => {
  test('"Chapter N" lines split the chapters and are not kept as text', async () => {
    const r = await importBuffer('Short Story.txt', text('Chapter 1\n\nIt began.\n\nIt went on.\n\nChapter 2\n\nIt ended.'));
    assert.equal(r.name, 'Short Story');
    assert.equal(r.chapters.length, 2);
    assert.deepEqual(prose(r.chapters[0]), ['It began.', 'It went on.']);
    assert.deepEqual(prose(r.chapters[1]), ['It ended.']);
    assert.equal(r.chapters[0].title, '', 'NEO numbers chapters itself');
  });

  test('markdown headings give chapters their titles, emphasis stripped', async () => {
    const r = await importBuffer('draft.md', text('# The Door\n\nShe knocked.\n\n## *The Hall*\n\nNobody came.'));
    assert.deepEqual(r.chapters.map((c) => c.title), ['The Door', 'The Hall']);
    assert.deepEqual(prose(r.chapters[1]), ['Nobody came.']);
  });

  test('a scene break line becomes a scene marker, and wrapped lines join', async () => {
    const r = await importBuffer('a.txt', text('One line\nwrapped here.\n\n* * *\n\nAfter the break.'));
    assert.deepEqual(r.chapters[0].paras, [{ text: 'One line wrapped here.' }, { scene: true }, { text: 'After the break.' }]);
  });

  test('a title that echoes the file name and a byline move to the title page', async () => {
    const r = await importBuffer('The Long Way Home.txt', text('The Long Way Home\n\nby Jane Doe\n\nChapter 1\n\nWe left at dawn.'));
    assert.equal(r.title, 'The Long Way Home');
    assert.equal(r.author, 'Jane Doe');
    assert.deepEqual(prose(r.chapters[0]), ['We left at dawn.']);
  });

  test('prologue and epilogue headings set the chapter\'s role, only in their place', async () => {
    const r = await importBuffer('p.txt', text('Prologue\n\nBefore.\n\nChapter 1\n\nDuring.\n\nEpilogue\n\nAfter.'));
    assert.deepEqual(r.chapters.map((c) => c.role), ['prologue', null, 'epilogue']);
  });

  test('a line that only opens with a chapter word is prose', async () => {
    const r = await importBuffer('p.txt', text('Part of me wanted to run.\n\nThe rest stayed.'));
    assert.equal(r.chapters.length, 1);
    assert.deepEqual(prose(r.chapters[0]), ['Part of me wanted to run.', 'The rest stayed.']);
  });

  test('an empty file still yields one empty chapter', async () => {
    const r = await importBuffer('empty.txt', text(''));
    assert.deepEqual(r.chapters, [{ title: '', paras: [{ text: '' }], role: null }]);
  });

  test('a string is accepted where a buffer is expected', async () => {
    const r = await importBuffer('s.md', 'Just words.');
    assert.deepEqual(prose(r.chapters[0]), ['Just words.']);
  });
});

describe('.docx', () => {
  test('bold and italic runs come back as markdown, adjacent alike runs merged', async () => {
    const buf = await docx([
      run('Plain, then ') + run('ital', '<w:i/>') + run('ics', '<w:i/>') + run(' and ') + run('bold', '<w:b/>') + run('.'),
      run('Second paragraph.')
    ]);
    const r = await importBuffer('Styled.docx', buf);
    assert.equal(r.name, 'Styled');
    assert.equal(r.chapters.length, 1);
    assert.deepEqual(prose(r.chapters[0]), ['Plain, then *italics* and **bold**.', 'Second paragraph.']);
  });

  test('an explicitly switched-off italic cancels the style\'s', () => {
    const styles = { Emph: { bold: false, italic: true } };
    const p = `<w:p><w:pPr><w:pStyle w:val="Emph"/></w:pPr>${run('on', '')}${run('off', '<w:i w:val="0"/>')}</w:p>`;
    assert.equal(docxParagraphToMarkdown(p, styles).text, '*on*off');
  });

  test('Heading styles start chapters; a page break does too', async () => {
    const buf = await docx([
      '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + run('The Door'),
      run('She knocked.'),
      '<w:r><w:br w:type="page"/></w:r>' + run('Nobody came.')
    ]);
    const r = await importBuffer('h.docx', buf);
    assert.deepEqual(r.chapters.map((c) => c.title), ['The Door', '']);
    assert.deepEqual(prose(r.chapters[1]), ['Nobody came.']);
  });

  test('italics carried by a character style in styles.xml are honored', async () => {
    const styles = '<w:styles xmlns:w="w"><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style></w:styles>';
    const buf = await docx([run('A ') + run('whisper', '<w:rStyle w:val="Emphasis"/>') + run('.')], { styles });
    const r = await importBuffer('e.docx', buf);
    assert.deepEqual(prose(r.chapters[0]), ['A *whisper*.']);
  });

  test('entities in the XML are decoded', async () => {
    const r = await importBuffer('e.docx', await docx([run('Salt &amp; pepper &lt;here&gt;')]));
    assert.deepEqual(prose(r.chapters[0]), ['Salt & pepper <here>']);
  });

  test('a zip without word/document.xml is refused by name', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    await assert.rejects(importBuffer('fake.docx', await zip.generateAsync({ type: 'nodebuffer' })), /Not a valid \.docx: fake\.docx/);
  });

  test('a caller may supply its own JSZip', async () => {
    const buf = await docx([run('Borrowed zip.')]);
    let used = false;
    const Borrowed = { loadAsync: (b) => { used = true; return JSZip.loadAsync(b); } };
    const r = await importBuffer('b.docx', buf, { JSZip: Borrowed });
    assert.ok(used);
    assert.deepEqual(prose(r.chapters[0]), ['Borrowed zip.']);
  });
});

describe('importFile, the desktop wrapper', () => {
  test('reads the file and names the book after it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-import-'));
    const fp = path.join(dir, 'From Disk.md');
    fs.writeFileSync(fp, '# One\n\nWords.\n\n# Two\n\nMore words.');
    const r = await importFile(fp);
    assert.equal(r.name, 'From Disk');
    assert.deepEqual(r.chapters.map((c) => c.title), ['One', 'Two']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
