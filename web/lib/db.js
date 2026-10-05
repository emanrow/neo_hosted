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

  return { pool, query, migrate, close: () => pool.end() };
}

module.exports = { openDatabase, MIGRATIONS };
