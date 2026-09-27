# Access Control V2 — Activation Plan (NOT EXECUTED)

**Status:** draft for owner approval only.  
**Production now:** Package 897 (`16f43ae6f81406c68944b66770b248b27137c643`, `sos-cache-v897`), `SOS_ACCESS_CONTROL_V2=false`.  
**Candidate:** Package **898** RC — first-group network-backed administration (not deployed, flag ships OFF).

## Package 898 first-group activation readiness

- First-group admin state is network-backed (`docs/FIRST_GROUP_NETWORK_AUTHORITY.md`); the three-browser
  network E2E, fresh profile, remote capability, cross-user join, gateway and adversarial suites pass.
- **Blocker:** `NETWORK_DOUBLE_REDEEM_GATE=BLOCKED_DISTRIBUTED_SERIALIZATION`. Single-use invites are only
  serialized while exactly one ROOT / MANAGE_MEMBERS client approves joins. Before controlled activation the owner
  must choose the serialization model (designated join-serializer key / root-only approval, or a convergent
  resolver rule) — see the "Double redeem" section of the authority doc.
- Operational precondition for activation even after that decision: at least one approver client online, otherwise
  redemptions wait (they are not lost; they are approved on the approver's next sync).
- Rollback after activation must be flag OFF (forward-only): 897 validators reject 898 d-tags.
- `FIRST_GROUP_V2_READY_FOR_CONTROLLED_PRODUCTION_ACTIVATION=false` until the blocker is resolved.

## Product model (must stay true after activation)

- SOS010 = **one global** communication network
- Global identity = single **P**
- Global: user search, direct chat, P2P, audio/video calls (membership not required)
- Community-scoped: branding, content, membership, admins, roles, permissions, invites, moderation, settings
- Feed = union of user-selected communities (selection ≠ membership)
- Authorization = `(P, communityId, capability)`

## Activation mechanism (Package 896)

Package 895 had no canonical production switch: the production host forces the flag
OFF and ignores query/storage. Package 896 adds the single canonical source:

- File: `/runtime-feature-flags.json` (same origin, deployed with the site)
- Content: `{"schema":"sos-feature-flags-v1","accessControlV2":false}`
- Loader: `feature-flags.js` (synchronous, first in `videos.html`, before any V2 module)
- Only `true` in a valid `sos-feature-flags-v1` document enables V2.
- Missing / unreachable / timeout (5s) / malformed / unknown schema / unknown key /
  non-boolean value => **OFF** (fail-closed).
- Flag reads `false` until the config resolves; V2 UIs boot on `sos-feature-flags-ready`.
- On non-local hosts writes to `window.SOS_ACCESS_CONTROL_V2` are ignored, so query,
  fragment, localStorage, sessionStorage and DOM cannot enable V2.
- The flag is **not** the authorization boundary. Signed control state and
  `(P, communityId, capability)` checks stay enforced whether the UI is visible or not.
- Diagnostics: `SosFeatureFlags.snapshot()` (schema, value, source, errorCode, host mode). No secrets.

### Toggle = config-only change

Enable: set `"accessControlV2":true` in `runtime-feature-flags.json` and deploy (no code change).  
Disable / rollback: set it back to `false` and deploy.

### Cache and propagation

- Service Worker never intercepts `runtime-feature-flags.json` (same rule as `app-version.json`),
  so it is never served from SW cache; offline => fetch fails => OFF.
- Loader fetches with `cache: 'no-store'` and a timestamp query.
- GitHub Pages / Fastly may keep the old file up to ~10 minutes after deploy.
- A running tab keeps the value it resolved at load; the new value applies on the next page load.
- Expected propagation: Pages deploy + up to ~10 minutes CDN + user reload.

## Preconditions

1. `qa/package896-rc-gate.mjs` PASS on the exact RC tree
2. Package 896 deployed with `accessControlV2=false` and production smoke PASS
3. Separate explicit owner approval to enable

## Packaging

| Field | Value |
|-------|-------|
| NEXT_WEB_PACKAGE | 896 |
| NEXT_CACHE_VERSION | sos-cache-v896 |
| FLAG_DEFAULT | `runtime-feature-flags.json` → `accessControlV2=false` |
| FLAG ROLLBACK | config back to `false` (no code change) |
| CODE ROLLBACK | Package 895 / `623c94f6e2b25471b4814cdcb74851f692263a1e` / `sos-cache-v895` |

## Activation sequence (owner-gated)

See `docs/PACKAGE896_FEATURE_FLAG_RELEASE_PLAN.md` steps A–F.

## Local test (developers)

- Same config path: serve `runtime-feature-flags.json` with `true` locally.
- Local helper still works only on localhost / 127.0.0.1 / LAN / file:
  `?acv2=1` or `localStorage.setItem('SOS_ACCESS_CONTROL_V2_LOCAL_TEST','1')`
- Production host **cannot** enable via query/storage/DOM.

## Out of scope until approved

- Production flag ON
- Android / APK / MD4
- Push incomplete work to main
