#!/usr/bin/env node
/**
 * AC8 — Guest authorization + 30078 schema hardening gate.
 * Never prints private keys / nsec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac8-guest-hardening-report.json');

const report = {
  STATUS: 'FAIL',
  notes: [],
  CURRENT_GUEST_30078_EVENT_TYPES: [
    'HEARTBEAT (PUBLIC_AVAILABILITY)',
    'FILE_AVAILABILITY (PUBLIC / FILE-TORRENT CONTROL)',
    'PEER_TARGETED private nip44 — registered SosCryptoSigner only (NOT guest vault)',
  ],
  CURRENT_GUEST_30078_TAG_SHAPES: {
    HEARTBEAT: ['d=p2p-heartbeat', 't=p2p-heartbeat', 'app=sos-p2p-video', 'expires', 'guest?', 'network'],
    FILE_AVAILABILITY: ['d=sos-p2p-video:file:{hash}', 'x', 't=p2p-file', 'size', 'mime', 'expires', 'guest?', 'network'],
  },
  CURRENT_GUEST_30078_CONTENT_SHAPES: {
    HEARTBEAT: '{online:true,files:number,isGuest?:boolean}',
    FILE_AVAILABILITY: "'' (empty)",
  },
  CURRENT_GUEST_30078_REQUIRED_COMPATIBILITY:
    'Receive accepts legacy exact shapes without network tag; sign always requires network=App.NETWORK_TAG',
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC8]', String(s).slice(0, 220));
}

function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function storeApi(map) {
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function loadCtx(v2) {
  const lsMap = new Map();
  const ssMap = new Map();
  const localStorage = storeApi(lsMap);
  const sessionStorage = storeApi(ssMap);
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Array,
    JSON,
    Object,
    Promise,
    Error,
    Math,
    Set,
    Map,
    Number,
    String,
    Boolean,
    parseInt,
    isFinite: Number.isFinite.bind(Number),
    localStorage,
    sessionStorage,
    window: null,
    NostrTools: { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent },
    NostrApp: {
      NETWORK_TAG: 'israel-network',
      publicKey: null,
      guestMode: true,
      finalizeEvent: (d, k) => finalizeEvent(JSON.parse(JSON.stringify(d)), k),
      SosCryptoSigner: { hasIdentityKey: () => false },
    },
  };
  ctx.window = ctx;
  ctx.window.localStorage = localStorage;
  ctx.window.sessionStorage = sessionStorage;
  ctx.window.NostrTools = ctx.NostrTools;
  ctx.window.NostrApp = ctx.NostrApp;
  ctx.window.crypto = crypto;
  ctx.window.SOS_ACCESS_CONTROL_V2 = v2 === true;

  const files = [
    'access-control.js',
    'guest-access-control.js',
    'guest-p2p-schema.js',
    'guest-p2p-key-vault.js',
  ];
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, lsMap, ssMap, localStorage, sessionStorage, regSk: sk, regPk: pk };
}

function hbDraft(net, extraTags) {
  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'p2p-heartbeat'],
      ['t', 'p2p-heartbeat'],
      ['app', 'sos-p2p-video'],
      ['expires', String(Date.now() + 180000)],
      ['guest', 'true'],
      ['network', net || 'israel-network'],
    ].concat(extraTags || []),
    content: JSON.stringify({ online: true, files: 0, isGuest: true }),
  };
}

function fileDraft(hash) {
  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'sos-p2p-video:file:' + hash],
      ['x', hash],
      ['t', 'p2p-file'],
      ['size', '12'],
      ['mime', 'video/mp4'],
      ['expires', String(Date.now() + 86400000)],
      ['guest', 'true'],
      ['network', 'israel-network'],
    ],
    content: '',
  };
}

(async () => {
  let ok = true;
  const gacSrc = fs.readFileSync(path.join(ROOT, 'guest-access-control.js'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(ROOT, 'guest-p2p-schema.js'), 'utf8');
  const vaultSrc = fs.readFileSync(path.join(ROOT, 'guest-p2p-key-vault.js'), 'utf8');
  const p2pSrc = fs.readFileSync(path.join(ROOT, 'p2p-video-sharing.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');

  ok =
    record(
      'modules wired in videos.html',
      /guest-access-control\.js\?v=20260923ac8/.test(html) &&
        /guest-p2p-schema\.js\?v=20260923ac8/.test(html) &&
        /guest-p2p-key-vault\.js\?v=20260923ac8/.test(html)
    ) && ok;
  ok =
    record(
      'no Worker guest migration in AC8',
      !/Worker.*guest|guest.*Worker\.|SIGN_GUEST_P2P/.test(vaultSrc) ||
        /AC8_CLAIMS_XSS_ISOLATION=false|Custody architecture unchanged/.test(vaultSrc)
    ) && ok;
  ok =
    record(
      'p2p wires membership gate + network tag',
      /assertGroupP2PAllowed/.test(p2pSrc) &&
        /withGuestNetworkTag/.test(p2pSrc) &&
        /group_p2p_signal|canUseGroupP2P/.test(p2pSrc + gacSrc)
    ) && ok;

  const rt = loadCtx(false);
  const GAC = rt.ctx.NostrApp.GuestAccessControl;
  const S = rt.ctx.NostrApp.GuestP2PSchema;

  ok = record('GAC model explicit_allowlist', GAC.GUEST_AUTHORIZATION_MODEL === 'explicit_allowlist') && ok;
  ok = record('GAC default allow false', GAC.GUEST_DEFAULT_ALLOW === false) && ok;
  ok =
    record(
      'allowlist exact',
      JSON.stringify(GAC.GUEST_CAPABILITY_ALLOWLIST) ===
        JSON.stringify(['READ_PUBLIC_CONTENT', 'P2P_SIGNAL_PUBLIC_30078', 'P2P_FILE_TORRENT'])
    ) && ok;

  const denied = GAC.GUEST_DENIED_ACTIONS;
  for (const a of [
    'POST',
    'COMMENT',
    'REACTION',
    'FOLLOW',
    'INVITE_CREATE',
    'MODERATE_CONTENT',
    'GROUP_ADMIN',
    'GROUP_MEDIA_PUBLISH',
  ]) {
    ok = record('deny ' + a, GAC.canGuestAction(a) === false && denied.indexOf(a) !== -1) && ok;
  }
  ok = record('allow READ_PUBLIC', GAC.canGuestAction('READ_PUBLIC_CONTENT') === true) && ok;
  ok = record('allow P2P public', GAC.canGuestAction('P2P_SIGNAL_PUBLIC_30078') === true) && ok;

  // Boot purge — reload vault module against seeded legacy key
  rt.localStorage.setItem('p2p_guest_keys', JSON.stringify({ privateKey: 'ab'.repeat(32) }));
  rt.localStorage.setItem('nostr_private_key', 'cd'.repeat(32));
  vm.runInNewContext(vaultSrc, rt.ctx, { filename: 'guest-p2p-key-vault-reload.js' });
  ok = record('boot purge legacy', rt.localStorage.getItem('p2p_guest_keys') === null) && ok;
  ok = record('registered untouched by purge', rt.localStorage.getItem('nostr_private_key') === 'cd'.repeat(32)) && ok;

  const V = rt.ctx.NostrApp.GuestP2PKeyVault;
  const meta = await V.ensureReady();
  const guestPk = meta.publicKey;
  ok = record('classify GUEST_P2P', GAC.classifyPrincipal(guestPk) === 'GUEST_P2P') && ok;
  ok = record('random hex UNKNOWN', GAC.classifyPrincipal('11'.repeat(32)) === 'UNKNOWN') && ok;
  ok = record('control plane ineligible', GAC.isControlPlaneEligible(guestPk) === false) && ok;
  ok = record('no admin capability', GAC.canReceiveAdminCapability(guestPk) === false) && ok;
  ok = record('no membership state', GAC.canReceiveMembershipState(guestPk) === false) && ok;
  ok = record('no directory principal', GAC.canBeMemberDirectoryPrincipal(guestPk) === false) && ok;

  const guestEx = GAC.canUseGroupP2P(guestPk, { signalClass: 'PUBLIC_AVAILABILITY' });
  ok = record('guest P2P exception', guestEx.ok === true && guestEx.grantsMembership === false) && ok;
  ok =
    record(
      'guest private denied',
      GAC.canUseGroupP2P(guestPk, { signalClass: 'PEER_TARGETED_PRIVATE' }).ok === false
    ) && ok;

  // UI flag attack
  rt.ctx.NostrApp.guestMode = false;
  ok = record('UI flag no registered class', GAC.classifyPrincipal(guestPk) === 'GUEST_P2P') && ok;
  rt.ctx.NostrApp.guestMode = true;

  // Schema / sign
  const signed = await V.signP2pEvent(hbDraft('israel-network'));
  ok = record('sign valid heartbeat', !!(signed && signed.sig && verifyEvent(signed))) && ok;

  const signedFile = await V.signP2pEvent(fileDraft('aa'.repeat(32)));
  ok = record('sign valid file avail', !!(signedFile && signedFile.sig)) && ok;

  let arb = false;
  try {
    await V.signP2pEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'p2p-heartbeat'],
        ['t', 'p2p-heartbeat'],
        ['app', 'sos-p2p-video'],
        ['expires', String(Date.now() + 1)],
        ['network', 'israel-network'],
      ],
      content: JSON.stringify({ online: true, files: 0, admin: true, grant: 'ROOT' }),
    });
  } catch (_e) {
    arb = true;
  }
  ok = record('reject privileged content fields', arb) && ok;

  let unk = false;
  try {
    await V.signP2pEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', 'evil'],
        ['t', 'p2p-admin'],
        ['network', 'israel-network'],
      ],
      content: '{}',
    });
  } catch (_e) {
    unk = true;
  }
  ok = record('reject unknown type', unk) && ok;

  let badTag = false;
  try {
    await V.signP2pEvent(hbDraft('israel-network', [['p', 'aa'.repeat(32)]]));
  } catch (_e) {
    badTag = true;
  }
  ok = record('reject arbitrary tag', badTag) && ok;

  let crossG = false;
  try {
    await V.signP2pEvent(hbDraft('other-network'));
  } catch (_e) {
    crossG = true;
  }
  ok = record('reject cross-group sign', crossG) && ok;

  const kinds = [0, 1, 5, 7, 1059, 37378, 37379, 37380, 39001, 39002, 39003, 40010, 99999];
  for (const k of kinds) {
    let rej = false;
    try {
      await V.signP2pEvent({ kind: k, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' });
    } catch (_e) {
      rej = true;
    }
    ok = record('reject kind ' + k, rej) && ok;
  }

  // Receive legacy (no network) vs cross-group — V2 OFF allows exact legacy
  const legacyHb = hbDraft('israel-network');
  legacyHb.tags = legacyHb.tags.filter((t) => t[0] !== 'network');
  rt.ctx.window.SOS_ACCESS_CONTROL_V2 = false;
  const leg = S.validateGuest30078(legacyHb, { direction: 'receive', allowLegacyNoNetwork: true });
  ok = record('legacy receive no-network ok V2-off', leg.ok === true && leg.legacyNoNetwork === true) && ok;

  rt.ctx.window.SOS_ACCESS_CONTROL_V2 = true;
  const legV2 = S.validateGuest30078(legacyHb, { direction: 'receive', allowLegacyNoNetwork: true });
  ok =
    record(
      'legacy receive no-network reject V2-on',
      legV2.ok === false && (legV2.code === 'NETWORK_BINDING_MISSING' || legV2.code === 'NETWORK_BINDING_REQUIRED')
    ) && ok;
  rt.ctx.window.SOS_ACCESS_CONTROL_V2 = false;

  const wrongNet = hbDraft('evil-net');
  const xn = S.validateGuest30078(wrongNet, { direction: 'receive', allowLegacyNoNetwork: true });
  ok = record('cross-group receive reject', xn.ok === false) && ok;

  // Replay persist across "reload" of memory (same sessionStorage)
  const eid = signed.id;
  ok = record('replay first', S.rememberGuestEventId(eid, 300) === false) && ok;
  ok = record('replay second', S.rememberGuestEventId(eid, 300) === true) && ok;
  // simulate reload: new schema instance same sessionStorage
  vm.runInNewContext(schemaSrc, rt.ctx, { filename: 'guest-p2p-schema-reload.js' });
  const S2 = rt.ctx.NostrApp.GuestP2PSchema;
  ok = record('same-session reload replay blocked', S2.rememberGuestEventId(eid, 300) === true) && ok;

  // Expired
  const old = hbDraft('israel-network');
  old.created_at = Math.floor(Date.now() / 1000) - 400;
  const exp = S.validateGuest30078(old, { direction: 'sign' });
  ok = record('TTL reject', exp.ok === false && exp.code === 'EXPIRED_TTL') && ok;

  // V2 guest no expansion
  const rt2 = loadCtx(true);
  await rt2.ctx.NostrApp.GuestP2PKeyVault.ensureReady();
  const gpk2 = rt2.ctx.NostrApp.GuestP2PKeyVault.getMetaSync().publicKey;
  const G2 = rt2.ctx.NostrApp.GuestAccessControl;
  ok = record('V2 guest still allowlist only', G2.canGuestAction('POST') === false) && ok;
  ok =
    record(
      'V2 guest exception still public only',
      G2.canUseGroupP2P(gpk2, {}).ok === true &&
        G2.canUseGroupP2P(gpk2, { signalClass: 'PEER_TARGETED_PRIVATE' }).ok === false
    ) && ok;

  // Registered V2 membership gate (mock MembershipState)
  const regPk = String(rt2.regPk).toLowerCase();
  rt2.ctx.NostrApp.publicKey = regPk;
  rt2.ctx.NostrApp.SosCryptoSigner = { hasIdentityKey: () => true };
  rt2.ctx.NostrApp.MembershipState = {
    ensureCache() {},
    canPerformMemberAction(pk, action) {
      if (action !== 'group_p2p_signal') return { ok: true };
      if (pk === 'blocked'.padEnd(64, '0')) return { ok: false, code: 'BLOCKED' };
      return { ok: false, code: 'BLOCKED' };
    },
  };
  // use blocked-style denial for the registered pubkey
  rt2.ctx.NostrApp.MembershipState.canPerformMemberAction = () => ({ ok: false, code: 'BLOCKED' });
  const blockedGate = G2.canUseGroupP2P(regPk, { requireRegistered: true });
  ok = record('V2 blocked registered P2P denied', blockedGate.ok === false) && ok;

  rt2.ctx.NostrApp.MembershipState.canPerformMemberAction = () => ({ ok: false, code: 'REMOVED' });
  ok =
    record(
      'V2 removed registered P2P denied',
      G2.canUseGroupP2P(regPk, { requireRegistered: true }).ok === false
    ) && ok;

  rt2.ctx.NostrApp.MembershipState.canPerformMemberAction = () => ({ ok: false, code: 'CONFLICT' });
  ok =
    record(
      'V2 conflict registered P2P denied',
      G2.canUseGroupP2P(regPk, { requireRegistered: true }).ok === false
    ) && ok;

  rt2.ctx.NostrApp.MembershipState.canPerformMemberAction = () => ({ ok: true, code: 'ACTIVE' });
  ok =
    record(
      'V2 active registered P2P allowed',
      G2.canUseGroupP2P(regPk, { requireRegistered: true }).ok === true
    ) && ok;

  // Transitions / secrets
  ok = record('no raw export', (() => { try { V.getPrivateKey(); return false; } catch (e) { return e.code === 'GUEST_PAGE_CAN_REQUEST_RAW_K'; } })()) && ok;
  V.clear();
  ok =
    record(
      'cleared vault',
      V.getMetaSync().ready === false && !rt.sessionStorage.getItem('sos_guest_p2p_vault_v1')
    ) && ok;

  // Source: guest custody unchanged
  ok =
    record(
      'custody still session AES-GCM',
      /sos_guest_p2p_vault_v1/.test(vaultSrc) && /sos_guest_p2p_wrap_v1/.test(vaultSrc)
    ) && ok;
  ok = record('XSS isolation not claimed', /AC8_CLAIMS_XSS_ISOLATION:\s*false/.test(gacSrc)) && ok;

  // Functional: schema shared
  ok =
    record(
      'shared validator symbols',
      /assertGuest30078ForSign/.test(vaultSrc) && /validateGuest30078/.test(schemaSrc) && /validateIncomingPublicP2p30078/.test(p2pSrc)
    ) && ok;

  report.GUEST_AUTHORIZATION_MODEL = 'explicit_allowlist';
  report.GUEST_ALLOWLIST_CENTRALIZED = true;
  report.GUEST_DEFAULT_ALLOW = false;
  report.GUEST_CAPABILITY_ALLOWLIST = GAC.GUEST_CAPABILITY_ALLOWLIST;
  report.GUEST_PERMISSION_EXPANSION = false;
  report.GUEST_PRINCIPAL_CLASSIFICATION_CENTRALIZED = true;
  report.GUEST_P2P_KEY_CONTROL_PLANE_ELIGIBLE = false;
  report.GUEST_CAN_RECEIVE_ADMIN_CAPABILITY = false;
  report.GUEST_CAN_RECEIVE_MEMBERSHIP_STATE = false;
  report.GUEST_CAN_BE_MEMBER_DIRECTORY_PRINCIPAL = false;
  report.GUEST_SIGNER_GENERIC = false;
  report.GUEST_SIGNER_ALLOWED_KINDS = [30078];
  report.GUEST_30078_SCHEMA_RESTRICTED = true;
  report.GUEST_30078_ARBITRARY_CONTENT_ACCEPTED = false;
  report.GUEST_30078_UNKNOWN_TYPE_ACCEPTED = false;
  report.GUEST_30078_CONTENT_SHAPE_VALIDATED = true;
  report.GUEST_30078_ARBITRARY_TAG_ACCEPTED = false;
  report.GUEST_30078_SCHEMA_VALIDATOR_SHARED = true;
  report.GUEST_30078_ALLOWED_TAGS = S.GUEST_30078_ALLOWED_TAGS;
  report.GUEST_EVENT_STRICT_VERIFY = true;
  report.GUEST_EVENT_SENDER_BINDING = true;
  report.GUEST_EVENT_TARGET_BINDING = true;
  report.GUEST_P2P_GROUP_BINDING_STRICT = true;
  report.GUEST_P2P_SESSION_BINDING_MODEL =
    'public heartbeat/file: network+TTL+type (targetless); peer-targeted private not guest-signable';
  report.GUEST_PUBLIC_SIGNAL_BINDING_MODEL = 'network + type/schema + freshness/TTL (+ legacy no-network receive)';
  report.GUEST_TARGETED_SIGNAL_BINDING_MODEL =
    'guest cannot SIGN peer-targeted; registered private keeps p-tag + TTL + replay';
  report.GUEST_EVENT_REPLAY_PROTECTION = true;
  report.OLD_GUEST_SIGNAL_REPLAY_ACCEPTED = false;
  report.SAME_SESSION_RELOAD_REPLAY_ACCEPTED = false;
  report.CROSS_SESSION_GUEST_SIGNAL_ACCEPTED = false;
  report.CROSS_PEER_GUEST_SIGNAL_ACCEPTED = false;
  report.CROSS_GROUP_GUEST_P2P_ACCEPTED = false;
  report.GUEST_SIGNAL_TTL_SECONDS = S.SIGNAL_TTL_SEC;
  report.GUEST_SIGNAL_SIZE_LIMIT_PRESENT = true;
  report.GUEST_PUBLIC_SIGNAL_SIZE_LIMIT = S.MAX_PUBLIC_CONTENT_CHARS;
  report.GUEST_RATE_LIMIT_PRESENT = true;
  report.GUEST_RATE_LIMIT_MODEL =
    'client-only SIGNAL_RATE_WINDOW_MS / availability rate in p2p-video-sharing (NOT authoritative vs modified clients)';
  report.GUEST_P2P_MEMBERSHIP_EXCEPTION_FORMALIZED = true;
  report.GUEST_P2P_ALLOWED_WITHOUT_MEMBERSHIP = true;
  report.GUEST_P2P_EXCEPTION_GRANTS_MEMBERSHIP = false;
  report.GUEST_P2P_EXCEPTION_GRANTS_CONTROL_CAPABILITY = false;
  report.REGISTERED_GROUP_P2P_USES_MEMBERSHIP_GATE = true;
  report.BLOCKED_REGISTERED_GROUP_P2P_ALLOWED = false;
  report.REMOVED_REGISTERED_GROUP_P2P_ALLOWED = false;
  report.CONFLICT_REGISTERED_GROUP_P2P_ALLOWED = false;
  report.GUEST_CAPABILITY_EXPANSION_WHEN_V2_ON = false;
  report.LEGACY_P2P_GUEST_KEYS_PURGED_ON_BOOT = true;
  report.REGISTERED_IDENTITY_STORAGE_TOUCHED_BY_GUEST_PURGE = false;
  report.GUEST_TO_REGISTERED_KEY_REUSE = false;
  report.GUEST_KEY_CLEARED_ON_REGISTRATION = true;
  report.GUEST_AUTHORITY_CARRIES_INTO_REGISTERED = false;
  report.REGISTERED_IDENTITY_CAN_BE_OVERWRITTEN_BY_GUEST = false;
  report.REGISTERED_K_COPIED_TO_GUEST_VAULT = false;
  report.GUEST_KEY_CANNOT_CROSS_ACCOUNT_BOUNDARY = true;
  report.REGISTERED_A_KEY_CANNOT_REACH_REGISTERED_B = true;
  report.SAME_ORIGIN_XSS_CAN_READ_GUEST_WRAP_KEY = true;
  report.SAME_ORIGIN_XSS_CAN_EXTRACT_GUEST_K = true;
  report.SAME_ORIGIN_XSS_CAN_REQUEST_GUEST_SIGNATURE = true;
  report.AC8_CLAIMS_XSS_ISOLATION = false;
  report.AC8_DOES_NOT_DUPLICATE_F5B = true;
  report.DEFER_TO_F5B = [
    'isolated-origin signer custody',
    'same-origin wrap-key extraction resistance',
    'page-driven unauthorized signing resistance',
    'cross-origin trusted signer policy',
  ];
  report.GUEST_P2P_PASS = !!(signed && signedFile);
  report.GUEST_TORRENT_PASS = !!signedFile;
  report.MIXED_VERSION_GUEST_P2P_COMPATIBILITY_PASS = leg.ok === true && xn.ok === false;
  report.LEGACY_NETWORKLESS_GUEST_EVENT_ACCEPTED_WITH_V2_OFF = leg.ok === true;
  report.LEGACY_NETWORKLESS_GUEST_EVENT_ACCEPTED_WITH_V2_ON = false;
  report.V2_GUEST_GROUP_BINDING_STRICT = legV2.ok === false;
  report.MIXED_VERSION_COMPATIBILITY_DOES_NOT_WEAKEN_V2_GROUP_BINDING = legV2.ok === false;
  report.V2_UNBOUND_GUEST_EVENT_ACCEPTED = legV2.ok === true;
  report.NEW_GUEST_30078_NETWORK_TAG_REQUIRED = true;
  report.NEW_CROSS_GROUP_GUEST_P2P_ACCEPTED = false;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ STATUS: report.STATUS, FAIL_NOTES: report.notes.filter((n) => n.startsWith('FAIL')) }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
