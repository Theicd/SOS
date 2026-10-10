# MD4 — History Sync S0 Contract (Design Freeze)

**Status:** S0 CONTRACT ONLY — no runtime history transfer  
**Gate:** `MD4_HISTORY_SYNC_S0`  
**Baseline HEAD:** `d1bcc5168d9e02564c505d4b10c69a8d9b5f208a`  
**Protocol:** `sos-history-sync-v1`  
**Transport tag:** Nostr kind `25060`, `t=sos-hist-v1` (strict domain separation from `t=sos-pair-v1`)

---

## 0. Owner-approved decisions (locked for S0)

| # | Decision |
|---|----------|
| 1 | **ConversationKeyIndex sealed to desktop `D_enc`** is the primary history decryption grant |
| 2 | Optional **device-sealed history batches** may supplement missing/local-only history |
| 3 | **Never** export Root `K` / `nsec` to a linked desktop |
| 4 | Browser-linked devices remain **NORMAL_PROFILE**, not `RECOVERY_CAPABLE` |
| 5 | **No** automatic recovery-on-link |
| 6 | Preserve existing **MAX_LINKED** runtime limit until separately approved |
| 7 | Accept and document **long-term conversation key exposure** and limits of cryptographic revocation |
| 8 | Initial bounds: **256 KiB / 50 events / 2 concurrent batches / 15-minute** resumable execution (subject to measured validation) |
| 9 | Reuse kind **25060** with `t=sos-hist-v1` if no cross-protocol routing vulnerability |
| 10 | Preserve MD1–MD3 authorization and E2EE boundaries |

**MD0 alignment:** `HISTORY_KEY_TRANSFER_MODEL`, `ROOT_K_REQUIRED_FOR_HISTORY_DECRYPTION_ON_DESKTOP=false`, incremental/resumable/idempotent sync.

**Out of scope (MD5+):** continuous live synchronization, realtime cross-device deltas.  
**Stage 5 dual-primary:** Desktop may be authorized from Android APK **or** (future) Mobile Web Primary — same DeviceAuthorization + CKI/history/media model. Ordering and gaps: `docs/security/STAGE5_LINKED_DEVICES_ROADMAP.md`. Web-primary history exporter is **not** in S0–S5 scope; MD4W_W3 must report browser/local-only history that APK never held.

---

## 1. ConversationKeyIndex schema (`sos-cki-v1`)

Canonical JSON object (UTF-8), sealed to destination `D_enc` (X25519 sealed box / AEAD wrap — implementation chooses one primitive in S1, must be authenticated encryption).

```json
{
  "schema": "sos-cki-v1",
  "accountP": "<64 hex x-only P>",
  "deviceId": "<64 hex>",
  "authorizationId": "<64 hex>",
  "authEpoch": 1,
  "pairingTranscriptHash": "<64 hex>",
  "createdAt": 0,
  "exporter": "<32B hex>",
  "entries": [
    {
      "peerP": "<64 hex>",
      "conversationKey": "<hex or b64url — NIP-44 v2 conversation key material>",
      "alg": "nip44-v2",
      "keyId": "<stable id>",
      "derivedAt": 0
    }
  ],
  "attachmentHints": [
    {
      "eventId": "<64 hex>",
      "mediaKey": "<b64url AES-256-GCM key>",
      "url": "<blossom or cache ref>",
      "alg": "aes-256-gcm"
    }
  ],
  "coverageNote": "KEYS_ONLY"
}
```

### Bindings (mandatory)

- `accountP` MUST equal DeviceAuthorization.accountP  
- `deviceId`, `D_enc` recipient MUST equal authorized desktop device  
- `authorizationId` + `authEpoch` MUST match current durable auth  
- `pairingTranscriptHash` MUST match MD3-bound transcript  
- Phone MUST derive conversation keys from root `K` locally; desktop MUST open seal with `D_enc_priv` only  

### Forbidden

- Root `K` / `nsec` fields  
- Recovery capsule material  
- Cross-account entries  

---

## 2. DeviceAuthorization validation (import gate)

Before any MD4 session or import:

1. Parse `sos-device-authorization-v1` (or current MD3 wire version).  
2. Run **strict** validation equivalent to Android `SosDeviceAuthorization.verifyStrict`:  
   - version, hex widths, `expiresAt > createdAt`, not expired  
   - `authEpoch >= AUTH_EPOCH_INITIAL`  
   - capabilities include `DEVICE_HISTORY_SYNC`  
   - reject `DEVICE_ADMIN`  
   - bind `deviceId` / `D_sign_pub` / `D_enc_pub` to local durable device keys  
3. **Schnorr verify** `rootSignature` under `accountP` over canonical signing bytes (same byte layout as Android issuer).  
4. Soft checks (“signature string present”) are **insufficient**.

---

## 3. Durable browser storage contract (`sos-device-keys-v1` browser profile)

| Requirement | Rule |
|-------------|------|
| Persist `D_sign` / `D_enc` | Yes, after successful MD3 link |
| Persist full signed DeviceAuthorization | Yes (not summary-only) |
| Storage | IndexedDB account-scoped: `(accountP, deviceId)` |
| Protection | WebCrypto non-extractable wrap key when available; AES-GCM wrap of priv material; AAD `SOS\|device-key\|v1\|{deviceId}\|…` |
| Plaintext priv in localStorage | **Forbidden** |
| `RECOVERY_CAPABLE` | **false** on browser |
| Unsupported (no WebCrypto Subtle / no IDB) | **Fail-closed** — no history sync |
| Account switch | Isolated partitions; wipe on account clear |
| Restart | Reload + `verifyStrict` before sync |

---

## 4. Post-link session wire (`sos-history-sync-v1`)

### Transport

- Kind: `25060`  
- Tags: `t=sos-hist-v1`, `d=<sessionId>`, `role=phone|desktop`  
- **MUST NOT** accept or decrypt frames with `t=sos-pair-v1` on this session path (and vice versa)  
- Cross-protocol routing vulnerability check is a **release gate** for S1

### Session key

```
transcriptBind = H(protocolVersion || accountP || deviceId || authorizationId ||
                   authEpoch || pairingTranscriptHash || sessionNonce || D_sign_pub || D_enc_pub)
session_key = HKDF-SHA256(ECDH(eph_phone, eph_desktop) || transcriptBind,
                          salt=transcriptBind, info="SOS|hist|v1")
AEAD AAD = transcriptBind
```

Desktop proves `D_sign` possession (PoP) before phone exports index/batches.

### Message types

| Type | Direction | Purpose |
|------|-----------|---------|
| `SYNC_HELLO` | desktop→phone | sessionNonce, D pubs, auth id |
| `SYNC_AUTH_OK` | phone→desktop | verified bindings |
| `KEY_INDEX_SEALED` | phone→desktop | sealed ConversationKeyIndex |
| `HIST_MANIFEST` | phone→desktop | coverage + cursors |
| `HIST_BATCH` | phone→desktop | sealed batch payload |
| `HIST_TOMBSTONE` | phone→desktop | delete markers |
| `SYNC_ACK` | desktop→phone | cursor ack / batch id |
| `SYNC_DONE` | either | bootstrap complete |
| `SYNC_CANCEL` | either | user/system abort |

---

## 5. History coverage, pagination, resume

**Source authority (phone):** union of local `NostrChatDB` / `nostr_chat_<P>` and relay history the phone can decrypt under `K`.

**Manifest fields:**

- `coverage`: `{ localDb: bool, relayWindow: { since, until }, gaps: [...] }`  
- `cursor`: `(collection, createdAtMs, eventId)` lexicographic  
- Collections: `messages`, `tombstones`, `cki` (index pages)

**Resume:** durable last `SYNC_ACK` cursor; reconnect continues; idempotent apply on `eventId`.

**MISSING_HISTORY:** explicit report when gaps remain; UI must not claim 100% if gaps listed.

**MD4 end state:** `SYNC_DONE` after index accepted and bootstrap batches drained (or empty history). **Not** continuous MD5 sync.

---

## 6. Tombstones and attachments

- Tombstone **wins** over body (MD0).  
- Apply tombstones even if body batch missing.  
- Attachments: include AES descriptors in index/batches; fetch Blossom/P2P **ciphertext**; decrypt locally.  
- Optional hot-blob sealed batches under same session AEAD.  
- No plaintext media on the wire.

---

## 7. Batch limits and resource controls

| Limit | Initial value |
|-------|----------------|
| Max batch ciphertext | 256 KiB |
| Max events per batch | 50 |
| Max concurrent batches | 2 |
| Max bootstrap wall clock | 15 minutes (then resumable cancel) |
| Max CKI peers per page | implementation-defined ≤ 512 recommended |

Exceeding limits → reject batch, fail-closed or page; never silent truncate of security fields.

Cancel → `SYNC_CANCEL`, drop partial un-acked batches, keep last durable ACK. Retry from cursor.

---

## 8. Revocation limitations (accepted product risk)

- Raising `authEpoch` / revoking DeviceAuthorization **stops future authorized sync sessions**.  
- It does **not** cryptographically erase NIP-44 conversation keys already delivered in a ConversationKeyIndex.  
- Compromised linked desktop that received the index retains historical decrypt capability until OS wipe or future **conversation rekey** (post-MD4 / MD8 territory).  
- S1 MUST document this in user-facing linked-device copy (no false “revoke erases history on device”).

---

## 9. Threat model (summary)

| Threat | Control |
|--------|---------|
| Root K exfiltration via MD4 | Forbidden by schema + negative tests |
| Unauthorized device sync | verifyStrict + capability + PoP |
| Pairing/history cross-routing | Strict `t=` separation + reject wrong protocol |
| Tampered batch/index | AEAD + optional content hashes |
| Replay | sessionNonce + spent batch ids + cursor ACK |
| Cross-account import | accountP binding |
| DoS | batch/time limits |
| Plaintext downgrade | reject non-AEAD / non-sos-e2ee where E2EE required |

---

## 10. Security negative test matrix (executable in S1+)

1. Missing `DEVICE_HISTORY_SYNC`  
2. Wrong `accountP` / `deviceId` / `D_*`  
3. Expired auth / wrong `authEpoch`  
4. Transcript mismatch  
5. AEAD tamper  
6. Replay `KEY_INDEX_SEALED` / batches  
7. `t=sos-pair-v1` frame injected into hist session (must fail)  
8. Root K/nsec field present (must reject + scan FAIL)  
9. Plaintext history on wire  
10. Cross-account CKI entries  
11. Oversize batch  
12. Import without Schnorr verify  

---

## 11. MD4 S1 Definition of Done

S1 is **complete** when all are true:

1. Durable browser `D_sign`/`D_enc` + full DeviceAuthorization persist across restart.  
2. Web `verifyStrict` + Schnorr under `P` before any sync API.  
3. Account-switch isolation; unsupported browser fail-closed.  
4. No ConversationKeyIndex export/import runtime yet (that is S2+) — **unless** owner expands S1 (default: storage+verify only).  
5. Unit/gate evidence for storage+verify negatives.  
6. No root K in storage or logs.  
7. MD1–MD3 regressions still PASS on the MD4 development worktree.

> Note: Per Stage-5 authorization, **S1 runtime is not started in S0**. This section defines DoD for the next approval gate.

---

## 12. Document control

| Field | Value |
|-------|-------|
| `MD4_S0_CONTRACT_COMPLETE` | true |
| `RUNTIME_HISTORY_TRANSFER` | false |
| `COMMIT_REQUIRED` | false (docs may live in recon worktree until owner commits) |
