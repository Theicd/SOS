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
  const CALL_METRIC_KIND = 25060; // חלק שיחות קול (chat-voice-call.js) – kind למדדי שיחות כלליות | HYPER CORE TECH

  /** SDP מהסיגנלינג / JSON — תמיד מחזיר {type,sdp} או null */
  function normalizeSessionDescription(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let o = raw;
    if (o.offer && typeof o.offer === 'object' && !o.type && !o.sdp) o = o.offer;
    const type = o.type;
    const sdp = typeof o.sdp === 'string' ? o.sdp : '';
    if (!type || !sdp) return null;
    return { type, sdp };
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
    lastOfferFrom: {},
    waitingOffer: null,
    lastSignalReceivedAt: 0,
    signalLastResubscribeAt: 0,
    signalKeepaliveTimer: null,
    ending: false,
    callStartTimestamp: null,
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

  async function publishCallMetric(durationSeconds, peerPubkey) {
    if (!App.pool || !App.publicKey || !App.privateKey) {
      return;
    }
    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : 0;
    const payload = {
      mode: 'voice',
      durationSeconds: safeDuration,
      endedAt: Math.floor(Date.now() / 1000),
    };
    if (peerPubkey) {
      payload.peer = peerPubkey;
    }

    const tags = [
      ['t', 'voice-call'],
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
      console.warn('Voice call metric publish failed', error);
    }
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

  // חלק שיחות קול (chat-voice-call.js) – חישוב מזהה חדר לפי זוג המפתחות
  function getRoomId(peerPubkey) {
    const a = (App.publicKey || '').toLowerCase();
    const b = (peerPubkey || '').toLowerCase();
    if (!a || !b) return '';
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  // חלק שיחות קול (chat-voice-call.js) – שליחת אירוע סינכרון דרך Nostr
  async function sendSignal(peerPubkey, type, data) {
    if (!App.pool || !App.publicKey || !App.privateKey) {
      console.error('Nostr pool or keys not available');
      return;
    }

    try {
      // הצפנת התוכן עם NIP-04
      const content = data ? JSON.stringify(data) : '';
      const encryptedContent = content
        ? await window.NostrTools.nip04.encrypt(App.privateKey, peerPubkey, content)
        : '';

      const event = {
        kind: 25050, // WebRTC signaling event
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['type', type],
          ['p', peerPubkey],
          ['r', getRoomId(peerPubkey)]
        ],
        content: encryptedContent
      };

      const signedEvent = App.finalizeEvent(event, App.privateKey);
      await App.pool.publish(App.relayUrls, signedEvent);

      console.log(`Sent ${type} signal to ${peerPubkey.slice(0, 8)}`);
    } catch (err) {
      console.error('Failed to send signal', err);
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
      console.log('ICE connection state:', pc.iceConnectionState);
      
      if (pc.iceConnectionState === 'connected') {
        state.isCallActive = true;
        // חלק שיחות קול (chat-voice-call.js) – מסנכרן זמן התחלת שיחה עבור UI (callStartTime) וגם עבור מדדים (callStartTimestamp) | HYPER CORE TECH
        state.callStartTimestamp = Date.now();
        state.callStartTime = state.callStartTimestamp;
        if (typeof App.onVoiceCallConnected === 'function') {
          App.onVoiceCallConnected(peerPubkey);
        }
      } else if (
        pc.iceConnectionState === 'disconnected' ||
        pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'closed'
      ) {
        console.log('ICE state ended, closing call');
        if (!state.ending) endCall();
      }
    };

    // חלק שיחות קול (chat-voice-call.js) – ניטור מצב כלל החיבור
    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      console.log('Peer connection state:', cs);
      if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
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
      // חלק שיחות קול (chat-voice-call.js) – איפוס זמן התחלה עד לחיבור בפועל (connected)
      state.callStartTimestamp = null;
      state.callStartTime = null;

      // יצירת offer
      const offer = await state.peerConnection.createOffer();
      if (!offer || !offer.type || !offer.sdp) {
        throw new Error('Offer לא תקין מהדפדפן');
      }
      await state.peerConnection.setLocalDescription(offer);

      // שליחת offer
      await sendSignal(peerPubkey, 'offer', offer);

      console.log('Call started to', peerPubkey.slice(0, 8));

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
        console.log('Accept skipped – already in call with', String(peerPubkey || '').slice(0, 8), cs);
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
      state.isIncoming = true;

      // קבלת offer (אימות + נרמול {type,sdp} אחרי סריאליזציה מ-Nostr/QA)
      const offerNorm = normalizeSessionDescription(offer);
      if (!offerNorm) {
        console.error('Invalid offer received', offer);
        throw new Error('ה-offer שהתקבל אינו תקין');
      }
      console.log('Applying remote offer', { type: offerNorm.type, sdpLen: offerNorm.sdp?.length });
      await state.peerConnection.setRemoteDescription(offerNorm);

      // יצירת answer
      const answer = await state.peerConnection.createAnswer();
      await state.peerConnection.setLocalDescription(answer);

      // שליחת answer
      await sendSignal(peerPubkey, 'answer', answer);
      answerSent = true;

      console.log('Call accepted from', peerPubkey.slice(0, 8));

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
    console.log('Ending call');

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
    const wasAnswered = !!startMs;
    const peer = state.currentPeer;

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

    // איפוס מצב
    state.currentPeer = null;
    state.isCallActive = false;
    state.isIncoming = false;
    state.isMuted = false;
    state.callStartTimestamp = null;
    state.callStartTime = null;
    // חלק שיחות קול (chat-voice-call.js) – שחזור AudioSession לסוג שהיה לפני השיחה | HYPER CORE TECH
    restoreAudioSessionType();
    setTimeout(() => { state.ending = false; }, 100);

    if (durationSeconds > 0 && peer) {
      publishCallMetric(durationSeconds, peer);
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
  async function handleSignalEvent(event) {
    if (event.pubkey === App.publicKey) return;
    
    // חלק דה-דופליקציה (chat-voice-call.js) – דילוג על אירועים שכבר עובדו (מונע שיחות כפולות אחרי רענון) | HYPER CORE TECH
    if (event.id && isCallEventProcessed(event.id)) {
      // מאפשרים offer שוב אם יש מענה ממתין מ-APK (אחרת השיחה נתקעת בלי SDP) | HYPER CORE TECH
      try {
        const pending = window.__sosNativePendingAnswer;
        const pendingDecline = window.__sosNativePendingDecline;
        const peer = String(event.pubkey || '').toLowerCase();
        const allowReplay = (pending && pending.peer === peer && Date.now() < (pending.until || 0))
          || (pendingDecline && pendingDecline.peer === peer && Date.now() < (pendingDecline.until || 0));
        if (!allowReplay) {
          console.log('Skipping already processed call event:', event.id.slice(0, 8));
          return;
        }
      } catch (_) {
        console.log('Skipping already processed call event:', event.id.slice(0, 8));
        return;
      }
    }

    const typeTag = event.tags.find(t => t[0] === 'type');
    if (!typeTag) return;

    const type = typeTag[1];
    // אותות שידור חי (live-*) לא שייכים לשיחות קול | HYPER CORE TECH
    if (String(type || '').startsWith('live-')) return;
    const peerPubkey = event.pubkey;

    try {
      let data = null;
      if (event.content) {
        const decrypted = await window.NostrTools.nip04.decrypt(
          App.privateKey,
          peerPubkey,
          event.content
        );
        data = decrypted ? JSON.parse(decrypted) : null;
      }

      console.log(`Received ${type} from ${peerPubkey.slice(0, 8)}`);

      switch (type) {
        case 'offer':
          // שיחה נכנסת – ולידציה והמרה במקרה הצורך
          try {
            if (isOfferEventTooOld(event)) {
              console.log('Ignored stale offer from', peerPubkey.slice(0, 8), 'age>', MAX_OFFER_AGE_SEC, 's');
              if (event.id) markCallEventProcessed(event.id);
              return;
            }
            let offerData = data;
            if (typeof offerData === 'string') {
              offerData = JSON.parse(offerData);
            }
            // יש מימושים שמחזירים { offer: {type,sdp} }
            if (offerData && offerData.offer && !offerData.type && !offerData.sdp) {
              offerData = offerData.offer;
            }
            if (!offerData || !offerData.type || !offerData.sdp) {
              console.error('Invalid offer payload received', offerData);
              return;
            }
            // דה-דופליקציה: מתעלם מהצעות כפולות מאותו peer בחלון קצר
            const now = Date.now();
            const last = state.lastOfferFrom[peerPubkey] || 0;
            state.lastOfferFrom[peerPubkey] = now;
            if (now - last < 1500) {
              console.log('Ignored duplicate offer from', peerPubkey.slice(0,8));
              return;
            }
            // כבר בשיחה פעילה עם אותו peer – לא לפתוח דיאלוג שני | HYPER CORE TECH
            if (state.isCallActive && state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase()) {
              console.log('Ignored offer – already in active call with', peerPubkey.slice(0, 8));
              if (event.id) markCallEventProcessed(event.id);
              return;
            }
            // חיבור בתהליך (לפני isCallActive) או accept בתהליך – לא לצלצל שוב | HYPER CORE TECH
            try {
              const samePeer = state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase();
              const pc = state.peerConnection;
              const cs = pc && String(pc.connectionState || pc.iceConnectionState || '');
              const acceptBusy = !!(window.__sosAcceptInFlight && String(window.__sosAcceptInFlightPeer || '').toLowerCase() === String(peerPubkey).toLowerCase());
              if (samePeer && (acceptBusy || cs === 'connected' || cs === 'connecting' || cs === 'checking' || cs === 'completed')) {
                console.log('Ignored offer – call connecting/connected with', peerPubkey.slice(0, 8), cs || 'accept');
                if (event.id) markCallEventProcessed(event.id);
                return;
              }
            } catch (_) {}
            // חלק דה-דופליקציה (chat-voice-call.js) – סימון האירוע כמעובד כדי שלא יופיע שוב אחרי רענון | HYPER CORE TECH
            if (event.id) markCallEventProcessed(event.id);
            console.log('Received valid offer:', offerData);
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
              console.log('Ignored incoming offer while another call context exists');
              return;
            }
            // אותו peer כבר ב־context (מסך ענה פתוח) – לא לפתוח שוב | HYPER CORE TECH
            if (state.currentPeer && String(state.currentPeer).toLowerCase() === String(peerPubkey).toLowerCase() && state.isIncoming) {
              console.log('Ignored offer – already handling incoming from', peerPubkey.slice(0, 8));
              return;
            }
            state.currentPeer = peerPubkey;
            state.isIncoming = true;
            // חלק Push (chat-voice-call.js) – שליחת התראת Push על שיחה נכנסת | HYPER CORE TECH
            if (typeof App.triggerIncomingCallPush === 'function') {
              App.triggerIncomingCallPush(peerPubkey, 'voice');
            }
            if (typeof App.onVoiceCallIncoming === 'function') {
              App.onVoiceCallIncoming(peerPubkey, offerData);
            }
          } catch (e) {
            console.error('Failed to parse offer payload', e, data);
          }
          break;

        case 'connect':
          // הודעת נוכחות/התחברות – לא מפעילים UI ולא משנים incomingOffer
          console.log('Peer connected presence from', peerPubkey.slice(0,8));
          break;

        case 'answer':
          // תשובה לשיחה יוצאת
          if (state.peerConnection && state.currentPeer === peerPubkey) {
            if (!data || !data.type || !data.sdp) {
              console.error('Invalid answer received', data);
              return;
            }
            console.log('Applying remote answer', { type: data.type, sdpLen: data.sdp?.length });
            await state.peerConnection.setRemoteDescription(data);
            // עוצרים חיוג מיד כשמגיע answer – לא מחכים ל-ICE | HYPER CORE TECH
            if (typeof App.onVoiceCallAnswerReceived === 'function') {
              App.onVoiceCallAnswerReceived(peerPubkey);
            }
          }
          break;

        case 'candidate':
          // ICE candidate בודד (תאימות לאחור)
          if (state.peerConnection && state.currentPeer === peerPubkey && data) {
            await state.peerConnection.addIceCandidate(new RTCIceCandidate(data));
          }
          break;

        case 'candidates':
          // ICE candidates מרובים (batch)
          if (state.peerConnection && state.currentPeer === peerPubkey && Array.isArray(data)) {
            for (const candidate of data) {
              if (candidate) {
                await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              }
            }
          }
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
      console.error('Failed to handle signal event', err);
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – זמן התחלת ניסיון הרשמה לתפוס שיחות שנכנסו בזמן טעינה | HYPER CORE TECH
  let voiceSubscribeStartTime = Date.now();
  
  // חלק דה-דופליקציה (chat-voice-call.js) – מניעת עיבוד כפול של אירועי שיחה אחרי רענון | HYPER CORE TECH
  const PROCESSED_CALLS_KEY = 'sos_processed_call_events_v2';
  const MAX_PROCESSED_IDS = 100;
  const PROCESSED_TTL_MS = 10 * 60 * 1000;
  const MAX_OFFER_AGE_SEC = 60;

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
        kinds: [25050],
        '#p': [App.publicKey],
        since
      }
    ];

    try {
      console.log('Voice call: subscribing to events for', App.publicKey.slice(0,8), 'since', since);
      const sub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (ev) => {
          state.lastSignalReceivedAt = Date.now();
          handleSignalEvent(ev);
        },
        oneose: () => {
          state.lastSignalReceivedAt = Date.now();
          console.log('Voice call subscription ready');
        }
      });
      state.signalSubscription = sub;
      state.lastSignalReceivedAt = Date.now();
      return sub;
    } catch (err) {
      console.warn('Voice call subscribe failed', err);
      return null;
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – רענון subscription לאחר idle/חזרה מפוקוס | HYPER CORE TECH
  function forceResubscribeSignals(reason, options) {
    if (App.guestMode) return;
    if (!App.pool || !App.publicKey) return;
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}

  const now = Date.now();
  if (now - (state.signalLastResubscribeAt || 0) < 5000 && !(options && options.force)) return;
  state.signalLastResubscribeAt = now;

  const opts = options && typeof options === 'object' ? options : null;
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
      subscribe: subscribeToSignals
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
})(window);
