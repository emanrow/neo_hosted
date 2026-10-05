'use strict';

// The one place that knows Postgres exists. A pool over DATABASE_URL, a
// `query` helper, and a migration runner that applies the numbered steps
// below exactly once each and records them in schema_migrations. Everything
// else talks to a store class (user-store.js) and never sees SQL.
//
// Migrations are plain SQL strings, appended in order and never edited once
// deployed: the runner skips the ids it has already recorded. A failed step
// rolls back and the server refuses to boot, which is the honest outcome.

const { Pool } = require('pg');

const MIGRATIONS = [
  {
    id: '001-users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id                TEXT PRIMARY KEY,
        email             TEXT NOT NULL UNIQUE,
        password_hash     TEXT NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        email_verified_at TIMESTAMPTZ
      );
    `
  },
  {
    id: '002-revisions',
    sql: `
      CREATE TABLE IF NOT EXISTS revisions (
        id           BIGSERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id),
        book_id      TEXT NOT NULL,
        chapter_id   TEXT NOT NULL,
        branch       TEXT NOT NULL DEFAULT 'main',
        parent_id    BIGINT REFERENCES revisions(id),
        kind         TEXT NOT NULL CHECK (kind IN ('snapshot', 'diff')),
        depth        INTEGER NOT NULL,
        body         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chain_hash   TEXT NOT NULL,
        chars        INTEGER NOT NULL,
        words        INTEGER NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_head ON revisions (user_id, book_id, chapter_id, branch, id DESC);
    `
  },
  {
    // A writer's library as rows: the folder layout of the desktop app, one
    // row per file, keyed by book and branch (pg-library.js). The daily zip
    // is written from these rows; nothing reads the volume for words.
    id: '003-library',
    sql: `
      CREATE TABLE IF NOT EXISTS libraries (
        user_id  TEXT PRIMARY KEY REFERENCES users(id),
        data     JSONB NOT NULL,
        modified TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS books (
        user_id       TEXT NOT NULL REFERENCES users(id),
        id            TEXT NOT NULL,
        active_branch TEXT NOT NULL DEFAULT 'main',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        trashed_at    TIMESTAMPTZ,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE IF NOT EXISTS branches (
        user_id      TEXT NOT NULL,
        book_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        created_from TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        trashed_at   TIMESTAMPTZ,
        PRIMARY KEY (user_id, book_id, name),
        FOREIGN KEY (user_id, book_id) REFERENCES books(user_id, id)
      );
      CREATE TABLE IF NOT EXISTS book_files (
        user_id  TEXT NOT NULL,
        book_id  TEXT NOT NULL,
        branch   TEXT NOT NULL,
        path     TEXT NOT NULL,
        body     TEXT,
        bytes    BYTEA,
        modified TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, book_id, branch, path),
        FOREIGN KEY (user_id, book_id, branch) REFERENCES branches(user_id, book_id, name) ON UPDATE CASCADE
      );
      CREATE TABLE IF NOT EXISTS branch_bases (
        user_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        branch  TEXT NOT NULL,
        path    TEXT NOT NULL,
        body    TEXT NOT NULL,
        PRIMARY KEY (user_id, book_id, branch, path),
        FOREIGN KEY (user_id, book_id, branch) REFERENCES branches(user_id, book_id, name) ON UPDATE CASCADE
      );
    `
  }
];

/**
 * @param {string} connectionString  DATABASE_URL; `sslmode=require` in it turns TLS on (Railway's public proxy needs it, its private network does not)
 * @param {{ max?: number }} [options]
 */
function openDatabase(connectionString, { max = 5 } = {}) {
  const pool = new Pool({ connectionString, max });
  pool.on('error', () => { /* an idle client dropped; the next query takes a fresh one */ });

  const query = (text, params = []) => pool.query(text, params);

  /** Applies every migration not yet recorded, in order, each in its own transaction. Returns the ids applied. */
  async function migrate() {
    await query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    const applied = [];
    for (const step of MIGRATIONS) {
      if (done.has(step.id)) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(step.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [step.id]);
        await client.query('COMMIT');
        applied.push(step.id);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${step.id} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }
    return applied;
  }

  /** Runs `work(client)` inside BEGIN/COMMIT on one connection, rolling back when it throws. */
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, query, transaction, migrate, close: () => pool.end() };
}

module.exports = { openDatabase, MIGRATIONS };
