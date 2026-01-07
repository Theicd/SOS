// חלק שיחות קול (chat-voice-call-ui.js) – ממשק משתמש לשיחות קוליות בסגנון וואטסאפ
(function initChatVoiceCallUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  let callDialog = null;
  let remoteAudioElement = null;
  let callTimer = null;
  let timerInterval = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – שמירת offer נכנס מקומית לתהליך קבלה
  let incomingOffer = null;

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
    try {
      // אימות offer נכנס
      const offer = incomingOffer;
      if (!offer || !offer.type || !offer.sdp) {
        alert('שגיאה: ההצעה לשיחה אינה תקינה. נסה שוב.');
        return;
      }
      await App.voiceCall.accept(peerPubkey, offer);
      incomingOffer = null;
      updateCallStatus('מתחבר...');
    } catch (err) {
      console.error('Failed to accept call', err);
      alert(err.message || 'שגיאה בקבלת השיחה');
      closeCallDialog();
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בניתוק
  function handleEndCall() {
    // סגירה מיידית של ה-UI כדי לא להיתקע אם יש השהייה ברשת
    closeCallDialog();
    stopRingtone();
    stopDialtone();
    if (App.voiceCall) {
      App.voiceCall.end();
    }
    // בטיחות: אם מסיבה כלשהי לא נסגר – נסה שוב אחרי 1.5 שניות
    setTimeout(() => { closeCallDialog(); }, 1500);
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
    // שמירת ה-offer באופן מקומי
    incomingOffer = offer;

    createCallDialog(peerPubkey, true);
    // ניגון צלצול לאחר מחווה ראשונה כדי להימנע ממדיניות חסימת אודיו
    resumeOnUserGestureOnce(() => playRingtone());
  };

  App.onVoiceCallStarted = function(peerPubkey, isIncoming) {
    console.log('Call started', isIncoming ? 'incoming' : 'outgoing');
    
    if (!callDialog) {
      createCallDialog(peerPubkey, isIncoming);
    }

    if (isIncoming) {
      // מקבל – כבר היה צלצול, לאחר התחלת תהליך החיבור מחליפים סטטוס
      updateCallStatus('מתחבר...');
      stopRingtone();
    } else {
      // מחייג – הפעל חיוג עד חיבור
      updateCallStatus('מחייג...');
      playDialtone();
    }
  };

  App.onVoiceCallConnected = function(peerPubkey) {
    console.log('Call connected');
    
    updateCallStatus('מחובר');
    showMuteButton();
    startCallTimer();
    stopRingtone();
    stopDialtone();
  };

  App.onVoiceCallRemoteStream = function(stream) {
    console.log('Received remote stream');
    
    const audio = createRemoteAudioElement();
    audio.srcObject = stream;
  };
  App.onVoiceCallMuteToggle = function(isMuted) {
    console.log('Mute toggled:', isMuted);
  };

  // חלק שיחות קול (chat-voice-call-ui.js) – ניגון צלצול (פשוט)
  // חלק שיחות קול (chat-voice-call-ui.js) – צלילי חיוג/צלצול באמצעות WebAudio ללא קבצים חיצוניים
  let audioCtx = null;
  let toneInterval = null;
  let activeOscillators = [];

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function resumeAudioIfNeeded() {
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
    } catch {}
  }

  function resumeOnUserGestureOnce(next) {
    const handler = () => {
      resumeAudioIfNeeded();
      try { next && next(); } catch {}
      doc.removeEventListener('pointerdown', handler, true);
      doc.removeEventListener('click', handler, true);
      doc.removeEventListener('touchstart', handler, true);
    };
    doc.addEventListener('pointerdown', handler, true);
    doc.addEventListener('click', handler, true);
    doc.addEventListener('touchstart', handler, true);
  }

  function stopAllTones() {
    if (toneInterval) {
      clearInterval(toneInterval);
      toneInterval = null;
    }
    activeOscillators.forEach(({ osc, gain }) => {
      try { gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05); } catch {}
      try { osc.stop(); } catch {}
    });
    activeOscillators = [];
  }

  // צלצול נכנס: שני אוסילטורים 440Hz ו-480Hz בקאדנס 2s on / 4s off
  function playRingtone() {
    ensureAudioCtx();
    stopAllTones();
    const playBurst = () => {
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc1.frequency.value = 440;
      osc2.frequency.value = 480;
      gain.gain.value = 0.0001;
      osc1.connect(gain); osc2.connect(gain); gain.connect(audioCtx.destination);
      osc1.start(); osc2.start();
      gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.05);
      activeOscillators.push({ osc: osc1, gain }, { osc: osc2, gain });
      setTimeout(() => { stopAllTones(); }, 2000); // 2s on
    };
    playBurst();
    toneInterval = setInterval(playBurst, 4000); // כל 4s מחדש
  }

  // חיוג יוצא: טון 425Hz בפולסים 0.4s on / 0.2s off (רצף)
  function playDialtone() {
    ensureAudioCtx();
    stopAllTones();
    const patternOn = 400, patternOff = 200;
    const startPulse = () => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 425;
      gain.gain.value = 0.0001;
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.03);
      activeOscillators.push({ osc, gain });
      setTimeout(() => {
        stopAllTones();
      }, patternOn);
    };
    startPulse();
    toneInterval = setInterval(startPulse, patternOn + patternOff);
  }

  function stopRingtone() { stopAllTones(); }
  function stopDialtone() { stopAllTones(); }

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

        // הבטחת AudioContext פעיל בעקבות המחווה הזו
        resumeAudioIfNeeded();
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
    // סגירת בטיחות כשעוזבים את הדף
    window.addEventListener('beforeunload', () => {
      stopRingtone();
      stopDialtone();
      closeCallDialog();
    });
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
    endVoiceCall: handleEndCall,
    closeVoiceCallUI: closeCallDialog
  });
})(window);
