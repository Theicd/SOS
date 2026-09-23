/**
 * AC8 — Central guest authorization (deny-by-default explicit allowlist).
 * Does not grant registered/admin/membership authority.
 * XSS isolation is NOT claimed (F5B).
 */
(function initGuestAccessControl(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const PRINCIPAL = Object.freeze({
    REGISTERED: 'REGISTERED',
    GUEST_P2P: 'GUEST_P2P',
    UNKNOWN: 'UNKNOWN',
  });

  /** Explicit guest allowlist — nothing else. */
  const GUEST_CAPABILITY = Object.freeze({
    READ_PUBLIC_CONTENT: 'READ_PUBLIC_CONTENT',
    P2P_SIGNAL_PUBLIC_30078: 'P2P_SIGNAL_PUBLIC_30078',
    P2P_FILE_TORRENT: 'P2P_FILE_TORRENT',
  });

  const GUEST_CAPABILITY_ALLOWLIST = Object.freeze([
    GUEST_CAPABILITY.READ_PUBLIC_CONTENT,
    GUEST_CAPABILITY.P2P_SIGNAL_PUBLIC_30078,
    GUEST_CAPABILITY.P2P_FILE_TORRENT,
  ]);

  const GUEST_CAP_SET = new Set(GUEST_CAPABILITY_ALLOWLIST);

  /** Actions explicitly denied for guests (documentation + canGuestAction). */
  const GUEST_DENIED_ACTIONS = Object.freeze([
    'POST',
    'COMMENT',
    'REACTION',
    'FOLLOW',
    'UNFOLLOW',
    'DIRECT_MESSAGE',
    'GROUP_CHAT',
    'PRESENCE',
    'VOICE',
    'CALL',
    'PROFILE_EDIT',
    'INVITE_CREATE',
    'INVITE_REDEEM',
    'DELETE_OWN',
    'MODERATE_CONTENT',
    'GROUP_ADMIN',
    'MEMBER_BLOCK',
    'MEMBER_REMOVE',
    'CAPABILITY_GRANT',
    'GROUP_SETTINGS',
    'GROUP_MEDIA_PUBLISH',
  ]);

  function normalizePubkey(value) {
    const s = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(s)) return '';
    return s;
  }

  /**
   * Central principal classification.
   * Does NOT trust App.guestMode / DOM / localStorage / profile alone.
   */
  function classifyPrincipal(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return PRINCIPAL.UNKNOWN;

    try {
      const V = App.GuestP2PKeyVault || window.SosGuestP2PKeyVault;
      if (V && typeof V.getMetaSync === 'function') {
        const meta = V.getMetaSync();
        if (meta && meta.ready && normalizePubkey(meta.publicKey) === pk) {
          return PRINCIPAL.GUEST_P2P;
        }
      }
    } catch (_e) {}

    try {
      if (
        App.SosCryptoSigner &&
        typeof App.SosCryptoSigner.hasIdentityKey === 'function' &&
        App.SosCryptoSigner.hasIdentityKey() === true &&
        normalizePubkey(App.publicKey) === pk
      ) {
        return PRINCIPAL.REGISTERED;
      }
    } catch (_e2) {}

    // Valid hex alone is never enough for guest/admin authority.
    return PRINCIPAL.UNKNOWN;
  }

  function isGuestP2PPrincipal(pubkey) {
    return classifyPrincipal(pubkey) === PRINCIPAL.GUEST_P2P;
  }

  function guestHasCapability(capability) {
    if (typeof capability !== 'string') return false;
    return GUEST_CAP_SET.has(capability);
  }

  /**
   * Deny-by-default guest action check.
   * Only allowlist capabilities map to true; denied actions always false.
   */
  function canGuestAction(action) {
    if (typeof action !== 'string') return false;
    const a = action.trim().toUpperCase();
    if (GUEST_DENIED_ACTIONS.indexOf(a) !== -1) return false;
    if (a === 'READ_PUBLIC_CONTENT') return true;
    if (a === 'P2P_SIGNAL_PUBLIC_30078' || a === 'P2P_SIGNAL') return true;
    if (a === 'P2P_FILE_TORRENT' || a === 'P2P_FILE' || a === 'TORRENT') return true;
    return false;
  }

  function isControlPlaneEligible(pubkey) {
    if (isGuestP2PPrincipal(pubkey)) return false;
    const AC = App.AccessControl || window.SosAccessControl;
    if (AC && typeof AC.isControlPlaneEligible === 'function') {
      return AC.isControlPlaneEligible(pubkey) === true;
    }
    return classifyPrincipal(pubkey) === PRINCIPAL.REGISTERED;
  }

  function canReceiveAdminCapability(pubkey) {
    if (isGuestP2PPrincipal(pubkey)) return false;
    return false; // guests never; registered grants go through AccessControl/GroupControl
  }

  function canReceiveMembershipState(pubkey) {
    if (isGuestP2PPrincipal(pubkey)) return false;
    return classifyPrincipal(pubkey) === PRINCIPAL.REGISTERED;
  }

  function canBeMemberDirectoryPrincipal(pubkey) {
    if (isGuestP2PPrincipal(pubkey)) return false;
    return classifyPrincipal(pubkey) === PRINCIPAL.REGISTERED;
  }

  /**
   * Formal V2 guest P2P membership exception.
   * REGISTERED + V2 ON → membership-gated group_p2p_signal
   * GUEST_P2P → public guest P2P only (no membership)
   * UNKNOWN → deny
   */
  function canUseGroupP2P(pubkey, context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const cls = classifyPrincipal(pubkey);
    const v2 = window.SOS_ACCESS_CONTROL_V2 === true;

    if (cls === PRINCIPAL.UNKNOWN) {
      return { ok: false, code: 'UNKNOWN_PRINCIPAL', class: cls };
    }

    if (cls === PRINCIPAL.GUEST_P2P) {
      if (ctx.requireRegistered === true) {
        return { ok: false, code: 'GUEST_NOT_REGISTERED_P2P', class: cls };
      }
      if (ctx.signalClass === 'PEER_TARGETED_PRIVATE') {
        return { ok: false, code: 'GUEST_PRIVATE_P2P_DENIED', class: cls };
      }
      // Exception: guest public 30078 / file-torrent without membership
      return {
        ok: true,
        code: 'GUEST_P2P_PUBLIC_EXCEPTION',
        class: cls,
        grantsMembership: false,
        grantsControlCapability: false,
      };
    }

    // REGISTERED
    if (!v2) {
      return { ok: true, code: 'LEGACY_V2_OFF', class: cls };
    }
    const MS = App.MembershipState || window.SosMembershipState;
    if (!MS || typeof MS.canPerformMemberAction !== 'function') {
      return { ok: false, code: 'MEMBERSHIP_UNAVAILABLE', class: cls };
    }
    if (typeof MS.ensureCache === 'function') MS.ensureCache();
    const gated = MS.canPerformMemberAction(pubkey, 'group_p2p_signal');
    if (!gated || gated.ok !== true) {
      return {
        ok: false,
        code: (gated && gated.code) || 'MEMBERSHIP_DENIED',
        class: cls,
      };
    }
    return { ok: true, code: gated.code || 'ACTIVE', class: cls };
  }

  const api = Object.freeze({
    PRINCIPAL,
    GUEST_CAPABILITY,
    GUEST_CAPABILITY_ALLOWLIST,
    GUEST_DENIED_ACTIONS,
    GUEST_AUTHORIZATION_MODEL: 'explicit_allowlist',
    GUEST_DEFAULT_ALLOW: false,
    classifyPrincipal,
    isGuestP2PPrincipal,
    guestHasCapability,
    canGuestAction,
    isControlPlaneEligible,
    canReceiveAdminCapability,
    canReceiveMembershipState,
    canBeMemberDirectoryPrincipal,
    canUseGroupP2P,
    /** Honest XSS boundary — AC8 does not fix these. */
    AC8_CLAIMS_XSS_ISOLATION: false,
    SAME_ORIGIN_XSS_CAN_READ_GUEST_WRAP_KEY: true,
    SAME_ORIGIN_XSS_CAN_EXTRACT_GUEST_K: true,
    SAME_ORIGIN_XSS_CAN_REQUEST_GUEST_SIGNATURE: true,
  });

  App.GuestAccessControl = api;
  window.SosGuestAccessControl = api;
})(typeof window !== 'undefined' ? window : globalThis);
