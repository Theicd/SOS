/**
 * Read-only production trace (https://sos010.com): cross-author removals (kind 39002 group moderation, kind 5) by ROOT
 * and by MODERATE_CONTENT holders, their Admin 2FA attestations (39004) and how a fresh guest client judges them.
 * Guest browser, no identity, no publishing. Reports short ids only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'moderation-delete-production-trace-report.json');

const browser = await chromium.launch({ headless: true });
const report = { gate: 'MODERATION_DELETE_PRODUCTION_TRACE', ts: new Date().toISOString(), mutations: 0 };
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.() && !!window.NostrApp?.ModerationPolicy && !!window.NostrApp?.pool, null, { polling: 500, timeout: 180000 });
  await new Promise((r) => setTimeout(r, 15000));
  Object.assign(
    report,
    await page.evaluate(async () => {
      const App = window.NostrApp;
      const MP = App.ModerationPolicy;
      const A2 = App.Admin2faProtocol;
      const st = App.GroupControlState.getVerifiedControlState();
      const root = st.rootAdminPubkey;
      const caps = st.capabilities || {};
      const mods = Object.keys(caps).filter((pk) => (caps[pk] || []).includes('MODERATE_CONTENT'));
      const principals = [root, ...mods];
      const relays = App.relayUrls || [];
      const q = async (f) => {
        try {
          return await App.pool.querySync(relays, f, { maxWait: 15000 });
        } catch (_e) {
          return [];
        }
      };
      const short = (s) => String(s || '').slice(0, 8);
      const since = Math.floor(Date.now() / 1000) - 14 * 86400;
      const [m39002, m5, att] = await Promise.all([
        q({ kinds: [39002], authors: principals, since, limit: 500 }),
        q({ kinds: [5], authors: principals, since, limit: 500 }),
        q({ kinds: [39004], '#p': principals, since, limit: 1000 }),
      ]);
      A2.ingestAttestations(att);
      const tag = (e, n) => ((e.tags || []).find((t) => t[0] === n) || [])[1] || '';
      const targetIds = Array.from(new Set(m39002.map((e) => tag(e, 'd')).concat(m5.flatMap((e) => (e.tags || []).filter((t) => t[0] === 'e').map((t) => t[1]))))).filter(Boolean);
      const targets = targetIds.length ? await q({ ids: targetIds, limit: targetIds.length }) : [];
      const tById = new Map(targets.map((t) => [t.id, t]));
      const who = (pk) => (pk === root ? 'ROOT' : 'MODERATOR:' + short(pk));
      const rows39002 = m39002.map((e) => {
        const tid = tag(e, 'd');
        const t = tById.get(tid) || null;
        const v = MP.validateModerationEvent(e, t, null);
        const a = A2.attestationsFor(e.id);
        return {
          by: who(e.pubkey),
          at: new Date(e.created_at * 1000).toISOString(),
          modId: short(e.id),
          target: short(tid),
          targetFound: !!t,
          targetIsComment: !!(t && (t.tags || []).some((x) => x[0] === 'e')),
          targetAuthorIsRoot: !!(t && t.pubkey === root),
          attestations: a.length,
          attestationOps: a.map((x) => {
            try {
              return JSON.parse(x.content).operations.join(',');
            } catch (_e) {
              return '?';
            }
          }),
          verdict: v.code,
          hiddenInGuest: !!(App.deletedEventIds && App.deletedEventIds.has(tid)),
        };
      });
      const rows5 = m5.map((e) => ({
        by: who(e.pubkey),
        at: new Date(e.created_at * 1000).toISOString(),
        targets: (e.tags || []).filter((t) => t[0] === 'e').map((t) => {
          const tt = tById.get(t[1]);
          return { id: short(t[1]), crossAuthor: !!(tt && tt.pubkey !== e.pubkey), hiddenInGuest: !!(App.deletedEventIds && App.deletedEventIds.has(t[1])) };
        }),
      }));
      return {
        controlEpoch: st.controlEpoch,
        moderators: mods.map(short),
        admin2faEnforced: A2.isEnforced(),
        attestationsSeen: att.length,
        moderation39002: rows39002.sort((a, b) => (a.at < b.at ? 1 : -1)),
        deletions5: rows5.sort((a, b) => (a.at < b.at ? 1 : -1)),
      };
    })
  );
} catch (e) {
  report.error = String((e && e.message) || e).slice(0, 300);
} finally {
  await browser.close();
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
