/* ===================== NEO, HOSTED: TIMELINE ====================== */
/* The first room off the hallway: View → Timeline… opens a panel of   */
/* the book's events in story order, each with a story-time ("Spring,  */
/* year 3", "Day 12"), a title, the place it happens, the characters   */
/* who are there and the chapter it is told in. Above the list a chart */
/* draws the same events as swimlanes, one lane per place, story order */
/* left to right, and a line per character joining the events they are */
/* in, so a character's path through time and space is one stroke.     */
/* A place is whatever the writer needs it to be: a town, a room, a    */
/* year, a world; a lane is a lane.                                    */
/*                                                                      */
/* The timeline is a sidecar, timeline.json beside darlings.json, read  */
/* and written through the json:read / json:write channels the desktop */
/* already has, so it rides along in branches, backups and the zip and */
/* needs nothing of the server. It never writes into chapter HTML.      */
/*                                                                      */
/* The file: { lanes: [{ id, name, color }], characters: [{ id, name,   */
/* color }], sheets: [{ id, name, color }], events: [{ id, when, title, */
/* chapterId, endChapterId, laneId, characterIds, sheetId }] }. Older   */
/* files carry only events; a missing laneId draws in the "(no place)"  */
/* lane, a missing sheetId is the main sheet, and an endChapterId says  */
/* the event is told across chapters (a siege over four of them). Story order is the array order;   */
/* the "when" is text the writer reads, never parsed, so a story can    */
/* run backwards, sideways or twice.                                    */
/*                                                                      */
/* A sheet of time is an alternate timeline the story keeps beside the  */
/* main one: a split world, a second frame of reference, the loop that  */
/* went the other way. The chart shows one sheet at a time (tabs above  */
/* it); a character whose next or previous event is on another sheet   */
/* gets a marker at the jump, naming the sheet they came from or went   */
/* to, so a crossing is visible from either side.                       */
/*                                                                      */
/* Print Chart… makes a sheet of the same chart for paper: every sheet  */
/* of time, cut into page-wide segments (the lane names repeated at the */
/* left of each, a character's stroke running on to the edge), with the */
/* events listed under it; it goes to the printer as a sheet of its own */
/* size (landscape) or, without one, to the browser's print view.       */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const SIDECAR = 'timeline';
  const EMPTY = { lanes: [], characters: [], sheets: [], events: [] };
  const PALETTE = ['#c9a86a', '#5fb3d9', '#8fd17a', '#e07a7a', '#c58fe0', '#f0a35e', '#6ad1c4', '#d9d9d9'];
  const CHART = { laneLeft: 24, column: 120, row: 72, top: 30, bottom: 26, labelChars: 18 };
  /** the printed chart: a gutter for the lane names at the left of each segment, and how many events a segment holds */
  const PRINT = { gutter: 130, perPage: 8 };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const say = (msg) => { if (typeof window.toast === 'function') window.toast(msg); };
  const newId = (prefix) => prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** The chapter's name as the editor shows it (chapterName is app.js's), else its id. */
  const nameOf = (chId, meta) => {
    try { return (typeof window.chapterName === 'function' && window.chapterName(chId, meta)) || chId; } catch { return chId; }
  };

  /** Jumps the page to a chapter; focusChapter is app.js's and lands the caret at its end. */
  function goToChapter(chId) {
    if (typeof window.focusChapter === 'function') window.focusChapter(chId);
  }

  /** Older timeline.json files have only events; every field the chart needs gets a default. */
  function normalise(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => x && typeof x === 'object') : []);
    return {
      lanes: list(data.lanes).map((l, i) => ({ id: l.id || newId('ln'), name: l.name || '', color: l.color || PALETTE[i % PALETTE.length] })),
      characters: list(data.characters).map((c, i) => ({ id: c.id || newId('ch'), name: c.name || '', color: c.color || PALETTE[(i + 1) % PALETTE.length] })),
      sheets: list(data.sheets).map((sh, i) => ({ id: sh.id || newId('sh'), name: sh.name || '', color: sh.color || PALETTE[(i + 2) % PALETTE.length] })),
      events: list(data.events).map((e) => ({
        id: e.id || newId('ev'), when: e.when || '', title: e.title || '', chapterId: e.chapterId || '', endChapterId: e.endChapterId || '',
        laneId: e.laneId || '', characterIds: Array.isArray(e.characterIds) ? e.characterIds.filter((id) => typeof id === 'string') : [], sheetId: e.sheetId || '',
      })),
    };
  }

  const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  /** A smooth path through the points, in order; a character's stroke across the lanes. */
  function pathThrough(points) {
    if (!points.length) return '';
    let d = 'M' + points[0].x + ' ' + points[0].y;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const mid = (a.x + b.x) / 2;
      d += ' C' + mid + ' ' + a.y + ' ' + mid + ' ' + b.y + ' ' + b.x + ' ' + b.y;
    }
    return d;
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
        <div class="ht-sets">
          <div class="ht-set ht-lanes"><span class="ht-set-label"></span><span class="ht-chips"></span><button class="ht-add-lane btn-quiet"></button></div>
          <div class="ht-set ht-chars"><span class="ht-set-label"></span><span class="ht-chips"></span><button class="ht-add-char btn-quiet"></button></div>
          <div class="ht-set ht-sheets"><span class="ht-set-label"></span><span class="ht-chips"></span><button class="ht-add-sheet btn-quiet"></button></div>
        </div>
        <div class="ht-sheet-tabs" role="tablist" hidden></div>
        <div class="ht-chart" hidden>
          <div class="ht-lane-names"></div>
          <div class="ht-chart-scroll"><svg class="ht-svg" aria-hidden="true"></svg></div>
        </div>
        <ol class="ht-list"></ol>
        <div class="hh-actions">
          <span class="hh-note"></span>
          <button class="ht-add btn-quiet">${t('Add Event')}</button>
          <button class="ht-print btn-quiet" hidden>${t('Print Chart…')}</button>
          <button class="ht-close btn-gold">${t('Close')}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    open = bd;
    bd.querySelector('h2').textContent = t('Timeline');
    bd.querySelector('.hs-lead').textContent = t('The story in the order it happens. Each event has a time in the story, a place and the characters who are there; the chart draws one lane per place and a line per character across them. A sheet of time is an alternate timeline beside the main one. Drag events to reorder them.');
    bd.querySelector('.ht-lanes .ht-set-label').textContent = t('Places');
    bd.querySelector('.ht-chars .ht-set-label').textContent = t('Characters');
    bd.querySelector('.ht-add-lane').textContent = t('Add Place');
    bd.querySelector('.ht-add-char').textContent = t('Add Character');
    bd.querySelector('.ht-sheets .ht-set-label').textContent = t('Sheets of time');
    bd.querySelector('.ht-add-sheet').textContent = t('Add Sheet');
    const tabs = bd.querySelector('.ht-sheet-tabs');
    let activeSheet = ''; // '' is the main sheet; the tabs switch it, the chart draws it, a new event lands on it
    const list = bd.querySelector('.ht-list');
    const note = bd.querySelector('.hh-note');
    const chart = bd.querySelector('.ht-chart');
    const laneNames = bd.querySelector('.ht-lane-names');
    const svg = bd.querySelector('.ht-svg');
    const printBtn = bd.querySelector('.ht-print');
    const close = () => { flush(); bd.remove(); open = null; delete hosted.timelinePrintDocument; };
    bd.querySelector('.ht-close').onclick = close;
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const typing = e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (typing) { e.target.blur(); bd.focus(); } else close();
    });
    bd.focus();

    let meta = null;
    let data = EMPTY;
    try {
      [meta, data] = await Promise.all([window.neo.readBookMeta(bookId), window.neo.readJSON(bookId, SIDECAR, EMPTY)]);
    } catch (err) {
      note.textContent = t('Could not load the timeline ({error})', { error: String((err && err.message) || err) });
      return;
    }
    data = normalise(data);
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

    // ---- places and characters: a chip each, with a colour swatch and a name ----
    const laneOf = (id) => data.lanes.find((l) => l.id === id);
    const sheetOf = (id) => data.sheets.find((sh) => sh.id === id);
    const sheetNameOf = (id) => { const sh = sheetOf(id); return sh ? (sh.name || t('(unnamed)')) : t('Main sheet'); };
    const chapterIndex = (id) => chapters.findIndex((c) => c.id === id);
    /** The chapter an event runs on to, when it has one after its own; a stale or earlier end is ignored. */
    const spanEnd = (event) => {
      const from = chapterIndex(event.chapterId);
      const to = chapterIndex(event.endChapterId);
      return from >= 0 && to > from ? chapters[to] : null;
    };
    const chapterSpanText = (event) => {
      const start = chapters.find((c) => c.id === event.chapterId);
      const end = spanEnd(event);
      return start ? (end ? start.name + ' → ' + end.name : start.name) : '';
    };
    const charOf = (id) => data.characters.find((c) => c.id === id);
    const nextColor = (set) => PALETTE[set.length % PALETTE.length];
    const cycleColor = (item) => { item.color = PALETTE[(PALETTE.indexOf(item.color) + 1) % PALETTE.length]; };

    function chip(item, onName, onColor, onRemove, placeholder) {
      const el = document.createElement('span');
      el.className = 'ht-chip';
      el.innerHTML = `<button class="ht-swatch" title="${t('Change color')}" aria-label="${t('Change color')}"></button><input class="ht-chip-name" type="text"><button class="ht-chip-x btn-quiet" title="${t('Remove')}" aria-label="${t('Remove')}">×</button>`;
      const swatch = el.querySelector('.ht-swatch');
      const name = el.querySelector('.ht-chip-name');
      swatch.style.background = item.color;
      name.value = item.name;
      name.placeholder = placeholder;
      name.oninput = () => { item.name = name.value; onName(); changed(); };
      swatch.onclick = () => { cycleColor(item); swatch.style.background = item.color; onColor(); changed(); };
      el.querySelector('.ht-chip-x').onclick = onRemove;
      return el;
    }

    function drawSets() {
      const lanes = bd.querySelector('.ht-lanes .ht-chips');
      lanes.innerHTML = '';
      for (const lane of data.lanes) {
        lanes.appendChild(chip(lane, () => { renameLane(lane); drawChart(); }, drawChart, () => {
          const used = data.events.filter((e) => e.laneId === lane.id).length;
          if (used && !window.confirm(t('Remove the place "{name}"? Its {count} events stay, with no place.', { name: lane.name, count: used }))) return;
          data.lanes = data.lanes.filter((l) => l !== lane);
          for (const e of data.events) if (e.laneId === lane.id) e.laneId = '';
          changed(); drawAll();
        }, t('Place')));
      }
      const chars = bd.querySelector('.ht-chars .ht-chips');
      chars.innerHTML = '';
      for (const who of data.characters) {
        chars.appendChild(chip(who, () => { renameCharacter(who); drawChart(); }, () => { drawList(); drawChart(); }, () => {
          const used = data.events.filter((e) => e.characterIds.includes(who.id)).length;
          if (used && !window.confirm(t('Remove "{name}"? The {count} events they are in stay.', { name: who.name, count: used }))) return;
          data.characters = data.characters.filter((c) => c !== who);
          for (const e of data.events) e.characterIds = e.characterIds.filter((id) => id !== who.id);
          changed(); drawAll();
        }, t('Character')));
      }
      const sheets = bd.querySelector('.ht-sheets .ht-chips');
      sheets.innerHTML = '';
      for (const sheet of data.sheets) {
        sheets.appendChild(chip(sheet, () => { renameSheet(sheet); drawTabs(); drawChart(); }, () => { drawTabs(); drawChart(); }, () => {
          const used = data.events.filter((e) => e.sheetId === sheet.id).length;
          if (used && !window.confirm(t('Remove the sheet "{name}"? Its {count} events move to the main sheet.', { name: sheet.name, count: used }))) return;
          data.sheets = data.sheets.filter((sh) => sh !== sheet);
          for (const e of data.events) if (e.sheetId === sheet.id) e.sheetId = '';
          if (activeSheet === sheet.id) activeSheet = '';
          changed(); drawAll();
        }, t('Sheet')));
      }
    }
    const renameSheet = (sheet) => {
      for (const opt of list.querySelectorAll('.ht-sheet option[value="' + sheet.id + '"]')) opt.textContent = sheet.name || t('(unnamed)');
    };

    /** One tab per sheet, the main sheet first; the chart draws the active one. Hidden until a sheet exists. */
    function drawTabs() {
      tabs.hidden = !data.sheets.length;
      tabs.innerHTML = '';
      if (tabs.hidden) { activeSheet = ''; return; }
      if (activeSheet && !sheetOf(activeSheet)) activeSheet = '';
      for (const sheet of [{ id: '', name: t('Main sheet'), color: '' }, ...data.sheets]) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ht-tab' + (sheet.id === activeSheet ? ' ht-tab-on' : '');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(sheet.id === activeSheet));
        tab.dataset.id = sheet.id;
        if (sheet.color) tab.style.setProperty('--sheet', sheet.color);
        const count = data.events.filter((e) => e.sheetId === sheet.id).length;
        tab.textContent = (sheet.name || t('(unnamed)')) + (count ? ' · ' + count : '');
        tab.onclick = () => { activeSheet = sheet.id; drawTabs(); drawChart(); };
        tabs.appendChild(tab);
      }
    }
    /** A rename reaches every place select and lane label without redrawing the list (the writer is typing). */
    const renameLane = (lane) => {
      for (const opt of list.querySelectorAll('.ht-place option[value="' + lane.id + '"]')) opt.textContent = lane.name || t('(unnamed)');
    };
    const renameCharacter = (who) => {
      for (const btn of list.querySelectorAll('.ht-who button[data-id="' + who.id + '"]')) btn.textContent = who.name || t('(unnamed)');
    };

    bd.querySelector('.ht-add-lane').onclick = () => {
      data.lanes.push({ id: newId('ln'), name: '', color: nextColor(data.lanes) });
      changed(); drawAll();
      const last = bd.querySelector('.ht-lanes .ht-chip:last-child .ht-chip-name');
      if (last) last.focus();
    };
    bd.querySelector('.ht-add-sheet').onclick = () => {
      const sheet = { id: newId('sh'), name: '', color: PALETTE[(data.sheets.length + 2) % PALETTE.length] };
      data.sheets.push(sheet);
      activeSheet = sheet.id;
      changed(); drawAll();
      const last = bd.querySelector('.ht-sheets .ht-chip:last-child .ht-chip-name');
      if (last) last.focus();
    };
    bd.querySelector('.ht-add-char').onclick = () => {
      data.characters.push({ id: newId('ch'), name: '', color: nextColor(data.characters) });
      changed(); drawAll();
      const last = bd.querySelector('.ht-chars .ht-chip:last-child .ht-chip-name');
      if (last) last.focus();
    };

    // ---- the chart: lanes across, story order along, a stroke per character ----
    let drawn = null; // what the last drawChart laid out, for the printed sheet
    function drawChart() {
      chart.hidden = !data.events.length;
      printBtn.hidden = chart.hidden;
      if (chart.hidden) return;
      const shown = data.events.filter((e) => (sheetOf(e.sheetId) ? e.sheetId : '') === activeSheet);
      const lanes = data.lanes.slice();
      if (shown.some((e) => !laneOf(e.laneId))) lanes.push({ id: '', name: t('(no place)'), color: '#6a6a6a' });
      const laneRow = (id) => { const i = lanes.findIndex((l) => l.id === id); return i < 0 ? lanes.length - 1 : i; };
      const width = CHART.laneLeft + Math.max(shown.length, 1) * CHART.column + 20;
      const height = CHART.top + lanes.length * CHART.row + CHART.bottom;
      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.innerHTML = '';
      laneNames.innerHTML = '';
      laneNames.style.paddingTop = CHART.top + 'px';
      const xOf = (i) => CHART.laneLeft + i * CHART.column + CHART.column / 2;
      const yOf = (row) => CHART.top + row * CHART.row + CHART.row / 2;
      drawn = { lanes, shown, width, height, yOf };

      lanes.forEach((lane, row) => {
        const label = document.createElement('div');
        label.className = 'ht-lane-name';
        label.style.height = CHART.row + 'px';
        label.style.color = lane.color;
        label.textContent = lane.name || t('(unnamed)');
        laneNames.appendChild(label);
        svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: yOf(row), y2: yOf(row), class: 'ht-lane-line', stroke: lane.color }));
      });

      // a dotted boundary wherever the chapter changes
      let lastChapter = null;
      shown.forEach((event, i) => {
        if (event.chapterId === lastChapter) return;
        lastChapter = event.chapterId;
        const ch = chapters.find((c) => c.id === event.chapterId);
        if (!ch) return;
        const x = CHART.laneLeft + i * CHART.column + 4;
        svg.appendChild(svgEl('line', { x1: x, x2: x, y1: 8, y2: height - 8, class: 'ht-chapter-line' }));
        const text = svgEl('text', { x: x + 5, y: 16, class: 'ht-chapter-label' });
        text.textContent = clip(ch.name, 22);
        svg.appendChild(text);
      });

      // every character's path, drawn under the dots so the dots stay clickable
      data.characters.forEach((who, k) => {
        const offset = (k - (data.characters.length - 1) / 2) * 4;
        const theirs = data.events.filter((event) => event.characterIds.includes(who.id)); // in story order, across every sheet
        const points = [];
        shown.forEach((event, i) => {
          if (!event.characterIds.includes(who.id)) return;
          const at = theirs.indexOf(event);
          const before = theirs[at - 1];
          const after = theirs[at + 1];
          points.push({
            x: xOf(i), y: yOf(laneRow(event.laneId)) + offset,
            from: before && before.sheetId !== event.sheetId ? sheetNameOf(before.sheetId) : '',
            to: after && after.sheetId !== event.sheetId ? sheetNameOf(after.sheetId) : '',
          });
        });
        if (!points.length) return;
        const path = svgEl('path', { d: pathThrough(points), class: 'ht-path', stroke: who.color, 'data-id': who.id });
        const title = svgEl('title', {});
        title.textContent = who.name;
        path.appendChild(title);
        svg.appendChild(path);
        for (const p of points) {
          svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 3.5, fill: who.color, class: 'ht-path-dot' }));
          // a crossing between sheets: where they came from, where they go, in their own colour
          if (p.from) { const m = svgEl('text', { x: p.x - 10, y: p.y + 4, class: 'ht-jump', fill: who.color, 'text-anchor': 'end' }); m.textContent = '⇠ ' + clip(p.from, 14); svg.appendChild(m); }
          if (p.to) { const m = svgEl('text', { x: p.x + 10, y: p.y + 4, class: 'ht-jump', fill: who.color }); m.textContent = clip(p.to, 14) + ' ⇢'; svg.appendChild(m); }
        }
      });

      shown.forEach((event, i) => {
        const x = xOf(i);
        const y = yOf(laneRow(event.laneId));
        const g = svgEl('g', { class: 'ht-mark', 'data-id': event.id, tabindex: 0, role: 'button' });
        g.appendChild(svgEl('circle', { cx: x, cy: y, r: 6, class: 'ht-mark-dot' }));
        const above = svgEl('text', { x, y: y - 12, class: 'ht-mark-when', 'text-anchor': 'middle' });
        above.textContent = clip(event.when, CHART.labelChars);
        g.appendChild(above);
        const below = svgEl('text', { x, y: y + 22, class: 'ht-mark-title', 'text-anchor': 'middle' });
        below.textContent = clip(event.title, CHART.labelChars);
        g.appendChild(below);
        const endChapter = spanEnd(event);
        if (endChapter) {
          // told across chapters: a bar runs on from the dot, and the title says where it ends
          const lane = laneOf(event.laneId);
          g.insertBefore(svgEl('line', { x1: x + 6, x2: x + CHART.column / 2 - 4, y1: y, y2: y, class: 'ht-span-bar', stroke: lane ? lane.color : '#9a9a9a' }), g.firstChild);
          const until = svgEl('text', { x, y: y + 35, class: 'ht-mark-span', 'text-anchor': 'middle' });
          until.textContent = t('to {chapter}', { chapter: clip(endChapter.name, CHART.labelChars - 3) });
          g.appendChild(until);
        }
        const tip = svgEl('title', {});
        tip.textContent = [event.when, event.title, chapterSpanText(event), event.characterIds.map((id) => (charOf(id) || {}).name).filter(Boolean).join(', ')].filter(Boolean).join(' · ');
        g.appendChild(tip);
        const reveal = () => {
          const row = list.querySelector('.ht-event[data-id="' + event.id + '"]');
          if (!row) return;
          row.scrollIntoView({ block: 'nearest' });
          row.classList.add('ht-lit');
          setTimeout(() => row.classList.remove('ht-lit'), 1200);
          row.querySelector('.ht-title').focus();
        };
        g.addEventListener('click', reveal);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } });
        g.addEventListener('dblclick', () => { if (chapters.some((c) => c.id === event.chapterId)) { close(); goToChapter(event.chapterId); } });
        svg.appendChild(g);
      });
    }

    // ---- paper: every sheet's chart in page-wide segments, the events under it ----
    /** The chart as a document of its own: landscape pages, the lane names at the left of every segment. */
    function printDocument() {
      const keep = activeSheet;
      const sheets = [{ id: '', name: t('Main sheet') }, ...data.sheets].filter((sh) => data.events.some((e) => (sheetOf(e.sheetId) ? e.sheetId : '') === sh.id));
      const parts = [];
      for (const sheet of sheets) {
        activeSheet = sheet.id;
        drawChart();
        const { lanes, shown, height, yOf } = drawn;
        const copy = svg.cloneNode(true);
        copy.removeAttribute('width'); copy.removeAttribute('height'); copy.removeAttribute('aria-hidden');
        for (const g of copy.querySelectorAll('.ht-mark')) { g.removeAttribute('tabindex'); g.removeAttribute('role'); }
        const segments = [];
        const segWidth = PRINT.gutter + PRINT.perPage * CHART.column + 20;
        for (let from = 0; from < shown.length; from += PRINT.perPage) {
          const x0 = CHART.laneLeft + from * CHART.column - PRINT.gutter;
          // the lane names, dark on paper with the lane's colour as a dot (a pale lane colour is no name to read)
          const names = lanes.map((lane, row) => `<circle cx="${x0 + 12}" cy="${yOf(row)}" r="4" fill="${esc(lane.color)}"/><text x="${x0 + 22}" y="${yOf(row) + 4}" class="ht-print-lane">${esc(clip(lane.name || t('(unnamed)'), 18))}</text>`).join('');
          segments.push(`<figure class="seg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} 0 ${segWidth} ${height}" class="ht-svg">`
            + copy.innerHTML + `<rect x="${x0}" y="0" width="${PRINT.gutter}" height="${height}" fill="#fff"/>${names}</svg></figure>`);
        }
        const rows = shown.map((event) => `<tr><td>${esc(event.when)}</td><td>${esc(event.title)}</td><td>${esc((laneOf(event.laneId) || {}).name || '')}</td><td>${esc(chapterSpanText(event))}</td><td>${esc(event.characterIds.map((id) => (charOf(id) || {}).name).filter(Boolean).join(', '))}</td></tr>`).join('');
        parts.push((sheets.length > 1 ? `<h2>${esc(sheet.name || t('(unnamed)'))}</h2>` : '') + segments.join('')
          + `<table><thead><tr><th>${t('When in the story')}</th><th>${t('What happens')}</th><th>${t('Place')}</th><th>${t('Chapter')}</th><th>${t('Characters')}</th></tr></thead><tbody>${rows}</tbody></table>`);
      }
      activeSheet = keep;
      drawChart();
      const paper = /^en-(us|ca|ph)/i.test(navigator.language || '') ? 'letter' : 'A4';
      const title = (meta && meta.title) || t('Untitled');
      return `<!DOCTYPE html><html lang="${esc(document.documentElement.lang || 'en')}"><head><meta charset="utf-8"><title>${esc(title)} — ${t('Timeline')}</title>
<style>
  @page { size: ${paper} landscape; margin: 0.5in; }
  html, body { margin: 0; padding: 0; }
  body { font: 11pt/1.4 Georgia, 'Times New Roman', serif; color: #111; background: #fff; }
  h1 { font-size: 18pt; font-weight: normal; margin: 0 0 2pt; }
  .sub { color: #555; font-size: 10pt; margin: 0 0 12pt; }
  h2 { font-size: 13pt; font-weight: normal; margin: 14pt 0 6pt; break-after: avoid; page-break-after: avoid; }
  figure.seg { margin: 0 0 8pt; break-inside: avoid; page-break-inside: avoid; }
  .ht-svg { display: block; width: 100%; height: auto; font-family: Helvetica, Arial, sans-serif; font-size: 11px; }
  .ht-lane-line { stroke-width: 1.5; opacity: .5; }
  .ht-chapter-line { stroke: #888; stroke-width: 1; stroke-dasharray: 2 4; }
  .ht-chapter-label { fill: #666; font-size: 10px; letter-spacing: .04em; }
  .ht-path { fill: none; stroke-width: 2.5; stroke-linecap: round; opacity: .9; }
  .ht-mark-dot { fill: #fff; stroke: #333; stroke-width: 2; }
  .ht-mark-when { fill: #555; }
  .ht-mark-title { fill: #111; }
  .ht-jump { font-size: 10px; font-style: italic; }
  .ht-span-bar { stroke-width: 4; stroke-linecap: round; opacity: .55; }
  .ht-mark-span { fill: #666; font-size: 10px; font-style: italic; }
  .ht-print-lane { fill: #222; font-size: 12px; font-weight: bold; letter-spacing: .02em; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 4pt 0 14pt; }
  th, td { text-align: left; vertical-align: top; padding: 3pt 8pt 3pt 0; border-bottom: 1px solid #ddd; }
  th { color: #666; font-weight: normal; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }
  tr { break-inside: avoid; page-break-inside: avoid; }
</style></head><body>
<h1>${esc(title)}</h1><p class="sub">${t('Timeline')}${meta && meta.author ? ' · ' + esc(meta.author) : ''}</p>
${parts.join('')}</body></html>`;
    }
    hosted.timelinePrintDocument = printDocument;
    printBtn.onclick = () => {
      flush();
      const name = (((meta && meta.title) || t('Untitled')) + ' - ' + t('Timeline') + '.pdf').replace(/[\\/:*?"<>|]+/g, ' ').trim();
      hosted.printSheet(printDocument(), name);
    };

    // ---- the list: one row per event, in story order ----
    const move = (from, to) => {
      if (to < 0 || to >= data.events.length || from === to) return;
      const [event] = data.events.splice(from, 1);
      data.events.splice(to, 0, event);
      changed();
      drawList(); drawChart(); keepFocus();
    };
    let dragging = -1;

    function row(event, index) {
      const li = document.createElement('li');
      li.className = 'ht-event';
      li.draggable = true;
      li.dataset.id = event.id;
      li.innerHTML = `
        <span class="ht-dot" aria-hidden="true"></span>
        <div class="ht-body">
          <div class="ht-fields">
            <input class="ht-when" type="text">
            <input class="ht-title" type="text">
            <select class="ht-place"></select>
            <select class="ht-chapter"></select>
          </div>
          <div class="ht-extra" hidden><select class="ht-sheet" hidden></select><label class="ht-span" hidden><span></span><select class="ht-chapter-end"></select></label><div class="ht-who"></div></div>
        </div>
        <div class="ht-tools">
          <button class="ht-up btn-quiet" title="${t('Move up')}" aria-label="${t('Move up')}">↑</button>
          <button class="ht-down btn-quiet" title="${t('Move down')}" aria-label="${t('Move down')}">↓</button>
          <button class="ht-go btn-quiet" hidden></button>
          <button class="ht-remove btn-quiet" title="${t('Remove')}" aria-label="${t('Remove')}">×</button>
        </div>`;
      const when = li.querySelector('.ht-when');
      const title = li.querySelector('.ht-title');
      const place = li.querySelector('.ht-place');
      const chapter = li.querySelector('.ht-chapter');
      const who = li.querySelector('.ht-who');
      const extra = li.querySelector('.ht-extra');
      const sheetSel = li.querySelector('.ht-sheet');
      const span = li.querySelector('.ht-span');
      const chapterEnd = li.querySelector('.ht-chapter-end');
      const go = li.querySelector('.ht-go');
      const dot = li.querySelector('.ht-dot');
      when.placeholder = t('When in the story');
      when.value = event.when;
      title.placeholder = t('What happens');
      title.value = event.title;

      const option = (select, value, text) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
      };
      option(place, '', t('(no place)'));
      for (const lane of data.lanes) option(place, lane.id, lane.name || t('(unnamed)'));
      place.value = laneOf(event.laneId) ? event.laneId : '';
      const tint = () => { const lane = laneOf(place.value); dot.style.background = lane ? lane.color : ''; };
      tint();
      option(chapter, '', t('(no chapter)'));
      for (const ch of chapters) option(chapter, ch.id, ch.name);
      chapter.value = chapters.some((ch) => ch.id === event.chapterId) ? event.chapterId : '';
      const showGo = () => {
        const ch = chapters.find((c) => c.id === chapter.value);
        go.hidden = !ch;
        if (ch) go.textContent = t('Go to {chapter}', { chapter: ch.name });
      };
      showGo();
      span.querySelector('span').textContent = t('through');
      /** Only chapters after the start one can end a span; the choice is kept if it still qualifies. */
      const showSpan = () => {
        const from = chapterIndex(chapter.value);
        span.hidden = from < 0 || from >= chapters.length - 1;
        chapterEnd.innerHTML = '';
        option(chapterEnd, '', t('(this chapter only)'));
        for (const ch of chapters.slice(from + 1)) option(chapterEnd, ch.id, ch.name);
        chapterEnd.value = spanEnd(event) ? event.endChapterId : '';
        extra.hidden = !data.characters.length && !data.sheets.length && span.hidden;
      };
      showSpan();
      chapterEnd.onchange = () => { event.endChapterId = chapterEnd.value; changed(); drawChart(); };

      sheetSel.hidden = !data.sheets.length;
      option(sheetSel, '', t('Main sheet'));
      for (const sheet of data.sheets) option(sheetSel, sheet.id, sheet.name || t('(unnamed)'));
      sheetSel.value = sheetOf(event.sheetId) ? event.sheetId : '';
      sheetSel.onchange = () => { event.sheetId = sheetSel.value; changed(); drawTabs(); drawChart(); };
      for (const person of data.characters) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.id = person.id;
        btn.textContent = person.name || t('(unnamed)');
        btn.style.setProperty('--who', person.color);
        const paint = () => btn.classList.toggle('ht-in', event.characterIds.includes(person.id));
        paint();
        btn.onclick = () => {
          event.characterIds = event.characterIds.includes(person.id) ? event.characterIds.filter((id) => id !== person.id) : event.characterIds.concat(person.id);
          paint(); changed(); drawChart();
        };
        who.appendChild(btn);
      }

      when.oninput = () => { event.when = when.value; changed(); drawChart(); };
      title.oninput = () => { event.title = title.value; changed(); drawChart(); };
      place.onchange = () => { event.laneId = place.value; tint(); changed(); drawChart(); };
      chapter.onchange = () => { event.chapterId = chapter.value || ''; if (!spanEnd(event)) event.endChapterId = ''; showGo(); showSpan(); changed(); drawChart(); };
      go.onclick = () => { close(); goToChapter(chapter.value); };
      li.querySelector('.ht-up').onclick = () => move(index, index - 1);
      li.querySelector('.ht-down').onclick = () => move(index, index + 1);
      li.querySelector('.ht-remove').onclick = () => {
        const drop = () => { data.events.splice(index, 1); changed(); drawTabs(); drawList(); drawChart(); keepFocus(); };
        if (!event.title && !event.when) { drop(); return; }
        if (window.confirm(t('Remove "{title}" from the timeline? The chapter itself is untouched.', { title: event.title || event.when }))) drop();
      };
      li.addEventListener('dragstart', (e) => { dragging = index; e.dataTransfer.effectAllowed = 'move'; li.classList.add('ht-dragging'); });
      li.addEventListener('dragend', () => { dragging = -1; li.classList.remove('ht-dragging'); });
      li.addEventListener('dragover', (e) => { if (dragging >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
      li.addEventListener('drop', (e) => { e.preventDefault(); if (dragging >= 0) move(dragging, index); });
      return li;
    }

    function drawList() {
      list.innerHTML = '';
      data.events.forEach((event, i) => list.appendChild(row(event, i)));
      if (!data.events.length) {
        const li = document.createElement('li');
        li.className = 'ht-empty';
        li.textContent = t('No events yet. Add the first one below.');
        list.appendChild(li);
      }
    }
    /** A redraw that removes the focused button would drop focus to the page, and Escape with it; the panel takes it back. */
    const keepFocus = () => { if (!bd.contains(document.activeElement)) bd.focus(); };
    const drawAll = () => { drawSets(); drawTabs(); drawList(); drawChart(); keepFocus(); };

    bd.querySelector('.ht-add').onclick = () => {
      const last = data.events[data.events.length - 1];
      data.events.push({ id: newId('ev'), when: '', title: '', chapterId: last ? last.chapterId : '', endChapterId: '', laneId: last ? last.laneId : '', characterIds: [], sheetId: activeSheet });
      changed();
      drawTabs(); drawList(); drawChart();
      const field = list.querySelector('.ht-event:last-child .ht-when');
      if (field) field.focus();
    };
    drawAll();
  }

  hosted.openTimeline = openTimeline;
})();
