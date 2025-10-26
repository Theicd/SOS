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
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => console.log('AudioContext resumed'));
      }
    } catch {}
  }

  // הפעלת audio אוטומטית עם ניסיון מיידי
  function tryAutoPlayAudio(callback) {
    resumeAudioIfNeeded();
    try {
      callback && callback();
    } catch (e) {
      console.warn('Auto-play blocked, waiting for gesture', e);
      const handler = () => {
        resumeAudioIfNeeded();
        try { callback && callback(); } catch {}
        doc.removeEventListener('pointerdown', handler, true);
        doc.removeEventListener('click', handler, true);
        doc.removeEventListener('touchstart', handler, true);
      };
      doc.addEventListener('pointerdown', handler, true);
      doc.addEventListener('click', handler, true);
      doc.addEventListener('touchstart', handler, true);
    }
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

  // חלק שיחות וידאו (chat-video-call-ui.js) – צלצול נכנס: SOS עם אפקט אקו
  function playRingtone() {
    const ctx = ensureAudioCtx();
    stopAllTones();
    console.log('playRingtone: Starting SOS with echo...');
    
    // יצירת delay לאפקט אקו
    const delay = ctx.createDelay(0.3);
    const feedback = ctx.createGain();
    const wetGain = ctx.createGain();
    delay.delayTime.value = 0.15;
    feedback.gain.value = 0.4;
    wetGain.gain.value = 0.5;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(ctx.destination);
    
    const freq = 850;
    const dotDur = 0.12;
    const dashDur = 0.35;
    const gap = 0.12;
    const letterGap = 0.35;
    
    let sosCount = 0;
    const playMorseSequence = () => {
      sosCount++;
      console.log(`SOS sequence #${sosCount} at ${ctx.currentTime.toFixed(2)}s`);
      let t = ctx.currentTime + 0.05;
      
      const createTone = (start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.connect(delay);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.01);
        gain.gain.setValueAtTime(0.35, start + duration - 0.02);
        gain.gain.linearRampToValueAtTime(0, start + duration);
        osc.start(start);
        osc.stop(start + duration + 0.01);
      };
      
      // S: ···
      for (let i = 0; i < 3; i++) {
        createTone(t, dotDur);
        t += dotDur + gap;
      }
      t += letterGap - gap;
      
      // O: ---
      for (let i = 0; i < 3; i++) {
        createTone(t, dashDur);
        t += dashDur + gap;
      }
      t += letterGap - gap;
      
      // S: ···
      for (let i = 0; i < 3; i++) {
        createTone(t, dotDur);
        t += dotDur + gap;
      }
    };
    
    playMorseSequence();
    toneInterval = setInterval(playMorseSequence, 3500);
  }

  // חלק שיחות וידאו (chat-video-call-ui.js) – טון חיוג יוצא: סונאר אונייה
  function playDialtone() {
    const ctx = ensureAudioCtx();
    stopAllTones();
    console.log('playDialtone: Starting sonar...');
    
    let pingCount = 0;
    const playSonarPing = () => {
      pingCount++;
      console.log(`Sonar ping #${pingCount} at ${ctx.currentTime.toFixed(2)}s`);
      const now = ctx.currentTime;
      
      // יצירת delay nodes לכל פינג (חייב להיות חדש בכל פעם)
      const delay1 = ctx.createDelay(1.0);
      const delay2 = ctx.createDelay(1.0);
      const delay3 = ctx.createDelay(1.0);
      
      const echo1Gain = ctx.createGain();
      const echo2Gain = ctx.createGain();
      const echo3Gain = ctx.createGain();
      
      delay1.delayTime.value = 0.25;
      delay2.delayTime.value = 0.5;
      delay3.delayTime.value = 0.75;
      
      echo1Gain.gain.value = 0.5;
      echo2Gain.gain.value = 0.3;
      echo3Gain.gain.value = 0.15;
      
      // חיבור שרשרת delay
      delay1.connect(echo1Gain);
      delay2.connect(echo2Gain);
      delay3.connect(echo3Gain);
      
      echo1Gain.connect(ctx.destination);
      echo2Gain.connect(ctx.destination);
      echo3Gain.connect(ctx.destination);
      
      // יצירת הצליל הראשי
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      // תדר יורד (אפקט דופלר של סונאר)
      osc.frequency.setValueAtTime(1400, now);
      osc.frequency.exponentialRampToValueAtTime(700, now + 0.2);
      osc.type = 'sine';
      
      osc.connect(gain);
      gain.connect(ctx.destination); // צליל ישיר
      gain.connect(delay1); // אקו 1
      delay1.connect(delay2); // אקו 2
      delay2.connect(delay3); // אקו 3
      
      // מעטפת הצליל
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.35, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      
      osc.start(now);
      osc.stop(now + 0.21);
    };
    
    playSonarPing();
    if (toneInterval) clearInterval(toneInterval);
    toneInterval = setInterval(playSonarPing, 1800);
    console.log('playDialtone: Interval set, will repeat every 1.8s');
  }

  function stopRingtone() { stopAllTones(); }
  function stopDialtone() { stopAllTones(); }

  // חלק שיחות וידאו (chat-video-call-ui.js) – צליל פידבק ללחיצה
  function playClickFeedback() {
    try {
      const ctx = ensureAudioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1200;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (e) {
      console.warn('Click feedback failed', e);
    }
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
      console.log('handleStart: starting video call to', peer.slice(0,8));
      playClickFeedback();
      await App.videoCall.start(peer);
      console.log('handleStart: call started, will play dialtone in 1s');
    } catch(e){ 
      console.error('handleStart error:', e); 
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
    console.log('onVideoCallIncoming from', peer.slice(0,8));
    App.__videoIncomingOffer = offer; 
    createDialog(peer, true);
    console.log('Starting ringtone for incoming call...');
    setTimeout(() => {
      tryAutoPlayAudio(() => {
        console.log('Playing ringtone now');
        playRingtone();
      });
    }, 100);
  };
  App.onVideoCallStarted = function(peer, isIncoming){
    console.log('onVideoCallStarted:', { peer: peer.slice(0,8), isIncoming });
    if (!dialog) createDialog(peer, isIncoming);
    setStatus(isIncoming? 'מתחבר...' : 'מחייג וידאו...');
    
    // הפעלת צלילים
    if (!isIncoming) {
      console.log('Starting dialtone for outgoing call...');
      setTimeout(() => {
        tryAutoPlayAudio(() => {
          console.log('Playing dialtone now');
          playDialtone();
        });
      }, 1000);
    }
    
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
