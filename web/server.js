'use strict';

// NEO, hosted. One node:http server that serves the desktop app's own page
// and scripts, signs writers in, and answers the window.neo calls that
// main.js answers on the desktop, against a NEO Library per writer: rows in
// Postgres when DATABASE_URL is set, a plain-file folder on the volume
// otherwise. No framework, no bundler.
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
//   POST /api/export:pdf?trim=<name>&scene=<name>  the export HTML → the PDF, by the printer (print/); 503 without one
//   GET  /library/<bookId>/<cover, art, map or fig file>  cover images for the shelf, the map map's sheet, a chapter's pictures
//   POST /api/map:upload?bookId=&ext=   the map map's sheet, raw image body (hosted only)
//   POST /api/figure:upload?bookId=&ext=   a picture for a chapter, raw image body → file name (hosted only; web-figures.js)
//   GET  /library.zip              the writer's whole library as the desktop folder
//   GET  /healthz

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');                      // web/node_modules' copy, handed to the shared parser

const { loadConfig } = require('./lib/config');
const { MIME, HttpError, readBody, readJSONBody, send, sendJSON, sendHTML, sendText, redirect, serveFile, parseCookies, cookieHeader, isSameOrigin, clientAddress, isSecureRequest } = require('./lib/http');
const { hashPassword, verifyPassword, signSession, verifySession, signLink, verifyLink, linkStamp, LoginThrottle, SESSION_TTL_MS } = require('./lib/auth');
const { JsonUserStore, PgUserStore, normalizeEmail, isEmailVerified, EMAIL_TAKEN } = require('./lib/user-store');
const { openDatabase } = require('./lib/db');
const { RevisionLog, NullRevisionLog } = require('./lib/revisions');
const { openBranches } = require('./lib/branches');
const { createMerger } = require('./lib/branch-merge');
const { createMailer, confirmationMessage, resetMessage, feedbackMessage } = require('./lib/mail');
const { createSecretBox } = require('./lib/secrets');
const { openLibrary, COVER_EXTS } = require('./lib/library');
const { openPgLibrary } = require('./lib/pg-library');
const { createObjectStore, NO_OBJECT_STORE } = require('./lib/object-store');
const { createImageStore } = require('./lib/image-store');
const { createPrintClient, NO_PRINT_CLIENT, PRINT_CHOICES, printSettingsFrom } = require('./lib/print-client');
const { JsonShareStore, PgShareStore, isToken } = require('./lib/share-store');
const { registerHandlers } = require('./lib/handlers');
const { SpellService, SPELL_LANGUAGES } = require('./lib/spell');
const { buildHostedPage, assetVersionFor, PAGE_CSP } = require('./lib/page');
const { buildLoginPage } = require('./lib/login-page');
const { buildAdminPage } = require('./lib/admin-page');
const { readJSON, writeJSON, writeFileDurable, libName } = require('../library-disk');
// the desktop's own manuscript parser, shared with main.js
const { importBuffer, isImportable } = require('../import-parse');
const i18n = require('./lib/i18n');

const ROOT = path.join(__dirname, '..');            // the desktop app: app.js, styles.css, fonts/, locales/
const PUBLIC = path.join(__dirname, 'public');
const SESSION_COOKIE = 'neo_session';
const API_BODY_LIMIT = 24 * 1024 * 1024;            // a whole library.json or one very long chapter
const COVER_BODY_LIMIT = 12 * 1024 * 1024;
const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;         // a whole manuscript as .docx, pictures and all
const EXPORT_BODY_LIMIT = 64 * 1024 * 1024;         // a long novel with four embedded font weights and a cover
const AUTH_BODY_LIMIT = 16 * 1024;
const FEEDBACK_LIMIT = 5000;                    // characters in one Help → Send Feedback… note
const MIN_PASSWORD = 8;
const BACKUP_SWEEP_MS = 60 * 60 * 1000;
const LIBRARY_FOLDER = 'NEO Library';

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
 * imports, once, a users.json and the library folders left over from before.
 */
function createApp(config, deps = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const usersFile = path.join(config.dataDir, 'users.json');
  const db = deps.db || (config.databaseUrl ? openDatabase(config.databaseUrl) : null);
  const users = db ? new PgUserStore(db) : new JsonUserStore(usersFile);
  const revisions = db ? new RevisionLog(db) : new NullRevisionLog();
  const objectStore = deps.objectStore || (config.backupBucket ? createObjectStore(config.backupBucket) : NO_OBJECT_STORE);
  const printer = deps.printer || (config.printer ? createPrintClient(config.printer) : NO_PRINT_CLIENT);
  const shares = db ? new PgShareStore(db) : new JsonShareStore(path.join(config.dataDir, 'shares'));
  // Migrate, then take over a users.json if one is there and the table is
  // empty, and every writer's library folder whose rows are still empty.
  // Files are renamed, not deleted, so nothing is lost if an import turns
  // out wrong; a later boot then leaves them alone.
  async function prepareDatabase() {
    await db.migrate();
    const stamp = new Date().toISOString().slice(0, 10);
    let imported = 0;
    if (fs.existsSync(usersFile)) {
      imported = await users.importFrom(new JsonUserStore(usersFile));
      fs.renameSync(usersFile, `${usersFile}.imported-${stamp}`);
    }
    let libraries = 0;
    for (const id of await users.listIds()) {
      const libraryDir = path.join(userRoot({ id }), LIBRARY_FOLDER);
      if (!fs.existsSync(libraryDir)) continue;
      const library = openPgLibrary({ db, userId: id, dir: libraryDir, t: i18n.translatorFor('en'), logError: (source, err) => logServerError(`${id} ${source}`, err) });
      if (!(await library.isEmpty())) continue;
      const counts = await library.importFolder(libraryDir);
      if (!counts.books && !fs.existsSync(path.join(libraryDir, 'library.json'))) { await db.query('DELETE FROM libraries WHERE user_id = $1', [id]); continue; }
      fs.renameSync(libraryDir, `${libraryDir}.imported-${stamp}`);
      libraries++;
      console.log(`[library] imported ${counts.books} books, ${counts.branches} branches, ${counts.files} files for one writer from the volume`);
    }
    return { store: 'postgres', imported, libraries };
  }
  const secretBox = createSecretBox(config.sessionSecret);
  const mailer = deps.mailer || createMailer(config.mail || {});
  const adminEmails = (config.adminEmails || []).map(normalizeEmail);       // the owner: /admin, and where feedback goes
  const guestsOfHonor = (config.guestsOfHonor || []).map(normalizeEmail);   // who gets the one-time welcome
  const throttle = new LoginThrottle();
  const mailPerAddress = new LoginThrottle({ limit: 5 });   // emails to one address per window
  const mailPerClient = new LoginThrottle({ limit: 20 });   // emails asked for from one client per window (a writing group shares an address)
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // everything the two pages load by URL: a changed file changes every asset URL on the next deploy
  const assetVersion = assetVersionFor([
    ...[...ROOT_FILES].map((p) => path.join(ROOT, p.slice(1))),
    path.join(__dirname, 'node_modules', 'jszip', 'dist', 'jszip.min.js'),
    ...fs.readdirSync(PUBLIC).sort().map((f) => path.join(PUBLIC, f)),
  ]);
  const languages = i18n.listLanguages();

  function logServerError(source, err) {
    const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
    console.error(line.trimEnd());
    try { fs.appendFileSync(path.join(config.dataDir, 'neo-errors.log'), line); } catch { /* never let logging crash the server */ }
  }

  const spell = new SpellService({ nodeModulesDir: path.join(__dirname, 'node_modules'), logError: logServerError });
  const userRoot = (user) => path.join(config.dataDir, 'users', libName(user.id));
  const ready = db ? prepareDatabase() : Promise.resolve({ store: 'users.json', imported: 0, libraries: 0 });

  // ---------------------------------------------------------------------
  // One writer's corner of the volume
  // ---------------------------------------------------------------------

  /** One writer's library and branches: rows in Postgres with a database, the desktop folder on the volume without. */
  function openWriterLibrary({ userId, libraryDir, t, logError }) {
    if (db) {
      const library = openPgLibrary({ db, userId, dir: libraryDir, t, logError });
      return { library, branches: library.branches };
    }
    const branches = openBranches({ dir: libraryDir, logError });
    return { library: openLibrary({ dir: libraryDir, t, logError, bookDirFor: branches.folderFor }), branches };
  }

  /** Everything a handler needs to act as this writer. */
  function contextFor(user, req) {
    const root = userRoot(user);
    const settingsFile = path.join(root, 'settings.json');
    const settings = readJSON(settingsFile, {});
    const locale = i18n.pickLanguage({ saved: settings.uiLanguage, acceptLanguage: req.headers['accept-language'] });
    const t = i18n.translatorFor(locale);
    const libraryDir = path.join(root, LIBRARY_FOLDER);
    const logError = (source, err) => {
      const line = `[${new Date().toISOString()}] [${source}] ${err && err.stack ? err.stack : String(err)}\n`;
      try { fs.mkdirSync(libraryDir, { recursive: true }); fs.appendFileSync(path.join(libraryDir, 'neo-errors.log'), line); } catch { logServerError(source, err); }
    };
    const { library, branches } = openWriterLibrary({ userId: user.id, libraryDir, t, logError });
    const images = createImageStore({ objectStore, writerId: user.id, library, logError });   // the bytes of covers, sheets and pictures: the bucket when there is one
    const honored = guestsOfHonor.includes(normalizeEmail(user.email));
    // this writer's slice of the revision log, keyed by the branch they are in; a no-op without a database
    const onBranch = async (bookId) => ({ userId: user.id, bookId, branch: await branches.activeBranch(bookId) });
    return {
      user, req, locale, t, logError, branches, library, images, shares, honored,
      welcomePending: honored && !settings.welcomedAt,   // the one-time welcome is still owed
      merger: createMerger({ branches, library }),
      revisions: {
        record: async (bookId, chapterId, html) => revisions.record({ ...(await onBranch(bookId)), chapterId, html }),
        list: async (bookId, chapterId) => revisions.list({ ...(await onBranch(bookId)), chapterId }),
        read: (id) => revisions.read({ userId: user.id, id }),
        verify: async (bookId, chapterId) => revisions.verify({ ...(await onBranch(bookId)), chapterId })
      },
      secretsFile: path.join(root, 'secrets.json'),
      setLanguage(code) {
        const resolved = i18n.resolveLanguage(code) || 'en';
        fs.mkdirSync(root, { recursive: true });
        writeJSON(settingsFile, { ...readJSON(settingsFile, {}), uiLanguage: resolved });
        return resolved;
      },
      /** The writer's print choices (trim size, scene breaks), saved when a patch is given; unknown values fall back on the defaults. */
      printSettings(patch) {
        const current = printSettingsFrom(readJSON(settingsFile, {}).print);
        if (!patch || typeof patch !== 'object') return current;
        const next = printSettingsFrom({ ...current, ...patch });
        fs.mkdirSync(root, { recursive: true });
        writeJSON(settingsFile, { ...readJSON(settingsFile, {}), print: next });
        return next;
      },
      /** The welcome was shown (or waved away); it is not shown again. */
      markWelcomed() {
        fs.mkdirSync(root, { recursive: true });
        writeJSON(settingsFile, { ...readJSON(settingsFile, {}), welcomedAt: new Date().toISOString() });
        return true;
      }
    };
  }

  // Help → Send Feedback…: a writer's note goes to the owner's inbox, through
  // the same mailer and rations as the sign-in emails. Off without email or
  // an owner address to send to.
  const feedback = {
    enabled: () => mailer.enabled && adminEmails.length > 0,
    async send(ctx, message) {
      if (!feedback.enabled()) throw new HttpError(503, ctx.t('Feedback by email is not set up on this server'));
      const text = String(message || '').trim();
      if (!text) throw new HttpError(400, ctx.t('Write something first'));
      if (text.length > FEEDBACK_LIMIT) throw new HttpError(400, ctx.t('That is longer than an email should be; please keep it under {n} characters', { n: FEEDBACK_LIMIT }));
      allowMail(ctx.req, ctx.user.email);
      const mail = feedbackMessage({ from: ctx.user.email, honored: ctx.honored, version: VERSIONS.hosted, message: text });
      for (const to of adminEmails) await mailer.send({ to, ...mail });
      return true;
    }
  };

  const api = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };
  registerHandlers(api, { spell, secretBox, versions: VERSIONS, rootDir: ROOT, feedback });

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

  /** Before anyone is signed in, the browser's language decides what the sign-in page and its errors say. */
  function visitorLanguage(req) {
    const locale = i18n.pickLanguage({ acceptLanguage: req.headers['accept-language'] });
    return { locale, t: i18n.translatorFor(locale) };
  }

  /** Where links in email point: NEO_PUBLIC_URL, or (laptops only) the host this request came to. */
  function linkBase(req) {
    if (config.publicUrl) return config.publicUrl;
    return `${isSecureRequest(req, config.trustProxy) ? 'https' : 'http'}://${req.headers.host}`;
  }

  /** Rations email: so many to one address, so many from one client, per window. Counts the request, then refuses past the limit. */
  function allowMail(req, email) {
    const rations = [[mailPerAddress, normalizeEmail(email)], [mailPerClient, clientAddress(req, config.trustProxy)]];
    if (!rations.every(([ration, key]) => ration.allowed(key))) throw new HttpError(429, visitorLanguage(req).t('Too many emails requested. Try again in a few minutes.'));
    rations.forEach(([ration, key]) => ration.failed(key));
  }

  async function sendConfirmation(req, user) {
    const token = signLink({ purpose: 'verify', userId: user.id }, config.sessionSecret);
    const link = `${linkBase(req)}/auth/verify?token=${encodeURIComponent(token)}`;
    await mailer.send({ to: user.email, ...confirmationMessage({ link, t: visitorLanguage(req).t }) });
  }

  async function sendReset(req, user) {
    const token = signLink({ purpose: 'reset', userId: user.id, stamp: linkStamp(user.passwordHash) }, config.sessionSecret);
    const link = `${linkBase(req)}/login?reset=${encodeURIComponent(token)}`;
    await mailer.send({ to: user.email, ...resetMessage({ link, t: visitorLanguage(req).t }) });
  }

  /** Signs the writer in and tells the page so. */
  function signIn(req, res, user) {
    res.setHeader('Set-Cookie', sessionCookie(req, user));
    sendJSON(res, 200, { ok: true });
  }

  function checkCredentials({ email, password }, t) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) throw new HttpError(400, t('That does not look like an email address'));
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, t('A password needs at least {n} characters', { n: MIN_PASSWORD }));
  }

  // With email on, a new account waits for its confirmation link and the
  // page says "check your email" ({ ok, confirm: true }). Signing up again
  // with the same password while still waiting sends the link again, so a
  // lost email is not a lost account. With email off, signup signs in.
  async function handleSignup(req, res) {
    const { email, password, invite } = await readJSONBody(req, AUTH_BODY_LIMIT);
    const { t } = visitorLanguage(req);
    if (!await signupAllowed(invite)) throw new HttpError(403, t(config.signup === 'closed' ? 'New accounts are not being created here' : 'That invitation code is not right'));
    checkCredentials({ email, password }, t);
    const waiting = await users.findByEmail(email);
    if (waiting && mailer.enabled && !isEmailVerified(waiting) && verifyPassword(password, waiting.passwordHash)) {
      allowMail(req, email);
      await sendConfirmation(req, waiting);
      return sendJSON(res, 200, { ok: true, confirm: true });
    }
    let user;
    try { user = await users.create({ email, passwordHash: hashPassword(password), emailVerified: !mailer.enabled }); } catch (err) { throw new HttpError(409, err.message === EMAIL_TAKEN ? t(EMAIL_TAKEN) : err.message); }
    if (!mailer.enabled) return signIn(req, res, user);
    allowMail(req, email);
    await sendConfirmation(req, user);
    sendJSON(res, 200, { ok: true, confirm: true });
  }

  async function handleLogin(req, res) {
    const { email, password } = await readJSONBody(req, AUTH_BODY_LIMIT);
    const keys = [clientAddress(req, config.trustProxy), 'email:' + normalizeEmail(email)];
    const { t } = visitorLanguage(req);
    if (!keys.every((k) => throttle.allowed(k))) throw new HttpError(429, t('Too many attempts. Try again in a few minutes.'));
    const user = await users.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      keys.forEach((k) => throttle.failed(k));
      throw new HttpError(401, t('That email and password do not match'));
    }
    keys.forEach((k) => throttle.clear(k));
    if (mailer.enabled && !isEmailVerified(user)) {
      // the right password, an unconfirmed address: send the link again rather than leave them stuck
      allowMail(req, email);
      await sendConfirmation(req, user);
      throw new HttpError(403, t('Confirm your email first. We just sent you a new link.'));
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
    if (!mailer.enabled) throw new HttpError(503, visitorLanguage(req).t('Password reset by email is not set up on this server'));
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
    if (!user || link.stamp !== linkStamp(user.passwordHash)) throw new HttpError(400, visitorLanguage(req).t('That reset link has expired or was already used. Ask for a new one.'));
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, visitorLanguage(req).t('A password needs at least {n} characters', { n: MIN_PASSWORD }));
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
      upstream: 'https://github.com/hughhowey/neo',
      feedback: feedback.enabled(),                       // Help → Send Feedback… is on the menu
      print: printer.enabled ? PRINT_CHOICES : false,     // Export → PDF is made by the printer, with these choices; false: the browser's print dialog
      welcome: ctx.welcomePending ? 'honored' : ''       // web-feedback.js opens the one-time welcome
    };
  }

  function servePage(ctx, res) {
    const html = buildHostedPage({ indexHtml, i18n: i18n.bundleFor(ctx.locale), hostedConfig: hostedConfig(ctx), assetVersion });
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
      // a failed save must reach the page (persistChapter retries) and the log;
      // a refusal the handler meant (an HttpError) keeps its status and is not a server fault
      if (err instanceof HttpError) { sendJSON(res, err.status, { ok: false, error: err.message }); return; }
      ctx.logError(channel, err);
      sendJSON(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  /** A raw image body in, its file name out: the cover (setCoverBytes), the map map's sheet (setMapImage) or a chapter's picture (addFigure), the bytes wherever ctx.images keeps them. */
  async function handleImageUpload(ctx, url, req, res, place) {
    const bookId = url.searchParams.get('bookId');
    const ext = String(url.searchParams.get('ext') || '').toLowerCase();
    if (!COVER_EXTS.includes(ext)) throw new HttpError(400, ctx.t('Images are PNG, JPEG or WebP'));
    const bytes = await readBody(req, COVER_BODY_LIMIT);
    sendJSON(res, 200, { ok: true, result: await ctx.images.put(place, bookId, ext, bytes) });
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

  // The book as the page exported it (buildHtml in app.js, fonts and cover
  // inside), printed by the second service. Nothing is kept; the bytes go
  // back to the browser, which saves them as a download.
  async function handleExportPdf(ctx, url, req, res) {
    if (!printer.enabled) throw new HttpError(503, 'No PDF printer is configured');
    const html = (await readBody(req, EXPORT_BODY_LIMIT)).toString('utf8');
    if (!/<html[\s>]/i.test(html.slice(0, 2000))) throw new HttpError(400, 'Send the book as a whole HTML document');
    // the writer's saved choices, unless the dialog sent others along
    // a sheet (the timeline chart) brings its own page and takes none of the book's choices
    const sheet = url.searchParams.get('layout') === 'sheet';
    const choices = sheet ? { layout: 'sheet' } : printSettingsFrom({ ...ctx.printSettings(), ...Object.fromEntries(['trim', 'scene'].filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k)])) });
    try {
      const { pdf, pages, paged } = await printer.render(html, { lang: ctx.locale, ...choices });
      send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'X-Neo-Pages': String(pages), 'X-Neo-Paged': paged ? '1' : '0', 'Cache-Control': 'no-store' });
    } catch (err) {
      ctx.logError('export:pdf', err);
      throw err;
    }
  }

  async function serveCover(ctx, bookId, fname, res) {
    const bytes = await ctx.images.get(bookId, fname);
    if (!bytes) throw new HttpError(404, 'No such image');
    send(res, 200, bytes, { 'Content-Type': MIME[path.extname(fname).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  // The writer's whole library as the desktop app's folder, zipped: the
  // export that files became. Built in memory; a library is small.
  async function serveLibraryZip(ctx, res) {
    const zip = await ctx.library.exportZip(ctx.images.forExport);
    send(res, 200, zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${LIBRARY_FOLDER}.zip"`, 'Cache-Control': 'no-store' });
  }

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------
  async function route(req, res) {
    const url = new URL(req.url, 'http://neo.local');
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    if (method === 'GET' && p === '/healthz') return sendText(res, 200, 'ok');
    if (method === 'GET' && p.startsWith('/s/')) return servePublicPage(p.slice(3), res);

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
      const html = buildLoginPage(fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8'), { ...visitorLanguage(req), assetVersion });
      return sendHTML(res, 200, html, { 'Content-Security-Policy': PAGE_CSP, Vary: 'Accept-Language' });
    }
    if (method === 'GET' && p === '/') {
      if (!user) return redirect(res, '/login');
      return servePage(contextFor(user, req), res);
    }
    if (p === '/admin' || p === '/admin/remove') {
      if (!user || !await isAdmin(user)) throw new HttpError(404, 'Not found');
      if (method === 'GET' && p === '/admin') return sendHTML(res, 200, await adminView(user, url.searchParams.get('notice') || ''), { 'Content-Security-Policy': PAGE_CSP });
      if (method === 'POST' && p === '/admin/remove') {
        if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-site request refused');
        return handleAdminRemove(user, req, res);
      }
    }

    if (p.startsWith('/api/') || p.startsWith('/library/') || p === '/library.zip') {
      if (!user) throw new HttpError(401, 'Sign in to continue');
      if (method === 'POST' && !isSameOrigin(req)) throw new HttpError(403, 'Cross-site request refused');
      const ctx = contextFor(user, req);
      if (method === 'POST' && p === '/api/cover:upload') return handleImageUpload(ctx, url, req, res, ctx.library.setCoverBytes);
      if (method === 'POST' && p === '/api/map:upload') return handleImageUpload(ctx, url, req, res, ctx.library.setMapImage);
      if (method === 'POST' && p === '/api/figure:upload') return handleImageUpload(ctx, url, req, res, ctx.library.addFigure);
      if (method === 'POST' && p === '/api/import:upload') return handleImportUpload(ctx, url, req, res);
      if (method === 'POST' && p === '/api/export:pdf') return handleExportPdf(ctx, url, req, res);
      if (method === 'POST' && p.startsWith('/api/')) return handleApi(ctx, p.slice(5), req, res);
      if (method === 'GET' && p === '/library.zip') return serveLibraryZip(ctx, res);
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
  // The owner's page: /admin (lib/admin-page.js)
  // ---------------------------------------------------------------------
  // The owner is whoever NEO_ADMIN_EMAILS names, else the oldest account.
  // Anyone else gets Not found, so the page gives nothing away.
  async function isAdmin(user) {
    if (adminEmails.length) return adminEmails.includes(normalizeEmail(user.email));
    const [oldest] = await users.list();
    return !!oldest && oldest.id === user.id;
  }

  const folderBytes = (p) => {
    let total = 0;
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (e.isDirectory()) total += folderBytes(path.join(p, e.name));
      else if (e.isFile()) { try { total += fs.statSync(path.join(p, e.name)).size; } catch { /* gone between list and stat */ } }
    }
    return total;
  };

  async function adminView(me, notice) {
    const writers = [];
    for (const u of await users.list()) {
      const root = userRoot(u);
      const libraryDir = path.join(root, LIBRARY_FOLDER);
      const { library } = openWriterLibrary({ userId: u.id, libraryDir, t: i18n.translatorFor('en'), logError: (source, err) => logServerError(`${u.id} ${source}`, err) });
      let books = 0;
      let libraryBytes = 0;
      try { books = (await library.listBooks()).length; libraryBytes = await library.footprint(); } catch (err) { logServerError(`${u.id} admin`, err); }
      let backups = 0;
      try { backups = fs.readdirSync(path.join(libraryDir, 'Backups')).filter((f) => f.endsWith('.zip')).length; } catch { /* none yet */ }
      writers.push({ id: u.id, email: u.email, createdAt: u.createdAt, emailVerifiedAt: isEmailVerified(u) ? (u.emailVerifiedAt || u.createdAt) : null, books, libraryBytes, backups, shares: await shares.countFor(u.id) });
    }
    const facts = [
      ['NEO hosted', `${VERSIONS.hosted} (NEO ${VERSIONS.neo})`],
      ['Accounts', db ? 'Postgres' : 'users.json'],
      ['Words', db ? 'Postgres (the volume keeps settings, keys, logs and zips)' : 'folders on the volume'],
      ['Signup', config.signup],
      ['Email', mailer.enabled ? 'on (Resend)' : 'off'],
      ['Backups', objectStore.enabled ? `volume + bucket ${objectStore.bucket}` : 'volume only'],
      ['Images', objectStore.enabled ? `bucket ${objectStore.bucket} (earlier ones where they were)` : db ? 'rows' : 'volume'],
      ['Owner', adminEmails.length ? adminEmails.join(', ') : 'the oldest account (set NEO_ADMIN_EMAILS to name one)']
    ];
    const volume = [
      ['Writers (users/)', folderBytes(path.join(config.dataDir, 'users'))],
      ['Public pages (shares/)', folderBytes(path.join(config.dataDir, 'shares'))],
      ['Removed accounts (removed/)', folderBytes(path.join(config.dataDir, 'removed'))],
      ['Everything', folderBytes(config.dataDir)]
    ];
    return buildAdminPage({ me, writers, facts, volume, notice });
  }

  /**
   * Removes an account: its library is zipped as the desktop folder under
   * removed/ first, then its public pages, history and rows go, the folder
   * on the volume moves under removed/, and the user row is deleted. The
   * owner cannot remove themself; the address must be typed back.
   */
  async function handleAdminRemove(me, req, res) {
    const form = new URLSearchParams((await readBody(req, AUTH_BODY_LIMIT)).toString('utf8'));
    const target = await users.findById(form.get('userId') || '');
    if (!target) throw new HttpError(404, 'No such account');
    if (target.id === me.id) throw new HttpError(400, 'You cannot remove your own account from here');
    if (normalizeEmail(form.get('confirm')) !== target.email) throw new HttpError(400, 'Type the address exactly to confirm');
    const root = userRoot(target);
    const libraryDir = path.join(root, LIBRARY_FOLDER);
    const logError = (source, err) => logServerError(`${target.id} ${source}`, err);
    const { library } = openWriterLibrary({ userId: target.id, libraryDir, t: i18n.translatorFor('en'), logError });
    const images = createImageStore({ objectStore, writerId: target.id, library, logError });
    const removedDir = path.join(config.dataDir, 'removed');
    fs.mkdirSync(removedDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const keep = path.join(removedDir, `${libName(target.id)}-${stamp}`);
    if (db || fs.existsSync(libraryDir)) writeFileDurable(keep + '.zip', await library.exportZip(images.forExport));
    await shares.removeAll(target.id);
    await revisions.erase(target.id);
    if (db) await library.erase();
    if (fs.existsSync(root)) fs.renameSync(root, keep);
    await users.remove(target.id);
    logServerError('admin', new Error(`account ${target.id} removed by ${me.id}; library kept at ${path.basename(keep)}`));
    redirect(res, '/admin?notice=' + encodeURIComponent(`Removed ${target.email}. Its library is under removed/ on the volume.`));
  }

  // ---------------------------------------------------------------------
  // Public pages: a published snapshot, read-only, for anyone with the link
  // ---------------------------------------------------------------------
  // The HTML came from the editor's exporter: its own styles inline, fonts and
  // the cover as data: URIs, no script. The policy says so, so that a page
  // that somehow carried one still runs nothing. Not for search engines: the
  // link is the writer's to hand out.
  const PUBLIC_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  async function servePublicPage(token, res) {
    const share = isToken(token) ? await shares.find(token) : null;
    if (!share) throw new HttpError(404, 'Not found');
    send(res, 200, share.html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': PUBLIC_PAGE_CSP, 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  }

  // ---------------------------------------------------------------------
  // Daily backups, one zip per writer per day, swept hourly; a copy of each
  // goes to the bucket when one is configured (lib/object-store.js)
  // ---------------------------------------------------------------------
  const offsiteCopyFor = (id) => (objectStore.enabled ? (name, bytes) => objectStore.put(`${id}/${name}`, bytes, 'application/zip') : undefined);
  async function backupEveryone() {
    let ids = [];
    try { ids = db ? await users.listIds() : fs.readdirSync(path.join(config.dataDir, 'users')); } catch { return; }
    for (const id of ids) {
      const root = userRoot({ id });
      const settings = readJSON(path.join(root, 'settings.json'), {});
      const t = i18n.translatorFor(settings.uiLanguage || 'en');
      const libraryDir = path.join(root, LIBRARY_FOLDER);
      if (!db && !fs.existsSync(libraryDir)) continue;
      const logError = (source, err) => logServerError(`${id} ${source}`, err);
      try { await openWriterLibrary({ userId: id, libraryDir, t, logError }).library.dailyBackup(offsiteCopyFor(id)); } catch (err) { logError('backup', err); }
    }
  }
  const timers = [];
  function startBackups() {
    timers.push(setTimeout(() => backupEveryone().catch((err) => logServerError('backup', err)), 60 * 1000).unref());
    timers.push(setInterval(() => backupEveryone().catch((err) => logServerError('backup', err)), BACKUP_SWEEP_MS).unref());
  }

  return {
    server, users, db, revisions, ready, spell, mailer, objectStore, printer, config, backupEveryone, startBackups,
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
  app.ready.then(({ store, imported, libraries }) => {
    const librariesLabel = store === 'postgres' ? 'postgres' : 'volume';   // folders on the volume when accounts are in users.json
    app.server.listen(config.port, () => {
      console.log(`NEO hosted ${VERSIONS.hosted} (NEO ${VERSIONS.neo}) listening on :${config.port}`);
      console.log(`library volume: ${config.dataDir}  users: ${store}${imported ? ` (${imported} imported from users.json)` : ''}  libraries: ${librariesLabel}${libraries ? ` (${libraries} imported from the volume)` : ''}  signup: ${config.signup}  email: ${app.mailer.enabled ? 'on (Resend)' : 'off'}  backups: ${app.objectStore.enabled ? `volume + bucket ${app.objectStore.bucket}` : 'volume only'}  images: ${app.objectStore.enabled ? 'bucket' : store === 'postgres' ? 'rows' : 'volume'}  pdf: ${app.printer.enabled ? `printer at ${config.printer.url}` : 'browser print view'}${config.dev ? '  (NEO_DEV: throwaway session secret)' : ''}`);
    });
    app.startBackups();
  }).catch((err) => {
    console.error('[main] could not open the user store:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, VERSIONS, ROOT_FILES, ROOT_DIRS };
