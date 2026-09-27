# Package 896 — Canonical Feature Flag Release Plan

**Status:** RC, not deployed. Owner approval required for every step below.

| Field | Value |
|-------|-------|
| Package | Web 896 / `sos-cache-v896` |
| Base | Package 895 `623c94f6e2b25471b4814cdcb74851f692263a1e` (production) |
| Shipped flag | `runtime-feature-flags.json` → `{"schema":"sos-feature-flags-v1","accessControlV2":false}` |
| Code rollback | Package 895 `623c94f6e2b25471b4814cdcb74851f692263a1e` |
| Flag rollback | config back to `false` |
| RC gate | `qa/package896-rc-gate.mjs` → `qa/package896-rc-report.json` |
| RC SHA / tree | see `qa/package896-rc-report.json` and the RC report returned to the owner |

## What changes

- `feature-flags.js` (new): canonical fail-closed loader, production write guard, safe diagnostics.
- `runtime-feature-flags.json` (new): the only production switch.
- `videos.html`: loads `feature-flags.js` synchronously before any V2 module; `pkg=896`.
- `service-worker.js`: never intercepts `runtime-feature-flags.json`; `sos-cache-v896`.
- V2 UIs (`group-admin-product-ui.js`, `admin-settings-ui.js`, `member-directory-ui.js`,
  `community-feed-selection.js`) boot on `sos-feature-flags-ready`; feed selector and
  community branding / feed scoping are now hidden when V2 is OFF (895 showed "הפיד שלי").
- No Android / APK / MD4 change.

## Steps

### A — Deploy 896 with V2 OFF
Merge RC to `main` (fast-forward, no force), wait for Pages deploy.
Confirm `https://sos010.com/runtime-feature-flags.json` returns `accessControlV2:false`.

### B — Production smoke (V2 OFF)
- `app-version.json` = `2026.09.27-web-896`, SW cache `sos-cache-v896`
- `SosFeatureFlags.snapshot()` → `resolved:true`, `accessControlV2:false`, `productionHost:true`
- No "יצירת קבוצה" / "ניהול קבוצה" / "הפיד שלי"
- `?acv2=1`, localStorage, sessionStorage, console write → still OFF
- Identity, feed, chat, P2P, calls OK; SIGN_FEED kinds `[1,6]`
- Failure => rollback to 895.

### C — Separate owner approval
Explicit written approval to enable Access Control V2 in production. Not implied by A/B.

### D — Config ON
Change only `runtime-feature-flags.json` to `{"schema":"sos-feature-flags-v1","accessControlV2":true}`,
commit, push, wait for Pages deploy. No functional code change.
Propagation: Pages deploy + up to ~10 minutes Fastly + user reload.

### E — Production community acceptance
- `SosFeatureFlags.snapshot().source === 'canonical_config'`
- Create community (name/logo/description), branding switch, feed selector, admin menu,
  invite/QR, member removal, privilege denial for non-admin, cross-community chat/calls, P2P.

### F — Rollback = config OFF
Set `accessControlV2` back to `false`, commit, push. Applies after deploy + CDN + reload.
Signed community state is kept; UI hides; legacy paths resume.
If code itself regresses: roll back to Package 895 `623c94f6e2b25471b4814cdcb74851f692263a1e`.

## Change control

MAIN_PUSH_EXECUTED=false, MAIN_DEPLOY_EXECUTED=false, CDN_PRODUCTION_CHANGED=false,
PRODUCTION_ACCESS_CONTROL_CHANGED=false until the owner approves each step.
