# Group Admin Product Status

**Branch:** `local/access-control-v2-product`  
**Production baseline:** Package **894** / `c5e764fd15befc16d26d944a3fba5d1f29b2eb08` — **unchanged**  
**Production flag:** `SOS_ACCESS_CONTROL_V2=false` (must remain OFF)

## Canonical authority model

Single model (no parallel admin systems):

1. **GroupControlState** verified tip (signed `GROUP_CONTROL` / typed admin ops)
2. **MembershipState** verified tip (ACTIVE / BLOCKED / REMOVED / CONFLICT)
3. **AccessControl.hasCapability(pubkey, cap)** derived from verified control (+ root)
4. Mutations only via **GroupControlMutations** / **MemberAdminOperations** + **SIGN_ADMIN_TYPED**

`CLIENT_ONLY_ADMIN_TRUST=false` — localStorage / DOM / URL / forged `isAdmin` are not authority.

## Reconciliation (AC1–AC10)

| Component | Protocol | AuthZ | UI | Wired | Hidden by V2 | Gap |
|-----------|----------|-------|----|-------|--------------|-----|
| AccessControl | yes | yes | no | yes | provider switch | — |
| GroupControlState | yes | yes | no | yes | no | creator-root bootstrap (fixed locally) |
| GroupControlMutations | yes | yes | no | yes | yes | — |
| MembershipState | yes | yes | no | yes | yes | — |
| MemberAdminOperations | yes | yes | no | yes | yes | — |
| AdminSettingsUi | yes | visibility caps | yes | yes | yes | rename → ניהול קבוצה |
| MemberDirectoryUi | yes | yes | yes | yes | yes | — |
| InvitePolicy/Service | yes | yes | yes | yes | policy gate | — |
| Invite QR UI | yes | n/a | yes | yes | no | integrate into admin tabs |
| CommunityContext | yes | metadata only | partial | yes | no | Create Group product |
| ModerationPolicy | yes | yes | no | yes | yes | — |

Gate: `qa/access-control-v2-product-reconciliation-gate.mjs`

## Product shell (this branch)

| File | Role |
|------|------|
| `access-control-v2-local-test.js` | Local/test V2 enable (`?acv2=1` / localStorage); **blocked on sos010.com** |
| `group-admin-product-ui.js` | Hebrew shell: ניהול קבוצה, tabs, יצירת קבוצה, invites/QR hooks |
| `group-control-state.js` | Accept bootstrap when `issuer === rootAdminPubkey` for first tip |

## Local test mode

```
ACCESS_CONTROL_V2_DEFAULT_OFF=true
ACCESS_CONTROL_V2_LOCAL_TEST_MODE=true
PRODUCTION_ACCESS_CONTROL_CHANGED=false
```

Enable only on localhost / 127.0.0.1 / LAN / file: via `?acv2=1` or `localStorage.SOS_ACCESS_CONTROL_V2_LOCAL_TEST=1`.

## Not done yet (continue on this branch)

- Full three-role Playwright product flow gate
- Double-redeem / delegated moderation / membership adversarial product harness glue
- Activation plan + RC packaging (895) — **no deploy**

## Rollback

Discard this branch / do not merge. Production stays Package 894.
