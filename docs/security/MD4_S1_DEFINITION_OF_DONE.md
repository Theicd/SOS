# MD4 S1 — Definition of Done

**Depends on:** `MD4_HISTORY_SYNC_S0.md`  
**Runtime history transfer:** not in S1 (ConversationKeyIndex export/import = S2+)

## Must ship in S1

1. Durable browser device key store (`D_sign` / `D_enc`) with WebCrypto-backed wrap; no plaintext priv in localStorage.  
2. Persist full signed DeviceAuthorization bound to `(accountP, deviceId)`.  
3. Strict Schnorr + `verifyStrict` parity with Android before any future sync entrypoint.  
4. Account-switch isolation; restart recovery of keys+auth; unsupported browser fail-closed.  
5. `RECOVERY_CAPABLE=false` for browser-linked devices.  
6. Negative tests for wrong account/device, missing signature, expired auth, capability absence.  
7. MD1–MD3 gate regressions PASS on the implementation worktree.  

## Explicitly not S1

- ConversationKeyIndex seal/export  
- History batches  
- `sos-hist-v1` session runtime  
- MD5 live sync  

## Approval gate

S1 code starts only after explicit owner approval separate from S0.
