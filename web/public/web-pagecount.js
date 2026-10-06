/* ===================== NEO, HOSTED: PAGE COUNT ===================== */
/* "about 290 pages" beside the word count: how long the book would be  */
/* as Export → PDF prints it, measured, not guessed from the words. The  */
/* lines of every paragraph are counted with pretext (web/vendor/       */
/* MIT, served at /vendor/), which measures with a canvas in the body face */
/* the editor shows, at the chosen trim's type size and column width;   */
/* the lines are then flowed into pages the way the printer's stylesheet */
/* does it (print/book.css: a heading block at the top of a chapter,     */
/* widows and orphans of two, chapters opening on a recto, a title page  */
/* and a contents page in front). It runs after the word count changes, */
/* in idle time, and only re-measures the paragraphs that changed.      */
/*                                                                      */
/* The trim comes from the writer's print settings when a printer is    */
/* configured, else the default; a click cycles the trims for a look.   */
/* The count is within a few per cent of the printer's (the spike in    */
/* docs/backlog.md); the printer's own X-Neo-Pages is the real one.     */

(function () {
  'use strict';

  const { t } = window.NeoI18n;
  const hosted = window.neoHosted;
  const config = hosted.config || {};
  const offered = config.pages;                   // { trims: [{ value, label, contentWidthIn, contentHeightIn, type, leading }], defaultTrim }
  const wordCounter = document.getElementById('word-counter');
  if (!offered || !wordCounter) return;

  const PX_PER_PT = 96 / 72;
  const PRETEXT_URL = '/vendor/pretext/layout.js?v=' + encodeURIComponent(config.version || '');
  /** the exporter's chapter heading: 1.45em type with 3.2em above and 2.4em below, one line tall (the leading is absolute) */
  const HEADING = { scale: 1.45, above: 3.2, below: 2.4 };
  const PARAGRAPH_INDENT_EM = 2;
  const POETRY_INDENT_EM = 2.5;
  const SCENE_BREAK_MARGIN_EM = 2.5;
  const FIGURE_MAX_HEIGHT_IN = 5.5;
  const CONTENTS_LINES_PER_PAGE = 32;
  /** the printer hyphenates (print/hyphenate.js) and pretext here does not: the spike measured soft hyphens saving 1–1.5% of lines, which a hair of extra width stands in for */
  const HYPHENATION_SLACK = 0.015;
  const DEBOUNCE_MS = 700;
  const PREPARED_CACHE_LIMIT = 6000;

  const counter = document.createElement('span');
  counter.id = 'page-counter';
  counter.hidden = true;
  counter.setAttribute('role', 'button');
  counter.tabIndex = 0;
  wordCounter.after(counter);

  let pretext = null;
  let loading = null;
  const load = () => loading || (loading = import(PRETEXT_URL).then((m) => { pretext = m; }));

  // ---- the trim: the writer's saved choice, or the default; a click cycles for a look ----
  let trim = null;
  let cycled = '';
  async function geometry() {
    if (trim) return trim;
    let name = cycled || offered.defaultTrim;
    if (!cycled && config.print) {
      try { name = (await window.neo.printSettings()).trim || name; } catch { /* the default stands */ }
    }
    trim = offered.trims.find((o) => o.value === name) || offered.trims[0];
    return trim;
  }
  // a choice saved from the print dialog reaches the count too
  const savePrintSettings = window.neo.printSettings;
  window.neo.printSettings = async (patch) => {
    const out = await savePrintSettings(patch);
    if (patch) { cycled = ''; trim = null; schedule(); }
    return out;
  };
  counter.onclick = () => {
    const names = offered.trims.map((o) => o.value);
    const at = names.indexOf((trim || {}).value);
    cycled = names[(at + 1) % names.length];
    trim = null;
    schedule(0);
  };
  counter.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); counter.onclick(); } };

  // ---- measuring: lines per paragraph, remembered by text and font ----
  const prepared = new Map();
  function preparedFor(text, font) {
    const key = font + '\n' + text;
    let p = prepared.get(key);
    if (!p) {
      if (prepared.size > PREPARED_CACHE_LIMIT) prepared.clear();
      p = pretext.prepareWithSegments(text, font);
      prepared.set(key, p);
    }
    return p;
  }
  /** How many lines a paragraph takes at the column width, its first line narrowed by an indent and the first two by a drop cap. */
  function linesOf(text, font, widthPx, { indentPx = 0, capPx = 0 } = {}) {
    const p = preparedFor(text, font);
    let cursor = { segmentIndex: 0, graphemeIndex: 0 };
    let n = 0;
    for (;;) {
      const width = widthPx * (1 + HYPHENATION_SLACK) - (n === 0 ? indentPx : 0) - (n < 2 ? capPx : 0);
      const range = pretext.layoutNextLineRange(p, cursor, Math.max(width, widthPx / 4));
      if (range === null) break;
      cursor = range.end;
      n += 1;
    }
    return n;
  }
  const canvas = document.createElement('canvas').getContext('2d');
  function capWidth(letter, family, leadingPx) {
    canvas.font = `${leadingPx * 2 * 0.95}px "${family}"`;
    return canvas.measureText(letter).width + 4;
  }
  const familyOf = (el) => getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  const figureLines = (p, g, widthPx) => {
    const m = /^(\d+)x(\d+)$/.exec(p.dataset.figureSize || '');
    if (!m) return 1;
    const [w, h] = [Number(m[1]), Number(m[2])];
    const heightIn = Math.min(FIGURE_MAX_HEIGHT_IN, (w > widthPx ? h * widthPx / w : h) / 96);
    return Math.ceil(heightIn * 72 / g.leading) + 2;
  };

  // ---- the page model: book.css's flow, as the spike measured it ----
  function estimate(g) {
    const sizePx = g.type * PX_PER_PT;
    const leadingPx = g.leading * PX_PER_PT;
    const widthPx = g.contentWidthIn * 96;
    const perPage = Math.floor(g.contentHeightIn * 96 / leadingPx) - 1;   // the PDFs hold one line fewer than the arithmetic says
    const headingLines = Math.ceil((HEADING.above * HEADING.scale * g.type + g.leading + HEADING.below * HEADING.scale * g.type) / g.leading);
    const sheets = [...document.querySelectorAll('#chapters section.chapter')];
    const story = sheets.filter((s) => !s.classList.contains('bookpage'));
    const flow = { page: 1 + (story.length > 1 ? Math.ceil(story.length / CONTENTS_LINES_PER_PAGE) : 0), room: 0 };  // the title page, then the contents
    const place = (lines) => {
      let left = lines;
      while (left > 0) {
        if (flow.room <= 0) { flow.page += 1; flow.room = perPage; }
        if (left <= flow.room) { flow.room -= left; return; }
        let take = flow.room;                                   // the paragraph splits: two lines stay, two go over
        if (take < 2 || left - take < 2) take = left - take < 2 ? Math.max(0, left - 2) : 0;
        if (take < 2) take = 0;
        left -= take; flow.page += 1; flow.room = perPage;
      }
    };
    const dropcapOn = !document.body.classList.contains('no-dropcap');
    for (const sheet of sheets) {
      if (sheet.classList.contains('bookpage')) { flow.page += 1; flow.room = 0; continue; }   // a dedication, an epigraph, a part: a page of its own
      if (flow.page % 2 === 1) flow.page += 1;                                               // a blank verso: chapters open on a recto
      flow.page += 1;
      flow.room = perPage - headingLines;
      const body = sheet.querySelector('.chapter-body');
      if (!body) continue;
      const family = familyOf(body);
      const font = `${sizePx}px "${family}"`;
      const cap = dropcapOn && !body.classList.contains('opens-dialogue');
      let first = true;
      let indent = false;
      for (const p of body.children) {
        if (p.tagName !== 'P' || p.classList.contains('ghost')) continue;
        const text = p.textContent;
        let lines;
        if (p.classList.contains('scene-break')) {
          lines = Math.ceil((2 * SCENE_BREAK_MARGIN_EM * g.type + g.leading) / g.leading);
          indent = false;
        } else if (p.classList.contains('figure')) {
          lines = figureLines(p, g, widthPx) + (text.trim() ? linesOf(text, font, widthPx) : 0);
          indent = true;
        } else if (p.classList.contains('poetry')) {
          lines = text.trim() ? linesOf(text, font, widthPx - 2 * POETRY_INDENT_EM * sizePx) : 1;
          indent = true;
        } else if (!text.trim()) {
          lines = 1;
        } else {
          lines = linesOf(text, font, widthPx, { indentPx: indent ? PARAGRAPH_INDENT_EM * sizePx : 0, capPx: first && cap ? capWidth(text.trim()[0], family, leadingPx) : 0 });
          indent = true;
        }
        first = false;
        place(lines);
      }
    }
    return flow.page;
  }

  // ---- when: after the word count changes, in idle time ----
  let timer = null;
  let running = false;
  let again = false;
  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      const editor = document.getElementById('editor-view');
      if (!editor || editor.hidden || !document.querySelector('#chapters section.chapter .chapter-body')) { counter.hidden = true; return; }
      await load();
      await document.fonts.ready;
      const g = await geometry();
      const pages = estimate(g);
      counter.textContent = t('about {n} pages', { n: pages });
      counter.title = t('About {n} pages as Export → PDF would print them at {trim}. Click to see another trim size.', { n: pages, trim: t(g.label) });
      counter.hidden = false;
      hosted.pageCount.last = { pages, trim: g.value };
    } catch (err) {
      counter.hidden = true;
      console.warn('[page count]', err);
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
  }
  function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; (window.requestIdleCallback || ((f) => setTimeout(f, 50)))(run); }, delay);
  }
  new MutationObserver(() => schedule()).observe(wordCounter, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => schedule()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => schedule()).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  const chapters = document.getElementById('chapters');
  if (chapters) new MutationObserver(() => schedule()).observe(chapters, { childList: true });

  hosted.pageCount = { now: async () => { await run(); return hosted.pageCount.last; }, last: null };
  schedule();
})();
