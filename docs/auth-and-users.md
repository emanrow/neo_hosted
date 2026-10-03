> [CLAUDE.md](../CLAUDE.md) > Auth and users

# Auth and users

The desktop app has one writer and no sign-in. The hosted edition adds the smallest account system that keeps "books are plain files" true of the people too.

## Sign-in

- **Passwords** are scrypt hashes (`web/lib/auth.js`), parameters recorded in the stored string (`scrypt$N$r$p$salt$hash`) so they can be raised later and old hashes still verify. Minimum 8 characters.
- **Sessions** are signed tokens in an HttpOnly, SameSite=Lax cookie (`neo_session`), `userId.expiry.hmac`, good for 30 days. Nothing is stored server-side: a restart signs nobody out, and rotating `NEO_SESSION_SECRET` signs everybody out.
- **Throttle**: ten wrong passwords from one address or for one email close the door for fifteen minutes (`LoginThrottle`, in memory; a restart forgives). The client address comes from `X-Forwarded-For` only when `trustProxy` is on.
- **CSRF**: `/auth/*` and `/api/*` POSTs must be same-origin by `Sec-Fetch-Site` (or `Origin` on older browsers). API bodies are JSON, which a cross-site form cannot send.
- **Secure cookies** are set when the request is TLS or the trusted proxy says `X-Forwarded-Proto: https`.

## Signup policy

`NEO_SIGNUP` is `open`, `invite` (a shared `NEO_INVITE_CODE`, compared in constant time) or `closed`. Whatever the setting, the very first account can always be created, so a fresh deployment has an owner. There is no admin role yet; see [backlog.md](backlog.md).

## Where users live, and the database question

Users are one JSON file, `<NEO_DATA_DIR>/users.json`, behind `JsonUserStore` (`web/lib/user-store.js`): `count`, `findByEmail`, `findById`, `create`, `setPasswordHash`. Ids are random (`u-<hex>`), so an email change never moves a library folder. That is right for a household or a writing group.

Reach for Postgres when one of these becomes true:

- more than one server instance behind the proxy (the JSON file is not shared);
- thousands of writers (every lookup reads the file);
- password reset by email, invitations per person, or roles, which want transactions and history.

The swap is a second class with the same five methods, chosen in `server.js`. Libraries stay files either way; a database would hold accounts, never manuscripts.

## API keys at rest

A writer's cover-art key (`secret:set` / `secret:has` / `cover:paint`) is stored in their own `secrets.json`, outside the library folder, encrypted with AES-256-GCM under a key derived from `NEO_SESSION_SECRET` by HKDF (`web/lib/secrets.js`). The desktop uses the OS keychain for the same job. Rotating the secret makes stored keys unreadable, which is the honest outcome: writers paste theirs in again. Nothing from `secrets.json` ever enters a library, a backup zip, or a download.

## Known gaps

- No password reset, no email of any kind.
- No admin surface: the owner edits `users.json` on the volume to remove an account.
- The login throttle is per process; a restart clears it.
- Rate limits exist only on sign-in. Everything else trusts a signed-in writer, as the desktop trusts its one user.
