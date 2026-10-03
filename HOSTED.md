# NEO, hosted

NEO is [Hugh Howey's](https://github.com/hughhowey/neo) word processor for authors: a local Electron app, MIT licensed, opinionated on purpose. This repository is a fork that serves the same app as an authenticated website, so a writer can open their shelf from any browser and keep writing. Every opinion in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) still holds. The editor is Hugh's `app.js`, unchanged; what this fork adds is a server that stands where `main.js` stood.

## Credit

- **NEO** — Hugh Howey, [hughhowey/neo](https://github.com/hughhowey/neo), MIT. The editor, the shelf, the covers, the export formats, the translations, the whole philosophy. Everything a writer sees is his work.
- **Hunspell** — the spellcheck engine, via [`@farscrl/hunspell-wasm`](https://www.npmjs.com/package/@farscrl/hunspell-wasm). Licenses in `licenses/hunspell`.
- **Dictionaries** — the `dictionary-*` packages by Titus Wormer and the original dictionary authors (see `licenses/`).
- **JSZip** — Stuart Knightley, for EPUB, Word and backups.
- **The hosted edition** — `web/`, `Dockerfile`, `railway.json`, this document. MIT, same as NEO.

Keep the upstream `LICENSE` and credits in any deployment. The sign-in page and the Help menu name Hugh and link to his repository.

## How it fits together

The desktop app is three layers: the page (`index.html` + `app.js`), a doorway (`preload.js`, which exposes `window.neo`), and a main process (`main.js`, which owns the disk). Pocket, the phone app, already proved the shape: it keeps the page and swaps the doorway (`pocket/www/pocket-bridge.js`). The hosted edition does the same, one more time.

```
desktop   index.html + app.js  →  preload.js  (window.neo)  →  main.js         →  ~/Documents/NEO Library
pocket    index.html + app.js  →  pocket-bridge.js          →  Capacitor FS    →  Documents/NEO Library
hosted    index.html + app.js  →  web/public/web-bridge.js  →  web/server.js   →  <volume>/users/<id>/NEO Library
                                   (fetch, POST /api/<channel>)   (node:http, no framework)
```

`web-bridge.js` has the same method names as `preload.js`. Each one POSTs to `/api/<ipc channel>` with the same arguments `ipcRenderer.invoke` would have sent, and `web/lib/handlers.js` registers one function per channel, named after the `ipcMain.handle` it replaces. Read `main.js` and `handlers.js` side by side.

| Piece | File | Stands in for |
|---|---|---|
| Server, routes, sessions | `web/server.js` | the Electron main process and window |
| `window.neo` channels | `web/lib/handlers.js` | `ipcMain.handle(...)` in `main.js` |
| One writer's library on disk | `web/lib/library.js`, `web/lib/files.js` | `libName`, `writeFileDurable`, `readJSON`, `rebuildBookMeta`, the chapter and cover handlers, `dailyBackup` |
| Spellcheck for everyone | `web/lib/spell.js` | `spell-worker.js` and the `spell:` handlers |
| Who can sign in | `web/lib/auth.js`, `web/lib/user-store.js` | nothing: the desktop has one writer |
| API keys at rest | `web/lib/secrets.js` | `safeStorage` and `secrets.json` in `userData` |
| Interface language | `web/lib/i18n.js` | `i18n:get`, `listLanguages`, `setUiLanguage` |
| The page itself | `web/lib/page.js` | serves the real `index.html` with the hosted scripts slotted in |
| The doorway in the browser | `web/public/web-bridge.js` | `preload.js` |
| Menus | `web/public/web-menu.js` | `buildMenu()` in `main.js` |
| Sign in | `web/public/login.html`, `login.js` | nothing |

One piece is shared rather than ported: `import-parse.js` at the repository root turns a .docx, .txt or .md manuscript into chapters, and both `main.js` and `web/server.js` require it. A fix to chapter detection lands in both editions at once.

There is no build step. The server serves `app.js`, `styles.css`, `covers.js`, `i18n.js`, `fonts/` and `locales/` straight from the repository root, so a change to the editor is a change to the hosted edition, as it is for Pocket. The page is built from `index.html` at request time by replacing four marked lines; if upstream moves one, the server refuses to boot and `web/test/page.test.js` names the marker.

## What a writer gets

Everything plain-file NEO promises, per account:

```
<NEO_DATA_DIR>/
  users.json                        who can sign in (see "Users" below)
  neo-errors.log                    the server's own failures
  users/<id>/
    settings.json                   uiLanguage
    secrets.json                    API keys, encrypted (AES-256-GCM, key derived from NEO_SESSION_SECRET)
    NEO Library/                    exactly the desktop layout
      library.json  _catalog.txt  neo-errors.log
      Backups/neo-backup-YYYY-MM-DD.zip   one per day, 14 kept, swept hourly by the server
      Trash/<book-id>--<timestamp>/       a "deleted" book; there is no system trash on a server
      book-<slug>-<id>/ ...
```

A writer can download their `NEO Library` folder and open it in desktop NEO, or drop a desktop library in and carry on. Two browsers signed into the same account see each other's edits through the same `refreshFromDisk` machinery that syncs two laptops over iCloud: `chapter:stamps` answers with `mtime:size`, and `app.js` decides what to adopt. Nothing here replaces that with last-write-wins.

## Parity with the desktop

| Desktop | Hosted | Notes |
|---|---|---|
| Shelves, books, chapters, notes, outline, darlings, stickies, goals | ✔ | the same files, the same code |
| Covers: seeded art, uploaded images | ✔ | upload is a raw `POST /api/cover:upload`; the shelf fetches `/library/<book>/<file>` |
| Painted covers (OpenAI) | ✔ | `art.js` runs on the server with the writer's own key, encrypted at rest |
| Spellcheck pass, suggestions, learned words | ✔ | one Hunspell per language shared by all writers; a writer's `customWords` are laid on top at check time, never added to the shared instance |
| Export txt, md, html, docx, epub | ✔ | built by `app.js` as before; the browser downloads the file |
| Export PDF, ⌘E email snapshot | ◐ | the browser opens the export as a print view ("Save as PDF") and a mail draft; no server-side PDF yet |
| Import .docx / .txt / .md | ✔ | the browser uploads each file as raw bytes to `POST /api/import:upload`; the parser is `import-parse.js`, the same module `main.js` uses |
| Daily zip backups | ✔ | per writer, inside their library; off-site copies are on the backlog |
| Delete a book | ✔ | moves to `Trash/` inside the library, named with a timestamp |
| Menus and shortcuts | ✔ | a hover-revealed bar at the top edge, Alt or F10 for the keyboard; same labels, same messages |
| Interface language, 10 languages | ✔ | saved per writer; the sign-in page is English for now |
| Full screen | ✔ | the browser's Fullscreen API |
| Auto-update | — | the site is always current; Help → Check for Update is gone from the menu |
| Library Folder… | — | the server chooses the folder |

## Users and sign-in

Email and password. Passwords are scrypt hashes (parameters recorded in the hash, so they can be raised). A session is a signed, HttpOnly, SameSite=Lax cookie that lasts 30 days; nothing is stored server-side, so a restart signs nobody out and rotating `NEO_SESSION_SECRET` signs everybody out (and makes stored API keys unreadable; writers paste them again). Cross-site requests are refused by `Sec-Fetch-Site`, and ten wrong passwords from one address or for one email close the door for fifteen minutes.

`NEO_SIGNUP` is `open`, `invite` (a shared `NEO_INVITE_CODE`) or `closed`. The very first account can always be created, so a fresh deployment has an owner.

**On the database question.** Users live in one JSON file behind `JsonUserStore`, five methods. That is right for a household or a writing group, and it keeps "books are plain files" true of the people too. Reach for Postgres when one of these becomes true: more than one server instance behind the proxy (the JSON file is not shared), thousands of writers (every lookup reads the file), or password reset by email and other state that wants transactions. The swap is a second class with the same five methods, chosen in `server.js`. Libraries stay files either way; a database would hold accounts, never manuscripts.

## Running it

```
cd web && npm install && cd ..
NEO_DEV=1 NEO_SIGNUP=open npm run start:web      # http://localhost:8080, throwaway session secret
npm run test:web                                  # node --test web/test/*.test.js
```

Environment (all read once in `web/lib/config.js`):

| Variable | Meaning |
|---|---|
| `PORT` | Railway sets it. Default 8080. |
| `NEO_DATA_DIR` | The volume. Default `./data`. |
| `NEO_SESSION_SECRET` | 32+ random characters. Required unless `NEO_DEV=1`. |
| `NEO_SIGNUP` | `open`, `invite` (default), `closed`. |
| `NEO_INVITE_CODE` | Needed when `NEO_SIGNUP=invite`. |
| `NEO_TRUST_PROXY` | `1` behind a TLS-terminating proxy. Defaults on when `RAILWAY_ENVIRONMENT` is set. |

### Railway

1. New project → Deploy from this GitHub repo. `railway.json` picks the `Dockerfile`; the image installs only `web/package.json`'s runtime dependencies (no Electron).
2. Add a **Volume** and mount it at `/data`.
3. Set `NEO_SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `NEO_SIGNUP` and, for invite mode, `NEO_INVITE_CODE`.
4. Generate a domain. Health checks hit `/healthz`.
5. Open the site, create the first account.

The volume is the only state. Back it up: the daily zips live on it too, so they protect against a writer's mistake, not against losing the volume (backlog below).

## Backlog

Extensions planned for this fork, in rough order. Each one keeps the rules: nothing interrupts a writer mid-sentence, controls stay hidden until asked for, words are never discarded, books stay plain files.

1. **Off-site backups** of each writer's daily zip to an S3-compatible bucket; and a **Download my library** item in the File menu (one zip, the whole folder).
2. **Server-side PDF** for exports and the email snapshot, with a headless Chromium only if the image stays reasonable; otherwise keep the print view.
3. **Mind map** — a canvas sidecar per book (`mindmap.json`), nodes that can link to chapters and placeholders.
4. **Map map** — a place to draw the world: an image or a blank sheet, pins that link to chapters and notes (`maps.json`, images beside it).
5. **Timelines** — a `timeline.json` sidecar: events with story-time and chapter references, drawn on one line, dragged to reorder.
6. **Handwritten notes** — a stylus pad that saves strokes as SVG beside the stickies, never OCR'd into the manuscript unless asked.
7. **AI throughout** — only ever at the writer's request, never while typing: ask a question of the manuscript, name a placeholder, continue a scene into Darlings (never onto the page), paint covers as today. Keys per writer, encrypted as today. Upstream NEO is firm that it has no generative tools; this fork adds them as opt-in rooms off the hallway, not squiggles on the page.
8. **Password reset** by email, and with it the move of users to a real store (see above).
9. **Translate the sign-in page** with the same `locales/` files.

## For agents

Read [AGENTS.md](AGENTS.md) first. Then:

- A new `window.neo` capability is added in three places, as on the desktop, plus one: `ipcMain.handle` in `main.js`, the method in `preload.js`, the call in `app.js`, and now the channel in `web/lib/handlers.js` with its method in `web/public/web-bridge.js` (and in `pocket-bridge.js`, which the desktop rule already implies).
- Pocket-only behavior goes in the Pocket bridge; hosted-only behavior goes in `web/`. Neither belongs behind a branch in `app.js`.
- Import is the model for the rest: `import-parse.js` is one module both editions require, so there is nothing to keep in step. The Dockerfile copies it beside `app.js`; a new shared root module needs the same line.
- `web/lib/files.js` and `web/lib/library.js` are ports of `main.js`. A fix to `writeFileDurable`, `readJSON` or `rebuildBookMeta` upstream needs the same fix here; the comments at the top of each file say so. Lifting them into a module both can `require` is welcome once the hosted edition has settled.
- `scripts/i18n.js` scans `web/public/web-bridge.js` and `web/public/web-menu.js`. A new writer-visible string in `web/` goes through `t()` (the bridge's `tr()`) and `node scripts/i18n.js template`.
- Tests: `npm run test:web`. They start the real server on a free port with a temporary data folder.
