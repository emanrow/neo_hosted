'use strict';

// Who can sign in. One JSON file today, because a hosted NEO for a handful
// of writers needs nothing more and "books are plain files" should extend to
// the people who own them. The class is the whole contract: when the day
// comes for Postgres (many thousands of writers, or more than one server
// instance behind the proxy), write a second store with these same five
// methods and switch it in server.js. Nothing else knows how users are kept.

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

  /** Adds a writer; throws when the email is taken. Ids are random, so an email change never moves a library folder. */
  create({ email, passwordHash }) {
    const users = this.load();
    const normalized = normalizeEmail(email);
    if (!normalized) throw new Error('An email address is needed');
    if (users.some((u) => u.email === normalized)) throw new Error('That email already has an account');
    const user = { id: 'u-' + crypto.randomBytes(8).toString('hex'), email: normalized, passwordHash, createdAt: new Date().toISOString() };
    this.save([...users, user]);
    return user;
  }

  setPasswordHash(id, passwordHash) {
    const users = this.load();
    const user = users.find((u) => u.id === id);
    if (!user) throw new Error('No such user');
    user.passwordHash = passwordHash;
    this.save(users);
  }
}

module.exports = { JsonUserStore, normalizeEmail };
