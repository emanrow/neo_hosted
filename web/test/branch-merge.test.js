'use strict';

// Merging a branch back into the draft the writer is in: the base snapshot,
// the preview, the apply, and the base moving forward afterwards.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { openLibrary } = require('../lib/library');
const { openBranches } = require('../lib/branches');
const { createMerger, mergeOrder } = require('../lib/branch-merge');

const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-hosted-merge-'));
  const logError = () => {};
  const branches = openBranches({ dir, logError });
  const library = openLibrary({ dir, t: (k) => k, logError, bookDirFor: branches.folderFor });
  const merger = createMerger({ branches, library });
  const book = library.createBook({ title: 'Merge me' });
  library.writeBookMeta(book.id, { ...book, chapterOrder: ['ch-1', 'ch-2'], chapterTitles: { 'ch-1': 'Opening' } });
  library.writeChapter(book.id, 'ch-1', p('One.', 'Two.', 'Three.'));
  library.writeChapter(book.id, 'ch-2', p('Alpha.', 'Beta.'));
  return { dir, branches, library, merger, bookId: book.id };
}

describe('mergeOrder', () => {
  test('ours first, new chapters from the branch after their predecessor, deleted-here stays deleted', () => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'x', 'c', 'y']), ['a', 'x', 'c', 'y']);
    assert.deepEqual(mergeOrder([], [], ['n1', 'n2']), ['n1', 'n2']);
  });
});

describe('merging a branch into the current draft', () => {
  test('a branch keeps a base snapshot of where it started', () => {
    const { dir, branches, bookId } = setup();
    branches.create(bookId, 'alt');
    assert.equal(fs.readFileSync(path.join(dir, bookId, '.branches', 'alt', '.base', 'chapters', 'ch-1.html'), 'utf8'), p('One.', 'Two.', 'Three.'));
    assert.deepEqual(branches.readBaseMetaOf(bookId, 'alt').chapterOrder, ['ch-1', 'ch-2']);
    branches.create(bookId, 'alt 2');
    assert.ok(!fs.existsSync(path.join(dir, bookId, '.branches', 'alt 2', '.base', '.base')), 'a base is not copied into the next branch');
  });

  test('preview, then apply: one-sided edits land, conflicts are settled by the writer, titles and new chapters come along', async () => {
    const { branches, library, merger, bookId } = setup();
    branches.create(bookId, 'alt');
    // on the branch: edit ch-1 paragraph two, add a chapter, retitle ch-2
    library.writeChapter(bookId, 'ch-1', p('One.', 'Two, on the branch.', 'Three.'));
    library.writeChapter(bookId, 'ch-3', p('A new chapter.'));
    library.writeBookMeta(bookId, { ...library.readBookMeta(bookId), chapterOrder: ['ch-1', 'ch-2', 'ch-3'], chapterTitles: { 'ch-1': 'Opening', 'ch-2': 'Second' } });
    // on main meanwhile: edit ch-1 paragraph two differently, edit ch-2
    branches.switchTo(bookId, 'main');
    library.writeChapter(bookId, 'ch-1', p('One.', 'Two, on main.', 'Three.'));
    library.writeChapter(bookId, 'ch-2', p('Alpha, revised.', 'Beta.'));

    await assert.rejects(merger.preview(bookId, 'main'), /draft you are in/);
    const preview = await merger.preview(bookId, 'alt');
    assert.equal(preview.into, 'main');
    assert.deepEqual(preview.chapters.map((c) => [c.id, c.status, c.conflicts.length]), [['ch-1', 'conflict', 1], ['ch-2', 'kept', 0], ['ch-3', 'added', 0]]);
    assert.equal(preview.chapters[0].label, 'Opening');
    assert.equal(preview.chapters[2].label, 'Chapter 3');
    assert.deepEqual(preview.chapters[0].conflicts[0], { index: 0, ours: '<p>Two, on main.</p>', theirs: '<p>Two, on the branch.</p>' });
    assert.match(preview.chapters[0].blackline, /<ins class="bl-ins"><p>Two, on the branch.<\/p><\/ins>/);
    assert.match(preview.chapters[2].blackline, /^<ins class="bl-ins"><p>A new chapter.<\/p><\/ins>$/);

    const result = await merger.apply(bookId, 'alt', { 'ch-1:0': 'theirs' });
    assert.deepEqual(result.written.map((w) => w.id), ['ch-1', 'ch-3']);
    assert.equal(library.readChapter(bookId, 'ch-1'), p('One.', 'Two, on the branch.', 'Three.'));
    assert.equal(library.readChapter(bookId, 'ch-2'), p('Alpha, revised.', 'Beta.'), 'untouched on the branch, so ours stays');
    assert.equal(library.readChapter(bookId, 'ch-3'), p('A new chapter.'));
    const meta = library.readBookMeta(bookId);
    assert.deepEqual(meta.chapterOrder, ['ch-1', 'ch-2', 'ch-3']);
    assert.equal(meta.chapterTitles['ch-2'], 'Second', 'a title given on the branch comes along');

    // the base moved forward: merging again changes nothing
    const again = await merger.preview(bookId, 'alt');
    assert.ok(again.chapters.every((c) => c.status === 'same' || c.status === 'kept'), JSON.stringify(again.chapters.map((c) => c.status)));
    assert.equal((await merger.apply(bookId, 'alt')).written.length, 0);
  });

  test('keeping both is the default, and a deletion on the branch leaves this draft alone', async () => {
    const { branches, library, merger, bookId } = setup();
    branches.create(bookId, 'cut');
    library.writeChapter(bookId, 'ch-1', p('One.', 'Three.'));
    library.writeBookMeta(bookId, { ...library.readBookMeta(bookId), chapterOrder: ['ch-1'] });
    branches.switchTo(bookId, 'main');
    library.writeChapter(bookId, 'ch-1', p('One.', 'Two, kept and polished.', 'Three.'));
    const result = await merger.apply(bookId, 'cut');
    assert.equal(result.written.length, 0, 'ours plus nothing is ours: no chapter rewritten');
    assert.equal(library.readChapter(bookId, 'ch-1'), p('One.', 'Two, kept and polished.', 'Three.'), 'our edit against their deletion: ours stays (both = ours + nothing)');
    assert.deepEqual(library.readBookMeta(bookId).chapterOrder, ['ch-1', 'ch-2'], 'the chapter they dropped stays here');
  });
});
