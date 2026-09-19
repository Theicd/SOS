#!/usr/bin/env node
/**
 * APK update correctness — sole latest published APK on GitHub.
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

const apkMeta = JSON.parse(read('apk-version.json'));
record('apk-version has published field', Object.prototype.hasOwnProperty.call(apkMeta, 'published'));
record('apk-version published === true', apkMeta.published === true);
record('apk-version url points to 1.0.122', String(apkMeta.url || '').includes('downloads/SOS-1.0.122.apk'));
record('apk-version advertises 1.0.122 / 123', apkMeta.version === '1.0.122' && Number(apkMeta.versionCode) === 123);

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
record('PUBLIC STABLE is 1.0.122 for initial install',
  /const NATIVE_APK_VERSION = '1\.0\.122'/.test(installerSrc));
record('apk-version published with matching 1.0.122 URL',
  apkMeta.published === true
  && String(apkMeta.url).includes('downloads/SOS-1.0.122.apk')
  && String(apkMeta.file) === 'SOS-1.0.122.apk');

const bridgeSrc = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
record('Native getShellVersion = BuildConfig.VERSION_NAME',
  /fun getShellVersion\(\):\s*String\s*=\s*BuildConfig\.VERSION_NAME/.test(bridgeSrc));
record('Native getShellVersionCode = BuildConfig.VERSION_CODE',
  /fun getShellVersionCode\(\):\s*Int\s*=\s*BuildConfig\.VERSION_CODE/.test(bridgeSrc));

const gradle = read('android-shell/app/build.gradle.kts');
record('BuildConfig shell versionName 1.0.122', /versionName\s*=\s*"1\.0\.122"/.test(gradle));
record('BuildConfig shell versionCode 123', /versionCode\s*=\s*123/.test(gradle));
record('published apk-version is 1.0.122 / 123',
  JSON.parse(read('apk-version.json')).version === '1.0.122'
  && Number(JSON.parse(read('apk-version.json')).versionCode) === 123);

record('callSignalGiftWrapRequired true',
  JSON.parse(read('app-version.json')).callSignalGiftWrapRequired === true);

function loadInstaller() {
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {}, remove() {} }),
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
    },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 13) SOSNativeShell/1.0.115' },
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
    getShellVersion: () => '1.0.115',
    getShellVersionCode: () => 116,
  };
  vm.createContext(sandbox);
  vm.runInContext(installerSrc, sandbox, { filename: 'pwa-installer.js' });
  return sandbox.window.NostrApp;
}

const App = loadInstaller();
const validate = App.validateApkUpdateRelease;
record('validateApkUpdateRelease exported', typeof validate === 'function');

const OLD_STABLE_URL = 'https://github.com/Theicd/SOS/releases/download/apk-1.0.115/SOS-1.0.115.apk';
const V122_URL = 'https://sos010.com/downloads/SOS-1.0.122.apk';
const V123_URL = 'https://sos010.com/downloads/SOS-1.0.123.apk';

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

{
  const r = decideUpdate('1.0.115', 116, {
    version: '1.0.119',
    versionCode: 120,
    file: 'SOS-1.0.119.apk',
    url: '',
    published: false,
    channel: 'qa',
  });
  record('CASE A unpublished → toast ZERO', r.toast === false && r.download === false);
  record('CASE A reason unpublished', r.reason === 'unpublished');
}

{
  const r = decideUpdate('1.0.115', 116, {
    version: '1.0.119',
    versionCode: 120,
    file: 'SOS-1.0.119.apk',
    url: '',
    published: true,
  });
  record('CASE B published+empty url → ZERO', r.toast === false && r.download === false);
  record('CASE B reason missing-url-or-file', r.reason === 'missing-url-or-file');
}

{
  const r = decideUpdate('1.0.115', 116, {
    version: '1.0.119',
    versionCode: 120,
    file: 'SOS-1.0.119.apk',
    url: OLD_STABLE_URL,
    published: true,
  });
  record('CASE C wrong URL version → BLOCK', r.toast === false && r.download === false);
  record('CASE C mismatch reason',
    r.reason === 'url-version-mismatch' || r.reason === 'stable-fallback-blocked');
}

{
  const r = decideUpdate('1.0.115', 116, {
    version: '1.0.118',
    versionCode: 119,
    file: 'SOS-1.0.115.apk',
    url: 'https://github.com/Theicd/SOS/releases/download/apk-1.0.119/SOS-1.0.115.apk',
    published: true,
  });
  record('file vs version mismatch → BLOCK', r.toast === false && r.reason === 'file-version-mismatch');
}

{
  const r = decideUpdate('1.0.122', 123, {
    version: '1.0.122',
    versionCode: 123,
    file: 'SOS-1.0.122.apk',
    url: V122_URL,
    published: true,
  });
  record('CASE D localCode >= remoteCode → toast ZERO', r.toast === false && r.download === false);
}

{
  const r = decideUpdate('1.0.121', 122, {
    version: '1.0.122',
    versionCode: 123,
    file: 'SOS-1.0.122.apk',
    url: V122_URL,
    published: true,
  });
  record('CASE E toast offers 1.0.122', r.toast === true && r.download === true);
  record('CASE E exact 1.0.122 URL used', r.url === V122_URL);
  record('CASE E no old stable fallback', r.url !== OLD_STABLE_URL && !String(r.url || '').includes('1.0.115'));
}

{
  const r = decideUpdate('1.0.122', 123, {
    version: '1.0.123',
    versionCode: 124,
    file: 'SOS-1.0.123.apk',
    url: V123_URL,
    published: true,
  });
  record('future newer release uses exact URL', r.toast === true && r.url === V123_URL);
}

console.log(results.join('\n'));
console.log(`\nAPK_UPDATE_CORRECTNESS_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
