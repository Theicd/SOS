/**
 * Package 897 — First group (sos010 / israel-network) admin gateway.
 * Authority = verified signed control chain (39001) + signed membership (39003) only.
 * UI flags, DOM, AccessControl QA overlays and App.isAdmin are never authority.
 * Every privileged op: V2 → identity → session → first-group context → shared-cache sync → network reconcile
 * (FirstGroupNetworkAuthority, fail closed) → signed authority → existing typed mutation/member pipelines
 * (final acceptance re-verifies the signed transition).
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

  const DOUBLE_REDEEM_SCOPE = 'NETWORK_SERIALIZED_AUTHORITY';
  const ADMISSION_CAPS = Object.freeze(['FINALIZE_MEMBERSHIP_ADMISSION', 'FINALIZE_MEMBERSHIP_ADMISSION_RETIRED']);
  /** Production admission service key (public). The ROOT delegates FINALIZE_MEMBERSHIP_ADMISSION to it only. */
  const ADMISSION_SERVICE_PUBKEY = '752f47fa926d1833a451bdc97f3f2967ae4bc6452d0356bc7919c6928e4611ef';
  const E2E_SCOPE = 'NETWORK_BACKED_E2E';

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
  function NA() {
    return App.FirstGroupNetworkAuthority || window.SosFirstGroupNetworkAuthority || null;
  }
  function networkSynced() {
    const n = NA();
    return !!(n && n.isSynced());
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
    return ((g && g.MAP_CAPABILITIES) || Object.keys(CAP_LABELS)).filter((c) => ADMISSION_CAPS.indexOf(c) === -1);
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
    const a = networkSynced() ? authIn || myAuthority() : authorityFor('');
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
    if (!networkSynced()) return false;
    const a = myAuthority();
    return a.verified && (a.isRoot || isGroupAdminTier(a.caps));
  }

  /** Canonical admin-tier set (same list the Admin 2FA server uses). Invite-only helpers are not admins. */
  function isGroupAdminTier(caps) {
    const P = App.Admin2faProtocol;
    return !!P && typeof P.isAdminTier === 'function' && P.isAdminTier(caps) === true;
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

  const PIN_OPS = new Set([
    'SET_GROUP_METADATA',
    'GRANT_CAPABILITY',
    'REVOKE_CAPABILITY',
    'SET_PERMISSIONS',
    'DEMOTE_ADMIN',
    'REMOVE_MEMBER',
    'GRANT_MEMBER_ACTIVE',
    'SET_INVITE_POLICY',
    'CREATE_INVITE',
    'REVOKE_INVITE',
    'SET_ADMISSION_DELEGATE',
    'RETIRE_ADMISSION_DELEGATE',
    'REVOKE_ADMISSION_DELEGATE',
  ]);

  function PIN() {
    return App.AdminPinLock || window.SosAdminPinLock || null;
  }

  /** Admin-tier actors must hold an unlocked PIN session; the PIN adds a lock, never authority. */
  function pinCheck(opName, auth, me) {
    if (!PIN_OPS.has(opName)) return null;
    if (!auth.isRoot && !hasAny(auth, ADMIN_TIER_CAPS)) return null;
    const p = PIN();
    if (!p || typeof p.isUnlocked !== 'function' || p.isUnlocked(me) !== true) return fail('ADMIN_PIN_REQUIRED');
    p.touch();
    return null;
  }

  /** Privileged ops: local checks, then current network state, then the same checks against it. */
  async function nguard(opName, anyOfCaps, explicitGroupId) {
    const pre = guard(opName, anyOfCaps, explicitGroupId);
    if (!pre.ok && pre.code !== 'UNAUTHORIZED' && pre.code !== 'NO_VERIFIED_CONTROL') return pre;
    const n = NA();
    if (!n) return { ok: false, code: 'NETWORK_AUTHORITY_MISSING' };
    const r = await n.reconcile('op:' + opName);
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'NETWORK_AUTHORITY_UNVERIFIED', detail: r && r.detail };
    const g = guard(opName, anyOfCaps, explicitGroupId);
    if (!g.ok) return g;
    return pinCheck(opName, g.auth, g.actor) || g;
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

  function attestPrivileged(event, extra) {
    const C = App.Admin2faClient;
    if (C && typeof C.attest === 'function') return C.attest(event, extra);
    const A = App.Admin2faProtocol;
    return Promise.resolve(A && A.isEnforced() ? fail('ADMIN_2FA_SERVICE_UNAVAILABLE') : { ok: true, skipped: true });
  }

  /** ROOT-signed BOOTSTRAP (binding the configured Admin 2FA signer) plus its verified attestation. Publishes nothing. */
  async function signAttestedBootstrap(me, o) {
    const g = GCS();
    const A = App.Admin2faProtocol;
    const signer = A && typeof A.activeSignerPubkey === 'function' ? A.activeSignerPubkey() : '';
    const record = g.buildBootstrapRecord({
      groupId: FIRST_GROUP.groupId,
      rootAdminPubkey: me,
      creatorPubkey: me,
      displayName: String(o.displayName || 'SOS'),
      invitePolicy: o.invitePolicy || 'AUTHORIZED_USERS_ONLY',
      admin2faSignerPubkey: signer || undefined,
    });
    const event = await g.signControlRecord(record);
    const att = await attestPrivileged(event, { expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'] });
    if (!att.ok) return fail(att.code);
    return { ok: true, event, attestation: att.attestation || null };
  }

  /**
   * Gate 1.5 package: ROOT-signed BOOTSTRAP + server attestation, verified locally. Nothing is published or
   * applied; publishing the package is a separate, owner-approved step.
   */
  async function prepareGate15Package(opts) {
    const me = actor();
    if (!me || App.guestMode === true) return fail('NO_IDENTITY');
    if (!isConfiguredRoot(me)) return fail('FIRST_GROUP_ROOT_NOT_CONFIGURED');
    const C = App.Admin2faClient;
    if (!C || !C.required()) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    sync();
    if (verifiedControl()) return fail('ALREADY_BOOTSTRAPPED');
    try {
      const r = await signAttestedBootstrap(me, opts || {});
      if (!r.ok) return r;
      if (!r.attestation) return fail('ADMIN_2FA_REQUIRED');
      return { ok: true, code: 'GATE15_PACKAGE_READY', published: false, event: r.event, attestation: r.attestation };
    } catch (e) {
      return fail((e && e.code) || 'BOOTSTRAP_FAILED');
    }
  }

  /** Signed events seen by the last relay probe (untrusted input; the service re-verifies them). */
  let lastProbeEvents = { control: [], attestations: [] };

  /** Read-only control-chain probe from the relays; works with ACCESS_CONTROL_V2 off. */
  async function probeNetworkControl() {
    const n = NA();
    const g = GCS();
    if (!n || typeof n.fetchFromRelays !== 'function' || !g) return fail('NETWORK_AUTHORITY_MISSING');
    const gid = FIRST_GROUP.groupId;
    const res = await n.fetchFromRelays([
      { kinds: [39001], '#t': [gid], limit: 500 },
      { kinds: [39004], '#t': [gid], limit: 2000 },
    ]);
    const control = res.events.filter((e) => e && e.kind === 39001);
    lastProbeEvents = {
      control: control.slice(0, 500),
      attestations: res.events.filter((e) => e && e.kind === 39004).slice(0, 500),
    };
    const out = {
      ok: true,
      relaysOk: res.relaysOk,
      relaysTotal: res.relaysTotal,
      controlEvents: control.length,
      status: 'MISSING',
      controlEpoch: null,
      rootAdminPubkey: null,
      admin2faSignerPubkey: null,
      eventId: null,
      bootstrapEventId: null,
      admissionServicePubkey: ADMISSION_SERVICE_PUBKEY,
      admissionServiceCaps: [],
      admissionDelegates: [],
    };
    if (!control.length) return out;
    const A = App.Admin2faProtocol;
    if (A) A.ingestAttestations(res.events.filter((e) => e && e.kind === 39004));
    g.ingestControlEvents(control, { groupId: gid });
    out.status = g.getStatus(gid);
    const st = out.status === 'VERIFIED' ? g.getVerifiedControlState(gid) : null;
    const ev = st ? g.getVerifiedControlEvent(gid) : null;
    if (st) {
      out.controlEpoch = st.controlEpoch;
      out.rootAdminPubkey = st.rootAdminPubkey;
      out.admin2faSignerPubkey = st.admin2faSignerPubkey || null;
      out.eventId = ev ? ev.id : null;
      const chain = g.getVerifiedControlChain(gid);
      out.bootstrapEventId = chain.length ? chain[0].eventId : null;
      const caps = st.capabilities || {};
      out.admissionServiceCaps = (caps[ADMISSION_SERVICE_PUBKEY] || []).slice();
      out.admissionDelegates = Object.keys(caps)
        .filter((pk) => (caps[pk] || []).some((c) => ADMISSION_CAPS.indexOf(c) !== -1))
        .sort();
    }
    return out;
  }

  /** Exact Gate 1.5 genesis shape plus the attestation, verified locally before anything is published. */
  function checkGate15Package(ev, att, root, signer) {
    const A = App.Admin2faProtocol;
    const g = GCS();
    const gid = FIRST_GROUP.groupId;
    const tags = JSON.stringify([['d', gid + ':1'], ['t', gid], ['sos-control', 'v1']]);
    if (!ev || ev.kind !== 39001 || ev.pubkey !== root || JSON.stringify(ev.tags) !== tags) return fail('GATE15_EVENT_INVALID');
    if (typeof App.strictVerifyNostrEvent !== 'function' || App.strictVerifyNostrEvent(ev) !== true) return fail('GATE15_EVENT_INVALID');
    let rec = null;
    try {
      rec = g.parseAndValidateRecord(ev.content);
    } catch (_e) {
      return fail('GATE15_RECORD_INVALID');
    }
    if (
      rec.groupId !== gid ||
      rec.controlEpoch !== 1 ||
      rec.membershipEpoch !== 1 ||
      rec.rootAdminPubkey !== root ||
      Object.keys(rec.capabilities || {}).length !== 0 ||
      (rec.blockedPubkeys || []).length !== 0 ||
      rec.invitePolicy !== 'AUTHORIZED_USERS_ONLY' ||
      rec.admin2faSignerPubkey !== signer
    ) {
      return fail('GATE15_RECORD_INVALID');
    }
    const v = A.verifyAdmin2faAttestation(ev, att, {
      groupId: gid,
      rootPubkey: root,
      signerPubkey: signer,
      expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'],
      controlEpoch: 1,
      nowSec: Math.floor(Date.now() / 1000),
      requireUnexpired: true,
    });
    if (!v.ok) return fail(v.code);
    const p = g.previewControlTransition(ev, { groupId: gid });
    if (!p.ok) return fail(p.code || 'GATE15_PREVIEW_FAILED');
    return { ok: true };
  }

  async function publishCounted(ev) {
    let list;
    try {
      list = await Promise.resolve(App.pool.publish(App.relayUrls, ev));
    } catch (_e) {
      return 0;
    }
    if (!Array.isArray(list)) return 1;
    const timed = list.map((p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 10000))]));
    const r = await Promise.allSettled(timed);
    return r.filter((x) => x.status === 'fulfilled').length;
  }

  /**
   * Gate 1.5 (owner): relays confirm no control exists, then the attested BOOTSTRAP package is verified locally and
   * published, attestation first. No membership, delegation or other grant is created.
   */
  async function activateGroupControl() {
    const me = actor();
    if (!me || App.guestMode === true) return fail('NO_IDENTITY');
    if (!isConfiguredRoot(me)) return fail('FIRST_GROUP_ROOT_NOT_CONFIGURED');
    const sa = SA();
    const s = sa && sa.checkSessionForSensitiveOp ? sa.checkSessionForSensitiveOp('FIRST_GROUP_ADMIN:BOOTSTRAP') : null;
    if (!s || s.ok !== true) return fail((s && s.code) || 'SESSION_REVOKED');
    const ctx = contextCheck();
    if (!ctx.ok) return ctx;
    const A = App.Admin2faProtocol;
    const signer = A && typeof A.activeSignerPubkey === 'function' ? A.activeSignerPubkey() : '';
    if (!A || A.isEnforced() !== true || !signer || A.canonicalRootPubkey() !== me) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) return fail('NETWORK_AUTHORITY_UNVERIFIED');
    const pre = await probeNetworkControl();
    if (!pre.ok) return pre;
    if (pre.relaysOk < 2) return fail('NETWORK_AUTHORITY_UNVERIFIED');
    if (pre.controlEvents > 0) return fail('ALREADY_BOOTSTRAPPED');
    const pkg = await prepareGate15Package({ displayName: 'SOS', invitePolicy: 'AUTHORIZED_USERS_ONLY' });
    if (!pkg.ok) return pkg;
    const check = checkGate15Package(pkg.event, pkg.attestation, me, signer);
    if (!check.ok) return check;
    const attAcks = await publishCounted(pkg.attestation);
    if (!attAcks) return fail('PUBLISH_FAILED', { stage: 'attestation' });
    const evAcks = await publishCounted(pkg.event);
    if (!evAcks) return fail('PUBLISH_FAILED', { stage: 'event', attestationId: pkg.attestation.id });
    A.ingestAttestations([pkg.attestation]);
    const acc = GCS().acceptControlEvent(pkg.event, { groupId: FIRST_GROUP.groupId, persist: true });
    return done({
      ok: true,
      code: 'GATE15_PUBLISHED',
      eventId: pkg.event.id,
      attestationId: pkg.attestation.id,
      relayAcks: { attestation: attAcks, event: evAcks },
      accepted: !!(acc && acc.ok),
    });
  }

  // ---------------------------------------------------------------- Gate 2: admission service delegation (V2 off, ROOT)

  const DELEGATION_CHANGE = Object.freeze({
    ACTIVATE: Object.freeze({
      id: 'ACTIVATE',
      op: 'GRANT_CAPABILITY',
      operations: Object.freeze(['CREATE_ADMISSION_DELEGATION']),
      session: 'FIRST_GROUP_ADMIN:SET_ADMISSION_DELEGATE',
    }),
    REVOKE: Object.freeze({
      id: 'REVOKE',
      op: 'REVOKE_CAPABILITY',
      operations: Object.freeze(['REVOKE_ADMISSION_DELEGATION']),
      session: 'FIRST_GROUP_ADMIN:REVOKE_ADMISSION_DELEGATE',
    }),
  });

  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function settingsView(s) {
    const o = s || {};
    return {
      displayName: o.displayName || '',
      networkTag: o.networkTag || '',
      description: o.description || '',
      logoRef: o.logoRef || '',
    };
  }

  /** Expected capabilities map after the change: only FINALIZE_MEMBERSHIP_ADMISSION on the service key moves. */
  function expectedDelegationCaps(prevCaps, change) {
    const caps = JSON.parse(JSON.stringify(prevCaps || {}));
    const svc = ADMISSION_SERVICE_PUBKEY;
    if (change.id === 'ACTIVATE') caps[svc] = ['FINALIZE_MEMBERSHIP_ADMISSION'];
    else {
      caps[svc] = (caps[svc] || []).filter((c) => c !== 'FINALIZE_MEMBERSHIP_ADMISSION');
      if (!caps[svc].length) delete caps[svc];
    }
    return caps;
  }

  /** Gate 2 pre-publish validation: exact single-capability transition + bound, unexpired attestation. */
  function checkDelegationPackage(ev, att, prev, root, signer, change) {
    const A = App.Admin2faProtocol;
    const g = GCS();
    const gid = FIRST_GROUP.groupId;
    if (!prev || prev.rootAdminPubkey !== root || prev.admin2faSignerPubkey !== signer) return fail('GATE2_BASE_INVALID');
    const epoch = prev.controlEpoch + 1;
    const tags = JSON.stringify([['d', gid + ':' + epoch], ['t', gid], ['sos-control', 'v1']]);
    if (!ev || ev.kind !== 39001 || ev.pubkey !== root || JSON.stringify(ev.tags) !== tags) return fail('GATE2_EVENT_INVALID');
    if (typeof App.strictVerifyNostrEvent !== 'function' || App.strictVerifyNostrEvent(ev) !== true) return fail('GATE2_EVENT_INVALID');
    if (ADMISSION_SERVICE_PUBKEY === root || ev.pubkey === ADMISSION_SERVICE_PUBKEY) return fail('SELF_GRANT_FORBIDDEN');
    let next = null;
    try {
      next = g.parseAndValidateRecord(ev.content);
    } catch (_e) {
      return fail('GATE2_RECORD_INVALID');
    }
    if (
      next.groupId !== gid ||
      next.controlEpoch !== epoch ||
      next.membershipEpoch !== prev.membershipEpoch ||
      next.rootAdminPubkey !== root ||
      next.admin2faSignerPubkey !== signer ||
      next.invitePolicy !== prev.invitePolicy ||
      next.resolution ||
      (next.membershipRoot || null) !== (prev.membershipRoot || null) ||
      stable((next.blockedPubkeys || []).slice().sort()) !== stable((prev.blockedPubkeys || []).slice().sort()) ||
      stable(settingsView(next.groupSettings)) !== stable(settingsView(prev.groupSettings)) ||
      stable(next.capabilities) !== stable(expectedDelegationCaps(prev.capabilities, change))
    ) {
      return fail('GATE2_RECORD_INVALID');
    }
    const ops = A.classifyControlTransition(prev, next).slice().sort();
    if (ops.join(',') !== change.operations.join(',')) return fail('GATE2_OPERATION_MISMATCH');
    const v = A.verifyAdmin2faAttestation(ev, att, {
      groupId: gid,
      rootPubkey: root,
      signerPubkey: signer,
      expectedOperations: change.operations.slice(),
      controlEpoch: epoch,
      nowSec: Math.floor(Date.now() / 1000),
      requireUnexpired: true,
    });
    if (!v.ok) return fail(v.code);
    const p = g.previewControlTransition(ev, { groupId: gid });
    if (!p.ok) return fail(p.code || 'GATE2_PREVIEW_FAILED');
    return { ok: true, operations: ops, controlEpoch: epoch };
  }

  /** The admission service must verify the same control tip (read from relays) before it can co-sign. */
  async function serviceControlSummary(adm, tipId) {
    const gid = FIRST_GROUP.groupId;
    let r = await adm.post('/v1/control/refresh', { groupId: gid });
    if (r && r.tipEventId === tipId) return r;
    await adm.post('/v1/control/ingest', {
      groupId: gid,
      events: lastProbeEvents.control,
      attestations: lastProbeEvents.attestations,
    });
    r = await adm.post('/v1/control/refresh', { groupId: gid });
    return r || { result: 'TEMPORARILY_UNAVAILABLE' };
  }

  async function changeAdmissionDelegation(change) {
    const me = actor();
    if (!me || App.guestMode === true) return fail('NO_IDENTITY');
    if (!isConfiguredRoot(me)) return fail('FIRST_GROUP_ROOT_NOT_CONFIGURED');
    const sa = SA();
    const s = sa && sa.checkSessionForSensitiveOp ? sa.checkSessionForSensitiveOp(change.session) : null;
    if (!s || s.ok !== true) return fail((s && s.code) || 'SESSION_REVOKED');
    const ctx = contextCheck();
    if (!ctx.ok) return ctx;
    const A = App.Admin2faProtocol;
    const C = App.Admin2faClient;
    const signer = A && typeof A.activeSignerPubkey === 'function' ? A.activeSignerPubkey() : '';
    if (!A || A.isEnforced() !== true || !signer || A.canonicalRootPubkey() !== me) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    if (!C || typeof C.required !== 'function' || !C.required()) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    const adm = App.FirstGroupAdmission;
    if (!adm || !adm.configured()) return fail('ADMISSION_SERVICE_NOT_CONFIGURED');
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) return fail('NETWORK_AUTHORITY_UNVERIFIED');
    if (me === ADMISSION_SERVICE_PUBKEY) return fail('ROOT_TARGET_FORBIDDEN');

    const pre = await probeNetworkControl();
    if (!pre.ok) return pre;
    if (pre.relaysOk < 2) return fail('NETWORK_AUTHORITY_UNVERIFIED');
    if (pre.status === 'CONTROL_CONFLICT') return fail('CONTROL_CONFLICT');
    if (pre.status !== 'VERIFIED' || pre.rootAdminPubkey !== me || pre.admin2faSignerPubkey !== signer) {
      return fail('NETWORK_AUTHORITY_UNVERIFIED');
    }
    if (change.id === 'ACTIVATE') {
      if (pre.admissionDelegates.length) return fail('DELEGATION_EXISTS');
      if (pre.admissionServiceCaps.length) return fail('DELEGATE_HAS_OTHER_CAPABILITIES');
    } else if (pre.admissionServiceCaps.indexOf('FINALIZE_MEMBERSHIP_ADMISSION') === -1) {
      return fail('DELEGATION_NOT_ACTIVE');
    }
    const g = GCS();
    const gid = FIRST_GROUP.groupId;
    const base = g.getVerifiedControlEvent(gid);
    const prev = g.getVerifiedControlState(gid);
    if (!base || !prev || base.id !== pre.eventId) return fail('STALE_BASE');

    const svc = await serviceControlSummary(adm, base.id);
    if (!svc || svc.status !== 'VERIFIED' || svc.tipEventId !== base.id || svc.rootAdminPubkey !== me) {
      return fail('ADMISSION_SERVICE_CONTROL_MISMATCH', { serviceStatus: (svc && (svc.status || svc.code)) || null });
    }
    if (change.id === 'ACTIVATE' && svc.servicePubkey !== ADMISSION_SERVICE_PUBKEY) return fail('ADMISSION_SERVICE_KEY_MISMATCH');

    const S = App.SosCryptoSigner;
    if (!S || typeof S.signTypedAdminOperation !== 'function') return fail('SIGNER_MISSING');
    let signed;
    try {
      signed = await Promise.resolve(
        S.signTypedAdminOperation({
          version: 1,
          operation: change.op,
          groupId: gid,
          baseEvent: base,
          controlConflict: false,
          actorMembershipStatus: 'UNKNOWN',
          targetPubkey: ADMISSION_SERVICE_PUBKEY,
          capability: 'FINALIZE_MEMBERSHIP_ADMISSION',
        })
      );
    } catch (e) {
      return fail((e && e.code) || 'SIGN_FAILED');
    }
    const att = await attestPrivileged(signed, { expectedOperations: change.operations.slice(), controlEpoch: prev.controlEpoch + 1 });
    if (!att || !att.ok) return fail((att && att.code) || 'ADMIN_2FA_REQUIRED');
    if (!att.attestation) return fail('ADMIN_2FA_REQUIRED');
    A.ingestAttestations([att.attestation]);
    const check = checkDelegationPackage(signed, att.attestation, prev, me, signer, change);
    if (!check.ok) return check;

    const attAcks = await publishCounted(att.attestation);
    if (!attAcks) return fail('PUBLISH_FAILED', { stage: 'attestation' });
    const evAcks = await publishCounted(signed);
    if (!evAcks) return fail('PUBLISH_FAILED', { stage: 'event', attestationId: att.attestation.id });
    const acc = g.acceptControlEvent(signed, { groupId: gid, persist: true });
    const pushed = await adm.post('/v1/control/ingest', {
      groupId: gid,
      events: lastProbeEvents.control.concat([signed]),
      attestations: lastProbeEvents.attestations.concat([att.attestation]),
    });
    return done({
      ok: true,
      code: change.id === 'ACTIVATE' ? 'GATE2_DELEGATION_PUBLISHED' : 'DELEGATION_REVOKED',
      eventId: signed.id,
      attestationId: att.attestation.id,
      delegatePubkey: ADMISSION_SERVICE_PUBKEY,
      controlEpoch: check.controlEpoch,
      relayAcks: { attestation: attAcks, event: evAcks },
      accepted: !!(acc && acc.ok),
      serviceIngest: pushed ? pushed.result : null,
    });
  }

  /** Owner: delegate FINALIZE_MEMBERSHIP_ADMISSION (only) to the admission service key. V2 stays off. */
  function activateAdmissionService() {
    return changeAdmissionDelegation(DELEGATION_CHANGE.ACTIVATE);
  }

  /** Owner: remove the admission service delegation (compromise path). Not run in Gate 2. */
  function deactivateAdmissionService() {
    return changeAdmissionDelegation(DELEGATION_CHANGE.REVOKE);
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
    const n = NA();
    if (!n) return fail('NETWORK_AUTHORITY_MISSING');
    const net = await n.reconcile('bootstrap');
    if (!net.ok && net.detail === 'RELAY_UNAVAILABLE') return fail('NETWORK_AUTHORITY_UNVERIFIED');
    sync();
    if (verifiedControl()) return fail('ALREADY_BOOTSTRAPPED');
    if (!isConfiguredRoot(me)) return fail('FIRST_GROUP_ROOT_NOT_CONFIGURED');
    const p = PIN();
    if (!p || typeof p.isUnlocked !== 'function' || p.isUnlocked(me) !== true) return fail('ADMIN_PIN_REQUIRED');
    const g = GCS();
    const o = opts || {};
    try {
      const signedBootstrap = await signAttestedBootstrap(me, o);
      if (!signedBootstrap.ok) return signedBootstrap;
      const ev = signedBootstrap.event;
      if (!o.skipPublish && App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length) {
        try {
          if (signedBootstrap.attestation) await App.pool.publish(App.relayUrls, signedBootstrap.attestation);
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
          const matt = await attestPrivileged(memEv);
          if (!matt.ok) {
            member = { ok: false, code: matt.code, reason: matt.reason, detail: matt.detail };
          } else {
            if (!o.skipPublish && App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length) {
              try {
                if (matt.attestation) await App.pool.publish(App.relayUrls, matt.attestation);
                await App.pool.publish(App.relayUrls, memEv);
              } catch (_p2) {}
            }
            const macc = m.acceptMembershipEvent(memEv, verifiedControl(), { groupId: FIRST_GROUP.groupId });
            member = { ok: !!(macc && macc.ok), code: macc && macc.code };
          }
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
    const g = await nguard('SET_GROUP_METADATA', ['MANAGE_GROUP_SETTINGS']);
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
    const g = await nguard('GRANT_CAPABILITY', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
    if (!g.ok) return g;
    const target = normalizePubkey(targetPubkey);
    if (!target) return fail('BAD_PUBKEY');
    if (target === g.actor && !g.auth.isRoot) return fail('SELF_GRANT_FORBIDDEN');
    if (grantableCapsFor(g.auth, target).indexOf(capability) === -1) return fail('DELEGATION_ESCALATION');
    if (memberStatus(target) !== 'ACTIVE') return fail('TARGET_NOT_ACTIVE_MEMBER');
    return mutate({ type: 'GRANT_CAPABILITY', targetPubkey: target, capability }, opts);
  }

  async function revokeCapability(targetPubkey, capability, opts) {
    const g = await nguard('REVOKE_CAPABILITY', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
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
    const g = await nguard('SET_PERMISSIONS', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
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
    const g = await nguard('DEMOTE_ADMIN', ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS']);
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
    const g = await nguard('REMOVE_MEMBER', ['MANAGE_MEMBERS']);
    if (!g.ok) return g;
    const mao = MAO();
    if (!mao) return fail('NO_MEMBER_OPS');
    const res = await mao.removeMember(normalizePubkey(targetPubkey), g.actor, opts || {});
    return res && res.ok ? done(res) : res || fail('REMOVE_FAILED');
  }

  /** Invite-bound admission is final only through the canonical admission service (single-use atomic claim). */
  async function approveJoin(memberPubkey, inviteEventId) {
    const g = await nguard('GRANT_MEMBER_ACTIVE', ['MANAGE_MEMBERS']);
    if (!g.ok) return g;
    void memberPubkey;
    void inviteEventId;
    return fail('ADMISSION_SERVICE_REQUIRED');
  }

  // ---------------------------------------------------------------- admission service delegation (ROOT only)

  async function rootDelegationGuard(opName, servicePubkey) {
    const g = await nguard(opName, ['MANAGE_ADMINS']);
    if (!g.ok) return g;
    if (!g.auth.isRoot) return fail('ROOT_ONLY');
    const pk = normalizePubkey(servicePubkey);
    if (!pk) return fail('BAD_PUBKEY');
    if (pk === g.actor) return fail('ROOT_TARGET_FORBIDDEN');
    return Object.assign({}, g, { target: pk, assigned: authorityFor(pk).assigned });
  }

  /** Grants only FINALIZE_MEMBERSHIP_ADMISSION to the admission service key. */
  async function setAdmissionDelegate(servicePubkey, opts) {
    const g = await rootDelegationGuard('SET_ADMISSION_DELEGATE', servicePubkey);
    if (!g.ok) return g;
    if (g.assigned.some((c) => ADMISSION_CAPS.indexOf(c) === -1)) return fail('DELEGATE_HAS_OTHER_CAPABILITIES');
    if (g.assigned.indexOf('FINALIZE_MEMBERSHIP_ADMISSION') !== -1) return fail('NO_CHANGES');
    return mutate({ type: 'GRANT_CAPABILITY', targetPubkey: g.target, capability: 'FINALIZE_MEMBERSHIP_ADMISSION' }, opts);
  }

  /** Planned rotation: RETIRED is added before ACTIVE is removed, so earlier proofs never lose validity. */
  async function retireAdmissionDelegate(servicePubkey, opts) {
    const g = await rootDelegationGuard('RETIRE_ADMISSION_DELEGATE', servicePubkey);
    if (!g.ok) return g;
    if (g.assigned.indexOf('FINALIZE_MEMBERSHIP_ADMISSION_RETIRED') === -1) {
      const r1 = await mutate({ type: 'GRANT_CAPABILITY', targetPubkey: g.target, capability: 'FINALIZE_MEMBERSHIP_ADMISSION_RETIRED' }, opts);
      if (!r1 || !r1.ok) return r1;
    }
    if (authorityFor(g.target).assigned.indexOf('FINALIZE_MEMBERSHIP_ADMISSION') === -1) return { ok: true, code: 'RETIRED' };
    const r2 = await mutate({ type: 'REVOKE_CAPABILITY', targetPubkey: g.target, capability: 'FINALIZE_MEMBERSHIP_ADMISSION' }, opts);
    return r2 && r2.ok ? Object.assign({}, r2, { code: 'RETIRED' }) : r2;
  }

  /** Compromise: removes the delegation entirely; every proof it signed stops counting. */
  async function revokeAdmissionDelegate(servicePubkey, opts) {
    const g = await rootDelegationGuard('REVOKE_ADMISSION_DELEGATE', servicePubkey);
    if (!g.ok) return g;
    let last = fail('NO_CHANGES');
    for (const c of ADMISSION_CAPS) {
      if (authorityFor(g.target).assigned.indexOf(c) === -1) continue;
      last = await mutate({ type: 'REVOKE_CAPABILITY', targetPubkey: g.target, capability: c }, opts);
      if (!last || !last.ok) return last;
    }
    return last && last.ok ? Object.assign({}, last, { code: 'DELEGATION_REVOKED' }) : last;
  }

  function admissionDelegates() {
    const st = verifiedControl();
    if (!st) return [];
    return Object.keys(st.capabilities || {})
      .map((pk) => ({ pubkey: pk, caps: (st.capabilities[pk] || []).filter((c) => ADMISSION_CAPS.indexOf(c) !== -1) }))
      .filter((r) => r.caps.length)
      .map((r) => ({ pubkey: r.pubkey, status: r.caps.indexOf('FINALIZE_MEMBERSHIP_ADMISSION') !== -1 ? 'ACTIVE' : 'RETIRED' }));
  }

  async function setInvitePolicy(policy, opts) {
    const g = await nguard('SET_INVITE_POLICY', ['MANAGE_INVITES']);
    if (!g.ok) return g;
    return mutate({ type: 'SET_INVITE_POLICY', invitePolicy: policy }, opts);
  }

  // ---------------------------------------------------------------- invites / QR

  const myInvites = [];

  async function createInvite() {
    const g = await nguard('CREATE_INVITE', null);
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
      return done({ ok: true, code: 'CREATED', invite: row, admission: inv.admission || null });
    } catch (e) {
      return fail((e && e.admissionCode) || 'CREATE_INVITE_FAILED', { error: String((e && e.message) || e) });
    }
  }

  async function revokeInvite(row) {
    const g = await nguard('REVOKE_INVITE', null);
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
      if (e && e.admissionCode === 'ALREADY_REDEEMED') {
        myInvites.forEach((r) => {
          if (r.eventId === row.eventId) r.status = 'USED';
        });
      }
      return fail((e && e.admissionCode) || 'REVOKE_FAILED', { error: String((e && e.message) || e) });
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
    const g = await nguard('LIST_PENDING_JOINS', ['MANAGE_MEMBERS']);
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
    const n = NA();
    if (n) n.start();
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
    ADMIN_MUTATION_REQUIRES_PIN_UNLOCK: true,
    FIRST_GROUP_ADMIN_AUDIT_MODEL: 'SIGNED_CONTROL_CHAIN_PLUS_MEMBERSHIP_EVENTS',
    ROLE_MODEL: 'PRESENTATION_OVER_CANONICAL_CAPABILITIES',
    CAP_LABELS,
    ROLES,
    ADMIN_TIER_CAPS,
    contextCheck,
    sync,
    networkSynced,
    authorityFor,
    myAuthority,
    visibleSections,
    canSeeAdminMenu,
    isConfiguredRoot,
    grantableCapsFor,
    roleLabel,
    bootstrapFirstGroup,
    prepareGate15Package,
    probeNetworkControl,
    activateGroupControl,
    ADMISSION_SERVICE_PUBKEY,
    activateAdmissionService,
    deactivateAdmissionService,
    checkDelegationPackage,
    DELEGATION_CHANGE,
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
    ADMISSION_CAPS,
    setAdmissionDelegate,
    retireAdmissionDelegate,
    revokeAdmissionDelegate,
    admissionDelegates,
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
