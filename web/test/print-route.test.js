'use strict';

// File → Export → PDF on the server: the page's HTML goes to the printer, the
// bytes come back as a download. The printer is a stub that keeps what it was
// asked; print/test covers the real one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createApp } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-print-route-'));
const asked = [];
const printer = {
  enabled: true,
  render: async (html, opts) => { asked.push({ html, opts }); return { pdf: Buffer.from('%PDF-1.7 stub'), pages: 12 }; }
};
const config = { dev: true, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: '', mail: {} };
const app = createApp(config, { printer });
const bare = createApp({ ...config, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'neo-print-bare-')) });
let base, bareBase, cookie, bareCookie;
const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lamps</title></head><body><p>Words.</p></body></html>';

const signUp = async (root) => {
  const res = await fetch(root + '/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ email: 'w@example.com', password: 'longenough' }), redirect: 'manual' });
  return res.headers.get('set-cookie').split(';')[0];
};
const post = (root, p, body, headers = {}) => fetch(root + p, { method: 'POST', headers: { 'Content-Type': 'text/html', 'Sec-Fetch-Site': 'same-origin', ...headers }, body, redirect: 'manual' });

before(async () => {
  await Promise.all([app.ready, bare.ready]);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; resolve(); }));
  await new Promise((resolve) => bare.server.listen(0, '127.0.0.1', () => { bareBase = `http://127.0.0.1:${bare.server.address().port}`; resolve(); }));
  cookie = await signUp(base);
  bareCookie = await signUp(bareBase);
});
after(() => { app.server.close(); bare.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('the PDF export route', () => {
  test('the page knows whether a printer is there', async () => {
    const withPrinter = await (await fetch(base + '/', { headers: { Cookie: cookie } })).text();
    assert.match(withPrinter, /"print":true/);
    const without = await (await fetch(bareBase + '/', { headers: { Cookie: bareCookie } })).text();
    assert.match(without, /"print":false/);
  });

  test('sends the export to the printer and hands the PDF back as a download, Letter for an English writer', async () => {
    const res = await post(base, '/api/export:pdf?name=The%20Lamps%20on%20the%20Hill', page, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="The Lamps on the Hill.pdf"');
    assert.equal(res.headers.get('x-pages'), '12');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.7 stub');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].html, page);
    assert.equal(asked[0].opts.size, 'Letter', 'the English interface prints on Letter until the export dialog says otherwise');
  });

  test('a size the page asks for is passed on; a bad name is made safe', async () => {
    const res = await post(base, '/api/export:pdf?size=A5&name=..%2F%22x%22', page, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="x.pdf"');
    assert.equal(asked[asked.length - 1].opts.size, 'A5');
  });

  test('refuses a fragment, a stranger and a cross-site post, and says so without a printer', async () => {
    assert.equal((await post(base, '/api/export:pdf', '<p>no</p>', { Cookie: cookie })).status, 400);
    assert.equal((await post(base, '/api/export:pdf', page)).status, 401);
    assert.equal((await post(base, '/api/export:pdf', page, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const none = await post(bareBase, '/api/export:pdf', page, { Cookie: bareCookie });
    assert.equal(none.status, 503);
    assert.match((await none.json()).error, /No PDF printer/);
    assert.equal(asked.length, 2, 'none of them reached the printer');
  });
});
