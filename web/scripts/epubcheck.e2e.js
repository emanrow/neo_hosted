'use strict';

// An EPUB from the real exporter, through the hosted polish, checked by
// epubcheck. Boots the server with a temporary data folder, writes a book
// with front matter, a part and chapters in headless Chromium with Libron
// chosen, exports it the way File → Export → EPUB does, zips the entries as
// the bridge would, and runs epubcheck on the file. Exits 1 on any error
// or warning, or if the face and the drop cap did not land.
//
//   cd web && npm i --no-save playwright-core   (once; not a runtime dependency)
//   EPUBCHECK_JAR=/path/to/epubcheck.jar CHROMIUM_PATH=... node web/scripts/epubcheck.e2e.js
//
// Without EPUBCHECK_JAR the EPUB is still built and inspected, and the
// epubcheck step is skipped with a note. docs/testing.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try { ({ chromium } = require(path.join(ROOT, 'web', 'node_modules', 'playwright-core'))); } catch {
    console.error('Playwright is not installed: cd web && npm i --no-save playwright-core');
    process.exit(1);
  }
}
const JSZip = require(path.join(ROOT, 'web', 'node_modules', 'jszip'));
const { createApp } = require(path.join(ROOT, 'web', 'server'));

const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-epubcheck-'));
  const app = createApp({ dev: true, dataDir, sessionSecret: 's'.repeat(40), signup: 'open', inviteCode: '', trustProxy: false, port: 0, publicUrl: '', mail: {} });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(base + '/login');
    await page.click('#switch');
    await page.fill('#email', 'writer@example.com');
    await page.fill('#password', 'longenough');
    await page.click('#submit');
    await page.waitForURL(base + '/');
    await page.waitForTimeout(500);
    const para = '<p>' + 'The light failed early that winter, and the house on the hill kept its lamps lit from four in the afternoon. '.repeat(3) + '</p>';
    const dialogue = '<p>“You will not go,” she said. “Not tonight.”</p>';
    await page.evaluate(async ({ para, dialogue }) => {
      const lib = await window.neo.readLibrary();
      lib.firstRunDone = true; lib.fonts = { body: 'Libron' };
      await window.neo.writeLibrary(lib);
      const book = await window.neo.createBook({ title: 'The Lamps on the Hill' });
      const meta = await window.neo.readBookMeta(book.id);
      meta.subtitle = 'A Novel';
      meta.chapterOrder = ['ded', 'toc', 'part1', 'ch-1', 'ch-2'];
      meta.chapterKinds = { ded: 'dedication', toc: 'contents', part1: 'part' };
      meta.chapterTitles = { ded: 'Dedication', toc: 'Contents', part1: 'The Winter', 'ch-1': 'The Elms', 'ch-2': 'Lamps' };
      await window.neo.writeBookMeta(book.id, meta);
      await window.neo.writeChapter(book.id, 'ded', '<p>For the ones who stayed.</p>');
      await window.neo.writeChapter(book.id, 'toc', '');
      await window.neo.writeChapter(book.id, 'part1', '<p>Part One: The Winter</p>');
      await window.neo.writeChapter(book.id, 'ch-1', para.repeat(4) + '<p class="brk">* * *</p>' + dialogue + para.repeat(3));
      await window.neo.writeChapter(book.id, 'ch-2', dialogue + para.repeat(6));
      const lib2 = await window.neo.readLibrary();
      lib2.shelves[0].bookIds = [book.id];
      await window.neo.writeLibrary(lib2);
    }, { para, dialogue });
    await page.reload();
    await page.waitForSelector('#bookshelf-view .book');
    await page.click('#bookshelf-view .book');
    await page.waitForSelector('section.chapter');
    await page.waitForTimeout(500);
    // what exportSave does for an EPUB, minus the download
    const entries = await page.evaluate(async () => {
      const payload = await shelfPayload(bookExportData(), 'epub');
      return window.neoHosted.epub.polish(payload.zipEntries);
    });
    if (errors.length) fail('page errors: ' + errors.join('; '));
    const paths = entries.map((e) => e.path);
    const fonts = paths.filter((p) => p.startsWith('OEBPS/fonts/'));
    if (fonts.length !== 4) fail(`expected Libron's four faces in the EPUB, found ${fonts.length}: ${fonts.join(', ')}`);
    const css = entries.find((e) => e.path === 'OEBPS/style.css').content;
    if (!css.includes('body { font-family: "Libron", serif; }')) fail('the body is not set in Libron');
    if (!css.includes('::first-letter')) fail('no drop cap');
    const opf = entries.find((e) => e.path === 'OEBPS/content.opf').content;
    if ((opf.match(/media-type="font\/woff2"/g) || []).length !== 4) fail('the manifest does not list the faces');
    const zip = new JSZip();
    for (const e of entries) zip.file(e.path, e.content, { base64: !!e.base64, compression: e.store ? 'STORE' : 'DEFLATE' });
    const file = path.join(dataDir, 'book.epub');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' }));
    console.log(`built ${file}: ${entries.length} entries, ${fs.statSync(file).size} bytes, faces: ${fonts.map((f) => f.split('/').pop()).join(', ')}`);
    const jar = process.env.EPUBCHECK_JAR;
    if (!jar) { console.log('EPUBCHECK_JAR not set: the EPUB was built and inspected, epubcheck skipped'); return; }
    let report = '';
    try {
      report = execFileSync('java', ['-jar', jar, '--failonwarnings', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.error(String(err.stdout || '') + String(err.stderr || ''));
      fail('epubcheck found problems');
    }
    const summary = (report.match(/Messages: .*/) || [''])[0];
    console.log('epubcheck: ' + (summary || report.trim().split('\n').pop()));
  } finally {
    await browser.close();
    app.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err) => fail(err.stack || String(err)));
