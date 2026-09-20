#!/usr/bin/env node
/**
 * Cross-platform secure-call reliability (Android Native queue + Web Relay catch-up).
 * Static source-contract gate — no device runtime.
 * Run: node qa/secure-call-cross-platform-reliability-gate.mjs
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

const helper = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const voiceUi = read('chat-voice-call-ui.js');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const config = read('config.js');
const appJs = read('app.js');
const indexHtml = read('index.html');
const videosHtml = read('videos.html');
const appVer = JSON.parse(read('app-version.json'));

const nativeRelays = (watcher.match(/private val RELAYS = listOf\(([\s\S]*?)\)/) || [])[1] || '';
const canonical = (helper.match(/CANONICAL_CALL_RELAYS = \[([\s\S]*?)\]/) || [])[1] || '';

function hasRelay(blob, host) {
  return blob.indexOf(host) >= 0;
}

// A/B Android watchdog observable ticks
record('A Android watchdog recovers Native-only answer (PEEK path)',
  /CALL_NATIVE_PENDING_WATCHDOG_TICK/.test(helper)
  && /outgoing-await-answer/.test(helper)
  && /CALL_NATIVE_PENDING_PEEK reason=/.test(helper));
record('B Android dropped notify still recovered by watchdog',
  /CALL_NATIVE_PENDING_WATCHDOG_DEFER reason=in-flight/.test(helper)
  && /CALL_NATIVE_PENDING_WATCHDOG_ERROR reason=/.test(helper)
  && /startOutgoingAnswerDrainWatchdog/.test(helper));

// C/D Desktop web catch-up
record('C Desktop catch-up recovers missed answer',
  /function runWebSecureCallRecovery/.test(helper)
  && /CALL_WEB_RECOVERY_START/.test(helper)
  && /CALL_WEB_RECOVERY_QUERY/.test(helper)
  && /enqueueSecureDispatch/.test(helper)
  && /startWebSecureCallRecovery/.test(helper));
record('D Desktop duplicate live+catch-up one apply',
  /CALL_ANSWER_APPLY_SKIP reason=already-applied/.test(voice)
  && /rememberWrapId/.test(helper)
  && /status === 'duplicate'/.test(helper));

// E offer catch-up rings once
record('E catch-up fresh offer rings once only',
  /CALL_RING_AUTH_ONCE/.test(helper)
  && /nativeRingAuthOnce/.test(helper)
  && /authorizeNativeSecureOfferRing|unwrapped\.action === 'offer'/.test(helper));

// F/G NIP-59 outer vs inner freshness
record('F catch-up uses TWO_DAYS outer window',
  /TWO_DAYS_SEC/.test(helper)
  && /since: Math\.floor\(Date\.now\(\) \/ 1000\) - TWO_DAYS_SEC - 120/.test(helper)
  && /querySecureCallWrapsFromRelays/.test(helper));
record('G inner sentAt freshness remains authoritative',
  /FRESHNESS_SEC\[action\]/.test(helper)
  && /age > maxAge/.test(helper)
  && /payload\.sentAt/.test(helper));

// H/I/J publish quorum + auth-required
record('H auth-required one relay + quorum on others',
  /CALL_RELAY_AUTH_REQUIRED/.test(helper)
  && /CALL_RELAY_OK relay=/.test(helper)
  && /CALL_RELAY_FAIL relay=/.test(helper)
  && /requiredOk = critical \? Math\.min\(2/.test(helper));
record('I single eligible relay degraded mode',
  /CALL_RELAY_DEGRADED_SINGLE_RELAY/.test(helper));
record('J all relays fail → PUBLISH_FAIL not silent OK',
  /CALL_SEND_1059_PUBLISH_FAIL/.test(helper)
  && /publish quorum failed/.test(helper)
  && /CALL_RELAY_PUBLISH_RESULT/.test(helper));

// K subscription health / multi-relay continue
record('K subscribe uses call relays + health markers',
  /CALL_SECURE_SUBSCRIBE_START relays=/.test(helper)
  && /CALL_SECURE_SUBSCRIBE_EOSE/.test(helper)
  && /CALL_SECURE_SUBSCRIBE_RECONNECT/.test(helper)
  && /getCallSignalRelays\(\)/.test(helper));

// L/M voice + video
record('L voice uses getCallSignalRelays for publish',
  /getCallSignalRelays\(\)/.test(voice)
  && /startOutgoingAnswerDrainWatchdog/.test(voice));
record('M video uses getCallSignalRelays for publish',
  /getCallSignalRelays\(\)/.test(video)
  && /startOutgoingAnswerDrainWatchdog/.test(video));

// N prior Native handoff still present
record('N Native handoff markers remain',
  /notifySecurePendingAvailable/.test(read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt'))
  && /reconcilePendingSecureCallSignals/.test(helper)
  && /CALL_NATIVE_HANDOFF_REV/.test(helper));

// O bilateral CALL_CONNECTED
record('O bilateral CALL_CONNECTED preserved',
  /CALL_CONNECTED_DEFER reason=await-answer/.test(voice)
  && /CALL_CONNECTED_DEFER reason=await-answer/.test(video)
  && /CALL_ANSWER_APPLY_OK/.test(voice)
  && /CALL_ANSWER_APPLY_OK/.test(video));

// Relay overlap Android ↔ Web canonical
record('relay set: Web CANONICAL matches Android SosRelayWatcher',
  hasRelay(canonical, 'relay.snort.social')
  && hasRelay(canonical, 'nos.lol')
  && hasRelay(canonical, 'nostr-relay.xbytez.io')
  && hasRelay(canonical, 'nostr-02.uid.ovh')
  && hasRelay(nativeRelays, 'relay.snort.social')
  && hasRelay(nativeRelays, 'nos.lol')
  && hasRelay(nativeRelays, 'nostr-relay.xbytez.io')
  && hasRelay(nativeRelays, 'nostr-02.uid.ovh'));

record('call relays exclude session auth-required',
  /callRelayAuthExcluded/.test(helper)
  && /markCallRelayAuthRequired/.test(helper));

record('web recovery triggers: subscribe/visibility/outgoing',
  /runWebSecureCallRecovery\('subscribe-ready'\)/.test(helper)
  && /runWebSecureCallRecovery\('visibility'\)/.test(helper)
  && /startWebSecureCallRecovery/.test(helper)
  && /CALL_WEB_RECOVERY_TICK/.test(helper));

record('nostr-tools 2.7.2 loaded (no invented NIP-42)',
  /nostr-tools@2\.7\.2/.test(indexHtml) || /nostr-tools@2\.7\.2/.test(videosHtml));

record('NIP-42 not invented insecurely for calls',
  !/nip42Authenticate|fakeAuth|password.*relay/.test(helper)
  && /CALL_RELAY_AUTH_REQUIRED/.test(helper));

record('gift wrap policy unchanged',
  appVer.callSignalGiftWrapRequired === true);

record('config SAFE_DEFAULT overlaps call set',
  /wss:\/\/relay\.snort\.social/.test(config)
  && /wss:\/\/nos\.lol/.test(config)
  && /wss:\/\/nostr-relay\.xbytez\.io/.test(config)
  && /wss:\/\/nostr-02\.uid\.ovh/.test(config));

record('voice-ui resume triggers web recovery',
  /runWebSecureCallRecovery\('resume'\)/.test(voiceUi));

console.log(results.join('\n'));
console.log(
  fail
    ? 'SECURE_CALL_CROSS_PLATFORM_RELIABILITY_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'SECURE_CALL_CROSS_PLATFORM_RELIABILITY_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
