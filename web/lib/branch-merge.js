'use strict';

// Bringing a branch into the draft the writer is in. Chapter by chapter, a
// three-way merge (merge.js) between the branch's starting point (the
// .base snapshot branches.js kept when it was made), the branch now, and
// this draft now. preview() says what would happen and shows the blackline;
// apply() writes it, through the library so the revision log sees it, and
// then moves the branch's base forward so a second merge only carries what
// is new. Notes, outline, stickies and darlings are not merged: this draft
// keeps its own. A chapter deleted on the branch stays here; a chapter new
// on the branch is added after the chapter it follows there.

const { mergeChapter, blackline } = require('./merge');

const chapterLabel = (meta, chapterId) => {
  const title = meta && meta.chapterTitles && meta.chapterTitles[chapterId];
  const n = meta && Array.isArray(meta.chapterOrder) ? meta.chapterOrder.indexOf(chapterId) + 1 : 0;
  return title || (n ? `Chapter ${n}` : chapterId);
};

/** The merged chapter order: ours, with chapters new on the branch slotted in after their predecessor there. */
function mergeOrder(baseOrder, oursOrder, theirsOrder) {
  const order = [...oursOrder];
  theirsOrder.forEach((chapterId, i) => {
    if (order.includes(chapterId) || baseOrder.includes(chapterId)) return; // ours already, or deleted here on purpose
    const before = theirsOrder.slice(0, i).reverse().find((c) => order.includes(c));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, chapterId);
  });
  return order;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./branches').openBranches>} deps.branches
 * @param {ReturnType<import('./library').openLibrary>} deps.library
 */
function createMerger({ branches, library }) {
  function gather(bookId, name) {
    const active = branches.activeBranch(bookId);
    if (name === active) throw new Error('That is the draft you are in');
    const ours = library.readBookMeta(bookId) || { chapterOrder: [] };
    const theirs = branches.readMetaOf(bookId, name);
    const base = branches.readBaseMetaOf(bookId, name) || theirs;
    const order = mergeOrder(base.chapterOrder || [], ours.chapterOrder || [], theirs.chapterOrder || []);
    return { active, ours, theirs, base, order };
  }

  /** What merging `name` into the current draft would do: a row per chapter, conflicts with both versions, a blackline for changed ones. */
  function preview(bookId, name) {
    const { active, ours, theirs, order } = gather(bookId, name);
    const chapters = order.map((chapterId) => {
      const oursHtml = library.readChapter(bookId, chapterId);
      const theirsHtml = branches.readChapterOf(bookId, name, chapterId);
      const baseHtml = branches.readBaseChapterOf(bookId, name, chapterId);
      const merged = mergeChapter(baseHtml, oursHtml, theirsHtml);
      const status = merged.html === oursHtml ? (oursHtml === theirsHtml ? 'same' : 'kept') : (oursHtml === '' ? 'added' : merged.conflicts.length ? 'conflict' : 'merged');
      return {
        id: chapterId,
        label: chapterLabel(status === 'added' ? theirs : ours, chapterId),
        status,
        conflicts: merged.conflicts,
        blackline: status === 'same' || status === 'kept' ? '' : blackline(oursHtml, merged.html)
      };
    });
    return { into: active, from: name, chapters };
  }

  /** Writes the merge. `resolutions` is { "<chapterId>:<conflict index>": 'ours' | 'theirs' | 'both' }. */
  function apply(bookId, name, resolutions = {}) {
    const { ours, theirs, base, order } = gather(bookId, name);
    const written = [];
    for (const chapterId of order) {
      const oursHtml = library.readChapter(bookId, chapterId);
      const theirsHtml = branches.readChapterOf(bookId, name, chapterId);
      const baseHtml = branches.readBaseChapterOf(bookId, name, chapterId);
      const merged = mergeChapter(baseHtml, oursHtml, theirsHtml, (index) => resolutions[`${chapterId}:${index}`] || 'both');
      if (merged.html !== oursHtml) { library.writeChapter(bookId, chapterId, merged.html); written.push({ id: chapterId, html: merged.html }); }
    }
    const meta = { ...ours, chapterOrder: order, chapterTitles: { ...(ours.chapterTitles || {}) } };
    for (const chapterId of order) {
      const theirTitle = theirs.chapterTitles && theirs.chapterTitles[chapterId];
      const baseTitle = base.chapterTitles && base.chapterTitles[chapterId];
      const ourTitle = ours.chapterTitles && ours.chapterTitles[chapterId];
      if (theirTitle && theirTitle !== baseTitle && (ourTitle || '') === (baseTitle || '')) meta.chapterTitles[chapterId] = theirTitle;
    }
    library.writeBookMeta(bookId, meta);
    branches.moveBaseForward(bookId, name);
    return { into: branches.activeBranch(bookId), from: name, written };
  }

  return { preview, apply };
}

module.exports = { createMerger, mergeOrder, chapterLabel };
