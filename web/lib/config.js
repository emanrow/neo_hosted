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
//   NEO_ADMIN_EMAILS     Who may open /admin (comma-separated addresses). Unset,
//                        the oldest account is the owner. Help → Send Feedback…
//                        emails these addresses too (with RESEND_API_KEY).
//   NEO_GUESTS_OF_HONOR  Addresses (comma-separated) that get a one-time welcome
//                        and thank-you when they first open the writing room:
//                        for the author of NEO, should he ever sign up.
//   NEO_BACKUP_BUCKET    An S3-compatible bucket that gets a copy of every daily
//                        zip. Unset, the zips stay on the volume only. With it:
//   AWS_ENDPOINT_URL     The service's address, "https://storage.railway.app".
//   AWS_REGION           "auto" on Railway and R2, "us-east-1" and friends on AWS.
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   The bucket's keys.
//                        These four are the names the AWS SDK reads, so Railway's
//                        "AWS SDK" preset on a Storage Bucket fills them in; each
//                        is also read as NEO_BACKUP_ENDPOINT, NEO_BACKUP_REGION,
//                        NEO_BACKUP_ACCESS_KEY_ID, NEO_BACKUP_SECRET_ACCESS_KEY.
//   NEO_BACKUP_PREFIX    Optional folder inside the bucket. NEO_BACKUP_PATH_STYLE=1
//                        for a service that wants the bucket on the path (MinIO).
//   NEO_PRINT_URL        The PDF printer (print/), "http://neo-print.railway.internal:8080".
//                        Unset, Export → PDF opens the browser's print view instead.
//   NEO_PRINT_SECRET     The word the printer expects; the same value on both
//                        services. Required with NEO_PRINT_URL.
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

function backupBucket(env) {
  const bucket = String(env.NEO_BACKUP_BUCKET || '').trim();
  if (!bucket) return null;
  const pick = (ours, theirs) => String(env[ours] || env[theirs] || '').trim();
  const store = {
    bucket,
    endpoint: pick('NEO_BACKUP_ENDPOINT', 'AWS_ENDPOINT_URL'),
    region: pick('NEO_BACKUP_REGION', 'AWS_REGION') || 'auto',
    accessKeyId: pick('NEO_BACKUP_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: pick('NEO_BACKUP_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'),
    prefix: String(env.NEO_BACKUP_PREFIX || '').trim(),
    pathStyle: env.NEO_BACKUP_PATH_STYLE === '1'
  };
  if (!store.endpoint) throw new Error('NEO_BACKUP_BUCKET needs AWS_ENDPOINT_URL (or NEO_BACKUP_ENDPOINT), the service address such as https://storage.railway.app');
  if (!/^https?:\/\//.test(store.endpoint)) throw new Error('AWS_ENDPOINT_URL must start with http:// or https://');
  if (!store.accessKeyId || !store.secretAccessKey) throw new Error('NEO_BACKUP_BUCKET needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or the NEO_BACKUP_ names)');
  return store;
}

function printer(env) {
  const url = String(env.NEO_PRINT_URL || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) throw new Error('NEO_PRINT_URL must start with http:// or https://, e.g. http://neo-print.railway.internal:8080');
  const secret = String(env.NEO_PRINT_SECRET || '').trim();
  if (!secret && env.NEO_DEV !== '1') throw new Error('NEO_PRINT_URL needs NEO_PRINT_SECRET, the same value the printer was given');
  return { url, secret };
}

/** A comma-separated list of addresses, trimmed and lowercased, as the user store normalizes them. */
const addressList = (value) => String(value || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

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
    databaseUrl: String(env.DATABASE_URL || env.NEO_DATABASE_URL || '').trim(),
    backupBucket: backupBucket(env),
    printer: printer(env),
    adminEmails: addressList(env.NEO_ADMIN_EMAILS),
    guestsOfHonor: addressList(env.NEO_GUESTS_OF_HONOR)
  };
}

module.exports = { loadConfig, SIGNUP_MODES };
