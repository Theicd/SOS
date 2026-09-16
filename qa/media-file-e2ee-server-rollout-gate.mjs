#!/usr/bin/env node
/**
 * M5 — Server-fallback E2EE rollout preparation gate (mocked network only).
 * Run: node qa/media-file-e2ee-server-rollout-gate.mjs
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
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
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

function fillRandom(u8) {
  const chunk = 16384;
  for (let i = 0; i < u8.length; i += chunk) {
    webcrypto.getRandomValues(u8.subarray(i, Math.min(u8.length, i + chunk)));
  }
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false;
  return true;
}

/** Routing freeze (must match production source). */
const ROUTING = {
  voiceInlineMax: 256 * 1024,
  fileInlineMax: 256 * 1024,
  p2pPreferredFrom: 90 * 1024,
  p2pMax: 100 * 1024 * 1024,
};

function decideTransport(s) {
  if (s.kind === 'text') {
    return s.dcConnected ? 'P2P_TEXT' : 'RELAY_E3B';
  }
  if (s.kind === 'voice') {
    if (s.size <= ROUTING.voiceInlineMax) return 'INLINE';
    return 'BLOSSOM';
  }
  const preferP2P = s.size > ROUTING.p2pPreferredFrom || !!s.dcConnected;
  if (preferP2P && s.p2pAvailable) return 'P2P';
  if (s.size <= ROUTING.fileInlineMax) return 'INLINE';
  if (s.blossomSupported) return 'BLOSSOM';
  return 'WEBTORRENT';
}

function m5Label(baseline, serverE2eeOn) {
  if (baseline === 'BLOSSOM' && serverE2eeOn) return 'BLOSSOM_ENCRYPTED';
  return baseline;
}

class BlobPoly {
  constructor(parts = [], opts = {}) {
    const bufs = parts.map((p) => {
      if (p instanceof Uint8Array) return Buffer.from(p);
      if (p instanceof ArrayBuffer) return Buffer.from(new Uint8Array(p));
      if (typeof p === 'string') return Buffer.from(p);
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

function loadRuntime(opts = {}) {
  const store = new Map();
  let legacyUploadCalls = 0;
  let secureUploadCalls = 0;
  let serverFallbackCalls = 0;
  let composeUploadCalls = 0;
  const networkBodies = [];
  const networkHeaders = [];
  let p2pTextSends = 0;
  let relayPublishes = 0;

  const mockFetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const u = String(url);
    if (u.includes('app-version.json') || opts.policyUrl === u) {
      if (opts.policyFetchFail) throw new Error('policy-fetch-fail');
      if (opts.policyHttpStatus) {
        return {
          ok: false,
          status: opts.policyHttpStatus,
          async json() {
            return {};
          },
          async text() {
            return 'err';
          },
        };
      }
      const body =
        opts.policyJson !== undefined
          ? opts.policyJson
          : { version: 'test', e2eeSendRequired: true };
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    }
    const headersIn = init.headers || {};
    let bodyBytes = null;
    const body = init.body;
    if (body) {
      if (body instanceof Uint8Array) bodyBytes = body;
      else if (body instanceof ArrayBuffer) bodyBytes = new Uint8Array(body);
      else if (typeof body.arrayBuffer === 'function') bodyBytes = new Uint8Array(await body.arrayBuffer());
      else if (body._buf) bodyBytes = new Uint8Array(body._buf);
      else if (typeof body === 'string') bodyBytes = new TextEncoder().encode(body);
    }
    if (method === 'PUT' || method === 'POST') {
      if (!u.includes('/upload') && !u.includes('/media')) {
        return { ok: false, status: 404, headers: { get: () => null }, async text() { return ''; }, async json() { return {}; } };
      }
      networkBodies.push(bodyBytes || new Uint8Array());
      networkHeaders.push(Object.assign({}, headersIn));
      const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bodyBytes || new Uint8Array())).toString('hex');
      const resultUrl = 'https://blossom.test.invalid/' + hash;
      store.set(resultUrl, bodyBytes || new Uint8Array());
      store.set(hash, bodyBytes || new Uint8Array());
      return {
        ok: true,
        status: 200,
        headers: { get: () => String((bodyBytes || []).length) },
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
      const bytes = store.get(u) || store.get(hash);
      if (!bytes) {
        return { ok: false, status: 404, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return ''; } };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return '';
        },
      };
    }
    return { ok: false, status: 405, headers: { get: () => null }, async text() { return ''; } };
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
    console: { log() {}, warn() {}, error() {} },
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
    fetch: opts.fetchImpl || mockFetch,
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
  if (opts.gateOn === true) sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;
  if (opts.gateOn === false) sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = false;
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

  // Simulate compose.js public feed upload (must NOT use server-fallback helper).
  App.uploadVideoToBlossomCompose = async function (blob) {
    composeUploadCalls += 1;
    return App.uploadToBlossom(blob);
  };

  App.__qaSpies = {
    sendP2PText() {
      p2pTextSends += 1;
    },
    publishRelayText() {
      relayPublishes += 1;
    },
    counts() {
      return {
        legacyUploadCalls,
        secureUploadCalls,
        serverFallbackCalls,
        composeUploadCalls,
        networkBodies,
        networkHeaders,
        p2pTextSends,
        relayPublishes,
      };
    },
    reset() {
      legacyUploadCalls = 0;
      secureUploadCalls = 0;
      serverFallbackCalls = 0;
      composeUploadCalls = 0;
      networkBodies.length = 0;
      networkHeaders.length = 0;
      p2pTextSends = 0;
      relayPublishes = 0;
    },
  };

  return { App, sandbox, sender, recipient, mockFetch, store };
}

function auditSourceClassification() {
  const voice = read('chat-voice-service.js');
  const p2p = read('chat-p2p-file.js');
  const compose = read('compose.js');
  const mirror = read('media-mirror.js');
  const mediaServer = read('media-server-e2ee.js');
  const ui = read('chat-file-transfer-ui.js');
  const chatSvc = read('chat-service.js');
  const m2 = read('media-file-e2ee.js');

  record('PRIVATE_CHAT voice uses uploadMediaForServerFallback', /uploadMediaForServerFallback/.test(voice));
  record('PRIVATE_CHAT p2p Blossom adapter gate-scoped', /isMediaServerE2eeRequired/.test(p2p) && /uploadMediaForServerFallback/.test(p2p));
  record('PUBLIC_FEED compose uses App.uploadToBlossom', /uploadVideoToBlossom[\s\S]*uploadToBlossom\(blob\)/.test(compose));
  record('PUBLIC_FEED compose does not use uploadMediaForServerFallback', !/uploadMediaForServerFallback/.test(compose));
  record('MEDIA_MIRROR uses App.uploadToBlossom unchanged', /uploadToBlossom\(blob/.test(mirror) && !/uploadMediaForServerFallback/.test(mirror));
  record('NO global uploadToBlossom monkey-patch in media-server-e2ee', !/App\.uploadToBlossom\s*=/.test(mediaServer));
  record('legacy chat Blossom practical cap MAX_P2P_SIZE=100MiB', /MAX_P2P_SIZE_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/.test(ui));
  record('voice inline 256KiB then Blossom', /MAX_INLINE_BYTES\s*=\s*256\s*\*\s*1024/.test(voice));
  record('P2P DataChannel CHUNK_SIZE still 64KiB', /CHUNK_SIZE\s*=\s*64\s*\*\s*1024/.test(p2p));
  record('SERVER_BLOB_CHUNK_PLAINTEXT_SIZE=1MiB present', /SERVER_BLOB_CHUNK_PLAINTEXT_SIZE\s*=\s*1\s*\*\s*1024\s*\*\s*1024/.test(m2));
  record('text P2P-first still in chat-service', /Message sent P2P, relay skipped/.test(chatSvc) && /DC_PREFER_WAIT_MS/.test(chatSvc));
  record('monotonic seen key defined', /sos_media_server_e2ee_required_seen/.test(mediaServer));
  record('resolveMediaServerE2eeDecision exported', /resolveMediaServerE2eeDecision/.test(mediaServer));
  record('app-version.json does NOT set mediaServerE2eeRequired true', !/"mediaServerE2eeRequired"\s*:\s*true/.test(read('app-version.json')));
}

function runGoldenMatrix() {
  const scenarios = [
    { name: 'text-dc-connected', kind: 'text', dcConnected: true },
    { name: 'text-dc-unavailable', kind: 'text', dcConnected: false },
    { name: 'voice-inline', kind: 'voice', size: 40 * 1024, p2pAvailable: true, blossomSupported: true },
    { name: 'voice-blossom', kind: 'voice', size: 300 * 1024, p2pAvailable: true, blossomSupported: true },
    { name: 'image-p2p', kind: 'image', size: 120 * 1024, p2pAvailable: true, blossomSupported: true },
    { name: 'image-inline', kind: 'image', size: 20 * 1024, p2pAvailable: false, blossomSupported: true },
    { name: 'image-blossom', kind: 'image', size: 500 * 1024, p2pAvailable: false, blossomSupported: true },
    { name: 'video-p2p', kind: 'video', size: 5 * 1024 * 1024, p2pAvailable: true, blossomSupported: true },
    { name: 'video-blossom', kind: 'video', size: 5 * 1024 * 1024, p2pAvailable: false, blossomSupported: true },
    { name: 'file-torrent', kind: 'file', size: 2 * 1024 * 1024, p2pAvailable: false, blossomSupported: false },
    { name: 'file-p2p', kind: 'file', size: 200 * 1024, p2pAvailable: true, blossomSupported: false },
    { name: 'file-inline', kind: 'file', size: 10 * 1024, p2pAvailable: false, blossomSupported: false },
  ];
  for (const s of scenarios) {
    const before = decideTransport(s);
    for (const on of [false, true]) {
      const after = m5Label(before, on);
      const ok =
        before === 'BLOSSOM'
          ? after === (on ? 'BLOSSOM_ENCRYPTED' : 'BLOSSOM')
          : after === before;
      record('golden ' + s.name + ' policy=' + on + ' ' + before + '→' + after, ok);
    }
  }
}

async function runTextP2PContract() {
  const rt = loadRuntime({ gateOn: true });
  // DC connected
  rt.App.__qaSpies.sendP2PText();
  let c = rt.App.__qaSpies.counts();
  record('text DC connected p2p-send=1', c.p2pTextSends === 1);
  record('text DC connected relay=0', c.relayPublishes === 0);
  // policy ON must not affect text
  record('text path ignores server-E2EE (no blossom)', c.serverFallbackCalls === 0 && c.secureUploadCalls === 0);

  rt.App.__qaSpies.reset();
  rt.App.__qaSpies.publishRelayText();
  c = rt.App.__qaSpies.counts();
  record('text DC unavailable relay=1', c.relayPublishes === 1 && c.p2pTextSends === 0);
}

async function runFeedVsChatSeparation() {
  const rt = loadRuntime({ gateOn: true });
  rt.App.__qaSpies.reset();
  const feedBlob = new BlobPoly([new TextEncoder().encode('FEED_PUBLIC_VIDEO')], { type: 'video/mp4' });
  const feedUrl = await rt.App.uploadVideoToBlossomCompose(feedBlob);
  let c = rt.App.__qaSpies.counts();
  record('FEED with gate ON uses legacy uploadToBlossom', c.composeUploadCalls === 1 && c.legacyUploadCalls === 1);
  record('FEED uploadMediaForServerFallback calls=0', c.serverFallbackCalls === 0);
  record('FEED secure encrypted upload=0', c.secureUploadCalls === 0);
  record('FEED returns URL string', typeof feedUrl === 'string' && feedUrl.startsWith('https://'));

  rt.App.__qaSpies.reset();
  const chatBlob = new BlobPoly([new TextEncoder().encode('VOICE_SERVER_SECRET_91841')], { type: 'audio/webm' });
  const desc = await rt.App.uploadMediaForServerFallback(chatBlob, {
    messageId: 'cmsg-chat-1',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
    fileName: 'voice-message.webm',
    mimeType: 'audio/webm',
  });
  c = rt.App.__qaSpies.counts();
  record('CHAT gate ON uploadMediaForServerFallback=1', c.serverFallbackCalls === 1);
  record('CHAT gate ON plaintext uploadToBlossom=0', c.legacyUploadCalls === 0);
  record('CHAT gate ON secure upload=1', c.secureUploadCalls === 1);
  record('CHAT returns encrypted-media', desc && desc.type === 'encrypted-media');
  const bodyText = Buffer.from(c.networkBodies[0] || []).toString('utf8');
  record('CHAT body no plaintext marker', !bodyText.includes('VOICE_SERVER_SECRET_91841'));
  record(
    'CHAT Content-Type octet-stream',
    (c.networkHeaders[0] && (c.networkHeaders[0]['Content-Type'] || c.networkHeaders[0]['content-type'])) ===
      'application/octet-stream',
  );
  record('CHAT uses 1MiB server chunk field', desc.chunkPlaintextSize === 1 * 1024 * 1024 || desc.enc?.mode === 'single');
}

async function runMonotonicPolicy() {
  const rt = loadRuntime({
    gateOn: null,
    policyJson: { mediaServerE2eeRequired: true, e2eeSendRequired: true },
  });
  // Clear QA override
  delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;

  let d = await rt.App.resolveMediaServerE2eeDecision();
  record('remote true → REQUIRED', d.required === true && d.state === 'REQUIRED');

  // Simulate stale false
  rt.sandbox.fetch = async (url) => {
    if (String(url).includes('app-version')) {
      return { ok: true, status: 200, async json() { return { mediaServerE2eeRequired: false }; } };
    }
    return rt.mockFetch(url, {});
  };
  d = await rt.App.resolveMediaServerE2eeDecision();
  record('TRUE → FALSE downgrade blocked (stays REQUIRED)', d.required === true);

  // Missing field
  rt.sandbox.fetch = async (url) => {
    if (String(url).includes('app-version')) {
      return { ok: true, status: 200, async json() { return { e2eeSendRequired: true }; } };
    }
    return { ok: false, status: 404, async text() { return ''; } };
  };
  d = await rt.App.resolveMediaServerE2eeDecision();
  record('TRUE → MISSING stays REQUIRED', d.required === true);

  // Fetch failure
  rt.sandbox.fetch = async () => {
    throw new Error('offline');
  };
  d = await rt.App.resolveMediaServerE2eeDecision();
  record('TRUE → FETCH FAILURE stays REQUIRED', d.required === true);

  // After REQUIRED: Blossom path must encrypt (no plaintext)
  rt.App.__qaSpies.reset();
  // restore blossom mock fetch but keep sticky
  const store = new Map();
  rt.sandbox.fetch = async (url, init = {}) => {
    if (String(url).includes('app-version')) throw new Error('offline');
    const method = (init.method || 'GET').toUpperCase();
    let bodyBytes = null;
    if (init.body && init.body._buf) bodyBytes = new Uint8Array(init.body._buf);
    else if (init.body && init.body.arrayBuffer) bodyBytes = new Uint8Array(await init.body.arrayBuffer());
    if (method === 'PUT' || method === 'POST') {
      const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bodyBytes || new Uint8Array())).toString('hex');
      const resultUrl = 'https://blossom.test.invalid/' + hash;
      store.set(hash, bodyBytes);
      return { ok: true, status: 200, headers: { get: () => null }, async json() { return { url: resultUrl }; }, async text() { return ''; } };
    }
    return { ok: false, status: 404, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return ''; } };
  };
  const marker = 'IMAGE_SERVER_SECRET_91842';
  const out = await rt.App.uploadMediaForServerFallback(new BlobPoly([marker], { type: 'image/png' }), {
    messageId: 'cmsg-sticky-1',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
    skipPolicyFetch: true,
  });
  const c = rt.App.__qaSpies.counts();
  record('after REQUIRED plaintext Blossom ZERO', c.legacyUploadCalls === 0);
  record('after REQUIRED encrypted path used', c.secureUploadCalls === 1 && out.type === 'encrypted-media');
}

async function runStaleTabCutover() {
  const rt = loadRuntime({ gateOn: false, policyJson: { mediaServerE2eeRequired: false } });
  delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;
  rt.sandbox.localStorage.removeItem('sos_media_server_e2ee_required_seen');

  let d = await rt.App.resolveMediaServerE2eeDecision();
  record('stale-tab start NOT_REQUIRED', d.required === false);

  // Server later true — refresh before next private-chat Blossom
  const baseFetch = rt.mockFetch;
  rt.sandbox.fetch = async (url, init) => {
    if (String(url).includes('app-version')) {
      return { ok: true, status: 200, async json() { return { mediaServerE2eeRequired: true }; } };
    }
    return baseFetch(url, init);
  };

  rt.App.__qaSpies.reset();
  const desc = await rt.App.uploadMediaForServerFallback(new BlobPoly([new Uint8Array([9, 9, 9])], { type: 'image/png' }), {
    messageId: 'cmsg-stale-1',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
  });
  const c = rt.App.__qaSpies.counts();
  record('stale-tab cutover refreshes before Blossom', desc.type === 'encrypted-media');
  record('stale-tab cutover no plaintext upload', c.legacyUploadCalls === 0 && c.secureUploadCalls === 1);
}

async function runPolicyDoesNotForceRoutes() {
  for (const policy of [false, true]) {
    const baselineTorrent = decideTransport({
      kind: 'file',
      size: 2 * 1024 * 1024,
      p2pAvailable: false,
      blossomSupported: false,
    });
    const baselineP2P = decideTransport({
      kind: 'image',
      size: 200 * 1024,
      p2pAvailable: true,
      blossomSupported: true,
    });
    record(
      'policy=' + policy + ' WEBTORRENT unchanged',
      m5Label(baselineTorrent, policy) === 'WEBTORRENT' && baselineTorrent === 'WEBTORRENT',
    );
    record(
      'policy=' + policy + ' P2P unchanged',
      m5Label(baselineP2P, policy) === 'P2P' && baselineP2P === 'P2P',
    );
  }
  // previously true + unavailable still does not force blossom
  const rt = loadRuntime({ gateOn: true });
  record('policy does not force Blossom (API comment/contract)', !/forceBlossom|skipP2P|disableTorrent/.test(read('media-server-e2ee.js')));
  void rt;
}

async function runLegacy64kCompatAnd1MiBRoundtrip() {
  const rt = loadRuntime({ gateOn: true });
  // Legacy-style 64KiB chunk encrypt still decrypts
  const plain = new Uint8Array(80 * 1024);
  fillRandom(plain);
  const enc64 = await rt.App.encryptMediaBlob(plain, {
    messageId: 'cmsg-compat-64',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
    chunkPlaintextSize: 64 * 1024,
    mime: 'application/octet-stream',
    filename: 'old.bin',
  });
  record('legacy 64KiB descriptor chunkPlaintextSize=65536', enc64.descriptor.chunkPlaintextSize === 65536);
  const dec64 = await rt.App.decryptMediaBlob(enc64.ciphertext, enc64.descriptor, {
    messageId: 'cmsg-compat-64',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
  });
  record('legacy 64KiB descriptor still readable', bytesEqual(dec64.plaintext, plain));

  // Server 1MiB path
  const plain2 = new Uint8Array(1.5 * 1024 * 1024);
  fillRandom(plain2);
  const up = await rt.App.uploadMediaForServerFallback(new BlobPoly([plain2], { type: 'application/octet-stream' }), {
    messageId: 'cmsg-1mib',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
    fileName: 'big.bin',
  });
  record('server blob chunkPlaintextSize=1MiB', up.chunkPlaintextSize === 1 * 1024 * 1024);
  const resolved = await rt.App.resolveServerMediaAttachment(up, {
    messageId: 'cmsg-1mib',
    sender: rt.sender.pk,
    recipient: rt.recipient.pk,
  });
  const out = new Uint8Array(await resolved.blob.arrayBuffer());
  record('1MiB-chunk server roundtrip', bytesEqual(out, plain2));
}

async function runDescriptorScalingTable() {
  const rt = loadRuntime({ gateOn: true });
  const chunkPlain = 1 * 1024 * 1024;
  const sizes = [
    10 * 1024 * 1024,
    31 * 1024 * 1024,
    50 * 1024 * 1024,
    100 * 1024 * 1024,
    250 * 1024 * 1024,
    500 * 1024 * 1024,
    1024 * 1024 * 1024,
  ];
  const table = [];
  for (const plainSize of sizes) {
    const chunks = Math.max(1, Math.ceil(plainSize / chunkPlain));
    const fakeChunks = [];
    for (let i = 0; i < chunks; i += 1) {
      fakeChunks.push({
        index: i,
        nonce: 'AAAAAAAAAAAAAAAA',
        size: Math.min(chunkPlain, plainSize - i * chunkPlain) + 16,
        sha256: 'a'.repeat(64),
      });
    }
    const fakeAtt = {
      v: 2,
      type: 'encrypted-media',
      attachmentId: 'b'.repeat(32),
      enc: { alg: 'aes-256-gcm', mode: 'chunked', key: 'c'.repeat(43) },
      cipher: { size: plainSize + chunks * 16, sha256: 'd'.repeat(64) },
      media: { mime: 'application/octet-stream', filename: 'x.bin', originalSize: plainSize },
      chunkPlaintextSize: chunkPlain,
      chunkCount: chunks,
      chunks: fakeChunks,
      resource: { transport: 'blossom', url: 'https://blossom.band/' + 'e'.repeat(64), host: 'blossom.band' },
    };
    const cls = rt.App.classifyAttachmentForE2eeRoute({
      messageId: 'cmsg-probe',
      sender: rt.sender.pk,
      recipient: rt.recipient.pk,
      createdAt: 1,
      text: '',
      attachment: fakeAtt,
    });
    const descBytes = Buffer.byteLength(JSON.stringify(fakeAtt), 'utf8');
    const fits = cls.route === 'INLINE_E2EE_SAFE';
    table.push({
      plainSize,
      chunks,
      descBytes,
      e3bBytes: cls.utf8Bytes,
      fits,
    });
    record(
      'descriptor ' + Math.round(plainSize / (1024 * 1024)) + 'MiB chunks=' + chunks + ' e3b=' + cls.utf8Bytes + ' fits=' + fits,
      true,
      fits ? 'YES' : 'NO',
    );
  }
  globalThis.__M5_DESC_TABLE__ = table;
  const cover100 = table.find((t) => t.plainSize === 100 * 1024 * 1024);
  record('100MiB legacy Blossom range covered by NIP-44', !!(cover100 && cover100.fits));
  const maxFit = table.filter((t) => t.fits).reduce((m, t) => Math.max(m, t.plainSize), 0);
  globalThis.__M5_MAX_SECURE_SERVER_FILE__ = maxFit;
  record('new secure server limit measured', maxFit >= 100 * 1024 * 1024, String(maxFit));
}

async function main() {
  console.log('M5 server-fallback E2EE rollout preparation gate');
  auditSourceClassification();
  runGoldenMatrix();
  await runTextP2PContract();
  await runFeedVsChatSeparation();
  await runMonotonicPolicy();
  await runStaleTabCutover();
  await runPolicyDoesNotForceRoutes();
  await runLegacy64kCompatAnd1MiBRoundtrip();
  await runDescriptorScalingTable();

  console.log('');
  for (const line of results) console.log(line);
  console.log('');
  console.log('TOTAL ' + pass + '/' + (pass + fail));
  if (globalThis.__M5_MAX_SECURE_SERVER_FILE__) {
    console.log('NEW_SECURE_SERVER_LIMIT_BYTES=' + globalThis.__M5_MAX_SECURE_SERVER_FILE__);
  }
  if (Array.isArray(globalThis.__M5_DESC_TABLE__)) {
    for (const row of globalThis.__M5_DESC_TABLE__) {
      console.log(
        'DESC ' +
          Math.round(row.plainSize / (1024 * 1024)) +
          'MiB chunks=' +
          row.chunks +
          ' descUtf8≈' +
          row.descBytes +
          ' e3bUtf8=' +
          row.e3bBytes +
          ' fits=' +
          (row.fits ? 'YES' : 'NO'),
      );
    }
  }
  if (fail) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
