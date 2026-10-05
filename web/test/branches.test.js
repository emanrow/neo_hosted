'use strict';

// Branches: whole alternate drafts of a book as copies of its folder, with
// the library pointed at the one the writer is in. Files only, no database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { openLibrary } = require('../lib/library');
const { openBranches, checkBranchName } = require('../lib/branches');

const t = (key) => key;

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-branches-'));
  const log = [];
  const logError = (source, err) => log.push(`${source}: ${(err && err.message) || err}`);
  const branches = openBranches({ dir, logError });
  const lib = openLibrary({ dir, t, logError, bookDirFor: branches.folderFor });
  return { dir, lib, branches, log };
}

describe('branch names', () => {
  test('plain names pass, main and path tricks do not', () => {
    assert.equal(checkBranchName('  What if Act 2  '), 'What if Act 2');
    for (const bad of ['', 'main', 'MAIN', '.hidden', 'a/b', 'a'.repeat(41), '-lead', 'two\nlines']) {
      assert.throws(() => checkBranchName(bad), /branch name|Invalid/, JSON.stringify(bad));
    }
  });
});

describe('branches', () => {
  test('a branch is a copy of the draft the writer is in, and the library follows the active one', () => {
    const { dir, lib, branches } = tempLibrary();
    const book = lib.createBook({ title: 'Fork' });
    lib.writeBookMeta(book.id, { ...book, chapterOrder: ['ch-1'] });
    lib.writeChapter(book.id, 'ch-1', '<p>Main words.</p>');
    lib.writeAux(book.id, 'notes', '<p>A note.</p>');
    assert.deepEqual(branches.list(book.id), { active: 'main', branches: [{ name: 'main', createdAt: null, from: null }] });

    const made = branches.create(book.id, 'alt');
    assert.equal(made.active, 'alt');
    assert.equal(made.branches.length, 2);
    assert.equal(made.branches[1].from, 'main');
    assert.ok(fs.existsSync(path.join(dir, book.id, '.branches', 'alt', 'chapters', 'ch-1.html')), 'the chapters came along');
    assert.equal(lib.readChapter(book.id, 'ch-1'), '<p>Main words.</p>', 'the branch starts as the draft it came from');
    assert.equal(lib.readAux(book.id, 'notes'), '<p>A note.</p>', 'notes too');

    lib.writeChapter(book.id, 'ch-1', '<p>Alt words.</p>');
    lib.writeBookMeta(book.id, { ...lib.readBookMeta(book.id), title: 'Fork, alt' });
    assert.equal(fs.readFileSync(path.join(dir, book.id, 'chapters', 'ch-1.html'), 'utf8'), '<p>Main words.</p>', 'main is untouched');
    assert.equal(lib.listBooks()[0].title, 'Fork, alt', 'the shelf shows the draft the writer is in');

    branches.switchTo(book.id, 'main');
    assert.equal(lib.readChapter(book.id, 'ch-1'), '<p>Main words.</p>');
    assert.equal(lib.readBookMeta(book.id).title, 'Fork');
    branches.switchTo(book.id, 'alt');
    assert.equal(lib.readChapter(book.id, 'ch-1'), '<p>Alt words.</p>');

    const second = branches.create(book.id, 'alt 2');
    assert.equal(second.branches.find((b) => b.name === 'alt 2').from, 'alt', 'branched from the branch the writer was in');
    assert.equal(lib.readChapter(book.id, 'ch-1'), '<p>Alt words.</p>');
    assert.ok(!fs.existsSync(path.join(dir, book.id, '.branches', 'alt 2', '.branches')), 'a branch does not carry the other branches inside it');
  });

  test('refusals: a taken name, a missing book, deleting main or the active branch', () => {
    const { lib, branches } = tempLibrary();
    const book = lib.createBook({ title: 'Rules' });
    branches.create(book.id, 'one');
    assert.throws(() => branches.create(book.id, 'one'), /already exists/);
    assert.throws(() => branches.create('book-nope', 'x'), /No such book/);
    assert.throws(() => branches.switchTo(book.id, 'nope'), /No such branch/);
    assert.throws(() => branches.remove(book.id, 'main'), /main draft/);
    assert.throws(() => branches.remove(book.id, 'one'), /Switch to another branch first/);
  });

  test('deleting a branch moves it to Trash, and trashing the book takes every branch along', () => {
    const { dir, lib, branches } = tempLibrary();
    const book = lib.createBook({ title: 'Gone' });
    lib.writeChapter(book.id, 'ch-1', '<p>Keep me.</p>');
    branches.create(book.id, 'draft b');
    lib.writeChapter(book.id, 'ch-1', '<p>Branch words.</p>');
    branches.switchTo(book.id, 'main');
    const after = branches.remove(book.id, 'draft b');
    assert.deepEqual(after.branches.map((b) => b.name), ['main']);
    const trashed = fs.readdirSync(path.join(dir, 'Trash'));
    assert.equal(trashed.length, 1);
    assert.match(trashed[0], new RegExp(`^${book.id}--branch-draft b--`));
    assert.equal(fs.readFileSync(path.join(dir, 'Trash', trashed[0], 'chapters', 'ch-1.html'), 'utf8'), '<p>Branch words.</p>');

    branches.create(book.id, 'draft c');
    assert.equal(lib.trashBook(book.id), true);
    assert.ok(!fs.existsSync(path.join(dir, book.id)));
    const bookInTrash = fs.readdirSync(path.join(dir, 'Trash')).find((f) => f.startsWith(book.id + '--2'));
    assert.ok(fs.existsSync(path.join(dir, 'Trash', bookInTrash, '.branches', 'draft c', 'chapters', 'ch-1.html')), 'the branch went with the book');
  });

  test('a dangling active file falls back to main', () => {
    const { dir, lib, branches } = tempLibrary();
    const book = lib.createBook({ title: 'Dangle' });
    fs.mkdirSync(path.join(dir, book.id, '.branches'), { recursive: true });
    fs.writeFileSync(path.join(dir, book.id, '.branches', 'active'), 'vanished\n');
    assert.equal(branches.activeBranch(book.id), 'main');
    assert.equal(lib.readBookMeta(book.id).title, 'Dangle');
  });
});
