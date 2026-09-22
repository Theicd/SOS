/**
 * אחסון מפתח Nostr.
 * Stage 5E-E2B2A:
 * - NativeSecureProvider: compatible Android shell only.
 * - BrowserSecureProvider: ordinary browser, IndexedDB + non-extractable AES-GCM.
 * - SessionOnlyProvider: never durable Native/Web/IndexedDB.
 * - LegacyProvider: old APK and missing browser primitives.
 * E2B2A keeps legacy plaintext as rollback. Migration does not delete it.
 * Sync read API after SOSKeyStorage.ready. Never logs K.
 */
(function initSOSKeyStorage(window) {
  const LS = 'nostr_private_key';
  const SS = 'nostr_private_key_ephemeral';
  const FLAG = 'sos_session_only_key';

  const PROVIDER_LEGACY = 'LegacyProvider';
  const PROVIDER_NATIVE_SECURE = 'NativeSecureProvider';
  const PROVIDER_SESSION_ONLY = 'SessionOnlyProvider';
  const PROVIDER_BROWSER_SECURE = 'BrowserSecureProvider';

  const WEB_SECURE_NONE = 'WEB_SECURE_NONE';
  const WEB_SECURE_LEGACY_ONLY = 'WEB_SECURE_LEGACY_ONLY';
  const WEB_SECURE_COPYING = 'WEB_SECURE_COPYING';
  const WEB_SECURE_COPY_VERIFIED = 'WEB_SECURE_COPY_VERIFIED';
  const WEB_SECURE_ACTIVE = 'WEB_SECURE_ACTIVE';
  const WEB_SECURE_MISMATCH = 'WEB_SECURE_MISMATCH';
  const WEB_SECURE_RECOVERY_REQUIRED = 'WEB_SECURE_RECOVERY_REQUIRED';
  const WEB_SECURE_UNAVAILABLE = 'WEB_SECURE_UNAVAILABLE';

  const BROWSER_DB = 'sos_identity_secure';
  const BROWSER_DB_VERSION = 1;
  const AAD_TEXT = 'SOS|browser-identity|v1';
  const SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  const BROWSER_SECURE_CUTOVER_PENDING = true;
  const BROWSER_SECURE_CUTOVER_DELETE_LEGACY = false;
  const CUTOVER_MARKER_KEY = 'sos_browser_secure_cutover';
  const REQUIRED_IDENTITY_MODULES = [
    'key-storage.js',
    'identity-storage-bootstrap.js',
    'auth-guard.js',
    'config.js',
    'keys.js',
    'app.js',
    'identity-lifecycle.js',
    'account.js',
    'key-viewer.js',
  ];
  const IDENTITY_PAGE_MODULE_SETS = {
    'index.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'auth-guard.js',
      'config.js',
      'keys.js',
      'identity-lifecycle.js',
      'account.js',
      'key-viewer.js',
      'app.js',
    ],
    'videos.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'config.js',
      'keys.js',
      'identity-lifecycle.js',
      'account.js',
      'key-viewer.js',
      'app.js',
    ],
    'auth.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'config.js',
      'app.js',
      'keys.js',
    ],
    'profile.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'auth-guard.js',
      'app.js',
      'config.js',
      'keys.js',
    ],
    'profile-viewer.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'auth-guard.js',
      'config.js',
      'keys.js',
    ],
    'dating.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'config.js',
      'keys.js',
    ],
    'storage.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'config.js',
      'keys.js',
      'identity-lifecycle.js',
      'app.js',
      'account.js',
      'key-viewer.js',
    ],
    'p2p-standby.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
      'config.js',
      'keys.js',
      'app.js',
    ],
    'hexgl-multiplayer.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
    ],
    'nzp-multiplayer.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
    ],
    'doom-multiplayer.html': [
      'key-storage.js',
      'identity-storage-bootstrap.js',
    ],
  };
  const IDENTITY_STORAGE_DEPLOY_FILES = REQUIRED_IDENTITY_MODULES.concat([
    'index.html',
    'videos.html',
    'storage.html',
    'auth.html',
    'profile.html',
    'profile-viewer.html',
    'dating.html',
    'p2p-standby.html',
    'hexgl-multiplayer.html',
    'nzp-multiplayer.html',
    'doom-multiplayer.html',
  ]);
  let memoryPriv = '';
  let memoryPub = '';
  let providerState = WEB_SECURE_NONE;
  let browserSecureActivated = false;
  let initPromise = null;
  let initCount = 0;
  let browserLegacyDeletePerformed = false;
  let controllerAtBoot = false;
  let controllerChangedMidPage = false;
  let browserSecureBootVerified = false;

  function createBootId() {
    try {
      const bytes = new Uint8Array(16);
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_e) {}
    return 'boot-' + String(Math.random()).slice(2);
  }
  const currentBootId = createBootId();

  const generationRegistry = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  generationRegistry['key-storage.js'] = SOS_IDENTITY_STORAGE_CODE_VERSION;
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = SOS_IDENTITY_STORAGE_CODE_VERSION;

  function captureControllerAtBoot() {
    try {
      const sw = window.navigator && window.navigator.serviceWorker;
      controllerAtBoot = !!(sw && sw.controller);
      if (sw && typeof sw.addEventListener === 'function') {
        sw.addEventListener('controllerchange', () => {
          controllerChangedMidPage = true;
        });
      }
    } catch (_e) {
      controllerAtBoot = false;
    }
  }
  captureControllerAtBoot();

  function isHex64(s) {
    if (typeof s !== 'string') return false;
    return /^[0-9a-f]{64}$/i.test(s.trim());
  }

  function isSessionOnly() {
    try {
      return window.localStorage.getItem(FLAG) === '1';
    } catch (_e) {
      return false;
    }
  }

  function nativeBridge() {
    try {
      const bridge = window.SosNativeShell;
      if (!bridge || typeof bridge.isNativeShell !== 'function') return null;
      if (bridge.isNativeShell() !== true) return null;
      if (typeof bridge.getIdentityStorageCapabilitiesJson !== 'function') return null;
      if (typeof bridge.getSecureWebIdentityJson !== 'function') return null;
      if (typeof bridge.writeSecureWebIdentity !== 'function') return null;
      const raw = bridge.getIdentityStorageCapabilitiesJson();
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      if (!parsed || parsed.nativeSecureWebIdentity !== true || Number(parsed.version) < 1) return null;
      return bridge;
    } catch (_e) {
      return null;
    }
  }

  function isUncapableNativeShell() {
    try {
      const bridge = window.SosNativeShell;
      if (!bridge || typeof bridge.isNativeShell !== 'function') return false;
      if (bridge.isNativeShell() !== true) return false;
      return !nativeBridge();
    } catch (_e) {
      return false;
    }
  }

  function browserPrimitives() {
    try {
      const fail = window.__sosBrowserSecureForceFail;
      if (fail === 'subtle' || fail === 'idb') return false;
      return !!(
        window.crypto &&
        window.crypto.subtle &&
        typeof window.crypto.getRandomValues === 'function' &&
        window.indexedDB &&
        typeof window.indexedDB.open === 'function'
      );
    } catch (_e) {
      return false;
    }
  }

  function activeProviderName() {
    if (isSessionOnly()) return PROVIDER_SESSION_ONLY;
    if (nativeBridge()) return PROVIDER_NATIVE_SECURE;
    if (isUncapableNativeShell()) return PROVIDER_LEGACY;
    if (browserSecureActivated) return PROVIDER_BROWSER_SECURE;
    return PROVIDER_LEGACY;
  }

  function readLegacyPlaintext() {
    try {
      return window.localStorage.getItem(LS) || '';
    } catch (_e) {
      return '';
    }
  }

  function removeWebPlaintext() {
    try { window.localStorage.removeItem(LS); } catch (_e) {}
    try {
      if (!isSessionOnly()) window.sessionStorage.removeItem(SS);
    } catch (_e2) {}
  }

  function validatePair(priv, pub) {
    const p = String(priv || '').trim().toLowerCase();
    const expected = String(pub || '').trim().toLowerCase();
    if (!isHex64(p)) return null;
    try {
      if (window.NostrApp && typeof window.NostrApp.validateIdentityPair === 'function') {
        const pair = window.NostrApp.validateIdentityPair(p, expected || null);
        if (!pair || !pair.ok) return null;
        return { priv: pair.privateKey, pub: pair.publicKey };
      }
    } catch (_e) {}
    if (expected && isHex64(expected)) return { priv: p, pub: expected };
    try {
      const getPublicKey = window.NostrTools && window.NostrTools.getPublicKey;
      if (typeof getPublicKey === 'function') {
        const derived = String(getPublicKey(p) || '').trim().toLowerCase();
        if (!isHex64(derived)) return null;
        if (expected && expected !== derived) return null;
        return { priv: p, pub: derived };
      }
    } catch (_e2) {}
    return { priv: p, pub: expected };
  }

  function readNativeIdentity() {
    const bridge = nativeBridge();
    if (!bridge) return { ok: false, state: WEB_SECURE_NONE, priv: '', pub: '' };
    try {
      const raw = bridge.getSecureWebIdentityJson();
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      if (!parsed || parsed.ok !== true) {
        return {
          ok: false,
          state: String(parsed && parsed.state ? parsed.state : WEB_SECURE_NONE),
          priv: '',
          pub: '',
        };
      }
      const pair = validatePair(parsed.privkey, parsed.pubkey);
      if (!pair || !pair.pub) {
        return { ok: false, state: WEB_SECURE_RECOVERY_REQUIRED, priv: '', pub: '' };
      }
      return { ok: true, state: WEB_SECURE_ACTIVE, priv: pair.priv, pub: pair.pub };
    } catch (_e) {
      return { ok: false, state: WEB_SECURE_RECOVERY_REQUIRED, priv: '', pub: '' };
    }
  }

  /**
   * Pure decision for Web plaintext vs Native secure. No generation.
   */
  function decideWebNativeSecure(nativeOk, legacyHex, nativeHex, nativeFailedState) {
    const legacy = isHex64(legacyHex) ? String(legacyHex).trim().toLowerCase() : '';
    const native = isHex64(nativeHex) ? String(nativeHex).trim().toLowerCase() : '';
    if (nativeOk && legacy && native && legacy !== native) {
      return { state: WEB_SECURE_MISMATCH, deleteLegacy: false, use: '', recovery: true };
    }
    if (nativeOk && legacy && native && legacy === native) {
      return { state: WEB_SECURE_COPY_VERIFIED, deleteLegacy: true, use: native, recovery: false };
    }
    if (nativeOk && native && !legacy) {
      return { state: WEB_SECURE_ACTIVE, deleteLegacy: false, use: native, recovery: false };
    }
    if (!nativeOk && nativeFailedState === WEB_SECURE_MISMATCH) {
      return { state: WEB_SECURE_MISMATCH, deleteLegacy: false, use: '', recovery: true };
    }
    if (!nativeOk && nativeFailedState === WEB_SECURE_RECOVERY_REQUIRED) {
      return { state: WEB_SECURE_RECOVERY_REQUIRED, deleteLegacy: false, use: '', recovery: true };
    }
    if (!nativeOk && legacy) {
      return { state: WEB_SECURE_LEGACY_ONLY, deleteLegacy: false, use: legacy, recovery: false };
    }
    return { state: WEB_SECURE_NONE, deleteLegacy: false, use: '', recovery: false };
  }

  function writeNativeSecure(privHex) {
    const bridge = nativeBridge();
    if (!bridge) return false;
    const pair = validatePair(privHex, null);
    if (!pair || !pair.pub) return false;
    let parsed = null;
    try {
      const raw = bridge.writeSecureWebIdentity(pair.pub, pair.priv);
      parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    } catch (_e) {
      return false;
    }
    if (!parsed || parsed.ok !== true) return false;
    const again = readNativeIdentity();
    if (!again.ok || again.priv !== pair.priv || again.pub !== pair.pub) return false;
    memoryPriv = again.priv;
    memoryPub = again.pub;
    providerState = WEB_SECURE_ACTIVE;
    return true;
  }

  function hydrateNative() {
    if (isHex64(memoryPriv)) {
      providerState = WEB_SECURE_ACTIVE;
      return memoryPriv;
    }
    const legacy = readLegacyPlaintext();
    const native = readNativeIdentity();
    const decision = decideWebNativeSecure(native.ok, legacy, native.priv, native.state);
    if (decision.state === WEB_SECURE_MISMATCH || decision.recovery && !decision.use) {
      memoryPriv = '';
      memoryPub = '';
      providerState = decision.state;
      return '';
    }
    if (decision.deleteLegacy) {
      const again = readNativeIdentity();
      if (!again.ok || again.priv !== decision.use) {
        providerState = WEB_SECURE_RECOVERY_REQUIRED;
        return '';
      }
      removeWebPlaintext();
      try { console.log('WEB_NATIVE_SECURE_CUTOVER legacy_web_deleted=1 verified=1'); } catch (_e) {}
      memoryPriv = again.priv;
      memoryPub = again.pub;
      providerState = WEB_SECURE_ACTIVE;
      return memoryPriv;
    }
    if (native.ok && decision.use) {
      memoryPriv = native.priv;
      memoryPub = native.pub;
      providerState = WEB_SECURE_ACTIVE;
      return memoryPriv;
    }
    if (!native.ok && isHex64(legacy)) {
      const copied = writeNativeSecure(legacy);
      if (!copied) {
        providerState = WEB_SECURE_LEGACY_ONLY;
        return String(legacy).trim().toLowerCase();
      }
      const again = readNativeIdentity();
      if (again.ok && again.priv === String(legacy).trim().toLowerCase()) {
        removeWebPlaintext();
        try { console.log('WEB_NATIVE_SECURE_CUTOVER legacy_web_deleted=1 verified=1'); } catch (_e2) {}
      }
      return memoryPriv;
    }
    providerState = decision.state || WEB_SECURE_NONE;
    return '';
  }

  function aadBytes() {
    return new TextEncoder().encode(AAD_TEXT);
  }

  let delayApplied = false;

  function openBrowserDb() {
    const delay = !delayApplied ? Math.max(0, Number(window.__sosBrowserSecureDelayMs) || 0) : 0;
    delayApplied = true;
    return new Promise((resolve, reject) => {
      const start = () => {
        let req;
        try {
          req = window.indexedDB.open(BROWSER_DB, BROWSER_DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          ['wrapping_key', 'identity_blob', 'metadata'].forEach((name) => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb_open'));
      };
      if (delay) window.setTimeout(start, delay);
      else start();
    });
  }

  function idbGet(storeName, key) {
    return openBrowserDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        try { db.close(); } catch (_e) {}
        resolve(req.result);
      };
      req.onerror = () => {
        try { db.close(); } catch (_e) {}
        reject(req.error || new Error('idb_get'));
      };
    }));
  }

  function idbPut(storeName, key, value) {
    if (window.__sosBrowserSecureForceFail === 'persist' && storeName === 'wrapping_key') {
      return Promise.reject(new Error('persist'));
    }
    return openBrowserDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value, key);
      req.onsuccess = () => {
        try { db.close(); } catch (_e) {}
        resolve(true);
      };
      req.onerror = () => {
        try { db.close(); } catch (_e) {}
        reject(req.error || new Error('idb_put'));
      };
    }));
  }

  function idbDelete(storeName, key) {
    return openBrowserDb().then((db) => new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => {
          try { db.close(); } catch (_e) {}
          resolve(true);
        };
        req.onerror = () => {
          try { db.close(); } catch (_e) {}
          reject(req.error || new Error('idb_delete'));
        };
      } catch (err) {
        try { db.close(); } catch (_e) {}
        reject(err);
      }
    }));
  }

  async function loadOrCreateWrapKey() {
    const existing = await idbGet('wrapping_key', 'v1');
    if (existing) return existing;
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    await idbPut('wrapping_key', 'v1', key);
    const again = await idbGet('wrapping_key', 'v1');
    if (!again) throw new Error('wrap_missing');
    return again;
  }

  async function encryptIdentity(pair) {
    const key = await loadOrCreateWrapKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadBytes() },
      key,
      new TextEncoder().encode(pair.priv)
    );
    const blob = {
      version: 1,
      iv,
      ciphertext,
      pubkey: pair.pub,
      migratedAt: Date.now(),
    };
    await idbPut('identity_blob', 'current', blob);
    try {
      await idbPut('metadata', 'provider', { identity_storage_provider: 'browser-secure-v1' });
    } catch (_e) {}
    return blob;
  }

  async function decryptIdentityBlob(blob) {
    if (!blob || blob.version !== 1 || !blob.iv || !blob.ciphertext) {
      return { corrupt: true };
    }
    try {
      const key = await idbGet('wrapping_key', 'v1');
      if (!key) return { corrupt: true };
      const plain = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.iv, additionalData: aadBytes() },
        key,
        blob.ciphertext
      );
      const priv = new TextDecoder().decode(plain).trim().toLowerCase();
      const pair = validatePair(priv, blob.pubkey || null);
      if (!pair || !pair.pub) return { corrupt: true };
      return { ok: true, priv: pair.priv, pub: pair.pub };
    } catch (_e) {
      return { corrupt: true };
    }
  }

  async function readSecureIdentity() {
    const blob = await idbGet('identity_blob', 'current');
    if (!blob) return { ok: false, empty: true };
    const opened = await decryptIdentityBlob(blob);
    if (opened.corrupt) return { ok: false, corrupt: true };
    return opened;
  }

  async function deleteBrowserSecrets() {
    try { await idbDelete('identity_blob', 'current'); } catch (_e) {}
    try { await idbDelete('wrapping_key', 'v1'); } catch (_e2) {}
    try { await idbDelete('metadata', 'provider'); } catch (_e3) {}
  }

  async function writeBrowserVerified(privHex) {
    if (providerState === WEB_SECURE_MISMATCH || providerState === WEB_SECURE_RECOVERY_REQUIRED) {
      return false;
    }
    const pair = validatePair(privHex, null);
    if (!pair || !pair.pub) return false;
    const existingMarker = readCutoverMarker();
    if (existingMarker && existingMarker.publicKey && existingMarker.publicKey !== pair.pub) {
      try { window.localStorage.removeItem(CUTOVER_MARKER_KEY); } catch (_eMarker) {}
    }
    const legacy = String(readLegacyPlaintext() || '').trim().toLowerCase();
    if (isHex64(legacy) && legacy !== pair.priv) {
      try { await idbDelete('identity_blob', 'current'); } catch (_e0) {}
      try { window.localStorage.removeItem(LS); } catch (_e1) {}
    }
    providerState = WEB_SECURE_COPYING;
    await encryptIdentity(pair);
    const again = await readSecureIdentity();
    if (!again.ok || again.priv !== pair.priv || again.pub !== pair.pub) {
      providerState = WEB_SECURE_RECOVERY_REQUIRED;
      return false;
    }
    try { window.localStorage.setItem(LS, pair.priv); } catch (_e) {}
    memoryPriv = pair.priv;
    memoryPub = pair.pub;
    providerState = WEB_SECURE_COPY_VERIFIED;
    browserSecureActivated = true;
    noteSecureBootVerified();
    return true;
  }

  async function bootBrowserSecure() {
    browserSecureBootVerified = false;
    const legacyRaw = readLegacyPlaintext();
    const legacyPair = isHex64(legacyRaw) ? validatePair(legacyRaw, null) : null;
    const secure = await readSecureIdentity();
    const migratedMarker = markerIndicatesSecureUser(readCutoverMarker());
    if (!secure.ok && !secure.corrupt && !legacyPair && migratedMarker) {
      try { window.localStorage.removeItem(CUTOVER_MARKER_KEY); } catch (_eOrphan) {}
      providerState = WEB_SECURE_NONE;
      memoryPriv = '';
      memoryPub = '';
      browserSecureActivated = true;
      return;
    }
    if (secure.corrupt) {
      providerState = WEB_SECURE_RECOVERY_REQUIRED;
      memoryPriv = '';
      memoryPub = '';
      browserSecureActivated = true;
      return;
    }
    if (secure.ok && legacyPair && secure.priv !== legacyPair.priv) {
      providerState = WEB_SECURE_MISMATCH;
      memoryPriv = '';
      memoryPub = '';
      browserSecureActivated = true;
      return;
    }
    if (secure.ok && legacyPair && secure.priv === legacyPair.priv) {
      memoryPriv = secure.priv;
      memoryPub = secure.pub;
      providerState = WEB_SECURE_COPY_VERIFIED;
      browserSecureActivated = true;
      noteSecureBootVerified();
      return;
    }
    if (secure.ok && !legacyPair) {
      memoryPriv = secure.priv;
      memoryPub = secure.pub;
      providerState = WEB_SECURE_ACTIVE;
      browserSecureActivated = true;
      noteSecureBootVerified();
      return;
    }
    if (!secure.ok && legacyPair) {
      providerState = WEB_SECURE_COPYING;
      await encryptIdentity(legacyPair);
      const again = await readSecureIdentity();
      if (!again.ok || again.priv !== legacyPair.priv || again.pub !== legacyPair.pub) {
        providerState = WEB_SECURE_UNAVAILABLE;
        browserSecureActivated = false;
        return;
      }
      memoryPriv = again.priv;
      memoryPub = again.pub;
      providerState = WEB_SECURE_COPY_VERIFIED;
      browserSecureActivated = true;
      noteSecureBootVerified();
      return;
    }
    providerState = WEB_SECURE_NONE;
    browserSecureActivated = true;
  }

  /* CUTOVER_I1_START */
  function readCutoverMarker() {
    try {
      const raw = window.localStorage.getItem(CUTOVER_MARKER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        version: parsed.version === 1 ? 1 : 0,
        state: parsed.state || 'none',
        publicKey: typeof parsed.publicKey === 'string' ? parsed.publicKey : '',
        codeVersion: typeof parsed.codeVersion === 'string' ? parsed.codeVersion : '',
        controllerMarker: typeof parsed.controllerMarker === 'string' ? parsed.controllerMarker : '',
        pendingAt: parsed.pendingAt || null,
        verifiedAt: parsed.verifiedAt || null,
        pendingBootId: typeof parsed.pendingBootId === 'string' ? parsed.pendingBootId : '',
      };
    } catch (_e) {
      return null;
    }
  }

  function markerIndicatesSecureUser(marker) {
    if (!marker) return false;
    return marker.state === 'pending' || marker.state === 'verified' || marker.state === 'complete';
  }

  function writeCutoverMarker(marker) {
    if (!marker || marker.state === 'complete') {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=COMPLETE_FORBIDDEN'); } catch (_e) {}
      return readCutoverMarker();
    }
    const safe = {
      version: 1,
      state: marker.state,
      publicKey: String(marker.publicKey || ''),
      codeVersion: SOS_IDENTITY_STORAGE_CODE_VERSION,
      controllerMarker: marker.controllerMarker || 'none',
      pendingAt: marker.pendingAt || null,
      verifiedAt: marker.verifiedAt || null,
      pendingBootId: typeof marker.pendingBootId === 'string' ? marker.pendingBootId : '',
    };
    window.localStorage.setItem(CUTOVER_MARKER_KEY, JSON.stringify(safe));
    return safe;
  }

  let storagePersistenceRequested = false;
  let storagePersistedObserved = false;

  function noteSecureBootVerified() {
    browserSecureBootVerified = true;
    requestStoragePersistenceOnce();
  }

  function requestStoragePersistenceOnce() {
    try {
      if (storagePersistenceRequested) return;
      if (isSessionOnly() || nativeBridge() || isUncapableNativeShell()) return;
      const storage = window.navigator && window.navigator.storage;
      if (!storage || typeof storage.persist !== 'function') return;
      storagePersistenceRequested = true;
      Promise.resolve(storage.persist()).then(() => storagePersistedState()).then((state) => {
        storagePersistedObserved = state.ok === true;
      }).catch(() => {
        storagePersistedObserved = false;
      });
    } catch (_e) {}
  }

  function identityEntryPageName() {
    try {
      const body = window.document && window.document.body;
      if (body && body.classList && body.classList.contains('videos-page')) return 'videos.html';
    } catch (_e) {}
    let path = '';
    try {
      path = String(window.location && window.location.pathname || '');
    } catch (_e2) {
      path = '';
    }
    const parts = path.split('/').filter(Boolean);
    const leaf = parts.length ? parts[parts.length - 1] : 'index.html';
    if (!leaf || leaf.indexOf('.') === -1) return 'index.html';
    return String(leaf).toLowerCase();
  }

  function expectedIdentityModulesForPage(pageName) {
    const page = String(pageName || identityEntryPageName());
    const set = IDENTITY_PAGE_MODULE_SETS[page];
    return set ? set.slice() : null;
  }

  function verifyIdentityStorageCodeGeneration() {
    const page = identityEntryPageName();
    const expected = IDENTITY_PAGE_MODULE_SETS[page];
    const reg = window.SOSIdentityStorageGeneration || {};
    if (!expected) {
      return { result: 'CODE_GENERATION_INCOMPLETE', page, missing: ['UNDECLARED_PAGE'] };
    }
    const missing = expected.filter((name) => reg[name] == null || reg[name] === '');
    if (missing.length) return { result: 'CODE_GENERATION_INCOMPLETE', page, missing };
    const mismatch = expected.filter((name) => reg[name] !== SOS_IDENTITY_STORAGE_CODE_VERSION);
    const extraMismatch = Object.keys(reg).filter((name) => {
      return expected.indexOf(name) === -1 && reg[name] !== SOS_IDENTITY_STORAGE_CODE_VERSION;
    });
    if (mismatch.length || extraMismatch.length) {
      return {
        result: 'CODE_GENERATION_MISMATCH',
        page,
        mismatch: mismatch.concat(extraMismatch),
      };
    }
    return { result: 'CODE_GENERATION_OK', page };
  }

  async function storagePersistedState() {
    try {
      const storage = window.navigator && window.navigator.storage;
      if (!storage || typeof storage.persisted !== 'function') {
        return { ok: false, reason: 'STORAGE_NOT_PERSISTED' };
      }
      const value = await storage.persisted();
      if (value === true) return { ok: true };
      return { ok: false, reason: 'STORAGE_NOT_PERSISTED' };
    } catch (_e) {
      return { ok: false, reason: 'STORAGE_NOT_PERSISTED' };
    }
  }

  async function isBrowserCutoverEnvironmentSafe() {
    const reasons = [];
    const gen = verifyIdentityStorageCodeGeneration();
    if (gen.result !== 'CODE_GENERATION_OK') reasons.push(gen.result);
    if (!controllerAtBoot) reasons.push('NO_CONTROLLER_AT_BOOT');
    if (controllerChangedMidPage) reasons.push('CONTROLLER_CHANGED');
    if (isSessionOnly()) reasons.push('SESSION_ONLY');
    else if (nativeBridge()) reasons.push('ANDROID_NATIVE');
    else if (isUncapableNativeShell()) reasons.push('OLD_APK');
    else if (activeProviderName() !== PROVIDER_BROWSER_SECURE) reasons.push('NOT_BROWSER_SECURE');
    return { ok: reasons.length === 0, reasons };
  }

  function classifyBrowserIdentityFailure() {
    if (markerIndicatesSecureUser(readCutoverMarker())) return 'SECURE_MIGRATED_USER_WITH_PROVIDER_FAILURE';
    if (isHex64(readLegacyPlaintext())) return 'NEVER_MIGRATED_LEGACY_USER';
    return 'WEB_SECURE_NONE';
  }

  function refusePlaintextDowngrade() {
    const marker = readCutoverMarker();
    if (markerIndicatesSecureUser(marker)) {
      return { allowed: false, state: 'WEB_SECURE_RECOVERY_REQUIRED' };
    }
    return { allowed: true, state: 'NO_SECURE_MARKER' };
  }

  function canDeleteBrowserLegacySecret() {
    return false;
  }

  async function evaluateFutureBrowserLegacyDeleteEligibility() {
    const persisted = await storagePersistedState();
    const reasons = [];
    if (persisted.ok !== true) reasons.push('STORAGE_NOT_PERSISTED');
    if (BROWSER_SECURE_CUTOVER_DELETE_LEGACY !== true) reasons.push('DELETE_FLAG_FALSE');
    reasons.push('DESTRUCTIVE_CUTOVER_DISABLED');
    return {
      eligible: false,
      persistenceRequired: true,
      persisted: persisted.ok === true,
      reasons,
    };
  }

  async function evaluateBrowserSecureCutoverEligibility() {
    const env = await isBrowserCutoverEnvironmentSafe();
    const reasons = env.reasons.slice();
    const providerBlocked = reasons.indexOf('SESSION_ONLY') !== -1
      || reasons.indexOf('ANDROID_NATIVE') !== -1
      || reasons.indexOf('OLD_APK') !== -1
      || reasons.indexOf('NOT_BROWSER_SECURE') !== -1;
    if (providerBlocked || !browserSecureActivated) {
      return {
        eligible: false,
        state: 'WEB_SECURE_CUTOVER_NOT_ELIGIBLE',
        reasons,
        legacyDeleteAllowed: false,
      };
    }
    if (providerState === WEB_SECURE_MISMATCH) reasons.push('MISMATCH');
    if (providerState === WEB_SECURE_RECOVERY_REQUIRED) reasons.push('RECOVERY');
    if (providerState !== WEB_SECURE_COPY_VERIFIED) reasons.push('STATE_NOT_COPY_VERIFIED');
    if (window.NostrApp && window.NostrApp._accountSwitchInProgress) reasons.push('IDENTITY_TRANSITION');
    if (!browserSecureBootVerified) reasons.push('BOOT_NOT_VERIFIED');
    let secure = { ok: false };
    try {
      const wrap = await idbGet('wrapping_key', 'v1');
      if (!wrap) reasons.push('WRAP_KEY_MISSING');
      const blob = await idbGet('identity_blob', 'current');
      if (!blob) reasons.push('BLOB_MISSING');
      if (blob) {
        secure = await decryptIdentityBlob(blob);
        if (!secure.ok) reasons.push('DECRYPT_FAILED');
      }
    } catch (_e) {
      reasons.push('SECURE_READ_FAILED');
    }
    const legacyPair = isHex64(readLegacyPlaintext()) ? validatePair(readLegacyPlaintext(), null) : null;
    if (!legacyPair) reasons.push('LEGACY_MISSING');
    if (secure.ok && legacyPair && secure.priv !== legacyPair.priv) reasons.push('K_MISMATCH');
    if (secure.ok && legacyPair && secure.pub !== legacyPair.pub) reasons.push('P_MISMATCH');
    const marker = readCutoverMarker();
    if (marker && marker.publicKey && secure.ok && marker.publicKey !== secure.pub) reasons.push('MARKER_PUBKEY_MISMATCH');
    const unique = [];
    reasons.forEach((reason) => {
      if (unique.indexOf(reason) === -1) unique.push(reason);
    });
    const eligible = unique.length === 0;
    return {
      eligible,
      state: eligible ? 'WEB_SECURE_CUTOVER_ELIGIBLE' : 'WEB_SECURE_CUTOVER_BLOCKED',
      reasons: unique,
      legacyDeleteAllowed: false,
    };
  }

  async function markBrowserCutoverPendingIfEnabled() {
    if (BROWSER_SECURE_CUTOVER_PENDING !== true) {
      return { result: 'CUTOVER_DISABLED', mutated: false };
    }
    const existing = readCutoverMarker();
    if (
      existing
      && (existing.state === 'pending' || existing.state === 'verified')
      && existing.publicKey
      && existing.publicKey === memoryPub
      && existing.codeVersion === SOS_IDENTITY_STORAGE_CODE_VERSION
      && existing.pendingBootId
    ) {
      if (existing.state === 'pending') {
        try { console.log('WEB_SECURE_CUTOVER_PENDING_EXISTS'); } catch (_e) {}
        return { result: 'WEB_SECURE_CUTOVER_PENDING_EXISTS', mutated: false, pendingBootId: existing.pendingBootId };
      }
      return { result: 'WEB_SECURE_CUTOVER_VERIFIED', mutated: false, pendingBootId: existing.pendingBootId };
    }
    const elig = await evaluateBrowserSecureCutoverEligibility();
    if (!elig.eligible) {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=' + (elig.reasons[0] || 'NOT_ELIGIBLE')); } catch (_e2) {}
      return { result: 'WEB_SECURE_CUTOVER_BLOCKED', reasons: elig.reasons, mutated: false };
    }
    const fresh = await verifyFreshSecureReopen(memoryPub);
    if (fresh.result !== 'FRESH_SECURE_REOPEN_VERIFIED') {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=' + fresh.result); } catch (_e3) {}
      return { result: 'WEB_SECURE_CUTOVER_BLOCKED', reasons: [fresh.result], mutated: false };
    }
    const legacyBefore = readLegacyPlaintext();
    writeCutoverMarker({
      state: 'pending',
      publicKey: memoryPub,
      controllerMarker: controllerAtBoot ? 'controller-at-boot' : 'none',
      pendingAt: Date.now(),
      pendingBootId: currentBootId,
    });
    try { console.log('WEB_SECURE_CUTOVER_PENDING'); } catch (_e4) {}
    return {
      result: 'WEB_SECURE_CUTOVER_PENDING',
      mutated: true,
      legacyUnchanged: readLegacyPlaintext() === legacyBefore,
      legacyDeleteAllowed: canDeleteBrowserLegacySecret(),
      pendingBootId: currentBootId,
    };
  }

  async function verifyFreshSecureReopen(expectedPub) {
    try {
      const key = await idbGet('wrapping_key', 'v1');
      const blob = await idbGet('identity_blob', 'current');
      if (!key || !blob) return { result: 'FRESH_SECURE_REOPEN_FAILED' };
      const opened = await decryptIdentityBlob(blob);
      if (!opened.ok || !opened.pub) return { result: 'FRESH_SECURE_REOPEN_FAILED' };
      const expected = String(expectedPub || memoryPub || '').trim().toLowerCase();
      if (expected && opened.pub !== expected) return { result: 'FRESH_SECURE_REOPEN_MISMATCH' };
      return { result: 'FRESH_SECURE_REOPEN_VERIFIED' };
    } catch (_e) {
      return { result: 'FRESH_SECURE_REOPEN_FAILED' };
    }
  }

  async function evaluateBootNPlusOneCutover() {
    const marker = readCutoverMarker();
    const reasons = [];
    if (!marker || marker.state !== 'pending') reasons.push('NO_PENDING_MARKER');
    if (marker && marker.state === 'complete') reasons.push('COMPLETE_FORBIDDEN');
    if (!marker || !marker.pendingBootId) reasons.push('NO_PENDING_BOOT_ID');
    else if (marker.pendingBootId === currentBootId) reasons.push('SAME_BOOT');
    if (providerState === WEB_SECURE_MISMATCH) reasons.push('MISMATCH');
    if (providerState === WEB_SECURE_RECOVERY_REQUIRED) reasons.push('RECOVERY');
    if (window.NostrApp && window.NostrApp._accountSwitchInProgress) reasons.push('IDENTITY_TRANSITION');
    if (!browserSecureBootVerified) reasons.push('BOOT_NOT_VERIFIED');
    const fresh = await verifyFreshSecureReopen(marker && marker.publicKey);
    if (fresh.result !== 'FRESH_SECURE_REOPEN_VERIFIED') reasons.push(fresh.result);
    let secure = { ok: false };
    try { secure = await readSecureIdentity(); } catch (_e) { secure = { ok: false }; }
    if (!secure.ok) reasons.push(secure.corrupt ? 'DECRYPT_FAILED' : 'SECURE_READ_FAILED');
    if (marker && marker.publicKey && secure.ok && marker.publicKey !== secure.pub) reasons.push('MARKER_PUBKEY_MISMATCH');
    const legacyPair = isHex64(readLegacyPlaintext()) ? validatePair(readLegacyPlaintext(), null) : null;
    if (!legacyPair) reasons.push('LEGACY_UNEXPECTEDLY_ABSENT');
    else if (secure.ok && (secure.priv !== legacyPair.priv || secure.pub !== legacyPair.pub)) reasons.push('MISMATCH');
    const gen = verifyIdentityStorageCodeGeneration();
    if (gen.result !== 'CODE_GENERATION_OK') reasons.push(gen.result);
    if (marker && marker.codeVersion && marker.codeVersion !== SOS_IDENTITY_STORAGE_CODE_VERSION) {
      reasons.push('MARKER_CODE_MISMATCH');
    }
    if (!controllerAtBoot || controllerChangedMidPage) reasons.push('CONTROLLER_UNSAFE');
    const unique = [];
    reasons.forEach((reason) => {
      if (unique.indexOf(reason) === -1) unique.push(reason);
    });
    const legacyBefore = readLegacyPlaintext();
    if (unique.length) {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=' + unique[0]); } catch (_e2) {}
      return { state: 'WEB_SECURE_CUTOVER_BLOCKED', reasons: unique, legacyDeleteAllowed: false };
    }
    writeCutoverMarker({
      state: 'verified',
      publicKey: secure.pub,
      controllerMarker: marker.controllerMarker || 'controller-at-boot',
      pendingAt: marker.pendingAt,
      verifiedAt: Date.now(),
      pendingBootId: marker.pendingBootId,
    });
    try { console.log('WEB_SECURE_CUTOVER_VERIFIED'); } catch (_e3) {}
    return {
      state: 'WEB_SECURE_CUTOVER_VERIFIED',
      legacyDeleteAllowed: canDeleteBrowserLegacySecret(),
      legacyUnchanged: readLegacyPlaintext() === legacyBefore && isHex64(legacyBefore),
    };
  }

  async function runBrowserCutoverProgression() {
    if (BROWSER_SECURE_CUTOVER_PENDING !== true) return;
    if (isSessionOnly() || nativeBridge() || isUncapableNativeShell()) return;
    if (activeProviderName() !== PROVIDER_BROWSER_SECURE) return;
    const marker = readCutoverMarker();
    if (marker && marker.publicKey && memoryPub && marker.publicKey !== memoryPub) {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=MARKER_PUBKEY_MISMATCH'); } catch (_e) {}
      return;
    }
    if (
      marker
      && marker.state === 'verified'
      && marker.publicKey === memoryPub
      && marker.codeVersion === SOS_IDENTITY_STORAGE_CODE_VERSION
    ) {
      return;
    }
    if (marker && marker.state === 'complete') {
      try { console.log('WEB_SECURE_CUTOVER_BLOCKED reason=COMPLETE_FORBIDDEN'); } catch (_e2) {}
      return;
    }
    if (marker && marker.state === 'pending') {
      if (marker.pendingBootId && marker.pendingBootId !== currentBootId) {
        await evaluateBootNPlusOneCutover();
      }
      return;
    }
    await markBrowserCutoverPendingIfEnabled();
  }
  /* CUTOVER_I1_END */

  function enqueue(fn) {
    const next = Promise.resolve(initPromise).then(fn, fn);
    initPromise = next;
    window.SOSIdentityStorageReady = next;
    if (window.SOSKeyStorage) window.SOSKeyStorage.ready = next;
    return next;
  }

  function initialize() {
    if (initPromise) return initPromise;
    initCount += 1;
    initPromise = (async () => {
      if (isSessionOnly()) {
        providerState = WEB_SECURE_NONE;
        return { provider: PROVIDER_SESSION_ONLY, state: providerState };
      }
      if (nativeBridge()) {
        hydrateNative();
        return { provider: PROVIDER_NATIVE_SECURE, state: providerState };
      }
      if (isUncapableNativeShell() || !browserPrimitives()) {
        providerState = WEB_SECURE_UNAVAILABLE;
        browserSecureActivated = false;
        return { provider: PROVIDER_LEGACY, state: WEB_SECURE_UNAVAILABLE, reason: 'BROWSER_SECURE_UNAVAILABLE' };
      }
      try {
        await bootBrowserSecure();
        await runBrowserCutoverProgression();
        return { provider: activeProviderName(), state: providerState };
      } catch (_e) {
        browserSecureActivated = false;
        providerState = WEB_SECURE_UNAVAILABLE;
        return { provider: PROVIDER_LEGACY, state: WEB_SECURE_UNAVAILABLE, reason: 'BROWSER_SECURE_UNAVAILABLE' };
      }
    })();
    window.SOSIdentityStorageReady = initPromise;
    return initPromise;
  }

  function readPrivateKeyRaw() {
    try {
      const provider = activeProviderName();
      if (provider === PROVIDER_SESSION_ONLY) {
        return window.sessionStorage.getItem(SS) || '';
      }
      if (provider === PROVIDER_NATIVE_SECURE) {
        return hydrateNative();
      }
      if (provider === PROVIDER_BROWSER_SECURE) {
        if (providerState === WEB_SECURE_MISMATCH || providerState === WEB_SECURE_RECOVERY_REQUIRED) return '';
        return isHex64(memoryPriv) ? memoryPriv : '';
      }
      return readLegacyPlaintext() || window.sessionStorage.getItem(SS) || '';
    } catch (_e) {
      return '';
    }
  }

  function readPrivateKeyHex() {
    const raw = readPrivateKeyRaw();
    return isHex64(raw) ? raw.trim().toLowerCase() : '';
  }

  function writePrivateKeyRaw(str) {
    if (str == null || typeof str !== 'string') return false;
    try {
      const provider = activeProviderName();
      if (provider === PROVIDER_SESSION_ONLY) {
        window.sessionStorage.setItem(SS, str);
        try { window.localStorage.removeItem(LS); } catch (_e) {}
        memoryPriv = '';
        memoryPub = '';
        return true;
      }
      if (provider === PROVIDER_NATIVE_SECURE) {
        const ok = writeNativeSecure(str);
        if (!ok) return false;
        removeWebPlaintext();
        return true;
      }
      if (provider === PROVIDER_BROWSER_SECURE) {
        const pair = validatePair(str, null);
        if (!pair || !pair.pub) return false;
        if (providerState === WEB_SECURE_MISMATCH || providerState === WEB_SECURE_RECOVERY_REQUIRED) return false;
        memoryPriv = pair.priv;
        memoryPub = pair.pub;
        enqueue(() => writeBrowserVerified(pair.priv));
        return true;
      }
      window.localStorage.setItem(LS, str);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function writePrivateKeyHex(hex) {
    if (!isHex64(hex)) return false;
    return writePrivateKeyRaw(hex.trim().toLowerCase());
  }

  function clearPrivateKey() {
    memoryPriv = '';
    memoryPub = '';
    providerState = WEB_SECURE_NONE;
    browserSecureBootVerified = false;
    try {
      window.localStorage.removeItem(LS);
      window.sessionStorage.removeItem(SS);
      window.localStorage.removeItem(CUTOVER_MARKER_KEY);
    } catch (_e) {}
    if (!isSessionOnly()) {
      const bridge = nativeBridge();
      if (bridge && typeof bridge.clearUserSession === 'function') {
        try { bridge.clearUserSession(); } catch (_e2) {}
      }
    }
    if (browserSecureActivated) {
      enqueue(async () => {
        await deleteBrowserSecrets();
      });
    }
  }

  function getSecurityDesignNotes() {
    return {
      stage: '5E-E2B2B-I1',
      syncApi: true,
      asyncConversion: false,
      legacyDeletePerformed: false,
      browserSecureImplemented: true,
      legacyDeleteOnBrowser: false,
      browserLegacyDeletePerformed: browserLegacyDeletePerformed,
      browserSecureCutoverPending: BROWSER_SECURE_CUTOVER_PENDING,
      browserSecureCutoverDeleteLegacy: BROWSER_SECURE_CUTOVER_DELETE_LEGACY,
      legacyWriteDisabled: false,
      finalLegacyWriteDisablePoint: 'key-storage.js:writeBrowserVerified localStorage.setItem(nostr_private_key) after secure verify',
      aad: AAD_TEXT,
      sessionOnlyPolicy: 'SESSION_ONLY never writes durable Native Keystore, IndexedDB identity, or durable Web secure store',
      logoutWrappingKey: 'deleted with identity blob (option A)',
      aadDecision: 'Stable UTF-8 AAD SOS|browser-identity|v1. Not bound to URL, pubkey, or versionCode.',
      deployCacheRequirement: 'key-storage.js identity-storage-bootstrap.js auth-guard.js config.js keys.js app.js must ship in one service-worker cache generation',
      xssLimitation: 'Secure-at-rest does not equal XSS-proof; runtime JS can still see K',
      providers: [PROVIDER_LEGACY, PROVIDER_NATIVE_SECURE, PROVIDER_SESSION_ONLY, PROVIDER_BROWSER_SECURE],
      activeProvider: activeProviderName(),
      state: providerState,
    };
  }

  window.SOSKeyStorage = {
    readPrivateKeyRaw,
    readPrivateKeyHex,
    writePrivateKeyRaw,
    writePrivateKeyHex,
    clearPrivateKey,
    SESSION_ONLY_FLAG: FLAG,
    PROVIDER_LEGACY,
    PROVIDER_NATIVE_SECURE,
    PROVIDER_SESSION_ONLY,
    PROVIDER_BROWSER_SECURE,
    activeProviderName,
    isSessionOnly,
    getSecurityDesignNotes,
    getProviderState() { return providerState; },
    getPublicKeyHint() {
      if (memoryPub && /^[0-9a-f]{64}$/i.test(memoryPub)) return String(memoryPub).toLowerCase();
      try {
        const marker = readCutoverMarker();
        if (marker && marker.publicKey && /^[0-9a-f]{64}$/i.test(marker.publicKey)) {
          return String(marker.publicKey).toLowerCase();
        }
      } catch (_e) {}
      return '';
    },
    decideWebNativeSecure,
    initialize,
    ready: null,
    getInitCount() { return initCount; },
    WEB_SECURE_NONE,
    WEB_SECURE_LEGACY_ONLY,
    WEB_SECURE_COPYING,
    WEB_SECURE_COPY_VERIFIED,
    WEB_SECURE_ACTIVE,
    WEB_SECURE_MISMATCH,
    WEB_SECURE_RECOVERY_REQUIRED,
    WEB_SECURE_UNAVAILABLE,
    SOS_IDENTITY_STORAGE_CODE_VERSION,
    REQUIRED_IDENTITY_MODULES,
    IDENTITY_PAGE_MODULE_SETS,
    IDENTITY_STORAGE_DEPLOY_FILES,
    identityEntryPageName,
    expectedIdentityModulesForPage,
    verifyIdentityStorageCodeGeneration,
    evaluateBrowserSecureCutoverEligibility,
    isBrowserCutoverEnvironmentSafe,
    markBrowserCutoverPendingIfEnabled,
    canDeleteBrowserLegacySecret,
    evaluateFutureBrowserLegacyDeleteEligibility,
    verifyFreshSecureReopen,
    evaluateBootNPlusOneCutover,
    classifyBrowserIdentityFailure,
    refusePlaintextDowngrade,
    getCutoverFlags() {
      return {
        browserSecureCutoverPending: BROWSER_SECURE_CUTOVER_PENDING,
        browserSecureCutoverDeleteLegacy: BROWSER_SECURE_CUTOVER_DELETE_LEGACY,
        CUTOVER_PENDING_FLAG: BROWSER_SECURE_CUTOVER_PENDING === true,
        CUTOVER_DELETE_FLAG: BROWSER_SECURE_CUTOVER_DELETE_LEGACY === true,
        LEGACY_DELETE_ALLOWED: canDeleteBrowserLegacySecret(),
        BROWSER_LEGACY_WRITE_DISABLED: false,
        browserSecureBootVerified,
        controllerAtBoot,
        controllerChangedMidPage,
        currentBootId,
        codeVersion: SOS_IDENTITY_STORAGE_CODE_VERSION,
        storagePersistenceRequested,
        storagePersisted: storagePersistedObserved === true,
        browserLegacyDeletePerformed,
      };
    },
  };
  window.SOSKeyStorage.ready = initialize();
  window.SOSIdentityStorageReady = window.SOSKeyStorage.ready;
})(window);
