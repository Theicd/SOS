/**
 * Gate 4 pre-activation: ACCESS_CONTROL_V2 scope split + existing-user lockout simulation (read-only).
 * - feature-flags.js: accessControlV2Scope (FULL | CONTROL_PLANE; absent = FULL; invalid = V2 off).
 * - Rebuilds the live production control chain from the canonical control relays (Admin 2FA enforced) and
 *   simulates every known israel-network post author under V2 FULL vs V2 CONTROL_PLANE.
 * - Proves the control plane (capabilities, invite creation, delegated capability use) is unchanged by the scope,
 *   and that blocked users stay denied in CONTROL_PLANE scope (disposable chain).
 * Publishes nothing. Disposable keys are generated per run and never printed.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../admission-service/package.json', import.meta.url));
const NT = require('nostr-tools');
const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
useWebSocketImplementation(require('ws'));
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

const GROUP = 'israel-network';
const ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const SIGNER = '74c4bb0fb6b87b69cc2a95a80b4b5fa616cde3f917ef1894594606d30062edfa';
const GENESIS = '69a27d4a441dc5e9067567332c02641db11733d988228e24fc4869604db20df3';
const DELEGATION = '02263f81915e0b8fd34cc92d6acbd590560d426d003d850492a8e1f8257d2833';
const CONTROL_RELAYS = ['wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh'];
const USER_RELAYS = CONTROL_RELAYS.concat(['wss://relay.snort.social']);

const results = [];
const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

// ---------------------------------------------------------------- 1. canonical flag parsing (production host)
async function flags(body) {
  const ctx = { console, setTimeout, clearTimeout, Promise, JSON, Date };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = { hostname: 'sos010.com', protocol: 'https:', search: '?acv2=1', hash: '', pathname: '/' };
  const store = { getItem: () => '1', setItem() {}, removeItem() {} };
  ctx.localStorage = store;
  ctx.sessionStorage = store;
  ctx.document = { readyState: 'complete', addEventListener() {} };
  ctx.NostrApp = {};
  ctx.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } };
  ctx.dispatchEvent = () => {};
  ctx.addEventListener = () => {};
  ctx.fetch = async () => ({ ok: true, status: 200, text: async () => body });
  vm.createContext(ctx);
  vm.runInContext(read('feature-flags.js'), ctx, { filename: 'feature-flags.js' });
  await ctx.SosFeatureFlags.whenReady();
  ctx.SOS_ACCESS_CONTROL_V2 = true;
  let tamper = true;
  try {
    ctx.SosFeatureFlags.accessControlV2Scope = () => 'FULL';
  } catch (_e) {}
  tamper = ctx.SosFeatureFlags.accessControlV2Scope() !== ctx.SosFeatureFlags.snapshot().accessControlV2Scope;
  return { v2: ctx.SOS_ACCESS_CONTROL_V2, scope: ctx.SosFeatureFlags.accessControlV2Scope(), member: ctx.SosFeatureFlags.isV2MemberScopeEnabled(), err: ctx.SosFeatureFlags.snapshot().errorCode, tamper };
}
const base = { schema: 'sos-feature-flags-v1', admin2faEnforcement: true, admin2faSignerPubkey: SIGNER };
const fCP = await flags(JSON.stringify(Object.assign({}, base, { accessControlV2: true, accessControlV2Scope: 'CONTROL_PLANE' })));
add('FLAG_CONTROL_PLANE_SCOPE_PARSED', fCP.v2 === true && fCP.scope === 'CONTROL_PLANE' && fCP.member === false && !fCP.err, fCP);
const fAbsent = await flags(JSON.stringify(Object.assign({}, base, { accessControlV2: true })));
add('FLAG_SCOPE_ABSENT_DEFAULTS_FULL', fAbsent.v2 === true && fAbsent.scope === 'FULL' && fAbsent.member === true, fAbsent);
const fBad = await flags(JSON.stringify(Object.assign({}, base, { accessControlV2: true, accessControlV2Scope: 'ALL' })));
add('FLAG_INVALID_SCOPE_FAILS_CLOSED_V2_OFF', fBad.v2 === false && fBad.err === 'INVALID_VALUE', fBad);
const fOff = await flags(JSON.stringify(Object.assign({}, base, { accessControlV2: false, accessControlV2Scope: 'CONTROL_PLANE' })));
add('FLAG_SCOPE_WITH_V2_OFF_STAYS_OFF', fOff.v2 === false && fOff.member === false, fOff);
add('FLAG_PRODUCTION_OVERRIDES_IGNORED', fOff.v2 === false && fCP.tamper === false, { writeIgnored: fOff.v2 === false, apiFrozen: fCP.tamper === false });

// ---------------------------------------------------------------- 2. canonical modules (node, Admin 2FA enforced)
await import('../admission-service/src/shim.js');
const App = globalThis.NostrApp;
App.adminSourceKeys = [ROOT];
const ff = { enforced: true, signer: SIGNER, scope: 'CONTROL_PLANE' };
App.FeatureFlags = Object.freeze({
  isAdmin2faEnforced: () => ff.enforced,
  admin2faSignerPubkey: () => ff.signer,
  accessControlV2Scope: () => ff.scope,
});
await import('../nostr-event-integrity.js');
await import('../group-control-state.js');
await import('../invite-policy.js');
await import('../moderation-policy.js');
await import('../membership-state.js');
await import('../admin-2fa-protocol.js');
await import('../access-control.js');
await import('../guest-p2p-schema.js');
const G = App.GroupControlState;
const P = App.Admin2faProtocol;
const MS = App.MembershipState;
const AC = App.AccessControl;
const GPS = App.GuestP2PSchema || globalThis.SosGuestP2PSchema;

async function query(url, filters, ms = 12000) {
  let relay;
  for (let i = 0; i < 3 && !relay; i++) {
    try {
      relay = await Relay.connect(url);
    } catch (_e) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!relay) return { url, code: 'CONNECT_FAILED', events: [] };
  return new Promise((resolve) => {
    const events = [];
    let done = false;
    const fin = (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        relay.close();
      } catch (_e) {}
      resolve({ url, code, events });
    };
    const t = setTimeout(() => fin('TIMEOUT'), ms);
    relay.subscribe(filters, { onevent: (e) => events.push(e), oneose: () => fin('EOSE'), onclose: () => fin('CLOSED') });
  });
}

const control = new Map();
const perControlRelay = [];
for (const u of CONTROL_RELAYS) {
  const r = await query(u, [{ kinds: [39001, 39003, 39004], '#t': [GROUP], limit: 2000 }]);
  r.events.forEach((e) => control.set(e.id, e));
  perControlRelay.push({ relay: u, code: r.code, events: r.events.length });
}
const cEvents = Array.from(control.values());
function loadProduction() {
  ff.enforced = true;
  ff.signer = SIGNER;
  App.adminSourceKeys = [ROOT];
  G.clearAllStores();
  P.clearAttestations();
  if (MS.clearAllMembershipStores) MS.clearAllMembershipStores();
  P.ingestAttestations(cEvents.filter((e) => e.kind === 39004));
  G.ingestControlEvents(cEvents.filter((e) => e.kind === 39001), { groupId: GROUP, persist: false });
  const mem = cEvents.filter((e) => e.kind === 39003);
  if (mem.length && MS.ingestMembershipEvents) MS.ingestMembershipEvents(mem);
}
loadProduction();
const tip = G.getVerifiedControlState(GROUP);
const chain = G.getVerifiedControlChain(GROUP).map((r) => r.eventId);
add(
  'PRODUCTION_CHAIN_VERIFIED',
  G.getStatus(GROUP) === 'VERIFIED' && chain[0] === GENESIS && chain[1] === DELEGATION && tip.rootAdminPubkey === ROOT && tip.admin2faSignerPubkey === SIGNER,
  { status: G.getStatus(GROUP), chain, perControlRelay }
);
const membershipEvents = cEvents.filter((e) => e.kind === 39003).length;

// ---------------------------------------------------------------- 3. known users + lockout simulation
const authors = new Map();
const perUserRelay = [];
for (const u of USER_RELAYS) {
  const r = await query(u, [{ kinds: [1], '#t': [GROUP], limit: 3000 }], 15000);
  r.events.forEach((e) => {
    if (NT.verifyEvent(e)) authors.set(e.pubkey, Math.max(authors.get(e.pubkey) || 0, e.created_at));
  });
  perUserRelay.push({ relay: u, code: r.code, posts: r.events.length });
}
const users = Array.from(authors.keys());
const nonRoot = users.filter((pk) => pk !== ROOT);
const CONTENT = MS.MEMBER_CONTENT_ACTIONS || [];
function simulate(scope) {
  ff.scope = scope;
  const denied = new Set();
  const codes = {};
  nonRoot.forEach((pk) => {
    CONTENT.forEach((a) => {
      const r = MS.canPerformMemberAction(pk, a);
      if (!r || r.ok !== true) {
        denied.add(pk);
        codes[r && r.code] = (codes[r && r.code] || 0) + 1;
      }
    });
  });
  const rootOk = CONTENT.every((a) => MS.canPerformMemberAction(ROOT, a).ok === true);
  return { denied: denied.size, allowed: nonRoot.length - denied.size, rootOk, codes };
}
const simFull = simulate('FULL');
const simCP = simulate('CONTROL_PLANE');
add('KNOWN_USERS_FOUND', users.length > 1, { users: users.length, perUserRelay });
add('FULL_SCOPE_WOULD_LOCK_OUT_EXISTING_USERS', simFull.denied === nonRoot.length, simFull);
add('CONTROL_PLANE_SCOPE_NO_EXISTING_USER_LOCKOUT', simCP.denied === 0 && simCP.rootOk, simCP);

// ---------------------------------------------------------------- 4. control plane unchanged by scope
function controlPlane(scope) {
  ff.scope = scope;
  let userCaps = 0;
  let inviteCreate = 0;
  let delegatedUse = 0;
  nonRoot.forEach((pk) => {
    AC.ADMIN_CAPABILITIES.forEach((c) => {
      if (AC.hasCapability(pk, c, GROUP)) userCaps++;
    });
    if (MS.canPerformMemberAction(pk, 'invite_create').ok === true) inviteCreate++;
    if (MS.canPerformMemberAction(pk, 'delegated_capability_use').ok === true) delegatedUse++;
  });
  const rootCaps = AC.ADMIN_CAPABILITIES.every((c) => AC.hasCapability(ROOT, c, GROUP));
  return { userCaps, inviteCreate, delegatedUse, rootCaps };
}
const cpFull = controlPlane('FULL');
const cpCP = controlPlane('CONTROL_PLANE');
add('NO_USER_GAINS_CAPABILITY_IN_EITHER_SCOPE', cpFull.userCaps === 0 && cpCP.userCaps === 0, { FULL: cpFull, CONTROL_PLANE: cpCP });
add('INVITE_CREATE_AND_DELEGATED_USE_STILL_MEMBERSHIP_GATED', cpCP.inviteCreate === 0 && cpCP.delegatedUse === 0 && JSON.stringify(cpFull) === JSON.stringify(cpCP), cpCP);
add('ROOT_KEEPS_ALL_CAPABILITIES', cpFull.rootCaps && cpCP.rootCaps, null);
ff.scope = 'CONTROL_PLANE';
add('GUEST_AND_UNKNOWN_PRINCIPAL_NO_CAPABILITY', !AC.hasCapability('', 'MANAGE_ADMINS', GROUP) && !AC.hasCapability('zz', 'INVITE_USERS', GROUP), null);
const svcPk = '752f47fa926d1833a451bdc97f3f2967ae4bc6452d0356bc7919c6928e4611ef';
add(
  'ADMISSION_SERVICE_HAS_NO_ADMIN_CAPABILITY',
  AC.ADMIN_CAPABILITIES.every((c) => !AC.hasCapability(svcPk, c, GROUP)) && G.admissionDelegateInfo(svcPk, GROUP).active === true,
  null
);

// ---------------------------------------------------------------- 5. blocklist still enforced in CONTROL_PLANE scope (disposable chain)
{
  const mk = () => {
    const sk = NT.generateSecretKey();
    return { sk, pk: NT.getPublicKey(sk) };
  };
  const R = mk();
  const X = mk();
  const Y = mk();
  const TG = 'gate4-disposable-network';
  G.clearAllStores();
  P.clearAttestations();
  if (MS.clearAllMembershipStores) MS.clearAllMembershipStores();
  const rec = JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: TG, rootAdminPubkey: R.pk, creatorPubkey: R.pk, displayName: 'T', invitePolicy: 'AUTHORIZED_USERS_ONLY' })));
  rec.blockedPubkeys = [X.pk];
  const t = Math.floor(Date.now() / 1000) - 60;
  rec.createdAt = t;
  const ev = NT.finalizeEvent({ kind: 39001, created_at: t, tags: [['d', TG + ':1'], ['t', TG], ['sos-control', 'v1']], content: JSON.stringify(rec) }, R.sk);
  G.ingestControlEvents([ev], { groupId: TG, persist: false });
  const prevTag = App.NETWORK_TAG;
  App.NETWORK_TAG = TG;
  MS.bindMembershipStore(TG);
  ff.scope = 'CONTROL_PLANE';
  const xPost = MS.canPerformMemberAction(X.pk, 'post_create');
  const yPost = MS.canPerformMemberAction(Y.pk, 'post_create');
  add('CONTROL_PLANE_BLOCKLISTED_USER_DENIED', G.getStatus(TG) === 'VERIFIED' && xPost.ok === false && yPost.ok === true, {
    status: G.getStatus(TG),
    x: xPost.code,
    y: yPost.code,
  });
  App.NETWORK_TAG = prevTag;
  MS.bindMembershipStore(GROUP);
}

// ---------------------------------------------------------------- 6. legacy P2P receive unchanged in CONTROL_PLANE scope
if (GPS && typeof GPS.validateGuest30078 === 'function') {
  const draft = () => ({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'p2p-heartbeat'], ['t', 'p2p-heartbeat'], ['app', 'sos-p2p-video'], ['expires', String(Date.now() + 180000)], ['guest', 'true']],
    content: JSON.stringify({ online: true, files: 0 }),
  });
  ff.scope = 'CONTROL_PLANE';
  const cp = GPS.validateGuest30078(draft(), { direction: 'receive', allowLegacyNoNetwork: true, networkTag: GROUP });
  ff.scope = 'FULL';
  const full = GPS.validateGuest30078(draft(), { direction: 'receive', allowLegacyNoNetwork: true, networkTag: GROUP });
  add('LEGACY_P2P_RECEIVE_UNCHANGED_IN_CONTROL_PLANE', cp.ok === true && full.ok === false, { cp: cp.code || cp.ok, full: full.code || full.reason || full.ok });
} else {
  add('LEGACY_P2P_RECEIVE_UNCHANGED_IN_CONTROL_PLANE', false, 'GuestP2PSchema not loaded');
}

// ---------------------------------------------------------------- 7. multi-community UI gated on FULL scope (source)
const scoped = ['feed.js', 'community-feed-selection.js', 'community-branding-ui.js', 'community-context.js', 'guest-p2p-schema.js', 'p2p-video-sharing.js'];
const missing = scoped.filter((f) => !/accessControlV2Scope\(\) === 'CONTROL_PLANE'/.test(read(f)));
add('MULTI_COMMUNITY_AND_P2P_SCOPE_CHECKS_PRESENT', missing.length === 0, missing);

const pass = results.every((r) => r.ok);
const report = {
  gate: 'gate4-v2-scope',
  CURRENT_KNOWN_FIRST_GROUP_USERS: users.length,
  CURRENT_KNOWN_ACTIVE_LAST_30D: users.filter((pk) => authors.get(pk) >= Math.floor(Date.now() / 1000) - 30 * 86400).length,
  CURRENT_VALID_MEMBERSHIP_EVENTS: membershipEvents,
  FULL_SCOPE: { USERS_ALLOWED: simFull.allowed + 1, USERS_DENIED: simFull.denied },
  CONTROL_PLANE_SCOPE: { USERS_ALLOWED: simCP.allowed + 1, USERS_DENIED: simCP.denied },
  ROOT_ALLOWED_AFTER_V2: simCP.rootOk,
  results,
  GATE4_V2_SCOPE_GATE: pass ? 'PASS' : 'FAIL',
};
fs.writeFileSync(new URL('./gate4-v2-scope-report.json', import.meta.url), JSON.stringify(report, null, 2));
results.forEach((r) => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' ' + JSON.stringify(r.detail))));
console.log('USERS=' + users.length + ' MEMBERSHIP_EVENTS=' + membershipEvents + ' FULL_DENIED=' + simFull.denied + ' CP_DENIED=' + simCP.denied);
console.log('GATE4_V2_SCOPE_GATE=' + report.GATE4_V2_SCOPE_GATE + ' (' + results.filter((r) => r.ok).length + '/' + results.length + ')');
process.exit(0);
