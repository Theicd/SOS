# Web Package 894 — Release Plan (RC ONLY — NOT DEPLOYED)

**PACKAGE894_RC_STATUS:** see final report (owner approval required before any deploy).  
**DO NOT deploy without new explicit owner approval.**

---

## Package 893 production baseline (LIVE — remains live)

| Field | Value |
|-------|-------|
| ROLLBACK_MAIN_SHA / MAIN_SHA | `75103604a5219062e9d42f61e717b10d76280652` |
| ROLLBACK_PACKAGE / PACKAGE | 893 |
| ROLLBACK_CACHE / CACHE | `sos-cache-v893` |
| PRODUCTION URL | https://sos010.com |
| Build id | `2026.09.26-web-893` |

Production must not be changed by this RC phase.

---

## Share root cause (Package 893)

- Typed signer `SIGN_FEED` allowlist was `{ kinds: [1] }` only.
- `feed.js` `sharePost` creates NIP-18 repost **kind 6**.
- Result: `kind 6 not allowed for SIGN_FEED` → `PROD_SHARE_GATE=FAIL`.

## Share fix commit

| Field | Value |
|-------|-------|
| SHARE_FIX_COMMIT | `d9faca483e32c8d4a48086f3667318dade8d1353` |
| Semantic change | `SIGN_FEED.kinds`: `[1]` → `[1, 6]` only |
| Cache-bust | `videos.html` → `sos-crypto-signer.js?v=20260926share6` |

### Exact signer allowlist change

```js
// before
SIGN_FEED: { kinds: [1] },
// after
SIGN_FEED: { kinds: [1, 6] }, // kind 6 = NIP-18 repost/share
```

### Minimal authority

| Check | Result |
|-------|--------|
| SIGN_FEED_KIND1_ALLOWED | true |
| SIGN_FEED_KIND6_ALLOWED | true |
| SIGN_FEED_ARBITRARY_KIND_ALLOWED | false |
| SIGN_FEED_ALLOWED_KINDS | `[1, 6]` |
| Wildcard kinds | none |
| Generic signer / raw K / nsec exposure | none |

Negative kinds rejected via same typed op: `0, 3, 4, 7, 25050, 1059` (and others).

---

## Package 894 exact delta

**Functional commits expected:**

1. `d9faca483e32c8d4a48086f3667318dade8d1353` — share SIGN_FEED kind 6  
2. Packaging bump commit (local RC) — `pkg=894` / `sos-cache-v894` / `2026.09.26-web-894` only  

**Unrelated application changes:** false (Android untouched).

### Cache / SW version plan

| Field | Value |
|-------|-------|
| NEXT_WEB_PACKAGE | 894 |
| NEXT_CACHE_VERSION | `sos-cache-v894` |
| NEXT_BUILD_ID | `2026.09.26-web-894` |
| Canonical SW | `./service-worker.js?pkg=894` |

Files touched for packaging metadata (same set as 893):  
`app-version.json`, `service-worker.js`, `sw-register.js`, `videos.html`, `p2p-standby.html`.

---

## Post-deploy share smoke (after owner approves deploy)

1. Create post (kind 1) → Share/repost → kind 6 signed via `signFeedEvent`  
2. Relay publish + other-user visibility + reload persistence  
3. Social non-regression: post/like/comment/follow  
4. Hebrew + secret-leak quick check  
5. Relay chat still works  
6. P2P: attempt DC; if environment blocks, document — do not treat as share rollback trigger

---

## P2P evidence (RC)

### Production https://sos010.com (Package 893 live)

- Headed Chromium, two contexts: capability A/B true, signaling started, initiator stuck `have-local-offer`, responder `waiting`, no ICE candidates → **SIGNALING**.
- Relay fallback: **PASS** (E2EE chat deliverable).
- `P2P_CODE_FIX_REQUIRED=false` (no application regression; share delta does not touch P2P).

### Local Package 894 RC tree (headed, same machine)

- DataChannel **open**, ICE connected, text A2B/B2A **PASS**, 10MB file hash match **PASS**, ~19.5 Mbps, relay also **PASS**.
- Proves application DC path is healthy on the RC tree when signaling completes.

---

## Rollback to Package 893

| Field | Value |
|-------|-------|
| ROLLBACK_MAIN_SHA | `75103604a5219062e9d42f61e717b10d76280652` |
| ROLLBACK_PACKAGE | 893 |
| ROLLBACK_CACHE | `sos-cache-v893` |

Rollback = restore production tree/CDN to Package 893 artifacts; do not leave dual APK/web histories.

---

## Change control (this phase)

| Flag | Value |
|------|-------|
| MAIN_PUSH_EXECUTED | false |
| MAIN_DEPLOY_EXECUTED | false |
| CDN_PRODUCTION_CHANGED | false |
| ROLLBACK_EXECUTED | false |
| ANDROID_WORK_EXECUTED | false |
| APK_BUILT | false |
| ACCESS_CONTROL_V2_CHANGED | false |
| MD4_STARTED | false |

**Owner approval required to deploy Package 894.**
