/**
 * AC1/AC2 — Central authorization foundation + signed-control provider hook.
 * Deny-by-default capability API. Principal = pubkey (P) only.
 * No raw K / nsec. SOS_ACCESS_CONTROL_V2 defaults OFF (legacy provider).
 * When V2=true (QA only): SignedGroupControlProvider; invalid/missing → fail closed.
 */
(function initAccessControl(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  /** Feature flag — production default OFF (AC1 foundation only). */
  const FLAG_KEY = 'SOS_ACCESS_CONTROL_V2';
  if (typeof window[FLAG_KEY] === 'undefined') {
    window[FLAG_KEY] = false;
  }

  const CAPABILITY = Object.freeze({
    ROOT_ADMIN: 'ROOT_ADMIN',
    MANAGE_ADMINS: 'MANAGE_ADMINS',
    MANAGE_PERMISSIONS: 'MANAGE_PERMISSIONS',
    MANAGE_GROUP_SETTINGS: 'MANAGE_GROUP_SETTINGS',
    MODERATE_CONTENT: 'MODERATE_CONTENT',
    INVITE_USERS: 'INVITE_USERS',
    MANAGE_INVITES: 'MANAGE_INVITES',
    MANAGE_MEMBERS: 'MANAGE_MEMBERS',
    MANAGE_BLOCKLIST: 'MANAGE_BLOCKLIST',
    VIEW_AUDIT_LOG: 'VIEW_AUDIT_LOG',
  });

  const ADMIN_CAPABILITIES = Object.freeze([
    CAPABILITY.ROOT_ADMIN,
    CAPABILITY.MANAGE_ADMINS,
    CAPABILITY.MANAGE_PERMISSIONS,
    CAPABILITY.MANAGE_GROUP_SETTINGS,
    CAPABILITY.MODERATE_CONTENT,
    CAPABILITY.INVITE_USERS,
    CAPABILITY.MANAGE_INVITES,
    CAPABILITY.MANAGE_MEMBERS,
    CAPABILITY.MANAGE_BLOCKLIST,
    CAPABILITY.VIEW_AUDIT_LOG,
  ]);

  const CAPABILITY_SET = new Set(ADMIN_CAPABILITIES);

  /**
   * Action → required capability (any-of when multiple listed).
   * Wiring deferred to AC2/AC3/AC4 — matrix is the source of truth for future enforcement.
   */
  const ACTION_CAPABILITY_MATRIX = Object.freeze({
    GRANT_ADMIN_CAPABILITY: Object.freeze([CAPABILITY.MANAGE_ADMINS, CAPABILITY.MANAGE_PERMISSIONS]),
    REVOKE_ADMIN_CAPABILITY: Object.freeze([CAPABILITY.MANAGE_ADMINS, CAPABILITY.MANAGE_PERMISSIONS]),
    CHANGE_GROUP_SETTINGS: Object.freeze([CAPABILITY.MANAGE_GROUP_SETTINGS]),
    MODERATE_POST: Object.freeze([CAPABILITY.MODERATE_CONTENT]),
    MODERATE_COMMENT: Object.freeze([CAPABILITY.MODERATE_CONTENT]),
    CREATE_INVITE_PRIVILEGED: Object.freeze([CAPABILITY.INVITE_USERS]),
    REVOKE_INVITE: Object.freeze([CAPABILITY.MANAGE_INVITES]),
    BLOCK_USER: Object.freeze([CAPABILITY.MANAGE_BLOCKLIST, CAPABILITY.MANAGE_MEMBERS]),
    UNBLOCK_USER: Object.freeze([CAPABILITY.MANAGE_BLOCKLIST, CAPABILITY.MANAGE_MEMBERS]),
    REMOVE_USER: Object.freeze([CAPABILITY.MANAGE_MEMBERS]),
    VIEW_ADMIN_AUDIT: Object.freeze([CAPABILITY.VIEW_AUDIT_LOG]),
  });

  /** Reserved signer op names for future AC2+ — not wired into SosCryptoSigner yet. */
  const RESERVED_SIGNER_ADMIN_OPS = Object.freeze([
    'ADMIN_GRANT_PERMISSION',
    'ADMIN_REVOKE_PERMISSION',
    'ADMIN_MODERATE_CONTENT',
    'ADMIN_BLOCK_MEMBER',
    'ADMIN_UNBLOCK_MEMBER',
    'ADMIN_REMOVE_MEMBER',
    'ADMIN_CHANGE_GROUP_SETTINGS',
    'ADMIN_CREATE_INVITE',
    'ADMIN_REVOKE_INVITE',
  ]);

  /** @type {{ groupId: string, epoch: number, rootAdminPubkey: string, capabilitiesByPubkey: Object, invitePolicy: Object|null, blockedPubkeys: string[], membershipEpoch: number, source: string, verified: boolean } | null} */
  let authoritySnapshot = null;

  /** QA-only in-memory overlay — never used unless explicitly installed by gate. */
  let qaOverlay = null;

  function isHex64Pubkey(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim());
  }

  function normalizePubkey(value) {
    if (value == null) return '';
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().toLowerCase().replace(/^0x/, '');
    if (!isHex64Pubkey(trimmed)) return '';
    return trimmed;
  }

  function resolveGroupId() {
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) {
      return App.NETWORK_TAG.trim();
    }
    return 'israel-network';
  }

  /**
   * Legacy bootstrap authority: configured root admin public keys only.
   * Never treats 64-hex config as private K.
   */
  const LegacyRootAuthorityProvider = {
    name: 'LegacyRootAuthorityProvider',
    listRootAdminPubkeys() {
      const out = [];
      const seen = new Set();
      const push = (raw) => {
        const pk = normalizePubkey(raw);
        if (!pk || seen.has(pk)) return;
        seen.add(pk);
        out.push(pk);
      };

      if (Array.isArray(App.adminSourceKeys)) {
        App.adminSourceKeys.forEach(push);
      }
      if (App.adminPublicKeys instanceof Set) {
        App.adminPublicKeys.forEach(push);
      } else if (Array.isArray(App.adminPublicKeys)) {
        App.adminPublicKeys.forEach(push);
      }
      return out;
    },
  };

  function buildLegacySnapshot() {
    const roots = LegacyRootAuthorityProvider.listRootAdminPubkeys();
    const rootAdminPubkey = roots[0] || '';
    const capabilitiesByPubkey = Object.create(null);
    roots.forEach((pk) => {
      capabilitiesByPubkey[pk] = Object.freeze([CAPABILITY.ROOT_ADMIN]);
    });
    return Object.freeze({
      groupId: resolveGroupId(),
      epoch: 0,
      rootAdminPubkey,
      capabilitiesByPubkey: Object.freeze({ ...capabilitiesByPubkey }),
      invitePolicy: null,
      blockedPubkeys: Object.freeze([]),
      membershipEpoch: 0,
      source: 'legacy-config',
      verified: false,
    });
  }

  function refreshAuthorityFromLegacy() {
    authoritySnapshot = buildLegacySnapshot();
    return getAuthoritySnapshot();
  }

  /**
   * AC2 provider — reads GroupControlState verified store only.
   * Never trusts localStorage flags / UI. Cache must already be revalidated by GroupControlState.
   */
  const SignedGroupControlProvider = {
    name: 'SignedGroupControlProvider',
    buildSnapshot() {
      const GCS = App.GroupControlState || window.SosGroupControlState;
      if (!GCS || typeof GCS.getVerifiedControlState !== 'function') {
        return Object.freeze({
          groupId: resolveGroupId(),
          epoch: 0,
          rootAdminPubkey: '',
          capabilitiesByPubkey: Object.freeze({}),
          invitePolicy: null,
          blockedPubkeys: Object.freeze([]),
          membershipEpoch: 0,
          source: 'signed-group-control-missing',
          verified: false,
          controlStatus: 'MISSING',
        });
      }
      const status = typeof GCS.getStatus === 'function' ? GCS.getStatus() : 'MISSING';
      const state = GCS.getVerifiedControlState();
      if (!state || status !== 'VERIFIED' || state.verified !== true) {
        return Object.freeze({
          groupId: resolveGroupId(),
          epoch: 0,
          rootAdminPubkey: '',
          capabilitiesByPubkey: Object.freeze({}),
          invitePolicy: null,
          blockedPubkeys: Object.freeze([]),
          membershipEpoch: 0,
          source: 'signed-group-control-invalid',
          verified: false,
          controlStatus: status || 'INVALID',
        });
      }
      const caps = Object.create(null);
      Object.keys(state.capabilities || {}).forEach((pk) => {
        caps[pk] = Object.freeze((state.capabilities[pk] || []).slice());
      });
      return Object.freeze({
        groupId: state.groupId,
        epoch: state.controlEpoch,
        rootAdminPubkey: state.rootAdminPubkey,
        capabilitiesByPubkey: Object.freeze(caps),
        invitePolicy: state.invitePolicy,
        blockedPubkeys: Object.freeze((state.blockedPubkeys || []).slice()),
        membershipEpoch: state.membershipEpoch || 0,
        source: 'signed-group-control',
        verified: true,
        controlStatus: 'VERIFIED',
      });
    },
  };

  function activeSnapshot() {
    if (qaOverlay) return qaOverlay;
    if (window[FLAG_KEY] === true) {
      return SignedGroupControlProvider.buildSnapshot();
    }
    if (!authoritySnapshot) refreshAuthorityFromLegacy();
    return authoritySnapshot;
  }

  function getAuthoritySnapshot() {
    const snap = activeSnapshot();
    const capsCopy = Object.create(null);
    const src = snap.capabilitiesByPubkey || {};
    Object.keys(src).forEach((pk) => {
      const list = Array.isArray(src[pk]) ? src[pk].slice() : [];
      capsCopy[pk] = Object.freeze(list);
    });
    return Object.freeze({
      groupId: snap.groupId,
      epoch: snap.epoch,
      rootAdminPubkey: snap.rootAdminPubkey || '',
      capabilitiesByPubkey: Object.freeze(capsCopy),
      invitePolicy: snap.invitePolicy,
      blockedPubkeys: Object.freeze([...(snap.blockedPubkeys || [])]),
      membershipEpoch: snap.membershipEpoch || 0,
      source: snap.source,
      verified: snap.verified === true,
    });
  }

  function isGuestPrincipal(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return false;
    try {
      const GAC = App.GuestAccessControl || window.SosGuestAccessControl;
      if (GAC && typeof GAC.classifyPrincipal === 'function') {
        return GAC.classifyPrincipal(pk) === 'GUEST_P2P';
      }
    } catch (_g) {}
    try {
      const V = App.GuestP2PKeyVault || window.SosGuestP2PKeyVault;
      if (V && typeof V.getMetaSync === 'function') {
        const meta = V.getMetaSync();
        if (meta && meta.ready && normalizePubkey(meta.publicKey) === pk) return true;
      }
    } catch (_e) {}
    if (App.guestMode === true && normalizePubkey(App.publicKey) === pk) return true;
    if (App.identityClass === 'EPHEMERAL_GUEST' && normalizePubkey(App.publicKey) === pk) return true;
    return false;
  }

  function capabilityAllowedToken(capability) {
    if (typeof capability !== 'string') return null;
    if (capability !== capability.trim()) return null;
    if (!CAPABILITY_SET.has(capability)) return null;
    return capability;
  }

  function capsForPrincipal(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return Object.freeze([]);
    if (isGuestPrincipal(pk)) return Object.freeze([]);

    const snap = activeSnapshot();
    if (snap.groupId !== resolveGroupId() && snap.source !== 'qa-overlay') {
      // Authority must be bound to current network group id.
      return Object.freeze([]);
    }

    const granted = [];
    const listed = snap.capabilitiesByPubkey && snap.capabilitiesByPubkey[pk];
    if (Array.isArray(listed)) {
      listed.forEach((c) => {
        const tok = capabilityAllowedToken(c);
        if (tok && !granted.includes(tok)) granted.push(tok);
      });
    }

    const isRoot =
      granted.includes(CAPABILITY.ROOT_ADMIN) ||
      (snap.rootAdminPubkey && snap.rootAdminPubkey === pk);

    if (isRoot) {
      return Object.freeze(ADMIN_CAPABILITIES.slice());
    }
    return Object.freeze(granted.slice());
  }

  function hasCapability(pubkey, capability) {
    const tok = capabilityAllowedToken(capability);
    if (!tok) return false;
    const pk = normalizePubkey(pubkey);
    if (!pk) return false;
    // AC5: BLOCKED/REMOVED/UNKNOWN members cannot use delegated capabilities under V2.
    // Root remains effective without depending on a mutable membership tip.
    if (window[FLAG_KEY] === true && tok !== CAPABILITY.ROOT_ADMIN) {
      const MS = App.MembershipState || window.SosMembershipState;
      if (MS && typeof MS.membershipAllowsDelegatedCapability === 'function') {
        if (MS.ensureCache) MS.ensureCache();
        if (!MS.membershipAllowsDelegatedCapability(pk)) return false;
      }
    }
    const caps = capsForPrincipal(pubkey);
    return caps.indexOf(tok) !== -1;
  }

  function requireCapability(pubkey, capability) {
    if (!hasCapability(pubkey, capability)) {
      const err = new Error('ACCESS_DENIED');
      err.code = 'ACCESS_DENIED';
      err.capability = capability;
      throw err;
    }
    return true;
  }

  function can(pubkey, action) {
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_CAPABILITY_MATRIX, action)) {
      return false;
    }
    const needed = ACTION_CAPABILITY_MATRIX[action];
    for (let i = 0; i < needed.length; i++) {
      if (hasCapability(pubkey, needed[i])) return true;
    }
    return false;
  }

  function getCapabilities(pubkey) {
    return capsForPrincipal(pubkey).slice();
  }

  /**
   * Normal API must never grant/revoke ROOT_ADMIN.
   * AC1 foundation: mutations are not supported (deny).
   */
  function grantCapability(_actorPubkey, _targetPubkey, capability) {
    if (capability === CAPABILITY.ROOT_ADMIN) {
      const err = new Error('ROOT_ADMIN_NOT_GRANTABLE');
      err.code = 'ROOT_ADMIN_NOT_GRANTABLE';
      throw err;
    }
    const err = new Error('GRANT_NOT_AVAILABLE_UNTIL_AC2');
    err.code = 'GRANT_NOT_AVAILABLE_UNTIL_AC2';
    throw err;
  }

  function revokeCapability(_actorPubkey, _targetPubkey, capability) {
    if (capability === CAPABILITY.ROOT_ADMIN) {
      const err = new Error('ROOT_ADMIN_NOT_REVOCABLE');
      err.code = 'ROOT_ADMIN_NOT_REVOCABLE';
      throw err;
    }
    const err = new Error('REVOKE_NOT_AVAILABLE_UNTIL_AC2');
    err.code = 'REVOKE_NOT_AVAILABLE_UNTIL_AC2';
    throw err;
  }

  /** Reject any API that looks like raw-K / nsec input. */
  function assertNoPrivateKeyInput(value) {
    if (value == null) return;
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (/^nsec1/i.test(v)) {
      const err = new Error('ACCESS_CONTROL_REJECTS_PRIVATE_KEY');
      err.code = 'ACCESS_CONTROL_REJECTS_PRIVATE_KEY';
      throw err;
    }
    // Do not accept labeled private-key fields via options bags
  }

  function installQaAuthorityOverlay(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      qaOverlay = null;
      return;
    }
    const capsCopy = Object.create(null);
    const src = snapshot.capabilitiesByPubkey || {};
    Object.keys(src).forEach((pk) => {
      const npk = normalizePubkey(pk);
      if (!npk) return;
      const list = Array.isArray(src[pk]) ? src[pk].filter((c) => capabilityAllowedToken(c)) : [];
      // ROOT_ADMIN in QA overlay is allowed only as fixture marker for root tests —
      // ordinary grant API still cannot grant it.
      capsCopy[npk] = Object.freeze(list.slice());
    });
    qaOverlay = Object.freeze({
      groupId: snapshot.groupId || resolveGroupId(),
      epoch: snapshot.epoch || 0,
      rootAdminPubkey: normalizePubkey(snapshot.rootAdminPubkey) || '',
      capabilitiesByPubkey: Object.freeze(capsCopy),
      invitePolicy: snapshot.invitePolicy || null,
      blockedPubkeys: Object.freeze([...(snapshot.blockedPubkeys || [])].map(normalizePubkey).filter(Boolean)),
      membershipEpoch: snapshot.membershipEpoch || 0,
      source: 'qa-overlay',
      verified: false,
    });
  }

  function clearQaAuthorityOverlay() {
    qaOverlay = null;
  }

  const AccessControl = {
    CAPABILITY,
    ADMIN_CAPABILITIES,
    ACTION_CAPABILITY_MATRIX,
    RESERVED_SIGNER_ADMIN_OPS,
    FLAG_KEY,
    isV2Enabled() {
      return window[FLAG_KEY] === true;
    },
    normalizePubkey,
    isHex64Pubkey,
    resolveGroupId,
    LegacyRootAuthorityProvider,
    SignedGroupControlProvider,
    refreshAuthorityFromLegacy,
    getAuthoritySnapshot,
    hasCapability,
    requireCapability,
    can,
    getCapabilities,
    grantCapability,
    revokeCapability,
    assertNoPrivateKeyInput,
    isGuestPrincipal,
    installQaAuthorityOverlay,
    clearQaAuthorityOverlay,
    /** Explicit: guest P2P keys are not control-plane principals. */
    isControlPlaneEligible(pubkey) {
      const pk = normalizePubkey(pubkey);
      if (!pk) return false;
      if (isGuestPrincipal(pk)) return false;
      return true;
    },
  };

  Object.freeze(AccessControl);

  App.AccessControl = AccessControl;
  window.SosAccessControl = AccessControl;

  // Bootstrap legacy snapshot when config already populated admin keys.
  try {
    refreshAuthorityFromLegacy();
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
