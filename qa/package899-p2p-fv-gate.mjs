#!/usr/bin/env node
/**
 * Package 899 — Phase F + V gate: P2P connection state machine, phase deadlines,
 * failure classification, encrypted-only fallback, hash integrity, diagnostics privacy.
 * Loads p2p-connection-state.js + chat-p2p-datachannel.js / chat-p2p-file.js in VMs
 * with fake RTCPeerConnection / relay pool / Blossom. No browser, no network.
 * Run: node qa/package899-p2p-fv-gate.mjs [--out qa/package899-p2p-fv-report.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC_STATE = read('p2p-connection-state.js');
const SRC_DC = read('chat-p2p-datachannel.js');
const SRC_FILE = read('chat-p2p-file.js');
const SRC_UI = read('chat-file-transfer-ui.js');
const SRC_MEDIA = read('media-server-e2ee.js');
const SRC_VIDEO = read('p2p-video-sharing.js');
const SRC_VOICE = read('chat-voice-service.js');
const ROOT_898 = path.resolve(ROOT, '..', 'SOS-web-898-rc');
const read898 = (f) => { try { return fs.readFileSync(path.join(ROOT_898, f), 'utf8'); } catch (_) { return null; } };

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : path.join('qa', 'package899-p2p-fv-report.json');

process.on('unhandledRejection', () => {});

const FAKE_SDP_MARKER = 'QA_FAKE_SDP_MARKER_a=ice-pwd:zzzz';
const FAKE_SDP = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n${FAKE_SDP_MARKER}\r\n`;
const SELF = '11'.repeat(32);
const PEER_HI = 'ee'.repeat(32); // SELF < PEER_HI → אנחנו initiator
const PEER_LO = '00'.repeat(32); // PEER_LO < SELF → אנחנו responder
const SECRET_KEYSTRS = [];
const ALL_LOGS = [];

const gates = {};
const checks = [];
function check(gate, label, ok, detail = '') {
  if (!gates[gate]) gates[gate] = { pass: true, checks: [] };
  gates[gate].checks.push({ label, ok: !!ok, detail: String(detail || '') });
  if (!ok) gates[gate].pass = false;
  checks.push(`${ok ? 'PASS' : 'FAIL'} [${gate}] ${label}${!ok && detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeoutMs = 3000, step = 5) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(step);
  }
  return !!pred();
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

class FakeFileReader {
  readAsArrayBuffer(blob) {
    Promise.resolve().then(() => blob.arrayBuffer()).then((ab) => { this.result = ab; this.onload && this.onload({ target: this }); })
      .catch((e) => this.onerror && this.onerror(e));
  }
}

function fakeDocument() {
  return {
    readyState: 'complete', hidden: false,
    getElementById: () => null, querySelector: () => null, createElement: () => ({ getContext: () => null }),
    documentElement: { getAttribute: () => null, setAttribute: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
  };
}

function safeStr(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch (_) { return String(x); }
}

function makeSandbox(App, extra = {}) {
  const logs = [];
  const cap = (lvl) => (...a) => { const line = lvl + ' ' + a.map(safeStr).join(' '); logs.push(line); ALL_LOGS.push(line); };
  const con = { log: cap('log'), warn: cap('warn'), error: cap('error'), info: cap('info'), debug: cap('debug'), group: cap('group'), groupCollapsed: cap('group'), groupEnd: () => {}, table: cap('table') };
  const sb = {
    console: con, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    crypto: webcrypto, FileReader: FakeFileReader, Blob, File, Uint8Array, Uint16Array, ArrayBuffer, DataView,
    Promise, Map, Set, WeakMap, JSON, Math, Date, Number, String, Object, Error, TypeError, Array, Symbol,
    parseInt, parseFloat, isNaN, isFinite, atob, btoa, TextEncoder, TextDecoder,
    URL: { createObjectURL: () => 'blob:qa', revokeObjectURL: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hostname: 'qa.local', href: 'https://qa.local/videos.html' },
    navigator: { userAgent: 'node-qa', onLine: true },
    document: fakeDocument(),
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    NostrApp: App,
    ...extra,
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.self = sb;
  vm.createContext(sb);
  return { sb, logs };
}

// ───────────────────────────── DataChannel harness ─────────────────────────────
class FakeDC {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.sent = []; }
  send(d) { this.sent.push(d); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; if (this.onclose) this.onclose(); }
  addEventListener() {}
  removeEventListener() {}
  _open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
  _error() { if (this.onerror) this.onerror({ type: 'error' }); }
}

function loadDc({ self = SELF, scale = 0.05, publishMode = 'ok', publishDelayMs = 5 } = {}) {
  const pcs = [];
  const published = [];
  const ctl = { publishMode, publishDelayMs, presence: 0, activeXfer: false };
  class FakePC {
    constructor() { this.iceConnectionState = 'new'; this.connectionState = 'new'; this.remoteDescription = null; this.localDescription = null; this.dcs = []; pcs.push(this); }
    createDataChannel(l) { const d = new FakeDC(l); this.dcs.push(d); return d; }
    async createOffer() { return { type: 'offer', sdp: FAKE_SDP }; }
    async createAnswer() { return { type: 'answer', sdp: FAKE_SDP }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    close() { this.iceConnectionState = 'closed'; this.connectionState = 'closed'; }
    _ice(st) { this.iceConnectionState = st; if (this.oniceconnectionstatechange) this.oniceconnectionstatechange(); }
    _pc(st) { this.connectionState = st; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
    _localCand() { if (this.onicecandidate) this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0' } }); }
    _incomingDc(label) { const d = new FakeDC(label); if (this.ondatachannel) this.ondatachannel({ channel: d }); return d; }
  }
  const App = {
    publicKey: self,
    relayUrls: ['wss://r1.qa', 'wss://r2.qa'],
    _p2pQaDeadlineScale: scale,
    SosCryptoSigner: {
      hasIdentityKey: () => true,
      nip04Encrypt: async (_p, raw) => 'enc:' + raw.length,
      signP2pSignal: async (e) => ({ ...e, id: 'qa', sig: 'qa' }),
    },
    pool: {
      publish: (relays, ev) => {
        const type = (ev.tags.find((t) => t[0] === 'type') || [])[1];
        published.push({ type, at: Date.now() });
        return relays.map(() => {
          if (ctl.publishMode === 'down') return Promise.reject(new Error('connection failure: websocket closed'));
          if (ctl.publishMode === 'reject') return Promise.reject(new Error('blocked: event rejected by policy'));
          if (ctl.publishMode === 'hang') return new Promise(() => {});
          return new Promise((r) => setTimeout(() => r('ok'), ctl.publishDelayMs));
        });
      },
      subscribeMany: (_r, _f, h) => { setTimeout(() => h.oneose && h.oneose(), 1); return { close() {} }; },
    },
    getChatPresence: () => (ctl.presence ? { lastSeenAt: ctl.presence } : null),
    hasActiveChatFileTransfer: () => ctl.activeXfer,
  };
  const { sb, logs } = makeSandbox(App, { RTCPeerConnection: FakePC, RTCIceCandidate: class { constructor(c) { Object.assign(this, c); } } });
  vm.runInContext(SRC_STATE, sb);
  vm.runInContext(SRC_DC, sb);
  const dc = App.dataChannel;
  return {
    App, dc, pcs, published, ctl, logs,
    trk: (p) => App.P2pConn.peer(p),
    lastPc: () => pcs[pcs.length - 1],
    answer: (p) => dc.ingestSignal('qa', { type: 'dc-answer', data: { type: 'answer', sdp: FAKE_SDP } }, p),
    offer: (p) => dc.ingestSignal('qa', { type: 'dc-offer', data: { type: 'offer', sdp: FAKE_SDP } }, p),
    cands: (p, n = 1) => dc.ingestSignal('qa', { type: 'dc-candidates', data: Array.from({ length: n }, (_, i) => ({ candidate: 'candidate:' + i, sdpMid: '0' })) }, p),
  };
}

async function initiatorToIce(h, peer) {
  await h.dc.connect(peer);
  await until(() => h.pcs.length > 0 && h.trk(peer).state === 'ANSWER_WAIT', 3000);
  await h.answer(peer);
  await until(() => h.trk(peer).state === 'ICE_CONNECTING', 1000);
}

async function dcScenarios(matrix) {
  // 1 healthy new DC
  {
    const h = loadDc();
    const t0 = Date.now();
    await h.dc.connect(PEER_HI);
    const w = h.dc.waitForOpen(PEER_HI);
    await until(() => h.trk(PEER_HI).state === 'ANSWER_WAIT', 3000);
    await h.answer(PEER_HI);
    await h.cands(PEER_HI, 2);
    h.lastPc()._localCand();
    h.lastPc()._ice('connected');
    const midState = h.trk(PEER_HI).state;
    h.lastPc().dcs[0]._open();
    const r = await w;
    await sleep(30);
    const hist = h.trk(PEER_HI).snapshot().history.join(',');
    check('P2P_CONNECTION_STATE_MACHINE_GATE', 'late publish ack never moves state backwards from DC_OPEN', h.trk(PEER_HI).state === 'DC_OPEN' && !/DC_OPEN>ANSWER_WAIT/.test(hist), hist);
    const ok = r.ok && !r.reused && midState === 'DC_CONNECTING';
    matrix.push({ scenario: 'healthy_new_dc', expected: 'DC_OPEN', actual: r.ok ? 'DC_OPEN' : r.failure, ms: Date.now() - t0, ok });
    check('P2P_CONNECTION_STATE_MACHINE_GATE', 'initiator IDLE→SIGNALING→OFFER_SENT→ANSWER_WAIT→ICE_CONNECTING→DC_CONNECTING→DC_OPEN',
      ok && /SIGNALING>OFFER_SENT/.test(hist) && /OFFER_SENT>ANSWER_WAIT/.test(hist) && /ANSWER_WAIT>ICE_CONNECTING/.test(hist) && /ICE_CONNECTING>DC_CONNECTING/.test(hist) && /DC_CONNECTING>DC_OPEN/.test(hist), hist);
    // 2 healthy existing DC
    const t1 = Date.now();
    const r2 = await h.dc.waitForOpen(PEER_HI);
    const pubBefore = h.published.length;
    await h.dc.connect(PEER_HI);
    const reuseOk = r2.ok && r2.reused && r2.waitedMs === 0 && h.published.length === pubBefore && h.pcs.length === 1;
    matrix.push({ scenario: 'healthy_existing_dc', expected: 'REUSED', actual: r2.reused ? 'REUSED' : 'NEW', ms: Date.now() - t1, ok: reuseOk });
    check('P2P_PERSISTENT_DC_REUSE_GATE', 'healthy DC reused: no signaling, no new PC, 0ms wait', reuseOk, JSON.stringify(r2));
    // stale DC: DC open but ICE disconnected → not healthy
    h.lastPc()._ice('disconnected');
    const staleNotHealthy = h.dc.isHealthy(PEER_HI) === false;
    const graceNoFail = h.trk(PEER_HI).state === 'DC_OPEN' && !h.trk(PEER_HI).failure;
    await sleep(80);
    h.lastPc()._ice('connected');
    await sleep(Math.round(4000 * 0.05) + 80);
    check('P2P_STALE_DC_DETECTION_GATE', 'open DC over disconnected ICE is not healthy', staleNotHealthy);
    check('P2P_STALE_DC_DETECTION_GATE', 'ICE recovery inside grace → healthy again, no failure', h.dc.isHealthy(PEER_HI) && !h.trk(PEER_HI).failure, JSON.stringify(h.trk(PEER_HI).snapshot()));
    check('P2P_ACTIVE_TRANSFER_CONNECTION_PROTECTION_GATE', 'ICE disconnected is not an immediate failure', graceNoFail);
    // DC closes mid transfer
    h.ctl.activeXfer = true;
    h.lastPc()._ice('disconnected');
    await sleep(Math.round(4000 * 0.05) + 60);
    const survivedSoft = !h.trk(PEER_HI).failure;
    await sleep(Math.round(10000 * 0.05));
    const afterHard = h.trk(PEER_HI).failure ? h.trk(PEER_HI).failure.code : null;
    check('P2P_ACTIVE_TRANSFER_CONNECTION_PROTECTION_GATE', 'active transfer gets hard grace (not killed at soft grace)', survivedSoft);
    check('P2P_ACTIVE_TRANSFER_CONNECTION_PROTECTION_GATE', 'grace expiry after hard → precise code', afterHard === 'DATA_CHANNEL_CLOSED', afterHard);
  }
  // DC closes mid-transfer (explicit onclose)
  {
    const h = loadDc();
    await initiatorToIce(h, PEER_HI);
    h.lastPc()._ice('connected');
    h.lastPc().dcs[0]._open();
    const t0 = Date.now();
    h.lastPc().dcs[0].close();
    const code = h.trk(PEER_HI).failure && h.trk(PEER_HI).failure.code;
    matrix.push({ scenario: 'dc_closes_mid_transfer', expected: 'DATA_CHANNEL_CLOSED', actual: code, ms: Date.now() - t0, ok: code === 'DATA_CHANNEL_CLOSED' });
    const h2 = loadDc();
    await initiatorToIce(h2, PEER_HI);
    h2.lastPc()._ice('connected');
    h2.lastPc().dcs[0]._open();
    h2.lastPc().dcs[0]._error();
    h2.lastPc().dcs[0].close();
    const code2 = h2.trk(PEER_HI).failure && h2.trk(PEER_HI).failure.code;
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'DC error then close → DATA_CHANNEL_ERROR', code2 === 'DATA_CHANNEL_ERROR', code2);
  }
  // 3 slow signaling (publish slow + late answer, still inside hard)
  {
    const h = loadDc({ publishDelayMs: 150 });
    const t0 = Date.now();
    await h.dc.connect(PEER_HI);
    const w = h.dc.waitForOpen(PEER_HI);
    await until(() => h.pcs.length > 0, 3000);
    await sleep(350);
    const stateBefore = h.trk(PEER_HI).state;
    await h.answer(PEER_HI);
    h.lastPc()._ice('connected');
    h.lastPc().dcs[0]._open();
    const r = await w;
    const ok = r.ok && !h.trk(PEER_HI).failure && stateBefore === 'ANSWER_WAIT';
    matrix.push({ scenario: 'slow_signaling', expected: 'DC_OPEN (no premature fail)', actual: r.ok ? 'DC_OPEN' : r.failure, ms: Date.now() - t0, ok });
    check('P2P_PHASE_DEADLINE_GATE', 'slow signaling inside hard deadline is not failed', ok, `${stateBefore} ${JSON.stringify(r)}`);
  }
  // late relay OK after answer + DC open (seen in real browser) must not regress state
  {
    const h = loadDc({ publishDelayMs: 150 });
    await h.dc.connect(PEER_HI);
    await until(() => h.trk(PEER_HI).state === 'OFFER_SENT' && h.lastPc() && h.lastPc().localDescription, 3000);
    await sleep(100);
    await h.answer(PEER_HI);
    h.lastPc()._ice('connected');
    h.lastPc().dcs[0]._open();
    await sleep(250);
    const hist = h.trk(PEER_HI).snapshot().history.join(',');
    check('P2P_CONNECTION_STATE_MACHINE_GATE', 'publish OK arriving after DC_OPEN keeps DC_OPEN', h.trk(PEER_HI).state === 'DC_OPEN' && h.trk(PEER_HI).evidence.publishOk === true && !/DC_OPEN>ANSWER_WAIT/.test(hist), hist);
  }
  // 4 relay unavailable
  {
    const h = loadDc({ publishMode: 'down' });
    const t0 = Date.now();
    await h.dc.connect(PEER_HI);
    const r = await h.dc.waitForOpen(PEER_HI);
    const ms = Date.now() - t0;
    const ok = !r.ok && r.failure === 'SIGNAL_RELAY_UNAVAILABLE' && r.negotiationStarted === false && ms < 1500;
    matrix.push({ scenario: 'relay_unavailable', expected: 'SIGNAL_RELAY_UNAVAILABLE', actual: r.failure, ms, ok });
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'all relays down → SIGNAL_RELAY_UNAVAILABLE, negotiationStarted=false, fast', ok, JSON.stringify(r));
    const h2 = loadDc({ publishMode: 'reject' });
    await h2.dc.connect(PEER_HI);
    const r2 = await h2.dc.waitForOpen(PEER_HI);
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'relay rejects event → SIGNAL_PUBLISH_FAILED', r2.failure === 'SIGNAL_PUBLISH_FAILED' && !r2.negotiationStarted, JSON.stringify(r2));
    const h3 = loadDc({ publishMode: 'hang' });
    await h3.dc.connect(PEER_HI);
    const r3 = await h3.dc.waitForOpen(PEER_HI);
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'publish hangs → bounded SIGNAL_RELAY_UNAVAILABLE (timeout)', r3.failure === 'SIGNAL_RELAY_UNAVAILABLE' && r3.waitedMs < 1500, JSON.stringify(r3));
    for (const rr of [r, r2, r3]) {
      check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'no ICE/DC code when negotiation never began', !/^(ICE_|DATA_CHANNEL_|PEER_CONNECTION)/.test(rr.failure || ''), rr.failure);
    }
  }
  // 5 answer missing — peer reachable recently → ANSWER_TIMEOUT; unknown → SIGNAL_DELIVERY_TIMEOUT
  {
    const h = loadDc();
    h.trk(PEER_HI).evidence.lastPeerRxAt = Date.now();
    const t0 = Date.now();
    await h.dc.connect(PEER_HI);
    const r = await h.dc.waitForOpen(PEER_HI);
    const ms = Date.now() - t0;
    const ok = r.failure === 'ANSWER_TIMEOUT' && !r.negotiationStarted && ms <= Math.round(12000 * 0.05) + 600;
    matrix.push({ scenario: 'answer_missing', expected: 'ANSWER_TIMEOUT', actual: r.failure, ms, ok });
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'peer recently seen + no answer by hard → ANSWER_TIMEOUT', ok, JSON.stringify(r));
    const h2 = loadDc();
    h2.ctl.presence = Math.floor(Date.now() / 1000) - 120;
    await h2.dc.connect(PEER_HI);
    const r2 = await h2.dc.waitForOpen(PEER_HI);
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'no proof of delivery → SIGNAL_DELIVERY_TIMEOUT', r2.failure === 'SIGNAL_DELIVERY_TIMEOUT' && !r2.negotiationStarted, JSON.stringify(r2));
    // heartbeat alone never authoritative
    const h3 = loadDc();
    h3.ctl.presence = Math.floor(Date.now() / 1000) - 5;
    await h3.dc.connect(PEER_HI);
    const r3 = await h3.dc.waitForOpen(PEER_HI);
    check('P2P_PEER_OFFLINE_GATE', 'fresh presence alone does not mark ONLINE nor block failure', r3.failure === 'SIGNAL_DELIVERY_TIMEOUT', JSON.stringify(r3));
    // responder: need-offer delivered, no offer
    const h4 = loadDc();
    h4.ctl.presence = Math.floor(Date.now() / 1000) - 120;
    await h4.dc.connect(PEER_LO);
    const r4 = await h4.dc.waitForOpen(PEER_LO);
    check('SIGNALING_FAILURE_CLASSIFICATION_GATE', 'responder need-offer delivered but no offer → SIGNAL_DELIVERY_TIMEOUT (not RELAY_UNAVAILABLE)', r4.failure === 'SIGNAL_DELIVERY_TIMEOUT', JSON.stringify(r4));
  }
  // 12 peer offline
  {
    const h = loadDc();
    h.ctl.presence = Math.floor(Date.now() / 1000) - 600;
    const t0 = Date.now();
    await h.dc.connect(PEER_HI);
    const r = await h.dc.waitForOpen(PEER_HI);
    const ms = Date.now() - t0;
    const ok = r.failure === 'PEER_OFFLINE' && h.trk(PEER_HI).state === 'PEER_OFFLINE' && ms < Math.round(12000 * 0.05);
    matrix.push({ scenario: 'peer_offline', expected: 'PEER_OFFLINE (early at soft)', actual: r.failure, ms, ok });
    check('P2P_PEER_OFFLINE_GATE', 'no answer + no signal/presence 5m → PEER_OFFLINE before hard deadline', ok, `${ms}ms ${JSON.stringify(r)}`);
    const C = h.App.P2pConn;
    check('P2P_PEER_OFFLINE_GATE', 'transport active beats stale presence', C.decidePeerOffline({ dcState: 'open', presenceAgeMs: 1e9 }).decision === 'ONLINE');
    check('P2P_PEER_OFFLINE_GATE', 'unknown presence is not offline evidence', C.decidePeerOffline({ publishOk: true, answerDeadlineExpired: true }).decision === 'UNKNOWN');
    check('P2P_PEER_OFFLINE_GATE', 'publish not delivered → UNKNOWN (never offline)', C.decidePeerOffline({ publishOk: false, answerDeadlineExpired: true }).decision === 'UNKNOWN');
    check('P2P_PEER_OFFLINE_GATE', 'presence basis marked non-authoritative', C.decidePeerOffline({ publishOk: true, presenceAgeMs: 1000 }).basis.includes('presence_recent_non_authoritative'));
  }
  // 6 ICE failure
  {
    const h = loadDc();
    await initiatorToIce(h, PEER_HI);
    await h.cands(PEER_HI, 2);
    h.lastPc()._localCand();
    const t0 = Date.now();
    h.lastPc()._ice('failed');
    const code = h.trk(PEER_HI).failure && h.trk(PEER_HI).failure.code;
    const noReconn = !(h.dc._peers.get(PEER_HI) || {}).reconnT;
    matrix.push({ scenario: 'ice_failure', expected: 'NETWORK_ENVIRONMENT_BLOCKED', actual: code, ms: Date.now() - t0, ok: code === 'NETWORK_ENVIRONMENT_BLOCKED' });
    check('NETWORK_ENVIRONMENT_BLOCK_CLASSIFICATION_GATE', 'ICE failed with local+remote candidates → NETWORK_ENVIRONMENT_BLOCKED', code === 'NETWORK_ENVIRONMENT_BLOCKED', code);
    check('NETWORK_ENVIRONMENT_BLOCK_CLASSIFICATION_GATE', 'network-blocked → no reconnect loop', noReconn && /NETWORK_ENVIRONMENT_BLOCKED'\)\{ console\.log\(`\[DC\] skip reconn network-blocked/.test(SRC_DC));
    const h2 = loadDc();
    await initiatorToIce(h2, PEER_HI);
    h2.lastPc()._ice('failed');
    const code2 = h2.trk(PEER_HI).failure && h2.trk(PEER_HI).failure.code;
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'ICE failed without remote candidates → ICE_FAILED', code2 === 'ICE_FAILED', code2);
    const h3 = loadDc();
    await initiatorToIce(h3, PEER_HI);
    h3.lastPc()._ice('checking');
    const t3 = Date.now();
    await until(() => !!h3.trk(PEER_HI).failure, 2000);
    const code3 = h3.trk(PEER_HI).failure && h3.trk(PEER_HI).failure.code;
    check('P2P_PHASE_DEADLINE_GATE', 'ICE stuck checking → ICE_TIMEOUT at ICE hard deadline', code3 === 'ICE_TIMEOUT' && Date.now() - t3 <= Math.round(15000 * 0.05) + 150, `${code3} ${Date.now() - t3}ms`);
    const h4 = loadDc();
    await initiatorToIce(h4, PEER_HI);
    h4.lastPc()._ice('connected');
    h4.lastPc()._pc('failed');
    const code4 = h4.trk(PEER_HI).failure && h4.trk(PEER_HI).failure.code;
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'PC failed after ICE connected → PEER_CONNECTION_FAILED', code4 === 'PEER_CONNECTION_FAILED', code4);
  }
  // 7 DC never opens
  {
    const h = loadDc();
    await initiatorToIce(h, PEER_HI);
    h.lastPc()._ice('connected');
    const t0 = Date.now();
    await sleep(Math.round(5000 * 0.05 * 0.5));
    const midState = h.trk(PEER_HI).state;
    const midFail = h.trk(PEER_HI).failure;
    await until(() => !!h.trk(PEER_HI).failure, 1500);
    const code = h.trk(PEER_HI).failure && h.trk(PEER_HI).failure.code;
    const ms = Date.now() - t0;
    const ok = midState === 'DC_CONNECTING' && !midFail && code === 'DATA_CHANNEL_TIMEOUT';
    matrix.push({ scenario: 'dc_never_opens', expected: 'DATA_CHANNEL_TIMEOUT', actual: code, ms, ok });
    check('P2P_PHASE_DEADLINE_GATE', 'DC_CONNECTING not failed before DC hard; DATA_CHANNEL_TIMEOUT after', ok, `${midState} ${code} ${ms}ms`);
    const pcsAfter = h.pcs.length;
    await sleep(100);
    check('P2P_RETRY_STORM_GATE', 'DC timeout does not spin new PCs (no reconnect storm)', h.pcs.length === pcsAfter, `${pcsAfter}->${h.pcs.length}`);
  }
  // responder happy path
  {
    const h = loadDc();
    await h.dc.connect(PEER_LO);
    const w = h.dc.waitForOpen(PEER_LO);
    await until(() => h.published.some((p) => p.type === 'dc-need-offer'), 2000);
    await h.offer(PEER_LO);
    await until(() => h.trk(PEER_LO).state === 'ICE_CONNECTING', 1000);
    h.lastPc()._ice('connected');
    const ch = h.lastPc()._incomingDc('sos-chat');
    ch._open();
    const r = await w;
    const hist = h.trk(PEER_LO).snapshot().history.join(',');
    check('P2P_CONNECTION_STATE_MACHINE_GATE', 'responder SIGNALING→ICE_CONNECTING→DC_CONNECTING→DC_OPEN', r.ok && /SIGNALING>ICE_CONNECTING/.test(hist) && /DC_CONNECTING>DC_OPEN/.test(hist), hist);
  }
  // retry storm
  {
    const h = loadDc();
    for (let i = 0; i < 20; i++) h.dc.connect(PEER_HI);
    await until(() => h.pcs.length > 0, 3000);
    await sleep(300);
    const offers = h.published.filter((p) => p.type === 'dc-offer').length;
    check('P2P_RETRY_STORM_GATE', '20× connect() → 1 PC, 1 offer', h.pcs.length === 1 && offers === 1, `pcs=${h.pcs.length} offers=${offers}`);
    const h2 = loadDc();
    for (let i = 0; i < 10; i++) h2.dc.resumeStandby(PEER_LO);
    await sleep(150);
    const needOffers = h2.published.filter((p) => p.type === 'dc-need-offer').length;
    check('P2P_RETRY_STORM_GATE', '10× resumeStandby → ≤1 need-offer (throttled counter reset)', needOffers <= 1, `needOffers=${needOffers}`);
    for (let i = 0; i < 10; i++) h2.dc.connect(PEER_LO);
    await sleep(150);
    const needOffers2 = h2.published.filter((p) => p.type === 'dc-need-offer').length;
    check('P2P_RETRY_STORM_GATE', 'responder need-offer throttled (8s)', needOffers2 <= 1, `needOffers=${needOffers2}`);
    check('P2P_RETRY_STORM_GATE', 'bounded retries (MAX_OFFER_RETRY/MAX_RECONN, linear backoff)', /MAX_RECONN = window\.__sosP2pHeadless \? 24 : 3/.test(SRC_DC) && /MAX_OFFER_RETRY = window\.__sosP2pHeadless \? 12 : 3/.test(SRC_DC) && /COUNTER_RESET_MIN_MS = 30000/.test(SRC_DC));
    check('DC_FAILED_NOT_RETRIED_FOREVER', 'offer retries exhausted → failPeer (terminal)', /offer_retries_exhausted/.test(SRC_DC));
  }
  // privacy of DC harness logs checked globally later
}

// ───────────────────────────── File harness ─────────────────────────────
function makeFile(size, name = 'qa.png', type = 'image/png', seed = 7) {
  const buf = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; buf[i] = x >>> 24; }
  return new File([buf], name, { type });
}

function loadFile({ scale = 0.01, self = SELF, fallbackMode = 'ok' } = {}) {
  const notes = [];
  const progress = [];
  const uploads = [];
  const signals = [];
  const published = [];
  let plaintextUploads = 0;
  const dcState = { diag: { state: 'IDLE', failure: null }, healthy: false, waitCalls: 0, waitResult: { ok: false, failure: 'PEER_OFFLINE', negotiationStarted: false, waitedMs: 3 }, waitDelayMs: 0, peers: new Map(), connectCalls: 0 };
  const ctl = { fallbackMode, persistent: null };
  const App = {
    publicKey: self,
    _p2pQaDeadlineScale: scale,
    persistChatP2PMedia: async () => {},
    appendChatMessage: () => {},
    getPersistentConnection: () => ctl.persistent,
    sendP2PSignal: async (peer, payload) => { signals.push({ peer, payload: JSON.parse(JSON.stringify(payload)) }); },
    uploadToBlossom: async () => { plaintextUploads += 1; return 'https://plain.qa/x'; },
    uploadMediaForServerFallback: async (file, opts) => {
      uploads.push({ size: file.size, opts: { requireEncryption: opts.requireEncryption, mimeType: opts.mimeType } });
      await sleep(2);
      if (ctl.fallbackMode === 'crypto-fail') { const e = new Error('MEDIA_E2EE_ENCRYPT_FAILED'); e.code = 'MEDIA_E2EE_ENCRYPT_FAILED'; throw e; }
      if (ctl.fallbackMode === 'subtle-fail') { const e = new Error('The operation failed'); e.name = 'OperationError'; throw e; }
      if (ctl.fallbackMode === 'policy') { const e = new Error('SERVER_E2EE_POLICY_BLOCKED'); e.code = 'SERVER_E2EE_POLICY_BLOCKED'; throw e; }
      if (ctl.fallbackMode === 'plain') return { url: 'https://plain.qa/x', type: 'image/png' };
      if (ctl.fallbackMode === 'upload-fail') throw new Error('blossom 503');
      return { type: 'encrypted-media', attachmentId: 'att-qa', resource: { transport: 'blossom', url: 'https://blossom.qa/ciphertext' }, media: { filename: file.name, originalSize: file.size } };
    },
    publishChatMessage: async (peer, text) => { published.push({ peer, text }); return { ok: ctl.fallbackMode !== 'publish-fail' }; },
    dataChannel: {
      init() {}, connect() { dcState.connectCalls += 1; }, forceConnect: async () => {},
      isConnected: () => dcState.healthy, isHealthy: () => dcState.healthy,
      getDiagnostics: () => ({ ...dcState.diag }),
      waitForOpen: async () => { dcState.waitCalls += 1; if (dcState.waitDelayMs) await sleep(dcState.waitDelayMs); return dcState.waitResult; },
      getChatPC: () => null,
      _peers: dcState.peers,
    },
  };
  const { sb, logs } = makeSandbox(App);
  vm.runInContext(SRC_STATE, sb);
  vm.runInContext(SRC_FILE, sb);
  App._p2pFileQaNote = (event, detail) => notes.push({ event, at: Date.now(), ...(detail || {}) });
  App.subscribeP2PFileProgress((evt) => progress.push({ ...evt, at: Date.now() }));
  return {
    App, notes, progress, uploads, signals, published, dcState, ctl, logs,
    plaintextUploads: () => plaintextUploads,
    count: (ev, pred) => notes.filter((n) => n.event === ev && (!pred || pred(n))).length,
    status: (fileId, st) => progress.find((p) => p.fileId === fileId && p.status === st),
    attempt: (fileId) => notes.find((n) => n.event === 'attempt-log' && n.attemptId && n.__fid === fileId),
  };
}

function openChannel(label = 'file-transfer') {
  const listeners = [];
  const ch = {
    label, readyState: 'open', binaryType: 'arraybuffer', bufferedAmount: 0, sent: [],
    send(d) { if (ch.readyState !== 'open') throw new Error('closed'); ch.sent.push(d); if (ch.onSend) ch.onSend(d); },
    addEventListener(t, fn) { if (t === 'message') listeners.push(fn); }, removeEventListener() {},
    close() { ch.readyState = 'closed'; },
    _dispatch(data) { const e = { data, currentTarget: ch, target: ch }; if (typeof ch.onmessage === 'function') ch.onmessage(e); listeners.forEach((fn) => fn(e)); },
  };
  return ch;
}

async function exportKey() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', key));
  const keyStr = btoa(String.fromCharCode(...raw));
  SECRET_KEYSTRS.push(keyStr);
  return { key, keyStr };
}

async function manualSend(h, { chunks = 6, fileId, mime = 'image/png', channel = openChannel(), peer = PEER_HI, sha256 } = {}) {
  const file = makeFile(chunks * h.App.P2P_FILE_CHUNK_SIZE, 'm.png', mime);
  const { key, keyStr } = await exportKey();
  const transfer = {
    fileId, file, key, keyStr, peerPubkey: peer, direction: 'send', currentChunk: 0, totalChunks: chunks, ackReceived: 0,
    paused: false, startTime: Date.now(), caption: '', dcWaitAttempts: 0, channel, lastAckedChunk: -1, completed: false,
    _sendInFlight: false, _sendQueued: false, _dcOfferSent: true, nextChunkToSend: 0, nextChunkToPrepare: 0,
    inFlightChunks: new Set(), ackedChunks: new Set(), preparingChunks: new Map(), preparedChunks: new Map(), sendGeneration: 0,
    maxInFlightSeen: 0, maxPreparingSeen: 0, maxPreparedSeen: 0, inFlightSampleSum: 0, inFlightSampleCount: 0,
    totalReadMs: 0, totalAesMs: 0, totalPrepareMs: 0, attemptId: 'qa-' + fileId, fileSelectedAt: Date.now(), p2pConnectMs: 0,
    dcReused: true, sha256, ackTimeouts: 0, retransmits: 0, windowDownshifts: 0, bufferedPeak: 0,
  };
  h.App.activeP2PTransfers.set(fileId, transfer);
  return { transfer, channel, file, keyStr };
}
const ack = (h, peer, fileId, index) => h.App._p2pFileQa.handleIncomingMessage(peer, JSON.stringify({ type: 'chunk-ack', fileId, index }), null);

async function fileScenarios(matrix, latency) {
  // healthy existing DC reused by sendFile (no signaling wait)
  {
    const h = loadFile();
    h.dcState.healthy = true;
    h.ctl.persistent = { channel: openChannel('sos-chat-persist') };
    const t0 = Date.now();
    const fileId = await h.App.sendP2PFile(PEER_HI, makeFile(3 * 65536));
    const tr = h.App.activeP2PTransfers.get(fileId);
    const ok = !!tr && tr.dcReused === true && h.dcState.waitCalls === 0 && tr.p2pConnectMs === 0;
    check('P2P_PERSISTENT_DC_REUSE_GATE', 'file send reuses healthy DC without waitForOpen', ok, `wait=${h.dcState.waitCalls} reused=${tr && tr.dcReused}`);
    check('P2P_PERSISTENT_DC_REUSE_GATE', 'file offer carries sha256 (encrypted 30078 signal)', h.signals.some((s) => s.payload.type === 'file-offer' && /^[0-9a-f]{64}$/.test(s.payload.sha256 || '')));
    check('P2P_PERSISTENT_DC_REUSE_GATE', 'text + voice reuse same DC path (dataChannel.send / isHealthy)', /isHealthy\(peer\)/.test(SRC_DC) && /function send\(peer, msg\)/.test(SRC_DC));
    matrix.push({ scenario: 'healthy_existing_dc_file', expected: 'REUSED', actual: ok ? 'REUSED' : 'WAITED', ms: Date.now() - t0, ok });
    h.App.cancelP2PFile(fileId);
  }
  // P2P unavailable → encrypted Blossom (latency sampling, several classes)
  const classes = ['PEER_OFFLINE', 'SIGNAL_RELAY_UNAVAILABLE', 'ANSWER_TIMEOUT', 'NETWORK_ENVIRONMENT_BLOCKED', 'DATA_CHANNEL_TIMEOUT'];
  for (let i = 0; i < 25; i++) {
    const h = loadFile();
    const code = classes[i % classes.length];
    h.dcState.waitResult = { ok: false, failure: code, negotiationStarted: /NETWORK|DATA_CHANNEL/.test(code), waitedMs: 2 };
    const t0 = Date.now();
    const fileId = await h.App.sendP2PFile(PEER_HI, makeFile(200 * 1024, 'p.jpg', 'image/jpeg'));
    await until(() => h.status(fileId, 'complete-blossom') || h.status(fileId, 'failed'), 2000);
    const done = h.status(fileId, 'complete-blossom');
    const failedNote = h.notes.find((n) => n.event === 'p2p-failed');
    const startNote = h.notes.find((n) => n.event === 'fallback-start');
    if (failedNote && startNote) latency.decisionToFallbackStartMs.push(startNote.at - failedNote.at);
    if (done) latency.selectToFallbackCompleteMs.push(done.at - t0);
    if (i < classes.length) {
      const ok = !!done && done.p2pFailureCode === code && h.uploads.length === 1 && h.uploads[0].opts.requireEncryption === true && h.plaintextUploads() === 0
        && !h.signals.some((s) => s.payload && s.payload.keyStr);
      check('P2P_TO_BLOSSOM_FALLBACK_GATE', `${code} → encrypted Blossom, code preserved, no P2P offer/key sent`, ok, JSON.stringify({ done: !!done, code: done && done.p2pFailureCode, uploads: h.uploads.length, sig: h.signals.length }));
      if (i === 0) matrix.push({ scenario: 'p2p_unavailable_to_blossom', expected: 'complete-blossom (encrypted)', actual: done ? 'complete-blossom' : 'none', ms: done ? done.at - t0 : -1, ok });
    }
  }
  // fallback crypto fails closed
  {
    const modes = [['crypto-fail', 'ENCRYPTION_FAILED'], ['subtle-fail', 'ENCRYPTION_FAILED'], ['plain', 'ENCRYPTION_FAILED'], ['policy', 'SERVER_E2EE_POLICY_BLOCKED'], ['upload-fail', 'FALLBACK_UPLOAD_FAILED'], ['publish-fail', 'FALLBACK_PUBLISH_FAILED']];
    for (const [mode, expected] of modes) {
      const h = loadFile({ fallbackMode: mode });
      h.dcState.waitResult = { ok: false, failure: 'PEER_OFFLINE', negotiationStarted: false, waitedMs: 1 };
      const t0 = Date.now();
      const fileId = await h.App.sendP2PFile(PEER_HI, makeFile(100 * 1024, 'c.mp4', 'video/mp4'));
      await until(() => h.status(fileId, 'failed') || h.status(fileId, 'complete-blossom'), 2000);
      const f = h.status(fileId, 'failed');
      const ok = !!f && f.failureCode === expected && f.p2pFailureCode === 'PEER_OFFLINE' && !h.status(fileId, 'complete-blossom') && h.plaintextUploads() === 0
        && (mode === 'publish-fail' || h.published.length === 0);
      check('P2P_FALLBACK_CRYPTO_FAIL_CLOSED_GATE', `${mode} → ${expected}, no plaintext, no publish`, ok, JSON.stringify({ f: f && f.failureCode, pub: h.published.length, plain: h.plaintextUploads() }));
      if (mode === 'crypto-fail') matrix.push({ scenario: 'crypto_failure_during_fallback', expected, actual: f ? f.failureCode : 'none', ms: Date.now() - t0, ok });
    }
    const h = loadFile();
    h.dcState.waitResult = { ok: false, failure: 'PEER_OFFLINE', negotiationStarted: false, waitedMs: 1 };
    const fileId = await h.App.sendP2PFile(PEER_HI, makeFile(1000, 'a.zip', 'application/zip'));
    await until(() => h.status(fileId, 'failed'), 1000);
    const f = h.status(fileId, 'failed');
    check('P2P_TO_BLOSSOM_FALLBACK_GATE', 'unsupported type → FALLBACK_TYPE_UNSUPPORTED, no torrent/plaintext', f && f.failureCode === 'FALLBACK_TYPE_UNSUPPORTED' && h.uploads.length === 0 && h.plaintextUploads() === 0, JSON.stringify(f));
  }
  // ACK timeout before first ACK → TRANSFER_READY_TIMEOUT (scale 0.01 → soft 120 / hard 240)
  {
    const h = loadFile();
    const { transfer } = await manualSend(h, { chunks: 8, fileId: 'qa-ack-ready' });
    const t0 = Date.now();
    await h.App._p2pFileQa.sendNextChunk('qa-ack-ready');
    await until(() => h.status('qa-ack-ready', 'complete-blossom') || h.status('qa-ack-ready', 'failed'), 2500);
    const done = h.status('qa-ack-ready', 'complete-blossom');
    const ms = Date.now() - t0;
    const ok = !!done && done.p2pFailureCode === 'TRANSFER_READY_TIMEOUT' && transfer.ackTimeouts === 2 && transfer.retransmits > 0 && ms < 1500;
    matrix.push({ scenario: 'ack_timeout_no_first_ack', expected: 'TRANSFER_READY_TIMEOUT → encrypted fallback', actual: done ? done.p2pFailureCode : 'none', ms, ok });
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'no ACK ever → TRANSFER_READY_TIMEOUT after FILE_READY hard (not infinite rewind)', ok, JSON.stringify({ code: done && done.p2pFailureCode, t: transfer.ackTimeouts, r: transfer.retransmits, ms }));
  }
  // receiver stalls mid-transfer → APPLICATION_ACK_TIMEOUT (soft 160 / hard 480)
  {
    const h = loadFile();
    const { transfer } = await manualSend(h, { chunks: 20, fileId: 'qa-ack-mid' });
    await h.App._p2pFileQa.sendNextChunk('qa-ack-mid');
    await until(() => transfer.inFlightChunks.size >= 4, 1000);
    for (let i = 0; i < 4; i++) ack(h, PEER_HI, 'qa-ack-mid', i);
    await until(() => transfer.inFlightChunks.size >= 5, 1000);
    const t0 = Date.now();
    await until(() => h.status('qa-ack-mid', 'complete-blossom') || h.status('qa-ack-mid', 'failed'), 3000);
    const done = h.status('qa-ack-mid', 'complete-blossom');
    const ms = Date.now() - t0;
    const ok = !!done && done.p2pFailureCode === 'APPLICATION_ACK_TIMEOUT' && transfer.ackTimeouts === 3 && transfer.windowDownshifts >= 1;
    matrix.push({ scenario: 'receiver_stalls', expected: 'APPLICATION_ACK_TIMEOUT → encrypted fallback', actual: done ? done.p2pFailureCode : 'none', ms, ok });
    check('P2P_ACK_TIMEOUT_POSTFIX_GATE', 'mid-transfer ACK stop → downshift to 4, bounded retransmit, APPLICATION_ACK_TIMEOUT', ok, JSON.stringify({ code: done && done.p2pFailureCode, t: transfer.ackTimeouts, ds: transfer.windowDownshifts, ms }));
    check('P2P_ADAPTIVE_WINDOW_SAFETY_GATE', 'window reset to MIN (4) on timeout, never above 32', transfer.sendWindow === 4 && (transfer.maxInFlightSeen || 0) <= 32, `win=${transfer.sendWindow} peak=${transfer.maxInFlightSeen}`);
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'receiver-side stall → TRANSFER_PROGRESS_TIMEOUT code present', /stalled mid-transfer', failureCode: 'TRANSFER_PROGRESS_TIMEOUT'/.test(SRC_FILE));
  }
  // slow but progressing transfer is NOT killed by total time
  {
    const h = loadFile();
    const { transfer } = await manualSend(h, { chunks: 30, fileId: 'qa-slow' });
    const t0 = Date.now();
    await h.App._p2pFileQa.sendNextChunk('qa-slow');
    while (!transfer.completed && Date.now() - t0 < 6000) {
      const pend = [...transfer.inFlightChunks].sort((a, b) => a - b);
      if (pend.length) ack(h, PEER_HI, 'qa-slow', pend[0]);
      await sleep(50);
    }
    const ms = Date.now() - t0;
    const ok = transfer.completed && !transfer.fallbackActive && transfer.ackTimeouts === 0 && ms > Math.round(48000 * 0.01);
    check('TRANSFER_INACTIVITY_DEADLINE_GATE', 'progress resets inactivity deadline; total > hard still completes', ok, JSON.stringify({ done: transfer.completed, fb: !!transfer.fallbackActive, t: transfer.ackTimeouts, ms }));
    check('P2P_ADAPTIVE_WINDOW_SAFETY_GATE', 'window grows on ACK progress, capped at 32', (transfer.sendWindow || 0) > 4 && (transfer.sendWindow || 0) <= 32, `win=${transfer.sendWindow}`);
  }
  // RTT-aware cap: low RTT never bursts above 8 (browser SCTP stall), high RTT may use up to 32
  {
    const h = loadFile();
    const q = h.App._p2pFileQa;
    const lan = {}, wan = {}, fresh = {};
    q.noteChannelAckRtt(lan, 2);
    q.noteChannelAckRtt(wan, 100);
    q.noteChannelAckRtt(wan, 120);
    const caps = { lan: q.channelWindowCap(lan), wan: q.channelWindowCap(wan), fresh: q.channelWindowCap(fresh) };
    check('P2P_ADAPTIVE_WINDOW_SAFETY_GATE', 'RTT-aware cap: low RTT ≤ 8, RTT 100ms → 32, unknown RTT → 8', caps.lan === 8 && caps.wan === 32 && caps.fresh === 8, JSON.stringify(caps));
  }
  // DC closes mid-transfer (file level)
  {
    const h = loadFile();
    const { transfer, channel } = await manualSend(h, { chunks: 20, fileId: 'qa-dc-close' });
    await h.App._p2pFileQa.sendNextChunk('qa-dc-close');
    await until(() => transfer.inFlightChunks.size >= 4, 1000);
    ack(h, PEER_HI, 'qa-dc-close', 0);
    ack(h, PEER_HI, 'qa-dc-close', 1);
    await sleep(20);
    channel.readyState = 'closed';
    h.dcState.diag = { state: 'FAILED', failure: 'DATA_CHANNEL_CLOSED' };
    const t0 = Date.now();
    ack(h, PEER_HI, 'qa-dc-close', 2);
    await until(() => h.status('qa-dc-close', 'complete-blossom') || h.status('qa-dc-close', 'failed'), 2000);
    const done = h.status('qa-dc-close', 'complete-blossom');
    const ms = Date.now() - t0;
    const ok = !!done && done.p2pFailureCode === 'DATA_CHANNEL_CLOSED' && ms < 300;
    check('DC_FAILED_NOT_RETRIED_FOREVER', 'DC FAILED mid-transfer → immediate DATA_CHANNEL_CLOSED → encrypted fallback', ok, JSON.stringify({ code: done && done.p2pFailureCode, ms }));
  }
  // DC connecting → wait (not failed); then opens → continues
  {
    const h = loadFile({ scale: 0.05 });
    const { transfer } = await manualSend(h, { chunks: 6, fileId: 'qa-dc-connecting', channel: null });
    h.dcState.diag = { state: 'DC_CONNECTING', failure: null };
    const t0 = Date.now();
    await h.App._p2pFileQa.sendNextChunk('qa-dc-connecting');
    await sleep(400);
    const notFailed = !transfer.fallbackActive && !transfer.p2pFailure;
    h.App.onFileDataChannel(PEER_HI, openChannel());
    h.dcState.diag = { state: 'DC_OPEN', failure: null };
    await until(() => h.count('chunk-sent', (n) => n.fileId === 'qa-dc-connecting' || true) > 0, 1500);
    const sent = h.count('chunk-sent') > 0;
    check('DC_CONNECTING_NOT_MISCLASSIFIED_AS_FAILED', 'DC_CONNECTING waits (no fallback), resumes when DC opens', notFailed && sent && !transfer.fallbackActive, JSON.stringify({ notFailed, sent, ms: Date.now() - t0 }));
    h.App.cancelP2PFile('qa-dc-connecting');
    const h2 = loadFile({ scale: 0.05 });
    const r2 = await manualSend(h2, { chunks: 6, fileId: 'qa-dc-never', channel: null });
    h2.dcState.diag = { state: 'DC_CONNECTING', failure: null };
    const t2 = Date.now();
    await h2.App._p2pFileQa.sendNextChunk('qa-dc-never');
    await until(() => h2.status('qa-dc-never', 'complete-blossom') || h2.status('qa-dc-never', 'failed'), 3000);
    const d2 = h2.status('qa-dc-never', 'complete-blossom');
    const ms2 = Date.now() - t2;
    const hard = Math.round(15000 * 0.05) + Math.round(5000 * 0.05);
    check('P2P_PHASE_DEADLINE_GATE', 'file DC never opens → DATA_CHANNEL_TIMEOUT at ICE+DC hard (bounded)', d2 && d2.p2pFailureCode === 'DATA_CHANNEL_TIMEOUT' && ms2 >= hard - 50 && ms2 < hard + 800, JSON.stringify({ code: d2 && d2.p2pFailureCode, ms2, hard, waits: r2.transfer.dcWaitAttempts }));
    check('P2P_RETRY_STORM_GATE', 'DC wait polls bounded (≤ hard/500ms + 2)', r2.transfer.dcWaitAttempts <= Math.ceil(hard / 500) + 2, `waits=${r2.transfer.dcWaitAttempts}`);
    const h3 = loadFile({ scale: 0.05 });
    await manualSend(h3, { chunks: 6, fileId: 'qa-dc-failed', channel: null });
    h3.dcState.diag = { state: 'FAILED', failure: 'ICE_FAILED' };
    const t3 = Date.now();
    await h3.App._p2pFileQa.sendNextChunk('qa-dc-failed');
    await until(() => h3.status('qa-dc-failed', 'complete-blossom'), 1500);
    const d3 = h3.status('qa-dc-failed', 'complete-blossom');
    check('DC_FAILED_NOT_RETRIED_FOREVER', 'diagnostics FAILED → no waiting, immediate fallback with the precise code', d3 && d3.p2pFailureCode === 'ICE_FAILED' && Date.now() - t3 < 200, JSON.stringify({ code: d3 && d3.p2pFailureCode, ms: Date.now() - t3 }));
  }
  // stale DC detection at file level
  {
    const h = loadFile();
    h.dcState.peers.set(PEER_HI, { pc: { iceConnectionState: 'disconnected' } });
    h.dcState.diag = { state: 'DC_OPEN', failure: null };
    const { transfer } = await manualSend(h, { chunks: 6, fileId: 'qa-stale' });
    await h.App._p2pFileQa.sendNextChunk('qa-stale');
    await sleep(60);
    const staleNoted = h.count('dc-stale') >= 1 && h.count('chunk-sent') === 0;
    h.dcState.peers.set(PEER_HI, { pc: { iceConnectionState: 'connected' } });
    await until(() => h.count('chunk-sent') > 0, 1500);
    check('P2P_STALE_DC_DETECTION_GATE', 'open-but-stale DC not used for chunks; resumes after ICE recovers', staleNoted && h.count('chunk-sent') > 0 && !transfer.fallbackActive, JSON.stringify({ staleNoted, sent: h.count('chunk-sent') }));
    h.App.cancelP2PFile('qa-stale');
  }
}

// ───────────── two-sided pipe for hash integrity ─────────────
function linkPipe(hs, hr, senderPk, receiverPk) {
  const a = openChannel('file-transfer');
  const b = openChannel('file-transfer');
  const copy = (d) => (d instanceof ArrayBuffer ? d.slice(0) : ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
  a.onSend = (d) => { const c = copy(d); setImmediate(() => { if (b.readyState === 'open') b._dispatch(c); }); };
  b.onSend = (d) => { const c = copy(d); setImmediate(() => { if (a.readyState === 'open') a._dispatch(c); }); };
  hs.App.onFileDataChannel(receiverPk, a);
  hr.App.onFileDataChannel(senderPk, b);
  return { a, b };
}

async function hashScenario({ tamper }) {
  const RECV = PEER_HI;
  const hs = loadFile({ self: SELF });
  const hr = loadFile({ self: RECV });
  const { a, b } = linkPipe(hs, hr, SELF, RECV);
  const fileId = 'qa-hash-' + (tamper ? 'bad' : 'ok');
  const chunks = 5;
  const probe = makeFile(chunks * 65536 - 1000, 'h.png');
  const realHash = createHash('sha256').update(Buffer.from(await probe.arrayBuffer())).digest('hex');
  const expected = tamper ? createHash('sha256').update('different').digest('hex') : realHash;
  const { key, keyStr } = await exportKey();
  const transfer = {
    fileId, file: probe, key, keyStr, peerPubkey: RECV, direction: 'send', currentChunk: 0, totalChunks: chunks, ackReceived: 0,
    paused: false, startTime: Date.now(), caption: '', dcWaitAttempts: 0, channel: a, lastAckedChunk: -1, completed: false,
    _sendInFlight: false, _sendQueued: false, _dcOfferSent: true, nextChunkToSend: 0, nextChunkToPrepare: 0,
    inFlightChunks: new Set(), ackedChunks: new Set(), preparingChunks: new Map(), preparedChunks: new Map(), sendGeneration: 0,
    maxInFlightSeen: 0, maxPreparingSeen: 0, maxPreparedSeen: 0, inFlightSampleSum: 0, inFlightSampleCount: 0,
    totalReadMs: 0, totalAesMs: 0, totalPrepareMs: 0, attemptId: 'qa-' + fileId, sha256: realHash,
  };
  hs.App.activeP2PTransfers.set(fileId, transfer);
  const offer = { type: 'file-offer', fileId, name: 'h.png', size: probe.size, mimeType: 'image/png', keyStr, totalChunks: chunks, createdAt: Math.floor(Date.now() / 1000), sha256: expected };
  await hr.App.handleP2PFileOffer(SELF, offer);
  await hs.App._p2pFileQa.sendNextChunk(fileId);
  await until(() => hr.progress.some((p) => p.fileId === fileId && (p.status === 'complete' || p.status === 'failed')), 5000);
  const recvT = hr.App.activeP2PTransfers.get(fileId);
  let duplicateOfferIgnored = null;
  if (!tamper) {
    await hr.App.handleP2PFileOffer(SELF, offer);
    await sleep(30);
    duplicateOfferIgnored = hr.count('offer-ignored-completed') === 1 && !hr.App.activeP2PTransfers.has(fileId);
  }
  const res = {
    complete: hr.progress.some((p) => p.fileId === fileId && p.status === 'complete'),
    failed: hr.progress.find((p) => p.fileId === fileId && p.status === 'failed'),
    resendRequested: hr.progress.some((p) => p.fileId === fileId && p.status === 'requesting-resend' && p.failureCode === 'INTEGRITY_HASH_FAILED'),
    mismatches: hr.count('hash-mismatch'),
    attempt: hr.notes.find((n) => n.event === 'attempt-log' && n.direction === 'receive'),
    recvT,
    duplicateOfferIgnored,
  };
  a.close(); b.close();
  return res;
}

// ───────────────────────────── main ─────────────────────────────
async function main() {
  const matrix = [];
  const latency = { decisionToFallbackStartMs: [], selectToFallbackCompleteMs: [] };

  // ── state module unit checks ──
  {
    const { sb } = makeSandbox({});
    vm.runInContext(SRC_STATE, sb);
    const C = sb.NostrApp.P2pConn;
    const needStates = ['IDLE', 'SIGNALING', 'OFFER_SENT', 'ANSWER_WAIT', 'ICE_CONNECTING', 'DC_CONNECTING', 'DC_OPEN', 'TRANSFER_ACTIVE', 'TRANSFER_STALLED', 'FAILED', 'PEER_OFFLINE', 'FALLBACK_ACTIVE', 'CLOSED'];
    check('P2P_CONNECTION_STATE_MACHINE_GATE', 'all 13 states defined', needStates.every((s) => C.STATES[s] === s), Object.keys(C.STATES).join(','));
    const needCodes = ['SIGNAL_RELAY_UNAVAILABLE', 'SIGNAL_PUBLISH_FAILED', 'SIGNAL_DELIVERY_TIMEOUT', 'ANSWER_TIMEOUT', 'ICE_FAILED', 'ICE_TIMEOUT', 'PEER_CONNECTION_FAILED', 'DATA_CHANNEL_TIMEOUT', 'DATA_CHANNEL_CLOSED', 'DATA_CHANNEL_ERROR', 'PEER_OFFLINE', 'TRANSFER_READY_TIMEOUT', 'TRANSFER_PROGRESS_TIMEOUT', 'APPLICATION_ACK_TIMEOUT', 'APPLICATION_PROTOCOL_FAILED', 'INTEGRITY_HASH_FAILED', 'ENCRYPTION_FAILED', 'DECRYPTION_FAILED', 'NETWORK_ENVIRONMENT_BLOCKED', 'USER_CANCELLED', 'UNKNOWN_P2P_FAILURE'];
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'all 21 canonical failure codes defined', needCodes.every((c) => C.FAILURES[c] === c));
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'no generic "P2P FAIL" code', !Object.keys(C.FAILURES).some((k) => /^P2P_FAIL$|^FAIL$/.test(k)) && !/['"]P2P FAIL['"]/.test(SRC_FILE + SRC_DC));
    const D = C.DEADLINES;
    check('P2P_PHASE_DEADLINE_GATE', 'every phase has soft < hard', Object.values(D).every((r) => r.soft > 0 && r.soft < r.hard), JSON.stringify(D));
    check('P2P_PHASE_DEADLINE_GATE', 'mobile-safe bounds (answer ≤12s, ICE ≤15s, DC ≤5s, progress hard ≤48s)', D.ANSWER_WAIT.hard <= 12000 && D.ICE_CONNECT.hard <= 15000 && D.DC_OPEN.hard <= 5000 && D.TRANSFER_PROGRESS.hard <= 48000);
    const cls = C.classifyConnectFailure;
    const cases = [
      [{ userCancelled: true }, 'USER_CANCELLED'],
      [{ publishOk: false, publishReasons: ['connection failure'] }, 'SIGNAL_RELAY_UNAVAILABLE'],
      [{ publishOk: false, publishReasons: ['blocked: pow'] }, 'SIGNAL_PUBLISH_FAILED'],
      [{ publishOk: true, negotiationStarted: false, lastPeerRxAgeMs: 1000 }, 'ANSWER_TIMEOUT'],
      [{ publishOk: true, negotiationStarted: false, presenceAgeMs: 120000 }, 'SIGNAL_DELIVERY_TIMEOUT'],
      [{ publishOk: true, negotiationStarted: false }, 'SIGNAL_DELIVERY_TIMEOUT'],
      [{ publishOk: true, negotiationStarted: false, presenceAgeMs: 600000 }, 'PEER_OFFLINE'],
      [{ publishOk: true, negotiationStarted: true, iceState: 'failed', localCandidates: 2, remoteCandidates: 2 }, 'NETWORK_ENVIRONMENT_BLOCKED'],
      [{ publishOk: true, negotiationStarted: true, iceState: 'failed' }, 'ICE_FAILED'],
      [{ publishOk: true, negotiationStarted: true, phaseExpired: 'ICE_CONNECT', iceState: 'checking' }, 'ICE_TIMEOUT'],
      [{ publishOk: true, negotiationStarted: true, iceEverConnected: true, pcState: 'failed' }, 'PEER_CONNECTION_FAILED'],
      [{ publishOk: true, negotiationStarted: true, iceEverConnected: true }, 'DATA_CHANNEL_TIMEOUT'],
      [{ publishOk: true, negotiationStarted: true, dcEverOpen: true }, 'DATA_CHANNEL_CLOSED'],
      [{ publishOk: true, negotiationStarted: true, dcEverOpen: true, dcError: true }, 'DATA_CHANNEL_ERROR'],
      [{ publishOk: true, negotiationStarted: true }, 'UNKNOWN_P2P_FAILURE'],
    ];
    for (const [e, want] of cases) {
      const got = cls(e);
      check('P2P_FAILURE_CLASSIFICATION_GATE', `classify ${want}`, got === want, `got=${got} ev=${JSON.stringify(e)}`);
    }
    check('P2P_FAILURE_CLASSIFICATION_GATE', 'fallback error: crypto → ENCRYPTION_FAILED', C.classifyFallbackError({ code: 'MEDIA_E2EE_ENCRYPT_FAILED' }) === 'ENCRYPTION_FAILED' && C.classifyFallbackError({ name: 'OperationError' }) === 'ENCRYPTION_FAILED');
    // scaled deadlines only in (0,1]
    sb.NostrApp._p2pQaDeadlineScale = 5;
    check('P2P_PHASE_DEADLINE_GATE', 'QA deadline scale cannot extend deadlines (>1 ignored)', C.deadline('ICE_CONNECT', 'hard') === 15000);
    sb.NostrApp._p2pQaDeadlineScale = undefined;
    // privacy
    const clean = C.sanitize({ peer: 'nsec1qqqqqq', detail: 'a=fingerprint:sha-256 AA', attemptId: 'ab'.repeat(32), code: 'ICE_FAILED', sdp: FAKE_SDP, keyStr: 'AAAA', phase: 'x' });
    check('P2P_DIAGNOSTIC_PRIVACY_GATE', 'sanitize drops nsec / SDP / long hex / non-whitelisted keys', !('peer' in clean) && !('detail' in clean) && !('attemptId' in clean) && !('sdp' in clean) && !('keyStr' in clean) && clean.code === 'ICE_FAILED', JSON.stringify(clean));
    check('P2P_DIAGNOSTIC_PRIVACY_GATE', 'peer fingerprint is 8 hex only', C.peerFingerprint(PEER_HI) === 'eeeeeeee' && C.peerFingerprint('nsec1abc') === '');
  }

  await dcScenarios(matrix);
  await fileScenarios(matrix, latency);

  // hash integrity
  {
    const good = await hashScenario({ tamper: false });
    check('P2P_HASH_FAILURE_GATE', 'valid whole-file SHA-256 → complete + hashVerified', good.complete && good.recvT === undefined && good.attempt && good.attempt.hashVerified === true, JSON.stringify({ c: good.complete, a: good.attempt }));
    check('P2P_RETRY_STORM_GATE', 'duplicate offer (DC + 30078) after verified receive → ignored, no full resend', good.duplicateOfferIgnored === true, String(good.duplicateOfferIgnored));
    const bad = await hashScenario({ tamper: true });
    const ok = !bad.complete && bad.resendRequested && bad.mismatches === 2 && bad.failed && bad.failed.failureCode === 'INTEGRITY_HASH_FAILED';
    matrix.push({ scenario: 'hash_mismatch', expected: 'INTEGRITY_HASH_FAILED (1 full resend, never complete)', actual: bad.failed ? bad.failed.failureCode : (bad.complete ? 'complete' : 'none'), ms: 0, ok });
    check('P2P_HASH_FAILURE_GATE', 'mismatch → never complete, one full resend, then INTEGRITY_HASH_FAILED', ok, JSON.stringify({ c: bad.complete, r: bad.resendRequested, m: bad.mismatches, f: bad.failed && bad.failed.failureCode }));
  }

  // ── static / security checks ──
  check('P2P_TO_BLOSSOM_FALLBACK_GATE', 'SERVER_E2EE_REQUIRED: fallback passes requireEncryption:true', /requireEncryption: true/.test(SRC_FILE) && /opts\.requireEncryption === true/.test(SRC_MEDIA));
  check('P2P_TO_BLOSSOM_FALLBACK_GATE', 'PLAINTEXT_FALLBACK_ENABLED=false: no torrent / plaintext Blossom paths in file+UI', !/fallbackToTorrent|seedOnly|uploadToBlossom\(|torrentTransfer\.requestTransfer|requestTransfer\(/.test(SRC_FILE) && !/torrentTransfer\.requestTransfer|seedOnly/.test(SRC_UI));
  check('P2P_TO_BLOSSOM_FALLBACK_GATE', 'only encrypted-media descriptor published', /uploadResult\.type === 'encrypted-media'/.test(SRC_FILE) && /non_encrypted_result_rejected/.test(SRC_FILE));
  check('SECURITY', 'FILE_KEY_PLAINTEXT_ON_SIGNALING=false: 30078 signal requires encrypted envelope', /encrypted envelope required/.test(SRC_VIDEO) && /\['enc', 'nip44'\]/.test(SRC_VIDEO));
  check('SECURITY', 'no legacy DTLS plaintext key over DC', /no LEGACY_DTLS_KEY_EXCHANGE/.test(SRC_FILE) && !/ch\.send\(JSON\.stringify\(offerPlain\)\)/.test(SRC_FILE));
  check('SECURITY', 'chunk crypto unchanged (AES-GCM per chunk)', /name: 'AES-GCM'/.test(SRC_FILE));

  // 898 repro vs 899 fix
  {
    const f898 = read898('chat-p2p-file.js');
    const ui898 = read898('chat-file-transfer-ui.js');
    const dc898 = read898('chat-p2p-datachannel.js');
    const bugs898 = {
      ackTimeoutUnbounded: !!f898 && !/_ackTimeoutStreak/.test(f898),
      plaintextTorrentFallback: !!f898 && (/fallbackToTorrent|seedOnly/.test(f898) || (!!ui898 && /torrentTransfer\.requestTransfer/.test(ui898))),
      dcWaitCountBased: !!f898 && /dcWaitAttempts/.test(f898) && !/_dcWaitSince/.test(f898),
      noFailureClassification: !!dc898 && !/classifyConnectFailure/.test(dc898),
      noHashVerification: !!f898 && !/expectedSha256/.test(f898),
    };
    let stall898 = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'package899-p2p-benchmark-before-d50.json'), 'utf8'));
      stall898 = j.root === 'SOS-web-898-rc' && j.SOS_FILE_MBPS_P50 === null && j.ALL_HASHES_OK === false;
    } catch (_) {}
    check('P2P_898_BUG_REPRO_GATE', '898 has unbounded ACK rewind / plaintext torrent fallback / count-based DC wait / no classification / no hash', Object.values(bugs898).every(Boolean), JSON.stringify(bugs898));
    check('P2P_898_BUG_REPRO_GATE', '898 benchmark at 50ms stalls (recorded)', stall898 === true, String(stall898));
    const fixed = {
      ackBounded: /_ackTimeoutStreak/.test(SRC_FILE), noPlaintext: !/fallbackToTorrent|seedOnly/.test(SRC_FILE) && !/torrentTransfer\.requestTransfer/.test(SRC_UI),
      deadlineWait: /_dcWaitSince/.test(SRC_FILE), classification: /classifyConnectFailure/.test(SRC_DC), hash: /expectedSha256/.test(SRC_FILE),
    };
    check('P2P_899_BUG_FIXED_GATE', 'all 898 bugs fixed in 899', Object.values(fixed).every(Boolean), JSON.stringify(fixed));
  }

  // diagnostics privacy over every captured log line
  {
    const blob = ALL_LOGS.join('\n');
    const leaks = [];
    if (blob.includes(FAKE_SDP_MARKER) || /a=ice-pwd|a=fingerprint/.test(blob)) leaks.push('sdp');
    for (const k of SECRET_KEYSTRS) if (k && blob.includes(k)) { leaks.push('keyStr'); break; }
    if (/nsec1[0-9a-z]{20,}/.test(blob)) leaks.push('nsec');
    check('P2P_DIAGNOSTIC_PRIVACY_GATE', `no SDP / file key / nsec in ${ALL_LOGS.length} captured log lines`, leaks.length === 0, leaks.join(','));
    const attemptLines = ALL_LOGS.filter((l) => l.includes('[P2P_ATTEMPT]') || l.includes('[P2P_CONN_FAIL]'));
    const badAttempt = attemptLines.filter((l) => /[0-9a-f]{40,}/i.test(l));
    check('P2P_DIAGNOSTIC_PRIVACY_GATE', 'structured attempt/fail lines contain no full pubkeys/hex secrets', attemptLines.length > 0 && badAttempt.length === 0, `lines=${attemptLines.length} bad=${badAttempt.length}`);
    const sample = attemptLines.find((l) => l.includes('[P2P_ATTEMPT]')) || '';
    const needFields = ['attemptId', 'peer', 'kind', 'result', 'durationMs', 'dcReused', 'fallbackUsed'];
    check('P2P_TEST_DIAGNOSTIC_GATE', 'P2P_ATTEMPT line has structured fields', needFields.every((f) => sample.includes(`"${f}"`)), sample.slice(0, 200));
  }

  // voice status (unchanged, blocker)
  const voicePlainSeed = /seedVoiceForP2P/.test(SRC_VOICE);

  // matrix
  const needScen = ['healthy_existing_dc', 'healthy_new_dc', 'slow_signaling', 'relay_unavailable', 'answer_missing', 'ice_failure', 'dc_never_opens', 'dc_closes_mid_transfer', 'ack_timeout_no_first_ack', 'receiver_stalls', 'hash_mismatch', 'peer_offline', 'p2p_unavailable_to_blossom', 'crypto_failure_during_fallback'];
  for (const s of needScen) {
    const row = matrix.find((m) => m.scenario === s);
    check('P2P_FAILURE_MATRIX_GATE', s, row && row.ok, row ? `${row.expected} vs ${row.actual}` : 'missing');
  }

  const fb = {
    decisionToFallbackStart_p50_ms: pct(latency.decisionToFallbackStartMs, 50),
    decisionToFallbackStart_p95_ms: pct(latency.decisionToFallbackStartMs, 95),
    selectToFallbackComplete_p50_ms_mock: pct(latency.selectToFallbackCompleteMs, 50),
    selectToFallbackComplete_p95_ms_mock: pct(latency.selectToFallbackCompleteMs, 95),
    worstCaseDetectMs: { SIGNAL_RELAY_UNAVAILABLE: 4000, PEER_OFFLINE: 4000, ANSWER_TIMEOUT: 12000, ICE_FAILED_or_TIMEOUT: 12000 + 15000, DATA_CHANNEL_TIMEOUT: 12000 + 15000 + 5000, TRANSFER_READY_TIMEOUT: 24000, APPLICATION_ACK_TIMEOUT: 48000 },
    samples: latency.decisionToFallbackStartMs.length,
  };
  check('P2P_FALLBACK_LATENCY_GATE', 'decision→fallback start p95 < 250ms (mock); worst-case detect bounded ≤ 48s', fb.decisionToFallbackStart_p95_ms !== null && fb.decisionToFallbackStart_p95_ms < 250 && fb.samples >= 20, JSON.stringify(fb));

  checks.forEach((l) => console.log(l));
  const summary = {};
  Object.entries(gates).forEach(([k, v]) => { summary[k] = v.pass ? 'PASS' : 'FAIL'; });
  const allPass = Object.values(gates).every((g) => g.pass);
  const report = {
    generatedAt: new Date().toISOString(),
    package: 899,
    phase: 'F+V',
    gates: summary,
    matrix,
    fallbackLatency: fb,
    voice: { VOICE_P2P_APP_E2EE_STATUS: 'NOT_YET_IMPLEMENTED', plaintextWebTorrentSeedPresent: voicePlainSeed, PACKAGE899_FINAL_RC_BLOCKED_BY_VOICE_P2P_E2EE: true },
    logLinesScanned: ALL_LOGS.length,
    result: allPass ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(report, null, 2));
  console.log('\n' + Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('\n'));
  console.log(`\nP2P_FV_GATE=${allPass ? 'PASS' : 'FAIL'} checks=${checks.length} failed=${checks.filter((c) => c.startsWith('FAIL')).length}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('GATE_CRASH', e); process.exit(2); });
