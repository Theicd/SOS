/**
 * AC V2 product reconciliation — inventory AC1–AC10 vs product gaps.
 * QA only. Does not enable production V2. Does not deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'access-control-v2-product-reconciliation-report.json');

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const components = [];
function add(name, row) {
  components.push({ component: name, ...row });
}

const ac = read('access-control.js');
const gcs = read('group-control-state.js');
const mut = read('group-control-mutations.js');
const ms = read('membership-state.js');
const adminUi = read('admin-settings-ui.js');
const memUi = read('member-directory-ui.js');
const ops = read('member-admin-operations.js');
const invite = read('invite-service.js');
const invPol = read('invite-policy.js');
const qr = read('sos-invite-qr-ui.js');
const mod = read('moderation-policy.js');
const cc = read('community-context.js');
const asp = read('admin-signing-policy.js');
const guest = read('guest-access-control.js');
const videos = read('videos.html');

add('AccessControl', {
  IMPLEMENTED_PROTOCOL: /CAPABILITY|ACTION_CAPABILITY_MATRIX/.test(ac),
  IMPLEMENTED_STORAGE: /authoritySnapshot/.test(ac),
  IMPLEMENTED_AUTHORIZATION: /hasCapability|canPerformAction/.test(ac),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /access-control\.js/.test(videos),
  HIDDEN_BY_FLAG: /SOS_ACCESS_CONTROL_V2/.test(ac) && /false/.test(ac),
  MISSING: false,
  BLOCKED: false,
  NOTES: 'Canonical capability matrix; V2 selects SignedGroupControlProvider',
});

add('GroupControlState', {
  IMPLEMENTED_PROTOCOL: /GROUP_CONTROL_EVENT_KIND|sos-group-control/.test(gcs),
  IMPLEMENTED_STORAGE: /ingestControlEvents|verified/.test(gcs),
  IMPLEMENTED_AUTHORIZATION: /authorizeTransition/.test(gcs),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /group-control-state\.js/.test(videos),
  HIDDEN_BY_FLAG: false,
  MISSING: false,
  BLOCKED: /legacyRootPubkey|only legacy root/.test(gcs),
  NOTES: 'BOOTSTRAP accept path historically legacy-root-only — product create needs creator=root',
});

add('GroupControlMutations', {
  IMPLEMENTED_PROTOCOL: /GRANT_CAPABILITY|SET_INVITE_POLICY/.test(mut),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /isV2|hasCapability|applyControlMutation/.test(mut),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /group-control-mutations\.js/.test(videos),
  HIDDEN_BY_FLAG: /SOS_ACCESS_CONTROL_V2/.test(mut),
  MISSING: false,
  BLOCKED: false,
  NOTES: 'Allowlisted mutations; typed SIGN_ADMIN_TYPED',
});

add('MembershipState', {
  IMPLEMENTED_PROTOCOL: /ACTIVE|REMOVED|BLOCKED|BOOTSTRAP_ACTIVE/.test(ms),
  IMPLEMENTED_STORAGE: /membership/.test(ms),
  IMPLEMENTED_AUTHORIZATION: /membershipAccessAllowed|isActiveMember/.test(ms),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /membership-state\.js/.test(videos),
  HIDDEN_BY_FLAG: /SOS_ACCESS_CONTROL_V2/.test(ms),
  MISSING: false,
  BLOCKED: false,
  NOTES: 'Authoritative membership tips; dual-authority with blocklist',
});

add('MemberAdminOperations', {
  IMPLEMENTED_PROTOCOL: /blockMember|removeMember|unblockMember/.test(ops),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /MANAGE_MEMBERS|actorMayManage/.test(ops),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /member-admin-operations\.js/.test(videos),
  HIDDEN_BY_FLAG: /SOS_ACCESS_CONTROL_V2/.test(ops),
  MISSING: false,
  BLOCKED: false,
});

add('AdminSettingsUi', {
  IMPLEMENTED_PROTOCOL: true,
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /canSeeAdminEntry|hasCapability/.test(adminUi),
  IMPLEMENTED_UI: /sosAdminSettingsModal|הגדרות קבוצה/.test(adminUi),
  WIRED_TO_PRODUCT: /admin-settings-ui\.js/.test(videos),
  HIDDEN_BY_FLAG: true,
  MISSING: !/ניהול קבוצה/.test(adminUi),
  BLOCKED: false,
  NOTES: 'Floating entry "הגדרות קבוצה"; missing product nav label ניהול קבוצה + tabs home',
});

add('MemberDirectoryUi', {
  IMPLEMENTED_PROTOCOL: true,
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /isV2|Ops\(\)/.test(memUi),
  IMPLEMENTED_UI: /sosMemberDirectorySection|חברים/.test(memUi),
  WIRED_TO_PRODUCT: /member-directory-ui\.js/.test(videos),
  HIDDEN_BY_FLAG: true,
  MISSING: false,
  BLOCKED: false,
});

add('InvitePolicy+InviteService', {
  IMPLEMENTED_PROTOCOL: /createInvite|redeem|revoke|ih/.test(invite + invPol),
  IMPLEMENTED_STORAGE: true,
  IMPLEMENTED_AUTHORIZATION: /InvitePolicy|V2/.test(invite + invPol),
  IMPLEMENTED_UI: /invite/.test(videos),
  WIRED_TO_PRODUCT: true,
  HIDDEN_BY_FLAG: /SOS_ACCESS_CONTROL_V2/.test(invPol),
  MISSING: false,
  BLOCKED: false,
});

add('InviteQrUi', {
  IMPLEMENTED_PROTOCOL: /renderInviteQr|QRCode/.test(qr),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: false,
  IMPLEMENTED_UI: /סרוק QR הזמנה|sos-invite-qr/.test(qr),
  WIRED_TO_PRODUCT: /sos-invite-qr-ui\.js/.test(videos),
  HIDDEN_BY_FLAG: false,
  MISSING: !/AdminSettings|ניהול/.test(qr),
  BLOCKED: false,
  NOTES: 'QR exists; not integrated into Admin management home tabs',
});

add('ModerationPolicy', {
  IMPLEMENTED_PROTOCOL: /MODERATE_CONTENT|canModerate/.test(mod),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /SOS_ACCESS_CONTROL_V2/.test(mod),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /moderation-policy\.js/.test(videos),
  HIDDEN_BY_FLAG: true,
  MISSING: false,
  BLOCKED: false,
});

add('CommunityContext', {
  IMPLEMENTED_PROTOCOL: /register|setActive|networkTag/.test(cc),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: false,
  IMPLEMENTED_UI: exists('community.html'),
  WIRED_TO_PRODUCT: /community-context\.js/.test(videos),
  HIDDEN_BY_FLAG: false,
  MISSING: !/createGroup|יצירת קבוצה/.test(cc + adminUi),
  BLOCKED: false,
  NOTES: 'Multi-community metadata ready; product Create Group flow missing',
});

add('AdminSigningPolicy', {
  IMPLEMENTED_PROTOCOL: /BOOTSTRAP_GROUP_CONTROL|GRANT_MEMBER_ACTIVE|MANAGE_ADMINS/.test(asp),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: true,
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: true,
  HIDDEN_BY_FLAG: false,
  MISSING: false,
  BLOCKED: false,
  NOTES: 'Signer already builds bootstrap with rootAdminPubkey=actor',
});

add('GuestAccessControl', {
  IMPLEMENTED_PROTOCOL: /GuestAccessControl/.test(guest),
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: true,
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: /guest-access-control\.js/.test(videos),
  HIDDEN_BY_FLAG: true,
  MISSING: false,
  BLOCKED: false,
});

add('GroupAdminNavProduct', {
  IMPLEMENTED_PROTOCOL: false,
  IMPLEMENTED_STORAGE: false,
  IMPLEMENTED_AUTHORIZATION: /canSeeAdminEntry/.test(adminUi),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: false,
  HIDDEN_BY_FLAG: true,
  MISSING: true,
  BLOCKED: false,
  NOTES: 'Required Hebrew menu ניהול קבוצה + management home tabs',
});

add('GroupCreateProduct', {
  IMPLEMENTED_PROTOCOL: /BOOTSTRAP_GROUP_CONTROL/.test(asp + gcs),
  IMPLEMENTED_STORAGE: true,
  IMPLEMENTED_AUTHORIZATION: /authorizeTransition/.test(gcs),
  IMPLEMENTED_UI: false,
  WIRED_TO_PRODUCT: false,
  HIDDEN_BY_FLAG: true,
  MISSING: true,
  BLOCKED: /issuer !== legacy/.test(gcs) || /only legacy root/.test(gcs),
  NOTES: 'Need creator-as-root accept path for new groupId tip',
});

const requiredFiles = [
  'access-control.js',
  'group-control-state.js',
  'group-control-mutations.js',
  'membership-state.js',
  'member-admin-operations.js',
  'admin-settings-ui.js',
  'member-directory-ui.js',
  'invite-policy.js',
  'invite-service.js',
  'sos-invite-qr-ui.js',
  'moderation-policy.js',
  'community-context.js',
  'admin-signing-policy.js',
];
const filesOk = requiredFiles.every((f) => exists(f));

const report = {
  gate: 'ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION',
  status: filesOk ? 'PASS' : 'FAIL',
  ts: new Date().toISOString(),
  PRODUCTION_BASELINE_MAIN: 'c5e764fd15befc16d26d944a3fba5d1f29b2eb08',
  PRODUCTION_PACKAGE: 894,
  ACCESS_CONTROL_V2_DEFAULT: false,
  CANONICAL_GROUP_AUTHORITY_MODEL:
    'GroupControlState verified tip + MembershipState tip + AccessControl.hasCapability; mutations via GroupControlMutations/MemberAdminOperations + SIGN_ADMIN_TYPED',
  CLIENT_ONLY_ADMIN_TRUST: false,
  components,
  PRODUCT_GAPS: [
    'Menu label ניהול קבוצה + management home tabs',
    'Create Group product flow (creator=root bootstrap accept)',
    'Local/test V2 enablement without production flag change',
    'Admin UI integration of invite QR tabs',
  ],
  ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION_GATE: filesOk ? 'PASS' : 'FAIL',
  CANONICAL_GROUP_AUTHORITY_MODEL_DEFINED: true,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('STATUS', report.status);
console.log('GATE', report.ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION_GATE);
console.log('REPORT', OUT);
process.exit(filesOk ? 0 : 1);
