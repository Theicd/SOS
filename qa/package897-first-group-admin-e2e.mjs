/**
 * Package 897 — First-group admin control center E2E (LOCAL_CONTROLLED_E2E).
 *
 * Scope honesty:
 *  - Separate browser contexts = separate devices/users (A root, B delegated, C regular, D/E redeemers, X attacker).
 *  - Signed control/membership state moves between users only through explicit export/import of SIGNED events
 *    (FirstGroupAdmin.exportSignedState / importSignedState). This is NOT network-backed propagation.
 *  - Invite events (37378/37379/37380) go through an in-memory Node relay stub shared by all contexts.
 *  - Local static server; runtime-feature-flags.json is served ON for this local run only.
 *    config.js is served with adminSourceKeys = [A] so A is the configured first-group root.
 * Never deploys. Never touches production config.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package897-first-group-admin-e2e-report.json');
const PORT = Number(process.env.SOS_897_PORT || 8797);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const PROD_ROOT = '8c60929899e0009f199b3865a7a5e7ba483fec60ff3c926169d0a4588ada256a';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const report = {
  gate: 'PACKAGE897_FIRST_GROUP_ADMIN_E2E',
  E2E_SCOPE: 'LOCAL_CONTROLLED_E2E',
  NETWORK_BACKED_E2E: false,
  DOUBLE_REDEEM_SCOPE: 'LOCAL_ONLY',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  screenshots: [],
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 260));
};

// ---------------------------------------------------------------- relay stub
const relay = new Map();
function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k[0] !== '#') continue;
    const name = k.slice(1);
    const vals = f[k] || [];
    if (!(ev.tags || []).some((t) => t[0] === name && vals.includes(t[1]))) return false;
  }
  return true;
}
function relayOp(op, arg) {
  if (op === 'publish') {
    if (arg && arg.id) relay.set(arg.id, arg);
    return 'ok';
  }
  if (op === 'query') {
    const f = arg || {};
    const rows = Array.from(relay.values())
      .filter((ev) => matchFilter(ev, f))
      .sort((a, b) => b.created_at - a.created_at);
    return rows.slice(0, f.limit || 500);
  }
  return null;
}

// ---------------------------------------------------------------- server
let ROOT_PUB = '';
function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
  };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/videos.html';
      if (p === '/runtime-feature-flags.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"schema":"sos-feature-flags-v1","accessControlV2":true}');
        return;
      }
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

// ---------------------------------------------------------------- page helpers
const NO_SW_INIT = () => {
  try {
    Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
  } catch (_e) {}
};

async function newUser(browser, label, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.exposeFunction('__qaRelay', (op, arg) => relayOp(op, arg));
  await ctx.addInitScript(NO_SW_INIT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    if (/first-group-admin|group-admin-product-ui/.test(String(e.stack || ''))) {
      (report.pageErrors = report.pageErrors || []).push(label + ': ' + String(e.message).slice(0, 200));
    }
  });
  return { ctx, page, label };
}

async function waitApp(page) {
  await page.waitForFunction(
    () =>
      !!window.NostrApp?.createNewIdentityExplicit &&
      !!window.NostrApp?.FirstGroupAdmin &&
      !!window.NostrApp?.GroupAdminProductUi &&
      window.SosFeatureFlags?.isResolved?.() === true &&
      !!window.NostrApp?.pool,
    { timeout: 120000 }
  );
}

async function installStub(page) {
  return page.evaluate(() => {
    const App = window.NostrApp;
    if (App.pool && App.pool.__qaStub) return true;
    const KINDS = new Set([37378, 37379, 37380, 39001, 39002, 39003]);
    const orig = App.pool;
    const wrap = {
      __qaStub: true,
      publish(relays, ev) {
        if (ev && KINDS.has(ev.kind)) return window.__qaRelay('publish', ev);
        return orig.publish(relays, ev);
      },
      async querySync(relays, filter) {
        if (filter && Array.isArray(filter.kinds) && filter.kinds.length && filter.kinds.every((k) => KINDS.has(k))) {
          return window.__qaRelay('query', filter);
        }
        return orig.querySync(relays, filter);
      },
    };
    App.pool = new Proxy(orig, {
      get(t, p) {
        if (Object.prototype.hasOwnProperty.call(wrap, p)) return wrap[p];
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return !!App.pool.__qaStub;
  });
}

async function boot(page, key) {
  await waitApp(page);
  const pub = await page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    try {
      window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 700));
    return String(c.publicKey || '').toLowerCase();
  }, key.hex);
  await installStub(page);
  await page.evaluate(() => window.NostrApp.FirstGroupAdmin.boot());
  return pub;
}

/** Hard reload; identity must restore from storage (re-boot only if it does not, and record that). */
async function hardReload(u, key) {
  await u.page.reload({ waitUntil: 'domcontentloaded' });
  await waitApp(u.page);
  let restored = false;
  try {
    await u.page.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, key.pub, { timeout: 25000 });
    restored = true;
  } catch (_e) {}
  if (!restored) await boot(u.page, key);
  await u.page.evaluate(() => {
    window.NostrApp.guestMode = false;
  });
  await installStub(u.page);
  await u.page.evaluate(() => window.NostrApp.FirstGroupAdmin.boot());
  await sleep(400);
  return restored;
}

const fga = (page, fn, arg) => page.evaluate(fn, arg);

async function transfer(from, to) {
  const bundle = await from.page.evaluate(() => window.NostrApp.FirstGroupAdmin.exportSignedState());
  return to.page.evaluate((b) => window.NostrApp.FirstGroupAdmin.importSignedState(b), bundle);
}

async function openUi(page, tab) {
  const render = () =>
    page.evaluate((t) => {
      const ui = window.NostrApp.GroupAdminProductUi;
      ui.ensureMenuEntry();
      ui.open(t);
      ui.renderTab(t);
      return document.querySelector('#sosGapTabs button.active')?.dataset.tab || null;
    }, tab);
  let active = await render();
  for (let i = 0; active !== tab && i < 10; i++) {
    await sleep(500);
    active = await render();
  }
  if (active !== tab) {
    (report.openUiDiag = report.openUiDiag || []).push(
      await page.evaluate((t) => {
        const F = window.NostrApp.FirstGroupAdmin;
        const a = F.myAuthority();
        return {
          want: t,
          sections: F.visibleSections(),
          role: a && a.role,
          verified: a && a.verified,
          status: window.NostrApp.GroupControlState.getStatus('israel-network'),
          pk: String(window.NostrApp.publicKey || '').slice(0, 8),
        };
      }, tab)
    );
  }
  await sleep(250);
}

async function clickTab(page, tab) {
  await page.click(`#sosGapTabs button[data-tab="${tab}"]`);
  await sleep(250);
}

async function clearMsg(page) {
  await page.evaluate(() => {
    const m = document.getElementById('sosGapMsg');
    if (m) {
      m.textContent = '';
      m.className = 'gap-msg';
    }
  });
}

async function waitMsg(page) {
  await page.waitForFunction(
    () => {
      const m = document.getElementById('sosGapMsg');
      return !!m && /\b(ok|err)\b/.test(m.className);
    },
    null,
    { timeout: 60000 }
  );
  return page.evaluate(() => {
    const m = document.getElementById('sosGapMsg');
    return { ok: /\bok\b/.test(m.className), text: m.textContent };
  });
}

async function domClick(page, selector) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  await page.$eval(selector, (el) => el.click());
}

async function act(page, selector, { confirm = false } = {}) {
  await clearMsg(page);
  await domClick(page, selector);
  if (confirm) {
    const opened = await page
      .waitForFunction(
        () => document.getElementById('sosGapConfirm')?.classList.contains('is-open') || /\b(ok|err)\b/.test(document.getElementById('sosGapMsg')?.className || ''),
        null,
        { timeout: 15000 }
      )
      .then(() => page.evaluate(() => document.getElementById('sosGapConfirm')?.classList.contains('is-open')));
    if (!opened) {
      const m = await waitMsg(page);
      return { ...m, ok: false, noConfirm: true };
    }
    await domClick(page, '#sosGapConfirmOk');
  }
  return waitMsg(page);
}

async function visibleTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#sosGapTabs button'))
      .filter((b) => !b.hidden && getComputedStyle(b).display !== 'none')
      .map((b) => b.dataset.tab)
  );
}

async function menuVisible(page) {
  return page.evaluate(() => {
    window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
    const el = document.getElementById('sosGroupAdminMenuEntry');
    return !!el && getComputedStyle(el).display !== 'none';
  });
}

async function setCaps(page, targetPub, caps) {
  await openUi(page, 'roles');
  await page.selectOption('#sosGapRoleTarget', targetPub);
  await page.waitForFunction((pk) => document.getElementById('sosGapRoleTarget')?.value === pk, targetPub, { timeout: 10000 });
  await sleep(250);
  const dbg = await page.evaluate((want) => {
    const boxes = Array.from(document.querySelectorAll('#sosGapCaps input[type=checkbox]'));
    boxes.forEach((c) => {
      if (!c.disabled) c.checked = want.includes(c.getAttribute('data-cap'));
    });
    return {
      target: document.getElementById('sosGapRoleTarget')?.value,
      checked: boxes.filter((c) => c.checked).map((c) => c.getAttribute('data-cap')),
      disabled: boxes.filter((c) => c.disabled).map((c) => c.getAttribute('data-cap')),
    };
  }, caps);
  const removing = await page.evaluate(
    ({ pk, want }) => window.NostrApp.FirstGroupAdmin.authorityFor(pk).assigned.some((c) => !want.includes(c)),
    { pk: targetPub, want: caps }
  );
  const r = await act(page, '#sosGroupAdminShell [data-act="save-perms"]', { confirm: removing });
  if (!r.ok) (report.setCapsDebug = report.setCapsDebug || []).push({ caps, removing, dbg, r });
  return r;
}

async function createInviteUi(page) {
  await openUi(page, 'invites');
  const r = await act(page, '#sosGroupAdminShell [data-act="create-invite"]');
  const url = await page.evaluate(() => (document.getElementById('sosGapInviteUrl') || {}).value || '');
  const code = url ? new URL(url).searchParams.get('invite') : '';
  return { r, url, code };
}

async function redeem(u, code, inviterPub) {
  return u.page.evaluate(
    async ({ code, inviter }) => {
      const App = window.NostrApp;
      const v = await App.validateInvite({ code });
      if (!v.ok) return { ok: false, stage: 'validate', error: v.error, code: v.code };
      const tags = (v.inviteEvent.tags || []).filter((t) => t[0] === 't').map((t) => t[1]);
      const m = await App.markInviteUsed({ code, inviterPubkey: inviter, inviteEventId: v.inviteEvent.id });
      return { ok: !!m.ok, stage: 'mark', inviteEventId: v.inviteEvent.id, tTags: tags, markError: m.error };
    },
    { code, inviter: inviterPub }
  );
}

async function approveViaUi(page, memberPub) {
  await openUi(page, 'members');
  await page.click('#sosGroupAdminShell [data-act="load-joins"]');
  await page.waitForSelector(`#sosGapJoinList [data-pk="${memberPub}"]`, { timeout: 20000 });
  return act(page, `#sosGapJoinList [data-pk="${memberPub}"]`, { confirm: true });
}

function makePng(w, h, rgb) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function decodeQrDataUrl(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return res ? res.data : '';
}

/** Build an unsigned control draft in-page from the verified tip with an arbitrary patch, sign it in Node with any key. */
async function forgeControlEvent(page, signerKey, patchFn) {
  const draft = await page.evaluate(
    ({ patchSrc, pub }) => {
      const G = window.NostrApp.GroupControlState;
      const st = G.getVerifiedControlState('israel-network');
      const rec = JSON.parse(G.serializeRecord(st));
      // eslint-disable-next-line no-new-func
      const patched = new Function('r', patchSrc)(rec) || rec;
      patched.createdAt = Math.floor(Date.now() / 1000);
      const record = G.parseAndValidateRecord(G.serializeRecord(patched));
      return G.buildSignDraft(record, pub);
    },
    { patchSrc: patchFn, pub: signerKey.pub }
  );
  return finalizeEvent({ kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content }, signerKey.sk);
}

// ---------------------------------------------------------------- main flow
async function main() {
  const A = mkKey();
  const B = mkKey();
  const C = mkKey();
  const D = mkKey();
  const E = mkKey();
  const X = mkKey();
  ROOT_PUB = A.pub;
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
  });
  const shot = async (page, name) => {
    const file = path.join(ROOT, 'qa', `package897-${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    report.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  };
  try {
    const ua = await newUser(browser, 'A');
    const ub = await newUser(browser, 'B');
    const uc = await newUser(browser, 'C');
    const ux = await newUser(browser, 'X');
    for (const u of [ua, ub, uc, ux]) await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const pubA = await boot(ua.page, A);
    await boot(ub.page, B);
    await boot(uc.page, C);
    await boot(ux.page, X);
    set('IDENTITIES_BOOTED', pubA === A.pub, { a: pubA.slice(0, 8) });

    // ---- Step 1: first-group context
    const ctx1 = await fga(ua.page, () => {
      const F = window.NostrApp.FirstGroupAdmin;
      return {
        id: F.FIRST_GROUP_ID,
        source: F.FIRST_GROUP_SOURCE,
        model: F.FIRST_GROUP_AUTHORITY_MODEL,
        ctx: F.contextCheck(),
        mismatch: F.contextCheck('community-other'),
        v2: window.SOS_ACCESS_CONTROL_V2 === true,
        configuredRoot: F.isConfiguredRoot(window.NostrApp.publicKey),
      };
    });
    report.FIRST_GROUP_ID = ctx1.id;
    report.FIRST_GROUP_SOURCE = ctx1.source;
    report.FIRST_GROUP_AUTHORITY_MODEL = ctx1.model;
    set('FIRST_GROUP_CONTEXT', ctx1.id === 'israel-network' && ctx1.ctx.ok && ctx1.v2 && ctx1.configuredRoot, ctx1.ctx);
    set('NO_AMBIGUOUS_ADMIN_GROUP_CONTEXT', ctx1.mismatch.code === 'FIRST_GROUP_CONTEXT_MISMATCH');

    // ---- Root binding: attacker cannot become first-group root
    const xBoot = await fga(ux.page, () => window.NostrApp.FirstGroupAdmin.bootstrapFirstGroup({}));
    const xForged = await fga(ux.page, async () => {
      const G = window.NostrApp.GroupControlState;
      const rec = G.buildBootstrapRecord({ groupId: 'israel-network', rootAdminPubkey: window.NostrApp.publicKey, creatorPubkey: window.NostrApp.publicKey, displayName: 'EVIL', invitePolicy: 'EVERYONE' });
      let ev = null;
      try {
        ev = await G.signControlRecord(rec);
      } catch (e) {
        return { signed: false, code: e.code || e.message };
      }
      const acc = G.acceptControlEvent(ev, { groupId: 'israel-network', persist: false });
      return { signed: true, acc: { ok: acc.ok, code: acc.code }, ev };
    });
    set('ATTACKER_BOOTSTRAP_REJECTED', xBoot.code === 'FIRST_GROUP_ROOT_NOT_CONFIGURED' && (!xForged.signed || xForged.acc.ok === false), { xBoot: xBoot.code, forged: xForged.acc || xForged.code });

    // ---- Step 2/3: A bootstraps via UI, dashboard sections
    set('ROOT_SEES_ADMIN_ENTRY_BEFORE_BOOTSTRAP', await menuVisible(ua.page));
    await openUi(ua.page, 'home');
    const boot1 = await act(ua.page, '#sosGroupAdminShell [data-act="bootstrap"]');
    const aAuth = await fga(ua.page, () => window.NostrApp.FirstGroupAdmin.myAuthority());
    set('FIRST_GROUP_BOOTSTRAP_BY_CONFIGURED_ROOT', boot1.ok && aAuth.isRoot && aAuth.verified, boot1.text);
    if (xForged.ev) {
      const cross = await fga(ua.page, (ev) => {
        const G = window.NostrApp.GroupControlState;
        const r = G.ingestControlEvents([ev], { groupId: 'israel-network' });
        return { r, status: G.getStatus('israel-network'), root: G.getVerifiedControlState('israel-network').rootAdminPubkey };
      }, xForged.ev);
      set('FORGED_ROOT_BOOTSTRAP_NO_CONFLICT_ON_HONEST_PEER', cross.status === 'VERIFIED' && cross.root === A.pub, cross.status);
    }
    await openUi(ua.page, 'home');
    const aTabs = await visibleTabs(ua.page);
    const allTabs = ['home', 'details', 'members', 'admins', 'roles', 'invites', 'qr', 'settings', 'security'];
    set('ADMIN_ENTRY_LABEL', await ua.page.evaluate(() => document.getElementById('sosGroupAdminMenuEntry')?.textContent === 'ניהול קבוצה'));
    set('DASHBOARD_SECTIONS_FULL_ADMIN', allTabs.every((t) => aTabs.includes(t)), aTabs);

    // ---- Join B and C via invite -> redeem -> approve (step 19)
    const inv1 = await createInviteUi(ua.page);
    set('INVITE_CREATE_IN_ADMIN_PAGE', inv1.r.ok && /^[A-Z0-9]{6,16}$/.test(inv1.code || ''), inv1.r.text);
    await openUi(ua.page, 'invites');
    const copy = await act(ua.page, '#sosGroupAdminShell [data-act="copy-invite"]');
    const copied = await ua.page.evaluate(() => window.__SOS_GAP_LAST_COPIED__ || '');
    set('INVITE_COPY_IN_ADMIN_PAGE', copy.ok && copied === inv1.url, copy.text);
    await transfer(ua, ub);
    const rB = await redeem(ub, inv1.code, A.pub);
    set('INVITE_VALIDATE_REDEEM', rB.ok && rB.tTags.includes('israel-network'), rB);
    const apB = await approveViaUi(ua.page, B.pub);
    set('JOIN_APPROVAL_UI', apB.ok, apB.text);
    const inv2 = await createInviteUi(ua.page);
    await transfer(ua, uc);
    const rC = await redeem(uc, inv2.code, A.pub);
    const apC = rC.ok ? await approveViaUi(ua.page, C.pub) : { ok: false };
    set('SECOND_MEMBER_JOIN', rC.ok && apC.ok, { rC: rC.stage, ap: apC.text });
    for (const u of [ub, uc, ux]) await transfer(ua, u);
    const memStates = await fga(ub.page, ({ b, c }) => ({
      b: window.NostrApp.MembershipState.getMemberState(b),
      c: window.NostrApp.MembershipState.getMemberState(c),
    }), { b: B.pub, c: C.pub });
    set('MEMBERSHIP_ACTIVE_AFTER_APPROVAL', memStates.b === 'ACTIVE' && memStates.c === 'ACTIVE', memStates);
    set('REGULAR_MEMBER_NO_ADMIN_MENU', !(await menuVisible(uc.page)) && !(await menuVisible(ub.page)));

    // ---- Step 4: metadata edit + reload
    await openUi(ua.page, 'details');
    const pngPath = path.join(ROOT, 'qa', '.package897-logo.png');
    fs.writeFileSync(pngPath, makePng(96, 96, [220, 40, 60]));
    await ua.page.fill('#sosGapName', 'קבוצת SOS הראשית');
    await ua.page.fill('#sosGapDesc', 'תיאור קבוצה לבדיקה 897');
    await ua.page.setInputFiles('#sosGapLogoFile', pngPath);
    await ua.page.waitForFunction(() => !!window.__SOS_GAP_LOGO_DATA__, null, { timeout: 15000 });
    const saveMeta = await act(ua.page, '#sosGroupAdminShell [data-act="save-details"]');
    const restoredA1 = await hardReload(ua, A);
    await openUi(ua.page, 'details');
    const metaView = await ua.page.evaluate(() => ({
      name: document.getElementById('sosGapViewName')?.textContent,
      desc: document.getElementById('sosGapViewDesc')?.textContent,
      logo: !!document.getElementById('sosGapViewLogo'),
      title: document.getElementById('sosGapTitle')?.textContent,
    }));
    set('GROUP_METADATA_EDIT', saveMeta.ok, saveMeta.text);
    set('GROUP_METADATA_PERSISTS_RELOAD', metaView.name === 'קבוצת SOS הראשית' && metaView.desc === 'תיאור קבוצה לבדיקה 897' && metaView.logo, { ...metaView, restoredA1 });
    report.IDENTITY_AUTO_RESTORE_ON_RELOAD = restoredA1;

    // ---- Step 5: member directory
    await openUi(ua.page, 'members');
    await ua.page.fill('#sosGapSearch', B.pub.slice(0, 10));
    await sleep(200);
    const searchRows = await ua.page.evaluate(() => document.querySelectorAll('#sosGapMemberList [data-member]').length);
    await ua.page.click(`#sosGapMemberList [data-act="select-member"][data-pk="${B.pub}"]`);
    await sleep(200);
    const detail = await ua.page.evaluate(() => document.getElementById('sosGapMemberDetail')?.innerText || '');
    const dir = await fga(ua.page, () => window.NostrApp.FirstGroupAdmin.directory('').map((r) => ({ pk: r.pubkey.slice(0, 8), role: r.role, status: r.status })));
    set('MEMBER_DIRECTORY', dir.length >= 3 && searchRows === 1 && detail.includes(B.pub) && /חבר/.test(detail), { dir, searchRows });

    // ---- Step 13 / 37: A grants B INVITE only
    const g1 = await setCaps(ua.page, B.pub, ['INVITE_USERS']);
    set('GRANT_INVITE_ONLY_UI', g1.ok, g1.text);
    await transfer(ua, ub);
    await hardReload(ub, B);
    const bAuth1 = await fga(ub.page, () => {
      const F = window.NostrApp.FirstGroupAdmin;
      return { a: F.myAuthority(), s: F.visibleSections() };
    });
    await openUi(ub.page, 'home');
    const bTabs1 = await visibleTabs(ub.page);
    set('INVITER_ROLE_EXACT', bAuth1.a.role === 'INVITER' && bAuth1.a.caps.join() === 'INVITE_USERS', bAuth1.a.caps);
    set('INVITER_LIMITED_SURFACE', (await menuVisible(ub.page)) && bTabs1.includes('invites') && bTabs1.includes('qr') && !bTabs1.some((t) => ['members', 'admins', 'roles', 'settings', 'security', 'details'].includes(t)), bTabs1);
    const invB = await createInviteUi(ub.page);
    await openUi(ub.page, 'invites');
    const copyB = await act(ub.page, '#sosGroupAdminShell [data-act="copy-invite"]');
    await ub.page.click('#sosGroupAdminShell [data-act="show-qr"]');
    await sleep(600);
    const qrB = await ub.page.evaluate(() => document.getElementById('sosGapQrCanvas')?.toDataURL('image/png') || '');
    const qrBText = qrB ? decodeQrDataUrl(qrB) : '';
    set('INVITER_CREATE_COPY_QR', invB.r.ok && copyB.ok && qrBText === invB.url, { code: invB.code, qr: !!qrBText });
    const bDirect = await fga(ub.page, async ({ c, b }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const out = {};
      out.grantOther = (await F.grantCapability(c, 'INVITE_USERS')).code;
      out.selfPerms = (await F.setPermissions(b, ['INVITE_USERS', 'MANAGE_ADMINS'])).code;
      out.meta = (await F.updateMetadata({ displayName: 'hack' })).code;
      out.remove = (await F.removeMember(c)).code;
      out.promote = (await F.promoteAdmin(c)).code;
      out.mutDirect = (await App.GroupControlMutations.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: b, capability: 'MANAGE_MEMBERS' }, b)).code;
      out.maoDirect = (await App.MemberAdminOperations.removeMember(c, b)).code;
      const AC = App.AccessControl;
      AC.installQaAuthorityOverlay({ capabilitiesByPubkey: { [b]: ['MANAGE_ADMINS', 'MANAGE_PERMISSIONS', 'MANAGE_MEMBERS'] } });
      out.overlayMut = (await App.GroupControlMutations.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: c, capability: 'MANAGE_MEMBERS' }, b)).code;
      out.overlayMao = (await App.MemberAdminOperations.removeMember(c, b)).code;
      out.overlayFga = (await F.grantCapability(c, 'INVITE_USERS')).code;
      out.overlayUiRoles = F.visibleSections().roles;
      AC.installQaAuthorityOverlay(null);
      App.GroupAdminProductUi.open('roles');
      out.uiRolesTabOpened = document.querySelector('#sosGapTabs button.active')?.dataset.tab;
      out.epoch = App.GroupControlState.getVerifiedControlState('israel-network').controlEpoch;
      return out;
    }, { c: C.pub, b: B.pub });
    const aEpoch1 = await fga(ua.page, () => window.NostrApp.GroupControlState.getVerifiedControlState('israel-network').controlEpoch);
    set(
      'INVITER_NO_ADMIN_POWERS',
      ['grantOther', 'selfPerms', 'meta', 'remove', 'promote', 'mutDirect', 'maoDirect', 'overlayMut', 'overlayMao', 'overlayFga'].every((k) => bDirect[k] && bDirect[k] !== 'APPLIED' && bDirect[k] !== 'REMOVED' && bDirect[k] !== 'SAVED') &&
        bDirect.overlayUiRoles === false &&
        bDirect.uiRolesTabOpened !== 'roles' &&
        bDirect.epoch === aEpoch1,
      bDirect
    );

    // ---- Step 23 / 37: A grants moderation
    const g2 = await setCaps(ua.page, B.pub, ['INVITE_USERS', 'MODERATE_CONTENT']);
    await transfer(ua, ub);
    const mod1 = await fga(ub.page, ({ a, c }) => {
      const MP = window.NostrApp.ModerationPolicy || window.SosModerationPolicy;
      return {
        onMember: MP.canModerateContent(window.NostrApp.publicKey, c, 1).code,
        onRoot: MP.canModerateContent(window.NostrApp.publicKey, a, 1).code,
        role: window.NostrApp.FirstGroupAdmin.myAuthority().role,
        sections: window.NostrApp.FirstGroupAdmin.visibleSections(),
      };
    }, { a: A.pub, c: C.pub });
    const modC = await fga(uc.page, (b) => (window.NostrApp.ModerationPolicy || window.SosModerationPolicy).canModerateContent(window.NostrApp.publicKey, b, 1).code, B.pub);
    set('GRANT_MODERATION_UI', g2.ok, g2.text);
    set('DELEGATED_MODERATOR', mod1.onMember === 'MODERATE_CONTENT' && mod1.onRoot === 'ROOT_CONTENT_PROTECTED' && modC === 'NO_MODERATE_CAP' && mod1.role === 'MODERATOR' && !mod1.sections.roles, { mod1: { onMember: mod1.onMember, onRoot: mod1.onRoot, role: mod1.role }, modC });

    // B second tab (same profile) for stale-tab checks later
    const bTab2 = await ub.ctx.newPage();
    await bTab2.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(bTab2);
    await bTab2.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, B.pub, { timeout: 30000 }).catch(() => {});
    await bTab2.evaluate(() => {
      window.NostrApp.guestMode = false;
      window.NostrApp.FirstGroupAdmin.boot();
    });
    await installStub(bTab2);

    // ---- Step 8 / 37: A promotes B (הוספת מנהל)
    await openUi(ua.page, 'admins');
    await ua.page.selectOption('#sosGapPromoteSel', B.pub);
    const promo = await act(ua.page, '#sosGroupAdminShell [data-act="promote"]', { confirm: true });
    const bAfterPromo = await fga(ua.page, (b) => window.NostrApp.FirstGroupAdmin.authorityFor(b), B.pub);
    const adminList = await ua.page.evaluate(() => Array.from(document.querySelectorAll('#sosGapAdminList [data-admin]')).map((e) => e.getAttribute('data-admin')));
    set('PROMOTE_ADMIN_UI', promo.ok && bAfterPromo.role === 'ADMIN' && bAfterPromo.caps.includes('MANAGE_MEMBERS'), { text: promo.text, caps: bAfterPromo.caps });
    await openUi(ua.page, 'admins');
    const adminList2 = await ua.page.evaluate(() => Array.from(document.querySelectorAll('#sosGapAdminList [data-admin]')).map((e) => e.getAttribute('data-admin')));
    set('ADMIN_LIST', adminList2.includes(A.pub) && adminList2.includes(B.pub) && !adminList2.includes(C.pub), { n: adminList2.length, before: adminList.length });
    await transfer(ua, ub);
    await hardReload(ub, B);
    await openUi(ub.page, 'home');
    const bTabs2 = await visibleTabs(ub.page);
    set('PROMOTED_ADMIN_UI_MATCHES_AUTHORITY', bTabs2.includes('members') && !bTabs2.includes('roles') && !bTabs2.includes('admins'), bTabs2);

    // ---- Step 12 / 37: A removes one capability (MODERATE_CONTENT)
    const g3 = await setCaps(ua.page, B.pub, ['INVITE_USERS', 'MANAGE_MEMBERS']);
    await transfer(ua, ub);
    const mod2 = await fga(ub.page, (c) => (window.NostrApp.ModerationPolicy || window.SosModerationPolicy).canModerateContent(window.NostrApp.publicKey, c, 1).code, C.pub);
    set('REMOVE_ONE_CAPABILITY', g3.ok && mod2 === 'NO_MODERATE_CAP', { text: g3.text, mod2 });

    // ---- Step 9 / 37: A demotes B (הסרת מנהל); stale tab must have no authority
    await openUi(ua.page, 'admins');
    const demote = await act(ua.page, `#sosGapAdminList [data-act="demote"][data-pk="${B.pub}"]`, { confirm: true });
    const bAfterDemote = await fga(ua.page, (b) => window.NostrApp.FirstGroupAdmin.authorityFor(b), B.pub);
    set('DEMOTE_ADMIN_UI', demote.ok && !bAfterDemote.caps.includes('MANAGE_MEMBERS') && bAfterDemote.role === 'INVITER', { text: demote.text, caps: bAfterDemote.caps });

    // Cross-device staleness: B has not received the demotion; its locally-signed removal must be rejected by A.
    const staleDevice = await fga(ub.page, async (c) => {
      const F = window.NostrApp.FirstGroupAdmin;
      const r = await F.removeMember(c);
      const ev = r && r.phase1 && r.phase1.event ? r.phase1.event : null;
      return { code: r.code, ev };
    }, C.pub);
    let staleRejected = true;
    if (staleDevice.ev) {
      const onA = await fga(ua.page, ({ ev, c }) => {
        const MS = window.NostrApp.MembershipState;
        const res = MS.ingestMembershipEvents([ev]);
        return { res, st: MS.getMemberState(c) };
      }, { ev: staleDevice.ev, c: C.pub });
      staleRejected = onA.st === 'ACTIVE';
      report.STALE_DEVICE_IMPORT = onA;
    }
    report.CROSS_DEVICE_STALE_LOCAL_RESULT = staleDevice.code;
    set('STALE_DEVICE_ACTION_REJECTED_BY_AUTHORITATIVE_PEER', staleRejected, { local: staleDevice.code });
    // Same-profile stale tab: tab1 imports demotion, tab2 (never reloaded) must fail.
    await transfer(ua, ub);
    const staleTab = await bTab2.evaluate(async (c) => {
      const F = window.NostrApp.FirstGroupAdmin;
      return { remove: (await F.removeMember(c)).code, role: F.myAuthority().role };
    }, C.pub);
    set('STALE_TAB_NO_AUTHORITY_AFTER_DEMOTE', staleTab.remove === 'UNAUTHORIZED' && staleTab.role === 'INVITER', staleTab);
    await bTab2.close();

    // ---- Step 6 / 33 / 37: A removes C (with cancel first)
    await openUi(ua.page, 'members');
    await ua.page.click(`#sosGapMemberList [data-act="select-member"][data-pk="${C.pub}"]`);
    await sleep(200);
    await ua.page.click('#sosGroupAdminShell [data-act="remove-member"]');
    await ua.page.waitForSelector('#sosGapConfirm.is-open');
    await ua.page.click('#sosGapConfirmCancel');
    await sleep(300);
    const afterCancel = await fga(ua.page, (c) => window.NostrApp.MembershipState.getMemberState(c), C.pub);
    await ua.page.click(`#sosGapMemberList [data-act="select-member"][data-pk="${C.pub}"]`).catch(() => {});
    await sleep(200);
    const rem = await act(ua.page, '#sosGroupAdminShell [data-act="remove-member"]', { confirm: true });
    const cState = await fga(ua.page, (c) => window.NostrApp.MembershipState.getMemberState(c), C.pub);
    set('CONFIRMATION_CANCEL_KEEPS_STATE', afterCancel === 'ACTIVE');
    set('REMOVE_MEMBER_UI', rem.ok && cState === 'REMOVED', { text: rem.text, cState });
    await transfer(ua, uc);
    const cAfter = await fga(uc.page, async ({ b }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      let inv;
      try {
        await App.createInvite();
        inv = 'CREATED';
      } catch (e) {
        inv = 'DENIED';
      }
      return {
        status: App.MembershipState.getMemberState(App.publicKey),
        menu: App.GroupAdminProductUi.canSeeGroupAdminMenu(),
        grant: (await F.grantCapability(b, 'INVITE_USERS')).code,
        invite: inv,
        moderate: (App.ModerationPolicy || window.SosModerationPolicy).canModerateContent(App.publicKey, b, 1).code,
      };
    }, { b: B.pub });
    set('REMOVED_MEMBER_PRIVILEGED_ACTIONS_FAIL', cAfter.status === 'REMOVED' && !cAfter.menu && cAfter.grant !== 'APPLIED' && cAfter.invite === 'DENIED', cAfter);

    // ---- Steps 16-18 / 37: A creates invite with QR render/scan/parse; D redeems
    const inv3 = await createInviteUi(ua.page);
    await openUi(ua.page, 'invites');
    await ua.page.click('#sosGroupAdminShell [data-act="show-qr"]');
    await ua.page.waitForSelector('#sosGapQrCanvas', { timeout: 10000 });
    await sleep(600);
    const qrData = await ua.page.evaluate(() => document.getElementById('sosGapQrCanvas').toDataURL('image/png'));
    const qrText = decodeQrDataUrl(qrData);
    const secretHits = [A.hex, B.hex, C.hex, X.hex].filter((k) => qrText.includes(k)).length;
    const qrSecretScan = !/nsec1|[0-9a-f]{64}|priv|secret|seed/i.test(qrText) && secretHits === 0;
    set('QR_RENDER_FROM_CANONICAL_INVITE', qrText === inv3.url, { qrText });
    set('QR_SECRET_SCAN', qrSecretScan, { len: qrText.length });
    const parsed = await fga(ua.page, (t) => window.NostrApp.FirstGroupAdmin.parseInviteQr(t), qrText);
    const legacyParsed = await fga(ua.page, (t) => window.NostrApp.extractInviteCodeFromQrText(t), qrText);
    const ud = await newUser(browser, 'D');
    await ud.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await boot(ud.page, D);
    await transfer(ua, ud);
    const rD = await redeem(ud, parsed.code, A.pub);
    set('QR_SCAN_PARSE_BINDS_GROUP', parsed.ok && parsed.code === inv3.code && legacyParsed === inv3.code && rD.ok && rD.tTags.includes('israel-network'), { parsed, rD: rD.stage });
    const apD = await approveViaUi(ua.page, D.pub);
    set('QR_INVITE_JOIN_APPROVED', apD.ok, apD.text);

    // ---- Step 22: double redeem (LOCAL_ONLY)
    const ue = await newUser(browser, 'E');
    await ue.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await boot(ue.page, E);
    await transfer(ua, ue);
    const dAgain = await fga(ud.page, async (code) => (await window.NostrApp.validateInvite({ code })), inv3.code);
    const eSame = await fga(ue.page, async (code) => (await window.NostrApp.validateInvite({ code })), inv3.code);
    set('DOUBLE_REDEEM_REJECTED', !dAgain.ok && !eSame.ok, { d: dAgain.error, e: eSame.error, scope: 'LOCAL_ONLY' });

    // ---- Step 20: revoke via UI
    const inv4 = await createInviteUi(ua.page);
    await openUi(ua.page, 'invites');
    const idx = await ua.page.evaluate((code) => window.NostrApp.FirstGroupAdmin.listMyInvites().findIndex((r) => r.code === code), inv4.code);
    const rev = await act(ua.page, `#sosGapInviteList [data-act="revoke-invite"][data-idx="${idx}"]`, { confirm: true });
    const eRev = await fga(ue.page, async (code) => (await window.NostrApp.validateInvite({ code })), inv4.code);
    set('INVITE_REVOKE', rev.ok && !eRev.ok && eRev.code === 'REVOKED', { text: rev.text, e: eRev.code });

    // ---- Step 21: expired invite
    const expired = await fga(ua.page, async () => {
      const App = window.NostrApp;
      const prev = App.INVITE_TTL_SECONDS;
      App.INVITE_TTL_SECONDS = -120;
      const r = await App.FirstGroupAdmin.createInvite();
      App.INVITE_TTL_SECONDS = prev;
      return r.ok ? r.invite.code : '';
    });
    const eExp = await fga(ue.page, async (code) => (await window.NostrApp.validateInvite({ code })), expired);
    set('INVITE_EXPIRED_REJECTED', !!expired && !eExp.ok && /תוקף/.test(eExp.error || ''), { e: eExp.error });

    // ---- Step 39: QR adversarial
    const qrAdv = await fga(ua.page, ({ port, h }) => {
      const F = window.NostrApp.FirstGroupAdmin;
      const base = `http://127.0.0.1:${port}/videos.html`;
      const cases = {
        nsec: 'nsec1' + 'q'.repeat(58),
        hexKey: h,
        foreign: 'https://evil.example/videos.html?invite=ABCDEFGH',
        extraParam: base + '?invite=ABCDEFGH&k=' + h,
        secretParam: base + '?invite=ABCDEFGH&secret=1',
        js: 'javascript:alert(1)',
        fragment: base + '?invite=ABCDEFGH#nsec',
        badCode: base + '?invite=AB<script>',
        tooLong: base + '?invite=' + 'A'.repeat(600),
        dataUrl: 'data:text/html,<script>alert(1)</script>',
      };
      const out = {};
      Object.keys(cases).forEach((k) => {
        out[k] = F.parseInviteQr(cases[k]).code;
      });
      out.payloadSecret = F.qrPayloadForInvite(base + '?invite=ABCDEFGH&nsec=' + h).code;
      out.okCase = F.parseInviteQr(base + '?invite=ABCDEFGH').ok;
      return out;
    }, { port: PORT, h: X.hex });
    const advOk = Object.entries(qrAdv).every(([k, v]) => (k === 'okCase' ? v === true : typeof v === 'string' && v.startsWith('QR_')));
    // Cross-group invite (valid signature, wrong network tag) must not bind to the first group
    const crossInv = await fga(ua.page, async () => {
      const App = window.NostrApp;
      const P = App.InvitePolicy;
      const code = 'CROSSGRP' + Math.floor(Math.random() * 90 + 10);
      const ih = await P.sha256Hex(code);
      const ev = await App.SosCryptoSigner.signInviteEvent({
        kind: 37378,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'sos-invite'], ['t', 'community-other'], ['ih', ih], ['expiration', String(Math.floor(Date.now() / 1000) + 3600)]],
        content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
        pubkey: App.publicKey,
      });
      await App.pool.publish(App.relayUrls, ev);
      return code;
    });
    const eCross = await fga(ue.page, async (code) => (await window.NostrApp.validateInvite({ code })), crossInv);
    set('QR_ADVERSARIAL', advOk && !eCross.ok, { qrAdv, cross: eCross.error || eCross.code });

    // ---- Step 26 / 38: forged authority on attacker X (non-member) and forged events
    await transfer(ua, ux);
    const xAdv = await fga(ux.page, async ({ x, b, a }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const out = {};
      App.isAdmin = true;
      try {
        App.adminPublicKeys.add(x);
      } catch (_e) {}
      try {
        App.adminSourceKeys.push(x);
      } catch (_e) {}
      App.AccessControl.installQaAuthorityOverlay({ capabilitiesByPubkey: { [x]: ['ROOT_ADMIN', 'MANAGE_ADMINS', 'MANAGE_PERMISSIONS', 'MANAGE_MEMBERS'] } });
      out.configuredRootAfterForge = F.isConfiguredRoot(x);
      out.menu = App.GroupAdminProductUi.canSeeGroupAdminMenu();
      const btn = document.getElementById('sosGroupAdminMenuEntry');
      if (btn) {
        btn.style.display = 'inline-flex';
        btn.click();
      }
      out.shellOpenAfterForcedClick = App.GroupAdminProductUi.isOpen();
      out.grant = (await F.grantCapability(x, 'INVITE_USERS')).code;
      out.promoteSelf = (await F.promoteAdmin(x)).code;
      out.demoteB = (await F.demoteAdmin(b)).code;
      out.meta = (await F.updateMetadata({ displayName: 'pwned' })).code;
      out.removeB = (await F.removeMember(b)).code;
      out.policy = (await F.setInvitePolicy('EVERYONE')).code;
      out.mutRevokeRoot = (await App.GroupControlMutations.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: x, capability: 'MANAGE_ADMINS' }, x)).code;
      out.mutAsRoot = (await App.GroupControlMutations.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: x, capability: 'INVITE_USERS' }, a)).code;
      out.bootstrap = (await F.bootstrapFirstGroup({})).code;
      // forged membership (unsigned) in shared cache
      try {
        const k = 'sos_membership_v2_israel-network';
        const cur = JSON.parse(localStorage.getItem(k) || '{"v":2,"rows":[]}');
        cur.rows.push({ event: { id: 'f'.repeat(64), kind: 39003, pubkey: a, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'israel-network:' + x], ['p', x], ['status', 'ACTIVE']], content: JSON.stringify({ memberPubkey: x, status: 'ACTIVE' }), sig: '0'.repeat(128) } });
        localStorage.setItem(k, JSON.stringify(cur));
      } catch (_e) {}
      F.sync();
      out.memberAfterForgedCache = App.MembershipState.getMemberState(x);
      out.authority = F.myAuthority();
      App.AccessControl.installQaAuthorityOverlay(null);
      return out;
    }, { x: X.pub, b: B.pub, a: A.pub });
    const denied = (v) => typeof v === 'string' && !['APPLIED', 'SAVED', 'REMOVED', 'BOOTSTRAPPED'].includes(v);
    set(
      'FORGED_ISADMIN_ROLE_OVERLAY_DOM_REJECTED',
      !xAdv.configuredRootAfterForge && !xAdv.menu && !xAdv.shellOpenAfterForcedClick && ['grant', 'promoteSelf', 'demoteB', 'meta', 'removeB', 'policy', 'mutRevokeRoot', 'mutAsRoot', 'bootstrap'].every((k) => denied(xAdv[k])) && xAdv.authority.caps.length === 0,
      xAdv
    );
    set('FORGED_MEMBERSHIP_CACHE_REJECTED', xAdv.memberAfterForgedCache !== 'ACTIVE', xAdv.memberAfterForgedCache);
    // forged selected group on A (real root): switch active community -> ops must refuse
    const ctxForge = await fga(ua.page, async () => {
      const App = window.NostrApp;
      const CC = App.CommunityContext;
      const out = {};
      try {
        CC.register({ communityId: 'fake897', networkTag: 'community-fake897', groupId: 'community-fake897', slug: 'fake897', name: 'Fake' });
        CC.setActive('fake897');
        out.switched = CC.snapshot().networkTag;
      } catch (e) {
        out.switched = 'REGISTER_FAILED:' + (e.code || e.message);
      }
      out.meta = (await App.FirstGroupAdmin.updateMetadata({ displayName: 'wrong group' })).code;
      out.menu = App.GroupAdminProductUi.canSeeGroupAdminMenu();
      try {
        CC.setActive('sos010');
      } catch (_e) {}
      out.back = CC.snapshot().networkTag;
      return out;
    });
    set('FORGED_SELECTED_GROUP_REJECTED', (ctxForge.switched !== 'community-fake897' || (ctxForge.meta === 'FIRST_GROUP_CONTEXT_MISMATCH' && !ctxForge.menu)) && ctxForge.back === 'israel-network', ctxForge);
    // forged capability events: X self-grant at next epoch; B (inviter) self-escalation; replay
    const tipBefore = await fga(ua.page, () => {
      const G = window.NostrApp.GroupControlState;
      const s = G.getVerifiedControlState('israel-network');
      return { epoch: s.controlEpoch, id: s.eventId };
    });
    const forgedX = await forgeControlEvent(ua.page, X, `r.controlEpoch += 1; r.capabilities['${X.pub}'] = ['MANAGE_ADMINS']; return r;`);
    const forgedB = await forgeControlEvent(ua.page, B, `r.controlEpoch += 1; r.capabilities['${B.pub}'] = ['INVITE_USERS','MANAGE_MEMBERS']; return r;`);
    const forgedRoot = await forgeControlEvent(ua.page, X, `r.controlEpoch += 1; r.rootAdminPubkey = '${X.pub}'; return r;`);
    const replay = await fga(ua.page, () => window.NostrApp.FirstGroupAdmin.exportSignedState().control);
    const forgedRes = await fga(ua.page, ({ evs, replay }) => {
      const G = window.NostrApp.GroupControlState;
      const r = G.ingestControlEvents(evs.concat(replay), { groupId: 'israel-network' });
      const s = G.getVerifiedControlState('israel-network');
      return { status: G.getStatus('israel-network'), epoch: s.controlEpoch, id: s.eventId, codes: r.map((x) => x.code) };
    }, { evs: [forgedX, forgedB, forgedRoot], replay });
    set('FORGED_CAPABILITY_EVENTS_REJECTED', forgedRes.status === 'VERIFIED' && forgedRes.epoch === tipBefore.epoch && forgedRes.id === tipBefore.id, forgedRes);
    // forged control event in shared localStorage cache (X device) -> sync must not apply it
    const xCache = await fga(ux.page, (ev) => {
      const k = 'sos_group_control_v1_israel-network';
      const cur = JSON.parse(localStorage.getItem(k) || '{"v":2,"rows":[]}');
      cur.rows.push({ event: ev });
      localStorage.setItem(k, JSON.stringify(cur));
      const F = window.NostrApp.FirstGroupAdmin;
      F.sync();
      return { caps: F.myAuthority().caps, status: window.NostrApp.GroupControlState.getStatus('israel-network') };
    }, forgedX);
    set('FORGED_CACHE_CONTROL_EVENT_REJECTED', xCache.caps.length === 0 && xCache.status === 'VERIFIED', xCache);

    // ---- Steps 14/15: MANAGE_ADMINS / MANAGE_PERMISSIONS semantics (B as permission manager, D as target)
    const gPerm = await setCaps(ua.page, B.pub, ['INVITE_USERS', 'MANAGE_PERMISSIONS']);
    await transfer(ua, ub);
    const sem = await fga(ub.page, async ({ d, b, a }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const out = {};
      out.grantDelegable = (await F.grantCapability(d, 'INVITE_USERS')).code;
      out.grantManageAdmins = (await F.grantCapability(d, 'MANAGE_ADMINS')).code;
      out.grantManagePerms = (await F.grantCapability(d, 'MANAGE_PERMISSIONS')).code;
      out.selfGrant = (await F.grantCapability(b, 'MODERATE_CONTENT')).code;
      out.selfSetPerms = (await F.setPermissions(b, ['INVITE_USERS', 'MANAGE_PERMISSIONS', 'MANAGE_MEMBERS'])).code;
      out.mutSelf = (await App.GroupControlMutations.applyControlMutation({ type: 'GRANT_CAPABILITY', targetPubkey: b, capability: 'MODERATE_CONTENT' }, b)).code;
      out.mutRoot = (await App.GroupControlMutations.applyControlMutation({ type: 'REVOKE_CAPABILITY', targetPubkey: a, capability: 'MANAGE_ADMINS' }, b)).code;
      try {
        await App.SosCryptoSigner.signTypedAdminOperation({
          version: 1,
          operation: 'GRANT_CAPABILITY',
          groupId: 'israel-network',
          baseEvent: App.GroupControlState.getVerifiedControlEvent('israel-network'),
          targetPubkey: b,
          capability: 'MODERATE_CONTENT',
          actorMembershipStatus: 'ACTIVE',
          controlConflict: false,
        });
        out.signerSelf = 'SIGNED';
      } catch (e) {
        out.signerSelf = e.code || e.message;
      }
      out.uiRolesVisible = F.visibleSections().roles;
      out.selfCheckboxes = F.grantableCapsFor(F.myAuthority(), b).length;
      return out;
    }, { d: D.pub, b: B.pub, a: A.pub });
    const bToA = await transfer(ub, ua);
    const dCapsOnA = await fga(ua.page, (d) => window.NostrApp.FirstGroupAdmin.authorityFor(d).assigned, D.pub);
    set('MANAGE_ADMINS_SEMANTICS', gPerm.ok && sem.grantManageAdmins === 'DELEGATION_ESCALATION' && sem.grantManagePerms === 'DELEGATION_ESCALATION' && sem.mutRoot !== 'APPLIED', sem);
    set('MANAGE_PERMISSIONS_SEMANTICS', sem.grantDelegable === 'APPLIED' && dCapsOnA.includes('INVITE_USERS') && sem.uiRolesVisible === true, { grant: sem.grantDelegable, dCapsOnA, imported: bToA.control });
    set('SELF_GRANT_ESCALATION_DIRECT_CALL_REJECTED', ['selfGrant', 'selfSetPerms', 'mutSelf', 'signerSelf'].every((k) => sem[k] !== 'APPLIED' && sem[k] !== 'SAVED' && sem[k] !== 'SIGNED') && sem.selfCheckboxes === 0, sem);
    // cleanup: A removes B's MANAGE_PERMISSIONS
    await setCaps(ua.page, B.pub, ['INVITE_USERS']);

    // ---- Step 27: session authority
    const sess = await fga(ua.page, async () => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const out = {};
      out.valid = (await F.updateMetadata({ description: 'תיאור קבוצה לבדיקה 897' })).code;
      App.SessionAuthority.revokeSession({ reason: 'qa-897' });
      out.revoked = (await F.updateMetadata({ description: 'after revoke' })).code;
      return out;
    });
    await boot(ua.page, A);
    const relog = await fga(ua.page, async () => (await window.NostrApp.FirstGroupAdmin.updateMetadata({ description: 'תיאור אחרי התחברות מחדש' })).code);
    // different account in another tab of the same profile revokes this tab's authority
    const aTab2 = await ua.ctx.newPage();
    await aTab2.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(aTab2);
    await aTab2.evaluate((k) => window.NostrApp.switchAccountFromRawKey(k, { reload: false }), E.hex);
    await sleep(800);
    const diffAcct = await fga(ua.page, async () => (await window.NostrApp.FirstGroupAdmin.updateMetadata({ description: 'other account' })).code);
    await aTab2.close();
    await boot(ua.page, A);
    set('SESSION_AUTHORITY', sess.valid === 'APPLIED' && /SESSION|REVOKED|NO_IDENTITY/.test(sess.revoked) && relog === 'APPLIED' && /SESSION|REVOKED|MISMATCH|NO_IDENTITY/.test(diffAcct), { ...sess, relog, diffAcct });

    // ---- Step 29: account switch A -> C in the same page, no leak
    await openUi(ua.page, 'invites');
    const leak = await fga(ua.page, async (kC) => {
      const App = window.NostrApp;
      const codesBefore = App.FirstGroupAdmin.listMyInvites().map((r) => r.code);
      App.switchAccountFromRawKey(kC, { reload: false });
      App.guestMode = false;
      await new Promise((r) => setTimeout(r, 900));
      App.GroupAdminProductUi.ensureMenuEntry();
      const text = document.body.innerText;
      return {
        pub: App.publicKey,
        menu: App.GroupAdminProductUi.canSeeGroupAdminMenu(),
        open: App.GroupAdminProductUi.isOpen(),
        invitesAfter: App.FirstGroupAdmin.listMyInvites().length,
        codesInDom: codesBefore.filter((c) => text.includes(c)).length,
        caps: App.FirstGroupAdmin.myAuthority().caps.length,
      };
    }, C.hex);
    set('ACCOUNT_SWITCH_NO_LEAK', leak.pub === C.pub && !leak.menu && !leak.open && leak.invitesAfter === 0 && leak.codesInDom === 0 && leak.caps === 0, leak);
    await boot(ua.page, A);

    // ---- Step 30: multi-tab live sync
    const aTab3 = await ua.ctx.newPage();
    await aTab3.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(aTab3);
    await aTab3.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, A.pub, { timeout: 30000 }).catch(() => {});
    await aTab3.evaluate(() => {
      window.NostrApp.guestMode = false;
      window.NostrApp.FirstGroupAdmin.boot();
    });
    await installStub(aTab3);
    const grantInTab1 = await fga(ua.page, async (d) => (await window.NostrApp.FirstGroupAdmin.grantCapability(d, 'MODERATE_CONTENT')).code, D.pub);
    await sleep(1500);
    const tab3View = await aTab3.evaluate((d) => window.NostrApp.FirstGroupAdmin.authorityFor(d).assigned, D.pub);
    const revokeInTab3 = await aTab3.evaluate(async (d) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(d, 'MODERATE_CONTENT')).code, D.pub);
    await sleep(1500);
    const tab1View = await fga(ua.page, (d) => window.NostrApp.FirstGroupAdmin.authorityFor(d).assigned, D.pub);
    set('MULTI_TAB_SYNC', grantInTab1 === 'APPLIED' && tab3View.includes('MODERATE_CONTENT') && revokeInTab3 === 'APPLIED' && !tab1View.includes('MODERATE_CONTENT'), { grantInTab1, tab3View, revokeInTab3, tab1View });
    await aTab3.close();

    // ---- Step 28: typed signer boundaries
    const signer = await fga(ua.page, async () => {
      const App = window.NostrApp;
      const S = App.SosCryptoSigner;
      const tryIt = async (fn) => {
        try {
          await fn();
          return 'SIGNED';
        } catch (e) {
          return e.code || String(e.message || e).slice(0, 40);
        }
      };
      const draft = { kind: 39001, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'israel-network']], content: '{}', pubkey: App.publicKey };
      return {
        feed39001: await tryIt(() => S.signFeedEvent(draft)),
        invite39001: await tryIt(() => S.signInviteEvent(draft)),
        opener39001: await tryIt(() => App.signEvent(draft)),
        broadGroup: await tryIt(() => S.signGroupControlEvent(draft)),
        broadMember: await tryIt(() => S.signMembershipState(draft)),
        unknownOp: await tryIt(() => S.signTypedAdminOperation({ version: 1, operation: 'RAW_SIGN', groupId: 'israel-network' })),
        rawSurface: ['signRaw', 'signAny', 'signArbitrary', 'getPrivateKey', 'exportKey'].filter((k) => typeof S[k] === 'function'),
      };
    });
    set('TYPED_SIGNER_BOUNDARIES', ['feed39001', 'invite39001', 'opener39001', 'broadGroup', 'broadMember', 'unknownOp'].every((k) => signer[k] !== 'SIGNED') && signer.rawSurface.length === 0, signer);

    // ---- Step 32: audit model
    await openUi(ua.page, 'security');
    const audit = await ua.page.evaluate(() => {
      const F = window.NostrApp.FirstGroupAdmin;
      const rows = F.auditLog();
      const chainIds = new Set(window.NostrApp.GroupControlState.getVerifiedControlChain('israel-network').map((r) => r.eventId));
      const text = document.getElementById('sosGapAudit')?.innerText || '';
      return {
        n: rows.length,
        actions: Array.from(new Set(rows.map((r) => r.action))),
        controlRowsVerified: rows.filter((r) => r.source === 'CONTROL_39001').every((r) => chainIds.has(r.eventId)),
        hebrew: ['הענקת הרשאה', 'הסרת הרשאה', 'עריכת פרטי הקבוצה', 'חבר הוסר'].every((w) => text.includes(w)),
      };
    });
    report.FIRST_GROUP_ADMIN_AUDIT_MODEL = 'SIGNED_CONTROL_CHAIN_PLUS_MEMBERSHIP_EVENTS';
    set('AUDIT_MODEL', audit.n > 10 && audit.controlRowsVerified && audit.hebrew && ['GRANT_CAPABILITY', 'REVOKE_CAPABILITY', 'SET_GROUP_METADATA', 'MEMBER_REMOVED', 'MEMBER_ACTIVE'].every((a) => audit.actions.includes(a)), audit);

    // ---- Step 31: hard reload admin / member / permission / invite
    const inv5 = await createInviteUi(ua.page);
    const rA = await hardReload(ua, A);
    const rBr = await hardReload(ub, B);
    const rD2 = await hardReload(ud, D);
    await transfer(ua, ub);
    await transfer(ua, ud);
    const afterReload = {
      a: await fga(ua.page, ({ c }) => {
        const F = window.NostrApp.FirstGroupAdmin;
        return { root: F.myAuthority().isRoot, c: window.NostrApp.MembershipState.getMemberState(c), name: window.NostrApp.GroupControlState.getGroupSettings('israel-network').displayName, menu: window.NostrApp.GroupAdminProductUi.canSeeGroupAdminMenu() };
      }, { c: C.pub }),
      b: await fga(ub.page, () => window.NostrApp.FirstGroupAdmin.myAuthority().role),
      d: await fga(ud.page, () => window.NostrApp.FirstGroupAdmin.myAuthority().caps),
    };
    const invAfter = await fga(ue.page, async (code) => (await window.NostrApp.validateInvite({ code })).ok, inv5.code);
    set('HARD_RELOAD_STATE', afterReload.a.root && afterReload.a.menu && afterReload.a.c === 'REMOVED' && afterReload.a.name === 'קבוצת SOS הראשית' && afterReload.b === 'INVITER' && afterReload.d.includes('INVITE_USERS') && invAfter, { ...afterReload, invAfter, restored: { rA, rBr, rD2 } });

    // ---- Steps 24/34/35/36: UI parity, Hebrew, desktop/mobile, three roles
    await openUi(ua.page, 'roles');
    await shot(ua.page, 'admin-A-desktop-roles');
    await openUi(ua.page, 'members');
    await shot(ua.page, 'admin-A-desktop-members');
    await ua.page.setViewportSize({ width: 390, height: 844 });
    await openUi(ua.page, 'admins');
    await shot(ua.page, 'admin-A-mobile-admins');
    const mobileFit = await ua.page.evaluate(() => {
      const p = document.querySelector('#sosGroupAdminShell .gap-panel');
      const r = p.getBoundingClientRect();
      return { w: r.width, overflow: document.querySelector('#sosGroupAdminShell .gap-body').scrollWidth <= r.width + 2 };
    });
    await ua.page.setViewportSize({ width: 1280, height: 860 });
    await openUi(ub.page, 'invites');
    await shot(ub.page, 'admin-B-delegated-desktop');
    const bTabs3 = await visibleTabs(ub.page);
    const dReset = await setCaps(ua.page, D.pub, []);
    await transfer(ua, ud);
    const dMenu = await menuVisible(ud.page);
    report.D_RESET_TO_MEMBER = dReset.ok;
    await shot(ud.page, 'member-D-regular-desktop');
    const parity = [];
    for (const u of [ua, ub]) {
      parity.push(
        await u.page.evaluate(() => {
          const ui = window.NostrApp.GroupAdminProductUi;
          const s = window.NostrApp.FirstGroupAdmin.visibleSections();
          const shown = Array.from(document.querySelectorAll('#sosGapTabs button')).filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.dataset.tab);
          return ui.TABS.every((t) => shown.includes(t.id) === ui.tabAllowed(t.id, s));
        })
      );
    }
    set('UI_MATCHES_EFFECTIVE_AUTHORITY', parity.every(Boolean), parity);
    set('THREE_ROLE_UI', bTabs3.includes('invites') && !bTabs3.includes('roles') && !dMenu, { bTabs3, dMenu });
    set('DESKTOP_MOBILE_UI', mobileFit.w <= 391 && mobileFit.overflow, mobileFit);
    const hebrew = await ua.page.evaluate(() => {
      const ui = window.NostrApp.GroupAdminProductUi;
      const want = ['הוספת מנהל', 'הסרת מנהל', 'הסרת חבר', 'יצירת הזמנה', 'העתקת קישור', 'הצגת QR', 'ביטול הזמנה', 'שמירת הרשאות'];
      const labels = Object.values(ui.LABELS);
      const text = document.getElementById('sosGroupAdminShell')?.innerText || '';
      return { all: want.every((w) => labels.includes(w)), mojibake: /[\u05F3][\u0000-\u05FF]{0,2}[\u05F3\u2019\u201D]|Ã|â€|\uFFFD/.test(text) };
    });
    const srcMojibake = ['group-admin-product-ui.js', 'first-group-admin.js'].some((f) => /׳³|ג€|Ã|â€|\uFFFD/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    set('HEBREW_LABELS_NO_MOJIBAKE', hebrew.all && !hebrew.mojibake && !srcMojibake, { ...hebrew, srcMojibake });
    set('NO_NSEC_IN_ADMIN_DOM', !(await ua.page.evaluate(() => /nsec1[a-z0-9]{20,}/i.test(document.body.innerText))));
    set('NO_PAGE_ERRORS_IN_ADMIN_MODULES', !(report.pageErrors || []).length, report.pageErrors || []);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(() => r()));
  }
}

main()
  .catch((e) => {
    set('E2E_RUNTIME', false, String(e.stack || e).slice(0, 600));
  })
  .finally(() => {
    const missing = Object.entries(report.results)
      .filter(([, v]) => !v.ok)
      .map(([k]) => k);
    report.missing = missing;
    report.status = missing.length === 0 && Object.keys(report.results).length > 30 ? 'PASS' : 'FAIL';
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    console.log('STATUS', report.status);
    console.log('MISSING', missing.join(',') || 'none');
    process.exit(report.status === 'PASS' ? 0 : 1);
  });
