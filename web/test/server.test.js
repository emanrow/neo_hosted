'use strict';

// The server end to end: a fresh data folder, a writer signing up, and the
// window.neo channels answering over HTTP.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const { createApp } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-server-'));
const bucketPuts = [];                                 // what the stand-in bucket was sent
const objectStore = { enabled: true, bucket: 'words', put: async (key, bytes, type) => { bucketPuts.push({ key, size: bytes.length, type }); } };
const app = createApp({ dev: true, dataDir, sessionSecret: 's'.repeat(40), signup: 'invite', inviteCode: 'come-in', trustProxy: false, port: 0 }, { objectStore });
let base = '';
let cookie = '';

const call = (method, p, { body, headers = {}, raw } = {}) => fetch(base + p, {
  method,
  headers: { 'Sec-Fetch-Site': 'same-origin', ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  body: raw || (body === undefined ? undefined : JSON.stringify(body)),
  redirect: 'manual'
});
const api = async (channel, ...args) => {
  const res = await call('POST', '/api/' + channel, { body: { args } });
  const data = await res.json();
  return { status: res.status, ...data };
};

before(() => new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; resolve(); })));
after(() => app.close());

describe('the hosted server', () => {
  test('answers the health check and sends the sign-in page to strangers', async () => {
    assert.equal(await (await call('GET', '/healthz')).text(), 'ok');
    const home = await call('GET', '/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/login');
    const login = await call('GET', '/login');
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await login.text(), /<html lang="en">[\s\S]*id="submit">Sign in</, 'English without a preference');
    const german = await call('GET', '/login', { headers: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' } });
    assert.match(await german.text(), /<html lang="de">[\s\S]*id="submit">Anmelden</, 'the browser\'s language');
    assert.equal(german.headers.get('vary'), 'Accept-Language');
    const wrong = await call('POST', '/auth/signup', { body: { email: 'not-an-address', password: 'longenough' }, headers: { 'Accept-Language': 'fr' } });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'Cela ne ressemble pas à une adresse e-mail', 'errors speak it too');
    assert.equal((await api('library:read')).status, 401);
    assert.equal((await call('GET', '/library/book-x/cover-1.png')).status, 401);
  });

  test('serves the desktop app\'s own files and refuses to leave the folder', async () => {
    assert.equal((await call('GET', '/app.js')).status, 200);
    assert.match((await call('GET', '/styles.css')).headers.get('content-type'), /text\/css/);
    assert.equal((await call('GET', '/locales/fr.json')).status, 200);
    assert.equal((await call('GET', '/jszip.min.js')).status, 200);
    assert.equal((await call('GET', '/web/web-bridge.js')).status, 200);
    assert.equal((await call('GET', '/favicon.ico')).headers.get('content-type'), 'image/png');
    assert.equal((await call('GET', '/main.js')).status, 404, 'the main process is not for the browser');
    assert.equal((await call('GET', '/web/../package.json')).status, 404);
    assert.equal((await call('GET', '/locales/..%2F..%2Fpackage.json')).status, 404);
  });

  test('the first writer signs up without an invitation, the next one needs it', async () => {
    const bad = await call('POST', '/auth/signup', { body: { email: 'not-an-email', password: 'longenough' } });
    assert.equal(bad.status, 400);
    const short = await call('POST', '/auth/signup', { body: { email: 'w@example.com', password: 'short' } });
    assert.equal(short.status, 400);
    const first = await call('POST', '/auth/signup', { body: { email: 'w@example.com', password: 'longenough' } });
    assert.equal(first.status, 200);
    cookie = first.headers.get('set-cookie').split(';')[0];
    assert.match(first.headers.get('set-cookie'), /HttpOnly/);
    assert.match(first.headers.get('set-cookie'), /SameSite=Lax/);
    const saved = cookie;
    cookie = '';
    const second = await call('POST', '/auth/signup', { body: { email: 'two@example.com', password: 'longenough' } });
    assert.equal(second.status, 403);
    const invited = await call('POST', '/auth/signup', { body: { email: 'two@example.com', password: 'longenough', invite: 'come-in' } });
    assert.equal(invited.status, 200);
    const dup = await call('POST', '/auth/signup', { body: { email: 'W@example.com', password: 'longenough', invite: 'come-in' } });
    assert.equal(dup.status, 409);
    cookie = saved;
  });

  test('cross-site posts are refused even with the cookie', async () => {
    const res = await call('POST', '/api/library:read', { body: { args: [] }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  test('the writing room is the desktop page with this writer\'s facts in it', async () => {
    const res = await call('GET', '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="neo-hosted-config"'));
    assert.ok(html.includes('"email":"w@example.com"'));
    assert.ok(html.includes('/web/web-menu.js'));
    assert.ok(html.includes('/web/web-history.js'));
    assert.equal((await call('GET', '/web/web-history.js')).status, 200);
    assert.ok(html.includes('/web/web-branches.js'));
    assert.equal((await call('GET', '/web/web-branches.js')).status, 200);
    assert.ok(html.includes('/web/web-mobile.js'));
    assert.equal((await call('GET', '/web/web-mobile.js')).status, 200);
    assert.ok(html.includes('name="viewport"'));
    assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
    const login = await call('GET', '/login');
    assert.equal(login.status, 302, 'a signed-in writer is sent to the room');
  });

  test('branches: create, switch, delete, with the book following the active one', async () => {
    const book = (await api('book:create', { title: 'Forked' })).result;
    await api('book:writeMeta', book.id, { ...book, chapterOrder: ['ch-1'] });
    await api('chapter:write', book.id, 'ch-1', '<p>Main.</p>');
    const made = (await api('branch:create', book.id, 'alt'));
    assert.equal(made.status, 200);
    assert.equal(made.result.active, 'alt');
    assert.deepEqual(made.result.branches.map((b) => b.name), ['main', 'alt']);
    await api('chapter:write', book.id, 'ch-1', '<p>Alt.</p>');
    assert.equal((await api('chapter:read', book.id, 'ch-1')).result, '<p>Alt.</p>');
    assert.equal((await api('branch:switch', book.id, 'main')).result.active, 'main');
    assert.equal((await api('chapter:read', book.id, 'ch-1')).result, '<p>Main.</p>');
    assert.equal((await api('revision:list', book.id, 'ch-1')).result.length, 0, 'no database, no history, no error');
    const refused = await api('branch:create', book.id, 'main');
    assert.equal(refused.status, 500);
    assert.match(refused.error, /branch name/);
    assert.deepEqual((await api('branch:delete', book.id, 'alt')).result.branches.map((b) => b.name), ['main']);
    assert.equal((await api('book:delete', book.id)).result, true); // the shelf test below counts books
  });

  test('the window.neo channels answer with the desktop\'s shapes', async () => {
    const lib = await api('library:read');
    assert.equal(lib.ok, true);
    assert.equal(lib.result.shelves[0].name, 'Works in Progress');

    const created = await api('book:create', { title: 'Hosted Book', author: 'W' });
    const book = created.result;
    assert.match(book.id, /^book-hosted-book-/);
    assert.equal((await api('chapter:write', book.id, 'ch-1', '<p>First words.</p>')).result, true);
    assert.equal((await api('chapter:read', book.id, 'ch-1')).result, '<p>First words.</p>');
    assert.match((await api('chapter:stamps', book.id)).result['ch-1'], /:19$/, 'mtime:size, and the size is the HTML\'s 19 bytes');
    assert.equal((await api('aux:write', book.id, 'notes', '<p>n</p>')).result, true);
    assert.equal((await api('aux:read', book.id, 'notes')).result, '<p>n</p>');
    assert.deepEqual((await api('json:read', book.id, 'darlings', 'fb')).result, []);
    assert.equal((await api('json:write', book.id, 'stickies', [{ a: 1 }])).result, true);
    assert.deepEqual((await api('json:read', book.id, 'stickies', null)).result, [{ a: 1 }]);
    assert.equal(typeof (await api('book:writeMeta', book.id, { ...book, title: 'Renamed' })).result, 'string');
    assert.equal((await api('book:readMeta', book.id)).result.title, 'Renamed');
    assert.deepEqual((await api('library:listBooks')).result.map((b) => b.title), ['Renamed']);
    assert.match((await api('app:version')).result, /\(NEO \d+\.\d+\.\d+\)$/);

    const bad = await api('chapter:read', '../etc', 'passwd');
    assert.equal(bad.status, 500);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Invalid library name/);
    assert.equal((await api('no:such')).status, 404);

    // the files are where desktop NEO would keep them
    const userDirs = fs.readdirSync(path.join(dataDir, 'users'));
    const libraryDir = path.join(dataDir, 'users', userDirs.find((d) => fs.existsSync(path.join(dataDir, 'users', d, 'NEO Library', book.id))), 'NEO Library');
    assert.equal(fs.readFileSync(path.join(libraryDir, book.id, 'chapters', 'ch-1.html'), 'utf8'), '<p>First words.</p>');
    assert.ok(fs.readFileSync(path.join(libraryDir, '_catalog.txt'), 'utf8').includes('Renamed'));
  });

  test('covers upload as raw bytes and come back as images, per writer', async () => {
    const book = (await api('book:create', { title: 'Covered' })).result;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const up = await call('POST', `/api/cover:upload?bookId=${book.id}&ext=png`, { raw: png, headers: { 'Content-Type': 'application/octet-stream' } });
    const fname = (await up.json()).result;
    assert.match(fname, /^cover-\d+\.png$/);
    const img = await call('GET', `/library/${book.id}/${fname}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
    assert.equal((await call('GET', `/library/${book.id}/book.json`)).status, 404, 'only images are served from a book folder');
    const gif = await call('POST', `/api/cover:upload?bookId=${book.id}&ext=gif`, { raw: png, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(gif.status, 400);
    assert.equal((await api('cover:remove', book.id)).result, true);
    assert.equal((await call('GET', `/library/${book.id}/${fname}`)).status, 404);
  });

  test('the whole library downloads as the desktop folder, zipped', async () => {
    const res = await call('GET', '/library.zip');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="NEO Library.zip"/);
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    assert.ok(zip.file('library.json'), 'library.json is in it');
    assert.ok(Object.keys(zip.files).some((n) => /^book-hosted-book-.*\/chapters\/ch-1\.html$/.test(n)), 'and the chapters');
    const signedIn = cookie;
    cookie = '';
    assert.equal((await call('GET', '/library.zip')).status, 401);
    cookie = signedIn;
  });

  test('manuscripts upload as raw bytes and come back split into chapters', async () => {
    const upload = async (name, bytes) => {
      const res = await call('POST', '/api/import:upload?name=' + encodeURIComponent(name), { raw: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      return { status: res.status, ...(await res.json()) };
    };
    const prose = (chapter) => chapter.paras.filter((p) => p.text).map((p) => p.text);

    const txt = await upload('Short Story.txt', Buffer.from('Chapter 1\n\nIt began.\n\nChapter 2\n\nIt ended.', 'utf8'));
    assert.equal(txt.status, 200);
    assert.equal(txt.ok, true);
    assert.equal(txt.result.name, 'Short Story');
    assert.equal(txt.result.chapters.length, 2);
    assert.deepEqual(prose(txt.result.chapters[0]), ['It began.']);
    assert.deepEqual(prose(txt.result.chapters[1]), ['It ended.']);

    const md = await upload('draft.md', Buffer.from('# Chapter 1\n\nShe knocked.\n\n# Chapter 2\n\nNobody came.', 'utf8'));
    assert.equal(md.result.chapters.length, 2);
    assert.deepEqual(md.result.chapters.map((c) => c.title), ['', ''], 'NEO numbers chapters itself');
    assert.deepEqual(prose(md.result.chapters[1]), ['Nobody came.']);

    // a .docx built here: two paragraphs, one italic run
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
      + '<w:p><w:r><w:t>She spoke </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>softly</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>He did not hear.</w:t></w:r></w:p>'
      + '</w:body></w:document>');
    const docx = await upload('Quiet.docx', await zip.generateAsync({ type: 'nodebuffer' }));
    assert.equal(docx.status, 200);
    assert.equal(docx.result.name, 'Quiet');
    assert.deepEqual(prose(docx.result.chapters[0]), ['She spoke *softly*.', 'He did not hear.']);

    // what the server refuses, and how: the page turns these into { name, error }
    const notZip = await upload('broken.docx', Buffer.from('this is not a zip'));
    assert.equal(notZip.status, 500);
    assert.equal(notZip.ok, false);
    assert.equal(typeof notZip.error, 'string');
    const logs = fs.readdirSync(path.join(dataDir, 'users')).map((u) => path.join(dataDir, 'users', u, 'NEO Library', 'neo-errors.log')).filter((f) => fs.existsSync(f));
    assert.ok(logs.some((f) => fs.readFileSync(f, 'utf8').includes('[import]')), 'the failure is in the writer\'s own error log');
    assert.equal((await upload('cover.png', Buffer.from([1, 2, 3]))).status, 400);
    assert.equal((await upload('', Buffer.from('x'))).status, 400);
    const signedIn = cookie;
    cookie = '';
    assert.equal((await upload('a.txt', Buffer.from('x'))).status, 401, 'strangers may not use the parser');
    cookie = signedIn;
  });

  test('a book deleted from the page lands in the writer\'s Trash', async () => {
    const book = (await api('book:create', { title: 'Trashed' })).result;
    assert.equal((await api('book:delete', book.id)).result, true);
    assert.equal((await api('book:readMeta', book.id)).result, null);
  });

  test('secrets, spellcheck and the error log answer', async () => {
    assert.equal((await api('secret:has', 'openai')).result, false);
    assert.equal((await api('secret:set', 'openai', 'sk-abc')).result, true);
    assert.equal((await api('secret:has', 'openai')).result, true);
    assert.equal((await api('secret:set', 'bad name!', 'x')).status, 500);
    const checked = await api('spell:check', ['writing', 'wrtiing']);
    assert.deepEqual(checked.result, { writing: true, wrtiing: false });
    assert.equal((await api('spell:setLanguage', 'xx')).result, false);
    assert.equal((await api('spell:setLanguage', 'en-GB')).result, true);
    assert.equal((await api('log:error', 'the page hiccuped')).result, true);
  });

  test('the interface language is the writer\'s choice, saved for next time', async () => {
    assert.equal((await api('settings:language', 'fr-CA')).result, 'fr-CA');
    const html = await (await call('GET', '/')).text();
    assert.ok(html.includes('"locale":"fr-CA"'));
    assert.equal((await api('settings:language', 'en')).result, 'en');
  });

  test('the owner sees every account on /admin and can remove one, whose library is zipped and kept', async () => {
    const owner = cookie;
    const page = await call('GET', '/admin');
    assert.equal(page.status, 200, 'the oldest account is the owner');
    const html = await page.text();
    assert.ok(html.includes('w@example.com') && html.includes('two@example.com'), 'both accounts listed');
    assert.match(html, /<td class="num">\d+<\/td>/, 'the counts are there');
    const other = await call('POST', '/auth/login', { body: { email: 'two@example.com', password: 'longenough' } });
    assert.equal(other.status, 200);
    cookie = other.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('GET', '/admin')).status, 404, 'anyone else: nothing to see');
    assert.equal((await call('POST', '/admin/remove', { raw: 'userId=x&confirm=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 404);
    const two = await api('library:read');
    assert.equal(two.status, 200);
    cookie = owner;
    const ids = Object.fromEntries([...html.matchAll(/name="userId" value="([^"]+)"[\s\S]*?aria-label="type ([^ ]+) to confirm"/g)].map((m) => [m[2], m[1]]));
    assert.ok(ids['two@example.com'], 'the form names the account');
    const form = (body) => call('POST', '/admin/remove', { raw: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal((await form(`userId=${ids['two@example.com']}&confirm=someone@else.com`)).status, 400, 'the address must be typed back');
    const me = (await call('GET', '/')).status === 200 && [...html.matchAll(/name="userId" value="([^"]+)"/g)].map((m) => m[1]).find((id) => id !== ids['two@example.com']);
    assert.ok(!me, 'the owner has no remove form of their own');
    const removed = await form(`userId=${ids['two@example.com']}&confirm=TWO%40example.com`);
    assert.equal(removed.status, 302);
    assert.match(removed.headers.get('location'), /^\/admin\?notice=Removed/);
    const after = await (await call('GET', '/admin')).text();
    assert.ok(after.includes('w@example.com') && !after.includes('two@example.com'), 'gone from the list');
    assert.equal(await app.users.findByEmail('two@example.com'), null, 'the account is gone (a sign-in attempt here would count against the throttle test below)');
    const kept = fs.readdirSync(path.join(dataDir, 'removed'));
    assert.ok(kept.some((f) => f.endsWith('.zip')), 'the library was zipped first');
    assert.ok(kept.some((f) => !f.endsWith('.zip') && fs.existsSync(path.join(dataDir, 'removed', f, 'NEO Library'))), 'the folder moved under removed/');
    assert.ok(!fs.existsSync(path.join(dataDir, 'users', ids['two@example.com'])), 'and left users/');
  });

  test('wrong passwords are counted and the throttle closes the door', async () => {
    cookie = '';
    for (let i = 0; i < 10; i++) {
      const res = await call('POST', '/auth/login', { body: { email: 'two@example.com', password: 'nope-nope' } });
      assert.equal(res.status, 401);
    }
    const blocked = await call('POST', '/auth/login', { body: { email: 'two@example.com', password: 'longenough' } });
    assert.equal(blocked.status, 429);
    const other = await call('POST', '/auth/login', { body: { email: 'w@example.com', password: 'longenough' }, headers: { 'X-Forwarded-For': '10.0.0.9' } });
    assert.equal(other.status, 429, 'the IP is throttled too, and a forwarded address is not believed without a trusted proxy');
  });

  test('with email off, a forgotten password has nowhere to go', async () => {
    assert.equal(app.mailer.enabled, false);
    const res = await call('POST', '/auth/forgot', { body: { email: 'w@example.com' } });
    assert.equal(res.status, 503);
    assert.equal((await call('GET', '/auth/verify?token=junk')).headers.get('location'), '/login?notice=link-expired');
  });

  test('signing out clears the cookie', async () => {
    const first = await call('POST', '/auth/signup', { body: { email: 'three@example.com', password: 'longenough', invite: 'come-in' } });
    cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('library:read')).ok, true);
    const out = await call('POST', '/auth/logout');
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  });

  test('a published page is served to anyone with the link, and only its owner can take it down', async () => {
    const html = '<!doctype html><html><head><title>Wool</title></head><body><p>Once.</p></body></html>';
    const bookId = 'book-shared';                    // a page is a snapshot; the book need not still be on the shelf
    const share = (await api('share:publish', bookId, null, 'Wool', html)).result;
    assert.match(share.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(share.chapterId, '');
    const listed = (await api('share:list', bookId)).result;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].token, share.token);
    const saved = cookie;
    cookie = '';
    const page = await call('GET', '/s/' + share.token);
    assert.equal(page.status, 200, 'no sign-in needed');
    assert.equal(await page.text(), html);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.equal((await call('GET', '/s/' + share.token.slice(1) + 'x')).status, 404, 'a token off by one is nothing');
    assert.equal((await call('GET', '/s/%2e%2e%2flogin')).status, 404, 'a token is letters and digits only');
    cookie = saved;
    const refused = await api('share:publish', bookId, null, 'Wool', '<p>not a page</p>');
    assert.match(refused.error, /whole web page/);
    const again = (await api('share:publish', bookId, 'ch-1', 'Holston', html.replace('Once.', 'Twice.'))).result;
    assert.notEqual(again.token, share.token, 'a chapter has its own link');
    assert.equal((await api('share:list', bookId)).result.length, 2);
    assert.equal((await api('share:remove', share.token)).result, true);
    assert.equal((await call('GET', '/s/' + share.token)).status, 404, 'taken down');
    assert.equal((await api('share:remove', share.token)).result, false);
  });

  test('the backup sweep zips every writer\'s library and sends each zip to the bucket', async () => {
    const put = bucketPuts;
    await app.backupEveryone();
    const users = fs.readdirSync(path.join(dataDir, 'users'));
    const withLibrary = users.filter((u) => fs.existsSync(path.join(dataDir, 'users', u, 'NEO Library')));
    assert.ok(withLibrary.length >= 1);
    for (const u of withLibrary) {
      const files = fs.readdirSync(path.join(dataDir, 'users', u, 'NEO Library', 'Backups')).sort();
      assert.equal(files.filter((f) => f.endsWith('.zip')).length, 1);
      assert.equal(files.filter((f) => f.endsWith('.zip.offsite')).length, 1, 'marked as copied');
      assert.ok(put.some((p) => p.key.startsWith(`${u}/neo-backup-`) && p.key.endsWith('.zip') && p.type === 'application/zip' && p.size > 0), `${u} was sent`);
    }
    assert.equal(put.length, withLibrary.length);
  });
});
