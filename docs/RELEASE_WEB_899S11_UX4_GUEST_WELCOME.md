# Production Web Release — 899s.11 UX4 Guest Welcome

Previous: `2026.10.11-web-899s.10` @ `4107bbb`  
Next: `2026.10.11-web-899s.11`

## Included (Web)

- Guest QR welcome: only `המשך כאורח`
- Auto-refresh expired Guest pairing QR
- Truthful Mobile Web T2-unavailable post-scan message
- `key-utils` nsec Uint8Array decode fallback (WebView-safe)
- Distinct login import error codes in `guest-auth.js`

## Excluded

- Production WebPhoneIssuer / T2 enablement
- Production APK distribution (Android import clear-before-write ships in source; QA APK 1.0.128 not distributed)
- Full QA branch merge / W3 / MD5
