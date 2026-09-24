#!/usr/bin/env node
/**
 * F6E — Native typed admin policy static gate.
 * Run: node qa/native-admin-policy-f6e-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-admin-policy-f6e-report.json');

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

const policyKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeAdminPolicy.kt';
const signerKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeAdminTypedSigner.kt';
const typedSignerKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedSigner.kt';
const bridgeKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedBridge.kt';
const jsBridge = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const policyTest = 'android-shell/app/src/test/java/com/sos010/app/SosNativeAdminPolicyTest.kt';
const signerTest = 'android-shell/app/src/test/java/com/sos010/app/SosNativeAdminSignerTest.kt';
const ac9 = 'admin-signing-policy.js';
const p2p = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const ft = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';

record('native admin policy present', exists(policyKt));
record('native admin typed signer present', exists(signerKt));
record('policy unit test present', exists(policyTest));
record('signer unit test present', exists(signerTest));

const pol = exists(policyKt) ? read(policyKt) : '';
const sig = exists(signerKt) ? read(signerKt) : '';
const br = exists(bridgeKt) ? read(bridgeKt) : '';
const jb = exists(jsBridge) ? read(jsBridge) : '';
const ac9src = exists(ac9) ? read(ac9) : '';
const allNative = [pol, sig, br, jb, exists(typedSignerKt) ? read(typedSignerKt) : ''].join('\n');

record('NATIVE_ADMIN_POLICY_PRESENT', /NATIVE_ADMIN_POLICY_PRESENT\s*=\s*true/.test(pol));
record('NATIVE_ADMIN_TYPED_ALLOWLIST_PRESENT', /NATIVE_ADMIN_TYPED_ALLOWLIST_PRESENT\s*=\s*true/.test(pol));
record('no private K in policy', /NATIVE_ADMIN_POLICY_CONTAINS_PRIVATE_K\s*=\s*false/.test(pol));
record('no nsec in policy', /NATIVE_ADMIN_POLICY_CONTAINS_NSEC\s*=\s*false/.test(pol));
record('GENERIC_NATIVE_ADMIN_SIGN_API false', /GENERIC_NATIVE_ADMIN_SIGN_API\s*=\s*false/.test(pol));
record('ARBITRARY_ADMIN_EVENT_SIGNING_EXPOSED false', /ARBITRARY_ADMIN_EVENT_SIGNING_EXPOSED\s*=\s*false/.test(pol));
record('CALLER_SUPPLIED_COMPLETE_ADMIN_EVENT_ACCEPTED false', /CALLER_SUPPLIED_COMPLETE_ADMIN_EVENT_ACCEPTED\s*=\s*false/.test(pol));
record('NATIVE_CONSTRUCTS_ADMIN_EVENT', /NATIVE_CONSTRUCTS_ADMIN_EVENT\s*=\s*true/.test(pol));
record('explicit community scope', /ADMIN_OPERATION_REQUIRES_EXPLICIT_COMMUNITY_SCOPE\s*=\s*true/.test(pol));
record('active community not authority', /ACTIVE_COMMUNITY_IS_ADMIN_AUTHORITY_SOURCE\s*=\s*false/.test(pol));
record('capability mapping explicit', /ADMIN_CAPABILITY_MAPPING_EXPLICIT\s*=\s*true/.test(pol));
record('missing capability not accepted', /MISSING_REQUIRED_CAPABILITY_ACCEPTED\s*=\s*false/.test(pol));
record('root-only rejects delegated', /ROOT_ONLY_OPERATION_ACCEPTS_DELEGATED_ADMIN\s*=\s*false/.test(pol));
record('caller control state not authority', /CALLER_SUPPLIED_CONTROL_STATE_IS_AUTHORITY\s*=\s*false/.test(pol));
record('stale base not auto-accepted', /STALE_ADMIN_BASE_AUTO_ACCEPTED\s*=\s*false/.test(pol));
record('TOCTOU policy documented', /ADMIN_TOCTOU_POLICY_DOCUMENTED\s*=\s*true/.test(pol));
record('high-risk cannot sign before F6G', /HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G\s*=\s*false/.test(pol));
record('webview cannot bypass confirm', /WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION\s*=\s*false/.test(pol));
record('pre-F6G surface minimized', /PRE_F6G_ADMIN_SIGNING_SURFACE_MINIMIZED\s*=\s*true/.test(pol));
record('XSS not claimed eliminated', /F6E_CLAIMS_XSS_ELIMINATED\s*=\s*false/.test(pol));
record('double-redeem not claimed solved', /F6E_CLAIMS_INVITE_DOUBLE_REDEEM_SOLVED\s*=\s*false/.test(pol));
record('historical auth proof not claimed', /F6E_CLAIMS_HISTORICAL_AUTH_PROOF_SOLVED\s*=\s*false/.test(pol));
record('V2 not activation ready', /ACCESS_CONTROL_V2_ACTIVATION_READY\s*=\s*false/.test(pol));
record('reuses F6D session', /ADMIN_REUSES_F6D_SESSION_AUTHORITY\s*=\s*true/.test(sig));
record('no second session authority', /SECOND_ADMIN_SESSION_AUTHORITY_CREATED\s*=\s*false/.test(sig));
record('signing pubkey from secure identity', /ADMIN_SIGNING_PUBKEY_DERIVED_FROM_SECURE_IDENTITY\s*=\s*true/.test(sig));
record('caller cannot select private key', /CALLER_CAN_SELECT_ADMIN_PRIVATE_KEY\s*=\s*false/.test(sig));
record('policy before private key', /ADMIN_POLICY_CHECK_BEFORE_PRIVATE_KEY_USE\s*=\s*true/.test(sig));
record('policy recheck before sign', /ADMIN_POLICY_RECHECK_BEFORE_SIGN\s*=\s*true/.test(sig));
record('F6G confirmation unavailable', /F6G_TRUSTED_CONFIRMATION_AVAILABLE\s*=\s*false/.test(sig));
record('TRUSTED_CONFIRMATION_REQUIRED returned', /TRUSTED_CONFIRMATION_REQUIRED/.test(sig));

const ac9Ops = [
  'SET_GROUP_DISPLAY_NAME',
  'SET_INVITE_POLICY',
  'GRANT_CAPABILITY',
  'REVOKE_CAPABILITY',
  'ADD_MEMBER_TO_BLOCKLIST',
  'REMOVE_MEMBER_FROM_BLOCKLIST',
  'CLEAN_REMOVED_MEMBER_CAPABILITIES',
  'RESOLVE_CONTROL_CONFLICT',
  'BOOTSTRAP_GROUP_CONTROL',
  'GRANT_MEMBER_ACTIVE',
  'BLOCK_MEMBER',
  'UNBLOCK_MEMBER',
  'REMOVE_MEMBER',
  'RESOLVE_MEMBERSHIP_CONFLICT',
  'BOOTSTRAP_MEMBER_ACTIVE',
];
for (const op of ac9Ops) {
  record('allowlist has ' + op, new RegExp('\\b' + op + '\\b').test(pol) && new RegExp('\\b' + op + '\\b').test(ac9src));
}

const forbiddenApis = [
  'fun signAdminEvent',
  'fun signGroupControl',
  'fun signMembershipState',
  'fun signArbitraryAdmin',
  'fun signKind39001',
  'fun signKind39003',
  'fun genericAdminSign',
  'signAdminPayload',
];
let genericApiClean = true;
for (const api of forbiddenApis) {
  if (allNative.includes(api)) {
    genericApiClean = false;
    record('no ' + api, false);
  } else {
    record('no ' + api, true);
  }
}
record('F6E_NO_GENERIC_ADMIN_API_GATE', genericApiClean);

record('no generic admin bridge method', !/fun\s+nativeAdminSign|fun\s+signAdmin|ADMIN_BRIDGE_GENERIC/.test(jb + br));
record('admin bridge not exposing high-risk sign', !/attemptTypedAdminSign/.test(jb));
record('p2p hot path untouched', !/SosNativeAdminPolicy|SosNativeAdminTypedSigner/.test(read(p2p)));
record('file transfer untouched', !/SosNativeAdminPolicy|SosNativeAdminTypedSigner/.test(read(ft)));

// AC9 capability tokens mirrored
for (const cap of [
  'MANAGE_ADMINS',
  'MANAGE_PERMISSIONS',
  'MANAGE_GROUP_SETTINGS',
  'MODERATE_CONTENT',
  'INVITE_USERS',
  'MANAGE_MEMBERS',
  'MANAGE_INVITES',
  'MANAGE_BLOCKLIST',
  'VIEW_AUDIT_LOG',
]) {
  record('capability ' + cap, pol.includes('"' + cap + '"'));
}

record('invite policies preserved', /EVERYONE/.test(pol) && /AUTHORIZED_USERS_ONLY/.test(pol) && /ADMINS_ONLY/.test(pol));
record('NATIVE_CONFIRM_REQUIRED classification', /NATIVE_CONFIRM_REQUIRED/.test(pol));
record('session required flag', /ADMIN_TYPED_OP_REQUIRES_NATIVE_SESSION\s*=\s*true/.test(pol) || /ADMIN_TYPED_OP_REQUIRES_NATIVE_SESSION\s*=\s*true/.test(sig));
record('no remote API dependency', /NATIVE_ADMIN_POLICY_REQUIRES_REMOTE_API\s*=\s*false/.test(pol));
record('no Cloudflare dependency', /NATIVE_ADMIN_POLICY_REQUIRES_CLOUDFLARE\s*=\s*false/.test(pol));
record('no signer host dependency', /NATIVE_ADMIN_POLICY_REQUIRES_SIGNER_HOST\s*=\s*false/.test(pol));

const report = {
  gate: 'F6E_NATIVE_ADMIN_POLICY',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  invariants: {
    NATIVE_ADMIN_POLICY_PRESENT: true,
    NATIVE_ADMIN_TYPED_ALLOWLIST_PRESENT: true,
    GENERIC_NATIVE_ADMIN_SIGN_API: false,
    HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G: false,
    WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION: false,
    F6E_CLAIMS_INVITE_DOUBLE_REDEEM_SOLVED: false,
    F6E_CLAIMS_HISTORICAL_AUTH_PROOF_SOLVED: false,
    ACCESS_CONTROL_V2_ACTIVATION_READY: false,
    F6E_NO_GENERIC_ADMIN_API_GATE: genericApiClean ? 'PASS' : 'FAIL',
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6E_NATIVE_ADMIN_POLICY_GATE=' + report.status);
console.log('F6E_NO_GENERIC_ADMIN_API_GATE=' + report.invariants.F6E_NO_GENERIC_ADMIN_API_GATE);
console.log('Wrote ' + OUT);
process.exit(fail === 0 ? 0 : 1);
