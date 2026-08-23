// חלק שיחות וידאו (chat-video-call-ui.js) – UI לשיחות וידאו בסגנון וואטסאפ
(function initChatVideoCallUI(window){
  // שייך: שכבת UI לוידאו – דיאלוג, כפתורים, חיבור ל-App.videoCall
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  let dialog = null;
  let remoteVideo = null;
  let localVideo = null;
  let timerEl = null;
  let timerId = null;

  // חלק שיחות וידאו (chat-video-call-ui.js) – דגל: דחייה ידנית של שיחה נכנסת כדי למנוע רישום missed | HYPER CORE TECH
  let userDeclinedVideoCall = false;

  // חלק שיחות וידאו (chat-video-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה כדי להחזיר אותו בסיום | HYPER CORE TECH
  let chatPanelWasOpen = false;
  let chatActiveContactBeforeCall = null;

  // חלק שיחות וידאו (chat-video-call-ui.js) – מצב תצוגה: מציגים מקומי במסך מלא עד שמגיע וידאו מרוחק | HYPER CORE TECH
  function setLocalOnlyMode(enabled) {
    if (!dialog) return;
    if (enabled) {
      dialog.classList.add('video-call-dialog--local-only');
    } else {
      dialog.classList.remove('video-call-dialog--local-only');
    }
  }

  function showRemoteWhenReady() {
    if (!dialog || !remoteVideo) return;
    try {
      if (remoteVideo.readyState >= 2) {
        setLocalOnlyMode(false);
        return;
      }
    } catch {}
    const onReady = () => setLocalOnlyMode(false);
    try { remoteVideo.addEventListener('playing', onReady, { once: true }); } catch {}
    try { remoteVideo.addEventListener('loadeddata', onReady, { once: true }); } catch {}
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – קבצי צלילי שיחה (MP3) כמו בשיחות קוליות | HYPER CORE TECH
  const DIALTONE_MP3_URL = 'https://npub1hwja2gw0m3kmehwp22rtfu7larrt8tnx4lyqhxp4nzu7jxzzj3wqwl9uc9.blossom.band/61924ef011f5b03e4ec49f0f9c9ac32361419607bd5c52f879bc8d0dd4938107.mp3';
  const RINGTONE_MP3_URL = 'https://npub1hwja2gw0m3kmehwp22rtfu7larrt8tnx4lyqhxp4nzu7jxzzj3wqwl9uc9.blossom.band/2c9aa92402a15e51f2a9dc542f5ce6a7c11e36065eb223f343e0d0bfe07de34d.mp3';
  // חלק שיחות וידאו (chat-video-call-ui.js) – אובייקטי אודיו לצלילים | HYPER CORE TECH
  let dialtoneAudio = null;
  let ringtoneAudio = null;
  let toneAudioPrimed = false;

  // חלק שיחות וידאו (chat-video-call-ui.js) – טוקן/ביטול טריגר צלילים כדי למנוע צלצול מאוחר אחרי סגירת שיחה | HYPER CORE TECH
  let toneSessionId = 0;
  let pendingGestureHandler = null;

  // חלק שיחות וידאו (chat-video-call-ui.js) – התראות מערכת כמו בשיחות קוליות | HYPER CORE TECH
  let incomingVideoNotification = null;

  // חלק שיחות וידאו (chat-video-call-ui.js) – Service Worker והתראות למצב ברקע | HYPER CORE TECH
  function registerVideoCallServiceWorkerIfSupported() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    try {
      const p = navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function getVideoCallServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!window.isSecureContext) return Promise.resolve(null);
    try {
      return navigator.serviceWorker.getRegistration().catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function requestVideoNotificationPermissionIfNeeded() {
    if (!('Notification' in window)) return;
    registerVideoCallServiceWorkerIfSupported();
    try {
      if (window.Notification.permission !== 'default') return;
      if (typeof window.Notification.requestPermission === 'function') {
        const p = window.Notification.requestPermission();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {}
  }

  function closeIncomingVideoNotification() {
    if (incomingVideoNotification) {
      try { incomingVideoNotification.close(); } catch {}
      incomingVideoNotification = null;
    }
    getVideoCallServiceWorkerRegistration().then((reg) => {
      if (!reg || typeof reg.getNotifications !== 'function') return;
      return reg.getNotifications({ tag: 'video-call-incoming' }).then((items) => {
        (items || []).forEach((n) => {
          try { n.close(); } catch {}
        });
      }).catch(() => {});
    }).catch(() => {});
  }

  function showIncomingVideoNotification(peerPubkey) {
    try {
      if (!('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;

      const isHidden = !!doc.hidden || doc.visibilityState === 'hidden';
      const hasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
      if (!isHidden && hasFocus) return;

      closeIncomingVideoNotification();
      registerVideoCallServiceWorkerIfSupported();

      const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
      const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
      const picture = contact?.picture || '';

      const baseOptions = {
        body: name,
        tag: 'video-call-incoming',
        renotify: true
      };
      if (picture) baseOptions.icon = picture;
      try { baseOptions.requireInteraction = true; } catch {}

      const openUrl = `${window.location.origin}/videos.html?chat=${encodeURIComponent(peerPubkey)}&incomingCall=video`;
      const swOptions = Object.assign({}, baseOptions, {
        actions: [
          { action: 'open', title: 'ענה / פתח וידאו' }
        ],
        data: {
          type: 'video-call-incoming',
          peerPubkey: peerPubkey,
          incomingCall: 'video',
          url: openUrl
        }
      });

      getVideoCallServiceWorkerRegistration().then((reg) => {
        if (reg && typeof reg.showNotification === 'function') {
          try {
            const p = reg.showNotification('שיחת וידאו נכנסת', swOptions);
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }

        incomingVideoNotification = new window.Notification('שיחת וידאו נכנסת', baseOptions);
        incomingVideoNotification.onclick = () => {
          try { window.focus(); } catch {}
          closeIncomingVideoNotification();
          if (typeof App.resumeIncomingVideoCallFromDeepLink === 'function') {
            App.resumeIncomingVideoCallFromDeepLink(peerPubkey);
          } else if (!dialog) {
            createDialog(peerPubkey, true);
          }
        };
      }).catch(() => {
        try {
          incomingVideoNotification = new window.Notification('שיחת וידאו נכנסת', baseOptions);
          incomingVideoNotification.onclick = () => {
            try { window.focus(); } catch {}
            closeIncomingVideoNotification();
            if (typeof App.resumeIncomingVideoCallFromDeepLink === 'function') {
              App.resumeIncomingVideoCallFromDeepLink(peerPubkey);
            } else if (!dialog) {
              createDialog(peerPubkey, true);
            }
          };
        } catch {}
      });
    } catch (err) {
      console.warn('Failed to show incoming video call notification', err);
    }
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – קבלת פעולה מהתראת Service Worker (פתיחת מסך וידאו) | HYPER CORE TECH
  function handleVideoCallServiceWorkerMessage(event) {
    const data = event && event.data ? event.data : null;
    if (!data) return;
    if (data.type !== 'video-call-notification-action' && !(data.type === 'sos-deeplink' && data.incomingCall === 'video')) {
      return;
    }

    const peerPubkey = data.peerPubkey || data.chat || App.__videoIncomingPeer || null;
    if (!peerPubkey) return;

    closeIncomingVideoNotification();
    try { window.focus(); } catch {}
    if (typeof App.resumeIncomingVideoCallFromDeepLink === 'function') {
      App.resumeIncomingVideoCallFromDeepLink(peerPubkey);
      return;
    }
    if (!dialog) {
      createDialog(peerPubkey, true);
    }
  }

  function initVideoCallServiceWorkerMessageHandling() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.addEventListener('message', handleVideoCallServiceWorkerMessage);
    } catch {}
  }

  function clearPendingGestureHandler() {
    if (!pendingGestureHandler) return;
    doc.removeEventListener('pointerdown', pendingGestureHandler, true);
    doc.removeEventListener('click', pendingGestureHandler, true);
    doc.removeEventListener('touchstart', pendingGestureHandler, true);
    pendingGestureHandler = null;
  }

  function invalidateToneSession() {
    toneSessionId += 1;
    clearPendingGestureHandler();
  }

  // חלק שיחות וידאו – פורמט זמן קצר
  function fmt(ms){ const s = Math.floor(ms/1000); const m = Math.floor(s/60); const ss = s%60; return `${m}:${String(ss).padStart(2,'0')}`; }

  // חלק שיחות וידאו (chat-video-call-ui.js) – יצירת אלמנטי אודיו לצלילים (MP3) | HYPER CORE TECH
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
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – priming לאודיו כדי לעקוף מדיניות autoplay | HYPER CORE TECH
  function silenceDialtonePrime() {
    if (!dialtoneAudio) return;
    try { dialtoneAudio.pause(); } catch {}
    try { dialtoneAudio.currentTime = 0; } catch {}
  }

  function primeToneAudioOnce() {
    if (toneAudioPrimed) return;
    // באפליקציית APK – CallSoundHelper, בלי priming HTML | HYPER CORE TECH
    if (typeof App.isNativeShell === 'function' && App.isNativeShell()) {
      toneAudioPrimed = true;
      return;
    }
    ensureToneAudioElements();
    try {
      dialtoneAudio.muted = true;
      const p = dialtoneAudio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          silenceDialtonePrime();
          try { dialtoneAudio.muted = false; } catch {}
          toneAudioPrimed = true;
        }).catch(() => {
          // AbortError מנגן מדיה אחרת – עוצרים בלי להשאיר נגינה בקול | HYPER CORE TECH
          silenceDialtonePrime();
          try { dialtoneAudio.muted = false; } catch {}
        });
      } else {
        silenceDialtonePrime();
        try { dialtoneAudio.muted = false; } catch {}
        toneAudioPrimed = true;
      }
    } catch {
      silenceDialtonePrime();
      try { dialtoneAudio.muted = false; } catch {}
    }
  }

  function resumeOnUserGestureOnce(next) {
    if (toneAudioPrimed) {
      try { next && next(); } catch {}
      return;
    }
    clearPendingGestureHandler();
    const sessionId = toneSessionId;
    const handler = () => {
      clearPendingGestureHandler();
      if (sessionId !== toneSessionId) return;
      primeToneAudioOnce();
      try { next && next(); } catch {}
    };
    pendingGestureHandler = handler;
    doc.addEventListener('pointerdown', handler, true);
    doc.addEventListener('click', handler, true);
    doc.addEventListener('touchstart', handler, true);
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – עצירת צלצול (MP3) | HYPER CORE TECH
  function stopRingtone() {
    try {
      if (typeof App.nativeStopCallRingtone === 'function') App.nativeStopCallRingtone();
    } catch {}
    if (!ringtoneAudio) return;
    try { ringtoneAudio.pause(); } catch {}
    try { ringtoneAudio.currentTime = 0; } catch {}
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – עצירת טון חיוג (MP3) | HYPER CORE TECH
  function stopDialtone() {
    try {
      if (typeof App.nativeStopCallDialtone === 'function') App.nativeStopCallDialtone();
    } catch {}
    if (!dialtoneAudio) return;
    try { dialtoneAudio.pause(); } catch {}
    try { dialtoneAudio.currentTime = 0; } catch {}
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – ניגון צלצול נכנס (MP3) | HYPER CORE TECH
  function playRingtone() {
    stopDialtone();
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

  // חלק שיחות וידאו (chat-video-call-ui.js) – ניגון טון חיוג יוצא (MP3) | HYPER CORE TECH
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

  // חלק שיחות וידאו (chat-video-call-ui.js) – התחלת צליל עם מדיניות autoplay | HYPER CORE TECH
  function startToneWithPolicy(playFn) {
    invalidateToneSession();
    const sessionId = toneSessionId;
    ensureToneAudioElements();
    if (toneAudioPrimed) {
      playFn();
      return;
    }
    // ניסיון ישיר
    try {
      playFn();
      toneAudioPrimed = true;
      return;
    } catch {}
    // אם נכשל, ממתינים למחווה
    resumeOnUserGestureOnce(() => {
      if (sessionId !== toneSessionId) return;
      playFn();
    });
  }

  // חלק שיחות וידאו – יצירת דיאלוג
  function createDialog(peer, isIncoming){
    if (dialog) dialog.remove();
    try {
      doc.body.classList.add('sos-call-active');
      window.__sosIncomingCallActive = true;
    } catch (_) {}
    // חלק שיחות וידאו (chat-video-call-ui.js) – שליפת פרטי איש קשר כמו בשיחת קול
    const contact = App.chatState?.contacts?.get(peer.toLowerCase());
    const name = contact?.name || `משתמש ${peer.slice(0, 8)}`;
    const initials = contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(name) : 'מש');
    const picture = contact?.picture || '';
    dialog = doc.createElement('div');
    dialog.className = 'video-call-dialog';
    dialog.innerHTML = `
      <div class="video-call-dialog__backdrop"></div>
      <div class="video-call-dialog__content">
        <div class="video-call-dialog__videos">
          <div class="video-call-dialog__incomingfx">
            <div class="video-call-dialog__incomingfx-text">
              <div class="video-call-dialog__incomingfx-title">${isIncoming ? 'שיחת וידאו נכנסת' : 'מתחיל שיחת וידאו'}</div>
              <div class="video-call-dialog__incomingfx-sub">${isIncoming ? 'לחץ קבל כדי להתחבר' : 'ממתין לתשובה...'}</div>
            </div>
          </div>
          <video id="videoRemote" class="video-remote" autoplay playsinline></video>
          <video id="videoLocal" class="video-local" autoplay muted playsinline></video>
        </div>
        <div class="video-call-dialog__hud">
          <div class="video-call-dialog__status" style="display:flex; align-items:center; gap:10px;">
            <div class="video-call-dialog__avatar" style="width:40px;height:40px;border-radius:999px;background:#243042;color:#fff;display:grid;place-items:center;overflow:hidden;flex:0 0 auto;">
              ${picture ? `<img src="${picture}" alt="${name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.remove();">` : `<span style="font-weight:700;">${initials}</span>`}
            </div>
            <div style="display:flex;flex-direction:column;">
              <span class="video-call-dialog__name">${name}</span>
              <span class="video-call-dialog__label">${isIncoming? 'שיחת וידאו נכנסת...' : 'מחייג וידאו...'}</span>
            </div>
            <span class="video-call-dialog__timer" hidden style="margin-inline-start:auto;">0:00</span>
          </div>
          <div class="video-call-dialog__actions">
            ${isIncoming? '<button class="vbtn vbtn--accept" data-action="accept"><i class="fa-solid fa-video"></i><span>ענה</span></button>' : ''}
            <button class="vbtn vbtn--mute" data-action="mute"><i class="fa-solid fa-microphone"></i><span>השתק</span></button>
            <button class="vbtn vbtn--camera" data-action="camera"><i class="fa-solid fa-camera"></i><span>מצלמה</span></button>
            <button class="vbtn vbtn--flip" data-action="flip"><i class="fa-solid fa-camera-rotate"></i><span>החלף</span></button>
            <button class="vbtn vbtn--end" data-action="end"><i class="fa-solid fa-phone-slash"></i><span>${isIncoming ? 'דחה' : 'נתק'}</span></button>
          </div>
        </div>
      </div>`;
    doc.body.appendChild(dialog);
    remoteVideo = dialog.querySelector('#videoRemote');
    localVideo = dialog.querySelector('#videoLocal');
    timerEl = dialog.querySelector('.video-call-dialog__timer');

    // חלק שיחות וידאו (chat-video-call-ui.js) – ברירת מחדל: לא local-only עד שיש וידאו מקומי | HYPER CORE TECH
    setLocalOnlyMode(false);

    const acc = dialog.querySelector('[data-action="accept"]');
    const end = dialog.querySelector('[data-action="end"]');
    const mute = dialog.querySelector('[data-action="mute"]');
    const cam = dialog.querySelector('[data-action="camera"]');
    const flip = dialog.querySelector('[data-action="flip"]');

    if (acc) acc.addEventListener('click', ()=> handleAccept(peer));
    if (end) end.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleEnd();
    });
    if (mute) mute.addEventListener('click', handleMute);
    if (cam) cam.addEventListener('click', handleCamera);
    if (flip) flip.addEventListener('click', handleFlip);
  }

  // חלק שיחות וידאו – עדכון סטטוס
  function setStatus(text){ if (!dialog) return; const el = dialog.querySelector('.video-call-dialog__label'); if (el) el.textContent = text; }
  function showControls(){
    if (!dialog) return;
    // חלק שיחות וידאו (chat-video-call-ui.js) – לאחר התחלה/חיבור מסתירים את כפתור "קבל" כדי למנוע לחיצות כפולות | HYPER CORE TECH
    const acceptBtn = dialog.querySelector('[data-action="accept"]');
    if (acceptBtn) acceptBtn.setAttribute('hidden', '');
    ['mute','camera','flip'].forEach(a=>{ const b=dialog.querySelector(`[data-action="${a}"]`); if(b) b.removeAttribute('hidden'); });
  }
  function startTimer(){ if (!timerEl) return; timerEl.removeAttribute('hidden'); const start = Date.now(); if (timerId) clearInterval(timerId); timerId = setInterval(()=>{ timerEl.textContent = fmt(Date.now()-start); },1000); }
  function stopTimer(){ if (timerId) { clearInterval(timerId); timerId=null; } }
  // חלק שיחות וידאו (chat-video-call-ui.js) – הסתרת אנימציה incomingfx | HYPER CORE TECH
  function hideIncomingFx() {
    if (!dialog) return;
    try {
      const fx = dialog.querySelector('.video-call-dialog__incomingfx');
      if (fx) fx.setAttribute('hidden', '');
    } catch {}
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה | HYPER CORE TECH
  function saveChatPanelState() {
    const chatPanel = doc.getElementById('chatPanel');
    chatPanelWasOpen = chatPanel && !chatPanel.hasAttribute('hidden');
    chatActiveContactBeforeCall = App.chatState?.activeContact || (typeof App.getActiveChatContact === 'function' ? App.getActiveChatContact() : null);
    console.log('[VIDEO] Saved chat panel state:', { open: chatPanelWasOpen, contact: chatActiveContactBeforeCall?.slice?.(0, 8) });
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – החזרת מצב פאנל הצ'אט לאחר סיום השיחה | HYPER CORE TECH
  function restoreChatPanelState() {
    console.log('[VIDEO] restoreChatPanelState called:', { 
      chatPanelWasOpen, 
      contact: chatActiveContactBeforeCall?.slice?.(0, 8) 
    });

    if (!chatPanelWasOpen && !chatActiveContactBeforeCall) {
      console.log('[VIDEO] No chat state to restore');
      return;
    }

    setTimeout(() => {
      const chatPanel = doc.getElementById('chatPanel');
      console.log('[VIDEO] Restoring - chatPanel hidden?', chatPanel?.hasAttribute('hidden'));

      if (typeof App.toggleChatPanel === 'function') {
        App.toggleChatPanel(true);
      } else if (chatPanel) {
        chatPanel.removeAttribute('hidden');
        doc.body.classList.add('chat-overlay-open');
      }

      if (chatActiveContactBeforeCall && typeof App.showChatConversation === 'function') {
        console.log('[VIDEO] Showing conversation:', chatActiveContactBeforeCall.slice(0, 8));
        App.showChatConversation(chatActiveContactBeforeCall);
      }

      chatPanelWasOpen = false;
      chatActiveContactBeforeCall = null;
    }, 150);
  }

  function closeDialog(){
    stopTimer();
    invalidateToneSession();
    stopRingtone();
    stopDialtone();
    App.__videoIncomingOffer = null;
    App.__videoIncomingPeer = null;
    userDeclinedVideoCall = false;
    try {
      if (typeof App.nativeClearIncomingCallOffer === 'function') App.nativeClearIncomingCallOffer();
      sessionStorage.removeItem('sos_pending_video_offer');
    } catch (_) {}
    try {
      doc.body.classList.remove('sos-call-active');
      window.__sosIncomingCallActive = false;
    } catch (_) {}
    if (dialog) { dialog.remove(); dialog = null; }
    remoteVideo = null;
    localVideo = null;
    timerEl = null;
    restoreChatPanelState();
  }

  // חלק שיחות וידאו – פעולות כפתורים
  async function handleStart(peer){ try { startToneWithPolicy(playDialtone); await App.videoCall.start(peer); } catch(e){ console.error(e); alert(e.message||'שגיאת וידאו'); closeDialog(); } }
  async function handleAccept(peer){
    try {
      stopRingtone();
      invalidateToneSession();
      hideIncomingFx();
      // חלק שיחות וידאו (chat-video-call-ui.js) – נטרול כפתור קבלה מיידית כדי למנוע לחיצות כפולות | HYPER CORE TECH
      const acceptBtn = dialog && dialog.querySelector('[data-action="accept"]');
      if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.setAttribute('hidden', '');
      }
      const offer = App.__videoIncomingOffer || null;
      if (!offer) {
        alert('הצעת וידאו חסרה');
        closeDialog();
        return;
      }
      await App.videoCall.accept(peer, offer);
      App.__videoIncomingOffer = null;
      setStatus('מתחבר...');
    } catch(e){ console.error(e); alert(e.message||'שגיאה בקבלת וידאו'); closeDialog(); }
  }
  function handleEnd(){
    // חלק שיחות וידאו (chat-video-call-ui.js) – שמירת סימון דחייה ידנית גם אחרי closeDialog (שמאפס דגלים) | HYPER CORE TECH
    let shouldMarkDeclined = false;
    const peer = App.__videoIncomingPeer || '';
    try {
      const st = App.videoCall?.getState && App.videoCall.getState();
      shouldMarkDeclined = !!(App.__videoIncomingOffer && st?.isIncoming && !st?.isActive);
    } catch {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallDeclined === 'function') {
        bridge.markIncomingCallDeclined(peer);
      }
    } catch (_) {}
    closeDialog();
    if (shouldMarkDeclined) {
      userDeclinedVideoCall = true;
    }
    if (App.videoCall) App.videoCall.end();
  }
  function handleMute(){ const m = App.videoCall.toggleMute(); const btn = dialog && dialog.querySelector('[data-action="mute"]'); if (btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(m){ i.className='fa-solid fa-microphone-slash'; t.textContent='בטל השתקה'; } else { i.className='fa-solid fa-microphone'; t.textContent='השתק'; } } }
  async function handleCamera(){ const off = await App.videoCall.toggleCamera(); const btn = dialog && dialog.querySelector('[data-action="camera"]'); if(btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(off){ i.className='fa-solid fa-video-slash'; t.textContent='הפעל מצלמה'; } else { i.className='fa-solid fa-camera'; t.textContent='כבה מצלמה'; } } }
  async function handleFlip(){ try { await App.videoCall.switchCamera(); } catch(e){ console.warn('flip failed', e); } }

  // חלק שיחות וידאו – callbacks מהמנוע
  App.onVideoCallIncoming = function(peer, offer){
    const peerNorm = peer ? String(peer).toLowerCase() : '';
    try {
      const pendingDecline = window.__sosNativePendingDecline;
      if (pendingDecline && pendingDecline.peer === peerNorm && Date.now() < (pendingDecline.until || 0)) {
        App.__videoIncomingOffer = offer;
        App.__videoIncomingPeer = peerNorm;
        userDeclinedVideoCall = true;
        if (App.videoCall && typeof App.videoCall.rejectIncoming === 'function') {
          App.videoCall.rejectIncoming(peerNorm);
        } else if (App.videoCall) App.videoCall.end();
        window.__sosNativePendingDecline = null;
        return;
      }
    } catch (_) {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.isIncomingCallSuppressed === 'function') {
        if (bridge.isIncomingCallSuppressed(String(peer || ''))) {
          console.log('Incoming video suppressed by native (legacy)');
          return;
        }
      }
    } catch (_) {}
    App.__videoIncomingOffer = offer;
    App.__videoIncomingPeer = peerNorm;
    try {
      sessionStorage.setItem('sos_pending_video_offer', JSON.stringify({
        peer: App.__videoIncomingPeer, callType: 'video', offer, savedAt: Date.now()
      }));
      if (typeof App.nativeCacheIncomingCallOffer === 'function') {
        App.nativeCacheIncomingCallOffer(peer, 'video', offer);
      }
    } catch (_) {}
    try {
      const pendingAnswer = window.__sosNativePendingAnswer;
      if (pendingAnswer && pendingAnswer.peer === peerNorm && pendingAnswer.callType === 'video' && Date.now() < (pendingAnswer.until || 0)) {
        saveChatPanelState();
        if (typeof App.pauseAllFeedVideos === 'function') App.pauseAllFeedVideos();
        createDialog(peer, true);
        window.__sosNativePendingAnswer = null;
        setTimeout(() => handleAccept(peerNorm), 120);
        return;
      }
    } catch (_) {}
    saveChatPanelState();
    if (typeof App.pauseAllFeedVideos === 'function') {
      App.pauseAllFeedVideos();
    }
    createDialog(peer, true);
    showIncomingVideoNotification(peer);
    startToneWithPolicy(playRingtone);
    try {
      if (typeof App.nativeStartCallRingtone === 'function') App.nativeStartCallRingtone();
    } catch (_) {}
  };

  App.acceptIncomingVideoCallFromNative = function acceptIncomingVideoCallFromNative(peerPubkey) {
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (App.__videoIncomingPeer || '');
    if (!peer) return false;
    try {
      if (typeof App.initVideoCall === 'function') App.initVideoCall({ force: true, lookbackSec: 120 });
    } catch (_) {}
    window.__sosNativePendingAnswer = { peer, callType: 'video', until: Date.now() + 45000 };
    window.__sosNativePendingDecline = null;
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallAnswered === 'function') {
        bridge.markIncomingCallAnswered(peer);
      }
    } catch (_) {}
    if (!dialog) {
      saveChatPanelState();
      createDialog(peer, true);
    }
    let attempts = 0;
    const tryAccept = () => {
      attempts += 1;
      if (App.__videoIncomingOffer && App.__videoIncomingOffer.type && App.__videoIncomingOffer.sdp) {
        window.__sosNativePendingAnswer = null;
        handleAccept(peer);
        return;
      }
      if (attempts >= 50) {
        window.__sosNativePendingAnswer = null;
        return;
      }
      setTimeout(tryAccept, 400);
    };
    tryAccept();
    return true;
  };

  App.declineIncomingVideoCallFromNative = async function declineIncomingVideoCallFromNative(peerPubkey) {
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (App.__videoIncomingPeer || '');
    window.__sosNativePendingDecline = { peer, until: Date.now() + 45000 };
    window.__sosNativePendingAnswer = null;
    userDeclinedVideoCall = true;
    window.__sosIncomingCallActive = false;
    try {
      if (typeof App.initVideoCall === 'function') App.initVideoCall({ force: true, lookbackSec: 120 });
    } catch (_) {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallDeclined === 'function') {
        bridge.markIncomingCallDeclined(peer);
      }
    } catch (_) {}
    closeDialog();
    try {
      if (App.videoCall && typeof App.videoCall.rejectIncoming === 'function' && peer) {
        await App.videoCall.rejectIncoming(peer);
      } else if (App.videoCall) {
        await App.videoCall.end();
      }
    } catch (_) {}
    window.__sosNativePendingDecline = null;
    return true;
  };

  // חלק Deep Link (chat-video-call-ui.js) – חזרה לשיחת וידאו נכנסת מהתראת מערכת | HYPER CORE TECH
  App.resumeIncomingVideoCallFromDeepLink = function resumeIncomingVideoCallFromDeepLink(peerPubkey, pendingOfferDetail, opts) {
    const peer = peerPubkey ? String(peerPubkey).toLowerCase() : (App.__videoIncomingPeer || '');
    window.__sosIncomingCallActive = true;
    const restore = (parsed) => {
      if (!parsed) return false;
      try {
        const offerRaw = parsed.offer != null ? parsed.offer : parsed;
        const offer = typeof offerRaw === 'string' ? JSON.parse(offerRaw) : offerRaw;
        const p = String(parsed.peer || peer || '').toLowerCase();
        if (!offer?.type || !offer?.sdp) return false;
        App.__videoIncomingOffer = offer;
        App.__videoIncomingPeer = p || peer;
        return true;
      } catch (_) { return false; }
    };
    try {
      if (pendingOfferDetail) {
        restore(typeof pendingOfferDetail === 'string' ? JSON.parse(pendingOfferDetail) : pendingOfferDetail);
      }
    } catch (_) {}
    if (!App.__videoIncomingOffer) {
      try {
        if (typeof App.nativeGetIncomingCallOffer === 'function') restore(App.nativeGetIncomingCallOffer());
      } catch (_) {}
    }
    if (!App.__videoIncomingOffer) {
      try {
        const raw = sessionStorage.getItem('sos_pending_video_offer');
        if (raw) restore(JSON.parse(raw));
      } catch (_) {}
    }
    const target = App.__videoIncomingPeer || peer;
    if (!target) return false;
    const autoAnswering = !!(opts && opts.autoAnswering) || !!(
      window.__sosNativePendingAnswer &&
      window.__sosNativePendingAnswer.peer === String(target).toLowerCase()
    );
    // קודם מסך ענה – בלי לפתוח צ'אט מעליו | HYPER CORE TECH
    saveChatPanelState();
    createDialog(target, true);
    if (autoAnswering) {
      try {
        const acceptBtn = dialog && dialog.querySelector('[data-action="accept"]');
        if (acceptBtn) acceptBtn.setAttribute('hidden', '');
      } catch (_) {}
      try {
        if (typeof App.nativeStopCallRingtone === 'function') App.nativeStopCallRingtone();
      } catch (_) {}
    } else {
      startToneWithPolicy(playRingtone);
      try {
        if (typeof App.nativeStartCallRingtone === 'function') App.nativeStartCallRingtone();
      } catch (_) {}
    }
    return true;
  };
  App.onVideoCallStarted = function(peer, isIncoming){
    if (!dialog) createDialog(peer, isIncoming);
    setStatus(isIncoming? 'מתחבר...' : 'מחייג וידאו...');
    // חלק שיחות וידאו (chat-video-call-ui.js) – אם השיחה כבר התחילה, לא מציגים כפתור קבלה | HYPER CORE TECH
    try {
      const acceptBtn = dialog && dialog.querySelector('[data-action="accept"]');
      if (acceptBtn) acceptBtn.setAttribute('hidden', '');
    } catch {}
    // הצגת הווידאו המקומי אם כבר זמין
    try {
      const st = App.videoCall?.getState && App.videoCall.getState();
      if (st?.localStream && localVideo) {
        localVideo.srcObject = st.localStream;
        setLocalOnlyMode(true);
        // חלק שיחות וידאו (chat-video-call-ui.js) – בצד היוזם משאירים את ההודעה "מתחיל שיחת וידאו" עד שהצד השני עונה | HYPER CORE TECH
        if (isIncoming) {
          hideIncomingFx();
        }
      }
    } catch {}
  };
  App.onVideoCallConnected = function(peer){
    stopDialtone();
    stopRingtone();
    closeIncomingVideoNotification();
    invalidateToneSession();
    hideIncomingFx();
    setStatus('מחובר');
    showControls();
    startTimer();
  };
  App.onVideoCallRemoteStream = function(stream){ if (!remoteVideo) return; remoteVideo.srcObject = stream; hideIncomingFx(); showRemoteWhenReady(); };
  App.onVideoCallLocalStreamChanged = function(stream){
    if (!localVideo) return;
    localVideo.srcObject = stream;
    // חלק שיחות וידאו (chat-video-call-ui.js) – בהחלפת מצלמה לא מסתירים remote אם כבר קיים | HYPER CORE TECH
    if (!remoteVideo || !remoteVideo.srcObject) {
      setLocalOnlyMode(true);
    } else {
      showRemoteWhenReady();
    }
  };
  App.onVideoCallEnded = function(peerPubkey){
    closeIncomingVideoNotification();
    closeDialog();
    try {
      const bridge = window.SosNativeShell;
      const peer = String(peerPubkey || '');
      if (bridge && typeof bridge.markIncomingCallEnded === 'function') {
        bridge.markIncomingCallEnded(peer);
      } else if (bridge && typeof bridge.notifyNativeCallEnded === 'function') {
        bridge.notifyNativeCallEnded(peer);
      }
    } catch (_) {}
    try { window.__sosNativeInCallUi = false; } catch (_) {}
  };

  // חלק שיחות וידאו (chat-video-call-ui.js) – רישום שיחה שלא נענתה בהיסטוריית הצ'אט ועדכון מונה לא נקראו | HYPER CORE TECH
  App.onVideoCallMissed = function(peerPubkey) {
    if (userDeclinedVideoCall) {
      userDeclinedVideoCall = false;
      return;
    }

    if (!peerPubkey) return;
    console.log('Missed video call from', peerPubkey.slice(0, 8));

    const missedCallMessage = {
      id: 'missed-video-call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      from: peerPubkey,
      to: App.publicKey,
      content: '📹 שיחת וידאו שלא נענתה',
      createdAt: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
      direction: 'incoming',
      type: 'missed_call'
    };

    if (typeof App.appendChatMessage === 'function') {
      App.appendChatMessage(missedCallMessage);
    }
  };
  App.onVideoCallMuteToggle = function(){};
  App.onVideoCallCameraToggle = function(){};

  // חלק שיחות וידאו – הוספת כפתור מצלמה לכותרת שיחה
  function initVideoButton(){
    const tryInit = () => {
      const panel = doc.getElementById('chatPanel'); if (!panel) return setTimeout(tryInit, 500);
      const actions = panel.querySelector('.chat-conversation__actions'); if (!actions) return setTimeout(tryInit, 500);
      let btn = actions.querySelector('.chat-conversation__icon--video');
      if (!btn){
        btn = doc.createElement('button');
        btn.type='button'; btn.className='chat-conversation__icon chat-conversation__icon--video'; btn.setAttribute('aria-label','שיחת וידאו');
        btn.innerHTML = '<svg class="chat-header-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="7" width="12.5" height="10" rx="2"/><path d="M16 10.2 20.5 7.5v9L16 13.8z"/></svg>';
        actions.insertBefore(btn, actions.firstChild);
      }
      const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
      newBtn.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        const peer = typeof App.getActiveChatContact === 'function' ? App.getActiveChatContact() : null;
        if (!peer){ alert('אנא בחר שיחה תחילה'); return; }
        // חלק שיחות וידאו (chat-video-call-ui.js) – שמירת מצב פאנל הצ'אט לפני פתיחת שיחה יוצאת | HYPER CORE TECH
        saveChatPanelState();
        // חלק שיחות וידאו (chat-video-call-ui.js) – עצירת וידיאו ברקע כדי לא להפריע לשיחה יוצאת | HYPER CORE TECH
        if (typeof App.pauseAllFeedVideos === 'function') { App.pauseAllFeedVideos(); }
        createDialog(peer, false); handleStart(peer);
      });
      console.log('Video call button initialized');
    };
    tryInit();
  }

  // חלק שיחות וידאו – אתחול
  function init(){ initVideoButton(); console.log('Video call UI initialized'); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();

  // חשיפה מוגבלת
  Object.assign(App, { startVideoCall: (peer)=>{ saveChatPanelState(); if (typeof App.pauseAllFeedVideos === 'function') { App.pauseAllFeedVideos(); } createDialog(peer,false); handleStart(peer); }, endVideoCall: handleEnd });
})(window);
