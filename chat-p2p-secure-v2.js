/**
 * Stage 5E — Secure P2P payload v2 (application-layer NIP-44 on DataChannel + mesh).
 * No deploy hook. Capability must be exchanged before treating peer as v2-capable.
 */
(function initP2pSecureV2(root) {
  const App = root.NostrApp || (root.NostrApp = {});
  const NT = root.NostrTools;

  const CAPABILITY = Object.freeze({ secureP2pV2: true, v: 1 });
  const FAMILY = 'sos-p2p-secure-v2';
  const VERSION = 1;
  const ALG = 'nip44';

  const INNER_P2P_CHAT = 'p2p-dc-chat';
  const INNER_FILE_OFFER = 'p2p-dc-file-offer';
  const INNER_MESH_SIG = 'p2p-dc-mesh-sig';

  const REPLAY_MAX = 8000;
  const REPLAY_TTL_MS = 7 * 24 * 3600 * 1000;

  /** @type {Map<string, { secureP2pV2: boolean, known: boolean, updatedAt: number }>} */
  const peerCaps = new Map();
  /** @type {Map<string, number>} */
  const replaySeen = new Map();

  function normPeer(pk) {
    if (typeof pk !== 'string') return '';
    const h = pk.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(h) ? h : '';
  }

  function localPub() {
    return normPeer(App.publicKey);
  }

  function isLocalSecureP2pV2() {
    return !!(localPub() && App.privateKey && !App.guestMode);
  }

  function isPeerSecureP2pV2(peerPubkey) {
    const p = normPeer(peerPubkey);
    if (!p) return false;
    const row = peerCaps.get(p);
    return !!(row && row.known && row.secureP2pV2 === true);
  }

  function isPeerCapabilityKnown(peerPubkey) {
    const p = normPeer(peerPubkey);
    if (!p) return false;
    const row = peerCaps.get(p);
    return !!(row && row.known);
  }

  function setPeerCapability(peerPubkey, secureP2pV2) {
    const p = normPeer(peerPubkey);
    if (!p) return;
    peerCaps.set(p, { secureP2pV2: secureP2pV2 === true, known: true, updatedAt: Date.now() });
  }

  function secureFail(code, msg) {
    const err = new Error(msg || code);
    err.code = code;
    err.name = 'P2pSecureV2Error';
    throw err;
  }

  function requirePrivHex() {
    if (typeof App.privateKey !== 'string' || !App.privateKey.trim()) {
      secureFail('NO_PRIVATE_KEY', 'missing private key');
    }
    const hex = App.privateKey.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) secureFail('BAD_PRIVATE_KEY', 'bad private key');
    return hex;
  }

  function getNip44() {
    const nip44 = NT && NT.nip44;
    if (!nip44 || !nip44.v2 || typeof nip44.v2.encrypt !== 'function' || typeof nip44.v2.decrypt !== 'function') {
      secureFail('NIP44_UNAVAILABLE', 'nip44 v2 missing');
    }
    const getConversationKey =
      (nip44.v2.utils && nip44.v2.utils.getConversationKey) || nip44.getConversationKey;
    if (typeof getConversationKey !== 'function') secureFail('NIP44_UNAVAILABLE', 'getConversationKey missing');
    return {
      encrypt: nip44.v2.encrypt.bind(nip44.v2),
      decrypt: nip44.v2.decrypt.bind(nip44.v2),
      getConversationKey,
    };
  }

  function parseEnvelope(raw) {
    let env = raw;
    if (typeof env === 'string') {
      try {
        env = JSON.parse(env);
      } catch (_e) {
        secureFail('BAD_ENVELOPE', 'envelope JSON invalid');
      }
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) secureFail('BAD_ENVELOPE', 'envelope not object');
    if (env.family !== FAMILY) secureFail('UNKNOWN_FAMILY', 'bad family');
    if (env.v !== VERSION) secureFail('UNKNOWN_VERSION', 'bad version');
    if (env.alg !== ALG) secureFail('UNSUPPORTED_ALG', 'bad alg');
    if (typeof env.ct !== 'string' || !env.ct) secureFail('BAD_CIPHERTEXT', 'missing ct');
    return env;
  }

  function buildEnvelope(ciphertext) {
    return { family: FAMILY, v: VERSION, alg: ALG, ct: ciphertext };
  }

  function bindSenderRecipient(inner, expectedSender, expectedRecipient) {
    const sender = normPeer(inner && inner.sender);
    const recipient = normPeer(inner && inner.recipient);
    const expS = normPeer(expectedSender);
    const expR = normPeer(expectedRecipient);
    if (!sender || sender !== expS) secureFail('SENDER_MISMATCH', 'sender mismatch');
    if (!recipient || recipient !== expR) secureFail('RECIPIENT_MISMATCH', 'recipient mismatch');
    return { sender, recipient };
  }

  function replayKey(sender, recipient, nonce) {
    return `${sender}:${recipient}:${String(nonce || '')}`;
  }

  function markReplayOnce(sender, recipient, nonce) {
    const key = replayKey(sender, recipient, nonce);
    if (!nonce) secureFail('REPLAY_NO_NONCE', 'missing nonce');
    const now = Date.now();
    if (replaySeen.has(key)) secureFail('REPLAY', 'duplicate envelope');
    replaySeen.set(key, now);
    if (replaySeen.size > REPLAY_MAX) {
      for (const [k, t] of replaySeen) {
        if (now - t > REPLAY_TTL_MS) replaySeen.delete(k);
        if (replaySeen.size <= REPLAY_MAX * 0.8) break;
      }
    }
  }

  async function encryptInner(inner, recipientPubkey) {
    const recipient = normPeer(recipientPubkey);
    const sender = localPub();
    if (!recipient || !sender) secureFail('BAD_PEER', 'bad peer keys');
    const body = { ...inner, sender, recipient };
    const plaintext = JSON.stringify(body);
    const nip44 = getNip44();
    const ct = nip44.encrypt(plaintext, nip44.getConversationKey(requirePrivHex(), recipient));
    if (!ct) secureFail('ENCRYPT_FAILURE', 'empty ciphertext');
    return buildEnvelope(ct);
  }

  async function decryptInner(envelope, expectedSenderPubkey) {
    const expectedSender = normPeer(expectedSenderPubkey);
    const local = localPub();
    if (!expectedSender || !local) secureFail('BAD_PEER', 'bad peer keys');
    const env = parseEnvelope(envelope);
    const nip44 = getNip44();
    let plain;
    try {
      plain = nip44.decrypt(env.ct, nip44.getConversationKey(requirePrivHex(), expectedSender));
    } catch (_e) {
      secureFail('DECRYPT_FAILURE', 'decrypt failed');
    }
    let inner;
    try {
      inner = JSON.parse(plain);
    } catch (_e) {
      secureFail('BAD_JSON', 'inner JSON invalid');
    }
    bindSenderRecipient(inner, expectedSender, local);
    return inner;
  }

  function announceCapability(peerPubkey, dc) {
    if (!isLocalSecureP2pV2()) return;
    const ch = dc || (App.dataChannel && typeof App.dataChannel.getChatDC === 'function'
      ? App.dataChannel.getChatDC(peerPubkey)
      : null);
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(JSON.stringify({ type: 'p2p-secure-capability', ...CAPABILITY, from: localPub() }));
    } catch (_e) {}
  }

  function handleCapabilityMessage(peerPubkey, msg) {
    const p = normPeer(peerPubkey);
    if (!p || !msg) return;
    setPeerCapability(p, msg.secureP2pV2 === true && msg.v === 1);
    announceCapability(p);
  }

  async function encryptChatTextForDc(peerPubkey, msg) {
    const recipient = normPeer(peerPubkey);
    if (!recipient) secureFail('BAD_PEER', 'bad recipient');
    const messageId = String(msg && msg.id || '');
    if (!messageId || messageId.length > 256) secureFail('BAD_ID', 'bad message id');
    const createdAt = Number(msg && msg.createdAt);
    if (!Number.isFinite(createdAt)) secureFail('BAD_CREATED_AT', 'bad createdAt');
    const text = typeof msg.content === 'string' ? msg.content : '';
    const attachment = msg.attachment == null ? null : msg.attachment;
    const nonce = messageId;
    const inner = {
      v: VERSION,
      type: INNER_P2P_CHAT,
      messageId,
      createdAt,
      text,
      attachment,
      nonce,
    };
    const envelope = await encryptInner(inner, recipient);
    try {
      console.log('[P2P_SECURE_TEXT_SEND] peer=' + recipient.slice(0, 8));
    } catch (_e) {}
    return { type: 'p2p-secure-text', envelope };
  }

  async function decryptChatTextFromDc(peerPubkey, wire) {
    const inner = await decryptInner(wire && wire.envelope, peerPubkey);
    if (inner.type !== INNER_P2P_CHAT) secureFail('BAD_TYPE', 'not chat');
    markReplayOnce(inner.sender, inner.recipient, inner.nonce || inner.messageId);
    try {
      console.log('[P2P_SECURE_TEXT_RECV] peer=' + normPeer(peerPubkey).slice(0, 8));
    } catch (_e) {}
    return {
      id: inner.messageId,
      content: inner.text,
      attachment: inner.attachment == null ? null : inner.attachment,
      createdAt: inner.createdAt,
    };
  }

  async function encryptFileOfferForDc(peerPubkey, offerPlain) {
    const recipient = normPeer(peerPubkey);
    if (!recipient) secureFail('BAD_PEER', 'bad recipient');
    const fileId = String(offerPlain && offerPlain.fileId || '');
    const keyStr = String(offerPlain && offerPlain.keyStr || '');
    if (!fileId || !keyStr) secureFail('BAD_OFFER', 'missing fileId/keyStr');
    const nonce = `file-offer:${fileId}`;
    const inner = {
      v: VERSION,
      type: INNER_FILE_OFFER,
      nonce,
      createdAt: Math.floor(Date.now() / 1000),
      fileId,
      name: offerPlain.name,
      size: offerPlain.size,
      mimeType: offerPlain.mimeType,
      keyStr,
      totalChunks: offerPlain.totalChunks,
      caption: offerPlain.caption,
    };
    const envelope = await encryptInner(inner, recipient);
    try {
      console.log('[P2P_SECURE_FILE_KEY_SEND] peer=' + recipient.slice(0, 8) + ' fileId=' + fileId.slice(0, 12));
    } catch (_e) {}
    return { type: 'p2p-secure-file-offer', envelope };
  }

  async function decryptFileOfferFromDc(peerPubkey, wire) {
    const inner = await decryptInner(wire && wire.envelope, peerPubkey);
    if (inner.type !== INNER_FILE_OFFER) secureFail('BAD_TYPE', 'not file offer');
    markReplayOnce(inner.sender, inner.recipient, inner.nonce || inner.fileId);
    try {
      console.log('[P2P_SECURE_FILE_KEY_RECV] peer=' + normPeer(peerPubkey).slice(0, 8));
    } catch (_e) {}
    return {
      fileId: inner.fileId,
      name: inner.name,
      size: inner.size,
      mimeType: inner.mimeType,
      keyStr: inner.keyStr,
      totalChunks: inner.totalChunks,
      createdAt: inner.createdAt,
      caption: inner.caption,
    };
  }

  async function encryptMeshSignal(peerPubkey, sigType, data) {
    const recipient = normPeer(peerPubkey);
    if (!recipient) secureFail('BAD_PEER', 'bad recipient');
    const nonce = `${sigType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const inner = {
      v: VERSION,
      type: INNER_MESH_SIG,
      sigType: String(sigType || ''),
      nonce,
      ts: Date.now(),
      data: data == null ? null : data,
    };
    const envelope = await encryptInner(inner, recipient);
    try {
      console.log('[P2P_SECURE_MESH_SIGNAL] peer=' + recipient.slice(0, 8) + ' type=' + String(sigType));
    } catch (_e) {}
    return JSON.stringify({
      type: 'p2p-secure-mesh-signal',
      fromPubkey: localPub(),
      envelope,
    });
  }

  async function decryptMeshSignal(fromPubkey, rawJson) {
    let parsed = rawJson;
    if (typeof rawJson === 'string') {
      try {
        parsed = JSON.parse(rawJson);
      } catch (_e) {
        secureFail('BAD_MESH', 'mesh JSON invalid');
      }
    }
    if (!parsed || parsed.type !== 'p2p-secure-mesh-signal') secureFail('BAD_MESH', 'not secure mesh');
    const inner = await decryptInner(parsed.envelope, fromPubkey);
    if (inner.type !== INNER_MESH_SIG) secureFail('BAD_TYPE', 'not mesh sig');
    markReplayOnce(inner.sender, inner.recipient, inner.nonce);
    return { type: inner.sigType, data: inner.data, fromPubkey: normPeer(fromPubkey) };
  }

  async function waitForPeerCapability(peerPubkey, timeoutMs) {
    const p = normPeer(peerPubkey);
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : 1500;
    const start = Date.now();
    while (Date.now() - start < budget) {
      if (isPeerCapabilityKnown(p)) return isPeerSecureP2pV2(p);
      announceCapability(p);
      await new Promise((r) => setTimeout(r, 60));
    }
    return isPeerSecureP2pV2(p);
  }

  function hookDataChannelOpen() {
    const prev = App.onChatDataChannelOpen;
    App.onChatDataChannelOpen = function onChatDataChannelOpenSecure(peer, dc) {
      try {
        announceCapability(peer, dc);
      } catch (_e) {}
      if (typeof prev === 'function') {
        try {
          prev(peer, dc);
        } catch (_e2) {}
      }
    };
  }

  hookDataChannelOpen();

  const api = {
    CAPABILITY,
    FAMILY,
    VERSION,
    isLocalSecureP2pV2,
    isPeerSecureP2pV2,
    isPeerCapabilityKnown,
    setPeerCapability,
    announceCapability,
    handleCapabilityMessage,
    encryptChatTextForDc,
    decryptChatTextFromDc,
    encryptFileOfferForDc,
    decryptFileOfferFromDc,
    encryptMeshSignal,
    decryptMeshSignal,
    waitForPeerCapability,
    parseEnvelope,
    looksLikeSecureEnvelope(value) {
      try {
        parseEnvelope(value);
        return true;
      } catch (_e) {
        return false;
      }
    },
  };

  App.P2pSecureV2 = api;
  try {
    console.log('[P2P-SECURE-V2] module loaded');
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
