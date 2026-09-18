#!/usr/bin/env node
/**
 * Durable outer-1059 replay/wake dedupe gate.
 * Run: node qa/call-secure-replay-dedupe-gate.mjs
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
const pending = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');
const handled = read('android-shell/app/src/main/java/com/sos010/app/SosSecureWrapHandledStore.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const e2ee = read('call-signal-e2ee.js');
const appVer = JSON.parse(read('app-version.json'));

// Case 1: new 1059 queues
record('1 new 1059 enqueue path',
  /SECURE_WAKE_NEW/.test(watcher) && /enqueueSecureWrap/.test(watcher));

// Case 2: pending dup
record('2 pending dup no re-wake',
  /SECURE_WAKE_PENDING_DUP/.test(watcher) && /containsSecureWrap/.test(watcher));

// Case 3+9+10+11: handled + replay → wake ZERO
record('3 handled replay drop',
  /SECURE_WAKE_REPLAY_DROP/.test(watcher) && /SosSecureWrapHandledStore\.isHandled/.test(watcher));
record('9/10/11 replay drop before enqueue',
  /isHandled[\s\S]{0,400}?SECURE_WAKE_REPLAY_DROP/.test(watcher)
  || /SECURE_WAKE_REPLAY_DROP[\s\S]{0,200}?return/.test(watcher));

// Case 4: durable store survives restart
record('4 durable SharedPreferences store',
  /sos_secure_wrap_handled/.test(handled) && /KEY_JSON/.test(handled));
record('4 store only id + at fields',
  /put\("id"/.test(handled) && /put\("at"/.test(handled)
  && !/\.put\("peer"|\.put\("sdp"|\.put\("media"|\.put\("caller"/.test(handled));

// Case 5: TTL / prune
record('5 TTL >= 72h', /TTL_MS\s*=\s*72L\s*\*\s*60L/.test(handled) || /72L \* 60L \* 60L \* 1000L/.test(handled));
record('5 max entries bounded', /MAX_ENTRIES\s*=\s*(512|768|1024)/.test(handled));
record('5 prune log', /SECURE_WAKE_HANDLED_STORE_PRUNE/.test(handled) || /SECURE_WAKE_HANDLED_STORE_PRUNE/.test(watcher));

// Case 6+7: pending recovery after restart
record('6 pending queue preserved MAX32 TTL120',
  /SECURE_QUEUE_MAX\s*=\s*32/.test(pending) && /TTL_MS\s*=\s*120_000L/.test(pending));
record('6 enqueue skips durable handled',
  /SosSecureWrapHandledStore\.isHandled/.test(pending));
record('7 recovery wake on startup',
  /SECURE_WAKE_RECOVERY_PENDING/.test(watcher) && /maybeRecoverPendingSecureWake/.test(watcher));
record('7 recovery requires pending > 0 and no host',
  /peekSecureWrapCount[\s\S]{0,300}?isHostAlive/.test(watcher)
  || /pending[\s\S]{0,200}?isHostAlive/.test(watcher));

// Case 8: no caller metadata in handled store
record('8 no caller metadata fields stored',
  /put\("id"/.test(handled) && /put\("at"/.test(handled)
  && !/\.put\("peer"|\.put\("caller"|\.put\("sdp"|\.put\("media"|\.put\("ciphertext"/.test(handled));

// Case 12: new legitimate still wakes
record('12 new legitimate still wakes verifier',
  /SECURE_WAKE_NEW/.test(watcher) && /launchSecureVerifierWakeIfNeeded|warmHostForSecureWrap/.test(watcher));

// ACK semantics
record('ackSecureWrapHandled bridge', /fun ackSecureWrapHandled/.test(bridge));
record('requeueSecureWrap on temporary fail', /fun requeueSecureWrap/.test(bridge));
record('JS acks after dispatched/duplicate/invalid_offer/unwrap',
  /ackSecureWrapHandledToNative/.test(e2ee) && /shouldRequeueSecureWrap/.test(e2ee));
record('JS does not mark handled on no_keys',
  /reason === 'no_keys'/.test(e2ee) && /shouldRequeueSecureWrap/.test(e2ee));
record('removeSecureWrap on ack', /fun removeSecureWrap/.test(pending));

// Policy freeze
record('callSignalGiftWrapRequired unchanged true', appVer.callSignalGiftWrapRequired === true);
record('lookback 2 days still present',
  /TWO_DAYS|2 \* 24 \* 60 \* 60|172800/.test(watcher) || /TWO_DAYS_SEC/.test(e2ee));

console.log(results.join('\n'));
console.log(`\nCALL_SECURE_REPLAY_DEDUPE_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
