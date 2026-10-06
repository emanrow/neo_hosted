'use strict';

// Soft hyphens for the book, put in before Paged.js runs. Chromium's own
// `hyphens: auto` needs a dictionary it downloads through its component
// updater, which a headless browser in a container never runs, so the
// book's justified lines would otherwise be set without a single broken
// word (the gaps show). Liang's patterns (the `hyphen` package, one module
// per language) put a U+00AD at each break the browser may use; where no
// line breaks there, nothing shows.

const LANGUAGE_MODULES = {
  en: 'en-us', de: 'de', el: 'el', es: 'es', fr: 'fr', it: 'it', nl: 'nl', pl: 'pl', pt: 'pt', ro: 'ro', ru: 'ru', tr: 'tr'
};
const loaded = new Map();

/** The `hyphen` module for a locale (`pt-PT` → pt, `en` → en-us), or null for one we have no patterns for. */
function patternsFor(locale) {
  const base = String(locale || '').toLowerCase().split(/[-_]/)[0];
  const name = LANGUAGE_MODULES[base];
  if (!name) return null;
  if (!loaded.has(name)) loaded.set(name, require(`hyphen/${name}`).hyphenateSync);
  return loaded.get(name);
}

// a paragraph of running text; not the author line under the title (a
// running head is set from it), a byline, an attribution or a scene break
const PARAGRAPH = /<p\b([^>]*)>[\s\S]*?<\/p>/gi;
const NOT_PROSE = /\bclass="[^"]*\b(auth|byline|attr|brk)\b/;

/**
 * The export document with soft hyphens in its paragraphs. Headings, the
 * contents page and the lines a running head is set from are left as they
 * are (a broken word in a centred heading is no book's), as are tags and
 * attributes (the library skips them) and the <head> with its embedded
 * fonts. A locale without patterns gets the document back unchanged.
 * @param {string} html
 * @param {string} [locale]
 */
function softHyphens(html, locale) {
  const hyphenate = patternsFor(locale);
  const at = html.search(/<body[\s>]/i);
  if (!hyphenate || at < 0) return html;
  return html.slice(0, at) + html.slice(at).replace(PARAGRAPH, (p, attrs) => (NOT_PROSE.test(attrs) ? p : hyphenate(p)));
}

module.exports = { softHyphens, patternsFor, LANGUAGE_MODULES };
