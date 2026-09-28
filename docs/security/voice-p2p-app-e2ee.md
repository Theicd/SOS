# Voice messages — application-level E2EE over P2P (Package 899)

## Model

```
MediaRecorder → plaintext WebM Blob (sender memory only)
  → existing sos-media-e2ee v2 (AES-256-GCM, per-file key, AAD = protocol/messageId/sender/recipient/attachmentId/mode/chunk)
  → ONE ciphertext
      ├─ Blossom: opaque wire wrap of the same ciphertext  (descriptor.resource)
      └─ WebTorrent: raw ciphertext, torrent name "data.bin", application/octet-stream  (descriptor.p2p v1)
  → descriptor (incl. file key) travels only inside the E2EE chat message (NIP-44 / E3B)
recipient: P2P ciphertext (or Blossom fallback) → size + SHA-256 vs descriptor.cipher → local decrypt → Blob/ObjectURL → play
```

No new cryptographic primitive. Encryption/decryption reuse `App.encryptMediaBlob` / `App.decryptMediaBlob`
(via `prepareEncryptedMediaForBlossom`, `uploadPreparedEncryptedMediaToBlossom`, `downloadEncryptedMediaFromBlossom`).

## Formats seen by the receiver

| Format | How recognised | Read path |
|---|---|---|
| LEGACY_VOICE | plaintext `audio/*` attachment (`url` / `dataUrl` / top-level `magnetURI`) | unchanged (read-only compatibility) |
| SERVER_E2EE_VOICE | `type: encrypted-media`, `v: 2`, no `p2p` | encrypted Blossom → decrypt |
| P2P_APP_E2EE_VOICE | `type: encrypted-media`, `v: 2`, `p2p: {v:1, transport:'webtorrent', content:'sos-media-e2ee-v2-ciphertext', magnetURI}` | P2P ciphertext first; Blossom E2EE starts after 4 s (no peer) or after +3 s grace (peer connected); first verified copy wins, the other is aborted |

Inbound validation (`inspectIncomingChatAttachment`) rejects a `p2p` block with any other shape, version, content or
a non-magnet URI (`VOICE_P2P_BAD_METADATA`). A `p2p` descriptor never uses the legacy plaintext-torrent player path.
Small voices that fit the E2EE message are still sent inline inside the encrypted chat message (no P2P, no Blossom).

## Fail-closed

Encryption failure, missing parties, missing key, corrupt ciphertext, hash/size mismatch, invalid version, wrong
recipient, tampered metadata and decrypt failure never produce playable plaintext. A P2P integrity failure is logged
with its code and the verified Blossom copy of the same ciphertext is used; if that also fails the player shows
`VOICE_DECRYPT_FAILED` (fail-closed). New voice never falls back to plaintext Blossom, plaintext inline dataUrl or a
plaintext torrent, regardless of the server-E2EE policy flag (`requireEncryption: true`).

## Key handling

The file key exists only in `descriptor.enc.key`, inside the E2EE chat message. It is not in the magnet URI, torrent
name/metadata, seeded bytes, Blossom URL/headers/body, relay tags or logs (checked by the VM and real-browser gates).

## Cache / plaintext lifetime

- Sender: recorder chunks are released after the Blob is built; `_prepared` (ciphertext) is dropped after seeding;
  WebTorrent holds ciphertext only.
- Receiver, P2P source: plaintext exists as an in-memory Blob + one ObjectURL per message (reused on replay, revoked
  when re-resolved). It is not written to the local media cache.
- Receiver, Blossom source: the decrypted voice may be kept in the pre-existing local media cache, but only under a key
  bound to the full descriptor (SHA-256 over attachmentId, cipher sha256, file key, messageId, sender, recipient).
  A descriptor with any altered field never hits that entry, so a tampered or re-targeted message is decrypted again
  and fails closed. The same binding is used for in-flight de-duplication.
- No zeroization guarantee is claimed for JS/Blob memory.

## Metadata limitations (not hidden by application E2EE)

- Sender and recipient pubkeys and event timestamps on relays (the chat event itself).
- Ciphertext size ≈ plaintext size + 16 bytes per chunk; duration is inside the encrypted descriptor, but size leaks
  approximate length.
- WebTorrent: trackers and peers see the infoHash, torrent size, and the IP addresses of both parties; WebRTC ICE
  exposes IPs to the peer (and to STUN servers).
- Blossom: the server sees upload/download source IPs, timing, the wire hash and size.
- Relays and servers see timing of sends/receives.
- Call media remains DTLS/SRTP; call signaling remains kind 1059. Not changed by this work.
