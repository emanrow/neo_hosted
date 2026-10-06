'use strict';

// What the printer does to an export's HTML before Chromium lays it out.
//
// The HTML is the one app.js's buildHtml makes for a PDF: a self-contained
// page with the book's fonts and cover inlined, @page rules for the folio
// at the foot of story pages (none on the front matter), and a contents
// page whose numbers are empty spans (class="toc-pg" data-for="s2") that
// the desktop's main.js fills by printing twice. Here Paged.js lays the book
// out into pages first, so the numbers come from CSS target-counter() and
// one print is enough. That is the one coupling to the editor's markup; a
// change to buildHtml's contents page shows up in prepare.test.js.

// A page size is one of the named sheets CSS knows, or a "W H" pair with
// units: the trim sizes the export dialog will offer. Nothing else reaches
// the stylesheet, since the size lands in a CSS rule as it is.
const SIZE_PATTERN = /^(?:Letter|Legal|A4|A5|B5|\d+(?:\.\d+)?(?:in|mm|cm) \d+(?:\.\d+)?(?:in|mm|cm))$/;
const DEFAULT_SIZE = 'A4';

/** The size the request asked for, or a reason it cannot be used. */
function pageSizeFrom(raw) {
  const size = String(raw || '').trim() || DEFAULT_SIZE;
  if (!SIZE_PATTERN.test(size)) return { error: `Unknown page size "${size.slice(0, 40)}"; use Letter, A4, A5 or a "6in 9in" pair` };
  return { size };
}

/**
 * The export, ready for Paged.js: the sheet, the rules Paged.js needs, the
 * hook that says when layout is done, and the contents page's spans given
 * the anchor they point at so target-counter can read the page it lands on.
 * Paged.js itself is added by the renderer as a script tag after the page
 * has loaded (its source would break an inline tag at the first "</script>").
 */
function prepareForPrint(html, { size = DEFAULT_SIZE } = {}) {
  if (typeof html !== 'string' || !/^\s*<!doctype html/i.test(html)) throw new Error('A whole web page is needed');
  if (!SIZE_PATTERN.test(size)) throw new Error(`Bad page size ${size}`);
  const setup = [
    // the sheet, before the book's own rules so a @page rule in the export
    // (the folio, the front matter) still wins where they overlap
    `<style>@page { size: ${size}; margin: 1in; }`,
    // the export centres itself for a browser window; a page has margins of its own
    'html, body { margin: 0 !important; padding: 0 !important; max-width: none !important; }',
    // the contents page's numbers: where each entry's section begins
    '.contents .toc-pg::after { content: target-counter(attr(data-href url), page); }</style>',
    '<script>window.PagedConfig = { auto: true, after: (flow) => { window.__neoPrintPages = flow.total; } };</script>'
  ].join('\n');
  // right after the charset, ahead of the book's own stylesheet, so the
  // book's @page rules are the later ones and win where they overlap
  const withSetup = /<meta charset="[^"]*">/i.test(html)
    ? html.replace(/<meta charset="[^"]*">/i, (meta) => `${meta}\n${setup}`)
    : html.replace(/<head>/i, `<head>\n${setup}`);
  // <a href="#s2"><span class="toc-t">…</span><span class="toc-pg" data-for="s2"></span></a>
  return withSetup.replace(/<a href="(#[^"]+)">(<span class="toc-t">[\s\S]*?<\/span>)<span class="toc-pg" data-for="([^"]+)">/g,
    (_, href, label, target) => `<a href="${href}">${label}<span class="toc-pg" data-for="${target}" data-href="${href}">`);
}

module.exports = { prepareForPrint, pageSizeFrom, DEFAULT_SIZE, SIZE_PATTERN };
