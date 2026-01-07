(function initChatVoiceUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  // חלק קול (chat-voice-ui.js) – UI משופר לכפתור מיקרופון, הקלטה בסגנון וואטסאפ | HYPER CORE TECH
  // שייך למודול SOS2 צ'אט קול. ללא תלות חיצונית.

  if (App.initializeChatVoiceUI) return;

  function formatTime(sec){
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s/60);
    const r = String(s%60).padStart(2,'0');
    return `${m}:${r}`;
  }

  // חלק הקלטה (chat-voice-ui.js) – יצירת ממשק הקלטה בסגנון וואטסאפ | HYPER CORE TECH
  function createRecordingOverlay(){
    const overlay = doc.createElement('div');
    overlay.id = 'chatVoiceRecordingOverlay';
    overlay.className = 'chat-voice-recording';
    overlay.setAttribute('hidden', '');
    overlay.innerHTML = `
      <button type="button" class="chat-voice-recording__delete" aria-label="מחק הקלטה">
        <i class="fa-solid fa-trash"></i>
      </button>
      <div class="chat-voice-recording__waveform">
        <div class="chat-voice-recording__bars">
          <span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span><span></span>
        </div>
      </div>
      <span class="chat-voice-recording__timer">0:00</span>
      <button type="button" class="chat-voice-recording__send" aria-label="שלח הקלטה">
        <i class="fa-solid fa-paper-plane"></i>
      </button>
    `;
    return overlay;
  }

  function initializeChatVoiceUI(config){
    const getActivePeer = typeof config?.getActivePeer === 'function' ? config.getActivePeer : ()=>null;
    const composer = config?.composerElement || doc.getElementById('chatComposer');
    if(!composer) {
      setTimeout(()=>initializeChatVoiceUI(config), 500);
      return;
    }

    const inputEl = composer.querySelector('#chatMessageInput') || composer.querySelector('textarea');
    const sendBtn = composer.querySelector('.chat-composer__send, [type="submit"]');
    if (!sendBtn) {
      setTimeout(()=>initializeChatVoiceUI(config), 500);
      return;
    }

    // מניעת אתחול כפול
    if (sendBtn.dataset.voiceInitialized) return;
    sendBtn.dataset.voiceInitialized = 'true';

    // יצירת ממשק הקלטה
    const recordingOverlay = createRecordingOverlay();
    composer.appendChild(recordingOverlay);
    
    const timerEl = recordingOverlay.querySelector('.chat-voice-recording__timer');
    const deleteBtn = recordingOverlay.querySelector('.chat-voice-recording__delete');
    const sendRecordingBtn = recordingOverlay.querySelector('.chat-voice-recording__send');
    const bars = recordingOverlay.querySelectorAll('.chat-voice-recording__bars span');

    let isRecording = false;
    let tickHandle = null;
    let startedAt = 0;
    let animationHandle = null;

    // חלק אנימציה (chat-voice-ui.js) – אנימציית גלי קול בזמן הקלטה | HYPER CORE TECH
    function animateBars(){
      bars.forEach((bar, i) => {
        const height = 20 + Math.random() * 60;
        bar.style.height = height + '%';
      });
      animationHandle = requestAnimationFrame(()=> setTimeout(animateBars, 100));
    }

    function stopBarsAnimation(){
      if (animationHandle) {
        cancelAnimationFrame(animationHandle);
        animationHandle = null;
      }
      bars.forEach(bar => bar.style.height = '30%');
    }

    function showRecordingUI(){
      recordingOverlay.removeAttribute('hidden');
      composer.classList.add('chat-composer--recording');
    }

    function hideRecordingUI(){
      recordingOverlay.setAttribute('hidden', '');
      composer.classList.remove('chat-composer--recording');
      timerEl.textContent = '0:00';
      stopBarsAnimation();
    }

    async function startRecording(){
      const peer = getActivePeer();
      if(!peer) return;
      try{
        await App.startVoiceRecording?.();
        isRecording = true;
        startedAt = Date.now();
        showRecordingUI();
        animateBars();
        tickHandle = setInterval(()=>{
          const sec = Math.round((Date.now()-startedAt)/1000);
          timerEl.textContent = formatTime(sec);
        }, 500);
      }catch(err){
        console.warn('voice start failed', err);
      }
    }

    async function stopAndSend(){
      if (!isRecording) return;
      const peer = getActivePeer();
      try{
        clearInterval(tickHandle); tickHandle = null;
        isRecording = false;
        hideRecordingUI();
        updateSendIcon();
        
        // חלק טעינה (chat-voice-ui.js) – הצגת אינדיקטור טעינה בזמן עיבוד הודעה קולית | HYPER CORE TECH
        const loadingId = 'voice-sending-' + Date.now();
        if (typeof App.showVoiceSendingIndicator === 'function') {
          App.showVoiceSendingIndicator(peer, loadingId);
        }
        
        const result = await App.finalizeVoiceToChat?.(peer);
        if (result && typeof App.publishChatMessage === 'function'){
          await App.publishChatMessage(peer, '');
        }
        
        // הסרת אינדיקטור הטעינה
        if (typeof App.hideVoiceSendingIndicator === 'function') {
          App.hideVoiceSendingIndicator(loadingId);
        }
      }catch(err){
        console.warn('voice finalize failed', err);
        hideRecordingUI();
        updateSendIcon();
      }
    }

    async function cancelRecording(){
      if (!isRecording) return;
      clearInterval(tickHandle); tickHandle = null;
      try {
        await App.cancelVoiceRecording?.();
      } catch {}
      isRecording = false;
      hideRecordingUI();
      updateSendIcon();
    }

    // חלק אירועים (chat-voice-ui.js) – טיפול בלחיצות על כפתורי ההקלטה | HYPER CORE TECH
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
    });

    sendRecordingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      stopAndSend();
    });

    // חלק קול (chat-voice-ui.js) – בדיקת קובץ מצורף בנוסף לטקסט | HYPER CORE TECH
    function hasFileAttachment(){
      const peer = getActivePeer();
      if (!peer) return false;
      return typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(peer);
    }

    function updateSendIcon(){
      const hasText = !!(inputEl && inputEl.value.trim());
      const hasFile = hasFileAttachment();
      if (isRecording) return;
      if (hasText || hasFile){
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
        sendBtn.classList.remove('is-mic');
      } else {
        sendBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        sendBtn.classList.add('is-mic');
      }
    }

    // שליטה בהתנהגות לחיצה על כפתור שליחה/מיקרופון
    sendBtn.addEventListener('click', (ev)=>{
      const hasText = !!(inputEl && inputEl.value.trim());
      const hasFile = hasFileAttachment();
      if (!hasText && !hasFile && !isRecording){
        ev.preventDefault();
        ev.stopPropagation();
        startRecording();
      }
    });

    inputEl?.addEventListener('input', updateSendIcon);
    updateSendIcon();
    
    App.updateChatSendIcon = updateSendIcon;
  }

  Object.assign(App, { initializeChatVoiceUI });
})(window);
