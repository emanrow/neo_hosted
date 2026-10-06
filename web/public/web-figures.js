/* ====================== NEO, HOSTED: PICTURES ====================== */
/* A picture in a chapter. Format → Insert Picture… uploads an image     */
/* (POST /api/figure:upload) and plants a paragraph at the caret:        */
/*                                                                       */
/*   <p class="figure" data-figure="fig-<ts>.jpg" data-figure-size="WxH">caption</p>
/*                                                                       */
/* The editor is upstream's and never learns about pictures: the file    */
/* name rides on an ordinary paragraph, whose words are the caption,     */
/* and the image itself is drawn above it by a stylesheet this script    */
/* keeps (a ::before with a background, so nothing but the attributes    */
/* is ever saved). The file is fig-<ts>.<ext> beside the cover, served   */
/* at /library/<book>/<file>, and never deleted: a paragraph can go, the */
/* picture stays, like words in the Trash.                               */
/*                                                                       */
/* Exports: the editor's parasFromHtml keeps a paragraph for its words,  */
/* so the caption survives into every export and a captionless picture   */
/* vanishes. This script wraps bookExportData, re-reads each chapter's   */
/* HTML, works out where its pictures sit among the kept paragraphs, and */
/* sets a <figure> into the export data there; the web page and the PDF  */
/* take it as it is (the bridge inlines the image bytes, web page files  */
/* and the printer have no session), the EPUB gets OEBPS/images/ and a   */
/* <figure> in place of the caption's <p>. Word gets the caption only,   */
/* for now. Nothing here touches app.js.                                 */

(function (root) {
  'use strict';

  const FILE_RE = /^fig-\d+\.(png|jpg|webp)$/;
  const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  const PAGE_KINDS = ['copyright', 'dedication', 'epigraph', 'part', 'opener']; // lines, not prose: no pictures
  const CSS_PATH = 'OEBPS/style.css';
  const OPF_PATH = 'OEBPS/content.opf';
  const IMAGE_DIR = 'OEBPS/images/';
  const EXPORT_CSS = 'figure.figure { margin: 1.5em 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }\n'
    + 'figure.figure img { max-width: 100%; max-height: 5.5in; height: auto; }\n'
    + 'figure.figure figcaption { font-size: 0.85em; font-style: italic; margin-top: 0.5em; text-indent: 0; }\n';

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const extOf = (file) => String(file).split('.').pop().toLowerCase();
  const sizeOf = (size) => {
    const m = /^(\d+)x(\d+)$/.exec(String(size || ''));
    return m ? { width: +m[1], height: +m[2] } : null;
  };

  /* ---------- pure: where the pictures sit ---------- */

  /**
   * The paragraphs of a chapter the way parasFromHtml (app.js) keeps them,
   * with each picture's place among them. `paras` is a list of
   * { sceneBreak, text, figure? } in document order; the result lists each
   * picture with the index it has, or will have, in the kept list:
   * `replace` when its caption paragraph is kept (it has words) and the
   * <figure> stands in for it, otherwise an insertion before that index.
   * Indexes are in the kept list before any insertion.
   */
  function placeFigures(paras) {
    const out = [];
    let kept = 0;
    for (const p of paras || []) {
      const keep = !!(p.sceneBreak || (p.text && p.text.trim()));
      if (p.figure && p.figure.file && FILE_RE.test(p.figure.file)) out.push({ index: kept, replace: keep, figure: { ...p.figure, caption: (p.text || '').trim() } });
      if (keep) kept++;
    }
    return out;
  }

  /** The <figure> the exports carry; `src` is where the image is at that moment (a URL for the page, data: once inlined, images/… in the EPUB). */
  function figureHtml(figure, src, xml) {
    const size = sizeOf(figure.size);
    const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
    const caption = figure.caption ? `<figcaption>${esc(figure.caption)}</figcaption>` : '';
    return `<figure class="figure"><img src="${esc(src)}" alt="${esc(figure.caption)}"${dims}${xml ? '/' : ''}>${caption}</figure>`;
  }

  /**
   * Sets the pictures into one section of the export data (its `paras`,
   * as bookExportData built them), given placeFigures' answer for that
   * chapter's HTML. Returns the final index of each figure in `paras`.
   */
  function layIntoSection(section, placed, srcFor) {
    const laid = [];
    let shift = 0;
    for (const item of placed) {
      const at = item.index + shift;
      const html = figureHtml(item.figure, srcFor(item.figure));
      if (item.replace) {
        const para = section.paras[at];
        // the kept list and the HTML were read from the same words; if they
        // disagree, something else changed the paragraph and it is left alone
        if (!para || para.sceneBreak || (para.text || '').trim() !== item.figure.caption) continue;
        para.html = html;
        para.figure = item.figure;
      } else {
        section.paras.splice(at, 0, { sceneBreak: false, poetry: false, flush: false, text: '', runs: [], align: '', html, figure: item.figure });
        shift++;
      }
      laid.push({ at, figure: item.figure });
    }
    return laid;
  }

  /**
   * The EPUB with its pictures: in each chapter file, the paragraph a
   * figure was laid into (the nth <p> of the chapter's prose, bylines
   * aside) becomes the <figure>, the image bytes go in OEBPS/images/ and
   * the manifest and stylesheet learn of them. `layouts` is
   * [{ num, laid: [{ at, figure }] }], `images` maps a file name to its
   * base64 bytes (a picture without bytes is left as its caption).
   */
  function epubEntries(entries, layouts, images) {
    const out = entries.map((e) => ({ ...e }));
    const opf = out.find((e) => e.path === OPF_PATH);
    const css = out.find((e) => e.path === CSS_PATH);
    if (!opf || !css) return out;
    const used = new Set();
    for (const { num, laid } of layouts) {
      const entry = out.find((e) => e.path === `OEBPS/ch${num}.xhtml`);
      if (!entry || !laid.length) continue;
      const slots = [];
      const re = /<p\b([^>]*)>[\s\S]*?<\/p>/g;
      let m;
      while ((m = re.exec(entry.content))) if (!/class="(?:byline|sub)"/.test(m[1])) slots.push({ start: m.index, end: m.index + m[0].length });
      const ready = laid.filter(({ at, figure }) => slots[at] && images[figure.file]);
      for (const { figure } of ready) used.add(figure.file); // in the order the book shows them
      let content = entry.content;
      for (const { at, figure } of [...ready].sort((a, b) => b.at - a.at)) { // from the back, so the slots ahead keep their offsets
        const slot = slots[at];
        content = content.slice(0, slot.start) + figureHtml(figure, 'images/' + figure.file, true) + content.slice(slot.end);
      }
      entry.content = content;
    }
    if (!used.size) return out;
    const items = [];
    let n = 0;
    for (const file of used) {
      out.push({ path: IMAGE_DIR + file, content: images[file], base64: true });
      items.push(`<item id="fig-${++n}" href="images/${file}" media-type="${MIME[extOf(file)]}"/>`);
    }
    opf.content = opf.content.replace('</manifest>', items.join('\n') + '\n</manifest>');
    css.content += '\n' + EXPORT_CSS;
    return out;
  }

  /** The export HTML (a web page, or the printer's input) with each picture's bytes inside it and the figure styles in its head. */
  function inlineHtml(html, dataUrlFor) {
    if (!/class="figure"/.test(html)) return Promise.resolve(html);
    const refs = [...html.matchAll(/ src="(\/library\/[^"]+\/(fig-\d+\.(?:png|jpg|webp)))"/g)];
    return Promise.all(refs.map((r) => dataUrlFor(r[2], r[1]))).then((urls) => {
      let out = html;
      refs.forEach((r, i) => { if (urls[i]) out = out.split(` src="${r[1]}"`).join(` src="${urls[i]}"`); });
      return out.replace('</head>', `<style>\n${EXPORT_CSS}</style>\n</head>`);
    });
  }

  const api = { placeFigures, figureHtml, layIntoSection, epubEntries, inlineHtml, FILE_RE, EXPORT_CSS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document || !root.neoHosted) return;

  /* ---------- in the page ---------- */

  const hosted = root.neoHosted;
  const t = (root.NeoI18n && root.NeoI18n.t) || ((s) => s);
  const say = (msg) => { if (typeof root.toast === 'function') root.toast(msg); };
  const urlFor = (bookId, file) => '/library/' + encodeURIComponent(bookId) + '/' + encodeURIComponent(file);

  // the bytes of each picture, as data: URLs, fetched once and kept for the exports
  const bytes = new Map();
  function dataUrl(bookId, file) {
    const key = bookId + '/' + file;
    if (!bytes.has(key)) {
      bytes.set(key, fetch(urlFor(bookId, file), { credentials: 'same-origin' }).then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
      }).catch(() => { bytes.delete(key); return null; }));
    }
    return bytes.get(key);
  }
  const base64Of = (bookId, file) => dataUrl(bookId, file).then((u) => (u ? u.split(',')[1] : null));

  // The chapter's HTML read the way parasFromHtml reads it (a ghost outline
  // paragraph goes with its planted break; marks and anchors go), so the
  // kept paragraphs here are the paragraphs the export has.
  function readParagraphs(html) {
    const holder = document.createElement('template');
    holder.innerHTML = html || '';
    const frag = holder.content;
    frag.querySelectorAll('p.ghost[data-sec-id]').forEach((g) => {
      const brk = frag.querySelector(`p.scene-break[data-sec-brk="${g.dataset.secId}"]`);
      if (brk) brk.remove();
    });
    frag.querySelectorAll('.darling-anchor, .ph-mark, .ghost').forEach((n) => n.remove());
    return [...frag.querySelectorAll('p')].map((p) => ({
      sceneBreak: p.classList.contains('scene-break'),
      text: p.textContent.replace(/ /g, ' ').trim(),
      figure: p.dataset.figure ? { file: p.dataset.figure, size: p.dataset.figureSize || '' } : null
    }));
  }

  // what the last export laid, by section, for the EPUB to finish
  let lastLayouts = [];
  function layIntoExport(d) {
    lastLayouts = [];
    const bookId = hosted.state.bookId;
    const htmlOf = typeof chapterHTML !== 'undefined' ? chapterHTML : {}; // app.js keeps the open book's chapters here
    if (!bookId || !d || !Array.isArray(d.sections)) return;
    for (const sec of d.sections) {
      if (!sec.chId || PAGE_KINDS.includes(sec.kind) || !Array.isArray(sec.paras)) continue;
      const placed = placeFigures(readParagraphs(htmlOf[sec.chId]));
      if (!placed.length) continue;
      for (const item of placed) dataUrl(bookId, item.figure.file); // in flight for the bridge's inlining
      const laid = layIntoSection(sec, placed, (fig) => urlFor(bookId, fig.file));
      if (laid.length) lastLayouts.push({ sec, laid });
    }
  }
  if (typeof root.bookExportData === 'function') {
    const original = root.bookExportData;
    root.bookExportData = function () {
      const d = original.apply(this, arguments);
      try { layIntoExport(d); } catch (err) { console.error('pictures left out of the export', err); }
      return d;
    };
  }

  /** The export HTML with the pictures' bytes inside (the bridge calls this before a download or the printer). */
  const inlineExport = (html) => inlineHtml(html, (file) => dataUrl(hosted.state.bookId, file)).catch(() => html);

  /** The EPUB entries with the pictures laid in (the bridge calls this after web-epub.js). */
  async function epubExport(entries) {
    try {
      const bookId = hosted.state.bookId;
      const images = {};
      for (const { laid } of lastLayouts) for (const { figure } of laid) if (!(figure.file in images)) images[figure.file] = await base64Of(bookId, figure.file);
      // a section's number is read now: a single chapter's export renumbers it to 1
      return epubEntries(entries, lastLayouts.map(({ sec, laid }) => ({ num: sec.num, laid })), images);
    } catch (err) {
      console.error('pictures left out of the EPUB', err);
      return entries;
    }
  }

  /* ---------- on the page: the picture above its caption ---------- */

  let sheet = null;
  function refresh() {
    const bookId = hosted.state.bookId;
    if (!sheet) { sheet = document.createElement('style'); sheet.id = 'hosted-figures'; document.head.appendChild(sheet); }
    if (!bookId) { sheet.textContent = ''; return; }
    const rules = [];
    const seen = new Set();
    for (const p of document.querySelectorAll('#editor-view .chapter-body p[data-figure]')) {
      const file = p.dataset.figure;
      if (seen.has(file) || !FILE_RE.test(file)) continue;
      seen.add(file);
      const size = sizeOf(p.dataset.figureSize);
      // one class more than web.css's own rule, which comes later in the page and would win a tie
      rules.push(`.chapter-body p.figure[data-figure="${file}"] { --fig-ratio: ${size ? `${size.width} / ${size.height}` : '3 / 2'}; }\n`
        + `.chapter-body p.figure[data-figure="${file}"]::before { background-image: url("${urlFor(bookId, file)}"); }`);
      dataUrl(bookId, file);
    }
    sheet.textContent = rules.join('\n');
  }

  // Enter in a caption makes a plain paragraph after the picture (the engine
  // would clone the paragraph, picture and all); a cloned picture that
  // slips through loses its attributes before app.js reads the body
  function captionEnter(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const sel = root.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    let el = sel.anchorNode;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const p = el && el.closest ? el.closest('p[data-figure]') : null;
    const body = p && p.closest('.chapter-body');
    if (!p || !body) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const fresh = document.createElement('p');
    fresh.innerHTML = '<br>';
    p.after(fresh);
    if (typeof root.placeCaret === 'function') root.placeCaret(fresh, 0);
    body.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function dedupe(e) {
    const body = e.target && e.target.closest ? e.target.closest('.chapter-body') : null;
    if (!body) return;
    const byFile = new Map();
    for (const p of body.querySelectorAll('p[data-figure]')) {
      const list = byFile.get(p.dataset.figure) || [];
      list.push(p);
      byFile.set(p.dataset.figure, list);
    }
    for (const list of byFile.values()) {
      if (list.length < 2) continue;
      const keep = list.find((p) => p.textContent.trim()) || list[0];
      for (const p of list) {
        if (p === keep) continue;
        p.classList.remove('figure');
        delete p.dataset.figure;
        delete p.dataset.figureSize;
      }
    }
  }

  function pickImage() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.style.display = 'none';
      input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
      input.addEventListener('cancel', () => { resolve(null); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  }
  async function measure(file) {
    try {
      const bmp = await createImageBitmap(file);
      const size = bmp.width + 'x' + bmp.height;
      bmp.close();
      return size;
    } catch { return ''; }
  }

  // the paragraph the caret is in, when it is in a chapter's prose
  function caretParagraph() {
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return null; }
    const sel = root.getSelection();
    let el = sel && sel.rangeCount ? sel.anchorNode : null;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const block = el && el.closest ? el.closest('.chapter-body p') : null;
    const section = block && block.closest('.chapter[data-id]');
    if (!block || !section) { say(t('Click in the chapter where the picture goes, then try again')); return null; }
    // isStory and chapterHTML are app.js's top-level bindings (not on window): reachable by name from this script
    if (typeof isStory === 'function' && !isStory(section.dataset.id)) { say(t('Pictures go in chapters, not on the front pages')); return null; }
    return block;
  }

  /** Format → Insert Picture…: the image goes up, a picture paragraph lands at the caret (or replaces the empty line it is on). */
  async function insertPicture() {
    if (!caretParagraph()) return false;
    const file = await pickImage();
    return file ? placePicture(file) : false;
  }

  /** The picture `file` (a File or Blob with a name) at the caret: uploaded, then its paragraph planted. */
  async function placePicture(file) {
    const block = caretParagraph();
    if (!block) return false;
    const bookId = hosted.state.bookId;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let name;
    try { name = await root.neo.uploadFigure(bookId, file, ext); } catch (err) { say(err.message || t('Couldn’t save that picture')); return false; }
    if (!name) return false;
    const p = document.createElement('p');
    p.className = 'figure';
    p.dataset.figure = name;
    p.dataset.figureSize = await measure(file);
    p.innerHTML = '<br>';
    const empty = !block.classList.contains('scene-break') && !block.classList.contains('ghost') && !block.textContent.trim() && !block.querySelector('.ph-mark');
    if (empty) block.replaceWith(p); else block.after(p);
    refresh();
    if (typeof root.placeCaret === 'function') root.placeCaret(p, 0);
    const body = p.closest('.chapter-body');
    if (body) body.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function watch() {
    const editor = document.getElementById('editor-view');
    if (!editor) return;
    editor.addEventListener('keydown', captionEnter, true);
    editor.addEventListener('input', dedupe, true);
    let timer = 0;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(refresh, 150); }).observe(editor, { childList: true, subtree: true });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();

  hosted.figures = Object.assign(api, { insertPicture, placePicture, inlineExport, epubExport, refresh, readParagraphs });
  hosted.insertPicture = insertPicture;
}(typeof window !== 'undefined' ? window : globalThis));
