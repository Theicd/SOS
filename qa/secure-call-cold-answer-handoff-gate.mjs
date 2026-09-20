#!/usr/bin/env node
/**
 * Cold Answer handoff: Native answered before Web offer → no ring/manual UI.
 * Run: node qa/secure-call-cold-answer-handoff-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEER_A = 'aa'.repeat(32);
const PEER_B = 'bb'.repeat(32);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function count(logs, n) {
  return logs.filter((l) => l.includes(n)).length;
}

function staticNativeContracts() {
  const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
  const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
  const recv = read('android-shell/app/src/main/java/com/sos010/app/CallActionReceiver.kt');
  record('N1 holdSoCallSplashForCall separate from pendingOpenChatList',
    /holdSoCallSplashForCall/.test(main)
    && /beginSoCallSplashForCall/.test(main)
    && /hideSoCallSplashForCallFromJs/.test(main));
  record('N2 Answer shows splash (not only chat-list)',
    /beginSoCallSplashForCall\("intent-answer"\)/.test(main)
    && /CALL_ACTION_ANSWER[\s\S]{0,400}?beginSoCallSplashForCall/.test(main));
  record('N3 notifySoCallReady does not clear call splash hold',
    /fun hideSoCallSplashFromJs[\s\S]{0,200}?if \(holdSoCallSplashForCall\) return/.test(main));
  record('N4 bridge isIncomingCallAnsweredForPeer',
    /fun isIncomingCallAnsweredForPeer/.test(bridge)
    && /isAnsweredPhase/.test(bridge)
    && /isSameActiveCall/.test(bridge));
  record('N5 notifySoCallCallUiReady',
    /fun notifySoCallCallUiReady/.test(bridge));
  record('N6 CALL_COLD markers',
    (/CALL_COLD_ANSWER_CLICK/.test(main) || /CALL_COLD_ANSWER_CLICK/.test(recv))
    && /CALL_COLD_MAIN_CREATE/.test(main)
    && /CALL_COLD_PAGE_START/.test(main)
    && /CALL_COLD_PAGE_FINISHED/.test(main));
  record('N7 deeplink autoAccept uses answeredAlready',
    /answeredAlready/.test(main) && /isAnsweredPhase/.test(main));
}

function staticWebContracts() {
  const voiceUi = read('chat-voice-call-ui.js');
  const videoUi = read('chat-video-call-ui.js');
  const deeplink = read('chat-deeplink.js');
  record('W1 voice CALL_NATIVE_ANSWER_ADOPT',
    /CALL_NATIVE_ANSWER_ADOPT/.test(voiceUi)
    && /CALL_NATIVE_ANSWER_SUPPRESS_RING/.test(voiceUi)
    && /CALL_NATIVE_ANSWER_AUTO_ACCEPT_START/.test(voiceUi)
    && /isIncomingCallAnsweredForPeer/.test(voiceUi)
    && /acceptIncomingCallFromNative/.test(voiceUi));
  record('W2 voice CALL_DEEPLINK_SKIP',
    /CALL_DEEPLINK_SKIP reason=native-already-answered/.test(voiceUi));
  record('W3 video parity adopt',
    /CALL_NATIVE_ANSWER_ADOPT/.test(videoUi)
    && /acceptIncomingVideoCallFromNative/.test(videoUi));
  record('W4 deeplink skip in chat-deeplink',
    /CALL_DEEPLINK_SKIP reason=native-already-answered/.test(deeplink));
  record('W5 notifySoCallCallUiReady from accept paths',
    /notifySoCallCallUiReady/.test(voiceUi) && /notifySoCallCallUiReady/.test(videoUi));
}

function bootVoiceUi(answeredPeers) {
  const box = {
    logs: [],
    ringtone: 0,
    dialogs: 0,
    autoAccept: 0,
    notifyReady: 0,
    notif: 0,
  };
  const answered = new Set(answeredPeers || []);
  const ctx = {
    console: {
      log: (...a) => box.logs.push(a.map(String).join(' ')),
      warn: (...a) => box.logs.push(a.map(String).join(' ')),
      error: (...a) => box.logs.push('ERR ' + a.map(String).join(' ')),
    },
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      body: {
        contains() { return false; },
        classList: { add() {}, remove() {} },
        appendChild() {},
      },
      createElement() {
        return {
          className: '',
          style: {},
          innerHTML: '',
          textContent: '',
          hidden: false,
          setAttribute() {},
          getAttribute() { return null; },
          removeAttribute() {},
          querySelector() { return null; },
          querySelectorAll() { return []; },
          appendChild() {},
          removeChild() {},
          addEventListener() {},
          remove() {},
          classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        };
      },
      getElementById() { return null; },
      querySelector() { return null; },
      documentElement: { setAttribute() {}, removeAttribute() {} },
      addEventListener() {},
    },
    window: null,
    Audio: class { play() { return Promise.resolve(); } pause() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks() { return []; } }) } },
  };
  ctx.window = ctx;
  ctx.addEventListener = function () {};
  ctx.removeEventListener = function () {};
  ctx.dispatchEvent = function () { return true; };
  ctx.requestAnimationFrame = (fn) => { try { fn(); } catch (_) {} return 1; };
  ctx.HTMLElement = class {};
  ctx.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } };
  ctx.SosNativeShell = {
    isIncomingCallAnsweredForPeer(peer) {
      return answered.has(String(peer || '').toLowerCase());
    },
    isIncomingCallSuppressed() { return false; },
    markIncomingCallAnswered() {},
    notifySoCallCallUiReady() { box.notifyReady += 1; },
    notifyNativeCallConnected() {},
  };
  ctx.NostrApp = {
    publicKey: 'cc'.repeat(32),
    privateKey: '22'.repeat(32),
    pool: {},
    chatState: { contacts: new Map() },
    voiceCall: {
      getState() { return { isCallActive: false, currentPeer: null }; },
      accept: async () => {},
      rejectIncoming: async () => {},
      end: async () => {},
    },
    CallSignalE2ee: {
      getCachedSecureOffer() { return { offer: OFFER, sessionId: 'd'.repeat(32), media: 'voice' }; },
    },
    isCallSessionTerminal() { return false; },
    initVoiceCall() {},
    pauseAllFeedVideos() {},
  };
  // Minimal stubs used by voice UI module load
  vm.createContext(ctx);
  // Load only the helpers we need by evaluating a harness that mirrors contracts.
  // Full UI file is large; exercise via exported callbacks after partial boot.
  vm.runInContext(read('chat-voice-call-ui.js'), ctx, { filename: 'chat-voice-call-ui.js' });

  // Instrument after load
  const App = ctx.NostrApp;
  const origAccept = App.acceptIncomingCallFromNative;
  App.acceptIncomingCallFromNative = function (...args) {
    box.autoAccept += 1;
    return origAccept.apply(this, args);
  };
  // Hook ringtone / dialog via globals the module uses if present
  box.App = App;
  box.ctx = ctx;
  box.answered = answered;
  return box;
}

async function runtimeCases() {
  // TEST 1: answered before offer
  {
    const box = bootVoiceUi([PEER_A]);
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('T1 no ringtone log / suppress',
      count(box.logs, 'CALL_NATIVE_ANSWER_SUPPRESS_RING') === 1
      && count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 1);
    record('T1 autoAccept starts',
      count(box.logs, 'CALL_NATIVE_ANSWER_AUTO_ACCEPT_START') === 1
      && box.autoAccept >= 1);
    record('T1 splash notify ready', box.notifyReady >= 1);
  }
  // TEST 2: normal incoming (answered=false)
  {
    const box = bootVoiceUi([]);
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('T2 normal path no ADOPT',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 0
      && count(box.logs, 'Incoming call from') >= 1);
  }
  // TEST 3: late deeplink skip
  {
    const box = bootVoiceUi([PEER_A]);
    box.ctx.__sosAcceptInFlight = true;
    box.ctx.__sosAcceptInFlightPeer = PEER_A;
    box.App.resumeIncomingVoiceCallFromDeepLink(PEER_A, null, { autoAnswering: false });
    record('T3 deeplink skip when answered/in-flight',
      count(box.logs, 'CALL_DEEPLINK_SKIP reason=native-already-answered') === 1);
  }
  // TEST 4: wrong peer
  {
    const box = bootVoiceUi([PEER_A]);
    box.App.onVoiceCallIncoming(PEER_B, OFFER);
    record('T4 wrong peer does not ADOPT',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 0);
  }
  // TEST 5: terminal
  {
    const box = bootVoiceUi([PEER_A]);
    box.App.isCallSessionTerminal = () => true;
    box.App.CallSignalE2ee.getCachedSecureOffer = () => ({
      offer: OFFER, sessionId: 'e'.repeat(32), media: 'voice',
    });
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('T5 tombstone blocks resurrect',
      count(box.logs, 'CALL_STALE_OFFER_APPLY_BLOCK') === 1
      && box.autoAccept === 0);
  }
}

async function main() {
  staticNativeContracts();
  staticWebContracts();
  try {
    await runtimeCases();
  } catch (err) {
    record('runtime harness', false, String(err && err.message || err));
    console.error(err);
  }
  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main();
