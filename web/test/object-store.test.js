'use strict';

// The off-site copy: SigV4 signing against a known vector, a PUT against a
// local stand-in for the bucket that checks the signature with its own
// arithmetic, and the retry marker in backups.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createObjectStore, signRequest, sha256, EMPTY_HASH } = require('../lib/object-store');
const { dailyZip, OFFSITE_MARK } = require('../lib/backups');
const { loadConfig } = require('../lib/config');

// AWS's published example secret; its example key id is spelled differently here so no scanner mistakes it for a live one.
const KEYS = { accessKeyId: 'EXAMPLE-KEY-ID', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('signRequest', () => {
  test("matches the GET Object example in AWS's SigV4 documentation", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html#sig-v4-examples-get-object
    const headers = signRequest({
      method: 'GET', path: '/test.txt',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
      payloadHash: EMPTY_HASH, region: 'us-east-1', ...KEYS,
      now: new Date('2013-05-24T00:00:00Z')
    });
    assert.equal(headers['x-amz-date'], '20130524T000000Z');
    assert.equal(headers.authorization,
      'AWS4-HMAC-SHA256 Credential=EXAMPLE-KEY-ID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

/** A bucket that stores what it is sent and recomputes every signature with the secret it knows. */
function fakeBucket({ failFirst = 0 } = {}) {
  const objects = new Map();
  const bad = [];
  let failures = failFirst;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (failures > 0) { failures--; res.writeHead(503); res.end('SlowDown'); return; }
      const auth = req.headers.authorization || '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      if (!m) { bad.push('no authorization'); res.writeHead(403); res.end(); return; }
      const [, keyId, date, region, signedHeaders, signature] = m;
      const canonicalHeaders = signedHeaders.split(';').map((h) => `${h}:${req.headers[h]}\n`).join('');
      const canonicalRequest = [req.method, req.url, '', canonicalHeaders, signedHeaders, req.headers['x-amz-content-sha256']].join('\n');
      const scope = `${date}/${region}/s3/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256(canonicalRequest)].join('\n');
      const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
      const expected = crypto.createHmac('sha256', h(h(h(h('AWS4' + KEYS.secretAccessKey, date), region), 's3'), 'aws4_request')).update(stringToSign).digest('hex');
      if (keyId !== KEYS.accessKeyId || expected !== signature) { bad.push('signature'); res.writeHead(403); res.end('SignatureDoesNotMatch'); return; }
      if (req.headers['x-amz-content-sha256'] !== sha256(body)) { bad.push('payload hash'); res.writeHead(400); res.end(); return; }
      objects.set(`${req.headers.host}${req.url}`, { body, type: req.headers['content-type'] });
      res.writeHead(200); res.end();
    });
  });
  return {
    objects, bad,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

describe('createObjectStore', () => {
  test('refuses to start without its pieces', () => {
    assert.throws(() => createObjectStore({ bucket: 'b', endpoint: 'https://x', region: 'auto', accessKeyId: 'k' }), /secretAccessKey is required/);
  });

  test('addresses the bucket as a subdomain by default and on the path when asked', () => {
    const virtual = createObjectStore({ bucket: 'words-abc', endpoint: 'https://storage.example.test', region: 'auto', ...KEYS, prefix: '/neo/' });
    assert.equal(virtual.urlFor('user 1/neo-backup-2026-01-01.zip').toString(), 'https://words-abc.storage.example.test/neo/user%201/neo-backup-2026-01-01.zip');
    const onPath = createObjectStore({ bucket: 'words', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', ...KEYS, pathStyle: true });
    assert.equal(onPath.urlFor('u/x.zip').toString(), 'http://127.0.0.1:9000/words/u/x.zip');
  });

  test('PUT carries a signature the bucket accepts, the payload hash and the bytes', async () => {
    const bucket = fakeBucket();
    const endpoint = await bucket.listen();
    try {
      const store = createObjectStore({ bucket: 'words', endpoint, region: 'auto', ...KEYS, pathStyle: true });
      const bytes = Buffer.from('PK zip bytes');
      await store.put('user-1/neo-backup-2026-01-01.zip', bytes, 'application/zip');
      assert.deepEqual(bucket.bad, []);
      const stored = bucket.objects.get(`${new URL(endpoint).host}/words/user-1/neo-backup-2026-01-01.zip`);
      assert.ok(stored, 'landed under the bucket and key');
      assert.equal(stored.body.toString(), 'PK zip bytes');
      assert.equal(stored.type, 'application/zip');
    } finally { await bucket.close(); }
  });

  test('a wrong secret is refused by the bucket and surfaces as an error', async () => {
    const bucket = fakeBucket();
    const endpoint = await bucket.listen();
    try {
      const store = createObjectStore({ bucket: 'words', endpoint, region: 'auto', accessKeyId: KEYS.accessKeyId, secretAccessKey: 'nope', pathStyle: true });
      await assert.rejects(store.put('k', Buffer.from('x')), /403 SignatureDoesNotMatch/);
    } finally { await bucket.close(); }
  });
});

describe('dailyZip with an off-site copy', () => {
  test('copies today\'s zip once, retries a failed copy on the next sweep, and never blocks the local zip', async () => {
    const backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-offsite-'));
    const sent = [];
    let failing = true;
    const copy = async (name, bytes) => { if (failing) throw new Error('bucket away'); sent.push({ name, size: bytes.length }); };
    const fill = (zip) => zip.file('library.json', '{}');
    await assert.rejects(dailyZip({ backupsDir, fill, copy }), /bucket away/);
    const zips = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, 'the zip is on the volume even though the copy failed');
    assert.ok(!fs.existsSync(path.join(backupsDir, zips[0] + OFFSITE_MARK)), 'no marker until it lands');
    failing = false;
    assert.equal(await dailyZip({ backupsDir, fill, copy }), false, 'nothing new to zip');
    assert.equal(sent.length, 1, 'the copy was retried');
    assert.equal(sent[0].name, zips[0]);
    assert.ok(fs.existsSync(path.join(backupsDir, zips[0] + OFFSITE_MARK)));
    await dailyZip({ backupsDir, fill, copy });
    assert.equal(sent.length, 1, 'copied once');
    await dailyZip({ backupsDir, fill });
    assert.equal(sent.length, 1, 'without a copy nothing is sent');
  });
});

describe('loadConfig for the bucket', () => {
  const base = { NEO_DEV: '1' };
  test('no bucket, no store', () => assert.equal(loadConfig(base).backupBucket, null));
  test('the AWS SDK names fill the store in', () => {
    const c = loadConfig({ ...base, NEO_BACKUP_BUCKET: 'b', AWS_ENDPOINT_URL: 'https://storage.railway.app', AWS_REGION: 'auto', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' });
    assert.deepEqual(c.backupBucket, { bucket: 'b', endpoint: 'https://storage.railway.app', region: 'auto', accessKeyId: 'k', secretAccessKey: 's', prefix: '', pathStyle: false });
  });
  test('the NEO_BACKUP names win and the region defaults to auto', () => {
    const c = loadConfig({ ...base, NEO_BACKUP_BUCKET: 'b', AWS_ENDPOINT_URL: 'https://aws', NEO_BACKUP_ENDPOINT: 'http://127.0.0.1:9000', NEO_BACKUP_ACCESS_KEY_ID: 'k', NEO_BACKUP_SECRET_ACCESS_KEY: 's', NEO_BACKUP_PATH_STYLE: '1', NEO_BACKUP_PREFIX: 'neo' });
    assert.equal(c.backupBucket.endpoint, 'http://127.0.0.1:9000');
    assert.equal(c.backupBucket.region, 'auto');
    assert.equal(c.backupBucket.pathStyle, true);
    assert.equal(c.backupBucket.prefix, 'neo');
  });
  test('a bucket without its keys or endpoint refuses to boot and says which', () => {
    assert.throws(() => loadConfig({ ...base, NEO_BACKUP_BUCKET: 'b' }), /AWS_ENDPOINT_URL/);
    assert.throws(() => loadConfig({ ...base, NEO_BACKUP_BUCKET: 'b', AWS_ENDPOINT_URL: 'https://x' }), /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    assert.throws(() => loadConfig({ ...base, NEO_BACKUP_BUCKET: 'b', AWS_ENDPOINT_URL: 'storage.railway.app', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }), /must start with http/);
  });
});
