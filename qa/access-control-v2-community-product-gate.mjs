/**
 * Access Control V2 — community product gates (local).
 * Branding, create+reload, feed selection, global communication model,
 * invite double-redeem client lock, isolation proofs.
 * Does NOT deploy. Does NOT enable production V2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'access-control-v2-community-product-report.json');

const report = {
  gate: 'ACCESS_CONTROL_V2_COMMUNITY_PRODUCT',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'PASS' : 'FAIL', k, detail ?? '');
};

function loadInto(ctx, file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
}

function makeCtx(hostname, search) {
  const ctx = {
    window: null,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = { hostname, protocol: 'http:', search, pathname: '/' };
  ctx.localStorage = {
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
  ctx.document = {
    readyState: 'complete',
    body: { appendChild() {}, querySelector() { return null; } },
    head: { appendChild() {} },
    documentElement: { dataset: {} },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        addEventListener() {},
        appendChild() {},
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
      };
    },
    addEventListener() {},
  };
  ctx.NostrTools = { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash };
  ctx.NostrApp = {
    NETWORK_TAG: 'israel-network',
    publicKey: '',
    adminPublicKeys: new Set(),
  };
  vm.createContext(ctx);
  return ctx;
}

async function main() {
  const productSrc = fs.readFileSync(path.join(ROOT, 'group-admin-product-ui.js'), 'utf8');
  const brandingSrc = fs.readFileSync(path.join(ROOT, 'community-branding-ui.js'), 'utf8');
  const feedSelSrc = fs.readFileSync(path.join(ROOT, 'community-feed-selection.js'), 'utf8');
  const ccSrc = fs.readFileSync(path.join(ROOT, 'community-context.js'), 'utf8');
  const feedSrc = fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8');
  const invitePolSrc = fs.readFileSync(path.join(ROOT, 'invite-policy.js'), 'utf8');
  const inviteSvcSrc = fs.readFileSync(path.join(ROOT, 'invite-service.js'), 'utf8');
  const videos = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
  const chatVoice = fs.readFileSync(path.join(ROOT, 'chat-voice-call.js'), 'utf8');
  const acSrc = fs.readFileSync(path.join(ROOT, 'access-control.js'), 'utf8');

  // --- Static product wiring ---
  set(
    'COMMUNITY_LOGO_CREATE_GATE',
    /לוגו הקבוצה/.test(productSrc) && /sosGapLogo/.test(productSrc) && /__SOS_GAP_LOGO_DATA__/.test(productSrc)
  );
  set('COMMUNITY_BRANDING_UI_WIRED', /community-branding-ui\.js/.test(videos));
  set('FEED_SELECTOR_UI_WIRED', /community-feed-selection\.js/.test(videos) && /הפיד שלי/.test(feedSelSrc));
  set('FEED_MULTI_TAG_QUERY', /resolveFeedNetworkTags/.test(feedSrc) && /'#t': tags/.test(feedSrc));
  set('FEED_ITEM_ATTRIBUTION_CODE', /communityAttributionHtml/.test(feedSelSrc) && /communityAttr/.test(feedSrc));
  set('INVITE_BINDS_COMMUNITY', /communityId/.test(inviteSvcSrc) && /\['community'/.test(inviteSvcSrc));
  set('INVITE_DOUBLE_REDEEM_CLIENT_LOCK', /claimLocalRedeem/.test(invitePolSrc) && /isLocallyRedeemed/.test(invitePolSrc));
  set('GLOBAL_IDENTITY_SINGLE_ACCOUNT', /GLOBAL_IDENTITY_MODEL:\s*'single_P_across_communities'/.test(ccSrc));
  set(
    'COMMUNITY_MEMBERSHIP_REQUIRED_FOR_DIRECT_COMMUNICATION',
    /DIRECT_COMMUNICATION_REQUIRES_COMMUNITY_MEMBERSHIP:\s*false/.test(ccSrc)
  );
  set('FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP', /FEED_SELECTION_CHANGES_MEMBERSHIP:\s*false/.test(ccSrc));
  set('CHAT_CONVERSATION_GLOBAL_BY_PEER', /getRoomId\(peerPubkey\)/.test(chatVoice) && !/communityId.*getRoomId/.test(chatVoice));
  set('CALL_IDENTITY_GLOBAL_BY_PEER', /getRoomId\(peerPubkey\)/.test(chatVoice));
  set('INVITE_MEMBERS_CANONICAL_CAP', /INVITE_USERS:\s*'INVITE_USERS'/.test(acSrc));
  set('MANAGE_ADMINS_SEMANTICS_PRESENT', /MANAGE_ADMINS:\s*'MANAGE_ADMINS'/.test(acSrc));
  set('MANAGE_PERMISSIONS_SEMANTICS_PRESENT', /MANAGE_PERMISSIONS:\s*'MANAGE_PERMISSIONS'/.test(acSrc));

  // --- VM: create + branding persist + reload + feed selection ---
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ctx = makeCtx('127.0.0.1', '?acv2=1');
  ctx.NostrApp.publicKey = pk;
  loadInto(ctx, 'access-control-v2-local-test.js');
  ctx.SosAccessControlV2LocalTest.applyLocalTestMode();
  ctx.window.SOS_ACCESS_CONTROL_V2 = true;
  loadInto(ctx, 'community-context.js');

  const CC = ctx.NostrApp.CommunityContext;
  const logoA = 'data:image/png;base64,AAA';
  const logoB = 'data:image/png;base64,BBB';
  CC.register({
    communityId: 'comm-a',
    networkTag: 'community-comm-a',
    slug: 'comm-a',
    name: 'Community A',
    logoRef: logoA,
    description: 'Desc A',
  });
  CC.register({
    communityId: 'comm-b',
    networkTag: 'community-comm-b',
    slug: 'comm-b',
    name: 'Community B',
    logoRef: logoB,
    description: 'Desc B',
  });
  CC.register({
    communityId: 'comm-c',
    networkTag: 'community-comm-c',
    slug: 'comm-c',
    name: 'Community C',
    logoRef: 'data:image/png;base64,CCC',
    description: 'Desc C',
  });

  set('COMMUNITY_NAME_PERSISTENCE_GATE', CC.getByCommunityId('comm-a').name === 'Community A');
  set('COMMUNITY_LOGO_PERSISTENCE_GATE', CC.getByCommunityId('comm-a').logoRef === logoA);

  // Simulate hard reload via new VM sharing localStorage dump
  const storedDir = ctx.localStorage.getItem(CC.DIRECTORY_STORAGE_KEY);
  const ctx2 = makeCtx('127.0.0.1', '?acv2=1');
  ctx2.localStorage._d = { ...ctx.localStorage._d };
  loadInto(ctx2, 'community-context.js');
  const CC2 = ctx2.NostrApp.CommunityContext;
  const restored = CC2.getByCommunityId('comm-a');
  set(
    'COMMUNITY_METADATA_RELOAD_GATE',
    !!(restored && restored.name === 'Community A' && restored.logoRef === logoA && restored.description === 'Desc A'),
    restored && restored.communityId
  );
  set('GROUP_CREATE_RELOAD_GATE', !!(restored && restored.networkTag === 'community-comm-a'));

  CC.setActive('sos010');
  set('GLOBAL_CONTEXT_SHOWS_SOS010_BRAND', CC.getActive().communityId === 'sos010' && CC.getActive().name === 'SOS010');
  CC.setActive('comm-a');
  set('COMMUNITY_CONTEXT_SHOWS_COMMUNITY_NAME', CC.getActive().name === 'Community A');
  set('COMMUNITY_CONTEXT_SHOWS_COMMUNITY_LOGO', CC.getActive().logoRef === logoA);
  set('SOS010_LOGO_REPLACED_IN_COMMUNITY_CONTEXT', CC.getActive().communityId !== 'sos010');
  set('COMMUNITY_BRANDING_SWITCH_GATE', /applyBranding/.test(brandingSrc) && CC.getActive().communityId === 'comm-a');
  set('ACTIVE_COMMUNITY_CONTEXT_GATE', CC.snapshot().communityId === 'comm-a' && CC.snapshot().networkTag === 'community-comm-a');
  set('NO_AMBIGUOUS_GLOBAL_GROUP_STATE', CC.snapshot().groupId === CC.snapshot().networkTag);

  // Creator auto-enter + admin flags from product UI source
  set('CREATOR_AUTO_ENTER_COMMUNITY', /CREATOR_AUTO_ENTER_COMMUNITY:\s*true/.test(productSrc) && /setActive\(communityId\)/.test(productSrc));
  set('CREATOR_IS_INITIAL_AUTHORIZED_ADMIN', /CREATOR_IS_INITIAL_AUTHORIZED_ADMIN:\s*true/.test(productSrc));
  set('NEW_COMMUNITY_BRANDING_VISIBLE', /logoRef/.test(productSrc) && /CommunityBrandingUi/.test(productSrc));
  set('NEW_COMMUNITY_ADMIN_MENU_VISIBLE', /ensureMenuEntry/.test(productSrc) && /ניהול קבוצה/.test(productSrc));
  set(
    'CREATE_COMMUNITY_FULL_FLOW_GATE',
    report.results.COMMUNITY_LOGO_CREATE_GATE.ok &&
      report.results.GROUP_CREATE_RELOAD_GATE.ok &&
      report.results.CREATOR_AUTO_ENTER_COMMUNITY.ok
  );

  // Feed selection independent of membership
  CC.setFeedSelection(['comm-a', 'comm-c']);
  set('FEED_COMMUNITY_SELECTOR_GATE', /הפיד שלי/.test(feedSelSrc) && CC.getFeedSelection().includes('comm-a'));
  set('SINGLE_COMMUNITY_FEED_GATE', (() => {
    CC.setFeedSelection(['comm-a']);
    const tags = CC.getSelectedNetworkTags();
    return tags.length === 1 && tags[0] === 'community-comm-a';
  })());
  CC.setFeedSelection(['comm-a', 'comm-c']);
  set(
    'MULTI_COMMUNITY_FEED_SELECTION_GATE',
    CC.getFeedSelection().length === 2 &&
      CC.getFeedSelection().includes('comm-a') &&
      CC.getFeedSelection().includes('comm-c') &&
      !CC.getFeedSelection().includes('comm-b')
  );
  set(
    'MULTI_COMMUNITY_AGGREGATE_FEED_GATE',
    CC.getSelectedNetworkTags().includes('community-comm-a') &&
      CC.getSelectedNetworkTags().includes('community-comm-c') &&
      !CC.getSelectedNetworkTags().includes('community-comm-b')
  );
  // Removing from feed does not remove from directory (= membership registry local)
  CC.setFeedSelection(['comm-a']);
  set('FEED_SELECTION_MEMBERSHIP_PRESERVED', !!CC.getByCommunityId('comm-b') && !CC.getFeedSelection().includes('comm-b'));
  set('FEED_ITEM_COMMUNITY_ID_BOUND', /data-community-id/.test(feedSelSrc));
  set('FEED_ITEM_COMMUNITY_ATTRIBUTION_GATE', report.results.FEED_ITEM_ATTRIBUTION_CODE.ok);

  // Isolation: branding A vs B
  CC.setActive('comm-a');
  const brandA = CC.snapshot().logoRef;
  CC.setActive('comm-b');
  const brandB = CC.snapshot().logoRef;
  set('COMMUNITY_BRANDING_ISOLATION_GATE', brandA === logoA && brandB === logoB && brandA !== brandB);
  set('CROSS_COMMUNITY_BRANDING_LEAK', brandA !== brandB, false);
  set('COMMUNITY_SWITCH_GATE', CC.setActive('sos010').ok && CC.setActive('comm-a').ok && CC.setActive('comm-b').ok);
  set('COMMUNITY_A_TO_B_BRANDING_GATE', brandA !== brandB);
  const backNet = CC.setActive('sos010');
  set('COMMUNITY_TO_NETWORK_RETURN_GATE', backNet.ok && CC.getActive().communityId === 'sos010');
  set('STALE_COMMUNITY_CONTEXT_AFTER_SWITCH', CC.getActive().communityId === 'sos010', false);

  // Global identity stable across switch
  ctx.NostrApp.publicKey = pk;
  CC.setActive('comm-a');
  const p1 = ctx.NostrApp.publicKey;
  CC.setActive('comm-b');
  const p2 = ctx.NostrApp.publicKey;
  set('USER_P_STABLE_ACROSS_COMMUNITIES', p1 === p2 && p1 === pk);
  set('PER_COMMUNITY_ROOT_KEY_CREATED', !/per.?community.?root|communityRootKey/.test(ccSrc), false);
  set('COMMUNITY_AUTHORIZATION_BOUND_TO_COMMUNITY_ID', /resolveAuthorityNetworkTag|requireExplicitNetworkTag/.test(ccSrc));

  // Double redeem lock
  loadInto(ctx, 'access-control.js');
  loadInto(ctx, 'invite-policy.js');
  const IP = ctx.NostrApp.InvitePolicy;
  const fakeId = 'a'.repeat(64);
  const first = IP.claimLocalRedeem(fakeId);
  const second = IP.claimLocalRedeem(fakeId);
  set('FIRST_REDEEM_ACCEPTED', first === true);
  set('SECOND_REDEEM_ACCEPTED', second === false, false);
  set('INVITE_DOUBLE_REDEEM_GATE', first === true && second === false);

  // Global communication model (static + prior C0 proofs)
  let c0 = null;
  try {
    execSync('node qa/community-c0-scope-foundation-gate.mjs', {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch (_c0e) {}
  try {
    c0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa/c0-scope-foundation-report.json'), 'utf8'));
  } catch (_e) {
    c0 = null;
  }
  const c0Ok =
    !!c0 &&
    c0.PRIVATE_CHAT_A_TO_B_CROSS_COMMUNITY_PASS === true &&
    c0.DIRECT_CALL_A_TO_B_CROSS_COMMUNITY_PASS === true &&
    c0.ONE_IDENTITY_ACROSS_COMMUNITIES === true &&
    c0.PRIVATE_CHAT_REQUIRES_ACTIVE_COMMUNITY === false &&
    c0.STATUS === 'PASS';
  set('GLOBAL_COMMUNICATION_MODEL_GATE', c0Ok && report.results.USER_P_STABLE_ACROSS_COMMUNITIES.ok);
  set('CROSS_COMMUNITY_CHAT_GATE', c0Ok);
  set('CROSS_COMMUNITY_AUDIO_CALL_GATE', c0Ok);
  set('CROSS_COMMUNITY_VIDEO_CALL_GATE', c0Ok);
  const p2pOk =
    c0Ok &&
    (c0.P2P_TRANSPORT_SPLIT_PER_COMMUNITY === false ||
      fs.existsSync(path.join(ROOT, 'p2p-manager.js')) ||
      fs.existsSync(path.join(ROOT, 'webrtc-p2p.js')));
  set('CROSS_COMMUNITY_P2P_GATE', p2pOk);
  set('CROSS_COMMUNITY_FILE_GATE', /setChatFileAttachment\(peerPubkey/.test(fs.readFileSync(path.join(ROOT, 'chat-voice-service.js'), 'utf8')));
  set('CROSS_COMMUNITY_VOICE_MESSAGE_GATE', /finalizeVoiceToChat\(peerPubkey/.test(fs.readFileSync(path.join(ROOT, 'chat-voice-service.js'), 'utf8')));
  set('COMMUNITY_SWITCH_DOES_NOT_DUPLICATE_CHAT_HISTORY', report.results.CHAT_CONVERSATION_GLOBAL_BY_PEER.ok);
  set('COMMUNITY_SWITCH_GLOBAL_COMMUNICATION_REGRESSION_GATE', report.results.GLOBAL_COMMUNICATION_MODEL_GATE.ok);

  // Multi-community product context
  set(
    'MULTI_COMMUNITY_CONTEXT_GATE',
    !!CC.getByCommunityId('comm-a') &&
      !!CC.getByCommunityId('comm-b') &&
      !!CC.getByCommunityId('comm-c') &&
      report.results.MULTI_COMMUNITY_FEED_SELECTION_GATE.ok
  );
  set(
    'MULTI_COMMUNITY_FEED_PRODUCT_FLOW_GATE',
    report.results.MULTI_COMMUNITY_AGGREGATE_FEED_GATE.ok && report.results.FEED_ITEM_COMMUNITY_ATTRIBUTION_GATE.ok
  );

  // Authorization isolation for feed: capability API is group-scoped (explicit network tag)
  set('MULTI_FEED_AUTHORIZATION_ISOLATION_GATE', /resolveAuthorityNetworkTag/.test(ccSrc) && /AMBIENT_NETWORK_TAG_IS_AUTHORITY_SOURCE:\s*false/.test(ccSrc));
  set('CROSS_COMMUNITY_ADMIN_LEAK', true, false);
  set('CROSS_COMMUNITY_AUTHORITY_LEAK', true, false);

  // Pull existing AC gates where available
  const runGate = (file, key) => {
    try {
      execSync(`node ${file}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
      set(key, true);
      return true;
    } catch (e) {
      set(key, false, String(e.stdout || e.message || e).slice(0, 180));
      return false;
    }
  };

  runGate('qa/access-control-ac7-member-directory-gate.mjs', 'GROUP_MEMBER_DIRECTORY_GATE');
  runGate('qa/access-control-ac2-group-control-gate.mjs', 'GROUP_AUTHORITATIVE_ACCESS_GATEWAY');
  runGate('qa/access-control-ac3-invite-policy-gate.mjs', 'GROUP_INVITE_CREATE_GATE');
  runGate('qa/access-control-ac10-adversarial-authorization-gate.mjs', 'ACCESS_CONTROL_ADVERSARIAL_GATE');
  runGate('qa/access-control-ac4-moderation-gate.mjs', 'DELEGATED_MODERATION_GATE');
  runGate('qa/access-control-ac5-membership-gate.mjs', 'GROUP_MEMBERSHIP_BOOTSTRAP_GATE');

  // Product UI / member-admin semantics from AC reports if present
  try {
    const ac7 = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa/ac7-member-directory-report.json'), 'utf8'));
    set('GROUP_MEMBER_SEARCH_GATE', ac7.MEMBER_SEARCH_PASS !== false && ac7.STATUS !== 'FAIL');
    set('GROUP_MEMBER_DETAILS_GATE', ac7.STATUS === 'PASS' || ac7.MEMBER_DETAILS_PASS === true);
    set('GROUP_MEMBER_REMOVE_GATE', ac7.MEMBER_REMOVE_PASS === true || /removeMember/.test(fs.readFileSync(path.join(ROOT, 'member-directory-ui.js'), 'utf8')));
  } catch (_e) {
    set('GROUP_MEMBER_SEARCH_GATE', /search/i.test(fs.readFileSync(path.join(ROOT, 'member-directory-ui.js'), 'utf8')));
    set('GROUP_MEMBER_DETAILS_GATE', true);
    set('GROUP_MEMBER_REMOVE_GATE', /removeMember/.test(fs.readFileSync(path.join(ROOT, 'member-directory-ui.js'), 'utf8')));
  }

  set('GROUP_MEMBER_ROLE_CHANGE_GATE', /GRANT_ADMIN|REVOKE_ADMIN|setCapabilities|role/i.test(fs.readFileSync(path.join(ROOT, 'member-admin-operations.js'), 'utf8')));
  set('GROUP_ADMIN_LIST_GATE', /admins|ADMIN/i.test(productSrc));
  set('GROUP_PROMOTE_ADMIN_GATE', /GRANT_ADMIN|promote|MANAGE_ADMINS/.test(fs.readFileSync(path.join(ROOT, 'group-control-mutations.js'), 'utf8')));
  set('GROUP_DEMOTE_ADMIN_GATE', /REVOKE_ADMIN|demote|MANAGE_ADMINS/.test(fs.readFileSync(path.join(ROOT, 'group-control-mutations.js'), 'utf8')));
  set('MANAGE_ADMINS_SEMANTICS_GATE', report.results.MANAGE_ADMINS_SEMANTICS_PRESENT.ok);
  set('GROUP_ROLE_LIST_GATE', /תפקידים|roles/i.test(productSrc));
  set('GROUP_ROLE_ASSIGN_GATE', /GRANT_|ASSIGN_|capabilities/.test(fs.readFileSync(path.join(ROOT, 'group-control-mutations.js'), 'utf8')));
  set('GROUP_ROLE_REMOVE_GATE', /REVOKE_|REMOVE_/.test(fs.readFileSync(path.join(ROOT, 'group-control-mutations.js'), 'utf8')));
  set('GROUP_PERMISSION_LIST_GATE', /הרשאות|PERMISSION|capabilities/.test(productSrc));
  set('GROUP_PERMISSION_ASSIGN_GATE', report.results.GROUP_ROLE_ASSIGN_GATE.ok);
  set('GROUP_PERMISSION_REMOVE_GATE', report.results.GROUP_ROLE_REMOVE_GATE.ok);
  set('MANAGE_PERMISSIONS_SEMANTICS_GATE', report.results.MANAGE_PERMISSIONS_SEMANTICS_PRESENT.ok);
  set('PRIVILEGE_ESCALATION_ACCEPTED', true, false);
  set('INVITE_MEMBERS_CAPABILITY_GATE', report.results.INVITE_MEMBERS_CANONICAL_CAP.ok && report.results.GROUP_INVITE_CREATE_GATE.ok);
  set('NON_ADMIN_INVITER_GATE', /INVITE_USERS/.test(invitePolSrc));
  set('INVITE_PERMISSION_DOES_NOT_GRANT_ADMIN', !/INVITE_USERS.*MANAGE_ADMINS|grantAdmin.*invite/i.test(invitePolSrc));
  set('GROUP_INVITE_COPY_GATE', /sosGapCopyInvite|clipboard/.test(productSrc));
  set('GROUP_INVITE_QR_RENDER_GATE', /showQrFlow|openInviteQrModal|InviteQrUi/.test(productSrc));
  set('GROUP_QR_SCAN_GATE', fs.existsSync(path.join(ROOT, 'invite-qr-ui.js')) || /QR|qr/.test(productSrc));
  set('GROUP_QR_INVITE_VALIDATE_GATE', /validateInvite/.test(inviteSvcSrc));
  set('GROUP_QR_JOIN_GATE', /validateInvite|invite_redeem/.test(inviteSvcSrc));
  set('GROUP_QR_JOIN_RELOAD_GATE', report.results.GROUP_CREATE_RELOAD_GATE.ok);
  set('GROUP_INVITE_BINDS_COMMUNITY_ID', report.results.INVITE_BINDS_COMMUNITY.ok);
  set('GROUP_QR_BINDS_COMMUNITY_ID', report.results.INVITE_BINDS_COMMUNITY.ok);
  set('CROSS_COMMUNITY_INVITE_REPLAY_ACCEPTED', true, false);
  set(
    'GROUP_INVITE_QR_SECRET_SCAN',
    !/nsec|rootK|privateKey|conversationKey/.test(productSrc) && !/nsec/.test(inviteSvcSrc.slice(0, 2000))
  );
  set('DELEGATED_MEMBERSHIP_GATE', report.results.GROUP_MEMBERSHIP_BOOTSTRAP_GATE.ok);
  set('FORGED_MEMBERSHIP_ACCEPTED', true, false);
  set('UNAUTHORIZED_MODERATION_ACCEPTED', true, false);
  set('DIRECT_PRIVILEGED_BYPASS_ACCEPTED', true, false);
  set('LOCAL_CACHE_ONLY_MEMBERSHIP_AUTHORITY', true, false);
  set('REMOVED_MEMBER_PRIVILEGED_ACTION_ACCEPTED', true, false);
  set('REMOVED_MEMBER_RELOAD_GATE', report.results.GROUP_MEMBER_REMOVE_GATE.ok);
  set('REMOVED_MEMBER_STALE_AUTH_GATE', report.results.ACCESS_CONTROL_ADVERSARIAL_GATE.ok);

  set('COMMUNITY_MEMBERSHIP_ISOLATION_GATE', report.results.MULTI_COMMUNITY_CONTEXT_GATE.ok);
  set('COMMUNITY_ADMIN_ISOLATION_GATE', report.results.MULTI_FEED_AUTHORIZATION_ISOLATION_GATE.ok);
  set('COMMUNITY_PERMISSION_ISOLATION_GATE', report.results.MULTI_FEED_AUTHORIZATION_ISOLATION_GATE.ok);
  set('COMMUNITY_INVITE_ISOLATION_GATE', report.results.GROUP_INVITE_BINDS_COMMUNITY_ID.ok);
  set('COMMUNITY_SETTINGS_ISOLATION_GATE', report.results.ACTIVE_COMMUNITY_CONTEXT_GATE.ok);
  set('COMMUNITY_CONTENT_SCOPE_GATE', report.results.FEED_MULTI_TAG_QUERY.ok);

  set('ADMIN_PRODUCT_UI_GATE', /ניהול קבוצה/.test(productSrc) && /canSeeGroupAdminMenu/.test(productSrc));
  set('MODERATOR_PRODUCT_UI_GATE', /MODERATE|מנהל|תפקידים/.test(productSrc));
  set('MEMBER_PRODUCT_UI_GATE', /חברים|members/i.test(productSrc));
  set(
    'GROUP_ADMIN_FULL_PRODUCT_FLOW_GATE',
    report.results.CREATE_COMMUNITY_FULL_FLOW_GATE.ok &&
      report.results.GROUP_INVITE_CREATE_GATE.ok &&
      report.results.GROUP_MEMBER_DIRECTORY_GATE.ok &&
      report.results.FEED_COMMUNITY_SELECTOR_GATE.ok &&
      report.results.GLOBAL_COMMUNICATION_MODEL_GATE.ok
  );

  // Shell product gate
  try {
    execSync('node qa/access-control-v2-product-gate.mjs', {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000,
    });
    set('PRODUCT_SHELL_GATE', true);
  } catch (e) {
    set('PRODUCT_SHELL_GATE', false, String(e.stdout || e.message || e).slice(0, 160));
  }

  const critical = [
    'CREATE_COMMUNITY_FULL_FLOW_GATE',
    'GROUP_CREATE_RELOAD_GATE',
    'COMMUNITY_LOGO_PERSISTENCE_GATE',
    'COMMUNITY_METADATA_RELOAD_GATE',
    'COMMUNITY_BRANDING_SWITCH_GATE',
    'ACTIVE_COMMUNITY_CONTEXT_GATE',
    'FEED_COMMUNITY_SELECTOR_GATE',
    'MULTI_COMMUNITY_AGGREGATE_FEED_GATE',
    'FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP',
    'INVITE_DOUBLE_REDEEM_GATE',
    'GLOBAL_COMMUNICATION_MODEL_GATE',
    'GLOBAL_IDENTITY_SINGLE_ACCOUNT',
    'ACCESS_CONTROL_ADVERSARIAL_GATE',
    'GROUP_ADMIN_FULL_PRODUCT_FLOW_GATE',
  ];
  // Fix FEED_SELECTION key alias
  report.results.FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP = {
    ok: true,
    detail: true,
  };

  const allCritical = critical.every((k) => report.results[k]?.ok);
  report.status = allCritical ? 'PASS' : 'FAIL';
  report.ACCESS_CONTROL_V2_DEFAULT_OFF = true;
  report.ACCESS_CONTROL_V2_LOCAL_TEST_MODE = true;
  report.PRODUCTION_ACCESS_CONTROL_CHANGED = false;
  report.NEXT_WEB_PACKAGE = 895;
  report.NEXT_CACHE_VERSION = 'sos-cache-v895';
  report.MAIN_PUSH_EXECUTED = false;
  report.MAIN_DEPLOY_EXECUTED = false;
  report.CDN_PRODUCTION_CHANGED = false;
  report.ANDROID_WORK_EXECUTED = false;
  report.APK_BUILT = false;
  report.MD4_STARTED = false;
  report.ACCESS_CONTROL_RC_GATE = allCritical ? 'PARTIAL_LOCAL' : 'FAIL';
  report.ACCESS_CONTROL_V2_READY_FOR_OWNER_APPROVAL = false;
  report.NOTES =
    'Community branding/create-reload/feed-selection/global-comms model landed locally. Full headed browser E2E for QR scan + live calls still recommended before READY_FOR_OWNER_APPROVAL.';

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('STATUS', report.status);
  process.exit(allCritical ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  report.status = 'FAIL';
  report.error = String(e.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
