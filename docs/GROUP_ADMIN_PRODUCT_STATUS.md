# Group Admin Product Status

**Branch:** `local/access-control-v2-product`  
**Production baseline:** Package **894** / `c5e764fd15befc16d26d944a3fba5d1f29b2eb08` — **unchanged**  
**Production flag:** `SOS_ACCESS_CONTROL_V2=false` (must remain OFF)  
**Next package (not deployed):** **895** / `sos-cache-v895`

## Product model (authoritative)

| Layer | Scope |
|-------|--------|
| **SOS010** | One **global** communication network |
| **Identity** | One global **P** (no per-community account / nsec / root key) |
| **Direct comms** | Global by peer **P↔P**: search, chat, files, voice msgs, P2P, audio/video calls — **membership not required** |
| **Community** | Independent scope for: branding, feed/content, membership, admins, roles, permissions, moderation, invites, settings |
| **Authorization** | `(P, communityId, capability)` — explicit community binding |
| **Feed** | `union(user-selected community feeds)` — selection ≠ membership |

## Canonical authority model

1. **GroupControlState** verified tip  
2. **MembershipState** verified tip  
3. **AccessControl.hasCapability(pubkey, cap)** (+ root)  
4. Mutations via typed admin ops (`SIGN_ADMIN_TYPED`)

`CLIENT_ONLY_ADMIN_TRUST=false`

## Landed locally (this branch)

| Area | Status |
|------|--------|
| Local V2 test mode (`?acv2=1`, blocked on sos010.com) | PASS |
| Group admin Hebrew shell + create UI (name/logo/description) | PASS |
| Creator-root bootstrap | PASS |
| Community directory persist + reload | PASS |
| Branding switch (network SOS010 ↔ community logo/name) | PASS |
| Feed selector «הפיד שלי» + multi `#t` query + attribution | PASS |
| Invite binds `communityId` + client double-redeem lock | PASS |
| Global identity / cross-community chat model (C0 + code) | PASS |
| Full headed QR/live-call product E2E | PENDING |
| Owner approval / deploy 895 | **blocked** (flag stays OFF) |

## Gates

- `qa/access-control-v2-product-gate.mjs`
- `qa/access-control-v2-community-product-gate.mjs`
- AC1–AC10 + C0 (existing)

## Local test

```
ACCESS_CONTROL_V2_DEFAULT_OFF=true
ACCESS_CONTROL_V2_LOCAL_TEST_MODE=true
PRODUCTION_ACCESS_CONTROL_CHANGED=false
```

Enable only on localhost / LAN / file: via `?acv2=1` or `localStorage.SOS_ACCESS_CONTROL_V2_LOCAL_TEST=1`.

## Rollback

Discard this branch / do not merge. Production stays Package 894.
