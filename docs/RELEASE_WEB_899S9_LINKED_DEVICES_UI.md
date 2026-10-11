# Production Web Release — 899s.9 Linked Devices UI

Date: 2026-10-11  
Previous Production: `2026.10.05-web-899s.8` @ `d1bcc5168d9e02564c505d4b10c69a8d9b5f208a`  
Next Production: `2026.10.11-web-899s.9`  
RC branch: `release/web-899s.9-linked-devices-ui`

## Version sequence evidence

| Commit | Version |
|--------|---------|
| e8b2167 | 2026.10.05-web-899s.6 |
| 801b1ff | 2026.10.05-web-899s.7 |
| d1bcc51 | 2026.10.05-web-899s.8 (previous live) |
| **this RC** | **2026.10.11-web-899s.9** |

QA-only tags (`qa-stage5-*`) were never Production versions and are not claimed as such.

## Scoped promotion (included)

- Remove legacy product modal `קישור מכשיר (MD2)` and synthetic QR fallback (`sos-md2-pairing-qr.js`)
- Single Linked Devices event owner (`sos-web-linked-devices.js`)
- Mobile Web camera scanner entry (`sos-web-linked-qr-scanner.js` + `vendor/jsQR.js`)
- Desktop real MD2 SOSPAIR1 session QR (`sos-md2-pairing-session.js`)
- videos.html script wiring + cache bust `pkg=899s9`
- app-version / SW cache `sos-cache-v899s9` / sw-register `?pkg=899s9`
- Update toast shows version + "עדכן עכשיו"; defers reload during active pairing/scan UI

## Explicitly excluded (not Production-ready)

- Full `qa/stage5-dual-primary-qr-20261011` merge
- MD3W-W1A/W1B Web T2 issuance modules (`sos-web-phone-issuer.js`, `sos-authorize-linked-device.js`, `sos-ald-w1a-verify.js`)
- `md3wT2SignerApproval` enablement (remains OFF / not shipped)
- MD4 history / CKI / attachment sync / W3 / MD5
- Global identity / phone onboarding Stage5 package churn unrelated to Linked Devices UI
- Native APK binary release

## Production feature truth

- Optical QR decode ≠ DeviceAuthorization
- Web MD3 issuance OFF; mobile web scan shows target hint and directs to Android SOS app for secure approval
- Desktop may display real SOSPAIR1 and await authorized phone; no fake LINKED
- T1 fallback remains disabled
- Signer / Worker / DNS unchanged
