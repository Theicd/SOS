(function initChatVoiceUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  // חלק קול (chat-voice-ui.js) – UI מינימלי לכפתור מיקרופון, הקלטה, תצוגת טיימר ופרסום ההודעה
  // שייך למודול SOS2 צ'אט קול. ללא תלות חיצונית. קצר וברור.

  if (App.initializeChatVoiceUI) return;

  function createTimerLabel(){
    const span = doc.createElement('span');
    span.id = 'chatComposerVoiceTimer';
    span.className = 'chat-composer__voice-timer';
    span.setAttribute('hidden','');
    span.textContent = '0:00';
    return span;
  }

  function formatTime(sec){
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s/60);
    const r = String(s%60).padStart(2,'0');
    return `${m}:${r}`;
  }

  function initializeChatVoiceUI(config){
    const getActivePeer = typeof config?.getActivePeer === 'function' ? config.getActivePeer : ()=>null;
    const composer = config?.composerElement || doc.getElementById('chatComposer');
    if(!composer) {
      // ניסיון חוזר במובייל
      setTimeout(()=>initializeChatVoiceUI(config), 500);
      return;
    }

    const inputEl = composer.querySelector('#chatMessageInput') || composer.querySelector('textarea');
    const sendBtn = composer.querySelector('.chat-composer__send, [type="submit"]');
    if (!sendBtn) {
      // המתנה לכפתור במובייל
      setTimeout(()=>initializeChatVoiceUI(config), 500);
      return;
    }

    // מניעת אתחול כפול
    if (sendBtn.dataset.voiceInitialized) return;
    sendBtn.dataset.voiceInitialized = 'true';

    const toolbar = composer.querySelector('.chat-composer__actions') || composer;
    const timer = createTimerLabel();
    // מציב טיימר ליד שדה הטקסט
    const field = composer.querySelector('#chatMessageInput') || composer.querySelector('textarea');
    if (field && field.parentElement) {
      field.parentElement.appendChild(timer);
    } else {
      toolbar.appendChild(timer);
    }

    let isRecording = false;
    let tickHandle = null;
    let startedAt = 0;

    function setTimerVisible(v){
      if(v) timer.removeAttribute('hidden'); else timer.setAttribute('hidden','');
    }

    async function onMicClick(){
      const peer = getActivePeer();
      if(!peer) return;
      if(!isRecording){
        try{
          await App.startVoiceRecording?.();
          isRecording = true;
          startedAt = Date.now();
          setTimerVisible(true);
          sendBtn.classList.add('is-mic-recording');
          sendBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
          tickHandle = setInterval(()=>{
            const sec = Math.round((Date.now()-startedAt)/1000);
            timer.textContent = formatTime(sec);
          }, 500);
        }catch(err){
          console.warn('voice start failed', err);
        }
        return;
      }
      // stop & attach
      try{
        clearInterval(tickHandle); tickHandle = null;
        const result = await App.finalizeVoiceToChat?.(peer);
        isRecording = false;
        sendBtn.classList.remove('is-mic-recording');
        updateSendIcon();
        setTimerVisible(false);
        timer.textContent = '0:00';
        // שליחה מיידית כהודעה ללא טקסט – נתמך ע"י publishChatMessage
        if (result && typeof App.publishChatMessage === 'function'){
          await App.publishChatMessage(peer, '');
        }
      }catch(err){
        console.warn('voice finalize failed', err);
        isRecording = false;
        sendBtn.classList.remove('is-mic-recording');
        updateSendIcon();
        setTimerVisible(false);
        timer.textContent = '0:00';
      }
    }

    function updateSendIcon(){
      const hasText = !!(inputEl && inputEl.value.trim());
      if (isRecording) return; // נשלט ע"י מצב הקלטה
      if (hasText){
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
      if (!hasText){
        ev.preventDefault();
        ev.stopPropagation();
        onMicClick();
      }
      // אחרת – לתת לטופס לשלוח כרגיל
    });

    inputEl?.addEventListener('input', updateSendIcon);
    updateSendIcon();
  }

  Object.assign(App, { initializeChatVoiceUI });
})(window);
