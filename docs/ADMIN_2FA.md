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
