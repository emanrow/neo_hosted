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
| `web/test/pg-library.test.js` | against a real Postgres: the library over rows (seed, books, chapters and stamps, covers as bytes, trash keeps rows, another writer sees nothing), branches as rows (create, switch, refusals, trash and reuse of the name), Compare & Merge over rows, a desktop folder imported with its branches, bases and cover and zipped back out as the same folder, the daily zip, and the server on `{ db }`: the folder on the volume imported on boot, every channel, the cover route, `/library.zip`, the backup sweep. Skipped unless `NEO_TEST_DATABASE_URL` is set; it drops the tables first |
| `web/test/auth.test.js` | password hashes, session tokens (tamper, expiry, wrong secret), the links in email (one purpose each, stamps, expiry), the mailer against a stub `fetch`, the throttle, the JSON user store and its confirmation state, the secret box, config validation including the email variables |
| `web/test/email.test.js` | the real server with email on and a mailer that keeps what it would have sent: a new writer waits for the confirmation link, signing in resends it, the link signs them in, a forgotten password comes back by link that works once, the ration on email per address |
| `web/test/db.test.js` | against a real Postgres: migrations run once, the user store (create/find/verify/password, the one-time import of `users.json`, the server booting with `{ db }` and signing an imported writer in) and the revision log (diffs round-trip, unchanged saves record nothing, the snapshot cadence, every revision rebuilds, another writer cannot read it, a rewritten timestamp breaks the chain, `chapter:write` through the server records history). Skipped unless `NEO_TEST_DATABASE_URL` is set; it drops the tables first. CI starts `postgres:16` as a service |
| `web/test/branches.test.js` | branch names, a branch as a copy of the draft the writer is in, the library following the active one, refusals, Trash, the dangling-pointer fallback |
| `web/test/merge.test.js` | the three-way paragraph merge on its own: one-sided edits, edits to different paragraphs, identical edits, conflicts and the three ways to settle them, deletions, insertions at one place, an empty base, the blackline |
| `web/test/branch-merge.test.js` | the merger over real folders (awaited, as over rows): the base snapshot, preview rows and conflicts, apply with resolutions, chapter order and titles, the base moving forward so a second merge is a no-op |
| `web/test/page.test.js` | the `index.html` transform, script order, inline-JSON escaping, the loud failure on a moved marker, the CSP |
| `web/test/spell.test.js` | the shared Hunspell with a writer's words laid on top, suggestions, the fallback when a dictionary cannot load |
| `web/test/server.test.js` | the real server on a free port with a temporary data folder, email off: health, static fencing, signup policy, CSRF refusal, the page, every channel's shape, cover upload and serving, the library download, manuscript upload (.txt, .md, a .docx built in the test), Trash, secrets, spellcheck, language, throttle, password reset refused with no email, logout, the backup sweep |
| `web/test/dockerfile.test.js` | the `Dockerfile` copies every root file the server serves or requires (`styles.css` once went missing from the image and nothing in the repository noticed), and names nothing that does not exist |
| `scripts/import-parse.test.js` | the shared manuscript parser on its own: chapter and scene-break detection, titles, .docx italics and styles. Lives beside upstream's tests because `main.js` uses the same module; needs the root `npm install` (JSZip) |

The server test is the one to extend when a channel changes: it asserts the shapes `app.js` relies on.

## A browser smoke run

`web/scripts/smoke.e2e.js` boots the server with a throwaway data folder, signs up in headless Chromium, walks the first-run questions, opens a menu, changes the page theme, creates a book and a chapter, types a sentence, and checks that the chapter HTML landed on disk with no console errors. It needs Playwright and a Chromium:

```
npm i -D playwright            # or point CHROMIUM_PATH at an installed Chromium
node web/scripts/smoke.e2e.js
```

It is not part of `npm test`; it is the thing to run after touching the bridge, the menu bar, or the page transform.

## Upstream's suite

`npm test` at the root runs `scripts/*.test.js`, which load `main.js` and `app.js` inside `vm` and need the root `npm install` (Electron included). The hosted edition does not change those files except `scripts/i18n.js`'s scan list, so the hosted suite is enough for `web/`-only changes. A change to `app.js`, `main.js` or `index.html` needs both suites.

## What a good test here looks like

- It asserts through the public surface (`openLibrary()`, the HTTP routes), not private helpers.
- It uses a temporary folder and leaves nothing behind.
- When it checks a recovery path, it breaks the file the way a power cut would (truncate, not delete), because the desktop seeds a missing file afresh and only recovers an unreadable one.
