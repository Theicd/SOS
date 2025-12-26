(function initChatUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;
  // חלק צ'אט (chat-ui.js) – צליל והתרעות להודעות נכנסות | HYPER CORE TECH
  const CHAT_MESSAGE_SOUND_URL = 'https://npub1jqzsts0fz6ufkgxdhna99rqwnn0ptrg9tvmy62m7ytffy4w0ncnsm7rac0.blossom.band/f0a73d1b6550d6a140a63fa91ec906f89dcbc2fdece317dbaa81e5093a319629.mp3';
  let chatMessageAudio = null;
  let chatNotificationPermissionLastRequestedAt = 0;

  // חלק צ'אט (chat-ui.js) – מוודא שקיימת סביבת צ'אט
  if (!App.chatState) {
    console.warn('Chat state not initialized – chat UI skipped');
    return;
  }

  // חלק בועת התקדמות העברה (chat-ui.js) – מציג אחוזים + אייקון קובץ/מדיה בתוך השיחה | HYPER CORE TECH
  function renderTransferProgress(progress) {
    if (!elements.messagesContainer || !progress?.fileId) return;
    const existing = elements.messagesContainer.querySelector(`[data-transfer-id="${progress.fileId}"]`);
    const bubble = existing || doc.createElement('div');
    bubble.className = `chat-transfer-bubble chat-transfer-bubble--${progress.direction || 'send'}`;
    bubble.setAttribute('data-transfer-id', progress.fileId);

    const pct = Math.round((progress.progress || 0) * 100);
    const label = progress.name || 'קובץ מצורף';
    const sizeMb = progress.size ? (progress.size / (1024 * 1024)).toFixed(2) : '';
    const statusText = progress.status === 'complete' || progress.status === 'complete-blossom'
      ? 'הועלה'
      : progress.status === 'failed'
      ? 'נכשל'
      : `מעלה... ${pct}%`;

    bubble.innerHTML = `
      <div class="chat-transfer-bubble__header">
        <div class="chat-transfer-bubble__icon"><i class="fa-solid fa-cloud-arrow-up"></i></div>
        <div class="chat-transfer-bubble__meta">
          <div class="chat-transfer-bubble__name">${label}</div>
          <div class="chat-transfer-bubble__size">${sizeMb ? sizeMb + 'MB' : ''}</div>
        </div>
      </div>
      <div class="chat-transfer-bubble__progress">
        <div class="chat-transfer-bubble__bar" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <div class="chat-transfer-bubble__status">${statusText}</div>
    `;

    if (!existing) {
      elements.messagesContainer.appendChild(bubble);
    }

    // scroll עם כל עדכון
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;

    // אם הסתיים – להסיר את בועת הפרוגרס אחרי דיליי קצר (ההודעה המלאה כבר תירנדר) | HYPER CORE TECH
    if (progress.status === 'complete' || progress.status === 'complete-blossom') {
      setTimeout(() => {
        bubble.remove();
        state.transferProgress.delete(progress.fileId);
        console.log('[CHAT/UI] transfer bubble removed', progress.fileId);
      }, 800);
    }
  }

  function subscribeTransferProgress() {
    if (typeof App.subscribeP2PFileProgress === 'function') {
      App.subscribeP2PFileProgress((evt) => {
        const activePeer = (state.activeContact || '').toLowerCase();
        if (evt?.peerPubkey && activePeer && evt.peerPubkey.toLowerCase() !== activePeer) return;
        state.transferProgress.set(evt.fileId, evt);
        renderTransferProgress(evt);
      });
    }
    // פונקציית callback לשימוש ב-chat-file-transfer-ui בעת שליחה | HYPER CORE TECH
    App.handleP2PProgressUpdate = (evt) => {
      const activePeer = (state.activeContact || '').toLowerCase();
      if (evt?.peerPubkey && activePeer && evt.peerPubkey.toLowerCase() !== activePeer) return;
      state.transferProgress.set(evt.fileId, evt);
      renderTransferProgress(evt);
    };
  }

  function handleMessageActions(event) {
    const deleteTarget = event.target.closest('[data-chat-delete]');
    if (!deleteTarget || !state.activeContact) {
      return;
    }
    event.preventDefault();
    const messageId = deleteTarget.getAttribute('data-chat-delete');
    if (!messageId) {
      return;
    }
    showDeleteConfirmDialog(messageId, state.activeContact);
  }

  function showDeleteConfirmDialog(messageId, peerPubkey) {
    const existing = doc.getElementById('chatDeleteDialog');
    if (existing) existing.remove();
    const dialog = doc.createElement('div');
    dialog.id = 'chatDeleteDialog';
    dialog.className = 'chat-dialog';
    dialog.innerHTML = `
      <div class="chat-dialog__backdrop"></div>
      <div class="chat-dialog__content" role="dialog" aria-modal="true">
        <h3 class="chat-dialog__title">מחיקת הודעה</h3>
        <p class="chat-dialog__message">למחוק את ההודעה עבור שני הצדדים? פעולה זו תשלח מחיקה לרשת.</p>
        <div class="chat-dialog__actions">
          <button type="button" class="chat-dialog__btn chat-dialog__btn--cancel">ביטול</button>
          <button type="button" class="chat-dialog__btn chat-dialog__btn--confirm">מחק</button>
        </div>
      </div>
    `;
    elements.panel.appendChild(dialog);
    const backdrop = dialog.querySelector('.chat-dialog__backdrop');
    const cancel = dialog.querySelector('.chat-dialog__btn--cancel');
    const confirm = dialog.querySelector('.chat-dialog__btn--confirm');
    const close = () => dialog.remove();
    backdrop?.addEventListener('click', close);
    cancel?.addEventListener('click', close);
    confirm?.addEventListener('click', () => {
      close();
      if (typeof App.deleteChatMessage === 'function') {
        App.deleteChatMessage(peerPubkey, messageId).then(() => {
          renderMessages(peerPubkey);
        });
      } else if (typeof App.removeChatMessage === 'function') {
        App.removeChatMessage(peerPubkey, messageId);
        renderMessages(peerPubkey);
      }
    });
  }

  const homeNavButton = doc.querySelector('[data-nav="home"]');

  const elements = {
    launcher: doc.getElementById('chatLauncher'),
    launcherButton: doc.getElementById('chatLauncherButton'),
    launcherBadge: doc.getElementById('chatBadge'),
    panel: doc.getElementById('chatPanel'),
    navButton: doc.getElementById('messagesToggle'),
    badge: doc.getElementById('messagesBadge'),
    closeButton: doc.getElementById('chatCloseButton'),
    contactsList: doc.getElementById('chatContactsList'),
    refreshContacts: doc.getElementById('chatRefreshContacts'),
    searchInput: doc.getElementById('chatSearchInput'),
    backButton: doc.getElementById('chatConversationBack'),
    emptyState: doc.getElementById('chatEmptyState'),
    conversationHeader: doc.getElementById('chatConversationHeader'),
    conversationAvatar: doc.getElementById('chatConversationAvatar'),
    conversationName: doc.getElementById('chatConversationName'),
    conversationStatus: doc.getElementById('chatConversationStatus'),
    messagesContainer: doc.getElementById('chatMessages'),
    composer: doc.getElementById('chatComposer'),
    messageInput: doc.getElementById('chatMessageInput'),
    footer: doc.getElementById('chatPanelFooter'),
    footerItems: doc.querySelectorAll('#chatPanelFooter .chat-footer__item'),
    footerNotificationsBadge: doc.getElementById('chatFooterNotificationsBadge'),
    notificationsSection: doc.getElementById('chatNotifications'),
    notificationsList: doc.getElementById('chatNotificationsList'),
    notificationsEmpty: doc.getElementById('chatNotificationsEmpty'),
    notificationsMarkRead: doc.getElementById('chatNotificationsMarkRead'),
    notificationsToggle: doc.getElementById('notificationsToggle'),
  };

  if ((!elements.navButton && !elements.launcherButton) || !elements.panel) {
    console.warn('Chat UI elements missing');
    return;
  }

  const state = {
    isOpen: false,
    activeContact: null,
    filterText: '',
    footerMode: 'contacts',
    panelMode: 'list',
    notifications: [],
    // חלק צ'אט (chat-ui.js) – עוקב אחרי שאילתות פרופיל ממתינות כדי לא לבצע בקשות כפולות
    pendingProfileFetches: new Set(),
    // חלק צ'אט (chat-ui.js) – ניטור העברות P2P לצורך רינדור בועת התקדמות | HYPER CORE TECH
    transferProgress: new Map(),
  };

  let unsubscribeNotifications = null; // חלק צ'אט (chat-ui.js) – מחזיק ביטול הרשמה לעדכוני התרעות עבור ניקוי משאבים
  let notificationSubscribeTimer = null; // חלק צ'אט (chat-ui.js) – טיימר לגיבוי כאשר feed.js נטען מאוחר יותר
  let isRefreshing = false; // חלק רענון (chat-ui.js) – מונע רענון כפול | HYPER CORE TECH

  // חלק רענון שיחות (chat-ui.js) – פונקציה לרענון כל השיחות וההודעות מחדש | HYPER CORE TECH
  async function handleRefreshAllConversations() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    // הצגת אינדיקטור טעינה על כפתור הרענון
    const refreshBtn = elements.refreshContacts;
    if (refreshBtn) {
      refreshBtn.classList.add('is-loading');
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('fa-spin');
    }
    
    try {
      // איפוס חותמת הזמן של הסנכרון האחרון כדי לטעון מההתחלה
      if (typeof App.setChatLastSyncTs === 'function') {
        App.setChatLastSyncTs(0);
      }
      
      // קריאה לפונקציית הסנכרון מחדש
      if (typeof App.syncChatHistory === 'function') {
        await App.syncChatHistory();
      } else if (typeof App.ensureChatEnabled === 'function') {
        App.ensureChatEnabled();
      }
      
      // רענון רשימת אנשי הקשר
      renderContacts();
      
      // אם יש שיחה פעילה, רענן גם אותה
      if (state.activeContact) {
        renderMessages(state.activeContact);
      }
      
      console.log('[CHAT/UI] Refreshed all conversations');
    } catch (err) {
      console.warn('[CHAT/UI] Failed to refresh conversations', err);
    } finally {
      isRefreshing = false;
      if (refreshBtn) {
        refreshBtn.classList.remove('is-loading');
        const icon = refreshBtn.querySelector('i');
        if (icon) icon.classList.remove('fa-spin');
      }
    }
  }

  const PANEL_MODES = {
    LIST: 'list',
    CONVERSATION: 'conversation',
    NOTIFICATIONS: 'notifications',
  };

  function updatePanelMode(mode) {
    const safeMode = Object.values(PANEL_MODES).includes(mode) ? mode : PANEL_MODES.LIST;
    state.panelMode = safeMode;
    if (!elements.panel) {
      return;
    }
    elements.panel.classList.remove('chat-panel--list-only', 'chat-panel--conversation', 'chat-panel--notifications');
    if (safeMode === PANEL_MODES.CONVERSATION) {
      elements.panel.classList.add('chat-panel--conversation');
    } else if (safeMode === PANEL_MODES.NOTIFICATIONS) {
      elements.panel.classList.add('chat-panel--notifications');
    } else {
      elements.panel.classList.add('chat-panel--list-only');
    }
  }

  // חלק צ'אט (chat-ui.js) – שליטה בסטטוס התפריט התחתון בסגנון וואטסאפ
  function setFooterMode(mode) {
    state.footerMode = mode;
    if (!elements.footerItems?.length) return;
    elements.footerItems.forEach((item) => {
      if (item.dataset.chatNav === mode) {
        item.classList.add('is-active');
      } else {
        item.classList.remove('is-active');
      }
    });
  }

  function handleFooterNav(item) {
    const nav = item?.dataset?.chatNav;
    if (!nav) {
      return;
    }
    switch (nav) {
      case 'contacts':
        setFooterMode('contacts');
        state.activeContact = null;
        resetConversationView();
        renderContacts();
        if (!state.isOpen) {
          togglePanel(true);
        }
        break;
      case 'notifications':
        setFooterMode('notifications');
        if (!state.isOpen) {
          togglePanel(true);
        }
        showNotificationsView();
        break;
      case 'home':
        setFooterMode('home');
        togglePanel(false);
        homeNavButton?.click?.();
        break;
      default:
        break;
    }
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const timePart = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) {
      return timePart;
    }
    const datePart = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
    return `${datePart} ${timePart}`;
  }

  // חלק צ'אט (chat-ui.js) – פורמט זמן להצגה בתוך בועת הודעה (רק שעה:דקה כמו וואטסאפ)
  function formatMessageTime(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // חלק צ'אט (chat-ui.js) – מפתח יום (YYYY-MM-DD) לקיבוץ הודעות והצגת כותרות תאריך דביקות
  function getMessageDayKey(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // חלק צ'אט (chat-ui.js) – כותרת יום בסגנון וואטסאפ: היום/אתמול/יום בשבוע/תאריך מלא
  function formatMessageDayHeader(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
    if (diffDays === 0) return 'היום';
    if (diffDays === 1) return 'אתמול';
    if (diffDays >= 2 && diffDays <= 6) {
      return date.toLocaleDateString('he-IL', { weekday: 'long' });
    }
    return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // חלק צ'אט (chat-ui.js) – פורמט זמן לרשימת אנשי קשר בסגנון WhatsApp: היום=שעה, אחרת=אתמול/יום/תאריך
  function formatContactListTimestamp(ts) {
    if (!ts) return '';
    const dayHeader = formatMessageDayHeader(ts);
    if (dayHeader === 'היום') {
      return formatMessageTime(ts);
    }
    return dayHeader;
  }

  // חלק צ'אט (chat-ui.js) – צליל התרעה להודעות נכנסות
  function ensureChatMessageAudio() {
    if (chatMessageAudio) return;
    try {
      chatMessageAudio = new window.Audio(CHAT_MESSAGE_SOUND_URL);
      chatMessageAudio.preload = 'auto';
      chatMessageAudio.playsInline = true;
      chatMessageAudio.setAttribute('playsinline', '');
    } catch (err) {
      console.warn('Failed to init chat message audio', err);
    }
  }

  function playChatMessageSound() {
    ensureChatMessageAudio();
    if (!chatMessageAudio) return;
    try {
      chatMessageAudio.currentTime = 0;
      const p = chatMessageAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – בקשת הרשאת התרעות (חסכון בבקשות) | HYPER CORE TECH
  function requestChatNotificationPermissionIfNeeded() {
    if (!('Notification' in window)) return;
    try {
      if (window.Notification.permission !== 'default') return;
      const now = Date.now();
      if (chatNotificationPermissionLastRequestedAt && (now - chatNotificationPermissionLastRequestedAt) < 60000) return;
      chatNotificationPermissionLastRequestedAt = now;
      const p = window.Notification.requestPermission();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – רישום SW לקבלת התראות במצב ברקע | HYPER CORE TECH
  function registerChatServiceWorkerIfSupported() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    try {
      const p = navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function getChatServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!window.isSecureContext) return Promise.resolve(null);
    try {
      return navigator.serviceWorker.getRegistration().catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // חלק פורמט מדיה להתראות (chat-ui.js) – פורמט הודעות מדיה בעברית להתראות | HYPER CORE TECH
  function formatMessageForNotification(message) {
    const AUDIO_EXTS = /\.(webm|mp3|m4a|ogg|wav|aac)(\?|$)/i;
    const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v)(\?|$)/i;
    const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$)/i;
    
    const content = typeof message === 'string' ? message : (message?.content || '');
    const attachment = typeof message === 'object' ? message?.attachment : null;
    
    // בדיקת attachment
    if (attachment) {
      const mime = String(attachment.type || '').toLowerCase();
      const name = String(attachment.name || '').toLowerCase();
      const url = String(attachment.url || attachment.dataUrl || '').toLowerCase();
      
      // הודעה קולית
      if (mime.startsWith('audio/') || AUDIO_EXTS.test(name) || AUDIO_EXTS.test(url) || 
          name.includes('voice') || url.includes('voice')) {
        const dur = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : null;
        const durationText = dur !== null 
          ? ` (${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')})`
          : '';
        return `🎤 הודעה קולית${durationText}`;
      }
      // וידאו
      if (mime.startsWith('video/') || VIDEO_EXTS.test(name) || VIDEO_EXTS.test(url)) {
        return content ? `📹 ${content}` : '📹 וידאו';
      }
      // תמונה
      if (mime.startsWith('image/') || IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url)) {
        return content ? `📷 ${content}` : '📷 תמונה';
      }
      // קובץ רגיל
      return `📎 ${attachment.name || 'קובץ מצורף'}`;
    }
    
    // בדיקת URL בתוכן
    if (content) {
      const urlMatch = content.match(/(https?:\/\/[^\s]+)/i);
      if (urlMatch) {
        const url = urlMatch[0];
        const remainingText = content.replace(url, '').trim();
        
        if (AUDIO_EXTS.test(url)) return '🎤 הודעה קולית';
        if (VIDEO_EXTS.test(url)) return remainingText ? `📹 ${remainingText}` : '📹 וידאו';
        if (IMAGE_EXTS.test(url)) return remainingText ? `📷 ${remainingText}` : '📷 תמונה';
      }
    }
    
    return content || 'הודעה חדשה';
  }

  // חלק דה-דופליקציה (chat-ui.js) – מניעת התראות כפולות על אותה הודעה | HYPER CORE TECH
  const NOTIFIED_MSG_KEY = 'nostr_notified_chat_messages';
  const MAX_NOTIFIED_IDS = 200;
  
  function getNotifiedMessageIds() {
    try {
      const raw = sessionStorage.getItem(NOTIFIED_MSG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  
  function markMessageNotified(messageId) {
    if (!messageId) return;
    try {
      const ids = getNotifiedMessageIds();
      if (!ids.includes(messageId)) {
        ids.push(messageId);
        while (ids.length > MAX_NOTIFIED_IDS) ids.shift();
        sessionStorage.setItem(NOTIFIED_MSG_KEY, JSON.stringify(ids));
      }
    } catch {}
  }
  
  function wasMessageNotified(messageId) {
    return messageId && getNotifiedMessageIds().includes(messageId);
  }

  // חלק צ'אט (chat-ui.js) – התראת מערכת על הודעה נכנסת כאשר החלון ברקע/לא בשיחה הפעילה | HYPER CORE TECH
  function showIncomingChatNotification(peerPubkey, message, messageId) {
    try {
      if (!peerPubkey || !message) return;
      if (!('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;
      
      // חלק דה-דופליקציה (chat-ui.js) – מניעת התראה כפולה על אותה הודעה | HYPER CORE TECH
      if (messageId && wasMessageNotified(messageId)) {
        return;
      }

      const isHidden = !!doc.hidden || doc.visibilityState === 'hidden';
      const hasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
      const activePeer = state.activeContact ? state.activeContact.toLowerCase() : null;
      const normalizedPeer = peerPubkey.toLowerCase();
      const isActivePeer = activePeer && activePeer === normalizedPeer && state.isOpen && hasFocus && !isHidden;
      if (isActivePeer) return;
      
      // סימון ההודעה כ"הותרעה" כדי שלא תופיע שוב
      if (messageId) markMessageNotified(messageId);

      registerChatServiceWorkerIfSupported();
      const contact = App.chatState?.contacts?.get(normalizedPeer);
      const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
      const picture = contact?.picture || '';
      // חלק התראות מדיה (chat-ui.js) – שימוש בפורמט מדיה בעברית להתראות | HYPER CORE TECH
      const safeSnippet = formatMessageForNotification(message).slice(0, 120);

      const baseOptions = {
        body: safeSnippet,
        tag: `chat-message-${normalizedPeer}`,
        renotify: true
      };
      if (picture) baseOptions.icon = picture;
      try { baseOptions.requireInteraction = true; } catch {}

      const swOptions = Object.assign({}, baseOptions, {
        actions: [{ action: 'open', title: 'פתח צ\'אט' }],
        data: {
          type: 'chat-message',
          peerPubkey: normalizedPeer,
          url: window.location.href
        }
      });

      getChatServiceWorkerRegistration().then((reg) => {
        if (reg && typeof reg.showNotification === 'function') {
          try {
            const p = reg.showNotification(name, swOptions);
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }
        const n = new window.Notification(name, baseOptions);
        n.onclick = () => {
          try { window.focus(); } catch {}
        };
      }).catch(() => {
        try {
          const n = new window.Notification(name, baseOptions);
          n.onclick = () => { try { window.focus(); } catch {} };
        } catch {}
      });
    } catch (err) {
      console.warn('Failed to show chat message notification', err);
    }
  }

  // חלק צ'אט (chat-ui.js) – פתיחת שיחה מתוך הודעת SW | HYPER CORE TECH
  function openConversationFromNotification(peerPubkey) {
    if (!peerPubkey) return;
    const normalized = peerPubkey.toLowerCase();
    state.activeContact = normalized;
    togglePanel(true);
    renderContacts();
    renderMessages(normalized);
    updatePanelMode(PANEL_MODES.CONVERSATION);
    App.markChatConversationRead(normalized);
  }

  // חלק צ'אט (chat-ui.js) – טיפול בהודעות מה-SW עבור התראות צ'אט | HYPER CORE TECH
  function handleChatServiceWorkerMessage(event) {
    const data = event && event.data ? event.data : null;
    if (!data || data.type !== 'chat-message-notification-action') return;
    const peerPubkey = data.peerPubkey || null;
    if (!peerPubkey) return;
    try { window.focus(); } catch {}
    openConversationFromNotification(peerPubkey);
  }

  function initChatServiceWorkerMessageHandling() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.addEventListener('message', handleChatServiceWorkerMessage);
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – שולף את ההודעה האחרונה האמיתית לצורך תצוגה מקדימה ברשימת אנשי קשר
  function resolveContactLastMessageInfo(contact) {
    const fallbackText = typeof contact?.lastMessage === 'string' ? contact.lastMessage : '';
    const fallbackTs = Number(contact?.lastTimestamp) || 0;
    const pubkey = contact?.pubkey;
    if (!pubkey || typeof App.getChatMessages !== 'function') {
      return { text: fallbackText, ts: fallbackTs };
    }
    const messages = App.getChatMessages(pubkey) || [];
    if (!Array.isArray(messages) || !messages.length) {
      return { text: fallbackText, ts: fallbackTs };
    }
    let last = null;
    let lastTs = -1;
    messages.forEach((m) => {
      const ts = Number(m?.createdAt) || 0;
      if (ts >= lastTs) {
        lastTs = ts;
        last = m;
      }
    });
    if (!last) {
      return { text: fallbackText, ts: fallbackTs };
    }
    
    // חלק זיהוי מדיה (chat-ui.js) – זיהוי סוגי מדיה לתצוגה בסגנון וואטסאפ | HYPER CORE TECH
    const AUDIO_EXTS = /\.(webm|mp3|m4a|ogg|wav|aac)(\?|$)/i;
    const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v)(\?|$)/i;
    const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$)/i;
    
    // חלק זיהוי מדיה משופר (chat-ui.js) – תומך ב-Blossom URLs שלא מכילים סיומת | HYPER CORE TECH
    function detectMediaType(mime, name, url, attachment) {
      mime = String(mime || '').toLowerCase();
      name = String(name || '').toLowerCase();
      url = String(url || '').toLowerCase();
      
      // אודיו/הודעה קולית - עדיפות: MIME > שם > duration > URL
      const hasDuration = attachment && typeof attachment.duration === 'number' && attachment.duration > 0;
      if (mime.startsWith('audio/') || AUDIO_EXTS.test(name) || name.includes('voice') || hasDuration || AUDIO_EXTS.test(url)) {
        return 'audio';
      }
      // וידאו
      if (mime.startsWith('video/') || VIDEO_EXTS.test(name) || VIDEO_EXTS.test(url)) {
        return 'video';
      }
      // תמונה
      if (mime.startsWith('image/') || IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url)) {
        return 'image';
      }
      return 'file';
    }
    
    // פונקציית עזר לזיהוי מדיה מ-URL בטקסט
    function detectMediaFromUrl(url) {
      if (AUDIO_EXTS.test(url)) return 'audio';
      if (VIDEO_EXTS.test(url)) return 'video';
      if (IMAGE_EXTS.test(url)) return 'image';
      return null;
    }
    
    let text = '';
    let mediaIcon = '';
    const content = typeof last.content === 'string' ? last.content.trim() : '';
    
    // בדיקת attachment
    if (last.attachment) {
      const a = last.attachment;
      const mediaType = detectMediaType(a.type, a.name, a.url || a.dataUrl, a);
      
      if (mediaType === 'audio') {
        // הודעה קולית: 🎤 הודעה קולית (0:15)
        const dur = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null;
        const durationText = dur !== null 
          ? ` (${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')})`
          : '';
        text = `🎤 הודעה קולית${durationText}`;
      } else if (mediaType === 'video') {
        // וידאו: 📹 וידאו או 📹 + טקסט
        mediaIcon = '📹 ';
        text = content ? mediaIcon + content : mediaIcon + 'וידאו';
      } else if (mediaType === 'image') {
        // תמונה: 📷 תמונה או 📷 + טקסט
        mediaIcon = '📷 ';
        text = content ? mediaIcon + content : mediaIcon + 'תמונה';
      } else {
        // קובץ רגיל: 📎 + שם קובץ
        const fileName = typeof a.name === 'string' && a.name ? a.name : 'קובץ מצורף';
        text = '📎 ' + fileName;
      }
    } else if (content) {
      // בדיקה אם יש URL של מדיה בטקסט
      const urlMatch = content.match(/(https?:\/\/[^\s]+)/i);
      if (urlMatch) {
        const mediaType = detectMediaFromUrl(urlMatch[0]);
        const remainingText = content.replace(urlMatch[0], '').trim();
        
        if (mediaType === 'audio') {
          text = '🎤 הודעה קולית';
        } else if (mediaType === 'video') {
          text = remainingText ? '📹 ' + remainingText : '📹 וידאו';
        } else if (mediaType === 'image') {
          text = remainingText ? '📷 ' + remainingText : '📷 תמונה';
        } else {
          text = content;
        }
      } else {
        text = content;
      }
    }
    
    // חלק סטטוס קריאה (chat-ui.js) – מחזיר גם אם ההודעה יוצאת ומה הסטטוס שלה | HYPER CORE TECH
    const isOutgoing = last?.direction === 'outgoing' || last?.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    const status = last?.status || 'sent';
    
    return { text: text || fallbackText, ts: lastTs || fallbackTs, isOutgoing, status };
  }

  let chatEnableRetryHandle = null;
  function ensureChatEnabled() {
    if (!App.pool) {
      if (!chatEnableRetryHandle) {
        chatEnableRetryHandle = setTimeout(() => {
          chatEnableRetryHandle = null;
          ensureChatEnabled();
        }, 600);
      }
      return;
    }
    if (chatEnableRetryHandle) {
      clearTimeout(chatEnableRetryHandle);
      chatEnableRetryHandle = null;
    }
    if (typeof App.restoreChatState === 'function') {
      App.restoreChatState();
    }
    if (typeof App.subscribeToChatEvents === 'function') {
      App.subscribeToChatEvents();
    }
    if (typeof App.bootstrapChatContacts === 'function') {
      App.bootstrapChatContacts();
    }
  }

  function positionPanel() {
    if (!elements.panel) {
      return;
    }
    const trigger = elements.navButton || elements.launcherButton;
    if (window.innerWidth <= 768) {
      elements.panel.style.left = '0px';
      elements.panel.style.right = '0px';
      const safeTop = Math.max(0, window.visualViewport?.offsetTop || 0);
      elements.panel.style.top = `${safeTop}px`;
      elements.panel.style.bottom = '0px';
      elements.panel.style.width = `${window.visualViewport?.width || window.innerWidth}px`;
      elements.panel.style.maxWidth = `${window.visualViewport?.width || window.innerWidth}px`;
      elements.panel.style.height = `${window.visualViewport?.height || window.innerHeight}px`;
      elements.panel.style.maxHeight = `${window.visualViewport?.height || window.innerHeight}px`;
      return;
    }
    if (!trigger) {
      return;
    }
    const anchor = trigger;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = elements.panel.offsetWidth || 420;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const preferredLeft = rect.left + rect.width / 2 - panelWidth / 2;
    const minLeft = 16;
    const maxLeft = viewportWidth - panelWidth - 16;
    const clampedLeft = Math.max(minLeft, Math.min(preferredLeft, maxLeft)) - 6;
    const top = rect.bottom + 18;
    elements.panel.style.left = `${clampedLeft}px`;
    elements.panel.style.top = `${top}px`;
    elements.panel.style.right = '';
    elements.panel.style.bottom = '';
    elements.panel.style.width = '';
    elements.panel.style.maxWidth = '';
    elements.panel.style.height = '';
    elements.panel.style.maxHeight = '';
  }

  function togglePanel(forceOpen) {
    const targetState = typeof forceOpen === 'boolean' ? forceOpen : !state.isOpen;
    state.isOpen = targetState;
    if (state.isOpen) {
      elements.panel.removeAttribute('hidden');
      elements.navButton?.setAttribute('aria-pressed', 'true');
      elements.launcherButton?.setAttribute('aria-expanded', 'true');
      positionPanel();
      if (window.innerWidth <= 768) {
        doc.body.classList.add('chat-overlay-open');
      } else {
        doc.body.classList.remove('chat-overlay-open');
      }
      if (state.activeContact) {
        App.markChatConversationRead(state.activeContact);
        renderMessages(state.activeContact);
        updatePanelMode(PANEL_MODES.CONVERSATION);
      } else {
        updatePanelMode(PANEL_MODES.LIST);
        ensureChatEnabled();
        renderContacts();
      }
    } else {
      if (state.activeContact) {
        App.markChatConversationRead(state.activeContact);
        renderContacts();
      }
      elements.panel.setAttribute('hidden', '');
      elements.navButton?.setAttribute('aria-pressed', 'false');
      elements.launcherButton?.setAttribute('aria-expanded', 'false');
      resetConversationView();
      doc.body.classList.remove('chat-overlay-open');
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (state.isOpen) {
        positionPanel();
      }
    });
  }

  function renderChatBadge(unreadTotal) {
    const badges = [elements.badge, elements.launcherBadge].filter(Boolean);
    if (!badges.length) {
      return;
    }
    const count = Number(unreadTotal) || 0;
    badges.forEach((badge) => {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.removeAttribute('hidden');
      } else {
        badge.setAttribute('hidden', '');
      }
    });
  }

  function updateFooterNotificationsBadge(notifications) {
    if (!elements.footerNotificationsBadge) {
      return;
    }
    const unreadCount = Array.isArray(notifications)
      ? notifications.reduce((total, entry) => (!entry?.read ? total + 1 : total), 0)
      : 0;
    if (unreadCount > 0) {
      elements.footerNotificationsBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      elements.footerNotificationsBadge.removeAttribute('hidden');
    } else {
      elements.footerNotificationsBadge.setAttribute('hidden', '');
    }
  }

  function handleNotificationItemClick(notification) {
    if (!notification) {
      return;
    }
    if (notification.postId) {
      const target = doc.querySelector(`[data-post-id="${notification.postId}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('feed-post--highlight');
        window.setTimeout(() => target.classList.remove('feed-post--highlight'), 2000);
      }
    }
    if (notification.id && typeof App.markNotificationRead === 'function') {
      App.markNotificationRead(notification.id);
    }
  }

  function createNotificationElement(notification) {
    const item = doc.createElement('li');
    item.className = 'chat-notifications__item';
    if (!notification?.read) {
      item.classList.add('chat-notifications__item--unread');
    }
    if (notification?.id) {
      item.dataset.notificationId = notification.id;
    }
    if (notification?.postId) {
      item.dataset.postId = notification.postId;
    }
    const profile = notification?.actorProfile || {};
    const actorNameRaw = profile.name || notification?.actorPubkey?.slice?.(0, 8) || 'משתמש';
    const actorName = App.escapeHtml ? App.escapeHtml(actorNameRaw) : actorNameRaw;
    const initialsValue = profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(actorNameRaw) : 'מש');
    const initials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
    const avatarHtml = profile.picture
      ? `<img src="${profile.picture}" alt="${actorName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement && (this.parentElement.innerHTML='<span>${initials}</span>');">`
      : `<span>${initials}</span>`;
    const actionText = notification?.type === 'comment' ? 'הגיב לפוסט שלך' : 'אהב את הפוסט שלך';
    const safeAction = App.escapeHtml ? App.escapeHtml(actionText) : actionText;
    const snippetSource = notification?.type === 'comment' && notification?.content ? notification.content : '';
    const safeSnippet = snippetSource && App.escapeHtml ? App.escapeHtml(snippetSource) : snippetSource;
    const snippetHtml = safeSnippet ? `<p class="chat-notifications__snippet">${safeSnippet.replace(/\n/g, '<br>')}</p>` : '';
    const timeLabel = notification?.createdAt ? formatTimestamp(notification.createdAt) : '';
    const timeHtml = timeLabel ? `<time class="chat-notifications__time">${timeLabel}</time>` : '';
    item.innerHTML = `
      <div class="chat-notifications__avatar">${avatarHtml}</div>
      <div class="chat-notifications__content">
        <span class="chat-notifications__actor">${actorName}</span>
        <span class="chat-notifications__action">${safeAction}</span>
        ${snippetHtml}
        ${timeHtml}
      </div>
    `;
    item.addEventListener('click', () => handleNotificationItemClick(notification));
    return item;
  }

  function renderNotificationsList(notifications) {
    if (!elements.notificationsList || !elements.notificationsEmpty) {
      return;
    }
    const records = Array.isArray(notifications) ? notifications : [];
    if (!records.length) {
      elements.notificationsEmpty.removeAttribute('hidden');
      elements.notificationsList.innerHTML = '';
      return;
    }
    elements.notificationsEmpty.setAttribute('hidden', '');
    const fragment = doc.createDocumentFragment();
    records.forEach((notification) => {
      fragment.appendChild(createNotificationElement(notification));
    });
    elements.notificationsList.innerHTML = '';
    elements.notificationsList.appendChild(fragment);
  }

  function showNotificationsView() {
    state.activeContact = null;
    if (typeof App.getNotificationsSnapshot === 'function') {
      state.notifications = App.getNotificationsSnapshot();
    }
    elements.notificationsSection?.removeAttribute('hidden');
    elements.emptyState?.setAttribute('hidden', '');
    elements.conversationHeader?.setAttribute('hidden', '');
    elements.composer?.setAttribute('hidden', '');
    elements.messagesContainer?.setAttribute('hidden', '');
    updatePanelMode(PANEL_MODES.NOTIFICATIONS);
    renderNotificationsList(state.notifications);
    if (typeof App.markAllNotificationsRead === 'function') {
      App.markAllNotificationsRead();
    }
  }

  function ensureNotificationSubscription() {
    if (unsubscribeNotifications) {
      return;
    }
    if (typeof App.subscribeNotifications !== 'function') {
      if (!notificationSubscribeTimer) {
        notificationSubscribeTimer = setTimeout(() => {
          notificationSubscribeTimer = null;
          ensureNotificationSubscription();
        }, 400);
      }
      return;
    }
    try {
      unsubscribeNotifications = App.subscribeNotifications((snapshot) => {
        state.notifications = Array.isArray(snapshot) ? snapshot : [];
        updateFooterNotificationsBadge(state.notifications);
        if (state.panelMode === PANEL_MODES.NOTIFICATIONS) {
          renderNotificationsList(state.notifications);
        }
      });
    } catch (err) {
      console.warn('Chat notifications subscription failed', err);
    }
    if (typeof App.getNotificationsSnapshot === 'function') {
      state.notifications = App.getNotificationsSnapshot();
      updateFooterNotificationsBadge(state.notifications);
    }
  }

  function maybeFetchContactProfile(pubkey, contact) {
    if (!pubkey || typeof App.fetchProfile !== 'function') {
      return;
    }
    const normalized = pubkey.toLowerCase();
    const alreadyFetching = state.pendingProfileFetches.has(normalized);
    const hasPicture = Boolean(contact?.picture);
    const name = contact?.name || '';
    const isFallbackName = !name || (name.startsWith('משתמש ') && name.includes(normalized.slice(0, 8)));
    if (alreadyFetching || (hasPicture && !isFallbackName)) {
      return;
    }
    state.pendingProfileFetches.add(normalized);
    Promise.resolve()
      .then(() => App.fetchProfile(normalized))
      .then((profile) => {
        if (!profile) {
          return;
        }
        const normalizedProfile = {
          name: profile.name || `משתמש ${normalized.slice(0, 8)}`,
          picture: profile.picture || '',
          initials:
            profile.initials ||
            (typeof App.getInitials === 'function' ? App.getInitials(profile.name || '') : 'מש'),
          lastReadTimestamp: contact?.lastReadTimestamp || 0,
        };
        App.ensureChatContact(normalized, normalizedProfile);
      })
      .catch((err) => {
        console.warn('Chat profile fetch failed', err);
      })
      .finally(() => {
        state.pendingProfileFetches.delete(normalized);
      });
  }

  function buildContactHtml(contact) {
    // חלק צ'אט (chat-ui.js) – בונה פריט רשימת אנשי קשר עם אווטרים, שם ותצוגה מקדימה
    const rawName = contact.name || `משתמש ${contact.pubkey.slice(0, 8)}`;
    const safeName = App.escapeHtml ? App.escapeHtml(rawName) : rawName;
    const initialsValue = contact.initials || (typeof App.getInitials === 'function' ? App.getInitials(rawName) : 'מש');
    const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
    const lastInfo = resolveContactLastMessageInfo(contact);
    const previewSource = lastInfo.text
      ? lastInfo.text.replace(/\s+/g, ' ').trim().slice(0, 60)
      : 'אין הודעות עדיין';
    const safePreview = App.escapeHtml ? App.escapeHtml(previewSource) : previewSource;
    // חלק צ'אט (chat-ui.js) – תצוגת זמן הודעה אחרונה ברשימת אנשי קשר בסגנון WhatsApp | HYPER CORE TECH
    const timeLabel = lastInfo.ts ? formatContactListTimestamp(lastInfo.ts) : '';
    const timeHtml = timeLabel ? `<span class="chat-contact__time">${timeLabel}</span>` : '';
    const badgeHtml = contact.unreadCount
      ? `<span class="chat-contact__badge">${contact.unreadCount > 99 ? '99+' : contact.unreadCount}</span>`
      : '';
    const activeClass = state.activeContact === contact.pubkey ? ' chat-contact--active' : '';
    const avatarHtml = contact.picture
      ? `<span class="chat-contact__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-contact__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
      : `<span class="chat-contact__avatar chat-contact__avatar--initials" title="${safeName}">${safeInitials}</span>`;

    // חלק סטטוס קריאה (chat-ui.js) – הוספת וי לרשימת אנשי קשר כמו וואטסאפ | HYPER CORE TECH
    let statusCheckHtml = '';
    if (lastInfo.isOutgoing) {
      const status = lastInfo.status || 'sent';
      if (status === 'read') {
        // וי כפול אדום - נקרא
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--read">✓✓</span>';
      } else if (status === 'sent') {
        // וי אחד אפור - נשלח
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sent">✓</span>';
      } else if (status === 'sending') {
        // שעון - בשליחה
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sending">⏳</span>';
      }
    }

    return `
      <article class="chat-contact${activeClass}" data-chat-contact="${contact.pubkey}">
        ${avatarHtml}
        <div class="chat-contact__body">
          <div class="chat-contact__row">
            <span class="chat-contact__name">${safeName}</span>
            ${timeHtml}
          </div>
          <div class="chat-contact__row chat-contact__row--sub">
            <span class="chat-contact__last-message">${statusCheckHtml}${safePreview}</span>
            ${badgeHtml}
          </div>
        </div>
      </article>
    `;
  }

  function renderContacts() {
    if (!elements.contactsList) return;
    const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
    const unreadTotal = contacts.reduce((sum, item) => sum + (item?.unreadCount || 0), 0);
    renderChatBadge(unreadTotal);
    const normalizedFilter = state.filterText.trim().toLowerCase();
    const filteredContacts = normalizedFilter
      ? contacts.filter((contact) => {
          const label = (contact.name || contact.pubkey || '').toLowerCase();
          const preview = (contact.lastMessage || '').toLowerCase();
          return label.includes(normalizedFilter) || preview.includes(normalizedFilter);
        })
      : contacts;
    if (!filteredContacts.length) {
      const message = contacts.length
        ? 'לא נמצאו תוצאות התואמות לחיפוש.'
        : 'עוד אין שיחות. שלח הודעה ראשונה.';
      elements.contactsList.innerHTML = `<p class="chat-contacts__empty">${message}</p>`;
      return;
    }
    const fragment = doc.createDocumentFragment();
    filteredContacts.forEach((contact) => {
      maybeFetchContactProfile(contact.pubkey, contact);
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = buildContactHtml(contact);
      fragment.appendChild(wrapper.firstElementChild);
    });
    elements.contactsList.innerHTML = '';
    elements.contactsList.appendChild(fragment);
  }

  function renderMessages(peerPubkey) {
    if (!elements.messagesContainer) return;
    const messages = typeof App.getChatMessages === 'function' ? App.getChatMessages(peerPubkey) : [];
    elements.messagesContainer.innerHTML = '';
    if (!messages.length) {
      elements.messagesContainer.innerHTML = '<p class="chat-conversation__empty">אין הודעות עדיין. כתוב משהו!</p>';
      return;
    }
    const fragment = doc.createDocumentFragment();
    // חלק צ'אט (chat-ui.js) – קיבוץ הודעות לפי יום והוספת כותרות תאריך דביקות בסגנון וואטסאפ
    let lastDayKey = '';
    messages.forEach((message) => {
      const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
      const dayKey = getMessageDayKey(messageTimestamp);
      if (dayKey && dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        const header = doc.createElement('div');
        header.className = 'chat-date-header';
        header.textContent = formatMessageDayHeader(messageTimestamp);
        fragment.appendChild(header);
      }
      const item = doc.createElement('div');
      const isOutgoing =
        message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
      const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
      const safeContent = App.escapeHtml ? App.escapeHtml(message.content) : message.content;
      const rawMessageContent = typeof message.content === 'string' ? message.content.trim() : '';

      // חלק צ'אט (chat-ui.js) – משחזר אוואטר לשיחות נכנסות על בסיס נתוני איש הקשר
      let avatarHtml = '';
      if (!isOutgoing) {
        const normalizedFrom = message.from?.toLowerCase?.();
        const contact = normalizedFrom && App.chatState?.contacts?.get?.(normalizedFrom);
        const fallbackName = contact?.name || (normalizedFrom ? `משתמש ${normalizedFrom.slice(0, 8)}` : 'משתמש');
        const safeName = App.escapeHtml ? App.escapeHtml(fallbackName) : fallbackName;
        const initialsValue =
          contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
        const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
        avatarHtml = contact?.picture
          ? `<span class="chat-message__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-message__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
          : `<span class="chat-message__avatar chat-message__avatar--initials" title="${safeName}">${safeInitials}</span>`;
      }

      // חלק זיהוי אודיו מקיף (chat-ui.js) – תמיכה בכל פורמטי האודיו הנפוצים PC/Android/iPhone/Apple | HYPER CORE TECH
      let attachmentHtml = '';
      let isAudioAttachment = false;
      let isImageAttachment = false;
      let isVideoAttachment = false;
      const a = message.attachment || null;
      if (a) {
        const src = a.url || a.dataUrl || '';
        const mime = (a.type || '').toLowerCase();
        const fileName = (a.name || '').toLowerCase();
        const srcLower = src.toLowerCase();
        
        // רשימת כל סיומות האודיו הנפוצות - PC, Android, iPhone, Apple | HYPER CORE TECH
        const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)$/i;
        const AUDIO_EXTENSIONS_URL = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)(\?|#|$)/i;
        
        // בדיקת MIME type - הכי אמין!
        const isAudioMime = mime.startsWith('audio/') || mime === 'application/ogg';
        // בדיקת data URL
        const fromDataUrl = /^data:audio\//i.test(src);
        // בדיקת סיומת בשם הקובץ (חשוב! Blossom URLs לא מכילים סיומת)
        const audioExtInName = AUDIO_EXTENSIONS.test(fileName);
        // בדיקת סיומת ב-URL
        const audioExtInUrl = AUDIO_EXTENSIONS_URL.test(srcLower);
        // בדיקת שם קובץ מכיל "voice" או "audio" או "sound"
        const isVoiceByName = fileName.includes('voice') || fileName.includes('audio') || fileName.includes('sound');
        // בדיקת duration - אם יש duration זה הודעה קולית
        const hasDuration = typeof a.duration === 'number' && a.duration > 0;
        
        // זיהוי אודיו: מספיק שאחד מהתנאים מתקיים
        isAudioAttachment = !!(src && (
          isAudioMime ||           // type: audio/*
          fromDataUrl ||           // data:audio/*
          audioExtInName ||        // song.mp3, voice.m4a, etc.
          isVoiceByName ||         // שם מכיל "voice"/"audio"/"sound"
          hasDuration ||           // יש duration
          audioExtInUrl            // URL מסתיים בסיומת אודיו
        ));
        
        // לוג לדיבאג
        if (audioExtInName || isAudioMime) {
          console.log('[AUDIO] Detected audio attachment:', { fileName, mime, isAudioAttachment });
        }
        
        // חלק מדיה (chat-ui.js) – זיהוי תמונות ווידאו | HYPER CORE TECH
        if (!isAudioAttachment && typeof App.isImageAttachment === 'function') {
          isImageAttachment = App.isImageAttachment(a);
        }
        if (!isAudioAttachment && !isImageAttachment && typeof App.isVideoAttachment === 'function') {
          isVideoAttachment = App.isVideoAttachment(a);
        }
        
        if (isAudioAttachment) {
          // חלק נגן אודיו (chat-ui.js) – שימוש בנגן משודרג מ-chat-audio-player.js | HYPER CORE TECH
          attachmentHtml = typeof App.createEnhancedAudioPlayer === 'function'
            ? App.createEnhancedAudioPlayer(a)
            : `<div class="chat-message__audio" data-audio><audio preload="metadata" class="chat-message__audio-el" src="${src}" type="${a.type || 'audio/webm'}"></audio></div>`;
        } else if (isImageAttachment) {
          // חלק תמונות (chat-ui.js) – הצגת תמונה inline | HYPER CORE TECH
          attachmentHtml = typeof App.renderImageAttachment === 'function'
            ? App.renderImageAttachment(a)
            : `<img src="${src}" alt="${a.name || 'תמונה'}" class="chat-message__image" loading="lazy">`;
        } else if (isVideoAttachment) {
          // חלק וידאו (chat-ui.js) – נגן וידאו מוטמע | HYPER CORE TECH
          attachmentHtml = typeof App.renderVideoAttachment === 'function'
            ? App.renderVideoAttachment(a)
            : `<video src="${src}" controls class="chat-message__video"></video>`;
        } else if (src) {
          const fileName = a.name || 'קובץ מצורף';
          const safeFileName = App.escapeHtml ? App.escapeHtml(fileName) : fileName;
          const extraAttrs = a.url ? 'target="_blank" rel="noopener noreferrer"' : '';
          attachmentHtml = `
            <a class="chat-message__attachment" href="${src}" ${extraAttrs} download="${fileName}">
              <i class="fa-solid fa-paperclip"></i>
              <span>${safeFileName}</span>
            </a>
          `;
        }
      }
      
      // חלק YouTube (chat-ui.js) – זיהוי לינק YouTube בטקסט ההודעה | HYPER CORE TECH
      let youtubeHtml = '';
      if (!a && rawMessageContent && typeof App.extractYouTubeId === 'function') {
        const videoId = App.extractYouTubeId(rawMessageContent);
        if (videoId) {
          youtubeHtml = `
            <div class="chat-message__youtube-container">
              <iframe
                class="chat-message__youtube-iframe"
                src="https://www.youtube.com/embed/${videoId}"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
                loading="lazy"
                title="YouTube video"
              ></iframe>
            </div>
          `;
        }
      }
      
      // חלק זיהוי מדיה מ-URL (chat-ui.js) – זיהוי לינקי תמונה/וידאו/אודיו בטקסט ההודעה | HYPER CORE TECH
      let mediaUrlHtml = '';
      let isMediaUrl = false;
      let remainingText = rawMessageContent;
      // חלק זיהוי URL (chat-ui.js) – גם אם יש attachment, נבדוק URLs בטקסט | HYPER CORE TECH
      if (!youtubeHtml && rawMessageContent) {
        const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|#|$)/i;
        // חלק זיהוי אודיו מקיף (chat-ui.js) – כל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
        const AUDIO_EXTS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)(\?|#|$)/i;
        const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v|wmv|flv|3gp)(\?|#|$)/i;
        
        // חיפוש כל ה-URLs בהודעה - משופר לתמוך ב-URLs עם תווים מיוחדים
        const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
        const urls = rawMessageContent.match(urlRegex) || [];
        const mediaItems = [];
        
        urls.forEach(originalUrl => {
          // ניקוי URL מתווי סיום לא רצויים
          const url = originalUrl.replace(/[.,;:!?)}\]]+$/, '');
          
          // חלק זיהוי אודיו (chat-ui.js) – בדיקה אם זה קובץ אודיו | HYPER CORE TECH
          const isAudioUrl = AUDIO_EXTS.test(url);
          
          if (IMAGE_EXTS.test(url) && !a) {
            // תמונה
            mediaItems.push(`
              <div class="chat-message__image-container">
                <img 
                  src="${url}" 
                  alt="תמונה" 
                  class="chat-message__image"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  onclick="if(typeof App.openImageLightbox==='function')App.openImageLightbox('${url.replace(/'/g, "\\'")}','תמונה')"
                />
              </div>
            `);
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          } else if (isAudioUrl) {
            // חלק נגן אודיו מקיף (chat-ui.js) – יוצר נגן לכל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
            const ext = (url.match(/\.(\w+)(?:\?|#|$)/i) || [])[1]?.toLowerCase() || 'mp3';
            const mimeMap = {
              mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
              m4a: 'audio/mp4', m4b: 'audio/mp4', m4p: 'audio/mp4', m4r: 'audio/mp4', mp4a: 'audio/mp4', alac: 'audio/mp4',
              aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac', wma: 'audio/x-ms-wma',
              aiff: 'audio/aiff', aif: 'audio/aiff', caf: 'audio/x-caf', amr: 'audio/amr', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp'
            };
            const mimeType = mimeMap[ext] || 'audio/mpeg';
            const fileName = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'קובץ שמע');
            const fakeAttachment = { url: url, type: mimeType, name: fileName };
            console.log('[AUDIO] Creating player for URL:', { url, ext, mimeType, fileName });
            mediaItems.push(typeof App.createEnhancedAudioPlayer === 'function'
              ? App.createEnhancedAudioPlayer(fakeAttachment)
              : `<div class="chat-message__audio" data-audio data-src="${url}"><audio preload="auto" class="chat-message__audio-el" src="${url}" type="${mimeType}"></audio></div>`);
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          } else if (VIDEO_EXTS.test(url) && !a) {
            // וידאו - רק סיומות וידאו מפורשות (לא webm)
            mediaItems.push(`
              <div class="chat-message__video-container">
                <video 
                  class="chat-message__video"
                  controls
                  preload="metadata"
                  playsinline
                  aria-label="וידאו"
                >
                  <source src="${url}" type="video/mp4">
                </video>
              </div>
            `);
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          }
        });
        
        mediaUrlHtml = mediaItems.join('');
      }

      item.className = `chat-message ${directionClass}`;
      const deleteButtonHtml = isOutgoing
        ? `
            <button type="button" class="chat-message__delete" data-chat-delete="${message.id}" aria-label="מחק הודעה">
              <i class="fa-solid fa-trash"></i>
            </button>
          `
        : '';
      // חלק צ'אט (chat-ui.js) – כאשר מצורף קובץ בלבד, לא מציגים שוב את הטקסט "📎 filename" כי הלינק מציג את השם
      const fileOnlyLabel = a && !isAudioAttachment ? `📎 ${a.name || 'קובץ מצורף'}` : '';
      const hideTextForFileOnly = !isAudioAttachment && !!attachmentHtml && rawMessageContent === fileOnlyLabel;
      // חלק מדיה URL (chat-ui.js) – מסתיר את הטקסט כשיש מדיה מ-URL | HYPER CORE TECH
      // אם יש URLs של מדיה, נציג רק את הטקסט הנותר (ללא ה-URLs)
      const textToShow = isMediaUrl ? remainingText : rawMessageContent;
      const safeTextToShow = App.escapeHtml ? App.escapeHtml(textToShow) : textToShow;
      const hideTextForMediaUrl = isMediaUrl && !remainingText;
      
      // חלק "המשך קריאה" (chat-ui.js) – קיצור הודעות ארוכות ל-10 שורות עם כפתור הרחבה | HYPER CORE TECH
      let textHtml = '';
      if (safeTextToShow && !isAudioAttachment && !hideTextForFileOnly && !hideTextForMediaUrl) {
        const lines = safeTextToShow.split('\n');
        const MAX_LINES = 10;
        const isLongText = lines.length > MAX_LINES;
        const truncatedContent = isLongText ? lines.slice(0, MAX_LINES).join('\n') : safeTextToShow;
        const fullContentEscaped = safeTextToShow.replace(/'/g, "\\'").replace(/\n/g, '\\n');
        
        if (isLongText) {
          textHtml = `
            <span class="chat-message__text chat-message__text--truncated" data-full-text="${fullContentEscaped}" onclick="App.copyMessageToClipboard && App.copyMessageToClipboard(this)">
              ${truncatedContent.replace(/\n/g, '<br>')}
              <span class="chat-message__read-more" onclick="event.stopPropagation(); App.expandMessageText && App.expandMessageText(this.parentElement)">להמשך קריאה...</span>
            </span>
          `;
        } else {
          textHtml = `<span class="chat-message__text" onclick="App.copyMessageToClipboard && App.copyMessageToClipboard(this)">${safeTextToShow.replace(/\n/g, '<br>')}</span>`;
        }
      }

      // חלק צ'אט (chat-ui.js) – מצב קומפקטי בסגנון WhatsApp: הודעות קצרות עם שעה+פח על אותה שורה | HYPER CORE TECH
      const shouldCompactMeta =
        !a &&
        rawMessageContent &&
        rawMessageContent.length <= 60 &&
        !rawMessageContent.includes('\n') &&
        Boolean(textHtml);
      const contentClassName = `chat-message__content${a ? ' chat-message__content--has-attachment' : ''}${
        shouldCompactMeta ? ' chat-message__content--compact-meta' : ''
      }`;
      
      // חלק סטטוס הודעות (chat-ui.js) – אייקון סטטוס להודעות יוצאות (טעינה, נשלח, נקרא) | HYPER CORE TECH
      let statusHtml = '';
      if (isOutgoing) {
        const status = message.status || 'sent';
        if (status === 'sending') {
          statusHtml = '<span class="chat-message__status chat-message__status--sending" title="שולח..."><i class="fa-solid fa-circle-notch fa-spin"></i></span>';
        } else if (status === 'sent') {
          statusHtml = '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check"></i></span>';
        } else if (status === 'read') {
          statusHtml = '<span class="chat-message__status chat-message__status--read" title="נקרא"><i class="fa-solid fa-check-double"></i></span>';
        } else if (status === 'failed') {
          statusHtml = '<span class="chat-message__status chat-message__status--failed" title="שליחה נכשלה"><i class="fa-solid fa-exclamation-circle"></i></span>';
        }
      }
      
      item.innerHTML = `
        ${avatarHtml}
        <div class="${contentClassName}" data-chat-message="${message.id}">
          ${textHtml}
          ${attachmentHtml}
          ${youtubeHtml}
          ${mediaUrlHtml}
          <div class="chat-message__meta-row">
            <span class="chat-message__meta">${formatMessageTime(messageTimestamp)}</span>
            ${statusHtml}
            ${deleteButtonHtml}
          </div>
        </div>
      `;
      // חלק חיבור נגנים (chat-ui.js) – חיבור כל נגני האודיו (attachment + URL) | HYPER CORE TECH
      const contentEl = item.querySelector('[data-chat-message]');
      if (contentEl && typeof App.wireEnhancedAudioPlayer === 'function') {
        // חיבור כל נגני האודיו בהודעה
        const audioWraps = contentEl.querySelectorAll('[data-audio]');
        audioWraps.forEach(wrap => {
          App.wireEnhancedAudioPlayer(wrap);
        });
      }
      fragment.appendChild(item);
    });
    elements.messagesContainer.appendChild(fragment);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;

    // חלק צ'אט (chat-ui.js) – הבטחת איפוס מונה לא נקראים כשצופים בשיחה בפועל | HYPER CORE TECH
    const activeNormalized = (state.activeContact || '').toLowerCase();
    const normalized = (peerPubkey || '').toLowerCase();
    if (activeNormalized && normalized && activeNormalized === normalized && typeof App.markChatConversationRead === 'function') {
      App.markChatConversationRead(normalized);
    }
  }

  function showConversation(peerPubkey, contact) {
    state.activeContact = peerPubkey;
    elements.panel.classList.add('chat-panel--conversation');
    updatePanelMode(PANEL_MODES.CONVERSATION);
    setFooterMode('contacts');
    elements.notificationsSection?.setAttribute('hidden', '');
    if (elements.emptyState) {
      elements.emptyState.setAttribute('hidden', '');
    }
    elements.conversationHeader?.removeAttribute('hidden');
    elements.composer?.removeAttribute('hidden');
    elements.messagesContainer?.removeAttribute('hidden');
    if (elements.messageInput) {
      elements.messageInput.value = '';
      // חלק צ'אט (chat-ui.js) – לא מפעיל focus אוטומטי כדי שהמקלדת לא תיפתח ללא לחיצה יזומה
    }
    // אתחול מחדש של כפתור מיקרופון במובייל כשהשיחה נפתחת
    if (typeof App.initializeChatVoiceUI === 'function') {
      setTimeout(() => {
        App.initializeChatVoiceUI({
          getActivePeer: () => state.activeContact,
          getMessageDraft: () => elements.messageInput?.value || '',
          composerElement: elements.composer,
        });
      }, 100);
    }
    const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
    const initials = contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(name) : 'מש');
    if (elements.conversationName) {
      elements.conversationName.textContent = name;
    }
    if (elements.conversationAvatar) {
      // חלק צ'אט (chat-ui.js) – מציג אווטר עבור השיחה הנוכחית עם ניקוי תוכן קודם
      elements.conversationAvatar.innerHTML = '';
      elements.conversationAvatar.textContent = '';
      if (contact?.picture) {
        elements.conversationAvatar.innerHTML = `<img src="${contact.picture}" alt="${name}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.textContent='${initials}'; this.remove();" />`;
      } else {
        elements.conversationAvatar.textContent = initials;
      }
    }
    if (elements.conversationStatus) {
      elements.conversationStatus.textContent = 'פעיל ברשת';
    }
    renderMessages(peerPubkey);
    App.markChatConversationRead(peerPubkey);
    if (typeof App.setChatFileTransferActivePeer === 'function') {
      App.setChatFileTransferActivePeer(peerPubkey);
    }
  }

  function resetConversationView() {
    state.activeContact = null;
    elements.panel.classList.remove('chat-panel--conversation');
    setFooterMode('contacts');
    elements.conversationHeader?.setAttribute('hidden', '');
    elements.composer?.setAttribute('hidden', '');
    if (elements.emptyState) {
      elements.emptyState.removeAttribute('hidden');
    }
    if (elements.messagesContainer) {
      elements.messagesContainer.innerHTML = '';
      elements.messagesContainer.setAttribute('hidden', '');
    }
    elements.notificationsSection?.setAttribute('hidden', '');
    if (typeof App.clearChatFileTransferUI === 'function') {
      App.clearChatFileTransferUI();
    }
    updatePanelMode(PANEL_MODES.LIST);
  }

  function handleContactClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target.closest('[data-chat-contact]');
    if (!target) return;
    const peerPubkey = target.getAttribute('data-chat-contact');
    if (!peerPubkey) return;
    const contact = App.chatState.contacts.get(peerPubkey.toLowerCase());
    showConversation(peerPubkey, contact);
    renderContacts();
  }

  function handleSendMessage(event) {
    event.preventDefault();
    if (!state.activeContact) {
      return;
    }
    const value = elements.messageInput?.value || '';
    const hasAttachment =
      typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(state.activeContact);
    if (!value.trim() && !hasAttachment) {
      return;
    }
    elements.messageInput.disabled = true;
    App.publishChatMessage(state.activeContact, value)
      .then((result) => {
        if (!result?.ok) {
          console.warn('Failed to send chat message', result?.error);
        }
        if (elements.messageInput) {
          elements.messageInput.value = '';
          // חלק צ'אט (chat-ui.js) – לא מפעיל focus אוטומטי כדי שהמקלדת לא תיפתח ללא לחיצה יזומה
        }
        renderMessages(state.activeContact);
      })
      .catch((err) => {
        console.error('Chat send error', err);
      })
      .finally(() => {
        if (elements.messageInput) {
          elements.messageInput.disabled = false;
        }
      });
  }

  function handleAddContact(event) {
    event.preventDefault();
    const value = elements.addContactInput?.value?.trim?.();
    if (!value) {
      return;
    }
    const contact = App.addChatContact?.(value);
    if (contact) {
      renderContacts();
      showConversation(contact.pubkey, contact);
      elements.addContactInput.value = '';
      togglePanel(true);
    }
  }

  function subscribeToEvents() {
    if (elements.navButton) {
      elements.navButton.addEventListener('click', () => togglePanel());
    }
    if (elements.launcherButton) {
      elements.launcherButton.addEventListener('click', () => togglePanel());
    }
    if (elements.closeButton) {
      elements.closeButton.addEventListener('click', () => togglePanel(false));
    }
    doc.addEventListener('click', (event) => {
      if (!state.isOpen) return;
      if (
        elements.panel.contains(event.target) ||
        (elements.navButton && elements.navButton.contains(event.target)) ||
        (elements.launcherButton && elements.launcherButton.contains(event.target))
      ) {
        return;
      }
      togglePanel(false);
    });
    window.addEventListener('resize', () => {
      positionPanel();
    });
    window.addEventListener('scroll', () => {
      positionPanel();
    });
    if (elements.contactsList) {
      elements.contactsList.addEventListener('click', handleContactClick);
    }
    if (elements.refreshContacts) {
      elements.refreshContacts.addEventListener('click', () => {
        // חלק רענון שיחות (chat-ui.js) – איפוס חותמת זמן וטעינה מחדש של כל השיחות | HYPER CORE TECH
        handleRefreshAllConversations();
      });
    }
    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', (event) => {
        const value = event.target?.value || '';
        state.filterText = value;
        renderContacts();
      });
    }
    if (elements.composer) {
      elements.composer.addEventListener('submit', handleSendMessage);
    }
    if (elements.messagesContainer) {
      elements.messagesContainer.addEventListener('click', handleMessageActions);
    }
    if (elements.backButton) {
      elements.backButton.addEventListener('click', () => {
        resetConversationView();
      });
    }
    const headerBackButton = doc.getElementById('chatConversationActionsBack');
    if (headerBackButton) {
      headerBackButton.addEventListener('click', () => {
        resetConversationView();
      });
    }
    if (elements.notificationsMarkRead) {
      elements.notificationsMarkRead.addEventListener('click', () => {
        if (typeof App.markAllNotificationsRead === 'function') {
          App.markAllNotificationsRead(true);
        }
      });
    }
    if (elements.footerItems?.length) {
      elements.footerItems.forEach((item) => {
        item.addEventListener('click', () => handleFooterNav(item));
      });
    }
  }

  function initSubscriptions() {
    App.subscribeChat?.('contacts', () => {
      renderContacts();
    });
    App.subscribeChat?.('message', ({ peer, message }) => {
      if (!peer) return;
      const normalizedPeer = peer.toLowerCase();
      const isIncoming = message?.direction === 'incoming'
        || (message?.from && typeof App.publicKey === 'string' && message.from.toLowerCase() !== App.publicKey.toLowerCase());
      const isActivePeer = normalizedPeer === (state.activeContact || '').toLowerCase();
      const messageId = message?.id || null;

      // התרעה + צליל רק אם זה נכנס ולא בשיחה הפעילה/פוקוס
      // חלק דה-דופליקציה (chat-ui.js) – בודק גם אם ההודעה כבר הותרעה | HYPER CORE TECH
      if (isIncoming && !wasMessageNotified(messageId)) {
        if (!isActivePeer || !state.isOpen) {
          playChatMessageSound();
          const snippetSource = (message?.content && message.content.trim()) ||
            (message?.attachment?.name ? `📎 ${message.attachment.name}` :
              (message?.attachment
                ? (String(message.attachment.type || '').toLowerCase().startsWith('audio/') ? 'הודעת קול' : 'קובץ מצורף')
                : 'הודעה חדשה'));
          showIncomingChatNotification(normalizedPeer, snippetSource, messageId);
        }
      }

      if (isActivePeer) {
        renderMessages(peer);
        App.markChatConversationRead(peer);
      } else {
        renderContacts();
      }
      
      // חלק סטטוס הודעות (chat-ui.js) – עדכון DOM ישיר כשמשתנה סטטוס הודעה | HYPER CORE TECH
      // מונע רינדור מלא רק לעדכון סטטוס
    });
    App.subscribeChat?.('unread', (total) => {
      renderChatBadge(total);
    });
    ensureNotificationSubscription();
  }

  function initializeUI() {
    renderContacts();
    renderChatBadge(App.chatState?.unreadTotal || 0);
    elements.messagesContainer?.setAttribute('hidden', '');
    elements.notificationsSection?.setAttribute('hidden', '');
    subscribeToEvents();
    initSubscriptions();
    ensureNotificationSubscription();
    if (typeof App.initializeChatFileTransferUI === 'function') {
      App.initializeChatFileTransferUI({
        fileButton: doc.getElementById('chatComposerFileButton'),
        fileInput: doc.getElementById('chatComposerFileInput'),
        filePreview: doc.getElementById('chatComposerFilePreview'),
        fileNameLabel: doc.getElementById('chatComposerFileName'),
        fileRemove: doc.getElementById('chatComposerFileRemove'),
        getActivePeer: () => state.activeContact,
        getMessageDraft: () => elements.messageInput?.value || '',
      });
    }
    // אתחול UI להודעות קוליות – מוסיף כפתור מיקרופון, הקלטה והצמדה כשמצרפים קול
    if (typeof App.initializeChatVoiceUI === 'function') {
      App.initializeChatVoiceUI({
        getActivePeer: () => state.activeContact,
        getMessageDraft: () => elements.messageInput?.value || '',
        composerElement: elements.composer,
      });
    }
    // מנוי פרוגרס להעברות P2P כדי לרנדר בועות התקדמות בתוך השיחה | HYPER CORE TECH
    subscribeTransferProgress();
    // בקשת הרשאות התרעה לצ'אט + רישום SW והאזנה להודעות ממנו
    requestChatNotificationPermissionIfNeeded();
    registerChatServiceWorkerIfSupported();
    initChatServiceWorkerMessageHandling();
    updatePanelMode(PANEL_MODES.LIST);
  }

  // חלק צ'אט (chat-ui.js) – מאפשר למודולים חיצוניים (למשל התרעות) לסגור את חלון הצ'אט במעבר בין פאנלים
  App.closeChatPanel = function closeChatPanel() {
    togglePanel(false);
  };

  // חלק צ'אט (chat-ui.js) – חשיפת פונקציה לקבלת המשתמש הפעיל בשיחה
  App.getActiveChatContact = function getActiveChatContact() {
    return state.activeContact;
  };

  // חלק העתקה ללוח (chat-ui.js) – העתקת טקסט הודעה ללוח בלחיצה | HYPER CORE TECH
  App.copyMessageToClipboard = function copyMessageToClipboard(element) {
    if (!element) return;
    const fullText = element.getAttribute('data-full-text');
    const textToCopy = fullText 
      ? fullText.replace(/\\n/g, '\n').replace(/\\'/g, "'")
      : element.innerText.replace('להמשך קריאה...', '').trim();
    
    if (!textToCopy) return;
    
    navigator.clipboard.writeText(textToCopy).then(() => {
      // הצגת הודעה למשתמש
      const toast = doc.createElement('div');
      toast.className = 'chat-toast';
      toast.textContent = 'הועתק ללוח!';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 16px;border-radius:20px;font-size:14px;z-index:10000;animation:fadeInOut 2s forwards;';
      doc.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);
    }).catch(() => {});
  };

  // חלק הרחבת טקסט (chat-ui.js) – הרחבת הודעה ארוכה שנחתכה | HYPER CORE TECH
  App.expandMessageText = function expandMessageText(element) {
    if (!element) return;
    const fullText = element.getAttribute('data-full-text');
    if (!fullText) return;
    
    const expandedText = fullText.replace(/\\n/g, '<br>').replace(/\\'/g, "'");
    element.innerHTML = expandedText;
    element.classList.remove('chat-message__text--truncated');
    element.onclick = function() { App.copyMessageToClipboard(this); };
  };

  // חלק אינדיקטור שליחה (chat-ui.js) – הצגת סימן טעינה בזמן שליחת הודעה קולית | HYPER CORE TECH
  const voiceSendingIndicators = new Map();
  
  App.showVoiceSendingIndicator = function showVoiceSendingIndicator(peer, loadingId) {
    if (!elements.messagesContainer || !peer) return;
    
    const indicator = doc.createElement('div');
    indicator.className = 'chat-message chat-message--outgoing chat-message--sending';
    indicator.id = loadingId;
    indicator.innerHTML = `
      <div class="chat-message__content">
        <div class="chat-message__sending-indicator">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span>שולח הודעה קולית...</span>
        </div>
        <div class="chat-message__meta-row">
          <span class="chat-message__meta">
            <i class="fa-solid fa-clock"></i>
          </span>
        </div>
      </div>
    `;
    elements.messagesContainer.appendChild(indicator);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    voiceSendingIndicators.set(loadingId, indicator);
  };
  
  App.hideVoiceSendingIndicator = function hideVoiceSendingIndicator(loadingId) {
    const indicator = voiceSendingIndicators.get(loadingId);
    if (indicator && indicator.parentElement) {
      indicator.remove();
    }
    voiceSendingIndicators.delete(loadingId);
  };

  initializeUI();
  togglePanel(false);
  ensureChatEnabled();
})(window);
