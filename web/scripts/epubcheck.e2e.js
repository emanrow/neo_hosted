'use strict';

// An EPUB from the real exporter, through the hosted polish, checked by
// epubcheck. Boots the server with a temporary data folder, writes a book
// with front matter, a part and chapters in headless Chromium with Libron
// chosen, puts two pictures in it the way Format → Insert Picture… does,
// exports it the way File → Export → EPUB does, zips the entries as the
// bridge would, and runs epubcheck on the file. Exits 1 on any error or
// warning, or if the face, the drop cap or the pictures did not land.
//
//   cd web && npm i --no-save playwright-core   (once; not a runtime dependency)
//   EPUBCHECK_JAR=/path/to/epubcheck.jar CHROMIUM_PATH=... node web/scripts/epubcheck.e2e.js
//
// Without EPUBCHECK_JAR the EPUB is still built and inspected, and the
// epubcheck step is skipped with a note. docs/testing.md.

const fs = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
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

// a real PNG, 2 by 2, to upload as a picture
function tinyPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = Buffer.from([0, 200, 30, 30, 30, 30, 200, 0, 30, 30, 200, 200, 200, 30]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

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
    // two pictures, placed as Format → Insert Picture… places them: one with
    // a caption typed under it, one with none; Enter in a caption makes a
    // plain paragraph, so the book goes on below the picture
    const png = tinyPng().toString('base64');
    const placeAt = async (chId, nth) => page.evaluate(([chId, nth]) => {
      const p = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body p:nth-of-type(${nth})`);
      p.closest('.chapter-body').focus();
      placeCaret(p.firstChild || p, 0);
    }, [chId, nth]);
    await placeAt('ch-1', 2);
    const placed = await page.evaluate(async (png) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      return window.neoHosted.figures.placePicture(new File([bytes], 'hill.png', { type: 'image/png' }));
    }, png);
    if (placed !== true) fail('the picture was not placed');
    await page.keyboard.type('The house on the hill');
    await page.keyboard.press('Enter');
    await page.keyboard.type('After the picture.');
    await placeAt('ch-2', 3);
    await page.evaluate(async (png) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      return window.neoHosted.figures.placePicture(new File([bytes], 'lamps.png', { type: 'image/png' }));
    }, png);
    await page.waitForTimeout(1200); // the editor's save
    const onDisk = await page.evaluate(async () => {
      const id = window.neoHosted.state.bookId;
      return { one: await window.neo.readChapter(id, 'ch-1'), two: await window.neo.readChapter(id, 'ch-2') };
    });
    const planted = onDisk.one.match(/<p class="figure" data-figure="(fig-\d+\.png)" data-figure-size="2x2">The house on the hill<\/p><p>After the picture\.<\/p>/);
    if (!planted) fail('the captioned picture is not in the chapter as expected: ' + onDisk.one.slice(0, 600));
    if ((onDisk.one.match(/data-figure=/g) || []).length !== 1) fail('Enter in the caption cloned the picture');
    if (!/<p class="figure" data-figure="fig-\d+\.png" data-figure-size="2x2"><br><\/p>/.test(onDisk.two)) fail('the captionless picture is not in its chapter: ' + onDisk.two.slice(0, 400));
    const shown = await page.evaluate(() => document.getElementById('hosted-figures').textContent);
    if ((shown.match(/background-image: url\("\/library\//g) || []).length !== 2) fail('the editor does not draw both pictures: ' + shown);
    // the web page (and the printer's input) carries the bytes
    const webPage = await page.evaluate(async () => window.neoHosted.figures.inlineExport(buildHtml(bookExportData())));
    if ((webPage.match(/<img src="data:image\/png;base64,/g) || []).length !== 2) fail('the web page does not carry both pictures');
    if (!webPage.includes('<figcaption>The house on the hill</figcaption>')) fail('the web page lost the caption');
    // what exportSave does for an EPUB, minus the download
    const entries = await page.evaluate(async () => {
      const payload = await shelfPayload(bookExportData(), 'epub');
      return window.neoHosted.figures.epubExport(await window.neoHosted.epub.polish(payload.zipEntries));
    });
    if (errors.length) fail('page errors: ' + errors.join('; '));
    const images = entries.filter((e) => e.path.startsWith('OEBPS/images/'));
    if (images.length !== 2) fail(`expected two pictures in the EPUB, found ${images.length}`);
    const chapterFiles = entries.filter((e) => /^OEBPS\/ch\d+\.xhtml$/.test(e.path) && e.content.includes('<figure class="figure">'));
    if (chapterFiles.length !== 2) fail('the pictures are not in their chapter files');
    if (!entries.some((e) => e.content.includes('<figcaption>The house on the hill</figcaption>'))) fail('the EPUB lost the caption');
    const paths = entries.map((e) => e.path);
    const fonts = paths.filter((p) => p.startsWith('OEBPS/fonts/'));
    if (fonts.length !== 4) fail(`expected Libron's four faces in the EPUB, found ${fonts.length}: ${fonts.join(', ')}`);
    const css = entries.find((e) => e.path === 'OEBPS/style.css').content;
    if (!css.includes('body { font-family: "Libron", serif; }')) fail('the body is not set in Libron');
    if (!css.includes('::first-letter')) fail('no drop cap');
    const opf = entries.find((e) => e.path === 'OEBPS/content.opf').content;
    if ((opf.match(/media-type="font\/woff2"/g) || []).length !== 4) fail('the manifest does not list the faces');
    if ((opf.match(/media-type="image\/png"/g) || []).length !== 2) fail('the manifest does not list the pictures');
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
