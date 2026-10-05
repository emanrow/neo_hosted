'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { hashPassword, verifyPassword, signSession, verifySession, signLink, verifyLink, linkStamp, LoginThrottle } = require('../lib/auth');
const { JsonUserStore, isEmailVerified } = require('../lib/user-store');
const { createMailer, confirmationMessage, resetMessage } = require('../lib/mail');
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

describe('links in email', () => {
  test('a link is good for one purpose, until it expires, and carries the stamp it was issued with', () => {
    const token = signLink({ purpose: 'verify', userId: 'u-abc' }, 'secret-one');
    assert.deepEqual(verifyLink(token, 'verify', 'secret-one'), { userId: 'u-abc', stamp: linkStamp('') });
    assert.equal(verifyLink(token, 'reset', 'secret-one'), null, 'a confirmation link is not a reset link');
    assert.equal(verifyLink(token, 'verify', 'secret-two'), null, 'another secret');
    assert.equal(verifySession(token, 'secret-one'), null, 'and never a session');
    assert.equal(verifyLink(token.replace('u-abc', 'u-xyz'), 'verify', 'secret-one'), null, 'a changed user');
    assert.equal(verifyLink(signLink({ purpose: 'reset', userId: 'u-abc' }, 'secret-one', -1000), 'reset', 'secret-one'), null, 'expired');
    assert.equal(verifyLink('junk', 'verify', 'secret-one'), null);
    const reset = signLink({ purpose: 'reset', userId: 'u-abc', stamp: linkStamp('scrypt$old-hash') }, 'secret-one');
    assert.equal(verifyLink(reset, 'reset', 'secret-one').stamp, linkStamp('scrypt$old-hash'));
    assert.notEqual(linkStamp('scrypt$old-hash'), linkStamp('scrypt$new-hash'), 'the stamp moves with the password');
    assert.ok(!reset.includes('old-hash'), 'the hash itself is not in the link');
    assert.throws(() => signLink({ purpose: 'session', userId: 'u-abc' }, 'secret-one'), /Unknown link purpose/);
  });
});

describe('the mailer', () => {
  test('is off without a key, and otherwise posts to Resend and reports its answer', async () => {
    const off = createMailer({});
    assert.equal(off.enabled, false);
    await assert.rejects(off.send({ to: 'w@example.com', subject: 's', text: 't' }), /not configured/);

    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ id: 'msg-1' }) }; };
    const on = createMailer({ resendApiKey: 're_test_key', from: 'NEO <neo@example.com>', fetchImpl });
    assert.equal(on.enabled, true);
    assert.equal(await on.send({ to: 'w@example.com', subject: 'Hello', text: 'Body' }), 'msg-1');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
    assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'NEO <neo@example.com>', to: ['w@example.com'], subject: 'Hello', text: 'Body' });

    const refusing = createMailer({ resendApiKey: 'k', from: 'f', fetchImpl: async () => ({ ok: false, status: 422, text: async () => 'bad sender' }) });
    await assert.rejects(refusing.send({ to: 'w@example.com', subject: 's', text: 't' }), /Resend answered 422: bad sender/);
  });

  test('the messages carry the link and say how long it lasts', () => {
    const confirm = confirmationMessage({ link: 'https://neo.example.com/auth/verify?token=abc' });
    assert.match(confirm.subject, /Confirm/);
    assert.ok(confirm.text.includes('https://neo.example.com/auth/verify?token=abc'));
    assert.match(confirm.text, /one day/);
    const reset = resetMessage({ link: 'https://neo.example.com/login?reset=xyz' });
    assert.ok(reset.text.includes('/login?reset=xyz'));
    assert.match(reset.text, /one hour/);
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
    assert.throws(() => store.setPasswordHash('u-nobody', 'h'), /No such user/);
  });

  test('an account waits for its confirmation link only when asked to; older accounts count as confirmed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-users-'));
    const store = new JsonUserStore(path.join(dir, 'users.json'));
    const confirmed = store.create({ email: 'a@example.com', passwordHash: 'h' });
    assert.equal(isEmailVerified(confirmed), true);
    const waiting = store.create({ email: 'b@example.com', passwordHash: 'h', emailVerified: false });
    assert.equal(waiting.emailVerifiedAt, null);
    assert.equal(isEmailVerified(waiting), false);
    store.markEmailVerified(waiting.id);
    assert.equal(isEmailVerified(store.findById(waiting.id)), true);
    assert.equal(isEmailVerified({ id: 'u-old', email: 'c@example.com', passwordHash: 'h' }), true, 'made before email existed');
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
    assert.equal(dev.mail, null);
    assert.equal(dev.publicUrl, '');
  });

  test('email needs a sender and a public address to put in the links', () => {
    const base = { NEO_SESSION_SECRET: 'x'.repeat(40), NEO_SIGNUP: 'open', RESEND_API_KEY: 're_k' };
    assert.throws(() => loadConfig(base), /NEO_MAIL_FROM/);
    assert.throws(() => loadConfig({ ...base, NEO_MAIL_FROM: 'NEO <neo@example.com>' }), /NEO_PUBLIC_URL/);
    assert.throws(() => loadConfig({ ...base, NEO_MAIL_FROM: 'NEO <neo@example.com>', NEO_PUBLIC_URL: 'neo.example.com' }), /full address/);
    assert.throws(() => loadConfig({ ...base, NEO_MAIL_FROM: 'NEO <neo@example.com>', NEO_PUBLIC_URL: 'ftp://neo.example.com' }), /http/);
    const cfg = loadConfig({ ...base, NEO_MAIL_FROM: 'NEO <neo@example.com>', NEO_PUBLIC_URL: 'https://neo.example.com/' });
    assert.deepEqual(cfg.mail, { resendApiKey: 're_k', from: 'NEO <neo@example.com>' });
    assert.equal(cfg.publicUrl, 'https://neo.example.com', 'no trailing slash, so links join cleanly');
    assert.equal(loadConfig({ ...base, NEO_DEV: '1', NEO_MAIL_FROM: 'f' }).publicUrl, '', 'a laptop may fall back to the request host');
  });
});
