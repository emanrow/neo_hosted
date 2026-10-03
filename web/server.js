'use strict';

// NEO, hosted. One node:http server that serves the desktop app's own page
// and scripts, signs writers in, and answers the window.neo calls that
// main.js answers on the desktop, against a plain-file NEO Library per
// writer on a persistent volume. No framework, no bundler, no database.
//
//   node web/server.js             (NEO_SESSION_SECRET set, or NEO_DEV=1)
//
// Routes
//   GET  /                         the writing room (signed in) or → /login
//   GET  /login, /web/*, /app.js, /styles.css, /covers.js, /i18n.js,
//        /jszip.min.js, /fonts/*, /locales/*       public static files
//   POST /auth/signup | /auth/login | /auth/logout
//   POST /api/<channel>            { args: [...] } → { ok, result | error }   (see lib/handlers.js)
//   POST /api/cover:upload?bookId=&ext=            raw image bytes → file name
//   GET  /library/<bookId>/<cover-or-art file>     cover images for the shelf
//   GET  /healthz

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig } = require('./lib/config');
const { HttpError, readBody, readJSONBody, sendJSON, sendHTML, sendText, redirect, serveFile, parseCookies, cookieHeader, isSameOrigin, clientAddress, isSecureRequest } = require('./lib/http');
const { hashPassword, verifyPassword, signSession, verifySession, LoginThrottle, SESSION_TTL_MS } = require('./lib/auth');
const { JsonUserStore, normalizeEmail } = require('./lib/user-store');
const { createSecretBox } = require('./lib/secrets');
const { openLibrary, COVER_EXTS } = require('./lib/library');
const { registerHandlers } = require('./lib/handlers');
const { SpellService, SPELL_LANGUAGES } = require('./lib/spell');
const { buildHostedPage, PAGE_CSP } = require('./lib/page');
const { readJSON, writeJSON, libName } = require('./lib/files');
const i18n = require('./lib/i18n');

const ROOT = path.join(__dirname, '..');            // the desktop app: app.js, styles.css, fonts/, locales/
const PUBLIC = path.join(__dirname, 'public');
const SESSION_COOKIE = 'neo_session';
const API_BODY_LIMIT = 24 * 1024 * 1024;            // a whole library.json or one very long chapter
const COVER_BODY_LIMIT = 12 * 1024 * 1024;
const AUTH_BODY_LIMIT = 16 * 1024;
const MIN_PASSWORD = 8;
const BACKUP_SWEEP_MS = 60 * 60 * 1000;

const VERSIONS = {
  hosted: require('./package.json').version,
  neo: require(path.join(ROOT, 'package.json')).version
};

// the shared files a browser may fetch by name from the repository root
const ROOT_FILES = new Set(['/app.js', '/styles.css', '/covers.js', '/i18n.js']);
const ROOT_DIRS = ['/fonts/', '/locales/'];

function createApp(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const users = new JsonUserStore(path.join(config.dataDir, 'users.json'));
  const secretBox = createSecretBox(config.sessionSecret);
  const throttle = new LoginThrottle();
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const languages = i18n.listLanguages();

  function logServerError(source, err) {
    const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
    console.error(line.trimEnd());
    try { fs.appendFileSync(path.join(config.dataDir, 'neo-errors.log'), line); } catch { /* never let logging crash the server */ }
  }

  const spell = new SpellService({ nodeModulesDir: path.join(__dirname, 'node_modules'), logError: logServerError });

  // ---------------------------------------------------------------------
  // One writer's corner of the volume
  // ---------------------------------------------------------------------
  const userRoot = (user) => path.join(config.dataDir, 'users', libName(user.id));

  /** Everything a handler needs to act as this writer. */
  function contextFor(user, req) {
    const root = userRoot(user);
    const settingsFile = path.join(root, 'settings.json');
    const settings = readJSON(settingsFile, {});
    const locale = i18n.pickLanguage({ saved: settings.uiLanguage, acceptLanguage: req.headers['accept-language'] });
    const t = i18n.translatorFor(locale);
    const libraryDir = path.join(root, 'NEO Library');
    const logError = (source, err) => {
      const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
      try { fs.mkdirSync(libraryDir, { recursive: true }); fs.appendFileSync(path.join(libraryDir, 'neo-errors.log'), line); } catch { logServerError(source, err); }
    };
    return {
      user, req, locale, t, logError,
      library: openLibrary({ dir: libraryDir, t, logError }),
      secretsFile: path.join(root, 'secrets.json'),
      setLanguage(code) {
        const resolved = i18n.resolveLanguage(code) || 'en';
        fs.mkdirSync(root, { recursive: true });
        writeJSON(settingsFile, { ...readJSON(settingsFile, {}), uiLanguage: resolved });
        return resolved;
      }
    };
  }

  const api = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
  registerHandlers(api, { spell, secretBox, versions: VERSIONS, rootDir: ROOT });

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------
  function currentUser(req) {
    const userId = verifySession(parseCookies(req)[SESSION_COOKIE], config.sessionSecret);
    return userId ? users.findById(userId) : null;
  }

  const sessionCookie = (req, user) => cookieHeader(SESSION_COOKIE, signSession(user.id, config.sessionSecret), { maxAge: SESSION_TTL_MS / 1000, secure: isSecureRequest(req, config.trustProxy) });
  const clearedCookie = (req) => cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure: isSecureRequest(req, config.trustProxy) });

  function signupAllowed(invite) {
    if (users.count() === 0) return true; // the first writer owns a fresh deployment
    if (config.signup === 'open') return true;
    if (config.signup !== 'invite' || !config.inviteCode) return false;
    const a = Buffer.from(String(invite || ''));
    const b = Buffer.from(config.inviteCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function handleSignup(req, res) {
    const { email, password, invite } = await readJSONBody(req, AUTH_BODY_LIMIT);
    if (!signupAllowed(invite)) throw new HttpError(403, config.signup === 'closed' ? 'New accounts are not being created here' : 'That invitation code is not right');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) throw new HttpError(400, 'That does not look like an email address');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `A password needs at least ${MIN_PASSWORD} characters`);
    let user;
    try { user = users.create({ email, passwordHash: hashPassword(password) }); } catch (err) { throw new HttpError(409, err.message); }
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    sendJSON(res, 200, { ok: true });
  }

  async function handleLogin(req, res) {
    const { email, password } = await readJSONBody(req, AUTH_BODY_LIMIT);
    const keys = [clientAddress(req, config.trustProxy), 'email:' + normalizeEmail(email)];
    if (!keys.every((k) => throttle.allowed(k))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const user = users.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      keys.forEach((k) => throttle.failed(k));
      throw new HttpError(401, 'That email and password do not match');
    }
    keys.forEach((k) => throttle.clear(k));
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    sendJSON(res, 200, { ok: true });
  }

  function handleLogout(req, res) {
    res.setHeader('Set-Cookie', clearedCookie(req));
    sendJSON(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------------
  // The writing room
  // ---------------------------------------------------------------------
  function hostedConfig(ctx) {
    return {
      version: `${VERSIONS.hosted} (NEO ${VERSIONS.neo})`,
      email: ctx.user.email,
      locale: ctx.locale,
      languages,
      spellLanguages: Object.fromEntries(Object.entries(SPELL_LANGUAGES).map(([code, l]) => [code, l.label])),
      source: 'https://github.com/emanrow/neo_hosted',
      upstream: 'https://github.com/hughhowey/neo'
    };
  }

  function servePage(ctx, res) {
    const html = buildHostedPage({ indexHtml, i18n: i18n.bundleFor(ctx.locale), hostedConfig: hostedConfig(ctx) });
    sendHTML(res, 200, html, { 'Content-Security-Policy': PAGE_CSP });
  }

  async function handleApi(ctx, channel, req, res) {
    const fn = api.handlers.get(channel);
    if (!fn) throw new HttpError(404, `No such channel: ${channel}`);
    const body = await readJSONBody(req, API_BODY_LIMIT);
    const args = Array.isArray(body.args) ? body.args : [];
    try {
      const result = await fn(ctx, ...args);
      sendJSON(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (err) {
      // a failed save must reach the page (persistChapter retries) and the log
      ctx.logError(channel, err);
      sendJSON(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  async function handleCoverUpload(ctx, url, req, res) {
    const bookId = url.searchParams.get('bookId');
    const ext = String(url.searchParams.get('ext') || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) throw new HttpError(400, 'Covers are PNG, JPEG or WebP');
    const bytes = await readBody(req, COVER_BODY_LIMIT);
    sendJSON(res, 200, { ok: true, result: ctx.library.setCoverBytes(bookId, ext, bytes) });
  }

  function serveCover(ctx, bookId, fname, res) {
    const file = ctx.library.coverPath(bookId, fname);
    if (!file) throw new HttpError(404, 'No such image');
    serveFile(res, path.dirname(file), path.basename(file), { cache: 'private, max-age=31536000, immutable' });
  }

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------
  async function route(req, res) {
    const url = new URL(req.url, 'http://neo.local');
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    if (method === 'GET' && p === '/healthz') return sendText(res, 200, 'ok');

    // static: the app itself, public by design (it is MIT-licensed source)
    if (method === 'GET' || method === 'HEAD') {
      if (ROOT_FILES.has(p) && serveFile(res, ROOT, p.slice(1))) return;
      if (ROOT_DIRS.some((d) => p.startsWith(d)) && serveFile(res, ROOT, p.slice(1), { cache: 'public, max-age=86400' })) return;
      if (p === '/jszip.min.js' && serveFile(res, path.join(__dirname, 'node_modules', 'jszip', 'dist'), 'jszip.min.js')) return;
      if (p === '/favicon.ico' && serveFile(res, path.join(ROOT, 'build'), 'icon.png', { cache: 'public, max-age=86400' })) return;
      if (p.startsWith('/web/') && serveFile(res, PUBLIC, p.slice(5))) return;
    }

    if (method === 'POST' && p.startsWith('/auth/')) {
      if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-site request refused');
      if (p === '/auth/signup') return handleSignup(req, res);
      if (p === '/auth/login') return handleLogin(req, res);
      if (p === '/auth/logout') return handleLogout(req, res);
    }

    const user = currentUser(req);

    if (method === 'GET' && p === '/login') {
      if (user) return redirect(res, '/');
      return sendHTML(res, 200, fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8'), { 'Content-Security-Policy': PAGE_CSP });
    }
    if (method === 'GET' && p === '/') {
      if (!user) return redirect(res, '/login');
      return servePage(contextFor(user, req), res);
    }

    if (p.startsWith('/api/') || p.startsWith('/library/')) {
      if (!user) throw new HttpError(401, 'Sign in to continue');
      if (method === 'POST' && !isSameOrigin(req)) throw new HttpError(403, 'Cross-site request refused');
      const ctx = contextFor(user, req);
      if (method === 'POST' && p === '/api/cover:upload') return handleCoverUpload(ctx, url, req, res);
      if (method === 'POST' && p.startsWith('/api/')) return handleApi(ctx, p.slice(5), req, res);
      if (method === 'GET' && p.startsWith('/library/')) {
        const [bookId, fname, ...rest] = p.slice(9).split('/');
        if (bookId && fname && !rest.length) return serveCover(ctx, bookId, fname, res);
      }
    }

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logServerError('http', err);
      if (res.headersSent) { res.end(); return; }
      sendJSON(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server' : err.message });
    }
  });

  // ---------------------------------------------------------------------
  // Daily backups, one zip per writer per day, swept hourly
  // ---------------------------------------------------------------------
  async function backupEveryone() {
    const usersDir = path.join(config.dataDir, 'users');
    let ids = [];
    try { ids = fs.readdirSync(usersDir); } catch { return; }
    for (const id of ids) {
      const root = path.join(usersDir, id);
      const settings = readJSON(path.join(root, 'settings.json'), {});
      const t = i18n.translatorFor(settings.uiLanguage || 'en');
      const libraryDir = path.join(root, 'NEO Library');
      if (!fs.existsSync(libraryDir)) continue;
      const logError = (source, err) => logServerError(`${id} ${source}`, err);
      try { await openLibrary({ dir: libraryDir, t, logError }).dailyBackup(); } catch (err) { logError('backup', err); }
    }
  }
  const timers = [];
  function startBackups() {
    timers.push(setTimeout(() => backupEveryone().catch((err) => logServerError('backup', err)), 60 * 1000).unref());
    timers.push(setInterval(() => backupEveryone().catch((err) => logServerError('backup', err)), BACKUP_SWEEP_MS).unref());
  }

  return {
    server, users, spell, config, backupEveryone, startBackups,
    close: () => new Promise((resolve) => { timers.forEach(clearTimeout); server.close(() => resolve()); })
  };
}

if (require.main === module) {
  const config = loadConfig();
  const app = createApp(config);
  process.on('uncaughtException', (err) => console.error('[main]', err));
  process.on('unhandledRejection', (err) => console.error('[main-promise]', err));
  app.server.listen(config.port, () => {
    console.log(`NEO hosted ${VERSIONS.hosted} (NEO ${VERSIONS.neo}) listening on :${config.port}`);
    console.log(`library volume: ${config.dataDir}  signup: ${config.signup}${config.dev ? '  (NEO_DEV: throwaway session secret)' : ''}`);
  });
  app.startBackups();
}

module.exports = { createApp, VERSIONS };
