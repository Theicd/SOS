# M1 — Media / File E2EE Architecture + Gap Audit

**Package:** M1 MEDIA / FILE E2EE ARCHITECTURE + GAP AUDIT  
**Mode:** Audit + design + QA spec only  
**Date:** 2026-09-16  
**Base main:** `75098a5579cc97748533925b0ea82a2bfda82243`  
**Branch:** `feat/media-file-e2ee-m1-audit`

## Status

- **Production:** UNCHANGED by this document.
- **Runtime code:** UNCHANGED by this package.
- **E3B:** ACTIVE (`e2eeSendRequired=true`, secure epoch 1, self-echo/history fixed).
- **Blossom file bytes:** NOT E2EE (`BLOSSOM_FILE_BYTES_ENCRYPTED=false`).
- **M2 implementation:** NOT started. Do not implement from this doc without a separate package.

---

## 0. Security baseline (production)

| Item | State |
|---|---|
| Repository | Theicd/SOS |
| Production | https://sos010.com/ |
| E3B private chat text | NIP-44 E2EE ACTIVE |
| `e2eeSendRequired` | `true` |
| Secure epoch | 1 / READY |
| Self-authored Relay echo/history | FIXED |
| Receive | DUAL_READ |
| Push Privacy | ACTIVE |
| APK | 1.0.113 / 114 (unchanged by M1) |
| Known limitation | Blossom-hosted file bytes are plaintext |

---

## 1. Objective

Design the next secure-media architecture so private-chat:

- voice messages
- images
- videos
- documents/files

can be end-to-end encrypted.

This document is a **factual map before implementation**. Attachment paths are **not** assumed identical.

---

## 2. Existing transport distinctions

### A. Small inline attachments

Chat messages may carry:

```json
{ "t": "text", "a": { /* attachment */ } }
```

or the E3B equivalent inner payload (`text` + `attachment`).

When actual media bytes are embedded as `dataUrl` inside the encrypted kind-1050 inner payload, those bytes **are protected by E3B** — **if** NIP-44 encryption succeeds (see §4 size cliff).

Do **not** re-encrypt unnecessarily once a safe encrypted-blob path exists for oversized media.

### B. Blossom

Large media/files can be uploaded to Blossom.

| Aspect | Current state |
|---|---|
| Hosted file bytes | **NOT E2EE** (plaintext upload) |
| Attachment metadata on Relay | May be inside E3B inner payload (URL, name, mime, size, magnet, etc.) |
| Content-Type on upload | Original media MIME (`blob.type`) |
| Auth hash | SHA-256 of **plaintext** bytes (NIP-24242 `x` tag) |

**Current answer (proven from code):** Blossom server **can read private media bytes**.

### C. WebRTC / DataChannel

Direct P2P chat/media uses WebRTC **DTLS**.

File-transfer code additionally uses **AES-GCM per chunk** (`chat-p2p-file.js`).

Do **not** redesign working P2P hop protection unnecessarily — but **do** fix Relay-side key exposure (kind 30078).

### D. WebTorrent

Audit conclusions:

- Magnet creation / infoHash / trackers: present
- Piece transport: **plaintext** original file seeded
- No file-encryption layer in `webtorrent-transfer.js`
- Voice path may seed a plaintext torrent **in parallel** with inline/Blossom attachment

### E. File offer / kind 30078

- `file-offer` carries `keyStr`, name, size, MIME, caption, chunk count
- Signaling via kind **30078**
- `SIGNAL_ENCRYPTION_ENABLED = (window.NostrP2P_SIGNAL_ENCRYPTION === true)`
- Flag is **never assigned** in-repo → effectively **OFF**
- Historical plaintext-fallback concern: **confirmed current default is plaintext signaling**

---

## 3. Media send flow map (by type)

### Voice

1. `MediaRecorder` → blob (`chat-voice-service.js`)
2. `finalizeVoiceToChat` → `buildAttachmentFromBlob`
3. Size decision:
   - `≤ MAX_INLINE_BYTES` (256 KiB) → inline `dataUrl`
   - else → `uploadToBlossom` (plaintext bytes)
   - Blossom fail → re-inline if `≤ MAX_INLINE_BYTES * 1.2` (~307 KiB)
4. **Parallel:** `seedVoiceForP2P` seeds original blob to WebTorrent (plaintext pieces)
5. Attachment set on peer → `publishChatMessage` → E3B encrypts descriptor (+ dataUrl if inline)
6. Push: generic only (`hasAttachment` flag, no content)
7. Receiver: dual-read decrypt → render / download / local cache
8. Delete: kind-5 for chat event; **Blossom blob not deleted**

### Image / video / generic file

1. User selects file → `handleFileSelection` (`chat-file-transfer-ui.js`)
2. Hard reject if `> MAX_P2P_SIZE_BYTES` (100 MiB)
3. Chat video compression: **deliberate no-op** (`maybeCompressVideoForChat`)
4. Routing:
   - Prefer P2P if `size > 90 KiB` **or** DC already connected → `sendP2PFile`
   - Else if `size > 256 KiB` → WebTorrent
   - Else ≤ 256 KiB → inline dataUrl → publish
5. Inside P2P fail cascade (`chat-p2p-file.js`):
   - Media MIME → Blossom plaintext upload
   - Unsupported MIME → WebTorrent plaintext seed
6. Posters/thumbnails: **local only** (not Blossom-uploaded)
7. EXIF: **no stripping** on chat path

### Key code references

| Area | File / symbol |
|---|---|
| Inline serialize | `chat-file-transfer-service.js` — `serializeAttachment`, `MAX_INLINE_SIZE` |
| UI routing | `chat-file-transfer-ui.js` — `handleFileSelection` |
| Voice | `chat-voice-service.js` — `buildAttachmentFromBlob`, `seedVoiceForP2P`, `finalizeVoiceToChat` |
| E3B publish | `chat-service.js` — `publishChatMessage` → `encryptPrivateChatPayload` |
| E2EE core | `chat-e2ee.js` — `encryptPrivateChatPayload`, `MAX_E2EE_CIPHERTEXT_CHARS` |
| Blossom | `blossom.js` — `uploadToBlossom`, `sha256Hex`, `createAuthEvent` |
| P2P file AES | `chat-p2p-file.js` — `encryptChunk`, `generateFileKey`, `file-offer` |
| 30078 signaling | `p2p-video-sharing.js` — `SIGNAL_ENCRYPTION_ENABLED`, `prepareSignalContent` |
| WebTorrent | `webtorrent-transfer.js` |
| Push | `push-trigger.js` — `sanitizePrivateChatPushPayload` |
| Local media cache | `media-cache.js` |

---

## 4. Exact size thresholds

| Constant | Value | Location |
|---|---|---|
| `MAX_INLINE_SIZE` | **256 KiB** | `chat-file-transfer-service.js` |
| `MAX_INLINE_SIZE_BYTES` | **256 KiB** | `chat-file-transfer-ui.js` |
| `P2P_PREFERRED_FROM_BYTES` | **90 KiB** | `chat-file-transfer-ui.js` |
| `MAX_P2P_SIZE_BYTES` | **100 MiB** | `chat-file-transfer-ui.js` |
| Voice `MAX_INLINE_BYTES` | **256 KiB** | `chat-voice-service.js` |
| Voice Blossom-fail re-inline | **~307 KiB** (`× 1.2`) | `chat-voice-service.js` |
| Voice `MAX_SECONDS` | **60** | `chat-voice-service.js` |
| P2P `CHUNK_SIZE` | **64 KiB** | `chat-p2p-file.js` |
| Video-share DC chunk | **16 KiB** | `p2p-video-sharing.js` |
| `MAX_ATTACH_DATAURL_CHARS` | **400 KiB chars** | `chat-service.js` |
| `MAX_ATTACH_FILE_SIZE` | **50 GiB claim** | `chat-service.js` |
| `MAX_E2EE_CIPHERTEXT_CHARS` | **87472** | `chat-e2ee.js` |
| `MAX_CLAIMED_FILE_SIZE` (DC) | **2 GiB** | `chat-p2p-file.js` |

### Named blocker: INLINE / NIP-44 size cliff

| Gate | Value |
|---|---|
| Application inline gate | **256 KiB** raw |
| NIP-44 v2 practical plaintext ceiling | **~65535 bytes** |
| Practical safe raw inline under E3B | **approximately ~48 KiB** |

**Functional/security blocker:** common attachments between **~48 KiB and 256 KiB** may currently hit:

```text
e2ee-encrypt-failed
```

because the full serialized `{t,a}` (including base64 `dataUrl`) is passed into `encryptPrivateChatPayload` with **no send-side size pre-check**. Receive-side only guards oversized ciphertext (`OVERSIZED_CIPHERTEXT`).

**M2 MUST** include a send-side routing decision **before** serialization/encryption so oversized attachments never unpredictably fail at NIP-44 (see §16).

---

## 5. Current transport matrix

| MEDIA TYPE | TRANSPORT | FILE BYTES E2EE? | METADATA E2EE? | TLS/DTLS | KEY MATERIAL LOCATION | SERVER CAN READ BYTES? | RELAY CAN READ CONTENT? | RISK |
|---|---|---|---|---|---|---|---|---|
| **TEXT** | Relay kind 1050 | YES (NIP-44) | YES | TLS to Relay | NIP-44 conversation key | N/A | No (outer envelope only) | LOW |
| **SMALL VOICE** (≤~48 KiB raw inline) | Relay 1050 | YES if encrypt succeeds | YES | TLS | — | No | No | MED (size cliff nearby) |
| **SMALL VOICE** (48–256 KiB “inline”) | Relay attempt | **FAIL SEND** under E3B | — | — | — | — | — | **CRITICAL functional** |
| **LARGE VOICE** | Blossom + 1050 (+ optional magnet) | **NO** (plaintext upload) | URL/name often in E3B | HTTPS | — | **YES** | No plaintext body | **CRITICAL** |
| **IMAGE** (small inline) | Relay | YES / FAIL by size | YES | TLS | — | No | No | CRITICAL size cliff |
| **IMAGE** (large) | P2P → Blossom fallback | Blossom **NO** | URL in E3B | HTTPS / DTLS | P2P: see P2P FILE | Blossom **YES** | keyStr risk on 30078 | **CRITICAL** |
| **VIDEO** | Same as image; no chat compress | Same | Same | Same | Same | Same | Same | **CRITICAL** |
| **GENERIC FILE** | P2P or WebTorrent | P2P: AES chunks; WT: **NO** | varies | DTLS / trackers | P2P `keyStr` | WT peers **YES** | 30078 plaintext risk | **CRITICAL** |
| **BLOSSOM** | HTTPS upload | **NO** | URL may be E3B | HTTPS | plaintext SHA-256 in auth | **YES** | No file body | **CRITICAL GAP** |
| **P2P FILE** | DC AES-GCM 64 KiB chunks | YES *if key secret* | offer metadata | DTLS | **`keyStr` also on kind 30078 plaintext** | No (unless key known) | **keyStr YES** | **CRITICAL key leak** |
| **WEBTORRENT** | Public trackers + pieces | **NO** | magnet may be in E3B | WSS trackers | none (no encryption) | Peers **YES** | infoHash / activity | **CRITICAL GAP** |
| **FILE-OFFER** | kind 30078 (+ DC) | N/A | **NO** (default) | TLS to Relay | `keyStr` in content | N/A | **YES** | **CRITICAL** |

---

## 6. Small inline media — E2EE proof

**YES — when encryption succeeds:**

1. `serializeAttachment` includes `dataUrl` / `url` / fields.
2. `publishChatMessage` lifts `packed.a` into `payload.attachment`.
3. `encryptPrivateChatPayload` JSON-stringifies canonical payload (including attachment) and NIP-44-encrypts.
4. Outer Relay content is `{family:'sos-e2ee', v:1, alg:'nip44', ct:...}` only.

**NO — not reliably for the full 256 KiB inline gate** because of the NIP-44 size cliff (§4).

**FILE_BYTES_E2EE=YES** only for the **successful small-inline E3B path**.

---

## 7. Blossom audit

| Topic | Finding |
|---|---|
| Upload | `blossom.js` → `uploadToBlossom(blob)` |
| Download | Client HTTP GET of returned URL (chat media renderer / browser) |
| Auth | NIP-24242 signed event; `x` = SHA-256(**plaintext**) |
| URL | Server returns URL; client stores in attachment |
| MIME | `Content-Type: blob.type \|\| application/octet-stream` |
| Filename | Not sent as multipart filename; stays client-side in descriptor |
| Cache | Local `media-cache.js` stores decrypted/fetched blobs unencrypted at rest |
| Delete | Auth verb `'delete'` exists; **no call site invokes Blossom delete** |

**Blossom sees plaintext bytes: YES (proven).**

---

## 8. Priority leaks (ordered)

1. **Blossom plaintext bytes** + plaintext SHA-256 bound to user pubkey  
2. **kind 30078 `keyStr` exposure** (signal encryption default OFF)  
3. **WebTorrent plaintext pieces**  
4. **Voice plaintext torrent seeding** (parallel even when chat path is E2EE/inline)  
5. **NIP-44 / 256 KiB inline size cliff** (`e2ee-encrypt-failed`)  
6. **EXIF / camera metadata** where plaintext Blossom/torrent path exists  
7. **Blossom delete not invoked** after chat message delete  

---

## 9. Already secure / acceptable paths (do not overstate)

| Path | Assessment |
|---|---|
| Relay private **text** under E3B | **SECURE** |
| Small-enough inline attachment inside NIP-44 | **SECURE when encryption succeeds** |
| Push Privacy | Generic title/body; no filename/caption/key/URL content |
| Poster / thumbnail | **Local-only** per current audit (not separately uploaded to Blossom) |
| P2P DataChannel hop | **DTLS** transport confidentiality (not a substitute for end-to-end key secrecy vs Relay) |
| Live voice/video **calls** | Separate; DTLS-SRTP; **unchanged / out of M1–M5 file scope** |

---

## 10. Target architecture (M2+)

Preferred Blossom file E2EE design (**design only**):

1. Generate random **per-file** AES-256 key on sender device (`crypto.subtle.generateKey`).
2. Encrypt raw file bytes locally with **AES-256-GCM** (Web Crypto; same family as `chat-p2p-file.js`).
3. Upload **only ciphertext** to Blossom.
4. Blossom URL points to ciphertext object.
5. Place decryption material **only** inside NIP-44 encrypted chat attachment descriptor.

### Target Blossom upload properties

| Property | Target |
|---|---|
| Body | Ciphertext only |
| Content-Type | `application/octet-stream` |
| Public hash / auth `x` | SHA-256 of **ciphertext** |
| Original MIME / filename / caption | Inside E3B encrypted descriptor |

### Key rule

The per-file symmetric key MUST NEVER appear in:

- Blossom URL
- Nostr outer `content`
- Nostr outer tags
- Push
- Console logs
- Server logs
- Query parameters
- Plaintext kind 30078
- WebTorrent magnet URI
- Public metadata

Allowed only:

- trusted sender/recipient local runtime/storage
- E3B encrypted inner attachment descriptor

### Nonce rule

- Fresh cryptographically random 256-bit key per file
- Fresh unique 12-byte IV/nonce per encryption unit
- Never reuse AES-GCM nonce with the same key
- APIs: `crypto.getRandomValues`, `crypto.subtle.encrypt/decrypt` with `{ name: 'AES-GCM', iv }`

### Integrity / fail-closed

Receiver must reject on:

- ciphertext modification
- wrong key / nonce
- truncated file
- hash mismatch
- bad attachment descriptor

**No plaintext fallback** after an attachment is marked encrypted.

### Hash strategy

| Use | Recommendation |
|---|---|
| Blossom addressing / auth | **Ciphertext** SHA-256 |
| Public correlation | Avoid publishing **plaintext** hash |
| Optional plaintext integrity | Only inside encrypted descriptor if required |

Tradeoff: plaintext hash enables known-file confirmation and cross-server correlation when signed with user identity (current Blossom behavior). Target removes that.

### AAD (recommended binding)

Bind authenticated encryption context to:

- `sos-file-v2`
- `messageId`
- `sender`
- `recipient`
- ciphertext hash
- attachment version

Exact canonical AAD encoding is **to be frozen in M2** (not frozen here).

---

## 11. Conceptual attachment v2 (NOT frozen)

```json
{
  "v": 2,
  "transport": "blossom",
  "enc": {
    "alg": "aes-256-gcm",
    "key": "<base64>",
    "nonce": "<base64>"
  },
  "resource": {
    "url": "https://...",
    "encryptedSize": 0,
    "sha256_ct": "<hex>"
  },
  "media": {
    "mime": "image/jpeg",
    "filename": "photo.jpg",
    "originalSize": 0
  },
  "aad": "..."
}
```

**Schema is conceptual only. Not frozen until M2 implementation review.**

---

## 12. Large-file strategy

- Whole-file AES-GCM may be acceptable for typical chat media sizes.
- Multi-hundred-MB / multi-GB files must **not** require unsafe full-RAM buffering in WebView.
- **M2 must decide:** whole-file vs chunked authenticated encryption.
- If chunked: **unique nonce per chunk**; never reuse key+nonce pair.
- Existing P2P pattern: 64 KiB chunks + 12-byte IV prepended — useful reference, not automatically the Blossom wire format.

Practical current product max for picker routing: **100 MiB** (`MAX_P2P_SIZE_BYTES`). DC claim ceiling: **2 GiB**.

---

## 13. Backward compatibility

Future receive must dual/compat-read:

1. Legacy plaintext attachments (`url` / `dataUrl` / magnet)
2. Current E3B inline attachment objects
3. Future encrypted v2 descriptors

Future secure **send** activation:

- **Fail closed**
- No plaintext fallback once encrypted-file send is required
- Do not rewrite old stored files / historical Blossom blobs

---

## 14. Download flow (future)

1. Receive encrypted kind 1050  
2. NIP-44 decrypt descriptor  
3. Validate schema  
4. Fetch ciphertext  
5. Enforce size limits  
6. Decrypt locally (AES-GCM + AAD)  
7. Authenticate tag  
8. Validate result  
9. Create local object URL  
10. Render  

No server-side decrypt. On any failure: secure attachment error — **never** treat ciphertext URL as plaintext media.

---

## 15. P2P / WebTorrent interaction (analysis)

Preferred if practical: **encrypt once**, transport ciphertext anywhere (Blossom / P2P / torrent), decrypt only at recipient.

Current blockers to that ideal:

- WebTorrent seeds plaintext today
- P2P AES exists but key is Relay-visible via 30078
- Voice always seeds plaintext torrent in parallel

M5 should harden these; do not force unsafe reuse of current plaintext seeds.

---

## 16. Important M2 requirement — send-side size gate

**M2 MUST include send-side routing protection for the NIP-44 size cliff.**

- Do **not** allow an attachment larger than safe inline E2EE capacity to reach NIP-44 encryption and fail unpredictably with `e2ee-encrypt-failed`.
- Routing decision must happen **before** serialization/encryption.
- Do **not** implement this in M1.

---

## 17. Implementation phases

| Phase | Scope |
|---|---|
| **M2** | Encrypted Blob Core + **mandatory send-side size gate** |
| **M3** | Blossom ciphertext upload/download + descriptor in E3B |
| **M4** | Voice / image / video / generic file routing integration |
| **M5** | P2P / kind 30078 / WebTorrent hardening |
| **M6** | Production activation flag + migration + QA |

Adjust phase boundaries only if a later audit proves a safer split. **Do not start M2 from this document alone without an explicit implementation package.**

---

## 18. QA plan (future implementation)

Required cases:

- small inline voice
- large voice
- image
- video
- document
- wrong key
- wrong nonce
- modified ciphertext
- truncated ciphertext
- oversized ciphertext
- bad schema
- legacy plaintext history
- new encrypted history
- reload / history reconstruction
- Blossom server inspection → ciphertext only
- Relay outer inspection → no key
- Push privacy → no private metadata
- log privacy → no key/plaintext
- P2P fallback
- WebTorrent fallback
- delete / re-download
- background notification remains generic

---

## 19. Threat model (target)

| Actor | Should read private media content? |
|---|---|
| Relay operator | **No** (metadata only: sender, `p` tag, kind, time, size/activity) |
| Blossom server | **Ciphertext only** |
| Push server | **Generic only** |
| WebTorrent peer | Ciphertext only **or** no transfer |
| Network ISP | Encrypted transport / ciphertext only |
| Malicious unrelated Nostr user | **No** |
| Recipient | **Yes** (intentional) |
| Sender local device | **Yes** |
| Compromised endpoint | Out of scope |
| Screenshots / recipient resharing | Out of scope |
| Device-at-rest encryption | Out of scope for M1 |

Relay still observes social graph / timing — **do not claim anonymity**.

---

## 20. Calls (out of scope)

Do **not** confuse:

- recorded **voice message** attachments
- live **voice call** / **video call**

Live WebRTC calls use DTLS-SRTP transport protection and are **separate**.  
**Do not modify calls** in Media/File E2EE packages M1–M5 unless a separate audit says otherwise.

---

## 21. Native Android (impact only)

- APK remains unchanged in M1.
- Native RelayWatcher: JSON content → generic notification preview (no decrypt).
- Native DC file path mirrors JS AES-GCM and **inherits** kind-30078 key exposure if offers arrive via Relay.
- No M1 changes to watcher, file picker, background service, or Android bridge.

---

## 22. Push privacy

Media Push must remain generic.

Push must never include future:

- file key / nonce
- ciphertext URL (if avoidable)
- filename / caption / mime
- thumbnail / voice duration

Current sanitizer already drops content fields for chat type — preserve.

---

## 23. Delete / retention

Even if Blossom deletion fails after client-side encryption is deployed: ciphertext without the key remains computationally unreadable — a major benefit of client-side file encryption.

Today: deleting a chat message does **not** unlink Blossom plaintext blobs.

---

## 24. Local cache (document only)

- IndexedDB `SOS2MediaCache` stores media blobs unencrypted at rest
- P2P transfer state may persist `keyStr` locally
- Service Worker cache is app shell, not chat media store
- Device-at-rest encryption is **not** redesigned in M1

---

## 25. Crypto inventory (reuse preference)

| Mechanism | Location / use |
|---|---|
| Web Crypto AES-GCM | `chat-p2p-file.js` chunk encrypt/decrypt |
| nostr-tools NIP-44 | `chat-e2ee.js` private chat |
| SHA-256 | `blossom.js` upload auth |
| WebRTC DTLS | DataChannel / calls |

Prefer native Web Crypto / existing vetted code. No new dependency unless M2 proves necessity.

---

## 26. Known limitations (honest)

- E3B does **not** currently protect Blossom/WebTorrent bytes.
- P2P AES is undermined by Relay `keyStr` exposure.
- Inline 256 KiB gate conflicts with NIP-44 capacity under active E3B.
- Voice may publish plaintext torrent pieces alongside an otherwise E2EE chat message.
- No EXIF stripping on chat media.
- No Blossom delete on chat delete.
- This document does **not** authorize production encrypted-file rollout.

---

## 27. Next

```text
READY_FOR_M2_ENCRYPTED_BLOB_CORE
```

**STOP.**

- DO NOT IMPLEMENT M2 in this package.
- DO NOT MERGE this branch to main as a runtime change (docs-only branch is fine to open PR later by owner).
- DO NOT DEPLOY.
- DO NOT MODIFY BLOSSOM / NATIVE / E3B FLAGS from M1.
