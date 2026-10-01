# SOS Web Finalization Roadmap (canonical handoff)

Internal. No secrets in this file. Do not add private keys, PINs, tokens or invite codes.

## Current completed state (2026-10-01)

- Production: https://sos010.com, GitHub Pages from `Theicd/SOS` `main`. Live package `2026.10.01-web-899j`.
- Isolated signer: https://signer.sos010.com (Cloudflare Pages `sos-signer`), personal-key file save (899i).
- First group `israel-network`: `ACCESS_CONTROL_V2=true`, `accessControlV2Scope=CONTROL_PLANE`.
- ROOT pubkey `ede1e7fa…7e601`. Admission Service pubkey `752f47fa…611ef`, single capability `FINALIZE_MEMBERSHIP_ADMISSION`.
- Admin 2FA enforcement ON (server PIN verifier + pinned attestation signer). 899f group-control PIN lock.
- Account creation: Worker identity → "המפתח האישי שלך" → signer saves `SOS-personal-key-<fp>.txt` → "המפתח נשמר בהצלחה". Login accepts the key file.
- 899j (Phase 1 code): profile kind 0 actually published (awaited typed signature, relay acks, monotonic `created_at`); avatar/cover uploaded to Blossom and stored as https URLs; `profile.html` loads the signer; newest-wins profile resolution for feed, conversations, public profile and group management; stub names refreshed; floating home "ניהול קבוצה" button removed (menu "שליטה על הקבוצה" only).

## Phases

1. **Web control + profile** — profile persistence, canonical resolver, remove home button, INVITE_USERS regression, one production role/permission mutation (owner PIN), invite/admission production acceptance, regression. Code done in 899j; production owner steps listed below.
2. **Mobile account creation + personal key** — invitation → phone → create account → "המפתח האישי שלך" → real key file → "המפתח נשמר בהצלחה" → enter SOS. Desktop account creation disabled. No technical terms for normal users.
   - 2B: WhatsApp phone verification. No raw phone number in Nostr, invite URLs or any public directory; HMAC identifiers only.
3. **Desktop login by QR** — desktop guest unchanged; "התחבר" shows a one-time QR; phone: "מכשירים מחוברים" → "חיבור מחשב" → scan.
4. **Linked devices** — single main-menu entry "מכשירים מחוברים" with "חיבור מחשב" and device list with "נתק מכשיר".
5. **Encrypted device sync** — separate network-refetchable data from data that needs device sync.
6. **New-phone recovery** — "שחזור ממכשיר מחובר". Account PIN is separate from the Admin PIN. Key file stays the emergency path.
7. **Final web freeze** — then Android/APK work may resume.

## STOP point

Work stops after each phase and reports in the agreed format. Phase N+1 starts only on explicit owner instruction. Android, APK, MD4 and multi-community stay frozen until after Phase 7.

## Known production blockers / open owner steps

- 1E: one real role/permission mutation by ROOT through the production UI requires the owner's Admin PIN (owner-only action; never ask for or handle the PIN).
- 1D/1F in production depend on the 1E grant (INVITE_USERS for a non-ROOT member) and a real invite redemption.
- Stale QA pins (not product bugs): `multitab-session-revocation-gate` (package 892 markers), `gate4-v2-scope-gate` (expects zero granted capabilities in production), `identity-i2-predeploy-package-gate` (PKG 886 / cache v889).

## Non-negotiable UX rules

- Account creation is mobile-only; desktop does not create users.
- Desktop guest mode stays fully usable (posts, TV, games).
- Desktop "התחבר" becomes a one-time QR (Phase 3).
- Phone linked devices live under one menu entry: "מכשירים מחוברים".
- Initial key delivery is "המפתח האישי שלך" — never "backup".

## Do not touch without explicit owner approval

ROOT identity, genesis, Admission delegation, Admin 2FA signer, control relay set, V2 scope, multi-community, Android, APK, MD4. No force push, no `git reset`, no cleaning unexplained worktrees.
