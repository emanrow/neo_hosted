> [CLAUDE.md](../CLAUDE.md) > print/

# print/ -- the PDF printer

A second, smaller service beside the app: one headless Chromium with [Paged.js](https://pagedjs.org), reached only by `web/server.js` over Railway's private network. The app sends the export HTML `app.js` built (the same document the Web Page and EPUB exports come from), the printer lays it out as a book and answers with the PDF. It keeps nothing and fetches nothing: every request the document would make is refused, so the book carries its own fonts and cover as data: URLs, which `exportFontFaces` and `exportCover` in `app.js` already do.

## Files

```
print/
  server.js        POST /render?lang=&trim= (text/html in, application/pdf out, X-Neo-Pages on the answer), GET /healthz; createApp(config), renderBook(browser, html, opts)
  book.js          TRIMS (5.5x8.5, 6x9, a5, letter, a4: page size, mirrored margins, type size and leading) and bookStyles(name), the stylesheet Paged.js lays the book out with
  book.css         the book's page laid over the exporter's own styles: justified book type, widows and orphans, hyphenation, headings scaled to the trim, the contents page numbered by target-counter
  Dockerfile       node:22-bookworm-slim + Debian's chromium; Railway builds it with the service's Root Directory set to `print`
  railway.json     the health check for that service
  test/            node:test; the render test runs only where a Chromium is at hand (CHROMIUM_PATH, or /usr/bin/chromium in the image)
```

## How a book becomes a PDF

1. `web/server.js` receives `POST /api/export:pdf` with the export HTML (`web/lib/print-client.js` forwards it with the shared secret and the writer's language).
2. `renderBook` opens a page sized to the trim's content box (so the exporter's `vh` paddings mean a share of the printed page), sets the document, adds `bookStyles(trim)`, waits for the embedded fonts, and runs Paged.js with `auto: false` then `preview()`, which resolves once every page is laid out.
3. Chromium prints with `preferCSSPageSize`, a document outline (the chapter headings become the PDF's bookmarks) and tagging (for screen readers), and the bytes go straight back.

If Paged.js throws on a book, the document is printed as Chromium alone would (the answer says so in `X-Neo-Paged: 0`) rather than failing the export.

## Gotchas

- **Paged.js marks the element it split across pages** with `data-align-last-split-element="justify"` so its last line on the page is justified; a section split that way passes the mark down, since `text-align-last` inherits, and every paragraph's last line would be stretched. `book.css` sets `p { text-align-last: auto }`, a rule weak enough that a paragraph Paged.js splits itself still gets its attribute rule.
- **The package's `exports` map hides `dist/`,** so `server.js` finds `paged.polyfill.js` by path under `node_modules`, not through `require.resolve`.
- **The viewport is the content box, not the trim.** The exporter's `.copyright { min-height: 98vh }` and the `padding-top: 2Xvh` openers were written for a screen; `book.css` trims the copyright page to `94vh` so it stays on one page.
- **Chromium runs with `--no-sandbox`:** the image runs as `node` in a container without user namespaces. The document is the writer's own and fetches nothing, which is the boundary.
- **The service listens on every address** (no host given to `listen`), because Railway's private network is IPv6; a laptop reaches it at `localhost`.
- **Concurrency is a gate, not a pool.** `NEO_PRINT_CONCURRENCY` books render at once in one browser, each in its own page; the rest wait in order. The app's request timeout (`print-client.js`) allows for the wait.
