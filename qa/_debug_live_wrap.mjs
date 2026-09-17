#!/usr/bin/env node
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
class BlobPoly {
  constructor(parts = [], opts = {}) {
    const bufs = parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(p)));
    this._buf = Buffer.concat(bufs);
    this.type = (opts && opts.type) || '';
    this.size = this._buf.length;
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
}
const aliceSk = generateSecretKey();
const alice = { pk: getPublicKey(aliceSk), hex: utils.bytesToHex(aliceSk) };
const App = {
  publicKey: alice.pk,
  privateKey: alice.hex,
  finalizeEvent(d, k) {
    return finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? utils.hexToBytes(k) : k);
  },
};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  URL,
  Blob: BlobPoly,
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  fetch,
  NostrApp: App,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('media-file-e2ee.js'), sandbox);
vm.runInContext(read('blossom.js'), sandbox);

const cipher = webcrypto.getRandomValues(new Uint8Array(3000));
const wire = sandbox.NostrApp.__sosWrapOpaqueJpegV1(cipher);
const round = sandbox.NostrApp.__sosUnwrapOpaqueJpegV1(wire);
console.log('unwrap_ok', Buffer.from(round).equals(Buffer.from(cipher)), 'wireLen', wire.length);

const wireHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', wire)).toString('hex');
const now = Math.floor(Date.now() / 1000);
const ev = finalizeEvent(
  {
    kind: 24242,
    content: 'Upload encrypted media',
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 3600)],
      ['x', wireHash],
    ],
    created_at: now,
    pubkey: alice.pk,
  },
  aliceSk,
);
const auth = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');

for (const pathName of ['/upload', '/media']) {
  const url = 'https://blossom.primal.net' + pathName;
  const res = await fetch(url, {
    method: 'PUT',
    body: Buffer.from(wire),
    headers: { 'Content-Type': 'image/jpeg', Accept: 'application/json', Authorization: auth },
  });
  const text = await res.text();
  console.log(JSON.stringify({ path: pathName, status: res.status, prefix: text.slice(0, 160) }));
}
