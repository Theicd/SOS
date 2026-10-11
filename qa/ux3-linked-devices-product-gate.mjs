#!/usr/bin/env node
/**
 * UX3 product gate: Guest QR-first + continue-as-guest + mobile Linked Devices page
 * + chat-request-logger Filter-shape telemetry fix (no flatMap throw).
 */
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
  console.log(`${ok ? '[ux3] PASS' : '[ux3] FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function sha16(rel) {
  return createHash('sha256').update(read(rel)).digest('hex').slice(0, 16).toUpperCase();
}

const ld = read('sos-web-linked-devices.js');
const logger = read('chat-request-logger.js');
const guest = read('guest-auth.js');
const videos = read('videos.html');
const av = JSON.parse(read('app-version.json'));
const sw = read('service-worker.js');
const swr = read('sw-register.js');

check('VERSION_899S10', av.version === '2026.10.11-web-899s.10', av.version);
check('SW_CACHE_899S10', /CACHE_NAME\s*=\s*'sos-cache-v899s10'/.test(sw));
check('SW_REGISTER_899S10', /service-worker\.js\?pkg=899s10/.test(swr));
check('VIDEOS_PKG_899S10', /sos-web-linked-devices\.js\?[^"']*pkg=899s10/.test(videos));
check('LOGGER_CACHE_BUST', /chat-request-logger\.js\?[^"']*pkg=899s10/.test(videos));
check('LOGGER_NORMALIZE_FILTERS', /Array\.isArray\(filters\)[\s\S]{0,120}\[filters\]/.test(logger));
check('LOGGER_TELEMETRY_TRYCATCH', /telemetry must never break subscriptions/.test(logger));
check('LOGGER_ORIG_APPLY', /return orig\.apply\(this, arguments\)/.test(logger));
check('NO_ARRAY_PROTO_POLYFILL', !/Array\.prototype\.flatMap\s*=/.test(logger));
check('GUEST_WELCOME_UI', /sosLdGuestWelcome/.test(ld) && /המשך כאורח/.test(ld));
check('GUEST_TITLE', /חיבור SOS באמצעות הטלפון/.test(ld));
check('CONTINUE_AS_GUEST_FN', /function continueAsGuest/.test(ld));
check('GUEST_SESSION_KEY', /sos_ld_guest_continued_v1/.test(ld));
check('MOBILE_PAGE', /sosLdMobilePage/.test(ld) && /קישור מכשיר/.test(ld));
check('EMPTY_DEVICES', /אין עדיין מכשירים מקושרים/.test(ld));
check('LOCAL_REGISTRY_SCOPE', /LOCAL_BROWSER_REGISTRY/.test(ld));
check('NO_REVOKE_PRODUCT', /DEVICE_REVOKE_PRODUCT_READY:\s*false/.test(ld));
check('QR_ERROR_STATE', /לא ניתן ליצור קוד כרגע/.test(ld) && /נסה שוב/.test(ld));
check('DESKTOP_REOPEN_LABEL', /קישור מחשב לטלפון/.test(ld));
check('AUTH_PROMPT_DEFER', /__sosLdGuestWelcomeActive/.test(guest) && /__sosLdGuestWelcomeActive/.test(ld));
check('NO_W1B', !/phone-issuer|authorize-linked|ald-w1a/.test(videos));
check('NO_W3', !/md4-history-sync|md4-attachment-sync/.test(videos));
check('WEB_MD3_OFF', /WEB_MD3_ISSUANCE:\s*false/.test(ld));
check('DECODE_NOT_AUTH', /DECODE_IS_NOT_AUTHORIZATION:\s*true/.test(ld));
check('NO_FAKE_LINKED', !/FAKE_LINKED|forceLinked|syntheticLinked/i.test(ld));

// --- Runtime: logger must not throw on single Filter object ---
const logSandbox = {
  window: { NostrApp: { pool: null }, addEventListener() {} },
  document: { addEventListener() {}, readyState: 'complete' },
  console: { log() {}, warn() {}, error() {} },
  setTimeout(fn) {
    try {
      fn();
    } catch (_e) {}
    return 1;
  },
  clearTimeout() {},
  setInterval(fn) {
    // Immediately invoke waiters once so hooks install when pool appears.
    logSandbox.__intervals.push(fn);
    return 1;
  },
  clearInterval() {},
  __intervals: [],
};
logSandbox.window.document = logSandbox.document;
vm.createContext(logSandbox);
vm.runInContext(logger, logSandbox);
let subscribeCalled = false;
let subscribeArgs = null;
logSandbox.window.NostrApp.pool = {
  publish() {},
  subscribeMany(relays, filters, opts) {
    subscribeCalled = true;
    subscribeArgs = { relays, filters, opts };
    return { close() {} };
  },
  list() {
    return Promise.resolve([]);
  },
};
for (const fn of logSandbox.__intervals) {
  try {
    fn();
  } catch (_e) {}
}
let loggerThrew = false;
try {
  logSandbox.window.NostrApp.pool.subscribeMany(
    ['wss://example.invalid'],
    { kinds: [25060], '#d': ['pairing'] },
    { onevent() {} },
  );
} catch (e) {
  loggerThrew = true;
  check('LOGGER_SINGLE_FILTER_NO_THROW', false, String(e && e.message));
}
if (!loggerThrew) {
  check('LOGGER_SINGLE_FILTER_NO_THROW', true);
  check(
    'LOGGER_PRESERVES_FILTER_SHAPE',
    subscribeCalled &&
      subscribeArgs &&
      !Array.isArray(subscribeArgs.filters) &&
      subscribeArgs.filters &&
      subscribeArgs.filters.kinds &&
      subscribeArgs.filters.kinds[0] === 25060,
  );
}

// --- Runtime: Guest welcome + mobile page APIs ---
const els = new Map();
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    innerHTML: '',
    className: '',
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    hidden: false,
    textContent: '',
    width: 240,
    height: 240,
    onclick: null,
    children: [],
    attributes: {},
    parentNode: null,
    _id: '',
    addEventListener() {},
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'id') this.id = v;
    },
    getAttribute(k) {
      return this.attributes[k] || null;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      if (c.id) els.set(c.id, c);
      return c;
    },
    replaceChild(n, o) {
      const i = this.children.indexOf(o);
      if (i >= 0) this.children[i] = n;
      n.parentNode = this;
      if (n.id) els.set(n.id, n);
      return n;
    },
    cloneNode() {
      return makeEl(this.tagName);
    },
    closest() {
      return this;
    },
    querySelector(sel) {
      if (sel === '.sos-ld-qr-wrap') return this._qrWrap || (this._qrWrap = makeEl('div'));
      if (sel === '.sos-ld-status') return this._st || (this._st = makeEl('p'));
      if (sel === '.sos-ld-expiry') return this._exp || (this._exp = makeEl('p'));
      if (sel === '[data-ld-refresh]') return this._rf || (this._rf = makeEl('button'));
      if (sel === '[data-ld-continue-guest]') return this._cg || (this._cg = makeEl('button'));
      if (sel === '[data-ld-close]') return this._cl || (this._cl = makeEl('button'));
      if (sel === '[data-ld-open-login]') return this._lg || (this._lg = makeEl('button'));
      if (sel === '[data-ld-mobile-back]') return this._bk || (this._bk = makeEl('button'));
      if (sel === '[data-ld-retry-qr]') return this._retry || (this._retry = makeEl('button'));
      if (sel === '#sosLdMobileScan') return this._scan || (this._scan = makeEl('button'));
      if (sel === '#sosLdMobileDeviceList') return this._list || (this._list = makeEl('ul'));
      if (sel === 'canvas') return this._canvas || (this._canvas = makeEl('canvas'));
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(el, 'id', {
    get() {
      return this._id || '';
    },
    set(v) {
      this._id = String(v || '');
      if (this._id) els.set(this._id, this);
    },
  });
  return el;
}

const sandbox = {
  window: {
    matchMedia(q) {
      const queries = sandbox.__mq || {};
      return { matches: !!queries[q], addEventListener() {}, addListener() {} };
    },
    NostrApp: { guestMode: true, publicKey: '', pool: null },
    alert() {},
    scrollTo() {},
    addEventListener() {},
    sessionStorage: {
      _m: {},
      getItem(k) {
        return this._m[k] || null;
      },
      setItem(k, v) {
        this._m[k] = String(v);
      },
    },
    __sosLdGuestWelcomeActive: false,
  },
  navigator: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
    maxTouchPoints: 0,
    userAgentData: { mobile: false, platform: 'Windows' },
  },
  document: {
    readyState: 'complete',
    addEventListener() {},
    getElementById(id) {
      return els.get(id) || null;
    },
    querySelector() {
      return null;
    },
    createElement: makeEl,
    head: { appendChild() {} },
    body: {
      appendChild(c) {
        if (c.id) els.set(c.id, c);
        return c;
      },
    },
  },
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {},
  },
  sessionStorage: null,
  crypto: {
    getRandomValues(a) {
      for (let i = 0; i < a.length; i++) a[i] = (i + 3) & 255;
      return a;
    },
  },
  console,
  setTimeout(fn) {
    fn();
    return 1;
  },
  clearInterval() {},
  setInterval() {
    return 1;
  },
  __mq: {
    '(pointer: fine)': true,
    '(pointer: coarse)': false,
    '(hover: hover)': true,
    '(max-width: 900px)': false,
  },
};
sandbox.sessionStorage = sandbox.window.sessionStorage;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.crypto = sandbox.crypto;
sandbox.window.location = { href: 'https://sos010.com/videos.html' };
sandbox.Buffer = Buffer;
sandbox.URL = URL;
vm.createContext(sandbox);

// Stub MD2 session + QR renderer
let beginCalls = 0;
sandbox.window.SosMd2PairingSession = {
  beginDesktopInitiator: async () => {
    beginCalls += 1;
    const pairingId = 'pid' + beginCalls;
    const qrText =
      'SOSPAIR1:' +
      Buffer.from(
        JSON.stringify({
          v: 1,
          pairingId,
          deviceId: 'd'.repeat(64),
          expiresAt: Date.now() + 120000,
        }),
      ).toString('base64url');
    return {
      qrText,
      deviceId: 'd'.repeat(64),
      dSignPub: 'a'.repeat(64),
      dEncPub: 'b'.repeat(64),
      payload: { pairingId, expiresAt: Date.now() + 120000 },
      stop() {},
      waitLinked: () => new Promise(() => {}),
      exportDeviceSecrets: () => null,
    };
  },
};
sandbox.window.SosMd2PairingQr = {
  renderPairingQrToCanvas: async () => true,
  parseQr: () => ({ ok: false }),
};
sandbox.window.NostrApp.Md2PairingSession = sandbox.window.SosMd2PairingSession;
sandbox.window.NostrApp.Md2PairingQr = sandbox.window.SosMd2PairingQr;

vm.runInContext(ld, sandbox);
const API = sandbox.window.SosWebLinkedDevices || sandbox.window.NostrApp.WebLinkedDevices;
check('API_UX3_EXPORTS', !!(API && API.showGuestQrWelcome && API.continueAsGuest && API.openMobileLinkedDevicesPage));

const welcome = API.showGuestQrWelcome();
check('GUEST_FIRST_ENTRY_PATH', welcome && welcome.path === 'GUEST_FIRST_ENTRY_QR');
check('GUEST_WELCOME_FLAG', sandbox.window.__sosLdGuestWelcomeActive === true);
await new Promise((r) => setTimeout(r, 10));
check('MD2_SESSION_STARTED', beginCalls >= 1, String(beginCalls));

const cont = API.continueAsGuest();
check('CONTINUE_PATH', cont && cont.path === 'CONTINUE_AS_GUEST' && cont.LINKED === false);
check('GUEST_FLAG_CLEARED', sandbox.window.__sosLdGuestWelcomeActive === false);
check('GUEST_CONTINUED_SESSION', sandbox.window.sessionStorage.getItem('sos_ld_guest_continued_v1') === '1');

// Mobile page
sandbox.__mq = {
  '(pointer: fine)': false,
  '(pointer: coarse)': true,
  '(hover: hover)': false,
  '(max-width: 900px)': true,
};
sandbox.navigator.userAgent = 'Mozilla/5.0 (Linux; Android 11; M2101K6G) Mobile';
sandbox.navigator.maxTouchPoints = 5;
sandbox.navigator.userAgentData = { mobile: true, platform: 'Android' };
const page = API.openMobileLinkedDevicesPage();
check('MOBILE_PAGE_PATH', page && page.path === 'MOBILE_LINKED_DEVICES_PAGE');
check('DEVICE_LIST_LOCAL', page && page.DEVICE_LIST_SOURCE === 'LOCAL_BROWSER_REGISTRY');
const primary = API.openLinkedDevicesPrimaryAction();
check(
  'MOBILE_PRIMARY_OPENS_PAGE',
  primary && (primary.path === 'MOBILE_LINKED_DEVICES_PAGE' || els.has('sosLdMobilePage')),
);

const failed = checks.filter((c) => !c.ok);
const report = {
  status: failed.length ? 'FAIL' : 'PASS',
  runId,
  version: av.version,
  moduleSha16: {
    linkedDevices: sha16('sos-web-linked-devices.js'),
    logger: sha16('chat-request-logger.js'),
    guestAuth: sha16('guest-auth.js'),
  },
  checks,
  failed: failed.map((f) => f.name),
};
fs.writeFileSync(path.join(ROOT, 'qa/ux3-linked-devices-product-report.json'), JSON.stringify(report, null, 2));
console.log(`STATUS=${report.status} runId=${runId}`);
process.exit(failed.length ? 1 : 0);
