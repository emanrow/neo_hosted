'use strict';

// Passwords, sessions and the links in email, with nothing but node:crypto.
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

// ---------------------------------------------------------------------------
// Links in email: "purpose.userId.expiry.stamp.signature"
//
// The HMAC key is derived from the session secret per purpose, so a link that
// confirms an email can never pass as a session or as a password reset. The
// stamp is a digest of some state the link should die with (the password
// hash, for a reset): once that state changes, the stamp no longer matches
// and a replayed link is refused. Nothing is stored server-side, as with
// sessions.
// ---------------------------------------------------------------------------

const LINK_TTL_MS = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 };

const linkKey = (secret, purpose) => Buffer.from(crypto.hkdfSync('sha256', String(secret), '', `neo-link:${purpose}`, 32));

/** A short, non-reversible digest of the state a link is tied to. */
const linkStamp = (state) => b64url(crypto.createHash('sha256').update(String(state || '')).digest()).slice(0, 22);

/** A one-purpose token for userId, good for LINK_TTL_MS[purpose] (or ttlMs). */
function signLink({ purpose, userId, stamp = linkStamp('') }, secret, ttlMs = LINK_TTL_MS[purpose]) {
  if (!LINK_TTL_MS[purpose]) throw new Error(`Unknown link purpose: ${purpose}`);
  const payload = [purpose, userId, Date.now() + ttlMs, stamp].join('.');
  return `${payload}.${sign(payload, linkKey(secret, purpose))}`;
}

/** `{ userId, stamp }` for a genuine, unexpired link of this purpose; null otherwise. The caller compares the stamp. */
function verifyLink(token, purpose, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== purpose) return null;
  const [, userId, expiry, stamp, signature] = parts;
  const expected = sign([purpose, userId, expiry, stamp].join('.'), linkKey(secret, purpose));
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return null;
  return { userId, stamp };
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

module.exports = { hashPassword, verifyPassword, signSession, verifySession, signLink, verifyLink, linkStamp, LoginThrottle, SESSION_TTL_MS, LINK_TTL_MS };
