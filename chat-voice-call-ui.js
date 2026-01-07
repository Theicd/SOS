// חלק שיחות קול (chat-voice-call-ui.js) – ממשק משתמש לשיחות קוליות בסגנון וואטסאפ
(function initChatVoiceCallUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  let callDialog = null;
  let remoteAudioElement = null;
  let callTimer = null;
  let timerInterval = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – קבצי צלילי שיחה (MP3): חיוג למחייג + צלצול למקבל | HYPER CORE TECH
  const DIALTONE_MP3_URL = 'https://npub1hwja2gw0m3kmehwp22rtfu7larrt8tnx4lyqhxp4nzu7jxzzj3wqwl9uc9.blossom.band/61924ef011f5b03e4ec49f0f9c9ac32361419607bd5c52f879bc8d0dd4938107.mp3';
  const RINGTONE_MP3_URL = 'https://npub1hwja2gw0m3kmehwp22rtfu7larrt8tnx4lyqhxp4nzu7jxzzj3wqwl9uc9.blossom.band/2c9aa92402a15e51f2a9dc542f5ce6a7c11e36065eb223f343e0d0bfe07de34d.mp3';
  const WAITING_TONE_MP3_URL = 'https://assets.mixkit.co/sfx/download/mixkit-correct-answer-tone-2870.wav'; // צליל קצר לשיחה ממתינה
  // חלק שיחות קול (chat-voice-call-ui.js) – אובייקטי אודיו לצלילים + priming ל-autoplay | HYPER CORE TECH
  let dialtoneAudio = null;
  let ringtoneAudio = null;
  let tonePrimerAudio = null;
  let toneAudioPrimed = false;
  let waitingToneAudio = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – התראות מערכת לשיחה נכנסת (Notification API) | HYPER CORE TECH
  let incomingCallNotification = null;
  let notificationPermissionLastRequestedAt = 0;
  // חלק שיחות קול (chat-voice-call-ui.js) – רישום Service Worker להתראות שיחה נכנסת עם פעולות | HYPER CORE TECH
  let voiceCallServiceWorkerRegisterAttempted = false;
  // חלק שיחות קול (chat-voice-call-ui.js) – בחירת התקן פלט לשיחת קול (setSinkId/selectAudioOutput) | HYPER CORE TECH
  let selectedOutputDeviceId = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – שמירת offer נכנס מקומית לתהליך קבלה
  let incomingOffer = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – שומר את ה-peer הפעיל כדי לסגור UI בצורה מדויקת בעת ניתוק/ביטול | HYPER CORE TECH
  let activePeerPubkey = null;
  // חלק שיחות קול (chat-voice-call-ui.js) – דגל: המשתמש דחה את השיחה באופן יזום (לא לרשום כ-missed) | HYPER CORE TECH
  let userDeclinedCall = false;
  // חלק שיחות קול (chat-voice-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה כדי להחזיר אותו בסיום | HYPER CORE TECH
  let chatPanelWasOpen = false;
  let chatActiveContactBeforeCall = null;

  // חלק שיחות קול (chat-voice-call-ui.js) – יצירת אלמנט אודיו מרוחק
  function createRemoteAudioElement() {
    if (remoteAudioElement) return remoteAudioElement;

    const audio = doc.createElement('audio');
    audio.id = 'voiceCallRemoteAudio';
    audio.autoplay = true;
    // חלק שיחות קול (chat-voice-call-ui.js) – playsinline לתאימות מובייל/‏PWA | HYPER CORE TECH
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    doc.body.appendChild(audio);
    remoteAudioElement = audio;
    return audio;
  }

  // חלק שיחה ממתינה (chat-voice-call-ui.js) – צליל קצר במקום צלצול בעת שיחה פעילה | HYPER CORE TECH
  function playWaitingTone() {
    try {
      if (!waitingToneAudio) {
        waitingToneAudio = new Audio(WAITING_TONE_MP3_URL);
        waitingToneAudio.preload = 'auto';
        waitingToneAudio.volume = 0.55;
      }
      waitingToneAudio.currentTime = 0;
      waitingToneAudio.play()?.catch(() => {});
    } catch (_) {}
  }
  function stopWaitingTone() {
    try {
      if (waitingToneAudio) {
        waitingToneAudio.pause();
        waitingToneAudio.currentTime = 0;
      }
    } catch (_) {}
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

    activePeerPubkey = peerPubkey;

    const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
    const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
    const initials = contact?.initials || 'מש';
    const picture = contact?.picture || '';

    // חלק שיחות קול (chat-voice-call-ui.js) – עיצוב מסך מלא כמו שיחת וידיאו עם כותרת עליונה | HYPER CORE TECH
    callDialog = doc.createElement('div');
    callDialog.id = 'voiceCallDialog';
    callDialog.className = isIncoming ? 'voice-call-dialog voice-call-dialog--incoming' : 'voice-call-dialog';
    callDialog.innerHTML = `
      <div class="voice-call-dialog__backdrop"></div>
      <div class="voice-call-dialog__content">
        <div class="voice-call-dialog__topbar">
          <h2 class="voice-call-dialog__topbar-title">${isIncoming ? 'שיחה נכנסת' : 'מתחיל שיחת קול'}</h2>
          <p class="voice-call-dialog__topbar-sub">ממתין לתשובה...</p>
        </div>
        <div class="voice-call-dialog__header">
          <div class="voice-call-dialog__avatar">
            ${picture ? `<img src="${picture}" alt="${name}">` : `<span>${initials}</span>`}
          </div>
          <h3 class="voice-call-dialog__name">${name}</h3>
          <p class="voice-call-dialog__status">${isIncoming ? 'מחייג קול...' : 'מחייג...'}</p>
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
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--speaker" data-action="speaker" hidden>
            <i class="fa-solid fa-volume-high"></i>
            <span>רמקול</span>
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
    const speakerBtn = callDialog.querySelector('[data-action="speaker"]');
    const endBtn = callDialog.querySelector('[data-action="end"]');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => handleAcceptCall(peerPubkey));
    }

    if (muteBtn) {
      muteBtn.addEventListener('click', handleToggleMute);
    }

    if (speakerBtn) {
      speakerBtn.addEventListener('click', handleSelectOutputDevice);
    }

    if (endBtn) {
      endBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleEndCall();
      });
    }

    callTimer = callDialog.querySelector('.voice-call-dialog__timer');

    return callDialog;
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – עדכון סטטוס שיחה והסתרת כותרת עליונה בעת חיבור | HYPER CORE TECH
  function updateCallStatus(status) {
    if (!callDialog) return;

    const statusEl = callDialog.querySelector('.voice-call-dialog__status');
    if (statusEl) {
      statusEl.textContent = status;
    }

    // הסתרת הכותרת העליונה כשהשיחה מתחברת
    const topbar = callDialog.querySelector('.voice-call-dialog__topbar');
    if (topbar) {
      if (status === 'מחובר') {
        topbar.setAttribute('hidden', '');
      } else {
        topbar.removeAttribute('hidden');
        // עדכון טקסט הכותרת בהתאם לסטטוס
        const topbarSub = topbar.querySelector('.voice-call-dialog__topbar-sub');
        if (topbarSub) {
          if (status === 'מתחבר...') {
            topbarSub.textContent = 'מתחבר...';
          } else if (status === 'מחייג...') {
            topbarSub.textContent = 'ממתין לתשובה...';
          }
        }
      }
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

  // חלק שיחות קול (chat-voice-call-ui.js) – הצגת כפתור רמקול/בחירת פלט רק כשנתמך (בלי הפעלה אוטומטית) | HYPER CORE TECH
  function isOutputDeviceSelectionSupported() {
    const audio = remoteAudioElement || createRemoteAudioElement();
    const canSetSinkId = !!(audio && typeof audio.setSinkId === 'function');
    const canSelectOutput = !!(navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function');
    const canEnumerate = !!(navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function');
    return canSetSinkId && (canSelectOutput || canEnumerate);
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – AudioSession (בעיקר iOS Safari) להחלפת רמקול/אפרכסת כשאין setSinkId | HYPER CORE TECH
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

  // חלק שיחות קול (chat-voice-call-ui.js) – החלפת מצב רמקול/אפרכסת עם AudioSession (iOS) או setSinkId (Desktop) | HYPER CORE TECH
  function toggleSpeakerMode() {
    speakerModeActive = !speakerModeActive;
    const audio = remoteAudioElement || createRemoteAudioElement();

    // ניסיון עם AudioSession (iOS Safari)
    if (isAudioSessionTypeSupported()) {
      const next = speakerModeActive ? 'playback' : 'play-and-record';
      setAudioSessionTypeSafely(next);
      return;
    }

    // ניסיון עם setSinkId (Chrome/Edge Desktop)
    if (audio && typeof audio.setSinkId === 'function') {
      try {
        const targetId = speakerModeActive ? 'default' : 'communications';
        const p = audio.setSinkId(targetId);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    }
  }

  function showSpeakerButton() {
    if (!callDialog) return;
    const speakerBtn = callDialog.querySelector('[data-action="speaker"]');
    if (!speakerBtn) return;
    speakerBtn.removeAttribute('hidden');
    updateSpeakerButtonUI();
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – עדכון UI כפתור רמקול לפי מצב נוכחי | HYPER CORE TECH
  function updateSpeakerButtonUI() {
    if (!callDialog) return;
    const speakerBtn = callDialog.querySelector('[data-action="speaker"]');
    if (!speakerBtn) return;

    const icon = speakerBtn.querySelector('i');
    const text = speakerBtn.querySelector('span');
    if (!text) return;

    if (selectedOutputDeviceId) {
      text.textContent = 'פלט נבחר';
      return;
    }

    // עדכון טקסט ואייקון לפי מצב רמקול
    if (speakerModeActive) {
      text.textContent = 'אפרכסת';
      if (icon) icon.className = 'fa-solid fa-volume-high';
      speakerBtn.classList.add('is-speaker-on');
    } else {
      text.textContent = 'רמקול';
      if (icon) icon.className = 'fa-solid fa-volume-low';
      speakerBtn.classList.remove('is-speaker-on');
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – מצב רמקול פעיל (true = רמקול, false = אפרכסת) | HYPER CORE TECH
  let speakerModeActive = false;

  function applyOutputDeviceIdToMediaElement(el, deviceId) {
    if (!el || typeof el.setSinkId !== 'function') return;
    try {
      const targetId = deviceId || 'default';
      const p = el.setSinkId(targetId);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – הגדרת ברירת מחדל לאפרכסת בתחילת שיחה (setSinkId או AudioSession) | HYPER CORE TECH
  function setDefaultEarpieceOutput() {
    speakerModeActive = false;
    const audio = remoteAudioElement || createRemoteAudioElement();
    // ניסיון להגדיר communications (אפרכסת) בדפדפנים שתומכים
    if (audio && typeof audio.setSinkId === 'function') {
      try {
        const p = audio.setSinkId('communications');
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // אם communications לא נתמך, נשאר ב-default
            try { audio.setSinkId('default'); } catch {}
          });
        }
      } catch {}
    }
  }

  function applySelectedOutputDeviceToAllMediaElements() {
    const audioEls = [
      remoteAudioElement,
      dialtoneAudio,
      ringtoneAudio,
      tonePrimerAudio
    ].filter(Boolean);

    audioEls.forEach((el) => applyOutputDeviceIdToMediaElement(el, selectedOutputDeviceId));
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – איפוס בחירת פלט ומצב רמקול בסיום שיחה | HYPER CORE TECH
  function resetOutputDeviceSelection() {
    selectedOutputDeviceId = null;
    speakerModeActive = false;
    applySelectedOutputDeviceToAllMediaElements();
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בלחיצה על כפתור רמקול: החלפת מצב פשוטה | HYPER CORE TECH
  function handleSelectOutputDevice() {
    toggleSpeakerMode();
    updateSpeakerButtonUI();
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – סגירת דיאלוג
  function closeCallDialog() {
    stopCallTimer();

    // חלק שיחות קול (chat-voice-call-ui.js) – סגירת התראת מערכת (אם קיימת) בעת סגירת ה-UI | HYPER CORE TECH
    closeIncomingCallNotification();

    // חלק שיחות קול (chat-voice-call-ui.js) – איפוס בחירת פלט כדי ששיחה הבאה תתחיל בברירת מחדל (לא רמקול אוטומטי) | HYPER CORE TECH
    resetOutputDeviceSelection();

    // חלק שיחות קול (chat-voice-call-ui.js) – ניקוי offer ו-peer ודגל דחייה כדי למנוע קבלה של הצעה ישנה לאחר סגירה | HYPER CORE TECH
    incomingOffer = null;
    activePeerPubkey = null;
    userDeclinedCall = false;

    if (callDialog) {
      callDialog.remove();
      callDialog = null;
    }

    callTimer = null;

    // חלק שיחות קול (chat-voice-call-ui.js) – החזרת מצב פאנל הצ'אט לאחר סיום השיחה | HYPER CORE TECH
    restoreChatPanelState();
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה | HYPER CORE TECH
  function saveChatPanelState() {
    const chatPanel = doc.getElementById('chatPanel');
    chatPanelWasOpen = chatPanel && !chatPanel.hasAttribute('hidden');
    chatActiveContactBeforeCall = App.chatState?.activeContact || App.getActiveChatContact?.() || null;
    console.log('[VOICE] Saved chat panel state:', { open: chatPanelWasOpen, contact: chatActiveContactBeforeCall?.slice?.(0, 8) });
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – החזרת מצב פאנל הצ'אט לאחר סיום השיחה | HYPER CORE TECH
  function restoreChatPanelState() {
    console.log('[VOICE] restoreChatPanelState called:', { 
      chatPanelWasOpen, 
      contact: chatActiveContactBeforeCall?.slice?.(0, 8) 
    });

    if (!chatPanelWasOpen && !chatActiveContactBeforeCall) {
      console.log('[VOICE] No chat state to restore');
      return;
    }

    // תמיד לנסות לפתוח את פאנל הצ'אט ולחזור לשיחה
    setTimeout(() => {
      const chatPanel = doc.getElementById('chatPanel');
      console.log('[VOICE] Restoring - chatPanel hidden?', chatPanel?.hasAttribute('hidden'));

      // פתיחת פאנל הצ'אט
      if (typeof App.toggleChatPanel === 'function') {
        App.toggleChatPanel(true);
      } else if (chatPanel) {
        chatPanel.removeAttribute('hidden');
        doc.body.classList.add('chat-overlay-open');
      }

      // חזרה לשיחה הפעילה
      if (chatActiveContactBeforeCall && typeof App.showChatConversation === 'function') {
        console.log('[VOICE] Showing conversation:', chatActiveContactBeforeCall.slice(0, 8));
        App.showChatConversation(chatActiveContactBeforeCall);
      }

      // איפוס המשתנים
      chatPanelWasOpen = false;
      chatActiveContactBeforeCall = null;
    }, 150);
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – התראות מערכת לשיחה נכנסת (Notification API) | HYPER CORE TECH
  // חלק שיחות קול (chat-voice-call-ui.js) – רישום Service Worker כדי לאפשר פתיחת מסך שיחה מתוך ההתראה (ללא מענה אוטומטי) | HYPER CORE TECH
  function registerVoiceCallServiceWorkerIfSupported() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    if (voiceCallServiceWorkerRegisterAttempted) return;
    voiceCallServiceWorkerRegisterAttempted = true;
    try {
      const p = navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function getVoiceCallServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!window.isSecureContext) return Promise.resolve(null);
    try {
      return navigator.serviceWorker.getRegistration().catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function requestNotificationPermissionIfNeeded() {
    if (!('Notification' in window)) return;
    registerVoiceCallServiceWorkerIfSupported();
    try {
      if (window.Notification.permission !== 'default') return;

      const now = Date.now();
      if (notificationPermissionLastRequestedAt && (now - notificationPermissionLastRequestedAt) < 60000) return;
      notificationPermissionLastRequestedAt = now;

      if (window.Notification.permission === 'default') {
        const p = window.Notification.requestPermission();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {}
  }

  function closeIncomingCallNotification() {
    if (incomingCallNotification) {
      try { incomingCallNotification.close(); } catch {}
      incomingCallNotification = null;
    }

    getVoiceCallServiceWorkerRegistration().then((reg) => {
      if (!reg || typeof reg.getNotifications !== 'function') return;
      return reg.getNotifications({ tag: 'voice-call-incoming' }).then((items) => {
        (items || []).forEach((n) => {
          try { n.close(); } catch {}
        });
      }).catch(() => {});
    }).catch(() => {});
  }

  function showIncomingCallNotification(peerPubkey) {
    try {
      if (!('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;

      const isHidden = !!doc.hidden || doc.visibilityState === 'hidden';
      const hasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
      if (!isHidden && hasFocus) return;

      closeIncomingCallNotification();
      registerVoiceCallServiceWorkerIfSupported();

      const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
      const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
      const picture = contact?.picture || '';

      const baseOptions = {
        body: name,
        tag: 'voice-call-incoming',
        renotify: true
      };
      if (picture) baseOptions.icon = picture;
      try { baseOptions.requireInteraction = true; } catch {}

      const swOptions = Object.assign({}, baseOptions, {
        actions: [
          { action: 'open', title: 'פתח מסך שיחה (לא עונה)' }
        ],
        data: {
          type: 'voice-call-incoming',
          peerPubkey: peerPubkey,
          url: window.location.href
        }
      });

      getVoiceCallServiceWorkerRegistration().then((reg) => {
        if (reg && typeof reg.showNotification === 'function') {
          try {
            const p = reg.showNotification('שיחה נכנסת', swOptions);
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }

        incomingCallNotification = new window.Notification('שיחה נכנסת', baseOptions);
        incomingCallNotification.onclick = () => {
          try { window.focus(); } catch {}
          closeIncomingCallNotification();
        };
      }).catch(() => {
        try {
          incomingCallNotification = new window.Notification('שיחה נכנסת', baseOptions);
          incomingCallNotification.onclick = () => {
            try { window.focus(); } catch {}
            closeIncomingCallNotification();
          };
        } catch {}
      });
    } catch (err) {
      console.warn('Failed to show incoming call notification', err);
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – קבלת פעולה מהתראת Service Worker (פתיחת מסך שיחה ללא מענה אוטומטי) | HYPER CORE TECH
  function handleVoiceCallServiceWorkerMessage(event) {
    const data = event && event.data ? event.data : null;
    if (!data || data.type !== 'voice-call-notification-action') return;

    const peerPubkey = data.peerPubkey || activePeerPubkey;
    if (!peerPubkey) return;

    closeIncomingCallNotification();
    try { window.focus(); } catch {}
    if (!callDialog) {
      createCallDialog(peerPubkey, true);
    }
  }

  function initVoiceCallServiceWorkerMessageHandling() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.addEventListener('message', handleVoiceCallServiceWorkerMessage);
    } catch {}
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בלחיצה על כפתור שיחה
  async function handleStartCall(peerPubkey) {
    if (!App.voiceCall?.isSupported()) {
      alert('הדפדפן שלך לא תומך בשיחות קוליות');
      return;
    }

    // חלק שיחות קול (chat-voice-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה | HYPER CORE TECH
    saveChatPanelState();

    // חלק שיחות קול (chat-voice-call-ui.js) – עצירת וידיאו ברקע כדי לא להפריע לשיחה | HYPER CORE TECH
    if (typeof App.pauseAllFeedVideos === 'function') {
      App.pauseAllFeedVideos();
    }

    // חלק שיחות קול (chat-voice-call-ui.js) – שיחה יוצאת: יצירת UI והתחלת טון חיוג בתוך מחוות המשתמש (autoplay) | HYPER CORE TECH
    if (!callDialog) {
      createCallDialog(peerPubkey, false);
    }

    updateCallStatus('מחייג...');
    resumeAudioIfNeeded();
    playDialtone();

    try {
      await App.voiceCall.start(peerPubkey);
    } catch (err) {
      console.error('Failed to start call', err);
      alert(err.message || 'שגיאה בהתחלת השיחה');
      stopRingtone();
      stopDialtone();
      closeCallDialog();
    }
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בקבלת שיחה
  async function handleAcceptCall(peerPubkey) {
    try {
      // חלק שיחות קול (chat-voice-call-ui.js) – סגירת התראת מערכת מיד עם לחיצת "קבל" | HYPER CORE TECH
      closeIncomingCallNotification();
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

  // חלק שיחות קול (chat-voice-call-ui.js) – טיפול בניתוק/דחייה | HYPER CORE TECH
  function handleEndCall() {
    // סימון שהמשתמש דחה את השיחה באופן יזום (אם זו שיחה נכנסת שעדיין לא נענתה)
    if (incomingOffer) {
      userDeclinedCall = true;
    }
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

    // חלק שיחות קול (chat-voice-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה נכנסת | HYPER CORE TECH
    saveChatPanelState();

    // חלק שיחות קול (chat-voice-call-ui.js) – עצירת וידיאו ברקע כדי לא להפריע לשיחה נכנסת | HYPER CORE TECH
    if (typeof App.pauseAllFeedVideos === 'function') {
      App.pauseAllFeedVideos();
    }

    createCallDialog(peerPubkey, true);
    // חלק שיחות קול (chat-voice-call-ui.js) – התראת מערכת לשיחה נכנסת כשהטאב/דפדפן ברקע | HYPER CORE TECH
    showIncomingCallNotification(peerPubkey);
    // חלק שיחות קול (chat-voice-call-ui.js) – ניגון צלצול בצורה autoplay-safe (מחווה ראשונה אם צריך) | HYPER CORE TECH
    resumeOnUserGestureOnce(() => playRingtone());
  };

  // חלק שיחה ממתינה (chat-voice-call-ui.js) – התראה קצרה ללא צלצול מלא בזמן שיחה פעילה | HYPER CORE TECH
  App.onVoiceCallWaiting = function(peerPubkey, offer) {
    console.log('Call waiting from', peerPubkey.slice(0, 8));
    const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
    const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
    const initials = contact?.initials || 'מש';
    const picture = contact?.picture || '';

    // צליל קצר
    playWaitingTone();

    // בנר/טוסט – הודעה קצרה
    try {
      const container = document.body;
      const toast = document.createElement('div');
      toast.className = 'voice-call-waiting-toast';
      toast.innerHTML = `
        <div class="voice-call-waiting-toast__avatar">
          ${picture ? `<img src="${picture}" alt="${name}">` : `<span>${initials}</span>`}
        </div>
        <div class="voice-call-waiting-toast__text">
          <strong>שיחה ממתינה</strong>
          <span>${name}</span>
        </div>
      `;
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('is-visible'));
      setTimeout(() => {
        toast.classList.remove('is-visible');
        setTimeout(() => toast.remove(), 250);
      }, 3200);
    } catch (err) {
      console.warn('call waiting toast failed', err);
    }
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
      closeIncomingCallNotification();
    } else {
      // מחייג – הפעל חיוג עד חיבור
      updateCallStatus('מחייג...');
      playDialtone();
    }
  };

  App.onVoiceCallConnected = function(peerPubkey) {
    console.log('Call connected');
    
    // חלק שיחות קול (chat-voice-call-ui.js) – הגדרת ברירת מחדל לאפרכסת בעת חיבור השיחה | HYPER CORE TECH
    setDefaultEarpieceOutput();
    updateCallStatus('מחובר');
    showMuteButton();
    showSpeakerButton();
    startCallTimer();
    stopRingtone();
    stopDialtone();
    closeIncomingCallNotification();
  };

  App.onVoiceCallRemoteStream = function(stream) {
    console.log('Received remote stream');
    
    const audio = createRemoteAudioElement();
    audio.srcObject = stream;
  };
  App.onVoiceCallMuteToggle = function(isMuted) {
    console.log('Mute toggled:', isMuted);
  };

  // חלק שיחות קול (chat-voice-call-ui.js) – סגירת UI בעת ניתוק/ביטול מהצד השני | HYPER CORE TECH
  App.onVoiceCallEnded = function(peerPubkey) {
    const peer = peerPubkey || activePeerPubkey;
    if (peer && activePeerPubkey && peer !== activePeerPubkey) {
      return;
    }
    stopRingtone();
    stopDialtone();
    closeCallDialog();
  };

  // חלק שיחות קול (chat-voice-call-ui.js) – רישום שיחה שלא נענתה בהיסטוריית הצ'אט ועדכון מונה לא נקראו | HYPER CORE TECH
  App.onVoiceCallMissed = function(peerPubkey) {
    // אם המשתמש דחה את השיחה באופן יזום – לא לרשום כ-missed
    if (userDeclinedCall) {
      userDeclinedCall = false;
      return;
    }

    if (!peerPubkey) return;
    console.log('Missed call from', peerPubkey.slice(0, 8));

    // יצירת הודעת "שיחה שלא נענתה" מיוחדת
    const missedCallMessage = {
      id: 'missed-call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      from: peerPubkey,
      to: App.publicKey,
      content: '📞 שיחה שלא נענתה',
      createdAt: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
      direction: 'incoming',
      type: 'missed_call'
    };

    // הוספה להיסטוריית השיחה דרך chat-state (משתמש ב-API הנכון)
    if (typeof App.appendChatMessage === 'function') {
      App.appendChatMessage(missedCallMessage);
    }
  };

  // חלק שיחות קול (chat-voice-call-ui.js) – צלילי חיוג/צלצול באמצעות קבצי MP3 | HYPER CORE TECH
  function ensureToneAudioElements() {
    if (!dialtoneAudio) {
      dialtoneAudio = new window.Audio(DIALTONE_MP3_URL);
      dialtoneAudio.loop = true;
      dialtoneAudio.preload = 'auto';
      dialtoneAudio.playsInline = true;
      try { dialtoneAudio.setAttribute('playsinline', ''); } catch {}
    }
    if (!ringtoneAudio) {
      ringtoneAudio = new window.Audio(RINGTONE_MP3_URL);
      ringtoneAudio.loop = true;
      ringtoneAudio.preload = 'auto';
      ringtoneAudio.playsInline = true;
      try { ringtoneAudio.setAttribute('playsinline', ''); } catch {}
    }
    if (!tonePrimerAudio) {
      tonePrimerAudio = new window.Audio(RINGTONE_MP3_URL);
      tonePrimerAudio.loop = false;
      tonePrimerAudio.preload = 'auto';
      tonePrimerAudio.playsInline = true;
      try { tonePrimerAudio.setAttribute('playsinline', ''); } catch {}
    }
  }

  function primeToneAudioOnce() {
    if (toneAudioPrimed) return;
    ensureToneAudioElements();

    try {
      tonePrimerAudio.muted = true;
      const p = tonePrimerAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          try { tonePrimerAudio.pause(); } catch {}
          try { tonePrimerAudio.currentTime = 0; } catch {}
          tonePrimerAudio.muted = false;
          toneAudioPrimed = true;
        }).catch(() => {
          try { tonePrimerAudio.muted = false; } catch {}
        });
      } else {
        try { tonePrimerAudio.pause(); } catch {}
        try { tonePrimerAudio.currentTime = 0; } catch {}
        tonePrimerAudio.muted = false;
        toneAudioPrimed = true;
      }
    } catch {
      try { tonePrimerAudio.muted = false; } catch {}
    }
  }

  function resumeAudioIfNeeded() {
    requestNotificationPermissionIfNeeded();
    primeToneAudioOnce();
  }

  function resumeOnUserGestureOnce(next) {
    if (toneAudioPrimed) {
      try { next && next(); } catch {}
      return;
    }
    const handler = () => {
      requestNotificationPermissionIfNeeded();
      primeToneAudioOnce();
      try { next && next(); } catch {}
      doc.removeEventListener('pointerdown', handler, true);
      doc.removeEventListener('click', handler, true);
      doc.removeEventListener('touchstart', handler, true);
    };
    doc.addEventListener('pointerdown', handler, true);
    doc.addEventListener('click', handler, true);
    doc.addEventListener('touchstart', handler, true);
  }

  function stopRingtone() {
    if (!ringtoneAudio) return;
    try { ringtoneAudio.pause(); } catch {}
    try { ringtoneAudio.currentTime = 0; } catch {}
  }

  function stopDialtone() {
    if (!dialtoneAudio) return;
    try { dialtoneAudio.pause(); } catch {}
    try { dialtoneAudio.currentTime = 0; } catch {}
  }

  function playRingtone() {
    ensureToneAudioElements();
    stopDialtone();
    if (ringtoneAudio && !ringtoneAudio.paused) return;
    try { ringtoneAudio.currentTime = 0; } catch {}
    try {
      const p = ringtoneAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function playDialtone() {
    ensureToneAudioElements();
    stopRingtone();
    if (dialtoneAudio && !dialtoneAudio.paused) return;
    try { dialtoneAudio.currentTime = 0; } catch {}
    try {
      const p = dialtoneAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
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

        // חלק שיחות קול (chat-voice-call-ui.js) – priming לצלילי MP3 + בקשת הרשאת Notification בעקבות המחווה הזו | HYPER CORE TECH
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
    // חלק שיחות קול (chat-voice-call-ui.js) – רישום Service Worker להתראות שיחה נכנסת + האזנה לפעולות מהתראה | HYPER CORE TECH
    registerVoiceCallServiceWorkerIfSupported();
    initVoiceCallServiceWorkerMessageHandling();
    initCallButton();
    console.log('Voice call UI initialized');
    // חלק שיחות קול (chat-voice-call-ui.js) – priming לצלילי MP3 + בקשת הרשאת Notification אחרי מחווה ראשונה | HYPER CORE TECH
    resumeOnUserGestureOnce();
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
