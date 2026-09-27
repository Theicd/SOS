/**
 * Package 896 RC gate — canonical runtime feature flag for Access Control V2.
 * Exact local tree only. Does NOT deploy. Does NOT change production config.
 *
 * Browser phases run on host "sos010.com" mapped to a local static server
 * (Chromium --host-resolver-rules), so production-host semantics are exercised
 * while runtime-feature-flags.json is swapped per phase through the same path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package896-rc-report.json');
const PROD895 = '623c94f6e2b25471b4814cdcb74851f692263a1e';
const PORT = Number(process.env.SOS_RC_PORT || 8796);
const PROD_URL = `http://sos010.com:${PORT}/videos.html`;
const LOCAL_URL = `http://127.0.0.1:${PORT}/videos.html`;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

const report = {
  gate: 'PACKAGE896_RC',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  PACKAGE896_RC_SHA: null,
  PACKAGE896_RC_TREE_HASH: null,
  ROLLBACK_TARGET_SHA: PROD895,
  NEXT_WEB_PACKAGE: 896,
  NEXT_CACHE_VERSION: 'sos-cache-v896',
  ACCESS_CONTROL_V2_SHIPPED_VALUE: null,
  MAIN_PUSH_EXECUTED: false,
  MAIN_DEPLOY_EXECUTED: false,
  CDN_PRODUCTION_CHANGED: false,
  PRODUCTION_ACCESS_CONTROL_CHANGED: false,
  ANDROID_WORK_EXECUTED: false,
  MD4_STARTED: false,
  PACKAGE896_RC_STATUS: 'BLOCKED',
  phases: {},
};

const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};

function runNode(script, timeoutMs = 360000) {
  try {
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.stderr || e.message || e).slice(0, 600) };
  }
}

// ---------------------------------------------------------------- server
const FLAG_BODIES = {
  off: { status: 200, body: '{"schema":"sos-feature-flags-v1","accessControlV2":false}' },
  on: { status: 200, body: '{"schema":"sos-feature-flags-v1","accessControlV2":true}' },
  missing: { status: 404, body: 'not found' },
  malformed: { status: 200, body: '{"schema":"sos-feature-flags-v1","accessControlV2":tru' },
  unknown_schema: { status: 200, body: '{"schema":"sos-feature-flags-v2","accessControlV2":true}' },
  extra_key: { status: 200, body: '{"schema":"sos-feature-flags-v1","accessControlV2":true,"x":1}' },
  string_value: { status: 200, body: '{"schema":"sos-feature-flags-v1","accessControlV2":"true"}' },
  server_error: { status: 500, body: 'err' },
};
let flagsMode = 'off';
let flagsRequests = 0;

function startStaticServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/videos.html';
      if (urlPath === '/runtime-feature-flags.json') {
        flagsRequests += 1;
        const f = FLAG_BODIES[flagsMode];
        res.writeHead(f.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(f.body);
        return;
      }
      const filePath = path.join(ROOT, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
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

// ---------------------------------------------------------------- VM loader tests
function makeVmCtx({ hostname, protocol = 'https:', search = '', fetchImpl, preFlag, storage = {} }) {
  const events = [];
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Promise,
    JSON,
    Date,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = { hostname, protocol, search, hash: '#acv2=1', pathname: '/' };
  const mkStore = (d) => ({
    _d: { ...d },
    getItem(k) {
      return this._d[k] ?? null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    },
  });
  ctx.localStorage = mkStore(storage);
  ctx.sessionStorage = mkStore(storage);
  ctx.document = { readyState: 'complete', addEventListener() {} };
  ctx.NostrApp = {};
  ctx.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  ctx.dispatchEvent = (ev) => events.push(ev.type);
  ctx.addEventListener = () => {};
  if (fetchImpl) ctx.fetch = fetchImpl;
  if (preFlag !== undefined) ctx.SOS_ACCESS_CONTROL_V2 = preFlag;
  vm.createContext(ctx);
  return { ctx, events };
}

const fetchWith = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

async function vmLoader(opts) {
  const { ctx, events } = makeVmCtx(opts);
  vm.runInContext(read('feature-flags.js'), ctx, { filename: 'feature-flags.js' });
  const before = ctx.SOS_ACCESS_CONTROL_V2;
  if (opts.runLocalHelper) {
    vm.runInContext(read('access-control-v2-local-test.js'), ctx, { filename: 'access-control-v2-local-test.js' });
  }
  if (opts.runAccessControl) {
    vm.runInContext(read('access-control.js'), ctx, { filename: 'access-control.js' });
  }
  await ctx.SosFeatureFlags.whenReady();
  if (opts.postWrite !== undefined) ctx.SOS_ACCESS_CONTROL_V2 = opts.postWrite;
  return { before, after: ctx.SOS_ACCESS_CONTROL_V2, snap: ctx.SosFeatureFlags.snapshot(), events };
}

async function vmSuite() {
  const P = 'sos010.com';
  const cases = [
    ['VM_PROD_CONFIG_OFF', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.off.body) }, false],
    ['VM_PROD_CONFIG_ON', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.on.body) }, true],
    ['VM_PROD_WWW_CONFIG_ON', { hostname: 'www.sos010.com', fetchImpl: fetchWith(200, FLAG_BODIES.on.body) }, true],
    ['FAIL_CLOSED_MISSING', { hostname: P, fetchImpl: fetchWith(404, '') }, false],
    ['FAIL_CLOSED_SERVER_ERROR', { hostname: P, fetchImpl: fetchWith(500, '') }, false],
    ['FAIL_CLOSED_UNREACHABLE', { hostname: P, fetchImpl: async () => { throw new Error('net'); } }, false],
    ['FAIL_CLOSED_NO_FETCH', { hostname: P }, false],
    ['FAIL_CLOSED_MALFORMED', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.malformed.body) }, false],
    ['FAIL_CLOSED_UNKNOWN_SCHEMA', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.unknown_schema.body) }, false],
    ['FAIL_CLOSED_EXTRA_KEY', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.extra_key.body) }, false],
    ['FAIL_CLOSED_STRING_VALUE', { hostname: P, fetchImpl: fetchWith(200, FLAG_BODIES.string_value.body) }, false],
    ['FAIL_CLOSED_ARRAY', { hostname: P, fetchImpl: fetchWith(200, '[true]') }, false],
    ['FAIL_CLOSED_NULL', { hostname: P, fetchImpl: fetchWith(200, 'null') }, false],
    ['FAIL_CLOSED_TOO_LARGE', { hostname: P, fetchImpl: fetchWith(200, '{"schema":"sos-feature-flags-v1","accessControlV2":true' + ' '.repeat(4000) + '}') }, false],
    [
      'PROD_OVERRIDES_IGNORED_ALL_CHANNELS',
      {
        hostname: P,
        search: '?acv2=1&access_control_v2=1',
        storage: { SOS_ACCESS_CONTROL_V2_LOCAL_TEST: '1', SOS_ACCESS_CONTROL_V2: '1' },
        preFlag: true,
        runLocalHelper: true,
        postWrite: true,
        fetchImpl: fetchWith(200, FLAG_BODIES.off.body),
      },
      false,
    ],
    [
      'PROD_OVERRIDES_IGNORED_ON_FAILURE',
      {
        hostname: P,
        search: '?acv2=1',
        storage: { SOS_ACCESS_CONTROL_V2_LOCAL_TEST: '1' },
        preFlag: true,
        runLocalHelper: true,
        postWrite: true,
        fetchImpl: fetchWith(404, ''),
      },
      false,
    ],
    ['NON_LOCAL_HOST_OVERRIDE_IGNORED', { hostname: 'example.github.io', search: '?acv2=1', runLocalHelper: true, postWrite: true, fetchImpl: fetchWith(404, '') }, false],
    ['LOCAL_CONFIG_ON', { hostname: '127.0.0.1', protocol: 'http:', fetchImpl: fetchWith(200, FLAG_BODIES.on.body) }, true],
    ['LOCAL_CONFIG_OFF', { hostname: '127.0.0.1', protocol: 'http:', fetchImpl: fetchWith(200, FLAG_BODIES.off.body) }, false],
    ['LOCAL_TEST_HELPER_PRESERVED', { hostname: 'localhost', protocol: 'http:', search: '?acv2=1', runLocalHelper: true, fetchImpl: fetchWith(200, FLAG_BODIES.off.body) }, true],
  ];
  for (const [name, opts, expected] of cases) {
    try {
      const r = await vmLoader(opts);
      const readyFired = r.events.includes('sos-feature-flags-ready');
      set(name, r.after === expected && readyFired && r.before === false, {
        after: r.after,
        before: r.before,
        source: r.snap.source,
        errorCode: r.snap.errorCode,
      });
    } catch (e) {
      set(name, false, String(e.message || e));
    }
  }

  // Default OFF until resolved: pending fetch
  let release;
  const pending = new Promise((r) => (release = r));
  const { ctx } = makeVmCtx({
    hostname: 'sos010.com',
    fetchImpl: () => pending.then(() => ({ ok: true, status: 200, text: async () => FLAG_BODIES.on.body })),
  });
  vm.runInContext(read('feature-flags.js'), ctx, { filename: 'feature-flags.js' });
  const beforeResolve = { v: ctx.SOS_ACCESS_CONTROL_V2, resolved: ctx.SosFeatureFlags.isResolved() };
  release();
  await ctx.SosFeatureFlags.whenReady();
  set('FLAG_OFF_UNTIL_RESOLVED', beforeResolve.v === false && beforeResolve.resolved === false && ctx.SOS_ACCESS_CONTROL_V2 === true, beforeResolve);

  // Snapshot diagnostics are safe
  const snap = ctx.SosFeatureFlags.snapshot();
  const keys = Object.keys(snap).sort().join(',');
  const safe = !/nsec|priv|secret|token|key\b/i.test(JSON.stringify(snap)) && Object.values(snap).every((v) => v === null || ['string', 'boolean'].includes(typeof v));
  set('SAFE_DIAGNOSTICS_ONLY', safe, keys);
  set('FEATURE_FLAG_NOT_AUTHORITY', ctx.SosFeatureFlags.FEATURE_FLAG_IS_AUTHORITY === false && ctx.SosFeatureFlags.FAIL_CLOSED === true);
}

// ---------------------------------------------------------------- browser helpers
async function bootIdentity(page, key) {
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, { timeout: 90000 });
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const created = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: created.publicKey, bump: true });
    try {
      window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 900));
    return { ok: !!(created && created.ok), pub: String(created?.publicKey || '').toLowerCase() };
  }, key);
}

async function flagState(page) {
  await page.waitForFunction(() => window.SosFeatureFlags && window.SosFeatureFlags.isResolved(), { timeout: 30000 });
  await sleep(1500);
  return page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden;
    };
    const text = document.body?.innerText || '';
    return {
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      snap: window.SosFeatureFlags.snapshot(),
      createVisible: vis('sosGroupCreateMenuEntry'),
      adminVisible: vis('sosGroupAdminMenuEntry') || vis('sosAdminSettingsEntry'),
      feedSelVisible: vis('sosFeedSelBtn'),
      hebrewCreate: text.includes('יצירת קבוצה'),
      hebrewFeed: text.includes('הפיד שלי'),
      brandMode: document.documentElement.dataset.communityBrandMode || null,
      earlyV2: window.__sos896Probe ? window.__sos896Probe.earlyV2 : null,
      flash: window.__sos896Probe ? window.__sos896Probe.flash : null,
      nsecDom: /nsec1[a-z0-9]{20,}/i.test(text),
    };
  });
}

const PROBE_INIT = () => {
  const probe = { ready: false, flash: false, earlyV2: false };
  window.__sos896Probe = probe;
  window.addEventListener('sos-feature-flags-ready', () => {
    probe.ready = true;
  });
  const ids = ['sosGroupCreateMenuEntry', 'sosGroupAdminMenuEntry', 'sosFeedSelBtn', 'sosAdminSettingsEntry'];
  const check = () => {
    if (probe.ready) return;
    if (window.SOS_ACCESS_CONTROL_V2 === true) probe.earlyV2 = true;
    if (ids.some((id) => document.getElementById(id))) probe.flash = true;
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
};

const OVERRIDE_INIT = () => {
  try {
    window.SOS_ACCESS_CONTROL_V2 = true;
    localStorage.setItem('SOS_ACCESS_CONTROL_V2_LOCAL_TEST', '1');
    localStorage.setItem('SOS_ACCESS_CONTROL_V2', 'true');
    sessionStorage.setItem('SOS_ACCESS_CONTROL_V2', 'true');
    sessionStorage.setItem('SOS_ACCESS_CONTROL_V2_LOCAL_TEST', '1');
  } catch (_e) {}
  document.addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.id = 'SOS_ACCESS_CONTROL_V2';
    d.dataset.enabled = 'true';
    document.body.appendChild(d);
    try {
      window.SOS_ACCESS_CONTROL_V2 = true;
    } catch (_e) {}
  });
};

async function browserSuite() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--host-resolver-rules=MAP sos010.com 127.0.0.1, MAP www.sos010.com 127.0.0.1`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  try {
    const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
    await ctxA.addInitScript(PROBE_INIT);
    const pageA = await ctxA.newPage();
    const keyA = hex(generateSecretKey());
    const keyB = hex(generateSecretKey());
    const pubB = getPublicKey(utils.hexToBytes(keyB));

    // Phase 1: production host, config OFF (shipped value)
    flagsMode = 'off';
    await pageA.goto(PROD_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const idA = await bootIdentity(pageA, keyA);
    const off1 = await flagState(pageA);
    report.phases.off1 = off1;
    const pkg = await pageA.evaluate(async () => (await fetch('./app-version.json?_=' + Date.now()).then((r) => r.json())).version);
    set('BROWSER_PACKAGE_896', String(pkg).includes('896'), pkg);
    set('BROWSER_PRODUCTION_HOST_MODE', off1.snap.productionHost === true && off1.snap.localOverrideAllowed === false, off1.snap);
    const offHidden = (s) => !s.v2 && !s.createVisible && !s.adminVisible && !s.feedSelVisible && !s.hebrewCreate && !s.hebrewFeed;
    set('FLAG_OFF_CREATE_GROUP_HIDDEN', !off1.createVisible && !off1.hebrewCreate, off1);
    set('FLAG_OFF_GROUP_ADMIN_HIDDEN', !off1.adminVisible);
    set('FLAG_OFF_MULTI_COMMUNITY_HIDDEN', !off1.feedSelVisible && !off1.hebrewFeed && off1.brandMode !== 'community');
    set('FLAG_OFF_NO_V2_FLASH', off1.flash === false && off1.earlyV2 === false);
    set('BROWSER_IDENTITY', idA.ok, idA.pub.slice(0, 8));

    // Forced UI with V2 OFF: product APIs refuse
    const forcedOff = await pageA.evaluate(async () => {
      const ui = window.SosGroupAdminProductUi;
      const btn = document.createElement('button');
      btn.id = 'sosGroupCreateMenuEntry';
      btn.style.display = 'inline-flex';
      document.body.appendChild(btn);
      ui.openCreate();
      const fields = [
        ['sosGapName', 'Forced Group'],
        ['sosGapDesc', 'forced'],
        ['sosGapSlug', 'forced-' + Date.now().toString(36)],
      ].map(([id, v]) => {
        const el = document.createElement('input');
        el.id = id;
        el.value = v;
        document.body.appendChild(el);
        return el;
      });
      window.__SOS_GAP_LOGO_DATA__ = 'data:image/png;base64,iVBORw0KGgo=';
      const res = await ui.createGroupFromForm();
      fields.forEach((el) => el.remove());
      const mut = await window.NostrApp.GroupControlMutations.applyControlMutation(
        { type: 'GRANT_CAPABILITY', targetPubkey: window.NostrApp.publicKey, capability: 'MANAGE_ADMINS' },
        window.NostrApp.publicKey
      );
      btn.remove();
      return { create: res, mut, v2: window.SOS_ACCESS_CONTROL_V2 === true };
    });
    set(
      'FORCED_UI_V2_OFF_REJECTED',
      forcedOff.create?.code === 'V2_OFF' && forcedOff.mut?.code === 'V2_REQUIRED' && !forcedOff.v2,
      forcedOff
    );

    // Overrides on production host (query, fragment, local/session storage, DOM, window write)
    const ctxO = await browser.newContext();
    await ctxO.addInitScript(OVERRIDE_INIT);
    const pageO = await ctxO.newPage();
    await pageO.goto(PROD_URL + '?acv2=1&access_control_v2=1#acv2=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await bootIdentity(pageO, hex(generateSecretKey()));
    const ov = await flagState(pageO);
    const ovAfter = await pageO.evaluate(() => {
      window.SOS_ACCESS_CONTROL_V2 = true;
      window.dispatchEvent(new CustomEvent('sos-access-control-v2-local', { detail: { enabled: true } }));
      window.SosAccessControlV2LocalTest?.enableLocalTest?.();
      return window.SOS_ACCESS_CONTROL_V2 === true;
    });
    report.phases.overrides = ov;
    set('PRODUCTION_OVERRIDES_NO_EFFECT', offHidden(ov) && ovAfter === false, { v2: ov.v2, ovAfter });
    await ctxO.close();

    // Fail-closed configs in browser
    for (const mode of ['missing', 'malformed', 'unknown_schema', 'extra_key', 'string_value', 'server_error']) {
      flagsMode = mode;
      await pageA.reload({ waitUntil: 'domcontentloaded' });
      const s = await flagState(pageA);
      set('BROWSER_FAIL_CLOSED_' + mode.toUpperCase(), offHidden(s), { v2: s.v2, err: s.snap.errorCode });
    }

    // Phase 2: config ON -> reload
    flagsMode = 'on';
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await bootIdentity(pageA, keyA);
    const on1 = await flagState(pageA);
    report.phases.on1 = on1;
    set('FLAG_ON_V2_ENABLED', on1.v2 && on1.snap.source === 'canonical_config', on1.snap);
    set('FLAG_ON_CREATE_GROUP_VISIBLE', on1.createVisible && on1.hebrewCreate);
    set('FLAG_ON_MULTI_COMMUNITY_VISIBLE', on1.feedSelVisible && on1.hebrewFeed);
    set('FLAG_ON_NO_PRE_RESOLUTION_V2', on1.earlyV2 === false && on1.flash === false);

    const created = await pageA.evaluate(async () => {
      const App = window.NostrApp;
      const ui = App.GroupAdminProductUi;
      window.__SOS_GAP_LOGO_DATA__ = 'data:image/png;base64,iVBORw0KGgo=';
      ui.openCreate();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('sosGapName').value = 'RC896 Community';
      document.getElementById('sosGapDesc').value = 'Package 896 RC';
      document.getElementById('sosGapSlug').value = 'rc896-' + Date.now().toString(36);
      const res = await ui.createGroupFromForm();
      ui.close?.();
      ui.ensureMenuEntry();
      const snap = App.CommunityContext.snapshot();
      return {
        ok: !!res?.ok,
        code: res?.code,
        communityId: res?.communityId,
        networkTag: snap?.networkTag,
        adminMenu: ui.canSeeGroupAdminMenu(),
        brand: document.documentElement.dataset.communityBrandMode,
      };
    });
    set('FLAG_ON_FULL_COMMUNITY_PRODUCT', created.ok && created.adminMenu && created.brand === 'community', created);

    // Forced-UI privilege bypass with V2 ON: stranger actor on real community state
    const bypass = await pageA.evaluate(
      async ({ stranger, networkTag }) => {
        const App = window.NostrApp;
        const AC = App.AccessControl || window.SosAccessControl;
        const ui = App.GroupAdminProductUi;
        const btn = document.getElementById('sosGroupAdminMenuEntry');
        if (btn) btn.style.display = 'inline-flex';
        const out = {};
        out.strangerCan = AC ? AC.can(stranger, 'GRANT_ADMIN_CAPABILITY', networkTag) : null;
        out.creatorCan = AC ? AC.can(App.publicKey, 'GRANT_ADMIN_CAPABILITY', networkTag) : null;
        const r1 = await App.GroupControlMutations.applyControlMutation(
          { type: 'GRANT_CAPABILITY', targetPubkey: stranger, capability: 'MANAGE_ADMINS', groupId: networkTag },
          stranger
        );
        out.grant = { ok: r1?.ok, code: r1?.code };
        let r2;
        try {
          r2 = await App.MemberAdminOperations.removeMember(App.publicKey, stranger);
        } catch (e) {
          r2 = { ok: false, code: e?.code || 'THROWN' };
        }
        out.remove = { ok: r2?.ok, code: r2?.code };
        out.stillAdmin = ui.canSeeGroupAdminMenu();
        return out;
      },
      { stranger: pubB, networkTag: created.networkTag }
    );
    set(
      'FORCED_UI_PRIVILEGE_BYPASS_REJECTED',
      bypass.strangerCan === false && bypass.grant.ok === false && bypass.remove.ok === false && bypass.creatorCan === true,
      bypass
    );

    // Phase 3: OFF -> reload
    flagsMode = 'off';
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await bootIdentity(pageA, keyA);
    const off2 = await flagState(pageA);
    report.phases.off2 = off2;
    set('TOGGLE_OFF_AFTER_ON_HIDDEN', offHidden(off2) && off2.brandMode !== 'community', off2);
    const tagsOff = await pageA.evaluate(() => ({
      feed: window.NostrApp.resolveFeedNetworkTags(),
      ambient: window.NostrApp.NETWORK_TAG,
      active: window.NostrApp.CommunityContext.snapshot().communityId,
    }));
    set(
      'TOGGLE_OFF_FEED_GLOBAL_ONLY',
      tagsOff.feed.length === 1 && !/^community-/.test(tagsOff.feed[0]) && !/^community-/.test(tagsOff.ambient) && tagsOff.active === 'sos010',
      tagsOff
    );

    // Phase 4: ON -> reload (state persists)
    flagsMode = 'on';
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await bootIdentity(pageA, keyA);
    const on2 = await flagState(pageA);
    const persisted = await pageA.evaluate(
      (cid) => ({
        found: !!window.NostrApp.CommunityContext.getByCommunityId(cid),
        active: window.NostrApp.CommunityContext.snapshot().communityId === cid,
      }),
      created.communityId
    );
    set('TOGGLE_ON_AGAIN_STATE_PERSISTS', on2.v2 && on2.createVisible && persisted.found && persisted.active, { v2: on2.v2, persisted });

    // Phase 5: final OFF
    flagsMode = 'off';
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const off3 = await flagState(pageA);
    set('TOGGLE_CYCLE_OFF_ON_OFF_ON_OFF', offHidden(off3), { v2: off3.v2 });
    set('BROWSER_NO_NSEC_IN_DOM', ![off1, on1, off2, on2, off3].some((s) => s.nsecDom));

    // P2P + chat regression with config OFF (fresh users). Runs on 127.0.0.1 because
    // http://sos010.com (mapped) is not a secure context: no WebCrypto => no secure P2P.
    await ctxA.close();
    flagsMode = 'off';
    const freshBoot = async (key) => {
      const c = await browser.newContext({ permissions: ['microphone', 'camera'] });
      const pg = await c.newPage();
      await pg.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await pg.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, { timeout: 90000 });
      const pub = await pg.evaluate(async (k) => {
        const App = window.NostrApp;
        const created = App.createNewIdentityExplicit({ privateKeyHex: k });
        App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: created.publicKey, bump: true });
        await new Promise((r) => setTimeout(r, 900));
        return String(created.publicKey || '').toLowerCase();
      }, key);
      return { c, pg, pub };
    };
    const keyC = hex(generateSecretKey());
    const fa = await freshBoot(keyC);
    const fb = await freshBoot(keyB);
    const offP2p = await fa.pg.evaluate(() => window.SOS_ACCESS_CONTROL_V2 === true);
    set('P2P_CONTEXT_V2_OFF', offP2p === false);
    await p2pChatAndSw({ browser, pageA: fa.pg, pageB: fb.pg, pubA: fa.pub, pubB, ctxs: [fa.c, fb.c] });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(() => r()));
  }
}

async function p2pChatAndSw({ browser, pageA, pageB, pubA, pubB, ctxs }) {
  {
    const tok = 'SOS-896-CHAT-' + Date.now();
    await pageA.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'B' });
      window.NostrApp.showChatConversation?.(p);
    }, pubB);
    await pageB.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'A' });
      window.NostrApp.showChatConversation?.(p);
    }, pubA);
    const chatSend = await pageA.evaluate(
      async ({ peer, text }) => {
        try {
          const pub = await window.NostrApp.publishChatMessage(peer, text);
          return { ok: !!pub };
        } catch (e) {
          return { ok: false, err: String(e.message || e) };
        }
      },
      { peer: pubB, text: tok }
    );
    set('CHAT_REGRESSION_V2_OFF', chatSend.ok, chatSend);
    for (const [pg, peer] of [
      [pageA, pubB],
      [pageB, pubA],
    ]) {
      await pg.evaluate(async (p) => {
        try {
          await window.NostrApp.dataChannel?.connect?.(p);
        } catch (_e) {}
      }, peer);
    }
    let p2p = null;
    for (let i = 0; i < 70; i++) {
      if (i === 25) {
        for (const [pg, peer] of [
          [pageA, pubB],
          [pageB, pubA],
        ]) {
          await pg.evaluate(async (p) => {
            try {
              await window.NostrApp.dataChannel?.connect?.(p);
            } catch (_e) {}
          }, peer);
        }
      }
      p2p = await pageA.evaluate((peer) => {
        const entry = window.NostrApp.dataChannel?._peers?.get?.(String(peer).toLowerCase());
        const pc = entry?.pc || entry?.peerConnection;
        const dc = entry?.dc || entry?.dataChannel;
        return {
          connected: !!window.NostrApp.dataChannel?.isConnected?.(peer),
          ice: pc?.iceConnectionState || null,
          dc: dc?.readyState || null,
        };
      }, pubB);
      if (p2p.connected || p2p.dc === 'open' || p2p.ice === 'connected' || p2p.ice === 'completed') break;
      await sleep(1000);
    }
    const p2pOk = !!(p2p?.connected || p2p?.dc === 'open' || p2p?.ice === 'connected' || p2p?.ice === 'completed');
    set('P2P_REGRESSION_V2_OFF', p2pOk, p2p);
    const social = await pageA.evaluate(() => {
      const App = window.NostrApp;
      return {
        like: typeof App.likePost === 'function',
        share: typeof App.sharePost === 'function',
        follow: typeof App.followUser === 'function' || typeof App.toggleFollow === 'function',
      };
    });
    set('SOCIAL_REGRESSION_V2_OFF', social.like && social.share && social.follow, social);
    for (const c of ctxs) await c.close();

    // Service Worker coherence on secure local origin
    const ctxS = await browser.newContext();
    const pageS = await ctxS.newPage();
    flagsMode = 'on';
    await pageS.goto(LOCAL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await pageS.waitForFunction(() => window.SosFeatureFlags?.isResolved(), { timeout: 30000 });
    const swCtl = await pageS
      .waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30000 })
      .then(() => true)
      .catch(async () => {
        await pageS.reload({ waitUntil: 'domcontentloaded' });
        return pageS
          .waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30000 })
          .then(() => true)
          .catch(() => false);
      });
    await pageS.waitForFunction(() => window.SosFeatureFlags?.isResolved(), { timeout: 30000 });
    const swOn = await pageS.evaluate(() => ({ v2: window.SOS_ACCESS_CONTROL_V2 === true, cache: null }));
    flagsMode = 'off';
    const reqBefore = flagsRequests;
    await pageS.reload({ waitUntil: 'domcontentloaded' });
    await pageS.waitForFunction(() => window.SosFeatureFlags?.isResolved(), { timeout: 30000 });
    const swOff = await pageS.evaluate(async () => {
      const names = await caches.keys();
      let cachedFlags = false;
      for (const n of names) {
        const c = await caches.open(n);
        const keys = await c.keys();
        if (keys.some((k) => k.url.includes('runtime-feature-flags.json'))) cachedFlags = true;
      }
      return { v2: window.SOS_ACCESS_CONTROL_V2 === true, names, cachedFlags };
    });
    set(
      'SW_CACHE_COHERENCE_TOGGLE',
      swCtl && swOn.v2 === true && swOff.v2 === false && flagsRequests > reqBefore && !swOff.cachedFlags && swOff.names.includes('sos-cache-v896'),
      { swCtl, swOn: swOn.v2, swOff }
    );
    flagsMode = 'on';
    await ctxS.setOffline(true);
    let offline = null;
    try {
      await pageS.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await pageS.waitForFunction(() => window.SosFeatureFlags?.isResolved(), { timeout: 30000 });
      offline = await pageS.evaluate(() => ({ v2: window.SOS_ACCESS_CONTROL_V2 === true, err: window.SosFeatureFlags.snapshot().errorCode }));
    } catch (e) {
      offline = { v2: false, err: 'PAGE_UNAVAILABLE_OFFLINE', detail: String(e.message || e).slice(0, 80) };
    }
    set('SW_OFFLINE_FAIL_CLOSED', offline.v2 === false, offline);
    await ctxS.close();
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const allChanged = git(`git diff --name-only ${PROD895}`)
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((f) => !/^qa\/(\..*\.txt|.*report.*\.json)$/.test(f) || f === 'qa/package896-rc-report.json');
  report.delta = { files: allChanged, count: allChanged.length };
  const unrelated = allChanged.filter((f) => f.startsWith('android-shell/') || /\.apk$|MD4/i.test(f));
  set('PACKAGE896_SURGICAL_DELTA', unrelated.length === 0 && allChanged.length > 0 && allChanged.length <= 30, allChanged);
  set('ANDROID_UNTOUCHED', !allChanged.some((f) => f.startsWith('android-shell/')));

  // Static
  const av = JSON.parse(read('app-version.json'));
  const sw = read('service-worker.js');
  const swr = read('sw-register.js');
  const videos = read('videos.html');
  const flags = JSON.parse(read('runtime-feature-flags.json'));
  report.ACCESS_CONTROL_V2_SHIPPED_VALUE = flags.accessControlV2;
  set('PACKAGE896_VERSION_GATE', av.version === '2026.09.27-web-896' && /pkg=896/.test(videos) && !/pkg=895/.test(videos), av.version);
  set('PACKAGE896_CACHE_GATE', /'sos-cache-v896'/.test(sw) && !/sos-cache-v895/.test(sw) && /pkg=896/.test(swr));
  set('SHIPPED_CONFIG_V2_OFF', flags.schema === 'sos-feature-flags-v1' && flags.accessControlV2 === false && Object.keys(flags).length === 2, flags);
  set('SW_BYPASSES_FLAG_CONFIG', /endsWith\('\/runtime-feature-flags\.json'\)\) return;/.test(sw) && !/runtime-feature-flags/.test(sw.split('self.addEventListener(\'fetch\'')[0]));
  const loaderIdx = videos.indexOf('<script src="./feature-flags.js?pkg=896"></script>');
  const firstV2 = Math.min(
    ...['community-context.js', 'access-control-v2-local-test.js', 'access-control.js', 'feed.js', 'group-admin-product-ui.js', 'admin-settings-ui.js']
      .map((f) => videos.indexOf('./' + f))
      .filter((i) => i >= 0)
  );
  set('FLAG_LOADS_BEFORE_V2_SYNC', loaderIdx > 0 && loaderIdx < firstV2, { loaderIdx, firstV2 });
  const localHelper = read('access-control-v2-local-test.js');
  set('LOCAL_TEST_HELPER_UNCHANGED_PROD_BLOCK', /hostIsProduction/.test(localHelper) && /sos010\.com/.test(localHelper));
  const uiGated = ['group-admin-product-ui.js', 'admin-settings-ui.js', 'member-directory-ui.js', 'community-feed-selection.js'].every((f) => {
    const s = read(f);
    return /sos-feature-flags-ready/.test(s) && /booted \|\| !isV2\(\)/.test(s);
  });
  set('V2_UI_BOOTS_ON_RESOLVED_FLAG', uiGated);

  await vmSuite();

  // SIGN_FEED
  const signer = read('sos-crypto-signer.js');
  const m = signer.match(/SIGN_FEED:\s*\{\s*kinds:\s*\[([^\]]+)\]/);
  const kinds = m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : [];
  set('SIGN_FEED_ALLOWED_KINDS', kinds.length === 2 && kinds[0] === 1 && kinds[1] === 6, kinds);
  const allow = runNode('qa/package894-sign-feed-allowlist-gate.mjs');
  set('SIGN_FEED_NEGATIVE_ALLOWLIST_GATE', allow.ok, allow.out.slice(0, 120));

  // Secret leak static on changed JS
  let leak = false;
  for (const f of allChanged.filter((x) => /\.(js|json|html)$/.test(x) && fs.existsSync(path.join(ROOT, x)))) {
    const s = read(f);
    if (/nsec1[a-z0-9]{50,}/i.test(s) || /privateKeyHex\s*[:=]\s*['"][0-9a-f]{64}['"]/i.test(s)) leak = true;
  }
  set('SECRET_LEAK_GATE', !leak);

  // Community / adversarial suites
  const community = runNode('qa/access-control-v2-community-product-gate.mjs');
  set('COMMUNITY_PRODUCT_SUITE', community.ok, community.out.slice(0, 160));
  const adv = runNode('qa/access-control-ac10-adversarial-authorization-gate.mjs');
  set('ACCESS_CONTROL_ADVERSARIAL_GATE', adv.ok, adv.out.slice(0, 160));

  // Master security (same policy as Package 895 RC)
  for (const [name, script] of [
    ['EXISTING_KEY_IMPORT_GATE', 'qa/sos-crypto-worker-f5a-gate.mjs'],
    ['F5B6', 'qa/f5b6-sealed-migration-gate.mjs'],
    ['F6A', 'qa/native-secure-identity-store-f6a-gate.mjs'],
    ['F6I', 'qa/native-f6i-adversarial-acceptance-gate.mjs'],
  ]) {
    const r = runNode(script);
    set(name, r.ok, r.ok ? 'rerun PASS' : r.out.slice(0, 140));
  }
  let f5b6StaticOk = false;
  try {
    const rows = JSON.parse(read('qa/f5b6-sealed-migration-report.json')).results || [];
    f5b6StaticOk = rows.some((x) => String(x).includes('PASS F5B6_STATIC_SECRET_SCAN'));
  } catch (_e) {}
  const masterOk =
    report.results.ANDROID_UNTOUCHED.ok &&
    f5b6StaticOk &&
    report.results.F6A.ok &&
    report.results.F6I.ok &&
    report.results.EXISTING_KEY_IMPORT_GATE.ok;
  set('MASTER_SECURITY_REGRESSION', masterOk, report.results.F5B6.ok ? 'full' : 'android delta=0; F5B6 static + F6A/F6I + worker PASS');

  try {
    await browserSuite();
  } catch (e) {
    set('BROWSER_SUITE', false, String(e.stack || e).slice(0, 300));
  }

  set('DOC_ACTIVATION_PLAN', /Package 896/.test(read('docs/ACCESS_CONTROL_V2_ACTIVATION_PLAN.md')));
  set('DOC_896_RELEASE_PLAN', fs.existsSync(path.join(ROOT, 'docs/PACKAGE896_FEATURE_FLAG_RELEASE_PLAN.md')));

  const informational = new Set(['F5B6']);
  const missing = Object.entries(report.results)
    .filter(([k, v]) => !v.ok && !informational.has(k))
    .map(([k]) => k);
  const allOk = missing.length === 0;
  report.status = allOk ? 'PASS' : 'FAIL';
  report.PACKAGE896_RC_STATUS = allOk ? 'READY_FOR_OWNER_APPROVAL' : 'BLOCKED';
  report.missing = missing;
  report.PACKAGE896_RC_SHA = git('git rev-parse HEAD');
  report.PACKAGE896_RC_TREE_HASH = git('git show -s --format=%T HEAD');
  report.RC_IDENTITY_NOTE = 'SHA/tree above are HEAD at gate run time; final RC identity is the commit that contains this report.';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('STATUS', report.status);
  console.log('MISSING', missing.join(',') || 'none');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  report.status = 'FAIL';
  report.error = String(e.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  process.exit(1);
});
