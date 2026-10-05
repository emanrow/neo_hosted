'use strict';

// Merging two drafts of a chapter, paragraph by paragraph. A three-way merge
// over the editor's block-level HTML: `base` is the draft the branch was
// made from, `ours` the draft being merged into, `theirs` the branch. A
// paragraph changed on one side only takes that side; changed the same way
// on both, once; changed differently on both, a conflict the writer settles
// (keep mine, take theirs, or keep both, the default, since words are never
// discarded). Blocks are the same grain the revision log diffs at.
//
// Also the blackline: two drafts rendered as one, with what left in <del>
// and what came in <ins>, for the compare view.

const { diffArrays } = require('diff');
const { splitBlocks } = require('./revisions');

/**
 * base → side, as hunks over base positions: [start, end) replaced by `insert`.
 * A deletion followed by an insertion is one hunk (a replacement).
 */
function hunksOf(base, side) {
  const hunks = [];
  let at = 0;
  for (const part of diffArrays(base, side)) {
    if (part.added) {
      const last = hunks[hunks.length - 1];
      if (last && last.end === at && !last.closed) last.insert.push(...part.value);
      else hunks.push({ start: at, end: at, insert: [...part.value], closed: false });
    } else if (part.removed) {
      hunks.push({ start: at, end: at + part.value.length, insert: [], closed: false });
      at += part.value.length;
    } else {
      if (hunks.length) hunks[hunks.length - 1].closed = true;
      at += part.value.length;
    }
  }
  return hunks;
}

const sameBlocks = (a, b) => a.length === b.length && a.every((block, i) => block === b[i]);

/**
 * Three-way merge of block arrays. Returns segments: { blocks } for settled
 * text, { conflict: true, ours, theirs } where both sides changed the same
 * region differently.
 */
function merge3(base, ours, theirs) {
  const a = hunksOf(base, ours);
  const b = hunksOf(base, theirs);
  const segments = [];
  const settled = (blocks) => { if (blocks.length) segments.push({ blocks }); };
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ha = a[i];
    const hb = b[j];
    // the next hunk on either side; untouched base up to it is settled text
    const next = Math.min(ha ? ha.start : Infinity, hb ? hb.start : Infinity);
    settled(base.slice(at, next));
    at = next;
    // gather every hunk from either side that touches this region
    let end = at;
    const mine = [];
    const yours = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (i < a.length && a[i].start <= end && (a[i].start < end || a[i].end === a[i].start || end === at)) { end = Math.max(end, a[i].end); mine.push(a[i]); i++; grew = true; }
      while (j < b.length && b[j].start <= end && (b[j].start < end || b[j].end === b[j].start || end === at)) { end = Math.max(end, b[j].end); yours.push(b[j]); j++; grew = true; }
    }
    const applied = (hunks) => {
      const out = [];
      let pos = at;
      for (const h of hunks) { out.push(...base.slice(pos, h.start), ...h.insert); pos = h.end; }
      out.push(...base.slice(pos, end));
      return out;
    };
    const oursText = applied(mine);
    const theirsText = applied(yours);
    if (!mine.length || sameBlocks(oursText, theirsText)) settled(theirsText);
    else if (!yours.length) settled(oursText);
    else segments.push({ conflict: true, ours: oursText, theirs: theirsText });
    at = end;
  }
  settled(base.slice(at));
  return segments;
}

/**
 * Merges one chapter. `resolve(index)` answers 'ours', 'theirs' or 'both'
 * for conflict number `index` (default 'both'). Returns { html, conflicts }
 * where conflicts carry the two versions for the writer to see.
 */
function mergeChapter(baseHtml, oursHtml, theirsHtml, resolve = () => 'both') {
  const base = splitBlocks(baseHtml);
  const ours = splitBlocks(oursHtml);
  const theirs = splitBlocks(theirsHtml);
  if (sameBlocks(ours, theirs)) return { html: oursHtml, conflicts: [] };
  if (sameBlocks(theirs, base)) return { html: oursHtml, conflicts: [] };
  if (sameBlocks(ours, base)) return { html: theirsHtml, conflicts: [] };
  const out = [];
  const conflicts = [];
  for (const segment of merge3(base, ours, theirs)) {
    if (!segment.conflict) { out.push(...segment.blocks); continue; }
    const index = conflicts.length;
    conflicts.push({ index, ours: segment.ours.join(''), theirs: segment.theirs.join('') });
    const choice = resolve(index);
    if (choice === 'ours') out.push(...segment.ours);
    else if (choice === 'theirs') out.push(...segment.theirs);
    else out.push(...segment.ours, ...segment.theirs);
  }
  return { html: out.join(''), conflicts };
}

/** Two drafts as one page: blocks only in `from` wrapped in <del>, only in `to` in <ins>. */
function blackline(fromHtml, toHtml) {
  return diffArrays(splitBlocks(fromHtml), splitBlocks(toHtml)).map((part) => {
    const text = part.value.join('');
    if (part.added) return `<ins class="bl-ins">${text}</ins>`;
    if (part.removed) return `<del class="bl-del">${text}</del>`;
    return text;
  }).join('');
}

module.exports = { mergeChapter, merge3, blackline, hunksOf };
