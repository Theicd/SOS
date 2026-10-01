# F5B6-W — Web Worker Vault → Isolated Signer sealed handoff (design)

**Status:** `OWNER_APPROVED` (approve_all) — implemented; local gate `qa/f5b6w-recovery-e2e.mjs`.
**Scope:** Web only. Android / APK / MD4 untouched.
**Purpose:** Give Worker-Vault identities (F5A, `CREATE_BROWSER_IDENTITY`) a real recovery path through the
existing F5B5 trusted reveal on `https://signer.sos010.com`, without the main page ever holding K.

## 1. Why this is needed

| Fact (current production) | Source |
|---|---|
| Worker generates K and stores it AES-GCM wrapped (non-extractable key) in IDB `sos_identity_secure` on `sos010.com` | `sos-crypto-worker.js` `createBrowserIdentity` |
| Worker bans every export op; responses are scanned for K | `rejectBannedOps`, `assertNoKeyLeak` |
| F5B5 reveal (WebAuthn UV → 30 s canvas) reads only the signer vault `sos_signer_secure` | `SOS-signer/js/trusted-export-reveal.js` |
| Signer vault is filled only by F5B4 (user types nsec inside the signer) | `SOS-signer/js/signer-vault.js` `importTrustedIdentity` |
| Logout deletes `identity_blob` + `wrapping_key` → Worker identity destroyed | `key-storage.js` `clearPrivateKey` → `deleteBrowserSecrets` |

Result: `CRITICAL_RECOVERY_GAP=true`. The missing piece is exactly the MD0 §16 "sealed Worker→signer" step.

## 2. Protocol (reuses F5B6 primitives: `sos-sealed-migration-v1`, HKDF-SHA256, AES-256-GCM, TTL 120 s)

1. User clicks **"גיבוי לשחזור החשבון"** (normal page). Page opens `https://signer.sos010.com/handoff` (top-level
   window, `noopener` not used so a `postMessage` channel exists; origin-pinned both ways).
2. Signer page (top-level only, opener required, `returnOrigin` allowlisted; refuses if the signer vault already holds
   a different identity) generates an ephemeral ECDH P-256 key pair (private non-extractable) and sends
   `{type:'SOS_F5B6W_OFFER', sessionId, recipientPub, expectedPubkey, exp}` to the return origin only.
   WebAuthn UV is not required for the import itself; it gates the reveal in step 6 (enroll if none, existing WA1–WA3 code).
3. Page forwards the offer to the Worker as a new typed op `SEAL_IDENTITY_FOR_SIGNER` (no K in params).
4. Worker checks: identity present; `expectedPubkey === P`; TTL; handoff policy (§4). Then ECDH(worker-ephemeral,
   recipientPub) → HKDF(info=`SOS|f5b6w|v1|P|sessionId`) → AES-GCM(K) with AAD = header hash. Returns only the envelope
   (ciphertext). `assertNoKeyLeak` still applies.
5. Page relays the envelope to the signer window. Signer decrypts in memory, derives pub(K), requires `=== expectedPubkey`,
   imports via the existing `importTrustedIdentity(privHex, {expectedPubkey})`, zeroises, replies `F5B6W_ACK{pubkey}`.
6. Signer offers the existing F5B5 reveal (WebAuthn UV → 30 s canvas) with one owner-approved action (899i):
   "שמירת המפתח כקובץ" — a local download of `SOS-personal-key-<fp8>-<fp8>.txt` containing only the nsec line, available
   only while the reveal is active, no upload/share. There is no manual "I saved it" button.
   After the file is handed to the browser, the signer posts `SOS_F5B6W_KEY_EXPORTED{pubkey, sessionId}` (no secret).
7. Main page stores `PERSONAL_KEY_EXPORTED` (`sos_recovery_backup_v1:<P>` with `confirmed/keyFileExported`, pubkey-scoped,
   non-secret) → onboarding/logout state flips. Login accepts the key file (read locally into the existing login path).

Page never sees plaintext K: it only relays `recipientPub` and the ciphertext.

## 3. Honest residual risk (must be accepted by owner)

The Worker has **no trusted display or input**; every request reaches it through main-page JS. Therefore an
**active main-origin XSS at handoff time** can call `SEAL_IDENTITY_FOR_SIGNER` with its **own** `recipientPub` and decrypt K.
WebAuthn on the signer does not help the Worker: it cannot pin an authentic signer credential without a prior trusted anchor.
MD0's answer (strong confirm on a phone) does not exist on web-only accounts.

`MAIN_ORIGIN_XSS_AT_HANDOFF_CAN_EXFILTRATE_K=true` (window-limited, see §4).
`SIGNER_ORIGIN_XSS_CAN_EXFILTRATE_REVEALED_NSEC=true` (already accepted in F5B5-WA0).

Note: the wrapping key in `sos_identity_secure` is non-extractable but usable by any same-origin script, so active
main-origin XSS could already decrypt `identity_blob` before this change. The handoff therefore adds no new class of
main-origin exposure; it adds a bounded, Worker-counted path.

Before this change: `ACCOUNT_LOST_ON_LOGOUT=true`. This design trades a bounded export window for recoverability.

## 4. Mitigations (Worker-enforced, not page-enforced)

| Control | Rule |
|---|---|
| Lifetime cap | Worker persists seals in IDB metadata `f5b6w_handoff` (pubkey-scoped) **before** sealing and fails closed if the write is not read back. Max 3 seals per identity lifetime, then `HANDOFF_LIMIT_REACHED`. Remaining count via `GET_HANDOFF_STATUS`. |
| TTL | Offer `exp` ≤ 120 s (`HANDOFF_EXPIRED`); replayed `sessionId` refused (`HANDOFF_REPLAY`). |
| Binding | HKDF info binds P + sessionId; signer rejects pubkey mismatch; AAD binds header. |
| No page K | Params containing key-like fields still rejected (`WORKER_REJECTS_PAGE_K`); response scan unchanged. |
| Visible | Handoff result + timestamp shown in account status ("גיבוי נוצר ב…"); an unexpected "already done" is a compromise signal. |

## 5. Logout / onboarding (Phase A/B, independent of §3)

* Onboarding: remove textarea + fake "העתק"/"שמור כקובץ"; show "הזהות שלך נוצרה בהצלחה", public key, fingerprint,
  and the real action "קבלת המפתח ושמירה כקובץ" under "המפתח האישי שלך". Never claim saved before `SOS_F5B6W_KEY_EXPORTED`.
* Logout for a Worker identity with `recoveryBackupConfirmed=false`: blocked by a severe warning; primary
  "קבלת המפתח האישי"; destructive path requires typing a confirmation phrase.

## 6. Recovery on a clean browser

Existing path only: paste the revealed nsec into the login screen (`switchAccountFromRawKey`), which already imports
same-P into the Worker vault. Test: recovered `P` must equal the original; no new identity is created.
(A signer-first login that avoids the paste would need the reverse direction — out of scope.)

## 7. Implementation surface (after approval)

Main repo: `sos-crypto-worker.js` (+ typed op, handoff state), `sos-crypto-worker-vault.js` (rpc), new
`f5b6w-handoff-client.js`, `guest-auth.js` + `videos.html` (onboarding), `key-viewer.js` / `identity-lifecycle.js` (logout guard).
Signer repo: new `handoff.html` + `js/f5b6w-handoff.js`, `protocol.json` capability `workerHandoff`, `_headers`/`sw.js` route.
Gates: Playwright with CDP virtual WebAuthn authenticator, disposable identity, full E2E + adversarial (wrong pubkey,
replay, second seal, key-field injection, origin spoof), plus the existing regression list.
