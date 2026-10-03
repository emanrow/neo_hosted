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

Generate a secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Railway

1. New project → Deploy from this GitHub repo. `railway.json` selects the `Dockerfile`; the image installs only `web/package.json`'s runtime dependencies (the spellcheck engine, its dictionaries, JSZip). No Electron.
2. Add a **Volume** and mount it at `/data`.
3. Set `NEO_SESSION_SECRET`, `NEO_SIGNUP`, and for invite mode `NEO_INVITE_CODE`.
4. Generate a domain. Health checks hit `/healthz`.
5. Open the site and create the first account. It is the owner's.

Railway auto-deploys `main`. The volume is the only state; back it up. The daily zips live on the same volume, so they protect against a writer's mistake, not against losing the volume ([backlog.md](backlog.md) has off-site copies).

## Docker anywhere

```
docker build -t neo-hosted .
docker run -p 8080:8080 -v neo-data:/data -e NEO_SESSION_SECRET=... -e NEO_SIGNUP=open neo-hosted
```

The image runs as the `node` user, so a bind-mounted folder must be writable by uid 1000.

## A laptop

```
cd web && npm install && cd ..
NEO_DEV=1 NEO_SIGNUP=open npm run start:web      # http://localhost:8080
```

## Verifying a deploy without a shell

Things the owner can do from a browser and the Railway dashboard:

- `https://<domain>/healthz` answers `ok`.
- `https://<domain>/` redirects to `/login`; creating an account lands on the shelf and the first-run questions.
- Railway → Deploy logs show `NEO hosted <version> (NEO <version>) listening on :8080` and the data folder path.
- Railway → Volume shows `users.json` and `users/<id>/NEO Library/` after the first sign-up.
- A failing save shows a toast in the page and a line in that writer's `neo-errors.log` on the volume.

## Upgrading

Merge to `main`. Sessions survive a deploy (nothing is stored server-side). Libraries are files; there are no migrations. If upstream NEO changes `index.html` so a page marker moves, the new build fails its health check rather than serving a broken page; see `web/lib/page.js`.
