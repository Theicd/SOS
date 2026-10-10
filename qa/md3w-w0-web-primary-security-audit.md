# MD3W-W0 — Mobile Web Primary Security & Architecture Audit

| Field | Value |
|-------|-------|
| STATUS | **DESIGN_READY** |
| Baseline HEAD | `d1bcc5168d9e02564c505d4b10c69a8d9b5f208a` |
| Worktree | `C:\BRAIN\SOS-MD4-S0-RECON-20261009-155349` |
| Mode | Read-only audit + implementation blueprint |
| Code / docs mutated | **false** (this qa report only) |
| S7A2 hardware | NOT_VERIFIED |
| S6 gaps remaining | 28 |

---

## A. Identity and trust-boundary audit

### What exists today

| Component | Role | Holds Root K? |
|-----------|------|---------------|
| Global Account (`P`, kind 39007/39008) | Account identity + disable gate | No |
| Admission / invite onboarding | Mints/activates Global Account | No |
| Web session (`session-authority.js`, login state) | UX + soft gates | No |
| `sos-crypto-worker.js` Worker Vault | Typed product signing under K; bans K export | **Yes (Worker-only)** |
| `sos-crypto-signer.js` (main-thread facade) | Typed ops; may delegate to Worker/native | Transient / Worker |
| Isolated signer `https://signer.sos010.com` | F5B4 import, F5B5 WebAuthn reveal, F5B6-W handoff import | **Yes (signer vault, separate origin)** |
| Android `SosSecureIdentityStore` + `PhoneIssuer` | Sole **product** MD3 DeviceAuthorization issuer today | **Yes (native)** |
| Desktop / `sos-web-linked-devices.js` | SOSPAIR1 QR show, MD2 session, `verifyStrict` accept | No (Desktop = NORMAL_PROFILE destination) |

### What proves authority to request root-signed DeviceAuthorization

**Not sufficient alone:**

- Session cookie / localStorage login flag  
- Presence of Global Account card / kind 39007  
- Successful invite redeem  
- Scanning a SOSPAIR1 QR  

**Required cryptographic authority (MD0/MD3):**

Ability to produce Schnorr `rootSignature` over  
`SHA256(canonical-line-v1 under domain SOS_DEVICE_AUTHORIZATION_V1)`  
using account Root **K**, after **explicit user confirmation** of a bound payload hash.

**Today that path exists only on Android:**

```
SosSecureIdentityStore → PhoneIssuer.signAfterConfirm
  → SosDeviceAuthorization.signUnderRoot
  → AEAD deliver → Desktop verifyStrict / verifyForDestination
```

`sos-web-linked-devices.js` `beginPrimaryApproval` explicitly sets  
`WEB_MD3_ISSUANCE=false`, `MD3_ISSUANCE_PATH=REQUIRES_SOS_ANDROID_APP` when no native bridge.

### Trusted component that holds signing authority today

1. **Android PhoneIssuer** — only live DeviceAuthorization issuer.  
2. **Browser Worker Vault** — holds K for typed Nostr/product ops (`SIGN_CHAT_EVENT`, …); **no** `AUTHORIZE_LINKED_DEVICE`.  
3. **Isolated Signer vault** — holds K after F5B4/F5B6-W; used for reveal/handoff; **no** DeviceAuthorization op.

---

## B. Typed Trusted Signer operation — `AUTHORIZE_LINKED_DEVICE`

### Feasibility verdict

**FEASIBLE** without a new unrestricted root-signing API, by extending the **existing typed-op pattern** already used by Worker (`OP_SPECS` / `signTyped`) and mirroring Android `SosDeviceAuthorizationCeremony.OP`.

Does **not** require copying K to Desktop or main-origin page.

### Recommended W1 architecture (two assurance tiers)

| Tier | Where K signs | User verification | When to use |
|------|---------------|-------------------|-------------|
| **T1 (minimum, matches Worker chat)** | Worker typed op `AUTHORIZE_LINKED_DEVICE` | Explicit in-page confirm UI + one-time challenge consume (Android ConfirmationGate parity) | Default Web Primary |
| **T2 (stronger, owner option)** | Isolated signer popup after K present in signer vault (F5B4/F5B6-W) + **WebAuthn UV** | Signer-origin confirmation screen | High-assurance / post-handoff accounts |

**Do not** add generic `sign(bytes)` / `getPrivkey` on page or signer.

Residual (honest, same class as F5B6-W §3): main-origin XSS can drive Worker typed ops. T2 reduces that for this op if K is only in signer vault at sign time. Owner must pick T1 vs T1+T2.

### Input schema (W1)

```
AUTHORIZE_LINKED_DEVICE {
  challengeId: hex,                 // one-time, created at PENDING_CONFIRM
  accountP: hex64,                  // must == vault P
  authorization: {                  // full draft fields pre-signature
    version: "sos-device-authorization-v1",
    authorizationId: hex64,
    accountP, deviceId,
    D_sign_pub, D_enc_pub,
    capabilities: string[],         // NORMAL_PROFILE + optional HISTORY_SYNC (default on)
    authEpoch: number,              // >= 1; account-scoped
    createdAt, expiresAt,           // default lifetime 365d (MD3)
    pairingTranscriptHash: hex64,
    pairingId: hex,
    storageSecurityClass: "SOFTWARE_ONLY" | ...,
    recoveryEligibleAtAuthorization: boolean,
    deviceLabel: string
  },
  confirmPayloadHash: hex64,        // must match ConfirmIntent.payloadHash()
  origin: string,                   // expected return origin allowlist
  requestingSessionId: string,      // bind to pairing session / tab
  userApproved: true                // must be set only after UI approve
}
```

### Exact signed bytes

Reuse Android/JS parity:

- Domain: `SOS_DEVICE_AUTHORIZATION_V1`  
- Encoding: `canonical-line-v1` newline fields (see `SosDeviceAuthorization.canonicalBytes`)  
- `messageHash = SHA256(canonicalBytes)`  
- `rootSignature = Schnorr(messageHash, K)`  
- Response to page: **signed authorization JSON only** (never K/nsec)

### Bindings & controls

| Control | Rule |
|---------|------|
| accountP | Must equal Worker/signer vault P |
| deviceId / D_sign / D_enc | From MD2 BoundDestination only |
| pairingTranscriptHash | SHA256 transcript from completed PoP |
| authorizationId | Fresh CSPRNG; unique |
| authEpoch | Current account epoch; reject stale |
| DEVICE_HISTORY_SYNC | Included in NORMAL_PROFILE (MD3) |
| Expiration | `expiresAt`; reject if clock skew exceeds policy |
| Confirmation | Challenge created at begin; `consume` requires prior approve; payload mutation → fail |
| Cancel | Removes challenge; post-cancel sign → `NOT_APPROVED` / `NO_CHALLENGE` |
| Single-use | Challenge + pairingId spent after success |
| Rate limit | Per-P authorize attempts (suggest ≤ 5 / 10 min) |
| Origin | postMessage / opener allowlist (`sos010.com`) |
| Failure modes | `NOT_AUTHENTICATED`, `ACCOUNT_DISABLED`, `PAYLOAD_MUTATION`, `EXPIRED_QR`, `WRONG_P`, `SIGNER_UNAVAILABLE`, `UV_REQUIRED`, `ALREADY_CONSUMED` |

### Existing Trusted Signer interfaces

| Surface | Can host op? | Notes |
|---------|--------------|-------|
| Worker `OP_SPECS` | **Yes** | Add op + confirmation gate; keep `assertNoKeyLeak` |
| Main `sos-crypto-signer.js` | Facade only | Must not sign DeviceAuthorization on page with raw K |
| `signer.sos010.com` | **Optional T2** | Needs new typed UI page; no reveal/export of K for this op |
| Android PhoneIssuer | Unchanged | Regression path |

---

## C. Mobile Web QR intake

Reuse **one** parser: `SosMd2PairingQr.parseQr` / `SosPairingCrypto` SOSPAIR1 (same as Android `SosLinkedDeviceQrIntake`).

| Concern | Plan |
|---------|------|
| HTTPS secure context | Required for `getUserMedia` |
| Chrome Android | `getUserMedia` + `BarcodeDetector` (same pattern as `sos-invite-qr-ui.js`) |
| Safari iOS | `getUserMedia` OK; `BarcodeDetector` often **missing** → fallback: wasm/jsQR **or** file/camera frame canvas decode; document matrix |
| Permission denied | Hebrew error; paste QA path optional but **not** hardware PASS |
| Visibility / suspend | `visibilitychange` → stop tracks; resume requires user gesture |
| Duplicate callbacks | Atomic consume flag (S7A1 pattern) |
| Invalid / expired / replay | Parser + MD2 spent store |
| Group Invite isolation | Reject non-`SOSPAIR1:` and invite URLs (`GROUP_INVITE_QR`) |

---

## D. Web Primary pairing transport (reuse MD2/MD3)

```
Desktop: beginDesktopInitiator → SOSPAIR1 QR (existing)
Mobile Web Primary:
  scan → parseQr → Md2PairingSession.Responder
  → kind 25060 hello/PoP/AEAD (existing sos-md2-pairing-session + transport)
  → BoundDestination
  → Global status gate (assertIssuanceAllowed)
  → PENDING_APPROVAL UI (device fingerprint, SAS, P)
  → AUTHORIZE_LINKED_DEVICE (Worker/Signer typed)
  → AEAD deliver device_authorization
Desktop:
  → SosMd4DeviceAuth.verifyStrict / verifyForDestination
  → durable store → LINKED
```

| Rule | Value |
|------|-------|
| Desktop profile | NORMAL_PROFILE (unchanged) |
| SAME_GLOBAL_P | auth.accountP == mobile vault P == desktop expected |
| Cancel | No ACTIVE registry; Desktop stays unlinked |
| Restart mid-flow | New QR; spent pairingId not reusable |
| Account switch during approve | Fail closed (`ACCOUNT_MISMATCH`) |

---

## E. Web Primary history / media (MD4W-W3 adapter)

### Android-only today

| Piece | Location | Web gap |
|-------|----------|---------|
| CKI derive under K + seal to `D_enc` | `SosHistorySyncExporter` / `SosConversationKeyIndex` (Android) | Need Worker typed `EXPORT_SEALED_CKI` (or equivalent) — **no plaintext CKI to page** |
| History bootstrap session | `SosHistorySyncPhoneSession` | Port session state machine to JS primary role |
| Local chat/event source | Android local stores | Browser chat IDB / relay-backed history only |
| Attachments | Android media + S5 hybrid | Browser Blossom/P2P clients exist; local-only blobs may be missing |

### Reusable on Desktop (unchanged)

`sos-md4-cki.js`, `sos-md4-history-sync.js`, `sos-md4-attachment-sync.js`, durable device store, ACK/tombstone gates.

### Explicit non-coverage

- History/media that lived **only** on an Android install never synced to relays/Blossom **cannot** be exported by Mobile Web Primary.  
- Browser local-only drafts not on relays: report `INACCESSIBLE_LOCAL_ONLY`.  
- Never claim complete history without coverage evidence.

---

## F. MD5 offline dependency (OPEN — do not decide)

| Question | Current approved posture |
|----------|--------------------------|
| Desktop signed account-P messages phone offline? | MD0: **A** delegated `sig_D` for SO-CALL-native; **B** phone co-sign for standard Nostr-as-P |
| Mobile Web suspended/closed? | Same OPEN productization — no APK process; browser may be killed |
| Co-sign vs delegated | **OPEN** until owner resolves `MD5_OFFLINE_SIGNING_DECISION` |
| Forbidden | Copy Root K to Desktop |
| New CKI after revoke | MD6/MD5 territory; authEpoch raise stops sync |

---

## G. Security-negative test blueprint

| ID | Case | Auto browser | Real mobile HW |
|----|------|--------------|----------------|
| W0-N01 | Invited but unauthenticated | Yes | — |
| W0-N02 | Authenticated session, no signer approve | Yes | — |
| W0-N03 | Wrong account P | Yes | — |
| W0-N04 | Forged Desktop QR | Yes | — |
| W0-N05 | Wrong D_sign/D_enc | Yes | — |
| W0-N06 | Expired / replayed QR | Yes | — |
| W0-N07 | Fake Trusted Signer / Worker response | Yes | — |
| W0-N08 | Cross-origin signer injection | Yes | — |
| W0-N09 | Unauthorized signature request (no challenge) | Yes | — |
| W0-N10 | Missing user approval | Yes | — |
| W0-N11 | Sign after cancel | Yes | — |
| W0-N12 | Stale authEpoch | Yes | — |
| W0-N13 | Account switch during approval | Yes | — |
| W0-N14 | Cross-device auth substitution | Yes | — |
| W0-N15 | Mobile browser restart mid-pair | Partial | Preferred |
| W0-N16 | Trusted Signer / Worker unavailable | Yes | — |
| W0-N17 | Camera permission denied | Emulator limited | **Yes** |
| W0-N18 | Chrome Android optical scan | — | **Yes** |
| W0-N19 | Safari iOS optical scan / fallback | — | **Yes** |
| W0-N20 | No Root K/nsec leak (page, QR, Desktop, logs) | Yes | Yes |
| W0-N21 | Android MD3 path regression | Emulator paste | S7A2 camera |

---

## H. Slice boundaries

| Slice | Scope | Not in scope |
|-------|-------|--------------|
| **W1** | Typed `AUTHORIZE_LINKED_DEVICE` (Worker T1; optional Signer T2) + web PhoneIssuer ceremony parity + Desktop verify unchanged | QR camera UX, history export |
| **W2** | Mobile Web Linked Devices scan/approve/cancel UX; Chrome Android + Safari iOS matrix; reuse SOSPAIR1/MD2 | History/media |
| **W3** | Web Primary sealed CKI + history/media adapter; inaccessible-local reporting | MD5 live sync |
| **S7B** | Dual-primary full E2E | — |
| **S8** | Full regression both primaries | — |
| **MD5+** | Live sync / revoke — after offline-signing decision | — |

---

## Files to reuse / expect to change (future W1–W3 only)

**Reuse:**  
`sos-md2-pairing-qr.js`, `sos-md2-pairing-session.js`, `sos-web-linked-devices.js` (Desktop half), `sos-md4-device-auth.js`, `sos-md4-device-store.js`, `sos-md4-history-sync.js`, `sos-md4-cki.js`, `sos-md4-attachment-sync.js`, `SosDeviceAuthorization*` (schema parity), `sos-invite-qr-ui.js` (camera pattern), `f5b6w-handoff-client.js` (optional T2), `global-account-status-state.js`.

**Expect change (after W1+ approval):**  
`sos-crypto-worker.js`, `sos-crypto-signer.js`, `sos-web-linked-devices.js` (Primary path), new web PhoneIssuer module, optional signer-repo authorize page, W3 exporter Worker op, gates under `qa/md3w-*`.

---

## Owner decisions required

1. **T1 vs T2:** Worker-only confirm vs mandatory Signer + WebAuthn for `AUTHORIZE_LINKED_DEVICE`.  
2. Acknowledge Worker XSS residual (same class as other typed signs / F5B6-W).  
3. Safari iOS fallback scanner library choice.  
4. Whether Web Primary requires prior F5B6-W personal-key backup.  
5. Keep `MD5_OFFLINE_SIGNING_DECISION` OPEN until dedicated MD5 design.  
6. Approve start of **MD3W-W1** separately.

## Blockers (implementation, not design)

- No Web PhoneIssuer code yet  
- No `AUTHORIZE_LINKED_DEVICE` in Worker/Signer OP_SPECS  
- No Mobile Web QR product surface for Linked Devices  
- S7A2 physical Android still NOT_VERIFIED (parallel track)  
- MD5 offline signing OPEN (does not block W1–W3)
