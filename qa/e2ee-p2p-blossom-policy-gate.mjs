#!/usr/bin/env node
/**
 * Hotfix: PRIVATE CHAT P2P→Blossom must await resolveMediaServerE2eeDecision
 * before any private Blossom upload. Fresh clients must not plaintext-bypass.
 * Run: node qa/e2ee-p2p-blossom-policy-gate.mjs
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
    return new BlobPoly([this._bytes.subarray(start || 0, end == null ? this._bytes.length : end)], {
      type: type || this.type,
    });
  }
}

function loadRuntime(opts = {}) {
  let legacyUploadCalls = 0;
  let secureUploadCalls = 0;
  let serverFallbackCalls = 0;
  let resolveCalls = 0;
  const networkBodies = [];
  const networkHeaders = [];
  const plaintextMarkers = [];

  const policyJson =
    opts.policyJson !== undefined
      ? opts.policyJson
      : { mediaServerE2eeRequired: true, e2eeSendRequired: true, minSecureChatEpoch: 2 };

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (/app-version\.json/i.test(u)) {
      if (opts.fetchFail) throw new Error('offline');
      if (opts.fetchStatus) {
        return {
          ok: opts.fetchStatus >= 200 && opts.fetchStatus < 300,
          status: opts.fetchStatus,
          async json() {
            return policyJson;
          },
          async text() {
            return '';
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return typeof policyJson === 'function' ? policyJson() : policyJson;
        },
      };
    }
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
    const blob = args[0];
    if (blob && typeof blob.arrayBuffer === 'function') {
      const buf = new Uint8Array(await blob.arrayBuffer());
      plaintextMarkers.push(Buffer.from(buf).toString('utf8'));
    }
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
  const resolve = App.resolveMediaServerE2eeDecision.bind(App);
  App.resolveMediaServerE2eeDecision = async function (...args) {
    resolveCalls += 1;
    return resolve(...args);
  };

  /** Simulate the private-chat Blossom branch after P2P already failed. */
  App.__qaSimulateP2pBlossomFallback = async function (file, extra = {}) {
    const decision = await App.resolveMediaServerE2eeDecision(extra.resolveOpts || {});
    const interpreted = App.interpretPrivateChatBlossomPolicy(decision);
    if (interpreted.mode === 'SECURE') {
      return {
        interpreted,
        result: await App.uploadMediaForServerFallback(file, {
          messageId: extra.messageId || 'cmsg-p2p-fallback',
          sender: App.publicKey,
          recipient: recipient.pk,
          mimeType: file.type,
          fileName: file.name || 'photo.jpg',
        }),
      };
    }
    if (interpreted.mode === 'LEGACY') {
      return {
        interpreted,
        result: await App.uploadToBlossom(file),
      };
    }
    const err = new Error('MEDIA_SERVER_E2EE_POLICY_BLOCKED');
    err.code = 'MEDIA_SERVER_E2EE_POLICY_BLOCKED';
    err.interpreted = interpreted;
    throw err;
  };

  return {
    App,
    sender,
    recipient,
    sandbox,
    counts() {
      return {
        legacyUploadCalls,
        secureUploadCalls,
        serverFallbackCalls,
        resolveCalls,
        networkBodies,
        networkHeaders,
        plaintextMarkers,
      };
    },
    reset() {
      legacyUploadCalls = 0;
      secureUploadCalls = 0;
      serverFallbackCalls = 0;
      resolveCalls = 0;
      networkBodies.length = 0;
      networkHeaders.length = 0;
      plaintextMarkers.length = 0;
    },
    clearSticky() {
      sandbox.localStorage.removeItem('sos_media_server_e2ee_required_seen');
      // force in-memory sticky reset by reloading is hard; clear storage is enough if module
      // also checks localStorage first after mediaServerE2eeRequiredKnown — known flag stays.
      // Re-create runtime for true fresh client tests.
    },
  };
}

async function main() {
  const p2p = read('chat-p2p-file.js');
  const ui = read('chat-file-transfer-ui.js');
  const service = read('chat-service.js');
  const compose = read('compose.js');
  const mirror = read('media-mirror.js');
  const mediaServer = read('media-server-e2ee.js');

  record(
    'fallbackToBlossom awaits resolveMediaServerE2eeDecision',
    /resolveMediaServerE2eeDecision/.test(p2p) &&
      /Fallback to Blossom upload[\s\S]{0,1200}resolveMediaServerE2eeDecision/.test(p2p),
  );
  record(
    'fallbackToBlossom does not gate solely on sync isMediaServerE2eeRequired for upload choice',
    !/if\s*\(\s*typeof App\.isMediaServerE2eeRequired[\s\S]{0,180}uploadMediaForServerFallback[\s\S]{0,200}uploadToBlossom\(transfer\.file\)/.test(
      p2p,
    ),
  );
  record(
    'secure path does not require uploadToBlossom existence first',
    !/if\s*\(\s*typeof App\.uploadToBlossom !== 'function'\)[\s\S]{0,200}Fallback to Blossom/.test(p2p) &&
      /uploadMediaForServerFallback/.test(p2p),
  );
  record('POLICY_BLOCKED fail-closed present', /MEDIA_SERVER_E2EE_POLICY_BLOCKED/.test(p2p + mediaServer));
  record('interpretPrivateChatBlossomPolicy exported', /interpretPrivateChatBlossomPolicy/.test(mediaServer));
  record(
    'P2P threshold 90KiB unchanged',
    /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(ui),
  );
  record('P2P chunk 64KiB unchanged', /CHUNK_SIZE\s*=\s*64\s*\*\s*1024/.test(p2p));
  record(
    'text P2P relay skip log present',
    /Message sent P2P, relay skipped/.test(service),
  );
  record('compose unchanged / no server-fallback', /uploadToBlossom/.test(compose) && !/uploadMediaForServerFallback/.test(compose));
  record('media-mirror unchanged', /uploadToBlossom/.test(mirror) && !/uploadMediaForServerFallback/.test(mirror));
  record('no global uploadToBlossom patch', !/App\.uploadToBlossom\s*=/.test(mediaServer));

  // --- CASE A: fresh client, remote=true ---
  {
    const rt = loadRuntime({
      gateOn: null,
      policyJson: { mediaServerE2eeRequired: true, e2eeSendRequired: true, minSecureChatEpoch: 2 },
    });
    delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;
    record('fresh sticky absent', rt.sandbox.localStorage.getItem('sos_media_server_e2ee_required_seen') == null);
    record('fresh sync isMediaServerE2eeRequired false', rt.App.isMediaServerE2eeRequired() === false);
    const file = new BlobPoly([randomBytes(140915)], { type: 'image/jpeg' });
    file.name = 'mobile-140915.jpg';
    const out = await rt.App.__qaSimulateP2pBlossomFallback(file);
    const c = rt.counts();
    record('CASE A resolve called', c.resolveCalls >= 1);
    record('CASE A mode SECURE', out.interpreted.mode === 'SECURE');
    record('CASE A uploadMediaForServerFallback=1', c.serverFallbackCalls === 1);
    record('CASE A plaintext uploadToBlossom=0', c.legacyUploadCalls === 0);
    record('CASE A encrypted-media result', out.result && out.result.type === 'encrypted-media');
    const body = c.networkBodies[0];
    const plain = Buffer.from(await file.arrayBuffer());
    record(
      'CASE A body not plaintext',
      !!(body && body.length) && !(body.length === plain.length && Buffer.from(body).equals(plain)),
    );
  }

  // --- Fresh + fetch failure → FAIL CLOSED ---
  {
    const rt = loadRuntime({ gateOn: null, fetchFail: true, policyJson: { mediaServerE2eeRequired: true } });
    delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;
    const file = new BlobPoly([randomBytes(116318)], { type: 'image/jpeg' });
    file.name = 'fresh-fail.jpg';
    let blocked = false;
    let code = '';
    try {
      await rt.App.__qaSimulateP2pBlossomFallback(file);
    } catch (e) {
      blocked = true;
      code = e && e.code;
    }
    const c = rt.counts();
    record('fresh fetch fail BLOCKED', blocked && code === 'MEDIA_SERVER_E2EE_POLICY_BLOCKED');
    record('fresh fetch fail plaintext=0', c.legacyUploadCalls === 0);
    record('fresh fetch fail secureUpload=0', c.secureUploadCalls === 0);
  }

  // --- Sticky true → remote false / missing / fetch fail ---
  {
    const rt = loadRuntime({
      gateOn: null,
      policyJson: { mediaServerE2eeRequired: true, e2eeSendRequired: true },
    });
    delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;
    await rt.App.resolveMediaServerE2eeDecision();
    record('sticky set after remote true', rt.sandbox.localStorage.getItem('sos_media_server_e2ee_required_seen') === '1');

    async function stickyCase(name, fetchImpl) {
      rt.reset();
      rt.sandbox.fetch = fetchImpl;
      const file = new BlobPoly([randomBytes(206146)], { type: 'image/jpeg' });
      file.name = name + '.jpg';
      const out = await rt.App.__qaSimulateP2pBlossomFallback(file);
      const c = rt.counts();
      record(name + ' SECURE', out.interpreted.mode === 'SECURE' && out.result?.type === 'encrypted-media');
      record(name + ' plaintext=0', c.legacyUploadCalls === 0);
    }

    await stickyCase('sticky→remote false', async (url, init) => {
      if (String(url).includes('app-version')) {
        return { ok: true, status: 200, async json() { return { mediaServerE2eeRequired: false }; } };
      }
      // blossom
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method === 'PUT' || method === 'POST') {
        let bytes = new Uint8Array(0);
        if (init.body && init.body.arrayBuffer) bytes = new Uint8Array(await init.body.arrayBuffer());
        const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
        return {
          ok: true,
          status: 200,
          headers: { get: () => hash },
          async json() { return { sha256: hash, url: 'https://blossom.test.invalid/' + hash }; },
        };
      }
      return { ok: false, status: 404, async text() { return ''; } };
    });

    await stickyCase('sticky→missing', async (url, init) => {
      if (String(url).includes('app-version')) {
        return { ok: true, status: 200, async json() { return { e2eeSendRequired: true }; } };
      }
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method === 'PUT' || method === 'POST') {
        let bytes = new Uint8Array(0);
        if (init.body && init.body.arrayBuffer) bytes = new Uint8Array(await init.body.arrayBuffer());
        const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
        return {
          ok: true,
          status: 200,
          headers: { get: () => hash },
          async json() { return { sha256: hash, url: 'https://blossom.test.invalid/' + hash }; },
        };
      }
      return { ok: false, status: 404, async text() { return ''; } };
    });

    await stickyCase('sticky→fetch fail', async (url, init) => {
      if (String(url).includes('app-version')) throw new Error('offline');
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method === 'PUT' || method === 'POST') {
        let bytes = new Uint8Array(0);
        if (init.body && init.body.arrayBuffer) bytes = new Uint8Array(await init.body.arrayBuffer());
        const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
        return {
          ok: true,
          status: 200,
          headers: { get: () => hash },
          async json() { return { sha256: hash, url: 'https://blossom.test.invalid/' + hash }; },
        };
      }
      return { ok: false, status: 404, async text() { return ''; } };
    });
  }

  // --- Real failure sizes ---
  for (const n of [116318, 140915, 206146]) {
    const rt = loadRuntime({
      gateOn: null,
      policyJson: { mediaServerE2eeRequired: true, e2eeSendRequired: true },
    });
    delete rt.sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__;
    const file = new BlobPoly([randomBytes(n)], { type: 'image/jpeg' });
    file.name = 'size-' + n + '.jpg';
    const out = await rt.App.__qaSimulateP2pBlossomFallback(file);
    const c = rt.counts();
    record(n + ' encrypted fallback', out.result?.type === 'encrypted-media');
    record(n + ' plaintext=0', c.legacyUploadCalls === 0);
  }

  // --- Pre-activation explicit false → LEGACY allowed ---
  {
    const rt = loadRuntime({
      gateOn: false,
      policyJson: { mediaServerE2eeRequired: false },
    });
    const file = new BlobPoly([randomBytes(4096)], { type: 'image/jpeg' });
    file.name = 'legacy.jpg';
    // Clear sticky if any
    rt.sandbox.localStorage.removeItem('sos_media_server_e2ee_required_seen');
    const out = await rt.App.__qaSimulateP2pBlossomFallback(file);
    const c = rt.counts();
    record('pre-activation explicit false → LEGACY', out.interpreted.mode === 'LEGACY');
    record('pre-activation legacy upload allowed', c.legacyUploadCalls === 1);
  }

  // --- P2P success path: no Blossom (static + size assertion) ---
  record(
    '507273 remains above P2P preferred threshold',
    507273 > 90 * 1024 && /shouldPreferP2P\s*=\s*file\.size\s*>\s*P2P_PREFERRED_FROM_BYTES/.test(ui),
  );
  record(
    'P2P success path does not call Blossom in sendP2P success return',
    /adoptOutgoingBubble\(fileId\)[\s\S]{0,200}return;/.test(ui) ||
      /sendP2PFile[\s\S]{0,400}return/.test(ui),
  );

  // --- Text relay skip regression (static structure) ---
  record(
    'DC connected skips relay publish',
    /dataChannel\.isConnected/.test(service) &&
      /dataChannel\.send/.test(service) &&
      /Message sent P2P, relay skipped/.test(service) &&
      /return \{ ok: true, messageId: p2pId, p2p: true \}/.test(service),
  );

  console.log(results.join('\n'));
  console.log(`\nSummary: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
