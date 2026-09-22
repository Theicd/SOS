(function initKeys(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['keys.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};
  const { generateSecretKey, getPublicKey } = tools;
  const { bytesToHex, hexToBytes } = App;

  const IDENTITY_OK = 'IDENTITY_OK';
  const IDENTITY_NEW_USER = 'IDENTITY_NEW_USER';
  const IDENTITY_INVALID = 'IDENTITY_INVALID';
  const IDENTITY_RECOVERY_REQUIRED = 'IDENTITY_RECOVERY_REQUIRED';

  function persistNostrPrivateKey(key) {
    if (key == null) return;
    if (window.SOSKeyStorage && typeof window.SOSKeyStorage.writePrivateKeyRaw === 'function') {
      window.SOSKeyStorage.writePrivateKeyRaw(String(key));
    }
  }

  function loadStoredNostrPrivateKey() {
    if (window.SOSKeyStorage && typeof window.SOSKeyStorage.readPrivateKeyRaw === 'function') {
      return window.SOSKeyStorage.readPrivateKeyRaw() || '';
    }
    return '';
  }

  function isHex64(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim());
  }

  function hasNonEmptyRaw(value) {
    return value != null && String(value).trim().length > 0;
  }

  function setIdentityState(state) {
    App.identityState = state;
    try {
      console.log('IDENTITY_STATE state=' + state);
    } catch (_e) {}
    if (state === IDENTITY_INVALID || state === IDENTITY_RECOVERY_REQUIRED) {
      try {
        console.log('IDENTITY_RECOVERY_REQUIRED');
      } catch (_e2) {}
    }
    try {
      if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
    } catch (_syncUi) {}
  }

  function encodeBytesToHex(bytesLike) {
    const arr = bytesLike instanceof Uint8Array
      ? bytesLike
      : Uint8Array.from(bytesLike || []);
    if (arr.length !== 32) return null;
    if (typeof bytesToHex === 'function') {
      try {
        const out = bytesToHex(arr);
        if (typeof out === 'string' && /^[0-9a-fA-F]{64}$/.test(out)) return out;
      } catch (_e) {
        // fall through to manual encode
      }
    }
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Identity-preserving normalize only.
   * May rewrite storage ONLY when the result is the same 32-byte secret (e.g. case / 0x / legacy bytes).
   * Never writes on failure — corrupt storage stays untouched.
   */
  function normalizePrivateKey(storedKey, options) {
    const persist = !options || options.persist !== false;
    if (!storedKey) return null;
    let key = String(storedKey).trim();
    if (!key) return null;
    if (key.startsWith('0x') || key.startsWith('0X')) key = key.slice(2);

    if (key.includes(',')) {
      const bytes = key
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      if (bytes.length !== 32) return null;
      const encoded = encodeBytesToHex(bytes);
      if (!encoded) return null;
      key = encoded;
    }

    if (key.length !== 64 && typeof hexToBytes === 'function') {
      try {
        const bytes = hexToBytes(key);
        const encoded = encodeBytesToHex(bytes);
        if (!encoded) return null;
        key = encoded;
      } catch (err) {
        console.warn('Private key normalization failed', err);
        return null;
      }
    }

    if (!isHex64(key)) return null;
    key = key.toLowerCase();
    if (persist) persistNostrPrivateKey(key);
    return key;
  }

  function clearAppIdentityMemory() {
    App.privateKey = null;
    App.publicKey = null;
  }

  /**
   * Load/validate existing identity ONLY.
   * Never calls generateSecretKey / generateAndStoreKey / createNewIdentityExplicit.
   */
  function ensureKeys() {
    const rawMemory = App.privateKey;
    const rawStored = loadStoredNostrPrivateKey();
    const hadRaw = hasNonEmptyRaw(rawMemory) || hasNonEmptyRaw(rawStored);

    let privateKey = normalizePrivateKey(rawMemory, { persist: true });
    if (!privateKey && hasNonEmptyRaw(rawStored)) {
      privateKey = normalizePrivateKey(rawStored, { persist: true });
    }

    if (!privateKey) {
      clearAppIdentityMemory();
      if (hadRaw) {
        setIdentityState(IDENTITY_INVALID);
        return {
          ok: false,
          state: IDENTITY_INVALID,
          privateKey: null,
          publicKey: null,
        };
      }
      setIdentityState(IDENTITY_NEW_USER);
      return {
        ok: false,
        state: IDENTITY_NEW_USER,
        privateKey: null,
        publicKey: null,
      };
    }

    if (!isHex64(privateKey)) {
      clearAppIdentityMemory();
      setIdentityState(IDENTITY_INVALID);
      return {
        ok: false,
        state: IDENTITY_INVALID,
        privateKey: null,
        publicKey: null,
      };
    }

    privateKey = privateKey.toLowerCase();

    let publicKey;
    try {
      if (typeof getPublicKey !== 'function') {
        throw new Error('getPublicKey unavailable');
      }
      publicKey = getPublicKey(privateKey);
    } catch (err) {
      console.warn('Invalid private key detected; recovery required (no regeneration)', err);
      clearAppIdentityMemory();
      setIdentityState(IDENTITY_RECOVERY_REQUIRED);
      return {
        ok: false,
        state: IDENTITY_RECOVERY_REQUIRED,
        privateKey: null,
        publicKey: null,
      };
    }

    if (typeof publicKey === 'string') {
      publicKey = publicKey.toLowerCase();
    } else {
      clearAppIdentityMemory();
      setIdentityState(IDENTITY_RECOVERY_REQUIRED);
      return {
        ok: false,
        state: IDENTITY_RECOVERY_REQUIRED,
        privateKey: null,
        publicKey: null,
      };
    }

    App.privateKey = privateKey;
    App.publicKey = publicKey;
    setIdentityState(IDENTITY_OK);
    try {
      console.log('CALL_REQUIRED_IDENTITY_BOOTSTRAP ok=1 deferred=0');
    } catch (_e) {}
    return {
      ok: true,
      state: IDENTITY_OK,
      privateKey,
      publicKey,
    };
  }

  /**
   * Explicit new-account identity creation ONLY.
   * options.privateKeyHex: optional pre-generated K from confirmed create UI (backup step).
   */
  function createNewIdentityExplicit(options) {
    const opts = options && typeof options === 'object' ? options : {};
    let privateKey = null;

    if (opts.privateKeyHex != null && String(opts.privateKeyHex).trim()) {
      privateKey = normalizePrivateKey(opts.privateKeyHex, { persist: false });
      if (!privateKey) {
        setIdentityState(IDENTITY_INVALID);
        return {
          ok: false,
          state: IDENTITY_INVALID,
          privateKey: null,
          publicKey: null,
        };
      }
    } else {
      if (typeof generateSecretKey !== 'function') {
        throw new Error('generateSecretKey missing from NostrTools');
      }
      const generated = generateSecretKey();
      const normalized = bytesToHex
        ? bytesToHex(generated)
        : Array.from(generated)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
      privateKey = String(normalized).toLowerCase();
      if (!isHex64(privateKey)) {
        throw new Error('generated secret key invalid');
      }
    }

    persistNostrPrivateKey(privateKey);

    let publicKey;
    try {
      if (typeof getPublicKey !== 'function') {
        throw new Error('getPublicKey unavailable');
      }
      publicKey = getPublicKey(privateKey);
    } catch (err) {
      console.warn('Explicit create derive failed', err);
      setIdentityState(IDENTITY_RECOVERY_REQUIRED);
      return {
        ok: false,
        state: IDENTITY_RECOVERY_REQUIRED,
        privateKey: null,
        publicKey: null,
      };
    }

    if (typeof publicKey === 'string') {
      publicKey = publicKey.toLowerCase();
    } else {
      setIdentityState(IDENTITY_RECOVERY_REQUIRED);
      return {
        ok: false,
        state: IDENTITY_RECOVERY_REQUIRED,
        privateKey: null,
        publicKey: null,
      };
    }

    App.privateKey = privateKey;
    App.publicKey = publicKey;
    setIdentityState(IDENTITY_OK);
    try {
      console.log('IDENTITY_EXPLICIT_CREATE');
    } catch (_e) {}
    try {
      console.log('CALL_REQUIRED_IDENTITY_BOOTSTRAP ok=1 deferred=0');
    } catch (_e2) {}
    return {
      ok: true,
      state: IDENTITY_OK,
      privateKey,
      publicKey,
    };
  }

  /** Legacy name — explicit create only. Never call from ensureKeys. */
  function generateAndStoreKey() {
    const result = createNewIdentityExplicit();
    if (!result || !result.ok || !result.privateKey) {
      throw new Error('explicit identity create failed');
    }
    return result.privateKey;
  }

  /**
   * Canonical PRIVATE → derive PUBLIC pair validation.
   * Never mutates storage, never generates, never logs secrets.
   */
  function validateIdentityPair(privkey, expectedPubkey) {
    const normalized = normalizePrivateKey(privkey, { persist: false });
    if (!normalized) {
      return {
        ok: false,
        state: IDENTITY_INVALID,
        privateKey: null,
        publicKey: null,
      };
    }
    let publicKey;
    try {
      if (typeof getPublicKey !== 'function') {
        throw new Error('getPublicKey unavailable');
      }
      publicKey = getPublicKey(normalized);
    } catch (_err) {
      return {
        ok: false,
        state: IDENTITY_INVALID,
        privateKey: null,
        publicKey: null,
      };
    }
    if (typeof publicKey !== 'string' || !isHex64(publicKey)) {
      return {
        ok: false,
        state: IDENTITY_INVALID,
        privateKey: null,
        publicKey: null,
      };
    }
    publicKey = publicKey.toLowerCase();
    if (expectedPubkey != null && String(expectedPubkey).trim()) {
      const expected = String(expectedPubkey).trim().toLowerCase();
      if (!isHex64(expected) || expected !== publicKey) {
        return {
          ok: false,
          state: 'IDENTITY_MISMATCH',
          privateKey: normalized,
          publicKey,
        };
      }
    }
    return {
      ok: true,
      state: IDENTITY_OK,
      privateKey: normalized,
      publicKey,
    };
  }

  App.IDENTITY_OK = IDENTITY_OK;
  App.IDENTITY_NEW_USER = IDENTITY_NEW_USER;
  App.IDENTITY_INVALID = IDENTITY_INVALID;
  App.IDENTITY_RECOVERY_REQUIRED = IDENTITY_RECOVERY_REQUIRED;
  App.IDENTITY_MISMATCH = 'IDENTITY_MISMATCH';
  App.IDENTITY_WEB_ONLY = 'IDENTITY_WEB_ONLY';
  App.IDENTITY_NATIVE_ONLY = 'IDENTITY_NATIVE_ONLY';
  App.IDENTITY_NATIVE_INVALID = 'IDENTITY_NATIVE_INVALID';
  App.IDENTITY_WEB_INVALID = 'IDENTITY_WEB_INVALID';
  App.normalizePrivateKey = normalizePrivateKey;
  App.validateIdentityPair = validateIdentityPair;
  App.createNewIdentityExplicit = createNewIdentityExplicit;
  App.generateAndStoreKey = generateAndStoreKey;
  App.ensureKeys = ensureKeys;
  App.ensureExistingKeys = ensureKeys;
})(window);
