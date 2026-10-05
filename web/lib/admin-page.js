'use strict';

// The owner's page: who has an account, what the volume and the database
// hold, and a way to remove an account. Server-rendered, no script; the one
// action is a form that asks for the address to be typed back. English only:
// it is the owner's own page, not a writer's.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const when = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '');

/**
 * @param {{
 *   me: { id: string, email: string },
 *   writers: Array<{ id: string, email: string, createdAt: string, emailVerifiedAt: string|null, books: number, libraryBytes: number, backups: number, shares: number }>,
 *   facts: Array<[string, string]>,
 *   volume: Array<[string, number]>,
 *   notice?: string
 * }} view
 */
function buildAdminPage({ me, writers, facts, volume, notice = '' }) {
  const row = (w) => `
      <tr>
        <td>${escapeHtml(w.email)}${w.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
        <td>${escapeHtml(when(w.createdAt))}</td>
        <td>${w.emailVerifiedAt === null ? '<span class="muted">waiting for the link</span>' : 'yes'}</td>
        <td class="num">${w.books}</td>
        <td class="num">${escapeHtml(bytes(w.libraryBytes))}</td>
        <td class="num">${w.backups}</td>
        <td class="num">${w.shares}</td>
        <td>${w.id === me.id ? '' : `
          <form method="post" action="/admin/remove" class="remove">
            <input type="hidden" name="userId" value="${escapeHtml(w.id)}" />
            <input name="confirm" placeholder="type the address to confirm" autocomplete="off" aria-label="type ${escapeHtml(w.email)} to confirm" />
            <button type="submit">Remove</button>
          </form>`}
        </td>
      </tr>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="robots" content="noindex" />
  <title>NEO — Admin</title>
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/web/web.css" />
</head>
<body class="hosted-admin">
  <main class="admin">
    <h1>NEO <span class="muted">admin</span></h1>
    <p class="muted">Signed in as ${escapeHtml(me.email)}. <a href="/">Back to the shelf</a></p>
    ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}

    <h2>Accounts</h2>
    <table>
      <thead><tr><th>Email</th><th>Created</th><th>Confirmed</th><th class="num">Books</th><th class="num">Library</th><th class="num">Zips</th><th class="num">Pages</th><th></th></tr></thead>
      <tbody>${writers.map(row).join('')}
      </tbody>
    </table>
    <p class="muted">Removing an account signs it out for good and takes down its public pages. Its library is zipped first, as the desktop folder, under <code>removed/</code> on the volume; nothing is deleted that cannot be put back from that zip.</p>

    <h2>This server</h2>
    <table class="facts">
      <tbody>${facts.map(([k, v]) => `
        <tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
      </tbody>
    </table>

    <h2>The volume</h2>
    <table class="facts">
      <tbody>${volume.map(([k, v]) => `
        <tr><th>${escapeHtml(k)}</th><td>${escapeHtml(bytes(v))}</td></tr>`).join('')}
      </tbody>
    </table>
  </main>
</body>
</html>
`;
}

module.exports = { buildAdminPage, bytes };
