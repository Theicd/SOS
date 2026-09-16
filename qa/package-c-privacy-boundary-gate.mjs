#!/usr/bin/env node
/**
 * Package C Stages 16–18 — log privacy + bridge/trust wiring checks.
 * Run: node qa/package-c-privacy-boundary-gate.mjs
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

const ab = read('android-bridge.js');
const nsb = read('native-shell-bridge.js');
const pt = read('push-trigger.js');
const pc = read('push-client.js');
const px = read('p2p-peer-exchange.js');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const fileKt = read('android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const logGate = read('qa/log-privacy-gate.mjs');

record('android-bridge mesh message log redacted', ab.includes("type: message && message.type") && !/console\.log\('📨 Message from:', fromIp, message\)/.test(ab));
record('android-bridge raw message logs length only', ab.includes('bytes: String(text || \'\')') && !/console\.log\('📝 Raw message from:', fromIp, text\)/.test(ab));
record('native-shell FCM register log redacted', nsb.includes("ok: !!data.ok") && !/FCM register:', data\)/.test(nsb));
record('push-trigger server response redacted', pt.includes('sent: data.sent') && !/תגובת שרת:', data\)/.test(pt));
record('push-client config warn redacted', pc.includes('status: response.status') && !/לא מוגדר כראוי:', data\)/.test(pc));
record('log-privacy gate includes android-bridge', logGate.includes("'android-bridge.js'"));
record('log-privacy gate includes push-trigger', logGate.includes("'push-trigger.js'"));
record('log-privacy gate includes native-shell-bridge', logGate.includes("'native-shell-bridge.js'"));

record('SosJsBridge notification openUrl https allowlist', bridge.includes('isSafeHttpsOpenUrl') && bridge.includes('sos010.com'));
record('SosJsBridge cacheContact requires hex pubkey', bridge.includes('normalizeHexPubkey(pubkey)') && bridge.includes('clampText(name, 120)'));
record('SosJsBridge offerJson size capped', bridge.includes('json.length > 65536'));
record('SosJsBridge saveToDownloads size capped', bridge.includes('error:too-large'));
record('SosJsBridge downloadUrl size capped', bridge.includes('50 * 1024 * 1024') || bridge.includes('50L * 1024L * 1024L'));
record('MainActivity host allowlist exact/suffix', main.includes('isAllowedAppHost') && main.includes('h == "sos010.com"'));
record('APK update host allowlist', main.includes('isAllowedApkUpdateHost') && main.includes('raw.githubusercontent.com'));
record('Native file-offer log no full filename', fileKt.includes('nameLen=${name.length}') && !/file-offer \$\{peer\.take\(8\)\} \$name /.test(fileKt));
record('RelayWatcher profile log no display name', watcher.includes('nameLen=${name.length}') && !/name=\$\{name\.take\(24\)\}/.test(watcher));
record('mesh originalSender hex-64 required', px.includes('bad_originalSender') && px.includes('/^[0-9a-f]{64}$/'));
record('mesh originalTarget hex-64 required', px.includes('bad_originalTarget'));

// Deferred Native crypto must remain documented as gap (no fake verifier required)
const cryptoPath = path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosNostrCrypto.kt');
record(
  'Native verifyEvent not falsely claimed present',
  !fs.existsSync(cryptoPath) || !read('android-shell/app/src/main/java/com/sos010/app/SosNostrCrypto.kt').includes('fun verifyEvent'),
);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
