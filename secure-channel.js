;(function initSecureChannel(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const crypto = window.crypto || window.msCrypto;

  const COMMUNITY_KEY_STORAGE = 'nostr_community_key';
  const DERIVATION_SALT_STORAGE = 'nostr_community_salt';
  const DEFAULT_CONTEXT = 'yalacommunity';
  const ENCRYPTION_PREFIX = App.ENCRYPTION_PREFIX || 'enc.v1:';
  App.ENCRYPTION_PREFIX = ENCRYPTION_PREFIX;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function getDefaultSalt() {
    let storedSalt = window.localStorage.getItem(DERIVATION_SALT_STORAGE);
    if (storedSalt) {
      return Uint8Array.from(storedSalt.split('-').map(Number));
    }
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    storedSalt = Array.from(randomBytes).join('-');
    window.localStorage.setItem(DERIVATION_SALT_STORAGE, storedSalt);
    return randomBytes;
  }

  async function deriveKeyFromPassphrase(passphrase, context = DEFAULT_CONTEXT) {
    if (!passphrase) {
      throw new Error('Passphrase required for key derivation');
    }
    const pwdKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
      'deriveKey',
    ]);
    const salt = getDefaultSalt();
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      pwdKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function importCommunityKey(base64Key) {
    if (!base64Key) {
      throw new Error('Community key missing');
    }
    const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function exportCommunityKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    const bytes = new Uint8Array(raw);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function getStoredCommunityKey() {
    return window.localStorage.getItem(COMMUNITY_KEY_STORAGE) || '';
  }

  function setStoredCommunityKey(base64Key) {
    if (!base64Key) {
      window.localStorage.removeItem(COMMUNITY_KEY_STORAGE);
      return;
    }
    window.localStorage.setItem(COMMUNITY_KEY_STORAGE, base64Key);
  }

  function hasCommunityKey() {
    return Boolean(
      App.communityCryptoKey || getStoredCommunityKey() || App.communityKeyBase64 || App.communityPassphrase
    );
  }

  async function ensureCommunityKey() {
    if (App.communityCryptoKey) {
      return App.communityCryptoKey;
    }

    let stored = getStoredCommunityKey();
    if (!stored && App.communityKeyBase64) {
      stored = App.communityKeyBase64;
      setStoredCommunityKey(stored);
    }

    if (!stored && App.communityPassphrase) {
      await setCommunityKeyFromPassphrase(App.communityPassphrase);
      stored = getStoredCommunityKey();
    }

    if (!stored) {
      throw new Error('Community key not set');
    }

    const key = await importCommunityKey(stored);
    App.communityCryptoKey = key;
    return key;
  }

  async function setCommunityKeyFromBase64(base64Key, persist = true) {
    if (!base64Key) {
      throw new Error('Community key base64 missing');
    }
    const key = await importCommunityKey(base64Key);
    App.communityCryptoKey = key;
    App.communityKeyBase64 = base64Key;
    if (persist) {
      setStoredCommunityKey(base64Key);
    }
    return key;
  }

  async function setCommunityKeyFromPassphrase(passphrase) {
    if (!passphrase) {
      throw new Error('Community passphrase missing');
    }
    App.communityPassphrase = passphrase;
    const key = await deriveKeyFromPassphrase(passphrase, DEFAULT_CONTEXT);
    const base64 = await exportCommunityKey(key);
    setStoredCommunityKey(base64);
    App.communityCryptoKey = key;
    App.communityKeyBase64 = base64;
    return key;
  }

  async function encryptPayload(payload, header = {}) {
    const communityKey = await ensureCommunityKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const structured = {
      header,
      payload,
      timestamp: Date.now(),
    };
    const encoded = encoder.encode(JSON.stringify(structured));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      communityKey,
      encoded
    );
    const cipherBytes = new Uint8Array(ciphertext);
    const merged = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
    merged.set(iv, 0);
    merged.set(cipherBytes, iv.byteLength);
    let binary = '';
    for (let i = 0; i < merged.byteLength; i += 1) {
      binary += String.fromCharCode(merged[i]);
    }
    const base64 = btoa(binary);
    return `${ENCRYPTION_PREFIX}${base64}`;
  }

  async function decryptPayload(ciphertextInput) {
    const communityKey = await ensureCommunityKey();
    const normalized = ciphertextInput.startsWith(ENCRYPTION_PREFIX)
      ? ciphertextInput.slice(ENCRYPTION_PREFIX.length)
      : ciphertextInput;
    const merged = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
    const iv = merged.slice(0, 12);
    const ciphertext = merged.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      communityKey,
      ciphertext
    );
    const text = decoder.decode(decrypted);
    return JSON.parse(text);
  }

  async function loadCommunityKeyOrPrompt(passphrase) {
    if (!passphrase && getStoredCommunityKey()) {
      const key = await ensureCommunityKey();
      if (!App.communityKeyBase64) {
        App.communityKeyBase64 = getStoredCommunityKey();
      }
      return key;
    }
    const key = await deriveKeyFromPassphrase(passphrase || DEFAULT_CONTEXT);
    const base64 = await exportCommunityKey(key);
    setStoredCommunityKey(base64);
    App.communityCryptoKey = key;
    App.communityKeyBase64 = base64;
    return key;
  }

  function clearCommunityKey() {
    App.communityCryptoKey = null;
    window.localStorage.removeItem(COMMUNITY_KEY_STORAGE);
    App.communityKeyBase64 = '';
    App.communityPassphrase = '';
  }

  async function tryDecryptContent(content) {
    if (!content || !content.startsWith(ENCRYPTION_PREFIX)) {
      return { content, encrypted: false };
    }

    const base64 = content.slice(ENCRYPTION_PREFIX.length);

    try {
      const result = await decryptPayload(base64);
      const payload = result?.payload;
      let resolvedContent = '';
      if (typeof payload === 'string') {
        resolvedContent = payload;
      } else if (payload && typeof payload.content === 'string') {
        resolvedContent = payload.content;
      }
      return {
        content: resolvedContent,
        encrypted: true,
        meta: result,
      };
    } catch (err) {
      console.error('Failed to decrypt community content', err);
      return {
        content: '',
        encrypted: true,
        error: err,
      };
    }
  }

  Object.assign(App, {
    ensureCommunityKey,
    encryptPayload,
    decryptPayload,
    loadCommunityKeyOrPrompt,
    clearCommunityKey,
    setCommunityKeyFromPassphrase,
    setCommunityKeyFromBase64,
    hasCommunityKey,
    tryDecryptContent,
    getStoredCommunityKey,
    setStoredCommunityKey,
  });
})(window);
