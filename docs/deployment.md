> [CLAUDE.md](../CLAUDE.md) > Deployment

# Deployment

The hosted edition is one Node process and one folder. There is no database to provision.

## Environment

All read once in `web/lib/config.js`; the server refuses to boot on a bad combination and says why.

| Variable | Meaning |
|---|---|
| `PORT` | Railway sets it. Default 8080. |
| `NEO_DATA_DIR` | The volume. Default `./data` (ignored by git). The Docker image sets `/data`. |
| `NEO_SESSION_SECRET` | 32+ random characters. Signs sessions and encrypts API keys. Required unless `NEO_DEV=1`. |
| `NEO_SIGNUP` | `open`, `invite` (default), `closed`. The first account is always allowed. |
| `NEO_INVITE_CODE` | Needed when `NEO_SIGNUP=invite`. |
| `NEO_TRUST_PROXY` | `1` behind a TLS-terminating proxy. Defaults on when `RAILWAY_ENVIRONMENT` is set. |
| `NEO_DEV` | `1` makes a throwaway session secret and relaxes the checks above. Laptops only. |
| `RESEND_API_KEY` | Turns email on: new writers confirm their address before they can sign in, and a forgotten password can be reset by link. Unset, there is no email at all and signup signs straight in. |
| `NEO_MAIL_FROM` | The sender Resend has verified for your domain, `NEO <neo@example.com>`. Required with `RESEND_API_KEY`. |
| `NEO_PUBLIC_URL` | Where writers open the site, `https://neo.example.com`, so the links in email point home. Required with `RESEND_API_KEY` (a `NEO_DEV` laptop falls back to the request's own host). |
| `NEO_BACKUP_BUCKET` | An S3-compatible bucket that gets a copy of every writer's daily zip, under `<writer id>/neo-backup-<date>.zip`. Unset, the zips stay on the volume. With it, `AWS_ENDPOINT_URL` (`https://storage.railway.app`), `AWS_REGION` (`auto` on Railway), `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are required; the server refuses to boot without them and says which is missing. Each is also read as `NEO_BACKUP_ENDPOINT`, `NEO_BACKUP_REGION`, `NEO_BACKUP_ACCESS_KEY_ID`, `NEO_BACKUP_SECRET_ACCESS_KEY`. Optional: `NEO_BACKUP_PREFIX`, a folder inside the bucket; `NEO_BACKUP_PATH_STYLE=1` for a service that wants the bucket on the path (MinIO). |
| `DATABASE_URL` | Postgres for accounts, history and every writer's words. Railway sets it when the Postgres service is referenced from this one. Unset, accounts stay in `users.json` and libraries are folders on the volume. The first boot with it set imports `users.json` ([auth-and-users.md](auth-and-users.md#where-users-live)) and each writer's library folder ([architecture.md](architecture.md#where-a-writers-words-live)). `NEO_DATABASE_URL` is read too, for a hand-named variable. Put `?sslmode=require` on it when connecting over Railway's public proxy; the private network needs no TLS. |

Generate a secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Railway

1. New project → Deploy from this GitHub repo. `railway.json` selects the `Dockerfile`; the image installs only `web/package.json`'s runtime dependencies (the spellcheck engine, its dictionaries, JSZip). No Electron.
2. Add a **Volume** and mount it at `/data`. The `Dockerfile` deliberately has no `VOLUME` instruction: Railway fails the build on one ("The Dockerfile failed validation") and expects the mount to come from its own Volume.
3. Set `NEO_SESSION_SECRET`, `NEO_SIGNUP`, and for invite mode `NEO_INVITE_CODE`.
4. Generate a domain. Health checks hit `/healthz`.
5. Open the site and create the first account. It is the owner's.
6. Add a **Postgres** service to the project (Railway → New → Database → PostgreSQL) and give this service `DATABASE_URL` as a reference variable (`${{Postgres.DATABASE_URL}}`), or paste the URL by hand. The next deploy creates the tables and moves the writers from `users.json` and their libraries from the volume into them; the volume keeps the file as `users.json.imported-<date>` and each folder as `NEO Library.imported-<date>`.
7. For email (optional, but needed for confirmed addresses and password reset): create a [Resend](https://resend.com) account, add and verify the sending domain there, make an API key, and set `RESEND_API_KEY`, `NEO_MAIL_FROM` and `NEO_PUBLIC_URL` on the service. Accounts made before email was on keep working; only new ones wait for a confirmation link. The server refuses to boot if one of the three is missing and says which. [auth-and-users.md](auth-and-users.md#email) has the flow.

8. For off-site copies of the daily zips: add a **Storage Bucket** to the project (Railway → New → Bucket), open its Variables, pick the **AWS SDK** preset to hand this service `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as references, and add `NEO_BACKUP_BUCKET` = `${{Bucket.BUCKET}}` (the bucket's generated name). Any S3-compatible bucket works the same way with its own endpoint and keys. The zips are never deleted from the bucket by the server; a lifecycle rule there is the place to expire them.

Railway auto-deploys `main`. With Postgres, the database holds the accounts, the history and the words, and the volume holds settings, encrypted keys, error logs and the daily zips; turn on Railway's Postgres backups. The zips on the volume protect against a writer's mistake; the copies in the bucket (step 8) protect against losing the volume.

## Docker anywhere

```
docker build -t neo-hosted .
docker run -p 8080:8080 -v neo-data:/data -e NEO_SESSION_SECRET=... -e NEO_SIGNUP=open neo-hosted
```

The server runs as the `node` user. Railway and Docker mount volumes owned by root, which once failed the first sign-up with `EACCES: permission denied, open '/data/users.json.tmp'`, so `web/docker-entrypoint.sh` starts as root, gives the volume's top folder to `node`, and drops privileges before starting the server. A bind-mounted folder needs no special ownership.

## A laptop

```
cd web && npm install && cd ..
NEO_DEV=1 NEO_SIGNUP=open npm run start:web      # http://localhost:8080
```

## Verifying a deploy without a shell

Things the owner can do from a browser and the Railway dashboard:

- `https://<domain>/healthz` answers `ok`.
- `https://<domain>/` redirects to `/login`; creating an account lands on the shelf and the first-run questions.
- The editor is styled: the shelf has its paper background, not browser defaults. The image copies the desktop app's files by name, so a file missing from the `Dockerfile` shows up here first; `web/test/dockerfile.test.js` guards the list.
- Railway → Deploy logs show `NEO hosted <version> (NEO <version>) listening on :8080`, then the data folder path, `users: postgres` (with `(N imported from users.json)` on the boot that moved them) or `users: users.json`, `libraries: postgres` (with `(N imported from the volume)` on the boot that moved them, and a `[library] imported ...` line per writer), the signup mode, `email: on (Resend)` or `email: off`, and `backups: volume + bucket <name>` or `backups: volume only`. A boot that cannot reach Postgres or fails a migration exits with `could not open the user store` instead of listening.
- With Postgres: signing in with an account made before still works, and Railway → Postgres → Data shows the `users`, `revisions`, `libraries`, `books`, `branches`, `book_files`, `branch_bases` and `schema_migrations` tables. Typing in a chapter adds `revisions` rows and rewrites one `book_files` row; the same words saved twice add none. Books made before the flip are on the shelf with their chapters.
- File → Share… → Publish the Book gives a link; opened in a private window it shows the book as the Web Page export would, with no sign-in. Unpublish, and the link answers Not found.
- `/login` with the browser set to German (or any of the editor's languages) is in that language, errors included; English otherwise.
- On a phone: the page fits the screen, a ☰ at the top left opens the menu (File → Sign Out is in it), a swipe in from the left edge shows the chapters, from the right the notes.
- File → Download Library… saves `NEO Library.zip`: `library.json`, a folder per book with `book.json` and `chapters/`, exactly the desktop layout.
- File → Branches → New Branch… reloads with the book open on the new draft; Railway → Postgres → Data shows the row in `branches`. Edit a paragraph there, switch to the main draft, edit the same paragraph differently, then Branches → Compare & Merge…: the chapter is listed as needing a choice, both versions are shown, and Merge reloads the book with the choice applied.
- With email on: create an account with an address you own; the page says to check your email, the link lands on the shelf, and Resend's dashboard lists the message. "Forgot your password?" on the sign-in page sends the second kind of link.
- Railway → Volume shows `users/<id>/NEO Library/` after the first save (with Postgres only `Backups/` and `neo-errors.log` inside it; the words are in the database).
- With a bucket: within an hour of the deploy (the first sweep runs a minute after boot) Railway → the Bucket's browser shows `<writer id>/neo-backup-<today>.zip` for every writer, and `Backups/` on the volume holds a `.offsite` marker beside each copied zip. A copy that failed leaves a `backup` line in that writer's `neo-errors.log` and is retried on the next hourly sweep.
- A failing save shows a toast in the page and a line in that writer's `neo-errors.log` on the volume.

## Upgrading

Every pull request runs the hosted suite, the lint, the shared parser's tests and a boot of the Docker image in GitHub Actions (`.github/workflows/hosted.yml`); the checks must be green before the merge. Merge to `main`. Sessions survive a deploy (nothing is stored server-side). The tables are migrated on boot by `web/lib/db.js`, which applies each numbered step once; without Postgres, libraries are files and need no migrations. If upstream NEO changes `index.html` so a page marker moves, the new build fails its health check rather than serving a broken page; see `web/lib/page.js`.
