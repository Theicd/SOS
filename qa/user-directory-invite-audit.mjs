/**
 * Read-only production audit (https://sos010.com): every known SOS identity for israel-network (canonical members,
 * blocklist, own email-registry 37377, SOS-tagged profiles) and who can create invites.
 * Guest browser, no identity, no publishing. Reports short public keys and public profile names only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'user-directory-invite-audit-report.json');
const ADMISSION_URL = 'https://sos-first-group-admission.dror201031-b16.workers.dev';

const health = await (await fetch(ADMISSION_URL + '/v1/health')).json();
const live = await (await fetch('https://sos010.com/app-version.json?qa=' + Date.now())).json();
const browser = await chromium.launch({ headless: true });
const report = { gate: 'USER_DIRECTORY_INVITE_AUDIT', ts: new Date().toISOString(), mutations: 0, liveVersion: live.version };
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.() && !!window.NostrApp?.InvitePolicy && !!window.NostrApp?.pool, null, { polling: 500, timeout: 180000 });
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('audit').catch(() => null));
  await new Promise((r) => setTimeout(r, 6000));
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('audit2').catch(() => null));
  const r = await page.evaluate(async ({ admissionPk }) => {
    const App = window.NostrApp;
    const MS = App.MembershipState;
    const st = App.GroupControlState.getVerifiedControlState();
    const tag = 'israel-network';
    const relays = Array.from(new Set([...(App.relayUrls || []), ...(App.EMAIL_REGISTRY_RELAYS || [])]));
    const q = async (f) => {
      try {
        return await App.pool.querySync(relays, f, { maxWait: 15000 });
      } catch (_e) {
        return [];
      }
    };
    const verify = (e) => typeof App.strictVerifyNostrEvent === 'function' && App.strictVerifyNostrEvent(e) === true;
    const hasT = (e, v) => (e.tags || []).some((t) => t[0] === 't' && t[1] === v);
    const short = (pk) => pk.slice(0, 8) + '…' + pk.slice(-4);
    const [reg, prof] = await Promise.all([q({ kinds: [37377], '#t': ['email-registry'], limit: 5000 }), q({ kinds: [0], '#t': [tag], limit: 5000 })]);
    const registered = new Set(reg.filter((e) => verify(e) && hasT(e, tag)).map((e) => e.pubkey));
    const names = new Map();
    prof
      .filter(verify)
      .sort((a, b) => b.created_at - a.created_at)
      .forEach((e) => {
        if (names.has(e.pubkey)) return;
        let n = '';
        try {
          const c = JSON.parse(e.content || '{}');
          n = String(c.display_name || c.name || '').trim().slice(0, 40);
        } catch (_e) {}
        names.set(e.pubkey, n);
      });
    const caps = st.capabilities || {};
    const blocked = new Set(st.blockedPubkeys || []);
    const known = new Set([st.rootAdminPubkey, ...Object.keys(caps), ...(MS.getKnownMemberPubkeys ? MS.getKnownMemberPubkeys() : []), ...blocked, ...registered, ...names.keys()]);
    known.delete(admissionPk);
    const evalInvite = (pk) => {
      App.guestMode = false;
      try {
        return App.InvitePolicy.canCreateInvite(pk, null, {});
      } finally {
        App.guestMode = true;
      }
    };
    const rows = Array.from(known).map((pk) => {
      const c = (caps[pk] || []).slice();
      const isRoot = pk === st.rootAdminPubkey;
      const snap = MS.getMemberSnapshot(pk);
      const ms = isRoot ? 'ROOT' : snap ? snap.status : 'UNKNOWN';
      const inv = evalInvite(pk);
      return {
        pk: short(pk),
        name: names.get(pk) || '',
        status: blocked.has(pk) && ms !== 'REMOVED' && !isRoot ? 'BLOCKED' : ms,
        registered: registered.has(pk),
        sosProfile: names.has(pk),
        caps: c,
        inviteUsers: isRoot || c.includes('INVITE_USERS'),
        canCreateInvite: !!inv.ok,
        policyCode: inv.code,
        source: inv.ok ? (isRoot ? 'ROOT' : c.includes('INVITE_USERS') ? 'EXPLICIT_CAPABILITY_IN_SIGNED_CONTROL_STATE' : 'OTHER') : 'NONE',
        isRoot,
      };
    });
    const NT = window.NostrTools;
    const fresh = evalInvite(NT.getPublicKey(NT.generateSecretKey()));
    return {
      controlEpoch: st.controlEpoch,
      controlTip: st.eventId,
      invitePolicy: st.invitePolicy,
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      rows,
      freshKey: { ok: !!fresh.ok, code: fresh.code },
    };
  }, { admissionPk: health.servicePubkey });
  const rows = r.rows;
  const inviters = rows.filter((x) => x.inviteUsers || x.canCreateInvite);
  Object.assign(report, {
    admissionService: { controlEpoch: health.controlEpoch, controlTipMatches: health.controlTipEventId === r.controlTip, admin2faEnforced: health.admin2faEnforced },
    controlEpoch: r.controlEpoch,
    invitePolicy: r.invitePolicy,
    v2: r.v2,
    TOTAL_KNOWN_IDENTITIES: rows.length,
    TOTAL_ACTIVE_MEMBERS: rows.filter((x) => x.status === 'ACTIVE' || x.status === 'ROOT').length,
    LEGACY_NOT_MEMBER: rows.filter((x) => x.status === 'UNKNOWN').length,
    REMOVED: rows.filter((x) => x.status === 'REMOVED').length,
    BLOCKED: rows.filter((x) => x.status === 'BLOCKED').length,
    TOTAL_USERS_WITH_INVITE_USERS: rows.filter((x) => x.inviteUsers).length,
    INVITE_AUTHORIZED_USERS: inviters.map((x) => ({ pk: x.pk, name: x.name, status: x.status, source: x.source, caps: x.caps })),
    NON_ROOT_INVITE_USERS_COUNT: inviters.filter((x) => !x.isRoot).length,
    DEFAULT_MEMBER_CAN_CREATE_INVITE: rows.some((x) => !x.isRoot && x.status === 'ACTIVE' && !x.caps.includes('INVITE_USERS') && x.canCreateInvite),
    REGISTRATION_GRANTS_INVITE_USERS: rows.some((x) => !x.isRoot && x.registered && !x.caps.includes('INVITE_USERS') && x.canCreateInvite),
    BACKFILL_GRANTS_INVITE_USERS: rows.some((x) => !x.isRoot && x.status === 'ACTIVE' && x.caps.length === 0 && x.canCreateInvite),
    KEY_POSSESSION_ALONE_CAN_CREATE_INVITE: r.freshKey.ok,
    freshKeyCode: r.freshKey.code,
    rows: rows.map(({ isRoot, ...x }) => x),
  });
} catch (e) {
  report.error = String((e && e.message) || e).slice(0, 300);
} finally {
  await browser.close();
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
const { rows: _rows, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
