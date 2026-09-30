/**
 * Gate 4 production browser check (read-only, no login): https://sos010.com/videos.html with the live flags.
 * Verifies V2 on + CONTROL_PLANE scope, verified control chain, no multi-community UI, member content not gated for an
 * unknown pubkey, invite creation still gated, no page errors. Publishes nothing, signs nothing.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const RANDOM_PK = 'cd'.repeat(32);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 160)));
await page.goto('https://sos010.com/videos.html?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.SosFeatureFlags && window.SosFeatureFlags.isResolved(), null, { timeout: 30000 });
await page
  .waitForFunction(() => {
    const G = window.NostrApp && window.NostrApp.GroupControlState;
    return G && G.getStatus('israel-network') === 'VERIFIED';
  }, null, { timeout: 90000 })
  .catch(() => {});
await page.waitForTimeout(3000);
const out = await page.evaluate((pk) => {
  const App = window.NostrApp || {};
  const MS = App.MembershipState;
  const G = App.GroupControlState;
  const AC = App.AccessControl;
  if (MS && MS.ensureCache) MS.ensureCache();
  const st = G ? G.getVerifiedControlState('israel-network') : null;
  const chain = G && st ? G.getVerifiedControlChain('israel-network').map((r) => r.eventId) : [];
  return {
    version: (document.querySelector('script[src*="feature-flags.js"]') || {}).src || '',
    v2: window.SOS_ACCESS_CONTROL_V2 === true,
    scope: window.SosFeatureFlags.accessControlV2Scope(),
    admin2fa: window.SosFeatureFlags.isAdmin2faEnforced(),
    controlStatus: G ? G.getStatus('israel-network') : null,
    controlEpoch: st ? st.controlEpoch : null,
    root: st ? st.rootAdminPubkey : null,
    chain,
    feedSelectionButton: !!document.getElementById('sosFeedSelBtn'),
    post: MS ? MS.canPerformMemberAction(pk, 'post_create') : null,
    reaction: MS ? MS.canPerformMemberAction(pk, 'reaction') : null,
    p2p: MS ? MS.canPerformMemberAction(pk, 'group_p2p_signal') : null,
    inviteCreate: MS ? MS.canPerformMemberAction(pk, 'invite_create') : null,
    unknownCaps: AC ? AC.getCapabilities(pk, 'israel-network') : null,
    feedTag: typeof App.resolveFeedNetworkTag === 'function' ? App.resolveFeedNetworkTag() : null,
  };
}, RANDOM_PK);
await browser.close();
const checks = {
  PROD_V2_ON_CONTROL_PLANE: out.v2 === true && out.scope === 'CONTROL_PLANE' && out.admin2fa === true,
  PROD_CHAIN_VERIFIED: out.controlStatus === 'VERIFIED' && out.controlEpoch === 2 && out.chain[0] === '69a27d4a441dc5e9067567332c02641db11733d988228e24fc4869604db20df3' && out.chain[1] === '02263f81915e0b8fd34cc92d6acbd590560d426d003d850492a8e1f8257d2833' && out.root === 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601',
  PROD_NO_MULTI_COMMUNITY_UI: out.feedSelectionButton === false && out.feedTag === 'israel-network',
  PROD_UNKNOWN_USER_CONTENT_NOT_GATED: !!(out.post && out.post.ok && out.reaction && out.reaction.ok && out.p2p && out.p2p.ok),
  PROD_UNKNOWN_USER_NO_INVITE_NO_CAPS: !!(out.inviteCreate && out.inviteCreate.ok === false) && Array.isArray(out.unknownCaps) && out.unknownCaps.length === 0,
  PROD_NO_PAGE_ERRORS: errors.length === 0,
};
const pass = Object.values(checks).every(Boolean);
fs.writeFileSync(new URL('./gate4-production-browser-report.json', import.meta.url), JSON.stringify({ checks, out, errors, GATE4_PRODUCTION_BROWSER: pass ? 'PASS' : 'FAIL' }, null, 2));
Object.entries(checks).forEach(([k, v]) => console.log((v ? 'PASS ' : 'FAIL ') + k));
if (!pass) console.log(JSON.stringify({ out, errors }));
console.log('GATE4_PRODUCTION_BROWSER=' + (pass ? 'PASS' : 'FAIL'));
process.exit(0);
