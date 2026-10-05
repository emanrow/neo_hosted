'use strict';

// Everything the server needs to know arrives in the environment, so one
// image runs on Railway, in Docker, and on a laptop.
//
//   PORT                 Railway sets it. Default 8080.
//   NEO_DATA_DIR         Where writers' libraries live: a Railway volume. Default ./data.
//   NEO_SESSION_SECRET   Signs sessions and email links, encrypts API keys. Required
//                        unless NEO_DEV=1, which makes a throwaway one (everyone is
//                        signed out at each restart).
//   NEO_SIGNUP           open | invite | closed. Default invite.
//   NEO_INVITE_CODE      The word a new writer types to join when NEO_SIGNUP=invite.
//   NEO_TRUST_PROXY      1 when a proxy terminates TLS (Railway does). Defaults
//                        to on when RAILWAY_ENVIRONMENT is set.
//   RESEND_API_KEY       Turns email on: new writers confirm their address, and
//                        passwords can be reset. Unset, there is no email at all.
//   NEO_MAIL_FROM        The sender Resend has verified, "NEO <neo@example.com>".
//                        Required with RESEND_API_KEY.
//   NEO_PUBLIC_URL       Where the site lives, "https://neo.example.com", for the
//                        links in email. Required with RESEND_API_KEY unless
//                        NEO_DEV=1, which falls back to the request's own host.
//   DATABASE_URL         Postgres, for accounts (Railway sets it when its Postgres
//                        is referenced). Unset, accounts live in users.json. With
//                        it set, an existing users.json is imported once, on boot.
//                        NEO_DATABASE_URL is read too, for a hand-named variable.
//
// Whatever the signup setting, the very first account can always be created:
// someone has to own a fresh deployment.

const crypto = require('node:crypto');
const path = require('node:path');

const SIGNUP_MODES = ['open', 'invite', 'closed'];

function publicUrlFrom(env, dev) {
  const raw = String(env.NEO_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!raw) {
    if (env.RESEND_API_KEY && !dev) throw new Error('RESEND_API_KEY needs NEO_PUBLIC_URL, the address writers open (https://...), so links in email point home');
    return '';
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('NEO_PUBLIC_URL must be a full address such as https://neo.example.com'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('NEO_PUBLIC_URL must start with http:// or https://');
  return raw;
}

function mailFrom(env) {
  if (!env.RESEND_API_KEY) return null;
  if (!env.NEO_MAIL_FROM) throw new Error('RESEND_API_KEY needs NEO_MAIL_FROM, the verified sender, e.g. "NEO <neo@example.com>"');
  return { resendApiKey: env.RESEND_API_KEY, from: env.NEO_MAIL_FROM };
}

function loadConfig(env = process.env) {
  const dev = env.NEO_DEV === '1';
  let sessionSecret = env.NEO_SESSION_SECRET;
  if (!sessionSecret) {
    if (!dev) throw new Error('NEO_SESSION_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }
  if (sessionSecret.length < 32 && !dev) throw new Error('NEO_SESSION_SECRET should be at least 32 characters');

  const signup = env.NEO_SIGNUP || 'invite';
  if (!SIGNUP_MODES.includes(signup)) throw new Error(`NEO_SIGNUP must be one of ${SIGNUP_MODES.join(', ')}`);
  if (signup === 'invite' && !env.NEO_INVITE_CODE && !dev) throw new Error('NEO_SIGNUP=invite needs NEO_INVITE_CODE');

  return {
    dev,
    port: Number(env.PORT) || 8080,
    dataDir: path.resolve(env.NEO_DATA_DIR || path.join(__dirname, '..', 'data')),
    sessionSecret,
    signup,
    inviteCode: env.NEO_INVITE_CODE || '',
    trustProxy: env.NEO_TRUST_PROXY === '1' || (env.NEO_TRUST_PROXY !== '0' && !!env.RAILWAY_ENVIRONMENT),
    mail: mailFrom(env),
    publicUrl: publicUrlFrom(env, dev),
    databaseUrl: String(env.DATABASE_URL || env.NEO_DATABASE_URL || '').trim()
  };
}

module.exports = { loadConfig, SIGNUP_MODES };
