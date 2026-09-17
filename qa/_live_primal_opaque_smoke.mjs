#!/usr/bin/env node
/** Live synthetic smoke: opaque JPEG wire → blossom.primal.net/upload only. */
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
const bob = { pk: getPublicKey(generateSecretKey()) };
const App = {
  publicKey: alice.pk,
  privateKey: alice.hex,
  blossomServers: [{ url: 'https://blossom.primal.net' }],
  finalizeEvent(d, k) {
    return finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? utils.hexToBytes(k) : k);
  },
};
const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  URL,
  Blob: globalThis.Blob,
  File: globalThis.File,
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  fetch,
  NostrApp: App,
  NostrTools: { finalizeEvent, utils },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('media-file-e2ee.js'), sandbox);
vm.runInContext(read('blossom.js'), sandbox);

const sizes = [1024, 140915];
for (const n of sizes) {
  const plain = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(plain.subarray(i, Math.min(n, i + 65536)));
  plain[0] = 0xab;
  plain[1] = 0xcd;
  const up = await sandbox.NostrApp.uploadEncryptedMediaToBlossom({
    blob: new Blob([plain], { type: 'image/png' }),
    messageId: 'cmsg-live-' + n,
    senderPubkey: alice.pk,
    recipientPubkey: bob.pk,
    mime: 'image/png',
    filename: 'synth.png',
  });
  const down = await sandbox.NostrApp.downloadEncryptedMediaFromBlossom({
    descriptor: up.descriptor,
    messageId: 'cmsg-live-' + n,
    senderPubkey: alice.pk,
    recipientPubkey: bob.pk,
  });
  let match = down.plaintext.length === plain.length;
  if (match) {
    for (let i = 0; i < plain.length; i += 1) {
      if (down.plaintext[i] !== plain[i]) {
        match = false;
        break;
      }
    }
  }
  console.log(
    JSON.stringify({
      size: n,
      ok: match,
      encoding: up.descriptor.resource.encoding,
      contentType: up.descriptor.resource.contentType,
      host: up.descriptor.resource.host,
      urlHost: new URL(up.descriptor.resource.url).hostname,
    }),
  );
}
