(function initChatUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  // חלק צ'אט (chat-ui.js) – מוודא שקיימת סביבת צ'אט
  if (!App.chatState) {
    console.warn('Chat state not initialized – chat UI skipped');
    return;
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
  };

  let unsubscribeNotifications = null; // חלק צ'אט (chat-ui.js) – מחזיק ביטול הרשמה לעדכוני התרעות עבור ניקוי משאבים
  let notificationSubscribeTimer = null; // חלק צ'אט (chat-ui.js) – טיימר לגיבוי כאשר feed.js נטען מאוחר יותר

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
    const previewSource = contact.lastMessage ? contact.lastMessage.replace(/\s+/g, ' ').trim().slice(0, 60) : 'אין הודעות עדיין';
    const safePreview = App.escapeHtml ? App.escapeHtml(previewSource) : previewSource;
    const badgeHtml = contact.unreadCount
      ? `<span class="chat-contact__badge">${contact.unreadCount > 99 ? '99+' : contact.unreadCount}</span>`
      : '';
    const activeClass = state.activeContact === contact.pubkey ? ' chat-contact--active' : '';
    const avatarHtml = contact.picture
      ? `<span class="chat-contact__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-contact__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
      : `<span class="chat-contact__avatar chat-contact__avatar--initials" title="${safeName}">${safeInitials}</span>`;

    return `
      <article class="chat-contact${activeClass}" data-chat-contact="${contact.pubkey}">
        ${avatarHtml}
        <div class="chat-contact__body">
          <div class="chat-contact__row">
            <span class="chat-contact__name">${safeName}</span>
            ${badgeHtml}
          </div>
          <span class="chat-contact__last-message">${safePreview}</span>
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
    messages.forEach((message) => {
      const item = doc.createElement('div');
      const isOutgoing =
        message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
      const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
      const safeContent = App.escapeHtml ? App.escapeHtml(message.content) : message.content;

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

      // תמיכה בהצגת אודיו: זיהוי אמין לפי MIME/נתיב/סיומת
      let attachmentHtml = '';
      let isAudioAttachment = false;
      const a = message.attachment || null;
      if (a) {
        const src = a.url || a.dataUrl || '';
        const mime = (a.type || '').toLowerCase();
        const fromSrc = /^data:audio\//i.test(src);
        const byExt = /\.(webm|mp3|m4a|ogg|wav)(\?|$)/i.test(src || a.name || '');
        isAudioAttachment = (mime.startsWith('audio/') || fromSrc || byExt) && !!src;
        if (isAudioAttachment) {
          const dur = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null;
          const mm = dur !== null ? Math.floor(dur / 60) : null;
          const ss = dur !== null ? String(dur % 60).padStart(2, '0') : null;
          const durationLabel = dur !== null ? `${mm}:${ss}` : '';
          attachmentHtml = `
            <div class="chat-message__audio" data-audio>
              <audio preload="metadata" class="chat-message__audio-el" src="${src}" type="${a.type || 'audio/webm'}"></audio>
              <div class="chat-audio">
                <button type="button" class="chat-audio__play" aria-label="נגן">
                  <i class="fa-solid fa-play"></i>
                </button>
                <span class="chat-audio__time chat-audio__time--current">0:00</span>
                <div class="chat-audio__bar">
                  <div class="chat-audio__progress" style="width:0%"></div>
                </div>
                <span class="chat-audio__time chat-audio__time--total">${durationLabel}</span>
              </div>
            </div>
          `;
        } else if (a.dataUrl) {
          attachmentHtml = `
            <a class="chat-message__attachment" href="${a.dataUrl}" download="${a.name || 'file'}">
              <i class="fa-solid fa-paperclip"></i>
              <span>${App.escapeHtml ? App.escapeHtml(a.name || 'קובץ מצורף') : a.name || 'קובץ מצורף'}</span>
            </a>
          `;
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
      const textHtml = safeContent && !isAudioAttachment
        ? `<span class="chat-message__text">${safeContent.replace(/\n/g, '<br>')}</span>`
        : '';
      item.innerHTML = `
        ${avatarHtml}
        <div class="chat-message__content" data-chat-message="${message.id}">
          ${textHtml}
          ${attachmentHtml}
          <div class="chat-message__meta-row">
            <span class="chat-message__meta">${formatTimestamp(message.createdAt || Math.floor(Date.now() / 1000))}</span>
            ${deleteButtonHtml}
          </div>
        </div>
      `;
      // חיבור לוגיקת נגן מותאם בסגנון וואטסאפ
      if (isAudioAttachment) {
        const contentEl = item.querySelector('[data-chat-message]');
        const wrap = contentEl?.querySelector('[data-audio]');
        const audio = wrap?.querySelector('.chat-message__audio-el');
        const btn = wrap?.querySelector('.chat-audio__play');
        const bar = wrap?.querySelector('.chat-audio__bar');
        const progress = wrap?.querySelector('.chat-audio__progress');
        const curEl = wrap?.querySelector('.chat-audio__time--current');
        const totalEl = wrap?.querySelector('.chat-audio__time--total');
        const format = (sec)=>{
          const s = Math.max(0, Math.round(sec||0));
          return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
        };
        if (audio && btn && bar && progress && curEl && totalEl) {
          audio.addEventListener('loadedmetadata', ()=>{
            if (!totalEl.textContent) totalEl.textContent = format(audio.duration||0);
          });
          const toggle = ()=>{
            if (audio.paused) { audio.play(); btn.innerHTML = '<i class="fa-solid fa-pause"></i>'; }
            else { audio.pause(); btn.innerHTML = '<i class="fa-solid fa-play"></i>'; }
          };
          btn.addEventListener('click', toggle);
          audio.addEventListener('timeupdate', ()=>{
            const d = Math.max(1, audio.duration||1);
            const p = Math.min(100, (audio.currentTime/d)*100);
            progress.style.width = p + '%';
            curEl.textContent = format(audio.currentTime);
          });
          audio.addEventListener('ended', ()=>{
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
          });
          // קפיצה בפס
          bar.addEventListener('click', (e)=>{
            const rect = bar.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            audio.currentTime = ratio * (audio.duration||0);
          });
        }
      }
      fragment.appendChild(item);
    });
    elements.messagesContainer.appendChild(fragment);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
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
        renderContacts();
        ensureChatEnabled();
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
    App.subscribeChat?.('message', ({ peer }) => {
      if (!peer) return;
      if (peer === state.activeContact) {
        renderMessages(peer);
        App.markChatConversationRead(peer);
      } else {
        renderContacts();
      }
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

  initializeUI();
  togglePanel(false);
  ensureChatEnabled();
})(window);
