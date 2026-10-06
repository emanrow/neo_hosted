'use strict';

// library-disk.js on its own: the rules both editions trust their books to.
// main.js and web/lib/library.js require the same module, so this is the one
// place the rules are checked; the desktop's power-loss test and the hosted
// library test check them again through each caller.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const disk = require('../library-disk');

const t = (key) => key;
const logged = [];
const logError = (source, err) => logged.push(`${source}: ${err instanceof Error ? err.message : err}`);
const library = disk.forLibrary({ t, logError });

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'neo-disk-'));
const bookWithChapters = (dir, id, chapters) => {
  const folder = path.join(dir, id, 'chapters');
  fs.mkdirSync(folder, { recursive: true });
  for (const ch of chapters) fs.writeFileSync(path.join(folder, ch + '.html'), '<p>words</p>');
  return path.join(dir, id);
};

describe('a library name', () => {
  test('is one plain path segment', () => {
    assert.equal(disk.libName('book-the-elms-abc'), 'book-the-elms-abc');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 7, null]) assert.throws(() => disk.libName(bad), /Invalid library name/);
  });
});

describe('JSON on disk', () => {
  test('a write keeps the last whole version as .bak, and a torn file reads from it', () => {
    const dir = scratch();
    const file = path.join(dir, 'book.json');
    disk.writeJSON(file, { v: 1 });
    disk.writeJSON(file, { v: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { v: 1 });
    fs.writeFileSync(file, '{"v": 2');                       // the power went out mid-write
    const heard = [];
    assert.deepEqual(disk.readJSON(file, null, (what) => heard.push(what)), { v: 1 });
    assert.match(heard[0], /restored from book\.json\.bak/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });   // put back as the file itself
  });

  test('a file that never existed is the fallback, quietly', () => {
    const heard = [];
    assert.equal(disk.readJSON(path.join(scratch(), 'none.json'), 'fallback', (what) => heard.push(what)), 'fallback');
    assert.deepEqual(heard, []);
  });

  test('a durable write leaves no .tmp behind', () => {
    const dir = scratch();
    disk.writeFileDurable(path.join(dir, 'a.txt'), 'words');
    assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
  });
});

describe('the library\'s own files', () => {
  test('a lost book.json comes back from the chapters, titled from the catalog', () => {
    const dir = scratch();
    const folder = bookWithChapters(dir, 'book-elms-1', ['ch-b', 'ch-a']);
    fs.writeFileSync(path.join(dir, '_catalog.txt'), 'head\n\nThe Elms  —  book-elms-1  —  shelf: Works\n');
    const meta = library.rebuildBookMeta('book-elms-1', folder, dir);
    assert.equal(meta.title, 'The Elms');
    assert.deepEqual(meta.chapterOrder, ['ch-a', 'ch-b']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'book.json'), 'utf8')).id, 'book-elms-1');
    assert.equal(library.rebuildBookMeta('book-none', path.join(dir, 'book-none'), dir), null);
  });

  test('a lost library.json puts every book with chapters on one shelf', () => {
    const dir = scratch();
    bookWithChapters(dir, 'book-one', ['ch-1']);
    bookWithChapters(dir, 'book-two', ['ch-1']);
    fs.mkdirSync(path.join(dir, 'book-empty'));
    const seed = library.seedLostLibrary(dir);
    assert.deepEqual(seed.shelves[0].bookIds, ['book-one', 'book-two']);
    assert.equal(seed.firstRunDone, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')), seed);
  });

  test('the catalog names each book, its folder and its shelf', () => {
    const dir = scratch();
    const folder = bookWithChapters(dir, 'book-elms-1', ['ch-1']);
    fs.writeFileSync(path.join(folder, 'book.json'), JSON.stringify({ id: 'book-elms-1', title: 'The Elms' }));
    disk.writeJSON(path.join(dir, 'library.json'), { shelves: [{ name: 'Works', bookIds: ['book-elms-1'] }] });
    library.writeCatalog(dir);
    assert.match(fs.readFileSync(path.join(dir, '_catalog.txt'), 'utf8'), /The Elms {2}— {2}book-elms-1 {2}— {2}shelf: Works/);
  });

  test('the backup zip leaves out the skipped folders and names a file it could not read', () => {
    const dir = scratch();
    bookWithChapters(dir, 'book-one', ['ch-1']);
    fs.mkdirSync(path.join(dir, 'Backups')); fs.writeFileSync(path.join(dir, 'Backups', 'old.zip'), 'x');
    fs.mkdirSync(path.join(dir, 'Trash')); fs.writeFileSync(path.join(dir, 'Trash', 'gone.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(dir, 'book-one', 'held'));
    if (process.getuid && process.getuid() !== 0) fs.chmodSync(path.join(dir, 'book-one', 'held'), 0o000);
    const files = {};
    const zip = { file: (name, bytes) => { files[name] = bytes; } };
    const missed = library.fillZip(zip, dir, ['Backups', 'Trash']);
    assert.ok(files['book-one/chapters/ch-1.html']);
    assert.ok(!Object.keys(files).some((f) => f.startsWith('Backups/') || f.startsWith('Trash/') || f === '.DS_Store'));
    if (process.getuid && process.getuid() !== 0) {
      assert.match(missed[0], /^book-one\/held/);
      assert.ok(files['_left-out-of-this-backup.txt']);
      fs.chmodSync(path.join(dir, 'book-one', 'held'), 0o700);
    }
    logged.length = 0;
  });
});
