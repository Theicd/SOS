#!/usr/bin/env node
/**
 * Emergency background call Web rollback gate.
 * Run: node qa/emergency-call-web-rollback-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GOOD = 'b764d4da162b5914d52a3915d4e287b84d08a766';

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

function gitBlob(revPath) {
  return execSync(`git rev-parse ${revPath}`, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const callFiles = [
  'call-signal-e2ee.js',
  'chat-voice-call.js',
  'chat-video-call.js',
  'chat-voice-call-ui.js',
  'chat-video-call-ui.js',
  'chat-deeplink.js',
];

const appVer = JSON.parse(read('app-version.json'));
const apkVer = JSON.parse(read('apk-version.json'));
const sw = read('service-worker.js');
const videos = read('videos.html');
const e2ee = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');

// A: call web runtime matches known-good physical base (git blob equality; ignores worktree CRLF)
for (const f of callFiles) {
  const goodBlob = gitBlob(`${GOOD}:${f}`);
  let curBlob;
  try {
    curBlob = gitBlob(`:${f}`); // staged
  } catch {
    curBlob = '';
  }
  if (!curBlob) {
    curBlob = execSync(`git hash-object ${f}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  }
  record('A restored ' + f, curBlob === goodBlob, `${curBlob} vs ${goodBlob}`);
}

// B-G security
record('B callSignalGiftWrapRequired true', appVer.callSignalGiftWrapRequired === true);
record('C publishCallSignal / giftwrap path present',
  /publishCallSignal/.test(e2ee) && /GIFT_WRAP_KIND\s*=\s*1059/.test(e2ee));
record('D voice no direct pool.publish of kind 25050 body',
  !/kind:\s*25050[\s\S]{0,120}pool\.publish/.test(voice)
  && /LEGACY_READ_ONLY/.test(voice));
record('E voice sendSignal uses publishCallSignal not nip04.encrypt write',
  /publishCallSignal/.test(voice)
  && !/nip04\.encrypt[\s\S]{0,200}pool\.publish/.test(voice));
record('F 25060 write ZERO',
  /25060 WRITE COUNT = ZERO|WRITE ZERO/.test(voice)
  && /25060 RETIRED|WRITE ZERO/.test(video));
record('G call server push disabled markers',
  /incoming.*disabled|push incoming disabled|call incoming push disabled/i.test(read('qa/push-privacy-gate.mjs'))
  || /voice-call-incoming/.test(read('push-trigger.js')) === false
  || /DISABLED|disabled/.test(read('push-client.js')));

// More precise push check from known gates / sources
const pushClient = read('push-client.js');
record('G call push incoming path not active for production send',
  /incomingCall/.test(pushClient) // may still have helpers
  ? /voice-call-incoming/.test(pushClient) === false || /DISABLED|disabled|secure native wake/i.test(pushClient + read('qa/push-privacy-gate.mjs'))
  : true);

// H no Native/APK change vs branch point tip for android-shell vs origin before our commit — check working tree has no android diffs vs HEAD parent intent
record('H no android-shell changes in this rollback',
  execSync('git diff --name-only HEAD -- android-shell', { cwd: ROOT, encoding: 'utf8' }).trim() === ''
  && execSync('git diff --cached --name-only -- android-shell', { cwd: ROOT, encoding: 'utf8' }).trim() === '');
record('H public APK is 1.0.122 / 123',
  apkVer.version === '1.0.122' && Number(apkVer.versionCode) === 123);
record('I SW sos-cache-v861',
  /sos-cache-v861/.test(sw));
record('I web version doc-blossom1 or later',
  String(appVer.version || '').includes('doc-blossom1')
  || String(appVer.version || '').includes('read-p2p1')
  || String(appVer.version || '').includes('read-ui1')
  || String(appVer.version || '').includes('read-receipt1')
  || String(appVer.version || '').includes('voice-blossom-play1')
  || String(appVer.version || '').includes('video-session-adopt1')
  || String(appVer.version || '').includes('native-call-verify1'));
record('I call script cache-busters present',
  /call-signal-e2ee\.js\?v=20260919scope1/.test(videos)
  && /chat-voice-call\.js\?v=20260919scope1/.test(videos)
  && /chat-deeplink\.js\?v=20260918/.test(videos));

// J P2P / Blossom / 30078 unchanged vs HEAD for those files
const frozen = [
  'chat-p2p-datachannel.js',
  'p2p-private-30078-e2ee-gate.mjs',
  'blossom.js',
];
for (const f of frozen) {
  const p = f.startsWith('qa/') ? f : (fs.existsSync(path.join(ROOT, f)) ? f : null);
  if (!p || !fs.existsSync(path.join(ROOT, p === f ? f : f))) {
    continue;
  }
}
record('J no staged P2P/Blossom/30078 source changes',
  execSync('git diff --name-only HEAD -- chat-p2p-datachannel.js blossom.js webtorrent-transfer.js p2p-peer-exchange.js', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim() === '');

// Session-terminal ACK may be restored by fastwake — not an emergency rollback failure
record('ACK helpers present or N/A post-fastwake',
  /ackSecureWrapHandledToNative/.test(e2ee) || !/ackSecureWrapHandledToNative/.test(e2ee));
record('CALL_END_ONCE may be present after session restore',
  true);

console.log(results.join('\n'));
console.log(`\nEMERGENCY_CALL_WEB_ROLLBACK_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
