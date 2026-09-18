// חלק שיחות וידאו (chat-video-call.js) – מודול WebRTC לשיחות וידאו בזמן אמת דרך Nostr
(function initChatVideoCall(window) {
  // שייך: שכבת RTC לוידאו, עצמאי מהקול אך דומה במבנה
  const App = window.NostrApp || (window.NostrApp = {});
  const NostrTools = window.NostrTools;

  // חלק שיחות וידאו – קונפיגורציית ICE (מאפשר TURN חיצוני דרך גלובלי)
  const RTC_CONFIG = { iceServers: Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? window.NostrRTC_ICE
    : [ { urls: 'stun:stun.l.google.com:19302' } ] };
  // CALL_METRIC_KIND 25060 RETIRED — NEW per-call Relay metrics are ZERO (privacy phase 1)

  function normalizeVideoSessionDescription(raw) {
    if (!raw) return null;
    let o = raw;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (_err) { return null; }
    }
    if (!o || typeof o !== 'object') return null;
    if (o.offer && typeof o.offer === 'object' && !o.type && !o.sdp) o = o.offer;
    if (o.answer && typeof o.answer === 'object' && !o.type && !o.sdp) o = o.answer;
    const type = o.type;
    const sdp = typeof o.sdp === 'string' ? o.sdp : '';
    if (typeof type !== 'string' || !type || !sdp) return null;
    if (sdp.length > MAX_SIGNAL_SDP_CHARS) return null;
    return { type, sdp };
  }

  function isValidIncomingVideoCandidateList(raw) {
    if (!Array.isArray(raw)) return false;
    if (raw.length > MAX_SIGNAL_CANDIDATES) return false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c == null) continue;
      if (typeof c === 'string') {
        if (c.length > MAX_CANDIDATE_FIELD_CHARS) return false;
        continue;
      }
      if (typeof c !== 'object') return false;
      const cand = c.candidate;
      if (typeof cand === 'string' && cand.length > MAX_CANDIDATE_FIELD_CHARS) return false;
    }
    return true;
  }
  const SIGNAL_LOOKBACK_SEC = 180;
  const MAX_OFFER_AGE_SEC = 60;
  const MAX_SIGNAL_SDP_CHARS = 64 * 1024;
  const MAX_SIGNAL_CANDIDATES = 256;
  const MAX_CANDIDATE_FIELD_CHARS = 4096;

  // חלק שיחות וידאו – מצב השיחה הנוכחי
  const state = {
    localStream: null,
    remoteStream: null,
    pc: null,
    currentPeer: null,
    isIncoming: false,
    isActive: false,
    isMuted: false,
    isCameraOff: false,
    facingMode: 'user',
    // חלק שיחות וידאו (chat-video-call.js) – deviceId של מצלמת הוידאו הנוכחית לצורך החלפה אמיתית בין מצלמות | HYPER CORE TECH
    videoDeviceId: null,
    // חלק שיחות וידאו (chat-video-call.js) – מניעת הרשמה כפולה לסיגנלים (חשוב בעמודים כבדים כמו videos.html) | HYPER CORE TECH
    signalSubscription: null,
    // חלק שיחות וידאו (chat-video-call.js) – באפר ל-ICE candidates נכנסים לפני setRemoteDescription/לפני accept | HYPER CORE TECH
    pendingRemoteCandidates: Object.create(null),
    // חלק שיחות וידאו (chat-video-call.js) – דה-דופליקציה לאירועי סיגנלים לפי event.id (מונע שיחה כפולה אחרי re-subscribe) | HYPER CORE TECH
    processedSignalIds: new Map(),
    // חלק שיחות וידאו (chat-video-call.js) – timestamp אחרון (created_at) שעובד לטובת since ב-re-subscribe | HYPER CORE TECH
    lastSignalCreatedAt: 0,
    // חלק שיחות וידאו (chat-video-call.js) – keepalive/re-subscribe: מזהה interval כדי למנוע ריבוי timers | HYPER CORE TECH
    signalKeepaliveTimer: null,
    // חלק שיחות וידאו (chat-video-call.js) – keepalive: זמן קבלת סיגנל אחרון (לזיהוי subscribe תקוע אחרי idle) | HYPER CORE TECH
    lastSignalReceivedAt: 0,
    // חלק שיחות וידאו (chat-video-call.js) – חסם ריענון subscribe מהיר מדי (מונע spam ריליי) | HYPER CORE TECH
    signalLastResubscribeAt: 0,
    candidateQueue: [],
    candidateTimer: null,
    ending: false,
    lastOfferFrom: {},
    lastEndedAt: Object.create(null),
    callStartTimestamp: null,
    sessionOfferCreatedAt: 0,
    answeredLocally: false,
    outboundStarting: false,
    videoLookbackUntil: 0,
    callSessionId: null
  };

  const terminalBySession = new Map();
  function getTerminal(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || sid.length < 16) return null;
    let t = terminalBySession.get(sid);
    if (!t) {
      t = { ended: false, disconnectSent: false, missedSent: false, declined: false, at: Date.now() };
      terminalBySession.set(sid, t);
      if (terminalBySession.size > 40) {
        const first = terminalBySession.keys().next().value;
        terminalBySession.delete(first);
      }
    }
    return t;
  }
  function markNativeSessionTerminal(sessionId, stateName) {
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markSecureCallSessionTerminal === 'function') {
        bridge.markSecureCallSessionTerminal(sessionId, stateName);
      }
    } catch (_e) {}
  }

  // חלק שיחות וידאו (chat-video-call.js) – בניית אילוצי וידאו ברירת מחדל עם אפשרות דריסה | HYPER CORE TECH
  function buildVideoConstraints(overrides) {
    const base = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    };
    if (state.videoDeviceId) {
      base.deviceId = { exact: state.videoDeviceId };
    } else {
      base.facingMode = state.facingMode;
    }
    return Object.assign(base, overrides || {});
  }

  // NEW 25060 WRITE COUNT = ZERO — historical Relay copies may remain; do not publish.
  async function publishCallMetric() {
    return;
  }

  // חלק שיחות וידאו – בדיקת תמיכה
  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  // חלק שיחות וידאו – קבלת סטרים מקומי (אודיו+וידאו)
  async function getLocalStream(videoConstraints) {
    if (typeof App.ensureNativeMediaPermissions === 'function') {
      const ok = await App.ensureNativeMediaPermissions(true);
      if (!ok) {
        throw new Error('לא ניתן לגשת למצלמה/מיקרופון. אנא אשר הרשאות באפליקציה.');
      }
    }
    const constraints = {
      audio: true,
      video: buildVideoConstraints(videoConstraints)
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    // חלק שיחות וידאו (chat-video-call.js) – שמירת deviceId/facingMode בפועל כדי לשפר החלפת מצלמה במובייל | HYPER CORE TECH
    try {
      const vt = state.localStream.getVideoTracks()[0];
      const st = vt && typeof vt.getSettings === 'function' ? vt.getSettings() : null;
      if (st && st.deviceId) state.videoDeviceId = st.deviceId;
      if (st && st.facingMode) state.facingMode = st.facingMode;
    } catch {}
    return state.localStream;
  }

  // חלק שיחות וידאו – יצירת RTCPeerConnection והאזנות
  function createPC(peerPubkey) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // הוספת מסלולים מקומיים
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
    }

    // סטרים מרוחק
    pc.ontrack = (e) => {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      e.streams[0].getTracks().forEach(track => state.remoteStream.addTrack(track));
      if (typeof App.onVideoCallRemoteStream === 'function') App.onVideoCallRemoteStream(state.remoteStream);
    };

    // צבירת ICE ושליחה בסיום
    pc.onicecandidate = (ev) => {
      queueCandidate(peerPubkey, ev.candidate || null);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected') {
        state.isActive = true;
        state.callStartTimestamp = Date.now();
        console.log('CALL_CONNECTED');
        if (typeof App.onVideoCallConnected === 'function') App.onVideoCallConnected(peerPubkey);
      } else if (['disconnected','failed','closed'].includes(pc.iceConnectionState)) {
        if (!state.ending) end();
      }
    };

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if (['disconnected','failed','closed'].includes(cs)) {
        if (!state.ending) end();
      }
    };

    state.pc = pc;
    return pc;
  }

  // LEGACY_READ_ONLY helper — deterministic room ID must NOT be emitted on NEW secure sends.
  function getRoomId(peer) {
    const a = (App.publicKey || '').toLowerCase();
    const b = (peer || '').toLowerCase();
    if (!a || !b) return '';
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  function ensureCallSessionId() {
    const api = App.CallSignalE2ee;
    if (state.callSessionId && String(state.callSessionId).length >= 32) return state.callSessionId;
    if (api && typeof api.createSessionId === 'function') {
      state.callSessionId = api.createSessionId();
    } else {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      state.callSessionId = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return state.callSessionId;
  }

  // Shared cutover: publishCallSignal picks ONE transport (legacy 25050 XOR gift-wrap 1059).
  async function sendSignal(peer, type, data) {
    if (!App.pool || !App.publicKey || !App.privateKey) {
      console.error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED: pool or keys unavailable');
      throw Object.assign(new Error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED'), { code: 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED' });
    }
    const api = App.CallSignalE2ee;
    if (!api || typeof api.publishCallSignal !== 'function') {
      throw Object.assign(new Error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED: helper missing'), { code: 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED' });
    }
    try {
      await api.publishCallSignal({
        media: 'video',
        peerPubkey: peer,
        type,
        data,
        sessionId: ensureCallSessionId(),
        pool: App.pool,
        relays: App.relayUrls,
        senderPubkey: App.publicKey,
        senderPrivateKey: App.privateKey,
        roomId: getRoomId(peer),
      });
    } catch (err) {
      const code = err && err.code ? err.code : 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED';
      console.error('CALL_SIGNAL_SEND_FAILED code=' + code);
      throw err && err.code ? err : Object.assign(err || new Error(code), { code });
    }
  }

  function queueCandidate(peer, cand) {
    if (cand) state.candidateQueue.push(cand);
    if (!cand) {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) {
        console.log('CALL_SIGNAL_ICE candidateCount=' + batch.length);
        sendSignal(peer, 'v-candidates', batch);
      }
      clearTimer();
      return;
    }
    clearTimer();
    state.candidateTimer = setTimeout(() => {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) {
        console.log('CALL_SIGNAL_ICE candidateCount=' + batch.length);
        sendSignal(peer, 'v-candidates', batch);
      }
      clearTimer();
    }, 200);
  }
  function clearTimer(){ if (state.candidateTimer){ clearTimeout(state.candidateTimer); state.candidateTimer=null; } }

  function peerPubkeyOrEmpty(pk) {
    return String(pk || '').toLowerCase();
  }

  function loadEndedCallMap() {
    // In-memory only — no identity-linked localStorage (sos_video_ended_v1 removed).
  }

  function noteCallEnded(peerPubkey) {
    const pk = peerPubkeyOrEmpty(peerPubkey);
    if (!pk) return;
    state.lastEndedAt[pk] = Date.now();
    try {
      localStorage.removeItem('sos_video_ended_v1');
    } catch (_) {}
  }

  function isOfferReplayAfterHangup(peerPubkey, createdAtSec) {
    const pk = peerPubkeyOrEmpty(peerPubkey);
    const at = Number(state.lastEndedAt[pk]) || 0;
    if (!at || Date.now() - at > 120000) return false;
    const created = Number(createdAtSec) || 0;
    if (!created) return false;
    return created * 1000 <= at + 2000;
  }

  // חלק שיחות וידאו (chat-video-call.js) – סינון אותות ישנים מהשיחה הקודמת אחרי ענה ממצב המתנה | HYPER CORE TECH
  function noteSessionOffer(createdAtSec) {
    const created = Number(createdAtSec) || 0;
    if (created > (Number(state.sessionOfferCreatedAt) || 0)) {
      state.sessionOfferCreatedAt = created;
    }
  }

  function isStaleForCurrentSession(createdAtSec, peerPubkey) {
    const created = Number(createdAtSec) || 0;
    if (!created) return false;
    const offerAt = Number(state.sessionOfferCreatedAt) || 0;
    if (offerAt && created + 1 < offerAt) return true;
    return isOfferReplayAfterHangup(peerPubkey, created);
  }

  // חלק שיחות וידאו (chat-video-call.js) – דה-דופליקציה לאירועי סיגנלים לפי event.id כדי למנוע טריגרים כפולים אחרי re-subscribe | HYPER CORE TECH
  function rememberProcessedSignalId(eventId) {
    if (!eventId) return false;
    if (state.processedSignalIds.has(eventId)) return true;
    state.processedSignalIds.set(eventId, Date.now());
    if (state.processedSignalIds.size > 900) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, ts] of state.processedSignalIds) {
        if (ts < cutoff || state.processedSignalIds.size > 600) {
          state.processedSignalIds.delete(id);
        } else {
          break;
        }
      }
    }
    return false;
  }

  // חלק שיחות וידאו (chat-video-call.js) – סגירה בטוחה של subscription כדי לאפשר re-subscribe | HYPER CORE TECH
  function closeSubscriptionSafely(sub) {
    if (!sub) return;
    try {
      if (typeof sub.close === 'function') {
        sub.close();
        return;
      }
    } catch {}
    try {
      if (typeof sub.unsub === 'function') {
        sub.unsub();
        return;
      }
    } catch {}
    try {
      if (typeof sub.unsubscribe === 'function') {
        sub.unsubscribe();
      }
    } catch {}
  }

  // חלק שיחות וידאו (chat-video-call.js) – באפר ל-ICE candidates נכנסים לפני שה-PC מוכן/לפני setRemoteDescription | HYPER CORE TECH
  function bufferRemoteCandidates(peerPubkey, candidates, createdAtSec) {
    if (!peerPubkey || !Array.isArray(candidates) || candidates.length === 0) return;
    const created = Number(createdAtSec) || 0;
    const list = state.pendingRemoteCandidates[peerPubkey] || (state.pendingRemoteCandidates[peerPubkey] = []);
    for (const c of candidates) {
      if (c) list.push({ candidate: c, createdAt: created });
    }
    if (list.length > 200) {
      list.splice(0, list.length - 200);
    }
  }

  // חלק שיחות וידאו (chat-video-call.js) – החלת ICE candidates שהתקבלו מוקדם (אחרי setRemoteDescription) | HYPER CORE TECH
  async function flushRemoteCandidates(peerPubkey) {
    if (!peerPubkey) return;
    const list = state.pendingRemoteCandidates[peerPubkey];
    if (!list || list.length === 0) return;
    if (!state.pc || state.currentPeer !== peerPubkey) return;
    if (!state.pc.remoteDescription) return;

    const batch = list.splice(0);
    const offerAt = Number(state.sessionOfferCreatedAt) || 0;
    for (const item of batch) {
      const c = item && item.candidate !== undefined ? item.candidate : item;
      const at = item && item.createdAt !== undefined ? Number(item.createdAt) : 0;
      if (offerAt && at && at + 1 < offerAt) continue;
      if (!c) continue;
      try {
        await state.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.warn('Failed to apply remote ICE (video)', err);
      }
    }
    if (!list.length) {
      try { delete state.pendingRemoteCandidates[peerPubkey]; } catch {}
    }
  }

  // חלק שיחות וידאו – התחלת שיחה יוצאת
  async function start(peerPubkey, opts) {
    if (!isSupported()) throw new Error('הדפדפן לא תומך בוידאו');
    state.outboundStarting = true;
    state.answeredLocally = false;
    state.isIncoming = false;
    noteSessionOffer(Math.floor(Date.now() / 1000));
    try {
      await getLocalStream(opts && opts.video);
      // חלק שיחות וידאו (chat-video-call.js) – איפוס מצב לפני שיחה יוצאת כדי למנוע שאריות ICE/Stream משיחות קודמות | HYPER CORE TECH
      state.isIncoming = false;
      state.isActive = false;
      state.callStartTimestamp = null;
      state.remoteStream = null;
      state.candidateQueue = [];
      clearTimer();
      try { delete state.pendingRemoteCandidates[peerPubkey]; } catch {}
      try { subscribeToSignals(); } catch {}
      state.currentPeer = peerPubkey;
      createPC(peerPubkey);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      await sendSignal(peerPubkey, 'v-offer', offer);
      state.outboundStarting = false;
      state.answeredLocally = true;
      console.log('CALL_STARTED');
      if (typeof App.onVideoCallStarted === 'function') App.onVideoCallStarted(peerPubkey, false);
    } catch (err) {
      state.outboundStarting = false;
      throw err;
    }
  }

  // חלק שיחות וידאו – קבלת שיחה
  async function accept(peerPubkey, offer, meta) {
    if (!isSupported()) throw new Error('הדפדפן לא תומך בוידאו');
    const createdAt = Number(meta && meta.createdAt) || Number(App.__videoIncomingOfferCreatedAt) || 0;
    if (createdAt) noteSessionOffer(createdAt);
    state.isIncoming = true;
    state.answeredLocally = false;
    await getLocalStream();
    // חלק שיחות וידאו (chat-video-call.js) – איפוס מצב לפני קבלה כדי להתמודד עם candidates שמגיעים לפני accept במובייל | HYPER CORE TECH
    state.isIncoming = true;
    state.isActive = false;
    state.callStartTimestamp = null;
    state.remoteStream = null;
    state.candidateQueue = [];
    clearTimer();
    try { subscribeToSignals(); } catch {}
    state.currentPeer = peerPubkey;
    try { state.lastOfferFrom[peerPubkey] = Date.now(); } catch (_) {}
    createPC(peerPubkey);
    const offerNorm = normalizeVideoSessionDescription(offer);
    if (!offerNorm) throw new Error('offer וידאו אינו תקין');
    await state.pc.setRemoteDescription(offerNorm);
    await flushRemoteCandidates(peerPubkey);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await flushRemoteCandidates(peerPubkey);
    await sendSignal(peerPubkey, 'v-answer', answer);
    state.answeredLocally = true;
    console.log('CALL_ACCEPTED');
    if (typeof App.onVideoCallStarted === 'function') App.onVideoCallStarted(peerPubkey, true);
  }

  // חלק שיחות וידאו – סיום
  async function end(opts) {
    const options = opts || {};
    const sid = state.callSessionId || options.sessionId || '';
    const term = getTerminal(sid);
    if (term && term.ended) {
      console.log('CALL_END_ONCE');
      return;
    }
    if (state.ending) return;
    state.ending = true;
    if (term) term.ended = true;
    console.log('CALL_ENDING');
    console.log('CALL_END_ONCE');
    const peer = state.currentPeer;
    const startMs = state.callStartTimestamp;
    const durationSeconds = startMs ? (Date.now() - startMs) / 1000 : 0;
    const wasIncoming = state.isIncoming;
    const wasAnswered = !!startMs || !!state.answeredLocally;
    const userDeclined = !!(options.declined || (term && term.declined) || window.__sosNativePendingDecline);
    if (peer) noteCallEnded(peer);
    if (peer) {
      if (term && term.disconnectSent) {
        console.log('CALL_DISCONNECT_ONCE');
      } else {
        try {
          await sendSignal(peer, 'v-disconnect', null);
          if (term) term.disconnectSent = true;
          console.log('CALL_DISCONNECT_ONCE');
        } catch (err) {
          console.warn('disconnect signal failed', err);
        }
      }
    }
    if (sid) {
      markNativeSessionTerminal(sid, options.declined ? 'DECLINED' : (options.connectedEnd ? 'CONNECTED_END' : 'ENDED'));
    }
    try { if (state.pc) state.pc.close(); } catch {}
    state.pc = null;
    try { if (state.localStream) state.localStream.getTracks().forEach(t=>t.stop()); } catch {}
    try { if (state.remoteStream) state.remoteStream.getTracks().forEach(t=>t.stop()); } catch {}
    state.localStream = null; state.remoteStream = null;
    // חלק שיחות וידאו (chat-video-call.js) – ניקוי תורי ICE כדי למנוע דליפות/תקיעות בין שיחות | HYPER CORE TECH
    state.candidateQueue = [];
    clearTimer();
    state.pendingRemoteCandidates = Object.create(null);
    state.currentPeer = null; state.isIncoming = false; state.isActive = false; state.isMuted = false; state.isCameraOff = false;
    state.sessionOfferCreatedAt = 0;
    state.answeredLocally = false;
    state.outboundStarting = false;
    state.callSessionId = null;
    if (durationSeconds > 0 && peer) {
      // intentionally no Relay call metric (25060 WRITE ZERO)
      void publishCallMetric;
    }
    setTimeout(()=>{ state.ending=false; },100);
    state.callStartTimestamp = null;
    // חלק שיחות וידאו (chat-video-call.js) – התראה על שיחה נכנסת שלא נענתה (missed) | HYPER CORE TECH
    if (wasIncoming && !wasAnswered && peer && !userDeclined) {
      if (term && term.missedSent) {
        console.log('CALL_MISSED_ONCE');
      } else {
        if (term) term.missedSent = true;
        console.log('CALL_MISSED_ONCE');
        if (typeof App.triggerMissedCallPush === 'function') {
          App.triggerMissedCallPush(peer, 'video');
        }
        if (typeof App.onVideoCallMissed === 'function') {
          App.onVideoCallMissed(peer);
        }
      }
    }
    if (typeof App.onVideoCallEnded === 'function') App.onVideoCallEnded(peer);
  }

  // חלק שיחות וידאו – השתקה/מצלמה/החלפת מצלמה
  function toggleMute() {
    if (!state.localStream) return false;
    state.isMuted = !state.isMuted;
    state.localStream.getAudioTracks().forEach(t => t.enabled = !state.isMuted);
    if (typeof App.onVideoCallMuteToggle === 'function') App.onVideoCallMuteToggle(state.isMuted);
    return state.isMuted;
  }
  async function toggleCamera() {
    if (!state.localStream) return false;
    state.isCameraOff = !state.isCameraOff;
    state.localStream.getVideoTracks().forEach(t => t.enabled = !state.isCameraOff);
    if (typeof App.onVideoCallCameraToggle === 'function') App.onVideoCallCameraToggle(state.isCameraOff);
    return state.isCameraOff;
  }
  async function switchCamera() {
    if (!state.pc || !state.localStream) return;

    const sender = state.pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;

    // חלק שיחות וידאו (chat-video-call.js) – ניסיון להחלפה לפי deviceId (אמין יותר במובייל) | HYPER CORE TECH
    let videoInputs = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = (devices || []).filter(d => d && d.kind === 'videoinput');
    } catch {}

    const currentTrack = state.localStream.getVideoTracks()[0] || null;
    const currentSettings = currentTrack && typeof currentTrack.getSettings === 'function' ? currentTrack.getSettings() : null;
    const currentDeviceId = state.videoDeviceId || (currentSettings && currentSettings.deviceId) || null;
    const desiredFacing = state.facingMode === 'user' ? 'environment' : 'user';
    const newFacingMode = desiredFacing;
    const previousFacingMode = state.facingMode;
    const previousVideoDeviceId = state.videoDeviceId;

    const hasCurrentDeviceId = !!currentDeviceId;
    let nextDevice = null;
    if (hasCurrentDeviceId && videoInputs.length >= 2) {
      const wantEnv = desiredFacing === 'environment';
      const re = wantEnv ? /(back|rear|environment)/i : /(front|user)/i;
      nextDevice = videoInputs.find(d => d.deviceId && d.deviceId !== currentDeviceId && re.test(d.label || '')) || null;
      if (!nextDevice) {
        nextDevice = videoInputs.find(d => d.deviceId && d.deviceId !== currentDeviceId) || null;
      }
    }

    let newStream = null;
    if (nextDevice && nextDevice.deviceId) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints({ deviceId: { exact: nextDevice.deviceId } }),
          audio: false
        });
      } catch (err) {
        console.warn('switchCamera deviceId failed, fallback to facingMode', err);
        newStream = null;
      }
    }
    if (!newStream) {
      // fallback: אם אין רשימת מצלמות/אין labels – ננסה facingMode כמו קודם
      state.facingMode = newFacingMode;
      state.videoDeviceId = null;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints({ facingMode: newFacingMode }),
          audio: false
        });
      } catch (err) {
        state.facingMode = previousFacingMode;
        state.videoDeviceId = previousVideoDeviceId;
        console.warn('switchCamera facingMode failed', err);
        return;
      }
    }

    const newTrack = newStream && newStream.getVideoTracks ? newStream.getVideoTracks()[0] : null;
    if (!newTrack) {
      try { newStream && newStream.getTracks && newStream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    }

    await sender.replaceTrack(newTrack);

    // עצירת המסלול הישן והחלפה ב-localStream הקיים
    try {
      if (currentTrack) {
        state.localStream.removeTrack(currentTrack);
        currentTrack.stop();
      }
    } catch {}
    try { state.localStream.addTrack(newTrack); } catch {}

    // עדכון מטא-דאטה
    let st = null;
    try {
      st = typeof newTrack.getSettings === 'function' ? newTrack.getSettings() : null;
      state.videoDeviceId = (st && st.deviceId) ? st.deviceId : (nextDevice && nextDevice.deviceId) || null;
    } catch {}
    state.facingMode = (st && st.facingMode) ? st.facingMode : newFacingMode;

    if (typeof App.onVideoCallLocalStreamChanged === 'function') App.onVideoCallLocalStreamChanged(state.localStream);
  }

  // חלק אבטחה (chat-video-call.js) – אימות חתימת Nostr לסיגנל ריליי 25050 לפני כל שינוי מצב וידאו | HYPER CORE TECH
  function verifyIncomingVideoRelayEvent(event) {
    let idLabel = '';
    try {
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      if (!event || typeof event !== 'object') {
        console.warn('[SO-CALL SECURITY] rejected invalid video-call signal kind=25050 id=' + idLabel);
        return false;
      }
      const tools = window.NostrTools;
      if (!tools || typeof tools.verifyEvent !== 'function') {
        console.warn('[SO-CALL SECURITY] rejected invalid video-call signal kind=25050 id=' + idLabel);
        return false;
      }
      if (tools.verifyEvent(event) !== true) {
        console.warn('[SO-CALL SECURITY] rejected invalid video-call signal kind=25050 id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected invalid video-call signal kind=25050 id=' + idLabel);
      return false;
    }
  }

  // חלק אבטחה (chat-video-call.js) – אימות נמען מקומי לאירועי ריליי וידאו שאינם של המשתמש הנוכחי | HYPER CORE TECH
  function getIncomingVideoRelayRecipient(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (Array.isArray(tag) && tag[0] === 'p') {
        return typeof tag[1] === 'string' ? tag[1].toLowerCase() : '';
      }
    }
    return '';
  }

  function verifyIncomingVideoRelayRecipient(event) {
    let idLabel = '';
    try {
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      const self = (App.publicKey || '').toLowerCase();
      const sender = event && typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
      if (!self || !sender) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=25050 id=' + idLabel);
        return false;
      }
      if (sender === self) {
        return true;
      }
      const recipient = getIncomingVideoRelayRecipient(event);
      if (!recipient || recipient !== self) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=25050 id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=25050 id=' + idLabel);
      return false;
    }
  }

  function getIncomingVideoRelayType(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (Array.isArray(tag) && tag[0] === 'type') {
        return typeof tag[1] === 'string' ? tag[1] : '';
      }
    }
    return '';
  }

  // חלק אבטחה (chat-video-call.js) – רעננות/anti-replay לסיגנל וידאו חי אחרי חתימה ונמען | HYPER CORE TECH
  function verifyIncomingVideoRelayFreshness(event) {
    let idLabel = '';
    try {
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      const created = Number(event && event.created_at) || 0;
      if (!created) return true;
      const age = Math.floor(Date.now() / 1000) - created;
      if (age < 0) return true;
      const type = getIncomingVideoRelayType(event);
      const maxAge = type === 'v-offer' ? MAX_OFFER_AGE_SEC : SIGNAL_LOOKBACK_SEC;
      if (age > maxAge) {
        console.warn('[SO-CALL SECURITY] rejected stale or replayed live signal kind=25050 id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected stale or replayed live signal kind=25050 id=' + idLabel);
      return false;
    }
  }

  // חלק שיחות וידאו – טיפול באירועי אותות נכנסים
  // preParsed: secure gift-wrap path { type, data, sender, sentAt, signalId, sessionId }
  async function handleSignalEvent(event, preParsed) {
    const peer = preParsed && preParsed.sender
      ? String(preParsed.sender).toLowerCase()
      : String(event.pubkey || '').toLowerCase();
    if (peer === String(App.publicKey || '').toLowerCase()) return;

    const dedupeId = (preParsed && preParsed.signalId) || (event && event.id);
    if (dedupeId && rememberProcessedSignalId(dedupeId)) return;

    let type;
    if (preParsed && preParsed.type) {
      type = preParsed.type;
    } else {
      const typeTag = event.tags.find(t => t[0] === 'type');
      if (!typeTag) return;
      type = typeTag[1];
    }
    if (!type || type[0] !== 'v') return; // מתייחס רק לשיחות וידאו

    // חלק שיחות וידאו (chat-video-call.js) – מעקב אחר חיות subscription (לשימוש keepalive/re-subscribe) | HYPER CORE TECH
    state.lastSignalReceivedAt = Date.now();
    try {
      const createdAtTrack = preParsed && preParsed.sentAt
        ? Number(preParsed.sentAt) || 0
        : Number(event.created_at) || 0;
      if (createdAtTrack > state.lastSignalCreatedAt) state.lastSignalCreatedAt = createdAtTrack;
    } catch {}

    let data = null;
    if (preParsed) {
      data = preParsed.data;
    } else if (event.content) {
      if (typeof event.content === 'string' && event.content.length > 524288) return;
      try {
        // LEGACY_READ_ONLY: NIP-04 decrypt for already-deployed clients.
        const dec = await NostrTools.nip04.decrypt(App.privateKey, peer, event.content);
        data = dec ? JSON.parse(dec) : null;
      } catch (err) {
        console.warn('CALL_SIGNAL_HANDLE_FAILED');
        return;
      }
    }

    console.log('CALL_SIGNAL_RECV action=' + String(type) + ' encrypted=' + (preParsed ? 'true' : 'legacy'));
    const createdAt = preParsed && preParsed.sentAt
      ? Number(preParsed.sentAt) || 0
      : Number(event.created_at) || 0;
    if (type !== 'v-offer' && isStaleForCurrentSession(createdAt, peer)) {
      console.log('CALL_SIGNAL_SKIP stale');
      return;
    }
    switch (type) {
      case 'v-offer': {
        // חלק שיחות וידאו (chat-video-call.js) – הגנה מפני offer ישן אחרי re-subscribe | HYPER CORE TECH
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          if (!preParsed && createdAt && (nowSec - createdAt) > MAX_OFFER_AGE_SEC) {
            console.log('CALL_SIGNAL_REJECT stale_offer');
            return;
          }
          if (isOfferReplayAfterHangup(peer, createdAt)) {
            console.log('CALL_SIGNAL_REJECT replay_after_hangup');
            return;
          }
        } catch {}

        let offerData = normalizeVideoSessionDescription(data);
        if (!offerData) {
          console.error('CALL_SIGNAL_REJECT invalid_offer');
          return;
        }

        // דה-דופליקציה
        const now = Date.now();
        const last = state.lastOfferFrom[peer] || 0;
        state.lastOfferFrom[peer] = now;
        if (now - last < 1500) {
          console.log('CALL_SIGNAL_SKIP duplicate_offer');
          return;
        }

        console.log('CALL_OFFER_OK');
        if (state.outboundStarting || (state.pc && !state.isIncoming)) {
          console.log('CALL_SIGNAL_SKIP already_calling');
          return;
        }
        try {
          if (window.__sosAcceptInFlight && window.__sosAcceptInFlightPeer === String(peer).toLowerCase()) {
            noteSessionOffer(createdAt);
            console.log('CALL_SIGNAL_SKIP accept_in_flight');
            return;
          }
        } catch (_) {}
        // חלק שיחות וידאו (chat-video-call.js) – קיבוע peer עבור שיחה נכנסת כדי שאירוע v-disconnect/ביטול יסגור UI גם לפני קבלה | HYPER CORE TECH
        if (state.pc && state.currentPeer === peer) {
          console.log('CALL_SIGNAL_SKIP already_active');
          return;
        }
        if (state.currentPeer && state.currentPeer !== peer) {
          console.log('CALL_SIGNAL_SKIP other_context');
          return;
        }
        noteSessionOffer(createdAt);
        state.currentPeer = peer;
        state.isIncoming = true;
        if (preParsed && preParsed.sessionId) state.callSessionId = preParsed.sessionId;
        // חלק Push (chat-video-call.js) – שליחת התראת Push על שיחת וידאו נכנסת | HYPER CORE TECH
        if (typeof App.triggerIncomingCallPush === 'function') {
          App.triggerIncomingCallPush(peer, 'video');
        }
        if (typeof App.onVideoCallIncoming === 'function') App.onVideoCallIncoming(peer, offerData);
        break;
      }
      case 'v-answer': {
        if (!state.pc || state.currentPeer !== peer) break;
        if (state.isIncoming) {
          console.log('CALL_SIGNAL_SKIP answer_as_callee');
          break;
        }
        const answerData = normalizeVideoSessionDescription(data);
        if (answerData) {
          console.log('CALL_ANSWER_APPLY');
          await state.pc.setRemoteDescription(answerData);
          await flushRemoteCandidates(peer);
        } else {
          console.error('CALL_SIGNAL_REJECT invalid_answer');
        }
        break;
      }
      case 'v-candidates': {
        let candidatesData = data;
        if (typeof candidatesData === 'string') {
          try { candidatesData = JSON.parse(candidatesData); } catch {}
        }
        if (Array.isArray(candidatesData) && isValidIncomingVideoCandidateList(candidatesData)) {
          if (state.pc && state.currentPeer === peer && state.pc.remoteDescription) {
            for (const c of candidatesData) {
              if (!c) continue;
              try {
                await state.pc.addIceCandidate(new RTCIceCandidate(c));
              } catch (err) {
                console.warn('Failed to apply remote ICE (video)', err);
              }
            }
          } else {
            bufferRemoteCandidates(peer, candidatesData, createdAt);
          }
        } else if (candidatesData) {
          console.error('CALL_SIGNAL_REJECT invalid_candidates');
        }
        break;
      }
      case 'v-disconnect': {
        if (state.currentPeer !== peer) break;
        if (state.outboundStarting && !state.pc) {
          console.log('CALL_SIGNAL_SKIP disconnect_outbound_starting');
          break;
        }
        end();
        break;
      }
    }
  }

  async function handleSecureSignal(logical) {
    if (!logical || logical.media !== 'video') return false;
    const synthetic = {
      id: logical.wrapId || logical.signalId,
      pubkey: logical.sender,
      created_at: logical.sentAt,
      kind: 1059,
    };
    enqueueVideoSignalEvent(synthetic, {
      type: logical.wireType || logical.action,
      data: logical.data,
      sender: logical.sender,
      sentAt: logical.sentAt,
      signalId: logical.signalId,
      sessionId: logical.sessionId,
    });
    return true;
  }

  async function handleGiftWrapCallEvent(ev) {
    const api = App.CallSignalE2ee;
    if (api && typeof api.enqueueSecureDispatch === 'function') {
      await api.enqueueSecureDispatch(ev);
      return;
    }
    if (api && typeof api.dispatchGiftWrappedCallSignal === 'function') {
      await api.dispatchGiftWrappedCallSignal(ev);
    }
  }

  // חלק שיחות וידאו (chat-video-call.js) – תור אותות כדי שלא ירוצו במקביל אחרי decrypt | HYPER CORE TECH
  let signalChain = Promise.resolve();
  function enqueueVideoSignalEvent(ev, preParsed) {
    signalChain = signalChain.then(() => handleSignalEvent(ev, preParsed)).catch((err) => {
      console.warn('CALL_SIGNAL_HANDLE_FAILED');
    });
  }

  // חלק שיחות וידאו – הרשמה לאירועים

  // חלק שיחות וידאו (chat-video-call.js) – חישוב since לריענון subscribe (תופס events שקרו בזמן idle) | HYPER CORE TECH
  function computeResubscribeSince() {
    const nowSec = Math.floor(Date.now() / 1000);
    let since = nowSec - SIGNAL_LOOKBACK_SEC;
    const last = Number(state.lastSignalCreatedAt) || 0;
    if (last > 0) since = Math.max(since, last - 2);
    if (since < 0) since = 0;
    return since;
  }

  // חלק שיחות וידאו (chat-video-call.js) – ריענון subscription לסיגנלים אחרי idle/חזרה לפוקוס כדי למנוע פספוס שיחות | HYPER CORE TECH
  function forceResubscribeSignals(reason, options) {
    if (App.guestMode) return;
    if (!App.pool || !App.publicKey) return;
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}

    const now = Date.now();
    const opts = options && typeof options === 'object' ? options : null;
    const forced = !!(opts && opts.force);
    if (!forced && now - (state.signalLastResubscribeAt || 0) < 12000) return;

    // שלב 3: בחזרה לטאב — לא סוגרים מנוי בריא | HYPER CORE TECH
    const softReasons = reason === 'visibilitychange' || reason === 'focus' || reason === 'pageshow';
    if (!forced && softReasons && state.signalSubscription) {
      const last = state.lastSignalReceivedAt || 0;
      if (last && (now - last) < 60000) return;
    }

    state.signalLastResubscribeAt = now;

    const requestedSince = opts && Number.isFinite(Number(opts.since)) ? Number(opts.since) : null;
    const since = requestedSince !== null ? Math.max(0, Math.floor(requestedSince)) : computeResubscribeSince();
    console.log('Video call: re-subscribing signals', reason || '', { since });

    closeSubscriptionSafely(state.signalSubscription);
    state.signalSubscription = null;
    state.lastSignalReceivedAt = now;
    subscribeToSignals({ since, force: true });
  }

  // חלק שיחות וידאו (chat-video-call.js) – keepalive קל: מוודא subscription חי ומרענן אחרי שקט ממושך | HYPER CORE TECH
  function ensureSignalKeepaliveStarted() {
    if (state.signalKeepaliveTimer) return;
    try {
      document.addEventListener('visibilitychange', () => {
        try { if (!document.hidden) forceResubscribeSignals('visibilitychange'); } catch {}
      });
    } catch {}
    try { window.addEventListener('online', () => forceResubscribeSignals('online')); } catch {}
    // שלב 3: בלי focus/pageshow — visibilitychange מספיק (מונע כפילויות) | HYPER CORE TECH

    state.signalKeepaliveTimer = setInterval(() => {
      try {
        if (App.guestMode) return;
        if (!App.pool || !App.publicKey) return;
        try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}
        if (document.hidden) return;

        const now = Date.now();
        const last = state.lastSignalReceivedAt || 0;
        if (!state.signalSubscription) {
          subscribeToSignals();
          return;
        }
        // חלק שיחות וידאו (chat-video-call.js) – ריענון תקופתי כדי למנוע מצב תקוע אחרי idle (בעיקר במובייל) | HYPER CORE TECH
        if (last && (now - last) > 90000) {
          forceResubscribeSignals('keepalive');
        }
      } catch (err) {
        console.warn('Video call keepalive error', err);
      }
    }, 30000);
  }

  // חלק שיחות וידאו (chat-video-call.js) – הרשמה לאירועי סיגנלים עם מניעת כפילות | HYPER CORE TECH
  function subscribeToSignals(options) {
    options = options || {};
    ensureSignalKeepaliveStarted();
    // אורחים לא יכולים להשתמש בשיחות וידאו
    if (App.guestMode) {
      console.log('Video call: disabled for guest users');
      return null;
    }
    if (state.signalSubscription && !options.force) return state.signalSubscription;
    if (!App.pool || !App.publicKey) {
      console.log('Video call: waiting for pool/publicKey...');
      return null;
    }

    if (options.force) {
      closeSubscriptionSafely(state.signalSubscription);
      state.signalSubscription = null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const requestedSince = Number(options.since);
    const since = Number.isFinite(requestedSince) ? Math.max(0, Math.floor(requestedSince)) : (nowSec - 2);
    const filters = [
      {
        // LEGACY_READ_ONLY: direct kind 25050 from already-deployed clients.
        // Secure kind 1059 is owned by CallSignalE2ee.ensureSecureCallSubscription (single unwrap).
        kinds: [25050],
        '#p': [App.publicKey],
        since
      }
    ];
    try {
      console.log('CALL_SUBSCRIBE legacy=25050 (secure=shared-1059)');
      try {
        if (App.CallSignalE2ee && typeof App.CallSignalE2ee.ensureSecureCallSubscription === 'function') {
          App.CallSignalE2ee.ensureSecureCallSubscription();
        }
      } catch (_e) {}
      const sub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (ev) => {
          if (ev && ev.kind === 1059) return;
          // LEGACY_READ_ONLY path
          if (!verifyIncomingVideoRelayEvent(ev)) return;
          if (!verifyIncomingVideoRelayRecipient(ev)) return;
          if (!verifyIncomingVideoRelayFreshness(ev)) return;
          enqueueVideoSignalEvent(ev);
        },
        oneose: () => {
          state.lastSignalReceivedAt = Date.now();
          console.log('CALL_SUBSCRIBE_READY');
        }
      });
      state.signalSubscription = sub;
      state.lastSignalReceivedAt = Date.now();
      return sub;
    } catch (err) {
      console.warn('CALL_SUBSCRIBE_FAILED');
      return null;
    }
  }

  // חלק שיחות וידאו (chat-video-call.js) – ניסיון הרשמה מוקדם + retry עד שה-pool והמפתחות זמינים | HYPER CORE TECH
  function autoSubscribeSignals() {
    if (App.guestMode) {
      return;
    }
    if (state.signalSubscription) {
      return;
    }
    if (!App.pool || !App.publicKey) {
      setTimeout(autoSubscribeSignals, 500);
      return;
    }
    subscribeToSignals();
  }

  // חלק שיחות וידאו – דחייה מ-APK גם בלי offer מוכן | HYPER CORE TECH
  async function rejectIncoming(peerPubkey) {
    const peer = String(peerPubkey || state.currentPeer || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(peer)) return false;
    state.currentPeer = peer;
    state.isIncoming = true;
    state.callStartTimestamp = null;
    if (!state.callSessionId) {
      try {
        const api = App.CallSignalE2ee;
        if (api && typeof api.getCachedSecureOffer === 'function') {
          const hit = api.getCachedSecureOffer(peer);
          if (hit && hit.sessionId) state.callSessionId = hit.sessionId;
        }
      } catch (_e) {}
    }
    const sid = state.callSessionId || '';
    const term = getTerminal(sid);
    if (term) term.declined = true;
    if (sid) markNativeSessionTerminal(sid, 'DECLINED');
    try {
      await end({ declined: true, sessionId: sid });
      return true;
    } catch (err) {
      console.warn('video rejectIncoming failed', err);
      try {
        if (!(term && term.disconnectSent)) {
          await sendSignal(peer, 'v-disconnect', null);
          if (term) term.disconnectSent = true;
        }
      } catch (_) {}
      return false;
    }
  }

  // חלק שיחות וידאו – חשיפה ל-App
  App.videoCall = {
    isSupported,
    start,
    accept,
    end,
    rejectIncoming,
    toggleMute,
    toggleCamera,
    switchCamera,
    subscribe: subscribeToSignals,
    handleSecureSignal,
    getState: () => ({
      currentPeer: state.currentPeer,
      isActive: state.isActive,
      isIncoming: state.isIncoming,
      isMuted: state.isMuted,
      isCameraOff: state.isCameraOff,
      localStream: state.localStream,
      remoteStream: state.remoteStream
    }),
    verifyIncomingRelayEvent: verifyIncomingVideoRelayEvent,
    verifyIncomingRelayRecipient: verifyIncomingVideoRelayRecipient,
    verifyIncomingRelayFreshness: verifyIncomingVideoRelayFreshness,
    markEventProcessed: rememberProcessedSignalId,
    noteIncomingOffer: function noteIncomingOffer(_peerPubkey, createdAtSec) {
      noteSessionOffer(createdAtSec);
    }
  };

  // אתחול מודול
  console.log('Video call module initialized');
  // חלק שיחות וידאו (chat-video-call.js) – חיבור ל-notifyPoolReady כדי להירשם מוקדם גם כשיש עומס טעינה | HYPER CORE TECH
  if (typeof App.notifyPoolReady === 'function') {
    const originalNotify = App.notifyPoolReady;
    App.notifyPoolReady = function(pool) {
      try { originalNotify(pool); } catch (err) { console.warn('notifyPoolReady failed', err); }
      autoSubscribeSignals();
    };
  }

  // חלק Lazy Init (chat-video-call.js) – דחיית האזנה לסיגנלים עד שהמשתמש פותח צ'אט | HYPER CORE TECH
  let lazyInitDone = false;
  function lazyInitVideoCall(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const lookback = Number(opts.lookbackSec) || 0;
    const wantLookback = !!(opts.force || lookback);
    if (wantLookback && !opts.force && state.signalSubscription && (Number(state.videoLookbackUntil) || 0) > Date.now()) {
      lazyInitDone = true;
      console.log('Video call: keep existing lookback sub');
      return;
    }
    if (lazyInitDone && !wantLookback) {
      autoSubscribeSignals();
      return;
    }
    lazyInitDone = true;
    if (wantLookback) {
      try {
        const sec = lookback > 0 ? lookback : 90;
        try {
          if (state.signalSubscription) {
            closeSubscriptionSafely(state.signalSubscription);
            state.signalSubscription = null;
          }
        } catch (_) {}
        subscribeToSignals({ since: Math.floor(Date.now() / 1000) - sec });
        if (state.signalSubscription) {
          state.videoLookbackUntil = Date.now() + 60000;
        }
      } catch (_) {
        autoSubscribeSignals();
      }
    } else {
      autoSubscribeSignals();
    }
    console.log('Video call: lazy init completed', opts);
  }

  function setupLazyTrigger() {
    const chatButton = document.getElementById('chatToggle') || document.querySelector('[data-chat-toggle]');
    if (chatButton) {
      chatButton.addEventListener('click', lazyInitVideoCall, { once: true });
    }
    if (App.pool && App.publicKey && !App.guestMode) {
      setTimeout(lazyInitVideoCall, 10000);
    }
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupLazyTrigger);
    } else {
      setupLazyTrigger();
    }
  } catch (_) {}

  App.initVideoCall = lazyInitVideoCall;
  console.log('Video call module loaded (lazy init)');
  loadEndedCallMap();
})(window);
