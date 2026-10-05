/* ======================= NEO, HOSTED: SHARE ======================= */
/* File → Share…: a writer puts a book, or the chapter they are in, on */
/* the web as a read-only page, by choice and one link at a time. The  */
/* page is a snapshot: the same HTML as Export → Web Page, built here  */
/* by the editor's own exporter and sent to the server, which serves   */
/* it at /s/<token> to anyone with the link. Editing changes nothing   */
/* until the writer publishes again; Unpublish takes the page down.    */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const when = (iso) => new Date(iso).toLocaleString(config.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' });
  const linkFor = (token) => `${location.origin}/s/${token}`;

  /** The export HTML of the whole book, or of one chapter, exactly as Export → Web Page makes it. */
  async function snapshot(chapterId) {
    const data = chapterId ? window.chapterExportData(chapterId) : window.bookExportData();
    if (!data) throw new Error(t('Open a chapter first'));
    const fonts = await window.exportFontFaces(data);
    const cover = chapterId ? null : await window.exportCover(data);
    return { title: chapterId ? data.chapterOnly : data.title, html: window.buildHtml(data, { cover, fonts }) };
  }

  let open = null;

  async function openShare() {
    if (open) { open.focus(); return; }
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return; }
    const section = hosted.chapterOnPage ? hosted.chapterOnPage() : null;
    const chapterId = section ? section.dataset.id : null;

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-share';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-share-modal" role="dialog" aria-labelledby="hosted-share-title">
        <h2 id="hosted-share-title" style="font-size:16px"></h2>
        <p class="hs-lead"></p>
        <ul class="hs-list"></ul>
        <div class="hs-publish">
          <button class="hs-book btn-quiet"></button>
          <button class="hs-chapter btn-quiet" hidden></button>
        </div>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="hs-close btn-gold">${t('Close')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Share');
    bd.querySelector('.hs-lead').textContent = t('A published page is a copy of the book as it is now, for anyone with its link. Publish again to update it; unpublish to take it down.');
    const list = bd.querySelector('.hs-list');
    const note = bd.querySelector('.hh-note');
    const bookButton = bd.querySelector('.hs-book');
    const chapterButton = bd.querySelector('.hs-chapter');
    const close = () => { bd.remove(); open = null; };
    bd.querySelector('.hs-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bd.focus();

    let shares = [];
    const draw = () => {
      list.innerHTML = '';
      for (const share of shares) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'hs-label';
        label.textContent = share.chapterId ? share.title : t('{title} (whole book)', { title: share.title });
        const stamp = document.createElement('span');
        stamp.className = 'hh-words';
        stamp.textContent = t('Published {when}', { when: when(share.updatedAt) });
        const link = document.createElement('input');
        link.className = 'hs-link';
        link.readOnly = true;
        link.value = linkFor(share.token);
        link.onclick = () => link.select();
        const row = document.createElement('div');
        row.className = 'hs-row';
        const copy = document.createElement('button');
        copy.className = 'btn-quiet';
        copy.textContent = t('Copy Link');
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(link.value); say(t('Link copied')); } catch { link.select(); }
        };
        const update = document.createElement('button');
        update.className = 'btn-quiet';
        update.textContent = t('Publish Again');
        update.onclick = () => publish(share.chapterId || null);
        const remove = document.createElement('button');
        remove.className = 'btn-quiet';
        remove.textContent = t('Unpublish');
        remove.onclick = async () => {
          try { await window.neo.removeShare(share.token); say(t('Page taken down')); await refresh(); } catch (err) { note.textContent = String(err.message || err); }
        };
        // a phone's own share sheet (Messages, Mail, AirDrop…), where the browser has one
        if (typeof navigator.share === 'function') {
          const sheet = document.createElement('button');
          sheet.className = 'btn-quiet hs-sheet';
          sheet.textContent = t('Share…');
          sheet.onclick = async () => {
            try { await navigator.share({ title: share.title, url: link.value }); } catch (err) { if (err && err.name !== 'AbortError') { try { await navigator.clipboard.writeText(link.value); say(t('Link copied')); } catch { link.select(); } } }
          };
          row.append(sheet);
        }
        row.append(copy, update, remove);
        li.append(label, stamp, link, row);
        list.appendChild(li);
      }
      const bookShared = shares.some((s) => !s.chapterId);
      const chapterShared = chapterId && shares.some((s) => s.chapterId === chapterId);
      bookButton.textContent = bookShared ? t('Publish the Book Again') : t('Publish the Book');
      chapterButton.hidden = !chapterId;
      chapterButton.textContent = chapterShared ? t('Publish This Chapter Again') : t('Publish This Chapter');
      note.textContent = shares.length ? '' : t('Nothing is published yet.');
    };
    const refresh = async () => {
      try { shares = await window.neo.listShares(bookId); } catch (err) { shares = []; note.textContent = String(err.message || err); }
      draw();
    };
    const publish = async (chId) => {
      note.textContent = t('Publishing…');
      bookButton.disabled = chapterButton.disabled = true;
      try {
        if (typeof window.flushAllSaves === 'function') window.flushAllSaves();
        const { title, html } = await snapshot(chId);
        const share = await window.neo.publishShare(bookId, chId, title, html);
        await refresh();
        note.textContent = t('Published. The link is ready to copy.');
        const row = [...list.querySelectorAll('.hs-link')].find((i) => i.value === linkFor(share.token));
        if (row) row.select();
      } catch (err) {
        note.textContent = String(err.message || err);
      } finally {
        bookButton.disabled = chapterButton.disabled = false;
      }
    };
    bookButton.onclick = () => publish(null);
    chapterButton.onclick = () => publish(chapterId);
    await refresh();
  }

  hosted.openShare = openShare;
})();
