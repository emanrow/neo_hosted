# NEO Hosted -- Agent Navigation Guide

This file is the root of the documentation tree. Every doc this fork owns links back here.

## Documentation Structure

Documentation follows **progressive disclosure**: this file is a table of contents, not an encyclopedia. Each linked doc is self-contained and capped at ~300 lines. Every non-root `.md` this fork owns has a breadcrumb backlink in its first line. If you can't find information within 1-2 hops from here, add it to the appropriate doc -- don't let the tree rot. Hooks enforce the size cap and breadcrumb on every `.md` write.

**Two owners.** This is a fork of [Hugh Howey's NEO](https://github.com/hughhowey/neo). Upstream's docs ([AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), [TRANSLATING.md](TRANSLATING.md), [TUTORIAL.md](TUTORIAL.md), `pocket/`) describe the editor and are authoritative for it. This tree describes the hosted edition in `web/`. Read AGENTS.md's "Rules that override convenience" before touching anything; they apply here unchanged.

## This Repository Is PUBLIC -- READ FIRST

`emanrow/neo_hosted` is a public fork of `hughhowey/neo`. The owner's other repositories are private; this one is not. Everything committed, pushed, or written in a PR, issue or comment is visible to anyone. **Never** include secrets, personal details about the owner (address, time zone, location, employer, schedule), the names or contents of the owner's private repositories, client or business information, or writers' data. Hooks remind you at session start and on every prompt and scan every push; the policy, the allow-list and the audit log are in [docs/public-repo.md](docs/public-repo.md).

## Deployment Model -- READ FIRST

**The owner has NO local dev environment for this project.** Code reaches a running system only by:

1. Commit + push to a branch
2. Open PR + merge to `main`
3. Railway auto-deploys `main` via `Dockerfile`

Consequences:

- **Never** suggest `railway run`, `curl localhost`, or anything implying a local shell near the app or its volume in user-facing instructions. (The building agent's own container may run the server for verification -- see [docs/testing.md](docs/testing.md).)
- **Verification** in PRs must be things the owner can do: open a URL, click in the page, read a Railway log line, look at the volume. [docs/deployment.md](docs/deployment.md) lists them.
- **No migrations.** Libraries are plain files; users are a JSON file. A deploy never rewrites a writer's folder.
- **Timezone**: set `TZ` on the Railway service to the owner's local zone (the Railway dashboard, not this repository) so backup dates and log lines match their calendar day.

## What This Project Does

Serves NEO, a distraction-free word processor for books, as an authenticated website. The editor is upstream's `app.js`, unchanged. `web/` adds a third doorway beside the desktop preload and the Pocket bridge: `web/public/web-bridge.js` implements `window.neo` over HTTP, `web/server.js` answers each IPC channel at `POST /api/<channel>`, and every writer has a plain-file `NEO Library` on a Railway volume, laid out exactly as the desktop app's. No framework, no bundler, no database. `print/` is a second, optional service: headless Chromium with Paged.js that turns the export HTML into a book-shaped PDF.

## Documentation Index

| Doc | What it covers |
|-----|---------------|
| [AGENTS.md](AGENTS.md) | **Upstream, read first.** The product's rules, where the editor's code is, files on disk, saving and sync, i18n, Pocket |
| [HOSTED.md](HOSTED.md) | The hosted edition for humans: what it is, credits, how to run it, links into this tree |
| [docs/architecture.md](docs/architecture.md) | Three doorways, no build step, request lifecycle, a writer's folder on the volume, what was ported from `main.js` and must stay in step |
| [docs/auth-and-users.md](docs/auth-and-users.md) | Sign-in, sessions, signup policy, the JSON user store and when to move to Postgres, API keys at rest, known gaps |
| [docs/parity.md](docs/parity.md) | Feature-by-feature comparison with the desktop, where each difference lives, which accelerators the menu bar owns |
| [docs/deployment.md](docs/deployment.md) | Environment variables, Railway steps, Docker, a laptop, verifying without a shell |
| [docs/testing.md](docs/testing.md) | The hosted suite, the Chromium smoke run, upstream's suite, what a good test here looks like |
| [docs/backlog.md](docs/backlog.md) | Import first, then downloads and off-site backups, then the rooms off the hallway (mind map, map map, timelines, handwriting, opt-in AI) |
| [docs/public-repo.md](docs/public-repo.md) | **This repository is public**: what never goes in, what is fine, the hooks that enforce it, what to do if something slips, the audit log |
| [docs/doc-conventions.md](docs/doc-conventions.md) | How this tree is shaped, enforced and kept |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Upstream's bar for a feature: it helps someone finish a book |
| [TRANSLATING.md](TRANSLATING.md) | Upstream: adding a language, plurals, regional fallback |

## Package Navigation

- [web/CLAUDE.md](web/CLAUDE.md) -- the server, its libraries, the browser bridge and menu bar: file tree, request path, how to add a channel, gotchas
- [print/CLAUDE.md](print/CLAUDE.md) -- the PDF printer: one Chromium with Paged.js behind `POST /render`, the trim sizes, how a book becomes a PDF, gotchas
- The editor itself (`app.js`, `main.js`, `styles.css`, `index.html`) is mapped by the "Where the code is" table in [AGENTS.md](AGENTS.md); `app.js` is navigated by its banner comments

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | Plain JavaScript (CommonJS on the server, scripts in the page), no TypeScript, no bundler |
| Server | `node:http`, Node 22. No framework |
| Page | Upstream's `index.html` + `app.js`, served from the repository root |
| Storage | Plain files on a volume; one `NEO Library` folder per writer; `users.json` |
| Auth | scrypt passwords, HMAC-signed HttpOnly cookies (`node:crypto` only) |
| Spellcheck | Hunspell via `@farscrl/hunspell-wasm`, upstream's `dictionary-*` packages |
| Zips | JSZip (exports in the page, backups on the server) |
| PDF | `print/`: Debian's Chromium driven by puppeteer-core, Paged.js for the pagination; a second Railway service the app reaches over the private network |
| Lint | oxlint with upstream's `.oxlintrc.json` |
| Tests | `node:test`; Playwright for the optional smoke run |
| Deploy | Dockerfile, `railway.json`, a Railway volume at `/data` |

## Key Commands

```bash
cd web && npm install && cd ..   # the hosted edition's runtime deps (no Electron)
npm run start:web                # NEO_DEV=1 NEO_SIGNUP=open for a laptop; http://localhost:8080
npm run test:web                 # node --test web/test/*.test.js, one file at a time  (must be green before pushing)
npx oxlint -c .oxlintrc.json web/server.js web/lib web/public web/test
node scripts/i18n.js template    # after adding a writer-visible string (t() / tr())
node web/scripts/smoke.e2e.js    # optional: headless Chromium end to end (needs Playwright)
EPUBCHECK_JAR=... node web/scripts/epubcheck.e2e.js   # an EPUB from the real exporter under epubcheck (CI runs it)
cd print && npm install && CHROMIUM_PATH=/path/to/chrome npm test   # the printer; its render test needs a Chromium
```

## Workflow Rules

1. **Always create a PR and merge it.** Every push ends in a merged PR; Railway deploys `main`.
2. **Consult documentation early and often.** Read the relevant doc from the index before changing code.
3. **Update documentation in the same PR.** The PR template's Docs section must list the doc files touched or say why none were needed.
4. **Test and lint before pushing.** `npm run test:web` and the oxlint line above. A change to `app.js`, `main.js` or `index.html` also needs upstream's `npm test`.
5. **Hosted behavior lives in `web/`, never behind a branch in `app.js`.** A parity gap that cannot be closed from the bridge goes in the backlog. This keeps upstream merges clean and is the same rule AGENTS.md sets for Pocket.
6. **Keep the ports in step.** `web/lib/files.js` and `web/lib/library.js` mirror `main.js`'s disk code; a fix to one is a fix to both ([docs/architecture.md](docs/architecture.md#what-was-ported-from-mainjs-and-must-stay-in-step)).
7. **Credit stays.** Hugh Howey wrote NEO. The sign-in page, the Help menu, HOSTED.md and the README say so; do not trim it.
8. **It is public.** Read your own diff, commit message and PR text as a stranger would before pushing ([docs/public-repo.md](docs/public-repo.md)). The pre-push scanner is a net, not a reviewer.

## Key Concepts

1. **Three doorways, one editor.** `preload.js`, `pocket-bridge.js` and `web-bridge.js` each implement `window.neo`; `app.js` cannot tell them apart.
2. **A channel is an IPC name.** `POST /api/chapter:write` with `{ args: [bookId, chId, html] }` is `ipcMain.handle('chapter:write', ...)`. Handlers in `web/lib/handlers.js` are registered under the same names, in the same order, as in `main.js`.
3. **A writer's context** (`contextFor` in `web/server.js`) is their locale, translator, library, settings, secrets file and error log. Handlers receive it first.
4. **Words are never discarded.** Deleting a book moves it to `Trash/` inside the library. A failed save throws back to the page so `persistChapter` retries. The bridge never navigates away from a page with unsaved words, even when the session has expired.
5. **Durable writes everywhere.** tmp, fsync, rename; `.bak` of the last whole JSON; reads fall back on `.tmp` then `.bak` (upstream's rules, ported).
6. **The page is upstream's `index.html`,** transformed at request time around four markers. A moved marker fails the boot and the test, loudly.
7. **Spellcheck is shared, learned words are not.** One Hunspell per language for every writer; `customWords` from each writer's `library.json` are laid over the result.
8. **The menu bar is `buildMenu()` in a browser.** Same labels (translated through `locales/`), same `{ type, ... }` messages to `window.neo.onMenu`, hidden until the top edge is hovered or Alt/F10 is pressed.
9. **New strings** go through `t()` (the bridge's `tr()`) and `node scripts/i18n.js template`, which scans the two `web/public/*.js` files too.
10. **One manuscript parser.** `import-parse.js` at the root is required by both `main.js` and `web/server.js`; chapter detection (`CHAPTER_WORDS`) lives there and nowhere else.

## Documentation Standards

- **Breadcrumbs**: every `.md` this fork owns, except this one and `README.md`, starts with `> [CLAUDE.md](../CLAUDE.md) > Page Name` (a root-level file such as `HOSTED.md` links to `CLAUDE.md`). Upstream's files keep upstream's shape.
- **Size cap**: ~300 lines per `.md`; split when exceeded.
- **Enforcement**: `.claude/hooks/md-quality-check.sh` warns on every Write/Edit; `.claude/hooks/pre-push-doc-check.sh` blocks pushes that add source files without doc changes; `.claude/hooks/pre-push-public-check.sh` blocks pushes that would publish secrets, personal details or private-repository references; `.claude/hooks/public-repo-reminder.sh` restates the public-repository rule at session start and on every prompt.
