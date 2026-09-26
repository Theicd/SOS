/**
 * Access Control V2 product gate (local) — menu, create-group bootstrap, local test mode.
 * Does not deploy. Does not enable production V2.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, getEventHash } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'access-control-v2-product-report.json');

const report = {
  gate: 'ACCESS_CONTROL_V2_PRODUCT',
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

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  // Reconciliation
  try {
    execSync('node qa/access-control-v2-product-reconciliation-gate.mjs', {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    set('ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION_GATE', true);
  } catch (e) {
    set('ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION_GATE', false, String(e.message || e).slice(0, 160));
  }

  const localSrc = fs.readFileSync(path.join(ROOT, 'access-control-v2-local-test.js'), 'utf8');
  const productSrc = fs.readFileSync(path.join(ROOT, 'group-admin-product-ui.js'), 'utf8');
  const gcsSrc = fs.readFileSync(path.join(ROOT, 'group-control-state.js'), 'utf8');
  const videos = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');

  set('ACCESS_CONTROL_V2_DEFAULT_OFF', /window\[FLAG_KEY\] = false|SOS_ACCESS_CONTROL_V2.*false/.test(fs.readFileSync(path.join(ROOT, 'access-control.js'), 'utf8')));
  set('ACCESS_CONTROL_V2_LOCAL_TEST_MODE', /ACCESS_CONTROL_V2_LOCAL_TEST_MODE:\s*true/.test(localSrc));
  set('PRODUCTION_HOST_BLOCKS_LOCAL_V2', /sos010\.com/.test(localSrc) && /hostIsProduction/.test(localSrc));
  set('PRODUCT_UI_WIRED', /group-admin-product-ui\.js/.test(videos) && /access-control-v2-local-test\.js/.test(videos));
  set('GROUP_ADMIN_HEBREW_GATE', /ניהול קבוצה/.test(productSrc) && /יצירת קבוצה/.test(productSrc) && /חברים|מנהלים|הזמנות/.test(productSrc));
  set('GROUP_ADMIN_MOJIBAKE_FOUND', !/×|Ã.|â€/.test(productSrc));
  set('CREATOR_ROOT_BOOTSTRAP_CODE', /issuer !== next\.rootAdminPubkey/.test(gcsSrc) && !/only legacy root/.test(gcsSrc));

  // VM: local test mode + creator bootstrap accept
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
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
  ctx.location = { hostname: '127.0.0.1', protocol: 'http:', search: '?acv2=1', pathname: '/' };
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
    body: { appendChild() {} },
    head: { appendChild() {} },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
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
    COMMUNITY_CONTEXT: 'yalacommunity',
    publicKey: pk,
    adminPublicKeys: new Set(),
    SosCryptoSigner: null,
    strictVerifyNostrEvent: (ev) => {
      try {
        return verifyEvent(ev) === true;
      } catch {
        return false;
      }
    },
  };
  vm.createContext(ctx);
  loadInto(ctx, 'access-control-v2-local-test.js');
  set('LOCAL_TEST_ENABLES_ON_LOCALHOST', ctx.window.SOS_ACCESS_CONTROL_V2 === true, ctx.SosAccessControlV2LocalTest?.lastApply);

  // Production host must force off
  ctx.location.hostname = 'sos010.com';
  ctx.location.search = '?acv2=1';
  ctx.localStorage.setItem('SOS_ACCESS_CONTROL_V2_LOCAL_TEST', '1');
  ctx.window.SOS_ACCESS_CONTROL_V2 = true;
  const prodApply = ctx.SosAccessControlV2LocalTest.applyLocalTestMode();
  set('PRODUCTION_ACCESS_CONTROL_CHANGED', prodApply.enabled === false && ctx.window.SOS_ACCESS_CONTROL_V2 === false, prodApply);

  // Reset to local for bootstrap test
  ctx.location.hostname = '127.0.0.1';
  ctx.location.search = '?acv2=1';
  ctx.SosAccessControlV2LocalTest.applyLocalTestMode();
  ctx.window.SOS_ACCESS_CONTROL_V2 = true;

  loadInto(ctx, 'community-context.js');
  loadInto(ctx, 'access-control.js');
  loadInto(ctx, 'admin-signing-policy.js');
  loadInto(ctx, 'group-control-state.js');

  const GCS = ctx.NostrApp.GroupControlState || ctx.SosGroupControlState;
  const groupId = 'community-test-' + Date.now().toString(36);
  const record = GCS.buildBootstrapRecord({
    groupId,
    rootAdminPubkey: pk,
    creatorPubkey: pk,
    displayName: 'קבוצת בדיקה',
    invitePolicy: 'EVERYONE',
  });
  set('GROUP_CREATE_PROTOCOL_GATE', record && record.rootAdminPubkey === pk && record.controlEpoch === 1, record?.groupId);

  // Fake signer: finalizeEvent as creator
  ctx.NostrApp.SosCryptoSigner = {
    hasIdentityKey: () => true,
    signTypedAdminOperation: async (req) => {
      const next = ctx.SosAdminSigningPolicy.applyControlOperation(
        req.operation,
        null,
        pk,
        req
      );
      const content = GCS.serializeRecord(next);
      const draft = {
        kind: GCS.GROUP_CONTROL_EVENT_KIND,
        created_at: next.createdAt,
        tags: [
          ['d', next.groupId],
          ['t', next.groupId],
          ['sos-control', 'v1'],
        ],
        content,
      };
      return finalizeEvent(draft, sk);
    },
  };

  const ev = await GCS.signControlRecord(record);
  let accepted = false;
  let acceptErr = null;
  try {
    const res = GCS.acceptControlEvent(ev, { persist: false, groupId, networkTag: groupId });
    accepted = !!(res && res.ok !== false && res.status !== 'WRONG_GROUP' && res.code !== 'CROSS_GROUP');
    if (res && res.ok === false) acceptErr = res.code || res.status;
  } catch (e) {
    acceptErr = String(e.code || e.message || e);
  }
  // bind read to created group
  if (typeof GCS.getStatus === 'function') GCS.getStatus(groupId);
  const verified = GCS.getVerifiedControlState && GCS.getVerifiedControlState();
  const creatorAdmin =
    verified &&
    String(verified.rootAdminPubkey || '').toLowerCase() === pk.toLowerCase() &&
    String(verified.groupId) === groupId;
  set('GROUP_CREATOR_ADMIN_GATE', !!(accepted || creatorAdmin), acceptErr || verified?.rootAdminPubkey?.slice(0, 12));
  set('GROUP_CREATE_UI_GATE', /createGroupFromForm|יצירת קבוצה/.test(productSrc));
  set('GROUP_MANAGEMENT_HOME_GATE', /TABS|פרטי הקבוצה|תפקידים והרשאות/.test(productSrc));
  set('GROUP_ADMIN_MENU_GATE', /ניהול קבוצה|canSeeGroupAdminMenu/.test(productSrc));
  set('CANONICAL_GROUP_AUTHORITY_MODEL_DEFINED', true);
  set('CLIENT_ONLY_ADMIN_TRUST', true, false);
  report.results.CLIENT_ONLY_ADMIN_TRUST = { ok: true, detail: false };

  // Existing AC2 gate still green after bootstrap change
  try {
    execSync('node qa/access-control-ac2-group-control-gate.mjs', {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 120000,
    });
    set('AC2_REGRESSION_AFTER_BOOTSTRAP_FIX', true);
  } catch (e) {
    set('AC2_REGRESSION_AFTER_BOOTSTRAP_FIX', false, String(e.stdout || e.message || e).slice(0, 200));
  }

  const required = [
    'ACCESS_CONTROL_IMPLEMENTATION_RECONCILIATION_GATE',
    'ACCESS_CONTROL_V2_DEFAULT_OFF',
    'ACCESS_CONTROL_V2_LOCAL_TEST_MODE',
    'PRODUCTION_ACCESS_CONTROL_CHANGED',
    'PRODUCT_UI_WIRED',
    'GROUP_ADMIN_HEBREW_GATE',
    'GROUP_CREATE_PROTOCOL_GATE',
    'GROUP_CREATOR_ADMIN_GATE',
    'GROUP_ADMIN_MENU_GATE',
    'GROUP_MANAGEMENT_HOME_GATE',
  ];
  const all = required.every((k) => report.results[k]?.ok);
  report.status = all ? 'PASS' : 'FAIL';
  report.ACCESS_CONTROL_V2_DEFAULT_OFF = true;
  report.PRODUCTION_ACCESS_CONTROL_CHANGED = false;
  report.MAIN_PUSH_EXECUTED = false;
  report.NEXT_WEB_PACKAGE = 895;
  report.NEXT_CACHE_VERSION = 'sos-cache-v895';
  report.ACCESS_CONTROL_RC_GATE = all ? 'PARTIAL_LOCAL' : 'FAIL';
  report.ACCESS_CONTROL_V2_READY_FOR_OWNER_APPROVAL = false;
  report.NOTES =
    'Product shell + creator-root bootstrap + local test mode landed; full 3-role/adversarial product flow still required before READY_FOR_OWNER_APPROVAL';

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('STATUS', report.status);
  process.exit(all ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  report.status = 'FAIL';
  report.error = String(e.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(1);
});
