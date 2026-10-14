/**
 * Account session resolver.
 * PRIMARY_ACCOUNT holds Root K. LINKED_DEVICE holds a verified MD3 and device keys.
 * GUEST has neither. Device signatures are never treated as Root-P signatures.
 */
(function initSosAccountSession(root) {
  'use strict';

  const App = root.NostrApp || (root.NostrApp = {});
  const HIST_KIND = 22243;
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

  async function verifyDelegatedEvent(event, requiredCap) {
    if (!event || typeof event !== 'object') return { ok: false, code: 'BAD_EVENT' };
    const auth = readMd3Tag(event);
    if (!auth) return { ok: false, code: 'NO_DELEGATION' };
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    const NT = root.NostrTools;
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
    let sigOk = false;
    try {
      sigOk = !!(NT && typeof NT.verifyEvent === 'function' && NT.verifyEvent(event));
    } catch (_e) {
      sigOk = false;
    }
    if (!sigOk) return { ok: false, code: 'BAD_EVENT_SIG' };
    const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
    if (requiredCap && caps.indexOf(requiredCap) === -1) return { ok: false, code: 'CAPABILITY_MISSING' };
    return { ok: true, accountP: norm(auth.accountP), deviceSignPub: devicePub, caps: caps };
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

  async function delegatedChatEncrypt(peer, text, messageId) {
    const session = getAccountSession();
    if (!allows(OPS.SEND_CHAT)) return { ok: false, code: 'CAPABILITY_DENIED' };
    return withDevice(async function (dev) {
      const createdAt = Math.floor(Date.now() / 1000);
      const env = App.encryptPrivateChatPayload({
        senderPrivateKeyHex: dev.privHex,
        senderPubkey: dev.pub,
        recipientPubkey: peer,
        payload: {
          messageId: messageId || ('ld-' + createdAt),
          sender: dev.pub,
          recipient: norm(peer),
          createdAt: createdAt,
          text: text,
          attachment: null,
        },
      });
      const NT = root.NostrTools;
      if (!NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'FINALIZE_UNAVAILABLE' };
      const draft = {
        kind: 1050,
        created_at: createdAt,
        pubkey: dev.pub,
        tags: [
          ['p', norm(peer)],
          ['t', 'yalachat'],
          ['sos-md3', JSON.stringify(dev.authorization)],
        ],
        content: JSON.stringify(env),
      };
      const event = NT.finalizeEvent(draft, hexToBytes(dev.privHex));
      if (!event || norm(event.pubkey) !== dev.pub) return { ok: false, code: 'SIGN_FAILED' };
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
    const conv = App.chatState && App.chatState.conversations;
    if (!conv || typeof conv.forEach !== 'function') return out;
    conv.forEach(function (entry) {
      const messages = entry && Array.isArray(entry.messages) ? entry.messages : [];
      messages.forEach(function (m) {
        if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
        if (m.historySync === true) return;
        const peer = norm(entry.peer || (norm(m.from) === norm(App.publicKey) ? m.to : m.from));
        if (!isHex64(peer)) return;
        out.push({
          id: String(m.id || '').slice(0, 80),
          peer: peer,
          text: m.content.slice(0, 500),
          direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
          createdAt: Number(m.createdAt) || Math.floor(Date.now() / 1000),
        });
      });
    });
    return out.slice(-20);
  }

  async function publishLinkedHistoryBundle(devicePub) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const peer = norm(devicePub);
    if (!isHex64(peer)) return { ok: false, code: 'BAD_DEVICE' };
    const signer = App.SosCryptoSigner;
    if (!signer || typeof signer.nip44ChatEncrypt !== 'function' || typeof signer.signLinkedHistory !== 'function') {
      return { ok: false, code: 'SIGNER_MISSING' };
    }
    const messages = collectHistoryMessages();
    const createdAt = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ v: 1, type: HIST_TAG, accountP: norm(App.publicKey), messages: messages });
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
    await pool.publish(App.relayUrls, event);
    return { ok: true, count: messages.length, id: String(event.id).slice(0, 12), HISTORY_SYNC_TRANSFERRED: messages.length > 0 };
  }

  async function acceptHistoryEvent(event) {
    if (!event || event.kind !== HIST_KIND) return { ok: false, code: 'NOT_HISTORY' };
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified) return { ok: false, code: 'NOT_LINKED' };
    if (!allows('READ_CONVERSATIONS')) return { ok: false, code: 'CAPABILITY_DENIED' };
    const NT = root.NostrTools;
    if (!NT || typeof NT.verifyEvent !== 'function' || NT.verifyEvent(event) !== true) return { ok: false, code: 'BAD_EVENT_SIG' };
    if (norm(event.pubkey) !== session.accountP) return { ok: false, code: 'ACCOUNT_MISMATCH' };
    let env;
    try { env = JSON.parse(event.content); } catch (_e) { return { ok: false, code: 'BAD_ENVELOPE' }; }
    const opened = await decryptForLinkedDevice(event, env, false, null);
    if (!opened || opened.ok !== true || !opened.payload) return { ok: false, code: (opened && opened.code) || 'DECRYPT_FAILED' };
    let bundle;
    try { bundle = JSON.parse(opened.payload.text); } catch (_e2) { return { ok: false, code: 'BAD_BUNDLE' }; }
    if (!bundle || bundle.type !== HIST_TAG || norm(bundle.accountP) !== session.accountP) return { ok: false, code: 'BAD_BUNDLE' };
    const list = Array.isArray(bundle.messages) ? bundle.messages : [];
    let n = 0;
    list.forEach(function (m) {
      if (!m || typeof m.text !== 'string' || !isHex64(m.peer) || typeof App.appendChatMessage !== 'function') return;
      const outgoing = m.direction === 'outgoing';
      App.appendChatMessage({
        id: 'hist-' + String(m.id || n),
        from: outgoing ? session.accountP : m.peer,
        to: outgoing ? m.peer : session.accountP,
        content: m.text,
        createdAt: Number(m.createdAt) || Math.floor(Date.now() / 1000),
        direction: outgoing ? 'outgoing' : 'incoming',
        status: 'delivered',
        source: 'HISTORY_SYNC',
        historySync: true,
      });
      n += 1;
    });
    root.__sosLdHistorySync = { ok: true, count: n, HISTORY_SYNC_COMPLETE: true, FAKE_HISTORY_SYNC: false };
    return { ok: true, count: n, HISTORY_SYNC_COMPLETE: true };
  }

  async function resubscribeLinkedTransports() {
    try {
      if (typeof App.stopPrivateChatSubscription === 'function') App.stopPrivateChatSubscription('linked-device');
    } catch (_e) {}
    try {
      if (typeof App.subscribeToChatEvents === 'function') App.subscribeToChatEvents();
    } catch (_e2) {}
    try {
      const calls = App.CallSignalE2ee;
      if (calls && typeof calls.ensureSecureCallSubscription === 'function') {
        calls.ensureSecureCallSubscription({ force: true, reason: 'linked-device' });
      }
    } catch (_e3) {}
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
    acceptHistoryEvent: acceptHistoryEvent,
    resubscribeLinkedTransports: resubscribeLinkedTransports,
    ROOT_K_ON_DESKTOP: false,
  };
  root.SosAccountSession = App.SosAccountSession;
})(window);
