import { finalizeEvent, getPublicKey } from 'nostr-tools';

/**
 * The admission service key (env.ADMISSION_SK, Cloudflare secret) is used for exactly one thing: signing the
 * invite-bound GRANT_ACTIVE membership proof. It is never returned, logged, or used for any other kind.
 */
const PROOF_KIND = 39003;
let cache = { raw: null, sk: null, pk: '' };

function load(env) {
  const raw = String(env.ADMISSION_SK || '');
  if (cache.raw === raw && cache.sk) return cache;
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw Object.assign(new Error('service key not configured'), { code: 'NOT_CONFIGURED' });
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  cache = { raw, sk, pk: getPublicKey(sk) };
  return cache;
}

export function servicePubkey(env) {
  return load(env).pk;
}

/** Signs only kind 39003 GRANT_ACTIVE drafts that carry the admission binding. */
export function signAdmissionProof(env, draft) {
  if (!draft || draft.kind !== PROOF_KIND) throw Object.assign(new Error('bad proof kind'), { code: 'SIGN_REFUSED' });
  let body;
  try {
    body = JSON.parse(draft.content);
  } catch (_e) {
    body = null;
  }
  if (!body || body.transition !== 'GRANT_ACTIVE' || !body.admission || !body.inviteEventId) {
    throw Object.assign(new Error('bad proof body'), { code: 'SIGN_REFUSED' });
  }
  const { sk } = load(env);
  return finalizeEvent(draft, sk);
}
