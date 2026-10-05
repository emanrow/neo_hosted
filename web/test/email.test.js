'use strict';

// The server with email on: a new writer waits for the confirmation link,
// signing in sends it again, a forgotten password comes back by link, and a
// used reset link is dead. The mailer is a stub that keeps what would have
// been sent, so nothing leaves the test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const { createApp } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-email-'));
const outbox = [];
const mailer = { enabled: true, async send(message) { outbox.push(message); return 'msg-' + outbox.length; } };
const app = createApp({ dev: false, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: 'https://neo.example.com', mail: { resendApiKey: 'unused', from: 'NEO <neo@example.com>' }, adminEmails: ['owner@example.com'], guestsOfHonor: ['guest@example.com'] }, { mailer });
let base = '';

const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual'
});
const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
/** The path of the one link in the latest email, relative to the public URL. */
const lastLink = () => {
  const text = outbox[outbox.length - 1].text;
  const match = text.match(/https:\/\/neo\.example\.com(\/\S+)/);
  assert.ok(match, 'the email carries a link home');
  return match[1];
};

before(() => new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; resolve(); })));
after(() => app.close());

describe('with email on', () => {
  test('a new writer is asked to confirm, and the link signs them in', async () => {
    const res = await post('/auth/signup', { email: 'new@example.com', password: 'longenough' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, confirm: true });
    assert.equal(res.headers.get('set-cookie'), null, 'not signed in yet');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'new@example.com');
    assert.match(outbox[0].subject, /Confirm/);
    const link = lastLink();
    assert.match(link, /^\/auth\/verify\?token=verify\./);

    const denied = await post('/auth/login', { email: 'new@example.com', password: 'longenough' });
    assert.equal(denied.status, 403, 'the right password alone does not open the door');
    assert.match((await denied.json()).error, /Confirm your email/);
    assert.equal(outbox.length, 2, 'but the link was sent again');

    const again = await post('/auth/signup', { email: 'new@example.com', password: 'longenough' });
    assert.deepEqual(await again.json(), { ok: true, confirm: true }, 'signing up again while waiting is not a conflict');
    assert.equal(outbox.length, 3);
    const wrong = await post('/auth/signup', { email: 'new@example.com', password: 'differentone' });
    assert.equal(wrong.status, 409, 'with another password it is somebody else, and the address is taken');

    const opened = await get(link);
    assert.equal(opened.status, 302);
    assert.equal(opened.headers.get('location'), '/');
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^neo_session=/);
    const room = await get('/', { Cookie: cookie });
    assert.equal(room.status, 200, 'the writing room opens');
    const stored = await app.users.findByEmail('new@example.com');
    assert.equal(typeof stored.emailVerifiedAt, 'string');

    const signedIn = await post('/auth/login', { email: 'new@example.com', password: 'longenough' });
    assert.equal(signedIn.status, 200, 'and from now on the password is enough');
  });

  test('a bad or stale confirmation link lands on the sign-in page with a notice', async () => {
    const res = await get('/auth/verify?token=verify.u-nobody.1.x.y');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login?notice=link-expired');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('a forgotten password comes back by link, which works exactly once', async () => {
    const sent = outbox.length;
    const unknown = await post('/auth/forgot', { email: 'nobody@example.com' });
    assert.equal(unknown.status, 200, 'the form never says who has an account');
    assert.equal(outbox.length, sent, 'and nothing is sent to a stranger');

    const asked = await post('/auth/forgot', { email: 'NEW@example.com' });
    assert.equal(asked.status, 200);
    assert.equal(outbox.length, sent + 1);
    const link = lastLink();
    assert.match(link, /^\/login\?reset=reset\./);
    const token = decodeURIComponent(link.split('reset=')[1]);

    const page = await get(link);
    assert.equal(page.status, 200, 'the sign-in page opens in reset mode');
    const short = await post('/auth/reset', { token, password: 'short' });
    assert.equal(short.status, 400);
    const done = await post('/auth/reset', { token, password: 'anotherlongone' });
    assert.equal(done.status, 200);
    assert.match(done.headers.get('set-cookie'), /^neo_session=/, 'signed in with the new password');

    assert.equal((await post('/auth/login', { email: 'new@example.com', password: 'longenough' })).status, 401, 'the old password is gone');
    assert.equal((await post('/auth/login', { email: 'new@example.com', password: 'anotherlongone' })).status, 200);
    const replay = await post('/auth/reset', { token, password: 'yetanotherone' });
    assert.equal(replay.status, 400, 'the same link a second time is refused');
    assert.match((await replay.json()).error, /expired or was already used/);
    assert.equal((await post('/auth/reset', { token: 'reset.u-x.9999999999999.s.sig', password: 'yetanotherone' })).status, 400);
  });

  test('a guest of honor is welcomed once, and feedback reaches the owner', async () => {
    await post('/auth/signup', { email: 'guest@example.com', password: 'longenough' });
    const opened = await get(lastLink());
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    const api = async (channel, ...args) => {
      const res = await post('/api/' + channel, { args }, { Cookie: cookie });
      return { status: res.status, ...(await res.json()) };
    };
    const pageConfig = async () => JSON.parse((await (await get('/', { Cookie: cookie })).text()).match(/id="neo-hosted-config"[^>]*>([^<]*)</)[1]);

    assert.equal((await pageConfig()).welcome, 'honored', 'the page is told to open the welcome');
    assert.equal((await pageConfig()).feedback, true, 'and Send Feedback… is on the Help menu');
    assert.deepEqual(await api('welcome:seen'), { status: 200, ok: true, result: true });
    assert.equal((await pageConfig()).welcome, '', 'once');

    const sent = outbox.length;
    assert.deepEqual(await api('feedback:send', '  The margins are perfect.  '), { status: 200, ok: true, result: true });
    assert.equal(outbox.length, sent + 1);
    const mail = outbox[outbox.length - 1];
    assert.equal(mail.to, 'owner@example.com');
    assert.match(mail.subject, /guest of honor.*guest@example\.com/);
    assert.match(mail.text, /as a guest of honor:\n\nThe margins are perfect\.\n/, 'the note, trimmed, with who wrote it');

    assert.equal((await api('feedback:send', '   ')).status, 400, 'an empty note is not sent');
    assert.equal((await api('feedback:send', 'x'.repeat(5001))).status, 400, 'nor a novel');
    assert.equal(outbox.length, sent + 1);
  });

  test('the emails speak the language of the browser that asked', async () => {
    const res = await post('/auth/signup', { email: 'neu@example.com', password: 'longenough' }, { 'Accept-Language': 'de-DE,de;q=0.9' });
    assert.equal(res.status, 200);
    const welcome = outbox[outbox.length - 1];
    assert.equal(welcome.subject, 'Bestätige deine E-Mail für NEO');
    assert.match(welcome.text, /^Willkommen bei NEO\.\n\nÖffne diesen Link/);
    assert.match(welcome.text, /https:\/\/neo\.example\.com\/auth\/verify\?token=/, 'the link is the same');
    await post('/auth/forgot', { email: 'neu@example.com' }, { 'Accept-Language': 'fr' });
    assert.equal(outbox[outbox.length - 1].subject, 'Réinitialisez votre mot de passe NEO');
    await post('/auth/forgot', { email: 'neu@example.com' }, { 'Accept-Language': 'xx' });
    assert.equal(outbox[outbox.length - 1].subject, 'Reset your NEO password', 'English when NEO does not speak the language');
  });

  test('email is rationed per address', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post('/auth/forgot', { email: 'rationed@example.com' })).status, 200);
    const res = await post('/auth/forgot', { email: 'rationed@example.com' });
    assert.equal(res.status, 429);
  });
});
