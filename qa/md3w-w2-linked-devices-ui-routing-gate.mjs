#!/usr/bin/env node
/**
 * Product UI routing: Mobile Primary opens scanner; Desktop Destination shows QR.
 * Tests classifyLinkedDevicesSurface + wiring strings — not optical hardware.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const runId = randomUUID();
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '[ui] PASS' : '[ui] FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sha16(rel) {
  return createHash('sha256').update(read(rel)).digest('hex').slice(0, 16).toUpperCase();
}

const ld = read('sos-web-linked-devices.js');
const md2 = read('sos-md2-pairing-qr.js');
const scanner = read('sos-web-linked-qr-scanner.js');

check('CLASSIFY_HELPER', /function classifyLinkedDevicesSurface/.test(ld));
check('PRIMARY_ACTION_HELPER', /function openLinkedDevicesPrimaryAction/.test(ld));
check('MOBILE_ACTION_HELPER', /function openMobilePrimaryLinkAction/.test(ld));
check('ROLE_CHOOSER', /sosLdRoleChooser|openRoleChooserPanel/.test(ld));
check('WIREUI_USES_PRIMARY', /openLinkedDevicesPrimaryAction\(\)/.test(ld) && /topBarMd2Pairing/.test(ld));
check('SINGLE_EVENT_OWNER_CLAIM', /function claimPrimaryLinkControl/.test(ld) && /cloneNode\(true\)/.test(ld));
check('NO_WIREUI_ALWAYS_DESKTOP_QR', !/topBarMd2Pairing[\s\S]{0,200}openDesktopPairingPanel\(\)/.test(ld));
check('MD2_NO_PRODUCT_MENU', /MD2_PRODUCT_MENU_DISABLED|PRODUCT_UI_OWNER:\s*'WebLinkedDevices'/.test(md2));
check('MD2_NO_SYNTHETIC_FALLBACK', !/openPairingQrPanel\(\s*\{/.test(md2) && /SYNTHETIC_QR_FALLBACK:\s*false/.test(md2));
check('MD2_LEGACY_MODAL_DISABLED', /LEGACY_MD2_PRODUCT_UI_DISABLED/.test(md2) && !/קישור מכשיר \(MD2\)/.test(md2));
check('MD2_NO_AUTO_MENU', !/DOMContentLoaded',\s*ensureMenuEntry/.test(md2) && !/ensureMenuEntry\(\);\s*\n\}\)\(window\)/.test(md2));
check('NO_RAW_SOSPAIR1_TEXTAREA', !/sosLinkedPairText/.test(ld) && !/sosMd2QrText/.test(md2));
check('NO_AMET_TEXT_BUTTON', !/אמת טקסט/.test(md2) && !/אמת טקסט/.test(ld));
check('SCANNER_MODULE_PRESENT', /startLinkedDeviceQrScan/.test(scanner));
check('DECODE_NOT_AUTH', /DECODE_IS_NOT_AUTHORIZATION:\s*true/.test(ld));
check('MOBILE_LABEL', /סריקת QR לקישור מחשב/.test(ld));
check('DESKTOP_LABEL', /קישור מחשב באמצעות הטלפון/.test(ld));
check('NATIVE_SHELL_OPENS_SETTINGS', /openLinkedDevicesSettings/.test(ld) && /NATIVE_SHELL|ANDROID_NATIVE_LINKED_DEVICES/.test(ld));
const videos = read('videos.html');
check(
  'VIDEOS_CACHE_BUST_899S9',
  /sos-web-linked-devices\.js\?[^"']*pkg=899s9/.test(videos) &&
    /sos-md2-pairing-qr\.js\?[^"']*pkg=899s9/.test(videos) &&
    /sos-web-linked-qr-scanner\.js\?[^"']*pkg=899s9/.test(videos),
);
check('VIDEOS_NO_STALE_LEGACY_MD2_ONLY', !/sos-md2-pairing-qr\.js\?v=20260926web1/.test(videos));

// Runtime classification with jsdom-like stubs via vm
import vm from 'vm';
const sandbox = {
  window: {
    matchMedia(q) {
      const queries = sandbox.__mq || {};
      return { matches: !!queries[q], addEventListener() {}, addListener() {} };
    },
    SosNativeShell: null,
    NostrApp: {},
  },
  navigator: { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, userAgentData: { mobile: false, platform: 'Windows' } },
  document: {
    readyState: 'complete',
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
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
        getAttribute() { return null; },
        appendChild() {},
        cloneNode() {
          return sandbox.document.createElement('div');
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = 1; return a; } },
  console,
  __mq: {},
};
sandbox.window.navigator = sandbox.navigator;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.crypto = sandbox.crypto;
sandbox.window.NostrApp = sandbox.window.NostrApp;
vm.createContext(sandbox);
vm.runInContext(ld, sandbox);
const API = sandbox.window.SosWebLinkedDevices || sandbox.window.NostrApp.WebLinkedDevices;
check('API_EXPORTED', !!(API && typeof API.classifyLinkedDevicesSurface === 'function'));

function setMq(map) {
  sandbox.__mq = map;
}

if (API && typeof API.classifyLinkedDevicesSurface === 'function') {
  setMq({
    '(pointer: fine)': true,
    '(pointer: coarse)': false,
    '(hover: hover)': true,
    '(max-width: 900px)': false,
  });
  sandbox.navigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';
  sandbox.navigator.maxTouchPoints = 0;
  sandbox.navigator.userAgentData = { mobile: false, platform: 'Windows' };
  sandbox.window.SosNativeShell = null;
  let c = API.classifyLinkedDevicesSurface();
  check('DESKTOP_CLASS', c.role === 'DESKTOP_DESTINATION', c.reason);

  setMq({
    '(pointer: fine)': false,
    '(pointer: coarse)': true,
    '(hover: hover)': false,
    '(max-width: 900px)': true,
  });
  sandbox.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 11; M2101K6G) AppleWebKit/537.36 Mobile Safari/537.36';
  sandbox.navigator.maxTouchPoints = 5;
  sandbox.navigator.userAgentData = { mobile: true, platform: 'Android' };
  c = API.classifyLinkedDevicesSurface();
  check('MOBILE_CLASS', c.role === 'MOBILE_PRIMARY', c.reason);

  sandbox.window.SosNativeShell = { isNativeShell: () => true, openLinkedDevicesSettings: () => '{}' };
  c = API.classifyLinkedDevicesSurface();
  check('NATIVE_CLASS', c.role === 'MOBILE_PRIMARY' && c.reason === 'NATIVE_SHELL', c.reason);

  sandbox.window.SosNativeShell = null;
  setMq({
    '(pointer: fine)': true,
    '(pointer: coarse)': true,
    '(hover: hover)': true,
    '(max-width: 900px)': false,
  });
  sandbox.navigator.userAgent = 'Mozilla/5.0 (iPad; CPU OS 16) AppleWebKit/605';
  sandbox.navigator.maxTouchPoints = 5;
  sandbox.navigator.userAgentData = { mobile: false, platform: 'iPad' };
  c = API.classifyLinkedDevicesSurface();
  check('AMBIGUOUS_TABLET', c.role === 'AMBIGUOUS', c.reason);

  let openedScan = false;
  sandbox.window.SosWebLinkedQrScanner = {
    startLinkedDeviceQrScan: async () => {
      openedScan = true;
      return { ok: false, code: 'USER_CANCELLED', DECODE_IS_NOT_AUTHORIZATION: true };
    },
  };
  sandbox.window.NostrApp.WebLinkedQrScanner = sandbox.window.SosWebLinkedQrScanner;

  const deskCls = API.classifyLinkedDevicesSurface({ forceRole: 'DESKTOP_DESTINATION' });
  check('FORCE_DESKTOP_CLASS', deskCls.role === 'DESKTOP_DESTINATION');
  check(
    'FORCE_DESKTOP_PATH_WIRED',
    /forceRole === 'DESKTOP_DESTINATION'[\s\S]*openDesktopPairingPanel/.test(ld) ||
      /role === 'DESKTOP_DESTINATION'[\s\S]{0,120}openDesktopPairingPanel/.test(ld),
  );

  sandbox.window.SosNativeShell = null;
  const mobCls = API.classifyLinkedDevicesSurface({ forceRole: 'MOBILE_PRIMARY' });
  check('FORCE_MOBILE_CLASS', mobCls.role === 'MOBILE_PRIMARY');
  await Promise.resolve(API.openMobilePrimaryLinkAction());
  check('FORCE_MOBILE_OPENS_SCANNER', openedScan === true);

  setMq({
    '(pointer: fine)': true,
    '(pointer: coarse)': true,
    '(hover: hover)': true,
    '(max-width: 900px)': false,
  });
  sandbox.navigator.userAgent = 'Mozilla/5.0 (iPad; CPU OS 16) AppleWebKit/605';
  sandbox.navigator.maxTouchPoints = 5;
  sandbox.navigator.userAgentData = { mobile: false, platform: 'iPad' };
  const ambCls = API.classifyLinkedDevicesSurface();
  check('AMBIGUOUS_STILL', ambCls.role === 'AMBIGUOUS');
  check('PRIMARY_ACTION_EXPORT', typeof API.openLinkedDevicesPrimaryAction === 'function');
  check('CHOOSER_WIRED_IN_PRIMARY', /openRoleChooserPanel\(\)/.test(ld));
}

const failed = checks.filter((c) => !c.ok);
const report = {
  status: failed.length ? 'FAIL' : 'PASS',
  runId,
  moduleSha16: {
    linkedDevices: sha16('sos-web-linked-devices.js'),
    md2Qr: sha16('sos-md2-pairing-qr.js'),
    scanner: sha16('sos-web-linked-qr-scanner.js'),
  },
  checks,
  failed: failed.map((f) => f.name),
};
fs.writeFileSync(path.join(ROOT, 'qa/md3w-w2-linked-devices-ui-routing-report.json'), JSON.stringify(report, null, 2));
console.log(`STATUS=${report.status} runId=${runId}`);
process.exit(failed.length ? 1 : 0);
