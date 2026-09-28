#!/usr/bin/env node
/**
 * Package 899 — call realtime + security gate.
 *  - Worker-path unwrap must validate payload and bind payload.sender to the seal signer.
 *  - Ring intent is a normal authenticated 1059 signal (no SDP, no leaks).
 *  - Per-relay publish: first OK resolves, per-relay timeout, NIP-42 write auth with the
 *    ephemeral wrapper key only, circuit breaker, async-wrapped pool cannot fake success.
 * Run: node qa/package899-call-realtime-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
  utils,
  nip44,
  nip04,
} from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const results = [];
let pass = 0;
let fail = 0;
const out = {};

function record(name, ok, detail = '') {
  if (ok) { pass += 1; results.push('PASS ' + name); return; }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hex32 = () => randomBytes(32).toString('hex');
function hexPair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

function loadHelper() {
  const alice = hexPair();
  const bob = hexPair();
  const published = [];
  const logs = [];
  const App = {
    publicKey: alice.pk,
    finalizeEvent(draft, key) {
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(JSON.parse(JSON.stringify(draft)), sk);
    },
    pool: {
      publish(_relays, event) { published.push(event); return [Promise.resolve('ok')]; },
    },
    relayUrls: ['wss://qa.example'],
  };
  const sandbox = {
    console: { log(m) { logs.push(String(m)); }, warn() {}, error() {}, info() {}, debug() {} },
    navigator: { userAgent: 'NodeQA', onLine: true },
    crypto: webcrypto,
    localStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } },
    sessionStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Map, Set, Promise, JSON, Date, Math, Number, String, Array, Object, Boolean, Error, TypeError,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL,
    NostrApp: App,
    NostrTools: {
      finalizeEvent: (d, sk) => finalizeEvent(JSON.parse(JSON.stringify(d)), sk),
      getEventHash: (ev) => getEventHash(JSON.parse(JSON.stringify(ev))),
      verifyEvent: (ev) => verifyEvent(JSON.parse(JSON.stringify(ev))),
      generateSecretKey, getPublicKey, utils, nip44, nip04,
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('nostr-event-integrity.js'), sandbox, { filename: 'nostr-event-integrity.js' });
  vm.runInContext(read('sos-crypto-signer.js'), sandbox, { filename: 'sos-crypto-signer.js' });
  vm.runInContext(read('relay-health.js'), sandbox, { filename: 'relay-health.js' });
  vm.runInContext(read('call-signal-e2ee.js'), sandbox, { filename: 'call-signal-e2ee.js' });
  return { App: sandbox.NostrApp, sandbox, alice, bob, published, logs };
}

function workerSigner(logicalFactory) {
  return {
    hasIdentityKey: () => true,
    isWorkerAuthoritative: () => true,
    unwrapCallGiftwrap: async () => logicalFactory(),
  };
}

async function workerPathCases() {
  const rt = loadHelper();
  const { App, alice, bob } = rt;
  const api = App.CallSignalE2ee;
  const routed = [];
  App.publicKey = bob.pk;
  App.voiceCall = { handleSecureSignal: async (l) => { routed.push(l); return true; } };
  App.videoCall = { handleSecureSignal: async (l) => { routed.push(l); return true; } };
  const now = () => Math.floor(Date.now() / 1000);
  const base = (over = {}) => ({
    family: 'sos-call-signal', v: 1, media: 'voice', action: 'ring',
    sessionId: hex32(), signalId: hex32(), sender: alice.pk, recipient: bob.pk,
    sentAt: now(), data: null, sealPubkey: alice.pk, wrapId: hex32(), ...over,
  });
  const cases = [
    ['forged sender (payload.sender != seal signer) rejected', base({ sealPubkey: hexPair().pk }), false],
    ['missing seal signer rejected', base({ sealPubkey: undefined }), false],
    ['stale ring rejected', base({ sentAt: now() - 600 }), false],
    ['future-dated signal rejected', base({ sentAt: now() + 600 }), false],
    ['wrong recipient rejected', base({ recipient: hexPair().pk }), false],
    ['wrong family rejected', base({ family: 'evil' }), false],
    ['unknown action rejected', base({ action: 'shell' }), false],
    ['short sessionId rejected', base({ sessionId: 'abc' }), false],
    ['valid ring dispatched', base(), true],
    ['valid video offer dispatched', base({ media: 'video', action: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' } }), true],
  ];
  for (const [name, logical, expectOk] of cases) {
    App.SosCryptoSigner = workerSigner(() => logical);
    routed.length = 0;
    const r = await api.dispatchGiftWrappedCallSignal({ kind: 1059, id: hex32(), tags: [['p', bob.pk]], content: 'x', pubkey: hexPair().pk });
    const ok = r && r.status === 'dispatched' && routed.length === 1;
    record('WORKER_PATH ' + name, expectOk ? ok : (!ok && routed.length === 0), JSON.stringify(r));
  }
  // Replay: same signalId twice → second rejected.
  const replay = base();
  App.SosCryptoSigner = workerSigner(() => ({ ...replay }));
  routed.length = 0;
  await api.dispatchGiftWrappedCallSignal({ kind: 1059, id: hex32(), tags: [['p', bob.pk]], content: 'x', pubkey: hexPair().pk });
  const r2 = await api.dispatchGiftWrappedCallSignal({ kind: 1059, id: hex32(), tags: [['p', bob.pk]], content: 'x', pubkey: hexPair().pk });
  record('WORKER_PATH replayed signalId rejected', routed.length === 1 && r2.status === 'reject', JSON.stringify(r2));
  const routedRing = base();
  App.SosCryptoSigner = workerSigner(() => routedRing);
  routed.length = 0;
  await api.dispatchGiftWrappedCallSignal({ kind: 1059, id: hex32(), tags: [['p', bob.pk]], content: 'x', pubkey: hexPair().pk });
  record('WORKER_PATH routed sender is seal-bound lowercase', routed[0] && routed[0].sender === alice.pk.toLowerCase());
  out.CALL_WORKER_PATH_SENDER_BINDING = fail === 0 ? 'PASS' : 'FAIL';
}

async function ringCrypto() {
  const rt = loadHelper();
  const { App, alice, bob, published } = rt;
  const api = App.CallSignalE2ee;
  for (const [media, type, wire] of [['voice', 'ring', 'ring'], ['video', 'v-ring', 'v-ring']]) {
    published.length = 0;
    App.publicKey = alice.pk;
    const sessionId = api.createSessionId();
    const res = await api.publishGiftWrappedCallSignal({
      media, peerPubkey: bob.pk, type, data: null, sessionId, pool: App.pool,
      relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
    });
    const ev = published[published.length - 1];
    record(`RING ${media} published as 1059`, res && res.transport === 'giftwrap1059' && ev && ev.kind === 1059);
    record(`RING ${media} outer pubkey is ephemeral`, ev && ev.pubkey !== alice.pk);
    const outer = JSON.stringify(ev);
    record(`RING ${media} outer leaks nothing`, !['ring', 'sos-call-signal', alice.pk, sessionId, media].some((s) => outer.includes(s)));
    const un = await api.unwrapGiftWrappedCallSignal(ev, bob.hex, bob.pk);
    record(`RING ${media} unwraps authenticated`, un && un.action === 'ring' && un.wireType === wire && un.sender === alice.pk && un.sessionId === sessionId && un.data === null);
    const un2 = await api.unwrapGiftWrappedCallSignal(ev, bob.hex, bob.pk);
    record(`RING ${media} replay rejected`, un2 === null);
    const eve = hexPair();
    const un3 = await api.unwrapGiftWrappedCallSignal(ev, eve.hex, eve.pk);
    record(`RING ${media} third party cannot unwrap`, un3 === null);
  }
  record('RING freshness 60s', api.FRESHNESS_SEC && api.FRESHNESS_SEC.ring === 60);
}

function mockRelayPool(spec, calls) {
  return {
    publish() { throw new Error('base publish must not be used when ensureRelay exists'); },
    async ensureRelay(url) {
      const s = spec[url.replace(/\/$/, '')] || { mode: 'ok', ms: 5 };
      if (s.mode === 'connect-fail') { await new Promise((r) => setTimeout(r, s.ms || 5)); throw new Error('connection failed'); }
      const relay = {
        url,
        challenge: s.challenge || undefined,
        authed: false,
        async auth(signer) {
          const ev = await signer({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', url], ['challenge', s.challenge]], content: '' });
          calls.push({ url, auth: ev });
          if (!verifyEvent(ev) || ev.kind !== 22242) throw new Error('bad auth');
          relay.authed = true;
          return 'ok';
        },
        async publish(event) {
          calls.push({ url, publish: event.id });
          if (s.mode === 'hang') return new Promise(() => {});
          if (s.mode === 'auth' && !relay.authed) throw new Error('auth-required: authenticate to publish gift wraps');
          if (s.mode === 'reject') throw new Error('blocked: nope');
          await new Promise((r) => setTimeout(r, s.ms || 5));
          return 'ok';
        },
      };
      return relay;
    },
  };
}

async function relayPublish() {
  const rt = loadHelper();
  const { App, alice, bob } = rt;
  const api = App.CallSignalE2ee;
  App.publicKey = alice.pk;
  const calls = [];
  const spec = {
    'wss://relay.snort.social': { mode: 'ok', ms: 30 },
    'wss://nos.lol': { mode: 'connect-fail', ms: 5 },
    'wss://nostr-relay.xbytez.io': { mode: 'hang' },
    'wss://nostr-02.uid.ovh': { mode: 'auth', ms: 10, challenge: 'chal-' + hex32().slice(0, 8) },
  };
  const pool = mockRelayPool(spec, calls);
  const t0 = Date.now();
  const res = await api.publishGiftWrappedCallSignal({
    media: 'voice', peerPubkey: bob.pk, type: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' },
    sessionId: api.createSessionId(), pool, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
  });
  const firstMs = Date.now() - t0;
  out.CALL_PUBLISH_FIRST_OK_MS = firstMs;
  record('PUBLISH resolves on first relay OK (does not wait for hung relay)', res && res.transport === 'giftwrap1059' && firstMs < 1500, 'ms=' + firstMs);
  await new Promise((r) => setTimeout(r, 4600));
  const auths = calls.filter((c) => c.auth);
  const wrapPub = res.event.pubkey;
  record('NIP42 auth performed for auth-required relay', auths.length === 1 && auths[0].url.includes('uid.ovh'));
  record('NIP42 auth signed by ephemeral wrapper key, never identity', auths[0] && auths[0].auth.pubkey === wrapPub && auths[0].auth.pubkey !== alice.pk);
  record('NIP42 auth event kind 22242 with challenge', auths[0] && auths[0].auth.kind === 22242 && auths[0].auth.tags.some((t) => t[0] === 'challenge' && t[1] === spec['wss://nostr-02.uid.ovh'].challenge));
  const snap = App.RelayHealth.snapshot();
  out.RELAY_HEALTH_AFTER_PUBLISH = snap;
  record('HEALTH uid.ovh ok after auth', snap['wss://nostr-02.uid.ovh'] && snap['wss://nostr-02.uid.ovh'].ok === 1);
  record('HEALTH hung relay recorded as timeout', snap['wss://nostr-relay.xbytez.io'] && snap['wss://nostr-relay.xbytez.io'].lastReason === 'timeout');
  record('HEALTH connect-fail relay recorded', snap['wss://nos.lol'] && snap['wss://nos.lol'].fail === 1);
  const authExcluded = !api.getCallSignalRelays().some((u) => u.includes('uid.ovh'));
  record('auth relay not excluded when auth succeeds', !authExcluded);

  // Second failure opens the circuit → next publish skips nos.lol.
  calls.length = 0;
  await api.publishGiftWrappedCallSignal({
    media: 'voice', peerPubkey: bob.pk, type: 'disconnect', data: null,
    sessionId: api.createSessionId(), pool, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
  });
  await new Promise((r) => setTimeout(r, 4600));
  const snap2 = App.RelayHealth.snapshot();
  record('CIRCUIT opens after 2 consecutive failures', snap2['wss://nos.lol'].circuitOpen === true && snap2['wss://nostr-relay.xbytez.io'].circuitOpen === true);
  calls.length = 0;
  await api.publishGiftWrappedCallSignal({
    media: 'voice', peerPubkey: bob.pk, type: 'disconnect', data: null,
    sessionId: api.createSessionId(), pool, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
  });
  const touched = new Set(calls.map((c) => c.url.replace(/\/$/, '')));
  record('CIRCUIT open relays skipped (no hot loop on dead relays)', !touched.has('wss://nos.lol') && !touched.has('wss://nostr-relay.xbytez.io'), JSON.stringify([...touched]));
  out.UNHEALTHY_RELAY_HOT_LOOP = (!touched.has('wss://nos.lol') && !touched.has('wss://nostr-relay.xbytez.io')) ? false : true;

  // All relays down → circuit falls back to full list, and zero OK must throw.
  const deadPool = mockRelayPool({
    'wss://relay.snort.social': { mode: 'reject' }, 'wss://nos.lol': { mode: 'reject' },
    'wss://nostr-relay.xbytez.io': { mode: 'reject' }, 'wss://nostr-02.uid.ovh': { mode: 'reject' },
  }, []);
  App.RelayHealth.reset();
  let threw = null;
  try {
    await api.publishGiftWrappedCallSignal({
      media: 'voice', peerPubkey: bob.pk, type: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' },
      sessionId: api.createSessionId(), pool: deadPool, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
    });
  } catch (e) { threw = e; }
  record('ZERO relay OK fails closed (CALL_SIGNAL_TRANSPORT_FAILED)', threw && threw.code === 'CALL_SIGNAL_TRANSPORT_FAILED');

  // Regression: async-wrapped publish (emergency-wrapper shape) must not count as success.
  App.RelayHealth.reset();
  const wrappedPool = { publish: async () => [Promise.reject(new Error('blocked')), Promise.reject(new Error('auth-required: x'))] };
  let threw2 = null;
  try {
    await api.publishGiftWrappedCallSignal({
      media: 'voice', peerPubkey: bob.pk, type: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' },
      sessionId: api.createSessionId(), pool: wrappedPool, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
    });
  } catch (e) { threw2 = e; }
  record('ASYNC_WRAPPED_POOL all-reject no longer fakes success', threw2 && threw2.code === 'CALL_SIGNAL_TRANSPORT_FAILED');
  const okWrapped = { publish: async (relays) => relays.map(() => Promise.resolve('ok')) };
  const r3 = await api.publishGiftWrappedCallSignal({
    media: 'voice', peerPubkey: bob.pk, type: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' },
    sessionId: api.createSessionId(), pool: okWrapped, relays: App.relayUrls, senderPubkey: alice.pk, senderPrivateKey: alice.hex,
  });
  record('ASYNC_WRAPPED_POOL success still works', r3 && r3.transport === 'giftwrap1059');
}

async function recoveryChurn() {
  const rt = loadHelper();
  const { App, bob, logs } = rt;
  const api = App.CallSignalE2ee;
  App.publicKey = bob.pk;
  App.SosCryptoSigner = { hasIdentityKey: () => true, isWorkerAuthoritative: () => false, f1CryptoModuleSessionKeyHex: () => bob.hex };
  const reads = [];
  App.pool = {
    async ensureRelay(url) {
      return {
        subscribe(_filters, h) {
          reads.push(url);
          setTimeout(() => {
            if (url.includes('uid.ovh')) h.onclose('auth-required: authenticate as this recipient');
            else h.oneose();
          }, 5);
          return { close() {} };
        },
      };
    },
    subscribeMany(_relays, _f, h) { setTimeout(() => h.oneose(), 5); return { close() {} }; },
  };
  api.ensureSecureCallSubscription({ force: true, reason: 'qa' });
  await new Promise((r) => setTimeout(r, 30));
  await api.runWebSecureCallRecovery('qa-1');
  const firstRound = reads.slice();
  reads.length = 0;
  await api.runWebSecureCallRecovery('qa-2');
  record('RECOVERY read-auth relay detected from CLOSED', logs.some((l) => l.includes('CALL_RELAY_READ_AUTH_REQUIRED')) && firstRound.some((u) => u.includes('uid.ovh')));
  record('RECOVERY read-auth relay skipped afterwards (no churn)', reads.length > 0 && !reads.some((u) => u.includes('uid.ovh')), JSON.stringify(reads));
  reads.length = 0;
  logs.length = 0;
  api.startWebSecureCallRecovery({ reason: 'qa-outgoing', shouldStop: () => false });
  await new Promise((r) => setTimeout(r, 6200));
  api.stopWebSecureCallRecovery('qa-done');
  const ticks = logs.filter((l) => l.startsWith('CALL_WEB_RECOVERY_TICK')).length;
  out.RECOVERY_TICKS_IN_6S_HEALTHY_SUB = ticks;
  record('RECOVERY healthy subscription → slow ticks (<=3 in 6s, was 9)', ticks >= 2 && ticks <= 3, 'ticks=' + ticks);
  logs.length = 0;
  await new Promise((r) => setTimeout(r, 3500));
  record('RECOVERY stop leaves no timer running', !logs.some((l) => l.startsWith('CALL_WEB_RECOVERY_TICK')));
}

function staticChecks() {
  const voice = read('chat-voice-call.js');
  const video = read('chat-video-call.js');
  const vui = read('chat-voice-call-ui.js');
  const videoUi = read('chat-video-call-ui.js');
  const helper = read('call-signal-e2ee.js');
  const vStart = voice.slice(voice.indexOf('async function startCall'), voice.indexOf('async function acceptCall'));
  record('VOICE ring published before GUM', vStart.indexOf("'ring'") > 0 && vStart.indexOf("'ring'") < vStart.indexOf('await getLocalStream'));
  record('VOICE ring not awaited (GUM parallel)', !/await\s+sendSignal\(peerPubkey,\s*'ring'/.test(vStart));
  const vdStart = video.slice(video.indexOf('async function start('), video.indexOf('async function start(') + 2500);
  record('VIDEO ring published before GUM', vdStart.indexOf("'v-ring'") > 0 && vdStart.indexOf("'v-ring'") < vdStart.indexOf('await getLocalStream'));
  record('VIDEO ring not awaited (GUM parallel)', !/await\s+sendSignal\(peerPubkey,\s*'v-ring'/.test(vdStart));
  record('VOICE ring handler requires secure preParsed', /case 'ring':[\s\S]{0,200}if \(!preParsed \|\| !preParsed\.sessionId\) break;/.test(voice));
  record('VIDEO ring handler requires secure preParsed', /case 'v-ring':[\s\S]{0,200}if \(!preParsed \|\| !preParsed\.sessionId\) break;/.test(video));
  record('VOICE ring has offer deadline', voice.includes('armRingOfferDeadline') && voice.includes('CALL_RING_OFFER_TIMEOUT'));
  record('VIDEO ring has offer deadline', video.includes('armRingOfferDeadline') && video.includes('CALL_RING_OFFER_TIMEOUT'));
  record('VOICE UI accept waits for offer after ring', vui.includes('RING_ACCEPT_OFFER_WAIT_MS') && vui.includes('App.onVoiceCallRinging'));
  record('VIDEO UI accept waits for offer after ring', videoUi.includes('RING_ACCEPT_OFFER_WAIT_MS') && videoUi.includes('App.onVideoCallRinging'));
  record('VOICE UI ring accept binds cached offer to session', /cached\.sessionId === st\.callSessionId/.test(vui));
  record('Legacy 25050 read path kept', voice.includes('LEGACY_READ_ONLY') && video.includes('LEGACY_READ_ONLY') && helper.includes('looksLikeLegacyDirectCallSignal'));
  record('Worker path calls validatePayload + seal binding', /unwrapCallGiftwrap[\s\S]{0,400}validatePayload\(/.test(helper) && helper.includes('valid.sender === sealPk'));
  record('NIP42 auth uses wrap key only', helper.includes('authSk: wrapAuthSk') && !/relay\.auth\([^)]*f1CryptoModuleSessionKeyHex/.test(helper));
  const voiceFail = voice.slice(voice.indexOf("console.error('Failed to accept call', err);"), voice.indexOf('async function endCall'));
  record('STALE voice failed accept clears peer+session', /state\.currentPeer = null;[\s\S]{0,80}state\.callSessionId = null;/.test(voiceFail));
  record('STALE voice failed accept tells caller (disconnect)', voiceFail.includes("sendSignal(state.currentPeer, 'disconnect', null)"));
  record('STALE voice outgoing setup deadline 60s', voice.includes('OUTGOING_NO_ANSWER_MS = 60000') && /CALL_STARTED'\);\s*armOutgoingSetupDeadline/.test(voice));
  record('STALE video outgoing setup deadline 60s', video.includes('OUTGOING_NO_ANSWER_MS = 60000') && video.includes('armOutgoingSetupDeadline(state.callSessionId)'));
  record('STALE video start failure ends session (v-disconnect + cleanup)', /catch \(err\) \{\s*state\.outboundStarting = false;[\s\S]{0,200}await end\(\{ reason: 'start_error' \}\)/.test(video));
  record('STALE video accept failure ends session', /async function accept\(peerPubkey, offer, meta\) \{\s*try \{\s*return await acceptIncoming/.test(video));
  record('STALE pagehide disconnect voice (not for unanswered incoming ring)', /addEventListener\('pagehide'[\s\S]{0,260}state\.isIncoming && !state\.callAnswered && !state\.isCallActive\) return;[\s\S]{0,60}page_hide/.test(voice));
  record('STALE pagehide disconnect video (not for unanswered incoming ring)', /addEventListener\('pagehide'[\s\S]{0,260}state\.isIncoming && !state\.isActive && !state\.answerPublished\) return;[\s\S]{0,60}page_hide/.test(video));
  record('CHURN forced resubscribe coalesced', helper.includes('FORCED_SUBSCRIBE_COALESCE_MS') && helper.includes('CALL_SECURE_SUBSCRIBE_COALESCED'));
  record('Ring payload carries no SDP', !/sendSignal\(peerPubkey, '(v-)?ring', (?!null)/.test(voice + video));
}

(async () => {
  staticChecks();
  await workerPathCases();
  await ringCrypto();
  await relayPublish();
  await recoveryChurn();
  out.CALL_STALE_STATE_GATE = results.filter((r) => r.includes('STALE')).every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL';
  out.CALL_RECOVERY_CHURN_GATE = results.filter((r) => r.includes('RECOVERY') || r.includes('CHURN')).every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL';
  out.CALL_1059_WORKER_VALIDATION = results.filter((r) => r.includes('WORKER_PATH')).every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL';
  out.CALL_RING_NO_GUM_BLOCK_STATIC = results.filter((r) => /ring|RING/.test(r)).every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL';
  out.CALL_RELAY_HEALTH_GATE = results.filter((r) => /PUBLISH|HEALTH|CIRCUIT|NIP42|ZERO|ASYNC_WRAPPED/.test(r)).every((r) => r.startsWith('PASS')) ? 'PASS' : 'FAIL';
  out.TOTAL = { pass, fail };
  out.results = results;
  out.STATUS = fail === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(ROOT, 'qa', 'package899-call-realtime-report.json'), JSON.stringify(out, null, 2));
  for (const r of results) console.log(r);
  console.log(`PACKAGE899_CALL_REALTIME_GATE ${out.STATUS} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('GATE_CRASH', e && e.stack || e); process.exit(2); });
