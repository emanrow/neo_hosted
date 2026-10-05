'use strict';

// The revision log: every autosave that changed a chapter becomes a row,
// so a writer's history is finer than a daily zip and cheaper to keep. The
// files on the volume stay the chapter's truth; this log is additive, and a
// deployment without a database records nothing (NullRevisionLog).
//
// Each row is either a snapshot (the whole chapter) or a diff against its
// parent, with a snapshot forced every SNAPSHOT_EVERY rows so rebuilding a
// chapter never walks far. Diffs are at paragraph grain, which is what
// the editor's HTML naturally breaks into. Every row carries a hash of its
// content and a chain hash over the parent's chain hash, its own content
// hash and its timestamp, so the history of a chapter is an append-only
// chain whose timestamps cannot be rewritten without breaking it. That is
// the whole "proof of human work" story: a manuscript that grew at human
// cadence, quietly verifiable, never a certificate.
//
// Branches are already a column (`branch`, 'main' for now) so the coming
// alternate-draft feature is rows, not a migration.
//
// Gotchas:
// - record() must never fail a save. The handler catches and logs; the
//   file is already written by then.
// - Two autosaves of the same chapter in flight at once take an advisory
//   lock, so the chain never forks by accident.

const crypto = require('node:crypto');
const { diffArrays } = require('diff');

const SNAPSHOT_EVERY = 20;
const LIST_LIMIT = 200;

// After a block-level close tag (or an <hr>): the grain diffs are taken at.
const BLOCK_END = /(?<=<\/(?:p|h[1-6]|div|blockquote|ul|ol|pre|section)>|<hr\b[^>]*>)/i;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const splitBlocks = (html) => (html ? html.split(BLOCK_END) : []);
const countWords = (html) => (html.replace(/<[^>]*>/g, ' ').match(/\S+/g) || []).length;

/**
 * A compact diff between two HTMLs at block grain: a list of
 * [0, keep n] / [-1, drop n] / [1, [blocks to insert]] steps.
 */
function makeDiff(oldHtml, newHtml) {
  return diffArrays(splitBlocks(oldHtml), splitBlocks(newHtml)).map((part) => {
    if (part.added) return [1, part.value];
    return [part.removed ? -1 : 0, part.value.length];
  });
}

/** The inverse of makeDiff: the old HTML and the steps give back the new one. */
function applyDiff(oldHtml, steps) {
  const blocks = splitBlocks(oldHtml);
  const out = [];
  let at = 0;
  for (const [op, arg] of steps) {
    if (op === 1) out.push(...arg);
    else if (op === 0) { out.push(...blocks.slice(at, at + arg)); at += arg; }
    else at += arg;
  }
  return out.join('');
}

const chainHash = (parentChainHash, contentHash, createdAt) => sha256(`${parentChainHash || ''}\n${contentHash}\n${createdAt}`);

const rowToEntry = (row) => ({
  id: Number(row.id), branch: row.branch, kind: row.kind, chars: row.chars, words: row.words,
  contentHash: row.content_hash, chainHash: row.chain_hash, createdAt: new Date(row.created_at).toISOString()
});

class RevisionLog {
  /** @param {{ query(text: string, params?: unknown[]): Promise<{ rows: object[] }>, pool: import('pg').Pool }} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Appends a revision for this HTML unless it is byte-identical to the
   * head. Returns the new entry, or null when nothing changed.
   */
  async record({ userId, bookId, chapterId, branch = 'main', html }) {
    const text = String(html ?? '');
    const contentHash = sha256(text);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${userId}/${bookId}/${chapterId}/${branch}`]);
      const head = (await client.query(
        'SELECT * FROM revisions WHERE user_id = $1 AND book_id = $2 AND chapter_id = $3 AND branch = $4 ORDER BY id DESC LIMIT 1',
        [userId, bookId, chapterId, branch])).rows[0];
      if (head && head.content_hash === contentHash) { await client.query('COMMIT'); return null; }

      const depth = head && head.depth + 1 < SNAPSHOT_EVERY ? head.depth + 1 : 0;
      const kind = depth === 0 ? 'snapshot' : 'diff';
      const body = kind === 'snapshot' ? text : JSON.stringify(makeDiff(await this.rebuild(head.id, client), text));
      const createdAt = new Date().toISOString();
      const row = (await client.query(
        `INSERT INTO revisions (user_id, book_id, chapter_id, branch, parent_id, kind, depth, body, content_hash, chain_hash, chars, words, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [userId, bookId, chapterId, branch, head ? head.id : null, kind, depth, body, contentHash,
          chainHash(head && head.chain_hash, contentHash, createdAt), text.length, countWords(text), createdAt])).rows[0];
      await client.query('COMMIT');
      return rowToEntry(row);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** The chapter's revisions on a branch, newest first, without bodies. */
  async list({ userId, bookId, chapterId, branch = 'main' }) {
    const res = await this.db.query(
      'SELECT * FROM revisions WHERE user_id = $1 AND book_id = $2 AND chapter_id = $3 AND branch = $4 ORDER BY id DESC LIMIT $5',
      [userId, bookId, chapterId, branch, LIST_LIMIT]);
    return res.rows.map(rowToEntry);
  }

  /** One revision's HTML, rebuilt from the nearest snapshot. Null when it is not this writer's. */
  async read({ userId, id }) {
    const own = await this.db.query('SELECT id FROM revisions WHERE id = $1 AND user_id = $2', [Number(id) || 0, userId]);
    if (!own.rows.length) return null;
    return this.rebuild(Number(id));
  }

  /** Walks parents back to a snapshot, then replays the diffs forward. */
  async rebuild(id, client = this.db) {
    const res = await client.query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id, kind, body FROM revisions WHERE id = $1
         UNION ALL
         SELECT r.id, r.parent_id, r.kind, r.body FROM revisions r JOIN chain c ON r.id = c.parent_id WHERE c.kind <> 'snapshot'
       ) SELECT kind, body FROM chain ORDER BY id`, [id]);
    if (!res.rows.length || res.rows[0].kind !== 'snapshot') throw new Error(`Revision ${id} has no snapshot behind it`);
    return res.rows.slice(1).reduce((html, row) => applyDiff(html, JSON.parse(row.body)), res.rows[0].body);
  }

  /**
   * Recomputes every chain hash on a branch from the first row. True when
   * the chain is intact; the quiet proof that this history was not rewritten.
   */
  /** Every revision of one writer, gone (an account being removed; the library was zipped first). */
  async erase(userId) {
    return (await this.db.query('DELETE FROM revisions WHERE user_id = $1', [userId])).rowCount;
  }

  async verify({ userId, bookId, chapterId, branch = 'main' }) {
    const res = await this.db.query(
      'SELECT * FROM revisions WHERE user_id = $1 AND book_id = $2 AND chapter_id = $3 AND branch = $4 ORDER BY id',
      [userId, bookId, chapterId, branch]);
    let previous = null;
    for (const row of res.rows) {
      if (row.chain_hash !== chainHash(previous, row.content_hash, new Date(row.created_at).toISOString())) return false;
      previous = row.chain_hash;
    }
    return true;
  }
}

/** Stands in when there is no database: saves still succeed, history is simply not kept. */
class NullRevisionLog {
  async erase() { return 0; }
  async record() { return null; }
  async list() { return []; }
  async read() { return null; }
  async verify() { return true; }
}

module.exports = { RevisionLog, NullRevisionLog, makeDiff, applyDiff, splitBlocks, SNAPSHOT_EVERY };
