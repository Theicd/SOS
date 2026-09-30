import './shim.js';
import '../../nostr-event-integrity.js';
import '../../group-control-state.js';
import '../../invite-policy.js';
import '../../admin-2fa-protocol.js';

const App = globalThis.NostrApp;
let configuredRoot = '';

/** Root is fixed per deployment (env.ROOT_PUBKEY); group-control-state snapshots it on first use. */
export function configure(env) {
  const root = String(env.ROOT_PUBKEY || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(root)) throw Object.assign(new Error('ROOT_PUBKEY not configured'), { code: 'NOT_CONFIGURED' });
  if (configuredRoot && configuredRoot !== root) throw Object.assign(new Error('ROOT_PUBKEY changed'), { code: 'NOT_CONFIGURED' });
  const group = String(env.FIRST_GROUP_ID || 'israel-network');
  App.NETWORK_TAG = group;
  App.adminSourceKeys = [root];
  configuredRoot = root;
  return { root, group };
}

export const GCS = () => App.GroupControlState;
export const Policy = () => App.InvitePolicy;
export const Admin2fa = () => App.Admin2faProtocol;
export const strictVerify = (ev) => App.strictVerifyNostrEvent(ev) === true;
