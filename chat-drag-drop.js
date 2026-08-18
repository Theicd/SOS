// =====================================================================================
// חלק Drag & Drop (chat-drag-drop.js) – גרירת קבצים לשיחה בדסקטופ בלבד | HYPER CORE TECH
// =====================================================================================
(function initChatDragDrop(window) {
  'use strict';
  var App = window.NostrApp || (window.NostrApp = {});
  var doc = window.document;

  var dropOverlayEl = null;
  var hoverContactEl = null;
  var lastZone = null; // 'conversation' | 'contact'
  var lastContactPk = null;
  var leaveTimer = 0;
  var dropLock = false;

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

  function getActivePeer() {
    try {
      if (typeof App.getActiveChatContact === 'function') {
        var a = App.getActiveChatContact();
        if (a) return String(a).toLowerCase();
      }
      if (typeof App.getActiveChatPeer === 'function') {
        var b = App.getActiveChatPeer();
        if (b) return String(b).toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function chatPanelEl() {
    return doc.getElementById('chatPanel');
  }

  function conversationEl() {
    return doc.querySelector('#chatPanel .chat-conversation') ||
      doc.querySelector('.chat-panel .chat-conversation') ||
      null;
  }

  function contactFromEvent(e) {
    var t = e && e.target;
    if (!t || !t.closest) return null;
    return t.closest('.chat-contact[data-chat-contact]');
  }

  function pointInRect(x, y, rect) {
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isOverConversation(e) {
    var conv = conversationEl();
    if (!conv) return false;
    var t = e && e.target;
    if (t && t.closest) {
      if (t.closest('.chat-drop-overlay')) return true;
      if (t.closest('.chat-conversation')) return true;
    }
    if (typeof e.clientX === 'number') {
      return pointInRect(e.clientX, e.clientY, conv.getBoundingClientRect());
    }
    return false;
  }

  function clearLeaveTimer() {
    if (leaveTimer) {
      window.clearTimeout(leaveTimer);
      leaveTimer = 0;
    }
  }

  function clearContactHover() {
    if (hoverContactEl) {
      hoverContactEl.classList.remove('is-file-drop-hover');
      hoverContactEl = null;
    }
  }

  function hideOverlay() {
    if (dropOverlayEl) {
      dropOverlayEl.classList.remove('is-visible');
      dropOverlayEl.setAttribute('aria-hidden', 'true');
    }
  }

  function resetDragUi() {
    hideOverlay();
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
    window.setTimeout(function () {
      openSendPreview(file);
    }, 80);
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
    // overlay קולט את ה־drop ישירות | HYPER CORE TECH
    dropOverlayEl.addEventListener('dragenter', function (ev) {
      if (!isDesktop()) return;
      ev.preventDefault();
      ev.stopPropagation();
      clearLeaveTimer();
      lastZone = 'conversation';
      lastContactPk = null;
    });
    dropOverlayEl.addEventListener('dragover', function (ev) {
      if (!isDesktop()) return;
      ev.preventDefault();
      ev.stopPropagation();
      clearLeaveTimer();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      lastZone = 'conversation';
      lastContactPk = null;
    });
    dropOverlayEl.addEventListener('drop', handleDrop);
    return dropOverlayEl;
  }

  function showConversationOverlay() {
    var conv = conversationEl();
    if (!conv) return;
    var el = ensureOverlay();
    if (el.parentNode !== conv) {
      if (window.getComputedStyle(conv).position === 'static') {
        conv.style.position = 'relative';
      }
      conv.appendChild(el);
    }
    el.classList.add('is-visible');
    el.setAttribute('aria-hidden', 'false');
  }

  function updateZoneFromEvent(e) {
    clearLeaveTimer();
    var contact = contactFromEvent(e);
    if (contact) {
      lastZone = 'contact';
      lastContactPk = contact.getAttribute('data-chat-contact');
      hideOverlay();
      if (hoverContactEl !== contact) {
        clearContactHover();
        contact.classList.add('is-file-drop-hover');
        hoverContactEl = contact;
      }
      return;
    }
    if (isOverConversation(e) || getActivePeer()) {
      // מעל אזור השיחה (או שיחה פתוחה בזמן גרירה בפאנל) | HYPER CORE TECH
      if (isOverConversation(e)) {
        lastZone = 'conversation';
        lastContactPk = null;
        clearContactHover();
        showConversationOverlay();
      }
    }
  }

  function onDragEnter(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    updateZoneFromEvent(e);
  }

  function onDragOver(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    updateZoneFromEvent(e);
  }

  function onDragLeave(e) {
    if (!isDesktop()) return;
    var panel = chatPanelEl();
    var related = e.relatedTarget;
    // עדיין בתוך הפאנל / overlay – לא מאפסים lastZone | HYPER CORE TECH
    if (panel && related && panel.contains(related)) return;
    if (dropOverlayEl && related && dropOverlayEl.contains(related)) return;
    clearLeaveTimer();
    leaveTimer = window.setTimeout(function () {
      leaveTimer = 0;
      resetDragUi();
      lastZone = null;
      lastContactPk = null;
    }, 120);
  }

  function handleDrop(e) {
    if (!isDesktop()) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropLock) return;
    dropLock = true;
    window.setTimeout(function () { dropLock = false; }, 400);

    clearLeaveTimer();
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    var contact = contactFromEvent(e);
    var zone = lastZone;
    var pk = lastContactPk;

    if (!zone && contact) {
      zone = 'contact';
      pk = contact.getAttribute('data-chat-contact');
    }
    // אם lastZone נמחק בטעות – עדיין מזהים לפי מיקום/overlay | HYPER CORE TECH
    if (!zone && isOverConversation(e)) zone = 'conversation';
    if (!zone && dropOverlayEl && dropOverlayEl.classList.contains('is-visible')) {
      zone = 'conversation';
    }

    resetDragUi();
    var savedZone = zone;
    var savedPk = pk;
    lastZone = null;
    lastContactPk = null;

    if (!file) {
      console.warn('[DRAG-DROP] drop without file');
      return;
    }

    if (savedZone === 'contact' && savedPk) {
      openChatThenPreview(savedPk, file);
      return;
    }

    if (savedZone === 'conversation') {
      var peer = getActivePeer();
      if (!peer) {
        console.warn('[DRAG-DROP] no active chat on conversation drop');
        return;
      }
      // השהייה אחרי סיום אירוע ה־drop – כמו נתיב איש קשר | HYPER CORE TECH
      window.setTimeout(function () {
        openSendPreview(file);
      }, 80);
      return;
    }

    console.warn('[DRAG-DROP] drop ignored, zone=', savedZone);
  }

  function setupChatDragDrop() {
    var chatPanel = chatPanelEl();
    if (!chatPanel) {
      console.warn('[DRAG-DROP] chatPanel not found');
      return;
    }
    if (chatPanel.getAttribute('data-chat-dnd') === '1') return;
    chatPanel.setAttribute('data-chat-dnd', '1');

    chatPanel.addEventListener('dragenter', onDragEnter, true);
    chatPanel.addEventListener('dragover', onDragOver, true);
    chatPanel.addEventListener('dragleave', onDragLeave, true);
    chatPanel.addEventListener('drop', handleDrop, true);

    // גם ברמת המסמך – למקרה שהדפדפן בולע drop על הילד | HYPER CORE TECH
    doc.addEventListener('dragover', function (e) {
      if (!isDesktop()) return;
      if (!chatPanelEl() || chatPanelEl().hasAttribute('hidden')) return;
      if (!hasFiles(e.dataTransfer)) return;
      if (!getActivePeer() && !contactFromEvent(e)) return;
      e.preventDefault();
    }, true);

    window.addEventListener('resize', function () {
      if (!isDesktop()) resetDragUi();
    });

    console.log('[DRAG-DROP] initialized (desktop-only, zone-safe)');
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', setupChatDragDrop);
  } else {
    setTimeout(setupChatDragDrop, 200);
  }

  App.setupChatDragDrop = setupChatDragDrop;
})(window);
