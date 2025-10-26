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

  // חלק שיחות קול (chat-voice-call.js) – מצב השיחה הנוכחי
  const state = {
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    currentPeer: null,
    isCallActive: false,
    isIncoming: false,
    isMuted: false,
    callStartTime: null
  };

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
          ['p', peerPubkey]
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
      });
      
      // עדכון UI
      if (typeof App.onVoiceCallRemoteStream === 'function') {
        App.onVoiceCallRemoteStream(state.remoteStream);
      }
    };

    // חלק שיחות קול (chat-voice-call.js) – שליחת ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerPubkey, 'candidate', event.candidate);
      }
    };

    // חלק שיחות קול (chat-voice-call.js) – מעקב אחר מצב החיבור
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      
      if (pc.iceConnectionState === 'connected') {
        state.isCallActive = true;
        state.callStartTime = Date.now();
        if (typeof App.onVoiceCallConnected === 'function') {
          App.onVoiceCallConnected(peerPubkey);
        }
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        endCall();
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

      // יצירת offer
      const offer = await state.peerConnection.createOffer();
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

      // קבלת offer
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

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
  function endCall() {
    console.log('Ending call');

    // שליחת אירוע disconnect
    if (state.currentPeer) {
      sendSignal(state.currentPeer, 'disconnect', null);
    }

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

    // איפוס מצב
    const peer = state.currentPeer;
    state.currentPeer = null;
    state.isCallActive = false;
    state.isIncoming = false;
    state.isMuted = false;
    state.callStartTime = null;

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
          // שיחה נכנסת
          state.isIncoming = true;
          if (typeof App.onVoiceCallIncoming === 'function') {
            App.onVoiceCallIncoming(peerPubkey, data);
          }
          break;

        case 'answer':
          // תשובה לשיחה יוצאת
          if (state.peerConnection && state.currentPeer === peerPubkey) {
            await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data));
          }
          break;

        case 'candidate':
          // ICE candidate
          if (state.peerConnection && state.currentPeer === peerPubkey && data) {
            await state.peerConnection.addIceCandidate(new RTCIceCandidate(data));
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

    const filters = [
      {
        kinds: [25050],
        '#p': [App.publicKey]
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
