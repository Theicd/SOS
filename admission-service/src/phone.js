/**
 * Server-side phone normalization + phoneToken (HMAC via WebCrypto).
 * PHONE_TOKEN_CLIENT_COMPUTABLE=false — secret never leaves Worker.
 */
const enc = new TextEncoder();
const PHONE_TOKEN_VERSION = 1;
const PHONE_TOKEN_PREFIX = 'pt1';

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function pepperBytes(env) {
  // PRODUCTION_PHONE_PEPPER_REQUIRED=true — production must set PHONE_PEPPER explicitly (no default).
  const isProd = String(env.SOS_ENV || '').toLowerCase() === 'production';
  const primary = String(env.PHONE_PEPPER || '')
    .trim()
    .toLowerCase();
  const fallback = String(env.ADMIN_PIN_PEPPER || '')
    .trim()
    .toLowerCase();
  const h = primary || (!isProd ? fallback : '');
  if (isProd && !/^[0-9a-f]{64}$/.test(primary)) return null;
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function normalizePhoneE164(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, code: 'EMPTY' };
  if (/[a-zA-Z]/.test(raw)) return { ok: false, code: 'LETTERS' };
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return { ok: false, code: 'NO_DIGITS' };
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('972')) {
    // ok
  } else if (digits.length === 10 && digits.startsWith('0')) {
    digits = '972' + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith('5')) {
    digits = '972' + digits;
  } else if (!raw.startsWith('+')) {
    return { ok: false, code: 'UNSUPPORTED_LOCAL' };
  }
  if (digits.length < 8 || digits.length > 15) return { ok: false, code: 'LENGTH' };
  if (!/^9725\d{8}$/.test(digits) && !/^972\d{8,9}$/.test(digits)) {
    return { ok: false, code: 'INVALID_IL' };
  }
  return { ok: true, e164: '+' + digits, digits };
}

/**
 * phoneToken = pt1 || hex(HMAC-SHA256(PHONE_PEPPER, "sos|phone|v1|" || e164))
 */
export async function computePhoneToken(env, e164OrInput) {
  const n = normalizePhoneE164(e164OrInput);
  if (!n.ok) return { ok: false, code: n.code };
  const pepper = pepperBytes(env);
  if (!pepper) return { ok: false, code: 'PHONE_PEPPER_MISSING' };
  const key = await crypto.subtle.importKey('raw', pepper, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode('sos|phone|v1|' + n.e164)));
  return {
    ok: true,
    e164: n.e164,
    digits: n.digits,
    phoneToken: PHONE_TOKEN_PREFIX + mac,
    version: PHONE_TOKEN_VERSION,
  };
}

export function phoneTokensEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length || !x.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(s) {
  const dig = await crypto.subtle.digest('SHA-256', enc.encode(String(s || '')));
  return hex(dig);
}

export const PHONE_TOKEN_SCHEME = 'HMAC-SHA256(PHONE_PEPPER, sos|phone|v1|+E164) → pt1||hex';
export const PHONE_PROOF_LEVEL = 'WHATSAPP_DELIVERY_BOUND_INVITE';
