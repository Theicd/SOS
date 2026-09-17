// חלק שיחות קול (chat-voice-call.js) – מודול WebRTC לשיחות קוליות בזמן אמת דרך Nostr
// מבוסס על nrtc אבל משולב עם התשתית הקיימת של SOS2
(function initChatVoiceCall(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק שיחות קול (chat-voice-call.js) – הגדרות WebRTC עם STUN server של Google
  const RTC_CONFIG = {
    iceServers:
      (Array.isArray(App.RTC_ICE_SERVERS) && App.RTC_ICE_SERVERS.length > 0
        ? App.RTC_ICE_SERVERS
        : (Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length > 0
            ? window.NostrRTC_ICE
            : [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
              ]))
  };
  const ICE_DISCONNECT_GRACE_MS = 4000;
  // CALL_METRIC_KIND 25060 RETIRED — NEW per-call Relay metrics are ZERO (privacy phase 1)
  const MAX_SIGNAL_SDP_CHARS = 64 * 1024;
  const MAX_SIGNAL_CANDIDATES = 256;
  const MAX_CANDIDATE_FIELD_CHARS = 4096;

  /** SDP מהסיגנלינג / JSON — תמיד מחזיר {type,sdp} או null */
  function normalizeSessionDescription(raw) {
    if (!raw) return null;
    let o = raw;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (_err) { return null; }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.offer && typeof o.offer === 'object' && !o.type && !o.sdp) o = o.offer;
    if (o.answer && typeof o.answer === 'object' && !o.type && !o.sdp) o = o.answer;
    const type = o.type;
    const sdp = typeof o.sdp === 'string' ? o.sdp : '';
    if (typeof type !== 'string' || !type || !sdp) return null;
    if (sdp.length > MAX_SIGNAL_SDP_CHARS) return null;
    return { type, sdp };
  }

  function isValidIncomingCandidateList(raw) {
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (list.length > MAX_SIGNAL_CANDIDATES) return false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
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
  let state = {
    currentPeer: null,
    peerConnection: null,
    currentPeer: null,
    isCallActive: false,
    isIncoming: false,
    isMuted: false,
    callStartTime: null,
    candidateQueue: [],
    candidateTimer: null,
    // חלק שיחות קול (chat-voice-call.js) – באפר ל-ICE candidates נכנסים לפני PC / setRemoteDescription | HYPER CORE TECH
    pendingRemoteCandidates: Object.create(null),
    callAnswered: false,
    iceDisconnectTimer: null,
    lastEndedAt: Object.create(null),
    lastOfferFrom: {},
    waitingOffer: null,
    lastSignalReceivedAt: 0,
    signalLastResubscribeAt: 0,
    signalKeepaliveTimer: null,
    ending: false,
    callStartTimestamp: null,
    callSessionId: null,
    // חלק שיחות קול (chat-voice-call.js) – שמירת audioSession.type כדי להחזיר אותו בסיום השיחה (מובייל) | HYPER CORE TECH
    previousAudioSessionType: null,
    // חלק שיחות קול (chat-voice-call.js) – דגל: האם שינינו AudioSession עבור שיחה (כדי לא לשנות כשדוחים לפני קבלה) | HYPER CORE TECH
    audioSessionTypeApplied: false,
  };

  // חלק שיחות קול (chat-voice-call.js) – סגירה בטוחה של subscription (מוגדר מוקדם כדי להיות זמין לכל הפונקציות) | HYPER CORE TECH
  function closeSubscriptionSafely(sub) {
    if (!sub) return;
    try { if (typeof sub.close === 'function') { sub.close(); return; } } catch {}
    try { if (typeof sub.unsub === 'function') { sub.unsub(); return; } } catch {}
    try { if (typeof sub.unsubscribe === 'function') { sub.unsubscribe(); } } catch {}
  }

  // NEW 25060 WRITE COUNT = ZERO — historical Relay copies may remain; do not publish.
  async function publishCallMetric() {
    return;
  }

  // חלק שיחות קול (chat-voice-call.js) – בדיקת תמיכה בדפדפן
  function isWebRTCSupported() {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.RTCPeerConnection
    );
  }

  // חלק שיחות קול (chat-voice-call.js) – AudioSession (play-and-record) לשיפור ניתוב אודיו במכשירים תומכים | HYPER CORE TECH
  function isAudioSessionTypeSupported() {
    try {
      const session = navigator && navigator.audioSession ? navigator.audioSession : null;
      return !!(session && ('type' in session));
    } catch {
      return false;
    }
  }

  function getAudioSessionTypeSafely() {
    try {
      if (!isAudioSessionTypeSupported()) return null;
      return navigator.audioSession.type || null;
    } catch {
      return null;
    }
  }

  function setAudioSessionTypeSafely(type) {
    try {
      if (!isAudioSessionTypeSupported()) return;
      navigator.audioSession.type = type;
    } catch {}
  }

  function setCallAudioSessionType() {
    if (!isAudioSessionTypeSupported()) return;
    if (state.audioSessionTypeApplied) return;

    state.audioSessionTypeApplied = true;
    state.previousAudioSessionType = getAudioSessionTypeSafely();
    setAudioSessionTypeSafely('play-and-record');
  }

  function restoreAudioSessionType() {
    if (!isAudioSessionTypeSupported()) return;
    if (!state.audioSessionTypeApplied) return;

    state.audioSessionTypeApplied = false;
    const prev = state.previousAudioSessionType;
    state.previousAudioSessionType = null;

    if (typeof prev === 'string' && prev) {
      setAudioSessionTypeSafely(prev);
    } else {
      setAudioSessionTypeSafely('auto');
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – קבלת הרשאות מיקרופון
  async function getLocalStream() {
    if (state.localStream) {
      return state.localStream;
    }

    try {
      if (typeof App.ensureNativeMediaPermissions === 'function') {
        const ok = await App.ensureNativeMediaPermissions(false);
        if (!ok) {
          throw new Error('לא ניתן לגשת למיקרופון. אנא אשר הרשאות באפליקציה.');
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      state.localStream = stream;
      return stream;
    } catch (err) {
      console.error('Failed to get local stream', err);
      throw new Error('לא ניתן לגשת למיקרופון. אנא בדוק הרשאות.');
    }
  }

  // LEGACY_READ_ONLY helper — deterministic room ID must NOT be emitted on NEW secure sends.
  function getRoomId(peerPubkey) {
    const a = (App.publicKey || '').toLowerCase();
    const b = (peerPubkey || '').toLowerCase();
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

  // NEW SEND: Gift Wrap (kind 1059) ONLY — ZERO direct 25050 / NIP-04 / plaintext.
  async function sendSignal(peerPubkey, type, data) {
    if (!App.pool || !App.publicKey || !App.privateKey) {
      console.error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED: pool or keys unavailable');
      throw Object.assign(new Error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED'), { code: 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED' });
    }
    const api = App.CallSignalE2ee;
    if (!api || typeof api.publishGiftWrappedCallSignal !== 'function') {
      throw Object.assign(new Error('CALL_SIGNAL_E2EE_ENCRYPT_FAILED: helper missing'), { code: 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED' });
    }
    try {
      await api.publishGiftWrappedCallSignal({
        media: 'voice',
        peerPubkey,
        type,
        data,
        sessionId: ensureCallSessionId(),
        pool: App.pool,
        relays: App.relayUrls,
        senderPubkey: App.publicKey,
        senderPrivateKey: App.privateKey,
      });
    } catch (err) {
      const code = err && err.code ? err.code : 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED';
      console.error('CALL_SIGNAL_SEND_FAILED code=' + code);
      throw err && err.code ? err : Object.assign(err || new Error(code), { code });
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – שליחת ICE candidates מיידית (trickle) לחיבור מהיר | HYPER CORE TECH
  function queueCandidate(peerPubkey, candidate) {
    if (!candidate) {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) {
        sendSignal(peerPubkey, 'candidates', batch);
      }
      if (state.candidateTimer) {
        clearTimeout(state.candidateTimer);
        state.candidateTimer = null;
      }
      return;
    }

    // trickle מיידי – לא מחכים ל-batch של שנייה+ | HYPER CORE TECH
    sendSignal(peerPubkey, 'candidate', candidate);
  }

  function loadEndedCallMap() {
    // In-memory only — no identity-linked localStorage (sos_voice_ended_v1 removed).
  }

  function noteCallEnded(peerPubkey) {
    const pk = peerPubkeyOrEmpty(peerPubkey);
    if (!pk) return;
    state.lastEndedAt[pk] = Date.now();
    try {
      localStorage.removeItem('sos_voice_ended_v1');
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

  function peerPubkeyOrEmpty(pk) {
    return String(pk || '').toLowerCase();
  }

  function clearIceDisconnectTimer() {
    if (state.iceDisconnectTimer) {
      clearTimeout(state.iceDisconnectTimer);
      state.iceDisconnectTimer = null;
    }
  }

  function isSameCallPeer(peerPubkey) {
    return !!(state.currentPeer && peerPubkeyOrEmpty(state.currentPeer) === peerPubkeyOrEmpty(peerPubkey));
  }

  function bufferRemoteCandidates(peerPubkey, candidates) {
    if (!peerPubkey || !Array.isArray(candidates) || candidates.length === 0) return;
    if (state.currentPeer && !isSameCallPeer(peerPubkey)) return;
    const pk = peerPubkeyOrEmpty(peerPubkey);
    const list = state.pendingRemoteCandidates[pk] || (state.pendingRemoteCandidates[pk] = []);
    for (const c of candidates) {
      if (c) list.push(c);
    }
    if (list.length > 200) {
      list.splice(0, list.length - 200);
    }
  }

  async function flushRemoteCandidates(peerPubkey) {
    if (!peerPubkey) return;
    const pk = peerPubkeyOrEmpty(peerPubkey);
    const list = state.pendingRemoteCandidates[pk];
    if (!list || list.length === 0) return;
    const pc = state.peerConnection;
    if (!pc || !isSameCallPeer(peerPubkey) || !pc.remoteDescription) return;

    const batch = list.splice(0);
    let applied = 0;
    for (const c of batch) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
        applied += 1;
      } catch (err) {
        console.warn('Failed to apply remote ICE (voice)', err);
      }
    }
    if (!list.length) {
      try { delete state.pendingRemoteCandidates[pk]; } catch {}
    }
    if (applied) {
      console.log('Applied buffered ICE candidates', applied);
    }
  }

  async function addOrBufferRemoteCandidates(peerPubkey, candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : (candidates ? [candidates] : []);
    if (!list.length) return;
    const pc = state.peerConnection;
    const canApply = !!(pc && isSameCallPeer(peerPubkey) && pc.remoteDescription);
    if (canApply) {
      for (const c of list) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch (err) {
          console.warn('Failed to apply remote ICE (voice)', err);
        }
      }
      return;
    }
    bufferRemoteCandidates(peerPubkey, list);
  }

  // חלק שיחות קול (chat-voice-call.js) – יצירת חיבור WebRTC חדש
  function createPeerConnection(peerPubkey) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // חלק שיחות קול (chat-voice-call.js) – הוספת הזרם המקומי
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
      });
    }

    // חלק שיחות קול (chat-voice-call.js) – קבלת הזרם המרוחק
    pc.ontrack = (event) => {
      console.log('Received remote track');
      if (!state.remoteStream) {
        state.remoteStream = new MediaStream();
      }
      event.streams[0].getTracks().forEach(track => {
        state.remoteStream.addTrack(track);
        try {
          track.onended = () => {
            console.log('Remote track ended');
            if (!state.ending) endCall();
          };
        } catch {}
      });
      
      // עדכון UI
      if (typeof App.onVoiceCallRemoteStream === 'function') {
        App.onVoiceCallRemoteStream(state.remoteStream);
      }
    };

    // חלק שיחות קול (chat-voice-call.js) – שליחת ICE candidates בצבירה
    pc.onicecandidate = (event) => {
      // שולחים רק בצבירה, ובסיום (candidate=null) מבצעים flush
      queueCandidate(peerPubkey, event.candidate || null);
    };

    // חלק שיחות קול (chat-voice-call.js) – מעקב אחר מצב החיבור
    pc.oniceconnectionstatechange = () => {
      if (state.peerConnection !== pc) return;
      const ice = pc.iceConnectionState;
      console.log('ICE connection state:', ice);

      if (ice === 'connected' || ice === 'completed') {
        clearIceDisconnectTimer();
        state.isCallActive = true;
        // חלק שיחות קול (chat-voice-call.js) – מסנכרן זמן התחלת שיחה עבור UI (callStartTime) וגם עבור מדדים (callStartTimestamp) | HYPER CORE TECH
        state.callStartTimestamp = Date.now();
        state.callStartTime = state.callStartTimestamp;
        if (typeof App.onVoiceCallConnected === 'function') {
          App.onVoiceCallConnected(peerPubkey);
        }
        console.log('CALL_CONNECTED');
      } else if (ice === 'disconnected') {
        if (state.iceDisconnectTimer || state.ending) return;
        state.iceDisconnectTimer = setTimeout(() => {
          state.iceDisconnectTimer = null;
          if (state.ending || state.peerConnection !== pc) return;
          const still = pc.iceConnectionState;
          if (still === 'disconnected' || still === 'failed' || still === 'closed') {
            console.log('ICE disconnected persisted, closing call');
            endCall();
          }
        }, ICE_DISCONNECT_GRACE_MS);
      } else if (ice === 'failed' || ice === 'closed') {
        clearIceDisconnectTimer();
        console.log('ICE state ended, closing call');
        if (!state.ending) endCall();
      }
    };

    // חלק שיחות קול (chat-voice-call.js) – ניטור מצב כלל החיבור
    pc.onconnectionstatechange = () => {
      if (state.peerConnection !== pc) return;
      const cs = pc.connectionState;
      console.log('Peer connection state:', cs);
      if (cs === 'connected') {
        clearIceDisconnectTimer();
      } else if (cs === 'failed' || cs === 'closed') {
        clearIceDisconnectTimer();
        if (!state.ending) endCall();
      }
    };

    return pc;
  }

  // חלק שיחות קול (chat-voice-call.js) – התחלת שיחה יוצאת
  async function startCall(peerPubkey) {
    if (!isWebRTCSupported()) {
      throw new Error('הדפדפן שלך לא תומך בשיחות קוליות');
    }

    if (state.isCallActive) {
      throw new Error('שיחה כבר פעילה');
    }

    try {
      // חלק שיחות קול (chat-voice-call.js) – הגדרת AudioSession לשיחה לפני בקשת מיקרופון (Best Effort) | HYPER CORE TECH
      setCallAudioSessionType();
      // קבלת הרשאות מיקרופון
      await getLocalStream();

      // יצירת חיבור
      state.currentPeer = peerPubkey;
      state.peerConnection = createPeerConnection(peerPubkey);
      state.callSessionId = null;
      ensureCallSessionId();
      // חלק שיחות קול (chat-voice-call.js) – איפוס זמן התחלה עד לחיבור בפועל (connected)
      state.callStartTimestamp = null;
      state.callStartTime = null;
      state.callAnswered = false;
      clearIceDisconnectTimer();
      try { delete state.pendingRemoteCandidates[peerPubkeyOrEmpty(peerPubkey)]; } catch {}

      // יצירת offer
      const offer = await state.peerConnection.createOffer();
      if (!offer || !offer.type || !offer.sdp) {
        throw new Error('Offer לא תקין מהדפדפן');
      }
      await state.peerConnection.setLocalDescription(offer);

      // שליחת offer
      await sendSignal(peerPubkey, 'offer', offer);

      console.log('CALL_STARTED');

      // עדכון UI
      if (typeof App.onVoiceCallStarted === 'function') {
        App.onVoiceCallStarted(peerPubkey, false);
      }
    } catch (err) {
      console.error('Failed to start call', err);
      endCall();
      throw err;
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – קבלת שיחה נכנסת
  async function acceptCall(peerPubkey, offer) {
    if (!isWebRTCSupported()) {
      throw new Error('הדפדפן שלך לא תומך בשיחות קוליות');
    }

    // כבר בשיחה פעילה עם אותו peer – לא מאפסים SDP (מונע שבירת retries מ-APK) | HYPER CORE TECH
    try {
      const samePeer = state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey || '').toLowerCase();
      const pc = state.peerConnection;
      const cs = pc && (pc.connectionState || pc.iceConnectionState);
      if (samePeer && pc && (state.isCallActive || cs === 'connected' || cs === 'connecting' || cs === 'checking')) {
        console.log('CALL_ACCEPT_SKIP already_in_call');
        return;
      }
    } catch (_) {}

    let answerSent = false;
    try {
      // חלק שיחות קול (chat-voice-call.js) – הגדרת AudioSession לשיחה לפני בקשת מיקרופון (Best Effort) | HYPER CORE TECH
      setCallAudioSessionType();
      // קבלת הרשאות מיקרופון
      await getLocalStream();

      // יצירת חיבור
      state.currentPeer = peerPubkey;
      state.peerConnection = createPeerConnection(peerPubkey);
      // חלק שיחות קול (chat-voice-call.js) – איפוס זמן התחלה עד לחיבור בפועל (connected)
      state.callStartTimestamp = null;
      state.callStartTime = null;
      state.callAnswered = false;
      state.isIncoming = true;
      clearIceDisconnectTimer();

      // קבלת offer (אימות + נרמול {type,sdp} אחרי סריאליזציה מ-Nostr/QA)
      const offerNorm = normalizeSessionDescription(offer);
      if (!offerNorm) {
        console.error('Invalid offer received', { reason: 'invalid-sdp', type: typeof offer, sdpLength: offer && offer.sdp ? String(offer.sdp).length : 0 });
        throw new Error('ה-offer שהתקבל אינו תקין');
      }
      console.log('Applying remote offer', { type: offerNorm.type, sdpLen: offerNorm.sdp?.length });
      await state.peerConnection.setRemoteDescription(offerNorm);
      await flushRemoteCandidates(peerPubkey);

      // יצירת answer
      const answer = await state.peerConnection.createAnswer();
      await state.peerConnection.setLocalDescription(answer);
      await flushRemoteCandidates(peerPubkey);

      // שליחת answer
      await sendSignal(peerPubkey, 'answer', answer);
      answerSent = true;
      state.callAnswered = true;

      console.log('CALL_ACCEPTED');

      // עדכון UI
      if (typeof App.onVoiceCallStarted === 'function') {
        App.onVoiceCallStarted(peerPubkey, true);
      }
    } catch (err) {
      console.error('Failed to accept call', err);
      if (answerSent) {
        endCall();
      } else {
        // ניקוי מקומי בלי disconnect – מאפשר retry אוטומטי מ-APK | HYPER CORE TECH
        try {
          if (state.peerConnection) {
            state.peerConnection.close();
            state.peerConnection = null;
          }
        } catch (_) {}
        try {
          if (state.localStream) {
            state.localStream.getTracks().forEach((t) => t.stop());
            state.localStream = null;
          }
        } catch (_) {}
        state.isCallActive = false;
      }
      throw err;
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – סיום שיחה
  async function endCall() {
    if (state.ending) return;
    state.ending = true;
    console.log('CALL_ENDING');

    // שליחת אירוע disconnect – חשוב await כדי שדחייה מ-APK תגיע לצד השני | HYPER CORE TECH
    if (state.currentPeer) {
      try {
        await sendSignal(state.currentPeer, 'disconnect', null);
      } catch (err) {
        console.warn('disconnect signal failed', err);
      }
    }

    // חלק שיחות קול (chat-voice-call.js) – חישוב משך שיחה לפי timestamp זמין (תאימות ל-UI ולמדדים) | HYPER CORE TECH
    const startMs = state.callStartTimestamp || state.callStartTime;
    const durationSeconds = startMs ? (Date.now() - startMs) / 1000 : 0;

    // חלק שיחות קול (chat-voice-call.js) – זיהוי שיחה נכנסת שלא נענתה (לפני איפוס state) | HYPER CORE TECH
    const wasIncoming = state.isIncoming;
    const wasAnswered = !!startMs || !!state.callAnswered;
    const peer = state.currentPeer;
    if (peer) noteCallEnded(peer);

    // סגירת חיבור
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    // עצירת זרמים
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => track.stop());
      state.localStream = null;
    }

    if (state.remoteStream) {
      state.remoteStream.getTracks().forEach(track => track.stop());
      state.remoteStream = null;
    }

    // ניקוי תור candidates
    state.candidateQueue = [];
    if (state.candidateTimer) {
      clearTimeout(state.candidateTimer);
      state.candidateTimer = null;
    }
    state.pendingRemoteCandidates = Object.create(null);
    clearIceDisconnectTimer();

    // איפוס מצב
    state.currentPeer = null;
    state.isCallActive = false;
    state.isIncoming = false;
    state.isMuted = false;
    state.callAnswered = false;
    state.callStartTimestamp = null;
    state.callStartTime = null;
    state.callSessionId = null;
    // חלק שיחות קול (chat-voice-call.js) – שחזור AudioSession לסוג שהיה לפני השיחה | HYPER CORE TECH
    restoreAudioSessionType();
    setTimeout(() => { state.ending = false; }, 100);

    if (durationSeconds > 0 && peer) {
      // intentionally no Relay call metric (25060 WRITE ZERO)
      void publishCallMetric;
    }

    // חלק שיחות קול (chat-voice-call.js) – התראה על שיחה שלא נענתה (נכנסת + לא נענתה) | HYPER CORE TECH
    if (wasIncoming && !wasAnswered && peer) {
      // חלק Push (chat-voice-call.js) – שליחת Push על שיחה שהוחמצה | HYPER CORE TECH
      if (typeof App.triggerMissedCallPush === 'function') {
        App.triggerMissedCallPush(peer, 'voice');
      }
      if (typeof App.onVoiceCallMissed === 'function') {
        App.onVoiceCallMissed(peer);
      }
    }

    // עדכון UI
    if (typeof App.onVoiceCallEnded === 'function') {
      App.onVoiceCallEnded(peer);
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – השתקת/ביטול השתקת מיקרופון
  function toggleMute() {
    if (!state.localStream) return;

    state.isMuted = !state.isMuted;
    state.localStream.getAudioTracks().forEach(track => {
      track.enabled = !state.isMuted;
    });

    if (typeof App.onVoiceCallMuteToggle === 'function') {
      App.onVoiceCallMuteToggle(state.isMuted);
    }

    return state.isMuted;
  }

  // חלק שיחות קול (chat-voice-call.js) – טיפול באירועי סינכרון נכנסים
  // preParsed: secure gift-wrap path { type, data, sender, sentAt, signalId }
  async function handleSignalEvent(event, preParsed) {
    const peerPubkey = preParsed && preParsed.sender
      ? String(preParsed.sender).toLowerCase()
      : event.pubkey;
    if (peerPubkey === App.publicKey) return;
    
    // חלק דה-דופליקציה (chat-voice-call.js) – דילוג על אירועים שכבר עובדו (מונע שיחות כפולות אחרי רענון) | HYPER CORE TECH
    const dedupeId = (preParsed && preParsed.signalId) || event.id;
    if (dedupeId && isCallEventProcessed(dedupeId)) {
      // מאפשרים offer שוב אם יש מענה ממתין מ-APK (אחרת השיחה נתקעת בלי SDP) | HYPER CORE TECH
      try {
        const pending = window.__sosNativePendingAnswer;
        const pendingDecline = window.__sosNativePendingDecline;
        const peer = String(peerPubkey || '').toLowerCase();
        const allowReplay = (pending && pending.peer === peer && Date.now() < (pending.until || 0))
          || (pendingDecline && pendingDecline.peer === peer && Date.now() < (pendingDecline.until || 0));
        if (!allowReplay) {
          console.log('CALL_SIGNAL_SKIP already_processed');
          return;
        }
      } catch (_) {
        console.log('CALL_SIGNAL_SKIP already_processed');
        return;
      }
    }

    let type;
    if (preParsed && preParsed.type) {
      type = preParsed.type;
    } else {
      const typeTag = event.tags.find(t => t[0] === 'type');
      if (!typeTag) return;
      type = typeTag[1];
    }
    // אותות שידור חי (live-*) לא שייכים לשיחות קול | HYPER CORE TECH
    if (String(type || '').startsWith('live-')) return;

    try {
      if (!preParsed && event.content && typeof event.content === 'string' && event.content.length > 524288) {
        return;
      }
      let data = null;
      if (preParsed) {
        data = preParsed.data;
      } else if (event.content) {
        // LEGACY_READ_ONLY: NIP-04 decrypt for already-deployed clients.
        const decrypted = await window.NostrTools.nip04.decrypt(
          App.privateKey,
          peerPubkey,
          event.content
        );
        data = decrypted ? JSON.parse(decrypted) : null;
      }

      console.log('CALL_SIGNAL_RECV action=' + String(type) + ' encrypted=' + (preParsed ? 'true' : 'legacy'));

      switch (type) {
        case 'offer':
          // שיחה נכנסת – ולידציה והמרה במקרה הצורך
          try {
            const createdAt = preParsed && preParsed.sentAt ? preParsed.sentAt : event.created_at;
            if (!preParsed && isOfferEventTooOld(event)) {
              console.log('CALL_SIGNAL_REJECT stale_offer');
              if (dedupeId) markCallEventProcessed(dedupeId);
              return;
            }
            if (isOfferReplayAfterHangup(peerPubkey, createdAt)) {
              console.log('CALL_SIGNAL_REJECT replay_after_hangup');
              if (dedupeId) markCallEventProcessed(dedupeId);
              return;
            }
            let offerData = normalizeSessionDescription(data);
            if (!offerData) {
              console.error('CALL_SIGNAL_REJECT invalid_offer');
              return;
            }
            // דה-דופליקציה: מתעלם מהצעות כפולות מאותו peer בחלון קצר
            const now = Date.now();
            const last = state.lastOfferFrom[peerPubkey] || 0;
            state.lastOfferFrom[peerPubkey] = now;
            if (now - last < 1500) {
              console.log('CALL_SIGNAL_SKIP duplicate_offer');
              return;
            }
            // כבר בשיחה פעילה עם אותו peer – לא לפתוח דיאלוג שני | HYPER CORE TECH
            if (state.isCallActive && state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase()) {
              console.log('CALL_SIGNAL_SKIP already_active');
              if (dedupeId) markCallEventProcessed(dedupeId);
              return;
            }
            // חיבור בתהליך (לפני isCallActive) או accept בתהליך – לא לצלצל שוב | HYPER CORE TECH
            try {
              const samePeer = state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase();
              const pc = state.peerConnection;
              const cs = pc && String(pc.connectionState || pc.iceConnectionState || '');
              const acceptBusy = !!(window.__sosAcceptInFlight && String(window.__sosAcceptInFlightPeer || '').toLowerCase() === String(peerPubkey).toLowerCase());
              if (samePeer && (acceptBusy || cs === 'connected' || cs === 'connecting' || cs === 'checking' || cs === 'completed')) {
                console.log('CALL_SIGNAL_SKIP connecting');
                if (dedupeId) markCallEventProcessed(dedupeId);
                return;
              }
            } catch (_) {}
            // חלק דה-דופליקציה (chat-voice-call.js) – סימון האירוע כמעובד כדי שלא יופיע שוב אחרי רענון | HYPER CORE TECH
            if (dedupeId) markCallEventProcessed(dedupeId);
            console.log('CALL_OFFER_OK');
            // חלק שיחות קול (chat-voice-call.js) – שיחה ממתינה: אם יש שיחה פעילה מפיר אחר, לא מצלצלים אלא מתריעים בלבד | HYPER CORE TECH
            if (state.isCallActive && state.currentPeer && state.currentPeer !== peerPubkey) {
              state.waitingOffer = { peer: peerPubkey, offer: offerData, ts: now };
              if (typeof App.onVoiceCallWaiting === 'function') {
                App.onVoiceCallWaiting(peerPubkey, offerData);
              }
              return;
            }
            // קיבוע peer עבור שיחה נכנסת כדי שאירוע disconnect/ביטול יסגור UI גם לפני קבלה | HYPER CORE TECH
            if (state.currentPeer && state.currentPeer !== peerPubkey) {
              console.log('CALL_SIGNAL_SKIP other_context');
              return;
            }
            // אותו peer כבר ב־context (מסך ענה פתוח) – לא לפתוח שוב | HYPER CORE TECH
            if (state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase() && state.isIncoming) {
              console.log('CALL_SIGNAL_SKIP already_incoming');
              return;
            }
            state.currentPeer = peerPubkey;
            state.isIncoming = true;
            if (preParsed && preParsed.sessionId) state.callSessionId = preParsed.sessionId;
            // חלק Push (chat-voice-call.js) – שליחת התראת Push על שיחה נכנסת | HYPER CORE TECH
            if (typeof App.triggerIncomingCallPush === 'function') {
              App.triggerIncomingCallPush(peerPubkey, 'voice');
            }
            if (typeof App.onVoiceCallIncoming === 'function') {
              App.onVoiceCallIncoming(peerPubkey, offerData);
            }
          } catch (e) {
            console.error('CALL_SIGNAL_REJECT offer_parse');
          }
          break;

        case 'connect':
          // הודעת נוכחות/התחברות – לא מפעילים UI ולא משנים incomingOffer
          console.log('CALL_PEER_PRESENCE');
          break;

        case 'answer':
          // תשובה לשיחה יוצאת
          if (state.peerConnection && state.currentPeer === peerPubkey) {
            const answerData = normalizeSessionDescription(data);
            if (!answerData) {
              console.error('CALL_SIGNAL_REJECT invalid_answer');
              return;
            }
            console.log('CALL_ANSWER_APPLY');
            await state.peerConnection.setRemoteDescription(answerData);
            await flushRemoteCandidates(peerPubkey);
            state.callAnswered = true;
            // עוצרים חיוג מיד כשמגיע answer – לא מחכים ל-ICE | HYPER CORE TECH
            if (typeof App.onVoiceCallAnswerReceived === 'function') {
              App.onVoiceCallAnswerReceived(peerPubkey);
            }
          }
          break;

        case 'candidate':
          // ICE candidate בודד (תאימות לאחור)
          if (!isValidIncomingCandidateList(data)) return;
          await addOrBufferRemoteCandidates(peerPubkey, data);
          break;

        case 'candidates':
          // ICE candidates מרובים (batch)
          if (!isValidIncomingCandidateList(data)) return;
          await addOrBufferRemoteCandidates(peerPubkey, data);
          break;

        case 'disconnect':
          // ניתוק מהצד השני
          // חלק שיחות קול (chat-voice-call.js) – ביטול/ניתוק: סוגרים רק אם זה ה-peer הנוכחי (כולל לפני קבלה) | HYPER CORE TECH
          if (state.currentPeer === peerPubkey) {
            endCall();
          }
          break;
      }
    } catch (err) {
      console.error('CALL_SIGNAL_HANDLE_FAILED');
    }
  }

  async function handleGiftWrapCallEvent(ev) {
    const api = App.CallSignalE2ee;
    if (!api || typeof api.unwrapGiftWrappedCallSignal !== 'function') return;
    const unwrapped = await api.unwrapGiftWrappedCallSignal(ev, App.privateKey, App.publicKey);
    if (!unwrapped || unwrapped.media !== 'voice') return;
    await handleSignalEvent(ev, {
      type: unwrapped.wireType,
      data: unwrapped.data,
      sender: unwrapped.sender,
      sentAt: unwrapped.sentAt,
      signalId: unwrapped.signalId,
      sessionId: unwrapped.sessionId,
    });
  }

  // חלק שיחות קול (chat-voice-call.js) – זמן התחלת ניסיון הרשמה לתפוס שיחות שנכנסו בזמן טעינה | HYPER CORE TECH
  let voiceSubscribeStartTime = Date.now();
  
  // חלק דה-דופליקציה (chat-voice-call.js) – מניעת עיבוד כפול של אירועי שיחה אחרי רענון | HYPER CORE TECH
  const PROCESSED_CALLS_KEY = 'sos_processed_call_events_v2';
  const MAX_PROCESSED_IDS = 100;
  const PROCESSED_TTL_MS = 10 * 60 * 1000;
  const MAX_OFFER_AGE_SEC = 60;
  const VOICE_SIGNAL_MAX_AGE_SEC = 180;

  function getProcessedCallEntries() {
    try {
      const raw = localStorage.getItem(PROCESSED_CALLS_KEY) || sessionStorage.getItem(PROCESSED_CALLS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      const now = Date.now();
      return parsed.filter(function(e) {
        if (typeof e === 'string') return true;
        return e && e.id && (!e.at || (now - e.at) < PROCESSED_TTL_MS);
      }).map(function(e) {
        return typeof e === 'string' ? { id: e, at: now } : e;
      });
    } catch (_) { return []; }
  }

  function getProcessedCallIds() {
    return getProcessedCallEntries().map(function(e) { return e.id; });
  }

  function markCallEventProcessed(eventId) {
    try {
      if (!eventId) return;
      const now = Date.now();
      const entries = getProcessedCallEntries().filter(function(e) { return e.id !== eventId; });
      entries.push({ id: eventId, at: now });
      while (entries.length > MAX_PROCESSED_IDS) entries.shift();
      const raw = JSON.stringify(entries);
      localStorage.setItem(PROCESSED_CALLS_KEY, raw);
      sessionStorage.setItem(PROCESSED_CALLS_KEY, raw);
    } catch (_) {}
  }

  function isCallEventProcessed(eventId) {
    return getProcessedCallIds().includes(eventId);
  }

  function isOfferEventTooOld(event) {
    const created = Number(event && event.created_at) || 0;
    if (!created) return false;
    const age = Math.floor(Date.now() / 1000) - created;
    return age > MAX_OFFER_AGE_SEC;
  }

  // חלק שיחות קול (chat-voice-call.js) – דחייה מ-APK גם בלי offer/UI מוכן | HYPER CORE TECH
  async function rejectIncoming(peerPubkey) {
    const peer = String(peerPubkey || state.currentPeer || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(peer)) return false;
    state.currentPeer = peer;
    state.isIncoming = true;
    state.callStartTimestamp = null;
    state.callStartTime = null;
    try {
      await endCall();
      return true;
    } catch (err) {
      console.warn('rejectIncoming failed', err);
      try {
        await sendSignal(peer, 'disconnect', null);
      } catch (_) {}
      return false;
    }
  }

  // חלק אבטחה (chat-voice-call.js) – אימות חתימת Nostr לסיגנל ריליי 25050 לפני כל שינוי מצב | HYPER CORE TECH
  function verifyIncomingVoiceRelayEvent(event) {
    let idLabel = '';
    try {
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      if (!event || typeof event !== 'object') {
        console.warn('[SO-CALL SECURITY] rejected invalid voice-call signal kind=25050 id=' + idLabel);
        return false;
      }
      const tools = window.NostrTools;
      if (!tools || typeof tools.verifyEvent !== 'function') {
        console.warn('[SO-CALL SECURITY] rejected invalid voice-call signal kind=25050 id=' + idLabel);
        return false;
      }
      if (tools.verifyEvent(event) !== true) {
        console.warn('[SO-CALL SECURITY] rejected invalid voice-call signal kind=25050 id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected invalid voice-call signal kind=25050 id=' + idLabel);
      return false;
    }
  }

  // חלק אבטחה (chat-voice-call.js) – אימות נמען מקומי לאירועי ריליי שאינם של המשתמש הנוכחי | HYPER CORE TECH
  function getIncomingVoiceRelayRecipient(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (Array.isArray(tag) && tag[0] === 'p') {
        return typeof tag[1] === 'string' ? tag[1].toLowerCase() : '';
      }
    }
    return '';
  }

  function verifyIncomingVoiceRelayRecipient(event) {
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
      const recipient = getIncomingVoiceRelayRecipient(event);
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

  function getIncomingVoiceRelayType(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (Array.isArray(tag) && tag[0] === 'type') {
        return typeof tag[1] === 'string' ? tag[1] : '';
      }
    }
    return '';
  }

  function isNativePendingVoiceReplay(event) {
    try {
      const peer = String(event && event.pubkey || '').toLowerCase();
      if (!peer) return false;
      const pending = window.__sosNativePendingAnswer;
      const pendingDecline = window.__sosNativePendingDecline;
      return ((pending && pending.peer === peer && Date.now() < (pending.until || 0))
        || (pendingDecline && pendingDecline.peer === peer && Date.now() < (pendingDecline.until || 0)));
    } catch (_err) {
      return false;
    }
  }

  // חלק אבטחה (chat-voice-call.js) – רעננות/anti-replay לסיגנל חי אחרי חתימה ונמען | HYPER CORE TECH
  function verifyIncomingVoiceRelayFreshness(event) {
    let idLabel = '';
    try {
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      if (isNativePendingVoiceReplay(event)) return true;
      const created = Number(event && event.created_at) || 0;
      if (!created) return true;
      const age = Math.floor(Date.now() / 1000) - created;
      if (age < 0) return true;
      const type = getIncomingVoiceRelayType(event);
      const maxAge = type === 'offer' ? MAX_OFFER_AGE_SEC : VOICE_SIGNAL_MAX_AGE_SEC;
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

  // חלק שיחות קול (chat-voice-call.js) – הרשמה לאירועי סינכרון עם since מורחב | HYPER CORE TECH
  function subscribeToSignals(options) {
    options = options || {};
    ensureSignalKeepaliveStarted();
    if (state.signalSubscription && !options.force) return state.signalSubscription;
    if (!App.pool || !App.publicKey) {
      console.log('Voice call: waiting for pool/publicKey...');
      return null;
    }

    if (options.force) {
      closeSubscriptionSafely(state.signalSubscription);
      state.signalSubscription = null;
    }

    // since מורחב: לתפוס offer שנשלח כשהמסך היה כבוי | HYPER CORE TECH
    const lookback = Number.isFinite(Number(options.lookbackSec)) ? Number(options.lookbackSec) : null;
    const requestedSince = Number.isFinite(Number(options.since)) ? Number(options.since) : null;
    const timeSinceStart = Math.floor((Date.now() - voiceSubscribeStartTime) / 1000);
    const since = requestedSince !== null
      ? Math.max(0, Math.floor(requestedSince))
      : Math.floor(Date.now() / 1000) - Math.max(
          lookback != null ? lookback : 0,
          timeSinceStart + 5,
          90
        );
    const filters = [
      {
        // Gift-wrap lookback covers NIP-59 randomized created_at (up to ~2 days past).
        kinds: [1059],
        '#p': [App.publicKey],
        since: Math.floor(Date.now() / 1000) - (2 * 24 * 60 * 60) - 120,
      },
      {
        // LEGACY_READ_ONLY: direct kind 25050 from already-deployed clients.
        kinds: [25050],
        '#p': [App.publicKey],
        since
      }
    ];

    try {
      console.log('CALL_SUBSCRIBE secure=1059 legacy=25050');
      const sub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (ev) => {
          if (ev && ev.kind === 1059) {
            if (!verifyIncomingVoiceRelayEvent(ev)) return;
            if (!verifyIncomingVoiceRelayRecipient(ev)) return;
            // Freshness for gift-wrap uses INNER sentAt after unwrap — not outer created_at.
            state.lastSignalReceivedAt = Date.now();
            handleGiftWrapCallEvent(ev);
            return;
          }
          // LEGACY_READ_ONLY path
          if (!verifyIncomingVoiceRelayEvent(ev)) return;
          if (!verifyIncomingVoiceRelayRecipient(ev)) return;
          if (!verifyIncomingVoiceRelayFreshness(ev)) return;
          state.lastSignalReceivedAt = Date.now();
          handleSignalEvent(ev);
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

  // חלק שיחות קול (chat-voice-call.js) – רענון subscription לאחר idle/חזרה מפוקוס | HYPER CORE TECH
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
  const since = requestedSince !== null ? Math.max(0, Math.floor(requestedSince)) : Math.max(0, Math.floor(Date.now() / 1000) - 2);
  console.log('Voice call: re-subscribing signals', reason || '', { since });

  closeSubscriptionSafely(state.signalSubscription);
  state.signalSubscription = null;
  state.lastSignalReceivedAt = now;
  subscribeToSignals({ since, force: true });
}

  // חלק שיחות קול (chat-voice-call.js) – keepalive: רענון אחרי idle, האזנה לפוקוס/רשת | HYPER CORE TECH
  function ensureSignalKeepaliveStarted() {
    if (state.signalKeepaliveTimer) return;
    try {
      document.addEventListener('visibilitychange', () => {
        try { if (!document.hidden) forceResubscribeSignals('visibilitychange'); } catch {}
      });
    } catch {}
    try { window.addEventListener('online', () => forceResubscribeSignals('online')); } catch {}
    // שלב 3: בלי focus/pageshow — visibilitychange מספיק | HYPER CORE TECH

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
        if (last && (now - last) > 90000) {
          forceResubscribeSignals('keepalive');
        }
      } catch (err) {
        console.warn('Voice call keepalive error', err);
      }
    }, 30000);
  }

  // חלק שיחות קול (chat-voice-call.js) – אתחול הרשמה אוטומטית לסיגנלים עם retry מהיר | HYPER CORE TECH
  function autoSubscribeSignals() {
    // אורחים: לא מפעילים שיחות קול כדי למנוע UX תקול
    if (App.guestMode) {
      return;
    }
    if (state.signalSubscription) {
      return;
    }
    if (!App.pool || !App.publicKey) {
      setTimeout(autoSubscribeSignals, 300); // מהיר יותר - 300ms במקום 500ms
      return;
    }
    subscribeToSignals();
  }

  // חלק שיחות קול (chat-voice-call.js) – חשיפת API
  Object.assign(App, {
    voiceCall: {
      isSupported: isWebRTCSupported,
      start: startCall,
      accept: acceptCall,
      end: endCall,
      rejectIncoming,
      toggleMute,
      getState: () => ({ ...state }),
      subscribe: subscribeToSignals,
      markEventProcessed: markCallEventProcessed,
      verifyIncomingRelayEvent: verifyIncomingVoiceRelayEvent,
      verifyIncomingRelayRecipient: verifyIncomingVoiceRelayRecipient,
      verifyIncomingRelayFreshness: verifyIncomingVoiceRelayFreshness
    }
  });

  // חלק שיחות קול (chat-voice-call.js) – אתחול אוטומטי
  if (typeof App.notifyPoolReady === 'function') {
    const originalNotify = App.notifyPoolReady;
    App.notifyPoolReady = function(pool) {
      originalNotify(pool);
      subscribeToSignals();
    };
  }

  // חלק Lazy Init (chat-voice-call.js) – דחיית האזנה לסיגנלים עד שהמשתמש פותח צ'אט | HYPER CORE TECH
  // מונע עומס מיותר על מכשירים חלשים ועל הrelays
  function lazyInitVoiceCall(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const force = !!opts.force;
    if (state.lazyInitDone && !force) {
      autoSubscribeSignals();
      return;
    }
    state.lazyInitDone = true;
    if (force || opts.lookbackSec) {
      const lookback = Number(opts.lookbackSec) || 90;
      forceResubscribeSignals('lazy-force', {
        since: Math.floor(Date.now() / 1000) - lookback
      });
      // forceResubscribe → subscribeToSignals; ensure force path if empty
      if (!state.signalSubscription) {
        subscribeToSignals({ force: true, lookbackSec: lookback });
      }
    } else {
      autoSubscribeSignals();
    }
    console.log('Voice call: lazy init completed', opts);
  }
  state.lazyInitDone = false;

  // האזנה לפתיחת צ'אט כדי להתחיל את השירות
  function setupLazyTrigger() {
    const chatButton = document.getElementById('chatToggle') || document.querySelector('[data-chat-toggle]');
    if (chatButton) {
      chatButton.addEventListener('click', lazyInitVoiceCall, { once: true });
    }
    // גם כשמקבלים הודעת צ'אט או שיחה נכנסת
    if (App.pool && App.publicKey && !App.guestMode) {
      // הפעלה אוטומטית אחרי 10 שניות אם המשתמש מחובר (למקרה של שיחות נכנסות)
      setTimeout(lazyInitVoiceCall, 10000);
    }
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupLazyTrigger);
    } else {
      setupLazyTrigger();
    }
  } catch (_) {}

  // חשיפת פונקציה לאתחול ידני מבחוץ | HYPER CORE TECH
  App.initVoiceCall = lazyInitVoiceCall;

  console.log('Voice call module loaded (lazy init)');
  loadEndedCallMap();
})(window);
