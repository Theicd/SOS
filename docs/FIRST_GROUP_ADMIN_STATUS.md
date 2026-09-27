# First Group Admin Control Center — Package 897 status

Scope: the FIRST group only — community `sos010`, groupId / networkTag `israel-network`.
Multi-community network work, relay-sync and community discovery are paused for this phase.

Production is unchanged: Package 896, main `1b922c0312dfcd6feb2b4a127ef127b89997ba64`, `sos-cache-v896`,
`ACCESS_CONTROL_V2` OFF. Package 897 ships with `ACCESS_CONTROL_V2` OFF (`runtime-feature-flags.json`).

## Authority model

- `FIRST_GROUP_ID=israel-network`
- `FIRST_GROUP_SOURCE=CommunityContext.SOS010 (config.js NETWORK_TAG israel-network)`
- `FIRST_GROUP_AUTHORITY_MODEL`: signed kind-39001 control chain (exact +1 epochs). The epoch-1 root must be a
  configured `adminSourceKeys` pubkey (frozen snapshot; runtime edits to admin key lists are ignored).
  Delegated capabilities are effective only while the member's signed kind-39003 membership is ACTIVE and the
  pubkey is not blocklisted.
- Roles are a presentation layer over canonical capabilities (no parallel role system):
  ROOT, SENIOR_ADMIN (MANAGE_ADMINS / MANAGE_PERMISSIONS), ADMIN (MANAGE_MEMBERS), MODERATOR (MODERATE_CONTENT),
  INVITER (INVITE_USERS only), DELEGATE (other combinations), MEMBER.
- Only the root can grant MANAGE_ADMINS / MANAGE_PERMISSIONS. Holders of MANAGE_PERMISSIONS can grant delegable
  capabilities to others only. Self-grant is rejected (`SELF_GRANT_FORBIDDEN`).
- `LAST_OWNER_POLICY=ROOT_IMMUTABLE`: the configured root cannot be granted, revoked, demoted, blocked or removed,
  so the group can never be left without an owner.
- Every privileged operation goes through `FirstGroupAdmin.guard`: V2 on → identity → session authority →
  first-group context → shared-cache sync (stale tabs) → conflict check → signed effective authority.
  UI state, `isAdmin`, QA overlays, DOM and localStorage caches are not authority.
- `FIRST_GROUP_ADMIN_AUDIT_MODEL=SIGNED_CONTROL_CHAIN_PLUS_MEMBERSHIP_EVENTS`.

## COMPLETE_NOW

- "ניהול קבוצה" entry for users with admin capabilities; regular members see no admin menu.
- Hebrew dashboard: home, details, members, admins, roles/permissions, invites, QR, settings, security.
  Tabs are filtered by signed effective authority.
- Group metadata (name, logo, description) edit — signed `SET_GROUP_METADATA`, persists across reload.
- Member directory, remove member (with confirmation), join approval for redeemed invites.
- Admin list, promote (הוספת מנהל), demote (הסרת מנהל), granular permissions (שמירת הרשאות), role presets.
- Inviter-only delegation; delegated moderator; MANAGE_ADMINS / MANAGE_PERMISSIONS semantics.
- Invites: create, copy, QR render, QR parse bound to the first group, validate/redeem, revoke, expiry,
  double-redeem rejection. Invites of a user whose INVITE_USERS is revoked stop validating.
- QR payload is only the canonical invite URL (`/videos.html?invite=CODE`); strict parser rejects foreign
  origins, extra params, fragments and secret-like payloads. No root K, nsec, device key, file key or
  conversation key in QR.
- Adversarial: forged bootstrap, forged capability / membership / cache events, forged isAdmin / role / overlay /
  DOM / selected group, direct API calls, self-grant, stale tab, stale device, removed member.
- Session authority (valid / revoked / other account / re-login), account switch without leak, multi-tab sync,
  hard reload, typed signer boundaries (no generic raw signing surface).
- Destructive actions require an in-shell confirmation; cancel keeps state.
- Desktop and mobile layouts.

Verification scope:

- `E2E_SCOPE=LOCAL_CONTROLLED_E2E` — multi-user flows run in isolated browser contexts; signed control and
  membership events are transferred with `exportSignedState` / `importSignedState`, invites use a local
  in-memory relay stub. `NETWORK_BACKED_E2E=false`.
- `DOUBLE_REDEEM_SCOPE=LOCAL_ONLY` — double redeem is rejected by local used-state and relay used-events; it is
  not network-atomic.

Superseded gates (static checks for the deferred group-creation surface): `access-control-v2-product-gate`
(`GROUP_ADMIN_HEBREW_GATE` requires "יצירת קבוצה") and `access-control-v2-community-product-gate`.
They are replaced by `qa/package897-first-group-admin-e2e.mjs` and `qa/package897-rc-gate.mjs`.

## DEFERRED_TO_NEXT_PHASE

- Relay-backed multi-user propagation of the control chain (relays keep only the latest replaceable event, so
  the full chain cannot be reconstructed from relays yet).
- Cross-device staleness beyond the local peer: a stale device's own action is rejected by up-to-date peers,
  but there is no network push of revocations.
- Network-atomic double redeem.
- Invite create / revoke events in the audit log (currently chain diffs + membership events only).
- Root key rotation / root key loss recovery.
- New group / community creation and multi-community network protocol.
- Community discovery and cross-community relay synchronization.
- Server-side logging backend for admin actions.
