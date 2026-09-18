#!/usr/bin/env node
/**
 * Call Privacy Phase 1C — single secure 1059 dispatch + background race fixes.
 * Run: node qa/call-privacy-phase1c-gate.mjs
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
const voiceUi = read('chat-voice-call-ui.js');
const store = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const push = read('push-trigger.js');
const indexHtml = read('index.html');

record('dispatcher exists', helperSrc.includes('dispatchGiftWrappedCallSignal'));
record('shared 1059 subscription', helperSrc.includes('ensureSecureCallSubscription') && helperSrc.includes('CALL_SECURE_SUBSCRIBE'));
record('voice no independent 1059 filter', !/kinds:\s*\[1059\]/.test(voice));
record('video no independent 1059 filter', !/kinds:\s*\[1059\]/.test(video));
record('voice handleSecureSignal no unwrap', voice.includes('handleSecureSignal') && !/handleSecureSignal[\s\S]{0,400}unwrapGiftWrappedCallSignal/.test(voice));
record('video handleSecureSignal no unwrap', video.includes('handleSecureSignal') && !/handleSecureSignal[\s\S]{0,400}unwrapGiftWrappedCallSignal/.test(video));
record('native ring after SDP normalize', /action === 'offer'[\s\S]{0,500}normalizeSessionDescription[\s\S]{0,400}authorizeNativeSecureOfferRing/.test(helperSrc));
record('invalid offer skips ring', helperSrc.includes("status: 'invalid_offer'") && helperSrc.includes('authorizeNativeSecureOfferRing'));
record('bounded secure queue', store.includes('KEY_SECURE_QUEUE') && store.includes('SECURE_QUEUE_MAX = 32') && store.includes('enqueueSecureWrap'));
record('queue drain API retained + peek API',
  store.includes('drainSecureWraps')
  && store.includes('peekSecureWraps')
  && bridge.includes('drainPendingSecureWraps')
  && bridge.includes('peekPendingSecureWraps'));
record('opaque wake no rememberHandledOffer', /handleSecureGiftWrap[\s\S]{0,1200}rememberHandledOffer/.test(watcher) === false);
record('opaque wake dedupe separate', watcher.includes('opaqueWakeSeen') && watcher.includes('rememberOpaqueWakeId'));
record('enqueue not gated by rate limit first', watcher.includes('enqueueSecureWrap') && watcher.includes('kept in queue'));
record('prepareSecure uses dispatcher', voiceUi.includes('dispatchGiftWrappedCallSignal') || voiceUi.includes('drainPendingSecureWrapsFromNative'));
record('index loads call-signal-e2ee', indexHtml.includes('call-signal-e2ee.js'));
record('call push still disabled', push.includes('CALL_PUSH_DISABLED') && push.includes('MISSED_CALL_PUSH_DISABLED'));
record('inject peeks queue (non-destructive)', main.includes('peekSecureWraps'));

// Runtime cross-media + double-consume
async function runtime() {
  const {
    generateSecretKey,
    getPublicKey,
    finalizeEvent,
    getEventHash,
    verifyEvent,
    utils,
    nip44,
  } = require(path.join(ROOT, 'node_modules', 'nostr-tools'));
  const { webcrypto } = crypto;

  function hexPair() {
    const sk = generateSecretKey();
    return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
  }

  const alice = hexPair();
  const bob = hexPair();
  const published = [];
  const App = {
    publicKey: bob.pk,
    privateKey: bob.hex,
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
    },
  };
  sandbox.window = sandbox;
  sandbox.window.NostrApp = App;
  sandbox.window.NostrTools = sandbox.NostrTools;
  sandbox.window.crypto = sandbox.crypto;
  vm.createContext(sandbox);
  vm.runInContext(helperSrc, sandbox, { filename: 'call-signal-e2ee.js' });
  const api = sandbox.NostrApp.CallSignalE2ee;

  const voiceHits = [];
  const videoHits = [];
  sandbox.NostrApp.voiceCall = {
    handleSecureSignal: async (logical) => {
      voiceHits.push(logical.action + ':' + logical.media);
      return true;
    },
  };
  sandbox.NostrApp.videoCall = {
    handleSecureSignal: async (logical) => {
      videoHits.push(logical.action + ':' + logical.media);
      return true;
    },
  };

  const pool = {
    publish: async (_relays, ev) => {
      published.push(ev);
      return ev;
    },
  };

  async function send(media, action, data) {
    return api.publishGiftWrappedCallSignal({
      media,
      peerPubkey: bob.pk,
      type: action,
      data,
      sessionId: api.createSessionId(),
      pool,
      relays: [],
      senderPubkey: alice.pk,
      senderPrivateKey: alice.hex,
    });
  }

  api.resetDispatchStatsForQa();
  api._seenSignalIds.clear();
  api._seenWrapIds.clear();
  voiceHits.length = 0;
  videoHits.length = 0;

  const offerSdp = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
  const { event: videoOffer } = await send('video', 'offer', offerSdp);

  const r1 = await api.dispatchGiftWrappedCallSignal(videoOffer);
  const r1b = await api.dispatchGiftWrappedCallSignal(videoOffer);
  const st1 = api.getDispatchStats();
  record('video offer unwrap once', st1.unwrapCount === 1 && r1.status === 'dispatched');
  record('video dispatch once', st1.videoDispatch === 1 && videoHits.length === 1);
  record('voice did not consume video', st1.voiceDispatch === 0 && voiceHits.length === 0);
  record('native+live duplicate wrap safe', r1b.status === 'duplicate' && st1.duplicateWrap >= 1);
  record('native ring auth once for video offer', st1.nativeRingAuth === 1);

  api.resetDispatchStatsForQa();
  voiceHits.length = 0;
  videoHits.length = 0;
  const { event: voiceOffer } = await send('voice', 'offer', offerSdp);
  const r2 = await api.dispatchGiftWrappedCallSignal(voiceOffer);
  const st2 = api.getDispatchStats();
  record('voice offer dispatch once', r2.status === 'dispatched' && st2.voiceDispatch === 1 && voiceHits.length === 1);
  record('video did not consume voice', st2.videoDispatch === 0 && videoHits.length === 0);

  api.resetDispatchStatsForQa();
  const { event: badOffer } = await send('voice', 'offer', { type: 'offer', sdp: '' });
  const rBad = await api.dispatchGiftWrappedCallSignal(badOffer);
  const stBad = api.getDispatchStats();
  record('invalid SDP no ring', rBad.status === 'invalid_offer' && stBad.nativeRingAuth === 0);

  api.resetDispatchStatsForQa();
  api._seenSignalIds.clear();
  api._seenWrapIds.clear();
  voiceHits.length = 0;
  const { event: o1 } = await send('voice', 'offer', offerSdp);
  const { event: c1 } = await send('voice', 'candidate', { candidate: 'x', sdpMid: '0' });
  const { event: c2 } = await send('voice', 'candidates', [{ candidate: 'y', sdpMid: '0' }]);
  const drained = await api.drainPendingSecureWrapsFromNative([
    { id: o1.id, event: JSON.stringify(o1) },
    { id: c1.id, event: JSON.stringify(c1) },
    { id: c2.id, event: JSON.stringify(c2) },
  ]);
  record(
    'queue offer+candidates all dispatched',
    drained.filter((d) => d.status === 'dispatched').length === 3 &&
      voiceHits[0] &&
      voiceHits[0].startsWith('offer'),
  );

  api.resetDispatchStatsForQa();
  api._seenSignalIds.clear();
  api._seenWrapIds.clear();
  const { event: ans } = await send('voice', 'answer', { type: 'answer', sdp: offerSdp.sdp });
  await api.dispatchGiftWrappedCallSignal(ans);
  record('answer no native ring', api.getDispatchStats().nativeRingAuth === 0);
}

await runtime().catch((err) => {
  record('runtime harness', false, String(err && err.message ? err.message : err));
});

console.log('call-privacy-phase1c gate');
for (const line of results) console.log(line);
console.log('TOTAL ' + pass + '/' + (pass + fail));
process.exit(fail > 0 ? 1 : 0);
