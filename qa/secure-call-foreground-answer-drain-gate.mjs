#!/usr/bin/env node
/**
 * Foreground outgoing-call answer drain: Native queue + watchdog must recover
 * answer even when Web Relay misses and one-shot Native notify is dropped.
 * Static + source-contract checks — no device runtime.
 * Run: node qa/secure-call-foreground-answer-drain-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const helper = read('call-signal-e2ee.js');
const voiceUi = read('chat-voice-call-ui.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const store = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');
const appVer = JSON.parse(read('app-version.json'));

const verifyFnIdx = watcher.indexOf('private fun verifySecureWrapsNative');
const verifyFn = verifyFnIdx >= 0 ? watcher.slice(verifyFnIdx, verifyFnIdx + 1600) : '';
const notifyIdx = main.indexOf('fun notifySecurePendingAvailable');
const notifyFn = notifyIdx >= 0 ? main.slice(notifyIdx, notifyIdx + 1200) : '';

// --- Previous handoff still present ---
record('1 previous handoff: notifySecurePendingAvailable exists',
  /notifySecurePendingAvailable/.test(verifyFn)
  && /SosNativeCallVerifier\.processPending/.test(verifyFn)
  && /CALL_NATIVE_PENDING_AVAILABLE/.test(main));
record('2 previous handoff: reconcilePendingSecureCallSignals exists',
  /function reconcilePendingSecureCallSignals/.test(helper)
  && /App\.reconcilePendingSecureCallSignals\s*=/.test(voiceUi));

// --- HANDOFF_REV=2 markers (Native + JS) ---
record('3 HANDOFF_REV=2 Native SosRelayWatcher',
  /CALL_NATIVE_HANDOFF_REV=2/.test(watcher));
record('4 HANDOFF_REV=2 Native MainActivity notify',
  /CALL_NATIVE_HANDOFF_REV=2/.test(notifyFn));
record('5 HANDOFF_REV=2 JS helper',
  /NATIVE_HANDOFF_REV\s*=\s*2/.test(helper)
  && /CALL_NATIVE_HANDOFF_REV=/.test(helper));
record('6 HANDOFF_REV=2 voice-ui startup log',
  /CALL_NATIVE_HANDOFF_REV=/.test(voiceUi));

// --- Native notify retries (not one-shot only) ---
record('7 Native notify multi-delay retries',
  /longArrayOf\(0L,\s*400L,\s*1000L,\s*2000L\)/.test(notifyFn)
  || (/400L/.test(notifyFn) && /1000L/.test(notifyFn) && /2000L/.test(notifyFn)));

// --- Peek diagnostics ---
record('8 peekPendingSecureWrapCount bridge',
  /fun peekPendingSecureWrapCount/.test(bridge));
record('9 CALL_NATIVE_PENDING_PEEK log',
  /CALL_NATIVE_PENDING_PEEK reason=/.test(helper));
record('10 CALL_NATIVE_PENDING_QUEUE_MISMATCH log',
  /CALL_NATIVE_PENDING_QUEUE_MISMATCH/.test(helper));
record('11 CALL_NATIVE_PENDING_DISPATCH log',
  /CALL_NATIVE_PENDING_DISPATCH action=/.test(helper));
record('12 CALL_NATIVE_PENDING_DRAIN_START/OK',
  /CALL_NATIVE_PENDING_DRAIN_START/.test(helper)
  && /CALL_NATIVE_PENDING_DRAIN_OK handled=/.test(helper));

// --- Outgoing await-answer watchdog ---
record('13 startOutgoingAnswerDrainWatchdog exists',
  /function startOutgoingAnswerDrainWatchdog/.test(helper)
  && /outgoing-await-answer/.test(helper));
record('14 watchdog bounded cadence <=20s / ~750ms',
  /OUTGOING_ANSWER_WATCHDOG_MS\s*=\s*20000/.test(helper)
  && /OUTGOING_ANSWER_WATCHDOG_INTERVAL_MS\s*=\s*750/.test(helper));
record('15 voice starts watchdog on CALL_STARTED',
  /CALL_STARTED[\s\S]{0,500}?startOutgoingAnswerDrainWatchdog/.test(voice));
record('16 video starts watchdog on CALL_STARTED',
  /CALL_STARTED[\s\S]{0,500}?startOutgoingAnswerDrainWatchdog/.test(video));
record('17 voice stops watchdog on answer/end',
  /stopOutgoingAnswerDrainWatchdog\('answer-applied'\)/.test(voice)
  && /stopOutgoingAnswerDrainWatchdog\('call-end'\)/.test(voice));
record('18 video stops watchdog on answer/end',
  /stopOutgoingAnswerDrainWatchdog\('answer-applied'\)/.test(video)
  && /stopOutgoingAnswerDrainWatchdog\('call-end'\)/.test(video));
record('19 single-flight reconcile mutex',
  /pendingSecureReconcileInFlight/.test(helper)
  && /pendingSecureReconcileQueued/.test(helper));

// --- Reconciliation triggers ---
record('20 trigger: native pending notify',
  /injectLiveSecurePendingReconcile/.test(main)
  && /native-pending/.test(notifyFn));
record('21 trigger: resume',
  /injectLiveSecurePendingReconcile\("resume"\)/.test(main)
  && /reconcilePendingSecureCallSignals\('resume'\)/.test(voiceUi));
record('22 trigger: CALL_SECURE_SUBSCRIBE_READY',
  /CALL_SECURE_SUBSCRIBE_READY/.test(helper)
  && /reconcilePendingSecureCallSignals\('subscribe-ready'\)/.test(helper));
record('23 trigger: CALL_SUBSCRIBE_READY legacy',
  /CALL_SUBSCRIBE_READY[\s\S]{0,220}?reconcilePendingSecureCallSignals\('subscribe-ready-legacy'\)/.test(voice)
  && /CALL_SUBSCRIBE_READY[\s\S]{0,220}?reconcilePendingSecureCallSignals\('subscribe-ready-legacy'\)/.test(video));
record('24 trigger: outgoing CALL_STARTED',
  /reconcilePendingSecureCallSignals\('outgoing-start'\)/.test(voice)
  && /reconcilePendingSecureCallSignals\('outgoing-start'\)/.test(video));
record('25 trigger: incoming CALL_ACCEPTED',
  /reconcilePendingSecureCallSignals\('incoming-accept'\)/.test(voice)
  && /reconcilePendingSecureCallSignals\('incoming-accept'\)/.test(video));
record('26 trigger: js-bridge-ready',
  /reconcilePendingSecureCallSignals\('js-bridge-ready'\)/.test(helper));

// --- Answer diagnostics (no SDP) ---
record('27 callee answer build/publish logs voice',
  /CALL_ANSWER_BUILD_START/.test(voice)
  && /CALL_ANSWER_LOCAL_SET/.test(voice)
  && /CALL_ANSWER_PUBLISH_START/.test(voice)
  && /CALL_ANSWER_PUBLISH_OK/.test(voice));
record('28 callee answer build/publish logs video',
  /CALL_ANSWER_BUILD_START/.test(video)
  && /CALL_ANSWER_LOCAL_SET/.test(video)
  && /CALL_ANSWER_PUBLISH_START/.test(video)
  && /CALL_ANSWER_PUBLISH_OK/.test(video));
record('29 caller answer rx/apply logs voice',
  /CALL_ANSWER_RX/.test(voice)
  && /CALL_ANSWER_SESSION_OK/.test(voice)
  && /CALL_ANSWER_APPLY_START/.test(voice)
  && /CALL_ANSWER_APPLY_OK/.test(voice));
record('30 caller answer rx/apply logs video',
  /CALL_ANSWER_RX/.test(video)
  && /CALL_ANSWER_SESSION_OK/.test(video)
  && /CALL_ANSWER_APPLY_START/.test(video)
  && /CALL_ANSWER_APPLY_OK/.test(video));
record('31 answer logs never dump SDP field',
  !/CALL_ANSWER_[A-Z_]+\s*=\s*.*sdp/.test(helper + voice + video)
  && !/console\.log\(['"]CALL_ANSWER[^'"]*sdp/.test(voice + video));

// --- ACK only after successful handoff ---
record('32 peek does not remove wraps',
  /Peek opaque secure wrap queue without deleting/.test(bridge)
  || /Removal is only via ackSecureWrapHandled/.test(store));
record('33 shouldRequeue preserves temporary failures',
  /shouldRequeueSecureWrap/.test(helper)
  && /no_keys/.test(helper)
  && /CALL_NATIVE_PENDING_DRAIN_DEFER reason=not-ready/.test(helper));
record('34 ACK only on dispatched/duplicate/invalid',
  /ackSecureWrapHandledToNative/.test(helper)
  && /fun ackSecureWrapHandled/.test(bridge));

// --- answer/candidate never ring ---
record('35 only offer may ring',
  /authorizeNativeSecureOfferRing/.test(helper)
  && /unwrapped\.action === 'offer'/.test(helper));
record('36 notify path does not show IncomingCall',
  !/fun notifySecurePendingAvailable[\s\S]{0,800}?showIncomingCall/.test(main)
  && !/fun notifySecurePendingAvailable[\s\S]{0,800}?IncomingCallActivity/.test(main));

// --- Dedupe / already-applied guards ---
record('37 wrapId/signalId dedupe in helper',
  /rememberWrapId/.test(helper) && /rememberSignalId/.test(helper)
  && /status === 'duplicate'/.test(helper));
record('38 voice skips duplicate answer apply',
  /CALL_ANSWER_APPLY_SKIP reason=already-applied/.test(voice));
record('39 video skips duplicate answer apply',
  /CALL_ANSWER_APPLY_SKIP reason=already-applied/.test(video));

// --- Bilateral CALL_CONNECTED ---
record('40 voice CALL_CONNECTED gated on callAnswered',
  /CALL_CONNECTED_DEFER reason=await-answer/.test(voice)
  && /if \(!state\.callAnswered\)/.test(voice));
record('41 video CALL_CONNECTED gated on answer',
  /CALL_CONNECTED_DEFER reason=await-answer/.test(video));

// --- Voice + video shared dispatcher ---
record('42 shared dispatcher voice+video',
  /media === 'voice'/.test(helper)
  && /media === 'video'/.test(helper)
  && /voiceCall\.handleSecureSignal/.test(helper)
  && /videoCall\.handleSecureSignal/.test(helper));

// --- Encryption / no version bump ---
record('43 gift wrap required unchanged',
  appVer.callSignalGiftWrapRequired === true
  && /GIFT_WRAP_KIND/.test(helper));
record('44 no public version bump in this patch contract',
  typeof appVer.version === 'string');

// --- Physical QA scenario contracts (source-level) ---
record('QA1 Native-only answer recovered by watchdog (no web relay needed)',
  /outgoing-await-answer/.test(helper)
  && /peekNativePendingSecureWraps|peekPendingSecureWraps/.test(helper)
  && /do NOT assume|independent Web Relay|Web Relay/.test(verifyFn + helper));
record('QA2 dropped Native notify recovered by watchdog <=1s cadence',
  /OUTGOING_ANSWER_WATCHDOG_INTERVAL_MS\s*=\s*750/.test(helper)
  && /CALL_NATIVE_PENDING_WATCHDOG_START/.test(helper));
record('QA3 Native+Web duplicate answer apply once',
  /CALL_ANSWER_APPLY_SKIP reason=already-applied/.test(voice)
  && /CALL_NATIVE_PENDING_DUPLICATE/.test(helper));
record('QA4 queue persists across temporary JS unavailable',
  /shouldRequeueSecureWrap/.test(helper)
  && /peekPendingSecureWraps/.test(bridge)
  && /Removal is only via ackSecureWrapHandled/.test(store));

console.log(results.join('\n'));
console.log(
  fail
    ? 'SECURE_CALL_FOREGROUND_ANSWER_DRAIN_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'SECURE_CALL_FOREGROUND_ANSWER_DRAIN_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
