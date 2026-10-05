'use strict';

// Public pages on files: one page per (writer, book, chapter), publishing
// again keeps the link, removal is the owner's alone, tokens are long and
// unguessable, and a bad token finds nothing.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonShareStore, isToken, WHOLE_BOOK } = require('../lib/share-store');

describe('JsonShareStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-shares-'));
  const store = new JsonShareStore(dir);
  const page = '<!doctype html><html><body><p>Once upon a time.</p></body></html>';

  test('publishes, lists, finds and republishes under the same link', async () => {
    const first = await store.publish({ userId: 'u1', bookId: 'b1', chapterId: WHOLE_BOOK, title: 'Wool', html: page });
    assert.ok(isToken(first.token));
    assert.equal(first.chapterId, WHOLE_BOOK);
    const chapter = await store.publish({ userId: 'u1', bookId: 'b1', chapterId: 'ch-1', title: 'Holston', html: page });
    assert.notEqual(chapter.token, first.token);
    const again = await store.publish({ userId: 'u1', bookId: 'b1', chapterId: WHOLE_BOOK, title: 'Wool, revised', html: page + '<!-- v2 -->' });
    assert.equal(again.token, first.token, 'the link survives a republish');
    const listed = await store.list('u1', 'b1');
    assert.deepEqual(listed.map((s) => [s.chapterId, s.title]).sort(), [['', 'Wool, revised'], ['ch-1', 'Holston']]);
    assert.ok(listed.every((s) => !('html' in s) && !('userId' in s)), 'a listing carries no words and no owner');
    const found = await store.find(first.token);
    assert.equal(found.html, page + '<!-- v2 -->');
    assert.equal(found.userId, 'u1');
    assert.deepEqual(await store.list('u2', 'b1'), [], 'another writer sees nothing');
  });

  test('only the owner removes, and a bad token is nothing', async () => {
    const share = (await store.list('u1', 'b1')).find((s) => s.chapterId === WHOLE_BOOK); // the one that was rewritten, so a .bak exists
    assert.equal(await store.remove('u2', share.token), false);
    assert.ok(await store.find(share.token), 'still there');
    assert.equal(await store.remove('u1', share.token), true);
    assert.equal(await store.find(share.token), null);
    assert.equal((await store.list('u1', 'b1')).length, 1, 'and it does not come back from a .bak');
    assert.equal(await store.find('../../etc/passwd'), null);
    assert.equal(await store.find(''), null);
    assert.equal(await store.remove('u1', 'nope'), false);
    assert.equal((await store.list('u1', 'b1')).length, 1);
  });
});
