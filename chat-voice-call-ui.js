// חלק שיחות קול (chat-voice-call-ui.js) – ממשק משתמש לשיחות קוליות בסגנון וואטסאפ
(function initChatVoiceCallUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  let callDialog = null;
  let remoteAudioElement = null;
  let callTimer = null;
  let timerInterval = null;

  // חלק שיחות קול (chat-voice-call-ui.js) – יצירת אלמנט אודיו מרוחק
  function createRemoteAudioElement() {
    if (remoteAudioElement) return remoteAudioElement;

    const audio = doc.createElement('audio');
    audio.id = 'voiceCallRemoteAudio';
    audio.autoplay = true;
    audio.style.display = 'none';
    doc.body.appendChild(audio);
    remoteAudioElement = audio;
    return audio;
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – פורמט זמן שיחה
  function formatCallDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – יצירת דיאלוג שיחה
  function createCallDialog(peerPubkey, isIncoming) {
    // הסרת דיאלוג קיים
    if (callDialog) {
      callDialog.remove();
    }

    const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
    const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
    const initials = contact?.initials || 'מש';
    const picture = contact?.picture || '';

    callDialog = doc.createElement('div');
    callDialog.id = 'voiceCallDialog';
    callDialog.className = 'voice-call-dialog';
    callDialog.innerHTML = `
      <div class="voice-call-dialog__backdrop"></div>
      <div class="voice-call-dialog__content">
        <div class="voice-call-dialog__header">
          <div class="voice-call-dialog__avatar">
            ${picture ? `<img src="${picture}" alt="${name}">` : `<span>${initials}</span>`}
          </div>
          <h3 class="voice-call-dialog__name">${name}</h3>
          <p class="voice-call-dialog__status">${isIncoming ? 'שיחה נכנסת...' : 'מתקשר...'}</p>
          <p class="voice-call-dialog__timer" hidden>0:00</p>
        </div>
        <div class="voice-call-dialog__actions">
          ${isIncoming ? `
            <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--accept" data-action="accept">
              <i class="fa-solid fa-phone"></i>
              <span>קבל</span>
            </button>
          ` : ''}
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--mute" data-action="mute" hidden>
            <i class="fa-solid fa-microphone"></i>
            <span>השתק</span>
          </button>
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--end" data-action="end">
            <i class="fa-solid fa-phone-slash"></i>
            <span>נתק</span>
          </button>
        </div>
      </div>
    `;

    doc.body.appendChild(callDialog);

    // חיבור אירועים
    const acceptBtn = callDialog.querySelector('[data-action="accept"]');
    const muteBtn = callDialog.querySelector('[data-action="mute"]');
    const endBtn = callDialog.querySelector('[data-action="end"]');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => handleAcceptCall(peerPubkey));
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', handleToggleMute);
    }

    if (endBtn) {
      endBtn.addEventListener('click', handleEndCall);
    }

    callTimer = callDialog.querySelector('.voice-call-dialog__timer');

    return callDialog;
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – עדכון סטטוס שיחה
  function updateCallStatus(status) {
    if (!callDialog) return;

    const statusEl = callDialog.querySelector('.voice-call-dialog__status');
    if (statusEl) {
      statusEl.textContent = status;
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – התחלת טיימר שיחה
  function startCallTimer() {
    if (!callDialog || !callTimer) return;

    const state = App.voiceCall?.getState();
    if (!state || !state.callStartTime) return;

    callTimer.removeAttribute('hidden');
    
    if (timerInterval) {
      clearInterval(timerInterval);
    }

    timerInterval = setInterval(() => {
      const elapsed = Date.now() - state.callStartTime;
      callTimer.textContent = formatCallDuration(elapsed);
    }, 1000);
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – עצירת טיימר
  function stopCallTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – הצגת כפתור השתקה
  function showMuteButton() {
    if (!callDialog) return;

    const muteBtn = callDialog.querySelector('[data-action="mute"]');
    if (muteBtn) {
      muteBtn.removeAttribute('hidden');
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – סגירת דיאלוג
  function closeCallDialog() {
    stopCallTimer();

    if (callDialog) {
      callDialog.remove();
      callDialog = null;
    }

    callTimer = null;
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בלחיצה על כפתור שיחה
  async function handleStartCall(peerPubkey) {
    if (!App.voiceCall?.isSupported()) {
      alert('הדפדפן שלך לא תומך בשיחות קוליות');
      return;
    }

    try {
      await App.voiceCall.start(peerPubkey);
    } catch (err) {
      console.error('Failed to start call', err);
      alert(err.message || 'שגיאה בהתחלת השיחה');
      closeCallDialog();
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בקבלת שיחה
  async function handleAcceptCall(peerPubkey) {
    const state = App.voiceCall?.getState();
    if (!state || !state.isIncoming) return;

    try {
      // שמירת ה-offer שהתקבל
      const offer = state.pendingOffer;
      await App.voiceCall.accept(peerPubkey, offer);
      
      updateCallStatus('מתחבר...');
    } catch (err) {
      console.error('Failed to accept call', err);
      alert(err.message || 'שגיאה בקבלת השיחה');
      closeCallDialog();
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בניתוק
  function handleEndCall() {
    if (App.voiceCall) {
      App.voiceCall.end();
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בהשתקה
  function handleToggleMute() {
    if (!App.voiceCall) return;

    const isMuted = App.voiceCall.toggleMute();
    
    if (!callDialog) return;

    const muteBtn = callDialog.querySelector('[data-action="mute"]');
    if (muteBtn) {
      const icon = muteBtn.querySelector('i');
      const text = muteBtn.querySelector('span');
      
      if (isMuted) {
        icon.className = 'fa-solid fa-microphone-slash';
        text.textContent = 'בטל השתקה';
        muteBtn.classList.add('is-muted');
      } else {
        icon.className = 'fa-solid fa-microphone';
        text.textContent = 'השתק';
        muteBtn.classList.remove('is-muted');
      }
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – callbacks מהמודול הראשי
  App.onVoiceCallIncoming = function(peerPubkey, offer) {
    console.log('Incoming call from', peerPubkey.slice(0, 8));
    
    // שמירת ה-offer למקרה של קבלה
    const state = App.voiceCall?.getState();
    if (state) {
      state.pendingOffer = offer;
    }

    createCallDialog(peerPubkey, true);
    
    // ניגון צלצול (אופציונלי)
    playRingtone();
  };

  App.onVoiceCallStarted = function(peerPubkey, isIncoming) {
    console.log('Call started', isIncoming ? 'incoming' : 'outgoing');
    
    if (!callDialog) {
      createCallDialog(peerPubkey, isIncoming);
    }

    updateCallStatus('מתחבר...');
    stopRingtone();
  };

  App.onVoiceCallConnected = function(peerPubkey) {
    console.log('Call connected');
    
    updateCallStatus('מחובר');
    showMuteButton();
    startCallTimer();
  };

  App.onVoiceCallRemoteStream = function(stream) {
    console.log('Received remote stream');
    
    const audio = createRemoteAudioElement();
    audio.srcObject = stream;
  };

  App.onVoiceCallEnded = function(peerPubkey) {
    console.log('Call ended');
    
    closeCallDialog();
    stopRingtone();
    
    if (remoteAudioElement) {
      remoteAudioElement.srcObject = null;
    }
  };

  App.onVoiceCallMuteToggle = function(isMuted) {
    console.log('Mute toggled:', isMuted);
  };

  // חלק שיחות קול (chat-voice-call-ui.js) – ניגון צלצול (פשוט)
  let ringtoneAudio = null;
  function playRingtone() {
    // ניתן להוסיף קובץ אודיו לצלצול
    // ringtoneAudio = new Audio('./sounds/ringtone.mp3');
    // ringtoneAudio.loop = true;
    // ringtoneAudio.play();
  }

  function stopRingtone() {
    if (ringtoneAudio) {
      ringtoneAudio.pause();
      ringtoneAudio.currentTime = 0;
      ringtoneAudio = null;
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – חיבור לכפתור שיחת קול בכותרת
  function initCallButton() {
    // המתנה לטעינת הממשק
    const tryInit = () => {
      const chatPanel = doc.getElementById('chatPanel');
      if (!chatPanel) {
        setTimeout(tryInit, 500);
        return;
      }

      // חיפוש כפתור טלפון בכותרת השיחה
      const callButtons = chatPanel.querySelectorAll('.chat-conversation__icon');
      let phoneButton = null;

      callButtons.forEach(btn => {
        const icon = btn.querySelector('i');
        if (icon && (icon.classList.contains('fa-phone') || btn.getAttribute('aria-label') === 'שיחת קול')) {
          phoneButton = btn;
        }
      });

      if (!phoneButton) {
        // ניסיון נוסף אחרי טעינה
        setTimeout(tryInit, 1000);
        return;
      }

      // הסרת מאזינים קיימים
      const newButton = phoneButton.cloneNode(true);
      phoneButton.parentNode.replaceChild(newButton, phoneButton);

      newButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // קבלת ה-peer הפעיל מהפונקציה החשופה
        const activePeer = typeof App.getActiveChatContact === 'function' 
          ? App.getActiveChatContact() 
          : null;

        if (!activePeer) {
          alert('אנא בחר שיחה תחילה');
          return;
        }

        console.log('Starting call to:', activePeer.slice(0, 8));
        handleStartCall(activePeer);
      });

      console.log('Voice call button initialized successfully');
    };

    tryInit();
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – אתחול
  function init() {
    createRemoteAudioElement();
    initCallButton();
    console.log('Voice call UI initialized');
  }

  // אתחול כשהדף נטען
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // חשיפת פונקציות
  Object.assign(App, {
    startVoiceCall: handleStartCall,
    endVoiceCall: handleEndCall
  });
})(window);
