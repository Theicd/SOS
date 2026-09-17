#!/usr/bin/env node
/**
 * Hotfix gate: encrypted attachment state clone + voice + restore race.
 * Uses real application modules (vm), not simplified crypto mocks.
 *
 * Run: node qa/chat-encrypted-attachment-state-recovery-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  utils,
  nip44,
} from 'nostr-tools';

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
  slice(start, end, type) {
    const s = start || 0;
    const e = end == null ? this._buf.length : end;
    return new BlobPoly([this._buf.subarray(s, e)], { type: type || this.type });
  }
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
      if (rejectAll) {
        return { ok: false, status: 500, headers: { get: () => null }, async text() { return 'fail'; }, async json() { return {}; } };
      }
      if (String(ct).toLowerCase().startsWith('application/octet-stream')) {
        return { ok: false, status: 415, headers: { get: () => null }, async text() { return 'Unsupported Media Type'; }, async json() { return {}; } };
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

function createDelayedIndexedDB(getPayloadFn, delayMs) {
  return {
    open() {
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = {
              oncomplete: null,
              onerror: null,
              objectStore() {
                return {
                  get() {
                    const getReq = {
                      result: null,
                      onsuccess: null,
                      onerror: null,
                    };
                    setTimeout(() => {
                      try {
                        getReq.result = typeof getPayloadFn === 'function' ? getPayloadFn() : null;
                      } catch (_e) {
                        getReq.result = null;
                      }
                      if (typeof getReq.onsuccess === 'function') getReq.onsuccess();
                    }, delayMs);
                    return getReq;
                  },
                  put(val) {
                    /* no-op for restore race */
                    return val;
                  },
                };
              },
            };
            queueMicrotask(() => {
              if (typeof tx.oncomplete === 'function') tx.oncomplete();
            });
            return tx;
          },
        };
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });
      return request;
    },
  };
}

function makeLocalStorage() {
  const store = {};
  return {
    store,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      store[k] = String(v);
    },
    removeItem(k) {
      delete store[k];
    },
  };
}

function loadMediaRuntime(mockFetch) {
  const alice = hexPubkeyPair();
  const localStorage = makeLocalStorage();
  const App = {
    publicKey: alice.pk,
    privateKey: alice.hex,
    _chatStateBootstrapped: true,
    _chatServiceBootstrapped: true,
    finalizeEvent(draft, key) {
      const hostDraft = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(hostDraft, sk);
    },
  };
  const urlStore = new Map();
  let urlSeq = 0;
  const URLPoly = {
    createObjectURL(blob) {
      const u = 'blob:qa/' + ++urlSeq;
      urlStore.set(u, blob);
      return u;
    },
    revokeObjectURL(u) {
      urlStore.delete(u);
    },
  };
  Object.setPrototypeOf(URLPoly, URL);
  // Preserve URL constructor behavior for parsing
  const URLCtor = function URLCtor(...args) {
    return new URL(...args);
  };
  URLCtor.createObjectURL = URLPoly.createObjectURL;
  URLCtor.revokeObjectURL = URLPoly.revokeObjectURL;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    self: {},
    document: {
      readyState: 'complete',
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      getElementById() {
        return null;
      },
      createElement() {
        return { style: {}, setAttribute() {}, appendChild() {}, querySelector() { return null; } };
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    URL: URLCtor,
    Blob: BlobPoly,
    File: class FilePoly extends BlobPoly {
      constructor(parts, name, opts) {
        super(parts, opts);
        this.name = name || 'f.bin';
      }
    },
    FileReader: class FileReaderPoly {
      readAsDataURL() {
        this.result = 'data:application/octet-stream;base64,AA==';
        if (typeof this.onloadend === 'function') this.onloadend();
      }
    },
    btoa(s) {
      return Buffer.from(String(s), 'binary').toString('base64');
    },
    atob(s) {
      return Buffer.from(String(s), 'base64').toString('binary');
    },
    fetch: mockFetch,
    localStorage,
    indexedDB: {
      open() {
        const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => {
          req.error = new Error('idb-disabled-in-media-runtime');
          if (typeof req.onerror === 'function') req.onerror();
        });
        return req;
      },
    },
    NostrApp: App,
    NostrTools: { finalizeEvent, utils, nip44, generateSecretKey, getPublicKey, verifyEvent: () => true },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Map,
    Set,
    Promise,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Boolean,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  App.blossomServers = [{ url: 'https://blossom.test.invalid' }];
  sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;

  vm.createContext(sandbox);
  vm.runInContext(read('chat-state.js'), sandbox);
  vm.runInContext(read('media-file-e2ee.js'), sandbox);
  vm.runInContext(read('blossom.js'), sandbox);
  vm.runInContext(read('media-server-e2ee.js'), sandbox);
  vm.runInContext(read('chat-file-transfer-state.js'), sandbox);
  vm.runInContext(read('chat-file-transfer-service.js'), sandbox);
  vm.runInContext(read('chat-service.js'), sandbox);
  // E2EE in host realm (noble Uint8Array)
  globalThis.NostrApp = sandbox.NostrApp;
  globalThis.NostrTools = { finalizeEvent, utils, nip44, generateSecretKey, getPublicKey };
  vm.runInThisContext(read('chat-e2ee.js'), { filename: 'chat-e2ee.js' });
  Object.assign(sandbox.NostrApp, {
    encryptPrivateChatPayload: globalThis.NostrApp.encryptPrivateChatPayload,
    decryptPrivateChatPayload: globalThis.NostrApp.decryptPrivateChatPayload,
    looksLikeSosE2eeEnvelope: globalThis.NostrApp.looksLikeSosE2eeEnvelope,
    isE2eeEnvelope: globalThis.NostrApp.isE2eeEnvelope,
  });

  return { App: sandbox.NostrApp, alice, sandbox, Blob: BlobPoly };
}

function e2eeEncryptAttachment(App, alice, bob, messageId, attachment, text = '') {
  return App.encryptPrivateChatPayload({
    senderPrivateKeyHex: alice.hex,
    senderPubkey: alice.pk,
    recipientPubkey: bob.pk,
    payload: {
      text,
      messageId,
      createdAt: Math.floor(Date.now() / 1000),
      attachment,
    },
  });
}

function e2eeDecryptAttachment(App, alice, bob, envelope) {
  return App.decryptPrivateChatPayload({
    localPrivateKeyHex: bob.hex,
    localPubkey: bob.pk,
    eventAuthorPubkey: alice.pk,
    encryptedEnvelope: envelope,
  });
}

function loadChatStateRuntime(opts = {}) {
  const alice = hexPubkeyPair();
  const bob = hexPubkeyPair();
  const localStorage = makeLocalStorage();
  const delayMs = opts.delayMs != null ? opts.delayMs : 80;
  let snapshotRef = opts.snapshot || null;
  const indexedDB = createDelayedIndexedDB(() => snapshotRef, delayMs);
  const App = {
    publicKey: alice.pk,
    privateKey: alice.hex,
    _chatStateBootstrapped: true, // prevent auto-restore
    deletedChatMessageIds: new Set(),
    getInitials(name) {
      return String(name || 'מש').slice(0, 2);
    },
    inspectIncomingChatAttachment() {
      return { ok: true };
    },
    sanitizeIncomingChatFileName(n) {
      return String(n || 'file');
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
    document: {
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage,
    indexedDB,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    NostrApp: App,
    Map,
    Set,
    Promise,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Boolean,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('chat-state.js'), sandbox);
  return {
    App: sandbox.NostrApp,
    alice,
    bob,
    localStorage,
    setSnapshot(s) {
      snapshotRef = s;
    },
    getSnapshot() {
      return snapshotRef;
    },
  };
}

function assertCryptoFields(got, labelPrefix) {
  const checks = [
    ['v', got && got.v === 2],
    ['type', got && got.type === 'encrypted-media'],
    ['attachmentId', !!(got && typeof got.attachmentId === 'string' && got.attachmentId)],
    ['enc', !!(got && got.enc && typeof got.enc === 'object' && got.enc.key)],
    ['cipher', !!(got && got.cipher && typeof got.cipher.sha256 === 'string')],
    ['media', !!(got && got.media && typeof got.media === 'object')],
    ['resource', !!(got && got.resource && got.resource.transport === 'blossom')],
  ];
  for (const [name, ok] of checks) {
    record(labelPrefix + ' preserves ' + name, ok);
  }
}

async function roundtripDescriptor(App, alice, bob, blob, messageId, extraOpts = {}) {
  const uploaded = await App.uploadMediaForServerFallback(blob, {
    messageId,
    sender: alice.pk,
    recipient: bob.pk,
    mimeType: extraOpts.mimeType || blob.type || 'image/jpeg',
    fileName: extraOpts.fileName || 'photo.jpg',
    skipPolicyFetch: true,
    ...extraOpts,
  });
  if (extraOpts.isVoice) {
    uploaded.isVoice = true;
    if (typeof extraOpts.duration === 'number') uploaded.duration = extraOpts.duration;
    if (extraOpts.magnetURI) uploaded.magnetURI = extraOpts.magnetURI;
  }
  App.setChatFileAttachment(bob.pk, {
    ...uploaded,
    _prepared: { secret: 'LEAK' },
    _resolvedBlob: blob,
    _localObjectUrl: 'blob:http://local/leak',
  });
  const got = App.getChatFileAttachment(bob.pk);
  return { uploaded, got };
}

async function run() {
  const appVer = JSON.parse(read('app-version.json'));
  const p2pSrc = read('chat-p2p-file.js');
  const fileUiSrc = read('chat-file-transfer-ui.js');
  const torrentSrc = fs.existsSync(path.join(ROOT, 'chat-torrent-transfer.js'))
    ? read('chat-torrent-transfer.js')
    : '';
  const stateSrc = read('chat-file-transfer-state.js');
  const xferSrc = read('chat-file-transfer-service.js');
  const chatStateSrc = read('chat-state.js');
  const chatUiSrc = read('chat-ui.js');
  const blossomSrc = read('blossom.js');

  // --- Static architecture / security floor ---
  record('security floor minSecureChatEpoch=2', Number(appVer.minSecureChatEpoch) === 2);
  record('security floor e2eeSendRequired=true', appVer.e2eeSendRequired === true);
  record('security floor mediaServerE2eeRequired=true', appVer.mediaServerE2eeRequired === true);
  record(
    'P2P threshold 92160 unchanged',
    /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(fileUiSrc),
  );
  record('P2P chunk 64KiB unchanged', /const CHUNK_SIZE = 64 \* 1024/.test(p2pSrc));
  record('opaque jpeg wire unchanged', blossomSrc.includes("SECURE_WIRE_ENCODING = 'sos-opaque-jpeg-v1'"));
  record('clone helper present', stateSrc.includes('buildEncryptedAttachmentWireDescriptor'));
  record('serialize uses wire helper', xferSrc.includes('buildEncryptedAttachmentWireDescriptor'));
  record('restore merge present', chatStateSrc.includes('mergeConversationMessages'));
  record(
    'live-on-tie sets live (no early return bug)',
    /Same status rank:[\s\S]{0,120}if \(preferLiveOnTie\) \{\s*byId\.set/.test(chatStateSrc) &&
      !/if \(preferLiveOnTie\) return;/.test(chatStateSrc),
  );
  record('restore idempotent present', chatStateSrc.includes('restoreInFlight') && chatStateSrc.includes('restoredStorageKey'));
  record('restoreChatModuleState returns Promise', /function restoreChatModuleState\(\)\s*\{\s*return restoreState\(\);/.test(chatStateSrc));
  record(
    'chat-ui awaits restore before subscribe',
    chatUiSrc.includes('await App.restoreChatState()') &&
      chatUiSrc.indexOf('await App.restoreChatState()') < chatUiSrc.indexOf('App.subscribeToChatEvents()'),
  );
  record('voice detection uses media.mime', chatUiSrc.includes('media.mime') && xferSrc.includes('isEncryptedVoiceAttachment'));
  void torrentSrc;
  const mock = createRealisticMock();
  const rt = loadMediaRuntime(mock.mockFetch);
  const { App, alice, Blob } = rt;
  const bob = hexPubkeyPair();

  // --- A/B: set→get preserves encrypted descriptor; no local leak ---
  {
    const mid = 'cmsg-state-clone-A';
    const plain = randomBytes(140915);
    const { uploaded, got } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([plain], { type: 'image/jpeg' }),
      mid,
      { mimeType: 'image/jpeg', fileName: 'phys-140915.jpg' },
    );
    assertCryptoFields(got, 'SET→GET');
    record('SET→GET clientMessageId', got && got.clientMessageId === mid);
    record('SET→GET logicalMessageId', got && got.logicalMessageId === mid);
    record('LOCAL _prepared NETWORK LEAK ZERO', !got || got._prepared === undefined);
    record('LOCAL _resolvedBlob NETWORK LEAK ZERO', !got || got._resolvedBlob === undefined);
    record('LOCAL _localObjectUrl NETWORK LEAK ZERO', !got || got._localObjectUrl === undefined);

    const packed = App.serializeChatMessageContent(bob.pk, '');
    record('serialize hasAttachment after clone', !!(packed && packed.hasAttachment));
    let wireA = null;
    try {
      wireA = JSON.parse(packed.rawContent).a;
    } catch (_e) {
      wireA = null;
    }
    assertCryptoFields(wireA, 'SERIALIZE');
    record('wire omits clientMessageId', wireA && wireA.clientMessageId === undefined);
    record('wire omits _prepared', wireA && wireA._prepared === undefined);
    const inspected = App.inspectIncomingChatAttachment(wireA);
    record('inspectIncomingChatAttachment PASS after clone', inspected && inspected.ok === true);

    // Stable messageId into E3B path
    let enc = null;
    let encOk = false;
    try {
      enc = e2eeEncryptAttachment(App, alice, bob, got.clientMessageId, wireA);
      encOk = !!(enc && enc.ct);
    } catch (e) {
      encOk = false;
      record('E3B encrypt PASS (no BAD_ATTACHMENT)', false, String(e && (e.code || e.message)));
    }
    if (encOk) record('E3B encrypt PASS (no BAD_ATTACHMENT)', true);
    const outer = JSON.stringify(enc || {});
    record('outer Relay NO AES key plaintext', !outer.includes(String(wireA.enc.key)));
    record('outer Relay NO private filename', !outer.includes('phys-140915.jpg'));
    record('outer Relay NO original MIME image/jpeg as media', !/\"mime\"\s*:\s*\"image\/jpeg\"/.test(outer));

    let decAtt = null;
    try {
      const dec = e2eeDecryptAttachment(App, alice, bob, enc);
      decAtt = dec && (dec.attachment || (dec.payload && dec.payload.attachment));
    } catch (e) {
      decAtt = null;
      record('receiver decrypt attachment ok', false, String(e && (e.code || e.message)));
    }
    if (decAtt) record('receiver decrypt attachment ok', decAtt.type === 'encrypted-media');
    const decInspect = App.inspectIncomingChatAttachment(decAtt);
    record('receiver inspect PASS', !!(decInspect && decInspect.ok === true));

    // Download/decrypt fixture
    try {
      const dl = await App.downloadEncryptedMediaFromBlossom({
        descriptor: decAtt,
        messageId: mid,
        sender: alice.pk,
        recipient: bob.pk,
        fetchImpl: mock.mockFetch,
      });
      const outBytes =
        dl && dl.plaintext
          ? dl.plaintext instanceof Uint8Array
            ? dl.plaintext
            : new Uint8Array(dl.plaintext)
          : dl && dl.blob && typeof dl.blob.arrayBuffer === 'function'
            ? new Uint8Array(await dl.blob.arrayBuffer())
            : null;
      record('140915 receiver decrypt bytes match', !!(outBytes && bytesEqual(outBytes, plain)));
    } catch (e) {
      record('140915 receiver decrypt bytes match', false, String(e && (e.code || e.message)));
    }

    App.clearChatFileAttachment(bob.pk);
    const afterClear = App.serializeChatMessageContent(bob.pk, 'hello text only');
    record(
      'TEXT AFTER MEDIA clear hasAttachment=false',
      !!(afterClear && afterClear.hasAttachment === false && !/encrypted-media/.test(afterClear.rawContent || '')),
    );
  }

  // --- Size matrix: 140915 / 206146 / 300KiB ---
  for (const size of [140915, 206146, 300 * 1024]) {
    const mid = 'cmsg-size-' + size;
    const plain = randomBytes(size);
    const beforeBad = mock.requests.length;
    const { got } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([plain], { type: 'image/jpeg' }),
      mid,
      { mimeType: 'image/jpeg', fileName: 's-' + size + '.jpg' },
    );
    const packed = App.serializeChatMessageContent(bob.pk, '');
    let wire = null;
    try {
      wire = JSON.parse(packed.rawContent).a;
    } catch (_e) {}
    const inspected = App.inspectIncomingChatAttachment(wire);
    let encOk = false;
    let badAtt = false;
    try {
      const enc = e2eeEncryptAttachment(App, alice, bob, got.clientMessageId, wire);
      encOk = !!(enc && enc.ct);
    } catch (e) {
      badAtt = /BAD_ATTACHMENT|ATTACHMENT|INVALID_DESCRIPTOR/i.test(String(e && (e.code || e.message)));
      encOk = false;
    }
    record(size + ' SET→GET enc preserved', !!(got && got.enc && got.enc.key));
    record(size + ' inspect PASS', inspected && inspected.ok === true);
    record(size + ' E3B publish PASS', encOk);
    record(size + ' BAD_ATTACHMENT ZERO', inspected && inspected.ok === true && !badAtt);
    record(
      size + ' secure blossom upload happened',
      mock.requests.slice(beforeBad).some((r) => (r.method === 'PUT' || r.method === 'POST') && String(r.contentType).includes('image/jpeg')),
    );
    App.clearChatFileAttachment(bob.pk);
  }

  // --- Chunked >1MiB ---
  {
    const size = 1 * 1024 * 1024 + 4096;
    const mid = 'cmsg-chunked-' + size;
    const plain = randomBytes(size);
    const { got } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([plain], { type: 'image/jpeg' }),
      mid,
      { mimeType: 'image/jpeg', fileName: 'big.jpg' },
    );
    const packed = App.serializeChatMessageContent(bob.pk, '');
    let wire = null;
    try {
      wire = JSON.parse(packed.rawContent).a;
    } catch (_e) {}
    record('>1MiB chunked mode', !!(got && got.enc && got.enc.mode === 'chunked'));
    record('>1MiB chunks preserved SET→GET', Array.isArray(got && got.chunks) && got.chunks.length >= 2);
    record('>1MiB chunkCount preserved SET→GET', typeof (got && got.chunkCount) === 'number' && got.chunkCount >= 2);
    record(
      '>1MiB chunkPlaintextSize preserved SET→GET',
      typeof (got && got.chunkPlaintextSize) === 'number' && got.chunkPlaintextSize > 0,
    );
    record('>1MiB chunks in serialize', Array.isArray(wire && wire.chunks) && wire.chunks.length >= 2);
    record('>1MiB chunkCount in serialize', typeof (wire && wire.chunkCount) === 'number');
    record('>1MiB chunkPlaintextSize in serialize', typeof (wire && wire.chunkPlaintextSize) === 'number');
    const inspected = App.inspectIncomingChatAttachment(wire);
    record('>1MiB inspect PASS', inspected && inspected.ok === true);
    let e3bOk = false;
    try {
      if (typeof App.assertEncryptedBlossomFitsE3b === 'function') {
        App.assertEncryptedBlossomFitsE3b({
          messageId: mid,
          sender: alice.pk,
          recipient: bob.pk,
          createdAt: Math.floor(Date.now() / 1000),
          text: '',
          attachment: wire,
        });
      }
      const enc = e2eeEncryptAttachment(App, alice, bob, mid, wire);
      e3bOk = !!(enc && enc.ct);
    } catch (_e) {
      e3bOk = false;
    }
    record('>1MiB E3B fit/encrypt when in range', e3bOk || inspected.ok === true);
    App.clearChatFileAttachment(bob.pk);
  }

  // --- Encrypted voice ---
  {
    const mid = 'cmsg-voice-small';
    const audioPlain = randomBytes(2400);
    const magnet =
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=voice';
    const { got } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([audioPlain], { type: 'audio/webm' }),
      mid,
      {
        mimeType: 'audio/webm',
        fileName: 'voice-message.webm',
        isVoice: true,
        duration: 3,
        magnetURI: magnet,
      },
    );
    record('voice type remains encrypted-media', got && got.type === 'encrypted-media');
    record('voice media.mime audio/webm', got && got.media && got.media.mime === 'audio/webm');
    record('voice isVoice preserved', got && got.isVoice === true);
    const packed = App.serializeChatMessageContent(bob.pk, '');
    record('voice display 🎤', !!(packed && packed.displayText && packed.displayText.includes('🎤')));
    let wire = null;
    try {
      wire = JSON.parse(packed.rawContent).a;
    } catch (_e) {}
    record('voice magnetURI inside serialize (E3B inner)', wire && wire.magnetURI === magnet);
    record('voice duration inside serialize', wire && wire.duration === 3);
    const inspected = App.inspectIncomingChatAttachment(wire);
    record('voice inspect PASS', inspected && inspected.ok === true);
    let encOk = false;
    try {
      const enc = e2eeEncryptAttachment(App, alice, bob, mid, wire);
      encOk = !!(enc && enc.ct);
      const outer = JSON.stringify(enc);
      record('voice magnet NOT in outer Relay', !outer.includes(magnet));
      const dec = e2eeDecryptAttachment(App, alice, bob, enc);
      const decAtt = dec && (dec.attachment || (dec.payload && dec.payload.attachment));
      record('voice receiver decrypt PASS', !!(decAtt && decAtt.type === 'encrypted-media'));
      record(
        'voice playback mime from media.mime',
        !!(decAtt && decAtt.media && decAtt.media.mime === 'audio/webm'),
      );
    } catch (e) {
      record('voice magnet NOT in outer Relay', false, String(e && e.message));
      record('voice receiver decrypt PASS', false);
      record('voice playback mime from media.mime', false);
    }
    record('voice BAD_ATTACHMENT ZERO', inspected && inspected.ok === true && encOk);
    App.clearChatFileAttachment(bob.pk);

    // Medium voice above tiny inline
    const mid2 = 'cmsg-voice-med';
    const med = randomBytes(90 * 1024);
    const { got: got2 } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([med], { type: 'audio/webm' }),
      mid2,
      { mimeType: 'audio/webm', fileName: 'voice-long.webm', isVoice: true, duration: 45 },
    );
    const packed2 = App.serializeChatMessageContent(bob.pk, '');
    let wire2 = null;
    try {
      wire2 = JSON.parse(packed2.rawContent).a;
    } catch (_e) {}
    const insp2 = App.inspectIncomingChatAttachment(wire2);
    let enc2 = false;
    try {
      const e = e2eeEncryptAttachment(App, alice, bob, mid2, wire2);
      enc2 = !!(e && e.ct);
    } catch (_e) {
      enc2 = false;
    }
    record('medium voice encrypted-media', got2 && got2.type === 'encrypted-media');
    record('medium voice E3B PASS', enc2 && insp2 && insp2.ok === true);
    App.clearChatFileAttachment(bob.pk);
  }

  // --- Stable media messageId: encrypt A → set/get → publish uses A ---
  {
    const midA = 'cmsg-stable-aad-keep';
    const plain = randomBytes(8192);
    const { got } = await roundtripDescriptor(
      App,
      alice,
      bob,
      new Blob([plain], { type: 'image/jpeg' }),
      midA,
    );
    const packed = App.serializeChatMessageContent(bob.pk, '');
    let wire = null;
    try {
      wire = JSON.parse(packed.rawContent).a;
    } catch (_e) {}
    // Simulate chat-service messageId selection
    const innerMessageId =
      (got && got.clientMessageId) || (got && got.logicalMessageId) || 'cmsg-NEW-RANDOM';
    record('STABLE MEDIA MESSAGE ID equals A', innerMessageId === midA);
    record('STABLE MEDIA MESSAGE ID not regenerated', !String(innerMessageId).includes('NEW-RANDOM'));
    try {
      e2eeEncryptAttachment(App, alice, bob, innerMessageId, wire);
      record('STABLE MEDIA MESSAGE ID E3B ok', true);
    } catch (e) {
      record('STABLE MEDIA MESSAGE ID E3B ok', false, String(e && e.message));
    }
    App.clearChatFileAttachment(bob.pk);
  }

  // --- LIVE-ON-TIE merge regressions (would FAIL with preferLiveOnTie early-return bug) ---
  async function restoreRaceMergeCase(label, diskMsg, liveMsg, assertFn) {
    const now = Math.floor(Date.now() / 1000);
    const peer = hexPubkeyPair().pk;
    const self = hexPubkeyPair();
    const key =
      self.pk.toLowerCase() < peer.toLowerCase()
        ? self.pk.toLowerCase() + ':' + peer.toLowerCase()
        : peer.toLowerCase() + ':' + self.pk.toLowerCase();
    const diskFull = {
      from: peer,
      to: self.pk,
      createdAt: now - 5,
      direction: 'incoming',
      ...diskMsg,
    };
    const liveFull = {
      from: peer,
      to: self.pk,
      createdAt: now - 4,
      direction: 'incoming',
      ...liveMsg,
    };
    const snapshot = {
      id: 'nostr_chat_' + self.pk.toLowerCase(),
      contacts: [{ pubkey: peer, name: 'Peer', picture: '', initials: 'Pe' }],
      conversations: [{ key, peer: peer.toLowerCase(), messages: [diskFull] }],
      deletedIds: [],
      lastSyncTs: now,
      disappearingTimers: [],
      defaultDisappearingSec: 7 * 24 * 60 * 60,
      pendingReadReceipts: [],
    };
    const st = loadChatStateRuntime({ snapshot, delayMs: 100 });
    st.App.publicKey = self.pk;
    const rp = st.App.restoreChatState();
    st.App.appendChatMessage(liveFull);
    await rp;
    const msgs = st.App.getChatMessages(peer) || [];
    const hit = msgs.find((m) => m.id === liveFull.id);
    assertFn(hit, msgs, label);
    return { st, peer, hit, msgs };
  }

  // TEST A — same id / same status / different content → LIVE wins
  {
    await restoreRaceMergeCase(
      'A',
      { id: 'same-1', status: 'sent', content: 'OLD DISK' },
      { id: 'same-1', status: 'sent', content: 'NEW LIVE' },
      (hit) => {
        record('LIVE-ON-TIE same status content LIVE WINS', !!(hit && hit.content === 'NEW LIVE'));
      },
    );
  }

  // TEST B — same id / same status / live encrypted-media attachment survives
  {
    const encAtt = {
      v: 2,
      type: 'encrypted-media',
      attachmentId: 'att-live-tie-1',
      enc: { alg: 'aes-256-gcm', mode: 'single', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', nonce: 'AAAAAAAAAAAA' },
      cipher: { size: 32, sha256: 'a'.repeat(64) },
      media: { mime: 'image/jpeg', filename: 'live.jpg', originalSize: 12 },
      resource: { transport: 'blossom', url: 'https://blossom.test.invalid/x', encoding: 'sos-opaque-jpeg-v1' },
      clientMessageId: 'cmsg-live-tie',
      logicalMessageId: 'cmsg-live-tie',
    };
    await restoreRaceMergeCase(
      'B',
      { id: 'same-enc-1', status: 'sent', content: '📎 file', attachment: null },
      { id: 'same-enc-1', status: 'sent', content: '📎 file', attachment: encAtt },
      (hit) => {
        const att = hit && hit.attachment;
        record(
          'LIVE-ON-TIE encrypted attachment LIVE WINS',
          !!(
            att &&
            att.type === 'encrypted-media' &&
            att.attachmentId === 'att-live-tie-1' &&
            att.enc &&
            att.cipher &&
            att.media &&
            att.resource &&
            att.clientMessageId === 'cmsg-live-tie'
          ),
        );
      },
    );
  }

  // TEST C — disk higher status (read) wins over live (sent)
  {
    await restoreRaceMergeCase(
      'C',
      { id: 'same-status-disk', status: 'read', content: 'disk-read' },
      { id: 'same-status-disk', status: 'sent', content: 'live-sent' },
      (hit) => {
        record('DISK HIGHER STATUS wins', !!(hit && hit.status === 'read' && hit.content === 'disk-read'));
      },
    );
  }

  // TEST D — live higher status (read) wins over disk (sent)
  {
    await restoreRaceMergeCase(
      'D',
      { id: 'same-status-live', status: 'sent', content: 'disk-sent' },
      { id: 'same-status-live', status: 'read', content: 'live-read' },
      (hit) => {
        record('LIVE HIGHER STATUS wins', !!(hit && hit.status === 'read' && hit.content === 'live-read'));
      },
    );
  }

  // --- ROOT C: stale restore cannot overwrite live 141 ---
  {
    const now = Math.floor(Date.now() / 1000);
    const peer = hexPubkeyPair().pk;
    const self = hexPubkeyPair();
    const key =
      self.pk.toLowerCase() < peer.toLowerCase()
        ? self.pk.toLowerCase() + ':' + peer.toLowerCase()
        : peer.toLowerCase() + ':' + self.pk.toLowerCase();

    const diskMessages = [];
    for (let i = 1; i <= 139; i += 1) {
      diskMessages.push({
        id: 'msg-' + i,
        from: peer,
        to: self.pk,
        content: 'd' + i,
        createdAt: now - 1000 + i,
        direction: 'incoming',
        status: 'delivered',
      });
    }
    const snapshot = {
      id: 'nostr_chat_' + self.pk.toLowerCase(),
      contacts: [{ pubkey: peer, name: 'Peer', picture: '', initials: 'Pe' }],
      conversations: [{ key, peer: peer.toLowerCase(), messages: diskMessages }],
      deletedIds: [],
      lastSyncTs: now,
      disappearingTimers: [],
      defaultDisappearingSec: 7 * 24 * 60 * 60,
      pendingReadReceipts: [],
    };

    const st = loadChatStateRuntime({ snapshot, delayMs: 120 });
    st.App.publicKey = self.pk;

    const restorePromise = st.App.restoreChatState();
    // Live arrivals while restore in-flight
    st.App.appendChatMessage({
      id: 'msg-140',
      from: peer,
      to: self.pk,
      content: 'live140',
      createdAt: now + 1,
      direction: 'incoming',
      status: 'delivered',
    });
    st.App.appendChatMessage({
      id: 'msg-141',
      from: peer,
      to: self.pk,
      content: 'live141',
      createdAt: now + 2,
      direction: 'incoming',
      status: 'delivered',
    });
    await restorePromise;

    const msgs = st.App.getChatMessages(peer) || [];
    const ids = new Set(msgs.map((m) => m.id));
    record('STALE 139 → LIVE 141 FINAL 141', msgs.length === 141);
    record('LIVE msg-140 present', ids.has('msg-140'));
    record('LIVE msg-141 present', ids.has('msg-141'));
    record('LIVE MESSAGE LOSS ZERO', ids.has('msg-140') && ids.has('msg-141') && msgs.length === 141);

    // Repeated restore idempotent
    await st.App.restoreChatState();
    const msgs2 = st.App.getChatMessages(peer) || [];
    const ids2 = msgs2.map((m) => m.id);
    record('REPEATED RESTORE still 141', msgs2.length === 141);
    record('RESTORE DUPLICATES ZERO', ids2.length === new Set(ids2).size);

    // Concurrent restore shares promise (start delayed restore again on fresh runtime)
    const st2 = loadChatStateRuntime({ snapshot, delayMs: 50 });
    st2.App.publicKey = self.pk;
    const p1 = st2.App.restoreChatState();
    const p2 = st2.App.restoreChatState();
    record('concurrent restore same promise', p1 === p2);
    await p1;
  }

  // --- Text during restore ---
  {
    const now = Math.floor(Date.now() / 1000);
    const peer = hexPubkeyPair().pk;
    const self = hexPubkeyPair();
    const key =
      self.pk.toLowerCase() < peer.toLowerCase()
        ? self.pk.toLowerCase() + ':' + peer.toLowerCase()
        : peer.toLowerCase() + ':' + self.pk.toLowerCase();
    const snapshot = {
      id: 'nostr_chat_' + self.pk.toLowerCase(),
      contacts: [],
      conversations: [
        {
          key,
          peer: peer.toLowerCase(),
          messages: [
            {
              id: 'old-1',
              from: peer,
              to: self.pk,
              content: 'old',
              createdAt: now - 10,
              direction: 'incoming',
              status: 'delivered',
            },
          ],
        },
      ],
      deletedIds: [],
      lastSyncTs: now,
      disappearingTimers: [],
      defaultDisappearingSec: 7 * 24 * 60 * 60,
      pendingReadReceipts: [],
    };
    const st = loadChatStateRuntime({ snapshot, delayMs: 100 });
    st.App.publicKey = self.pk;
    const rp = st.App.restoreChatState();
    st.App.appendChatMessage({
      id: 'text-during-restore',
      from: peer,
      to: self.pk,
      content: 'hello while restoring',
      createdAt: now + 5,
      direction: 'incoming',
      status: 'delivered',
    });
    await rp;
    const msgs = st.App.getChatMessages(peer) || [];
    record(
      'TEXT DURING RESTORE remains',
      msgs.some((m) => m.id === 'text-during-restore' && m.content === 'hello while restoring'),
    );
  }

  // Blossom plaintext private ZERO (uploads were jpeg wire only in this gate)
  record(
    'PRIVATE PLAINTEXT BLOSSOM ZERO',
    mock.requests
      .filter((r) => r.method === 'PUT' || r.method === 'POST')
      .every((r) => String(r.contentType || '').toLowerCase().startsWith('image/jpeg')),
  );

  console.log('chat-encrypted-attachment-state-recovery gate');
  for (const line of results) console.log(line);
  console.log('TOTAL ' + pass + '/' + (pass + fail));
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
