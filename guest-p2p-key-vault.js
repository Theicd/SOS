/**
 * AC0/AC8 — Guest P2P key authority.
 * Raw guest K stays in module closure (and AES-GCM sessionStorage blob for reload).
 * Never localStorage plaintext. No GET_GUEST_K / export. Not registered identity.
 * AC8: strict 30078 schema via GuestP2PSchema; boot purge of legacy LS only.
 * Same-origin XSS can still attack sessionStorage wrap material — F5B, not AC8.
 * AC8_CLAIMS_XSS_ISOLATION=false. Custody architecture unchanged (no Worker migration).
 */
(function initGuestP2PKeyVault(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const LEGACY_LS = 'p2p_guest_keys';
  const SESSION_BLOB = 'sos_guest_p2p_vault_v1';
  const SESSION_WRAP = 'sos_guest_p2p_wrap_v1';
  const AAD = 'SOS|guest-p2p|v1';

  // AC8: boot-time purge of ONLY legacy plaintext guest key entry (no registered storage).
  try {
    window.localStorage.removeItem(LEGACY_LS);
  } catch (_bootPurge) {}

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
    try {
      const S = App.GuestP2PSchema || window.SosGuestP2PSchema;
      if (S && typeof S.clearGuestReplayCache === 'function') S.clearGuestReplayCache();
    } catch (_e2) {}
    return { ok: true };
  }

  function assertGuestP2pDraft(draft) {
    const S = App.GuestP2PSchema || window.SosGuestP2PSchema;
    if (S && typeof S.assertGuest30078ForSign === 'function') {
      S.assertGuest30078ForSign(draft);
      return;
    }
    // Fail closed if schema module missing (AC8)
    throw Object.assign(new Error('GUEST_SCHEMA_UNAVAILABLE'), { code: 'GUEST_SCHEMA_UNAVAILABLE' });
  }

  async function signP2pEvent(draft) {
    await ensureReady();
    if (!privHex) throw Object.assign(new Error('GUEST_VAULT_EMPTY'), { code: 'GUEST_VAULT_EMPTY' });
    // AC8: GuestAccessControl public-signal capability (deny-by-default)
    try {
      const GAC = App.GuestAccessControl || window.SosGuestAccessControl;
      if (GAC && typeof GAC.canGuestAction === 'function' && !GAC.canGuestAction('P2P_SIGNAL_PUBLIC_30078')) {
        throw Object.assign(new Error('GUEST_CAPABILITY_DENIED'), { code: 'GUEST_CAPABILITY_DENIED' });
      }
      if (GAC && typeof GAC.canUseGroupP2P === 'function') {
        const gate = GAC.canUseGroupP2P(pubHex, { signalClass: 'PUBLIC_AVAILABILITY' });
        if (!gate || gate.ok !== true) {
          throw Object.assign(new Error((gate && gate.code) || 'GUEST_P2P_DENIED'), {
            code: (gate && gate.code) || 'GUEST_P2P_DENIED',
          });
        }
      }
    } catch (e) {
      if (e && e.code) throw e;
      throw e;
    }
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

  // --- AC8 typed exception: guest public-media file transfer (NIP-44, recipient-bound) ---
  // Signs / decrypts ONLY file-request / file-response / ice-candidate for a public media hash.
  // No generic private sign/encrypt; K never leaves this closure.
  const MEDIA_SIGNAL_D_PREFIX = 'sos-p2p-video:signal:';

  function mediaSchema() {
    const S = App.GuestP2PSchema || window.SosGuestP2PSchema;
    if (!S || typeof S.validateGuestMediaFileSignalMessage !== 'function' || typeof S.validateGuestMediaFileSignalEvent !== 'function') {
      throw Object.assign(new Error('GUEST_SCHEMA_UNAVAILABLE'), { code: 'GUEST_SCHEMA_UNAVAILABLE' });
    }
    return S;
  }

  function mediaNip44() {
    const nip44 = window.NostrTools && window.NostrTools.nip44;
    const v2 = nip44 && nip44.v2;
    const getKey = v2 && ((v2.utils && v2.utils.getConversationKey) || nip44.getConversationKey);
    if (!v2 || typeof v2.encrypt !== 'function' || typeof v2.decrypt !== 'function' || typeof getKey !== 'function') {
      throw Object.assign(new Error('NIP44_UNAVAILABLE'), { code: 'NIP44_UNAVAILABLE' });
    }
    return { v2, getKey };
  }

  function assertMediaTransferAllowed(recipient, type, networkTag) {
    const GAC = App.GuestAccessControl || window.SosGuestAccessControl;
    if (!GAC || typeof GAC.canUseGroupP2P !== 'function') {
      throw Object.assign(new Error('GUEST_ACCESS_UNAVAILABLE'), { code: 'GUEST_ACCESS_UNAVAILABLE' });
    }
    const gate = GAC.canUseGroupP2P(pubHex, {
      signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER',
      signalType: type,
      recipient,
      networkTag,
    });
    if (!gate || gate.ok !== true) {
      const code = (gate && gate.code) || 'GUEST_MEDIA_TRANSFER_DENIED';
      throw Object.assign(new Error(code), { code });
    }
  }

  function isPublicMediaFileTransferReady() {
    try {
      const S = App.GuestP2PSchema || window.SosGuestP2PSchema;
      const GAC = App.GuestAccessControl || window.SosGuestAccessControl;
      mediaNip44();
      return !!(privHex && pubHex && S && typeof S.validateGuestMediaFileSignalMessage === 'function'
        && GAC && typeof GAC.canGuestAction === 'function' && GAC.canGuestAction('P2P_FILE_TORRENT') === true
        && typeof GAC.classifyPrincipal === 'function' && GAC.classifyPrincipal(pubHex) === 'GUEST_P2P');
    } catch (_e) {
      return false;
    }
  }

  /** @returns {Promise<object>} signed kind-30078 event (NIP-44 envelope content) */
  async function signPublicMediaFileSignal(params) {
    await ensureReady();
    if (!privHex) throw Object.assign(new Error('GUEST_VAULT_EMPTY'), { code: 'GUEST_VAULT_EMPTY' });
    const p = params && typeof params === 'object' ? params : {};
    const recipient = String(p.recipient || '').trim().toLowerCase();
    const type = p.type;
    const S = mediaSchema();
    const networkTag = typeof S.resolveNetworkTag === 'function' ? S.resolveNetworkTag() : 'israel-network';
    if (!isHex64(recipient)) {
      throw Object.assign(new Error('GUEST_MEDIA_RECIPIENT_REQUIRED'), { code: 'GUEST_MEDIA_RECIPIENT_REQUIRED' });
    }
    if (recipient === pubHex) throw Object.assign(new Error('WRONG_RECIPIENT'), { code: 'WRONG_RECIPIENT' });
    assertMediaTransferAllowed(recipient, type, networkTag);
    let message;
    try {
      // RTCIceCandidate / RTCSessionDescription expose fields via toJSON, not own keys
      message = JSON.parse(JSON.stringify({ type, data: p.data }));
    } catch (_e) {
      throw Object.assign(new Error('MALFORMED_SIGNAL'), { code: 'MALFORMED_SIGNAL' });
    }
    const check = S.validateGuestMediaFileSignalMessage(message);
    if (!check || check.ok !== true) {
      const code = (check && check.code) || 'GUEST_MEDIA_SIGNAL_INVALID';
      throw Object.assign(new Error(code), { code });
    }
    const { v2, getKey } = mediaNip44();
    const ct = v2.encrypt(JSON.stringify(message), getKey(hexToBytes(privHex), recipient));
    const draft = {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', MEDIA_SIGNAL_D_PREFIX + Date.now() + ':' + Math.random().toString(36).slice(2, 8)],
        ['p', recipient],
        ['t', S.GUEST_MEDIA_SIGNAL_T_TAG[type]],
        ['enc', 'nip44'],
        ['guest', 'true'],
        ['network', networkTag],
      ],
      content: JSON.stringify({ family: 'sos-p2p-signal', v: 1, alg: 'nip44', ct }),
      pubkey: pubHex,
    };
    const shape = S.validateGuestMediaFileSignalEvent(draft, { direction: 'sign', networkTag, type, recipient, requireGuestTag: true });
    if (!shape || shape.ok !== true) {
      const code = (shape && shape.code) || 'GUEST_MEDIA_SIGNAL_INVALID';
      throw Object.assign(new Error(code), { code });
    }
    const NT = window.NostrTools;
    const finalize =
      (App.finalizeEvent && typeof App.finalizeEvent === 'function' && App.finalizeEvent.bind(App)) ||
      (NT && NT.finalizeEvent);
    if (typeof finalize !== 'function') {
      throw Object.assign(new Error('FINALIZE_UNAVAILABLE'), { code: 'FINALIZE_UNAVAILABLE' });
    }
    return finalize(draft, privHex);
  }

  /**
   * Decrypts an already signature/recipient/freshness-verified 30078 addressed to this guest.
   * Returns { type, data } only for public-media file-transfer types; everything else throws.
   */
  async function decryptPublicMediaFileSignal(event) {
    await ensureReady();
    if (!privHex) throw Object.assign(new Error('GUEST_VAULT_EMPTY'), { code: 'GUEST_VAULT_EMPTY' });
    const S = mediaSchema();
    const sender = String(event && event.pubkey || '').toLowerCase();
    if (!isHex64(sender) || sender === pubHex) throw Object.assign(new Error('BAD_SENDER'), { code: 'BAD_SENDER' });
    const verify = (App.strictVerifyNostrEvent && typeof App.strictVerifyNostrEvent === 'function' && App.strictVerifyNostrEvent)
      || (window.NostrEventIntegrity && window.NostrEventIntegrity.strictVerifyNostrEvent)
      || (window.NostrTools && window.NostrTools.verifyEvent);
    let sigOk = false;
    try {
      sigOk = typeof verify === 'function' && verify(JSON.parse(JSON.stringify(event))) === true;
    } catch (_e) {
      sigOk = false;
    }
    if (!sigOk) throw Object.assign(new Error('BAD_SIGNATURE'), { code: 'BAD_SIGNATURE' });
    const networkTag = typeof S.resolveNetworkTag === 'function' ? S.resolveNetworkTag() : 'israel-network';
    const shape = S.validateGuestMediaFileSignalEvent(event, { direction: 'receive', networkTag, recipient: pubHex });
    if (!shape || shape.ok !== true) {
      const code = (shape && shape.code) || 'GUEST_MEDIA_SIGNAL_INVALID';
      throw Object.assign(new Error(code), { code });
    }
    const env = JSON.parse(event.content);
    const { v2, getKey } = mediaNip44();
    let message;
    try {
      message = JSON.parse(v2.decrypt(env.ct, getKey(hexToBytes(privHex), sender)));
    } catch (_e) {
      throw Object.assign(new Error('GUEST_MEDIA_DECRYPT_FAILED'), { code: 'GUEST_MEDIA_DECRYPT_FAILED' });
    }
    const check = S.validateGuestMediaFileSignalMessage(message);
    if (!check || check.ok !== true) {
      const code = (check && check.code) || 'GUEST_MEDIA_SIGNAL_INVALID';
      throw Object.assign(new Error(code), { code });
    }
    if (S.GUEST_MEDIA_SIGNAL_T_TAG[message.type] !== shape.tTag) {
      throw Object.assign(new Error('T_TAG_TYPE_MISMATCH'), { code: 'T_TAG_TYPE_MISMATCH' });
    }
    assertMediaTransferAllowed(sender, message.type, networkTag);
    return { type: message.type, data: message.data };
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
    signPublicMediaFileSignal,
    decryptPublicMediaFileSignal,
    isPublicMediaFileTransferReady,
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
