> [CLAUDE.md](../CLAUDE.md) > Backlog

# Backlog

Extensions planned for this fork, in rough order. Each one keeps the rules in [AGENTS.md](../AGENTS.md): nothing interrupts a writer mid-sentence, controls stay hidden until asked for, words are never discarded, books stay plain files. Tick an item off here in the same PR that ships it, and move the parity row in [parity.md](parity.md).

## Next

1. **Download my library**: a File menu item that zips the writer's whole `NEO Library` folder, so leaving is one click.
2. **Off-site backups** of each writer's daily zip to an S3-compatible bucket, with the bucket named in the environment and nothing else.
3. **Server-side PDF** for exports and the email snapshot, with a headless Chromium only if the image stays reasonable; otherwise keep the print view.
4. **Password reset** by email, and with it the move of users to a real store ([auth-and-users.md](auth-and-users.md)).
5. **Translate the sign-in page** with the same `locales/` files.

## Rooms off the hallway

Each of these is a sidecar beside the book's files and a tab or pane that stays shut until opened. None of them writes into chapter HTML.

6. **Mind map**: `mindmap.json`, a canvas of nodes that can link to chapters and placeholders.
7. **Map map**: a place to draw the world, an image or a blank sheet with pins that link to chapters and notes (`maps.json`, images beside it).
8. **Timelines**: `timeline.json`, events with story-time and chapter references, drawn on one line, dragged to reorder.
9. **Handwritten notes**: a stylus pad that saves strokes as SVG beside the stickies, never OCR'd into the manuscript unless asked.
10. **AI throughout**, only ever at the writer's request and never while typing: ask a question of the manuscript, name a placeholder, continue a scene into Darlings (never onto the page), paint covers as today. Keys per writer, encrypted as today. Upstream NEO is firm that it has no generative tools; this fork adds them as opt-in rooms off the hallway, not squiggles on the page.

## Done

- **Import** .docx / .txt / .md (2026-10-03): the parser left `main.js` for a shared `import-parse.js`; the server exposes `POST /api/import:upload`; the bridge wires `importPick` and `importFiles`. One parser for both editions.

## Housekeeping

- Lift `files.js` and `library.js` into a module `main.js` can `require`, ending the port-in-step rule in [architecture.md](architecture.md).
- An admin surface for the owner: list accounts, remove one, see the volume's size.
- Run `npm run test:web` and the lint in GitHub Actions on every PR.
