> [CLAUDE.md](../CLAUDE.md) > Architecture

# Architecture: three doorways, one editor

NEO's desktop app is three layers: the page (`index.html` + `app.js`), a doorway (`preload.js`, which exposes `window.neo`), and a main process (`main.js`, which owns the disk). Pocket, the phone app, keeps the page and swaps the doorway (`pocket/www/pocket-bridge.js`). The hosted edition does the same, one more time.

```
desktop   index.html + app.js  →  preload.js  (window.neo)  →  main.js         →  ~/Documents/NEO Library
pocket    index.html + app.js  →  pocket-bridge.js          →  Capacitor FS    →  Documents/NEO Library
hosted    index.html + app.js  →  web/public/web-bridge.js  →  web/server.js   →  <volume>/users/<id>/NEO Library
                                   (fetch, POST /api/<channel>)   (node:http, no framework)
```

`web-bridge.js` has the same method names as `preload.js`. Each one POSTs to `/api/<ipc channel>` with the same arguments `ipcRenderer.invoke` would have sent, and `web/lib/handlers.js` registers one function per channel, named after the `ipcMain.handle` it replaces. Read `main.js` and `handlers.js` side by side. The file-by-file map of `web/` is in [web/CLAUDE.md](../web/CLAUDE.md).

## No build step

The server serves `app.js`, `styles.css`, `covers.js`, `i18n.js`, `fonts/` and `locales/` straight from the repository root. A change to the editor is a change to the hosted edition, as it is for Pocket. The page is built from `index.html` at request time (`web/lib/page.js`) by replacing four marked lines: the CSP meta tag (the server sends the policy as a header), the frameless-window drag strip, and the two script tags around which the hosted scripts are slotted. If upstream moves a marker, the server refuses to boot and `web/test/page.test.js` names it.

## Request lifecycle

1. `server.js` reads the session cookie, verifies its signature (`lib/auth.js`), and finds the writer (`lib/user-store.js`).
2. `contextFor(user, req)` builds the writer's context: their locale (saved choice, else `Accept-Language`), a translator bound to it, an `openLibrary()` over `<data>/users/<id>/NEO Library`, their settings and secrets files, and an error logger that appends to their own `neo-errors.log`.
3. `POST /api/<channel>` parses `{ args: [...] }`, calls the handler as `fn(ctx, ...args)`, and answers `{ ok: true, result }`. A thrown error answers `{ ok: false, error }` with status 500 and is logged for that writer. The bridge rethrows, so `persistChapter` in `app.js` rolls back `savedHTML` and retries on the next flush, as on the desktop.
4. Two routes are not channels because they move bytes: `POST /api/cover:upload` (raw image body) and `GET /library/<book>/<cover-or-art-file>` (the shelf's images).

## A writer's corner of the volume

```
<NEO_DATA_DIR>/
  users.json                        who can sign in (see auth-and-users.md)
  neo-errors.log                    the server's own failures
  users/<id>/
    settings.json                   uiLanguage
    secrets.json                    API keys, encrypted (AES-256-GCM, key derived from NEO_SESSION_SECRET)
    NEO Library/                    exactly the desktop layout (AGENTS.md, "Files on disk")
      library.json  _catalog.txt  neo-errors.log
      Backups/neo-backup-YYYY-MM-DD.zip   one per day, 14 kept, swept hourly by the server
      Trash/<book-id>--<timestamp>/       a "deleted" book; there is no system trash on a server
      book-<slug>-<id>/ ...
```

A writer can download their `NEO Library` folder and open it in desktop NEO, or drop a desktop library in and carry on. Two browsers signed into the same account see each other's edits through the same `refreshFromDisk` machinery that syncs two laptops over iCloud: `chapter:stamps` answers with `mtime:size`, and `app.js` decides what to adopt. Nothing here replaces that with last-write-wins; AGENTS.md, "Saving and sync", explains why.

## What was ported from main.js, and must stay in step

`web/lib/files.js` and `web/lib/library.js` are ports, not imports, because `main.js` requires Electron at the top. They carry the same contracts:

| In `main.js` | Here | Contract |
|---|---|---|
| `libName` | `files.libName` | one path segment; `.`, `..`, slashes and null bytes throw |
| `writeFileDurable` | `files.writeFileDurable` | tmp, fsync, rename, fsync the folder |
| `readJSON` / `writeJSON` | `files.readJSON` / `files.writeJSON` | `.bak` of the last whole version; reads fall back on `.tmp` then `.bak` and restore |
| `rebuildBookMeta` | `library.rebuildBookMeta` | a lost `book.json` comes back from the chapter files and the catalog |
| `library:read` recovery | `library.readLibrary` | an unreadable `library.json` with no copy puts every book on one shelf |
| `dailyBackup` | `library.dailyBackup` | one zip a day, 14 kept, `Backups/`, `Exports/` and `Trash/` left out |
| `book:delete` → `shell.trashItem` | `library.trashBook` | the folder moves to `Trash/` inside the library, timestamped |

A fix to one of these upstream needs the same fix here. Lifting them into a module both can `require` is welcome once the hosted edition has settled.

## Security posture in one paragraph

Scripts are `'self'` only, as on the desktop; styles allow inline because `index.html` already carries `style=""` attributes. Sessions are signed HttpOnly SameSite=Lax cookies; cross-site POSTs are refused by `Sec-Fetch-Site`. Every name the page sends passes `libName`; every static path is fenced to its root. Covers are served only by NEO's own `cover-*`/`art-*` names. Details and known gaps are in [auth-and-users.md](auth-and-users.md).
