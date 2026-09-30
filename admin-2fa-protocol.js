/**
 * Admin 2FA protocol — single source of truth for the admission Worker (issuer) and Web clients (verifier).
 *
 * A privileged first-group event is valid only with a kind 39004 attestation for that exact event, signed by the
 * Admin 2FA service key after an admin PIN session. A ROOT key alone cannot produce the attestation.
 *
 * Enforcement is OFF unless a deployment-controlled source turns it on: the build constant below, or the
 * canonical same-origin runtime-feature-flags.json (read through FeatureFlags, never local overrides).
 * Enforcement can only go from OFF to ON inside a page. Verification only: no private keys, no signing here.
 */
(function initAdmin2faProtocol(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const PROTOCOL = 'sos-admin-2fa-v1';
  const ATTESTATION_KIND = 39004;
  const ATTESTATION_SCHEMA = 'sos-admin-cosign';
  const ATTESTATION_VERSION = 1;
  const ATTESTATION_TAG = 'sos-cosign';
  const ATTESTATION_TAG_VALUE = 'v1';
  const AUTH_KIND = 27235;
  const AUTH_U_PREFIX = 'sos-admin-pin:v1:';
  /** The attested event must have been created at most this long before the attestation was issued. */
  const ATTESTATION_TTL_SEC = 600;
  const FUTURE_SKEW_SEC = 60;
  const FIRST_GROUP_ID = 'israel-network';
  const CONTROL_KIND = 39001;
  const PRIVILEGED_EVENT_KINDS = Object.freeze([39001, 39002, 39003, 37380, 5]);
  const CONTENT_KEYS = Object.freeze([
    'schema',
    'version',
    'protocol',
    'groupId',
    'rootPubkey',
    'eventId',
    'eventKind',
    'operations',
    'controlEpoch',
    'principal',
    'stepUp',
    'issuedAt',
    'expiresAt',
    'requestId',
  ]);

  const PRIVILEGED_OPERATIONS = Object.freeze([
    'BOOTSTRAP_GROUP_CONTROL',
    'PROMOTE_ADMIN',
    'DEMOTE_ADMIN',
    'CHANGE_ROLE',
    'CHANGE_PERMISSION',
    'GRANT_CAPABILITY',
    'REVOKE_CAPABILITY',
    'REMOVE_MEMBER',
    'REVOKE_INVITE',
    'CHANGE_GROUP_POLICY',
    'DELETE_OTHER_USER_POST',
    'DELETE_OTHER_USER_COMMENT',
    'CREATE_ADMISSION_DELEGATION',
    'REVOKE_ADMISSION_DELEGATION',
    'CHANGE_GROUP_SETTINGS',
    'CHANGE_BLOCKLIST',
    'ROTATE_MEMBERSHIP_EPOCH',
    'RESOLVE_CONTROL_CONFLICT',
    'BIND_ADMIN_2FA_SIGNER',
    'UPDATE_GROUP_CONTROL',
    'BLOCK_MEMBER',
    'UNBLOCK_MEMBER',
    'ADMIT_MEMBER',
    'SET_MEMBER_STATE',
  ]);
  const PRIVILEGED_SET = new Set(PRIVILEGED_OPERATIONS);

  const MEMBERSHIP_TRANSITION_OPERATION = Object.freeze({
    REMOVE: 'REMOVE_MEMBER',
    BLOCK: 'BLOCK_MEMBER',
    UNBLOCK: 'UNBLOCK_MEMBER',
    GRANT_ACTIVE: 'ADMIT_MEMBER',
    BOOTSTRAP_ACTIVE: 'ADMIT_MEMBER',
    ROOT_SET_STATE: 'SET_MEMBER_STATE',
    RESOLVE_CONFLICT: 'SET_MEMBER_STATE',
  });

  const ADMIN_TIER_CAPABILITIES = Object.freeze([
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
  ]);
  /**
   * Sensitive re-auth: these need the PIN entered again for the request itself, even inside an active session.
   * Removing or blocking a member is sensitive only when the target holds an admin-tier capability.
   * Read-only panel viewing never needs re-auth.
   */
  const STEP_UP_OPERATIONS = Object.freeze([
    'DEMOTE_ADMIN',
    'CHANGE_GROUP_POLICY',
    'CREATE_ADMISSION_DELEGATION',
    'REVOKE_ADMISSION_DELEGATION',
    'ROTATE_MEMBERSHIP_EPOCH',
    'RESOLVE_CONTROL_CONFLICT',
  ]);
  const STEP_UP_WHEN_TARGET_IS_ADMIN = Object.freeze(['REMOVE_MEMBER', 'BLOCK_MEMBER', 'CHANGE_BLOCKLIST']);

  const ADMISSION_CAP = 'FINALIZE_MEMBERSHIP_ADMISSION';
  const ADMISSION_RETIRED_CAP = 'FINALIZE_MEMBERSHIP_ADMISSION_RETIRED';

  // Deployment-controlled. Both stay OFF / empty until Phase 4 activation.
  const BUILD_ENFORCEMENT = false;
  const PINNED_SIGNER_PUBKEY = '';

  const HEX64 = /^[0-9a-f]{64}$/;
  const FF = App.FeatureFlags || window.SosFeatureFlags || null;

  function isHex64(v) {
    return typeof v === 'string' && HEX64.test(v);
  }

  function tagValues(ev, name) {
    if (!ev || !Array.isArray(ev.tags)) return [];
    return ev.tags.filter((t) => Array.isArray(t) && t[0] === name).map((t) => String(t[1] == null ? '' : t[1]));
  }

  function strictVerify(ev) {
    try {
      return typeof App.strictVerifyNostrEvent === 'function' && App.strictVerifyNostrEvent(ev) === true;
    } catch (_e) {
      return false;
    }
  }

  // ------------------------------------------------------------ enforcement
  function flagsEnforced() {
    try {
      return !!(FF && typeof FF.isAdmin2faEnforced === 'function' && FF.isAdmin2faEnforced() === true);
    } catch (_e) {
      return false;
    }
  }

  function isEnforced() {
    return BUILD_ENFORCEMENT === true || flagsEnforced();
  }

  /** '' when unset or when the build pin and the canonical config disagree (then everything fails closed). */
  function activeSignerPubkey() {
    let cfg = '';
    try {
      cfg = FF && typeof FF.admin2faSignerPubkey === 'function' ? String(FF.admin2faSignerPubkey() || '') : '';
    } catch (_e) {
      cfg = '';
    }
    if (PINNED_SIGNER_PUBKEY && cfg && PINNED_SIGNER_PUBKEY !== cfg) return '';
    const pk = PINNED_SIGNER_PUBKEY || cfg;
    return isHex64(pk) ? pk : '';
  }

  function canonicalRootPubkey() {
    const G = App.GroupControlState;
    try {
      const roots = G && typeof G.configuredRootPubkeys === 'function' ? G.configuredRootPubkeys() : [];
      return isHex64(roots[0]) ? roots[0] : '';
    } catch (_e) {
      return '';
    }
  }

  // ------------------------------------------------------------ operation classification
  function settingsKey(s) {
    const g = (s && s.groupSettings) || {};
    return JSON.stringify([g.displayName || '', g.networkTag || '', g.description || '', g.logoRef || '']);
  }

  /** Operations performed by a GROUP_CONTROL transition. Accepts record or verified-state shapes. */
  function classifyControlTransition(prev, next) {
    if (!next) return [];
    if (!prev) return ['BOOTSTRAP_GROUP_CONTROL'];
    const ops = new Set();
    if (next.resolution) ops.add('RESOLVE_CONTROL_CONFLICT');
    const pc = prev.capabilities || {};
    const nc = next.capabilities || {};
    const pks = new Set(Object.keys(pc).concat(Object.keys(nc)));
    pks.forEach((pk) => {
      const before = new Set(pc[pk] || []);
      const after = new Set(nc[pk] || []);
      const added = Array.from(after).filter((c) => !before.has(c));
      const removed = Array.from(before).filter((c) => !after.has(c));
      if (added.indexOf(ADMISSION_CAP) !== -1) ops.add('CREATE_ADMISSION_DELEGATION');
      if (removed.indexOf(ADMISSION_CAP) !== -1) ops.add('REVOKE_ADMISSION_DELEGATION');
      if (added.indexOf(ADMISSION_RETIRED_CAP) !== -1 || removed.indexOf(ADMISSION_RETIRED_CAP) !== -1) {
        ops.add('REVOKE_ADMISSION_DELEGATION');
      }
      const ordinary = (c) => c !== ADMISSION_CAP && c !== ADMISSION_RETIRED_CAP;
      if (added.some(ordinary)) ops.add('GRANT_CAPABILITY');
      if (removed.some(ordinary)) ops.add('REVOKE_CAPABILITY');
      const wasAdmin = Array.from(before).some((c) => ADMIN_TIER_CAPABILITIES.indexOf(c) !== -1);
      const isAdmin = Array.from(after).some((c) => ADMIN_TIER_CAPABILITIES.indexOf(c) !== -1);
      if (!wasAdmin && isAdmin) ops.add('PROMOTE_ADMIN');
      if (wasAdmin && !isAdmin) ops.add('DEMOTE_ADMIN');
    });
    if (prev.invitePolicy !== next.invitePolicy) ops.add('CHANGE_GROUP_POLICY');
    const blockedA = (prev.blockedPubkeys || []).slice().sort().join(',');
    const blockedB = (next.blockedPubkeys || []).slice().sort().join(',');
    if (blockedA !== blockedB) ops.add('CHANGE_BLOCKLIST');
    if (prev.membershipEpoch !== next.membershipEpoch) ops.add('ROTATE_MEMBERSHIP_EPOCH');
    if (settingsKey(prev) !== settingsKey(next)) ops.add('CHANGE_GROUP_SETTINGS');
    if ((prev.admin2faSignerPubkey || '') !== (next.admin2faSignerPubkey || '')) ops.add('BIND_ADMIN_2FA_SIGNER');
    if (!ops.size) ops.add('UPDATE_GROUP_CONTROL');
    return Array.from(ops).sort();
  }

  /** Cross-author content removal: a reply (has an `e` tag) is a comment, anything else a post. */
  function contentRemovalOperation(targetEvent) {
    const isComment = !!(targetEvent && tagValues(targetEvent, 'e').length > 0);
    return isComment ? 'DELETE_OTHER_USER_COMMENT' : 'DELETE_OTHER_USER_POST';
  }

  /**
   * Operations a receiver may check for a removal target. With the full target event the operation is exact;
   * a receiver that only knows the target id/author tries both removal operations (the attestation still binds
   * the exact event id, principal and signer).
   */
  function contentRemovalCandidates(targetEvent) {
    if (targetEvent && Array.isArray(targetEvent.tags)) return [contentRemovalOperation(targetEvent)];
    return ['DELETE_OTHER_USER_POST', 'DELETE_OTHER_USER_COMMENT'];
  }

  function membershipOperation(transition) {
    return MEMBERSHIP_TRANSITION_OPERATION[transition] || '';
  }

  function isAdminTier(caps) {
    return (Array.isArray(caps) ? caps : []).some((c) => ADMIN_TIER_CAPABILITIES.indexOf(c) !== -1);
  }

  /** Canonical sensitive re-auth policy. ctx.targetIsAdmin: the removed/blocked member holds admin-tier caps. */
  function requiresStepUp(operations, ctx) {
    const ops = Array.isArray(operations) ? operations : [];
    if (ops.some((op) => STEP_UP_OPERATIONS.indexOf(op) !== -1)) return true;
    return !!(ctx && ctx.targetIsAdmin === true) && ops.some((op) => STEP_UP_WHEN_TARGET_IS_ADMIN.indexOf(op) !== -1);
  }

  /** Control transition: did it remove or block someone who held admin-tier capabilities before? */
  function controlTargetsAdmin(prev, next) {
    if (!prev || !next) return false;
    const pc = prev.capabilities || {};
    const before = new Set(prev.blockedPubkeys || []);
    return (next.blockedPubkeys || []).some((pk) => !before.has(pk) && isAdminTier(pc[pk]));
  }

  // ------------------------------------------------------------ attestation (issuer side builds, verifier checks)
  /** Unsigned draft; the Worker signs it with the Admin 2FA key. */
  function buildAttestationDraft(p) {
    const content = {
      schema: ATTESTATION_SCHEMA,
      version: ATTESTATION_VERSION,
      protocol: PROTOCOL,
      groupId: p.groupId,
      rootPubkey: p.rootPubkey,
      eventId: p.event.id,
      eventKind: p.event.kind,
      operations: p.operations.slice().sort(),
      controlEpoch: p.controlEpoch,
      principal: p.principal,
      stepUp: p.stepUp === true,
      issuedAt: p.issuedAt,
      expiresAt: p.issuedAt + ATTESTATION_TTL_SEC,
      requestId: p.requestId,
    };
    return {
      kind: ATTESTATION_KIND,
      created_at: p.issuedAt,
      tags: [
        ['d', p.groupId + ':' + p.event.id],
        ['e', p.event.id],
        ['p', p.principal],
        ['t', p.groupId],
        [ATTESTATION_TAG, ATTESTATION_TAG_VALUE],
      ],
      content: JSON.stringify(content),
    };
  }

  function fail(code) {
    return { ok: false, code };
  }

  function rootEventGroupBound(ev, groupId) {
    if (ev.kind === CONTROL_KIND) {
      let body = null;
      try {
        body = JSON.parse(ev.content);
      } catch (_e) {
        return false;
      }
      if (!body || body.groupId !== groupId) return false;
      const d = tagValues(ev, 'd');
      if (d.length < 1 || d.some((v) => v !== d[0])) return false;
      return d[0] === groupId || d[0] === groupId + ':' + body.controlEpoch;
    }
    return tagValues(ev, 't').indexOf(groupId) !== -1;
  }

  /**
   * Canonical verifier. context: { groupId, rootPubkey, signerPubkey?, expectedOperations, controlEpoch?,
   * nowSec?, requireUnexpired? }. Fails closed on anything missing or malformed.
   */
  function verifyAdmin2faAttestation(rootEvent, attestation, context) {
    const ctx = context || {};
    const groupId = ctx.groupId;
    if (groupId !== FIRST_GROUP_ID) return fail('ADMIN_2FA_GROUP_SCOPE');
    const signer = ctx.signerPubkey != null ? ctx.signerPubkey : activeSignerPubkey();
    if (!isHex64(signer)) return fail('ADMIN_2FA_SIGNER_NOT_CONFIGURED');
    if (!isHex64(ctx.rootPubkey)) return fail('ADMIN_2FA_ROOT_NOT_CONFIGURED');
    const expected = Array.isArray(ctx.expectedOperations) ? ctx.expectedOperations.slice().sort() : [];
    if (!expected.length) return fail('ADMIN_2FA_BAD_CONTEXT');
    if (expected.some((op) => !PRIVILEGED_SET.has(op))) return fail('ADMIN_2FA_OPERATION_NOT_PRIVILEGED');

    if (!rootEvent || typeof rootEvent !== 'object' || !strictVerify(rootEvent)) return fail('ADMIN_2FA_ROOT_EVENT_INVALID');
    if (PRIVILEGED_EVENT_KINDS.indexOf(rootEvent.kind) === -1) return fail('ADMIN_2FA_ROOT_EVENT_KIND');
    if (!rootEventGroupBound(rootEvent, groupId)) return fail('ADMIN_2FA_ROOT_EVENT_GROUP_MISMATCH');

    const att = attestation;
    if (!att || typeof att !== 'object') return fail('ADMIN_2FA_REQUIRED');
    if (att.kind !== ATTESTATION_KIND) return fail('ADMIN_2FA_ATTESTATION_KIND');
    if (!strictVerify(att)) return fail('ADMIN_2FA_ATTESTATION_SIGNATURE_INVALID');
    if (att.pubkey !== signer) return fail('ADMIN_2FA_ATTESTATION_WRONG_SIGNER');

    const eTags = tagValues(att, 'e');
    if (eTags.length !== 1 || eTags[0] !== rootEvent.id) return fail('ADMIN_2FA_ATTESTATION_EVENT_MISMATCH');
    const tags = Array.isArray(att.tags) ? att.tags : [];
    if (
      tags.length !== 5 ||
      tagValues(att, 'd').join('|') !== groupId + ':' + rootEvent.id ||
      tagValues(att, 't').join('|') !== groupId ||
      tagValues(att, 'p').join('|') !== rootEvent.pubkey ||
      tagValues(att, ATTESTATION_TAG).join('|') !== ATTESTATION_TAG_VALUE
    ) {
      return fail('ADMIN_2FA_ATTESTATION_TAGS_INVALID');
    }

    let body = null;
    try {
      body = JSON.parse(att.content);
    } catch (_e) {
      return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    const keys = Object.keys(body).sort();
    if (keys.join(',') !== CONTENT_KEYS.slice().sort().join(',')) return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    if (body.schema !== ATTESTATION_SCHEMA || body.version !== ATTESTATION_VERSION || body.protocol !== PROTOCOL) {
      return fail('ADMIN_2FA_ATTESTATION_PROTOCOL');
    }
    if (body.groupId !== groupId) return fail('ADMIN_2FA_ATTESTATION_GROUP_MISMATCH');
    if (body.rootPubkey !== ctx.rootPubkey) return fail('ADMIN_2FA_ATTESTATION_ROOT_MISMATCH');
    if (body.eventId !== rootEvent.id || body.eventKind !== rootEvent.kind) return fail('ADMIN_2FA_ATTESTATION_EVENT_MISMATCH');
    if (body.principal !== rootEvent.pubkey) return fail('ADMIN_2FA_ATTESTATION_PRINCIPAL_MISMATCH');
    if (!Array.isArray(body.operations) || body.operations.join(',') !== expected.join(',')) {
      return fail('ADMIN_2FA_ATTESTATION_OPERATION_MISMATCH');
    }
    if (!Number.isInteger(body.controlEpoch) || body.controlEpoch < 0) return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    if (ctx.controlEpoch != null && body.controlEpoch !== ctx.controlEpoch) return fail('ADMIN_2FA_ATTESTATION_EPOCH_MISMATCH');
    if (typeof body.stepUp !== 'boolean') return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    if (!Number.isInteger(body.issuedAt) || body.issuedAt !== att.created_at) return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    if (body.expiresAt !== body.issuedAt + ATTESTATION_TTL_SEC) return fail('ADMIN_2FA_ATTESTATION_MALFORMED');
    if (!isHex64(body.requestId)) return fail('ADMIN_2FA_ATTESTATION_NONCE_INVALID');

    if (rootEvent.created_at > body.issuedAt + FUTURE_SKEW_SEC) return fail('ADMIN_2FA_ATTESTATION_BEFORE_EVENT');
    if (rootEvent.created_at < body.issuedAt - ATTESTATION_TTL_SEC) return fail('ADMIN_2FA_ATTESTATION_EXPIRED');
    if (Number.isInteger(ctx.nowSec)) {
      if (body.issuedAt > ctx.nowSec + FUTURE_SKEW_SEC) return fail('ADMIN_2FA_ATTESTATION_FROM_FUTURE');
      if (ctx.requireUnexpired === true && ctx.nowSec > body.expiresAt) return fail('ADMIN_2FA_ATTESTATION_EXPIRED');
    }
    return { ok: true, code: 'ADMIN_2FA_VERIFIED', operations: expected, stepUp: body.stepUp };
  }

  // ------------------------------------------------------------ attestation store (verification input only)
  const MAX_EVENTS = 4000;
  const MAX_PER_EVENT = 4;
  const store = new Map();

  /** Keeps signature-valid 39004 events from the active signer, indexed by the attested event id. */
  function ingestAttestations(list) {
    const signer = activeSignerPubkey();
    let added = 0;
    (Array.isArray(list) ? list : [list]).forEach((ev) => {
      if (!signer || !ev || ev.kind !== ATTESTATION_KIND || ev.pubkey !== signer || !strictVerify(ev)) return;
      const e = tagValues(ev, 'e');
      if (e.length !== 1 || !isHex64(e[0])) return;
      const rows = store.get(e[0]) || [];
      if (rows.some((r) => r.id === ev.id) || rows.length >= MAX_PER_EVENT) return;
      if (!store.has(e[0]) && store.size >= MAX_EVENTS) store.delete(store.keys().next().value);
      rows.push(JSON.parse(JSON.stringify(ev)));
      store.set(e[0], rows);
      added++;
    });
    return added;
  }

  function attestationsFor(eventId) {
    return (store.get(String(eventId || '')) || []).slice();
  }

  function clearAttestations() {
    store.clear();
  }

  // ------------------------------------------------------------ enforcement policy
  function requireForEvent(event, operations, context) {
    const ctx = context || {};
    if (!isEnforced()) return { ok: true, code: 'ADMIN_2FA_NOT_ENFORCED', enforced: false };
    if (!event || !isHex64(event.id)) return fail('ADMIN_2FA_ROOT_EVENT_INVALID');
    const list = attestationsFor(event.id);
    if (!list.length) return fail('ADMIN_2FA_REQUIRED');
    let last = fail('ADMIN_2FA_REQUIRED');
    for (let i = 0; i < list.length; i++) {
      const r = verifyAdmin2faAttestation(event, list[i], {
        groupId: ctx.groupId || FIRST_GROUP_ID,
        rootPubkey: ctx.rootPubkey || canonicalRootPubkey(),
        expectedOperations: operations,
        controlEpoch: ctx.controlEpoch,
        nowSec: ctx.nowSec,
        requireUnexpired: ctx.requireUnexpired,
      });
      if (r.ok) return Object.assign({ enforced: true }, r);
      last = r;
    }
    return last;
  }

  /** GROUP_CONTROL step: bound signer + attestation over the classified operations and the new epoch. */
  function requireForControlTransition(event, prev, next) {
    if (!isEnforced()) return { ok: true, code: 'ADMIN_2FA_NOT_ENFORCED', enforced: false };
    const signer = activeSignerPubkey();
    if (!signer) return fail('ADMIN_2FA_SIGNER_NOT_CONFIGURED');
    if (!next || next.admin2faSignerPubkey !== signer) return fail('ADMIN_2FA_SIGNER_NOT_BOUND');
    const root = canonicalRootPubkey();
    if (!root || next.rootAdminPubkey !== root) return fail('ADMIN_2FA_ROOT_MISMATCH');
    return requireForEvent(event, classifyControlTransition(prev, next), {
      groupId: next.groupId,
      rootPubkey: root,
      controlEpoch: next.controlEpoch,
    });
  }

  /**
   * Legacy (V2 off) admin kind-5 removal of other users' content. targets: [{ id, author, targetEvent? }].
   * Returns which cross-author targets the admin may remove; own-content removal is never affected.
   */
  function authorizeAdminContentRemoval(event, targets, context) {
    const list = Array.isArray(targets) ? targets : [];
    if (!isEnforced()) return { ok: true, enforced: false, code: 'ADMIN_2FA_NOT_ENFORCED', allowUnknownAuthor: true };
    const deleter = String((event && event.pubkey) || '').toLowerCase();
    const cross = list.filter((t) => t && t.author && t.author !== deleter);
    if (!cross.length) return { ok: false, enforced: true, code: 'NO_CROSS_AUTHOR_TARGETS', allowUnknownAuthor: false };
    // Server-issued removal attestations cover exactly one target, so the candidate sets come from that target.
    const candidateSets =
      cross.length === 1
        ? contentRemovalCandidates(cross[0].targetEvent).map((op) => [op])
        : [Array.from(new Set(cross.map((t) => contentRemovalOperation(t.targetEvent)))).sort()];
    let r = fail('ADMIN_2FA_REQUIRED');
    for (let i = 0; i < candidateSets.length; i++) {
      r = requireForEvent(event, candidateSets[i], context);
      if (r.ok) return Object.assign({}, r, { enforced: true, allowUnknownAuthor: false, operations: candidateSets[i] });
    }
    return Object.assign({}, r, { enforced: true, allowUnknownAuthor: false, operations: candidateSets[0] });
  }

  /** First cross-author removal that verifies against any of the candidate operations. */
  function requireForContentRemoval(event, targetEvent, context) {
    const cands = contentRemovalCandidates(targetEvent);
    let r = fail('ADMIN_2FA_REQUIRED');
    for (let i = 0; i < cands.length; i++) {
      r = requireForEvent(event, [cands[i]], context);
      if (r.ok) return r;
    }
    return r;
  }

  const api = Object.freeze({
    PROTOCOL,
    ATTESTATION_KIND,
    ATTESTATION_SCHEMA,
    ATTESTATION_VERSION,
    ATTESTATION_TAG,
    ATTESTATION_TAG_VALUE,
    AUTH_KIND,
    AUTH_U_PREFIX,
    ATTESTATION_TTL_SEC,
    FUTURE_SKEW_SEC,
    FIRST_GROUP_ID,
    PRIVILEGED_EVENT_KINDS,
    PRIVILEGED_OPERATIONS,
    MEMBERSHIP_TRANSITION_OPERATION,
    CONTENT_KEYS,
    ENFORCEMENT_SOURCES: 'build constant OR canonical runtime-feature-flags.json; no local overrides; monotonic',
    GENERIC_SIGNER_EXPOSED: false,
    isEnforced,
    activeSignerPubkey,
    canonicalRootPubkey,
    STEP_UP_OPERATIONS,
    STEP_UP_WHEN_TARGET_IS_ADMIN,
    SENSITIVE_ADMIN_REAUTH_POLICY_CANONICAL: true,
    classifyControlTransition,
    contentRemovalOperation,
    contentRemovalCandidates,
    membershipOperation,
    isAdminTier,
    requiresStepUp,
    controlTargetsAdmin,
    requireForContentRemoval,
    buildAttestationDraft,
    verifyAdmin2faAttestation,
    ingestAttestations,
    attestationsFor,
    clearAttestations,
    requireForEvent,
    requireForControlTransition,
    authorizeAdminContentRemoval,
  });

  App.Admin2faProtocol = api;
  window.SosAdmin2faProtocol = api;

  try {
    if (FF && FF.READY_EVENT && typeof window.addEventListener === 'function') {
      window.addEventListener(FF.READY_EVENT, () => {
        const G = App.GroupControlState;
        if (isEnforced() && G && typeof G.revalidateFromCache === 'function') {
          try {
            G.revalidateFromCache();
          } catch (_e) {}
        }
      });
    }
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
