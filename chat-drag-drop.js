// =====================================================================================
// חלק Drag & Drop (chat-drag-drop.js) – גרירת קבצים לשיחה בדסקטופ בלבד (סגנון WhatsApp) | HYPER CORE TECH
// מובייל: ללא listeners פעילים / ללא overlay. דסקטופ: overlay + תצוגה מקדימה קיימת.
// =====================================================================================
(function initChatDragDrop(window) {
  'use strict';
  var App = window.NostrApp || (window.NostrApp = {});
  var doc = window.document;

  var dragCounter = 0;
  var dropOverlayEl = null;
  var hoverContactEl = null;

  function isDesktop() {
    return window.matchMedia && window.matchMedia('(min-width: 769px)').matches;
  }

  function hasFiles(dt) {
    if (!dt || !dt.types) return false;
    try {
      if (typeof dt.types.includes === 'function') return dt.types.includes('Files');
      return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
    } catch (_) {
      return false;
    }
  }

  function conversationEl() {
    return doc.querySelector('#chatPanel .chat-conversation') ||
      doc.querySelector('.chat-panel .chat-conversation') ||
      null;
  }

  function contactFromEvent(e) {
    var t = e.target;
    if (!t || !t.closest) return null;
    return t.closest('.chat-contact[data-chat-contact]');
  }

  function clearContactHover() {
    if (hoverContactEl) {
      hoverContactEl.classList.remove('is-file-drop-hover');
      hoverContactEl = null;
    }
  }

  function setContactHover(el) {
    if (hoverContactEl === el) return;
    clearContactHover();
    if (el) {
      el.classList.add('is-file-drop-hover');
      hoverContactEl = el;
    }
  }

  function ensureOverlay() {
    if (dropOverlayEl && dropOverlayEl.isConnected) return dropOverlayEl;
    dropOverlayEl = doc.createElement('div');
    dropOverlayEl.className = 'chat-drop-overlay';
    dropOverlayEl.setAttribute('aria-hidden', 'true');
    dropOverlayEl.innerHTML =
      '<div class="chat-drop-overlay__content">' +
      '<span class="chat-drop-overlay__text">\u05D2\u05E8\u05D5\u05E8/\u05D9 \u05D0\u05EA \u05D4\u05E7\u05D5\u05D1\u05E5 \u05DC\u05DB\u05D0\u05DF</span>' +
      '</div>';
    return dropOverlayEl;
  }

  function showConversationOverlay() {
    var conv = conversationEl();
    if (!conv) return;
    var el = ensureOverlay();
    if (el.parentNode !== conv) {
      if (getComputedStyle(conv).position === 'static') {
        conv.style.position = 'relative';
      }
      conv.appendChild(el);
    }
    el.classList.add('is-visible');
    el.setAttribute('aria-hidden', 'false');
  }

  function hideConversationOverlay() {
    if (dropOverlayEl) {
      dropOverlayEl.classList.remove('is-visible');
      dropOverlayEl.setAttribute('aria-hidden', 'true');
    }
  }

  function resetDragUi() {
    dragCounter = 0;
    hideConversationOverlay();
    clearContactHover();
  }

  function openSendPreview(file) {
    if (!file) return;
    if (typeof App.openChatSendPreview === 'function') {
      App.openChatSendPreview(file);
      return;
    }
    if (typeof App.handleChatFileSelection === 'function') {
      App.handleChatFileSelection(file);
    }
  }

  function openChatThenPreview(pubkey, file) {
    var normalized = String(pubkey || '').toLowerCase();
    if (!normalized || !file) return;
    try {
      if (typeof App.ensureChatContact === 'function') App.ensureChatContact(normalized);
    } catch (_) {}
    if (typeof App.showChatConversation === 'function') {
      App.showChatConversation(normalized);
    }
    // ממתינים לרענון DOM של השיחה לפני מסך התצוגה | HYPER CORE TECH
    window.setTimeout(function () {
      openSendPreview(file);
    }, 80);
  }

  function onDragEnter(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter += 1;
    var contact = contactFromEvent(e);
    if (contact) {
      hideConversationOverlay();
      setContactHover(contact);
    } else if (conversationEl() && conversationEl().contains(e.target)) {
      clearContactHover();
      showConversationOverlay();
    } else {
      // גרירה מעל פאנל הצ'אט (כולל רשימה) – מציגים overlay רק מעל אזור השיחה הפעיל
      var peer = App.chatState && App.chatState.activeContact;
      if (peer) showConversationOverlay();
    }
  }

  function onDragOver(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    var contact = contactFromEvent(e);
    if (contact) {
      hideConversationOverlay();
      setContactHover(contact);
    } else if (conversationEl() && conversationEl().contains(e.target)) {
      clearContactHover();
      showConversationOverlay();
    }
  }

  function onDragLeave(e) {
    if (!isDesktop()) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter -= 1;
    if (dragCounter <= 0) resetDragUi();
  }

  function onDrop(e) {
    if (!isDesktop()) return;
    e.preventDefault();
    e.stopPropagation();
    var contact = contactFromEvent(e);
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    resetDragUi();
    if (!file) return;

    if (contact) {
      var pk = contact.getAttribute('data-chat-contact');
      if (pk) {
        openChatThenPreview(pk, file);
        return;
      }
    }

    // שחרור באזור השיחה – דורש שיחה פעילה | HYPER CORE TECH
    var peer = App.chatState && App.chatState.activeContact;
    if (!peer) {
      console.warn('[DRAG-DROP] no active chat');
      return;
    }
    var conv = conversationEl();
    if (conv && !conv.contains(e.target) && !contact) {
      // drop מחוץ לשיחה ולאיש קשר – מתעלמים
      return;
    }
    openSendPreview(file);
  }

  function setupChatDragDrop() {
    var chatPanel = doc.getElementById('chatPanel');
    if (!chatPanel) {
      console.warn('[DRAG-DROP] chatPanel not found');
      return;
    }
    if (chatPanel.getAttribute('data-chat-dnd') === '1') return;
    chatPanel.setAttribute('data-chat-dnd', '1');

    chatPanel.addEventListener('dragenter', onDragEnter);
    chatPanel.addEventListener('dragover', onDragOver);
    chatPanel.addEventListener('dragleave', onDragLeave);
    chatPanel.addEventListener('drop', onDrop);

    window.addEventListener('resize', function () {
      if (!isDesktop()) resetDragUi();
    });

    console.log('[DRAG-DROP] initialized (desktop-only)');
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', setupChatDragDrop);
  } else {
    setTimeout(setupChatDragDrop, 200);
  }

  App.setupChatDragDrop = setupChatDragDrop;
})(window);
