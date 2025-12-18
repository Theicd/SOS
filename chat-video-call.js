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
    candidateQueue: [],
    candidateTimer: null,
    ending: false,
    lastOfferFrom: {},
    callStartTimestamp: null
  };

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
      video: Object.assign({ facingMode: state.facingMode, width: { ideal: 720 }, height: { ideal: 1280 } }, videoConstraints || {})
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
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

  // חלק שיחות וידאו – התחלת שיחה יוצאת
  async function start(peerPubkey, opts) {
    if (!isSupported()) throw new Error('הדפדפן לא תומך בוידאו');
    await getLocalStream(opts && opts.video);
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
    state.currentPeer = peerPubkey;
    createPC(peerPubkey);
    if (!offer || !offer.type || !offer.sdp) throw new Error('offer וידאו אינו תקין');
    await state.pc.setRemoteDescription(offer);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await sendSignal(peerPubkey, 'v-answer', answer);
    if (typeof App.onVideoCallStarted === 'function') App.onVideoCallStarted(peerPubkey, true);
  }

  // חלק שיחות וידאו – סיום
  async function end() {
    if (state.ending) return;
    state.ending = true;
    const peer = state.currentPeer;
    const durationSeconds = state.callStartTimestamp ? (Date.now() - state.callStartTimestamp) / 1000 : 0;
    
    // חלק שיחות וידאו (chat-video-call.js) – זיהוי שיחה נכנסת שלא נענתה (לפני איפוס state) | HYPER CORE TECH
    const wasIncoming = state.isIncoming;
    const wasAnswered = !!state.callStartTimestamp;
    
    if (peer) sendSignal(peer, 'v-disconnect', null);
    try { if (state.pc) state.pc.close(); } catch {}
    state.pc = null;
    try { if (state.localStream) state.localStream.getTracks().forEach(t=>t.stop()); } catch {}
    try { if (state.remoteStream) state.remoteStream.getTracks().forEach(t=>t.stop()); } catch {}
    state.localStream = null; state.remoteStream = null;
    state.currentPeer = null; state.isIncoming = false; state.isActive = false; state.isMuted = false; state.isCameraOff = false;
    if (durationSeconds > 0) {
      publishCallMetric(durationSeconds, peer);
    }
    setTimeout(()=>{ state.ending=false; },100);
    state.callStartTimestamp = null;
    
    // חלק שיחות וידאו (chat-video-call.js) – התראה על שיחה שלא נענתה (נכנסת + לא נענתה) | HYPER CORE TECH
    if (wasIncoming && !wasAnswered && peer) {
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
  // חלק שיחות וידאו (chat-video-call.js) – החלפת מצלמה קדמית/אחורית עם תמיכה במובייל | HYPER CORE TECH
  async function switchCamera() {
    if (!state.pc || !state.localStream) return;
    
    // החלפת facingMode
    const newFacingMode = state.facingMode === 'user' ? 'environment' : 'user';
    
    try {
      // ניסיון עם exact facingMode (מבטיח החלפה אמיתית)
      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: newFacingMode } },
          audio: false // לא צריך אודיו חדש
        });
      } catch (exactErr) {
        // fallback ללא exact (חלק מהמכשירים לא תומכים)
        console.warn('exact facingMode failed, trying ideal:', exactErr);
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: newFacingMode } },
          audio: false
        });
      }
      
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        console.warn('No video track from new stream');
        return;
      }
      
      // החלפת ה-track ב-sender
      const sender = state.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
      
      // עצירת ה-track הישן והחלפה ב-localStream
      const oldVideoTrack = state.localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        state.localStream.removeTrack(oldVideoTrack);
      }
      state.localStream.addTrack(newVideoTrack);
      
      // עדכון state רק אחרי הצלחה
      state.facingMode = newFacingMode;
      
      if (typeof App.onVideoCallLocalStreamChanged === 'function') {
        App.onVideoCallLocalStreamChanged(state.localStream);
      }
      
      console.log('Camera switched to:', newFacingMode);
    } catch (err) {
      console.error('Failed to switch camera:', err);
      // לא משנים את state.facingMode אם נכשל
    }
  }

  // חלק שיחות וידאו – טיפול באירועי אותות נכנסים
  async function handleSignalEvent(event) {
    if (event.pubkey === App.publicKey) return;
    const typeTag = event.tags.find(t => t[0] === 'type');
    if (!typeTag) return;
    const type = typeTag[1];
    if (!type || type[0] !== 'v') return; // מתייחס רק לשיחות וידאו
    const peer = event.pubkey;
    let data = null;
    if (event.content) {
      const dec = await NostrTools.nip04.decrypt(App.privateKey, peer, event.content);
      data = dec ? JSON.parse(dec) : null;
    }

    console.log(`Received ${type} from ${peer.slice(0,8)}`);    
    switch (type) {
      case 'v-offer': {
        // שיחה נכנסת בוידאו
        if (!data || !data.type || !data.sdp) {
          console.error('Invalid video offer received', data);
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
        console.log('Received valid video offer:', { type: data.type, sdpLen: data.sdp?.length });
        // חלק שיחות וידאו (chat-video-call.js) – קיבוע peer עבור שיחה נכנסת כדי שאירוע v-disconnect/ביטול יסגור UI גם לפני קבלה | HYPER CORE TECH
        if (state.currentPeer && state.currentPeer !== peer) {
          console.log('Ignored incoming video offer while another call context exists');
          return;
        }
        state.currentPeer = peer;
        state.isIncoming = true;
        if (typeof App.onVideoCallIncoming === 'function') App.onVideoCallIncoming(peer, data);
        break;
      }
      case 'v-answer': {
        if (state.pc && state.currentPeer === peer && data && data.type && data.sdp) {
          await state.pc.setRemoteDescription(data);
        }
        break;
      }
      case 'v-candidates': {
        if (state.pc && state.currentPeer === peer && Array.isArray(data)) {
          for (const c of data) { if (c) await state.pc.addIceCandidate(new RTCIceCandidate(c)); }
        }
        break;
      }
      case 'v-disconnect': {
        if (state.currentPeer === peer) end();
        break;
      }
    }
  }

  // חלק שיחות וידאו (chat-video-call.js) – הרשמה לאירועים עם since מורחב לתפוס שיחות שנכנסו בזמן טעינה | HYPER CORE TECH
  let videoCallSubscription = null;
  let subscribeStartTime = Date.now(); // זמן התחלת ניסיון ההרשמה
  
  function subscribe() {
    // אורחים לא יכולים להשתמש בשיחות וידאו - לא לחכות לנצח
    if (App.guestMode) {
      console.log('Video call: disabled for guest users');
      return;
    }
    // מניעת הרשמה כפולה
    if (videoCallSubscription) {
      return;
    }
    if (!App.pool || !App.publicKey) {
      console.log('Video call: waiting for pool/publicKey...');
      setTimeout(subscribe, 300); // מהיר יותר - 300ms במקום 500ms
      return;
    }
    // since מורחב: מתחילת ניסיון ההרשמה או 30 שניות אחורה (הגדול מביניהם)
    const timeSinceStart = Math.floor((Date.now() - subscribeStartTime) / 1000);
    const since = Math.floor(Date.now()/1000) - Math.max(timeSinceStart + 5, 30);
    const filters = [{ kinds: [25050], '#p': [App.publicKey], since }];
    console.log('Video call: subscribing to events for', App.publicKey.slice(0,8), 'since', since);
    try {
      videoCallSubscription = App.pool.subscribeMany(App.relayUrls, filters, { 
        onevent: handleSignalEvent, 
        oneose: () => console.log('Video call subscription ready') 
      });
    } catch (err) {
      console.warn('Video call subscribe failed', err);
      videoCallSubscription = null;
    }
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', subscribe);
  } else {
    setTimeout(subscribe, 100);
  }
})(window);
