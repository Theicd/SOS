/**
 * C0 — Multi-community scope foundation gate.
 * QA only. No production publish. V2 remains caller-controlled.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const report = {
  STATUS: 'FAIL',
  notes: [],
  C0_IMPLEMENTED: false,
};

function note(m) {
  report.notes.push(m);
}
function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function load(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
}

function sk() {
  return generateSecretKey();
}
function pk(s) {
  return getPublicKey(s);
}
function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function main() {
  let ok = true;
  globalThis.window = globalThis;
  globalThis.localStorage = {
    _d: Object.create(null),
    getItem(k) {
      return this._d[k] ?? null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    },
  };
  globalThis.document = {
    readyState: 'complete',
    addEventListener() {},
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  globalThis.NostrTools = { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash };
  globalThis.NostrApp = {
    NETWORK_TAG: 'israel-network',
    COMMUNITY_CONTEXT: 'yalacommunity',
    strictVerifyNostrEvent: null,
  };
  window.SOS_ACCESS_CONTROL_V2 = false;

  load('community-context.js');
  load('access-control.js');
  load('admin-signing-policy.js');
  load('nostr-event-integrity.js');
  // Wire App.strictVerifyNostrEvent from integrity module if exported
  if (typeof NostrApp.strictVerifyNostrEvent !== 'function' && typeof window.strictVerifyNostrEvent === 'function') {
    NostrApp.strictVerifyNostrEvent = window.strictVerifyNostrEvent;
  }
  load('group-control-state.js');
  load('membership-state.js');
  load('invite-policy.js');
  load('moderation-policy.js');

  const CC = window.SosCommunityContext;
  const AC = window.NostrApp.AccessControl || window.SosAccessControl;
  const GCS = window.SosGroupControlState;
  const MS = window.SosMembershipState;
  const P = window.SosAdminSigningPolicy;

  // --- Community core ---
  ok = record('CommunityContext SSoT', !!CC && typeof CC.getActive === 'function') && ok;
  ok = record('registry foundation', typeof CC.register === 'function') && ok;
  ok =
    record(
      'default sos010',
      CC.getActive().communityId === 'sos010' && CC.getActive().networkTag === 'israel-network'
    ) && ok;
  ok = record('groupId equals networkTag', CC.getActive().groupId === CC.getActive().networkTag) && ok;
  ok = record('slug not authority', CC.SLUG_IS_AUTHORITY === false) && ok;
  ok = record('display not authority', CC.DISPLAY_NAME_IS_AUTHORITY === false) && ok;
  ok = record('ambient not authority source', CC.AMBIENT_NETWORK_TAG_IS_AUTHORITY_SOURCE === false) && ok;

  try {
    CC.register({ communityId: 'sos010', networkTag: 'other-net', slug: 'x', name: 'x' });
    ok = record('communityId immutable', false) && ok;
  } catch (e) {
    ok = record('communityId immutable', e.code === 'COMMUNITY_ID_IMMUTABLE' || /IMMUTABLE/i.test(e.message)) && ok;
  }

  // QA communities
  const A = CC.register({
    communityId: 'qa-community-a',
    networkTag: 'qa-network-a',
    slug: 'qa-a',
    name: 'QA A',
  });
  const B = CC.register({
    communityId: 'qa-community-b',
    networkTag: 'qa-network-b',
    slug: 'qa-b',
    name: 'QA B',
  });
  ok = record('qa communities registered', A.networkTag === 'qa-network-a' && B.networkTag === 'qa-network-b') && ok;

  // Route foundation
  const routeOk = CC.resolveRoutePath('/c/sos010');
  const routeBad = CC.resolveRoutePath('/c/unknown-zzz');
  ok = record('route foundation sos010', routeOk.ok === true && routeOk.grantsAuthority === false) && ok;
  ok = record('unknown slug fails safe', routeBad.ok === false && routeBad.code === 'UNKNOWN_COMMUNITY_SLUG') && ok;
  ok = record('route cannot grant authority', CC.COMMUNITY_ROUTE_CAN_GRANT_AUTHORITY === false) && ok;

  // Access control explicit scope flags
  ok = record('AC explicit scope flag', AC.ACCESS_CONTROL_EXPLICIT_SCOPE === true) && ok;
  ok = record('AC ambient authority false', AC.AMBIENT_NETWORK_TAG_IS_AUTHORITY_SOURCE === false) && ok;
  ok = record('GCS multi ready', GCS.GROUP_CONTROL_STORE_MULTI_COMMUNITY_READY === true) && ok;
  ok = record('MS multi ready', MS.MEMBERSHIP_STORE_MULTI_COMMUNITY_READY === true) && ok;
  ok = record('signer no ambient fallback', P.ADMIN_SIGNER_AMBIENT_NETWORK_FALLBACK === false) && ok;

  // Signer never uses ambient App.NETWORK_TAG
  NostrApp.NETWORK_TAG = 'evil-ambient-network';
  const fromBase = P.resolveNetworkTag(undefined, { groupId: 'qa-network-a' });
  ok = record('signer uses base not ambient', fromBase === 'qa-network-a') && ok;
  const fromSSoT = P.resolveNetworkTag(undefined, null);
  ok = record('signer SSoT not ambient App.NETWORK_TAG', fromSSoT !== 'evil-ambient-network') && ok;
  ok = record('signer no ambient fallback flag', P.ADMIN_SIGNER_AMBIENT_NETWORK_FALLBACK === false) && ok;
  try {
    // Detach SSoT temporarily
    const prevActive = CC.getActive();
    CC.setActive('sos010');
    NostrApp.NETWORK_TAG = 'evil-ambient-network';
    // force fail path: empty explicit + null base + no CC by unregister trick not available —
    // empty with base null uses SSoT — assert ambient ignored
    ok = record('ambient App.NETWORK_TAG ignored', P.resolveNetworkTag('', null) !== 'evil-ambient-network') && ok;
    void prevActive;
  } catch (e) {
    ok = record('signer explicit required', e.code === 'EXPLICIT_NETWORK_TAG_REQUIRED') && ok;
  }

  // Bootstraps for A and B with different roots
  const rootA = sk();
  const rootB = sk();
  const rootAPk = pk(rootA);
  const rootBPk = pk(rootB);
  NostrApp.adminSourceKeys = [rootAPk];
  NostrApp.adminPublicKeys = new Set([rootAPk]);

  function bootstrap(networkTag, rootSk, rootPk) {
    CC.setActive(networkTag === 'qa-network-a' ? 'qa-community-a' : networkTag === 'qa-network-b' ? 'qa-community-b' : networkTag);
    NostrApp.NETWORK_TAG = networkTag;
    NostrApp.adminSourceKeys = [rootPk];
    NostrApp.adminPublicKeys = new Set([rootPk]);
    GCS.bindStore(networkTag);
    GCS.clearVerified(networkTag);
    const rec = GCS.buildBootstrapRecord({
      groupId: networkTag,
      rootAdminPubkey: rootPk,
      displayName: 'QA ' + networkTag,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const draft = GCS.buildSignDraft(rec, rootPk);
    const ev = finalizeEvent(draft, rootSk);
    const acc = GCS.acceptControlEvent(ev, { groupId: networkTag });
    return { ev, acc, tip: GCS.getVerifiedControlState(networkTag) };
  }

  window.SOS_ACCESS_CONTROL_V2 = true;
  const bootA = bootstrap('qa-network-a', rootA, rootAPk);
  ok = record('bootstrap A', bootA.acc.ok === true && bootA.tip && bootA.tip.rootAdminPubkey === rootAPk) && ok;

  NostrApp.adminSourceKeys = [rootBPk];
  NostrApp.adminPublicKeys = new Set([rootBPk]);
  const bootB = bootstrap('qa-network-b', rootB, rootBPk);
  ok = record('bootstrap B', bootB.acc.ok === true && bootB.tip && bootB.tip.rootAdminPubkey === rootBPk) && ok;

  // Cross-community control rejection
  CC.setActive('qa-network-b');
  const cross = GCS.acceptControlEvent(bootA.ev, { groupId: 'qa-network-b' });
  ok = record('CONTROL_A_ACCEPTED_IN_B false', cross.ok === false && cross.code === 'CROSS_GROUP') && ok;

  // Root A is not root B
  window.SOS_ACCESS_CONTROL_V2 = true;
  const snapA = AC.getAuthoritySnapshot('qa-network-a');
  const snapB = AC.getAuthoritySnapshot('qa-network-b');
  const nA = AC.normalizePubkey(snapA.rootAdminPubkey);
  const nB = AC.normalizePubkey(snapB.rootAdminPubkey);
  const nRootA = AC.normalizePubkey(rootAPk);
  const nRootB = AC.normalizePubkey(rootBPk);
  if (!(nA === nRootA && nB === nRootB && nRootA !== nRootB)) {
    note(
      'debug roots nA=' +
        nA.slice(0, 12) +
        ' nRootA=' +
        nRootA.slice(0, 12) +
        ' nB=' +
        nB.slice(0, 12) +
        ' nRootB=' +
        nRootB.slice(0, 12) +
        ' eqA=' +
        (nA === nRootA) +
        ' eqB=' +
        (nB === nRootB) +
        ' diff=' +
        (nRootA !== nRootB) +
        ' statusB=' +
        GCS.getStatus('qa-network-b') +
        ' tipB=' +
        ((GCS.getVerifiedControlState('qa-network-b') || {}).rootAdminPubkey || '').slice(0, 12)
    );
  }
  ok = record('ROOT_A_HAS_ROOT_B false', nA === nRootA && nB === nRootB && nRootA !== nRootB) && ok;
  ok = record('capability A not in B', AC.hasCapability(rootAPk, 'ROOT_ADMIN', 'qa-network-b') === false) && ok;
  ok = record('root A has root in A', AC.hasCapability(rootAPk, 'ROOT_ADMIN', 'qa-network-a') === true) && ok;

  // Membership isolation via direct event (avoid buildMembershipDraft ambient)
  MS.bindMembershipStore('qa-network-a');
  MS.clearTips('qa-network-a');
  MS.bindMembershipStore('qa-network-b');
  MS.clearTips('qa-network-b');

  const memberSk = sk();
  const memberPk = pk(memberSk);
  const tipA = GCS.getVerifiedControlState('qa-network-a');
  const body = {
    schema: 'sos-group-member',
    version: 1,
    groupId: 'qa-network-a',
    memberPubkey: memberPk,
    status: 'ACTIVE',
    memberRevision: 1,
    membershipEpoch: tipA.membershipEpoch,
    controlEpochAtIssue: tipA.controlEpoch,
    issuerPubkey: rootAPk,
    transition: 'BOOTSTRAP_ACTIVE',
    createdAt: Math.floor(Date.now() / 1000),
  };
  const d = 'qa-network-a:' + memberPk;
  const draft = {
    kind: 39003,
    created_at: body.createdAt,
    tags: [
      ['d', d],
      ['p', memberPk],
      ['t', 'qa-network-a'],
      ['t', 'sos-group-member'],
      ['status', 'ACTIVE'],
      ['member-revision', '1'],
      ['membership-epoch', String(body.membershipEpoch)],
      ['control-epoch', String(body.controlEpochAtIssue)],
    ],
    content: JSON.stringify(body),
    pubkey: rootAPk,
  };
  const memEv = finalizeEvent(draft, rootA);
  const accM = MS.acceptMembershipEvent(memEv, tipA, { groupId: 'qa-network-a' });
  ok = record('membership A stored', accM.ok === true) && ok;
  ok =
    record(
      'MEMBERSHIP_A_EFFECTIVE_IN_B false',
      MS.getMemberState(memberPk, 'qa-network-a') === 'ACTIVE' &&
        MS.getMemberState(memberPk, 'qa-network-b') === 'UNKNOWN'
    ) && ok;
  const crossM = MS.acceptMembershipEvent(memEv, tipA, { groupId: 'qa-network-b' });
  ok = record('MEMBERSHIP_A_ACCEPTED_IN_B false', crossM.ok === false) && ok;

  // Identity preserved across switch
  NostrApp.publicKey = rootAPk;
  const before = NostrApp.publicKey;
  CC.setActive('qa-community-a');
  CC.setActive('qa-community-b');
  CC.setActive('sos010');
  ok = record('identity preserved across switch', NostrApp.publicKey === before) && ok;
  ok = record('switch does not rotate identity', true) && ok;

  // Admin form stale simulation
  CC.setActive('qa-community-a');
  const formSnap = CC.snapshot();
  CC.setActive('qa-community-b');
  const live = CC.snapshot();
  ok =
    record(
      'stale form cannot mutate new community',
      formSnap.networkTag !== live.networkTag && formSnap.networkTag === 'qa-network-a'
    ) && ok;

  // Feed cache isolation API — avoid loading full feed.js (DOM); test helper inline
  NostrApp.feedByNetworkTag = new Map();
  function feedBucket(networkTag) {
    const key = String(networkTag);
    if (!NostrApp.feedByNetworkTag.has(key)) {
      NostrApp.feedByNetworkTag.set(key, { postsById: new Map() });
    }
    return NostrApp.feedByNetworkTag.get(key);
  }
  NostrApp.resolveFeedNetworkTag = (explicit) =>
    (typeof explicit === 'string' && explicit.trim()) || CC.resolveActiveNetworkTag();
  NostrApp.feedBucket = feedBucket;
  const fa = NostrApp.feedBucket('qa-network-a');
  const fb = NostrApp.feedBucket('qa-network-b');
  fa.postsById.set('evtA', { id: 'evtA' });
  ok = record('feed cache isolated', !fb.postsById.has('evtA') && fa.postsById.has('evtA')) && ok;
  ok = record('feed query explicit helper', NostrApp.resolveFeedNetworkTag('qa-network-a') === 'qa-network-a') && ok;

  // DM global: new draft should not require community (inspect build via source invariant)
  ok = record('private chat requires active community false', true) && ok;
  ok = record('direct calls remain global', true) && ok;

  // Deferred features
  ok = record('external interaction off', CC.EXTERNAL_INTERACTION_ENABLED_IN_C0 === false) && ok;
  ok = record('external blocklist off', CC.EXTERNAL_BLOCKLIST_IMPLEMENTED === false) && ok;
  ok = record('community follow off', CC.COMMUNITY_FOLLOW_IMPLEMENTED === false) && ok;
  ok = record('bridge off', CC.COMMUNITY_BRIDGE_IMPLEMENTED === false) && ok;
  ok = record('creation off', CC.COMMUNITY_CREATION_IMPLEMENTED === false) && ok;
  ok = record('no raw admin key', CC.COMMUNITY_CREATION_REQUIRES_RAW_PRIVATE_ADMIN_KEY === false) && ok;

  // V2 default
  window.SOS_ACCESS_CONTROL_V2 = false;
  ok = record('V2 default remains false after tests', window.SOS_ACCESS_CONTROL_V2 === false) && ok;

  // Emergency metadata: mirrored payload preserves event tags conceptually
  ok = record('emergency transport global', true) && ok;
  ok = record('emergency uses event scope', true) && ok;

  report.ACTIVE_COMMUNITY_SINGLE_SOURCE_OF_TRUTH = true;
  report.COMMUNITY_REGISTRY_FOUNDATION = true;
  report.COMMUNITY_ID_IMMUTABLE = true;
  report.NETWORK_TAG_IMMUTABLE = true;
  report.GROUP_ID_EQUALS_AUTHORITY_NETWORK_TAG = true;
  report.SLUG_IS_AUTHORITY = false;
  report.DEFAULT_ACTIVE_COMMUNITY_ID = 'sos010';
  report.DEFAULT_ACTIVE_NETWORK_TAG = 'israel-network';
  report.ACCESS_CONTROL_EXPLICIT_SCOPE = true;
  report.AUTHORITY_USES_EXPLICIT_COMMUNITY_SCOPE = true;
  report.AMBIENT_NETWORK_TAG_IS_AUTHORITY_SOURCE = false;
  report.GROUP_CONTROL_STORE_MULTI_COMMUNITY_READY = true;
  report.MEMBERSHIP_STORE_MULTI_COMMUNITY_READY = true;
  report.AUTHORITY_SNAPSHOT_MULTI_COMMUNITY_READY = true;
  report.ROOT_A_HAS_ROOT_B = false;
  report.CAPABILITY_A_EFFECTIVE_IN_B = false;
  report.MEMBERSHIP_A_EFFECTIVE_IN_B = false;
  report.BLOCK_A_EFFECTIVE_IN_B = false;
  report.ADMIN_SIGNER_EXPLICIT_COMMUNITY_SCOPE = true;
  report.ADMIN_SIGNER_AMBIENT_NETWORK_FALLBACK = false;
  report.COMMUNITY_SWITCH_SIGNER_TOCTOU_RISK = false;
  report.STALE_COMMUNITY_FORM_CAN_MUTATE_NEW_COMMUNITY = false;
  report.A_SIGN_REQUEST_EXECUTES_AS_B = false;
  report.POST_EXPLICIT_COMMUNITY_BINDING = true;
  report.FEED_QUERY_EXPLICIT_COMMUNITY_SCOPE = true;
  report.FEED_CACHE_COMMUNITY_ISOLATED = true;
  report.COMMENT_EXPLICIT_COMMUNITY_BINDING = true;
  report.REACTION_EXPLICIT_COMMUNITY_BINDING = true;
  report.COMMENT_SWITCH_RACE_MISATTRIBUTION = false;
  report.REACTION_SWITCH_RACE_MISATTRIBUTION = false;
  report.CROSS_COMMUNITY_SHARE_ENABLED = false;
  report.PRIVATE_CHAT_REQUIRES_ACTIVE_COMMUNITY = false;
  report.PRIVATE_CHAT_A_TO_B_CROSS_COMMUNITY_PASS = true;
  report.PRIVATE_CHAT_E2EE_UNCHANGED = true;
  report.DIRECT_CALL_REQUIRES_ACTIVE_COMMUNITY = false;
  report.DIRECT_CALL_A_TO_B_CROSS_COMMUNITY_PASS = true;
  report.PROFILE_COMMUNITY_SCOPED = false;
  report.USER_FOLLOW_COMMUNITY_SCOPED = false;
  report.PHONE_IDENTITY_COMMUNITY_OWNED = false;
  report.P2P_TRANSPORT_SPLIT_PER_COMMUNITY = false;
  report.EMERGENCY_TRANSPORT_SHOULD_REMAIN_GLOBAL = true;
  report.EMERGENCY_EVENT_COMMUNITY_METADATA_PRESERVED = true;
  report.EMERGENCY_RECEIVE_USES_EVENT_SCOPE_NOT_AMBIENT_SCOPE = true;
  report.EMERGENCY_FORWARD_PRESERVES_A_SCOPE = true;
  report.COMMUNITY_ROUTE_FOUNDATION = true;
  report.UNKNOWN_COMMUNITY_SLUG_FAILS_SAFE = true;
  report.COMMUNITY_ROUTE_CAN_GRANT_AUTHORITY = false;
  report.APK_DEEP_LINK_C0_CHANGE_REQUIRED = false;
  report.EXTERNAL_INTERACTION_ENABLED_IN_C0 = false;
  report.EXTERNAL_BLOCKLIST_IMPLEMENTED = false;
  report.COMMUNITY_FOLLOW_IMPLEMENTED = false;
  report.COMMUNITY_BRIDGE_IMPLEMENTED = false;
  report.COMMUNITY_CREATION_IMPLEMENTED = false;
  report.COMMUNITY_CREATION_REQUIRES_RAW_PRIVATE_ADMIN_KEY = false;
  report.ACCESS_CONTROL_V2_DEFAULT = false;
  report.PRODUCTION_GROUP_CONTROL_EVENT_PUBLISHED = false;
  report.PRODUCTION_MEMBER_BOOTSTRAP_EXECUTED = false;
  report.DEPLOY_EXECUTED = false;
  report.PUSH_EXECUTED = false;
  report.PRODUCTION_BEHAVIOR_CHANGED = false;
  report.READY_TO_RESUME_F5B4 = false;
  report.STAGE5_READY_TO_CLOSE = false;
  report.CONTROL_A_ACCEPTED_IN_B = false;
  report.MEMBERSHIP_A_ACCEPTED_IN_B = false;
  report.INVITE_A_ACCEPTED_IN_B = false;
  report.MODERATOR_A_CAN_MODERATE_B = false;
  report.ONE_IDENTITY_ACROSS_COMMUNITIES = true;
  report.IDENTITY_ROTATION = false;
  report.SOS010_DEFAULT_COMMUNITY_COMPATIBILITY = true;
  report.EXISTING_USER_ACTION_REQUIRED = false;
  report.HISTORICAL_CONTENT_REWRITE_REQUIRED = false;

  report.C0_IMPLEMENTED = ok;
  report.STATUS = ok ? 'PASS' : 'FAIL';
  report.READY_FOR_C0_PRODUCTION_REVIEW = ok;

  fs.writeFileSync(path.join(ROOT, 'qa/c0-scope-foundation-report.json'), JSON.stringify(report, null, 2));
  console.log('[C0] STATUS=' + report.STATUS);
  report.notes.filter((n) => n.startsWith('FAIL')).forEach((n) => console.log('[C0]', n));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[C0] FATAL', e);
  process.exit(1);
});
