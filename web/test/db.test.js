'use strict';

// The Postgres user store, against a real Postgres. Skipped unless
// NEO_TEST_DATABASE_URL names a scratch database (CI starts one; on a
// laptop, `docker run -e POSTGRES_PASSWORD=neo -p 5432:5432 postgres:16`).
// Every run starts by dropping the tables, so point it at nothing you love.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const DATABASE_URL = process.env.NEO_TEST_DATABASE_URL;

describe('PgUserStore', { skip: DATABASE_URL ? false : 'NEO_TEST_DATABASE_URL is not set' }, () => {
  const { openDatabase, MIGRATIONS } = require('../lib/db');
  const { PgUserStore, JsonUserStore } = require('../lib/user-store');
  const { createApp } = require('../server');

  const db = openDatabase(DATABASE_URL);
  const store = new PgUserStore(db);

  before(async () => {
    await db.query('DROP TABLE IF EXISTS revisions, users, schema_migrations');
  });
  after(() => db.close());

  test('migrate applies each step once and remembers it', async () => {
    assert.deepEqual(await db.migrate(), MIGRATIONS.map((m) => m.id));
    assert.deepEqual(await db.migrate(), [], 'a second boot has nothing to do');
  });

  test('create, find, verify, change the password', async () => {
    assert.equal(await store.count(), 0);
    const user = await store.create({ email: ' Ann@Example.com ', passwordHash: 'hash-1', emailVerified: false });
    assert.match(user.id, /^u-[0-9a-f]{16}$/);
    assert.equal(user.email, 'ann@example.com', 'emails are normalized on the way in');
    assert.equal(user.emailVerifiedAt, null);
    assert.deepEqual(await store.findByEmail('ANN@example.com'), user, 'and on the way out');
    assert.deepEqual(await store.findById(user.id), user);
    assert.equal(await store.findById('u-nobody'), null);
    assert.equal(await store.count(), 1);

    await assert.rejects(store.create({ email: 'ann@example.com', passwordHash: 'x' }), /already has an account/);
    await assert.rejects(store.create({ email: '  ', passwordHash: 'x' }), /email address is needed/);

    await store.markEmailVerified(user.id);
    const verified = await store.findById(user.id);
    assert.ok(verified.emailVerifiedAt, 'now a date');
    await store.markEmailVerified(user.id);
    assert.equal((await store.findById(user.id)).emailVerifiedAt, verified.emailVerifiedAt, 'confirming twice keeps the first date');

    await store.setPasswordHash(user.id, 'hash-2');
    assert.equal((await store.findById(user.id)).passwordHash, 'hash-2');
    await assert.rejects(store.setPasswordHash('u-nobody', 'x'), /No such user/);
  });

  test('a users.json is imported once, ids and all, and never over existing rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-db-'));
    const json = new JsonUserStore(path.join(dir, 'users.json'));
    const old = json.create({ email: 'old@example.com', passwordHash: 'hash-old' });
    delete old.emailVerifiedAt; // an account from before email existed
    json.save([old, json.create({ email: 'waiting@example.com', passwordHash: 'hash-w', emailVerified: false })]);

    assert.equal(await store.importFrom(json), 0, 'the table already has Ann, so nothing moves');
    await db.query('DELETE FROM revisions; DELETE FROM users');
    assert.equal(await store.importFrom(json), 2);
    const imported = await store.findById(old.id);
    assert.equal(imported.email, 'old@example.com');
    assert.equal(imported.passwordHash, 'hash-old');
    assert.ok(imported.emailVerifiedAt, 'an account from before email counts as confirmed');
    assert.equal((await store.findByEmail('waiting@example.com')).emailVerifiedAt, null, 'one still waiting keeps waiting');
  });

  test('the server signs writers up and in through Postgres, and imports users.json on boot', async () => {
    await db.query('DELETE FROM revisions; DELETE FROM users');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-dbserver-'));
    const { hashPassword } = require('../lib/auth');
    new JsonUserStore(path.join(dataDir, 'users.json')).create({ email: 'first@example.com', passwordHash: hashPassword('longenough') });

    const app = createApp({ dev: false, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: '', mail: {} }, { db });
    assert.deepEqual(await app.ready, { store: 'postgres', imported: 1 });
    assert.ok(!fs.existsSync(path.join(dataDir, 'users.json')), 'the file was renamed out of the way');
    assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('users.json.imported-')), 'but kept');
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
    try {
      const login = await post('/auth/login', { email: 'first@example.com', password: 'longenough' });
      assert.equal(login.status, 200, 'the imported writer signs in with the same password');
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const signup = await post('/auth/signup', { email: 'second@example.com', password: 'longenough' });
      assert.equal(signup.status, 200);
      assert.equal(await store.count(), 2);

      const me = await fetch(base + '/api/library:read', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: '{"args":[]}' });
      assert.equal(me.status, 200, 'a session cookie finds its writer in the table');
    } finally {
      await app.close();
    }
  });
});

describe('RevisionLog', { skip: DATABASE_URL ? false : 'NEO_TEST_DATABASE_URL is not set' }, () => {
  const { openDatabase } = require('../lib/db');
  const { PgUserStore } = require('../lib/user-store');
  const { RevisionLog, makeDiff, applyDiff, SNAPSHOT_EVERY } = require('../lib/revisions');
  const { createApp } = require('../server');

  const db = openDatabase(DATABASE_URL);
  const log = new RevisionLog(db);
  let writer;

  before(async () => {
    await db.query('DROP TABLE IF EXISTS revisions, users, schema_migrations');
    await db.migrate();
    writer = await new PgUserStore(db).create({ email: 'rev@example.com', passwordHash: 'h' });
  });
  after(() => db.close());

  test('a diff at paragraph grain round-trips, including an empty chapter', () => {
    const a = '<p>One.</p><p>Two.</p><p>Three.</p>';
    const b = '<p>One.</p><p>Two, revised.</p><hr class="sb"><p>Three.</p><p>Four.</p>';
    assert.equal(applyDiff(a, makeDiff(a, b)), b);
    assert.equal(applyDiff(b, makeDiff(b, a)), a);
    assert.equal(applyDiff('', makeDiff('', a)), a);
    assert.equal(applyDiff(a, makeDiff(a, '')), '');
    assert.equal(applyDiff('plain text, no tags', makeDiff('plain text, no tags', 'plain text, no tags at all')), 'plain text, no tags at all');
  });

  test('records changes only, snapshots on a cadence, rebuilds any revision, and keeps the chain intact', async () => {
    const key = { userId: writer.id, bookId: 'book-1', chapterId: 'ch-1' };
    const first = await log.record({ ...key, html: '<p>Call me Ishmael.</p>' });
    assert.equal(first.kind, 'snapshot');
    assert.equal(first.words, 3);
    assert.equal(await log.record({ ...key, html: '<p>Call me Ishmael.</p>' }), null, 'the same words again are not a revision');

    const drafts = [];
    for (let i = 1; i <= SNAPSHOT_EVERY + 2; i++) {
      drafts.push(`<p>Call me Ishmael.</p>${'<p>Some years ago.</p>'.repeat(i)}`);
      await log.record({ ...key, html: drafts[drafts.length - 1] });
    }
    const entries = await log.list(key);
    assert.equal(entries.length, SNAPSHOT_EVERY + 3);
    assert.equal(entries[0].kind, 'diff', 'newest first');
    assert.deepEqual(entries.map((e) => e.kind).filter((k) => k === 'snapshot').length, 2, 'one snapshot at the start, one when the chain got long');

    for (const [i, html] of drafts.entries()) {
      assert.equal(await log.read({ userId: writer.id, id: entries[drafts.length - 1 - i].id }), html, `draft ${i + 1} rebuilds`);
    }
    assert.equal(await log.read({ userId: 'u-someone-else', id: entries[0].id }), null, 'another writer cannot read it');
    assert.equal(await log.verify(key), true);

    await db.query('UPDATE revisions SET created_at = created_at - interval \'1 day\' WHERE id = $1', [entries[3].id]);
    assert.equal(await log.verify(key), false, 'a rewritten timestamp breaks the chain');
  });

  test('each branch has its own history, and a new branch starts with where it came from', async () => {
    const key = { userId: writer.id, bookId: 'book-2', chapterId: 'ch-1' };
    await log.record({ ...key, html: '<p>On main.</p>' });
    await log.record({ ...key, branch: 'alt', html: '<p>On alt.</p>' });
    await log.record({ ...key, branch: 'alt', html: '<p>On alt, more.</p>' });
    assert.equal((await log.list(key)).length, 1);
    assert.equal((await log.list({ ...key, branch: 'alt' })).length, 2);
    assert.equal(await log.verify({ ...key, branch: 'alt' }), true);
  });

  test('chapter:write through the server records a revision, and the history channels answer', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-revserver-'));
    const app = createApp({ dev: false, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: '', mail: {} }, { db });
    await app.ready;
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    try {
      const signup = await fetch(base + '/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email: 'typing@example.com', password: 'longenough' }), redirect: 'manual' });
      const cookie = signup.headers.get('set-cookie').split(';')[0];
      const api = async (channel, ...args) => (await (await fetch(base + '/api/' + channel, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ args }) })).json()).result;

      const book = await api('book:create', { title: 'Draft' });
      await api('chapter:write', book.id, 'ch-a', '<p>First words.</p>');
      await api('chapter:write', book.id, 'ch-a', '<p>First words, then more.</p>');
      const history = await api('revision:list', book.id, 'ch-a');
      assert.equal(history.length, 2);
      assert.equal(await api('revision:read', history[1].id), '<p>First words.</p>', 'the earlier draft is still there');
      assert.equal(await api('revision:verify', book.id, 'ch-a'), true);
      assert.equal(await api('chapter:read', book.id, 'ch-a'), '<p>First words, then more.</p>', 'the file on disk is still the truth');

      await api('book:writeMeta', book.id, { ...(await api('book:readMeta', book.id)), chapterOrder: ['ch-a'] });
      const made = await api('branch:create', book.id, 'what if');
      assert.equal(made.active, 'what if');
      const onBranch = await api('revision:list', book.id, 'ch-a');
      assert.equal(onBranch.length, 1, 'the branch opens with one revision: the draft it came from');
      assert.equal(onBranch[0].branch, 'what if');
      await api('chapter:write', book.id, 'ch-a', '<p>Branch words.</p>');
      assert.equal((await api('revision:list', book.id, 'ch-a')).length, 2);
      await api('branch:switch', book.id, 'main');
      assert.equal((await api('revision:list', book.id, 'ch-a')).length, 2, 'main still has its own two');
      assert.equal(await api('chapter:read', book.id, 'ch-a'), '<p>First words, then more.</p>');
    } finally {
      await app.close();
    }
  });
});
