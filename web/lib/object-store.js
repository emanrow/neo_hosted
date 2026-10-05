'use strict';

// A copy of each daily zip in an S3-compatible bucket, so a writer's words
// survive the loss of the volume. Only PUT is needed, so this is Signature
// Version 4 over node:crypto and fetch rather than an SDK: Railway's buckets,
// AWS S3, Cloudflare R2 and MinIO all take it.
//
// Keys are `<prefix>/<writer id>/neo-backup-YYYY-MM-DD.zip`. Nothing is ever
// deleted from the bucket by this code; a lifecycle rule on the bucket is the
// place to expire old zips.

const crypto = require('node:crypto');

const SERVICE = 's3';
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one path segment, as S3 canonicalizes it (`~` kept, `/` encoded). */
const encodeSegment = (segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** `20260105T131500Z` and `20260105` for the signing headers. */
function amzDates(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: stamp, dateOnly: stamp.slice(0, 8) };
}

/**
 * The headers of one SigV4-signed request, given its pieces. Pure, so a test
 * can check a known vector. `headers` must include `host`.
 */
function signRequest({ method, path: canonicalPath, headers, payloadHash, region, accessKeyId, secretAccessKey, now = new Date() }) {
  const { amzDate, dateOnly } = amzDates(now);
  const signed = {};
  for (const [name, value] of Object.entries({ ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash })) {
    signed[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((h) => `${h}:${signed[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateOnly}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateOnly), region), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  signed.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return signed;
}

/**
 * @param {{ bucket: string, endpoint: string, region: string, accessKeyId: string, secretAccessKey: string, prefix?: string, pathStyle?: boolean, fetch?: typeof fetch }} options
 *   `endpoint` is the service's base address (`https://storage.railway.app`);
 *   virtual-hosted addressing (`https://<bucket>.<host>/<key>`) is the default,
 *   `pathStyle` puts the bucket on the path instead (MinIO on a laptop).
 * @returns {{ enabled: true, bucket: string, put(key: string, body: Buffer, contentType?: string): Promise<void>, urlFor(key: string): URL }}
 */
function createObjectStore({ bucket, endpoint, region, accessKeyId, secretAccessKey, prefix = '', pathStyle = false, fetch: doFetch = globalThis.fetch }) {
  for (const [name, value] of Object.entries({ bucket, endpoint, region, accessKeyId, secretAccessKey })) {
    if (!value) throw new Error(`object store: ${name} is required`);
  }
  const base = new URL(endpoint);
  const keyPrefix = prefix.replace(/^\/+|\/+$/g, '');

  function urlFor(key) {
    const full = (keyPrefix ? `${keyPrefix}/` : '') + key;
    const segments = full.split('/').map(encodeSegment);
    const url = new URL(base.toString());
    if (pathStyle) url.pathname = `/${encodeSegment(bucket)}/${segments.join('/')}`;
    else { url.hostname = `${bucket}.${base.hostname}`; url.pathname = `/${segments.join('/')}`; }
    return url;
  }

  async function put(key, body, contentType = 'application/octet-stream') {
    const url = urlFor(key);
    const headers = signRequest({
      method: 'PUT',
      path: url.pathname,
      headers: { host: url.host, 'content-type': contentType, 'content-length': String(body.length) },
      payloadHash: sha256(body),
      region, accessKeyId, secretAccessKey
    });
    const res = await doFetch(url, { method: 'PUT', headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`object store: PUT ${key} answered ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    }
  }

  return { enabled: true, bucket, put, urlFor };
}

/** What stands in for the store when no bucket is configured. */
const NO_OBJECT_STORE = { enabled: false, bucket: '', put: async () => {}, urlFor: () => null };

module.exports = { createObjectStore, signRequest, sha256, NO_OBJECT_STORE, EMPTY_HASH };
