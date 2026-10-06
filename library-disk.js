'use strict';

// The disk under a NEO Library, shared by the desktop app (main.js) and the
// hosted server (web/lib/library.js). Books are plain files, and these are
// the rules that keep them safe: a name is one path segment, a write is
// tmp + fsync + rename, a JSON read falls back on the copies a write leaves
// behind, a lost book.json or library.json is rebuilt from what is still on
// disk, and the daily backup leaves out the one file a sync tool will not
// hand over rather than losing the day. Nothing here knows about Electron or
// HTTP; a caller brings its translator and its error log.

const fs = require('node:fs');
const path = require('node:path');

/* ---------- the primitives ---------- */

/**
 * Accepts one plain name inside the library and nothing else. ".", "..",
 * slashes and null bytes never reach the disk, however they arrive. Any
 * name NEO ever made passes, and so does a folder named by hand. Throws
 * rather than returning null so a caller cannot forget to check.
 */
function libName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error('Invalid library name');
  }
  return name;
}

/**
 * Writing that survives the power going out. A new file is written beside
 * the old one, pushed all the way to the disk (fsync), and only then swapped
 * in. Without the push, a power cut right after the swap can leave the swap
 * done and the words not: an empty book.json, and the book gone from its
 * shelf (#219). The folder is pushed too, so the rename itself survives.
 */
function writeFileDurable(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, typeof data === 'string' ? data : Buffer.from(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* a filesystem that will not fsync a directory */ }
  }
}

function parseJSONFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * Reads JSON, and when the file is missing or torn, the .tmp a write was
 * making, then the .bak of the last version that read whole. Whatever it
 * recovers is written back as the file itself.
 *
 * @param {(what: string) => void} [onRecovered] hears about a recovery, for the error log
 */
function readJSON(file, fallback, onRecovered) {
  const main = parseJSONFile(file);
  if (main !== undefined) return main;
  if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return fallback;
  for (const spare of [file + '.tmp', file + '.bak']) {
    const value = parseJSONFile(spare);
    if (value === undefined) continue;
    if (onRecovered) onRecovered(`${file} was unreadable; restored from ${path.basename(spare)}`);
    try { writeFileDurable(file, JSON.stringify(value, null, 2)); } catch (err) {
      if (onRecovered) onRecovered(`${file} could not be put back on disk: ${err.message}`);
    }
    return value;
  }
  return fallback;
}

/** Keeps the readable version on disk as .bak, then writes the new one durably. */
function writeJSON(file, data) {
  if (parseJSONFile(file) !== undefined) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* the write still goes ahead */ }
  }
  writeFileDurable(file, JSON.stringify(data, null, 2));
}

/** The book folders in a library, by name. */
function bookFolders(libraryDir) {
  try { return fs.readdirSync(libraryDir).filter((d) => d.startsWith('book-')); } catch { return []; }
}

/* ---------- the library's own files ---------- */

const CATALOG_SEPARATOR = '  —  ';
const DEFAULT_BACKUP_SKIP = ['Backups', 'Exports'];

/**
 * The parts of a library that need the writer's language and an error log:
 * the catalog, the recoveries and the backup zip. Both editions call these
 * with their own folder, which the desktop can change while it runs.
 *
 * @param {object} deps
 * @param {(key: string, vars?: object) => string} deps.t   the translator, for seed strings
 * @param {(source: string, err: unknown) => void} deps.logError
 */
function forLibrary({ t, logError }) {
  const recovered = (what) => logError('recovered', what);

  /**
   * _catalog.txt: a human-readable map of folder → title → shelf, regenerated
   * on every change so a writer browsing the folder can find their way.
   */
  function writeCatalog(libraryDir, libraryFile = path.join(libraryDir, 'library.json')) {
    try {
      const lib = readJSON(libraryFile, { shelves: [] }, recovered);
      const onShelf = {};
      for (const shelf of lib.shelves || []) for (const id of shelf.bookIds || []) onShelf[id] = shelf.name;
      const lines = [];
      for (const folder of bookFolders(libraryDir)) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(libraryDir, folder, 'book.json'), 'utf8'));
          lines.push([meta.title || t('Untitled'), folder, `${t('shelf:')} ${onShelf[meta.id] || t('(none — removed from shelves)')}`].join(CATALOG_SEPARATOR));
        } catch { /* not a book folder */ }
      }
      lines.sort((a, b) => a.localeCompare(b));
      fs.writeFileSync(path.join(libraryDir, '_catalog.txt'),
        t('NEO LIBRARY CATALOG — which folder is which book') + '\n' +
        t('(regenerated automatically; edits here do nothing)') + '\n\n' + lines.join('\n') + '\n');
    } catch (err) {
      logError('catalog', err);
    }
  }

  /**
   * A book whose book.json is gone for good (and no .bak) still has its
   * chapters: the book comes back with them in the order they were made,
   * its title from the catalog, rather than vanishing from the shelf.
   *
   * @param {string} folder  where the book's files are (its own folder, or a branch's on the server)
   * @returns the rebuilt meta, or null when there are no chapters to rebuild from
   */
  function rebuildBookMeta(bookId, folder, libraryDir) {
    const chaptersDir = path.join(folder, 'chapters');
    if (!fs.existsSync(chaptersDir)) return null;
    let title = '';
    try {
      const catalog = fs.readFileSync(path.join(libraryDir, '_catalog.txt'), 'utf8');
      const line = catalog.split('\n').find((l) => l.includes(CATALOG_SEPARATOR + bookId + CATALOG_SEPARATOR));
      if (line) title = line.split(CATALOG_SEPARATOR)[0].trim();
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

  /**
   * library.json lost with no copy to fall back on: every book in the folder
   * goes onto one shelf, so nothing disappears. Returns the seed it wrote.
   */
  function seedLostLibrary(libraryDir, libraryFile = path.join(libraryDir, 'library.json')) {
    const ids = bookFolders(libraryDir).filter((d) => fs.existsSync(path.join(libraryDir, d, 'chapters')));
    const seed = {
      authorName: '', penNames: [], firstRunDone: ids.length > 0, pageTheme: 'night',
      shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: ids }]
    };
    logError('recovered', `library.json was lost; ${ids.length} books put back on one shelf`);
    try { writeJSON(libraryFile, seed); } catch (err) { logError('recover write', err); }
    return seed;
  }

  /**
   * Puts the library's files into a JSZip. One file the system won't hand
   * over (in iCloud but not downloaded yet, held by a sync tool) used to
   * throw, and cost the whole day's backup, every day. Now it's left out,
   * named in the zip and in the error log.
   *
   * @param {string[]} [skip]  top-level folders to leave out
   */
  function fillZip(zip, libraryDir, skip = DEFAULT_BACKUP_SKIP) {
    const skipped = new Set(skip);
    const missed = [];
    const walk = (folder, rel) => {
      let names = [];
      try { names = fs.readdirSync(folder); } catch (err) { missed.push(`${rel || '.'} (${err.code || err.message})`); return; }
      for (const name of names) {
        if (rel === '' && skipped.has(name)) continue;
        if (name === '.DS_Store' || /^\..+\.icloud$/.test(name)) continue; // Finder litter; iCloud's stand-in for a file not downloaded
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
    walk(libraryDir, '');
    if (missed.length) {
      zip.file('_left-out-of-this-backup.txt', missed.join('\n') + '\n');
      logError('backup', new Error('left out of today\'s backup: ' + missed.join(', ')));
    }
    return missed;
  }

  return { writeCatalog, rebuildBookMeta, seedLostLibrary, fillZip };
}

module.exports = { libName, writeFileDurable, parseJSONFile, readJSON, writeJSON, bookFolders, forLibrary, DEFAULT_BACKUP_SKIP };
