> [CLAUDE.md](../CLAUDE.md) > web/

# web/ -- the hosted edition

The server and the browser-side pieces that stand where Electron's main process and preload stood. Everything a writer sees is still upstream's `app.js`, served from the repository root.

## Directory tree

```
web/
  server.js             entry point: routes, sessions, the per-writer context, backups timer. createApp(config)
  package.json          runtime deps only (hunspell-wasm, dictionary-*, jszip); the Dockerfile installs this, not the root
  lib/
    config.js           env → config; refuses to boot on a bad combination (loadConfig)
    http.js             readBody/readJSONBody with limits, sendJSON/HTML, serveFile (path-fenced), cookies, isSameOrigin
    auth.js             hashPassword/verifyPassword (scrypt), signSession/verifySession (HMAC), signLink/verifyLink (email links), LoginThrottle
    user-store.js       JsonUserStore (users.json) and PgUserStore (Postgres), one contract: count, findByEmail, findById, create, setPasswordHash, markEmailVerified, update; PgUserStore.importFrom; isEmailVerified
    db.js               openDatabase(DATABASE_URL): pool, query, migrate (MIGRATIONS applied once, recorded in schema_migrations), close
    revisions.js        RevisionLog(db): record, list, read, verify; makeDiff/applyDiff at paragraph grain; NullRevisionLog without a database
    branches.js         openBranches({dir, logError}): activeBranch, folderFor (library.js's bookDirFor), list, create, switchTo, remove; readChapterOf/readMetaOf and the .base readers; moveBaseForward; checkBranchName
    merge.js            mergeChapter(base, ours, theirs, resolve): three-way merge at paragraph grain; merge3; blackline(from, to)
    branch-merge.js     createMerger({branches, library}): preview(bookId, name), apply(bookId, name, resolutions); mergeOrder
    mail.js             createMailer({resendApiKey, from}): enabled, send; the confirmation and reset messages
    secrets.js          createSecretBox(masterSecret): read/write/has, AES-256-GCM per writer
    files.js            libName, writeFileDurable, readJSON, writeJSON  (port of main.js)
    library.js          openLibrary({dir, t, logError}): one writer's NEO Library  (port of main.js)
    handlers.js         registerHandlers(api, deps): one function per IPC channel
    spell.js            SpellService: shared Hunspell per language; SPELL_LANGUAGES; defaultSpellLanguage
    i18n.js             listLanguages, resolveLanguage, bundleFor, translatorFor, pickLanguage
    page.js             buildHostedPage(indexHtml, i18n, hostedConfig), PAGE_CSP, MARKERS
  public/
    web-bridge.js       window.neo for the browser; rpc(channel, ...args) → POST /api/<channel>
    web-menu.js         the menu bar: template() mirrors buildMenu(); accelerators; Alt/F10; File → History… opens web-history.js
    web-branches.js     File → Branches: new, switch, delete, Compare & Merge… (the merge panel: chapter list, blackline, conflict choices); a switch or merge saves, tells the server, reloads and reopens the book
    web-history.js      the History panel: a chapter's revisions (revision:list/read through the bridge), preview, restore by writing the draft back and calling the editor's refreshFromDisk
    web.css             menu bar and sign-in styles, on styles.css's tokens
    login.html, login.js  sign in / create account / forgot / reset, one form in four modes (English only for now)
  scripts/smoke.e2e.js  optional headless-Chromium run, see docs/testing.md
  docker-entrypoint.sh  starts as root, hands the mounted volume to `node`, drops privileges (docs/deployment.md)
  test/*.test.js        node:test; server.test.js boots the real server
../import-parse.js      NOT in web/: the manuscript parser shared with main.js (importBuffer, isImportable, CHAPTER_WORDS)
```

## Request path

`server.js` → `createApp(config, deps)` picks the user store (`PgUserStore` over `deps.db` or `config.databaseUrl`, else `JsonUserStore`) and exposes `ready`, which runs the migrations and the one-time `users.json` import; `main` awaits it before listening. Then `route(req, res)`: health, public static files, `/auth/*` (signup, login, logout, forgot, reset, and `GET /auth/verify` for the confirmation link), then everything that needs a writer. `currentUser(req)` verifies the cookie and loads the user; `contextFor(user, req)` builds the context; `handleApi` dispatches `POST /api/<channel>` to `api.handlers`. Errors become `{ ok: false, error }`; an `HttpError` keeps its status, anything else is 500 and logged. Full narrative in [docs/architecture.md](../docs/architecture.md#request-lifecycle).

The context (`ctx`) a handler receives:

| Field | What it is |
|---|---|
| `user` | `{ id, email, ... }` from the store |
| `locale`, `t` | the writer's interface language and a translator bound to it |
| `library` | `openLibrary()` over `<data>/users/<id>/NEO Library` |
| `revisions` | this writer's slice of the revision log, keyed by the branch they are in: `record(bookId, chapterId, html)`, `list`, `read(id)`, `verify`; a no-op without Postgres |
| `branches` | `openBranches()` for this library: `list`, `create`, `switchTo`, `remove`, `activeBranch` |
| `merger` | `createMerger()` over `branches` and `library`: `preview(bookId, name)`, `apply(bookId, name, resolutions)` |
| `secretsFile` | `<data>/users/<id>/secrets.json` |
| `logError(source, err)` | appends to the writer's own `neo-errors.log` |
| `setLanguage(code)` | saves `uiLanguage` in the writer's `settings.json` |

## Adding a channel

1. `main.js`: the `ipcMain.handle`, as upstream would. `preload.js`: the method. `app.js`: the call. (AGENTS.md's three places.)
2. `web/lib/handlers.js`: `api.handle('<same channel name>', (ctx, ...args) => ...)`. Disk work goes through `ctx.library`; add a method to `library.js` if none fits, and keep every name inside `libName`.
3. `web/public/web-bridge.js`: `name: (...args) => rpc('<channel>', ...args)`. Browser-only behavior (downloads, pickers, full screen) is implemented here instead of a channel.
4. `pocket/www/pocket-bridge.js`: the method, or an honest stub, so Pocket keeps working.
5. `web/test/server.test.js`: assert the shape `app.js` relies on.
6. Docs: this file's tree if a file was added; [docs/parity.md](../docs/parity.md) if a writer can tell.

Bytes (uploads, images, manuscripts) are not channels: see `handleCoverUpload`, `handleImportUpload` and `serveCover` in `server.js` for the pattern.

## Gotchas

- **The shared i18n singleton.** `translatorFor()` sets the global locale on every call. Library code is synchronous, so writers never see each other's language; do not hold a `t()` across an `await`.
- **Handlers are synchronous by design** (small files, one Node thread). `cover:paint`, `spell:*` and `dailyBackup` are the async exceptions.
- **Bad names throw on reads too.** `readChapter` and `readAux` compute the path outside their `try`, as `main.js` does, so `../x` is an error, not an empty string. `library.test.js` checks it.
- **A missing `library.json` is seeded, an unreadable one is recovered.** Same as the desktop; a test that deletes the file is testing the wrong path.
- **The bridge never redirects on 401.** It toasts once and keeps throwing, so unsaved words stay on the page and `persistChapter` retries after the writer signs in elsewhere.
- **Files handed to the page** (`pathForFile`, `pickCover`) become `upload:<n>/<name>` tokens kept in a Map, so `app.js`'s extension checks still work; `setCover` turns the token back into bytes.
- **The menu bar rebuilds on `mouseenter`, not on click,** so the button being pressed is never replaced mid-click. Its open-list CSS needs the `#hosted-menubar` prefix to outrank the generic `ul` rule.
- **Accelerators `app.js` already owns** (⌘; ⌘+ ⌘− ⌘/) are not in `web-menu.js`'s table; see [docs/parity.md](../docs/parity.md#accelerators).
- **`index.html` markers** (`page.js` `MARKERS`): the CSP meta, the drag strip, and the two script tags. A moved marker throws at boot.
- **Static roots are allowlisted** (`ROOT_FILES`, `ROOT_DIRS` in `server.js`). `main.js`, `preload.js`, `package.json` are never served.
- **New strings** in `web-bridge.js`, `web-menu.js` and `web-history.js` are scanned by `scripts/i18n.js`; run `node scripts/i18n.js template`.
- **The page's open book is not readable from outside `app.js`** (`book` and `currentChapterId` are top-level `let`s). The bridge notes the last book id it was asked about (`neoHosted.state.bookId`), and `web-history.js` finds the chapter from the DOM (`section.chapter[data-id]` holding the caret, else nearest the middle). A restore goes through `chapter:write` plus the editor's own `refreshFromDisk`, so replaced words land in Darlings exactly as an edit from another device would.
- **Every user-store call is awaited.** `JsonUserStore` is synchronous and `PgUserStore` is not; the contract says "may return a promise", so `currentUser`, `signupAllowed` and the `/auth/*` handlers are all async. A new call site that forgets `await` passes the JSON tests and breaks on Railway.
- **`library.bookDir()` is the active branch, `bookRoot()` is the book.** Chapters, meta, sidecars and covers go through `bookDir`; `trashBook` and the branch folders themselves use the root. A new library method that touches the folder must pick the right one.
- **Switching a branch reloads the page.** `refreshFromDisk` in `app.js` treats a changed file as another device's edit and would send the words it replaced to Darlings, which is right for a device and wrong for a branch. So `web-branches.js` saves, switches, reloads, and reopens the book through the editor's global `openBook`.
- **`merge.js` is pure and `branch-merge.js` owns the files.** A change to how paragraphs are matched belongs in `merge.js` with a case in `merge.test.js`; what counts as a chapter's base, order or title belongs in `branch-merge.js`. `apply` writes through `library`, never to a branch folder directly, so the log and the catalog see it.
- **A failed revision never fails a save.** `chapter:write` writes the file first and catches what `ctx.revisions.record` throws into the writer's error log. Keep that order if the handler changes.
- **SQL lives in `db.js`, `PgUserStore` and `RevisionLog` only.** A new table is a new entry appended to `MIGRATIONS`, never an edit to a deployed one, and a handler never sees a query.
- **Email is optional and the server must not care.** `mailer.enabled` is the only question `server.js` asks; with it off, signup signs in at once and `/auth/forgot` answers 503. Tests pass a stub mailer as `createApp(config, { mailer })` and read what it would have sent.
