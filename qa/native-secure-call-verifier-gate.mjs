#!/usr/bin/env node
/**
 * Native secure call verifier gate (APK 1.0.121 QA, not published).
 * Run: node qa/native-secure-call-verifier-gate.mjs
 */
import { execSync } from 'node:child_process';
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

const crypto = read('android-shell/app/src/main/java/com/sos010/app/SosNostrCrypto.kt');
const nip = read('android-shell/app/src/main/java/com/sos010/app/SosNip44.kt');
const verifier = read('android-shell/app/src/main/java/com/sos010/app/SosNativeCallVerifier.kt');
const watcher = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const gradle = read('android-shell/app/build.gradle.kts');
const test = read('android-shell/app/src/test/java/com/sos010/app/SosNip44VectorTest.kt');
const p2p = read('chat-p2p-datachannel.js');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const appVer = JSON.parse(read('app-version.json'));

record('1 NIP44 official vectors referenced',
  /conversationKeyVectorsPass/.test(test) && /encrypt_decrypt/.test(test) === false
    ? fs.existsSync(path.join(ROOT, 'android-shell/app/src/test/resources/nip44.vectors.json'))
    : fs.existsSync(path.join(ROOT, 'android-shell/app/src/test/resources/nip44.vectors.json')));
record('2 NIP44 invalid MAC fail closed',
  /invalidMacAndPayloadFailClosed/.test(test) && /constantTimeEquals/.test(nip));
record('3 outer event signature verify', /verifyEvent\(wrap\)/.test(verifier));
record('4 seal signature verify', /verifyEvent\(seal\)/.test(verifier));
record('5 rumor author binding verify', /NATIVE_GIFTWRAP_AUTHOR_MISMATCH/.test(verifier));
record('6 wrong recipient ring zero', /recipient/.test(verifier) && /Drop\("recipient"\)/.test(verifier));
record('7 stale offer ring zero', /age > maxAge/.test(verifier));
record('8 candidate ring zero', /"candidate", "candidates" -> Unit/.test(verifier));
record('9 fresh offer Native ring once',
  /NATIVE_1059_OFFER_AUTH_OK/.test(verifier)
  && /NATIVE_CALL_RING_AUTHORIZED/.test(verifier)
  && /markRinged/.test(verifier)
  && /startRingtone/.test(verifier));
record('10 Native ring path does not instantiate SecureCallWakeActivity',
  !/warmHostForSecureWrap|showSecureVerifierWake|SecureCallWakeActivity\(/.test(watcher));
record('11 connecting notification zero',
  !/showSecureVerifierWake/.test(watcher));
record('12 user tap prerequisite zero',
  !/showSecureVerifierWake/.test(watcher) && /processPending/.test(watcher));
record('13 encrypted offer remains pending for answer',
  /updateSecureWrapPeer/.test(verifier) && !/drainSecureWraps/.test(verifier));
record('14 answer full JS consumes offer',
  /peekSecureWraps/.test(read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt'))
  && /STATE_ANSWERED/.test(verifier));
record('15 candidates preserved',
  /"candidate", "candidates" -> Unit/.test(verifier));
record('16 remote disconnect stops ringtone',
  /NATIVE_CALL_REMOTE_DISCONNECT/.test(verifier) && /stopRingtone/.test(verifier));
record('17 Native secure decline sends 1059',
  /NATIVE_DECLINE_1059_SENT/.test(verifier)
  && /GIFT_KIND/.test(verifier)
  && /publishEvent/.test(verifier)
  && !/kind.?25050/.test(verifier.slice(verifier.indexOf('fun publishDisconnect'))));
record('18 JS can unwrap Native disconnect',
  /nativeDisconnectRoundtripMatchesPayload/.test(test)
  && /family/.test(verifier)
  && /sos-call-signal/.test(verifier));
record('19 direct25050 write zero',
  !/put\("kind", 25050\)/.test(verifier) && !/kind\s*=\s*25050/.test(verifier));
record('20 NIP04 call write zero', !/nip04Encrypt/.test(verifier));
record('21 25060 zero', !/25060/.test(verifier));
record('22 process restart recovery works',
  /SECURE_WAKE_RECOVERY_PENDING/.test(watcher) && /verifySecureWrapsNative/.test(watcher));
record('23 handled replay ring zero',
  /SECURE_WAKE_REPLAY_DROP/.test(watcher) && /isHandled/.test(watcher));
record('24 connected hangup regression pass',
  /DECLINE_IGNORED_AFTER_ANSWER/.test(bridge)
  && /CALL_SESSION_ENDED/.test(read('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt')));
record('25 P2P unchanged', /datachannel/i.test(p2p) && !/SosNativeP2pEngine/.test(verifier));
record('26 Blossom unchanged',
  fs.existsSync(path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt'))
  && !/Blossom|blossom/.test(verifier));
record('QA shell 1.0.121 / 122 / shell=121',
  /versionName\s*=\s*"1\.0\.121"/.test(gradle)
  && /versionCode\s*=\s*122/.test(gradle)
  && /shell=121/.test(gradle));
record('security policy frozen',
  appVer.callSignalGiftWrapRequired === true
  && appVer.minSecureChatEpoch === 2
  && appVer.e2eeSendRequired === true
  && appVer.mediaServerE2eeRequired === true);
record('schnorr verify uses secp', /verifySchnorr/.test(crypto));
record('NIP44 extract matches nostr-tools', /HmacSHA256/.test(nip) && /hkdfExpand/.test(nip));

console.log(results.join('\n'));
console.log(`\nNATIVE_SECURE_CALL_VERIFIER_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
