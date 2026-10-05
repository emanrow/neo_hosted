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
| `DATABASE_URL` | Postgres for accounts. Railway sets it when the Postgres service is referenced from this one. Unset, accounts stay in `users.json` on the volume. The first boot with it set imports `users.json` ([auth-and-users.md](auth-and-users.md#where-users-live)). `NEO_DATABASE_URL` is read too, for a hand-named variable. Put `?sslmode=require` on it when connecting over Railway's public proxy; the private network needs no TLS. |

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
6. Add a **Postgres** service to the project (Railway → New → Database → PostgreSQL) and give this service `DATABASE_URL` as a reference variable (`${{Postgres.DATABASE_URL}}`), or paste the URL by hand. The next deploy creates the `users` table and moves the writers from `users.json` into it; the volume keeps the file as `users.json.imported-<date>`.
7. For email (optional, but needed for confirmed addresses and password reset): create a [Resend](https://resend.com) account, add and verify the sending domain there, make an API key, and set `RESEND_API_KEY`, `NEO_MAIL_FROM` and `NEO_PUBLIC_URL` on the service. Accounts made before email was on keep working; only new ones wait for a confirmation link. The server refuses to boot if one of the three is missing and says which. [auth-and-users.md](auth-and-users.md#email) has the flow.

Railway auto-deploys `main`. The volume is the only state; back it up. The daily zips live on the same volume, so they protect against a writer's mistake, not against losing the volume ([backlog.md](backlog.md) has off-site copies).

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
- Railway → Deploy logs show `NEO hosted <version> (NEO <version>) listening on :8080`, then the data folder path, `users: postgres` (with `(N imported from users.json)` on the boot that moved them) or `users: users.json`, the signup mode and `email: on (Resend)` or `email: off`. A boot that cannot reach Postgres or fails a migration exits with `could not open the user store` instead of listening.
- With Postgres: signing in with an account made before still works, and Railway → Postgres → Data shows the `users`, `revisions` and `schema_migrations` tables. Typing in a chapter adds `revisions` rows; the same words saved twice add none.
- File → Branches → New Branch… reloads with the book open on the new draft; Railway → Volume shows `.branches/<name>/` inside the book's folder. Edit a paragraph there, switch to the main draft, edit the same paragraph differently, then Branches → Compare & Merge…: the chapter is listed as needing a choice, both versions are shown, and Merge reloads the book with the choice applied.
- With email on: create an account with an address you own; the page says to check your email, the link lands on the shelf, and Resend's dashboard lists the message. "Forgot your password?" on the sign-in page sends the second kind of link.
- Railway → Volume shows `users/<id>/NEO Library/` after the first sign-up (and `users.json` only without Postgres).
- A failing save shows a toast in the page and a line in that writer's `neo-errors.log` on the volume.

## Upgrading

Every pull request runs the hosted suite, the lint, the shared parser's tests and a boot of the Docker image in GitHub Actions (`.github/workflows/hosted.yml`); the checks must be green before the merge. Merge to `main`. Sessions survive a deploy (nothing is stored server-side). Libraries are files and need no migrations; the `users` table is migrated on boot by `web/lib/db.js`, which applies each numbered step once. If upstream NEO changes `index.html` so a page marker moves, the new build fails its health check rather than serving a broken page; see `web/lib/page.js`.
