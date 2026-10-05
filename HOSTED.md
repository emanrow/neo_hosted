> [CLAUDE.md](CLAUDE.md) > NEO, hosted

# NEO, hosted

NEO is [Hugh Howey's](https://github.com/hughhowey/neo) word processor for authors: a local Electron app, MIT licensed, opinionated on purpose. This repository is an independent fork, not affiliated with or endorsed by him, that serves the same app as an authenticated website, so a writer can open their shelf from any browser and keep writing. Every opinion in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) still holds. The editor is Hugh's `app.js`, unchanged; what this fork adds is a server that stands where `main.js` stood.

## Credit

- **NEO** -- Hugh Howey, [hughhowey/neo](https://github.com/hughhowey/neo), MIT. The editor, the shelf, the covers, the export formats, the translations, the whole philosophy. Everything a writer sees is his work.
- **Hunspell** -- the spellcheck engine, via [`@farscrl/hunspell-wasm`](https://www.npmjs.com/package/@farscrl/hunspell-wasm). Licenses in `licenses/hunspell`.
- **Dictionaries** -- the `dictionary-*` packages by Titus Wormer and the original dictionary authors (see `licenses/`).
- **JSZip** -- Stuart Knightley, for EPUB, Word and backups.
- **The hosted edition** -- `web/`, `Dockerfile`, `railway.json`, this tree of docs. MIT, same as NEO.

Keep the upstream `LICENSE` and credits in any deployment. The sign-in page and the Help menu name Hugh and link to his repository.

## In one paragraph

The desktop app is a page, a doorway (`window.neo`) and a main process that owns the disk. Pocket swapped the doorway for the phone; the hosted edition swaps it for a browser. `web/public/web-bridge.js` has the same methods as `preload.js` and POSTs each one to `/api/<channel>`; `web/server.js` answers with the same code paths `main.js` has, against a plain-file `NEO Library` per writer on a volume. No framework, no bundler, no database. A writer can download their folder and open it in desktop NEO.

## Where to read next

| You want to | Read |
|---|---|
| Run it on a laptop, deploy it to Railway, set the environment | [docs/deployment.md](docs/deployment.md) |
| Know what matches the desktop and what does not yet | [docs/parity.md](docs/parity.md) |
| Understand the shape before changing code | [docs/architecture.md](docs/architecture.md), then [web/CLAUDE.md](web/CLAUDE.md) |
| Know how sign-in works and when a database would be warranted | [docs/auth-and-users.md](docs/auth-and-users.md) |
| Run or add tests | [docs/testing.md](docs/testing.md) |
| See what is planned (mind map, map map, handwriting, opt-in AI) | [docs/backlog.md](docs/backlog.md) |

## Quick start

```
cd web && npm install && cd ..
NEO_DEV=1 NEO_SIGNUP=open npm run start:web      # http://localhost:8080
npm run test:web
```

On Railway: deploy this repo, mount a volume at `/data`, set `NEO_SESSION_SECRET` and `NEO_SIGNUP`, open the site, create the first account. Details in [docs/deployment.md](docs/deployment.md).
