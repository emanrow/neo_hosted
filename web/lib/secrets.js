'use strict';

// A writer's API keys (today: the cover-art provider), encrypted at rest in
// their own secrets.json, outside the library folder, so a downloaded or
// backed-up library never carries a key. The desktop app uses the OS keychain
// for this; the server derives one key from NEO_SESSION_SECRET instead.
// Rotating that secret makes every stored key unreadable, which is the honest
// outcome: writers paste theirs in again.

const crypto = require('node:crypto');
const { readJSON, writeJSON } = require('./files');

function createSecretBox(masterSecret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', String(masterSecret), 'neo-hosted', 'secrets', 32));

  const seal = (plain) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };

  const open = (box) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  };

  return {
    /** The plain value, or null when absent or unreadable (a rotated secret). */
    read(file, name) {
      const all = readJSON(file, {});
      if (!all[name]) return null;
      try { return open(all[name]); } catch { return null; }
    },
    /** An empty value forgets the key, as in the desktop app. */
    write(file, name, value) {
      const all = readJSON(file, {});
      if (!value) delete all[name]; else all[name] = seal(value);
      writeJSON(file, all);
      return true;
    },
    has(file, name) { return this.read(file, name) !== null; }
  };
}

module.exports = { createSecretBox };
