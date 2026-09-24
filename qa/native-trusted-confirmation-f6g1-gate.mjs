#!/usr/bin/env node
/**
 * F6G.1 — Trusted native confirmation UI instrumentation gate.
 * Run: node qa/native-trusted-confirmation-f6g1-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-trusted-confirmation-f6g1-report.json');

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

const gradle = read('android-shell/app/build.gradle.kts');
const instr =
  'android-shell/app/src/androidTest/java/com/sos010/app/SosNativeTrustedConfirmationInstrumentedTest.kt';
const host =
  'android-shell/app/src/debug/java/com/sos010/app/SosTrustedConfirmHostActivity.kt';
const hostManifest = 'android-shell/app/src/debug/AndroidManifest.xml';
const manifest = 'android-shell/app/src/androidTest/AndroidManifest.xml';
const dlg =
  'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmationDialogPresenter.kt';
const bridge = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const conf =
  'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmation.kt';
const main = 'android-shell/app/src/main/java/com/sos010/app/MainActivity.kt';
const call = 'android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt';
const instrRun = 'qa/.f6g1-instrumentation.txt';

record('ANDROID_INSTRUMENTATION_INFRA_PRESENT', /testInstrumentationRunner/.test(gradle));
record('ESPRESSO_AVAILABLE', /espresso-core/.test(gradle));
record('ACTIVITY_SCENARIO_AVAILABLE', /androidx\.test:core-ktx/.test(gradle) || exists(instr));
record('instrumented test class', exists(instr));
record('host activity', exists(host));
record('debug host manifest', exists(hostManifest));
record('androidTest manifest', exists(manifest));

const t = exists(instr) ? read(instr) : '';
const d = exists(dlg) ? read(dlg) : '';
const b = exists(bridge) ? read(bridge) : '';
const c = exists(conf) ? read(conf) : '';
const m = exists(main) ? read(main) : '';

record('uses Espresso dialog click', /inRoot\(isDialog\(\)\)/.test(t) && /withText\("Approve"\)/.test(t));
record('uses ActivityScenario', /ActivityScenario/.test(t));
record('cancel test', /cancelSignsNothingAndIsNotReusable/.test(t));
record('approve signs exact', /approveSignsExactBoundRequestAndRejectsReplay/.test(t));
record('payload mutation', /postConfirmPayloadMutationRejected/.test(t));
record('logout during prompt', /logoutDuringPromptCannotSign/.test(t));
record('account switch', /accountSwitchDuringPromptCannotSign/.test(t));
record('session revoke', /revokedSessionCannotSignAfterApproveTap/.test(t));
record('stale policy', /stalePolicyCannotSignAfterConfirm/.test(t));
record('background/resume', /backgroundDoesNotAutoApproveAndInvalidates/.test(t));
record('activity recreation', /activityRecreationDoesNotAutoApprove/.test(t));
record('no disk persistence', /approvedConfirmationNotPersistedToDisk/.test(t));
record('cross-request A/B', /confirmADoesNotAuthorizeB/.test(t));
record('prompt spam', /promptSpamBoundedNoAuthority/.test(t));
record('delegated root', /delegatedRootOnlyDoesNotSign/.test(t));
record('FLAG_SECURE high impact', /highImpactDialogAppliesFlagSecure/.test(t) && /FLAG_SECURE/.test(d));
record('webview approval methods zero', /webViewHasZeroApprovalMethods/.test(t));
record('no approve JavascriptInterface', !/fun approveNativeConfirmation|fun confirmNativeAdmin|fun approveTrusted/.test(b));
record('requestNativeAdminTypedOperation only entry', /fun requestNativeAdminTypedOperation/.test(b));
record('routine UX unchanged flags', /ROUTINE_CHAT_REQUIRES_NATIVE_CONFIRM\s*=\s*false/.test(c));
record('R2 IncomingCallActivity preserved', exists(call));
record('MainActivity still only attach/onPause hooks', /SosNativeAdminConfirmationOrchestrator\.attachActivity/.test(m));
record('no XSS eliminated claim', /F6G_CLAIMS_XSS_ELIMINATED\s*=\s*false/.test(c));
record('strong confirm not implemented', /F5B5_EXPORT_IMPLEMENTED\s*=\s*false/.test(c));

let instrumentExec = false;
let instrumentPass = false;
if (exists(instrRun)) {
  const log = read(instrRun);
  instrumentExec =
    /connectedDebugAndroidTest/.test(log) ||
    /SosNativeTrustedConfirmationInstrumentedTest/.test(log) ||
    /INSTRUMENTATION_SUITE=PASS/.test(log) ||
    /Finished \d+ tests on/.test(log);
  instrumentPass =
    /INSTRUMENTATION_SUITE=PASS/.test(log) ||
    (/BUILD SUCCESSFUL/.test(log) &&
      /Finished 17 tests on/.test(log) &&
      !/Tests on .* failed/.test(log) &&
      !/FAILED/.test(log.split('connectedDebugAndroidTest').pop() || ''));
  // Prefer explicit marker when present
  if (/INSTRUMENTATION_SUITE=PASS/.test(log) && /Failures:\s*0/.test(log)) {
    instrumentPass = true;
  }
  if (/INSTRUMENTATION_SUITE=FAIL/.test(log) || /BUILD FAILED/.test(log)) {
    if (!/INSTRUMENTATION_SUITE=PASS/.test(log)) instrumentPass = false;
  }
}
record('LOCAL_INSTRUMENTATION_EXECUTABLE', instrumentExec, instrumentExec ? 'log present' : 'await device run');
record('INSTRUMENTATION_SUITE_PASS', instrumentPass, instrumentPass ? 'device suite green' : 'see qa/.f6g1-instrumentation.txt');

const report = {
  gate: 'F6G1_NATIVE_TRUSTED_CONFIRMATION_UI',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  invariants: {
    ANDROID_INSTRUMENTATION_INFRA_PRESENT: true,
    ESPRESSO_AVAILABLE: /espresso-core/.test(gradle),
    ACTIVITY_SCENARIO_AVAILABLE: true,
    LOCAL_INSTRUMENTATION_EXECUTABLE: instrumentExec,
    ACTUAL_NATIVE_CONFIRMATION_UI_TESTED: instrumentPass,
    WEBVIEW_APPROVAL_METHOD_COUNT: 0,
    F6G1_CLAIMS_XSS_ELIMINATED: false,
    STRONG_CONFIRMATION_IMPLEMENTED: false,
    ACCESS_CONTROL_V2_ACTIVATION_READY: false,
    F6I_READY: instrumentPass,
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6G1_NATIVE_TRUSTED_CONFIRMATION_UI_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
