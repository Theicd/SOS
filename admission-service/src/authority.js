import { serviceAdmin2fa } from './shim.js';
import '../../nostr-event-integrity.js';
import '../../group-control-state.js';
import '../../invite-policy.js';
import '../../moderation-policy.js';
import '../../membership-state.js';
import '../../admin-2fa-protocol.js';

const App = globalThis.NostrApp;
let configuredRoot = '';

/**
 * Every control reload re-verifies the whole stored chain and its attestations. A strict verify is a pure function
 * of the signed fields, so positive results are remembered keyed by exactly those fields (any change is a new key).
 */
const VERIFY_MEMO_MAX = 20000;
const verifiedMemo = new Set();
const strictVerifyUncached = App.strictVerifyNostrEvent;
App.strictVerifyNostrEvent = function strictVerifyMemo(event) {
  let key;
  try {
    key = JSON.stringify([event.id, event.pubkey, event.created_at, event.kind, event.tags, event.content, event.sig]);
  } catch (_e) {
    return false;
  }
  if (verifiedMemo.has(key)) return true;
  const ok = strictVerifyUncached(event) === true;
  if (ok) {
    if (verifiedMemo.size >= VERIFY_MEMO_MAX) verifiedMemo.clear();
    verifiedMemo.add(key);
  }
  return ok;
};

/** Root is fixed per deployment (env.ROOT_PUBKEY); group-control-state snapshots it on first use. */
export function configure(env) {
  const root = String(env.ROOT_PUBKEY || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(root)) throw Object.assign(new Error('ROOT_PUBKEY not configured'), { code: 'NOT_CONFIGURED' });
  if (configuredRoot && configuredRoot !== root) throw Object.assign(new Error('ROOT_PUBKEY changed'), { code: 'NOT_CONFIGURED' });
  const group = String(env.FIRST_GROUP_ID || 'israel-network');
  const signer = String(env.ADMIN_2FA_SIGNER_PUBKEY || '').trim().toLowerCase();
  if (signer && !/^[0-9a-f]{64}$/.test(signer)) throw Object.assign(new Error('ADMIN_2FA_SIGNER_PUBKEY invalid'), { code: 'NOT_CONFIGURED' });
  if (serviceAdmin2fa.signer && serviceAdmin2fa.signer !== signer) {
    throw Object.assign(new Error('ADMIN_2FA_SIGNER_PUBKEY changed'), { code: 'NOT_CONFIGURED' });
  }
  App.NETWORK_TAG = group;
  App.adminSourceKeys = [root];
  configuredRoot = root;
  serviceAdmin2fa.signer = signer;
  return { root, group, admin2faSigner: signer };
}

/**
 * Runs a synchronous canonical validator for an event the co-sign service is about to attest. Every check runs
 * except the validator's own "attestation present" step, which this service is the issuer of. Synchronous only,
 * so no other request can observe the flag.
 */
export function validateBeforeAttestation(fn) {
  serviceAdmin2fa.issuing = true;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('validateBeforeAttestation requires a synchronous validator');
    return r;
  } finally {
    serviceAdmin2fa.issuing = false;
  }
}

export const RELAY_CONTROL_KINDS = Object.freeze({ control: 39001, attestation: 39004 });

/** Canonical relays the service reads the published control chain from (deployment env only). */
export function controlRelays(env) {
  return String(env.CONTROL_RELAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((u) => /^wss?:\/\/[^\s]+$/i.test(u))
    .slice(0, 8);
}

export const GCS = () => App.GroupControlState;
export const Policy = () => App.InvitePolicy;
export const Admin2fa = () => App.Admin2faProtocol;
export const Moderation = () => App.ModerationPolicy;
export const Membership = () => App.MembershipState;
export const strictVerify = (ev) => App.strictVerifyNostrEvent(ev) === true;
