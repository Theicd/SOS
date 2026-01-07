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

  // חלק שיחות וידאו (chat-video-call-ui.js) – מנגנון צלילים
  let audioCtx = null;
  let toneInterval = null;
  let activeOscillators = [];

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

  // חלק שיחות וידאו (chat-video-call-ui.js) – עצירת כל הצלילים
  function stopAllTones() {
    if (toneInterval) { clearInterval(toneInterval); toneInterval = null; }
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
      setTimeout(() => { stopAllTones(); }, 2000);
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
      setTimeout(() => { stopAllTones(); }, patternOn);
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
  function showControls(){ if (!dialog) return; ['mute','camera','flip'].forEach(a=>{ const b=dialog.querySelector(`[data-action="${a}"]`); if(b) b.removeAttribute('hidden'); }); }
  function startTimer(){ if (!timerEl) return; timerEl.removeAttribute('hidden'); const start = Date.now(); if (timerId) clearInterval(timerId); timerId = setInterval(()=>{ timerEl.textContent = fmt(Date.now()-start); },1000); }
  function stopTimer(){ if (timerId) { clearInterval(timerId); timerId=null; } }
  function closeDialog(){ stopTimer(); stopAllTones(); if (dialog) { dialog.remove(); dialog=null; } remoteVideo=null; localVideo=null; timerEl=null; }

  // חלק שיחות וידאו – פעולות כפתורים
  async function handleStart(peer){ try { resumeOnUserGestureOnce(() => playDialtone()); await App.videoCall.start(peer); } catch(e){ console.error(e); alert(e.message||'שגיאת וידאו'); closeDialog(); } }
  async function handleAccept(peer){ try { stopRingtone(); const offer = App.__videoIncomingOffer || null; if (!offer) { alert('הצעת וידאו חסרה'); return; } await App.videoCall.accept(peer, offer); setStatus('מתחבר...'); } catch(e){ console.error(e); alert(e.message||'שגיאה בקבלת וידאו'); closeDialog(); } }
  function handleEnd(){ if (App.videoCall) App.videoCall.end(); closeDialog(); }
  function handleMute(){ const m = App.videoCall.toggleMute(); const btn = dialog && dialog.querySelector('[data-action="mute"]'); if (btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(m){ i.className='fa-solid fa-microphone-slash'; t.textContent='בטל השתקה'; } else { i.className='fa-solid fa-microphone'; t.textContent='השתק'; } } }
  async function handleCamera(){ const off = await App.videoCall.toggleCamera(); const btn = dialog && dialog.querySelector('[data-action="camera"]'); if(btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(off){ i.className='fa-solid fa-video-slash'; t.textContent='הפעל מצלמה'; } else { i.className='fa-solid fa-camera'; t.textContent='כבה מצלמה'; } } }
  async function handleFlip(){ try { await App.videoCall.switchCamera(); } catch(e){ console.warn('flip failed', e); } }

  // חלק שיחות וידאו – callbacks מהמנוע
  App.onVideoCallIncoming = function(peer, offer){ App.__videoIncomingOffer = offer; createDialog(peer, true); resumeOnUserGestureOnce(() => playRingtone()); };
  App.onVideoCallStarted = function(peer, isIncoming){
    if (!dialog) createDialog(peer, isIncoming);
    setStatus(isIncoming? 'מתחבר...' : 'מחייג וידאו...');
    // הצגת הווידאו המקומי אם כבר זמין
    try {
      const st = App.videoCall?.getState && App.videoCall.getState();
      if (st?.localStream && localVideo) localVideo.srcObject = st.localStream;
    } catch {}
  };
  App.onVideoCallConnected = function(peer){ stopDialtone(); stopRingtone(); setStatus('מחובר'); showControls(); startTimer(); };
  App.onVideoCallRemoteStream = function(stream){ if (!remoteVideo) return; remoteVideo.srcObject = stream; };
  App.onVideoCallLocalStreamChanged = function(stream){ if (!localVideo) return; localVideo.srcObject = stream; };
  App.onVideoCallEnded = function(){ closeDialog(); };
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
