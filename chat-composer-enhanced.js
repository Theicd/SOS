// חלק פס תחתון משופר (chat-composer-enhanced.js) – UI מתקדם לשליחת הודעות בסגנון WhatsApp | HYPER CORE TECH
(function initChatComposerEnhanced(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;
  
  let composerState = {
    isRecording: false,
    showEmojiPicker: false,
    attachmentPreview: null,
    inputElement: null,
    composerElement: null,
    sendButton: null,
    voiceButton: null,
    attachButton: null,
    emojiButton: null,
  };
  
  // חלק Emoji Picker (chat-composer-enhanced.js) – בורר אימוג'ים פשוט | HYPER CORE TECH
  const COMMON_EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
    '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
    '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
    '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
    '🤧', '🥵', '🥶', '😶‍🌫️', '🥴', '😵', '🤯', '🤠', '🥳', '😎',
    '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉',
    '👆', '👇', '☝️', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
  ];
  
  function createEmojiPicker() {
    const picker = doc.createElement('div');
    picker.className = 'chat-emoji-picker';
    picker.innerHTML = `
      <div class="chat-emoji-picker__header">
        <span class="chat-emoji-picker__title">בחר אימוג'י</span>
        <button type="button" class="chat-emoji-picker__close" aria-label="סגור">×</button>
      </div>
      <div class="chat-emoji-picker__grid">
        ${COMMON_EMOJIS.map(emoji => 
          `<button type="button" class="chat-emoji-picker__item" data-emoji="${emoji}">${emoji}</button>`
        ).join('')}
      </div>
    `;
    return picker;
  }
  
  function toggleEmojiPicker() {
    if (!composerState.composerElement) return;
    
    const existing = composerState.composerElement.querySelector('.chat-emoji-picker');
    if (existing) {
      existing.remove();
      composerState.showEmojiPicker = false;
      return;
    }
    
    const picker = createEmojiPicker();
    composerState.composerElement.appendChild(picker);
    composerState.showEmojiPicker = true;
    
    // חיבור אירועים
    const closeBtn = picker.querySelector('.chat-emoji-picker__close');
    closeBtn?.addEventListener('click', () => {
      picker.remove();
      composerState.showEmojiPicker = false;
    });
    
    const emojiButtons = picker.querySelectorAll('.chat-emoji-picker__item');
    emojiButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = btn.getAttribute('data-emoji');
        if (emoji && composerState.inputElement) {
          const start = composerState.inputElement.selectionStart || 0;
          const end = composerState.inputElement.selectionEnd || 0;
          const text = composerState.inputElement.value;
          const before = text.substring(0, start);
          const after = text.substring(end);
          composerState.inputElement.value = before + emoji + after;
          composerState.inputElement.selectionStart = composerState.inputElement.selectionEnd = start + emoji.length;
          composerState.inputElement.focus();
          
          // Trigger input event
          composerState.inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    });
    
    // סגירה בלחיצה מחוץ לפיקר
    setTimeout(() => {
      const handleClickOutside = (e) => {
        if (!picker.contains(e.target) && e.target !== composerState.emojiButton) {
          picker.remove();
          composerState.showEmojiPicker = false;
          doc.removeEventListener('click', handleClickOutside);
        }
      };
      doc.addEventListener('click', handleClickOutside);
    }, 0);
  }
  
  // חלק כפתורים (chat-composer-enhanced.js) – יצירת כפתורי פעולה | HYPER CORE TECH
  function createEnhancedComposer(container) {
    if (!container) return;
    
    const existingInput = container.querySelector('#chatMessageInput');
    const existingForm = container.querySelector('form');
    
    if (!existingInput || !existingForm) return;
    
    composerState.inputElement = existingInput;
    composerState.composerElement = container;
    
    // יצירת כפתורים משופרים
    const actionsBar = doc.createElement('div');
    actionsBar.className = 'chat-composer__actions';
    actionsBar.innerHTML = `
      <button type="button" class="chat-composer__action-btn" id="chatEmojiButton" title="הוסף אימוג'י" aria-label="הוסף אימוג'י">
        <i class="fa-regular fa-face-smile"></i>
      </button>
      <button type="button" class="chat-composer__action-btn" id="chatAttachButton" title="צרף קובץ" aria-label="צרף קובץ">
        <i class="fa-solid fa-paperclip"></i>
      </button>
      <!-- חלק אטב (chat-composer-enhanced.js) – תומך בכל סוגי הקבצים: DC ישיר / WebTorrent P2P / Blossom (למדיה) | HYPER CORE TECH -->
      <input type="file" id="chatFileInput" style="display:none">
    `;
    
    // הוספת הכפתורים לפני ה-input
    existingForm.insertBefore(actionsBar, existingInput);
    
    // שמירת רפרנסים
    composerState.emojiButton = actionsBar.querySelector('#chatEmojiButton');
    composerState.attachButton = actionsBar.querySelector('#chatAttachButton');
    const fileInput = actionsBar.querySelector('#chatFileInput');
    
    // חיבור אירועים
    composerState.emojiButton?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEmojiPicker();
    });
    
    composerState.attachButton?.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput?.click();
    });
    
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file && typeof App.handleChatFileSelection === 'function') {
        App.handleChatFileSelection(file);
      }
      fileInput.value = ''; // איפוס
    });
    
    // אופטימיזציה להקלדה
    if (typeof App.optimizeMessageInput === 'function') {
      App.optimizeMessageInput(existingInput);
    }
    
    // שינוי דינמי של כפתור שליחה/הקלטה
    existingInput.addEventListener('input', () => {
      updateSendButton();
    });
    
    updateSendButton();
  }
  
  function updateSendButton() {
    const sendBtn = composerState.composerElement?.querySelector('button[type="submit"]');
    const hasText = composerState.inputElement?.value?.trim().length > 0;
    
    if (sendBtn) {
      if (hasText) {
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
        sendBtn.classList.add('chat-composer__send--active');
      } else {
        sendBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        sendBtn.classList.remove('chat-composer__send--active');
      }
    }
  }
  
  // חלק אנימציות (chat-composer-enhanced.js) – אנימציות חלקות | HYPER CORE TECH
  function animateButton(button, animation = 'pulse') {
    if (!button) return;
    
    button.classList.add(`chat-composer__btn--${animation}`);
    setTimeout(() => {
      button.classList.remove(`chat-composer__btn--${animation}`);
    }, 300);
  }
  
  // חלק הקלטה (chat-composer-enhanced.js) – אינדיקטור הקלטה | HYPER CORE TECH
  function showRecordingIndicator() {
    if (!composerState.composerElement) return;
    
    const indicator = doc.createElement('div');
    indicator.className = 'chat-recording-indicator';
    indicator.innerHTML = `
      <div class="chat-recording-indicator__dot"></div>
      <span class="chat-recording-indicator__text">מקליט...</span>
      <span class="chat-recording-indicator__time">0:00</span>
    `;
    
    composerState.composerElement.appendChild(indicator);
    composerState.isRecording = true;
    
    let seconds = 0;
    const timer = setInterval(() => {
      seconds++;
      const timeEl = indicator.querySelector('.chat-recording-indicator__time');
      if (timeEl) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        timeEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
      }
    }, 1000);
    
    return {
      stop: () => {
        clearInterval(timer);
        indicator.remove();
        composerState.isRecording = false;
      }
    };
  }
  
  // חלק Typing Indicator (chat-composer-enhanced.js) – אינדיקטור "מקליד..." | HYPER CORE TECH
  let typingTimeout = null;
  function notifyTyping(peerPubkey) {
    if (!peerPubkey || typeof App.sendTypingIndicator !== 'function') return;
    
    clearTimeout(typingTimeout);
    App.sendTypingIndicator(peerPubkey, true);
    
    typingTimeout = setTimeout(() => {
      App.sendTypingIndicator(peerPubkey, false);
    }, 3000);
  }
  
  // חלק API ציבורי (chat-composer-enhanced.js) – חשיפת פונקציות | HYPER CORE TECH
  Object.assign(App, {
    createEnhancedComposer,
    toggleEmojiPicker,
    showRecordingIndicator,
    notifyTyping,
    animateComposerButton: animateButton,
    updateComposerSendButton: updateSendButton
  });
  
  console.log('Enhanced chat composer loaded');
})(window);
