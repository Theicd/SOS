#!/usr/bin/env node
/**
 * Phase 1 — Private P2P kind 30078 must use NIP-44 (no plaintext outbound).
 * Run: node qa/p2p-private-30078-e2ee-gate.mjs
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
  verifyEvent,
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

function hexPair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

function loadP2pRuntime(overrides = {}) {
  const alice = hexPair();
  const bob = hexPair();
  const published = [];
  const App = {
    publicKey: alice.pk,
    privateKey: alice.hex,
    hexToBytes: utils.hexToBytes,
    pool: {
      publish(_relays, event) {
        published.push(event);
        return [];
      },
      subscribeMany() {
        return { close() {} };
      },
    },
    finalizeEvent(draft, key) {
      const host = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(host, sk);
    },
    ...overrides.app,
  };

  const localStorage = {
    store: {},
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null;
    },
    setItem(k, v) {
      this.store[k] = String(v);
    },
    removeItem(k) {
      delete this.store[k];
    },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    window: {},
    self: {},
    navigator: { userAgent: 'NodeQA', onLine: true },
    document: { readyState: 'complete', addEventListener() {}, hidden: false },
    localStorage,
    crypto: webcrypto,
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
    Error,
    TypeError,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    btoa(s) {
      return Buffer.from(String(s), 'binary').toString('base64');
    },
    atob(s) {
      return Buffer.from(String(s), 'base64').toString('binary');
    },
    NostrApp: App,
    NostrTools: { finalizeEvent, utils, nip44, verifyEvent, generateSecretKey, getPublicKey },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.crypto = sandbox.crypto;
  sandbox.window.localStorage = localStorage;
  // Disable PeerExchange relay bypass for outbound Nostr path tests.
  App.PeerExchange = null;

  vm.createContext(sandbox);
  // Minimal stubs often required before p2p-video-sharing
  vm.runInContext(
    `
    window.NostrApp = NostrApp;
    window.NostrTools = NostrTools;
    window.localStorage = localStorage;
    window.NostrP2P_SIGNAL_ENCRYPTION = false; // must NOT matter for private path
    `,
    sandbox,
  );
  vm.runInContext(read('p2p-video-sharing.js'), sandbox, { filename: 'p2p-video-sharing.js' });

  return { App: sandbox.NostrApp, alice, bob, published, sandbox };
}

async function run() {
  const src = read('p2p-video-sharing.js');
  const fileSrc = read('chat-p2p-file.js');
  const uiSrc = read('chat-file-transfer-ui.js');
  const p2pFileSrc = read('chat-p2p-file.js');
  const blossomSrc = read('blossom.js');
  const chatE2ee = read('chat-e2ee.js');
  const voice = read('chat-voice-call.js');
  const video = read('chat-video-call.js');
  const dc = read('chat-p2p-datachannel.js');

  record('private prepareSignalContent has no plaintext fallback', !/שולח כטקסט גלוי/.test(src));
  record('encrypt fail code present', src.includes('P2P_PRIVATE_SIGNAL_ENCRYPT_FAILED'));
  record('envelope family sos-p2p-signal', src.includes("sos-p2p-signal"));
  record('private path ignores NostrP2P_SIGNAL_ENCRYPTION flag', /void SIGNAL_ENCRYPTION_ENABLED|intentionally unused for private path/.test(src));
  record('legacy read only marker', src.includes('LEGACY_READ_ONLY'));
  record('public heartbeat still present', src.includes('p2p-heartbeat') && src.includes('sendHeartbeat'));
  record('public file availability still present', src.includes('p2p-file') && src.includes('doRegisterFileAvailability'));
  record('P2P chunk 64KiB unchanged', /const CHUNK_SIZE = 64 \* 1024/.test(p2pFileSrc));
  record('P2P threshold 92160 unchanged', /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(uiSrc));
  record('opaque jpeg unchanged', blossomSrc.includes('sos-opaque-jpeg-v1'));
  record('chat E3B nip44 unchanged', chatE2ee.includes("alg: 'nip44'") || chatE2ee.includes('nip44'));
  record('calls 25050 unchanged marker', voice.includes('25050') && video.includes('25050'));
  record('DC 25055 unchanged marker', dc.includes('25055'));
  record('file-offer still built in chat-p2p-file', fileSrc.includes("type: 'file-offer'") && fileSrc.includes('keyStr'));

  const rt = loadP2pRuntime();
  const { App, alice, bob, published } = rt;

  // Force keys into module via App + any guest path: getEffectiveKeys reads App
  App.publicKey = alice.pk;
  App.privateKey = alice.hex;

  const privateTypes = [
    {
      type: 'file-offer',
      data: {
        fileId: 'test-private-file-1',
        name: 'secret-document.txt',
        mimeType: 'text/plain',
        size: 132119,
        caption: 'PRIVATE CAPTION',
        keyStr: 'TEST_SECRET_AES_KEY',
        totalChunks: 3,
        createdAt: Math.floor(Date.now() / 1000),
      },
    },
    { type: 'chunk-ack', data: { fileId: 'test-private-file-1', index: 0 } },
    { type: 'file-resend-request', data: { fileId: 'test-private-file-1', fromChunk: 1 } },
    { type: 'file-ready', data: { fileId: 'test-private-file-1' } },
    {
      type: 'file-request',
      data: { hash: 'a'.repeat(64), connectionId: 'c1', offer: { type: 'offer', sdp: 'v=0' } },
    },
    {
      type: 'file-response',
      data: { hash: 'a'.repeat(64), connectionId: 'c1', answer: { type: 'answer', sdp: 'v=0' } },
    },
    {
      type: 'ice-candidate',
      data: { hash: 'a'.repeat(64), connectionId: 'c1', candidate: { candidate: 'candidate:1', sdpMid: '0' } },
    },
  ];

  for (const msg of privateTypes) {
    published.length = 0;
    const before = published.length;
    await App.sendP2PSignal(bob.pk, msg.type, msg.data);
    record(msg.type + ' published once', published.length === before + 1);
    const ev = published[published.length - 1];
    record(msg.type + ' kind 30078', ev && ev.kind === 30078);
    record(msg.type + ' signature valid', !!(ev && verifyEvent(ev)));
    record(
      msg.type + ' recipient p tag',
      !!(ev && Array.isArray(ev.tags) && ev.tags.some((t) => t[0] === 'p' && t[1] === bob.pk)),
    );
    record(msg.type + ' enc=nip44 tag', !!(ev && ev.tags.some((t) => t[0] === 'enc' && t[1] === 'nip44')));
    const outer = String(ev && ev.content || '');
    const secrets = [
      'secret-document.txt',
      'text/plain',
      'PRIVATE CAPTION',
      'TEST_SECRET_AES_KEY',
      'test-private-file-1',
      '"type":"' + msg.type + '"',
    ];
    let leak = false;
    for (const s of secrets) {
      if (msg.type !== 'file-offer' && (s.includes('secret-document') || s.includes('PRIVATE') || s.includes('TEST_SECRET') || s.includes('text/plain'))) {
        continue;
      }
      if (outer.includes(s)) leak = true;
    }
    // Always assert type JSON not in outer plaintext for all private types
    if (outer.includes('"type":"' + msg.type + '"')) leak = true;
    if (msg.type === 'file-offer') {
      record('FILE-OFFER keyStr OUTER LEAK ZERO', !outer.includes('TEST_SECRET_AES_KEY'));
      record('FILE-OFFER filename OUTER LEAK ZERO', !outer.includes('secret-document.txt'));
      record('FILE-OFFER caption OUTER LEAK ZERO', !outer.includes('PRIVATE CAPTION'));
      record('FILE-OFFER mime OUTER LEAK ZERO', !outer.includes('text/plain'));
      record('FILE-OFFER fileId OUTER LEAK ZERO', !outer.includes('test-private-file-1'));
    }
    record(msg.type + ' outer is NIP44 envelope', App.looksLikePrivateP2pSignalEnvelope(outer));
    const plain = await App.decryptPrivateP2pSignalPayload(outer, alice.pk, bob.hex);
    const parsed = JSON.parse(plain);
    record(msg.type + ' decrypt recovers type', parsed && parsed.type === msg.type);
    if (msg.type === 'file-offer') {
      record(
        'FILE-OFFER decrypt recovers fields',
        parsed.data &&
          parsed.data.fileId === 'test-private-file-1' &&
          parsed.data.name === 'secret-document.txt' &&
          parsed.data.mimeType === 'text/plain' &&
          parsed.data.size === 132119 &&
          parsed.data.caption === 'PRIVATE CAPTION' &&
          parsed.data.keyStr === 'TEST_SECRET_AES_KEY' &&
          parsed.data.totalChunks === 3,
      );
    }
    record(msg.type + ' plaintext outbound ZERO', !leak && App.looksLikePrivateP2pSignalEnvelope(outer));
  }

  // Encrypt failure → publish ZERO
  {
    published.length = 0;
    const broken = loadP2pRuntime({
      app: {
        privateKey: 'not-a-key',
      },
    });
    broken.App.publicKey = broken.alice.pk;
    broken.App.privateKey = 'zz';
    let threw = false;
    let code = '';
    try {
      await broken.App.sendP2PSignal(broken.bob.pk, 'file-offer', {
        fileId: 'x',
        name: 'a.txt',
        keyStr: 'K',
        size: 1,
        mimeType: 'text/plain',
        totalChunks: 1,
      });
    } catch (e) {
      threw = true;
      code = e && e.code ? e.code : '';
    }
    record('ENCRYPT FAILURE threw', threw);
    record('ENCRYPT FAILURE code secure', code === 'P2P_PRIVATE_SIGNAL_ENCRYPT_FAILED');
    record('ENCRYPT FAILURE PUBLISH ZERO', broken.published.length === 0);
  }

  // Wrong recipient: encrypt for bob, decrypt as carol must fail; dispatch path via extract
  {
    const carol = hexPair();
    published.length = 0;
    await App.sendP2PSignal(bob.pk, 'file-offer', {
      fileId: 'test-private-file-1',
      name: 'secret-document.txt',
      mimeType: 'text/plain',
      size: 10,
      caption: 'PRIVATE CAPTION',
      keyStr: 'TEST_SECRET_AES_KEY',
      totalChunks: 1,
    });
    const ev = published[published.length - 1];
    let wrongOk = false;
    try {
      await App.decryptPrivateP2pSignalPayload(ev.content, alice.pk, carol.hex);
      wrongOk = true;
    } catch (_e) {
      wrongOk = false;
    }
    record('WRONG RECIPIENT decrypt REJECT', wrongOk === false);
  }

  // Tampered ciphertext
  {
    published.length = 0;
    await App.sendP2PSignal(bob.pk, 'chunk-ack', { fileId: 'f1', index: 0 });
    const ev = published[published.length - 1];
    const env = JSON.parse(ev.content);
    env.ct = env.ct.slice(0, -4) + 'AAAA';
    let tamperOk = false;
    try {
      await App.decryptPrivateP2pSignalPayload(JSON.stringify(env), alice.pk, bob.hex);
      tamperOk = true;
    } catch (_e) {
      tamperOk = false;
    }
    record('TAMPERED CIPHERTEXT REJECT', tamperOk === false);
  }

  // Invalid signature
  {
    published.length = 0;
    await App.sendP2PSignal(bob.pk, 'file-ready', { fileId: 'f1' });
    const ev = JSON.parse(JSON.stringify(published[published.length - 1]));
    ev.sig = '00'.repeat(64);
    record('INVALID SIGNATURE REJECT', App.verifyIncomingFileSignalEvent(ev) === false);
  }

  // Legacy read still accepted (extract)
  {
    const legacy = JSON.stringify({
      type: 'file-offer',
      data: {
        fileId: 'legacy-1',
        name: 'old.txt',
        keyStr: 'LEGACYKEY',
        size: 1,
        mimeType: 'text/plain',
        totalChunks: 1,
      },
    });
    App.publicKey = bob.pk;
    App.privateKey = bob.hex;
    const extracted = await App.extractPrivateP2pSignalContent(legacy, alice.pk);
    record('LEGACY PRIVATE READ PASS', !!(extracted && extracted.legacy === true && extracted.plaintext === legacy));
    // New outbound still encrypted only
    published.length = 0;
    App.publicKey = alice.pk;
    App.privateKey = alice.hex;
    await App.sendP2PSignal(bob.pk, 'file-offer', {
      fileId: 'new-1',
      name: 'new.txt',
      keyStr: 'NEWKEY',
      size: 1,
      mimeType: 'text/plain',
      totalChunks: 1,
    });
    record(
      'LEGACY PRIVATE WRITE ZERO',
      published.length === 1 && App.looksLikePrivateP2pSignalEnvelope(published[0].content),
    );
  }

  // Public heartbeat still does not use prepareSignalContent path / no #p
  {
    record(
      'PUBLIC heartbeat code path not encrypt-gated',
      /async function sendHeartbeat[\s\S]{0,900}kind:\s*FILE_AVAILABILITY_KIND/.test(src) &&
        !/async function sendHeartbeat[\s\S]{0,900}prepareSignalContent/.test(src),
    );
    record(
      'PUBLIC availability code path not encrypt-gated',
      /async function doRegisterFileAvailability[\s\S]{0,1200}prepareSignalContent/.test(src) === false,
    );
  }

  console.log('p2p-private-30078-e2ee gate');
  for (const line of results) console.log(line);
  console.log('TOTAL ' + pass + '/' + (pass + fail));
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
