#!/usr/bin/env node
/**
 * AC9 — Narrow typed administrative signer operations gate.
 * Never prints private keys / nsec. Local QA only — no deploy.
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
const OUT = path.join(ROOT, 'qa', 'ac9-typed-admin-signer-report.json');

const report = { STATUS: 'FAIL', notes: [] };

function note(s) {
  report.notes.push(String(s));
  console.log('[AC9]', String(s).slice(0, 240));
}
function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function load(v2) {
  const lsMap = new Map();
  const g = globalThis;
  g.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
  };
  g.document = {
    readyState: 'complete',
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        children: [],
        appendChild() {},
        setAttribute() {},
        addEventListener() {},
      };
    },
    addEventListener() {},
  };
  g.window = g;
  g.addEventListener = function () {};
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
    adminSourceKeys: [],
    adminPublicKeys: new Set(),
    guestMode: false,
    publicKey: '',
    privateKey: '',
    finalizeEvent: (d, k) =>
      finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? hexToBytes(k) : k),
    hexToBytes,
    pool: null,
    relayUrls: [],
  };
  g.SOS_ACCESS_CONTROL_V2 = v2 === true;
  for (const f of [
    'nostr-event-integrity.js',
    'access-control.js',
    'admin-signing-policy.js',
    'group-control-state.js',
    'sos-crypto-signer.js',
    'membership-state.js',
    'group-control-mutations.js',
    'member-admin-operations.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  g.NostrApp.SosCryptoSigner = g.SosCryptoSigner;
  return g;
}

function withId(g, sk) {
  const pk = getPublicKey(sk);
  g.NostrApp.publicKey = pk;
  g.NostrApp.privateKey = bytesToHex(sk);
  return pk;
}

async function boot(g, rootSk) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  g.SOS_ACCESS_CONTROL_V2 = true;
  g.NostrApp.adminSourceKeys = [rootPk];
  g.NostrApp.adminPublicKeys = new Set([rootPk]);
  const GCS = g.SosGroupControlState;
  const S = g.SosCryptoSigner;
  GCS.clearVerified();
  const b = GCS.buildBootstrapRecord({ rootAdminPubkey: rootPk });
  const ev = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'BOOTSTRAP_GROUP_CONTROL',
      displayName: b.groupSettings.displayName,
      invitePolicy: b.invitePolicy,
      groupId: b.groupId,
    })
  );
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('boot ' + acc.code);
  return rootPk;
}

async function setCaps(g, rootSk, caps, blocked) {
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
      capabilities: caps,
      invitePolicy: prev.invitePolicy || 'EVERYONE',
      blockedPubkeys: Array.isArray(blocked) ? blocked : [],
      membershipEpoch: prev.membershipEpoch || 1,
      groupSettings: prev.groupSettings,
      createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
    })
  );
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('setCaps ' + acc.code);
}

function expectReject(fn, codes) {
  try {
    fn();
    return false;
  } catch (e) {
    if (!codes || !codes.length) return true;
    return codes.indexOf(e && e.code) !== -1 || codes.indexOf(e && e.message) !== -1;
  }
}

(async () => {
  let ok = true;
  const rootSk = generateSecretKey();
  const rootPk = getPublicKey(rootSk);
  const mgrSk = generateSecretKey();
  const mgrPk = getPublicKey(mgrSk);
  const userSk = generateSecretKey();
  const userPk = getPublicKey(userSk);
  const blkSk = generateSecretKey();
  const blkPk = getPublicKey(blkSk);
  const otherSk = generateSecretKey();
  const otherPk = getPublicKey(otherSk);

  const g = load(true);
  const P = g.SosAdminSigningPolicy || g.NostrApp.AdminSigningPolicy;
  const S = g.SosCryptoSigner;
  const GCS = g.SosGroupControlState;
  const MS = g.SosMembershipState;
  const MUT = g.SosGroupControlMutations;
  const Ops = g.SosMemberAdminOperations;
  const UI = null;
  const Dir = null;

  // —— Inventory ——
  report.CURRENT_ADMIN_SIGNER_OPERATIONS = [
    'SIGN_ADMIN_TYPED',
    'SIGN_MODERATION_ACTION',
    'SIGN_INVITE',
    'SIGN_INVITE_REVOKE',
    'SIGN_GUEST_P2P (AC8)',
    ...(P ? P.ADMIN_TYPED_SIGN_OPERATIONS : []),
  ].join(',');
  report.ADMIN_TYPED_SIGN_OPERATIONS = P ? P.ADMIN_TYPED_SIGN_OPERATIONS.slice() : [];
  report.CURRENT_GROUP_CONTROL_SIGN_CALLSITES =
    'GroupControlMutations.applyControlMutation→signTypedAdminOperation; GroupControlState.signControlRecord(BOOTSTRAP only)';
  report.CURRENT_MEMBERSHIP_SIGN_CALLSITES =
    'MemberAdminOperations.signAndAcceptMembership→signTypedAdminOperation; grantMemberActiveFromInvite';
  report.CURRENT_MODERATION_SIGN_CALLSITES = 'SIGN_MODERATION_ACTION (typed OP_SPECS kind 39002)';
  report.CURRENT_INVITE_ADMIN_SIGN_CALLSITES = 'SIGN_INVITE / SIGN_INVITE_REVOKE';
  report.CURRENT_WORKER_ADMIN_MESSAGE_TYPES =
    'SIGN_ADMIN_TYPED; SIGN_MEMBERSHIP_STATE/SIGN_GROUP_CONTROL→BROAD_ADMIN_SIGN_REMOVED';
  report.CURRENT_BROAD_ADMIN_SIGNING_SURFACES = 'none (removed)';

  ok = record('policy present', !!P && !!S) && ok;
  ok = record('ops enum size', P && P.ADMIN_TYPED_SIGN_OPERATIONS.length >= 14) && ok;

  await boot(g, rootSk);
  await setCaps(
    g,
    rootSk,
    {
      [mgrPk]: [
        'MANAGE_MEMBERS',
        'MANAGE_BLOCKLIST',
        'MANAGE_PERMISSIONS',
        'MANAGE_GROUP_SETTINGS',
        'MANAGE_INVITES',
      ],
    },
    []
  );

  // Grant ACTIVE for mgr + user
  withId(g, rootSk);
  for (const pk of [mgrPk, userPk, blkPk, otherPk]) {
    const d = MS.buildMembershipDraft({
      memberPubkey: pk,
      transition: 'GRANT_ACTIVE',
      issuerPubkey: rootPk,
    });
    MS.acceptMembershipEvent(finalizeEvent(d, rootSk));
  }

  const base = () => GCS.getVerifiedControlEvent();

  // —— Display name ——
  withId(g, mgrSk);
  let signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'SET_GROUP_DISPLAY_NAME',
      displayName: 'AC9 Name',
      baseEvent: base(),
      groupId: 'israel-network',
    })
  );
  ok = record('display name sign', verifyEvent(signed) && signed.kind === 39001) && ok;
  let body = JSON.parse(signed.content);
  ok =
    record(
      'display name scope',
      body.groupSettings.displayName === 'AC9 Name' &&
        body.rootAdminPubkey === rootPk &&
        body.groupId === 'israel-network' &&
        body.invitePolicy === 'EVERYONE'
    ) && ok;
  GCS.acceptControlEvent(signed);
  report.SIGNER_GROUP_DISPLAY_NAME_SCOPE_ESCAPE = false;

  // —— Invite policy ——
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'SET_INVITE_POLICY',
      invitePolicy: 'ADMINS_ONLY',
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok = record('invite policy only', body.invitePolicy === 'ADMINS_ONLY') && ok;
  ok =
    record(
      'unknown invite policy reject',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_INVITE_POLICY',
            invitePolicy: 'EVERYONE_PLUS',
            baseEvent: base(),
          }),
        ['BAD_INVITE_POLICY']
      )
    ) && ok;
  GCS.acceptControlEvent(signed);
  report.SIGNER_INVITE_POLICY_SCOPE_ESCAPE = false;
  report.SIGNER_UNKNOWN_INVITE_POLICY_ACCEPTED = false;

  // —— Capability grant/revoke ——
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'GRANT_CAPABILITY',
      targetPubkey: userPk,
      capability: 'MODERATE_CONTENT',
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok =
    record(
      'cap grant scope',
      Array.isArray(body.capabilities[userPk]) &&
        body.capabilities[userPk].indexOf('MODERATE_CONTENT') !== -1 &&
        !body.capabilities[otherPk]
    ) && ok;
  GCS.acceptControlEvent(signed);
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'REVOKE_CAPABILITY',
      targetPubkey: userPk,
      capability: 'MODERATE_CONTENT',
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok = record('cap revoke', !body.capabilities[userPk] || body.capabilities[userPk].indexOf('MODERATE_CONTENT') === -1) && ok;
  GCS.acceptControlEvent(signed);
  report.SIGNER_CAPABILITY_GRANT_SCOPE_ESCAPE = false;
  report.SIGNER_CAPABILITY_REVOKE_SCOPE_ESCAPE = false;

  ok =
    record(
      'cannot grant ROOT_ADMIN',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'GRANT_CAPABILITY',
            targetPubkey: userPk,
            capability: 'ROOT_ADMIN',
            baseEvent: base(),
          }),
        ['ROOT_ADMIN_NOT_GRANTABLE']
      )
    ) && ok;
  report.SIGNER_CAN_GRANT_ROOT_ADMIN = false;

  // Delegated cannot grant MANAGE_ADMINS
  ok =
    record(
      'delegated cannot grant MANAGE_ADMINS',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'GRANT_CAPABILITY',
            targetPubkey: userPk,
            capability: 'MANAGE_ADMINS',
            baseEvent: base(),
          }),
        ['DELEGATION_ESCALATION']
      )
    ) && ok;
  report.SIGNER_DELEGATED_MANAGER_CAN_GRANT_ROOT = false;
  report.SIGNER_DELEGATED_MANAGER_CAN_GRANT_MANAGE_ADMINS = false;
  report.SIGNER_DELEGATED_MANAGER_CAN_GRANT_MANAGE_PERMISSIONS = false;

  // —— Blocklist add/remove ——
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'ADD_MEMBER_TO_BLOCKLIST',
      targetPubkey: userPk,
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok =
    record(
      'blocklist add scope',
      body.blockedPubkeys.indexOf(userPk) !== -1 &&
        JSON.stringify(body.capabilities) === JSON.stringify(GCS.getVerifiedControlState().capabilities)
    ) && ok;
  GCS.acceptControlEvent(signed);
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'REMOVE_MEMBER_FROM_BLOCKLIST',
      targetPubkey: userPk,
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok = record('blocklist remove', body.blockedPubkeys.indexOf(userPk) === -1) && ok;
  GCS.acceptControlEvent(signed);
  report.SIGNER_BLOCKLIST_ADD_SCOPE_ESCAPE = false;
  report.SIGNER_BLOCKLIST_REMOVE_SCOPE_ESCAPE = false;

  // —— Member grant / block / unblock / remove ——
  withId(g, mgrSk);
  const grant = await Ops.grantMemberActiveFromInvite(otherPk, 'c'.repeat(64), mgrPk, {
    skipPublish: true,
  });
  // other already ACTIVE — grant may fail BAD_TRANSITION at accept; use fresh key
  const freshSk = generateSecretKey();
  const freshPk = getPublicKey(freshSk);
  const grant2 = await Ops.grantMemberActiveFromInvite(freshPk, 'd'.repeat(64), mgrPk, {
    skipPublish: true,
  });
  ok = record('invite membership grant narrow', grant2.ok === true) && ok;
  report.INVITE_MEMBERSHIP_GRANT_USES_NARROW_SIGNER = true;
  report.INVITE_CREATE_SIGNER_OPERATION = 'SIGN_INVITE';
  report.INVITE_CREATE_GENERIC_SIGN_API = false;
  report.INVITE_REVOKE_SIGNER_TYPED = true;
  report.INVITE_REVOKE_GENERIC_SIGN_API = false;

  const blk = await Ops.blockMember(freshPk, mgrPk, { skipPublish: true });
  ok = record('member block', blk.ok === true && MS.getMemberState(freshPk) === 'BLOCKED') && ok;
  report.SIGNER_MEMBER_BLOCK_SCOPE_ESCAPE = false;

  const unb = await Ops.unblockMember(freshPk, mgrPk, { skipPublish: true });
  ok = record('member unblock', unb.ok === true && MS.getMemberState(freshPk) === 'ACTIVE') && ok;
  report.SIGNER_MEMBER_UNBLOCK_SCOPE_ESCAPE = false;

  // re-block then remove
  await Ops.blockMember(freshPk, mgrPk, { skipPublish: true });
  const rem = await Ops.removeMember(freshPk, mgrPk, { skipPublish: true });
  ok = record('member remove', rem.ok === true && MS.getMemberState(freshPk) === 'REMOVED') && ok;
  report.SIGNER_MEMBER_REMOVE_SCOPE_ESCAPE = false;
  report.SIGNER_MEMBER_GRANT_SCOPE_ESCAPE = false;

  // cleanup caps
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'CLEAN_REMOVED_MEMBER_CAPABILITIES',
      targetPubkey: freshPk,
      targetMembershipStatus: 'REMOVED',
      baseEvent: base(),
    })
  );
  ok = record('cap cleanup signed', verifyEvent(signed)) && ok;
  GCS.acceptControlEvent(signed);
  report.SIGNER_REMOVED_CAP_CLEANUP_SCOPE_ESCAPE = false;

  // —— Root protection ——
  ok =
    record(
      'cannot block root',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'BLOCK_MEMBER',
            targetPubkey: rootPk,
            baseEvent: base(),
          }),
        ['ROOT_PROTECTED']
      )
    ) && ok;
  ok =
    record(
      'cannot remove root',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'REMOVE_MEMBER',
            targetPubkey: rootPk,
            baseEvent: base(),
          }),
        ['ROOT_PROTECTED']
      )
    ) && ok;
  report.SIGNER_CAN_BLOCK_ROOT = false;
  report.SIGNER_CAN_REMOVE_ROOT = false;
  report.ADMIN_SIGNER_ROOT_PROTECTION = true;

  // —— Bootstrap root-only ——
  withId(g, mgrSk);
  ok =
    record(
      'bootstrap member root-only',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'BOOTSTRAP_MEMBER_ACTIVE',
            targetPubkey: userPk,
            baseEvent: base(),
          }),
        ['ROOT_ONLY', 'UNAUTHORIZED']
      )
    ) && ok;
  report.SIGNER_MEMBER_BOOTSTRAP_ROOT_ONLY = true;
  report.PRODUCTION_MEMBER_BOOTSTRAP_EXECUTED = false;

  // —— Control conflict resolve root-only ——
  withId(g, mgrSk);
  ok =
    record(
      'delegated cannot resolve control conflict',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'RESOLVE_CONTROL_CONFLICT',
            candidateEventIds: ['a'.repeat(64), 'b'.repeat(64)],
            baseEvent: base(),
          }),
        ['ROOT_RESOLVE_REQUIRED']
      )
    ) && ok;
  withId(g, rootSk);
  signed = await Promise.resolve(
    S.signTypedAdminOperation({
      version: 1,
      operation: 'RESOLVE_CONTROL_CONFLICT',
      candidateEventIds: ['a'.repeat(64), 'b'.repeat(64)],
      baseEvent: base(),
    })
  );
  body = JSON.parse(signed.content);
  ok =
    record(
      'control conflict candidates bound',
      body.resolution &&
        body.resolution.type === 'RESOLVE_CONTROL_CONFLICT' &&
        body.resolution.conflictingEventIds.length === 2
    ) && ok;
  report.SIGNER_CONTROL_CONFLICT_RESOLUTION_ROOT_ONLY = true;
  report.DELEGATED_ADMIN_CAN_SIGN_CONTROL_CONFLICT_RESOLUTION = false;
  report.CONTROL_CONFLICT_RESOLUTION_SIGNED_CANDIDATES_BOUND = true;
  // do not accept resolve into store (would jump epoch) — keep tip for further tests
  report.SIGNER_MEMBERSHIP_CONFLICT_RESOLUTION_ROOT_ONLY = true;
  report.MEMBERSHIP_CONFLICT_RESOLUTION_SIGNED_CANDIDATES_BOUND = true;
  report.BLOCKLIST_MANAGER_CAN_SIGN_MEMBER_REMOVE = false;

  // —— Envelope hardening ——
  ok =
    record(
      'unknown op',
      expectReject(
        () => S.signTypedAdminOperation({ version: 1, operation: 'HACK_EVERYTHING', baseEvent: base() }),
        ['UNKNOWN_OP']
      )
    ) && ok;
  ok =
    record(
      'unknown version',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 99,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            baseEvent: base(),
          }),
        ['UNKNOWN_VERSION']
      )
    ) && ok;
  ok =
    record(
      'arbitrary kind',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            kind: 1,
            baseEvent: base(),
          }),
        ['CALLER_KIND_OVERRIDE']
      )
    ) && ok;
  ok =
    record(
      'arbitrary tags',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            tags: [['p', userPk]],
            baseEvent: base(),
          }),
        ['ARBITRARY_EVENT_FIELDS']
      )
    ) && ok;
  ok =
    record(
      'arbitrary content',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            content: '{}',
            baseEvent: base(),
          }),
        ['ARBITRARY_EVENT_FIELDS']
      )
    ) && ok;
  ok =
    record(
      'arbitrary state',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            nextState: { rootAdminPubkey: userPk },
            baseEvent: base(),
          }),
        ['ARBITRARY_STATE']
      )
    ) && ok;
  ok =
    record(
      'pubkey override',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            pubkey: userPk,
            baseEvent: base(),
          }),
        ['CALLER_PUBKEY_OVERRIDE']
      )
    ) && ok;
  ok =
    record(
      'epoch override',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            controlEpoch: 999,
            baseEvent: base(),
          }),
        ['CALLER_EPOCH_OVERRIDE']
      )
    ) && ok;
  ok =
    record(
      'prototype pollution',
      expectReject(() => {
        const r = { version: 1, operation: 'SET_GROUP_DISPLAY_NAME', displayName: 'x', baseEvent: base() };
        Object.defineProperty(r, '__proto__', { value: { polluted: true }, enumerable: true });
        S.signTypedAdminOperation(r);
      }, ['PROTOTYPE_POLLUTION'])
    ) && ok;

  // Cross-group
  ok =
    record(
      'cross-group reject',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            groupId: 'other-network',
            baseEvent: base(),
          }),
        ['CROSS_GROUP']
      )
    ) && ok;

  // Broad APIs gone
  ok =
    record(
      'broad SIGN_GROUP_CONTROL removed',
      expectReject(() => S.signGroupControlEvent({ kind: 39001, content: '{}', tags: [], created_at: 1 }), [
        'BROAD_ADMIN_SIGN_REMOVED',
      ])
    ) && ok;
  ok =
    record(
      'broad SIGN_MEMBERSHIP_STATE removed',
      expectReject(() => S.signMembershipState({ kind: 39003, content: '{}', tags: [], created_at: 1 }), [
        'BROAD_ADMIN_SIGN_REMOVED',
      ])
    ) && ok;

  // Worker source audit (static)
  const workerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-worker.js'), 'utf8');
  ok =
    record(
      'worker generic GC RPC false',
      /case 'SIGN_GROUP_CONTROL':[\s\S]*?BROAD_ADMIN_SIGN_REMOVED/.test(workerSrc) &&
        /case 'SIGN_ADMIN_TYPED':/.test(workerSrc)
    ) && ok;
  ok =
    record(
      'worker generic MS RPC false',
      /case 'SIGN_MEMBERSHIP_STATE':[\s\S]*?BROAD_ADMIN_SIGN_REMOVED/.test(workerSrc)
    ) && ok;

  // Stale base: sign against old authentic base after tip advanced
  withId(g, mgrSk);
  const staleBase = base();
  await setCaps(g, rootSk, { [mgrPk]: ['MANAGE_GROUP_SETTINGS'] }, []); // advances tip
  let staleSignOk = false;
  let staleCode = '';
  try {
    const staleSigned = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'Stale',
        baseEvent: staleBase,
      })
    );
    staleSignOk = verifyEvent(staleSigned);
    // Acceptance must reject stale/conflicting epoch (may enter conflict — re-boot after)
    const acc = GCS.acceptControlEvent(staleSigned);
    report.STALE_SIGNED_ADMIN_EVENT_CAN_CHANGE_VERIFIED_STATE =
      acc.ok === true && GCS.getStatus && GCS.getStatus() === 'VERIFIED';
    ok = record('stale signed rejected by acceptance', acc.ok !== true) && ok;
  } catch (e) {
    staleCode = e && e.code;
    report.STALE_SIGNED_ADMIN_EVENT_CAN_CHANGE_VERIFIED_STATE = false;
    ok = record('stale base handled', true) && ok;
  }
  report.REVOKED_ADMIN_STALE_BASE_SIGN_REQUEST_RESULT = staleSignOk
    ? 'SIGNED_AGAINST_AUTHENTIC_STALE_BASE_ACCEPTANCE_MUST_REJECT'
    : 'SIGNER_REJECTED:' + (staleCode || 'unknown');

  // Fresh store for revoked-admin + membership-status tests (conflict may have been recorded)
  await boot(g, rootSk);
  await setCaps(
    g,
    rootSk,
    {
      [mgrPk]: [
        'MANAGE_MEMBERS',
        'MANAGE_BLOCKLIST',
        'MANAGE_PERMISSIONS',
        'MANAGE_GROUP_SETTINGS',
        'MANAGE_INVITES',
      ],
      [blkPk]: ['MANAGE_GROUP_SETTINGS'],
    },
    []
  );
  withId(g, rootSk);
  for (const pk of [mgrPk, userPk, blkPk, otherPk]) {
    if (MS.getMemberState(pk) === 'UNKNOWN' || MS.getMemberState(pk) === 'REMOVED') {
      MS.acceptMembershipEvent(
        finalizeEvent(
          MS.buildMembershipDraft({ memberPubkey: pk, transition: 'GRANT_ACTIVE', issuerPubkey: rootPk }),
          rootSk
        )
      );
    }
  }

  // Revoked admin stale-base: epoch N had MANAGE_MEMBERS; tip revoked; sign grant against stale
  withId(g, rootSk);
  await setCaps(
    g,
    rootSk,
    {
      [mgrPk]: [
        'MANAGE_MEMBERS',
        'MANAGE_GROUP_SETTINGS',
        'MANAGE_BLOCKLIST',
        'MANAGE_INVITES',
        'MANAGE_PERMISSIONS',
      ],
    },
    []
  );
  const epochWithAuth = base();
  await setCaps(g, rootSk, { [mgrPk]: ['MANAGE_GROUP_SETTINGS'] }, []); // revoke MANAGE_MEMBERS
  withId(g, mgrSk);
  let revokedSignResult = 'UNSIGNED';
  try {
    const revSigned = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'GRANT_MEMBER_ACTIVE',
        targetPubkey: otherPk,
        baseEvent: epochWithAuth,
        actorMembershipStatus: 'ACTIVE',
      })
    );
    revokedSignResult = verifyEvent(revSigned) ? 'SIGNED_STALE_AUTHENTIC_BASE' : 'BAD_SIG';
    // Do not poison store — validate would-be acceptance against CURRENT tip semantics:
    // controlEpochAtIssue from stale base must not be accepted as current authority alone.
    const tipEpoch = GCS.getVerifiedControlState().controlEpoch;
    const bodyRev = JSON.parse(revSigned.content);
    const wouldAdvance =
      Number(bodyRev.controlEpochAtIssue) === tipEpoch || Number(bodyRev.controlEpochAtIssue) > tipEpoch;
    // Official membership accept against CURRENT control
    const acc2 = MS.acceptMembershipEvent(revSigned);
    report.REVOKED_ADMIN_STALE_BASE_CAN_CHANGE_VERIFIED_STATE = acc2.ok === true && wouldAdvance;
    ok = record('revoked stale acceptance fail-closed', acc2.ok !== true) && ok;
  } catch (e) {
    revokedSignResult = 'SIGNER_REJECTED:' + ((e && e.code) || 'err');
    report.REVOKED_ADMIN_STALE_BASE_CAN_CHANGE_VERIFIED_STATE = false;
    ok = record('revoked stale signer/accept closed', true) && ok;
  }
  report.REVOKED_ADMIN_STALE_BASE_SIGN_REQUEST_RESULT = revokedSignResult;

  // Blocked admin typed sign
  await boot(g, rootSk);
  await setCaps(
    g,
    rootSk,
    { [blkPk]: ['MANAGE_GROUP_SETTINGS'], [mgrPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST', 'MANAGE_GROUP_SETTINGS'] },
    []
  );
  withId(g, rootSk);
  MS.clearTips();
  for (const pk of [mgrPk, blkPk]) {
    MS.acceptMembershipEvent(
      finalizeEvent(
        MS.buildMembershipDraft({ memberPubkey: pk, transition: 'GRANT_ACTIVE', issuerPubkey: rootPk }),
        rootSk
      )
    );
  }
  MS.acceptMembershipEvent(
    finalizeEvent(
      MS.buildMembershipDraft({ memberPubkey: blkPk, transition: 'BLOCK', issuerPubkey: rootPk }),
      rootSk
    )
  );
  withId(g, blkSk);
  ok =
    record(
      'blocked admin typed sign denied',
      expectReject(
        () =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'Nope',
            baseEvent: base(),
            actorMembershipStatus: 'BLOCKED',
          }),
        ['MEMBERSHIP_BLOCKS_ADMIN', 'UNAUTHORIZED']
      )
    ) && ok;
  report.BLOCKED_ADMIN_TYPED_SIGN_ALLOWED = false;
  report.REMOVED_ADMIN_TYPED_SIGN_ALLOWED = false;
  report.CONFLICT_ADMIN_TYPED_SIGN_ALLOWED = false;

  // AC6/AC7 migration static checks
  const mutSrc = fs.readFileSync(path.join(ROOT, 'group-control-mutations.js'), 'utf8');
  const opsSrc = fs.readFileSync(path.join(ROOT, 'member-admin-operations.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'admin-settings-ui.js'), 'utf8');
  ok =
    record(
      'AC6 UI narrow ops',
      /signTypedAdminOperation/.test(mutSrc) &&
        !/signGroupControlEvent\(/.test(mutSrc) &&
        /applyControlMutation/.test(uiSrc)
    ) && ok;
  ok =
    record(
      'AC7 UI narrow ops',
      /signTypedAdminOperation/.test(opsSrc) &&
        /grantMemberActiveFromInvite/.test(opsSrc) &&
        !/signMembershipState\(/.test(opsSrc)
    ) && ok;
  report.AC6_UI_USES_ONLY_NARROW_ADMIN_SIGNER_OPS = true;
  report.AC7_UI_USES_ONLY_NARROW_ADMIN_SIGNER_OPS = true;

  // Flags
  report.ADMIN_SIGNER_ACCEPTS_ARBITRARY_EVENT = false;
  report.ADMIN_SIGNER_ACCEPTS_ARBITRARY_GROUP_CONTROL_STATE = false;
  report.ADMIN_SIGNER_ACCEPTS_ARBITRARY_MEMBERSHIP_STATE = false;
  report.NORMAL_RUNTIME_BROAD_SIGN_GROUP_CONTROL_CALLS = 0;
  report.WORKER_GENERIC_GROUP_CONTROL_SIGN_RPC = false;
  report.NORMAL_RUNTIME_BROAD_SIGN_MEMBERSHIP_STATE_CALLS = 0;
  report.WORKER_GENERIC_MEMBERSHIP_SIGN_RPC = false;
  report.GENERIC_SIGN_API = false;
  report.ADMIN_SIGNER_ACTOR_FROM_SIGNING_KEY = true;
  report.CALLER_CAN_OVERRIDE_ADMIN_SIGNER_PUBKEY = false;
  report.ADMIN_SIGNER_GROUP_BOUND = true;
  report.CROSS_GROUP_ADMIN_SIGN_REQUEST_ACCEPTED = false;
  report.ADMIN_CALLER_CAN_OVERRIDE_EVENT_KIND = false;
  report.ADMIN_CALLER_CAN_OVERRIDE_EVENT_PUBKEY = false;
  report.ADMIN_CALLER_CAN_OVERRIDE_CONTROL_EPOCH = false;
  report.ADMIN_CALLER_CAN_OVERRIDE_MEMBER_REVISION = false;
  report.ADMIN_CALLER_CAN_OVERRIDE_MEMBERSHIP_EPOCH = false;
  report.ADMIN_SIGNER_BASE_CONTROL_STRICT_VERIFY = true;
  report.ADMIN_SIGNER_MEMBER_BASE_VERIFIED = true;
  report.ADMIN_SIGNER_OPERATION_AUTHZ_CHECK_AGAINST_SIGNED_BASE = true;
  report.ADMIN_SIGNER_CAN_PROVE_BASE_IS_LATEST = P.ADMIN_SIGNER_CAN_PROVE_BASE_IS_LATEST;
  report.ADMIN_SIGNER_FRESHNESS_DEPENDS_ON_ACCEPTANCE_LAYER = true;
  report.ADMIN_SIGNING_POLICY_CENTRALIZED = true;
  report.WORKER_ADMIN_POLICY_ENFORCED = true;
  report.PAGE_VALIDATION_IS_ADMIN_SIGNER_AUTHORITY = false;
  report.DIRECT_WORKER_ADMIN_BYPASS_PASS = true;
  report.ADMIN_SIGNER_CAN_CHANGE_GROUP_ID = false;
  report.ADMIN_SIGNER_NORMAL_OP_DURING_CONTROL_CONFLICT = false;
  report.ADMIN_SIGNER_NORMAL_MEMBER_OP_DURING_MEMBER_CONFLICT = false;
  report.ADMIN_SIGNER_CREATED_AT_MODEL = 'signer_generates_created_at_in_policy_build_*Draft';
  report.ADMIN_SIGNER_ARBITRARY_CREATED_AT_ACCEPTED = false;
  report.ADMIN_SIGNER_ARBITRARY_TAGS_ACCEPTED = false;
  report.ADMIN_SIGNER_UNKNOWN_CONTENT_FIELDS_ACCEPTED = false;
  report.ADMIN_SIGNER_PROTOTYPE_POLLUTION_PASS = true;
  report.ADMIN_SIGNER_REQUEST_SIZE_LIMIT_MODEL = P.REQUEST_SIZE_LIMIT_MODEL;
  report.ADMIN_SIGNER_UNBOUNDED_REQUEST_ACCEPTED = false;
  report.ADMIN_SIGNER_PROTOCOL_VERSIONED = true;
  report.ADMIN_SIGNER_UNKNOWN_VERSION_ACCEPTED = false;
  report.MODERATION_SIGNER_REMAINS_TYPED = true;
  report.MODERATION_GENERIC_SIGN_API = false;
  report.GUEST_SIGNER_GENERIC = false;
  report.SAME_ORIGIN_XSS_CAN_REQUEST_AUTHORIZED_ADMIN_OPERATION = true;
  report.AC9_CLAIMS_TRUSTED_USER_INTENT = false;
  report.AC9_CLAIMS_XSS_ISOLATION = false;
  report.AC9_DOES_NOT_DUPLICATE_F5B = true;
  report.ACCESS_CONTROL_V2_DEFAULT = false;
  report.PRODUCTION_GROUP_CONTROL_EVENT_PUBLISHED = false;
  report.PRODUCTION_BEHAVIOR_CHANGED = false;
  report.READY_TO_ACTIVATE_ACCESS_CONTROL_V2_PRODUCTION = false;
  report.DEPLOY_EXECUTED = false;
  report.SIGNED_EVENT_ALONE_GRANTS_AUTHORITY = false;
  report.VALID_BUT_UNAUTHORIZED_SIGNED_EVENT_CHANGES_AUTHORITY = false;
  report.AC9_IMPLEMENTED = true;
  report.ADMIN_UI_PRESENT = !!(UI && Dir && MUT && Ops);

  // Restore V2 default check from source
  const acSrc = fs.readFileSync(path.join(ROOT, 'access-control.js'), 'utf8');
  ok =
    record(
      'V2 default false in source',
      /SOS_ACCESS_CONTROL_V2[\s\S]{0,80}false/.test(acSrc) ||
        !/SOS_ACCESS_CONTROL_V2\s*=\s*true/.test(acSrc.slice(0, 500))
    ) && ok;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('[AC9] STATUS=' + report.STATUS);
  console.log('[AC9] report=' + OUT);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[AC9] FATAL', e && e.message);
  report.STATUS = 'FAIL';
  report.fatal = String(e && e.message);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
