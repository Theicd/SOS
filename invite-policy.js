/**
 * AC3 — Central invite policy engine.
 * When SOS_ACCESS_CONTROL_V2=false: callers use legacy invite-service paths.
 * When V2=true: authorization from CURRENT verified GROUP_CONTROL_STATE only.
 * Relays are transport, not authority. No private keys.
 */
(function initInvitePolicy(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const INVITE_CREATE_EVENT_KIND = 37378;
  const INVITE_USED_EVENT_KIND = 37379;
  /** Collision-free revoke kind (same custom band as invite 37378/9). */
  const INVITE_REVOKE_EVENT_KIND = 37380;
  /** NIP-01 parameterized replaceable (30000–39999). Intentional: one live revoke tip per invite via d=inviteEventId. */
  const INVITE_REVOKE_KIND_CLASS = 'parameterized-replaceable';
  const INVITE_REVOKE_PARAMETERIZED_REPLACEABLE_INTENTIONAL = true;
  /** Canonical d-tag = lowercase invite event id (64-hex). */
  const INVITE_REVOKE_D_TAG_RULE = 'd === inviteEvent.id (lowercase 64-hex)';
  /** e-tag mirrors invite id for NIP-01 event reference compatibility (same value as d). */
  const INVITE_REVOKE_E_TAG_RULE = 'e === inviteEvent.id (optional-but-if-present must match d)';
  const INVITE_REVOKE_D_TAG_REQUIRED = true;

  const ADMIN_PRINCIPAL_CAPABILITY_SET = Object.freeze([
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
  ]);
  const ADMIN_SET = new Set(ADMIN_PRINCIPAL_CAPABILITY_SET);

  const CURRENT_REGISTERED_INVITER_PREDICATE =
    'SosCryptoSigner.hasIdentityKey() === true && App.guestMode !== true';

  const INVITE_AUTHORIZATION_EVALUATION = 'current_verified_control_state';

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function resolveGroupId() {
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) return App.NETWORK_TAG.trim();
    return 'israel-network';
  }

  function getGCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }

  function getAC() {
    return App.AccessControl || window.SosAccessControl || null;
  }

  function getVerifiedControlOrNull() {
    const GCS = getGCS();
    if (!GCS || typeof GCS.getVerifiedControlState !== 'function') return null;
    if (typeof GCS.getStatus === 'function' && GCS.getStatus() !== 'VERIFIED') return null;
    const st = GCS.getVerifiedControlState();
    if (!st || st.verified !== true) return null;
    if (st.groupId !== resolveGroupId()) return null;
    return st;
  }

  function isGuestPrincipal(pubkey) {
    const AC = getAC();
    if (AC && typeof AC.isGuestPrincipal === 'function') {
      return AC.isGuestPrincipal(pubkey) === true;
    }
    if (App.guestMode === true) return true;
    return false;
  }

  function isRegisteredInviterLegacy(pubkey) {
    const pk = normalizePubkey(pubkey) || normalizePubkey(App.publicKey);
    if (!pk) return false;
    if (isGuestPrincipal(pk) || App.guestMode === true) return false;
    const S = App.SosCryptoSigner;
    if (S && typeof S.hasIdentityKey === 'function' && !S.hasIdentityKey()) return false;
    return true;
  }

  function capsFor(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !controlState) return [];
    if (pk === controlState.rootAdminPubkey) {
      return ['ROOT_ADMIN'].concat(ADMIN_PRINCIPAL_CAPABILITY_SET).concat(['INVITE_USERS', 'VIEW_AUDIT_LOG']);
    }
    const list = (controlState.capabilities && controlState.capabilities[pk]) || [];
    return Array.isArray(list) ? list.slice() : [];
  }

  function hasCap(pubkey, controlState, cap) {
    return capsFor(pubkey, controlState).indexOf(cap) !== -1;
  }

  function isAdminPrincipal(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !controlState) return false;
    if (pk === controlState.rootAdminPubkey) return true;
    const caps = capsFor(pk, controlState);
    return caps.some((c) => ADMIN_SET.has(c));
  }

  function canCreateInvite(pubkey, controlState, context) {
    const ctx = context || {};
    const pk = normalizePubkey(pubkey) || normalizePubkey(App.publicKey);
    if (!pk) return { ok: false, code: 'NO_PRINCIPAL' };
    if (isGuestPrincipal(pk) || App.guestMode === true || ctx.forceGuest === true) {
      return { ok: false, code: 'GUEST_DENIED' };
    }

    if (!isV2()) {
      return isRegisteredInviterLegacy(pk)
        ? { ok: true, policy: 'LEGACY', code: 'LEGACY_REGISTERED' }
        : { ok: false, code: 'LEGACY_DENIED' };
    }

    const state = controlState || getVerifiedControlOrNull();
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };

    const policy = state.invitePolicy;
    if (policy === 'EVERYONE') {
      return isRegisteredInviterLegacy(pk)
        ? { ok: true, policy, code: 'EVERYONE_REGISTERED' }
        : { ok: false, code: 'EVERYONE_DENIED' };
    }
    if (policy === 'AUTHORIZED_USERS_ONLY') {
      if (pk === state.rootAdminPubkey || hasCap(pk, state, 'INVITE_USERS')) {
        return { ok: true, policy, code: 'AUTHORIZED' };
      }
      return { ok: false, code: 'AUTHORIZED_DENIED' };
    }
    if (policy === 'ADMINS_ONLY') {
      if (isAdminPrincipal(pk, state)) return { ok: true, policy, code: 'ADMIN' };
      return { ok: false, code: 'ADMINS_DENIED' };
    }
    return { ok: false, code: 'UNKNOWN_POLICY' };
  }

  function readTag(event, name) {
    if (!event || !Array.isArray(event.tags)) return '';
    const row = event.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null);
    return row ? String(row[1]) : '';
  }

  function readAllTags(event, name) {
    if (!event || !Array.isArray(event.tags)) return [];
    return event.tags.filter((t) => Array.isArray(t) && t[0] === name).map((t) => String(t[1] || ''));
  }

  function eventHasNetworkTag(event, groupId) {
    const ts = readAllTags(event, 't');
    return ts.indexOf(groupId) !== -1;
  }

  function strictVerify(event) {
    if (typeof App.strictVerifyNostrEvent === 'function') {
      return App.strictVerifyNostrEvent(event) === true;
    }
    const NT = window.NostrTools;
    if (!NT || typeof NT.verifyEvent !== 'function') return false;
    try {
      return NT.verifyEvent(event) === true;
    } catch (_e) {
      return false;
    }
  }

  async function sha256Hex(value) {
    const data = new TextEncoder().encode(String(value || ''));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Validate a create-invite event for redemption under CURRENT control state (V2).
   */
  function validateInviteEvent(event, controlState, context) {
    const ctx = context || {};
    if (!event || event.kind !== (App.INVITE_KIND || INVITE_CREATE_EVENT_KIND)) {
      return { ok: false, code: 'BAD_KIND' };
    }
    if (!strictVerify(event)) return { ok: false, code: 'STRICT_VERIFY_FAILED' };

    const groupId = resolveGroupId();
    if (!eventHasNetworkTag(event, groupId)) {
      return { ok: false, code: 'CROSS_GROUP' };
    }

    const creator = normalizePubkey(event.pubkey);
    if (!creator) return { ok: false, code: 'BAD_CREATOR' };

    if (!isV2()) {
      return { ok: true, code: 'LEGACY', creatorPubkey: creator };
    }

    const state = controlState || getVerifiedControlOrNull();
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };

    const auth = canCreateInvite(creator, state, ctx);
    if (!auth.ok) {
      return { ok: false, code: 'CREATOR_UNAUTHORIZED', detail: auth.code };
    }
    return {
      ok: true,
      code: 'V2_OK',
      creatorPubkey: creator,
      controlEpochAtCreate: Number(readTag(event, 'control-epoch')) || null,
      inviteEventId: event.id,
    };
  }

  function canRedeemInvite(inviteEvent, controlState, context) {
    const base = validateInviteEvent(inviteEvent, controlState, context);
    if (!base.ok) return base;
    if (context && context.revoked === true) {
      return { ok: false, code: 'REVOKED' };
    }
    if (context && context.used === true) {
      return { ok: false, code: 'USED' };
    }
    return base;
  }

  function canRevokeInvite(actorPubkey, inviteEvent, controlState) {
    const pk = normalizePubkey(actorPubkey);
    if (!pk || !inviteEvent) return { ok: false, code: 'BAD_INPUT' };
    const creator = normalizePubkey(inviteEvent.pubkey);
    if (!isV2()) {
      // Legacy: no revoke protocol
      return { ok: false, code: 'LEGACY_NO_REVOKE' };
    }
    const state = controlState || getVerifiedControlOrNull();
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };
    if (pk === state.rootAdminPubkey) return { ok: true, code: 'ROOT' };
    if (hasCap(pk, state, 'MANAGE_INVITES')) return { ok: true, code: 'MANAGE_INVITES' };
    if (pk === creator) return { ok: true, code: 'CREATOR' };
    return { ok: false, code: 'UNAUTHORIZED' };
  }

  function validateRevokeEvent(revokeEvent, inviteEvent, controlState) {
    if (!revokeEvent || revokeEvent.kind !== INVITE_REVOKE_EVENT_KIND) {
      return { ok: false, code: 'BAD_KIND' };
    }
    if (!strictVerify(revokeEvent)) return { ok: false, code: 'STRICT_VERIFY_FAILED' };
    const groupId = resolveGroupId();
    if (!eventHasNetworkTag(revokeEvent, groupId)) return { ok: false, code: 'CROSS_GROUP' };
    const d = readTag(revokeEvent, 'd');
    if (!d) return { ok: false, code: 'MISSING_D_TAG' };
    const inviteId = inviteEvent && inviteEvent.id ? String(inviteEvent.id).toLowerCase() : '';
    if (!inviteId) return { ok: false, code: 'NO_INVITE' };
    if (d.toLowerCase() !== inviteId) return { ok: false, code: 'WRONG_D_TAG' };
    const eRef = readTag(revokeEvent, 'e');
    if (eRef && eRef.toLowerCase() !== inviteId) return { ok: false, code: 'BAD_E_REF' };
    const auth = canRevokeInvite(revokeEvent.pubkey, inviteEvent, controlState);
    if (!auth.ok) return { ok: false, code: 'UNAUTHORIZED_REVOKE' };
    return { ok: true, code: 'REVOKED', by: normalizePubkey(revokeEvent.pubkey) };
  }

  /**
   * invite-used acceptance: must reference invite id; V2 requires ih match when provided.
   * Random party without redeem session cannot forge official mark-used easily when code not on relay.
   */
  function validateUsedEvent(usedEvent, inviteEvent, expectedIh) {
    if (!usedEvent || usedEvent.kind !== (App.INVITE_USED_KIND || INVITE_USED_EVENT_KIND)) {
      return { ok: false, code: 'BAD_KIND' };
    }
    if (!strictVerify(usedEvent)) return { ok: false, code: 'STRICT_VERIFY_FAILED' };
    if (!inviteEvent || !inviteEvent.id) return { ok: false, code: 'NO_INVITE' };
    const eRef = readTag(usedEvent, 'e');
    if (!eRef || eRef.toLowerCase() !== String(inviteEvent.id).toLowerCase()) {
      return { ok: false, code: 'MISSING_E_REF' };
    }
    if (isV2() && expectedIh) {
      const ih = readTag(usedEvent, 'ih');
      if (ih !== expectedIh) return { ok: false, code: 'IH_MISMATCH' };
    }
    return { ok: true, code: 'USED_OK' };
  }

  function buildPolicyChangeRecord(nextPolicy, opts) {
    const GCS = getGCS();
    if (!GCS) throw Object.assign(new Error('GCS_MISSING'), { code: 'GCS_MISSING' });
    const prev = getVerifiedControlOrNull();
    if (!prev) throw Object.assign(new Error('NO_VERIFIED_CONTROL'), { code: 'NO_VERIFIED_CONTROL' });
    const policies = GCS.INVITE_POLICIES || ['EVERYONE', 'AUTHORIZED_USERS_ONLY', 'ADMINS_ONLY'];
    if (policies.indexOf(nextPolicy) === -1) {
      throw Object.assign(new Error('BAD_POLICY'), { code: 'BAD_POLICY' });
    }
    const actor = normalizePubkey((opts && opts.actorPubkey) || App.publicKey);
    if (!actor) throw Object.assign(new Error('NO_ACTOR'), { code: 'NO_ACTOR' });
    if (actor !== prev.rootAdminPubkey && !hasCap(actor, prev, 'MANAGE_INVITES')) {
      throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' });
    }
    const createdAt = (opts && opts.createdAt) || Math.floor(Date.now() / 1000);
    const next = GCS.parseAndValidateRecord(
      JSON.stringify({
        schema: 'sos-group-control',
        version: 1,
        groupId: prev.groupId,
        controlEpoch: prev.controlEpoch + 1,
        rootAdminPubkey: prev.rootAdminPubkey,
        capabilities: prev.capabilities || {},
        invitePolicy: nextPolicy,
        blockedPubkeys: prev.blockedPubkeys || [],
        membershipEpoch: prev.membershipEpoch,
        groupSettings: prev.groupSettings,
        createdAt,
      })
    );
    // Scope: only invitePolicy may change for MANAGE_INVITES (root may change only policy here too)
    return {
      record: next,
      audit: {
        changedBy: actor,
        oldPolicy: prev.invitePolicy,
        newPolicy: nextPolicy,
        controlEpoch: next.controlEpoch,
        timestamp: createdAt,
      },
    };
  }

  async function signAndAcceptPolicyChange(nextPolicy, opts) {
    const GCS = getGCS();
    const built = buildPolicyChangeRecord(nextPolicy, opts);
    if (!GCS || typeof GCS.signControlRecord !== 'function') {
      throw Object.assign(new Error('SIGNER_MISSING'), { code: 'SIGNER_MISSING' });
    }
    const event = await GCS.signControlRecord(built.record);
    const acc = GCS.acceptControlEvent(event);
    if (!acc.ok) {
      throw Object.assign(new Error(acc.code || 'ACCEPT_FAILED'), { code: acc.code || 'ACCEPT_FAILED' });
    }
    return { event, record: acc.record, audit: built.audit };
  }

  function getInvitePolicy() {
    if (!isV2()) return null;
    const st = getVerifiedControlOrNull();
    return st ? st.invitePolicy : null;
  }

  /** Session redeem gate — set after successful validateInvite for mark-used. */
  let redeemSession = null;

  function setRedeemSession(payload) {
    redeemSession = payload
      ? Object.freeze({
          code: String(payload.code || '').toUpperCase(),
          inviteEventId: String(payload.inviteEventId || '').toLowerCase(),
          ih: payload.ih || '',
          ts: Date.now(),
        })
      : null;
  }

  function consumeRedeemSession(code, inviteEventId) {
    if (!redeemSession) return false;
    const ok =
      redeemSession.code === String(code || '').toUpperCase() &&
      redeemSession.inviteEventId === String(inviteEventId || '').toLowerCase() &&
      Date.now() - redeemSession.ts < 30 * 60 * 1000;
    if (ok) redeemSession = null;
    return ok;
  }

  function peekRedeemSession() {
    return redeemSession;
  }

  const api = {
    INVITE_CREATE_EVENT_KIND,
    INVITE_USED_EVENT_KIND,
    INVITE_REVOKE_EVENT_KIND,
    INVITE_REVOKE_KIND_CLASS,
    INVITE_REVOKE_PARAMETERIZED_REPLACEABLE_INTENTIONAL,
    INVITE_REVOKE_D_TAG_RULE,
    INVITE_REVOKE_E_TAG_RULE,
    INVITE_REVOKE_D_TAG_REQUIRED,
    ADMIN_PRINCIPAL_CAPABILITY_SET,
    CURRENT_REGISTERED_INVITER_PREDICATE,
    INVITE_AUTHORIZATION_EVALUATION,
    INVITE_CREATE_KIND_CLASS: 'custom-kind-in-30000-39999-band (not addressable without d; lookup via #i / #ih)',
    INVITE_USED_KIND_CLASS: 'custom-kind-in-30000-39999-band (used marker; V2 requires e→invite id)',
    INVITE_REVOKE_REFERENCE_MODEL: 'd + e tags = invite event id; no plaintext invite code in revoke',
    canCreateInvite,
    validateInviteEvent,
    canRedeemInvite,
    canRevokeInvite,
    validateRevokeEvent,
    validateUsedEvent,
    getInvitePolicy,
    getVerifiedControlOrNull,
    buildPolicyChangeRecord,
    signAndAcceptPolicyChange,
    sha256Hex,
    setRedeemSession,
    consumeRedeemSession,
    peekRedeemSession,
    isV2,
    isAdminPrincipal,
    hasCap,
    resolveGroupId,
    normalizePubkey,
    readTag,
    eventHasNetworkTag,
    strictVerify,
  };

  Object.freeze(api);
  App.InvitePolicy = api;
  window.SosInvitePolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
