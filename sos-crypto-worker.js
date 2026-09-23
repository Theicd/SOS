/**
 * SosCryptoWorker ג€” F2A browser Worker key vault (SHADOW only).
 * Loads K from IndexedDB sos_identity_secure inside Worker. Never returns K to page.
 * Authoritative signer remains main-thread SosCryptoSigner until F2B cutover.
 * HYPER CORE TECH
 */
/* eslint-disable no-restricted-globals */
(function initSosCryptoWorker(self) {
  'use strict';

  const BROWSER_DB = 'sos_identity_secure';
  const BROWSER_DB_VERSION = 1;
  const AAD_TEXT = 'SOS|browser-identity|v1';
  const MAX_CONTENT_CHARS = 256 * 1024;
  const MAX_CREATED_AT_SKEW_SEC = 172800;
  const MIN_CREATED_AT = 1_000_000_000;

  const OP_SPECS = {
    SIGN_CHAT_EVENT: { kinds: [1050], requireRecipientP: true },
    SIGN_PROFILE_EVENT: { kinds: [0] },
    SIGN_P2P_SIGNAL: { kinds: [25055], requireRecipientP: true },
    SIGN_P2P_FILE: { kinds: [30078] },
    SIGN_CALL_SEAL: { kinds: [13] },
    SIGN_CALL_GIFTWRAP: { kinds: [1059], requireRecipientP: true },
    SIGN_CALL_RUMOR_LEGACY: { kinds: [25050] },
    SIGN_READ_RECEIPT: { kinds: [1051], requireRecipientP: true },
    SIGN_PRESENCE: { kinds: [1054], requireRecipientP: true },
    SIGN_DELETE: { kinds: [5] },
    SIGN_FEED: { kinds: [1] },
    SIGN_REACTION: { kinds: [7] },
    SIGN_FOLLOW: { kinds: [40010] },
    SIGN_INVITE: { kinds: [37378, 37379] },
    SIGN_INVITE_REVOKE: { kinds: [37380] },
    SIGN_MODERATION_ACTION: { kinds: [39002] },
    // AC9: broad SIGN_MEMBERSHIP_STATE / SIGN_GROUP_CONTROL removed
    SIGN_EMAIL_REGISTRY: { kinds: [37377] },
    SIGN_BLOSSOM_AUTH: { kinds: [24242] },
    SIGN_DATING: { kinds: [40001] },
    SIGN_GAME: { kinds: [33051, 33052, 33201, 33202, 33203, 33211] },
    SIGN_LIVE: { kinds: [25051, 25056] },
    SIGN_LIVE_TV: { kinds: [30078] },
    SIGN_LOGIN_METRIC: { kinds: [1050] },
    SIGN_MEDIA_RECHECK: { kinds: [1] },
  };

  // AC9 shared policy (same-origin Worker)
  try {
    importScripts('./admin-signing-policy.js');
  } catch (_importErr) {
    // Policy may be missing in older caches; SIGN_ADMIN_TYPED will fail closed.
  }

  /** @type {'UNINITIALIZED'|'LOADING'|'READY'|'UNAVAILABLE'|'RECOVERY_REQUIRED'|'CRASHED'} */
  let vaultState = 'UNINITIALIZED';
  let sessionPrivHex = '';
  let sessionPubHex = '';
  let vaultGeneration = 0;
  let loadErrorCode = '';
  let NT = null;
  let chatE2eeReady = false;
  let createInFlight = false;
  let lastCreateNonce = '';

  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'SosCryptoWorkerError';
    throw err;
  }

  function aadBytes() {
    return new TextEncoder().encode(AAD_TEXT);
  }

  function isHex64(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());
  }

  function fingerprint(pub) {
    const p = String(pub || '').toLowerCase();
    if (!isHex64(p)) return '';
    return p.slice(0, 8) + 'ג€¦' + p.slice(-8);
  }

  function hexToBytes(hex) {
    const clean = String(hex || '')
      .trim()
      .toLowerCase()
      .replace(/^0x/, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return out;
  }

  function openDb() {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      return Promise.reject(Object.assign(new Error('IndexedDB unavailable'), { code: 'WORKER_VAULT_UNAVAILABLE' }));
    }
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(BROWSER_DB, BROWSER_DB_VERSION);
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
    });
  }

  function idbGet(storeName, key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).get(key);
          req.onsuccess = () => {
            try {
              db.close();
            } catch (_e) {}
            resolve(req.result);
          };
          req.onerror = () => {
            try {
              db.close();
            } catch (_e) {}
            reject(req.error || new Error('idb_get'));
          };
        }),
    );
  }

  function idbPut(storeName, key, value) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const req = tx.objectStore(storeName).put(value, key);
          req.onsuccess = () => {
            try {
              db.close();
            } catch (_e) {}
            resolve(true);
          };
          req.onerror = () => {
            try {
              db.close();
            } catch (_e) {}
            reject(req.error || new Error('idb_put'));
          };
        }),
    );
  }

  function idbDelete(storeName, key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).delete(key);
            req.onsuccess = () => {
              try {
                db.close();
              } catch (_e) {}
              resolve(true);
            };
            req.onerror = () => {
              try {
                db.close();
              } catch (_e) {}
              reject(req.error || new Error('idb_delete'));
            };
          } catch (err) {
            try {
              db.close();
            } catch (_e2) {}
            reject(err);
          }
        }),
    );
  }

  function bytesToHex(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let out = '';
    for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
    return out;
  }

  /**
   * F5A ג€” create durable browser identity entirely inside Worker.
   * Never returns K. Atomic: refuse if valid identity already exists.
   */
  async function createBrowserIdentity(params) {
    const nonce = params && typeof params.createNonce === 'string' ? params.createNonce.slice(0, 128) : '';
    if (createInFlight) fail('CREATE_IN_FLIGHT', 'create already in progress');
    createInFlight = true;
    try {
      loadNostrTools();
      if (vaultState === 'READY' && isHex64(sessionPrivHex) && isHex64(sessionPubHex)) {
        fail('CREATE_ALREADY_EXISTS', 'vault already has identity');
      }
      // Refuse silent second generation over a decryptable blob
      try {
        const existingBlob = await idbGet('identity_blob', 'current');
        if (existingBlob && existingBlob.version === 1 && existingBlob.iv && existingBlob.ciphertext) {
          const wrapExisting = await idbGet('wrapping_key', 'v1');
          if (wrapExisting) {
            try {
              const plain = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: existingBlob.iv, additionalData: aadBytes() },
                wrapExisting,
                existingBlob.ciphertext,
              );
              const priv = new TextDecoder().decode(plain).trim().toLowerCase();
              if (isHex64(priv)) {
                const derived = String(NT.getPublicKey(priv) || '')
                  .trim()
                  .toLowerCase();
                if (isHex64(derived)) {
                  fail('CREATE_ALREADY_EXISTS', 'secure identity already present');
                }
              }
            } catch (_dec) {
              // corrupt blob ג€” do not accept; require recovery, no silent overwrite
              vaultState = 'RECOVERY_REQUIRED';
              loadErrorCode = 'RECOVERY_REQUIRED';
              fail('RECOVERY_REQUIRED', 'corrupt identity present; create refused');
            }
          }
        }
      } catch (preErr) {
        if (preErr && preErr.code) throw preErr;
      }

      if (typeof NT.generateSecretKey !== 'function') {
        fail('CREATE_FAILED', 'generateSecretKey unavailable');
      }
      const sk = NT.generateSecretKey();
      const priv = bytesToHex(sk).toLowerCase();
      if (!isHex64(priv)) fail('CREATE_FAILED', 'generated key invalid');
      const pub = String(NT.getPublicKey(priv) || '')
        .trim()
        .toLowerCase();
      if (!isHex64(pub)) fail('CREATE_FAILED', 'pubkey derive failed');

      let wrap = await idbGet('wrapping_key', 'v1');
      if (!wrap) {
        wrap = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await idbPut('wrapping_key', 'v1', wrap);
        const wrapAgain = await idbGet('wrapping_key', 'v1');
        if (!wrapAgain) fail('CREATE_FAILED', 'wrapping key persist failed');
        wrap = wrapAgain;
      }

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aadBytes() },
        wrap,
        new TextEncoder().encode(priv),
      );
      const blob = {
        version: 1,
        iv,
        ciphertext,
        pubkey: pub,
        migratedAt: Date.now(),
        createdBy: 'CREATE_BROWSER_IDENTITY',
      };
      await idbPut('identity_blob', 'current', blob);
      try {
        await idbPut('metadata', 'provider', { identity_storage_provider: 'browser-secure-v1' });
      } catch (_e) {}

      // Reread + verify before accepting
      const wrap2 = await idbGet('wrapping_key', 'v1');
      const blob2 = await idbGet('identity_blob', 'current');
      if (!wrap2 || !blob2 || blob2.version !== 1) {
        try {
          await idbDelete('identity_blob', 'current');
        } catch (_d) {}
        fail('CREATE_VERIFY_FAILED', 'reread missing');
      }
      let plain2;
      try {
        plain2 = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: blob2.iv, additionalData: aadBytes() },
          wrap2,
          blob2.ciphertext,
        );
      } catch (_e2) {
        try {
          await idbDelete('identity_blob', 'current');
        } catch (_d2) {}
        fail('CREATE_VERIFY_FAILED', 'decrypt verify failed');
      }
      const priv2 = new TextDecoder().decode(plain2).trim().toLowerCase();
      const pub2 = String(NT.getPublicKey(priv2) || '')
        .trim()
        .toLowerCase();
      if (priv2 !== priv || pub2 !== pub || String(blob2.pubkey || '').toLowerCase() !== pub) {
        try {
          await idbDelete('identity_blob', 'current');
        } catch (_d3) {}
        fail('CREATE_VERIFY_FAILED', 'mismatch after write');
      }

      sessionPrivHex = priv2;
      sessionPubHex = pub2;
      vaultGeneration += 1;
      vaultState = 'READY';
      loadErrorCode = '';
      lastCreateNonce = nonce;
      const meta = identityMeta();
      meta.createNonce = nonce;
      meta.created = true;
      return meta;
    } finally {
      createInFlight = false;
    }
  }

  function loadNostrTools() {
    if (NT && typeof NT.finalizeEvent === 'function') return;
    if (typeof importScripts === 'function') {
      try {
        importScripts('./vendor/nostr.bundle.min.js');
      } catch (err) {
        fail('NOSTR_TOOLS_LOAD_FAILED', err && err.message ? err.message : 'importScripts failed');
      }
    }
    NT = self.NostrTools || globalThis.NostrTools;
    if (!NT || typeof NT.finalizeEvent !== 'function') {
      fail('NOSTR_TOOLS_UNAVAILABLE', 'NostrTools missing in worker');
    }
  }

  function ensureChatE2ee() {
    if (chatE2eeReady) return;
    loadNostrTools();
    self.NostrApp = self.NostrApp || {};
    self.NostrApp.hexToBytes = hexToBytes;
    self.NostrApp.inspectIncomingChatAttachment = function () {
      return { ok: true };
    };
    self.NostrApp.verifyIncomingChatAttachment = function () {
      return true;
    };
    self.NostrTools = NT;
    if (typeof importScripts === 'function') {
      try {
        importScripts('./chat-e2ee.js');
      } catch (_e) {
        /* optional for non-chat ops */
      }
    }
    chatE2eeReady = typeof self.NostrApp.encryptPrivateChatPayload === 'function';
  }

  async function loadVaultFromSecureIdb() {
    vaultState = 'LOADING';
    loadErrorCode = '';
    sessionPrivHex = '';
    sessionPubHex = '';
    try {
      loadNostrTools();
      const wrap = await idbGet('wrapping_key', 'v1');
      if (!wrap) {
        vaultState = 'UNAVAILABLE';
        loadErrorCode = 'WORKER_VAULT_UNAVAILABLE';
        fail('WORKER_VAULT_UNAVAILABLE', 'missing wrapping_key');
      }
      const blob = await idbGet('identity_blob', 'current');
      if (!blob) {
        vaultState = 'UNAVAILABLE';
        loadErrorCode = 'WORKER_VAULT_UNAVAILABLE';
        fail('WORKER_VAULT_UNAVAILABLE', 'missing identity_blob');
      }
      if (!blob || blob.version !== 1 || !blob.iv || !blob.ciphertext) {
        vaultState = 'RECOVERY_REQUIRED';
        loadErrorCode = 'RECOVERY_REQUIRED';
        fail('RECOVERY_REQUIRED', 'corrupt identity_blob');
      }
      let plain;
      try {
        plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: blob.iv, additionalData: aadBytes() },
          wrap,
          blob.ciphertext,
        );
      } catch (_e) {
        vaultState = 'RECOVERY_REQUIRED';
        loadErrorCode = 'RECOVERY_REQUIRED';
        fail('RECOVERY_REQUIRED', 'AES-GCM authentication failure');
      }
      const priv = new TextDecoder().decode(plain).trim().toLowerCase();
      if (!isHex64(priv)) {
        vaultState = 'RECOVERY_REQUIRED';
        loadErrorCode = 'RECOVERY_REQUIRED';
        fail('RECOVERY_REQUIRED', 'decrypted key invalid');
      }
      const derived = String(NT.getPublicKey(priv) || '')
        .trim()
        .toLowerCase();
      const persisted = String(blob.pubkey || '')
        .trim()
        .toLowerCase();
      if (!isHex64(derived)) {
        vaultState = 'RECOVERY_REQUIRED';
        loadErrorCode = 'RECOVERY_REQUIRED';
        fail('RECOVERY_REQUIRED', 'pubkey derive failed');
      }
      if (persisted && persisted !== derived) {
        vaultState = 'RECOVERY_REQUIRED';
        loadErrorCode = 'RECOVERY_REQUIRED';
        fail('RECOVERY_REQUIRED', 'stored pubkey mismatch');
      }
      sessionPrivHex = priv;
      sessionPubHex = derived;
      vaultGeneration += 1;
      vaultState = 'READY';
      return identityMeta();
    } catch (err) {
      if (vaultState === 'LOADING') {
        vaultState = err && err.code === 'WORKER_VAULT_UNAVAILABLE' ? 'UNAVAILABLE' : 'RECOVERY_REQUIRED';
        loadErrorCode = (err && err.code) || 'RECOVERY_REQUIRED';
      }
      throw err;
    }
  }

  function identityMeta() {
    return {
      pubkey: sessionPubHex,
      fingerprint: fingerprint(sessionPubHex),
      vaultState,
      generation: vaultGeneration,
      loadErrorCode: loadErrorCode || null,
    };
  }

  function requireReady() {
    if (vaultState !== 'READY' || !isHex64(sessionPrivHex) || !isHex64(sessionPubHex)) {
      fail(loadErrorCode || 'WORKER_VAULT_UNAVAILABLE', 'vault not ready');
    }
  }

  function findPTag(tags) {
    if (!Array.isArray(tags)) return '';
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'p' && typeof t[1] === 'string') return t[1].toLowerCase();
    }
    return '';
  }

  function validateDraft(op, draft) {
    const spec = OP_SPECS[op];
    if (!spec) fail('UNKNOWN_OP', 'unsupported operation: ' + op);
    if (!draft || typeof draft !== 'object') fail('MALFORMED_DRAFT', 'draft required');
    if (typeof draft.kind !== 'number' || !Number.isInteger(draft.kind)) fail('BAD_KIND', 'draft.kind must be integer');
    if (spec.kinds.indexOf(draft.kind) === -1) fail('KIND_NOT_ALLOWED', 'kind not allowed for ' + op);
    if (typeof draft.content !== 'string') fail('BAD_CONTENT', 'content must be string');
    if (draft.content.length > MAX_CONTENT_CHARS) fail('CONTENT_TOO_LARGE', 'content exceeds limit');
    if (!Array.isArray(draft.tags)) fail('BAD_TAGS', 'tags must be array');
    const now = Math.floor(Date.now() / 1000);
    if (typeof draft.created_at !== 'number' || !Number.isInteger(draft.created_at)) {
      fail('BAD_CREATED_AT', 'created_at must be integer');
    }
    if (draft.created_at < MIN_CREATED_AT || draft.created_at > now + MAX_CREATED_AT_SKEW_SEC) {
      fail('BAD_CREATED_AT_WINDOW', 'created_at out of allowed window');
    }
    if (draft.pubkey != null && String(draft.pubkey).toLowerCase() !== sessionPubHex) {
      fail('SENDER_MISMATCH', 'draft.pubkey must match vault identity');
    }
    if (spec.requireRecipientP) {
      const p = findPTag(draft.tags);
      if (!p || !isHex64(p)) fail('MISSING_RECIPIENT', 'p tag required');
    }
    return spec;
  }

  function signTyped(op, draft) {
    requireReady();
    validateDraft(op, draft);
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
      pubkey: draft.pubkey || sessionPubHex,
    };
    return NT.finalizeEvent(copy, sessionPrivHex);
  }

  function signAdminTyped(request) {
    requireReady();
    loadNostrTools();
    const P = self.SosAdminSigningPolicy;
    if (!P) fail('ADMIN_POLICY_MISSING', 'AdminSigningPolicy not loaded in worker');
    const op = P.validateRequestEnvelope(request || {});
    const actor = sessionPubHex;
    function verifyEv(ev) {
      if (!ev || typeof ev !== 'object') return false;
      try {
        return NT.verifyEvent(ev) === true;
      } catch (_e) {
        return false;
      }
    }
    let draft;
    if (P.isControlOp(op)) {
      let baseRecord = null;
      if (op !== P.ADMIN_OP.BOOTSTRAP_GROUP_CONTROL) {
        if (!verifyEv(request.baseEvent)) fail('BASE_VERIFY_FAILED');
        baseRecord = P.parseControlRecordFromEvent(request.baseEvent);
      }
      const groupId = P.resolveNetworkTag(request && request.groupId, baseRecord);
      if (baseRecord && baseRecord.groupId !== groupId) fail('CROSS_GROUP');
      const next = P.applyControlOperation(op, baseRecord, actor, Object.assign({}, request, { groupId }));
      draft = P.buildControlDraft(next, actor);
    } else if (P.isMemberOp(op)) {
      if (!verifyEv(request.baseEvent)) fail('BASE_VERIFY_FAILED');
      const baseControl = P.parseControlRecordFromEvent(request.baseEvent);
      const groupId = P.resolveNetworkTag(request && request.groupId, baseControl);
      if (baseControl.groupId !== groupId) fail('CROSS_GROUP');
      let tipBody = null;
      if (request.memberTipEvent) {
        if (!verifyEv(request.memberTipEvent)) fail('MEMBER_TIP_VERIFY_FAILED');
        try {
          tipBody = JSON.parse(request.memberTipEvent.content);
        } catch (_e) {
          fail('BAD_MEMBER_TIP');
        }
      }
      const body = P.applyMembershipOperation(
        op,
        baseControl,
        tipBody,
        actor,
        Object.assign({}, request, { groupId })
      );
      draft = P.buildMembershipDraft(body);
    } else {
      fail('UNKNOWN_OP');
    }
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
      pubkey: actor,
    };
    return NT.finalizeEvent(copy, sessionPrivHex);
  }

  function getNip44() {
    loadNostrTools();
    const nip44 = NT.nip44;
    if (!nip44 || !nip44.v2 || typeof nip44.v2.encrypt !== 'function') fail('NIP44_UNAVAILABLE', 'nip44.v2 missing');
    const getConversationKey =
      (nip44.v2.utils && nip44.v2.utils.getConversationKey) || nip44.getConversationKey;
    if (typeof getConversationKey !== 'function') fail('NIP44_UNAVAILABLE', 'getConversationKey missing');
    return {
      encrypt: nip44.v2.encrypt.bind(nip44.v2),
      decrypt: nip44.v2.decrypt.bind(nip44.v2),
      getConversationKey,
    };
  }

  function nip44P2pEncrypt(plaintext, recipientPubkey) {
    requireReady();
    const recipient = String(recipientPubkey || '').toLowerCase();
    if (!isHex64(recipient)) fail('BAD_RECIPIENT', 'invalid recipient');
    if (typeof plaintext !== 'string') fail('BAD_PLAINTEXT', 'plaintext must be string');
    const nip44 = getNip44();
    return nip44.encrypt(plaintext, nip44.getConversationKey(hexToBytes(sessionPrivHex), recipient));
  }

  function nip44P2pDecrypt(ciphertext, senderPubkey) {
    requireReady();
    const sender = String(senderPubkey || '').toLowerCase();
    if (!isHex64(sender)) fail('BAD_SENDER', 'invalid sender');
    if (typeof ciphertext !== 'string' || !ciphertext) fail('BAD_CIPHERTEXT', 'ciphertext required');
    const nip44 = getNip44();
    return nip44.decrypt(ciphertext, nip44.getConversationKey(hexToBytes(sessionPrivHex), sender));
  }

  function nip44ChatEncrypt(args) {
    requireReady();
    ensureChatE2ee();
    if (!chatE2eeReady) fail('CHAT_E2EE_UNAVAILABLE', 'chat-e2ee missing in worker');
    return self.NostrApp.encryptPrivateChatPayload({
      senderPrivateKeyHex: sessionPrivHex,
      senderPubkey: args && args.senderPubkey,
      recipientPubkey: args && args.recipientPubkey,
      payload: args && args.payload,
    });
  }

  function nip44ChatDecrypt(args) {
    requireReady();
    ensureChatE2ee();
    if (!chatE2eeReady) fail('CHAT_E2EE_UNAVAILABLE', 'chat-e2ee missing in worker');
    return self.NostrApp.decryptPrivateChatPayload({
      localPrivateKeyHex: sessionPrivHex,
      localPubkey: args && args.localPubkey,
      eventAuthorPubkey: args && args.eventAuthorPubkey,
      encryptedEnvelope: args && args.encryptedEnvelope,
      selfAuthored: args && args.selfAuthored,
      intendedRecipientPubkey: args && args.intendedRecipientPubkey,
    });
  }

  async function nip04Encrypt(peerPubkey, plaintext) {
    requireReady();
    loadNostrTools();
    if (!NT.nip04 || typeof NT.nip04.encrypt !== 'function') fail('NIP04_UNAVAILABLE', 'nip04.encrypt missing');
    return NT.nip04.encrypt(sessionPrivHex, peerPubkey, plaintext);
  }

  async function nip04Decrypt(peerPubkey, ciphertext) {
    requireReady();
    loadNostrTools();
    if (!NT.nip04 || typeof NT.nip04.decrypt !== 'function') fail('NIP04_UNAVAILABLE', 'nip04.decrypt missing');
    return NT.nip04.decrypt(sessionPrivHex, peerPubkey, ciphertext);
  }

  function assertNoKeyLeak(payload) {
    const forbidden = [
      'privateKey',
      'privkey',
      'nsec',
      'rawKey',
      'sessionPriv',
      'senderPrivateKey',
      'localPrivateKey',
      'exportKey',
      'getPrivateKey',
    ];
    const s = JSON.stringify(payload);
    for (let i = 0; i < forbidden.length; i++) {
      if (s.indexOf(forbidden[i]) !== -1) fail('WORKER_KEY_LEAK_BLOCKED', 'response blocked');
    }
    if (sessionPrivHex && s.indexOf(sessionPrivHex) !== -1) fail('WORKER_KEY_LEAK_BLOCKED', 'K in response');
  }

  function rejectBannedOps(op) {
    const banned = [
      'SIGN_RAW',
      'SIGN_ANY',
      'DECRYPT_ANY',
      'GET_KEY',
      'GET_K',
      'EXPORT_KEY',
      'EXPORT_RAW_K',
      'READ_PRIVATE_KEY',
      'RUN_ARBITRARY_CRYPTO',
      'signRaw',
      'signAnything',
      'decryptAnything',
      'getPrivateKey',
      'exportRawKey',
      'readPrivateKey',
    ];
    if (banned.indexOf(op) !== -1) fail('UNKNOWN_OP', 'banned operation');
  }

  async function dispatch(op, params) {
    rejectBannedOps(op);
    switch (op) {
      case 'VAULT_INIT':
        return loadVaultFromSecureIdb();
      case 'GET_IDENTITY_META':
        return identityMeta();
      case 'CREATE_BROWSER_IDENTITY':
        return createBrowserIdentity(params || {});
      case 'SIGN_CHAT_EVENT':
        return signTyped('SIGN_CHAT_EVENT', params && params.draft);
      case 'SIGN_PROFILE_EVENT':
        return signTyped('SIGN_PROFILE_EVENT', params && params.draft);
      case 'SIGN_P2P_SIGNAL':
        return signTyped('SIGN_P2P_SIGNAL', params && params.draft);
      case 'SIGN_P2P_FILE':
        return signTyped('SIGN_P2P_FILE', params && params.draft);
      case 'SIGN_CALL_SEAL':
        return signTyped('SIGN_CALL_SEAL', params && params.draft);
      case 'SIGN_CALL_GIFTWRAP':
        return signTyped('SIGN_CALL_GIFTWRAP', params && params.draft);
      case 'SIGN_CALL_RUMOR_LEGACY':
        return signTyped('SIGN_CALL_RUMOR_LEGACY', params && params.draft);
      case 'SIGN_READ_RECEIPT':
        return signTyped('SIGN_READ_RECEIPT', params && params.draft);
      case 'SIGN_PRESENCE':
        return signTyped('SIGN_PRESENCE', params && params.draft);
      case 'SIGN_DELETE':
        return signTyped('SIGN_DELETE', params && params.draft);
      case 'SIGN_FEED':
        return signTyped('SIGN_FEED', params && params.draft);
      case 'SIGN_REACTION':
        return signTyped('SIGN_REACTION', params && params.draft);
      case 'SIGN_FOLLOW':
        return signTyped('SIGN_FOLLOW', params && params.draft);
      case 'SIGN_INVITE':
        return signTyped('SIGN_INVITE', params && params.draft);
      case 'SIGN_INVITE_REVOKE':
        return signTyped('SIGN_INVITE_REVOKE', params && params.draft);
      case 'SIGN_MODERATION_ACTION':
        return signTyped('SIGN_MODERATION_ACTION', params && params.draft);
      case 'SIGN_MEMBERSHIP_STATE':
        fail('BROAD_ADMIN_SIGN_REMOVED', 'Use SIGN_ADMIN_TYPED');
        return null;
      case 'SIGN_GROUP_CONTROL':
        fail('BROAD_ADMIN_SIGN_REMOVED', 'Use SIGN_ADMIN_TYPED');
        return null;
      case 'SIGN_ADMIN_TYPED':
        return signAdminTyped(params && params.request);
      case 'SIGN_EMAIL_REGISTRY':
        return signTyped('SIGN_EMAIL_REGISTRY', params && params.draft);
      case 'SIGN_BLOSSOM_AUTH':
        return signTyped('SIGN_BLOSSOM_AUTH', params && params.draft);
      case 'SIGN_DATING':
        return signTyped('SIGN_DATING', params && params.draft);
      case 'SIGN_GAME':
        return signTyped('SIGN_GAME', params && params.draft);
      case 'SIGN_LIVE':
        return signTyped('SIGN_LIVE', params && params.draft);
      case 'SIGN_LIVE_TV':
        return signTyped('SIGN_LIVE_TV', params && params.draft);
      case 'SIGN_LOGIN_METRIC':
        return signTyped('SIGN_LOGIN_METRIC', params && params.draft);
      case 'SIGN_MEDIA_RECHECK':
        return signTyped('SIGN_MEDIA_RECHECK', params && params.draft);
      case 'NIP44_CHAT_ENCRYPT':
        return nip44ChatEncrypt(params);
      case 'NIP44_CHAT_DECRYPT':
        return nip44ChatDecrypt(params);
      case 'NIP44_P2P_ENCRYPT':
        return nip44P2pEncrypt(params && params.plaintext, params && params.recipientPubkey);
      case 'NIP44_P2P_DECRYPT':
        return nip44P2pDecrypt(params && params.ciphertext, params && params.senderPubkey);
      case 'NIP44_CALL_ENCRYPT':
        return nip44P2pEncrypt(JSON.stringify(params && params.obj), params && params.recipientPubkey);
      case 'NIP44_CALL_DECRYPT':
        return nip44P2pDecrypt(params && params.ciphertext, params && params.senderPubkey);
      case 'FILE_KEY_WRAP':
        return nip44P2pEncrypt(params && params.keyMaterial, params && params.recipientPubkey);
      case 'FILE_KEY_UNWRAP':
        return nip44P2pDecrypt(params && params.ciphertext, params && params.senderPubkey);
      case 'NIP04_ENCRYPT':
        return nip04Encrypt(params && params.peerPubkey, params && params.plaintext);
      case 'NIP04_DECRYPT':
        return nip04Decrypt(params && params.peerPubkey, params && params.ciphertext);
      case 'CALL_UNWRAP_GIFTWRAP':
        return unwrapCallGiftwrap(params && params.wrapEvent, params && params.localPubkey);
      default:
        fail('UNKNOWN_OP', 'unsupported operation: ' + op);
    }
  }

  function verifyEventLocal(ev) {
    try {
      if (NT && typeof NT.verifyEvent === 'function') return NT.verifyEvent(ev) === true;
    } catch (_e) {}
    return false;
  }

  function nip44DecryptJsonEvent(eventLike) {
    requireReady();
    const nip44 = getNip44();
    if (!eventLike || typeof eventLike.content !== 'string' || !eventLike.pubkey) {
      fail('CALL_UNWRAP_FAILED', 'bad decrypt target');
    }
    const sender = String(eventLike.pubkey).toLowerCase();
    const conversationKey = nip44.getConversationKey(hexToBytes(sessionPrivHex), sender);
    const plain = nip44.decrypt(eventLike.content, conversationKey);
    return JSON.parse(plain);
  }

  function unwrapCallGiftwrap(wrapEvent, localPubkey) {
    requireReady();
    const self = String(localPubkey || sessionPubHex).toLowerCase();
    if (!isHex64(self) || self !== sessionPubHex) fail('CALL_UNWRAP_FAILED', 'local pubkey mismatch');
    if (!wrapEvent || wrapEvent.kind !== 1059) fail('CALL_UNWRAP_FAILED', 'not wrap');
    if (!verifyEventLocal(wrapEvent)) fail('CALL_UNWRAP_FAILED', 'bad wrap sig');
    const p = findPTag(wrapEvent.tags);
    if (p !== self) fail('CALL_UNWRAP_FAILED', 'p tag mismatch');
    let seal;
    try {
      seal = nip44DecryptJsonEvent(wrapEvent);
    } catch (_e) {
      fail('CALL_UNWRAP_FAILED', 'wrap decrypt failed');
    }
    if (!seal || seal.kind !== 13) fail('CALL_UNWRAP_FAILED', 'bad seal');
    if (!verifyEventLocal(seal)) fail('CALL_UNWRAP_FAILED', 'bad seal sig');
    let rumor;
    try {
      rumor = nip44DecryptJsonEvent(seal);
    } catch (_e) {
      fail('CALL_UNWRAP_FAILED', 'seal decrypt failed');
    }
    if (!rumor || rumor.kind !== 25050) fail('CALL_UNWRAP_FAILED', 'bad rumor');
    if (String(rumor.pubkey || '').toLowerCase() !== String(seal.pubkey || '').toLowerCase()) {
      fail('CALL_UNWRAP_FAILED', 'rumor/seal pubkey mismatch');
    }
    let payload;
    try {
      payload = typeof rumor.content === 'string' ? JSON.parse(rumor.content) : rumor.content;
    } catch (_e) {
      fail('CALL_UNWRAP_FAILED', 'payload JSON');
    }
    // Return logical signal only ג€” never K / conversation secrets.
    return {
      media: payload && payload.media,
      action: payload && payload.action,
      data: payload && payload.data,
      sender: payload && payload.sender,
      recipient: payload && payload.recipient,
      sessionId: payload && payload.sessionId,
      signalId: payload && payload.signalId,
      sentAt: payload && payload.sentAt,
      family: payload && payload.family,
      v: payload && payload.v,
      wrapId: wrapEvent.id,
      sealPubkey: seal.pubkey,
    };
  }

  self.onmessage = function onWorkerMessage(ev) {
    const msg = ev && ev.data;
    const id = msg && msg.id;
    const op = msg && msg.op;
    const params = (msg && msg.params) || {};
    const t0 = Date.now();

    // Refuse any inbound attempt to inject raw K.
    if (
      params.privateKey != null ||
      params.privkey != null ||
      params.nsec != null ||
      params.rawKey != null ||
      params.senderPrivateKey != null ||
      params.localPrivateKeyHex != null ||
      params.sessionKey != null
    ) {
      self.postMessage({
        id,
        ok: false,
        error: { code: 'WORKER_REJECTS_PAGE_K', message: 'page must not send K' },
        durationMs: Date.now() - t0,
      });
      return;
    }

    Promise.resolve()
      .then(() => dispatch(op, params))
      .then((result) => {
        assertNoKeyLeak(result);
        self.postMessage({
          id,
          ok: true,
          result,
          durationMs: Date.now() - t0,
          fingerprint: fingerprint(sessionPubHex),
          vaultState,
        });
      })
      .catch((err) => {
        self.postMessage({
          id,
          ok: false,
          error: {
            code: (err && err.code) || 'WORKER_ERROR',
            message: err && err.message ? String(err.message).slice(0, 200) : 'error',
          },
          durationMs: Date.now() - t0,
          vaultState,
        });
      });
  };

  // Node/QA harness: export handlers without Worker globals.
  if (typeof self.__SOS_CRYPTO_WORKER_TEST_HOOKS === 'object') {
    self.__SOS_CRYPTO_WORKER_TEST_HOOKS.dispatch = dispatch;
    self.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb = loadVaultFromSecureIdb;
    self.__SOS_CRYPTO_WORKER_TEST_HOOKS.identityMeta = identityMeta;
    self.__SOS_CRYPTO_WORKER_TEST_HOOKS.setNostrTools = function (tools) {
      NT = tools;
      self.NostrTools = tools;
    };
  }

  try {
    self.postMessage({ op: 'WORKER_BOOTED', ok: true, vaultState: 'UNINITIALIZED' });
  } catch (_e) {}
})(typeof self !== 'undefined' ? self : globalThis);
