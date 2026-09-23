/**
 * AC9 — Central typed administrative signing policy (page + Worker + QA).
 * Pure-ish: no App.privateKey. Caller cannot supply arbitrary event/kind/content.
 * Does NOT claim XSS isolation or trusted human intent (F5B).
 */
(function initAdminSigningPolicy(global) {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const GROUP_CONTROL_KIND = 39001;
  const MEMBERSHIP_KIND = 39003;
  const SCHEMA_CONTROL = 'sos-group-control';
  const SCHEMA_MEMBER = 'sos-group-member';
  const DISPLAY_NAME_MAX = 80;
  const REASON_MAX = 200;
  const MAX_CANDIDATES = 32;
  const MAX_CAPS_PER_TARGET = 32;
  const MAX_BLOCKLIST = 5000;
  const INVITE_ID_MAX = 128;

  const INVITE_POLICIES = Object.freeze(['EVERYONE', 'AUTHORIZED_USERS_ONLY', 'ADMINS_ONLY']);

  const MAP_CAPABILITIES = Object.freeze([
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_MEMBERS',
    'MANAGE_INVITES',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ]);

  const DELEGABLE_BY_PERMISSION_MANAGER = Object.freeze([
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ]);

  const ADMIN_OP = Object.freeze({
    SET_GROUP_DISPLAY_NAME: 'SET_GROUP_DISPLAY_NAME',
    SET_INVITE_POLICY: 'SET_INVITE_POLICY',
    GRANT_CAPABILITY: 'GRANT_CAPABILITY',
    REVOKE_CAPABILITY: 'REVOKE_CAPABILITY',
    ADD_MEMBER_TO_BLOCKLIST: 'ADD_MEMBER_TO_BLOCKLIST',
    REMOVE_MEMBER_FROM_BLOCKLIST: 'REMOVE_MEMBER_FROM_BLOCKLIST',
    CLEAN_REMOVED_MEMBER_CAPABILITIES: 'CLEAN_REMOVED_MEMBER_CAPABILITIES',
    RESOLVE_CONTROL_CONFLICT: 'RESOLVE_CONTROL_CONFLICT',
    BOOTSTRAP_GROUP_CONTROL: 'BOOTSTRAP_GROUP_CONTROL',
    GRANT_MEMBER_ACTIVE: 'GRANT_MEMBER_ACTIVE',
    BLOCK_MEMBER: 'BLOCK_MEMBER',
    UNBLOCK_MEMBER: 'UNBLOCK_MEMBER',
    REMOVE_MEMBER: 'REMOVE_MEMBER',
    RESOLVE_MEMBERSHIP_CONFLICT: 'RESOLVE_MEMBERSHIP_CONFLICT',
    BOOTSTRAP_MEMBER_ACTIVE: 'BOOTSTRAP_MEMBER_ACTIVE',
  });

  const CONTROL_OPS = new Set([
    ADMIN_OP.SET_GROUP_DISPLAY_NAME,
    ADMIN_OP.SET_INVITE_POLICY,
    ADMIN_OP.GRANT_CAPABILITY,
    ADMIN_OP.REVOKE_CAPABILITY,
    ADMIN_OP.ADD_MEMBER_TO_BLOCKLIST,
    ADMIN_OP.REMOVE_MEMBER_FROM_BLOCKLIST,
    ADMIN_OP.CLEAN_REMOVED_MEMBER_CAPABILITIES,
    ADMIN_OP.RESOLVE_CONTROL_CONFLICT,
    ADMIN_OP.BOOTSTRAP_GROUP_CONTROL,
  ]);

  const MEMBER_OPS = new Set([
    ADMIN_OP.GRANT_MEMBER_ACTIVE,
    ADMIN_OP.BLOCK_MEMBER,
    ADMIN_OP.UNBLOCK_MEMBER,
    ADMIN_OP.REMOVE_MEMBER,
    ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT,
    ADMIN_OP.BOOTSTRAP_MEMBER_ACTIVE,
  ]);

  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function isHex64(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());
  }

  function resolveNetworkTag(explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    try {
      const g = typeof global !== 'undefined' ? global : null;
      const App = g && (g.NostrApp || g);
      if (App && typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) {
        return App.NETWORK_TAG.trim();
      }
    } catch (_e) {}
    return 'israel-network';
  }

  function sanitizeDisplayName(raw) {
    let s = String(raw == null ? '' : raw);
    s = s.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > DISPLAY_NAME_MAX) s = s.slice(0, DISPLAY_NAME_MAX);
    return s;
  }

  function hasProtoPollution(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (Object.prototype.hasOwnProperty.call(obj, '__proto__')) return true;
    if (Object.prototype.hasOwnProperty.call(obj, 'constructor')) return true;
    if (Object.prototype.hasOwnProperty.call(obj, 'prototype')) return true;
    return false;
  }

  function assertCapabilityToken(cap) {
    if (cap === 'ROOT_ADMIN') fail('ROOT_ADMIN_NOT_GRANTABLE');
    if (MAP_CAPABILITIES.indexOf(cap) === -1) fail('UNKNOWN_CAPABILITY');
    return cap;
  }

  function actorIsRoot(actor, state) {
    return normalizePubkey(actor) === normalizePubkey(state.rootAdminPubkey);
  }

  function actorHas(actor, capability, state) {
    if (actorIsRoot(actor, state)) return true;
    const list = (state.capabilities && state.capabilities[normalizePubkey(actor)]) || [];
    return list.indexOf(capability) !== -1;
  }

  function cloneControlRecord(state) {
    const caps = {};
    Object.keys(state.capabilities || {}).forEach((pk) => {
      caps[pk] = (state.capabilities[pk] || []).slice();
    });
    return {
      schema: SCHEMA_CONTROL,
      version: 1,
      groupId: state.groupId,
      controlEpoch: state.controlEpoch,
      rootAdminPubkey: state.rootAdminPubkey,
      capabilities: caps,
      invitePolicy: state.invitePolicy,
      blockedPubkeys: (state.blockedPubkeys || []).slice(),
      membershipEpoch: state.membershipEpoch,
      groupSettings: {
        displayName: state.groupSettings && state.groupSettings.displayName,
        networkTag: state.groupSettings && state.groupSettings.networkTag,
      },
      createdAt: Math.floor(Date.now() / 1000),
      membershipRoot: state.membershipRoot || null,
      resolution: null,
    };
  }

  function parseControlRecordFromEvent(event) {
    if (!event || typeof event !== 'object') fail('BAD_BASE_EVENT');
    if (event.kind !== GROUP_CONTROL_KIND) fail('BAD_BASE_KIND');
    let body;
    try {
      body = typeof event.content === 'string' ? JSON.parse(event.content) : null;
    } catch (_e) {
      fail('BAD_BASE_CONTENT');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('BAD_BASE_CONTENT');
    if (hasProtoPollution(body)) fail('PROTOTYPE_POLLUTION');
    if (body.schema !== SCHEMA_CONTROL) fail('BAD_BASE_SCHEMA');
    if (!body.groupId || typeof body.groupId !== 'string') fail('BAD_BASE_GROUP');
    if (!isHex64(body.rootAdminPubkey)) fail('BAD_BASE_ROOT');
    if (!Number.isInteger(body.controlEpoch) || body.controlEpoch < 1) fail('BAD_BASE_EPOCH');
    return body;
  }

  function validateRequestEnvelope(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) fail('MALFORMED_REQUEST');
    if (hasProtoPollution(req)) fail('PROTOTYPE_POLLUTION');
    if (req.version !== PROTOCOL_VERSION) fail('UNKNOWN_VERSION');
    if (typeof req.operation !== 'string' || !ADMIN_OP[req.operation]) fail('UNKNOWN_OP');
    if (req.kind != null) fail('CALLER_KIND_OVERRIDE');
    if (req.pubkey != null || req.issuerPubkey != null) fail('CALLER_PUBKEY_OVERRIDE');
    if (req.controlEpoch != null || req.memberRevision != null || req.membershipEpoch != null) {
      fail('CALLER_EPOCH_OVERRIDE');
    }
    if (req.content != null || req.tags != null || req.event != null) fail('ARBITRARY_EVENT_FIELDS');
    if (req.record != null || req.nextState != null || req.groupControlState != null) {
      fail('ARBITRARY_STATE');
    }
    if (req.membershipState != null) fail('ARBITRARY_MEMBERSHIP_STATE');
    return req.operation;
  }

  /**
   * Build next control record from verified base + typed op.
   * actorPubkey MUST be derived from signing key by caller.
   */
  function applyControlOperation(operation, baseRecord, actorPubkey, params) {
    const actor = normalizePubkey(actorPubkey);
    if (!actor) fail('NO_ACTOR');
    const p = params && typeof params === 'object' ? params : {};
    if (hasProtoPollution(p)) fail('PROTOTYPE_POLLUTION');

    if (operation === ADMIN_OP.BOOTSTRAP_GROUP_CONTROL) {
      const groupId = resolveNetworkTag(p.groupId);
      const displayName = sanitizeDisplayName(p.displayName || 'Community');
      if (!displayName) fail('EMPTY_DISPLAY_NAME');
      const invitePolicy = p.invitePolicy || 'EVERYONE';
      if (INVITE_POLICIES.indexOf(invitePolicy) === -1) fail('BAD_INVITE_POLICY');
      // Root-only bootstrap: rootAdminPubkey must equal actor
      return {
        schema: SCHEMA_CONTROL,
        version: 1,
        groupId,
        controlEpoch: 1,
        rootAdminPubkey: actor,
        capabilities: {},
        invitePolicy,
        blockedPubkeys: [],
        membershipEpoch: 1,
        groupSettings: { displayName, networkTag: groupId },
        createdAt: Math.floor(Date.now() / 1000),
        membershipRoot: null,
        resolution: null,
      };
    }

    if (!baseRecord) fail('NO_BASE');
    const expectedGroup = resolveNetworkTag(p.groupId);
    if (baseRecord.groupId !== expectedGroup) fail('CROSS_GROUP');

    if (operation === ADMIN_OP.RESOLVE_CONTROL_CONFLICT) {
      if (!actorIsRoot(actor, baseRecord)) fail('ROOT_RESOLVE_REQUIRED');
      const candidates = Array.isArray(p.candidateEventIds) ? p.candidateEventIds : [];
      if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) fail('BAD_CANDIDATES');
      for (let i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] !== 'string' || candidates[i].length < 8 || candidates[i].length > 128) {
          fail('BAD_CANDIDATE_ID');
        }
      }
      const next = cloneControlRecord(baseRecord);
      next.controlEpoch = baseRecord.controlEpoch + 2;
      next.groupId = baseRecord.groupId;
      next.rootAdminPubkey = baseRecord.rootAdminPubkey;
      next.groupSettings.networkTag = baseRecord.groupSettings.networkTag;
      next.resolution = {
        type: 'RESOLVE_CONTROL_CONFLICT',
        conflictEpoch: baseRecord.controlEpoch + 1,
        conflictingEventIds: candidates.slice(),
      };
      return next;
    }

    // Normal ops blocked conceptually during conflict — caller must not request them;
    // acceptance layer also enforces. Signer rejects if params.controlConflict === true.
    if (p.controlConflict === true) fail('CONTROL_CONFLICT');

    if (!actorIsRoot(actor, baseRecord)) {
      const mstat = p.actorMembershipStatus;
      if (mstat === 'BLOCKED' || mstat === 'REMOVED' || mstat === 'CONFLICT') {
        fail('MEMBERSHIP_BLOCKS_ADMIN');
      }
    }

    const next = cloneControlRecord(baseRecord);
    next.controlEpoch = baseRecord.controlEpoch + 1;
    next.groupId = baseRecord.groupId;
    next.rootAdminPubkey = baseRecord.rootAdminPubkey;
    next.groupSettings.networkTag = baseRecord.groupSettings.networkTag;

    if (operation === ADMIN_OP.SET_GROUP_DISPLAY_NAME) {
      if (!actorHas(actor, 'MANAGE_GROUP_SETTINGS', baseRecord)) fail('UNAUTHORIZED');
      const name = sanitizeDisplayName(p.displayName);
      if (!name) fail('EMPTY_DISPLAY_NAME');
      next.groupSettings.displayName = name;
    } else if (operation === ADMIN_OP.SET_INVITE_POLICY) {
      if (!actorHas(actor, 'MANAGE_INVITES', baseRecord)) fail('UNAUTHORIZED');
      if (INVITE_POLICIES.indexOf(p.invitePolicy) === -1) fail('BAD_INVITE_POLICY');
      next.invitePolicy = p.invitePolicy;
    } else if (operation === ADMIN_OP.GRANT_CAPABILITY || operation === ADMIN_OP.REVOKE_CAPABILITY) {
      if (
        !actorHas(actor, 'MANAGE_PERMISSIONS', baseRecord) &&
        !actorHas(actor, 'MANAGE_ADMINS', baseRecord)
      ) {
        fail('UNAUTHORIZED');
      }
      const target = normalizePubkey(p.targetPubkey);
      if (!target) fail('INVALID_PUBKEY');
      if (target === normalizePubkey(baseRecord.rootAdminPubkey)) fail('ROOT_TARGET_FORBIDDEN');
      const cap = assertCapabilityToken(p.capability);
      if (!actorIsRoot(actor, baseRecord)) {
        if (DELEGABLE_BY_PERMISSION_MANAGER.indexOf(cap) === -1) fail('DELEGATION_ESCALATION');
        if (cap === 'MANAGE_ADMINS' || cap === 'MANAGE_PERMISSIONS') fail('DELEGATION_ESCALATION');
      }
      if (!next.capabilities[target]) next.capabilities[target] = [];
      const set = new Set(next.capabilities[target]);
      if (operation === ADMIN_OP.GRANT_CAPABILITY) {
        if (set.size >= MAX_CAPS_PER_TARGET) fail('TOO_MANY_CAPS');
        set.add(cap);
      } else set.delete(cap);
      next.capabilities[target] = Array.from(set).sort();
      if (next.capabilities[target].length === 0) delete next.capabilities[target];
    } else if (
      operation === ADMIN_OP.ADD_MEMBER_TO_BLOCKLIST ||
      operation === ADMIN_OP.REMOVE_MEMBER_FROM_BLOCKLIST
    ) {
      if (!actorHas(actor, 'MANAGE_BLOCKLIST', baseRecord) && !actorHas(actor, 'MANAGE_MEMBERS', baseRecord)) {
        fail('UNAUTHORIZED');
      }
      const target = normalizePubkey(p.targetPubkey);
      if (!target) fail('BAD_PUBKEY');
      if (target === normalizePubkey(baseRecord.rootAdminPubkey)) fail('ROOT_PROTECTED');
      const set = new Set(next.blockedPubkeys);
      if (operation === ADMIN_OP.ADD_MEMBER_TO_BLOCKLIST) {
        if (set.size >= MAX_BLOCKLIST) fail('BLOCKLIST_FULL');
        set.add(target);
      } else set.delete(target);
      next.blockedPubkeys = Array.from(set).sort();
    } else if (operation === ADMIN_OP.CLEAN_REMOVED_MEMBER_CAPABILITIES) {
      if (!actorHas(actor, 'MANAGE_MEMBERS', baseRecord) && !actorIsRoot(actor, baseRecord)) {
        fail('UNAUTHORIZED');
      }
      const target = normalizePubkey(p.targetPubkey);
      if (!target) fail('BAD_PUBKEY');
      if (target === normalizePubkey(baseRecord.rootAdminPubkey)) fail('ROOT_PROTECTED');
      if (p.targetMembershipStatus && p.targetMembershipStatus !== 'REMOVED') {
        fail('TARGET_NOT_REMOVED');
      }
      delete next.capabilities[target];
    } else {
      fail('UNKNOWN_OP');
    }
    return next;
  }

  function buildControlDraft(record, actorPubkey) {
    const actor = normalizePubkey(actorPubkey);
    if (!actor) fail('NO_ACTOR');
    const createdAt = Math.floor(Date.now() / 1000);
    const body = Object.assign({}, record, { createdAt });
    return {
      kind: GROUP_CONTROL_KIND,
      created_at: createdAt,
      tags: [
        ['d', body.groupId],
        ['t', body.groupId],
        ['sos-control', 'v1'],
      ],
      content: JSON.stringify(body),
      pubkey: actor,
    };
  }

  function applyMembershipOperation(operation, baseControl, tipBody, actorPubkey, params) {
    const actor = normalizePubkey(actorPubkey);
    if (!actor) fail('NO_ACTOR');
    if (!baseControl) fail('NO_BASE_CONTROL');
    const p = params && typeof params === 'object' ? params : {};
    if (hasProtoPollution(p)) fail('PROTOTYPE_POLLUTION');
    const expectedGroup = resolveNetworkTag(p.groupId);
    if (baseControl.groupId !== expectedGroup) fail('CROSS_GROUP');

    const memberPubkey = normalizePubkey(p.targetPubkey || p.memberPubkey);
    if (!memberPubkey) fail('NO_MEMBER');
    if (memberPubkey === normalizePubkey(baseControl.rootAdminPubkey)) {
      if (
        operation === ADMIN_OP.BLOCK_MEMBER ||
        operation === ADMIN_OP.REMOVE_MEMBER ||
        operation === ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT
      ) {
        // resolve may set ACTIVE only for root
        if (operation !== ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT || p.status !== 'ACTIVE') {
          fail('ROOT_PROTECTED');
        }
      }
    }

    if (p.controlConflict === true) fail('CONTROL_CONFLICT');
    if (p.memberConflict === true && operation !== ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT) {
      fail('MEMBER_CONFLICT');
    }

    if (!actorIsRoot(actor, baseControl)) {
      const mstat = p.actorMembershipStatus;
      if (mstat === 'BLOCKED' || mstat === 'REMOVED' || mstat === 'CONFLICT') {
        fail('MEMBERSHIP_BLOCKS_ADMIN');
      }
    }

    let status;
    let transition;
    let requireRoot = false;

    if (operation === ADMIN_OP.GRANT_MEMBER_ACTIVE || operation === ADMIN_OP.BOOTSTRAP_MEMBER_ACTIVE) {
      if (operation === ADMIN_OP.BOOTSTRAP_MEMBER_ACTIVE) {
        requireRoot = true;
      } else if (!actorHas(actor, 'MANAGE_MEMBERS', baseControl) && !actorIsRoot(actor, baseControl)) {
        fail('UNAUTHORIZED');
      }
      status = 'ACTIVE';
      transition = 'GRANT_ACTIVE';
    } else if (operation === ADMIN_OP.BLOCK_MEMBER) {
      if (
        !actorHas(actor, 'MANAGE_BLOCKLIST', baseControl) &&
        !actorHas(actor, 'MANAGE_MEMBERS', baseControl) &&
        !actorIsRoot(actor, baseControl)
      ) {
        fail('UNAUTHORIZED');
      }
      status = 'BLOCKED';
      transition = 'BLOCK';
    } else if (operation === ADMIN_OP.UNBLOCK_MEMBER) {
      if (actor === memberPubkey) fail('SELF_UNBLOCK');
      if (
        !actorHas(actor, 'MANAGE_BLOCKLIST', baseControl) &&
        !actorHas(actor, 'MANAGE_MEMBERS', baseControl) &&
        !actorIsRoot(actor, baseControl)
      ) {
        fail('UNAUTHORIZED');
      }
      status = 'ACTIVE';
      transition = 'UNBLOCK';
    } else if (operation === ADMIN_OP.REMOVE_MEMBER) {
      // MANAGE_BLOCKLIST alone cannot remove
      if (!actorHas(actor, 'MANAGE_MEMBERS', baseControl) && !actorIsRoot(actor, baseControl)) {
        fail('UNAUTHORIZED');
      }
      status = 'REMOVED';
      transition = 'REMOVE';
    } else if (operation === ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT) {
      requireRoot = true;
      status = p.status;
      if (['ACTIVE', 'BLOCKED', 'REMOVED'].indexOf(status) === -1) fail('BAD_STATUS');
      transition = 'ROOT_CHECKPOINT';
      const candidates = Array.isArray(p.candidateEventIds) ? p.candidateEventIds : [];
      if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) fail('BAD_CANDIDATES');
    } else {
      fail('UNKNOWN_OP');
    }

    if (requireRoot && !actorIsRoot(actor, baseControl)) fail('ROOT_ONLY');

    const prevRev =
      tipBody && Number.isInteger(tipBody.memberRevision) ? Number(tipBody.memberRevision) : 0;
    const memberRevision = prevRev + 1;
    const body = {
      schema: SCHEMA_MEMBER,
      version: 1,
      groupId: baseControl.groupId,
      memberPubkey,
      status,
      memberRevision,
      controlEpochAtIssue: baseControl.controlEpoch,
      membershipEpoch: baseControl.membershipEpoch,
      issuerPubkey: actor,
      transition,
      createdAt: Math.floor(Date.now() / 1000),
    };
    if (p.inviteEventId) {
      const id = String(p.inviteEventId).toLowerCase();
      if (id.length > INVITE_ID_MAX) fail('INVITE_ID_TOO_LONG');
      body.inviteEventId = id;
    }
    if (p.reason) body.reason = String(p.reason).slice(0, REASON_MAX);
    if (operation === ADMIN_OP.RESOLVE_MEMBERSHIP_CONFLICT) {
      body.resolution = {
        type: 'RESOLVE_MEMBERSHIP_CONFLICT',
        conflictingEventIds: (p.candidateEventIds || []).slice(),
      };
    }
    return body;
  }

  function buildMembershipDraft(body) {
    const actor = normalizePubkey(body.issuerPubkey);
    const memberPubkey = normalizePubkey(body.memberPubkey);
    const d = body.groupId + ':' + memberPubkey;
    const createdAt = Math.floor(Date.now() / 1000);
    const contentBody = Object.assign({}, body, { createdAt, issuerPubkey: actor });
    return {
      kind: MEMBERSHIP_KIND,
      created_at: createdAt,
      tags: [
        ['d', d],
        ['p', memberPubkey],
        ['t', body.groupId],
        ['t', 'sos-group-member'],
        ['status', body.status],
        ['member-revision', String(body.memberRevision)],
        ['membership-epoch', String(body.membershipEpoch)],
        ['control-epoch', String(body.controlEpochAtIssue)],
      ],
      content: JSON.stringify(contentBody),
      pubkey: actor,
    };
  }

  function mapLegacyMutationType(type) {
    const m = {
      SET_GROUP_DISPLAY_NAME: ADMIN_OP.SET_GROUP_DISPLAY_NAME,
      SET_INVITE_POLICY: ADMIN_OP.SET_INVITE_POLICY,
      GRANT_CAPABILITY: ADMIN_OP.GRANT_CAPABILITY,
      REVOKE_CAPABILITY: ADMIN_OP.REVOKE_CAPABILITY,
      ADD_TO_BLOCKLIST: ADMIN_OP.ADD_MEMBER_TO_BLOCKLIST,
      REMOVE_FROM_BLOCKLIST: ADMIN_OP.REMOVE_MEMBER_FROM_BLOCKLIST,
      CLEAR_MEMBER_CAPABILITIES: ADMIN_OP.CLEAN_REMOVED_MEMBER_CAPABILITIES,
      RESOLVE_CONTROL_CONFLICT: ADMIN_OP.RESOLVE_CONTROL_CONFLICT,
    };
    return m[type] || null;
  }

  const api = Object.freeze({
    PROTOCOL_VERSION,
    GROUP_CONTROL_KIND,
    MEMBERSHIP_KIND,
    ADMIN_OP,
    ADMIN_TYPED_SIGN_OPERATIONS: Object.freeze(Object.keys(ADMIN_OP)),
    CONTROL_OPS,
    MEMBER_OPS,
    INVITE_POLICIES,
    MAP_CAPABILITIES,
    DELEGABLE_BY_PERMISSION_MANAGER,
    DISPLAY_NAME_MAX,
    REASON_MAX,
    MAX_CANDIDATES,
    normalizePubkey,
    resolveNetworkTag,
    sanitizeDisplayName,
    validateRequestEnvelope,
    parseControlRecordFromEvent,
    applyControlOperation,
    buildControlDraft,
    applyMembershipOperation,
    buildMembershipDraft,
    mapLegacyMutationType,
    isControlOp: (op) => CONTROL_OPS.has(op),
    isMemberOp: (op) => MEMBER_OPS.has(op),
    ADMIN_SIGNER_CAN_PROVE_BASE_IS_LATEST: false,
    ADMIN_SIGNER_FRESHNESS_DEPENDS_ON_ACCEPTANCE_LAYER: true,
    AC9_CLAIMS_XSS_ISOLATION: false,
    AC9_CLAIMS_TRUSTED_USER_INTENT: false,
    AC9_DOES_NOT_DUPLICATE_F5B: true,
    REQUEST_SIZE_LIMIT_MODEL:
      'displayName<=80; reason<=200; candidates<=32; caps/target<=32; blocklist<=5000; inviteId<=128',
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.SosAdminSigningPolicy = api;
    if (global.NostrApp) global.NostrApp.AdminSigningPolicy = api;
    else if (typeof global.NostrApp === 'undefined' && typeof global.window === 'undefined') {
      // worker global
    }
    try {
      if (global.NostrApp) global.NostrApp.AdminSigningPolicy = api;
    } catch (_e) {}
  }
})(
  typeof self !== 'undefined'
    ? self
    : typeof window !== 'undefined'
      ? window
      : typeof globalThis !== 'undefined'
        ? globalThis
        : this
);
