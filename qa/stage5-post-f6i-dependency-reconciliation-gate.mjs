#!/usr/bin/env node
/**
 * Stage5 post-F6I dependency reconciliation (audit / decision only).
 * Run: node qa/stage5-post-f6i-dependency-reconciliation-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'qa', 'stage5-post-f6i-dependency-reconciliation-report.json');
const SIGNER = path.resolve(ROOT, '..', 'SOS-signer');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}
function exists(p) {
  return fs.existsSync(p);
}

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail += 1;
    results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

const report = JSON.parse(read(REPORT));
const protocol = exists(path.join(SIGNER, 'protocol.json'))
  ? JSON.parse(read(path.join(SIGNER, 'protocol.json')))
  : {};
const f5b4 = exists(path.join(SIGNER, 'qa', 'f5b4-report.json'))
  ? JSON.parse(read(path.join(SIGNER, 'qa', 'f5b4-report.json')))
  : {};
const deploy = exists(path.join(SIGNER, 'docs', 'PRODUCTION_DEPLOY.md'))
  ? read(path.join(SIGNER, 'docs', 'PRODUCTION_DEPLOY.md'))
  : '';
const f6design = exists(path.join(ROOT, 'docs', 'security', 'F6_ANDROID_NATIVE_TYPED_SIGNER_DESIGN.md'))
  ? read(path.join(ROOT, 'docs', 'security', 'F6_ANDROID_NATIVE_TYPED_SIGNER_DESIGN.md'))
  : '';
const launcher = exists(path.join(ROOT, 'isolated-signer-trusted-import.js'))
  ? read(path.join(ROOT, 'isolated-signer-trusted-import.js'))
  : '';
const blossom = exists(path.join(ROOT, 'qa', 'blossom-source-ip-privacy-report.json'))
  ? JSON.parse(read(path.join(ROOT, 'qa', 'blossom-source-ip-privacy-report.json')))
  : {};
const ac10 = exists(path.join(ROOT, 'qa', 'ac10-adversarial-authorization-report.json'))
  ? JSON.parse(read(path.join(ROOT, 'qa', 'ac10-adversarial-authorization-report.json')))
  : {};
const f6i = exists(path.join(ROOT, 'qa', 'native-f6i-adversarial-acceptance-report.json'))
  ? JSON.parse(read(path.join(ROOT, 'qa', 'native-f6i-adversarial-acceptance-report.json')))
  : {};
const confirm = exists(path.join(ROOT, 'android-shell', 'app', 'src', 'main', 'java', 'com', 'sos010', 'app', 'SosNativeTrustedConfirmation.kt'))
  ? read(path.join(ROOT, 'android-shell', 'app', 'src', 'main', 'java', 'com', 'sos010', 'app', 'SosNativeTrustedConfirmation.kt'))
  : '';
const bridge = exists(path.join(ROOT, 'android-shell', 'app', 'src', 'main', 'java', 'com', 'sos010', 'app', 'SosJsBridge.kt'))
  ? read(path.join(ROOT, 'android-shell', 'app', 'src', 'main', 'java', 'com', 'sos010', 'app', 'SosJsBridge.kt'))
  : '';

record('reconciliation report present', report.gate === 'STAGE5_POST_F6I_DEPENDENCY_RECONCILIATION');
record('contradiction marked resolved', report.contradiction?.CONTRADICTION_RESOLVED === true);
record('F6I next-item marked inaccurate', report.contradiction?.PREVIOUS_F6I_NEXT_LOCAL_WORK_ITEM_WAS_ACCURATE === false);
record('protocol export false', protocol.capabilities?.export === false);
record('protocol attestationPrivateKey false', protocol.capabilities?.attestationPrivateKey === false);
record('protocol production host signer.sos010.com', /signer\.sos010\.com/.test(protocol.productionHostTarget || ''));
record('MIGRATE banned', Array.isArray(protocol.bannedMessages) && protocol.bannedMessages.includes('MIGRATE'));
record('READY_FOR_F5B5 false', f5b4.READY_FOR_F5B5 === false);
record('READY_FOR_F5B6 false', f5b4.READY_FOR_F5B6 === false);
record('READY_FOR_F5B4_PRODUCTION_REVIEW true', f5b4.READY_FOR_F5B4_PRODUCTION_REVIEW === true);
record('PRODUCTION_DEPLOY mentions CF/DNS', /Cloudflare|GoDaddy|signer\.sos010\.com/.test(deploy));
record('PRODUCTION_DEPLOY no F5B5/F5B6', /No F5B5 \/ F5B6/.test(deploy));
record('launcher F5B5_EXPORT false', /F5B5_EXPORT:\s*false/.test(launcher));
record('launcher F5B6_MIGRATION false', /F5B6_MIGRATION:\s*false/.test(launcher));
record('F6 design blocks F5B6 sealed migration', /Blocked by F5B6/.test(f6design));
record('F6I report F6H blocked', f6i.invariants?.F6H_STATUS === 'BLOCKED_BY_F5B6');
record('strong confirm reserved not implemented', /STRONG_DEVICE_CONFIRM/.test(confirm) && /STRONG_CONFIRMATION_UNAVAILABLE/.test(confirm));
record('setUserPrivkey guarded by isTrustedIdentityWriteContext before storage',
  /fun setUserPrivkey[\s\S]{0,200}?isTrustedIdentityWriteContext/.test(bridge) &&
  /fun setUserPrivkey[\s\S]{0,500}?SosSessionStore\.setPrivkey/.test(bridge));
record('writeSecureWebIdentity guarded by isTrustedIdentityWriteContext',
  /fun writeSecureWebIdentity[\s\S]{0,250}?isTrustedIdentityWriteContext/.test(bridge));
record('F6_WRITE_PATH_TRUSTED_URL_GUARD closed in report',
  !String(report.verdict?.NEXT_LOCAL_WORK_ITEM || '').includes('F6_WRITE_PATH_TRUSTED_URL_GUARD') ||
  report.verdict?.ALL_POSSIBLE_LOCAL_IMPLEMENTATION_EXHAUSTED === true);
record('blossom direct client present', blossom.DIRECT_CLIENT_TO_BLOSSOM_PRESENT === true);
record('blossom requires external infra', blossom.BLOSSOM_SOURCE_IP_PRIVACY_STATUS === 'REQUIRES_EXTERNAL_INFRA');
record('V2 activation not ready', ac10.READY_TO_ACTIVATE_ACCESS_CONTROL_V2_PRODUCTION === false);
record('verdict F5B5 cannot start now', report.verdict?.F5B5_CAN_START_LOCAL_NOW === false);
record('verdict F5B6 model B present', report.verdict?.F5B6_MODEL_B_BLOCKER_PRESENT === true);
record('verdict F6H requires F5B6', report.verdict?.F6H_REQUIRES_F5B6 === true);
record('legacy delete still false', report.verdict?.LEGACY_DELETE_ALLOWED === false);

const out = {
  gate: 'STAGE5_POST_F6I_DEPENDENCY_RECONCILIATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  invariants: report.verdict,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'qa', 'stage5-post-f6i-dependency-reconciliation-gate-run.json'), JSON.stringify(out, null, 2));
console.log('\nSTAGE5_POST_F6I_DEPENDENCY_RECONCILIATION=' + out.status);
process.exit(fail === 0 ? 0 : 1);
