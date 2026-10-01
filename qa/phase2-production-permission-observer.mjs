/**
 * Phase 2 — read-only production observer for owner-performed permission / admission actions on https://sos010.com.
 * Guest browser, no identity, no publishing. Polls the verified control state and the canonical membership
 * record for one public key and records every change with a timestamp.
 *
 * Usage: node qa/phase2-production-permission-observer.mjs <targetPubkeyHex> [minutes=30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'phase2-production-permission-observer-report.json');
const ROOT_PUBKEY = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const ADMISSION_PUBKEY = '752f47fa926d1833a451bdc97f3f2967ae4bc6452d0356bc7919c6928e4611ef';
const target = String(process.argv[2] || '').trim().toLowerCase();
const minutes = Math.max(1, Math.min(120, Number(process.argv[3] || 30)));
if (!/^[0-9a-f]{64}$/.test(target)) {
  console.error('usage: node qa/phase2-production-permission-observer.mjs <targetPubkeyHex> [minutes]');
  process.exit(2);
}

const report = { gate: 'PHASE2_PRODUCTION_PERMISSION_OBSERVER', target, startedAt: new Date().toISOString(), changes: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.() && !!window.NostrApp?.InvitePolicy, null, { polling: 500, timeout: 180000 });
  let last = '';
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('observer').catch(() => null));
    const snap = await page.evaluate(({ pk, root, adm }) => {
      const App = window.NostrApp;
      const st = App.GroupControlState?.getVerifiedControlState?.() || null;
      const m = App.MembershipState?.getMemberSnapshot?.(pk) || null;
      // Policy is evaluated for the target principal, not for this guest session.
      App.guestMode = false;
      const inv = App.InvitePolicy.canCreateInvite(pk, null, {});
      App.guestMode = true;
      const caps = st && st.capabilities ? st.capabilities : {};
      return {
        controlEpoch: st ? st.controlEpoch : null,
        controlTip: st ? st.eventId : null,
        rootUnchanged: !!st && st.rootAdminPubkey === root,
        rootCaps: (caps[root] || []).slice(),
        invitePolicy: st ? st.invitePolicy : null,
        targetCaps: (caps[pk] || []).slice(),
        admissionServiceCaps: (caps[adm] || []).slice(),
        targetBlocked: !!(st && Array.isArray(st.blockedPubkeys) && st.blockedPubkeys.includes(pk)),
        member: m
          ? {
              status: m.status,
              revision: m.record && m.record.memberRevision,
              transition: m.record && m.record.transition,
              issuer: m.record && m.record.issuerPubkey,
              hasInvite: !!(m.record && m.record.inviteEventId),
            }
          : null,
        canInvite: !!(inv && inv.ok),
        inviteCode: inv && inv.code,
      };
    }, { pk: target, root: ROOT_PUBKEY, adm: ADMISSION_PUBKEY });
    const key = JSON.stringify(snap);
    if (key !== last) {
      last = key;
      const row = {
        at: new Date().toISOString(),
        ...snap,
        issuerIsAdmissionService: !!(snap.member && snap.member.issuer === ADMISSION_PUBKEY),
      };
      report.changes.push(row);
      save();
      console.log(JSON.stringify(row));
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
} catch (e) {
  report.error = String((e && e.message) || e).slice(0, 300);
} finally {
  report.endedAt = new Date().toISOString();
  save();
  await browser.close();
}
