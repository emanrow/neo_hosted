> [CLAUDE.md](../CLAUDE.md) > The print service

# The print service

File → Export → PDF, and the ⌘E email snapshot, made by a headless Chromium with [Paged.js](https://pagedjs.org) instead of the browser's print dialog. It is the first piece of the typography work: a book laid out as a book, the same for every writer, from the same HTML the EPUB and Web Page exports already come from. The editor (`app.js`) is untouched; `print/` is a second service beside `web/`.

## What a writer gets

With the service set up, Export → PDF downloads a file: a cover page, a title page, the front matter without page numbers, a contents page whose entries carry the page each section starts on, chapters each starting a new page with the folio at the foot, and the chapter headings as the PDF's bookmarks (the text is tagged for screen readers, as the desktop's `printToPDF` does). ⌘E downloads the same PDF and opens the mail draft to drag it into.

Without the service, or when it fails, nothing changes from before: the export opens as a print view with the browser's dialog up, and a toast says why.

The sheet is Letter for a writer whose interface language is English and A4 for everyone else, until the export dialog offers a trim size (the next step of the typography work; the route already takes `?size=`).

## How it works

```
app.js  buildHtml(data, { cover, fonts })        the export as one self-contained page
   │
web/public/web-bridge.js  printPdf()              POST /api/export:pdf?name=&size=   (text/html)
   │
web/server.js  handlePdfExport → web/lib/print-client.js  POST NEO_PRINT_URL/render?size=   Bearer NEO_PRINT_SECRET
   │
print/server.js → print/lib/renderer.js            Chromium: setContent, Paged.js, page.pdf()   → application/pdf, X-Pages
```

- **`print/lib/prepare.js`** gets the export ready for Paged.js: the sheet (`@page { size; margin: 1in }`) ahead of the book's own rules so the book's `@page` rules (the folio, the `front` pages without one) win where they overlap; the body's browser margin zeroed (a 40px top margin on the first page pushed the cover onto a second sheet); a `PagedConfig.after` hook that records the page count; and the contents page's empty number spans given the anchor they point at, so one CSS rule, `target-counter(attr(data-href url), page)`, fills them in. That replaces the desktop's trick of printing twice to learn where the sections landed.
- **`print/lib/renderer.js`** keeps one Chromium warm, opens a fresh browser context per book, refuses every network request from inside the page (an export inlines its fonts and cover, so it needs none), adds Paged.js as a script tag after the page has loaded, waits for the hook, and prints with `preferCSSPageSize`, `outline` and `tagged`. A semaphore lets `NEO_PRINT_CONCURRENCY` books lay out at once and queues the rest; a book past `NEO_PRINT_TIMEOUT_MS` is given up on.
- **`print/server.js`** is `node:http` with two routes, `GET /healthz` and `POST /render`. The secret is compared in constant time. Nothing is written to disk and no log line carries words: page counts, timings and byte counts only.
- **`web/lib/print-client.js`** is the web server's side: one `fetch`, the secret as a bearer token, the PDF and its page count back. What the printer says about the book (too large, an unknown size) reaches the writer with its own status; the printer's own failures become a 502 that names no internals. `NO_PRINTER` stands in without `NEO_PRINT_URL` and answers 503, which the bridge turns into the print view.

**Coupling to keep in step.** `prepare.js` knows the shape of `buildHtml`'s contents entry: `<a href="#s2"><span class="toc-t">…</span><span class="toc-pg" data-for="s2"></span></a>`. If upstream changes it, the contents page prints without numbers and `print/test/prepare.test.js` says so. Nothing else in the printer knows the editor's markup.

## Deploying it on Railway

The printer is its own service in the same Railway project, built from this repository with `print/` as its root directory. Its image is Playwright's (`mcr.microsoft.com/playwright:v1.63.0-noble`, about 2 GB), which carries the Chromium that `playwright-core` 1.63 drives; the two versions must match, so bump `print/package.json` and `print/Dockerfile` together.

1. Railway → New → GitHub Repo → this repository again. In the new service's Settings, set **Root Directory** to `print` (then `print/railway.json` and `print/Dockerfile` apply). Name the service `neo-print`.
2. On `neo-print`, set `NEO_PRINT_SECRET` to 16+ random characters. No domain is needed: the web service reaches it over the private network.
3. On the web service, set `NEO_PRINT_URL` to `http://${{neo-print.RAILWAY_PRIVATE_DOMAIN}}:8081` and `NEO_PRINT_SECRET` to the same value (a reference, `${{neo-print.NEO_PRINT_SECRET}}`, keeps them equal). The web server refuses to boot with the URL but no secret and says so.
4. Both redeploy. Export → PDF now downloads a file.

Memory: Chromium wants about 512 MB for a long novel; give the service 1 GB and watch Railway's metrics. The printer holds no state, so it can be restarted or scaled at will.

| Variable (on `neo-print`) | Meaning |
|---|---|
| `PORT` | Railway sets it. Default 8081. |
| `NEO_PRINT_SECRET` | Required, 16+ characters; the web server presents it on every book. |
| `NEO_PRINT_CONCURRENCY` | Books laid out at the same time. Default 2. |
| `NEO_PRINT_TIMEOUT_MS` | A book that takes longer is given up on. Default 180000. |
| `CHROMIUM_PATH` | A Chromium to use instead of Playwright's own (a laptop). |

The web service's two variables are in [deployment.md](deployment.md#environment).

## Verifying without a shell

- Railway → `neo-print` → Deploy logs: `NEO print listening on :8081  concurrency: 2  timeout: 180000 ms`; the web service's boot line ends `pdf: print service` (without the variables, `pdf: browser print view`).
- In the writing room, File → Export → PDF: a `.pdf` downloads instead of a print dialog opening, and a toast says `PDF saved: N pages`. Open it: the contents page has numbers, the chapters are bookmarks in the reader's sidebar, chapter pages carry a folio at the foot and the title page does not.
- `neo-print`'s logs show one `[print] rendered N pages in M ms, B bytes` line per export and never a word of the book.
- Stop the `neo-print` service: Export → PDF falls back to the print view with a toast saying the print service could not make the PDF.

## Running it on a laptop

```
cd print && npm install && cd ..
NEO_PRINT_SECRET=a-secret-of-sixteen-plus CHROMIUM_PATH=/path/to/chrome npm --prefix print start      # :8081
NEO_DEV=1 NEO_SIGNUP=open NEO_PRINT_URL=http://127.0.0.1:8081 NEO_PRINT_SECRET=a-secret-of-sixteen-plus npm run start:web
```

Without `CHROMIUM_PATH`, `playwright-core` looks for the browser Playwright would have installed (`npx playwright install chromium`).

## Tests

- `npm run test:print`: `print/test/prepare.test.js` (the sizes allowed, what is injected and where, the contents spans) and `print/test/server.test.js` (the routes against a stub renderer; then, when a Chromium is at hand through `CHROMIUM_PATH` or Playwright's own install, the real renderer on a small book: page count, A5 sheets, bookmarks, a second book on the same browser).
- `web/test/print-client.test.js` (the client against a stub `fetch`, the settings) and `web/test/print-route.test.js` (the route on the real web server with a stub printer: the page's `print` flag, the download's headers, Letter for English, the refusals, 503 without a printer).
- CI ([hosted.yml](../.github/workflows/hosted.yml)): the print suite runs inside Playwright's image so the real renderer is covered, and the printer's Docker image is built, booted and asked for one page.

## Security posture

The route takes any whole HTML page from a signed-in writer and runs it, with script, in Chromium. That is why every request from inside the page is refused (nothing on the private network is reachable from it), why the service holds no data and no credentials beyond its own secret, why the body is capped (48 MB) and the render timed, and why Chromium runs as the image's unprivileged user with the sandbox off rather than as root with it on. The secret keeps strangers out of the printer; it does not make the page trusted.
