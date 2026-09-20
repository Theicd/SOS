#!/usr/bin/env node
/**
 * Ring fast-path + zombie-session + soft quorum gate.
 * Run: node qa/secure-call-ring-zombie-session-gate.mjs
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
const verifier = read('android-shell/app/src/main/java/com/sos010/app/SosNativeCallVerifier.kt');
const helper = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const voiceUi = read('chat-voice-call-ui.js');
const xplat = read('qa/secure-call-cross-platform-reliability-gate.mjs');

const verifyFn = (() => {
  const i = watcher.indexOf('private fun verifySecureWrapsNative');
  return i >= 0 ? watcher.slice(i, i + 1600) : '';
})();

// A Native rings while hostAlive
record('A Native fast-path processPending even when hostAlive',
  /CALL_NATIVE_OFFER_FASTPATH_START/.test(verifyFn)
  && /SosNativeCallVerifier\.processPending/.test(verifyFn)
  && !/if \(MainActivity\.isHostAlive\) \{[\s\S]{0,200}?return/.test(verifyFn.replace(/\/\/[^\n]*/g, '')));

// B one ring via session markRinged
record('B Native ring-once via markRinged',
  /markRinged/.test(verifier) && /CALL_NATIVE_OFFER_FASTPATH_RING/.test(verifier));

// C soft quorum ok>=1
record('C answer ok>=1 is transport success',
  /if \(ok <= 0\)/.test(helper)
  && /CALL_SIGNAL_TRANSPORT_FAILED/.test(helper)
  && !/requiredOk = critical \? Math\.min\(2/.test(helper)
  && /CALL_RELAY_DEGRADED action=/.test(helper));

// D all relays fail once → terminal no resurrection
record('D setup failure marks terminal + clears cache',
  /CALL_SETUP_FAILED_AFTER_ANSWER/.test(voice)
  && /markJsSessionTerminal|markCallSessionTerminal/.test(voice)
  && /clearSecureOfferCache/.test(voice));

// E stale apply blocked
record('E CALL_STALE_OFFER_APPLY_BLOCK before Applying remote offer',
  /CALL_STALE_OFFER_APPLY_BLOCK/.test(voice)
  && /isOfferApplyBlocked/.test(voice)
  && voice.indexOf('isOfferApplyBlocked') < voice.indexOf("console.log('Applying remote offer'"));

// F web recovery drops terminal
record('F Web recovery drops terminal offers',
  /CALL_WEB_RECOVERY_DROP reason=terminal-session/.test(helper)
  && /isCallSessionTerminal/.test(helper));

// G Native pending drop terminal
record('G Native pending drop terminal-session log',
  /CALL_NATIVE_PENDING_DROP reason=terminal-session/.test(helper));

// H autoAccept cancel
record('H autoAccept cancel on terminal',
  /CALL_AUTO_ACCEPT_CANCEL reason=terminal/.test(voiceUi)
  && /__sosAcceptCancelPeer/.test(voiceUi));

// I answered is not missed
record('I answered-locally skips missed call',
  /CALL_MISSED_SKIP reason=answered-locally/.test(voice)
  && /answeredLocally/.test(voice));

// J unanswered once
record('J missed-call already-recorded latch',
  /CALL_MISSED_SKIP reason=already-recorded/.test(voice)
  && /missedSent/.test(voice));

// K recovery/resubscribe ring-once remains
record('K ring-once session markers remain',
  /CALL_RING_AUTH_ONCE/.test(helper)
  && /nativeRingAuthOnce/.test(helper)
  && /markRinged/.test(verifier));

// L new session from same peer not blocked by peer-only cache clear
record('L cache clear is session-scoped + getCached rejects terminal',
  /function clearSecureOfferCache/.test(helper)
  && /isCallSessionTerminal\(sid\)/.test(helper)
  && /CALL_OFFER_CACHE_CLEAR/.test(helper));

record('getCachedSecureOffer rejects tombstoned session',
  /function getCachedSecureOffer[\s\S]{0,500}?isCallSessionTerminal/.test(helper));

record('hostAlive notify still present after fast-path',
  /notifySecurePendingAvailable/.test(verifyFn)
  && /CALL_NATIVE_HANDOFF_REV=2/.test(verifyFn));

record('video stale/terminal + missed skip',
  /CALL_STALE_OFFER_APPLY_BLOCK/.test(video)
  && /CALL_MISSED_SKIP reason=answered-locally/.test(video)
  && /CALL_SETUP_FAILED_AFTER_ANSWER/.test(video));

record('transport failure not labeled encrypt',
  /err\.code = 'CALL_SIGNAL_TRANSPORT_FAILED'/.test(helper)
  && helper.indexOf("callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'publish quorum failed") < 0);

record('cross-platform gate still present',
  /SECURE_CALL_CROSS_PLATFORM_RELIABILITY_GATE/.test(xplat));

console.log(results.join('\n'));
console.log(
  fail
    ? 'SECURE_CALL_RING_ZOMBIE_SESSION_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'SECURE_CALL_RING_ZOMBIE_SESSION_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
