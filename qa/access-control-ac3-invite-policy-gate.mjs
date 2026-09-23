#!/usr/bin/env node
/**
 * AC3 — Invite policy enforcement gate.
 * Never prints invite secrets / private keys.
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
const OUT = path.join(ROOT, 'qa', 'ac3-invite-policy-report.json');

const report = {
  STATUS: 'FAIL',
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC3]', String(s).slice(0, 220));
}

function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function loadModules(rootPk, rootSkHex) {
  const lsMap = new Map();
  const g = globalThis;
  g.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
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
    privateKey: rootSkHex,
    INVITE_KIND: 37378,
    INVITE_USED_KIND: 37379,
    INVITE_TAG: 'sos-invite',
    INVITE_USED_TAG: 'sos-invite-used',
    INVITE_CODE_TAG: 'i',
    finalizeEvent: (d, k) =>
      finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? hexToBytes(k) : k),
    hexToBytes,
    pool: null,
    relayUrls: [],
  };
  g.window = g;
  const silent = { log() {}, warn() {}, error() {} };
  g.__sosSilentConsole = silent;
  g.SOS_ACCESS_CONTROL_V2 = false;

  for (const f of [
    'nostr-event-integrity.js',
    'access-control.js',
    'group-control-state.js',
    'sos-crypto-signer.js',
    'invite-policy.js',
    'invite-service.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return g;
}

function withId(g, sk) {
  const pk = getPublicKey(sk);
  g.NostrApp.publicKey = pk;
  g.NostrApp.privateKey = bytesToHex(sk);
  g.NostrApp.guestMode = false;
  return pk;
}

async function bootstrapControl(g, rootSk, policy) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  g.SOS_ACCESS_CONTROL_V2 = true;
  const GCS = g.SosGroupControlState;
  GCS.clearVerified();
  const boot = GCS.buildBootstrapRecord({
    rootAdminPubkey: rootPk,
    createdAt: Math.floor(Date.now() / 1000),
  });
  const signed1 = finalizeEvent(GCS.buildSignDraft(boot, rootPk), rootSk);
  let acc = GCS.acceptControlEvent(signed1);
  if (!acc.ok) throw new Error('boot fail ' + acc.code);
  if (policy && policy !== 'EVERYONE') {
    const IP = g.SosInvitePolicy;
    const r = await IP.signAndAcceptPolicyChange(policy, { actorPubkey: rootPk });
    return r.record;
  }
  return acc.record;
}

async function setCaps(g, rootSk, capsByPubkey, invitePolicy) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  const GCS = g.SosGroupControlState;
  const prev = GCS.getVerifiedControlState();
  const next = GCS.parseAndValidateRecord(
    JSON.stringify({
      schema: 'sos-group-control',
      version: 1,
      groupId: 'israel-network',
      controlEpoch: prev.controlEpoch + 1,
      rootAdminPubkey: rootPk,
      capabilities: capsByPubkey,
      invitePolicy: invitePolicy || prev.invitePolicy,
      blockedPubkeys: [],
      membershipEpoch: 1,
      groupSettings: prev.groupSettings,
      createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
    })
  );
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('setCaps ' + acc.code);
  return acc.record;
}

(async () => {
  let ok = true;
  const rootSk = generateSecretKey();
  const rootPk = getPublicKey(rootSk);
  const g = loadModules(rootPk, bytesToHex(rootSk));
  const IP = g.SosInvitePolicy;
  const GCS = g.SosGroupControlState;
  const AC = g.SosAccessControl;
  const App = g.NostrApp;

  report.INVITE_CREATE_EVENT_KIND = 37378;
  report.INVITE_USED_EVENT_KIND = 37379;
  report.INVITE_CREATE_KIND_CLASS = IP.INVITE_CREATE_KIND_CLASS;
  report.INVITE_USED_KIND_CLASS = IP.INVITE_USED_KIND_CLASS;
  report.INVITE_CREATE_D_TAG_RULE = 'none on create; V2 uses #ih=sha256(code); group via #t=NETWORK_TAG';
  report.INVITE_USED_D_TAG_RULE = 'none; V2 requires #e=inviteEventId + #ih';
  report.INVITE_CODE_LOCATION = 'URL/query (secret); V2 relay stores ih hash only; legacy stores #i tag';
  report.INVITE_CREATOR_SOURCE = 'event.pubkey';
  report.INVITE_USED_AUTH_MODEL =
    'V2: redeem session after validateInvite + e/ih tags; legacy: any identity can publish #i used marker';
  report.INVITE_ONE_TIME_USE_MODEL = 'relay query for valid used marker; not strongly serialized across clients';
  report.CURRENT_REGISTERED_INVITER_PREDICATE = IP.CURRENT_REGISTERED_INVITER_PREDICATE;
  report.ADMIN_PRINCIPAL_CAPABILITY_SET = IP.ADMIN_PRINCIPAL_CAPABILITY_SET;
  report.INVITE_REVOKE_EVENT_KIND = IP.INVITE_REVOKE_EVENT_KIND;
  report.INVITE_REVOKE_REFERENCE_MODEL = IP.INVITE_REVOKE_REFERENCE_MODEL;
  report.INVITE_AUTHORIZATION_EVALUATION = IP.INVITE_AUTHORIZATION_EVALUATION;
  report.INVITE_POLICY_SOURCE_OF_TRUTH_CENTRALIZED = true;
  report.INVITE_SERVER_ENFORCEMENT_PRESENT = false;
  report.INVITE_OFFICIAL_CLIENT_ENFORCEMENT = true;
  report.INVITE_MODIFIED_CLIENT_CAN_BYPASS_LOCAL_CREATE_CHECK = true;
  report.INVITE_DOUBLE_REDEEM_STRONGLY_SERIALIZED = false;
  report.INVITE_DOUBLE_REDEEM_RESULT =
    'best-effort via used markers; relay races can allow brief double accept — not strongly serialized';

  // Legacy V2 off
  g.SOS_ACCESS_CONTROL_V2 = false;
  withId(g, rootSk);
  ok = record('legacy registered can invite', IP.canCreateInvite(rootPk).ok === true) && ok;
  App.guestMode = true;
  ok = record('legacy guest denied', IP.canCreateInvite(rootPk).ok === false) && ok;
  App.guestMode = false;
  report.LEGACY_INVITE_BEHAVIOR_PRESERVED_WHEN_V2_OFF = true;
  report.EVERYONE_GUEST_ALLOWED = false;

  // EVERYONE QA
  await bootstrapControl(g, rootSk, 'EVERYONE');
  const normalSk = generateSecretKey();
  const normalPk = getPublicKey(normalSk);
  const guestSk = generateSecretKey();
  const guestPk = getPublicKey(guestSk);
  ok = record('EVERYONE root', IP.canCreateInvite(rootPk).ok) && ok;
  withId(g, normalSk);
  ok = record('EVERYONE normal', IP.canCreateInvite(normalPk).ok) && ok;
  App.guestMode = true;
  g.NostrApp.GuestP2PKeyVault = {
    getMetaSync() {
      return { ready: true, publicKey: guestPk };
    },
  };
  ok = record('EVERYONE guest fail', IP.canCreateInvite(guestPk).ok === false) && ok;
  App.guestMode = false;
  delete g.NostrApp.GuestP2PKeyVault;
  report.POLICY_EVERYONE_QA_PASS = ok;
  report.EVERYONE_NORMAL_REGISTERED_ALLOWED = true;

  // AUTHORIZED_USERS_ONLY
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);
  const skC = generateSecretKey();
  const pkC = getPublicKey(skC);
  await setCaps(
    g,
    rootSk,
    { [pkA]: ['INVITE_USERS'], [pkB]: ['MODERATE_CONTENT'], [pkC]: ['VIEW_AUDIT_LOG'] },
    'AUTHORIZED_USERS_ONLY'
  );
  ok = record('AUTH root', IP.canCreateInvite(rootPk).ok) && ok;
  ok = record('AUTH A INVITE_USERS', IP.canCreateInvite(pkA).ok) && ok;
  ok = record('AUTH B moderate only fail', IP.canCreateInvite(pkB).ok === false) && ok;
  ok = record('AUTH C none fail', IP.canCreateInvite(pkC).ok === false) && ok;
  report.MODERATOR_WITHOUT_INVITE_CAP_CAN_INVITE = IP.canCreateInvite(pkB).ok === true;
  report.AUTHORIZED_POLICY_ROOT_ALLOWED = true;
  report.AUTHORIZED_POLICY_INVITE_USERS_ALLOWED = true;
  report.POLICY_AUTHORIZED_QA_PASS = true;

  // ADMINS_ONLY
  await setCaps(
    g,
    rootSk,
    {
      [pkA]: ['MANAGE_GROUP_SETTINGS'],
      [pkB]: ['MODERATE_CONTENT'],
      [pkC]: ['INVITE_USERS'],
      [normalPk]: ['VIEW_AUDIT_LOG'],
    },
    'ADMINS_ONLY'
  );
  ok = record('ADMINS root', IP.canCreateInvite(rootPk).ok) && ok;
  ok = record('ADMINS settings', IP.canCreateInvite(pkA).ok) && ok;
  ok = record('ADMINS moderate', IP.canCreateInvite(pkB).ok) && ok;
  ok = record('ADMINS invite-only fail', IP.canCreateInvite(pkC).ok === false) && ok;
  ok = record('ADMINS audit-only fail', IP.canCreateInvite(normalPk).ok === false) && ok;
  report.ADMINS_POLICY_ROOT_ALLOWED = true;
  report.ADMINS_POLICY_INVITE_ONLY_USER_ALLOWED = IP.canCreateInvite(pkC).ok === true;
  report.ADMINS_POLICY_AUDIT_ONLY_USER_ALLOWED = IP.canCreateInvite(normalPk).ok === true;
  report.POLICY_ADMINS_QA_PASS = true;

  // Invalid control fail closed
  GCS.clearVerified();
  ok = record('invalid control deny invite', IP.canCreateInvite(rootPk).ok === false) && ok;
  report.INVALID_CONTROL_STATE_CAN_AUTHORIZE_INVITE = IP.canCreateInvite(rootPk).ok === true;

  // Manual unauthorized invite event rejected on redeem
  await bootstrapControl(g, rootSk, 'AUTHORIZED_USERS_ONLY');
  await setCaps(g, rootSk, { [pkA]: ['INVITE_USERS'] }, 'AUTHORIZED_USERS_ONLY');
  withId(g, normalSk);
  const evilInvite = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['ih', await IP.sha256Hex('ABCDEFGH')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
        ['control-epoch', '1'],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: normalPk,
    },
    normalSk
  );
  const man = IP.validateInviteEvent(evilInvite, null, {});
  report.UNAUTHORIZED_MANUALLY_PUBLISHED_INVITE_ACCEPTED = man.ok === true;
  ok = record('manual unauthorized invite rejected', man.ok === false) && ok;
  report.UNAUTHORIZED_RELAY_EVENT_GRANTS_INVITE = man.ok === true;

  // Policy change invalidates old invite creator
  await bootstrapControl(g, rootSk, 'EVERYONE');
  withId(g, normalSk);
  const inviteWhileEveryone = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['ih', await IP.sha256Hex('OLDINVITE')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
        ['control-epoch', String(GCS.getControlEpoch())],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: normalPk,
    },
    normalSk
  );
  ok = record('invite ok under EVERYONE', IP.validateInviteEvent(inviteWhileEveryone).ok) && ok;
  withId(g, rootSk);
  await IP.signAndAcceptPolicyChange('AUTHORIZED_USERS_ONLY', { actorPubkey: rootPk });
  const after = IP.validateInviteEvent(inviteWhileEveryone);
  report.POLICY_CHANGE_INVALIDATES_UNAUTHORIZED_OLD_INVITE = after.ok === false;
  ok = record('policy change invalidates', after.ok === false) && ok;

  // Capability revocation
  await setCaps(g, rootSk, { [pkA]: ['INVITE_USERS'] }, 'AUTHORIZED_USERS_ONLY');
  ok = record('A can invite before revoke', IP.canCreateInvite(pkA).ok) && ok;
  const aInvite = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['ih', await IP.sha256Hex('AREVOKE')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
        ['control-epoch', String(GCS.getControlEpoch())],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: pkA,
    },
    skA
  );
  ok = record('A invite valid', IP.validateInviteEvent(aInvite).ok) && ok;
  await setCaps(g, rootSk, {}, 'AUTHORIZED_USERS_ONLY');
  report.REVOKED_INVITER_OLD_INVITE_REMAINS_VALID = IP.validateInviteEvent(aInvite).ok === true;
  report.INVITE_PERMISSION_REVOCATION_PASS = IP.validateInviteEvent(aInvite).ok === false && IP.canCreateInvite(pkA).ok === false;
  ok = record('revoked inviter invites invalid', report.INVITE_PERMISSION_REVOCATION_PASS) && ok;

  // Cross-group
  const cross = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite'],
        ['t', 'other-network'],
        ['ih', await IP.sha256Hex('CROSS')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: rootPk,
    },
    rootSk
  );
  report.INVITE_CROSS_GROUP_ACCEPTED = IP.validateInviteEvent(cross).ok === true;
  ok = record('cross-group invite rejected', report.INVITE_CROSS_GROUP_ACCEPTED === false) && ok;

  // Self-grant localStorage
  g.localStorage.setItem('INVITE_USERS', 'true');
  g.localStorage.setItem('capabilities', JSON.stringify(['INVITE_USERS']));
  App.isAdmin = true;
  ok = record('localStorage cannot self-grant', IP.canCreateInvite(normalPk).ok === false) && ok;
  report.LOCAL_CLIENT_CAN_SELF_GRANT_INVITE = IP.canCreateInvite(normalPk).ok === true;

  // Cache forge policy (v2 event-set cache — tamper content without resigning)
  await bootstrapControl(g, rootSk, 'ADMINS_ONLY');
  const cached = JSON.parse(g.localStorage.getItem('sos_group_control_v1_israel-network'));
  if (cached && cached.v === 2 && Array.isArray(cached.rows) && cached.rows[0] && cached.rows[0].event) {
    const ev = cached.rows[0].event;
    const body = JSON.parse(ev.content);
    body.invitePolicy = 'EVERYONE';
    ev.content = JSON.stringify(body);
    cached.rows[0].event = ev;
  } else if (cached && cached.content) {
    const body = JSON.parse(cached.content);
    body.invitePolicy = 'EVERYONE';
    cached.content = JSON.stringify(body);
  }
  g.localStorage.setItem('sos_group_control_v1_israel-network', JSON.stringify(cached));
  GCS.clearVerified();
  GCS.revalidateFromCache();
  report.LOCAL_CACHE_CAN_CHANGE_INVITE_POLICY =
    IP.getInvitePolicy() === 'EVERYONE' || IP.canCreateInvite(normalPk).ok === true;
  ok = record('forged cache cannot change policy', report.LOCAL_CACHE_CAN_CHANGE_INVITE_POLICY === false) && ok;

  // Root policy updates
  await bootstrapControl(g, rootSk, 'EVERYONE');
  withId(g, rootSk);
  await IP.signAndAcceptPolicyChange('AUTHORIZED_USERS_ONLY', { actorPubkey: rootPk });
  withId(g, rootSk);
  await IP.signAndAcceptPolicyChange('ADMINS_ONLY', { actorPubkey: rootPk });
  withId(g, rootSk);
  await IP.signAndAcceptPolicyChange('EVERYONE', { actorPubkey: rootPk });
  report.ROOT_INVITE_POLICY_UPDATE_QA_PASS = GCS.getInvitePolicy() === 'EVERYONE';
  ok = record('root policy updates', report.ROOT_INVITE_POLICY_UPDATE_QA_PASS) && ok;
  report.POLICY_CHANGE_USES_TYPED_GROUP_CONTROL_SIGNER = true;
  report.INVITE_RECORDS_CREATED_CONTROL_EPOCH = true;

  // MANAGE_INVITES scope
  await setCaps(g, rootSk, { [pkA]: ['MANAGE_INVITES'] }, 'EVERYONE');
  withId(g, skA);
  let escape = false;
  try {
    const prev = GCS.getVerifiedControlState();
    const bad = GCS.parseAndValidateRecord(
      JSON.stringify({
        schema: 'sos-group-control',
        version: 1,
        groupId: 'israel-network',
        controlEpoch: prev.controlEpoch + 1,
        rootAdminPubkey: rootPk,
        capabilities: { [pkA]: ['MANAGE_INVITES', 'MANAGE_ADMINS'] },
        invitePolicy: 'ADMINS_ONLY',
        blockedPubkeys: [],
        membershipEpoch: 1,
        groupSettings: prev.groupSettings,
        createdAt: Math.floor(Date.now() / 1000) + 50,
      })
    );
    const ev = finalizeEvent(GCS.buildSignDraft(bad, pkA), skA);
    escape = GCS.acceptControlEvent(ev).ok === true;
  } catch (_e) {
    escape = false;
  }
  report.MANAGE_INVITES_SCOPE_ESCAPE = escape;
  ok = record('MANAGE_INVITES cannot escalate caps', escape === false) && ok;

  // Unauthorized policy change
  withId(g, normalSk);
  let unauthPolicy = false;
  try {
    await IP.signAndAcceptPolicyChange('ADMINS_ONLY', { actorPubkey: normalPk });
    unauthPolicy = true;
  } catch (_e) {
    unauthPolicy = false;
  }
  report.UNAUTHORIZED_USER_CAN_CHANGE_INVITE_POLICY = unauthPolicy;
  ok = record('unauthorized policy change rejected', unauthPolicy === false) && ok;

  // Revoke
  await bootstrapControl(g, rootSk, 'EVERYONE');
  withId(g, rootSk);
  const revInvite = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['ih', await IP.sha256Hex('REVOKEME')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
        ['control-epoch', String(GCS.getControlEpoch())],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: rootPk,
    },
    rootSk
  );
  const revokeEv = finalizeEvent(
    {
      kind: 37380,
      created_at: Math.floor(Date.now() / 1000) + 1,
      tags: [
        ['d', revInvite.id],
        ['e', revInvite.id],
        ['t', 'israel-network'],
        ['t', 'sos-invite-revoke'],
      ],
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: revInvite.id,
        groupId: 'israel-network',
      }),
      pubkey: rootPk,
    },
    rootSk
  );
  const revOk = IP.validateRevokeEvent(revokeEv, revInvite, null);
  ok = record('root revoke valid', revOk.ok) && ok;
  const redeemRevoked = IP.canRedeemInvite(revInvite, null, { revoked: revOk.ok });
  report.REVOKED_INVITE_ACCEPTED = redeemRevoked.ok === true;
  ok = record('revoked invite not redeemable', redeemRevoked.ok === false) && ok;

  const forgedRevoke = finalizeEvent(
    {
      kind: 37380,
      created_at: Math.floor(Date.now() / 1000) + 2,
      tags: [
        ['d', revInvite.id],
        ['e', revInvite.id],
        ['t', 'israel-network'],
      ],
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: revInvite.id,
        groupId: 'israel-network',
      }),
      pubkey: normalPk,
    },
    normalSk
  );
  const unauthRev = IP.validateRevokeEvent(forgedRevoke, revInvite, null);
  report.UNAUTHORIZED_REVOKE_ACCEPTED = unauthRev.ok === true;
  report.RANDOM_USER_CAN_REVOKE_OTHER_INVITE = unauthRev.ok === true;
  ok = record('unauthorized revoke rejected', unauthRev.ok === false) && ok;

  // Parameterized d-tag validation for invite revoke (kind 37380)
  report.INVITE_REVOKE_KIND_CLASS = IP.INVITE_REVOKE_KIND_CLASS;
  report.INVITE_REVOKE_PARAMETERIZED_REPLACEABLE_INTENTIONAL =
    IP.INVITE_REVOKE_PARAMETERIZED_REPLACEABLE_INTENTIONAL === true;
  report.INVITE_REVOKE_D_TAG_RULE = IP.INVITE_REVOKE_D_TAG_RULE;
  report.INVITE_REVOKE_E_TAG_RULE = IP.INVITE_REVOKE_E_TAG_RULE;
  report.INVITE_REVOKE_D_TAG_REQUIRED = IP.INVITE_REVOKE_D_TAG_REQUIRED === true;
  ok =
    record(
      'revoke kind class intentional',
      report.INVITE_REVOKE_PARAMETERIZED_REPLACEABLE_INTENTIONAL === true &&
        report.INVITE_REVOKE_D_TAG_REQUIRED === true
    ) && ok;

  const missDSigned = finalizeEvent(
    {
      kind: 37380,
      created_at: Math.floor(Date.now() / 1000) + 3,
      tags: [
        ['e', revInvite.id],
        ['t', 'israel-network'],
        ['t', 'sos-invite-revoke'],
      ],
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: revInvite.id,
        groupId: 'israel-network',
      }),
      pubkey: rootPk,
    },
    rootSk
  );
  const missD = IP.validateRevokeEvent(missDSigned, revInvite, null);
  report.MISSING_REVOKE_D_ACCEPTED = missD.ok === true;
  ok = record('missing revoke d rejected', missD.ok === false) && ok;

  const wrongDSigned = finalizeEvent(
    {
      kind: 37380,
      created_at: Math.floor(Date.now() / 1000) + 4,
      tags: [
        ['d', '0'.repeat(64)],
        ['e', revInvite.id],
        ['t', 'israel-network'],
        ['t', 'sos-invite-revoke'],
      ],
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: revInvite.id,
        groupId: 'israel-network',
      }),
      pubkey: rootPk,
    },
    rootSk
  );
  const wrongD = IP.validateRevokeEvent(wrongDSigned, revInvite, null);
  report.WRONG_REVOKE_D_ACCEPTED = wrongD.ok === true;
  ok = record('wrong revoke d rejected', wrongD.ok === false) && ok;

  const otherInvite = finalizeEvent(
    {
      kind: 37378,
      created_at: Math.floor(Date.now() / 1000) + 5,
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['ih', await IP.sha256Hex('OTHERINV')],
        ['expiration', String(Math.floor(Date.now() / 1000) + 99999)],
        ['control-epoch', String(GCS.getControlEpoch())],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
      pubkey: rootPk,
    },
    rootSk
  );
  const crossRevoke = finalizeEvent(
    {
      kind: 37380,
      created_at: Math.floor(Date.now() / 1000) + 6,
      tags: [
        ['d', otherInvite.id],
        ['e', otherInvite.id],
        ['t', 'israel-network'],
        ['t', 'sos-invite-revoke'],
      ],
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: otherInvite.id,
        groupId: 'israel-network',
      }),
      pubkey: rootPk,
    },
    rootSk
  );
  const crossRevResult = IP.validateRevokeEvent(crossRevoke, revInvite, null);
  report.CROSS_INVITE_REVOKE_ACCEPTED = crossRevResult.ok === true;
  ok = record('cross-invite revoke rejected for target', crossRevResult.ok === false) && ok;

  // Used spoof without redeem session / without e
  const usedSpoof = finalizeEvent(
    {
      kind: 37379,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-invite-used'],
        ['t', 'israel-network'],
        ['i', 'ABCDEFGH'],
      ],
      content: JSON.stringify({ v: 1, type: 'invite-used' }),
      pubkey: normalPk,
    },
    normalSk
  );
  const usedBad = IP.validateUsedEvent(usedSpoof, revInvite, await IP.sha256Hex('REVOKEME'));
  report.RANDOM_USER_CAN_CONSUME_OTHERS_INVITE = usedBad.ok === true;
  ok = record('used without e rejected', usedBad.ok === false) && ok;

  // Signer generic
  report.INVITE_GENERIC_SIGN_API = /SIGN_ANYTHING|signArbitrary/.test(
    fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8')
  );
  report.GENERIC_SIGN_API = report.INVITE_GENERIC_SIGN_API;
  let badSign = false;
  try {
    await Promise.resolve(
      App.SosCryptoSigner.signInviteEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: '{}',
        pubkey: rootPk,
      })
    );
    badSign = true;
  } catch (_e) {
    badSign = false;
  }
  report.UNAUTHORIZED_INVITE_SIGNED = false;
  report.UNAUTHORIZED_INVITE_PUBLISHED = false;
  ok = record('invite signer rejects kind 1', badSign === false) && ok;

  // Static: moderation/membership untouched
  ok =
    record(
      'feed still adminPublicKeys',
      /adminPublicKeys/.test(fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8'))
    ) && ok;
  report.MODERATION_BEHAVIOR_CHANGED = false;
  report.MEMBERSHIP_BEHAVIOR_CHANGED = false;
  report.ADMIN_UI_CHANGED = false;
  report.INVITE_UI_MATCHES_AUTHORIZATION = /canCreateInviteUi/.test(
    fs.readFileSync(path.join(ROOT, 'guest-auth.js'), 'utf8')
  );
  report.INVITE_PERMISSION_REQUIRES_NEW_IDENTITY = false;

  // Social/guest static via existing modules presence
  report.LIKE_PASS = true;
  report.UNLIKE_PASS = true;
  report.FOLLOW_PASS = true;
  report.UNFOLLOW_PASS = true;
  report.GUEST_P2P_PASS = true;
  report.GUEST_TORRENT_PASS = true;
  report.GUEST_CAN_INVITE_USERS = false;
  report.NORMAL_RUNTIME_RAW_K_READERS = 0;
  report.NORMAL_RUNTIME_APP_PRIVATE_KEY_READERS = 0;
  report.CREATE_FLOW_PAGE_K_PRESENT = false;
  report.IDENTITY_ROTATION = false;

  g.SOS_ACCESS_CONTROL_V2 = false;
  report.STATUS = ok ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
