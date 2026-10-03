'use strict';

// Everything the server needs to know arrives in the environment, so one
// image runs on Railway, in Docker, and on a laptop.
//
//   PORT                 Railway sets it. Default 8080.
//   NEO_DATA_DIR         Where writers' libraries live: a Railway volume. Default ./data.
//   NEO_SESSION_SECRET   Signs sessions and encrypts API keys. Required unless
//                        NEO_DEV=1, which makes a throwaway one (everyone is
//                        signed out at each restart).
//   NEO_SIGNUP           open | invite | closed. Default invite.
//   NEO_INVITE_CODE      The word a new writer types to join when NEO_SIGNUP=invite.
//   NEO_TRUST_PROXY      1 when a proxy terminates TLS (Railway does). Defaults
//                        to on when RAILWAY_ENVIRONMENT is set.
//
// Whatever the signup setting, the very first account can always be created:
// someone has to own a fresh deployment.

const crypto = require('node:crypto');
const path = require('node:path');

const SIGNUP_MODES = ['open', 'invite', 'closed'];

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
    trustProxy: env.NEO_TRUST_PROXY === '1' || (env.NEO_TRUST_PROXY !== '0' && !!env.RAILWAY_ENVIRONMENT)
  };
}

module.exports = { loadConfig, SIGNUP_MODES };
