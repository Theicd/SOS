/**
 * Package 899f — Web first-group control panel + 6-digit admin PIN lock gate (V2 OFF, production flag state).
 * Local static server; runtime-feature-flags.json served unchanged (ACCESS_CONTROL_V2 OFF).
 * config.js is served with the first-group root replaced by a disposable test root (A). Never deploys.
 * The test PIN is random per run and is never printed or written to the report.
 * Active-control (V2 ON) PIN enforcement is covered by package898-first-group-network-e2e.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package899f-group-control-pin-report.json');
const PORT = Number(process.env.SOS_899F_PORT || 8799);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const PROD_ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkKey = () => {
  const sk = generateSecretKey();
  return { hex: hex(sk), pub: getPublicKey(sk) };
};

function trivial(p) {
  if (/^(\d)\1{5}$/.test(p) || /^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p)) return true;
  const d = p.split('').map(Number);
  let asc = true;
  let desc = true;
  for (let i = 1; i < 6; i++) {
    if ((d[i] - d[i - 1] + 10) % 10 !== 1) asc = false;
    if ((d[i - 1] - d[i] + 10) % 10 !== 1) desc = false;
  }
  return asc || desc;
}
function randomPin(avoid) {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!trivial(p) && p !== avoid && !/^(19|20)\d\d/.test(p)) return p;
  }
}
const PIN = randomPin('');
const WRONG = randomPin(PIN);

const report = {
  gate: 'PACKAGE899F_GROUP_CONTROL_PIN',
  ACCESS_CONTROL_V2: 'OFF (served unchanged)',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 240));
};

// ---------------------------------------------------------------- server
let ROOT_PUB = '';
const netLog = [];
function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/videos.html';
      const fp = path.join(ROOT, p.replace(/^\//, ''));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end('nf');
        return;
      }
      if (p === '/config.js') {
        const src = fs.readFileSync(fp, 'utf8').replace(PROD_ROOT, ROOT_PUB);
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        res.end(src);
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
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

const ALLOWED = new Set(['127.0.0.1', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const consoleLog = [];

async function newUser(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.route('**/*', (route) => {
    const req = route.request();
    netLog.push(req.url() + ' ' + (req.postData() || ''));
    let host = '';
    try {
      host = new URL(req.url()).hostname;
    } catch (_e) {}
    return ALLOWED.has(host) ? route.continue() : route.abort();
  });
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
    } catch (_e) {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => consoleLog.push(m.text()));
  page.on('websocket', (ws) => ws.on('framesent', (f) => netLog.push(String(f.payload || ''))));
  page.on('pageerror', (e) => {
    if (/admin-pin-lock|first-group-admin|group-admin-product-ui/.test(String(e.stack || ''))) (report.pageErrors = report.pageErrors || []).push(label + ': ' + String(e.message).slice(0, 200));
  });
  return { ctx, page, label };
}

async function waitApp(page) {
  await page.waitForFunction(
    () => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.AdminPinLock && !!window.NostrApp?.GroupAdminProductUi && window.SosFeatureFlags?.isResolved?.() === true,
    null,
    { polling: 200, timeout: 120000 }
  );
}

async function boot(page, key) {
  await waitApp(page);
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    await new Promise((r) => setTimeout(r, 500));
    App.GroupAdminProductUi.ensureMenuEntry();
    return String(c.publicKey || '').toLowerCase();
  }, k(key));
}
const k = (key) => key.hex;

const menuState = (page) =>
  page.evaluate(() => {
    window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
    const el = document.getElementById('sosGroupControlMenuItem');
    return { exists: !!el, visible: !!el && !el.hidden && el.style.display !== 'none', label: el ? el.textContent.trim() : '', inMenu: !!el && !!el.closest('#topBarProfileMenu') };
  });

const dialog = (page) =>
  page.evaluate(() => {
    const d = document.getElementById('sosAdminPinDialog');
    if (!d) return null;
    return {
      title: d.querySelector('#sosAdminPinTitle')?.textContent || '',
      inputs: Array.from(d.querySelectorAll('input')).map((i) => ({ type: i.type, inputmode: i.getAttribute('inputmode'), maxlength: i.maxLength, autocomplete: i.getAttribute('autocomplete') })),
      err: d.querySelector('#sosAdminPinErr')?.textContent || '',
      buttons: Array.from(d.querySelectorAll('button')).map((b) => b.textContent),
    };
  });

async function fillDialog(page, values) {
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#sosAdminPinDialog input')).map((i) => i.id));
  for (let i = 0; i < ids.length; i++) await page.fill('#' + ids[i], values[i] ?? values[0]);
  await page.click('#sosAdminPinOk');
  await sleep(150);
  await page.waitForFunction(() => {
    const d = document.getElementById('sosAdminPinDialog');
    return !d || !document.getElementById('sosAdminPinOk').disabled || (document.getElementById('sosAdminPinErr').textContent || '').length > 0;
  }, null, { polling: 100, timeout: 30000 });
}

const panel = (page) =>
  page.evaluate(() => {
    const ui = window.NostrApp.GroupAdminProductUi;
    const st = document.getElementById('sosGapControlStatus');
    return {
      open: ui.isOpen(),
      status: st ? st.getAttribute('data-status') : null,
      name: document.getElementById('sosGapViewName')?.textContent || '',
      root: document.getElementById('sosGapRootCard')?.textContent || '',
      members: document.getElementById('sosGapMemberCount')?.textContent || '',
      caps: Array.from(document.querySelectorAll('#sosGapCapsCatalog input[data-cap]')).map((c) => c.getAttribute('data-cap')),
      capsDisabled: Array.from(document.querySelectorAll('#sosGapCapsCatalog input')).every((c) => c.disabled),
      roles: document.querySelectorAll('#sosGapBody table tbody tr').length,
      enabledMutations: Array.from(document.querySelectorAll('#sosGapBody button')).filter((b) => !b.disabled).length,
      bodyLen: (document.getElementById('sosGapBody')?.innerHTML || '').length,
    };
  });

async function main() {
  const A = mkKey();
  const M = mkKey();
  ROOT_PUB = A.pub;
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const ua = await newUser(browser, 'A');
    const um = await newUser(browser, 'M');
    const ug = await newUser(browser, 'G');
    await ua.page.clock.install();
    for (const u of [ua, um, ug]) await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const pa = await boot(ua.page, A);
    await boot(um.page, M);
    await waitApp(ug.page);
    const flags = await ua.page.evaluate(() => ({ v2: window.SOS_ACCESS_CONTROL_V2 === true, root: window.NostrApp.FirstGroupAdmin.isConfiguredRoot(window.NostrApp.publicKey), admission: window.NostrApp.FIRST_GROUP_ADMISSION_URL || '' }));
    set('ENV_V2_OFF_TEST_ROOT', pa === A.pub && !flags.v2 && flags.root && flags.admission === '', flags);

    // ---- menu visibility
    const mA = await menuState(ua.page);
    const mM = await menuState(um.page);
    const mG = await menuState(ug.page);
    set('MENU_VISIBLE_ROOT', mA.visible && mA.inMenu && mA.label === 'שליטה על הקבוצה', mA);
    set('MENU_HIDDEN_MEMBER', !mM.visible, mM);
    set('MENU_HIDDEN_GUEST', !mG.visible, mG);
    const mOpen = await um.page.evaluate(async () => (await window.NostrApp.GroupAdminProductUi.open('home')).code);
    const mDialog = await dialog(um.page);
    set('MEMBER_DIRECT_OPEN_REJECTED', mOpen === 'UNAUTHORIZED' && !mDialog, { mOpen });

    // ---- first-time setup via menu
    await ua.page.evaluate(() => document.getElementById('sosGroupControlMenuItem').click());
    await ua.page.waitForSelector('#sosAdminPinDialog', { timeout: 10000 });
    const d1 = await dialog(ua.page);
    const inputsOk = d1.inputs.length === 2 && d1.inputs.every((i) => i.type === 'password' && i.inputmode === 'numeric' && i.maxlength === 6 && i.autocomplete === 'off');
    set('SETUP_DIALOG', d1.title === 'הגדרת קוד מנהל' && inputsOk && d1.buttons.includes('אישור') && d1.buttons.includes('ביטול'), d1);
    set('PANEL_NOT_OPEN_BEFORE_PIN', !(await panel(ua.page)).open);
    await fillDialog(ua.page, ['123456', '123456']);
    const dTrivial = await dialog(ua.page);
    await fillDialog(ua.page, [PIN, WRONG]);
    const dMismatch = await dialog(ua.page);
    await ua.page.fill('#sosAdminPinNew', '12ab34');
    const filtered = await ua.page.$eval('#sosAdminPinNew', (i) => i.value);
    set('SETUP_REJECTS_TRIVIAL', !!dTrivial && /פשוט/.test(dTrivial.err), dTrivial && dTrivial.err);
    set('SETUP_REJECTS_MISMATCH', !!dMismatch && /אינם זהים/.test(dMismatch.err), dMismatch && dMismatch.err);
    set('NUMERIC_ONLY_INPUT', filtered === '1234', { len: filtered.length });
    const deny = await ua.page.evaluate(() => {
      const P = window.NostrApp.AdminPinLock;
      const bad = ['000000', '123456', '111111', '654321', '121212', '123123', '890123', '210987', '999999', '112233'];
      return { badAllRejected: bad.every((p) => P.isTrivialPin(p)), goodAccepted: !P.isTrivialPin('482915') && !P.isTrivialPin('730641'), shortRejected: P.isTrivialPin('12345') && P.isTrivialPin('abcdef') };
    });
    set('DENY_LIST', deny.badAllRejected && deny.goodAccepted && deny.shortRejected, deny);
    await fillDialog(ua.page, [PIN, PIN]);
    await ua.page.waitForFunction(() => window.NostrApp.GroupAdminProductUi.isOpen(), null, { polling: 100, timeout: 15000 });
    const p1 = await panel(ua.page);
    const capLabels = await ua.page.evaluate(() => Object.keys(window.NostrApp.FirstGroupAdmin.CAP_LABELS));
    set('SETUP_OK_PANEL_OPENS', p1.open && !(await dialog(ua.page)), { open: p1.open });
    set(
      'PANEL_INACTIVE_CONTENT',
      p1.status === 'CONTROL_PLANE_NOT_ACTIVE' && p1.name === 'SOS' && p1.root.includes(A.pub) && /מוגן/.test(p1.root) && p1.members === '—' && p1.roles >= 7 && JSON.stringify(p1.caps) === JSON.stringify(capLabels) && p1.capsDisabled,
      { status: p1.status, name: p1.name, members: p1.members, roles: p1.roles, caps: p1.caps.length, capsDisabled: p1.capsDisabled }
    );
    set('NO_ENABLED_MUTATION_CONTROLS_INACTIVE', p1.enabledMutations === 0 && /מוגן/.test(p1.root), { enabledButtons: p1.enabledMutations });
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'package899f-panel-inactive.png') }).catch(() => {});

    // ---- mutations fail closed while control plane is inactive
    const mut = await ua.page.evaluate(async () => {
      const F = window.NostrApp.FirstGroupAdmin;
      return {
        unlocked: window.NostrApp.AdminPinLock.isUnlocked(),
        ui: window.NostrApp.GroupAdminProductUi.controlStatus(),
        bootstrap: (await F.bootstrapFirstGroup({})).code,
        meta: (await F.updateMetadata({ description: 'x' })).code,
        grant: (await F.grantCapability('11'.repeat(32), 'INVITE_USERS')).code,
        invite: (await F.createInvite()).code,
        flagsFlag: F.ADMIN_MUTATION_REQUIRES_PIN_UNLOCK,
        pinOnly: window.NostrApp.AdminPinLock.PIN_ONLY_ADMIN_AUTHORIZATION,
      };
    });
    set('CONTROL_PLANE_NOT_ACTIVE_FAIL_CLOSED', mut.unlocked && mut.ui === 'CONTROL_PLANE_NOT_ACTIVE' && ['bootstrap', 'meta', 'grant', 'invite'].every((x) => mut[x] === 'V2_REQUIRED') && mut.flagsFlag === true && mut.pinOnly === false, mut);

    // ---- storage / leak checks (PIN never persisted in plaintext)
    const store = await ua.page.evaluate(async () => {
      const toHex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
      const dump = await new Promise((resolve) => {
        const r = indexedDB.open('sos-admin-pin-v1');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['pin', 'wrap'], 'readonly');
          const out = { pin: [], wrap: [] };
          tx.objectStore('pin').openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (c) {
              const v = c.value;
              out.pin.push({ key: c.key, fields: Object.keys(v), sealedFields: Object.keys(v.sealed || {}), iterations: v.sealed?.iterations, ivHex: toHex(v.sealed?.iv || []), ctHex: toHex(v.sealed?.ct || []), failures: v.failures });
              c.continue();
            }
          };
          tx.objectStore('wrap').openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (c) {
              out.wrap.push({ extractable: c.value.extractable, alg: c.value.algorithm && c.value.algorithm.name, usages: c.value.usages });
              c.continue();
            }
          };
          tx.oncomplete = () => resolve(out);
        };
      });
      const ls = [];
      for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i) + '=' + localStorage.getItem(localStorage.key(i)));
      const ss = [];
      for (let i = 0; i < sessionStorage.length; i++) ss.push(sessionStorage.key(i) + '=' + sessionStorage.getItem(sessionStorage.key(i)));
      return { dump, ls: ls.join('\n'), ss: ss.join('\n'), url: location.href, dom: document.documentElement.outerHTML };
    });
    const rec = store.dump.pin[0] || {};
    const pinHex = Buffer.from(PIN).toString('hex');
    const noPlain = ![store.ls, store.ss, store.url, store.dom, JSON.stringify(store.dump)].some((s) => s.includes(PIN) || s.includes(pinHex));
    set(
      'PIN_STORED_AS_SEALED_SLOW_VERIFIER',
      store.dump.pin.length === 1 && rec.key === A.pub && !rec.fields.some((f) => /pin|hash|salt/i.test(f)) && rec.iterations === 600000 && rec.ctHex.length === (16 + 32 + 16) * 2 && store.dump.wrap.length === 1 && store.dump.wrap[0].extractable === false && store.dump.wrap[0].alg === 'AES-GCM',
      { records: store.dump.pin.length, keyIsIdentity: rec.key === A.pub, fields: rec.fields, sealedFields: rec.sealedFields, iterations: rec.iterations, ctBytes: (rec.ctHex || '').length / 2, wrap: store.dump.wrap }
    );
    set('PIN_NOT_IN_STORAGE_URL_DOM', noPlain);

    // ---- lock + wrong PIN via UI
    await ua.page.evaluate(() => window.NostrApp.AdminPinLock.lock('test'));
    await sleep(200);
    set('LOCK_CLOSES_PANEL', !(await panel(ua.page)).open);
    await ua.page.evaluate(() => { window.__openRes = window.NostrApp.GroupAdminProductUi.open('home'); });
    await ua.page.waitForSelector('#sosAdminPinDialog', { timeout: 10000 });
    const d2 = await dialog(ua.page);
    set('ENTRY_DIALOG', d2.title === 'קוד מנהל' && d2.inputs.length === 1 && d2.inputs[0].type === 'password' && d2.inputs[0].maxlength === 6, d2);
    await fillDialog(ua.page, [WRONG]);
    const dWrong = await dialog(ua.page);
    set('WRONG_PIN_REJECTED', !!dWrong && /שגוי/.test(dWrong.err) && !(await panel(ua.page)).open, dWrong && dWrong.err);
    await fillDialog(ua.page, [PIN]);
    await ua.page.waitForFunction(() => window.NostrApp.GroupAdminProductUi.isOpen(), null, { polling: 100, timeout: 15000 });
    set('CORRECT_PIN_OPENS', (await panel(ua.page)).open && !(await dialog(ua.page)));

    // ---- progressive lockout (never permanent)
    await ua.page.evaluate(() => window.NostrApp.AdminPinLock.lock('test'));
    const lockout = [];
    const verify = (pin) => ua.page.evaluate(async (p) => {
      const r = await window.NostrApp.AdminPinLock.verifyPin(p);
      return { ok: r.ok, code: r.code, failures: r.failures, retryAfterMs: r.retryAfterMs };
    }, pin);
    for (let i = 1; i <= 3; i++) lockout.push(await verify(WRONG));
    const f4 = await verify(WRONG);
    const during4 = await verify(PIN);
    await ua.page.clock.fastForward(31000);
    const f5 = await verify(WRONG);
    await ua.page.clock.fastForward(61000);
    const f6 = await verify(WRONG);
    const during6 = await verify(PIN);
    await ua.page.clock.fastForward(5 * 60 * 1000 + 1000);
    const f7 = await verify(WRONG);
    await ua.page.clock.fastForward(10 * 60 * 1000 + 1000);
    const okAfter = await verify(PIN);
    const stAfter = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.lockoutState());
    set('FAILURES_1_TO_3_NO_DELAY', lockout.every((r, i) => r.code === 'PIN_WRONG' && r.retryAfterMs === 0 && r.failures === i + 1), lockout);
    set('FAILURES_4_5_SHORT_DELAY', f4.retryAfterMs === 30000 && during4.code === 'PIN_LOCKED' && f5.failures === 5 && f5.retryAfterMs === 60000, { f4, during4: during4.code, f5 });
    set('FAILURES_6_PLUS_PROGRESSIVE', f6.retryAfterMs === 300000 && during6.code === 'PIN_LOCKED' && f7.retryAfterMs === 600000, { f6, during6: during6.code, f7 });
    const cap = await ua.page.evaluate(() => [10, 20, 50].map((n) => window.NostrApp.AdminPinLock.delayForFailures(n)));
    set('LOCKOUT_NOT_PERMANENT', okAfter.ok && stAfter.failures === 0 && stAfter.retryAfterMs === 0 && cap.every((ms) => ms === 3600000), { okAfter: okAfter.code, stAfter, capMs: cap });

    // ---- inactivity timeout + activity refresh
    const t = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.isUnlocked());
    await ua.page.evaluate(() => window.NostrApp.GroupAdminProductUi.open('home'));
    await sleep(200);
    await ua.page.clock.fastForward(10 * 60 * 1000);
    await ua.page.evaluate(() => window.NostrApp.AdminPinLock.touch());
    await ua.page.clock.fastForward(10 * 60 * 1000);
    const refreshed = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.isUnlocked());
    await ua.page.clock.fastForward(16 * 60 * 1000);
    await sleep(300);
    const timedOut = await ua.page.evaluate(() => ({ unlocked: window.NostrApp.AdminPinLock.isUnlocked(), open: window.NostrApp.GroupAdminProductUi.isOpen(), body: (document.getElementById('sosGapBody')?.innerHTML || '').length }));
    const afterTimeoutMut = await ua.page.evaluate(async () => (await window.NostrApp.FirstGroupAdmin.updateMetadata({ description: 'y' })).code);
    set('ACTIVITY_REFRESHES_SESSION', t && refreshed, { t, refreshed });
    set('TIMEOUT_RELOCKS_15_MIN', !timedOut.unlocked && !timedOut.open && timedOut.body === 0, timedOut);
    report.info_afterTimeoutMutation = afterTimeoutMut;

    // ---- logout clears unlock
    await verify(PIN);
    const beforeLogout = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.isUnlocked());
    const afterLogout = await ua.page.evaluate(() => {
      window.NostrApp.SessionAuthority.revokeSession({ reason: 'logout' });
      return window.NostrApp.AdminPinLock.isUnlocked();
    });
    await boot(ua.page, A);
    const afterRelogin = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.isUnlocked());
    set('LOGOUT_CLEARS_UNLOCK', beforeLogout && !afterLogout && !afterRelogin, { beforeLogout, afterLogout, afterRelogin });

    // ---- account switch clears unlock and hides the menu
    await verify(PIN);
    await ua.page.evaluate(() => window.NostrApp.GroupAdminProductUi.open('home'));
    await sleep(200);
    const sw = await ua.page.evaluate(async (mHex) => {
      const App = window.NostrApp;
      const before = App.AdminPinLock.isUnlocked();
      App.switchAccountFromRawKey(mHex, { reload: false });
      App.guestMode = false;
      await new Promise((r) => setTimeout(r, 900));
      App.GroupAdminProductUi.ensureMenuEntry();
      const item = document.getElementById('sosGroupControlMenuItem');
      return {
        before,
        pub: App.publicKey,
        unlocked: App.AdminPinLock.isUnlocked(),
        open: App.GroupAdminProductUi.isOpen(),
        menu: !!item && item.style.display !== 'none',
        mHasPin: await App.AdminPinLock.hasPin(),
      };
    }, M.hex);
    set('ACCOUNT_SWITCH_CLEARS_UNLOCK', sw.before && sw.pub === M.pub && !sw.unlocked && !sw.open && !sw.menu && sw.mHasPin === false, sw);
    await boot(ua.page, A);
    const back = await ua.page.evaluate(async () => ({ unlocked: window.NostrApp.AdminPinLock.isUnlocked(), hasPin: await window.NostrApp.AdminPinLock.hasPin() }));
    set('SWITCH_BACK_REQUIRES_PIN', !back.unlocked && back.hasPin, back);

    // ---- identity-bound verifier: another identity cannot unlock with A's PIN
    const mVerify = await um.page.evaluate(async (p) => (await window.NostrApp.AdminPinLock.verifyPin(p)).code, PIN);
    set('PIN_BOUND_TO_IDENTITY', mVerify === 'PIN_NOT_SET', { mVerify });

    // ---- browser restart (reload) clears unlock, verifier persists
    await verify(PIN);
    await ua.page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(ua.page);
    await ua.page.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, A.pub, { polling: 200, timeout: 25000 }).catch(() => {});
    const reload = await ua.page.evaluate(async () => ({ pub: window.NostrApp.publicKey, unlocked: window.NostrApp.AdminPinLock.isUnlocked(), hasPin: await window.NostrApp.AdminPinLock.hasPin(), menu: window.NostrApp.GroupAdminProductUi.canSeeGroupControl() }));
    set('RESTART_CLEARS_UNLOCK', !reload.unlocked && reload.hasPin, reload);

    // ---- no PIN in console / network
    const netHit = netLog.some((s) => s.includes(PIN));
    const conHit = consoleLog.some((s) => s.includes(PIN) || s.includes(WRONG));
    set('PIN_NOT_IN_CONSOLE_OR_NETWORK', !netHit && !conHit, { requests: netLog.length, consoleLines: consoleLog.length });
    set('NO_PIN_MODULE_PAGE_ERRORS', !(report.pageErrors || []).length, report.pageErrors || []);
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'package899f-after.png') }).catch(() => {});
  } catch (e) {
    set('GATE_EXCEPTION', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  const vals = Object.values(report.results);
  report.passed = vals.filter((r) => r.ok).length;
  report.total = vals.length;
  report.status = vals.length && vals.every((r) => r.ok) ? 'PASS' : 'FAIL';
  report.PIN_ONLY_ADMIN_AUTHORIZATION = !(report.results.CONTROL_PLANE_NOT_ACTIVE_FAIL_CLOSED || {}).ok;
  report.PIN_LOGGED = !(report.results.PIN_NOT_IN_CONSOLE_OR_NETWORK || {}).ok || !(report.results.PIN_NOT_IN_STORAGE_URL_DOM || {}).ok;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${report.status} ${report.passed}/${report.total}`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
