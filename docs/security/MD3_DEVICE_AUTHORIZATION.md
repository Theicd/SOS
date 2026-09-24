# MD3 — Device Authorization + Capability Foundation

**Status:** IMPLEMENTED (local)  
**Version:** `sos-device-authorization-v1`  
**Depends:** MD1 device identity, MD2 `sos-pair-v1` BoundDestination  
**Non-goals:** history sync (MD4+), Recovery Capsule (MD6), revocation (MD8), Nostr delegation (MD9), F5B6 sealed migration

---

## Root signing path

```
DEVICE_AUTH_ROOT_SIGNING_PATH =
  SosSecureIdentityStore (native custody)
  → SosDeviceAuthorizationCeremony.PhoneIssuer.signAfterConfirm
  → SosDeviceAuthorization.signUnderRoot (domain SOS_DEVICE_AUTHORIZATION_V1)
  → Schnorr under account P
```

- **No** generic `sign(bytes)` / `getPrivkey` / `getNsec` API  
- Typed operation name: `AUTHORIZE_LINKED_DEVICE`  
- Confirmation gate binds exact semantic payload hash (capabilities, D pubs, deviceId, transcript, authId)  
- Session must be logged-in + account match

---

## Schema

| Field | Binding |
|-------|---------|
| version | `sos-device-authorization-v1` |
| authorizationId | 256-bit CSPRNG |
| accountP | root account |
| deviceId | MD1 id from MD2 QR |
| D_sign_pub / D_enc_pub | MD2 transcript-bound |
| capabilities | explicit enum set |
| authEpoch | account-scoped; initial `1` |
| createdAt / expiresAt | default lifetime **365 days** |
| pairingTranscriptHash | MD2 transcript hex |
| pairingId | single-use consumption |
| storageSecurityClass | MD1 class at auth time |
| recoveryEligibleAtAuthorization | bound decision |
| rootSignature | Schnorr over SHA256(canonical-line-v1) |

**Encoding:** `canonical-line-v1+sha256+schnorr` — deterministic newline fields under domain `SOS_DEVICE_AUTHORIZATION_V1`.

---

## Capabilities

Normal profile: CHAT, CALLS, P2P, FILES, RECEIPTS, PRESENCE, SETTINGS, HISTORY_SYNC  

`DEVICE_RECOVERY`: only if MD1 `recoveryEligible` + storage not SOFTWARE_ONLY/UNSUPPORTED + explicit user confirmation (owner default checkbox may be on).  

`DEVICE_ADMIN`: reserved — **never granted** in MD3.

---

## Atomic commit

```
PENDING_CONFIRM → SIGNED_LOCAL → DELIVERED_PENDING_ACK → LINKED_AUTHORIZED
```

ACTIVE registry entry only after: root verify + destination verify + phone `putActive` + ACK.  
Cancel / delivery failure ⇒ no ACTIVE.  
`HALF_LINKED_STATE_ACCEPTED=false`

---

## Registry

Account-scoped; stores public metadata + full signed JSON.  
Signed object is authority; mismatch fail-closed.  
`MAX_LINKED_DEVICES=4` enforced on ACTIVE non-expired.  
Same deviceId+keys reauth replaces slot.  
Logout: registry retained; logged-out session cannot issue.

---

## F5B6 primitive

After MD3 success:

- Authenticated `D_enc` from MD2  
- Root-signed authorization binding `P → (deviceId, D_sign, D_enc)`  

`F5B6_MODEL_B_PRIMITIVE_COMPLETE=true` (design/crypto primitive).  
**Do not implement F5B6 sealed migration in MD3.**

---

## Explicit non-claims

- No root K / nsec transfer or wrap  
- No conversation key transfer  
- No Recovery Capsule  
- No full revocation (MD8)  
- No delegated Nostr / phone co-sign  
- No ACCESS_CONTROL_V2 / ADMIN grant  
