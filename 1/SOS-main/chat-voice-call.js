// חלק שיחות קול (chat-voice-call.js) – מודול WebRTC לשיחות קוליות בזמן אמת דרך Nostr
// מבוסס על nrtc אבל משולב עם התשתית הקיימת של SOS2
(function initChatVoiceCall(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק שיחות קול (chat-voice-call.js) – הגדרות WebRTC עם STUN server של Google
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  const CALL_METRIC_KIND = 25060; // חלק שיחות קול (chat-voice-call.js) – kind למדדי שיחות כלליות | HYPER CORE TECH

  // חלק שיחות קול (chat-voice-call.js) – מצב השיחה הנוכחי
  const state = {
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    currentPeer: null,
    isCallActive: false,
    isIncoming: false,
    isMuted: false,
    callStartTime: null,
    candidateQueue: [],
    candidateTimer: null,
    lastOfferFrom: {},
    ending: false,
    callStartTimestamp: null
  };

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

  // חלק שיחות קול (chat-voice-call.js) – קבלת הרשאות מיקרופון
  async function getLocalStream() {
    if (state.localStream) {
      return state.localStream;
    }

    try {
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
      
      // שליחה עם delay קטן כדי למנוע rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
      await App.pool.publish(App.relayUrls, signedEvent);

      console.log(`Sent ${type} signal to ${peerPubkey.slice(0, 8)}`);
    } catch (err) {
      console.error('Failed to send signal', err);
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – שליחת ICE candidates בצבירה
  function queueCandidate(peerPubkey, candidate) {
    if (candidate) {
      state.candidateQueue.push(candidate);
    }

    // אם זה ה-null candidate – זה אות שהאיסוף הסתיים; שלח את כל מה שנצבר
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

    // fallback: אם משום מה לא הגיע null – שלח אחרי 1200ms
    if (state.candidateTimer) {
      clearTimeout(state.candidateTimer);
    }
    state.candidateTimer = setTimeout(() => {
      const batch = state.candidateQueue.splice(0);
      if (batch.length) {
        sendSignal(peerPubkey, 'candidates', batch);
      }
      state.candidateTimer = null;
    }, 1200);
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
        state.callStartTimestamp = Date.now();
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
      // קבלת הרשאות מיקרופון
      await getLocalStream();

      // יצירת חיבור
      state.currentPeer = peerPubkey;
      state.peerConnection = createPeerConnection(peerPubkey);
      state.callStartTimestamp = null;

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

    try {
      // קבלת הרשאות מיקרופון
      await getLocalStream();

      // יצירת חיבור
      state.currentPeer = peerPubkey;
      state.peerConnection = createPeerConnection(peerPubkey);

      // קבלת offer (אימות ושימוש ישיר באובייקט)
      if (!offer || !offer.type || !offer.sdp) {
        console.error('Invalid offer received', offer);
        throw new Error('ה-offer שהתקבל אינו תקין');
      }
      console.log('Applying remote offer', { type: offer.type, sdpLen: offer.sdp?.length });
      await state.peerConnection.setRemoteDescription(offer);

      // יצירת answer
      const answer = await state.peerConnection.createAnswer();
      await state.peerConnection.setLocalDescription(answer);

      // שליחת answer
      await sendSignal(peerPubkey, 'answer', answer);

      console.log('Call accepted from', peerPubkey.slice(0, 8));

      // עדכון UI
      if (typeof App.onVoiceCallStarted === 'function') {
        App.onVoiceCallStarted(peerPubkey, true);
      }
    } catch (err) {
      console.error('Failed to accept call', err);
      endCall();
      throw err;
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – סיום שיחה
  async function endCall() {
    if (state.ending) return;
    state.ending = true;
    console.log('Ending call');

    // שליחת אירוע disconnect
    if (state.currentPeer) {
      sendSignal(state.currentPeer, 'disconnect', null);
    }

    const durationSeconds = state.callStartTimestamp ? (Date.now() - state.callStartTimestamp) / 1000 : 0;

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
    const peer = state.currentPeer;
    state.currentPeer = null;
    state.isCallActive = false;
    state.isIncoming = false;
    state.isMuted = false;
    state.callStartTimestamp = null;
    setTimeout(() => { state.ending = false; }, 100);

    if (durationSeconds > 0 && peer) {
      publishCallMetric(durationSeconds, peer);
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

    const typeTag = event.tags.find(t => t[0] === 'type');
    if (!typeTag) return;

    const type = typeTag[1];
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
            console.log('Received valid offer:', offerData);
            state.isIncoming = true;
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
          if (state.currentPeer === peerPubkey) {
            endCall();
          }
          break;
      }
    } catch (err) {
      console.error('Failed to handle signal event', err);
    }
  }

  // חלק שיחות קול (chat-voice-call.js) – הרשמה לאירועי סינכרון
  function subscribeToSignals() {
    if (!App.pool || !App.publicKey) {
      console.warn('Cannot subscribe to voice call signals - pool or keys missing');
      return;
    }

    const since = Math.floor(Date.now() / 1000) - 2; // מתעלם מאירועי עבר
    const filters = [
      {
        kinds: [25050],
        '#p': [App.publicKey],
        since
      }
    ];

    const sub = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: handleSignalEvent,
      oneose: () => {
        console.log('Voice call subscription ready');
      }
    });

    return sub;
  }

  // חלק שיחות קול (chat-voice-call.js) – חשיפת API
  Object.assign(App, {
    voiceCall: {
      isSupported: isWebRTCSupported,
      start: startCall,
      accept: acceptCall,
      end: endCall,
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

  console.log('Voice call module initialized');
})(window);
