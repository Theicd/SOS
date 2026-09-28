# First Group Admission Authority — Package 898

Scope: FIRST group only (`israel-network`). Purpose: make single-use invitation redemption atomic.
`DOUBLE_REDEEM_SCOPE=NETWORK_SERIALIZED_AUTHORITY`. Invariant: one single-use invite + N concurrent redeems
(any browsers, devices, relays, Worker instances) = exactly one `ACCEPTED`; every other attempt gets a canonical
non-success result. No relay-order, browser-order or localStorage authority. `UNSERIALIZED_FALLBACK_ENABLED=false`.

Code: `admission-service/` (Cloudflare Worker + Durable Objects), client `first-group-admission-client.js`
(`App.FirstGroupAdmission`), used by `invite-service.js` only when V2 is ON and the tag is `israel-network`.
Package 898 ships `App.FIRST_GROUP_ADMISSION_URL = ''` and `ACCESS_CONTROL_V2` OFF: nothing changes in production.

## Durable Object topology

| Object | Key | Holds |
| --- | --- | --- |
| `InviteLedger` (SQLite DO) | `idFromName('israel-network:' + inviteEventId)` — one per invite | one ledger row: state, invite hash, creator, expiry, redeemer, operation id, proof |
| `GroupAuthority` (SQLite DO) | `idFromName('israel-network')` — one per group | verified 39001 control chain + conflict candidates (max 2000), cached snapshot |

Cloudflare guarantees one live instance per DO id worldwide, and requests to one instance run one at a time
between awaits. Every Worker isolate that receives a redeem for the same invite forwards it to the same object, so
serialization does not depend on which edge or isolate received the request.

HTTP (JSON only, error codes never include secrets): `GET /v1/health`, `POST /v1/control/ingest`,
`/v1/invites/register`, `/v1/invites/redeem`, `/v1/invites/revoke`, `/v1/invites/status`.
`/v1/test/inspect` exists only when `TEST_FAULTS=1` (staging / local), never in production config.
CORS is an allowlist for browsers, not authorization; authorization is the signed events.

## Ledger and state machine

```
UNUSED --redeem CAS--> CLAIMED --finalize--> REDEEMED
UNUSED --revoke CAS--> REVOKED
UNUSED --expiry (service clock)--> EXPIRED
```

- The transition is one `transactionSync` with `UPDATE invite SET state=? … WHERE k=1 AND state=?` and a
  `rowsWritten === 1` check. It runs after every await (signature and policy checks happen first), so no other
  request can interleave between the read and the write.
- `CLAIMED` never returns to `UNUSED`. `REVOKED`, `EXPIRED`, `REDEEMED` are terminal.
- Canonical results: `ACCEPTED`, `ALREADY_REDEEMED`, `REVOKED`, `EXPIRED`, `INVALID`, `UNAUTHORIZED`,
  `TEMPORARILY_UNAVAILABLE`.

## Idempotency and recovery

- The redeem request is a kind-37379 event signed by the redeemer with tags `op` (random operation id),
  `member-revision`, `svc=sos-first-group-admission-v1`, `e`, `d`, `ih`, `t=israel-network`. Freshness 300 s.
- Same redeemer + same operation id → the same `ACCEPTED` proof (replay-safe). A different redeemer or operation
  → `ALREADY_REDEEMED`. A replayed request can only ever admit its original signer.
- Response loss: the client keeps the operation id (localStorage hint only) and retries; the ledger returns the
  stored proof. Verified with a dropped HTTP response in the browser and in the service gate.
- Finalization: the claim is written first, then the service signs the proof and writes `REDEEMED` + proof in a
  second CAS (`WHERE state='CLAIMED' AND redeemer=? AND op_id=?`). A crash between the two leaves `CLAIMED`; a DO
  alarm (15 s, then 60 s) and any retry finish it. The winner cannot change during recovery.
- Register is idempotent: re-registering the same signed invite event returns `REGISTERED` (`replay: true`) and
  never resets the ledger state.

## Delegation

- ROOT keeps its private key on the user's device. It grants the service pubkey exactly one control capability:
  `FINALIZE_MEMBERSHIP_ADMISSION` (`FirstGroupAdmin.setAdmissionDelegate`, ROOT only, signed 39001).
- The capability is ROOT-only and not delegable (absent from `DELEGABLE_BY_PERMISSION_MANAGER`). Its holder cannot
  issue control events, cannot hold other capabilities (`DELEGATE_HAS_OTHER_CAPABILITIES`), and does not receive
  MANAGE_ADMINS, MANAGE_PERMISSIONS, MANAGE_MEMBERS, MODERATE_CONTENT or any generic signing authority.
- Group-bound: validity is checked against the `israel-network` control chain; a proof for another group is rejected.
- A proof (kind 39003 `GRANT_ACTIVE`, tag `['admission', inviteEventId]`, body `admission{schema, version,
  inviteEventId, redeemerPubkey, groupId, operationId}`) is valid in `MembershipState` only if the issuer holds
  the capability for that control epoch and the proof binds exactly that invite, redeemer and group.
- `PRODUCTION_ROOT_DELEGATION_CREATED=false`: all tests use disposable QA keys.

## Service key security

- The service has its own secp256k1 key in Cloudflare secret `ADMISSION_SK` (`wrangler secret put`, stdin).
  Never in `wrangler.toml`, source, git, KV, D1, R2, DO storage, logs, responses, or the client.
- `keys.js` exposes only `servicePubkey()` and `signAdmissionProof()`, which refuses anything that is not a kind
  39003 `GRANT_ACTIVE` draft carrying the admission binding.
- The ROOT private key is not on any server: the Worker only has `ROOT_PUBKEY` (a var).
- Local secrets (`.dev.vars`, `.staging-keys.json`) are gitignored and deleted after each run.
- Service logs are scanned for secrets in the gates (0 hits).

## Rotation

- Planned: ROOT grants `FINALIZE_MEMBERSHIP_ADMISSION` to the new key, then `retireAdmissionDelegate(old)` adds
  `FINALIZE_MEMBERSHIP_ADMISSION_RETIRED` before removing the active capability. Proofs issued while the old key
  was active stay valid; the retired key cannot issue new ones.
- Compromise: `revokeAdmissionDelegate(old)` removes both capabilities. All proofs of that key stop validating.
  Affected members must be re-admitted by a new key.
- `ROOT_KEY_ROTATION_REQUIRED=false`: rotating the service key never touches the ROOT key.

## Registration policy

- `INVITE_MEMBERS` authority (policy AUTHORIZED_USERS_ONLY → ROOT / INVITE_USERS / admin principal) is checked at
  registration time against the service's verified control view. Registration must succeed before the invite is
  published or shown as a QR.
- A registered invite stays redeemable after the inviter later loses the capability; new registrations by that
  user are denied. Blocklisted inviter or redeemer → `UNAUTHORIZED`; self-redeem → `INVALID`.
- Expiry must be in the future and ≤ 31 days; `created_at` within ±600 s of service time.

## Revoke/redeem race

Both are CAS transitions out of `UNUSED` on the same object, so exactly one wins: either `REVOKED` (redeem then
gets `REVOKED`) or `CLAIMED` (revoke then gets `ALREADY_REDEEMED`). Never both. The gate runs the race with
jitter and observes both orderings, always with one consistent outcome.

## Expiry clock

Expiry is evaluated only on the service clock. The client's local expiry check is a UX hint.
`CLIENT_CLOCK_CAN_BYPASS_EXPIRATION=false`: a request signed with a forged `created_at` cannot redeem an expired invite.

## Outage behavior

Fail closed. Service unreachable, no verified control, delegation not active, or conflict →
`TEMPORARILY_UNAVAILABLE`; nothing is claimed and no local fallback approves joins
(`maybeApproveJoins` returns `UNSERIALIZED_FALLBACK_DISABLED`, `approveJoin` returns `ADMISSION_SERVICE_REQUIRED`).
Existing members, chat, feed, P2P and calls do not depend on the service.

The service's control view is fed by clients (`/v1/control/ingest` before every register / redeem / revoke) and
is re-verified with the same client code (`group-control-state.js`, `invite-policy.js`,
`nostr-event-integrity.js`). If no client pushes a newer revocation, the service acts on older control until one
does (residual, documented).

## Privacy

The service stores the invite hash (`ih`), invite event id, creator / redeemer pubkeys, timestamps, state and
the signed proof. It never receives the plaintext invite code, nsec, raw K, conversation or file keys.
`status` requires the invite code hash match and returns only the state class. Test inspection is disabled in production.

## Staging to production rollout

1. Done in 898: local workerd gate, then Cloudflare staging (`sos-first-group-admission-staging`, workers.dev only,
   no routes, no custom domain, disposable QA keys, `TEST_FAULTS=1`), gate PASS, Worker deleted afterwards.
2. Owner approval: create the production Worker (no `TEST_FAULTS`), set `ADMISSION_SK` as a secret, set
   `ROOT_PUBKEY`, `ALLOWED_ORIGINS=https://sos010.com`. No DNS change needed (workers.dev) unless the owner asks.
3. ROOT signs `setAdmissionDelegate(<service pubkey>)` from the owner's device.
4. Web package sets `App.FIRST_GROUP_ADMISSION_URL`; V2 is activated separately (see `ACCESS_CONTROL_V2_ACTIVATION_PLAN.md`).
5. Rollback: flag OFF, or `revokeAdmissionDelegate`; the ledger stays for audit.

Current state: `PRODUCTION_ADMISSION_SERVICE_DEPLOYED=false`, `PRODUCTION_DNS_CHANGED=false`,
`PRODUCTION_V2_ACTIVATED=false`.
