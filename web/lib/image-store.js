'use strict';

// Where a book's images live: covers, paintings, the map map's sheet and a
// chapter's pictures. The library (files on the volume, or rows) always
// owns the file name and the rules for it (one cover, one sheet, pictures
// never replaced), because the desktop folder a writer downloads must look
// the same whatever holds the bytes. With a bucket configured the bytes go
// there, under images/<writer>/<book>/<file>, and the library keeps a
// one-line stub in the file's place; without one, the bytes stay in the
// library as they always did. A read looks in the library first, so an
// image stored before the bucket existed is still served, and a stub is
// followed into the bucket. The download zip and the removed-account zip
// put the bytes back in the stub's place; the daily backup leaves the stub,
// since the bucket already holds the picture.

const path = require('node:path');
const { MIME } = require('./http');

const STUB = 'neo-image-in-bucket\n';   // what the library holds when the bucket has the bytes
const STUB_BYTES = Buffer.from(STUB);

const isStub = (bytes) => Buffer.isBuffer(bytes) && bytes.length === STUB_BYTES.length && bytes.equals(STUB_BYTES);

/**
 * @param {object} deps
 * @param {{ enabled: boolean, put: Function, get?: Function }} deps.objectStore   lib/object-store.js, or its stand-in
 * @param {string} deps.writerId
 * @param {object} deps.library   openLibrary / openPgLibrary: readCover and the placing methods
 * @param {(source: string, err: unknown) => void} [deps.logError]
 */
function createImageStore({ objectStore, writerId, library, logError = () => {} }) {
  const enabled = !!(objectStore && objectStore.enabled && typeof objectStore.get === 'function');
  const keyFor = (bookId, fname) => `images/${writerId}/${bookId}/${fname}`;
  const typeOf = (fname) => MIME[path.extname(fname).toLowerCase()] || 'application/octet-stream';

  /**
   * Stores an image through one of the library's placing methods
   * (setCoverBytes, setMapImage, addFigure, or a wrapper round storePainting):
   * `place(bookId, ext, bytes)` allocates the name and clears what it replaces.
   * With a bucket the library gets the stub and the bucket the bytes; a bucket
   * that refuses falls back on the library, so an upload never fails for it.
   * @returns the file name the library chose, '' or null as the method would
   */
  async function put(place, bookId, ext, bytes) {
    if (!enabled || !bytes || !bytes.length) return place(bookId, ext, bytes);
    const fname = await place(bookId, ext, STUB_BYTES);
    if (!fname) return fname;
    try {
      await objectStore.put(keyFor(bookId, fname), bytes, typeOf(fname));
      return fname;
    } catch (err) {
      logError('images', err);
      return place(bookId, ext, bytes);   // the bytes stay with the words; a later upload may reach the bucket
    }
  }

  /** The bytes of an image by its file name: from the library, or from the bucket when the library holds the stub. Null when there is none. */
  async function get(bookId, fname) {
    const bytes = await library.readCover(bookId, fname);
    if (!bytes) return null;
    if (!isStub(bytes)) return bytes;
    if (!enabled) { logError('images', new Error(`${bookId}/${fname} is in a bucket that is no longer configured`)); return null; }
    try { return await objectStore.get(keyFor(bookId, fname)); } catch (err) { logError('images', err); return null; }
  }

  /**
   * For the library's exportZip: a file's bytes as the zip should carry
   * them. A stub becomes the picture from the bucket (JSZip takes the
   * promise), so the folder a writer downloads is whole.
   */
  function forExport(relPath, bytes) {
    if (!isStub(bytes)) return bytes;
    const [bookId] = relPath.split('/');
    return get(bookId, path.basename(relPath)).then((found) => found || bytes);
  }

  return { enabled, put, get, forExport, keyFor };
}

module.exports = { createImageStore, isStub, STUB };
