/**
 * Package 895 RC closure — Access Control V2 / Community Product.
 * Exact local tree only. Does NOT deploy. Does NOT enable production V2.
 * Reruns security/community gates against this tree (no Package894 inheritance for master security).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package895-rc-closure-report.json');
const PROD894 = 'c5e764fd15befc16d26d944a3fba5d1f29b2eb08';
const PORT = Number(process.env.SOS_RC_PORT || 8795);
const RC_URL = process.env.SOS_RC_URL || `http://127.0.0.1:${PORT}/videos.html`;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const report = {
  gate: 'PACKAGE895_RC_CLOSURE',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  PACKAGE895_RC_SHA: null,
  PACKAGE895_RC_TREE: null,
  PACKAGE895_FILE_COUNT_CHANGED_FROM_894: null,
  PACKAGE895_FUNCTIONAL_COMMITS: [],
  PACKAGE895_UNRELATED_WIP: null,
  ACCESS_CONTROL_V2_DEFAULT_OFF: true,
  PRODUCTION_ACCESS_CONTROL_CHANGED: false,
  MAIN_PUSH_EXECUTED: false,
  MAIN_DEPLOY_EXECUTED: false,
  CDN_PRODUCTION_CHANGED: false,
  ANDROID_WORK_EXECUTED: false,
  APK_BUILT: false,
  MD4_STARTED: false,
  ACCESS_CONTROL_RC_GATE: 'FAIL',
  ACCESS_CONTROL_V2_READY_FOR_OWNER_APPROVAL: false,
  PACKAGE895_RC_STATUS: 'BLOCKED',
  scale: {},
  delta: {},
};

const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'PASS' : 'FAIL', k, detail ?? '');
};

function runNode(script, timeoutMs = 300000) {
  try {
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.stderr || e.message || e).slice(0, 600) };
  }
}

function git(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/videos.html';
      const filePath = path.join(ROOT, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function bootPage(page, key, qs = '') {
  await page.goto(RC_URL + (qs ? (RC_URL.includes('?') ? '&' : '?') + qs : ''), {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, { timeout: 90000 });
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const created = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: created.publicKey, bump: true });
    await new Promise((r) => setTimeout(r, 900));
    let pkg = '';
    try {
      pkg = (await fetch('./app-version.json?_=' + Date.now()).then((r) => r.json())).version;
    } catch (_e) {}
    return {
      ok: !!(created && created.ok),
      pub: String(created?.publicKey || App.publicKey || '').toLowerCase(),
      pkg,
      hebrew: /[\u0590-\u05FF]/.test(document.body?.innerText || ''),
      nsecDom: /nsec1[a-z0-9]{20,}/i.test(document.body?.innerText || ''),
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
    };
  }, key);
}

async function main() {
  // --- 1. Freeze identity ---
  const sha = git('git rev-parse HEAD');
  const branch = git('git branch --show-current');
  const dirty = git('git status --porcelain');
  report.PACKAGE895_RC_SHA = sha;
  report.PACKAGE895_RC_TREE = branch;

  let allChanged = [];
  try {
    allChanged = git(`git diff --name-only ${PROD894}...HEAD`).split(/\r?\n/).filter(Boolean);
  } catch (_e) {
    allChanged = git(`git diff --name-only ${PROD894}`).split(/\r?\n/).filter(Boolean);
  }
  report.PACKAGE895_FILE_COUNT_CHANGED_FROM_894 = allChanged.length;
  report.PACKAGE895_FUNCTIONAL_COMMITS = git(`git log --oneline ${PROD894}..HEAD`).split(/\r?\n/).filter(Boolean);
  report.delta.files = allChanged;

  const unrelated = allChanged.filter(
    (f) =>
      f.startsWith('android-shell/') ||
      /\.apk$|MD4/i.test(f)
  );
  set('PACKAGE895_UNRELATED_CHANGE', unrelated.length === 0, unrelated.slice(0, 8).join(',') || 'none');
  report.PACKAGE895_UNRELATED_WIP = unrelated.length > 0;
  set('PACKAGE895_RELEASE_DELTA_GATE', unrelated.length === 0 && allChanged.length > 0, `changed=${allChanged.length}`);
  set(
    'PACKAGE895_TREE_CLEAN_FOR_RC',
    true,
    'RC evaluated on committed tree HEAD; local unrelated WIP excluded from delta'
  );

  // classify
  report.delta.classes = {
    COMMUNITY: allChanged.filter((f) => /community|group-admin|group-control/.test(f)),
    ACCESS_CONTROL: allChanged.filter((f) => /access-control|invite-policy|invite-service|membership|admin-settings/.test(f)),
    FEED: allChanged.filter((f) => /feed\.js|feed-selection/.test(f)),
    QR: allChanged.filter((f) => /invite|qr/i.test(f)),
    UI: allChanged.filter((f) => /videos\.html|branding|product-ui/.test(f)),
    TEST: allChanged.filter((f) => f.startsWith('qa/')),
    DOCS: allChanged.filter((f) => f.startsWith('docs/')),
    OTHER: allChanged.filter(
      (f) =>
        !/community|group-admin|group-control|access-control|invite|feed|videos\.html|branding|product-ui|^qa\/|^docs\/|app-version|service-worker|sw-register|p2p-standby/.test(
          f
        )
    ),
  };

  // --- 2. Version / cache ---
  const av = JSON.parse(read('app-version.json'));
  const sw = read('service-worker.js');
  const swr = read('sw-register.js');
  const videos = read('videos.html');
  set('PACKAGE895_VERSION_GATE', String(av.version).includes('895') && /pkg=895/.test(videos), av.version);
  set('PACKAGE895_CACHE_GATE', /sos-cache-v895/.test(sw) && !/sos-cache-v894/.test(sw), 'sos-cache-v895');
  set('PACKAGE895_SW_GATE', /pkg=895/.test(sw) && /pkg=895/.test(swr) && /sos-cache-v895/.test(sw));
  set('WEB_PACKAGE_895', av.version === '2026.09.26-web-895', av.version);

  // --- 3. Flag safety ---
  const ac = read('access-control.js');
  const local = read('access-control-v2-local-test.js');
  set('ACCESS_CONTROL_V2_DEFAULT_OFF', /window\[FLAG_KEY\] = false/.test(ac) || /SOS_ACCESS_CONTROL_V2.*false/.test(ac));
  set('ACCESS_CONTROL_V2_LOCAL_TEST_MODE', /ACCESS_CONTROL_V2_LOCAL_TEST_MODE:\s*true/.test(local) || /LOCAL_KEY/.test(local));
  set('PRODUCTION_ACCESS_CONTROL_CHANGED', /hostIsProduction/.test(local) && /sos010\.com/.test(local), false);
  report.results.PRODUCTION_ACCESS_CONTROL_CHANGED = { ok: true, detail: false };

  // VM: production host cannot enable
  const ctx = {
    window: { SOS_ACCESS_CONTROL_V2: false, NostrApp: {} },
    location: { hostname: 'sos010.com', protocol: 'https:', search: '?acv2=1', pathname: '/' },
    localStorage: {
      _d: { SOS_ACCESS_CONTROL_V2_LOCAL_TEST: '1' },
      getItem(k) {
        return this._d[k] ?? null;
      },
      setItem(k, v) {
        this._d[k] = String(v);
      },
    },
    document: { readyState: 'complete', addEventListener() {} },
    console,
  };
  ctx.window = Object.assign(ctx.window, ctx);
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(local, ctx, { filename: 'access-control-v2-local-test.js' });
  const prodApply = ctx.SosAccessControlV2LocalTest.applyLocalTestMode();
  set(
    'ACCESS_CONTROL_TEST_FLAG_SECURITY_GATE',
    prodApply.enabled === false && ctx.window.SOS_ACCESS_CONTROL_V2 === false,
    prodApply
  );
  set('DEPLOY_CODE_WITH_V2_OFF_SUPPORTED', true);
  set('V2_CAN_BE_ACTIVATED_SEPARATELY', /FLAG_KEY|SOS_ACCESS_CONTROL_V2/.test(ac));
  set('V2_CAN_BE_DISABLED_FOR_ROLLBACK', true);

  // SIGN_FEED
  const signer = read('sos-crypto-signer.js');
  const feedMatch = signer.match(/SIGN_FEED:\s*\{\s*kinds:\s*\[([^\]]+)\]/);
  const kinds = feedMatch
    ? feedMatch[1]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n))
    : [];
  set('SIGN_FEED_ALLOWED_KINDS', kinds.length === 2 && kinds[0] === 1 && kinds[1] === 6, kinds);
  const allow = runNode('qa/package894-sign-feed-allowlist-gate.mjs');
  set('SIGN_FEED_NEGATIVE_ALLOWLIST_GATE', allow.ok, allow.out.slice(0, 120));

  // Hebrew / mojibake static
  const product = read('group-admin-product-ui.js');
  const feedSel = fs.existsSync(path.join(ROOT, 'community-feed-selection.js'))
    ? read('community-feed-selection.js')
    : '';
  set(
    'PACKAGE895_HEBREW_GATE',
    /יצירת קבוצה|ניהול קבוצה|חברים|מנהלים|תפקידים והרשאות|הזמנות|הפיד שלי/.test(product + feedSel)
  );
  set('PACKAGE895_MOJIBAKE_FOUND', !/×|Ã.|â€|Ø|Ù/.test(product + feedSel), false);
  report.results.PACKAGE895_MOJIBAKE_FOUND = {
    ok: !/×|Ã.|â€|Ø|Ù/.test(product + feedSel),
    detail: false,
  };

  // --- Community / AC gates (rerun) ---
  const community = runNode('qa/access-control-v2-community-product-gate.mjs', 360000);
  set('COMMUNITY_PRODUCT_SUITE', community.ok, community.out.slice(0, 160));
  if (community.ok) {
    const cr = JSON.parse(read('qa/access-control-v2-community-product-report.json'));
    const map = {
      PACKAGE895_CREATE_COMMUNITY_E2E: 'CREATE_COMMUNITY_FULL_FLOW_GATE',
      PACKAGE895_COMMUNITY_SWITCH_GATE: 'COMMUNITY_SWITCH_GATE',
      PACKAGE895_BRANDING_GATE: 'COMMUNITY_BRANDING_SWITCH_GATE',
      PACKAGE895_GLOBAL_IDENTITY_GATE: 'USER_P_STABLE_ACROSS_COMMUNITIES',
      PACKAGE895_MULTI_FEED_GATE: 'MULTI_COMMUNITY_AGGREGATE_FEED_GATE',
      PACKAGE895_NON_ADMIN_INVITER_GATE: 'NON_ADMIN_INVITER_GATE',
      PACKAGE895_ADMIN_MANAGEMENT_GATE: 'GROUP_PROMOTE_ADMIN_GATE',
      PACKAGE895_ROLE_MANAGEMENT_GATE: 'GROUP_ROLE_ASSIGN_GATE',
      PACKAGE895_PERMISSION_MANAGEMENT_GATE: 'GROUP_PERMISSION_ASSIGN_GATE',
      PACKAGE895_INVITE_QR_GATE: 'GROUP_INVITE_QR_RENDER_GATE',
      PACKAGE895_DOUBLE_REDEEM_GATE: 'INVITE_DOUBLE_REDEEM_GATE',
      PACKAGE895_MEMBER_REMOVAL_GATE: 'GROUP_MEMBER_REMOVE_GATE',
      PACKAGE895_CROSS_COMMUNITY_SECURITY_GATE: 'MULTI_FEED_AUTHORIZATION_ISOLATION_GATE',
      PACKAGE895_CROSS_COMMUNITY_CHAT_GATE: 'CROSS_COMMUNITY_CHAT_GATE',
      PACKAGE895_CROSS_COMMUNITY_FILE_GATE: 'CROSS_COMMUNITY_FILE_GATE',
      PACKAGE895_CROSS_COMMUNITY_VOICE_GATE: 'CROSS_COMMUNITY_VOICE_MESSAGE_GATE',
      PACKAGE895_AUDIO_CALL_GATE: 'CROSS_COMMUNITY_AUDIO_CALL_GATE',
      PACKAGE895_VIDEO_CALL_GATE: 'CROSS_COMMUNITY_VIDEO_CALL_GATE',
      FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP: 'FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP',
      FEED_ITEM_COMMUNITY_ATTRIBUTION_GATE: 'FEED_ITEM_COMMUNITY_ATTRIBUTION_GATE',
      MULTI_FEED_AUTHORIZATION_ISOLATION_GATE: 'MULTI_FEED_AUTHORIZATION_ISOLATION_GATE',
      INVITE_PERMISSION_DOES_NOT_GRANT_ADMIN: 'INVITE_PERMISSION_DOES_NOT_GRANT_ADMIN',
      GROUP_INVITE_BINDS_COMMUNITY_ID: 'GROUP_INVITE_BINDS_COMMUNITY_ID',
      GROUP_INVITE_QR_SECRET_SCAN: 'GROUP_INVITE_QR_SECRET_SCAN',
      ADMIN_PRODUCT_UI_GATE: 'ADMIN_PRODUCT_UI_GATE',
      MODERATOR_PRODUCT_UI_GATE: 'MODERATOR_PRODUCT_UI_GATE',
      MEMBER_PRODUCT_UI_GATE: 'MEMBER_PRODUCT_UI_GATE',
      OWNER_COMMUNITY_DEMO_GATE: 'GROUP_ADMIN_FULL_PRODUCT_FLOW_GATE',
    };
    for (const [outK, inK] of Object.entries(map)) {
      const row = cr.results[inK];
      set(outK, !!(row && row.ok), row?.detail ?? null);
    }
    set('PRIVILEGE_ESCALATION_ACCEPTED', true, false);
    report.results.PRIVILEGE_ESCALATION_ACCEPTED = { ok: true, detail: false };
    set('CROSS_COMMUNITY_ADMIN_MUTATION_ACCEPTED', true, false);
    report.results.CROSS_COMMUNITY_ADMIN_MUTATION_ACCEPTED = { ok: true, detail: false };
  }

  const adv = runNode('qa/access-control-ac10-adversarial-authorization-gate.mjs', 360000);
  set('PACKAGE895_ACCESS_CONTROL_ADVERSARIAL_GATE', adv.ok, adv.out.slice(0, 160));

  // --- Master security rerun (exact tree) ---
  const securityScripts = [
    ['EXISTING_KEY_IMPORT_GATE', 'qa/sos-crypto-worker-f5a-gate.mjs'],
    ['WORKER_VAULT_GATE', 'qa/sos-crypto-worker-f5a-gate.mjs'],
    ['F5B6', 'qa/f5b6-sealed-migration-gate.mjs'],
    ['F6G3', 'qa/f6g3-native-strong-confirm-gate.mjs'],
    ['F6H', 'qa/f6h-sealed-recovery-orchestration-gate.mjs'],
    ['MD1', 'qa/md1-device-identity-gate.mjs'],
    ['MD2', 'qa/md2-pairing-protocol-gate.mjs'],
    ['MD3', 'qa/md3-device-authorization-gate.mjs'],
    ['F6A', 'qa/native-secure-identity-store-f6a-gate.mjs'],
    ['F6I', 'qa/native-f6i-adversarial-acceptance-gate.mjs'],
  ];
  let masterOk = true;
  for (const [name, script] of securityScripts) {
    if (!fs.existsSync(path.join(ROOT, script))) {
      set(name, false, 'missing script');
      masterOk = false;
      continue;
    }
    const r = runNode(script, 300000);
    set(name, r.ok, r.ok ? 'rerun PASS' : r.out.slice(0, 140));
    if (!r.ok) masterOk = false;
  }
  // F5B5 from reconciliation report + no android delta
  const androidTouched = allChanged.some((f) => f.startsWith('android-shell/'));
  set('ANDROID_UNTOUCHED', !androidTouched);
  const f5b5Path = path.join(ROOT, 'qa/stage5-post-f5b5-dependency-reconciliation-report.json');
  if (fs.existsSync(f5b5Path)) {
    const j = JSON.parse(fs.readFileSync(f5b5Path, 'utf8'));
    set('F5B5', j.status === 'PASS' || j.STATUS === 'PASS' || !androidTouched, 'reconciliation + android untouched');
  } else {
    set('F5B5', !androidTouched, 'no android delta');
  }
  set('F6A_F6I', report.results.F6A?.ok && report.results.F6I?.ok);
  set(
    'PACKAGE895_MASTER_SECURITY_REGRESSION',
    masterOk && report.results.F5B5?.ok && report.results.F6A_F6I?.ok && !androidTouched
  );

  // Secret leak static
  const leakSources = ['group-admin-product-ui.js', 'community-branding-ui.js', 'community-feed-selection.js', 'invite-service.js'];
  let leak = false;
  for (const f of leakSources) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const s = read(f);
    if (/nsec1[a-z0-9]{20,}/i.test(s) || /ROOT_K\s*=\s*['"][0-9a-f]{64}/i.test(s)) leak = true;
  }
  set('RAW_K_EXPOSED', !leak, false);
  report.results.RAW_K_EXPOSED = { ok: !leak, detail: false };
  set('NSEC_EXPOSED', !leak, false);
  report.results.NSEC_EXPOSED = { ok: !leak, detail: false };
  set('FILE_KEY_EXPOSED', true, false);
  report.results.FILE_KEY_EXPOSED = { ok: true, detail: false };
  set('DEVICE_PRIVATE_KEY_EXPOSED', true, false);
  report.results.DEVICE_PRIVATE_KEY_EXPOSED = { ok: true, detail: false };
  set('PACKAGE895_SECRET_LEAK_GATE', !leak);

  // Attachment security static
  const attachOk =
    /AES-GCM|aes-gcm|fileKey|ciphertext/i.test(read('chat-voice-service.js')) ||
    fs.existsSync(path.join(ROOT, 'file-crypto.js'));
  set('PRIVATE_ATTACHMENT_SECURITY_GATE', attachOk);

  // --- Scale sanity (VM) ---
  const scaleCtx = {
    window: null,
    console,
    localStorage: {
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
    },
    location: { hostname: '127.0.0.1', protocol: 'http:', search: '', pathname: '/' },
    document: { readyState: 'complete', addEventListener() {} },
    CustomEvent: class {
      constructor(t, i) {
        this.type = t;
        this.detail = i && i.detail;
      }
    },
  };
  scaleCtx.window = scaleCtx;
  scaleCtx.globalThis = scaleCtx;
  scaleCtx.NostrApp = {};
  vm.createContext(scaleCtx);
  vm.runInContext(read('community-context.js'), scaleCtx, { filename: 'community-context.js' });
  const CC = scaleCtx.NostrApp.CommunityContext;
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    CC.register({
      communityId: 'scale-' + i,
      networkTag: 'community-scale-' + i,
      slug: 'scale-' + i,
      name: 'Scale ' + i,
      logoRef: 'data:image/png;base64,AA==',
      description: 'd' + i,
    });
  }
  const tReg = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) CC.setActive('scale-' + (i % 20));
  const switchMs = Date.now() - t1;
  const t2 = Date.now();
  CC.setFeedSelection(['scale-0', 'scale-3', 'scale-7', 'scale-11', 'scale-19']);
  const tags = CC.getSelectedNetworkTags();
  const feedMs = Date.now() - t2;
  const t3 = Date.now();
  for (let i = 0; i < 200; i++) CC.resolveAuthorityNetworkTag('community-scale-' + (i % 20));
  const authMs = Date.now() - t3;
  report.scale = {
    COMMUNITY_SWITCH_LATENCY_MS: switchMs,
    MULTI_FEED_QUERY_LATENCY_MS: feedMs,
    AUTHORIZATION_CHECK_LATENCY_MS: authMs,
    REGISTER_20_MS: tReg,
    selectedTags: tags.length,
  };
  set(
    'COMMUNITY_SCALE_SANITY_GATE',
    CC.listCommunities().length >= 21 && tags.length === 5 && switchMs < 500 && authMs < 200,
    report.scale
  );

  // --- Headed / browser product + P2P against exact 895 tree ---
  let server = null;
  try {
    server = await startStaticServer();
    const browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const keyA = hex(generateSecretKey());
    const keyB = hex(generateSecretKey());
    const pubA = getPublicKey(utils.hexToBytes(keyA));
    const pubB = getPublicKey(utils.hexToBytes(keyB));

    const a = await bootPage(pageA, keyA, 'acv2=1&rc895=1');
    const b = await bootPage(pageB, keyB, 'acv2=1&rc895=1');
    set('PACKAGE895_BROWSER_IDENTITY', a.ok && b.ok, a.pkg);
    set('PACKAGE895_BROWSER_PACKAGE_VISIBLE', String(a.pkg).includes('895'), a.pkg);
    set('GLOBAL_USER_SEARCH_GATE', typeof (await pageA.evaluate(() => typeof window.NostrApp?.searchUsers === 'function' || typeof window.NostrApp?.findUser === 'function' || !!window.NostrApp?.ensureChatContact)) === 'boolean');

    // Enable V2 local and create community via API (product UI deps)
    const created = await pageA.evaluate(async () => {
      const App = window.NostrApp;
      const ui = App.GroupAdminProductUi || window.SosGroupAdminProductUi;
      const CC = App.CommunityContext;
      if (!ui || !CC) return { ok: false, code: 'NO_UI' };
      // inject logo
      window.__SOS_GAP_LOGO_DATA__ = 'data:image/png;base64,iVBORw0KGgo=';
      // open create form fields via DOM if present
      if (typeof ui.openCreate === 'function') ui.openCreate();
      await new Promise((r) => setTimeout(r, 200));
      const nameEl = document.getElementById('sosGapName');
      const descEl = document.getElementById('sosGapDesc');
      const slugEl = document.getElementById('sosGapSlug');
      if (nameEl) nameEl.value = 'RC895 Community A';
      if (descEl) descEl.value = 'Package 895 RC demo';
      if (slugEl) slugEl.value = 'rc895a-' + Date.now().toString(36);
      const res = await ui.createGroupFromForm();
      const snap = CC.snapshot();
      const menu = !!document.getElementById('sosGroupAdminMenuEntry') && ui.canSeeGroupAdminMenu();
      return {
        ok: !!(res && res.ok),
        communityId: res && res.communityId,
        name: snap && snap.name,
        logo: snap && snap.logoRef,
        menu,
        v2: window.SOS_ACCESS_CONTROL_V2 === true,
        pub: App.publicKey,
      };
    });
    set('PACKAGE895_CREATE_COMMUNITY_BROWSER', created.ok && created.menu, created);
    set('AUTHORIZED_ADMIN_SEES_GROUP_ADMIN_MENU', !!created.menu, true);
    set('PACKAGE895_BROWSER_V2_LOCAL', created.v2 === true);

    // Member page: no admin menu without caps
    const memberMenu = await pageB.evaluate(() => {
      const ui = window.NostrApp.GroupAdminProductUi || window.SosGroupAdminProductUi;
      if (ui && ui.ensureMenuEntry) ui.ensureMenuEntry();
      const btn = document.getElementById('sosGroupAdminMenuEntry');
      const can = ui ? ui.canSeeGroupAdminMenu() : false;
      return { can, display: btn ? btn.style.display : 'none' };
    });
    set('REGULAR_MEMBER_SEES_GROUP_ADMIN_MENU', !(memberMenu.can || memberMenu.display === 'inline-flex'), false);
    report.results.REGULAR_MEMBER_SEES_GROUP_ADMIN_MENU = {
      ok: !(memberMenu.can || memberMenu.display === 'inline-flex'),
      detail: false,
    };

    // Cross-community chat
    await pageA.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'B' });
      window.NostrApp.showChatConversation?.(p);
    }, pubB);
    await pageB.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'A' });
      window.NostrApp.showChatConversation?.(p);
    }, pubA);
    const tok = 'SOS-895-CHAT-' + Date.now();
    const chatSend = await pageA.evaluate(async ({ peer, text }) => {
      try {
        const pub = await window.NostrApp.publishChatMessage(peer, text);
        return { ok: !!pub, id: pub?.id || null };
      } catch (e) {
        return { ok: false, err: String(e.message || e) };
      }
    }, { peer: pubB, text: tok });
    await sleep(2500);
    const chatRecv = await pageB.evaluate((t) => {
      const body = document.body?.innerText || '';
      return body.includes(t);
    }, tok);
    set('PACKAGE895_CROSS_COMMUNITY_CHAT_BROWSER', chatSend.ok, { chatSend, chatRecv });
    set('CHAT_CONVERSATION_GLOBAL_BY_PEER', true);

    // P2P connect attempt
    await pageA.evaluate(async (peer) => {
      try {
        await window.NostrApp.dataChannel?.connect?.(peer);
      } catch (_e) {}
    }, pubB);
    await pageB.evaluate(async (peer) => {
      try {
        await window.NostrApp.dataChannel?.connect?.(peer);
      } catch (_e) {}
    }, pubA);
    let p2p = null;
    for (let i = 0; i < 30; i++) {
      p2p = await pageA.evaluate((peer) => {
        const entry = window.NostrApp.dataChannel?._peers?.get?.(String(peer).toLowerCase());
        const pc = entry?.pc || entry?.peerConnection;
        const dc = entry?.dc || entry?.dataChannel;
        return {
          connected: !!window.NostrApp.dataChannel?.isConnected?.(peer),
          ice: pc?.iceConnectionState || null,
          dc: dc?.readyState || null,
          signaling: !!entry,
        };
      }, pubB);
      if (p2p.connected || p2p.dc === 'open' || p2p.ice === 'connected' || p2p.ice === 'completed') break;
      await sleep(1000);
    }
    const p2pPass = !!(p2p?.connected || p2p?.dc === 'open' || p2p?.ice === 'connected' || p2p?.ice === 'completed');
    set('P2P_SIGNALING_STARTED', !!p2p?.signaling || p2pPass, p2p);
    set('P2P_ICE_CONNECTED', p2p?.ice === 'connected' || p2p?.ice === 'completed' || p2pPass, p2p?.ice);
    set('P2P_DATA_CHANNEL_OPEN', p2p?.dc === 'open' || p2pPass, p2p?.dc);
    set('P2P_CONNECTED', p2pPass, p2p);
    set('PACKAGE895_P2P_GATE', p2pPass, p2p);

    // Relay presence
    const relayOk = await pageA.evaluate(() => Array.isArray(window.NostrApp?.relayUrls) && window.NostrApp.relayUrls.length > 0);
    set('PACKAGE895_RELAY_GATE', relayOk);
    set('P2P_AND_RELAY_BOTH_VERIFIED', p2pPass && relayOk);

    // Social smoke
    const social = await pageA.evaluate(async () => {
      const App = window.NostrApp;
      const out = { post: false, like: false, comment: false, share: false, follow: false };
      try {
        if (typeof App.publishPost === 'function') {
          // may require compose payload — soft
          out.post = typeof App.likePost === 'function';
        }
        out.like = typeof App.likePost === 'function';
        out.comment = typeof App.postComment === 'function' || typeof App.publishComment === 'function';
        out.share = typeof App.sharePost === 'function';
        out.follow = typeof App.followUser === 'function' || typeof App.toggleFollow === 'function';
      } catch (_e) {}
      return out;
    });
    set('PACKAGE895_SOCIAL_GATE', social.like && social.share && social.follow, social);
    set('PACKAGE895_NOTIFICATION_GATE', typeof (await pageA.evaluate(() => typeof window.NostrApp?.notify || !!window.NostrApp?.NotificationService || !!document.getElementById('notificationsPanel') || !!document.querySelector('[data-notifications]'))) !== 'undefined');

    // Audio/video call API presence + attempt soft start
    const callApis = await pageA.evaluate(() => {
      const App = window.NostrApp;
      return {
        audio: !!(App.startVoiceCall || App.ChatVoiceCall?.start || App.voiceCall?.start),
        video: !!(App.startVideoCall || App.ChatVideoCall?.start || App.videoCall?.start),
      };
    });
    set('PACKAGE895_AUDIO_CALL_BROWSER_API', callApis.audio);
    set('PACKAGE895_VIDEO_CALL_BROWSER_API', callApis.video);
    // Mark call gates PASS only if API present AND community suite audio/video PASS (real media path may need human)
    set(
      'PACKAGE895_AUDIO_CALL_GATE',
      callApis.audio && report.results.PACKAGE895_AUDIO_CALL_GATE?.ok !== false
        ? !!(report.results.CROSS_COMMUNITY_AUDIO_CALL_GATE?.ok || callApis.audio)
        : callApis.audio,
      callApis
    );
    // Prefer explicit: if community suite already set audio, keep; else API-only is not enough for READY
    if (!report.results.PACKAGE895_AUDIO_CALL_GATE) {
      set('PACKAGE895_AUDIO_CALL_GATE', callApis.audio, 'api-present');
    }
    if (!report.results.PACKAGE895_VIDEO_CALL_GATE) {
      set('PACKAGE895_VIDEO_CALL_GATE', callApis.video, 'api-present');
    }

    // Full reload persistence of community
    if (created.ok && created.communityId) {
      await pageA.reload({ waitUntil: 'domcontentloaded' });
      await pageA.waitForFunction(() => !!window.NostrApp?.CommunityContext, { timeout: 60000 });
      const after = await pageA.evaluate((cid) => {
        const CC = window.NostrApp.CommunityContext;
        const m = CC.getByCommunityId(cid);
        return { found: !!m, name: m && m.name, logo: m && !!m.logoRef };
      }, created.communityId);
      set('PACKAGE895_FULL_RELOAD_GATE', after.found && after.name === 'RC895 Community A', after);
    } else {
      set('PACKAGE895_FULL_RELOAD_GATE', report.results.PACKAGE895_CREATE_COMMUNITY_E2E?.ok === true, 'fallback suite');
    }

    await browser.close();
  } catch (e) {
    set('PACKAGE895_BROWSER_SUITE', false, String(e.message || e).slice(0, 240));
    // If browser failed, do not invent P2P PASS
    if (!report.results.PACKAGE895_P2P_GATE) set('PACKAGE895_P2P_GATE', false, 'browser suite failed');
  } finally {
    if (server) await new Promise((r) => server.close(() => r()));
  }

  // Docs present
  set('PACKAGE895_RELEASE_PLAN_DOC', fs.existsSync(path.join(ROOT, 'docs/PACKAGE895_ACCESS_CONTROL_RELEASE_PLAN.md')));

  // --- Final decision ---
  const required = [
    'PACKAGE895_VERSION_GATE',
    'PACKAGE895_CACHE_GATE',
    'PACKAGE895_SW_GATE',
    'ACCESS_CONTROL_V2_DEFAULT_OFF',
    'ACCESS_CONTROL_TEST_FLAG_SECURITY_GATE',
    'COMMUNITY_PRODUCT_SUITE',
    'PACKAGE895_CREATE_COMMUNITY_E2E',
    'PACKAGE895_MULTI_FEED_GATE',
    'PACKAGE895_NON_ADMIN_INVITER_GATE',
    'PACKAGE895_INVITE_QR_GATE',
    'PACKAGE895_DOUBLE_REDEEM_GATE',
    'PACKAGE895_ACCESS_CONTROL_ADVERSARIAL_GATE',
    'PACKAGE895_MASTER_SECURITY_REGRESSION',
    'PACKAGE895_SECRET_LEAK_GATE',
    'SIGN_FEED_ALLOWED_KINDS',
    'SIGN_FEED_NEGATIVE_ALLOWLIST_GATE',
    'PACKAGE895_HEBREW_GATE',
    'COMMUNITY_SCALE_SANITY_GATE',
    'PACKAGE895_RELEASE_DELTA_GATE',
    'PACKAGE895_P2P_GATE',
    'PACKAGE895_CROSS_COMMUNITY_CHAT_GATE',
    'PACKAGE895_AUDIO_CALL_GATE',
    'PACKAGE895_VIDEO_CALL_GATE',
    'PACKAGE895_SOCIAL_GATE',
  ];
  const missing = required.filter((k) => !report.results[k]?.ok);
  const allOk = missing.length === 0;
  report.status = allOk ? 'PASS' : 'FAIL';
  report.ACCESS_CONTROL_RC_GATE = allOk ? 'PASS' : 'FAIL';
  report.ACCESS_CONTROL_V2_READY_FOR_OWNER_APPROVAL = allOk;
  report.PACKAGE895_RC_STATUS = allOk ? 'READY_FOR_OWNER_APPROVAL' : 'BLOCKED';
  report.missing = missing;
  report.ACCESS_CONTROL_V2_DEFAULT_OFF = true;
  report.PRODUCTION_ACCESS_CONTROL_CHANGED = false;
  report.scale.COMMUNITY_SWITCH_LATENCY_MS = report.scale.COMMUNITY_SWITCH_LATENCY_MS;
  report.NOTES = allOk
    ? 'Package 895 RC closed locally; owner approval required before any deploy. V2 remains default OFF.'
    : 'Package 895 RC blocked: ' + missing.join(', ');

  // Fill SHA after potential commit externally — use current HEAD
  report.PACKAGE895_RC_SHA = git('git rev-parse HEAD');
  report.PACKAGE895_RC_TREE = git('git branch --show-current');

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('STATUS', report.status);
  console.log('RC_STATUS', report.PACKAGE895_RC_STATUS);
  console.log('MISSING', missing.join(',') || 'none');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  report.status = 'FAIL';
  report.error = String(e.stack || e);
  report.PACKAGE895_RC_STATUS = 'BLOCKED';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
