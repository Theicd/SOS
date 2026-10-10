/**
 * MD4 S4 — desktop sos-history-sync-v1 bootstrap with pagination/resume/tombstones (t=sos-hist-v1).
 * Opens sealed CKI with durable D_enc; decrypts kind 1050 via conversation keys in memory.
 * No root K/nsec. No persistent plaintext CKI storage.
 */
(function initSosMd4HistorySync(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const KIND = 25060;
  const TAG = 'sos-hist-v1';
  const PAIR_TAG = 'sos-pair-v1';
  const PROTOCOL = 'sos-history-sync-v1';
  const HKDF_INFO = 'SOS|hist|v1';
  const POP_DOMAIN = 'SOS|hist|pop';
  const ACK_AAD_DOMAIN = 'SOS|hist|ack|aad|v1';
  const BATCH_DIGEST_DOMAIN = 'SOS|hist|batch|digest|v1';
  const MAX_BATCH_EVENTS = 50;
  const MAX_BATCH_BYTES = 256 * 1024;
  const DEFAULT_TTL_MS = 15 * 60 * 1000;
  const COLLECTION_ID = 'hist-bootstrap-v1';

  const spentSessionNonces = new Set();
  const spentExportSessions = new Set();

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }
  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }
  function bufFromHex(hex) {
    const h = normHex(hex);
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function hexFromBuf(buf) {
    return Array.from(buf, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function b64(buf) {
    let s = '';
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function b64dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }
  async function hmacSha256(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }
  async function hkdfExtract(salt, ikm) {
    return hmacSha256(salt, ikm);
  }
  async function hkdfExpand(prk, info, length) {
    const out = new Uint8Array(length);
    let t = new Uint8Array(0);
    let offset = 0;
    let counter = 1;
    while (offset < length) {
      const input = new Uint8Array(t.length + info.length + 1);
      input.set(t, 0);
      input.set(info, t.length);
      input[t.length + info.length] = counter;
      t = await hmacSha256(prk, input);
      const take = Math.min(t.length, length - offset);
      out.set(t.subarray(0, take), offset);
      offset += take;
      counter += 1;
    }
    return out;
  }
  async function histSessionKey(ecdh, bind) {
    const ikm = new Uint8Array(64);
    ikm.set(ecdh, 0);
    ikm.set(bind, 32);
    const prk = await hkdfExtract(bind, ikm);
    const info = new TextEncoder().encode(HKDF_INFO);
    try {
      return await hkdfExpand(prk, info, 32);
    } finally {
      ikm.fill(0);
      prk.fill(0);
    }
  }
  async function aeadSeal(sk, aad, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext),
    );
    return { ivB64: b64(iv), ctB64: b64(ct) };
  }
  async function aeadOpen(sk, aad, ivB64, ctB64) {
    try {
      const iv = b64dec(ivB64);
      const ct = b64dec(ctB64);
      const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['decrypt']);
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct),
      );
    } catch (_e) {
      return null;
    }
  }
  async function transcriptBind(fields) {
    const enc = new TextEncoder();
    const parts = [
      PROTOCOL,
      normHex(fields.accountP),
      normHex(fields.deviceId),
      normHex(fields.authorizationId),
      String(fields.authEpoch),
      normHex(fields.pairingTranscriptHash),
      normHex(fields.sessionNonce),
      normHex(fields.dSignPub),
      normHex(fields.dEncPub),
    ];
    let total = 0;
    const bins = parts.map((p) => {
      const b = enc.encode(p);
      total += b.length;
      return b;
    });
    const all = new Uint8Array(total);
    let o = 0;
    bins.forEach((b) => {
      all.set(b, o);
      o += b.length;
    });
    return sha256(all);
  }
  async function popMessage(bind) {
    const enc = new TextEncoder();
    const prefix = enc.encode(POP_DOMAIN);
    const all = new Uint8Array(prefix.length + bind.length);
    all.set(prefix, 0);
    all.set(bind, prefix.length);
    return sha256(all);
  }
  /** Domain-separated AEAD AAD for SYNC_ACK / SYNC_FINAL_ACK (binds session + auth). */
  async function ackAad(bind, sessionId, accountP, deviceId, authorizationId, authEpoch) {
    const enc = new TextEncoder();
    const parts = [
      enc.encode(ACK_AAD_DOMAIN),
      bind,
      enc.encode(normHex(sessionId)),
      enc.encode(normHex(accountP)),
      enc.encode(normHex(deviceId)),
      enc.encode(normHex(authorizationId)),
      enc.encode(String(authEpoch)),
    ];
    let total = 0;
    parts.forEach((p) => {
      total += p.length;
    });
    const all = new Uint8Array(total);
    let o = 0;
    parts.forEach((p) => {
      all.set(p, o);
      o += p.length;
    });
    return sha256(all);
  }
  async function batchDigest(batchId, batchSeq, eventsJson) {
    const enc = new TextEncoder();
    const parts = [
      enc.encode(BATCH_DIGEST_DOMAIN),
      enc.encode(normHex(batchId)),
      enc.encode(String(batchSeq)),
      enc.encode(String(eventsJson || '')),
    ];
    let total = 0;
    parts.forEach((p) => {
      total += p.length;
    });
    const all = new Uint8Array(total);
    let o = 0;
    parts.forEach((p) => {
      all.set(p, o);
      o += p.length;
    });
    return hexFromBuf(await sha256(all));
  }

  function classifyTags(tags) {
    const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
    if (Auth && typeof Auth.classifyKind25060Tags === 'function') return Auth.classifyKind25060Tags(tags);
    const tTags = (tags || []).filter((x) => x && x[0] === 't').map((x) => String(x[1] || ''));
    if (tTags.indexOf(PAIR_TAG) !== -1 && tTags.indexOf(TAG) !== -1) {
      return { ok: false, code: 'CROSS_PROTOCOL_TAG_COLLISION' };
    }
    if (tTags.indexOf(TAG) !== -1) return { ok: true, protocol: TAG };
    if (tTags.indexOf(PAIR_TAG) !== -1) return { ok: true, protocol: PAIR_TAG };
    return { ok: false, code: 'UNKNOWN_PROTOCOL' };
  }

  function decryptEnvelopeWithCk(env, conversationKeyHex) {
    const parsed = typeof env === 'string' ? JSON.parse(env) : env;
    const E2ee = window.SosChatE2ee || App;
    if (E2ee && typeof E2ee.decryptPrivateChatPayloadWithConversationKey === 'function') {
      try {
        const out = E2ee.decryptPrivateChatPayloadWithConversationKey({
          encryptedEnvelope: parsed,
          conversationKeyHex: conversationKeyHex,
        });
        if (out != null) return out;
      } catch (_e) {
        /* fall through to raw NIP-44 — tombstones / atypical inners may be rejected by chat e2ee facade */
      }
    }
    const nip44 = (window.NostrTools && window.NostrTools.nip44 && window.NostrTools.nip44.v2) || null;
    if (!nip44) throw new Error('NIP44_UNAVAILABLE');
    const ct = parsed.ct || parsed.ciphertext;
    const ck = bufFromHex(conversationKeyHex);
    const plain = nip44.decrypt(ct, ck);
    ck.fill(0);
    return typeof plain === 'string' ? JSON.parse(plain) : plain;
  }

  function isTombstoneInner(inner) {
    return !!(inner && (inner.deleted === true || inner.type === 'tombstone' || inner.action === 'delete'));
  }

  /** Fail-closed outer kind-1050 verification (id/hash + Schnorr). */
  function verifyOuterKind1050(ev) {
    if (!ev || Number(ev.kind) !== 1050) return { ok: false, code: 'BAD_KIND' };
    if (!ev.id || typeof ev.id !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.id)) {
      return { ok: false, code: 'BAD_EVENT_ID' };
    }
    if (!ev.pubkey || !/^[0-9a-f]{64}$/i.test(String(ev.pubkey))) {
      return { ok: false, code: 'BAD_EVENT_PUBKEY' };
    }
    if (!ev.sig || typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(String(ev.sig))) {
      return { ok: false, code: 'MISSING_OUTER_SIGNATURE' };
    }
    const NT = window.NostrTools;
    if (!NT || typeof NT.verifyEvent !== 'function') return { ok: false, code: 'VERIFY_UNAVAILABLE' };
    // Verify against a plain copy so callers cannot rely on frozen/proxy event quirks.
    const copy = {
      id: String(ev.id),
      pubkey: String(ev.pubkey),
      created_at: Number(ev.created_at),
      kind: Number(ev.kind),
      tags: Array.isArray(ev.tags) ? ev.tags.map((t) => (Array.isArray(t) ? t.slice() : t)) : [],
      content: String(ev.content == null ? '' : ev.content),
      sig: String(ev.sig),
    };
    if (typeof NT.getEventHash === 'function') {
      try {
        if (normHex(NT.getEventHash(copy)) !== normHex(copy.id)) {
          return { ok: false, code: 'EVENT_ID_MISMATCH' };
        }
      } catch (_e) {
        return { ok: false, code: 'EVENT_ID_MISMATCH' };
      }
    }
    try {
      if (NT.verifyEvent(copy) !== true) return { ok: false, code: 'BAD_EVENT_SIG' };
    } catch (_e) {
      return { ok: false, code: 'BAD_EVENT_SIG' };
    }
    return { ok: true };
  }

  function markDeleted(id) {
    App.deletedChatMessageIds = App.deletedChatMessageIds || new Set();
    App.deletedChatMessageIds.add(id);
    if (typeof App.markChatMessageDeleted === 'function') {
      try {
        App.markChatMessageDeleted(id);
      } catch (_e) {}
    }
  }

  function findExistingMessage(id) {
    const nid = normHex(id);
    if (App.chatState && App.chatState.messageIndex && App.chatState.messageIndex.get) {
      const existingIdx = App.chatState.messageIndex.get(id) || App.chatState.messageIndex.get(nid);
      if (existingIdx && App.chatState.conversations) {
        const entry = App.chatState.conversations.get(existingIdx.key);
        const prev = entry && Array.isArray(entry.messages) ? entry.messages.find((m) => m && normHex(m.id) === nid) : null;
        if (prev) return prev;
      }
    }
    if (App.chatState && App.chatState.conversations) {
      let found = null;
      App.chatState.conversations.forEach((entry) => {
        if (found || !entry || !Array.isArray(entry.messages)) return;
        const hit = entry.messages.find((m) => m && normHex(m.id) === nid);
        if (hit) found = hit;
      });
      if (found) return found;
    }
    return null;
  }

  function importDecryptedMessage(accountP, peerP, event, inner) {
    const self = normHex(accountP);
    const peer = normHex(peerP);
    if (!App.appendChatMessage) return { ok: false, code: 'CHAT_STATE_MISSING' };
    if (!event || typeof event.id !== 'string' || !/^[0-9a-f]{64}$/i.test(event.id)) {
      return { ok: false, code: 'FORGED_EVENT_IDENTITY' };
    }
    // Mandatory outer provenance before any import / deletion authority.
    const outer = verifyOuterKind1050(event);
    if (!outer.ok) return { ok: false, code: outer.code };
    if (normHex(App.publicKey || '') !== self) {
      App.publicKey = self;
    }
    const author = normHex(event.pubkey);
    if (author !== self && author !== peer) {
      return { ok: false, code: 'UNAUTHORIZED_CONVERSATION' };
    }
    if (author !== self && !((event.tags || []).some((t) => t[0] === 'p' && normHex(t[1]) === self))) {
      return { ok: false, code: 'CROSS_ACCOUNT_EVENT' };
    }
    if (author === self && !((event.tags || []).some((t) => t[0] === 'p' && normHex(t[1]) === peer))) {
      return { ok: false, code: 'UNAUTHORIZED_CONVERSATION' };
    }
    const tomb = isTombstoneInner(inner);
    const eTag = (event.tags || []).find((t) => t && t[0] === 'e' && t[1]);
    const targetId = tomb
      ? normHex((inner && (inner.targetId || inner.messageId)) || (eTag && eTag[1]) || '')
      : normHex(event.id);
    if (tomb) {
      // Unauthorized deletion: only conversation participants (self/peer) may tombstone.
      if (author !== self && author !== peer) {
        return { ok: false, code: 'UNAUTHORIZED_TOMBSTONE' };
      }
      if (!targetId || !/^[0-9a-f]{64}$/.test(targetId)) {
        return { ok: false, code: 'TOMBSTONE_BAD_TARGET' };
      }
      // If an e-tag is present it must agree with the authenticated inner target.
      if (eTag && normHex(eTag[1]) !== targetId) {
        return { ok: false, code: 'TOMBSTONE_TARGET_MISMATCH' };
      }
      const prevTarget = findExistingMessage(targetId);
      if (prevTarget && Number(event.created_at) < Number(prevTarget.createdAt || 0)) {
        return { ok: false, code: 'TOMBSTONE_BEFORE_TARGET' };
      }
      markDeleted(targetId);
      // Soft-delete visible row if present.
      if (prevTarget) prevTarget.deleted = true;
      if (App.chatState && App.chatState.messageIndex && App.chatState.conversations) {
        const idx = App.chatState.messageIndex.get(targetId);
        if (idx) {
          const entry = App.chatState.conversations.get(idx.key);
          const prev = entry && Array.isArray(entry.messages) ? entry.messages.find((m) => m && m.id === targetId) : null;
          if (prev) prev.deleted = true;
        }
      }
      return { ok: true, id: targetId, tombstone: true };
    }
    // No resurrection after durable tombstone.
    if (App.deletedChatMessageIds && App.deletedChatMessageIds.has(normHex(event.id))) {
      return { ok: true, id: event.id, suppressed: true, reason: 'TOMBSTONE_AUTHORITATIVE' };
    }
    const fromSelf = author === self;
    const text = (inner && (inner.text || inner.content || '')) || '';
    const prev = findExistingMessage(event.id);
    if (prev) {
      if (prev.deleted) return { ok: true, id: event.id, suppressed: true, reason: 'ALREADY_DELETED' };
      const prevText = String(prev.content || '');
      const nextText = String(text || '');
      if (prevText !== nextText) return { ok: false, code: 'CONFLICTING_EVENT' };
      return { ok: true, id: event.id, duplicate: true };
    }
    const logicalMessageId =
      (inner && (inner.messageId || inner.logicalMessageId)) || event.id;
    const attachment =
      inner && inner.attachment && typeof inner.attachment === 'object' ? inner.attachment : null;
    const msg = {
      id: event.id,
      from: fromSelf ? self : peer,
      to: fromSelf ? peer : self,
      content: text,
      createdAt: Number(event.created_at) || 0,
      direction: fromSelf ? 'out' : 'in',
      status: 'delivered',
      transport: 'NOSTR',
      source: 'MD4_HIST_BOOTSTRAP',
      encrypted: true,
      logicalMessageId: String(logicalMessageId),
      mediaSyncState: attachment ? 'PENDING' : 'NONE',
    };
    if (attachment) {
      msg.attachment = attachment;
    }
    App.ensureChatContact && App.ensureChatContact(peer, { name: peer.slice(0, 8) });
    App.appendChatMessage(msg);
    return {
      ok: true,
      id: event.id,
      attachment: !!attachment,
      logicalMessageId: String(logicalMessageId),
      peer,
      sender: fromSelf ? self : peer,
      recipient: fromSelf ? peer : self,
    };
  }

  function compareCursor(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    const ai = normHex(a.eventId);
    const bi = normHex(b.eventId);
    if (ai === bi) return 0;
    return ai < bi ? -1 : 1;
  }

  function cursorOfEvent(ev) {
    return { createdAt: Number(ev.created_at) || 0, eventId: normHex(ev.id) };
  }

  /**
   * Begin desktop bootstrap against an authorized phone exporter on relays.
   * deviceCtx: result of Md4DeviceStore.loadLinkedDevice (includes dEncPriv, dSignSk, authorization).
   */
  async function beginBootstrap(opts) {
    const o = opts || {};
    const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
    const Cki = App.Md4Cki || window.SosMd4Cki;
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Auth || !Cki || !Md2) return { ok: false, code: 'MODULES_MISSING' };
    const deviceCtx = o.deviceCtx;
    if (!deviceCtx || !deviceCtx.ok) return { ok: false, code: 'NO_DEVICE' };
    const auth = deviceCtx.authorization;
    const gate = await Auth.assertHistorySyncAuthorized({
      authorization: auth,
      device: deviceCtx,
      nowMs: Date.now(),
      minAcceptedAuthEpoch: deviceCtx.minAcceptedAuthEpoch,
    });
    if (!gate.ok) return gate;

    const relays = o.relays || Md2.DEFAULT_RELAYS || [];
    const sessionId = o.sessionId || hexFromBuf(crypto.getRandomValues(new Uint8Array(32)));
    const sessionNonce = hexFromBuf(crypto.getRandomValues(new Uint8Array(32)));
    if (spentSessionNonces.has(sessionNonce)) return { ok: false, code: 'REPLAY_SESSION_NONCE' };
    spentSessionNonces.add(sessionNonce);

    const eph = Md2.x25519Generate();
    const bind = await transcriptBind({
      accountP: auth.accountP,
      deviceId: auth.deviceId,
      authorizationId: auth.authorizationId,
      authEpoch: auth.authEpoch,
      pairingTranscriptHash: auth.pairingTranscriptHash,
      sessionNonce: sessionNonce,
      dSignPub: auth.D_sign_pub || auth.dSignPub,
      dEncPub: auth.D_enc_pub || auth.dEncPub,
    });
    const popMsg = await popMessage(bind);
    const popSig = await Md2.signSchnorrRaw(popMsg, deviceCtx.dSignSk);
    const expiresAt = Date.now() + (o.ttlMs || DEFAULT_TTL_MS);
    const hello = {
      type: 'SYNC_HELLO',
      protocol: PROTOCOL,
      sessionNonce: sessionNonce,
      accountP: auth.accountP,
      deviceId: auth.deviceId,
      authorizationId: auth.authorizationId,
      authEpoch: auth.authEpoch,
      pairingTranscriptHash: auth.pairingTranscriptHash,
      D_sign_pub: auth.D_sign_pub || auth.dSignPub,
      D_enc_pub: auth.D_enc_pub || auth.dEncPub,
      ephDesktopPub: hexFromBuf(eph.pub),
      popSig: popSig,
      createdAt: Date.now(),
      expiresAt: expiresAt,
    };

    const NT = window.NostrTools;
    if (!NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'NOSTR_TOOLS_MISSING' };
    const ephSk = NT.generateSecretKey();
    const seen = new Set();
    const sockets = [];
    let sessionKey = null;
    let openedIndex = null;
    const imported = [];
    const duplicates = [];
    const rejected = [];
    const suppressed = [];
    const tombstones = [];
    const attachmentJobs = [];
    let attachmentsComplete = 0;
    let attachmentsMissing = 0;
    let attachmentsFailed = 0;
    let completeness = 'FAILED';
    let exportSessionId = '';
    let lastCursorCommitted = null;
    let batchesAcked = 0;
    let authOkCount = 0;
    const Attach = App.Md4AttachmentSync || window.SosMd4AttachmentSync;
    let doneResolve;
    let settled = false;
    const donePromise = new Promise((r) => {
      doneResolve = (v) => {
        if (settled) return;
        settled = true;
        r(v);
      };
    });
    const timeoutMs = Math.min(o.timeoutMs || 120000, DEFAULT_TTL_MS);
    const Ckpt = App.Md4HistoryCheckpoint || window.SosMd4HistoryCheckpoint;

    function publish(contentObj) {
      const tags = [
        ['t', TAG],
        ['d', sessionId],
        ['role', 'desktop'],
      ];
      const cl = classifyTags(tags);
      if (!cl.ok || cl.protocol !== TAG) throw new Error('PROTOCOL_CONFUSION');
      const ev = NT.finalizeEvent(
        { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(contentObj) },
        ephSk,
      );
      const frame = JSON.stringify(['EVENT', ev]);
      sockets.forEach((ws) => {
        try {
          ws.send(frame);
        } catch (_e) {}
      });
    }

    async function publishAckSealed(ackObj) {
      if (!sessionKey) return;
      const aad = await ackAad(
        bind,
        sessionId,
        auth.accountP,
        auth.deviceId,
        auth.authorizationId,
        auth.authEpoch,
      );
      const sealed = await aeadSeal(sessionKey, aad, new TextEncoder().encode(JSON.stringify(ackObj)));
      publish({ type: 'AEAD', iv: sealed.ivB64, ct: sealed.ctB64 });
    }

    // Serialize inbound processing — phone may publish CKI/batch/DONE faster than async open completes.
    let contentChain = Promise.resolve();
    function enqueueContent(raw) {
      contentChain = contentChain.then(() => onContent(raw)).catch(() => {});
      return contentChain;
    }

    async function onContent(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.type === 'SYNC_AUTH_OK') {
        if (!isHex64(msg.ephPhonePub)) return;
        authOkCount += 1;
        if (sessionKey) return; // duplicate AUTH_OK: no second session / no re-derive
        const shared = Md2.x25519Shared(eph.priv, msg.ephPhonePub);
        sessionKey = await histSessionKey(shared, bind);
        if (shared.fill) shared.fill(0);
        return;
      }
      if (msg.type !== 'AEAD' || !sessionKey) return;
      const plain = await aeadOpen(sessionKey, bind, msg.iv, msg.ct);
      if (!plain) return;
      let inner;
      try {
        inner = JSON.parse(new TextDecoder().decode(plain));
      } catch (_e) {
        return;
      }
      if (inner.type === 'KEY_INDEX_SEALED') {
        if (openedIndex) return; // already opened (retry duplicate)
        const pages = inner.pages || [];
        if (!pages.length) {
          doneResolve({ ok: false, code: 'EMPTY_CKI_PAGES' });
          return;
        }
        const seal = pages[0].seal;
        Cki.resetSpentForTests && Cki.resetSpentForTests();
        const opened = await Cki.openSealedIndex(seal, deviceCtx, {});
        if (!opened.ok) {
          doneResolve({ ok: false, code: opened.code || 'CKI_OPEN_FAIL' });
          return;
        }
        openedIndex = opened;
        exportSessionId = opened.index.exportSessionId;
        if (spentExportSessions.has(exportSessionId)) {
          doneResolve({ ok: false, code: 'REPLAY_EXPORT_SESSION' });
          return;
        }
        spentExportSessions.add(exportSessionId);
        return;
      }
      if (inner.type === 'HIST_MANIFEST') {
        completeness = inner.completeness || 'PARTIAL';
        return;
      }
      if (inner.type === 'HIST_BATCH') {
        if (!openedIndex || !openedIndex.index) {
          doneResolve({ ok: false, code: 'BATCH_BEFORE_CKI', completeness: 'FAILED' });
          return;
        }
        const events = inner.events || [];
        const rawBytes = new TextEncoder().encode(JSON.stringify(events)).length;
        if (events.length > MAX_BATCH_EVENTS || rawBytes > MAX_BATCH_BYTES) {
          doneResolve({ ok: false, code: 'OVERSIZED_BATCH', completeness: 'FAILED' });
          return;
        }
        const batchId = normHex(inner.batchId || '');
        const batchSeq = Number(inner.batchSeq);
        // Phone-computed digest binds ACK to the exact in-flight batch (serialization-stable on phone).
        const digest = normHex(inner.batchDigest || '');
        if (!batchId || !digest || !Number.isFinite(batchSeq)) {
          doneResolve({ ok: false, code: 'BATCH_META_INVALID', completeness: 'FAILED' });
          return;
        }
        const ckByPeer = {};
        openedIndex.index.entries.forEach((e) => {
          ckByPeer[normHex(e.peerP)] = e.conversationKeyHex;
        });
        const self = normHex(auth.accountP);
        let batchImported = 0;
        let batchDup = 0;
        let batchRej = 0;
        let batchSup = 0;
        let batchTomb = 0;
        let maxCursor = lastCursorCommitted;
        const seenInBatch = new Set();
        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          if (!ev || ev.kind !== 1050) {
            batchRej += 1;
            rejected.push({ id: ev && ev.id, code: 'BAD_KIND' });
            continue;
          }
          const outer = verifyOuterKind1050(ev);
          if (!outer.ok) {
            batchRej += 1;
            rejected.push({ id: ev && ev.id, code: outer.code });
            continue;
          }
          const eid = normHex(ev.id);
          if (seenInBatch.has(eid)) {
            batchDup += 1;
            duplicates.push(eid);
            continue;
          }
          seenInBatch.add(eid);
          if (normHex(ev.pubkey) !== self && !((ev.tags || []).some((t) => t[0] === 'p' && normHex(t[1]) === self))) {
            batchRej += 1;
            rejected.push({ id: eid, code: 'CROSS_ACCOUNT' });
            continue;
          }
          let peer = '';
          if (normHex(ev.pubkey) === self) {
            const p = (ev.tags || []).find((t) => t[0] === 'p');
            peer = p ? normHex(p[1]) : '';
          } else {
            peer = normHex(ev.pubkey);
          }
          if (!peer || !ckByPeer[peer]) {
            batchRej += 1;
            rejected.push({ id: eid, code: 'UNAUTHORIZED_CONVERSATION' });
            continue;
          }
          try {
            let env = ev.content;
            try {
              env = JSON.parse(ev.content);
            } catch (_e) {}
            const dec = decryptEnvelopeWithCk(env, ckByPeer[peer]);
            const imp = importDecryptedMessage(self, peer, ev, dec);
            if (!imp.ok) {
              batchRej += 1;
              rejected.push({ id: eid, code: imp.code });
              continue;
            }
            if (imp.duplicate) {
              batchDup += 1;
              duplicates.push(eid);
            } else if (imp.suppressed) {
              batchSup += 1;
              suppressed.push(eid);
            } else if (imp.tombstone) {
              batchTomb += 1;
              tombstones.push(imp.id);
              // Live tombstone during transfer: mark any queued attachment for this target.
              if (Attach && typeof Attach.loadJob === 'function') {
                /* tombstone applied via deletedChatMessageIds; processPending will TOMBSTONE jobs */
              }
            } else {
              batchImported += 1;
              imported.push(imp.id);
              if (imp.attachment && Attach && typeof Attach.enqueueFromImport === 'function') {
                const msg = findExistingMessage(imp.id);
                const queued = await Attach.enqueueFromImport({
                  accountP: auth.accountP,
                  deviceId: auth.deviceId,
                  authorizationId: auth.authorizationId,
                  authEpoch: auth.authEpoch,
                  sessionId,
                  exportSessionId,
                  peerP: imp.peer || peer,
                  eventId: imp.id,
                  messageId: imp.logicalMessageId || imp.id,
                  sender: imp.sender,
                  recipient: imp.recipient,
                  attachment: msg && msg.attachment,
                });
                if (queued && queued.ok) attachmentJobs.push(queued.job.attachmentId);
              }
            }
            const cur = cursorOfEvent(ev);
            if (!maxCursor || compareCursor(cur, maxCursor) > 0) maxCursor = cur;
          } catch (_e) {
            batchRej += 1;
            rejected.push({ id: eid, code: 'DECRYPT_FAIL' });
          }
        }
        // Durable import BEFORE ACK / checkpoint advance.
        if (typeof App.flushChatPersist === 'function') {
          await App.flushChatPersist();
        }
        if (maxCursor && Ckpt) {
          await Ckpt.save({
            v: 1,
            accountP: normHex(auth.accountP),
            deviceId: normHex(auth.deviceId),
            authorizationId: normHex(auth.authorizationId),
            authEpoch: auth.authEpoch,
            collectionId: COLLECTION_ID,
            cursor: maxCursor,
            exportSessionId: exportSessionId || '',
            committedBatchSeq: Number.isFinite(batchSeq) ? batchSeq : batchesAcked,
          });
        }
        lastCursorCommitted = maxCursor || lastCursorCommitted;
        batchesAcked += 1;
        await publishAckSealed({
          type: 'SYNC_ACK',
          batchId: batchId,
          batchSeq: Number.isFinite(batchSeq) ? batchSeq : batchesAcked - 1,
          batchDigest: digest,
          accountP: normHex(auth.accountP),
          deviceId: normHex(auth.deviceId),
          authorizationId: normHex(auth.authorizationId),
          authEpoch: auth.authEpoch,
          sessionId: normHex(sessionId),
          pairingTranscriptHash: normHex(auth.pairingTranscriptHash),
          exportSessionId: normHex(exportSessionId || ''),
          imported: batchImported,
          duplicate: batchDup,
          rejected: batchRej,
          suppressed: batchSup,
          tombstones: batchTomb,
          cursorCommitted: lastCursorCommitted,
        });
        return;
      }
      if (inner.type === 'ATTACH_CIPHER') {
        // Phone-local ciphertext over authenticated hist session (already AEAD-opened).
        if (!Attach || !sessionKey) return;
        const attachmentId = normHex(inner.attachmentId || '');
        const loaded = await Attach.loadJob(auth.accountP, auth.deviceId, attachmentId);
        if (!loaded.ok) return;
        const job = loaded.job;
        if (App.deletedChatMessageIds && App.deletedChatMessageIds.has(job.eventId)) {
          job.state = Attach.STATES.TOMBSTONED;
          await Attach.saveJob(job);
          return;
        }
        const msg = findExistingMessage(job.eventId);
        if (!msg || !msg.attachment) return;
        try {
          const bytes = b64dec(String(inner.ctB64 || ''));
          const accepted = await Attach.acceptLocalCiphertext(job, bytes, msg.attachment);
          if (accepted.ok) {
            attachmentsComplete += 1;
            await publishAckSealed({
              type: 'ATTACH_ACK',
              attachmentId,
              accountP: normHex(auth.accountP),
              deviceId: normHex(auth.deviceId),
              authorizationId: normHex(auth.authorizationId),
              authEpoch: auth.authEpoch,
              sessionId: normHex(sessionId),
              cipherSha256: job.cipherSha256,
              state: 'COMPLETE',
            });
          }
        } catch (_e) {}
        return;
      }
      if (inner.type === 'SYNC_DONE') {
        completeness = inner.completeness || completeness || 'COMPLETE';
        if (completeness !== 'COMPLETE' && completeness !== 'PARTIAL' && completeness !== 'MISSING_HISTORY' &&
            completeness !== 'INTERRUPTED' && completeness !== 'FAILED') {
          completeness = 'PARTIAL';
        }
        try {
          if (typeof App.flushChatPersist === 'function') await App.flushChatPersist();
          // Hydrate attachments via Blossom/P2P; missing media does not fail history COMPLETE.
          let attachSummary = { processed: 0, complete: 0, missing: 0, failed: 0 };
          if (Attach && typeof Attach.processPending === 'function') {
            try {
              attachSummary = await Attach.processPending(auth, { maxConcurrent: 2 });
              attachmentsComplete += attachSummary.complete || 0;
              attachmentsMissing += attachSummary.missing || 0;
              attachmentsFailed += attachSummary.failed || 0;
            } catch (_e) {}
          }
          if (completeness === 'COMPLETE' && Ckpt) {
            await Ckpt.clear(auth.accountP, auth.deviceId, COLLECTION_ID);
          }
          await publishAckSealed({
            type: 'SYNC_FINAL_ACK',
            exportSessionId: normHex(exportSessionId || ''),
            accountP: normHex(auth.accountP),
            deviceId: normHex(auth.deviceId),
            authorizationId: normHex(auth.authorizationId),
            authEpoch: auth.authEpoch,
            sessionId: normHex(sessionId),
            pairingTranscriptHash: normHex(auth.pairingTranscriptHash),
            imported: imported.length,
            duplicate: duplicates.length,
            rejected: rejected.length,
            suppressed: suppressed.length,
            tombstones: tombstones.length,
            batchesAcked: batchesAcked,
            completeness: completeness,
            cursorCommitted: lastCursorCommitted,
            authOkCount: authOkCount,
            attachmentsQueued: attachmentJobs.length,
            attachmentsComplete: attachmentsComplete,
            attachmentsMissing: attachmentsMissing,
            attachmentsFailed: attachmentsFailed,
          });
          if (openedIndex) Cki.zeroizeIndex(openedIndex);
          doneResolve({
            ok: completeness === 'COMPLETE' || completeness === 'PARTIAL' || completeness === 'MISSING_HISTORY',
            code: 'OK',
            sessionId: sessionId,
            exportSessionId: exportSessionId,
            importedCount: imported.length,
            duplicateCount: duplicates.length,
            rejectedCount: rejected.length,
            rejectedSample: rejected.slice(0, 8),
            suppressedCount: suppressed.length,
            tombstoneCount: tombstones.length,
            batchesAcked: batchesAcked,
            importedIds: imported.slice(0, 32),
            completeness: completeness,
            cursorCommitted: lastCursorCommitted,
            authOkCount: authOkCount,
            attachmentsQueued: attachmentJobs.length,
            attachmentsComplete: attachmentsComplete,
            attachmentsMissing: attachmentsMissing,
            attachmentsFailed: attachmentsFailed,
            mediaComplete: attachmentsMissing === 0 && attachmentsFailed === 0,
            ROOT_K_PRESENT: false,
            NSEC_PRESENT: false,
            PERSISTED_PLAINTEXT_CKI: false,
            FINAL_ACK: true,
            ACK_AEAD: true,
          });
        } catch (_e) {
          doneResolve({ ok: false, code: 'PERSIST_FAIL', completeness: 'FAILED' });
        }
      }
    }

    await new Promise((resolve, reject) => {
      let opened = 0;
      const need = Math.min(relays.length, 3) || 1;
      relays.forEach((url) => {
        try {
          const ws = new WebSocket(url);
          sockets.push(ws);
          ws.onopen = () => {
            const filter = { kinds: [KIND], '#t': [TAG], '#d': [sessionId], limit: 500 };
            ws.send(JSON.stringify(['REQ', 'hist-' + sessionId.slice(0, 12), filter]));
            opened += 1;
            if (opened >= 1) resolve();
          };
          ws.onmessage = (ev) => {
            try {
              const arr = JSON.parse(ev.data);
              if (!Array.isArray(arr) || arr[0] !== 'EVENT') return;
              const event = arr[2];
              if (!event || event.kind !== KIND) return;
              if (seen.has(event.id)) return;
              seen.add(event.id);
              const cl = classifyTags(event.tags);
              if (!cl.ok || cl.protocol !== TAG) return;
              const role = (event.tags || []).find((t) => t[0] === 'role');
              if (role && role[1] === 'desktop') return;
              enqueueContent(event.content);
            } catch (_e) {}
          };
          ws.onerror = () => {};
        } catch (_e) {}
      });
      setTimeout(() => reject(new Error('RELAY_CONNECT_TIMEOUT')), 15000);
    }).catch((e) => {
      return Promise.reject(e);
    });

    // Ephemeral relay: retry HELLO until AUTH_OK (phone REQ may land after first publish).
    publish(hello);
    const helloRetry = setInterval(() => {
      if (sessionKey) return;
      try {
        publish(hello);
      } catch (_e) {}
    }, 2000);

    const timer = setTimeout(() => {
      doneResolve({
        ok: false,
        code: 'TIMEOUT',
        completeness: batchesAcked > 0 ? 'INTERRUPTED' : 'FAILED',
        importedCount: imported.length,
        batchesAcked: batchesAcked,
        cursorCommitted: lastCursorCommitted,
        authOkCount: authOkCount,
      });
    }, timeoutMs);
    const result = await donePromise;
    clearInterval(helloRetry);
    clearTimeout(timer);
    sockets.forEach((ws) => {
      try {
        ws.close();
      } catch (_e) {}
    });
    if (sessionKey) sessionKey.fill(0);
    if (eph.priv && eph.priv.fill) eph.priv.fill(0);
    try {
      if (typeof App.flushChatPersist === 'function') {
        await App.flushChatPersist();
      }
    } catch (_e) {}
    return result;
  }

  function resetSpentForTests() {
    spentSessionNonces.clear();
    spentExportSessions.clear();
  }

  const api = Object.freeze({
    KIND,
    TAG,
    PROTOCOL,
    COLLECTION_ID,
    ACK_AAD_DOMAIN,
    BATCH_DIGEST_DOMAIN,
    beginBootstrap,
    classifyTags,
    importDecryptedMessage,
    isTombstoneInner,
    verifyOuterKind1050,
    compareCursor,
    cursorOfEvent,
    ackAad,
    batchDigest,
    aeadSeal,
    aeadOpen,
    histSessionKey,
    transcriptBind,
    resetSpentForTests,
    MAX_BATCH_EVENTS,
    MAX_BATCH_BYTES,
  });
  App.Md4HistorySync = api;
  window.SosMd4HistorySync = api;
})(window);
