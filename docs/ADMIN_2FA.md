# Admin 2FA (server PIN + co-sign) — first group `israel-network`

Goal: a copied ROOT private key alone must not be enough for privileged SOS admin actions. Every privileged
event needs a second, server-held factor: a kind 39004 attestation signed by the Admin 2FA service key, issued
only inside an admin PIN session.

No secrets in this file. The PIN, pepper, verifier, session ids and private keys are never written anywhere.

## Phase 1 checkpoint (commit `2ec6aca`, branch `local/admin-cosign-s1`, local only)

| Field | Value |
| --- | --- |
| Gate | `qa/admin-cosign-s1-gate.mjs` 36/36 PASS; `qa/package898-admission-service-gate.mjs` 46/46 PASS |
| Build | `wrangler deploy --dry-run --env production` only (bindings `INVITES`, `GROUP`, `ADMIN_PIN`) |
| `PRODUCTION_DEPLOYED` | `false` |
| `ROOT_EVENT_WITHOUT_ATTESTATION_ACCEPTED` | `true` at Phase 1: clients do not check attestations yet (Phase 2 closes this) |

`ADMIN_2FA_PROTOCOL` (as committed in Phase 1):

- Request auth: kind 27235 signed by the admin key. Tags `u=sos-admin-pin:v1:<action>`, `method=POST`,
  `payload=sha256(params JSON string)`, `t=israel-network`, `nonce=<32..64 hex>`, `sos-admin-pin=v1`.
  Freshness ±120 s against the service clock. Single use: the auth event id is stored (600 s retention) and a
  second use returns `AUTH_REPLAY`. Principal = ROOT (`env.ROOT_PUBKEY`) or an admin principal of the verified chain.
- Actions: `params`, `enroll` (only while no verifier exists; conditional write, no replacement), `verify`,
  `cosign`, `lock`.
- Attestation: kind 39004, signed with `ADMIN_COSIGN_SK`. Tags `d=<group>:<eventId>`, `e=<eventId>`,
  `p=<principal>`, `t=<group>`, `sos-cosign=v1`. Content
  `{schema:'sos-admin-cosign', version:1, groupId, eventId, eventKind:39001, controlEpoch, principal, stepUp}`.
- Co-signable kinds in Phase 1: 39001 only. The event must pass the service's own dry-run chain validation,
  `event.pubkey` must equal the session principal, and destructive changes need the PIN again (`stepUp`).

`ADMIN_2FA_SIGNER_PUBLIC_KEY`: not provisioned for production. `ADMIN_COSIGN_SK` has not been created in
Cloudflare; it is created at deploy time (Phase 4) and its public key is then read from `GET /v1/health`
(`cosignPubkey`). Local gates use a disposable key generated per run (not recorded).

`PIN_VERIFIER_CONSTRUCTION`:

- Client: `derived = PBKDF2-HMAC-SHA256(PIN, salt, 600000 iterations, 32 bytes)`; `salt` = 16 random bytes per
  principal from the service. The PIN never leaves the device.
- Service: `verifier = HMAC-SHA256(key = ADMIN_PIN_PEPPER (32-byte secret), "sos-admin-pin-v1|" + principal + "|" + salt + "|" + derivedHex)`.
  Only `salt` + `verifier` are stored (SQLite Durable Object `AdminPinAuthority`). Constant-time compare.
- Lockout per principal: 3 free failures, then 30 s, 60 s, 5 min doubling, 1 h cap; plus a ceiling of 30 guesses
  per minute per instance. Sessions: 32 random bytes returned once, only `sha256(session)` stored; 15 min idle,
  12 h absolute, `lock` revokes.

`ADMIN_2FA_REPLAY_GATE`: PASS — `AUTH_REPLAY_DENIED`, `NO_NONCE`, `STALE_AUTH` (past and future),
`PAYLOAD_MISMATCH`, `WRONG_ACTION`, `CROSS_GROUP`, `STRICT_VERIFY_FAILED`, `ENROLL_RACE_NO_OVERWRITE`.

Proposed PIN reset (not implemented): ROOT-signed reset request plus an out-of-band confirmation, then a 24–72 h
waiting period during which the current PIN can cancel.

## Phase 2 — client verification (branch `local/admin-2fa-p2`, local only)

One protocol module, `admin-2fa-protocol.js`, is shared by the web client and the admission Worker (the Worker
imports it through `shim.js`). There is no second format.

- Attestation content (Phase 1 content plus): `protocol:'sos-admin-2fa-v1'`, `rootPubkey`, `operations` (sorted),
  `issuedAt` (= `created_at`), `expiresAt` (= `issuedAt` + 600), `requestId` (= auth event id). Tags are exactly
  `d`, `e`, `p`, `t`, `sos-cosign`. `signAttestation` refuses any other shape.
- `verifyAdmin2faAttestation(rootEvent, attestation, context)` checks kind, signature, pinned signer, group,
  canonical ROOT, exact event id / kind / epoch / principal, exact operations, `issuedAt`/`expiresAt`, request id,
  and the privileged event's own signature. Anything missing or malformed fails closed.
- Enforcement: `admin2faEnforcement` + `admin2faSignerPubkey` in the canonical `runtime-feature-flags.json`, or
  the build constant. No query / localStorage / window override. Enforced with no signer rejects everything.
  Production stays OFF.
- Routed paths when enforced: control chain (`group-control-state.js`, all reconstruct call sites), moderation,
  membership (non-admission), revoke of another user's invite, kind 5 deletion of another user's post.
  An unattested event returns `ADMIN_2FA_REQUIRED`. Own-content actions are unchanged.
- Genesis must bind `admin2faSignerPubkey`; it is immutable and root-only afterwards.
- The Worker validates with `previewControlTransition` (dry run, no attestation needed) before co-signing.

Gates: `qa/admin-2fa-client-gate.mjs` 69/69 (negatives 34/34), `qa/admin-cosign-s1-gate.mjs` 40/40.

Known limits: the attestation store is memory-only; non-39001 privileged kinds cannot be co-signed yet, so they
fail closed under enforcement until Phase 3.

## Phase 3 — web UI + server integration (branch `local/admin-2fa-p3`, local only)

The server is the only PIN authority. The existing Hebrew dialogs (`הגדרת קוד מנהל`, `קוד מנהל`) and the
`שליטה על הקבוצה` menu are kept; `admin-pin-lock.js` is now a facade over `admin-2fa-client.js` and has no local
verifier (IndexedDB code removed, old local data neither uploaded nor migrated).

- `admin-2fa-client.js`: admin state from `/v1/admin-pin/session` (`PIN_NOT_CONFIGURED`, `PIN_CONFIGURED_LOCKED`,
  `ADMIN_SESSION_ACTIVE`, `ADMIN_2FA_SERVICE_UNAVAILABLE`). Enrollment / verify use the Phase 1 protocol (PBKDF2
  600k on the client, pepper + slow verifier on the server, server lockout). The admin session lives in memory only,
  15 min idle, bound to identity, session generation, group and protocol; logout, account switch or mismatch clear it.
  Every request is signed with kind 27235 through `SosCryptoSigner.signAdmin2faAuth` (fixed action set, no generic signing).
- Privileged pipeline (all senders): build → sign → `attest()` (push control, server co-sign, local
  `verifyAdmin2faAttestation`) → publish attestation → publish event. Any failure publishes nothing.
  Senders: `group-control-mutations.js`, `member-admin-operations.js`, `invite-policy.js`, `invite-service.js`,
  `feed.js` (moderation / other-user deletion), `first-group-admin.js` (BOOTSTRAP).
- Server co-sign (`admission-service/src/pin.js` `classify`) accepts only: control transitions (39001), moderation
  (39002), non-admission membership (39003), revoke of another author's invite (37380), kind 5 of another author's
  post. Own content / own invites are rejected as not privileged. Role / permission changes are attested as
  capability diffs.
- Canonical re-auth policy (`STEP_UP_OPERATIONS`, `STEP_UP_WHEN_TARGET_IS_ADMIN` in `admin-2fa-protocol.js`, used by
  the server): a fresh PIN is required for DEMOTE_ADMIN, CHANGE_GROUP_POLICY, admission delegation create / revoke,
  and removing or blocking an admin. Viewing never needs re-auth.
- The group-control panel needs a server admin session for the root and admin-tier principals. Invite-only helpers
  hold no admin power and get no server session.
- Receivers fetch kind 39004 attestations with the control / feed filters.
- Service down or not configured: fail closed with `שירות אימות המנהל אינו זמין כרגע`. No ROOT-only fallback.
- Gate 1.5 package: `FirstGroupAdmin.prepareGate15Package()` returns the ROOT-signed BOOTSTRAP + its verified
  attestation, publishes and applies nothing.
- Production unchanged: `admin2faEnforcement` off, `ACCESS_CONTROL_V2` off, `FIRST_GROUP_ADMISSION_URL` empty, so the
  admin panel stays closed (fail closed) until Phase 4 configures the service.

Gates: `qa/admin-2fa-phase3-gate.mjs` 48/48, `qa/admin-cosign-s1-gate.mjs` 40/40, `qa/admin-2fa-client-gate.mjs`
69/69, `qa/package899f-group-control-pin-gate.mjs` 34/34 (local service), `qa/package898-first-group-network-e2e.mjs`
51/51 (enforcement on, local relays + local service).

Known limits: the attestation store is memory-only (cached control needs its attestations from relays); the ROOT
self-membership record at bootstrap is rejected by membership rules (`SELF_GRANT`) and is not co-signed; removing
an admin asks for the PIN twice (remove + demote cleanup).

## Phase 4: production rollout

- `config.js` `FIRST_GROUP_ADMISSION_URL` points at the production Worker. With `ACCESS_CONTROL_V2` off this only
  enables the Admin 2FA calls (invite admission and control push still need V2 / a verified control state).
- `/v1/health` reports `rootPinConfigured` (boolean only, from the `AdminPinAuthority` internal `status` action; no
  public route). Used to verify owner enrollment without any PIN material.
- Rollout order: server (co-sign + pepper secrets, `ADMISSION_SK` untouched), web with `admin2faEnforcement` off,
  owner enrolls the PIN in the UI, verify `rootPinConfigured=true`, then enable enforcement. Gate 1.5 stays frozen.
- Web package `2026.09.30-web-899p4` (`?pkg=899p4` on every script changed since 899g).

## Gate 1.5: attested genesis (web `2026.09.30-web-899g15`)

- `runtime-feature-flags.json`: `admin2faEnforcement: true`, `admin2faSignerPubkey` = the production co-sign public key.
  `ACCESS_CONTROL_V2` stays off. From here every privileged event needs a server attestation.
- Owner flow: "ניהול הקבוצה" → "הגדרות מתקדמות" → "הפעלת מערכת הניהול" (root only, shown only when the relays report no
  control events). `FirstGroupAdmin.activateGroupControl()` probes the relays, signs the exact BOOTSTRAP (signer pinned),
  gets the attestation inside the admin PIN session, verifies both locally, then publishes the attestation and the event.
  No membership, delegation or other grant.
- `FirstGroupAdmin.probeNetworkControl()` is a read-only relay check that works with V2 off (used by the status line:
  "מערכת הניהול הופעלה. שמירת שינויים תיפתח בשלב הבא.").
- Gate: `qa/gate15-activation-gate.mjs` (local relays + local service, production flag shape).

## Gate 2: admission service delegation (web `2026.09.30-web-899g2`)

- Admission service reads the control chain itself: kinds 39001/39004 from `CONTROL_RELAYS` (EOSE required per relay),
  on `/v1/health` (background, throttled 20s), `POST /v1/control/refresh` and a 10-minute cron. It enforces Admin 2FA
  attestations with the pinned `ADMIN_2FA_SIGNER_PUBKEY` (off-to-on only). Health reports `controlPlane`,
  `bootstrapEventId`, `controlTipEventId`, `delegatedCapabilities`, `lastRelayRefresh`. No V2 dependency.
- Owner flow: advanced settings, "admission service" section. `FirstGroupAdmin.activateAdmissionService()` probes the
  relays (fails if a delegation already exists), checks the service sees the same tip, signs one typed
  `GRANT_CAPABILITY` of `FINALIZE_MEMBERSHIP_ADMISSION` to the pinned service key, gets the attestation inside the PIN
  session, runs `checkDelegationPackage` (exact record delta, operations, attestation, transition preview), then
  publishes the attestation and the event. `deactivateAdmissionService()` is the same path with `REVOKE_CAPABILITY`.
- Gates: `qa/gate2-negatives.mjs` (offline), `qa/gate2-delegation-gate.mjs` (local relays + local service),
  `qa/gate2-production-verify.mjs pre|post` (read-only production check).
