# MD1 — Windows / Desktop Device Storage Contract

**Status:** CONTRACT ONLY — no Windows/desktop runtime exists in this repository yet.  
**Gate:** MD1  
**Scheme:** `sos-device-keys-v1`

## Platform audit (MD1)

| Capability | Result |
|------------|--------|
| `WINDOWS_RUNTIME_PRESENT` | **false** (no `desktop/` / Electron / Tauri / WinUI app in repo) |
| `WINDOWS_DEVICE_STORAGE_IMPLEMENTED` | **false** |
| `WINDOWS_DEVICE_STORAGE_CONTRACT_DEFINED` | **true** (this document) |
| `WINDOWS_NATIVE_NONEXPORTABLE_SECP256K1` | **NOT_PRESENT** (no runtime to claim CNG secp256k1) |
| `WINDOWS_NATIVE_NONEXPORTABLE_X25519` | **NOT_PRESENT** |

Wire algorithms remain:

- `D_sign` = secp256k1 (software generate)
- `D_enc` = X25519 (software generate)

Do **not** claim CNG/TPM holds these wire keys non-exportably unless a future desktop runtime proves it. Default desktop architecture mirrors Android:

**software device keys → platform-bound wrap (DPAPI / CNG AES / TPM-sealed AES) → app-private path under `%LOCALAPPDATA%\SOS\device\`**

## Required path layout (future)

```
%LOCALAPPDATA%\SOS\device\
  identity-v1\
    meta.json          # public metadata only
    sign.wrap          # AES-GCM ciphertext + iv (no plaintext)
    enc.wrap
```

- Cloud backup / OneDrive roaming of this folder: **forbidden** (`WINDOWS_CLOUD_BACKUP_PRIVATE_KEYS_ALLOWED=false`)
- Plaintext private key files: **forbidden**
- `storageClass`: `PLATFORM_WRAPPED` when DPAPI/CNG/TPM wrap is used; `SOFTWARE_ONLY` otherwise → `recoveryEligible=false`
- Soft/browser-only: `BROWSER_ONLY_RECOVERY_CAPABLE_ALLOWED=false`

## Public metadata schema (shared with Android)

```json
{
  "version": "sos-device-keys-v1",
  "formatVersion": 1,
  "deviceId": "<64 hex>",
  "DSignPub": "<64 hex x-only>",
  "DEncPub": "<64 hex x25519 u>",
  "createdAt": 0,
  "storageClass": "PLATFORM_WRAPPED|SOFTWARE_ONLY|HARDWARE_NONEXPORTABLE|UNSUPPORTED",
  "hardwareBacked": false,
  "recoveryEligible": false,
  "dSignPublicEncoding": "secp256k1-xonly-hex-v1",
  "dEncPublicEncoding": "x25519-u-hex-v1"
}
```

## Wrap AAD (must match Android)

```
SOS|device-key|v1|{deviceId}|{sign|enc}|{pubFingerprint8}
```

`pubFingerprint8` = first 8 bytes of SHA-256(pub) as hex (16 hex chars).

## Typed API contract (future desktop)

- `createOrGet()` → public metadata
- `signDevicePayload(bytes)` → signature hex (no priv)
- `deviceEcdh(peerEncPubHex)` → shared secret hex (no priv)
- `getPublicMetadata()`
- `deleteLocalDeviceIdentity()` — local only; not remote revoke

Forbidden: `getDevicePrivateKey`, `exportDevicePrivateKey`, `getDevicePrivHex`.

## Copy-to-other-machine

When wrap is DPAPI/user-or-machine bound or TPM-sealed, copied blobs must fail unwrap (`COPIED_DEVICE_KEY_BLOB_USABLE_ON_OTHER_DEVICE=false` when binding works). Do not claim PASS until desktop runtime tests exist.
