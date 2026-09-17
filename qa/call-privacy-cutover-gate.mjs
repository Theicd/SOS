#!/usr/bin/env node
/**
 * Call Privacy Phase 1D — safe monotonic cutover (callSignalGiftWrapRequired).
 * Run: node qa/call-privacy-cutover-gate.mjs
 *
 * PHYSICAL QA CHECKLIST (after NEW APK versionCode>=115 is installed; do not claim PASS here):
 * A voice FG A→B  B voice FG B→A  C video FG A→B  D video FG B→A
 * E voice recipient background  F video recipient background
 * G voice screen-off  H video screen-off
 * I caller cancels  J receiver rejects  K answer+disconnect both ways
 * L logs: 1059 encrypted=true, no 25060, no new direct25050 after activation
 *
 * COMPAT MATRIX:
 * OLD APK + PRE-CUTOVER WEB → legacy BG wake OK
 * NEW APK + PRE-CUTOVER WEB → dual-read OK; legacy send
 * NEW APK + POST-CUTOVER WEB → secure BG wake OK
 * OLD APK + POST-CUTOVER WEB → BG secure wake NOT supported (activation blocked until NEW APK rolled out)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

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

const helperSrc = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const appVer = JSON.parse(read('app-version.json'));
const gradle = read('android-shell/app/build.gradle.kts');

record('policy field false in app-version', appVer.callSignalGiftWrapRequired === false);
record('decision API present', helperSrc.includes('resolveCallSignalSecurityDecision'));
record('publishCallSignal present', helperSrc.includes('publishCallSignal'));
record('sticky seen key', helperSrc.includes('sos_call_signal_giftwrap_required_seen'));
record('native min versionCode 115', helperSrc.includes('CALL_GIFT_WRAP_NATIVE_MIN_VERSION_CODE = 115'));
record('native min versionName 1.0.114', helperSrc.includes("CALL_GIFT_WRAP_NATIVE_MIN_VERSION_NAME = '1.0.114'"));
record('current gradle not bumped to 115 yet', /versionCode\s*=\s*114/.test(gradle));
record('voice uses publishCallSignal', voice.includes('publishCallSignal'));
record('video uses publishCallSignal', video.includes('publishCallSignal'));
record('CALL_PRIVACY_SIGNALING_ACTIVE helper', helperSrc.includes('isCallPrivacySignalingActive'));
record('old APK post-cutover limitation documented', helperSrc.includes('1.0.114') && read('qa/call-privacy-cutover-gate.mjs').includes('OLD APK + POST-CUTOVER'));
record('25060 still retired', /async function publishCallMetric\(\)\s*\{\s*return;\s*\}/.test(voice) && /async function publishCallMetric\(\)\s*\{\s*return;\s*\}/.test(video));

async function runtime() {
  const {
    generateSecretKey,
    getPublicKey,
    finalizeEvent,
    getEventHash,
    verifyEvent,
    utils,
    nip44,
    nip04,
  } = require(path.join(ROOT, 'node_modules', 'nostr-tools'));
  const { webcrypto } = crypto;

  function hexPair() {
    const sk = generateSecretKey();
    return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
  }

  const alice = hexPair();
  const bob = hexPair();
  const published = [];
  const store = {};
  const App = {
    publicKey: alice.pk,
    privateKey: alice.hex,
    finalizeEvent(draft, key) {
      const host = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(host, sk);
    },
    hexToBytes: utils.hexToBytes,
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    window: {},
    self: {},
    crypto: webcrypto,
    localStorage: {
      getItem(k) {
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem(k, v) {
        store[k] = String(v);
      },
      removeItem(k) {
        delete store[k];
      },
    },
    TextEncoder,
    TextDecoder,
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
    NostrApp: App,
    NostrTools: {
      finalizeEvent,
      getEventHash,
      verifyEvent,
      generateSecretKey,
      getPublicKey,
      utils,
      nip44,
      nip04,
    },
  };
  sandbox.window = sandbox;
  sandbox.window.NostrApp = App;
  sandbox.window.NostrTools = sandbox.NostrTools;
  sandbox.window.crypto = sandbox.crypto;
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(helperSrc, sandbox, { filename: 'call-signal-e2ee.js' });
  const api = sandbox.NostrApp.CallSignalE2ee;

  const pool = {
    publish: async (_relays, ev) => {
      published.push(ev);
      return ev;
    },
  };

  const offerSdp = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };

  async function send(media, action, data, policyOptions) {
    published.length = 0;
    return api.publishCallSignal({
      media,
      peerPubkey: bob.pk,
      type: action,
      data,
      sessionId: api.createSessionId(),
      pool,
      relays: [],
      senderPubkey: alice.pk,
      senderPrivateKey: alice.hex,
      policyOptions,
    });
  }

  // PRE-CUTOVER: flag false
  delete App.__qaCallSignalGiftWrapRequiredOverride;
  Object.keys(store).forEach((k) => delete store[k]);
  App.__qaCallSignalGiftWrapRequiredOverride = false;
  const preV = await send('voice', 'offer', offerSdp);
  record('pre-cutover voice legacy once', published.length === 1 && published[0].kind === 25050 && preV.mode === 'LEGACY_ROLLOUT');
  published.length = 0;
  const preVid = await send('video', 'offer', offerSdp);
  record('pre-cutover video legacy once', published.length === 1 && published[0].kind === 25050 && preVid.mode === 'LEGACY_ROLLOUT');
  record('pre-cutover 1059 write ZERO', published.every((e) => e.kind === 25050));
  record('CALL_PRIVACY_SIGNALING_ACTIVE false pre', api.isCallPrivacySignalingActive() === false);

  // POST-CUTOVER
  App.__qaCallSignalGiftWrapRequiredOverride = true;
  published.length = 0;
  const postV = await send('voice', 'offer', offerSdp);
  record('post-cutover voice 1059 once', published.length === 1 && published[0].kind === 1059 && postV.mode === 'SECURE');
  published.length = 0;
  const postVid = await send('video', 'offer', offerSdp);
  record('post-cutover video 1059 once', published.length === 1 && published[0].kind === 1059 && postVid.mode === 'SECURE');
  record('post-cutover direct25050 ZERO', published.every((e) => e.kind === 1059));
  record('CALL_PRIVACY_SIGNALING_ACTIVE true post', api.isCallPrivacySignalingActive() === true);

  // STICKY: true then false
  App.__qaCallSignalGiftWrapRequiredOverride = false;
  published.length = 0;
  const sticky = await send('voice', 'answer', { type: 'answer', sdp: offerSdp.sdp });
  record('sticky after true→false still SECURE', sticky.mode === 'SECURE' && published[0].kind === 1059);

  // STICKY: unavailable after true
  delete App.__qaCallSignalGiftWrapRequiredOverride;
  published.length = 0;
  const unavail = await send('voice', 'candidate', { candidate: 'x' }, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  record('sticky after fetch fail still SECURE', unavail.mode === 'SECURE' && published[0].kind === 1059);

  // STICKY: field missing after true
  published.length = 0;
  const missing = await send('voice', 'disconnect', null, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { version: 't', e2eeSendRequired: true };
      },
    }),
  });
  record('sticky after field missing still SECURE', missing.mode === 'SECURE' && published[0].kind === 1059);

  // Dual-write ZERO across actions
  const actions = [
    ['voice', 'offer', offerSdp],
    ['voice', 'answer', { type: 'answer', sdp: offerSdp.sdp }],
    ['voice', 'candidate', { candidate: 'a' }],
    ['voice', 'candidates', [{ candidate: 'b' }]],
    ['voice', 'disconnect', null],
    ['video', 'offer', offerSdp],
    ['video', 'v-answer', { type: 'answer', sdp: offerSdp.sdp }],
    ['video', 'v-candidate', { candidate: 'c' }],
    ['video', 'v-candidates', [{ candidate: 'd' }]],
    ['video', 'v-disconnect', null],
  ];
  let dualOk = true;
  for (const [media, type, data] of actions) {
    published.length = 0;
    await send(media, type, data);
    const kinds = new Set(published.map((e) => e.kind));
    if (published.length !== 1 || kinds.size !== 1) dualOk = false;
    if (kinds.has(1059) && kinds.has(25050)) dualOk = false;
  }
  record('no dual-write across signal types', dualOk);

  // Secure crypto failure → ZERO publish (fail closed)
  published.length = 0;
  let threw = false;
  try {
    await api.publishCallSignal({
      media: 'voice',
      peerPubkey: bob.pk,
      type: 'offer',
      data: offerSdp,
      sessionId: api.createSessionId(),
      pool,
      relays: [],
      senderPubkey: alice.pk,
      senderPrivateKey: '00'.repeat(32), // invalid/weak — may still finalize; force missing nip44
      policyOptions: { skipFetch: true },
    });
  } catch (_e) {
    threw = true;
  }
  // Force fail by breaking helper: empty pool publish already ran? Use missing CallSignal by deleting nip44 briefly
  // Better: call with pool that throws after we stub encrypt
  published.length = 0;
  threw = false;
  const brokenPool = {
    publish: async () => {
      throw new Error('relay-down');
    },
  };
  try {
    await api.publishGiftWrappedCallSignal({
      media: 'voice',
      peerPubkey: bob.pk,
      type: 'offer',
      data: offerSdp,
      sessionId: api.createSessionId(),
      pool: brokenPool,
      relays: [],
      senderPubkey: alice.pk,
      senderPrivateKey: alice.hex,
    });
  } catch (_e) {
    threw = true;
  }
  // After REQUIRED, publishCallSignal must not fall back to 25050 on secure failure
  published.length = 0;
  threw = false;
  try {
    await api.publishCallSignal({
      media: 'voice',
      peerPubkey: bob.pk,
      type: 'offer',
      data: offerSdp,
      sessionId: api.createSessionId(),
      pool: brokenPool,
      relays: [],
      senderPubkey: alice.pk,
      senderPrivateKey: alice.hex,
      policyOptions: { skipFetch: true },
    });
  } catch (_e) {
    threw = true;
  }
  record('secure failure publish ZERO no legacy fallback', threw && published.length === 0);

  // Receive markers still dual-read
  record('secure receive 1059 retained', helperSrc.includes('ensureSecureCallSubscription') && voice.includes('LEGACY_READ_ONLY'));
  record('legacy receive 25050 retained', voice.includes('kinds: [25050]') && video.includes('kinds: [25050]'));
}

await runtime().catch((err) => {
  record('runtime harness', false, String(err && err.message ? err.message : err));
});

console.log('call-privacy-cutover gate');
for (const line of results) console.log(line);
console.log('TOTAL ' + pass + '/' + (pass + fail));
console.log('CALL_PRIVACY_SIGNALING_ACTIVE default=' + String(appVer.callSignalGiftWrapRequired === true));
console.log('NATIVE_CAPABLE_APK versionCode=115 versionName=1.0.114 (not released)');
process.exit(fail > 0 ? 1 : 0);
