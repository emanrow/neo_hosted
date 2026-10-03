> [CLAUDE.md](../CLAUDE.md) > Documentation conventions

# Documentation conventions

How the doc tree is shaped and kept, so an agent finds what it needs in one or two hops from [CLAUDE.md](../CLAUDE.md).

## The conventions

1. **`CLAUDE.md` is the map, not the manual.** About 120 lines: what the project is, how it deploys, an index of leaf docs, the rules that override convenience. Detail lives in the leaves.
2. **300-line cap** per `.md` file. Past that, split and link from the parent.
3. **Breadcrumb** in the first line of every doc this fork owns: `> [CLAUDE.md](../CLAUDE.md) > Page Name`. The hook exempts `CLAUDE.md`, `README.md`, and the files upstream owns (`AGENTS.md`, `CONTRIBUTING.md`, `TRANSLATING.md`, `TUTORIAL.md`, `pocket/`, `licenses/`, `scripts/*.md`), which keep upstream's shape so merges stay clean.
4. **Two owners.** Upstream NEO's docs (`AGENTS.md` and the rest above) describe the editor and its rules; they are authoritative for anything in `app.js`, `main.js`, `styles.css`, `index.html`. This fork's docs (`CLAUDE.md`, `HOSTED.md`, `docs/`, `web/CLAUDE.md`) describe the hosted edition. When they disagree about the editor, upstream wins; when they disagree about `web/`, this tree wins.
5. **Package `CLAUDE.md`** for directory-specific context: `web/CLAUDE.md` holds the file tree, the request lifecycle and the "add a channel" checklist. The root app's map is the "Where the code is" table in `AGENTS.md`.
6. **Docs travel in the PR.** A change that moves behavior, a route, a file, or a rule updates the leaf in the same PR, and the PR template's Docs section names the files touched or says why none were needed.
7. **Self-navigation over reading lists.** Read the index, pick one or two leaves, read those. No per-task reading lists.
8. **Credit stays.** Every doc that explains the editor says it is Hugh Howey's work. Do not trim the credits to save lines.

## Enforcement

- `.claude/hooks/md-quality-check.sh` runs after every Write or Edit of a `.md` file and warns on the size cap, a missing breadcrumb, and stale-status words near the top.
- `.claude/hooks/pre-push-doc-check.sh` blocks a `git push` that adds source files under `web/` or at the root without touching `docs/`, `CLAUDE.md`, `HOSTED.md` or `web/CLAUDE.md`.
- A `Grep` hook asks whether what was found should have been findable from the tree. If yes, add it before the task ends.

## When to update the tree

- A new channel, route or module: `web/CLAUDE.md`, and `architecture.md` if the shape changed.
- A parity change: `parity.md` and `backlog.md` together.
- A new environment variable: `deployment.md` and the comment block in `web/lib/config.js`.
- A new test file: `testing.md`.
- A new rule that overrides convenience: `CLAUDE.md`, briefly, with the leaf that explains it.

## Why this shape

The same reasoning as the author's other repositories: a short root that an agent loads every time, leaves it loads on demand, and mechanical checks at write time rather than review time. Sources: OpenAI's harness-engineering notes, Osmani's spec-for-agents guide, Fowler's context-engineering guide, and Anthropic's CLAUDE.md guidance that a long root file gets half-ignored.
