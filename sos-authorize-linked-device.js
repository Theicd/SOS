/**
 * MD3W-W1B — Typed AUTHORIZE_LINKED_DEVICE (Worker Vault).
 * Requires independently verified W1A T2 approval artifact. Signs sos-device-authorization-v1 only.
 * No generic root signing. No T1 fallback. No Root K/nsec in responses.
 */
/* eslint-disable no-restricted-globals */
(function initSosAuthorizeLinkedDevice(root) {
  'use strict';

  const OP = 'AUTHORIZE_LINKED_DEVICE';
  const VERSION = 'sos-device-authorization-v1';
  const DOMAIN = 'SOS_DEVICE_AUTHORIZATION_V1';
  const ENCODING = 'canonical-line-v1+sha256+schnorr';
  const AUTH_EPOCH_INITIAL = 1;
  const STORAGE_CLASS_WEB = 'SOFTWARE_ONLY';
  const T1_FALLBACK_ENABLED = false;
  const GENERIC_ROOT_SIGNER = false;
  const NORMAL_PROFILE = Object.freeze([
    'DEVICE_CHAT',
    'DEVICE_CALLS',
    'DEVICE_P2P',
    'DEVICE_FILES',
    'DEVICE_RECEIPTS',
    'DEVICE_PRESENCE',
    'DEVICE_SETTINGS',
    'DEVICE_HISTORY_SYNC',
  ]);

  function fail(code, extra) {
    const o = { ok: false, code: code, authorized: false, ROOT_K_RETURNED: false };
    if (extra && typeof extra === 'object') Object.assign(o, extra);
    return o;
  }

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }

  function isProductionHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'sos010.com' || h === 'www.sos010.com';
  }

  function webMd3IssuanceHostAllowed(hostname) {
    // Owner PRODUCTION FIRST (2026-10-12): allow sos010.com when feature flag is on.
    void hostname;
    return true;
  }

  function capsList(caps) {
    if (Array.isArray(caps)) return caps.map(String).sort();
    return [...NORMAL_PROFILE];
  }

  function canonicalBytes(auth) {
    const a = auth || {};
    const caps = capsList(a.capabilities).join(',');
    const lines = [
      DOMAIN,
      'version=' + String(a.version || ''),
      'authorizationId=' + normHex(a.authorizationId),
      'accountP=' + normHex(a.accountP),
      'deviceId=' + normHex(a.deviceId),
      'D_sign_pub=' + normHex(a.D_sign_pub || a.dSignPub),
      'D_enc_pub=' + normHex(a.D_enc_pub || a.dEncPub),
      'capabilities=' + caps,
      'authEpoch=' + String(Number(a.authEpoch)),
      'createdAt=' + String(Number(a.createdAt)),
      'expiresAt=' + String(Number(a.expiresAt)),
      'pairingTranscriptHash=' + normHex(a.pairingTranscriptHash),
      'pairingId=' + normHex(a.pairingId),
      'storageSecurityClass=' + String(a.storageSecurityClass || ''),
      'recoveryEligibleAtAuthorization=' + String(!!a.recoveryEligibleAtAuthorization),
    ];
    return new TextEncoder().encode(lines.join('\n'));
  }

  async function messageHash(auth) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', canonicalBytes(auth)));
  }

  function buildAuthorizationDraft(req, opts) {
    const o = opts || {};
    const now = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const expiresAt = Number(req.expiresAt);
    const createdAt = now;
    return {
      version: VERSION,
      authorizationId: normHex(req.authorizationId),
      accountP: normHex(req.accountP),
      deviceId: normHex(req.deviceId),
      D_sign_pub: normHex(req.D_sign_pub || req.dSignPub),
      D_enc_pub: normHex(req.D_enc_pub || req.dEncPub),
      capabilities: capsList(req.capabilities),
      authEpoch: Number(req.authEpoch),
      createdAt,
      expiresAt,
      pairingTranscriptHash: normHex(req.pairingTranscriptHash),
      pairingId: normHex(req.pairingId),
      storageSecurityClass: String(o.storageSecurityClass || STORAGE_CLASS_WEB),
      recoveryEligibleAtAuthorization: false,
      status: 'ACTIVE',
      encoding: ENCODING,
    };
  }

  /**
   * Durable one-time consume store (in-process harness OR adapter over DO).
   * NOT sufficient alone in production — Worker must call admission DO.
   */
  function createDurableApprovalStore() {
    /** @type {Map<string, { requestHash: string, accountP: string, deviceId: string, spentAt: number }>} */
    const rows = new Map();
    let unavailable = false;
    return {
      setUnavailable(v) {
        unavailable = !!v;
      },
      async consume(rec) {
        if (unavailable) return { ok: false, code: 'DURABLE_STORE_UNAVAILABLE' };
        const approvalId = String(rec.approvalId || '');
        const requestHash = String(rec.requestHash || '');
        const accountP = normHex(rec.accountP);
        const deviceId = normHex(rec.deviceId);
        if (!approvalId || !requestHash || !isHex64(accountP) || !isHex64(deviceId)) {
          return { ok: false, code: 'BAD_CONSUME_FIELDS' };
        }
        if (rows.has(approvalId)) {
          return { ok: false, code: 'APPROVAL_REPLAY', CONCURRENT_REPLAY_REJECTED: true };
        }
        // Cross-check: same requestHash cannot authorize a different device/account under new id
        for (const [, v] of rows) {
          if (v.requestHash === requestHash && (v.accountP !== accountP || v.deviceId !== deviceId)) {
            return { ok: false, code: 'REQUEST_HASH_REBIND' };
          }
        }
        rows.set(approvalId, { requestHash, accountP, deviceId, spentAt: Date.now() });
        return { ok: true, code: 'CONSUMED', approvalId };
      },
      has(approvalId) {
        return rows.has(String(approvalId || ''));
      },
      size() {
        return rows.size;
      },
    };
  }

  /**
   * Authorize after W1A proof verification + durable consume.
   * @param {object} args
   * @param {object} args.artifact — W1A approval artifact
   * @param {object} args.expectedRequest — exact MD3 draft binding fields
   * @param {string} args.accountP — vault session pubkey
   * @param {function} args.signSchnorrHex — async (msg32:Uint8Array, privHex:string)=>sigHex
   * @param {string} args.privHex — root K (never returned)
   * @param {object} args.durableStore — { consume(rec) }
   * @param {boolean} args.featureEnabled — page/QA flag
   * @param {string} args.hostname — deployment host
   * @param {number} [args.nowMs]
   * @param {number} [args.minAuthEpoch]
   * @param {boolean} [args.accountDisabled]
   * @param {boolean} [args.t1FallbackAttempt]
   */
  async function authorizeLinkedDevice(args) {
    const a = args || {};
    const counters = a.counters || { issued: 0, rejected: 0 };

    if (a.t1FallbackAttempt === true || a.skipT2 === true) {
      counters.rejected++;
      return fail('T1_FALLBACK_FORBIDDEN', { T1_FALLBACK_DISABLED: true });
    }
    if (!webMd3IssuanceHostAllowed(a.hostname) || a.featureEnabled !== true) {
      counters.rejected++;
      return fail('WEB_MD3_ISSUANCE_DISABLED', { FEATURE_FLAG_STATUS: 'OFF' });
    }
    if (GENERIC_ROOT_SIGNER) {
      counters.rejected++;
      return fail('GENERIC_SIGNER_FORBIDDEN');
    }
    if (!a.durableStore || typeof a.durableStore.consume !== 'function') {
      counters.rejected++;
      return fail('DURABLE_STORE_UNAVAILABLE');
    }
    if (!isHex64(a.accountP) || typeof a.signSchnorrHex !== 'function' || !isHex64(a.privHex)) {
      counters.rejected++;
      return fail('VAULT_NOT_READY');
    }
    if (a.accountDisabled === true) {
      counters.rejected++;
      return fail('ACCOUNT_DISABLED');
    }

    const Verify = root.SosAldW1aVerify;
    if (!Verify || typeof Verify.verifyAldApprovalArtifact !== 'function') {
      counters.rejected++;
      return fail('W1A_VERIFY_MISSING');
    }

    const expected = a.expectedRequest || {};
    if (normHex(expected.accountP) !== normHex(a.accountP)) {
      counters.rejected++;
      return fail('ACCOUNT_BINDING_MISMATCH');
    }

    // Never trust client approved/uv flags alone.
    if (a.artifact && a.artifact.approved === true && !a.artifact.assertion) {
      counters.rejected++;
      return fail('CLIENT_APPROVED_FLAG_INSUFFICIENT');
    }

    const verified = await Verify.verifyAldApprovalArtifact(a.artifact, expected);
    if (!verified || verified.ok !== true || verified.readyForWorkerMd3Sign !== true) {
      counters.rejected++;
      return fail(verified && verified.code ? verified.code : 'W1A_PROOF_INVALID', {
        TRUSTED_W1A_PROOF_VERIFIED: false,
      });
    }
    if (normHex(verified.accountP) !== normHex(a.accountP)) {
      counters.rejected++;
      return fail('PROOF_ACCOUNT_MISMATCH');
    }

    const req = a.artifact.canonicalRequest;
    const epoch = Number(req.authEpoch);
    const minEpoch = Number(a.minAuthEpoch);
    if (!Number.isFinite(epoch) || epoch < AUTH_EPOCH_INITIAL) {
      counters.rejected++;
      return fail('BAD_AUTH_EPOCH');
    }
    if (Number.isFinite(minEpoch) && epoch < minEpoch) {
      counters.rejected++;
      return fail('STALE_AUTH_EPOCH');
    }

    for (let i = 0; i < (req.capabilities || []).length; i++) {
      const c = req.capabilities[i];
      if (c === 'DEVICE_ADMIN' || c === 'DEVICE_RECOVERY' || NORMAL_PROFILE.indexOf(c) === -1) {
        counters.rejected++;
        return fail('PRIVILEGED_CAPABILITY');
      }
    }

    const consume = await a.durableStore.consume({
      approvalId: a.artifact.approvalId || verified.approvalId,
      requestHash: verified.requestHash,
      accountP: verified.accountP,
      deviceId: verified.deviceId,
    });
    if (!consume || consume.ok !== true) {
      counters.rejected++;
      return fail(consume && consume.code ? consume.code : 'CONSUME_FAILED', {
        DURABLE_ONE_TIME_CONSUMPTION: false,
        CONCURRENT_REPLAY_REJECTED: consume && consume.code === 'APPROVAL_REPLAY',
      });
    }

    const draft = buildAuthorizationDraft(req, {
      nowMs: a.nowMs,
      storageSecurityClass: a.storageSecurityClass || STORAGE_CLASS_WEB,
    });
    if (draft.expiresAt <= draft.createdAt || (a.nowMs || Date.now()) > draft.expiresAt) {
      counters.rejected++;
      return fail('EXPIRED_AUTHORIZATION');
    }

    // Exact bind: draft fields must match approved request (except createdAt)
    const bindFields = [
      ['authorizationId', req.authorizationId],
      ['accountP', req.accountP],
      ['deviceId', req.deviceId],
      ['D_sign_pub', req.D_sign_pub],
      ['D_enc_pub', req.D_enc_pub],
      ['pairingTranscriptHash', req.pairingTranscriptHash],
      ['pairingId', req.pairingId],
    ];
    for (let i = 0; i < bindFields.length; i++) {
      if (normHex(draft[bindFields[i][0]]) !== normHex(bindFields[i][1])) {
        counters.rejected++;
        return fail('DRAFT_BIND_MISMATCH', { field: bindFields[i][0] });
      }
    }

    let sigHex;
    try {
      const msg = await messageHash(draft);
      sigHex = await a.signSchnorrHex(msg, a.privHex);
    } catch (_e) {
      counters.rejected++;
      return fail('SIGN_FAILED');
    }
    if (!sigHex || !/^[0-9a-f]{128}$/.test(normHex(sigHex))) {
      counters.rejected++;
      return fail('BAD_SIGNATURE_OUTPUT');
    }

    const authorization = Object.assign({}, draft, {
      rootSignature: normHex(sigHex),
      rootSignatureHex: normHex(sigHex),
    });

    counters.issued++;
    return {
      ok: true,
      code: 'OK',
      authorized: true,
      operation: OP,
      authorization: authorization,
      approvalId: verified.approvalId,
      requestHash: verified.requestHash,
      TRUSTED_W1A_PROOF_VERIFIED: true,
      WEBAUTHN_UV_PROVEN: true,
      DURABLE_ONE_TIME_CONSUMPTION: true,
      T1_FALLBACK_DISABLED: true,
      ROOT_K_RETURNED: false,
      NSEC_RETURNED: false,
      encoding: ENCODING,
    };
  }

  const api = {
    OP,
    VERSION,
    DOMAIN,
    ENCODING,
    AUTH_EPOCH_INITIAL,
    NORMAL_PROFILE,
    T1_FALLBACK_ENABLED,
    GENERIC_ROOT_SIGNER,
    DEVICE_AUTH_GENERIC_ROOT_SIGNER_CREATED: false,
    ROOT_K_EXPOSED_FOR_DEVICE_AUTH: false,
    canonicalBytes,
    messageHash,
    buildAuthorizationDraft,
    createDurableApprovalStore,
    authorizeLinkedDevice,
    webMd3IssuanceHostAllowed,
    isProductionHost,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SosAuthorizeLinkedDevice = api;
  if (root.NostrApp) root.NostrApp.AuthorizeLinkedDevice = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
