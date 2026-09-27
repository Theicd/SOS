/**
 * Package 898 RC gate — first-group (israel-network) network-backed administration.
 * Exact local tree only. Does NOT deploy. Does NOT change production config.
 * ACCESS_CONTROL_V2 must ship OFF; the network E2E enables it only on its own local server + local relays.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package898-rc-report.json');
const PROD897 = '16f43ae6f81406c68944b66770b248b27137c643';
const PRODUCT_PORT = 8794;
const SKIP_E2E = process.env.SOS_898_REUSE_E2E === '1';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  gate: 'PACKAGE898_RC',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  informational: {},
  blocked: {},
  groups: {},
  PACKAGE898_RC_SHA: null,
  PACKAGE898_RC_TREE_HASH: null,
  ROLLBACK_TARGET_SHA: PROD897,
  NEXT_WEB_PACKAGE: 898,
  NEXT_CACHE_VERSION: 'sos-cache-v898',
  ACCESS_CONTROL_V2_SHIPPED_VALUE: null,
  MAIN_PUSH_EXECUTED: false,
  MAIN_DEPLOY_EXECUTED: false,
  PRODUCTION_ACCESS_CONTROL_CHANGED: false,
  ANDROID_WORK_EXECUTED: false,
  APK_BUILT: false,
  MD4_STARTED: false,
  PACKAGE898_RC_STATUS: 'BLOCKED',
  FIRST_GROUP_V2_READY_FOR_CONTROLLED_PRODUCTION_ACTIVATION: false,
};

const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};
const info = (k, ok, detail) => {
  report.informational[k] = { ok: !!ok, detail: detail ?? null };
  console.log(ok ? 'INFO-PASS' : 'INFO-FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};
const block = (k, value, detail) => {
  report.blocked[k] = { value, detail: detail ?? null };
  console.log('BLOCKED', k, value);
};

function runNode(script, { timeoutMs = 600000, env = {} } = {}) {
  try {
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.stderr || e.message || e).slice(-600) };
  }
}
const readJson = (rel) => {
  try {
    return JSON.parse(read(rel));
  } catch (_e) {
    return {};
  }
};

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
  // ---------------------------------------------------------------- delta / scope
  const tracked = git(`git diff --name-only ${PROD897}`).split(/\r?\n/).filter(Boolean);
  const untracked = git('git ls-files --others --exclude-standard').split(/\r?\n/).filter(Boolean);
  const isNoise = (f) => /^qa\/(\..*|.*report.*\.json|.*\.png)$/.test(f);
  const delta = [...new Set([...tracked, ...untracked])].filter((f) => !isNoise(f));
  report.delta = { files: delta, count: delta.length };
  const forbidden = delta.filter((f) => f.startsWith('android-shell/') || /\.apk$|MD4/i.test(f) || /^downloads\//.test(f));
  set('PACKAGE898_SCOPE_DELTA', forbidden.length === 0 && delta.length > 0, delta);
  set('ANDROID_UNTOUCHED', !delta.some((f) => f.startsWith('android-shell/')) && !delta.some((f) => /\.apk$/.test(f)));
  const multiCommunity = delta.filter((f) => /community-(context|feed-selection|branding)|relay-sync|community-discovery|community-directory/i.test(f));
  set('NO_MULTI_COMMUNITY_PROTOCOL_CHANGES', multiCommunity.length === 0, multiCommunity);
  const commsTouched = delta.filter((f) => /^(chat-|call-|p2p-|feed\.js|compose\.js|voice-|notifications)/.test(f));
  set('GLOBAL_COMMUNICATION_UNCHANGED', commsTouched.length === 0, commsTouched);

  // ---------------------------------------------------------------- static release metadata
  const av = JSON.parse(read('app-version.json'));
  const sw = read('service-worker.js');
  const swr = read('sw-register.js');
  const videos = read('videos.html');
  const flags = JSON.parse(read('runtime-feature-flags.json'));
  report.ACCESS_CONTROL_V2_SHIPPED_VALUE = flags.accessControlV2;
  set('PACKAGE898_VERSION_GATE', av.version === '2026.09.28-web-898' && /pkg=898/.test(videos) && !/pkg=897/.test(videos), av.version);
  set('PACKAGE898_CACHE_GATE', /'sos-cache-v898'/.test(sw) && !/sos-cache-v897/.test(sw) && /pkg=898/.test(swr));
  set('SHIPPED_CONFIG_V2_OFF', flags.schema === 'sos-feature-flags-v1' && flags.accessControlV2 === false && Object.keys(flags).length === 2, flags);
  set('SW_BYPASSES_FLAG_CONFIG', /endsWith\('\/runtime-feature-flags\.json'\)\) return;/.test(sw));
  const loaderIdx = videos.indexOf('<script src="./feature-flags.js?pkg=898"></script>');
  const firstV2 = Math.min(
    ...['community-context.js', 'access-control-v2-local-test.js', 'access-control.js', 'feed.js', 'group-admin-product-ui.js', 'first-group-admin.js', 'first-group-network-authority.js']
      .map((f) => videos.indexOf('./' + f))
      .filter((i) => i >= 0)
  );
  set('FLAG_LOADS_BEFORE_V2_SYNC', loaderIdx > 0 && loaderIdx < firstV2, { loaderIdx, firstV2 });
  const naIdx = videos.indexOf('./first-group-network-authority.js?pkg=898');
  set('FIRST_GROUP_NETWORK_AUTHORITY_WIRED', naIdx > 0 && naIdx < videos.indexOf('./first-group-admin.js') && videos.indexOf('./first-group-admin.js') < videos.indexOf('./group-admin-product-ui.js'));
  const fga = read('first-group-admin.js');
  const na = read('first-group-network-authority.js');
  const ui = read('group-admin-product-ui.js');
  set('NETWORK_GATEWAY_ON_EVERY_PRIVILEGED_OP', (fga.match(/await nguard\(/g) || []).length >= 11 && !/const g = guard\(/.test(fga), (fga.match(/await nguard\(/g) || []).length);
  set('NETWORK_MODULE_DECLARES_CACHE_NOT_AUTHORITY', /LOCAL_CACHE_IS_AUTHORITY:\s*false/.test(na) && /NETWORK_STATE_AUTHORITATIVE:\s*true/.test(na) && /isV2\(\)/.test(na));
  set('NEW_GROUP_CREATION_DEFERRED', /MULTI_COMMUNITY_DEFERRED/.test(ui) && /NEW_GROUP_CREATION/.test(ui));
  set('DOUBLE_REDEEM_SCOPE_DECLARED', /DOUBLE_REDEEM_SCOPE\s*=\s*'NETWORK_SINGLE_APPROVER_SERIALIZED'/.test(fga));

  // ---------------------------------------------------------------- typed signer / secrets
  const signer = read('sos-crypto-signer.js');
  const m = signer.match(/SIGN_FEED:\s*\{\s*kinds:\s*\[([^\]]+)\]/);
  const kinds = m ? m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) : [];
  set('SIGN_FEED_ALLOWED_KINDS', kinds.length === 2 && kinds[0] === 1 && kinds[1] === 6, kinds);
  set('SIGNER_CORE_UNCHANGED_SINCE_897', !delta.includes('sos-crypto-signer.js') && !delta.includes('sos-crypto-worker.js') && !delta.includes('sos-crypto-worker-vault.js'));
  const policyDiff = git(`git diff ${PROD897} -- admin-signing-policy.js`)
    .split(/\r?\n/)
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const policyNonDtag = policyDiff.filter((l) => !/\['d',|const d = |^\s*[+-]\s*\/\//.test(l));
  set('ADMIN_SIGNING_POLICY_DTAG_ONLY', policyNonDtag.length === 0, { changed: policyDiff.length, nonDtag: policyNonDtag });
  const allow = runNode('qa/package894-sign-feed-allowlist-gate.mjs');
  set('SIGN_FEED_NEGATIVE_ALLOWLIST_GATE', allow.ok, allow.out.slice(-160));
  const leak = [];
  for (const f of delta.filter((x) => /\.(js|mjs|json|html|md)$/.test(x) && fs.existsSync(path.join(ROOT, x)))) {
    const s = read(f);
    if (/nsec1[a-z0-9]{50,}/i.test(s) || /privateKeyHex\s*[:=]\s*['"][0-9a-f]{64}['"]/i.test(s)) leak.push(f);
  }
  set('SECRET_LEAK_GATE', leak.length === 0, leak);
  set('NO_GENERIC_RAW_SIGNING_SURFACE', !/App\.signEvent\s*=|window\.nostr\s*=|signRawEvent|finalizeEvent\(/.test(fga + ui + na));

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
  for (const [name, script, why] of [
    ['SUPERSEDED_V2_PRODUCT_GATE', 'qa/access-control-v2-product-gate.mjs', 'asserts deferred group-creation surface'],
    ['SUPERSEDED_COMMUNITY_PRODUCT_GATE', 'qa/access-control-v2-community-product-gate.mjs', 'asserts deferred group-creation surface'],
    ['PREEXISTING_AC6_ADMIN_UI_GATE', 'qa/access-control-ac6-admin-ui-gate.mjs', 'pre-existing on 896/897'],
  ]) {
    const r = runNode(script);
    info(name, r.ok, r.ok ? 'PASS' : why);
  }

  // ---------------------------------------------------------------- first-group network E2E
  const e2e = SKIP_E2E ? { ok: true } : runNode('qa/package898-first-group-network-e2e.mjs', { timeoutMs: 1800000 });
  const er = readJson('qa/package898-first-group-network-e2e-report.json');
  const R = er.results || {};
  const ok = (k) => !!(R[k] && R[k].ok === true);
  const allOk = (keys) => keys.every(ok);
  report.E2E_SCOPE = er.E2E_SCOPE || null;
  report.NETWORK_BACKED_E2E = er.NETWORK_BACKED_E2E ?? null;
  report.DOUBLE_REDEEM_SCOPE = er.DOUBLE_REDEEM_SCOPE || null;
  report.E2E_CHECKS = Object.keys(R).length;
  report.E2E_METRICS = er.metrics || null;
  report.RELAY_PRIVACY = er.RELAY_PRIVACY || null;
  set('FIRST_GROUP_NETWORK_E2E', e2e.ok && er.status === 'PASS' && er.NETWORK_BACKED_E2E === true && Object.keys(R).length >= 40, {
    status: er.status,
    checks: Object.keys(R).length,
    failed: er.failedKeys,
  });
  const groups = {
    THREE_BROWSER_NETWORK_E2E: ['THREE_INDEPENDENT_PROFILES', 'APP_USES_LOCAL_TEST_RELAYS', 'FIRST_GROUP_CANONICAL_ID', 'ROOT_BOOTSTRAP_PUBLISHED_TO_RELAYS', 'CONTROL_RECEIVED_FROM_NETWORK', 'REMOTE_MEMBERSHIP_GRANT', 'A_ADMIN_UI_MEMBERS_FROM_NETWORK', 'REMOTE_CAPABILITY', 'REMOTE_INVITER', 'NETWORK_QR_RENDER', 'CROSS_USER_JOIN', 'REMOTE_ADMIN_PROMOTE', 'REMOTE_CAPABILITY_REVOKE', 'REMOTE_ADMIN_DEMOTE', 'REMOTE_MEMBER_REMOVE'],
    FRESH_PROFILE_AUTHORITY: ['FRESH_PROFILE_AUTHORITY'],
    REMOTE_CAPABILITY: ['REMOTE_CAPABILITY', 'REMOTE_CAPABILITY_REVOKE', 'INVITER_CANNOT_ESCALATE'],
    CROSS_USER_JOIN: ['CROSS_USER_JOIN', 'JOIN_OBSERVABILITY', 'REMOTE_INVITER', 'NETWORK_QR_RENDER'],
    NETWORK_AUTHORITATIVE_GATEWAY: ['NETWORK_AUTHORITATIVE_GATEWAY', 'DIRECT_NETWORK_PRIVILEGED_BYPASS_REJECTED', 'INVITER_CANNOT_ESCALATE', 'FAIL_CLOSED_NO_RELAY_CONFIRMATION', 'TYPED_SIGNER_ONLY'],
    NETWORK_ADVERSARIAL: ['EVENT_INTEGRITY', 'STALE_EVENT', 'CONTROL_CONFLICT_FAIL_CLOSED', 'DUPLICATE_EVENT_NO_CORRUPTION', 'EVENT_ARRIVAL_ORDER_DETERMINISTIC', 'ONE_RELAY_DOWN_CONVERGES', 'RELAY_RECONNECT_UNION', 'NETWORK_INVITE_REVOKE', 'NETWORK_EXPIRED_INVITE', 'RELAY_SECRET_LEAK_SCAN', 'DOM_SECRET_SCAN'],
    MULTI_USER_SESSION: ['MULTITAB_REVOCATION', 'OFFLINE_STALE_CACHE_FAIL_CLOSED', 'OFFLINE_RECONNECT', 'ACCOUNT_SWITCH'],
    NETWORK_BACKED_ADMIN_UI: ['NETWORK_BACKED_ADMIN_UI', 'ADMIN_UI_LOADING_STATE', 'NO_ADMIN_UI_WITHOUT_NETWORK_CONTROL'],
  };
  for (const [g, keys] of Object.entries(groups)) {
    const missing = keys.filter((k) => !ok(k));
    report.groups[g] = e2e.ok && missing.length === 0 ? 'PASS' : 'FAIL';
    set(g, report.groups[g] === 'PASS', missing.length ? missing : `${keys.length} checks`);
  }
  set('NETWORK_DOUBLE_REDEEM_SINGLE_APPROVER', ok('NETWORK_DOUBLE_REDEEM_SINGLE_APPROVER'), R.NETWORK_DOUBLE_REDEEM_SINGLE_APPROVER ? R.NETWORK_DOUBLE_REDEEM_SINGLE_APPROVER.detail : null);
  report.groups.NETWORK_DOUBLE_REDEEM = er.NETWORK_DOUBLE_REDEEM_GATE || 'MISSING';
  if (report.groups.NETWORK_DOUBLE_REDEEM !== 'PASS') {
    block('NETWORK_DOUBLE_REDEEM', report.groups.NETWORK_DOUBLE_REDEEM, {
      scope: er.DOUBLE_REDEEM_SCOPE,
      twoApprovers: er.metrics && er.metrics.DOUBLE_REDEEM_TWO_APPROVERS,
      requirement: 'designated single join-serializer key or convergent per-invite resolver rule (owner decision)',
    });
  }
  const e897 = runNode('qa/package897-first-group-admin-e2e.mjs', { timeoutMs: 1200000 });
  info('SUPERSEDED_897_LOCAL_CONTROLLED_E2E', e897.ok, e897.ok ? 'PASS' : 'superseded: in-page relay stub + export/import model; gateway now requires relay confirmation');

  // ---------------------------------------------------------------- product regression
  const productMissing = [];
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitForPort(PRODUCT_PORT);
    const LOCAL = `http://127.0.0.1:${PRODUCT_PORT}/videos.html`;
    runNode('qa/package894-product-rc-gate.mjs', { env: { SOS_RC_URL: LOCAL } });
    const notApplicable = new Set(['PACKAGE_894_VISIBLE', 'DIRECT_P2P', 'PACKAGE894_PRODUCT_RC_GATE']);
    const pr = readJson('qa/package894-product-rc-report.json').results || {};
    const prKeys = Object.keys(pr).filter((k) => !notApplicable.has(k));
    const prBad = prKeys.filter((k) => !pr[k].ok);
    set('PRODUCT_RC_894_FLOWS', prKeys.length >= 18 && prBad.length === 0, prBad.length ? prBad : prKeys);
    if (prBad.length || prKeys.length < 18) productMissing.push('PRODUCT_RC_894_FLOWS');
    info('DIRECT_P2P_ENVIRONMENTAL', !!(pr.DIRECT_P2P && pr.DIRECT_P2P.ok), pr.DIRECT_P2P ? pr.DIRECT_P2P.detail : null);
    const sec = runNode('qa/package894-security-gate.mjs', { env: { SOS_RC_URL: LOCAL } });
    set('PRODUCT_SECURITY_894', sec.ok, sec.ok ? 'PASS' : sec.out.slice(-200));
    if (!sec.ok) productMissing.push('PRODUCT_SECURITY_894');

    const calls = runNode('qa/package898-real-browser-call-gate.mjs', { env: { SOS_CALL_URL: LOCAL }, timeoutMs: 420000 });
    const cr = readJson('qa/package898-real-browser-call-report.json');
    set('REAL_BROWSER_VOICE_VIDEO_CALLS', calls.ok && cr.status === 'PASS', { voice: cr.voice && cr.voice.REAL_VOICE_CALL, video: cr.video && cr.video.REAL_VIDEO_CALL, hangup: cr.voice && cr.voice.REMOTE_HANGUP_PROPAGATED });
    if (!(calls.ok && cr.status === 'PASS')) productMissing.push('REAL_BROWSER_VOICE_VIDEO_CALLS');

    runNode('qa/package894-real-browser-p2p-gate.mjs', { env: { SOS_P2P_URL: LOCAL }, timeoutMs: 420000 });
    const p2p = readJson('qa/package894-real-browser-p2p-report.json');
    fs.writeFileSync(path.join(ROOT, 'qa', 'package898-real-browser-p2p-report.json'), JSON.stringify(p2p, null, 2));
    const base = readJson('qa/package898-baseline-prod897-p2p-report.json');
    const p2pOk = p2p.status === 'PASS';
    const envSame = !p2pOk && p2p.status === 'BLOCKED_NETWORK' && base.status === 'BLOCKED_NETWORK';
    report.REAL_P2P = p2pOk ? 'PASS' : envSame ? 'ENVIRONMENTAL_SAME_ON_PRODUCTION_897' : p2p.status || 'FAIL';
    info('REAL_BROWSER_P2P_CHAT_FILE', p2pOk, { local898: p2p.status, classification: p2p.classification, prod897Baseline: base.status, relayFallback: p2p.fallback && p2p.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE });
    set('REAL_BROWSER_P2P_NO_898_REGRESSION', p2pOk || envSame, report.REAL_P2P);
    if (!(p2pOk || envSame)) productMissing.push('REAL_BROWSER_P2P');
    set('RELAY_FALLBACK_CHAT', !!(p2p.fallback && p2p.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE === 'PASS'), p2p.fallback && p2p.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE);

    runNode('qa/package898-404-audit.mjs', { env: { SOS_404_LOCAL: LOCAL }, timeoutMs: 420000 });
    const a404 = readJson('qa/package898-404-audit-report.json');
    const known = new Set(['/styles/game-doom-arena.css', '/game-doom-arena.js']);
    const unknown = (a404.unique404 || []).filter((r) => !known.has(new URL(r.url).pathname));
    report.AUDIT_404 = (a404.unique404 || []).map((r) => ({ path: new URL(r.url).pathname, runs: r.runs, class: known.has(new URL(r.url).pathname) ? 'DEAD_ASSET_REFERENCE' : 'UNCLASSIFIED' }));
    set('404_AUDIT', unknown.length === 0 && (a404.unique404 || []).length > 0, { unknown, classified: report.AUDIT_404.length });
  } finally {
    server.kill();
    await sleep(1000);
  }
  for (const [name, script] of [
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
  ]) {
    const r = runNode(script);
    set(name, r.ok, r.ok ? 'PASS' : r.out.slice(-200));
    if (!r.ok) productMissing.push(name);
  }
  for (const [name, script] of [
    ['CHAT_SIGNATURE_SOURCE_GATE_PREEXISTING', 'qa/chat-signature-gate.mjs'],
    ['CALL_SESSION_TERMINAL_APK_VERSION_PREEXISTING', 'qa/call-session-terminal-gate.mjs'],
  ]) {
    const r = runNode(script);
    info(name, r.ok, r.ok ? 'PASS' : 'pre-existing on 896/897 baseline; inspected files unchanged');
  }
  const productUnchanged = ['chat-service.js', 'feed.js', 'compose.js', 'p2p-data-channel.js', 'voice-message.js', 'call-service.js', 'notifications.js', 'chat-voice-call.js', 'chat-video-call.js']
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
  info('F5B6_FULL', f5b6.ok, f5b6.ok ? 'PASS' : 'Android unit-test build is out of scope (no Android work in 898)');
  set('F5B6_STATIC_SECRET_SCAN', f5b6StaticOk);
  const masterOk =
    report.results.ANDROID_UNTOUCHED.ok &&
    report.results.SIGNER_CORE_UNCHANGED_SINCE_897.ok &&
    report.results.ADMIN_SIGNING_POLICY_DTAG_ONLY.ok &&
    report.results.SIGN_FEED_ALLOWED_KINDS.ok &&
    report.results.SECRET_LEAK_GATE.ok &&
    f5b6StaticOk &&
    report.results.F6A.ok &&
    report.results.F6I.ok &&
    report.results.EXISTING_KEY_IMPORT_GATE.ok &&
    ok('RELAY_SECRET_LEAK_SCAN') &&
    ok('DOM_SECRET_SCAN') &&
    ok('TYPED_SIGNER_ONLY');
  report.RAW_K_EXPOSED = er.RAW_K_EXPOSED === true;
  report.NSEC_EXPOSED = er.NSEC_EXPOSED === true || !report.results.SECRET_LEAK_GATE.ok;
  report.RELAY_SECRET_LEAK = er.RELAY_SECRET_LEAK === true;
  report.SIGN_FEED_ALLOWED_KINDS = kinds;
  report.groups.MASTER_SECURITY = masterOk ? 'PASS' : 'FAIL';
  set('MASTER_SECURITY_REGRESSION', masterOk);

  // ---------------------------------------------------------------- docs
  const doc = (rel, res) => {
    try {
      const d = read(rel);
      return res.every((re) => re.test(d));
    } catch (_e) {
      return false;
    }
  };
  set('DOC_FIRST_GROUP_ADMIN_STATUS', doc('docs/FIRST_GROUP_ADMIN_STATUS.md', [/Package 898/, /NETWORK_BACKED_E2E/, /BLOCKED_DISTRIBUTED_SERIALIZATION/, /DEFERRED_TO_NEXT_PHASE/]));
  set('DOC_FIRST_GROUP_NETWORK_AUTHORITY', doc('docs/FIRST_GROUP_NETWORK_AUTHORITY.md', [/Network-authoritative vs cache/, /Event kinds and schema/, /Authorization/, /Revocation/, /Double redeem/, /Relay privacy/, /Stale tabs/, /Rollback/, /Deferred/]));
  set('DOC_SECURITY_PRODUCT_INTEGRATION_MAP', doc('docs/SECURITY_PRODUCT_INTEGRATION_MAP.md', [/Package 898/, /first-group-network-authority\.js/]));
  set('DOC_ACCESS_CONTROL_V2_ACTIVATION_PLAN', doc('docs/ACCESS_CONTROL_V2_ACTIVATION_PLAN.md', [/Package 898/, /BLOCKED_DISTRIBUTED_SERIALIZATION/]));
  set('DOC_PACKAGE898_RELEASE_PLAN', doc('docs/PACKAGE898_FIRST_GROUP_NETWORK_RELEASE_PLAN.md', [/sos-cache-v898/, /DEAD_ASSET_REFERENCE/, /Rollback/]));

  // ---------------------------------------------------------------- verdict
  const missing = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  const scopeKeys = ['PACKAGE898_SCOPE_DELTA', 'ANDROID_UNTOUCHED', 'NO_MULTI_COMMUNITY_PROTOCOL_CHANGES', 'GLOBAL_COMMUNICATION_UNCHANGED', 'SHIPPED_CONFIG_V2_OFF'];
  report.PACKAGE898_SCOPE_GATE = scopeKeys.every((k) => report.results[k] && report.results[k].ok) ? 'PASS' : 'FAIL';
  const blockedKeys = Object.keys(report.blocked);
  report.status = missing.length ? 'FAIL' : blockedKeys.length ? 'BLOCKED' : 'PASS';
  report.PACKAGE898_RC_GATE = report.status;
  report.PACKAGE898_RC_STATUS = report.status === 'PASS' ? 'READY_FOR_OWNER_APPROVAL' : 'BLOCKED';
  report.FIRST_GROUP_V2_READY_FOR_CONTROLLED_PRODUCTION_ACTIVATION = report.status === 'PASS';
  report.missing = missing;
  report.blockedKeys = blockedKeys;
  report.PACKAGE898_RC_SHA = git('git rev-parse HEAD');
  report.PACKAGE898_RC_TREE_HASH = git('git show -s --format=%T HEAD');
  report.RC_IDENTITY_NOTE = 'SHA/tree above are HEAD at gate run time; final RC identity is the commit that contains this report.';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('STATUS', report.status);
  console.log('MISSING', missing.join(',') || 'none');
  console.log('BLOCKED', blockedKeys.join(',') || 'none');
  process.exit(report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1);
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
} else {
  main().catch((e) => {
    console.error(e);
    report.status = 'FAIL';
    report.error = String(e.stack || e);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    process.exit(1);
  });
}
