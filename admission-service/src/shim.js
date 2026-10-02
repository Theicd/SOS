/**
 * Minimal browser-global shim so the canonical client authority modules (group-control-state.js,
 * invite-policy.js, nostr-event-integrity.js) run unchanged inside the Worker. The service reuses the exact
 * same control reconstruction and invite policy as clients; it does not reimplement authority rules.
 */
import * as NostrTools from 'nostr-tools';

const memory = new Map();
const localStorageShim = {
  getItem: (k) => (memory.has(String(k)) ? memory.get(String(k)) : null),
  setItem: (k, v) => {
    memory.set(String(k), String(v));
  },
  removeItem: (k) => {
    memory.delete(String(k));
  },
  clear: () => memory.clear(),
  key: (i) => Array.from(memory.keys())[i] || null,
  get length() {
    return memory.size;
  },
};

if (!globalThis.localStorage) globalThis.localStorage = localStorageShim;
globalThis.NostrTools = NostrTools;
globalThis.SOS_ACCESS_CONTROL_V2 = true;
const App = globalThis.NostrApp || (globalThis.NostrApp = {});
App.NETWORK_TAG = 'israel-network';
App.COMMUNITY_CONTEXT = 'yalacommunity';
App.adminSourceKeys = [];
App.guestMode = false;

/** Admin 2FA for the control chain comes only from deployment env (configure()); it can only go from off to on. */
export const serviceAdmin2fa = { signer: '', issuing: false };
App.FeatureFlags = {
  isAdmin2faEnforced: () => /^[0-9a-f]{64}$/.test(serviceAdmin2fa.signer) && serviceAdmin2fa.issuing !== true,
  admin2faSignerPubkey: () => serviceAdmin2fa.signer,
};
