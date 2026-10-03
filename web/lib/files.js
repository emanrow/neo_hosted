'use strict';

// The disk primitives NEO's main process trusts its books to, ported for the
// hosted server. Same contract as main.js: a name is one path segment, a
// write is tmp + fsync + rename, and a JSON read falls back on the copies a
// write leaves behind. If main.js changes one of these, change it here too
// (see HOSTED.md, "What was ported").

const fs = require('node:fs');
const path = require('node:path');

/**
 * Accepts one plain name inside the library and nothing else. ".", "..",
 * slashes and null bytes never reach the disk, however they arrive.
 * Throws rather than returning null so a caller cannot forget to check.
 */
function libName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error('Invalid library name');
  }
  return name;
}

/**
 * Writes a file so a power cut cannot leave it empty: a sibling .tmp is
 * written and pushed to disk, then renamed into place. The folder is pushed
 * too, so the rename itself survives.
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
    try { writeFileDurable(file, JSON.stringify(value, null, 2)); } catch { /* the read still succeeds */ }
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

module.exports = { libName, writeFileDurable, parseJSONFile, readJSON, writeJSON };
