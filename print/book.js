'use strict';

// The trim sizes a writer may choose and the page each one makes. The
// margins are a book designer's: wider at the spine (inner) than the
// fore-edge (outer), and a little more at the foot than the head, mirrored
// on facing pages. The type is 11 on 15 at the trade-paperback sizes and a
// touch larger on office paper, which is read at arm's length.

const fs = require('node:fs');
const path = require('node:path');

const BOOK_CSS = fs.readFileSync(path.join(__dirname, 'book.css'), 'utf8');

/** name → page size (CSS), margins in inches [top, outer, bottom, inner], type size and leading in points */
const TRIMS = {
  '5.5x8.5': { label: '5.5 × 8.5 in', size: '5.5in 8.5in', widthIn: 5.5, heightIn: 8.5, margins: [0.75, 0.625, 0.875, 0.875], type: 11, leading: 15 },
  '6x9': { label: '6 × 9 in', size: '6in 9in', widthIn: 6, heightIn: 9, margins: [0.875, 0.75, 1, 1], type: 11.5, leading: 16 },
  'a5': { label: 'A5', size: 'A5', widthIn: 148 / 25.4, heightIn: 210 / 25.4, margins: [0.7, 0.6, 0.8, 0.8], type: 11, leading: 15 },
  'letter': { label: 'Letter', size: 'Letter', widthIn: 8.5, heightIn: 11, margins: [1, 1, 1, 1], type: 12, leading: 17 },
  'a4': { label: 'A4', size: 'A4', widthIn: 210 / 25.4, heightIn: 297 / 25.4, margins: [1, 1, 1, 1], type: 12, leading: 17 }
};
const DEFAULT_TRIM = '5.5x8.5';

/** How a scene break (the exporter's ***) is set on the page; the body gets class scene-<name> */
const SCENES = {
  asterisks: { label: 'Three asterisks' },
  ornament: { label: 'An ornament (❦)' },
  blank: { label: 'A blank line' }
};
const DEFAULT_SCENE = 'asterisks';

/** What the document is: a book, set with the trim's page and book.css; or a sheet (a chart, a plan) that brings its own @page and is printed as it comes */
const LAYOUTS = { book: { label: 'A book' }, sheet: { label: 'A sheet of its own size' } };
const DEFAULT_LAYOUT = 'book';

for (const trim of Object.values(TRIMS)) {
  const [top, outer, bottom, inner] = trim.margins;
  trim.contentWidthIn = trim.widthIn - inner - outer;
  trim.contentHeightIn = trim.heightIn - top - bottom;
}

/** The stylesheet Paged.js lays the book out with: the trim's page, then book.css. */
function bookStyles(name) {
  const trim = TRIMS[name] || TRIMS[DEFAULT_TRIM];
  const [top, outer, bottom, inner] = trim.margins;
  return `:root { --book-type-size: ${trim.type}pt; --book-leading: ${trim.leading}pt; }
@page { size: ${trim.size}; margin: ${top}in ${outer}in ${bottom}in ${inner}in; }
@page :left { margin-left: ${outer}in; margin-right: ${inner}in; }
@page :right { margin-left: ${inner}in; margin-right: ${outer}in; }
${BOOK_CSS}`;
}

module.exports = { TRIMS, DEFAULT_TRIM, SCENES, DEFAULT_SCENE, LAYOUTS, DEFAULT_LAYOUT, bookStyles };
