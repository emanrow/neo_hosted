/* =========================== NEO, HOSTED =========================== */
/* The EPUB, polished on its way out: the body face the writer chose    */
/* goes into the book as font files (readers may still override it),   */
/* and a drop cap opens each chapter when the editor shows one. The     */
/* entries come from app.js's own buildEpubEntries and leave as they    */
/* came, plus these; nothing in the editor changes. polishEntries is    */
/* pure (web/test/epub.test.js); the browser part gathers the faces.    */

(function (root) {
  'use strict';

  const FONT_MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
  const CSS_PATH = 'OEBPS/style.css';
  const OPF_PATH = 'OEBPS/content.opf';
  const FONT_DIR = 'OEBPS/fonts/';

  // a float, not an initial-letter: it is what e-readers understand, and a
  // chapter that opens with speech keeps its indent instead
  const DROPCAP_CSS = `
/* the drop cap the editor shows, two lines deep in the body face */
p.first:not(.dialogue)::first-letter { float: left; font-size: 3em; line-height: 0.82; padding: 0.05em 0.08em 0 0; }
`;

  /**
   * The zip entries of an EPUB with the chosen face and the drop cap laid in.
   * @param {Array<{path:string, content:string, base64?:boolean, store?:boolean}>} entries  as buildEpubEntries made them
   * @param {object} opts
   * @param {string} [opts.family]   the body face's family name, as the @font-face rules name it
   * @param {Array<{file:string, base64:string, weight:string|number, style:string}>} [opts.faces]  its files
   * @param {boolean} [opts.dropcap] whether chapters open with a drop cap
   * @returns a new array; the input is not touched
   */
  function polishEntries(entries, { family = '', faces = [], dropcap = false } = {}) {
    const out = entries.map((e) => ({ ...e }));
    const css = out.find((e) => e.path === CSS_PATH);
    const opf = out.find((e) => e.path === OPF_PATH);
    if (!css || !opf) return out;   // not the EPUB we know; leave it be
    const usable = family ? faces.filter((f) => f && f.file && f.base64 && FONT_MIME[ext(safeName(f.file))]) : [];
    if (usable.length) {
      const seen = new Set();
      const rules = [];
      const items = [];
      for (const face of usable) {
        const name = safeName(face.file);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ path: FONT_DIR + name, content: face.base64, base64: true });
        rules.push(`@font-face { font-family: "${family}"; src: url("fonts/${name}"); font-weight: ${face.weight || 400}; font-style: ${face.style || 'normal'}; }`);
        items.push(`<item id="font-${items.length + 1}" href="fonts/${name}" media-type="${FONT_MIME[ext(name)]}"/>`);
      }
      css.content = `${rules.join('\n')}\nbody { font-family: "${family}", serif; }\n${css.content}`;
      opf.content = opf.content.replace('</manifest>', `${items.join('\n')}\n</manifest>`);
    }
    if (dropcap) css.content += DROPCAP_CSS;
    return out;
  }

  const ext = (file) => String(file).split('.').pop().toLowerCase();
  const safeName = (file) => String(file).split(/[\\/]/).pop().split(/[?#]/)[0].replace(/[^\w.-]/g, '_');

  /** The @font-face files for one family, as the page's stylesheets declare them: the same walk exportFontFaces makes. */
  async function gatherFaces(family) {
    const faces = [];
    if (!family || typeof document === 'undefined') return faces;
    for (const sheet of document.styleSheets) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; }
      for (const r of rules) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        if (r.style.getPropertyValue('font-family').replace(/["']/g, '').trim() !== family) continue;
        const src = r.style.getPropertyValue('src').match(/url\(["']?([^"')]+)["']?\)/);
        if (!src) continue;
        try {
          const url = new URL(src[1], sheet.href || location.href);
          const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          faces.push({ file: url.pathname.split('/').pop(), base64: btoa(bin), weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal' });
        } catch { /* that face stays out; the name still stands with its fallbacks */ }
      }
    }
    return faces;
  }

  /** What exportSave calls for an EPUB: the entries with the writer's choices laid in. Never throws; on any trouble the EPUB goes out as it was. */
  async function polish(entries) {
    try {
      const lib = root.neo && root.neo.readLibrary ? await root.neo.readLibrary() : {};
      const fonts = (lib && lib.fonts) || {};
      // the face the page reads in, read the way the editor's own exporters read it (--body-font)
      const stack = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--body-font').trim() : '';
      const family = stack ? stack.split(',')[0].trim().replace(/^["']|["']$/g, '') : '';
      const faces = await gatherFaces(family);
      return polishEntries(entries, { family, faces, dropcap: fonts.dropcap !== 'none' });
    } catch {
      return entries;
    }
  }

  const api = { polishEntries, gatherFaces, polish, DROPCAP_CSS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.neoHosted) root.neoHosted.epub = api; else root.neoHostedEpub = api;
}(typeof window !== 'undefined' ? window : globalThis));
