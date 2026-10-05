'use strict';

// The window.neo doorway, server side. Every channel here is named after the
// ipcMain.handle it stands in for, so main.js and this file read side by
// side; web-bridge.js posts to /api/<channel> with the same arguments
// preload.js would have passed. ctx is one request's writer: their library,
// settings, secrets file and translator.

const path = require('node:path');
const { SPELL_LANGUAGES, defaultSpellLanguage } = require('./spell');

const SECRET_NAME = /^[a-z0-9-]{1,32}$/;

/**
 * @param {{ handle: (channel: string, fn: Function) => void }} api
 * @param {{ spell: import('./spell').SpellService, secretBox: object, versions: { hosted: string, neo: string }, rootDir: string }} deps
 */
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
    const saved = ctx.library.writeChapter(bookId, chapterId, html);
    try { await ctx.revisions.record(bookId, chapterId, html); } catch (err) { ctx.logError('revisions', err); }
    return saved;
  });
  api.handle('chapter:delete', (ctx, bookId, chapterId) => ctx.library.deleteChapter(bookId, chapterId));
  // ---------- history (hosted only; the editor does not call these yet) ----------
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
      if (!ctx.library.readBookMeta(bookId)) return { error: ctx.t('Book folder is missing') };
      try {
        const art = require(path.join(rootDir, 'art.js'));
        const out = await art.paintCover({
          provider, apiKey, text: String(text || ''),
          textModel: options && options.textModel, imageModel: options && options.imageModel, quality: options && options.quality
        });
        const file = ctx.library.storePainting(bookId, { buffer: out.buffer, ext: out.ext, brief: out.brief, provider, textModel: out.textModel, imageModel: out.imageModel });
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
  const spellLanguageFor = (ctx) => {
    const lib = ctx.library.readLibrary();
    return SPELL_LANGUAGES[lib.spellLanguage] ? lib.spellLanguage : defaultSpellLanguage(ctx.locale);
  };
  api.handle('spell:check', (ctx, words) => {
    const lib = ctx.library.readLibrary();
    const code = SPELL_LANGUAGES[lib.spellLanguage] ? lib.spellLanguage : defaultSpellLanguage(ctx.locale);
    return spell.check(code, Array.isArray(words) ? words : [], lib.customWords || []);
  });
  api.handle('spell:suggest', (ctx, word) => spell.suggest(spellLanguageFor(ctx), String(word || '')));
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
