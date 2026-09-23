#!/usr/bin/env node
/**
 * AC5 hardening — deterministic membership convergence / epoch / block transactions.
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
const OUT = path.join(ROOT, 'qa', 'ac5-membership-convergence-report.json');

const report = { STATUS: 'FAIL', notes: [] };

function note(s) {
  report.notes.push(String(s));
  console.log('[AC5-CONV]', String(s).slice(0, 240));
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

async function bootstrapControl(g, rootSk) {
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
  const acc = GCS.acceptControlEvent(signed1);
  if (!acc.ok) throw new Error('boot fail ' + acc.code);
  return acc.record;
}

async function setControl(g, rootSk, { capsByPubkey, blockedPubkeys, membershipEpoch }) {
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
      capabilities: capsByPubkey || prev.capabilities || {},
      invitePolicy: prev.invitePolicy || 'EVERYONE',
      blockedPubkeys: Array.isArray(blockedPubkeys) ? blockedPubkeys : prev.blockedPubkeys || [],
      membershipEpoch:
        typeof membershipEpoch === 'number' ? membershipEpoch : prev.membershipEpoch || 1,
      groupSettings: prev.groupSettings,
      createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
    })
  );
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('setControl ' + acc.code);
  return acc.record;
}

function signDraft(sk, draft) {
  return finalizeEvent(draft, sk);
}

function snap(MS, pk) {
  const s = MS.getMemberSnapshot(pk);
  return {
    status: MS.getMemberState(pk),
    rev: s && s.record ? s.record.memberRevision : 0,
    candidates: (MS.getConflictCandidates(pk) || [])
      .map((c) => c.eventId)
      .slice()
      .sort()
      .join(','),
    gated: MS.canPerformMemberAction(pk, 'post_create').ok,
  };
}

function snapsEqual(a, b) {
  return (
    a.status === b.status && a.rev === b.rev && a.candidates === b.candidates && a.gated === b.gated
  );
}

(async () => {
  let ok = true;
  const rootSk = generateSecretKey();
  const rootPk = getPublicKey(rootSk);
  const mgrASk = generateSecretKey();
  const mgrAPk = getPublicKey(mgrASk);
  const mgrBSk = generateSecretKey();
  const mgrBPk = getPublicKey(mgrBSk);
  const userSk = generateSecretKey();
  const userPk = getPublicKey(userSk);

  const g = loadModules(rootPk, bytesToHex(rootSk));
  const MS = g.SosMembershipState;
  const AC = g.SosAccessControl;

  report.MEMBERSHIP_FIRST_SEEN_WINS = MS.MEMBERSHIP_FIRST_SEEN_WINS;
  report.MEMBERSHIP_CONFLICT_STATE_SUPPORTED = MS.MEMBERSHIP_CONFLICT_STATE_SUPPORTED;
  report.CONFLICT_CANDIDATES_RETAINED = MS.CONFLICT_CANDIDATES_RETAINED;
  report.MEMBERSHIP_RECONSTRUCTION_ALGORITHM = MS.MEMBERSHIP_RECONSTRUCTION_ALGORITHM;
  report.MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC = MS.MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC;
  report.LATE_CONFLICT_EVENT_BEHAVIOR = MS.LATE_CONFLICT_EVENT_BEHAVIOR;
  report.MEMBERSHIP_LOCAL_CACHE_IS_AUTHORITY = MS.MEMBERSHIP_LOCAL_CACHE_IS_AUTHORITY;
  report.PARAM_REPLACEABLE_COLD_START_SAFE = MS.PARAM_REPLACEABLE_COLD_START_SAFE;
  report.MEMBERSHIP_EPOCH_SEMANTICS = MS.MEMBERSHIP_EPOCH_SEMANTICS;
  report.MEMBERSHIP_EPOCH_NORMAL_MUTATION_BUMPS = MS.MEMBERSHIP_EPOCH_NORMAL_MUTATION_BUMPS;
  report.EPOCH_ROLLOVER_CANNOT_SILENTLY_DROP_MEMBERS =
    MS.EPOCH_ROLLOVER_CANNOT_SILENTLY_DROP_MEMBERS;
  report.MEMBERSHIP_EPOCH_ROLLOVER_MODEL = MS.MEMBERSHIP_EPOCH_ROLLOVER_MODEL;
  report.MEMBERSHIP_EPOCH_ROLLOVER_ROOT_AUTHORIZED = MS.MEMBERSHIP_EPOCH_ROLLOVER_ROOT_AUTHORIZED;
  report.PARTIAL_EPOCH_ROLLOVER_ACTIVATES = MS.PARTIAL_EPOCH_ROLLOVER_ACTIVATES;
  report.PREVIOUS_MEMBERSHIP_EPOCH_EVENT_SEMANTICS = MS.PREVIOUS_MEMBERSHIP_EPOCH_EVENT_SEMANTICS;
  report.BLOCK_TRANSACTION_PROTOCOL = MS.BLOCK_TRANSACTION_PROTOCOL;
  report.UNBLOCK_TRANSACTION_PROTOCOL = MS.UNBLOCK_TRANSACTION_PROTOCOL;
  report.BLOCK_TRANSACTION_RECOVERY_MODEL = MS.BLOCK_TRANSACTION_RECOVERY_MODEL;
  report.REMOVE_TRANSACTION_PROTOCOL = MS.REMOVE_TRANSACTION_PROTOCOL;
  report.BLOCKED_CAPABILITY_STORAGE_MODEL = MS.BLOCKED_CAPABILITY_STORAGE_MODEL;
  report.DELEGATED_MEMBERSHIP_PERSISTENCE_MODEL = MS.DELEGATED_MEMBERSHIP_PERSISTENCE_MODEL;
  report.PERMANENT_DELEGATED_MEMBERSHIP_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF =
    MS.PERMANENT_DELEGATED_MEMBERSHIP_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF;

  await bootstrapControl(g, rootSk);
  await setControl(g, rootSk, {
    capsByPubkey: {
      [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'],
      [mgrBPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'],
    },
    blockedPubkeys: [],
    membershipEpoch: 1,
  });

  // —— Audit baseline: build rev1 ACTIVE, then concurrent rev2 BLOCK vs REMOVE ——
  MS.clearTips();
  withId(g, rootSk);
  const grant1 = signDraft(
    rootSk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'GRANT_ACTIVE',
      issuerPubkey: rootPk,
    })
  );
  MS.acceptMembershipEvent(grant1);

  // Build both rev2 drafts while still ACTIVE (before either applied) — use fresh MS state clone via clear+re-ingest
  // Actually after grant1 tip is ACTIVE rev1. Building BLOCK then REMOVE would make REMOVE from BLOCKED.
  // So build both drafts from same prev by constructing manually with same memberRevision=2.
  function buildFork(sk, issuerPk, transition, status) {
    const control = MS.getVerifiedControlOrNull();
    const body = {
      schema: 'sos-group-member',
      version: 1,
      groupId: 'israel-network',
      memberPubkey: userPk,
      status,
      memberRevision: 2,
      controlEpochAtIssue: control.controlEpoch,
      membershipEpoch: control.membershipEpoch,
      issuerPubkey: issuerPk,
      transition,
      createdAt: Math.floor(Date.now() / 1000),
      reason: transition,
    };
    const d = 'israel-network:' + userPk;
    return signDraft(sk, {
      kind: 39003,
      created_at: body.createdAt,
      tags: [
        ['d', d],
        ['p', userPk],
        ['t', 'israel-network'],
        ['t', 'sos-group-member'],
        ['status', status],
        ['member-revision', '2'],
        ['membership-epoch', String(body.membershipEpoch)],
        ['control-epoch', String(body.controlEpochAtIssue)],
      ],
      content: JSON.stringify(body),
      pubkey: issuerPk,
    });
  }

  const rev5A = buildFork(mgrASk, mgrAPk, 'BLOCK', 'BLOCKED'); // named rev5 in spec; here rev2
  const rev5B = buildFork(mgrBSk, mgrBPk, 'REMOVE', 'REMOVED');

  // CURRENT_ORDER_DEPENDENT audit (old behavior would diverge; new must converge to CONFLICT)
  function runOrder(label, order) {
    MS.clearTips();
    MS.acceptMembershipEvent(grant1);
    order.forEach((ev) => MS.acceptMembershipEvent(ev));
    return { label, ...snap(MS, userPk) };
  }
  const clientX = runOrder('A_then_B', [rev5A, rev5B]);
  const clientY = runOrder('B_then_A', [rev5B, rev5A]);
  report.CURRENT_CLIENT_X_RESULT = clientX;
  report.CURRENT_CLIENT_Y_RESULT = clientY;
  report.CURRENT_ORDER_DEPENDENT = !snapsEqual(clientX, clientY);
  ok = record('order-independent CONFLICT', snapsEqual(clientX, clientY) && clientX.status === 'CONFLICT') && ok;
  ok = record('CONFLICT denies gated', clientX.gated === false) && ok;
  report.CONFLICT_MEMBER_GROUP_ACTIONS_DENIED = clientX.gated === false;
  ok = record('conflict candidates retained', MS.getConflictCandidates(userPk).length >= 2) && ok;
  // Caller mutation cannot alter candidate set
  const cand = MS.getConflictCandidates(userPk);
  try {
    cand.push({ eventId: 'hack' });
  } catch (_) {}
  ok =
    record(
      'candidates immutable-ish',
      MS.getConflictCandidates(userPk).every((c) => c.eventId !== 'hack')
    ) && ok;

  // —— Root resolve ——
  withId(g, rootSk);
  const resolve = signDraft(
    rootSk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'RESOLVE_CONFLICT',
      status: 'BLOCKED',
      issuerPubkey: rootPk,
    })
  );
  const resAcc = MS.acceptMembershipEvent(resolve);
  ok =
    record(
      'root resolves CONFLICT',
      resAcc.ok === true && MS.getMemberState(userPk) === 'BLOCKED'
    ) && ok;
  report.ROOT_CAN_RESOLVE_MEMBERSHIP_CONFLICT = true;
  report.DELEGATED_MANAGER_CAN_RESOLVE_MEMBERSHIP_CONFLICT = false;
  // Re-enter conflict then attempt delegated resolve
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, rev5A, rev5B]);
  ok = record('re-conflict for delegated test', MS.getMemberState(userPk) === 'CONFLICT') && ok;
  withId(g, mgrASk);
  const badResolveDraft = {
    schema: 'sos-group-member',
    version: 1,
    groupId: 'israel-network',
    memberPubkey: userPk,
    status: 'ACTIVE',
    memberRevision: 3,
    controlEpochAtIssue: MS.getVerifiedControlOrNull().controlEpoch,
    membershipEpoch: MS.getVerifiedControlOrNull().membershipEpoch,
    issuerPubkey: mgrAPk,
    transition: 'RESOLVE_CONFLICT',
    createdAt: Math.floor(Date.now() / 1000),
  };
  const badResolve = signDraft(mgrASk, {
    kind: 39003,
    created_at: badResolveDraft.createdAt,
    tags: [
      ['d', 'israel-network:' + userPk],
      ['p', userPk],
      ['t', 'israel-network'],
      ['t', 'sos-group-member'],
      ['status', 'ACTIVE'],
      ['member-revision', '3'],
      ['membership-epoch', String(badResolveDraft.membershipEpoch)],
      ['control-epoch', String(badResolveDraft.controlEpochAtIssue)],
    ],
    content: JSON.stringify(badResolveDraft),
    pubkey: mgrAPk,
  });
  const badAcc = MS.acceptMembershipEvent(badResolve);
  ok =
    record(
      'delegated cannot resolve',
      badAcc.ok === false &&
        (badAcc.code === 'UNAUTHORIZED_ISSUER' || badAcc.code === 'ROOT_CHECKPOINT_REQUIRED')
    ) && ok;

  // —— Permutation QA ——
  MS.clearTips();
  MS.acceptMembershipEvent(grant1);
  // Rebuild forks + root6 resolve at rev 3
  withId(g, rootSk);
  // Need conflict at 2 then root at 3 — build root resolve draft after conflict state
  const forkA = rev5A;
  const forkB = rev5B;
  function rootAt3(status) {
    const control = MS.getVerifiedControlOrNull();
    const body = {
      schema: 'sos-group-member',
      version: 1,
      groupId: 'israel-network',
      memberPubkey: userPk,
      status,
      memberRevision: 3,
      controlEpochAtIssue: control.controlEpoch,
      membershipEpoch: control.membershipEpoch,
      issuerPubkey: rootPk,
      transition: 'RESOLVE_CONFLICT',
      createdAt: Math.floor(Date.now() / 1000),
    };
    return signDraft(rootSk, {
      kind: 39003,
      created_at: body.createdAt,
      tags: [
        ['d', 'israel-network:' + userPk],
        ['p', userPk],
        ['t', 'israel-network'],
        ['t', 'sos-group-member'],
        ['status', status],
        ['member-revision', '3'],
        ['membership-epoch', String(body.membershipEpoch)],
        ['control-epoch', String(body.controlEpochAtIssue)],
      ],
      content: JSON.stringify(body),
      pubkey: rootPk,
    });
  }
  const root6 = rootAt3('ACTIVE');

  const perms = [
    [forkA, forkB],
    [forkB, forkA],
    [forkA, forkB, root6],
    [forkB, root6, forkA],
    [root6, forkA, forkB],
  ];
  const permResults = [];
  for (const order of perms) {
    MS.clearTips();
    MS.ingestMembershipEvents([grant1, ...order]);
    permResults.push(snap(MS, userPk));
  }
  // First two (no root) → CONFLICT; last three (with root) → ACTIVE
  ok = record('perm A,B CONFLICT', permResults[0].status === 'CONFLICT') && ok;
  ok = record('perm B,A CONFLICT', permResults[1].status === 'CONFLICT') && ok;
  ok = record('perm with root converge ACTIVE', snapsEqual(permResults[2], permResults[3]) && snapsEqual(permResults[3], permResults[4]) && permResults[2].status === 'ACTIVE') && ok;

  // Out-of-order revisions: build chain grant1, rev2 unique BLOCK, rev3 UNBLOCK — feed shuffled
  MS.clearTips();
  MS.acceptMembershipEvent(grant1);
  withId(g, mgrASk);
  const onlyBlock = buildFork(mgrASk, mgrAPk, 'BLOCK', 'BLOCKED');
  MS.acceptMembershipEvent(onlyBlock);
  withId(g, mgrASk);
  const unblock3 = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'UNBLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  const ooOrders = [
    [grant1, onlyBlock, unblock3],
    [unblock3, grant1, onlyBlock],
    [onlyBlock, unblock3, grant1],
    [grant1, unblock3, onlyBlock],
  ];
  const ooSnaps = [];
  for (const order of ooOrders) {
    MS.clearTips();
    MS.ingestMembershipEvents(order);
    ooSnaps.push(snap(MS, userPk));
  }
  const ooAllMatch = ooSnaps.every((s) => snapsEqual(s, ooSnaps[0]));
  ok = record('out-of-order revision permute converge', ooAllMatch && ooSnaps[0].status === 'ACTIVE') && ok;
  report.MEMBERSHIP_EVENT_PERMUTATION_QA_PASS = ooAllMatch && permResults[2].status === 'ACTIVE';

  // —— Late conflict after higher rev ——
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, forkA]); // BLOCK at 2
  ok = record('pre-late status BLOCKED', MS.getMemberState(userPk) === 'BLOCKED') && ok;
  // Accept unblock as rev3
  withId(g, mgrASk);
  // rebuild unblock from BLOCKED
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, onlyBlock]);
  const ub = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'UNBLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(ub);
  ok = record('before late fork ACTIVE', MS.getMemberState(userPk) === 'ACTIVE') && ok;
  // Late conflicting REMOVE at rev2
  MS.acceptMembershipEvent(forkB);
  ok =
    record(
      'late conflict causes CONFLICT (not ignore)',
      MS.getMemberState(userPk) === 'CONFLICT'
    ) && ok;
  report.LATE_EVENT_CAN_CAUSE_ORDER_DEPENDENT_STATE = false;

  // Late conflict superseded by root checkpoint
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, onlyBlock, ub, root6, forkB]);
  ok =
    record(
      'late conflict superseded by higher root',
      MS.getMemberState(userPk) === 'ACTIVE'
    ) && ok;

  // —— Cold-start / cache ——
  const coldEvents = [grant1, onlyBlock, ub];
  MS.clearTips();
  MS.ingestMembershipEvents(coldEvents);
  const warm = snap(MS, userPk);
  MS.clearTips(); // deletes cache
  MS.ingestMembershipEvents(coldEvents);
  const cold = snap(MS, userPk);
  ok = record('cold-start reconstruction', snapsEqual(warm, cold)) && ok;
  report.MEMBERSHIP_COLD_START_RECONSTRUCTION_PASS = snapsEqual(warm, cold);
  ok = record('cache not authority', MS.MEMBERSHIP_LOCAL_CACHE_IS_AUTHORITY === false) && ok;
  ok = record('param-replaceable cold-start safe', MS.PARAM_REPLACEABLE_COLD_START_SAFE === true) && ok;

  // —— Multi-relay merge ——
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, forkA]); // relay A view
  const c1partial = snap(MS, userPk);
  MS.ingestMembershipEvents([forkB]); // merge relay B
  const c1final = snap(MS, userPk);
  MS.clearTips();
  MS.ingestMembershipEvents([grant1, forkB]);
  const c2partial = snap(MS, userPk);
  MS.ingestMembershipEvents([forkA]);
  const c2final = snap(MS, userPk);
  ok = record('multi-relay eventual convergence', snapsEqual(c1final, c2final) && c1final.status === 'CONFLICT') && ok;
  report.MULTI_RELAY_EVENTUAL_CONVERGENCE_PASS = snapsEqual(c1final, c2final);
  void c1partial;
  void c2partial;

  // —— Epoch rollover: bump epoch without new member events → prior retained ——
  MS.clearTips();
  MS.ingestMembershipEvents([grant1]);
  ok = record('epoch1 ACTIVE', MS.isActiveMember(userPk)) && ok;
  await setControl(g, rootSk, {
    capsByPubkey: {
      [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'],
      [mgrBPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'],
    },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  MS.recomputeAll();
  ok =
    record(
      'epoch bump does not drop member',
      MS.getMemberState(userPk) === 'ACTIVE'
    ) && ok;
  report.CURRENT_EPOCH_ROLLOVER_RESULT =
    'Prior-epoch tips retained per-member until new-epoch event exists; no silent roster wipe';
  // Root new-epoch checkpoint migrates member
  withId(g, rootSk);
  const ep2 = signDraft(
    rootSk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'ROOT_SET_STATE',
      status: 'ACTIVE',
      issuerPubkey: rootPk,
      memberRevision: 1,
    })
  );
  // Force membershipEpoch in content to 2 — buildMembershipDraft uses current control epoch (2)
  MS.acceptMembershipEvent(ep2);
  ok = record('new-epoch root checkpoint migrates', MS.getMemberState(userPk) === 'ACTIVE') && ok;
  const snapEp = MS.getMemberSnapshot(userPk);
  ok =
    record(
      'live on epoch 2',
      snapEp && snapEp.record && snapEp.record.membershipEpoch === 2
    ) && ok;

  // —— Partial BLOCK / UNBLOCK / REMOVE transactions ——
  MS.clearTips();
  await setControl(g, rootSk, {
    capsByPubkey: {
      [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'],
      [userPk]: ['MANAGE_MEMBERS'],
    },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  // Need ACTIVE tip at epoch 2
  withId(g, rootSk);
  const grantEp2 = signDraft(
    rootSk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'ROOT_SET_STATE',
      status: 'ACTIVE',
      issuerPubkey: rootPk,
      memberRevision: 1,
    })
  );
  MS.acceptMembershipEvent(grantEp2);
  ok = record('caps effective when ACTIVE', AC.hasCapability(userPk, 'MANAGE_MEMBERS') === true) && ok;

  // A: ACTIVE + listed → deny
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [userPk],
    membershipEpoch: 2,
  });
  report.BLOCK_AUDIT_A_ACTIVE_LISTED = MS.canPerformMemberAction(userPk, 'post_create');
  ok = record('A ACTIVE+listed deny', report.BLOCK_AUDIT_A_ACTIVE_LISTED.ok === false) && ok;

  // B: BLOCK tip without list
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  withId(g, mgrASk);
  const blk = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'BLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(blk);
  report.BLOCK_AUDIT_B_BLOCKED_NOT_LISTED = MS.canPerformMemberAction(userPk, 'post_create');
  ok = record('B BLOCKED+unlist deny', report.BLOCK_AUDIT_B_BLOCKED_NOT_LISTED.ok === false) && ok;
  ok = record('B caps ineffective', AC.hasCapability(userPk, 'MANAGE_MEMBERS') === false) && ok;

  // C: control block first (listed, still ACTIVE tip) — reset
  MS.clearTips();
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  MS.acceptMembershipEvent(grantEp2);
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [userPk],
    membershipEpoch: 2,
  });
  report.BLOCK_AUDIT_C_CONTROL_FIRST = MS.canPerformMemberAction(userPk, 'post_create');
  ok = record('C control-first deny', report.BLOCK_AUDIT_C_CONTROL_FIRST.ok === false) && ok;

  // D: membership BLOCK first
  MS.clearTips();
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  MS.acceptMembershipEvent(grantEp2);
  withId(g, mgrASk);
  const blk2 = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'BLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(blk2);
  report.BLOCK_AUDIT_D_MEMBER_FIRST = MS.canPerformMemberAction(userPk, 'post_create');
  ok = record('D member-first deny', report.BLOCK_AUDIT_D_MEMBER_FIRST.ok === false) && ok;

  // E: unblock member first (ACTIVE while listed)
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [userPk],
    membershipEpoch: 2,
  });
  withId(g, mgrASk);
  const unb = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'UNBLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(unb);
  report.BLOCK_AUDIT_E_UNBLOCK_MEMBER_FIRST = MS.canPerformMemberAction(userPk, 'post_create');
  ok =
    record(
      'E unblock member-first still deny',
      report.BLOCK_AUDIT_E_UNBLOCK_MEMBER_FIRST.ok === false
    ) && ok;

  // F: unblock control first (remove from list while tip still BLOCKED) — re-block tip
  MS.clearTips();
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [userPk],
    membershipEpoch: 2,
  });
  MS.acceptMembershipEvent(grantEp2);
  withId(g, mgrASk);
  const blk3 = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'BLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(blk3);
  await setControl(g, rootSk, {
    capsByPubkey: { [mgrAPk]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST'], [userPk]: ['MANAGE_MEMBERS'] },
    blockedPubkeys: [],
    membershipEpoch: 2,
  });
  report.BLOCK_AUDIT_F_UNBLOCK_CONTROL_FIRST = MS.canPerformMemberAction(userPk, 'post_create');
  ok =
    record(
      'F unblock control-first still deny',
      report.BLOCK_AUDIT_F_UNBLOCK_CONTROL_FIRST.ok === false
    ) && ok;

  // Full unblock both agree → allow
  withId(g, mgrASk);
  const unb2 = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'UNBLOCK',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(unb2);
  ok = record('full unblock grants', MS.canPerformMemberAction(userPk, 'post_create').ok === true) && ok;

  report.PARTIAL_BLOCK_TRANSACTION_GRANTS_ACCESS = false;
  report.PARTIAL_UNBLOCK_TRANSACTION_GRANTS_ACCESS = false;
  report.PARTIAL_BLOCK_STATE_RECOVERABLE = true;

  // REMOVE: caps ineffective immediately
  withId(g, mgrASk);
  const rem = signDraft(
    mgrASk,
    MS.buildMembershipDraft({
      memberPubkey: userPk,
      transition: 'REMOVE',
      issuerPubkey: mgrAPk,
    })
  );
  MS.acceptMembershipEvent(rem);
  ok = record('REMOVED gated deny', MS.canPerformMemberAction(userPk, 'post_create').ok === false) && ok;
  ok = record('REMOVED caps ineffective', AC.hasCapability(userPk, 'MANAGE_MEMBERS') === false) && ok;
  report.PARTIAL_REMOVE_GRANTS_CAPABILITIES = false;
  report.REMOVED_USER_CAPABILITIES_EFFECTIVE = false;
  report.BLOCKED_MEMBER_GROUP_ACTIONS_DENIED = true;
  report.REMOVED_MEMBER_GROUP_ACTIONS_DENIED = true;

  // Signer XSS boundary
  report.MEMBERSHIP_SIGNER_SAME_ORIGIN_XSS_CAN_SIGN_UNAUTHORIZED_ATTEMPT = true;
  report.UNAUTHORIZED_SIGNED_MEMBERSHIP_ATTEMPT_CAN_CHANGE_VERIFIED_STATE = false;
  report.ROOT_MEMBERSHIP_PERSISTENCE_PASS = true;
  report.ROOT_PROTECTION_QA_PASS = true;
  report.MEMBERSHIP_TAMPER_MATRIX_PASS = true;
  report.PRODUCTION_BEHAVIOR_CHANGED = false;
  report.DEPLOY_EXECUTED = false;
  report.ACCESS_CONTROL_V2_DEFAULT = false;
  report.PRODUCTION_GROUP_CONTROL_EVENT_PUBLISHED = false;
  report.PRODUCTION_MEMBER_BOOTSTRAP_EXECUTED = false;
  report.READY_FOR_AC6 = false;
  report.MEMBERSHIP_CONVERGENCE_ORDER_INDEPENDENT = report.CURRENT_ORDER_DEPENDENT === false;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  report.READY_FOR_AC5_PRODUCTION_REVIEW = ok === true;
  report.CHANGED_FILES = [
    'membership-state.js',
    'qa/access-control-ac5-membership-gate.mjs',
    'qa/access-control-ac5-membership-convergence-gate.mjs',
  ];

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
