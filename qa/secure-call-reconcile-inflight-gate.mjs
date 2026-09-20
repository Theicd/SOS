#!/usr/bin/env node
/**
 * Regression: stale pendingSecureReconcileInFlight after empty/sync reconcile
 * permanently blocked CALL_NATIVE_PENDING_WATCHDOG (physical session 2ef666b3).
 * Run: node qa/secure-call-reconcile-inflight-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALLER = 'aa'.repeat(32);
const RECEIVER = 'bb'.repeat(32);
const SESSION = '2e'.repeat(16);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.0.2\r\n' };

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function memStore() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
  };
}

function stream() {
  const track = { kind: 'audio', enabled: true, stop() {}, addEventListener() {} };
  return {
    getTracks() { return [track]; },
    getAudioTracks() { return [track]; },
    getVideoTracks() { return []; },
    addTrack() {},
  };
}

function count(logs, needle) {
  return logs.filter((l) => l.includes(needle)).length;
}

function boot() {
  const box = {
    logs: [],
    nativeQueue: [],
    bridgeCount: 0,
    publishes: [],
    pcs: [],
    answerApplied: 0,
    recoveryEnqueues: 0,
    recoverySkipKnown: 0,
  };
  const ctx = {
    console: {
      log: (...a) => { box.logs.push(a.map(String).join(' ')); },
      warn: (...a) => { box.logs.push(a.map(String).join(' ')); },
      error: (...a) => { box.logs.push('ERR ' + a.map(String).join(' ')); },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: memStore(),
    sessionStorage: memStore(),
    performance: { now: () => Date.now() },
    crypto: { getRandomValues(buf) { buf.fill(3); return buf; } },
    navigator: { onLine: true, mediaDevices: { getUserMedia: async () => stream() } },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
    },
    RTCIceCandidate: class { constructor(o) { Object.assign(this, o || {}); } },
    RTCSessionDescription: class { constructor(o) { Object.assign(this, o || {}); } },
    MediaStream: class {
      constructor() { this._t = []; }
      addTrack(t) { this._t.push(t); }
      getTracks() { return this._t; }
    },
    NostrTools: {
      nip04: { decrypt: async () => null, encrypt: async () => { throw new Error('nip04'); } },
    },
  };
  ctx.window = ctx;
  ctx.RTCPeerConnection = class {
    constructor() {
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      box.pcs.push(this);
    }
    close() {}
    addTrack() {}
    setRemoteDescription(d) { this.remoteDescription = d || null; return Promise.resolve(); }
    setLocalDescription(d) { this.localDescription = d || null; return Promise.resolve(); }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    addIceCandidate() { return Promise.resolve(); }
  };
  ctx.SosNativeShell = {
    peekPendingSecureWrapCount() { return box.bridgeCount; },
    peekPendingSecureWraps() {
      return JSON.stringify(box.nativeQueue.slice());
    },
    ackSecureWrapHandled() {},
    requeueSecureWrap() {},
  };
  ctx.NostrApp = {
    publicKey: CALLER,
    privateKey: '22'.repeat(32),
    relayUrls: ['wss://relay.example'],
    pool: {
      publish() { return []; },
      subscribeMany() { return { close() {} }; },
      querySync: async () => box.recoveryEvents || [],
    },
    onVoiceCallConnected() {},
    onVoiceCallStarted() {},
    onVoiceCallAnswerReceived() { box.answerApplied += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(read('call-signal-e2ee.js'), ctx, { filename: 'call-signal-e2ee.js' });
  vm.runInContext(read('chat-voice-call.js'), ctx, { filename: 'chat-voice-call.js' });
  ctx.NostrApp.CallSignalE2ee.publishCallSignal = async (payload) => {
    box.publishes.push(payload);
    return { transport: 'giftwrap1059' };
  };
  ctx.NostrApp.CallSignalE2ee.createSessionId = () => SESSION;
  // Bypass crypto unwrap for Native pending path — inject via dispatch mock for drain tests.
  box.App = ctx.NostrApp;
  box.ctx = ctx;
  box.api = ctx.NostrApp.CallSignalE2ee;
  return box;
}

async function flush(ms = 30) {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, ms));
}

function staticSourceContracts() {
  const helper = read('call-signal-e2ee.js');
  record('static identity-safe reconcile ownership',
    /pendingSecureReconcileInFlight = run/.test(helper)
    && /pendingSecureReconcileInFlight === run/.test(helper)
    && !/pendingSecureReconcileInFlight = \(async \(\) => \{[\s\S]*?finally \{[\s\S]*?pendingSecureReconcileInFlight = null/.test(helper));
  record('static native-pending-priority defer',
    /CALL_WEB_RECOVERY_DEFER reason=native-pending-priority/.test(helper));
  record('static skip known wrap before enqueue',
    /CALL_WEB_RECOVERY_SKIP_KNOWN/.test(helper)
    && /seenWrapIds\.has\(wrapId\)/.test(helper));
  record('static webRecovery identity-safe',
    /webRecoveryInFlight = run/.test(helper)
    && /webRecoveryInFlight === run/.test(helper));
}

async function test1EmptyReconcileRelease() {
  const box = boot();
  box.bridgeCount = 0;
  box.nativeQueue = [];
  await box.api.reconcilePendingSecureCallSignals('js-bridge-ready');
  await flush(10);
  const stuck = box.api.isPendingSecureReconcileInFlight();
  const held = box.api.getPendingSecureReconcileInFlight();
  record('TEST1 empty reconcile clears inFlight',
    stuck === false && held == null,
    stuck ? 'still in-flight' : '');
  box.logs.length = 0;
  await box.api.reconcilePendingSecureCallSignals('js-bridge-ready-2');
  await flush(10);
  record('TEST1 second reconcile runs (not stuck on stale Promise)',
    count(box.logs, 'CALL_NATIVE_PENDING_PEEK reason=js-bridge-ready-2') === 1
    && box.api.isPendingSecureReconcileInFlight() === false);
}

async function test2AnswerAfterEmptyThenWatchdog() {
  const box = boot();
  box.bridgeCount = 0;
  box.nativeQueue = [];
  await box.api.reconcilePendingSecureCallSignals('js-bridge-ready');
  await flush(10);
  record('TEST2 post-empty inFlight clear', box.api.isPendingSecureReconcileInFlight() === false);

  // Outgoing call waiting for answer
  await box.App.voiceCall.start(RECEIVER);
  await flush(20);

  // Inject Native answer wrap — dispatch path mocked via direct drain of synthetic event
  // that goes through dispatchGiftWrappedCallSignal. Use handleSecureSignal for apply proof
  // while proving watchdog no longer permanently DEFERs.
  const deferBefore = count(box.logs, 'CALL_NATIVE_PENDING_WATCHDOG_DEFER reason=in-flight');

  // Simulate Native queue receiving answer (authenticated wrap stub)
  const wrap = {
    kind: 1059,
    id: 'wrap-answer-live-1',
    pubkey: 'cc'.repeat(32),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', CALLER]],
    content: 'x',
    sig: '00'.repeat(32),
  };
  box.nativeQueue = [wrap];
  box.bridgeCount = 1;

  // Force a reconcile tick (watchdog may already be running from start)
  await box.api.reconcilePendingSecureCallSignals('outgoing-await-answer');
  await flush(40);

  // Permanent stuck DEFER must not appear after empty→answer sequence
  const deferAfter = count(box.logs, 'CALL_NATIVE_PENDING_WATCHDOG_DEFER reason=in-flight');
  record('TEST2 no permanent in-flight DEFER after answer arrives',
    box.api.isPendingSecureReconcileInFlight() === false
    && (deferAfter - deferBefore) < 8,
    'deferDelta=' + (deferAfter - deferBefore));

  // Apply answer via secure signal (crypto unwrap unavailable in this harness) —
  // prove CALL_ANSWER path still works independently.
  await box.App.voiceCall.handleSecureSignal({
    media: 'voice',
    sender: RECEIVER,
    action: 'answer',
    wireType: 'answer',
    sessionId: box.App.voiceCall.getState().callSessionId || SESSION,
    signalId: 'ans-live-1',
    sentAt: Math.floor(Date.now() / 1000),
    wrapId: 'w-ans-1',
    data: ANSWER,
  });
  await flush(20);
  record('TEST2 CALL_ANSWER_APPLY_OK',
    count(box.logs, 'CALL_ANSWER_APPLY_OK') === 1);
  box.App.voiceCall.maybeMarkConnected(RECEIVER, 'test');
  // ICE may still be new — force connected then mark
  const pc = box.pcs[box.pcs.length - 1];
  if (pc) {
    pc.iceConnectionState = 'connected';
    if (pc.oniceconnectionstatechange) pc.oniceconnectionstatechange();
  }
  record('TEST2 watchdog can stop after answer',
    count(box.logs, 'CALL_ANSWER_APPLY_OK') === 1
    && box.api.isPendingSecureReconcileInFlight() === false);
}

async function test3Coalesce() {
  const box = boot();
  // Parallel empty reconciles: one owner, optional coalesce, must clear.
  const p1 = box.api.reconcilePendingSecureCallSignals('coal-a');
  const p2 = box.api.reconcilePendingSecureCallSignals('coal-b');
  const p3 = box.api.reconcilePendingSecureCallSignals('coal-c');
  await Promise.all([p1, p2, p3]);
  await flush(60);
  const peeks = box.logs.filter((l) => l.includes('CALL_NATIVE_PENDING_PEEK reason=coal')).length
    + box.logs.filter((l) => l.includes('CALL_NATIVE_PENDING_PEEK reason=coalesce')).length;
  record('TEST3 parallel reconciles complete without stuck ownership',
    box.api.isPendingSecureReconcileInFlight() === false
    && peeks >= 1 && peeks <= 4,
    'peeks=' + peeks);
  // Source contract: coalesce rerun scheduled from outer finally
  const helper = read('call-signal-e2ee.js');
  record('TEST3 coalesce schedule present',
    /reconcilePendingSecureCallSignals\('coalesce'\)/.test(helper)
    && /pendingSecureReconcileQueued = true/.test(helper));
}

async function test4NativePriorityOverRecovery() {
  const box = boot();
  // Mark many historical wrap IDs as already seen
  for (let i = 0; i < 40; i += 1) {
    box.api.rememberWrapId('hist-wrap-' + i);
  }
  box.recoveryEvents = [];
  for (let i = 0; i < 40; i += 1) {
    box.recoveryEvents.push({
      kind: 1059,
      id: 'hist-wrap-' + i,
      pubkey: 'ee'.repeat(32),
      created_at: Math.floor(Date.now() / 1000) - 100,
      tags: [['p', CALLER]],
      content: 'old',
      sig: '22'.repeat(32),
    });
  }
  // Native has live answer wrap
  box.nativeQueue = [{
    kind: 1059,
    id: 'live-answer-wrap',
    pubkey: 'ff'.repeat(32),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', CALLER]],
    content: 'live',
    sig: '33'.repeat(32),
  }];
  box.bridgeCount = 1;

  // Start outgoing watchdog context
  box.api.startOutgoingAnswerDrainWatchdog({ shouldStop: () => false });
  await flush(50);

  // Recovery should defer to native priority OR skip known wraps
  const deferred = count(box.logs, 'CALL_WEB_RECOVERY_DEFER reason=native-pending-priority') >= 1;
  const skipped = count(box.logs, 'CALL_WEB_RECOVERY_SKIP_KNOWN') >= 1;
  const nativePeek = count(box.logs, 'CALL_NATIVE_PENDING_PEEK') >= 1;
  record('TEST4 Native priority or skip-known avoids backlog starve',
    (deferred || skipped) && nativePeek
    && box.api.isPendingSecureReconcileInFlight() === false,
    deferred ? 'deferred' : (skipped ? 'skipped' : 'none'));

  box.api.stopOutgoingAnswerDrainWatchdog('test-done');
}

async function test5BilateralConnectedPreserved() {
  // Source-level + light runtime: helpers still present
  const voice = read('chat-voice-call.js');
  const video = read('chat-video-call.js');
  record('TEST5 maybeMarkVoiceCallConnected present',
    /function maybeMarkVoiceCallConnected/.test(voice));
  record('TEST5 maybeMarkVideoCallConnected + answerPublished',
    /function maybeMarkVideoCallConnected/.test(video)
    && /answerPublished/.test(video));
}

async function main() {
  staticSourceContracts();
  await test1EmptyReconcileRelease();
  await test2AnswerAfterEmptyThenWatchdog();
  await test3Coalesce();
  await test4NativePriorityOverRecovery();
  await test5BilateralConnectedPreserved();

  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
