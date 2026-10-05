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
    await db.query('DROP TABLE IF EXISTS users, schema_migrations');
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
    await db.query('DELETE FROM users');
    assert.equal(await store.importFrom(json), 2);
    const imported = await store.findById(old.id);
    assert.equal(imported.email, 'old@example.com');
    assert.equal(imported.passwordHash, 'hash-old');
    assert.ok(imported.emailVerifiedAt, 'an account from before email counts as confirmed');
    assert.equal((await store.findByEmail('waiting@example.com')).emailVerifiedAt, null, 'one still waiting keeps waiting');
  });

  test('the server signs writers up and in through Postgres, and imports users.json on boot', async () => {
    await db.query('DELETE FROM users');
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
