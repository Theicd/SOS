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
      try { gain.gain.setValueAtTime(gain.gain.value, audioCtx.currentTime); } catch {}
      try { gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05); } catch {}
      try { osc.stop(audioCtx.currentTime + 0.06); } catch {}
    });
    activeOscillators = [];
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – צלצול נכנס: SOS במורס עם reverb
  function playRingtone() {
    const ctx = ensureAudioCtx();
    stopAllTones();
    console.log('Starting SOS ringtone with reverb...');
    
    // יצירת convolver ל-reverb (דמוי impulse response)
    const convolver = ctx.createConvolver();
    const reverbLength = ctx.sampleRate * 2;
    const reverbBuffer = ctx.createBuffer(2, reverbLength, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = reverbBuffer.getChannelData(ch);
      for (let i = 0; i < reverbLength; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / reverbLength, 2.5);
      }
    }
    convolver.buffer = reverbBuffer;
    convolver.connect(ctx.destination);
    
    // קוד מורס SOS: ··· --- ···
    const freq = 850;
    const dotDur = 0.12;
    const dashDur = 0.35;
    const gap = 0.1;
    const letterGap = 0.35;
    
    const playMorseSequence = () => {
      let t = ctx.currentTime + 0.05;
      
      const playTone = (dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();
        
        osc.frequency.value = freq;
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(dryGain);
        gain.connect(wetGain);
        dryGain.connect(ctx.destination);
        wetGain.connect(convolver);
        
        dryGain.gain.value = 0.25;
        wetGain.gain.value = 0.15;
        
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(1, t + 0.015);
        gain.gain.setValueAtTime(1, t + dur - 0.015);
        gain.gain.linearRampToValueAtTime(0, t + dur);
        osc.start(t);
        osc.stop(t + dur + 0.02);
        t += dur + gap;
      };
      
      // S: ···
      for (let i = 0; i < 3; i++) playTone(dotDur);
      t += letterGap - gap;
      
      // O: ---
      for (let i = 0; i < 3; i++) playTone(dashDur);
      t += letterGap - gap;
      
      // S: ···
      for (let i = 0; i < 3; i++) playTone(dotDur);
    };
    
    playMorseSequence();
    toneInterval = setInterval(playMorseSequence, 3500);
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – טון חיוג יוצא: סונאר אונייה
  function playDialtone() {
    const ctx = ensureAudioCtx();
    stopAllTones();
    console.log('Starting sonar ping...');
    
    const playSonarPing = () => {
      const now = ctx.currentTime;
      
      // פינג ראשי - גבוה לנמוך
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(1200, now);
      osc1.frequency.exponentialRampToValueAtTime(400, now + 0.15);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.35, now + 0.01);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.start(now);
      osc1.stop(now + 0.16);
      
      // אקו 1 - חלש יותר
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1200, now + 0.25);
      osc2.frequency.exponentialRampToValueAtTime(400, now + 0.35);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      gain2.gain.setValueAtTime(0, now + 0.25);
      gain2.gain.linearRampToValueAtTime(0.15, now + 0.26);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc2.start(now + 0.25);
      osc2.stop(now + 0.36);
      
      // אקו 2 - עוד יותר חלש
      const osc3 = ctx.createOscillator();
      const gain3 = ctx.createGain();
      osc3.type = 'sine';
      osc3.frequency.setValueAtTime(1200, now + 0.45);
      osc3.frequency.exponentialRampToValueAtTime(400, now + 0.52);
      osc3.connect(gain3);
      gain3.connect(ctx.destination);
      gain3.gain.setValueAtTime(0, now + 0.45);
      gain3.gain.linearRampToValueAtTime(0.08, now + 0.46);
      gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
      osc3.start(now + 0.45);
      osc3.stop(now + 0.53);
    };
    
    playSonarPing();
    toneInterval = setInterval(playSonarPing, 1800);
  }

  function stopRingtone() { stopAllTones(); }
  function stopDialtone() { stopAllTones(); }

  // חלק שיחות וידאו (chat-video-call-ui.js) – פיפ קצר לחיצוץ
  function playClickBeep() {
    try {
      const ctx = ensureAudioCtx();
      resumeAudioIfNeeded();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch(e) { console.warn('Click beep failed', e); }
  }

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
  async function handleStart(peer){ 
    try { 
      resumeAudioIfNeeded();
      // דיליי של שנייה לפני תחילת הסונאר
      setTimeout(() => playDialtone(), 1000);
      await App.videoCall.start(peer); 
    } catch(e){ 
      console.error(e); 
      alert(e.message||'שגיאת וידאו'); 
      closeDialog(); 
    } 
  }
  async function handleAccept(peer){ try { stopRingtone(); const offer = App.__videoIncomingOffer || null; if (!offer) { alert('הצעת וידאו חסרה'); return; } await App.videoCall.accept(peer, offer); setStatus('מתחבר...'); } catch(e){ console.error(e); alert(e.message||'שגיאה בקבלת וידאו'); closeDialog(); } }
  function handleEnd(){ if (App.videoCall) App.videoCall.end(); closeDialog(); }
  function handleMute(){ const m = App.videoCall.toggleMute(); const btn = dialog && dialog.querySelector('[data-action="mute"]'); if (btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(m){ i.className='fa-solid fa-microphone-slash'; t.textContent='בטל השתקה'; } else { i.className='fa-solid fa-microphone'; t.textContent='השתק'; } } }
  async function handleCamera(){ const off = await App.videoCall.toggleCamera(); const btn = dialog && dialog.querySelector('[data-action="camera"]'); if(btn){ const i = btn.querySelector('i'); const t = btn.querySelector('span'); if(off){ i.className='fa-solid fa-video-slash'; t.textContent='הפעל מצלמה'; } else { i.className='fa-solid fa-camera'; t.textContent='כבה מצלמה'; } } }
  async function handleFlip(){ try { await App.videoCall.switchCamera(); } catch(e){ console.warn('flip failed', e); } }

  // חלק שיחות וידאו – callbacks מהמנוע
  App.onVideoCallIncoming = function(peer, offer){ 
    App.__videoIncomingOffer = offer; 
    createDialog(peer, true); 
    // ניסיון להתחיל מייד
    resumeAudioIfNeeded();
    playRingtone();
    // fallback: אם לא עובד, נסה שוב אחרי לחיצה
    const tryAgain = () => {
      resumeAudioIfNeeded();
      if (!toneInterval) playRingtone();
      doc.removeEventListener('pointerdown', tryAgain, true);
      doc.removeEventListener('touchstart', tryAgain, true);
    };
    doc.addEventListener('pointerdown', tryAgain, { once: true, capture: true });
    doc.addEventListener('touchstart', tryAgain, { once: true, capture: true });
  };
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
        btn.innerHTML='<i class="fa-solid fa-video"></i>'; 
        actions.appendChild(btn);
      }
      btn.onclick = ()=>{ playClickBeep(); const peer = App.chatState?.currentPeer; if (peer && App.videoCall) App.startVideoCall(peer); };
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
