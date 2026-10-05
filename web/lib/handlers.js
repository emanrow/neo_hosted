'use strict';

// The window.neo doorway, server side. Every channel here is named after the
// ipcMain.handle it stands in for, so main.js and this file read side by
// side; web-bridge.js posts to /api/<channel> with the same arguments
// preload.js would have passed. ctx is one request's writer: their library,
// settings, secrets file and translator. ctx.library may be the file
// library or the Postgres one, so every call on it is awaited.

const path = require('node:path');
const { SPELL_LANGUAGES, defaultSpellLanguage } = require('./spell');

const SECRET_NAME = /^[a-z0-9-]{1,32}$/;

/**
 * @param {{ handle: (channel: string, fn: Function) => void }} api
 * @param {{ spell: import('./spell').SpellService, secretBox: object, versions: { hosted: string, neo: string }, rootDir: string }} deps
 */
const SHARE_HTML_LIMIT = 20 * 1024 * 1024;        // a book with its fonts and cover inlined

function registerHandlers(api, { spell, secretBox, versions, rootDir }) {
  // ---------- library ----------
  api.handle('library:read', (ctx) => ctx.library.readLibrary());
  api.handle('library:write', (ctx, data) => ctx.library.writeLibrary(data));
  api.handle('library:listBooks', (ctx) => ctx.library.listBooks());

  // ---------- books ----------
  api.handle('book:create', (ctx, meta) => ctx.library.createBook(meta || {}));
  api.handle('book:readMeta', (ctx, bookId) => ctx.library.readBookMeta(bookId));
  api.handle('book:writeMeta', (ctx, bookId, meta) => ctx.library.writeBookMeta(bookId, meta));
  // the page already asked the writer; the folder goes to the library's Trash
  api.handle('book:delete', (ctx, bookId) => ctx.library.trashBook(bookId));

  // ---------- chapters and sidecars ----------
  api.handle('chapter:stamps', (ctx, bookId) => ctx.library.chapterStamps(bookId));
  api.handle('chapter:read', (ctx, bookId, chapterId) => ctx.library.readChapter(bookId, chapterId));
  // the file first, then the history; a log that cannot be written never costs a save
  api.handle('chapter:write', async (ctx, bookId, chapterId, html) => {
    const saved = await ctx.library.writeChapter(bookId, chapterId, html);
    try { await ctx.revisions.record(bookId, chapterId, html); } catch (err) { ctx.logError('revisions', err); }
    return saved;
  });
  api.handle('chapter:delete', (ctx, bookId, chapterId) => ctx.library.deleteChapter(bookId, chapterId));
  // ---------- branches (hosted only; web-branches.js is the caller) ----------
  api.handle('branch:list', (ctx, bookId) => ctx.branches.list(bookId));
  api.handle('branch:switch', (ctx, bookId, name) => ctx.branches.switchTo(bookId, name));
  api.handle('branch:delete', (ctx, bookId, name) => ctx.branches.remove(bookId, name));
  api.handle('branch:mergePreview', (ctx, bookId, name) => ctx.merger.preview(bookId, name));
  // the merged chapters go through chapter:write's path so the log keeps them
  api.handle('branch:merge', async (ctx, bookId, name, resolutions) => {
    const result = await ctx.merger.apply(bookId, name, resolutions && typeof resolutions === 'object' ? resolutions : {});
    for (const { id, html } of result.written) {
      try { await ctx.revisions.record(bookId, id, html); } catch (err) { ctx.logError('revisions', err); }
    }
    return { into: result.into, from: result.from, chapters: result.written.length };
  });
  // a new branch starts its history with where it branched from, chapter by chapter
  api.handle('branch:create', async (ctx, bookId, name) => {
    const info = await ctx.branches.create(bookId, name);
    const meta = await ctx.library.readBookMeta(bookId);
    for (const chapterId of (meta && meta.chapterOrder) || []) {
      try { await ctx.revisions.record(bookId, chapterId, await ctx.library.readChapter(bookId, chapterId)); } catch (err) { ctx.logError('revisions', err); }
    }
    return info;
  });

  // ---------- public pages (hosted only; web-share.js is the caller) ----------
  // the page builds the HTML with the editor's own exporter; the server only keeps and serves it
  api.handle('share:list', (ctx, bookId) => ctx.shares.list(ctx.user.id, bookId));
  api.handle('share:publish', (ctx, bookId, chapterId, title, html) => {
    if (typeof bookId !== 'string' || !bookId) throw new Error('A book is needed');
    if (typeof html !== 'string' || !/^\s*<!doctype html/i.test(html)) throw new Error('A whole web page is needed');
    if (html.length > SHARE_HTML_LIMIT) throw new Error('That page is too large to publish');
    return ctx.shares.publish({ userId: ctx.user.id, bookId, chapterId: chapterId || '', title: String(title || '').slice(0, 300), html });
  });
  api.handle('share:remove', (ctx, token) => ctx.shares.remove(ctx.user.id, token));

  // ---------- history (hosted only; web-history.js is the reader) ----------
  api.handle('revision:list', (ctx, bookId, chapterId) => ctx.revisions.list(bookId, chapterId));
  api.handle('revision:read', (ctx, id) => ctx.revisions.read(id));
  api.handle('revision:verify', (ctx, bookId, chapterId) => ctx.revisions.verify(bookId, chapterId));
  api.handle('aux:read', (ctx, bookId, name) => ctx.library.readAux(bookId, name));
  api.handle('aux:write', (ctx, bookId, name, html) => ctx.library.writeAux(bookId, name, html));
  api.handle('json:read', (ctx, bookId, name, fallback) => ctx.library.readSidecar(bookId, name, fallback));
  api.handle('json:write', (ctx, bookId, name, data) => ctx.library.writeSidecar(bookId, name, data));

  // ---------- covers (the upload itself is a raw route in server.js) ----------
  api.handle('cover:remove', (ctx, bookId) => ctx.library.removeCover(bookId));

  // ---------- API keys, encrypted outside the library ----------
  const secretName = (name) => {
    if (!SECRET_NAME.test(String(name))) throw new Error('Invalid secret name');
    return name;
  };
  api.handle('secret:set', (ctx, name, value) => secretBox.write(ctx.secretsFile, secretName(name), value));
  api.handle('secret:has', (ctx, name) => secretBox.has(ctx.secretsFile, secretName(name)));

  // ---------- painted covers: art.js, unchanged, with the writer's own key ----------
  const paintJobs = new Map(); // `${userId}/${bookId}` -> Promise, one painting at a time per book
  api.handle('cover:paint', (ctx, bookId, text, options) => {
    const key = `${ctx.user.id}/${bookId}`;
    if (paintJobs.has(key)) return paintJobs.get(key);
    const job = (async () => {
      const provider = (options && options.provider) || 'openai';
      const apiKey = secretBox.read(ctx.secretsFile, secretName(provider));
      if (!apiKey) return { error: ctx.t('No API key for {provider} — add one under File → Cover Art…', { provider }) };
      if (!(await ctx.library.readBookMeta(bookId))) return { error: ctx.t('Book folder is missing') };
      try {
        const art = require(path.join(rootDir, 'art.js'));
        const out = await art.paintCover({
          provider, apiKey, text: String(text || ''),
          textModel: options && options.textModel, imageModel: options && options.imageModel, quality: options && options.quality
        });
        const file = await ctx.library.storePainting(bookId, { buffer: out.buffer, ext: out.ext, brief: out.brief, provider, textModel: out.textModel, imageModel: out.imageModel });
        return { file, brief: out.brief };
      } catch (err) {
        ctx.logError('paint', err);
        return { error: String((err && err.message) || err) };
      }
    })();
    paintJobs.set(key, job);
    job.finally(() => paintJobs.delete(key));
    return job;
  });

  // ---------- spellcheck ----------
  // the dictionary picked in Edit → Spellcheck Language (saved by the page in
  // library.json) wins; until then it follows the interface language
  const spellLanguageOf = (lib, ctx) => (SPELL_LANGUAGES[lib.spellLanguage] ? lib.spellLanguage : defaultSpellLanguage(ctx.locale));
  api.handle('spell:check', async (ctx, words) => {
    const lib = await ctx.library.readLibrary();
    return spell.check(spellLanguageOf(lib, ctx), Array.isArray(words) ? words : [], lib.customWords || []);
  });
  api.handle('spell:suggest', async (ctx, word) => spell.suggest(spellLanguageOf(await ctx.library.readLibrary(), ctx), String(word || '')));
  // the page keeps customWords in library.json itself; nothing to do but agree
  api.handle('spell:learn', () => true);
  api.handle('spell:setLanguage', async (_ctx, code) => {
    if (!spell.knows(code)) return false;
    return !!(await spell.checker(code));
  });

  // ---------- the rest of the desktop's main process ----------
  api.handle('log:error', (ctx, msg) => { ctx.logError('renderer', msg); return true; });
  api.handle('settings:language', (ctx, code) => ctx.setLanguage(code));
  api.handle('app:version', () => `${versions.hosted} (NEO ${versions.neo})`);
}

module.exports = { registerHandlers };
