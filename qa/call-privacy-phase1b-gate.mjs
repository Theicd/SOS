#!/usr/bin/env node
/**
 * Call Privacy Phase 1B — Native 1059 opaque wake + Push privacy.
 * Run: node qa/call-privacy-phase1b-gate.mjs
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
const store = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');
const push = read('push-trigger.js');
const voiceUi = read('chat-voice-call-ui.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const helper = read('call-signal-e2ee.js');
const p2p = read('p2p-video-sharing.js');

record('native GIFT_WRAP_KIND 1059', watcher.includes('GIFT_WRAP_KIND = 1059'));
record('native subscribes kind 1059', watcher.includes('JSONArray().put(GIFT_WRAP_KIND)'));
record('native legacy 25050 read retained', watcher.includes('CALL_KIND') && watcher.includes('LEGACY_READ_ONLY'));
record('native secure lookback ~2 days', watcher.includes('2L * 24L * 60L * 60L'));
record('native opaque wake handler', watcher.includes('handleSecureGiftWrap') && watcher.includes('SECURE_WAKE'));
const secureWakeFn = (() => {
  const a = watcher.indexOf('private fun handleSecureGiftWrap');
  const b = watcher.indexOf('private fun allowSecureWake');
  return a >= 0 && b > a ? watcher.slice(a, b) : '';
})();
record('native does NOT ring on unverified 1059', secureWakeFn.length > 0 && !secureWakeFn.includes('showIncomingCall'));
record('native warmHostForSecureWrap', main.includes('warmHostForSecureWrap') && main.includes('EXTRA_WARM_FOR_SECURE_WRAP'));
record('native injectSecureWrapProcessing', main.includes('injectSecureWrapProcessing') && main.includes('prepareSecureCallEventFromNative'));
record('bridge notifySecureCallOfferVerified', bridge.includes('notifySecureCallOfferVerified'));
record('bridge notifySecureCallDismissed', bridge.includes('notifySecureCallDismissed'));
record('pending store saveSecureWrap', store.includes('enqueueSecureWrap') || store.includes('saveSecureWrap'));
record('JS prepareSecureCallEventFromNative', voiceUi.includes('prepareSecureCallEventFromNative'));
record('JS hydrate prefers kind 1059 unwrap', voiceUi.includes('getCachedSecureOffer') || voiceUi.includes('dispatchGiftWrappedCallSignal') || voiceUi.includes('trySecureUnwrap'));
record('JS only offer notifies native ring', helper.includes('authorizeNativeSecureOfferRing') && helper.includes("status: 'invalid_offer'"));
record('offer path calls notifySecureCallOfferVerified', helper.includes('notifySecureCallOfferVerified'));
record('push incoming disabled', push.includes('CALL_PUSH_DISABLED'));
record('push missed disabled', push.includes('MISSED_CALL_PUSH_DISABLED'));
record('push no voice-call-incoming send', !/type:\s*isVideo\s*\?\s*'video-call-incoming'/.test(push));
record('push no caller name body', !/contactInfo\.name\} מתקשר/.test(push));
record('voice still gift-wrap send', voice.includes('publishCallSignal') || voice.includes('publishGiftWrappedCallSignal'));
record('video still gift-wrap send', video.includes('publishCallSignal') || video.includes('publishGiftWrappedCallSignal'));
record('25060 still retired voice', /async function publishCallMetric\(\)\s*\{\s*return;\s*\}/.test(voice));
record('25060 still retired video', /async function publishCallMetric\(\)\s*\{\s*return;\s*\}/.test(video));
record('helper gift wrap intact', helper.includes('1059') && helper.includes('sos-call-signal'));
record('P2P unchanged', p2p.includes('sos-p2p-signal'));
record('sub id no pubkey prefix', watcher.includes('"sos-bg-secure"') && !/sos-bg-\$\{pubkey\.take\(8\)\}/.test(watcher));
record('rate limit secure wakes', watcher.includes('allowSecureWake') && watcher.includes('secureWakeCount'));
record(
  'showIncomingCall not in handleSecureGiftWrap',
  secureWakeFn.length > 0 && !secureWakeFn.includes('NotificationHelper.showIncomingCall'),
);

console.log('call-privacy-phase1b gate');
for (const line of results) console.log(line);
console.log('TOTAL ' + pass + '/' + (pass + fail));
process.exit(fail > 0 ? 1 : 0);
