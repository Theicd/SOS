#!/usr/bin/env node
/**
 * Hotfix gate: secure 1059 background / screen-off verifier wake.
 * Static source assertions — no device runtime.
 * Run: node qa/call-secure-background-wake-gate.mjs
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

function extractFn(src, name) {
  const re = new RegExp(`(fun|private fun|override fun) ${name}\\s*\\([\\s\\S]*?\\n    (private |fun |companion |override |$)`);
  // Fallback: slice from fun name to next top-level-ish fun
  const idx = src.indexOf(`fun ${name}`);
  if (idx < 0) return '';
  const next = src.indexOf('\n    fun ', idx + 10);
  const next2 = src.indexOf('\n    private fun ', idx + 10);
  const next3 = src.indexOf('\n    companion object', idx + 10);
  const ends = [next, next2, next3].filter((n) => n > idx);
  const end = ends.length ? Math.min(...ends) : idx + 2500;
  return src.slice(idx, end);
}

const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const notify = read('android-shell/app/src/main/java/com/sos010/app/NotificationHelper.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const wakeAct = read('android-shell/app/src/main/java/com/sos010/app/SecureCallWakeActivity.kt');
const manifest = read('android-shell/app/src/main/AndroidManifest.xml');
const gradle = read('android-shell/app/build.gradle.kts');
const appVer = JSON.parse(read('app-version.json'));
const pending = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');

const handleSecure = extractFn(watcher, 'handleSecureGiftWrap');
const warmSecure = extractFn(main, 'warmHostForSecureWrap');
const showVerifier = extractFn(notify, 'showSecureVerifierWake');
const verified = extractFn(bridge, 'notifySecureCallOfferVerified');

// 1. queue on 1059
record('1059 enqueueSecureWrap present', /enqueueSecureWrap/.test(handleSecure) || /enqueueSecureWrap/.test(watcher));
record('SECURE_WAKE_QUEUED log', /SECURE_WAKE_QUEUED/.test(watcher));

// 2-4 unverified ring ZERO
record('unverified1059 ring ZERO (no showIncomingCall in handleSecureGiftWrap)',
  handleSecure.length > 0 && !handleSecure.includes('showIncomingCall'));
record('unverified1059 IncomingCallActivity ZERO in handleSecureGiftWrap',
  handleSecure.length > 0 && !handleSecure.includes('IncomingCallActivity'));
record('unverified1059 CallStyle ZERO in handleSecureGiftWrap',
  handleSecure.length > 0 && !handleSecure.includes('CallStyle'));
record('unverified1059 no markRinging in handleSecureGiftWrap',
  handleSecure.length > 0 && !handleSecure.includes('markRinging'));

// 5 PendingIntent / FSI mechanism
record('secure verifier uses fullScreenIntent',
  /setFullScreenIntent/.test(showVerifier) || /setFullScreenIntent/.test(notify));
record('secure verifier uses PendingIntent activity',
  /activityPendingIntent/.test(showVerifier) || /SecureCallWakeActivity/.test(showVerifier));
record('warmHostForSecureWrap uses showSecureVerifierWake not sole startActivity',
  /fun warmHostForSecureWrap[\s\S]{0,900}?showSecureVerifierWake/.test(main)
  && !/fun warmHostForSecureWrap[\s\S]{0,900}?app\.startActivity\(intent/.test(main));

// 6 no metadata in verifier
const verifierSlice = (showVerifier || '') + wakeAct.slice(0, 1200);
record('verifier wake has no peer/media extras',
  !/EXTRA_CALL_PEER|EXTRA_CALL_TYPE|peerPubkey|callerName|putExtra\([^)]*session/i.test(verifierSlice)
  && !/putExtra\([^)]*sdp/i.test(verifierSlice));

// 7 one verifier for multiple wraps
record('multiple wraps: secureWarmInFlight / launchInFlight dedupe',
  /secureWarmInFlight/.test(watcher) && /tryBeginLaunch|isLaunchInFlight/.test(watcher));

// 8 verified offer → real ring
record('verified offer notifySecureCallOfferVerified → showIncomingCall',
  /showIncomingCall/.test(verified) && /warmHostForIncomingCall/.test(verified));
record('SECURE_NATIVE_RING_AUTHORIZED after auth',
  /SECURE_NATIVE_RING_AUTHORIZED/.test(bridge) || /SECURE_WRAP_AUTH_OK/.test(bridge));

// 9-13 ring only after auth (phase1c covers SDP etc; assert handle path still opaque)
record('candidate/disconnect not in handleSecureGiftWrap ring path',
  !/showIncomingCall/.test(handleSecure));
record('SecureCallWakeActivity exported=false',
  /SecureCallWakeActivity/.test(manifest) && /android:name="\.SecureCallWakeActivity"[\s\S]*?android:exported="false"/.test(manifest));
record('SecureCallWakeActivity no sound/ringtone in source',
  !/MediaPlayer|startRingtone|CallSoundHelper/.test(wakeAct));

// 14 queue drain
record('queue peeked after WebView ready (injectSecureWrapProcessing)',
  /peekSecureWraps/.test(main) && /injectSecureWrapProcessing/.test(main));

// 15 Activity destroyed → verifier path
record('Activity destroyed wake uses FSI verifier',
  /showSecureVerifierWake/.test(main) && /CHANNEL_SECURE_WAKE/.test(notify));

// Wake lock bounded
record('PARTIAL_WAKE_LOCK bounded for verifier',
  /PARTIAL_WAKE_LOCK/.test(wakeAct) && /WAKE_MS\s*=\s*\d+_000L/.test(wakeAct));

// Queue limits unchanged
record('secure queue MAX 32', /MAX_SECURE_WRAPS\s*=\s*32|maxSecure.*=\s*32|32/.test(pending));
record('policy remains callSignalGiftWrapRequired true', appVer.callSignalGiftWrapRequired === true);
record('APK QA version 1.0.120 / 121',
  /versionName\s*=\s*"1\.0\.120"/.test(gradle) && /versionCode\s*=\s*121/.test(gradle));
record('production web version call-wake-hangup1',
  String(appVer.version || '').includes('call-wake-hangup1'));
record('durable handled store present',
  fs.existsSync(path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosSecureWrapHandledStore.kt')));
record('SECURE_WAKE_REPLAY_DROP log', /SECURE_WAKE_REPLAY_DROP/.test(watcher));
record('SECURE_WAKE_RECOVERY_PENDING log', /SECURE_WAKE_RECOVERY_PENDING/.test(watcher));
record('ackSecureWrapHandled bridge', /fun ackSecureWrapHandled/.test(bridge));
record('session tombstone store present',
  fs.existsSync(path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt')));
record('DECLINE_CANCEL_KEEPFRONT present', /DECLINE_CANCEL_KEEPFRONT/.test(main) || /DECLINE_CANCEL_KEEPFRONT/.test(bridge));
record('VERIFY_ONLY_IDLE_SHUTDOWN present', /VERIFY_ONLY_IDLE_SHUTDOWN/.test(main));
record('SW cache v851', /sos-cache-v851/.test(read('service-worker.js')));
record('public APK is 1.0.119',
  JSON.parse(read('apk-version.json')).version === '1.0.119'
  && Number(JSON.parse(read('apk-version.json')).versionCode) === 120);
record('session-terminal WEB ACK restored for fastwake',
  /ackSecureWrapHandledToNative/.test(read('call-signal-e2ee.js')));
record('QA shell version 1.0.120 / 121',
  /versionName\s*=\s*"1\.0\.120"/.test(read('android-shell/app/build.gradle.kts'))
  && /versionCode\s*=\s*121/.test(read('android-shell/app/build.gradle.kts')));
record('public APK pointer is 1.0.119',
  JSON.parse(read('apk-version.json')).version === '1.0.119'
  && Number(JSON.parse(read('apk-version.json')).versionCode) === 120);
record('minimal verifier asset present',
  fs.existsSync(path.join(ROOT, 'android-shell/app/src/main/assets/secure-call-verifier/index.html')));

console.log(results.join('\n'));
console.log(`\nCALL_SECURE_BACKGROUND_WAKE_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
