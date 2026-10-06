'use strict';

// The suite builds the app through createApp(); only a real `node web/server.js`
// runs the block under `require.main === module`, where the boot summary is
// printed. A name out of scope there (it happened: `db` is createApp's) throws
// after "listening", so the server serves but the line the deployment doc
// tells the owner to read never appears. This test boots the entry point the
// way Railway does and reads both lines.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { describe, test } = require('node:test');

const SERVER = path.join(__dirname, '..', 'server.js');

function bootAndCollect(timeoutMs) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-boot-'));
  const env = { ...process.env, NEO_DEV: '1', NEO_DATA_DIR: dataDir, PORT: '0' };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const onData = (chunk) => { output += chunk; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return new Promise((resolve) => {
    const finish = () => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); resolve(output); };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on('data', () => {
      // the summary is the second line; give stderr a moment to land after it
      if (/\nlibrary volume: /.test(output) || /\[main\]/.test(output)) setTimeout(() => { clearTimeout(timer); finish(); }, 200);
    });
  });
}

describe('node web/server.js', () => {
  test('prints the two boot lines and no error', async () => {
    const output = await bootAndCollect(15000);
    assert.match(output, /^NEO hosted .* listening on :/m, `no "listening" line in:\n${output}`);
    assert.match(output, /^library volume: .* {2}users: .* {2}libraries: .* {2}signup: .* {2}pdf: /m, `no boot summary in:\n${output}`);
    assert.doesNotMatch(output, /\[main\]|Error/, `the boot logged an error:\n${output}`);
  });
});
