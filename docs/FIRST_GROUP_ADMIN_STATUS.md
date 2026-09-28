# First Group Admin Control Center — Package 898 status

Scope: the FIRST group only — community `sos010`, groupId / networkTag `israel-network`.
Multi-community network work, new community creation, discovery and multi-community feed stay deferred.

Production is unchanged: Package 897, main `16f43ae6f81406c68944b66770b248b27137c643`, `sos-cache-v897`,
`ACCESS_CONTROL_V2` OFF. Package 898 ships with `ACCESS_CONTROL_V2` OFF (`runtime-feature-flags.json`).

## What changed from 897

- Authority is now network-backed: signed kind-39001 / kind-39003 events are fetched from the relay pool and
  re-verified by the canonical stores (`first-group-network-authority.js`). See `FIRST_GROUP_NETWORK_AUTHORITY.md`.
- Protocol d-tags: control `d = groupId:controlEpoch`, membership `d = groupId:member:memberRevision`,
  V2 invites `d = ih`, invite-used `d = inviteEventId`. Relays now keep the full chain (897: only the tip).
  Legacy d-tags are still accepted by the validators.
- Every privileged first-group action (`nguard`) reconciles with the relays first and fails closed
  (`NETWORK_AUTHORITY_UNVERIFIED`) when no relay confirms the state with EOSE, on control conflict, or when
  control is not VERIFIED.
- Join admission goes through the first-group admission service (single-use atomic claim, service-signed proof
  delegated by ROOT); C joins by B's QR without any manual export/import. See `FIRST_GROUP_ADMISSION_AUTHORITY.md`.
- The admin menu and all admin sections stay hidden until the first network sync (loading state).

## Authority model

- `FIRST_GROUP_ID=israel-network`
- Epoch-1 root must be a configured `adminSourceKeys` pubkey (frozen). Delegated capabilities are effective only
  while the member's signed membership is ACTIVE and the pubkey is not blocklisted.
- Roles are presentation over canonical capabilities: ROOT, SENIOR_ADMIN, ADMIN (MANAGE_MEMBERS),
  MODERATOR, INVITER (INVITE_USERS only), DELEGATE, MEMBER.
- `LAST_OWNER_POLICY=ROOT_IMMUTABLE`.
- `FIRST_GROUP_ADMIN_AUDIT_MODEL=SIGNED_CONTROL_CHAIN_PLUS_MEMBERSHIP_EVENTS`.

## COMPLETE_NOW

- Remote membership grant / remove, admin promote / demote, granular INVITE_USERS capability, capability revoke —
  all delivered to other users' browsers through the relays (live subscription + 15 s poll + reconcile on
  `online` and before every privileged action).
- Remote inviter: B (INVITE_USERS only) creates an invite and QR; C scans and joins; A and B see C; C reload keeps
  membership.
- Network invite revoke and expiry. Inviter authority is checked when the invite is registered with the admission
  service: a registered invite stays valid after the inviter loses INVITE_USERS; new registrations are denied.
- Fresh browser profile rebuilds authority from the network only.
- Multi-tab revocation, offline stale cache fails closed, reconnect converges.
- Account switch without leak.
- Adversarial: forged control / membership events, bad signature, wrong group, root tamper, stale replay,
  duplicate delivery, arrival order, one relay down, relay returning without newer events, silent relays,
  two-issuer control conflict.
- Typed signer only; no nsec / raw K / plaintext invite code on relays, in QR or in the DOM.

Verification: `E2E_SCOPE=NETWORK_BACKED_E2E` (`qa/package898-first-group-network-e2e.mjs`): three independent
persistent Chromium profiles (USER_A / USER_B / USER_C) plus isolated contexts, two real local NIP-01 WebSocket
relays with parameterized-replaceable semantics, the app's own nostr-tools pool. `NETWORK_BACKED_E2E=true`.

## Double redeem — resolved

- `NETWORK_DOUBLE_REDEEM_GATE=PASS`
- `DOUBLE_REDEEM_SCOPE=NETWORK_SERIALIZED_AUTHORITY`

One Durable Object per invite (`admission-service/`) performs an atomic `UNUSED → CLAIMED` compare-and-set; exactly one
redeem is accepted, others get canonical non-success results. ROOT delegates only `FINALIZE_MEMBERSHIP_ADMISSION` to
the service's own key; the ROOT private key never leaves the owner's device. Verified locally (workerd), on an
isolated Cloudflare staging Worker (deleted after the run) and in the three-browser E2E, including response loss,
revoke/redeem race, forged proofs and key rotation. Production service not deployed; `FIRST_GROUP_ADMISSION_URL`
is empty in 898.

## DEFERRED_TO_NEXT_PHASE

- Production admission service deployment + ROOT delegation (owner-gated).
- Service control view is fed by client pushes; a relay-subscribing service is a later hardening step.
- Freshness against all relays withholding the newest event (a client can only be as fresh as the union of
  reachable relays).
- Invite create / revoke events in the audit log.
- Root key rotation / root key loss recovery.
- New group / community creation, multi-community network sync / feed, cross-user community discovery.
- MD4. Android / APK untouched.
