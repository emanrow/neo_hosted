> [CLAUDE.md](../CLAUDE.md) > Backlog

# Backlog

Extensions planned for this fork, in rough order. Each one keeps the rules in [AGENTS.md](../AGENTS.md): nothing interrupts a writer mid-sentence, controls stay hidden until asked for, words are never discarded, books stay plain files. Tick an item off here in the same PR that ships it, and move the parity row in [parity.md](parity.md).

## Next

1. **Download my library**: a File menu item that zips the writer's whole `NEO Library` folder, so leaving is one click.
2. **Off-site backups** of each writer's daily zip to an S3-compatible bucket, with the bucket named in the environment and nothing else.
3. **Server-side PDF** for exports and the email snapshot, with a headless Chromium only if the image stays reasonable; otherwise keep the print view.
4. **Translate the sign-in page** with the same `locales/` files.
5. **Mobile pass**: the hosted edition is the only NEO on a phone. The menu bar needs a touch way in (there is no top edge to hover and no Alt), so Sign Out and everything else in it is reachable; the shelf and the page at narrow widths.
6. **Public sharing** of an excerpt or a whole work as a read-only page, by the writer's choice only. Belongs after the storage stages below, which decide what a "version" to share is.

## Storage

Decided 2026-10-05 with the owner: canonical text moves into Postgres by stages, behind the same `library` interface `app.js` already talks to, so the editor stays upstream's. Branching (alternate drafts side by side) is the feature that decides this; proof of human work is a quiet property of the history, never a certificate; the desktop folder stops being the escape hatch and DOCX/PDF/EPUB exports take its place, with a plain-file folder export kept as a courtesy.

- **A. Accounts in Postgres**: done, below.
- **B. Revision log**: every `chapter:write` that changes content appends a row (chapter, branch, parent revision, compressed diff against the parent with a full snapshot every N, a hash chaining to the parent, a timestamp). Files stay canonical; the log is additive. Gives undo beyond the browser session, a blackline between any two revisions, cheaper backups and the quiet proof of work. Timelines and characters will anchor to revisions, so this comes before any room off the hallway.
- **C. Branches**: a named pointer to a head revision per chapter or book; create, write on, compare, merge at paragraph granularity with the writer resolving real conflicts side by side. The editor edits "the open branch's head" through the same channels.
- **D. Flip canonical** to the database: files become an export, covers and images move to object storage, the daily zips give way to Postgres backups plus exports.

## Rooms off the hallway

Each of these is a sidecar beside the book's files and a tab or pane that stays shut until opened. None of them writes into chapter HTML.

7. **Mind map**: `mindmap.json`, a canvas of nodes that can link to chapters and placeholders.
8. **Map map**: a place to draw the world, an image or a blank sheet with pins that link to chapters and notes (`maps.json`, images beside it).
9. **Timelines**: `timeline.json`, events with story-time and chapter references, drawn on one line, dragged to reorder.
10. **Handwritten notes**: a stylus pad that saves strokes as SVG beside the stickies, never OCR'd into the manuscript unless asked.
11. **AI throughout**, only ever at the writer's request and never while typing: ask a question of the manuscript, name a placeholder, continue a scene into Darlings (never onto the page), paint covers as today. Keys per writer, encrypted as today. Upstream NEO is firm that it has no generative tools; this fork adds them as opt-in rooms off the hallway, not squiggles on the page.

## Done

- **Accounts in Postgres** (2026-10-05): `web/lib/db.js` and `PgUserStore`, chosen by `DATABASE_URL`; `users.json` is imported once on the first boot and kept beside the volume as `users.json.imported-<date>`. Storage stage A.
- **Email** (2026-10-05): Resend behind `web/lib/mail.js`; new writers confirm their address, a forgotten password comes back by a link that works once. `RESEND_API_KEY`, `NEO_MAIL_FROM`, `NEO_PUBLIC_URL` turn it on.
- **Checks on every PR** (2026-10-05): `.github/workflows/hosted.yml` runs the hosted suite, the lint, the parser tests and boots the Docker image.
- **Import** .docx / .txt / .md (2026-10-03): the parser left `main.js` for a shared `import-parse.js`; the server exposes `POST /api/import:upload`; the bridge wires `importPick` and `importFiles`. One parser for both editions.

## Housekeeping

- Lift `files.js` and `library.js` into a module `main.js` can `require`, ending the port-in-step rule in [architecture.md](architecture.md).
- An admin surface for the owner: list accounts, remove one, see the volume's size.
