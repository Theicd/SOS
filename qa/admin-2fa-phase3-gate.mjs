/**
 * Admin 2FA Phase 3 — web UI + server integration gate (local workerd only, no deploy, no relays).
 *
 * Starts `wrangler dev --local` with disposable ROOT / admission / co-sign keys and pepper written to the gitignored
 * admission-service/.dev.vars (deleted on exit). Loads the real browser modules (admin-2fa-client, protocol, control
 * state, typed signing policy, mutations, member ops, invite / moderation / membership policy, first-group-admin) in
 * VM contexts that talk to the local service over HTTP. The QA PINs are random per run and never printed.
 * Writes qa/admin-2fa-phase3-report.json (no secrets).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as NostrTools from 'nostr-tools';

const { generateSecretKey, getPublicKey, finalizeEvent } = NostrTools;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVC_DIR = path.join(ROOT, 'admission-service');
const REPORT = path.join(__dirname, 'admin-2fa-phase3-report.json');
const GROUP = 'israel-network';
const PORT = Number(process.env.SOS_A2FA_P3_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const DEAD = 'http://127.0.0.1:59999';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hex = (u8) => Buffer.from(u8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
function mkKey() {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
}

const R = mkKey(); // QA ROOT
const S = mkKey(); // admission service
const C = mkKey(); // Admin 2FA co-sign service
const W = mkKey(); // forger
const A2 = mkKey(); // delegated admin
const B = mkKey(); // member
const X = mkKey(); // outsider
const I = mkKey(); // invite-only helper
const PEPPER = crypto.randomBytes(32).toString('hex');
const SECRETS = [R.hex, S.hex, C.hex, W.hex, A2.hex, B.hex, X.hex, I.hex, PEPPER];
const SENSITIVE = [];

const checks = [];
const matrix = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail != null ? ' ' + JSON.stringify(detail) : ''}`);
}
function row(testCase, expected, ok, code) {
  matrix.push({ case: testCase, expected, result: ok ? 'PASS' : 'FAIL', code: code || null });
  check('MATRIX_' + testCase.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), ok, code);
}

// ------------------------------------------------------------ wrangler
let wr = null;
let wrLog = '';
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-a2fa-p3-'));
function writeDevVars() {
  fs.writeFileSync(
    path.join(SVC_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${R.pub}\nADMISSION_SK=${S.hex}\nADMIN_COSIGN_SK=${C.hex}\nADMIN_PIN_PEPPER=${PEPPER}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:8898\n`
  );
}
async function startWrangler() {
  wr = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', persistDir, '--show-interactive-dev-session=false'], {
    cwd: SVC_DIR,
    shell: true,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
  });
  wr.stdout.on('data', (d) => (wrLog += d.toString()));
  wr.stderr.on('data', (d) => (wrLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/v1/health');
      if (r.ok) return;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('wrangler dev did not start:\n' + wrLog.slice(-2000));
}
function stopWrangler() {
  if (!wr) return;
  try {
    execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' });
  } catch (_e) {
    try {
      wr.kill('SIGKILL');
    } catch (_e2) {}
  }
  wr = null;
}

// ------------------------------------------------------------ raw server calls (host side)
async function rawPin(signer, action, params) {
  const body = JSON.stringify(params || {});
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: nowSec(),
      tags: [
        ['u', 'sos-admin-pin:v1:' + action],
        ['method', 'POST'],
        ['payload', sha256(body)],
        ['t', GROUP],
        ['nonce', crypto.randomBytes(16).toString('hex')],
        ['sos-admin-pin', 'v1'],
      ],
      content: '',
    },
    signer.sk
  );
  const res = await fetch(BASE + '/v1/admin-pin/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: GROUP, auth, params: body }),
  });
  return res.json();
}

// ------------------------------------------------------------ browser-like VM client
const CLIENT_MODULES = [
  'admin-2fa-protocol.js',
  'group-control-state.js',
  'invite-policy.js',
  'moderation-policy.js',
  'membership-state.js',
  'admin-signing-policy.js',
  'group-control-mutations.js',
  'member-admin-operations.js',
  'first-group-admission-client.js',
  'admin-2fa-client.js',
  'first-group-admin.js',
];

function flagsJson(o) {
  return JSON.stringify({ schema: 'sos-feature-flags-v1', accessControlV2: false, admin2faEnforcement: o.enforce === true, admin2faSignerPubkey: o.signer || '' });
}

async function makeClient(identity, opts) {
  const o = Object.assign({ enforce: true, signer: C.pub, url: BASE }, opts || {});
  const mem = new Map();
  const target = new EventTarget();
  const clock = { offset: 0 };
  const pubLog = [];
  const state = { key: identity, sessionOk: true, generation: 1, unlockPin: null, stepPins: [], stepCalls: 0, unlockCalls: 0 };
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    static now() {
      return RealDate.now() + clock.offset;
    }
  }
  const config = flagsJson(o);
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {}, debug() {} },
    Date: ShiftedDate,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    crypto: globalThis.crypto,
    Promise,
    CustomEvent: class extends Event {
      constructor(type, init) {
        super(type);
        this.detail = init && init.detail;
      }
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    location: { hostname: '127.0.0.1', protocol: 'http:', search: '', hash: '' },
    document: {
      readyState: 'complete',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
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
    fetch: async (url, init) => {
      const u = String(url);
      if (/^https?:\/\//.test(u)) {
        const res = await fetch(u, init);
        const text = await res.text();
        return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
      }
      return { ok: true, status: 200, text: async () => config, json: async () => JSON.parse(config) };
    },
    NostrTools: {
      ...NostrTools,
      getEventHash: (e) => NostrTools.getEventHash(JSON.parse(JSON.stringify(e))),
      verifyEvent: (e) => NostrTools.verifyEvent(JSON.parse(JSON.stringify(e))),
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.NostrApp = { NETWORK_TAG: GROUP, COMMUNITY_CONTEXT: 'yalacommunity', adminSourceKeys: [R.pub] };
  vm.createContext(ctx);
  vm.runInContext(read('nostr-event-integrity.js'), ctx, { filename: 'nostr-event-integrity.js' });
  vm.runInContext(read('feature-flags.js'), ctx, { filename: 'feature-flags.js' });
  await ctx.NostrApp.FeatureFlags.whenReady();
  ctx.SOS_ACCESS_CONTROL_V2 = true; // local-host test switch for the V2 code paths (Admin 2FA has no override)
  const App = ctx.NostrApp;
  App.FIRST_GROUP_ADMISSION_URL = o.url;
  App.publicKey = identity.pub;
  App.guestMode = false;
  App.relayUrls = ['wss://relay.invalid'];
  App.pool = {
    publish: (_relays, ev) => {
      pubLog.push(JSON.parse(JSON.stringify(ev)));
      return [Promise.resolve('ok')];
    },
  };
  App.SessionAuthority = {
    checkSessionForSensitiveOp: () => (state.sessionOk ? { ok: true, generation: state.generation, account: App.publicKey } : { ok: false, code: 'SESSION_REVOKED' }),
    assertSessionForSensitiveOp: () => {
      if (!state.sessionOk) throw Object.assign(new Error('revoked'), { code: 'SESSION_REVOKED' });
    },
  };
  for (const f of CLIENT_MODULES) vm.runInContext(read(f), ctx, { filename: f });
  const Pol = App.AdminSigningPolicy;
  const strict = (ev) => App.strictVerifyNostrEvent(ev) === true;
  const fin = (draft) => finalizeEvent(JSON.parse(JSON.stringify({ kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content })), state.key.sk);
  // Same typed construction as SosCryptoSigner.signTypedAdminOperationMain (policy builds kind, tags, content).
  App.SosCryptoSigner = {
    hasIdentityKey: () => true,
    signAdmin2faAuth: (req) => fin(Pol.buildAdmin2faAuthDraft(req, state.key.pub)),
    signTypedAdminOperation: (request) => {
      const op = Pol.validateRequestEnvelope(request || {});
      const actor = state.key.pub;
      let draft;
      if (Pol.isControlOp(op)) {
        let baseRecord = null;
        if (op !== Pol.ADMIN_OP.BOOTSTRAP_GROUP_CONTROL) {
          if (!request.baseEvent || !strict(request.baseEvent)) throw new Error('BASE_VERIFY_FAILED');
          baseRecord = Pol.parseControlRecordFromEvent(request.baseEvent);
        }
        const groupId = Pol.resolveNetworkTag(request.groupId, baseRecord);
        draft = Pol.buildControlDraft(Pol.applyControlOperation(op, baseRecord, actor, Object.assign({}, request, { groupId })), actor);
      } else {
        const baseControl = Pol.parseControlRecordFromEvent(request.baseEvent);
        const groupId = Pol.resolveNetworkTag(request.groupId, baseControl);
        const tipBody = request.memberTipEvent ? JSON.parse(request.memberTipEvent.content) : null;
        draft = Pol.buildMembershipDraft(Pol.applyMembershipOperation(op, baseControl, tipBody, actor, Object.assign({}, request, { groupId })));
      }
      return fin(draft);
    },
  };
  // Dialog stand-in: the real dialog is exercised by the 899f / 898 browser gates.
  App.AdminPinLock = {
    requestUnlock: async () => {
      state.unlockCalls++;
      const st = await App.Admin2faClient.state();
      if (st.state === App.Admin2faClient.STATE.SERVICE_UNAVAILABLE) return { ok: false, code: 'ADMIN_2FA_SERVICE_UNAVAILABLE' };
      if (!state.unlockPin) return { ok: false, code: 'CANCELLED' };
      return App.Admin2faClient.verify(state.unlockPin);
    },
    requestStepUp: async (onPin) => {
      state.stepCalls++;
      const pin = state.stepPins.shift();
      if (!pin) return { ok: false, code: 'CANCELLED' };
      return onPin(pin);
    },
    isUnlocked: (pk) => App.Admin2faClient.isActive(pk),
    touch: () => App.Admin2faClient.touch(),
  };
  const controlCacheEvents = () => {
    try {
      const raw = mem.get('sos_group_control_v1_' + GROUP);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && Array.isArray(parsed.rows) ? parsed.rows : []).map((r) => r && r.event).filter(Boolean);
    } catch (_e) {
      return [];
    }
  };
  const extraControl = [];
  App.FirstGroupNetworkAuthority = {
    isSynced: () => true,
    reconcile: async () => ({ ok: true, code: 'SYNCED' }),
    pushControlToAdmission: async () => {
      const byId = new Map();
      pubLog.concat(controlCacheEvents(), extraControl).forEach((e) => {
        if (e && e.kind === 39001) byId.set(e.id, e);
      });
      const evs = Array.from(byId.values());
      if (evs.length) await App.FirstGroupAdmission.syncControl(evs);
    },
  };
  return {
    ctx,
    App,
    mem,
    clock,
    pubLog,
    state,
    extraControl,
    Cl: App.Admin2faClient,
    P: App.Admin2faProtocol,
    G: App.GroupControlState,
    M: App.GroupControlMutations,
    MAO: App.MemberAdminOperations,
    IP: App.InvitePolicy,
    MP: App.ModerationPolicy,
    MS: App.MembershipState,
    F: App.FirstGroupAdmin,
    App,
  };
}

function nonTrivialPin(isTrivial, avoid) {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!isTrivial(p) && p !== avoid) return p;
  }
}

/** Every attestation in the log appears before the event it covers, and every privileged event has one. */
function publishOrder(log, P) {
  const bad = [];
  log.forEach((ev, i) => {
    if (ev.kind === 39004) return;
    const idx = log.findIndex((a) => a.kind === 39004 && (a.tags.find((t) => t[0] === 'e') || [])[1] === ev.id);
    if (P.PRIVILEGED_EVENT_KINDS.indexOf(ev.kind) !== -1 && (idx === -1 || idx > i)) bad.push({ kind: ev.kind, idx, i });
  });
  return bad;
}

function contentEvent(author, parentId) {
  const tags = [['t', GROUP]];
  if (parentId) tags.push(['e', parentId, '', 'reply']);
  return finalizeEvent({ kind: 1, created_at: nowSec(), tags, content: 'qa ' + crypto.randomBytes(4).toString('hex') }, author.sk);
}

// ------------------------------------------------------------ main
async function main() {
  writeDevVars();
  await startWrangler();
  const health = await (await fetch(BASE + '/v1/health')).json();
  check('LOCAL_SERVICE_READY', health.adminPinService === true && health.cosignPubkey === C.pub, { adminPinService: health.adminPinService });

  const r = await makeClient(R);
  const PIN = nonTrivialPin(r.Cl.isTrivialPin);
  const WRONG = nonTrivialPin(r.Cl.isTrivialPin, PIN);
  SECRETS.push(PIN, WRONG);
  check('CLIENT_FLAGS_SERVER_AUTHORITATIVE', r.Cl.SERVER_PIN_AUTHORITATIVE === true && r.Cl.LOCAL_UI_PIN_ONLY === false && r.Cl.ADMIN_SESSION_TTL_MINUTES === 15 && r.Cl.required() === true);

  // ---------------- 2. admin state from the server (never browser storage)
  r.mem.set('sos-admin-pin-state', JSON.stringify({ configured: true, unlocked: true }));
  const st0 = await r.Cl.state();
  check('ADMIN_STATE_SERVER_DERIVED', st0.state === 'PIN_NOT_CONFIGURED' && r.Cl.isActive() === false, st0);

  // ---------------- 3. first-time enrollment
  const mismatch = await r.Cl.enroll(PIN, WRONG);
  const trivial = await r.Cl.enroll('123456', '123456');
  const short = await r.Cl.enroll('12345', '12345');
  const lsBefore = r.mem.size;
  const enr = await r.Cl.enroll(PIN, PIN);
  const st1 = await r.Cl.state();
  check('ENROLL_INPUT_RULES', mismatch.code === 'PIN_MISMATCH' && trivial.code === 'PIN_TOO_SIMPLE' && short.code === 'PIN_FORMAT', [mismatch.code, trivial.code, short.code]);
  const enrollPass = enr.ok === true && st1.state === 'ADMIN_SESSION_ACTIVE' && r.Cl.isActive() === true;
  check('FIRST_TIME_SERVER_ENROLLMENT_GATE', enrollPass, [enr.code, st1.state]);
  row('First server enrollment', 'PASS', enrollPass, enr.code);
  const p = await rawPin(R, 'params', {});
  const derivedGood = crypto.pbkdf2Sync(PIN, Buffer.from(p.salt, 'hex'), 600000, 32, 'sha256').toString('hex');
  const derivedWrong = crypto.pbkdf2Sync(WRONG, Buffer.from(p.salt, 'hex'), 600000, 32, 'sha256').toString('hex');
  SENSITIVE.push(derivedGood, derivedWrong);
  const second = await r.Cl.enroll(WRONG, WRONG);
  const secondRaw = await rawPin(R, 'enroll', { salt: p.salt, derived: derivedWrong });
  const secondOk = second.code === 'PIN_ALREADY_SET' && secondRaw.code === 'ALREADY_ENROLLED';
  check('SECOND_ENROLLMENT_REJECTED', secondOk, [second.code, secondRaw.code]);
  const healthAfter = await (await fetch(BASE + '/v1/health')).json();
  const statusRoute = await fetch(BASE + '/v1/admin-pin/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: GROUP }) });
  check(
    'HEALTH_ROOT_PIN_CONFIGURED_BOOLEAN_ONLY',
    health.rootPinConfigured === false && healthAfter.rootPinConfigured === true && statusRoute.status === 404 &&
      !/salt|verifier|session/i.test(JSON.stringify(healthAfter)),
    { before: health.rootPinConfigured, after: healthAfter.rootPinConfigured, statusRoute: statusRoute.status }
  );
  row('Second enrollment', 'DENY', secondOk, secondRaw.code);
  const storageValues = Array.from(r.mem.values()).join('|');
  check(
    'NO_PIN_OR_SESSION_IN_BROWSER_STORAGE',
    r.mem.size === lsBefore && !storageValues.includes(PIN) && !storageValues.includes(derivedGood) && JSON.stringify(enr).indexOf('session') === -1,
    { storageKeys: r.mem.size - lsBefore }
  );
  check('LOCAL_PIN_VERIFIER_MIGRATED_AS_SECRET_FALSE', !/indexedDB|localStorage|sessionStorage/.test(read('admin-pin-lock.js')) && !/localStorage|sessionStorage|indexedDB/.test(read('admin-2fa-client.js')));

  // ---------------- 5. verify / wrong PIN
  r.Cl.lock('test');
  const stLocked = await r.Cl.state();
  const wrong1 = await r.Cl.verify(WRONG);
  const right1 = await r.Cl.verify(PIN);
  row('Correct PIN', 'admin session', right1.ok === true && r.Cl.isActive() === true && stLocked.state === 'PIN_CONFIGURED_LOCKED', right1.code);
  row('Wrong PIN', 'DENY', wrong1.code === 'PIN_WRONG' && !wrong1.sessionId, wrong1.code);

  // ---------------- 6. session binding: logout / account switch / expiry
  r.state.generation = 2;
  const afterLogout = r.Cl.isActive();
  row('Logout', 'session invalidated', afterLogout === false, String(afterLogout));
  await r.Cl.verify(PIN);
  r.App.publicKey = B.pub;
  const switched = r.Cl.isActive();
  r.App.publicKey = R.pub;
  const switchedBack = r.Cl.isActive();
  row('Account switch', 'session invalidated', switched === false && switchedBack === false, String(switchedBack));
  check('ADMIN_SESSION_IDENTITY_BOUND', switched === false && switchedBack === false);
  await r.Cl.verify(PIN);
  check('ADMIN_SESSION_GROUP_BOUND', r.Cl.GROUP_ID === GROUP && r.Cl.PROTOCOL === 'sos-admin-2fa-v1' && /session\.groupId !== GROUP_ID/.test(read('admin-2fa-client.js')));

  // ---------------- 12. Gate 1.5 package (ROOT BOOTSTRAP + attestation, nothing published or applied)
  const noPkgBefore = r.pubLog.length;
  const pkg = await r.F.prepareGate15Package({ displayName: 'SOS' });
  let pkgBody = {};
  try {
    pkgBody = JSON.parse(pkg.event.content);
  } catch (_e) {}
  const pkgVerdict = pkg.ok
    ? r.P.verifyAdmin2faAttestation(pkg.event, pkg.attestation, { groupId: GROUP, rootPubkey: R.pub, signerPubkey: C.pub, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1, nowSec: nowSec() })
    : { ok: false, code: pkg.code };
  const gate15Ready =
    pkg.ok === true &&
    pkg.published === false &&
    r.pubLog.length === noPkgBefore &&
    pkg.event.pubkey === R.pub &&
    pkgBody.admin2faSignerPubkey === C.pub &&
    pkgVerdict.ok === true &&
    r.G.getStatus(GROUP) !== 'VERIFIED';
  check('GATE15_ADMIN_2FA_FLOW_READY', gate15Ready, { code: pkg.code, verdict: pkgVerdict.code, published: pkg.published });

  // ---------------- bootstrap through the real UI entry point (attest -> verify -> publish -> accept)
  const boot = await r.F.bootstrapFirstGroup({ displayName: 'SOS' });
  // the ROOT self-membership record is a pre-existing best-effort step that membership rules reject as SELF_GRANT;
  // the server must refuse to co-sign it and nothing unattested may be published
  const rootSelf = boot.rootMembership || {};
  check(
    'BOOTSTRAP_WITH_ADMIN_2FA',
    boot.ok === true && r.G.getStatus(GROUP) === 'VERIFIED' && rootSelf.ok !== true && rootSelf.detail === 'SELF_GRANT' && !r.pubLog.some((e) => e.kind === 39003 && e.pubkey === R.pub && e.tags.some((t) => t[0] === 'p' && t[1] === R.pub)),
    [boot.code, rootSelf.detail]
  );

  // ---------------- 8/9. privileged pipeline across operations
  const ops = {};
  const pre = r.pubLog.length;
  const grantA2 = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: A2.pub, capability: 'MANAGE_MEMBERS' }, R.pub);
  ops.PROMOTE_ADMIN = grantA2.ok;
  const grantA2b = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: A2.pub, capability: 'MODERATE_CONTENT' }, R.pub);
  ops.GRANT_CAPABILITY = grantA2b.ok;
  const grantB = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: B.pub, capability: 'INVITE_USERS' }, R.pub);
  ops.CHANGE_PERMISSION = grantB.ok;
  const revokeB = await r.M.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: B.pub, capability: 'INVITE_USERS' }, R.pub);
  ops.REVOKE_CAPABILITY = revokeB.ok;
  const admitB = await r.MAO.grantMemberActiveFromInvite(B.pub, crypto.randomBytes(32).toString('hex'), R.pub);
  const admitA2 = await r.MAO.grantMemberActiveFromInvite(A2.pub, crypto.randomBytes(32).toString('hex'), R.pub);
  check('CONTROL_AND_MEMBERSHIP_ATTESTED', grantA2.ok && grantA2b.ok && grantB.ok && revokeB.ok && admitB.ok && admitA2.ok, [grantA2.code, grantA2b.code, grantB.code, revokeB.code, admitB.code, admitA2.code]);

  // invite-only helper (INVITE_USERS only, ACTIVE member): no group control, no PIN bypass, invite capability kept
  const grantI = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: I.pub, capability: 'INVITE_USERS' }, R.pub);
  const admitI = await r.MAO.grantMemberActiveFromInvite(I.pub, crypto.randomBytes(32).toString('hex'), R.pub);
  const rootMenu = r.F.canSeeAdminMenu();
  const pubBeforeI = r.pubLog.length;
  let inviteOnly = {};
  r.App.publicKey = I.pub;
  try {
    const a = r.F.myAuthority();
    inviteOnly = {
      caps: a.caps.slice(),
      member: a.membership,
      menu: r.F.canSeeAdminMenu(),
      sections: r.F.visibleSections(),
      canInvite: r.IP.canCreateInvite(I.pub, r.G.getVerifiedControlState(GROUP)),
      grant: (await r.F.grantCapability(X.pub, 'MODERATE_CONTENT')).code,
      meta: (await r.F.updateMetadata({ description: 'invite-only' })).code,
      remove: (await r.F.removeMember(B.pub)).code,
    };
  } finally {
    r.App.publicKey = R.pub;
  }
  const uiSrc0 = read('group-admin-product-ui.js');
  check(
    'INVITE_ONLY_USER_GROUP_CONTROL_MENU_VISIBLE_FALSE',
    grantI.ok && admitI.ok && rootMenu === true && inviteOnly.caps.join() === 'INVITE_USERS' && inviteOnly.member === 'ACTIVE' && inviteOnly.menu === false,
    { grantI: grantI.code, admitI: admitI.code, rootMenu, caps: inviteOnly.caps, member: inviteOnly.member, menu: inviteOnly.menu }
  );
  check(
    'INVITE_ONLY_USER_GROUP_CONTROL_PANEL_ACCESS_FALSE',
    inviteOnly.menu === false &&
      /return f\.canSeeAdminMenu\(\) \|\| needsBootstrap\(\);/.test(uiSrc0) &&
      /if \(!canSeeGroupControl\(\)\) return \{ ok: false, code: 'UNAUTHORIZED' \};/.test(uiSrc0) &&
      !inviteOnly.sections.admins && !inviteOnly.sections.roles && !inviteOnly.sections.members && !inviteOnly.sections.settings
  );
  check(
    'INVITE_ONLY_USER_ADMIN_PIN_BYPASS_FALSE',
    ['grant', 'meta', 'remove'].every((k) => !/APPLIED|SAVED|REMOVED/.test(String(inviteOnly[k]))) && r.pubLog.length === pubBeforeI && !/needsAdminSession|NOT_ADMIN_TIER/.test(uiSrc0),
    { grant: inviteOnly.grant, meta: inviteOnly.meta, remove: inviteOnly.remove }
  );
  check(
    'INVITE_ONLY_USER_INVITE_CAPABILITY_PRESERVED',
    !!inviteOnly.canInvite && inviteOnly.canInvite.ok === true && inviteOnly.sections.invites === true && /id="topBarInviteFriend"/.test(read('videos.html')),
    { canInvite: inviteOnly.canInvite && inviteOnly.canInvite.code, invitesSection: inviteOnly.sections.invites }
  );

  // sensitive re-auth: DEMOTE_ADMIN (admin loses every admin-tier cap) needs a fresh PIN even inside the session;
  // revoking one cap while admin-tier caps remain is an ordinary REVOKE_CAPABILITY
  const grantA2c = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: B.pub, capability: 'MANAGE_GROUP_SETTINGS' }, R.pub);
  r.state.stepPins = [];
  const demoteNoPin = await r.M.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: B.pub, capability: 'MANAGE_GROUP_SETTINGS' }, R.pub);
  r.state.stepPins = [WRONG];
  const demoteWrong = await r.M.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: B.pub, capability: 'MANAGE_GROUP_SETTINGS' }, R.pub);
  r.state.stepPins = [PIN];
  const demoteB = await r.M.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: B.pub, capability: 'MANAGE_GROUP_SETTINGS' }, R.pub);
  const demoteAtt = demoteB.ok ? r.P.attestationsFor(demoteB.event.id)[0] : null;
  ops.DEMOTE_ADMIN = demoteB.ok && !!demoteAtt && JSON.parse(demoteAtt.content).stepUp === true;
  check(
    'DEMOTE_ADMIN_REQUIRES_FRESH_PIN',
    demoteNoPin.code === 'ADMIN_STEP_UP_CANCELLED' && demoteWrong.code === 'PIN_WRONG' && grantA2c.ok && ops.DEMOTE_ADMIN,
    [demoteNoPin.code, demoteWrong.code, demoteB.code]
  );

  // CHANGE_GROUP_POLICY via invite-policy (step-up)
  r.state.stepPins = [PIN];
  let policyRes;
  try {
    policyRes = await r.IP.signAndAcceptPolicyChange('ADMINS_ONLY');
    r.extraControl.push(policyRes.event);
    if (policyRes.attestation) r.extraControl.push(policyRes.attestation);
  } catch (e) {
    policyRes = { error: e.code || e.message };
  }
  ops.CHANGE_GROUP_POLICY = !!(policyRes && policyRes.attestation && JSON.parse(policyRes.attestation.content).stepUp === true);

  // metadata / role changes
  const meta = await r.M.applyControlMutation({ type: 'SET_GROUP_METADATA', description: 'qa phase3' }, R.pub);
  ops.CHANGE_GROUP_SETTINGS = meta.ok;
  ops.CHANGE_ROLE = grantA2.ok && ops.DEMOTE_ADMIN;

  // admission delegation create / revoke (local disposable key only; step-up)
  r.state.stepPins = [PIN];
  const delegate = await r.M.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: S.pub, capability: 'FINALIZE_MEMBERSHIP_ADMISSION' }, R.pub);
  ops.CREATE_ADMISSION_DELEGATION = delegate.ok && JSON.parse(r.P.attestationsFor(delegate.event.id)[0].content).stepUp === true;
  r.state.stepPins = [PIN];
  const undelegate = await r.M.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: S.pub, capability: 'FINALIZE_MEMBERSHIP_ADMISSION' }, R.pub);
  ops.REVOKE_ADMISSION_DELEGATION = undelegate.ok && JSON.parse(r.P.attestationsFor(undelegate.event.id)[0].content).stepUp === true;

  // REMOVE_MEMBER: ordinary member (no step-up) and admin target (step-up for REMOVE + DEMOTE cleanup)
  r.state.stepPins = [];
  const rmB = await r.MAO.removeMember(B.pub, R.pub);
  ops.REMOVE_MEMBER = rmB.ok === true && rmB.phase1 && rmB.phase1.ok;
  r.state.stepPins = [];
  const rmAdminNoPin = await r.MAO.removeMember(A2.pub, R.pub);
  r.state.stepPins = [PIN, PIN];
  const rmAdmin = await r.MAO.removeMember(A2.pub, R.pub);
  check('REMOVE_ADMIN_REQUIRES_FRESH_PIN', rmAdminNoPin.ok === false && rmAdminNoPin.code === 'ADMIN_STEP_UP_CANCELLED' && rmAdmin.ok === true, [rmAdminNoPin.code, rmAdmin.code, rmAdmin.cleanup && rmAdmin.cleanup.code]);

  // REVOKE_INVITE (another author's invite) through the server + receiver policy
  const inviteByB = finalizeEvent({ kind: 37378, created_at: nowSec(), tags: [['d', 'qa-' + crypto.randomBytes(4).toString('hex')], ['t', GROUP]], content: '{}' }, B.sk);
  const revokeDraft = (inv, signer) =>
    finalizeEvent(
      {
        kind: 37380,
        created_at: nowSec(),
        tags: [['d', inv.id], ['e', inv.id], ['t', GROUP], ['t', 'sos-invite-revoke']],
        content: JSON.stringify({ schema: 'sos-invite-revoke', version: 1, inviteEventId: inv.id, groupId: GROUP }),
      },
      signer.sk
    );
  const revokeEv = revokeDraft(inviteByB, R);
  const revokeNoAtt = r.IP.validateRevokeEvent(revokeEv, inviteByB, r.G.getVerifiedControlState(GROUP));
  const revokeAtt = await r.Cl.attest(revokeEv, { invite: inviteByB });
  const revokeAfter = r.IP.validateRevokeEvent(revokeEv, inviteByB, r.G.getVerifiedControlState(GROUP));
  const ownInvite = finalizeEvent({ kind: 37378, created_at: nowSec(), tags: [['d', 'qa-own'], ['t', GROUP]], content: '{}' }, R.sk);
  const ownRevokeAtt = await r.Cl.attest(revokeDraft(ownInvite, R), { invite: ownInvite });
  ops.REVOKE_INVITE = revokeNoAtt.ok === false && revokeAtt.ok === true && revokeAtt.operations.join() === 'REVOKE_INVITE' && revokeAfter.ok === true;
  check('OWN_INVITE_REVOKE_NOT_ATTESTED', ownRevokeAtt.ok === false, ownRevokeAtt.code);

  // DELETE_OTHER_USER_POST / COMMENT via group moderation (39002)
  const post = contentEvent(B);
  const comment = contentEvent(B, post.id);
  const modFor = (target) => {
    const d = r.MP.buildModerationDraft(target, 'hide', r.G.getVerifiedControlState(GROUP));
    return finalizeEvent({ kind: d.kind, created_at: d.created_at, tags: JSON.parse(JSON.stringify(d.tags)), content: d.content }, R.sk);
  };
  const modPost = modFor(post);
  const modPostNoAtt = r.MP.validateModerationEvent(modPost, post, null);
  const modPostAtt = await r.Cl.attest(modPost, { target: post });
  const modPostAfter = r.MP.validateModerationEvent(modPost, post, null);
  const modComment = modFor(comment);
  const modCommentAtt = await r.Cl.attest(modComment, { target: comment });
  ops.DELETE_OTHER_USER_POST = modPostAtt.ok && modPostAtt.operations.join() === 'DELETE_OTHER_USER_POST' && modPostAfter.ok === true;
  ops.DELETE_OTHER_USER_COMMENT = modCommentAtt.ok && modCommentAtt.operations.join() === 'DELETE_OTHER_USER_COMMENT' && r.MP.validateModerationEvent(modComment, comment, null).ok === true;
  row('Other-user deletion without attestation', 'DENY', modPostNoAtt.ok === false && /ADMIN_2FA/.test(modPostNoAtt.code), modPostNoAtt.code);
  row('Other-user deletion with attestation', 'ACCEPT', modPostAfter.ok === true, modPostAfter.code);

  // legacy kind 5 (V2 off receivers): cross-author only with attestation; own content never needs one
  const post2 = contentEvent(B);
  const del5 = finalizeEvent({ kind: 5, created_at: nowSec(), tags: [['e', post2.id], ['t', GROUP]], content: '' }, R.sk);
  const del5No = r.P.authorizeAdminContentRemoval(del5, [{ id: post2.id, author: B.pub }], { groupId: GROUP });
  const del5Att = await r.Cl.attest(del5, { target: post2 });
  const del5Yes = r.P.authorizeAdminContentRemoval(del5, [{ id: post2.id, author: B.pub }], { groupId: GROUP });
  const own = contentEvent(R);
  const ownDel = finalizeEvent({ kind: 5, created_at: nowSec(), tags: [['e', own.id], ['t', GROUP]], content: '' }, R.sk);
  const ownDelAtt = await r.Cl.attest(ownDel, { target: own });
  check('LEGACY_KIND5_CROSS_AUTHOR_ATTESTED', del5No.ok === false && del5Att.ok === true && del5Yes.ok === true, [del5No.code, del5Att.code, del5Yes.code]);
  const feedSrc = read('feed.js');
  const ownUnaffected =
    ownDelAtt.ok === false &&
    /OWN_CONTENT_NOT_PRIVILEGED|ADMIN_2FA_DENIED/.test(ownDelAtt.code + (ownDelAtt.reason || '')) &&
    /if \(!isOwn\) \{\s*const att = await attestAdminRemoval/.test(feedSrc) &&
    r.MP.canAuthorDelete(R.pub, R.pub).ok === true;
  row('Own-content deletion', 'unaffected', ownUnaffected, ownDelAtt.reason || ownDelAtt.code);
  check('OWN_CONTENT_DELETE_2FA_REQUIRED_FALSE', ownUnaffected);

  const opList = [
    'BOOTSTRAP_GROUP_CONTROL', 'PROMOTE_ADMIN', 'DEMOTE_ADMIN', 'CHANGE_ROLE', 'CHANGE_PERMISSION', 'GRANT_CAPABILITY', 'REVOKE_CAPABILITY',
    'REMOVE_MEMBER', 'REVOKE_INVITE', 'CHANGE_GROUP_POLICY', 'DELETE_OTHER_USER_POST', 'DELETE_OTHER_USER_COMMENT',
    'CREATE_ADMISSION_DELEGATION', 'REVOKE_ADMISSION_DELEGATION',
  ];
  ops.BOOTSTRAP_GROUP_CONTROL = boot.ok === true;
  const coverage = Object.fromEntries(opList.map((k) => [k, ops[k] === true]));
  check('PRIVILEGED_OPERATION_ATTESTATION_COVERAGE_COMPLETE', opList.every((k) => ops[k] === true), coverage);
  const order = publishOrder(r.pubLog.slice(pre), r.P);
  check('PUBLISH_ONLY_AFTER_VERIFIED_ATTESTATION', order.length === 0 && r.pubLog.length > pre, { violations: order.length, published: r.pubLog.length - pre });

  // ---------------- 11. canonical re-auth policy
  const P = r.P;
  check(
    'SENSITIVE_ADMIN_REAUTH_POLICY_CANONICAL',
    P.SENSITIVE_ADMIN_REAUTH_POLICY_CANONICAL === true &&
      ['DEMOTE_ADMIN', 'CHANGE_GROUP_POLICY', 'CREATE_ADMISSION_DELEGATION', 'REVOKE_ADMISSION_DELEGATION'].every((op) => P.requiresStepUp([op], {})) &&
      P.requiresStepUp(['REMOVE_MEMBER'], { targetIsAdmin: true }) &&
      !P.requiresStepUp(['REMOVE_MEMBER'], { targetIsAdmin: false }) &&
      !P.requiresStepUp(['BOOTSTRAP_GROUP_CONTROL', 'GRANT_CAPABILITY'], {}) &&
      /P\.requiresStepUp\(operations/.test(read('admission-service/src/pin.js')) &&
      !/needsStepUp/.test(read('admission-service/src/pin.js'))
  );

  // ---------------- receiver side (another member's browser, enforcement on)
  const recv = await makeClient(B);
  recv.P.ingestAttestations(r.pubLog.concat(r.extraControl).filter((e) => e.kind === 39004));
  const allControl = new Map();
  r.pubLog.concat(r.extraControl).forEach((e) => e.kind === 39001 && allControl.set(e.id, e));
  recv.G.ingestControlEvents(Array.from(allControl.values()), { groupId: GROUP });
  const recvState = recv.G.getVerifiedControlState(GROUP);
  const senderState = r.G.getVerifiedControlState(GROUP);
  row('Valid event + attestation', 'ACCEPT', recv.G.getStatus(GROUP) === 'VERIFIED' && recvState && senderState && recvState.eventId === senderState.eventId, recvState && recvState.controlEpoch);

  // ROOT event without attestation / forged / wrong-event (fresh receiver, BOOTSTRAP only)
  const fresh = async () => makeClient(X);
  const e1 = await fresh();
  const rootOnly = r.G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, creatorPubkey: R.pub, displayName: 'SOS', invitePolicy: 'AUTHORIZED_USERS_ONLY', admin2faSignerPubkey: C.pub });
  const rootOnlyDraft = JSON.parse(JSON.stringify(r.G.buildSignDraft(rootOnly, R.pub)));
  const rootOnlyEv = finalizeEvent({ kind: rootOnlyDraft.kind, created_at: nowSec(), tags: rootOnlyDraft.tags, content: rootOnlyDraft.content }, R.sk);
  const accNoAtt = e1.G.acceptControlEvent(rootOnlyEv, { groupId: GROUP });
  row('ROOT event without attestation', 'DENY', accNoAtt.ok !== true && /ADMIN_2FA/.test(String(accNoAtt.code)), accNoAtt.code);
  const forgedDraft = JSON.parse(JSON.stringify(e1.P.buildAttestationDraft({ groupId: GROUP, rootPubkey: R.pub, event: rootOnlyEv, operations: ['BOOTSTRAP_GROUP_CONTROL'], controlEpoch: 1, principal: R.pub, stepUp: false, issuedAt: nowSec(), requestId: crypto.randomBytes(32).toString('hex') })));
  const forged = finalizeEvent(forgedDraft, W.sk);
  const forgedV = e1.P.verifyAdmin2faAttestation(rootOnlyEv, forged, { groupId: GROUP, rootPubkey: R.pub, signerPubkey: C.pub, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'] });
  e1.P.ingestAttestations([forged]);
  const accForged = e1.G.acceptControlEvent(rootOnlyEv, { groupId: GROUP });
  row('Forged attestation', 'DENY', forgedV.ok === false && accForged.ok !== true, forgedV.code);
  const wrongEv = e1.P.verifyAdmin2faAttestation(rootOnlyEv, pkg.attestation, { groupId: GROUP, rootPubkey: R.pub, signerPubkey: C.pub, expectedOperations: ['BOOTSTRAP_GROUP_CONTROL'] });
  row('Wrong-event attestation', 'DENY', wrongEv.ok === false && wrongEv.code === 'ADMIN_2FA_ATTESTATION_EVENT_MISMATCH', wrongEv.code);

  // ---------------- ROOT key without PIN (fresh browser: no admin session)
  const noPin = await makeClient(R);
  const noPinLog = noPin.pubLog.length;
  const noPinMod = await noPin.Cl.attest(modFor(contentEvent(B)), { target: contentEvent(B) });
  const noPinMut = await noPin.M.applyControlMutation({ type: 'SET_GROUP_METADATA', description: 'no pin' }, R.pub).catch((e) => ({ ok: false, code: e.message }));
  const rawNoSession = await rawPin(R, 'cosign', { event: rootOnlyEv });
  row(
    'ROOT key without PIN',
    'DENY',
    noPinMod.code === 'ADMIN_PIN_REQUIRED' && noPinMut.ok !== true && rawNoSession.code === 'NO_SESSION' && noPin.pubLog.length === noPinLog,
    [noPinMod.code, noPinMut.code, rawNoSession.code].join('/')
  );
  check('ROOT_KEY_ONLY_ADMIN_ACCESS_FALSE', noPinMod.ok === false && rawNoSession.code === 'NO_SESSION');

  // ---------------- publish before attestation is impossible (denied pipeline publishes nothing)
  const before = r.pubLog.length;
  r.state.stepPins = [];
  const deniedPublish = await r.M.applyControlMutation({ type: 'SET_INVITE_POLICY', invitePolicy: 'EVERYONE' }, R.pub);
  row('Publish before attestation', 'DENY / impossible', deniedPublish.ok === false && r.pubLog.length === before, deniedPublish.code);

  // ---------------- expired session (client idle > 15 min): privileged op denied until PIN re-entry
  r.clock.offset = 16 * 60 * 1000;
  const expiredActive = r.Cl.isActive();
  r.clock.offset = 0;
  const unlockBefore = r.state.unlockCalls;
  const expiredOp = await r.M.applyControlMutation({ type: 'SET_GROUP_METADATA', description: 'expired' }, R.pub);
  row('Expired session', 'privileged op DENY', expiredActive === false && expiredOp.ok === false && expiredOp.code === 'ADMIN_PIN_REQUIRED' && r.state.unlockCalls === unlockBefore + 1, expiredOp.code);

  // ---------------- service unavailable: fail closed, no ROOT-only or local-PIN fallback
  const down = await makeClient(R, { url: DEAD });
  const downState = await down.Cl.state();
  const downAttest = await down.Cl.attest(modFor(contentEvent(B)), { target: contentEvent(B) });
  const noUrl = await makeClient(R, { url: '' });
  const noUrlAttest = await noUrl.Cl.attest(modFor(contentEvent(B)), { target: contentEvent(B) });
  const unavailable =
    downState.state === 'ADMIN_2FA_SERVICE_UNAVAILABLE' &&
    downAttest.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' &&
    noUrlAttest.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' &&
    down.pubLog.length === 0 &&
    down.Cl.SERVICE_UNAVAILABLE_TEXT === 'שירות אימות המנהל אינו זמין כרגע' &&
    down.MP.canAuthorDelete(R.pub, R.pub).ok === true;
  row('Service unavailable', 'DENY', unavailable, [downState.state, downAttest.code, noUrlAttest.code].join('/'));
  check('ADMIN_2FA_SERVICE_FAILURE_FAIL_CLOSED', unavailable);
  check('ROOT_ONLY_FALLBACK_FALSE', unavailable && down.Cl.ROOT_ONLY_FALLBACK === false && !/requestUnlock[\s\S]{0,200}indexedDB/.test(read('admin-pin-lock.js')));

  // ---------------- 7. group control menu requires the server session
  const uiSrc = read('group-admin-product-ui.js');
  const fgaSrc = read('first-group-admin.js');
  check(
    'GROUP_CONTROL_REQUIRES_SERVER_ADMIN_SESSION',
    /const u = await adminSession\(\)/.test(uiSrc) &&
      /const unlocked = await adminSession\(\)/.test(uiSrc) &&
      /function adminSession\(\) \{\s*const p = PIN\(\);\s*return p \? p\.requestUnlock\(\) : Promise\.resolve\(\{ ok: false \}\);/.test(uiSrc) &&
      !/needsAdminSession|NOT_ADMIN_TIER/.test(uiSrc) &&
      /return a\.verified && \(a\.isRoot \|\| isGroupAdminTier\(a\.caps\)\)/.test(fgaSrc) &&
      /p\.isUnlocked\(me\) !== true\) return fail\('ADMIN_PIN_REQUIRED'\)/.test(fgaSrc) &&
      /isUnlocked\(pubkey\) \{\s*const c = C\(\);\s*return !!c && c\.isActive\(pubkey\)/.test(read('admin-pin-lock.js')) &&
      /'שליטה על הקבוצה'/.test(uiSrc) &&
      /הגדרת קוד מנהל/.test(read('admin-pin-lock.js')) &&
      /'<h2 id="sosAdminPinTitle">קוד מנהל<\/h2>/.test(read('admin-pin-lock.js'))
  );

  // ---------------- 13. enforcement stays deployment-controlled
  const gitFlags = execSync('git show HEAD:runtime-feature-flags.json', { cwd: ROOT }).toString();
  const eol = (s) => s.replace(/\r\n/g, '\n');
  const prodFlags = JSON.parse(read('runtime-feature-flags.json'));
  const clientSrc = read('admin-2fa-client.js');
  check(
    'ENFORCEMENT_DEPLOYMENT_CONFIG_NO_OVERRIDES',
    eol(gitFlags) === eol(read('runtime-feature-flags.json')) &&
      prodFlags.admin2faEnforcement === true &&
      prodFlags.admin2faSignerPubkey === '74c4bb0fb6b87b69cc2a95a80b4b5fa616cde3f917ef1894594606d30062edfa' &&
      prodFlags.accessControlV2 !== true &&
      /const BUILD_ENFORCEMENT = false;/.test(read('admin-2fa-protocol.js')) &&
      /App\.FIRST_GROUP_ADMISSION_URL = '(?:|https:\/\/sos-first-group-admission\.dror201031-b16\.workers\.dev)';/.test(read('config.js')) &&
      !/location\.search|URLSearchParams|localStorage|sessionStorage/.test(clientSrc)
  );

  // ---------------- 16. static: every privileged sender attests before any publish
  const senders = {
    'group-control-mutations.js': /attestPrivileged\(signed\)[\s\S]*?if \(att\.attestation\) await App\.pool\.publish\(App\.relayUrls, att\.attestation\);\s*await App\.pool\.publish\(App\.relayUrls, signed\)/,
    'member-admin-operations.js': /attestPrivileged\(signed\)[\s\S]*?if \(attestation\) await App\.pool\.publish\(App\.relayUrls, attestation\);\s*await App\.pool\.publish\(App\.relayUrls, signed\)/,
    'invite-policy.js': /await C\.attest\(event\)[\s\S]*?acceptControlEvent\(event\)/,
    'invite-service.js': /C\.attest\(signed, \{ invite: ev \}\)[\s\S]*?A\.revoke\(signed\)[\s\S]*?publish\(App\.relayUrls, attestation\);\s*await App\.pool\.publish\(App\.relayUrls, signed\)/,
    'feed.js': /attestAdminRemoval\(event, targetEvent\)[\s\S]*?validateModerationEvent\(event, targetEvent, null\)[\s\S]*?publish\(App\.relayUrls, att\.attestation\);\s*await App\.pool\.publish\(App\.relayUrls, event\)/,
    'first-group-admin.js': /signAttestedBootstrap\(me, o\)[\s\S]*?publish\(App\.relayUrls, signedBootstrap\.attestation\);\s*await App\.pool\.publish\(App\.relayUrls, ev\)/,
  };
  const senderAudit = Object.fromEntries(Object.entries(senders).map(([f, re]) => [f, re.test(read(f))]));
  check('SENDERS_ATTEST_BEFORE_PUBLISH', Object.values(senderAudit).every(Boolean), senderAudit);
  check('RECEIVERS_FETCH_ATTESTATIONS', /KIND_ATTESTATION\], '#t': \[GROUP_ID\]/.test(read('first-group-network-authority.js')) && /kinds: \[39004\]/.test(feedSrc) && /registerAdmin2faAttestation\(event\)/.test(feedSrc));

  // ---------------- 5. server rate limit (last: leaves the QA ROOT locked)
  const rl = [];
  for (let i = 0; i < 4; i++) rl.push(await r.Cl.verify(WRONG));
  const rlRight = await r.Cl.verify(PIN);
  const rateOk = rl.slice(0, 3).every((x) => x.code === 'PIN_WRONG') && rl[3].code === 'PIN_WRONG' && rl[3].retryAfterMs === 30000 && rlRight.code === 'PIN_LOCKED' && rlRight.retryAfterMs > 0;
  row('Rate limit', 'PASS', rateOk, rl.map((x) => x.retryAfterMs).concat([rlRight.code]).join(','));
  check('SERVER_SIDE_PIN_RATE_LIMIT_AUTHORITATIVE', rateOk);

  stopWrangler();
  const leaks = SECRETS.concat(SENSITIVE).filter((s) => wrLog.includes(s)).length;
  check('SERVICE_LOG_PRIVACY', leaks === 0, { leaks });
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e;
  check('GATE_RUNTIME', false, String((e && e.message) || e).slice(0, 300));
} finally {
  stopWrangler();
  try {
    fs.unlinkSync(path.join(SVC_DIR, '.dev.vars'));
  } catch (_e) {}
  try {
    fs.rmSync(persistDir, { recursive: true, force: true });
  } catch (_e) {}
}

const pass = !failed && checks.every((c) => c.ok);
const report = {
  gate: 'ADMIN_2FA_PHASE3_GATE',
  mode: 'local-workerd + VM browser modules',
  generatedAt: new Date().toISOString(),
  status: pass ? 'ADMIN_2FA_PHASE3_PASS' : 'FAIL',
  tests: `${checks.filter((c) => c.ok).length}/${checks.length}`,
  matrix,
  results: Object.fromEntries(checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL'])),
  details: checks.filter((c) => c.detail !== undefined).map((c) => ({ name: c.name, detail: c.detail })),
  invariants: {
    ADMIN_2FA_ENFORCEMENT_PRODUCTION: false,
    ACCESS_CONTROL_V2: false,
    PRODUCTION_DEPLOYED: false,
    GATE15_PUBLISHED: false,
    DELEGATION_ACTIVE: false,
    APK_BUILT: false,
  },
  secretsInReport: false,
};
let text = JSON.stringify(report, null, 2);
const leaked = SECRETS.concat(SENSITIVE).filter((s) => text.includes(s)).length;
report.secretsInReport = leaked > 0;
text = JSON.stringify(report, null, 2);
if (leaked === 0) fs.writeFileSync(REPORT, text + '\n');
console.log(`\nADMIN_2FA_PHASE3_GATE=${pass && leaked === 0 ? 'PASS' : 'FAIL'} (${report.tests})${leaked ? ' REPORT_NOT_WRITTEN_SECRET_LEAK' : ''}`);
process.exit(pass && leaked === 0 ? 0 : 1);
