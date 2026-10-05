/* =================== NEO, HOSTED: HANDWRITING ===================== */
/* The fourth room off the hallway: View → Handwriting… is a pad for  */
/* a stylus, a finger or a mouse. Each page is a sheet of strokes the  */
/* writer drew, kept as the points themselves ([x, y, pressure]) and   */
/* drawn as SVG ribbons whose width follows the pen's pressure, never  */
/* read as text: a note in your own hand stays in your own hand.       */
/*                                                                      */
/* Pages live in handwriting.json beside stickies.json (json:read /    */
/* json:write, the desktop's own channels), so they ride along in      */
/* branches, backups and the zip and need nothing of the server. A     */
/* page can be tied to a chapter, which jumps the page there. Nothing  */
/* here writes into chapter HTML.                                       */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const SIDECAR = 'handwriting';
  const SHEET = { width: 1200, height: 800 };     // the logical sheet; the SVG scales it to the panel
  const SVG = 'http://www.w3.org/2000/svg';
  const INKS = [['ink', '#e8e2d6', '#1c1c1c'], ['gold', '#c9a86a', '#8a6a2a'], ['red', '#d86a5a', '#b5392b'], ['blue', '#6aa0d8', '#2b5fb5']];   // name, on night, on paper
  const WIDTHS = [2, 4, 8];
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const newId = () => 'hw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nameOf = (chId, meta) => {
    try { return (typeof window.chapterName === 'function' && window.chapterName(chId, meta)) || chId; } catch { return chId; }
  };
  const goToChapter = (chId) => { if (typeof window.focusChapter === 'function') window.focusChapter(chId); };
  const when = (iso) => new Date(iso).toLocaleString(hosted.config && hosted.config.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' });
  const light = () => document.body.classList.contains('light');
  const inkColor = (name) => { const ink = INKS.find((i) => i[0] === name) || INKS[0]; return light() ? ink[2] : ink[1]; };
  const MOUSE_PRESSURE = 0.5;                      // what a mouse or an unpressured touch reports; the pen's own value otherwise
  const radiusAt = (width, p) => width / 2 * (0.4 + 1.2 * (p == null ? MOUSE_PRESSURE : p));   // a light touch is thin, a hard press is wide

  /** The outline of a stroke as a filled ribbon: each point pushed out perpendicular to its neighbours, both sides, as one closed path. */
  function ribbonOf(points, width) {
    if (points.length < 2) return '';
    const left = [], right = [];
    for (let i = 0; i < points.length; i++) {
      const [x, y, p] = points[i];
      const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
      let dx = next[0] - prev[0], dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const r = radiusAt(width, p);
      left.push([x - dy * r, y + dx * r]);
      right.push([x + dy * r, y - dx * r]);
    }
    const ring = left.concat(right.reverse());
    return ring.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ') + ' Z';
  }

  let open = null;

  async function openHandwriting() {
    if (open) { open.focus(); return; }
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return; }

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-handwriting';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-handwriting-modal" role="dialog" aria-labelledby="hosted-handwriting-title">
        <div class="mm-head">
          <h2 id="hosted-handwriting-title" style="font-size:16px"></h2>
          <span class="hh-note hw-hint"></span>
        </div>
        <div class="hw-body">
          <div class="hw-side">
            <ul class="hw-pages"></ul>
            <button class="hw-new btn-quiet">${t('New Page')}</button>
          </div>
          <div class="hw-main">
            <div class="mm-toolbar hw-tools">
              <input class="hw-title" type="text">
              <span class="hw-inks"></span>
              <span class="hw-widths"></span>
              <button class="hw-eraser btn-quiet" aria-pressed="false">${t('Eraser')}</button>
              <button class="hw-undo btn-quiet">${t('Undo')}</button>
              <button class="hw-export btn-quiet">${t('Export SVG…')}</button>
              <select class="hw-chapter"></select>
              <button class="hw-go btn-quiet" hidden></button>
              <button class="hw-delete btn-quiet">${t('Delete Page')}</button>
              <span class="mm-spacer"></span>
              <button class="mm-close btn-gold">${t('Close')}</button>
            </div>
            <div class="hw-sheet-wrap">
              <svg class="hw-sheet" xmlns="${SVG}" viewBox="0 0 ${SHEET.width} ${SHEET.height}" preserveAspectRatio="xMidYMid meet"></svg>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Handwriting');
    const hint = bd.querySelector('.hw-hint');
    const pageList = bd.querySelector('.hw-pages');
    const tools = bd.querySelector('.hw-tools');
    const titleInput = bd.querySelector('.hw-title');
    const eraserButton = bd.querySelector('.hw-eraser');
    const chapterSelect = bd.querySelector('.hw-chapter');
    const goButton = bd.querySelector('.hw-go');
    const svg = bd.querySelector('.hw-sheet');
    const exportButton = bd.querySelector('.hw-export');
    titleInput.placeholder = t('Untitled page');
    const idle = () => { hint.textContent = t('Write or draw with a pen, a finger or the mouse. Nothing here is turned into text.'); };
    idle();
    const close = () => { flush(); bd.remove(); open = null; };
    bd.querySelector('.mm-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') { e.stopPropagation(); if (typing) e.target.blur(); else close(); }
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !typing) { e.preventDefault(); undo(); }
    });
    bd.focus();

    let meta = null;
    let data = { pages: [] };
    try {
      [meta, data] = await Promise.all([window.neo.readBookMeta(bookId), window.neo.readJSON(bookId, SIDECAR, data)]);
    } catch (err) {
      hint.textContent = t('Could not load the pages ({error})', { error: String((err && err.message) || err) });
      return;
    }
    if (!data || !Array.isArray(data.pages)) data = { pages: [] };
    const chapters = ((meta && meta.chapterOrder) || []).map((id) => ({ id, name: nameOf(id, meta) }));
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('(no chapter)');
    chapterSelect.appendChild(none);
    for (const ch of chapters) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.name;
      chapterSelect.appendChild(opt);
    }

    // ---- saving ----
    let timer = null;
    let dirty = false;
    const save = async () => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      try { await window.neo.writeJSON(bookId, SIDECAR, data); } catch (err) {
        dirty = true;
        hint.textContent = t('Could not save the pages ({error})', { error: String((err && err.message) || err) });
      }
    };
    const changed = () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 400); };
    const flush = () => { if (timer) { clearTimeout(timer); save(); } };

    // ---- the pen ----
    let ink = 'ink';
    let width = WIDTHS[1];
    let erasing = false;
    const inks = bd.querySelector('.hw-inks');
    const widths = bd.querySelector('.hw-widths');
    const drawTools = () => {
      inks.innerHTML = '';
      for (const [name] of INKS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hw-ink' + (name === ink && !erasing ? ' hw-on' : '');
        b.style.background = inkColor(name);
        b.title = name;
        b.setAttribute('aria-label', name);
        b.onclick = () => { ink = name; erasing = false; drawTools(); };
        inks.appendChild(b);
      }
      widths.innerHTML = '';
      for (const w of WIDTHS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hw-width' + (w === width && !erasing ? ' hw-on' : '');
        b.innerHTML = `<span style="width:${w * 2 + 4}px;height:${w * 2 + 4}px"></span>`;
        b.title = String(w);
        b.setAttribute('aria-label', t('Pen width {n}', { n: w }));
        b.onclick = () => { width = w; erasing = false; drawTools(); };
        widths.appendChild(b);
      }
      eraserButton.setAttribute('aria-pressed', String(erasing));
      eraserButton.classList.toggle('hw-on', erasing);
    };
    eraserButton.onclick = () => { erasing = !erasing; drawTools(); };
    drawTools();

    // ---- pages ----
    let current = null;
    const pageById = (id) => data.pages.find((p) => p.id === id);

    function drawPageList() {
      pageList.innerHTML = '';
      for (const page of data.pages) {
        const li = document.createElement('li');
        li.className = 'hw-page' + (current && current.id === page.id ? ' hh-chosen' : '');
        li.tabIndex = 0;
        li.innerHTML = '<span class="hh-when"></span><span class="hh-words"></span>';
        li.querySelector('.hh-when').textContent = page.title || t('Untitled page');
        li.querySelector('.hh-words').textContent = when(page.createdAt);
        li.onclick = () => show(page.id);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(page.id); } });
        pageList.appendChild(li);
      }
      if (!data.pages.length) {
        const li = document.createElement('li');
        li.className = 'ht-empty';
        li.textContent = t('No pages yet.');
        pageList.appendChild(li);
      }
    }

    /** A stroke as a group: the ribbon, plus a round cap at each end (a lone point is just the cap). */
    function strokeElement(stroke) {
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('fill', inkColor(stroke.ink));
      g.dataset.id = stroke.id;
      g.classList.add('hw-stroke');
      redraw(g, stroke);
      return g;
    }
    function redraw(g, stroke) {
      g.innerHTML = '';
      const pts = stroke.points;
      if (!pts.length) return;
      if (pts.length > 1) {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', ribbonOf(pts, stroke.width));
        g.appendChild(path);
      }
      for (const end of pts.length > 1 ? [pts[0], pts[pts.length - 1]] : [pts[0]]) {
        const cap = document.createElementNS(SVG, 'circle');
        cap.setAttribute('cx', end[0]);
        cap.setAttribute('cy', end[1]);
        cap.setAttribute('r', radiusAt(stroke.width, end[2]).toFixed(1));
        g.appendChild(cap);
      }
    }

    function drawSheet() {
      svg.innerHTML = '';
      if (!current) return;
      for (const stroke of current.strokes) svg.appendChild(strokeElement(stroke));
    }

    function show(id) {
      current = id ? pageById(id) : null;
      tools.classList.toggle('hw-disabled', !current);
      svg.classList.toggle('hw-off', !current);
      titleInput.value = current ? (current.title || '') : '';
      titleInput.disabled = !current;
      chapterSelect.disabled = !current;
      chapterSelect.value = current && chapters.some((c) => c.id === current.chapterId) ? current.chapterId : '';
      const ch = current && chapters.find((c) => c.id === current.chapterId);
      goButton.hidden = !ch;
      if (ch) goButton.textContent = t('Go to {chapter}', { chapter: ch.name });
      drawPageList();
      drawSheet();
    }

    bd.querySelector('.hw-new').onclick = () => {
      const page = { id: newId(), title: '', createdAt: new Date().toISOString(), chapterId: '', strokes: [] };
      data.pages.unshift(page);
      changed();
      show(page.id);
      titleInput.focus();
    };
    titleInput.oninput = () => { if (current) { current.title = titleInput.value; changed(); drawPageList(); } };
    chapterSelect.onchange = () => { if (current) { current.chapterId = chapterSelect.value || ''; changed(); show(current.id); } };
    goButton.onclick = () => { if (current && current.chapterId) { close(); goToChapter(current.chapterId); } };
    bd.querySelector('.hw-delete').onclick = () => {
      if (!current) return;
      if (current.strokes.length && !window.confirm(t('Delete the page "{title}"? Its strokes go with it.', { title: current.title || t('Untitled page') }))) return;
      data.pages = data.pages.filter((p) => p.id !== current.id);
      changed();
      show(data.pages.length ? data.pages[0].id : null);
    };
    const undo = () => { if (current && current.strokes.length) { current.strokes.pop(); changed(); drawSheet(); } };
    bd.querySelector('.hw-undo').onclick = undo;
    exportButton.onclick = () => {
      if (!current) return;
      const copy = svg.cloneNode(true);
      copy.removeAttribute('class');
      copy.setAttribute('width', SHEET.width);
      copy.setAttribute('height', SHEET.height);
      const paper = document.createElementNS(SVG, 'rect');
      paper.setAttribute('width', SHEET.width);
      paper.setAttribute('height', SHEET.height);
      paper.setAttribute('fill', light() ? '#fffdf8' : '#1a1a1a');
      copy.insertBefore(paper, copy.firstChild);
      const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + copy.outerHTML], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ((current.title || t('Untitled page')).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'page') + '.svg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    // ---- drawing: pointer events in sheet coordinates, whatever the panel's size ----
    const toSheet = (e) => {
      const box = svg.getBoundingClientRect();
      const scale = Math.min(box.width / SHEET.width, box.height / SHEET.height);
      const left = box.left + (box.width - SHEET.width * scale) / 2;
      const top = box.top + (box.height - SHEET.height * scale) / 2;
      const pressure = e.pointerType === 'pen' ? Math.min(1, Math.max(0, e.pressure)) : MOUSE_PRESSURE;
      return [Math.round((e.clientX - left) / scale * 10) / 10, Math.round((e.clientY - top) / scale * 10) / 10, Math.round(pressure * 100) / 100];
    };
    let drawing = null;
    svg.addEventListener('pointerdown', (e) => {
      if (!current) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement !== bd && bd.contains(document.activeElement)) document.activeElement.blur();   // drawing leaves the title box, so Escape closes
      bd.focus();
      try { svg.setPointerCapture(e.pointerId); } catch { /* a pointer the browser is not tracking; the stroke still draws */ }
      if (erasing) { eraseAt(e); drawing = { erase: true }; return; }
      const stroke = { id: newId(), ink, width, points: [toSheet(e)] };
      current.strokes.push(stroke);
      const el = strokeElement(stroke);
      svg.appendChild(el);
      drawing = { stroke, el };
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      if (drawing.erase) { eraseAt(e); return; }
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      for (const ev of (events.length ? events : [e])) drawing.stroke.points.push(toSheet(ev));
      redraw(drawing.el, drawing.stroke);
    });
    const endStroke = () => {
      if (!drawing) return;
      drawing = null;
      changed();
    };
    svg.addEventListener('pointerup', endStroke);
    svg.addEventListener('pointercancel', endStroke);
    function eraseAt(e) {
      const [x, y] = toSheet(e);
      const reach = 12;
      const gone = current.strokes.filter((s) => s.points.some((p) => Math.abs(p[0] - x) <= reach && Math.abs(p[1] - y) <= reach));
      if (!gone.length) return;
      current.strokes = current.strokes.filter((s) => !gone.includes(s));
      for (const s of gone) { const el = svg.querySelector(`[data-id="${s.id}"]`); if (el) el.remove(); }
    }

    show(data.pages.length ? data.pages[0].id : null);
  }

  hosted.openHandwriting = openHandwriting;
})();
