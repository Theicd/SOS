# Stage 5 — Linked Devices Roadmap (canonical)

**Document control**

| Field | Value |
|-------|-------|
| Path | `docs/security/STAGE5_LINKED_DEVICES_ROADMAP.md` |
| Role | **Canonical** Stage 5 linked-device / dual-primary ordering |
| Supersedes for ordering | MD0 §45 phase table (historical naming); see cross-refs below |
| MD0 crypto decisions | **Intact** — see `MD0_LINKED_DEVICES_ARCHITECTURE.md` |
| Runtime / production | Docs only in this amendment; no implementation implied |
| Baseline HEAD (audit) | `d1bcc5168d9e02564c505d4b10c69a8d9b5f208a` |
| Worktree (audit) | `C:\BRAIN\SOS-MD4-S0-RECON-20261009-155349` |

Related (do not fork competing roadmaps):

- Architecture / crypto: `docs/security/MD0_LINKED_DEVICES_ARCHITECTURE.md`
- Device auth: `docs/security/MD3_DEVICE_AUTHORIZATION.md`
- History sync: `docs/security/MD4_HISTORY_SYNC_S0.md`
- Web product handoff (separate track): `docs/WEB_FINALIZATION_ROADMAP.md`
- Integration map: `docs/SECURITY_PRODUCT_INTEGRATION_MAP.md`

---

## REQ_ID=STAGE5_DUAL_PRIMARY_QR_PAIRING

**Mandatory product requirement.** Every valid, authenticated SOS account holder must be able to link a Desktop through a QR code using **either**:

| Mode | Primary | Requirement |
|------|---------|-------------|
| **A** | Android APK Primary | Existing MD1–MD4 path; physical camera QR acceptance |
| **B** | Mobile Web Primary | Phone browser, **no APK**; same security model |

Applies to:

- Invited users with activated Global Account  
- `NEW_39007` accounts  
- `LEGACY_NO_PHONE` accounts  

Invariants (both modes):

- Same Global **P**  
- Same DeviceAuthorization rules (`sos-device-authorization-v1`, `verifyStrict`)  
- Same desktop linkage / capability model  
- Initial encrypted history + media sync (MD4)  
- Later continuous live sync (**MD5**)  
- Device revoke (**MD6**)  

**Hard rules:**

- An authenticated web session alone **does not** authorize signing DeviceAuthorization.  
- No Root **K** / **nsec** copy to Desktop or expansion of root-key APIs.  
- No security downgrade of Trusted Signer / PhoneIssuer architecture.  
- Communities **must not** start before approved Stage 5 gates complete.

---

## Current verified status (as of MD4 S6)

| Track | Status |
|-------|--------|
| MD1–MD3 pairing / authorization (Android Primary) | PASS (local + MD3 live paste-path QR) |
| MD4 S0–S5 history / media | PASS |
| MD4 S6 security matrix | `PASS_WITH_RELEASE_GAPS` (92 PASS / 0 FAIL / 28 NOT_VERIFIED) |
| Android Primary full physical camera QR | **NOT_VERIFIED** (`HARDWARE_CAMERA_QR`) |
| Mobile Web Primary DeviceAuthorization issuance | **NOT_IMPLEMENTED** |
| Public WebTorrent E2E | **NOT_VERIFIED** |
| Chromium in-page peak memory | **NOT_MEASURED** |

---

## Architecture audit snapshot (read-only)

### Android Primary (current)

```
Desktop SOSPAIR1 QR
  → Android SosLinkedDevicesActivity / SosLinkedDeviceOrchestrator
  → SosDeviceAuthorizationCeremony.PhoneIssuer.signAfterConfirm
  → SosDeviceAuthorization.signUnderRoot (Schnorr under account P)
  → Desktop verifyStrict + durable store
  → MD4 CKI seal-to-D_enc + history/media
```

- Bridge explicitly reports `WEB_MD3_ISSUANCE=false`, `MD3_ISSUANCE_PATH=ANDROID_NATIVE` (`SosJsBridge.startLinkedDevicePairing`).  
- Root K remains in `SosSecureIdentityStore`; no WebView root sign.

### Mobile Web Primary (current gap)

| Area | Finding |
|------|---------|
| Web PhoneIssuer | **Absent** — `sos-web-linked-devices.js` / `sos-md2-pairing-session.js` state MD3 issuance stays on Android |
| Trusted Signer (`signer.sos010.com`) | Personal-key import + typed product ops; **no** `AUTHORIZE_LINKED_DEVICE` / DeviceAuthorization issuance API found |
| Web root isolation | Main origin must not hold K; Worker Vault / isolated signer isolate personal key — **correct posture**; still insufficient for DeviceAuthorization without a typed issuer op |
| Reusable components | SOSPAIR1, MD2 transcript/PoP, MD3 schema, desktop `verifyStrict`, MD4 CKI/history/media stack |
| Camera / HTTPS | Hardware camera QR not verified even on APK; mobile web needs secure-context camera / BarcodeDetector (or equivalent) + iOS Safari matrix — **gap** |
| History from web primary | MD4 exporter today is Android-side (`SosHistorySyncPhoneSession` / exporter). Browser-local history not on APK may be inaccessible — must be reported explicitly in MD4W_W3 |

### MD5 offline account-P signing (OPEN — do not solve by copying Root K)

MD0 §7–§8 already selected:

- **A** delegated-device protocol (`sig_D` under authorized `D_sign`) for SO-CALL-native ops  
- **B** optional phone co-sign for standard Nostr-as-P authorship  
- **C** copy K to desktop — **rejected**

**Unresolved for MD5 productization (mark OPEN):**

1. How Desktop sends **signed account-P** messages when phone is offline?  
2. How that works when **Mobile Web** primary is suspended/closed (no APK process)?  
3. Approved model for MD5: delegated signing vs trusted co-signing vs other **already-reviewed** approach?

| Decision | Value |
|----------|-------|
| `MD5_OFFLINE_SIGNING_DECISION` | **OPEN** |
| Forbidden solution | Copy Root K / nsec to Desktop |
| Owner input required | Confirm A vs B (or hybrid) for each product surface before MD5 implementation |

---

## Updated Stage 5 order (mandatory)

Preserve canonical **MD4 → MD5 → MD6 → MD7 → MD8 → MD9** macro order.  
Insert dual-primary gates **after MD4 S6** and **before MD5**:

| # | Gate | Intent | Implementation now? |
|---|------|--------|---------------------|
| — | MD4 S0–S6 | Done (S6 = security matrix w/ release gaps) | — |
| 1a | **MD4_S7A1_ANDROID_QR_SCANNER_IMPLEMENTATION** | Native CameraX + on-device QR scanner in Linked Devices; reuse SOSPAIR1/MD2/MD3; paste path remains QA-only | **PASS_S7A1_CODE_READY** (2026-10-10) — see `qa/md4-s7a1-android-qr-scanner-report.json` |
| 1b | **MD4_S7A2_ANDROID_PHYSICAL_QR_ACCEPTANCE** | Real phone camera scan of Desktop SOSPAIR1; NEW + LEGACY; history/media; restart; negatives | **PARTIAL_PHYSICAL_PASS** (2026-10-11): Xiaomi M2101K6G `fe97fda6`; `adb install -r` **Success** for `com.sos010.app` 1.0.127/128 (SHA256 `729A4C85…`); optical APK QR / Desktop LINKED / NEW+LEGACY E2E **NOT_VERIFIED** (LinkedDevices not exported; androidTest APK still hit intermittent MIUI `INSTALL_FAILED_USER_RESTRICTED`). Procedure: `qa/md4-s7a2-physical-qr-procedure.md`; report: `qa/.physical-qr/s7a2-w2-physical-acceptance-report.txt` |
| 2 | **MD3W_W0_WEB_PRIMARY_SECURITY_AUDIT** | Worker/Trusted Signer authority; Web PhoneIssuer gap; mobile web lifecycle; camera/HTTPS; exact missing pieces; **no new root-key APIs** | **PASS** (prior) |
| 3 | **MD3W_W1_WEB_PRIMARY_AUTH_ISSUER** | Canonical DeviceAuthorization via trusted signing; reuse SOSPAIR1/MD2/MD3/`verifyStrict` | **PASS_W1A + PASS_WITH_GAPS W1B** (T2 signer + Worker AUTHORIZE_LINKED_DEVICE; live Desktop LINKED E2E still open) |
| 4 | **MD3W_W2_MOBILE_WEB_QR_PAIRING** | Phone-browser scan/approve/cancel/reject/live; Chrome Android + Safari iOS | **STATIC_PREVIEW_READY** + **OPTICAL_CAMERA_PASS** (local harness) (2026-10-11): isolated Pages `https://theicd.github.io/SOS-qa-stage5-preview/` (repo `SOS-qa-stage5-preview`, source SOS@8707291, version `2026.10.11-qa-stage5-dual-primary-w2`); Xiaomi Chrome local harness `SCANNED` pairingFp `b57e8fd5…` with `DECODE_IS_NOT_AUTHORIZATION=true`. **PROTOCOL_PASS** (canonical parse on optical). **LIVE_SIGNER_WORKER_PASS / DESKTOP_LINKED_PASS** = **NOT_VERIFIED**. Hosted product Linked Devices optical needs QA login. Safari iOS **NOT_VERIFIED**. Production sos010.com **unchanged** (899s.8). |
| 5 | **MD4W_W3_WEB_PRIMARY_HISTORY_MEDIA** | Reuse MD4 CKI/history/media; report inaccessible browser/local-only history | Future only |
| 6 | **MD4_S7B_DUAL_PRIMARY_FULL_E2E** | Mandatory acceptance for **both** primary modes | Future only |
| 7 | **MD4_S8_FINAL_REGRESSION** | Must include both primary modes (not APK-only) | Future only |
| → | **MD5_LIVE_SYNC_DUAL_PRIMARY** | Continuous sync; depends on OPEN offline-signing decision | Future |
| → | **MD6_DEVICE_REVOKE_AND_RECOVERY** | Revoke + recovery paths | Future |
| → | **MD7_OFFLINE_RECOVERY** | New-phone / offline recovery | Future |
| → | **MD8_FEATURE_PARITY** | Feature parity across primaries | Future |
| → | **MD9_ADVERSARIAL_SCALE** | Adversarial + scale | Future |
| → | **STAGE5_FINAL_SECURITY_REGRESSION** | Final Stage 5 security closure | Future |

**Communities:** blocked until Stage 5 gates above are approved complete.

### Note on MD0 §45 naming

MD0’s historical table used different labels (e.g. MD6=Recovery Capsule, MD8=Revocation).  
**This document is authoritative for Stage 5 delivery order.** MD0 cryptographic selections remain authoritative for security model.

---

## S6 — 28 NOT_VERIFIED gap triage

Do **not** relabel as PASS. Also keep release markers:

- `PUBLIC_WEBTORRENT_E2E=NOT_VERIFIED`  
- `CHROMIUM_IN_PAGE_MEMORY=NOT_MEASURED`  
- `HARDWARE_CAMERA_QR=NOT_VERIFIED` (physical device present 2026-10-11; APK USB install restricted — optical acceptance still open)  

| Case ID | Reason NOT_VERIFIED | Security impact | Priority | Required environment | Target gate | Blocks implementation? | Blocks release? |
|---------|---------------------|-----------------|----------|----------------------|-------------|------------------------|-----------------|
| B1-20 | Full live forged-auth wire E2E not isolated | Medium — verifyStrict covers forge; live wire corpus missing | P1 | 3-browser + relay live | MD4_S8 / STAGE5_FINAL | No | Soft |
| B1-21 | Dedicated DeviceAuthorization transcript-mismatch case not keyed | Medium — ACK/HELLO AAD bind covered | P1 | Browser + Android unit | MD4_S7A / S8 | No | Soft |
| B1-22 | D_enc mismatch on auth record not separately keyed in S1 | Medium — D_sign covered | P2 | S1/S7A negatives | MD4_S7A | No | Soft |
| B1-23 | Mid-sync device substitution race not instrumented | High if missed — bind checks exist | P0 | Live MD3→MD4 race harness | MD4_S7B / S8 | No | **Yes (acceptance)** |
| B3-40 | Non-in-flight batchId ACK not isolated | High for ACK integrity | P0 | Phone/desktop ACK harness | MD4_S8 / STAGE5_FINAL | No | Soft |
| B3-41 | Duplicate valid ACK double-advance not asserted | Medium — idempotent import covered | P1 | ACK harness | MD4_S8 | No | Soft |
| B3-42 | Explicit cross-session ACK replay corpus missing | High | P0 | Multi-session relay | MD4_S8 / STAGE5_FINAL | No | Soft |
| B3-43 | Forged SYNC_HELLO browser wire not mapped | High | P0 | Browser hist session | MD4_S7A / S8 | No | Soft |
| B3-44 | Explicit protocol version downgrade not isolated | Medium — collision covered | P2 | Unit/browser | MD4_S8 | No | Soft |
| B3-45 | Live premature SYNC_DONE not keyed | High — FINAL_ACK static exists | P0 | Live hist | MD4_S7A / S8 | No | Soft |
| B3-46 | Concurrent conflicting sync sessions | High | P0 | Dual desktop / dual session | MD4_S7B / S8 | No | **Yes (acceptance)** |
| B4-20 | Crash between import and checkpoint | High for resume safety | P0 | Crash-injection | MD4_S7A / S8 | No | Soft |
| B4-21 | Crash between commit and ACK | High — false COMPLETE risk | P0 | Crash-injection | MD4_S7A / S8 | No | Soft |
| B4-22 | Android process interruption resume | High | P0 | Instrumented Android | MD4_S7A | No | Soft |
| B4-23 | Incomplete relay coverage → false COMPLETE | High | P0 | Multi-relay lab | MD4_S8 | No | Soft |
| B4-24 | Same-timestamp pagination as negative matrix key | Low–Med — S4 E2E covers pagination | P2 | S4 E2E | MD4_S8 | No | Soft |
| B5-20 | Raw NIP-44 tombstone bypass probe not isolated | High if bypass exists | P0 | Browser adversarial | MD4_S8 / STAGE5_FINAL | No | Soft |
| B6-20 | Public WebTorrent swarm | Med — hybrid Blossom/local covered | P1 | Public trackers + NAT | STAGE5_FINAL (or accept gap) | No | Soft / product |
| B6-21 | Chromium in-page peak during large transfer | Med — node RSS measured | P2 | Playwright CDP / performance.memory under 32MiB | MD4_S7A / S8 | No | Soft |
| B6-22 | Hardware camera QR | **High product** — S7A1 adds scanner wiring; optical acceptance = S7A2 | P0 | Physical camera device | **MD4_S7A2** (mandatory) | No | **Yes** |
| C-01 | MD3 pairing → auth expiry multi-step | High | P0 | Live MD3→time travel | MD4_S7B / S8 | No | Soft |
| C-02 | Account switch during history import | High | P0 | Dual-account browser | MD4_S7B / S8 | No | Soft |
| C-03 | Revocation during media transfer | High | P0 | Live revoke mid-hydrate | MD4_S7B / MD6 prep | No | Soft |
| C-04 | Relay replay across history sessions | High | P0 | Multi-session relay | MD4_S8 | No | Soft |
| C-05 | Device key substitution on reconnect | High | P0 | Reconnect harness | MD4_S7B / S8 | No | Soft |
| C-07 | Corrupt media then fallback source matrix | Med — hybrid fail-closed covered | P1 | Hybrid media lab | MD4_S7B / S8 | No | Soft |
| C-08 | Interrupted bootstrap + forged completion | High | P0 | Live hist adversarial | MD4_S7A / S8 | No | Soft |
| C-09 | Concurrent desktops one account | High | P0 | Multi-desktop | MD4_S7B / S8 | No | **Yes (acceptance)** |

---

## Next safe implementation slice

**MD4_S7A1** — Android QR scanner product wiring (this slice).  
**MD4_S7A2** — physical camera acceptance on a real device (separate approval / hardware).  
**MD3W_W0** — may run in parallel as **docs/read-only** audit (independent of S7A2 hardware).  
**Do not** start MD3W_W1 / W2 / MD4W_W3 without approval.

---

## Owner decisions required

1. Acknowledge `STAGE5_DUAL_PRIMARY_QR_PAIRING` as release-mandatory.  
2. Approve Stage order in this document (S7A → W0…W3 → S7B → S8 → MD5…).  
3. Resolve **`MD5_OFFLINE_SIGNING_DECISION`** (OPEN) before MD5 implementation — without Root K on Desktop.  
4. Confirm whether public WebTorrent / Chromium peak memory remain soft release gaps vs hard blockers.  
5. Approve start of **MD4_S7A** (separate instruction).

---

## Non-goals for this amendment

- No MD3-W / MD4 S7 / MD5 code  
- No commit / push / PR / deploy  
- No Production changes  
- No Communities
