/* ====================== NEO, HOSTED: MAP MAP ====================== */
/* The third room off the hallway: View → Map… is a place to draw the  */
/* world. The sheet is an image the writer uploads (a drawn map, a      */
/* photograph of a napkin) or blank; pins go where things are, each    */
/* with a label, a note and the chapter it belongs to, and a pin's      */
/* chapter jumps the page there.                                        */
/*                                                                      */
/* Pins live in maps.json beside darlings.json (json:read / json:write, */
/* the desktop's own channels) as fractions of the sheet, so the sheet  */
/* can be swapped for a larger scan and the pins stay put. The image    */
/* is map-<ts>.<ext> beside the cover, uploaded raw like a cover and    */
/* served from /library/<book>/<file>. Never touches chapter HTML.      */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const SIDECAR = 'maps';
  const BLANK = { width: 1600, height: 1000 };
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const newId = () => 'pin-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nameOf = (chId, meta) => {
    try { return (typeof window.chapterName === 'function' && window.chapterName(chId, meta)) || chId; } catch { return chId; }
  };
  const goToChapter = (chId) => { if (typeof window.focusChapter === 'function') window.focusChapter(chId); };
  const clamp = (v) => Math.max(0, Math.min(1, v));

  let open = null;

  async function openMap() {
    if (open) { open.focus(); return; }
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return; }

    const bd = document.createElement('div');
    bd.className = 'modal-backdrop hosted-map';
    bd.tabIndex = -1;
    bd.innerHTML = `
      <div class="modal hosted-map-modal" role="dialog" aria-labelledby="hosted-map-title">
        <div class="mm-head">
          <h2 id="hosted-map-title" style="font-size:16px"></h2>
          <span class="hh-note mp-hint"></span>
        </div>
        <div class="mm-toolbar">
          <button class="mp-image btn-quiet">${t('Choose Image…')}</button>
          <button class="mp-remove-image btn-quiet" hidden>${t('Remove Image')}</button>
          <input class="mp-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
          <span class="mm-spacer"></span>
          <button class="mm-close btn-gold">${t('Close')}</button>
        </div>
        <div class="mp-body">
          <div class="mp-sheet-wrap" tabindex="0">
            <div class="mp-sheet"></div>
          </div>
          <div class="mp-inspector" hidden>
            <label>${t('Label')}<input class="mp-label" type="text"></label>
            <label>${t('Chapter')}<select class="mp-chapter"></select></label>
            <label>${t('Note')}<textarea class="mp-note" rows="5"></textarea></label>
            <div class="hs-row">
              <button class="mp-go btn-quiet" hidden></button>
              <button class="mp-delete btn-quiet">${t('Remove Pin')}</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Map');
    const hint = bd.querySelector('.mp-hint');
    const wrap = bd.querySelector('.mp-sheet-wrap');
    const sheet = bd.querySelector('.mp-sheet');
    const fileInput = bd.querySelector('.mp-file');
    const removeImageButton = bd.querySelector('.mp-remove-image');
    const inspector = bd.querySelector('.mp-inspector');
    const labelInput = bd.querySelector('.mp-label');
    const chapterSelect = bd.querySelector('.mp-chapter');
    const noteInput = bd.querySelector('.mp-note');
    const goButton = bd.querySelector('.mp-go');
    const idle = () => { hint.textContent = t('Double-click the sheet to drop a pin; drag a pin to move it.'); };
    idle();
    const close = () => { flush(); bd.remove(); open = null; };
    bd.querySelector('.mm-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.focus();

    let meta = null;
    let data = { image: '', pins: [] };
    try {
      [meta, data] = await Promise.all([window.neo.readBookMeta(bookId), window.neo.readJSON(bookId, SIDECAR, data)]);
    } catch (err) {
      hint.textContent = t('Could not load the map ({error})', { error: String((err && err.message) || err) });
      return;
    }
    if (!data || !Array.isArray(data.pins)) data = { image: '', pins: [] };
    data.image = data.image || '';
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
        hint.textContent = t('Could not save the map ({error})', { error: String((err && err.message) || err) });
      }
    };
    const changed = () => { dirty = true; clearTimeout(timer); timer = setTimeout(save, 400); };
    const flush = () => { if (timer) { clearTimeout(timer); save(); } };

    // ---- the sheet: the image at its own size, or a blank one ----
    function drawSheet() {
      sheet.innerHTML = '';
      sheet.classList.toggle('mp-blank', !data.image);
      removeImageButton.hidden = !data.image;
      if (data.image) {
        const img = document.createElement('img');
        img.className = 'mp-img';
        img.src = `/library/${encodeURIComponent(bookId)}/${encodeURIComponent(data.image)}`;
        img.alt = '';
        img.draggable = false;
        sheet.style.width = '';
        sheet.style.height = '';
        sheet.appendChild(img);
      } else {
        sheet.style.width = BLANK.width + 'px';
        sheet.style.height = BLANK.height + 'px';
      }
      for (const pin of data.pins) placePin(pin);
    }

    // ---- pins ----
    let selected = null;
    const pinElements = new Map();
    const pinById = (id) => data.pins.find((p) => p.id === id);

    function select(id) {
      selected = id;
      for (const [pid, el] of pinElements) el.classList.toggle('mp-selected', pid === id);
      const pin = id ? pinById(id) : null;
      inspector.hidden = !pin;
      if (!pin) return;
      labelInput.value = pin.label || '';
      noteInput.value = pin.note || '';
      chapterSelect.value = chapters.some((c) => c.id === pin.chapterId) ? pin.chapterId : '';
      const ch = chapters.find((c) => c.id === pin.chapterId);
      goButton.hidden = !ch;
      if (ch) goButton.textContent = t('Go to {chapter}', { chapter: ch.name });
    }

    function placePin(pin) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'mp-pin';
      el.style.left = (pin.x * 100) + '%';
      el.style.top = (pin.y * 100) + '%';
      el.innerHTML = '<span class="mp-pin-dot"></span><span class="mp-pin-label"></span>';
      el.querySelector('.mp-pin-label').textContent = pin.label || '';
      sheet.appendChild(el);
      pinElements.set(pin.id, el);
      let drag = null;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        select(pin.id);
        drag = { moved: false };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const box = sheet.getBoundingClientRect();
        pin.x = clamp((e.clientX - box.left) / box.width);
        pin.y = clamp((e.clientY - box.top) / box.height);
        drag.moved = true;
        el.style.left = (pin.x * 100) + '%';
        el.style.top = (pin.y * 100) + '%';
      });
      const endDrag = () => { if (drag && drag.moved) changed(); drag = null; };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      el.addEventListener('dblclick', (e) => e.stopPropagation());
      return el;
    }

    sheet.addEventListener('dblclick', (e) => {
      const box = sheet.getBoundingClientRect();
      const pin = { id: newId(), x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height), label: '', note: '', chapterId: '' };
      data.pins.push(pin);
      placePin(pin);
      changed();
      select(pin.id);
      labelInput.focus();
    });
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap || e.target === sheet || e.target.classList.contains('mp-img')) select(null); });

    // ---- the inspector ----
    const syncLabel = () => { const el = pinElements.get(selected); if (el) el.querySelector('.mp-pin-label').textContent = labelInput.value; };
    labelInput.oninput = () => { const pin = pinById(selected); if (pin) { pin.label = labelInput.value; syncLabel(); changed(); } };
    noteInput.oninput = () => { const pin = pinById(selected); if (pin) { pin.note = noteInput.value; changed(); } };
    chapterSelect.onchange = () => { const pin = pinById(selected); if (pin) { pin.chapterId = chapterSelect.value || ''; changed(); select(pin.id); } };
    goButton.onclick = () => { const pin = pinById(selected); if (pin && pin.chapterId) { close(); goToChapter(pin.chapterId); } };
    const removeSelected = () => {
      const pin = pinById(selected);
      if (!pin) return;
      if ((pin.label || pin.note) && !window.confirm(t('Remove the pin "{label}"?', { label: pin.label || pin.note.slice(0, 40) }))) return;
      data.pins = data.pins.filter((p) => p.id !== pin.id);
      pinElements.get(pin.id).remove();
      pinElements.delete(pin.id);
      changed();
      select(null);
    };
    bd.querySelector('.mp-delete').onclick = removeSelected;
    bd.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') { e.stopPropagation(); if (typing) e.target.blur(); else close(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) { e.preventDefault(); removeSelected(); }
    });

    // ---- the image ----
    bd.querySelector('.mp-image').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      hint.textContent = t('Uploading…');
      try {
        const fname = await window.neo.uploadMapImage(bookId, file);
        if (!fname) throw new Error(t('Images are PNG, JPEG or WebP'));
        data.image = fname;
        changed();
        pinElements.clear();
        drawSheet();
        select(selected);
        idle();
      } catch (err) {
        hint.textContent = String((err && err.message) || err);
      }
    };
    removeImageButton.onclick = async () => {
      if (!window.confirm(t('Remove the image? The pins stay where they are on a blank sheet.'))) return;
      try {
        await window.neo.removeMapImage(bookId);
        data.image = '';
        changed();
        pinElements.clear();
        drawSheet();
        select(selected);
      } catch (err) {
        hint.textContent = String((err && err.message) || err);
      }
    };

    drawSheet();
    wrap.focus();
  }

  hosted.openMap = openMap;
})();
