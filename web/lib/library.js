'use strict';

// One writer's NEO Library on the server's disk: the same folder layout as
// the desktop app (book-<slug>-<id>/book.json, chapters/<id>.html, sidecars),
// so a writer can download the folder and open it in desktop NEO, or upload
// a desktop library here. Every method mirrors an ipcMain.handle in main.js
// and is named after its IPC channel in handlers.js.
//
// Methods are synchronous like their originals: the files are small, Node is
// single-threaded, and a request never interleaves with another's write.

const fs = require('node:fs');
const path = require('node:path');
const { libName, writeFileDurable, readJSON, writeJSON } = require('./files');

const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const COVER_FILE = /^(cover|art)-\d+\.(png|jpg|webp)$/;
const SKIP_IN_BACKUP = new Set(['Backups', 'Exports', 'Trash']);
const BACKUPS_KEPT = 14;

/**
 * @param {object} deps
 * @param {string} deps.dir       the library folder; created on first use
 * @param {(key: string, vars?: object) => string} deps.t   the writer's translator, for seed strings
 * @param {(source: string, err: unknown) => void} deps.logError
 */
function openLibrary({ dir, t, logError }) {
  const libraryFile = path.join(dir, 'library.json');
  const recovered = (what) => logError('recovered', what);

  function ensure() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(libraryFile)) {
      writeJSON(libraryFile, {
        authorName: '',
        penNames: [],
        firstRunDone: false,
        pageTheme: 'night',
        shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: [] }]
      });
    }
  }

  const bookDir = (bookId) => path.join(dir, libName(bookId));
  const bookFolders = () => {
    try { return fs.readdirSync(dir).filter((d) => d.startsWith('book-')); } catch { return []; }
  };

  // _catalog.txt: a human-readable map of folder → title → shelf
  function writeCatalog() {
    try {
      const lib = readJSON(libraryFile, { shelves: [] }, recovered);
      const onShelf = {};
      for (const shelf of lib.shelves || []) for (const id of shelf.bookIds || []) onShelf[id] = shelf.name;
      const lines = [];
      for (const folder of bookFolders()) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, folder, 'book.json'), 'utf8'));
          lines.push(`${meta.title || t('Untitled')}  —  ${folder}  —  ${t('shelf:')} ${onShelf[meta.id] || t('(none — removed from shelves)')}`);
        } catch { /* not a book folder */ }
      }
      lines.sort((a, b) => a.localeCompare(b));
      fs.writeFileSync(path.join(dir, '_catalog.txt'),
        t('NEO LIBRARY CATALOG — which folder is which book') + '\n' +
        t('(regenerated automatically; edits here do nothing)') + '\n\n' + lines.join('\n') + '\n');
    } catch (err) {
      logError('catalog', err);
    }
  }

  // book.json gone with no copy: the chapters are still there, so the book
  // comes back with them in the order they were made
  function rebuildBookMeta(bookId) {
    const folder = bookDir(bookId);
    const chaptersDir = path.join(folder, 'chapters');
    if (!fs.existsSync(chaptersDir)) return null;
    let title = '';
    try {
      const catalog = fs.readFileSync(path.join(dir, '_catalog.txt'), 'utf8');
      const line = catalog.split('\n').find((l) => l.includes('  —  ' + bookId + '  —  '));
      if (line) title = line.split('  —  ')[0].trim();
    } catch { /* no catalog */ }
    const order = fs.readdirSync(chaptersDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
    const meta = {
      id: bookId,
      title: title || t('Untitled'),
      subtitle: '', series: '', author: t('Anonymous'), wordGoal: 0,
      created: new Date().toISOString(), modified: new Date().toISOString(),
      chapterOrder: order,
      tabNames: { notes: 'Notes', outline: 'Outline' }
    };
    logError('recovered', `${bookId}/book.json was lost; rebuilt from ${order.length} chapter files`);
    try { writeJSON(path.join(folder, 'book.json'), meta); } catch (err) { logError('recover write', err); }
    return meta;
  }

  function readLibrary() {
    ensure();
    const lib = readJSON(libraryFile, null, recovered);
    if (lib) return lib;
    // library.json lost with no copy: every book goes onto one shelf
    const ids = bookFolders().filter((d) => fs.existsSync(path.join(dir, d, 'chapters')));
    const seed = {
      authorName: '', penNames: [], firstRunDone: ids.length > 0, pageTheme: 'night',
      shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: ids }]
    };
    logError('recovered', `library.json was lost; ${ids.length} books put back on one shelf`);
    try { writeJSON(libraryFile, seed); } catch (err) { logError('recover write', err); }
    return seed;
  }

  function writeLibrary(data) {
    ensure();
    writeJSON(libraryFile, data);
    writeCatalog();
    return true;
  }

  function createBook(meta = {}) {
    ensure();
    const slug = String(meta.title || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    const id = 'book-' + (slug ? slug + '-' : '') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const folder = bookDir(id);
    fs.mkdirSync(path.join(folder, 'chapters'), { recursive: true });
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
    writeJSON(path.join(folder, 'book.json'), book);
    fs.writeFileSync(path.join(folder, 'notes.html'), '');
    fs.writeFileSync(path.join(folder, 'outline.html'), '');
    writeJSON(path.join(folder, 'darlings.json'), []);
    writeJSON(path.join(folder, 'stickies.json'), []);
    return book;
  }

  function listBooks() {
    const out = [];
    for (const folder of bookFolders()) {
      const meta = readJSON(path.join(dir, folder, 'book.json'), null, recovered);
      if (meta && meta.id) out.push({ id: meta.id, title: meta.title || t('Untitled'), author: meta.author || '', modified: meta.modified || '', kind: meta.kind || '' });
    }
    return out;
  }

  function readBookMeta(bookId) {
    return readJSON(path.join(bookDir(bookId), 'book.json'), null, recovered) || rebuildBookMeta(bookId);
  }

  function writeBookMeta(bookId, meta) {
    meta.modified = new Date().toISOString();
    writeJSON(path.join(bookDir(bookId), 'book.json'), meta);
    writeCatalog();
    return meta.modified;
  }

  // {chapterId: "mtimeMs:size"}: how the page tells what changed on disk
  // without re-reading every chapter (and how two browsers sharing one
  // library notice each other)
  function chapterStamps(bookId) {
    const out = {};
    try {
      const chaptersDir = path.join(bookDir(bookId), 'chapters');
      for (const f of fs.readdirSync(chaptersDir)) {
        if (!f.endsWith('.html')) continue;
        try {
          const st = fs.statSync(path.join(chaptersDir, f));
          out[f.slice(0, -5)] = st.mtimeMs + ':' + st.size;
        } catch { /* vanished between readdir and stat */ }
      }
    } catch { /* no chapters folder yet */ }
    return out;
  }

  const chapterFile = (bookId, chapterId) => path.join(bookDir(bookId), 'chapters', libName(chapterId) + '.html');

  // a bad name throws (as on the desktop); a chapter that is not there reads empty
  function readChapter(bookId, chapterId) {
    const file = chapterFile(bookId, chapterId);
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }

  function writeChapter(bookId, chapterId, html) {
    const file = chapterFile(bookId, chapterId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileDurable(file, String(html ?? ''));
    return true;
  }

  function deleteChapter(bookId, chapterId) {
    const file = chapterFile(bookId, chapterId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  }

  function readAux(bookId, name) {
    const file = path.join(bookDir(bookId), libName(name) + '.html');
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }

  function writeAux(bookId, name, html) {
    writeFileDurable(path.join(bookDir(bookId), libName(name) + '.html'), String(html ?? ''));
    return true;
  }

  function readSidecar(bookId, name, fallback) {
    return readJSON(path.join(bookDir(bookId), libName(name) + '.json'), fallback, recovered);
  }

  function writeSidecar(bookId, name, data) {
    writeJSON(path.join(bookDir(bookId), libName(name) + '.json'), data);
    return true;
  }

  // Words are never discarded. There is no system trash on a server, so the
  // book folder moves to the library's own Trash folder, timestamped, where
  // the writer (or a support hand) can bring it back. Returns false, with the
  // folder untouched, if the move fails.
  function trashBook(bookId) {
    const folder = bookDir(bookId);
    if (!fs.existsSync(folder)) return true;
    try {
      const trash = path.join(dir, 'Trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.renameSync(folder, path.join(trash, `${libName(bookId)}--${stamp}`));
      writeCatalog();
      return true;
    } catch (err) {
      logError('trash', err);
      return false;
    }
  }

  function clearCovers(folder) {
    for (const f of fs.readdirSync(folder)) {
      if (/^cover-\d+\./.test(f)) fs.unlinkSync(path.join(folder, f));
    }
  }

  /** Stores uploaded cover bytes as cover-<ts>.<ext>; returns the file name, or null for a type NEO does not take. */
  function setCoverBytes(bookId, ext, bytes) {
    ext = String(ext || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) return null;
    const folder = bookDir(bookId);
    if (!fs.existsSync(folder)) return null;
    clearCovers(folder);
    const fname = 'cover-' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    writeFileDurable(path.join(folder, fname), bytes);
    return fname;
  }

  function removeCover(bookId) {
    const folder = bookDir(bookId);
    if (fs.existsSync(folder)) clearCovers(folder);
    return true;
  }

  /** The on-disk path of a cover or painting, or null when the name is not one NEO made. */
  function coverPath(bookId, fname) {
    if (!COVER_FILE.test(String(fname))) return null;
    const file = path.join(bookDir(bookId), fname);
    return fs.existsSync(file) ? file : null;
  }

  /** Replaces the painting: older art-* files go, art.json records the brief. */
  function storePainting(bookId, { buffer, ext, brief, provider, textModel, imageModel }) {
    const folder = bookDir(bookId);
    for (const f of fs.readdirSync(folder)) {
      if (/^art-\d+\.(png|jpg|webp)$/.test(f)) fs.unlinkSync(path.join(folder, f));
    }
    const fname = 'art-' + Date.now() + '.' + (ext || 'jpg');
    writeFileDurable(path.join(folder, fname), buffer);
    writeJSON(path.join(folder, 'art.json'), { file: fname, brief, provider, textModel, imageModel, painted: new Date().toISOString() });
    return fname;
  }

  function appendErrorLog(line) {
    ensure();
    fs.appendFileSync(path.join(dir, 'neo-errors.log'), line);
  }

  // One zip of the whole library per day, keeping the last 14. Backups and
  // exports stay out of the zip; so does the Trash, which is its own safety net.
  async function dailyBackup() {
    ensure();
    const backupsDir = path.join(dir, 'Backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(backupsDir, `neo-backup-${today}.zip`);
    if (fs.existsSync(target)) return false;
    const JSZip = require('jszip');
    const zip = new JSZip();
    const missed = [];
    const walk = (folder, rel) => {
      let names = [];
      try { names = fs.readdirSync(folder); } catch (err) { missed.push(`${rel || '.'} (${err.code || err.message})`); return; }
      for (const name of names) {
        if (rel === '' && SKIP_IN_BACKUP.has(name)) continue;
        const full = path.join(folder, name);
        const relPath = rel ? rel + '/' + name : name;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) walk(full, relPath);
          else zip.file(relPath, fs.readFileSync(full));
        } catch (err) {
          missed.push(`${relPath} (${err.code || err.message})`);
        }
      }
    };
    walk(dir, '');
    if (missed.length) {
      zip.file('_left-out-of-this-backup.txt', missed.join('\n') + '\n');
      logError('backup', new Error('left out of today\'s backup: ' + missed.join(', ')));
    }
    writeFileDurable(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const backups = fs.readdirSync(backupsDir).filter((f) => f.startsWith('neo-backup-')).sort();
    while (backups.length > BACKUPS_KEPT) fs.unlinkSync(path.join(backupsDir, backups.shift()));
    return true;
  }

  return {
    dir, ensure,
    readLibrary, writeLibrary, listBooks,
    createBook, readBookMeta, writeBookMeta, trashBook,
    chapterStamps, readChapter, writeChapter, deleteChapter,
    readAux, writeAux, readSidecar, writeSidecar,
    setCoverBytes, removeCover, coverPath, storePainting,
    appendErrorLog, dailyBackup
  };
}

module.exports = { openLibrary, COVER_EXTS };
