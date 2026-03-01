(function initChatUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;
  // חלק דיבאג מדיה (chat-ui.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
  if (typeof App.mediaDebugLog !== 'function') {
    App.mediaDebugLog = (...args) => {
      try {
        if (localStorage.getItem('sos_debug_media') === '1') {
          console.log('[MEDIA-DEBUG]', ...args);
        }
      } catch (_) {}
    };
  }
  const mediaDebugLog = App.mediaDebugLog;
  // חלק אימות גרסה (chat-ui.js) – לוג לוידוא שהקוד החדש נטען | HYPER CORE TECH
  console.log('%c[CHAT-UI] VERSION: P2P-VOICE-FIX-v2 (2026-02-09)', 'color: lime; font-size: 14px; font-weight: bold;');
  // חלק צ'אט (chat-ui.js) – צליל והתרעות להודעות נכנסות | HYPER CORE TECH
  const CHAT_MESSAGE_SOUND_URL = 'https://npub1jqzsts0fz6ufkgxdhna99rqwnn0ptrg9tvmy62m7ytffy4w0ncnsm7rac0.blossom.band/f0a73d1b6550d6a140a63fa91ec906f89dcbc2fdece317dbaa81e5093a319629.mp3';
  let chatMessageAudio = null;
  let chatNotificationPermissionLastRequestedAt = 0;

  // חלק צ'אט (chat-ui.js) – מוודא שקיימת סביבת צ'אט
  if (!App.chatState) {
    console.warn('Chat state not initialized – chat UI skipped');
    return;
  }

  // חלק בועת התקדמות העברה (chat-ui.js) – מציג אחוזים + אייקון קובץ/מדיה + סטטוס retry/אישור | HYPER CORE TECH
  function renderTransferProgress(progress) {
    if (!elements.messagesContainer || !progress?.fileId) return;
    const existing = elements.messagesContainer.querySelector(`[data-transfer-id="${progress.fileId}"]`);
    const bubble = existing || doc.createElement('div');
    bubble.className = `chat-transfer-bubble chat-transfer-bubble--${progress.direction || 'send'}`;
    bubble.setAttribute('data-transfer-id', progress.fileId);

    const pct = Math.round((progress.progress || 0) * 100);
    const label = progress.name || 'קובץ מצורף';
    const sizeMb = progress.size ? (progress.size / (1024 * 1024)).toFixed(2) : '';

    // חלק סטטוסים מורחבים (chat-ui.js) – תמיכה ב-retry, seeding, complete-torrent, failed | HYPER CORE TECH
    let statusText = '';
    let statusClass = '';
    let iconClass = 'fa-cloud-arrow-up';
    const st = progress.status;
    if (st === 'complete' || st === 'complete-blossom') {
      statusText = '✅ הועלה בהצלחה'; statusClass = 'chat-transfer-bubble--success';
    } else if (st === 'complete-torrent') {
      statusText = progress.messageSent ? '✅ נשלח בהצלחה' : '⚠️ נשלח (ללא אישור)';
      statusClass = progress.messageSent ? 'chat-transfer-bubble--success' : 'chat-transfer-bubble--warn';
    } else if (st === 'sent-no-confirm') {
      statusText = '⚠️ הקובץ נשלח, ממתין לאישור'; statusClass = 'chat-transfer-bubble--warn';
    } else if (st === 'seeding-torrent') {
      const attempt = progress.attempt || 1;
      const max = progress.maxRetries || 3;
      statusText = max > 1 ? `🧲 משתף... (${attempt}/${max})` : '🧲 משתף...';
      iconClass = 'fa-seedling';
    } else if (st === 'retrying-torrent') {
      const attempt = progress.attempt || 1;
      const max = progress.maxRetries || 3;
      statusText = `🔄 ניסיון ${attempt + 1}/${max} — ${progress.error || 'ממתין'}`;
      statusClass = 'chat-transfer-bubble--retry'; iconClass = 'fa-rotate-right';
    } else if (st === 'failed') {
      statusText = '❌ השליחה נכשלה'; statusClass = 'chat-transfer-bubble--failed';
      iconClass = 'fa-triangle-exclamation';
    } else if (st === 'uploading-blossom') {
      statusText = `מעלה... ${pct}%`;
    } else {
      statusText = `מעלה... ${pct}%`;
    }

    bubble.innerHTML = `
      <div class="chat-transfer-bubble__header">
        <div class="chat-transfer-bubble__icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="chat-transfer-bubble__meta">
          <div class="chat-transfer-bubble__name">${label}</div>
          <div class="chat-transfer-bubble__size">${sizeMb ? sizeMb + 'MB' : ''}</div>
        </div>
      </div>
      <div class="chat-transfer-bubble__progress">
        <div class="chat-transfer-bubble__bar" style="width:${Math.min(100, pct)}%"></div>
      </div>
      <div class="chat-transfer-bubble__status ${statusClass}">${statusText}</div>
    `;

    if (!existing) {
      elements.messagesContainer.appendChild(bubble);
    }

    // scroll עם כל עדכון
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;

    // חלק הסרת בועה (chat-ui.js) – הסרה אחרי סיום מוצלח, השארה אם נכשל | HYPER CORE TECH
    if (st === 'complete' || st === 'complete-blossom' || st === 'complete-torrent') {
      setTimeout(() => {
        bubble.remove();
        state.transferProgress.delete(progress.fileId);
        console.log('[CHAT/UI] transfer bubble removed', progress.fileId);
      }, 1500);
    }
    // כשלון — משאירים את הבועה כדי שהשולח יראה שנכשל
    if (st === 'failed') {
      setTimeout(() => {
        state.transferProgress.delete(progress.fileId);
      }, 5000);
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
    // חלק טורנט הורדה (chat-ui.js) – טיפול בלחיצה על כפתור הורדה של טורנט | HYPER CORE TECH
    const torrentDownloadBtn = event.target.closest('.torrent-bubble__download-btn');
    if (torrentDownloadBtn) {
      event.preventDefault();
      event.stopPropagation();
      const magnetURI = torrentDownloadBtn.getAttribute('data-magnet');
      const fileName = torrentDownloadBtn.getAttribute('data-filename') || 'file';
      if (magnetURI && typeof App.downloadTorrentFile === 'function') {
        // שינוי מראה הכפתור להורדה פעילה
        if (!torrentDownloadBtn.dataset.defaultHtml) {
          torrentDownloadBtn.dataset.defaultHtml = torrentDownloadBtn.innerHTML;
        }
        torrentDownloadBtn.disabled = true;
        torrentDownloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> מוריד...';
        App.downloadTorrentFile(magnetURI, fileName);
      } else if (magnetURI) {
        console.log('[CHAT/UI] Torrent download requested:', magnetURI);
        // fallback - פתח את ה-magnet URI
        window.open(magnetURI, '_blank');
      }
      return;
    }

    // חלק ניסיון שוב (chat-ui.js) – טיפול בלחיצה על כפתור retry בבועת כשלון הורדה | HYPER CORE TECH
    const retryBtn = event.target.closest('.torrent-bubble__retry-btn');
    if (retryBtn) {
      event.preventDefault();
      event.stopPropagation();
      const magnetURI = retryBtn.getAttribute('data-retry-magnet');
      const fileName = retryBtn.getAttribute('data-retry-filename') || 'file';
      if (magnetURI && typeof App.downloadTorrentFile === 'function') {
        // הסרת בועת הכשלון והתחלת הורדה מחדש
        const failedBubble = retryBtn.closest('.chat-message--torrent-failed');
        if (failedBubble) failedBubble.remove();
        App.downloadTorrentFile(magnetURI, fileName);
      }
      return;
    }
    
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
    // חלק מניעת סגירה (chat-ui.js) – stopPropagation מונע סגירת הצ'אט פאנל בלחיצה על הדיאלוג | HYPER CORE TECH
    backdrop?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    cancel?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    confirm?.addEventListener('click', (e) => {
      e.stopPropagation();
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
    navSidebarItems: doc.querySelectorAll('.chat-nav-item, .chat-nav-profile'),
    navProfileImg: doc.getElementById('chatNavProfileImg'),
    torrentSendButton: doc.getElementById('chatTorrentSendButton'),
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

  // חלק סנכרון כפתורי טורנט (chat-ui.js) – מאחד מצב כפתורים לפי סט auto-start והעברות פעילות כדי למנוע מצב תקוע | HYPER CORE TECH
  function syncTorrentDownloadButtons() {
    if (!elements.messagesContainer) return;

    const incomingBtns = elements.messagesContainer.querySelectorAll('.chat-message--incoming .torrent-bubble__download-btn, .chat-message--incoming .chat-file-bubble__download.torrent-bubble__download-btn');
    if (!incomingBtns.length) return;

    const activeMagnets = new Set();
    if (App._autoStartedTorrentMagnets instanceof Set) {
      App._autoStartedTorrentMagnets.forEach((magnetURI) => {
        if (magnetURI) activeMagnets.add(magnetURI);
      });
    }

    if (typeof App.torrentTransfer?.getActiveTransfers === 'function') {
      try {
        const transfers = App.torrentTransfer.getActiveTransfers() || [];
        transfers.forEach((transfer) => {
          const magnetURI = transfer?.magnetURI || '';
          if (!magnetURI) return;
          if (transfer?.type && transfer.type !== 'receive') return;
          const status = String(transfer?.status || '').toLowerCase();
          if (status === 'completed' || status === 'error' || status === 'cancelled' || status === 'rejected') return;
          activeMagnets.add(magnetURI);
        });
      } catch (err) {
        console.warn('[CHAT/UI] syncTorrentDownloadButtons failed to read active transfers', err);
      }
    }

    incomingBtns.forEach((btn) => {
      if (!btn.dataset.defaultHtml) {
        btn.dataset.defaultHtml = btn.innerHTML;
      }

      const magnetURI = btn.getAttribute('data-magnet');
      const shouldDisable = Boolean(magnetURI && activeMagnets.has(magnetURI));

      if (shouldDisable) {
        btn.disabled = true;
        const hasTextLabel = (btn.dataset.defaultHtml || '').includes('הורד');
        btn.innerHTML = hasTextLabel
          ? '<i class="fa-solid fa-spinner fa-spin"></i> מוריד...'
          : '<i class="fa-solid fa-spinner fa-spin"></i>';
        return;
      }

      btn.disabled = false;
      if (btn.dataset.defaultHtml && btn.innerHTML !== btn.dataset.defaultHtml) {
        btn.innerHTML = btn.dataset.defaultHtml;
      }
    });
  }

  // חלק חשיפה (chat-ui.js) – API גלובלי לסנכרון כפתורי הורדה ממודולים אחרים (למשל WebTorrent) | HYPER CORE TECH
  App.syncTorrentDownloadButtons = syncTorrentDownloadButtons;

  // חלק אופטימיזציה (chat-ui.js) – debounce ו-throttle למניעת עומס ביצועים | HYPER CORE TECH
  function debounce(fn, delay) {
    let timer = null;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
  
  function throttle(fn, limit) {
    let lastCall = 0;
    let pending = null;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        fn.apply(this, args);
      } else if (!pending) {
        pending = setTimeout(() => {
          lastCall = Date.now();
          pending = null;
          fn.apply(this, args);
        }, limit - (now - lastCall));
      }
    };
  }
  
  // גרסאות מאופטמות של פונקציות רינדור - throttle למניעת רינדור כפול | HYPER CORE TECH
  let _lastRenderContactsTime = 0;
  const RENDER_CONTACTS_THROTTLE = 300; // מינימום 300ms בין רינדורים

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

  // חלק צ'אט (chat-ui.js) – שליטה בסטטוס התפריט התחתון והצדדי בסגנון וואטסאפ
  function setFooterMode(mode) {
    state.footerMode = mode;
    
    // עדכון סרגל תחתון (מובייל)
    if (elements.footerItems?.length) {
      elements.footerItems.forEach((item) => {
        if (item.dataset.chatNav === mode) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });
    }

    // עדכון סרגל צדדי (דסקטופ)
    if (elements.navSidebarItems?.length) {
      elements.navSidebarItems.forEach((item) => {
        // התעלמות מכפתורי פעולה שאינם טאבים (כמו home או settings אם הם לא מצב)
        if (item.id === 'chatNavHome') return; 
        
        if (item.dataset.chatNav === mode) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });
    }
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
      case 'profile':
        // חלק פרופיל (chat-ui.js) – פתיחת דף הפרופיל של המשתמש | HYPER CORE TECH
        console.log('[CHAT] Profile clicked - navigating to profile.html');
        window.location.href = 'profile.html';
        break;
      case 'games':
        // חלק משחקים (chat-ui.js) – פתיחת דף המשחקים | HYPER CORE TECH
        console.log('[CHAT] Games clicked - navigating to games.html');
        window.location.href = 'games.html';
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
  // חלק קיבוץ התראות (chat-ui.js) – מנהל מצטבר להתראה אחת עם ספירת הודעות/משתמשים | HYPER CORE TECH
  const aggregateNotificationState = {
    totalMessages: 0,
    peers: new Set(),
    lastPeer: null,
    lastSnippet: '',
    lastName: ''
  };

  function resetAggregateNotificationState() {
    aggregateNotificationState.totalMessages = 0;
    aggregateNotificationState.peers.clear();
    aggregateNotificationState.lastPeer = null;
    aggregateNotificationState.lastSnippet = '';
    aggregateNotificationState.lastName = '';
  }

  function buildAggregateNotificationBody() {
    const usersCount = aggregateNotificationState.peers.size;
    const header = `${aggregateNotificationState.totalMessages} הודעות מ-${usersCount} משתמשים`;
    const tail = aggregateNotificationState.lastSnippet
      ? `\n${aggregateNotificationState.lastName || 'משתמש'}: ${aggregateNotificationState.lastSnippet}`
      : '';
    return `${header}${tail}`;
  }
  
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

      // חלק קיבוץ התראות (chat-ui.js) – צבירת ספירה ואיחוד להתראה אחת | HYPER CORE TECH
      aggregateNotificationState.totalMessages += 1;
      aggregateNotificationState.peers.add(normalizedPeer);
      aggregateNotificationState.lastPeer = normalizedPeer;
      aggregateNotificationState.lastSnippet = safeSnippet;
      aggregateNotificationState.lastName = name;

      const baseOptions = {
        body: buildAggregateNotificationBody(),
        tag: 'chat-aggregate',
        renotify: true
      };
      if (picture) baseOptions.icon = picture;
      try { baseOptions.requireInteraction = true; } catch {}

      const swOptions = Object.assign({}, baseOptions, {
        actions: [{ action: 'open', title: "פתח צ'אט" }],
        data: {
          type: 'chat-message-aggregate',
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

  // חלק צ'אט (chat-ui.js) – מיקום הפאנל - בדסקטופ נשלט על ידי CSS בלבד | HYPER CORE TECH
  function positionPanel() {
    if (!elements.panel) {
      return;
    }
    // בדסקטופ (מעל 768px) - ה-CSS קובע את המיקום (כמו פרופיל), לא צריך JavaScript
    if (window.innerWidth > 768) {
      // איפוס כל הסגנונות האינליין כדי שה-CSS יעבוד
      elements.panel.style.left = '';
      elements.panel.style.right = '';
      elements.panel.style.top = '';
      elements.panel.style.bottom = '';
      elements.panel.style.width = '';
      elements.panel.style.maxWidth = '';
      elements.panel.style.height = '';
      elements.panel.style.maxHeight = '';
      return;
    }
    // במובייל (768px ומטה) - מיקום מלא מסך
    elements.panel.style.left = '0px';
    elements.panel.style.right = '0px';
    const safeTop = Math.max(0, window.visualViewport?.offsetTop || 0);
    elements.panel.style.top = `${safeTop}px`;
    elements.panel.style.bottom = '0px';
    elements.panel.style.width = `${window.visualViewport?.width || window.innerWidth}px`;
    elements.panel.style.maxWidth = `${window.visualViewport?.width || window.innerWidth}px`;
    elements.panel.style.height = `${window.visualViewport?.height || window.innerHeight}px`;
    elements.panel.style.maxHeight = `${window.visualViewport?.height || window.innerHeight}px`;
  }

  function togglePanel(forceOpen) {
    const targetState = typeof forceOpen === 'boolean' ? forceOpen : !state.isOpen;
    state.isOpen = targetState;
    if (state.isOpen) {
      // עצירת וידאו בפתיחת פאנל הודעות | HYPER CORE TECH
      if (typeof App.pauseAllFeedVideos === 'function') {
        App.pauseAllFeedVideos();
      }
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
        renderContacts(true); // force render בפתיחה ראשונה
      }
    } else {
      if (state.activeContact) {
        App.markChatConversationRead(state.activeContact);
        renderContacts(true);
      }
      elements.panel.setAttribute('hidden', '');
      elements.navButton?.setAttribute('aria-pressed', 'false');
      elements.launcherButton?.setAttribute('aria-expanded', 'false');
      resetConversationView();
      doc.body.classList.remove('chat-overlay-open');
    }
  }

  // חלק מקלדת מובייל (chat-ui.js) – מאזין לשינויי viewport עם שמירה על פוקוס ב-input | HYPER CORE TECH
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (state.isOpen) {
        // שמור את האלמנט הפעיל לפני שינוי גודל
        const activeElement = document.activeElement;
        const isInputFocused = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
        
        positionPanel();
        
        // אם ה-input היה בפוקוס, החזר אותו לפוקוס אחרי שינוי גודל
        if (isInputFocused && activeElement === elements.messageInput) {
          requestAnimationFrame(() => {
            elements.messageInput?.focus();
          });
        }
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
    const isFallbackName = !name || name.startsWith('משתמש ');
    
    // תמיד לנסות לטעון פרופיל אם השם הוא fallback
    if (alreadyFetching) {
      return;
    }
    // אם יש תמונה ושם אמיתי - לא צריך לטעון
    if (hasPicture && !isFallbackName) {
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
        // רינדור מחדש של רשימת אנשי הקשר אחרי עדכון הפרופיל | HYPER CORE TECH
        renderContacts(true);
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

    // חלק סטטוס קריאה (chat-ui.js) – הוספת וי לרשימת אנשי קשר כמו וואטסאפ (אייקוני FontAwesome זהים לשיחה) | HYPER CORE TECH
    let statusCheckHtml = '';
    if (lastInfo.isOutgoing) {
      const status = lastInfo.status || 'sent';
      if (status === 'read') {
        // וי כפול ירוק - נקרא (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--read"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'sent') {
        // וי כפול אפור - נשלח (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sent"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'sending') {
        // שעון - בשליחה (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sending"><i class="fa-solid fa-clock"></i></span>';
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

  function renderContacts(force = false) {
    if (!elements.contactsList) return;
    
    // חלק אופטימיזציה (chat-ui.js) – מניעת רינדור כפול עם throttle | HYPER CORE TECH
    const now = Date.now();
    if (!force && now - _lastRenderContactsTime < RENDER_CONTACTS_THROTTLE) {
      return;
    }
    _lastRenderContactsTime = now;
    
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

  // חלק throttle (chat-ui.js) – מניעת renderMessages חוזר מהיר (500ms מינימום) | HYPER CORE TECH
  let _lastRenderMsgTime = 0;
  let _pendingRenderMsg = null;
  const RENDER_MSG_THROTTLE = 500;

  // חלק בקרה UI טורנט (chat-ui.js) – ה-UI לא מתחיל הורדות היסטוריות בעצמו, רק מציג מצב לפי מנוע ההעברה | HYPER CORE TECH

  function renderMessages(peerPubkey) {
    if (!elements.messagesContainer) return;
    const now = Date.now();
    if (now - _lastRenderMsgTime < RENDER_MSG_THROTTLE) {
      if (_pendingRenderMsg) clearTimeout(_pendingRenderMsg);
      _pendingRenderMsg = setTimeout(() => { _pendingRenderMsg = null; renderMessages(peerPubkey); }, RENDER_MSG_THROTTLE);
      return;
    }
    _lastRenderMsgTime = now;
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
      
      // חלק זיהוי טורנט (chat-ui.js) – זיהוי הודעות העברת קבצים גדולים והצגתן כבועות מיוחדות | HYPER CORE TECH
      let isTorrentMessage = false;
      let torrentData = null;
      try {
        if (rawMessageContent.includes('torrent-transfer-request') || rawMessageContent.includes('magnetURI') || rawMessageContent.includes('infoHash')) {
          torrentData = JSON.parse(rawMessageContent);
          if (torrentData?.type === 'torrent-transfer-request' || (torrentData?.magnetURI && torrentData?.infoHash)) {
            isTorrentMessage = true;
            console.log('[CHAT/UI] 🧲 Detected torrent message:', torrentData.fileName, 'isOutgoing:', isOutgoing);
          }
        }
      } catch (e) { /* not JSON */ }
      
      // אם זו הודעת טורנט - מציגים בועה מיוחדת עם כפתור הורדה | HYPER CORE TECH
      if (isTorrentMessage && torrentData) {
        const torrentFileName = torrentData.fileName || 'קובץ';
        const torrentFileSize = torrentData.fileSize || 0;
        const torrentTransferId = torrentData.transferId || message.id;
        const magnetURI = torrentData.magnetURI || '';
        const infoHash = torrentData.infoHash || '';
        const actionIcon = isOutgoing ? 'fa-cloud-arrow-up' : 'fa-cloud-arrow-down';
        const actionText = isOutgoing ? 'נשלח' : 'התקבל';
        const fileSizeFormatted = typeof App.formatFileSize === 'function' ? App.formatFileSize(torrentFileSize) : `${(torrentFileSize / (1024 * 1024)).toFixed(2)} MB`;
        
        // זיהוי סוג קובץ לאייקון מתאים
        const fileExt = torrentFileName.split('.').pop()?.toLowerCase() || '';
        let fileIcon = 'fa-file';
        if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(fileExt)) fileIcon = 'fa-file-video';
        else if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(fileExt)) fileIcon = 'fa-file-audio';
        else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(fileExt)) fileIcon = 'fa-file-image';
        else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(fileExt)) fileIcon = 'fa-file-zipper';
        else if (['pdf'].includes(fileExt)) fileIcon = 'fa-file-pdf';
        else if (['doc', 'docx'].includes(fileExt)) fileIcon = 'fa-file-word';
        else if (['xls', 'xlsx'].includes(fileExt)) fileIcon = 'fa-file-excel';
        
        item.className = `chat-message ${directionClass} chat-message--torrent-transfer chat-message--torrent-completed`;
        item.setAttribute('data-message-id', message.id);
        item.setAttribute('data-torrent-transfer', torrentTransferId);
        if (magnetURI) item.setAttribute('data-magnet-uri', magnetURI);
        if (infoHash) item.setAttribute('data-info-hash', infoHash);
        
        // כפתור הורדה - רק להודעות נכנסות
        const downloadButtonHtml = !isOutgoing && magnetURI ? `
          <button type="button" class="torrent-bubble__download-btn" data-magnet="${App.escapeHtml ? App.escapeHtml(magnetURI) : magnetURI}" data-filename="${App.escapeHtml ? App.escapeHtml(torrentFileName) : torrentFileName}" title="הורד קובץ">
            <i class="fa-solid fa-download"></i> הורד
          </button>
        ` : '';
        
        // כפתור מחיקה - רק להודעות יוצאות | HYPER CORE TECH
        const torrentDeleteButtonHtml = isOutgoing ? `
          <button type="button" class="chat-message__delete" data-chat-delete="${message.id}" aria-label="מחק הודעה">
            <i class="fa-solid fa-trash"></i>
          </button>
        ` : '';
        
        item.innerHTML = `
          <div class="chat-message__content chat-message__content--torrent">
            ${torrentDeleteButtonHtml}
            <div class="torrent-bubble">
              <div class="torrent-bubble__header">
                <i class="fa-solid ${actionIcon}"></i>
                <span class="torrent-bubble__action">${actionText}</span>
              </div>
              <div class="torrent-bubble__file">
                <i class="fa-solid ${fileIcon}"></i>
                <div class="torrent-bubble__file-info">
                  <span class="torrent-bubble__file-name">${App.escapeHtml ? App.escapeHtml(torrentFileName) : torrentFileName}</span>
                  <span class="torrent-bubble__file-size">${fileSizeFormatted}</span>
                </div>
                ${downloadButtonHtml}
              </div>
            </div>
            <div class="chat-message__time">${formatMessageTime(message.createdAt || Math.floor(Date.now() / 1000))}</div>
          </div>
        `;
        
        fragment.appendChild(item);
        return; // המשך להודעה הבאה
      }

      // חלק צ'אט (chat-ui.js) – משחזר אוואטר לשיחות נכנסות על בסיס נתוני איש הקשר
      // חלק אוואטר יוצא (chat-ui.js) – הוספת תמיכה באוואטר גם להודעות יוצאות (אודיו) | HYPER CORE TECH
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
        // תיקון: וודא שה-type מועבר נכון, אחרת נסה לזהות מהשם
        let mime = (a.type || '').toLowerCase();
        const fileName = (a.name || '').toLowerCase();
        // אם אין MIME type, נסה לזהות מהשם
        if (!mime && fileName.includes('.webm')) mime = 'audio/webm';
        if (!mime && fileName.includes('.ogg')) mime = 'audio/ogg';
        if (!mime && fileName.includes('.mp3')) mime = 'audio/mpeg';
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
        // בדיקה נוספת: שם קובץ מסתיים ב-.webm (הודעה קולית נפוצה)
        const isWebmFile = fileName.endsWith('.webm') || srcLower.includes('.webm');
        // בדיקת duration - אם יש duration זה הודעה קולית
        const hasDuration = typeof a.duration === 'number' && a.duration > 0;
        // בדיקת URL מכיל blossom.band (שרת מדיה) - כל קובץ עם שם voice הוא אודיו
        const isBlossomAudio = srcLower.includes('blossom.band') && (audioExtInName || isVoiceByName || isWebmFile);
        // בדיקה נוספת: שם הקובץ מכיל "voice-message" - זה תמיד הודעה קולית!
        const isVoiceMessage = fileName.includes('voice-message') || fileName.includes('voicemessage');
        
        // חלק P2P קול (chat-ui.js) – הודעות P2P-only עם magnetURI בלבד גם נחשבות אודיו | HYPER CORE TECH
        const hasMagnetURI = !!(a.magnetURI);

        // חלק תיקון וידאו (chat-ui.js) – אם מסומן מפורשות כוידאו, מדלגים על זיהוי אודיו לחלוטין | HYPER CORE TECH
        if (a.isVideo === true) {
          isVideoAttachment = typeof App.isVideoAttachment === 'function' ? App.isVideoAttachment(a) : !!src;
        } else {
        // זיהוי אודיו: מספיק שאחד מהתנאים מתקיים (src או magnetURI) + תכונת אודיו אמיתית
        // שים לב: hasMagnetURI לבד אינו מספיק — חייבת להיות גם תכונת אודיו (mime/שם/סיומת/duration)
        // כדי שקבצי ZIP/PDF עם magnetURI לא יסווגו בטעות כהודעות קוליות!
        isAudioAttachment = !!((src || hasMagnetURI) && (
          isAudioMime ||           // type: audio/*
          fromDataUrl ||           // data:audio/*
          audioExtInName ||        // song.mp3, voice.m4a, etc.
          isVoiceByName ||         // שם מכיל "voice"/"audio"/"sound"
          isVoiceMessage ||        // שם מכיל "voice-message" - הכי חשוב!
          isWebmFile ||            // קובץ .webm (הודעה קולית)
          hasDuration ||           // יש duration
          audioExtInUrl ||         // URL מסתיים בסיומת אודיו
          isBlossomAudio           // Blossom URL עם שם קובץ אודיו
        ));
        
        // חלק מדיה (chat-ui.js) – זיהוי תמונות ווידאו | HYPER CORE TECH
        if (!isAudioAttachment && typeof App.isImageAttachment === 'function') {
          isImageAttachment = App.isImageAttachment(a);
        }
        if (!isAudioAttachment && !isImageAttachment && typeof App.isVideoAttachment === 'function') {
          isVideoAttachment = App.isVideoAttachment(a);
        }
        } // סוף בלוק isVideo===true
        // חלק דיבאג מדיה (chat-ui.js) – רישום זיהוי מצורף וסוג מדיה | HYPER CORE TECH
        mediaDebugLog('attachment-detect', {
          messageId: message.id,
          hasAttachment: !!a,
          name: a?.name || '',
          mime: a?.type || '',
          url: a?.url || a?.dataUrl || '',
          audio: isAudioAttachment,
          image: isImageAttachment,
          video: isVideoAttachment
        });
        
        if (isAudioAttachment) {
          // חלק נגן אודיו (chat-ui.js) – שימוש בנגן משודרג מ-chat-audio-player.js | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור אודיו מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'audio', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.createEnhancedAudioPlayer === 'function'
            ? App.createEnhancedAudioPlayer(a)
            : `<div class="chat-message__audio" data-audio><audio preload="metadata" class="chat-message__audio-el" src="${src}" type="${a.type || 'audio/webm'}"></audio></div>`;
        } else if (isImageAttachment) {
          // חלק תמונות (chat-ui.js) – הצגת תמונה inline | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור תמונה מצורפת | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'image', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderImageAttachment === 'function'
            ? App.renderImageAttachment(a)
            : `<img src="${src}" alt="${a.name || 'תמונה'}" class="chat-message__image" loading="lazy">`;
        } else if (isVideoAttachment) {
          // חלק וידאו (chat-ui.js) – נגן וידאו מוטמע | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור וידאו מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'video', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderVideoAttachment === 'function'
            ? App.renderVideoAttachment(a)
            : `<video src="${src}" controls class="chat-message__video"></video>`;
        } else if (typeof App.isPdfAttachment === 'function' && App.isPdfAttachment(a)) {
          // חלק PDF (chat-ui.js) – תצוגה מקדימה של PDF עם רנדור עמוד ראשון בסגנון WhatsApp | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור PDF מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'pdf', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderPdfAttachment === 'function'
            ? App.renderPdfAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-file-pdf"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'PDF') : (a.name || 'PDF')}</div>`;
        } else if (typeof App.isHtmlAttachment === 'function' && App.isHtmlAttachment(a)) {
          // חלק HTML (chat-ui.js) – תצוגה מקדימה של דף HTML ב-iframe sandbox בסגנון PDF | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור HTML מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'html', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderHtmlAttachment === 'function'
            ? App.renderHtmlAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-code"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'HTML') : (a.name || 'HTML')}</div>`;
        } else if (typeof App.isGenericFileAttachment === 'function' && App.isGenericFileAttachment(a)) {
          // חלק קובץ כללי (chat-ui.js) – רנדור בועת קובץ מעוצבת לקבצי ZIP/TXT/טורנט | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור קובץ כללי מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'file', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderGenericFileAttachment === 'function'
            ? App.renderGenericFileAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-file"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'קובץ') : (a.name || 'קובץ')}</div>`;
        } else if (src) {
          const fileName = a.name || 'קובץ מצורף';
          const safeFileName = App.escapeHtml ? App.escapeHtml(fileName) : fileName;
          const extraAttrs = a.url ? 'target="_blank" rel="noopener noreferrer"' : '';
          // חלק דיבאג מדיה (chat-ui.js) – fallback ללינק מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'link', name: fileName, mime: a?.type || '', src });
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
          // חלק דיבאג מדיה (chat-ui.js) – זיהוי YouTube בטקסט | HYPER CORE TECH
          mediaDebugLog('message-youtube-detect', { messageId: message.id, videoId });
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
        // חלק דיבאג מדיה (chat-ui.js) – רינדור מדיה מתוך URLs | HYPER CORE TECH
        if (mediaItems.length) {
          mediaDebugLog('message-media-urls', { messageId: message.id, count: mediaItems.length });
        }
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
      
      // חלק סטטוס הודעות ואטסאפ (chat-ui.js) – וי כפול כמו ואטסאפ | HYPER CORE TECH
      let statusHtml = '';
      if (isOutgoing) {
        const status = message.status || 'sent';
        if (status === 'sending') {
          statusHtml = '<span class="chat-message__status chat-message__status--sending" title="שולח..."><i class="fa-solid fa-clock"></i></span>';
        } else if (status === 'sent') {
          statusHtml = '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>';
        } else if (status === 'read') {
          statusHtml = '<span class="chat-message__status chat-message__status--read" title="נקרא"><i class="fa-solid fa-check-double"></i></span>';
        } else if (status === 'failed') {
          statusHtml = '<span class="chat-message__status chat-message__status--failed" title="שליחה נכשלה"><i class="fa-solid fa-exclamation-circle"></i></span>';
        }
      }
      
      // חלק meta בתוך נגן (chat-ui.js) – הסתרת meta-row לאודיו והזרקה לתוך הנגן | HYPER CORE TECH
      const hideMetaForAudio = isAudioAttachment && !textHtml && !youtubeHtml && !mediaUrlHtml;
      const metaRowHtml = hideMetaForAudio ? '' : `
          <div class="chat-message__meta-row">
            <span class="chat-message__meta">${formatMessageTime(messageTimestamp)}</span>
            ${statusHtml}
          </div>
      `;
      
      item.innerHTML = `
        ${avatarHtml}
        ${deleteButtonHtml}
        <div class="${contentClassName}" data-chat-message="${message.id}">
          ${textHtml}
          ${attachmentHtml}
          ${youtubeHtml}
          ${mediaUrlHtml}
          ${metaRowHtml}
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
      // חלק הזרקת meta לנגן (chat-ui.js) – הזרקת שעה וסטטוס לתוך נגן האודיו | HYPER CORE TECH
      if (hideMetaForAudio && contentEl) {
        const metaSlot = contentEl.querySelector('.chat-audio-whatsapp__meta-slot');
        if (metaSlot) {
          metaSlot.innerHTML = `<span class="chat-audio-whatsapp__msg-time">${formatMessageTime(messageTimestamp)}</span>${statusHtml}`;
        }
        // חלק הזרקת תמונת פרופיל לנגן (chat-ui.js) – הזרקת avatar לתוך נגן האודיו | HYPER CORE TECH
        const avatarSlot = contentEl.querySelector('.chat-audio-whatsapp__avatar-slot');
        if (avatarSlot) {
          let playerAvatarHtml = '';
          if (isOutgoing) {
            // תמונת פרופיל של המשתמש הנוכחי - חיפוש במקומות שונים
            const myPubkey = App.publicKey?.toLowerCase?.();
            const myContact = myPubkey && App.chatState?.contacts?.get?.(myPubkey);
            const myName = App.userName || App.userDisplayName || App.profile?.name || myContact?.name || 'אני';
            const safeName = App.escapeHtml ? App.escapeHtml(myName) : myName;
            const myInitials = typeof App.getInitials === 'function' ? App.getInitials(myName) : myName.slice(0, 2);
            const safeInitials = App.escapeHtml ? App.escapeHtml(myInitials) : myInitials;
            // חיפוש תמונת פרופיל במקומות שונים
            const myPicture = App.userPicture || App.userAvatar || App.profile?.picture || App.profile?.image || myContact?.picture || null;
            playerAvatarHtml = myPicture
              ? `<img src="${myPicture}" alt="${safeName}" class="chat-audio-whatsapp__avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add('chat-audio-whatsapp__avatar--initials'); this.outerHTML='<span class=\\'chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials\\'>${safeInitials}</span>';">`
              : `<span class="chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials">${safeInitials}</span>`;
          } else {
            // תמונת פרופיל של איש הקשר
            const normalizedFrom = message.from?.toLowerCase?.();
            const contact = normalizedFrom && App.chatState?.contacts?.get?.(normalizedFrom);
            const fallbackName = contact?.name || (normalizedFrom ? `משתמש ${normalizedFrom.slice(0, 8)}` : 'משתמש');
            const safeName = App.escapeHtml ? App.escapeHtml(fallbackName) : fallbackName;
            const initialsValue = contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
            const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
            playerAvatarHtml = contact?.picture
              ? `<img src="${contact.picture}" alt="${safeName}" class="chat-audio-whatsapp__avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add('chat-audio-whatsapp__avatar--initials'); this.outerHTML='<span class=\\'chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials\\'>${safeInitials}</span>';">`
              : `<span class="chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials">${safeInitials}</span>`;
          }
          avatarSlot.innerHTML = playerAvatarHtml;
        }
      }
      fragment.appendChild(item);
    });
    elements.messagesContainer.appendChild(fragment);

    // חלק סנכרון כפתור טורנט (chat-ui.js) – מניעת הורדות חוזרות מהיסטוריה אחרי אתחול שיחה | HYPER CORE TECH
    syncTorrentDownloadButtons();

    // חלק גלילה לתחתית (chat-ui.js) – גלילה מושהית כדי לוודא שהדפדפן סיים לרנדר את כל ההודעות | HYPER CORE TECH
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (elements.messagesContainer) {
          elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
        }
      }, 50);
    });

    // חלק צ'אט (chat-ui.js) – הבטחת איפוס מונה לא נקראים כשצופים בשיחה בפועל | HYPER CORE TECH
    const activeNormalized = (state.activeContact || '').toLowerCase();
    const normalized = (peerPubkey || '').toLowerCase();
    if (activeNormalized && normalized && activeNormalized === normalized && typeof App.markChatConversationRead === 'function') {
      App.markChatConversationRead(normalized);
    }
  }

  // חלק הוספת הודעה בודדת (chat-ui.js) – מוסיף הודעה ל-UI ללא רינדור מחדש של הכל | HYPER CORE TECH
  function appendSingleMessage(message) {
    if (!elements.messagesContainer) return;
    
    // הסר הודעת "אין הודעות" אם קיימת
    const emptyMsg = elements.messagesContainer.querySelector('.chat-conversation__empty');
    if (emptyMsg) emptyMsg.remove();
    
    const item = doc.createElement('div');
    const isOutgoing = message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
    const safeContent = App.escapeHtml ? App.escapeHtml(message.content) : message.content;
    const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
    
    // סטטוס הודעה בסגנון ואטסאפ
    let statusHtml = '';
    if (isOutgoing) {
      const status = message.status || 'sent';
      if (status === 'sending') {
        statusHtml = '<span class="chat-message__status chat-message__status--sending" title="שולח..."><i class="fa-solid fa-clock"></i></span>';
      } else if (status === 'sent') {
        statusHtml = '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'failed') {
        statusHtml = '<span class="chat-message__status chat-message__status--failed" title="שליחה נכשלה"><i class="fa-solid fa-exclamation-circle"></i></span>';
      }
    }

    const deleteButtonHtml = isOutgoing
      ? `
          <button type="button" class="chat-message__delete" data-chat-delete="${message.id}" aria-label="מחק הודעה">
            <i class="fa-solid fa-trash"></i>
          </button>
        `
      : '';
    
    item.className = `chat-message ${directionClass}`;
    item.setAttribute('data-message-id', message.id);
    
    const contentClass = safeContent.length <= 60 && !safeContent.includes('\n') 
      ? 'chat-message__content chat-message__content--compact-meta' 
      : 'chat-message__content';
    
    item.innerHTML = `
      <div class="${contentClass}" data-chat-message="${message.id}">
        <span class="chat-message__text">${safeContent.replace(/\n/g, '<br>')}</span>
        <div class="chat-message__meta-row">
          <span class="chat-message__meta">${formatMessageTime(messageTimestamp)}</span>
          ${statusHtml}
        </div>
      </div>
      ${deleteButtonHtml}
    `;
    
    elements.messagesContainer.appendChild(item);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
  }

  // חלק עדכון סטטוס הודעה (chat-ui.js) – מעדכן סטטוס הודעה קיימת ללא רינדור מחדש | HYPER CORE TECH
  function updateMessageStatus(tempId, newStatus, realId) {
    if (!elements.messagesContainer) return;
    
    const messageEl = elements.messagesContainer.querySelector(`[data-message-id="${tempId}"]`);
    if (!messageEl) return;
    
    // עדכן ID אם קיבלנו ID אמיתי
    if (realId) {
      messageEl.setAttribute('data-message-id', realId);
      const contentEl = messageEl.querySelector('[data-chat-message]');
      if (contentEl) contentEl.setAttribute('data-chat-message', realId);
    }
    
    // עדכן אייקון סטטוס בסגנון ואטסאפ
    const statusEl = messageEl.querySelector('.chat-message__status');
    if (statusEl) {
      statusEl.className = `chat-message__status chat-message__status--${newStatus}`;
      if (newStatus === 'sent') {
        statusEl.innerHTML = '<i class="fa-solid fa-check-double"></i>';
        statusEl.title = 'נשלח';
      } else if (newStatus === 'failed') {
        statusEl.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i>';
        statusEl.title = 'שליחה נכשלה';
      }
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
    // חלק סטטוס P2P (chat-ui.js) – מציג מצב חיבור DC בכותרת שיחה כדי שהמשתמש ידע אם ההודעות עוברות P2P | HYPER CORE TECH
    if (elements.conversationStatus) {
      updateConversationDCStatus(peerPubkey);
    }
    renderMessages(peerPubkey);
    App.markChatConversationRead(peerPubkey);
    if (typeof App.setChatFileTransferActivePeer === 'function') {
      App.setChatFileTransferActivePeer(peerPubkey);
    }
    // חלק P2P DataChannel (chat-ui.js) – חיבור DataChannel כשפותחים שיחה | HYPER CORE TECH
    if (App.dataChannel && typeof App.dataChannel.connect === 'function') {
      App.dataChannel.connect(peerPubkey);
    }
  }

  // חלק סטטוס P2P (chat-ui.js) – עדכון תצוגת מצב DC בכותרת שיחה + רענון כל 3 שניות | HYPER CORE TECH
  let _dcStatusTimer = null;
  function updateConversationDCStatus(peerPubkey) {
    if (_dcStatusTimer) { clearInterval(_dcStatusTimer); _dcStatusTimer = null; }
    const el = elements.conversationStatus;
    if (!el) return;
    const update = () => {
      const pk = peerPubkey || state.activeContact;
      if (!pk) { el.textContent = 'פעיל ברשת'; return; }
      const dcOn = App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(pk);
      el.innerHTML = dcOn
        ? '<span style="color:#25D366" title="חיבור ישיר P2P פעיל — הודעות עוברות ישירות">⚡ P2P ישיר</span>'
        : '<span title="הודעות עוברות דרך שרת relay">☁️ דרך שרת</span>';
    };
    update();
    _dcStatusTimer = setInterval(() => {
      if (state.activeContact) update(); else { clearInterval(_dcStatusTimer); _dcStatusTimer = null; }
    }, 3000);
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

  // חלק שליחה אופטימיסטית (chat-ui.js) – שליחה מיידית ללא המתנה לרשת | HYPER CORE TECH
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
    
    // 1. נקה input מיד - תגובה מיידית למשתמש
    const messageText = value;
    elements.messageInput.value = '';
    elements.messageInput.disabled = false;
    // חלק שמירת מקלדת (chat-ui.js) – שמירה על פוקוס ב-input אחרי שליחה כדי שהמקלדת תישאר פתוחה במובייל | HYPER CORE TECH
    elements.messageInput.focus();
    
    // 2. צור הודעה זמנית והצג מיד ב-UI
    const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const tempMessage = {
      id: tempId,
      from: App.publicKey,
      to: state.activeContact,
      content: messageText,
      createdAt: Math.floor(Date.now() / 1000),
      direction: 'outgoing',
      status: 'sending'
    };
    
    // הוסף הודעה ל-UI מיד (אופטימיסטי)
    appendSingleMessage(tempMessage);
    
    // 3. שלח ברקע - לא מחכים
    App.publishChatMessage(state.activeContact, messageText)
      .then((result) => {
        if (!result?.ok) {
          console.warn('Failed to send chat message', result?.error);
          updateMessageStatus(tempId, 'failed');
        } else {
          updateMessageStatus(tempId, 'sent', result.messageId);
        }
      })
      .catch((err) => {
        console.error('Chat send error', err);
        updateMessageStatus(tempId, 'failed');
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
      elements.navButton.addEventListener('click', () => {
        // בדיקת מצב אורח - חסימת הודעות למשתמשים לא מחוברים | HYPER CORE TECH
        if (App && typeof App.requireAuth === 'function') {
          if (!App.requireAuth('כדי לשלוח הודעות צריך להתחבר או להירשם.')) {
            return;
          }
        }
        // סגירת פאנל פרופיל אם פתוח | HYPER CORE TECH
        if (typeof App.closeProfilePanel === 'function') {
          App.closeProfilePanel();
        }
        
        // לוגיקה הגיונית: פתוח בשיחות→סגור, פתוח בהתראות→עבור לשיחות, סגור→פתח שיחות
        if (state.isOpen) {
          if (state.footerMode === 'contacts' || state.footerMode === 'home') {
            // כבר בטאב שיחות - סגור
            togglePanel(false);
          } else {
            // בטאב אחר (התראות) - עבור לשיחות
            setFooterMode('contacts');
            state.activeContact = null;
            resetConversationView();
            renderContacts();
            updatePanelMode(PANEL_MODES.LIST);
            // עדכון כפתור התראות
            if (elements.notificationsToggle) {
              elements.notificationsToggle.classList.remove('is-active');
            }
          }
        } else {
          // הפאנל סגור - פתח בטאב שיחות
          setFooterMode('contacts');
          togglePanel(true);
        }
      });
    }

    // חלק התראות (chat-ui.js) – המאזין לכפתור ההתראות מטופל על ידי feed.js שמפנה ל-openNotificationsPanel | HYPER CORE TECH
    // המאזין הוסר כדי למנוע כפילות - feed.js מטפל בלחיצה ומפנה לכאן דרך App.openNotificationsPanel

    if (elements.launcherButton) {
      elements.launcherButton.addEventListener('click', () => togglePanel());
    }
    if (elements.closeButton) {
      elements.closeButton.addEventListener('click', () => togglePanel(false));
    }
    // האזנה לכפתור סגירה החדש בסיידבר (דסקטופ) | HYPER CORE TECH
    const sidebarCloseBtn = doc.getElementById('chatSidebarCloseBtn');
    if (sidebarCloseBtn) {
      sidebarCloseBtn.addEventListener('click', () => togglePanel(false));
    }
    doc.addEventListener('click', (event) => {
      if (!state.isOpen) return;
      // חלק שיחות קול (chat-ui.js) – התעלמות מלחיצות על דיאלוג שיחת קול/וידיאו כדי לא לסגור את הצ'אט | HYPER CORE TECH
      const voiceCallDialog = doc.getElementById('voiceCallDialog');
      const videoCallDialog = doc.getElementById('videoCallDialog');
      if (voiceCallDialog && voiceCallDialog.contains(event.target)) return;
      if (videoCallDialog && videoCallDialog.contains(event.target)) return;
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
      // חלק אופטימיזציה (chat-ui.js) – debounce על חיפוש למניעת עומס | HYPER CORE TECH
      const debouncedSearch = debounce((value) => {
        state.filterText = value;
        renderContacts();
      }, 150);
      elements.searchInput.addEventListener('input', (event) => {
        debouncedSearch(event.target?.value || '');
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
    
    // האזנה לכפתורי סרגל הצד החדש | HYPER CORE TECH
    if (elements.navSidebarItems?.length) {
      elements.navSidebarItems.forEach((item) => {
        item.addEventListener('click', () => handleFooterNav(item));
      });
    }
    
    // עדכון תמונת פרופיל בסרגל הצד אם זמינה
    if (elements.navProfileImg && (App.userPicture || App.userAvatar)) {
      elements.navProfileImg.src = App.userPicture || App.userAvatar;
    }
    
    // חלק אטב אחיד (chat-ui.js) – כפתור טורנט נפרד הוסר — הכל עובר דרך כפתור אטב | HYPER CORE TECH
    if (elements.torrentSendButton) {
      elements.torrentSendButton.style.display = 'none';
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
      // חלק סינון הודעות ישנות (chat-ui.js) – התראה רק על הודעות מ-60 שניות אחרונות | HYPER CORE TECH
      const messageCreatedAt = message?.createdAt || message?.created_at || 0;
      const messageAgeSec = Math.floor(Date.now() / 1000) - messageCreatedAt;
      const isRecentMessage = messageAgeSec >= 0 && messageAgeSec < 60; // פחות מ-60 שניות
      
      if (isIncoming && !wasMessageNotified(messageId) && isRecentMessage) {
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
    renderContacts(true); // force render בטעינה ראשונה
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
    // רישום SW והאזנה להודעות ממנו (בקשת הרשאות רק בלחיצה על פאנל הצ'אט)
    registerChatServiceWorkerIfSupported();
    initChatServiceWorkerMessageHandling();
    updatePanelMode(PANEL_MODES.LIST);
  }

  // חלק צ'אט (chat-ui.js) – מאפשר למודולים חיצוניים (למשל התרעות) לסגור את חלון הצ'אט במעבר בין פאנלים
  App.closeChatPanel = function closeChatPanel() {
    togglePanel(false);
  };

  App.toggleChatPanel = togglePanel;

  // חלק התראות (chat-ui.js) – חשיפת פונקציות שליטה בפאנל ההתראות | HYPER CORE TECH
  App.openNotificationsPanel = function openNotificationsPanel() {
    // וידוא שהפאנל פתוח
    if (!state.isOpen) {
      togglePanel(true);
    }
    // מעבר למצב התראות
    setFooterMode('notifications');
    // הצגת התצוגה
    showNotificationsView();
    // עדכון כפתור הניווט הראשי
    if (elements.notificationsToggle) {
      elements.notificationsToggle.setAttribute('aria-pressed', 'true');
      elements.notificationsToggle.classList.add('is-active');
    }
  };

  App.closeNotificationsPanel = function closeNotificationsPanel() {
    if (elements.notificationsToggle) {
      elements.notificationsToggle.setAttribute('aria-pressed', 'false');
      elements.notificationsToggle.classList.remove('is-active');
    }
    // אם אנחנו במצב התראות, סגור את הפאנל
    if (state.isOpen && state.footerMode === 'notifications') {
      togglePanel(false);
    }
  };

  // חלק צ'אט (chat-ui.js) – חשיפת פונקציה לקבלת המשתמש הפעיל בשיחה
  App.getActiveChatContact = function getActiveChatContact() {
    return state.activeContact;
  };
  // חלק P2P DataChannel (chat-ui.js) – alias עבור מודול DataChannel reconnect | HYPER CORE TECH
  App.getActiveChatPeer = App.getActiveChatContact;

  // חלק צ'אט (chat-ui.js) – חשיפת פונקציה לפתיחת שיחה ספציפית (לשימוש בסיום שיחת קול) | HYPER CORE TECH
  App.showChatConversation = function showChatConversationExternal(peerPubkey) {
    if (!peerPubkey) return;
    const contact = App.chatState?.contacts?.get(peerPubkey.toLowerCase());
    showConversation(peerPubkey, contact);
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

  // חלק אטב אחיד (chat-ui.js) – openTorrentSendDialog הוסר — הכל עובר דרך כפתור אטב אחיד | HYPER CORE TECH
  App.openTorrentSendDialog = function openTorrentSendDialog() {
    console.log('[CHAT] openTorrentSendDialog הוסר — השתמש בכפתור אטב');
  };

  // חלק WebTorrent (chat-ui.js) – זיהוי הודעות WebTorrent נכנסות | HYPER CORE TECH
  App.handleIncomingChatMessage = function handleIncomingChatMessage(fromPeer, content) {
    // בדיקה אם זו הודעת בקשת העברה
    if (typeof App.torrentTransfer?.parseTransferMessage === 'function') {
      const handled = App.torrentTransfer.parseTransferMessage(content, fromPeer);
      if (handled) return true; // ההודעה טופלה כבקשת העברה
    }
    return false;
  };

  // חשיפת מצב הפאנל ל-feed.js עבור לוגיקת התראות | HYPER CORE TECH
  Object.defineProperty(App.chatState, 'isOpen', {
    get: () => state.isOpen,
    enumerable: true
  });
  Object.defineProperty(App.chatState, 'footerMode', {
    get: () => state.footerMode,
    enumerable: true
  });

  initializeUI();
  togglePanel(false);
  ensureChatEnabled();
})(window);
