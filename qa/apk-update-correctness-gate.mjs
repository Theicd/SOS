#!/usr/bin/env node
/**
 * PRE-CUTOVER HOTFIX: APK update correctness
 * - Unpublished / QA releases must not toast
 * - Never fall back to PUBLIC STABLE URL for a newer advertised release
 * - version/file/url must agree
 *
 * Run: node qa/apk-update-correctness-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── Static: production apk-version.json must advertise sole latest published APK ──
const apkMeta = JSON.parse(read('apk-version.json'));
record('apk-version has published field', Object.prototype.hasOwnProperty.call(apkMeta, 'published'));
record('apk-version published === true', apkMeta.published === true);
record('apk-version url points to 1.0.114', String(apkMeta.url || '').includes('apk-1.0.114/SOS-1.0.114.apk'));
record('apk-version advertises 1.0.114 / 115', apkMeta.version === '1.0.114' && Number(apkMeta.versionCode) === 115);

const installerSrc = read('pwa-installer.js');
record('validateApkUpdateRelease present', /function validateApkUpdateRelease/.test(installerSrc));
record('isApkReleasePublished present', /function isApkReleasePublished/.test(installerSrc));
record('update click never falls back to NATIVE_APK_URL',
  /Exact remote release URL only/.test(installerSrc)
  && !/pendingApkRelease\?\.url\s*\|\|\s*NATIVE_APK_URL/.test(installerSrc));
record('APK_UPDATE_METADATA_INVALID logged on bad metadata',
  /APK_UPDATE_METADATA_INVALID/.test(installerSrc));
record('checkApkReleaseVersion uses validateApkUpdateRelease',
  /const validated = validateApkUpdateRelease\(data\)/.test(installerSrc));
record('PUBLIC STABLE remains 1.0.114 for initial install',
  /const NATIVE_APK_VERSION = '1\.0\.114'/.test(installerSrc));
record('apk-version published with matching 1.0.114 URL',
  apkMeta.published === true
  && String(apkMeta.url).includes('apk-1.0.114')
  && String(apkMeta.file) === 'SOS-1.0.114.apk');

const bridgeSrc = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
record('Native getShellVersion = BuildConfig.VERSION_NAME',
  /fun getShellVersion\(\):\s*String\s*=\s*BuildConfig\.VERSION_NAME/.test(bridgeSrc));
record('Native getShellVersionCode = BuildConfig.VERSION_CODE',
  /fun getShellVersionCode\(\):\s*Int\s*=\s*BuildConfig\.VERSION_CODE/.test(bridgeSrc));

const gradle = read('android-shell/app/build.gradle.kts');
record('BuildConfig versionName 1.0.114', /versionName\s*=\s*"1\.0\.114"/.test(gradle));
record('BuildConfig versionCode 115', /versionCode\s*=\s*115/.test(gradle));

record('callSignalGiftWrapRequired true (RC)',
  JSON.parse(read('app-version.json')).callSignalGiftWrapRequired === true);

// ── Runtime: load validateApkUpdateRelease in VM ──
function loadInstaller() {
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
    },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 13) SOSNativeShell/1.0.113' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
    setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    fetch: async () => ({ ok: false }),
    location: { href: 'https://sos010.com/videos.html', protocol: 'https:' },
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.window.NostrApp = {};
  sandbox.window.SosNativeShell = {
    getShellVersion: () => '1.0.113',
    getShellVersionCode: () => 114,
  };
  vm.createContext(sandbox);
  vm.runInContext(installerSrc, sandbox, { filename: 'pwa-installer.js' });
  return sandbox.window.NostrApp;
}

const App = loadInstaller();
const validate = App.validateApkUpdateRelease;
record('validateApkUpdateRelease exported', typeof validate === 'function');

const STABLE_URL = 'https://github.com/Theicd/SOS/releases/download/apk-1.0.113/SOS-1.0.113.apk';
const V115_URL = 'https://github.com/Theicd/SOS/releases/download/apk-1.0.115/SOS-1.0.115.apk';

function decideUpdate(localVersion, localCode, remote) {
  const validated = validate(remote);
  if (!validated.ok) {
    return { toast: false, download: false, reason: validated.reason, url: null };
  }
  const release = validated.release;
  let needsUpdate = false;
  if (release.versionCode > 0 && localCode > 0) {
    needsUpdate = release.versionCode > localCode;
  } else if (release.version && localVersion) {
    const cmp = String(release.version).localeCompare(String(localVersion), undefined, { numeric: true });
    needsUpdate = cmp > 0;
  }
  if (!needsUpdate) {
    return { toast: false, download: false, reason: 'local-current', url: null };
  }
  return { toast: true, download: true, reason: 'ok', url: release.url, version: release.version };
}

// CASE A: unpublished QA with empty URL → toast ZERO
{
  const r = decideUpdate('1.0.113', 114, {
    version: '1.0.114',
    versionCode: 115,
    file: 'SOS-1.0.114.apk',
    url: '',
    published: false,
    channel: 'qa',
  });
  record('CASE A unpublished → toast ZERO', r.toast === false && r.download === false);
  record('CASE A reason unpublished', r.reason === 'unpublished');
}

// CASE B: published=true but url empty → metadata invalid, no toast/download
{
  const r = decideUpdate('1.0.113', 114, {
    version: '1.0.114',
    versionCode: 115,
    file: 'SOS-1.0.114.apk',
    url: '',
    published: true,
  });
  record('CASE B published+empty url → ZERO', r.toast === false && r.download === false);
  record('CASE B reason missing-url-or-file', r.reason === 'missing-url-or-file');
}

// CASE C: advertises 1.0.114 but URL points to 1.0.113 → BLOCK
{
  const r = decideUpdate('1.0.113', 114, {
    version: '1.0.114',
    versionCode: 115,
    file: 'SOS-1.0.114.apk',
    url: STABLE_URL,
    published: true,
  });
  record('CASE C wrong URL version → BLOCK', r.toast === false && r.download === false);
  record('CASE C mismatch reason',
    r.reason === 'url-version-mismatch' || r.reason === 'stable-fallback-blocked');
}

// file/version mismatch
{
  const r = decideUpdate('1.0.113', 114, {
    version: '1.0.114',
    versionCode: 115,
    file: 'SOS-1.0.113.apk',
    url: 'https://github.com/Theicd/SOS/releases/download/apk-1.0.114/SOS-1.0.113.apk',
    published: true,
  });
  record('file vs version mismatch → BLOCK', r.toast === false && r.reason === 'file-version-mismatch');
}

// CASE D: local already at remote → toast ZERO
{
  const r = decideUpdate('1.0.114', 115, {
    version: '1.0.114',
    versionCode: 115,
    file: 'SOS-1.0.114.apk',
    url: 'https://github.com/Theicd/SOS/releases/download/apk-1.0.114/SOS-1.0.114.apk',
    published: true,
  });
  record('CASE D localCode >= remoteCode → toast ZERO', r.toast === false && r.download === false);
}

// CASE E: newer published with exact URL — no stable fallback
{
  const r = decideUpdate('1.0.114', 115, {
    version: '1.0.115',
    versionCode: 116,
    file: 'SOS-1.0.115.apk',
    url: V115_URL,
    published: true,
  });
  record('CASE E toast offers update', r.toast === true && r.download === true);
  record('CASE E exact 1.0.115 URL used', r.url === V115_URL);
  record('CASE E no stable fallback', r.url !== STABLE_URL && !String(r.url || '').includes('1.0.113'));
}

console.log(results.join('\n'));
console.log(`\nAPK_UPDATE_CORRECTNESS_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
