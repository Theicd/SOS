/**
 * Gate 4 real-browser scope check. Serves this worktree locally with runtime-feature-flags.json =
 * V2 on + accessControlV2Scope CONTROL_PLANE (production shape), then FULL, and compares:
 * multi-community UI, member-content gating for an unknown registered pubkey, control plane recognition.
 * Reads the live control chain from the production relays (read-only). Publishes nothing.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8811;
const SIGNER = '74c4bb0fb6b87b69cc2a95a80b4b5fa616cde3f917ef1894594606d30062edfa';
const RANDOM_PK = 'ab'.repeat(32);
let flagsBody = '';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/runtime-feature-flags.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(flagsBody);
  }
  const f = path.join(ROOT_DIR, p === '/' ? 'videos.html' : p.replace(/^\//, ''));
  if (!f.startsWith(ROOT_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end('nf');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });

async function run(scope) {
  const obj = { schema: 'sos-feature-flags-v1', accessControlV2: true, admin2faEnforcement: true, admin2faSignerPubkey: SIGNER };
  if (scope) obj.accessControlV2Scope = scope;
  flagsBody = JSON.stringify(obj);
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 120)));
  await page.goto('http://127.0.0.1:' + PORT + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.SosFeatureFlags && window.SosFeatureFlags.isResolved(), null, { timeout: 30000 });
  await page
    .waitForFunction(() => {
      const G = window.NostrApp && window.NostrApp.GroupControlState;
      return G && G.getStatus('israel-network') === 'VERIFIED';
    }, null, { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  const out = await page.evaluate((pk) => {
    const App = window.NostrApp || {};
    const MS = App.MembershipState;
    const G = App.GroupControlState;
    if (MS && MS.ensureCache) MS.ensureCache();
    const st = G ? G.getVerifiedControlState('israel-network') : null;
    return {
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      scope: window.SosFeatureFlags.accessControlV2Scope(),
      controlStatus: G ? G.getStatus('israel-network') : null,
      controlEpoch: st ? st.controlEpoch : null,
      feedSelectionButton: !!document.getElementById('sosFeedSelBtn'),
      post: MS ? MS.canPerformMemberAction(pk, 'post_create') : null,
      reaction: MS ? MS.canPerformMemberAction(pk, 'reaction') : null,
      p2p: MS ? MS.canPerformMemberAction(pk, 'group_p2p_signal') : null,
      inviteCreate: MS ? MS.canPerformMemberAction(pk, 'invite_create') : null,
      feedTag: typeof App.resolveFeedNetworkTag === 'function' ? App.resolveFeedNetworkTag() : null,
    };
  }, RANDOM_PK);
  await ctx.close();
  return Object.assign(out, { errors });
}

const cp = await run('CONTROL_PLANE');
const full = await run(null);
await browser.close();
server.close();
const checks = {
  CP_V2_ON_SCOPE_CONTROL_PLANE: cp.v2 === true && cp.scope === 'CONTROL_PLANE',
  CP_CONTROL_CHAIN_VERIFIED_EPOCH_2: cp.controlStatus === 'VERIFIED' && cp.controlEpoch === 2,
  CP_NO_MULTI_COMMUNITY_BUTTON: cp.feedSelectionButton === false,
  CP_UNKNOWN_USER_CAN_POST_REACT_P2P: !!(cp.post && cp.post.ok && cp.reaction && cp.reaction.ok && cp.p2p && cp.p2p.ok),
  CP_UNKNOWN_USER_CANNOT_CREATE_INVITE: !!(cp.inviteCreate && cp.inviteCreate.ok === false),
  CP_FEED_STAYS_ISRAEL_NETWORK: cp.feedTag === 'israel-network',
  FULL_SCOPE_WOULD_DENY_UNKNOWN_POST: !!(full.post && full.post.ok === false),
  FULL_SCOPE_SHOWS_MULTI_COMMUNITY_BUTTON: full.feedSelectionButton === true,
};
const pass = Object.values(checks).every(Boolean);
const report = { gate: 'gate4-browser-scope-check', checks, CONTROL_PLANE: cp, FULL: full, GATE4_BROWSER_SCOPE: pass ? 'PASS' : 'FAIL' };
fs.writeFileSync(new URL('./gate4-browser-scope-report.json', import.meta.url), JSON.stringify(report, null, 2));
Object.entries(checks).forEach(([k, v]) => console.log((v ? 'PASS ' : 'FAIL ') + k));
if (!pass) console.log(JSON.stringify({ cp, full }));
console.log('GATE4_BROWSER_SCOPE=' + report.GATE4_BROWSER_SCOPE);
process.exit(0);
