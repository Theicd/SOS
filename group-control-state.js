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
  let storeStatus = 'MISSING'; // MISSING | VERIFIED | INVALID | STALE | CONFLICT | WRONG_GROUP | BAD_ISSUER

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

    // Epoch: prefer exact +1; allow any strictly greater only if documented — AC2 chooses exact +1
    if (next.controlEpoch !== prev.controlEpoch + 1) {
      throw Object.assign(new Error('BAD_EPOCH_STEP'), { code: 'BAD_EPOCH_STEP' });
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

  function persistCache(event) {
    try {
      window.localStorage.setItem(cacheKey(resolveGroupId()), JSON.stringify(event));
    } catch (_e) {}
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

  /**
   * Accept a signed GROUP_CONTROL event. Fail closed.
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

      // d-tag binding (parameterized-replaceable stream key = groupId)
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
      const prev = verified && verified.record ? verified.record : null;

      if (prev) {
        if (record.controlEpoch < prev.controlEpoch) {
          setStatus('STALE');
          return { ok: false, status: 'STALE', code: 'STALE_EPOCH' };
        }
        if (record.controlEpoch === prev.controlEpoch) {
          if (verified.event && verified.event.id === event.id) {
            return { ok: true, status: 'VERIFIED', record: prev, event: verified.event };
          }
          // Same epoch different content → conflict, fail closed; keep prior verified authority.
          return { ok: false, status: 'CONFLICT', code: 'SAME_EPOCH_CONFLICT' };
        }
        if (record.controlEpoch > prev.controlEpoch + 1 && !opts.allowEpochSkip) {
          // AC2 rule: prefer exact +1
          setStatus('INVALID');
          return { ok: false, status: 'INVALID', code: 'BAD_EPOCH_STEP' };
        }
      }

      authorizeTransition(prev, record, issuer);

      // Do not allow new state to invent issuer authority that wasn't in previous (already checked)
      verified = {
        event: Object.freeze({
          id: event.id,
          pubkey: issuer,
          created_at: event.created_at,
          kind: event.kind,
          tags: JSON.parse(JSON.stringify(event.tags)),
          content: event.content,
          sig: event.sig,
        }),
        record,
        status: 'VERIFIED',
      };
      setStatus('VERIFIED');
      if (opts.persist !== false) persistCache(verified.event);
      return { ok: true, status: 'VERIFIED', record, event: verified.event };
    } catch (e) {
      const code = (e && e.code) || 'REJECTED';
      if (code === 'BAD_ISSUER' || code === 'ROOT_MISMATCH') setStatus('BAD_ISSUER');
      else if (code === 'STALE_EPOCH') setStatus('STALE');
      else if (code === 'SAME_EPOCH_CONFLICT') setStatus('CONFLICT');
      else if (code === 'CROSS_GROUP' || code === 'GROUP_CHANGED') setStatus('WRONG_GROUP');
      else setStatus('INVALID');
      return { ok: false, status: storeStatus, code };
    }
  }

  function clearVerified() {
    verified = null;
    setStatus('MISSING');
  }

  function revalidateFromCache() {
    const cached = loadCacheRaw();
    if (!cached) {
      clearVerified();
      return { ok: false, status: 'MISSING', code: 'NO_CACHE' };
    }
    // Cache is not authority — must fully re-accept
    clearVerified();
    const result = acceptControlEvent(cached, { persist: false });
    if (!result.ok) {
      try {
        window.localStorage.removeItem(cacheKey(resolveGroupId()));
      } catch (_e) {}
    } else if (result.ok) {
      persistCache(result.event);
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
    CONTROL_ORDERING_SOURCE: 'controlEpoch',
    CONTROL_EPOCH_RULE: 'exact_+1',
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
    clearVerified,
    revalidateFromCache,
    getVerifiedControlState,
    getControlEpoch,
    getInvitePolicy,
    getCapabilities,
    isBlocked,
    getGroupSettings,
    getStatus,
    legacyRootPubkey,
    resolveGroupId,
    normalizePubkey,
  };

  Object.freeze(api);
  App.GroupControlState = api;
  window.SosGroupControlState = api;
})(typeof window !== 'undefined' ? window : globalThis);
