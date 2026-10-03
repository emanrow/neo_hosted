'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { hashPassword, verifyPassword, signSession, verifySession, LoginThrottle } = require('../lib/auth');
const { JsonUserStore } = require('../lib/user-store');
const { createSecretBox } = require('../lib/secrets');
const { loadConfig } = require('../lib/config');

describe('passwords', () => {
  test('hash and verify, with the parameters recorded in the hash', () => {
    const stored = hashPassword('correct horse battery');
    assert.match(stored, /^scrypt\$32768\$8\$1\$/);
    assert.equal(verifyPassword('correct horse battery', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
    assert.equal(verifyPassword('anything', 'not-a-hash'), false);
    assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
  });
});

describe('sessions', () => {
  test('a signed token names its user until it expires or is touched', () => {
    const token = signSession('u-abc', 'secret-one');
    assert.equal(verifySession(token, 'secret-one'), 'u-abc');
    assert.equal(verifySession(token, 'secret-two'), null, 'another secret');
    assert.equal(verifySession(token.replace('u-abc', 'u-xyz'), 'secret-one'), null, 'a changed user');
    assert.equal(verifySession(signSession('u-abc', 'secret-one', -1000), 'secret-one'), null, 'expired');
    assert.equal(verifySession('junk', 'secret-one'), null);
    assert.equal(verifySession(undefined, 'secret-one'), null);
  });
});

describe('login throttle', () => {
  test('refuses after the limit within the window and forgives on success', () => {
    const throttle = new LoginThrottle({ limit: 3, windowMs: 60000 });
    for (let i = 0; i < 3; i++) { assert.equal(throttle.allowed('ip'), true); throttle.failed('ip'); }
    assert.equal(throttle.allowed('ip'), false);
    assert.equal(throttle.allowed('other'), true);
    throttle.clear('ip');
    assert.equal(throttle.allowed('ip'), true);
  });
});

describe('the JSON user store', () => {
  test('creates, finds by normalized email, and refuses duplicates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-users-'));
    const store = new JsonUserStore(path.join(dir, 'users.json'));
    assert.equal(store.count(), 0);
    const user = store.create({ email: '  Writer@Example.com ', passwordHash: 'h' });
    assert.match(user.id, /^u-[0-9a-f]{16}$/);
    assert.equal(store.findByEmail('writer@example.com').id, user.id);
    assert.equal(store.findById(user.id).email, 'writer@example.com');
    assert.throws(() => store.create({ email: 'WRITER@example.com', passwordHash: 'h' }), /already has an account/);
    assert.throws(() => store.create({ email: '', passwordHash: 'h' }), /email address is needed/);
    store.setPasswordHash(user.id, 'h2');
    assert.equal(store.findById(user.id).passwordHash, 'h2');
    assert.equal(new JsonUserStore(path.join(dir, 'users.json')).count(), 1, 'it is on disk');
  });
});

describe('the secret box', () => {
  test('seals a key, opens it with the same master secret only, and forgets on empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-secrets-'));
    const file = path.join(dir, 'secrets.json');
    const box = createSecretBox('master-a');
    assert.equal(box.has(file, 'openai'), false);
    box.write(file, 'openai', 'sk-test-123');
    assert.equal(box.read(file, 'openai'), 'sk-test-123');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-test-123'), 'nothing in the clear on disk');
    assert.equal(createSecretBox('master-b').read(file, 'openai'), null, 'a rotated secret reads as absent');
    box.write(file, 'openai', '');
    assert.equal(box.has(file, 'openai'), false);
  });
});

describe('config', () => {
  test('insists on a secret in production and an invite code for invite mode', () => {
    assert.throws(() => loadConfig({}), /NEO_SESSION_SECRET/);
    assert.throws(() => loadConfig({ NEO_SESSION_SECRET: 'x'.repeat(40) }), /NEO_INVITE_CODE/);
    assert.throws(() => loadConfig({ NEO_SESSION_SECRET: 'x'.repeat(40), NEO_SIGNUP: 'maybe' }), /NEO_SIGNUP/);
    const cfg = loadConfig({ NEO_SESSION_SECRET: 'x'.repeat(40), NEO_SIGNUP: 'invite', NEO_INVITE_CODE: 'come-in', PORT: '9000', RAILWAY_ENVIRONMENT: 'production' });
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.trustProxy, true);
    const dev = loadConfig({ NEO_DEV: '1' });
    assert.equal(dev.sessionSecret.length, 64);
    assert.equal(dev.signup, 'invite');
  });
});
