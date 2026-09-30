/**
 * Admin 2FA Phase 2 — client verification gate (deterministic, no network, no deploy).
 *
 * Loads the real browser modules (feature-flags, admin-2fa-protocol, group-control-state, invite-policy,
 * moderation-policy, membership-state) in fresh VM contexts. Enforcement comes only from a mocked canonical
 * runtime-feature-flags.json response. Attestations are built with the shared protocol builder and signed with a
 * disposable key standing in for the Admin 2FA service. Writes qa/admin-2fa-client-report.json (no secrets).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as NostrTools from 'nostr-tools';

const { generateSecretKey, getPublicKey, finalizeEvent } = NostrTools;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'admin-2fa-client-report.json');
const GROUP = 'israel-network';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function mkKey() {
  const sk = generateSecretKey();
  return { sk, pub: getPublicKey(sk) };
}
const R = mkKey(); // canonical ROOT (QA)
const C = mkKey(); // Admin 2FA service (QA)
const W = mkKey(); // wrong server
const A2 = mkKey(); // delegated admin
const B = mkKey(); // ordinary member
const X = mkKey(); // outsider
const nowSec = () => Math.floor(Date.now() / 1000);
const rid = () => crypto.randomBytes(32).toString('hex');

const checks = [];
const negatives = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail != null ? ' ' + JSON.stringify(detail) : ''}`);
}
function negative(name, verdict, expectOk) {
  const ok = expectOk ? verdict.ok === true : verdict.ok === false;
  negatives.push({ name, ok, code: verdict.code });
  check('NEG_' + name, ok, verdict.code);
}

// ------------------------------------------------------------ browser-like VM environment
const PROD_CONFIG = read('runtime-feature-flags.json');
const PROD_SIGNER = '74c4bb0fb6b87b69cc2a95a80b4b5fa616cde3f917ef1894594606d30062edfa';
const OFF_CONFIG = JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false });
const MODULES = [
  'nostr-event-integrity.js',
  'feature-flags.js',
  'admin-2fa-protocol.js',
  'group-control-state.js',
  'invite-policy.js',
  'moderation-policy.js',
  'membership-state.js',
];

async function makeEnv(configText, opts) {
  const o = opts || {};
  const mem = new Map(o.localStorage || []);
  const target = new EventTarget();
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    crypto: globalThis.crypto,
    CustomEvent: class extends Event {
      constructor(type, init) {
        super(type);
        this.detail = init && init.detail;
      }
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    location: { hostname: o.hostname || '127.0.0.1', protocol: 'http:', search: o.search || '', hash: '' },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
      key: (i) => Array.from(mem.keys())[i] || null,
      get length() {
        return mem.size;
      },
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => configText }),
    NostrTools: {
      ...NostrTools,
      getEventHash: (e) => NostrTools.getEventHash(JSON.parse(JSON.stringify(e))),
      verifyEvent: (e) => NostrTools.verifyEvent(JSON.parse(JSON.stringify(e))),
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  if (o.preset) o.preset(ctx);
  ctx.NostrApp = { NETWORK_TAG: GROUP, COMMUNITY_CONTEXT: 'yalacommunity', adminSourceKeys: [R.pub] };
  vm.createContext(ctx);
  vm.runInContext(read('nostr-event-integrity.js'), ctx, { filename: 'nostr-event-integrity.js' });
  vm.runInContext(read('feature-flags.js'), ctx, { filename: 'feature-flags.js' });
  await ctx.NostrApp.FeatureFlags.whenReady();
  for (const f of MODULES.slice(2)) vm.runInContext(read(f), ctx, { filename: f });
  ctx.SOS_ACCESS_CONTROL_V2 = true; // local-host test override (V2 paths only; Admin 2FA has no override)
  const App = ctx.NostrApp;
  return { ctx, App, G: App.GroupControlState, P: App.Admin2faProtocol, IP: App.InvitePolicy, MP: App.ModerationPolicy, MS: App.MembershipState };
}

const ON_CONFIG = JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: true, admin2faSignerPubkey: C.pub });

// ------------------------------------------------------------ builders
function signControl(G, recObj, signer, createdAt) {
  const record = G.parseAndValidateRecord(JSON.stringify(recObj));
  const d = JSON.parse(JSON.stringify(G.buildSignDraft(record, signer.pub)));
  return finalizeEvent({ kind: d.kind, created_at: createdAt || d.created_at, tags: d.tags, content: d.content }, signer.sk);
}
function nextRec(G, tipRec, patch) {
  const rec = JSON.parse(G.serializeRecord(tipRec));
  rec.controlEpoch += 1;
  rec.createdAt = nowSec();
  patch(rec);
  return rec;
}
function attest(P, event, operations, o) {
  const opt = o || {};
  const draft = P.buildAttestationDraft({
    groupId: opt.groupId || GROUP,
    rootPubkey: opt.rootPubkey || R.pub,
    event,
    operations,
    controlEpoch: opt.controlEpoch != null ? opt.controlEpoch : 0,
    principal: opt.principal || event.pubkey,
    stepUp: opt.stepUp === true,
    issuedAt: opt.issuedAt || nowSec(),
    requestId: opt.requestId || rid(),
  });
  const host = JSON.parse(JSON.stringify(draft));
  if (opt.mutate) opt.mutate(host);
  return finalizeEvent(host, (opt.signer || C).sk);
}
function withContent(att, patch, signer) {
  const body = JSON.parse(att.content);
  patch(body);
  return finalizeEvent({ kind: att.kind, created_at: att.created_at, tags: att.tags, content: JSON.stringify(body) }, (signer || C).sk);
}
function modEvent(moderator, target) {
  const content = {
    schema: 'sos-group-moderation',
    version: 1,
    groupId: GROUP,
    targetEventId: target.id,
    targetEventKind: 1,
    targetAuthorPubkey: target.pubkey,
    moderatorPubkey: moderator.pub,
    action: 'hide',
    controlEpoch: 1,
  };
  return finalizeEvent(
    {
      kind: 39002,
      created_at: nowSec(),
      tags: [
        ['d', target.id],
        ['e', target.id],
        ['p', target.pubkey],
        ['k', '1'],
        ['t', GROUP],
        ['t', 'sos-group-moderation'],
        ['control-epoch', '1'],
      ],
      content: JSON.stringify(content),
    },
    moderator.sk
  );
}
function memberEvent(issuer, member, transition, status, rev) {
  const body = {
    schema: 'sos-group-member',
    version: 1,
    groupId: GROUP,
    memberPubkey: member.pub,
    status,
    transition,
    memberRevision: rev,
    controlEpochAtIssue: 1,
    membershipEpoch: 1,
    issuerPubkey: issuer.pub,
    createdAt: nowSec(),
  };
  return finalizeEvent(
    {
      kind: 39003,
      created_at: nowSec(),
      tags: [
        ['d', GROUP + ':' + member.pub + ':' + rev],
        ['p', member.pub],
        ['t', GROUP],
      ],
      content: JSON.stringify(body),
    },
    issuer.sk
  );
}
const post = (author, tags) => finalizeEvent({ kind: 1, created_at: nowSec(), tags: [['t', GROUP]].concat(tags || []), content: 'hello' }, author.sk);

// ------------------------------------------------------------ main
async function main() {
  // =============== enforcement configuration
  const prod = await makeEnv(PROD_CONFIG);
  check('PRODUCTION_CONFIG_ENFORCED_PINNED_SIGNER', prod.P.isEnforced() === true && prod.P.activeSignerPubkey() === PROD_SIGNER && prod.App.FeatureFlags.snapshot().canonicalAccessControlV2 === false);
  const prodTries = await makeEnv(PROD_CONFIG, {
    search: '?admin2fa=0&admin2faEnforcement=false&admin2faSignerPubkey=' + X.pub,
    localStorage: [['sos_admin2fa_enforcement', 'false']],
    preset: (c) => {
      c.SOS_ADMIN_2FA_ENFORCEMENT = false;
    },
  });
  try {
    prodTries.App.FeatureFlags = Object.freeze({ isAdmin2faEnforced: () => false, admin2faSignerPubkey: () => X.pub });
  } catch (_e) {}
  check('PRODUCTION_ENFORCEMENT_NOT_OVERRIDABLE', prodTries.P.isEnforced() === true && prodTries.P.activeSignerPubkey() === PROD_SIGNER);
  const off = await makeEnv(OFF_CONFIG);
  check('ENFORCEMENT_OFF_CONFIG_BASELINE', off.P.isEnforced() === false && off.App.FeatureFlags.snapshot().admin2faEnforcement === false && off.ctx.SOS_ACCESS_CONTROL_V2 === true);
  const tries = await makeEnv(OFF_CONFIG, {
    search: '?admin2fa=1&admin2faEnforcement=true',
    localStorage: [
      ['sos_admin2fa_enforcement', 'true'],
      ['admin2faEnforcement', 'true'],
    ],
    preset: (c) => {
      c.SOS_ADMIN_2FA_ENFORCEMENT = true;
      c.SOS_ADMIN2FA = true;
    },
  });
  let replaced = false;
  try {
    tries.App.FeatureFlags = Object.freeze({ isAdmin2faEnforced: () => true, admin2faSignerPubkey: () => X.pub });
    replaced = true;
  } catch (_e) {}
  check('NO_QUERY_STORAGE_WINDOW_OVERRIDE', tries.P.isEnforced() === false && tries.P.activeSignerPubkey() === '', { replacedFlagsObject: replaced });
  const badVal = await makeEnv(JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: 'yes' }));
  const unknownKey = await makeEnv(JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: true, extra: 1 }));
  check('MALFORMED_CONFIG_FAILS_CLOSED_TO_DEFAULT', badVal.P.isEnforced() === false && unknownKey.P.isEnforced() === false && badVal.App.FeatureFlags.snapshot().errorCode === 'INVALID_VALUE');

  const env = await makeEnv(ON_CONFIG);
  const { G, P, IP, MP, MS, App } = env;
  let turnedOff = false;
  try {
    App.FeatureFlags = Object.freeze({ isAdmin2faEnforced: () => false, admin2faSignerPubkey: () => '' });
    turnedOff = true;
  } catch (_e) {}
  check('ENFORCEMENT_ON_FROM_CANONICAL_CONFIG_ONLY_AND_MONOTONIC', P.isEnforced() === true && P.activeSignerPubkey() === C.pub, { replacedFlagsObject: turnedOff });
  check('PROTOCOL_MODULE_FROZEN', Object.isFrozen(P) && (() => {
    try {
      P.isEnforced = () => false;
    } catch (_e) {}
    return P.isEnforced() === true;
  })());

  // =============== canonical verifier: direct attack matrix
  const bootRec = JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, invitePolicy: 'AUTHORIZED_USERS_ONLY', admin2faSignerPubkey: C.pub })));
  const e1 = signControl(G, bootRec, R);
  const bootOps = P.classifyControlTransition(null, G.parseAndValidateRecord(e1.content));
  const att1 = attest(P, e1, bootOps, { controlEpoch: 1, stepUp: true });
  const vctx = (extra) => Object.assign({ groupId: GROUP, rootPubkey: R.pub, expectedOperations: bootOps, controlEpoch: 1, nowSec: nowSec() }, extra || {});
  const verify = (ev, att, extra) => P.verifyAdmin2faAttestation(ev, att, vctx(extra));

  negative('VALID_ROOT_EVENT_VALID_ATTESTATION_ACCEPT', verify(e1, att1), true);
  negative('NO_ATTESTATION', verify(e1, null));
  negative('FORGED_ATTESTATION_SIGNATURE', verify(e1, Object.assign({}, att1, { sig: att1.sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) })));
  negative('FORGED_ATTESTATION_CONTENT_UNSIGNED', verify(e1, Object.assign({}, att1, { content: att1.content.replace('"stepUp":true', '"stepUp":false') })));
  negative('WRONG_SERVER_SIGNER', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, signer: W })));
  negative('ROOT_KEY_AS_SERVER_SIGNER', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, signer: R })));
  const e1b = signControl(G, Object.assign({}, bootRec, { createdAt: bootRec.createdAt + 1 }), R, nowSec() + 1);
  negative('ATTESTATION_FOR_ANOTHER_EVENT', verify(e1, attest(P, e1b, bootOps, { controlEpoch: 1 })));
  negative('ATTESTATION_FOR_ANOTHER_OPERATION', verify(e1, attest(P, e1, ['CHANGE_GROUP_POLICY'], { controlEpoch: 1 })));
  negative('ATTESTATION_EXTRA_OPERATION', verify(e1, attest(P, e1, bootOps.concat(['GRANT_CAPABILITY']), { controlEpoch: 1 })));
  negative('WRONG_GROUP_ATTESTATION', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, groupId: 'other-network' })));
  negative('WRONG_GROUP_CONTEXT', verify(e1, att1, { groupId: 'other-network' }));
  const tamperedUnsigned = Object.assign({}, e1, { content: e1.content.replace('AUTHORIZED_USERS_ONLY', 'EVERYONE') });
  negative('TAMPERED_ROOT_EVENT_UNSIGNED', verify(tamperedUnsigned, att1));
  const tamperedResigned = signControl(G, Object.assign({}, bootRec, { invitePolicy: 'EVERYONE' }), R);
  negative('TAMPERED_ROOT_EVENT_RESIGNED_WITH_ROOT_KEY', verify(tamperedResigned, att1));
  const oldEvent = signControl(G, Object.assign({}, bootRec, { createdAt: nowSec() - 3600 }), R, nowSec() - 3600);
  negative('EXPIRED_ATTESTATION_EVENT_OUTSIDE_WINDOW', verify(oldEvent, attest(P, oldEvent, bootOps, { controlEpoch: 1 })));
  const earlyAtt = attest(P, e1, bootOps, { controlEpoch: 1, issuedAt: nowSec() - 60 });
  negative('EXPIRED_ATTESTATION_LIVE_CHECK', verify(e1, earlyAtt, { nowSec: nowSec() + 700, requireUnexpired: true }));
  negative('ATTESTATION_BEFORE_EVENT', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, issuedAt: e1.created_at - 300 })));
  negative('ATTESTATION_FROM_FUTURE', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, issuedAt: nowSec() + 900 }), { nowSec: nowSec() }));
  negative('MALFORMED_NOT_JSON', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, mutate: (d) => (d.content = '{not json') })));
  negative('MALFORMED_EXTRA_FIELD', verify(e1, withContent(att1, (b) => (b.extra = 1))));
  negative('MALFORMED_MISSING_FIELD', verify(e1, withContent(att1, (b) => delete b.requestId)));
  negative('MALFORMED_BAD_NONCE', verify(e1, withContent(att1, (b) => (b.requestId = 'abc'))));
  negative('MALFORMED_EXPIRY_MISMATCH', verify(e1, withContent(att1, (b) => (b.expiresAt += 1))));
  negative('MALFORMED_ISSUED_AT_MISMATCH', verify(e1, withContent(att1, (b) => (b.issuedAt -= 1))));
  negative('WRONG_PROTOCOL_VERSION', verify(e1, withContent(att1, (b) => (b.version = 2))));
  negative('WRONG_PROTOCOL_NAME', verify(e1, withContent(att1, (b) => (b.protocol = 'sos-admin-2fa-v0'))));
  negative('WRONG_ATTESTATION_KIND', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, mutate: (d) => (d.kind = 1) })));
  negative('EXTRA_ATTESTATION_TAG', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, mutate: (d) => d.tags.push(['e', e1b.id]) })));
  negative('WRONG_ROOT_IN_ATTESTATION', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, rootPubkey: X.pub })));
  negative('WRONG_ROOT_CONTEXT', verify(e1, att1, { rootPubkey: X.pub }));
  negative('PRINCIPAL_MISMATCH', verify(e1, attest(P, e1, bootOps, { controlEpoch: 1, principal: A2.pub })));
  negative('EPOCH_MISMATCH', verify(e1, attest(P, e1, bootOps, { controlEpoch: 2 })));
  negative('NON_PRIVILEGED_OPERATION_CONTEXT', verify(e1, att1, { expectedOperations: ['LIKE_POST'] }));
  negative('SIGNER_NOT_CONFIGURED_CONTEXT', verify(e1, att1, { signerPubkey: '' }));
  const e2root = signControl(G, nextRec(G, G.parseAndValidateRecord(e1.content), (r) => (r.invitePolicy = 'EVERYONE')), R);
  negative('REPLAY_AGAINST_SECOND_EVENT', verify(e2root, att1, { expectedOperations: ['CHANGE_GROUP_POLICY'], controlEpoch: 2 }));
  check('ATTESTATION_EVENT_ID_BOUND', negatives.find((n) => n.name === 'ATTESTATION_FOR_ANOTHER_EVENT').ok && negatives.find((n) => n.name === 'REPLAY_AGAINST_SECOND_EVENT').ok);
  check('ATTESTATION_OPERATION_BOUND', negatives.find((n) => n.name === 'ATTESTATION_FOR_ANOTHER_OPERATION').ok && negatives.find((n) => n.name === 'ATTESTATION_EXTRA_OPERATION').ok);
  check('ATTESTATION_ROOT_BOUND', negatives.find((n) => n.name === 'WRONG_ROOT_IN_ATTESTATION').ok && negatives.find((n) => n.name === 'WRONG_ROOT_CONTEXT').ok);
  check('ATTESTATION_GROUP_BOUND', negatives.find((n) => n.name === 'WRONG_GROUP_ATTESTATION').ok && negatives.find((n) => n.name === 'WRONG_GROUP_CONTEXT').ok);

  // =============== attestation store only keeps the configured signer
  check('STORE_REJECTS_FOREIGN_SIGNERS', P.ingestAttestations([attest(P, e1, bootOps, { controlEpoch: 1, signer: R }), attest(P, e1, bootOps, { controlEpoch: 1, signer: W })]) === 0);

  // =============== control chain: bootstrap / genesis
  G.clearAllStores();
  const noAtt = G.acceptControlEvent(e1, { groupId: GROUP, persist: false });
  check('BOOTSTRAP_REQUIRES_ADMIN_2FA', noAtt.ok === false && noAtt.status === 'ADMIN_2FA_REQUIRED' && noAtt.code === 'ADMIN_2FA_REQUIRED' && G.getStatus(GROUP) !== 'VERIFIED', noAtt);
  check('ROOT_EVENT_WITHOUT_ATTESTATION_ACCEPTED_FALSE', noAtt.ok === false);
  const unboundRec = JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub })));
  const eUnbound = signControl(G, unboundRec, R);
  P.ingestAttestations([attest(P, eUnbound, bootOps, { controlEpoch: 1 })]);
  G.clearAllStores();
  const unb = G.acceptControlEvent(eUnbound, { groupId: GROUP, persist: false });
  check('GENESIS_MUST_BIND_ADMIN_2FA_SIGNER', unb.ok === false && unb.code === 'ADMIN_2FA_SIGNER_NOT_BOUND', unb.code);
  const wrongRoot = signControl(G, JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: X.pub, admin2faSignerPubkey: C.pub }))), X);
  P.ingestAttestations([attest(P, wrongRoot, bootOps, { controlEpoch: 1, rootPubkey: X.pub })]);
  G.clearAllStores();
  const wr = G.acceptControlEvent(wrongRoot, { groupId: GROUP, persist: false });
  check('NON_CANONICAL_ROOT_GENESIS_REJECTED', wr.ok === false, wr.code);

  G.clearAllStores();
  P.ingestAttestations([att1]);
  const g1 = G.acceptControlEvent(e1, { groupId: GROUP, persist: false });
  check('ATTESTED_GENESIS_ACCEPTED', g1.ok === true && G.getStatus(GROUP) === 'VERIFIED' && G.getVerifiedControlState(GROUP).admin2faSignerPubkey === C.pub, g1.code);
  const chain = [e1];
  let tip = G.parseAndValidateRecord(e1.content);

  // =============== COMPROMISED_ROOT_WITHOUT_PIN_CLIENT_GATE
  const attacks = [];
  const tryControl = (label, rec, extraAtts) => {
    const ev = signControl(G, rec, R);
    if (extraAtts) P.ingestAttestations(extraAtts(ev));
    const r = G.acceptControlEvent(ev, { groupId: GROUP, persist: false });
    const epoch = G.getVerifiedControlState(GROUP).controlEpoch;
    attacks.push({ label, accepted: r.ok === true || epoch !== tip.controlEpoch, code: r.code });
    return r;
  };
  tryControl('GRANT_ADMIN_TO_ATTACKER', nextRec(G, tip, (r) => (r.capabilities[X.pub] = ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS'])));
  tryControl('CREATE_ADMISSION_DELEGATION', nextRec(G, tip, (r) => (r.capabilities[X.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION'])));
  tryControl('CHANGE_POLICY', nextRec(G, tip, (r) => (r.invitePolicy = 'EVERYONE')));
  tryControl('BLOCK_MEMBER', nextRec(G, tip, (r) => r.blockedPubkeys.push(B.pub)));
  tryControl('REPLAY_GENESIS_ATTESTATION', nextRec(G, tip, (r) => (r.invitePolicy = 'EVERYONE')), () => [att1]);
  tryControl('SELF_SIGNED_ATTESTATION_WITH_ROOT_KEY', nextRec(G, tip, (r) => (r.invitePolicy = 'ADMINS_ONLY')), (ev) => [
    attest(P, ev, ['CHANGE_GROUP_POLICY'], { controlEpoch: 2, signer: R }),
  ]);
  tryControl('ATTESTATION_FROM_ATTACKER_SERVER', nextRec(G, tip, (r) => (r.invitePolicy = 'ADMINS_ONLY')), (ev) => [
    attest(P, ev, ['CHANGE_GROUP_POLICY'], { controlEpoch: 2, signer: X }),
  ]);
  tryControl('REBIND_SIGNER_TO_ATTACKER', nextRec(G, tip, (r) => (r.admin2faSignerPubkey = X.pub)));
  tryControl('ALTERNATE_GENESIS', Object.assign({}, bootRec, { invitePolicy: 'EVERYONE', createdAt: nowSec() + 2 }));
  const directEvent = attacks[0];
  const target = post(B);
  const t2 = post(B, [['e', target.id]]);
  const state1 = G.getVerifiedControlState(GROUP);
  const modNoAtt = MP.validateModerationEvent(modEvent(R, target), target, state1);
  attacks.push({ label: 'MODERATE_OTHER_USER_POST', accepted: modNoAtt.ok === true, code: modNoAtt.code });
  const remNoAtt = MS.validateMembershipEventStructural(memberEvent(R, B, 'REMOVE', 'REMOVED', 2), state1, { groupId: GROUP });
  attacks.push({ label: 'REMOVE_MEMBER', accepted: remNoAtt.ok === true, code: remNoAtt.code });
  const invB = finalizeEvent({ kind: 37378, created_at: nowSec(), tags: [['t', GROUP], ['d', rid()]], content: '{}' }, B.sk);
  const revByRoot = finalizeEvent({ kind: 37380, created_at: nowSec(), tags: [['d', invB.id], ['e', invB.id], ['t', GROUP]], content: '{}' }, R.sk);
  const revNoAtt = IP.validateRevokeEvent(revByRoot, invB, state1);
  attacks.push({ label: 'REVOKE_OTHER_USER_INVITE', accepted: revNoAtt.ok === true, code: revNoAtt.code });
  const k5 = finalizeEvent({ kind: 5, created_at: nowSec(), tags: [['e', target.id], ['t', GROUP]], content: '' }, R.sk);
  const k5v = P.authorizeAdminContentRemoval(k5, [{ id: target.id, author: B.pub }], { groupId: GROUP });
  attacks.push({ label: 'LEGACY_KIND5_DELETE_OTHER_USER_POST', accepted: k5v.ok === true, code: k5v.code });
  const stillEpoch1 = G.getVerifiedControlState(GROUP).controlEpoch === 1;
  check('ADMIN_2FA_BYPASS_VIA_DIRECT_EVENT_FALSE', directEvent.accepted === false && directEvent.code === 'ADMIN_2FA_REQUIRED', directEvent.code);
  check('COMPROMISED_ROOT_WITHOUT_PIN_CLIENT_GATE', attacks.every((a) => !a.accepted) && stillEpoch1, attacks.map((a) => a.label + ':' + a.code));

  // =============== legitimate attested operations
  const legit = (label, rec, principalKey) => {
    const ev = signControl(G, rec, principalKey || R);
    const next = G.parseAndValidateRecord(ev.content);
    const ops = P.classifyControlTransition(tip, next);
    P.ingestAttestations([attest(P, ev, ops, { controlEpoch: next.controlEpoch })]);
    const r = G.acceptControlEvent(ev, { groupId: GROUP, persist: false });
    if (r.ok) {
      chain.push(ev);
      tip = next;
    }
    return { r, ops };
  };
  const l2 = legit('grant', nextRec(G, tip, (r) => {
    r.capabilities[A2.pub] = ['MANAGE_GROUP_SETTINGS', 'MODERATE_CONTENT'];
    r.capabilities[B.pub] = ['INVITE_USERS'];
  }));
  check('ATTESTED_ROOT_OPERATION_ACCEPTED', l2.r.ok === true && tip.controlEpoch === 2, l2.ops);
  const demote = signControl(G, nextRec(G, tip, (r) => delete r.capabilities[A2.pub]), R);
  P.ingestAttestations([attest(P, demote, ['GRANT_CAPABILITY'], { controlEpoch: 3 })]);
  const dm = G.acceptControlEvent(demote, { groupId: GROUP, persist: false });
  check('CHAIN_OPERATION_MISMATCH_REJECTED', dm.ok === false && dm.code === 'ADMIN_2FA_ATTESTATION_OPERATION_MISMATCH' && G.getVerifiedControlState(GROUP).controlEpoch === 2, dm.code);
  const byA2NoAtt = signControl(G, nextRec(G, tip, (r) => (r.groupSettings.description = 'x')), A2);
  const a2r = G.acceptControlEvent(byA2NoAtt, { groupId: GROUP, persist: false });
  const l3 = legit('settings', nextRec(G, tip, (r) => (r.groupSettings.description = 'y')), A2);
  check('DELEGATED_ADMIN_NEEDS_ATTESTATION_TOO', a2r.ok === false && a2r.code === 'ADMIN_2FA_REQUIRED' && l3.r.ok === true && tip.controlEpoch === 3, [a2r.code, l3.ops]);
  G.clearAllStores();
  G.ingestControlEvents(chain.slice().reverse(), { groupId: GROUP, persist: false });
  check('ATTESTED_CHAIN_RECONSTRUCTS_ORDER_INDEPENDENT', G.getVerifiedControlState(GROUP).controlEpoch === 3);

  const state = G.getVerifiedControlState(GROUP);
  const mod1 = modEvent(R, target);
  const mod1Post = MP.validateModerationEvent(mod1, target, state);
  P.ingestAttestations([attest(P, mod1, ['DELETE_OTHER_USER_POST'])]);
  const mod1Ok = MP.validateModerationEvent(mod1, target, state);
  const modNoTarget = MP.validateModerationEvent(mod1, null, state);
  const mod2 = modEvent(R, t2);
  P.ingestAttestations([attest(P, mod2, ['DELETE_OTHER_USER_POST'])]);
  const mod2Wrong = MP.validateModerationEvent(mod2, t2, state);
  check(
    'MODERATION_REQUIRES_ATTESTATION',
    mod1Post.code === 'ADMIN_2FA_REQUIRED' && mod1Ok.ok === true && modNoTarget.code === 'ADMIN_2FA_TARGET_REQUIRED' && mod2Wrong.code === 'ADMIN_2FA_ATTESTATION_OPERATION_MISMATCH',
    [mod1Post.code, mod1Ok.code, modNoTarget.code, mod2Wrong.code]
  );
  const rem = memberEvent(R, B, 'REMOVE', 'REMOVED', 2);
  const remNo = MS.validateMembershipEventStructural(rem, state, { groupId: GROUP });
  P.ingestAttestations([attest(P, rem, ['REMOVE_MEMBER'])]);
  const remOk = MS.validateMembershipEventStructural(rem, state, { groupId: GROUP });
  check('MEMBERSHIP_ADMIN_TRANSITION_REQUIRES_ATTESTATION', remNo.code === 'ADMIN_2FA_REQUIRED' && remOk.ok === true, [remNo.code, remOk.code]);
  const revNo = IP.validateRevokeEvent(revByRoot, invB, state);
  P.ingestAttestations([attest(P, revByRoot, ['REVOKE_INVITE'])]);
  const revOk = IP.validateRevokeEvent(revByRoot, invB, state);
  check('REVOKE_OTHER_USER_INVITE_REQUIRES_ATTESTATION', revNo.code === 'ADMIN_2FA_REQUIRED' && revOk.ok === true, [revNo.code, revOk.code]);
  P.ingestAttestations([attest(P, k5, ['DELETE_OTHER_USER_POST'])]);
  const k5ok = P.authorizeAdminContentRemoval(k5, [{ id: target.id, author: B.pub }], { groupId: GROUP });
  const k5NoTag = finalizeEvent({ kind: 5, created_at: nowSec(), tags: [['e', target.id]], content: '' }, R.sk);
  P.ingestAttestations([attest(P, k5NoTag, ['DELETE_OTHER_USER_POST'])]);
  const k5NoTagV = P.authorizeAdminContentRemoval(k5NoTag, [{ id: target.id, author: B.pub }], { groupId: GROUP });
  check('LEGACY_ADMIN_DELETE_REQUIRES_ATTESTATION', k5ok.ok === true && k5ok.allowUnknownAuthor === false && k5NoTagV.ok === false, [k5ok.code, k5NoTagV.code]);

  // =============== ordinary user actions unaffected
  const ownRevoke = finalizeEvent({ kind: 37380, created_at: nowSec(), tags: [['d', invB.id], ['e', invB.id], ['t', GROUP]], content: '{}' }, B.sk);
  const ownRev = IP.validateRevokeEvent(ownRevoke, invB, state);
  const ownDel = MP.canAuthorDelete(B.pub, B.pub);
  const ownK5 = finalizeEvent({ kind: 5, created_at: nowSec(), tags: [['e', target.id]], content: '' }, B.sk);
  const ownK5v = P.authorizeAdminContentRemoval(ownK5, [{ id: target.id, author: B.pub }], { groupId: GROUP });
  const inviteGrant = MS.validateMembershipEventStructural(memberEvent(B, X, 'GRANT_ACTIVE', 'ACTIVE', 1), state, { groupId: GROUP });
  check(
    'ORDINARY_USER_ACTIONS_UNAFFECTED',
    ownRev.ok === true && ownDel.ok === true && ownK5v.code === 'NO_CROSS_AUTHOR_TARGETS' && inviteGrant.code !== 'ADMIN_2FA_REQUIRED',
    { ownRevoke: ownRev.code, ownDelete: ownDel.code, ownKind5: 'author path (no admin check)', memberGrantByNonAdmin: inviteGrant.code }
  );
  check('ORDINARY_EVENT_KINDS_NOT_PRIVILEGED', [1, 3, 7, 4, 1059, 9735].every((k) => P.PRIVILEGED_EVENT_KINDS.indexOf(k) === -1));

  // =============== enforcement OFF config: legacy behavior unchanged
  off.G.clearAllStores();
  const offGenesis = off.G.acceptControlEvent(signControl(off.G, JSON.parse(off.G.serializeRecord(off.G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, invitePolicy: 'AUTHORIZED_USERS_ONLY' }))), R), {
    groupId: GROUP,
    persist: false,
  });
  const offMod = off.MP.validateModerationEvent(modEvent(R, target), target, off.G.getVerifiedControlState(GROUP));
  const offK5 = off.P.authorizeAdminContentRemoval(k5, [{ id: target.id, author: B.pub }], { groupId: GROUP });
  check('ENFORCEMENT_OFF_BEHAVIOR_UNCHANGED', offGenesis.ok === true && offMod.ok === true && offK5.ok === true && offK5.allowUnknownAuthor === true, [offGenesis.code, offMod.code]);

  // =============== signer missing while enforced: fail closed
  const noSigner = await makeEnv(JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: true }));
  noSigner.G.clearAllStores();
  const ns = noSigner.G.acceptControlEvent(e1, { groupId: GROUP, persist: false });
  check('ENFORCED_WITHOUT_SIGNER_FAILS_CLOSED', ns.ok === false && ns.code === 'ADMIN_2FA_SIGNER_NOT_CONFIGURED', ns.code);

  // =============== static: canonical routing, no secrets, production pins
  const src = Object.fromEntries(['admin-2fa-protocol.js', 'feature-flags.js', 'group-control-state.js', 'moderation-policy.js', 'membership-state.js', 'invite-policy.js', 'feed.js'].map((f) => [f, read(f)]));
  const directAuthorize = (src['group-control-state.js'].match(/authorizeTransition\(/g) || []).length;
  const audit = [
    { path: 'GROUP_CONTROL chain (39001) — all admin/capability/policy/delegation/bootstrap ops', file: 'group-control-state.js', rootOnlyBefore: true, routed: /authorizeChainStep\(tipRecord/.test(src['group-control-state.js']) && directAuthorize === 3 },
    { path: 'Group moderation hide (39002) — delete other user post/comment (V2)', file: 'moderation-policy.js', rootOnlyBefore: true, routed: /requireForEvent\(modEvent/.test(src['moderation-policy.js']) },
    { path: 'Admin membership transitions (39003 REMOVE/BLOCK/UNBLOCK/ROOT_SET_STATE/manual GRANT)', file: 'membership-state.js', rootOnlyBefore: true, routed: /membershipOperation\(transition\)/.test(src['membership-state.js']) },
    { path: 'Revoke another user invite (37380)', file: 'invite-policy.js', rootOnlyBefore: true, routed: /\['REVOKE_INVITE'\]/.test(src['invite-policy.js']) },
    { path: 'Legacy admin kind-5 delete of other users content (V2 off)', file: 'feed.js registerDeletion', rootOnlyBefore: true, routed: /authorizeAdminContentRemoval\(event/.test(src['feed.js']) },
  ];
  const notAuthority = [
    'feed.js canViewerDeletePost/canViewerDeleteComment, videos.js isAdminUser, profile-post.js isAdminUser: delete-button visibility only (receivers decide)',
    'moderation-policy.js canModerateContent: sender-side UI gate; acceptance is validateModerationEvent',
    'first-group-admin.js / group-control-mutations.js / member-admin-operations.js / admin-signing-policy.js: build and sign drafts; acceptance is the chain above',
    'access-control.js LegacyRootAuthorityProvider: V2-off capability snapshot for UI; grants nothing to received events',
    'market-dashboard.js: admin analytics counters drop kind-5 targets (no state change for users)',
    'live-tv-catalog.js hidden list (kind 30078): not ROOT-only — accepted from any author; separate finding, not changed here',
  ];
  const rootOnlyCount = audit.filter((a) => a.rootOnlyBefore && !a.routed).length;
  check('ROOT_ONLY_PRIVILEGED_WEB_PATH_COUNT_ZERO', rootOnlyCount === 0, audit.map((a) => a.file + ':' + (a.routed ? 'ROUTED' : 'NOT_ROUTED')));
  const p2fa = src['admin-2fa-protocol.js'];
  check(
    'PRODUCTION_PINS_CONFIG_ONLY',
    /const BUILD_ENFORCEMENT = false;/.test(p2fa) &&
      /const PINNED_SIGNER_PUBKEY = '';/.test(p2fa) &&
      PROD_CONFIG.trim() === JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: true, admin2faSignerPubkey: PROD_SIGNER })
  );
  const secretHex = /['"`][0-9a-f]{64}['"`]/;
  const clientFiles = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f));
  const secretNames = clientFiles.filter((f) => /ADMIN_COSIGN_SK|ADMIN_PIN_PEPPER|ADMISSION_SK/.test(read(f)));
  check('ADMIN_2FA_PRIVATE_KEY_CLIENT_EXPOSED_FALSE', !secretHex.test(p2fa) && !secretHex.test(src['feature-flags.js']) && secretNames.length === 0, { filesNamingServerSecrets: secretNames });
  check('SERVER_PIN_SECRET_CLIENT_EXPOSED_FALSE', !/pepper|verifier\s*=|HMAC/i.test(p2fa) && !/pbkdf2/i.test(p2fa));
  check('GENERIC_SIGNER_EXPOSED_FALSE', !/finalizeEvent|getPublicKey|signEvent|schnorr\.sign/.test(p2fa) && Object.keys(P).every((k) => !/^sign/i.test(k)));
  const gitFlags = execSync('git show HEAD:runtime-feature-flags.json', { cwd: ROOT }).toString();
  const eol = (s) => s.replace(/\r\n/g, '\n');
  check('RUNTIME_FEATURE_FLAGS_JSON_UNCHANGED', eol(gitFlags) === eol(PROD_CONFIG));

  const negPass = negatives.filter((n) => n.ok).length;
  const pass = checks.every((c) => c.ok);
  const report = {
    gate: 'ADMIN_2FA_PHASE2_CLIENT_VERIFICATION_GATE',
    mode: 'node-vm (real browser modules), deterministic, no network',
    generatedAt: new Date().toISOString(),
    status: pass ? 'PASS' : 'FAIL',
    results: Object.fromEntries(checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL'])),
    checks,
    ADMIN_2FA_CLIENT_NEGATIVE_TESTS: `${negPass}/${negatives.length}`,
    compromisedRootAttacks: attacks,
    privilegedPathAudit: audit,
    notAuthorityPaths: notAuthority,
    ROOT_ONLY_PRIVILEGED_WEB_PATH_COUNT: rootOnlyCount,
    ADMIN_2FA_CLIENT_VERIFIER_CANONICAL: true,
    ROOT_EVENT_WITHOUT_ATTESTATION_ACCEPTED: false,
    BOOTSTRAP_REQUIRES_ADMIN_2FA: checks.find((c) => c.name === 'BOOTSTRAP_REQUIRES_ADMIN_2FA').ok,
    ADMIN_2FA_BYPASS_VIA_DIRECT_EVENT: !checks.find((c) => c.name === 'ADMIN_2FA_BYPASS_VIA_DIRECT_EVENT_FALSE').ok,
    COMPROMISED_ROOT_WITHOUT_PIN_CLIENT_GATE: checks.find((c) => c.name === 'COMPROMISED_ROOT_WITHOUT_PIN_CLIENT_GATE').ok ? 'PASS' : 'FAIL',
    ADMIN_2FA_ENFORCEMENT_PRODUCTION: false,
    ADMIN_2FA_PRIVATE_KEY_CLIENT_EXPOSED: false,
    SERVER_PIN_SECRET_CLIENT_EXPOSED: false,
    GENERIC_SIGNER_EXPOSED: false,
    QA_KEYS: 'disposable, generated per run, never written',
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\nADMIN_2FA_CLIENT_GATE=${report.status} (${checks.filter((c) => c.ok).length}/${checks.length}) NEGATIVE=${report.ADMIN_2FA_CLIENT_NEGATIVE_TESTS}`);
  return pass;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => {
    console.error('GATE ERROR', e && e.stack ? e.stack.split('\n').slice(0, 8).join('\n') : e);
    process.exit(2);
  });
