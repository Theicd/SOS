# Call Lifecycle Web/Native Compatibility RC

**Status:** DO NOT DEPLOY — compatibility proof for owner review  
**Branch:** `hotfix/call-lifecycle-session-terminal`  
**Parent:** `e647845ba07e367ed1c619f7f3108dbace30d401`

---

## 1. Confirmed Web/APK mismatch (physical QA 1.0.116)

| Layer | Commit / surface | Present? |
|-------|------------------|----------|
| Native durable 1059 handled store | e647845 APK 1.0.116 | YES |
| Web `ackSecureWrapHandledToNative` / requeue | e647845 `call-signal-e2ee.js` | YES in branch |
| Production Web (main / live site) | `b764d4d` | **NO** — missing ACK half |

**WEB/APK MISMATCH: CONFIRMED**

Physical QA of APK 1.0.116 against production Web therefore could **not** exercise durable HANDLED ACKs. Outer IDs stayed effectively un-acked → Relay lookback re-woke verifier.

This RC packages **matching Web + Native** together. Deploy Web only after owner review; do not force users to install QA APK solely because a Web patch exists.

---

## 2. Web diff required (this RC — not deployed)

| Area | Files | Behavior |
|------|-------|----------|
| Secure wrap ACK | `call-signal-e2ee.js` | After terminal dispatch → `ackSecureWrapHandled`; temp fail → `requeueSecureWrap` |
| Session tombstone | `call-signal-e2ee.js` | Before ring: `isSecureCallSessionTombstoned(sessionId)`; disconnect → mark ENDED |
| Ring once / session | `call-signal-e2ee.js` | `nativeRingAuthOnce` keyed by **sessionId** |
| Idempotent end | `chat-voice-call.js`, `chat-video-call.js` | Session terminal: end/disconnect/missed once |
| Decline terminal | `chat-voice-call-ui.js`, `chat-video-call-ui.js` | Tombstone first; stop sounds; one disconnect; missed ZERO |
| Deeplink consume | `chat-deeplink.js` | `DEEPLINK_CALL_CONSUMED` strips `incomingCall` after first success |
| Verify-only idle | `call-signal-e2ee.js` | No ring after drain → `requestVerifyOnlyIdleShutdown` |

---

## 3. Native half (APK 1.0.117)

| Component | Role |
|-----------|------|
| `SosSecureCallSessionStore` | SHA-256(sessionId) tombstone DECLINED/ENDED/CONNECTED_END, TTL ~3m, max 128 |
| `SosSecureWrapHandledStore` | Outer event-id HANDLED (from e647) |
| `SosJsBridge` | ACK, tombstone query/mark, verify-only shutdown, decline cancels keepFront |
| `MainActivity` | Decline stays background; no keepFront; verify-only idle finish |
| `IncomingCallActivity` | Decline marks tombstone before background decline inject |

---

## 4. Freshness / first-upgrade backlog rules

Do **not** blindly mark all historical 1059 as handled.

On verifier wake / drain:

1. Unwrap/authenticate each queued wrap.
2. If `action=offer` and inner `sentAt` older than freshness (~60s) → handled, **ring ZERO**.
3. Candidates / answers / disconnect → handled, **ring ZERO** unless a live session needs them (tombstoned → drop).
4. Only a **fresh authenticated offer** with new non-tombstoned `sessionId` may call `notifySecureCallOfferVerified`.
5. If drain produces **zero** ring authorizations → `VERIFY_ONLY_IDLE_SHUTDOWN` (P2P owner → NATIVE, finish background Activity).

---

## 5. Compatibility matrix (expected)

| Client | New Web (this RC, undeployed) | Result |
|--------|-------------------------------|--------|
| APK 1.0.115 | New Web | **PASS** — old Native ignores unknown bridge methods; Web still rings via existing `notifySecureCallOfferVerified`; tombstone/ACK soft-fail closed |
| APK 1.0.116 | New Web | **PASS** — durable handled ACK now works; session tombstone if bridge present |
| APK 1.0.117 | New Web | **PASS** — full session terminal + idle shutdown |
| Old browser/PWA | New Web | **PASS** — bridge calls guarded; Gift Wrap send/receive unchanged; no forced APK install |

No user must install QA APK merely because Web patch exists.

---

## 6. CHAT_OPEN_WAKE (future — NOT this RC)

Preserved target (audit only):

USER1 opens chat with USER2 → one encrypted CHAT_OPEN_WAKE → USER2 minimal background chat runtime → decrypt peer → targeted DC only → lease over DC → CHAT_CLOSE → idle grace → P2P owner NATIVE.

Must keep: top-5 preconnect ZERO, public feed ZERO, autoplay ZERO, feed WebTorrent ZERO, unrelated PeerExchange ZERO.

---

## 7. Security freeze

- `callSignalGiftWrapRequired=true`
- New call send: 1059 only
- ZERO: direct25050 write, NIP04 call write, 25060, dual-write, call push
- Legacy 25050: READ ONLY
- P2P / Blossom / 30078 / DC thresholds: **unchanged**
