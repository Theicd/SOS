# Background Call Cold-Start Regression

**Date:** 2026-09-18  
**Status:** Documented after emergency Web rollback  
**APK under test:** 1.0.117 / code118 (Native wake intact)  
**Next APK if Native needed:** 1.0.118 / code119

---

## What worked

Native secure Gift Wrap wake itself **succeeds** with screen off / Activity destroyed:

```
SECURE_WAKE_RECEIVED
SECURE_VERIFIER_LAUNCH
SECURE_VERIFIER_ACTIVE
SECURE_WEBVIEW_READY
```

Foreground calls work because the Web runtime is already loaded.

---

## What failed physically

Background/screen-off calls became unusable after the call-session-terminal Web cutover.

Observed timeline (approx):

| Time | Side | Event |
|------|------|--------|
| 13:46:59 | Caller | `CALL_SIGNAL_SENT action=offer` / `CALL_STARTED` |
| 13:46:59 | Receiver | Native verifier wake starts |
| ~20s | Receiver | Full `videos.html` cold boot (WebTorrent, feed, notifications…) |
| 13:47:20–23 | Receiver | Usable Web call processing / `CALL_RING_AUTH_ONCE` / Native ring |
| 13:47:21 | Caller | `CALL_ENDING` / `CALL_END_ONCE` |
| 13:47:23 | Caller | `CALL_SIGNAL_SENT action=disconnect` |
| 13:47:23 | Receiver | `SECURE_NATIVE_RING_AUTHORIZED` (too late) |
| 13:47:25 | Receiver | disconnect recv → end |

**Result:** ring missing or too brief to answer.

---

## Root cause (architecture)

`SosCallUrls.warmPage()` / secure verifier loads **full** `videos.html` (home/feed stack):

- WebTorrent client init
- VIDEOS Page loaded
- feed hydration / relay subscriptions
- notifications bootstrap
- chat + top-contact P2P preconnect paths

That cold start (~20s) exceeds offer usability window while the caller waits.

This is **not** a Gift Wrap / NIP-44 security failure. Native opaque wake works.

---

## Emergency response

Web-only rollback of call runtime JS to known-good base:

`b764d4da162b5914d52a3915d4e287b84d08a766`

Security freeze preserved:

- `callSignalGiftWrapRequired=true`
- 1059-only new call writes
- no Native/APK rebuild in the rollback

---

## Future solution (NOT this task)

**MINIMAL SECURE CALL FAST BOOTSTRAP**

A dedicated lightweight page/module for verifier wake:

Allowed: identity/session, Gift Wrap unwrap, call signaling, ring authorize path.

Forbidden on wake: public feed, videos queue, WebTorrent feed work, top-5 P2P preconnect, PeerExchange fanout, autoplay.

Do **not** confuse with `CHAT_OPEN_WAKE` / `BACKGROUND_CHAT_MODE` (separate future work).

---

## Version lock

| Item | Value |
|------|--------|
| Current QA/public APK | 1.0.117 / 118 |
| Do not reuse | 1.0.117 / 118 |
| Next APK if Native change required | **1.0.118 / 119** |
