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
//   POST /auth/forgot { email } | /auth/reset { token, password }   (email on; see lib/mail.js)
//   GET  /auth/verify?token=     the link in a confirmation email → signed in, or → /login?notice=link-expired
//   POST /api/<channel>            { args: [...] } → { ok, result | error }   (see lib/handlers.js)
//   POST /api/cover:upload?bookId=&ext=            raw image bytes → file name
//   POST /api/import:upload?name=<file name>       raw .docx/.txt/.md bytes → the parsed book
//   GET  /library/<bookId>/<cover-or-art file>     cover images for the shelf
//   GET  /healthz

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');                      // web/node_modules' copy, handed to the shared parser

const { loadConfig } = require('./lib/config');
const { HttpError, readBody, readJSONBody, sendJSON, sendHTML, sendText, redirect, serveFile, parseCookies, cookieHeader, isSameOrigin, clientAddress, isSecureRequest } = require('./lib/http');
const { hashPassword, verifyPassword, signSession, verifySession, signLink, verifyLink, linkStamp, LoginThrottle, SESSION_TTL_MS } = require('./lib/auth');
const { JsonUserStore, PgUserStore, normalizeEmail, isEmailVerified } = require('./lib/user-store');
const { openDatabase } = require('./lib/db');
const { createMailer, confirmationMessage, resetMessage } = require('./lib/mail');
const { createSecretBox } = require('./lib/secrets');
const { openLibrary, COVER_EXTS } = require('./lib/library');
const { registerHandlers } = require('./lib/handlers');
const { SpellService, SPELL_LANGUAGES } = require('./lib/spell');
const { buildHostedPage, PAGE_CSP } = require('./lib/page');
const { readJSON, writeJSON, libName } = require('./lib/files');
// the desktop's own manuscript parser, shared with main.js
const { importBuffer, isImportable } = require('../import-parse');
const i18n = require('./lib/i18n');

const ROOT = path.join(__dirname, '..');            // the desktop app: app.js, styles.css, fonts/, locales/
const PUBLIC = path.join(__dirname, 'public');
const SESSION_COOKIE = 'neo_session';
const API_BODY_LIMIT = 24 * 1024 * 1024;            // a whole library.json or one very long chapter
const COVER_BODY_LIMIT = 12 * 1024 * 1024;
const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;         // a whole manuscript as .docx, pictures and all
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

/**
 * The whole server, not yet listening. `deps.mailer` lets a test catch the
 * email the server would send; production builds one from config.mail.
 * `deps.db` is an opened database (db.js) for a test; production opens one
 * from config.databaseUrl, or keeps users in users.json without one.
 *
 * Await `ready` before listening: with Postgres it runs the migrations and
 * imports a users.json left over from before, once.
 */
function createApp(config, deps = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const usersFile = path.join(config.dataDir, 'users.json');
  const db = deps.db || (config.databaseUrl ? openDatabase(config.databaseUrl) : null);
  const users = db ? new PgUserStore(db) : new JsonUserStore(usersFile);
  const ready = db ? prepareDatabase() : Promise.resolve({ store: 'users.json', imported: 0 });

  // Migrate, then take over a users.json if one is there and the table is
  // empty. The file is renamed, not deleted, so nothing is lost if the
  // import turns out wrong; a later boot then leaves it alone.
  async function prepareDatabase() {
    await db.migrate();
    let imported = 0;
    if (fs.existsSync(usersFile)) {
      imported = await users.importFrom(new JsonUserStore(usersFile));
      fs.renameSync(usersFile, `${usersFile}.imported-${new Date().toISOString().slice(0, 10)}`);
    }
    return { store: 'postgres', imported };
  }
  const secretBox = createSecretBox(config.sessionSecret);
  const mailer = deps.mailer || createMailer(config.mail || {});
  const throttle = new LoginThrottle();
  const mailPerAddress = new LoginThrottle({ limit: 5 });   // emails to one address per window
  const mailPerClient = new LoginThrottle({ limit: 20 });   // emails asked for from one client per window (a writing group shares an address)
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
  async function currentUser(req) {
    const userId = verifySession(parseCookies(req)[SESSION_COOKIE], config.sessionSecret);
    return userId ? users.findById(userId) : null;
  }

  const sessionCookie = (req, user) => cookieHeader(SESSION_COOKIE, signSession(user.id, config.sessionSecret), { maxAge: SESSION_TTL_MS / 1000, secure: isSecureRequest(req, config.trustProxy) });
  const clearedCookie = (req) => cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure: isSecureRequest(req, config.trustProxy) });

  async function signupAllowed(invite) {
    if (await users.count() === 0) return true; // the first writer owns a fresh deployment
    if (config.signup === 'open') return true;
    if (config.signup !== 'invite' || !config.inviteCode) return false;
    const a = Buffer.from(String(invite || ''));
    const b = Buffer.from(config.inviteCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // -------------------------------------------------------------------
  // Email: confirming an address, resetting a password
  // -------------------------------------------------------------------

  /** Where links in email point: NEO_PUBLIC_URL, or (laptops only) the host this request came to. */
  function linkBase(req) {
    if (config.publicUrl) return config.publicUrl;
    return `${isSecureRequest(req, config.trustProxy) ? 'https' : 'http'}://${req.headers.host}`;
  }

  /** Rations email: so many to one address, so many from one client, per window. Counts the request, then refuses past the limit. */
  function allowMail(req, email) {
    const rations = [[mailPerAddress, normalizeEmail(email)], [mailPerClient, clientAddress(req, config.trustProxy)]];
    if (!rations.every(([ration, key]) => ration.allowed(key))) throw new HttpError(429, 'Too many emails requested. Try again in a few minutes.');
    rations.forEach(([ration, key]) => ration.failed(key));
  }

  async function sendConfirmation(req, user) {
    const token = signLink({ purpose: 'verify', userId: user.id }, config.sessionSecret);
    const link = `${linkBase(req)}/auth/verify?token=${encodeURIComponent(token)}`;
    await mailer.send({ to: user.email, ...confirmationMessage({ link }) });
  }

  async function sendReset(req, user) {
    const token = signLink({ purpose: 'reset', userId: user.id, stamp: linkStamp(user.passwordHash) }, config.sessionSecret);
    const link = `${linkBase(req)}/login?reset=${encodeURIComponent(token)}`;
    await mailer.send({ to: user.email, ...resetMessage({ link }) });
  }

  /** Signs the writer in and tells the page so. */
  function signIn(req, res, user) {
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    sendJSON(res, 200, { ok: true });
  }

  function checkCredentials({ email, password }) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) throw new HttpError(400, 'That does not look like an email address');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `A password needs at least ${MIN_PASSWORD} characters`);
  }

  // With email on, a new account waits for its confirmation link and the
  // page says "check your email" ({ ok, confirm: true }). Signing up again
  // with the same password while still waiting sends the link again, so a
  // lost email is not a lost account. With email off, signup signs in.
  async function handleSignup(req, res) {
    const { email, password, invite } = await readJSONBody(req, AUTH_BODY_LIMIT);
    if (!await signupAllowed(invite)) throw new HttpError(403, config.signup === 'closed' ? 'New accounts are not being created here' : 'That invitation code is not right');
    checkCredentials({ email, password });
    const waiting = await users.findByEmail(email);
    if (waiting && mailer.enabled && !isEmailVerified(waiting) && verifyPassword(password, waiting.passwordHash)) {
      allowMail(req, email);
      await sendConfirmation(req, waiting);
      return sendJSON(res, 200, { ok: true, confirm: true });
    }
    let user;
    try { user = await users.create({ email, passwordHash: hashPassword(password), emailVerified: !mailer.enabled }); } catch (err) { throw new HttpError(409, err.message); }
    if (!mailer.enabled) return signIn(req, res, user);
    allowMail(req, email);
    await sendConfirmation(req, user);
    sendJSON(res, 200, { ok: true, confirm: true });
  }

  async function handleLogin(req, res) {
    const { email, password } = await readJSONBody(req, AUTH_BODY_LIMIT);
    const keys = [clientAddress(req, config.trustProxy), 'email:' + normalizeEmail(email)];
    if (!keys.every((k) => throttle.allowed(k))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const user = await users.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      keys.forEach((k) => throttle.failed(k));
      throw new HttpError(401, 'That email and password do not match');
    }
    keys.forEach((k) => throttle.clear(k));
    if (mailer.enabled && !isEmailVerified(user)) {
      // the right password, an unconfirmed address: send the link again rather than leave them stuck
      allowMail(req, email);
      await sendConfirmation(req, user);
      throw new HttpError(403, 'Confirm your email first. We just sent you a new link.');
    }
    signIn(req, res, user);
  }

  async function handleVerify(url, req, res) {
    const link = verifyLink(url.searchParams.get('token'), 'verify', config.sessionSecret);
    const user = link && await users.findById(link.userId);
    if (!user) return redirect(res, '/login?notice=link-expired');
    await users.markEmailVerified(user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    redirect(res, '/');
  }

  // Always "ok", whether or not the address has an account, so the form
  // cannot be used to find out who writes here.
  async function handleForgot(req, res) {
    const { email } = await readJSONBody(req, AUTH_BODY_LIMIT);
    if (!mailer.enabled) throw new HttpError(503, 'Password reset by email is not set up on this server');
    allowMail(req, email);
    const user = await users.findByEmail(email);
    if (user) await sendReset(req, user);
    sendJSON(res, 200, { ok: true });
  }

  // The reset link carries a stamp of the password hash it was issued
  // against, so it works once: after this, the stamp no longer matches.
  // Opening the link also proves the address, so an unconfirmed account
  // is confirmed here too.
  async function handleReset(req, res) {
    const { token, password } = await readJSONBody(req, AUTH_BODY_LIMIT);
    const link = verifyLink(token, 'reset', config.sessionSecret);
    const user = link && await users.findById(link.userId);
    if (!user || link.stamp !== linkStamp(user.passwordHash)) throw new HttpError(400, 'That reset link has expired or was already used. Ask for a new one.');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `A password needs at least ${MIN_PASSWORD} characters`);
    await users.setPasswordHash(user.id, hashPassword(password));
    await users.markEmailVerified(user.id);
    throttle.clear('email:' + user.email);
    signIn(req, res, await users.findById(user.id));
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

  // A manuscript the writer picked or dropped, parsed into chapters the way
  // main.js does it for the desktop. The page then creates the book over the
  // ordinary channels; nothing is written here.
  async function handleImportUpload(ctx, url, req, res) {
    const name = path.basename(String(url.searchParams.get('name') || ''));
    if (!isImportable(name)) throw new HttpError(400, 'Manuscripts are .docx, .txt or .md files');
    const bytes = await readBody(req, IMPORT_BODY_LIMIT);
    try {
      sendJSON(res, 200, { ok: true, result: await importBuffer(name, bytes, { JSZip }) });
    } catch (err) {
      ctx.logError('import', err);
      sendJSON(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
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
      if (p === '/auth/forgot') return handleForgot(req, res);
      if (p === '/auth/reset') return handleReset(req, res);
    }
    if (method === 'GET' && p === '/auth/verify') return handleVerify(url, req, res);

    const user = await currentUser(req);

    if (method === 'GET' && p === '/login') {
      if (user && !url.searchParams.has('reset')) return redirect(res, '/');
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
      if (method === 'POST' && p === '/api/import:upload') return handleImportUpload(ctx, url, req, res);
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
    server, users, db, ready, spell, mailer, config, backupEveryone, startBackups,
    close: async () => {
      await new Promise((resolve) => { timers.forEach(clearTimeout); server.close(() => resolve()); });
      if (db && !deps.db) await db.close();
    }
  };
}

if (require.main === module) {
  const config = loadConfig();
  const app = createApp(config);
  process.on('uncaughtException', (err) => console.error('[main]', err));
  process.on('unhandledRejection', (err) => console.error('[main-promise]', err));
  app.ready.then(({ store, imported }) => {
    app.server.listen(config.port, () => {
      console.log(`NEO hosted ${VERSIONS.hosted} (NEO ${VERSIONS.neo}) listening on :${config.port}`);
      console.log(`library volume: ${config.dataDir}  users: ${store}${imported ? ` (${imported} imported from users.json)` : ''}  signup: ${config.signup}  email: ${app.mailer.enabled ? 'on (Resend)' : 'off'}${config.dev ? '  (NEO_DEV: throwaway session secret)' : ''}`);
    });
    app.startBackups();
  }).catch((err) => {
    console.error('[main] could not open the user store:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, VERSIONS, ROOT_FILES, ROOT_DIRS };
