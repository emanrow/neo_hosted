/* ====================== NEO, HOSTED: BRANCHES ====================== */
/* Alternate drafts of a whole book, from File → Branches. The server    */
/* keeps each branch as its own copy of the book folder and points "the  */
/* book" at the one the writer is in (web/lib/branches.js). The editor   */
/* never learns this, so switching is: save everything, tell the server, */
/* reload the page, reopen the book. Nothing on the page is merged with  */
/* the other draft, so nothing can be lost between them.                 */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const REOPEN_KEY = 'neo-hosted-reopen';
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const bookOnPage = () => {
    const editor = document.getElementById('editor-view');
    return editor && !editor.hidden ? hosted.state.bookId : null;
  };

  /** The branch list for the open book, kept on hosted.state for the menu to draw. */
  async function refresh(bookId) {
    if (!bookId) return null;
    try {
      const info = await window.neo.listBranches(bookId);
      hosted.state.branches = { bookId, ...info };
      return info;
    } catch { return null; }
  }

  /** Saves the page, moves the book to a branch on the server, and comes back with it open. */
  async function go(bookId, name) {
    if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
    await pause(800);
    await window.neo.switchBranch(bookId, name);
    try { sessionStorage.setItem(REOPEN_KEY, bookId); } catch { /* the shelf, then */ }
    location.reload();
  }

  async function switchBranch(name) {
    const bookId = bookOnPage();
    if (!bookId) { say(t('Open a book first')); return; }
    const current = hosted.state.branches && hosted.state.branches.bookId === bookId ? hosted.state.branches.active : null;
    if (current === name) return;
    try { await go(bookId, name); } catch (err) { say(String((err && err.message) || err)); }
  }

  async function newBranch() {
    const bookId = bookOnPage();
    if (!bookId) { say(t('Open a book first')); return; }
    const name = typeof window.askInput === 'function'
      ? await window.askInput(t('New branch'), t('What if…'))
      : window.prompt(t('New branch'));
    if (!name) return;
    try {
      if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
      await pause(800);
      await window.neo.createBranch(bookId, name);
      try { sessionStorage.setItem(REOPEN_KEY, bookId); } catch { /* the shelf, then */ }
      location.reload();
    } catch (err) {
      say(String((err && err.message) || err));
    }
  }

  async function deleteBranch() {
    const bookId = bookOnPage();
    const info = bookId && (await refresh(bookId));
    if (!info) { say(t('Open a book first')); return; }
    const others = info.branches.filter((b) => b.name !== 'main' && b.name !== info.active).map((b) => b.name);
    if (!others.length) { say(t('No other branch to delete. Switch away from a branch to delete it.')); return; }
    const name = typeof window.optionModal === 'function'
      ? await window.optionModal(t('Delete a branch'), t('It goes to the library’s Trash, not away.'), others.map((name) => ({ label: name, value: name })))
      : (window.prompt(t('Delete which branch? {names}', { names: others.join(', ') })) || null);
    if (!name || !others.includes(name)) return;
    try {
      await window.neo.deleteBranch(bookId, name);
      await refresh(bookId);
      say(t('Branch "{name}" moved to Trash', { name }));
    } catch (err) {
      say(String((err && err.message) || err));
    }
  }

  /** Compare & Merge…: pick a branch, see what merging it here would do, settle conflicts, merge. */
  async function mergeBranch() {
    const bookId = bookOnPage();
    const info = bookId && (await refresh(bookId));
    if (!info) { say(t('Open a book first')); return; }
    const others = info.branches.filter((b) => b.name !== info.active).map((b) => b.name);
    if (!others.length) { say(t('No other branch to merge. Make one first.')); return; }
    const label = (n) => (n === 'main' ? t('Main draft') : n);
    const name = typeof window.optionModal === 'function'
      ? await window.optionModal(t('Merge into this draft'), t('Which draft comes into "{into}"?', { into: label(info.active) }), others.map((n) => ({ label: label(n), value: n })))
      : (window.prompt(t('Merge which draft? {names}', { names: others.join(', ') })) || null);
    if (!name || !others.includes(name)) return;
    if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
    await pause(800);
    let preview;
    try { preview = await window.neo.mergePreview(bookId, name); } catch (err) { say(String((err && err.message) || err)); return; }
    showMergePanel(bookId, preview, label);
  }

  const STATUS_WORDS = () => ({ same: t('same'), kept: t('only changed here'), merged: t('merges cleanly'), added: t('new chapter'), conflict: t('needs a choice') });

  function showMergePanel(bookId, preview, label) {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-merge';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-merge-modal" role="dialog" aria-labelledby="hosted-merge-title">
        <h2 id="hosted-merge-title" style="font-size:16px"></h2>
        <p class="hm-lead"></p>
        <div class="hh-body">
          <ul class="hh-list" role="listbox"></ul>
          <div class="hm-detail"></div>
        </div>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="hm-cancel btn-quiet">${t('Cancel')}</button>
          <button class="hm-go btn-gold">${t('Merge')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const words = STATUS_WORDS();
    const changed = preview.chapters.filter((c) => c.status !== 'same' && c.status !== 'kept');
    const conflicts = changed.reduce((n, c) => n + c.conflicts.length, 0);
    bd.querySelector('h2').textContent = t('Merge "{from}" into "{into}"', { from: label(preview.from), into: label(preview.into) });
    bd.querySelector('.hm-lead').textContent = changed.length
      ? (conflicts ? t('Chapters that change: {n}. Places changed in both drafts: {c}. Choose for each, or keep both.', { n: changed.length, c: conflicts }) : t('Chapters that change: {n}. Nothing was changed in both drafts.', { n: changed.length }))
      : t('Nothing to merge: this draft already has everything from "{from}".', { from: label(preview.from) });
    const list = bd.querySelector('.hh-list');
    const detail = bd.querySelector('.hm-detail');
    const note = bd.querySelector('.hh-note');
    const go = bd.querySelector('.hm-go');
    go.disabled = !changed.length;
    const resolutions = {};
    const close = () => bd.remove();
    bd.querySelector('.hm-cancel').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bd.focus();

    const show = (chapter, li) => {
      list.querySelectorAll('.hh-chosen').forEach((el) => el.classList.remove('hh-chosen'));
      li.classList.add('hh-chosen');
      detail.textContent = '';
      for (const conflict of chapter.conflicts) {
        const key = `${chapter.id}:${conflict.index}`;
        const box = document.createElement('div');
        box.className = 'hm-conflict';
        box.innerHTML = `
          <div class="hm-side"><div class="hm-side-title"></div><div class="chapter-body hm-text"></div></div>
          <div class="hm-side"><div class="hm-side-title"></div><div class="chapter-body hm-text"></div></div>
          <div class="hm-choice"></div>`;
        const [mine, theirs] = box.querySelectorAll('.hm-side');
        mine.querySelector('.hm-side-title').textContent = t('Here, in "{name}"', { name: label(preview.into) });
        mine.querySelector('.hm-text').innerHTML = conflict.ours || `<p><em>${t('(nothing)')}</em></p>`;
        theirs.querySelector('.hm-side-title').textContent = t('In "{name}"', { name: label(preview.from) });
        theirs.querySelector('.hm-text').innerHTML = conflict.theirs || `<p><em>${t('(nothing)')}</em></p>`;
        const choice = box.querySelector('.hm-choice');
        for (const [value, text] of [['both', t('Keep both')], ['ours', t('Keep mine')], ['theirs', t('Take theirs')]]) {
          const lab = document.createElement('label');
          const input = document.createElement('input');
          input.type = 'radio'; input.name = key; input.value = value; input.checked = (resolutions[key] || 'both') === value;
          input.addEventListener('change', () => { resolutions[key] = value; });
          lab.append(input, ' ' + text);
          choice.appendChild(lab);
        }
        detail.appendChild(box);
      }
      if (chapter.blackline) {
        const bl = document.createElement('div');
        bl.className = 'chapter-body hm-blackline';
        bl.innerHTML = chapter.blackline;
        detail.appendChild(bl);
      } else {
        detail.innerHTML = `<p class="hh-note">${words[chapter.status]}</p>`;
      }
    };
    for (const chapter of preview.chapters) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.innerHTML = '<span class="hh-when"></span><span class="hh-words"></span>';
      li.querySelector('.hh-when').textContent = chapter.label;
      li.querySelector('.hh-words').textContent = words[chapter.status] || chapter.status;
      if (chapter.status === 'conflict') li.classList.add('hm-has-conflict');
      li.addEventListener('click', () => show(chapter, li));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(chapter, li); } });
      list.appendChild(li);
    }
    const first = changed[0] || preview.chapters[0];
    if (first) show(first, list.children[preview.chapters.indexOf(first)]);

    go.onclick = async () => {
      go.disabled = true;
      try {
        const result = await window.neo.mergeBranch(bookId, preview.from, resolutions);
        try { sessionStorage.setItem(REOPEN_KEY, bookId); } catch { /* the shelf, then */ }
        say(t('Merged "{from}" into "{into}": {n} chapters changed', { from: label(result.from), into: label(result.into), n: result.chapters }));
        location.reload();
      } catch (err) {
        note.textContent = String((err && err.message) || err);
        go.disabled = false;
      }
    };
  }

  // After a switch the page reloads on the shelf; open the book again once
  // the shelf is drawn, and say which draft this is.
  async function reopenAfterReload() {
    let bookId = null;
    try { bookId = sessionStorage.getItem(REOPEN_KEY); sessionStorage.removeItem(REOPEN_KEY); } catch { return; }
    if (!bookId) return;
    for (let i = 0; i < 100; i++) {
      if (typeof window.openBook === 'function' && document.querySelector('#bookshelf-view .book')) break;
      await pause(100);
    }
    if (typeof window.openBook !== 'function') return;
    await window.openBook(bookId);
    const info = await refresh(bookId);
    if (info) say(info.active === 'main' ? t('Main draft') : t('Branch: {name}', { name: info.active }));
  }

  hosted.branches = { refresh, switchBranch, newBranch, deleteBranch, mergeBranch };
  reopenAfterReload();
})();
