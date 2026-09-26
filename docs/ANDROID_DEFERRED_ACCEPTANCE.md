# Android Deferred Acceptance

**Web-first freeze:** Android / APK work is **FROZEN** until Web owner acceptance.  
This list contains **only** work that truly requires device/Android execution.

Do **not** treat Web failures as `DEFERRED_ANDROID`.

---

## Deferred Android-only items

| ID | Work | Why Android-only |
|----|------|------------------|
| A1 | Android Secure Identity Store physical verification | Keystore / encrypted prefs on device |
| A2 | Android Keystore persistence across process death | Platform keystore |
| A3 | Device reboot persistence | Hardware reboot |
| A4 | BiometricPrompt physical verification (F6G3) | Hardware biometric |
| A5 | F5B6 physical sealed migration ceremony | Two physical devices + strong confirm |
| A6 | F6H physical orchestration | Native confirm + migration UX |
| A7 | Android WebView integration acceptance | WebView bridge / COEP / typed native |
| A8 | Android P2P / media paths | Native sockets / MediaProjection / audio focus |
| A9 | Android audio / video call physical | Mic/cam routing, background, notifications |
| A10 | Android social UI regression | WebView rendering / touch |
| A11 | Android Hebrew UI | WebView font/encoding surfaces |
| A12 | Android secret leak via logcat | Device logs |
| A13 | F6J R2 physical acceptance | Physical device matrix |
| A14 | R3 canary / APK publish | Release pipeline |
| A15 | MD1 device key generation on handset | Keystore-backed D_sign/D_enc |
| A16 | MD2/MD3 live pairing with camera on device | Native camera + spent store |
| A17 | Linked-devices revoke UX on Android settings | Native settings surface |

---

## Explicitly NOT deferred (Web owns them)

- Invite QR generate/scan (Web)
- Social / chat / call regressions (Web)
- Worker Vault / existing key import (Web)
- AC1–AC10 architecture gates with `SOS_ACCESS_CONTROL_V2` default **OFF**
- MD2 **payload parse/render** presentation (public SOSPAIR1 only) on Web
- Privacy audits / forward-secrecy **plan** docs

---

## Change control while frozen

- `ANDROID_WORK_EXECUTED=false`
- `APK_BUILT=false`
- `APK_INSTALLED=false`
- No versionName/versionCode bumps
- No R2 / biometric / reboot ceremonies

`ANDROID_DEFERRED_LIST_GATE=PASS` when this document is present and scoped to Android-only work.
