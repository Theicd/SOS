/**
 * AC6 — Central GROUP_CONTROL mutation builder (allowlisted diffs only).
 * UI must not construct arbitrary control content. Typed SIGN_GROUP_CONTROL only.
 * When V2=false: mutations unavailable (production dark).
 */
(function initGroupControlMutations(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const MUTATION = Object.freeze({
    SET_GROUP_DISPLAY_NAME: 'SET_GROUP_DISPLAY_NAME',
    SET_INVITE_POLICY: 'SET_INVITE_POLICY',
    GRANT_CAPABILITY: 'GRANT_CAPABILITY',
    REVOKE_CAPABILITY: 'REVOKE_CAPABILITY',
    RESOLVE_CONTROL_CONFLICT: 'RESOLVE_CONTROL_CONFLICT',
    ADD_TO_BLOCKLIST: 'ADD_TO_BLOCKLIST',
    REMOVE_FROM_BLOCKLIST: 'REMOVE_FROM_BLOCKLIST',
    CLEAR_MEMBER_CAPABILITIES: 'CLEAR_MEMBER_CAPABILITIES',
  });

  const DISPLAY_NAME_MAX = 80;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }

  function getGCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }

  function getAC() {
    return App.AccessControl || window.SosAccessControl || null;
  }

  function getMS() {
    return App.MembershipState || window.SosMembershipState || null;
  }

  function normalizePubkey(value) {
    const GCS = getGCS();
    if (GCS && typeof GCS.normalizePubkey === 'function') return GCS.normalizePubkey(value);
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function cloneRecord(state) {
    const caps = {};
    Object.keys(state.capabilities || {}).forEach((pk) => {
      caps[pk] = (state.capabilities[pk] || []).slice();
    });
    return {
      schema: 'sos-group-control',
      version: 1,
      groupId: state.groupId,
      controlEpoch: state.controlEpoch,
      rootAdminPubkey: state.rootAdminPubkey,
      capabilities: caps,
      invitePolicy: state.invitePolicy,
      blockedPubkeys: (state.blockedPubkeys || []).slice(),
      membershipEpoch: state.membershipEpoch,
      groupSettings: {
        displayName: state.groupSettings.displayName,
        networkTag: state.groupSettings.networkTag,
      },
      createdAt: Math.floor(Date.now() / 1000),
      membershipRoot: state.membershipRoot || null,
      resolution: null,
    };
  }

  function sanitizeDisplayName(raw) {
    let s = String(raw == null ? '' : raw);
    // Strip HTML tags / angle brackets and control chars
    s = s.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > DISPLAY_NAME_MAX) s = s.slice(0, DISPLAY_NAME_MAX);
    return s;
  }

  function requireVerifiedBase() {
    const GCS = getGCS();
    if (!GCS) throw Object.assign(new Error('NO_GCS'), { code: 'NO_GCS' });
    if (typeof GCS.mutationsBlockedByConflict === 'function' && GCS.mutationsBlockedByConflict()) {
      // Only RESOLVE mutation may proceed — checked by caller
      const err = Object.assign(new Error('CONTROL_CONFLICT'), { code: 'CONTROL_CONFLICT' });
      throw err;
    }
    if (typeof GCS.getStatus === 'function' && GCS.getStatus() !== 'VERIFIED') {
      throw Object.assign(new Error('NO_VERIFIED_CONTROL'), { code: 'NO_VERIFIED_CONTROL' });
    }
    const st = GCS.getVerifiedControlState();
    if (!st || st.verified !== true) {
      throw Object.assign(new Error('NO_VERIFIED_CONTROL'), { code: 'NO_VERIFIED_CONTROL' });
    }
    return st;
  }

  function actorIsRoot(actorPubkey, state) {
    return normalizePubkey(actorPubkey) === normalizePubkey(state.rootAdminPubkey);
  }

  function actorHas(actorPubkey, capability, state) {
    if (actorIsRoot(actorPubkey, state)) return true;
    const AC = getAC();
    if (AC && typeof AC.hasCapability === 'function') {
      return AC.hasCapability(actorPubkey, capability) === true;
    }
    const list = (state.capabilities && state.capabilities[normalizePubkey(actorPubkey)]) || [];
    return list.indexOf(capability) !== -1;
  }

  function memberStatus(pubkey) {
    const MS = getMS();
    if (!MS || typeof MS.getMemberState !== 'function') return 'UNKNOWN';
    if (MS.ensureCache) MS.ensureCache();
    return MS.getMemberState(pubkey);
  }

  function assertGrantTarget(targetPubkey, state) {
    const pk = normalizePubkey(targetPubkey);
    if (!pk) throw Object.assign(new Error('INVALID_PUBKEY'), { code: 'INVALID_PUBKEY' });
    if (pk === normalizePubkey(state.rootAdminPubkey)) {
      throw Object.assign(new Error('ROOT_TARGET_FORBIDDEN'), { code: 'ROOT_TARGET_FORBIDDEN' });
    }
    const st = memberStatus(pk);
    if (st === 'BLOCKED') {
      throw Object.assign(new Error('TARGET_BLOCKED'), { code: 'TARGET_BLOCKED' });
    }
    if (st === 'REMOVED') {
      throw Object.assign(new Error('TARGET_REMOVED'), { code: 'TARGET_REMOVED' });
    }
    if (st === 'CONFLICT') {
      throw Object.assign(new Error('TARGET_CONFLICT'), { code: 'TARGET_CONFLICT' });
    }
    // ACTIVE preferred; UNKNOWN allowed only for explicit entry when MS not enforcing yet
    return pk;
  }

  function assertCapabilityToken(cap) {
    const GCS = getGCS();
    const allowed = (GCS && GCS.MAP_CAPABILITIES) || [];
    if (cap === 'ROOT_ADMIN') {
      throw Object.assign(new Error('ROOT_ADMIN_NOT_GRANTABLE'), { code: 'ROOT_ADMIN_NOT_GRANTABLE' });
    }
    if (allowed.indexOf(cap) === -1) {
      throw Object.assign(new Error('UNKNOWN_CAPABILITY'), { code: 'UNKNOWN_CAPABILITY' });
    }
    return cap;
  }

  function delegableSet() {
    const GCS = getGCS();
    return new Set((GCS && GCS.DELEGABLE_BY_PERMISSION_MANAGER) || []);
  }

  /**
   * Build next control record from verified base + allowlisted mutation.
   * Does not sign. Re-reads verified state (caller should pass fresh baseEventId).
   */
  function buildNextControlState(currentVerifiedState, mutation, actorPubkey) {
    if (!isV2()) {
      throw Object.assign(new Error('V2_REQUIRED'), { code: 'V2_REQUIRED' });
    }
    const GCS = getGCS();
    if (!GCS) throw Object.assign(new Error('NO_GCS'), { code: 'NO_GCS' });

    const type = mutation && mutation.type;
    if (!MUTATION[type]) {
      throw Object.assign(new Error('UNKNOWN_MUTATION'), { code: 'UNKNOWN_MUTATION' });
    }

    // Always re-read verified tip — stale forms must not sign
    const live = GCS.getVerifiedControlState();
    const conflicted = typeof GCS.mutationsBlockedByConflict === 'function' && GCS.mutationsBlockedByConflict();

    if (type === MUTATION.RESOLVE_CONTROL_CONFLICT) {
      if (!conflicted) {
        throw Object.assign(new Error('NO_CONFLICT'), { code: 'NO_CONFLICT' });
      }
      if (!live || !live.verified) {
        throw Object.assign(new Error('NO_VERIFIED_BASE'), { code: 'NO_VERIFIED_BASE' });
      }
      const actor = normalizePubkey(actorPubkey);
      if (!actorIsRoot(actor, live)) {
        throw Object.assign(new Error('ROOT_RESOLVE_REQUIRED'), { code: 'ROOT_RESOLVE_REQUIRED' });
      }
      const candidates = GCS.getConflictCandidates ? GCS.getConflictCandidates() : [];
      const next = cloneRecord(live);
      next.controlEpoch = live.controlEpoch + 2; // conflict at +1, resolve at +2
      // Apply optional canonical field overlays from mutation.canonical
      const can = mutation.canonical || {};
      if (typeof can.displayName === 'string') {
        next.groupSettings.displayName = sanitizeDisplayName(can.displayName);
      }
      if (can.invitePolicy && GCS.INVITE_POLICIES.indexOf(can.invitePolicy) !== -1) {
        next.invitePolicy = can.invitePolicy;
      }
      if (can.capabilities && typeof can.capabilities === 'object') {
        next.capabilities = {};
        Object.keys(can.capabilities).forEach((pk) => {
          const npk = normalizePubkey(pk);
          if (!npk) return;
          next.capabilities[npk] = (can.capabilities[pk] || [])
            .map(assertCapabilityToken)
            .filter((c, i, a) => a.indexOf(c) === i)
            .sort();
        });
      }
      next.resolution = {
        type: 'RESOLVE_CONTROL_CONFLICT',
        conflictEpoch: live.controlEpoch + 1,
        conflictingEventIds: candidates.map((c) => c.eventId).filter(Boolean),
      };
      next.createdAt = Math.floor(Date.now() / 1000);
      // Must not change groupId / root / networkTag
      next.groupId = live.groupId;
      next.rootAdminPubkey = live.rootAdminPubkey;
      next.groupSettings.networkTag = live.groupSettings.networkTag;
      return {
        record: GCS.parseAndValidateRecord(GCS.serializeRecord(next)),
        baseEventId: live.eventId,
        baseEpoch: live.controlEpoch,
        mutationType: type,
      };
    }

    if (conflicted) {
      throw Object.assign(new Error('CONTROL_CONFLICT'), { code: 'CONTROL_CONFLICT' });
    }

    const base = live || currentVerifiedState;
    if (!base || !base.verified) {
      throw Object.assign(new Error('NO_VERIFIED_CONTROL'), { code: 'NO_VERIFIED_CONTROL' });
    }
    if (currentVerifiedState && currentVerifiedState.eventId && currentVerifiedState.eventId !== base.eventId) {
      throw Object.assign(new Error('STALE_BASE'), { code: 'STALE_BASE' });
    }
    if (currentVerifiedState && Number(currentVerifiedState.controlEpoch) !== Number(base.controlEpoch)) {
      throw Object.assign(new Error('STALE_BASE'), { code: 'STALE_BASE' });
    }

    const actor = normalizePubkey(actorPubkey);
    if (!actor) throw Object.assign(new Error('NO_ACTOR'), { code: 'NO_ACTOR' });

    // Membership-suppressed delegated admins cannot mutate
    if (!actorIsRoot(actor, base)) {
      const MS = getMS();
      if (MS && MS.isV2 && MS.isV2()) {
        const st = memberStatus(actor);
        if (st === 'BLOCKED' || st === 'REMOVED' || st === 'CONFLICT') {
          throw Object.assign(new Error('MEMBERSHIP_BLOCKS_ADMIN'), { code: 'MEMBERSHIP_BLOCKS_ADMIN' });
        }
        if (st !== 'ACTIVE' && st !== 'UNKNOWN') {
          throw Object.assign(new Error('MEMBERSHIP_BLOCKS_ADMIN'), { code: 'MEMBERSHIP_BLOCKS_ADMIN' });
        }
      }
    }

    const next = cloneRecord(base);
    next.controlEpoch = base.controlEpoch + 1;
    next.createdAt = Math.floor(Date.now() / 1000);

    if (type === MUTATION.SET_GROUP_DISPLAY_NAME) {
      if (!actorHas(actor, 'MANAGE_GROUP_SETTINGS', base) && !actorIsRoot(actor, base)) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      const name = sanitizeDisplayName(mutation.displayName);
      if (!name) throw Object.assign(new Error('EMPTY_DISPLAY_NAME'), { code: 'EMPTY_DISPLAY_NAME' });
      next.groupSettings.displayName = name;
      // allowlist: only displayName
    } else if (type === MUTATION.SET_INVITE_POLICY) {
      if (!actorHas(actor, 'MANAGE_INVITES', base) && !actorIsRoot(actor, base)) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      const policy = mutation.invitePolicy;
      if (!GCS.INVITE_POLICIES || GCS.INVITE_POLICIES.indexOf(policy) === -1) {
        throw Object.assign(new Error('BAD_INVITE_POLICY'), { code: 'BAD_INVITE_POLICY' });
      }
      next.invitePolicy = policy;
    } else if (type === MUTATION.GRANT_CAPABILITY || type === MUTATION.REVOKE_CAPABILITY) {
      if (
        !actorHas(actor, 'MANAGE_PERMISSIONS', base) &&
        !actorHas(actor, 'MANAGE_ADMINS', base) &&
        !actorIsRoot(actor, base)
      ) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      const target = assertGrantTarget(mutation.targetPubkey, base);
      const cap = assertCapabilityToken(mutation.capability);
      const isRootActor = actorIsRoot(actor, base);
      if (!isRootActor) {
        if (!delegableSet().has(cap)) {
          throw Object.assign(new Error('DELEGATION_ESCALATION'), { code: 'DELEGATION_ESCALATION' });
        }
        if (cap === 'MANAGE_ADMINS' || cap === 'MANAGE_PERMISSIONS') {
          throw Object.assign(new Error('DELEGATION_ESCALATION'), { code: 'DELEGATION_ESCALATION' });
        }
      }
      // Self-escalation: delegated cannot grant themselves non-delegable (already blocked)
      // Also: cannot grant self MANAGE_* high priv via root path only
      if (!next.capabilities[target]) next.capabilities[target] = [];
      const set = new Set(next.capabilities[target]);
      if (type === MUTATION.GRANT_CAPABILITY) set.add(cap);
      else set.delete(cap);
      next.capabilities[target] = Array.from(set).sort();
      if (next.capabilities[target].length === 0) delete next.capabilities[target];
    } else if (type === MUTATION.ADD_TO_BLOCKLIST || type === MUTATION.REMOVE_FROM_BLOCKLIST) {
      if (
        !actorHas(actor, 'MANAGE_BLOCKLIST', base) &&
        !actorHas(actor, 'MANAGE_MEMBERS', base) &&
        !actorIsRoot(actor, base)
      ) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      const target = normalizePubkey(mutation.targetPubkey);
      if (!target) throw Object.assign(new Error('BAD_PUBKEY'), { code: 'BAD_PUBKEY' });
      if (target === normalizePubkey(base.rootAdminPubkey)) {
        throw Object.assign(new Error('ROOT_PROTECTED'), { code: 'ROOT_PROTECTED' });
      }
      const set = new Set(base.blockedPubkeys || []);
      if (type === MUTATION.ADD_TO_BLOCKLIST) set.add(target);
      else set.delete(target);
      next.blockedPubkeys = Array.from(set).sort();
    } else if (type === MUTATION.CLEAR_MEMBER_CAPABILITIES) {
      if (
        !actorHas(actor, 'MANAGE_PERMISSIONS', base) &&
        !actorHas(actor, 'MANAGE_ADMINS', base) &&
        !actorIsRoot(actor, base)
      ) {
        throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
      }
      const target = normalizePubkey(mutation.targetPubkey);
      if (!target) throw Object.assign(new Error('BAD_PUBKEY'), { code: 'BAD_PUBKEY' });
      if (target === normalizePubkey(base.rootAdminPubkey)) {
        throw Object.assign(new Error('ROOT_PROTECTED'), { code: 'ROOT_PROTECTED' });
      }
      delete next.capabilities[target];
    } else {
      throw Object.assign(new Error('UNKNOWN_MUTATION'), { code: 'UNKNOWN_MUTATION' });
    }

    // Immutable fields (blockedPubkeys / capabilities only when allowlisted above)
    next.groupId = base.groupId;
    next.rootAdminPubkey = base.rootAdminPubkey;
    next.groupSettings.networkTag = base.groupSettings.networkTag;
    next.membershipEpoch = base.membershipEpoch;
    if (
      type !== MUTATION.ADD_TO_BLOCKLIST &&
      type !== MUTATION.REMOVE_FROM_BLOCKLIST
    ) {
      next.blockedPubkeys = (base.blockedPubkeys || []).slice();
    }
    if (
      type !== MUTATION.GRANT_CAPABILITY &&
      type !== MUTATION.REVOKE_CAPABILITY &&
      type !== MUTATION.CLEAR_MEMBER_CAPABILITIES &&
      type !== MUTATION.RESOLVE_CONTROL_CONFLICT
    ) {
      // keep capabilities identical for non-cap mutations (already cloned)
      next.capabilities = cloneRecord(base).capabilities;
      if (type === MUTATION.SET_GROUP_DISPLAY_NAME || type === MUTATION.SET_INVITE_POLICY) {
        /* already mutated only allowlisted field */
      }
    }

    return {
      record: GCS.parseAndValidateRecord(GCS.serializeRecord(next)),
      baseEventId: base.eventId,
      baseEpoch: base.controlEpoch,
      mutationType: type,
    };
  }

  /**
   * Full pipeline: authorize → build → sign → publish → verify → apply.
   * Returns result; does not optimistically grant authority.
   */
  async function applyControlMutation(mutation, actorPubkey, opts) {
    const options = opts || {};
    const GCS = getGCS();
    if (!isV2()) {
      return { ok: false, code: 'V2_REQUIRED' };
    }
    let built;
    try {
      built = buildNextControlState(options.baseState || null, mutation, actorPubkey);
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'BUILD_FAILED', error: e && e.message };
    }

    // Re-check base not stale immediately before sign
    const live = GCS.getVerifiedControlState();
    if (!mutation || mutation.type !== MUTATION.RESOLVE_CONTROL_CONFLICT) {
      if (!live || live.eventId !== built.baseEventId) {
        return { ok: false, code: 'STALE_BASE' };
      }
    }

    let signed;
    try {
      const S = App.SosCryptoSigner;
      if (!S || typeof S.signGroupControlEvent !== 'function') {
        return { ok: false, code: 'SIGNER_MISSING' };
      }
      const draft = GCS.buildSignDraft(built.record, normalizePubkey(actorPubkey));
      signed = await Promise.resolve(S.signGroupControlEvent(draft));
    } catch (e) {
      return { ok: false, code: 'SIGN_FAILED', error: e && e.message };
    }

    if (options.skipPublish) {
      const acc = GCS.acceptControlEvent(signed);
      return { ok: acc.ok, code: acc.code || acc.status, accept: acc, event: signed, built };
    }

    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      return { ok: false, code: 'NO_RELAYS', event: signed, built };
    }
    try {
      await App.pool.publish(App.relayUrls, signed);
    } catch (e) {
      return { ok: false, code: 'PUBLISH_FAILED', error: e && e.message, event: signed, built };
    }

    const acc = GCS.acceptControlEvent(signed);
    if (!acc.ok) {
      return { ok: false, code: acc.code || 'VERIFY_FAILED', accept: acc, event: signed, built };
    }
    return { ok: true, code: 'APPLIED', accept: acc, event: signed, built };
  }

  const api = {
    MUTATION,
    DISPLAY_NAME_MAX,
    buildNextControlState,
    applyControlMutation,
    sanitizeDisplayName,
    normalizePubkey,
    memberStatus,
    requireVerifiedBase,
    CONTROL_UPDATE_BUILDER_CENTRALIZED: true,
    CONTROL_MUTATION_DIFF_ALLOWLIST: true,
  };

  Object.freeze(api);
  App.GroupControlMutations = api;
  window.SosGroupControlMutations = api;
})(typeof window !== 'undefined' ? window : globalThis);
