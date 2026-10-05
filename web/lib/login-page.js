'use strict';

const { versionAssets } = require('./page');

// The sign-in page in the visitor's language. login.html is upstream-free
// and ours, so it is a plain template: every `{{English text}}` is replaced
// by its translation, HTML-escaped, and the strings login.js needs at run
// time (mode labels, notices) ride along in a JSON block the page reads.
// The CSP allows no inline script; a JSON block is data, not script.
//
// The three credit lines carry links, so they are built here from their
// translations with {author} and {edition} filled in after escaping.

const MARKER = /\{\{([^{}]+)\}\}/g;
const CREDIT_AUTHOR = '<a href="https://github.com/hughhowey/neo" rel="noopener" target="_blank">Hugh Howey</a>';
const CREDIT_EDITION = (text) => `<a href="https://github.com/emanrow/neo_hosted" rel="noopener" target="_blank">${text}</a>`;

/** What login.js says on its own: the keys it asks t() for. */
const PAGE_STRINGS = [
  'Sign in', 'Create an account', 'Create account', 'I already have an account', 'Email me a reset link', 'Back to sign in',
  'Set new password', 'Password', 'New password', 'Could not sign in',
  'That link has expired or was already used. Sign in to get a new one, or ask for a password reset.',
  'If that address has an account here, a reset link is on its way. Check your email.',
  'Almost there. We sent a confirmation link to your email; open it to start writing.'
];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {string} html   web/public/login.html
 * @param {{ locale: string, t: (key: string, vars?: object) => string, assetVersion?: string }} language  and the deploy's asset fingerprint (page.js)
 */
function buildLoginPage(html, { locale, t, assetVersion }) {
  const credits = [
    escapeHtml(t('NEO is the word processor for authors written by {author}, MIT licensed.')).replace('{author}', CREDIT_AUTHOR),
    escapeHtml(t('This is an independent {edition}, not affiliated with or endorsed by him.')).replace('{edition}', CREDIT_EDITION(escapeHtml(t('hosted edition')))),
    escapeHtml(t('Your books are yours: download your whole library any time from the File menu.'))
  ].join('<br />\n      ');
  const strings = {};
  for (const key of PAGE_STRINGS) strings[key] = t(key);
  const json = JSON.stringify(strings).replace(/</g, '\\u003c');
  return versionAssets(html, assetVersion)
    .replace('<html lang="en">', `<html lang="${escapeHtml(locale)}">`)
    .replace('{{credits}}', credits)
    .replace('{{strings}}', `<script type="application/json" id="login-strings">${json}</script>`)
    .replace(MARKER, (m, key) => escapeHtml(t(key)));
}

module.exports = { buildLoginPage, PAGE_STRINGS };
