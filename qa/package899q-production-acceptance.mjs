/**
 * 899q read-only production acceptance (https://sos010.com).
 * Guest browser, no private key, no publishing (pool.publish is blocked and counted). Reads the verified control state
 * from the canonical relays through the deployed client, then evaluates the deployed menu, report-recipient,
 * moderation-history and avatar behavior per real production identity by setting only the viewer public key.
 * Reports short public keys only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'package899q-production-acceptance-report.json');
const URL0 = 'https://sos010.com/videos.html?qa899q=' + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const report = { gate: 'PACKAGE_899Q_PRODUCTION_ACCEPTANCE', ts: new Date().toISOString(), checks: {} };
const set = (name, ok, detail) => {
  report.checks[name] = { pass: !!ok, detail };
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(detail).slice(0, 400));
};
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.GroupAdminProductUi && !!window.NostrApp?.FirstGroupAdmin && !!window.NostrApp?.pool, null, { polling: 200, timeout: 120000 });
  await page.evaluate(() => {
    const App = window.NostrApp;
    window.__q = { publishAttempts: 0, attempts: [] };
    const real = App.pool.publish.bind(App.pool);
    App.pool.publish = (relays, ev) => {
      window.__q.publishAttempts++;
      const caller = (new Error().stack || '').split('\n').slice(2, 5).map((l) => (l.match(/\/([\w.-]+\.js):\d+/) || [])[1] || '').filter(Boolean);
      window.__q.attempts.push({ kind: ev && ev.kind, signedBy: ev && ev.pubkey ? ev.pubkey.slice(0, 8) : null, viewer: String(App.publicKey || '').slice(0, 8), caller });
      return (relays || []).map(() => Promise.reject(new Error('read-only acceptance')));
    };
    void real;
  });

  // ---- guest view and ROOT during startup (before the control plane is synced)
  const early = await page.evaluate(() => {
    const App = window.NostrApp;
    const ui = App.GroupAdminProductUi;
    const F = App.FirstGroupAdmin;
    const vis = (id) => {
      const el = document.getElementById(id);
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    };
    ui.ensureMenuEntry();
    const guest = { control: vis('sosGroupControlMenuItem'), invite: vis('topBarInviteFriend'), controlMenu: ui.canSeeControlMenu() };
    const synced = !!App.FirstGroupNetworkAuthority?.isSynced?.();
    return { guest, syncedAtStart: synced, rootConfigured: typeof F.isConfiguredRoot === 'function' };
  });
  report.GUEST = early.guest;
  set('GUEST_NO_MANAGEMENT_ENTRY', !early.guest.control && !early.guest.invite && !early.guest.controlMenu, early.guest);

  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.(), null, { polling: 500, timeout: 180000 });
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('q899q').catch(() => null));
  await sleep(6000);
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('q899q-2').catch(() => null));

  // ---- deployed version / cache / flags (runtime)
  const runtime = await page.evaluate(async () => {
    const v = await (await fetch('/app-version.json?cb=' + Date.now(), { cache: 'no-store' })).json();
    let keys = [];
    try {
      await navigator.serviceWorker.ready;
      await new Promise((r) => setTimeout(r, 3000));
      keys = await caches.keys();
    } catch (_e) {}
    return {
      version: v.version,
      cacheKeys: keys.filter((k) => /sos-cache/.test(k)),
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      scope: window.NostrApp.FeatureFlags.accessControlV2Scope(),
    };
  });
  report.RUNTIME = runtime;
  set('RUNTIME_VERSION_AND_FLAGS', runtime.version === '2026.10.03-web-899q' && runtime.cacheKeys.includes('sos-cache-v899q') && runtime.v2 && runtime.scope === 'CONTROL_PLANE', runtime);

  // ---- ROOT entry while the network authority is loading (fresh page, viewer = configured root, before sync)
  const loadPage = await ctx.newPage();
  await loadPage.goto(URL0 + '-load', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await loadPage.waitForFunction(() => !!window.NostrApp?.GroupAdminProductUi && !!window.NostrApp?.FirstGroupAdmin, null, { polling: 100, timeout: 120000 });
  const rootPk = await page.evaluate(() => window.NostrApp.GroupControlState.getVerifiedControlState('israel-network').rootAdminPubkey);
  const rootLoading = await loadPage.evaluate((root) => {
    const App = window.NostrApp;
    App.pool.publish = (relays) => (relays || []).map(() => Promise.reject(new Error('read-only acceptance')));
    const synced = !!App.FirstGroupNetworkAuthority?.isSynced?.();
    App.publicKey = root;
    App.guestMode = false;
    App.GroupAdminProductUi.ensureMenuEntry();
    const el = document.getElementById('sosGroupControlMenuItem');
    const out = {
      syncedWhenChecked: synced,
      menu: !!el && !el.hidden && el.style.display !== 'none',
      full: App.GroupAdminProductUi.canSeeGroupControl(),
      sectionsWhileLoading: synced ? null : Object.values(App.FirstGroupAdmin.visibleSections()).some(Boolean),
    };
    App.publicKey = '';
    App.guestMode = true;
    return out;
  }, rootPk);
  await loadPage.close();
  report.ROOT_STARTUP = rootLoading;
  set('ROOT_MENU_DURING_STARTUP', rootLoading.menu && rootLoading.full, rootLoading);

  // ---- per-identity evaluation over the real production control state
  const evalRes = await page.evaluate(() => {
    const App = window.NostrApp;
    const ui = App.GroupAdminProductUi;
    const F = App.FirstGroupAdmin;
    const MS = App.MembershipState;
    const R = App.GroupReports;
    const st = App.GroupControlState.getVerifiedControlState('israel-network');
    const caps = st.capabilities || {};
    const recipients = R.moderatorRecipients('');
    const vis = (id) => {
      const el = document.getElementById(id);
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    };
    const known = new Set([st.rootAdminPubkey].concat(Object.keys(caps), MS.getKnownMemberPubkeys ? MS.getKnownMemberPubkeys() : []));
    const NT = window.NostrTools;
    const freshPk = NT.getPublicKey(NT.generateSecretKey());
    known.add(freshPk);
    const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);
    const rows = [];
    for (const pk of known) {
      App.publicKey = pk;
      App.guestMode = false;
      ui.ensureMenuEntry();
      const a = F.authorityFor(pk);
      const isRoot = pk === st.rootAdminPubkey;
      const snap = MS.getMemberSnapshot ? MS.getMemberSnapshot(pk) : null;
      const status = isRoot ? 'ROOT' : pk === freshPk ? 'NOT_A_MEMBER' : snap ? snap.status : 'NONE';
      const effective = (a && a.caps) || [];
      const mode = ui.canSeeGroupControl() ? 'FULL' : ui.canSeeReportsEntry() ? 'MODERATION_ONLY' : 'NONE';
      rows.push({
        pk: short(pk),
        fresh: pk === freshPk,
        isRoot,
        status,
        assigned: (caps[pk] || []).slice(),
        effective: isRoot ? ['ALL'] : effective.slice(),
        GROUP_CONTROL_VISIBLE: vis('sosGroupControlMenuItem'),
        MODE: mode,
        SEPARATE_REPORTS_ITEM: !!document.getElementById('sosGroupReportsMenuItem'),
        INVITE_MENU_VISIBLE: vis('topBarInviteFriend'),
        REPORT_RECIPIENT: recipients.indexOf(pk) !== -1,
      });
    }
    App.publicKey = '';
    App.guestMode = true;
    ui.ensureMenuEntry();
    return { rows, recipients: recipients.map(short), controlEpoch: st.controlEpoch, root: short(st.rootAdminPubkey) };
  });
  // admission service is a delegated principal, not a person; it holds only its admission capability
  const rows = evalRes.rows;
  report.CONTROL_EPOCH = evalRes.controlEpoch;
  report.PERSONAS = rows;
  report.REPORT_RECIPIENTS = evalRes.recipients;
  const has = (r, c) => r.effective.includes(c);
  const expectMode = (r) => (r.isRoot ? 'FULL' : has(r, 'MODERATE_CONTENT') ? 'MODERATION_ONLY' : 'NONE');
  const expectInvite = (r) => r.isRoot || has(r, 'INVITE_USERS');
  const bad = rows.filter(
    (r) =>
      r.MODE !== expectMode(r) || r.GROUP_CONTROL_VISIBLE !== (expectMode(r) !== 'NONE') || r.SEPARATE_REPORTS_ITEM ||
      r.INVITE_MENU_VISIBLE !== expectInvite(r) || r.REPORT_RECIPIENT !== (r.isRoot || has(r, 'MODERATE_CONTENT'))
  );
  set('PERSONA_MATRIX_PRODUCTION', bad.length === 0, { identities: rows.length, mismatches: bad });
  const root = rows.find((r) => r.isRoot);
  const mods = rows.filter((r) => !r.isRoot && has(r, 'MODERATE_CONTENT'));
  const inviteOnly = rows.filter((r) => !r.isRoot && has(r, 'INVITE_USERS') && !has(r, 'MODERATE_CONTENT'));
  const blocklistNoMod = rows.filter((r) => !r.isRoot && has(r, 'MANAGE_BLOCKLIST') && !has(r, 'MODERATE_CONTENT'));
  const membersNoMod = rows.filter((r) => !r.isRoot && !has(r, 'MODERATE_CONTENT') && (has(r, 'MANAGE_MEMBERS') || has(r, 'MANAGE_PERMISSIONS')));
  const plain = rows.filter((r) => !r.isRoot && r.effective.length === 0);
  const blocked = rows.filter((r) => r.status === 'BLOCKED');
  report.PRESENT_IN_PRODUCTION = {
    ROOT: !!root,
    MODERATE_CONTENT: mods.length,
    INVITE_USERS_ONLY: inviteOnly.length,
    MANAGE_BLOCKLIST_WITHOUT_MOD: blocklistNoMod.length,
    MANAGE_MEMBERS_OR_PERMISSIONS_WITHOUT_MOD: membersNoMod.length,
    PLAIN_OR_NON_MEMBER: plain.length,
    BLOCKED: blocked.length,
  };
  set('ROOT_FULL', !!root && root.MODE === 'FULL' && root.GROUP_CONTROL_VISIBLE && root.REPORT_RECIPIENT, root);
  set('MODERATORS_MODERATION_ONLY', mods.every((r) => r.MODE === 'MODERATION_ONLY' && r.GROUP_CONTROL_VISIBLE && r.REPORT_RECIPIENT), { count: mods.length });
  set('INVITE_ONLY_NO_CONTROL', inviteOnly.every((r) => !r.GROUP_CONTROL_VISIBLE && r.INVITE_MENU_VISIBLE), { count: inviteOnly.length });
  set('PLAIN_AND_BLOCKED_NO_ENTRY', plain.concat(blocked).every((r) => !r.GROUP_CONTROL_VISIBLE && !r.INVITE_MENU_VISIBLE && !r.REPORT_RECIPIENT), { plain: plain.length, blocked: blocked.length });
  set('REPORT_RECIPIENTS_ROOT_PLUS_MODERATORS', evalRes.recipients.length === 1 + mods.length && blocklistNoMod.every((r) => !r.REPORT_RECIPIENT), { recipients: evalRes.recipients.length, mods: mods.length });

  // ---- moderation history on a fresh client: every published group moderation, resolved target-driven
  const mod = await page.evaluate(async () => {
    const App = window.NostrApp;
    const st = App.GroupControlState.getVerifiedControlState('israel-network');
    const caps = st.capabilities || {};
    const q = async (f) => {
      const got = await App.pool.querySync(App.relayUrls, f);
      return Array.isArray(got) ? got : (got && got.events) || [];
    };
    const mods = await q({ kinds: [39002], '#t': ['israel-network'], limit: 1000 });
    const byTarget = new Map();
    mods.forEach((m) => {
      const d = (m.tags.find((t) => t[0] === 'd') || [])[1] || '';
      const id = d.includes(':') ? d.split(':').pop() : d;
      if (/^[0-9a-f]{64}$/.test(id) && !byTarget.has(id)) byTarget.set(id, m);
    });
    const ids = Array.from(byTarget.keys());
    const targets = [];
    for (let i = 0; i < ids.length; i += 100) targets.push(...(await q({ ids: ids.slice(i, i + 100) })));
    targets.forEach((e) => {
      const isComment = e.tags.some((t) => t[0] === 'e');
      if (isComment) {
        const root = (e.tags.find((t) => t[0] === 'e' && t[3] === 'root') || e.tags.find((t) => t[0] === 'e') || [])[1];
        try {
          App.registerComment(e, root);
        } catch (_e) {}
      } else {
        App.postsById.set(e.id, e);
        App.eventAuthorById.set(e.id, e.pubkey);
      }
      App.retryModerationForTarget(e.id);
    });
    const t0 = Date.now();
    const done = () => targets.every((e) => App.deletedEventIds.has(e.id));
    while (Date.now() - t0 < 45000 && !done()) await new Promise((r) => setTimeout(r, 500));
    const classOf = (m) => (m.pubkey === st.rootAdminPubkey ? 'ROOT' : (caps[m.pubkey] || []).includes('MODERATE_CONTENT') ? 'CURRENT_MODERATOR' : 'REVOKED_MODERATOR');
    const out = { totalModerationEvents: mods.length, targetsFound: targets.length, byClass: {} };
    targets.forEach((e) => {
      const m = byTarget.get(e.id);
      const c = classOf(m);
      const kind = e.tags.some((t) => t[0] === 'e') ? 'comment' : 'post';
      const k = c + ':' + kind;
      out.byClass[k] = out.byClass[k] || { total: 0, hidden: 0, source: {} };
      out.byClass[k].total++;
      if (App.deletedEventIds.has(e.id)) out.byClass[k].hidden++;
      const s = (App.deletionTombstones.get(e.id) || {}).source || 'none';
      out.byClass[k].source[s] = (out.byClass[k].source[s] || 0) + 1;
    });
    return out;
  });
  report.MODERATION_HISTORY = mod;
  const cls = Object.entries(mod.byClass);
  const unhidden = cls.filter(([, v]) => v.hidden !== v.total);
  set('MODERATION_HISTORY_FRESH_CLIENT', mod.targetsFound > 0 && unhidden.length === 0, mod);
  set('REVOKED_MODERATOR_HISTORY_HIDDEN', cls.filter(([k]) => k.startsWith('REVOKED_MODERATOR')).every(([, v]) => v.hidden === v.total), {
    revoked: cls.filter(([k]) => k.startsWith('REVOKED_MODERATOR')),
  });

  // ---- avatars: no visible broken-image icon in the guest feed
  await sleep(4000);
  const imgs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('img')).filter((i) => i.offsetParent !== null && i.getBoundingClientRect().width > 0);
    const broken = all.filter((i) => i.complete && i.naturalWidth === 0 && !!i.getAttribute('src'));
    return { visible: all.length, broken: broken.length, brokenHosts: broken.slice(0, 5).map((i) => { try { return new URL(i.src).host; } catch (_e) { return 'invalid'; } }) };
  });
  report.AVATARS = imgs;
  set('NO_BROKEN_IMAGE_ICON_VISIBLE', imgs.broken === 0, imgs);

  report.PUBLISH_ATTEMPTS = await page.evaluate(() => window.__q.publishAttempts);
  report.PUBLISH_ATTEMPT_DETAILS = await page.evaluate(() => window.__q.attempts);
  // every publish is blocked; the guest client's own ephemeral-key 30078 sync is expected, nothing as a real identity
  const identity8 = new Set((report.PERSONAS || []).map((r) => r.pk.slice(0, 8)));
  const asIdentity = report.PUBLISH_ATTEMPT_DETAILS.filter((a) => a.viewer || (a.signedBy && identity8.has(a.signedBy)));
  set('READ_ONLY_NO_PUBLISH_AS_IDENTITY', asIdentity.length === 0, { blockedAttempts: report.PUBLISH_ATTEMPTS, asIdentity, details: report.PUBLISH_ATTEMPT_DETAILS });
} finally {
  await browser.close();
}
const failed = Object.entries(report.checks).filter(([, v]) => !v.pass).map(([k]) => k);
report.RESULT = failed.length ? 'FAIL' : 'PASS';
report.FAILED = failed;
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('RESULT ' + report.RESULT + ' passed ' + (Object.keys(report.checks).length - failed.length) + ' failed ' + failed.join(','));
