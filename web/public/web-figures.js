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
/* <figure> in place of the caption's <p>, the Word file an inline       */
/* drawing in word/media/. Nothing here touches app.js.                  */

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

  // The mark a figure's paragraph carries through app.js's builders: a
  // private-use span of text, "<file>|<size>", that paraRuns
  // keeps as words (the builders keep nothing else of the markup), so the
  // EPUB and the Word file can find the paragraph again and the web page
  // can drop it. Plain text and Markdown read p.text and p.runs, which
  // never carried it.
  const MARK_OPEN = '';
  const MARK_CLOSE = '';
  const markOf = (figure) => `${MARK_OPEN}${figure.file}|${figure.size || ''}${MARK_CLOSE}`;
  const MARK_RE = /([^|]+)\|([^]*)/;
  const MARK_SPAN_RE = /<span class="fig-mark" hidden="">[^]*<\/span>|<span class="fig-mark" hidden>[^]*<\/span>/g;

  /** The <figure> the exports carry; `src` is where the image is at that moment (a URL for the page, data: once inlined, images/… in the EPUB). */
  function figureHtml(figure, src, { xml = false, mark = false, captionHtml } = {}) {
    const size = sizeOf(figure.size);
    const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
    const inner = captionHtml !== undefined ? captionHtml : esc(figure.caption);
    const caption = inner ? `<figcaption>${inner}</figcaption>` : '';
    return `<figure class="figure">${mark ? `<span class="fig-mark" hidden>${markOf(figure)}</span>` : ''}<img src="${esc(src)}" alt="${esc(figure.caption)}"${dims}${xml ? '/' : ''}>${caption}</figure>`;
  }

  /**
   * Sets the pictures into one section of the export data (its `paras`,
   * as bookExportData built them), given placeFigures' answer for that
   * chapter's HTML. Each figure's paragraph carries the mark. Returns the
   * final index of each figure in `paras`.
   */
  function layIntoSection(section, placed, srcFor) {
    const laid = [];
    let shift = 0;
    for (const item of placed) {
      const at = item.index + shift;
      const html = figureHtml(item.figure, srcFor(item.figure), { mark: true });
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

  /** The file names the marks in a builder's output name, in order, each once. */
  function markedFiles(text) {
    const files = [];
    for (const m of String(text).matchAll(new RegExp(MARK_RE.source, 'g'))) if (!files.includes(m[1])) files.push(m[1]);
    return files;
  }
  const stripTags = (s) => s.replace(/<[^>]+>/g, '');
  const unescXml = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  /**
   * The EPUB with its pictures: in each chapter file the paragraph that
   * carries a figure's mark becomes the <figure> (its remaining words the
   * caption), the image bytes go in OEBPS/images/ and the manifest and the
   * stylesheet learn of them. `images` maps a file name to its base64
   * bytes; a picture without bytes is left as its caption, mark removed.
   */
  function epubEntries(entries, images) {
    const out = entries.map((e) => ({ ...e }));
    const opf = out.find((e) => e.path === OPF_PATH);
    const css = out.find((e) => e.path === CSS_PATH);
    if (!opf || !css) return out;
    const used = [];
    const re = new RegExp(`<p\\b[^>]*>((?:<[^>]+>)*)${MARK_RE.source}([\\s\\S]*?)<\\/p>`, 'g');
    for (const entry of out) {
      if (!/^OEBPS\/ch\d+\.xhtml$/.test(entry.path) || !MARK_RE.test(entry.content)) continue;
      entry.content = entry.content.replace(re, (whole, open, file, size, rest) => {
        const captionHtml = (open + rest).trim();
        if (!images[file]) return whole.replace(MARK_RE, '');
        if (!used.includes(file)) used.push(file);
        return figureHtml({ file, size, caption: unescXml(stripTags(captionHtml)) }, 'images/' + file, { xml: true, captionHtml });
      });
    }
    if (!used.length) return out;
    const items = used.map((file, i) => {
      out.push({ path: IMAGE_DIR + file, content: images[file], base64: true });
      return `<item id="fig-${i + 1}" href="images/${file}" media-type="${MIME[extOf(file)]}"/>`;
    });
    opf.content = opf.content.replace('</manifest>', items.join('\n') + '\n</manifest>');
    css.content += '\n' + EXPORT_CSS;
    return out;
  }

  // Word's page: 6.5 in between the margins buildDocxEntries sets, 9 in tall; sizes in EMU (914400 to the inch)
  const EMU_PER_PX = 9525; // at 96 dpi
  const DOCX_MAX_WIDTH = 5943600;
  const DOCX_MAX_HEIGHT = 7315200;
  function docxExtent(size) {
    let cx = size ? size.width * EMU_PER_PX : 3657600;
    let cy = size ? size.height * EMU_PER_PX : 2743200;
    if (cx > DOCX_MAX_WIDTH) { cy = Math.round(cy * DOCX_MAX_WIDTH / cx); cx = DOCX_MAX_WIDTH; }
    if (cy > DOCX_MAX_HEIGHT) { cx = Math.round(cx * DOCX_MAX_HEIGHT / cy); cy = DOCX_MAX_HEIGHT; }
    return { cx, cy };
  }
  function docxDrawing(n, rId, file, alt, size) {
    const { cx, cy } = docxExtent(size);
    return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:drawing>'
      + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${esc(alt)}"/>`
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${esc(file)}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  const DOCX_NS = ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

  /**
   * The Word file with its pictures: the paragraph that carries a figure's
   * mark becomes an inline drawing, centred, followed by its caption,
   * centred, when it has one; the bytes go in word/media/ with a
   * relationship and a content type each. A picture without bytes is
   * left as its caption, mark removed.
   */
  function docxEntries(entries, images) {
    const out = entries.map((e) => ({ ...e }));
    const doc = out.find((e) => e.path === 'word/document.xml');
    const rels = out.find((e) => e.path === 'word/_rels/document.xml.rels');
    const types = out.find((e) => e.path === '[Content_Types].xml');
    if (!doc || !rels || !types || !MARK_RE.test(doc.content)) return out;
    const used = [];
    const re = new RegExp(`<w:p>(<w:pPr>[\\s\\S]*?<\\/w:pPr>)([\\s\\S]*?)<\\/w:p>`, 'g');
    let n = 0;
    doc.content = doc.content.replace(re, (whole, pPr, runs) => {
      const m = MARK_RE.exec(runs);
      if (!m) return whole;
      const [, file, size] = m;
      const rest = runs.replace(MARK_RE, '');
      const caption = unescXml(stripTags(rest)).trim();
      const captionP = caption ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>${rest}</w:p>` : '';
      if (!images[file]) return caption ? captionP : '';
      if (!used.includes(file)) used.push(file);
      n++;
      return docxDrawing(n, 'rIdFig' + (used.indexOf(file) + 1), file, caption, sizeOf(size)) + captionP;
    });
    if (!used.length) return out;
    doc.content = doc.content.replace('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"${DOCX_NS}>`);
    const relXml = used.map((file, i) => {
      out.push({ path: 'word/media/' + file, content: images[file], base64: true });
      return `<Relationship Id="rIdFig${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${file}"/>`;
    });
    rels.content = rels.content.replace('</Relationships>', relXml.join('\n') + '\n</Relationships>');
    const defaults = [...new Set(used.map(extOf))].filter((ext) => !types.content.includes(`Extension="${ext}"`))
      .map((ext) => `<Default Extension="${ext}" ContentType="${MIME[ext]}"/>`);
    if (defaults.length) types.content = types.content.replace('<Override', defaults.join('\n') + '\n<Override');
    return out;
  }

  /** The export HTML (a web page, or the printer's input) with each picture's bytes inside it, the marks gone and the figure styles in its head. */
  function inlineHtml(html, dataUrlFor) {
    if (!/class="figure"/.test(html)) return Promise.resolve(html);
    const refs = [...html.matchAll(/ src="(\/library\/[^"]+\/(fig-\d+\.(?:png|jpg|webp)))"/g)];
    return Promise.all(refs.map((r) => dataUrlFor(r[2], r[1]))).then((urls) => {
      let out = html.replace(MARK_SPAN_RE, '');
      refs.forEach((r, i) => { if (urls[i]) out = out.split(` src="${r[1]}"`).join(` src="${urls[i]}"`); });
      return out.replace('</head>', `<style>\n${EXPORT_CSS}</style>\n</head>`);
    });
  }

  const api = { placeFigures, figureHtml, layIntoSection, markedFiles, epubEntries, docxEntries, docxExtent, inlineHtml, FILE_RE, EXPORT_CSS, MARK_OPEN, MARK_CLOSE };

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

  function layIntoExport(d) {
    const bookId = hosted.state.bookId;
    const htmlOf = typeof chapterHTML !== 'undefined' ? chapterHTML : {}; // app.js keeps the open book's chapters here
    if (!bookId || !d || !Array.isArray(d.sections)) return;
    for (const sec of d.sections) {
      if (!sec.chId || PAGE_KINDS.includes(sec.kind) || !Array.isArray(sec.paras)) continue;
      const placed = placeFigures(readParagraphs(htmlOf[sec.chId]));
      if (!placed.length) continue;
      for (const item of placed) dataUrl(bookId, item.figure.file); // in flight for the bridge's hooks
      layIntoSection(sec, placed, (fig) => urlFor(bookId, fig.file));
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

  // the bytes of every picture the marks in these entries name
  async function imagesFor(entries) {
    const bookId = hosted.state.bookId;
    const images = {};
    for (const e of entries) if (typeof e.content === 'string' && !e.base64) for (const file of markedFiles(e.content)) if (!(file in images)) images[file] = await base64Of(bookId, file);
    return images;
  }
  /** The EPUB entries with the pictures laid in (the bridge calls this after web-epub.js). */
  async function epubExport(entries) {
    try { return epubEntries(entries, await imagesFor(entries)); } catch (err) { console.error('pictures left out of the EPUB', err); return entries; }
  }
  /** The Word entries with the pictures laid in (the bridge calls this before zipping). */
  async function docxExport(entries) {
    try { return docxEntries(entries, await imagesFor(entries)); } catch (err) { console.error('pictures left out of the Word file', err); return entries; }
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

  hosted.figures = Object.assign(api, { insertPicture, placePicture, inlineExport, epubExport, docxExport, refresh, readParagraphs });
  hosted.insertPicture = insertPicture;
}(typeof window !== 'undefined' ? window : globalThis));
