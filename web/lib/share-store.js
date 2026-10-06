'use strict';

// Public pages: a writer's choice to put a book, or one chapter, on the web
// as a read-only page. What is published is a snapshot, the same HTML the
// editor's "Web Page (.html)" export makes (built in the page, sent here),
// so sharing never reads the live draft and a later edit changes nothing
// until the writer publishes again. One page per (writer, book, chapter);
// publishing again keeps the link and replaces the words.
//
// Two stores, one contract, as for users: files under <data>/shares on a
// laptop, a table with Postgres. Every method may return a promise.
//
//   list(userId, bookId)           → [{ token, chapterId, title, updatedAt }]
//   find(token)                    → { token, userId, bookId, chapterId, title, html, updatedAt } | null
//   publish({ userId, bookId, chapterId, title, html }) → { token, chapterId, title, updatedAt }
//   remove(userId, token)          → true when something was removed
//   removeAll(userId)              → how many pages went (an account being removed)
//   countFor(userId)               → how many pages a writer has up
//
// A token is 16 random bytes, base64url: the link is the only key, so it
// cannot be guessed, and it carries nothing about the writer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeFileDurable, readJSON, writeJSON } = require('../../library-disk');

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const WHOLE_BOOK = '';                      // chapterId of a whole-book page; '' keeps the unique key simple
const newToken = () => crypto.randomBytes(16).toString('base64url');
const isToken = (token) => TOKEN.test(String(token || ''));

class JsonShareStore {
  constructor(dir) { this.dir = dir; }

  metaFile(token) { return path.join(this.dir, token + '.json'); }
  htmlFile(token) { return path.join(this.dir, token + '.html'); }

  all() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => readJSON(path.join(this.dir, n), null)).filter(Boolean);
  }

  list(userId, bookId) {
    return this.all().filter((s) => s.userId === userId && s.bookId === bookId).map(publicFields);
  }

  find(token) {
    if (!isToken(token)) return null;
    const meta = readJSON(this.metaFile(token), null);
    if (!meta) return null;
    let html;
    try { html = fs.readFileSync(this.htmlFile(token), 'utf8'); } catch { return null; }
    return { ...meta, html };
  }

  publish({ userId, bookId, chapterId = WHOLE_BOOK, title, html }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const existing = this.all().find((s) => s.userId === userId && s.bookId === bookId && s.chapterId === chapterId);
    const meta = { token: existing ? existing.token : newToken(), userId, bookId, chapterId, title, updatedAt: new Date().toISOString() };
    writeFileDurable(this.htmlFile(meta.token), html);
    writeJSON(this.metaFile(meta.token), meta);
    return publicFields(meta);
  }

  removeAll(userId) {
    const mine = this.all().filter((s) => s.userId === userId);
    for (const s of mine) this.remove(userId, s.token);
    return mine.length;
  }

  countFor(userId) { return this.all().filter((s) => s.userId === userId).length; }

  remove(userId, token) {
    if (!isToken(token)) return false;
    const meta = readJSON(this.metaFile(token), null);
    if (!meta || meta.userId !== userId) return false;
    // the .bak and .tmp go too: readJSON would otherwise bring a taken-down page back from them
    for (const file of [this.metaFile(token), this.metaFile(token) + '.bak', this.metaFile(token) + '.tmp', this.htmlFile(token), this.htmlFile(token) + '.tmp']) fs.rmSync(file, { force: true });
    return true;
  }
}

class PgShareStore {
  constructor(db) { this.db = db; }

  async list(userId, bookId) {
    const res = await this.db.query('SELECT token, chapter_id, title, updated_at FROM shares WHERE user_id = $1 AND book_id = $2 ORDER BY chapter_id', [userId, bookId]);
    return res.rows.map(rowFields);
  }

  async find(token) {
    if (!isToken(token)) return null;
    const res = await this.db.query('SELECT token, user_id, book_id, chapter_id, title, html, updated_at FROM shares WHERE token = $1', [token]);
    const row = res.rows[0];
    return row ? { ...rowFields(row), userId: row.user_id, bookId: row.book_id, html: row.html } : null;
  }

  async publish({ userId, bookId, chapterId = WHOLE_BOOK, title, html }) {
    const res = await this.db.query(`
      INSERT INTO shares (token, user_id, book_id, chapter_id, title, html)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, book_id, chapter_id)
      DO UPDATE SET title = EXCLUDED.title, html = EXCLUDED.html, updated_at = now()
      RETURNING token, chapter_id, title, updated_at`, [newToken(), userId, bookId, chapterId, title, html]);
    return rowFields(res.rows[0]);
  }

  async removeAll(userId) {
    return (await this.db.query('DELETE FROM shares WHERE user_id = $1', [userId])).rowCount;
  }

  async countFor(userId) {
    return Number((await this.db.query('SELECT count(*)::int AS n FROM shares WHERE user_id = $1', [userId])).rows[0].n);
  }

  async remove(userId, token) {
    if (!isToken(token)) return false;
    const res = await this.db.query('DELETE FROM shares WHERE user_id = $1 AND token = $2', [userId, token]);
    return res.rowCount > 0;
  }
}

const publicFields = ({ token, chapterId, title, updatedAt }) => ({ token, chapterId, title, updatedAt });
const rowFields = (row) => ({ token: row.token, chapterId: row.chapter_id, title: row.title, updatedAt: new Date(row.updated_at).toISOString() });

module.exports = { JsonShareStore, PgShareStore, isToken, WHOLE_BOOK };
