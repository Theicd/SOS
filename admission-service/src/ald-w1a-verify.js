/**
 * MD3W-W1B Γאפ Admission-service copy of W1A approval artifact verification.
 * Used before durable one-time consumption. No Root K. No MD3 sign.
 */
import { verifyEvent } from 'nostr-tools';

export const ALD_APPROVAL_OPERATION = 'AUTHORIZE_LINKED_DEVICE_APPROVAL_V1';
export const PRODUCTION_ORIGIN = 'https://signer.sos010.com';
export const PRODUCTION_RP_ID = 'signer.sos010.com';
export const PAGES_DEV_ORIGIN = 'https://sos-signer.pages.dev';
export const DEV_ORIGINS = Object.freeze(['http://localhost:8787', 'http://127.0.0.1:8787']);
export const NORMAL_PROFILE_CAPS = Object.freeze([
  'DEVICE_CHAT',
  'DEVICE_CALLS',
  'DEVICE_P2P',
  'DEVICE_FILES',
  'DEVICE_RECEIPTS',
  'DEVICE_PRESENCE',
  'DEVICE_SETTINGS',
  'DEVICE_HISTORY_SYNC',
]);

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64urlDecode(s) {
  try {
    const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_e) {
    return null;
  }
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function buildCanonicalAldApprovalRequest(req) {
  return JSON.stringify({
    operation: ALD_APPROVAL_OPERATION,
    protocolVersion: 1,
    accountP: req.accountP,
    deviceId: req.deviceId,
    D_sign_pub: req.D_sign_pub,
    D_enc_pub: req.D_enc_pub,
    pairingTranscriptHash: req.pairingTranscriptHash,
    pairingId: req.pairingId,
    authorizationId: req.authorizationId,
    authEpoch: req.authEpoch,
    capabilities: [...(req.capabilities || [])].sort(),
    expiresAt: req.expiresAt,
    requestNonce: req.requestNonce || '',
  });
}

function parseClientDataJSON(clientDataJSON) {
  try {
    const j = JSON.parse(new TextDecoder().decode(clientDataJSON));
    return { ok: true, type: String(j.type || ''), challenge: String(j.challenge || ''), origin: String(j.origin || '') };
  } catch (_e) {
    return { ok: false, code: 'MALFORMED_CLIENT_DATA' };
  }
}

function parseAuthenticatorData(authData) {
  if (!authData || authData.length < 37) return { ok: false, code: 'MALFORMED_AUTH_DATA' };
  const flags = authData[32];
  return {
    ok: true,
    rpIdHashHex: bytesToHex(authData.slice(0, 32)),
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
  };
}

function derEcdsaSignatureToRaw(der) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  if (bytes.length < 8 || bytes[0] !== 0x30) return null;
  let offset = 2;
  if (bytes[1] & 0x80) offset = 2 + (bytes[1] & 0x7f);
  if (bytes[offset] !== 0x02) return null;
  const rLen = bytes[offset + 1];
  let r = bytes.slice(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (bytes[offset] !== 0x02) return null;
  const sLen = bytes[offset + 1];
  let s = bytes.slice(offset + 2, offset + 2 + sLen);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  if (r.length > 32 || s.length > 32) return null;
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

function challengeBytesMatchClient(clientChallengeB64url, expectedChallengeBytes) {
  const got = b64urlDecode(clientChallengeB64url);
  if (!got || got.length !== expectedChallengeBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expectedChallengeBytes[i];
  return diff === 0;
}

export async function verifyAldApprovalArtifact(artifact, expectedRequest) {
  try {
    if (!artifact || artifact.operation !== ALD_APPROVAL_OPERATION) return { ok: false, code: 'BAD_OPERATION' };
    if (artifact.T1_FALLBACK_ENABLED === true) return { ok: false, code: 'T1_FALLBACK_FORBIDDEN' };
    if (artifact.ROOT_K_USED === true || artifact.NSEC_USED === true) return { ok: false, code: 'SECRET_FLAG' };
    if (Date.now() > Number(artifact.approvalExpiresAt || 0)) return { ok: false, code: 'APPROVAL_EXPIRED' };
    const req = artifact.canonicalRequest;
    if (!req) return { ok: false, code: 'NO_CANONICAL_REQUEST' };
    for (const c of req.capabilities || []) {
      if (c === 'DEVICE_ADMIN' || c === 'DEVICE_RECOVERY' || !NORMAL_PROFILE_CAPS.includes(c)) {
        return { ok: false, code: 'BAD_CAPABILITY' };
      }
    }
    const canonical = buildCanonicalAldApprovalRequest(req);
    if (artifact.intentCanonical && artifact.intentCanonical !== canonical) {
      return { ok: false, code: 'CANONICAL_MISMATCH' };
    }
    const requestHash = bytesToHex(await sha256(new TextEncoder().encode(canonical)));
    if (requestHash !== artifact.requestHash) return { ok: false, code: 'REQUEST_HASH_MISMATCH' };

    if (expectedRequest) {
      const fields = ['accountP', 'deviceId', 'D_sign_pub', 'D_enc_pub', 'pairingTranscriptHash', 'pairingId', 'authorizationId', 'authEpoch'];
      for (const f of fields) {
        const a = String(req[f] ?? '').toLowerCase();
        const b = String(expectedRequest[f] ?? '').toLowerCase();
        if (a !== b) return { ok: false, code: 'EXPECTED_FIELD_MISMATCH', field: f };
      }
    }

    const signerOrigin = String(artifact.signerOrigin || '');
    if (signerOrigin === PAGES_DEV_ORIGIN) return { ok: false, code: 'PAGES_DEV_FORBIDDEN' };
    if (signerOrigin !== PRODUCTION_ORIGIN && !DEV_ORIGINS.includes(signerOrigin)) {
      return { ok: false, code: 'SIGNER_ORIGIN_NOT_ALLOWED' };
    }
    const rpId = signerOrigin === PRODUCTION_ORIGIN ? PRODUCTION_RP_ID : 'localhost';
    const ass = artifact.assertion;
    if (!ass) return { ok: false, code: 'NO_ASSERTION' };
    const clientDataJSON = b64urlDecode(ass.clientDataJSON_b64url);
    const authenticatorData = b64urlDecode(ass.authenticatorData_b64url);
    const signature = b64urlDecode(ass.signature_b64url);
    const spki = b64urlDecode(artifact.publicKeySpkiB64url);
    if (!clientDataJSON || !authenticatorData || !signature || !spki) {
      return { ok: false, code: 'MALFORMED_ASSERTION_BUNDLE' };
    }
    const challenge = await sha256(new TextEncoder().encode(canonical));
    if (bytesToHex(challenge) !== artifact.challengeHex) return { ok: false, code: 'CHALLENGE_HEX_MISMATCH' };
    const client = parseClientDataJSON(clientDataJSON);
    if (!client.ok || client.type !== 'webauthn.get') return { ok: false, code: 'CLIENT_DATA' };
    if (client.origin !== signerOrigin) return { ok: false, code: 'ORIGIN_MISMATCH' };
    if (!challengeBytesMatchClient(client.challenge, challenge)) return { ok: false, code: 'CHALLENGE_MISMATCH' };
    const auth = parseAuthenticatorData(authenticatorData);
    if (!auth.ok || !auth.up) return { ok: false, code: 'UP_FLAG_MISSING' };
    if (!auth.uv) return { ok: false, code: 'UV_FLAG_MISSING' };
    const rpHash = bytesToHex(await sha256(new TextEncoder().encode(rpId)));
    if (auth.rpIdHashHex !== rpHash) return { ok: false, code: 'RP_ID_HASH_MISMATCH' };
    let key;
    try {
      key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch (_e) {
      return { ok: false, code: 'PUBLIC_KEY_IMPORT_FAIL' };
    }
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const signed = new Uint8Array(authenticatorData.length + clientHash.length);
    signed.set(authenticatorData, 0);
    signed.set(clientHash, authenticatorData.length);
    const sigRaw = derEcdsaSignatureToRaw(signature);
    if (!sigRaw) return { ok: false, code: 'SIGNATURE_FORMAT' };
    const okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, signed);
    if (!okSig) return { ok: false, code: 'SIGNATURE_INVALID' };
    return {
      ok: true,
      code: 'OK',
      accountP: req.accountP,
      requestHash,
      approvalId: artifact.approvalId,
      deviceId: req.deviceId,
      readyForWorkerMd3Sign: true,
    };
  } catch (_e) {
    return { ok: false, code: 'VERIFY_EXCEPTION' };
  }
}

/** Fresh account-bound auth for ALD consume (kind 22242). */
export function validateAldConsumeAuth(authEvent, expectedAccountP) {
  if (!authEvent || !verifyEvent(authEvent)) return { ok: false, code: 'BAD_AUTH' };
  const pk = String(authEvent.pubkey || '').toLowerCase();
  if (pk !== String(expectedAccountP || '').toLowerCase()) return { ok: false, code: 'AUTH_ACCOUNT_MISMATCH' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(authEvent.created_at || 0));
  if (age > 300) return { ok: false, code: 'AUTH_STALE' };
  if (Number(authEvent.kind) !== 22242) return { ok: false, code: 'BAD_AUTH_KIND' };
  let body;
  try {
    body = JSON.parse(authEvent.content || '{}');
  } catch (_e) {
    return { ok: false, code: 'BAD_AUTH_CONTENT' };
  }
  if (String(body.purpose || '') !== 'ALD_APPROVAL_CONSUME') return { ok: false, code: 'BAD_AUTH_PURPOSE' };
  return { ok: true, pubkey: pk };
}
