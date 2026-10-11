# Production Web Release — 899s.10 UX3 Linked Devices

Date: 2026-10-11  
Previous Production: `2026.10.11-web-899s.9` @ `ab4230f311564007149d26ff714089b3a4fda9b4`  
Next Production: `2026.10.11-web-899s.10`  
RC branch: `feature/ux3-linked-devices-guest-qr` → `main`

## Scoped promotion (included)

- `chat-request-logger.js`: normalize Filter / Filter[] only for telemetry; preserve SimplePool args (fixes blank Desktop QR / `flatMap is not a function`)
- Desktop Guest QR-first welcome + `המשך כאורח` (sessionStorage per-tab)
- Desktop menu reopen: `קישור מחשב לטלפון`
- Mobile Web dedicated Linked Devices page + `קישור מכשיר` scanner CTA
- Local device list scope honesty (`LOCAL_BROWSER_REGISTRY`); revoke product still OFF
- Version / SW / cache bust `899s10`

## Explicitly excluded

- Full QA / MD4 / MD3W-W1B / W3 / MD5 merge
- Web PhoneIssuer / T2 enablement
- Production signer / Worker / APK changes
- Fake LINKED / synthetic QR / account-wide revoke claims
