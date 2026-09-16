#!/usr/bin/env node
/**
 * Hotfix gate: E3B inline media overflow → secure server fallback.
 * Physical repro sizes: 36599 (PASS inline) / 89562 (SECURE_BLOB_REQUIRED).
 * Run: node qa/e2ee-inline-media-overflow-gate.mjs
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

function randomBytes(n) {
  const out = new Uint8Array(n);
  const chunk = 65536;
  for (let i = 0; i < n; i += chunk) {
    webcrypto.getRandomValues(out.subarray(i, Math.min(n, i + chunk)));
  }
  return out;
}

function hexPubkeyPair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

function bytesToDataUrl(bytes, mime) {
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${b64}`;
}

class BlobPoly {
  constructor(parts, options) {
    const chunks = [];
    for (const p of parts || []) {
      if (p instanceof Uint8Array) chunks.push(p);
      else if (p instanceof ArrayBuffer) chunks.push(new Uint8Array(p));
      else if (typeof p === 'string') chunks.push(Buffer.from(p, 'utf8'));
      else if (p && p.buffer) chunks.push(new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength || p.length));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this._bytes = merged;
    this.size = merged.length;
    this.type = (options && options.type) || '';
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(
      this._bytes.byteOffset,
      this._bytes.byteOffset + this._bytes.byteLength,
    );
  }
  slice(start, end, type) {
    const s = start || 0;
    const e = end == null ? this._bytes.length : end;
    return new BlobPoly([this._bytes.subarray(s, e)], { type: type || this.type });
  }
}

function loadRuntime() {
  let legacyUploadCalls = 0;
  let secureUploadCalls = 0;
  let serverFallbackCalls = 0;
  let encryptFailureSignals = 0;
  let inlineEncryptAttempts = 0;
  let e3bDescriptorPublishes = 0;
  const networkBodies = [];
  const networkHeaders = [];

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'PUT' || method === 'POST') {
      const body = init.body;
      let bytes = new Uint8Array(0);
      if (body instanceof Uint8Array) bytes = body;
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
      else if (body && typeof body.arrayBuffer === 'function') {
        bytes = new Uint8Array(await body.arrayBuffer());
      } else if (typeof body === 'string') {
        bytes = new Uint8Array(Buffer.from(body, 'binary'));
      }
      networkBodies.push(bytes);
      networkHeaders.push(init.headers || {});
      const hash = await webcrypto.subtle.digest('SHA-256', bytes);
      const hex = Buffer.from(new Uint8Array(hash)).toString('hex');
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'x-sha-256' ? hex : null) },
        async json() {
          return { sha256: hex, url: `https://blossom.test.invalid/${hex}` };
        },
        async text() {
          return '';
        },
      };
    }
    if (method === 'GET' && /app-version\.json/i.test(u)) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            version: '2026.09.16-media-inline-hotfix1',
            minSecureChatEpoch: 2,
            e2eeSendRequired: true,
            mediaServerE2eeRequired: true,
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, async text() { return ''; } };
  };

  const sender = hexPubkeyPair();
  const recipient = hexPubkeyPair();
  const AppSeed = {
    publicKey: sender.pk,
    privateKey: sender.hex,
    finalizeEvent(draft, key) {
      const hostDraft = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(hostDraft, sk);
    },
    blossomServers: [{ url: 'https://blossom.test.invalid' }],
  };

  const sandbox = {
    console: {
      log() {},
      warn(...args) {
        const s = args.map(String).join(' ');
        if (/ENCRYPT_FAILURE|e2ee-encrypt-failed/i.test(s)) encryptFailureSignals += 1;
      },
      error() {},
    },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Buffer,
    Blob: BlobPoly,
    File: class File extends BlobPoly {
      constructor(parts, name, o) {
        super(parts, o);
        this.name = name || 'f.bin';
      }
    },
    URL,
    fetch: mockFetch,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null;
      },
      setItem(k, v) {
        this._m.set(k, String(v));
      },
      removeItem(k) {
        this._m.delete(k);
      },
    },
    setTimeout,
    clearTimeout,
    window: null,
    globalThis: null,
    NostrApp: AppSeed,
    module: { exports: {} },
    exports: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;
  sandbox.URL.createObjectURL = () => 'blob:mock-' + Math.random().toString(36).slice(2);
  sandbox.URL.revokeObjectURL = () => {};

  vm.createContext(sandbox);
  vm.runInContext(read('media-file-e2ee.js'), sandbox);
  vm.runInContext(read('blossom.js'), sandbox);
  vm.runInContext(read('media-server-e2ee.js'), sandbox);
  const App = sandbox.NostrApp;

  const legacy = App.uploadToBlossom.bind(App);
  App.uploadToBlossom = async function (...args) {
    legacyUploadCalls += 1;
    return legacy(...args);
  };
  const secure = App.uploadEncryptedMediaToBlossom.bind(App);
  App.uploadEncryptedMediaToBlossom = async function (...args) {
    secureUploadCalls += 1;
    return secure(...args);
  };
  const fallback = App.uploadMediaForServerFallback.bind(App);
  App.uploadMediaForServerFallback = async function (...args) {
    serverFallbackCalls += 1;
    return fallback(...args);
  };

  // Simulate "would attempt inline E3B encrypt" — only when route stays INLINE with dataUrl.
  App.__qaSimulateInlineEncrypt = function (attachment) {
    if (attachment && typeof attachment.dataUrl === 'string' && attachment.dataUrl) {
      inlineEncryptAttempts += 1;
      if (typeof App.classifyAttachmentForE2eeRoute === 'function') {
        const cls = App.classifyAttachmentForE2eeRoute({
          messageId: attachment.clientMessageId || 'cmsg-sim',
          sender: App.publicKey,
          recipient: recipient.pk,
          createdAt: Math.floor(Date.now() / 1000),
          text: '',
          attachment,
        });
        if (cls.route !== 'INLINE_E2EE_SAFE') {
          encryptFailureSignals += 1;
          const e = new Error('ENCRYPT_FAILURE');
          e.code = 'ENCRYPT_FAILURE';
          throw e;
        }
      }
      e3bDescriptorPublishes += 1;
      return { ok: true, mode: 'inline-dataurl' };
    }
    if (attachment && attachment.type === 'encrypted-media') {
      e3bDescriptorPublishes += 1;
      return { ok: true, mode: 'encrypted-media' };
    }
    return { ok: false };
  };

  return {
    App,
    sender,
    recipient,
    counts() {
      return {
        legacyUploadCalls,
        secureUploadCalls,
        serverFallbackCalls,
        encryptFailureSignals,
        inlineEncryptAttempts,
        e3bDescriptorPublishes,
        networkBodies,
        networkHeaders,
      };
    },
    reset() {
      legacyUploadCalls = 0;
      secureUploadCalls = 0;
      serverFallbackCalls = 0;
      encryptFailureSignals = 0;
      inlineEncryptAttempts = 0;
      e3bDescriptorPublishes = 0;
      networkBodies.length = 0;
      networkHeaders.length = 0;
    },
  };
}

function makeInlineAttachment(bytes, mime, name, extra = {}) {
  return {
    id: 'att-' + name,
    fileId: 'att-' + name,
    name,
    size: bytes.length,
    type: mime,
    dataUrl: bytesToDataUrl(bytes, mime),
    url: '',
    hidePreview: true,
    ...extra,
  };
}

async function main() {
  const ui = read('chat-file-transfer-ui.js');
  const voice = read('chat-voice-service.js');
  const server = read('media-server-e2ee.js');
  const compose = read('compose.js');
  const mirror = read('media-mirror.js');

  record(
    'P2P_PREFERRED_FROM_BYTES=90KiB unchanged',
    /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(ui),
  );
  record(
    'MAX_INLINE_SIZE_BYTES=256KiB unchanged',
    /MAX_INLINE_SIZE_BYTES\s*=\s*256\s*\*\s*1024/.test(ui),
  );
  record(
    'voice MAX_INLINE_BYTES=256KiB unchanged',
    /MAX_INLINE_BYTES\s*=\s*256\s*\*\s*1024/.test(voice),
  );
  record(
    'UI uses resolveInlineAttachmentForE2ee',
    /resolveInlineAttachmentForE2ee/.test(ui),
  );
  record(
    'voice uses resolveInlineAttachmentForE2ee',
    /resolveInlineAttachmentForE2ee/.test(voice),
  );
  record(
    'helper resolveInlineAttachmentForE2ee present',
    /function resolveInlineAttachmentForE2ee/.test(server),
  );
  record('compose.js unchanged path (no helper)', !/resolveInlineAttachmentForE2ee/.test(compose));
  record(
    'compose still uploadToBlossom / no server-fallback',
    /uploadToBlossom/.test(compose) && !/uploadMediaForServerFallback/.test(compose),
  );
  record(
    'media-mirror unchanged (no server-fallback helper)',
    /uploadToBlossom/.test(mirror) && !/uploadMediaForServerFallback/.test(mirror),
  );

  const rt = loadRuntime();
  const { App, sender, recipient } = rt;
  const messageId = 'cmsg-overflow-qa-1';
  const createdAt = Math.floor(Date.now() / 1000);

  // --- Physical repro sizes ---
  const imgA = randomBytes(36599);
  const imgB = randomBytes(89562);
  const attA = makeInlineAttachment(imgA, 'image/jpeg', 'photo-a.jpg');
  const attB = makeInlineAttachment(imgB, 'image/jpeg', 'photo-b.jpg');

  const clsA = App.classifyAttachmentForE2eeRoute({
    messageId,
    sender: sender.pk,
    recipient: recipient.pk,
    createdAt,
    text: '',
    attachment: attA,
  });
  record('36599 classify INLINE_E2EE_SAFE', clsA.route === 'INLINE_E2EE_SAFE', clsA.route + ' bytes=' + clsA.utf8Bytes);

  const clsB = App.classifyAttachmentForE2eeRoute({
    messageId,
    sender: sender.pk,
    recipient: recipient.pk,
    createdAt,
    text: '',
    attachment: attB,
  });
  record(
    '89562 classify SECURE_BLOB_REQUIRED',
    clsB.route === 'SECURE_BLOB_REQUIRED',
    clsB.route + ' bytes=' + clsB.utf8Bytes,
  );

  // IMAGE A path: resolve stays inline, no secure upload
  rt.reset();
  const resA = await App.resolveInlineAttachmentForE2ee({
    attachment: { ...attA },
    blob: new BlobPoly([imgA], { type: 'image/jpeg' }),
    messageId: 'cmsg-a',
    sender: sender.pk,
    recipient: recipient.pk,
    text: '',
    skipPolicyFetch: true,
  });
  record('36599 resolve route INLINE_E2EE_SAFE', resA.route === 'INLINE_E2EE_SAFE');
  record('36599 secure Blossom upload=0', rt.counts().serverFallbackCalls === 0);
  const pubA = App.__qaSimulateInlineEncrypt(resA.attachment);
  record('36599 Relay E3B publish=1', pubA.ok && rt.counts().e3bDescriptorPublishes === 1);
  record('36599 ENCRYPT_FAILURE=0', rt.counts().encryptFailureSignals === 0);
  record('36599 plaintext Blossom=0', rt.counts().legacyUploadCalls === 0);

  // IMAGE B path: secure fallback, no inline encrypt attempt
  rt.reset();
  const resB = await App.resolveInlineAttachmentForE2ee({
    attachment: { ...attB },
    blob: new BlobPoly([imgB], { type: 'image/jpeg' }),
    messageId: 'cmsg-b',
    sender: sender.pk,
    recipient: recipient.pk,
    text: '',
    skipPolicyFetch: true,
  });
  record('89562 resolve SECURE_BLOB_REQUIRED', resB.route === 'SECURE_BLOB_REQUIRED');
  record('89562 uploadMediaForServerFallback=1', rt.counts().serverFallbackCalls === 1);
  record('89562 plaintext Blossom=0', rt.counts().legacyUploadCalls === 0);
  record(
    '89562 attachment encrypted-media',
    resB.attachment && resB.attachment.type === 'encrypted-media',
  );
  record('89562 stable messageId', resB.messageId === 'cmsg-b' && resB.attachment.logicalMessageId === 'cmsg-b');
  record('89562 no dataUrl on wire attachment', !resB.attachment.dataUrl);
  // Must NOT attempt inline dataURL encrypt
  let inlineAttempted = false;
  try {
    if (resB.attachment && resB.attachment.dataUrl) {
      inlineAttempted = true;
      App.__qaSimulateInlineEncrypt(resB.attachment);
    }
  } catch (_e) {
    inlineAttempted = true;
  }
  record('89562 inline encrypt attempt=0', !inlineAttempted && rt.counts().inlineEncryptAttempts === 0);
  record('89562 ENCRYPT_FAILURE=0', rt.counts().encryptFailureSignals === 0);
  const pubB = App.__qaSimulateInlineEncrypt(resB.attachment);
  record('89562 encrypted-media E3B publish=1', pubB.ok && pubB.mode === 'encrypted-media');

  // Server body / content-type / hash / key leak
  const cB = rt.counts();
  const body = cB.networkBodies[0];
  const headers = cB.networkHeaders[0] || {};
  const ct =
    headers['Content-Type'] ||
    headers['content-type'] ||
    (typeof headers.get === 'function' ? headers.get('Content-Type') : '');
  record('server body present', !!(body && body.length > 0));
  // Ciphertext should not equal plaintext JPEG magic as sole content — compare to imgB
  let plaintextMatch = false;
  if (body && body.length === imgB.length) {
    plaintextMatch = Buffer.from(body).equals(Buffer.from(imgB));
  }
  record('server body not plaintext bytes', !plaintextMatch);
  record(
    'server Content-Type octet-stream (or unset mock)',
    !ct || /octet-stream/i.test(String(ct)),
  );
  const keyLeak =
    JSON.stringify(resB.attachment).includes(resB.attachment.enc?.key) === false
      ? false
      : String(JSON.stringify(cB)).includes(resB.attachment.enc?.key);
  // Key may be in descriptor object (private) but must not appear in network mock URL path alone —
  // stronger: ensure network body is not UTF-8 containing key
  const bodyText = body ? Buffer.from(body).toString('utf8') : '';
  record(
    'AES key not in network body',
    !resB.attachment.enc?.key || !bodyText.includes(resB.attachment.enc.key),
  );
  record(
    'nonce not in network body',
    !resB.attachment.enc?.nonce || !bodyText.includes(resB.attachment.enc.nonce),
  );

  // Caption-aware: same bytes inline-safe without caption may overflow with long caption
  // Find a size that is INLINE with empty text but SECURE with large caption.
  let captionAware = false;
  for (let n = 20000; n < 50000; n += 500) {
    const bytes = randomBytes(n);
    const att = makeInlineAttachment(bytes, 'image/jpeg', 'cap.jpg');
    const empty = App.classifyAttachmentForE2eeRoute({
      messageId: 'cmsg-cap',
      sender: sender.pk,
      recipient: recipient.pk,
      createdAt,
      text: '',
      attachment: att,
    });
    const longCap = 'x'.repeat(8000);
    const withCap = App.classifyAttachmentForE2eeRoute({
      messageId: 'cmsg-cap',
      sender: sender.pk,
      recipient: recipient.pk,
      createdAt,
      text: longCap,
      attachment: att,
    });
    if (empty.route === 'INLINE_E2EE_SAFE' && withCap.route === 'SECURE_BLOB_REQUIRED') {
      captionAware = true;
      rt.reset();
      const rCap = await App.resolveInlineAttachmentForE2ee({
        attachment: { ...att, caption: longCap },
        blob: new BlobPoly([bytes], { type: 'image/jpeg' }),
        messageId: 'cmsg-cap-stable',
        sender: sender.pk,
        recipient: recipient.pk,
        text: longCap,
        skipPolicyFetch: true,
      });
      record(
        'caption overflow → SECURE_BLOB_REQUIRED',
        rCap.route === 'SECURE_BLOB_REQUIRED' && rt.counts().serverFallbackCalls === 1,
      );
      record('caption overflow stable messageId', rCap.messageId === 'cmsg-cap-stable');
      break;
    }
  }
  record('caption-aware preflight demonstrated', captionAware);

  // Dynamic boundary around NIP-44 limit for image/jpeg
  let lastSafe = null;
  let firstUnsafe = null;
  for (let n = 30000; n <= 100000; n += 256) {
    const bytes = randomBytes(n);
    const att = makeInlineAttachment(bytes, 'image/jpeg', 'bound.jpg');
    const cls = App.classifyAttachmentForE2eeRoute({
      messageId: 'cmsg-bound',
      sender: sender.pk,
      recipient: recipient.pk,
      createdAt,
      text: '',
      attachment: att,
    });
    if (cls.route === 'INLINE_E2EE_SAFE') lastSafe = { n, utf8: cls.utf8Bytes };
    else if (cls.route === 'SECURE_BLOB_REQUIRED' && firstUnsafe == null) {
      firstUnsafe = { n, utf8: cls.utf8Bytes };
      break;
    }
  }
  record('dynamic boundary found', !!(lastSafe && firstUnsafe), JSON.stringify({ lastSafe, firstUnsafe }));
  if (lastSafe && firstUnsafe) {
    const sizes = [lastSafe.n - 1, lastSafe.n, firstUnsafe.n].filter((x) => x > 0);
    for (const n of sizes) {
      const bytes = randomBytes(n);
      const att = makeInlineAttachment(bytes, 'image/jpeg', 'edge.jpg');
      const cls = App.classifyAttachmentForE2eeRoute({
        messageId: 'cmsg-edge',
        sender: sender.pk,
        recipient: recipient.pk,
        createdAt,
        text: '',
        attachment: att,
      });
      const expect =
        n <= lastSafe.n ? 'INLINE_E2EE_SAFE' : 'SECURE_BLOB_REQUIRED';
      // at exact lastSafe.n should be INLINE; firstUnsafe.n SECURE
      if (n === lastSafe.n) {
        record('boundary safe size INLINE', cls.route === 'INLINE_E2EE_SAFE', 'n=' + n);
      } else if (n === firstUnsafe.n) {
        record('boundary unsafe size SECURE', cls.route === 'SECURE_BLOB_REQUIRED', 'n=' + n);
      } else if (n === lastSafe.n - 1) {
        record('boundary safe-1 INLINE', cls.route === 'INLINE_E2EE_SAFE', 'n=' + n);
      }
    }
  }

  // Representative sizes × MIME
  const probeSizes = [40 * 1024, 48 * 1024, 64 * 1024, 90 * 1024, 256 * 1024];
  const probeMimes = [
    ['image/jpeg', 'p.jpg'],
    ['audio/webm', 'voice-message.webm'],
    ['video/mp4', 'clip.mp4'],
    ['application/octet-stream', 'doc.bin'],
  ];
  for (const [mime, name] of probeMimes) {
    for (const n of probeSizes) {
      const bytes = randomBytes(n);
      const att = makeInlineAttachment(bytes, mime, name);
      const cls = App.classifyAttachmentForE2eeRoute({
        messageId: 'cmsg-probe',
        sender: sender.pk,
        recipient: recipient.pk,
        createdAt,
        text: '',
        attachment: att,
      });
      record(
        `probe ${mime} ${n}B → ${cls.route}`,
        cls.route === 'INLINE_E2EE_SAFE' ||
          cls.route === 'SECURE_BLOB_REQUIRED' ||
          cls.route === 'REJECT_TOO_LARGE',
      );
    }
  }

  // Generic overflow → GENERIC_ALTERNATE_REQUIRED (no Blossom invent)
  rt.reset();
  const genBytes = randomBytes(89562);
  const genAtt = makeInlineAttachment(genBytes, 'application/octet-stream', 'notes.bin');
  const resGen = await App.resolveInlineAttachmentForE2ee({
    attachment: genAtt,
    blob: new BlobPoly([genBytes], { type: 'application/octet-stream' }),
    messageId: 'cmsg-gen',
    sender: sender.pk,
    recipient: recipient.pk,
    text: '📎 notes.bin',
    skipPolicyFetch: true,
  });
  record('generic overflow → GENERIC_ALTERNATE_REQUIRED', resGen.route === 'GENERIC_ALTERNATE_REQUIRED');
  record('generic overflow no Blossom upload', rt.counts().serverFallbackCalls === 0 && rt.counts().legacyUploadCalls === 0);

  // Voice-sized webm near physical cliff
  rt.reset();
  const voiceBytes = randomBytes(89562);
  const voiceAtt = makeInlineAttachment(voiceBytes, 'audio/webm', 'voice-message.webm', {
    duration: 8,
    isVoice: true,
  });
  const resV = await App.resolveInlineAttachmentForE2ee({
    attachment: voiceAtt,
    blob: new BlobPoly([voiceBytes], { type: 'audio/webm' }),
    messageId: 'cmsg-voice',
    sender: sender.pk,
    recipient: recipient.pk,
    text: '',
    duration: 8,
    skipPolicyFetch: true,
  });
  record(
    'voice 89562 → SECURE encrypted-media',
    resV.route === 'SECURE_BLOB_REQUIRED' && resV.attachment?.type === 'encrypted-media',
  );
  record('voice overflow plaintext Blossom=0', rt.counts().legacyUploadCalls === 0);

  // P2P threshold static still preferred (routing constants)
  record(
    'P2P preferred threshold still 92160',
    /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(ui),
  );
  record(
    'UI still prefers P2P when DC connected OR size>90KiB',
    /shouldPreferP2P\s*=\s*file\.size\s*>\s*P2P_PREFERRED_FROM_BYTES\s*\|\|\s*dcConnectedNow/.test(ui),
  );

  console.log(results.join('\n'));
  console.log(`\nSummary: ${pass} passed, ${fail} failed`);
  console.log('PHYSICAL_A_BYTES=36599 route=' + clsA.route + ' utf8=' + clsA.utf8Bytes);
  console.log('PHYSICAL_B_BYTES=89562 route=' + clsB.route + ' utf8=' + clsB.utf8Bytes);
  if (lastSafe && firstUnsafe) {
    console.log('DYNAMIC_INLINE_BOUNDARY lastSafe=' + lastSafe.n + ' firstUnsafe=' + firstUnsafe.n);
  }
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
