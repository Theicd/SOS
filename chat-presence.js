/* __F2B_AWAIT_WRAPPED__ */
/**
 * Stage 5C.1b — conversation-view presence (ONLINE / LAST SEEN).
 * Peer-scoped, authenticated, E2EE on Relay.
 * "מחובר" = peer has THIS exact conversation open in foreground UI.
 * Independent from DataChannel / P2P lamp.
 */
(function initChatPresence(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const PRESENCE_KIND = 1054;
  const PRESENCE_TYPE = 'chat_presence';
  const HEARTBEAT_MS = 45000;
  const ONLINE_TTL_MS = 90000;
  const CLOCK_SKEW_MS = 120000;
  const DAY_MS = 86400000;
  const WEEK_MS = 7 * DAY_MS;

  /** peer -> { online, viewing, lastSeenAt (sec), lastPresenceAt (ms sender), lastPresenceSentAt (sec) } */
  const presenceByPeer = new Map();
  let heartbeatTimer = null;
  let started = false;
  let listeners = [];
  /** Local peer we currently claim to be viewing */
  let localViewingPeer = '';

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function normalizePeer(peer) {
    return String(peer || '').trim().toLowerCase();
  }

  function isUiForegroundActive() {
    try {
      if (typeof document !== 'undefined') {
        if (document.hidden || document.visibilityState === 'hidden') return false;
      }
    } catch (_) {}
    try {
      if (typeof App.isNativeShell === 'function' && App.isNativeShell()) {
        if (typeof App.isNativeHostAlive === 'function' && !App.isNativeHostAlive()) return false;
      }
    } catch (_) {}
    return true;
  }

  /** Exact open conversation peer, only when chat conversation UI is actively viewed. */
  function getActiveViewingPeer() {
    if (!isUiForegroundActive()) return '';
    try {
      if (typeof App.getChatPresenceViewedPeer === 'function') {
        return normalizePeer(App.getChatPresenceViewedPeer());
      }
    } catch (_) {}
    return '';
  }

  function getPresence(peerPubkey) {
    const peer = normalizePeer(peerPubkey);
    if (!peer) {
      return { peer: '', online: false, viewing: false, lastSeenAt: 0, lastPresenceAt: 0, lastPresenceSentAt: 0 };
    }
    const row = presenceByPeer.get(peer);
    if (!row) {
      return { peer, online: false, viewing: false, lastSeenAt: 0, lastPresenceAt: 0, lastPresenceSentAt: 0 };
    }
    const fresh = row.lastPresenceAt > 0 && (Date.now() - row.lastPresenceAt) <= ONLINE_TTL_MS;
    const online = !!(row.online && row.viewing && fresh);
    return {
      peer,
      online,
      viewing: online,
      lastSeenAt: Number(row.lastSeenAt) || 0,
      lastPresenceAt: Number(row.lastPresenceAt) || 0,
      lastPresenceSentAt: Number(row.lastPresenceSentAt) || 0,
    };
  }

  function setPresence(peerPubkey, patch) {
    const peer = normalizePeer(peerPubkey);
    if (!peer) return null;
    const prev = presenceByPeer.get(peer) || {
      online: false,
      viewing: false,
      lastSeenAt: 0,
      lastPresenceAt: 0,
      lastPresenceSentAt: 0,
    };
    const next = {
      online: patch.online != null ? !!patch.online : !!prev.online,
      viewing: patch.viewing != null ? !!patch.viewing : !!prev.viewing,
      lastSeenAt: Number(patch.lastSeenAt != null ? patch.lastSeenAt : prev.lastSeenAt) || 0,
      lastPresenceAt: Number(patch.lastPresenceAt != null ? patch.lastPresenceAt : prev.lastPresenceAt) || 0,
      lastPresenceSentAt: Number(patch.lastPresenceSentAt != null ? patch.lastPresenceSentAt : prev.lastPresenceSentAt) || 0,
    };
    presenceByPeer.set(peer, next);
    notifyPresence(peer);
    persistPresenceCache();
    return getPresence(peer);
  }

  function notifyPresence(peer) {
    const snapshot = getPresence(peer);
    listeners.forEach((fn) => {
      try { fn(snapshot); } catch (_) {}
    });
    try {
      window.dispatchEvent(new CustomEvent('sos-chat-presence', { detail: snapshot }));
    } catch (_) {}
  }

  function subscribePresence(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((x) => x !== fn);
    };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatClock(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function hebrewWeekday(date) {
    const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    return names[date.getDay()] || '';
  }

  function startOfLocalDay(tsMs) {
    const d = new Date(tsMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function formatChatPresence(peerPresence) {
    const row = peerPresence && typeof peerPresence === 'object'
      ? peerPresence
      : getPresence(peerPresence);
    if (row && row.online) {
      return { text: 'מחובר', tone: 'online' };
    }
    const lastSeenAt = Number(row && row.lastSeenAt) || 0;
    if (!lastSeenAt) {
      return { text: '', tone: 'unknown' };
    }
    const seenMs = lastSeenAt * 1000;
    const ageMs = Math.max(0, Date.now() - seenMs);
    const seenDate = new Date(seenMs);
    const clock = formatClock(seenDate);
    let text = '';
    if (ageMs < 60 * 1000) {
      text = 'נראה לאחרונה עכשיו';
    } else if (ageMs < 60 * 60 * 1000) {
      const mins = Math.max(1, Math.floor(ageMs / 60000));
      text = 'נראה לאחרונה לפני ' + mins + ' דקות';
    } else {
      const today0 = startOfLocalDay(Date.now());
      const seen0 = startOfLocalDay(seenMs);
      const dayDiff = Math.round((today0 - seen0) / DAY_MS);
      if (dayDiff === 0) {
        text = 'נראה לאחרונה היום ב־' + clock;
      } else if (dayDiff === 1) {
        text = 'נראה לאחרונה אתמול ב־' + clock;
      } else if (dayDiff > 1 && dayDiff < 7) {
        text = 'נראה לאחרונה ביום ' + hebrewWeekday(seenDate) + ' ב־' + clock;
      } else {
        text = 'נראה לאחרונה ' + pad2(seenDate.getDate()) + '/' + pad2(seenDate.getMonth() + 1) + '/' + seenDate.getFullYear() + ' ב־' + clock;
      }
    }
    let tone = 'stale';
    if (ageMs <= DAY_MS) tone = 'recent';
    else if (ageMs < WEEK_MS) tone = 'older';
    else tone = 'stale';
    return { text, tone };
  }

  function presenceToneClass(tone) {
    const t = String(tone || 'unknown');
    if (t === 'online') return 'chat-conversation__status--online';
    if (t === 'recent') return 'chat-conversation__status--recent';
    if (t === 'older') return 'chat-conversation__status--older';
    if (t === 'stale') return 'chat-conversation__status--stale';
    return 'chat-conversation__status--unknown';
  }

  function storageKey() {
    const pk = String(App.publicKey || '').toLowerCase();
    return pk ? ('sos_chat_presence_' + pk) : '';
  }

  function persistPresenceCache() {
    const key = storageKey();
    if (!key) return;
    try {
      const out = {};
      presenceByPeer.forEach((row, peer) => {
        out[peer] = {
          lastSeenAt: Number(row.lastSeenAt) || 0,
          online: false,
          viewing: false,
          lastPresenceAt: 0,
          lastPresenceSentAt: Number(row.lastPresenceSentAt) || 0,
        };
      });
      localStorage.setItem(key, JSON.stringify(out));
    } catch (_) {}
  }

  function restorePresenceCache() {
    const key = storageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.keys(parsed || {}).forEach((peer) => {
        const row = parsed[peer];
        if (!row) return;
        presenceByPeer.set(normalizePeer(peer), {
          online: false,
          viewing: false,
          lastSeenAt: Number(row.lastSeenAt) || 0,
          lastPresenceAt: 0,
          lastPresenceSentAt: Number(row.lastPresenceSentAt) || 0,
        });
      });
    } catch (_) {}
  }

  function buildPresencePayload(toPeer, viewing) {
    const self = String(App.publicKey || '').toLowerCase();
    const to = normalizePeer(toPeer);
    const at = nowSec();
    const on = viewing === true;
    return {
      type: PRESENCE_TYPE,
      from: self,
      to,
      online: on,
      viewing: on,
      lastSeenAt: at,
      sentAt: at,
    };
  }

  function sendPresenceOverDc(payload) {
    if (!payload || !App.dataChannel) return false;
    if (typeof App.dataChannel.isConnected === 'function' && !App.dataChannel.isConnected(payload.to)) return false;
    if (typeof App.dataChannel.sendJson === 'function') {
      return !!App.dataChannel.sendJson(payload.to, payload);
    }
    return false;
  }

  function presenceHexToBytes(hex) {
    const clean = String(hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    return out;
  }

  async function publishPresenceCopy(recipient, bodyText, authorization, secretHex) {
    const to = String(recipient || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(to) || !App.pool) return false;
    const NT = window.NostrTools;
    if (!NT || typeof NT.finalizeEvent !== 'function') return false;
    const secret = presenceHexToBytes(secretHex);
    if (!secret) return false;
    const tags = [['p', to], ['t', 'yalachat']];
    if (authorization) tags.push(['sos-md3', JSON.stringify(authorization)]);
    const signed = NT.finalizeEvent({
      kind: PRESENCE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: tags,
      content: bodyText,
    }, secret);
    const results = App.pool.publish(App.relayUrls, signed);
    await Promise.allSettled(results || []);
    return !!(signed && signed.id);
  }

  async function sendLinkedDevicePresence(payload) {
    const LD = window.SosWebLinkedDevices;
    const Session = window.SosAccountSession;
    if (!LD || typeof LD.withLinkedDeviceSigner !== 'function' || !App.encryptPrivateChatPayload) return false;
    const session = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const caps = session && Array.isArray(session.caps) ? session.caps : [];
    if (caps.indexOf('DEVICE_PRESENCE') === -1 && caps.indexOf('DEVICE_CHAT') === -1) return false;
    const dev = await LD.withLinkedDeviceSigner(function (material) { return material; });
    if (!dev || !dev.privHex || !dev.pub || !dev.authorization) return false;
    const body = {
      type: PRESENCE_TYPE,
      online: payload.online === true,
      viewing: payload.viewing === true,
      lastSeenAt: Number(payload.lastSeenAt) || nowSec(),
      sentAt: Number(payload.sentAt) || nowSec(),
    };
    const targets = [String(payload.to || '').toLowerCase()];
    if (Session && typeof Session.listAuthorizedDevices === 'function') {
      try {
        const devices = await Session.listAuthorizedDevices(payload.to, 'DEVICE_CHAT');
        (devices || []).forEach((row) => {
          const pk = row && String(row.deviceSignPub || '').toLowerCase();
          if (/^[0-9a-f]{64}$/.test(pk) && targets.indexOf(pk) === -1 && pk !== String(dev.pub).toLowerCase()) targets.push(pk);
        });
      } catch (_list) {}
    }
    let sent = 0;
    for (let i = 0; i < targets.length; i += 1) {
      try {
        const env = App.encryptPrivateChatPayload({
          senderPrivateKeyHex: dev.privHex,
          senderPubkey: dev.pub,
          recipientPubkey: targets[i],
          payload: {
            messageId: 'presence-' + body.sentAt + '-' + i,
            sender: dev.pub,
            recipient: targets[i],
            createdAt: body.sentAt,
            text: JSON.stringify(body),
            attachment: null,
          },
        });
        if (!env) continue;
        const ok = await publishPresenceCopy(targets[i], JSON.stringify(env), dev.authorization, dev.privHex);
        if (ok) sent += 1;
      } catch (_one) {}
    }
    return sent > 0;
  }

  async function sendPresenceOverNostr(payload) {
    try {
      if (!payload || App.guestMode) return false;
      const session = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
      if (session && session.role === 'LINKED_DEVICE' && session.verified === true) {
        return sendLinkedDevicePresence(payload);
      }
      if (!App.pool || !App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey || typeof App.SosCryptoSigner.signPresence !== 'function') return false;
      const mustEncrypt = typeof App.isE2eeSendRequired !== 'function' || App.isE2eeSendRequired() === true;
      if (mustEncrypt && typeof App.SosCryptoSigner?.nip44ChatEncrypt !== 'function') return false;
      const body = {
        type: PRESENCE_TYPE,
        online: payload.online === true,
        viewing: payload.viewing === true,
        lastSeenAt: Number(payload.lastSeenAt) || nowSec(),
        sentAt: Number(payload.sentAt) || nowSec(),
      };
      let content = JSON.stringify(body);
      if (mustEncrypt) {
        const envelope = await Promise.resolve(App.SosCryptoSigner.nip44ChatEncrypt({
          senderPubkey: App.publicKey,
          recipientPubkey: payload.to,
          payload: {
            messageId: 'presence-' + body.sentAt + '-' + Math.random().toString(36).slice(2, 8),
            sender: App.publicKey,
            recipient: payload.to,
            createdAt: body.sentAt,
            text: content,
            attachment: null,
          },
        }));
        content = JSON.stringify(envelope);
      }
      const tags = [['p', payload.to], ['t', 'yalachat']];
      if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);
      const signed = await Promise.resolve(App.SosCryptoSigner.signPresence({
        kind: PRESENCE_KIND,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      }));
      const results = App.pool.publish(App.relayUrls, signed);
      await Promise.allSettled(results || []);
      const Session = window.SosAccountSession;
      if (Session && typeof Session.listAuthorizedDevices === 'function' && App.SosCryptoSigner && typeof App.SosCryptoSigner.nip44ChatEncrypt === 'function') {
        try {
          const devices = await Session.listAuthorizedDevices(payload.to, 'DEVICE_CHAT');
          for (let i = 0; i < (devices || []).length; i += 1) {
            const devicePub = devices[i] && String(devices[i].deviceSignPub || '').toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(devicePub) || devicePub === String(payload.to || '').toLowerCase()) continue;
            const copy = await Promise.resolve(App.SosCryptoSigner.nip44ChatEncrypt({
              senderPubkey: App.publicKey,
              recipientPubkey: devicePub,
              payload: {
                messageId: 'presence-' + body.sentAt + '-d' + i,
                sender: App.publicKey,
                recipient: devicePub,
                createdAt: body.sentAt,
                text: JSON.stringify(body),
                attachment: null,
              },
            }));
            const copyTags = [['p', devicePub], ['t', 'yalachat']];
            const copySigned = await Promise.resolve(App.SosCryptoSigner.signPresence({
              kind: PRESENCE_KIND,
              pubkey: App.publicKey,
              created_at: Math.floor(Date.now() / 1000),
              tags: copyTags,
              content: JSON.stringify(copy),
            }));
            await Promise.allSettled(App.pool.publish(App.relayUrls, copySigned) || []);
          }
        } catch (_fan) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function transmitPresence(payload) {
    if (!payload || !payload.to) return false;
    if (sendPresenceOverDc(payload)) return true;
    return sendPresenceOverNostr(payload);
  }

  async function sendViewingState(peer, viewing) {
    const p = normalizePeer(peer);
    if (!p || !App.publicKey || App.guestMode) return false;
    const payload = buildPresencePayload(p, viewing === true);
    try {
      return await transmitPresence(payload);
    } catch (_) {
      return false;
    }
  }

  /**
   * Enter/leave exact conversation view.
   * Sends viewing=false to previous peer, viewing=true only to the new peer.
   */
  async function setLocalConversationViewing(peerPubkey, viewing) {
    const peer = normalizePeer(peerPubkey);
    if (viewing === true) {
      if (!peer || !isUiForegroundActive()) {
        if (localViewingPeer) {
          const prev = localViewingPeer;
          localViewingPeer = '';
          await sendViewingState(prev, false);
        }
        return false;
      }
      if (localViewingPeer && localViewingPeer !== peer) {
        const prev = localViewingPeer;
        localViewingPeer = peer;
        await sendViewingState(prev, false);
        await sendViewingState(peer, true);
        return true;
      }
      localViewingPeer = peer;
      await sendViewingState(peer, true);
      return true;
    }
    // viewing false
    const target = peer || localViewingPeer;
    if (localViewingPeer && (!peer || localViewingPeer === peer)) {
      localViewingPeer = '';
    }
    if (target) await sendViewingState(target, false);
    return true;
  }

  async function leaveAllConversationViewing(reason) {
    if (!localViewingPeer) {
      const viewed = getActiveViewingPeer();
      if (viewed) return setLocalConversationViewing(viewed, false);
      return false;
    }
    return setLocalConversationViewing(localViewingPeer, false);
  }

  function applyIncomingPresence(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (String(raw.type || '') !== PRESENCE_TYPE) return false;
    const from = normalizePeer(raw.from || raw.peer);
    const self = String(App.publicKey || '').toLowerCase();
    if (!from || from === self) return false;
    const to = normalizePeer(raw.to);
    if (to && to !== self) return false;

    const sentAt = Number(raw.sentAt || raw.lastSeenAt) || 0;
    if (!sentAt || !Number.isFinite(sentAt)) return false;
    const sentMs = sentAt * 1000;
    const ageMs = Date.now() - sentMs;
    if (ageMs < -CLOCK_SKEW_MS) return false;

    const prev = presenceByPeer.get(from);
    const prevSent = Number(prev && prev.lastPresenceSentAt) || 0;
    if (prevSent && sentAt < prevSent) return false;

    const viewingFlag = raw.viewing === true;
    const onlineFlag = raw.online === true;
    // Require both online+viewing for מחובר. Explicit viewing=false wins immediately.
    const wantsOnline = onlineFlag && viewingFlag;
    const fresh = ageMs <= ONLINE_TTL_MS;
    const online = wantsOnline && fresh && ageMs >= -CLOCK_SKEW_MS;
    const lastSeenAt = Number(raw.lastSeenAt || sentAt) || sentAt;

    setPresence(from, {
      online,
      viewing: online,
      lastSeenAt,
      lastPresenceAt: sentMs,
      lastPresenceSentAt: sentAt,
    });
    return true;
  }

  async function presenceFromRelayEvent(event) {
    if (!event || event.kind !== PRESENCE_KIND) return null;
    const raw = String(event.content || '');
    let body = null;
    const encrypted = typeof App.looksLikeSosE2eeEnvelope === 'function' && App.looksLikeSosE2eeEnvelope(raw);
    if (encrypted) {
      try {
        let text = '';
        if (typeof App.SosCryptoSigner?.nip44ChatDecrypt === 'function' && App.SosCryptoSigner?.hasIdentityKey?.() && App.publicKey) {
          const dec = await Promise.resolve(App.SosCryptoSigner.nip44ChatDecrypt({
            localPubkey: App.publicKey,
            eventAuthorPubkey: event.pubkey,
            encryptedEnvelope: raw,
          }));
          text = dec && dec.text;
        } else if (window.SosAccountSession && typeof window.SosAccountSession.decryptForLinkedDevice === 'function') {
          const envelope = JSON.parse(raw);
          const opened = await window.SosAccountSession.decryptForLinkedDevice(event, envelope, false, null);
          text = opened && opened.ok === true && opened.payload ? opened.payload.text : '';
        }
        body = typeof text === 'string' && text ? JSON.parse(text) : null;
      } catch (_) {
        return null;
      }
      if (!body) return null;
    } else if (typeof App.isE2eeSendRequired === 'function' && App.isE2eeSendRequired() === true) {
      return null;
    } else {
      try { body = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!body || body.type !== PRESENCE_TYPE) return null;
    let fromAccount = String(event.pubkey || '').toLowerCase();
    if (Array.isArray(event.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'sos-md3')) {
      const Session = window.SosAccountSession;
      if (!Session || typeof Session.verifyDelegatedEvent !== 'function') return null;
      let verified = await Session.verifyDelegatedEvent(event, 'DEVICE_PRESENCE');
      if (!verified || verified.ok !== true) verified = await Session.verifyDelegatedEvent(event, 'DEVICE_CHAT');
      if (!verified || verified.ok !== true || !verified.accountP) return null;
      fromAccount = String(verified.accountP).toLowerCase();
    }
    return {
      type: PRESENCE_TYPE,
      from: fromAccount,
      to: '',
      online: body.online === true,
      viewing: body.viewing === true,
      lastSeenAt: Number(body.lastSeenAt || body.sentAt || event.created_at) || nowSec(),
      sentAt: Number(body.sentAt || body.lastSeenAt || event.created_at) || nowSec(),
    };
  }

  async function handleIncomingPresenceEvent(event) {
    const payload = await presenceFromRelayEvent(event);
    if (!payload) return false;
    return applyIncomingPresence(payload);
  }

  function tickExpireOnline() {
    const now = Date.now();
    presenceByPeer.forEach((row, peer) => {
      if (!row.online) return;
      if (row.lastPresenceAt && (now - row.lastPresenceAt) > ONLINE_TTL_MS) {
        row.online = false;
        row.viewing = false;
        presenceByPeer.set(peer, row);
        notifyPresence(peer);
      }
    });
  }

  async function heartbeatTick() {
    tickExpireOnline();
    if (!isUiForegroundActive()) {
      if (localViewingPeer) await leaveAllConversationViewing('heartbeat-background');
      return;
    }
    const viewed = getActiveViewingPeer();
    if (!viewed) {
      if (localViewingPeer) await leaveAllConversationViewing('heartbeat-no-view');
      return;
    }
    if (localViewingPeer !== viewed) {
      await setLocalConversationViewing(viewed, true);
      return;
    }
    await sendViewingState(viewed, true);
  }

  function onVisibilityChange() {
    if (isUiForegroundActive()) {
      heartbeatTick();
      return;
    }
    leaveAllConversationViewing('visibility-hidden');
  }

  function onNativePause() {
    leaveAllConversationViewing('native-pause');
  }

  function startChatPresence() {
    if (started) return;
    started = true;
    restorePresenceCache();
    try {
      document.addEventListener('visibilitychange', onVisibilityChange);
    } catch (_) {}
    try {
      window.addEventListener('sos-native-resume', () => {
        if (isUiForegroundActive()) heartbeatTick();
      });
    } catch (_) {}
    try {
      window.addEventListener('sos-native-pause', onNativePause);
    } catch (_) {}
    heartbeatTimer = setInterval(() => {
      heartbeatTick();
    }, HEARTBEAT_MS);
    setTimeout(() => {
      if (isUiForegroundActive()) heartbeatTick();
    }, 1500);
  }

  Object.assign(App, {
    PRESENCE_KIND,
    PRESENCE_HEARTBEAT_MS: HEARTBEAT_MS,
    PRESENCE_ONLINE_TTL_MS: ONLINE_TTL_MS,
    startChatPresence,
    getChatPresence: getPresence,
    setChatPresence: setPresence,
    formatChatPresence,
    presenceToneClass,
    applyIncomingChatPresence: applyIncomingPresence,
    handleIncomingPresenceEvent,
    presenceFromRelayEvent,
    setChatPresenceViewing: setLocalConversationViewing,
    leaveChatPresenceViewing: leaveAllConversationViewing,
    getLocalChatPresenceViewingPeer: () => localViewingPeer,
    subscribeChatPresence: subscribePresence,
    isChatPresenceForegroundActive: isUiForegroundActive,
  });

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        try { startChatPresence(); } catch (_) {}
      });
    } else {
      startChatPresence();
    }
  } catch (_) {}
})(window);
