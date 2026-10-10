/**
 * MD4 S2 — desktop ConversationKeyIndex sealed open + validation (sos-cki-v1 / sos-cki-seal-v1).
 * Opens only with durable D_enc. Never logs conversation keys. No chat-history import.
 */
(function initSosMd4Cki(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const SCHEMA = 'sos-cki-v1';
  const SEAL_SCHEMA = 'sos-cki-seal-v1';
  const ALG = 'nip44-v2';
  const SEAL_INFO = 'SOS|cki|v1';
  const HKDF_INFO = 'SOS|pair|v1'; // matches Android SosPairingCrypto.sessionKey info; domain sep via binding
  const MAX_ENTRIES_PER_PAGE = 512;
  const HIST_TAG = 'sos-hist-v1';
  const PAIR_TAG = 'sos-pair-v1';

  const spentExportSessions = new Set();

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }

  function bufFromHex(hex) {
    const h = normHex(hex);
    if (h.length % 2) throw new Error('BAD_HEX');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function hexFromBuf(buf) {
    return Array.from(buf, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function b64dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }

  async function hmacSha256(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }

  async function hkdfExtract(salt, ikm) {
    return hmacSha256(salt, ikm);
  }

  async function hkdfExpand(prk, info, length) {
    const out = new Uint8Array(length);
    let t = new Uint8Array(0);
    let offset = 0;
    let counter = 1;
    while (offset < length) {
      const input = new Uint8Array(t.length + info.length + 1);
      input.set(t, 0);
      input.set(info, t.length);
      input[t.length + info.length] = counter;
      t = await hmacSha256(prk, input);
      const take = Math.min(t.length, length - offset);
      out.set(t.subarray(0, take), offset);
      offset += take;
      counter += 1;
    }
    return out;
  }

  async function sessionKey(ecdh, binding) {
    const prk = await hkdfExtract(binding, ecdh);
    const info = new TextEncoder().encode(HKDF_INFO);
    return hkdfExpand(prk, info, 32);
  }

  async function aeadOpen(sk, aad, ivB64, ctB64) {
    try {
      const iv = b64dec(ivB64);
      const ct = b64dec(ctB64);
      const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['decrypt']);
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct),
      );
    } catch (_e) {
      return null;
    }
  }

  function x25519Shared(dEncPriv, ephPubHex) {
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.x25519Shared !== 'function') throw new Error('X25519_UNAVAILABLE');
    return Md2.x25519Shared(dEncPriv, ephPubHex);
  }

  async function bindingBytes(fields) {
    const lines = [
      SEAL_INFO,
      'accountP=' + normHex(fields.accountP),
      'deviceId=' + normHex(fields.deviceId),
      'authorizationId=' + normHex(fields.authorizationId),
      'authEpoch=' + String(fields.authEpoch),
      'pairingTranscriptHash=' + normHex(fields.pairingTranscriptHash),
      'exportSessionId=' + normHex(fields.exportSessionId),
      'D_enc_pub=' + normHex(fields.dEncPub),
      'nonce=' + normHex(fields.indexNonce),
    ];
    return sha256(new TextEncoder().encode(lines.join('\n')));
  }

  function rejectPlaintextDowngrade(pkg) {
    if (!pkg || typeof pkg !== 'object') return { ok: false, code: 'MALFORMED_SEAL' };
    if (pkg.entries || pkg.conversationKey || pkg.plaintextIndex) {
      return { ok: false, code: 'PLAINTEXT_DOWNGRADE' };
    }
    if (pkg.schema === SCHEMA && !pkg.ct && !pkg.ctB64) {
      return { ok: false, code: 'PLAINTEXT_DOWNGRADE' };
    }
    return { ok: true };
  }

  function parseIndex(plainBytes) {
    let o;
    try {
      o = JSON.parse(new TextDecoder().decode(plainBytes));
    } catch (_e) {
      return { ok: false, code: 'MALFORMED_INDEX' };
    }
    if (o.schema !== SCHEMA) return { ok: false, code: 'BAD_SCHEMA' };
    if (!Array.isArray(o.entries)) return { ok: false, code: 'MALFORMED_INDEX' };
    if (o.entries.length > MAX_ENTRIES_PER_PAGE) return { ok: false, code: 'PAGE_TOO_LARGE' };
    const seen = new Set();
    const entries = [];
    for (let i = 0; i < o.entries.length; i++) {
      const e = o.entries[i] || {};
      const peer = normHex(e.peerP);
      if (!isHex64(peer)) return { ok: false, code: 'BAD_PEER' };
      if (seen.has(peer)) return { ok: false, code: 'DUPLICATE_PEER' };
      seen.add(peer);
      const ck = normHex(e.conversationKey);
      if (ck.length !== 64) return { ok: false, code: 'BAD_CONVERSATION_KEY' };
      if (e.alg !== ALG) return { ok: false, code: 'BAD_ALG' };
      entries.push({
        peerP: peer,
        conversationKeyHex: ck,
        keyId: normHex(e.keyId),
        derivedAt: Number(e.derivedAt) || 0,
        alg: ALG,
      });
    }
    return {
      ok: true,
      index: {
        schema: SCHEMA,
        accountP: normHex(o.accountP),
        deviceId: normHex(o.deviceId),
        authorizationId: normHex(o.authorizationId),
        authEpoch: Number(o.authEpoch),
        pairingTranscriptHash: normHex(o.pairingTranscriptHash),
        createdAt: Number(o.createdAt),
        nonce: normHex(o.nonce),
        exportSessionId: normHex(o.exportSessionId),
        page: Number(o.page),
        pageCount: Number(o.pageCount),
        coverageNote: o.coverageNote || 'KEYS_ONLY',
        entries: entries,
      },
    };
  }

  /**
   * Open sealed CKI with durable device material from Md4DeviceStore load result.
   * Returns index in-memory only; caller must not persist plaintext keys (S2).
   */
  async function openSealedIndex(pkg, deviceCtx, opts) {
    const o = opts || {};
    const downgrade = rejectPlaintextDowngrade(pkg);
    if (!downgrade.ok) return downgrade;

    const sealSchema = pkg.sealSchema || SEAL_SCHEMA;
    if (sealSchema !== SEAL_SCHEMA) return { ok: false, code: 'BAD_SEAL_SCHEMA' };

    const exportId = normHex(pkg.exportSessionId);
    if (!isHex64(exportId)) return { ok: false, code: 'BAD_EXPORT_SESSION' };
    if (spentExportSessions.has(exportId) || (o.spentExportSessions && o.spentExportSessions.has(exportId))) {
      return { ok: false, code: 'REPLAY_EXPORT_SESSION' };
    }

    const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
    if (!Auth) return { ok: false, code: 'AUTH_MODULE_MISSING' };
    const auth = deviceCtx.authorization || o.authorization;
    if (!auth) return { ok: false, code: 'NO_AUTHORIZATION' };

    const v = await Auth.verifyForDestination(
      auth,
      {
        accountP: deviceCtx.accountP,
        deviceId: deviceCtx.deviceId,
        D_sign_pub: deviceCtx.D_sign_pub,
        D_enc_pub: deviceCtx.D_enc_pub,
      },
      o.nowMs,
      { requireHistorySync: true, minAcceptedAuthEpoch: deviceCtx.minAcceptedAuthEpoch || o.minAcceptedAuthEpoch },
    );
    if (!v.ok) return v;

    if (normHex(pkg.accountP) !== normHex(deviceCtx.accountP)) return { ok: false, code: 'ACCOUNT_MISMATCH' };
    if (normHex(pkg.deviceId) !== normHex(deviceCtx.deviceId)) return { ok: false, code: 'DEVICE_MISMATCH' };
    if (normHex(pkg.D_enc_pub || pkg.dEncPub) !== normHex(deviceCtx.D_enc_pub)) {
      return { ok: false, code: 'D_ENC_MISMATCH' };
    }
    if (normHex(pkg.authorizationId) !== normHex(auth.authorizationId)) {
      return { ok: false, code: 'AUTHORIZATION_ID_MISMATCH' };
    }
    if (Number(pkg.authEpoch) !== Number(auth.authEpoch)) return { ok: false, code: 'AUTH_EPOCH_MISMATCH' };
    if (normHex(pkg.pairingTranscriptHash) !== normHex(auth.pairingTranscriptHash)) {
      return { ok: false, code: 'PAIRING_TRANSCRIPT_MISMATCH' };
    }
    if (!isHex64(pkg.indexNonce)) return { ok: false, code: 'BAD_INDEX_NONCE' };
    if (!deviceCtx.dEncPriv) return { ok: false, code: 'NO_D_ENC_PRIV' };

    const binding = await bindingBytes({
      accountP: pkg.accountP,
      deviceId: pkg.deviceId,
      authorizationId: pkg.authorizationId,
      authEpoch: pkg.authEpoch,
      pairingTranscriptHash: pkg.pairingTranscriptHash,
      exportSessionId: pkg.exportSessionId,
      dEncPub: pkg.D_enc_pub || pkg.dEncPub,
      indexNonce: pkg.indexNonce,
    });

    const shared = x25519Shared(deviceCtx.dEncPriv, pkg.ephPub);
    let cek = null;
    try {
      cek = await sessionKey(shared, binding);
      const plain = await aeadOpen(cek, binding, pkg.iv, pkg.ct);
      if (!plain) return { ok: false, code: 'AEAD_FAIL' };
      const parsed = parseIndex(plain);
      if (!parsed.ok) return parsed;
      const index = parsed.index;
      if (normHex(index.nonce) !== normHex(pkg.indexNonce)) return { ok: false, code: 'NONCE_MISMATCH' };
      if (normHex(index.exportSessionId) !== exportId) return { ok: false, code: 'SESSION_MISMATCH' };
      if (normHex(index.accountP) !== normHex(deviceCtx.accountP)) return { ok: false, code: 'INDEX_ACCOUNT_MISMATCH' };
      if (normHex(index.deviceId) !== normHex(deviceCtx.deviceId)) return { ok: false, code: 'INDEX_DEVICE_MISMATCH' };
      if (normHex(index.pairingTranscriptHash) !== normHex(auth.pairingTranscriptHash)) {
        return { ok: false, code: 'INDEX_TRANSCRIPT_MISMATCH' };
      }
      // Mark replay after successful open
      spentExportSessions.add(exportId);
      return {
        ok: true,
        code: 'OK',
        index: index,
        entryCount: index.entries.length,
        // Safe public summary — no conversation keys
        publicSummary: {
          schema: index.schema,
          accountP: index.accountP,
          deviceId: index.deviceId,
          authorizationId: index.authorizationId,
          authEpoch: index.authEpoch,
          exportSessionId: index.exportSessionId,
          page: index.page,
          pageCount: index.pageCount,
          peerPs: index.entries.map((e) => e.peerP),
          coverageNote: index.coverageNote,
        },
        ROOT_K_PRESENT: false,
        PERSISTED_PLAINTEXT_KEYS: false,
      };
    } finally {
      if (cek) cek.fill(0);
      if (shared && shared.fill) shared.fill(0);
    }
  }

  function classifyHistTags(tags) {
    const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
    if (Auth && typeof Auth.classifyKind25060Tags === 'function') {
      return Auth.classifyKind25060Tags(tags);
    }
    const tTags = (tags || []).filter((x) => x && x[0] === 't').map((x) => String(x[1] || ''));
    const hasPair = tTags.indexOf(PAIR_TAG) !== -1;
    const hasHist = tTags.indexOf(HIST_TAG) !== -1;
    if (hasPair && hasHist) return { ok: false, code: 'CROSS_PROTOCOL_TAG_COLLISION', protocol: null };
    if (hasPair) return { ok: true, protocol: 'pair' };
    if (hasHist) return { ok: true, protocol: 'hist' };
    return { ok: false, code: 'UNKNOWN_PROTOCOL', protocol: null };
  }

  /** Reject MD2 pairing frames on hist open path. */
  function assertHistProtocol(tags) {
    const c = classifyHistTags(tags);
    if (!c.ok) return c;
    const proto = c.protocol;
    if (proto !== 'hist' && proto !== HIST_TAG) return { ok: false, code: 'PROTOCOL_CONFUSION' };
    return { ok: true, code: 'OK' };
  }

  function zeroizeIndex(opened) {
    if (!opened || !opened.index || !opened.index.entries) return;
    opened.index.entries.forEach((e) => {
      if (e && typeof e.conversationKeyHex === 'string') e.conversationKeyHex = '';
    });
  }

  function spentHas(id) {
    return spentExportSessions.has(normHex(id));
  }

  function resetSpentForTests() {
    spentExportSessions.clear();
  }

  const api = Object.freeze({
    SCHEMA,
    SEAL_SCHEMA,
    ALG,
    MAX_ENTRIES_PER_PAGE,
    openSealedIndex,
    parseIndex,
    rejectPlaintextDowngrade,
    assertHistProtocol,
    classifyHistTags,
    zeroizeIndex,
    spentHas,
    resetSpentForTests,
    bindingBytes,
  });

  App.Md4Cki = api;
  window.SosMd4Cki = api;
})(window);
