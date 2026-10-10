/**
 * STAGE 5 — Account revocation + directory hygiene gate (local, no production mutation).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || null });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const ver = JSON.parse(read('app-version.json'));
check('VERSION_899S_LINE', /^2026\.10\.05-web-899s\.\d+$/.test(String(ver.version || '')), ver.version);

check('MODULE_ACCOUNT_STATUS', exists('account-status-state.js'));
check('MODULE_DIRECTORY_HYGIENE', exists('directory-hygiene-state.js'));
check('MODULE_ACCOUNT_DIRECTORY_OPS', exists('account-directory-ops.js'));

const policy = require(path.join(ROOT, 'admin-signing-policy.js'));
check('KIND_39005', policy.ACCOUNT_STATUS_KIND === 39005);
check('KIND_39006', policy.DIRECTORY_HYGIENE_KIND === 39006);
check('OP_DISABLE', !!policy.ADMIN_OP.DISABLE_ACCOUNT);
check('OP_REENABLE', !!policy.ADMIN_OP.REENABLE_ACCOUNT);
check('OP_HIDE', !!policy.ADMIN_OP.HIDE_DIRECTORY);
check('OP_RESTORE', !!policy.ADMIN_OP.RESTORE_DIRECTORY);
check('IS_ACCOUNT_STATUS_OP', policy.isAccountStatusOp('DISABLE_ACCOUNT') === true);
check('IS_DIR_OP', policy.isDirectoryHygieneOp('HIDE_DIRECTORY') === true);
check('MEMBER_OPS_UNCHANGED_BLOCK', policy.isMemberOp('BLOCK_MEMBER') === true);
check('MEMBER_OPS_UNCHANGED_REMOVE', policy.isMemberOp('REMOVE_MEMBER') === true);

const root = 'a'.repeat(64);
const actor = root;
const target = 'b'.repeat(64);
const base = {
  schema: 'sos-group-control',
  version: 1,
  groupId: 'israel-network',
  controlEpoch: 3,
  rootAdminPubkey: root,
  capabilities: {},
  invitePolicy: 'EVERYONE',
  blockedPubkeys: [],
  membershipEpoch: 1,
  groupSettings: { displayName: 'x', networkTag: 'israel-network' },
  createdAt: 1,
};
const disableBody = policy.applyAccountStatusOperation(
  'DISABLE_ACCOUNT',
  base,
  null,
  actor,
  { groupId: 'israel-network', targetPubkey: target, reasonCode: 'ADMIN_DISABLED' }
);
check('DISABLE_STATUS', disableBody.status === 'DISABLED' && disableBody.revision === 1);
const disableDraft = policy.buildAccountStatusDraft(disableBody);
check('DISABLE_DRAFT_KIND', disableDraft.kind === 39005);

let nonRootFail = false;
try {
  policy.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, target, {
    groupId: 'israel-network',
    targetPubkey: 'c'.repeat(64),
  });
} catch (e) {
  nonRootFail = e && e.code === 'ROOT_ONLY';
}
check('NON_ROOT_DISABLE_REJECTED', nonRootFail);

let rootProtect = false;
try {
  policy.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, actor, {
    groupId: 'israel-network',
    targetPubkey: root,
  });
} catch (e) {
  rootProtect = e && e.code === 'ROOT_PROTECTED';
}
check('ROOT_IMMUTABLE_DISABLE', rootProtect);

const reBody = policy.applyAccountStatusOperation(
  'REENABLE_ACCOUNT',
  base,
  { revision: 1 },
  actor,
  { groupId: 'israel-network', targetPubkey: target }
);
check('REENABLE_STATUS', reBody.status === 'ENABLED' && reBody.revision === 2);

const hideBody = policy.applyDirectoryHygieneOperation(
  'HIDE_DIRECTORY',
  base,
  null,
  actor,
  { groupId: 'israel-network', targetPubkey: target }
);
check('HIDE_VISIBILITY', hideBody.visibility === 'HIDDEN');
check('HIDE_NOTE_NO_ERASURE', /not cryptographic deletion/i.test(hideBody.note || ''));

const a2fa = read('admin-2fa-protocol.js');
check('A2FA_KINDS', /39005/.test(a2fa) && /39006/.test(a2fa));
check('A2FA_OPS', /DISABLE_ACCOUNT/.test(a2fa) && /HIDE_DIRECTORY/.test(a2fa));
check('A2FA_STEP_UP', /DISABLE_ACCOUNT/.test(a2fa) && /STEP_UP_OPERATIONS/.test(a2fa));

const signer = read('sos-crypto-signer.js');
const worker = read('sos-crypto-worker.js');
check('SIGNER_ACCOUNT_STATUS', /isAccountStatusOp/.test(signer) && /buildAccountStatusDraft/.test(signer));
check('WORKER_ACCOUNT_STATUS', /isAccountStatusOp/.test(worker) && /buildDirectoryHygieneDraft/.test(worker));

const keys = read('keys.js');
check('LOGIN_GATE_ENSURE', /assertLoginAllowed/.test(keys) && /ACCOUNT_DISABLED/.test(keys));
check('LOGIN_NO_INVALID_CLAIM', /KEY_CLAIMED_INVALID:\s*false/.test(keys));

const life = read('identity-lifecycle.js');
check('SWITCH_GATE', /ACCOUNT_DISABLED/.test(life) && /assertLoginAllowed/.test(life));

const guest = read('guest-auth.js');
const auth = read('auth.js');
const msg = 'החשבון הושבת ואינו מורשה להתחבר ל-SOS.';
check('UI_MSG_GUEST', guest.includes(msg));
check('UI_MSG_AUTH', auth.includes(msg));

const fga = read('first-group-admin.js');
check('FGA_DISABLE_API', /disableAccount/.test(fga) && /hideFromDirectory/.test(fga));
check('FGA_OPERATIONAL_FLAG', /operationalVisible/.test(fga) && /profileOnly/.test(fga));

const ui = read('group-admin-product-ui.js');
check('UI_DISABLE_ACTION', ui.includes('השבת חשבון') && ui.includes('הפעל חשבון מחדש'));
check('UI_HIDE_ACTION', ui.includes('הסר מהרשימה') && ui.includes('החזר לרשימה'));
check('UI_REMOVE_LABEL', ui.includes('הסר מהקבוצה'));
check('UI_BLOCK_LABEL', ui.includes('חסום משתמש'));
check('UI_DEFAULT_OPERATIONAL', /dirFilter = 'OPERATIONAL'/.test(ui));
check('UI_NO_ERASURE_CLAIM', ui.includes('אינו מחיקה קריפטוגרפית'));

const ops = read('account-directory-ops.js');
check('REENABLE_NO_RESTORE_MEMBERSHIP', /REENABLE_RESTORES_MEMBERSHIP:\s*false/.test(ops));
check('REENABLE_NO_RESTORE_CAPS', /REENABLE_RESTORES_CAPABILITIES:\s*false/.test(ops));
check('REENABLE_NO_RESTORE_BLOCK', /REENABLE_RESTORES_BLOCKLIST:\s*false/.test(ops));
check('HIDE_NOT_ERASURE', /DIRECTORY_HIDE_IS_CRYPTOGRAPHIC_DELETION:\s*false/.test(ops));

const net = read('first-group-network-authority.js');
check('NET_FETCH_39005_39006', /KIND_ACCOUNT_STATUS = 39005/.test(net) && /KIND_DIRECTORY_HYGIENE = 39006/.test(net));

const videos = read('videos.html');
check('SCRIPT_TAGS', /account-status-state\.js/.test(videos) && /account-directory-ops\.js/.test(videos));

const pin = read('admission-service/src/pin.js');
check('PIN_CLASSIFY_39005', /ACCOUNT_STATUS_KIND = 39005/.test(pin) && /DISABLE_ACCOUNT/.test(pin));

const assSrc = read('account-status-state.js');
check('CACHE_FAIL_CLOSED', /CACHED_DISABLED_FAILS_OPEN:\s*false/.test(assSrc));
check('DISABLED_LOGIN_NOT_ACCEPTED', /DISABLED_KEY_FILE_LOGIN_ACCEPTED:\s*false/.test(assSrc));

const auditPath = path.join(ROOT, 'qa/account-directory-source-audit.json');
check('DIRECTORY_AUDIT_PRESENT', fs.existsSync(auditPath));
if (fs.existsSync(auditPath)) {
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  check('DIRECTORY_AUDIT_HAS_SOURCES', Array.isArray(audit.sources) && audit.sources.length >= 3);
  check('DIRECTORY_AUDIT_EXPLAINED_BLOAT', !!audit.whyApproximatelySixty);
}

const failed = checks.filter((c) => !c.ok);
const report = {
  gate: 'account-revocation-directory-hygiene',
  version: ver.version,
  passed: failed.length === 0,
  total: checks.length,
  failed: failed.length,
  checks,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(ROOT, 'qa/account-revocation-directory-hygiene-report.json'),
  JSON.stringify(report, null, 2) + '\n'
);
console.log(failed.length === 0 ? '\nGATE PASS' : `\nGATE FAIL (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
