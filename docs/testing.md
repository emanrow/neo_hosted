> [CLAUDE.md](../CLAUDE.md) > Testing

# Testing

Two suites, one tool: `node:test`. The hosted suite, the lint, the shared parser's tests and a boot of the Docker image run in GitHub Actions on every pull request and every push to `main` (`.github/workflows/hosted.yml`); upstream's own workflow packages the desktop app on `v*` tags. Run the hosted suite before every push anyway: the owner has no local environment, so a red check is the first anyone hears of a break.

## The hosted suite

```
cd web && npm install && cd ..      # once
npm run test:web                    # node --test web/test/*.test.js
npx oxlint -c .oxlintrc.json web/server.js web/lib web/public web/test
NEO_TEST_DATABASE_URL=postgres://neo:neo@127.0.0.1:5432/neo_test npm run test:web   # also the Postgres store, against a scratch database
```

| File | Covers |
|---|---|
| `web/test/library.test.js` | `libName`, durable writes, `.tmp`/`.bak` recovery, book layout, chapter stamps, `rebuildBookMeta`, lost `library.json`, Trash, covers, the daily zip |
| `web/test/auth.test.js` | password hashes, session tokens (tamper, expiry, wrong secret), the links in email (one purpose each, stamps, expiry), the mailer against a stub `fetch`, the throttle, the JSON user store and its confirmation state, the secret box, config validation including the email variables |
| `web/test/email.test.js` | the real server with email on and a mailer that keeps what it would have sent: a new writer waits for the confirmation link, signing in resends it, the link signs them in, a forgotten password comes back by link that works once, the ration on email per address |
| `web/test/db.test.js` | the Postgres user store against a real database: migrations run once, create/find/verify/password, the one-time import of `users.json`, and the server booting with `{ db }` and signing an imported writer in. Skipped unless `NEO_TEST_DATABASE_URL` is set; it drops the tables first. CI starts `postgres:16` as a service |
| `web/test/page.test.js` | the `index.html` transform, script order, inline-JSON escaping, the loud failure on a moved marker, the CSP |
| `web/test/spell.test.js` | the shared Hunspell with a writer's words laid on top, suggestions, the fallback when a dictionary cannot load |
| `web/test/server.test.js` | the real server on a free port with a temporary data folder, email off: health, static fencing, signup policy, CSRF refusal, the page, every channel's shape, cover upload and serving, manuscript upload (.txt, .md, a .docx built in the test), Trash, secrets, spellcheck, language, throttle, password reset refused with no email, logout, the backup sweep |
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
