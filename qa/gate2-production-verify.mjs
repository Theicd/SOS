/**
 * Gate 2 production verification (read-only). Reads the canonical relays and the admission service health, rebuilds
 * the control chain with the canonical modules (admission-service shim) and the live runtime-feature-flags.json.
 * Modes: `pre`  = pre-delegation readback (exactly one attested genesis, no delegation, no conflict);
 *        `post` = delegation readback per relay + independent verify + service view + negatives on the real events.
 * Publishes nothing. Negative events are signed with disposable keys only.
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
const SERVICE = '752f47fa926d1833a451bdc97f3f2967ae4bc6452d0356bc7919c6928e4611ef';
const SERVICE_URL = 'https://sos-first-group-admission.dror201031-b16.workers.dev';
const ADM = 'FINALIZE_MEMBERSHIP_ADMISSION';
const PROD_RELAYS = ['wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh'];
const mode = process.argv[2] === 'post' ? 'post' : 'pre';

const flags = await (await fetch('https://sos010.com/runtime-feature-flags.json?ts=' + Date.now())).json();
await import('../admission-service/src/shim.js');
const App = globalThis.NostrApp;
App.adminSourceKeys = [ROOT];
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
const now = () => Math.floor(Date.now() / 1000);

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
  const chain = tip ? G.getVerifiedControlChain(GROUP) : [];
  return {
    status,
    tip,
    tipId: tipEv ? tipEv.id : null,
    chain: chain.map((r) => ({ id: r.eventId, epoch: r.controlEpoch })),
    conflicts: (G.getConflictCandidates() || []).length,
    service: G.admissionDelegateInfo(SERVICE, GROUP),
    delegates: G.activeAdmissionDelegates(GROUP),
  };
}
const attFor = (atts, id) => atts.filter((a) => (a.tags.find((t) => t[0] === 'e') || [])[1] === id);
const expectPost = (ev) =>
  ev.status === 'VERIFIED' &&
  ev.tip.controlEpoch === 2 &&
  ev.tip.rootAdminPubkey === ROOT &&
  ev.tip.admin2faSignerPubkey === SIGNER &&
  JSON.stringify(ev.tip.capabilities) === JSON.stringify({ [SERVICE]: [ADM] }) &&
  ev.service.active === true &&
  ev.conflicts === 0;
const expectPre = (ev) =>
  ev.status === 'VERIFIED' && ev.tip.controlEpoch === 1 && ev.tip.rootAdminPubkey === ROOT && ev.tip.admin2faSignerPubkey === SIGNER && Object.keys(ev.tip.capabilities).length === 0 && ev.conflicts === 0;

const FILTERS = [{ kinds: [39001, 39003, 39004], '#t': [GROUP], limit: 2000 }];
const perRelay = [];
const all = new Map();
for (const url of PROD_RELAYS) {
  const r = await queryWithRetry(url, FILTERS);
  r.events.forEach((e) => all.set(e.id, e));
  const ev = evaluate(r.events);
  const control = r.events.filter((e) => e.kind === 39001);
  const del = control.find((e) => {
    try {
      return JSON.parse(e.content).controlEpoch === 2;
    } catch (_e) {
      return false;
    }
  });
  const delAtt = del ? attFor(r.events.filter((e) => e.kind === 39004), del.id) : [];
  perRelay.push({
    relay: url,
    eose: r.ok,
    code: r.code,
    control39001: control.length,
    attestations39004: r.events.filter((e) => e.kind === 39004).length,
    membership39003: r.events.filter((e) => e.kind === 39003).length,
    delegation: del ? 'FOUND' : 'NOT_FOUND',
    delegationEventId: del ? del.id : null,
    delegationAttestation: delAtt.length ? 'FOUND' : 'NOT_FOUND',
    tipEventId: ev.tipId,
    verification: (mode === 'post' ? expectPost(ev) : expectPre(ev)) ? 'PASS' : 'FAIL',
  });
}
const events = Array.from(all.values());
const control = events.filter((e) => e.kind === 39001);
const atts = events.filter((e) => e.kind === 39004);
const indep = evaluate(events);
const genesis = indep.chain[0] ? control.find((e) => e.id === indep.chain[0].id) : null;
const delegation = indep.chain[1] ? control.find((e) => e.id === indep.chain[1].id) : null;
const dAtts = delegation ? attFor(atts, delegation.id) : [];
const dAttV = delegation && dAtts[0]
  ? P.verifyAdmin2faAttestation(delegation, dAtts[0], { groupId: GROUP, rootPubkey: ROOT, signerPubkey: SIGNER, expectedOperations: ['CREATE_ADMISSION_DELEGATION'], controlEpoch: 2 })
  : { ok: false, code: 'NO_ATTESTATION' };
const dAttBody = dAtts[0] ? JSON.parse(dAtts[0].content) : {};

let health = null;
try {
  await fetch(SERVICE_URL + '/v1/control/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: GROUP }) });
  health = await (await fetch(SERVICE_URL + '/v1/health')).json();
} catch (_e) {
  health = null;
}

const tip = indep.tip || {};
const summary = {
  mode,
  flags: { accessControlV2: flags.accessControlV2, admin2faEnforcement: flags.admin2faEnforcement, admin2faSignerPubkey: flags.admin2faSignerPubkey },
  perRelay,
  INDEPENDENT_CONTROL_STATUS: indep.status === 'VERIFIED' ? 'ACTIVE' : indep.status,
  BOOTSTRAP_EVENT_ID: genesis ? genesis.id : null,
  CONTROL_TIP_EVENT_ID: indep.tipId,
  CONTROL_EPOCH: tip.controlEpoch ?? null,
  MEMBERSHIP_EPOCH: tip.membershipEpoch ?? null,
  ROOT: tip.rootAdminPubkey || null,
  ADMIN_2FA_SIGNER: tip.admin2faSignerPubkey || null,
  CAPABILITIES: tip.capabilities || null,
  CONTROL_EVENTS_TOTAL: control.length,
  CONFLICTS: indep.conflicts,
  ACTIVE_ADMISSION_DELEGATES: indep.delegates,
  DELEGATION_ACTIVE: indep.service.active === true,
  DELEGATION_EVENT_ID: delegation ? delegation.id : null,
  DELEGATION_ATTESTATION_ID: dAtts[0] ? dAtts[0].id : null,
  DELEGATION_ATTESTATION_VERIFY: dAttV.code || (dAttV.ok ? 'OK' : 'FAIL'),
  DELEGATION_ATTESTATION_OPERATIONS: dAttBody.operations || null,
  DELEGATION_ATTESTATION_STEP_UP: dAttBody.stepUp === true,
  service: health
    ? {
        controlPlane: health.controlPlane,
        controlStatus: health.controlStatus,
        bootstrapEventId: health.bootstrapEventId,
        controlTipEventId: health.controlTipEventId,
        controlEpoch: health.controlEpoch,
        controlRootPubkey: health.controlRootPubkey,
        admin2faEnforced: health.admin2faEnforced,
        admin2faSignerPubkey: health.admin2faSignerPubkey,
        servicePubkey: health.servicePubkey,
        delegationActive: health.delegationActive,
        delegatedCapabilities: health.delegatedCapabilities,
        lastRelayRefresh: health.lastRelayRefresh,
      }
    : null,
};

if (mode === 'post') {
  const neg = [];
  const add = (name, ok, detail) => neg.push({ name, ok: !!ok, detail });
  if (genesis && delegation && dAtts[0]) {
    const gAtt = attFor(atts, genesis.id)[0];
    const X = NT.generateSecretKey();
    const xPk = NT.getPublicKey(X);
    const run = (evs, attList) => {
      G.clearAllStores();
      P.clearAttestations();
      P.ingestAttestations(attList);
      G.ingestControlEvents(evs, { groupId: GROUP, persist: false });
      return { status: G.getStatus(GROUP), active: G.admissionDelegateInfo(SERVICE, GROUP).active === true, epoch: (G.getVerifiedControlState(GROUP) || {}).controlEpoch };
    };
    const r0 = run([genesis, delegation], [gAtt, dAtts[0]]);
    add('REAL_DELEGATION_WITH_ATTESTATION_ACTIVE', r0.active && r0.epoch === 2, r0);
    const r1 = run([genesis, delegation], [gAtt]);
    add('DELEGATION_WITHOUT_ATTESTATION_NOT_ACCEPTED', !r1.active && r1.epoch === 1, r1);
    const forged = NT.finalizeEvent({ kind: 39004, created_at: dAtts[0].created_at, tags: dAtts[0].tags, content: dAtts[0].content }, X);
    const r2 = run([genesis, delegation], [gAtt, forged]);
    add('FORGED_ATTESTATION_REJECTED', !r2.active, r2);
    const body = JSON.parse(delegation.content);
    const sign = (patch, tags) =>
      NT.finalizeEvent({ kind: 39001, created_at: now(), tags: tags || delegation.tags, content: JSON.stringify(Object.assign({}, body, { createdAt: now() }, patch || {})) }, X);
    const r3 = run([genesis, delegation, sign({ capabilities: { [xPk]: [ADM] } })], [gAtt, dAtts[0]]);
    add('NON_ROOT_CONFLICTING_DELEGATION_IGNORED', r3.status === 'VERIFIED' && r3.active && r3.epoch === 2, r3);
    const r4 = run([genesis, sign({ capabilities: { [SERVICE]: [ADM] } })], [gAtt]);
    add('NON_ROOT_DELEGATION_TO_SERVICE_REJECTED', !r4.active, r4);
    const r5 = P.verifyAdmin2faAttestation(sign({ capabilities: { [xPk]: [ADM] } }), dAtts[0], { groupId: GROUP, rootPubkey: ROOT, signerPubkey: SIGNER, expectedOperations: ['CREATE_ADMISSION_DELEGATION'], controlEpoch: 2 });
    add('ATTESTATION_BOUND_TO_OTHER_EVENT_REJECTED', !r5.ok, r5.code);
    const r6 = P.verifyAdmin2faAttestation(delegation, dAtts[0], { groupId: 'other-network', rootPubkey: ROOT, signerPubkey: SIGNER, expectedOperations: ['CREATE_ADMISSION_DELEGATION'], controlEpoch: 2 });
    add('WRONG_GROUP_REJECTED', !r6.ok, r6.code);
    run([genesis, delegation], [gAtt, dAtts[0]]);
    add('WRONG_SERVICE_PUBKEY_NOT_DELEGATED', G.admissionDelegateInfo(xPk, GROUP).active === false, null);
    const r8 = run([genesis, delegation, sign({ controlEpoch: 3, capabilities: {} }, [['d', GROUP + ':3'], ['t', GROUP], ['sos-control', 'v1']])], [gAtt, dAtts[0]]);
    add('NON_ROOT_REVOCATION_REJECTED', r8.active && r8.epoch === 2, r8);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./gate2-negatives.mjs', import.meta.url))], { encoding: 'utf8' });
    const m = /GATE2_NEGATIVE_GATE=(PASS|FAIL) \((\d+)\/(\d+)\)/.exec(String(child.stdout || ''));
    add('AUTHORITY_NEGATIVES_DISPOSABLE_CHAIN', !!m && m[1] === 'PASS', m ? m[0] : 'NO_RESULT');
  } else {
    add('DELEGATION_PRESENT', false, 'no verified delegation on relays');
  }
  summary.negative = neg;
  summary.GATE2_NEGATIVE_GATE = neg.length && neg.every((n) => n.ok) ? 'PASS' : 'FAIL';
}
fs.writeFileSync(new URL('./gate2-production-' + mode + '-report.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
