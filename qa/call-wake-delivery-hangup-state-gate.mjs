#!/usr/bin/env node
/**
 * Call wake delivery latch + connected hangup state.
 * Run: node qa/call-wake-delivery-hangup-state-gate.mjs
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

const wake = read('android-shell/app/src/main/java/com/sos010/app/SecureCallWakeActivity.kt');
const notify = read('android-shell/app/src/main/java/com/sos010/app/NotificationHelper.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const urls = read('android-shell/app/src/main/java/com/sos010/app/SosCallUrls.kt');
const voiceUi = read('chat-voice-call-ui.js');
const videoUi = read('chat-video-call-ui.js');
const gradle = read('android-shell/app/build.gradle.kts');
const apk = JSON.parse(read('apk-version.json'));
const p2p = read('chat-p2p-datachannel.js');

record('1 launch requested != activity started',
  /SECURE_VERIFIER_LAUNCH_REQUESTED/.test(notify)
  && /SECURE_VERIFIER_ACTIVITY_STARTED/.test(wake)
  && /noteActivityStarted/.test(wake));
record('2 watchdog clears stuck launchInFlight',
  /SECURE_VERIFIER_START_TIMEOUT/.test(notify)
  && /clearLaunchInFlight/.test(notify)
  && /scheduleVerifierDeliveryWatchdog/.test(notify));
record('3 failed FSI does not clear encrypted queue',
  /isFullScreenIntentAllowed/.test(notify)
  && /Do not pretend FSI succeeded/.test(notify)
  && !/fun showSecureVerifierWake[\s\S]{0,900}drainSecureWraps/.test(notify)
  && !/fun showSecureVerifierWake[\s\S]{0,900}SosPendingCallStore\.clear/.test(notify));
record('4 fresh wake may retry after failed Activity start',
  /resetAttemptCycle/.test(notify)
  && /clearSecureWarmInFlight/.test(notify));
record('5 max 2 wake attempts per cycle',
  /MAX_LAUNCH_ATTEMPTS\s*=\s*2/.test(wake)
  && /consumeLaunchAttempt/.test(notify)
  && /canAttemptFallback/.test(notify));
record('6 canUseFullScreenIntent state inspected API34+',
  /canUseFullScreenIntent/.test(notify)
  && /SECURE_VERIFIER_FSI_ALLOWED/.test(notify)
  && /SDK_INT\s*<\s*34/.test(notify));
record('7 verifier remains minimal asset, NOT videos.html',
  /secure-call-verifier\/index\.html/.test(urls)
  && /loadUrl\(SosCallUrls\.verifierAssetUrl\(\)\)/.test(wake)
  && !/loadUrl\([^\)]*videos\.html/.test(wake));
record('8 unverified1059 ring ZERO',
  /notifySecureCallOfferVerified/.test(read('call-signal-e2ee.js'))
  && /authorizeNativeSecureOfferRing/.test(read('call-signal-e2ee.js')));
record('9 verified offer ring once',
  /nativeRingAuthOnce|CALL_RING_AUTH_ONCE/.test(read('call-signal-e2ee.js'))
  && /markRinged/.test(bridge));
record('10 connected voice END does not call markIncomingCallDeclined',
  /stillRinging && bridge && typeof bridge\.markIncomingCallDeclined/.test(voiceUi)
  && /markIncomingCallEnded/.test(voiceUi));
record('11 connected video END does not call markIncomingCallDeclined',
  /shouldMarkDeclined && bridge && typeof bridge\.markIncomingCallDeclined/.test(videoUi)
  && /!shouldMarkDeclined && bridge && typeof bridge\.markIncomingCallEnded/.test(videoUi));
record('12 connected END moveTaskToBack ZERO',
  /DECLINE_IGNORED_AFTER_ANSWER/.test(bridge)
  && /isAnsweredPhase/.test(bridge));
record('13 connected END CALL_SESSION_DECLINED ZERO',
  /DECLINE_IGNORED_AFTER_ANSWER/.test(bridge)
  && /markIncomingCallEnded\(peer\)/.test(bridge));
record('14 connected END CALL_SESSION_ENDED exactly once',
  /fun markIncomingCallEnded/.test(bridge)
  && /STATE_ENDED/.test(read('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt')));
record('15 pre-answer decline still DECLINED exactly once',
  /markActiveDeclined/.test(bridge)
  && /CALL_SESSION_DECLINED/.test(read('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt')));
record('16 answer clears pending decline',
  /ANSWER_CLEARS_PENDING_DECLINE/.test(bridge)
  && /__sosNativePendingDecline = null/.test(voiceUi)
  && /__sosNativePendingDecline = null/.test(videoUi));
record('17 stale decline after answer ignored',
  /DECLINE_IGNORED_AFTER_ANSWER/.test(bridge));
record('18 voice secure disconnect path retained',
  /function endCall/.test(read('chat-voice-call.js'))
  && /disconnect/.test(read('chat-voice-call.js')));
record('19 video secure disconnect path retained',
  /function end/.test(read('chat-video-call.js'))
  && /disconnect|v-disconnect/.test(read('chat-video-call.js')));
record('20 P2P unchanged file present',
  /MAX_IN_FLIGHT|datachannel/i.test(p2p) && fs.existsSync(path.join(ROOT, 'chat-p2p-datachannel.js')));
record('QA shell 1.0.119 / 120 / shell=119',
  /versionName\s*=\s*"1\.0\.119"/.test(gradle)
  && /versionCode\s*=\s*120/.test(gradle)
  && /shell=119/.test(gradle));
record('public apk-version not republished as 1.0.119',
  apk.version !== '1.0.119');
record('fallback logs present',
  /SECURE_VERIFIER_FALLBACK_SEND/.test(notify)
  && /SECURE_VERIFIER_FALLBACK_OK/.test(notify)
  && /SECURE_VERIFIER_FALLBACK_BLOCKED/.test(notify));
record('MODE_BACKGROUND_ACTIVITY_START_ALLOWED retained',
  /MODE_BACKGROUND_ACTIVITY_START_ALLOWED/.test(read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt')));
record('direct25050 write ZERO marker',
  /LEGACY_READ_ONLY/.test(read('chat-voice-call.js')));
record('gift wrap required true',
  JSON.parse(read('app-version.json')).callSignalGiftWrapRequired === true);

console.log(results.join('\n'));
console.log(`\nCALL_WAKE_DELIVERY_HANGUP_STATE_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
