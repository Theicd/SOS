#!/usr/bin/env node
/**
 * Secure wake notification delivery (APK 1.0.120 QA).
 * Run: node qa/secure-wake-notification-delivery-gate.mjs
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

const notify = read('android-shell/app/src/main/java/com/sos010/app/NotificationHelper.kt');
const wake = read('android-shell/app/src/main/java/com/sos010/app/SecureCallWakeActivity.kt');
const launch = read('android-shell/app/src/main/java/com/sos010/app/SecureVerifierLaunchService.kt');
const manifest = read('android-shell/app/src/main/AndroidManifest.xml');
const gradle = read('android-shell/app/build.gradle.kts');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const voiceUi = read('chat-voice-call-ui.js');
const videoUi = read('chat-video-call-ui.js');
const urls = read('android-shell/app/src/main/java/com/sos010/app/SosCallUrls.kt');
const appVer = JSON.parse(read('app-version.json'));
const apk = JSON.parse(read('apk-version.json'));

const channelBlock = notify.slice(notify.indexOf('CHANNEL_SECURE_WAKE_LEGACY'));
record('1 secure wake channel v2 exists',
  /CHANNEL_SECURE_WAKE = "sos_secure_call_wake_v2"/.test(notify)
  && /sos_secure_wake_v1/.test(notify)
  && !/deleteNotificationChannel\(\s*CHANNEL_SECURE_WAKE/.test(notify));
record('2 v2 importance HIGH',
  /CHANNEL_SECURE_WAKE,\s*\n\s*context\.getString\(R\.string\.channel_secure_wake\),\s*\n\s*NotificationManager\.IMPORTANCE_HIGH/.test(channelBlock)
  && /setBypassDnd\(true\)/.test(channelBlock)
  && /setSound\(null, null\)/.test(channelBlock)
  && /setShowBadge\(false\)/.test(channelBlock)
  && /enableVibration\(false\)/.test(channelBlock)
  && /VISIBILITY_SECRET/.test(channelBlock));
record('3 verifier notification uses v2',
  /NotificationCompat\.Builder\(app, CHANNEL_SECURE_WAKE\)/.test(notify)
  && /CATEGORY_CALL/.test(notify)
  && !/CATEGORY_ALARM/.test(notify));
record('4 FSI permission declared',
  /android\.permission\.USE_FULL_SCREEN_INTENT/.test(manifest));
record('5 canUseFullScreenIntent checked API34+',
  /SDK_INT < 34/.test(notify) && /canUseFullScreenIntent\(\)/.test(notify));
record('6 FALLBACK_SENT is not delivery success',
  /SECURE_VERIFIER_FALLBACK_SENT/.test(notify)
  && !/SECURE_VERIFIER_FALLBACK_OK/.test(notify)
  && /send\(\) returning is not delivery/.test(notify));
record('7 only Activity.onCreate sets ACTIVITY_STARTED',
  /override fun onCreate/.test(wake)
  && /noteActivityStarted\(\)/.test(wake)
  && (wake.match(/SECURE_VERIFIER_ACTIVITY_STARTED/g) || []).length === 2);
record('8 watchdog preserves pending wraps',
  /SECURE_VERIFIER_START_TIMEOUT/.test(notify)
  && /clearLaunchInFlight/.test(notify)
  && !/clearSecureWrap|deleteSecure|dropSecure/.test(notify.slice(notify.indexOf('scheduleVerifierDeliveryWatchdog'))));
record('9 max one bounded fallback',
  /markFallbackUsed/.test(wake)
  && /fallbackAlreadyUsed/.test(notify)
  && /compareAndSet\(false, true\)/.test(wake));
record('10 unverified 1059 ring ZERO',
  !/CallSoundHelper|showIncomingCall|startRingtone/.test(wake)
  && !/startRingtone|showIncomingCall/.test(launch));
record('11 verifier stays minimal asset',
  /file:\/\/\/android_asset\/secure-call-verifier\/index\.html/.test(urls)
  && /loadUrl\(SosCallUrls\.verifierAssetUrl\(\)\)/.test(wake));
record('12 videos.html verifier load ZERO',
  !/loadUrl\([^)]*videos\.html/.test(wake));
record('13 P2P unchanged',
  fs.existsSync(path.join(ROOT, 'chat-p2p-datachannel.js'))
  && !/chat-p2p|webtorrent|WebTorrent|PeerExchange/.test(diffNames()));
record('14 call encryption unchanged',
  appVer.callSignalGiftWrapRequired === true
  && appVer.minSecureChatEpoch === 2
  && appVer.e2eeSendRequired === true
  && appVer.mediaServerE2eeRequired === true
  && !/call-signal-e2ee\.js|chat-voice-call\.js|chat-video-call\.js/.test(diffNames()));
record('15 connected hangup decline ZERO',
  /DECLINE_IGNORED_AFTER_ANSWER/.test(bridge)
  && /markIncomingCallEnded/.test(bridge)
  && /markIncomingCallEnded/.test(voiceUi)
  && /shouldMarkDeclined/.test(videoUi));
record('creator BAL opt-in for system FSI',
  /setPendingIntentCreatorBackgroundActivityStartMode/.test(
    read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt')
  ));
record('entry logs do not invent origin',
  /SECURE_VERIFIER_ENTRY_FSI/.test(wake)
  && /SECURE_VERIFIER_ENTRY_CONTENT_TAP/.test(wake)
  && /SECURE_VERIFIER_ENTRY_UNKNOWN/.test(wake));
record('channel audit logs',
  /SECURE_WAKE_CHANNEL_EXISTS=/.test(notify)
  && /SECURE_WAKE_CHANNEL_IMPORTANCE=/.test(notify)
  && /SECURE_WAKE_CHANNEL_BLOCKED=/.test(notify)
  && /SECURE_WAKE_CHANNEL_BYPASS_DND=/.test(notify)
  && /SECURE_WAKE_CHANNEL_SOUND_PRESENT=/.test(notify));
record('device state logs before delivery',
  /SECURE_VERIFIER_DEVICE_API=/.test(notify)
  && /SECURE_VERIFIER_SCREEN_INTERACTIVE=/.test(notify)
  && /SECURE_VERIFIER_KEYGUARD_LOCKED=/.test(notify));
record('QA shell 1.0.120 / 121 / shell=120',
  /versionName\s*=\s*"1\.0\.120"/.test(gradle)
  && /versionCode\s*=\s*121/.test(gradle)
  && /shell=120/.test(gradle));
record('public apk-version is 1.0.120 / 121',
  apk.version === '1.0.120' && Number(apk.versionCode) === 121);
record('phoneCall service is screen-on delivery only',
  /foregroundServiceType="phoneCall"/.test(manifest)
  && /FOREGROUND_SERVICE_PHONE_CALL/.test(manifest)
  && /MANAGE_OWN_CALLS/.test(manifest)
  && /device\.interactive && !device\.keyguardLocked/.test(notify));

function diffNames() {
  try {
    return execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return '';
  }
}

console.log(results.join('\n'));
console.log(`\nSECURE_WAKE_NOTIFICATION_DELIVERY_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
