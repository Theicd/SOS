# MD3W-W1 — STOP: BLOCKED_SECURITY

| Field | Value |
|-------|-------|
| STATUS | **BLOCKED_SECURITY** |
| Baseline HEAD | `d1bcc5168d9e02564c505d4b10c69a8d9b5f208a` |
| Authorized worktree | `C:\BRAIN\SOS-MD4-S0-RECON-20261009-155349` |
| Code implemented | **false** (stop before enabling Web PhoneIssuer) |
| Checkpoint | `C:\BRAIN\SOS-MD3W-W1-CHECKPOINT-20261010\STOP.json` |

---

## Why stopped

W1 mandates:

1. **T2 WebAuthn UV** as the preferred high-assurance path.  
2. **No silent T2→T1 downgrade.**  
3. T1 **must not** be an enabled production fallback without separate owner approval.  
4. If infrastructure cannot provide an **independently protected user-confirmation boundary**, **STOP** with `BLOCKED_SECURITY` / `DESIGN_GAP`.  
5. **No production Trusted Signer changes** without identifying out-of-scope dependencies first.

### Independently protected confirmation boundary

| Candidate | Independent of main-origin XSS? | Available in authorized worktree? |
|-----------|----------------------------------|-----------------------------------|
| Worker typed op + in-page confirm (T1) | **No** — page JS can forge approve + call Worker (same residual as F5B6-W §3) | Yes (`sos-crypto-worker.js`) |
| Isolated signer + WebAuthn UV (T2) | **Yes** — confirm + UV on `signer.sos010.com` | **No** — signer lives outside worktree |
| Android PhoneIssuer | Yes (native UI) | Unchanged; not Mobile Web Primary |

Therefore enabling Mobile Web DeviceAuthorization **inside this worktree alone** would either:

- ship **T1 as the only path** (forbidden as production fallback / silent T2 downgrade), or  
- claim T2 without implementing signer-origin UV (false assurance).

**Correct stop:** `BLOCKED_SECURITY`.

---

## Exact out-of-scope dependency

| Item | Path / URL |
|------|------------|
| Isolated Trusted Signer repo | `C:\BRAIN\SOS-signer` |
| Production origin | `https://signer.sos010.com` |
| Existing WebAuthn stack | `SOS-signer/js/webauthn-*.js`, `trusted-export-intent.js`, `trusted-export-ui.js` |
| Existing vault | `SOS-signer/js/signer-vault.js` (`importTrustedIdentity`, F5B5 reveal) |
| F5B6-W handoff (K into signer) | Already in main repo client + signer `handoff` — but **no** `AUTHORIZE_LINKED_DEVICE` page/op |
| In authorized worktree? | **`in-worktree-signer=no`** |

Stop-gate trigger: *“If the required Trusted Signer component resides outside the authorized local development scope, STOP and identify the exact dependency before modifying it.”*

---

## What W1 still needs (after separate approval)

### A. Signer repo (T2 — required for production Web Primary)

1. New typed ceremony page (e.g. `/authorize-linked-device`) on signer origin.  
2. Bind WebAuthn UV to **one** authorize challenge (mirror `trusted-export-intent.js` pattern; `GENERIC_SENSITIVE_OPERATION_AUTHORIZER=false`).  
3. After UV: sign `SHA256(canonical-line-v1)` under vault K; return **signed DeviceAuthorization JSON only**.  
4. Never reveal nsec / never generic `sign(bytes)`.  
5. Origin allowlist + session binding for opener (`sos010.com`).  
6. Local QA deploy of signer Pages — **not** production — only with explicit owner approval.

### B. Main worktree (after T2 available)

1. Web PhoneIssuer adapter: MD2 BoundDestination → open signer ceremony → AEAD deliver.  
2. Keep `WEB_MD3_ISSUANCE` false until T2 gates PASS.  
3. Optional T1 Worker op: **QA-only / owner-gated**, never silent production fallback.  
4. Negatives W0-N01…N21 + Android MD3 regression.

### C. Explicitly not done in this stop

- No `AUTHORIZE_LINKED_DEVICE` in Worker `OP_SPECS`  
- No `WEB_MD3_ISSUANCE=true`  
- No W2 camera / W3 history / MD5  
- No SOS-signer modifications  
- No Root K exposure paths  

---

## W0 findings re-verified (current source)

- `sos-web-linked-devices.js`: `WEB_MD3_ISSUANCE=false`, path `REQUIRES_SOS_ANDROID_APP` without native bridge.  
- `sos-crypto-worker.js`: typed `SIGN_*` + `SEAL_IDENTITY_FOR_SIGNER`; no `AUTHORIZE_LINKED_DEVICE`.  
- Android `SosDeviceAuthorizationCeremony.OP = AUTHORIZE_LINKED_DEVICE` remains sole live issuer.  
- Desktop `verifyStrict` / MD2 stack reusable once a T2 signature exists.

---

## Owner decisions to unblock W1

1. Authorize **cross-repo** work in `C:\BRAIN\SOS-signer` (non-production first).  
2. Confirm **T2 mandatory** for production Web Primary (recommended: yes).  
3. If T1 QA scaffolding is desired in main repo: separate explicit approval; production flag stays off.  
4. Confirm accounts without signer vault (no F5B4/F5B6-W) are **unsupported** until handoff, or define onboarding prerequisite.

---

## Report fields

```
STATUS=BLOCKED_SECURITY
TRUSTED_SIGNING_AUTHORITY=Android PhoneIssuer (live); Worker Vault (typed SIGN_* only); Signer vault (reveal/handoff only)
AUTHORIZE_LINKED_DEVICE_TYPED_OP=NOT_IMPLEMENTED
T2_WEB_AUTHN_UV=BLOCKED_OUT_OF_SCOPE_SIGNER
T1_FALLBACK_STATUS=NOT_ENABLED (must not ship as production)
ROOT_K_ISOLATION=PRESERVED (no new paths)
WEB_PHONEISSUER=ABSENT
READY_FOR_MD3W_W2_APPROVAL=false
S7A2_HARDWARE_STATUS=NOT_VERIFIED
S6_REMAINING_RELEASE_GAPS=28
CODE_CHANGED=false
COMMIT_CREATED=false
```
