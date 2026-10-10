# MD4 S7A2 — Physical Android camera QR acceptance procedure

**Prerequisite:** S7A1 scanner wired (`SosLinkedDevicesActivity` → CameraX + ML Kit).  
**Do not** mark `HARDWARE_CAMERA_QR=PASS` from emulator, paste, clipboard, or fixture injection.

## Environment

1. Build debug APK: `android-shell` → `assembleDebug`.
2. Install on a **real** Android phone (USB/ADB preferred for logcat; sideload OK if evidence is trustworthy).
3. Desktop: Chromium/Chrome with SOS web shell; local or staging admission + pairing relay as used in MD3 live E2E.
4. Phone and Desktop on network paths that can reach the pairing relay (same as paste-path E2E).

## Happy path (repeat for NEW_39007 and LEGACY_NO_PHONE)

1. Open SOS Desktop → Linked Devices → show **fresh** SOSPAIR1 QR (visible on screen).
2. Open SOS APK → Linked Devices (`מכשירים מקושרים`).
3. Tap **סריקת QR במצלמה**; grant camera if prompted.
4. Point the phone camera at the Desktop QR (physical optical path).
5. Confirm status shows recognition → handshake → destination fingerprint/SAS.
6. Tap **אשר קישור** (explicit approve — never auto-link).
7. Verify Desktop `LINKED` and Android “המכשיר קושר בהצלחה”.
8. Same Global **P** on both sides; `ROOT_K` / nsec never on Desktop.
9. Complete MD4 history + sample encrypted image/video/file restore.
10. Restart Desktop browser and Android APK; confirm durable auth, no forced re-scan.
11. Brief network disconnect/reconnect; authorization remains valid (not MD5 live sync).

## Negatives

| Case | Expect |
|------|--------|
| Deny camera permission | Clear Hebrew error; paste still available; no LINKED |
| Permanently deny camera | Settings hint; no crash |
| Expired QR | Reject; prompt for fresh Desktop QR |
| Replay spent QR | Fail closed (MD2 spent store) |
| Group Invite QR | `GROUP_INVITE_QR` / not pairing |
| Cancel before approve | No DeviceAuthorization issued |
| Explicit deny / cancel | No LINKED |
| Wrong account session | Fail closed |

## Evidence to capture

- Device model + Android version  
- APK versionCode / versionName / SHA256  
- Screenshots or screen recording of optical scan (optional but preferred)  
- logcat around pairing (`SosLinkedQrCam`, orchestrator phases)  
- Desktop LINKED state + auth id  
- History/media completion status  

## Report fields

```
HARDWARE_CAMERA_QR=PASS|NOT_VERIFIED
REAL_ANDROID_DEVICE_USED=true|false
S7A_PHYSICAL_ACCEPTANCE=PASS_S7A2|BLOCKED_HARDWARE|FAIL_PRODUCT
```
