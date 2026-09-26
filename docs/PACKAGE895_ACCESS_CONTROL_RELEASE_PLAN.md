# Package 895 ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג€ֲ¬ײ²ֲ׳²ֲ²ײ²ֲ¬׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ Access Control V2 / Community Product Release Plan

**Status:** prepared for owner approval only. **NOT DEPLOYED.**

## Exact RC identity

| Field | Value |
|-------|-------|
| PACKAGE | 895 |
| CACHE | `sos-cache-v895` |
| VERSION | `2026.09.26-web-895` |
| BRANCH | `local/access-control-v2-product` |
| RC_SHA | `30dc066ff319d912adc9cb1ebd034ca5ffa7b2cb` |
| PRODUCTION_NOW | Package **894** / `c5e764fd15befc16d26d944a3fba5d1f29b2eb08` / `sos-cache-v894` |

## Product model (unchanged by activation)

- SOS010 = one **global** communication network
- Identity = one global **P**
- Global: search, chat, P2P, audio/video calls (membership not required)
- Community-scoped: branding, feed/content, membership, admins, roles, permissions, invites, moderation, settings
- Feed = union of user-selected communities (selection ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ°׳³ֲ²ײ²ֲ²׳²ֲ²ײ²ֲ  membership)
- Authorization = `(P, communityId, capability)`

## Feature flag

| State | Value |
|-------|-------|
| Default / production | `SOS_ACCESS_CONTROL_V2=false` |
| Local test only | `?acv2=1` or `localStorage.SOS_ACCESS_CONTROL_V2_LOCAL_TEST=1` on non-production hosts |
| Production host | Local test helper **forces OFF** on `sos010.com` |

Architecture supports:

- `DEPLOY_CODE_WITH_V2_OFF_SUPPORTED=true` ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג€ֲ¬ײ²ֲ׳²ֲ²ײ²ֲ¬׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ ship 895 UI/protocol with flag OFF
- `V2_CAN_BE_ACTIVATED_SEPARATELY=true` ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג€ֲ¬ײ²ֲ׳²ֲ²ײ²ֲ¬׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ flip flag after base smoke
- `V2_CAN_BE_DISABLED_FOR_ROLLBACK=true` ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג€ֲ¬ײ²ֲ׳²ֲ²ײ²ֲ¬׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ set flag false without code rollback

## Activation sequence (owner-gated)

1. Owner approves READY_FOR_OWNER_APPROVAL RC
2. Deploy Package 895 **with V2 still OFF** (dark/code-present)
3. Production base smoke: identity, chat, P2P, calls, social, share kind 6
4. If base smoke fails ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ ׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳³ג€™׳’ג‚¬ֲײ²ֲ¢ rollback to Package 894 (`c5e764f` / `sos-cache-v894`)
5. Only after base smoke PASS: controlled V2 enable (owner order)
6. V2 smoke: create community, branding, ׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ²ײ²ֲ²׳²ֲ²ײ²ֲ ׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג€ֲ¬ײ²ֲ׳²ֲ²ײ²ֲ¢׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ¢׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ²ײ²ֲ²׳²ֲ²ײ²ֲ ׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ²ײ²ֲ²׳²ֲ²ײ²ֲ§׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ»ײ²ֲ׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ¢׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ²ײ²ֲ²׳²ֲ²ײ²ֲ¦׳³ֲ³ײ²ֲ³׳²ֲ²ײ²ֲ³׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ, invite/QR, non-admin inviter, member remove, feed selector, cross-community chat/calls
7. If V2 smoke fails ׳³ֲ³ײ²ֲ³׳³ג€™׳’ג€ֲ¬׳’ג€ֲ¢׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳²ֲ²ײ²ֲ ׳³ֲ³׳’ג‚¬ג„¢׳³ג€™׳’ג‚¬ֲײ²ֲ¬׳³ג€™׳’ג‚¬ֲײ²ֲ¢ disable flag first; if needed full rollback to 894

## Rollback

| Target | Value |
|--------|-------|
| SHA | `c5e764fd15befc16d26d944a3fba5d1f29b2eb08` |
| Package | 894 |
| Cache | `sos-cache-v894` |
| Flag | `SOS_ACCESS_CONTROL_V2=false` |

## Out of scope

- Android / APK / MD4
- Enabling V2 without owner approval
- Push/deploy of incomplete RC

## Gates

- `qa/package895-rc-closure-gate.mjs`
- `qa/access-control-v2-community-product-gate.mjs`
- `qa/access-control-v2-product-gate.mjs`
