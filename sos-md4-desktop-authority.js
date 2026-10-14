/**
 * Desktop MD3 verifyStrict + software-only device-key store.
 * Verifies the root Schnorr signature and device binding. Stores device keys, never Root K.
 */
(function initSosMd4DesktopAuthority(root) {
  'use strict';

  const VERSION = 'sos-device-authorization-v1';
  const DB_NAME = 'sos_md4_desktop_v1';
  const REC_STORE = 'devices';
  const META_STORE = 'meta';
  const App = root.NostrApp || (root.NostrApp = {});

  function normHex(v) {
    return String(v || '').toLowerCase().replace(/^0x/, '').trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }

  function bytesOf(v) {
    if (v instanceof Uint8Array) return new Uint8Array(v);
    return null;
  }

  function zero(buf) {
    try { if (buf) buf.fill(0); } catch (_e) {}
  }

  function capsOf(auth) {
    const raw = auth && auth.capabilities;
    if (!Array.isArray(raw)) return [];
    return raw.map(function (c) { return String(c); });
  }

  async function verifyForDestination(auth, local, nowMs, opts) {
    const o = opts || {};
    const dest = local || {};
    if (!auth || auth.version !== VERSION) return { ok: false, code: 'UNKNOWN_VERSION' };
    if (!isHex64(auth.accountP) || !isHex64(auth.deviceId) || !isHex64(auth.D_sign_pub || auth.dSignPub) || !isHex64(auth.D_enc_pub || auth.dEncPub)) {
      return { ok: false, code: 'BAD_BINDING' };
    }
    if (!isHex64(auth.authorizationId) || !isHex64(auth.pairingTranscriptHash) || !isHex64(auth.pairingId)) {
      return { ok: false, code: 'BAD_BINDING' };
    }
    if (!(Number(auth.authEpoch) >= 1)) return { ok: false, code: 'BAD_EPOCH' };
    if (!(Number(auth.expiresAt) > Number(auth.createdAt))) return { ok: false, code: 'BAD_EXPIRY_RANGE' };
    if ((nowMs || Date.now()) > Number(auth.expiresAt)) return { ok: false, code: 'EXPIRED' };
    const caps = capsOf(auth);
    if (!caps.length) return { ok: false, code: 'EMPTY_CAPABILITIES' };
    if (caps.indexOf('DEVICE_ADMIN') !== -1) return { ok: false, code: 'ADMIN_NOT_ALLOWED' };
    if (caps.indexOf('DEVICE_RECOVERY') !== -1) return { ok: false, code: 'RECOVERY_NOT_ELIGIBLE' };
    if (o.requireHistorySync === true && caps.indexOf('DEVICE_HISTORY_SYNC') === -1) {
      return { ok: false, code: 'HISTORY_SYNC_MISSING' };
    }
    const sig = normHex(auth.rootSignature || auth.rootSignatureHex);
    if (!/^[0-9a-f]{128}$/.test(sig)) return { ok: false, code: 'MISSING_SIGNATURE' };
    const Ald = root.SosAuthorizeLinkedDevice || App.AuthorizeLinkedDevice;
    const Md2 = root.SosMd2PairingSession || App.Md2PairingSession;
    if (!Ald || typeof Ald.messageHash !== 'function' || !Md2 || typeof Md2.verifySchnorrRawAsync !== 'function') {
      return { ok: false, code: 'AUTH_MODULE_MISSING' };
    }
    let msg;
    try { msg = await Ald.messageHash(auth); } catch (_e) { return { ok: false, code: 'CANONICAL_FAIL' }; }
    let good = false;
    try { good = await Md2.verifySchnorrRawAsync(sig, msg, normHex(auth.accountP)); } catch (_e) { good = false; }
    if (!good) return { ok: false, code: 'BAD_SIGNATURE' };
    if (normHex(auth.accountP) !== normHex(dest.accountP)) return { ok: false, code: 'ACCOUNT_MISMATCH' };
    if (normHex(auth.deviceId) !== normHex(dest.deviceId)) return { ok: false, code: 'DEVICE_ID_MISMATCH' };
    if (normHex(auth.D_sign_pub || auth.dSignPub) !== normHex(dest.D_sign_pub)) return { ok: false, code: 'D_SIGN_MISMATCH' };
    if (normHex(auth.D_enc_pub || auth.dEncPub) !== normHex(dest.D_enc_pub || auth.D_enc_pub)) return { ok: false, code: 'D_ENC_MISMATCH' };
    return { ok: true, code: 'VERIFY_STRICT', MD3_AUTHORIZATION_CRYPTO_VERIFIED: true };
  }

  async function assertHistorySyncAuthorized(args) {
    const a = args || {};
    const device = a.device || {};
    const verified = await verifyForDestination(a.authorization, {
      accountP: device.accountP || (a.authorization && a.authorization.accountP),
      deviceId: device.deviceId,
      D_sign_pub: device.D_sign_pub,
      D_enc_pub: device.D_enc_pub,
    }, Date.now(), { requireHistorySync: true });
    if (!verified.ok) return verified;
    return { ok: true, HISTORY_SYNC_AUTHORIZED: true, FAKE_HISTORY_SYNC: false };
  }

  function unsupported() {
    if (typeof indexedDB === 'undefined' || !root.crypto || !root.crypto.subtle) {
      return { ok: false, code: 'STORE_UNSUPPORTED' };
    }
    return { ok: true };
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(REC_STORE)) db.createObjectStore(REC_STORE, { keyPath: 'deviceId' });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IDB_OPEN')); };
    });
  }

  function idbReq(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IDB')); };
    });
  }

  async function wrapKey(db) {
    const existing = await idbReq(db.transaction(META_STORE).objectStore(META_STORE).get('wrap'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbReq(db.transaction(META_STORE, 'readwrite').objectStore(META_STORE).put(key, 'wrap'));
    return key;
  }

  async function sealBytes(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes));
    return { iv: iv, ct: ct };
  }

  async function openBytes(key, packed) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.iv }, key, packed.ct);
    return new Uint8Array(plain);
  }

  function publicAuth(auth) {
    return {
      version: auth.version,
      authorizationId: normHex(auth.authorizationId),
      accountP: normHex(auth.accountP),
      deviceId: normHex(auth.deviceId),
      D_sign_pub: normHex(auth.D_sign_pub || auth.dSignPub),
      D_enc_pub: normHex(auth.D_enc_pub || auth.dEncPub),
      capabilities: capsOf(auth),
      authEpoch: Number(auth.authEpoch),
      createdAt: Number(auth.createdAt),
      expiresAt: Number(auth.expiresAt),
      pairingTranscriptHash: normHex(auth.pairingTranscriptHash),
      pairingId: normHex(auth.pairingId),
      storageSecurityClass: String(auth.storageSecurityClass || 'SOFTWARE_ONLY'),
      recoveryEligibleAtAuthorization: false,
      rootSignature: normHex(auth.rootSignature || auth.rootSignatureHex),
      rootSignatureHex: normHex(auth.rootSignature || auth.rootSignatureHex),
    };
  }

  async function persistLinkedDevice(rec) {
    const support = unsupported();
    if (!support.ok) return support;
    const sign = bytesOf(rec && rec.dSignSk);
    const enc = bytesOf(rec && rec.dEncPriv);
    if (!sign || sign.length !== 32 || !enc || enc.length !== 32 || !rec.authorization) {
      return { ok: false, code: 'DEVICE_SECRETS_UNAVAILABLE' };
    }
    const db = await openDb();
    try {
      const key = await wrapKey(db);
      const sealedSign = await sealBytes(key, sign);
      const sealedEnc = await sealBytes(key, enc);
      const row = {
        deviceId: normHex(rec.deviceId),
        accountP: normHex(rec.accountP),
        D_sign_pub: normHex(rec.D_sign_pub),
        D_enc_pub: normHex(rec.D_enc_pub),
        storageClass: 'SOFTWARE_ONLY',
        savedAt: Date.now(),
        authorization: publicAuth(rec.authorization),
        sign: sealedSign,
        enc: sealedEnc,
        ROOT_K_PRESENT: false,
      };
      await idbReq(db.transaction(REC_STORE, 'readwrite').objectStore(REC_STORE).put(row));
      return { ok: true, code: 'PERSISTED', ROOT_K_PRESENT: false };
    } finally {
      zero(sign);
      zero(enc);
      try { db.close(); } catch (_e) {}
    }
  }

  async function unpack(row) {
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    const db = await openDb();
    try {
      const key = await wrapKey(db);
      const dSignSk = await openBytes(key, row.sign);
      const dEncPriv = await openBytes(key, row.enc);
      return {
        ok: true,
        deviceId: row.deviceId,
        accountP: row.accountP,
        D_sign_pub: row.D_sign_pub,
        D_enc_pub: row.D_enc_pub,
        storageClass: row.storageClass || 'SOFTWARE_ONLY',
        authorization: row.authorization,
        dSignSk: dSignSk,
        dEncPriv: dEncPriv,
        ROOT_K_PRESENT: false,
      };
    } finally {
      try { db.close(); } catch (_e) {}
    }
  }

  async function loadAnyForAccount(accountP) {
    const want = normHex(accountP);
    if (!isHex64(want)) return { ok: false, code: 'NO_ACCOUNT' };
    const db = await openDb();
    let rows = [];
    try {
      rows = await idbReq(db.transaction(REC_STORE).objectStore(REC_STORE).getAll());
    } finally {
      try { db.close(); } catch (_e) {}
    }
    const mine = (rows || []).filter(function (r) { return r && normHex(r.accountP) === want; });
    mine.sort(function (a, b) { return Number(b.savedAt || 0) - Number(a.savedAt || 0); });
    if (!mine.length) return { ok: false, code: 'NOT_FOUND' };
    return unpack(mine[0]);
  }

  async function loadLatest() {
    const db = await openDb();
    let rows = [];
    try {
      rows = await idbReq(db.transaction(REC_STORE).objectStore(REC_STORE).getAll());
    } finally {
      try { db.close(); } catch (_e) {}
    }
    const list = (rows || []).filter(Boolean);
    list.sort(function (a, b) { return Number(b.savedAt || 0) - Number(a.savedAt || 0); });
    if (!list.length) return { ok: false, code: 'NOT_FOUND' };
    return unpack(list[0]);
  }

  async function clearAccount(accountP) {
    const want = normHex(accountP);
    const db = await openDb();
    try {
      const rows = await idbReq(db.transaction(REC_STORE).objectStore(REC_STORE).getAll());
      const tx = db.transaction(REC_STORE, 'readwrite');
      (rows || []).forEach(function (r) {
        if (r && normHex(r.accountP) === want) tx.objectStore(REC_STORE).delete(r.deviceId);
      });
      await new Promise(function (resolve, reject) {
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, code: 'CLEAR_FAIL' };
    } finally {
      try { db.close(); } catch (_e) {}
    }
  }

  const authApi = {
    VERSION: VERSION,
    verifyForDestination: verifyForDestination,
    assertHistorySyncAuthorized: assertHistorySyncAuthorized,
    FAKE_HISTORY_SYNC: false,
  };
  const storeApi = {
    unsupported: unsupported,
    persistLinkedDevice: persistLinkedDevice,
    loadAnyForAccount: loadAnyForAccount,
    loadLatest: loadLatest,
    clearAccount: clearAccount,
    ROOT_K_STORED: false,
  };
  App.Md4DeviceAuth = authApi;
  App.Md4DeviceStore = storeApi;
  root.SosMd4DeviceAuth = authApi;
  root.SosMd4DeviceStore = storeApi;
})(typeof window !== 'undefined' ? window : globalThis);
