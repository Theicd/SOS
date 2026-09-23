/**
 * Dedicated Nostr strict-verify Worker.
 * Verify-only: no private keys, no signing, no decrypt, no signer host.
 * HYPER CORE TECH
 */
/* eslint-disable no-undef */
self.NOSTR_INTEGRITY_WORKER_MODE = true;
try {
  importScripts('./vendor/nostr.bundle.min.js');
} catch (e1) {
  try {
    importScripts('/vendor/nostr.bundle.min.js');
  } catch (e2) {
    self.postMessage({ type: 'error', ok: false, reason: 'NOSTR_TOOLS_LOAD_FAILED' });
  }
}
try {
  importScripts('./nostr-event-integrity.js');
} catch (e3) {
  try {
    importScripts('/nostr-event-integrity.js');
  } catch (e4) {
    self.postMessage({ type: 'error', ok: false, reason: 'INTEGRITY_LOAD_FAILED' });
  }
}
