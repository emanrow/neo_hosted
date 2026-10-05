'use strict';

// Who can sign in. One JSON file today, because a hosted NEO for a handful
// of writers needs nothing more and "books are plain files" should extend to
// the people who own them. The class is the whole contract: when the day
// comes for Postgres (many thousands of writers, or more than one server
// instance behind the proxy), write a second store with these same methods
// and switch it in server.js. Nothing else knows how users are kept.
//
// `emailVerifiedAt` is null while a writer has not yet opened the link in
// their confirmation email, a date once they have, and absent on accounts
// made before email existed, which count as confirmed (isEmailVerified).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, writeJSON } = require('./files');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

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
    const normalized = normalizeEmail(email);
    if (!normalized) throw new Error('An email address is needed');
    if (users.some((u) => u.email === normalized)) throw new Error('That email already has an account');
    const now = new Date().toISOString();
    const user = { id: 'u-' + crypto.randomBytes(8).toString('hex'), email: normalized, passwordHash, createdAt: now, emailVerifiedAt: emailVerified ? now : null };
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

/** True unless the account is explicitly waiting on its confirmation link. */
const isEmailVerified = (user) => !user || user.emailVerifiedAt !== null;

module.exports = { JsonUserStore, normalizeEmail, isEmailVerified };
