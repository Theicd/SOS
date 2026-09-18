# Background Chat / P2P Wake Audit

**Status:** AUDIT + DESIGN ONLY — do **not** implement background chat wake yet.  
**Date:** 2026-09-18  
**Branch context:** `hotfix/native-avatar-1059-dedupe`  
**Physical QA base:** APK 1.0.115 (secure verifier wake)

---

## 1. Physical discovery (APK 1.0.115)

Secure call verifier wake proved Android can start:

`Native FGS → MainActivity/WebView → Web P2P stack → DataChannel`

even when UI closed, Activity destroyed, and screen off.

Observed sequence (approx):

| Time | Event |
|------|--------|
| 03:33:24 | MainActivity destroyed, P2P owner=NATIVE, card closed |
| 03:33:29 | APK process/FGS restarted, RelayWatcher connected |
| 03:33:30 | Historical/replayed kind 1059 → SECURE_WAKE_* → verifier → WebView |
| 03:33:35 | Full `videos.html` loaded, WebTorrent + feed init |
| 03:33:45 | P2P owner=WEBVIEW, DC pre-connect for top contacts |
| 03:33:46 | Incoming private chat via Relay → CHAT/E2EE → CHAT/P2P-AUTO targeted connect |
| 03:33:52 | P2P-DC OPEN |

**Critical:** wake was caused by **1059 secure verifier**, not by the chat event.  
Do **not** claim chat wake exists yet.

---

## 2. Current Native chat behavior (kind 1050)

| Item | Behavior |
|------|----------|
| Listener | `SosRelayWatcher` subscribes to private chat kind **1050** |
| `notifyChat` | Displays message notification only |
| WebView wake | **NO** — explicit comment: do not raise Native WebRTC on chat |
| P2P 25055 | **WebView-only** while Activity is alive; Native RelayWatcher intentionally does **not** subscribe |
| Deep link | Notification tap opens `videos.html?chat=<pubkey>` (user-initiated only) |

**CURRENT CHAT EVENT DIRECTLY WAKES WEBVIEW: NO**

---

## 3. Why full home/feed started on secure wake

`SosCallUrls.warmPage()` returns `BuildConfig.SOS_START_URL`, currently:

`https://sos010.com/videos.html?shell=…`

Secure verifier (`SecureCallWakeActivity` → `MainActivity` with `EXTRA_OPEN_URL`) therefore boots the **full videos.html stack** solely to unwrap NIP-59 call signals.

Call secure verifier must remain functional; future background-chat wake must **not** reuse this generic full-home URL.

---

## 4. Unwanted background work on current full-home wake

These run today when verifier loads `videos.html` and must be forbidden in a future `BACKGROUND_CHAT_MODE`:

| Area | Primary files / entry points |
|------|------------------------------|
| VIDEOS Page loaded | `videos.html` load handler; `videos.js` `init()` |
| Feed hydration | `videos.js` `hydrateFeedFromCache`, `loadVideos`, `ensureBootFeedReady` |
| Public kind:1 feed | `videos.js` `buildVideoFeedFilters`, realtime `subscribeMany` |
| Likes/reactions | `videos.js` `loadLikesAndCommentsForVideos` (kinds 7/6/1) |
| Video queue / preloads | `addToVideoDownloadQueue`, `processVideoDownloadQueue`, `pumpFeedWarmQueue`, `preloadNextMedia` |
| Autoplay | `globalAutoplayEnabled` default true in `videos.js` |
| WebTorrent | `webtorrent-transfer.js` `initClient()` |
| Feed/P2P heartbeats | `p2p-video-sharing.js` `sendHeartbeat`, background worker |
| Top-5 DC preconnect | `chat-service.js` `handlePoolReady` → `DC_PRECONNECT_COUNT = 5` |
| PeerExchange | `p2p-peer-exchange.js` `startAutoExchange` |
| Extra weight | live-tv, games, market, pdf.js, ffmpeg, hls, Chart.js, push init |

**Allowed today after incidental wake (documented, not endorsed as product feature):**

- Chat E2EE accept path in `chat-service.js`
- Targeted `[CHAT/P2P-AUTO]` `dataChannel.connect(peer)` for recent incoming message
- Physical QA: **P2P-DC OPEN** while user did not intentionally open UI

---

## 5. Future `BACKGROUND_CHAT_MODE` design (NOT IMPLEMENTED)

### Entry

Preferred:

- `https://sos010.com/videos.html?backgroundChat=1`, **or**
- dedicated lightweight page (prefer reuse patterns from existing `p2p-standby.html` headless shell)

### Allowed init

- Secure identity / session
- Private chat E2EE
- Necessary Relay private-chat subscription
- DataChannel module
- **Targeted** P2P peer connection only
- Chat media/file receive + receipts/ACK
- Minimal persistence

### Forbidden init

- Public feed / videos / autoplay / feed media
- Public kind:1 feed subscription / feed queue / downloads
- Top-5 P2P preconnect
- Random PeerExchange fanout
- Unrelated Torrent/WebTorrent activity
- Feed heartbeats / likes / reactions UI work

### Relay-metadata-future compatible

Do **not** require Native to see real sender pubkey from outer event long-term.

Desired future flow:

1. Opaque private-chat wake  
2. Minimal background chat WebView  
3. Authenticate/decrypt private event **inside** secure payload  
4. Determine real peer inside payload  
5. Targeted `connect(peer)` only  

Log shape (future): `BACKGROUND_P2P_TARGET peer=redacted` — one targeted DataChannel.

Suggested max simultaneous peers: **2–3** (audit only).

### Idle shutdown (~8–15s)

If user has **not** opened app foreground AND no active transfer AND no pending message AND no call AND no queued P2P work:

- Close targeted DC  
- Stop chat-only P2P signaling  
- Stop background WebView-owned heartbeats  
- P2P owner → NATIVE  
- Finish background-only MainActivity/WebView  

Native minimal Relay watcher/FGS may remain.

### Foreground takeover

If user opens app while background chat session is active:

- Cancel background auto-shutdown  
- Transition `BACKGROUND_CHAT → FOREGROUND` without duplicate connections / messages / notifications / DataChannels  

### Multiple messages

- Same peer during idle grace → extend timer  
- Second peer → bounded second targeted session if needed  
- Never preconnect arbitrary contacts  

---

## 6. Explicit non-goals for this branch

- Do **not** enable incoming chat → Activity wake  
- Do **not** subscribe Native to 25055  
- Do **not** change P2P priority / fallback / threshold / chunk sizes  
- Do **not** change Torrent / WebTorrent / Blossom / WebRTC / STUN / TURN  
- Do **not** change `callSignalGiftWrapRequired=true`

---

## 7. Audit checklist

| Claim | Result |
|-------|--------|
| Background call wake can bring up Web P2P | DOCUMENTED (physical) |
| Chat event directly wakes WebView | **NO** |
| Targeted chat auto-connect after WebView up | PASS (code + physical) |
| Physical P2P-DC OPEN after verifier wake | DOCUMENTED |
| Full home startup risk via `warmPage()` | DOCUMENTED |
| Future BACKGROUND_CHAT_MODE design | COMPLETE (this doc) |
| Future feed disabled | DESIGNED |
| Future top-5 preconnect zero | DESIGNED |
| Future targeted peer only | DESIGNED |
| Future idle shutdown | DESIGNED |
| Relay-metadata-future compatible | DESIGNED |
