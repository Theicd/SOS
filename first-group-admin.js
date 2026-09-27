/**
 * Package 897 — First group (sos010 / israel-network) admin gateway.
 * Authority = verified signed control chain (39001) + signed membership (39003) only.
 * UI flags, DOM, AccessControl QA overlays and App.isAdmin are never authority.
 * Every privileged op: V2 → identity → session → first-group context → shared-cache sync → signed authority
 * → existing typed mutation/member pipelines (final acceptance re-verifies the signed transition).
 */
(function initFirstGroupAdmin(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const FIRST_GROUP = Object.freeze({
    communityId: 'sos010',
    groupId: 'israel-network',
    networkTag: 'israel-network',
  });

  const FIRST_GROUP_SOURCE = 'CommunityContext.SOS010 (config.js NETWORK_TAG israel-network)';
  const FIRST_GROUP_AUTHORITY_MODEL =
    'Signed kind-39001 control chain for groupId israel-network; epoch-1 root must be a configured ' +
    'adminSourceKeys pubkey; delegated capabilities live only in the signed capabilities map and are ' +
    'effective only while signed kind-39003 membership is ACTIVE and the pubkey is not blocklisted.';

  const CAP_LABELS = Object.freeze({
    MANAGE_ADMINS: 'ניהול מנהלים',
    MANAGE_PERMISSIONS: 'ניהול הרשאות',
    MANAGE_GROUP_SETTINGS: 'עריכת פרטי הקבוצה והגדרות',
    MODERATE_CONTENT: 'פיקוח תוכן',
    INVITE_USERS: 'הזמנת חברים',
    MANAGE_INVITES: 'ניהול הזמנות',
    MANAGE_MEMBERS: 'ניהול חברים',
    MANAGE_BLOCKLIST: 'חסימת חברים',
    VIEW_AUDIT_LOG: 'צפייה בפעילות ניהולית',
  });

  const ROLES = Object.freeze([
    { id: 'ROOT', label: 'מנהל ראשי', preset: null },
    { id: 'SENIOR_ADMIN', label: 'מנהל בכיר', preset: ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS'] },
    { id: 'ADMIN', label: 'מנהל', preset: ['MANAGE_MEMBERS'] },
    { id: 'MODERATOR', label: 'מפקח תוכן', preset: ['MODERATE_CONTENT'] },
    { id: 'INVITER', label: 'מזמין', preset: ['INVITE_USERS'] },
    { id: 'DELEGATE', label: 'בעל הרשאות', preset: null },
    { id: 'MEMBER', label: 'חבר', preset: null },
  ]);

  const ADMIN_TIER_CAPS = Object.freeze([
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'MANAGE_GROUP_SETTINGS',
    'MANAGE_INVITES',
    'VIEW_AUDIT_LOG',
  ]);

  const LAST_OWNER_POLICY =
    'ROOT_IMMUTABLE: the configured root cannot be granted, revoked, demoted, blocked or removed ' +
    '(ROOT_IMMUTABLE / ROOT_PROTECTED / ROOT_TARGET_FORBIDDEN), so the first group can never be left ' +
    'without an owner through admin actions. Root key loss/rotation is out of scope for this phase.';

  const DOUBLE_REDEEM_SCOPE = 'LOCAL_ONLY';
  const E2E_SCOPE = 'LOCAL_CONTROLLED_E2E';

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function MUT() {
    return App.GroupControlMutations || window.SosGroupControlMutations || null;
  }
  function MAO() {
    return App.MemberAdminOperations || window.SosMemberAdminOperations || null;
  }
  function CC() {
    return App.CommunityContext || window.SosCommunityContext || null;
  }
  function SA() {
    return App.SessionAuthority || window.SosSessionAuthority || null;
  }
  function IP() {
    return App.InvitePolicy || window.SosInvitePolicy || null;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function actor() {
    return normalizePubkey(App.publicKey);
  }

  function mapCaps() {
    const g = GCS();
    return ((g && g.MAP_CAPABILITIES) || Object.keys(CAP_LABELS)).slice();
  }

  function delegableCaps() {
    const g = GCS();
    return ((g && g.DELEGABLE_BY_PERMISSION_MANAGER) || []).slice();
  }

  // ---------------------------------------------------------------- context

  function contextCheck(explicitGroupId) {
    if (explicitGroupId != null && explicitGroupId !== FIRST_GROUP.groupId) {
      return { ok: false, code: 'FIRST_GROUP_CONTEXT_MISMATCH' };
    }
    const cc = CC();
    const snap = cc && typeof cc.snapshot === 'function' ? cc.snapshot() : null;
    const tag = (snap && snap.networkTag) || App.NETWORK_TAG || '';
    if (tag !== FIRST_GROUP.networkTag) return { ok: false, code: 'FIRST_GROUP_CONTEXT_MISMATCH', active: tag };
    return { ok: true, groupId: FIRST_GROUP.groupId };
  }

  function sync() {
    const g = GCS();
    const m = MS();
    let control = null;
    let membership = null;
    try {
      if (g && typeof g.syncFromSharedCache === 'function') control = g.syncFromSharedCache(FIRST_GROUP.groupId);
    } catch (_e) {}
    try {
      if (m && typeof m.syncFromSharedCache === 'function') membership = m.syncFromSharedCache(FIRST_GROUP.groupId);
    } catch (_e2) {}
    return { control, membership };
  }

  // ---------------------------------------------------------------- signed authority

  function verifiedControl() {
    const g = GCS();
    if (!g || !isV2()) return null;
    if (typeof g.getStatus === 'function' && g.getStatus(FIRST_GROUP.groupId) !== 'VERIFIED') return null;
    const st = g.getVerifiedControlState(FIRST_GROUP.groupId);
    if (!st || st.verified !== true || st.groupId !== FIRST_GROUP.groupId) return null;
    return st;
  }

  function memberStatus(pk) {
    const m = MS();
    if (!m || typeof m.getMemberState !== 'function') return 'UNKNOWN';
    try {
      return m.getMemberState(pk, FIRST_GROUP.groupId);
    } catch (_e) {
      return 'UNKNOWN';
    }
  }

  function deriveRole(isRoot, caps) {
    if (isRoot) return 'ROOT';
    if (caps.indexOf('MANAGE_ADMINS') !== -1 || caps.indexOf('MANAGE_PERMISSIONS') !== -1) return 'SENIOR_ADMIN';
    if (caps.indexOf('MANAGE_MEMBERS') !== -1) return 'ADMIN';
    if (caps.indexOf('MODERATE_CONTENT') !== -1) return 'MODERATOR';
    if (caps.indexOf('INVITE_USERS') !== -1 && caps.length === 1) return 'INVITER';
    if (caps.length) return 'DELEGATE';
    return 'MEMBER';
  }

  function roleLabel(roleId) {
    const r = ROLES.find((x) => x.id === roleId);
    return r ? r.label : roleId;
  }

  /** Effective authority from signed state only (no AccessControl overlay). */
  function authorityFor(pubkey) {
    const pk = normalizePubkey(pubkey);
    const st = verifiedControl();
    const base = {
      pubkey: pk,
      verified: !!st,
      isRoot: false,
      assigned: [],
      caps: [],
      membership: pk ? memberStatus(pk) : 'UNKNOWN',
      blocked: false,
      role: 'MEMBER',
      controlEpoch: st ? st.controlEpoch : null,
    };
    if (!pk || !st) return base;
    const root = normalizePubkey(st.rootAdminPubkey);
    if (pk === root) {
      base.isRoot = true;
      base.caps = mapCaps();
      base.role = 'ROOT';
      base.membership = base.membership === 'UNKNOWN' ? 'ROOT' : base.membership;
      return base;
    }
    base.assigned = ((st.capabilities && st.capabilities[pk]) || []).slice().sort();
    base.blocked = Array.isArray(st.blockedPubkeys) && st.blockedPubkeys.indexOf(pk) !== -1;
    const activeOk = base.membership === 'ACTIVE' && !base.blocked;
    base.caps = activeOk ? base.assigned.slice() : [];
    base.role = deriveRole(false, base.caps);
    return base;
  }

  function myAuthority() {
    return authorityFor(actor());
  }

  function has(auth, cap) {
    return !!auth && (auth.isRoot || auth.caps.indexOf(cap) !== -1);
  }

  function hasAny(auth, caps) {
    return (caps || []).some((c) => has(auth, c));
  }

  /** Which dashboard sections the current principal may use. */
  function visibleSections(authIn) {
    const a = authIn || myAuthority();
    const managePerms = hasAny(a, ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    return {
      details: hasAny(a, ['MANAGE_GROUP_SETTINGS', 'MANAGE_ADMINS', 'MANAGE_PERMISSIONS', 'MANAGE_MEMBERS', 'VIEW_AUDIT_LOG']),
      editDetails: has(a, 'MANAGE_GROUP_SETTINGS'),
      members: hasAny(a, ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST', 'MANAGE_ADMINS', 'MANAGE_PERMISSIONS', 'VIEW_AUDIT_LOG']),
      removeMembers: has(a, 'MANAGE_MEMBERS'),
      admins: managePerms || has(a, 'VIEW_AUDIT_LOG'),
      manageAdmins: managePerms,
      roles: managePerms,
      invites: hasAny(a, ['INVITE_USERS', 'MANAGE_INVITES']),
      createInvite: inviteCreateAllowed(a),
      revokeInvites: hasAny(a, ['INVITE_USERS', 'MANAGE_INVITES']),
      qr: inviteCreateAllowed(a),
      settings: has(a, 'MANAGE_INVITES') || a.isRoot,
      security: has(a, 'VIEW_AUDIT_LOG'),
      moderation: has(a, 'MODERATE_CONTENT'),
    };
  }

  function inviteCreateAllowed(a) {
    const P = IP();
    const st = verifiedControl();
    if (!P || !st || !a || !a.pubkey) return false;
    if (!a.isRoot && (a.membership !== 'ACTIVE' || a.blocked)) return false;
    try {
      return P.canCreateInvite(a.pubkey, st, {}).ok === true;
    } catch (_e) {
      return false;
    }
  }

  function canSeeAdminMenu() {
    if (!isV2() || App.guestMode === true) return false;
    if (!contextCheck().ok) return false;
    const a = myAuthority();
    return a.verified && (a.isRoot || a.caps.length > 0);
  }

  function isConfiguredRoot(pk) {
    const g = GCS();
    const roots = g && typeof g.configuredRootPubkeys === 'function' ? g.configuredRootPubkeys() : [];
    return roots.indexOf(normalizePubkey(pk)) !== -1;
  }

  // ---------------------------------------------------------------- gateway

  function guard(opName, anyOfCaps, explicitGroupId) {
    if (!isV2()) return { ok: false, code: 'V2_REQUIRED' };
    const me = actor();
    if (!me || App.guestMode === true) return { ok: false, code: 'NO_IDENTITY' };
    const sa = SA();
    if (sa && typeof sa.checkSessionForSensitiveOp === 'function') {
      const s = sa.checkSessionForSensitiveOp('FIRST_GROUP_ADMIN:' + opName);
      if (!s || s.ok !== true) return { ok: false, code: (s && s.code) || 'SESSION_REVOKED' };
      if (s.account && normalizePubkey(s.account) && normalizePubkey(s.account) !== me) {
        return { ok: false, code: 'SESSION_ACCOUNT_MISMATCH' };
      }
    } else {
      return { ok: false, code: 'NO_SESSION_AUTHORITY' };
    }
    const ctx = contextCheck(explicitGroupId);
    if (!ctx.ok) return ctx;
    sync();
    const g = GCS();
    if (g && typeof g.mutationsBlockedByConflict === 'function') {
      g.getStatus(FIRST_GROUP.groupId);
      if (g.mutationsBlockedByConflict()) return { ok: false, code: 'CONTROL_CONFLICT' };
    }
    const auth = authorityFor(me);
    if (!auth.verified) return { ok: false, code: 'NO_VERIFIED_CONTROL' };
    if (anyOfCaps && anyOfCaps.length && !hasAny(auth, anyOfCaps)) {
      return { ok: false, code: 'UNAUTHORIZED', role: auth.role };
    }
    return { ok: true, actor: me, auth };
  }

  function done(res) {
    notifyChanged('local');
    return res;
  }

  function fail(code, extra) {
    return Object.assign({ ok: false, code }, extra || {});
  }

  async function mutate(mutation, opts) {
    const m = MUT();
    if (!m) return fail('NO_MUTATIONS');
    const res = await m.applyControlMutation(
      Object.assign({ groupId: FIRST_GROUP.groupId }, mutation),
      actor(),
      opts || {}
    );
    return res && res.ok ? done(res) : res || fail('MUTATION_FAILED');
  }

  async function bootstrapFirstGroup(opts) {
    if (!isV2()) return fail('V2_REQUIRED');
    const me = actor();
    if (!me || App.guestMode === true) return fail('NO_IDENTITY');
    const sa = SA();
    const s = sa && sa.checkSessionForSensitiveOp ? sa.checkSessionForSensitiveOp('FIRST_GROUP_ADMIN:BOOTSTRAP') : null;
    if (!s || s.ok !== true) return fail((s && s.code) || 'SESSION_REVOKED');
    const ctx = contextCheck();
    if (!ctx.ok) return ctx;
    sync();
    if (verifiedControl()) return fail('ALREADY_BOOTSTRAPPED');
    if (!isConfiguredRoot(me)) return fail('FIRST_GROUP_ROOT_NOT_CONFIGURED');
    const g = GCS();
    const o = opts || {};
    try {
      const record = g.buildBootstrapRecord({
        groupId: FIRST_GROUP.groupId,
        rootAdminPubkey: me,
        creatorPubkey: me,
        displayName: String(o.displayName || 'SOS'),
        invitePolicy: o.invitePolicy || 'AUTHORIZED_USERS_ONLY',
      });
      const ev = await g.signControlRecord(record);
      if (!o.skipPublish && App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length) {
        try {
          await App.pool.publish(App.relayUrls, ev);
        } catch (_p) {}
      }
      const acc = g.acceptControlEvent(ev, { groupId: FIRST_GROUP.groupId, persist: true });
      if (!acc.ok) return fail(acc.code || 'BOOTSTRAP_REJECTED', { accept: acc });
      let member = { ok: false, code: 'SKIPPED' };
      try {
        const S = App.SosCryptoSigner;
        const m = MS();
        if (S && typeof S.signTypedAdminOperation === 'function' && m) {
          const memEv = await S.signTypedAdminOperation({
            version: 1,
            operation: 'BOOTSTRAP_MEMBER_ACTIVE',
            groupId: FIRST_GROUP.groupId,
            baseEvent: g.getVerifiedControlEvent(FIRST_GROUP.groupId),
            targetPubkey: me,
          });
          if (!o.skipPublish && App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length) {
            try {
              await App.pool.publish(App.relayUrls, memEv);
            } catch (_p2) {}
          }
          const macc = m.acceptMembershipEvent(memEv, verifiedControl(), { groupId: FIRST_GROUP.groupId });
          member = { ok: !!(macc && macc.ok), code: macc && macc.code };
        }
      } catch (e2) {
        member = { ok: false, code: (e2 && e2.code) || 'ROOT_MEMBERSHIP_FAILED' };
      }
      return done({ ok: true, code: 'BOOTSTRAPPED', event: ev, rootMembership: member });
    } catch (e) {
      return fail((e && e.code) || 'BOOTSTRAP_FAILED', { error: e && e.message });
    }
  }

  async function updateMetadata(fields, opts) {
    const g = guard('SET_GROUP_METADATA', ['MANAGE_GROUP_SETTINGS']);
    if (!g.ok) return g;
    const f = fields || {};
    const mutation = { type: 'SET_GROUP_METADATA' };
    if (f.displayName != null) mutation.displayName = String(f.displayName);
    if (f.description != null) mutation.description = String(f.description);
    if (f.logoRef != null) mutation.logoRef = String(f.logoRef);
    if (mutation.displayName == null && mutation.description == null && mutation.logoRef == null) {
      return fail('NO_CHANGES');
    }
    return mutate(mutation, opts);
  }

  function grantableCapsFor(auth, target) {
    if (!auth) return [];
    if (auth.isRoot) return mapCaps();
    if (!hasAny(auth, ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS'])) return [];
    if (normalizePubkey(target) === auth.pubkey) return [];
    return delegableCaps();
  }

  async function grantCapability(targetPubkey, capability, opts) {
    const g = guard('GRANT_CAPABILITY', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    if (!g.ok) return g;
    const target = normalizePubkey(targetPubkey);
    if (!target) return fail('BAD_PUBKEY');
    if (target === g.actor && !g.auth.isRoot) return fail('SELF_GRANT_FORBIDDEN');
    if (grantableCapsFor(g.auth, target).indexOf(capability) === -1) return fail('DELEGATION_ESCALATION');
    if (memberStatus(target) !== 'ACTIVE') return fail('TARGET_NOT_ACTIVE_MEMBER');
    return mutate({ type: 'GRANT_CAPABILITY', targetPubkey: target, capability }, opts);
  }

  async function revokeCapability(targetPubkey, capability, opts) {
    const g = guard('REVOKE_CAPABILITY', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    if (!g.ok) return g;
    const target = normalizePubkey(targetPubkey);
    if (!target) return fail('BAD_PUBKEY');
    if (grantableCapsFor(g.auth, target).indexOf(capability) === -1 && !(g.auth.isRoot)) {
      return fail('DELEGATION_ESCALATION');
    }
    return mutate({ type: 'REVOKE_CAPABILITY', targetPubkey: target, capability }, opts);
  }

  /** שמירת הרשאות: apply the diff between current signed caps and desired set (one signed epoch per change). */
  async function setPermissions(targetPubkey, desiredCaps, opts) {
    const g = guard('SET_PERMISSIONS', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    if (!g.ok) return g;
    const target = normalizePubkey(targetPubkey);
    if (!target) return fail('BAD_PUBKEY');
    const current = authorityFor(target).assigned;
    const want = Array.from(new Set((desiredCaps || []).filter((c) => mapCaps().indexOf(c) !== -1)));
    const toGrant = want.filter((c) => current.indexOf(c) === -1);
    const toRevoke = current.filter((c) => want.indexOf(c) === -1);
    const allowed = grantableCapsFor(g.auth, target);
    const bad = toGrant.concat(toRevoke).filter((c) => allowed.indexOf(c) === -1);
    if (bad.length) return fail(target === g.actor ? 'SELF_GRANT_FORBIDDEN' : 'DELEGATION_ESCALATION', { caps: bad });
    const steps = [];
    for (const c of toRevoke) {
      const r = await revokeCapability(target, c, opts);
      steps.push({ op: 'REVOKE', cap: c, ok: !!r.ok, code: r.code });
      if (!r.ok) return fail(r.code || 'REVOKE_FAILED', { steps });
    }
    for (const c of toGrant) {
      const r = await grantCapability(target, c, opts);
      steps.push({ op: 'GRANT', cap: c, ok: !!r.ok, code: r.code });
      if (!r.ok) return fail(r.code || 'GRANT_FAILED', { steps });
    }
    return { ok: true, code: steps.length ? 'SAVED' : 'NO_CHANGES', steps };
  }

  async function assignRole(targetPubkey, roleId, opts) {
    const role = ROLES.find((r) => r.id === roleId);
    if (!role || !role.preset) return fail('BAD_ROLE');
    const current = authorityFor(targetPubkey).assigned;
    return setPermissions(targetPubkey, Array.from(new Set(current.concat(role.preset))), opts);
  }

  async function removeRole(targetPubkey, roleId, opts) {
    const role = ROLES.find((r) => r.id === roleId);
    if (!role || !role.preset) return fail('BAD_ROLE');
    const current = authorityFor(targetPubkey).assigned;
    return setPermissions(
      targetPubkey,
      current.filter((c) => role.preset.indexOf(c) === -1),
      opts
    );
  }

  /** הוספת מנהל = grant MANAGE_MEMBERS (requires MANAGE_ADMINS/MANAGE_PERMISSIONS or root). */
  async function promoteAdmin(targetPubkey, opts) {
    return assignRole(targetPubkey, 'ADMIN', opts);
  }

  /** הסרת מנהל = revoke every admin-tier capability the actor may revoke. */
  async function demoteAdmin(targetPubkey, opts) {
    const g = guard('DEMOTE_ADMIN', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    if (!g.ok) return g;
    const target = normalizePubkey(targetPubkey);
    const st = verifiedControl();
    if (st && target === normalizePubkey(st.rootAdminPubkey)) return fail('ROOT_IMMUTABLE');
    const current = authorityFor(target).assigned;
    return setPermissions(
      target,
      current.filter((c) => ADMIN_TIER_CAPS.indexOf(c) === -1),
      opts
    );
  }

  async function removeMember(targetPubkey, opts) {
    const g = guard('REMOVE_MEMBER', ['MANAGE_MEMBERS']);
    if (!g.ok) return g;
    const mao = MAO();
    if (!mao) return fail('NO_MEMBER_OPS');
    const res = await mao.removeMember(normalizePubkey(targetPubkey), g.actor, opts || {});
    return res && res.ok ? done(res) : res || fail('REMOVE_FAILED');
  }

  async function approveJoin(memberPubkey, inviteEventId, opts) {
    const g = guard('GRANT_MEMBER_ACTIVE', ['MANAGE_MEMBERS']);
    if (!g.ok) return g;
    const mao = MAO();
    if (!mao) return fail('NO_MEMBER_OPS');
    const res = await mao.grantMemberActiveFromInvite(normalizePubkey(memberPubkey), inviteEventId, g.actor, opts || {});
    return res && res.ok ? done(res) : res || fail('GRANT_FAILED');
  }

  async function setInvitePolicy(policy, opts) {
    const g = guard('SET_INVITE_POLICY', ['MANAGE_INVITES']);
    if (!g.ok) return g;
    return mutate({ type: 'SET_INVITE_POLICY', invitePolicy: policy }, opts);
  }

  // ---------------------------------------------------------------- invites / QR

  const myInvites = [];

  async function createInvite() {
    const g = guard('CREATE_INVITE', null);
    if (!g.ok) return g;
    if (!inviteCreateAllowed(g.auth)) return fail('UNAUTHORIZED');
    if (typeof App.createInvite !== 'function') return fail('NO_CREATE_INVITE');
    try {
      const inv = await App.createInvite();
      const row = {
        owner: g.actor,
        code: inv.code,
        inviteUrl: inv.inviteUrl,
        event: inv.event,
        eventId: inv.event && inv.event.id,
        createdAt: Date.now(),
        status: 'ACTIVE',
      };
      myInvites.unshift(row);
      return done({ ok: true, code: 'CREATED', invite: row });
    } catch (e) {
      return fail('CREATE_INVITE_FAILED', { error: String((e && e.message) || e) });
    }
  }

  async function revokeInvite(row) {
    const g = guard('REVOKE_INVITE', null);
    if (!g.ok) return g;
    const P = IP();
    const st = verifiedControl();
    if (row && !row.event && row.eventId) {
      const own = myInvites.find((r) => r.eventId === row.eventId && r.owner === g.actor);
      if (own) row = own;
    }
    if (!P || !st || !row || !row.event) return fail('BAD_INVITE');
    const auth = P.canRevokeInvite(g.actor, row.event, st);
    if (!auth.ok) return fail('UNAUTHORIZED');
    try {
      const res = await App.revokeInvite({ inviteEvent: row.event });
      row.status = 'REVOKED';
      myInvites.forEach((r) => {
        if (r.eventId === row.eventId) r.status = 'REVOKED';
      });
      return done({ ok: true, code: 'REVOKED', event: res && res.event });
    } catch (e) {
      return fail('REVOKE_FAILED', { error: String((e && e.message) || e) });
    }
  }

  function readTag(ev, name) {
    const row = ev && Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null) : null;
    return row ? String(row[1]) : '';
  }

  async function queryRelays(filter) {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) return [];
    if (typeof App.pool.querySync === 'function') {
      const r = await App.pool.querySync(App.relayUrls, filter);
      return Array.isArray(r) ? r : [];
    }
    return [];
  }

  /** Redeemed invites (37379) for this group whose redeemer is not yet an ACTIVE member; each verified against its invite. */
  async function listPendingJoins() {
    const g = guard('LIST_PENDING_JOINS', ['MANAGE_MEMBERS']);
    if (!g.ok) return g;
    const P = IP();
    const st = verifiedControl();
    if (!P || !st) return fail('NO_VERIFIED_CONTROL');
    let used = [];
    try {
      used = await queryRelays({ kinds: [App.INVITE_USED_KIND || 37379], '#t': [FIRST_GROUP.networkTag], limit: 100 });
    } catch (_e) {
      return fail('RELAY_QUERY_FAILED');
    }
    const ids = Array.from(new Set(used.map((u) => readTag(u, 'e').toLowerCase()).filter(Boolean)));
    let invites = [];
    if (ids.length) {
      try {
        invites = await queryRelays({ kinds: [App.INVITE_KIND || 37378], ids, limit: ids.length });
      } catch (_e2) {
        invites = [];
      }
    }
    const byId = new Map(invites.map((ev) => [String(ev.id).toLowerCase(), ev]));
    const out = [];
    const seen = new Set();
    used.forEach((u) => {
      const inv = byId.get(readTag(u, 'e').toLowerCase());
      const redeemer = normalizePubkey(u.pubkey);
      if (!inv || !redeemer || seen.has(redeemer)) return;
      const iv = P.validateInviteEvent(inv, st, {});
      const uv = P.validateUsedEvent(u, inv, readTag(inv, 'ih'));
      if (!iv.ok || !uv.ok) return;
      if (memberStatus(redeemer) === 'ACTIVE' || redeemer === normalizePubkey(st.rootAdminPubkey)) return;
      seen.add(redeemer);
      out.push({ memberPubkey: redeemer, inviteEventId: String(inv.id).toLowerCase(), inviterPubkey: normalizePubkey(inv.pubkey), status: memberStatus(redeemer) });
    });
    return { ok: true, rows: out };
  }

  function listMyInvites() {
    const me = actor();
    for (let i = myInvites.length - 1; i >= 0; i--) {
      if (myInvites[i].owner !== me) myInvites.splice(i, 1);
    }
    return myInvites.map((r) => ({ code: r.code, inviteUrl: r.inviteUrl, eventId: r.eventId, status: r.status, event: r.event }));
  }

  const SECRET_PATTERNS = [
    /nsec1[02-9ac-hj-np-z]{20,}/i,
    /\b[0-9a-f]{64}\b/i,
    /priv|secret|seed|mnemonic|conversation.?key|file.?key|rootk/i,
  ];

  function qrPayloadForInvite(inviteUrl) {
    const u = String(inviteUrl || '');
    if (!u) return fail('NO_INVITE_URL');
    if (SECRET_PATTERNS.some((re) => re.test(u))) return fail('QR_PAYLOAD_SECRET_REJECTED');
    const parsed = parseInviteQr(u);
    if (!parsed.ok) return parsed;
    return { ok: true, payload: u, code: parsed.code };
  }

  function allowedInviteOrigins() {
    const out = ['https://sos010.com', 'https://www.sos010.com'];
    try {
      if (window.location && window.location.origin) out.push(window.location.origin);
    } catch (_e) {}
    return out;
  }

  /** Strict QR/link parser: only canonical invite links (or a bare code) for this app, no secrets. */
  function parseInviteQr(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 512) return fail('QR_EMPTY_OR_TOO_LONG');
    if (SECRET_PATTERNS.some((re) => re.test(raw))) return fail('QR_CONTAINS_SECRET_PATTERN');
    if (/^[A-Z0-9]{6,16}$/i.test(raw)) return { ok: true, code: raw.toUpperCase(), kind: 'CODE' };
    let u;
    try {
      u = new URL(raw);
    } catch (_e) {
      return fail('QR_NOT_INVITE');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('QR_BAD_SCHEME');
    if (allowedInviteOrigins().indexOf(u.origin) === -1) return fail('QR_FOREIGN_ORIGIN');
    if (!/\/videos\.html$/.test(u.pathname) && u.pathname !== '/') return fail('QR_BAD_PATH');
    const keys = Array.from(u.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== 'invite') return fail('QR_UNEXPECTED_PARAMS');
    if (u.hash) return fail('QR_UNEXPECTED_FRAGMENT');
    const code = String(u.searchParams.get('invite') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,16}$/.test(code)) return fail('QR_BAD_CODE');
    return { ok: true, code, kind: 'URL' };
  }

  async function renderInviteQr(canvas, inviteUrl) {
    const p = qrPayloadForInvite(inviteUrl);
    if (!p.ok) return p;
    const QR = window.QRCode;
    if (!QR || typeof QR.toCanvas !== 'function') return fail('QR_LIB_MISSING');
    await QR.toCanvas(canvas, p.payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
      color: { dark: '#000000', light: '#ffffff' },
    });
    return { ok: true, payload: p.payload, code: p.code };
  }

  // ---------------------------------------------------------------- directory / audit

  function directory(query) {
    const mao = MAO();
    if (!mao || !isV2()) return [];
    sync();
    const q = String(query || '').trim().toLowerCase();
    const rows = mao.buildDirectoryRows('ALL').map((r) => {
      const a = authorityFor(r.memberPubkey);
      return {
        pubkey: r.memberPubkey,
        displayName: r.displayName || '',
        avatar: r.avatar || '',
        status: a.isRoot ? 'ACTIVE' : r.status,
        isRoot: a.isRoot,
        assigned: a.assigned,
        caps: a.caps,
        role: a.role,
        roleLabel: roleLabel(a.role),
      };
    });
    if (!q) return rows;
    return rows.filter(
      (r) => r.pubkey.indexOf(q) !== -1 || String(r.displayName || '').toLowerCase().indexOf(q) !== -1
    );
  }

  function admins() {
    return directory('').filter((r) => r.isRoot || r.caps.some((c) => ADMIN_TIER_CAPS.indexOf(c) !== -1));
  }

  function diffCaps(prev, next) {
    const out = [];
    const all = new Set(Object.keys(prev || {}).concat(Object.keys(next || {})));
    all.forEach((pk) => {
      const b = new Set((prev && prev[pk]) || []);
      const a = new Set((next && next[pk]) || []);
      a.forEach((c) => {
        if (!b.has(c)) out.push({ action: 'GRANT_CAPABILITY', target: pk, detail: c });
      });
      b.forEach((c) => {
        if (!a.has(c)) out.push({ action: 'REVOKE_CAPABILITY', target: pk, detail: c });
      });
    });
    return out;
  }

  /** FIRST_GROUP_ADMIN_AUDIT_MODEL: verified signed control chain + signed membership events. */
  function auditLog() {
    const g = GCS();
    const m = MS();
    const rows = [];
    const chain = g && typeof g.getVerifiedControlChain === 'function' ? g.getVerifiedControlChain(FIRST_GROUP.groupId) : [];
    for (let i = 0; i < chain.length; i++) {
      const cur = chain[i];
      const prev = i > 0 ? chain[i - 1].record : null;
      const base = { source: 'CONTROL_39001', epoch: cur.controlEpoch, actor: cur.issuerPubkey, createdAt: cur.createdAt, eventId: cur.eventId };
      if (!prev) {
        rows.push(Object.assign({ action: 'BOOTSTRAP', target: cur.record.rootAdminPubkey, detail: '' }, base));
        continue;
      }
      const r = cur.record;
      diffCaps(prev.capabilities, r.capabilities).forEach((d) => rows.push(Object.assign(d, base)));
      if (prev.invitePolicy !== r.invitePolicy) {
        rows.push(Object.assign({ action: 'SET_INVITE_POLICY', target: '', detail: r.invitePolicy }, base));
      }
      const ps = prev.groupSettings || {};
      const ns = r.groupSettings || {};
      ['displayName', 'description', 'logoRef'].forEach((k) => {
        if ((ps[k] || '') !== (ns[k] || '')) {
          rows.push(Object.assign({ action: 'SET_GROUP_METADATA', target: '', detail: k }, base));
        }
      });
      const pb = (prev.blockedPubkeys || []).join(',');
      const nb = (r.blockedPubkeys || []).join(',');
      if (pb !== nb) rows.push(Object.assign({ action: 'BLOCKLIST_CHANGED', target: '', detail: '' }, base));
    }
    const mem = m && typeof m.exportMembershipEvents === 'function' ? m.exportMembershipEvents(FIRST_GROUP.groupId) : [];
    mem.forEach((ev) => {
      let body = {};
      try {
        body = JSON.parse(ev.content || '{}');
      } catch (_e) {}
      rows.push({
        source: 'MEMBERSHIP_39003',
        epoch: body.controlEpochAtIssue != null ? body.controlEpochAtIssue : null,
        actor: normalizePubkey(ev.pubkey),
        createdAt: ev.created_at,
        eventId: ev.id,
        action: 'MEMBER_' + String(body.status || ''),
        target: normalizePubkey(body.memberPubkey),
        detail: String(body.transition || ''),
      });
    });
    rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.epoch || 0) - (b.epoch || 0));
    return rows;
  }

  // ---------------------------------------------------------------- local-controlled transfer

  /** Signed events only (public data): verified control chain + membership events. */
  function exportSignedState() {
    const g = GCS();
    const m = MS();
    const control = [];
    if (g && typeof g.syncFromSharedCache === 'function') g.syncFromSharedCache(FIRST_GROUP.groupId);
    try {
      const raw = window.localStorage.getItem('sos_group_control_v1_' + FIRST_GROUP.groupId);
      const parsed = raw ? JSON.parse(raw) : null;
      (parsed && Array.isArray(parsed.rows) ? parsed.rows : []).forEach((r) => {
        if (r && r.event) control.push(r.event);
      });
    } catch (_e) {}
    const membership = m && typeof m.exportMembershipEvents === 'function' ? m.exportMembershipEvents(FIRST_GROUP.groupId) : [];
    return { schema: 'sos-first-group-signed-state', version: 1, groupId: FIRST_GROUP.groupId, control, membership };
  }

  /** Every event is strictly re-verified and re-authorized by the canonical stores; nothing is trusted. */
  function importSignedState(bundle) {
    const g = GCS();
    const m = MS();
    if (!bundle || bundle.groupId !== FIRST_GROUP.groupId) return fail('FIRST_GROUP_CONTEXT_MISMATCH');
    const control = Array.isArray(bundle.control) ? bundle.control : [];
    const membership = Array.isArray(bundle.membership) ? bundle.membership : [];
    let c = [];
    let mm = [];
    if (g && control.length) c = g.ingestControlEvents(control, { groupId: FIRST_GROUP.groupId });
    if (m && membership.length) {
      if (m.bindMembershipStore) m.bindMembershipStore(FIRST_GROUP.groupId);
      mm = m.ingestMembershipEvents(membership, verifiedControl());
    }
    notifyChanged('import');
    return {
      ok: true,
      status: g ? g.getStatus(FIRST_GROUP.groupId) : 'NONE',
      control: c.filter((o) => o.ok).length,
      membership: mm.filter((o) => o.ok).length,
    };
  }

  // ---------------------------------------------------------------- multi-tab / boot

  function notifyChanged(reason) {
    try {
      window.dispatchEvent(new CustomEvent('sos-first-group-state-changed', { detail: { reason } }));
    } catch (_e) {}
  }

  function onStorage(ev) {
    const k = ev && ev.key;
    if (!k) return;
    if (k.indexOf('sos_group_control_v1_' + FIRST_GROUP.groupId) === 0 || k.indexOf('sos_membership_v2_' + FIRST_GROUP.groupId) === 0) {
      sync();
      notifyChanged('storage');
    }
  }

  let booted = false;
  function boot() {
    if (!isV2()) return;
    if (!booted) {
      booted = true;
      window.addEventListener('storage', onStorage);
      window.addEventListener('sos-identity-ready', () => {
        sync();
        notifyChanged('identity');
      });
    }
    sync();
    notifyChanged('boot');
  }

  const api = Object.freeze({
    FIRST_GROUP,
    FIRST_GROUP_ID: FIRST_GROUP.groupId,
    FIRST_GROUP_SOURCE,
    FIRST_GROUP_AUTHORITY_MODEL,
    NO_AMBIGUOUS_ADMIN_GROUP_CONTEXT: true,
    LAST_OWNER_POLICY,
    DOUBLE_REDEEM_SCOPE,
    E2E_SCOPE,
    FIRST_GROUP_ADMIN_AUDIT_MODEL: 'SIGNED_CONTROL_CHAIN_PLUS_MEMBERSHIP_EVENTS',
    ROLE_MODEL: 'PRESENTATION_OVER_CANONICAL_CAPABILITIES',
    CAP_LABELS,
    ROLES,
    ADMIN_TIER_CAPS,
    contextCheck,
    sync,
    authorityFor,
    myAuthority,
    visibleSections,
    canSeeAdminMenu,
    isConfiguredRoot,
    grantableCapsFor,
    roleLabel,
    bootstrapFirstGroup,
    updateMetadata,
    grantCapability,
    revokeCapability,
    setPermissions,
    assignRole,
    removeRole,
    promoteAdmin,
    demoteAdmin,
    removeMember,
    approveJoin,
    listPendingJoins,
    setInvitePolicy,
    createInvite,
    revokeInvite,
    listMyInvites,
    parseInviteQr,
    qrPayloadForInvite,
    renderInviteQr,
    directory,
    admins,
    auditLog,
    exportSignedState,
    importSignedState,
    boot,
  });

  App.FirstGroupAdmin = api;
  window.SosFirstGroupAdmin = api;

  window.addEventListener('sos-feature-flags-ready', boot);
  window.addEventListener('sos-access-control-v2-local', boot);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
