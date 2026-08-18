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
  // אזור גרירה אחרון – לא לסמוך רק על e.target ב־drop | HYPER CORE TECH
  var lastZone = null; // 'conversation' | 'contact' | null
  var lastContactPk = null;

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
        var fromApi = App.getActiveChatContact();
        if (fromApi) return String(fromApi).toLowerCase();
      }
      if (typeof App.getActiveChatPeer === 'function') {
        var fromPeer = App.getActiveChatPeer();
        if (fromPeer) return String(fromPeer).toLowerCase();
      }
    } catch (_) {}
    return '';
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

  function pointInRect(x, y, rect) {
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isOverConversation(e) {
    var conv = conversationEl();
    if (!conv) return false;
    if (e.target && e.target.closest && e.target.closest('.chat-conversation')) return true;
    if (e.target && e.target.closest && e.target.closest('.chat-drop-overlay')) return true;
    return pointInRect(e.clientX, e.clientY, conv.getBoundingClientRect());
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

  function setZoneConversation() {
    lastZone = 'conversation';
    lastContactPk = null;
    clearContactHover();
    showConversationOverlay();
  }

  function setZoneContact(el) {
    lastZone = 'contact';
    lastContactPk = el ? el.getAttribute('data-chat-contact') : null;
    hideConversationOverlay();
    setContactHover(el);
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
    // ה־overlay עצמו מקבל drop (לא pointer-events:none) | HYPER CORE TECH
    dropOverlayEl.addEventListener('dragenter', function (e) {
      if (!isDesktop()) return;
      e.preventDefault();
      e.stopPropagation();
      setZoneConversation();
    });
    dropOverlayEl.addEventListener('dragover', function (e) {
      if (!isDesktop()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setZoneConversation();
    });
    dropOverlayEl.addEventListener('drop', onDrop);
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
    window.setTimeout(function () {
      openSendPreview(file);
    }, 80);
  }

  function updateZoneFromEvent(e) {
    var contact = contactFromEvent(e);
    if (contact) {
      setZoneContact(contact);
      return;
    }
    if (isOverConversation(e) || (dropOverlayEl && dropOverlayEl.classList.contains('is-visible'))) {
      setZoneConversation();
      return;
    }
    // גרירה מעל פאנל עם שיחה פעילה – מציגים overlay על השיחה | HYPER CORE TECH
    if (getActivePeer()) {
      setZoneConversation();
    }
  }

  function onDragEnter(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter += 1;
    updateZoneFromEvent(e);
  }

  function onDragOver(e) {
    if (!isDesktop()) return;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    updateZoneFromEvent(e);
  }

  function onDragLeave(e) {
    if (!isDesktop()) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter -= 1;
    if (dragCounter <= 0) {
      resetDragUi();
      lastZone = null;
      lastContactPk = null;
    }
  }

  function onDrop(e) {
    if (!isDesktop()) return;
    e.preventDefault();
    e.stopPropagation();
    var contact = contactFromEvent(e);
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    var zone = lastZone;
    var pkFromZone = lastContactPk;
    if (!zone && contact) {
      zone = 'contact';
      pkFromZone = contact.getAttribute('data-chat-contact');
    }
    if (!zone && isOverConversation(e)) zone = 'conversation';
    resetDragUi();
    lastZone = null;
    lastContactPk = null;
    if (!file) return;

    if (zone === 'contact' && pkFromZone) {
      openChatThenPreview(pkFromZone, file);
      return;
    }

    if (zone === 'conversation' || isOverConversation(e)) {
      var peer = getActivePeer();
      if (!peer) {
        console.warn('[DRAG-DROP] no active chat');
        return;
      }
      window.setTimeout(function () {
        openSendPreview(file);
      }, 80);
    }
  }

  function setupChatDragDrop() {
    var chatPanel = doc.getElementById('chatPanel');
    if (!chatPanel) {
      console.warn('[DRAG-DROP] chatPanel not found');
      return;
    }
    if (chatPanel.getAttribute('data-chat-dnd') === '1') return;
    chatPanel.setAttribute('data-chat-dnd', '1');

    // capture כדי לתפוס drop גם כשילדים בולעים אירועים | HYPER CORE TECH
    chatPanel.addEventListener('dragenter', onDragEnter, true);
    chatPanel.addEventListener('dragover', onDragOver, true);
    chatPanel.addEventListener('dragleave', onDragLeave, true);
    chatPanel.addEventListener('drop', onDrop, true);

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
