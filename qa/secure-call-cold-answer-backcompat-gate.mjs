#!/usr/bin/env node
/**
 * Cold-answer Web must be safe on APK 1.0.123 (no new Native bridge APIs)
 * and fully use APK 1.0.124+ when present.
 * Run: node qa/secure-call-cold-answer-backcompat-gate.mjs
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
  return logs.filter((l) => String(l).includes(n)).length;
}

function staticGuards() {
  const voice = read('chat-voice-call-ui.js');
  const video = read('chat-video-call-ui.js');
  const deeplink = read('chat-deeplink.js');
  const all = voice + video + deeplink;

  // Every isIncomingCallAnsweredForPeer use must be behind typeof === 'function'
  const bareAnswered = all.match(/\.isIncomingCallAnsweredForPeer\s*\(/g) || [];
  const guardedAnswered = all.match(/typeof\s+bridge\.isIncomingCallAnsweredForPeer\s*===\s*'function'/g) || [];
  record('static every answered-bridge call is typeof-guarded',
    bareAnswered.length > 0 && guardedAnswered.length >= bareAnswered.length);

  const bareReady = all.match(/\.notifySoCallCallUiReady\s*\(/g) || [];
  const guardedReady = all.match(/typeof\s+bridge\.notifySoCallCallUiReady\s*===\s*'function'/g) || [];
  record('static every callUiReady call is typeof-guarded',
    bareReady.length > 0 && guardedReady.length >= bareReady.length);

  record('static isNativeIncomingAnswered returns false without API',
    /function isNativeIncomingAnswered/.test(voice)
    && /return false/.test(voice.slice(voice.indexOf('function isNativeIncomingAnswered'),
      voice.indexOf('function isNativeIncomingAnswered') + 400)));

  record('static notifyNativeCallUiReady no-ops without API',
    /function notifyNativeCallUiReady/.test(voice)
    && /typeof bridge\.notifySoCallCallUiReady === 'function'/.test(voice));

  record('static no unconditional await of splash callback',
    !/await\s+[^\n]*notifySoCallCallUiReady/.test(all)
    && !/waitFor.*CallUiReady/.test(all));
}

function el() {
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
}

function boot(opts) {
  const mode = opts.mode || 'old'; // old | new
  const answeredPeers = new Set(opts.answeredPeers || []);
  const box = {
    logs: [],
    errors: [],
    rejections: [],
    ringtone: 0,
    autoAccept: 0,
    notifyReady: 0,
    dialogs: 0,
  };
  const ctx = {
    console: {
      log: (...a) => box.logs.push(a.map(String).join(' ')),
      warn: (...a) => box.logs.push(a.map(String).join(' ')),
      error: (...a) => {
        const s = a.map(String).join(' ');
        box.logs.push('ERR ' + s);
        box.errors.push(s);
      },
    },
    setTimeout: (fn) => { try { fn(); } catch (e) { box.errors.push(String(e)); } return 1; },
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
      createElement: el,
      getElementById() { return null; },
      querySelector() { return null; },
      documentElement: { setAttribute() {}, removeAttribute() {} },
      addEventListener() {},
    },
    window: null,
    Audio: class {
      play() { box.ringtone += 1; return Promise.resolve(); }
      pause() {}
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks() { return []; } }) } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    requestAnimationFrame(fn) { try { fn(); } catch (_) {} return 1; },
    HTMLElement: class {},
    CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } },
  };
  ctx.window = ctx;
  const shell = {
    isIncomingCallSuppressed() { return false; },
    markIncomingCallAnswered() {},
    notifyNativeCallConnected() {},
  };
  if (mode === 'new') {
    shell.isIncomingCallAnsweredForPeer = (peer) => answeredPeers.has(String(peer || '').toLowerCase());
    shell.notifySoCallCallUiReady = () => { box.notifyReady += 1; };
  }
  // old mode: SosNativeShell exists but NEW APIs are absent (undefined)
  ctx.SosNativeShell = shell;
  ctx.NostrApp = {
    publicKey: 'cc'.repeat(32),
    privateKey: '22'.repeat(32),
    pool: {},
    chatState: { contacts: new Map() },
    voiceCall: {
      getState() { return { isCallActive: false, currentPeer: null, peerConnection: null }; },
      accept: async () => {},
      start: async () => {},
      rejectIncoming: async () => {},
      end: async () => {},
    },
    videoCall: {
      getState() { return { isActive: false, currentPeer: null }; },
      accept: async () => {},
      start: async () => {},
      rejectIncoming: async () => {},
      end: async () => {},
    },
    CallSignalE2ee: {
      getCachedSecureOffer() { return { offer: OFFER, sessionId: 'd'.repeat(32), media: 'voice' }; },
    },
    isCallSessionTerminal() { return false; },
    initVoiceCall() {},
    initVideoCall() {},
    pauseAllFeedVideos() {},
  };
  vm.createContext(ctx);
  const onUnhandled = (reason) => { box.rejections.push(String(reason)); };
  process.on('unhandledRejection', onUnhandled);
  try {
    vm.runInContext(read('chat-voice-call-ui.js'), ctx, { filename: 'chat-voice-call-ui.js' });
    vm.runInContext(read('chat-video-call-ui.js'), ctx, { filename: 'chat-video-call-ui.js' });
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  const App = ctx.NostrApp;
  const origVoiceAccept = App.acceptIncomingCallFromNative;
  App.acceptIncomingCallFromNative = function (...args) {
    box.autoAccept += 1;
    return origVoiceAccept.apply(this, args);
  };
  const origVideoAccept = App.acceptIncomingVideoCallFromNative;
  App.acceptIncomingVideoCallFromNative = function (...args) {
    box.autoAccept += 1;
    return origVideoAccept.apply(this, args);
  };
  // Count dialog creation via createCallDialog side effects in logs / DOM appends
  box.App = App;
  box.ctx = ctx;
  box.shell = shell;
  return box;
}

function noTypeErrors(box) {
  return box.errors.filter((e) => /TypeError|is not a function|undefined is not/i.test(e)).length === 0
    && box.rejections.length === 0;
}

function runCases() {
  // OLD_APK_NO_ANSWERED_BRIDGE + OLD_APK_NO_CALL_UI_READY_BRIDGE
  {
    const box = boot({ mode: 'old' });
    record('OLD_APK_NO_ANSWERED_BRIDGE',
      typeof box.shell.isIncomingCallAnsweredForPeer !== 'function');
    record('OLD_APK_NO_CALL_UI_READY_BRIDGE',
      typeof box.shell.notifySoCallCallUiReady !== 'function');
  }

  // OLD_APK_NORMAL_INCOMING_VOICE
  {
    const box = boot({ mode: 'old' });
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('OLD_APK_NORMAL_INCOMING_VOICE',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 0
      && count(box.logs, 'Incoming call from') >= 1
      && box.autoAccept === 0
      && noTypeErrors(box),
      noTypeErrors(box) ? '' : box.errors.join('|'));
  }

  // OLD_APK: notifyReady path during pending answer must not throw
  {
    const box = boot({ mode: 'old' });
    box.ctx.__sosNativePendingAnswer = {
      peer: PEER_A,
      callType: 'voice',
      until: Date.now() + 60000,
    };
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('OLD_APK pending-answer path no TypeError / no splash wait',
      noTypeErrors(box) && box.notifyReady === 0);
  }

  // OLD_APK_NORMAL_VIDEO
  {
    const box = boot({ mode: 'old' });
    box.App.onVideoCallIncoming(PEER_A, OFFER);
    record('OLD_APK_NORMAL_VIDEO',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 0
      && box.autoAccept === 0
      && noTypeErrors(box));
  }

  // OLD_APK deeplink with autoAccept false still focuses without crash
  {
    const box = boot({ mode: 'old' });
    box.App.resumeIncomingVoiceCallFromDeepLink(PEER_A, null, { autoAnswering: false });
    record('OLD_APK deeplink resume no TypeError',
      count(box.logs, 'CALL_DEEPLINK_SKIP reason=native-already-answered') === 0
      && noTypeErrors(box));
  }

  // NEW_APK_NATIVE_ANSWER_ADOPT
  {
    const box = boot({ mode: 'new', answeredPeers: [PEER_A] });
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('NEW_APK_NATIVE_ANSWER_ADOPT',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 1
      && count(box.logs, 'CALL_NATIVE_ANSWER_SUPPRESS_RING') === 1
      && count(box.logs, 'CALL_NATIVE_ANSWER_AUTO_ACCEPT_START') === 1
      && box.autoAccept === 1
      && noTypeErrors(box));
  }

  // NEW_APK_SPLASH_READY_CALLBACK
  {
    const box = boot({ mode: 'new', answeredPeers: [PEER_A] });
    box.App.onVoiceCallIncoming(PEER_A, OFFER);
    record('NEW_APK_SPLASH_READY_CALLBACK',
      box.notifyReady === 1 && noTypeErrors(box));
  }

  // NEW_APK late deeplink skip
  {
    const box = boot({ mode: 'new', answeredPeers: [PEER_A] });
    box.ctx.__sosAcceptInFlight = true;
    box.ctx.__sosAcceptInFlightPeer = PEER_A;
    box.App.resumeIncomingVoiceCallFromDeepLink(PEER_A, null, { autoAnswering: false });
    record('NEW_APK late deeplink no resurrection',
      count(box.logs, 'CALL_DEEPLINK_SKIP reason=native-already-answered') === 1
      && noTypeErrors(box));
  }

  // NEW_APK wrong peer
  {
    const box = boot({ mode: 'new', answeredPeers: [PEER_A] });
    box.App.onVoiceCallIncoming(PEER_B, OFFER);
    record('NEW_APK wrong peer not auto-accepted',
      count(box.logs, 'CALL_NATIVE_ANSWER_ADOPT') === 0
      && box.autoAccept === 0
      && noTypeErrors(box));
  }
}

async function main() {
  staticGuards();
  runCases();
  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
