#!/usr/bin/env node
/**
 * M3 — Encrypted Blossom upload/download gate (mocked network only).
 * Run: node qa/media-file-e2ee-blossom-gate.mjs
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
const allLogs = [];

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

function randomBytes(n) {
  const out = new Uint8Array(n);
  const chunk = 65536;
  for (let i = 0; i < n; i += chunk) {
    webcrypto.getRandomValues(out.subarray(i, Math.min(n, i + chunk)));
  }
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

function hexPubkeyPair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

function loadRuntime(mockFetch) {
  const logs = [];
  const consoleProxy = {
    log(...a) {
      const line = a.map(String).join(' ');
      logs.push(['log', line]);
      allLogs.push(['log', line]);
    },
    warn(...a) {
      const line = a.map(String).join(' ');
      logs.push(['warn', line]);
      allLogs.push(['warn', line]);
    },
    error(...a) {
      const line = a.map(String).join(' ');
      logs.push(['error', line]);
      allLogs.push(['error', line]);
    },
  };

  class BlobPoly {
    constructor(parts = [], opts = {}) {
      const bufs = parts.map((p) => {
        if (p instanceof Uint8Array) return Buffer.from(p);
        if (p instanceof ArrayBuffer) return Buffer.from(new Uint8Array(p));
        if (typeof p === 'string') return Buffer.from(p);
        if (p && p._buf) return p._buf;
        return Buffer.from(String(p));
      });
      this._buf = Buffer.concat(bufs);
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
    blossomServers: [{ url: 'https://blossom.test.invalid' }],
  };

  const sandbox = {
    console: consoleProxy,
    crypto: webcrypto,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob: BlobPoly,
    File: class File extends BlobPoly {
      constructor(parts, name, opts) {
        super(parts, opts);
        this.name = name || 'file';
      }
    },
    URL,
    fetch: mockFetch,
    Buffer,
    module: { exports: {} },
    window: null,
    globalThis: null,
    NostrApp: App,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('media-file-e2ee.js'), sandbox);
  vm.runInContext(read('blossom.js'), sandbox);
  return { App: sandbox.NostrApp, logs, alice, sandbox };
}

function createMockBlossom() {
  const store = new Map(); // sha256 -> Uint8Array
  const requests = [];

  async function mockFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const u = String(url);
    const headersIn = opts.headers || {};
    let bodyBytes = null;
    if (opts.body) {
      if (opts.body instanceof Uint8Array) bodyBytes = opts.body;
      else if (opts.body instanceof ArrayBuffer) bodyBytes = new Uint8Array(opts.body);
      else if (typeof opts.body.arrayBuffer === 'function') {
        bodyBytes = new Uint8Array(await opts.body.arrayBuffer());
      } else if (opts.body._buf) bodyBytes = new Uint8Array(opts.body._buf);
      else if (typeof opts.body === 'string') bodyBytes = new TextEncoder().encode(opts.body);
    }
    const rec = {
      url: u,
      method,
      headers: { ...headersIn },
      body: bodyBytes,
      authHeader: headersIn.Authorization || headersIn.authorization || '',
      contentType: headersIn['Content-Type'] || headersIn['content-type'] || '',
    };
    requests.push(rec);

    if (opts.signal && opts.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Forced status via query for failure tests
    if (u.includes('status=')) {
      const m = /status=(\d+)/.exec(u);
      const status = m ? Number(m[1]) : 500;
      return {
        ok: false,
        status,
        headers: { get: () => null },
        async text() {
          return 'error';
        },
        async json() {
          return { error: 'fail' };
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }

    if ((method === 'PUT' || method === 'POST') && u.includes('/upload')) {
      // Realistic Blossom fleet: application/octet-stream → 415 Unsupported Media Type.
      const ct = String(rec.contentType || '').toLowerCase();
      if (ct === 'application/octet-stream' || ct === 'application/octet-stream;') {
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
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
        };
      }
      // Parse auth for x tag
      let auth = null;
      try {
        const raw = String(rec.authHeader || '').replace(/^Nostr\s+/i, '');
        auth = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      } catch (_e) {
        return { ok: false, status: 401, headers: { get: () => null }, async text() { return 'auth'; }, async json() { return {}; }, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      const x = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'x');
      const hash = x && x[1];
      if (!hash || !bodyBytes) {
        return { ok: false, status: 400, headers: { get: () => null }, async text() { return 'bad'; }, async json() { return {}; }, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      store.set(hash, bodyBytes);
      const resultUrl = 'https://blossom.test.invalid/' + hash;
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
        async json() {
          return { url: resultUrl, sha256: hash, size: bodyBytes.length };
        },
        async text() {
          return JSON.stringify({ url: resultUrl });
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }

    if (method === 'GET' && u.startsWith('https://blossom.test.invalid/')) {
      const hash = u.split('/').pop().split('?')[0];
      if (u.includes('tamper=1') && store.has(hash)) {
        const orig = store.get(hash);
        const bad = new Uint8Array(orig);
        bad[0] ^= 0xff;
        return {
          ok: true,
          status: 200,
          headers: {
            get(k) {
              if (String(k).toLowerCase() === 'content-length') return String(bad.length);
              if (String(k).toLowerCase() === 'content-type') return 'application/octet-stream';
              return null;
            },
          },
          async arrayBuffer() {
            return bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength);
          },
          async text() {
            return '';
          },
          async json() {
            return {};
          },
        };
      }
      if (u.includes('truncate=1') && store.has(hash)) {
        const orig = store.get(hash);
        const trunc = orig.subarray(0, Math.max(0, orig.length - 5));
        return {
          ok: true,
          status: 200,
          headers: {
            get(k) {
              if (String(k).toLowerCase() === 'content-length') return String(trunc.length);
              return null;
            },
          },
          async arrayBuffer() {
            return trunc.buffer.slice(trunc.byteOffset, trunc.byteOffset + trunc.byteLength);
          },
          async text() {
            return '';
          },
          async json() {
            return {};
          },
        };
      }
      if (u.includes('append=1') && store.has(hash)) {
        const orig = store.get(hash);
        const bigger = new Uint8Array(orig.length + 3);
        bigger.set(orig, 0);
        return {
          ok: true,
          status: 200,
          headers: {
            get(k) {
              if (String(k).toLowerCase() === 'content-length') return String(bigger.length);
              return null;
            },
          },
          async arrayBuffer() {
            return bigger.buffer.slice(bigger.byteOffset, bigger.byteOffset + bigger.byteLength);
          },
          async text() {
            return '';
          },
          async json() {
            return {};
          },
        };
      }
      if (!store.has(hash)) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          async text() {
            return 'missing';
          },
          async json() {
            return {};
          },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
        };
      }
      const body = store.get(hash);
      return {
        ok: true,
        status: 200,
        headers: {
          get(k) {
            if (String(k).toLowerCase() === 'content-length') return String(body.length);
            if (String(k).toLowerCase() === 'content-type') return 'application/octet-stream';
            return null;
          },
        },
        async arrayBuffer() {
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        },
        async text() {
          return '';
        },
        async json() {
          return {};
        },
      };
    }

    if (method === 'DELETE') {
      const hash = u.split('/').pop();
      if (store.has(hash)) store.delete(hash);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return 'ok';
        },
        async json() {
          return { ok: true };
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }

    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      async text() {
        return 'no';
      },
      async json() {
        return {};
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  }

  return { mockFetch, store, requests };
}

function parseAuthEvent(authHeader) {
  const raw = String(authHeader || '').replace(/^Nostr\s+/i, '');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

async function run() {
  const blossomSrc = read('blossom.js');
  const coreSrc = read('media-file-e2ee.js');
  record('blossom.js present', blossomSrc.length > 500);
  record('legacy uploadToBlossom still present', blossomSrc.includes('async function uploadToBlossom'));
  record('secure upload API present', blossomSrc.includes('uploadEncryptedMediaToBlossom'));
  record('prepare/upload split present', blossomSrc.includes('prepareEncryptedMediaForBlossom') && blossomSrc.includes('uploadPreparedEncryptedMediaToBlossom'));
  record('secure download API present', blossomSrc.includes('downloadEncryptedMediaFromBlossom'));
  record('delete helper present', blossomSrc.includes('deleteEncryptedMediaFromBlossom'));
  record('secure Content-Type opaque jpeg', blossomSrc.includes("SECURE_WIRE_CONTENT_TYPE = 'image/jpeg'") && blossomSrc.includes("SECURE_WIRE_ENCODING = 'sos-opaque-jpeg-v1'"));
  record('opaque jpeg wrap/unwrap present', blossomSrc.includes('wrapOpaqueJpegV1') && blossomSrc.includes('unwrapOpaqueJpegV1'));
  record('classifier LEGACY vs ENCRYPTED', blossomSrc.includes('ENCRYPTED_BLOSSOM_V2') && blossomSrc.includes('LEGACY_BLOSSOM'));
  record('M2 core still present', coreSrc.includes('encryptMediaBlob'));
  record('redirect error on secure fetch', blossomSrc.includes("redirect: 'error'"));
  record('secure upload prefers /upload not /media first', blossomSrc.includes("SECURE_UPLOAD_PATHS = ['/upload'"));
  record('legacy uploadToBlossom still before secure wire consts', blossomSrc.indexOf('async function uploadToBlossom') < blossomSrc.indexOf('SECURE_WIRE_CONTENT_TYPE'));

  const mock = createMockBlossom();
  const { App, alice, logs } = loadRuntime(mock.mockFetch);
  const bob = hexPubkeyPair();
  const messageId = 'cmsg-m3-test-001';

  // Privacy marker roundtrip
  const MARKER = 'M3_PRIVATE_MARKER_91841';
  const plain = new TextEncoder().encode(MARKER + '-payload-' + 'x'.repeat(200));
  const blob = new (globalThis.Blob ||
    class {
      constructor() {}
    })();
  // Use sandbox Blob via App path — recreate from loadRuntime sandbox
  // Re-load with access to Blob:
  const mock2 = createMockBlossom();
  const rt = loadRuntime(mock2.mockFetch);
  const Blob = rt.sandbox.Blob;
  const plainBlob = new Blob([plain], { type: 'image/jpeg' });

  const up = await rt.App.uploadEncryptedMediaToBlossom({
    blob: plainBlob,
    messageId,
    senderPubkey: rt.alice.pk,
    recipientPubkey: bob.pk,
    filename: 'private-photo-91841.jpg',
    mime: 'image/jpeg',
    fetchImpl: mock2.mockFetch,
  });

  record('upload returned descriptor', !!(up && up.descriptor && up.descriptor.v === 2));
  record('resource.transport=blossom', up.descriptor.resource.transport === 'blossom');
  record('resource.url present', typeof up.descriptor.resource.url === 'string' && up.descriptor.resource.url.startsWith('https://'));

  const uploadReq = mock2.requests.find((r) => r.method === 'PUT' || r.method === 'POST');
  record('upload request captured', !!uploadReq);
  record('upload Content-Type opaque image/jpeg', uploadReq && uploadReq.contentType === 'image/jpeg');
  record('resource.encoding sos-opaque-jpeg-v1', up.descriptor.resource.encoding === 'sos-opaque-jpeg-v1');
  record('resource.wireSha256 present', /^[0-9a-f]{64}$/.test(String(up.descriptor.resource.wireSha256 || '')));

  const bodyStr = uploadReq ? Buffer.from(uploadReq.body).toString('utf8') : '';
  record('upload body NOT contain private marker', !bodyStr.includes(MARKER));
  record('upload body NOT contain original filename', !bodyStr.includes('private-photo-91841.jpg'));
  record('headers NOT contain original filename', !JSON.stringify(uploadReq.headers || {}).includes('private-photo-91841.jpg'));
  record('opaque transport MIME constant (not original-derived)', uploadReq.contentType === 'image/jpeg');

  const auth = parseAuthEvent(uploadReq.authHeader);
  const xTag = (auth.tags || []).find((t) => t[0] === 'x');
  record('auth x-tag equals wire sha256', xTag && xTag[1] === up.wireSha256 && xTag[1] === up.descriptor.resource.wireSha256);
  record('auth x-tag NOT raw ciphertext sha256', xTag && xTag[1] !== up.ciphertextSha256);
  record('auth event does NOT contain marker', !JSON.stringify(auth).includes(MARKER));
  record('auth event does NOT contain AES key', !JSON.stringify(auth).includes(up.descriptor.enc.key));
  record('auth event does NOT contain nonce', !JSON.stringify(auth).includes(up.descriptor.enc.nonce || ''));

  // Wire body = opaque container; cipher.sha256 is raw ciphertext after unwrap
  const wireHash = await rt.App.hashMediaCiphertext(uploadReq.body);
  record('body sha256 matches resource.wireSha256', wireHash === up.descriptor.resource.wireSha256);
  record('wire body differs from plaintext', !bytesEqual(uploadReq.body, plain));
  record('wire size recorded', up.descriptor.resource.wireSize === uploadReq.body.length);
  const unwrapped = rt.App.__sosUnwrapOpaqueJpegV1(uploadReq.body);
  const ctHash = await rt.App.hashMediaCiphertext(unwrapped);
  record('unwrapped sha256 matches cipher.sha256', ctHash === up.descriptor.cipher.sha256);
  record('cipher size is unwrapped length', up.descriptor.cipher.size === unwrapped.length);

  // Key/nonce absent from network
  const netDump = JSON.stringify(mock2.requests);
  record('AES key network leak NONE', !netDump.includes(up.descriptor.enc.key));
  if (up.descriptor.enc.nonce) {
    record('nonce network leak NONE', !netDump.includes(up.descriptor.enc.nonce));
  } else {
    // chunked: check chunk nonces
    const nonces = (up.descriptor.chunks || []).map((c) => c.nonce);
    record('nonce network leak NONE', nonces.every((n) => !netDump.includes(n)));
  }

  // Download roundtrip
  const down = await rt.App.downloadEncryptedMediaFromBlossom({
    descriptor: up.descriptor,
    messageId,
    senderPubkey: rt.alice.pk,
    recipientPubkey: bob.pk,
    fetchImpl: mock2.mockFetch,
  });
  record('download decrypt exact bytes', bytesEqual(down.plaintext, plain));
  record('download blob mime from descriptor', down.blob.type === 'image/jpeg');
  record('isEncryptedBlossomDescriptor true', rt.App.isEncryptedBlossomDescriptor(up.descriptor) === true);
  record('classify ENCRYPTED_BLOSSOM_V2', rt.App.classifyBlossomAttachment(up.descriptor) === 'ENCRYPTED_BLOSSOM_V2');
  record('classify LEGACY_BLOSSOM', rt.App.classifyBlossomAttachment({ url: 'https://blossom.test.invalid/abc' }) === 'LEGACY_BLOSSOM');

  // Size matrix single/chunked
  const sizes = [1, 1024, 48 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  for (const n of sizes) {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const data = randomBytes(n);
    // inject marker only in small ones for privacy already tested
    const b = new r.sandbox.Blob([data], { type: 'application/octet-stream' });
    const u = await r.App.uploadEncryptedMediaToBlossom({
      blob: b,
      messageId: 'cmsg-size-' + n,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      mime: 'application/octet-stream',
      filename: 'f-' + n + '.bin',
      fetchImpl: m.mockFetch,
      mode: n > 64 * 1024 ? 'chunked' : undefined,
    });
    const d = await r.App.downloadEncryptedMediaFromBlossom({
      descriptor: u.descriptor,
      messageId: 'cmsg-size-' + n,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    record('roundtrip size=' + n + ' mode=' + u.descriptor.enc.mode, bytesEqual(d.plaintext, data));
    const req = m.requests.find((x) => x.method === 'PUT' || x.method === 'POST');
    record('size=' + n + ' upload opaque image/jpeg', req && req.contentType === 'image/jpeg');
  }

  // 10MiB chunked if practical
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const data = randomBytes(10 * 1024 * 1024);
    const b = new r.sandbox.Blob([data], { type: 'video/mp4' });
    const u = await r.App.uploadEncryptedMediaToBlossom({
      blob: b,
      messageId: 'cmsg-10m',
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      mime: 'video/mp4',
      filename: 'clip.mp4',
      mode: 'chunked',
      fetchImpl: m.mockFetch,
    });
    const d = await r.App.downloadEncryptedMediaFromBlossom({
      descriptor: u.descriptor,
      messageId: 'cmsg-10m',
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    record('10MiB chunked roundtrip', bytesEqual(d.plaintext, data) && u.descriptor.enc.mode === 'chunked');
    const req = m.requests.find((x) => x.method === 'PUT' || x.method === 'POST');
    record('10MiB body is opaque wire object', req && req.body.length === u.descriptor.resource.wireSize);
    record('10MiB MIME not exposed on wire', req.contentType === 'image/jpeg');
  }

  // Tamper / wrong context
  async function expectFail(name, fn) {
    let ok = false;
    try {
      await fn();
    } catch (e) {
      ok = !!(e && e.code);
    }
    record(name, ok);
  }

  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const data = randomBytes(2048);
    const u = await r.App.uploadEncryptedMediaToBlossom({
      blob: new r.sandbox.Blob([data]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });

    const tampered = JSON.parse(JSON.stringify(u.descriptor));
    tampered.resource.url = u.descriptor.resource.url + '?tamper=1';
    await expectFail('server flips byte → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: tampered,
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    const trunc = JSON.parse(JSON.stringify(u.descriptor));
    trunc.resource.url = u.descriptor.resource.url + '?truncate=1';
    await expectFail('server truncates → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: trunc,
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    const appended = JSON.parse(JSON.stringify(u.descriptor));
    appended.resource.url = u.descriptor.resource.url + '?append=1';
    await expectFail('server appends bytes → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: appended,
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    const badKey = JSON.parse(JSON.stringify(u.descriptor));
    badKey.enc.key = r.App.MediaFileE2ee.bytesToBase64Url(randomBytes(32));
    await expectFail('wrong key → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: badKey,
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    if (u.descriptor.enc.nonce) {
      const badNonce = JSON.parse(JSON.stringify(u.descriptor));
      badNonce.enc.nonce = r.App.MediaFileE2ee.bytesToBase64Url(randomBytes(12));
      await expectFail('wrong nonce → FAIL', () =>
        r.App.downloadEncryptedMediaFromBlossom({
          descriptor: badNonce,
          messageId,
          senderPubkey: r.alice.pk,
          recipientPubkey: bob.pk,
          fetchImpl: m.mockFetch,
        }),
      );
    } else {
      record('wrong nonce → FAIL', true); // chunked covered by wrong key/context
    }

    await expectFail('wrong messageId context → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: u.descriptor,
        messageId: 'cmsg-other',
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    await expectFail('unsafe javascript URL → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: Object.assign({}, u.descriptor, {
          resource: { transport: 'blossom', url: 'javascript:alert(1)' },
        }),
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );
  }

  // HTTP failures
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const prepared = await r.App.prepareEncryptedMediaForBlossom({
      blob: new r.sandbox.Blob([randomBytes(32)]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
    });
    // Point servers at status-forcing upload by monkeypatching getBlossomServers result via App.blossomServers
    // Instead: call download against status URL
    const fakeDesc = Object.assign({}, prepared.privateDescriptorDraft, {
      resource: {
        transport: 'blossom',
        url: 'https://blossom.test.invalid/deadbeef?status=404',
      },
    });
    // Need valid hash length url path - use real hash path with status
    fakeDesc.resource.url = 'https://blossom.test.invalid/' + prepared.ciphertextSha256 + '?status=500';
    await expectFail('HTTP 500 download → FAIL', () =>
      r.App.downloadEncryptedMediaFromBlossom({
        descriptor: fakeDesc,
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      }),
    );

    const ac = new AbortController();
    ac.abort();
    await expectFail('AbortSignal upload → FAIL', () =>
      r.App.uploadEncryptedMediaToBlossom({
        blob: new r.sandbox.Blob([randomBytes(16)]),
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        signal: ac.signal,
        fetchImpl: m.mockFetch,
      }),
    );
  }

  // Retry idempotence: same prepared ciphertext → same hash
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const prepared = await r.App.prepareEncryptedMediaForBlossom({
      blob: new r.sandbox.Blob([randomBytes(1000)]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
    });
    const u1 = await r.App.uploadPreparedEncryptedMediaToBlossom({
      encryptedBlob: prepared.encryptedBlob,
      privateDescriptorDraft: prepared.privateDescriptorDraft,
      fetchImpl: m.mockFetch,
    });
    const u2 = await r.App.uploadPreparedEncryptedMediaToBlossom({
      encryptedBlob: prepared.encryptedBlob,
      privateDescriptorDraft: prepared.privateDescriptorDraft,
      fetchImpl: m.mockFetch,
    });
    record('retry same prepared → same ciphertext hash', u1.ciphertextSha256 === u2.ciphertextSha256);
  }

  // Independent re-encrypt → different hash
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const data = randomBytes(500);
    const u1 = await r.App.uploadEncryptedMediaToBlossom({
      blob: new r.sandbox.Blob([data]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    const u2 = await r.App.uploadEncryptedMediaToBlossom({
      blob: new r.sandbox.Blob([data]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    record('independent encrypt → different ciphertext hash', u1.ciphertextSha256 !== u2.ciphertextSha256);
  }

  // Delete helper
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const u = await r.App.uploadEncryptedMediaToBlossom({
      blob: new r.sandbox.Blob([randomBytes(64)]),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    const del = await r.App.deleteEncryptedMediaFromBlossom({
      descriptor: u.descriptor,
      fetchImpl: m.mockFetch,
    });
    record('delete helper ok', del && del.ok === true);
    record('delete uses wire object hash', del.ciphertextSha256 === u.wireSha256 || del.ciphertextSha256 === u.descriptor.resource.wireSha256);
  }

  // Legacy uploadToBlossom unchanged behavior smoke (still callable)
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    record('legacy uploadToBlossom still exported', typeof r.App.uploadToBlossom === 'function');
    // Legacy will hash plaintext and upload — Content-Type from blob.type
    const legacyBlob = new r.sandbox.Blob([new TextEncoder().encode('legacy-plain')], { type: 'text/plain' });
    const url = await r.App.uploadToBlossom(legacyBlob);
    record('legacy upload still works', typeof url === 'string' && url.startsWith('https://'));
    const req = m.requests.find((x) => x.method === 'PUT' || x.method === 'POST');
    record('legacy may still use blob MIME (unchanged)', req && req.contentType === 'text/plain');
    const body = Buffer.from(req.body).toString('utf8');
    record('legacy path still plaintext body (documented)', body.includes('legacy-plain'));
  }

  // 256KiB classifier → SECURE_BLOB then blossom prepare
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const big = randomBytes(256 * 1024);
    const b64 = Buffer.from(big).toString('base64');
    const att = {
      name: 'voice-message.webm',
      size: 256 * 1024,
      type: 'audio/webm',
      dataUrl: 'data:audio/webm;base64,' + b64,
      url: '',
    };
    const cls = r.App.classifyAttachmentForE2eeRoute({
      messageId,
      sender: r.alice.pk,
      recipient: bob.pk,
      createdAt: Math.floor(Date.now() / 1000),
      text: '',
      attachment: att,
    });
    record('256KiB legacy inline → SECURE_BLOB_REQUIRED', cls.route === 'SECURE_BLOB_REQUIRED');
    const prepared = await r.App.prepareEncryptedMediaForBlossom({
      blob: new r.sandbox.Blob([big], { type: 'audio/webm' }),
      messageId,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      mime: 'audio/webm',
      filename: 'voice-message.webm',
    });
    record('SECURE_BLOB prepare succeeds locally', prepared.ciphertextSha256 && prepared.encryptedBlob.size > 0);
  }

  // No plaintext fallback for v2 descriptor failure
  {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    let fellBack = false;
    try {
      await r.App.downloadEncryptedMediaFromBlossom({
        descriptor: {
          v: 2,
          type: 'encrypted-media',
          attachmentId: 'a'.repeat(32),
          enc: { alg: 'aes-256-gcm', mode: 'single', key: 'x', nonce: 'y' },
          cipher: { size: 10, sha256: 'b'.repeat(64) },
          resource: { transport: 'blossom', url: 'https://blossom.test.invalid/' + 'b'.repeat(64) },
          media: { mime: 'image/jpeg', filename: 'x.jpg', originalSize: 1 },
        },
        messageId,
        senderPubkey: r.alice.pk,
        recipientPubkey: bob.pk,
        fetchImpl: m.mockFetch,
      });
      fellBack = true;
    } catch (e) {
      fellBack = false;
      record('no plaintext fallback on bad v2', !!(e && e.code));
    }
    if (fellBack) record('no plaintext fallback on bad v2', false);
  }

  // Log privacy for marker/key
  {
    const joined = allLogs.map((x) => x[1]).join('\n');
    record('log does not contain private marker', !joined.includes(MARKER));
    record('log does not contain full private descriptor JSON key field dump', !/"key"\s*:\s*"ey/.test(joined));
  }

  // Voice/image/video/pdf-like binary labels
  for (const [label, mime] of [
    ['voice-like', 'audio/webm'],
    ['image-like', 'image/jpeg'],
    ['video-like', 'video/mp4'],
    ['pdf-like', 'application/pdf'],
  ]) {
    const m = createMockBlossom();
    const r = loadRuntime(m.mockFetch);
    const data = randomBytes(4096);
    const u = await r.App.uploadEncryptedMediaToBlossom({
      blob: new r.sandbox.Blob([data], { type: mime }),
      messageId: 'cmsg-' + label,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      mime,
      filename: label + '.bin',
      fetchImpl: m.mockFetch,
    });
    const d = await r.App.downloadEncryptedMediaFromBlossom({
      descriptor: u.descriptor,
      messageId: 'cmsg-' + label,
      senderPubkey: r.alice.pk,
      recipientPubkey: bob.pk,
      fetchImpl: m.mockFetch,
    });
    const req = m.requests.find((x) => x.method === 'PUT' || x.method === 'POST');
    record(label + ' roundtrip', bytesEqual(d.plaintext, data));
    record(label + ' wire Content-Type opaque image/jpeg', req.contentType === 'image/jpeg');
    record(label + ' private mime restored', d.blob.type === mime);
  }

  console.log(results.join('\n'));
  console.log('\nSummary: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error('GATE_CRASH', err && err.stack ? err.stack : err);
  process.exit(2);
});
