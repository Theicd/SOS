/**
 * Account session resolver.
 * PRIMARY_ACCOUNT holds Root K. LINKED_DEVICE holds a verified MD3 and device keys.
 * GUEST has neither. Device signatures are never treated as Root-P signatures.
 */
(function initSosAccountSession(root) {
  'use strict';

  const App = root.NostrApp || (root.NostrApp = {});
  const HIST_KIND = 1050;
  const HIST_TAG = 'sos-hist-v1';

  const OPS = {
    VIEW_PRIVATE_UI: 'VIEW_PRIVATE_UI',
    VIEW_PROFILE: 'VIEW_PROFILE',
    READ_CONVERSATIONS: 'READ_CONVERSATIONS',
    SEND_CHAT: 'SEND_CHAT',
    READ_RECEIPTS: 'READ_RECEIPTS',
    START_CALL: 'START_CALL',
    RECEIVE_CALL: 'RECEIVE_CALL',
    SHARE_URL: 'SHARE_URL',
    SHARE_REPOST: 'SHARE_REPOST',
    REACT: 'REACT',
    POST: 'POST',
    MANAGE_SECURITY: 'MANAGE_SECURITY',
  };

  const LINKED_CAP = {
    VIEW_PRIVATE_UI: null,
    VIEW_PROFILE: null,
    READ_CONVERSATIONS: 'DEVICE_CHAT',
    SEND_CHAT: 'DEVICE_CHAT',
    READ_RECEIPTS: 'DEVICE_RECEIPTS',
    START_CALL: 'DEVICE_CALLS',
    RECEIVE_CALL: 'DEVICE_CALLS',
    SHARE_URL: null,
    SHARE_REPOST: false,
    REACT: false,
    POST: false,
    MANAGE_SECURITY: false,
  };

  let snapshot = {
    role: 'GUEST',
    verified: false,
    accountP: '',
    deviceSignPub: '',
    deviceId: '',
    caps: [],
    ROOT_K_PRESENT: false,
  };

  function norm(v) {
    return String(v || '').toLowerCase().replace(/^0x/, '').trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(norm(v));
  }

  function primaryReady() {
    const signer = App.SosCryptoSigner;
    return !!(
      App.guestMode === false &&
      isHex64(App.publicKey) &&
      signer &&
      typeof signer.hasIdentityKey === 'function' &&
      signer.hasIdentityKey() === true &&
      App.linkedDeviceSession !== true
    );
  }

  function setGuest() {
    snapshot = {
      role: 'GUEST',
      verified: false,
      accountP: '',
      deviceSignPub: '',
      deviceId: '',
      caps: [],
      ROOT_K_PRESENT: false,
    };
    return snapshot;
  }

  function setPrimary() {
    snapshot = {
      role: 'PRIMARY_ACCOUNT',
      verified: true,
      accountP: norm(App.publicKey),
      deviceSignPub: '',
      deviceId: '',
      caps: [],
      ROOT_K_PRESENT: true,
    };
    return snapshot;
  }

  function adoptVerified(info) {
    const accountP = norm(info && info.accountP);
    const deviceSignPub = norm(info && info.deviceSignPub);
    const deviceId = norm(info && info.deviceId);
    const caps = Array.isArray(info && info.caps) ? info.caps.map(String) : [];
    if (!isHex64(accountP) || !isHex64(deviceSignPub)) return setGuest();
    snapshot = {
      role: 'LINKED_DEVICE',
      verified: true,
      accountP: accountP,
      deviceSignPub: deviceSignPub,
      deviceId: deviceId,
      caps: caps,
      ROOT_K_PRESENT: false,
    };
    App.publicKey = accountP;
    App.privateKey = null;
    App.guestMode = false;
    App.linkedDeviceSession = true;
    App.identityState = 'LINKED_DEVICE';
    queueMicrotask(function () {
      if (typeof App.loadOwnProfileMetadata !== 'function') return;
      Promise.resolve(App.loadOwnProfileMetadata()).then(function () {
        if (typeof App.renderProfile === 'function') App.renderProfile();
      }).catch(function () {});
    });
    return snapshot;
  }

  function getAccountSession() {
    if (snapshot.role === 'LINKED_DEVICE' && snapshot.verified) return snapshot;
    if (primaryReady()) return setPrimary();
    if (snapshot.role === 'PRIMARY_ACCOUNT') return setGuest();
    return snapshot;
  }

  function allows(op) {
    const session = getAccountSession();
    const name = String(op || OPS.VIEW_PRIVATE_UI);
    if (session.role === 'PRIMARY_ACCOUNT') return name !== OPS.MANAGE_SECURITY ? true : true;
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return false;
    if (!Object.prototype.hasOwnProperty.call(LINKED_CAP, name)) return false;
    const need = LINKED_CAP[name];
    if (need === false) return false;
    if (need == null) return true;
    return session.caps.indexOf(need) !== -1;
  }

  function opForPrompt(text) {
    const t = String(text || '');
    if (/פרופיל/.test(t)) return OPS.VIEW_PROFILE;
    if (/הודע|צ׳אט|צ'אט|לחבר/.test(t)) return OPS.SEND_CHAT;
    if (/שיחה|קול|וידאו/.test(t)) return OPS.START_CALL;
    if (/לשתף בפיד/.test(t)) return OPS.SHARE_REPOST;
    if (/לייק|תגובה|פוסט|פרסם|שידור|למחוק|לדווח/.test(t)) return OPS.REACT;
    return OPS.VIEW_PRIVATE_UI;
  }

  function showLinkedDenial() {
    let box = document.getElementById('sosLdCapabilityDenied');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sosLdCapabilityDenied';
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:12050;background:#141414;color:#f5f5f5;border-radius:12px;padding:12px 16px;max-width:min(420px,92vw);text-align:center;font-size:14px;';
      document.body.appendChild(box);
    }
    box.textContent = 'הפעולה הזו נשארת בטלפון שמחזיק את מפתח החשבון.';
    clearTimeout(showLinkedDenial._t);
    showLinkedDenial._t = setTimeout(function () {
      if (box && box.parentNode) box.parentNode.removeChild(box);
    }, 2800);
  }

  async function restoreVerifiedLinkedDevice() {
    if (primaryReady()) return setPrimary();
    const Store = App.Md4DeviceStore || root.SosMd4DeviceStore;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!Store || typeof Store.loadLatest !== 'function' || !Auth || typeof Auth.verifyForDestination !== 'function') {
      return getAccountSession();
    }
    let loaded;
    try {
      loaded = await Store.loadLatest();
    } catch (_e) {
      return setGuest();
    }
    if (!loaded || loaded.ok !== true || !loaded.authorization) return setGuest();
    const verified = await Auth.verifyForDestination(loaded.authorization, {
      accountP: loaded.accountP,
      deviceId: loaded.deviceId,
      D_sign_pub: loaded.D_sign_pub,
      D_enc_pub: loaded.D_enc_pub,
    }, Date.now(), { requireHistorySync: false });
    if (!verified || verified.ok !== true) return setGuest();
    const caps = Array.isArray(loaded.authorization.capabilities) ? loaded.authorization.capabilities.map(String) : [];
    return adoptVerified({
      accountP: loaded.accountP,
      deviceSignPub: loaded.D_sign_pub,
      deviceId: loaded.deviceId,
      caps: caps,
    });
  }

  function readMd3Tag(event) {
    const tags = event && event.tags;
    if (!Array.isArray(tags)) return null;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'sos-md3' && typeof t[1] === 'string') {
        try { return JSON.parse(t[1]); } catch (_e) { return null; }
      }
    }
    return null;
  }

  function plainEvent(event) {
    if (!event || typeof event !== 'object') return null;
    try {
      return {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: JSON.parse(JSON.stringify(event.tags || [])),
        content: event.content,
        sig: event.sig,
      };
    } catch (_e) {
      return null;
    }
  }

  function verifyEventPlain(event) {
    const NT = root.NostrTools;
    if (!NT || typeof NT.verifyEvent !== 'function') return { ok: false, code: 'VERIFY_UNAVAILABLE' };
    const copy = plainEvent(event);
    if (!copy || typeof copy.sig !== 'string' || typeof copy.id !== 'string') return { ok: false, code: 'BAD_EVENT' };
    try {
      if (typeof NT.getEventHash === 'function') {
        const hash = NT.getEventHash(copy);
        if (typeof hash === 'string' && hash.toLowerCase() !== String(copy.id).toLowerCase()) {
          return { ok: false, code: 'HASH_MISMATCH' };
        }
      }
    } catch (_hash) {
      return { ok: false, code: 'HASH_THREW' };
    }
    try {
      if (NT.verifyEvent(copy) === true) return { ok: true, code: 'OK' };
      return { ok: false, code: 'BAD_EVENT_SIG' };
    } catch (_verify) {
      return { ok: false, code: 'VERIFY_THREW' };
    }
  }

  async function verifyDelegatedEvent(event, requiredCap) {
    if (!event || typeof event !== 'object') return { ok: false, code: 'BAD_EVENT' };
    const auth = readMd3Tag(event);
    if (!auth) return { ok: false, code: 'NO_DELEGATION' };
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!Auth || typeof Auth.verifyForDestination !== 'function') return { ok: false, code: 'AUTH_MODULE_MISSING' };
    const verified = await Auth.verifyForDestination(auth, {
      accountP: auth.accountP,
      deviceId: auth.deviceId,
      D_sign_pub: auth.D_sign_pub || auth.dSignPub,
      D_enc_pub: auth.D_enc_pub || auth.dEncPub,
    }, Date.now(), { requireHistorySync: false });
    if (!verified || verified.ok !== true) return { ok: false, code: (verified && verified.code) || 'DELEGATION_REJECTED' };
    const devicePub = norm(auth.D_sign_pub || auth.dSignPub);
    if (norm(event.pubkey) !== devicePub) return { ok: false, code: 'DEVICE_PUB_MISMATCH' };
    const sig = verifyEventPlain(event);
    if (!sig.ok) return { ok: false, code: 'BAD_EVENT_SIG', detail: sig.code || 'BAD_EVENT_SIG' };
    const rev = await loadRevocations(norm(auth.accountP));
    if (isRevokedDevice(rev, { deviceSignPub: devicePub, authorizationId: norm(auth.authorizationId) })) {
      return { ok: false, code: 'DEVICE_REVOKED' };
    }
    const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
    if (requiredCap && caps.indexOf(requiredCap) === -1) return { ok: false, code: 'CAPABILITY_MISSING' };
    noteVerifiedDevice(devicePub, auth.accountP);
    return { ok: true, accountP: norm(auth.accountP), deviceSignPub: devicePub, caps: caps };
  }

  function noteVerifiedDevice(devicePub, accountP) {
    const device = norm(devicePub);
    const account = norm(accountP);
    if (!isHex64(device) || !isHex64(account) || device === account) return;
    const map = root.__sosVerifiedDeviceOwners || (root.__sosVerifiedDeviceOwners = {});
    map[device] = account;
    if (typeof App.mergeDeviceConversationIntoAccount === 'function') {
      try { App.mergeDeviceConversationIntoAccount(device, account); } catch (_merge) {}
    }
  }

  function hexToBytes(hex) {
    const clean = norm(hex);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    return out;
  }

  async function withDevice(fn) {
    const LD = App.WebLinkedDevices || root.SosWebLinkedDevices;
    if (!LD || typeof LD.withLinkedDeviceSigner !== 'function') return { ok: false, code: 'NO_DEVICE' };
    return LD.withLinkedDeviceSigner(fn);
  }

  async function delegatedChatEncrypt(peer, text, messageId, extra) {
    const session = getAccountSession();
    if (!allows(OPS.SEND_CHAT)) return { ok: false, code: 'CAPABILITY_DENIED' };
    const opts = extra && typeof extra === 'object' ? extra : {};
    const deviceCopy = opts.deviceCopy === true;
    const devicePub = norm(opts.devicePub || '');
    const deviceEncPub = norm(opts.deviceEncPub || '');
    if (deviceCopy) {
      if (!isHex64(devicePub)) return { ok: false, code: 'BAD_DEVICE' };
      if (deviceEncPub && deviceEncPub === devicePub) return { ok: false, code: 'D_ENC_NOT_CHAT_RECIPIENT' };
    }
    const sibling = opts.sibling === true && !deviceCopy;
    const deliverTo = deviceCopy ? devicePub : (sibling ? session.accountP : norm(peer));
    if (!isHex64(deliverTo)) return { ok: false, code: 'BAD_RECIPIENT' };
    return withDevice(async function (dev) {
      const createdAt = Math.floor(Date.now() / 1000);
      const env = App.encryptPrivateChatPayload({
        senderPrivateKeyHex: dev.privHex,
        senderPubkey: dev.pub,
        recipientPubkey: deliverTo,
        payload: {
          messageId: messageId || ('ld-' + createdAt),
          sender: dev.pub,
          recipient: deliverTo,
          createdAt: createdAt,
          text: text,
          attachment: opts.attachment || null,
        },
      });
      const NT = root.NostrTools;
      if (!NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'FINALIZE_UNAVAILABLE' };
      const tags = [
        ['p', deliverTo],
        ['t', 'yalachat'],
        ['sos-md3', JSON.stringify(dev.authorization)],
      ];
      if (deviceCopy) {
        tags.push(['t', 'sos-device-copy']);
        if (messageId) tags.push(['e', String(messageId).slice(0, 80)]);
        if (opts.mirror === 'outgoing' && isHex64(norm(peer))) {
          tags.push(['t', 'sos-sibling-sync']);
          tags.push(['sync-peer', norm(peer)]);
        }
      } else if (sibling) {
        tags.push(['t', 'sos-sibling-sync']);
        tags.push(['sync-peer', norm(peer)]);
      }
      const draft = {
        kind: 1050,
        created_at: createdAt,
        pubkey: dev.pub,
        tags: tags,
        content: JSON.stringify(env),
      };
      const event = NT.finalizeEvent(draft, hexToBytes(dev.privHex));
      if (!event || norm(event.pubkey) !== dev.pub) return { ok: false, code: 'SIGN_FAILED' };
      const signed = verifyEventPlain(event);
      if (!signed.ok) return { ok: false, code: 'BAD_EVENT_SIG', detail: signed.code || 'BAD_EVENT_SIG' };
      return { ok: true, event: event, accountP: session.accountP, deviceSignPub: dev.pub };
    });
  }

  async function decryptForLinkedDevice(event, envelope, selfAuthored, intendedRecipient) {
    return withDevice(async function (dev) {
      const inner = App.decryptPrivateChatPayload({
        localPrivateKeyHex: dev.privHex,
        localPubkey: dev.pub,
        eventAuthorPubkey: event.pubkey,
        encryptedEnvelope: envelope,
        selfAuthored: selfAuthored === true,
        intendedRecipientPubkey: intendedRecipient,
      });
      return { ok: true, payload: inner, deviceSignPub: dev.pub, accountP: dev.accountP };
    });
  }

  function collectHistoryMessages() {
    const out = [];
    const unavailable = [];
    const conv = App.chatState && App.chatState.conversations;
    if (!conv || typeof conv.forEach !== 'function') return { messages: out, unavailable: unavailable, omitted: 0, complete: true };
    conv.forEach(function (entry) {
      const messages = entry && Array.isArray(entry.messages) ? entry.messages : [];
      messages.forEach(function (m) {
        if (!m || m.historySync === true) return;
        const text = typeof m.content === 'string' ? m.content : '';
        const peer = norm(entry.peer || (norm(m.from) === norm(App.publicKey) ? m.to : m.from));
        if (!isHex64(peer)) return;
        let attachment = null;
        if (m.attachment) {
          const att = m.attachment;
          const logical = String(m.logicalMessageId || m.id || '');
          if (att.type === 'encrypted-media' && att.cipher && typeof att.cipher.sha256 === 'string') {
            attachment = {
              type: 'encrypted-media',
              name: typeof att.name === 'string' ? att.name.slice(0, 180) : '',
              mime: typeof att.mime === 'string' ? att.mime.slice(0, 80) : '',
              sha256: String(att.cipher.sha256),
              url: typeof att.url === 'string' ? att.url.slice(0, 300) : '',
              cipher: { sha256: String(att.cipher.sha256) },
            };
          } else {
            unavailable.push({
              id: logical,
              name: att && typeof att.name === 'string' ? att.name.slice(0, 180) : '',
              hash: att && typeof (att.sha256 || att.hash || (att.cipher && att.cipher.sha256)) === 'string' ? String(att.sha256 || att.hash || att.cipher.sha256) : '',
              reason: 'ATTACHMENT_BYTES_UNAVAILABLE',
            });
          }
        }
        if (!text.trim() && !m.attachment) return;
        out.push({
          id: String(m.logicalMessageId || m.id || ''),
          peer: peer,
          text: text,
          direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
          createdAt: Number(m.createdAt) || Math.floor(Date.now() / 1000),
          deleted: m.deleted === true || m.tombstone === true,
          attachment: attachment,
        });
      });
    });
    let omitted = 0;
    let packed = out;
    let body = JSON.stringify(packed);
    while (body.length > 48000 && packed.length > 1) {
      packed = packed.slice(1);
      omitted += 1;
      body = JSON.stringify(packed);
    }
    if (body.length > 48000 && packed.length === 1) {
      packed = [{ id: packed[0].id, peer: packed[0].peer, text: '', direction: packed[0].direction, createdAt: packed[0].createdAt, deleted: packed[0].deleted, reason: 'MESSAGE_TOO_LARGE' }];
      omitted += 1;
    }
    return { messages: packed, unavailable: unavailable, omitted: omitted, complete: omitted === 0 && unavailable.length === 0 };
  }

  async function publishLinkedHistoryBundle(devicePub) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const peer = norm(devicePub);
    if (!isHex64(peer)) return { ok: false, code: 'BAD_DEVICE' };
    const signer = App.SosCryptoSigner;
    if (!signer || typeof signer.nip44ChatEncrypt !== 'function' || typeof signer.signLinkedHistory !== 'function') {
      return { ok: false, code: 'SIGNER_MISSING' };
    }
    const snapshot = collectHistoryMessages();
    const messages = snapshot.messages || [];
    const createdAt = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      v: 2,
      type: HIST_TAG,
      accountP: norm(App.publicKey),
      messages: messages,
      unavailable: snapshot.unavailable || [],
      omitted: snapshot.omitted || 0,
      complete: snapshot.complete === true,
    });
    const env = await Promise.resolve(signer.nip44ChatEncrypt({
      senderPubkey: norm(App.publicKey),
      recipientPubkey: peer,
      payload: {
        messageId: 'hist-' + createdAt,
        sender: norm(App.publicKey),
        recipient: peer,
        createdAt: createdAt,
        text: body,
        attachment: null,
      },
    }));
    if (!env || typeof env.ct !== 'string') return { ok: false, code: 'ENCRYPT_FAILED' };
    const event = await Promise.resolve(signer.signLinkedHistory({
      kind: HIST_KIND,
      created_at: createdAt,
      tags: [['p', peer], ['t', HIST_TAG]],
      content: JSON.stringify(env),
    }));
    if (!event || !event.id) return { ok: false, code: 'SIGN_FAILED' };
    const pool = App.pool;
    if (!pool || typeof pool.publish !== 'function') return { ok: false, code: 'NO_POOL' };
    const published = pool.publish(App.relayUrls, event);
    const pending = Array.isArray(published) ? published : [published];
    const settled = await Promise.allSettled(pending.map(function (p) { return Promise.resolve(p); }));
    const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
    if (!accepted) return { ok: false, code: 'RELAY_REJECTED', count: messages.length };
    return {
      ok: true,
      count: messages.length,
      id: String(event.id).slice(0, 12),
      HISTORY_SYNC_TRANSFERRED: messages.length > 0,
      HISTORY_SYNC_COMPLETE: snapshot.complete === true,
      omitted: snapshot.omitted || 0,
      unavailable: (snapshot.unavailable || []).length,
    };
  }

  function hasHistTag(event) {
    return Array.isArray(event && event.tags) && event.tags.some(function (t) {
      return Array.isArray(t) && t[0] === 't' && t[1] === HIST_TAG;
    });
  }

  function rememberHistory(result) {
    root.__sosLdHistorySync = result;
    return result;
  }

  async function acceptHistoryEvent(event) {
    if (!hasHistTag(event)) return rememberHistory({ ok: false, code: 'NOT_HISTORY', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified) return rememberHistory({ ok: false, code: 'NOT_LINKED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    if (!allows('READ_CONVERSATIONS')) return rememberHistory({ ok: false, code: 'CAPABILITY_DENIED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    const histSig = verifyEventPlain(event);
    if (!histSig.ok) return rememberHistory({ ok: false, code: 'BAD_EVENT_SIG', detail: histSig.code || 'BAD_EVENT_SIG', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    if (norm(event.pubkey) !== session.accountP) return rememberHistory({ ok: false, code: 'ACCOUNT_MISMATCH', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    let env;
    try { env = JSON.parse(event.content); } catch (_e) { return rememberHistory({ ok: false, code: 'BAD_ENVELOPE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false }); }
    const opened = await decryptForLinkedDevice(event, env, false, null);
    if (!opened || opened.ok !== true || !opened.payload) return rememberHistory({ ok: false, code: (opened && opened.code) || 'DECRYPT_FAILED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    let bundle;
    try { bundle = JSON.parse(opened.payload.text); } catch (_e2) { return rememberHistory({ ok: false, code: 'BAD_BUNDLE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false }); }
    if (!bundle || bundle.type !== HIST_TAG || norm(bundle.accountP) !== session.accountP) return rememberHistory({ ok: false, code: 'BAD_BUNDLE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    const list = Array.isArray(bundle.messages) ? bundle.messages : [];
    let n = 0;
    list.forEach(function (m) {
      if (!m || typeof m.text !== 'string' || !isHex64(m.peer) || typeof App.appendChatMessage !== 'function') return;
      const outgoing = m.direction === 'outgoing';
      const histAttachment = m.attachment && m.attachment.type === 'encrypted-media' ? m.attachment : null;
      App.appendChatMessage({
        id: 'hist-' + String(m.id || n),
        from: outgoing ? session.accountP : m.peer,
        to: outgoing ? m.peer : session.accountP,
        content: m.text,
        attachment: histAttachment,
        createdAt: Number(m.createdAt) || Math.floor(Date.now() / 1000),
        direction: outgoing ? 'outgoing' : 'incoming',
        status: m.deleted === true ? 'deleted' : 'delivered',
        deleted: m.deleted === true,
        tombstone: m.deleted === true,
        source: 'HISTORY_SYNC',
        historySync: true,
        logicalMessageId: String(m.id || ''),
      });
      n += 1;
    });
    const unavailable = Array.isArray(bundle.unavailable) ? bundle.unavailable : [];
    const omitted = Number(bundle.omitted) || 0;
    const complete = bundle.complete === true && unavailable.length === 0 && omitted === 0;
    root.__sosLdHistorySync = { ok: true, count: n, HISTORY_SYNC_COMPLETE: complete, omitted: omitted, unavailable: unavailable.length, FAKE_HISTORY_SYNC: false };
    return root.__sosLdHistorySync;
  }

  async function pullLinkedHistory() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !allows('READ_CONVERSATIONS')) {
      return { ok: false, code: 'NOT_LINKED' };
    }
    const pool = App.pool;
    if (!pool || typeof pool.get !== 'function' || !isHex64(session.deviceSignPub)) return { ok: false, code: 'NO_POOL' };
    let events = [];
    try {
      const filter = {
        kinds: [HIST_KIND],
        '#p': [session.deviceSignPub],
        '#t': [HIST_TAG],
        authors: [session.accountP],
        limit: 8,
      };
      if (typeof pool.list === 'function') events = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') {
        const result = await pool.querySync(App.relayUrls, filter);
        events = Array.isArray(result && result.events) ? result.events : (Array.isArray(result) ? result : []);
      } else if (typeof pool.get === 'function') {
        const ev = await pool.get(App.relayUrls, filter);
        events = ev ? [ev] : [];
      }
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    if (!Array.isArray(events) || !events.length) return { ok: false, code: 'NO_EVENT' };
    let last = { ok: false, code: 'NO_EVENT', HISTORY_SYNC_COMPLETE: false };
    for (let i = 0; i < events.length; i += 1) last = await acceptHistoryEvent(events[i]);
    return last;
  }

  async function pullLinkedDirectMessages() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !allows('READ_CONVERSATIONS')) {
      return { ok: false, code: 'NOT_LINKED' };
    }
    const pool = App.pool;
    if (!pool || !isHex64(session.deviceSignPub)) return { ok: false, code: 'NO_POOL' };
    const filter = { kinds: [1050], '#p': [session.deviceSignPub], '#t': ['yalachat'], limit: 20 };
    let events = [];
    try {
      if (typeof pool.list === 'function') events = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') events = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    if (!Array.isArray(events)) events = [];
    for (let i = 0; i < events.length; i += 1) {
      if (typeof App.handleIncomingChatEvent === 'function') {
        try { await App.handleIncomingChatEvent(events[i]); } catch (_in) {}
      }
    }
    root.__sosLdChatPull = { n: events.length };
    return { ok: true, n: events.length };
  }

  async function announceLinkedDevice() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return { ok: false, code: 'NOT_LINKED' };
    const Store = App.Md4DeviceStore || root.SosMd4DeviceStore;
    if (!Store || typeof Store.loadLatest !== 'function') return { ok: false, code: 'NO_STORE' };
    let loaded;
    try { loaded = await Store.loadLatest(); } catch (_e) { return { ok: false, code: 'NO_STORE' }; }
    if (!loaded || loaded.ok !== true || !loaded.authorization) return { ok: false, code: 'NO_AUTH' };
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!pool || typeof pool.publish !== 'function' || !NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'NO_POOL' };
    return withDevice(async function (dev) {
      if (norm(dev.pub) !== norm(loaded.D_sign_pub)) return { ok: false, code: 'DEVICE_MISMATCH' };
      const event = NT.finalizeEvent({
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'sos-device-directory'],
          ['p', session.accountP],
          ['t', 'sos-devdir-v1'],
        ],
        content: JSON.stringify({
          v: 1,
          authorization: loaded.authorization,
          deviceLabel: directoryDeviceLabel(),
        }),
      }, hexToBytes(dev.privHex));
      const published = pool.publish(App.relayUrls, event);
      const pending = Array.isArray(published) ? published : [published];
      const settled = await Promise.allSettled(pending.map(function (p) { return Promise.resolve(p); }));
      const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
      return accepted ? { ok: true, device: session.deviceSignPub.slice(0, 8) } : { ok: false, code: 'RELAY_REJECTED' };
    });
  }

  function flattenRelayEvents(raw) {
    const out = [];
    const stack = Array.isArray(raw) ? raw.slice() : (raw ? [raw] : []);
    while (stack.length) {
      const item = stack.shift();
      if (!item) continue;
      if (Array.isArray(item)) { stack.push.apply(stack, item); continue; }
      if (item.kind && item.pubkey && item.id) out.push(item);
    }
    return out;
  }

  const REVOKE_TAG = 'sos-device-revocation';
  const revokeCache = {};
  let directoryHeartbeat = 0;

  async function loadRevocations(accountP, opts) {
    const account = norm(accountP);
    const fresh = !!(opts && opts.fresh);
    if (!isHex64(account)) return { ok: false, code: 'BAD_ACCOUNT', pubs: {}, ids: {}, list: [] };
    const hit = revokeCache[account];
    if (!fresh && hit && hit.exp > Date.now()) return hit.value;
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!pool || !NT || typeof NT.verifyEvent !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY', pubs: {}, ids: {}, list: [] };
    }
    const filter = { kinds: [30078], authors: [account], '#d': [REVOKE_TAG], limit: 3 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED', pubs: {}, ids: {}, list: [] };
    }
    const events = flattenRelayEvents(raw);
    let newest = null;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (norm(event.pubkey) !== account || verifyEventPlain(event).ok !== true) continue;
      const marked = (event.tags || []).some(function (tag) { return tag && tag[0] === 'd' && tag[1] === REVOKE_TAG; });
      if (!marked) continue;
      if (!newest || Number(event.created_at) >= Number(newest.created_at)) newest = event;
    }
    const pubs = {};
    const ids = {};
    const list = [];
    if (newest) {
      let body = null;
      try { body = JSON.parse(newest.content); } catch (_p) { body = null; }
      const rows = body && Array.isArray(body.revoked) ? body.revoked : [];
      for (let i = 0; i < rows.length && list.length < 32; i += 1) {
        const row = rows[i];
        const pub = norm(row && row.deviceSignPub);
        const id = norm(row && row.authorizationId);
        if (!isHex64(pub) || !isHex64(id) || pubs[pub]) continue;
        pubs[pub] = true;
        ids[id] = true;
        list.push({ deviceSignPub: pub, authorizationId: id, at: Math.max(1, Math.floor(Number(row.at) || Date.now())) });
      }
    }
    const value = { ok: true, code: newest ? 'REVOKED' : 'EMPTY', pubs: pubs, ids: ids, list: list };
    revokeCache[account] = { exp: Date.now() + 20000, value: value };
    return value;
  }

  function isRevokedDevice(rev, row) {
    if (!rev || rev.ok !== true || !row) return false;
    const pub = norm(row.deviceSignPub || row.D_sign_pub);
    const id = norm(row.authorizationId);
    return !!(pub && rev.pubs[pub]) || !!(id && rev.ids[id]);
  }

  function releaseLinkedDevice(reason) {
    if (snapshot.role !== 'LINKED_DEVICE') return { ok: false, code: 'NOT_LINKED' };
    App.linkedDeviceSession = false;
    App.publicKey = '';
    App.privateKey = null;
    App.guestMode = true;
    App.identityState = 'GUEST';
    setGuest();
    if (directoryHeartbeat) {
      clearInterval(directoryHeartbeat);
      directoryHeartbeat = 0;
    }
    return { ok: true, code: reason || 'DEVICE_REVOKED' };
  }

  async function watchOwnRevocation() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !isHex64(session.deviceSignPub)) return { ok: true };
    const rev = await loadRevocations(session.accountP, { fresh: true });
    if (!rev || rev.ok !== true || !isRevokedDevice(rev, session)) return { ok: true };
    releaseLinkedDevice('DEVICE_REVOKED');
    try {
      root.dispatchEvent(new CustomEvent('sos-ld-device-revoked'));
    } catch (_e) {}
    return { ok: false, code: 'DEVICE_REVOKED' };
  }

  async function revokeLinkedDevice(device) {
    const session = getAccountSession();
    if (session.role !== 'PRIMARY_ACCOUNT' || !primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const signer = App.SosCryptoSigner;
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!signer || typeof signer.signDeviceRevoke !== 'function' || typeof signer.hasIdentityKey !== 'function' || signer.hasIdentityKey() !== true || !pool || !NT) {
      return { ok: false, code: 'NO_SIGNER' };
    }
    const pub = norm(device && device.deviceSignPub);
    const authorizationId = norm(device && device.authorizationId);
    if (!isHex64(pub) || !isHex64(authorizationId)) return { ok: false, code: 'BAD_DEVICE' };
    const current = await loadRevocations(session.accountP, { fresh: true });
    if (!current || current.ok !== true) return { ok: false, code: (current && current.code) || 'QUERY_FAILED' };
    const list = current.list.filter(function (row) { return row.deviceSignPub !== pub; });
    list.push({ deviceSignPub: pub, authorizationId: authorizationId, at: Date.now() });
    const body = { v: 1, revoked: list.slice(-32) };
    let signed;
    try {
      signed = await Promise.resolve(signer.signDeviceRevoke({
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', REVOKE_TAG]],
        content: JSON.stringify(body),
        pubkey: session.accountP,
      }));
    } catch (err) {
      return { ok: false, code: (err && err.code) || 'SIGN_FAILED' };
    }
    if (!signed || verifyEventPlain(signed).ok !== true || norm(signed.pubkey) !== session.accountP) {
      return { ok: false, code: 'BAD_SIGNATURE' };
    }
    const published = pool.publish(App.relayUrls, signed);
    const pending = Array.isArray(published) ? published : [published];
    const settled = await Promise.allSettled(pending.map(function (p) { return Promise.resolve(p); }));
    const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
    if (!accepted) return { ok: false, code: 'RELAY_REJECTED' };
    const pubs = {};
    const ids = {};
    body.revoked.forEach(function (row) {
      pubs[row.deviceSignPub] = true;
      ids[row.authorizationId] = true;
    });
    const value = { ok: true, code: 'REVOKED', pubs: pubs, ids: ids, list: body.revoked };
    revokeCache[session.accountP] = { exp: Date.now() + 20000, value: value };
    const cache = root.__sosDeviceAccountCache;
    if (cache) delete cache[pub];
    return { ok: true, code: 'REVOKED' };
  }

  function directoryDeviceLabel() {
    try {
      const nav = root.navigator;
      const raw = String((nav && nav.userAgentData && nav.userAgentData.platform) || (nav && nav.userAgent) || '');
      if (/Windows/i.test(raw)) return 'Windows';
      if (/Android/i.test(raw)) return 'Android';
      if (/iPhone|iPad/i.test(raw)) return 'iPhone';
      if (/Mac/i.test(raw)) return 'Mac';
      if (/CrOS/i.test(raw)) return 'ChromeOS';
      if (/Linux/i.test(raw)) return 'Linux';
    } catch (_e) {}
    return 'מחשב';
  }

  function safeDirectoryLabel(value) {
    const text = String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
    if (!text || /nsec|private|secret/i.test(text)) return '';
    return text;
  }

  async function collectVerifiedDirectory(accountP, requiredCap, opts) {
    const account = norm(accountP);
    const cap = requiredCap ? String(requiredCap) : '';
    if (!isHex64(account)) return { ok: false, code: 'BAD_ACCOUNT', devices: [] };
    const pool = App.pool;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    const NT = root.NostrTools;
    if (!pool || !Auth || typeof Auth.verifyForDestination !== 'function' || !NT || typeof NT.verifyEvent !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY', devices: [] };
    }
    const filter = { kinds: [30078], '#p': [account], '#d': ['sos-device-directory'], limit: 20 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED', devices: [] };
    }
    const events = flattenRelayEvents(raw);
    const rev = await loadRevocations(account, opts);
    const best = {};
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (verifyEventPlain(event).ok !== true) continue;
      let body = null;
      try { body = JSON.parse(event.content); } catch (_p) { continue; }
      const auth = body && body.authorization;
      if (!auth || norm(auth.accountP) !== account || norm(auth.D_sign_pub) !== norm(event.pubkey)) continue;
      const verified = await Auth.verifyForDestination(auth, {
        accountP: auth.accountP,
        deviceId: auth.deviceId,
        D_sign_pub: auth.D_sign_pub,
        D_enc_pub: auth.D_enc_pub,
      }, Date.now(), { requireHistorySync: false });
      if (!verified || verified.ok !== true) continue;
      const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
      if (cap && caps.indexOf(cap) === -1) continue;
      const signPub = norm(auth.D_sign_pub);
      const authorizationId = norm(auth.authorizationId);
      if (!isHex64(signPub) || isRevokedDevice(rev, { deviceSignPub: signPub, authorizationId: authorizationId })) continue;
      const row = {
        deviceId: norm(auth.deviceId) || signPub,
        deviceSignPub: signPub,
        deviceEncPub: norm(auth.D_enc_pub),
        authorizationId: authorizationId,
        expiresAt: Number(auth.expiresAt) || 0,
        caps: caps,
        deviceLabel: safeDirectoryLabel(body.deviceLabel) || safeDirectoryLabel(auth.deviceLabel) || 'מחשב',
        linkedAt: Number(auth.createdAt) || 0,
        lastSeenAt: (Number(event.created_at) || 0) * 1000,
      };
      const prev = best[signPub];
      if (!prev || row.lastSeenAt >= prev.lastSeenAt) best[signPub] = row;
    }
    return { ok: true, devices: Object.keys(best).map(function (id) { return best[id]; }) };
  }

  async function listAuthorizedDevices(accountP, requiredCap) {
    const listed = await collectVerifiedDirectory(accountP, requiredCap ? String(requiredCap) : 'DEVICE_CHAT');
    return listed.devices;
  }

  async function listAccountLinkedDevices(accountP) {
    return collectVerifiedDirectory(accountP, '', { fresh: true });
  }

  async function resolveDeviceAccount(devicePub) {
    const device = norm(devicePub);
    if (!isHex64(device)) return { ok: false, code: 'BAD_DEVICE' };
    const cache = root.__sosDeviceAccountCache || (root.__sosDeviceAccountCache = {});
    const hit = cache[device];
    if (hit && hit.exp > Date.now()) return hit.value;
    const pool = App.pool;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!pool || !Auth || typeof Auth.verifyForDestination !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY' };
    }
    const filter = { kinds: [30078], authors: [device], '#d': ['sos-device-directory'], limit: 5 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    const events = flattenRelayEvents(raw);
    let value = { ok: false, code: 'NO_DIRECTORY' };
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (norm(event.pubkey) !== device || verifyEventPlain(event).ok !== true) continue;
      let body = null;
      try { body = JSON.parse(event.content); } catch (_p) { continue; }
      const auth = body && body.authorization;
      if (!auth || norm(auth.D_sign_pub || auth.dSignPub) !== device || !isHex64(auth.accountP)) continue;
      const verified = await Auth.verifyForDestination(auth, {
        accountP: auth.accountP,
        deviceId: auth.deviceId,
        D_sign_pub: auth.D_sign_pub || auth.dSignPub,
        D_enc_pub: auth.D_enc_pub || auth.dEncPub,
      }, Date.now(), { requireHistorySync: false });
      if (!verified || verified.ok !== true) continue;
      const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
      const signPub = device;
      if (isRevokedDevice(await loadRevocations(norm(auth.accountP)), { deviceSignPub: signPub, authorizationId: norm(auth.authorizationId) })) continue;
      value = {
        ok: true,
        accountP: norm(auth.accountP),
        deviceId: norm(auth.deviceId),
        deviceSignPub: device,
        caps: caps,
      };
      noteVerifiedDevice(device, auth.accountP);
      break;
    }
    cache[device] = { exp: Date.now() + (value.ok ? 60000 : 15000), value: value };
    return value;
  }

  async function resubscribeLinkedTransports() {
    try { await watchOwnRevocation(); } catch (_rev) {}
    if (getAccountSession().role !== 'LINKED_DEVICE') return;
    if (typeof App.ensureSecureChatEpochReady === 'function') {
      try { await App.ensureSecureChatEpochReady(); } catch (_epoch) {}
    }
    const ready = typeof App.isSecureChatReady !== 'function' || App.isSecureChatReady() === true;
    if (ready) {
      try {
        if (typeof App.stopPrivateChatSubscription === 'function') App.stopPrivateChatSubscription('linked-device');
      } catch (_e) {}
      try {
        if (typeof App.subscribeToChatEvents === 'function') App.subscribeToChatEvents();
      } catch (_e2) {}
    }
    try {
      if (typeof App.rebindLinkedDeviceP2P === 'function') App.rebindLinkedDeviceP2P();
    } catch (_p2p) {}
    try { await announceLinkedDevice(); } catch (_ann) {}
    if (!directoryHeartbeat) {
      directoryHeartbeat = setInterval(function () {
        announceLinkedDevice().catch(function () {});
        watchOwnRevocation().catch(function () {});
      }, 120000);
    }
    try {
      const calls = App.CallSignalE2ee;
      if (calls && typeof calls.ensureSecureCallSubscription === 'function') {
        calls.ensureSecureCallSubscription({ force: true, reason: 'linked-device' });
      }
    } catch (_e3) {}
    try {
      await pullLinkedHistory();
      await pullLinkedDirectMessages();
    } catch (_e4) {}
  }

  function verifiedAccountOf(pubkey) {
    const pk = norm(pubkey);
    if (!isHex64(pk)) return '';
    const map = root.__sosVerifiedDeviceOwners;
    const owner = map && typeof map[pk] === 'string' ? norm(map[pk]) : '';
    return isHex64(owner) && owner !== pk ? owner : '';
  }

  // Verified MD3 only. A directory miss stays the pubkey; unknown keys are not merged.
  async function canonicalPeer(pubkey, requiredCap) {
    const pk = norm(pubkey);
    if (!isHex64(pk)) return '';
    const cached = verifiedAccountOf(pk);
    if (cached) return cached;
    const resolved = await resolveDeviceAccount(pk);
    if (!resolved || resolved.ok !== true || !isHex64(resolved.accountP) || resolved.accountP === pk) return pk;
    const caps = Array.isArray(resolved.caps) ? resolved.caps : [];
    const need = requiredCap || 'DEVICE_CHAT';
    if (caps.indexOf(need) === -1 && caps.indexOf('DEVICE_CHAT') === -1 && caps.indexOf('DEVICE_FILES') === -1 && caps.indexOf('DEVICE_CALLS') === -1) {
      return pk;
    }
    return resolved.accountP;
  }

  async function resolveVerifiedActor(event) {
    const devicePub = norm(event && event.pubkey);
    const empty = { ok: false, accountP: '', devicePub: '', deviceId: '', authorization: '', capabilities: [] };
    if (!isHex64(devicePub)) return Object.assign({}, empty, { code: 'BAD_PUBKEY' });
    const tagged = event && event.__sosDelegatedAccount ? norm(event.__sosDelegatedAccount) : '';
    if (isHex64(tagged) && tagged !== devicePub) {
      return { ok: true, accountP: tagged, devicePub: devicePub, deviceId: '', authorization: 'md3-event', capabilities: [] };
    }
    const cached = verifiedAccountOf(devicePub);
    if (cached) {
      return { ok: true, accountP: cached, devicePub: devicePub, deviceId: '', authorization: 'md3-cache', capabilities: [] };
    }
    const resolved = await resolveDeviceAccount(devicePub);
    if (resolved && resolved.ok === true && isHex64(resolved.accountP) && resolved.accountP !== devicePub) {
      const caps = Array.isArray(resolved.caps) ? resolved.caps : [];
      return {
        ok: true,
        accountP: resolved.accountP,
        devicePub: devicePub,
        deviceId: resolved.deviceId || '',
        authorization: 'md3-directory',
        capabilities: caps,
      };
    }
    return { ok: true, accountP: devicePub, devicePub: '', deviceId: '', authorization: 'direct-account', capabilities: [] };
  }

  App.getAccountSession = getAccountSession;
  App.accountSessionAllows = allows;
  App.accountSessionOpForPrompt = opForPrompt;
  App.showLinkedCapabilityDenial = showLinkedDenial;
  App.adoptLinkedDeviceSession = adoptVerified;
  App.SosAccountSession = {
    OPS: OPS,
    HIST_KIND: HIST_KIND,
    restoreVerifiedLinkedDevice: restoreVerifiedLinkedDevice,
    getAccountSession: getAccountSession,
    allows: allows,
    adoptVerified: adoptVerified,
    opForPrompt: opForPrompt,
    showLinkedDenial: showLinkedDenial,
    verifyDelegatedEvent: verifyDelegatedEvent,
    delegatedChatEncrypt: delegatedChatEncrypt,
    decryptForLinkedDevice: decryptForLinkedDevice,
    publishLinkedHistoryBundle: publishLinkedHistoryBundle,
    pullLinkedHistory: pullLinkedHistory,
    pullLinkedDirectMessages: pullLinkedDirectMessages,
    announceLinkedDevice: announceLinkedDevice,
    listAuthorizedDevices: listAuthorizedDevices,
    listAccountLinkedDevices: listAccountLinkedDevices,
    revokeLinkedDevice: revokeLinkedDevice,
    releaseLinkedDevice: releaseLinkedDevice,
    resolveDeviceAccount: resolveDeviceAccount,
    verifiedAccountOf: verifiedAccountOf,
    canonicalPeer: canonicalPeer,
    resolveVerifiedActor: resolveVerifiedActor,
    verifyEventPlain: verifyEventPlain,
    acceptHistoryEvent: acceptHistoryEvent,
    resubscribeLinkedTransports: resubscribeLinkedTransports,
    ROOT_K_ON_DESKTOP: false,
  };
  root.SosAccountSession = App.SosAccountSession;
})(window);
