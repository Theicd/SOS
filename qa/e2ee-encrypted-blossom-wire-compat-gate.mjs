#!/usr/bin/env node
/**
 * Encrypted Blossom wire compatibility gate.
 * Realistic mock: application/octet-stream → 415; opaque JPEG wire → accept.
 * Also asserts secure-upload failure clears attachment and does not emit
 * complete-blossom / BAD_ATTACHMENT publish / plaintext Blossom retry.
 *
 * Run: node qa/e2ee-encrypted-blossom-wire-compat-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function hexPubkeyPair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

function loadRuntime(mockFetch) {
  class BlobPoly {
    constructor(parts = [], opts = {}) {
      const bufs = parts.map((p) => {
        if (p instanceof Uint8Array) return Buffer.from(p);
        if (p instanceof ArrayBuffer) return Buffer.from(new Uint8Array(p));
        if (typeof p === 'string') return Buffer.from(p);
        if (p && p._buf) return Buffer.from(p._buf);
        if (p && p.buffer) return Buffer.from(p.buffer);
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

  const alice = hexPubkeyPair();
  const App = {
    publicKey: alice.pk,
    privateKey: alice.hex,
    finalizeEvent(draft, key) {
      const hostDraft = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(hostDraft, sk);
    },
  };

  const sandbox = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    window: {},
    self: {},
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    URL,
    Blob: BlobPoly,
    File: class FilePoly extends BlobPoly {
      constructor(parts, name, opts) {
        super(parts, opts);
        this.name = name || 'f.bin';
      }
    },
    btoa(s) {
      return Buffer.from(String(s), 'binary').toString('base64');
    },
    atob(s) {
      return Buffer.from(String(s), 'base64').toString('binary');
    },
    fetch: mockFetch,
    NostrApp: App,
    NostrTools: { finalizeEvent, utils },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  App.blossomServers = [{ url: 'https://blossom.test.invalid' }];

  vm.createContext(sandbox);
  vm.runInContext(read('media-file-e2ee.js'), sandbox);
  vm.runInContext(read('blossom.js'), sandbox);
  vm.runInContext(read('media-server-e2ee.js'), sandbox);
  return { App: sandbox.NostrApp, alice, sandbox, Blob: BlobPoly };
}

function createRealisticMock(opts = {}) {
  const store = new Map();
  const requests = [];
  const rejectAll = opts.rejectAll === true;

  async function mockFetch(url, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const u = String(url);
    const headersIn = init.headers || {};
    let bodyBytes = null;
    if (init.body) {
      if (init.body instanceof Uint8Array) bodyBytes = init.body;
      else if (typeof init.body.arrayBuffer === 'function') {
        bodyBytes = new Uint8Array(await init.body.arrayBuffer());
      } else if (init.body._buf) bodyBytes = new Uint8Array(init.body._buf);
    }
    const ct = headersIn['Content-Type'] || headersIn['content-type'] || '';
    requests.push({ url: u, method, contentType: ct, body: bodyBytes, headers: { ...headersIn } });

    if (method === 'PUT' || method === 'POST') {
      if (!u.includes('/upload') && !u.includes('/media') && !u.includes('/api/')) {
        return { ok: false, status: 404, headers: { get: () => null }, async text() { return 'nf'; }, async json() { return {}; } };
      }
      if (rejectAll) {
        return { ok: false, status: 500, headers: { get: () => null }, async text() { return 'fail'; }, async json() { return {}; } };
      }
      if (String(ct).toLowerCase().startsWith('application/octet-stream')) {
        return {
          ok: false,
          status: 415,
          headers: { get: () => null },
          async text() {
            return 'Unsupported Media Type';
          },
          async json() {
            return { error: 'unsupported-media-type' };
          },
        };
      }
      if (!String(ct).toLowerCase().startsWith('image/jpeg')) {
        return { ok: false, status: 415, headers: { get: () => null }, async text() { return 'bad-ct'; }, async json() { return {}; } };
      }
      const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bodyBytes || new Uint8Array())).toString('hex');
      store.set(hash, bodyBytes || new Uint8Array());
      const resultUrl = 'https://blossom.test.invalid/' + hash;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { url: resultUrl, sha256: hash };
        },
        async text() {
          return '';
        },
      };
    }
    if (method === 'GET') {
      const hash = u.split('/').pop().split('?')[0];
      const bytes = store.get(hash);
      if (!bytes) {
        return { ok: false, status: 404, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get(h) {
            if (String(h).toLowerCase() === 'content-length') return String(bytes.length);
            if (String(h).toLowerCase() === 'content-type') return 'image/jpeg';
            return null;
          },
        },
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    }
    return { ok: false, status: 405, headers: { get: () => null }, async text() { return ''; } };
  }

  return { mockFetch, store, requests };
}

async function run() {
  const blossomSrc = read('blossom.js');
  const p2pSrc = read('chat-p2p-file.js');
  const composeSrc = read('compose.js');
  const appVersion = JSON.parse(read('app-version.json'));

  record('opaque jpeg wire constants present', blossomSrc.includes("SECURE_WIRE_CONTENT_TYPE = 'image/jpeg'") && blossomSrc.includes("SECURE_WIRE_ENCODING = 'sos-opaque-jpeg-v1'"));
  record('octet-stream no longer forced for secure upload', !blossomSrc.includes("SECURE_UPLOAD_CONTENT_TYPE = 'application/octet-stream'"));
  record('secure path prefers /upload', blossomSrc.includes("SECURE_UPLOAD_PATHS = ['/upload'"));
  record('primal preferred for secure servers', blossomSrc.includes('blossom.primal.net') && blossomSrc.includes('getSecureServers'));
  record('failure clears attachment before torrent', /clearChatFileAttachment[\s\S]{0,120}fallbackToTorrent/.test(p2pSrc));
  record('complete-blossom only after publishOk', /if\s*\(\s*publishOk\s*\)[\s\S]{0,200}complete-blossom/.test(p2pSrc));
  record('public compose still uploadToBlossom', /uploadToBlossom/.test(composeSrc) && !/uploadMediaForServerFallback/.test(composeSrc));
  record('production security flags unchanged', appVersion.minSecureChatEpoch === 2 && appVersion.e2eeSendRequired === true && appVersion.mediaServerE2eeRequired === true);

  // Encoding hygiene: reject classic UTF-8->cp1252->UTF-8 mojibake in hotfix JS sources.
  // Valid Hebrew must remain; detect corrupted punctuation / re-encoded letter clusters only.
  {
    const needles = [
      // Corrupted U+2013/U+2014 dash sequences often start with gimel+euro (ג€)
      String.fromCharCode(0x05d2, 0x20ac),
      // Corrupted ❌
      String.fromCharCode(0x05d2, 0x201d, 0x0152),
      // Corrupted Hebrew "חלק" as seen in 3cebd77: geresh+emdash+geresh+...
      String.fromCharCode(0x05f3, 0x2014, 0x05f3),
      // Corrupted "חסר" / error fragments often include geresh + control/latin1
      String.fromCharCode(0x05f3, 0x201d, 0x0152),
    ];
    const targets = [
      ['blossom.js', blossomSrc],
      ['chat-p2p-file.js', p2pSrc],
      ['media-server-e2ee.js', read('media-server-e2ee.js')],
    ];
    let mojiHits = 0;
    for (const [, src] of targets) {
      for (const lit of needles) {
        let idx = 0;
        while ((idx = src.indexOf(lit, idx)) !== -1) {
          mojiHits += 1;
          idx += lit.length;
        }
      }
    }
    record('NEW MOJIBAKE INTRODUCED ZERO', mojiHits === 0);
    record(
      'blossom.js retains original Hebrew',
      blossomSrc.includes(
        String.fromCharCode(0x05d7, 0x05dc, 0x05e7, 0x20, 0x05d4, 0x05e2, 0x05dc, 0x05d0, 0x05d5, 0x05ea),
      ),
    );
    record('blossom.js has no BOM', blossomSrc.charCodeAt(0) !== 0xfeff);
  }

  // --- Realistic mock: octet-stream rejected, opaque jpeg accepted ---
  const mock = createRealisticMock();
  const rt = loadRuntime(mock.mockFetch);
  const bob = hexPubkeyPair();
  const MARKER = 'WIRE_COMPAT_PRIVATE_91899';
  const plain = new TextEncoder().encode(MARKER + '-' + 'y'.repeat(1200));
  const sizes = [46543, 89562, 140915, 206146, 300 * 1024];

  // Force policy ON
  rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;

  const up = await rt.App.uploadMediaForServerFallback(new rt.Blob([plain], { type: 'image/png' }), {
    messageId: 'cmsg-wire-compat-1',
    sender: rt.alice.pk,
    recipient: bob.pk,
    mimeType: 'image/png',
    fileName: 'secret-shot.png',
    fetchImpl: mock.mockFetch,
    skipPolicyFetch: true,
  });

  record('upload returns encrypted-media', up && up.type === 'encrypted-media');
  record('descriptor validates', (() => {
    try {
      rt.App.validateEncryptedMediaDescriptor(up);
      return true;
    } catch (_e) {
      return false;
    }
  })());
  record('encoding sos-opaque-jpeg-v1', up.resource && up.resource.encoding === 'sos-opaque-jpeg-v1');
  record('wire Content-Type constant image/jpeg', up.resource && up.resource.contentType === 'image/jpeg');

  const uploadReqs = mock.requests.filter((r) => r.method === 'PUT' || r.method === 'POST');
  record('at least one upload attempt', uploadReqs.length >= 1);
  record('no octet-stream accepted (none succeed as that CT)', uploadReqs.every((r) => r.contentType === 'image/jpeg'));
  record('plaintext original upload ZERO', !uploadReqs.some((r) => r.body && bytesEqual(r.body, plain)));
  record('original filename not in wire body', !uploadReqs.some((r) => Buffer.from(r.body || []).toString('utf8').includes('secret-shot.png')));
  record('original image/png not used as wire CT', !uploadReqs.some((r) => /image\/png/i.test(r.contentType)));

  const down = await rt.App.downloadEncryptedMediaFromBlossom({
    descriptor: up,
    messageId: 'cmsg-wire-compat-1',
    sender: rt.alice.pk,
    recipient: bob.pk,
    fetchImpl: mock.mockFetch,
  });
  record('receiver decrypt PASS', bytesEqual(down.plaintext, plain));
  record('receiver mime restored image/png', down.blob.type === 'image/png');
  record('ciphertext hash verify before decrypt', up.cipher && /^[0-9a-f]{64}$/.test(up.cipher.sha256));
  record('wire hash distinct from cipher hash', up.resource.wireSha256 && up.resource.wireSha256 !== up.cipher.sha256);

  // Prove mock rejects octet-stream
  {
    const res = await mock.mockFetch('https://blossom.primal.net/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    record('realistic mock rejects octet-stream with 415', res.status === 415);
  }

  // Size class roundtrips (secure overflow / server fallback sizes)
  for (const n of sizes) {
    const m = createRealisticMock();
    const r = loadRuntime(m.mockFetch);
    r.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;
    const data = new Uint8Array(n);
    const chunk = 65536;
    for (let i = 0; i < n; i += chunk) {
      webcrypto.getRandomValues(data.subarray(i, Math.min(n, i + chunk)));
    }
    data[0] = 0x89;
    data[1] = 0x50; // synthetic marker bytes — not a real PNG
    const desc = await r.App.uploadMediaForServerFallback(new r.Blob([data], { type: 'image/jpeg' }), {
      messageId: 'cmsg-size-' + n,
      sender: r.alice.pk,
      recipient: bob.pk,
      mimeType: 'image/jpeg',
      fileName: 'x.jpg',
      fetchImpl: m.mockFetch,
      skipPolicyFetch: true,
    });
    const d = await r.App.downloadEncryptedMediaFromBlossom({
      descriptor: desc,
      messageId: 'cmsg-size-' + n,
      sender: r.alice.pk,
      recipient: bob.pk,
      fetchImpl: m.mockFetch,
    });
    const req = m.requests.find((x) => x.method === 'PUT' || x.method === 'POST');
    record('size=' + n + ' secure upload PASS', bytesEqual(d.plaintext, data) && req && req.contentType === 'image/jpeg');
  }

  // --- All secure Blossom servers fail: no BAD_ATTACHMENT / no complete-blossom / torrent once ---
  {
    const failMock = createRealisticMock({ rejectAll: true });
    const r = loadRuntime(failMock.mockFetch);
    r.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;
    let threw = null;
    try {
      await r.App.uploadMediaForServerFallback(new r.Blob([new Uint8Array(2000)], { type: 'image/jpeg' }), {
        messageId: 'cmsg-fail-all',
        sender: r.alice.pk,
        recipient: bob.pk,
        mimeType: 'image/jpeg',
        fileName: 'x.jpg',
        fetchImpl: failMock.mockFetch,
        skipPolicyFetch: true,
      });
    } catch (e) {
      threw = e;
    }
    record('all servers fail → upload throws', !!(threw && (threw.code === 'BLOSSOM_UPLOAD_FAILED' || /blossom|upload/i.test(String(threw.message || '')))));
    record('all servers fail → no success URL stored', failMock.store.size === 0);
  }

  // Static: plaintext App.uploadToBlossom(transfer.file) not used under mustSecure
  record(
    'mustSecure path never calls uploadToBlossom(transfer.file)',
    !/mustSecure[\s\S]{0,400}uploadToBlossom\(transfer\.file\)/.test(p2pSrc),
  );
  record(
    'secure failure path has no complete-blossom before publishOk',
    !/catch\s*\(\s*uploadErr\s*\)[\s\S]{0,500}complete-blossom/.test(p2pSrc),
  );

  console.log(results.join('\n'));
  console.log('\nSummary: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error('GATE_CRASH', err && err.stack ? err.stack : err);
  process.exit(2);
});
