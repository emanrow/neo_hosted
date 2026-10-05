'use strict';

// The Postgres library (storage stage D): the same contract as library.js
// and branches.js over rows, the merge over it, the folder import, the zip
// out, and the server flipped onto it. Skipped unless NEO_TEST_DATABASE_URL
// names a scratch database; it drops the tables first.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const DATABASE_URL = process.env.NEO_TEST_DATABASE_URL;

describe('PgLibrary', { skip: DATABASE_URL ? false : 'NEO_TEST_DATABASE_URL is not set' }, () => {
  const { openDatabase } = require('../lib/db');
  const { PgUserStore } = require('../lib/user-store');
  const { openPgLibrary } = require('../lib/pg-library');
  const { openLibrary } = require('../lib/library');
  const { openBranches } = require('../lib/branches');
  const { createMerger } = require('../lib/branch-merge');
  const { createApp } = require('../server');
  const JSZip = require('jszip');

  const db = openDatabase(DATABASE_URL);
  const t = (key) => key;
  const quiet = () => {};
  const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');
  let writerId = '';
  let otherId = '';

  const libraryFor = (userId) => openPgLibrary({ db, userId, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-pglib-')), t, logError: quiet });

  before(async () => {
    await db.query('DROP TABLE IF EXISTS shares, branch_bases, book_files, branches, books, libraries, revisions, users, schema_migrations');
    await db.migrate();
    const users = new PgUserStore(db);
    writerId = (await users.create({ email: 'rows@example.com', passwordHash: 'h' })).id;
    otherId = (await users.create({ email: 'other@example.com', passwordHash: 'h' })).id;
  });
  after(() => db.close());

  test('the library is seeded on first read, books are rows laid out like the folder, chapters stamp by time and size', async () => {
    const lib = libraryFor(writerId);
    assert.equal((await lib.readLibrary()).shelves[0].name, 'Works in Progress');
    assert.equal(await lib.isEmpty(), false, 'the seed counts as a library');
    const book = await lib.createBook({ title: 'Capítulo Uno', author: 'A. Writer' });
    assert.match(book.id, /^book-capitulo-uno-[a-z0-9]+-[a-z0-9]+$/);
    assert.deepEqual((await lib.listBooks()).map((b) => b.title), ['Capítulo Uno']);
    assert.equal(await lib.readAux(book.id, 'notes'), '', 'notes.html is there and empty');
    assert.deepEqual(await lib.readSidecar(book.id, 'darlings', 'fallback'), [], 'darlings.json is there and empty');
    assert.equal(await lib.readSidecar(book.id, 'nothing', 'fallback'), 'fallback');

    assert.equal(await lib.readChapter(book.id, 'ch1'), '', 'a chapter that is not there reads empty');
    await lib.writeChapter(book.id, 'ch1', '<p>one</p>');
    assert.equal(await lib.readChapter(book.id, 'ch1'), '<p>one</p>');
    const stamps = await lib.chapterStamps(book.id);
    assert.match(stamps.ch1, /^\d+:10$/);
    await lib.writeChapter(book.id, 'ch1', '<p>one!</p>');
    assert.notEqual((await lib.chapterStamps(book.id)).ch1, stamps.ch1, 'a rewrite moves the stamp');
    await lib.deleteChapter(book.id, 'ch1');
    assert.deepEqual(await lib.chapterStamps(book.id), {});
    await assert.rejects(lib.writeChapter(book.id, '../escape', 'x'), /Invalid library name/);
    await assert.rejects(lib.writeChapter('book-nope', 'ch1', 'x'), /No such book/);

    assert.equal(typeof (await lib.writeBookMeta(book.id, { ...book, title: 'Renamed' })), 'string');
    assert.equal((await lib.readBookMeta(book.id)).title, 'Renamed');
    assert.equal(await libraryFor(otherId).readBookMeta(book.id), null, 'another writer cannot see it');
    assert.equal((await libraryFor(otherId).listBooks()).length, 0);
  });

  test('covers are bytes in the same table, replaced, and found only by NEO\'s own names', async () => {
    const lib = libraryFor(writerId);
    const book = await lib.createBook({ title: 'Jacket' });
    assert.equal(await lib.setCoverBytes(book.id, 'gif', Buffer.from('x')), null);
    assert.equal(await lib.setCoverBytes('book-nope', 'png', Buffer.from('x')), null);
    const first = await lib.setCoverBytes(book.id, 'jpeg', Buffer.from('one'));
    assert.match(first, /^cover-\d+\.jpg$/);
    const second = await lib.setCoverBytes(book.id, 'png', Buffer.from('two'));
    assert.equal(await lib.readCover(book.id, first), null, 'the earlier cover went');
    assert.deepEqual(await lib.readCover(book.id, second), Buffer.from('two'));
    assert.equal(await lib.readCover(book.id, 'book.json'), null, 'only cover-* and art-* images are served');
    const art = await lib.storePainting(book.id, { buffer: Buffer.from('paint'), ext: 'png', brief: 'a sea', provider: 'x' });
    assert.deepEqual(await lib.readCover(book.id, art), Buffer.from('paint'));
    assert.equal((await lib.readSidecar(book.id, 'art', null)).file, art);
    await lib.removeCover(book.id);
    assert.equal(await lib.readCover(book.id, second), null);
    assert.deepEqual(await lib.readCover(book.id, art), Buffer.from('paint'), 'removing the cover leaves the painting');
  });

  test('trashing a book takes it off the shelf and keeps its rows', async () => {
    const lib = libraryFor(writerId);
    const book = await lib.createBook({ title: 'Doomed' });
    await lib.writeChapter(book.id, 'c', '<p>keep me</p>');
    assert.equal(await lib.trashBook(book.id), true);
    assert.equal(await lib.readBookMeta(book.id), null);
    assert.ok(!(await lib.listBooks()).some((b) => b.id === book.id));
    assert.equal(await lib.trashBook(book.id), true, 'trashing twice is not an error');
    const kept = await db.query('SELECT body FROM book_files WHERE user_id = $1 AND book_id = $2 AND path = $3', [writerId, book.id, 'chapters/c.html']);
    assert.equal(kept.rows[0].body, '<p>keep me</p>', 'words are never discarded');
  });

  test('branches: a copy of the draft the writer is in, the book follows the active one, refusals, Trash', async () => {
    const lib = libraryFor(writerId);
    const { branches } = lib;
    const book = await lib.createBook({ title: 'Fork' });
    await lib.writeBookMeta(book.id, { ...book, chapterOrder: ['ch-1'] });
    await lib.writeChapter(book.id, 'ch-1', '<p>Main words.</p>');
    await lib.writeAux(book.id, 'notes', '<p>A note.</p>');
    assert.deepEqual(await branches.list(book.id), { active: 'main', branches: [{ name: 'main', createdAt: null, from: null }] });

    const made = await branches.create(book.id, 'alt');
    assert.equal(made.active, 'alt');
    assert.equal(made.branches.length, 2);
    assert.equal(made.branches[1].from, 'main');
    assert.equal(await lib.readChapter(book.id, 'ch-1'), '<p>Main words.</p>', 'the branch starts as the draft it came from');
    assert.equal(await lib.readAux(book.id, 'notes'), '<p>A note.</p>', 'notes too');
    assert.equal(await branches.readBaseChapterOf(book.id, 'alt', 'ch-1'), '<p>Main words.</p>', 'and keeps a base of where it started');
    assert.deepEqual((await branches.readBaseMetaOf(book.id, 'alt')).chapterOrder, ['ch-1']);

    await lib.writeChapter(book.id, 'ch-1', '<p>Alt words.</p>');
    await lib.writeBookMeta(book.id, { ...(await lib.readBookMeta(book.id)), title: 'Fork, alt' });
    assert.equal(await branches.readChapterOf(book.id, 'main', 'ch-1'), '<p>Main words.</p>', 'main is untouched');
    assert.equal((await lib.listBooks()).find((b) => b.id === book.id).title, 'Fork, alt', 'the shelf shows the draft the writer is in');

    await branches.switchTo(book.id, 'main');
    assert.equal(await lib.readChapter(book.id, 'ch-1'), '<p>Main words.</p>');
    assert.equal((await lib.readBookMeta(book.id)).title, 'Fork');
    await branches.switchTo(book.id, 'alt');
    const second = await branches.create(book.id, 'alt 2');
    assert.equal(second.branches.find((b) => b.name === 'alt 2').from, 'alt', 'branched from the branch the writer was in');
    assert.equal(await lib.readChapter(book.id, 'ch-1'), '<p>Alt words.</p>');

    await assert.rejects(branches.create(book.id, 'alt'), /already exists/);
    await assert.rejects(branches.create(book.id, 'main'), /branch name/);
    await assert.rejects(branches.create('book-nope', 'x'), /No such book/);
    await assert.rejects(branches.switchTo(book.id, 'nope'), /No such branch/);
    await assert.rejects(branches.remove(book.id, 'main'), /main draft/);
    await assert.rejects(branches.remove(book.id, 'alt 2'), /Switch to another branch first/);

    await branches.switchTo(book.id, 'main');
    const after = await branches.remove(book.id, 'alt 2');
    assert.deepEqual(after.branches.map((b) => b.name), ['main', 'alt']);
    const trashed = await db.query("SELECT name FROM branches WHERE user_id = $1 AND book_id = $2 AND trashed_at IS NOT NULL", [writerId, book.id]);
    assert.match(trashed.rows[0].name, /^Trash\/alt 2--/);
    const again = await branches.create(book.id, 'alt 2');
    assert.ok(again.branches.some((b) => b.name === 'alt 2'), 'the name is free again');
  });

  test('Compare & Merge works over rows: the base, the preview, the apply, the base moving forward', async () => {
    const lib = libraryFor(writerId);
    const { branches } = lib;
    const merger = createMerger({ branches, library: lib });
    const book = await lib.createBook({ title: 'Merge me' });
    await lib.writeBookMeta(book.id, { ...book, chapterOrder: ['ch-1', 'ch-2'], chapterTitles: { 'ch-1': 'Opening' } });
    await lib.writeChapter(book.id, 'ch-1', p('One.', 'Two.', 'Three.'));
    await lib.writeChapter(book.id, 'ch-2', p('Alpha.', 'Beta.'));
    await branches.create(book.id, 'alt');
    await lib.writeChapter(book.id, 'ch-1', p('One.', 'Two, on the branch.', 'Three.'));
    await lib.writeChapter(book.id, 'ch-3', p('A new chapter.'));
    await lib.writeBookMeta(book.id, { ...(await lib.readBookMeta(book.id)), chapterOrder: ['ch-1', 'ch-2', 'ch-3'] });
    await branches.switchTo(book.id, 'main');
    await lib.writeChapter(book.id, 'ch-1', p('One.', 'Two, on main.', 'Three.'));

    const preview = await merger.preview(book.id, 'alt');
    assert.deepEqual(preview.chapters.map((c) => [c.id, c.status, c.conflicts.length]), [['ch-1', 'conflict', 1], ['ch-2', 'same', 0], ['ch-3', 'added', 0]]);
    const result = await merger.apply(book.id, 'alt', { 'ch-1:0': 'theirs' });
    assert.deepEqual(result.written.map((w) => w.id), ['ch-1', 'ch-3']);
    assert.equal(await lib.readChapter(book.id, 'ch-1'), p('One.', 'Two, on the branch.', 'Three.'));
    assert.deepEqual((await lib.readBookMeta(book.id)).chapterOrder, ['ch-1', 'ch-2', 'ch-3']);
    const again = await merger.preview(book.id, 'alt');
    assert.ok(again.chapters.every((c) => c.status === 'same' || c.status === 'kept'), 'the base moved forward');
  });

  test('a desktop folder imports once, branches and bases included, and the zip out is that folder again', async () => {
    // a library made by the file code, as the volume held before the flip
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-import-'));
    const fileBranches = openBranches({ dir, logError: quiet });
    const files = openLibrary({ dir, t, logError: quiet, bookDirFor: fileBranches.folderFor });
    const book = files.createBook({ title: 'Imported' });
    files.writeBookMeta(book.id, { ...book, chapterOrder: ['ch-1'] });
    files.writeChapter(book.id, 'ch-1', '<p>Main words.</p>');
    files.writeAux(book.id, 'notes', '<p>Note.</p>');
    files.setCoverBytes(book.id, 'png', Buffer.from([0x89, 0x50]));
    files.writeLibrary({ ...files.readLibrary(), firstRunDone: true, shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [book.id] }] });
    fileBranches.create(book.id, 'alt');
    files.writeChapter(book.id, 'ch-1', '<p>Branch words.</p>');
    files.trashBook(files.createBook({ title: 'Trashed before' }).id);
    fs.mkdirSync(path.join(dir, 'Backups'));
    fs.writeFileSync(path.join(dir, 'Backups', 'neo-backup-2020-01-01.zip'), 'old');

    const lib = openPgLibrary({ db, userId: otherId, dir, t, logError: quiet });
    assert.equal(await lib.isEmpty(), true);
    const counts = await lib.importFolder(dir);
    assert.deepEqual(counts, { books: 1, branches: 1, files: 16 }, '7 files on main, 7 on the branch, 2 in its base');
    assert.equal(await lib.isEmpty(), false);
    assert.deepEqual((await lib.readLibrary()).shelves[0].bookIds, [book.id]);
    assert.equal(await lib.branches.activeBranch(book.id), 'alt', 'the writer is still on the branch');
    assert.equal(await lib.readChapter(book.id, 'ch-1'), '<p>Branch words.</p>');
    assert.equal(await lib.branches.readChapterOf(book.id, 'main', 'ch-1'), '<p>Main words.</p>');
    assert.equal(await lib.branches.readBaseChapterOf(book.id, 'alt', 'ch-1'), '<p>Main words.</p>');
    assert.equal(await lib.readAux(book.id, 'notes'), '<p>Note.</p>');
    const cover = (await lib.readBookMeta(book.id)) && fs.readdirSync(path.join(dir, book.id)).find((f) => f.startsWith('cover-'));
    assert.deepEqual(await lib.readCover(book.id, cover), Buffer.from([0x89, 0x50]), 'images came in as bytes');
    assert.equal((await lib.branches.list(book.id)).branches[1].from, 'main');
    assert.deepEqual((await lib.listBooks()).map((b) => b.title), ['Imported'], 'the Trash stayed on the volume');

    const zip = await JSZip.loadAsync(await lib.exportZip());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.deepEqual(names, [
      '_catalog.txt', `${book.id}/.branches/active`, `${book.id}/.branches/alt/.base/book.json`, `${book.id}/.branches/alt/.base/chapters/ch-1.html`,
      `${book.id}/.branches/alt/book.json`, `${book.id}/.branches/alt/branch.json`, `${book.id}/.branches/alt/chapters/ch-1.html`, `${book.id}/.branches/alt/${cover}`,
      `${book.id}/.branches/alt/darlings.json`, `${book.id}/.branches/alt/notes.html`, `${book.id}/.branches/alt/outline.html`, `${book.id}/.branches/alt/stickies.json`,
      `${book.id}/book.json`, `${book.id}/chapters/ch-1.html`, `${book.id}/${cover}`, `${book.id}/darlings.json`, `${book.id}/notes.html`, `${book.id}/outline.html`, `${book.id}/stickies.json`,
      'library.json'
    ].sort());
    assert.equal(await zip.file(`${book.id}/.branches/active`).async('string'), 'alt\n');
    assert.equal(await zip.file(`${book.id}/chapters/ch-1.html`).async('string'), '<p>Main words.</p>');
    assert.deepEqual(await zip.file(`${book.id}/${cover}`).async('nodebuffer'), Buffer.from([0x89, 0x50]));
    assert.ok((await zip.file('_catalog.txt').async('string')).includes('Imported'));

    assert.equal(await lib.dailyBackup(), true);
    assert.equal(await lib.dailyBackup(), false, 'one per day');
    assert.equal(fs.readdirSync(path.join(dir, 'Backups')).length, 2, 'beside the old one');
  });

  test('the server on Postgres: a library folder on the volume is imported on boot, then every channel answers from rows', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-pgserver-'));
    const users = new PgUserStore(db);
    const writer = await users.create({ email: 'flip@example.com', passwordHash: require('../lib/auth').hashPassword('longenough') });
    const libraryDir = path.join(dataDir, 'users', writer.id, 'NEO Library');
    const before = openLibrary({ dir: libraryDir, t, logError: quiet });
    const old = before.createBook({ title: 'From the volume' });
    before.writeChapter(old.id, 'ch-1', '<p>Old words.</p>');
    before.writeLibrary({ ...before.readLibrary(), firstRunDone: true, shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [old.id] }] });

    const app = createApp({ dev: false, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: '', mail: {} }, { db });
    assert.deepEqual(await app.ready, { store: 'postgres', imported: 0, libraries: 1 });
    assert.ok(!fs.existsSync(libraryDir), 'the folder was renamed out of the way');
    assert.ok(fs.readdirSync(path.join(dataDir, 'users', writer.id)).some((f) => f.startsWith('NEO Library.imported-')));
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    try {
      const login = await fetch(base + '/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: 'flip@example.com', password: 'longenough' }), redirect: 'manual' });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const call = (p, init = {}) => fetch(base + p, { ...init, headers: { ...headers, Cookie: cookie, ...(init.headers || {}) } });
      const api = async (channel, ...args) => (await (await call('/api/' + channel, { method: 'POST', body: JSON.stringify({ args }) })).json()).result;

      assert.deepEqual((await api('library:listBooks')).map((b) => b.title), ['From the volume']);
      assert.equal(await api('chapter:read', old.id, 'ch-1'), '<p>Old words.</p>');
      const book = await api('book:create', { title: 'In rows' });
      await api('book:writeMeta', book.id, { ...book, chapterOrder: ['ch-1'] });
      assert.equal(await api('chapter:write', book.id, 'ch-1', '<p>First words.</p>'), true);
      assert.match((await api('chapter:stamps', book.id))['ch-1'], /:19$/);
      assert.equal((await api('revision:list', book.id, 'ch-1')).length, 1, 'the log still records');
      assert.ok(!fs.existsSync(path.join(libraryDir, book.id)), 'nothing was written to the volume');

      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const up = await call(`/api/cover:upload?bookId=${book.id}&ext=png`, { method: 'POST', body: png, headers: { 'Content-Type': 'application/octet-stream' } });
      const fname = (await up.json()).result;
      const img = await call(`/library/${book.id}/${fname}`);
      assert.equal(img.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

      const made = await api('branch:create', book.id, 'what if');
      assert.equal(made.active, 'what if');
      await api('chapter:write', book.id, 'ch-1', '<p>Branch words.</p>');
      assert.equal((await api('branch:switch', book.id, 'main')).active, 'main');
      assert.equal(await api('chapter:read', book.id, 'ch-1'), '<p>First words.</p>');
      const preview = await api('branch:mergePreview', book.id, 'what if');
      assert.equal(preview.chapters[0].status, 'merged');
      assert.deepEqual(await api('branch:merge', book.id, 'what if', {}), { into: 'main', from: 'what if', chapters: 1 });
      assert.equal(await api('chapter:read', book.id, 'ch-1'), '<p>Branch words.</p>');

      const zip = await JSZip.loadAsync(Buffer.from(await (await call('/library.zip')).arrayBuffer()));
      assert.equal(await zip.file(`${book.id}/chapters/ch-1.html`).async('string'), '<p>Branch words.</p>');
      assert.ok(zip.file(`${book.id}/.branches/what if/chapters/ch-1.html`));
      assert.equal(await api('book:delete', book.id), true);
      assert.equal(await api('book:readMeta', book.id), null);

      await app.backupEveryone();
      assert.equal(fs.readdirSync(path.join(libraryDir, 'Backups')).length, 1, 'the daily zip lands on the volume');
    } finally {
      await app.close();
    }
  });
});
