'use strict';

// Who can sign in. Two stores with one contract: JsonUserStore keeps a
// users.json on the data folder (a laptop, a household), PgUserStore keeps a
// table in Postgres (the hosted site). server.js picks one from the config
// and nothing else knows how users are kept.
//
// The contract: count, listIds, list, findByEmail, findById, create, setPasswordHash,
// markEmailVerified, update, remove (the row alone; server.js empties what
// hangs off a writer first). Every method MAY return a promise, so callers
// always await; the JSON store happens to be synchronous. A user is
// { id, email, passwordHash, createdAt, emailVerifiedAt }.
//
// `emailVerifiedAt` is null while a writer has not yet opened the link in
// their confirmation email, a date once they have, and absent on accounts
// made before email existed, which count as confirmed (isEmailVerified).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, writeJSON } = require('./files');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const newUserId = () => 'u-' + crypto.randomBytes(8).toString('hex');

function checkNewEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('An email address is needed');
  return normalized;
}

class JsonUserStore {
  /** @param {string} file  users.json under the data folder */
  constructor(file) {
    this.file = file;
  }

  load() {
    const data = readJSON(this.file, { users: [] });
    return Array.isArray(data.users) ? data.users : [];
  }

  save(users) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJSON(this.file, { users });
  }

  count() { return this.load().length; }

  listIds() { return this.load().map((u) => u.id); }

  /** Everyone, oldest first, as stored (password hashes included: callers pick what to show). */
  list() { return [...this.load()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); }

  remove(id) {
    const users = this.load();
    const kept = users.filter((u) => u.id !== id);
    if (kept.length === users.length) return false;
    this.save(kept);
    return true;
  }

  findByEmail(email) {
    const wanted = normalizeEmail(email);
    return this.load().find((u) => u.email === wanted) || null;
  }

  findById(id) {
    return this.load().find((u) => u.id === id) || null;
  }

  /**
   * Adds a writer; throws when the email is taken. Ids are random, so an email
   * change never moves a library folder. `emailVerified: false` leaves the
   * account waiting for its confirmation link.
   */
  create({ email, passwordHash, emailVerified = true }) {
    const users = this.load();
    const normalized = checkNewEmail(email);
    if (users.some((u) => u.email === normalized)) throw new Error(EMAIL_TAKEN);
    const now = new Date().toISOString();
    const user = { id: newUserId(), email: normalized, passwordHash, createdAt: now, emailVerifiedAt: emailVerified ? now : null };
    this.save([...users, user]);
    return user;
  }

  setPasswordHash(id, passwordHash) {
    this.update(id, (user) => { user.passwordHash = passwordHash; });
  }

  markEmailVerified(id) {
    this.update(id, (user) => { if (!isEmailVerified(user)) user.emailVerifiedAt = new Date().toISOString(); });
  }

  /** Loads, lets `change` edit the one user in place, saves. Throws when the id is unknown. */
  update(id, change) {
    const users = this.load();
    const user = users.find((u) => u.id === id);
    if (!user) throw new Error('No such user');
    change(user);
    this.save(users);
    return user;
  }
}

/** The same contract over a Postgres table (db.js owns the schema). Methods return promises. */
class PgUserStore {
  /** @param {{ query(text: string, params?: unknown[]): Promise<{ rows: object[] }> }} db  from openDatabase() */
  constructor(db) {
    this.db = db;
  }

  async count() {
    return Number((await this.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n);
  }

  async listIds() {
    return (await this.db.query('SELECT id FROM users ORDER BY created_at')).rows.map((r) => r.id);
  }

  async list() {
    return (await this.db.query('SELECT * FROM users ORDER BY created_at')).rows.map(rowToUser);
  }

  async remove(id) {
    return (await this.db.query('DELETE FROM users WHERE id = $1', [String(id || '')])).rowCount > 0;
  }

  async findByEmail(email) {
    return rowToUser((await this.db.query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)])).rows[0]);
  }

  async findById(id) {
    return rowToUser((await this.db.query('SELECT * FROM users WHERE id = $1', [String(id || '')])).rows[0]);
  }

  async create({ email, passwordHash, emailVerified = true }) {
    const normalized = checkNewEmail(email);
    const user = { id: newUserId(), email: normalized, passwordHash, createdAt: new Date().toISOString(), emailVerifiedAt: null };
    user.emailVerifiedAt = emailVerified ? user.createdAt : null;
    try {
      await this.db.query('INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES ($1, $2, $3, $4, $5)',
        [user.id, user.email, user.passwordHash, user.createdAt, user.emailVerifiedAt]);
    } catch (err) {
      if (err.code === '23505') throw new Error(EMAIL_TAKEN); // unique_violation on email
      throw err;
    }
    return user;
  }

  async setPasswordHash(id, passwordHash) {
    await this.update(id, 'password_hash = $2', [passwordHash]);
  }

  async markEmailVerified(id) {
    await this.update(id, 'email_verified_at = COALESCE(email_verified_at, now())', []);
  }

  /** One UPDATE on one user; `assignment` is SQL with $2.. for `params`. Throws when the id is unknown. */
  async update(id, assignment, params) {
    const res = await this.db.query(`UPDATE users SET ${assignment} WHERE id = $1 RETURNING *`, [String(id || ''), ...params]);
    if (!res.rows.length) throw new Error('No such user');
    return rowToUser(res.rows[0]);
  }

  /**
   * Brings a JSON store's writers into an empty table, keeping their ids so
   * their library folders still belong to them. Does nothing when the table
   * already has anyone. Returns how many were imported.
   */
  async importFrom(jsonStore) {
    if (await this.count() > 0) return 0;
    const users = jsonStore.load();
    for (const u of users) {
      await this.db.query(
        'INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
        [u.id, normalizeEmail(u.email), u.passwordHash, u.createdAt || new Date().toISOString(), u.emailVerifiedAt === null ? null : (u.emailVerifiedAt || u.createdAt || new Date().toISOString())]
      );
    }
    return users.length;
  }
}

const EMAIL_TAKEN = 'That email already has an account';

const isoOrNull = (value) => (value == null ? null : new Date(value).toISOString());

function rowToUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: isoOrNull(row.created_at), emailVerifiedAt: isoOrNull(row.email_verified_at) };
}

/** True unless the account is explicitly waiting on its confirmation link. */
const isEmailVerified = (user) => !user || user.emailVerifiedAt !== null;

module.exports = {
  EMAIL_TAKEN, JsonUserStore, PgUserStore, normalizeEmail, isEmailVerified };
