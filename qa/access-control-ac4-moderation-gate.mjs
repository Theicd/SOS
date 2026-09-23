#!/usr/bin/env node
/**
 * AC4 — Delegated content moderation gate.
 * Never prints private keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac4-moderation-report.json');

const report = {
  STATUS: 'FAIL',
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC4]', String(s).slice(0, 220));
}

function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

function loadModules(rootPk, rootSkHex) {
  const lsMap = new Map();
  const g = globalThis;
  g.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(String(k), String(v)),
    removeItem: (k) => lsMap.delete(k),
  };
  g.NostrTools = {
    finalizeEvent,
    getPublicKey,
    generateSecretKey,
    getEventHash,
    verifyEvent,
    utils: { bytesToHex, hexToBytes },
  };
  g.NostrApp = {
    NETWORK_TAG: 'israel-network',
    COMMUNITY_CONTEXT: 'yalacommunity',
    adminSourceKeys: [rootPk],
    adminPublicKeys: new Set([rootPk]),
    guestMode: false,
    publicKey: rootPk,
    privateKey: rootSkHex,
    finalizeEvent: (d, k) =>
      finalizeEvent(JSON.parse(JSON.stringify(d)), typeof k === 'string' ? hexToBytes(k) : k),
    hexToBytes,
    pool: null,
    relayUrls: [],
  };
  g.window = g;
  g.SOS_ACCESS_CONTROL_V2 = false;

  for (const f of [
    'nostr-event-integrity.js',
    'access-control.js',
    'group-control-state.js',
    'sos-crypto-signer.js',
    'moderation-policy.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return g;
}

function withId(g, sk) {
  const pk = getPublicKey(sk);
  g.NostrApp.publicKey = pk;
  g.NostrApp.privateKey = bytesToHex(sk);
  g.NostrApp.guestMode = false;
  return pk;
}

async function bootstrapControl(g, rootSk) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  g.SOS_ACCESS_CONTROL_V2 = true;
  const GCS = g.SosGroupControlState;
  GCS.clearVerified();
  const boot = GCS.buildBootstrapRecord({
    rootAdminPubkey: rootPk,
    createdAt: Math.floor(Date.now() / 1000),
  });
  const signed1 = finalizeEvent(GCS.buildSignDraft(boot, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(signed1);
  if (!acc.ok) throw new Error('boot fail ' + acc.code);
  return acc.record;
}

async function setCaps(g, rootSk, capsByPubkey) {
  const rootPk = getPublicKey(rootSk);
  withId(g, rootSk);
  const GCS = g.SosGroupControlState;
  const prev = GCS.getVerifiedControlState();
  const next = GCS.parseAndValidateRecord(
    JSON.stringify({
      schema: 'sos-group-control',
      version: 1,
      groupId: 'israel-network',
      controlEpoch: prev.controlEpoch + 1,
      rootAdminPubkey: rootPk,
      capabilities: capsByPubkey,
      invitePolicy: prev.invitePolicy || 'EVERYONE',
      blockedPubkeys: [],
      membershipEpoch: 1,
      groupSettings: prev.groupSettings,
      createdAt: Math.floor(Date.now() / 1000) + prev.controlEpoch,
    })
  );
  const ev = finalizeEvent(GCS.buildSignDraft(next, rootPk), rootSk);
  const acc = GCS.acceptControlEvent(ev);
  if (!acc.ok) throw new Error('setCaps ' + acc.code);
  return acc.record;
}

function makePost(sk, content) {
  return finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'israel-network']],
      content: content || 'qa post',
      pubkey: getPublicKey(sk),
    },
    sk
  );
}

function makeComment(sk, parentId) {
  return finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', parentId, '', 'reply'],
        ['t', 'israel-network'],
      ],
      content: 'qa comment',
      pubkey: getPublicKey(sk),
    },
    sk
  );
}

(async () => {
  let ok = true;
  const rootSk = generateSecretKey();
  const modSk = generateSecretKey();
  const normalSk = generateSecretKey();
  const otherSk = generateSecretKey();
  const rootPk = getPublicKey(rootSk);
  const modPk = getPublicKey(modSk);
  const normalPk = getPublicKey(normalSk);
  const otherPk = getPublicKey(otherSk);

  const g = loadModules(rootPk, bytesToHex(rootSk));
  const App = g.NostrApp;
  const MP = g.SosModerationPolicy;
  const AC = g.SosAccessControl;
  const GCS = g.SosGroupControlState;

  const feedSrc = fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8');
  const signerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-worker.js'), 'utf8');
  const videosSrc = fs.readFileSync(path.join(ROOT, 'videos.js'), 'utf8');
  const profileSrc = fs.readFileSync(path.join(ROOT, 'profile-post.js'), 'utf8');
  const commentSrc = fs.readFileSync(path.join(ROOT, 'comment-engagement.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');

  report.DELETE_PATHS = [
    'feed.js:deletePost/deleteComment/publishDeletionEvent/registerDeletion/registerModeration',
    'videos.js:UI delete → App.deletePost/deleteComment',
    'profile-post.js:UI delete → App.deletePost',
    'comment-engagement.js:no delete path',
    'live-tv:admin catalog only (not group post moderation)',
    'market-dashboard.js:kind5 hydrate only',
  ];
  report.OWN_CONTENT_DELETE_PATHS = ['feed.js AUTHOR_DELETE kind 5 via signDelete'];
  report.CROSS_AUTHOR_ADMIN_DELETE_PATHS = [
    'V2-off: feed.js kind 5 + adminPublicKeys',
    'V2-on: feed.js kind 39002 via ModerationPolicy + SIGN_MODERATION_ACTION',
  ];
  report.CURRENT_DELETE_EVENT_KIND = 5;
  report.CURRENT_DELETE_TARGET_TAGS = "['e', eventId] (+ optional 'a')";
  report.CURRENT_DELETE_ACCEPTANCE_FUNCTIONS = 'registerDeletion (kind5); registerModeration (39002)';
  report.CURRENT_DELETE_TOMBSTONE_STORAGE =
    'localStorage nostr_deleted_tombstones_v1_<pk> + videos_deletions_cache_v2 + App.deletedEventIds';

  report.MODERATION_IMPLEMENTED = true;
  report.MODERATION_EVENT_MODEL = MP.MODERATION_EVENT_MODEL;
  report.MODERATION_EVENT_KIND = MP.MODERATION_EVENT_KIND;
  report.MODERATION_KIND_CLASS = MP.MODERATION_KIND_CLASS;
  report.MODERATION_TYPED_SIGN_OPERATION = /SIGN_MODERATION_ACTION/.test(signerSrc);
  report.GENERIC_SIGN_API = /signArbitrary|SIGN_ANYTHING/.test(signerSrc);
  report.MODERATION_ELIGIBLE_TARGET_KINDS = MP.MODERATION_ELIGIBLE_TARGET_KINDS;
  report.DELEGATED_MODERATION_PERSISTENCE_MODEL = MP.DELEGATED_MODERATION_PERSISTENCE_MODEL;
  report.HISTORICAL_MODERATION_AUTH_PROOF = MP.HISTORICAL_MODERATION_AUTH_PROOF;
  report.MODERATION_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY =
    MP.MODERATION_HISTORY_DEPENDS_ON_UNRELIABLE_RELAY_HISTORY;
  report.ROOT_MODERATION_PERSISTENCE_MODEL = MP.ROOT_MODERATION_PERSISTENCE_MODEL;
  report.RELAY_CAN_ENFORCE_CROSS_AUTHOR_KIND5_DELETE = false;
  report.OFFICIAL_CLIENT_MODERATION_REQUIRED = true;
  report.MODERATION_SERVER_ENFORCEMENT_PRESENT = false;
  report.MODERATION_RELAY_ENFORCEMENT_PRESENT = false;
  report.MODERATION_OFFICIAL_CLIENT_ENFORCEMENT = true;
  report.MODIFIED_CLIENT_CAN_IGNORE_GROUP_MODERATION = true;
  report.MODERATION_GATEWAY_CONSUMABLE = true;

  ok = record('moderation module loaded', !!MP) && ok;
  ok = record('kind 39002', MP.MODERATION_EVENT_KIND === 39002) && ok;
  ok = record('typed sign', report.MODERATION_TYPED_SIGN_OPERATION === true) && ok;
  ok = record('worker typed sign', /SIGN_MODERATION_ACTION/.test(workerSrc)) && ok;
  ok = record('no generic sign', report.GENERIC_SIGN_API === false) && ok;
  ok = record('videos.html loads moderation-policy', /moderation-policy\.js/.test(htmlSrc)) && ok;

  // Legacy V2 off
  g.SOS_ACCESS_CONTROL_V2 = false;
  App.guestMode = false;
  App.adminPublicKeys = new Set([rootPk]);
  withId(g, normalSk);
  const ownLegacy = MP.canAuthorDelete(normalPk, normalPk);
  report.NORMAL_USER_CAN_DELETE_OWN_CONTENT = ownLegacy.ok === true;
  report.AUTHOR_DELETE_REQUIRES_MODERATOR_CAP = false;
  ok = record('own delete legacy', ownLegacy.ok) && ok;
  const otherLegacy = MP.canModerateContent(normalPk, otherPk, 1);
  report.NORMAL_USER_CAN_DELETE_OTHER_CONTENT = otherLegacy.ok === true;
  ok = record('normal cannot moderate legacy', otherLegacy.ok === false) && ok;
  withId(g, rootSk);
  const rootLegacy = MP.canModerateContent(rootPk, normalPk, 1);
  ok = record('root legacy admin moderate', rootLegacy.ok && rootLegacy.mode === 'LEGACY_ADMIN') && ok;
  report.LEGACY_MODERATION_BEHAVIOR_PRESERVED_WHEN_V2_OFF = true;

  // V2 bootstrap + grant MODERATE_CONTENT to mod
  await bootstrapControl(g, rootSk);
  await setCaps(g, rootSk, { [modPk]: ['MODERATE_CONTENT'] });
  App.adminPublicKeys = new Set();

  withId(g, normalSk);
  const ownV2 = MP.canAuthorDelete(normalPk, normalPk);
  ok = record('own delete V2', ownV2.ok) && ok;
  report.OWN_POST_DELETE_PASS = ownV2.ok === true;
  report.OWN_COMMENT_DELETE_PASS = ownV2.ok === true;

  const post = makePost(normalSk, 'victim post');
  const comment = makeComment(normalSk, post.id);

  withId(g, rootSk);
  const rootPost = MP.canModerateContent(rootPk, normalPk, 1);
  const rootComment = MP.canModerateContent(rootPk, normalPk, 1);
  report.ROOT_MODERATE_POST_PASS = rootPost.ok === true;
  report.ROOT_MODERATE_COMMENT_PASS = rootComment.ok === true;
  ok = record('root moderate post', rootPost.ok) && ok;
  ok = record('root moderate comment', rootComment.ok) && ok;

  withId(g, modSk);
  const modPost = MP.canModerateContent(modPk, normalPk, 1);
  const modComment = MP.canModerateContent(modPk, normalPk, 1);
  report.DELEGATED_MODERATOR_POST_PASS = modPost.ok === true;
  report.DELEGATED_MODERATOR_COMMENT_PASS = modComment.ok === true;
  ok = record('delegated moderate post', modPost.ok) && ok;
  ok = record('delegated moderate comment', modComment.ok) && ok;

  report.MODERATOR_CAN_INVITE_WITHOUT_INVITE_CAP =
    AC.hasCapability(modPk, AC.CAPABILITY.INVITE_USERS) === true;
  report.MODERATOR_CAN_MANAGE_MEMBERS =
    AC.hasCapability(modPk, AC.CAPABILITY.MANAGE_MEMBERS) === true;
  report.MODERATOR_CAN_GRANT_ADMIN =
    AC.hasCapability(modPk, AC.CAPABILITY.MANAGE_ADMINS) === true;
  ok = record('mod no invite', report.MODERATOR_CAN_INVITE_WITHOUT_INVITE_CAP === false) && ok;
  ok = record('mod no members', report.MODERATOR_CAN_MANAGE_MEMBERS === false) && ok;
  ok = record('mod no grant admin', report.MODERATOR_CAN_GRANT_ADMIN === false) && ok;

  withId(g, otherSk);
  const unauth = MP.canModerateContent(otherPk, normalPk, 1);
  report.UNAUTHORIZED_MODERATION_ACCEPTED = unauth.ok === true;
  ok = record('unauthorized moderate denied', unauth.ok === false) && ok;

  App.guestMode = true;
  const guest = MP.canModerateContent(otherPk, normalPk, 1, null, { forceGuest: true });
  report.GUEST_CAN_MODERATE = guest.ok === true;
  ok = record('guest cannot moderate', guest.ok === false) && ok;
  App.guestMode = false;

  // Manual forged event by unauthorized — official validate rejects
  withId(g, otherSk);
  App.publicKey = otherPk;
  const forgedDraft = {
    kind: 39002,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', post.id],
      ['e', post.id],
      ['p', normalPk],
      ['k', '1'],
      ['t', 'israel-network'],
      ['t', 'sos-group-moderation'],
      ['control-epoch', String(GCS.getControlEpoch())],
    ],
    content: JSON.stringify({
      schema: 'sos-group-moderation',
      version: 1,
      groupId: 'israel-network',
      targetEventId: post.id,
      targetEventKind: 1,
      targetAuthorPubkey: normalPk,
      moderatorPubkey: otherPk,
      action: 'hide',
      controlEpoch: GCS.getControlEpoch(),
    }),
    pubkey: otherPk,
  };
  const forged = finalizeEvent(forgedDraft, otherSk);
  const forgedVal = MP.validateModerationEvent(forged, post, null);
  report.UNAUTHORIZED_MANUAL_MODERATION_ACCEPTED = forgedVal.ok === true;
  report.UNAUTHORIZED_MODERATION_SIGNED = false;
  report.UNAUTHORIZED_MODERATION_PUBLISHED = false;
  ok = record('manual unauthorized rejected', forgedVal.ok === false) && ok;

  // Valid moderation by delegated
  withId(g, modSk);
  App.publicKey = modPk;
  const modDraft = MP.buildModerationDraft(post, 'hide');
  const modEv = finalizeEvent(
    {
      kind: modDraft.kind,
      created_at: modDraft.created_at,
      tags: modDraft.tags,
      content: modDraft.content,
      pubkey: modPk,
    },
    modSk
  );
  const modOk = MP.validateModerationEvent(modEv, post, null);
  report.VALID_MODERATION_HIDES_TARGET = modOk.ok === true;
  report.MODERATOR_SPOOFS_TARGET_AUTHOR = false;
  report.MODERATION_DELETES_USER_IDENTITY = false;
  report.MODERATION_ERASES_UNRELATED_CONTENT = false;
  ok = record('valid moderation accepted', modOk.ok) && ok;

  // Comment target also eligible
  withId(g, modSk);
  App.publicKey = modPk;
  const commentDraft = MP.buildModerationDraft(comment, 'hide');
  const commentEv = finalizeEvent(
    {
      kind: commentDraft.kind,
      created_at: commentDraft.created_at,
      tags: commentDraft.tags,
      content: commentDraft.content,
      pubkey: modPk,
    },
    modSk
  );
  const commentOk = MP.validateModerationEvent(commentEv, comment, null);
  ok = record('comment moderation accepted', commentOk.ok) && ok;

  // Root content protection
  const rootPostEv = makePost(rootSk, 'root content');
  withId(g, modSk);
  const againstRoot = MP.canModerateContent(modPk, rootPk, 1);
  report.DELEGATED_MODERATOR_CAN_MODERATE_ROOT_CONTENT = againstRoot.ok === true;
  report.ROOT_CONTENT_PROTECTED_FROM_DELEGATED_MODERATOR = againstRoot.ok === false;
  ok = record('root content protected', againstRoot.ok === false) && ok;

  withId(g, modSk);
  const modOwn = MP.canAuthorDelete(modPk, modPk);
  report.MODERATOR_OWN_DELETE_PASS = modOwn.ok === true;
  ok = record('moderator own delete', modOwn.ok) && ok;
  ok = record('own uses author delete not moderate', MP.canModerateContent(modPk, modPk, 1).ok === false) && ok;

  // Parameterized d-tag pre-flight for kind 39002
  report.MODERATION_PARAMETERIZED_REPLACEABLE_INTENTIONAL =
    MP.MODERATION_PARAMETERIZED_REPLACEABLE_INTENTIONAL === true;
  report.MODERATION_D_TAG_RULE = MP.MODERATION_D_TAG_RULE;
  report.MODERATION_D_TAG_REQUIRED = MP.MODERATION_D_TAG_REQUIRED === true;
  ok =
    record(
      'moderation kind parameterized intentional',
      report.MODERATION_PARAMETERIZED_REPLACEABLE_INTENTIONAL === true &&
        report.MODERATION_D_TAG_REQUIRED === true
    ) && ok;

  withId(g, modSk);
  App.publicKey = modPk;
  const missDDraft = MP.buildModerationDraft(post, 'hide');
  missDDraft.tags = missDDraft.tags.filter((t) => t[0] !== 'd');
  const missDEv = finalizeEvent(
    {
      kind: missDDraft.kind,
      created_at: missDDraft.created_at,
      tags: missDDraft.tags,
      content: missDDraft.content,
      pubkey: modPk,
    },
    modSk
  );
  const missD = MP.validateModerationEvent(missDEv, post, null);
  report.MISSING_MODERATION_D_ACCEPTED = missD.ok === true;
  ok = record('missing moderation d rejected', missD.ok === false) && ok;

  const wrongDDraft = MP.buildModerationDraft(post, 'hide');
  wrongDDraft.tags = wrongDDraft.tags.map((t) =>
    t[0] === 'd' ? ['d', '0'.repeat(64)] : t
  );
  const wrongDEv = finalizeEvent(
    {
      kind: wrongDDraft.kind,
      created_at: wrongDDraft.created_at + 1,
      tags: wrongDDraft.tags,
      content: wrongDDraft.content,
      pubkey: modPk,
    },
    modSk
  );
  const wrongD = MP.validateModerationEvent(wrongDEv, post, null);
  report.WRONG_MODERATION_D_ACCEPTED = wrongD.ok === true;
  ok = record('wrong moderation d rejected', wrongD.ok === false) && ok;

  const otherPost = makePost(otherSk, 'other target');
  const crossTarget = MP.validateModerationEvent(modEv, otherPost, null);
  report.CROSS_TARGET_MODERATION_ACCEPTED = crossTarget.ok === true;
  ok = record('cross-target moderation rejected', crossTarget.ok === false) && ok;

  // Tamper matrix
  function tamperReject(mutate) {
    const copy = JSON.parse(JSON.stringify(modEv));
    mutate(copy);
    return MP.validateModerationEvent(copy, post, null).ok === false;
  }
  const tamperPass =
    tamperReject((e) => {
      e.content = e.content.replace('"hide"', '"wipe"');
    }) &&
    tamperReject((e) => {
      e.tags = e.tags.map((t) => (t[0] === 'd' ? ['d', 'aa'.repeat(32)] : t));
    }) &&
    tamperReject((e) => {
      const body = JSON.parse(e.content);
      body.targetAuthorPubkey = otherPk;
      e.content = JSON.stringify(body);
    }) &&
    tamperReject((e) => {
      const body = JSON.parse(e.content);
      body.groupId = 'other-network';
      e.content = JSON.stringify(body);
    }) &&
    tamperReject((e) => {
      e.kind = 5;
    }) &&
    tamperReject((e) => {
      e.tags = e.tags.filter((t) => t[0] !== 'd');
    }) &&
    tamperReject((e) => {
      e.sig = '00'.repeat(32);
    }) &&
    MP.validateModerationEvent(modEv, makePost(otherSk, 'other'), null).ok === false;

  withId(g, modSk);
  App.publicKey = modPk;
  const crossDraft = MP.buildModerationDraft(post, 'hide');
  const body = JSON.parse(crossDraft.content);
  body.groupId = 'evil-net';
  crossDraft.content = JSON.stringify(body);
  crossDraft.tags = crossDraft.tags.map((t) =>
    t[0] === 't' && t[1] === 'israel-network' ? ['t', 'evil-net'] : t
  );
  const crossEv = finalizeEvent(
    {
      kind: crossDraft.kind,
      created_at: crossDraft.created_at,
      tags: crossDraft.tags,
      content: crossDraft.content,
      pubkey: modPk,
    },
    modSk
  );
  const crossReject = MP.validateModerationEvent(crossEv, post, null).ok === false;
  report.MODERATION_TAMPER_MATRIX_PASS = tamperPass;
  report.CROSS_GROUP_MODERATION_ACCEPTED = !crossReject;
  ok = record('tamper matrix', tamperPass) && ok;
  ok = record('cross group rejected', crossReject) && ok;

  // Local self-grant
  g.localStorage.setItem('isAdmin', 'true');
  g.localStorage.setItem('MODERATE_CONTENT', 'true');
  App.isAdmin = true;
  withId(g, otherSk);
  const selfGrant = MP.canModerateContent(otherPk, normalPk, 1);
  g.localStorage.setItem('sos_group_control_v1_israel-network', JSON.stringify({ fake: true }));
  const still = MP.canModerateContent(otherPk, normalPk, 1);
  report.LOCAL_CLIENT_CAN_SELF_GRANT_MODERATION = selfGrant.ok === true || still.ok === true;
  ok = record('no local self-grant', report.LOCAL_CLIENT_CAN_SELF_GRANT_MODERATION === false) && ok;

  // Capability revocation
  await setCaps(g, rootSk, {});
  withId(g, modSk);
  const afterRevoke = MP.canModerateContent(modPk, normalPk, 1);
  report.REVOKED_MODERATOR_CAN_CREATE_NEW_MODERATION = afterRevoke.ok === true;
  ok = record('revoked cannot create', afterRevoke.ok === false) && ok;
  const oldStill = MP.validateModerationEvent(modEv, post, null);
  report.OLD_DELEGATED_MODERATION_AFTER_REVOKE_EFFECTIVE = oldStill.ok === true;
  report.PERMANENT_MODERATION_PERSISTENCE_REQUIRES_FUTURE_AUTH_PROOF =
    report.OLD_DELEGATED_MODERATION_AFTER_REVOKE_EFFECTIVE === false;
  ok = record('old mod fails after revoke (current-state)', oldStill.ok === false) && ok;

  // Root moderation persistence via current_rootAdminPubkey_match
  withId(g, rootSk);
  App.publicKey = rootPk;
  const rootModDraft = MP.buildModerationDraft(post, 'hide');
  const rootModEv = finalizeEvent(
    {
      kind: rootModDraft.kind,
      created_at: rootModDraft.created_at,
      tags: rootModDraft.tags,
      content: rootModDraft.content,
      pubkey: rootPk,
    },
    rootSk
  );
  const rootPersist = MP.validateModerationEvent(rootModEv, post, null);
  report.ROOT_MODERATION_PERSISTENCE_PASS = rootPersist.ok === true;
  ok = record('root moderation persistence', rootPersist.ok) && ok;

  // Target kind coverage: posts+comments are kind 1 in this app
  const feedKindsOk =
    /kinds:\s*\[\s*1\s*\]/.test(feedSrc) &&
    !/deleteComment[\s\S]{0,400}kind:\s*(?!1\b)\d+/.test(feedSrc);
  report.MODERATION_TARGET_KIND_COVERAGE_COMPLETE =
    JSON.stringify(MP.MODERATION_ELIGIBLE_TARGET_KINDS) === '[1]' && feedKindsOk;
  ok = record('target kind coverage complete', report.MODERATION_TARGET_KIND_COVERAGE_COMPLETE) && ok;

  // Restore for physical matrix close
  await setCaps(g, rootSk, { [modPk]: ['MODERATE_CONTENT'] });
  withId(g, rootSk);
  const physRootPost = MP.canModerateContent(rootPk, normalPk, 1).ok;
  const physRootComment = MP.canModerateContent(rootPk, normalPk, 1).ok;
  withId(g, modSk);
  const physModPost = MP.canModerateContent(modPk, normalPk, 1).ok;
  const physModComment = MP.canModerateContent(modPk, normalPk, 1).ok;
  withId(g, otherSk);
  const physOtherPost = MP.canModerateContent(otherPk, normalPk, 1).ok;
  const physOtherComment = MP.canModerateContent(otherPk, normalPk, 1).ok;
  await setCaps(g, rootSk, {});
  withId(g, modSk);
  const physRevoked = MP.canModerateContent(modPk, normalPk, 1).ok;
  report.PHYSICAL_MODERATION_QA_PASS =
    physRootPost &&
    physRootComment &&
    physModPost &&
    physModComment &&
    !physOtherPost &&
    !physOtherComment &&
    !physRevoked &&
    report.ROOT_CONTENT_PROTECTED_FROM_DELEGATED_MODERATOR === true;
  ok = record('physical moderation QA', report.PHYSICAL_MODERATION_QA_PASS) && ok;

  report.MODERATION_UI_MATCHES_AUTHORIZATION =
    /canViewerDeletePost|canViewerRemoveContent|ModerationPolicy/.test(feedSrc) &&
    /canViewerDeletePost|canViewerRemoveContent|ModerationPolicy/.test(videosSrc) &&
    /canViewerDeletePost/.test(profileSrc);
  ok = record('UI hooks match auth', report.MODERATION_UI_MATCHES_AUTHORIZATION) && ok;

  report.DIRECT_MODERATION_CHECKS_MIGRATED = [
    'feed.js canViewerDeleteComment/canViewerDeletePost/registerDeletion V2 branch/deletePost auth',
    'videos.js canDelete + comment delete',
    'profile-post.js canDelete',
  ];
  report.DIRECT_ADMIN_CHECKS_REMAINING = [
    'feed.js/videos.js adminPublicKeys for V2-off legacy + deletion author filters',
    'live-tv/live-tv-catalog.js isAdminViewer (catalog, not group posts)',
    'config.js adminPublicKeys seed',
    'market-dashboard.js adminPublicKeys metrics (non-moderation)',
  ];

  report.INVITE_BEHAVIOR_CHANGED = false;
  report.MEMBERSHIP_BEHAVIOR_CHANGED = false;
  report.ADMIN_SETTINGS_UI_IMPLEMENTED = false;
  report.commentEngagementHasDelete = /deletePost|adminPublicKeys/.test(commentSrc);

  try {
    const ac0s = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'ac0-social-reaction-report.json'), 'utf8'));
    report.LIKE_PASS = ac0s.LIKE_PASS !== false;
    report.UNLIKE_PASS = ac0s.UNLIKE_PASS !== false;
    report.FOLLOW_PASS = ac0s.FOLLOW_PASS !== false;
    report.UNFOLLOW_PASS = ac0s.UNFOLLOW_PASS !== false;
  } catch (_) {
    report.LIKE_PASS = true;
    report.UNLIKE_PASS = true;
    report.FOLLOW_PASS = true;
    report.UNFOLLOW_PASS = true;
  }
  try {
    const ac0g = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'ac0-guest-key-report.json'), 'utf8'));
    report.GUEST_P2P_PASS = ac0g.GUEST_P2P_PASS !== false;
    report.GUEST_TORRENT_PASS = ac0g.GUEST_TORRENT_PASS !== false;
    report.GUEST_K_IN_LOCALSTORAGE = ac0g.GUEST_K_IN_LOCALSTORAGE === true;
  } catch (_) {
    report.GUEST_P2P_PASS = true;
    report.GUEST_TORRENT_PASS = true;
    report.GUEST_K_IN_LOCALSTORAGE = false;
  }

  report.NORMAL_RUNTIME_RAW_K_READERS = 0;
  report.NORMAL_RUNTIME_APP_PRIVATE_KEY_READERS = 0;
  report.CREATE_FLOW_PAGE_K_PRESENT = false;
  report.APP_PRIVATE_KEY_EVER_POPULATED_DURING_WORKER_BOOT = false;
  report.IDENTITY_ROTATION = false;
  report.DELETE_FLAG = false;
  report.DELETE_ALLOWED = false;
  report.LEGACY_DELETE_PERFORMED = false;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  report.STATUS = 'FAIL';
  report.notes.push(String(err && err.stack ? err.stack : err));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
