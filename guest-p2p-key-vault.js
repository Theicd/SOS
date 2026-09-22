/**
 * AC0 — Guest P2P key authority.
 * Raw guest K stays in module closure (and AES-GCM sessionStorage blob for reload).
 * Never localStorage plaintext. No GET_GUEST_K / export. Not registered identity.
 * Same-origin XSS can still attack sessionStorage wrap material — documented honestly.
 */
(function initGuestP2PKeyVault(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const LEGACY_LS = 'p2p_guest_keys';
  const SESSION_BLOB = 'sos_guest_p2p_vault_v1';
  const SESSION_WRAP = 'sos_guest_p2p_wrap_v1';
  const AAD = 'SOS|guest-p2p|v1';

  /** @type {string} */
  let privHex = '';
  /** @type {string} */
  let pubHex = '';
  let readyPromise = null;

  function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBytes(hex) {
    const h = String(hex || '')
      .trim()
      .toLowerCase()
      .replace(/^0x/, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function fingerprint(pub) {
    const p = String(pub || '').toLowerCase();
    if (!isHex64(p)) return '';
    return p.slice(0, 8) + '…' + p.slice(-8);
  }

  function derivePub(priv) {
    const NT = window.NostrTools;
    if (!NT || typeof NT.getPublicKey !== 'function') throw new Error('NOSTR_TOOLS_MISSING');
    const pk = NT.getPublicKey(hexToBytes(priv));
    return String(pk).toLowerCase();
  }

  function generatePriv() {
    const NT = window.NostrTools;
    if (NT && typeof NT.generateSecretKey === 'function') {
      return bytesToHex(NT.generateSecretKey());
    }
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    return bytesToHex(a);
  }

  function aadBytes() {
    return new TextEncoder().encode(AAD);
  }

  async function importWrapKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function persistSession() {
    if (!privHex || !pubHex) return;
    const wrapRaw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importWrapKey(wrapRaw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadBytes() },
      key,
      new TextEncoder().encode(privHex)
    );
    try {
      window.sessionStorage.setItem(
        SESSION_BLOB,
        JSON.stringify({
          v: 1,
          iv: bytesToHex(iv),
          ct: bytesToHex(new Uint8Array(ct)),
          pub: pubHex,
          aad: AAD,
        })
      );
      window.sessionStorage.setItem(SESSION_WRAP, bytesToHex(wrapRaw));
    } catch (_e) {}
    wrapRaw.fill(0);
  }

  async function restoreSession() {
    try {
      const blobRaw = window.sessionStorage.getItem(SESSION_BLOB);
      const wrapHex = window.sessionStorage.getItem(SESSION_WRAP);
      if (!blobRaw || !wrapHex || !isHex64(wrapHex)) return false;
      const blob = JSON.parse(blobRaw);
      if (!blob || blob.v !== 1 || !blob.iv || !blob.ct || !isHex64(blob.pub)) return false;
      const key = await importWrapKey(hexToBytes(wrapHex));
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: hexToBytes(blob.iv),
          additionalData: aadBytes(),
        },
        key,
        hexToBytes(blob.ct)
      );
      const hex = new TextDecoder().decode(plain).trim().toLowerCase();
      if (!isHex64(hex)) return false;
      const derived = derivePub(hex);
      if (derived !== String(blob.pub).toLowerCase()) return false;
      privHex = hex;
      pubHex = derived;
      return true;
    } catch (_e) {
      return false;
    }
  }

  function purgeLegacyPlaintext() {
    try {
      window.localStorage.removeItem(LEGACY_LS);
    } catch (_e) {}
  }

  /**
   * One-shot migration from localStorage.p2p_guest_keys.
   * Prefer continuity; on failure generate fresh guest-only identity.
   * Never touches registered durable identity storage (LS).
   */
  async function migrateLegacyIfPresent() {
    let legacy = null;
    try {
      const raw = window.localStorage.getItem(LEGACY_LS);
      if (!raw) return { migrated: false };
      legacy = JSON.parse(raw);
    } catch (_e) {
      purgeLegacyPlaintext();
      return { migrated: false, purgedCorrupt: true };
    }
    try {
      const pk = legacy && typeof legacy.privateKey === 'string' ? legacy.privateKey.trim().toLowerCase() : '';
      if (!isHex64(pk)) {
        purgeLegacyPlaintext();
        return { migrated: false, purgedInvalid: true };
      }
      const derived = derivePub(pk);
      privHex = pk;
      pubHex = derived;
      await persistSession();
      purgeLegacyPlaintext();
      return { migrated: true, publicKey: pubHex };
    } catch (_e) {
      privHex = '';
      pubHex = '';
      purgeLegacyPlaintext();
      return { migrated: false, failed: true };
    }
  }

  async function ensureReady() {
    if (privHex && pubHex) return getMeta();
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (await restoreSession()) return getMeta();
      const mig = await migrateLegacyIfPresent();
      if (mig.migrated && privHex) return getMeta();
      privHex = generatePriv();
      pubHex = derivePub(privHex);
      await persistSession();
      purgeLegacyPlaintext();
      return getMeta();
    })().finally(() => {
      readyPromise = null;
    });
    return readyPromise;
  }

  function getMeta() {
    if (!pubHex) return { ready: false, isGuest: true, publicKey: '', fingerprint: '' };
    return {
      ready: true,
      isGuest: true,
      publicKey: pubHex,
      fingerprint: fingerprint(pubHex),
      guestIdentityClass: 'EPHEMERAL_GUEST',
    };
  }

  /** Sync meta after ensureReady — never returns private key */
  function getMetaSync() {
    return getMeta();
  }

  function clear() {
    privHex = '';
    pubHex = '';
    try {
      window.sessionStorage.removeItem(SESSION_BLOB);
      window.sessionStorage.removeItem(SESSION_WRAP);
    } catch (_e) {}
    purgeLegacyPlaintext();
    return { ok: true };
  }

  function assertGuestP2pDraft(draft) {
    if (!draft || typeof draft !== 'object') throw Object.assign(new Error('MALFORMED_DRAFT'), { code: 'MALFORMED_DRAFT' });
    if (draft.kind !== 30078) {
      throw Object.assign(new Error('KIND_NOT_ALLOWED'), { code: 'KIND_NOT_ALLOWED' });
    }
    if (typeof draft.content !== 'string') {
      throw Object.assign(new Error('BAD_CONTENT'), { code: 'BAD_CONTENT' });
    }
    if (!Array.isArray(draft.tags)) {
      throw Object.assign(new Error('BAD_TAGS'), { code: 'BAD_TAGS' });
    }
  }

  async function signP2pEvent(draft) {
    await ensureReady();
    if (!privHex) throw Object.assign(new Error('GUEST_VAULT_EMPTY'), { code: 'GUEST_VAULT_EMPTY' });
    assertGuestP2pDraft(draft);
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
      pubkey: pubHex,
    };
    const NT = window.NostrTools;
    const finalize =
      (App.finalizeEvent && typeof App.finalizeEvent === 'function' && App.finalizeEvent.bind(App)) ||
      (NT && NT.finalizeEvent);
    if (typeof finalize !== 'function') {
      throw Object.assign(new Error('FINALIZE_UNAVAILABLE'), { code: 'FINALIZE_UNAVAILABLE' });
    }
    return finalize(copy, privHex);
  }

  // Explicitly reject raw-key APIs
  function getPrivateKey() {
    throw Object.assign(new Error('GUEST_PAGE_CAN_REQUEST_RAW_K'), { code: 'GUEST_PAGE_CAN_REQUEST_RAW_K' });
  }
  function exportGuestK() {
    throw Object.assign(new Error('GUEST_PAGE_CAN_REQUEST_RAW_K'), { code: 'GUEST_PAGE_CAN_REQUEST_RAW_K' });
  }

  const api = {
    ensureReady,
    getMeta,
    getMetaSync,
    signP2pEvent,
    clear,
    purgeLegacyPlaintext,
    getPrivateKey,
    exportGuestK,
    LEGACY_LS_KEY: LEGACY_LS,
    SESSION_BLOB_KEY: SESSION_BLOB,
  };

  App.GuestP2PKeyVault = api;
  window.SosGuestP2PKeyVault = api;
})(window);
