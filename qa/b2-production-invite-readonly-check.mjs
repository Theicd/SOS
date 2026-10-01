/**
 * Blocker 2 — read-only production check of INVITE_USERS propagation on https://sos010.com (899h).
 * Guest browser, no identity, no publishing: reads network control/membership state and evaluates
 * the invite policy for a member with INVITE_USERS and for a member without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'b2-production-invite-readonly-report.json');
const MEMBER_WITH_INVITE = '170fe2a9b7156c9ac94dc4580f928cb215e06fa4ca88890bd3aa95184e195e28';
const NOT_A_MEMBER = 'ab'.repeat(32);

const browser = await chromium.launch({ headless: true });
const report = { gate: 'B2_PRODUCTION_INVITE_READONLY', status: 'FAIL', ts: new Date().toISOString() };
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority && !!window.NostrApp?.InvitePolicy, null, { polling: 300, timeout: 120000 });
  await page.waitForFunction(() => window.NostrApp.FirstGroupNetworkAuthority.isSynced(), null, { polling: 500, timeout: 120000 });
  const r = await page.evaluate(async ({ withCap, none }) => {
    const App = window.NostrApp;
    const P = App.InvitePolicy;
    const v = await fetch('/app-version.json?t=' + Date.now()).then((x) => x.json());
    const st = App.FirstGroupNetworkAuthority.status();
    // Evaluate the policy for the given principals, not for this guest test session.
    App.guestMode = false;
    return {
      version: v.version,
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      synced: App.FirstGroupNetworkAuthority.isSynced(),
      authorityStatus: st.status,
      withCap: P.canCreateInvite(withCap, null, {}),
      none: P.canCreateInvite(none, null, {}),
      refreshFn: typeof App.refreshInviteAuthority === 'function',
    };
  }, { withCap: MEMBER_WITH_INVITE, none: NOT_A_MEMBER });
  Object.assign(report, {
    LIVE_VERSION: r.version,
    ACCESS_CONTROL_V2: r.v2,
    AUTHORITY_SYNCED: r.synced,
    AUTHORIZED_MEMBER_WITH_INVITE_USERS_CAN_CREATE_INVITE: r.withCap && r.withCap.ok === true,
    NON_AUTHORIZED_CAN_CREATE_INVITE: r.none && r.none.ok === true,
    NON_AUTHORIZED_DENY_CODE: r.none && r.none.code,
    REFRESH_BEFORE_CHECK_LIVE: r.refreshFn,
  });
  report.status =
    /^2026\.10\.01-web-899[hij]$/.test(r.version) && r.v2 && r.synced && report.AUTHORIZED_MEMBER_WITH_INVITE_USERS_CAN_CREATE_INVITE && !report.NON_AUTHORIZED_CAN_CREATE_INVITE && r.refreshFn
      ? 'PASS'
      : 'FAIL';
} catch (e) {
  report.error = String((e && e.message) || e).slice(0, 300);
} finally {
  await browser.close();
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
