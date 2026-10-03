> [CLAUDE.md](../CLAUDE.md) > Public repository

# This repository is public

`emanrow/neo_hosted` is a fork of `hughhowey/neo`, and GitHub forks of public repositories are public. The owner's other repositories are private; this one is not, and the habits that are safe there are not safe here. Everything that lands in this repository is readable by anyone: code, docs, commit messages, PR titles and bodies, review comments, issues, screenshots.

## What never goes in

- **Secrets of any kind.** API keys, session secrets, invite codes, tokens, passwords, `.env` contents, the Railway project's values. The hosted edition reads all of these from the environment on purpose (`web/lib/config.js`); keep it that way.
- **Personal details about the owner.** Email address, time zone, location, employer, schedule, family, devices. "The owner" is the whole identity this tree needs.
- **The owner's private repositories.** Not their names, not their structure, not text copied from them. When a pattern from one of them is wanted here, describe the pattern in this repository's own words; do not cite the source by name. (This tree's shape was modelled on the owner's other repositories; the docs say exactly that and no more.)
- **Client, employer or business information.** Nothing about the owner's day job, its systems, vendors or data.
- **Writers' data.** No real manuscripts, library folders, `users.json`, backups or error logs, in fixtures, screenshots or examples. Tests use `@example.com` addresses and invented sentences.
- **The live deployment's details** beyond what `docs/deployment.md` explains generically: no domain, no volume contents, no log excerpts with real paths or names, unless the owner asks for them to be published.

## What is fine

- The owner's GitHub handle: it is the repository's owner and already on every page.
- Hugh Howey's name and repository: the credit is required, see `HOSTED.md`.
- Session attribution lines in commit messages (`Claude-Session: https://claude.ai/code/...`). The link opens only for the owner.
- Generic deployment instructions: Railway, a volume at `/data`, the environment variable names.

## Enforcement

| When | What | Where |
|---|---|---|
| Session start | A full reminder of this page's rules enters the agent's context | `.claude/hooks/public-repo-reminder.sh SessionStart` |
| Every prompt | A one-line reminder enters the context with the prompt | `.claude/hooks/public-repo-reminder.sh UserPromptSubmit` |
| `git push` | The branch's added lines and commit messages are scanned for tokens and keys, email addresses outside the allow-list, home-directory paths, references to `emanrow/<anything but this repo>`, and time-zone or location phrasing. A hit blocks the push. | `.claude/hooks/pre-push-public-check.sh` |
| PR | The template's Public repository section must be answered | `.github/pull_request_template.md` |

The scanner is a net, not a reviewer. A false positive is fixed by rewording, not by editing the hook's patterns; a true positive is removed before the push, never after (see below).

## If something slips through

1. **Rotate first.** A leaked secret is compromised the moment it is pushed, whatever happens to the history afterwards. Rotate it on the provider, then redeploy.
2. **Tell the owner what and where**, with the commit hash and file. Removing it from the tip is yours to do at once; rewriting `main`'s history is the owner's call, because it breaks every clone and GitHub keeps the old objects reachable for a while regardless.
3. **Add the pattern** to the scanner if it was mechanical and the scanner should have caught it.

## Audit log

Each entry: date, scope, findings, action.

- **2026-10-03** -- everything pushed by the hosted-edition work (commits `663d62a` and `b8e3121`, the PR text, tracked files, commit identities). Found: one line in `CLAUDE.md` naming the owner's time zone (removed; the Railway `TZ` instruction is now generic); the `Claude outputs/` images, which are upstream's own tracked files, not this fork's; session attribution links in commit messages, which are allowed. No secrets, no addresses, no private repository names. Commit authors are no-reply addresses.
