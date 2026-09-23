/**
 * AC7 — Central member admin operations (block / unblock / remove / conflict resolve).
 * Authority from verified MembershipState + GroupControlState + AccessControl only.
 * UI must not invent transactions. V2 OFF → all ops fail closed.
 */
(function initMemberAdminOperations(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const UNBLOCK_UI_TRANSACTION_ORDER =
    'phase1: membership BLOCKED→ACTIVE (still denied while listed); phase2: REMOVE_FROM_BLOCKLIST; access only when ACTIVE∧∉blockedPubkeys';

  const MEMBER_DIRECTORY_VIEW_CAPABILITIES = Object.freeze([
    'ROOT_ADMIN',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'VIEW_AUDIT_LOG',
  ]);

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function AC() {
    return App.AccessControl || window.SosAccessControl || null;
  }
  function MUT() {
    return App.GroupControlMutations || window.SosGroupControlMutations || null;
  }

  function normalizePubkey(value) {
    const m = MS();
    if (m && typeof m.normalizePubkey === 'function') return m.normalizePubkey(value);
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function actorIsRoot(actor, control) {
    return normalizePubkey(actor) === normalizePubkey(control && control.rootAdminPubkey);
  }

  function hasCap(actor, cap, control) {
    if (actorIsRoot(actor, control)) return true;
    const ac = AC();
    if (ac && typeof ac.hasCapability === 'function') return ac.hasCapability(actor, cap) === true;
    return false;
  }

  function controlOkForMemberMutation() {
    const g = GCS();
    if (!g) return { ok: false, code: 'NO_GCS' };
    if (typeof g.mutationsBlockedByConflict === 'function' && g.mutationsBlockedByConflict()) {
      return { ok: false, code: 'CONTROL_CONFLICT' };
    }
    const st = typeof g.getStatus === 'function' ? g.getStatus() : '';
    if (st !== 'VERIFIED') return { ok: false, code: 'INVALID_CONTROL', status: st };
    const live = g.getVerifiedControlState();
    if (!live || live.verified !== true) return { ok: false, code: 'INVALID_CONTROL' };
    return { ok: true, control: live };
  }

  function actorMayManageMembers(actor, control) {
    return hasCap(actor, 'MANAGE_MEMBERS', control) || actorIsRoot(actor, control);
  }
  function actorMayManageBlocklist(actor, control) {
    return (
      hasCap(actor, 'MANAGE_BLOCKLIST', control) ||
      hasCap(actor, 'MANAGE_MEMBERS', control) ||
      actorIsRoot(actor, control)
    );
  }

  function canViewDirectory(actorPubkey) {
    if (!isV2()) return false;
    const ctrl = controlOkForMemberMutation();
    const control = ctrl.ok ? ctrl.control : GCS() && GCS().getVerifiedControlState();
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    if (!actor) return false;
    if (control && actorIsRoot(actor, control)) return true;
    for (let i = 0; i < MEMBER_DIRECTORY_VIEW_CAPABILITIES.length; i++) {
      const c = MEMBER_DIRECTORY_VIEW_CAPABILITIES[i];
      if (c === 'ROOT_ADMIN') continue;
      if (hasCap(actor, c, control || { rootAdminPubkey: '' })) return true;
    }
    return false;
  }

  function assignedCapabilities(pubkey) {
    const live = GCS() && GCS().getVerifiedControlState();
    const pk = normalizePubkey(pubkey);
    if (!live || !pk) return [];
    return ((live.capabilities && live.capabilities[pk]) || []).slice().sort();
  }

  function effectiveCapabilities(pubkey) {
    const ms = MS();
    const pk = normalizePubkey(pubkey);
    if (!pk) return [];
    const live = GCS() && GCS().getVerifiedControlState();
    if (live && actorIsRoot(pk, live)) {
      return ['ROOT_ADMIN'];
    }
    if (ms && ms.isV2 && ms.isV2()) {
      if (!ms.membershipAllowsDelegatedCapability(pk)) return [];
    }
    return assignedCapabilities(pk);
  }

  function snapshotTarget(memberPubkey) {
    const ms = MS();
    const g = GCS();
    const pk = normalizePubkey(memberPubkey);
    const live = g && g.getVerifiedControlState();
    const snap = ms && ms.getMemberSnapshot ? ms.getMemberSnapshot(pk) : null;
    const status = ms ? ms.getMemberState(pk) : 'UNKNOWN';
    return {
      memberPubkey: pk,
      status,
      memberRevision: snap && snap.record ? Number(snap.record.memberRevision) || 0 : 0,
      membershipEpoch: snap && snap.record ? Number(snap.record.membershipEpoch) || 0 : 0,
      controlEpoch: live ? live.controlEpoch : 0,
      controlEventId: live ? live.eventId : '',
      listed: ms ? ms.inBlockedPubkeys(pk) : false,
      consistency: ms && ms.getBlocklistConsistency ? ms.getBlocklistConsistency(pk) : 'N_A',
    };
  }

  function assertFresh(expected, memberPubkey) {
    if (!expected) return;
    const now = snapshotTarget(memberPubkey);
    if (expected.controlEventId && expected.controlEventId !== now.controlEventId) {
      throw Object.assign(new Error('STALE_BASE'), { code: 'STALE_BASE' });
    }
    if (expected.controlEpoch != null && Number(expected.controlEpoch) !== Number(now.controlEpoch)) {
      throw Object.assign(new Error('STALE_BASE'), { code: 'STALE_BASE' });
    }
    if (expected.memberRevision != null && Number(expected.memberRevision) !== Number(now.memberRevision)) {
      throw Object.assign(new Error('STALE_MEMBER'), { code: 'STALE_MEMBER' });
    }
    if (expected.status && expected.status !== now.status) {
      throw Object.assign(new Error('STALE_MEMBER'), { code: 'STALE_MEMBER' });
    }
  }

  async function signAndAcceptMembership(draft, opts) {
    const options = opts || {};
    const ms = MS();
    if (!ms) return { ok: false, code: 'NO_MS' };
    let signed = draft;
    if (!options.preSigned) {
      const S = App.SosCryptoSigner;
      if (!S || typeof S.signMembershipState !== 'function') {
        return { ok: false, code: 'SIGNER_MISSING' };
      }
      try {
        signed = await Promise.resolve(S.signMembershipState(draft));
      } catch (e) {
        return { ok: false, code: 'SIGN_FAILED', error: e && e.message };
      }
    }
    if (options.skipPublish) {
      const acc = ms.acceptMembershipEvent(signed);
      return { ok: acc.ok === true, code: acc.code || acc.status, accept: acc, event: signed };
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      return { ok: false, code: 'NO_RELAYS', event: signed };
    }
    try {
      await App.pool.publish(App.relayUrls, signed);
    } catch (e) {
      return { ok: false, code: 'PUBLISH_FAILED', error: e && e.message, event: signed };
    }
    const acc = ms.acceptMembershipEvent(signed);
    if (!acc.ok) return { ok: false, code: acc.code || 'VERIFY_FAILED', accept: acc, event: signed };
    return { ok: true, code: 'APPLIED', accept: acc, event: signed };
  }

  async function applyMembershipTransition(actor, memberPubkey, transition, extra, opts) {
    const ms = MS();
    const draft = ms.buildMembershipDraft(
      Object.assign(
        {
          memberPubkey,
          transition,
          issuerPubkey: actor,
        },
        extra || {}
      )
    );
    return signAndAcceptMembership(draft, opts);
  }

  /**
   * BLOCK: phase1 ADD_TO_BLOCKLIST → phase2 membership BLOCK.
   */
  async function blockMember(memberPubkey, actorPubkey, opts) {
    const options = opts || {};
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actor || !target) return { ok: false, code: 'BAD_PUBKEY' };
    if (!actorMayManageBlocklist(actor, ctrl.control)) return { ok: false, code: 'UNAUTHORIZED' };
    if (actorIsRoot(target, ctrl.control)) return { ok: false, code: 'ROOT_PROTECTED' };

    try {
      assertFresh(options.expected, target);
    } catch (e) {
      return { ok: false, code: e.code || 'STALE' };
    }

    const ms = MS();
    const st = ms.getMemberState(target);
    if (st !== 'ACTIVE') return { ok: false, code: 'TARGET_NOT_ACTIVE', status: st };

    const mut = MUT();
    const phase1 = await mut.applyControlMutation(
      { type: 'ADD_TO_BLOCKLIST', targetPubkey: target },
      actor,
      { skipPublish: options.skipPublish, baseState: options.expectedControl || null }
    );
    if (!phase1.ok) {
      return {
        ok: false,
        code: phase1.code || 'BLOCK_PHASE1_FAILED',
        phase: 1,
        phase1,
        continuedToPhase2: false,
      };
    }

    const phase2 = await applyMembershipTransition(actor, target, 'BLOCK', null, options);
    if (!phase2.ok) {
      return {
        ok: false,
        code: 'PARTIAL_BLOCK',
        phase: 2,
        phase1,
        phase2,
        recoveryRequired: true,
        continuedToPhase2: true,
      };
    }
    return { ok: true, code: 'BLOCKED', phase1, phase2 };
  }

  /** Resume BLOCK phase2 when listed but tip not BLOCKED. */
  async function resumeBlock(memberPubkey, actorPubkey, opts) {
    const options = opts || {};
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actorMayManageBlocklist(actor, ctrl.control)) return { ok: false, code: 'UNAUTHORIZED' };
    if (actorIsRoot(target, ctrl.control)) return { ok: false, code: 'ROOT_PROTECTED' };
    const ms = MS();
    if (!ms.inBlockedPubkeys(target)) return { ok: false, code: 'NOT_LISTED' };
    if (ms.getMemberState(target) === 'BLOCKED') return { ok: false, code: 'ALREADY_BLOCKED' };
    try {
      assertFresh(options.expected, target);
    } catch (e) {
      return { ok: false, code: e.code || 'STALE' };
    }
    return applyMembershipTransition(actor, target, 'BLOCK', null, options);
  }

  /**
   * UNBLOCK: phase1 membership UNBLOCK→ACTIVE; phase2 REMOVE_FROM_BLOCKLIST.
   */
  async function unblockMember(memberPubkey, actorPubkey, opts) {
    const options = opts || {};
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actor || !target) return { ok: false, code: 'BAD_PUBKEY' };
    if (normalizePubkey(actor) === target) return { ok: false, code: 'SELF_UNBLOCK' };
    if (!actorMayManageBlocklist(actor, ctrl.control)) return { ok: false, code: 'UNAUTHORIZED' };
    if (actorIsRoot(target, ctrl.control)) return { ok: false, code: 'ROOT_PROTECTED' };

    try {
      assertFresh(options.expected, target);
    } catch (e) {
      return { ok: false, code: e.code || 'STALE' };
    }

    const ms = MS();
    const st = ms.getMemberState(target);
    if (st !== 'BLOCKED' && !(options.resumeOnly)) {
      // Allow resume path separately
      if (st !== 'BLOCKED') return { ok: false, code: 'TARGET_NOT_BLOCKED', status: st };
    }

    let phase1 = { ok: true, code: 'SKIPPED' };
    if (st === 'BLOCKED') {
      phase1 = await applyMembershipTransition(actor, target, 'UNBLOCK', null, options);
      if (!phase1.ok) {
        return { ok: false, code: phase1.code || 'UNBLOCK_PHASE1_FAILED', phase: 1, phase1 };
      }
    }

    // Still denied until removed from blocklist
    if (ms.membershipAccessAllowed(target)) {
      // Already fully unblocked
      return { ok: true, code: 'ALREADY_ACTIVE', phase1 };
    }

    const mut = MUT();
    const phase2 = await mut.applyControlMutation(
      { type: 'REMOVE_FROM_BLOCKLIST', targetPubkey: target },
      actor,
      { skipPublish: options.skipPublish }
    );
    if (!phase2.ok) {
      return {
        ok: false,
        code: 'PARTIAL_UNBLOCK',
        phase: 2,
        phase1,
        phase2,
        recoveryRequired: true,
        grantsAccess: false,
      };
    }
    return { ok: true, code: 'UNBLOCKED', phase1, phase2, grantsAccess: ms.membershipAccessAllowed(target) };
  }

  async function resumeUnblock(memberPubkey, actorPubkey, opts) {
    const options = Object.assign({}, opts || {}, { resumeOnly: true });
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actorMayManageBlocklist(actor, ctrl.control)) return { ok: false, code: 'UNAUTHORIZED' };
    const ms = MS();
    if (ms.getMemberState(target) !== 'ACTIVE') return { ok: false, code: 'NEED_ACTIVE_TIP' };
    if (!ms.inBlockedPubkeys(target)) return { ok: false, code: 'NOT_LISTED' };
    try {
      assertFresh(options.expected, target);
    } catch (e) {
      return { ok: false, code: e.code || 'STALE' };
    }
    const mut = MUT();
    const phase2 = await mut.applyControlMutation(
      { type: 'REMOVE_FROM_BLOCKLIST', targetPubkey: target },
      actor,
      { skipPublish: options.skipPublish }
    );
    if (!phase2.ok) return { ok: false, code: phase2.code || 'PARTIAL_UNBLOCK', phase2, grantsAccess: false };
    return { ok: true, code: 'UNBLOCKED', phase2, grantsAccess: ms.membershipAccessAllowed(target) };
  }

  /**
   * REMOVE: phase1 membership REMOVE; phase2 optional CLEAR_MEMBER_CAPABILITIES.
   */
  async function removeMember(memberPubkey, actorPubkey, opts) {
    const options = opts || {};
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actorMayManageMembers(actor, ctrl.control)) return { ok: false, code: 'UNAUTHORIZED' };
    // MANAGE_BLOCKLIST alone cannot remove
    if (
      !actorIsRoot(actor, ctrl.control) &&
      !hasCap(actor, 'MANAGE_MEMBERS', ctrl.control)
    ) {
      return { ok: false, code: 'UNAUTHORIZED' };
    }
    if (actorIsRoot(target, ctrl.control)) return { ok: false, code: 'ROOT_PROTECTED' };

    try {
      assertFresh(options.expected, target);
    } catch (e) {
      return { ok: false, code: e.code || 'STALE' };
    }

    const ms = MS();
    const st = ms.getMemberState(target);
    if (st !== 'ACTIVE' && st !== 'BLOCKED') {
      return { ok: false, code: 'TARGET_NOT_REMOVABLE', status: st };
    }

    const phase1 = await applyMembershipTransition(actor, target, 'REMOVE', null, options);
    if (!phase1.ok) {
      return { ok: false, code: phase1.code || 'REMOVE_FAILED', phase: 1, phase1, uiAuthorityChanged: false };
    }

    let cleanup = { ok: true, code: 'NOT_NEEDED', pending: false };
    const assigned = assignedCapabilities(target);
    if (assigned.length) {
      const canClean =
        actorIsRoot(actor, ctrl.control) ||
        hasCap(actor, 'MANAGE_PERMISSIONS', ctrl.control) ||
        hasCap(actor, 'MANAGE_ADMINS', ctrl.control);
      if (canClean) {
        const mut = MUT();
        cleanup = await mut.applyControlMutation(
          { type: 'CLEAR_MEMBER_CAPABILITIES', targetPubkey: target },
          actor,
          { skipPublish: options.skipPublish }
        );
        if (!cleanup.ok) {
          cleanup = {
            ok: false,
            code: cleanup.code || 'CLEANUP_FAILED',
            pending: true,
            securityEffective: true,
          };
        }
      } else {
        cleanup = { ok: false, code: 'CAPABILITY_CLEANUP_PENDING', pending: true, securityEffective: true };
      }
    }

    return {
      ok: true,
      code: 'REMOVED',
      phase1,
      cleanup,
      securityEffective: true,
      capabilityCleanupPending: cleanup.pending === true,
    };
  }

  async function resolveMembershipConflict(memberPubkey, canonicalStatus, actorPubkey, opts) {
    const options = opts || {};
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const ctrl = controlOkForMemberMutation();
    // Conflict resolution allowed even if... control must still be verified for epoch binding
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(actorPubkey) || normalizePubkey(App.publicKey);
    const target = normalizePubkey(memberPubkey);
    if (!actorIsRoot(actor, ctrl.control)) return { ok: false, code: 'ROOT_REQUIRED' };
    const ms = MS();
    if (ms.getMemberState(target) !== 'CONFLICT') return { ok: false, code: 'NOT_CONFLICT' };
    const candidates = (ms.getConflictCandidates(target) || []).map((c) => c.eventId || c.id).filter(Boolean);
    if (options.expectedCandidateIds) {
      const a = options.expectedCandidateIds
        .slice()
        .map(String)
        .sort()
        .join(',');
      const b = candidates.slice().map(String).sort().join(',');
      if (a !== b) return { ok: false, code: 'STALE_CONFLICT_SET' };
    }
    if (['ACTIVE', 'BLOCKED', 'REMOVED'].indexOf(canonicalStatus) === -1) {
      return { ok: false, code: 'BAD_STATUS' };
    }
    return applyMembershipTransition(
      actor,
      target,
      'RESOLVE_CONFLICT',
      { status: canonicalStatus },
      options
    );
  }

  function buildDirectoryRows(filter) {
    const ms = MS();
    const g = GCS();
    if (!ms || !isV2()) return [];
    let pks = [];
    if (filter === 'ACTIVE') pks = ms.getActiveMembers();
    else if (filter === 'BLOCKED') pks = ms.getBlockedMembers();
    else if (filter === 'REMOVED') pks = ms.getRemovedMembers();
    else if (filter === 'CONFLICT') pks = ms.getConflictMembers();
    else pks = ms.getKnownMemberPubkeys ? ms.getKnownMemberPubkeys() : [];

    // Include root for display if verified control exists
    const live = g && g.getVerifiedControlState();
    if (live && live.rootAdminPubkey && (filter === 'ALL' || filter === 'ACTIVE' || !filter)) {
      const root = normalizePubkey(live.rootAdminPubkey);
      if (root && pks.indexOf(root) === -1 && (filter === 'ALL' || !filter || filter === 'ACTIVE')) {
        pks = pks.concat([root]);
      }
    }

    return pks.map((pk) => {
      const snap = snapshotTarget(pk);
      const profile = resolveProfilePresentation(pk);
      return {
        memberPubkey: pk,
        displayName: profile.displayName,
        avatar: profile.avatar,
        status: snap.status,
        memberRevision: snap.memberRevision,
        membershipEpoch: snap.membershipEpoch,
        controlEpoch: snap.controlEpoch,
        consistency: snap.consistency,
        assignedCapabilities: assignedCapabilities(pk),
        effectiveCapabilities: effectiveCapabilities(pk),
        isRoot: !!(live && actorIsRoot(pk, live)),
        conflictCandidates: ms.getConflictCandidates(pk) || [],
      };
    });
  }

  function resolveProfilePresentation(pubkey) {
    const pk = normalizePubkey(pubkey);
    let displayName = '';
    let avatar = '';
    try {
      if (App.profileCache instanceof Map) {
        const p = App.profileCache.get(pk) || App.profileCache.get(pubkey) || {};
        displayName = String(p.display_name || p.name || p.displayName || '').trim();
        avatar = String(p.picture || p.avatar || '').trim();
      }
    } catch (_e) {}
    // Sanitize for display only — never authority
    displayName = displayName.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    return { displayName, avatar };
  }

  const api = {
    UNBLOCK_UI_TRANSACTION_ORDER,
    MEMBER_DIRECTORY_VIEW_CAPABILITIES,
    MEMBER_DIRECTORY_AUTHORITY_SOURCE: 'verified_membership_store',
    DIRECTORY_USES_CENTRAL_MEMBERSHIP_STORE: true,
    BLOCK_OPERATION_CENTRALIZED: true,
    REMOVE_OPERATION_CENTRALIZED: true,
    MEMBER_UI_OPTIMISTIC_AUTHORITY: false,
    canViewDirectory,
    snapshotTarget,
    assignedCapabilities,
    effectiveCapabilities,
    buildDirectoryRows,
    resolveProfilePresentation,
    blockMember,
    resumeBlock,
    unblockMember,
    resumeUnblock,
    removeMember,
    resolveMembershipConflict,
    controlOkForMemberMutation,
    normalizePubkey,
  };

  Object.freeze(api);
  App.MemberAdminOperations = api;
  window.SosMemberAdminOperations = api;
})(typeof window !== 'undefined' ? window : globalThis);
