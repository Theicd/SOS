/**
 * Stage 5C.1 — private chat presence (ONLINE / LAST SEEN).
 * Peer-scoped, authenticated, E2EE on Relay. Not P2P transport state.
 */
(function initChatPresence(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const PRESENCE_KIND = 1054;
  const PRESENCE_TYPE = 'chat_presence';
  const HEARTBEAT_MS = 45000;
  const ONLINE_TTL_MS = 90000;
  const DAY_MS = 86400000;
  const WEEK_MS = 7 * DAY_MS;
  const MAX_HEARTBEAT_PEERS = 40;

  /** peer -> { online, lastSeenAt (sec), lastPresenceAt (ms) } */
  const presenceByPeer = new Map();
  let heartbeatTimer = null;
  let started = false;
  let listeners = [];

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

  function getPresence(peerPubkey) {
    const peer = normalizePeer(peerPubkey);
    if (!peer) return { peer: '', online: false, lastSeenAt: 0, lastPresenceAt: 0 };
    const row = presenceByPeer.get(peer);
    if (!row) return { peer, online: false, lastSeenAt: 0, lastPresenceAt: 0 };
    const fresh = row.lastPresenceAt > 0 && (Date.now() - row.lastPresenceAt) <= ONLINE_TTL_MS;
    const online = !!(row.online && fresh);
    return {
      peer,
      online,
      lastSeenAt: Number(row.lastSeenAt) || 0,
      lastPresenceAt: Number(row.lastPresenceAt) || 0,
    };
  }

  function setPresence(peerPubkey, patch) {
    const peer = normalizePeer(peerPubkey);
    if (!peer) return null;
    const prev = presenceByPeer.get(peer) || { online: false, lastSeenAt: 0, lastPresenceAt: 0 };
    const next = {
      online: patch.online != null ? !!patch.online : !!prev.online,
      lastSeenAt: Number(patch.lastSeenAt != null ? patch.lastSeenAt : prev.lastSeenAt) || 0,
      lastPresenceAt: Number(patch.lastPresenceAt != null ? patch.lastPresenceAt : prev.lastPresenceAt) || 0,
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

  /**
   * @returns {{ text: string, tone: 'online'|'recent'|'older'|'stale'|'unknown' }}
   */
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
          // Never persist online=true — must depend on TTL freshness.
          online: false,
          lastPresenceAt: 0,
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
          lastSeenAt: Number(row.lastSeenAt) || 0,
          lastPresenceAt: 0,
        });
      });
    } catch (_) {}
  }

  function listHeartbeatPeers() {
    const peers = [];
    const seen = new Set();
    const push = (pk) => {
      const p = normalizePeer(pk);
      if (!p || p.length !== 64 || seen.has(p)) return;
      if (p === String(App.publicKey || '').toLowerCase()) return;
      seen.add(p);
      peers.push(p);
    };
    try {
      if (typeof App.getActiveChatPeer === 'function') push(App.getActiveChatPeer());
    } catch (_) {}
    try {
      if (App.chatUiState && App.chatUiState.activeContact) push(App.chatUiState.activeContact);
    } catch (_) {}
    try {
      const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
      (contacts || []).forEach((c) => push(c && c.pubkey));
    } catch (_) {}
    return peers.slice(0, MAX_HEARTBEAT_PEERS);
  }

  function buildPresencePayload(toPeer, online) {
    const self = String(App.publicKey || '').toLowerCase();
    const to = normalizePeer(toPeer);
    const at = nowSec();
    return {
      type: PRESENCE_TYPE,
      from: self,
      to,
      online: online === true,
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

  async function sendPresenceOverNostr(payload) {
    try {
      if (!payload || App.guestMode) return false;
      if (!App.pool || !App.privateKey || !App.publicKey || typeof App.finalizeEvent !== 'function') return false;
      const mustEncrypt = typeof App.isE2eeSendRequired !== 'function' || App.isE2eeSendRequired() === true;
      if (mustEncrypt && typeof App.encryptPrivateChatPayload !== 'function') return false;
      const body = {
        type: PRESENCE_TYPE,
        online: payload.online === true,
        lastSeenAt: Number(payload.lastSeenAt) || nowSec(),
        sentAt: Number(payload.sentAt) || nowSec(),
      };
      let content = JSON.stringify(body);
      if (mustEncrypt) {
        const envelope = App.encryptPrivateChatPayload({
          senderPrivateKeyHex: App.privateKey,
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
        });
        content = JSON.stringify(envelope);
      }
      const tags = [['p', payload.to], ['t', 'yalachat']];
      if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);
      if (App.CHAT_TAG) tags.push(['t', String(App.CHAT_TAG)]);
      const signed = App.finalizeEvent({
        kind: PRESENCE_KIND,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      }, App.privateKey);
      const results = App.pool.publish(App.relayUrls, signed);
      await Promise.allSettled(results || []);
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

  async function publishPresenceToPeers(online) {
    if (!App.publicKey || !App.privateKey || App.guestMode) return;
    const peers = listHeartbeatPeers();
    for (let i = 0; i < peers.length; i += 1) {
      const payload = buildPresencePayload(peers[i], online === true);
      try { await transmitPresence(payload); } catch (_) {}
    }
  }

  function applyIncomingPresence(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (String(raw.type || '') !== PRESENCE_TYPE) return false;
    const from = normalizePeer(raw.from || raw.peer);
    const self = String(App.publicKey || '').toLowerCase();
    if (!from || from === self) return false;
    const to = normalizePeer(raw.to);
    if (to && to !== self) return false;
    const lastSeenAt = Number(raw.lastSeenAt || raw.sentAt) || nowSec();
    const online = raw.online === true;
    setPresence(from, {
      online,
      lastSeenAt,
      lastPresenceAt: online ? Date.now() : 0,
    });
    return true;
  }

  function presenceFromRelayEvent(event) {
    if (!event || event.kind !== PRESENCE_KIND) return null;
    const raw = String(event.content || '');
    let body = null;
    const encrypted = typeof App.looksLikeSosE2eeEnvelope === 'function' && App.looksLikeSosE2eeEnvelope(raw);
    if (encrypted) {
      if (typeof App.decryptPrivateChatPayload !== 'function' || !App.privateKey || !App.publicKey) return null;
      try {
        const dec = App.decryptPrivateChatPayload({
          localPrivateKeyHex: App.privateKey,
          localPubkey: App.publicKey,
          eventAuthorPubkey: event.pubkey,
          encryptedEnvelope: raw,
        });
        const text = dec && dec.text;
        body = typeof text === 'string' ? JSON.parse(text) : null;
      } catch (_) {
        return null;
      }
    } else if (typeof App.isE2eeSendRequired === 'function' && App.isE2eeSendRequired() === true) {
      return null;
    } else {
      try { body = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!body || body.type !== PRESENCE_TYPE) return null;
    return {
      type: PRESENCE_TYPE,
      from: String(event.pubkey || '').toLowerCase(),
      to: '',
      online: body.online === true,
      lastSeenAt: Number(body.lastSeenAt || body.sentAt || event.created_at) || nowSec(),
      sentAt: Number(body.sentAt || event.created_at) || nowSec(),
    };
  }

  function handleIncomingPresenceEvent(event) {
    const payload = presenceFromRelayEvent(event);
    if (!payload) return false;
    return applyIncomingPresence(payload);
  }

  function tickExpireOnline() {
    const now = Date.now();
    presenceByPeer.forEach((row, peer) => {
      if (!row.online) return;
      if (row.lastPresenceAt && (now - row.lastPresenceAt) > ONLINE_TTL_MS) {
        row.online = false;
        presenceByPeer.set(peer, row);
        notifyPresence(peer);
      }
    });
  }

  async function heartbeatTick() {
    tickExpireOnline();
    if (!isUiForegroundActive()) return;
    await publishPresenceToPeers(true);
  }

  function onVisibilityChange() {
    if (isUiForegroundActive()) {
      heartbeatTick();
      return;
    }
    // Leaving foreground: stop claiming online. TTL + lastSeen from last heartbeat.
    publishPresenceToPeers(false);
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
    publishChatPresenceNow: publishPresenceToPeers,
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
