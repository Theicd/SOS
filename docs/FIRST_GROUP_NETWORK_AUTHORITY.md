# First Group Network Authority — Package 898

Scope: first group only (`israel-network`). Module: `first-group-network-authority.js`
(`App.FirstGroupNetworkAuthority`). Active only when `ACCESS_CONTROL_V2` is ON (ships OFF).

## Network-authoritative vs cache

| Data | Authority | Cache |
| --- | --- | --- |
| Control chain (roles, capabilities, invite policy, metadata, blocklist) | signed kind-39001 events on relays, re-verified | `sos_group_control_v1_israel-network` |
| Membership of every user | signed kind-39003 events on relays, re-verified against current control | `sos_membership_v2_israel-network` |
| Invites / redemptions / revokes | signed 37378 / 37379 / 37380 on relays | in-memory `myInvites` (UI list only) |
| Admin UI state, selected tab, roles shown | derived | DOM only |

Authority = deterministic reconstruction of the *set* of valid signed events (network ∪ locally held signed events),
never the arrival order. Cached rows are signed events and are re-verified like network events; a cache entry
alone never grants anything to another user. `LOCAL_CACHE_IS_AUTHORITY=false`, `NETWORK_STATE_AUTHORITATIVE=true`.

## Event kinds and schema (canonical, no new kinds)

- 39001 `sos-group-control` v1 — tags `d=israel-network:<controlEpoch>`, `t=israel-network`, `t=sos-control`.
  Exact +1 epoch chain from the configured root; ≥2 valid different states at one epoch → `CONTROL_CONFLICT`
  (only a root `RESOLVE_CONTROL_CONFLICT` resolves it).
- 39003 `sos-group-membership` — tags `d=israel-network:<member>:<memberRevision>`, `p`, `t`, `status`,
  `member-revision`, `membership-epoch`, `control-epoch`. Per-member revision chain; delegated grants are valid
  only while the issuer holds the capability in the *current* control state.
- 37378 invite (V2) — `ih=sha256(code)`, `d=ih`, `t=israel-network`, `expiration`, `control-epoch`. No plaintext code.
- 37379 invite-used — `e=<invite id>`, `d=<invite id>`, `ih`, `p=<inviter>`, `t=israel-network`.
- 37380 invite revoke — `d=e=<invite id>`, `t=israel-network`, `control-epoch`.
- Legacy d-tags (`d=israel-network`, `d=israel-network:<member>`) are still accepted.

Why the d-tag change: 39001 / 39003 / 37378 are parameterized-replaceable, so NIP-01 relays keep only the newest
event per (pubkey, kind, d). With one d per group / member relays dropped the chain history (897 limitation) and
kept only an author's latest invite.

## Sync

1. `reconcile()` queries every configured relay for `{kinds:[39001,39003], '#t':['israel-network']}`; a relay
   counts only after EOSE (nostr-tools' own 4.4 s EOSE timer is disabled so silence never counts).
2. Events are merged by id with locally held signed events, sorted, ingested; membership is rebuilt from the full
   set against the current control state.
3. Live subscription (39001 / 39003 / 37379) with 150 ms debounce, 15 s poll, reconcile on `online`,
   `sos-identity-ready`, and before every privileged action.
4. Dead relay entries are evicted from the pool so a relay that was down reconnects.

Measured on local relays (E2E): grant 284 ms, promote 379 ms, revoke 309 ms, remove 361 ms, reconnect 145 ms.
Join admission latency is the service round-trip (staging 100-way race: p50 ≈ 640 ms, p95 ≈ 800 ms).

## Authorization

`FirstGroupAdmin.nguard(op)`: local guard (V2, identity, session authority, first-group context, conflict) →
network reconcile → guard again on the fresh state. Fails closed with `NETWORK_AUTHORITY_UNVERIFIED` when no relay
confirms, when control is not VERIFIED, or on `CONTROL_CONFLICT`. Peers independently re-verify every published
event, so a bypass of the gateway (direct low-level signing) is rejected by everyone else.

## Revocation

A revoke / demote / remove is a new signed event. Online users apply it within ~0.3 s (live). A user who is
offline keeps a stale cache but every privileged action fails closed until a relay confirms fresh state; on
reconnect the tab converges and the action is rejected as `UNAUTHORIZED`.

## Invites and joining

Creator authority is checked against the current control state (policy AUTHORIZED_USERS_ONLY → INVITE_USERS or
MANAGE_INVITES). With V2 ON, the invite must be registered with the admission service before it is published.
Redeem sends a signed 37379 request to the service; on `ACCEPTED` the client publishes the service-signed
39003 proof and the 37379 event. No client approves joins any more (`maybeApproveJoins` →
`UNSERIALIZED_FALLBACK_DISABLED`, `approveJoin` → `ADMISSION_SERVICE_REQUIRED`).

## Double redeem — NETWORK_SERIALIZED_AUTHORITY

Relays have no compare-and-set, so single-use cannot be decided from relay or browser order. Package 898 uses one
canonical serializer per invite: a Cloudflare Durable Object (`InviteLedger`) with an atomic `UNUSED → CLAIMED` CAS.
Exactly one redeem wins; the rest get `ALREADY_REDEEMED` / `REVOKED` / `EXPIRED`. The winner's membership is valid
only through a proof signed by the service key that ROOT delegated `FINALIZE_MEMBERSHIP_ADMISSION` to; every peer
re-verifies it. Full design: `FIRST_GROUP_ADMISSION_AUTHORITY.md`. Verified locally (workerd), on Cloudflare staging
(100-way race → 1 accepted), and in the three-browser E2E.

## Relay privacy (what relays can see)

Public by design (signed, unencrypted): member / admin pubkeys, capability map, statuses and revisions, invite
policy, group display name / description / logo reference, blocklist, timestamps, invite hash (`ih`), inviter and
redeemer pubkeys, invite expiration. Never on relays (E2E scan): nsec, raw K / private keys, plaintext invite codes,
file keys, conversation keys. Privacy semantics are unchanged from 897 (no redesign in 898).

## Stale tabs

Same-profile tabs share the signed cache via `localStorage` and each runs its own network sync. A stale tab's action
is re-checked against the network first; if it signs anyway, up-to-date peers reject it.

## Known limits

- Freshness is bounded by the union of reachable relays: if every relay withholds the newest event a client can act on
  older state (peers holding the newer state still reject the result).
- Same-author forks at one epoch collapse on relays (same pubkey + kind + d); a visible conflict needs two issuers.

## Rollback

Flag OFF (`runtime-feature-flags.json`) disables the module entirely. Code rollback: revert to Package 897
(`16f43ae`, `sos-cache-v897`). 897 validators require the legacy d-tags, so events signed by 898 would be rejected
after a rollback; this is safe only while V2 has never been activated in production (true today). After activation,
rollback must be forward-only (flag OFF), not a code revert.

## Deferred

New community creation, multi-community network sync / feed, cross-user community discovery, MD4, Android / APK.
