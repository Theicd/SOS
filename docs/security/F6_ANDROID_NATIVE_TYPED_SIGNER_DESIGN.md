# F6 — Android Native Typed Signer Architecture

**Status:** DESIGN ONLY (implementation-ready package)  
**Worktree:** `C:\BRAIN\SOS-stage5-preinfra`  
**Branch:** `local/stage5-preinfra-integration`  
**Base HEAD at design start:** `b4e847ba0e926f24d40665117e6aedc6f0ea6a78`  
**Package:** 892  
**Date:** 2026-09-24  

**Non-goals (this document):** F5B5, F5B6, Package 893, Cloudflare/DNS, V2, Community C1, identity rotation, legacy delete, R2 call/nav rewrite, Kotlin/JS runtime changes.

**Invariant:** F6 preserves the **same registered identity** (`same K`, `same P = derive(K)`). Corruption → `RECOVERY_REQUIRED`, never silent generate.

---

## 0. Executive summary

Today Android holds a **plaintext hex private key** in `SharedPreferences` (`SosSessionStore`) and exposes it to WebView via bridge (`setUserPrivkey`, and critically `getVerifierSessionJson` returns `privkey`). Crypto helpers (`SosNostrCrypto.signEvent(privHex, …)`) are generic and take raw K.

**F6 target:** Android Keystore–wrapped durable identity + **typed** native operations only. WebView never receives raw K/nsec. Session authority (F7 `sessionGeneration`) gates every typed call. P2P bulk/chunk paths stay unchanged. Offline local crypto works without `signer.sos010.com` / Cloudflare.

`F6_DEPENDS_ENTIRELY_ON_F5B6 = false`. Core F6A–F6F can ship before F5B6; sealed cross-origin migration remains F5B6-blocked.

---

## 1. Current Android crypto audit

### 1.1 Primary files / classes / functions

| Path | Role | F6 relevance |
|------|------|--------------|
| `android-shell/.../SosNostrCrypto.kt` | `signEvent(privHex,…)`, `nip04Encrypt/Decrypt`, `nip44*`, `verifyEvent*` | **F6_REQUIRED** — becomes internal backend; must lose public privHex surface to WebView |
| `android-shell/.../SosNip44.kt` | NIP-44 helpers | **F6_REQUIRED** |
| `android-shell/.../SosSessionStore.kt` | pubkey/privkey in prefs `sos_native_session`; `getPrivkey`/`setPrivkey` plaintext | **F6_REQUIRED** — replace durable K storage |
| `android-shell/.../SosJsBridge.kt` | `@JavascriptInterface` WebView bridge | **SHARED_FILE** — add typed APIs; do not redesign call/nav methods |
| `android-shell/.../MainActivity.kt` | WebView host; `addJavascriptInterface(SosJsBridge, "SosNativeShell")` | **SHARED_FILE** / **UNRELATED_R2_WIP** overlap |
| `android-shell/.../IncomingCallActivity.kt` | Incoming call UI | **UNRELATED_R2_WIP** |
| `android-shell/.../SosSecureCallSessionStore.kt` | Call session persistence | **UNRELATED_R2_WIP** (call session ≠ identity session) |
| `android-shell/.../SosSecureWrapHandledStore.kt` | Secure wrap ack store | **SHARED_FILE** (call path; F6 must not rewrite) |
| `android-shell/.../SecureCallWakeActivity.kt` | Secondary WebView + bridge | **SHARED_FILE** |
| `android-shell/.../SosNativeCallVerifier.kt` | Giftwrap unwrap/sign using `SosSessionStore.getPrivkey` | **F6_REQUIRED** consumer — switch to typed native authority |
| `android-shell/.../SosNativeP2pEngine.kt` | Background P2P signaling; uses `getPrivkey` + `signEvent` | **F6_REQUIRED** consumer — typed sign/encrypt only; **not** chunk path |
| `android-shell/.../SosNativeFileTransfer.kt` | AES-GCM **file chunks** (already local content keys) | **SHARED_FILE** — **NATIVE_SIGNER_IN_FILE_CHUNK_HOT_PATH=false** |
| `android-shell/.../SosRelayWatcher.kt` | Background relay | Uses pubkey only — **SHARED_FILE** |
| `android-shell/.../SosContactCache.kt` | Contact cache | Unrelated identity crypto |
| `android-shell/.../SosPendingCallStore.kt` | Pending wraps | Call pipeline |
| `android-shell/.../SosWebView.kt` | IME / rich content WebView | Unrelated |
| `android-shell/.../AndroidManifest.xml` | `android:allowBackup="true"` | **F6_REQUIRED** backup policy review |
| `native-shell-bridge.js` | Web↔Native reconcile; expects `syncUserIdentity` / status JSON | **F6_REQUIRED** (JS contract; design only now) |
| `identity-lifecycle.js` | Logout/switch; `clearUserSession` | Session + native clear |
| `key-storage.js` | `NativeSecureProvider` expects `writeSecureWebIdentity` / `getSecureWebIdentityJson` | **F6_REQUIRED** contract gap |
| `session-authority.js` | F7 `sos_session_generation` | **F6_REQUIRED** bind |
| `sos-crypto-signer.js` | Browser typed facade | Parallel API shape for F6 typed ops |
| `admin-signing-policy.js` | AC9 typed admin | Map into native admin ops |

**Not found in this tree:** `SosSecureIdentityStore.kt` (canonical secure store absent).

### 1.2 Current private-key paths

1. **Web → Native write:** `SosJsBridge.setUserPrivkey(hex)` → `SosSessionStore.setPrivkey` → plaintext SharedPreferences.  
2. **Native internal read:** `SosSessionStore.getPrivkey` used by `SosNativeCallVerifier`, `SosNativeP2pEngine`.  
3. **Native → Web expose:** `SosJsBridge.getVerifierSessionJson()` returns JSON `{pubkey, privkey}` — **raw K to WebView**.  
4. **JS expects (often missing on this APK):** `writeSecureWebIdentity`, `getSecureWebIdentityJson`, `syncUserIdentity`, `getNativeIdentityStatusJson` — designed on JS side; Kotlin implementation incomplete / absent in audited tree → falls back to legacy `setUserPubkey`/`setUserPrivkey`.  
5. **No Android Keystore** wrapping of account identity today.

### 1.3 Current WebView bridge (identity-relevant)

| Method | Today | F6 fate |
|--------|-------|---------|
| `setUserPubkey` | Writes pubkey | Keep (public) |
| `setUserPrivkey` | Writes **plaintext K** | **Remove / refuse** after cutover |
| `clearUserSession` | Clears prefs (void) | Keep; also revoke native session capability |
| `getVerifierSessionJson` | Returns **privkey** | **Remove**; replace with typed verifier bootstrap |
| `syncUserIdentity` / `getNativeIdentityStatusJson` | Expected by JS, not in Kotlin | Implement securely (status **without** K) |
| `writeSecureWebIdentity` / `getSecureWebIdentityJson` | Expected by NativeSecureProvider | Implement Keystore store; **get must not return raw K to page** after F6 cutover |

### 1.4 Current Keystore / at-rest

- **ANDROID_KEYSTORE_USED (identity):** false today.  
- **NATIVE_PRIVATE_IDENTITY_PLAINTEXT_AT_REST:** true (`KEY_PRIVKEY` in `sos_native_session`).  
- File-transfer AES-GCM uses content keys (not identity K) — keep separate.

### 1.5 Current session model

- **App login session (F7):** `session-authority.js` — monotonic `sos_session_generation` + account bind; BroadcastChannel wake-up.  
- **Native call session:** `SosSecureCallSessionStore` / incoming call — unrelated to F7.  
- **Native identity prefs:** `SosSessionStore` — durable pubkey/privkey for background services.  
F6 must bind typed crypto to **F7 generation**, not call-session IDs.

### 1.6 R2 WIP overlap

| File | Classification |
|------|----------------|
| `IncomingCallActivity.kt` | UNRELATED_R2_WIP |
| `MainActivity.kt` | SHARED_FILE (bridge registration / navigation) |
| `SosSecureCallSessionStore.kt` | UNRELATED_R2_WIP |
| `SosSecureWrapHandledStore.kt` | SHARED_FILE (call correctness; leave logic) |
| `SecureCallWakeActivity.kt` | SHARED_FILE |
| Call notification / ringtone helpers | UNRELATED_R2_WIP |

**F6_DESIGN_DOES_NOT_REQUIRE_DISCARDING_R2_WIP = true**

---

## 2. Target security model

```
WebView (typed request + sessionGeneration + accountPubkey)
    → SosJsBridge / SosNativeTypedBridge (schema allowlist)
    → SosNativeSessionGate (F7 generation + account match)
    → SosNativePolicy (op allowlist; AC9 for admin)
    → SosSecureIdentityStore (Keystore-wrapped K; never returned)
    → SosNativeTypedSigner (internal SosNostrCrypto)
    → typed result (signed event / ciphertext / metadata)
```

Targets:

- `NATIVE_RAW_K_EXPOSED_TO_WEBVIEW = false`
- `NATIVE_NSEC_EXPOSED_TO_WEBVIEW = false`
- `GENERIC_NATIVE_SIGN_API = false`
- `GENERIC_NATIVE_DECRYPT_API = false`
- `ANDROID_KEYSTORE_USED = true`
- `NATIVE_PRIVATE_IDENTITY_PLAINTEXT_AT_REST = false`
- `NATIVE_IDENTITY_COMMUNITY_INDEPENDENT = true`
- `PER_COMMUNITY_NATIVE_SIGNER = false`
- `NATIVE_SIGNING_REQUIRES_REMOTE_API = false`
- `NATIVE_SIGNING_REQUIRES_CLOUDFLARE = false`
- `NATIVE_SIGNING_REQUIRES_SIGNER_HOST = false`
- `NATIVE_SIGNING_CREATES_100K_BOTTLENECK = false`
- `NATIVE_SIGNER_REQUIRES_NETWORK_FOR_LOCAL_CRYPTO = false`
- `NATIVE_SIGNER_IN_FILE_CHUNK_HOT_PATH = false`
- `NATIVE_SIGNER_IN_MEDIA_CHUNK_HOT_PATH = false`
- `P2P_BULK_DATA_PATH_UNCHANGED = true`
- `F6_CLAIMS_XSS_ELIMINATED = false`
- `F6_SILENT_IDENTITY_REPLACEMENT = false`

---

## 3. Canonical native identity store (`SosSecureIdentityStore`)

**New class (F6A):** `android-shell/.../SosSecureIdentityStore.kt`

### 3.1 Storage layout

| Component | Spec |
|-----------|------|
| Keystore key alias | `sos_identity_wrap_v1` (AES/GCM, non-exportable) |
| Blob prefs name | `sos_native_identity_secure_v1` (MODE_PRIVATE) |
| Blob fields | `ciphertext` (Base64), `iv` (12 bytes Base64), `pubkey` (hex64), `generation` (int), `aadVersion` (int), `updatedAt` |
| Algorithm | AES-256-GCM |
| IV | 96-bit random per write |
| AAD | UTF-8 stable: `SOS\|android-identity\|v1` (not URL/versionCode/community) |
| Plaintext payload | JSON `{"k":"<hex64>","p":"<hex64>","v":1}` verified `p == derive(k)` before seal |
| Atomic write | write temp → verify decrypt+pair → commit; on failure leave prior blob |
| Read | Keystore decrypt → validate pair → return **in-process only** to typed signer |
| Corruption | clear in-memory capability; state `RECOVERY_REQUIRED`; **never** `generateSecretKey` |
| Migration from plaintext prefs | One-way copy **same** K/P into secure store; then clear `KEY_PRIVKEY` from `sos_native_session` after verify |
| Backup | Exclude secure prefs + Keystore-bound material (see §21) |

### 3.2 Public API (native-only)

```
hasIdentity(): Boolean
getPublicIdentity(): pubkey | null          // never K
getStatusJson(): {hasIdentity, valid, state, pubkey}  // no K
sealIdentity(k, p): Result                 // same K/P only; trusted UI for import
clearIdentity(): Result                    // logout
withIdentityKey(block: (k) -> T): T        // internal; never crosses JS
```

No `getPrivkey()` for WebView. Internal callers (typed signer, call verifier) use `withIdentityKey` or sealed interfaces.

---

## 4. Identity states & transitions

Align with existing 5E-C / lifecycle language:

| State | Meaning |
|-------|---------|
| `IDENTITY_OK` | Native secure store valid; P matches K; session may bind |
| `IDENTITY_NEW_USER` | No web + no native identity |
| `WEB_ONLY` | Web has valid K; native empty → eligible for **same-K** seal copy |
| `NATIVE_ONLY` | Native sealed; Web has no page K (F6 goal) |
| `MISMATCH` | Web P ≠ Native P → fail closed; no overwrite |
| `INVALID` | Malformed material → no silent repair |
| `RECOVERY_REQUIRED` | Keystore/blob failure, partial restore, decrypt fail |

Transitions:

```
NEW_USER --explicit create/import--> IDENTITY_OK (same path as today; no auto-gen on boot)
WEB_ONLY --trusted seal of SAME K/P--> NATIVE_ONLY / IDENTITY_OK
IDENTITY_OK --logout clear--> NEW_USER (session revoke + store clear)
IDENTITY_OK --account switch--> clear A, seal B (same as lifecycle; generation bump)
MISMATCH / INVALID / RECOVERY_REQUIRED --explicit recovery UI only--> OK
```

**Forbidden:** boot-time generate; mismatch overwrite; “fix” by new K.

---

## 5. Typed native operation surface

Mirror browser `SosCryptoSigner` **narrowly**. Do **not** expose `signEvent(privHex, arbitrary)`.

### 5.1 Operation matrix

| Op | Expose? | Session | Policy | Confirm | Notes |
|----|---------|---------|--------|---------|-------|
| `SIGN_NOSTR_EVENT` | **No** (too broad) | — | — | — | Use typed kinds only |
| `SIGN_CHAT_EVENT` | Yes | Required | Identity | NO_CONFIRM | kind 1050 + recipient rules |
| `SIGN_PROFILE_EVENT` | Yes | Required | Identity | NO_CONFIRM | kind 0 |
| `SIGN_FEED` / `SIGN_REACTION` / `SIGN_FOLLOW` | Yes | Required | Identity | NO_CONFIRM | existing OP_SPECS |
| `SIGN_CALL_SEAL` / `SIGN_CALL_GIFTWRAP` | Yes | Required | Identity | NO_CONFIRM | preserve 1059 path |
| `SIGN_P2P_SIGNAL` / `SIGN_P2P_FILE` | Yes | Required | Identity | NO_CONFIRM | signaling only |
| `SIGN_READ_RECEIPT` / `SIGN_PRESENCE` / `SIGN_DELETE` | Yes | Required | Identity | NO_CONFIRM | |
| `SIGN_ADMIN_TYPED` | Yes | Required | **AC9** | NATIVE_CONFIRM for root/bootstrap/capability | Map `AdminSigningPolicy` |
| `SIGN_INVITE_TYPED` / `SIGN_INVITE_REVOKE` | Yes | Required | Invite policy | POLICY_DEPENDENT | |
| `SIGN_MEMBERSHIP_TYPED` | Yes | Required | AC9 member ops | NATIVE_CONFIRM for remove/block | |
| `SIGN_MODERATION_TYPED` | Yes | Required | Moderation policy | POLICY_DEPENDENT | |
| `SIGN_GROUP_CONTROL_TYPED` | Yes | Required | AC9 control ops | NATIVE_CONFIRM | |
| `NIP44_CHAT_ENCRYPT/DECRYPT` | Yes | Encrypt: Required; Decrypt: Required if session bound | Identity | NO_CONFIRM | |
| `NIP44_P2P_ENCRYPT/DECRYPT` | Yes | Same | Identity | NO_CONFIRM | Not per chunk |
| `FILE_KEY_WRAP/UNWRAP` | Yes | Required | Identity | NO_CONFIRM | Offer init only |
| `GENERIC_SIGN` / `GENERIC_DECRYPT` / `GET_K` / `EXPORT_K` | **Forbidden** | — | — | — | |

### 5.2 Request / response schema (bridge)

**Request JSON:**

```json
{
  "protocol": 1,
  "requestId": "uuid",
  "op": "SIGN_CHAT_EVENT",
  "sessionGeneration": 42,
  "accountPubkey": "<hex64>",
  "createdAtMs": 0,
  "params": { }
}
```

**Success:** `{ "ok": true, "requestId", "op", "result": { ... } }` — never `k`/`nsec`/`priv*`.  
**Failure codes:** `SESSION_REVOKED`, `SESSION_UNBOUND`, `ACCOUNT_MISMATCH`, `UNKNOWN_OP`, `MALFORMED`, `POLICY_DENIED`, `RECOVERY_REQUIRED`, `SIZE_LIMIT`, `REPLAY`, `EXPIRED`, `CONFIRM_REQUIRED`, `CONFIRM_DENIED`.

**Limits:** content ≤ 256 KiB (align browser); reject unknown keys; reject `__proto__` / secret field names.

**Replay:** `requestId` single-use window (e.g. 2 min) in native LRU; expired `createdAtMs` skew rejected.

---

## 6. Session revocation integration (F7)

Native holds **mirror** of authoritative generation:

1. On each typed request: compare `sessionGeneration` + `accountPubkey` to values last sealed from Web (`SosNativeSessionGate`).  
2. Web pushes updates via `SosNativeShell.bindNativeSessionAuthority({generation, accountPubkey})` (no secrets) whenever F7 binds/revokes.  
3. On mismatch / missing bind → fail closed; optional `deactivateNativeSignerCapability()`.  
4. Logout: JS `revokeSession` + `clearUserSession` + native clear secure store + clear session gate.

Targets:

- `REVOKED_WEBVIEW_CAN_USE_NATIVE_SIGNER = false`
- `STALE_SESSION_CAN_USE_NATIVE_SIGNER = false`
- `ACCOUNT_SWITCH_NATIVE_AUTHORITY_CONFUSION = false`

Background services (`SosNativeCallVerifier`, P2P engine) must use the **same** gate: if session revoked / identity cleared, stop signing.

---

## 7. Admin typed policy

- Port AC9 `AdminSigningPolicy` semantics into Kotlin (`SosNativeAdminPolicy`) **or** evaluate policy in JS and only send **already-narrowed** drafts — preferred: **native re-validation** of op + baseEvent verify + capability tip to prevent XSS forging envelopes.  
- `NATIVE_GENERIC_ADMIN_SIGN = false`  
- `NATIVE_ADMIN_POLICY_BYPASS = false`  
- No `signGroupControlEvent` / broad membership sign.

---

## 8. Community model

- One device identity; Communities are network tags / control state only.  
- Typed requests may include `groupId` for admin/invite/membership ops; never select a different K.  
- `NATIVE_IDENTITY_COMMUNITY_INDEPENDENT = true`  
- `PER_COMMUNITY_NATIVE_SIGNER = false`

---

## 9. Calls interface boundary

**Preserve:** kind 1059 giftwrap, receiver auth, no unauthenticated ring, existing `SosNativeCallVerifier` / pending wrap pipeline / R2 UI.

**Change (F6 phase):** replace `SosSessionStore.getPrivkey()` inside verifier with `SosSecureIdentityStore.withIdentityKey` + typed `SIGN_CALL_*` / unwrap helpers. Do **not** redesign `IncomingCallActivity` / `SosSecureCallSessionStore`.

**WebView:** call UI continues to request typed seal/giftwrap; never `getVerifierSessionJson` with K.

---

## 10. P2P interface boundary

- Signaling / offer / file-key wrap → typed native crypto.  
- `SosNativeFileTransfer` chunk AES-GCM stays on **file content keys** (already established).  
- `NATIVE_SIGNER_IN_FILE_CHUNK_HOT_PATH = false`  
- `P2P_BULK_DATA_PATH_UNCHANGED = true`

---

## 11. Performance / offline / scale

- Per-device Keystore crypto; no central signer host for normal ops.  
- Distinguish **local crypto** (offline OK) vs **relay publish** (network).  
- 100k users ⇒ 100k devices signing locally — no new SPOF.

---

## 12. WebView bridge hardening

| Rule | Spec |
|------|------|
| Allowlist | Typed ops only |
| Schema | Strict JSON; reject extra secret keys |
| Session | generation + account required |
| Request IDs | Replay cache |
| Size bounds | Enforce |
| Responses | No K/nsec |
| Logging | No secrets (`SosDebugLog` scrub) |
| Remove | `getVerifierSessionJson` privkey; `setUserPrivkey` after cutover |
| `JS_BRIDGE_GENERIC_CRYPTO_RPC` | false |
| `JS_BRIDGE_RAW_K_RESPONSE` | false |
| `JS_BRIDGE_NSEC_RESPONSE` | false |

---

## 13. XSS boundary & trusted native UI

`F6_CLAIMS_XSS_ELIMINATED = false`

Same-origin WebView XSS in an **active valid session** can still invoke allowed typed ops unless confirmation is required.

### Confirmation matrix

| Operation class | Classification |
|-----------------|----------------|
| Routine chat / presence / read receipt / call seal | `NO_CONFIRM_REQUIRED` |
| File-key wrap / P2P signal | `NO_CONFIRM_REQUIRED` |
| Profile / feed / reaction | `NO_CONFIRM_REQUIRED` |
| Invite create/revoke | `POLICY_DEPENDENT` |
| Membership block/remove | `NATIVE_CONFIRM_REQUIRED` |
| Group control / capability / bootstrap | `NATIVE_CONFIRM_REQUIRED` |
| Identity seal import / clear / switch | `NATIVE_CONFIRM_REQUIRED` |
| Future export / recovery reveal | `NATIVE_CONFIRM_REQUIRED` (+ biometric) |

**UI options:** `BiometricPrompt` / device credential for identity & admin; `DialogFragment` for confirm copy; avoid confirm-every-message.

---

## 14. Migration / import / export dependencies

### Dependency graph

```
F7 session authority ──────────────┐
AC9 admin policy ──────────────────┼──► F6A store → F6B signer → F6C bridge → F6D session bind
F1/F5A typed shapes (reference) ───┘         │
                                             ├──► F6E admin
                                             ├──► F6F nip44/p2p typed
                                             ├──► F6G trusted UI
F5B5 trusted export ──► future export UI only (F6G+)
F5B6 Model B sealed migration ──► optional import path (blocked until Model B)
```

- **`F6_DEPENDS_ENTIRELY_ON_F5B6 = false`**
- **Available pre-F5B6:** F6A–F6G (store, typed signer, bridge, session, admin, nip44, trusted UI), plaintext→Keystore same-K migration, QR/file native import designs  
- **Blocked by F5B6:** sealed Worker→signer→Android authenticated migration blob  
- **Blocked by F5B5:** production trusted export UX (design hooks only)

### Import (design only)

- Trusted paths: native QR, native file picker, future F5B6 sealed handoff, explicit recovery.  
- `WEBVIEW_PLAINTEXT_K_IMPORT_TARGET = false` (no paste-into-page as end state).

### Export

- `NATIVE_SILENT_PRIVATE_KEY_EXPORT = false`  
- Future export requires trusted UI + F5B5 semantics.

---

## 15. Recovery state machine

```
OK --Keystore invalid / decrypt fail / pair fail--> RECOVERY_REQUIRED
OK --backup restore without Keystore--> RECOVERY_REQUIRED (blob present, unwrap impossible)
OK --web P ≠ native P--> MISMATCH (no auto-fix)
RECOVERY_REQUIRED --user supplies same K via trusted import--> verify P --> OK
RECOVERY_REQUIRED --user aborts--> stay RECOVERY_REQUIRED / logout clear
MISMATCH --user confirms which identity (trusted UI)--> clear other --> OK
```

Never: generate on error; never revive foreign backup K into Web silently.

---

## 16. Backup / device migration

**Current risk:** `android:allowBackup="true"` + plaintext prefs ⇒ identity may backup.

**Design (implement in F6A/F6J, not this doc commit):**

- `android:allowBackup="false"` **or** `dataExtractionRules` / `fullBackupContent` excluding:
  - `sos_native_session` (especially priv)
  - `sos_native_identity_secure_v1`
  - any Keystore-aliased material (Keystore itself is device-bound)
- Document: restore to new device without Keystore ⇒ `RECOVERY_REQUIRED`, not fake OK.

**This design phase:** document only; tiny manifest fix deferred to F6A owner-review (unsafe today, but changing backup is a product/security decision with restore UX impact).

---

## 17. Threat model

| Threat | Rating |
|--------|--------|
| Malicious WebView script (active session) | PARTIALLY_PROTECTED (typed allowlist); REQUIRES_TRUSTED_UI for admin/identity |
| Same-origin XSS | PARTIALLY_PROTECTED; F6_CLAIMS_XSS_ELIMINATED=false |
| Stale / revoked WebView | PROTECTED (session gate) |
| Malformed bridge request | PROTECTED |
| Replayed bridge request | PROTECTED (requestId) |
| ADB/debug builds | PARTIALLY_PROTECTED / OUT_OF_SCOPE for release hardening |
| Rooted device | OUT_OF_SCOPE (no absolute guarantee) |
| Keystore compromise | OUT_OF_SCOPE / PARTIALLY_PROTECTED |
| Stolen unlocked device | PARTIALLY_PROTECTED; REQUIRES_TRUSTED_UI / biometric for high-risk |
| Stolen locked device | PROTECTED relative to plaintext prefs today |
| App backup restore | PARTIALLY_PROTECTED until backup exclusion shipped |
| Account switch confusion | PROTECTED (generation + account bind) |
| Multi-WebView stale | PROTECTED via F7 + native gate |
| Malicious Community content | PROTECTED (identity independent; policy on admin ops) |

---

## 18. Test plan

### Node / structural

- `qa/native-typed-signer-f6-gate.mjs` — static contracts: no priv in bridge responses; allowlist; session bind symbols; backup rules; chunk path unchanged.

### Android instrumentation / unit

| Test | Covers |
|------|--------|
| `SosSecureIdentityStoreTest` | seal/read/corrupt/recovery; no plaintext prefs K |
| `SosNativeTypedSignerTest` | typed sign; reject generic; kind allowlist |
| `SosNativeSessionRevocationTest` | stale generation denied |
| `SosNativeIdentityReconciliationTest` | WEB_ONLY→seal same K; MISMATCH fail closed |
| `SosNativeBridgePolicyTest` | malformed/replay/secret fields/size |
| `SosNativeAdminPolicyTest` | AC9 mapping; no broad admin |
| `SosNativeCallTypedCryptoTest` | giftwrap without exposing K to JS |
| `SosNativeP2pHotPathTest` | signer not in chunk loop |
| `SosNativeBackupExclusionTest` | prefs excluded / restore ⇒ RECOVERY |

### Adversarial

- Bridge XSS driving typed admin without confirm → denied when confirm required  
- `getVerifierSessionJson` absent / empty of K  
- Prototype pollution / unexpected origin N/A (native)  
- Account A session after switch to B  
- Offline crypto still works; publish separate  

---

## 19. Implementation phases

| Phase | Name | Files (primary) | Invariant | Tests | Depends | Owner gate | Rollback |
|-------|------|-----------------|-----------|-------|---------|------------|----------|
| **F6A** | Native identity store | `SosSecureIdentityStore.kt`, migrate from `SosSessionStore` plaintext, backup rules | No plaintext K at rest; no silent gen | StoreTest | none | Review store AAD/alias | Keep dual-read until verified |
| **F6B** | Typed signer facade | `SosNativeTypedSigner.kt` wrapping `SosNostrCrypto` | No public privHex API to bridge | TypedSignerTest | F6A | Review OP allowlist | Feature flag OFF |
| **F6C** | JS bridge typed protocol | `SosJsBridge.kt` additions; remove K getters; `native-shell-bridge.js` later | No K in responses | BridgePolicyTest | F6B | Review bridge schema | Flag; legacy methods refuse |
| **F6D** | Session/revocation bind | `SosNativeSessionGate.kt` + F7 push | Revoked WV cannot sign | SessionRevocationTest | F6C + F7 | Review generation mirror | Gate fail-open **forbidden** — fail closed |
| **F6E** | Admin typed policy | `SosNativeAdminPolicy.kt` | No generic admin sign | AdminPolicyTest | F6D + AC9 | Review confirm matrix | Flag |
| **F6F** | NIP44 / P2P typed | Call verifier + P2P engine consumers | Chunk path unchanged | Call/P2p tests | F6D | Perf + hot-path review | Per-module flag |
| **F6G** | Trusted native UI | Activity/Dialog/Biometric | High-risk confirm | UI tests | F6E | UX review | Confirm bypass **forbidden** in prod |
| **F6H** | Migration/recovery | Import UI; F5B6 hook stubs | Same K/P only | ReconcileTest | F6A; F5B6 optional | Recovery review | |
| **F6I** | Adversarial QA | gates + instrumentation | Boundaries hold | f6-gate | F6G | Security review | |
| **F6J** | Dark rollout | flags, APK dark | No Package893 required for internal | smoke | F6I | Release owner | Disable flag |

**NEXT_IMPLEMENTABLE_F6_PHASE = F6A**  
**NEXT_IMPLEMENTABLE_F6_PHASE_BLOCKERS:** none technical beyond owner approval to start Kotlin work; does **not** require F5B5/F5B6/CF.

---

## 20. Explicit non-claims

- Does not eliminate XSS.  
- Does not complete F5B5/F5B6.  
- Does not authorize legacy delete.  
- Does not enable ACCESS_CONTROL_V2.  
- Does not require discarding R2 call/nav WIP.  
- Does not make rooted devices safe.

---

## 21. Handoff checklist for F6A implementer

1. Add `SosSecureIdentityStore` with Keystore AES-GCM + AAD `SOS|android-identity|v1`.  
2. Dual-read: if secure OK use it; else plaintext prefs → one-time seal same K/P → clear plaintext after verify.  
3. Corruption → `RECOVERY_REQUIRED`.  
4. Do not touch IncomingCallActivity / call session store logic.  
5. Do not implement bridge typed RPC yet (F6C).  
6. Add unit tests listed for F6A.  
7. Flag `SOS_NATIVE_SECURE_IDENTITY_V1` default OFF until verified.  
8. Document backup exclusion PR as part of F6A or immediate follow-up.

---

## 22. Document control

| Field | Value |
|-------|-------|
| Design file | `docs/security/F6_ANDROID_NATIVE_TYPED_SIGNER_DESIGN.md` |
| Kotlin runtime changed | false (this phase) |
| JS runtime changed | false (this phase) |
| F6_DESIGN_COMPLETE | true |
| F6_IMPLEMENTATION_READY | true (for F6A) |
