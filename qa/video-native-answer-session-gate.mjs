/**
 * Reproduces Native Answer racing ahead of the secure v-offer.
 * The receiver must adopt SESSION_A before the accept_in_flight return.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALLER = 'aa'.repeat(32);
const RECEIVER = 'bb'.repeat(32);
const SESSION_A = 'a1'.repeat(16);
const SESSION_B = 'b2'.repeat(16);
const SESSION_OLD = 'c3'.repeat(16);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
const CAND = { candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 54400 typ host', sdpMid: '0', sdpMLineIndex: 0 };

const results = [];
function record(name, ok, detail) {
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

function boot(role) {
  const box = {
    logs: [], publishes: [], poolPublishes: [], pcs: [], closes: 0, uiCloses: 0, nip04: 0, invented: 0, cache: null,
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
    crypto: { getRandomValues(buf) { buf.fill(9); return buf; } },
    navigator: { onLine: true, mediaDevices: { getUserMedia: async () => stream() } },
    document: { readyState: 'loading', hidden: false, addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    RTCIceCandidate: class RTCIceCandidate { constructor(o) { Object.assign(this, o || {}); } },
    RTCSessionDescription: class RTCSessionDescription { constructor(o) { Object.assign(this, o || {}); } },
    MediaStream: class MediaStream { constructor() { this._t = []; } addTrack(t) { this._t.push(t); } getTracks() { return this._t; } },
    NostrTools: { nip04: { decrypt: async () => null, encrypt: async () => { box.nip04 += 1; throw new Error('nip04'); } } },
  };
  ctx.window = ctx;
  ctx.RTCPeerConnection = class RTCPeerConnection {
    constructor() {
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.remoteSet = 0;
      this.closed = false;
      box.pcs.push(this);
    }
    close() { this.closed = true; box.closes += 1; }
    addTrack() {}
    setRemoteDescription() { this.remoteSet += 1; return Promise.resolve(); }
    setLocalDescription() { return Promise.resolve(); }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    addIceCandidate() { return Promise.resolve(); }
  };
  ctx.NostrApp = {
    publicKey: role === 'caller' ? CALLER : RECEIVER,
    privateKey: '22'.repeat(32),
    relayUrls: ['wss://relay.example'],
    pool: {
      publish() { box.poolPublishes.push('pool'); return []; },
      subscribeMany() { return { close() {} }; },
    },
    onVideoCallIncoming() {},
    onVideoCallStarted() {},
    onVideoCallEnded() { box.uiCloses += 1; },
    onVideoCallConnected() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('call-signal-e2ee.js'), ctx, { filename: 'call-signal-e2ee.js' });
  vm.runInContext(read('chat-video-call.js'), ctx, { filename: 'chat-video-call.js' });
  ctx.NostrApp.CallSignalE2ee.publishCallSignal = async (payload) => {
    box.publishes.push({
      type: payload && payload.type,
      sessionId: payload && payload.sessionId,
      media: payload && payload.media,
    });
    return { transport: 'giftwrap1059' };
  };
  ctx.NostrApp.CallSignalE2ee.createSessionId = () => {
    if (role === 'caller') return SESSION_A;
    box.invented += 1;
    return SESSION_B;
  };
  ctx.NostrApp.CallSignalE2ee.getCachedSecureOffer = () => box.cache;
  box.App = ctx.NostrApp;
  box.ctx = ctx;
  return box;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function logical(from, action, sessionId, data) {
  const wire = action === 'offer' ? 'v-offer'
    : action === 'answer' ? 'v-answer'
    : action === 'candidates' ? 'v-candidates'
    : 'v-disconnect';
  return {
    media: 'video',
    sender: from,
    action,
    wireType: wire,
    sessionId,
    signalId: wire + '-' + Math.random().toString(16).slice(2, 8),
    sentAt: nowSec(),
    wrapId: 'w' + Math.random().toString(16).slice(2, 10),
    data: data === undefined ? null : data,
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 30));
}

function count(box, needle) {
  return box.logs.filter((l) => l.includes(needle)).length;
}

async function main() {
  const caller = boot('caller');
  const receiver = boot('receiver');
  await caller.App.videoCall.start(RECEIVER);
  const offerSend = caller.publishes.find((p) => p.type === 'v-offer');
  record('caller outgoing session created',
    !!offerSend && offerSend.sessionId === SESSION_A && count(caller, 'CALL_VIDEO_OUTGOING_SESSION_CREATED') === 1);

  receiver.ctx.__sosAcceptInFlight = true;
  receiver.ctx.__sosAcceptInFlightPeer = CALLER;
  receiver.App.videoCall.handleSecureSignal(logical(CALLER, 'offer', SESSION_A, OFFER));
  await flush();
  const adopted = receiver.App.videoCall.getState().callSessionId === SESSION_A
    && count(receiver, 'CALL_SIGNAL_SKIP accept_in_flight') === 1
    && count(receiver, 'CALL_OFFER_OK') === 1;
  record('VIDEO_NATIVE_ACCEPT_INFLIGHT_SESSION_ADOPT', adopted);

  receiver.cache = { media: 'video', offer: OFFER, sessionId: SESSION_A };
  receiver.App.__videoIncomingSessionId = receiver.App.videoCall.getState().callSessionId;
  await receiver.App.videoCall.accept(CALLER, OFFER, { createdAt: nowSec() });
  const pc = receiver.pcs[receiver.pcs.length - 1];
  if (pc && pc.onicecandidate) {
    pc.onicecandidate({ candidate: CAND });
    pc.onicecandidate({ candidate: null });
  }
  await flush();
  const answer = receiver.publishes.find((p) => p.type === 'v-answer');
  const cands = receiver.publishes.filter((p) => p.type === 'v-candidates' || p.type === 'v-candidate');
  record('VIDEO_ANSWER_SAME_SESSION',
    !!answer && answer.sessionId === SESSION_A && answer.sessionId !== SESSION_B && receiver.invented === 0);
  record('VIDEO_CANDIDATES_SAME_SESSION',
    cands.length >= 1 && cands.every((p) => p.sessionId === SESSION_A));

  caller.App.videoCall.handleSecureSignal(logical(RECEIVER, 'answer', SESSION_A, { type: 'answer', sdp: 'v=0\r\n' }));
  await flush();
  record('VIDEO_CALLER_APPLIES_ANSWER', count(caller, 'CALL_ANSWER_APPLY') === 1);
  record('VIDEO_SESSION_MISMATCH_ANSWER', count(caller, 'CALL_SIGNAL_SKIP session_mismatch_answer') === 0);

  const callerPc = caller.pcs[caller.pcs.length - 1];
  callerPc.iceConnectionState = 'connected';
  callerPc.oniceconnectionstatechange();
  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange();
  record('VIDEO_BOTH_CONNECTED',
    count(caller, 'CALL_CONNECTED') === 1
    && count(receiver, 'CALL_CONNECTED') === 1
    && caller.App.videoCall.getState().isActive === true
    && receiver.App.videoCall.getState().isActive === true
    && caller.App.videoCall.getState().callSessionId === SESSION_A
    && receiver.App.videoCall.getState().callSessionId === SESSION_A);

  receiver.App.videoCall.handleSecureSignal(logical(CALLER, 'disconnect', SESSION_OLD, null));
  await flush();
  record('VIDEO_OLD_SESSION_DISCONNECT_DROP',
    count(receiver, 'CALL_OLD_SESSION_DISCONNECT_DROP') === 1
    && receiver.App.videoCall.getState().isActive === true
    && receiver.App.videoCall.getState().callSessionId === SESSION_A
    && pc.closed === false
    && receiver.uiCloses === 0);

  caller.publishes.length = 0;
  await caller.App.videoCall.end({ reason: 'user_end' });
  const bye = caller.publishes.filter((p) => p.type === 'v-disconnect');
  record('caller local end one disconnect', bye.length === 1 && bye[0].sessionId === SESSION_A);

  const echoBefore = receiver.publishes.filter((p) => p.type === 'v-disconnect').length;
  receiver.App.videoCall.handleSecureSignal(logical(CALLER, 'disconnect', SESSION_A, null));
  await flush();
  const echoAfter = receiver.publishes.filter((p) => p.type === 'v-disconnect').length;
  record('VIDEO_REMOTE_DISCONNECT_MATCHED',
    count(receiver, 'CALL_ENDING reason=remote_disconnect') === 1
    && receiver.App.videoCall.getState().isActive === false);
  record('VIDEO_REMOTE_DISCONNECT_UI_CLOSE', receiver.uiCloses === 1 && pc.closed === true);
  record('VIDEO_REMOTE_DISCONNECT_ECHO', echoAfter === echoBefore && receiver.nip04 === 0 && receiver.poolPublishes.length === 0);
  record('current call old-drop stays one', count(receiver, 'CALL_OLD_SESSION_DISCONNECT_DROP') === 1);
  record('adopt log has no session id',
    receiver.logs.filter((l) => l.includes('CALL_VIDEO_SESSION_ADOPTED')).every((l) => !l.includes(SESSION_A)));
  record('DIRECT25050 WRITE', caller.poolPublishes.length === 0 && receiver.poolPublishes.length === 0);
  record('NIP04 CALL WRITE', caller.nip04 === 0 && receiver.nip04 === 0);

  const names = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const touched = names.split(/\r?\n/).filter(Boolean);
  record('VOICE', !touched.some((n) => n === 'chat-voice-call.js' || n === 'chat-voice-call-ui.js'));
  record('P2P', !touched.some((n) => /p2p|webtorrent|torrent|PeerExchange|25055|30078|DataChannel/i.test(n)));
  record('BLOSSOM', !touched.some((n) => /blossom/i.test(n)));
  record('apk unchanged', !touched.includes('apk-version.json'));
  const apk = JSON.parse(read('apk-version.json'));
  const app = JSON.parse(read('app-version.json'));
  record('apk pointer 1.0.122/123', apk.version === '1.0.122' && Number(apk.versionCode) === 123);
  record('web version', app.version === '2026.09.20-presence2');
  record('flags', app.callSignalGiftWrapRequired === true && app.minSecureChatEpoch === 2 && app.e2eeSendRequired === true && app.mediaServerE2eeRequired === true);

  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
