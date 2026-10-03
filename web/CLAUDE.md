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
    auth.js             hashPassword/verifyPassword (scrypt), signSession/verifySession (HMAC), LoginThrottle
    user-store.js       JsonUserStore: count, findByEmail, findById, create, setPasswordHash
    secrets.js          createSecretBox(masterSecret): read/write/has, AES-256-GCM per writer
    files.js            libName, writeFileDurable, readJSON, writeJSON  (port of main.js)
    library.js          openLibrary({dir, t, logError}): one writer's NEO Library  (port of main.js)
    handlers.js         registerHandlers(api, deps): one function per IPC channel
    spell.js            SpellService: shared Hunspell per language; SPELL_LANGUAGES; defaultSpellLanguage
    i18n.js             listLanguages, resolveLanguage, bundleFor, translatorFor, pickLanguage
    page.js             buildHostedPage(indexHtml, i18n, hostedConfig), PAGE_CSP, MARKERS
  public/
    web-bridge.js       window.neo for the browser; rpc(channel, ...args) → POST /api/<channel>
    web-menu.js         the menu bar: template() mirrors buildMenu(); accelerators; Alt/F10
    web.css             menu bar and sign-in styles, on styles.css's tokens
    login.html, login.js  sign in / create account (English only for now)
  scripts/smoke.e2e.js  optional headless-Chromium run, see docs/testing.md
  test/*.test.js        node:test; server.test.js boots the real server
```

## Request path

`server.js` → `route(req, res)`: health, public static files, `/auth/*`, then everything that needs a writer. `currentUser(req)` verifies the cookie and loads the user; `contextFor(user, req)` builds the context; `handleApi` dispatches `POST /api/<channel>` to `api.handlers`. Errors become `{ ok: false, error }`; an `HttpError` keeps its status, anything else is 500 and logged. Full narrative in [docs/architecture.md](../docs/architecture.md#request-lifecycle).

The context (`ctx`) a handler receives:

| Field | What it is |
|---|---|
| `user` | `{ id, email, ... }` from the store |
| `locale`, `t` | the writer's interface language and a translator bound to it |
| `library` | `openLibrary()` over `<data>/users/<id>/NEO Library` |
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

Bytes (uploads, images) are not channels: see `handleCoverUpload` and `serveCover` in `server.js` for the pattern.

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
- **New strings** in `web-bridge.js` and `web-menu.js` are scanned by `scripts/i18n.js`; run `node scripts/i18n.js template`.
