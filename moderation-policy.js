/**
 * AC4 — Delegated content moderation authorization.
 * When SOS_ACCESS_CONTROL_V2=false: callers keep Package 885 legacy adminPublicKeys + kind 5.
 * When V2=true: AUTHOR_DELETE (kind 5) vs MODERATE_CONTENT (kind 39002 group moderation).
 * Relays are transport, not authority. No private keys.
 */
(function initModerationPolicy(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  /** Dedicated group moderation (not NIP-09 kind 5). Cross-author kind 5 is not relay-enforceable. */
  const MODERATION_EVENT_KIND = 39002;
  const MODERATION_KIND_CLASS = 'parameterized-replaceable';
  const MODERATION_PARAMETERIZED_REPLACEABLE_INTENTIONAL = true;
  /** Canonical d-tag = target event id (one live moderation tip per target). */
  const MODERATION_D_TAG_RULE = 'd === targetEvent.id (lowercase 64-hex)';
  const MODERATION_E_TAG_RULE = 'e === targetEvent.id (event reference; must match d)';
  const MODERATION_D_TAG_REQUIRED = true;
  /** Tags: d/e=targetEventId; t=groupId(+sos-group-moderation); p=targetAuthor; k=targetKind; control-epoch; body carries moderatorPubkey+controlEpoch. */
  const MODERATION_EVENT_MODEL =
    'sos-group-moderation kind 39002; official clients hide target; relays do not enforce cross-author kind 5';
  const SCHEMA_NAME = 'sos-group-moderation';
  const SCHEMA_VERSION = 1;

  /**
   * CURRENT_STATE fail-safe: accept/create moderation only against CURRENT verified control.
   * No embedded historical control attestation → cannot safely prove past MODERATE_CONTENT
   * without relying on unreliable relay retention of prior 39001 tips.
   */
  const DELEGATED_MODERATION_PERSISTENCE_MODEL = 'current_verified_control_state';
  const HISTORICAL_MODERATION_AUTH_PROOF = 'none_safe_without_embedded_control_attestation';
  const MODERATION_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY = false;
  /** Root continuity via current control.rootAdminPubkey match (not relay history). */
  const ROOT_MODERATION_PERSISTENCE_MODEL = 'current_rootAdminPubkey_match';

  /** Group feed posts + comments/replies are kind 1 with network tag in this app. */
  const MODERATION_ELIGIBLE_TARGET_KINDS = Object.freeze([1]);
  const ELIGIBLE_KIND_SET = new Set(MODERATION_ELIGIBLE_TARGET_KINDS);

  const ACTION_HIDE = 'hide';

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function normalizeHexId(value) {
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

  function readTag(event, name) {
    if (!event || !Array.isArray(event.tags)) return '';
    for (let i = 0; i < event.tags.length; i++) {
      const t = event.tags[i];
      if (Array.isArray(t) && t[0] === name && t[1] != null) return String(t[1]);
    }
    return '';
  }

  function eventHasNetworkTag(event, groupId) {
    if (!event || !Array.isArray(event.tags)) return false;
    const want = String(groupId || '');
    return event.tags.some((t) => Array.isArray(t) && t[0] === 't' && String(t[1]) === want);
  }

  function strictVerify(event) {
    try {
      if (typeof App.verifyEventStrict === 'function') return App.verifyEventStrict(event) === true;
      if (window.NostrEventIntegrity && typeof window.NostrEventIntegrity.verifyEventStrict === 'function') {
        return window.NostrEventIntegrity.verifyEventStrict(event) === true;
      }
      if (window.NostrTools && typeof window.NostrTools.verifyEvent === 'function') {
        return window.NostrTools.verifyEvent(event) === true;
      }
    } catch (_) {}
    return false;
  }

  function isGuestPrincipal(pubkey) {
    const AC = getAC();
    if (AC && typeof AC.isGuestPrincipal === 'function') {
      return AC.isGuestPrincipal(pubkey) === true;
    }
    if (App.guestMode === true) return true;
    return false;
  }

  function isEligibleTargetKind(kind) {
    return ELIGIBLE_KIND_SET.has(Number(kind));
  }

  function capsFor(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !controlState) return [];
    if (pk === controlState.rootAdminPubkey) {
      return [
        'ROOT_ADMIN',
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
    }
    const list = (controlState.capabilities && controlState.capabilities[pk]) || [];
    return Array.isArray(list) ? list.slice() : [];
  }

  function hasCap(pubkey, controlState, cap) {
    return capsFor(pubkey, controlState).indexOf(cap) !== -1;
  }

  function isRootAdmin(pubkey, controlState) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !controlState) return false;
    return pk === normalizePubkey(controlState.rootAdminPubkey);
  }

  function legacyIsAdmin(pubkey) {
    const pk = normalizePubkey(pubkey) || normalizePubkey(App.publicKey);
    if (!pk) return false;
    if (App.adminPublicKeys instanceof Set) return App.adminPublicKeys.has(pk);
    if (Array.isArray(App.adminPublicKeys)) {
      return App.adminPublicKeys.some((k) => normalizePubkey(k) === pk);
    }
    return false;
  }

  /** Own-content delete: target author == principal. Never requires moderator cap. */
  function canAuthorDelete(viewerPubkey, targetAuthorPubkey) {
    const viewer = normalizePubkey(viewerPubkey) || normalizePubkey(App.publicKey);
    const author = normalizePubkey(targetAuthorPubkey);
    if (!viewer || !author) return { ok: false, code: 'NO_PRINCIPAL' };
    if (isGuestPrincipal(viewer) || App.guestMode === true) return { ok: false, code: 'GUEST_DENIED' };
    if (viewer !== author) return { ok: false, code: 'NOT_AUTHOR' };
    return { ok: true, mode: 'AUTHOR_DELETE', code: 'OWN_CONTENT' };
  }

  /**
   * Cross-author moderation. V2: ROOT or MODERATE_CONTENT from CURRENT verified control.
   * Root content protected from delegated moderators.
   */
  function canModerateContent(viewerPubkey, targetAuthorPubkey, targetKind, controlState, context) {
    const ctx = context || {};
    const viewer = normalizePubkey(viewerPubkey) || normalizePubkey(App.publicKey);
    const author = normalizePubkey(targetAuthorPubkey);
    if (!viewer) return { ok: false, code: 'NO_PRINCIPAL' };
    if (isGuestPrincipal(viewer) || App.guestMode === true || ctx.forceGuest === true) {
      return { ok: false, code: 'GUEST_DENIED' };
    }
    if (!author) return { ok: false, code: 'NO_TARGET_AUTHOR' };
    if (viewer === author) return { ok: false, code: 'USE_AUTHOR_DELETE' };
    if (!isEligibleTargetKind(targetKind)) return { ok: false, code: 'INELIGIBLE_KIND' };

    if (!isV2()) {
      if (!legacyIsAdmin(viewer)) return { ok: false, code: 'LEGACY_NOT_ADMIN' };
      return { ok: true, mode: 'LEGACY_ADMIN', code: 'LEGACY_ADMIN_PUBLIC_KEYS' };
    }

    const state = controlState || getVerifiedControlOrNull();
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };

    if (isRootAdmin(viewer, state)) {
      return { ok: true, mode: 'ROOT', code: 'ROOT_ADMIN', controlEpoch: state.controlEpoch };
    }

    if (!hasCap(viewer, state, 'MODERATE_CONTENT')) {
      return { ok: false, code: 'NO_MODERATE_CAP' };
    }

    // Delegated moderator must not moderate ROOT_ADMIN content
    if (isRootAdmin(author, state)) {
      return { ok: false, code: 'ROOT_CONTENT_PROTECTED' };
    }

    return {
      ok: true,
      mode: 'DELEGATED',
      code: 'MODERATE_CONTENT',
      controlEpoch: state.controlEpoch,
    };
  }

  /** Combined UI/action gate: own delete OR moderation. */
  function canViewerRemoveContent(viewerPubkey, targetAuthorPubkey, targetKind, controlState) {
    const own = canAuthorDelete(viewerPubkey, targetAuthorPubkey);
    if (own.ok) return own;
    return canModerateContent(viewerPubkey, targetAuthorPubkey, targetKind, controlState);
  }

  function buildModerationDraft(targetEvent, action, controlState) {
    const state = controlState || getVerifiedControlOrNull();
    if (!targetEvent || !targetEvent.id) throw new Error('NO_TARGET');
    const targetId = normalizeHexId(targetEvent.id);
    const targetAuthor = normalizePubkey(targetEvent.pubkey);
    const groupId = resolveGroupId();
    const content = {
      schema: SCHEMA_NAME,
      version: SCHEMA_VERSION,
      groupId,
      targetEventId: targetId,
      targetEventKind: Number(targetEvent.kind),
      targetAuthorPubkey: targetAuthor,
      moderatorPubkey: normalizePubkey(App.publicKey),
      action: action || ACTION_HIDE,
      controlEpoch: state && typeof state.controlEpoch === 'number' ? state.controlEpoch : null,
    };
    return {
      kind: MODERATION_EVENT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', targetId],
        ['e', targetId],
        ['p', targetAuthor],
        ['k', String(Number(targetEvent.kind))],
        ['t', groupId],
        ['t', 'sos-group-moderation'],
        ['control-epoch', String(content.controlEpoch != null ? content.controlEpoch : '')],
      ],
      content: JSON.stringify(content),
      pubkey: App.publicKey,
    };
  }

  function parseModerationContent(event) {
    try {
      const raw = typeof event.content === 'string' ? JSON.parse(event.content) : null;
      if (!raw || raw.schema !== SCHEMA_NAME) return null;
      if (Number(raw.version) !== SCHEMA_VERSION) return null;
      return raw;
    } catch (_) {
      return null;
    }
  }

  /**
   * Accept moderation for official client hide. CURRENT_STATE model.
   * targetEvent optional but preferred for author/kind binding checks.
   */
  function validateModerationEvent(modEvent, targetEvent, controlState) {
    if (!modEvent || modEvent.kind !== MODERATION_EVENT_KIND) {
      return { ok: false, code: 'BAD_KIND' };
    }
    if (!strictVerify(modEvent)) return { ok: false, code: 'STRICT_VERIFY_FAILED' };

    const groupId = resolveGroupId();
    if (!eventHasNetworkTag(modEvent, groupId)) return { ok: false, code: 'CROSS_GROUP' };

    const d = normalizeHexId(readTag(modEvent, 'd'));
    if (!d) return { ok: false, code: 'MISSING_D_TAG' };
    const eRef = normalizeHexId(readTag(modEvent, 'e'));
    if (eRef && eRef !== d) return { ok: false, code: 'BAD_E_REF' };

    const body = parseModerationContent(modEvent);
    if (!body) return { ok: false, code: 'BAD_SCHEMA' };
    if (String(body.groupId) !== groupId) return { ok: false, code: 'CROSS_GROUP_BODY' };
    if (normalizeHexId(body.targetEventId) !== d) return { ok: false, code: 'TARGET_ID_MISMATCH' };
    if ((body.action || ACTION_HIDE) !== ACTION_HIDE) return { ok: false, code: 'BAD_ACTION' };

    const targetAuthor =
      normalizePubkey(body.targetAuthorPubkey) ||
      (targetEvent ? normalizePubkey(targetEvent.pubkey) : '') ||
      normalizePubkey(readTag(modEvent, 'p'));
    if (!targetAuthor) return { ok: false, code: 'NO_TARGET_AUTHOR' };

    const pTag = normalizePubkey(readTag(modEvent, 'p'));
    if (pTag && pTag !== targetAuthor) return { ok: false, code: 'P_TAG_MISMATCH' };

    const targetKind =
      body.targetEventKind != null
        ? Number(body.targetEventKind)
        : targetEvent
          ? Number(targetEvent.kind)
          : Number(readTag(modEvent, 'k'));
    if (!isEligibleTargetKind(targetKind)) return { ok: false, code: 'INELIGIBLE_KIND' };
    if (targetEvent) {
      if (normalizeHexId(targetEvent.id) !== d) return { ok: false, code: 'TARGET_EVENT_MISMATCH' };
      if (normalizePubkey(targetEvent.pubkey) !== targetAuthor) return { ok: false, code: 'TARGET_AUTHOR_MISMATCH' };
      if (Number(targetEvent.kind) !== targetKind) return { ok: false, code: 'TARGET_KIND_MISMATCH' };
    }

    const moderator = normalizePubkey(modEvent.pubkey);
    if (!moderator) return { ok: false, code: 'NO_MODERATOR' };
    if (body.moderatorPubkey && normalizePubkey(body.moderatorPubkey) !== moderator) {
      return { ok: false, code: 'MODERATOR_SPOOF' };
    }
    if (moderator === targetAuthor) return { ok: false, code: 'USE_AUTHOR_DELETE' };

    if (!isV2()) {
      // V2-off clients should not consume 39002 as authority (legacy path is kind 5).
      return { ok: false, code: 'V2_REQUIRED' };
    }

    const state = controlState || getVerifiedControlOrNull();
    if (!state) return { ok: false, code: 'NO_VERIFIED_CONTROL' };

    // CURRENT_STATE: issuer must still be authorized now
    const auth = canModerateContent(moderator, targetAuthor, targetKind, state);
    if (!auth.ok) return { ok: false, code: 'UNAUTHORIZED_MODERATION', detail: auth.code };

    return {
      ok: true,
      code: 'ACCEPTED',
      targetEventId: d,
      targetAuthorPubkey: targetAuthor,
      moderatorPubkey: moderator,
      action: ACTION_HIDE,
      mode: auth.mode,
      controlEpoch: state.controlEpoch,
    };
  }

  const api = {
    MODERATION_EVENT_KIND,
    MODERATION_KIND_CLASS,
    MODERATION_PARAMETERIZED_REPLACEABLE_INTENTIONAL,
    MODERATION_D_TAG_RULE,
    MODERATION_E_TAG_RULE,
    MODERATION_D_TAG_REQUIRED,
    MODERATION_EVENT_MODEL,
    MODERATION_ELIGIBLE_TARGET_KINDS,
    DELEGATED_MODERATION_PERSISTENCE_MODEL,
    HISTORICAL_MODERATION_AUTH_PROOF,
    MODERATION_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY,
    ROOT_MODERATION_PERSISTENCE_MODEL,
    ACTION_HIDE,
    isV2,
    canAuthorDelete,
    canModerateContent,
    canViewerRemoveContent,
    buildModerationDraft,
    validateModerationEvent,
    isEligibleTargetKind,
    getVerifiedControlOrNull,
    isRootAdmin,
    hasCap,
    normalizePubkey,
    resolveGroupId,
    strictVerify,
    readTag,
  };

  Object.freeze(api);
  App.ModerationPolicy = api;
  window.SosModerationPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
