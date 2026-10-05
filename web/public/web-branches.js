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

  hosted.branches = { refresh, switchBranch, newBranch, deleteBranch };
  reopenAfterReload();
})();
