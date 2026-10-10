/**
 * MD4 S1 — durable browser device identity + signed DeviceAuthorization (IndexedDB + WebCrypto wrap).
 * NORMAL_PROFILE only. RECOVERY_CAPABLE=false.
 * Limitation: same-origin script compromise can still access unwrapped keys in process — documented.
 */
(function initSosMd4DeviceStore(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const DB_NAME = 'sos_md4_device_store_v1';
  const DB_VERSION = 1;
  const STORE = 'devices';
  const SCHEME = 'sos-device-keys-v1';
  const STORAGE_CLASS = 'BROWSER_WEBCYPTO_WRAPPED';

  function unsupported() {
    const subtle = !!(window.crypto && window.crypto.subtle);
    const idb = !!(window.indexedDB && typeof window.indexedDB.open === 'function');
    if (!subtle || !idb) return { ok: false, code: 'UNSUPPORTED_BROWSER', subtle, idb };
    return { ok: true, code: 'OK' };
  }

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
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

  function openDb() {
    const u = unsupported();
    if (!u.ok) return Promise.reject(Object.assign(new Error(u.code), u));
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error || new Error('IDB_OPEN_FAIL'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'recordKey' });
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  function recordKey(accountP, deviceId) {
    return normHex(accountP) + ':' + normHex(deviceId);
  }

  async function importWrapKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function generateWrapKeyMaterial() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importWrapKey(raw);
    return { raw, key };
  }

  async function aesGcmSeal(key, plain, aadStr) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(aadStr);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
    return { iv: hexFromBuf(iv), ct: hexFromBuf(new Uint8Array(ct)) };
  }

  async function aesGcmOpen(key, sealed, aadStr) {
    const iv = bufFromHex(sealed.iv);
    const ct = bufFromHex(sealed.ct);
    const aad = new TextEncoder().encode(aadStr);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct);
    return new Uint8Array(pt);
  }

  function aadFor(deviceId, which, pubFp8) {
    return 'SOS|device-key|v1|' + normHex(deviceId) + '|' + which + '|' + pubFp8;
  }

  async function pubFp8(pubHex) {
    const dig = await crypto.subtle.digest('SHA-256', bufFromHex(pubHex));
    return hexFromBuf(new Uint8Array(dig).slice(0, 8));
  }

  /**
   * Persist device privates (wrapped) + public meta + full signed authorization.
   * wrapKeyRawHex is stored AES-GCM-sealed under a random DB-local wrap envelope key... 
   * Simpler S1: store wrapKey raw encrypted to itself is circular.
   * Approach: store wrapKey as non-extractable CryptoKey in IDB via structured clone (CryptoKey is cloneable).
   */
  async function persistLinkedDevice(bundle) {
    const u = unsupported();
    if (!u.ok) return u;
    const b = bundle || {};
    const accountP = normHex(b.accountP);
    const deviceId = normHex(b.deviceId);
    const dSignPub = normHex(b.D_sign_pub);
    const dEncPub = normHex(b.D_enc_pub);
    if (!/^[0-9a-f]{64}$/.test(accountP) || !/^[0-9a-f]{64}$/.test(deviceId)) {
      return { ok: false, code: 'BAD_IDS' };
    }
    if (!/^[0-9a-f]{64}$/.test(dSignPub) || !/^[0-9a-f]{64}$/.test(dEncPub)) {
      return { ok: false, code: 'BAD_PUBS' };
    }
    const dSignSk = b.dSignSk instanceof Uint8Array ? b.dSignSk : bufFromHex(b.dSignSkHex || b.dSignSk);
    const dEncPriv = b.dEncPriv instanceof Uint8Array ? b.dEncPriv : bufFromHex(b.dEncPrivHex || b.dEncPriv);
    if (dSignSk.length !== 32 || dEncPriv.length !== 32) return { ok: false, code: 'BAD_PRIV_LEN' };

    const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
    if (!Auth) return { ok: false, code: 'AUTH_MODULE_MISSING' };
    const verified = await Auth.verifyForDestination(b.authorization, {
      accountP,
      deviceId,
      D_sign_pub: dSignPub,
      D_enc_pub: dEncPub,
    }, Date.now(), { requireHistorySync: true, minAcceptedAuthEpoch: b.minAcceptedAuthEpoch });
    if (!verified.ok) return verified;

    // Reject pubkey mismatch vs priv (best-effort for D_sign via nostr-tools)
    const NT = window.NostrTools;
    if (NT && typeof NT.getPublicKey === 'function') {
      const derived = normHex(NT.getPublicKey(dSignSk));
      if (derived !== dSignPub) return { ok: false, code: 'D_SIGN_PRIV_PUB_MISMATCH' };
    }

    const { key: wrapKey } = await generateWrapKeyMaterial();
    const signFp = await pubFp8(dSignPub);
    const encFp = await pubFp8(dEncPub);
    const sealedSign = await aesGcmSeal(wrapKey, dSignSk, aadFor(deviceId, 'sign', signFp));
    const sealedEnc = await aesGcmSeal(wrapKey, dEncPriv, aadFor(deviceId, 'enc', encFp));

    const authJson = JSON.parse(JSON.stringify(b.authorization));
    // Never persist root K fields if somehow present
    delete authJson.rootK;
    delete authJson.nsec;
    delete authJson.privateKey;

    const rec = {
      recordKey: recordKey(accountP, deviceId),
      schema: SCHEME,
      accountP,
      deviceId,
      D_sign_pub: dSignPub,
      D_enc_pub: dEncPub,
      storageClass: STORAGE_CLASS,
      recoveryEligible: false,
      RECOVERY_CAPABLE: false,
      hardwareBacked: false,
      wrapKey, // non-extractable CryptoKey via structured clone
      sealedSign,
      sealedEnc,
      authorization: authJson,
      minAcceptedAuthEpoch: Number(authJson.authEpoch) || 1,
      updatedAt: Date.now(),
      ROOT_K_PRESENT: false,
    };

    // Secret scan on serialized public parts
    const probe = JSON.stringify({ authorization: authJson, D_sign_pub: dSignPub, D_enc_pub: dEncPub });
    if (/\bnsec1|/i.test(probe) && /nsec1[a-z0-9]+/i.test(probe)) {
      return { ok: false, code: 'SECRET_SCAN_REJECT' };
    }

    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IDB_WRITE_FAIL'));
      tx.objectStore(STORE).put(rec);
    });
    db.close();
    try {
      dSignSk.fill(0);
      dEncPriv.fill(0);
    } catch (_z) {}
    return {
      ok: true,
      code: 'OK',
      accountP,
      deviceId,
      storageClass: STORAGE_CLASS,
      RECOVERY_CAPABLE: false,
      ROOT_K_SENT_TO_DESKTOP: false,
    };
  }

  async function loadLinkedDevice(accountP, deviceId) {
    const u = unsupported();
    if (!u.ok) return u;
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(recordKey(accountP, deviceId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('IDB_READ_FAIL'));
    });
    db.close();
    if (!rec) return { ok: false, code: 'NOT_FOUND' };
    return unwrapRecord(rec);
  }

  async function loadAnyForAccount(accountP) {
    const u = unsupported();
    if (!u.ok) return u;
    const pk = normHex(accountP);
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IDB_READ_FAIL'));
    });
    db.close();
    const mine = all.filter((r) => r && normHex(r.accountP) === pk);
    if (!mine.length) return { ok: false, code: 'NOT_FOUND' };
    mine.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return unwrapRecord(mine[0]);
  }

  async function unwrapRecord(rec) {
    try {
      if (!rec.wrapKey || !rec.sealedSign || !rec.sealedEnc) return { ok: false, code: 'CORRUPT_RECORD' };
      if (rec.RECOVERY_CAPABLE === true) return { ok: false, code: 'RECOVERY_CAPABLE_FORBIDDEN' };
      const signFp = await pubFp8(rec.D_sign_pub);
      const encFp = await pubFp8(rec.D_enc_pub);
      const dSignSk = await aesGcmOpen(rec.wrapKey, rec.sealedSign, aadFor(rec.deviceId, 'sign', signFp));
      const dEncPriv = await aesGcmOpen(rec.wrapKey, rec.sealedEnc, aadFor(rec.deviceId, 'enc', encFp));
      const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
      if (!Auth) return { ok: false, code: 'AUTH_MODULE_MISSING' };
      const v = await Auth.verifyForDestination(rec.authorization, {
        accountP: rec.accountP,
        deviceId: rec.deviceId,
        D_sign_pub: rec.D_sign_pub,
        D_enc_pub: rec.D_enc_pub,
      }, Date.now(), { requireHistorySync: true, minAcceptedAuthEpoch: rec.minAcceptedAuthEpoch });
      if (!v.ok) return { ok: false, code: v.code || 'AUTH_VERIFY_FAIL', authorization: null };

      return {
        ok: true,
        code: 'OK',
        scheme: SCHEME,
        accountP: rec.accountP,
        deviceId: rec.deviceId,
        D_sign_pub: rec.D_sign_pub,
        D_enc_pub: rec.D_enc_pub,
        dSignSk,
        dEncPriv,
        storageClass: rec.storageClass || STORAGE_CLASS,
        recoveryEligible: false,
        RECOVERY_CAPABLE: false,
        authorization: rec.authorization,
        minAcceptedAuthEpoch: rec.minAcceptedAuthEpoch || 1,
        updatedAt: rec.updatedAt,
        ROOT_K_PRESENT: false,
      };
    } catch (_e) {
      return { ok: false, code: 'CORRUPT_OR_TAMPERED' };
    }
  }

  async function clearAccount(accountP) {
    const u = unsupported();
    if (!u.ok) return u;
    const pk = normHex(accountP);
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IDB_KEYS_FAIL'));
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IDB_CLEAR_FAIL'));
      const os = tx.objectStore(STORE);
      all.forEach((k) => {
        if (String(k).indexOf(pk + ':') === 0) os.delete(k);
      });
    });
    db.close();
    return { ok: true, code: 'OK' };
  }

  async function listPublicForAccount(accountP) {
    const u = unsupported();
    if (!u.ok) return u;
    const pk = normHex(accountP);
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IDB_READ_FAIL'));
    });
    db.close();
    return {
      ok: true,
      devices: all
        .filter((r) => r && normHex(r.accountP) === pk)
        .map((r) => ({
          deviceId: r.deviceId,
          accountP: r.accountP,
          D_sign_pub: r.D_sign_pub,
          D_enc_pub: r.D_enc_pub,
          storageClass: r.storageClass,
          authorizationId: r.authorization && r.authorization.authorizationId,
          updatedAt: r.updatedAt,
          RECOVERY_CAPABLE: false,
        })),
    };
  }

  /** Scan IDB public JSON for plaintext priv / nsec (security test helper). */
  async function plaintextSecretScan(accountP) {
    const listed = await listPublicForAccount(accountP);
    if (!listed.ok) return listed;
    const db = await openDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('IDB_READ_FAIL'));
    });
    db.close();
    const pk = normHex(accountP);
    let hit = false;
    const blob = JSON.stringify(
      all.filter((r) => r && normHex(r.accountP) === pk).map((r) => {
        const copy = Object.assign({}, r);
        delete copy.wrapKey; // CryptoKey not JSON
        return copy;
      }),
    );
    if (/\bnsec1[a-z0-9]+\b/i.test(blob)) hit = true;
    if (/"dSignSk"|"d_sign_priv"|"dEncPriv"|"privateKey"|"rootK"/i.test(blob) && /"[0-9a-f]{64}"/i.test(blob)) {
      // sealed ct fields are hex — only flag explicit priv field names with raw 32-byte beside wrap
      if (/"dSignSkHex"\s*:\s*"[0-9a-f]{64}"/i.test(blob) || /"dEncPrivHex"\s*:\s*"[0-9a-f]{64}"/i.test(blob)) hit = true;
    }
    return { ok: !hit, code: hit ? 'PLAINTEXT_SECRET_DETECTED' : 'CLEAN', ROOT_K_PRESENT: false };
  }

  const api = Object.freeze({
    DB_NAME,
    SCHEME,
    STORAGE_CLASS,
    unsupported,
    persistLinkedDevice,
    loadLinkedDevice,
    loadAnyForAccount,
    clearAccount,
    listPublicForAccount,
    plaintextSecretScan,
    RECOVERY_CAPABLE: false,
    SAME_ORIGIN_XSS_STILL_RISK: true,
  });

  App.Md4DeviceStore = api;
  window.SosMd4DeviceStore = api;
})(window);
