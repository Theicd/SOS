/**
 * Read-only invite authority audit for israel-network on https://sos010.com.
 * Guest browser, no identity, no publishing. Reads the verified control state and membership from the canonical
 * relays (through the production client) and the Admission Service public health endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'invite-authority-production-audit-report.json');
const ADMISSION_URL = 'https://sos-first-group-admission.dror201031-b16.workers.dev';
const TEST_USER = '170fe2a9b7156c9ac94dc4580f928cb215e06fa4ca88890bd3aa95184e195e28';

const health = await (await fetch(ADMISSION_URL + '/v1/health')).json();
const browser = await chromium.launch({ headless: true });
let out;
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.() && !!window.NostrApp?.InvitePolicy, null, { polling: 500, timeout: 180000 });
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('audit').catch(() => null));
  await new Promise((r) => setTimeout(r, 8000));
  await page.evaluate(() => window.NostrApp.FirstGroupNetworkAuthority.reconcile('audit2').catch(() => null));
  out = await page.evaluate(({ testUser, admissionPk }) => {
    const App = window.NostrApp;
    const st = App.GroupControlState.getVerifiedControlState();
    const MS = App.MembershipState;
    const caps = st.capabilities || {};
    const known = new Set([st.rootAdminPubkey].concat(Object.keys(caps), MS.getKnownMemberPubkeys ? MS.getKnownMemberPubkeys() : []));
    known.add(testUser);
    const roleFor = (pk, c) => {
      if (pk === st.rootAdminPubkey) return 'ROOT_OWNER';
      if (pk === admissionPk) return 'ADMISSION_SERVICE';
      if (c.includes('MANAGE_ADMINS') || c.includes('MANAGE_PERMISSIONS')) return 'SENIOR_ADMIN';
      if (c.includes('MANAGE_MEMBERS')) return 'ADMIN';
      if (c.includes('MODERATE_CONTENT')) return 'MODERATOR';
      if (c.includes('INVITE_USERS') && c.length === 1) return 'INVITER';
      return c.length ? 'DELEGATE' : 'MEMBER';
    };
    const evalInvite = (pk) => {
      App.guestMode = false;
      const r = App.InvitePolicy.canCreateInvite(pk, null, {});
      App.guestMode = true;
      return r;
    };
    const rows = Array.from(known).map((pk) => {
      const c = (caps[pk] || []).slice();
      const snap = MS.getMemberSnapshot(pk);
      const inv = evalInvite(pk);
      const isRoot = pk === st.rootAdminPubkey;
      return {
        PUBLIC_KEY_SHORT: pk.slice(0, 8) + '…' + pk.slice(-4),
        ROLE: roleFor(pk, c),
        MEMBERSHIP_STATUS: isRoot ? 'ROOT' : snap ? snap.status : 'NONE',
        MEMBERSHIP_ACTIVE: isRoot || !!(snap && snap.status === 'ACTIVE'),
        CAPABILITIES: c,
        INVITE_USERS: isRoot || c.includes('INVITE_USERS'),
        CAN_CREATE_INVITE: !!inv.ok,
        POLICY_CODE: inv.code,
        SOURCE_OF_AUTHORITY: inv.ok ? (isRoot ? 'ROOT' : c.includes('INVITE_USERS') ? 'EXPLICIT_CAPABILITY' : 'ROLE') : 'NONE',
      };
    });
    const NT = window.NostrTools;
    const freshPk = NT.getPublicKey(NT.generateSecretKey());
    const fresh = evalInvite(freshPk);
    return {
      groupId: st.groupId,
      controlEpoch: st.controlEpoch,
      controlTip: st.eventId,
      rootPubkey8: st.rootAdminPubkey.slice(0, 8),
      INVITE_POLICY: st.invitePolicy,
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      scope: App.accessControlV2Scope || window.SOS_ACCESS_CONTROL_V2_SCOPE || null,
      rows,
      KEY_POSSESSION_ALONE_CAN_CREATE_INVITE: !!fresh.ok,
      freshKeyCode: fresh.code,
      testUserInviteUsers: (caps[testUser] || []).includes('INVITE_USERS'),
    };
  }, { testUser: TEST_USER, admissionPk: health.servicePubkey });
} finally {
  await browser.close();
}
const report = {
  gate: 'INVITE_AUTHORITY_PRODUCTION_AUDIT',
  ts: new Date().toISOString(),
  admissionService: {
    controlEpoch: health.controlEpoch,
    controlTipMatches: health.controlTipEventId === out.controlTip,
    delegatedCapabilities: health.delegatedCapabilities,
    admin2faEnforced: health.admin2faEnforced,
  },
  ...out,
};
const members = out.rows.filter((r) => r.ROLE !== 'ADMISSION_SERVICE');
const can = out.rows.filter((r) => r.CAN_CREATE_INVITE);
report.TOTAL_KNOWN_MEMBERS = members.length;
report.TOTAL_CAN_CREATE_INVITE = can.length;
report.INVITE_AUTHORIZED_PUBKEYS = can.map((r) => r.PUBLIC_KEY_SHORT);
report.DEFAULT_MEMBER_CAN_CREATE_INVITE = out.rows.some((r) => r.ROLE === 'MEMBER' && r.CAN_CREATE_INVITE);
report.UNAUTHORIZED_EXISTING_KEYS_CAN_INVITE = out.rows.some((r) => r.CAN_CREATE_INVITE && r.SOURCE_OF_AUTHORITY !== 'ROOT' && !r.INVITE_USERS);
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
