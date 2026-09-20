#!/usr/bin/env node
/**
 * Stage: secure call Native→Web live handoff for kind 1059.
 * Static + source-contract checks — no device runtime.
 * Run: node qa/secure-call-native-live-handoff-gate.mjs
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
const audio = read('chat-audio-player.js');
const state = read('chat-state.js');
const appVer = JSON.parse(read('app-version.json'));

const verifyFnIdx = watcher.indexOf('private fun verifySecureWrapsNative');
const verifyFn = verifyFnIdx >= 0 ? watcher.slice(verifyFnIdx, verifyFnIdx + 1600) : '';
const handleSecureIdx = watcher.indexOf('private fun handleSecureGiftWrap');
const handleSecure = handleSecureIdx >= 0 ? watcher.slice(handleSecureIdx, handleSecureIdx + 2200) : '';

// 1 Native answer while hostAlive → notify (not silent return)
record('1 hostAlive notifies live WebView pending',
  /notifySecurePendingAvailable/.test(verifyFn)
  && /SosNativeCallVerifier\.processPending/.test(verifyFn)
  && /CALL_NATIVE_PENDING_AVAILABLE/.test(main));

// 2-3 candidates / batch use same queue+drain
record('2 candidate uses shared pending queue',
  /enqueueSecureWrap/.test(handleSecure) && /verifySecureWrapsNative/.test(handleSecure));
record('3 candidates batch uses same drain helper',
  /reconcilePendingSecureCallSignals/.test(helper)
  && /drainPendingSecureWrapsFromNative/.test(helper));

// 4-6 dedupe via wrap id / ACK
record('4 native+web duplicate safe via wrap id',
  /rememberWrapId/.test(helper) && /status === 'duplicate'/.test(helper)
  && /ackSecureWrapHandledToNative/.test(helper));
record('5 web-first then native duplicate ACK',
  /CALL_NATIVE_PENDING_DUPLICATE/.test(helper) && /fun ackSecureWrapHandled/.test(bridge));
record('6 native-first then web duplicate uses same dispatcher',
  /enqueueSecureDispatch/.test(helper) && /dispatchGiftWrappedCallSignal/.test(helper));

// 7 not-ready defer
record('7 pending survives not-ready',
  /CALL_NATIVE_PENDING_DRAIN_DEFER reason=not-ready/.test(helper)
  && /shouldRequeueSecureWrap/.test(helper));

// 8-11 reconciliation triggers
record('8 resume triggers pending drain',
  /injectLiveSecurePendingReconcile\("resume"\)/.test(main)
  && /reconcilePendingSecureCallSignals\('resume'\)/.test(voiceUi));
record('9 subscribe READY triggers drain',
  /CALL_SECURE_SUBSCRIBE_READY/.test(helper)
  && /reconcilePendingSecureCallSignals\('subscribe-ready'\)/.test(helper));
record('10 outgoing start triggers reconciliation',
  /CALL_STARTED[\s\S]{0,220}?reconcilePendingSecureCallSignals\('outgoing-start'\)/.test(voice)
  && /CALL_STARTED[\s\S]{0,220}?reconcilePendingSecureCallSignals\('outgoing-start'\)/.test(video));
record('11 incoming accept triggers reconciliation',
  /CALL_ACCEPTED[\s\S]{0,220}?reconcilePendingSecureCallSignals\('incoming-accept'\)/.test(voice)
  && /CALL_ACCEPTED[\s\S]{0,220}?reconcilePendingSecureCallSignals\('incoming-accept'\)/.test(video));

// 12-13 only offer rings
record('12 only offer may ring (auth path)',
  /authorizeNativeSecureOfferRing/.test(helper)
  && /unwrapped\.action === 'offer'/.test(helper));
record('13 answer/candidate never ring from Native handleSecureGiftWrap',
  handleSecure.length > 0
  && !/showIncomingCall/.test(handleSecure)
  && !/IncomingCallActivity/.test(handleSecure)
  && /notifySecurePendingAvailable/.test(main)
  && !/fun notifySecurePendingAvailable[\s\S]{0,500}?showIncomingCall/.test(main));

// 14-15 tombstone / current session
record('14 stale tombstone drop remains',
  /CALL_SESSION_TOMBSTONE_DROP/.test(helper));
record('15 current-session answer not blocked by hostAlive skip',
  /notifySecurePendingAvailable/.test(verifyFn)
  && /CALL_SECURE_SIGNAL_DISPATCH/.test(helper));

// 16-17 voice + video shared path
record('16 voice route via shared helper',
  /media === 'voice'/.test(helper) && /voiceCall\.handleSecureSignal/.test(helper));
record('17 video route via shared helper',
  /media === 'video'/.test(helper) && /videoCall\.handleSecureSignal/.test(helper));

// 18-19 encryption / no plaintext restore
record('18 gift wrap kind 1059 required',
  /GIFT_WRAP_KIND/.test(helper) && appVer.callSignalGiftWrapRequired === true);
record('19 no plaintext legacy write restored',
  !/kind:\s*25050/.test(helper)
  && /publishGiftWrappedCallSignal/.test(helper));

// 20-21 stage 5A / 5B unchanged markers
record('20 stage 5A voice durability unchanged',
  /VOICE_SOURCE_BLOSSOM_E2EE/.test(audio) && /resolveDurableVoicePlayback/.test(audio));
record('21 stage 5B read/documents unchanged',
  /getReceiptBoundaryId/.test(state)
  && /READ_RECEIPT_TRUE_REGRESS_IGNORED|READ_RECEIPT_APPLIED/.test(read('chat-service.js')));

// Extra contract logs + peek/ACK
record('mutex coalesce for parallel drains',
  /pendingSecureReconcileInFlight/.test(helper)
  && /pendingSecureReconcileQueued/.test(helper));
record('peek then ACK contract',
  /peekPendingSecureWraps/.test(bridge) && /ackSecureWrapHandled/.test(bridge)
  && /peekPendingSecureWraps/.test(helper));
record('App.reconcilePendingSecureCallSignals exported',
  /App\.reconcilePendingSecureCallSignals\s*=/.test(voiceUi));
record('drain start/ok logs present',
  /CALL_NATIVE_PENDING_DRAIN_START/.test(helper)
  && /CALL_NATIVE_PENDING_DRAIN_OK/.test(helper));
record('web-miss scenario: Native is sufficient handoff',
  /CALL_NATIVE_OFFER_FASTPATH_START/.test(verifyFn)
  || /do NOT assume/.test(verifyFn)
  || /Do NOT assume/.test(verifyFn)
  || /independent Web Relay subscription/.test(verifyFn)
  || /does not prove the JS 1059 subscription/.test(verifyFn));

console.log(results.join('\n'));
console.log(
  fail
    ? 'SECURE_CALL_NATIVE_LIVE_HANDOFF_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'SECURE_CALL_NATIVE_LIVE_HANDOFF_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
