#!/usr/bin/env node
/**
 * Stage 5E-E2B2B-I2 pre-deploy package gate.
 * Static only. Does not deploy, commit, or delete nostr_private_key.
 * MULTI_TAB_IDENTITY_TRANSITION_SAFE=false — hard blocker before any future plaintext deletion.
 * Run: node qa/identity-i2-predeploy-package-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '881';
const CACHE = 'sos-cache-v881';
const GEN = 'browser-secure-cutover-v1';
const MODULES = [
  'key-storage.js',
  'identity-storage-bootstrap.js',
  'auth-guard.js',
  'config.js',
  'keys.js',
  'app.js',
  'identity-lifecycle.js',
  'account.js',
  'key-viewer.js',
];
const ENTRIES = [
  'index.html',
  'videos.html',
  'storage.html',
  'auth.html',
  'profile.html',
  'profile-viewer.html',
  'dating.html',
  'p2p-standby.html',
  'hexgl-multiplayer.html',
  'nzp-multiplayer.html',
  'doom-multiplayer.html',
];
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const keySrc = read('key-storage.js');
const start = keySrc.indexOf('/* CUTOVER_I1_START */');
const end = keySrc.indexOf('/* CUTOVER_I1_END */');
const region = start >= 0 && end > start ? keySrc.slice(start, end) : '';

record('A_CODE_GENERATION',
  MODULES.every((name) => {
    const src = read(name);
    return src.includes("'" + GEN + "'") && src.includes("['" + name + "']");
  })
  && MODULES.length === 9
  && keySrc.includes('const IDENTITY_PAGE_MODULE_SETS = {')
  && keySrc.includes('UNDECLARED_PAGE')
  && keySrc.includes('function identityEntryPageName()')
  && keySrc.includes('videos-page'));

function parsePageMatrix(src) {
  const start = src.indexOf('const IDENTITY_PAGE_MODULE_SETS = {');
  const end = src.indexOf('};', start);
  const body = start >= 0 && end > start ? src.slice(start, end) : '';
  const pages = {};
  const re = /'([^']+\.html)':\s*\[([\s\S]*?)\]/g;
  let match;
  while ((match = re.exec(body))) {
    pages[match[1]] = [...match[2].matchAll(/'([^']+\.js)'/g)].map((item) => item[1]);
  }
  return pages;
}

function sameSet(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((name) => right.includes(name));
}

function htmlIdentityModules(html) {
  const found = [];
  const re = new RegExp('<script[^>]+src="\\./([^"]+\\.js)\\?pkg=' + PKG + '"', 'g');
  let match;
  while ((match = re.exec(html))) {
    if (MODULES.includes(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

const pageMatrix = parsePageMatrix(keySrc);
const matrixDetail = [];
let matrixOk = ENTRIES.every((page) => Object.prototype.hasOwnProperty.call(pageMatrix, page));
for (const page of ENTRIES) {
  const expected = pageMatrix[page];
  const actual = htmlIdentityModules(read(page));
  if (!sameSet(expected, actual)) {
    matrixOk = false;
    matrixDetail.push(page);
  }
}
const protectedPages = ['index.html', 'profile.html', 'profile-viewer.html'];
record('A2_PAGE_MODULE_MATRIX',
  matrixOk
  && pageMatrix['videos.html']
  && !pageMatrix['videos.html'].includes('auth-guard.js')
  && protectedPages.every((page) => pageMatrix[page] && pageMatrix[page].includes('auth-guard.js'))
  && !pageMatrix['auth.html'].includes('auth-guard.js'),
  matrixDetail.join(','));

record('B_PENDING_TRUE', /const BROWSER_SECURE_CUTOVER_PENDING = true/.test(keySrc));
record('C_DELETE_FALSE', /const BROWSER_SECURE_CUTOVER_DELETE_LEGACY = false/.test(keySrc));
record('D_COMPLETE_UNREACHABLE',
  region.length > 0
  && !/state:\s*'complete'/.test(region)
  && !/state\s*=\s*'complete'/.test(region));
record('E_NO_MIGRATION_DELETE',
  region.length > 0
  && !region.includes('removeItem')
  && /function canDeleteBrowserLegacySecret\(\) \{\s*return false;\s*\}/.test(keySrc));

let orderOk = true;
let guardOk = true;
let versionOk = true;
const orderDetail = [];
for (const page of ENTRIES) {
  const html = read(page);
  const keyAt = html.indexOf('./key-storage.js?pkg=' + PKG);
  const bootAt = html.indexOf('./identity-storage-bootstrap.js?pkg=' + PKG);
  if (!(keyAt >= 0 && bootAt > keyAt)) {
    orderOk = false;
    orderDetail.push(page);
  }
  const guardAt = html.indexOf('./auth-guard.js');
  if (guardAt >= 0 && !(html.indexOf('./identity-storage-bootstrap.js?pkg=' + PKG) >= 0 && guardAt > bootAt)) {
    guardOk = false;
    orderDetail.push(page + ':guard');
  }
  const tags = html.match(/<script[^>]+src="\.\/(?:key-storage|identity-storage-bootstrap|auth-guard|config|keys|app|identity-lifecycle|account|key-viewer)\.js[^"]*"/g) || [];
  if (!tags.length || tags.some((tag) => !tag.includes('?pkg=' + PKG + '"') && !tag.includes("?pkg=" + PKG + ' '))) {
    versionOk = false;
    orderDetail.push(page + ':pkg');
  }
}
record('F_ENTRY_ORDER', orderOk, orderDetail.join(','));
record('G_AUTH_GUARD_AFTER_BOOTSTRAP',
  guardOk && read('auth-guard.js').includes('ready.then(decide)'));

const sw = read('service-worker.js');
const precacheOk = MODULES.every((name) => sw.includes("'./" + name + '?pkg=' + PKG + "'"))
  && ENTRIES.every((name) => sw.includes("'./" + name + "'") || (name === 'index.html' && sw.includes("'./index.html'")));
record('H_SW_IDENTITY_PACKAGE',
  sw.includes("const CACHE_NAME = '" + CACHE + "'")
  && sw.includes('networkFirstThenCache')
  && sw.includes('skipWaiting')
  && sw.includes('clients.claim')
  && precacheOk
  && !sw.includes('nostr_private_key'));
record('I_ONE_PACKAGE_QUERY', versionOk && !/pkg=\d+/.test(sw.replaceAll('pkg=' + PKG, '')));

const canonicalSw = './service-worker.js?pkg=' + PKG;
const swOwner = read('sw-register.js');
const swCallers = ['chat-ui.js', 'chat-voice-call-ui.js', 'chat-video-call-ui.js', 'pwa-installer.js'];
const swPages = ['index.html', 'videos.html', 'storage.html'];
const strayRegisters = [];
function walkRegisters(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'android-shell', 'qa'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRegisters(full);
    else if (ent.name.endsWith('.js') && ent.name !== 'sw-register.js') {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('serviceWorker.register(') || /service-worker\.js\?v=/.test(text)) {
        strayRegisters.push(path.relative(root, full));
      }
    }
  }
}
walkRegisters(root);
const swPagesOk = swPages.every((page) => {
  const html = read(page);
  const ownerAt = html.indexOf('./sw-register.js?pkg=' + PKG);
  const firstCaller = ['chat-voice-call-ui.js', 'chat-video-call-ui.js', 'chat-ui.js', 'pwa-installer.js']
    .map((name) => html.indexOf(name))
    .filter((at) => at >= 0)
    .sort((a, b) => a - b)[0];
  return ownerAt >= 0 && firstCaller > ownerAt;
});
record('Q_SINGLE_SW_REGISTRATION',
  swOwner.includes("const SCRIPT_URL = '" + canonicalSw + "'")
  && swOwner.includes("const SCOPE = './'")
  && swCallers.every((name) => read(name).includes('owner.register()') && !/service-worker\.js\?/.test(read(name)))
  && strayRegisters.length === 0
  && swPagesOk
  && sw.includes("'./sw-register.js?pkg=" + PKG + "'"),
  strayRegisters.join(','));

record('J_OLD_APK_FEATURE_DETECT',
  /function isUncapableNativeShell\(/.test(keySrc)
  && /nativeSecureWebIdentity !== true/.test(keySrc)
  && /isUncapableNativeShell\(\)\) return PROVIDER_LEGACY/.test(keySrc));
record('K_NATIVE_PROVIDER',
  /function nativeBridge\(/.test(keySrc)
  && /function activeProviderName\(/.test(keySrc)
  && keySrc.indexOf('if (nativeBridge()) return PROVIDER_NATIVE_SECURE;') > keySrc.indexOf('function activeProviderName'));
record('L_SESSION_ONLY',
  keySrc.includes('PROVIDER_SESSION_ONLY')
  && /if \(isSessionOnly\(\)\) return PROVIDER_SESSION_ONLY;/.test(keySrc));
record('M_UNSUPPORTED_LEGACY',
  /BROWSER_SECURE_UNAVAILABLE/.test(keySrc)
  && /return PROVIDER_LEGACY;/.test(keySrc));

const appFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'android-shell', 'qa'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(ent.name) && ent.name !== 'key-storage.js') appFiles.push(p);
  }
}
walk(root);
const bypass = appFiles.filter((p) => fs.readFileSync(p, 'utf8').includes('nostr_private_key'));
record('N_DIRECT_BYPASS_0', bypass.length === 0, bypass.map((p) => path.relative(root, p)).join(','));
record('O_MIGRATION_NO_GENERATE', !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(keySrc));
record('LEGACY_MIRROR_STILL_WRITTEN', keySrc.includes('localStorage.setItem(LS, pair.priv)'));
record('MULTI_TAB_DELETE_BLOCKER',
  !/BroadcastChannel/.test(keySrc)
  && /const BROWSER_SECURE_CUTOVER_DELETE_LEGACY = false/.test(keySrc));

let preservationOk = false;
try {
  execFileSync(process.execPath, ['qa/identity-key-preservation-gate.mjs'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  preservationOk = true;
} catch (err) {
  preservationOk = false;
  const out = String((err.stdout || '') + (err.stderr || ''));
  record('P_KEY_PRESERVATION', false, out.split('\n').filter((line) => line.startsWith('FAIL')).join(' | '));
}
if (preservationOk) record('P_KEY_PRESERVATION', true);

const failed = results.filter((row) => !row.ok);
console.log('---');
console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
console.log('MULTI_TAB_IDENTITY_TRANSITION_SAFE=false');
if (failed.length) process.exit(1);
