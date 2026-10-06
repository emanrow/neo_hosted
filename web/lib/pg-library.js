'use strict';

// A writer's NEO Library as rows in Postgres: storage stage D, where the
// words become canonical in the database and files become an export. The
// layout is still the desktop app's folder, one row per file in book_files
// keyed by book and branch (book.json, chapters/<id>.html, notes.html,
// darlings.json, cover-<ts>.png ...), so the daily zip and the download are
// that folder, byte for byte, and a desktop library drops back in through
// importFolder(). library.js and branches.js keep the same contract for a
// laptop without Postgres; every method here returns a promise, and
// handlers.js awaits either.
//
// Branches are rows too: `branches` names each draft of a book, `books`
// points at the active one, and every file read or write joins on that
// pointer, so a handler reads and writes "the book" and lands on the draft
// the writer is in, as with folders. `branch_bases` is the .base snapshot a
// three-way merge measures from (branch-merge.js).
//
// Gotchas:
// - Nothing is deleted. Trashing a book or a branch sets trashed_at (a
//   trashed branch is also renamed under "Trash/", which a writer cannot
//   type, so the name is free again); listings skip them, the rows stay.
// - A write to a book that is not there throws "No such book" rather than
//   inventing one, unlike a folder write; the page never does that.
// - `modified` is clock_timestamp(), not now(): two saves in one transaction
//   must still stamp differently for chapter:stamps.
// - SQL stays in this file (and db.js, user-store.js, revisions.js).

const fs = require('node:fs');
const path = require('node:path');
const { libName, readJSON } = require('../../library-disk');
const { checkBranchName, MAIN_BRANCH: MAIN } = require('./branches');
const { dailyZip } = require('./backups');

const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const COVER_FILE = /^(cover|art|map|fig)-\d+\.(png|jpg|webp)$/;   // the images NEO made and serves: covers, paintings, the map map's sheet, a chapter's pictures
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const BASE_PATHS = "(path = 'book.json' OR path LIKE 'chapters/%')";
const TRASHED_PREFIX = 'Trash/';

const chapterPath = (chapterId) => 'chapters/' + libName(chapterId) + '.html';
const parseJSON = (text, fallback) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };
const pretty = (value) => JSON.stringify(value, null, 2);
const trashStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * @param {object} deps
 * @param {ReturnType<import('./db').openDatabase>} deps.db
 * @param {string} deps.userId
 * @param {string} deps.dir       the writer's folder on the volume; holds the daily zips and the error log, never words
 * @param {(key: string, vars?: object) => string} deps.t
 */
function openPgLibrary({ db, userId, dir, t }) {
  const rows = async (text, params, client = db) => (await client.query(text, params)).rows;
  const one = async (text, params, client = db) => (await rows(text, params, client))[0] || null;
  const branchName = (name) => (name === MAIN ? MAIN : checkBranchName(name));

  // ---------- the active draft of a book ----------

  /** The branch the writer is in; "main" for a book that is not there. */
  async function activeBranch(bookId) {
    const row = await one('SELECT active_branch FROM books WHERE user_id = $1 AND id = $2 AND trashed_at IS NULL', [userId, libName(bookId)]);
    return row ? row.active_branch : MAIN;
  }

  const readFile = async (bookId, filePath) => one(
    `SELECT f.body, f.bytes FROM book_files f
       JOIN books b ON b.user_id = f.user_id AND b.id = f.book_id AND b.active_branch = f.branch
      WHERE f.user_id = $1 AND f.book_id = $2 AND f.path = $3 AND b.trashed_at IS NULL`,
    [userId, libName(bookId), filePath]
  );
  const readText = async (bookId, filePath) => { const row = await readFile(bookId, filePath); return row && row.body != null ? row.body : ''; };

  async function writeFile(bookId, filePath, { body = null, bytes = null }, client = db) {
    const result = await client.query(
      `INSERT INTO book_files (user_id, book_id, branch, path, body, bytes, modified)
       SELECT $1, $2, active_branch, $3, $4, $5, clock_timestamp() FROM books WHERE user_id = $1 AND id = $2 AND trashed_at IS NULL
       ON CONFLICT (user_id, book_id, branch, path) DO UPDATE SET body = EXCLUDED.body, bytes = EXCLUDED.bytes, modified = EXCLUDED.modified`,
      [userId, libName(bookId), filePath, body, bytes]
    );
    if (!result.rowCount) throw new Error('No such book');
    return true;
  }

  const deleteFiles = (bookId, pattern) => db.query(
    `DELETE FROM book_files f USING books b
      WHERE b.user_id = f.user_id AND b.id = f.book_id AND b.active_branch = f.branch
        AND f.user_id = $1 AND f.book_id = $2 AND f.path LIKE $3`,
    [userId, libName(bookId), pattern]
  );

  // ---------- library.json ----------

  const seedLibrary = () => ({ authorName: '', penNames: [], firstRunDone: false, pageTheme: 'night', shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: [] }] });

  async function readLibrary() {
    const row = await one('SELECT data FROM libraries WHERE user_id = $1', [userId]);
    if (row) return row.data;
    const seed = seedLibrary();
    await db.query('INSERT INTO libraries (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, seed]);
    return seed;
  }

  async function writeLibrary(data) {
    await db.query('INSERT INTO libraries (user_id, data, modified) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, modified = now()', [userId, data]);
    return true;
  }

  // ---------- books ----------

  function createBook(meta = {}) {
    const slug = String(meta.title || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const id = 'book-' + (slug ? slug + '-' : '') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const book = {
      id,
      title: meta.title || t('Untitled'),
      subtitle: '',
      series: '',
      author: meta.author || t('Anonymous'),
      wordGoal: 0,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      chapterOrder: [],
      tabNames: { notes: 'Notes', outline: 'Outline' }
    };
    return db.transaction(async (client) => {
      await client.query('INSERT INTO books (user_id, id) VALUES ($1, $2)', [userId, id]);
      await client.query('INSERT INTO branches (user_id, book_id, name) VALUES ($1, $2, $3)', [userId, id, MAIN]);
      await writeFile(id, 'book.json', { body: pretty(book) }, client);
      await writeFile(id, 'notes.html', { body: '' }, client);
      await writeFile(id, 'outline.html', { body: '' }, client);
      await writeFile(id, 'darlings.json', { body: pretty([]) }, client);
      await writeFile(id, 'stickies.json', { body: pretty([]) }, client);
      return book;
    });
  }

  async function listBooks() {
    const found = await rows(
      `SELECT f.body FROM books b
         JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.branch = b.active_branch AND f.path = 'book.json'
        WHERE b.user_id = $1 AND b.trashed_at IS NULL ORDER BY b.created_at`,
      [userId]
    );
    return found.map((r) => parseJSON(r.body, null)).filter((meta) => meta && meta.id)
      .map((meta) => ({ id: meta.id, title: meta.title || t('Untitled'), author: meta.author || '', modified: meta.modified || '', kind: meta.kind || '' }));
  }

  const readBookMeta = async (bookId) => parseJSON(await readText(bookId, 'book.json') || null, null);

  async function writeBookMeta(bookId, meta) {
    meta.modified = new Date().toISOString();
    await writeFile(bookId, 'book.json', { body: pretty(meta) });
    return meta.modified;
  }

  /** Words are never discarded: the book and every branch stay as rows, marked trashed and off the shelf. */
  async function trashBook(bookId) {
    await db.query('UPDATE books SET trashed_at = now() WHERE user_id = $1 AND id = $2 AND trashed_at IS NULL', [userId, libName(bookId)]);
    return true;
  }

  // ---------- chapters and the files beside them ----------

  async function chapterStamps(bookId) {
    const found = await rows(
      `SELECT f.path, extract(epoch FROM f.modified) * 1000 AS ms, octet_length(f.body) AS size FROM book_files f
         JOIN books b ON b.user_id = f.user_id AND b.id = f.book_id AND b.active_branch = f.branch
        WHERE f.user_id = $1 AND f.book_id = $2 AND f.path LIKE 'chapters/%.html' AND b.trashed_at IS NULL`,
      [userId, libName(bookId)]
    );
    const out = {};
    for (const r of found) out[r.path.slice(9, -5)] = `${Math.round(Number(r.ms))}:${r.size}`;
    return out;
  }

  // async so a bad name rejects rather than throws, as every method here promises
  const readChapter = async (bookId, chapterId) => readText(bookId, chapterPath(chapterId));
  const writeChapter = async (bookId, chapterId, html) => writeFile(bookId, chapterPath(chapterId), { body: String(html ?? '') });
  async function deleteChapter(bookId, chapterId) {
    await deleteFiles(bookId, chapterPath(chapterId));
    return true;
  }

  const readAux = async (bookId, name) => readText(bookId, libName(name) + '.html');
  const writeAux = async (bookId, name, html) => writeFile(bookId, libName(name) + '.html', { body: String(html ?? '') });
  const readSidecar = async (bookId, name, fallback) => parseJSON(await readText(bookId, libName(name) + '.json') || null, fallback);
  const writeSidecar = async (bookId, name, data) => writeFile(bookId, libName(name) + '.json', { body: pretty(data) });

  // ---------- covers and paintings, bytes in the same table ----------

  /** Stores uploaded cover bytes as cover-<ts>.<ext>; returns the file name, or null for a type NEO does not take or a book that is not there. */
  async function setCoverBytes(bookId, ext, bytes) {
    ext = String(ext || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) return null;
    if (!(await readBookMeta(bookId))) return null;
    await deleteFiles(bookId, 'cover-%');
    const fname = 'cover-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    await writeFile(bookId, fname, { bytes });
    return fname;
  }

  async function removeCover(bookId) {
    await deleteFiles(bookId, 'cover-%');
    return true;
  }

  /** The map map's sheet (hosted only): one image per book as map-<ts>.<ext>, the earlier one replaced; '' removes it. Returns the file name. */
  async function setMapImage(bookId, ext, bytes) {
    if (!(await readBookMeta(bookId))) return null;
    await deleteFiles(bookId, 'map-%');
    if (!bytes) return '';
    ext = String(ext || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) return null;
    const fname = 'map-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    await writeFile(bookId, fname, { bytes });
    return fname;
  }

  /** A picture in a chapter (hosted only): fig-<ts>.<ext> beside the cover, one more each time, never replaced. Returns the file name. */
  async function addFigure(bookId, ext, bytes) {
    if (!(await readBookMeta(bookId)) || !bytes) return null;
    ext = String(ext || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) return null;
    let fname;
    do fname = 'fig-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext); while (await readFile(bookId, fname));
    await writeFile(bookId, fname, { bytes });
    return fname;
  }

  /** The bytes of a cover or painting, or null when the name is not one NEO made or it is gone. */
  async function readCover(bookId, fname) {
    if (!COVER_FILE.test(String(fname))) return null;
    const row = await readFile(bookId, fname);
    return row && row.bytes ? row.bytes : null;
  }

  async function storePainting(bookId, { buffer, ext, brief, provider, textModel, imageModel }) {
    await deleteFiles(bookId, 'art-%.%');
    const fname = 'art-' + Date.now() + '.' + (ext || 'jpg');
    await writeFile(bookId, fname, { bytes: buffer });
    await writeFile(bookId, 'art.json', { body: pretty({ file: fname, brief, provider, textModel, imageModel, painted: new Date().toISOString() }) });
    return fname;
  }

  // ---------- branches: the same contract as branches.js ----------

  async function listBranches(bookId) {
    const found = await rows(
      `SELECT name, created_from, created_at FROM branches WHERE user_id = $1 AND book_id = $2 AND trashed_at IS NULL
        ORDER BY (name = $3) DESC, created_at`,
      [userId, libName(bookId), MAIN]
    );
    const branches = found.map((r) => (r.name === MAIN
      ? { name: MAIN, createdAt: null, from: null }
      : { name: r.name, createdAt: new Date(r.created_at).toISOString(), from: r.created_from }));
    if (!branches.length) branches.push({ name: MAIN, createdAt: null, from: null });
    return { active: await activeBranch(bookId), branches };
  }

  const branchExists = async (bookId, name, client = db) => !!(await one('SELECT 1 FROM branches WHERE user_id = $1 AND book_id = $2 AND name = $3 AND trashed_at IS NULL', [userId, bookId, name], client));

  /** The branch's chapters and book.json as they stand become its base: what a later merge measures from. */
  async function moveBaseForward(bookId, name, client = db) {
    if (name === MAIN) return;
    const key = [userId, libName(bookId), branchName(name)];
    await client.query('DELETE FROM branch_bases WHERE user_id = $1 AND book_id = $2 AND branch = $3', key);
    await client.query(
      `INSERT INTO branch_bases (user_id, book_id, branch, path, body)
       SELECT user_id, book_id, branch, path, body FROM book_files
        WHERE user_id = $1 AND book_id = $2 AND branch = $3 AND body IS NOT NULL AND ${BASE_PATHS}`,
      key
    );
  }

  /** Copies the draft the writer is in to a new branch and moves them onto it, all in one transaction. */
  async function createBranch(bookId, name) {
    const target = checkBranchName(name); // "main" is refused here, not found
    await db.transaction(async (client) => {
      const book = await one('SELECT active_branch FROM books WHERE user_id = $1 AND id = $2 AND trashed_at IS NULL FOR UPDATE', [userId, libName(bookId)], client);
      if (!book) throw new Error('No such book');
      if (await branchExists(bookId, target, client)) throw new Error('A branch with that name already exists');
      const key = [userId, bookId, target];
      await client.query('INSERT INTO branches (user_id, book_id, name, created_from) VALUES ($1, $2, $3, $4)', [...key, book.active_branch]);
      await client.query(
        `INSERT INTO book_files (user_id, book_id, branch, path, body, bytes, modified)
         SELECT user_id, book_id, $3, path, body, bytes, modified FROM book_files WHERE user_id = $1 AND book_id = $2 AND branch = $4`,
        [...key, book.active_branch]
      );
      await moveBaseForward(bookId, target, client);
      await client.query('UPDATE books SET active_branch = $3 WHERE user_id = $1 AND id = $2', key);
    });
    return listBranches(bookId);
  }

  async function switchTo(bookId, name) {
    const target = branchName(name);
    if (!(await branchExists(bookId, target))) throw new Error('No such branch');
    await db.query('UPDATE books SET active_branch = $3 WHERE user_id = $1 AND id = $2 AND trashed_at IS NULL', [userId, libName(bookId), target]);
    return listBranches(bookId);
  }

  /** A branch is marked trashed and renamed out of the way, never dropped. The active branch and main stay. */
  async function removeBranch(bookId, name) {
    if (name === MAIN) throw new Error('The main draft cannot be deleted; delete the book instead');
    const target = checkBranchName(name);
    if (target === (await activeBranch(bookId))) throw new Error('Switch to another branch first');
    if (!(await branchExists(bookId, target))) throw new Error('No such branch');
    await db.query('UPDATE branches SET name = $4, trashed_at = now() WHERE user_id = $1 AND book_id = $2 AND name = $3',
      [userId, libName(bookId), target, `${TRASHED_PREFIX}${target}--${trashStamp()}`]);
    return listBranches(bookId);
  }

  const readOf = async (table, bookId, name, filePath) => {
    const row = await one(`SELECT body FROM ${table} WHERE user_id = $1 AND book_id = $2 AND branch = $3 AND path = $4`, [userId, libName(bookId), branchName(name), filePath]);
    return row ? row.body : null;
  };
  const readChapterOf = async (bookId, name, chapterId) => (await readOf('book_files', bookId, name, chapterPath(chapterId))) || '';
  const readMetaOf = async (bookId, name) => parseJSON(await readOf('book_files', bookId, name, 'book.json'), { chapterOrder: [] });
  const readBaseChapterOf = async (bookId, name, chapterId) => (await readOf('branch_bases', bookId, name, chapterPath(chapterId))) || '';
  const readBaseMetaOf = async (bookId, name) => parseJSON(await readOf('branch_bases', bookId, name, 'book.json'), null);

  const branches = { MAIN, activeBranch, list: listBranches, create: createBranch, switchTo, remove: removeBranch, readChapterOf, readMetaOf, readBaseChapterOf, readBaseMetaOf, moveBaseForward: (bookId, name) => moveBaseForward(bookId, name) };

  // ---------- the folder, out and in ----------

  /** Adds the whole library to a JSZip in the desktop layout (main at the book's root, branches under .branches/). Trashed books and branches stay out. */
  async function fillZip(zip, fileBytes = null) {
    const library = await readLibrary();
    zip.file('library.json', pretty(library));
    const books = await rows('SELECT id, active_branch FROM books WHERE user_id = $1 AND trashed_at IS NULL ORDER BY created_at', [userId]);
    const branchRows = await rows('SELECT book_id, name, created_from, created_at FROM branches WHERE user_id = $1 AND trashed_at IS NULL', [userId]);
    const files = await rows('SELECT f.book_id, f.branch, f.path, f.body, f.bytes FROM book_files f JOIN branches r ON r.user_id = f.user_id AND r.book_id = f.book_id AND r.name = f.branch WHERE f.user_id = $1 AND r.trashed_at IS NULL', [userId]);
    const bases = await rows('SELECT b.book_id, b.branch, b.path, b.body FROM branch_bases b JOIN branches r ON r.user_id = b.user_id AND r.book_id = b.book_id AND r.name = b.branch WHERE b.user_id = $1 AND r.trashed_at IS NULL', [userId]);
    const prefixOf = (bookId, branch) => (branch === MAIN ? `${bookId}/` : `${bookId}/.branches/${branch}/`);
    const catalog = [];
    const onShelf = {};
    for (const shelf of library.shelves || []) for (const id of shelf.bookIds || []) onShelf[id] = shelf.name;
    for (const book of books) {
      if (book.active_branch !== MAIN) zip.file(`${book.id}/.branches/active`, book.active_branch + '\n');
      const meta = parseJSON((files.find((f) => f.book_id === book.id && f.branch === book.active_branch && f.path === 'book.json') || {}).body, {});
      catalog.push(`${meta.title || t('Untitled')}  —  ${book.id}  —  ${t('shelf:')} ${onShelf[book.id] || t('(none — removed from shelves)')}`);
    }
    for (const r of branchRows) {
      if (r.name !== MAIN && books.some((b) => b.id === r.book_id)) zip.file(`${prefixOf(r.book_id, r.name)}branch.json`, pretty({ name: r.name, from: r.created_from, createdAt: new Date(r.created_at).toISOString() }));
    }
    for (const f of files) {
      if (!books.some((b) => b.id === f.book_id)) continue;
      const relPath = prefixOf(f.book_id, f.branch) + f.path;
      zip.file(relPath, f.bytes && fileBytes ? fileBytes(relPath, f.bytes) : f.bytes || f.body || '');
    }
    for (const b of bases) if (books.some((bk) => bk.id === b.book_id)) zip.file(`${prefixOf(b.book_id, b.branch)}.base/${b.path}`, b.body);
    catalog.sort((a, b) => a.localeCompare(b));
    zip.file('_catalog.txt', t('NEO LIBRARY CATALOG — which folder is which book') + '\n' + t('(regenerated automatically; edits here do nothing)') + '\n\n' + catalog.join('\n') + '\n');
  }

  /** The library as one zip, for the download. */
  /** How much of the table is this writer's: every row of every branch, trashed ones too. */
  async function footprint() {
    const r = await one('SELECT COALESCE(SUM(octet_length(body)), 0) + COALESCE(SUM(octet_length(bytes)), 0) AS n FROM book_files WHERE user_id = $1', [userId]);
    return Number(r && r.n) || 0;
  }

  /** Every row of this writer's library, gone, in one transaction: an account being removed, its zip already written. */
  function erase() {
    return db.transaction(async (client) => {
      for (const table of ['branch_bases', 'book_files', 'branches', 'books', 'libraries']) await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    });
  }

  /** The library as one zip, for the download; `fileBytes(relPath, bytes)` may swap a file's bytes (a picture the bucket holds, image-store.js). */
  async function exportZip(fileBytes) {
    const JSZip = require('jszip');
    const zip = new JSZip();
    await fillZip(zip, fileBytes);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /** One zip of the whole library per day on the volume (backups.js keeps 14); `copy(name, bytes)` sends it off-site. */
  const dailyBackup = (copy) => dailyZip({ backupsDir: path.join(dir, 'Backups'), fill: fillZip, copy });

  /** True when this writer has no rows yet, so a folder may be imported. */
  const isEmpty = async () => !(await one('SELECT 1 FROM libraries WHERE user_id = $1 UNION SELECT 1 FROM books WHERE user_id = $1', [userId]));

  /**
   * Brings a NEO Library folder (library.js's layout, branches and bases
   * included) into rows, in one transaction. Trash, Backups and the error
   * log stay on the volume. Returns what was imported.
   */
  function importFolder(folder) {
    const counts = { books: 0, branches: 0, files: 0 };
    const walk = (root, rel, skip, onFile) => {
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(root, relPath, skip, onFile); }
        else if (entry.isFile() && !/\.(tmp|bak)$/.test(entry.name)) onFile(relPath, fs.readFileSync(path.join(root, relPath)));
      }
    };
    const insertFile = (client, { table, bookId, branch, filePath, content }) => {
      counts.files++;
      if (table === 'branch_bases') return client.query('INSERT INTO branch_bases (user_id, book_id, branch, path, body) VALUES ($1, $2, $3, $4, $5)', [userId, bookId, branch, filePath, content.toString('utf8')]);
      const image = IMAGE_EXT.test(filePath);
      return client.query('INSERT INTO book_files (user_id, book_id, branch, path, body, bytes) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, bookId, branch, filePath, image ? null : content.toString('utf8'), image ? content : null]);
    };
    return db.transaction(async (client) => {
      const bookDirs = (() => { try { return fs.readdirSync(folder).filter((d) => d.startsWith('book-') && fs.existsSync(path.join(folder, d, 'book.json'))); } catch { return []; } })();
      const library = readJSON(path.join(folder, 'library.json'), null) || { ...seedLibrary(), firstRunDone: bookDirs.length > 0, shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: bookDirs }] };
      await client.query('INSERT INTO libraries (user_id, data) VALUES ($1, $2)', [userId, library]);
      for (const bookId of bookDirs) {
        const root = path.join(folder, bookId);
        const branchesDir = path.join(root, '.branches');
        let active = MAIN;
        try { active = fs.readFileSync(path.join(branchesDir, 'active'), 'utf8').trim() || MAIN; } catch { /* main */ }
        let names = [];
        try { names = fs.readdirSync(branchesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no branches */ }
        if (active !== MAIN && !names.includes(active)) active = MAIN;
        counts.books++;
        await client.query('INSERT INTO books (user_id, id, active_branch) VALUES ($1, $2, $3)', [userId, bookId, active]);
        await client.query('INSERT INTO branches (user_id, book_id, name) VALUES ($1, $2, $3)', [userId, bookId, MAIN]);
        const pending = [];
        walk(root, '', new Set(['.branches', '.base']), (filePath, content) => pending.push({ table: 'book_files', bookId, branch: MAIN, filePath, content }));
        for (const name of names) {
          const info = readJSON(path.join(branchesDir, name, 'branch.json'), {});
          counts.branches++;
          await client.query('INSERT INTO branches (user_id, book_id, name, created_from, created_at) VALUES ($1, $2, $3, $4, $5)', [userId, bookId, name, info.from || null, info.createdAt || new Date().toISOString()]);
          walk(path.join(branchesDir, name), '', new Set(['.base', '.branches']), (filePath, content) => { if (filePath !== 'branch.json') pending.push({ table: 'book_files', bookId, branch: name, filePath, content }); });
          walk(path.join(branchesDir, name, '.base'), '', new Set(), (filePath, content) => pending.push({ table: 'branch_bases', bookId, branch: name, filePath, content }));
        }
        for (const file of pending) await insertFile(client, file);
      }
      return counts;
    });
  }

  return {
    dir,
    readLibrary, writeLibrary, listBooks,
    createBook, readBookMeta, writeBookMeta, trashBook,
    chapterStamps, readChapter, writeChapter, deleteChapter,
    readAux, writeAux, readSidecar, writeSidecar,
    setCoverBytes, removeCover, readCover, setMapImage, addFigure, storePainting,
    branches, dailyBackup, exportZip, isEmpty, importFolder, footprint, erase
  };
}

module.exports = { openPgLibrary, COVER_EXTS };
