import { serviceAdmin2fa } from './shim.js';
import '../../nostr-event-integrity.js';
import '../../group-control-state.js';
import '../../invite-policy.js';
import '../../moderation-policy.js';
import '../../membership-state.js';
import '../../admin-2fa-protocol.js';

const App = globalThis.NostrApp;
let configuredRoot = '';

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
