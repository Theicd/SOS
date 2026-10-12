/**
 * MD3W-W1B — Port of W1A verifyAldApprovalArtifact for main-repo Worker Vault.
 * Re-verifies WebAuthn UV + canonical request binding. No Root K. No MD3 sign.
 * Signer repo remains read-only; this is an independent verification copy.
 */
/* eslint-disable no-restricted-globals */
(function initSosAldW1aVerify(root) {
  'use strict';

  const ALD_APPROVAL_OPERATION = 'AUTHORIZE_LINKED_DEVICE_APPROVAL_V1';
  const PRODUCTION_ORIGIN = 'https://signer.sos010.com';
  const PRODUCTION_RP_ID = 'signer.sos010.com';
  const PAGES_DEV_ORIGIN = 'https://sos-signer.pages.dev';
  const DEV_ORIGINS = Object.freeze(['http://localhost:8787', 'http://127.0.0.1:8787']);
  const COSE_ES256 = -7;
  const NORMAL_PROFILE_CAPS = Object.freeze([
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

  function isAllowedEnrollmentOrigin(origin) {
    const o = String(origin || '');
    return o === PRODUCTION_ORIGIN || DEV_ORIGINS.indexOf(o) !== -1;
  }

  function isPagesDevOrigin(origin) {
    return String(origin || '') === PAGES_DEV_ORIGIN;
  }

  function buildCanonicalAldApprovalRequest(req) {
    const o = {
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
    };
    return JSON.stringify(o);
  }

  async function requestHashFromCanonical(canonical) {
    return bytesToHex(await sha256(new TextEncoder().encode(canonical)));
  }

  function parseClientDataJSON(clientDataJSON) {
    try {
      const bytes = clientDataJSON instanceof Uint8Array ? clientDataJSON : new Uint8Array(clientDataJSON);
      const j = JSON.parse(new TextDecoder().decode(bytes));
      return {
        ok: true,
        type: String(j.type || ''),
        challenge: String(j.challenge || ''),
        origin: String(j.origin || ''),
      };
    } catch (_e) {
      return { ok: false, code: 'MALFORMED_CLIENT_DATA' };
    }
  }

  function parseAuthenticatorData(authData) {
    const bytes = authData instanceof Uint8Array ? authData : new Uint8Array(authData);
    if (!bytes || bytes.length < 37) return { ok: false, code: 'MALFORMED_AUTH_DATA' };
    const flags = bytes[32];
    return {
      ok: true,
      rpIdHashHex: bytesToHex(bytes.slice(0, 32)),
      up: !!(flags & 0x01),
      uv: !!(flags & 0x04),
      flags,
      signCount: ((bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36]) >>> 0,
    };
  }

  async function expectedRpIdHashHex(rpId) {
    return bytesToHex(await sha256(new TextEncoder().encode(String(rpId || ''))));
  }

  function challengeBytesMatchClient(clientChallengeB64url, expectedChallengeBytes) {
    try {
      const got = b64urlDecode(clientChallengeB64url);
      const exp =
        expectedChallengeBytes instanceof Uint8Array
          ? expectedChallengeBytes
          : new Uint8Array(expectedChallengeBytes);
      if (!got || got.length !== exp.length) return false;
      let diff = 0;
      for (let i = 0; i < got.length; i++) diff |= got[i] ^ exp[i];
      return diff === 0;
    } catch (_e) {
      return false;
    }
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

  async function verifyAldApprovalArtifact(artifact, expectedRequest) {
    try {
      return await verifyInner(artifact, expectedRequest || null);
    } catch (_e) {
      return { ok: false, code: 'VERIFY_EXCEPTION' };
    }
  }

  async function verifyInner(artifact, expectedRequest) {
    if (!artifact || artifact.operation !== ALD_APPROVAL_OPERATION) {
      return { ok: false, code: 'BAD_OPERATION' };
    }
    if (artifact.ROOT_K_USED === true || artifact.NSEC_USED === true) {
      return { ok: false, code: 'SECRET_FLAG' };
    }
    if (artifact.DEVICE_AUTHORIZATION_SIGNED === true) {
      return { ok: false, code: 'UNEXPECTED_MD3_SIGNATURE' };
    }
    if (artifact.T1_FALLBACK_ENABLED === true) {
      return { ok: false, code: 'T1_FALLBACK_FORBIDDEN' };
    }
    if (artifact.approved === true && !artifact.assertion) {
      return { ok: false, code: 'CLIENT_APPROVED_FLAG_INSUFFICIENT' };
    }
    if (Date.now() > Number(artifact.approvalExpiresAt || 0)) {
      return { ok: false, code: 'APPROVAL_EXPIRED' };
    }

    const req = artifact.canonicalRequest;
    if (!req) return { ok: false, code: 'NO_CANONICAL_REQUEST' };
    for (let i = 0; i < (req.capabilities || []).length; i++) {
      const c = req.capabilities[i];
      if (c === 'DEVICE_ADMIN' || c === 'DEVICE_RECOVERY' || NORMAL_PROFILE_CAPS.indexOf(c) === -1) {
        return { ok: false, code: 'BAD_CAPABILITY' };
      }
    }

    const canonical = buildCanonicalAldApprovalRequest(req);
    if (artifact.intentCanonical && artifact.intentCanonical !== canonical) {
      return { ok: false, code: 'CANONICAL_MISMATCH' };
    }
    const requestHash = await requestHashFromCanonical(canonical);
    if (requestHash !== artifact.requestHash) {
      return { ok: false, code: 'REQUEST_HASH_MISMATCH' };
    }

    if (expectedRequest) {
      const fields = [
        'accountP',
        'deviceId',
        'D_sign_pub',
        'D_enc_pub',
        'pairingTranscriptHash',
        'pairingId',
        'authorizationId',
        'authEpoch',
      ];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const a = String(req[f] != null ? req[f] : '').toLowerCase();
        let bRaw = expectedRequest[f];
        if (bRaw == null && f === 'D_sign_pub') bRaw = expectedRequest.dSignPub;
        if (bRaw == null && f === 'D_enc_pub') bRaw = expectedRequest.dEncPub;
        const b = String(bRaw != null ? bRaw : '').toLowerCase();
        if (a !== b) return { ok: false, code: 'EXPECTED_FIELD_MISMATCH', field: f };
      }
      if (Array.isArray(expectedRequest.capabilities)) {
        const ea = [...expectedRequest.capabilities].map(String).sort().join(',');
        const eb = [...req.capabilities].map(String).sort().join(',');
        if (ea !== eb) return { ok: false, code: 'CAPABILITY_MISMATCH' };
      }
    }

    const signerOrigin = String(artifact.signerOrigin || '');
    if (isPagesDevOrigin(signerOrigin) || signerOrigin === PAGES_DEV_ORIGIN) {
      return { ok: false, code: 'PAGES_DEV_FORBIDDEN' };
    }
    if (!isAllowedEnrollmentOrigin(signerOrigin)) {
      return { ok: false, code: 'SIGNER_ORIGIN_NOT_ALLOWED' };
    }
    const rpId = String(artifact.rpId || (signerOrigin === PRODUCTION_ORIGIN ? PRODUCTION_RP_ID : 'localhost'));

    const ass = artifact.assertion;
    if (!ass) return { ok: false, code: 'NO_ASSERTION' };
    const clientDataJSON = b64urlDecode(ass.clientDataJSON_b64url);
    const authenticatorData = b64urlDecode(ass.authenticatorData_b64url);
    const signature = b64urlDecode(ass.signature_b64url);
    const rawId = b64urlDecode(ass.rawId_b64url || artifact.credentialIdB64url);
    const spki = b64urlDecode(artifact.publicKeySpkiB64url);
    if (!clientDataJSON || !authenticatorData || !signature || !rawId || !spki) {
      return { ok: false, code: 'MALFORMED_ASSERTION_BUNDLE' };
    }

    const challenge = await sha256(new TextEncoder().encode(canonical));
    if (bytesToHex(challenge) !== artifact.challengeHex) {
      return { ok: false, code: 'CHALLENGE_HEX_MISMATCH' };
    }

    const client = parseClientDataJSON(clientDataJSON);
    if (!client.ok) return { ok: false, code: client.code || 'CLIENT_DATA' };
    if (client.type !== 'webauthn.get') return { ok: false, code: 'WRONG_CLIENT_TYPE' };
    if (client.origin !== signerOrigin) return { ok: false, code: 'ORIGIN_MISMATCH' };
    if (!challengeBytesMatchClient(client.challenge, challenge)) {
      return { ok: false, code: 'CHALLENGE_MISMATCH' };
    }

    const auth = parseAuthenticatorData(authenticatorData);
    if (!auth.ok) return { ok: false, code: auth.code || 'AUTH_DATA' };
    if (!auth.up) return { ok: false, code: 'UP_FLAG_MISSING' };
    if (!auth.uv) return { ok: false, code: 'UV_FLAG_MISSING' };
    const rpHash = await expectedRpIdHashHex(rpId);
    if (auth.rpIdHashHex !== rpHash) return { ok: false, code: 'RP_ID_HASH_MISMATCH' };

    let key;
    try {
      key = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch (_e) {
      return { ok: false, code: 'PUBLIC_KEY_IMPORT_FAIL' };
    }

    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const signed = new Uint8Array(authenticatorData.length + clientHash.length);
    signed.set(authenticatorData, 0);
    signed.set(clientHash, authenticatorData.length);
    const sigRaw = derEcdsaSignatureToRaw(signature);
    if (!sigRaw) return { ok: false, code: 'SIGNATURE_FORMAT' };
    let okSig = false;
    try {
      okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigRaw, signed);
    } catch (_e) {
      return { ok: false, code: 'SIGNATURE_VERIFY_FAIL' };
    }
    if (!okSig) return { ok: false, code: 'SIGNATURE_INVALID' };

    if (artifact.accountP && String(artifact.accountP).toLowerCase() !== String(req.accountP).toLowerCase()) {
      return { ok: false, code: 'ARTIFACT_ACCOUNT_MISMATCH' };
    }

    return {
      ok: true,
      code: 'OK',
      accountP: req.accountP,
      requestHash,
      approvalId: artifact.approvalId,
      deviceId: req.deviceId,
      readyForWorkerMd3Sign: true,
      alg: COSE_ES256,
      WEBAUTHN_UV_PROVEN: true,
    };
  }

  const api = {
    ALD_APPROVAL_OPERATION,
    ALD_WORKER_VERIFY_CONTRACT_PRESENT: true,
    ALD_WORKER_SIGNS_DEVICE_AUTHORIZATION: false,
    ALD_T1_FALLBACK_ACCEPTED: false,
    NORMAL_PROFILE_CAPS,
    buildCanonicalAldApprovalRequest,
    requestHashFromCanonical,
    verifyAldApprovalArtifact,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SosAldW1aVerify = api;
  if (root.NostrApp) root.NostrApp.AldW1aVerify = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
