'use strict';

// lib/image-store.js on its own: the library keeps the file name and its
// rules, the bucket keeps the bytes when there is one, and the volume (or
// the rows) keeps them when there is not.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createImageStore, isStub, STUB } = require('../lib/image-store');

/** A library that remembers what it was handed, by name. */
function fakeLibrary() {
  const files = new Map();
  let n = 0;
  return {
    files,
    setCoverBytes: async (bookId, ext, bytes) => { const fname = `cover-${++n}.${ext}`; files.set(`${bookId}/${fname}`, bytes); return fname; },
    addFigure: async (bookId, ext, bytes) => { if (!bytes) return null; const fname = `fig-${++n}.${ext}`; files.set(`${bookId}/${fname}`, bytes); return fname; },
    readCover: async (bookId, fname) => files.get(`${bookId}/${fname}`) || null
  };
}

/** A bucket that keeps what it is sent, and can be told to refuse. */
function fakeBucket({ refuse = false } = {}) {
  const objects = new Map();
  return {
    enabled: true, objects, bucket: 'words',
    put: async (key, bytes, type) => { if (refuse) throw new Error('SlowDown'); objects.set(key, { bytes, type }); },
    get: async (key) => (objects.has(key) ? objects.get(key).bytes : null)
  };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('without a bucket', () => {
  test('the bytes go to the library and come back from it', async () => {
    const library = fakeLibrary();
    const images = createImageStore({ objectStore: { enabled: false, put: async () => {}, get: async () => null }, writerId: 'w1', library });
    assert.equal(images.enabled, false);
    const fname = await images.put(library.setCoverBytes, 'book-1', 'png', png);
    assert.equal(fname, 'cover-1.png');
    assert.deepEqual(library.files.get('book-1/cover-1.png'), png);
    assert.deepEqual(await images.get('book-1', 'cover-1.png'), png);
    assert.equal(await images.get('book-1', 'cover-9.png'), null);
  });
});

describe('with a bucket', () => {
  test('the library keeps a stub, the bucket the bytes, and a read follows the stub', async () => {
    const library = fakeLibrary();
    const bucket = fakeBucket();
    const images = createImageStore({ objectStore: bucket, writerId: 'w1', library });
    assert.equal(images.enabled, true);
    const fname = await images.put(library.addFigure, 'book-1', 'png', png);
    assert.equal(fname, 'fig-1.png');
    assert.ok(isStub(library.files.get('book-1/fig-1.png')), 'the library holds the stub');
    assert.equal(library.files.get('book-1/fig-1.png').toString(), STUB);
    const stored = bucket.objects.get('images/w1/book-1/fig-1.png');
    assert.deepEqual(stored.bytes, png);
    assert.equal(stored.type, 'image/png');
    assert.deepEqual(await images.get('book-1', 'fig-1.png'), png);
  });

  test('an image stored before the bucket existed is still served from the library', async () => {
    const library = fakeLibrary();
    library.files.set('book-1/cover-0.png', png);
    const images = createImageStore({ objectStore: fakeBucket(), writerId: 'w1', library });
    assert.deepEqual(await images.get('book-1', 'cover-0.png'), png);
  });

  test('a bucket that refuses leaves the bytes with the words, and the upload still succeeds', async () => {
    const library = fakeLibrary();
    const logged = [];
    const images = createImageStore({ objectStore: fakeBucket({ refuse: true }), writerId: 'w1', library, logError: (s, e) => logged.push(`${s}: ${e.message}`) });
    const fname = await images.put(library.setCoverBytes, 'book-1', 'png', png);
    assert.equal(fname, 'cover-2.png', 'placed again, with the bytes');
    assert.deepEqual(library.files.get('book-1/cover-2.png'), png);
    assert.deepEqual(logged, ['images: SlowDown']);
  });

  test('nothing to store means nothing goes to the bucket (a sheet removed, a refused type)', async () => {
    const library = fakeLibrary();
    const bucket = fakeBucket();
    const images = createImageStore({ objectStore: bucket, writerId: 'w1', library });
    assert.equal(await images.put(library.addFigure, 'book-1', 'png', null), null);
    assert.equal(bucket.objects.size, 0);
  });

  test('the export hook puts the picture back in the stub\'s place, and leaves other files alone', async () => {
    const library = fakeLibrary();
    const bucket = fakeBucket();
    const images = createImageStore({ objectStore: bucket, writerId: 'w1', library });
    const fname = await images.put(library.setCoverBytes, 'book-1', 'png', png);
    const words = Buffer.from('<p>words</p>');
    assert.equal(images.forExport('book-1/chapters/ch-1.html', words), words);
    assert.deepEqual(await images.forExport(`book-1/${fname}`, library.files.get(`book-1/${fname}`)), png);
    assert.deepEqual(await images.forExport(`book-1/.branches/draft-two/${fname}`, library.files.get(`book-1/${fname}`)), png, 'a branch folder resolves to the same key');
  });

  test('a stub left behind when the bucket is gone reads as no image, and says so in the log', async () => {
    const library = fakeLibrary();
    library.files.set('book-1/fig-1.png', Buffer.from(STUB));
    const logged = [];
    const images = createImageStore({ objectStore: { enabled: false, get: async () => null }, writerId: 'w1', library, logError: (s, e) => logged.push(`${s}: ${e.message}`) });
    assert.equal(await images.get('book-1', 'fig-1.png'), null);
    assert.match(logged[0], /no longer configured/);
  });
});
