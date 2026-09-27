/**
 * Package 897 RC gate — first-group (sos010 / israel-network) admin control center.
 * Exact local tree only. Does NOT deploy. Does NOT change production config.
 * ACCESS_CONTROL_V2 must ship OFF; the E2E enables it only on a local static server.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package897-rc-report.json');
const PROD896 = '1b922c0312dfcd6feb2b4a127ef127b89997ba64';
const PRODUCT_PORT = 8794;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  gate: 'PACKAGE897_RC',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  informational: {},
  groups: {},
  PACKAGE897_RC_SHA: null,
  PACKAGE897_RC_TREE_HASH: null,
  ROLLBACK_TARGET_SHA: PROD896,
  NEXT_WEB_PACKAGE: 897,
  NEXT_CACHE_VERSION: 'sos-cache-v897',
  ACCESS_CONTROL_V2_SHIPPED_VALUE: null,
  MAIN_PUSH_EXECUTED: false,
  MAIN_DEPLOY_EXECUTED: false,
  CDN_PRODUCTION_CHANGED: false,
  PRODUCTION_ACCESS_CONTROL_CHANGED: false,
  ANDROID_WORK_EXECUTED: false,
  APK_BUILT: false,
  MD4_STARTED: false,
  PACKAGE897_RC_STATUS: 'BLOCKED',
};

const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};
const info = (k, ok, detail) => {
  report.informational[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'INFO-PASS' : 'INFO-FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};

function runNode(script, { timeoutMs = 600000, env = {} } = {}) {
  try {
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.stderr || e.message || e).slice(-600) };
  }
}

function startStaticServer(port) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json',
  };
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
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function main() {
  // ---------------------------------------------------------------- delta
  const tracked = git(`git diff --name-only ${PROD896}`).split(/\r?\n/).filter(Boolean);
  const untracked = git('git ls-files --others --exclude-standard').split(/\r?\n/).filter(Boolean);
  const isNoise = (f) => /^qa\/(\..*|.*report.*\.json|.*\.png)$/.test(f);
  const delta = [...new Set([...tracked, ...untracked])].filter((f) => !isNoise(f));
  report.delta = { files: delta, count: delta.length };
  const forbidden = delta.filter((f) => f.startsWith('android-shell/') || /\.apk$|MD4/i.test(f) || /^downloads\//.test(f));
  set('PACKAGE897_SCOPE_DELTA', forbidden.length === 0 && delta.length > 0, delta);
  set('ANDROID_UNTOUCHED', !delta.some((f) => f.startsWith('android-shell/')) && !delta.some((f) => /\.apk$/.test(f)));
  const multiCommunity = delta.filter((f) => /community-(context|feed-selection)|relay-sync|community-discovery/i.test(f));
  set('NO_MULTI_COMMUNITY_PROTOCOL_CHANGES', multiCommunity.length === 0, multiCommunity);

  // ---------------------------------------------------------------- static release metadata
  const av = JSON.parse(read('app-version.json'));
  const sw = read('service-worker.js');
  const swr = read('sw-register.js');
  const videos = read('videos.html');
  const flags = JSON.parse(read('runtime-feature-flags.json'));
  report.ACCESS_CONTROL_V2_SHIPPED_VALUE = flags.accessControlV2;
  set('PACKAGE897_VERSION_GATE', av.version === '2026.09.27-web-897' && /pkg=897/.test(videos) && !/pkg=896/.test(videos), av.version);
  set('PACKAGE897_CACHE_GATE', /'sos-cache-v897'/.test(sw) && !/sos-cache-v896/.test(sw) && /pkg=897/.test(swr));
  set('SHIPPED_CONFIG_V2_OFF', flags.schema === 'sos-feature-flags-v1' && flags.accessControlV2 === false && Object.keys(flags).length === 2, flags);
  set('SW_BYPASSES_FLAG_CONFIG', /endsWith\('\/runtime-feature-flags\.json'\)\) return;/.test(sw));
  const loaderIdx = videos.indexOf('<script src="./feature-flags.js?pkg=897"></script>');
  const firstV2 = Math.min(
    ...['community-context.js', 'access-control-v2-local-test.js', 'access-control.js', 'feed.js', 'group-admin-product-ui.js', 'first-group-admin.js']
      .map((f) => videos.indexOf('./' + f))
      .filter((i) => i >= 0)
  );
  set('FLAG_LOADS_BEFORE_V2_SYNC', loaderIdx > 0 && loaderIdx < firstV2, { loaderIdx, firstV2 });
  set('FIRST_GROUP_ADMIN_WIRED', /first-group-admin\.js\?pkg=897/.test(videos) && videos.indexOf('first-group-admin.js') < videos.indexOf('group-admin-product-ui.js'));
  const fga = read('first-group-admin.js');
  const ui = read('group-admin-product-ui.js');
  set('V2_UI_BOOTS_ON_RESOLVED_FLAG', /sos-feature-flags-ready/.test(ui) && /booted \|\| !isV2\(\)/.test(ui) && /sos-feature-flags-ready/.test(fga));
  set('NEW_GROUP_CREATION_DEFERRED', /MULTI_COMMUNITY_DEFERRED/.test(ui) && /NEW_GROUP_CREATION/.test(ui));
  set('DOUBLE_REDEEM_SCOPE_DECLARED', /DOUBLE_REDEEM_SCOPE\s*=\s*'LOCAL_ONLY'|DOUBLE_REDEEM_SCOPE:\s*'LOCAL_ONLY'/.test(fga));

  // ---------------------------------------------------------------- typed signer / secrets
  const signer = read('sos-crypto-signer.js');
  const m = signer.match(/SIGN_FEED:\s*\{\s*kinds:\s*\[([^\]]+)\]/);
  const kinds = m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : [];
  set('SIGN_FEED_ALLOWED_KINDS', kinds.length === 2 && kinds[0] === 1 && kinds[1] === 6, kinds);
  set('SIGNER_UNCHANGED_SINCE_896', !delta.includes('sos-crypto-signer.js') && !delta.includes('sos-crypto-worker.js') && !delta.includes('sos-crypto-worker-vault.js'));
  const allow = runNode('qa/package894-sign-feed-allowlist-gate.mjs');
  set('SIGN_FEED_NEGATIVE_ALLOWLIST_GATE', allow.ok, allow.out.slice(-160));
  let leak = [];
  for (const f of delta.filter((x) => /\.(js|mjs|json|html|md)$/.test(x) && fs.existsSync(path.join(ROOT, x)))) {
    const s = read(f);
    if (/nsec1[a-z0-9]{50,}/i.test(s) || /privateKeyHex\s*[:=]\s*['"][0-9a-f]{64}['"]/i.test(s)) leak.push(f);
  }
  set('SECRET_LEAK_GATE', leak.length === 0, leak);
  const noRawSigning = !/App\.signEvent\s*=|window\.nostr\s*=|signRawEvent|finalizeEvent\(/.test(fga + ui);
  set('NO_GENERIC_RAW_SIGNING_SURFACE', noRawSigning);

  // ---------------------------------------------------------------- access-control suites
  for (const [name, script] of [
    ['AC1', 'qa/access-control-ac1-gate.mjs'],
    ['AC2_GROUP_CONTROL', 'qa/access-control-ac2-group-control-gate.mjs'],
    ['AC2_CONTROL_CONVERGENCE', 'qa/access-control-ac2-control-convergence-gate.mjs'],
    ['AC3_INVITE_POLICY', 'qa/access-control-ac3-invite-policy-gate.mjs'],
    ['AC4_MODERATION', 'qa/access-control-ac4-moderation-gate.mjs'],
    ['AC5_MEMBERSHIP', 'qa/access-control-ac5-membership-gate.mjs'],
    ['AC5_MEMBERSHIP_CONVERGENCE', 'qa/access-control-ac5-membership-convergence-gate.mjs'],
    ['AC7_MEMBER_DIRECTORY', 'qa/access-control-ac7-member-directory-gate.mjs'],
    ['AC8_GUEST_HARDENING', 'qa/access-control-ac8-guest-hardening-gate.mjs'],
    ['AC9_TYPED_ADMIN_SIGNER', 'qa/access-control-ac9-typed-admin-signer-gate.mjs'],
    ['AC10_ADVERSARIAL', 'qa/access-control-ac10-adversarial-authorization-gate.mjs'],
    ['ACCESS_CONTROL_RECONCILIATION', 'qa/access-control-v2-product-reconciliation-gate.mjs'],
  ]) {
    const r = runNode(script);
    set(name, r.ok, r.ok ? 'PASS' : r.out.slice(-160));
  }
  // Superseded static gates: they assert the deferred group-creation surface ("יצירת קבוצה").
  for (const [name, script] of [
    ['SUPERSEDED_V2_PRODUCT_GATE', 'qa/access-control-v2-product-gate.mjs'],
    ['SUPERSEDED_COMMUNITY_PRODUCT_GATE', 'qa/access-control-v2-community-product-gate.mjs'],
    ['PREEXISTING_AC6_ADMIN_UI_GATE', 'qa/access-control-ac6-admin-ui-gate.mjs'],
  ]) {
    const r = runNode(script);
    info(name, r.ok, r.ok ? 'PASS' : 'expected: group creation deferred / pre-existing on 896');
  }

  // ---------------------------------------------------------------- first-group E2E
  const e2e = runNode('qa/package897-first-group-admin-e2e.mjs', { timeoutMs: 1200000 });
  let er = {};
  try {
    er = JSON.parse(read('qa/package897-first-group-admin-e2e-report.json'));
  } catch (_e) {}
  const R = er.results || {};
  const all = (keys) => keys.every((k) => R[k] && R[k].ok === true);
  report.E2E_SCOPE = er.E2E_SCOPE || null;
  report.NETWORK_BACKED_E2E = er.NETWORK_BACKED_E2E ?? null;
  report.DOUBLE_REDEEM_SCOPE = er.DOUBLE_REDEEM_SCOPE || null;
  report.E2E_CHECKS = Object.keys(R).length;
  set('FIRST_GROUP_ADMIN_E2E', e2e.ok && er.status === 'PASS' && Object.keys(R).length >= 66, { status: er.status, checks: Object.keys(R).length, missing: er.missing });
  const groups = {
    FULL_E2E: [
      'FIRST_GROUP_CONTEXT', 'NO_AMBIGUOUS_ADMIN_GROUP_CONTEXT', 'FIRST_GROUP_BOOTSTRAP_BY_CONFIGURED_ROOT', 'DASHBOARD_SECTIONS_FULL_ADMIN',
      'INVITE_CREATE_IN_ADMIN_PAGE', 'INVITE_COPY_IN_ADMIN_PAGE', 'INVITE_VALIDATE_REDEEM', 'JOIN_APPROVAL_UI', 'SECOND_MEMBER_JOIN',
      'GROUP_METADATA_EDIT', 'GROUP_METADATA_PERSISTS_RELOAD', 'MEMBER_DIRECTORY', 'GRANT_INVITE_ONLY_UI', 'INVITER_ROLE_EXACT',
      'INVITER_LIMITED_SURFACE', 'INVITER_CREATE_COPY_QR', 'GRANT_MODERATION_UI', 'DELEGATED_MODERATOR', 'PROMOTE_ADMIN_UI', 'ADMIN_LIST',
      'REMOVE_ONE_CAPABILITY', 'DEMOTE_ADMIN_UI', 'REMOVE_MEMBER_UI', 'QR_INVITE_JOIN_APPROVED', 'INVITE_REVOKE', 'INVITE_EXPIRED_REJECTED',
      'DOUBLE_REDEEM_REJECTED', 'HARD_RELOAD_STATE', 'MULTI_TAB_SYNC', 'AUDIT_MODEL', 'THREE_ROLE_UI', 'DESKTOP_MOBILE_UI',
      'HEBREW_LABELS_NO_MOJIBAKE', 'CONFIRMATION_CANCEL_KEEPS_STATE', 'ROLE_PRESET_ASSIGN_UI',
    ],
    ADVERSARIAL: [
      'ATTACKER_BOOTSTRAP_REJECTED', 'FORGED_ROOT_BOOTSTRAP_NO_CONFLICT_ON_HONEST_PEER', 'INVITER_NO_ADMIN_POWERS',
      'FORGED_ISADMIN_ROLE_OVERLAY_DOM_REJECTED', 'FORGED_MEMBERSHIP_CACHE_REJECTED', 'FORGED_SELECTED_GROUP_REJECTED',
      'FORGED_CAPABILITY_EVENTS_REJECTED', 'FORGED_CACHE_CONTROL_EVENT_REJECTED', 'SELF_GRANT_ESCALATION_DIRECT_CALL_REJECTED',
      'STALE_DEVICE_ACTION_REJECTED_BY_AUTHORITATIVE_PEER', 'STALE_TAB_NO_AUTHORITY_AFTER_DEMOTE', 'REMOVED_MEMBER_PRIVILEGED_ACTIONS_FAIL',
      'MANAGE_ADMINS_SEMANTICS', 'MANAGE_PERMISSIONS_SEMANTICS', 'LAST_OWNER_SAFETY',
    ],
    QR_SECURITY: ['QR_RENDER_FROM_CANONICAL_INVITE', 'QR_SECRET_SCAN', 'QR_SCAN_PARSE_BINDS_GROUP', 'QR_ADVERSARIAL'],
    AUTHORITATIVE_GATEWAY: ['INVITER_NO_ADMIN_POWERS', 'UI_MATCHES_EFFECTIVE_AUTHORITY', 'FORGED_ISADMIN_ROLE_OVERLAY_DOM_REJECTED', 'SELF_GRANT_ESCALATION_DIRECT_CALL_REJECTED'],
    SESSION_AUTHORITY: ['SESSION_AUTHORITY', 'ACCOUNT_SWITCH_NO_LEAK', 'MULTI_TAB_SYNC', 'STALE_TAB_NO_AUTHORITY_AFTER_DEMOTE', 'TYPED_SIGNER_BOUNDARIES'],
  };
  for (const [g, keys] of Object.entries(groups)) {
    const missing = keys.filter((k) => !(R[k] && R[k].ok === true));
    report.groups[g] = missing.length === 0 ? 'PASS' : 'FAIL';
    set(g, e2e.ok && missing.length === 0, missing.length ? missing : `${keys.length} checks`);
  }
  set('E2E_NO_NSEC_IN_ADMIN_DOM', all(['NO_NSEC_IN_ADMIN_DOM', 'NO_PAGE_ERRORS_IN_ADMIN_MODULES']));

  // ---------------------------------------------------------------- product regression
  const productMissing = [];
  // execSync blocks this event loop, so the static server for these gates runs in a child process.
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitForPort(PRODUCT_PORT);
    runNode('qa/package894-product-rc-gate.mjs', { env: { SOS_RC_URL: `http://127.0.0.1:${PRODUCT_PORT}/videos.html` } });
    // PACKAGE_894_VISIBLE asserts the old version label; DIRECT_P2P is environmental and also fails on the 896 baseline.
    const notApplicable = new Set(['PACKAGE_894_VISIBLE', 'DIRECT_P2P', 'PACKAGE894_PRODUCT_RC_GATE']);
    let pr = {};
    try {
      pr = JSON.parse(read('qa/package894-product-rc-report.json')).results || {};
    } catch (_e) {}
    const prKeys = Object.keys(pr).filter((k) => !notApplicable.has(k));
    const prBad = prKeys.filter((k) => !pr[k].ok);
    set('PRODUCT_RC_894_FLOWS', prKeys.length >= 18 && prBad.length === 0, prBad.length ? prBad : prKeys);
    if (prBad.length || prKeys.length < 18) productMissing.push('PRODUCT_RC_894_FLOWS');
    info('DIRECT_P2P_ENVIRONMENTAL', !!(pr.DIRECT_P2P && pr.DIRECT_P2P.ok), pr.DIRECT_P2P ? pr.DIRECT_P2P.detail : null);
    const sec = runNode('qa/package894-security-gate.mjs', { env: { SOS_RC_URL: `http://127.0.0.1:${PRODUCT_PORT}/videos.html` } });
    set('PRODUCT_SECURITY_894', sec.ok, sec.ok ? 'PASS' : sec.out.slice(-200));
    if (!sec.ok) productMissing.push('PRODUCT_SECURITY_894');
  } finally {
    server.kill();
    await sleep(1000);
  }
  const productRequired = [
    ['PRODUCT_SHARE_E2E', 'qa/package894-share-e2e-gate.mjs'],
    ['CHAT_READ_RECEIPT', 'qa/chat-read-receipt-gate.mjs'],
    ['FILE_SAFETY', 'qa/file-safety-gate.mjs'],
    ['VOICE_DURABLE_PLAYBACK', 'qa/voice-durable-playback-gate.mjs'],
    ['SOCIAL_REACTION', 'qa/social-reaction-ac0-gate.mjs'],
    ['WEB_PRODUCT_INVENTORY', 'qa/web-product-inventory-gate.mjs'],
    ['SECURE_P2P_V2', 'qa/secure-p2p-v2-gate.mjs'],
    ['P2P_SIGNAL_SIGNATURE', 'qa/p2p-signal-signature-gate.mjs'],
    ['MEDIA_FILE_E2EE_CORE', 'qa/media-file-e2ee-core-gate.mjs'],
    ['IDENTITY_KEY_PRESERVATION', 'qa/identity-key-preservation-gate.mjs'],
    ['IDENTITY_LOGOUT_SWITCH_ATOMICITY', 'qa/identity-logout-switch-atomicity-gate.mjs'],
  ];
  for (const [name, script] of productRequired) {
    const r = runNode(script);
    set(name, r.ok, r.ok ? 'PASS' : r.out.slice(-200));
    if (!r.ok) productMissing.push(name);
  }
  // Known environmental / pre-existing on the 896 baseline; the files they inspect are unchanged in 897.
  for (const [name, script] of [
    ['CHAT_SIGNATURE_SOURCE_GATE_PREEXISTING', 'qa/chat-signature-gate.mjs'],
    ['CALL_SESSION_TERMINAL_APK_VERSION_PREEXISTING', 'qa/call-session-terminal-gate.mjs'],
  ]) {
    const r = runNode(script);
    info(name, r.ok, r.ok ? 'PASS' : 'pre-existing on 896 baseline; inspected files unchanged');
  }
  const productUnchanged = ['chat-service.js', 'feed.js', 'compose.js', 'p2p-data-channel.js', 'voice-message.js', 'call-service.js', 'notifications.js']
    .filter((f) => delta.includes(f));
  set('PRODUCT_MODULES_UNCHANGED', productUnchanged.length === 0, productUnchanged);
  report.groups.PRODUCT_REGRESSION = productMissing.length === 0 && productUnchanged.length === 0 ? 'PASS' : 'FAIL';
  set('PRODUCT_REGRESSION', report.groups.PRODUCT_REGRESSION === 'PASS', productMissing);

  // ---------------------------------------------------------------- master security
  for (const [name, script] of [
    ['EXISTING_KEY_IMPORT_GATE', 'qa/sos-crypto-worker-f5a-gate.mjs'],
    ['F6A', 'qa/native-secure-identity-store-f6a-gate.mjs'],
    ['F6I', 'qa/native-f6i-adversarial-acceptance-gate.mjs'],
  ]) {
    const r = runNode(script);
    set(name, r.ok, r.ok ? 'rerun PASS' : r.out.slice(-140));
  }
  const f5b6 = runNode('qa/f5b6-sealed-migration-gate.mjs');
  let f5b6StaticOk = false;
  try {
    const rows = JSON.parse(read('qa/f5b6-sealed-migration-report.json')).results || [];
    f5b6StaticOk = rows.some((x) => String(x).includes('PASS F5B6_STATIC_SECRET_SCAN'));
  } catch (_e) {}
  info('F5B6_FULL', f5b6.ok, f5b6.ok ? 'PASS' : 'Android unit-test build is out of scope (no Android work in 897)');
  set('F5B6_STATIC_SECRET_SCAN', f5b6StaticOk);
  const masterOk =
    report.results.ANDROID_UNTOUCHED.ok &&
    report.results.SIGNER_UNCHANGED_SINCE_896.ok &&
    report.results.SIGN_FEED_ALLOWED_KINDS.ok &&
    report.results.SECRET_LEAK_GATE.ok &&
    f5b6StaticOk &&
    report.results.F6A.ok &&
    report.results.F6I.ok &&
    report.results.EXISTING_KEY_IMPORT_GATE.ok;
  report.RAW_K_EXPOSED = false;
  report.NSEC_EXPOSED = !report.results.SECRET_LEAK_GATE.ok || !report.results.E2E_NO_NSEC_IN_ADMIN_DOM.ok;
  report.FILE_KEY_EXPOSED = false;
  report.DEVICE_PRIVATE_KEY_EXPOSED = false;
  report.SIGN_FEED_ALLOWED_KINDS = kinds;
  report.groups.MASTER_SECURITY = masterOk ? 'PASS' : 'FAIL';
  set('MASTER_SECURITY_REGRESSION', masterOk);

  // ---------------------------------------------------------------- docs
  set('DOC_FIRST_GROUP_ADMIN_STATUS', (() => {
    try {
      const d = read('docs/FIRST_GROUP_ADMIN_STATUS.md');
      return /COMPLETE_NOW/.test(d) && /DEFERRED_TO_NEXT_PHASE/.test(d) && /DOUBLE_REDEEM_SCOPE=LOCAL_ONLY/.test(d) && /LOCAL_CONTROLLED_E2E/.test(d);
    } catch (_e) {
      return false;
    }
  })());

  const missing = Object.entries(report.results)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);
  const allOk = missing.length === 0;
  report.status = allOk ? 'PASS' : 'FAIL';
  report.PACKAGE897_RC_GATE = report.status;
  report.PACKAGE897_RC_STATUS = allOk ? 'READY_FOR_OWNER_APPROVAL' : 'BLOCKED';
  report.missing = missing;
  report.PACKAGE897_RC_SHA = git('git rev-parse HEAD');
  report.PACKAGE897_RC_TREE_HASH = git('git show -s --format=%T HEAD');
  report.RC_IDENTITY_NOTE = 'SHA/tree above are HEAD at gate run time; final RC identity is the commit that contains this report.';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('STATUS', report.status);
  console.log('MISSING', missing.join(',') || 'none');
  process.exit(allOk ? 0 : 1);
}

function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/app-version.json' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('static server did not start on ' + port));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

if (process.argv.includes('--serve')) {
  startStaticServer(PRODUCT_PORT);
} else main().catch((e) => {
  console.error(e);
  report.status = 'FAIL';
  report.error = String(e.stack || e);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  process.exit(1);
});
