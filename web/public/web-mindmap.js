/* ===================== NEO, HOSTED: MIND MAP ====================== */
/* The second room off the hallway: View → Mind Map… opens a canvas of */
/* nodes the writer drags into place, links to one another, and ties  */
/* to chapters; a tied node jumps the page to its chapter. The map is  */
/* a sidecar, mindmap.json beside darlings.json, read and written      */
/* through the desktop's own json:read / json:write channels, so it    */
/* rides along in branches, backups and the zip and needs nothing of   */
/* the server. It never writes into chapter HTML.                      */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const SIDECAR = 'mindmap';
  const CANVAS = { width: 2400, height: 1600 };
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const newId = () => 'n-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nameOf = (chId, meta) => {
    try { return (typeof window.chapterName === 'function' && window.chapterName(chId, meta)) || chId; } catch { return chId; }
  };
  const goToChapter = (chId) => { if (typeof window.focusChapter === 'function') window.focusChapter(chId); };
  const SVG = 'http://www.w3.org/2000/svg';

  let open = null;

  async function openMindMap() {
    if (open) { open.focus(); return; }
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return; }

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-mindmap';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-mindmap-modal" role="dialog" aria-labelledby="hosted-mindmap-title">
        <div class="mm-head">
          <h2 id="hosted-mindmap-title" style="font-size:16px"></h2>
          <span class="hh-note mm-hint"></span>
        </div>
        <div class="mm-toolbar">
          <button class="mm-add btn-quiet">${t('Add Node')}</button>
          <button class="mm-link btn-quiet" disabled>${t('Link')}</button>
          <select class="mm-chapter" disabled></select>
          <button class="mm-go btn-quiet" hidden></button>
          <button class="mm-delete btn-quiet" disabled>${t('Delete')}</button>
          <span class="mm-zoom">
            <button class="mm-zoom-out btn-quiet" aria-label="${t('Zoom out')}">−</button>
            <button class="mm-zoom-reset btn-quiet" aria-label="${t('Actual size')}">100%</button>
            <button class="mm-zoom-in btn-quiet" aria-label="${t('Zoom in')}">+</button>
          </span>
          <span class="mm-spacer"></span>
          <button class="mm-close btn-gold">${t('Close')}</button>
        </div>
        <div class="mm-canvas" tabindex="0">
          <div class="mm-sheet">
            <svg class="mm-links" xmlns="${SVG}" width="${CANVAS.width}" height="${CANVAS.height}"></svg>
          </div>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Mind Map');
    const hint = bd.querySelector('.mm-hint');
    const canvas = bd.querySelector('.mm-canvas');
    const sheet = bd.querySelector('.mm-sheet');
    const svg = bd.querySelector('.mm-links');
    const linkButton = bd.querySelector('.mm-link');
    const chapterSelect = bd.querySelector('.mm-chapter');
    const goButton = bd.querySelector('.mm-go');
    const deleteButton = bd.querySelector('.mm-delete');
    sheet.style.width = CANVAS.width + 'px';
    sheet.style.height = CANVAS.height + 'px';

    // ---- zoom: the sheet is scaled as a whole; node positions stay in sheet pixels ----
    const ZOOM = { min: 0.4, max: 2, step: 1.2 };
    let zoom = 1;
    const zoomLabel = bd.querySelector('.mm-zoom-reset');
    /** Scales the sheet about a point of the canvas (its centre by default), keeping that point under the pointer. */
    function setZoom(next, at) {
      const z = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(next * 100) / 100));
      const px = at ? at.x : canvas.clientWidth / 2, py = at ? at.y : canvas.clientHeight / 2;
      const sx = (canvas.scrollLeft + px) / zoom, sy = (canvas.scrollTop + py) / zoom;   // the sheet point under that spot
      zoom = z;
      sheet.style.transform = `scale(${zoom})`;
      canvas.style.setProperty('--mm-w', CANVAS.width * zoom + 'px');
      canvas.style.setProperty('--mm-h', CANVAS.height * zoom + 'px');
      canvas.scrollLeft = sx * zoom - px;
      canvas.scrollTop = sy * zoom - py;
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }
    /** A pointer's place in sheet pixels, whatever the zoom and scroll. */
    const onSheet = (e) => { const r = sheet.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
    bd.querySelector('.mm-zoom-in').onclick = () => setZoom(zoom * ZOOM.step);
    bd.querySelector('.mm-zoom-out').onclick = () => setZoom(zoom / ZOOM.step);
    zoomLabel.onclick = () => setZoom(1);
    canvas.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;   // a plain wheel scrolls, as everywhere; pinch on a trackpad arrives as ctrl+wheel
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step), { x: e.clientX - r.left, y: e.clientY - r.top });
    }, { passive: false });
    setZoom(1);
    const idle = () => { hint.textContent = t('Double-click the canvas for a node, drag to move, double-click a node to rename.'); };
    idle();
    const close = () => { flush(); bd.remove(); open = null; };
    bd.querySelector('.mm-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.focus();

    let meta = null;
    let data = { nodes: [], links: [] };
    try {
      [meta, data] = await Promise.all([window.neo.readBookMeta(bookId), window.neo.readJSON(bookId, SIDECAR, data)]);
    } catch (err) {
      hint.textContent = t('Could not load the mind map ({error})', { error: String((err && err.message) || err) });
      return;
    }
    if (!data || !Array.isArray(data.nodes)) data = { nodes: [], links: [] };
    if (!Array.isArray(data.links)) data.links = [];
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
        hint.textContent = t('Could not save the mind map ({error})', { error: String((err && err.message) || err) });
      }
    };
    const changed = () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 400); };
    const flush = () => { if (timer) { clearTimeout(timer); save(); } };

    // ---- state ----
    let selected = null;      // a node id
    let linking = false;      // the next node clicked gets linked to the selected one
    const elements = new Map();
    const nodeById = (id) => data.nodes.find((n) => n.id === id);
    const linked = (a, b) => data.links.findIndex((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));

    function drawLinks() {
      svg.innerHTML = '';
      for (const link of data.links) {
        const a = elements.get(link.from);
        const b = elements.get(link.to);
        if (!a || !b) continue;
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', a.offsetLeft + a.offsetWidth / 2);
        line.setAttribute('y1', a.offsetTop + a.offsetHeight / 2);
        line.setAttribute('x2', b.offsetLeft + b.offsetWidth / 2);
        line.setAttribute('y2', b.offsetTop + b.offsetHeight / 2);
        line.setAttribute('class', 'mm-line');
        svg.appendChild(line);
      }
    }

    function select(id) {
      selected = id;
      linking = false;
      for (const [nid, el] of elements) el.classList.toggle('mm-selected', nid === id);
      const node = id ? nodeById(id) : null;
      linkButton.disabled = !node;
      deleteButton.disabled = !node;
      chapterSelect.disabled = !node;
      chapterSelect.value = node && chapters.some((c) => c.id === node.chapterId) ? node.chapterId : '';
      const ch = node && chapters.find((c) => c.id === node.chapterId);
      goButton.hidden = !ch;
      if (ch) goButton.textContent = t('Go to {chapter}', { chapter: ch.name });
      idle();
    }

    function caption(node, el) {
      const ch = chapters.find((c) => c.id === node.chapterId);
      el.querySelector('.mm-caption').textContent = ch ? ch.name : '';
      el.classList.toggle('mm-tied', !!ch);
    }

    function rename(node, el) {
      const label = el.querySelector('.mm-text');
      const input = document.createElement('input');
      input.className = 'mm-edit';
      input.value = node.text || '';
      label.replaceWith(input);
      input.focus();
      input.select();
      const done = () => {
        node.text = input.value.trim();
        const span = document.createElement('span');
        span.className = 'mm-text';
        span.textContent = node.text || t('(untitled)');
        input.replaceWith(span);
        changed();
        drawLinks();
      };
      input.addEventListener('blur', done);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); input.blur(); } e.stopPropagation(); });
    }

    function place(node) {
      const el = document.createElement('div');
      el.className = 'mm-node';
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      el.innerHTML = '<span class="mm-text"></span><span class="mm-caption"></span>';
      el.querySelector('.mm-text').textContent = node.text || t('(untitled)');
      caption(node, el);
      sheet.appendChild(el);
      elements.set(node.id, el);

      let drag = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('mm-edit')) return;
        e.preventDefault();
        if (linking && selected && selected !== node.id) {
          const i = linked(selected, node.id);
          if (i >= 0) data.links.splice(i, 1); else data.links.push({ from: selected, to: node.id });
          changed();
          select(selected);
          drawLinks();
          return;
        }
        if (e.shiftKey && selected && selected !== node.id) {
          if (linked(selected, node.id) < 0) { data.links.push({ from: selected, to: node.id }); changed(); drawLinks(); }
          return;
        }
        select(node.id);
        const at = onSheet(e);
        drag = { dx: at.x - node.x, dy: at.y - node.y, moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const at = onSheet(e);
        node.x = Math.max(0, Math.min(CANVAS.width - el.offsetWidth, Math.round(at.x - drag.dx)));
        node.y = Math.max(0, Math.min(CANVAS.height - el.offsetHeight, Math.round(at.y - drag.dy)));
        drag.moved = true;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        drawLinks();
      });
      const endDrag = () => { if (drag && drag.moved) changed(); drag = null; };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); rename(node, el); });
      return el;
    }

    function addNode(x, y) {
      const node = { id: newId(), text: '', x: Math.round(x), y: Math.round(y), chapterId: '' };
      data.nodes.push(node);
      const el = place(node);
      changed();
      select(node.id);
      rename(node, el);
    }

    // ---- the toolbar ----
    bd.querySelector('.mm-add').onclick = () => addNode((canvas.scrollLeft + canvas.clientWidth / 2) / zoom - 60, (canvas.scrollTop + canvas.clientHeight / 2) / zoom - 20);
    linkButton.onclick = () => { linking = !linking; hint.textContent = linking ? t('Now click the node to link it to (again to unlink). Esc cancels.') : ''; if (!linking) idle(); };
    chapterSelect.onchange = () => {
      const node = nodeById(selected);
      if (!node) return;
      node.chapterId = chapterSelect.value || '';
      caption(node, elements.get(node.id));
      changed();
      select(node.id);
    };
    goButton.onclick = () => { const node = nodeById(selected); if (node && node.chapterId) { close(); goToChapter(node.chapterId); } };
    const removeSelected = () => {
      const node = nodeById(selected);
      if (!node) return;
      data.nodes = data.nodes.filter((n) => n.id !== node.id);
      data.links = data.links.filter((l) => l.from !== node.id && l.to !== node.id);
      elements.get(node.id).remove();
      elements.delete(node.id);
      changed();
      select(null);
      drawLinks();
    };
    deleteButton.onclick = removeSelected;
    canvas.addEventListener('dblclick', (e) => { if (e.target === canvas || e.target === sheet || e.target === svg) { const at = onSheet(e); addNode(at.x - 60, at.y - 20); } });
    canvas.addEventListener('pointerdown', (e) => { if (e.target === canvas || e.target === svg) select(null); });
    bd.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('mm-edit')) return;
      if (e.key === 'Escape') { e.stopPropagation(); if (linking) { linking = false; idle(); } else close(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeSelected(); }
    });

    // ---- draw what was saved, with the view on the nodes ----
    for (const node of data.nodes) place(node);
    drawLinks();
    if (data.nodes.length) {
      const minX = Math.min(...data.nodes.map((n) => n.x));
      const minY = Math.min(...data.nodes.map((n) => n.y));
      canvas.scrollTo(Math.max(0, minX - 40), Math.max(0, minY - 40));
    } else {
      canvas.scrollTo(CANVAS.width / 2 - canvas.clientWidth / 2, CANVAS.height / 2 - canvas.clientHeight / 2);
    }
    canvas.focus();
  }

  hosted.openMindMap = openMindMap;
})();
