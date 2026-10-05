/* =========================== NEO, HOSTED =========================== */
/* The window.neo doorway, implemented for a browser. preload.js forwards  */
/* each call to main.js over IPC; this forwards it to the server over      */
/* HTTP, same names, same arguments (POST /api/<channel>). What a browser  */
/* can do itself (downloads, full screen, file pickers) it does here, and  */
/* what belongs to a desktop (a Mail app, an installer) is said plainly.   */

(function () {
  'use strict';

  const readData = (id) => {
    try { return JSON.parse(document.getElementById(id).textContent); } catch { return {}; }
  };
  const config = readData('neo-hosted-config');
  const i18nBundle = readData('neo-i18n');
  const tr = (key, vars) => (window.NeoI18n ? window.NeoI18n.t(key, vars) : key);
  const say = (msg, ms) => { if (typeof window.toast === 'function') window.toast(msg, ms); else console.log(msg); };

  // the Format and View menus' tick marks, as main.js keeps them
  const state = { poetry: false, flush: false, typewriter: false, vim: false, uiZoom: 1, view: { focus: 'off', pageTheme: 'night', uiBright: false }, writingStyle: 'pantser', bookId: null };
  // app.js keeps the open book to itself; the book it last asked about is the one on the page (web-history.js)
  const noting = (bookId) => {
    if (bookId && bookId !== state.bookId && window.neoHosted && window.neoHosted.branches) window.neoHosted.branches.refresh(bookId);
    state.bookId = bookId || null;
    return bookId;
  };
  let menuListener = null;
  let signedOutShown = false;

  async function rpc(channel, ...args) {
    let res;
    try {
      res = await fetch('/api/' + channel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args }),
        credentials: 'same-origin'
      });
    } catch (err) {
      throw new Error(tr('No connection to the server ({error}) — your words stay on the page until it is back', { error: String(err && err.message || err) }));
    }
    if (res.status === 401) {
      // never bounce away from a page with unsaved words: say it once, keep retrying
      if (!signedOutShown) { signedOutShown = true; say(tr('Your session ended. Sign in again in another tab — your words stay on this page and save once you have.'), 12000); }
      throw new Error('Signed out');
    }
    const body = await res.json().catch(() => ({ ok: false, error: res.statusText }));
    if (!body.ok) throw new Error(body.error || 'Request failed');
    return body.result;
  }

  // Files the writer hands the page (a dropped cover, a picked image) are
  // kept here by a token that looks like a path, so app.js's own checks on
  // the file extension keep working unchanged.
  const handed = new Map();
  let handedSeq = 0;
  function handOver(file) {
    const token = 'upload:' + (++handedSeq) + '/' + file.name;
    handed.set(token, file);
    return token;
  }
  function pickFile(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = !!multiple;
      input.style.display = 'none';
      input.onchange = () => { const files = [...input.files]; input.remove(); resolve(files); };
      input.oncancel = () => { input.remove(); resolve([]); };
      document.body.appendChild(input);
      input.click();
    });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // The browser is the PDF printer: the export's HTML opens in a tab with
  // the print dialog up, and "Save as PDF" is one click away.
  function openPrintView(html) {
    const w = window.open('', '_blank');
    if (!w) { say(tr('The browser blocked the print window — allow pop-ups for this site and try again'), 8000); return false; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.addEventListener('load', () => setTimeout(() => { try { w.focus(); w.print(); } catch { /* the tab is still there to print by hand */ } }, 300));
    return true;
  }

  // Manuscripts go up as raw bytes and come back parsed, one request each,
  // in the shape import:pick answers with on the desktop: a book per file,
  // or { name, error } for one that would not parse, so the rest still land.
  const IMPORT_ACCEPT = '.docx,.txt,.md';
  const IMPORTABLE = /\.(docx|txt|md)$/i;
  async function uploadManuscript(file) {
    try {
      const res = await fetch('/api/import:upload?name=' + encodeURIComponent(file.name), {
        method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }
      });
      const body = await res.json().catch(() => ({ ok: false, error: res.statusText }));
      if (!body.ok) return { name: file.name, error: body.error || 'Import failed' };
      return body.result;
    } catch (err) {
      return { name: file.name, error: String((err && err.message) || err) };
    }
  }
  async function importMany(files) {
    const out = [];
    for (const file of files) {
      if (!IMPORTABLE.test(file.name)) continue;
      out.push(await uploadManuscript(file));
    }
    return out;
  }
  // a handed-over file by its token, released once claimed
  function takeHanded(token) {
    const file = handed.get(token);
    if (file) handed.delete(token);
    return file || null;
  }

  const ZIP_MIME = { epub: 'application/epub+zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const TEXT_MIME = { txt: 'text/plain', md: 'text/markdown', html: 'text/html' };

  window.neo = {
    /* ---------- library ---------- */
    readLibrary: () => rpc('library:read'),
    writeLibrary: (data) => rpc('library:write', data),
    listBooks: () => rpc('library:listBooks'),
    // a URL: the shelf fetches covers from it (see coverUrl in app.js)
    libraryPath: async () => location.origin + '/library',

    /* ---------- books ---------- */
    createBook: (meta) => rpc('book:create', meta),
    readBookMeta: (bookId) => rpc('book:readMeta', noting(bookId)),
    writeBookMeta: (bookId, meta) => rpc('book:writeMeta', bookId, meta),
    // the page has already asked; the folder moves to the library's Trash, never the void
    deleteBook: async (bookId, title) => {
      const ok = await rpc('book:delete', bookId);
      if (ok) say(tr('“{title}” moved to your library’s Trash folder — ask for it back any time', { title: title || '' }), 6000);
      else say(tr('NEO couldn’t move that book to the Trash. It is untouched.'), 6000);
      return ok;
    },

    /* ---------- chapters and sidecars ---------- */
    chapterStamps: (bookId) => rpc('chapter:stamps', noting(bookId)),
    readChapter: (bookId, chId) => rpc('chapter:read', noting(bookId), chId),
    writeChapter: (bookId, chId, html) => rpc('chapter:write', noting(bookId), chId, html),
    /* ---------- public pages (hosted only; web-share.js is the caller) ---------- */
    listShares: (bookId) => rpc('share:list', bookId),
    publishShare: (bookId, chapterId, title, html) => rpc('share:publish', bookId, chapterId, title, html),
    removeShare: (token) => rpc('share:remove', token),
    /* ---------- history (hosted only; web-history.js is the reader) ---------- */
    listRevisions: (bookId, chId) => rpc('revision:list', bookId, chId),
    /* ---------- branches (hosted only; web-branches.js is the caller) ---------- */
    listBranches: (bookId) => rpc('branch:list', bookId),
    createBranch: (bookId, name) => rpc('branch:create', bookId, name),
    switchBranch: (bookId, name) => rpc('branch:switch', bookId, name),
    deleteBranch: (bookId, name) => rpc('branch:delete', bookId, name),
    mergePreview: (bookId, name) => rpc('branch:mergePreview', bookId, name),
    mergeBranch: (bookId, name, resolutions) => rpc('branch:merge', bookId, name, resolutions),
    readRevision: (id) => rpc('revision:read', id),
    compareRevision: (bookId, chId, id) => rpc('revision:compare', bookId, chId, id),
    deleteChapter: (bookId, chId) => rpc('chapter:delete', bookId, chId),
    readAux: (bookId, name) => rpc('aux:read', bookId, name),
    writeAux: (bookId, name, html) => rpc('aux:write', bookId, name, html),
    readJSON: (bookId, name, fallback) => rpc('json:read', bookId, name, fallback),
    writeJSON: (bookId, name, data) => rpc('json:write', bookId, name, data),

    /* ---------- covers ---------- */
    pathForFile: (file) => (file && file.name ? handOver(file) : null),
    pickCover: async () => {
      const [file] = await pickFile('image/png,image/jpeg,image/webp', false);
      return file ? handOver(file) : null;
    },
    setCover: async (bookId, token) => {
      const file = handed.get(token);
      if (!file) return null;
      handed.delete(token);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const res = await fetch('/api/cover:upload?bookId=' + encodeURIComponent(bookId) + '&ext=' + encodeURIComponent(ext), {
        method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }
      });
      const body = await res.json().catch(() => ({ ok: false }));
      if (!body.ok) { say(body.error || tr('Couldn’t save that cover')); return null; }
      return body.result;
    },
    removeCover: (bookId) => rpc('cover:remove', bookId),
    readCover: async (bookId, fname) => {
      try {
        const res = await fetch('/library/' + encodeURIComponent(bookId) + '/' + encodeURIComponent(fname), { credentials: 'same-origin' });
        if (!res.ok) return null;
        const blob = await res.blob();
        const base64 = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
        const ext = fname.split('.').pop().toLowerCase();
        return { base64, mime: blob.type || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'), ext };
      } catch { return null; }
    },
    paintCover: (bookId, text, options) => rpc('cover:paint', bookId, text, options),
    setSecret: (name, value) => rpc('secret:set', name, value),
    hasSecret: (name) => rpc('secret:has', name),

    /* ---------- export: the page builds the file, the browser downloads it ---------- */
    exportSave: async ({ format, defaultName, content, zipEntries }) => {
      const name = (defaultName || 'book') + '.' + format;
      if (format === 'pdf') {
        if (!openPrintView(content)) return null;
        say(tr('Choose “Save as PDF” in the print dialog'), 6000);
        return name;
      }
      if (zipEntries) {
        if (!window.JSZip) throw new Error('Zip support missing');
        const zip = new window.JSZip();
        for (const e of zipEntries) zip.file(e.path, e.content, { base64: !!e.base64, compression: e.store ? 'STORE' : 'DEFLATE' });
        download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: ZIP_MIME[format] || 'application/zip' }), name);
        return name;
      }
      download(new Blob([content], { type: (TEXT_MIME[format] || 'text/plain') + ';charset=utf-8' }), name);
      return name;
    },
    // ⌘E on the desktop hands a PDF to Mail. Here the browser opens the
    // print view (save it as PDF) and a mail draft to drag it into.
    emailDraft: async ({ to, subject, body, html, method }) => {
      const opened = openPrintView(html);
      const q = (s) => encodeURIComponent(s || '');
      if (method === 'gmail') window.open('https://mail.google.com/mail/?view=cm&fs=1&to=' + q(to) + '&su=' + q(subject) + '&body=' + q(body), '_blank');
      else location.href = 'mailto:' + q(to) + '?subject=' + q(subject) + '&body=' + q(body);
      return opened ? { ok: true, method: 'gmail' } : { ok: false };
    },

    /* ---------- import: the server parses, the page makes the book ---------- */
    importPick: async () => importMany(await pickFile(IMPORT_ACCEPT, true)),
    // the tokens pathForFile handed out for dropped files
    importFiles: async (paths) => importMany((paths || []).map(takeHanded).filter(Boolean)),

    /* ---------- the window ---------- */
    fullscreenToggle: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { /* a browser that will not */ }
      return true;
    },
    fullscreenEscape: async () => {
      if (!document.fullscreenElement) return false;
      try { await document.exitFullscreen(); } catch { return false; }
      return true;
    },
    // the site is always the newest version
    checkForUpdate: async () => ({ error: false, hasUpdate: false, currentVersion: config.version }),
    installUpdate: async () => true,
    openRelease: async () => { window.open(config.source || '/', '_blank'); return true; },
    appVersion: async () => config.version,

    /* ---------- spellcheck, on the server ---------- */
    spellCheckWords: (words) => rpc('spell:check', words).catch(() => { const o = {}; for (const w of words) o[w] = true; return o; }),
    spellSuggest: (word) => rpc('spell:suggest', word).catch(() => []),
    spellLearn: (word) => rpc('spell:learn', word).catch(() => true),
    setSpellLanguage: (code) => rpc('spell:setLanguage', code).catch(() => false),

    /* ---------- errors go to the writer's own neo-errors.log ---------- */
    logError: (msg) => { console.error(msg); return rpc('log:error', String(msg)).catch(() => false); },

    /* ---------- menus: web-menu.js stands in for the menu bar ---------- */
    onMenu: (fn) => { menuListener = fn; },
    poetryState: (on) => { state.poetry = !!on; },
    flushState: (on) => { state.flush = !!on; },
    typewriterState: (on) => { state.typewriter = !!on; },
    vimState: (on) => { state.vim = !!on; },
    uiZoomState: (z) => { state.uiZoom = z || 1; },
    viewState: (st) => { state.view = { ...state.view, ...(st || {}) }; },
    writingStyleState: (st) => { state.writingStyle = st || 'pantser'; },
    i18n: i18nBundle,
    setUiLanguage: (code) => rpc('settings:language', code),
    reloadForLanguage: async () => { location.reload(); return true; },
    signOut: async () => {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
      location.href = '/login';
    }
  };

  // the browser says when full screen comes and goes, as the window does on the desktop
  document.addEventListener('fullscreenchange', () => { if (menuListener) menuListener({ type: 'fullScreen', value: !!document.fullscreenElement }); });

  // File → Download Library…: the whole library as the desktop app's folder,
  // zipped by the server. Saves first, so the zip has the words on the page.
  async function downloadLibrary() {
    if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const a = document.createElement('a');
    a.href = '/library.zip';
    a.download = 'NEO Library.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 2000);
  }

  window.neoHosted = {
    config,
    state,
    sendMenu: (msg) => { if (menuListener) menuListener(msg); },
    downloadLibrary
  };
})();
