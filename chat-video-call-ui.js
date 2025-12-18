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

  // חלק שיחות וידאו (chat-video-call-ui.js) – מנגנון צלילים
  let audioCtx = null;
  let toneInterval = null;
  let activeOscillators = [];

  // חלק שיחות וידאו (chat-video-call-ui.js) – טוקן/ביטול טריגר צלילים כדי למנוע צלצול מאוחר אחרי סגירת שיחה | HYPER CORE TECH
  let toneSessionId = 0;
  let pendingGestureHandler = null;

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

  function scheduleToneOnGesture(sessionId, playFn) {
    resumeOnUserGestureOnce(() => {
      if (sessionId !== toneSessionId) return;
      playFn();
    }, sessionId);
  }

  function startToneWithPolicy(playFn) {
    invalidateToneSession();
    const sessionId = toneSessionId;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'running') {
        playFn();
        return;
      }
      const p = ctx.resume();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (sessionId !== toneSessionId) return;
          playFn();
        }).catch(() => {
          if (sessionId !== toneSessionId) return;
          scheduleToneOnGesture(sessionId, playFn);
        });
        return;
      }
    } catch {}
    scheduleToneOnGesture(sessionId, playFn);
  }

  // חלק שיחות וידאו – פורמט זמן קצר
  function fmt(ms){ const s = Math.floor(ms/1000); const m = Math.floor(s/60); const ss = s%60; return `${m}:${String(ss).padStart(2,'0')}`; }

  // חלק שיחות וידאו (chat-video-call-ui.js) – אתחול AudioContext
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
      if (ctx.state === 'suspended') ctx.resume();
    } catch {}
  }

  function resumeOnUserGestureOnce(next) {
    clearPendingGestureHandler();
    const sessionId = toneSessionId;
    const handler = () => {
      clearPendingGestureHandler();
      if (sessionId !== toneSessionId) return;
      resumeAudioIfNeeded();
      try { next && next(); } catch {}
    };
    pendingGestureHandler = handler;
    doc.addEventListener('pointerdown', handler, true);
    doc.addEventListener('click', handler, true);
    doc.addEventListener('touchstart', handler, true);
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – עצירת כל הצלילים
  function stopAllTones(opts) {
    const keepInterval = !!(opts && opts.keepInterval);
    if (!keepInterval && toneInterval) { clearInterval(toneInterval); toneInterval = null; }
    activeOscillators.forEach(({ osc, gain }) => {
      try { gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05); } catch {}
      try { osc.stop(); } catch {}
    });
    activeOscillators = [];
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – צלצול נכנס (2s on / 4s off)
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
      setTimeout(() => { stopAllTones({ keepInterval: true }); }, 2000);
    };
    playBurst();
    toneInterval = setInterval(playBurst, 4000);
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – טון חיוג יוצא (425Hz, 0.4s on / 0.2s off)
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
      setTimeout(() => { stopAllTones({ keepInterval: true }); }, patternOn);
    };
    startPulse();
    toneInterval = setInterval(startPulse, patternOn + patternOff);
  }

  function stopRingtone() { stopAllTones(); }
  function stopDialtone() { stopAllTones(); }

  // חלק שיחות וידאו – יצירת דיאלוג
  function createDialog(peer, isIncoming){
    if (dialog) dialog.remove();
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
          <div class="video-call-dialog__incomingfx" ${isIncoming ? '' : 'hidden'}>
            <div class="video-call-dialog__incomingfx-text">
              <div class="video-call-dialog__incomingfx-title">שיחת וידאו נכנסת</div>
              <div class="video-call-dialog__incomingfx-sub">מאתחל קישור מוצפן...</div>
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
            ${isIncoming? '<button class="vbtn vbtn--accept" data-action="accept"><i class="fa-solid fa-video"></i><span>קבל</span></button>' : ''}
            <button class="vbtn vbtn--mute" data-action="mute" hidden><i class="fa-solid fa-microphone"></i><span>השתק</span></button>
            <button class="vbtn vbtn--camera" data-action="camera" hidden><i class="fa-solid fa-camera"></i><span>מצלמה</span></button>
            <button class="vbtn vbtn--flip" data-action="flip" hidden><i class="fa-solid fa-camera-rotate"></i><span>החלף</span></button>
            <button class="vbtn vbtn--end" data-action="end"><i class="fa-solid fa-phone-slash"></i><span>נתק</span></button>
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
    if (end) end.addEventListener('click', handleEnd);
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
  function closeDialog(){ stopTimer(); invalidateToneSession(); stopAllTones(); App.__videoIncomingOffer = null; userDeclinedVideoCall = false; if (dialog) { dialog.remove(); dialog=null; } remoteVideo=null; localVideo=null; timerEl=null; }

  // חלק שיחות וידאו – פעולות כפתורים
  async function handleStart(peer){ try { startToneWithPolicy(playDialtone); await App.videoCall.start(peer); } catch(e){ console.error(e); alert(e.message||'שגיאת וידאו'); closeDialog(); } }
  async function handleAccept(peer){
    try {
      stopRingtone();
      invalidateToneSession();
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
    try {
      const st = App.videoCall?.getState && App.videoCall.getState();
      shouldMarkDeclined = !!(App.__videoIncomingOffer && st?.isIncoming && !st?.isActive);
    } catch {}
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
  App.onVideoCallIncoming = function(peer, offer){ App.__videoIncomingOffer = offer; createDialog(peer, true); startToneWithPolicy(playRingtone); };
  App.onVideoCallStarted = function(peer, isIncoming){
    if (!dialog) createDialog(peer, isIncoming);
    setStatus(isIncoming? 'מתחבר...' : 'מחייג וידאו...');
    // חלק שיחות וידאו (chat-video-call-ui.js) – הסתרת רקע אנימציה כשמתחילים שיחה (יש כבר וידאו מקומי/חיבור) | HYPER CORE TECH
    try {
      const fx = dialog && dialog.querySelector('.video-call-dialog__incomingfx');
      if (fx) fx.setAttribute('hidden', '');
    } catch {}
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
      }
    } catch {}
  };
  App.onVideoCallConnected = function(peer){ stopDialtone(); stopRingtone(); invalidateToneSession(); setStatus('מחובר'); showControls(); startTimer(); };
  App.onVideoCallRemoteStream = function(stream){ if (!remoteVideo) return; remoteVideo.srcObject = stream; showRemoteWhenReady(); };
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
  App.onVideoCallEnded = function(){ closeDialog(); };

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
        btn.innerHTML = '<i class="fa-solid fa-video"></i>';
        actions.insertBefore(btn, actions.firstChild);
      }
      const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
      newBtn.addEventListener('click', (e)=>{
        e.preventDefault(); e.stopPropagation();
        const peer = typeof App.getActiveChatContact === 'function' ? App.getActiveChatContact() : null;
        if (!peer){ alert('אנא בחר שיחה תחילה'); return; }
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
  Object.assign(App, { startVideoCall: (peer)=>{ createDialog(peer,false); handleStart(peer); }, endVideoCall: handleEnd });
})(window);
