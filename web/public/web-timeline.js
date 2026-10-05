/* ===================== NEO, HOSTED: TIMELINE ====================== */
/* The first room off the hallway: View → Timeline… opens a panel of   */
/* the book's events in story order, each with a story-time ("Spring,  */
/* year 3", "Day 12"), a title, and the chapter it happens in. Events   */
/* are dragged (or nudged) into order; a chapter name jumps to it.      */
/*                                                                      */
/* The timeline is a sidecar, timeline.json beside darlings.json, read  */
/* and written through the json:read / json:write channels the desktop */
/* already has, so it rides along in branches, backups and the zip and */
/* needs nothing of the server. It never writes into chapter HTML.      */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const SIDECAR = 'timeline';
  const EMPTY = { events: [] };
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const newId = () => 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** The chapter's name as the editor shows it (chapterName is app.js's), else its id. */
  const nameOf = (chId, meta) => {
    try { return (typeof window.chapterName === 'function' && window.chapterName(chId, meta)) || chId; } catch { return chId; }
  };

  /** Jumps the page to a chapter; focusChapter is app.js's and lands the caret at its end. */
  function goToChapter(chId) {
    if (typeof window.focusChapter === 'function') window.focusChapter(chId);
  }

  let open = null;

  async function openTimeline() {
    if (open) { open.focus(); return; }
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return; }

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-timeline';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-timeline-modal" role="dialog" aria-labelledby="hosted-timeline-title">
        <h2 id="hosted-timeline-title" style="font-size:16px"></h2>
        <p class="hs-lead"></p>
        <ol class="ht-list"></ol>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="ht-add btn-quiet">${t('Add Event')}</button>
          <button class="ht-close btn-gold">${t('Close')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Timeline');
    bd.querySelector('.hs-lead').textContent = t('The story in the order it happens. Give each event a time in the story and the chapter it is told in; drag events to reorder them.');
    const list = bd.querySelector('.ht-list');
    const note = bd.querySelector('.hh-note');
    const close = () => { flush(); bd.remove(); open = null; };
    bd.querySelector('.ht-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    bd.focus();

    let meta = null;
    let data = EMPTY;
    try {
      [meta, data] = await Promise.all([window.neo.readBookMeta(bookId), window.neo.readJSON(bookId, SIDECAR, EMPTY)]);
    } catch (err) {
      note.textContent = t('Could not load the timeline ({error})', { error: String((err && err.message) || err) });
      return;
    }
    if (!data || !Array.isArray(data.events)) data = { events: [] };
    const chapters = ((meta && meta.chapterOrder) || []).map((id) => ({ id, name: nameOf(id, meta) }));

    // ---- saving: every change is written, a breath after the last keystroke ----
    let timer = null;
    let dirty = false;
    const save = async () => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      try {
        await window.neo.writeJSON(bookId, SIDECAR, data);
        note.textContent = '';
      } catch (err) {
        dirty = true;
        note.textContent = t('Could not save the timeline ({error})', { error: String((err && err.message) || err) });
      }
    };
    const changed = () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 400); };
    const flush = () => { if (timer) { clearTimeout(timer); save(); } };

    // ---- drawing ----
    const move = (from, to) => {
      if (to < 0 || to >= data.events.length || from === to) return;
      const [event] = data.events.splice(from, 1);
      data.events.splice(to, 0, event);
      changed();
      draw();
    };
    let dragging = -1;

    function row(event, index) {
      const li = document.createElement('li');
      li.className = 'ht-event';
      li.draggable = true;
      li.innerHTML = `
        <span class="ht-dot" aria-hidden="true"></span>
        <div class="ht-fields">
          <input class="ht-when" type="text">
          <input class="ht-title" type="text">
          <select class="ht-chapter"></select>
        </div>
        <div class="ht-tools">
          <button class="ht-up btn-quiet" title="${t('Move up')}" aria-label="${t('Move up')}">↑</button>
          <button class="ht-down btn-quiet" title="${t('Move down')}" aria-label="${t('Move down')}">↓</button>
          <button class="ht-go btn-quiet" hidden></button>
          <button class="ht-remove btn-quiet" title="${t('Remove')}" aria-label="${t('Remove')}">×</button>
        </div>`;
      const when = li.querySelector('.ht-when');
      const title = li.querySelector('.ht-title');
      const chapter = li.querySelector('.ht-chapter');
      const go = li.querySelector('.ht-go');
      when.placeholder = t('When in the story');
      when.value = event.when || '';
      title.placeholder = t('What happens');
      title.value = event.title || '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = t('(no chapter)');
      chapter.appendChild(none);
      for (const ch of chapters) {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = ch.name;
        chapter.appendChild(opt);
      }
      chapter.value = chapters.some((ch) => ch.id === event.chapterId) ? event.chapterId : '';
      const showGo = () => {
        const ch = chapters.find((c) => c.id === chapter.value);
        go.hidden = !ch;
        if (ch) go.textContent = t('Go to {chapter}', { chapter: ch.name });
      };
      showGo();
      when.oninput = () => { event.when = when.value; changed(); };
      title.oninput = () => { event.title = title.value; changed(); };
      chapter.onchange = () => { event.chapterId = chapter.value || ''; showGo(); changed(); };
      go.onclick = () => { close(); goToChapter(chapter.value); };
      li.querySelector('.ht-up').onclick = () => move(index, index - 1);
      li.querySelector('.ht-down').onclick = () => move(index, index + 1);
      li.querySelector('.ht-remove').onclick = () => {
        if (!event.title && !event.when) { data.events.splice(index, 1); changed(); draw(); return; }
        if (window.confirm(t('Remove "{title}" from the timeline? The chapter itself is untouched.', { title: event.title || event.when }))) { data.events.splice(index, 1); changed(); draw(); }
      };
      li.addEventListener('dragstart', (e) => { dragging = index; e.dataTransfer.effectAllowed = 'move'; li.classList.add('ht-dragging'); });
      li.addEventListener('dragend', () => { dragging = -1; li.classList.remove('ht-dragging'); });
      li.addEventListener('dragover', (e) => { if (dragging >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
      li.addEventListener('drop', (e) => { e.preventDefault(); if (dragging >= 0) move(dragging, index); });
      return li;
    }

    function draw() {
      list.innerHTML = '';
      data.events.forEach((event, i) => list.appendChild(row(event, i)));
      if (!data.events.length) {
        const li = document.createElement('li');
        li.className = 'ht-empty';
        li.textContent = t('No events yet. Add the first one below.');
        list.appendChild(li);
      }
    }

    bd.querySelector('.ht-add').onclick = () => {
      data.events.push({ id: newId(), when: '', title: '', chapterId: '' });
      changed();
      draw();
      const last = list.querySelector('.ht-event:last-child .ht-when');
      if (last) last.focus();
    };
    draw();
  }

  hosted.openTimeline = openTimeline;
})();
