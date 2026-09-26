# Access Control V2 — Activation Plan (NOT EXECUTED)

**Status:** draft for owner approval only.  
**Production now:** Package 894, `SOS_ACCESS_CONTROL_V2=false`.  
**Local branch:** `local/access-control-v2-product` preparing Package **895** (not deployed).

## Product model (must stay true after activation)

- SOS010 = **one global** communication network
- Global identity = single **P**
- Global: user search, direct chat, P2P, audio/video calls (membership not required)
- Community-scoped: branding, content, membership, admins, roles, permissions, invites, moderation, settings
- Feed = union of user-selected communities (selection ≠ membership)
- Authorization = `(P, communityId, capability)`

## Preconditions

1. Local product gates PASS on `local/access-control-v2-product`
   - `qa/access-control-v2-product-gate.mjs`
   - `qa/access-control-v2-community-product-gate.mjs`
2. Adversarial + cross-group + multitab gates PASS
3. Security non-regression PASS
4. Explicit owner approval for a **dark** or **enabled** production package

## Proposed packaging (future)

| Field | Value |
|-------|-------|
| NEXT_WEB_PACKAGE | 895 |
| NEXT_CACHE_VERSION | sos-cache-v895 |
| FLAG_DEFAULT | `SOS_ACCESS_CONTROL_V2=false` unless owner orders enable |
| ROLLBACK | Package 894 / `c5e764fd15befc16d26d944a3fba5d1f29b2eb08` / `sos-cache-v894` |

## Activation sequence (owner-gated)

1. Merge local AC product branch after RC PASS
2. Deploy Package 895 **with flag still OFF** (dark UI code path only) **or** enable flag only if owner orders
3. Smoke: create community (logo/name), branding switch, feed selector, admin menu, invite/QR, member remove, privilege denial, cross-community chat/calls
4. If regression → rollback to 894

## Local test (developers)

- Host: localhost / 127.0.0.1
- `?acv2=1` or `localStorage.setItem('SOS_ACCESS_CONTROL_V2_LOCAL_TEST','1')`
- Production host **cannot** enable via query/storage

## Out of scope until approved

- Production flag ON
- Android / APK / MD4
- Push incomplete work to main
