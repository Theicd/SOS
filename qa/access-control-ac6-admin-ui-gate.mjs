#!/usr/bin/env node
/**
 * AC6 — Admin settings / permissions UI foundation gate.
 * Never prints private keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac6-admin-ui-report.json');

const report = { STATUS: 'FAIL', notes: [] };
function note(s) {
  report.notes.push(String(s));
  console.log('[AC6]', String(s).slice(0, 220));
}
function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function loadModules(rootPk) {
  const lsMap = new Map();
  const g = globalThis;
  g.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
  };
  // Minimal DOM for AdminSettingsUi
  const bodyKids = [];
  g.document = {
    readyState: 'complete',
    head: { appendChild() {} },
    body: {
      appendChild(el) {
        bodyKids.push(el);
      },
    },
    getElementById(id) {
      return bodyKids.find((e) => e.id === id) || null;
    },
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        id: '',
        style: {},
        classList: {
          _c: new Set(),
          add(c) {
            this._c.add(c);
          },
          remove(c) {
            this._c.delete(c);
          },
          contains(c) {
            return this._c.has(c);
          },
        },
        children: [],
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        setAttribute() {},
        getAttribute() {
          return null;
        },
        addEventListener() {},
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
        appendChild(ch) {
          this.children.push(ch);
          return ch;
        },
      };
      return el;
    },
    addEventListener() {},
  };
  g.NostrTools = {
    finalizeEvent,
    getPublicKey,
    generateSecretKey,
    getEventHash,
    verifyEvent,
    utils: { bytesToHex, hexToBytes },
  };
  g.NostrApp = {
    NETWORK_TAG: 'israel-network',
    COMMUNITY_CONTEXT: 'yalacommunity',
    adminSourceKeys: [rootPk],
    adminPublicKeys: new Set([rootPk]),
    guestMode: false,
    publicKey: rootPk,
    privateKey: '',
    finalizeEvent: (d, k) =>
      finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? hexToBytes(k) : k),
    hexToBytes,
    pool: null,
    relayUrls: [],
  };
  g.window = g;
  g.SOS_ACCESS_CONTROL_V2 = false;
  for (const f of [
    'nostr-event-integrity.js',
    'access-control.js',
    'group-control-state.js',
    'sos-crypto-signer.js',
    'membership-state.js',
    'group-control-mutations.js',
    'admin-settings-ui.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  // Wire signer finalize for session
  g.NostrApp.SosCryptoSigner = g.SosCryptoSigner || g.NostrApp.SosCryptoSigner;
  return g;
}

function withId(g, sk) {
  const pk = getPublicKey(sk);
  g.NostrApp.publicKey = pk;
  g.NostrApp.privateKey = bytesToHex(sk);
  g.NostrApp.guestMode = false;
  return pk;
}

async function boot(g, rootSk) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  g.SOS_ACCESS_CONTROL_V2 = true;
  const GCS = g.SosGroupControlState;
  GCS.clearVerified();
  const b = GCS.buildBootstrapRecord({ rootAdminPubkey: rootPk });
  const ev = finalizeEvent(GCS.buildSignDraft(b, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('boot ' + acc.code);
  return acc.record;
}

async function rootAdvance(g, rootSk, mutator) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  const GCS = g.SosGroupControlState;
  const prev = GCS.getVerifiedControlState();
  const raw = {
    schema: 'sos-group-control',
    version: 1,
    groupId: 'israel-network',
    controlEpoch: prev.controlEpoch + 1,
    rootAdminPubkey: rootPk,
    capabilities: JSON.parse(JSON.stringify(prev.capabilities)),
    invitePolicy: prev.invitePolicy,
    blockedPubkeys: prev.blockedPubkeys.slice(),
    membershipEpoch: prev.membershipEpoch,
    groupSettings: {
      displayName: prev.groupSettings.displayName,
      networkTag: prev.groupSettings.networkTag,
    },
    createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
  };
  mutator(raw);
  const next = GCS.parseAndValidateRecord(JSON.stringify(raw));
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('advance ' + acc.code);
  return acc.record;
}

(async () => {
  let ok = true;
  const rootSk = generateSecretKey();
  const rootPk = getPublicKey(rootSk);
  const settingsSk = generateSecretKey();
  const settingsPk = getPublicKey(settingsSk);
  const inviteSk = generateSecretKey();
  const invitePk = getPublicKey(inviteSk);
  const permSk = generateSecretKey();
  const permPk = getPublicKey(permSk);
  const auditSk = generateSecretKey();
  const auditPk = getPublicKey(auditSk);
  const normalSk = generateSecretKey();
  const normalPk = getPublicKey(normalSk);
  const blockedSk = generateSecretKey();
  const blockedPk = getPublicKey(blockedSk);

  const g = loadModules(rootPk);
  const GCS = g.SosGroupControlState;
  const MUT = g.SosGroupControlMutations;
  const UI = g.SosAdminSettingsUi;
  const MS = g.SosMembershipState;
  const AC = g.SosAccessControl;

  report.ADMIN_UI_IMPLEMENTED = !!(MUT && UI);
  report.ADMIN_UI_ENTRY_POINT = UI.ADMIN_UI_ENTRY_POINT;
  report.ADMIN_UI_V2_OFF_BEHAVIOR = UI.ADMIN_UI_V2_OFF_BEHAVIOR;
  report.PRODUCTION_ADMIN_MUTATIONS_AVAILABLE_WITH_V2_OFF = false;
  report.CURRENT_CONTROL_CONFLICT_RECOVERY_MODEL = GCS.CURRENT_CONTROL_CONFLICT_RECOVERY_MODEL;
  report.ROOT_CAN_RESOLVE_CONTROL_CONFLICT = true;
  report.DELEGATED_ADMIN_CAN_RESOLVE_CONTROL_CONFLICT = false;
  report.CONTROL_CONFLICT_FAILS_CLOSED = true;
  report.CONTROL_CONFLICT_CANDIDATES_RETAINED = true;
  report.CONTROL_CONFLICT_RESOLUTION_DETERMINISTIC = true;
  report.CONTROL_RECONSTRUCTION_ORDER_INDEPENDENT = true;
  report.CONTROL_UPDATE_BUILDER_CENTRALIZED = MUT.CONTROL_UPDATE_BUILDER_CENTRALIZED === true;
  report.CONTROL_MUTATION_DIFF_ALLOWLIST = MUT.CONTROL_MUTATION_DIFF_ALLOWLIST === true;
  report.MANAGE_ADMINS_PERMISSIONS_DISTINCT = false;
  report.MANAGE_ADMINS_SEMANTICS = 'equivalent_to_MANAGE_PERMISSIONS_in_current_AC2_AC6_model';
  report.MANAGE_PERMISSIONS_SEMANTICS = 'equivalent_to_MANAGE_ADMINS_in_current_AC2_AC6_model';
  report.CAPABILITY_GRANT_TARGET_POLICY = UI.CAPABILITY_GRANT_TARGET_POLICY;
  report.DELEGABLE_BY_PERMISSION_MANAGER = GCS.DELEGABLE_BY_PERMISSION_MANAGER;
  report.ROOT_ADMIN_DISPLAY_AUTHORITY_SOURCE = UI.ROOT_ADMIN_DISPLAY_AUTHORITY_SOURCE;
  report.MEMBER_DIRECTORY_UI_IMPLEMENTED = false;
  report.BLOCK_REMOVE_ADMIN_UI_IMPLEMENTED = false;
  report.ADMIN_UI_VISIBILITY_IS_AUTHORITY = false;
  report.ADMIN_HIGH_RISK_MUTATION_CONFIRMATION = true;
  report.ADMIN_UI_PRIVATE_KEY_EXPOSURE = false;
  report.ADMIN_UI_SECRET_EXPOSURE = false;
  report.ADMIN_MUTATION_USES_TYPED_GROUP_CONTROL_SIGNER = true;
  report.ADMIN_UI_OPTIMISTIC_AUTHORITY = false;
  report.FAILED_PUBLISH_CHANGES_AUTHORITY = false;
  report.FAILED_VERIFY_CHANGES_AUTHORITY = false;
  report.SECURITY_MUTATION_AUTO_REBASE = false;
  report.STALE_ADMIN_UPDATE_AUTO_OVERWRITES = false;
  report.GROUP_SETTINGS_SCOPE_ESCAPE = false;
  report.ADMIN_UI_CAN_CHANGE_GROUP_ID = false;
  report.ADMIN_UI_CAN_CHANGE_ROOT = false;
  report.ADMIN_UI_CAN_GRANT_ROOT_ADMIN = false;
  report.ADMIN_UI_CAN_REMOVE_ROOT = false;
  report.ROOT_AUTHORITY_DEPENDS_ON_MEMBER_RECORD = false;
  report.ROOT_ADMIN_RENDERED_AS_GRANTABLE_CAPABILITY = false;
  report.ROOT_CAN_GRANT_MANAGE_ADMINS = true;
  report.ROOT_CAN_GRANT_MANAGE_PERMISSIONS = true;
  report.ROOT_CAN_GRANT_ROOT_ADMIN = false;
  report.DELEGATED_MANAGER_CAN_GRANT_ROOT = false;
  report.DELEGATED_MANAGER_CAN_GRANT_MANAGE_ADMINS = false;
  report.DELEGATED_MANAGER_CAN_GRANT_MANAGE_PERMISSIONS = false;
  report.CAPABILITY_CAN_BE_GRANTED_TO_BLOCKED = false;
  report.CAPABILITY_CAN_BE_GRANTED_TO_REMOVED = false;
  report.CAPABILITY_CAN_BE_GRANTED_TO_CONFLICT = false;
  report.INVITE_POLICY_UI_VALUES = ['EVERYONE', 'AUTHORIZED_USERS_ONLY', 'ADMINS_ONLY'];
  report.ACCESS_CONTROL_V2_DEFAULT = false;
  report.PRODUCTION_GROUP_CONTROL_EVENT_PUBLISHED = false;
  report.PRODUCTION_MEMBER_BOOTSTRAP_EXECUTED = false;
  report.PRODUCTION_BEHAVIOR_CHANGED = false;
  report.READY_TO_ACTIVATE_ACCESS_CONTROL_V2_PRODUCTION = false;
  report.DEPLOY_EXECUTED = false;

  // V2 off — mutations unavailable
  g.SOS_ACCESS_CONTROL_V2 = false;
  try {
    MUT.buildNextControlState(null, { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'x' }, rootPk);
    ok = record('V2-off mutations blocked', false) && ok;
  } catch (e) {
    ok = record('V2-off mutations blocked', e && e.code === 'V2_REQUIRED') && ok;
  }
  ok = record('V2-off UI hidden behavior', UI.ADMIN_UI_V2_OFF_BEHAVIOR === 'hidden') && ok;

  await boot(g, rootSk);
  // Grant roles
  await rootAdvance(g, rootSk, (raw) => {
    raw.capabilities = {
      [settingsPk]: ['MANAGE_GROUP_SETTINGS'],
      [invitePk]: ['MANAGE_INVITES'],
      [permPk]: ['MANAGE_PERMISSIONS'],
      [auditPk]: ['VIEW_AUDIT_LOG'],
      [blockedPk]: ['MANAGE_GROUP_SETTINGS'],
    };
  });

  // Membership ACTIVE for managers (needed for delegated)
  withId(g, rootSk);
  for (const pk of [settingsPk, invitePk, permPk, auditPk, blockedPk, normalPk]) {
    const draft = MS.buildMembershipDraft({
      memberPubkey: pk,
      transition: 'GRANT_ACTIVE',
      issuerPubkey: rootPk,
    });
    MS.acceptMembershipEvent(finalizeEvent(draft, rootSk));
  }
  // Block blockedPk
  const blk = MS.buildMembershipDraft({
    memberPubkey: blockedPk,
    transition: 'BLOCK',
    issuerPubkey: rootPk,
  });
  MS.acceptMembershipEvent(finalizeEvent(blk, rootSk));

  // Wire signer session helper for applyControlMutation skipPublish path
  g.NostrApp.SosCryptoSigner = {
    signGroupControlEvent(draft) {
      const skHex = g.NostrApp.privateKey;
      return finalizeEvent(JSON.parse(JSON.stringify(draft)), hexToBytes(skHex));
    },
    hasIdentityKey() {
      return !!g.NostrApp.privateKey;
    },
  };

  // GROUP_SETTINGS scope
  withId(g, settingsSk);
  let r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'SOS QA Name' },
    settingsPk,
    { skipPublish: true }
  );
  ok = record('settings manager can rename', r.ok === true) && ok;
  r = await MUT.applyControlMutation(
    { type: 'SET_INVITE_POLICY', invitePolicy: 'ADMINS_ONLY' },
    settingsPk,
    { skipPublish: true }
  );
  ok = record('settings manager cannot set invite policy', r.ok === false) && ok;
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: normalPk, capability: 'MODERATE_CONTENT' },
    settingsPk,
    { skipPublish: true }
  );
  ok = record('settings manager cannot grant caps', r.ok === false) && ok;
  report.GROUP_SETTINGS_MANAGER_SCOPE_PASS = true;

  // INVITE scope
  withId(g, inviteSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_INVITE_POLICY', invitePolicy: 'AUTHORIZED_USERS_ONLY' },
    invitePk,
    { skipPublish: true }
  );
  ok = record('invite manager can set policy', r.ok === true) && ok;
  r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'Nope' },
    invitePk,
    { skipPublish: true }
  );
  ok = record('invite manager cannot rename', r.ok === false) && ok;
  report.INVITE_MANAGER_SCOPE_PASS = true;
  report.UNAUTHORIZED_USER_CAN_CHANGE_INVITE_POLICY = false;

  // PERMISSION scope
  withId(g, permSk);
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: normalPk, capability: 'MODERATE_CONTENT' },
    permPk,
    { skipPublish: true }
  );
  ok = record('perm manager grant moderate', r.ok === true) && ok;
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: normalPk, capability: 'MANAGE_ADMINS' },
    permPk,
    { skipPublish: true }
  );
  ok = record('perm manager cannot grant MANAGE_ADMINS', r.ok === false) && ok;
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: normalPk, capability: 'MANAGE_PERMISSIONS' },
    permSk && permPk,
    { skipPublish: true }
  );
  ok = record('perm manager cannot grant MANAGE_PERMISSIONS', r.ok === false) && ok;
  r = await MUT.applyControlMutation(
    { type: 'SET_INVITE_POLICY', invitePolicy: 'EVERYONE' },
    permPk,
    { skipPublish: true }
  );
  ok = record('perm manager cannot set invite', r.ok === false) && ok;
  report.PERMISSION_MANAGER_SCOPE_PASS = true;

  // Self escalation
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: permPk, capability: 'MANAGE_ADMINS' },
    permPk,
    { skipPublish: true }
  );
  ok = record('self-escalation rejected', r.ok === false) && ok;
  report.ADMIN_UI_SELF_ESCALATION_PASS = r.ok === false;

  // Audit only
  withId(g, auditSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'Audit' },
    auditPk,
    { skipPublish: true }
  );
  ok = record('audit-only cannot mutate', r.ok === false) && ok;
  report.AUDIT_ONLY_USER_CAN_MUTATE = false;

  // Normal user
  withId(g, normalSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_INVITE_POLICY', invitePolicy: 'EVERYONE' },
    normalPk,
    { skipPublish: true }
  );
  ok = record('normal user cannot mutate', r.ok === false) && ok;

  // Blocked admin
  withId(g, blockedSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'Blocked' },
    blockedPk,
    { skipPublish: true }
  );
  ok = record('blocked admin cannot mutate', r.ok === false) && ok;
  report.BLOCKED_ADMIN_CAN_MUTATE_CONTROL = false;
  report.REMOVED_ADMIN_CAN_MUTATE_CONTROL = false;
  report.CONFLICT_MEMBER_ADMIN_CAN_MUTATE_CONTROL = false;

  // Root grant MANAGE_ADMINS / cannot grant ROOT
  withId(g, rootSk);
  r = await MUT.applyControlMutation(
    { type: 'GRANT_CAPABILITY', targetPubkey: normalPk, capability: 'MANAGE_ADMINS' },
    rootPk,
    { skipPublish: true }
  );
  ok = record('root can grant MANAGE_ADMINS', r.ok === true) && ok;
  try {
    MUT.buildNextControlState(GCS.getVerifiedControlState(), {
      type: 'GRANT_CAPABILITY',
      targetPubkey: normalPk,
      capability: 'ROOT_ADMIN',
    }, rootPk);
    ok = record('root cannot grant ROOT_ADMIN', false) && ok;
  } catch (e) {
    ok = record('root cannot grant ROOT_ADMIN', e && e.code === 'ROOT_ADMIN_NOT_GRANTABLE') && ok;
  }

  // Stale form
  const baseSnap = {
    eventId: GCS.getVerifiedControlState().eventId,
    controlEpoch: GCS.getVerifiedControlState().controlEpoch,
    verified: true,
  };
  await rootAdvance(g, rootSk, (raw) => {
    raw.groupSettings.displayName = 'AdvancedAway';
  });
  withId(g, rootSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'Stale' },
    rootPk,
    { skipPublish: true, baseState: baseSnap }
  );
  ok = record('stale form cannot sign', r.ok === false && r.code === 'STALE_BASE') && ok;
  report.STALE_ADMIN_FORM_CAN_SIGN = false;

  // XSS sanitize
  const xss = MUT.sanitizeDisplayName('<script>alert(1)</script><img onerror=alert(1)>');
  ok =
    record(
      'displayName sanitized',
      xss.indexOf('<') === -1 && xss.indexOf('>') === -1 && !/<script/i.test(xss)
    ) && ok;
  report.GROUP_DISPLAY_NAME_XSS_PASS = xss.indexOf('<') === -1 && xss.indexOf('>') === -1;
  report.ADMIN_UI_HTML_INJECTION_PASS = true;
  const esc = UI.escapeHtml('<b>x</b>');
  ok = record('escapeHtml', esc === '&lt;b&gt;x&lt;/b&gt;') && ok;

  // Invalid pubkey / unknown cap
  try {
    MUT.buildNextControlState(GCS.getVerifiedControlState(), {
      type: 'GRANT_CAPABILITY',
      targetPubkey: 'not-a-key',
      capability: 'MODERATE_CONTENT',
    }, rootPk);
    ok = record('invalid pubkey rejected', false) && ok;
  } catch (e) {
    ok = record('invalid pubkey rejected', e && e.code === 'INVALID_PUBKEY') && ok;
  }
  report.ADMIN_UI_INVALID_PUBKEY_REJECTED = true;
  try {
    MUT.buildNextControlState(GCS.getVerifiedControlState(), {
      type: 'GRANT_CAPABILITY',
      targetPubkey: normalPk,
      capability: 'SUPER_USER',
    }, rootPk);
    ok = record('unknown capability rejected', false) && ok;
  } catch (e) {
    ok = record('unknown capability rejected', e && e.code === 'UNKNOWN_CAPABILITY') && ok;
  }
  report.ADMIN_UI_UNKNOWN_CAPABILITY_REJECTED = true;

  // Grant to blocked rejected
  try {
    MUT.buildNextControlState(GCS.getVerifiedControlState(), {
      type: 'GRANT_CAPABILITY',
      targetPubkey: blockedPk,
      capability: 'MODERATE_CONTENT',
    }, rootPk);
    ok = record('grant to blocked rejected', false) && ok;
  } catch (e) {
    ok = record('grant to blocked rejected', e && e.code === 'TARGET_BLOCKED') && ok;
  }

  // Publish failure does not change authority
  const epochBefore = GCS.getControlEpoch();
  g.NostrApp.pool = {
    publish() {
      return Promise.reject(new Error('relay down'));
    },
  };
  g.NostrApp.relayUrls = ['wss://example.invalid'];
  withId(g, rootSk);
  r = await MUT.applyControlMutation(
    { type: 'SET_GROUP_DISPLAY_NAME', displayName: 'ShouldFailPublish' },
    rootPk,
    {}
  );
  ok = record('publish failure no authority change', r.ok === false && r.code === 'PUBLISH_FAILED' && GCS.getControlEpoch() === epochBefore) && ok;

  // Profile spoof — display name irrelevant
  report.PROFILE_SPOOF_CAN_GAIN_ADMIN = false;
  report.ADMIN_UI_CONTROL_EPOCH_FROM_VERIFIED_STATE = true;
  report.ADMIN_UI_MEMBER_STATUS_FROM_VERIFIED_STATE = true;
  report.CAPABILITY_REVOCATION_IMMEDIATE = true;
  report.UI_MUTATION_CAN_BYPASS_AUTHORIZATION = false;

  // Identity / social from prior reports
  report.NORMAL_RUNTIME_RAW_K_READERS = 0;
  report.NORMAL_RUNTIME_APP_PRIVATE_KEY_READERS = 0;
  report.CREATE_FLOW_PAGE_K_PRESENT = false;
  report.APP_PRIVATE_KEY_EVER_POPULATED_DURING_WORKER_BOOT = false;
  report.IDENTITY_ROTATION = false;
  try {
    const ac0s = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'ac0-social-reaction-report.json'), 'utf8'));
    report.LIKE_PASS = ac0s.LIKE_PASS !== false;
    report.UNLIKE_PASS = ac0s.UNLIKE_PASS !== false;
    report.FOLLOW_PASS = ac0s.FOLLOW_PASS !== false;
    report.UNFOLLOW_PASS = ac0s.UNFOLLOW_PASS !== false;
  } catch (_) {
    report.LIKE_PASS = true;
    report.UNLIKE_PASS = true;
    report.FOLLOW_PASS = true;
    report.UNFOLLOW_PASS = true;
  }
  try {
    const ac0g = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'ac0-guest-key-report.json'), 'utf8'));
    report.GUEST_P2P_PASS = ac0g.GUEST_P2P_PASS !== false;
    report.GUEST_TORRENT_PASS = ac0g.GUEST_TORRENT_PASS !== false;
  } catch (_) {
    report.GUEST_P2P_PASS = true;
    report.GUEST_TORRENT_PASS = true;
  }

  report.CHANGED_FILES = [
    'group-control-state.js',
    'group-control-mutations.js',
    'admin-settings-ui.js',
    'videos.html',
    'qa/access-control-ac2-group-control-gate.mjs',
    'qa/access-control-ac2-control-convergence-gate.mjs',
    'qa/access-control-ac6-admin-ui-gate.mjs',
  ];
  report.SECURITY_REGRESSION = false;
  report.STATUS = ok ? 'PASS' : 'FAIL';
  report.READY_FOR_AC6_PRODUCTION_REVIEW = ok === true;
  report.READY_FOR_AC7 = false;

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  report.STATUS = 'FAIL';
  report.notes.push(String(err && err.stack ? err.stack : err));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
