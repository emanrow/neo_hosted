'use strict';

// The little bit of HTTP plumbing a node:http server needs and a framework
// would otherwise bring: bodies with a ceiling, JSON and file responses,
// cookies, and a same-origin check for the API.

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm'
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The whole request body, or a 413 HttpError past `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSONBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Malformed JSON'); }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const sendJSON = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
const sendHTML = (res, status, html, extra = {}) => send(res, status, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...extra });
const sendText = (res, status, text) => send(res, status, text, { 'Content-Type': MIME['.txt'], 'Cache-Control': 'no-store' });
const redirect = (res, to) => send(res, 302, '', { Location: to, 'Cache-Control': 'no-store' });

/** Streams a file with its type; false when it is not there. `root` fences the path. */
function serveFile(res, root, relative, { cache = 'public, max-age=3600' } = {}) {
  const file = path.normalize(path.join(root, relative));
  if (!file.startsWith(path.normalize(root + path.sep)) && file !== root) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(name, value, { maxAge, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Was this request made by our own page? Modern browsers say so in
 * Sec-Fetch-Site; older ones at least send Origin on a cross-site POST.
 * Together with SameSite=Lax cookies this is the CSRF defence.
 */
function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin: not a browser's cross-site request
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/** The client address, trusting X-Forwarded-For only behind a proxy we own. */
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function isSecureRequest(req, trustProxy) {
  if (req.socket.encrypted) return true;
  return trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

module.exports = {
  MIME, HttpError, readBody, readJSONBody, send, sendJSON, sendHTML, sendText, redirect,
  serveFile, parseCookies, cookieHeader, isSameOrigin, clientAddress, isSecureRequest
};
