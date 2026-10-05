'use strict';

// The writing room's page is the desktop index.html, served with the hosted
// edition's pieces slotted in: the interface language and the deployment's
// facts as inline data (not script, so CSP stays script-src 'self'), the
// browser bridge that stands in for preload.js, and the menu bar that stands
// in for the native menus. One source of truth for the markup; nothing to
// copy at build time.
//
// Each marker below is a line of index.html as it stands. If upstream NEO
// changes one, buildHostedPage throws at boot and the test names the marker.

const MARKERS = {
  csp: /^\s*<meta http-equiv="Content-Security-Policy"[^\n]*\n/m,
  styles: '<link rel="stylesheet" href="styles.css" />',
  dragstrip: /^\s*<!-- Draggable strip[^\n]*\n\s*<div id="dragstrip"><\/div>\n/m,
  i18nScript: '<script src="i18n.js"></script>',
  appScript: '<script src="app.js"></script>'
};

/** JSON that is safe inside a <script type="application/json"> element. */
function inlineJSON(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * @param {object} parts
 * @param {string} parts.indexHtml     the desktop index.html
 * @param {object} parts.i18n          { locale, dict, base } for this writer
 * @param {object} parts.hostedConfig  what web-bridge.js and web-menu.js need to know
 */
function buildHostedPage({ indexHtml, i18n, hostedConfig }) {
  let html = indexHtml;
  for (const [name, marker] of Object.entries(MARKERS)) {
    const present = typeof marker === 'string' ? html.includes(marker) : marker.test(html);
    if (!present) throw new Error(`index.html no longer has the "${name}" marker the hosted page is built around`);
  }
  // the server sends the policy as a header, with the few sources a browser needs
  html = html.replace(MARKERS.csp, '');
  // no frameless window to drag
  html = html.replace(MARKERS.dragstrip, '');
  // a phone lays the page out at its own width (the desktop window never needed saying)
  html = html.replace(MARKERS.styles, '<meta name="viewport" content="width=device-width, initial-scale=1" />\n  ' + MARKERS.styles);
  html = html.replace(MARKERS.i18nScript,
    '<link rel="stylesheet" href="/web/web.css" />\n' +
    `  <script id="neo-i18n" type="application/json">${inlineJSON(i18n)}</script>\n` +
    `  <script id="neo-hosted-config" type="application/json">${inlineJSON(hostedConfig)}</script>\n` +
    '  <script src="/jszip.min.js"></script>\n' +
    '  <script src="i18n.js"></script>\n' +
    '  <script src="/web/web-bridge.js"></script>');
  html = html.replace(MARKERS.appScript, '<script src="app.js"></script>\n  <script src="/web/web-menu.js"></script>\n  <script src="/web/web-history.js"></script>\n  <script src="/web/web-branches.js"></script>\n  <script src="/web/web-mobile.js"></script>');
  return html;
}

// What the page may load. Styles need 'unsafe-inline' for the style=""
// attributes index.html already carries (the desktop policy never limited
// styles); scripts stay 'self' only, as on the desktop. Images may be data:
// and blob: for canvas covers and exports.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

module.exports = { buildHostedPage, inlineJSON, PAGE_CSP, MARKERS };
