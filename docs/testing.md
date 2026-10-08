> [CLAUDE.md](../CLAUDE.md) > Testing

# Testing

Two suites, one tool: `node:test`. The hosted suite, the lint, the shared parser's tests and a boot of the Docker image run in GitHub Actions on every pull request and every push to `main` (`.github/workflows/hosted.yml`); upstream's own workflow packages the desktop app on `v*` tags. Run the hosted suite before every push anyway: the owner has no local environment, so a red check is the first anyone hears of a break.

## The hosted suite

```
cd web && npm install && cd ..      # once
npm run test:web                    # node --test web/test/*.test.js, one file at a time (two files share the scratch database)
npx oxlint -c .oxlintrc.json web/server.js web/lib web/public web/test
NEO_TEST_DATABASE_URL=postgres://neo:neo@127.0.0.1:5432/neo_test npm run test:web   # also the Postgres store, against a scratch database
```

| File | Covers |
|---|---|
| `web/test/library.test.js` | `libName`, durable writes, `.tmp`/`.bak` recovery, book layout, chapter stamps, `rebuildBookMeta`, lost `library.json`, Trash, covers, the daily zip and the download |
| `web/test/pg-library.test.js` | against a real Postgres: the library over rows (seed, books, chapters and stamps, covers as bytes, trash keeps rows, another writer sees nothing), branches as rows (create, switch, refusals, trash and reuse of the name), Compare & Merge over rows, a desktop folder imported with its branches, bases and cover and zipped back out as the same folder, the daily zip, a writer's footprint and erase, and the server on `{ db }` (including a save compared with the draft now): the folder on the volume imported on boot, every channel, the cover route, `/library.zip`, the backup sweep. Skipped unless `NEO_TEST_DATABASE_URL` is set; it drops the tables first |
| `web/test/auth.test.js` | password hashes, session tokens (tamper, expiry, wrong secret), the links in email (one purpose each, stamps, expiry), the mailer against a stub `fetch`, the throttle, the JSON user store and its confirmation state, the secret box, config validation including the email variables |
| `web/test/email.test.js` | the real server with email on and a mailer that keeps what it would have sent: a new writer waits for the confirmation link, signing in resends it, the link signs them in, a forgotten password comes back by link that works once, the ration on email per address |
| `web/test/db.test.js` | against a real Postgres: migrations run once, the user store (create/find/verify/password, the one-time import of `users.json`, the server booting with `{ db }` and signing an imported writer in) and the revision log (diffs round-trip, unchanged saves record nothing, the snapshot cadence, every revision rebuilds, another writer cannot read it, a rewritten timestamp breaks the chain, `chapter:write` through the server records history). Skipped unless `NEO_TEST_DATABASE_URL` is set; it drops the tables first. CI starts `postgres:16` as a service |
| `web/test/branches.test.js` | branch names, a branch as a copy of the draft the writer is in, the library following the active one, refusals, Trash, the dangling-pointer fallback |
| `web/test/merge.test.js` | the three-way paragraph merge on its own: one-sided edits, edits to different paragraphs, identical edits, conflicts and the three ways to settle them, deletions, insertions at one place, an empty base, the blackline |
| `web/test/branch-merge.test.js` | the merger over real folders (awaited, as over rows): the base snapshot, preview rows and conflicts, apply with resolutions, chapter order and titles, the base moving forward so a second merge is a no-op |
| `web/test/saves.test.js` | the chapter saver on its own (`web/public/web-saves.js` doubles as a CommonJS module) against a scripted server: a lost answer confirmed by reading back, a write that never landed sent again with a growing pause, newer words superseding older ones on their way, an error the server meant rejecting and freeing the lane, a failed read-back not counting as proof, one lane per chapter, the stalled count a closing page asks about |
| `web/test/page.test.js` | the `index.html` transform, script order, the viewport meta, inline-JSON escaping, the loud failure on a moved marker, the CSP |
| `web/test/spell.test.js` | the shared Hunspell with a writer's words laid on top, suggestions, the fallback when a dictionary cannot load |
| `web/test/share-store.test.js` | public pages on files: publish, list, find, republish under the same link, another writer sees and removes nothing, a bad token is nothing |
| `web/test/login-page.test.js` | the sign-in page in the visitor's language: every `web/locales/<code>.json` is complete with its placeholders intact, the overlay sits on upstream's dictionary, the template renders in German with the credits' links kept and no marker left, a hostile translation is escaped, English is itself |
| `web/test/image-store.test.js` | where a book's images live, on its own with a stand-in library and bucket: no bucket, bytes in the library; a bucket, the stub in the library and the bytes under `images/<writer>/<book>/<file>`, a read following the stub, an image from before the bucket still served, a refusing bucket falling back on the library, nothing sent for nothing, the export hook putting the picture back (a branch folder too), a stub whose bucket is gone reading as no image |
| `web/test/object-store.test.js` | the off-site copy and the images: the signature against the GET Object vector in AWS's SigV4 documentation, a `PUT` against a local stand-in bucket that recomputes the signature and the payload hash, a `GET` that brings the bytes back and a missing key that is null, a wrong secret refused, the `.offsite` marker and the retry in `backups.js`, and the bucket's environment variables in `config.js` |
| `web/test/server.test.js` | the real server on a free port with a temporary data folder, email off: health, static fencing, signup policy, CSRF refusal, the page, every channel's shape, cover upload and serving (the bytes in the stand-in bucket, the stub in the folder, the download zip carrying the picture), the library download, manuscript upload (.txt, .md, a .docx built in the test), Trash, secrets, spellcheck, language, throttle, password reset refused with no email, logout, the owner's page (listed accounts, Not found for anyone else, an account removed with its library zipped and its folder moved), a published page served to a stranger with its policy and taken down by its owner, the backup sweep landing on the volume and in a stand-in bucket |
| `web/test/figures.test.js` | pictures in a chapter on their own (`web/public/web-figures.js` doubles as a CommonJS module): where each sits among the paragraphs the exports keep, a caption's paragraph replaced and a captionless picture inserted, the text mark each carries through the editor's builders, the EPUB's image files, manifest items and `<figure>` for each marked paragraph, the Word file's inline drawing, caption, media part, relationship and content type (and its sizing to the page), the export HTML with the bytes inlined, the marks gone and the figure styles in its head |
| `web/test/footnotes.test.js` | footnotes on their own (`web/public/web-footnotes.js` doubles as a CommonJS module): the private-use mark a call carries through the editor's builders and the ids it encodes, the web page with calls, a list under each chapter and the print rules only when a note was laid, the EPUB's noteref calls and asides, the Word file's footnote references, `word/footnotes.xml`, relationship and content type, plain text and Markdown with the list, and a call whose note is gone dropped everywhere |
| `web/test/epub.test.js` | the EPUB polish on its own (`web/public/web-epub.js` doubles as a CommonJS module): the chosen face laid in as files, manifest items and `@font-face` rules with the body set in it, file names made safe, the drop cap on unless the editor hides it, and an EPUB left exactly as it was for a system face, a face with no files or an unknown layout |
| `web/test/boot.test.js` | `node web/server.js` itself, booted as Railway boots it, prints the "listening" line and the boot summary with no error (a name out of scope in that block once threw after "listening" and the summary never appeared) |
| `web/test/dockerfile.test.js` | the `Dockerfile` copies every root file the server serves or requires (`styles.css` once went missing from the image and nothing in the repository noticed), and names nothing that does not exist |
| `scripts/library-disk.test.js` | the shared disk module on its own: a library name, `.bak` and the read that falls back on it, a durable write, a lost `book.json` rebuilt from its chapters and titled from the catalog, a lost `library.json` reseeded, the catalog's lines, the backup walk leaving out the skipped folders and naming a file it could not read. Beside upstream's tests because `main.js` requires the same module; CI runs it with the parser's test |
| `scripts/import-parse.test.js` | the shared manuscript parser on its own: chapter and scene-break detection, titles, .docx italics and styles. Lives beside upstream's tests because `main.js` uses the same module; needs the root `npm install` (JSZip) |

The server test is the one to extend when a channel changes: it asserts the shapes `app.js` relies on.

## The printer's suite

`cd print && npm test` runs `print/test/print.test.js`: the secret and the boot checks, the concurrency gate, every trim size's page, and, when a Chromium is found (`CHROMIUM_PATH`, or `/usr/bin/chromium` in the image), the service over HTTP: a stranger turned away, a fragment refused, a small book rendered to a PDF of the trim's size with Paged.js's page count and a numbered contents page. CI (`hosted.yml`, job `print`) runs it against the runner's Chrome, then builds `print/Dockerfile`, boots the image and prints a book through it, so a Debian package or a Paged.js upgrade that breaks the printer shows as a red check.

## A browser smoke run

`web/scripts/smoke.e2e.js` boots the server with a throwaway data folder, signs up in headless Chromium, walks the first-run questions, opens a menu, changes the page theme, creates a book and a chapter, types a sentence, drops the answer to one save on purpose and checks the editor does not make a twin chapter of it ([saving.md](saving.md)), opens each room off the hallway (Timeline, Mind Map, Map, Handwriting, History, Share) and does one thing in it, and checks that the chapter HTML and each room's sidecar landed on disk with no console errors. It then opens the same book as a phone would (a 390px touch screen, `(hover: none)`), drops a menu from the ☰ button, checks the sheet is where the next tap lands and that the progress dialog fits the screen without sideways scrolling. It needs Playwright and a Chromium:

```
npm i -D playwright            # or point CHROMIUM_PATH at an installed Chromium
node web/scripts/smoke.e2e.js
```

It is not part of `npm test`; it is the thing to run after touching the bridge, the menu bar, or the page transform.

## The EPUB under epubcheck

```
cd web && npm i --no-save playwright-core && cd ..     # once; not a runtime dependency
EPUBCHECK_JAR=/path/to/epubcheck.jar CHROMIUM_PATH=... node web/scripts/epubcheck.e2e.js
```

Boots the server, writes a book with a dedication, a contents page, a part and two chapters in headless Chromium with Libron chosen, puts two pictures in it the way Format → Insert Picture… does (one captioned under the caret, Enter below it, one without) and a footnote the way Format → Insert Footnote… does (the call at the caret, the note typed in the pad; the chapter HTML, the editor's stylesheet, the sidecar, the web page export with its notes list and the Word file with its two drawings and its footnotes part are checked on the way; `EXPORT_DIR=` keeps the `.epub` and `.docx` it built), exports it the way File → Export → EPUB does (the editor's own `shelfPayload`, then the hosted polish), checks that the four faces and the drop cap landed, zips it as the bridge would, and runs [epubcheck](https://www.w3.org/publishing/epubcheck/) with `--failonwarnings`. CI runs it on every pull request (the `epub` job in [hosted.yml](../.github/workflows/hosted.yml), inside Playwright's image with a JRE and epubcheck 5.2.1 fetched), so a regression in the export shows up as a red check rather than a rejected upload. Without `EPUBCHECK_JAR` the file is built and inspected and the check is skipped with a note.

## Upstream's suite

`npm test` at the root runs `scripts/*.test.js`, which load `main.js` and `app.js` inside `vm` and need the root `npm install` (Electron included). The hosted edition does not change those files except `scripts/i18n.js`'s scan list, so the hosted suite is enough for `web/`-only changes. A change to `app.js`, `main.js` or `index.html` needs both suites.

## What a good test here looks like

- It asserts through the public surface (`openLibrary()`, the HTTP routes), not private helpers.
- It uses a temporary folder and leaves nothing behind.
- When it checks a recovery path, it breaks the file the way a power cut would (truncate, not delete), because the desktop seeds a missing file afresh and only recovers an unreadable one.
