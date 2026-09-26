# Package 894 RC Plan — NOT DEPLOYED

**Status:** prepared only. Owner approval required before any production release.  
**Reason:** Package 893 live share gate fails — typed signer `SIGN_FEED` allows kind `1` only; `sharePost` signs kind `6` (NIP-18).

## Production remains

| Field | Value |
|-------|-------|
| MAIN_SHA | `75103604a5219062e9d42f61e717b10d76280652` |
| PACKAGE | 893 |
| CACHE | sos-cache-v893 |
| URL | https://sos010.com |

Do **not** auto-deploy 894.

## Included fix (local commit)

- `sos-crypto-signer.js`: `SIGN_FEED.kinds = [1, 6]`
- `videos.html`: cache-bust `sos-crypto-signer.js?v=20260926share6`

Commit message target: `fix(social): restore production share flow`

## Proposed Package 894 packaging (future deploy step)

| Field | Value |
|-------|-------|
| NEXT_WEB_PACKAGE | 894 |
| NEXT_CACHE_VERSION | sos-cache-v894 |
| NEXT_BUILD_ID | 2026.09.26-web-894 |

Bump `pkg=893` → `pkg=894` and `sos-cache-v893` → `sos-cache-v894` in the same files as the 893 release plan.

## Post-deploy smoke (after owner approves 894)

1. Share/repost kind 6 create → sign → publish → other user visible → reload
2. Relay chat E2EE
3. Direct P2P text/file **if** environment allows DC open; else document NAT/headless limits
4. Hebrew + secret leak

## Out of scope

- Android / APK
- MD4
- ACCESS_CONTROL_V2
- Force TURN-only P2P
