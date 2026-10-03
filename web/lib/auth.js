'use strict';

// Passwords and sessions with nothing but node:crypto.
//
// Passwords: scrypt, parameters recorded in the stored string so they can be
// raised later and old hashes still verify. Sessions: a signed token in an
// HttpOnly cookie, "userId.expiry.signature"; nothing is stored server-side,
// so a restart signs nobody out and a leaked database cannot mint sessions
// without the secret. Rotating NEO_SESSION_SECRET signs everyone out.

const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLength: 32 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(hash)].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sign(payload, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

/** A session token for userId, good for ttlMs (30 days by default). */
function signSession(userId, secret, ttlMs = SESSION_TTL_MS) {
  const payload = `${userId}.${Date.now() + ttlMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** The userId inside a token, or null when it is forged, malformed or expired. */
function verifySession(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiry, signature] = parts;
  const expected = sign(`${userId}.${expiry}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return null;
  return userId;
}

/**
 * Slows a password guesser down: after `limit` failures from one key (an IP
 * or an email) within `windowMs`, further attempts are refused until the
 * window passes. In memory on purpose; a restart forgives, which is fine.
 */
class LoginThrottle {
  constructor({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.failures = new Map(); // key -> [timestamps]
  }

  recent(key) {
    const cutoff = Date.now() - this.windowMs;
    const kept = (this.failures.get(key) || []).filter((ts) => ts > cutoff);
    if (kept.length) this.failures.set(key, kept); else this.failures.delete(key);
    return kept;
  }

  allowed(key) { return this.recent(key).length < this.limit; }
  failed(key) { this.failures.set(key, [...this.recent(key), Date.now()]); }
  clear(key) { this.failures.delete(key); }
}

module.exports = { hashPassword, verifyPassword, signSession, verifySession, LoginThrottle, SESSION_TTL_MS };
