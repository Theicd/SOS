/**
 * Gate 1.5 production verification (read-only). Reads the canonical relays, rebuilds the control chain with the
 * canonical modules (admission-service shim) and the live production runtime-feature-flags.json, and runs the
 * negative checks against the published genesis. Publishes nothing. Negative events are signed with disposable keys.
 * Modes: (none) = readback + independent verify + negatives; `selfgrant` = self-grant rule with a disposable root.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../admission-service/package.json', import.meta.url));
const NT = require('nostr-tools');
const GROUP = 'israel-network';
const ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const SIGNER = '74c4bb0fb6b87b69cc2a95a80b4b5fa616cde3f917ef1894594606d30062edfa';
const PROD_RELAYS = ['wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh'];
const mode = process.argv[2] || '';

const flags =
  mode === 'selfgrant'
    ? { admin2faEnforcement: true, admin2faSignerPubkey: SIGNER }
    : await (await fetch('https://sos010.com/runtime-feature-flags.json?ts=' + Date.now())).json();
const testRoot = mode === 'selfgrant' ? NT.generateSecretKey() : null;
await import('../admission-service/src/shim.js');
const App = globalThis.NostrApp;
App.adminSourceKeys = [testRoot ? NT.getPublicKey(testRoot) : ROOT];
App.FeatureFlags = Object.freeze({
  isAdmin2faEnforced: () => flags.admin2faEnforcement === true,
  admin2faSignerPubkey: () => String(flags.admin2faSignerPubkey || ''),
});
await import('../nostr-event-integrity.js');
await import('../group-control-state.js');
await import('../invite-policy.js');
await import('../moderation-policy.js');
await import('../membership-state.js');
await import('../admin-2fa-protocol.js');
const G = App.GroupControlState;
const P = App.Admin2faProtocol;
const MS = App.MembershipState;
const now = () => Math.floor(Date.now() / 1000);

if (mode === 'selfgrant') {
  // Disposable root + disposable signer: genesis is attested locally, then the root tries to grant itself membership.
  const rootPk = NT.getPublicKey(testRoot);
  const signerSk = NT.generateSecretKey();
  const t = now();
  const rec = JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: rootPk, invitePolicy: 'AUTHORIZED_USERS_ONLY', admin2faSignerPubkey: SIGNER })));
  rec.createdAt = t;
  const genesis = NT.finalizeEvent({ kind: 39001, created_at: t, tags: [['d', GROUP + ':1'], ['t', GROUP], ['sos-control', 'v1']], content: JSON.stringify(rec) }, testRoot);
  const draft = P.buildAttestationDraft({ groupId: GROUP, rootPubkey: rootPk, event: genesis, operations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1, principal: rootPk, stepUp: false, issuedAt: t, requestId: NT.getPublicKey(NT.generateSecretKey()) });
  // Signer pin is the production key, so a disposable signer cannot attest: this proves genesis stays unverified too.
  const fakeAtt = NT.finalizeEvent(draft, signerSk);
  G.clearAllStores();
  P.clearAttestations();
  P.ingestAttestations([fakeAtt]);
  const g1 = G.acceptControlEvent(genesis, { groupId: GROUP, persist: false });
  // Rule check on the membership layer itself, against the (unattested) record shape.
  const state = Object.assign({ verified: true, eventId: genesis.id }, rec);
  const out = {};
  for (const transition of ['GRANT_ACTIVE', 'BOOTSTRAP_ACTIVE']) {
    const body = { schema: 'sos-group-member', version: 1, groupId: GROUP, memberPubkey: rootPk, status: 'ACTIVE', transition, memberRevision: 1, controlEpochAtIssue: 1, membershipEpoch: 1, issuerPubkey: rootPk, createdAt: t };
    const ev = NT.finalizeEvent({ kind: 39003, created_at: t, tags: [['d', GROUP + ':' + rootPk + ':1'], ['p', rootPk], ['t', GROUP]], content: JSON.stringify(body) }, testRoot);
    const r = MS.validateMembershipEventStructural(ev, state, { groupId: GROUP });
    out[transition] = r && r.code;
  }
  console.log(JSON.stringify({ genesisWithForeignSigner: g1.code || g1.status, selfGrant: out }));
  process.exit(0);
}

const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
useWebSocketImplementation(require('ws'));

async function queryRelay(url, filters, ms = 9000) {
  let relay;
  try {
    relay = await Relay.connect(url);
  } catch (_e) {
    return { url, ok: false, code: 'CONNECT_FAILED', events: [] };
  }
  return new Promise((resolve) => {
    const events = [];
    let done = false;
    const finish = (ok, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        relay.close();
      } catch (_e) {}
      resolve({ url, ok, code, events });
    };
    const timer = setTimeout(() => finish(false, 'TIMEOUT'), ms);
    relay.subscribe(filters, { eoseTimeout: ms + 5000, onevent: (e) => events.push(e), oneose: () => finish(true, 'EOSE'), onclose: (r) => finish(false, 'CLOSED:' + String(r || '').slice(0, 40)) });
  });
}
async function queryWithRetry(url, filters) {
  let r = await queryRelay(url, filters);
  for (let i = 0; i < 2 && !r.ok; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    r = await queryRelay(url, filters);
  }
  return r;
}
function evaluate(events) {
  G.clearAllStores();
  P.clearAttestations();
  P.ingestAttestations(events.filter((e) => e.kind === 39004));
  const control = events.filter((e) => e.kind === 39001);
  if (control.length) G.ingestControlEvents(control, { groupId: GROUP });
  const status = G.getStatus(GROUP);
  const tip = status === 'VERIFIED' ? G.getVerifiedControlState(GROUP) : null;
  const tipEv = tip ? G.getVerifiedControlEvent(GROUP) : null;
  return { status, tip, tipId: tipEv ? tipEv.id : null, conflicts: (G.getConflictCandidates() || []).length };
}

const FILTERS = [{ kinds: [39001, 39003, 39004], '#t': [GROUP], limit: 2000 }];
const perRelay = [];
const all = new Map();
for (const url of PROD_RELAYS) {
  const r = await queryWithRetry(url, FILTERS);
  r.events.forEach((e) => all.set(e.id, e));
  const control = r.events.filter((e) => e.kind === 39001);
  const ev = evaluate(r.events);
  perRelay.push({
    relay: url,
    eose: r.ok,
    code: r.code,
    genesis: control.length ? 'FOUND' : 'NOT_FOUND',
    control39001: control.length,
    attestations39004: r.events.filter((e) => e.kind === 39004).length,
    membership39003: r.events.filter((e) => e.kind === 39003).length,
    eventId: ev.tipId,
    verification: ev.status === 'VERIFIED' && ev.tip.controlEpoch === 1 && ev.tip.rootAdminPubkey === ROOT && ev.tip.admin2faSignerPubkey === SIGNER ? 'PASS' : 'FAIL',
  });
}
const events = Array.from(all.values());
const control = events.filter((e) => e.kind === 39001);
const atts = events.filter((e) => e.kind === 39004);
const indep = evaluate(events);
const genesis = control.find((e) => e.id === indep.tipId) || null;
const gAtts = genesis ? atts.filter((a) => (a.tags.find((t) => t[0] === 'e') || [])[1] === genesis.id) : [];
const attV = genesis && gAtts[0]
  ? P.verifyAdmin2faAttestation(genesis, gAtts[0], { groupId: GROUP, rootPubkey: ROOT, signerPubkey: SIGNER, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1 })
  : { ok: false, code: 'NO_ATTESTATION' };
const tip = indep.tip || {};
const summary = {
  flags: { accessControlV2: flags.accessControlV2, admin2faEnforcement: flags.admin2faEnforcement, admin2faSignerPubkey: flags.admin2faSignerPubkey },
  perRelay,
  INDEPENDENT_CONTROL_STATUS: indep.status === 'VERIFIED' ? 'ACTIVE' : indep.status === 'MISSING' ? 'MISSING' : 'INVALID',
  BOOTSTRAP_EVENT_ID: indep.tipId,
  ADMIN_2FA_ATTESTATION_ID: gAtts[0] ? gAtts[0].id : null,
  ROOT: tip.rootAdminPubkey || null,
  CONTROL_EPOCH: tip.controlEpoch ?? null,
  MEMBERSHIP_EPOCH: tip.membershipEpoch ?? null,
  ADMIN_2FA_SIGNER: tip.admin2faSignerPubkey || null,
  CAPABILITIES: tip.capabilities || null,
  ATTESTATION_VERIFY: attV.code,
  control39001Total: control.length,
  membership39003Total: events.filter((e) => e.kind === 39003).length,
  conflicts: indep.conflicts,
  DELEGATION_ACTIVE: Object.values(tip.capabilities || {}).some((c) => (c || []).some((x) => /ADMISSION/.test(x))),
};

// ---- negatives against the published genesis (disposable keys; nothing is published)
const neg = [];
const add = (name, ok, detail) => neg.push({ name, ok: !!ok, detail });
if (genesis && gAtts[0]) {
  const att = gAtts[0];
  const body = JSON.parse(genesis.content);
  const X = NT.generateSecretKey();
  const xPk = NT.getPublicKey(X);
  const one = (ev, attList, groupId) => {
    G.clearAllStores();
    P.clearAttestations();
    if (attList) P.ingestAttestations(attList);
    const r = G.acceptControlEvent(ev, { groupId: groupId || GROUP, persist: false });
    return { ok: !!r.ok, code: r.code || r.status };
  };
  const sign = (patch, tags) =>
    NT.finalizeEvent({ kind: 39001, created_at: now(), tags: tags || [['d', GROUP + ':1'], ['t', GROUP], ['sos-control', 'v1']], content: JSON.stringify(Object.assign({}, body, { createdAt: now() }, patch || {})) }, X);
  const r0 = one(genesis, [att]);
  add('REAL_GENESIS_WITH_ATTESTATION_ACCEPTED', r0.ok, r0);
  const r1 = one(genesis, []);
  add('ROOT_BOOTSTRAP_WITHOUT_ATTESTATION_REJECTED', !r1.ok, r1);
  const r2 = one(sign({ rootAdminPubkey: xPk }), []);
  add('BOOTSTRAP_WRONG_ROOT_REJECTED', !r2.ok, r2);
  const r3 = one(genesis, [att], 'other-network');
  const wg = Object.assign({}, genesis, { content: JSON.stringify(Object.assign({}, body, { groupId: 'other-network' })) });
  const r3b = one(wg, [att]);
  add('BOOTSTRAP_WRONG_GROUP_REJECTED', !r3.ok && !r3b.ok, [r3, r3b]);
  const ws = Object.assign({}, genesis, { content: JSON.stringify(Object.assign({}, body, { admin2faSignerPubkey: xPk })) });
  const r4 = one(ws, [att]);
  const r4b = P.verifyAdmin2faAttestation(genesis, att, { groupId: GROUP, rootPubkey: ROOT, signerPubkey: xPk, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1 });
  add('BOOTSTRAP_WRONG_ADMIN_2FA_SIGNER_REJECTED', !r4.ok && !r4b.ok, [r4, r4b.code]);
  const forged = NT.finalizeEvent({ kind: 39004, created_at: att.created_at, tags: att.tags, content: att.content }, X);
  const r5 = one(genesis, [forged]);
  add('FORGED_ATTESTATION_REJECTED', !r5.ok, r5);
  const other = sign({ rootAdminPubkey: xPk, groupSettings: { displayName: 'X', networkTag: GROUP } });
  const r6 = P.verifyAdmin2faAttestation(other, att, { groupId: GROUP, rootPubkey: ROOT, signerPubkey: SIGNER, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1 });
  add('ATTESTATION_BOUND_TO_DIFFERENT_EVENT_REJECTED', !r6.ok, r6.code);
  G.clearAllStores();
  P.clearAttestations();
  P.ingestAttestations([att]);
  G.acceptControlEvent(genesis, { groupId: GROUP, persist: false });
  G.acceptControlEvent(sign({ rootAdminPubkey: xPk, invitePolicy: 'EVERYONE' }), { groupId: GROUP, persist: false });
  G.acceptControlEvent(sign({ controlEpoch: 2, rootAdminPubkey: xPk }, [['d', GROUP + ':2'], ['t', GROUP], ['sos-control', 'v1']]), { groupId: GROUP, persist: false });
  const t7 = G.getVerifiedControlState(GROUP);
  const e7 = G.getVerifiedControlEvent(GROUP);
  add('SECOND_COMPETING_GENESIS_IGNORED', G.getStatus(GROUP) === 'VERIFIED' && e7 && e7.id === genesis.id, { status: G.getStatus(GROUP) });
  add('ROOT_REPLACEMENT_REJECTED', t7 && t7.controlEpoch === 1 && t7.rootAdminPubkey === ROOT, { epoch: t7 && t7.controlEpoch, root: t7 && t7.rootAdminPubkey });
  const sg = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'selfgrant'], { encoding: 'utf8' });
  let sgOut = null;
  try {
    sgOut = JSON.parse(String(sg.stdout || '').trim().split('\n').pop());
  } catch (_e) {}
  add('SELF_GRANT_ROOT_MEMBERSHIP_REJECTED', !!sgOut && Object.values(sgOut.selfGrant).every((c) => c === 'SELF_GRANT'), sgOut);
} else {
  add('GENESIS_PRESENT', false, 'no verified genesis on relays');
}
summary.negative = neg;
summary.GATE15_NEGATIVE_GATE = neg.length && neg.every((n) => n.ok) ? 'PASS' : 'FAIL';
fs.writeFileSync(new URL('./gate15-production-verify-report.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
