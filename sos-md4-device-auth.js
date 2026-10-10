/**
 * MD4 S1 — browser DeviceAuthorization verifyStrict (parity with SosDeviceAuthorization.kt).
 * No history transfer. No root K handling.
 */
(function initSosMd4DeviceAuth(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const VERSION = 'sos-device-authorization-v1';
  const DOMAIN = 'SOS_DEVICE_AUTHORIZATION_V1';
  const AUTH_EPOCH_INITIAL = 1;
  const HIST_TAG = 'sos-hist-v1';
  const PAIR_TAG = 'sos-pair-v1';

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }

  function isHex128(v) {
    return /^[0-9a-f]{128}$/.test(normHex(v));
  }

  function capsList(auth) {
    const c = auth && auth.capabilities;
    if (Array.isArray(c)) return c.map((x) => String(x)).sort();
    if (c && typeof c === 'object') return Object.keys(c).filter((k) => c[k]).sort();
    return [];
  }

  function hasCap(auth, name) {
    return capsList(auth).indexOf(name) !== -1;
  }

  /** Canonical signing bytes — must match Android SosDeviceAuthorization.canonicalBytes. */
  function canonicalBytes(auth) {
    const a = auth || {};
    const caps = capsList(a).join(',');
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
    const bytes = canonicalBytes(auth);
    const dig = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(dig);
  }

  function getVerifySchnorr() {
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (Md2 && typeof Md2.verifySchnorrRaw === 'function') return Md2.verifySchnorrRaw.bind(Md2);
    return null;
  }

  async function verifyRootSignature(auth) {
    const sig = normHex(auth.rootSignature || auth.rootSignatureHex);
    if (!sig) return { ok: false, code: 'MISSING_SIGNATURE' };
    if (!isHex128(sig)) return { ok: false, code: 'BAD_SIG_LEN' };
    const msg = await messageHash(auth);
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (Md2 && typeof Md2.verifySchnorrRawAsync === 'function') {
      const ok = await Md2.verifySchnorrRawAsync(sig, msg, normHex(auth.accountP));
      return ok ? { ok: true, code: 'OK' } : { ok: false, code: 'BAD_SIGNATURE' };
    }
    const verify = getVerifySchnorr();
    if (!verify) return { ok: false, code: 'SCHNORR_VERIFY_UNAVAILABLE' };
    const sync = verify(sig, msg, normHex(auth.accountP));
    if (sync === null) return { ok: false, code: 'SCHNORR_VERIFY_UNAVAILABLE' };
    return sync ? { ok: true, code: 'OK' } : { ok: false, code: 'BAD_SIGNATURE' };
  }

  /**
   * Structural + cryptographic verify (Android verifyStrict parity + S1 HISTORY_SYNC require).
   */
  async function verifyStrict(auth, nowMs, opts) {
    const o = opts || {};
    const requireHistorySync = o.requireHistorySync !== false;
    const a = auth || {};
    if (a.version !== VERSION) return { ok: false, code: 'UNKNOWN_VERSION' };
    if (!isHex64(a.accountP)) return { ok: false, code: 'BAD_ACCOUNT_P' };
    if (!isHex64(a.deviceId)) return { ok: false, code: 'BAD_DEVICE_ID' };
    if (!isHex64(a.D_sign_pub || a.dSignPub)) return { ok: false, code: 'BAD_D_SIGN' };
    if (!isHex64(a.D_enc_pub || a.dEncPub)) return { ok: false, code: 'BAD_D_ENC' };
    if (!isHex64(a.authorizationId)) return { ok: false, code: 'BAD_AUTH_ID' };
    if (!isHex64(a.pairingTranscriptHash)) return { ok: false, code: 'BAD_TRANSCRIPT' };
    // pairingId is MD2 opaque hex (commonly 32 hex / 16 bytes); not required to be 64.
    const pairingId = normHex(a.pairingId);
    if (!pairingId || pairingId.length < 16 || pairingId.length > 128 || pairingId.length % 2 !== 0 || !/^[0-9a-f]+$/.test(pairingId)) {
      return { ok: false, code: 'BAD_PAIRING_ID' };
    }
    const epoch = Number(a.authEpoch);
    if (!Number.isFinite(epoch) || epoch < AUTH_EPOCH_INITIAL) return { ok: false, code: 'BAD_EPOCH' };
    const createdAt = Number(a.createdAt);
    const expiresAt = Number(a.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      return { ok: false, code: 'BAD_EXPIRY_RANGE' };
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (now > expiresAt) return { ok: false, code: 'EXPIRED' };
    const caps = capsList(a);
    if (!caps.length) return { ok: false, code: 'EMPTY_CAPABILITIES' };
    if (caps.indexOf('DEVICE_ADMIN') !== -1) return { ok: false, code: 'ADMIN_NOT_ALLOWED' };
    if (requireHistorySync && caps.indexOf('DEVICE_HISTORY_SYNC') === -1) {
      return { ok: false, code: 'MISSING_DEVICE_HISTORY_SYNC' };
    }
    if (caps.indexOf('DEVICE_RECOVERY') !== -1) {
      if (!a.recoveryEligibleAtAuthorization) return { ok: false, code: 'RECOVERY_NOT_ELIGIBLE' };
      const sc = String(a.storageSecurityClass || '');
      if (sc === 'SOFTWARE_ONLY' || sc === 'UNSUPPORTED') return { ok: false, code: 'RECOVERY_STORAGE_CLASS' };
    }
    if (String(a.status || '').toUpperCase() === 'REVOKED') return { ok: false, code: 'REVOKED' };
    const minEpoch = Number(o.minAcceptedAuthEpoch);
    if (Number.isFinite(minEpoch) && epoch < minEpoch) return { ok: false, code: 'AUTH_EPOCH_MISMATCH' };
    const sigField = a.rootSignature || a.rootSignatureHex;
    if (!sigField) return { ok: false, code: 'MISSING_SIGNATURE' };
    return verifyRootSignature(a);
  }

  async function verifyForDestination(auth, local, nowMs, opts) {
    const loc = local || {};
    const v = await verifyStrict(auth, nowMs, opts);
    if (!v.ok) return v;
    if (normHex(auth.accountP) !== normHex(loc.accountP || loc.expectedAccountP)) {
      return { ok: false, code: 'ACCOUNT_MISMATCH' };
    }
    if (normHex(auth.deviceId) !== normHex(loc.deviceId)) return { ok: false, code: 'DEVICE_ID_MISMATCH' };
    if (normHex(auth.D_sign_pub || auth.dSignPub) !== normHex(loc.D_sign_pub || loc.dSignPub)) {
      return { ok: false, code: 'D_SIGN_MISMATCH' };
    }
    if (normHex(auth.D_enc_pub || auth.dEncPub) !== normHex(loc.D_enc_pub || loc.dEncPub)) {
      return { ok: false, code: 'D_ENC_MISMATCH' };
    }
    return { ok: true, code: 'OK' };
  }

  /** Fail-closed gate for future history-sync privileged ops (no S2 payload path). */
  async function assertHistorySyncAuthorized(ctx) {
    const c = ctx || {};
    if (!c.authorization) return { ok: false, code: 'NO_AUTHORIZATION' };
    if (!c.device) return { ok: false, code: 'NO_DEVICE' };
    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    const pk = normHex(c.authorization.accountP);
    if (GAS && typeof GAS.assertLinkedDeviceBindAllowed === 'function') {
      const gate = GAS.assertLinkedDeviceBindAllowed(pk);
      if (gate && gate.ok === false) return { ok: false, code: gate.code || 'ACCOUNT_DISABLED' };
    } else if (c.requireFreshAuthority === true) {
      return { ok: false, code: 'AUTHORITY_UNAVAILABLE_FAIL_CLOSED' };
    }
    return verifyForDestination(c.authorization, {
      accountP: pk,
      deviceId: c.device.deviceId,
      D_sign_pub: c.device.D_sign_pub,
      D_enc_pub: c.device.D_enc_pub,
    }, c.nowMs, { requireHistorySync: true, minAcceptedAuthEpoch: c.minAcceptedAuthEpoch });
  }

  /** Kind 25060 protocol domain separation (no hist payload handling in S1). */
  function classifyKind25060Tags(tags) {
    const tTags = (tags || []).filter((x) => x && x[0] === 't').map((x) => String(x[1] || ''));
    const hasPair = tTags.indexOf(PAIR_TAG) !== -1;
    const hasHist = tTags.indexOf(HIST_TAG) !== -1;
    if (hasPair && hasHist) return { ok: false, code: 'CROSS_PROTOCOL_TAG_COLLISION', protocol: null };
    if (hasHist) return { ok: true, code: 'HIST', protocol: HIST_TAG };
    if (hasPair) return { ok: true, code: 'PAIR', protocol: PAIR_TAG };
    if (tTags.length) return { ok: false, code: 'UNKNOWN_PROTOCOL_TAG', protocol: null, tags: tTags.slice(0, 4) };
    return { ok: false, code: 'MISSING_PROTOCOL_TAG', protocol: null };
  }

  function assertMd2MayAcceptEvent(ev) {
    const c = classifyKind25060Tags(ev && ev.tags);
    if (!c.ok) return c;
    if (c.protocol !== PAIR_TAG) return { ok: false, code: 'MD2_REJECTS_NON_PAIR', protocol: c.protocol };
    return { ok: true, code: 'OK', protocol: PAIR_TAG };
  }

  function assertHistMayAcceptEvent(ev) {
    const c = classifyKind25060Tags(ev && ev.tags);
    if (!c.ok) return c;
    if (c.protocol !== HIST_TAG) return { ok: false, code: 'HIST_REJECTS_NON_HIST', protocol: c.protocol };
    // S1: classify only — no payload delivery
    return { ok: true, code: 'OK_CLASSIFIED_NO_DELIVERY', protocol: HIST_TAG, delivery: false };
  }

  const api = Object.freeze({
    VERSION,
    DOMAIN,
    AUTH_EPOCH_INITIAL,
    HIST_TAG,
    PAIR_TAG,
    normHex,
    isHex64,
    capsList,
    hasCap,
    canonicalBytes,
    messageHash,
    verifyRootSignature,
    verifyStrict,
    verifyForDestination,
    assertHistorySyncAuthorized,
    classifyKind25060Tags,
    assertMd2MayAcceptEvent,
    assertHistMayAcceptEvent,
    RECOVERY_CAPABLE_BROWSER: false,
    FAKE_HISTORY_SYNC: false,
  });

  App.Md4DeviceAuth = api;
  window.SosMd4DeviceAuth = api;
})(window);
