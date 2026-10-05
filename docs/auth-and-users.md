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

## Email

Email is on when `RESEND_API_KEY` is set (with `NEO_MAIL_FROM` and `NEO_PUBLIC_URL`; [deployment.md](deployment.md#environment)). `web/lib/mail.js` is the only file that knows the provider is [Resend](https://resend.com); `server.js` asks `mailer.enabled` and calls `send`. With email off, nothing below exists: signup signs straight in and "Forgot your password?" answers that reset is not set up here.

- **Confirming an address.** A new account is created with `emailVerifiedAt: null` and the page says to check your email; no cookie is set. The link, `GET /auth/verify?token=`, marks the address confirmed, signs the writer in and lands on the shelf. Signing in with the right password before confirming refuses with a fresh link; signing up again with the same password while waiting also resends it, so a lost email is never a lost account. Accounts made before email was on have no `emailVerifiedAt` and count as confirmed.
- **Resetting a password.** `POST /auth/forgot { email }` always answers ok, so the form cannot be used to find out who writes here; when the address has an account, a link to `/login?reset=<token>` goes out. The sign-in page opens in reset mode, and `POST /auth/reset { token, password }` sets the new password, confirms the address (opening the link proved it) and signs in.
- **The links** are signed tokens like sessions, `purpose.userId.expiry.stamp.hmac`, with the HMAC key derived from the session secret per purpose by HKDF, so a confirmation link can never pass as a session or a reset. The stamp is a digest of the state the link should die with: for a reset, the password hash, so the link works once and a replay is refused. Confirmation links last a day, reset links an hour. Nothing is stored server-side.
- **Ration.** Five emails to one address, twenty from one client, per fifteen minutes (`LoginThrottle` again). Past that, 429.
- **Messages** are plain text with one link each; the writer's mail client renders them.

## Where users live, and the database question

Users are one JSON file, `<NEO_DATA_DIR>/users.json`, behind `JsonUserStore` (`web/lib/user-store.js`): `count`, `findByEmail`, `findById`, `create`, `setPasswordHash`, `markEmailVerified`, and `update(id, change)` behind the last two. Ids are random (`u-<hex>`), so an email change never moves a library folder. That is right for a household or a writing group.

Reach for Postgres when one of these becomes true:

- more than one server instance behind the proxy (the JSON file is not shared);
- thousands of writers (every lookup reads the file);
- invitations per person, roles, or an audit trail, which want transactions and history.

The swap is a second class with the same methods, chosen in `server.js`. Libraries stay files either way; a database would hold accounts, never manuscripts. The owner wants a checkpoint on data management as a whole before this moves ([backlog.md](backlog.md)).

## API keys at rest

A writer's cover-art key (`secret:set` / `secret:has` / `cover:paint`) is stored in their own `secrets.json`, outside the library folder, encrypted with AES-256-GCM under a key derived from `NEO_SESSION_SECRET` by HKDF (`web/lib/secrets.js`). The desktop uses the OS keychain for the same job. Rotating the secret makes stored keys unreadable, which is the honest outcome: writers paste theirs in again. Nothing from `secrets.json` ever enters a library, a backup zip, or a download.

## Known gaps

- No way to change the email on an account, and no admin surface: the owner edits `users.json` on the volume to remove an account.
- Turning email on does not ask existing accounts to confirm; they are trusted as they were.
- The login and email throttles are per process; a restart clears them.
- Rate limits exist only on sign-in and email. Everything else trusts a signed-in writer, as the desktop trusts its one user.
