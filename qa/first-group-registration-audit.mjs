/**
 * Read-only production audit (https://sos010.com): SOS registration evidence vs israel-network membership.
 * Guest browser, no identity, no publishing. Reports counts and short public keys only (no names, no email hashes).
 *
 * Evidence:
 *   EMAIL_REGISTRY  kind 37377 ['t','email-registry'] + ['t','israel-network'] signed by the account (SOS signup only)
 *   ADMITTED        a valid 39003 membership record exists (admission proof or manager grant)
 *   SOS_PROFILE     kind 0 tagged ['t','israel-network'] (published by the SOS client on every profile save; weak)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'first-group-registration-audit-report.json');
const WATCH = {
  QA_MODERATOR2: '7c6a58485022fe4d39053cd371f081f0d10420946642ee2a8d7bc732a44b96a9',
  KODY2048: '170fe2a9b7156c9ac94dc4580f928cb215e06fa4ca88890bd3aa95184e195e28',
  QA_MODERATOR: 'c0fed7a8dee9bb75b41b2290bff138ceef2e587c252cf77fc94f57870202b470',
};

const browser = await chromium.launch({ headless: true });
const report = { gate: 'FIRST_GROUP_REGISTRATION_AUDIT', ts: new Date().toISOString() };
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority && !!window.NostrApp?.MembershipState && !!window.NostrApp?.pool, null, { polling: 300, timeout: 120000 });
  await page.waitForFunction(() => window.NostrApp.FirstGroupNetworkAuthority.isSynced(), null, { polling: 500, timeout: 120000 });
  const r = await page.evaluate(async (watch) => {
    const App = window.NostrApp;
    const MS = App.MembershipState;
    const P = App.InvitePolicy;
    const tag = App.NETWORK_TAG || 'israel-network';
    const relays = Array.from(new Set([...(App.relayUrls || []), ...(App.EMAIL_REGISTRY_RELAYS || [])]));
    const q = async (f) => {
      try {
        return await App.pool.querySync(relays, f, { maxWait: 12000 });
      } catch (_e) {
        return [];
      }
    };
    const verify = (e) => typeof App.strictVerifyNostrEvent !== 'function' || App.strictVerifyNostrEvent(e) === true;
    const hasT = (e, v) => (e.tags || []).some((t) => t[0] === 't' && t[1] === v);
    const [reg, prof, mem] = await Promise.all([
      q({ kinds: [App.EMAIL_REGISTRY_KIND || 37377], '#t': [App.EMAIL_REGISTRY_TAG || 'email-registry'], limit: 5000 }),
      q({ kinds: [0], '#t': [tag], limit: 5000 }),
      q({ kinds: [39003], '#t': [tag], limit: 5000 }),
    ]);
    const regSet = new Set(reg.filter((e) => verify(e) && hasT(e, tag)).map((e) => e.pubkey));
    const regAnyNet = new Set(reg.filter((e) => verify(e)).map((e) => e.pubkey));
    const profSet = new Set(prof.filter(verify).map((e) => e.pubkey));
    const memSet = new Set();
    mem.forEach((e) => {
      const p = (e.tags.find((t) => t[0] === 'p') || [])[1];
      if (p) memSet.add(p);
    });
    const st = P.getVerifiedControlOrNull();
    const blocked = new Set((st && st.blockedPubkeys) || []);
    const root = st && st.rootAdminPubkey;
    const CAPS = ['INVITE_USERS', 'MODERATE_CONTENT', 'MANAGE_MEMBERS', 'MANAGE_BLOCKLIST', 'MANAGE_INVITES'];
    const caps = (pk) => (st ? CAPS.filter((c) => P.hasCap(pk, st, c)) : []);
    const status = (pk) => (pk === root ? 'ROOT' : blocked.has(pk) ? 'BLOCKED' : MS.getMemberState(pk));
    const all = new Set([...regSet, ...profSet, ...memSet]);
    const rows = Array.from(all).map((pk) => ({
      pk,
      emailRegistry: regSet.has(pk),
      sosProfile: profSet.has(pk),
      admittedRecord: memSet.has(pk),
      status: status(pk),
    }));
    const count = (f) => rows.filter(f).length;
    const gap = (r) => r.status !== 'ACTIVE' && r.status !== 'ROOT' && r.status !== 'REMOVED' && r.status !== 'BLOCKED';
    const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);
    const w = {};
    Object.keys(watch).forEach((k) => {
      const pk = watch[k];
      w[k] = { pk: short(pk), emailRegistry: regSet.has(pk), emailRegistryAnyNetwork: regAnyNet.has(pk), sosProfile: profSet.has(pk), admittedRecord: memSet.has(pk), status: status(pk), caps: caps(pk) };
    });
    return {
      relays: relays.length,
      raw: { emailRegistryEvents: reg.length, profileEvents: prof.length, membershipEvents: mem.length },
      totals: {
        EMAIL_REGISTRY_ACCOUNTS: regSet.size,
        SOS_PROFILE_ACCOUNTS: profSet.size,
        MEMBERSHIP_RECORD_ACCOUNTS: memSet.size,
        ACTIVE: count((r) => r.status === 'ACTIVE'),
        REMOVED: count((r) => r.status === 'REMOVED'),
        BLOCKED: count((r) => r.status === 'BLOCKED'),
        CONFLICT: count((r) => r.status === 'CONFLICT'),
      },
      gaps: {
        EMAIL_REGISTRY_NOT_ACTIVE: count((r) => r.emailRegistry && gap(r)),
        PROFILE_ONLY_NOT_ACTIVE: count((r) => !r.emailRegistry && r.sosProfile && gap(r)),
        EMAIL_REGISTRY_REMOVED_OR_BLOCKED: count((r) => r.emailRegistry && (r.status === 'REMOVED' || r.status === 'BLOCKED')),
        ACTIVE_WITHOUT_EMAIL_REGISTRY: count((r) => r.status === 'ACTIVE' && !r.emailRegistry),
      },
      gapSample: rows.filter((r) => r.emailRegistry && gap(r)).slice(0, 60).map((r) => short(r.pk) + ' ' + r.status),
      watch: w,
    };
  }, WATCH);
  Object.assign(report, r);
} catch (e) {
  report.error = String((e && e.message) || e).slice(0, 300);
} finally {
  await browser.close();
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
