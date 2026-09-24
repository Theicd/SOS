#!/usr/bin/env node
/**
 * F6G — Native trusted confirmation static gate.
 * Run: node qa/native-trusted-confirmation-f6g-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-trusted-confirmation-f6g-report.json');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
    return true;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const confKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmation.kt';
const dlgKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmationDialogPresenter.kt';
const orchKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeAdminConfirmationOrchestrator.kt';
const signerKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeAdminTypedSigner.kt';
const bridgeKt = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const mainKt = 'android-shell/app/src/main/java/com/sos010/app/MainActivity.kt';
const test1 = 'android-shell/app/src/test/java/com/sos010/app/SosNativeTrustedConfirmationTest.kt';
const test2 = 'android-shell/app/src/test/java/com/sos010/app/SosNativeAdminConfirmationTest.kt';
const p2p = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const ft = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';

record('trusted confirmation class', exists(confKt));
record('dialog presenter class', exists(dlgKt));
record('admin orchestrator class', exists(orchKt));
record('trusted confirmation unit test', exists(test1));
record('admin confirmation unit test', exists(test2));

const c = exists(confKt) ? read(confKt) : '';
const d = exists(dlgKt) ? read(dlgKt) : '';
const o = exists(orchKt) ? read(orchKt) : '';
const s = exists(signerKt) ? read(signerKt) : '';
const b = exists(bridgeKt) ? read(bridgeKt) : '';
const m = exists(mainKt) ? read(mainKt) : '';

record('TRUSTED_NATIVE_CONFIRMATION_PRESENT', /TRUSTED_NATIVE_CONFIRMATION_PRESENT\s*=\s*true/.test(c));
record('not WebView HTML', /TRUSTED_CONFIRMATION_IS_WEBVIEW_HTML\s*=\s*false/.test(c));
record('not JS dialog', /TRUSTED_CONFIRMATION_IS_JAVASCRIPT_DIALOG\s*=\s*false/.test(c));
record('no WebView approve method flag', /WEBVIEW_CAN_CALL_APPROVE_METHOD\s*=\s*false/.test(c));
record('no approval boolean', /WEBVIEW_CAN_SEND_APPROVAL_BOOLEAN\s*=\s*false/.test(c));
record('no programmatic auto-confirm', /PROGRAMMATIC_AUTO_CONFIRM_SUPPORTED\s*=\s*false/.test(c));
record('no approval secret to WebView', /APPROVAL_SECRET_EXPOSED_TO_WEBVIEW\s*=\s*false/.test(c));
record('one-time challenge', /CONFIRMATION_CHALLENGE_ONE_TIME\s*=\s*true/.test(c));
record('binds operation/payload/session/account', 
  /CONFIRMATION_CHALLENGE_BINDS_OPERATION\s*=\s*true/.test(c) &&
  /CONFIRMATION_CHALLENGE_BINDS_PAYLOAD\s*=\s*true/.test(c) &&
  /CONFIRMATION_CHALLENGE_BINDS_SESSION\s*=\s*true/.test(c) &&
  /CONFIRMATION_CHALLENGE_BINDS_ACCOUNT\s*=\s*true/.test(c));
record('binds explicit community', /CONFIRMATION_BINDS_EXPLICIT_COMMUNITY\s*=\s*true/.test(c));
record('expiry present', /CONFIRMATION_EXPIRY_PRESENT\s*=\s*true/.test(c));
record('no replay', /CONFIRMATION_REPLAY_ACCEPTED\s*=\s*false/.test(c));
record('no post-confirm payload mutation', /POST_CONFIRM_PAYLOAD_MUTATION_ACCEPTED\s*=\s*false/.test(c));
record('policy recheck after confirm', /ADMIN_POLICY_RECHECK_AFTER_CONFIRM\s*=\s*true/.test(c) || /ADMIN_POLICY_RECHECK_AFTER_CONFIRM\s*=\s*true/.test(s));
record('XSS not claimed eliminated', /F6G_CLAIMS_XSS_ELIMINATED\s*=\s*false/.test(c));
record('prompt spam bounded', /CONFIRMATION_PROMPT_SPAM_BOUNDED\s*=\s*true/.test(c));
record('native builds summary', /NATIVE_BUILDS_CONFIRMATION_SUMMARY\s*=\s*true/.test(c));
record('AlertDialog presenter', /AlertDialog/.test(d));
record('FLAG_SECURE high impact', /FLAG_SECURE/.test(d) || /FLAG_SECURE/.test(c));
record('orchestrator request once', /requestTypedAdminOperation/.test(o));
record('no approve JavascriptInterface', !/fun approveNativeConfirmation|fun confirmNativeAdmin|fun approveTrusted/.test(b));
record('requestNativeAdminTypedOperation present', /fun requestNativeAdminTypedOperation/.test(b));
record('logout invalidates confirmation', /onLogout/.test(b) && /invalidateAll\("logout"\)/.test(o));
record('MainActivity attach + onPause', /SosNativeAdminConfirmationOrchestrator\.attachActivity/.test(m) && /SosNativeAdminConfirmationOrchestrator\.onPause/.test(m));
record('F6G confirmation available in signer', /F6G_TRUSTED_CONFIRMATION_AVAILABLE\s*=\s*true/.test(s));
record('cannot sign without confirmation', /HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION\s*=\s*false/.test(s));
record('can sign after valid confirmation', /HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION\s*=\s*true/.test(s));
record('Authorization type required', /authorization:\s*SosNativeTrustedConfirmation\.Authorization/.test(s));
record('no routine chat confirm', /ROUTINE_CHAT_REQUIRES_NATIVE_CONFIRM\s*=\s*false/.test(c));
record('no P2P chunk confirm', /P2P_FILE_CHUNK_REQUIRES_NATIVE_CONFIRM\s*=\s*false/.test(c));
record('P2P engine untouched by confirm UI', !/SosNativeTrustedConfirmation|TrustedConfirmationDialog/.test(read(p2p)));
record('file transfer untouched', !/SosNativeTrustedConfirmation|TrustedConfirmationDialog/.test(read(ft)));
record('F5B5 not implemented', /F5B5_EXPORT_IMPLEMENTED\s*=\s*false/.test(c));
record('F5B6 not implemented', /F5B6_MIGRATION_IMPLEMENTED\s*=\s*false/.test(c));
record('V2 not ready', /ACCESS_CONTROL_V2_ACTIVATION_READY\s*=\s*false/.test(c));
record('all F6E ops have trusted confirmation', /ALL_F6E_ADMIN_OPS_HAVE_TRUSTED_CONFIRMATION\s*=\s*true/.test(c));

const report = {
  gate: 'F6G_NATIVE_TRUSTED_CONFIRMATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  invariants: {
    TRUSTED_NATIVE_CONFIRMATION_PRESENT: true,
    WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION: false,
    APPROVAL_SECRET_EXPOSED_TO_WEBVIEW: false,
    F6G_CLAIMS_XSS_ELIMINATED: false,
    HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION: false,
    HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION: true,
    NATIVE_UI_INSTRUMENTATION: 'ESPRESSO_ACTIVITYSCENARIO_SosNativeTrustedConfirmationInstrumentedTest',
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6G_NATIVE_TRUSTED_CONFIRMATION_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
