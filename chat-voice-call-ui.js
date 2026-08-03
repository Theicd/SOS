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
  let incomingOfferPeer = null;
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

  function markCallUiActive(active) {
    try {
      if (active) {
        doc.body.classList.add('sos-call-active');
        window.__sosIncomingCallActive = true;
      } else {
        doc.body.classList.remove('sos-call-active');
        window.__sosIncomingCallActive = false;
      }
    } catch (_) {}
  }

  function persistIncomingOffer(peerPubkey, offer) {
    try {
      const peer = String(peerPubkey || '').toLowerCase();
      sessionStorage.setItem('sos_pending_voice_offer', JSON.stringify({
        peer, callType: 'voice', offer, savedAt: Date.now()
      }));
    } catch (_) {}
    try {
      if (typeof App.nativeCacheIncomingCallOffer === 'function') {
        App.nativeCacheIncomingCallOffer(peerPubkey, 'voice', offer);
      }
    } catch (_) {}
  }

  function clearPersistedIncomingOffer() {
    try { sessionStorage.removeItem('sos_pending_voice_offer'); } catch (_) {}
    try {
      if (typeof App.nativeClearIncomingCallOffer === 'function') App.nativeClearIncomingCallOffer();
    } catch (_) {}
  }

  function restoreIncomingOffer(peerPubkey, pendingOfferDetail) {
    if (incomingOffer && incomingOffer.type && incomingOffer.sdp) return incomingOffer;
    const tryParse = (parsed) => {
      if (!parsed) return null;
      try {
        const offerRaw = parsed.offer != null ? parsed.offer : parsed;
        const offer = typeof offerRaw === 'string' ? JSON.parse(offerRaw) : offerRaw;
        const peer = String(parsed.peer || peerPubkey || '').toLowerCase();
        if (!offer?.type || !offer?.sdp) return null;
        if (peerPubkey && peer && peer !== String(peerPubkey).toLowerCase()) return null;
        incomingOffer = offer;
        incomingOfferPeer = peer || String(peerPubkey || '').toLowerCase() || incomingOfferPeer;
        return offer;
      } catch (_) {
        return null;
      }
    };
    try {
      if (pendingOfferDetail) {
        const parsed = typeof pendingOfferDetail === 'string' ? JSON.parse(pendingOfferDetail) : pendingOfferDetail;
        const ok = tryParse(parsed);
        if (ok) return ok;
      }
    } catch (_) {}
    try {
      if (typeof App.nativeGetIncomingCallOffer === 'function') {
        const ok = tryParse(App.nativeGetIncomingCallOffer());
        if (ok) return ok;
      }
    } catch (_) {}
    try {
      const raw = sessionStorage.getItem('sos_pending_voice_offer');
      if (raw) {
        const ok = tryParse(JSON.parse(raw));
        if (ok) return ok;
      }
    } catch (_) {}
    return null;
  }

  // חלק APK – פענוח EVENT גולמי שנשמר ב-native כשהמסך היה כבוי | HYPER CORE TECH
  async function hydrateOfferFromNativeRawEvent(peerPubkey, pendingRawEventDetail) {
    if (incomingOffer && incomingOffer.type && incomingOffer.sdp) return incomingOffer;
    const peerWanted = String(peerPubkey || '').toLowerCase();

    const tryDecryptEvent = async (eventObj) => {
      if (!eventObj || typeof eventObj !== 'object') return null;
      const peer = String(eventObj.pubkey || '').toLowerCase();
      if (peerWanted && peer && peer !== peerWanted) return null;
      if (!eventObj.content || !App.privateKey || !window.NostrTools?.nip04) return null;
      try {
        const decrypted = await window.NostrTools.nip04.decrypt(
          App.privateKey,
          peer,
          eventObj.content
        );
        let offer = decrypted ? JSON.parse(decrypted) : null;
        if (offer && offer.offer && !offer.type && !offer.sdp) offer = offer.offer;
        if (!offer?.type || !offer?.sdp) return null;
        incomingOffer = offer;
        incomingOfferPeer = peer || peerWanted || incomingOfferPeer;
        persistIncomingOffer(incomingOfferPeer, offer);
        console.log('[APK] hydrated offer from native raw event', peer.slice(0, 8));
        return offer;
      } catch (err) {
        console.warn('[APK] decrypt raw event failed', err);
        return null;
      }
    };

    const unwrap = (raw) => {
      if (!raw) return null;
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed?.event) {
          const ev = typeof parsed.event === 'string' ? JSON.parse(parsed.event) : parsed.event;
          return { meta: parsed, event: ev };
        }
        if (parsed?.pubkey && parsed?.content) return { meta: null, event: parsed };
      } catch (_) {}
      return null;
    };

    try {
      if (pendingRawEventDetail) {
        const pack = unwrap(pendingRawEventDetail);
        if (pack) {
          const ok = await tryDecryptEvent(pack.event);
          if (ok) return ok;
        }
      }
    } catch (_) {}

    try {
      let pack = null;
      if (typeof App.nativeGetIncomingCallRawEvent === 'function') {
        pack = unwrap(App.nativeGetIncomingCallRawEvent());
      } else {
        const bridge = window.SosNativeShell;
        if (bridge && typeof bridge.getIncomingCallRawEvent === 'function') {
          pack = unwrap(bridge.getIncomingCallRawEvent());
        }
      }
      if (pack) {
        const ok = await tryDecryptEvent(pack.event);
        if (ok) return ok;
      }
    } catch (_) {}

    return null;
  }

  async function ensureMicReady() {
    try {
      if (typeof App.nativeRequestMediaPermissions === 'function') {
        App.nativeRequestMediaPermissions(false);
      }
    } catch (_) {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.requestMediaPermissions === 'function') {
        bridge.requestMediaPermissions(false);
      }
    } catch (_) {}
    // קצר – נותנים לדיאלוג הרשאות להופיע בלי לחסום לנצח
    await new Promise((r) => setTimeout(r, 350));
  }

  // חלק שיחות קול (chat-voice-call-ui.js) – יצירת דיאלוג שיחה
  function createCallDialog(peerPubkey, isIncoming) {
    // הסרת דיאלוג קיים
    if (callDialog) {
      callDialog.remove();
    }

    activePeerPubkey = peerPubkey;
    markCallUiActive(true);

    const contact = App.chatState?.contacts?.get(String(peerPubkey || '').toLowerCase());
    const name = contact?.name || `משתמש ${String(peerPubkey || '').slice(0, 8)}`;
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
          <p class="voice-call-dialog__topbar-sub">${isIncoming ? 'לחץ ענה כדי להתחבר' : 'ממתין לתשובה...'}</p>
        </div>
        <div class="voice-call-dialog__header">
          <div class="voice-call-dialog__avatar">
            ${picture ? `<img src="${picture}" alt="${name}">` : `<span>${initials}</span>`}
          </div>
          <h3 class="voice-call-dialog__name">${name}</h3>
          <p class="voice-call-dialog__status">${isIncoming ? 'מחייג אליך...' : 'מחייג...'}</p>
          <p class="voice-call-dialog__timer" hidden>0:00</p>
        </div>
        <div class="voice-call-dialog__actions">
          ${isIncoming ? `
            <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--accept" data-action="accept">
              <i class="fa-solid fa-phone"></i>
              <span>ענה</span>
            </button>
          ` : ''}
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--mute" data-action="mute">
            <i class="fa-solid fa-microphone"></i>
            <span>השתק</span>
          </button>
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--speaker" data-action="speaker">
            <i class="fa-solid fa-volume-high"></i>
            <span>רמקול</span>
          </button>
          <button type="button" class="voice-call-dialog__btn voice-call-dialog__btn--end" data-action="end">
            <i class="fa-solid fa-phone-slash"></i>
            <span>${isIncoming ? 'דחה' : 'נתק'}</span>
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
    incomingOfferPeer = null;
    activePeerPubkey = null;
    userDeclinedCall = false;
    clearPersistedIncomingOffer();
    markCallUiActive(false);

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

      const openUrl = `${window.location.origin}/videos.html?chat=${encodeURIComponent(peerPubkey)}&incomingCall=voice`;
      const swOptions = Object.assign({}, baseOptions, {
        actions: [
          { action: 'open', title: 'ענה / פתח שיחה' }
        ],
        data: {
          type: 'voice-call-incoming',
          peerPubkey: peerPubkey,
          incomingCall: 'voice',
          url: openUrl
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
          if (typeof App.resumeIncomingVoiceCallFromDeepLink === 'function') {
            App.resumeIncomingVoiceCallFromDeepLink(peerPubkey);
          } else if (!callDialog) {
            createCallDialog(peerPubkey, true);
          }
        };
      }).catch(() => {
        try {
          incomingCallNotification = new window.Notification('שיחה נכנסת', baseOptions);
          incomingCallNotification.onclick = () => {
            try { window.focus(); } catch {}
            closeIncomingCallNotification();
            if (typeof App.resumeIncomingVoiceCallFromDeepLink === 'function') {
              App.resumeIncomingVoiceCallFromDeepLink(peerPubkey);
            } else if (!callDialog) {
              createCallDialog(peerPubkey, true);
            }
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
    if (!data) return;
    if (data.type !== 'voice-call-notification-action' && !(data.type === 'sos-deeplink' && data.incomingCall === 'voice')) {
      return;
    }

    const peerPubkey = data.peerPubkey || data.chat || activePeerPubkey || incomingOfferPeer;
    if (!peerPubkey) return;

    closeIncomingCallNotification();
    try { window.focus(); } catch {}
    if (typeof App.resumeIncomingVoiceCallFromDeepLink === 'function') {
      App.resumeIncomingVoiceCallFromDeepLink(peerPubkey);
      return;
    }
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
      closeIncomingCallNotification();
      await ensureMicReady();
      await hydrateOfferFromNativeRawEvent(peerPubkey);
      restoreIncomingOffer(peerPubkey, null);
      const offer = incomingOffer;
      if (!offer || !offer.type || !offer.sdp) {
        updateCallStatus('ממתין להצעת שיחה...');
        alert('עדיין אין הצעת שיחה תקינה. המתן שנייה ונסה שוב.');
        return;
      }
      await App.voiceCall.accept(peerPubkey, offer);
      incomingOffer = null;
      incomingOfferPeer = null;
      clearPersistedIncomingOffer();
      updateCallStatus('מתחבר...');
      try {
        const endBtn = callDialog?.querySelector('[data-action="end"] span');
        if (endBtn) endBtn.textContent = 'נתק';
      } catch (_) {}
      try {
        if (typeof App.nativeStopCallRingtone === 'function') App.nativeStopCallRingtone();
      } catch (_) {}
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
    try {
      const peer = incomingOfferPeer || '';
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallDeclined === 'function') {
        bridge.markIncomingCallDeclined(peer);
      } else if (typeof App.nativeStopCallSounds === 'function') {
        App.nativeStopCallSounds();
      }
    } catch (_) {}
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
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : '';

    // דחייה ממתינה מ-APK – שולחים disconnect בלי לפתוח UI | HYPER CORE TECH
    try {
      const pendingDecline = window.__sosNativePendingDecline;
      if (pendingDecline && pendingDecline.peer === peer && Date.now() < (pendingDecline.until || 0)) {
        console.log('Incoming voice auto-rejected by native pending decline');
        incomingOffer = offer;
        incomingOfferPeer = peer;
        userDeclinedCall = true;
        if (App.voiceCall && typeof App.voiceCall.rejectIncoming === 'function') {
          App.voiceCall.rejectIncoming(peer);
        } else if (App.voiceCall) {
          App.voiceCall.end();
        }
        window.__sosNativePendingDecline = null;
        return;
      }
    } catch (_) {}

    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.isIncomingCallSuppressed === 'function') {
        if (bridge.isIncomingCallSuppressed(String(peerPubkey || ''))) {
          console.log('Incoming voice suppressed by native');
          return;
        }
      }
    } catch (_) {}

    // שמירת ה-offer באופן מקומי
    incomingOffer = offer;
    incomingOfferPeer = peer;
    persistIncomingOffer(peerPubkey, offer);

    // מענה ממתין מ-APK – מקבלים ברגע שיש offer | HYPER CORE TECH
    try {
      const pendingAnswer = window.__sosNativePendingAnswer;
      if (pendingAnswer && pendingAnswer.peer === peer && Date.now() < (pendingAnswer.until || 0)) {
        saveChatPanelState();
        if (typeof App.pauseAllFeedVideos === 'function') App.pauseAllFeedVideos();
        createCallDialog(peerPubkey, true);
        window.__sosNativePendingAnswer = null;
        setTimeout(() => handleAcceptCall(peer), 120);
        return;
      }
    } catch (_) {}

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
    try {
      if (typeof App.nativeStartCallRingtone === 'function') App.nativeStartCallRingtone();
    } catch (_) {}
  };

  // חלק APK (chat-voice-call-ui.js) – ענה מהתראת CallStyle | HYPER CORE TECH
  App.acceptIncomingCallFromNative = function acceptIncomingCallFromNative(peerPubkey, callType, pendingRawEvent) {
    if (callType && String(callType).toLowerCase() === 'video') {
      if (typeof App.acceptIncomingVideoCallFromNative === 'function') {
        return App.acceptIncomingVideoCallFromNative(peerPubkey, pendingRawEvent);
      }
      return false;
    }
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (incomingOfferPeer || '');
    if (!peer) return false;

    try {
      if (typeof App.initVoiceCall === 'function') {
        App.initVoiceCall({ force: true, lookbackSec: 120 });
      }
    } catch (_) {}

    window.__sosNativePendingAnswer = { peer, callType: 'voice', until: Date.now() + 45000 };
    window.__sosNativePendingDecline = null;

    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallAnswered === 'function') {
        bridge.markIncomingCallAnswered(peer);
      }
    } catch (_) {}

    if (!callDialog) {
      saveChatPanelState();
      createCallDialog(peer, true);
    }
    updateCallStatus('מתחבר...');

    let attempts = 0;
    const maxAttempts = 40;
    const tryAccept = async () => {
      attempts += 1;
      try {
        if (!App.privateKey || !window.NostrTools?.nip04) {
          if (attempts < maxAttempts) {
            setTimeout(tryAccept, 400);
            return;
          }
        }
        await hydrateOfferFromNativeRawEvent(peer, pendingRawEvent);
        restoreIncomingOffer(peer, null);
        if (incomingOffer && incomingOffer.type && incomingOffer.sdp) {
          window.__sosNativePendingAnswer = null;
          await handleAcceptCall(peer);
          return;
        }
      } catch (err) {
        console.warn('[APK] accept attempt failed', err);
      }
      if (attempts >= maxAttempts) {
        console.warn('[APK] accept timed out waiting for offer');
        window.__sosNativePendingAnswer = null;
        updateCallStatus('לא התקבלה הצעת שיחה');
        return;
      }
      setTimeout(tryAccept, 400);
    };
    tryAccept();
    return true;
  };

  // חלק APK (chat-voice-call-ui.js) – דחייה מהתראת CallStyle / ניתוק מרחוק | HYPER CORE TECH
  App.declineIncomingCallFromNative = async function declineIncomingCallFromNative(peerPubkey, callType) {
    if (callType && String(callType).toLowerCase() === 'video') {
      if (typeof App.declineIncomingVideoCallFromNative === 'function') {
        return App.declineIncomingVideoCallFromNative(peerPubkey);
      }
    }
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (incomingOfferPeer || '');
    window.__sosNativePendingDecline = { peer, until: Date.now() + 45000 };
    window.__sosNativePendingAnswer = null;
    userDeclinedCall = true;
    window.__sosIncomingCallActive = false;

    try {
      if (typeof App.initVoiceCall === 'function') {
        App.initVoiceCall({ force: true, lookbackSec: 120 });
      }
    } catch (_) {}

    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallDeclined === 'function') {
        bridge.markIncomingCallDeclined(peer);
      }
    } catch (_) {}

    closeIncomingCallNotification();
    closeCallDialog();
    stopRingtone();
    stopDialtone();

    let ok = false;
    try {
      if (App.voiceCall && typeof App.voiceCall.rejectIncoming === 'function' && peer) {
        ok = await App.voiceCall.rejectIncoming(peer);
      } else if (App.voiceCall) {
        // fallback: קיבוע peer ואז end
        try {
          const st = App.voiceCall.getState && App.voiceCall.getState();
          if (st) st.currentPeer = peer;
        } catch (_) {}
        await App.voiceCall.end();
        ok = true;
      }
    } catch (err) {
      console.warn('[APK] decline failed', err);
    }

    // ניסיונות נוספים אם pool עדיין לא מוכן | HYPER CORE TECH
    if (!ok && peer) {
      let tries = 0;
      const retry = async () => {
        tries += 1;
        try {
          if (typeof App.initVoiceCall === 'function') App.initVoiceCall({ force: true, lookbackSec: 120 });
          if (App.voiceCall && typeof App.voiceCall.rejectIncoming === 'function') {
            ok = await App.voiceCall.rejectIncoming(peer);
          }
        } catch (_) {}
        if (!ok && tries < 15) setTimeout(retry, 500);
        else window.__sosNativePendingDecline = null;
      };
      setTimeout(retry, 400);
    } else {
      window.__sosNativePendingDecline = null;
    }
    return true;
  };

  // חלק Deep Link (chat-voice-call-ui.js) – חזרה לשיחה נכנסת מלחיצה על התראת מערכת | HYPER CORE TECH
  App.resumeIncomingVoiceCallFromDeepLink = function resumeIncomingVoiceCallFromDeepLink(peerPubkey, pendingOfferDetail) {
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (incomingOfferPeer || '');
    window.__sosIncomingCallActive = true;
    restoreIncomingOffer(peer, pendingOfferDetail);
    // קודם מסך ענה – לא פותחים צ'אט שמסתיר את הדיאלוג | HYPER CORE TECH
    const target = incomingOfferPeer || peer;
    if (target) {
      saveChatPanelState();
      createCallDialog(target, true);
      resumeOnUserGestureOnce(() => playRingtone());
      try {
        if (typeof App.nativeStartCallRingtone === 'function') App.nativeStartCallRingtone();
      } catch (_) {}
      return true;
    }
    return false;
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

  function silenceTonePrimer() {
    if (!tonePrimerAudio) return;
    try { tonePrimerAudio.pause(); } catch {}
    try { tonePrimerAudio.currentTime = 0; } catch {}
    // נשאר muted – הפריים לא אמור להישמע אף פעם | HYPER CORE TECH
    try { tonePrimerAudio.muted = true; } catch {}
  }

  function primeToneAudioOnce() {
    if (toneAudioPrimed) return;
    // באפליקציית APK הצלילים מגיעים מ-CallSoundHelper – בלי priming HTML | HYPER CORE TECH
    if (typeof App.isNativeShell === 'function' && App.isNativeShell()) {
      toneAudioPrimed = true;
      return;
    }
    ensureToneAudioElements();

    try {
      tonePrimerAudio.muted = true;
      const p = tonePrimerAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          silenceTonePrimer();
          toneAudioPrimed = true;
        }).catch(() => {
          // AbortError מנגן וידאו/מדיה אחר – חובה לעצור בלי unmute | HYPER CORE TECH
          silenceTonePrimer();
        });
      } else {
        silenceTonePrimer();
        toneAudioPrimed = true;
      }
    } catch {
      silenceTonePrimer();
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
    try {
      if (typeof App.nativeStopCallRingtone === 'function') App.nativeStopCallRingtone();
    } catch {}
    if (!ringtoneAudio) return;
    try { ringtoneAudio.pause(); } catch {}
    try { ringtoneAudio.currentTime = 0; } catch {}
  }

  function stopDialtone() {
    try {
      if (typeof App.nativeStopCallDialtone === 'function') App.nativeStopCallDialtone();
    } catch {}
    if (!dialtoneAudio) return;
    try { dialtoneAudio.pause(); } catch {}
    try { dialtoneAudio.currentTime = 0; } catch {}
  }

  function playRingtone() {
    stopDialtone();
    // באפליקציה המקורית – צלצול מה-APK (לא תלוי ברשת)
    if (typeof App.isNativeShell === 'function' && App.isNativeShell() && typeof App.nativeStartCallRingtone === 'function') {
      if (App.nativeStartCallRingtone()) return;
    }
    ensureToneAudioElements();
    if (ringtoneAudio && !ringtoneAudio.paused) return;
    try { ringtoneAudio.currentTime = 0; } catch {}
    try {
      const p = ringtoneAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function playDialtone() {
    stopRingtone();
    if (typeof App.isNativeShell === 'function' && App.isNativeShell() && typeof App.nativeStartCallDialtone === 'function') {
      if (App.nativeStartCallDialtone()) return;
    }
    ensureToneAudioElements();
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
    // priming רק בלחיצת שיחה / שיחה נכנסת – לא על כל מחווה בדף (מונע צלצול ב-compose) | HYPER CORE TECH
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
