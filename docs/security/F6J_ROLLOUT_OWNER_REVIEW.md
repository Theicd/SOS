# F6J — Android Security Rollout Owner Review

**Phase:** F6J-R1 (preparation only)  
**Status:** Candidate ready for owner approval — **not deployed**  
**Date:** 2026-09-25  
**Local HEAD baseline:** `5f88b5c` → F6J-R1 commit after this review  

---

## What this rollout is

Controlled Android release of the completed Stage-5 **identity security** stack already implemented locally:

| Component | Role |
|-----------|------|
| F6A | Secure identity custody (Keystore-wrapped same K/P) |
| F6B–F6F | Typed native signer / bridge / session / admin / private crypto |
| F6G + F6G.1 | Trusted native confirmation lifecycle |
| F6G.3 | BiometricPrompt strong confirm for sealed migration |
| F5B6 | Sealed same-identity migration to authorized `DEVICE_RECOVERY` device |
| F6H | Migration/recovery orchestration + safe Hebrew UI state |
| F6I | Adversarial hardening boundaries |
| Trust guard | Identity **write** only from `https://sos010.com` / `https://*.sos010.com` |

**Same account forever:** migration/recovery preserves the same root K and P. No silent identity rotation.

---

## What stays off / not included

- **ACCESS_CONTROL_V2** remains default **OFF**
- **Package 893** is **not** required and is **not** created
- **MD4+** history sync / Recovery Capsule / desktop→new-phone MD7 product — **not** in this rollout
- **F8** legacy identity deletion — **not** authorized
- **F5B5** visual nsec emergency path — **unchanged** (separate)
- **Web production Package 892** — **unchanged** in this phase
- No DNS / signer production changes

---

## Version / package decision

| Track | Current production | F6J candidate |
|-------|--------------------|---------------|
| Web package | **892** | stays **892** |
| Android `versionName` | 1.0.124 | **1.0.125** |
| Android `versionCode` | 125 | **126** |
| Public download | `downloads/SOS-1.0.124.apk` | **not updated yet** |

**PACKAGE_893_REQUIRED = false**  
Android APK is versioned independently from the web package number. F6 design already stated F6J internal/dark rollout does not require Package 893.

---

## What is already live vs dark

Most F6A–F6I native security is **compiled into the app** (no inventable kill-switch flags found beyond `BuildConfig.DEBUG` for localhost trust).

**Dark / internal mechanism for F6J-R1:**

1. Build & sign release candidate APK (`1.0.125` / code `126`)
2. Install **only** on owner/internal test devices
3. **Do not** publish to `downloads/` or `apk-version.json`
4. **F6H / F5B6** have **no WebView bridge entry** — users cannot start sealed migration from the website UI yet
5. Strong confirmation in release uses real **BiometricPrompt** (`BIOMETRIC_STRONG | DEVICE_CREDENTIAL`); soft/test drivers exist **only** in unit-test source

---

## Physical device testing

| Gate | Value |
|------|-------|
| `PHYSICAL_BIOMETRIC_HARDWARE_TESTED` | **false** |
| Required before **internal/dark** install | **false** (prepare OK) |
| Required before **broad** production publish | **true** |

Do not claim biometric hardware acceptance until an owner runs a real-device ceremony.

---

## Rollout stages

1. **R0** — Release artifact validation (this phase / QA gate)  
2. **R1** — Internal/dark install on test devices  
3. **R2** — Physical-device BiometricPrompt + migration acceptance  
4. **R3** — Limited canary: publish `SOS-1.0.125.apk` to site downloads after explicit owner order  
5. **R4** — Broader enablement / optional WebView UX wiring for F6H  

---

## Rollback (same K/P)

- Reinstall previous production APK (`1.0.124` / code 125) signed with the **same upload keystore**
- Secure identity blobs + device-key prefs are backup-excluded; rollback must not invent a new root identity
- `ROLLBACK_ROTATES_ROOT_IDENTITY = false`
- If migration was mid-ceremony: incomplete ceremonies require a **fresh** strong confirmation (no durable approval token)

---

## Residual risks (honest)

- Physical BiometricPrompt not yet hardware-validated
- F6H product UI not yet exposed in WebView (intentional for dark stage)
- Upload signing keystore is the long-lived app-update key (protect it; do not rotate casually)
- `android:allowBackup="true"` with explicit exclusions for identity/session/device prefs — policy relies on those excludes remaining intact
- Windows desktop sealed-migration runtime still absent (Android-first)

---

## Production deployment readiness

| Question | Answer |
|----------|--------|
| Identity security implementation complete? | **Yes** (local) |
| Stage-5 ready to close? | **No** (needs production Android rollout + later product phases) |
| Ready for **owner approval** of dark install? | **Yes** after F6J gate PASS |
| Deploy / push / publish now? | **No** — wait for explicit owner order |

**Owner next action (one):** approve R1 internal install of `1.0.125`, or request fixes from the F6J gate report.
