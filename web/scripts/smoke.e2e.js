'use strict';

// The hosted edition, end to end in a real browser. Boots web/server.js with
// a throwaway data folder, signs up in headless Chromium, walks the first-run
// questions, opens a menu, changes the page theme through it, creates a book
// and a chapter, types a sentence, and checks that the chapter HTML landed on
// disk, with no console errors along the way.
//
//   npm i -D playwright            (or CHROMIUM_PATH=/path/to/chrome)
//   node web/scripts/smoke.e2e.js
//
// Not part of npm test: it needs a browser. Run it after touching the bridge,
// the menu bar, or the page transform. See docs/testing.md.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT) || 18080;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-smoke-'));
const shots = process.env.SMOKE_SHOTS || dataDir;

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('Playwright is not installed: npm i -D playwright');
  process.exit(2);
}

const server = spawn('node', ['web/server.js'], {
  cwd: ROOT,
  env: { ...process.env, NEO_DEV: '1', NEO_SIGNUP: 'open', NEO_DATA_DIR: dataDir, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, what) => { if (!ok) throw new Error('FAILED: ' + what); console.log('ok   ' + what); };

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch { /* not up yet */ }
    await wait(100);
  }
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  check(page.url().endsWith('/login'), 'a stranger lands on the sign-in page');
  await page.click('#switch');
  await page.fill('#email', 'smoke@example.com');
  await page.fill('#password', 'longenough-pass');
  await page.click('#submit');
  await page.waitForURL(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('#firstrun:not([hidden])', { timeout: 10000 });
  check(true, 'the first account is created and the first-run questions appear');

  await page.fill('#fr-name', 'Smoke Tester');
  await page.click('.fr-choice[data-style="pantser"]');
  await page.waitForSelector('#fr-step2:not([hidden])');
  await page.click('#fr-done');
  await page.waitForSelector('#firstrun', { state: 'hidden' });
  await wait(800);
  await page.screenshot({ path: path.join(shots, 'shelf.png') });
  check((await page.textContent('#shelves')).includes('Works in Progress'), 'the shelf renders');

  const opacity = () => page.evaluate(() => getComputedStyle(document.getElementById('hosted-menubar')).opacity);
  check((await opacity()) === '0', 'the menu bar is hidden until asked for');
  await page.mouse.move(400, 2);
  await wait(400);
  check((await opacity()) === '1', 'the menu bar appears at the top edge');
  await page.click('#hosted-menubar .hm-title:has-text("View")');
  await wait(200);
  const items = await page.$$eval('#hosted-menubar .hm-top.hm-open > ul > li', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  check(items.some((i) => i.startsWith('Page')), 'the View menu opens with its items');
  await page.hover('#hosted-menubar .hm-top.hm-open > ul > li.hm-has-sub:has-text("Page")');
  await page.click('#hosted-menubar .hm-top.hm-open > ul > li.hm-has-sub:has-text("Page") > ul > li:has-text("Paper")');
  await wait(600);

  await page.click('.new-book');
  await page.waitForSelector('#editor-view:not([hidden])', { timeout: 10000 });
  await wait(800);
  await page.mouse.move(2, 400);
  await wait(400);
  await page.evaluate(() => document.getElementById('nav-add').click());
  await page.waitForSelector('#chapters .chapter-body', { timeout: 10000 });
  await page.click('#chapters .chapter-body');
  await page.keyboard.type('It was a dark and stormy night on the server.');
  await wait(1800); // past the 800 ms save debounce
  await page.keyboard.press('Control+Shift+O');
  await wait(300);
  check((await page.evaluate(() => (typeof focusLevel !== 'undefined' ? focusLevel : '?'))) !== 'off', 'an accelerator the menu bar owns reaches app.js');
  await page.screenshot({ path: path.join(shots, 'editor.png') });

  const users = fs.readdirSync(path.join(dataDir, 'users'));
  const lib = path.join(dataDir, 'users', users[0], 'NEO Library');
  const libraryJson = JSON.parse(fs.readFileSync(path.join(lib, 'library.json'), 'utf8'));
  check(libraryJson.authorName === 'Smoke Tester' && libraryJson.firstRunDone === true, 'library.json carries the first-run answers');
  check(libraryJson.pageTheme === 'paper', 'the theme chosen in the menu was saved');
  const bookDir = fs.readdirSync(lib).find((d) => d.startsWith('book-'));
  const chapters = fs.readdirSync(path.join(lib, bookDir, 'chapters'));
  const html = fs.readFileSync(path.join(lib, bookDir, 'chapters', chapters[0]), 'utf8');
  check(html.includes('dark and stormy night'), 'the typed sentence reached the chapter file');
  check(errors.length === 0, 'no console errors or failed requests' + (errors.length ? ': ' + errors.join('; ') : ''));

  console.log(`\nAll good. Screenshots in ${shots}`);
  await browser.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((err) => { console.error(err.message || err); server.kill(); process.exit(1); });
