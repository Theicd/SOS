/**
 * חלק ניווט אחורה (sos-back-nav.js) – Back מערכתי כמו טיקטוק/וואטסאפ | HYPER CORE TECH
 * שכבות: שיחה → רשימת שיחות → בית → לחיצה נוספת לסגירה
 */
(function initSosBackNav(window, document) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const LAYER = {
    HOME: 'home',
    CHAT_LIST: 'chat-list',
    CHAT_CONV: 'chat-conversation',
  };
  const EXIT_ARM_MS = 2200;

  let applying = false;
  let exitArmedUntil = 0;
  let lastToastEl = null;
  let ready = false;

  function layerRank(layer) {
    if (layer === LAYER.CHAT_CONV) return 2;
    if (layer === LAYER.CHAT_LIST) return 1;
    return 0;
  }

  function isChatPanelOpen() {
    const panel = document.getElementById('chatPanel');
    if (!panel || panel.hasAttribute('hidden')) return false;
    try {
      if (App.chatState && App.chatState.isOpen) return true;
    } catch (_) {}
    return document.body.classList.contains('chat-overlay-open');
  }

  function isChatConversationOpen() {
    if (!isChatPanelOpen()) return false;
    const panel = document.getElementById('chatPanel');
    return !!(panel && panel.classList.contains('chat-panel--conversation'));
  }

  function desiredLayer() {
    if (isChatConversationOpen()) return LAYER.CHAT_CONV;
    if (isChatPanelOpen()) return LAYER.CHAT_LIST;
    return LAYER.HOME;
  }

  function showBackToast(message) {
    try {
      if (lastToastEl && lastToastEl.parentNode) lastToastEl.remove();
    } catch (_) {}
    if (typeof App.showToast === 'function') {
      try {
        App.showToast(message);
        return;
      } catch (_) {}
    }
    const toast = document.createElement('div');
    toast.className = 'sos-back-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    toast.style.cssText =
      'position:fixed;bottom:88px;left:50%;transform:translateX(-50%);' +
      'background:rgba(20,22,26,0.94);color:#fff;padding:10px 18px;border-radius:20px;' +
      'font-size:14px;z-index:10050;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.35);';
    document.body.appendChild(toast);
    lastToastEl = toast;
    setTimeout(() => {
      try {
        toast.remove();
      } catch (_) {}
      if (lastToastEl === toast) lastToastEl = null;
    }, 2000);
  }

  function moveAppToBackground() {
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.moveAppToBackground === 'function') {
        bridge.moveAppToBackground();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function writeHistory(layer, mode) {
    const payload = { sosBack: layer, t: Date.now() };
    try {
      if (mode === 'replace') history.replaceState(payload, '');
      else history.pushState(payload, '');
    } catch (_) {}
  }

  /** מסנכרן את ה־history לשכבת ה־UI הנוכחית (פתיחה/סגירה מכפתורים) | HYPER CORE TECH */
  function syncFromUi() {
    if (!ready || applying) return;
    const want = desiredLayer();
    const cur = history.state && history.state.sosBack ? history.state.sosBack : LAYER.HOME;
    if (cur === want) return;
    applying = true;
    try {
      if (layerRank(want) > layerRank(cur)) {
        writeHistory(want, 'push');
      } else {
        writeHistory(want, 'replace');
      }
    } finally {
      applying = false;
    }
    if (want === LAYER.HOME) exitArmedUntil = 0;
  }

  function closeConversationToList() {
    applying = true;
    try {
      if (typeof App.resetChatConversationView === 'function') {
        App.resetChatConversationView();
      }
    } finally {
      applying = false;
    }
    writeHistory(LAYER.CHAT_LIST, 'replace');
  }

  function closeChatToHome() {
    applying = true;
    try {
      if (typeof App.toggleChatPanel === 'function') {
        App.toggleChatPanel(false);
      } else if (typeof App.closeChatPanel === 'function') {
        App.closeChatPanel();
      }
    } finally {
      applying = false;
    }
    writeHistory(LAYER.HOME, 'replace');
  }

  function handleHomeBack() {
    const now = Date.now();
    if (now < exitArmedUntil) {
      exitArmedUntil = 0;
      if (moveAppToBackground()) {
        writeHistory(LAYER.HOME, 'replace');
        return true;
      }
      // ווב: מאפשרים יציאה אמיתית מההיסטוריה | HYPER CORE TECH
      applying = true;
      try {
        history.back();
      } catch (_) {}
      applying = false;
      return true;
    }
    exitArmedUntil = now + EXIT_ARM_MS;
    showBackToast('לחיצה נוספת תסגור את הממשק');
    writeHistory(LAYER.HOME, 'replace');
    return true;
  }

  /**
   * מטפל בלחיצת Back מערכתית (APK) או אחרי popstate.
   * תמיד מחזיר true כשטיפלנו — כדי שהמעטפת לא תברח ישר ל־launcher.
   */
  function handleSystemBack() {
    if (applying) return true;

    if (isChatConversationOpen()) {
      closeConversationToList();
      exitArmedUntil = 0;
      return true;
    }

    if (isChatPanelOpen()) {
      closeChatToHome();
      exitArmedUntil = 0;
      return true;
    }

    try {
      if (typeof App.areFeedOverlaysOpen === 'function' && App.areFeedOverlaysOpen()) {
        if (typeof App.closeAllOverlays === 'function') App.closeAllOverlays();
        exitArmedUntil = 0;
        return true;
      }
    } catch (_) {}

    return handleHomeBack();
  }

  function onPopState() {
    if (applying) return;
    // הדפדפן כבר ירד שכבה — מיישרים UI לפי היעד / מצב בפועל | HYPER CORE TECH
    const dest = history.state && history.state.sosBack ? history.state.sosBack : null;

    if (dest === LAYER.CHAT_LIST || (!dest && isChatConversationOpen())) {
      if (isChatConversationOpen()) closeConversationToList();
      else if (!isChatPanelOpen() && dest === LAYER.CHAT_LIST) {
        // לא אמור לקרות; מתעלמים
      }
      return;
    }

    if (dest === LAYER.HOME || dest == null) {
      if (isChatPanelOpen()) {
        closeChatToHome();
        return;
      }
      handleHomeBack();
      // אחרי toast — דוחפים שוב home כדי שה־Back הבא יישאר אצלנו בווב | HYPER CORE TECH
      applying = true;
      try {
        writeHistory(LAYER.HOME, 'push');
      } finally {
        applying = false;
      }
    }
  }

  function init() {
    if (ready) return;
    ready = true;
    try {
      // replace + push: Back ראשון נשאר אצלנו (toast) גם במעטפת ישנה עם goBack | HYPER CORE TECH
      writeHistory(LAYER.HOME, 'replace');
      writeHistory(LAYER.HOME, 'push');
    } catch (_) {}
    window.addEventListener('popstate', onPopState);
    syncFromUi();
  }

  window.__sosHandleSystemBack = function sosHandleSystemBack() {
    try {
      return handleSystemBack() === true;
    } catch (_) {
      return false;
    }
  };

  App.sosBackSync = syncFromUi;
  App.sosBackHandle = handleSystemBack;
  App.__sosHandleSystemBack = window.__sosHandleSystemBack;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window, document);
