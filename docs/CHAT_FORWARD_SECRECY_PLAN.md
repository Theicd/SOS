# Chat Forward Secrecy Plan (audit — no ratchet implemented)

**Status:** Plan only. Owner must approve before any ratchet implementation.  
**Current property:** `CHAT_FORWARD_SECRECY=NO`, `POST_COMPROMISE_SECURITY=NO`.

---

## 1. Current static-key architecture

- Private chat content uses **NIP-44** (and related sealed paths) derived from the long-term account key material (**P/K** via Worker Vault).
- Conversation keys are effectively **static** for the life of the account identity (no Double Ratchet / per-message ephemeral chain).
- Private attachments: **AES-GCM** file keys uploaded as ciphertext to Blossom; file keys travel in E2EE chat metadata — still bound to the same long-term identity decrypt capability.

## 2. Historical ciphertext compromise model

If an attacker:

1. records relay ciphertext (and Blossom ciphertext) over time, **and later**
2. steals the user’s long-term root/account secret **K**,

then historical private messages and attachment keys that were encrypted to that identity are **DECRYPTABLE**.

There is **no** post-compromise healing: stealing K today decrypts yesterday’s traffic.

## 3. Signal-style ratchet option (not implemented)

A Double Ratchet (or MLS) would:

- Derive ephemeral chain keys per message / epoch.
- Limit blast radius of a single session key compromise.
- Provide forward secrecy and (with ratchet advance) post-compromise security.

## 4. Nostr compatibility implications

- Classic Nostr DMs (NIP-04/NIP-44) are **identity-static**.
- A ratchet would require either:
  - custom event kinds + session state machines, or
  - a parallel transport (P2P DataChannel first, relay as fallback with ratcheted envelopes).
- Interop with unmodified Nostr clients would **break** unless a dual-path adapter remains.

## 5. Multi-device implications

- MD1–MD3 authorize devices; **MD4+ sync is NOT started**.
- Any ratchet must sync **session/epoch state** across linked devices or accept decrypt failures on offline devices.
- Sealed migration (F5B6/F6H) moves **root identity**, not chat ratchet bags — a future design must decide whether history re-keys or stays decryptable only on devices that held prior epochs.

## 6. Migration path (sketch)

1. Keep current NIP-44 path as **compat**.
2. Introduce optional `sos-chat-ratchet-v1` capability flag between peers.
3. Negotiate ratchet only when both sides advertise support.
4. Fall back to static NIP-44 for legacy peers.
5. Never put ratchet secrets in QR / Blossom plaintext / console.

## 7. Backward compatibility

- Default remain static until both peers upgrade.
- Historical events stay decryptable with K (honest about lack of FS).
- UI must not claim “Signal-level FS” until ratchet is live and audited.

## 8. Performance / storage / recovery tradeoffs

| Topic | Static (today) | Ratchet (future) |
|-------|----------------|------------------|
| CPU | Low | Higher (per-msg DH/HKDF) |
| Storage | Message ciphertext + IDB | + ratchet state per peer |
| Recovery | Restore K → all history | May need epoch backup or accept gaps |
| Multi-device | Simpler | Harder (state sync) |

## 9. Decision required from owner

- **Do nothing** (document residual risk) — current default.
- **Plan-only** (this document) — done.
- **Implement ratchet** — requires explicit owner approval + multi-device design + Nostr compat policy.

`FORWARD_SECRECY_PLAN_GATE=PASS` when this document exists and accurately reflects current `NO`/`NO` properties.
