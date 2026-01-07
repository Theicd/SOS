// חלק שיחות וידאו (chat-video-call.js) – מודול WebRTC לשיחות וידאו בזמן אמת דרך Nostr
(function initChatVideoCall(window) {
  // שייך: שכבת RTC לוידאו, עצמאי מהקול אך דומה במבנה
  const App = window.NostrApp || (window.NostrApp = {});
  const NostrTools = window.NostrTools;

  // חלק שיחות וידאו – קונפיגורציית ICE (מאפשר TURN חיצוני דרך גלובלי)
  const RTC_CONFIG = { iceServers: Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? window.NostrRTC_ICE
    : [ { urls: 'stun:stun.l.google.com:19302' } ] };
  const CALL_METRIC_KIND = 25060; // חלק שיחות וידאו (chat-video-call.js) – kind יעודי לרישום מדדי שיחה | HYPER CORE TECH

  // חלק שיחות וידאו (chat-video-call.js) – הגדרות יציבות סיגנלים: חלון אחורה קצר + סינון הצעות ישנות | HYPER CORE TECH
  const SIGNAL_LOOKBACK_SEC = 180;
  const MAX_OFFER_AGE_SEC = SIGNAL_LOOKBACK_SEC;

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
    callStartTimestamp: null
  };

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

  // חלק שיחות וידאו (chat-video-call.js) – מפרסם אירוע מדד לריליי עם משך השיחה | HYPER CORE TECH
  async function publishCallMetric(durationSeconds, peerPubkey) {
    if (!App.pool || !App.publicKey || !App.privateKey) {
      return;
    }
    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : 0;
    const payload = {
      mode: 'video',
      durationSeconds: safeDuration,
      endedAt: Math.floor(Date.now() / 1000),
    };
    if (peerPubkey) {
      payload.peer = peerPubkey;
    }

    const tags = [
      ['t', 'video-call'],
      ['metric', 'call'],
      ['duration', String(safeDuration)],
    ];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }

    const event = {
      kind: CALL_METRIC_KIND,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify(payload),
    };

    try {
      const signed = App.finalizeEvent(event, App.privateKey);
      await App.pool.publish(App.relayUrls, signed);
    } catch (error) {
      console.warn('Video call metric publish failed', error);
    }
  }

  // חלק שיחות וידאו – בדיקת תמיכה
  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  // חלק שיחות וידאו – קבלת סטרים מקומי (אודיו+וידאו)
  async function getLocalStream(videoConstraints) {
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
      console.log('VIDEO ICE:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        state.isActive = true;
        state.callStartTimestamp = Date.now();
        if (typeof App.onVideoCallConnected === 'function') App.onVideoCallConnected(peerPubkey);
      } else if (['disconnected','failed','closed'].includes(pc.iceConnectionState)) {
        if (!state.ending) end();
      }
    };

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      console.log('VIDEO PC:', cs);
      if (['disconnected','failed','closed'].includes(cs)) {
        if (!state.ending) end();
      }
    };

    state.pc = pc;
    return pc;
  }

  // חלק שיחות וידאו – חישוב מזהה חדר
  function getRoomId(peer) {
    const a = (App.publicKey || '').toLowerCase();
    const b = (peer || '').toLowerCase();
    if (!a || !b) return '';
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  // חלק שיחות וידאו – תור למועמדי ICE
  async function sendSignal(peer, type, data) {
    if (!App.pool || !App.publicKey || !App.privateKey) return;
    const payload = data ? JSON.stringify(data) : '';
    const content = payload ? await NostrTools.nip04.encrypt(App.privateKey, peer, payload) : '';
    const event = {
      kind: 25050,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now()/1000),
      tags: [ ['type', type], ['p', peer], ['r', getRoomId(peer)] ],
      content
    };
    const signed = App.finalizeEvent(event, App.privateKey);
    await new Promise(r => setTimeout(r, 80));
    await App.pool.publish(App.relayUrls, signed);
    console.log(`Sent ${type} (video) to ${peer.slice(0,8)}`);
  }

  function queueCandidate(peer, cand) {
    if (cand) state.candidateQueue.push(cand);
    if (!cand) {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) sendSignal(peer, 'v-candidates', batch);
      clearTimer();
      return;
    }
    clearTimer();
    state.candidateTimer = setTimeout(() => {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) sendSignal(peer, 'v-candidates', batch);
      clearTimer();
    }, 1000);
  }
  function clearTimer(){ if (state.candidateTimer){ clearTimeout(state.candidateTimer); state.candidateTimer=null; } }

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
  function bufferRemoteCandidates(peerPubkey, candidates) {
    if (!peerPubkey || !Array.isArray(candidates) || candidates.length === 0) return;
    const list = state.pendingRemoteCandidates[peerPubkey] || (state.pendingRemoteCandidates[peerPubkey] = []);
    for (const c of candidates) {
      if (c) list.push(c);
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
    for (const c of batch) {
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
    if (typeof App.onVideoCallStarted === 'function') App.onVideoCallStarted(peerPubkey, false);
  }

  // חלק שיחות וידאו – קבלת שיחה
  async function accept(peerPubkey, offer) {
    if (!isSupported()) throw new Error('הדפדפן לא תומך בוידאו');
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
    createPC(peerPubkey);
    if (!offer || !offer.type || !offer.sdp) throw new Error('offer וידאו אינו תקין');
    await state.pc.setRemoteDescription(offer);
    await flushRemoteCandidates(peerPubkey);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await flushRemoteCandidates(peerPubkey);
    await sendSignal(peerPubkey, 'v-answer', answer);
    if (typeof App.onVideoCallStarted === 'function') App.onVideoCallStarted(peerPubkey, true);
  }

  // חלק שיחות וידאו – סיום
  async function end() {
    if (state.ending) return;
    state.ending = true;
    const peer = state.currentPeer;
    const startMs = state.callStartTimestamp;
    const durationSeconds = startMs ? (Date.now() - startMs) / 1000 : 0;
    const wasIncoming = state.isIncoming;
    const wasAnswered = !!startMs;
    if (peer) sendSignal(peer, 'v-disconnect', null);
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
    if (durationSeconds > 0) {
      publishCallMetric(durationSeconds, peer);
    }
    setTimeout(()=>{ state.ending=false; },100);
    state.callStartTimestamp = null;
    // חלק שיחות וידאו (chat-video-call.js) – התראה על שיחה נכנסת שלא נענתה (missed) | HYPER CORE TECH
    if (wasIncoming && !wasAnswered && peer) {
      // חלק Push (chat-video-call.js) – שליחת Push על שיחת וידאו שהוחמצה | HYPER CORE TECH
      if (typeof App.triggerMissedCallPush === 'function') {
        App.triggerMissedCallPush(peer, 'video');
      }
      if (typeof App.onVideoCallMissed === 'function') {
        App.onVideoCallMissed(peer);
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

  // חלק שיחות וידאו – טיפול באירועי אותות נכנסים
  async function handleSignalEvent(event) {
    if (event.pubkey === App.publicKey) return;
    const typeTag = event.tags.find(t => t[0] === 'type');
    if (!typeTag) return;
    const type = typeTag[1];
    if (!type || type[0] !== 'v') return; // מתייחס רק לשיחות וידאו

    if (event && event.id && rememberProcessedSignalId(event.id)) return;

    // חלק שיחות וידאו (chat-video-call.js) – מעקב אחר חיות subscription (לשימוש keepalive/re-subscribe) | HYPER CORE TECH
    state.lastSignalReceivedAt = Date.now();
    try {
      const createdAt = Number(event.created_at) || 0;
      if (createdAt > state.lastSignalCreatedAt) state.lastSignalCreatedAt = createdAt;
    } catch {}

    const peer = event.pubkey;
    let data = null;
    if (event.content) {
      try {
        const dec = await NostrTools.nip04.decrypt(App.privateKey, peer, event.content);
        data = dec ? JSON.parse(dec) : null;
      } catch (err) {
        console.warn('Failed to decrypt/parse video signal', err);
        return;
      }
    }

    console.log(`Received ${type} from ${peer.slice(0,8)}`);
    switch (type) {
      case 'v-offer': {
        // חלק שיחות וידאו (chat-video-call.js) – הגנה מפני offer ישן אחרי re-subscribe | HYPER CORE TECH
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const createdAt = Number(event.created_at) || 0;
          if (createdAt && (nowSec - createdAt) > MAX_OFFER_AGE_SEC) {
            console.log('Ignored old video offer from', peer.slice(0,8));
            return;
          }
        } catch {}

        let offerData = data;
        if (typeof offerData === 'string') {
          try { offerData = JSON.parse(offerData); } catch {}
        }
        if (offerData && offerData.offer && !offerData.type && !offerData.sdp) {
          offerData = offerData.offer;
        }
        if (!offerData || !offerData.type || !offerData.sdp) {
          console.error('Invalid video offer received', offerData);
          return;
        }

        // דה-דופליקציה
        const now = Date.now();
        const last = state.lastOfferFrom[peer] || 0;
        state.lastOfferFrom[peer] = now;
        if (now - last < 1500) {
          console.log('Ignored duplicate video offer from', peer.slice(0,8));
          return;
        }

        console.log('Received valid video offer:', { type: offerData.type, sdpLen: offerData.sdp?.length });
        // חלק שיחות וידאו (chat-video-call.js) – קיבוע peer עבור שיחה נכנסת כדי שאירוע v-disconnect/ביטול יסגור UI גם לפני קבלה | HYPER CORE TECH
        if (state.currentPeer && state.currentPeer !== peer) {
          console.log('Ignored incoming video offer while another call context exists');
          return;
        }
        state.currentPeer = peer;
        state.isIncoming = true;
        // חלק Push (chat-video-call.js) – שליחת התראת Push על שיחת וידאו נכנסת | HYPER CORE TECH
        if (typeof App.triggerIncomingCallPush === 'function') {
          App.triggerIncomingCallPush(peer, 'video');
        }
        if (typeof App.onVideoCallIncoming === 'function') App.onVideoCallIncoming(peer, offerData);
        break;
      }
      case 'v-answer': {
        if (!state.pc || state.currentPeer !== peer) break;
        let answerData = data;
        if (typeof answerData === 'string') {
          try { answerData = JSON.parse(answerData); } catch {}
        }
        if (answerData && answerData.answer && !answerData.type && !answerData.sdp) {
          answerData = answerData.answer;
        }
        if (answerData && answerData.type && answerData.sdp) {
          await state.pc.setRemoteDescription(answerData);
          await flushRemoteCandidates(peer);
        } else {
          console.error('Invalid video answer received', answerData);
        }
        break;
      }
      case 'v-candidates': {
        let candidatesData = data;
        if (typeof candidatesData === 'string') {
          try { candidatesData = JSON.parse(candidatesData); } catch {}
        }
        if (Array.isArray(candidatesData)) {
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
            bufferRemoteCandidates(peer, candidatesData);
          }
        } else if (candidatesData) {
          console.error('Invalid video candidates received', candidatesData);
        }
        break;
      }
      case 'v-disconnect': {
        if (state.currentPeer === peer) end();
        break;
      }
    }
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
    if (now - (state.signalLastResubscribeAt || 0) < 5000) return;
    state.signalLastResubscribeAt = now;

    const opts = options && typeof options === 'object' ? options : null;
    const requestedSince = opts && Number.isFinite(Number(opts.since)) ? Number(opts.since) : null;
    const since = requestedSince !== null ? Math.max(0, Math.floor(requestedSince)) : computeResubscribeSince();
    console.log('Video call: re-subscribing signals', reason || '', { since });

    closeSubscriptionSafely(state.signalSubscription);
    state.signalSubscription = null;
    state.lastSignalReceivedAt = now;
    subscribeToSignals({ since });
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
    try { window.addEventListener('focus', () => forceResubscribeSignals('focus')); } catch {}
    try { window.addEventListener('pageshow', () => forceResubscribeSignals('pageshow')); } catch {}

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
    if (state.signalSubscription) return state.signalSubscription;
    if (!App.pool || !App.publicKey) {
      console.log('Video call: waiting for pool/publicKey...');
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const requestedSince = Number(options.since);
    const since = Number.isFinite(requestedSince) ? Math.max(0, Math.floor(requestedSince)) : (nowSec - 2);
    const filters = [{ kinds: [25050], '#p': [App.publicKey], since }];
    console.log('Video call: subscribing to events for', App.publicKey.slice(0, 8), 'since', since);
    try {
      const sub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: handleSignalEvent,
        oneose: () => {
          state.lastSignalReceivedAt = Date.now();
          console.log('Video call subscription ready');
        }
      });
      state.signalSubscription = sub;
      state.lastSignalReceivedAt = Date.now();
      return sub;
    } catch (err) {
      console.warn('Video call subscribe failed', err);
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

  // חלק שיחות וידאו – חשיפה ל-App
  App.videoCall = {
    isSupported,
    start,
    accept,
    end,
    toggleMute,
    toggleCamera,
    switchCamera,
    subscribe: subscribeToSignals,
    getState: () => ({
      currentPeer: state.currentPeer,
      isActive: state.isActive,
      isIncoming: state.isIncoming,
      isMuted: state.isMuted,
      isCameraOff: state.isCameraOff,
      localStream: state.localStream,
      remoteStream: state.remoteStream
    })
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

  // חלק שיחות וידאו (chat-video-call.js) – ניסיון הרשמה ראשון + retry
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(autoSubscribeSignals, 100));
    } else {
      setTimeout(autoSubscribeSignals, 100);
    }
  } catch (_) {}
})(window);
