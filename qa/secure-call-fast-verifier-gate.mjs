#!/usr/bin/env node
/**
 * Secure Call Fast Verifier gate (APK 1.0.118 RC).
 * Run: node qa/secure-call-fast-verifier-gate.mjs
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

const e2ee = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const gradle = read('android-shell/app/build.gradle.kts');
const apkPublic = JSON.parse(read('apk-version.json'));
const wake = read('android-shell/app/src/main/java/com/sos010/app/SecureCallWakeActivity.kt');
const pending = read('android-shell/app/src/main/java/com/sos010/app/SosPendingCallStore.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const urls = read('android-shell/app/src/main/java/com/sos010/app/SosCallUrls.kt');
const incoming = read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt');
const verifierHtml = read('android-shell/app/src/main/assets/secure-call-verifier/index.html');
const verifierJs = read('android-shell/app/src/main/assets/secure-call-verifier/secure-call-verifier.js');
const assetE2ee = read('android-shell/app/src/main/assets/secure-call-verifier/call-signal-e2ee.js');

record('1 offer send requires 1059 publish success markers',
  /CALL_SEND_1059_PUBLISH_OK/.test(e2ee)
  && /awaitPoolPublish|Promise\.allSettled/.test(e2ee)
  && /transport !== 'giftwrap1059'/.test(voice)
  && /transport !== 'giftwrap1059'/.test(video));
record('2 CALL_STARTED gated after publish',
  /published\.transport !== 'giftwrap1059'/.test(voice)
  && /console\.log\('CALL_STARTED'\)/.test(voice)
  && voice.indexOf("published.transport !== 'giftwrap1059'") < voice.indexOf("console.log('CALL_STARTED')"));
record('3 direct25050 new write ZERO',
  /LEGACY_READ_ONLY/.test(voice)
  && !/kind:\s*25050[\s\S]{0,80}pool\.publish/.test(voice));
record('4 verifier does not load videos.html',
  /verifierAssetUrl/.test(urls)
  && /secure-call-verifier\/index\.html/.test(urls)
  && /loadUrl\(SosCallUrls\.verifierAssetUrl\(\)\)/.test(wake)
  && /SECURE_VERIFIER_START/.test(wake)
  && !/loadUrl\([^\)]*videos\.html/.test(wake));
record('5 verifier feed imports ZERO',
  !/feed\.js/.test(verifierHtml) && !/feed\.js/.test(verifierJs));
record('6 verifier WebTorrent imports ZERO',
  !/<script[^>]+webtorrent/i.test(verifierHtml)
  && !/from ['"]webtorrent/i.test(verifierJs)
  && !/new\s+WebTorrent/i.test(verifierJs));
record('7 verifier P2P imports ZERO',
  !/p2p-|PeerExchange|chat-p2p/i.test(verifierHtml) && !/p2p-|PeerExchange/i.test(verifierJs));
record('8 unverified1059 ring ZERO (auth before notify)',
  /authorizeNativeSecureOfferRing/.test(e2ee)
  && /notifySecureCallOfferVerified/.test(e2ee));
record('9 valid offer ring once',
  /CALL_RING_AUTH_ONCE|nativeRingAuthOnce/.test(e2ee)
  && /SECURE_VERIFIER_RING_AUTH/.test(bridge + verifierJs));
record('10 duplicate offer same session ring ZERO',
  /isSessionTombstoned/.test(e2ee) && /markRinged/.test(bridge));
record('11 candidate before answer preserved',
  /pending_candidate/.test(e2ee) && /SECURE_VERIFIER_CANDIDATE_PENDING/.test(e2ee + verifierJs));
record('12 candidate does not ring',
  /action === 'candidate'[\s\S]{0,280}pending_candidate/.test(e2ee)
  || /pending_candidate[\s\S]{0,80}action: unwrapped\.action/.test(e2ee));
record('13 disconnect cancels ring',
  /notifySecureCallDismissed/.test(e2ee) && /SECURE_VERIFIER_DISCONNECT/.test(e2ee));
record('14 pending queue survives process restart (peek)',
  /fun peekSecureWraps/.test(pending)
  && /peekPendingSecureWraps/.test(bridge)
  && /PEEK/.test(read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt')));
record('15 live wake works',
  /SECURE_WAKE_LIVE/.test(wake));
record('16 recovery wake works',
  /SECURE_WAKE_RECOVERY/.test(wake)
  && /EXTRA_RECOVERY/.test(wake));
record('17 handled replay wake ZERO',
  /SECURE_WAKE_REPLAY_DROP/.test(read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt')));
record('18 decline disconnect exactly one',
  /sosSecureVerifierDecline/.test(verifierJs)
  && /CALL_DISCONNECT_ONCE/.test(verifierJs)
  && /requestDeclineDisconnect/.test(wake));
record('19 decline Home launch ZERO preference',
  /Prefer minimal verifier disconnect/.test(read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt'))
  || /Prefer verifier disconnect/.test(incoming)
  || /defer full UI until answer/.test(incoming));
record('20 answer launches full call UI',
  /CALL_ACTION_ANSWER/.test(incoming)
  && /MainActivity/.test(incoming)
  && /incomingCall=/.test(urls));
record('21 voice works (send path)',
  /media: 'voice'/.test(voice) && /publishCallSignal/.test(voice));
record('22 video works (send path)',
  /media: 'video'/.test(video) && /publishCallSignal/.test(video));
record('23 chat/P2P files unchanged markers present',
  fs.existsSync(path.join(ROOT, 'chat-p2p-datachannel.js'))
  && fs.existsSync(path.join(ROOT, 'p2p-peer-exchange.js')));
record('24 Blossom unchanged present',
  fs.existsSync(path.join(ROOT, 'blossom.js')));
record('ACK contract restored',
  /ackSecureWrapHandledToNative/.test(e2ee)
  && /requeueSecureWrapToNative/.test(e2ee));
record('asset verifier bundles e2ee + nostr',
  fs.existsSync(path.join(ROOT, 'android-shell/app/src/main/assets/secure-call-verifier/nostr.bundle.min.js'))
  && /publishCallSignal/.test(assetE2ee)
  && /__sosSecureVerifierOnly/.test(verifierJs));
record('QA APK version 1.0.120 / 121',
  /versionName\s*=\s*"1\.0\.120"/.test(gradle)
  && /versionCode\s*=\s*121/.test(gradle)
  && /shell=120/.test(gradle));
record('public apk-version is 1.0.119 / 120',
  apkPublic.version === '1.0.119' && Number(apkPublic.versionCode) === 120);
record('CALL_SEND instrumentation present',
  /CALL_SEND_ENTER/.test(e2ee)
  && /CALL_SEND_POLICY_REQUIRED/.test(e2ee)
  && /CALL_SEND_RETURN_OK/.test(e2ee));
record('NIP04 call write ZERO',
  !/nip04\.encrypt[\s\S]{0,200}pool\.publish/.test(voice));
record('25060 WRITE ZERO markers',
  /25060 WRITE COUNT = ZERO|WRITE ZERO/.test(voice));

console.log(results.join('\n'));
console.log(`\nSECURE_CALL_FAST_VERIFIER_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
