# Package 898 — First Group Network-Backed Administration — Release Plan (NOT EXECUTED)

| Field | Value |
| --- | --- |
| NEXT_WEB_PACKAGE | 898 |
| NEXT_CACHE_VERSION | sos-cache-v898 |
| app-version | 2026.09.28-web-898 |
| ACCESS_CONTROL_V2 shipped | `false` (`runtime-feature-flags.json`) |
| Base / rollback target | Package 897, `16f43ae6f81406c68944b66770b248b27137c643`, `sos-cache-v897` |
| RC gate | `qa/package898-rc-gate.mjs` → `qa/package898-rc-report.json` |
| Network E2E | `qa/package898-first-group-network-e2e.mjs` |
| Admission service gate | `qa/package898-admission-service-gate.mjs` (local workerd) + `qa/package898-admission-staging.mjs` (Cloudflare staging, deleted after run) |
| Status | see `qa/package898-rc-report.json` (`PACKAGE898_RC_STATUS`) |

## Delta

- `admission-service/` (new, not deployed): Cloudflare Worker + Durable Objects `InviteLedger` (per invite) and
  `GroupAuthority` (per group). Own service key as Cloudflare secret only. See `FIRST_GROUP_ADMISSION_AUTHORITY.md`.
- `first-group-admission-client.js` (new): register / redeem / revoke / status against the admission service,
  operation-id retry, control push; fail closed.
- `invite-service.js`: V2 first-group invites are registered before publish, redeemed and revoked via the service.
- `group-control-state.js` / `admin-signing-policy.js` / `membership-state.js`: ROOT-only, non-delegable
  `FINALIZE_MEMBERSHIP_ADMISSION` (+ `_RETIRED`) and admission-proof validation.
- `config.js`: `App.FIRST_GROUP_ADMISSION_URL = ''` (no production service in 898). `guest-auth.js`: admission error text.
- `first-group-network-authority.js` (new): relay fetch / live subscription / reconcile / fail-closed / control push
  to the admission service (no client-side join approval).
- `first-group-admin.js`: `nguard` (reconcile before every privileged action), sync-gated admin menu, network bootstrap.
- `group-admin-product-ui.js`: bootstrap prompt only after a relay confirmed there is no control; network state in fingerprint.
- `admin-signing-policy.js`, `group-control-state.js`, `membership-state.js`: per-epoch / per-revision d-tags
  (legacy accepted); `MembershipState.rebuildFromEvents`.
- `invite-service.js`: unique `d` on V2 invites (`ih`) and invite-used (`inviteEventId`).
- Version files: `videos.html` (pkg=898 + new script), `service-worker.js`, `sw-register.js`, `app-version.json`.
- No change to chat, P2P, calls, feed, signer core (`sos-crypto-signer.js`, worker, vault), Android.

## Why shipping with the flag OFF is safe

With `accessControlV2=false` the network module never starts, `nguard` is unreachable (every admin call returns
`V2_REQUIRED` first) and the admin UI is hidden. The d-tag / invite `d` changes only apply to V2 signing paths.

## Pre-deploy (owner-gated)

1. `qa/package898-rc-gate.mjs` on the exact RC tree; `PACKAGE898_RC_GATE=PASS`.
2. Explicit owner approval for Web deploy (flag OFF) — separate from the admission service deploy and from activation.

## Deploy (when approved)

`git push origin <RC SHA>:main` (fast-forward) → GitHub Pages → verify `app-version.json` = `2026.09.28-web-898`,
`sos-cache-v898`, flag `false`, production smoke (chat, P2P, calls, feed, invites).

## Admission service (separate approval)

Production Worker `wrangler deploy` (no `TEST_FAULTS`, no routes unless approved) → `wrangler secret put ADMISSION_SK`
(stdin, never in files) → `/v1/health` → ROOT signs `setAdmissionDelegate(<service pubkey>)` on the owner's device.
No DNS change required (workers.dev). The ROOT private key is never given to the service.

## Controlled activation (separate approval)

Web package sets `App.FIRST_GROUP_ADMISSION_URL`, then flag ON (config-only). Preconditions: admission service
healthy, delegation active, root key available. Monitor: control status VERIFIED on clients, admission results
(`ACCEPTED` / `ALREADY_REDEEMED`), no CONTROL_CONFLICT, no `TEMPORARILY_UNAVAILABLE` spikes.

## Rollback

- Before activation: code revert to 897 is safe (V2 never signed in production).
- After activation: flag OFF only (897 validators reject 898 d-tags).
- Admission service: `revokeAdmissionDelegate` stops new admissions immediately; the Worker can then be removed.

## 404 audit (production 897 and local 898, guest + logged in)

| URL | Class | Reason |
| --- | --- | --- |
| `/styles/game-doom-arena.css` | DEAD_ASSET_REFERENCE | `<link>` in `videos.html:113`; file never existed in git history; nothing uses it |
| `/game-doom-arena.js` | DEAD_ASSET_REFERENCE | `<script>` in `videos.html:3446`; never existed; Doom launcher opens `doom-multiplayer.html` (present) |

The eight 404 console lines of the 897 production acceptance are these two resources across four page loads.
No FUNCTIONAL_REGRESSION. Removing the two dead references is a separate cleanup (not in 898 scope).

## Deferred

New community creation, multi-community network sync / feed, cross-user new-community discovery,
community-creation relay propagation, MD4, Android / APK.
