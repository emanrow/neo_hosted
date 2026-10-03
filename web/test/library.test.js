'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { libName, readJSON, writeJSON, writeFileDurable } = require('../lib/files');
const { openLibrary } = require('../lib/library');

const t = (key, vars) => key.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
const quiet = () => {};

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-lib-'));
  const log = [];
  const lib = openLibrary({ dir, t, logError: (source, err) => log.push(`${source}: ${err && err.message || err}`) });
  return { dir, lib, log };
}

describe('libName', () => {
  test('one plain segment passes, everything else is refused', () => {
    assert.equal(libName('book-abc-123'), 'book-abc-123');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 42, null, undefined]) {
      assert.throws(() => libName(bad), /Invalid library name/, String(bad));
    }
  });
});

describe('durable files', () => {
  test('a write leaves the file and no .tmp behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-files-'));
    const file = path.join(dir, 'a.html');
    writeFileDurable(file, '<p>words</p>');
    assert.equal(fs.readFileSync(file, 'utf8'), '<p>words</p>');
    assert.ok(!fs.existsSync(file + '.tmp'));
  });

  test('readJSON falls back on .tmp, then .bak, and restores the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-files-'));
    const file = path.join(dir, 'book.json');
    writeJSON(file, { v: 1 });
    writeJSON(file, { v: 2 }); // v1 is now the .bak
    fs.writeFileSync(file, '{"v": 2, torn'); // a power cut mid-write
    const recovered = [];
    assert.deepEqual(readJSON(file, null, (what) => recovered.push(what)), { v: 1 });
    assert.equal(recovered.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
    fs.writeFileSync(file, 'garbage');
    fs.writeFileSync(file + '.tmp', '{"v": 3}');
    assert.deepEqual(readJSON(file, null, quiet), { v: 3 }, 'the .tmp a write was making wins over the older .bak');
  });

  test('a missing file with no copies is the fallback', () => {
    assert.equal(readJSON(path.join(os.tmpdir(), 'neo-no-such-' + Date.now() + '.json'), 'fallback'), 'fallback');
  });
});

describe('a writer\'s library', () => {
  test('is seeded with one shelf on first read', () => {
    const { lib } = tempLibrary();
    const library = lib.readLibrary();
    assert.equal(library.firstRunDone, false);
    assert.equal(library.shelves[0].name, 'Works in Progress');
  });

  test('a new book is a folder laid out like the desktop app\'s', () => {
    const { dir, lib } = tempLibrary();
    const book = lib.createBook({ title: 'Capítulo Uno', author: 'A. Writer' });
    assert.match(book.id, /^book-capitulo-uno-[a-z0-9]+-[a-z0-9]+$/);
    assert.deepEqual(book.chapterOrder, []);
    for (const f of ['book.json', 'notes.html', 'outline.html', 'darlings.json', 'stickies.json', 'chapters']) {
      assert.ok(fs.existsSync(path.join(dir, book.id, f)), f);
    }
    assert.deepEqual(lib.listBooks().map((b) => b.title), ['Capítulo Uno']);
  });

  test('chapters round-trip and stamp by mtime and size', () => {
    const { lib } = tempLibrary();
    const book = lib.createBook({ title: 'Stamps' });
    assert.equal(lib.readChapter(book.id, 'ch1'), '', 'a chapter that is not there reads empty');
    lib.writeChapter(book.id, 'ch1', '<p>one</p>');
    assert.equal(lib.readChapter(book.id, 'ch1'), '<p>one</p>');
    const stamps = lib.chapterStamps(book.id);
    assert.match(stamps.ch1, /^\d+(\.\d+)?:10$/);
    lib.deleteChapter(book.id, 'ch1');
    assert.deepEqual(lib.chapterStamps(book.id), {});
    assert.throws(() => lib.writeChapter(book.id, '../escape', 'x'), /Invalid library name/);
  });

  test('book.json lost with no copy is rebuilt from the chapter files', () => {
    const { dir, lib, log } = tempLibrary();
    const book = lib.createBook({ title: 'Rebuilt' });
    lib.writeChapter(book.id, 'b', '<p>2</p>');
    lib.writeChapter(book.id, 'a', '<p>1</p>');
    lib.writeLibrary({ ...lib.readLibrary(), shelves: [{ id: 's', name: 'Shelf', bookIds: [book.id] }] }); // writes the catalog
    for (const f of ['book.json', 'book.json.bak']) fs.rmSync(path.join(dir, book.id, f), { force: true });
    const meta = lib.readBookMeta(book.id);
    assert.equal(meta.title, 'Rebuilt', 'the title comes back from the catalog');
    assert.deepEqual(meta.chapterOrder, ['a', 'b']);
    assert.ok(log.some((l) => l.startsWith('recovered')));
  });

  test('library.json unreadable with no copy puts every book back on one shelf', () => {
    const { dir, lib } = tempLibrary();
    const book = lib.createBook({ title: 'Orphan' });
    lib.writeChapter(book.id, 'c', '<p>x</p>');
    // torn beyond repair, and the .bak gone too (a missing file is simply seeded afresh, as on the desktop)
    fs.writeFileSync(path.join(dir, 'library.json'), '{"shelves": [');
    fs.rmSync(path.join(dir, 'library.json.bak'), { force: true });
    const library = lib.readLibrary();
    assert.deepEqual(library.shelves[0].bookIds, [book.id]);
    assert.equal(library.firstRunDone, true);
  });

  test('deleting a book moves it to the Trash folder, words intact', () => {
    const { dir, lib } = tempLibrary();
    const book = lib.createBook({ title: 'Doomed' });
    lib.writeChapter(book.id, 'c', '<p>keep me</p>');
    assert.equal(lib.trashBook(book.id), true);
    assert.ok(!fs.existsSync(path.join(dir, book.id)));
    const trashed = fs.readdirSync(path.join(dir, 'Trash'));
    assert.equal(trashed.length, 1);
    assert.ok(trashed[0].startsWith(book.id + '--'));
    assert.equal(fs.readFileSync(path.join(dir, 'Trash', trashed[0], 'chapters', 'c.html'), 'utf8'), '<p>keep me</p>');
    assert.equal(lib.trashBook(book.id), true, 'trashing a book that is already gone is not an error');
  });

  test('covers are stored by type, replaced, and found only by NEO\'s own names', () => {
    const { dir, lib } = tempLibrary();
    const book = lib.createBook({ title: 'Jacket' });
    assert.equal(lib.setCoverBytes(book.id, 'gif', Buffer.from('x')), null);
    const first = lib.setCoverBytes(book.id, 'jpeg', Buffer.from('one'));
    assert.match(first, /^cover-\d+\.jpg$/);
    const second = lib.setCoverBytes(book.id, 'png', Buffer.from('two'));
    assert.deepEqual(fs.readdirSync(path.join(dir, book.id)).filter((f) => f.startsWith('cover-')), [second]);
    assert.equal(lib.coverPath(book.id, second), path.join(dir, book.id, second));
    assert.equal(lib.coverPath(book.id, 'book.json'), null, 'only cover-* and art-* images are served');
    lib.removeCover(book.id);
    assert.equal(lib.coverPath(book.id, second), null);
  });

  test('the daily backup zips the library once a day and leaves Trash and Backups out', async () => {
    const { dir, lib } = tempLibrary();
    const book = lib.createBook({ title: 'Backed Up' });
    lib.writeChapter(book.id, 'c', '<p>safe</p>');
    lib.trashBook(lib.createBook({ title: 'Gone' }).id);
    assert.equal(await lib.dailyBackup(), true);
    assert.equal(await lib.dailyBackup(), false, 'one per day');
    const zips = fs.readdirSync(path.join(dir, 'Backups'));
    assert.equal(zips.length, 1);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, 'Backups', zips[0])));
    const names = Object.keys(zip.files);
    assert.ok(names.includes(`${book.id}/chapters/c.html`));
    assert.ok(!names.some((n) => n.startsWith('Trash/') || n.startsWith('Backups/')));
  });
});
