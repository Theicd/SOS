/**
 * Package 899f — Web first-group control panel + 6-digit admin PIN lock gate (V2 OFF, production flag state).
 * Local static server; runtime-feature-flags.json served with ACCESS_CONTROL_V2 OFF (pre-activation stage).
 * config.js is served with the first-group root replaced by a disposable test root (A) and the admission URL pointed
 * at a local `wrangler dev --local` admin PIN service (Admin 2FA Phase 3: the server is the only PIN authority).
 * Disposable service keys + pepper go to the gitignored admission-service/.dev.vars (deleted on exit). Never deploys.
 * The test PIN is random per run and is never printed or written to the report.
 * Active-control (V2 ON) PIN enforcement is covered by package898-first-group-network-e2e.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package899f-group-control-pin-report.json');
const PORT = Number(process.env.SOS_899F_PORT || 8799);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const PROD_ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const SVC_DIR = path.join(ROOT, 'admission-service');
const ADM_PORT = Number(process.env.SOS_899F_ADM_PORT || 8794);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;

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
        const src = fs.readFileSync(fp, 'utf8').replace(PROD_ROOT, ROOT_PUB).replace(/App\.FIRST_GROUP_ADMISSION_URL = '[^']*';/, () => `App.FIRST_GROUP_ADMISSION_URL = '${ADM_URL}';`);
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        res.end(src);
        return;
      }
      if (p === '/runtime-feature-flags.json') {
        const pre = Object.assign(JSON.parse(fs.readFileSync(fp, 'utf8')), { accessControlV2: false });
        delete pre.accessControlV2Scope;
        res.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(pre));
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

// ---------------------------------------------------------------- local admin PIN service (disposable keys)
let wr = null;
let wrLog = '';
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-899f-adm-'));
const SECRETS = [];
async function startService(rootPub) {
  const svcHex = hex(generateSecretKey());
  const cosignHex = hex(generateSecretKey());
  const pepper = crypto.randomBytes(32).toString('hex');
  SECRETS.push(svcHex, cosignHex, pepper);
  fs.writeFileSync(
    path.join(SVC_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${rootPub}\nADMISSION_SK=${svcHex}\nADMIN_COSIGN_SK=${cosignHex}\nADMIN_PIN_PEPPER=${pepper}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:${PORT}\n`
  );
  wr = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(ADM_PORT), '--persist-to', persistDir, '--show-interactive-dev-session=false'], {
    cwd: SVC_DIR,
    shell: true,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
  });
  wr.stdout.on('data', (d) => (wrLog += d.toString()));
  wr.stderr.on('data', (d) => (wrLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ADM_URL + '/v1/health');
      if (r.ok && (await r.json()).adminPinService === true) return;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('local admin PIN service did not start');
}
function stopService() {
  if (wr) {
    try {
      execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' });
    } catch (_e) {
      try {
        wr.kill('SIGKILL');
      } catch (_e2) {}
    }
    wr = null;
  }
  try {
    fs.rmSync(path.join(SVC_DIR, '.dev.vars'), { force: true });
  } catch (_e) {}
  try {
    fs.rmSync(persistDir, { recursive: true, force: true });
  } catch (_e) {}
}
async function serverInspect() {
  const r = await fetch(ADM_URL + '/v1/test/pin-inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: 'israel-network' }) });
  return r.json();
}

// The page clock of user A is faked (lockout / inactivity tests); the service follows it via the TEST_FAULTS-only
// x-sos-test-now header, injected at the network layer so the page itself sends no extra header.
let srvOffset = 0;
async function fastForward(page, ms) {
  await page.clock.fastForward(ms);
  srvOffset += ms;
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
    if (!ALLOWED.has(host)) return route.abort();
    if (label === 'A' && req.url().startsWith(ADM_URL + '/')) {
      return route.continue({ headers: Object.assign({}, req.headers(), { 'x-sos-test-now': String(Date.now() + srvOffset) }) });
    }
    return route.continue();
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
      caps: Array.from(document.querySelectorAll('#sosGapCapsCatalog [data-cap]')).map((c) => c.getAttribute('data-cap')),
      capsInAdvanced: !!document.querySelector('#sosGapAdvanced #sosGapCapsCatalog') && !document.querySelector('#sosGapCapsCatalog input:not([disabled])'),
      roles: document.querySelectorAll('#sosGapAdvanced table tbody tr').length,
      enabledMutations: Array.from(document.querySelectorAll('#sosGroupAdminShell [data-mutation]')).filter((b) => !b.disabled).length,
      bodyLen: (document.getElementById('sosGapBody')?.innerHTML || '').length,
    };
  });

/** User-centric group control (V2 off): search → select → role + permissions; save disabled, navigation enabled. */
async function groupControlUx(page, A, M) {
  const ROOT_NAME = 'בעלים לבדיקה';
  const USER_NAME = 'משתמשת חיפוש';
  const stranger = mkKey().pub;
  await page.evaluate(
    ({ a, m, rn, un }) => {
      const App = window.NostrApp;
      App.profileCache.set(a, { name: rn, picture: '' });
      App.profileCache.set(m, { name: un, picture: '' });
      App.GroupAdminProductUi.renderTab('members');
    },
    { a: A.pub, m: M.pub, rn: ROOT_NAME, un: USER_NAME }
  );
  const main0 = await page.evaluate(() => {
    const adv = document.getElementById('sosGapAdvanced');
    const top = document.getElementById('sosGapTop');
    const body = document.getElementById('sosGapBody');
    const primary = (top ? top.innerText : '') + '\n' + (body ? body.innerText : '');
    return {
      title: document.getElementById('sosGapTitle')?.textContent || '',
      status: document.getElementById('sosGapControlStatus')?.textContent || '',
      searchLabel: document.querySelector('label[for="sosGapUserSearch"]')?.textContent || '',
      placeholder: document.getElementById('sosGapUserSearch')?.getAttribute('placeholder') || '',
      tabs: Array.from(document.querySelectorAll('#sosGapTabs button')).filter((b) => !b.hidden && b.style.display !== 'none').map((b) => b.textContent),
      advancedCollapsed: !!adv && adv.open === false,
      advancedHasGroupId: !!adv && adv.textContent.includes('israel-network'),
      primary,
      summary: document.getElementById('sosGapSummary')?.innerText || '',
    };
  });
  set(
    'UX_MAIN_PAGE',
    main0.title === 'ניהול הקבוצה' &&
      main0.status === 'מערכת הניהול עדיין לא הופעלה. ניתן לצפות ולהכין הרשאות, אך לא לשמור שינויים.' &&
      main0.searchLabel === 'חיפוש משתמש' &&
      main0.placeholder === 'חפש לפי שם או מזהה משתמש' &&
      JSON.stringify(main0.tabs) === JSON.stringify(['חברים', 'מנהלים', 'הזמנות', 'פעילות ניהולית']) &&
      /חברים: עדיין אין נתונים/.test(main0.summary) && /מנהלים: 1/.test(main0.summary) && !/—/.test(main0.summary),
    { title: main0.title, tabs: main0.tabs, summary: main0.summary }
  );
  set(
    'UX_TECHNICAL_INFO_ONLY_IN_ADVANCED',
    main0.advancedCollapsed && main0.advancedHasGroupId && !/CONTROL_PLANE_NOT_ACTIVE/.test(main0.primary) && !main0.primary.includes(A.pub) && !/israel-network/.test(main0.primary),
    { advancedCollapsed: main0.advancedCollapsed }
  );

  const list = await page.evaluate((a) => {
    const card = document.getElementById('sosGapRootCard');
    return {
      inList: !!card && !!card.closest('#sosGapMemberList'),
      text: card ? card.innerText : '',
      avatar: !!(card && card.querySelector('.gap-avatar')),
      manage: !!(card && Array.from(card.querySelectorAll('button')).some((b) => b.textContent === 'ניהול')),
      fullKey: card ? card.innerText.includes(a) : true,
    };
  }, A.pub);
  set('MEMBER_LIST', list.inList && list.avatar && list.manage && list.text.includes(ROOT_NAME) && /מנהל ראשי/.test(list.text) && /מוגן/.test(list.text) && !list.fullKey, list);

  await page.fill('#sosGapUserSearch', 'משתמשת');
  await page.waitForFunction((m) => !!document.querySelector(`#sosGapSearchResults [data-act="select-member"][data-pk="${m}"]`), M.pub, { polling: 200, timeout: 20000 });
  const hit = await page.evaluate((m) => {
    const row = document.querySelector(`#sosGapSearchResults [data-pk="${m}"]`);
    return { text: row ? row.innerText : '', avatar: !!(row && row.querySelector('.gap-avatar')), short: !!row && row.innerText.includes(m.slice(0, 8)) };
  }, M.pub);
  await page.fill('#sosGapUserSearch', stranger);
  await page.waitForFunction((s) => !!document.querySelector(`#sosGapSearchResults [data-pk="${s}"]`), stranger, { polling: 200, timeout: 20000 });
  set('USER_SEARCH', hit.text.includes(USER_NAME) && hit.avatar && hit.short && /עדיין אין נתוני חברות/.test(hit.text), hit);

  await page.fill('#sosGapUserSearch', 'משתמשת');
  await page.waitForFunction((m) => !!document.querySelector(`#sosGapSearchResults [data-pk="${m}"]`), M.pub, { polling: 200, timeout: 20000 });
  await page.$eval(`#sosGapSearchResults [data-pk="${M.pub}"]`, (el) => el.click());
  await page.waitForSelector('#sosGapMemberDetail', { timeout: 5000 });
  const drawer = await page.evaluate(() => {
    const d = document.getElementById('sosGapMemberDetail');
    return {
      pk: d.getAttribute('data-pk'),
      title: d.querySelector('#sosGapUserTitle')?.textContent || '',
      text: d.innerText,
      avatar: !!d.querySelector('.gap-avatar.lg'),
      roles: Array.from(d.querySelectorAll('#sosGapRoleOptions [data-role]')).map((b) => b.textContent),
      caps: Array.from(d.querySelectorAll('#sosGapCaps input[data-cap]')).map((c) => c.getAttribute('data-cap')),
      capsEnabled: Array.from(d.querySelectorAll('#sosGapCaps input[data-cap]')).every((c) => !c.disabled),
      primaryVisible: Array.from(d.querySelectorAll('#sosGapCaps > label input[data-cap]')).filter((c) => c.offsetParent !== null).map((c) => c.getAttribute('data-cap')),
      advanced: Array.from(d.querySelectorAll('#sosGapAdvancedCaps input[data-cap]')).map((c) => c.getAttribute('data-cap')),
      advancedCollapsed: !!d.querySelector('#sosGapAdvancedCaps') && d.querySelector('#sosGapAdvancedCaps').open === false,
      advancedTitle: d.querySelector('#sosGapAdvancedCaps summary')?.textContent || '',
      moderateLabel: d.querySelector('#sosGapCaps input[data-cap="MODERATE_CONTENT"]')?.closest('label')?.querySelector('b')?.textContent || '',
      helpCount: d.querySelectorAll('#sosGapCaps > label .gap-cap-help').length,
    };
  });
  set(
    'PERMISSION_UI_PRIMARY_AND_ADVANCED',
    JSON.stringify(drawer.primaryVisible) === JSON.stringify(['INVITE_USERS', 'MODERATE_CONTENT', 'MANAGE_MEMBERS', 'MANAGE_BLOCKLIST']) &&
      JSON.stringify(drawer.advanced.slice().sort()) === JSON.stringify(['MANAGE_ADMINS', 'MANAGE_GROUP_SETTINGS', 'MANAGE_INVITES', 'MANAGE_PERMISSIONS', 'VIEW_AUDIT_LOG']) &&
      drawer.advancedCollapsed && drawer.advancedTitle === 'הרשאות ניהול מתקדמות' && drawer.moderateLabel === 'מחיקת פוסטים ותגובות' && drawer.helpCount === 4,
    { primary: drawer.primaryVisible, advanced: drawer.advanced.length, collapsed: drawer.advancedCollapsed, label: drawer.moderateLabel, help: drawer.helpCount }
  );
  await page.screenshot({ path: path.join(ROOT, 'qa', 'permission-ui-user-panel.png') }).catch(() => {});
  const canonical = await page.evaluate(() => Object.keys(window.NostrApp.FirstGroupAdmin.CAP_LABELS));
  set(
    'SELECT_USER_PANEL',
    drawer.pk === M.pub && drawer.title === 'ניהול משתמש' && drawer.avatar && drawer.text.includes(USER_NAME) && drawer.text.includes(M.pub.slice(0, 8)) && /תפקיד/.test(drawer.text),
    { pk: drawer.pk === M.pub, title: drawer.title }
  );

  await page.click('#sosGapCaps input[data-cap="MODERATE_CONTENT"]');
  const afterToggle = await page.evaluate(() => document.querySelector('#sosGapRoleOptions .active')?.getAttribute('data-role') || '');
  await page.click('#sosGapRoleOptions [data-role="ADMIN"]');
  const afterRole = await page.evaluate(() => ({
    active: document.querySelector('#sosGapRoleOptions .active')?.getAttribute('data-role') || '',
    checked: Array.from(document.querySelectorAll('#sosGapCaps input[data-cap]')).filter((c) => c.checked).map((c) => c.getAttribute('data-cap')),
  }));
  set(
    'PER_USER_PERMISSION_EDITOR',
    JSON.stringify(drawer.roles) === JSON.stringify(['חבר', 'מזמין', 'מפקח תוכן', 'מנהל', 'מנהל בכיר']) &&
      JSON.stringify(drawer.caps.slice().sort()) === JSON.stringify(canonical.slice().sort()) && drawer.capsEnabled &&
      afterToggle === 'MODERATOR' && afterRole.active === 'ADMIN' && JSON.stringify(afterRole.checked) === JSON.stringify(['MANAGE_MEMBERS']),
    { roles: drawer.roles, caps: drawer.caps.length, afterToggle, afterRole }
  );

  const save = await page.evaluate(() => ({
    saveDisabled: document.getElementById('sosGapSaveUser')?.disabled === true,
    note: document.getElementById('sosGapSaveNote')?.textContent || '',
    enabledMutations: Array.from(document.querySelectorAll('#sosGroupAdminShell [data-mutation]')).filter((b) => !b.disabled).length,
    addDisabled: Array.from(document.querySelectorAll('#sosGapMemberDetail button')).some((b) => b.textContent === 'הוסף לקבוצה' && b.disabled),
  }));
  await page.screenshot({ path: path.join(ROOT, 'qa', 'group-control-ux-user-panel.png') }).catch(() => {});
  set('WRITE_ACTIONS_DISABLED', save.saveDisabled && save.note === 'ניתן לשמור לאחר הפעלת מערכת הניהול' && save.enabledMutations === 0 && save.addDisabled, save);

  await page.keyboard.press('Escape');
  const nav = [];
  for (const t of ['admins', 'invites', 'activity', 'members']) {
    await page.click(`#sosGapTabs button[data-tab="${t}"]`);
    nav.push(await page.evaluate(() => document.querySelector('#sosGapTabs button.active')?.dataset.tab || ''));
  }
  const adminsRoot = await page.evaluate((a) => {
    window.NostrApp.GroupAdminProductUi.renderTab('admins');
    const row = document.querySelector(`#sosGapAdminList [data-admin="${a}"]`);
    return !!row && /מוגן/.test(row.textContent) && !row.querySelector('[data-act="demote"]');
  }, A.pub);
  await page.evaluate(() => window.NostrApp.GroupAdminProductUi.renderTab('members'));
  set('READ_NAVIGATION_ENABLED', JSON.stringify(nav) === JSON.stringify(['admins', 'invites', 'activity', 'members']) && adminsRoot, { nav, adminsRoot });

  await page.$eval('#sosGapRootCard', (el) => el.click());
  await page.waitForSelector('#sosGapMemberDetail', { timeout: 5000 });
  const rootPanel = await page.evaluate(() => {
    const d = document.getElementById('sosGapMemberDetail');
    return {
      locked: !!d.querySelector('#sosGapRootLocked'),
      editor: !!d.querySelector('#sosGapCaps') || !!d.querySelector('#sosGapRoleOptions'),
      save: !!d.querySelector('[data-act="save-user"]'),
      allDisabled: Array.from(d.querySelectorAll('input')).every((i) => i.disabled),
      text: d.innerText,
    };
  });
  const rootOps = await page.evaluate(async (a) => {
    const F = window.NostrApp.FirstGroupAdmin;
    return { demote: (await F.demoteAdmin(a)).code, remove: (await F.removeMember(a)).code };
  }, A.pub);
  await page.keyboard.press('Escape');
  set(
    'ROOT_OWNER_IMMUTABLE',
    rootPanel.locked && !rootPanel.editor && !rootPanel.save && rootPanel.allDisabled && rootPanel.text.includes(ROOT_NAME) &&
      Object.values(rootOps).every((c) => c !== 'SAVED' && c !== 'OK' && c !== undefined),
    { rootPanel: { locked: rootPanel.locked, editor: rootPanel.editor, save: rootPanel.save }, rootOps }
  );
}

async function main() {
  const A = mkKey();
  const M = mkKey();
  ROOT_PUB = A.pub;
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await startService(A.pub);
    const ua = await newUser(browser, 'A');
    const um = await newUser(browser, 'M');
    const ug = await newUser(browser, 'G');
    await ua.page.clock.install();
    for (const u of [ua, um, ug]) await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const pa = await boot(ua.page, A);
    await boot(um.page, M);
    await waitApp(ug.page);
    const flags = await ua.page.evaluate(() => ({ v2: window.SOS_ACCESS_CONTROL_V2 === true, root: window.NostrApp.FirstGroupAdmin.isConfiguredRoot(window.NostrApp.publicKey), admission: window.NostrApp.FIRST_GROUP_ADMISSION_URL || '' }));
    set('ENV_V2_OFF_TEST_ROOT', pa === A.pub && !flags.v2 && flags.root && flags.admission === ADM_URL, flags);

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
      p1.status === 'CONTROL_PLANE_NOT_ACTIVE' && p1.name === 'SOS' && p1.root.includes(A.pub.slice(0, 8)) && !p1.root.includes(A.pub) && /מוגן/.test(p1.root) &&
        p1.members === 'עדיין אין נתונים' && p1.roles >= 7 && JSON.stringify(p1.caps) === JSON.stringify(capLabels) && p1.capsInAdvanced,
      { status: p1.status, name: p1.name, members: p1.members, roles: p1.roles, caps: p1.caps.length, capsInAdvanced: p1.capsInAdvanced }
    );
    set('NO_ENABLED_MUTATION_CONTROLS_INACTIVE', p1.enabledMutations === 0 && /מוגן/.test(p1.root), { enabledButtons: p1.enabledMutations });
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'package899f-panel-inactive.png') }).catch(() => {});
    await groupControlUx(ua.page, A, M);

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

    // ---- storage / leak checks: the verifier lives only on the server; the browser keeps nothing PIN-related
    const store = await ua.page.evaluate(async () => {
      const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
      const ls = [];
      for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i) + '=' + localStorage.getItem(localStorage.key(i)));
      const ss = [];
      for (let i = 0; i < sessionStorage.length; i++) ss.push(sessionStorage.key(i) + '=' + sessionStorage.getItem(sessionStorage.key(i)));
      return { dbs, ls: ls.join('\n'), ss: ss.join('\n'), url: location.href, dom: document.documentElement.outerHTML };
    });
    const insp = await serverInspect();
    const rec = (insp.pins || []).find((p) => p.principal === A.pub) || {};
    const pinHex = Buffer.from(PIN).toString('hex');
    const noPlain = ![store.ls, store.ss, store.url, store.dom, JSON.stringify(insp)].some((s) => s.includes(PIN) || s.includes(pinHex));
    const localPinKeys = (store.ls + '\n' + store.ss).split('\n').filter((l) => /admin[-_]?pin|sosAdminPin/i.test(l.split('=')[0]));
    set(
      'PIN_VERIFIER_SERVER_ONLY',
      !store.dbs.includes('sos-admin-pin-v1') && localPinKeys.length === 0 && (insp.pins || []).length === 1 && rec.saltHexLen >= 32 && rec.verifierHexLen === 64 && !(insp.columns || []).some((c) => /^pin$|plain/i.test(c)),
      { localIdb: store.dbs.includes('sos-admin-pin-v1'), localKeys: localPinKeys.length, serverRecords: (insp.pins || []).length, keyIsIdentity: rec.principal === A.pub, saltHexLen: rec.saltHexLen, verifierHexLen: rec.verifierHexLen, columns: insp.columns }
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
    await fastForward(ua.page, 31000);
    const f5 = await verify(WRONG);
    await fastForward(ua.page, 61000);
    const f6 = await verify(WRONG);
    const during6 = await verify(PIN);
    await fastForward(ua.page, 5 * 60 * 1000 + 1000);
    const f7 = await verify(WRONG);
    await fastForward(ua.page, 10 * 60 * 1000 + 1000);
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
    await fastForward(ua.page, 10 * 60 * 1000);
    await ua.page.evaluate(() => window.NostrApp.AdminPinLock.touch());
    await fastForward(ua.page, 10 * 60 * 1000);
    const refreshed = await ua.page.evaluate(() => window.NostrApp.AdminPinLock.isUnlocked());
    await fastForward(ua.page, 16 * 60 * 1000);
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
    set('PIN_BOUND_TO_IDENTITY', mVerify === 'UNAUTHORIZED' || mVerify === 'PIN_NOT_SET', { mVerify });

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
    const svcHit = wrLog.includes(PIN) || wrLog.includes(WRONG) || SECRETS.some((s) => wrLog.includes(s));
    set('PIN_NOT_IN_CONSOLE_OR_NETWORK', !netHit && !conHit && !svcHit, { requests: netLog.length, consoleLines: consoleLog.length, serviceLogClean: !svcHit });
    set('NO_PIN_MODULE_PAGE_ERRORS', !(report.pageErrors || []).length, report.pageErrors || []);
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'package899f-after.png') }).catch(() => {});
  } catch (e) {
    set('GATE_EXCEPTION', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    stopService();
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
