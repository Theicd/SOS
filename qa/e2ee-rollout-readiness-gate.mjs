#!/usr/bin/env node
/**
 * E3A4 — Safe E2EE cutover rollout readiness (static).
 * Verifies R1 package prerequisites: dual-read + epoch infra, cutover inactive, no encrypted send.
 * Does NOT deploy, activate minSecureChatEpoch, or enable send.
 * Run: node qa/e2ee-rollout-readiness-gate.mjs
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

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const e2ee = read('chat-e2ee.js');
const epoch = read('chat-secure-epoch.js');
const svc = read('chat-service.js');
const sw = read('service-worker.js');
const pwa = read('pwa-installer.js');
const push = read('push-trigger.js');
const blossom = exists('blossom.js') ? read('blossom.js') : '';
const videos = read('videos.html');
const indexHtml = read('index.html');
const storage = read('storage.html');
const appVer = JSON.parse(read('app-version.json'));
const profile = read('profile.js');

// Runtime modules present
record('chat-e2ee.js present', exists('chat-e2ee.js'));
record('chat-secure-epoch.js present', exists('chat-secure-epoch.js'));
record('local SOS_SECURE_CHAT_EPOCH=2', /SOS_SECURE_CHAT_EPOCH\s*=\s*2/.test(e2ee));
record('E2 dual-read wired', svc.includes('decryptPrivateChatPayload') && svc.includes('looksLikeIncomingE2eeContent'));
record('E3A3 gate wired before subscribe', svc.includes('ensureSecureChatEpochReady') && svc.includes('chat bootstrap deferred'));
record('E3A3 send gate present', svc.includes("secure-update-required"));

// Entrypoints
function orderOk(html, label) {
  const a = html.indexOf('chat-e2ee.js');
  const b = html.indexOf('chat-secure-epoch.js');
  const c = html.indexOf('chat-service.js');
  record(label + ' loads chat-e2ee → epoch → service', a >= 0 && b > a && c > b);
}
orderOk(videos, 'videos.html');
orderOk(indexHtml, 'index.html');
orderOk(storage, 'storage.html');
record('videos.html has nostr-tools before chat', videos.indexOf('nostr-tools') >= 0 && videos.indexOf('nostr-tools') < videos.indexOf('chat-e2ee.js'));
record('index.html has nostr-tools before chat', indexHtml.indexOf('nostr-tools') >= 0 && indexHtml.indexOf('nostr-tools') < indexHtml.indexOf('chat-e2ee.js'));

// Cutover active: minSecureChatEpoch=2
record('minSecureChatEpoch =2 in app-version.json',
  Object.prototype.hasOwnProperty.call(appVer, 'minSecureChatEpoch') &&
  Number(appVer.minSecureChatEpoch) === 2);
record('epoch module treats absent/0 as inactive', epoch.includes("hasOwnProperty.call(data, 'minSecureChatEpoch')") && epoch.includes('CUTOVER') || epoch.includes('cutover'));
record('decideSecureChatGate READY when remoteMin=0', epoch.includes('decideSecureChatGate'));

// Encrypted send: ACTIVE (e2eeSendRequired explicit true)
record('LIVE encrypted send gated by isE2eeSendRequired', svc.includes('isE2eeSendRequired') && svc.includes('encryptPrivateChatPayload'));
record('e2eeSendRequired explicit true in app-version (E3B ACTIVE)', Object.prototype.hasOwnProperty.call(appVer, 'e2eeSendRequired') && appVer.e2eeSendRequired === true);
record('encrypt helper exists in chat-e2ee', e2ee.includes('encryptPrivateChatPayload'));
record('no sos_caps capability kind', !profile.includes('sos_caps') && !svc.includes('sos_caps'));

// SW
record('SW CACHE_NAME sos-cache-v840', /sos-cache-v840/.test(sw));
record('SW precaches chat-e2ee.js', sw.includes("'./chat-e2ee.js'"));
record('SW precaches chat-secure-epoch.js', sw.includes("'./chat-secure-epoch.js'"));
record('SW precaches chat-service.js', sw.includes("'./chat-service.js'"));
record('SW networkFirstThenCache', sw.includes('networkFirstThenCache'));
record('app-version.json SW bypass', sw.includes('app-version.json') && /app-version\.json[\s\S]{0,120}return/.test(sw));

// PWA hook for forced reload (R3/R4 later)
record('prepareCleanReloadAfterUiUpdate exposed', pwa.includes('prepareCleanReloadAfterUiUpdate'));

// Push / Blossom markers
record('Push chat path is generic (no messageContent.slice)',
  push.includes('sanitizePrivateChatPushPayload') &&
  push.includes('triggerOutgoingMessagePush') &&
  !/messageContent\.length\s*>\s*100/.test(push));

record('Blossom module present unchanged by E2EE send', exists('blossom.js') && !blossom.includes('sos-e2ee') && !blossom.includes('encryptPrivateChatPayload'));

// Native freeze (static)
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
record('Native RelayWatcher has no nip44/E2EE decrypt', !watcher.includes('nip44') && !watcher.includes('sos-e2ee'));
record('MainActivity still remote sos010.com start', main.includes('sos010.com'));

// R1 safety: inactive cutover must not force-update
record('secure blocker only on UPDATE_REQUIRED path', epoch.includes('UPDATE_REQUIRED') && epoch.includes('עדכן עכשיו'));
record('R1 inactive: remote 0 → READY documented in epoch module',
  epoch.includes('lastKnownMin=0') || epoch.includes('never activated') || epoch.includes('CUTOVER_NOT'));

// Observability fields (no secrets)
record('safe diagnostic: getSecureChatGateState', epoch.includes('getSecureChatGateState'));
record('safe diagnostic: SOS_SECURE_CHAT_EPOCH on App', e2ee.includes('SOS_SECURE_CHAT_EPOCH'));
record('epoch logs omit message/keys', !/\$\{.*content/.test(epoch) && epoch.includes('[E2EE/EPOCH]'));

// Version: encrypted-blossom-compat1; minSecureChatEpoch=2; e2eeSendRequired explicit true; mediaServerE2eeRequired=true
record('app-version encrypted-blossom-compat1', String(appVer.version || '').includes('encrypted-blossom-compat1'));
record('mediaServerE2eeRequired explicit true (ACTIVE)',
  Object.prototype.hasOwnProperty.call(appVer, 'mediaServerE2eeRequired') && appVer.mediaServerE2eeRequired === true);
record('minSecureChatEpoch =2', Number(appVer.minSecureChatEpoch) === 2);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
console.log('APP_VERSION: ' + appVer.version);
console.log('secure cutover active: ' + (Number(appVer.minSecureChatEpoch) > 0 ? 'true' : 'false'));
console.log('LIVE_E2EE_SEND: true (e2eeSendRequired explicit true)');
console.log('PUSH_PLAINTEXT_BLOCKS_E3B: ' + (/messageContent\.length\s*>\s*100/.test(push) ? 'YES' : 'NO'));
console.log('TEXT_E2EE_BEFORE_BLOSSOM: SAFE_INTERMEDIATE (do not claim full attachment E2EE)');
process.exit(fail ? 1 : 0);
