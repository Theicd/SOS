import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { Admin2fa } from './authority.js';

/**
 * Admin co-sign key (env.ADMIN_COSIGN_SK, Cloudflare secret) and PIN pepper (env.ADMIN_PIN_PEPPER, secret).
 * The co-sign key signs exactly one thing: Admin 2FA attestations (admin-2fa-protocol.js format) for events that
 * passed an admin PIN session check. It must differ from the admission key. Neither value is ever returned or logged.
 */
const HEX64 = /^[0-9a-f]{64}$/i;
let cache = { raw: null, sk: null, pk: '' };

function hexToBytes(raw) {
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function load(env) {
  const raw = String(env.ADMIN_COSIGN_SK || '');
  if (cache.raw === raw && cache.sk) return cache;
  if (!HEX64.test(raw)) throw Object.assign(new Error('co-sign key not configured'), { code: 'NOT_CONFIGURED' });
  if (raw.toLowerCase() === String(env.ADMISSION_SK || '').toLowerCase()) {
    throw Object.assign(new Error('co-sign key must differ from admission key'), { code: 'NOT_CONFIGURED' });
  }
  const sk = hexToBytes(raw);
  cache = { raw, sk, pk: getPublicKey(sk) };
  return cache;
}

export function cosignPubkey(env) {
  return load(env).pk;
}

export function pepperBytes(env) {
  const raw = String(env.ADMIN_PIN_PEPPER || '');
  if (!HEX64.test(raw)) throw Object.assign(new Error('pepper not configured'), { code: 'NOT_CONFIGURED' });
  return hexToBytes(raw);
}

/** Signs only an attestation draft that names one event id in the canonical protocol shape. */
export function signAttestation(env, draft) {
  const P = Admin2fa();
  if (!draft || draft.kind !== P.ATTESTATION_KIND) throw Object.assign(new Error('bad kind'), { code: 'SIGN_REFUSED' });
  const e = (draft.tags || []).filter((t) => Array.isArray(t) && t[0] === 'e');
  let body = null;
  try {
    body = JSON.parse(draft.content);
  } catch (_e) {}
  if (
    e.length !== 1 ||
    !body ||
    body.schema !== P.ATTESTATION_SCHEMA ||
    body.protocol !== P.PROTOCOL ||
    body.eventId !== e[0][1] ||
    Object.keys(body).sort().join(',') !== P.CONTENT_KEYS.slice().sort().join(',')
  ) {
    throw Object.assign(new Error('bad attestation'), { code: 'SIGN_REFUSED' });
  }
  return finalizeEvent(draft, load(env).sk);
}
