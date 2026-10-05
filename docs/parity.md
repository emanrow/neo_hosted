> [CLAUDE.md](../CLAUDE.md) > Parity with the desktop

# Parity with the desktop

What a writer gets in a browser compared with desktop NEO. ✔ same code, same files. ◐ works, with a browser-shaped difference. + hosted only. ✘ not yet. — does not apply.

| Desktop | Hosted | Notes |
|---|---|---|
| Shelves, books, chapters, notes, outline, darlings, stickies, goals | ✔ | the same `app.js`, the same files |
| Covers: seeded art, uploaded images | ✔ | upload is a raw `POST /api/cover:upload`; the shelf fetches `/library/<book>/<file>` |
| Painted covers (OpenAI) | ✔ | `art.js` runs on the server with the writer's own key, encrypted at rest |
| Spellcheck pass, suggestions, learned words | ✔ | one Hunspell per language shared by all writers; a writer's `customWords` are laid on top at check time, never added to the shared instance |
| Export txt, md, html, docx, epub | ✔ | built by `app.js` as before; the browser downloads the file |
| Export PDF, ⌘E email snapshot | ◐ | the browser opens the export as a print view ("Save as PDF") and a mail draft; no server-side PDF yet |
| Import .docx / .txt / .md | ✔ | the browser uploads each file as raw bytes to `POST /api/import:upload`; the parser is `import-parse.js` at the repository root, the same module `main.js` uses, so chapter detection cannot drift between editions |
| Daily zip backups | ✔ | per writer, on the volume; with Postgres the zip is written from the rows. Off-site copies are on the backlog |
| Delete a book | ✔ | with Postgres the rows are marked trashed and kept; without, the folder moves to `Trash/` inside the library, named with a timestamp. The bridge says where it went |
| Download Library… (File menu) | + | hosted only: the whole library as the desktop folder, zipped by the server (`GET /library.zip`); it opens in desktop NEO |
| Menus and shortcuts | ✔ | a hover-revealed bar at the top edge, Alt or F10 for the keyboard; same labels, same messages |
| Interface language, 10 languages | ✔ | saved per writer; the sign-in page is English for now |
| Full screen | ✔ | the browser's Fullscreen API |
| History (File → History…) | + | hosted only: every save of a chapter is kept in the revision log; the panel previews any one and restores it, the replaced words going to Darlings. [architecture.md](architecture.md#a-writers-corner-of-the-volume) |
| Branches (File → Branches) | + | hosted only: whole alternate drafts of a book, made from the draft you are in, switched with a reload; each keeps its own history. Compare & Merge… brings one into the draft you are in, paragraph by paragraph, with a blackline and a choice on each place changed in both. [architecture.md](architecture.md#a-writers-corner-of-the-volume) |
| Auto-update, Check for Update | — | the site is always current; the item is gone from the menu |
| Library Folder… | — | the server keeps the library (rows in Postgres, or a folder on the volume); Download Library… is the way out |
| Other Font… (local font picker) | — | left out of the menu; `queryLocalFonts` is Chrome-only and needs a permission prompt |

## Where the differences live

Every difference above is in `web/public/web-bridge.js` or `web/public/web-menu.js`, never in `app.js`. That is the rule from AGENTS.md ("Pocket-only behavior belongs in `pocket-bridge.js`") applied to a third doorway. If a parity gap cannot be closed from the bridge, say so in the backlog rather than branching the editor.

## Accelerators

The native menu used to catch these; `web-menu.js` does now: ⌘E, ⌘, (Goals), ⌘F, ⌘0, ⌘⇧I, ⌘⇧L/C/R/J (align), ⌘⇧T, ⌘⇧O, ⌘⇧F. `app.js` already handles ⌘; ⌘+ ⌘− and ⌘/ inside the editor by character, so those stay out of the table (one press, one action). Browsers keep a few for themselves (⌘⇧I opens devtools in Chrome); the menu item still works by click.
