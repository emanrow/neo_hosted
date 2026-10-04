'use strict';

// The Dockerfile copies the desktop app's files one by one, so a file the
// server serves or requires from the repository root is missing from the
// image unless it is named there. The repository's own test run never
// notices (the file is right there); a deploy does, as a 404 for /styles.css
// and an unstyled editor. This test reads the Dockerfile and checks that
// everything web/server.js reaches for at the root is copied.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { ROOT_FILES, ROOT_DIRS } = require('../server');

const ROOT = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

// every `COPY a b c ./dest` line, as the set of sources it names
const copied = new Set(dockerfile.split('\n')
  .filter((line) => /^COPY\s/.test(line))
  .flatMap((line) => line.replace(/^COPY\s+/, '').trim().split(/\s+/).slice(0, -1)));

// root files the server requires at boot or on demand, beyond the ones it serves
const REQUIRED_AT_RUNTIME = ['package.json', 'index.html', 'i18n.js', 'spell-ro.js', 'art.js', 'import-parse.js', 'build/icon.png'];

describe('the Docker image', () => {
  test('copies every root file the server serves to the browser', () => {
    for (const p of ROOT_FILES) assert.ok(copied.has(p.slice(1)), `Dockerfile does not COPY ${p.slice(1)}, which the server serves at ${p}`);
    for (const d of ROOT_DIRS) assert.ok(copied.has(d.slice(1, -1)), `Dockerfile does not COPY ${d.slice(1, -1)}/`);
  });

  test('copies every root file the server requires', () => {
    for (const f of REQUIRED_AT_RUNTIME) assert.ok(copied.has(f), `Dockerfile does not COPY ${f}`);
  });

  test('names only files that exist, so the build cannot fail on a rename', () => {
    for (const f of copied) assert.ok(fs.existsSync(path.join(ROOT, f)), `Dockerfile copies ${f}, which is not in the repository`);
  });
});
