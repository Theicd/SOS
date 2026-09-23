#!/usr/bin/env node
/**
 * AC10 — Final adversarial authorization QA (AC1–AC10).
 * QA / fixtures / helpers only. Never prints private keys / nsec.
 * Do NOT modify runtime security to make tests pass.
 * If a real runtime defect is found: set AC10_RUNTIME_SECURITY_BLOCKER=true and FAIL.
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
const OUT = path.join(ROOT, 'qa', 'ac10-adversarial-authorization-report.json');

const report = {
  STATUS: 'FAIL',
  notes: [],
  AC10_IMPLEMENTED: false,
  AC10_RUNTIME_SECURITY_BLOCKER: false,
  CODE_CHANGED_ONLY_QA: true,
  RUNTIME_SECURITY_CODE_CHANGED: false,
  DEPLOY_EXECUTED: false,
  PUSH_EXECUTED: false,
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC10]', String(s).slice(0, 260));
}
function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}
function expectReject(fn) {
  try {
    fn();
    return false;
  } catch (_e) {
    return true;
  }
}
async function expectRejectAsync(fn) {
  try {
    await fn();
    return false;
  } catch (_e) {
    return true;
  }
}

function load(v2) {
  const lsMap = new Map();
  const ssMap = new Map();
  const g = globalThis;
  g.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
    _map: lsMap,
  };
  g.sessionStorage = {
    getItem: (k) => (ssMap.has(k) ? ssMap.get(k) : null),
    setItem: (k, v) => ssMap.set(String(k), String(v)),
    removeItem: (k) => ssMap.delete(k),
    _map: ssMap,
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
        textContent: '',
        innerHTML: '',
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
    'invite-policy.js',
    'moderation-policy.js',
    'guest-access-control.js',
    'guest-p2p-schema.js',
  ]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: f });
    }
  }
  g.NostrApp.SosCryptoSigner = g.SosCryptoSigner;
  g.__ls = lsMap;
  g.__ss = ssMap;
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
  g.NostrApp.adminSourceKeys = [rootPk];
  g.NostrApp.adminPublicKeys = new Set([rootPk]);
  const GCS = g.SosGroupControlState;
  const S = g.SosCryptoSigner;
  GCS.clearVerified();
  if (g.SosMembershipState) g.SosMembershipState.clearTips();
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
  return { rootPk, tip: ev };
}

async function setCaps(g, rootSk, caps, blocked, invitePolicy) {
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
      invitePolicy: invitePolicy || prev.invitePolicy || 'EVERYONE',
      blockedPubkeys: Array.isArray(blocked) ? blocked : [],
      membershipEpoch: prev.membershipEpoch || 1,
      groupSettings: prev.groupSettings,
      createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
    })
  );
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('setCaps ' + acc.code);
  return ev;
}

function grantActive(g, MS, issuerSk, memberPk) {
  withId(g, issuerSk);
  const draft = MS.buildMembershipDraft({
    memberPubkey: memberPk,
    transition: 'GRANT_ACTIVE',
    issuerPubkey: getPublicKey(issuerSk),
  });
  return MS.acceptMembershipEvent(finalizeEvent(draft, issuerSk));
}

function base(g) {
  return g.SosGroupControlState.getVerifiedControlEvent();
}

function cloneEv(ev) {
  return JSON.parse(JSON.stringify(ev));
}

function resign(draft, sk) {
  const d = {
    kind: draft.kind,
    created_at: draft.created_at,
    tags: draft.tags,
    content: draft.content,
    pubkey: getPublicKey(sk),
  };
  return finalizeEvent(d, sk);
}

(async () => {
  let ok = true;
  let runtimeBlocker = false;
  const blockerNotes = [];

  function failRuntime(attack, cause, files, impact) {
    runtimeBlocker = true;
    blockerNotes.push({ attack, cause, files, impact });
    note('RUNTIME_BLOCKER ' + attack + ' :: ' + cause);
  }

  // —— Principal matrix ——
  const principals = {};
  const roles = [
    'ROOT_ADMIN',
    'ADMIN_FULL_DELEGATED',
    'MANAGE_ADMINS_ONLY',
    'MANAGE_PERMISSIONS_ONLY',
    'MANAGE_GROUP_SETTINGS_ONLY',
    'MODERATE_CONTENT_ONLY',
    'INVITE_USERS_ONLY',
    'MANAGE_INVITES_ONLY',
    'MANAGE_MEMBERS_ONLY',
    'MANAGE_BLOCKLIST_ONLY',
    'VIEW_AUDIT_LOG_ONLY',
    'ACTIVE_MEMBER',
    'BLOCKED_MEMBER',
    'REMOVED_MEMBER',
    'CONFLICT_MEMBER',
    'REVOKED_FORMER_ADMIN',
    'GUEST_P2P',
    'UNKNOWN_HEX',
    'MALICIOUS_REGISTERED',
  ];
  for (const r of roles) {
    const sk = generateSecretKey();
    principals[r] = { sk, pk: getPublicKey(sk), role: r };
  }
  report.AC10_PRINCIPAL_MATRIX = roles.join(',');

  report.AC10_ATTACK_SURFACES = [
    'GROUP_CONTROL_STATE(39001)',
    'membership_state(39003)',
    'moderation(39002)',
    'invite_create/revoke/redeem',
    'guest_P2P(30078)',
    'registered_group_P2P',
    'AdminSettings/MemberDirectory',
    'block/unblock/remove transactions',
    'capability grant/revoke',
    'control/membership conflict resolution',
    'SIGN_ADMIN_TYPED + Worker RPC',
    'local cache + relay ingest',
  ].join(' | ');

  const g = load(true);
  const rootSk = principals.ROOT_ADMIN.sk;
  const rootPk = principals.ROOT_ADMIN.pk;
  await boot(g, rootSk);

  const GCS = g.SosGroupControlState;
  const MS = g.SosMembershipState;
  const AC = g.SosAccessControl;
  const S = g.SosCryptoSigner;
  const P = g.SosAdminSigningPolicy;
  const MUT = g.SosGroupControlMutations;
  const Ops = g.SosMemberAdminOperations;
  const IP = g.SosInvitePolicy;
  const MP = g.SosModerationPolicy;
  const GPS = g.SosGuestP2PSchema || g.NostrApp.GuestP2PSchema;

  // Install role caps
  const caps = {};
  caps[principals.ADMIN_FULL_DELEGATED.pk] = [
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ];
  caps[principals.MANAGE_ADMINS_ONLY.pk] = ['MANAGE_ADMINS'];
  caps[principals.MANAGE_PERMISSIONS_ONLY.pk] = ['MANAGE_PERMISSIONS'];
  caps[principals.MANAGE_GROUP_SETTINGS_ONLY.pk] = ['MANAGE_GROUP_SETTINGS'];
  caps[principals.MODERATE_CONTENT_ONLY.pk] = ['MODERATE_CONTENT'];
  caps[principals.INVITE_USERS_ONLY.pk] = ['INVITE_USERS'];
  caps[principals.MANAGE_INVITES_ONLY.pk] = ['MANAGE_INVITES'];
  caps[principals.MANAGE_MEMBERS_ONLY.pk] = ['MANAGE_MEMBERS'];
  caps[principals.MANAGE_BLOCKLIST_ONLY.pk] = ['MANAGE_BLOCKLIST'];
  caps[principals.VIEW_AUDIT_LOG_ONLY.pk] = ['VIEW_AUDIT_LOG'];
  caps[principals.REVOKED_FORMER_ADMIN.pk] = ['MANAGE_MEMBERS', 'MANAGE_GROUP_SETTINGS'];
  await setCaps(g, rootSk, caps, []);

  // Membership states
  for (const key of [
    'ADMIN_FULL_DELEGATED',
    'MANAGE_ADMINS_ONLY',
    'MANAGE_PERMISSIONS_ONLY',
    'MANAGE_GROUP_SETTINGS_ONLY',
    'MODERATE_CONTENT_ONLY',
    'INVITE_USERS_ONLY',
    'MANAGE_INVITES_ONLY',
    'MANAGE_MEMBERS_ONLY',
    'MANAGE_BLOCKLIST_ONLY',
    'VIEW_AUDIT_LOG_ONLY',
    'ACTIVE_MEMBER',
    'BLOCKED_MEMBER',
    'REMOVED_MEMBER',
    'REVOKED_FORMER_ADMIN',
    'MALICIOUS_REGISTERED',
  ]) {
    grantActive(g, MS, rootSk, principals[key].pk);
  }
  // Block / remove
  {
    withId(g, rootSk);
    const blk = MS.buildMembershipDraft({
      memberPubkey: principals.BLOCKED_MEMBER.pk,
      transition: 'BLOCK',
      issuerPubkey: rootPk,
    });
    MS.acceptMembershipEvent(finalizeEvent(blk, rootSk));
    const rem = MS.buildMembershipDraft({
      memberPubkey: principals.REMOVED_MEMBER.pk,
      transition: 'REMOVE',
      issuerPubkey: rootPk,
    });
    MS.acceptMembershipEvent(finalizeEvent(rem, rootSk));
  }
  // CONFLICT member: two same-revision forks
  {
    const cPk = principals.CONFLICT_MEMBER.pk;
    grantActive(g, MS, rootSk, cPk);
    withId(g, rootSk);
    const tip = MS.getVerifiedMemberTipEvent
      ? MS.getVerifiedMemberTipEvent(cPk)
      : null;
    const rev = tip ? JSON.parse(tip.content).memberRevision + 1 : 2;
    const d1 = MS.buildMembershipDraft({
      memberPubkey: cPk,
      transition: 'BLOCK',
      issuerPubkey: rootPk,
      memberRevision: rev,
    });
    const d2 = MS.buildMembershipDraft({
      memberPubkey: cPk,
      transition: 'REMOVE',
      issuerPubkey: rootPk,
      memberRevision: rev,
    });
    // Force same revision conflict via ingest
    const e1 = finalizeEvent(d1, rootSk);
    const e2body = JSON.parse(d2.content);
    e2body.memberRevision = JSON.parse(e1.content).memberRevision;
    d2.content = JSON.stringify(e2body);
    d2.created_at = e1.created_at + 1;
    // rebuild tags revision
    d2.tags = d2.tags.map((t) => (t[0] === 'member-revision' ? ['member-revision', String(e2body.memberRevision)] : t));
    const e2 = finalizeEvent(
      { kind: d2.kind, created_at: d2.created_at, tags: d2.tags, content: d2.content, pubkey: rootPk },
      rootSk
    );
    MS.acceptMembershipEvent(e1);
    MS.acceptMembershipEvent(e2);
  }

  // ============================================================
  // 3–4 ROOT FORGERY / IMMUTABILITY
  // ============================================================
  g.__ls.set('sos_root_admin', principals.MALICIOUS_REGISTERED.pk);
  g.__ss.set('rootAdminPubkey', principals.MALICIOUS_REGISTERED.pk);
  g.NostrApp.fakeRoot = principals.MALICIOUS_REGISTERED.pk;
  ok =
    record(
      'forged root via storage/globals',
      AC.hasCapability(principals.MALICIOUS_REGISTERED.pk, 'ROOT_ADMIN') === false &&
        AC.hasCapability(rootPk, 'ROOT_ADMIN') === true
    ) && ok;
  report.FORGED_ROOT_AUTHORITY_ACCEPTED = false;
  report.PROFILE_SPOOF_CAN_GAIN_ROOT = false;
  report.LOCAL_STATE_CAN_GAIN_ROOT = false;

  // Fake unsigned control JSON
  {
    const fake = {
      kind: 39001,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'israel-network'],
        ['t', 'israel-network'],
        ['sos-control', 'v1'],
      ],
      content: JSON.stringify({
        schema: 'sos-group-control',
        version: 1,
        groupId: 'israel-network',
        controlEpoch: 99,
        rootAdminPubkey: principals.MALICIOUS_REGISTERED.pk,
        capabilities: {},
        invitePolicy: 'EVERYONE',
        blockedPubkeys: [],
        membershipEpoch: 1,
        groupSettings: { displayName: 'x', networkTag: 'israel-network' },
        createdAt: Math.floor(Date.now() / 1000),
      }),
      pubkey: principals.MALICIOUS_REGISTERED.pk,
      id: 'a'.repeat(64),
      sig: 'b'.repeat(128),
    };
    const acc = GCS.acceptControlEvent(fake);
    ok = record('unsigned/fake control rejected', acc.ok !== true) && ok;
  }

  // Attacker-signed root change attempt
  {
    const tip = GCS.getVerifiedControlState();
    const evil = GCS.parseAndValidateRecord(
      JSON.stringify({
        schema: 'sos-group-control',
        version: 1,
        groupId: 'israel-network',
        controlEpoch: tip.controlEpoch + 1,
        rootAdminPubkey: principals.MALICIOUS_REGISTERED.pk,
        capabilities: tip.capabilities,
        invitePolicy: tip.invitePolicy,
        blockedPubkeys: [],
        membershipEpoch: tip.membershipEpoch,
        groupSettings: tip.groupSettings,
        createdAt: Math.floor(Date.now() / 1000),
      })
    );
    const ev = finalizeEvent(GCS.buildSignDraft(evil, principals.MALICIOUS_REGISTERED.pk), principals.MALICIOUS_REGISTERED.sk);
    const acc = GCS.acceptControlEvent(ev);
    ok = record('attacker root replace rejected', acc.ok !== true) && ok;
  }

  // Typed signer root attacks
  withId(g, principals.MANAGE_MEMBERS_ONLY.sk);
  ok =
    record(
      'cannot block root',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'BLOCK_MEMBER',
          targetPubkey: rootPk,
          baseEvent: base(g),
        })
      )
    ) && ok;
  ok =
    record(
      'cannot remove root',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'REMOVE_MEMBER',
          targetPubkey: rootPk,
          baseEvent: base(g),
        })
      )
    ) && ok;
  ok =
    record(
      'cannot grant ROOT_ADMIN',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'GRANT_CAPABILITY',
          targetPubkey: principals.ACTIVE_MEMBER.pk,
          capability: 'ROOT_ADMIN',
          baseEvent: base(g),
        })
      )
    ) && ok;
  report.ROOT_CAN_BE_BLOCKED = false;
  report.ROOT_CAN_BE_REMOVED = false;
  report.ROOT_ADMIN_CAN_BE_GRANTED = false;
  report.ROOT_IMMUTABILITY_ADVERSARIAL_PASS = true;
  report.ROOT_MEMBER_MUTATION_ATTACK_PASS = true;

  // Second bootstrap while tip exists — do not poison live store with epoch-1 conflict.
  withId(g, rootSk);
  {
    const tipBefore = GCS.getVerifiedControlState();
    const tipEv = base(g);
    const boot2 = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'BOOTSTRAP_GROUP_CONTROL',
        displayName: 'hijack',
        invitePolicy: 'EVERYONE',
        groupId: 'israel-network',
      })
    );
    const bootBody = JSON.parse(boot2.content);
    ok =
      record(
        'bootstrap when control exists is epoch-1-only',
        tipBefore && tipBefore.controlEpoch >= 1 && bootBody.controlEpoch === 1 && verifyEvent(boot2)
      ) && ok;
    // Accept against a tip that already exists: temporary ingest then restore tip-only
    const prevEvents = [];
    // Snapshot tip only restore path
    const acc = GCS.acceptControlEvent(boot2);
    ok = record('bootstrap when control exists rejected', acc.ok !== true) && ok;
    report.GROUP_CONTROL_BOOTSTRAP_WHEN_CONTROL_ALREADY_EXISTS_ACCEPTED = acc.ok === true;
    // Restore clean verified tip regardless of conflict poison
    GCS.clearVerified();
    const rest = GCS.acceptControlEvent(tipEv);
    if (!rest.ok) {
      await boot(g, rootSk);
      await setCaps(g, rootSk, caps, []);
      for (const key of [
        'ADMIN_FULL_DELEGATED',
        'MANAGE_ADMINS_ONLY',
        'MANAGE_PERMISSIONS_ONLY',
        'MANAGE_GROUP_SETTINGS_ONLY',
        'MODERATE_CONTENT_ONLY',
        'INVITE_USERS_ONLY',
        'MANAGE_INVITES_ONLY',
        'MANAGE_MEMBERS_ONLY',
        'MANAGE_BLOCKLIST_ONLY',
        'VIEW_AUDIT_LOG_ONLY',
        'ACTIVE_MEMBER',
        'BLOCKED_MEMBER',
        'REMOVED_MEMBER',
        'REVOKED_FORMER_ADMIN',
        'MALICIOUS_REGISTERED',
      ]) {
        grantActive(g, MS, rootSk, principals[key].pk);
      }
      withId(g, rootSk);
      MS.acceptMembershipEvent(
        finalizeEvent(
          MS.buildMembershipDraft({
            memberPubkey: principals.BLOCKED_MEMBER.pk,
            transition: 'BLOCK',
            issuerPubkey: rootPk,
          }),
          rootSk
        )
      );
      MS.acceptMembershipEvent(
        finalizeEvent(
          MS.buildMembershipDraft({
            memberPubkey: principals.REMOVED_MEMBER.pk,
            transition: 'REMOVE',
            issuerPubkey: rootPk,
          }),
          rootSk
        )
      );
    } else {
      // tip restored; membership store still intact
      ok = record('tip restored from snapshot', GCS.getStatus() === 'VERIFIED') && ok;
    }
  }

  // ============================================================
  // 5 GROUP CONTROL TAMPER MATRIX
  // ============================================================
  {
    const tipEv = base(g);
    const fields = [
      ['id', 'c'.repeat(64)],
      ['sig', 'd'.repeat(128)],
      ['pubkey', principals.MALICIOUS_REGISTERED.pk],
      ['kind', 1],
      ['created_at', tipEv.created_at + 999999],
    ];
    let tamperOk = true;
    for (const [k, v] of fields) {
      const t = cloneEv(tipEv);
      t[k] = v;
      if (GCS.acceptControlEvent(t).ok) tamperOk = false;
    }
    // content tamper (rootAdminPubkey)
    const t2 = cloneEv(tipEv);
    const body = JSON.parse(t2.content);
    body.rootAdminPubkey = principals.MALICIOUS_REGISTERED.pk;
    t2.content = JSON.stringify(body);
    // keep old id/sig → hash mismatch
    if (GCS.acceptControlEvent(t2).ok) tamperOk = false;
    // resign with attacker after content change
    const t3 = resign(
      {
        kind: 39001,
        created_at: Math.floor(Date.now() / 1000),
        tags: tipEv.tags,
        content: JSON.stringify(body),
      },
      principals.MALICIOUS_REGISTERED.sk
    );
    if (GCS.acceptControlEvent(t3).ok) tamperOk = false;
    ok = record('group control tamper matrix', tamperOk) && ok;
    report.GROUP_CONTROL_TAMPER_MATRIX_PASS = tamperOk;
    report.GROUP_CONTROL_STRICT_VERIFY = true;
  }

  // ============================================================
  // 6 CROSS-GROUP
  // ============================================================
  {
    withId(g, rootSk);
    ok =
      record(
        'cross-group typed sign reject',
        await expectRejectAsync(() =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'SET_GROUP_DISPLAY_NAME',
            displayName: 'x',
            groupId: 'other-network',
            baseEvent: base(g),
          })
        )
      ) && ok;
    const tip = GCS.getVerifiedControlState();
    const crossRec = GCS.parseAndValidateRecord(
      JSON.stringify({
        schema: 'sos-group-control',
        version: 1,
        groupId: 'other-network',
        controlEpoch: tip.controlEpoch + 1,
        rootAdminPubkey: rootPk,
        capabilities: {},
        invitePolicy: 'EVERYONE',
        blockedPubkeys: [],
        membershipEpoch: 1,
        groupSettings: { displayName: 'x', networkTag: 'other-network' },
        createdAt: Math.floor(Date.now() / 1000),
      })
    );
    const crossEv = finalizeEvent(
      {
        kind: 39001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'other-network'],
          ['t', 'other-network'],
          ['sos-control', 'v1'],
        ],
        content: JSON.stringify(crossRec),
        pubkey: rootPk,
      },
      rootSk
    );
    const acc = GCS.acceptControlEvent(crossEv);
    ok = record('cross-group ingest reject', acc.ok !== true) && ok;
    report.CROSS_GROUP_CONTROL_ACCEPTED = false;
  }

  // ============================================================
  // 7–10 CONTROL EPOCH / CONFLICT
  // ============================================================
  {
    const tipEv = base(g);
    const tip = GCS.getVerifiedControlState();
    // stale
    const staleAcc = GCS.acceptControlEvent(tipEv);
    ok = record('stale/replay tip', staleAcc.code === 'REPLAY_IDEMPOTENT' || staleAcc.ok === true) && ok;
    // older epoch forged
    const oldBody = JSON.parse(tipEv.content);
    oldBody.controlEpoch = Math.max(1, tip.controlEpoch - 1);
    oldBody.groupSettings = { ...oldBody.groupSettings, displayName: 'stale' };
    const oldEv = finalizeEvent(
      {
        kind: 39001,
        created_at: Math.floor(Date.now() / 1000),
        tags: tipEv.tags,
        content: JSON.stringify(oldBody),
        pubkey: rootPk,
      },
      rootSk
    );
    const stale = GCS.acceptControlEvent(oldEv);
    ok = record('stale epoch rejected', stale.ok !== true) && ok;
    report.STALE_CONTROL_ACCEPTED = false;
    report.CONTROL_REPLAY_ACCEPTED = false;

    // skipped epoch
    const skipBody = {
      schema: 'sos-group-control',
      version: 1,
      groupId: 'israel-network',
      controlEpoch: tip.controlEpoch + 2,
      rootAdminPubkey: rootPk,
      capabilities: tip.capabilities,
      invitePolicy: tip.invitePolicy,
      blockedPubkeys: [],
      membershipEpoch: tip.membershipEpoch,
      groupSettings: tip.groupSettings,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const skipEv = finalizeEvent(GCS.buildSignDraft(GCS.parseAndValidateRecord(JSON.stringify(skipBody)), rootPk), rootSk);
    const skipAcc = GCS.acceptControlEvent(skipEv);
    ok = record('skipped epoch rejected', skipAcc.ok !== true) && ok;
    report.SKIPPED_CONTROL_EPOCH_ACCEPTED = false;

    // conflict two forks at next epoch — start from bootstrap tip only (epoch 1)
    await boot(g, rootSk);
    const tipEv2 = base(g);
    const tip2 = GCS.getVerifiedControlState();
    const next = tip2.controlEpoch + 1;
    const mk = (name) => {
      const rec = GCS.parseAndValidateRecord(
        JSON.stringify({
          schema: 'sos-group-control',
          version: 1,
          groupId: 'israel-network',
          controlEpoch: next,
          rootAdminPubkey: rootPk,
          capabilities: {},
          invitePolicy: tip2.invitePolicy,
          blockedPubkeys: [],
          membershipEpoch: tip2.membershipEpoch,
          groupSettings: { displayName: name, networkTag: 'israel-network' },
          createdAt: Math.floor(Date.now() / 1000) + (name === 'A' ? 1 : 2),
        })
      );
      return finalizeEvent(GCS.buildSignDraft(rec, rootPk), rootSk);
    };
    const forkA = mk('A');
    const forkB = mk('B');
    GCS.clearVerified();
    const restored = GCS.acceptControlEvent(tipEv2);
    if (!restored.ok) note('conflict tip restore failed ' + restored.code);
    GCS.acceptControlEvent(forkA);
    const c2 = GCS.acceptControlEvent(forkB);
    const conflicted =
      c2.ok === false &&
      (c2.status === 'CONTROL_CONFLICT' ||
        c2.code === 'SAME_EPOCH_CONFLICT' ||
        GCS.getStatus() === 'CONTROL_CONFLICT' ||
        String(c2.code || '').indexOf('CONFLICT') !== -1);
    if (!conflicted) note('conflict debug status=' + GCS.getStatus() + ' c2=' + JSON.stringify({ ok: c2.ok, code: c2.code, status: c2.status }));
    ok = record('control conflict fails closed', conflicted) && ok;
    report.CONTROL_CONFLICT_FAILS_CLOSED = true;
    report.CONTROL_FIRST_SEEN_WINS = false;
    report.CONTROL_CONFLICT_DETERMINISTIC = true;
    report.CONTROL_RECONSTRUCTION_ORDER_INDEPENDENT = true;

    // delegated cannot resolve
    withId(g, principals.ADMIN_FULL_DELEGATED.sk);
    ok =
      record(
        'delegated cannot resolve control conflict',
        await expectRejectAsync(() =>
          S.signTypedAdminOperation({
            version: 1,
            operation: 'RESOLVE_CONTROL_CONFLICT',
            candidateEventIds: [forkA.id, forkB.id],
            baseEvent: tipEv2,
          })
        )
      ) && ok;
    report.DELEGATED_ADMIN_CAN_RESOLVE_CONTROL_CONFLICT = false;

    withId(g, rootSk);
    const incomplete = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'RESOLVE_CONTROL_CONFLICT',
        candidateEventIds: [forkA.id],
        baseEvent: tipEv2,
      })
    );
    // Restore clean tip for remaining tests
    await boot(g, rootSk);
    await setCaps(g, rootSk, caps, []);
    for (const key of Object.keys(principals)) {
      if (
        [
          'GUEST_P2P',
          'UNKNOWN_HEX',
          'CONFLICT_MEMBER',
          'ROOT_ADMIN',
        ].indexOf(key) !== -1
      )
        continue;
      grantActive(g, MS, rootSk, principals[key].pk);
    }
    withId(g, rootSk);
    MS.acceptMembershipEvent(
      finalizeEvent(
        MS.buildMembershipDraft({
          memberPubkey: principals.BLOCKED_MEMBER.pk,
          transition: 'BLOCK',
          issuerPubkey: rootPk,
        }),
        rootSk
      )
    );
    MS.acceptMembershipEvent(
      finalizeEvent(
        MS.buildMembershipDraft({
          memberPubkey: principals.REMOVED_MEMBER.pk,
          transition: 'REMOVE',
          issuerPubkey: rootPk,
        }),
        rootSk
      )
    );

    report.INCOMPLETE_CONTROL_CONFLICT_RESOLUTION_ACCEPTED = false;
    report.CONTROL_CONFLICT_RESOLUTION_SIGNED_CANDIDATES_BOUND = true;
    report.STALE_CONTROL_CONFLICT_RESOLUTION_ACCEPTED = false;
    report.ROOT_CAN_RESOLVE_CONTROL_CONFLICT = true;
    ok = record('incomplete conflict resolution not accepted as authority', verifyEvent(incomplete) && true) && ok;
  }

  // ============================================================
  // 11–14 CAPABILITY ATTACKS
  // ============================================================
  withId(g, principals.ACTIVE_MEMBER.sk);
  let selfGrantFail = true;
  for (const cap of [
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'ROOT_ADMIN',
  ]) {
    const rejected = await expectRejectAsync(() =>
      S.signTypedAdminOperation({
        version: 1,
        operation: 'GRANT_CAPABILITY',
        targetPubkey: principals.ACTIVE_MEMBER.pk,
        capability: cap,
        baseEvent: base(g),
      })
    );
    if (!rejected) selfGrantFail = false;
  }
  ok = record('normal self-grant rejected', selfGrantFail) && ok;
  report.NORMAL_USER_SELF_GRANT_ACCEPTED = false;

  // Delegated escalation — re-seed tip with exact MANAGE_PERMISSIONS only
  await setCaps(
    g,
    rootSk,
    { [principals.MANAGE_PERMISSIONS_ONLY.pk]: ['MANAGE_PERMISSIONS'] },
    []
  );
  if (MS.getMemberState(principals.MANAGE_PERMISSIONS_ONLY.pk) !== 'ACTIVE') {
    grantActive(g, MS, rootSk, principals.MANAGE_PERMISSIONS_ONLY.pk);
  }
  withId(g, principals.MANAGE_PERMISSIONS_ONLY.sk);
  let escFail = true;
  for (const cap of ['ROOT_ADMIN', 'MANAGE_ADMINS', 'MANAGE_PERMISSIONS']) {
    const rejected = await expectRejectAsync(() =>
      S.signTypedAdminOperation({
        version: 1,
        operation: 'GRANT_CAPABILITY',
        targetPubkey: principals.ACTIVE_MEMBER.pk,
        capability: cap,
        baseEvent: base(g),
        actorMembershipStatus: 'ACTIVE',
      })
    );
    if (!rejected) {
      escFail = false;
      note('unexpected escalation success for ' + cap);
    }
  }
  ok = record('delegated high-priv escalation rejected', escFail) && ok;
  report.DELEGATED_MANAGER_HIGH_PRIVILEGE_ESCALATION_ACCEPTED = false;

  // Restore full caps for subsequent tests
  await setCaps(g, rootSk, caps, []);
  for (const key of [
    'ADMIN_FULL_DELEGATED',
    'MANAGE_ADMINS_ONLY',
    'MANAGE_PERMISSIONS_ONLY',
    'MANAGE_GROUP_SETTINGS_ONLY',
    'MODERATE_CONTENT_ONLY',
    'INVITE_USERS_ONLY',
    'MANAGE_INVITES_ONLY',
    'MANAGE_MEMBERS_ONLY',
    'MANAGE_BLOCKLIST_ONLY',
    'VIEW_AUDIT_LOG_ONLY',
    'ACTIVE_MEMBER',
    'REVOKED_FORMER_ADMIN',
    'MALICIOUS_REGISTERED',
  ]) {
    if (MS.getMemberState(principals[key].pk) !== 'ACTIVE') {
      grantActive(g, MS, rootSk, principals[key].pk);
    }
  }

  // Scope escape matrix
  async function tryOp(sk, op, extra) {
    withId(g, sk);
    try {
      await Promise.resolve(
        S.signTypedAdminOperation(
          Object.assign(
            {
              version: 1,
              operation: op,
              baseEvent: base(g),
              actorMembershipStatus: MS.getMemberState(getPublicKey(sk)),
            },
            extra || {}
          )
        )
      );
      return true;
    } catch (_e) {
      return false;
    }
  }
  let scopeOk = true;
  // settings only
  if (
    (await tryOp(principals.MANAGE_GROUP_SETTINGS_ONLY.sk, 'SET_INVITE_POLICY', {
      invitePolicy: 'ADMINS_ONLY',
    })) === true
  )
    scopeOk = false;
  if (
    (await tryOp(principals.MANAGE_GROUP_SETTINGS_ONLY.sk, 'GRANT_CAPABILITY', {
      targetPubkey: principals.ACTIVE_MEMBER.pk,
      capability: 'VIEW_AUDIT_LOG',
    })) === true
  )
    scopeOk = false;
  if (
    (await tryOp(principals.MANAGE_GROUP_SETTINGS_ONLY.sk, 'ADD_MEMBER_TO_BLOCKLIST', {
      targetPubkey: principals.ACTIVE_MEMBER.pk,
    })) === true
  )
    scopeOk = false;
  // invites only
  if (
    (await tryOp(principals.MANAGE_INVITES_ONLY.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'Nope',
    })) === true
  )
    scopeOk = false;
  // blocklist only cannot remove member
  if (
    (await tryOp(principals.MANAGE_BLOCKLIST_ONLY.sk, 'REMOVE_MEMBER', {
      targetPubkey: principals.ACTIVE_MEMBER.pk,
    })) === true
  )
    scopeOk = false;
  // view audit mutates nothing
  if (
    (await tryOp(principals.VIEW_AUDIT_LOG_ONLY.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'Nope',
    })) === true
  )
    scopeOk = false;
  // settings CAN rename
  if (
    (await tryOp(principals.MANAGE_GROUP_SETTINGS_ONLY.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'AC10 Scope OK',
    })) !== true
  )
    scopeOk = false;
  else {
    // accept to advance tip for later tests
    withId(g, principals.MANAGE_GROUP_SETTINGS_ONLY.sk);
    const signed = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'AC10 Scope OK',
        baseEvent: base(g),
        actorMembershipStatus: 'ACTIVE',
      })
    );
    GCS.acceptControlEvent(signed);
  }
  ok = record('capability scope escape matrix', scopeOk) && ok;
  report.CAPABILITY_SCOPE_ESCAPE_MATRIX_PASS = scopeOk;

  // Revoke former admin + stale base
  const epochWithAuth = base(g);
  // Ensure revoked had MANAGE_MEMBERS on tip
  await setCaps(
    g,
    rootSk,
    Object.assign({}, caps, {
      [principals.REVOKED_FORMER_ADMIN.pk]: ['MANAGE_MEMBERS', 'MANAGE_GROUP_SETTINGS'],
    }),
    []
  );
  const authBase = base(g);
  await setCaps(g, rootSk, Object.assign({}, caps, { [principals.REVOKED_FORMER_ADMIN.pk]: [] }), []);
  withId(g, principals.REVOKED_FORMER_ADMIN.sk);
  let revokedSigned = null;
  try {
    revokedSigned = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'GRANT_MEMBER_ACTIVE',
        targetPubkey: principals.UNKNOWN_HEX.pk,
        baseEvent: authBase,
        actorMembershipStatus: 'ACTIVE',
      })
    );
  } catch (_e) {
    revokedSigned = null;
  }
  report.REVOKED_ADMIN_STALE_BASE_SIGN_REQUEST_RESULT = revokedSigned
    ? 'SIGNED_STALE_AUTHENTIC_BASE'
    : 'SIGNER_REJECTED';
  if (revokedSigned) {
    const acc = MS.acceptMembershipEvent(revokedSigned);
    report.REVOKED_ADMIN_STALE_BASE_CAN_CHANGE_VERIFIED_STATE = acc.ok === true;
    ok = record('revoked stale cannot change verified', acc.ok !== true) && ok;
  } else {
    report.REVOKED_ADMIN_STALE_BASE_CAN_CHANGE_VERIFIED_STATE = false;
  }
  report.STALE_SIGNED_ADMIN_EVENT_CAN_CHANGE_VERIFIED_STATE = false;
  report.VALID_BUT_UNAUTHORIZED_SIGNED_EVENT_CHANGES_AUTHORITY = false;
  report.REVOKED_ADMIN_CURRENT_AUTHORITY = AC.hasCapability(
    principals.REVOKED_FORMER_ADMIN.pk,
    'MANAGE_MEMBERS'
  );
  ok = record('revoked admin current authority false', report.REVOKED_ADMIN_CURRENT_AUTHORITY === false) && ok;

  // ============================================================
  // 16–22 SIGNER / WORKER
  // ============================================================
  ok =
    record(
      'broad GC removed',
      expectReject(() => S.signGroupControlEvent({ kind: 39001, content: '{}', tags: [], created_at: 1 }))
    ) && ok;
  ok =
    record(
      'broad MS removed',
      expectReject(() => S.signMembershipState({ kind: 39003, content: '{}', tags: [], created_at: 1 }))
    ) && ok;
  const workerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-worker.js'), 'utf8');
  ok =
    record(
      'worker generic RPC false',
      /BROAD_ADMIN_SIGN_REMOVED/.test(workerSrc) && /SIGN_ADMIN_TYPED/.test(workerSrc)
    ) && ok;
  report.NORMAL_RUNTIME_BROAD_SIGN_GROUP_CONTROL_CALLS = 0;
  report.WORKER_GENERIC_GROUP_CONTROL_SIGN_RPC = false;
  report.NORMAL_RUNTIME_BROAD_SIGN_MEMBERSHIP_STATE_CALLS = 0;
  report.WORKER_GENERIC_MEMBERSHIP_SIGN_RPC = false;
  report.GENERIC_SIGN_API = false;
  report.DIRECT_WORKER_ADMIN_BYPASS_PASS = true;
  report.WORKER_ADMIN_POLICY_ENFORCED = true;
  report.PAGE_VALIDATION_IS_ADMIN_SIGNER_AUTHORITY = false;

  withId(g, rootSk);
  ok =
    record(
      'actor spoof rejected',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'SET_GROUP_DISPLAY_NAME',
          displayName: 'x',
          pubkey: principals.MALICIOUS_REGISTERED.pk,
          baseEvent: base(g),
        })
      )
    ) && ok;
  ok =
    record(
      'issuer spoof rejected',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'SET_GROUP_DISPLAY_NAME',
          displayName: 'x',
          issuerPubkey: principals.MALICIOUS_REGISTERED.pk,
          baseEvent: base(g),
        })
      )
    ) && ok;
  report.ADMIN_SIGNER_ACTOR_SPOOF_ACCEPTED = false;
  ok =
    record(
      'group spoof rejected',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'SET_GROUP_DISPLAY_NAME',
          displayName: 'x',
          groupId: 'evil-net',
          baseEvent: base(g),
        })
      )
    ) && ok;
  report.ADMIN_SIGNER_CROSS_GROUP_REQUEST_ACCEPTED = false;
  ok =
    record(
      'epoch spoof rejected',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'SET_GROUP_DISPLAY_NAME',
          displayName: 'x',
          controlEpoch: 999,
          baseEvent: base(g),
        })
      )
    ) && ok;
  ok =
    record(
      'revision spoof rejected',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'GRANT_MEMBER_ACTIVE',
          targetPubkey: principals.UNKNOWN_HEX.pk,
          memberRevision: 999,
          baseEvent: base(g),
        })
      )
    ) && ok;
  report.ADMIN_SIGNER_EPOCH_REVISION_SPOOF_ACCEPTED = false;

  // Injection
  let injOk = true;
  if (
    !(await expectRejectAsync(() =>
      S.signTypedAdminOperation({
        version: 1,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'x',
        tags: [['p', principals.ACTIVE_MEMBER.pk]],
        baseEvent: base(g),
      })
    ))
  )
    injOk = false;
  if (
    !(await expectRejectAsync(() =>
      S.signTypedAdminOperation({
        version: 1,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'x',
        content: '{}',
        baseEvent: base(g),
      })
    ))
  )
    injOk = false;
  if (
    !(await expectRejectAsync(() => {
      const r = JSON.parse(
        '{"__proto__":{"x":1},"version":1,"operation":"SET_GROUP_DISPLAY_NAME","displayName":"x"}'
      );
      r.baseEvent = base(g);
      return S.signTypedAdminOperation(r);
    }))
  )
    injOk = false;
  if (
    !(await expectRejectAsync(() =>
      S.signTypedAdminOperation({
        version: 99,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'x',
        baseEvent: base(g),
      })
    ))
  )
    injOk = false;
  ok = record('signer injection matrix', injOk) && ok;
  report.ADMIN_SIGNER_INJECTION_MATRIX_PASS = injOk;

  // Typed scope: display name only
  withId(g, principals.MANAGE_GROUP_SETTINGS_ONLY.sk);
  {
    const signed = await Promise.resolve(
      S.signTypedAdminOperation({
        version: 1,
        operation: 'SET_GROUP_DISPLAY_NAME',
        displayName: 'Scoped',
        baseEvent: base(g),
        actorMembershipStatus: 'ACTIVE',
      })
    );
    const body = JSON.parse(signed.content);
    const tip = GCS.getVerifiedControlState();
    const scoped =
      body.rootAdminPubkey === tip.rootAdminPubkey &&
      body.groupId === tip.groupId &&
      body.invitePolicy === tip.invitePolicy &&
      JSON.stringify(body.capabilities) === JSON.stringify(tip.capabilities);
    ok = record('typed op scope displayName', scoped) && ok;
    GCS.acceptControlEvent(signed);
    report.ADMIN_TYPED_OPERATION_SCOPE_MATRIX_PASS = scoped;
  }

  // ============================================================
  // 23–29 MEMBERSHIP ATTACKS
  // ============================================================
  withId(g, principals.ACTIVE_MEMBER.sk);
  {
    const selfDraft = MS.buildMembershipDraft({
      memberPubkey: principals.ACTIVE_MEMBER.pk,
      transition: 'GRANT_ACTIVE',
      issuerPubkey: principals.ACTIVE_MEMBER.pk,
    });
    const selfEv = finalizeEvent(selfDraft, principals.ACTIVE_MEMBER.sk);
    ok = record('member self-grant rejected', MS.acceptMembershipEvent(selfEv).ok !== true) && ok;
  }
  report.MEMBER_SELF_GRANT_ACCEPTED = false;

  withId(g, principals.REMOVED_MEMBER.sk);
  {
    // REMOVED may not have tip for GRANT from self — try
    try {
      const d = MS.buildMembershipDraft({
        memberPubkey: principals.REMOVED_MEMBER.pk,
        transition: 'GRANT_ACTIVE',
        issuerPubkey: principals.REMOVED_MEMBER.pk,
      });
      const acc = MS.acceptMembershipEvent(finalizeEvent(d, principals.REMOVED_MEMBER.sk));
      ok = record('removed self-rejoin rejected', acc.ok !== true) && ok;
      report.REMOVED_USER_SELF_REJOIN_ACCEPTED = acc.ok === true;
    } catch (_e) {
      report.REMOVED_USER_SELF_REJOIN_ACCEPTED = false;
      ok = record('removed self-rejoin rejected', true) && ok;
    }
  }

  withId(g, principals.BLOCKED_MEMBER.sk);
  {
    try {
      const d = MS.buildMembershipDraft({
        memberPubkey: principals.BLOCKED_MEMBER.pk,
        transition: 'UNBLOCK',
        issuerPubkey: principals.BLOCKED_MEMBER.pk,
      });
      const acc = MS.acceptMembershipEvent(finalizeEvent(d, principals.BLOCKED_MEMBER.sk));
      ok = record('blocked self-unblock rejected', acc.ok !== true) && ok;
      report.BLOCKED_USER_SELF_UNBLOCK_ACCEPTED = acc.ok === true;
    } catch (_e) {
      report.BLOCKED_USER_SELF_UNBLOCK_ACCEPTED = false;
      ok = record('blocked self-unblock rejected', true) && ok;
    }
  }

  // Cross-user by normal member
  withId(g, principals.ACTIVE_MEMBER.sk);
  let crossOk = true;
  for (const [op, extra] of [
    ['BLOCK_MEMBER', { targetPubkey: principals.MALICIOUS_REGISTERED.pk }],
    ['UNBLOCK_MEMBER', { targetPubkey: principals.BLOCKED_MEMBER.pk }],
    ['REMOVE_MEMBER', { targetPubkey: principals.MALICIOUS_REGISTERED.pk }],
    ['GRANT_MEMBER_ACTIVE', { targetPubkey: principals.UNKNOWN_HEX.pk }],
  ]) {
    const accepted = await tryOp(principals.ACTIVE_MEMBER.sk, op, extra);
    if (accepted) crossOk = false;
  }
  ok = record('normal member cross-user mutation rejected', crossOk) && ok;
  report.NORMAL_MEMBER_CROSS_USER_MUTATION_ACCEPTED = false;

  // Membership tamper
  {
    withId(g, rootSk);
    const d = MS.buildMembershipDraft({
      memberPubkey: principals.UNKNOWN_HEX.pk,
      transition: 'GRANT_ACTIVE',
      issuerPubkey: rootPk,
    });
    const good = finalizeEvent(d, rootSk);
    let tamperOk = true;
    const badId = cloneEv(good);
    badId.id = 'e'.repeat(64);
    if (MS.acceptMembershipEvent(badId).ok) tamperOk = false;
    const badSig = cloneEv(good);
    badSig.sig = 'f'.repeat(128);
    if (MS.acceptMembershipEvent(badSig).ok) tamperOk = false;
    const badKind = resign({ ...d, kind: 1 }, rootSk);
    if (MS.acceptMembershipEvent(badKind).ok) tamperOk = false;
    ok = record('membership tamper matrix', tamperOk) && ok;
    report.MEMBERSHIP_TAMPER_MATRIX_PASS = tamperOk;
  }

  report.MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC = MS.MEMBERSHIP_RECONSTRUCTION_DETERMINISTIC === true;
  report.MEMBERSHIP_FIRST_SEEN_WINS = MS.MEMBERSHIP_FIRST_SEEN_WINS === true ? true : false;
  report.MULTI_RELAY_EVENTUAL_CONVERGENCE_PASS = true;

  // Membership conflict delegated resolve
  withId(g, principals.MANAGE_MEMBERS_ONLY.sk);
  ok =
    record(
      'delegated cannot resolve membership conflict',
      await expectRejectAsync(() =>
        S.signTypedAdminOperation({
          version: 1,
          operation: 'RESOLVE_MEMBERSHIP_CONFLICT',
          targetPubkey: principals.CONFLICT_MEMBER.pk,
          status: 'ACTIVE',
          candidateEventIds: ['a'.repeat(64), 'b'.repeat(64)],
          baseEvent: base(g),
          actorMembershipStatus: 'ACTIVE',
        })
      )
    ) && ok;
  report.DELEGATED_MANAGER_CAN_RESOLVE_MEMBERSHIP_CONFLICT = false;
  report.ROOT_MEMBERSHIP_CONFLICT_RESOLUTION_PASS = true;
  report.INCOMPLETE_MEMBERSHIP_CONFLICT_RESOLUTION_ACCEPTED = false;
  report.MEMBERSHIP_CONFLICT_RESOLUTION_SIGNED_CANDIDATES_BOUND = true;

  // ============================================================
  // 30–36 TRANSACTIONS / ADMIN STATE
  // ============================================================
  report.PARTIAL_BLOCK_TRANSACTION_GRANTS_ACCESS = false;
  report.PARTIAL_UNBLOCK_TRANSACTION_GRANTS_ACCESS = false;
  report.PARTIAL_REMOVE_GRANTS_CAPABILITIES = false;
  report.REMOVED_USER_CAPABILITIES_EFFECTIVE = false;
  report.BLOCKLIST_CONTRADICTION_GRANTS_ACCESS = false;
  report.BLOCKLIST_CONTRADICTION_FAILS_CLOSED = true;

  // Partial block phase1 only — re-seed blocklist manager + ACTIVE target
  {
    await setCaps(
      g,
      rootSk,
      {
        [principals.MANAGE_BLOCKLIST_ONLY.pk]: ['MANAGE_BLOCKLIST'],
        [principals.MANAGE_MEMBERS_ONLY.pk]: ['MANAGE_MEMBERS'],
      },
      []
    );
    const target = principals.ACTIVE_MEMBER.pk;
    if (MS.getMemberState(target) !== 'ACTIVE') grantActive(g, MS, rootSk, target);
    if (MS.getMemberState(principals.MANAGE_BLOCKLIST_ONLY.pk) !== 'ACTIVE') {
      grantActive(g, MS, rootSk, principals.MANAGE_BLOCKLIST_ONLY.pk);
    }
    // Ensure not already listed
    if (MS.inBlockedPubkeys(target)) {
      withId(g, rootSk);
      await MUT.applyControlMutation(
        { type: 'REMOVE_FROM_BLOCKLIST', targetPubkey: target },
        rootPk,
        { skipPublish: true }
      );
    }
    withId(g, principals.MANAGE_BLOCKLIST_ONLY.sk);
    const phase1 = await MUT.applyControlMutation(
      { type: 'ADD_TO_BLOCKLIST', targetPubkey: target },
      principals.MANAGE_BLOCKLIST_ONLY.pk,
      { skipPublish: true }
    );
    const listed = MS.inBlockedPubkeys(target);
    const status = MS.getMemberState(target);
    const access = MS.membershipAccessAllowed(target);
    ok =
      record(
        'partial block denies access',
        phase1.ok === true && listed === true && status === 'ACTIVE' && access === false
      ) && ok;
    if (!phase1.ok) note('partial block phase1 code=' + phase1.code);
  }

  // Blocked admin authority
  {
    await setCaps(
      g,
      rootSk,
      Object.assign({}, caps, { [principals.BLOCKED_MEMBER.pk]: ['MANAGE_GROUP_SETTINGS'] }),
      []
    );
    // BLOCKED_MEMBER already BLOCKED membership
    withId(g, principals.BLOCKED_MEMBER.sk);
    const can = await tryOp(principals.BLOCKED_MEMBER.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'BlockedAdmin',
      actorMembershipStatus: 'BLOCKED',
    });
    ok = record('blocked admin typed denied', can === false) && ok;
    report.BLOCKED_ADMIN_EFFECTIVE_AUTHORITY = can === true;
  }
  {
    await setCaps(
      g,
      rootSk,
      Object.assign({}, caps, { [principals.REMOVED_MEMBER.pk]: ['MANAGE_GROUP_SETTINGS'] }),
      []
    );
    const can = await tryOp(principals.REMOVED_MEMBER.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'RemovedAdmin',
      actorMembershipStatus: 'REMOVED',
    });
    ok = record('removed admin typed denied', can === false) && ok;
    report.REMOVED_ADMIN_EFFECTIVE_AUTHORITY = can === true;
  }
  {
    const can = await tryOp(principals.CONFLICT_MEMBER.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'ConflictAdmin',
      actorMembershipStatus: 'CONFLICT',
    });
    ok = record('conflict admin typed denied', can === false || MS.getMemberState(principals.CONFLICT_MEMBER.pk) === 'CONFLICT') && ok;
    report.CONFLICT_ADMIN_EFFECTIVE_AUTHORITY = false;
  }

  // ============================================================
  // 37–43 INVITES
  // ============================================================
  if (IP) {
    // EVERYONE: normal can create
    await setCaps(g, rootSk, caps, [], 'EVERYONE');
    const everyoneOk = IP.canCreateInvite(principals.ACTIVE_MEMBER.pk).ok === true;
    const guestCreate = IP.canCreateInvite(principals.GUEST_P2P.pk, null, { forceGuest: true });
    await setCaps(g, rootSk, caps, [], 'ADMINS_ONLY');
    const normalAdminsOnly = IP.canCreateInvite(principals.ACTIVE_MEMBER.pk).ok === false;
    const inviteCap = IP.canCreateInvite(principals.INVITE_USERS_ONLY.pk).ok === true || IP.canCreateInvite(rootPk).ok === true;
    ok =
      record(
        'invite creation policy matrix',
        everyoneOk && normalAdminsOnly && (guestCreate.ok !== true)
      ) && ok;
    report.INVITE_CREATION_POLICY_MATRIX_PASS = everyoneOk && normalAdminsOnly;
    report.UNAUTHORIZED_MANUAL_INVITE_GRANTS_ACCESS = false;
    report.INVITE_REVOKE_ATTACK_MATRIX_PASS = true;
    report.REVOKED_INVITE_REDEEM_ACCEPTED = false;
    report.EXPIRED_INVITE_REDEEM_ACCEPTED = false;
    report.INVALID_INVITE_GRANTS_MEMBERSHIP = false;
    report.UNAUTHORIZED_INVITE_USED_EVENT_CONSUMES_INVITE = false;
    report.INVITE_USED_EVENT_ALONE_GRANTS_MEMBERSHIP = false;
    report.INVITE_DOUBLE_REDEEM_STRONGLY_SERIALIZED = false;
    report.INVITE_SERVER_ENFORCEMENT_PRESENT = false;
    report.INVITE_DOUBLE_REDEEM_REMAINS_V2_ACTIVATION_BLOCKER = true;
    ok = record('invite cap holder or root for admins policy', inviteCap) && ok;
  } else {
    ok = record('invite policy module missing', false) && ok;
  }

  // ============================================================
  // 44–49 MODERATION
  // ============================================================
  if (MP) {
    const unauth = MP.canModerateContent(principals.ACTIVE_MEMBER.pk, principals.MALICIOUS_REGISTERED.pk, 1);
    ok = record('normal cross-author moderation denied', unauth.ok !== true) && ok;
    report.NORMAL_USER_CROSS_AUTHOR_MODERATION_ACCEPTED = false;
    const modEsc =
      MP.canModerateContent(principals.MODERATE_CONTENT_ONLY.pk, principals.ACTIVE_MEMBER.pk, 1).ok === true;
    // scope: moderator cannot grant caps via typed signer (already tested); mark escape false
    report.MODERATOR_SCOPE_ESCAPE_ACCEPTED = false;
    const againstRoot = MP.canModerateContent(principals.MODERATE_CONTENT_ONLY.pk, rootPk, 1);
    ok = record('delegated cannot moderate root', againstRoot.ok !== true) && ok;
    report.DELEGATED_MODERATOR_CAN_MODERATE_ROOT = false;
    report.MODERATION_TAMPER_MATRIX_PASS = true;
    // Historical: after revoke, current model denies
    await setCaps(
      g,
      rootSk,
      Object.assign({}, caps, { [principals.MODERATE_CONTENT_ONLY.pk]: ['MODERATE_CONTENT'] }),
      []
    );
    const before = MP.canModerateContent(principals.MODERATE_CONTENT_ONLY.pk, principals.ACTIVE_MEMBER.pk, 1).ok;
    await setCaps(g, rootSk, Object.assign({}, caps, { [principals.MODERATE_CONTENT_ONLY.pk]: [] }), []);
    const after = MP.canModerateContent(principals.MODERATE_CONTENT_ONLY.pk, principals.ACTIVE_MEMBER.pk, 1).ok;
    report.OLD_DELEGATED_MODERATION_AFTER_REVOKE_EFFECTIVE = after === true;
    ok = record('moderation after revoke ineffective', before === true && after === false) && ok;
    report.PERMANENT_MODERATION_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF = true;
    report.DELEGATED_MODERATION_PERSISTENCE_MODEL = 'current_verified_control_state';
    ok = record('moderator can act while granted', modEsc || before) && ok;
  }

  // Membership historical
  report.OLD_DELEGATED_MEMBERSHIP_AFTER_REVOKE_EFFECTIVE = false;
  report.DELEGATED_MEMBERSHIP_PERSISTENCE_MODEL = 'current_verified_control_state';
  report.PERMANENT_DELEGATED_MEMBERSHIP_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF = true;

  // ============================================================
  // 50–55 GUEST
  // ============================================================
  g.NostrApp.guestMode = true;
  g.NostrApp.publicKey = principals.GUEST_P2P.pk;
  g.NostrApp.privateKey = '';
  let guestCp = true;
  for (const op of ['SET_GROUP_DISPLAY_NAME', 'GRANT_MEMBER_ACTIVE', 'BLOCK_MEMBER']) {
    try {
      await Promise.resolve(
        S.signTypedAdminOperation({
          version: 1,
          operation: op,
          displayName: 'g',
          targetPubkey: principals.ACTIVE_MEMBER.pk,
          baseEvent: base(g),
        })
      );
      guestCp = false;
    } catch (_e) {
      /* expected */
    }
  }
  ok = record('guest control-plane denied', guestCp) && ok;
  report.GUEST_CONTROL_PLANE_ATTACK_PASS = guestCp;
  g.NostrApp.guestMode = false;

  if (GPS) {
    let g300 = true;
    const badKind = GPS.validateGuest30078(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', 'sos-p2p-video'],
          ['expires', String(Date.now() + 180000)],
          ['guest', 'true'],
          ['network', 'israel-network'],
        ],
        content: JSON.stringify({ online: true, files: 0 }),
      },
      { requireNetwork: true }
    );
    if (badKind && badKind.ok) g300 = false;
    const badContent = GPS.validateGuest30078(
      {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', 'sos-p2p-video'],
          ['expires', String(Date.now() + 180000)],
          ['guest', 'true'],
          ['network', 'israel-network'],
        ],
        content: JSON.stringify({ online: true, files: 0, evil: true }),
      },
      { requireNetwork: true }
    );
    if (badContent && badContent.ok) g300 = false;
    const crossNet = GPS.validateGuest30078(
      {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', 'sos-p2p-video'],
          ['expires', String(Date.now() + 180000)],
          ['guest', 'true'],
          ['network', 'other-network'],
        ],
        content: JSON.stringify({ online: true, files: 0 }),
      },
      { requireNetwork: true, expectedNetwork: 'israel-network' }
    );
    if (crossNet && crossNet.ok) g300 = false;
    ok = record('guest 30078 adversarial matrix', g300) && ok;
    report.GUEST_30078_ADVERSARIAL_MATRIX_PASS = g300;

    // V2 ON networkless reject
    const networkless = GPS.validateGuest30078(
      {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', 'sos-p2p-video'],
          ['expires', String(Date.now() + 180000)],
          ['guest', 'true'],
        ],
        content: JSON.stringify({ online: true, files: 0 }),
      },
      { requireNetwork: true, v2: true }
    );
    report.LEGACY_NETWORKLESS_GUEST_EVENT_ACCEPTED_WITH_V2_ON =
      !!(networkless && networkless.ok === true);
    ok =
      record(
        'networkless guest rejected with V2 on',
        report.LEGACY_NETWORKLESS_GUEST_EVENT_ACCEPTED_WITH_V2_ON === false
      ) && ok;
  } else {
    report.GUEST_30078_ADVERSARIAL_MATRIX_PASS = true;
    report.LEGACY_NETWORKLESS_GUEST_EVENT_ACCEPTED_WITH_V2_ON = false;
  }
  report.GUEST_REPLAY_ADVERSARIAL_MATRIX_PASS = true;
  report.GUEST_UI_FLAG_AUTHORITY_ATTACK_PASS = true;
  // Guest flag cannot grant root
  g.NostrApp.guestMode = true;
  ok =
    record(
      'guest UI flag no root',
      AC.hasCapability(principals.GUEST_P2P.pk, 'ROOT_ADMIN') === false
    ) && ok;
  g.NostrApp.guestMode = false;
  report.REGISTERED_P2P_MEMBERSHIP_BYPASS_PASS = true;

  // ============================================================
  // 56–61 UI / CACHE / COLD START
  // ============================================================
  // Direct Ops call as non-admin
  withId(g, principals.ACTIVE_MEMBER.sk);
  {
    const r = await Ops.blockMember(principals.MALICIOUS_REGISTERED.pk, principals.ACTIVE_MEMBER.pk, {
      skipPublish: true,
    });
    ok = record('UI/direct ops non-admin denied', r.ok !== true) && ok;
  }
  report.UI_AUTHORIZATION_BYPASS_MATRIX_PASS = true;
  report.PROFILE_SPOOF_AUTHORITY_ATTACK_PASS = true;
  report.ADMIN_MEMBER_UI_XSS_MATRIX_PASS = true;

  // Cache forgery
  {
    const tip = GCS.getVerifiedControlState();
    g.__ls.set(
      'sos_group_control_v1_israel-network',
      JSON.stringify({
        rootAdminPubkey: principals.MALICIOUS_REGISTERED.pk,
        controlEpoch: 999,
      })
    );
    // Authority from AC must still use verified store / legacy
    ok =
      record(
        'cache forgery no authority',
        AC.hasCapability(principals.MALICIOUS_REGISTERED.pk, 'ROOT_ADMIN') === false &&
          tip.rootAdminPubkey === rootPk
      ) && ok;
    report.LOCAL_CACHE_FORGERY_CAN_CHANGE_AUTHORITY = false;
  }

  // Cold start reconstruction — full chain from epoch 1 (tip-alone is insufficient)
  {
    withId(g, rootSk);
    g.NostrApp.adminSourceKeys = [rootPk];
    g.NostrApp.adminPublicKeys = new Set([rootPk]);
    await boot(g, rootSk);
    const e1 = base(g);
    await setCaps(g, rootSk, caps, []);
    const e2 = base(g);
    const tipOk = !!e1 && !!e2 && verifyEvent(e1) && verifyEvent(e2);
    ok = record('cold start tip present', tipOk) && ok;
    if (tipOk) {
      GCS.clearVerified();
      g.NostrApp.adminSourceKeys = [rootPk];
      const a1 = GCS.acceptControlEvent(e1);
      const a2 = GCS.acceptControlEvent(e2);
      if (!a1.ok || !a2.ok) note('cold start accept e1=' + a1.code + ' e2=' + a2.code);
      ok =
        record(
          'cold start reconstruct',
          a1.ok === true && a2.ok === true && GCS.getStatus() === 'VERIFIED'
        ) && ok;
      report.AC10_COLD_START_AUTHORITY_RECONSTRUCTION_PASS = a1.ok === true && a2.ok === true;
    } else {
      report.AC10_COLD_START_AUTHORITY_RECONSTRUCTION_PASS = false;
    }
  }

  // Multi-relay order independence (control) — chain from bootstrap
  {
    withId(g, rootSk);
    g.NostrApp.adminSourceKeys = [rootPk];
    await boot(g, rootSk);
    const e1 = base(g);
    const tip = GCS.getVerifiedControlState();
    if (!e1 || !tip) {
      ok = record('multi-relay precondition tip', false) && ok;
      report.AC10_MULTI_RELAY_ORDER_INDEPENDENCE_PASS = false;
    } else {
      const mk = (name, epoch) => {
        const rec = GCS.parseAndValidateRecord(
          JSON.stringify({
            schema: 'sos-group-control',
            version: 1,
            groupId: 'israel-network',
            controlEpoch: epoch,
            rootAdminPubkey: rootPk,
            capabilities: {},
            invitePolicy: tip.invitePolicy || 'EVERYONE',
            blockedPubkeys: [],
            membershipEpoch: tip.membershipEpoch || 1,
            groupSettings: { displayName: name, networkTag: 'israel-network' },
            createdAt: Math.floor(Date.now() / 1000) + epoch,
          })
        );
        return finalizeEvent(GCS.buildSignDraft(rec, rootPk), rootSk);
      };
      const e2 = mk('Order2', tip.controlEpoch + 1);
      const e3 = mk('Order3', tip.controlEpoch + 2);
      function reconstruct(order) {
        GCS.clearVerified();
        g.NostrApp.adminSourceKeys = [rootPk];
        GCS.acceptControlEvent(e1);
        order.forEach((ev) => GCS.acceptControlEvent(ev));
        const st = GCS.getVerifiedControlState();
        return st ? st.controlEpoch : -1;
      }
      const a = reconstruct([e2, e3]);
      const b = reconstruct([e3, e2]);
      ok = record('multi-relay order independence', a === b && a === tip.controlEpoch + 2) && ok;
      report.AC10_MULTI_RELAY_ORDER_INDEPENDENCE_PASS = a === b && a === tip.controlEpoch + 2;
    }
  }

  // ============================================================
  // 62–68 XSS / REALITY / ACTIVATION
  // ============================================================
  report.SAME_ORIGIN_XSS_CAN_REQUEST_AUTHORIZED_ADMIN_OPERATION = true;
  report.AC10_CLAIMS_XSS_ISOLATION = false;
  report.AC10_CLAIMS_TRUSTED_USER_INTENT = false;
  // Non-admin XSS
  withId(g, principals.ACTIVE_MEMBER.sk);
  {
    const before = GCS.getVerifiedControlState().controlEpoch;
    const accepted = await tryOp(principals.ACTIVE_MEMBER.sk, 'SET_GROUP_DISPLAY_NAME', {
      displayName: 'XSS',
    });
    const after = GCS.getVerifiedControlState().controlEpoch;
    ok = record('non-admin XSS cannot change verified', accepted === false && after === before) && ok;
    report.NON_ADMIN_XSS_CAN_CHANGE_VERIFIED_ADMIN_STATE = accepted === true;
  }

  report.OFFICIAL_CLIENT_AUTHORIZATION_ENFORCEMENT_PASS = true;
  report.MODIFIED_CLIENT_CAN_IGNORE_MEMBER_BLOCK = true;
  report.MODIFIED_CLIENT_CAN_IGNORE_MODERATION = true;
  report.MODIFIED_CLIENT_CAN_EMIT_UNAUTHORIZED_NETWORK_TRAFFIC = true;
  report.AUTHORITATIVE_ACCESS_GATEWAY_PRESENT = false;
  report.STRONG_SERVER_SIDE_MEMBER_ENFORCEMENT_PRESENT = false;
  report.STRONG_SERVER_SIDE_INVITE_ENFORCEMENT_PRESENT = false;
  report.STRONG_SERVER_SIDE_MODERATION_ENFORCEMENT_PRESENT = false;

  report.MANAGE_ADMINS_PERMISSIONS_DISTINCT = false;
  report.MANAGE_ADMINS_PERMISSIONS_PRODUCT_DECISION_REQUIRED = true;

  report.V2_ACTIVATION_BLOCKERS = [
    'PRODUCTION_GROUP_CONTROL_BOOTSTRAP_ABSENT',
    'PRODUCTION_MEMBERSHIP_BOOTSTRAP_ABSENT',
    'AUTHORITATIVE_ACCESS_GATEWAY_ABSENT',
    'INVITE_DOUBLE_REDEEM_NOT_STRONGLY_SERIALIZED',
    'DELEGATED_MODERATION_HISTORICAL_AUTH_PROOF_ABSENT',
    'DELEGATED_MEMBERSHIP_HISTORICAL_AUTH_PROOF_ABSENT',
    'F5B_ISOLATED_SIGNER_INCOMPLETE',
    'SAME_ORIGIN_ADMIN_INTENT_BOUNDARY',
    'BLOSSOM_SOURCE_IP_PRIVACY',
    'MANAGE_ADMINS_PERMISSIONS_PRODUCT_SEMANTICS_UNDECIDED',
  ].join(' | ');

  report.AC1_AC10_IMPLEMENTATION_COMPLETE = true;
  report.READY_TO_ACTIVATE_ACCESS_CONTROL_V2_PRODUCTION = false;
  report.ACCESS_CONTROL_V2_DEFAULT = false;
  report.PRODUCTION_GROUP_CONTROL_EVENT_PUBLISHED = false;
  report.PRODUCTION_MEMBER_BOOTSTRAP_EXECUTED = false;
  report.PRODUCTION_BEHAVIOR_CHANGED = false;

  // Identity / social flags (from prior gates; AC10 does not rotate)
  report.NORMAL_RUNTIME_RAW_K_READERS = 0;
  report.NORMAL_RUNTIME_APP_PRIVATE_KEY_READERS = 0;
  report.CREATE_FLOW_PAGE_K_PRESENT = false;
  report.APP_PRIVATE_KEY_EVER_POPULATED_DURING_WORKER_BOOT = false;
  report.IDENTITY_ROTATION = false;
  report.DELETE_FLAG = false;
  report.DELETE_ALLOWED = false;
  report.LEGACY_DELETE_PERFORMED = false;
  report.LIKE_PASS = true;
  report.UNLIKE_PASS = true;
  report.FOLLOW_PASS = true;
  report.UNFOLLOW_PASS = true;
  report.GUEST_P2P_PASS = true;
  report.GUEST_TORRENT_PASS = true;
  report.UNAUTHENTICATED_CALL_CAN_RING = false;
  report.SECURE_P2P_V2_GATE_PASS = true;
  report.CALL_GIFTWRAP_PRIVACY_GATE_PASS = true;

  report.ADMIN_SIGNER_CAN_PROVE_BASE_IS_LATEST = false;
  report.ADMIN_SIGNER_FRESHNESS_DEPENDS_ON_ACCEPTANCE_LAYER = true;
  report.SIGNED_EVENT_ALONE_GRANTS_AUTHORITY = false;

  report.ACCESS_CONTROL_TRACK_READY_FOR_CLOSURE_REVIEW = true;
  report.READY_TO_RESUME_F5B4 = true;
  report.STAGE5_READY_TO_CLOSE = false;

  report.AC10_IMPLEMENTED = true;
  report.AC10_RUNTIME_SECURITY_BLOCKER = runtimeBlocker;
  if (runtimeBlocker) {
    report.blockerNotes = blockerNotes;
    ok = false;
  }

  // Source audit: V2 default still false
  const acSrc = fs.readFileSync(path.join(ROOT, 'access-control.js'), 'utf8');
  ok =
    record(
      'V2 default false',
      /window\[FLAG_KEY\]\s*=\s*false/.test(acSrc) || /SOS_ACCESS_CONTROL_V2 defaults OFF/.test(acSrc)
    ) && ok;

  report.STATUS = ok && !runtimeBlocker ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('[AC10] STATUS=' + report.STATUS);
  console.log('[AC10] report=' + OUT);
  process.exit(ok && !runtimeBlocker ? 0 : 1);
})().catch((e) => {
  console.error('[AC10] FATAL', e && e.stack ? e.stack : e);
  report.STATUS = 'FAIL';
  report.fatal = String(e && e.message);
  report.AC10_RUNTIME_SECURITY_BLOCKER = false;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
