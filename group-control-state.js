/**
 * AC2 — Signed group control state (foundation).
 * Kind 39001. Strict verify. Epoch-ordered. Relays are not authority.
 * SOS_ACCESS_CONTROL_V2 default OFF — no invite/moderation/membership cutover.
 * Future GROUP_AUDIT_EVENT is separate (not embedded here).
 */
(function initGroupControlState(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GROUP_CONTROL_EVENT_KIND = 39001;
  /** NIP-01 parameterized replaceable (30000–39999). Intentional: one live tip per group via d=groupId. */
  const GROUP_CONTROL_KIND_CLASS = 'parameterized-replaceable';
  const PARAMETERIZED_REPLACEABLE_INTENTIONAL = true;
  /** Canonical d-tag value = groupId (App.NETWORK_TAG / israel-network). */
  const GROUP_CONTROL_D_TAG_VALUE_RULE = 'd === groupId (exact App.NETWORK_TAG binding)';
  /** Authority/history: verified store + local revalidated cache + future GROUP_AUDIT_EVENT — not relay retention. */
  const CONTROL_HISTORY_DEPENDS_ON_RELAY_RETENTION = false;
  const SCHEMA_NAME = 'sos-group-control';
  const SCHEMA_VERSION = 1;
  const CACHE_PREFIX = 'sos_group_control_v1_';
  const MAX_CREATED_AT_SKEW_SEC = 172800;
  const INITIAL_INVITE_POLICY = 'EVERYONE';

  const INVITE_POLICIES = Object.freeze(['EVERYONE', 'AUTHORIZED_USERS_ONLY', 'ADMINS_ONLY']);

  /** Capabilities that may appear in the capabilities map (never ROOT_ADMIN). */
  const MAP_CAPABILITIES = Object.freeze([
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ]);
  const MAP_CAP_SET = new Set(MAP_CAPABILITIES);

  /**
   * Conservative delegation:
   * MANAGE_PERMISSIONS / MANAGE_ADMINS may grant/revoke only these (not admin-management itself).
   */
  const DELEGABLE_BY_PERMISSION_MANAGER = Object.freeze([
    'MANAGE_GROUP_SETTINGS',
    'MODERATE_CONTENT',
    'INVITE_USERS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ]);
  const DELEGABLE_SET = new Set(DELEGABLE_BY_PERMISSION_MANAGER);

  const CAPABILITY_DELEGATION_MODEL =
    'ROOT may issue any control update except changing rootAdminPubkey. ' +
    'MANAGE_PERMISSIONS/MANAGE_ADMINS may only mutate capabilities map and only grant/revoke ' +
    'DELEGABLE_BY_PERMISSION_MANAGER (cannot grant MANAGE_ADMINS/MANAGE_PERMISSIONS/ROOT_ADMIN). ' +
    'MANAGE_GROUP_SETTINGS→groupSettings only; MANAGE_INVITES→invitePolicy only; ' +
    'MANAGE_BLOCKLIST|MANAGE_MEMBERS→blockedPubkeys/membershipEpoch only. ' +
    'Issuer authority always from PREVIOUS verified state. Relays are not authority.';

  const MEMBERSHIP_CONTROL_MODEL_PROPOSAL =
    'AC2 stores membershipEpoch (+ optional future membershipRoot reference). ' +
    'Full member roster lives in separate signed membership records (AC5/AC7), not embedded in GROUP_CONTROL_STATE.';

  /** @type {{ event: object, record: object, status: string } | null} */
  let verified = null;
  /** @type {string} */
  let storeStatus = 'MISSING'; // MISSING | VERIFIED | INVALID | STALE | CONFLICT | CONTROL_CONFLICT | WRONG_GROUP | BAD_ISSUER

  /** All strict-valid control events for this group (authority via reconstruct, not first-seen). */
  const controlEvents = new Map();
  /** @type {object[]} */
  let conflictCandidates = [];

  const CONTROL_CONFLICT_FAILS_CLOSED = true;
  const CONTROL_CONFLICT_CANDIDATES_RETAINED = true;
  const CONTROL_CONFLICT_RESOLUTION_DETERMINISTIC = true;
  const CONTROL_RECONSTRUCTION_ORDER_INDEPENDENT = true;
  const ROOT_CAN_RESOLVE_CONTROL_CONFLICT = true;
  const DELEGATED_ADMIN_CAN_RESOLVE_CONTROL_CONFLICT = false;
  const CURRENT_CONTROL_CONFLICT_RECOVERY_MODEL =
    'Event-set + deterministic reconstruct: unique exact_+1 chain from epoch 1; ' +
    '≥2 distinct valid states at same epoch → CONTROL_CONFLICT (tip frozen at prior epoch); ' +
    'ROOT_ADMIN issues RESOLVE_CONTROL_CONFLICT at conflictEpoch+1 referencing candidate event ids; ' +
    'no first-seen / created_at / arrival-order winner.';

  function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return isHex64(t) ? t : '';
  }

  function resolveGroupId() {
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) return App.NETWORK_TAG.trim();
    return 'israel-network';
  }

  function legacyRootPubkey() {
    if (App.AccessControl && App.AccessControl.LegacyRootAuthorityProvider) {
      const roots = App.AccessControl.LegacyRootAuthorityProvider.listRootAdminPubkeys();
      return roots[0] || '';
    }
    if (Array.isArray(App.adminSourceKeys) && App.adminSourceKeys[0]) {
      return normalizePubkey(App.adminSourceKeys[0]);
    }
    if (App.adminPublicKeys instanceof Set) {
      const first = App.adminPublicKeys.values().next();
      return first && first.value ? normalizePubkey(first.value) : '';
    }
    return '';
  }

  function initialDisplayName() {
    // Distinct from groupId. Bootstrap from COMMUNITY_CONTEXT product label only.
    if (typeof App.COMMUNITY_CONTEXT === 'string' && App.COMMUNITY_CONTEXT.trim()) {
      return App.COMMUNITY_CONTEXT.trim();
    }
    return 'SOS';
  }

  function deepFreeze(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    });
    return obj;
  }

  function canonicalizeCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Object.assign(new Error('BAD_CAPABILITIES'), { code: 'BAD_CAPABILITIES' });
    }
    const out = Object.create(null);
    const keys = Object.keys(raw).map(normalizePubkey).filter(Boolean).sort();
    const seenPk = new Set();
    keys.forEach((pk) => {
      if (seenPk.has(pk)) return;
      seenPk.add(pk);
      // find original key value
      let list = null;
      Object.keys(raw).forEach((k) => {
        if (normalizePubkey(k) === pk) list = raw[k];
      });
      if (!Array.isArray(list)) {
        throw Object.assign(new Error('BAD_CAPABILITIES'), { code: 'BAD_CAPABILITIES' });
      }
      const caps = [];
      const seenC = new Set();
      list.forEach((c) => {
        if (typeof c !== 'string' || c !== c.trim()) {
          throw Object.assign(new Error('UNKNOWN_CAPABILITY'), { code: 'UNKNOWN_CAPABILITY', capability: c });
        }
        if (c === 'ROOT_ADMIN') {
          throw Object.assign(new Error('ROOT_ADMIN_IN_MAP'), { code: 'ROOT_ADMIN_IN_MAP' });
        }
        if (!MAP_CAP_SET.has(c)) {
          throw Object.assign(new Error('UNKNOWN_CAPABILITY'), { code: 'UNKNOWN_CAPABILITY', capability: c });
        }
        if (!seenC.has(c)) {
          seenC.add(c);
          caps.push(c);
        }
      });
      caps.sort();
      if (caps.length) out[pk] = caps;
    });
    return out;
  }

  function canonicalizeBlocked(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) {
      throw Object.assign(new Error('BAD_BLOCKLIST'), { code: 'BAD_BLOCKLIST' });
    }
    const out = [];
    const seen = new Set();
    list.forEach((p) => {
      const pk = normalizePubkey(p);
      if (!pk) {
        throw Object.assign(new Error('INVALID_PUBKEY'), { code: 'INVALID_PUBKEY' });
      }
      if (!seen.has(pk)) {
        seen.add(pk);
        out.push(pk);
      }
    });
    out.sort();
    return out;
  }

  function parseAndValidateRecord(contentStr) {
    let raw;
    try {
      raw = JSON.parse(contentStr);
    } catch (_e) {
      throw Object.assign(new Error('BAD_JSON'), { code: 'BAD_JSON' });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw Object.assign(new Error('BAD_SCHEMA'), { code: 'BAD_SCHEMA' });
    }
    if (raw.schema !== SCHEMA_NAME) {
      throw Object.assign(new Error('BAD_SCHEMA'), { code: 'BAD_SCHEMA' });
    }
    if (raw.version !== SCHEMA_VERSION) {
      throw Object.assign(new Error('UNSUPPORTED_VERSION'), { code: 'UNSUPPORTED_VERSION' });
    }
    if (typeof raw.groupId !== 'string' || !raw.groupId.trim()) {
      throw Object.assign(new Error('BAD_GROUP'), { code: 'BAD_GROUP' });
    }
    if (typeof raw.controlEpoch !== 'number' || !Number.isInteger(raw.controlEpoch) || raw.controlEpoch < 1) {
      throw Object.assign(new Error('BAD_EPOCH'), { code: 'BAD_EPOCH' });
    }
    const root = normalizePubkey(raw.rootAdminPubkey);
    if (!root) {
      throw Object.assign(new Error('BAD_ROOT'), { code: 'BAD_ROOT' });
    }
    if (INVITE_POLICIES.indexOf(raw.invitePolicy) === -1) {
      throw Object.assign(new Error('BAD_INVITE_POLICY'), { code: 'BAD_INVITE_POLICY' });
    }
    if (
      typeof raw.membershipEpoch !== 'number' ||
      !Number.isInteger(raw.membershipEpoch) ||
      raw.membershipEpoch < 0
    ) {
      throw Object.assign(new Error('BAD_MEMBERSHIP_EPOCH'), { code: 'BAD_MEMBERSHIP_EPOCH' });
    }
    if (typeof raw.createdAt !== 'number' || !Number.isInteger(raw.createdAt)) {
      throw Object.assign(new Error('BAD_CREATED_AT'), { code: 'BAD_CREATED_AT' });
    }
    const gs = raw.groupSettings;
    if (!gs || typeof gs !== 'object' || Array.isArray(gs)) {
      throw Object.assign(new Error('BAD_GROUP_SETTINGS'), { code: 'BAD_GROUP_SETTINGS' });
    }
    if (typeof gs.displayName !== 'string' || !gs.displayName.trim()) {
      throw Object.assign(new Error('BAD_DISPLAY_NAME'), { code: 'BAD_DISPLAY_NAME' });
    }
    if (typeof gs.networkTag !== 'string' || gs.networkTag !== raw.groupId) {
      throw Object.assign(new Error('BAD_NETWORK_TAG'), { code: 'BAD_NETWORK_TAG' });
    }
    if (gs.displayName.trim() === raw.groupId) {
      // allowed to equal by coincidence but we still treat as distinct fields — OK
    }

    const capabilities = canonicalizeCapabilities(raw.capabilities || {});
    if (Object.prototype.hasOwnProperty.call(capabilities, root) === false) {
      // root must not rely on map for ROOT_ADMIN; map must not list ROOT_ADMIN
    }
    Object.keys(capabilities).forEach((pk) => {
      if ((capabilities[pk] || []).indexOf('ROOT_ADMIN') !== -1) {
        throw Object.assign(new Error('ROOT_ADMIN_IN_MAP'), { code: 'ROOT_ADMIN_IN_MAP' });
      }
    });

    const blockedPubkeys = canonicalizeBlocked(raw.blockedPubkeys || []);
    if (blockedPubkeys.indexOf(root) !== -1) {
      throw Object.assign(new Error('ROOT_BLOCKED'), { code: 'ROOT_BLOCKED' });
    }

    // Reject private-looking fields if ever present
    const forbidden = ['privateKey', 'nsec', 'password', 'token', 'emailSecret', 'k'];
    forbidden.forEach((f) => {
      if (Object.prototype.hasOwnProperty.call(raw, f)) {
        throw Object.assign(new Error('FORBIDDEN_FIELD'), { code: 'FORBIDDEN_FIELD' });
      }
    });

    let resolution = null;
    if (raw.resolution != null) {
      if (typeof raw.resolution !== 'object') {
        throw Object.assign(new Error('BAD_RESOLUTION'), { code: 'BAD_RESOLUTION' });
      }
      if (raw.resolution.type !== 'RESOLVE_CONTROL_CONFLICT') {
        throw Object.assign(new Error('BAD_RESOLUTION_TYPE'), { code: 'BAD_RESOLUTION_TYPE' });
      }
      const conflictEpoch = Number(raw.resolution.conflictEpoch);
      if (!Number.isInteger(conflictEpoch) || conflictEpoch < 1) {
        throw Object.assign(new Error('BAD_RESOLUTION_EPOCH'), { code: 'BAD_RESOLUTION_EPOCH' });
      }
      const ids = Array.isArray(raw.resolution.conflictingEventIds)
        ? raw.resolution.conflictingEventIds.map((x) => String(x || '').toLowerCase()).filter(Boolean)
        : [];
      resolution = Object.freeze({
        type: 'RESOLVE_CONTROL_CONFLICT',
        conflictEpoch,
        conflictingEventIds: Object.freeze(ids.slice().sort()),
      });
    }

    return deepFreeze({
      schema: SCHEMA_NAME,
      version: SCHEMA_VERSION,
      groupId: raw.groupId.trim(),
      controlEpoch: raw.controlEpoch,
      rootAdminPubkey: root,
      capabilities: deepFreeze(capabilities),
      invitePolicy: raw.invitePolicy,
      blockedPubkeys: Object.freeze(blockedPubkeys.slice()),
      membershipEpoch: raw.membershipEpoch,
      groupSettings: Object.freeze({
        displayName: gs.displayName.trim(),
        networkTag: gs.networkTag.trim(),
      }),
      createdAt: raw.createdAt,
      membershipRoot: typeof raw.membershipRoot === 'string' ? raw.membershipRoot : null,
      resolution,
    });
  }

  function serializeRecord(record) {
    // Deterministic JSON for content (sorted keys via manual build)
    const caps = {};
    Object.keys(record.capabilities)
      .sort()
      .forEach((pk) => {
        caps[pk] = record.capabilities[pk].slice().sort();
      });
    const obj = {
      schema: record.schema,
      version: record.version,
      groupId: record.groupId,
      controlEpoch: record.controlEpoch,
      rootAdminPubkey: record.rootAdminPubkey,
      capabilities: caps,
      invitePolicy: record.invitePolicy,
      blockedPubkeys: record.blockedPubkeys.slice().sort(),
      membershipEpoch: record.membershipEpoch,
      groupSettings: {
        displayName: record.groupSettings.displayName,
        networkTag: record.groupSettings.networkTag,
      },
      createdAt: record.createdAt,
    };
    if (record.membershipRoot) obj.membershipRoot = record.membershipRoot;
    if (record.resolution) {
      obj.resolution = {
        type: record.resolution.type,
        conflictEpoch: record.resolution.conflictEpoch,
        conflictingEventIds: (record.resolution.conflictingEventIds || []).slice().sort(),
      };
    }
    return JSON.stringify(obj);
  }

  function buildBootstrapRecord(opts) {
    const groupId = (opts && opts.groupId) || resolveGroupId();
    const root = normalizePubkey((opts && opts.rootAdminPubkey) || legacyRootPubkey());
    if (!root) throw Object.assign(new Error('NO_LEGACY_ROOT'), { code: 'NO_LEGACY_ROOT' });
    const createdAt = (opts && opts.createdAt) || Math.floor(Date.now() / 1000);
    return parseAndValidateRecord(
      JSON.stringify({
        schema: SCHEMA_NAME,
        version: SCHEMA_VERSION,
        groupId,
        controlEpoch: 1,
        rootAdminPubkey: root,
        capabilities: {},
        invitePolicy: INITIAL_INVITE_POLICY,
        blockedPubkeys: [],
        membershipEpoch: 1,
        groupSettings: {
          displayName: (opts && opts.displayName) || initialDisplayName(),
          networkTag: groupId,
        },
        createdAt,
      })
    );
  }

  function strictVerifyEvent(event) {
    if (typeof App.strictVerifyNostrEvent === 'function') {
      return App.strictVerifyNostrEvent(event) === true;
    }
    const NT = window.NostrTools;
    if (!NT || typeof NT.getEventHash !== 'function' || typeof NT.verifyEvent !== 'function') return false;
    try {
      const clean = {
        id: String(event.id).toLowerCase(),
        pubkey: String(event.pubkey).toLowerCase(),
        created_at: event.created_at,
        kind: event.kind,
        tags: JSON.parse(JSON.stringify(event.tags)),
        content: event.content,
        sig: String(event.sig).toLowerCase(),
      };
      if (NT.getEventHash(clean) !== clean.id) return false;
      return NT.verifyEvent(clean) === true;
    } catch (_e) {
      return false;
    }
  }

  function issuerCapsFromPrevious(prevRecord, issuerPk) {
    const pk = normalizePubkey(issuerPk);
    if (!pk || !prevRecord) return [];
    if (pk === prevRecord.rootAdminPubkey) {
      return ['ROOT_ADMIN'].concat(MAP_CAPABILITIES);
    }
    const list = prevRecord.capabilities[pk] || [];
    return list.slice();
  }

  function issuerHas(prev, issuerPk, cap) {
    return issuerCapsFromPrevious(prev, issuerPk).indexOf(cap) !== -1;
  }

  function jsonStable(v) {
    return JSON.stringify(v);
  }

  function authorizeTransition(prev, next, issuerPk) {
    const issuer = normalizePubkey(issuerPk);
    if (!issuer) {
      throw Object.assign(new Error('BAD_ISSUER'), { code: 'BAD_ISSUER' });
    }

    if (!prev) {
      // Bootstrap: only legacy root, epoch 1, root must match legacy, empty caps
      const legacy = legacyRootPubkey();
      if (!legacy || issuer !== legacy) {
        throw Object.assign(new Error('BAD_ISSUER'), { code: 'BAD_ISSUER' });
      }
      if (next.controlEpoch !== 1) {
        throw Object.assign(new Error('BAD_EPOCH'), { code: 'BAD_EPOCH' });
      }
      if (next.rootAdminPubkey !== legacy) {
        throw Object.assign(new Error('ROOT_MISMATCH'), { code: 'ROOT_MISMATCH' });
      }
      if (Object.keys(next.capabilities).length !== 0) {
        throw Object.assign(new Error('BOOTSTRAP_CAPS'), { code: 'BOOTSTRAP_CAPS' });
      }
      if (next.invitePolicy !== INITIAL_INVITE_POLICY) {
        throw Object.assign(new Error('BOOTSTRAP_POLICY'), { code: 'BOOTSTRAP_POLICY' });
      }
      return true;
    }

    // Epoch: prefer exact +1; root conflict resolution may advance conflictEpoch+1 from frozen tip
    const isRootResolve =
      next.resolution &&
      next.resolution.type === 'RESOLVE_CONTROL_CONFLICT' &&
      issuer === (prev ? prev.rootAdminPubkey : next.rootAdminPubkey);

    if (isRootResolve && prev) {
      const cEpoch = Number(next.resolution.conflictEpoch);
      if (cEpoch !== prev.controlEpoch + 1) {
        throw Object.assign(new Error('BAD_RESOLUTION_EPOCH'), { code: 'BAD_RESOLUTION_EPOCH' });
      }
      if (next.controlEpoch !== cEpoch + 1) {
        throw Object.assign(new Error('BAD_EPOCH_STEP'), { code: 'BAD_EPOCH_STEP' });
      }
      if (issuer !== prev.rootAdminPubkey) {
        throw Object.assign(new Error('ROOT_RESOLVE_REQUIRED'), { code: 'ROOT_RESOLVE_REQUIRED' });
      }
    } else if (next.controlEpoch !== prev.controlEpoch + 1) {
      throw Object.assign(new Error('BAD_EPOCH_STEP'), { code: 'BAD_EPOCH_STEP' });
    }
    if (next.resolution && !isRootResolve) {
      throw Object.assign(new Error('ROOT_RESOLVE_REQUIRED'), { code: 'ROOT_RESOLVE_REQUIRED' });
    }
    if (next.groupId !== prev.groupId) {
      throw Object.assign(new Error('GROUP_CHANGED'), { code: 'GROUP_CHANGED' });
    }
    if (next.rootAdminPubkey !== prev.rootAdminPubkey) {
      throw Object.assign(new Error('ROOT_IMMUTABLE'), { code: 'ROOT_IMMUTABLE' });
    }

    const isRoot = issuer === prev.rootAdminPubkey;
    if (!isRoot && issuerCapsFromPrevious(prev, issuer).length === 0) {
      throw Object.assign(new Error('BAD_ISSUER'), { code: 'BAD_ISSUER' });
    }

    // Detect field changes
    const capsChanged = jsonStable(prev.capabilities) !== jsonStable(next.capabilities);
    const policyChanged = prev.invitePolicy !== next.invitePolicy;
    const blockChanged = jsonStable(prev.blockedPubkeys) !== jsonStable(next.blockedPubkeys);
    const memEpochChanged = prev.membershipEpoch !== next.membershipEpoch;
    const settingsChanged = jsonStable(prev.groupSettings) !== jsonStable(next.groupSettings);

    if (isRoot) return true;

    if (capsChanged) {
      if (!(issuerHas(prev, issuer, 'MANAGE_PERMISSIONS') || issuerHas(prev, issuer, 'MANAGE_ADMINS'))) {
        throw Object.assign(new Error('UNAUTHORIZED_CAPS'), { code: 'UNAUTHORIZED_CAPS' });
      }
      // Validate granted/revoked caps are within delegable set
      const allPk = new Set([...Object.keys(prev.capabilities), ...Object.keys(next.capabilities)]);
      allPk.forEach((pk) => {
        const before = new Set(prev.capabilities[pk] || []);
        const after = new Set(next.capabilities[pk] || []);
        after.forEach((c) => {
          if (!before.has(c) && !DELEGABLE_SET.has(c)) {
            throw Object.assign(new Error('DELEGATION_ESCALATION'), { code: 'DELEGATION_ESCALATION' });
          }
        });
        before.forEach((c) => {
          if (!after.has(c) && !DELEGABLE_SET.has(c)) {
            throw Object.assign(new Error('DELEGATION_ESCALATION'), { code: 'DELEGATION_ESCALATION' });
          }
        });
      });
    }
    if (policyChanged && !issuerHas(prev, issuer, 'MANAGE_INVITES') && !issuerHas(prev, issuer, 'MANAGE_PERMISSIONS')) {
      throw Object.assign(new Error('UNAUTHORIZED_POLICY'), { code: 'UNAUTHORIZED_POLICY' });
    }
    if (
      (blockChanged || memEpochChanged) &&
      !(issuerHas(prev, issuer, 'MANAGE_BLOCKLIST') || issuerHas(prev, issuer, 'MANAGE_MEMBERS'))
    ) {
      throw Object.assign(new Error('UNAUTHORIZED_MEMBERS'), { code: 'UNAUTHORIZED_MEMBERS' });
    }
    if (settingsChanged && !issuerHas(prev, issuer, 'MANAGE_GROUP_SETTINGS')) {
      throw Object.assign(new Error('UNAUTHORIZED_SETTINGS'), { code: 'UNAUTHORIZED_SETTINGS' });
    }
    return true;
  }

  function cacheKey(groupId) {
    return CACHE_PREFIX + String(groupId || resolveGroupId());
  }

  function loadCacheRaw() {
    try {
      const raw = window.localStorage.getItem(cacheKey(resolveGroupId()));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  function setStatus(status) {
    storeStatus = status;
  }

  function contentFingerprint(record) {
    return serializeRecord(record);
  }

  function candidateMeta(event, record) {
    return Object.freeze({
      eventId: String(event.id || ''),
      issuerPubkey: normalizePubkey(event.pubkey),
      controlEpoch: record.controlEpoch,
      stateHash: contentFingerprint(record),
      createdAt: event.created_at,
      resolutionType: record.resolution ? record.resolution.type : null,
    });
  }

  function freezeEvent(event, issuer) {
    return Object.freeze({
      id: event.id,
      pubkey: issuer,
      created_at: event.created_at,
      kind: event.kind,
      tags: JSON.parse(JSON.stringify(event.tags)),
      content: event.content,
      sig: event.sig,
    });
  }

  function reconstructControlState() {
    conflictCandidates = [];
    const rows = [];
    controlEvents.forEach((row) => rows.push(row));
    if (!rows.length) {
      verified = null;
      setStatus('MISSING');
      return { ok: false, status: 'MISSING', code: 'NO_EVENTS' };
    }

    let tipRecord = null;
    let tipEvent = null;
    let epoch = 0;

    // Max epoch present
    let maxEpoch = 0;
    rows.forEach((r) => {
      if (r.record.controlEpoch > maxEpoch) maxEpoch = r.record.controlEpoch;
    });

    for (let e = 1; e <= maxEpoch; e++) {
      const atEpoch = rows.filter((r) => r.record.controlEpoch === e);
      if (atEpoch.length === 0) {
        // Gap — stop (fail closed). Higher events unapplied.
        break;
      }

      // Root resolve at this epoch supersedes forks at conflictEpoch = e-1 when tip is e-2
      const rootResolves = atEpoch.filter(
        (r) =>
          r.record.resolution &&
          r.record.resolution.type === 'RESOLVE_CONTROL_CONFLICT' &&
          normalizePubkey(r.event.pubkey) === normalizePubkey(r.record.rootAdminPubkey)
      );

      let chosen = null;
      if (rootResolves.length > 0) {
        const uniq = [];
        const seen = new Set();
        rootResolves.forEach((r) => {
          const fp = contentFingerprint(r.record);
          if (!seen.has(fp)) {
            seen.add(fp);
            uniq.push(r);
          }
        });
        if (uniq.length > 1) {
          conflictCandidates = Object.freeze(uniq.map((r) => candidateMeta(r.event, r.record)));
          // Keep prior tip
          if (tipRecord) {
            verified = { event: tipEvent, record: tipRecord, status: 'VERIFIED' };
          }
          setStatus('CONTROL_CONFLICT');
          return {
            ok: false,
            status: 'CONTROL_CONFLICT',
            code: 'ROOT_RESOLVE_CONFLICT',
            conflictCandidates,
            record: tipRecord,
            event: tipEvent,
          };
        }
        // Validate resolve against tip
        try {
          authorizeTransition(tipRecord, uniq[0].record, uniq[0].event.pubkey);
          chosen = uniq[0];
        } catch (err) {
          // invalid resolve — ignore for chain
          chosen = null;
        }
      }

      if (!chosen) {
        const valid = [];
        const seenFp = new Set();
        atEpoch.forEach((r) => {
          if (r.record.resolution) return; // non-chosen resolves already handled
          try {
            authorizeTransition(tipRecord, r.record, r.event.pubkey);
            const fp = contentFingerprint(r.record);
            if (seenFp.has(fp)) return;
            seenFp.add(fp);
            valid.push(r);
          } catch (_e) {
            /* unauthorized / illegal */
          }
        });
        if (valid.length === 0) break;
        if (valid.length > 1) {
          conflictCandidates = Object.freeze(valid.map((r) => candidateMeta(r.event, r.record)));
          // Look ahead: ROOT may resolve at conflictEpoch+1 referencing candidates.
          // Do not pick by arrival/created_at/event-id; only explicit RESOLVE_CONTROL_CONFLICT.
          const resolveEpoch = e + 1;
          const resolvesAtNext = rows.filter(
            (r) =>
              r.record.controlEpoch === resolveEpoch &&
              r.record.resolution &&
              r.record.resolution.type === 'RESOLVE_CONTROL_CONFLICT' &&
              Number(r.record.resolution.conflictEpoch) === e &&
              normalizePubkey(r.event.pubkey) === normalizePubkey(r.record.rootAdminPubkey)
          );
          const uniqResolves = [];
          const seenResolveFp = new Set();
          resolvesAtNext.forEach((r) => {
            const fp = contentFingerprint(r.record);
            if (!seenResolveFp.has(fp)) {
              seenResolveFp.add(fp);
              uniqResolves.push(r);
            }
          });
          if (uniqResolves.length === 1) {
            try {
              authorizeTransition(tipRecord, uniqResolves[0].record, uniqResolves[0].event.pubkey);
              tipRecord = uniqResolves[0].record;
              tipEvent = uniqResolves[0].event;
              epoch = resolveEpoch;
              conflictCandidates = Object.freeze([]);
              // Skip the resolve epoch on next iteration (already applied).
              e = resolveEpoch;
              continue;
            } catch (_resolveErr) {
              /* invalid resolve — fall through to fail-closed conflict */
            }
          } else if (uniqResolves.length > 1) {
            conflictCandidates = Object.freeze(
              uniqResolves.map((r) => candidateMeta(r.event, r.record))
            );
            if (tipRecord) {
              verified = { event: tipEvent, record: tipRecord, status: 'VERIFIED' };
            } else {
              verified = null;
            }
            setStatus('CONTROL_CONFLICT');
            return {
              ok: false,
              status: 'CONTROL_CONFLICT',
              code: 'ROOT_RESOLVE_CONFLICT',
              conflictCandidates,
              record: tipRecord,
              event: tipEvent,
            };
          }
          if (tipRecord) {
            verified = { event: tipEvent, record: tipRecord, status: 'VERIFIED' };
          } else {
            verified = null;
          }
          setStatus('CONTROL_CONFLICT');
          return {
            ok: false,
            status: 'CONTROL_CONFLICT',
            code: 'SAME_EPOCH_CONFLICT',
            conflictCandidates,
            record: tipRecord,
            event: tipEvent,
          };
        }
        chosen = valid[0];
      }

      tipRecord = chosen.record;
      tipEvent = chosen.event;
      epoch = e;
    }

    if (!tipRecord) {
      verified = null;
      setStatus('MISSING');
      return { ok: false, status: 'MISSING', code: 'NO_TIP' };
    }
    verified = { event: tipEvent, record: tipRecord, status: 'VERIFIED' };
    setStatus('VERIFIED');
    conflictCandidates = Object.freeze([]);
    return { ok: true, status: 'VERIFIED', record: tipRecord, event: tipEvent, controlEpoch: epoch };
  }

  function persistEventSet() {
    try {
      const rows = [];
      controlEvents.forEach((row) => rows.push({ event: row.event }));
      window.localStorage.setItem(
        cacheKey(resolveGroupId()),
        JSON.stringify({ v: 2, rows, updatedAt: Date.now() })
      );
    } catch (_e) {}
  }

  /**
   * Accept a signed GROUP_CONTROL event. Fail closed. Order-independent via reconstruct.
   * @returns {{ ok: boolean, status: string, record?: object, event?: object, code?: string }}
   */
  function acceptControlEvent(event, options) {
    const opts = options || {};
    try {
      if (!event || typeof event !== 'object') {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'MALFORMED' };
      }
      if (event.kind !== GROUP_CONTROL_EVENT_KIND) {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'BAD_KIND' };
      }
      if (!strictVerifyEvent(event)) {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'STRICT_VERIFY_FAILED' };
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof event.created_at === 'number' && event.created_at > now + MAX_CREATED_AT_SKEW_SEC) {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'FUTURE_CREATED_AT' };
      }

      const record = parseAndValidateRecord(event.content);
      const expectedGroup = resolveGroupId();
      if (record.groupId !== expectedGroup) {
        setStatus('WRONG_GROUP');
        return { ok: false, status: 'WRONG_GROUP', code: 'CROSS_GROUP' };
      }

      const dTags = Array.isArray(event.tags)
        ? event.tags.filter((t) => Array.isArray(t) && t[0] === 'd')
        : [];
      if (dTags.length === 0) {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'MISSING_D_TAG' };
      }
      if (dTags.length > 1) {
        const values = dTags.map((t) => String(t[1] || ''));
        const uniq = [...new Set(values)];
        if (uniq.length > 1) {
          setStatus('INVALID');
          return { ok: false, status: 'INVALID', code: 'CONFLICTING_D_TAG' };
        }
      }
      const dVal = String(dTags[0][1] || '');
      if (dVal !== record.groupId) {
        setStatus('INVALID');
        return { ok: false, status: 'INVALID', code: 'WRONG_D_TAG' };
      }
      if (dVal !== expectedGroup) {
        setStatus('WRONG_GROUP');
        return { ok: false, status: 'WRONG_GROUP', code: 'CROSS_GROUP_D_TAG' };
      }

      const issuer = normalizePubkey(event.pubkey);
      const frozen = freezeEvent(event, issuer);
      const eventId = String(event.id);
      controlEvents.set(eventId, { event: frozen, record });

      const prevTipId = verified && verified.event ? String(verified.event.id) : '';
      const prevEpoch = verified && verified.record ? verified.record.controlEpoch : 0;
      const result = reconstructControlState();
      if (opts.persist !== false) persistEventSet();

      if (result.status === 'CONTROL_CONFLICT' || result.status === 'CONFLICT') {
        return {
          ok: false,
          status: 'CONTROL_CONFLICT',
          code: result.code || 'SAME_EPOCH_CONFLICT',
          conflictCandidates: result.conflictCandidates || getConflictCandidates(),
          record: result.record || null,
          event: result.event || null,
        };
      }
      if (!result.ok) {
        return { ok: false, status: result.status || storeStatus, code: result.code || 'REJECTED' };
      }

      const tipId = result.event ? String(result.event.id) : '';
      // Exact replay of current tip
      if (tipId === eventId && prevTipId === eventId) {
        return { ok: true, status: 'VERIFIED', record: result.record, event: result.event, code: 'REPLAY_IDEMPOTENT' };
      }
      // New tip advanced to this event
      if (tipId === eventId) {
        return { ok: true, status: 'VERIFIED', record: result.record, event: result.event };
      }
      // Event stored but not applied (unauthorized, skipped epoch, stale, etc.)
      const code =
        record.controlEpoch < prevEpoch
          ? 'STALE_EPOCH'
          : record.controlEpoch > prevEpoch + 1
            ? 'BAD_EPOCH_STEP'
            : 'NOT_APPLIED';
      if (code === 'STALE_EPOCH') setStatus('STALE');
      else if (code === 'BAD_EPOCH_STEP') setStatus(prevTipId ? 'VERIFIED' : storeStatus);
      return {
        ok: false,
        status: code === 'STALE_EPOCH' ? 'STALE' : 'INVALID',
        code,
        record: result.record,
        event: result.event,
      };
    } catch (e) {
      const code = (e && e.code) || 'REJECTED';
      if (code === 'BAD_ISSUER' || code === 'ROOT_MISMATCH') setStatus('BAD_ISSUER');
      else if (code === 'STALE_EPOCH') setStatus('STALE');
      else if (code === 'SAME_EPOCH_CONFLICT') setStatus('CONTROL_CONFLICT');
      else if (code === 'CROSS_GROUP' || code === 'GROUP_CHANGED') setStatus('WRONG_GROUP');
      else setStatus('INVALID');
      return { ok: false, status: storeStatus, code };
    }
  }

  function ingestControlEvents(eventList, options) {
    const list = Array.isArray(eventList) ? eventList : [];
    const outcomes = [];
    list.forEach((ev) => {
      const r = acceptControlEvent(ev, Object.assign({}, options || {}, { persist: false }));
      outcomes.push({ eventId: ev && ev.id, ok: r.ok, status: r.status, code: r.code });
    });
    if ((options || {}).persist !== false) persistEventSet();
    reconstructControlState();
    return outcomes;
  }

  function getConflictCandidates() {
    return Object.freeze((conflictCandidates || []).slice());
  }

  function mutationsBlockedByConflict() {
    return storeStatus === 'CONTROL_CONFLICT' || storeStatus === 'CONFLICT';
  }

  function clearVerified() {
    verified = null;
    controlEvents.clear();
    conflictCandidates = [];
    setStatus('MISSING');
    try {
      window.localStorage.removeItem(cacheKey(resolveGroupId()));
    } catch (_e) {}
  }

  function revalidateFromCache() {
    const cached = loadCacheRaw();
    if (!cached) {
      clearVerified();
      return { ok: false, status: 'MISSING', code: 'NO_CACHE' };
    }
    clearVerified();
    // v2 event-set cache
    if (cached && cached.v === 2 && Array.isArray(cached.rows)) {
      const events = cached.rows.map((r) => r && r.event).filter(Boolean);
      ingestControlEvents(events, { persist: false });
      if (storeStatus === 'VERIFIED') {
        persistEventSet();
        return { ok: true, status: 'VERIFIED', record: verified && verified.record, event: verified && verified.event };
      }
      if (storeStatus === 'CONTROL_CONFLICT') {
        return {
          ok: false,
          status: 'CONTROL_CONFLICT',
          code: 'SAME_EPOCH_CONFLICT',
          conflictCandidates: getConflictCandidates(),
        };
      }
      try {
        window.localStorage.removeItem(cacheKey(resolveGroupId()));
      } catch (_e) {}
      return { ok: false, status: storeStatus, code: 'CACHE_REJECTED' };
    }
    // legacy single-event cache
    const result = acceptControlEvent(cached, { persist: false });
    if (!result.ok && result.status !== 'CONTROL_CONFLICT') {
      try {
        window.localStorage.removeItem(cacheKey(resolveGroupId()));
      } catch (_e) {}
    } else if (result.ok) {
      persistEventSet();
    }
    return result;
  }

  function getVerifiedControlState() {
    if (!verified || !verified.record) return null;
    const r = verified.record;
    const caps = Object.create(null);
    Object.keys(r.capabilities).forEach((pk) => {
      caps[pk] = r.capabilities[pk].slice();
    });
    return deepFreeze({
      schema: r.schema,
      version: r.version,
      groupId: r.groupId,
      controlEpoch: r.controlEpoch,
      rootAdminPubkey: r.rootAdminPubkey,
      capabilities: caps,
      invitePolicy: r.invitePolicy,
      blockedPubkeys: r.blockedPubkeys.slice(),
      membershipEpoch: r.membershipEpoch,
      groupSettings: { displayName: r.groupSettings.displayName, networkTag: r.groupSettings.networkTag },
      createdAt: r.createdAt,
      membershipRoot: r.membershipRoot,
      eventId: verified.event && verified.event.id,
      issuerPubkey: verified.event && verified.event.pubkey,
      verified: true,
      source: 'signed-group-control',
    });
  }

  function getControlEpoch() {
    return verified && verified.record ? verified.record.controlEpoch : 0;
  }

  function getInvitePolicy() {
    return verified && verified.record ? verified.record.invitePolicy : null;
  }

  function getCapabilities(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !verified || !verified.record) return Object.freeze([]);
    const r = verified.record;
    if (pk === r.rootAdminPubkey) {
      return Object.freeze(['ROOT_ADMIN'].concat(MAP_CAPABILITIES));
    }
    return Object.freeze((r.capabilities[pk] || []).slice());
  }

  function isBlocked(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk || !verified || !verified.record) return false;
    return verified.record.blockedPubkeys.indexOf(pk) !== -1;
  }

  function getGroupSettings() {
    if (!verified || !verified.record) return null;
    return Object.freeze({
      displayName: verified.record.groupSettings.displayName,
      networkTag: verified.record.groupSettings.networkTag,
      groupId: verified.record.groupId,
    });
  }

  function getStatus() {
    return storeStatus;
  }

  function buildSignDraft(record, pubkey) {
    const content = serializeRecord(record);
    return {
      kind: GROUP_CONTROL_EVENT_KIND,
      created_at: record.createdAt,
      pubkey: pubkey || record.rootAdminPubkey,
      tags: [
        ['d', record.groupId],
        ['t', record.groupId],
        ['sos-control', 'v' + SCHEMA_VERSION],
      ],
      content,
    };
  }

  async function signControlRecord(record) {
    const S = App.SosCryptoSigner;
    if (!S || typeof S.signGroupControlEvent !== 'function') {
      throw Object.assign(new Error('SIGNER_MISSING'), { code: 'SIGNER_MISSING' });
    }
    const draft = buildSignDraft(record, App.publicKey || record.rootAdminPubkey);
    return Promise.resolve(S.signGroupControlEvent(draft));
  }

  const api = {
    GROUP_CONTROL_EVENT_KIND,
    GROUP_CONTROL_KIND_CLASS,
    PARAMETERIZED_REPLACEABLE_INTENTIONAL,
    GROUP_CONTROL_D_TAG_VALUE_RULE,
    CONTROL_HISTORY_DEPENDS_ON_RELAY_RETENTION,
    SCHEMA_NAME,
    SCHEMA_VERSION,
    INITIAL_INVITE_POLICY,
    INVITE_POLICIES,
    MAP_CAPABILITIES,
    DELEGABLE_BY_PERMISSION_MANAGER,
    CAPABILITY_DELEGATION_MODEL,
    MEMBERSHIP_CONTROL_MODEL_PROPOSAL,
    CURRENT_CONTROL_CONFLICT_RECOVERY_MODEL,
    ROOT_CAN_RESOLVE_CONTROL_CONFLICT,
    DELEGATED_ADMIN_CAN_RESOLVE_CONTROL_CONFLICT,
    CONTROL_CONFLICT_FAILS_CLOSED,
    CONTROL_CONFLICT_CANDIDATES_RETAINED,
    CONTROL_CONFLICT_RESOLUTION_DETERMINISTIC,
    CONTROL_RECONSTRUCTION_ORDER_INDEPENDENT,
    CONTROL_ORDERING_SOURCE: 'controlEpoch',
    CONTROL_EPOCH_RULE: 'exact_+1 (root RESOLVE_CONTROL_CONFLICT may advance conflictEpoch+1 from frozen tip)',
    RELAY_IS_AUTHORITY: false,
    AUDIT_LOG_SEPARATE_FROM_CONTROL_STATE: true,
    CONTROL_STATE_SERVER_CONSUMABLE: true,
    INITIAL_GROUP_DISPLAY_NAME_SOURCE: 'App.COMMUNITY_CONTEXT (yalacommunity), distinct from NETWORK_TAG groupId',
    parseAndValidateRecord,
    serializeRecord,
    buildBootstrapRecord,
    buildSignDraft,
    signControlRecord,
    acceptControlEvent,
    ingestControlEvents,
    reconstructControlState,
    clearVerified,
    revalidateFromCache,
    getVerifiedControlState,
    getControlEpoch,
    getInvitePolicy,
    getCapabilities,
    isBlocked,
    getGroupSettings,
    getStatus,
    getConflictCandidates,
    mutationsBlockedByConflict,
    legacyRootPubkey,
    resolveGroupId,
    normalizePubkey,
  };

  Object.freeze(api);
  App.GroupControlState = api;
  window.SosGroupControlState = api;
})(typeof window !== 'undefined' ? window : globalThis);
