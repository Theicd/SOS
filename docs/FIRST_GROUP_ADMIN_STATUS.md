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
- Join approval is automatic on an online ROOT / MANAGE_MEMBERS client; C joins by B's QR without any
  manual export/import.
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
- Network invite revoke and expiry; invites of a user who lost INVITE_USERS stop validating.
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

## BLOCKED

- `NETWORK_DOUBLE_REDEEM_GATE=BLOCKED_DISTRIBUTED_SERIALIZATION`
- `DOUBLE_REDEEM_SCOPE=NETWORK_SINGLE_APPROVER_SERIALIZED`

With exactly one online approver, concurrent redemptions of one invite yield exactly one member (earliest valid
(created_at, id) after a 3 s settle window). With two approvers online the E2E shows the winner's two grants at the
same revision end in membership CONFLICT (no double membership, but the legitimate winner is stuck).
Nostr relays provide no compare-and-set, so the decentralized model cannot make single-use redemption atomic.
Architectural requirement and options: `FIRST_GROUP_NETWORK_AUTHORITY.md` → "Double redeem".

## DEFERRED_TO_NEXT_PHASE

- Atomic single-use redemption (designated serializer or convergent resolver rule — owner decision).
- Freshness against all relays withholding the newest event (a client can only be as fresh as the union of
  reachable relays).
- Invite create / revoke events in the audit log.
- Root key rotation / root key loss recovery.
- New group / community creation, multi-community network sync / feed, cross-user community discovery.
- MD4. Android / APK untouched.
