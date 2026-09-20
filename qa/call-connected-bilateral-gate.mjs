#!/usr/bin/env node
/**
 * Bilateral CALL_CONNECTED contract — voice + video.
 * Proves: ICE-before-answer defers; answer publish/apply then fires once;
 * publish failure → zero CALL_CONNECTED; no resurrection.
 * Run: node qa/call-connected-bilateral-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALLER = 'aa'.repeat(32);
const RECEIVER = 'bb'.repeat(32);
const SESSION = 'd4'.repeat(16);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.2.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.2.2\r\n' };

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
  const vtrack = { kind: 'video', enabled: true, stop() {}, getSettings() { return {}; }, addEventListener() {} };
  return {
    getTracks() { return [track, vtrack]; },
    getAudioTracks() { return [track]; },
    getVideoTracks() { return [vtrack]; },
    addTrack() {},
  };
}

function count(box, needle) {
  return box.logs.filter((l) => l.includes(needle)).length;
}

function countExactConnected(box) {
  return box.logs.filter((l) => /^CALL_CONNECTED(\s|$)/.test(l) || l.startsWith('CALL_CONNECTED session=')).length;
}

function boot(media, role, opts = {}) {
  const box = {
    logs: [],
    publishes: [],
    pcs: [],
    connectedCb: 0,
    publishFail: !!opts.publishFail,
    cache: null,
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
    crypto: { getRandomValues(buf) { buf.fill(7); return buf; } },
    navigator: { onLine: true, mediaDevices: { getUserMedia: async () => stream() } },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
    },
    RTCIceCandidate: class RTCIceCandidate { constructor(o) { Object.assign(this, o || {}); } },
    RTCSessionDescription: class RTCSessionDescription { constructor(o) { Object.assign(this, o || {}); } },
    MediaStream: class MediaStream {
      constructor() { this._t = []; }
      addTrack(t) { this._t.push(t); }
      getTracks() { return this._t; }
    },
    NostrTools: {
      nip04: {
        decrypt: async () => null,
        encrypt: async () => { throw new Error('nip04'); },
      },
    },
  };
  ctx.window = ctx;
  ctx.RTCPeerConnection = class RTCPeerConnection {
    constructor() {
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.localDescription = null;
      this.remoteDescription = null;
      this.closed = false;
      box.pcs.push(this);
    }
    close() { this.closed = true; }
    addTrack() {}
    setRemoteDescription(desc) {
      this.remoteDescription = desc || null;
      return Promise.resolve();
    }
    setLocalDescription(desc) {
      this.localDescription = desc || null;
      return Promise.resolve();
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    addIceCandidate() { return Promise.resolve(); }
  };
  ctx.NostrApp = {
    publicKey: role === 'caller' ? CALLER : RECEIVER,
    privateKey: '22'.repeat(32),
    relayUrls: ['wss://relay.example'],
    pool: {
      publish() { return []; },
      subscribeMany() { return { close() {} }; },
    },
    onVoiceCallConnected() { box.connectedCb += 1; },
    onVideoCallConnected() { box.connectedCb += 1; },
    onVoiceCallStarted() {},
    onVideoCallStarted() {},
    onVoiceCallEnded() {},
    onVideoCallEnded() {},
    isCallSessionTerminal() { return false; },
    markCallSessionTerminal() {},
    clearSecureOfferCache() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('call-signal-e2ee.js'), ctx, { filename: 'call-signal-e2ee.js' });
  if (media === 'voice') {
    vm.runInContext(read('chat-voice-call.js'), ctx, { filename: 'chat-voice-call.js' });
  } else {
    vm.runInContext(read('chat-video-call.js'), ctx, { filename: 'chat-video-call.js' });
  }
  ctx.NostrApp.CallSignalE2ee.publishCallSignal = async (payload) => {
    if (box.publishFail && payload && (payload.type === 'answer' || payload.type === 'v-answer')) {
      throw Object.assign(new Error('CALL_SIGNAL_TRANSPORT_FAILED'), { code: 'CALL_SIGNAL_TRANSPORT_FAILED' });
    }
    box.publishes.push(payload);
    return { transport: 'giftwrap1059' };
  };
  ctx.NostrApp.CallSignalE2ee.createSessionId = () => SESSION;
  ctx.NostrApp.CallSignalE2ee.getCachedSecureOffer = () => box.cache;
  box.App = ctx.NostrApp;
  box.ctx = ctx;
  return box;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function logicalVideo(from, action, data) {
  const wire = action === 'offer' ? 'v-offer' : action === 'answer' ? 'v-answer' : 'v-disconnect';
  return {
    media: 'video',
    sender: from,
    action,
    wireType: wire,
    sessionId: SESSION,
    signalId: wire + '-' + Math.random().toString(16).slice(2, 8),
    sentAt: nowSec(),
    wrapId: 'w' + Math.random().toString(16).slice(2, 10),
    data: data === undefined ? null : data,
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
}

async function voiceCalleeIceBeforePublish() {
  const box = boot('voice', 'receiver');
  // Adopt incoming session the same way a real offer would.
  await box.App.voiceCall.handleSecureSignal({
    media: 'voice',
    sender: CALLER,
    action: 'offer',
    wireType: 'offer',
    sessionId: SESSION,
    signalId: 'off-v1',
    sentAt: nowSec(),
    wrapId: 'woff1',
    data: OFFER,
  });
  await flush();
  record('VOICE_CALLEE session adopted before accept',
    box.App.voiceCall.getState().callSessionId === SESSION);

  let resolvePublish;
  const publishGate = new Promise((r) => { resolvePublish = r; });
  let published = false;
  box.App.CallSignalE2ee.publishCallSignal = async (payload) => {
    if (payload && payload.type === 'answer') {
      const pc = box.pcs[box.pcs.length - 1];
      if (pc && !published) {
        pc.iceConnectionState = 'connected';
        if (typeof pc.oniceconnectionstatechange === 'function') pc.oniceconnectionstatechange();
        record('VOICE_CALLEE ice-before-publish DEFER',
          count(box, 'CALL_CONNECTED_DEFER reason=await-answer') >= 1
          && countExactConnected(box) === 0);
        await publishGate;
      }
      published = true;
      box.publishes.push(payload);
      return { transport: 'giftwrap1059' };
    }
    box.publishes.push(payload);
    return { transport: 'giftwrap1059' };
  };
  const acceptP = box.App.voiceCall.accept(CALLER, OFFER);
  await flush();
  resolvePublish();
  await acceptP;
  await flush();
  record('VOICE_CALLEE CALL_CONNECTED after publish without new ICE event',
    countExactConnected(box) === 1
    && count(box, 'CALL_ANSWER_PUBLISH_OK') === 1
    && box.connectedCb === 1
    && !!box.App.voiceCall.getState().isCallActive);
  box.App.voiceCall.maybeMarkConnected(CALLER, 'recheck');
  record('VOICE_CALLEE CALL_CONNECTED exactly once',
    countExactConnected(box) === 1 && box.connectedCb === 1);
}

async function voiceCallerIceBeforeApply() {
  const box = boot('voice', 'caller');
  await box.App.voiceCall.start(RECEIVER);
  const pc = box.pcs[box.pcs.length - 1];
  pc.iceConnectionState = 'connected';
  if (typeof pc.oniceconnectionstatechange === 'function') pc.oniceconnectionstatechange();
  record('VOICE_CALLER ICE before answer DEFER',
    count(box, 'CALL_CONNECTED_DEFER reason=await-answer') >= 1
    && countExactConnected(box) === 0);
  await box.App.voiceCall.handleSecureSignal({
    media: 'voice',
    sender: RECEIVER,
    action: 'answer',
    wireType: 'answer',
    sessionId: box.App.voiceCall.getState().callSessionId || SESSION,
    signalId: 'ans-1',
    sentAt: nowSec(),
    wrapId: 'wans1',
    data: ANSWER,
  });
  await flush();
  record('VOICE_CALLER CALL_CONNECTED after apply once',
    countExactConnected(box) === 1
    && count(box, 'CALL_ANSWER_APPLY_OK') === 1
    && box.connectedCb === 1);
}

async function videoCalleeIceBeforePublish() {
  const box = boot('video', 'receiver');
  box.cache = { media: 'video', offer: OFFER, sessionId: SESSION };
  box.App.__videoIncomingSessionId = SESSION;
  let resolvePublish;
  const publishGate = new Promise((r) => { resolvePublish = r; });
  box.App.CallSignalE2ee.publishCallSignal = async (payload) => {
    if (payload && payload.type === 'v-answer') {
      const pc = box.pcs[box.pcs.length - 1];
      if (pc) {
        // answeredLocally may be true here, but answerPublished must still be false
        pc.iceConnectionState = 'connected';
        if (typeof pc.oniceconnectionstatechange === 'function') pc.oniceconnectionstatechange();
        record('VIDEO_CALLEE no CALL_CONNECTED before publish',
          countExactConnected(box) === 0
          && count(box, 'CALL_CONNECTED_DEFER reason=await-answer') >= 1
          && box.App.videoCall.getState().answerPublished === false);
        await publishGate;
      }
      box.publishes.push(payload);
      return { transport: 'giftwrap1059' };
    }
    box.publishes.push(payload);
    return { transport: 'giftwrap1059' };
  };
  const acceptP = box.App.videoCall.accept(CALLER, OFFER, { createdAt: nowSec(), sessionId: SESSION });
  await flush();
  resolvePublish();
  await acceptP;
  await flush();
  record('VIDEO_CALLEE CALL_CONNECTED after publish once',
    countExactConnected(box) === 1
    && box.App.videoCall.getState().answerPublished === true
    && box.App.videoCall.getState().isActive === true
    && box.connectedCb === 1);
  box.App.videoCall.maybeMarkConnected(CALLER, 'recheck');
  record('VIDEO_CALLEE CALL_CONNECTED exactly once',
    countExactConnected(box) === 1 && box.connectedCb === 1);
}

async function videoCallerRequiresRemoteAnswer() {
  const box = boot('video', 'caller');
  await box.App.videoCall.start(RECEIVER);
  const pc = box.pcs[box.pcs.length - 1];
  pc.iceConnectionState = 'connected';
  if (typeof pc.oniceconnectionstatechange === 'function') pc.oniceconnectionstatechange();
  record('VIDEO_CALLER ICE alone does not connect',
    countExactConnected(box) === 0
    && count(box, 'CALL_CONNECTED_DEFER reason=await-answer') >= 1);
  await box.App.videoCall.handleSecureSignal(logicalVideo(RECEIVER, 'answer', ANSWER));
  await flush();
  record('VIDEO_CALLER CALL_CONNECTED after answer apply once',
    countExactConnected(box) === 1
    && count(box, 'CALL_ANSWER_APPLY_OK') === 1
    && box.connectedCb === 1);
}

async function publishFailZeroConnected() {
  const voice = boot('voice', 'receiver', { publishFail: true });
  await voice.App.voiceCall.handleSecureSignal({
    media: 'voice',
    sender: CALLER,
    action: 'offer',
    wireType: 'offer',
    sessionId: SESSION,
    signalId: 'off-fail',
    sentAt: nowSec(),
    wrapId: 'wofff',
    data: OFFER,
  });
  await flush();
  let threw = false;
  try {
    await voice.App.voiceCall.accept(CALLER, OFFER);
  } catch (_) {
    threw = true;
  }
  const pc = voice.pcs[voice.pcs.length - 1];
  if (pc) {
    pc.iceConnectionState = 'connected';
    if (typeof pc.oniceconnectionstatechange === 'function') pc.oniceconnectionstatechange();
  }
  if (typeof voice.App.voiceCall.maybeMarkConnected === 'function') {
    voice.App.voiceCall.maybeMarkConnected(CALLER, 'after-fail');
  }
  record('FAILURE voice publish fail → CALL_CONNECTED ZERO',
    threw
    && countExactConnected(voice) === 0
    && voice.connectedCb === 0);

  const video = boot('video', 'receiver', { publishFail: true });
  video.cache = { media: 'video', offer: OFFER, sessionId: SESSION };
  video.App.__videoIncomingSessionId = SESSION;
  let threwV = false;
  try {
    await video.App.videoCall.accept(CALLER, OFFER, { createdAt: nowSec(), sessionId: SESSION });
  } catch (_) {
    threwV = true;
  }
  const vpc = video.pcs[video.pcs.length - 1];
  if (vpc) {
    vpc.iceConnectionState = 'connected';
    if (typeof vpc.oniceconnectionstatechange === 'function') vpc.oniceconnectionstatechange();
  }
  if (typeof video.App.videoCall.maybeMarkConnected === 'function') {
    video.App.videoCall.maybeMarkConnected(CALLER, 'after-fail');
  }
  record('FAILURE video publish fail → CALL_CONNECTED ZERO',
    threwV
    && countExactConnected(video) === 0
    && video.connectedCb === 0
    && video.App.videoCall.getState().answerPublished === false);
}

function staticContracts() {
  const voice = read('chat-voice-call.js');
  const video = read('chat-video-call.js');
  const helper = read('call-signal-e2ee.js');
  const voiceUi = read('chat-voice-call-ui.js');
  record('static maybeMarkVoiceCallConnected', /function maybeMarkVoiceCallConnected/.test(voice));
  record('static maybeMarkVideoCallConnected', /function maybeMarkVideoCallConnected/.test(video));
  record('static video answerPublished flag', /answerPublished/.test(video));
  record('static CALL_ACCEPT_FLOW markers voice',
    /CALL_ACCEPT_FLOW_START/.test(voice) && /CALL_ACCEPT_ANSWER_PUBLISH_OK/.test(voice)
    && /CALL_ACCEPT_FLOW_READY/.test(voice));
  record('static CALL_ACCEPT_FLOW markers video',
    /CALL_ACCEPT_FLOW_START/.test(video) && /CALL_ACCEPT_ANSWER_PUBLISH_OK/.test(video));
  record('static CALL_ACCEPT hydrate markers UI',
    /CALL_ACCEPT_HYDRATE_START/.test(voiceUi) && /CALL_ACCEPT_HYDRATE_OK source=/.test(voiceUi));
  record('static recovery defer accept-in-flight',
    /CALL_WEB_RECOVERY_DEFER reason=accept-in-flight/.test(helper));
  record('static terminal drop preserved',
    /CALL_SESSION_TOMBSTONE_DROP/.test(helper) && /CALL_STALE_OFFER_APPLY_BLOCK/.test(voice));
}

async function main() {
  staticContracts();
  await voiceCalleeIceBeforePublish();
  await voiceCallerIceBeforeApply();
  await videoCalleeIceBeforePublish();
  await videoCallerRequiresRemoteAnswer();
  await publishFailZeroConnected();

  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
