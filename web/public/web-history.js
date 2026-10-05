/* ====================== NEO, HOSTED: HISTORY ====================== */
/* The revision log, shown to the writer: File → History… lists every  */
/* save of the chapter the caret is in, shows any one of them, and puts */
/* one back on the page. Nothing here is in the desktop app; the log    */
/* lives on the server (web/lib/revisions.js) and this is its window.   */
/*                                                                      */
/* Restoring never discards words: the page is saved first, the old     */
/* draft is written as a new save (so it is itself a revision), and the */
/* editor's own refreshFromDisk takes it in, sending the words it       */
/* replaced to Darlings as it would for an edit from another device.    */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};

  /** The chapter the writer is in: the one holding the caret, else the one nearest the middle of the window. */
  function chapterOnPage() {
    const editor = document.getElementById('editor-view');
    if (!editor || editor.hidden) return null;
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('section.chapter');
    if (focused) return focused;
    const middle = window.innerHeight / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const section of editor.querySelectorAll('section.chapter')) {
      const box = section.getBoundingClientRect();
      const distance = box.top > middle ? box.top - middle : box.bottom < middle ? middle - box.bottom : 0;
      if (distance < bestDistance) { best = section; bestDistance = distance; }
    }
    return best;
  }

  const when = (iso) => new Date(iso).toLocaleString(config.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' });
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };

  let open = null;

  async function openHistory() {
    if (open) { open.focus(); return; }
    const section = chapterOnPage();
    const bookId = hosted.state.bookId;
    if (!section || !bookId) { say(t('Open a chapter first')); return; }
    const chapterId = section.dataset.id;
    const head = section.querySelector('.chapter-head');
    // the head reads "Chapter 3 — Title"; with no title the separator hangs, so it goes
    const chapterLabel = (head ? head.textContent : chapterId).replace(/\s+/g, ' ').replace(/[\s—–-]+$/, '').trim();

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-history';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-history-modal" role="dialog" aria-labelledby="hosted-history-title">
        <h2 id="hosted-history-title" style="font-size:16px"></h2>
        <div class="hh-body">
          <ul class="hh-list" role="listbox"></ul>
          <div class="hh-preview chapter-body" aria-live="polite"></div>
        </div>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="hh-changes btn-quiet" disabled aria-pressed="false">${t('Show Changes')}</button>
          <button class="hh-close btn-quiet">${t('Close')}</button>
          <button class="hh-restore btn-gold" disabled>${t('Restore')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('History: {chapter}', { chapter: chapterLabel });
    const list = bd.querySelector('.hh-list');
    const preview = bd.querySelector('.hh-preview');
    const note = bd.querySelector('.hh-note');
    const restoreButton = bd.querySelector('.hh-restore');
    const changesButton = bd.querySelector('.hh-changes');
    const close = () => { bd.remove(); open = null; };
    bd.querySelector('.hh-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bd.focus();

    let entries = [];
    let chosen = null;
    let draftHtml = '';          // the chosen save's words, what Restore writes back
    let showingChanges = false;  // the blackline of that save against the draft as saved now

    /** Draws the chosen save as its words, or as what changed between it and now. */
    const show = async () => {
      const entry = chosen;
      if (!entry) return;
      preview.classList.toggle('hm-blackline', showingChanges);
      changesButton.setAttribute('aria-pressed', String(showingChanges));
      changesButton.textContent = showingChanges ? t('Show Draft') : t('Show Changes');
      if (!showingChanges) { preview.innerHTML = draftHtml || '<p><br></p>'; return; }
      preview.innerHTML = '';
      try {
        const { blackline, same } = await window.neo.compareRevision(bookId, chapterId, entry.id);
        if (chosen !== entry || !showingChanges) return;
        preview.innerHTML = blackline || '<p><br></p>';
        note.textContent = same ? t('Nothing has changed since this save.') : t('Struck through: words this save had that the page no longer has. Highlighted: words written since.');
      } catch (err) {
        note.textContent = t('Could not load the history ({error})', { error: String((err && err.message) || err) });
      }
    };
    changesButton.onclick = () => { showingChanges = !showingChanges; if (!showingChanges) note.textContent = ''; show(); };
    try {
      entries = await window.neo.listRevisions(bookId, chapterId);
    } catch (err) {
      note.textContent = t('Could not load the history ({error})', { error: String((err && err.message) || err) });
      return;
    }
    if (!entries.length) {
      note.textContent = t('No history yet. Every save from now on is kept.');
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.innerHTML = '<span class="hh-when"></span><span class="hh-words"></span>';
      li.querySelector('.hh-when').textContent = when(entry.createdAt);
      li.querySelector('.hh-words').textContent = t('{n} words', { n: entry.words });
      const choose = async () => {
        list.querySelectorAll('.hh-chosen').forEach((el) => el.classList.remove('hh-chosen'));
        li.classList.add('hh-chosen');
        li.setAttribute('aria-selected', 'true');
        chosen = entry;
        restoreButton.disabled = true;
        changesButton.disabled = true;
        preview.innerHTML = '';
        try {
          const html = await window.neo.readRevision(entry.id);
          if (chosen !== entry) return;
          draftHtml = html || '';
          restoreButton.disabled = false;
          changesButton.disabled = false;
          await show();
        } catch (err) {
          note.textContent = t('Could not load the history ({error})', { error: String((err && err.message) || err) });
        }
      };
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      list.appendChild(li);
    }
    list.firstChild.click();

    restoreButton.onclick = async () => {
      if (!chosen) return;
      restoreButton.disabled = true;
      try {
        if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
        await new Promise((resolve) => setTimeout(resolve, 800)); // the page's own save, if one was pending, is on its way
        await window.neo.writeChapter(bookId, chapterId, draftHtml);
        if (typeof window.refreshFromDisk === 'function') await window.refreshFromDisk();
        say(t('Restored the draft from {time}', { time: when(chosen.createdAt) }));
        close();
      } catch (err) {
        note.textContent = t('Could not restore it ({error})', { error: String((err && err.message) || err) });
        restoreButton.disabled = false;
      }
    };
  }

  hosted.openHistory = openHistory;
  hosted.chapterOnPage = chapterOnPage;   // web-share.js asks the same question
})();
