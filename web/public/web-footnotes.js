/* ====================== NEO, HOSTED: FOOTNOTES ====================== */
/* A footnote in a chapter. Format → Insert Footnote… plants a call at   */
/* the caret and opens a small pad under it for the note's words:        */
/*                                                                       */
/*   <sup class="fn-ref" data-fn="<id>" contenteditable="false">\uE002<id, encoded>\uE003</sup>
/*                                                                       */
/* The editor is upstream's and never learns about footnotes. The call   */
/* is a non-editable superscript whose text is a private-use mark that   */
/* names the note; the number the writer sees is a CSS counter (so the   */
/* numbers follow the order of the chapter as it is typed) and the mark  */
/* itself is drawn at no size. The notes live in footnotes.json beside   */
/* darlings.json (json:read / json:write, the desktop's own channels),   */
/* { notes: { <id>: { text } } }, and a note whose call is deleted stays */
/* there: words are never discarded.                                     */
/*                                                                       */
/* Exports: the editor's builders keep text and nothing else, so the     */
/* mark reaches every format and this script finishes each one in the    */
/* bridge: the web page gets calls that link to notes at the chapter's   */
/* end and, for the printer, notes that Paged.js sets at the foot of the */
/* page; the EPUB gets epub:type="noteref" calls and footnote asides;    */
/* Word gets real footnotes (word/footnotes.xml); plain text and         */
/* Markdown get [n] calls and the notes at the end. Nothing here touches */
/* app.js.                                                               */

(function (root) {
  'use strict';

  const SIDECAR = 'footnotes';
  const MARK_OPEN = '\uE002';
  const MARK_CLOSE = '\uE003';
  const ENCODE_BASE = 0xE100; // an id's characters, each moved into the private-use area: no letters, so no word for the counter or the spellcheck
  const MARK_RE = /\uE002([\uE100-\uE1FF]+)\uE003/g;
  const hasMark = (s) => /\uE002[\uE100-\uE1FF]+\uE003/.test(String(s));
  const ID_RE = /^[a-z0-9]{4,16}$/;

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const encodeId = (id) => [...String(id)].map((c) => String.fromCharCode(ENCODE_BASE + c.charCodeAt(0))).join('');
  const decodeId = (coded) => [...String(coded)].map((c) => String.fromCharCode(c.charCodeAt(0) - ENCODE_BASE)).join('');
  const markOf = (id) => MARK_OPEN + encodeId(id) + MARK_CLOSE;
  const newId = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
  const noteText = (notes, id) => (notes && notes[id] && typeof notes[id].text === 'string' ? notes[id].text : '');

  /** Every note id the marks in `text` name, in order, repeats kept. */
  function markedIds(text) {
    return [...String(text).matchAll(MARK_RE)].map((m) => decodeId(m[1]));
  }

  // Styles the web page carries: calls as superscript links, the notes
  // listed at the chapter's end on screen; in print, Paged.js sets each
  // note at the foot of its page and the list stays out.
  const EXPORT_CSS = `sup.fn-ref { font-size: 0.7em; line-height: 0; vertical-align: super; }
sup.fn-ref a { text-decoration: none; }
.fn-endnotes { margin-top: 2em; padding-top: 0.6em; border-top: 1px solid currentColor; font-size: 0.85em; }
.fn-endnotes ol { padding-left: 1.6em; margin: 0; }
.fn-endnotes li { text-indent: 0; margin: 0 0 0.4em; }
.fn-note { display: none; }
@media print {
  .fn-endnotes { display: none; }
  .fn-note { display: list-item; float: footnote; font-size: 0.85em; line-height: 1.3; }
  sup.fn-ref { display: none; }
}
`;

  /**
   * The web page (and the printer's input) with its footnotes: in each
   * <section>, the marks become numbered calls, each followed by its note
   * in a span for the printer, and the section ends with the notes
   * listed for the screen. A mark whose note is unknown is dropped.
   */
  function htmlWithNotes(html, notes) {
    if (!hasMark(html)) return html;
    let laidAny = false;
    let out = html.replace(/<section\b[^>]*>[\s\S]*?<\/section>/g, (section) => {
      const items = [];
      const body = section.replace(MARK_RE, (whole, coded) => {
        const id = decodeId(coded);
        if (!(notes && notes[id])) return '';
        const n = items.length + 1;
        items.push({ id, n, text: noteText(notes, id) });
        return `<sup class="fn-ref" id="fnref-${esc(id)}"><a href="#fn-${esc(id)}">${n}</a></sup><span class="fn-note">${esc(noteText(notes, id))}</span>`;
      });
      if (!items.length) return body;
      laidAny = true;
      const list = `\n<aside class="fn-endnotes"><ol>${items.map((it) => `<li id="fn-${esc(it.id)}">${esc(it.text)} <a href="#fnref-${esc(it.id)}">↩</a></li>`).join('')}</ol></aside>`;
      return body.replace(/<\/section>$/, list + '\n</section>');
    });
    out = out.replace(MARK_RE, ''); // a mark outside any section (there are none; belt and braces)
    return laidAny && out.includes('</head>') ? out.replace('</head>', `<style>\n${EXPORT_CSS}</style>\n</head>`) : out;
  }

  /**
   * The EPUB with its footnotes: in each chapter file the marks become
   * noteref calls, numbered from one, and the chapter's section ends
   * with an aside per note (readers show these as pop-ups).
   */
  function epubEntries(entries, notes) {
    const out = entries.map((e) => ({ ...e }));
    const css = out.find((e) => e.path === 'OEBPS/style.css');
    let any = false;
    for (const entry of out) {
      if (!/^OEBPS\/ch\d+\.xhtml$/.test(entry.path) || typeof entry.content !== 'string') continue;
      if (!hasMark(entry.content)) continue;
      const items = [];
      let content = entry.content.replace(MARK_RE, (whole, coded) => {
        const id = decodeId(coded);
        if (!(notes && notes[id])) return '';
        const n = items.length + 1;
        items.push({ id, n, text: noteText(notes, id) });
        return `<sup class="fn-ref" id="fnref-${esc(id)}"><a epub:type="noteref" href="#fn-${esc(id)}">${n}</a></sup>`;
      });
      if (items.length) {
        any = true;
        const asides = items.map((it) => `<aside epub:type="footnote" class="fn-note" id="fn-${esc(it.id)}"><p>${it.n}. ${esc(it.text)}</p></aside>`).join('\n');
        const at = content.lastIndexOf('</section>');
        content = at < 0 ? content + asides : content.slice(0, at) + '\n' + asides + '\n' + content.slice(at);
      }
      entry.content = content;
    }
    if (any && css) css.content += '\nsup.fn-ref { font-size: 0.7em; line-height: 0; vertical-align: super; }\nsup.fn-ref a { text-decoration: none; }\naside.fn-note { font-size: 0.85em; margin-top: 1em; }\n';
    return out;
  }

  const DOCX_NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const FOOTNOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
  const FOOTNOTES_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';

  /**
   * The Word file with real footnotes: each mark splits its run around a
   * footnote reference, and word/footnotes.xml holds the notes (Word
   * numbers them itself), with the content type and relationship the
   * package needs.
   */
  function docxEntries(entries, notes) {
    const out = entries.map((e) => ({ ...e }));
    const doc = out.find((e) => e.path === 'word/document.xml');
    const rels = out.find((e) => e.path === 'word/_rels/document.xml.rels');
    const types = out.find((e) => e.path === '[Content_Types].xml');
    if (!doc || !rels || !types || !hasMark(doc.content)) return out;
    const items = [];
    doc.content = doc.content.replace(/<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve">([\s\S]*?)<\/w:t><\/w:r>/g, (whole, rPr, text) => {
      if (!hasMark(text)) return whole;
      const open = `<w:r>${rPr || ''}<w:t xml:space="preserve">`;
      const pieces = text.split(MARK_RE);
      let xml = '';
      for (let i = 0; i < pieces.length; i++) {
        if (i % 2 === 0) { if (pieces[i]) xml += open + pieces[i] + '</w:t></w:r>'; continue; }
        const id = decodeId(pieces[i]);
        if (!(notes && notes[id])) continue;
        const n = items.length + 1;
        items.push({ id, n, text: noteText(notes, id) });
        xml += `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${n}"/></w:r>`;
      }
      return xml;
    });
    doc.content = doc.content.replace(MARK_RE, '');
    if (!items.length) return out;
    const note = (it) => `<w:footnote w:id="${it.n}"><w:p><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve"> ${esc(it.text)}</w:t></w:r></w:p></w:footnote>`;
    out.push({ path: 'word/footnotes.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${DOCX_NS_W}">
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
${items.map(note).join('\n')}
</w:footnotes>` });
    rels.content = rels.content.replace('</Relationships>', `<Relationship Id="rIdFootnotes" Type="${FOOTNOTES_TYPE}" Target="footnotes.xml"/>\n</Relationships>`);
    types.content = types.content.replace('</Types>', `<Override PartName="/word/footnotes.xml" ContentType="${FOOTNOTES_CT}"/>\n</Types>`);
    return out;
  }

  /** Plain text: [n] calls, the notes listed at the end under NOTES. */
  function txtWithNotes(text, notes, heading = 'NOTES') {
    const items = [];
    const body = text.replace(MARK_RE, (whole, coded) => {
      const id = decodeId(coded);
      if (!(notes && notes[id])) return '';
      items.push({ n: items.length + 1, text: noteText(notes, id) });
      return `[${items.length}]`;
    });
    if (!items.length) return body;
    return body.replace(/\s*$/, '\n\n\n') + heading + '\n\n' + items.map((it) => `[${it.n}] ${it.text}`).join('\n') + '\n';
  }

  /** Markdown: [^n] calls, the definitions at the end. */
  function mdWithNotes(text, notes) {
    const items = [];
    const body = text.replace(MARK_RE, (whole, coded) => {
      const id = decodeId(coded);
      if (!(notes && notes[id])) return '';
      items.push({ n: items.length + 1, text: noteText(notes, id) });
      return `[^${items.length}]`;
    });
    if (!items.length) return body;
    return body.replace(/\s*$/, '\n\n') + items.map((it) => `[^${it.n}]: ${it.text.replace(/\n+/g, ' ')}`).join('\n') + '\n';
  }

  const api = { markOf, markedIds, encodeId, decodeId, htmlWithNotes, epubEntries, docxEntries, txtWithNotes, mdWithNotes, EXPORT_CSS, MARK_OPEN, MARK_CLOSE, MARK_RE, ID_RE };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document || !root.neoHosted) return;

  /* ---------- in the page ---------- */

  const hosted = root.neoHosted;
  const t = (root.NeoI18n && root.NeoI18n.t) || ((s) => s);
  const say = (msg) => { if (typeof root.toast === 'function') root.toast(msg); };

  // the open book's notes, read once per book and written whole after each change
  let loaded = { bookId: null, notes: {} };
  async function notesFor(bookId) {
    if (!bookId) return {};
    if (loaded.bookId !== bookId) {
      const data = await root.neo.readJSON(bookId, SIDECAR, { notes: {} });
      loaded = { bookId, notes: (data && data.notes) || {} };
    }
    return loaded.notes;
  }
  let saveTimer = 0;
  function saveNotes(bookId) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { root.neo.writeJSON(bookId, SIDECAR, { notes: loaded.notes }).catch(() => say(t('NEO couldn’t save that footnote. It will try again.'))); }, 400);
  }

  const callEl = (id) => {
    const sup = document.createElement('sup');
    sup.className = 'fn-ref';
    sup.dataset.fn = id;
    sup.contentEditable = 'false';
    sup.textContent = markOf(id);
    return sup;
  };
  const bodyOf = (node) => (node && node.closest ? node.closest('.chapter-body') : null);
  const saveBody = (body) => body.dispatchEvent(new Event('input', { bubbles: true }));

  /** Format → Insert Footnote…: a call at the caret, its pad opened. */
  async function insertFootnote() {
    const bookId = hosted.state.bookId;
    const editor = document.getElementById('editor-view');
    if (!bookId || !editor || editor.hidden) { say(t('Open a book first')); return false; }
    const sel = root.getSelection();
    if (!sel || !sel.rangeCount) { say(t('Click in the chapter where the footnote goes, then try again')); return false; }
    const range = sel.getRangeAt(0);
    let el = range.startContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    const block = el && el.closest ? el.closest('.chapter-body p') : null;
    const section = block && block.closest('.chapter[data-id]');
    if (!block || !section || block.classList.contains('scene-break')) { say(t('Click in the chapter where the footnote goes, then try again')); return false; }
    if (typeof isStory === 'function' && !isStory(section.dataset.id)) { say(t('Footnotes go in chapters, not on the front pages')); return false; } // isStory: app.js's binding
    if (el.closest('sup.fn-ref')) { say(t('That is a footnote already')); return false; }
    await notesFor(bookId);
    const id = newId();
    loaded.notes[id] = { text: '' };
    const sup = callEl(id);
    range.collapse(false);
    range.insertNode(sup);
    range.setStartAfter(sup);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    saveNotes(bookId);
    saveBody(bodyOf(sup));
    openPad(sup);
    return true;
  }

  /* ---------- the pad under a call ---------- */

  let pad = null;
  function closePad() {
    if (!pad) return;
    pad.remove();
    pad = null;
  }
  async function openPad(sup) {
    closePad();
    const bookId = hosted.state.bookId;
    const id = sup.dataset.fn;
    if (!bookId || !id) return;
    const notes = await notesFor(bookId);
    if (!notes[id]) notes[id] = { text: '' };
    pad = document.createElement('div');
    pad.className = 'hosted-fn-pad';
    pad.innerHTML = `<textarea rows="3" spellcheck="true"></textarea><div class="hosted-fn-row"><span class="hosted-fn-n"></span><button type="button" class="hosted-fn-remove"></button><button type="button" class="hosted-fn-done"></button></div>`;
    const ta = pad.querySelector('textarea');
    ta.value = notes[id].text;
    ta.placeholder = t('The note');
    pad.querySelector('.hosted-fn-n').textContent = t('Footnote {n}', { n: numberOf(sup) });
    pad.querySelector('.hosted-fn-remove').textContent = t('Remove');
    pad.querySelector('.hosted-fn-done').textContent = t('Done');
    ta.addEventListener('input', () => { notes[id].text = ta.value; saveNotes(bookId); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePad(); } e.stopPropagation(); });
    pad.querySelector('.hosted-fn-done').addEventListener('click', closePad);
    pad.querySelector('.hosted-fn-remove').addEventListener('click', () => { removeCall(sup); closePad(); });
    pad.sup = sup;
    document.body.appendChild(pad);
    place(sup);
    ta.focus();
  }
  function place(sup) {
    if (!pad) return;
    const r = sup.getBoundingClientRect();
    const w = Math.min(360, root.innerWidth - 24);
    pad.style.left = Math.max(12, Math.min(r.left, root.innerWidth - w - 12)) + 'px';
    pad.style.top = (r.bottom + 8) + 'px';
    pad.style.width = w + 'px';
  }
  const numberOf = (sup) => [...bodyOf(sup).querySelectorAll('sup.fn-ref')].indexOf(sup) + 1;
  function removeCall(sup) {
    const body = bodyOf(sup);
    sup.remove();
    if (body) saveBody(body); // the note stays in footnotes.json
  }

  /* ---------- keeping the calls whole ---------- */

  // text pasted or dragged carries a bare mark: it gets its superscript
  // back, and a second call to the same note becomes a call to a copy
  function reconcile(body) {
    const bookId = hosted.state.bookId;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const bare = [];
    let n;
    while ((n = walker.nextNode())) if (n.nodeValue.includes(MARK_OPEN) && !n.parentElement.closest('sup.fn-ref')) bare.push(n);
    for (const node of bare) {
      const parts = node.nodeValue.split(/(\uE002[\uE100-\uE1FF]+\uE003)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        const m = /^\uE002([\uE100-\uE1FF]+)\uE003$/.exec(part);
        frag.appendChild(m ? callEl(decodeId(m[1])) : document.createTextNode(part));
      }
      node.replaceWith(frag);
    }
    const seen = new Set();
    for (const sup of document.querySelectorAll('#editor-view .chapter-body sup.fn-ref')) {
      const id = sup.dataset.fn;
      if (!seen.has(id)) { seen.add(id); continue; }
      const copy = newId();
      if (loaded.bookId === bookId) { loaded.notes[copy] = { text: noteText(loaded.notes, id) }; saveNotes(bookId); }
      sup.dataset.fn = copy;
      sup.textContent = markOf(copy);
    }
  }
  function onInput(e) {
    const body = bodyOf(e.target);
    if (!body) return;
    reconcile(body);
    if (pad && pad.sup) place(pad.sup);
  }
  // Backspace or Delete beside a call takes the whole call, cleanly
  function guardDelete(e) {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.metaKey || e.ctrlKey || e.altKey) return;
    const sel = root.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const body = bodyOf(node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
    if (!body) return;
    const back = e.key === 'Backspace';
    let adjacent = null;
    if (node.nodeType === Node.TEXT_NODE) {
      if (back && r.startOffset === 0) adjacent = node.previousSibling;
      else if (!back && r.startOffset === node.nodeValue.length) adjacent = node.nextSibling;
    } else adjacent = back ? node.childNodes[r.startOffset - 1] : node.childNodes[r.startOffset];
    if (!adjacent || adjacent.nodeType !== Node.ELEMENT_NODE || !adjacent.classList.contains('fn-ref')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closePad();
    removeCall(adjacent);
  }
  function onClick(e) {
    const sup = e.target && e.target.closest ? e.target.closest('#editor-view .chapter-body sup.fn-ref') : null;
    if (sup) { e.preventDefault(); openPad(sup); return; }
    if (pad && !pad.contains(e.target)) closePad();
  }

  function watch() {
    const editor = document.getElementById('editor-view');
    if (!editor) return;
    editor.addEventListener('input', onInput, true);
    editor.addEventListener('keydown', guardDelete, true);
    document.addEventListener('mousedown', onClick, true);
    root.addEventListener('resize', () => { if (pad && pad.sup) place(pad.sup); });
    new MutationObserver(() => { if (pad && !document.contains(pad.sup)) closePad(); }).observe(editor, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();

  /* ---------- the exports, from the bridge ---------- */

  const finish = (fn) => async (content) => {
    try { return fn(content, await notesFor(hosted.state.bookId)); } catch (err) { console.error('footnotes left out of the export', err); return content; }
  };

  hosted.footnotes = Object.assign(api, {
    insertFootnote,
    openPad,
    html: finish(htmlWithNotes),
    epub: finish(epubEntries),
    docx: finish(docxEntries),
    txt: finish((text, notes) => txtWithNotes(text, notes, t('Notes').toUpperCase())),
    md: finish(mdWithNotes),
    notesFor
  });
  hosted.insertFootnote = insertFootnote;
}(typeof window !== 'undefined' ? window : globalThis));
