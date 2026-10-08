> [CLAUDE.md](../CLAUDE.md) > Saving

# Saving: how words reach the server, and what can go wrong

A review of the whole write path of the hosted edition, written after a writer on a phone saw a twin of the chapter they were typing in, headed "from other device" (2026-10-08). The twin held their own words. Nothing was lost, but the editor had taken its own save for a stranger's edit, and the reason is a difference between a disk and a network that `app.js` was never written for.

## The path a keystroke takes

| Step | Where | What |
|---|---|---|
| 1 | `app.js` `scheduleChapterSave` | 800 ms after the last keystroke in a chapter, `persistChapter(chId)` |
| 2 | `app.js` `persistChapter` | notes `savedHTML[chId] = html` and `writing[chId]++`, then `window.neo.writeChapter(bookId, chId, html)`; a rejection puts `savedHTML` back to what it was, so the next flush tries again |
| 3 | `web/public/web-bridge.js` `writeChapter` | hands the write to the saver (`web-saves.js`, below), which sends `POST /api/chapter:write` |
| 4 | `web/server.js` `handleApi` | the cookie, the writer's context, the handler |
| 5 | `web/lib/handlers.js` `chapter:write` | `library.writeChapter` first (one `UPSERT` on `book_files`, joined to the active branch), then `revisions.record` (a diff row in the log, which may fail without failing the save) |
| 6 | `app.js` `flushAllSaves` | every 20 s, on blur, when the page goes to the background and on unload: `persistChapter` for every chapter whose text differs from `savedHTML`, plus `book.json` (`saveMeta`), notes and stickies |

The other direction, `refreshFromDisk` in `app.js`, runs on focus, when the page comes back into view and every 30 s while visible. It asks `chapter:stamps` (`modified:size` per chapter), re-reads the chapters whose stamp changed and were not `writing`, and decides per chapter:

- server copy equals `savedHTML`: nothing new;
- server copy differs and the page has no unsaved words: adopt it (the page's words go to Darlings when the copy only drops words);
- server copy differs **and the page has unsaved words**: a conflict. The page keeps its words, the server copy lands in a new chapter right after, titled "from other device, <time>", and both are saved.

That third rule is right for two laptops sharing a folder over iCloud. It assumes three things a disk gives and a network does not.

## What app.js assumes, and what HTTP keeps

| `app.js` assumes | True of a disk | Over HTTP | Hosted answer |
|---|---|---|---|
| A rejected write never reached the file | yes: the syscall failed | no: the request can land and the answer be lost (a phone suspended mid-request, a dropped signal, a proxy closing the socket) | `web-saves.js` reads the chapter back before taking a failure for a failure |
| A write that was accepted is there to read | yes | yes: `pg-library.js` returns after the commit | kept |
| Writes from this window arrive in order | yes, one process | no: two requests can cross | the saver keeps one lane per chapter and only ever sends the newest words |
| The file changes only through this window or another device | yes | also: a branch switch, a restore from History | `web-branches.js` reloads the page; `web-history.js` restores through `chapter:write` plus `refreshFromDisk`, so replaced words go to Darlings |
| A failed write can wait for the next flush (20 s) | fine on a disk | a deploy answers 5xx for a minute; a session can end | the saver retries on its own, with a growing pause, and the editor's `writing` count keeps `refreshFromDisk` from adopting the stale copy meanwhile |

## The twin chapter, step by step

1. The writer types; a save lands; `savedHTML` = A.
2. More words; the next save (B) reaches the server. The phone goes to the background, iOS ends the request, `fetch` rejects. `persistChapter` puts `savedHTML` back to A. The server holds B.
3. The writer comes back and keeps typing (C, unsaved). The page comes into view, `refreshFromDisk` runs: server B ≠ `savedHTML` A, and the page's C ≠ A. Conflict. B becomes "Chapter 4, from other device, 12:26 AM"; Chapter 3 keeps C.

`web/scripts/smoke.e2e.js` reproduces exactly this with a route that forwards the request and drops the answer, and checks that one chapter remains.

## What was built

**`web/public/web-saves.js`** (`createSaver`): one lane per chapter. A write that rejects with a *transient* error (no connection, 5xx, 401) is not a failed write until the chapter is read back and found to differ; words already there count as saved. Otherwise the lane sleeps (2 s, doubling to 30 s) and sends again, for as long as it takes. A newer write for the same chapter replaces the one on its way (its words are inside the newer), and every caller hears once the newest landed. Only an error the server meant (a bad name, a refused request) rejects, so `persistChapter`'s rollback still does its job for those.

**`web-bridge.js`**: `request()` marks transient failures, `writeChapter` goes through the saver, short chapters are sent with `keepalive` so a request outlives the page going to the background, and a lane that has stalled twice shows the "no connection" toast at most once a minute. Leaving the page while a lane is stalled asks the browser for its "leave this page?" prompt, since those words are nowhere but on the page.

Nothing changed in `app.js`. Its conflict rule stays, because it is right when two devices really did edit the same chapter.

## What can still happen, and what to do

| Case | Outcome today | Words at risk? | Next step |
|---|---|---|---|
| Phone and laptop both edit one chapter between refreshes | a twin chapter, by design | no, both versions are kept | later: a three-way merge from the revision log instead of a twin (the merge in `merge.js` already does this for branches); on the backlog |
| The page is closed while a save is still retrying | the browser asks before leaving; if the writer leaves anyway, those words are gone | yes, by the writer's choice | a local copy in `localStorage` while a lane is stalled would close this; on the backlog |
| A `json:write` (stickies, darlings, timeline, footnotes) fails | no retry beyond the next flush of its owner | the sidecar's last change, until the next flush | give sidecars the same saver once a room asks for it |
| `book.json` write fails | `savedMetaSig` stays stale; the next flush writes it again | no | nothing |
| Session ends | a toast; every chapter write retries until the writer signs in in another tab | no, as long as the tab stays open | nothing |
| A deploy restarts the server | 5xx for about a minute; writes retry | no | nothing |
| Two tabs in one browser | the same as two devices | no | nothing |
| A stale tab left open overnight | adopts the other device's words at its next refresh; its own unsaved words, if any, make a twin | no | nothing |

**Server side, last write wins.** `chapter:write` has no version check: a request carrying older words than the row overwrites it, and `refreshFromDisk` is the only guard. A stamp in the request (`If-Match` on `modified`) would let the server refuse a stale write, but `app.js` cannot tell that refusal from a disk error, so until the editor can ask what to do with it, the row plus the revision log is the safer pair: every version is in History.

**Upstream.** One line in `refreshFromDisk` would make the desktop as robust: a server copy that equals the page's current text is not a conflict, whatever `savedHTML` says. That belongs in a pull request to upstream, not in this fork's `app.js` (CLAUDE.md, rule 5).

## If a writer sees a twin chapter

Nothing was lost: the twin holds the server's copy at that moment, the original keeps what was typed after. Open the History panel on the original to see every save. Read the twin once, and if the original has everything, delete the twin from the chapter's menu: deleting sends its words to Darlings, so even that is undoable. Ask them to hard-reload after a fix ships, as always.

## Verifying a change here

- `node --test web/test/saves.test.js`: the saver on its own, with a scripted server.
- `CHROMIUM_PATH=... node web/scripts/smoke.e2e.js`: the lost-answer pass against the real server.
- On the live site: type on a phone, switch to another app for a minute, come back, keep typing. One chapter, and the words typed before switching away are in it.
