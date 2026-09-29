import { finalizeEvent, getPublicKey } from 'nostr-tools';

/**
 * Admin co-sign key (env.ADMIN_COSIGN_SK, Cloudflare secret) and PIN pepper (env.ADMIN_PIN_PEPPER, secret).
 * The co-sign key signs exactly one thing: kind 39004 attestations for control events that passed an admin PIN
 * session check. It must differ from the admission key. Neither value is ever returned or logged.
 */
export const ATTESTATION_KIND = 39004;
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

/** Signs only a 39004 attestation that names one control event id. */
export function signAttestation(env, draft) {
  if (!draft || draft.kind !== ATTESTATION_KIND) throw Object.assign(new Error('bad kind'), { code: 'SIGN_REFUSED' });
  const e = (draft.tags || []).filter((t) => Array.isArray(t) && t[0] === 'e');
  let body = null;
  try {
    body = JSON.parse(draft.content);
  } catch (_e) {}
  if (e.length !== 1 || !body || body.schema !== 'sos-admin-cosign' || body.eventId !== e[0][1]) {
    throw Object.assign(new Error('bad attestation'), { code: 'SIGN_REFUSED' });
  }
  return finalizeEvent(draft, load(env).sk);
}
