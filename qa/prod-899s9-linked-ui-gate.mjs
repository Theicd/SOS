#!/usr/bin/env node
/** Production-scoped Linked Devices UI release gate (no W1B modules required). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import vm from 'vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '[prod899s9] PASS' : '[prod899s9] FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function sha16(rel) {
  return createHash('sha256').update(read(rel)).digest('hex').slice(0, 16).toUpperCase();
}

const videos = read('videos.html');
const md2 = read('sos-md2-pairing-qr.js');
const ld = read('sos-web-linked-devices.js');
const scanner = read('sos-web-linked-qr-scanner.js');
const av = JSON.parse(read('app-version.json'));
const sw = read('service-worker.js');
const swr = read('sw-register.js');

check('VERSION_899S9', av.version === '2026.10.11-web-899s.9', av.version);
check('SW_CACHE_899S9', /CACHE_NAME\s*=\s*'sos-cache-v899s9'/.test(sw));
check('SW_REGISTER_899S9', /service-worker\.js\?pkg=899s9/.test(swr));
check('VIDEOS_WIRED', /sos-web-linked-devices\.js\?[^"']*pkg=899s9/.test(videos));
check('VIDEOS_SCANNER', /sos-web-linked-qr-scanner\.js\?[^"']*pkg=899s9/.test(videos));
check('VIDEOS_SESSION', /sos-md2-pairing-session\.js\?[^"']*pkg=899s9/.test(videos));
check('NO_LEGACY_MD2_MODAL', !/קישור מכשיר \(MD2\)/.test(md2));
check('NO_SYNTHETIC', !/openPairingQrPanel\(\s*\{/.test(md2) && /SYNTHETIC_QR_FALLBACK:\s*false/.test(md2));
check('SINGLE_OWNER', /claimPrimaryLinkControl/.test(ld));
check('NO_W1B_SCRIPTS', !/phone-issuer|authorize-linked|ald-w1a/.test(videos));
check('NO_W3_SCRIPTS', !/md4-history-sync|md4-attachment-sync/.test(videos));
check('JSQR_PRESENT', fs.existsSync(path.join(ROOT, 'vendor/jsQR.js')));
check('DECODE_NOT_AUTH', /DECODE_IS_NOT_AUTHORIZATION:\s*true/.test(ld));
check('WEB_MD3_DEFAULT_FALSE', /WEB_MD3_ISSUANCE:\s*false/.test(ld));
check('UPDATE_NOW_LABEL', /עדכן עכשיו/.test(read('pwa-installer.js')));
check('UPDATE_SHOWS_VERSION', /גרסה \$\{remoteLabel\}|גרסה \$\{/.test(read('pwa-installer.js')) || /remoteLabel/.test(read('pwa-installer.js')));

// Runtime mobile opens scanner
const sandbox = {
  window: {
    matchMedia() {
      return { matches: false, addEventListener() {}, addListener() {} };
    },
    NostrApp: {},
    alert() {},
  },
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 11) Mobile', maxTouchPoints: 5, userAgentData: { mobile: true } },
  document: {
    readyState: 'complete',
    addEventListener() {},
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    createElement() {
      return {
        style: {},
        innerHTML: '',
        className: '',
        hidden: false,
        id: '',
        textContent: '',
        onclick: null,
        addEventListener() {},
        setAttribute() {},
        getAttribute() {
          return null;
        },
        appendChild() {},
        cloneNode() {
          return sandbox.document.createElement('div');
        },
        querySelector() {
          return null;
        },
      };
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  crypto: {
    getRandomValues(a) {
      for (let i = 0; i < a.length; i++) a[i] = 1;
      return a;
    },
  },
  console,
};
sandbox.window.navigator = sandbox.navigator;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.crypto = sandbox.crypto;
vm.createContext(sandbox);
vm.runInContext(ld, sandbox);
const API = sandbox.window.SosWebLinkedDevices || sandbox.window.NostrApp.WebLinkedDevices;
check('API', !!(API && API.openLinkedDevicesPrimaryAction));
let opened = false;
sandbox.window.SosWebLinkedQrScanner = {
  startLinkedDeviceQrScan: async () => {
    opened = true;
    return { ok: false, code: 'USER_CANCELLED', DECODE_IS_NOT_AUTHORIZATION: true };
  },
};
sandbox.window.NostrApp.WebLinkedQrScanner = sandbox.window.SosWebLinkedQrScanner;
await Promise.resolve(API.openMobilePrimaryLinkAction());
check('MOBILE_OPENS_SCANNER', opened === true);

const failed = checks.filter((c) => !c.ok);
const report = {
  status: failed.length ? 'FAIL' : 'PASS',
  runId,
  version: av.version,
  moduleSha16: {
    linkedDevices: sha16('sos-web-linked-devices.js'),
    md2Qr: sha16('sos-md2-pairing-qr.js'),
    scanner: sha16('sos-web-linked-qr-scanner.js'),
    session: sha16('sos-md2-pairing-session.js'),
  },
  checks,
  failed: failed.map((f) => f.name),
};
fs.writeFileSync(path.join(ROOT, 'qa/prod-899s9-linked-ui-report.json'), JSON.stringify(report, null, 2));
console.log(`STATUS=${report.status} runId=${runId}`);
process.exit(failed.length ? 1 : 0);
