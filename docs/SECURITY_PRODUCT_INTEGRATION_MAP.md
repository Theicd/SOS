# Security ↔ Product Integration Map

This document explains how Stage 5 identity/security layers connect to product
features (chat, social, groups, multi-device). It is an integration map, not a
deployment authorization.

**Change control (current):** no main push, no CDN/production deploy, no APK
publish, no canary, `ACCESS_CONTROL_V2` remains **OFF**, MD4 not started.

---

## Layer stack

```
ROOT ACCOUNT IDENTITY (P/K)
    ↓
WEB WORKER VAULT  /  ANDROID SECURE STORE
    ↓
TYPED SIGNER + TYPED CRYPTO (kind/capability allowlists)
    ↓
SESSION AUTHORITY (native session binding / web vault session)
    ↓
CHAT / P2P / CALLS  (sealed signals, DataChannel, relay fallback)
    ↓
SOCIAL POSTS / LIKES / COMMENTS / FOLLOWS / SHARES
    ↓
GROUP / COMMUNITY ACCESS CONTROL (V2 gated; currently OFF)
    ↓
MULTI-DEVICE AUTHORIZATION / PAIRING (MD1–MD3 local; QR UI not productized)
```

---

## What each layer owns

### Root account identity (P/K)
- Canonical Nostr public key **P** is the account identity.
- Private key material must not live on the web main origin (Worker Vault /
  Android secure store is authoritative).

### Worker Vault / Android secure store
- Holds keys and performs sign/encrypt RPCs.
- Protects against main-origin XSS reading raw K / nsec.

### Typed signer + typed crypto
- Capability-bound signing (chat, feed, follow, call seal/giftwrap, admin, …).
- Prevents “any-kind” signing from compromised page JS.

### Session authority
- Native: F6D session binding + F6G/G3 strong confirmation for high-risk ops.
- Web: vault readiness / authoritative worker backend.

### Chat / P2P / calls
- Product transport: E2EE chat (relay + P2P), files, voice notes, WebRTC calls.
- Call signaling uses typed call crypto; UI must load for buttons to appear.
- **Social feed script failures must not block chat** (separate modules), but
  shared boot pages (e.g. `videos.html`) can still share notification helpers.

### Social (posts / likes / comments / follows / shares)
- Kind 1 notes, kind 7 reactions, kind 6 reposts, follow kind 40010.
- Uses the **same root P** via typed feed/follow signing.
- Social features are **not** Access Control and do **not** replace membership.

### Group / community Access Control
- Governs **permissions** (who may post/moderate/manage), not key custody.
- Implemented locally as AC1–AC10 + C0 community scope.
- Runtime gate: `SOS_ACCESS_CONTROL_V2` (default **false**).
- When OFF: admin/member directory UI is **hidden**; legacy permissive paths may
  still apply for some actions.

### Multi-device / QR pairing
- MD1–MD3: device identity, pairing protocol, device authorization (**local**).
- MD2 pairing uses `SOSPAIR1:` payload — **device binding**, not community
  membership and not social follow.
- Group invites today are **URL/code + WhatsApp**, not QR.
- Linked-device QR **UI** is not productized yet (protocol-only).

---

## Program relationships (owner cheat-sheet)

| Track | Role |
|-------|------|
| **F5 / F6A–F6I** | Protect root/account identity + native typed path |
| **F6J** | Rollout / physical integration acceptance of the above |
| **Social feed** | Product engagement on the same identity P |
| **Access Control V2** | Community permission plane (flagged OFF until activation) |
| **MD1–MD3** | Device authorization foundation |
| **MD4+** | Cross-device history/sync product behavior (not started) |

---

## Why features can “disappear”

1. **Parse/bootstrap failures** (e.g. `feed.js` syntax) prevent registration of
   likes/comments/notification helpers even when chat still works.
2. **Feature flags** hide completed local UI (`SOS_ACCESS_CONTROL_V2`).
3. **Protocol-only work** (MD2 pairing) has no visible QR screens yet.
4. **Local ≠ deployed** — Stage5 worktrees can be ahead of production CDN/main.

---

## Recovery priorities (this audit)

1. Keep chat/P2P/file/voice identity baselines green.
2. Restore social execution (`feed.js` parse + publish paths).
3. Restore video-call **UI** bootstrap (core may already load).
4. Inventory groups/AC/QR without enabling V2.
5. Only then resume full call E2E / Android R2 / MD4.

---

## Stage status reconciliation (closure — do not downgrade closed local evidence)

| Milestone | Actual status | Evidence |
|-----------|---------------|----------|
| **F5B4** | `COMPLETE_LOCAL` / PASS | `qa/f5b4-main-integration-report.json` STATUS=PASS |
| **F5B5** | `COMPLETE_LOCAL` + production signer acceptance preserved | `qa/stage5-post-f5b5-dependency-reconciliation-report.json` status=PASS; WA6 closed; `DEPLOYED_SIGNER_COMMIT` recorded. Do **not** mark incomplete without new contrary evidence. |
| **F5B6** | `COMPLETE_LOCAL` / PASS | `qa/f5b6-sealed-migration-report.json` + gate rerun PASS |
| **F5** | `COMPLETE_LOCAL` (not IN_PROGRESS) | B4+B5+B6 local closed; production deploy/CDN remains change-controlled |
| **F6H** | PASS | sealed recovery orchestration gate |
| **F6J** | `BLOCKED` on Android R2 physical (web closure may proceed independently) | physical acceptance docs; R2 not started this phase |
| **MD1–MD3** | PASS local | device identity / pairing / authorization reports |
| **MD4** | NOT_STARTED | change control |
| **ACCESS_CONTROL_V2** | OFF / unchanged | default false |

**Integration recovery closure (web):** Hebrew UTF-8 product UI, social reload, notifications E2E, audio/video call E2E, call lifecycle/cleanup, and master security regression re-run completed locally without main push/deploy.

---

## Related reports

- `qa/ac10-adversarial-authorization-report.json`
- `qa/c0-scope-foundation-report.json`
- `qa/md0-linked-devices-architecture-report.json`
- `qa/md2-pairing-protocol-report.json`
- `qa/f6j-android-rollout-report.json`
- `qa/f5b4-main-integration-report.json`
- `qa/stage5-post-f5b5-dependency-reconciliation-report.json`
- `qa/f5b6-sealed-migration-report.json`
- `docs/security/MD0_LINKED_DEVICES_ARCHITECTURE.md`
- `docs/security/F6J_R2_PHYSICAL_DEVICE_ACCEPTANCE.md`
