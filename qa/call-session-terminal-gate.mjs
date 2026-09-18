#!/usr/bin/env node
/**
 * Call session terminal gate — one session one ring, decline terminal, ACK sync.
 * Run: node qa/call-session-terminal-gate.mjs
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

const sessionStore = read('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const incoming = read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt');
const e2ee = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const voiceUi = read('chat-voice-call-ui.js');
const deeplink = read('chat-deeplink.js');
const appVer = JSON.parse(read('app-version.json'));
const gradle = read('android-shell/app/build.gradle.kts');

// 1 fresh offer → one ring
record('1 ring once per session (native markRinged)',
  /fun markRinged/.test(sessionStore) && /CALL_RING_AUTH_ONCE/.test(sessionStore));
record('1 authorizeNative checks tombstone before ring',
  /isSecureCallSessionTombstoned/.test(e2ee) && /authorizeNativeSecureOfferRing/.test(e2ee));

// 2 same session retry ring ZERO
record('2 nativeRingAuthOnce keyed by sessionId',
  /ringKey = sessionId/.test(e2ee) || /nativeRingAuthOnce\.has\(ringKey\)/.test(e2ee));
record('2 notifySecureCallOfferVerified drops if already ringed',
  /markRinged[\s\S]{0,200}?return@post/.test(bridge) || /hasRingedSession/.test(bridge));

// 3 candidate before offer — no authorize without offer action
record('3 only offer action authorizes ring',
  /unwrapped\.action !== 'offer'/.test(e2ee) || /action !== 'offer'/.test(e2ee));

// 4 decline tombstone
record('4 decline marks DECLINED',
  /STATE_DECLINED/.test(sessionStore) && /markActiveDeclined/.test(bridge));
record('4 IncomingCallActivity decline marks active declined',
  /markActiveDeclined/.test(incoming));

// 5/6 candidate/offer after decline tombstone drop
record('5/6 CALL_SESSION_TOMBSTONE_DROP in e2ee',
  /CALL_SESSION_TOMBSTONE_DROP/.test(e2ee));
record('5/6 tombstone check on non-offer actions',
  /tombstone_drop/.test(e2ee));

// 7/8 process restart / replay — durable store + TTL
record('7/8 durable session prefs + TTL 3m',
  /sos_secure_call_sessions/.test(sessionStore) && /TTL_MS\s*=\s*3L/.test(sessionStore));
record('7/8 stores only hash (no peer/sdp)',
  /put\("h"/.test(sessionStore) && !/\.put\("peer"|\.put\("sdp"/.test(sessionStore));

// 9 new session after decline can ring — markRinged is per-hash
record('9 new sessionId gets CALL_SESSION_NEW',
  /CALL_SESSION_NEW/.test(sessionStore));

// 10 disconnect exactly one
record('10 CALL_DISCONNECT_ONCE in voice+video',
  /CALL_DISCONNECT_ONCE/.test(voice) && /CALL_DISCONNECT_ONCE/.test(video));
record('10 terminal.disconnectSent guard',
  /disconnectSent/.test(voice) && /disconnectSent/.test(video));

// 11 missed on decline ZERO
record('11 decline skips missed (userDeclined / declined flag)',
  /options\.declined/.test(voice) && /!userDeclined/.test(voice));
record('11 declineIncoming sets userDeclinedCall',
  /userDeclinedCall = true/.test(voiceUi));

// 12 unanswered timeout missed exactly one
record('12 CALL_MISSED_ONCE + missedSent guard',
  /CALL_MISSED_ONCE/.test(voice) && /missedSent/.test(voice));

// 13 remote disconnect end once
record('13 CALL_END_ONCE voice+video',
  /CALL_END_ONCE/.test(voice) && /CALL_END_ONCE/.test(video));
record('13 terminal.ended guard',
  /term && term\.ended/.test(voice) && /term && term\.ended/.test(video));

// 14 decline while WhatsApp — MainActivity foreground ZERO
record('14 decline stays background warm',
  /Decline\/hangup with START_IN_BACKGROUND stay warm/.test(main)
  || /Decline\/hangup must stay BACKGROUND/.test(main));
record('14 DECLINE_CANCEL_KEEPFRONT',
  /DECLINE_CANCEL_KEEPFRONT/.test(main) && /cancelKeepFrontAfterDecline/.test(main));
record('14 pulseKeepCallInFront blocked on decline',
  /pendingCallAction == CALL_ACTION_DECLINE[\s\S]{0,120}?DECLINE_CANCEL_KEEPFRONT/.test(main)
  || /if \(pendingCallAction == CALL_ACTION_DECLINE\)/.test(main));

// 15 all sound stopped on decline
record('15 decline stops CallSoundHelper + stopCallSounds',
  /CallSoundHelper\.stopAll/.test(bridge) && /stopCallSounds/.test(voiceUi));

// 16 stale verifier idle shutdown
record('16 VERIFY_ONLY_IDLE_SHUTDOWN',
  /VERIFY_ONLY_IDLE_SHUTDOWN/.test(main) && /requestVerifyOnlyIdleShutdown/.test(e2ee));

// 17 no black foreground takeover after decline
record('17 decline moveTaskToBack immediate',
  /CALL_ACTION_DECLINE[\s\S]{0,200}?moveTaskToBack\(true\)/.test(main));

// 18 secure handled ACK bridge
record('18 ackSecureWrapHandled + requeueSecureWrap',
  /fun ackSecureWrapHandled/.test(bridge) && /ackSecureWrapHandledToNative/.test(e2ee));

// Policy / version
record('callSignalGiftWrapRequired true', appVer.callSignalGiftWrapRequired === true);
record('APK QA 1.0.120 / 121',
  /versionName\s*=\s*"1\.0\.120"/.test(gradle) && /versionCode\s*=\s*121/.test(gradle));
record('DEEPLINK_CALL_CONSUMED',
  /DEEPLINK_CALL_CONSUMED/.test(deeplink));

console.log(results.join('\n'));
console.log(`\nCALL_SESSION_TERMINAL_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
