'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { mergeChapter, merge3, blackline } = require('../lib/merge');

const p = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');

describe('three-way merge of a chapter', () => {
  test('a change on one side only takes that side', () => {
    const base = p('One.', 'Two.', 'Three.');
    assert.deepEqual(mergeChapter(base, p('One.', 'Two.', 'Three.'), p('One.', 'Two, better.', 'Three.')), { html: p('One.', 'Two, better.', 'Three.'), conflicts: [] });
    assert.deepEqual(mergeChapter(base, p('One, mine.', 'Two.', 'Three.'), base), { html: p('One, mine.', 'Two.', 'Three.'), conflicts: [] });
  });

  test('changes to different paragraphs on both sides both land', () => {
    const base = p('One.', 'Two.', 'Three.', 'Four.');
    const ours = p('One, mine.', 'Two.', 'Three.', 'Four.');
    const theirs = p('One.', 'Two.', 'Three.', 'Four, theirs.', 'Five, new.');
    assert.deepEqual(mergeChapter(base, ours, theirs), { html: p('One, mine.', 'Two.', 'Three.', 'Four, theirs.', 'Five, new.'), conflicts: [] });
  });

  test('the same change on both sides lands once', () => {
    const base = p('One.', 'Two.');
    const same = p('One.', 'Two, agreed.');
    assert.deepEqual(mergeChapter(base, same, same), { html: same, conflicts: [] });
  });

  test('the same paragraph changed differently is a conflict, kept both ways by default', () => {
    const base = p('One.', 'Two.', 'Three.');
    const ours = p('One.', 'Two, mine.', 'Three.');
    const theirs = p('One.', 'Two, theirs.', 'Three.');
    const merged = mergeChapter(base, ours, theirs);
    assert.equal(merged.conflicts.length, 1);
    assert.deepEqual(merged.conflicts[0], { index: 0, ours: '<p>Two, mine.</p>', theirs: '<p>Two, theirs.</p>' });
    assert.equal(merged.html, p('One.', 'Two, mine.', 'Two, theirs.', 'Three.'));
    assert.equal(mergeChapter(base, ours, theirs, () => 'ours').html, ours);
    assert.equal(mergeChapter(base, ours, theirs, () => 'theirs').html, theirs);
  });

  test('a deletion against an edit is a conflict; a deletion against nothing is a deletion', () => {
    const base = p('One.', 'Two.', 'Three.');
    assert.deepEqual(mergeChapter(base, p('One.', 'Three.'), base), { html: p('One.', 'Three.'), conflicts: [] });
    const merged = mergeChapter(base, p('One.', 'Three.'), p('One.', 'Two, theirs.', 'Three.'));
    assert.equal(merged.conflicts.length, 1);
    assert.deepEqual(merged.conflicts[0], { index: 0, ours: '', theirs: '<p>Two, theirs.</p>' });
    assert.equal(merged.html, p('One.', 'Two, theirs.', 'Three.'), 'both = the words come back');
  });

  test('insertions at the same place from both sides keep both', () => {
    const base = p('One.', 'Two.');
    const merged = mergeChapter(base, p('One.', 'Mine.', 'Two.'), p('One.', 'Theirs.', 'Two.'));
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.html, p('One.', 'Mine.', 'Theirs.', 'Two.'));
  });

  test('an empty base: a new chapter written on both sides', () => {
    const merged = mergeChapter('', p('Mine.'), p('Theirs.'));
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.html, p('Mine.', 'Theirs.'));
    assert.deepEqual(mergeChapter('', '', p('Theirs.')), { html: p('Theirs.'), conflicts: [] });
  });

  test('merge3 settles untouched text around several hunks in order', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'];
    const segments = merge3(base, ['a', 'B', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'E', 'f', 'g']);
    assert.deepEqual(segments.map((s) => s.conflict ? 'conflict' : s.blocks.join('')), ['a', 'B', 'cd', 'E', 'f', 'g']);
  });
});

describe('blackline', () => {
  test('wraps what left and what came in', () => {
    assert.equal(blackline(p('One.', 'Two.', 'Three.'), p('One.', 'Two, new.', 'Three.')),
      '<p>One.</p><del class="bl-del"><p>Two.</p></del><ins class="bl-ins"><p>Two, new.</p></ins><p>Three.</p>');
    assert.equal(blackline('', ''), '');
  });
});
