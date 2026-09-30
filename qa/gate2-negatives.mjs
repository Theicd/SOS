/**
 * Gate 2 negative gate (offline, canonical modules through the admission-service shim, Admin 2FA enforced).
 * Builds a disposable chain: root R, Admin 2FA signer S, admission service SVC; genesis + delegation of exactly
 * FINALIZE_MEMBERSHIP_ADMISSION to SVC, both attested by S. Then proves the delegate cannot do anything else and
 * that malformed / unattested / conflicting / revoked delegations never make SVC active. Every negative has a
 * positive control signed by the root, so a rejection is an authority rejection, not a malformed event.
 * Publishes nothing; keys are generated per run and never printed.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../admission-service/package.json', import.meta.url));
const NT = require('nostr-tools');
const GROUP = 'israel-network';
const ADM = 'FINALIZE_MEMBERSHIP_ADMISSION';
const mk = () => {
  const sk = NT.generateSecretKey();
  return { sk, pk: NT.getPublicKey(sk) };
};
const R = mk();
const S = mk();
const SVC = mk();
const X = mk();
const Y = mk();

await import('../admission-service/src/shim.js');
const App = globalThis.NostrApp;
App.adminSourceKeys = [R.pk];
App.FeatureFlags = Object.freeze({ isAdmin2faEnforced: () => true, admin2faSignerPubkey: () => S.pk });
await import('../nostr-event-integrity.js');
await import('../group-control-state.js');
await import('../invite-policy.js');
await import('../moderation-policy.js');
await import('../membership-state.js');
await import('../admin-2fa-protocol.js');
await import('../admin-signing-policy.js');
const G = App.GroupControlState;
const P = App.Admin2faProtocol;
const MS = App.MembershipState;
const IP = App.InvitePolicy;
const MP = App.ModerationPolicy;
const SP = App.AdminSigningPolicy;
let clock = Math.floor(Date.now() / 1000) - 600;
const tick = () => ++clock;

const tagsFor = (epoch, group) => [['d', (group || GROUP) + ':' + epoch], ['t', group || GROUP], ['sos-control', 'v1']];
const signControl = (key, rec, group) => {
  const t = tick();
  const body = Object.assign({}, rec, { createdAt: t });
  return NT.finalizeEvent({ kind: 39001, created_at: t, tags: tagsFor(body.controlEpoch, group), content: JSON.stringify(body) }, key.sk);
};
const attest = (ev, ops, epoch, signerKey, stepUp) => {
  const t = tick();
  const d = P.buildAttestationDraft({
    groupId: GROUP,
    rootPubkey: R.pk,
    event: ev,
    operations: ops,
    controlEpoch: epoch,
    principal: R.pk,
    stepUp: stepUp !== false,
    issuedAt: t,
    requestId: NT.getPublicKey(NT.generateSecretKey()),
  });
  return NT.finalizeEvent(d, (signerKey || S).sk);
};

const genesisRec = JSON.parse(
  G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pk, creatorPubkey: R.pk, displayName: 'SOS', invitePolicy: 'AUTHORIZED_USERS_ONLY', admin2faSignerPubkey: S.pk }))
);
const genesis = signControl(R, genesisRec);
const gAtt = attest(genesis, ['BOOTSTRAP_GROUP_CONTROL'], 1, S, false);
const recAt = (prev, patch) => Object.assign(JSON.parse(JSON.stringify(prev)), patch);
const delRec = recAt(genesisRec, { controlEpoch: 2, capabilities: { [SVC.pk]: [ADM] } });
const delegation = signControl(R, delRec);
const dAtt = attest(delegation, ['CREATE_ADMISSION_DELEGATION'], 2);

function load(events, atts) {
  G.clearAllStores();
  P.clearAttestations();
  P.ingestAttestations(atts || []);
  G.ingestControlEvents(events, { groupId: GROUP, persist: false });
  return G.getStatus(GROUP);
}
function base() {
  return load([genesis, delegation], [gAtt, dAtt]);
}
const tipState = () => G.getVerifiedControlState(GROUP);
const svcInfo = () => G.admissionDelegateInfo(SVC.pk, GROUP);

const results = [];
const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

// ---- baseline: the real two-step chain is accepted and SVC holds exactly one capability
const b0 = base();
const st0 = tipState();
add('BASELINE_DELEGATION_ACTIVE', b0 === 'VERIFIED' && st0.controlEpoch === 2 && svcInfo().active === true, { status: b0, epoch: st0 && st0.controlEpoch });
add('DELEGATED_CAPABILITY_COUNT_1', JSON.stringify(st0.capabilities[SVC.pk]) === JSON.stringify([ADM]), st0.capabilities[SVC.pk]);
add('ROOT_OWNER_IMMUTABLE_AFTER_DELEGATION', st0.rootAdminPubkey === R.pk, null);

// ---- service-signed control events (even with a valid S attestation) are rejected
const svcControl = {
  PROMOTE_ADMIN: { capabilities: { [SVC.pk]: [ADM], [X.pk]: ['MANAGE_ADMINS'] } },
  DEMOTE_ADMIN: { capabilities: { [SVC.pk]: [ADM] } },
  CHANGE_PERMISSIONS: { capabilities: { [SVC.pk]: [ADM], [X.pk]: ['MODERATE_CONTENT'] } },
  REMOVE_MEMBER_BLOCKLIST: { blockedPubkeys: [X.pk] },
  CHANGE_POLICY: { invitePolicy: 'ADMINS_ONLY' },
  REPLACE_ROOT: { rootAdminPubkey: SVC.pk },
  SELF_GRANT_MORE: { capabilities: { [SVC.pk]: [ADM, 'MANAGE_MEMBERS'].sort() } },
  DELEGATE_ONWARD: { capabilities: { [SVC.pk]: [ADM], [Y.pk]: [ADM] } },
  CHANGE_SIGNER: { admin2faSignerPubkey: X.pk },
};
for (const [name, patch] of Object.entries(svcControl)) {
  base();
  const rec = recAt(delRec, Object.assign({ controlEpoch: 3 }, patch));
  const ev = signControl(SVC, rec);
  const preview = G.previewControlTransition(ev, { groupId: GROUP });
  P.ingestAttestations([attest(ev, ['GRANT_CAPABILITY'], 3)]);
  const acc = G.acceptControlEvent(ev, { groupId: GROUP, persist: false });
  const st = tipState();
  add('SERVICE_CANNOT_' + name, !preview.ok && !acc.ok && st.controlEpoch === 2 && st.rootAdminPubkey === R.pk, { preview: preview.code, accept: acc.code || acc.status });
}
// Positive control: the same shape signed by the root (attested) is accepted by the chain rules.
base();
const rootPromote = signControl(R, recAt(delRec, { controlEpoch: 3, capabilities: { [SVC.pk]: [ADM], [X.pk]: ['MANAGE_ADMINS'] } }));
P.ingestAttestations([attest(rootPromote, ['GRANT_CAPABILITY', 'PROMOTE_ADMIN'], 3)]);
const rp = G.acceptControlEvent(rootPromote, { groupId: GROUP, persist: false });
add('CONTROL_ROOT_SAME_CHANGE_ACCEPTED', rp.ok, rp.code || rp.status);

// ---- typed signing policy: the delegate cannot build any control operation
base();
const typedOps = [
  ['GRANT_CAPABILITY', { targetPubkey: X.pk, capability: 'MANAGE_ADMINS' }],
  ['GRANT_CAPABILITY', { targetPubkey: SVC.pk, capability: 'MANAGE_MEMBERS' }],
  ['GRANT_CAPABILITY', { targetPubkey: Y.pk, capability: ADM }],
  ['REVOKE_CAPABILITY', { targetPubkey: SVC.pk, capability: ADM }],
  ['SET_INVITE_POLICY', { invitePolicy: 'EVERYONE' }],
  ['ADD_MEMBER_TO_BLOCKLIST', { targetPubkey: X.pk }],
  ['SET_GROUP_DISPLAY_NAME', { displayName: 'X' }],
];
const typed = typedOps.map(([op, p]) => {
  try {
    SP.applyControlOperation(op, delRec, SVC.pk, Object.assign({ groupId: GROUP, actorMembershipStatus: 'ACTIVE' }, p));
    return { op, code: 'BUILT' };
  } catch (e) {
    return { op, code: (e && e.code) || 'THREW' };
  }
});
add('SERVICE_CANNOT_SIGN_ARBITRARY_TYPED_OP', typed.every((t) => t.code !== 'BUILT'), typed);
let rootTyped = 'THREW';
try {
  SP.applyControlOperation('GRANT_CAPABILITY', delRec, R.pk, { groupId: GROUP, targetPubkey: X.pk, capability: 'INVITE_USERS' });
  rootTyped = 'BUILT';
} catch (e) {
  rootTyped = (e && e.code) || 'THREW';
}
add('CONTROL_ROOT_TYPED_OP_BUILDS', rootTyped === 'BUILT', rootTyped);
add('GENERIC_SIGNER_EXPOSED_FALSE', P.GENERIC_SIGNER_EXPOSED === false, null);

// ---- invites, revokes, moderation, membership outside finalization
base();
const st = tipState();
const invite = (key) => {
  const ih = Buffer.from(NT.generateSecretKey()).toString('hex');
  return NT.finalizeEvent({ kind: 37378, created_at: tick(), tags: [['t', GROUP], ['ih', ih], ['d', ih], ['expiration', String(clock + 3600)]], content: JSON.stringify({ v: 2, schema: 'sos-invite' }) }, key.sk);
};
const invR = invite(R);
const invS = invite(SVC);
const vR = IP.validateInviteEvent(invR, st, {});
const vS = IP.validateInviteEvent(invS, st, {});
const svcInviteCap = IP.hasCap(SVC.pk, st, 'INVITE_USERS') || IP.isAdminPrincipal(SVC.pk, st);
add('SERVICE_CANNOT_CREATE_INVITE', vR.ok && !vS.ok && !svcInviteCap, { root: vR.code, service: vS.code + ':' + (vS.detail || '') });
const revoke = (key, inv) => NT.finalizeEvent({ kind: 37380, created_at: tick(), tags: [['d', inv.id], ['e', inv.id], ['t', GROUP]], content: '' }, key.sk);
const rvR = IP.validateRevokeEvent(revoke(R, invR), invR, st);
const rvS = IP.validateRevokeEvent(revoke(SVC, invR), invR, st);
add('SERVICE_CANNOT_REVOKE_ARBITRARY_INVITE', rvR.ok && !rvS.ok, { root: rvR.code, service: rvS.code });
const note = NT.finalizeEvent({ kind: 1, created_at: tick(), tags: [['t', GROUP]], content: 'x' }, X.sk);
const modBy = (key) => {
  App.publicKey = key.pk;
  const d = MP.buildModerationDraft(note, 'hide', st);
  App.publicKey = '';
  return NT.finalizeEvent({ kind: d.kind, created_at: tick(), tags: d.tags, content: d.content }, key.sk);
};
const modR = modBy(R);
P.ingestAttestations([attest(modR, [P.contentRemovalOperation(note)], 2)]);
const mR = MP.validateModerationEvent(modR, note, st);
const mS = MP.validateModerationEvent(modBy(SVC), note, st);
add('SERVICE_CANNOT_MODERATE_CONTENT', mR.ok && !mS.ok, { root: mR.code, service: mS.code });
const memberEv = (key, transition, status) => {
  const body = { schema: 'sos-group-member', version: 1, groupId: GROUP, memberPubkey: X.pk, status, transition, memberRevision: 2, controlEpochAtIssue: 2, membershipEpoch: 1, issuerPubkey: key.pk, createdAt: tick() };
  return NT.finalizeEvent({ kind: 39003, created_at: body.createdAt, tags: [['d', GROUP + ':' + X.pk + ':2'], ['p', X.pk], ['t', GROUP]], content: JSON.stringify(body) }, key.sk);
};
const memberOut = {};
for (const [tr, stt] of [['REMOVE', 'REMOVED'], ['BLOCK', 'BLOCKED']]) {
  const evR = memberEv(R, tr, stt);
  P.ingestAttestations([attest(evR, [P.membershipOperation(tr)], 2)]);
  const r = MS.validateMembershipEventStructural(evR, st, { groupId: GROUP });
  const s = MS.validateMembershipEventStructural(memberEv(SVC, tr, stt), st, { groupId: GROUP });
  memberOut[tr] = { root: r.code, service: s.code, ok: r.ok && !s.ok };
}
add('SERVICE_CANNOT_REMOVE_OR_BLOCK_MEMBER', Object.values(memberOut).every((m) => m.ok), memberOut);
const grantNoInvite = MS.validateMembershipEventStructural(memberEv(SVC, 'GRANT_ACTIVE', 'ACTIVE'), st, { groupId: GROUP });
add('SERVICE_GRANT_WITHOUT_INVITE_BINDING_REJECTED', !grantNoInvite.ok, grantNoInvite.code);

// ---- delegations that must never make SVC active
const inactive = (events, atts) => {
  const status = load(events, atts);
  const info = svcInfo();
  return { status, active: info.active === true };
};
const wrongTarget = signControl(R, recAt(genesisRec, { controlEpoch: 2, capabilities: { [X.pk]: [ADM] } }));
const w1 = inactive([genesis, wrongTarget], [gAtt, attest(wrongTarget, ['CREATE_ADMISSION_DELEGATION'], 2)]);
add('WRONG_SERVICE_PUBKEY_NOT_ACTIVE_FOR_SERVICE', w1.status === 'VERIFIED' && !w1.active, w1);
const wrongGroupRec = recAt(genesisRec, { controlEpoch: 2, groupId: 'other-network', capabilities: { [SVC.pk]: [ADM] }, groupSettings: { displayName: 'SOS', networkTag: 'other-network' } });
const wrongGroup = signControl(R, wrongGroupRec, 'other-network');
const w2 = inactive([genesis, wrongGroup], [gAtt, attest(wrongGroup, ['CREATE_ADMISSION_DELEGATION'], 2)]);
add('WRONG_GROUP_DELEGATION_REJECTED', !w2.active, w2);
const w3 = inactive([genesis, delegation], [gAtt]);
add('ROOT_ONLY_DELEGATION_WITHOUT_ATTESTATION_REJECTED', !w3.active && G.getAdmin2faRejections()[delegation.id] != null, Object.assign(w3, { code: G.getAdmin2faRejections()[delegation.id] || null }));
const forged = NT.finalizeEvent({ kind: 39004, created_at: dAtt.created_at, tags: dAtt.tags, content: dAtt.content }, X.sk);
const w4 = inactive([genesis, delegation], [gAtt, forged]);
add('FORGED_ATTESTATION_REJECTED', !w4.active, w4);
const wrongOps = attest(delegation, ['GRANT_CAPABILITY'], 2);
const w5 = inactive([genesis, delegation], [gAtt, wrongOps]);
add('ATTESTATION_WRONG_OPERATION_REJECTED', !w5.active, w5);
const wrongEpochAtt = attest(delegation, ['CREATE_ADMISSION_DELEGATION'], 3);
const w6 = inactive([genesis, delegation], [gAtt, wrongEpochAtt]);
add('ATTESTATION_WRONG_EPOCH_REJECTED', !w6.active, w6);
const extraCap = signControl(R, recAt(genesisRec, { controlEpoch: 2, capabilities: { [SVC.pk]: [ADM, 'MANAGE_MEMBERS'].sort() } }));
const w7 = inactive([genesis, extraCap], [gAtt, attest(extraCap, ['CREATE_ADMISSION_DELEGATION'], 2)]);
add('DELEGATION_WITH_EXTRA_CAPABILITY_NEEDS_OTHER_OPS', !w7.active, w7);
const second = signControl(R, recAt(genesisRec, { controlEpoch: 2, capabilities: { [Y.pk]: [ADM] } }));
const w8 = inactive([genesis, delegation, second], [gAtt, dAtt, attest(second, ['CREATE_ADMISSION_DELEGATION'], 2)]);
add('SECOND_CONFLICTING_DELEGATION_FAILS_CLOSED', w8.status === 'CONTROL_CONFLICT' && !w8.active, w8);
const revokeEv = signControl(R, recAt(delRec, { controlEpoch: 3, capabilities: {} }));
const w9 = inactive([genesis, delegation, revokeEv], [gAtt, dAtt, attest(revokeEv, ['REVOKE_ADMISSION_DELEGATION'], 3)]);
add('REVOKED_DELEGATION_NOT_ACTIVE', w9.status === 'VERIFIED' && tipState().controlEpoch === 3 && !w9.active, w9);
const w9b = inactive([genesis, delegation, revokeEv], [gAtt, dAtt]);
add('REVOCATION_WITHOUT_ATTESTATION_REJECTED', w9b.status === 'VERIFIED' && tipState().controlEpoch === 2 && w9b.active, w9b);
const retireEv = signControl(R, recAt(delRec, { controlEpoch: 3, capabilities: { [SVC.pk]: [ADM + '_RETIRED'] } }));
const w10 = inactive([genesis, delegation, retireEv], [gAtt, dAtt, attest(retireEv, ['REVOKE_ADMISSION_DELEGATION'], 3)]);
add('RETIRED_DELEGATION_NOT_ACTIVE', w10.status === 'VERIFIED' && !w10.active && svcInfo().retired === true, w10);
const expiredCheck = P.verifyAdmin2faAttestation(delegation, dAtt, {
  groupId: GROUP,
  rootPubkey: R.pk,
  signerPubkey: S.pk,
  expectedOperations: ['CREATE_ADMISSION_DELEGATION'],
  controlEpoch: 2,
  nowSec: clock + 100000,
  requireUnexpired: true,
});
add('EXPIRED_ATTESTATION_REJECTED_BEFORE_PUBLISH', !expiredCheck.ok, expiredCheck.code);
let selfTyped = 'BUILT';
try {
  SP.applyControlOperation('GRANT_CAPABILITY', genesisRec, R.pk, { groupId: GROUP, targetPubkey: R.pk, capability: ADM });
} catch (e) {
  selfTyped = (e && e.code) || 'THREW';
}
add('ROOT_SELF_DELEGATION_BLOCKED_BY_TYPED_SIGNER', selfTyped === 'ROOT_TARGET_FORBIDDEN', selfTyped);
add('STEP_UP_REQUIRED_FOR_DELEGATION', P.requiresStepUp(['CREATE_ADMISSION_DELEGATION'], {}) && P.requiresStepUp(['REVOKE_ADMISSION_DELEGATION'], {}), null);

const out = {
  gate: 'GATE2_NEGATIVE_GATE',
  ts: new Date().toISOString(),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  status: results.every((r) => r.ok) ? 'PASS' : 'FAIL',
  results,
};
fs.writeFileSync(new URL('./gate2-negatives-report.json', import.meta.url), JSON.stringify(out, null, 2));
results.forEach((r) => console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.detail == null ? '' : JSON.stringify(r.detail).slice(0, 220)));
console.log(`\nGATE2_NEGATIVE_GATE=${out.status} (${out.passed}/${out.total})`);
process.exit(out.status === 'PASS' ? 0 : 1);
