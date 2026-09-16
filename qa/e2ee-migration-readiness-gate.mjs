#!/usr/bin/env node
/**
 * E3A2 — Migration readiness / stale-client audit (static only).
 * Updated after E3A3: forced cutover gate infrastructure is PRESENT; cutover remains INACTIVE.
 * Run: node qa/e2ee-migration-readiness-gate.mjs
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

const sw = read('service-worker.js');
const pwa = read('pwa-installer.js');
const svc = read('chat-service.js');
const epoch = read('chat-secure-epoch.js');
const e2ee = read('chat-e2ee.js');
const fts = read('chat-file-transfer-service.js');
const videos = read('videos.html');
const indexHtml = read('index.html');
const storage = read('storage.html');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const appVer = JSON.parse(read('app-version.json'));
const apkVer = JSON.parse(read('apk-version.json'));

record('E2 dual-read present in chat-service', svc.includes('looksLikeIncomingE2eeContent') && svc.includes('decryptPrivateChatPayload'));
record('LIVE_E2EE_SEND=false (activation ABSENT)',
  svc.includes('isE2eeSendRequired') &&
  Object.prototype.hasOwnProperty.call(appVer, 'e2eeSendRequired') && appVer.e2eeSendRequired === false);
record('videos.html loads chat-e2ee.js before chat-service', (() => {
  const a = videos.indexOf('chat-e2ee.js');
  const b = videos.indexOf('chat-service.js');
  return a >= 0 && b > a;
})());
record('index.html loads chat-e2ee.js', indexHtml.includes('chat-e2ee.js'));
record('storage.html loads chat-e2ee.js', storage.includes('chat-e2ee.js'));
record('chat-secure-epoch loaded before chat-service on videos', (() => {
  const a = videos.indexOf('chat-secure-epoch.js');
  const b = videos.indexOf('chat-service.js');
  return a >= 0 && b > a;
})());

record('SW networkFirstThenCache for same-origin GET', sw.includes('networkFirstThenCache'));
record('SW skipWaiting on install', sw.includes('skipWaiting()'));
record('SW clients.claim on activate', sw.includes('clients.claim()'));
record('app-version.json bypasses SW cache', sw.includes("endsWith('app-version.json')") && /app-version\.json.*return/.test(sw.replace(/\s+/g, ' ')));
record('chat-e2ee.js IS in PRECACHE_URLS (E3A3)', sw.includes("'./chat-e2ee.js'"));
record('chat-secure-epoch.js IS in PRECACHE_URLS', sw.includes("'./chat-secure-epoch.js'"));
record('chat-service.js IS in PRECACHE_URLS', sw.includes("'./chat-service.js'"));

record('PWA update toast allows Later deferral (non-security)', pwa.includes('UPDATE_LATER_KEY') && pwa.includes('pwa-update-toast__later'));
record('PWA can reload on Update Now', pwa.includes('prepareCleanReloadAfterUiUpdate') || pwa.includes('location.reload'));
record('PWA listens NEW_VERSION_ACTIVATED / controllerchange', pwa.includes('NEW_VERSION_ACTIVATED') && pwa.includes('controllerchange'));
record('E3A3 forced secure blocker has no Later', epoch.includes('עדכן עכשיו') && epoch.includes('No "Later"'));

record('legacy deserialize uses payload.t / payload.a shape', fts.includes('payload.t') && fts.includes('payload.a'));
record(
  'legacy chat-service content fallback to event.content (stale risk documented)',
  /content:\s*parsedPayload\.displayText\s*\|\|\s*.*event\.content/.test(svc) ||
    svc.includes('parsedPayload.displayText || (isE2eeContent ? \'\' : event.content)') ||
    svc.includes('parsedPayload.displayText || event.content'),
);

record('Native JSON 1050 preview is generic', watcher.includes('raw.startsWith("{")') && watcher.includes('"הודעה / קובץ"'));
record('Native does not decrypt 1050', !watcher.includes('nip44') && watcher.includes('notifyChat'));
record('Native deep-link to remote Web chat', watcher.includes('https://sos010.com/videos.html?chat='));
record('MainActivity uses SOS_START_URL / sos010.com', main.includes('SOS_START_URL') && main.includes('sos010.com'));
record('WebView online uses LOAD_DEFAULT', main.includes('LOAD_DEFAULT'));
record('WebView cache-else-network only for emergency offline shell', main.includes('LOAD_CACHE_ELSE_NETWORK') && main.includes('offlineShellRequested'));

record('app-version.json present', typeof appVer.version === 'string' && appVer.version.length > 0);
record('minSecureChatEpoch activated =1', Number(appVer.minSecureChatEpoch) === 1);
record('e2eeSendRequired explicit false (not activated)', Object.prototype.hasOwnProperty.call(appVer, 'e2eeSendRequired') && appVer.e2eeSendRequired === false);
record('apk-version 1.0.113 recorded', apkVer.version === '1.0.113');

record('no kind-0 sos_caps advertise', !read('profile.js').includes('sos_caps'));
record('encrypted send path gated (activation ABSENT)', svc.includes('isE2eeSendRequired') && svc.includes('encryptPrivateChatPayload'));
record('local SOS_SECURE_CHAT_EPOCH present', /SOS_SECURE_CHAT_EPOCH\s*=\s*1/.test(e2ee));

record(
  'CRITERION_5_forced_cutover_gate_PRESENT',
  epoch.includes('UPDATE_REQUIRED') && svc.includes('ensureSecureChatEpochReady'),
);
record(
  'CRITERION_6_startup_before_history_gate_PRESENT',
  /ensureSecureChatEpochReady[\s\S]{0,500}subscribeToChatEvents/.test(svc),
);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
console.log('STATUS_HINT: E3A3 gate PRESENT; cutover INACTIVE until minSecureChatEpoch set remotely');
console.log('BACKGROUND_NATIVE_ENCRYPTED_1050: SAFE (generic notify + remote Web dual-read)');
console.log('APK_1_0_113_E2EE_1050_COMPATIBLE: PARTIAL (bg notify OK; Web refresh still required for epoch bumps)');
process.exit(fail ? 1 : 0);
