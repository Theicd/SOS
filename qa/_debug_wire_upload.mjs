#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

class BlobPoly {
  constructor(parts = [], opts = {}) {
    const bufs = parts.map((p) => {
      if (p instanceof Uint8Array) return Buffer.from(p);
      if (p instanceof ArrayBuffer) return Buffer.from(new Uint8Array(p));
      if (typeof p === 'string') return Buffer.from(p);
      if (p && p._buf) return Buffer.from(p._buf);
      return Buffer.from(String(p));
    });
    this._buf = Buffer.concat(bufs.length ? bufs : [Buffer.alloc(0)]);
    this.type = (opts && opts.type) || '';
    this.size = this._buf.length;
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
}

const requests = [];
async function mockFetch(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const u = String(url);
  const headersIn = init.headers || {};
  let bodyBytes = null;
  if (init.body) {
    if (typeof init.body.arrayBuffer === 'function') bodyBytes = new Uint8Array(await init.body.arrayBuffer());
    else if (init.body._buf) bodyBytes = new Uint8Array(init.body._buf);
  }
  const ct = headersIn['Content-Type'] || headersIn['content-type'] || '';
  requests.push({ u, method, ct, len: bodyBytes && bodyBytes.length });
  if (method === 'PUT' || method === 'POST') {
    if (String(ct).toLowerCase().startsWith('application/octet-stream')) {
      return { ok: false, status: 415, headers: { get: () => null }, async text() { return '415'; }, async json() { return {}; } };
    }
    if (!String(ct).toLowerCase().startsWith('image/jpeg')) {
      return { ok: false, status: 415, headers: { get: () => null }, async text() { return 'bad-ct:' + ct; }, async json() { return {}; } };
    }
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bodyBytes || new Uint8Array())).toString('hex');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return { url: 'https://blossom.test.invalid/' + hash, sha256: hash };
      },
      async text() {
        return '';
      },
    };
  }
  return { ok: false, status: 405, headers: { get: () => null }, async text() { return ''; } };
}

const aliceSk = generateSecretKey();
const alice = { pk: getPublicKey(aliceSk), hex: utils.bytesToHex(aliceSk) };
const bobSk = generateSecretKey();
const bob = { pk: getPublicKey(bobSk) };
const App = {
  publicKey: alice.pk,
  privateKey: alice.hex,
  finalizeEvent(d, k) {
    return finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? utils.hexToBytes(k) : k);
  },
};
const sandbox = {
  console: {
    log: (...a) => console.log('LOG', a.join(' ')),
    warn: (...a) => console.log('WARN', a.join(' ')),
    error: (...a) => console.log('ERR', a.join(' ')),
  },
  window: {},
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Blob: BlobPoly,
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  fetch: mockFetch,
  NostrApp: App,
  NostrTools: { finalizeEvent, utils },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('media-file-e2ee.js'), sandbox);
vm.runInContext(read('blossom.js'), sandbox);
vm.runInContext(read('media-server-e2ee.js'), sandbox);
sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;

try {
  const up = await sandbox.NostrApp.uploadMediaForServerFallback(
    new BlobPoly([new TextEncoder().encode('hi'.repeat(800))], { type: 'image/png' }),
    {
      messageId: 'cmsg-x',
      sender: alice.pk,
      recipient: bob.pk,
      mimeType: 'image/png',
      fileName: 'a.png',
      fetchImpl: mockFetch,
      skipPolicyFetch: true,
    },
  );
  console.log('OK', up.type, up.resource && up.resource.encoding);
} catch (e) {
  console.log('ERR', e.code, e.message);
}
console.log('REQS', JSON.stringify(requests.slice(0, 6), null, 2));
