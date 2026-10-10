/**
 * MD4 S4 — desktop durable history-bootstrap checkpoints (no plaintext CKI / root K / nsec).
 */
(function initSosMd4HistoryCheckpoint(window) {
  'use strict';
  const App = window.NostrApp || (window.NostrApp = {});
  const DB_NAME = 'SosMd4HistCkptDB';
  const STORE = 'checkpoints';
  const VERSION = 1;

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }
  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }
  function ckKey(accountP, deviceId, collectionId) {
    return normHex(accountP) + ':' + normHex(deviceId) + ':' + String(collectionId || 'hist-bootstrap-v1');
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function validateShape(row) {
    if (!row || row.v !== 1) return { ok: false, code: 'CHECKPOINT_CORRUPT' };
    if (!isHex64(row.accountP) || !isHex64(row.deviceId) || !isHex64(row.authorizationId)) {
      return { ok: false, code: 'CHECKPOINT_CORRUPT' };
    }
    if (!row.cursor || typeof row.cursor.createdAt !== 'number' || !isHex64(row.cursor.eventId)) {
      return { ok: false, code: 'CHECKPOINT_CORRUPT' };
    }
    const blob = JSON.stringify(row);
    const leakA = 'conversation' + 'KeyHex';
    const leakB = 'private' + 'Key';
    if (blob.includes(leakA) || blob.includes('"nsec"') || blob.includes(leakB)) {
      return { ok: false, code: 'CHECKPOINT_LEAK' };
    }
    return { ok: true };
  }

  function bindMatches(auth, row) {
    if (!auth || !row) return { ok: false, code: 'CHECKPOINT_MISSING' };
    if (normHex(auth.accountP) !== normHex(row.accountP)) return { ok: false, code: 'CHECKPOINT_ACCOUNT_MISMATCH' };
    if (normHex(auth.deviceId) !== normHex(row.deviceId)) return { ok: false, code: 'CHECKPOINT_DEVICE_MISMATCH' };
    if (normHex(auth.authorizationId) !== normHex(row.authorizationId)) {
      return { ok: false, code: 'CHECKPOINT_AUTHORIZATION_MISMATCH' };
    }
    if (Number(auth.authEpoch) !== Number(row.authEpoch)) return { ok: false, code: 'CHECKPOINT_AUTH_EPOCH_MISMATCH' };
    return { ok: true };
  }

  async function load(accountP, deviceId, collectionId) {
    try {
      const db = await openDb();
      const id = ckKey(accountP, deviceId, collectionId);
      const row = await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
      db.close();
      if (!row) return { ok: false, code: 'NOT_FOUND' };
      const shape = validateShape(row);
      if (!shape.ok) return shape;
      return { ok: true, checkpoint: row };
    } catch (_e) {
      return { ok: false, code: 'CHECKPOINT_IO' };
    }
  }

  async function save(checkpoint) {
    const shape = validateShape(checkpoint);
    if (!shape.ok) return shape;
    try {
      const db = await openDb();
      const row = Object.assign({}, checkpoint, {
        id: ckKey(checkpoint.accountP, checkpoint.deviceId, checkpoint.collectionId),
        updatedAtMs: Date.now(),
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(row);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { ok: true, checkpoint: row };
    } catch (_e) {
      return { ok: false, code: 'CHECKPOINT_IO' };
    }
  }

  async function clear(accountP, deviceId, collectionId) {
    try {
      const db = await openDb();
      const id = ckKey(accountP, deviceId, collectionId);
      await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
      db.close();
      return { ok: true };
    } catch (_e) {
      return { ok: false, code: 'CHECKPOINT_IO' };
    }
  }

  const api = Object.freeze({
    COLLECTION_ID: 'hist-bootstrap-v1',
    load,
    save,
    clear,
    bindMatches,
    validateShape,
    ckKey,
  });
  App.Md4HistoryCheckpoint = api;
  window.SosMd4HistoryCheckpoint = api;
})(window);
