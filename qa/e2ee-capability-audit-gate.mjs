#!/usr/bin/env node
/**
 * E3A audit gate — capability protocol decision + Native encrypted-1050 compatibility.
 * Does NOT implement advertise/send. Documents blockers for peer E2EE capability discovery.
 * Run: node qa/e2ee-capability-audit-gate.mjs
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

const svc = read('chat-service.js');
const e2ee = read('chat-e2ee.js');
const dual = read('qa/e2ee-dual-read-gate.mjs');
const profile = read('profile.js');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');

// No dedicated peer E2EE capability protocol in tree
record(
  'no dedicated peer E2EE capability module',
  !fs.existsSync(path.join(ROOT, 'chat-e2ee-capability.js')) &&
    !e2ee.includes('getPeerE2eeCapability') &&
    !svc.includes('getPeerE2eeCapability'),
);
record(
  'no sos_caps / sos-e2ee-chat-v1 published on wire yet',
  !profile.includes('sos_caps') &&
    !profile.includes('sos-e2ee-chat-v1') &&
    !svc.includes('sos-e2ee-chat-v1'),
);
record(
  'E2EE_CAPABILITY_V1 exists only as local constant (not published)',
  e2ee.includes('supportsE2EEChatV1') && e2ee.includes('not published'),
);
record(
  'video-compression-capability is local WebCodecs probe only',
  read('video-compression-capability.js').includes('probe') &&
    !read('video-compression-capability.js').includes('sos-e2ee'),
);

// Kind 0 is the only signed metadata surface commonly used
record(
  'kind 0 profile publish exists (candidate surface)',
  profile.includes('async function publishProfileMetadata') && profile.includes('kind: 0'),
);
record(
  'kind 0 is not yet used as E2EE capability transport',
  !profile.includes('sos_caps') && !profile.includes('sos-e2ee-chat-v1'),
);

// Live send still legacy
record('LIVE_E2EE_SEND=false', !svc.includes('encryptPrivateChatPayload'));
record('E2 dual-read still present', svc.includes('looksLikeIncomingE2eeContent') && svc.includes('decryptPrivateChatPayload'));
record('E2 dual-read gate present', dual.includes('signature-before-decrypt'));

// Native encrypted 1050 background: JSON content → generic preview (no plaintext leak of envelope internals as message body)
record(
  'Native notifyChat uses generic preview for JSON content',
  watcher.includes('raw.startsWith("{")') && watcher.includes('"הודעה / קובץ"'),
);
record(
  'Native notifyChat does not decrypt 1050 content',
  !watcher.includes('nip44') && !watcher.includes('decrypt') && watcher.includes('CHAT_KIND -> notifyChat'),
);
record(
  'Native opens remote Web chat URL after notify',
  watcher.includes('https://sos010.com/videos.html?chat='),
);
record(
  'MainActivity loads remote sos010.com Web (not APK-bundled chat JS as sole source)',
  main.includes('sos010.com') && main.includes('BuildConfig.SOS_START_URL'),
);

// Protocol decision required before wire advertise
record(
  'E3A wire advertise intentionally not implemented',
  !fs.existsSync(path.join(ROOT, 'chat-e2ee-capability.js')),
);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
console.log('\nE3A_DECISION: BLOCKED_BY_CAPABILITY_PROTOCOL_DECISION');
console.log('NATIVE_ENCRYPTED_1050_BACKGROUND: COMPATIBLE_GENERIC_NOTIFICATION');
console.log('IDENTITY_CAPABILITY_MODEL: MULTI_DEVICE_AMBIGUOUS (kind0/identity-scoped)');
process.exit(fail ? 1 : 0);
