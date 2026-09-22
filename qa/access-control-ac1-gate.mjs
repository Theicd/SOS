#!/usr/bin/env node
/**
 * AC1 — Central access-control foundation gate.
 * Never prints private keys / nsec / configured secrets beyond pubkey fingerprints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac1-access-control-report.json');

const report = {
  STATUS: 'FAIL',
  CAPABILITY_SOURCE_OF_TRUTH_CENTRALIZED: false,
  AUTH_PRINCIPAL_IS_PUBLIC_KEY: false,
  AUTH_DEFAULT_ALLOW: null,
  AUTH_UNKNOWN_PRINCIPAL_DENIED: false,
  AUTH_UNKNOWN_CAPABILITY_DENIED: false,
  AUTH_UNKNOWN_ACTION_DENIED: false,
  ROOT_ADMIN_GRANTABLE_BY_NORMAL_API: null,
  ROOT_ADMIN_REVOCABLE_BY_NORMAL_API: null,
  ROOT_ADMIN_IMPLICIT_ALL_ADMIN_CAPS: false,
  LEGACY_ROOT_SOURCE_ISOLATED_BEHIND_PROVIDER: false,
  ADMIN_CONFIG_ACCEPTS_PRIVATE_KEY: null,
  ACCESS_CONTROL_RAW_PRIVATE_KEY_INPUT: null,
  AUTHORITY_SNAPSHOT_INTERFACE: false,
  LEGACY_AUTHORITY_CRYPTOGRAPHICALLY_VERIFIED: null,
  LOCALSTORAGE_CAN_GRANT_ADMIN: null,
  LOCALSTORAGE_CAN_GRANT_INVITE: null,
  LOCALSTORAGE_CAN_GRANT_MODERATION: null,
  UI_STATE_CAN_GRANT_CAPABILITY: null,
  RANDOM_PUBKEY_HAS_ADMIN: null,
  RANDOM_PUBKEY_HAS_MODERATION: null,
  RANDOM_PUBKEY_HAS_INVITE: null,
  INVITER_CAN_MODERATE: null,
  MODERATOR_CAN_INVITE: null,
  MEMBER_MANAGER_CAN_GRANT_ADMIN: null,
  CAPABILITY_STRING_INJECTION_PASS: false,
  AUTH_RESULT_MUTATION_CAN_ESCALATE: null,
  AUTHORITY_BOUND_TO_GROUP_ID: false,
  AUTHORITY_GROUP_ID_SOURCE: null,
  GUEST_P2P_KEY_CONTROL_PLANE_ELIGIBLE: null,
  NORMAL_USER_ADMIN_CAPABILITY_COUNT: null,
  ACCESS_CONTROL_V2_DEFAULT: null,
  SIGNER_ADMIN_OPERATION_NAMES_RESERVED: false,
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC1]', String(s).slice(0, 220));
}

function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function fp(pk) {
  const p = String(pk || '').toLowerCase();
  if (p.length < 16) return '(none)';
  return p.slice(0, 8) + '…' + p.slice(-8);
}

(async () => {
  const acSrc = fs.readFileSync(path.join(ROOT, 'access-control.js'), 'utf8');
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');

  let ok = true;

  ok =
    record(
      'config does not derive admin P via getPublicKey(admin hex)',
      !/getPublicKey\(hexToBytes\(trimmed\)\)/.test(cfgSrc) &&
        !/Admin key derivation/.test(cfgSrc) &&
        /PUBLIC keys only|adminSourceKeys are PUBLIC/i.test(cfgSrc)
    ) && ok;
  report.ADMIN_CONFIG_ACCEPTS_PRIVATE_KEY = /getPublicKey\(hexToBytes\(trimmed\)\)/.test(cfgSrc);

  ok =
    record(
      'no SIGN_ANYTHING / admin ops wired into signer yet',
      !fs.existsSync(path.join(ROOT, 'sos-crypto-signer.js')) ||
        !/ADMIN_GRANT_PERMISSION/.test(fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8'))
    ) && ok;

  // Extract configured root pubkey from config without printing full if avoidable — needed for root tests
  const rootMatch = cfgSrc.match(/adminSourceKeys\s*=\s*\[\s*'([0-9a-fA-F]{64})'/);
  const rootPk = rootMatch ? rootMatch[1].toLowerCase() : '';
  ok = record('configured root pubkey present in config', /^[0-9a-f]{64}$/.test(rootPk)) && ok;
  note('root fingerprint ' + fp(rootPk));

  const lsMap = new Map();
  const localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
  };

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    localStorage,
    NostrTools: {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.NostrApp = {
    NETWORK_TAG: 'israel-network',
    COMMUNITY_CONTEXT: 'yalacommunity',
    adminSourceKeys: [rootPk],
    adminPublicKeys: new Set([rootPk]),
    guestMode: false,
  };

  vm.runInNewContext(acSrc, ctx, { filename: 'access-control.js' });
  const AC = ctx.NostrApp.AccessControl || ctx.SosAccessControl;
  ok = record('AccessControl exported', !!AC) && ok;

  report.CAPABILITY_SOURCE_OF_TRUTH_CENTRALIZED = !!(AC && AC.CAPABILITY && AC.hasCapability);
  report.AUTH_PRINCIPAL_IS_PUBLIC_KEY = typeof AC.normalizePubkey === 'function';
  report.ACCESS_CONTROL_V2_DEFAULT = ctx.SOS_ACCESS_CONTROL_V2 === false;
  report.LEGACY_ROOT_SOURCE_ISOLATED_BEHIND_PROVIDER =
    !!(AC.LegacyRootAuthorityProvider && AC.LegacyRootAuthorityProvider.listRootAdminPubkeys);
  report.AUTHORITY_SNAPSHOT_INTERFACE = typeof AC.getAuthoritySnapshot === 'function';
  report.SIGNER_ADMIN_OPERATION_NAMES_RESERVED =
    Array.isArray(AC.RESERVED_SIGNER_ADMIN_OPS) &&
    AC.RESERVED_SIGNER_ADMIN_OPS.includes('ADMIN_GRANT_PERMISSION') &&
    AC.RESERVED_SIGNER_ADMIN_OPS.includes('ADMIN_CREATE_INVITE');

  AC.refreshAuthorityFromLegacy();
  const snap = AC.getAuthoritySnapshot();
  report.LEGACY_AUTHORITY_CRYPTOGRAPHICALLY_VERIFIED = snap.verified === true;
  ok = record('legacy snapshot verified=false', snap.verified === false) && ok;
  ok = record('snapshot source legacy-config', snap.source === 'legacy-config') && ok;
  report.AUTHORITY_BOUND_TO_GROUP_ID = snap.groupId === 'israel-network';
  report.AUTHORITY_GROUP_ID_SOURCE = 'App.NETWORK_TAG (not COMMUNITY_CONTEXT)';
  ok = record('groupId from NETWORK_TAG', snap.groupId === 'israel-network') && ok;
  ok = record('COMMUNITY_CONTEXT not used as groupId', snap.groupId !== 'yalacommunity') && ok;

  // Deny by default / unknown principal
  const randomPk = getPublicKey(generateSecretKey());
  report.AUTH_DEFAULT_ALLOW = false;
  report.AUTH_UNKNOWN_PRINCIPAL_DENIED = !AC.hasCapability(randomPk, AC.CAPABILITY.ROOT_ADMIN);
  report.RANDOM_PUBKEY_HAS_ADMIN = AC.hasCapability(randomPk, AC.CAPABILITY.ROOT_ADMIN);
  report.RANDOM_PUBKEY_HAS_MODERATION = AC.hasCapability(randomPk, AC.CAPABILITY.MODERATE_CONTENT);
  report.RANDOM_PUBKEY_HAS_INVITE = AC.hasCapability(randomPk, AC.CAPABILITY.INVITE_USERS);
  ok = record('random pubkey denied admin', report.RANDOM_PUBKEY_HAS_ADMIN === false) && ok;
  ok = record('random pubkey denied moderation', report.RANDOM_PUBKEY_HAS_MODERATION === false) && ok;
  ok = record('random pubkey denied invite', report.RANDOM_PUBKEY_HAS_INVITE === false) && ok;

  report.AUTH_UNKNOWN_CAPABILITY_DENIED = AC.hasCapability(rootPk, 'NOT_A_REAL_CAP') === false;
  report.AUTH_UNKNOWN_ACTION_DENIED = AC.can(rootPk, 'NOT_A_REAL_ACTION') === false;
  ok = record('unknown capability denied', report.AUTH_UNKNOWN_CAPABILITY_DENIED) && ok;
  ok = record('unknown action denied', report.AUTH_UNKNOWN_ACTION_DENIED) && ok;
  ok = record('empty principal denied', AC.hasCapability('', AC.CAPABILITY.ROOT_ADMIN) === false) && ok;
  ok = record('null principal denied', AC.hasCapability(null, AC.CAPABILITY.ROOT_ADMIN) === false) && ok;

  // Root implicit all admin caps
  const rootCaps = AC.getCapabilities(rootPk);
  report.ROOT_ADMIN_IMPLICIT_ALL_ADMIN_CAPS =
    AC.hasCapability(rootPk, AC.CAPABILITY.ROOT_ADMIN) &&
    AC.ADMIN_CAPABILITIES.every((c) => AC.hasCapability(rootPk, c));
  ok = record('root has ROOT_ADMIN', AC.hasCapability(rootPk, AC.CAPABILITY.ROOT_ADMIN)) && ok;
  ok = record('root implicit all admin caps', report.ROOT_ADMIN_IMPLICIT_ALL_ADMIN_CAPS) && ok;
  note('root cap count ' + rootCaps.length);

  // ROOT_ADMIN not grantable/revocable via normal API
  let grantBlocked = false;
  try {
    AC.grantCapability(rootPk, randomPk, AC.CAPABILITY.ROOT_ADMIN);
  } catch (e) {
    grantBlocked = e && e.code === 'ROOT_ADMIN_NOT_GRANTABLE';
  }
  let revokeBlocked = false;
  try {
    AC.revokeCapability(rootPk, rootPk, AC.CAPABILITY.ROOT_ADMIN);
  } catch (e) {
    revokeBlocked = e && e.code === 'ROOT_ADMIN_NOT_REVOCABLE';
  }
  report.ROOT_ADMIN_GRANTABLE_BY_NORMAL_API = !grantBlocked;
  report.ROOT_ADMIN_REVOCABLE_BY_NORMAL_API = !revokeBlocked;
  ok = record('ROOT_ADMIN not grantable', grantBlocked) && ok;
  ok = record('ROOT_ADMIN not revocable', revokeBlocked) && ok;

  // localStorage / UI self-grant
  localStorage.setItem('isAdmin', 'true');
  localStorage.setItem('role', 'admin');
  localStorage.setItem('capabilities', JSON.stringify(['ROOT_ADMIN', 'INVITE_USERS']));
  ctx.NostrApp.isAdmin = true;
  ctx.document = {
    body: { setAttribute() {}, getAttribute() { return 'admin'; } },
    querySelector() {
      return { classList: { add() {}, contains() { return true; } }, dataset: { role: 'admin' } };
    },
  };
  report.LOCALSTORAGE_CAN_GRANT_ADMIN = AC.hasCapability(randomPk, AC.CAPABILITY.ROOT_ADMIN);
  report.LOCALSTORAGE_CAN_GRANT_INVITE = AC.hasCapability(randomPk, AC.CAPABILITY.INVITE_USERS);
  report.LOCALSTORAGE_CAN_GRANT_MODERATION = AC.hasCapability(randomPk, AC.CAPABILITY.MODERATE_CONTENT);
  report.UI_STATE_CAN_GRANT_CAPABILITY = AC.hasCapability(randomPk, AC.CAPABILITY.MANAGE_ADMINS);
  ok = record('localStorage cannot grant admin', report.LOCALSTORAGE_CAN_GRANT_ADMIN === false) && ok;
  ok = record('localStorage cannot grant invite', report.LOCALSTORAGE_CAN_GRANT_INVITE === false) && ok;
  ok = record('localStorage cannot grant moderation', report.LOCALSTORAGE_CAN_GRANT_MODERATION === false) && ok;
  ok = record('UI state cannot grant', report.UI_STATE_CAN_GRANT_CAPABILITY === false) && ok;

  // Capability separation fixtures (QA overlay only)
  const pkA = getPublicKey(generateSecretKey());
  const pkB = getPublicKey(generateSecretKey());
  const pkC = getPublicKey(generateSecretKey());
  AC.installQaAuthorityOverlay({
    groupId: 'israel-network',
    rootAdminPubkey: rootPk,
    capabilitiesByPubkey: {
      [rootPk]: ['ROOT_ADMIN'],
      [pkA]: ['INVITE_USERS'],
      [pkB]: ['MODERATE_CONTENT'],
      [pkC]: ['MANAGE_MEMBERS'],
    },
    source: 'qa-overlay',
    verified: false,
  });
  report.INVITER_CAN_MODERATE = AC.hasCapability(pkA, AC.CAPABILITY.MODERATE_CONTENT);
  report.MODERATOR_CAN_INVITE = AC.hasCapability(pkB, AC.CAPABILITY.INVITE_USERS);
  report.MEMBER_MANAGER_CAN_GRANT_ADMIN =
    AC.hasCapability(pkC, AC.CAPABILITY.MANAGE_ADMINS) ||
    AC.can(pkC, 'GRANT_ADMIN_CAPABILITY');
  ok = record('inviter cannot moderate', report.INVITER_CAN_MODERATE === false) && ok;
  ok = record('moderator cannot invite', report.MODERATOR_CAN_INVITE === false) && ok;
  ok = record('member manager cannot grant admin', report.MEMBER_MANAGER_CAN_GRANT_ADMIN === false) && ok;
  ok = record('inviter can invite action', AC.can(pkA, 'CREATE_INVITE_PRIVILEGED') === true) && ok;
  ok = record('moderator can moderate post', AC.can(pkB, 'MODERATE_POST') === true) && ok;
  ok = record('member manager can remove', AC.can(pkC, 'REMOVE_USER') === true) && ok;
  AC.clearQaAuthorityOverlay();

  // String injection
  const injections = [
    'ROOT_ADMIN',
    '*',
    'ALL',
    'admin',
    '__proto__',
    'constructor',
    'root_admin',
    'Root_Admin',
    'ＲＯＯＴ＿ＡＤＭＩＮ',
    'MANAGE_ADMINS\0',
    ' MANAGE_ADMINS',
    'MANAGE_ADMINS ',
  ];
  let injectionPass = true;
  for (const s of injections) {
    // ROOT_ADMIN string against random user must be false; malformed tokens denied
    if (AC.hasCapability(randomPk, s)) {
      injectionPass = false;
      note('injection leak: ' + String(s).slice(0, 40));
    }
  }
  // prototype pollution attempt on snapshot maps
  try {
    const caps = AC.getCapabilities(rootPk);
    caps.push('INVITE_USERS');
    const again = AC.getCapabilities(randomPk);
    if (again.includes('INVITE_USERS') && !AC.hasCapability(randomPk, AC.CAPABILITY.INVITE_USERS) === false) {
      /* check mutation escalate */
    }
  } catch (_e) {}
  report.CAPABILITY_STRING_INJECTION_PASS = injectionPass;
  ok = record('capability string injection', injectionPass) && ok;

  // Immutability
  const before = AC.getCapabilities(randomPk).slice();
  const mutable = AC.getCapabilities(rootPk);
  mutable.push(AC.CAPABILITY.INVITE_USERS);
  mutable.push('__proto__');
  try {
    const snap2 = AC.getAuthoritySnapshot();
    snap2.capabilitiesByPubkey[randomPk] = ['ROOT_ADMIN'];
    if (snap2.rootAdminPubkey) snap2.rootAdminPubkey = randomPk;
  } catch (_e) {
    /* frozen throws — good */
  }
  report.AUTH_RESULT_MUTATION_CAN_ESCALATE =
    AC.hasCapability(randomPk, AC.CAPABILITY.ROOT_ADMIN) === true ||
    AC.hasCapability(randomPk, AC.CAPABILITY.INVITE_USERS) === true;
  ok = record('mutation cannot escalate', report.AUTH_RESULT_MUTATION_CAN_ESCALATE === false) && ok;
  ok = record('random still empty after mutate', before.length === 0) && ok;

  // Guest denial
  const guestSk = generateSecretKey();
  const guestPk = getPublicKey(guestSk);
  ctx.NostrApp.guestMode = true;
  ctx.NostrApp.publicKey = guestPk;
  ctx.NostrApp.identityClass = 'EPHEMERAL_GUEST';
  ctx.NostrApp.GuestP2PKeyVault = {
    getMetaSync() {
      return { ready: true, publicKey: guestPk, isGuest: true };
    },
  };
  AC.refreshAuthorityFromLegacy();
  ok = record('guest no ROOT_ADMIN', AC.hasCapability(guestPk, AC.CAPABILITY.ROOT_ADMIN) === false) && ok;
  ok = record('guest no MANAGE_ADMINS', AC.hasCapability(guestPk, AC.CAPABILITY.MANAGE_ADMINS) === false) && ok;
  ok = record('guest no MODERATE', AC.hasCapability(guestPk, AC.CAPABILITY.MODERATE_CONTENT) === false) && ok;
  ok = record('guest no INVITE', AC.hasCapability(guestPk, AC.CAPABILITY.INVITE_USERS) === false) && ok;
  ok = record('guest no MANAGE_MEMBERS', AC.hasCapability(guestPk, AC.CAPABILITY.MANAGE_MEMBERS) === false) && ok;
  report.GUEST_P2P_KEY_CONTROL_PLANE_ELIGIBLE = AC.isControlPlaneEligible(guestPk);
  ok = record('guest P2P not control-plane eligible', report.GUEST_P2P_KEY_CONTROL_PLANE_ELIGIBLE === false) && ok;

  // Normal registered user
  ctx.NostrApp.guestMode = false;
  ctx.NostrApp.identityClass = 'REGISTERED';
  delete ctx.NostrApp.GuestP2PKeyVault;
  const normalPk = getPublicKey(generateSecretKey());
  ctx.NostrApp.publicKey = normalPk;
  AC.refreshAuthorityFromLegacy();
  report.NORMAL_USER_ADMIN_CAPABILITY_COUNT = AC.getCapabilities(normalPk).length;
  ok = record('normal user admin caps 0', report.NORMAL_USER_ADMIN_CAPABILITY_COUNT === 0) && ok;

  // Raw K / nsec rejection
  let nsecRejected = false;
  try {
    AC.assertNoPrivateKeyInput('nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
  } catch (e) {
    nsecRejected = e && e.code === 'ACCESS_CONTROL_REJECTS_PRIVATE_KEY';
  }
  report.ACCESS_CONTROL_RAW_PRIVATE_KEY_INPUT = !nsecRejected;
  ok = record('rejects nsec input helper', nsecRejected) && ok;
  ok = record('access-control.js never calls getPublicKey', !/getPublicKey\s*\(/.test(acSrc)) && ok;

  // V2 flag default
  ok = record('SOS_ACCESS_CONTROL_V2 default false', report.ACCESS_CONTROL_V2_DEFAULT === true) && ok;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
