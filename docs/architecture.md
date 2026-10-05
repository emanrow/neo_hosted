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
2. `contextFor(user, req)` builds the writer's context: their locale (saved choice, else `Accept-Language`), a translator bound to it, their library (rows in Postgres with `DATABASE_URL`, `web/lib/pg-library.js`; the folder `<data>/users/<id>/NEO Library` without, `web/lib/library.js`; one contract, every call awaited), their settings and secrets files, and an error logger that appends to their own `neo-errors.log`.
3. `POST /api/<channel>` parses `{ args: [...] }`, calls the handler as `fn(ctx, ...args)`, and answers `{ ok: true, result }`. A thrown error answers `{ ok: false, error }` with status 500 and is logged for that writer; a refusal the handler meant (an `HttpError`, such as feedback with email off) keeps its own status and is not logged. The bridge rethrows, so `persistChapter` in `app.js` rolls back `savedHTML` and retries on the next flush, as on the desktop.
4. `chapter:write` writes the chapter, then appends a row to the revision log (`lib/revisions.js`) when the words changed; a log failure is logged for the writer and never fails the save. The log lives in Postgres beside the accounts ([auth-and-users.md](auth-and-users.md#where-users-live)); without a database it is a no-op. `revision:list`, `revision:read` and `revision:verify` read it back for the History panel.
5. Four routes are not channels because they move bytes: `POST /api/cover:upload` (raw image body), `POST /api/import:upload?name=` (a raw manuscript in, the parsed book out; the page then creates the book over the ordinary channels, nothing is written server-side), `GET /library/<book>/<cover-or-art-file>` (the shelf's images) and `GET /library.zip` (File → Download Library…: the whole library as the desktop folder).

## Where a writer's words live

With `DATABASE_URL` set (the hosted site), a library is rows in Postgres (`lib/pg-library.js`, migration `003-library` in `lib/db.js`), laid out as the desktop folder, one row per file:

| Table | Holds |
|---|---|
| `libraries` | `library.json`, one row per writer |
| `books` | one row per book: which branch is active, when it was trashed (never dropped) |
| `branches` | one row per draft of a book, `main` included: where it came from and when; a deleted branch is renamed under `Trash/` and marked, so the name is free again |
| `book_files` | every file of every draft, keyed by book, branch and path: `book.json`, `chapters/<id>.html`, `notes.html`, `darlings.json`, `cover-<ts>.png` (bytes) ...; `modified` answers `chapter:stamps` |
| `branch_bases` | the chapters and `book.json` a branch started from, what a merge measures against |
| `shares` | public pages (File → Share…): one row per published book or chapter, the export HTML as a snapshot, keyed by an unguessable token (`web/lib/share-store.js`); on a laptop these are `<data>/shares/<token>.json` and `.html` instead |

Every read and write joins `books.active_branch`, so a channel reads and writes "the book" and lands on the draft the writer is in; the editor never learns which. A branch is made in one transaction: the rows copied, the base taken, the pointer moved. Trashing a book or a branch marks it; listings skip it, the rows stay, so words are never discarded. Covers and paintings are bytes in the same table for now ([backlog.md](backlog.md) moves images to object storage later).

**Files are the export.** `GET /library.zip` (File → Download Library…) and the daily backup write the rows out as the desktop folder, byte for byte, branches under `.branches/<name>/` and bases under `.base/`, so the zip opens in desktop NEO and drops back into a folder-mode server. `pg-library.js`'s `importFolder` is the inverse: the first boot with Postgres brings every writer's `NEO Library` folder on the volume into rows and renames the folder `NEO Library.imported-<date>`; Trash and old zips stay where they were.

Without a database (a laptop, the tests), `lib/library.js` and `lib/branches.js` keep the same contract over the folder below, exactly the desktop layout. What stays on the volume either way:

```
<NEO_DATA_DIR>/
  users.json                        who can sign in without Postgres (see auth-and-users.md)
  shares/<token>.json, .html        public pages without Postgres (lib/share-store.js)
  removed/<id>-<stamp>.zip, <id>-<stamp>/   an account the owner removed from /admin: its library zipped as the desktop folder, and its folder moved here
  neo-errors.log                    the server's own failures
  users/<id>/
    settings.json                   uiLanguage; welcomedAt once a guest of honor has seen the welcome
    secrets.json                    API keys, encrypted (AES-256-GCM, key derived from NEO_SESSION_SECRET)
    NEO Library/                    with Postgres: only the two lines below; without: the desktop layout (AGENTS.md, "Files on disk")
      neo-errors.log                this writer's failures
      Backups/neo-backup-YYYY-MM-DD.zip   one per day, 14 kept, swept hourly by the server (lib/backups.js)
      Backups/neo-backup-YYYY-MM-DD.zip.offsite   present once that zip landed in the bucket (lib/object-store.js), when one is configured
      library.json  _catalog.txt          folder mode only, and the rest of this list
      Trash/<book-id>--<timestamp>/       a "deleted" book; there is no system trash on a server
      Trash/<book-id>--branch-<name>--<timestamp>/   a deleted branch
      book-<slug>-<id>/ ...               the main draft (the desktop layout, plus timeline.json and mindmap.json for the rooms under View)
        .branches/active                  names the branch the writer is in (absent or "main": the folder above)
        .branches/<name>/ ...             a whole alternate draft: the same layout, plus branch.json (hosted only)
        .branches/<name>/.base/           the chapters and book.json the branch started from (moved forward by each merge)
```

**Branches** (hosted only): a branch is a whole copy of the draft the writer is in, rows or folder. Switching saves the page, moves the pointer and reloads the page, which reopens the book: two drafts are never merged onto one page. Deleting a branch marks it (rows) or moves it to Trash (folder); trashing the book takes its branches along; the zip carries them. The revision log keys rows by branch, and a new branch opens its history with the draft it came from.

**Merging** (`lib/merge.js`, `lib/branch-merge.js`): Compare & Merge… brings a branch into the draft the writer is in. Each chapter is a three-way merge at paragraph grain between the branch's `.base` snapshot, the branch now and this draft now: a paragraph changed on one side takes that side, changed alike on both lands once, changed differently on both is a conflict the writer settles in the panel (keep mine, take theirs, or keep both, the default). Chapters new on the branch are added after the chapter they follow there; a chapter deleted on the branch stays here; a title given on the branch comes along when this draft kept the old one; notes, outline, stickies and darlings are not merged. The merged chapters are written through the library, so the revision log keeps them, and the branch's base moves forward to its current text so a second merge carries only what is new. `branch-merge.js` awaits every library call, so it runs over rows and over folders alike.

**The revision log** (Postgres, `revisions` table): one row per autosave that changed a chapter, a snapshot of the whole chapter every twentieth row and a paragraph-grain diff against the parent otherwise, each row hashed into the one before it with its timestamp. Rebuilding any revision walks back to the nearest snapshot and replays forward. The chapter row (or file) stays the chapter's truth; the log is history, and a chapter written before the log existed simply has history that starts at its next save.

A writer can download their library (File → Download Library…) and open it in desktop NEO. Two browsers signed into the same account see each other's edits through the same `refreshFromDisk` machinery that syncs two laptops over iCloud: `chapter:stamps` answers with `modified:size`, and `app.js` decides what to adopt. Nothing here replaces that with last-write-wins; AGENTS.md, "Saving and sync", explains why.

## What was ported from main.js, and must stay in step

`web/lib/files.js` and `web/lib/library.js` are ports, not imports, because `main.js` requires Electron at the top. They serve a server without Postgres and the tests, and `web/lib/pg-library.js` answers the same contract over rows. They carry the same contracts:

| In `main.js` | Here | Contract |
|---|---|---|
| `libName` | `files.libName` | one path segment; `.`, `..`, slashes and null bytes throw |
| `writeFileDurable` | `files.writeFileDurable` | tmp, fsync, rename, fsync the folder |
| `readJSON` / `writeJSON` | `files.readJSON` / `files.writeJSON` | `.bak` of the last whole version; reads fall back on `.tmp` then `.bak` and restore |
| `rebuildBookMeta` | `library.rebuildBookMeta` | a lost `book.json` comes back from the chapter files and the catalog |
| `library:read` recovery | `library.readLibrary` | an unreadable `library.json` with no copy puts every book on one shelf |
| `dailyBackup` | `library.dailyBackup(copy)` | one zip a day, 14 kept, `Backups/`, `Exports/` and `Trash/` left out; `copy(name, bytes)` sends it to the bucket and is retried hourly until it lands |
| `book:delete` → `shell.trashItem` | `library.trashBook` | the folder moves to `Trash/` inside the library, timestamped |

A fix to one of these upstream needs the same fix here. Lifting them into a module both can `require` is welcome once the hosted edition has settled.

One piece is already shared rather than ported: `import-parse.js` at the repository root turns a .docx, .txt or .md manuscript into chapters on a buffer, and both `main.js` and `web/server.js` require it (the server hands it its own JSZip). `CHAPTER_WORDS`, the per-language chapter-heading table translators maintain, lives there. A fix to chapter detection lands in both editions at once; it is the model for the rest of the table above.

## Security posture in one paragraph

Scripts are `'self'` only, as on the desktop; styles allow inline because `index.html` already carries `style=""` attributes. Sessions are signed HttpOnly SameSite=Lax cookies; cross-site POSTs are refused by `Sec-Fetch-Site`. Every name the page sends passes `libName`; every static path is fenced to its root. Covers are served only by NEO's own `cover-*`/`art-*` names. Details and known gaps are in [auth-and-users.md](auth-and-users.md).
