/**
 * חלק ניווט אחורה (sos-back-nav.js) – Back כמו טיקטוק: שכבות + לחיצה כפולה לסגירה | HYPER CORE TECH
 * סדר: לייטבוקס מדיה → שיחה → רשימה → בית → toast → יציאה
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
  /** כמה push מעל בית (רשימה/שיחה) — לסגירה בלי toast מזויף | HYPER CORE TECH */
  let chatHistoryDepth = 0;

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

  function isChatLightboxOpen() {
    if (document.body.classList.contains('chat-lightbox-open')) return true;
    if (document.body.classList.contains('chat-media-modal-open')) return true;
    if (document.querySelector('.chat-lightbox.chat-lightbox--visible')) return true;
    if (document.querySelector('.chat-lightbox:not(.chat-lightbox--closing)')) {
      const lb = document.querySelector('.chat-lightbox');
      if (lb && lb.id && !lb.hidden) return true;
    }
    const modal = document.querySelector('.chat-media-modal');
    if (modal && !modal.hasAttribute('hidden') && !modal.hidden) return true;
    return false;
  }

  function closeChatLightboxLayer() {
    try {
      if (typeof App.closeChatLightbox === 'function') {
        if (App.closeChatLightbox()) return true;
      }
    } catch (_) {}
    let closed = false;
    try {
      const btn = document.querySelector(
        '.chat-lightbox--visible .chat-lightbox__back, .chat-lightbox--visible .chat-lightbox__close, .chat-lightbox .chat-lightbox__back, .chat-lightbox .chat-lightbox__close'
      );
      if (btn) {
        btn.click();
        closed = true;
      }
    } catch (_) {}
    try {
      document.querySelectorAll('.chat-lightbox').forEach((el) => {
        el.remove();
        closed = true;
      });
      document.getElementById('chatLightboxDeleteDialog')?.remove();
      document.body.classList.remove('chat-lightbox-open');
    } catch (_) {}
    try {
      const modal = document.querySelector('.chat-media-modal');
      if (modal && !modal.hasAttribute('hidden')) {
        modal.setAttribute('hidden', '');
        document.body.classList.remove('chat-media-modal-open');
        closed = true;
      }
    } catch (_) {}
    try {
      App.__sosSuppressChatOutsideClose = false;
    } catch (_) {}
    return closed;
  }

  function desiredLayer() {
    if (isChatConversationOpen()) return LAYER.CHAT_CONV;
    if (isChatPanelOpen()) return LAYER.CHAT_LIST;
    return LAYER.HOME;
  }

  function showExitHint(message) {
    try {
      if (lastToastEl && lastToastEl.parentNode) lastToastEl.remove();
    } catch (_) {}

    // רק body + fixed — לא נוגעים ב־.videos-feed / רמז בית | HYPER CORE TECH
    const hint = document.createElement('div');
    hint.className = 'sos-back-exit-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    hint.innerHTML = `<span>${message}</span>`;
    document.body.appendChild(hint);
    lastToastEl = hint;
    requestAnimationFrame(() => {
      try {
        hint.classList.add('is-visible');
      } catch (_) {}
    });
    setTimeout(() => {
      try {
        hint.classList.remove('is-visible');
      } catch (_) {}
      setTimeout(() => {
        try {
          hint.remove();
        } catch (_) {}
        if (lastToastEl === hint) lastToastEl = null;
      }, 220);
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

  function ensureHomeTrap() {
    applying = true;
    try {
      writeHistory(LAYER.HOME, 'replace');
      writeHistory(LAYER.HOME, 'push');
    } finally {
      applying = false;
    }
    chatHistoryDepth = 0;
  }

  function syncFromUi() {
    if (!ready || applying) return;
    const want = desiredLayer();
    const cur = history.state && history.state.sosBack ? history.state.sosBack : LAYER.HOME;

    if (want === LAYER.HOME) {
      exitArmedUntil = 0;
      if (chatHistoryDepth === 0 && cur === LAYER.HOME) return;
      collapseChatHistoryToHome(true);
      return;
    }

    if (cur === want) return;

    applying = true;
    try {
      if (layerRank(want) > layerRank(cur === LAYER.HOME ? LAYER.HOME : cur)) {
        writeHistory(want, 'push');
        chatHistoryDepth += 1;
      } else if (layerRank(want) < layerRank(cur)) {
        writeHistory(want, 'replace');
        chatHistoryDepth = Math.max(1, chatHistoryDepth - 1);
      } else {
        writeHistory(want, 'replace');
      }
    } finally {
      applying = false;
    }
  }

  function collapseChatHistoryToHome(rearmTrap) {
    const steps = Math.max(chatHistoryDepth, curChatStepsInState());
    chatHistoryDepth = 0;
    exitArmedUntil = 0;
    applying = true;
    try {
      if (steps > 0) {
        try {
          history.go(-steps);
        } catch (_) {
          writeHistory(LAYER.HOME, 'replace');
        }
      } else {
        writeHistory(LAYER.HOME, 'replace');
      }
    } finally {
      window.setTimeout(() => {
        applying = false;
        if (rearmTrap !== false) ensureHomeTrap();
        else {
          writeHistory(LAYER.HOME, 'replace');
          writeHistory(LAYER.HOME, 'push');
        }
      }, 30);
    }
  }

  function curChatStepsInState() {
    const cur = history.state && history.state.sosBack ? history.state.sosBack : LAYER.HOME;
    return layerRank(cur);
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
    exitArmedUntil = 0;
    writeHistory(LAYER.CHAT_LIST, 'replace');
    chatHistoryDepth = Math.max(1, chatHistoryDepth - 1);
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
    exitArmedUntil = 0;
    collapseChatHistoryToHome(true);
  }

  function handleHomeBack() {
    const now = Date.now();
    if (now < exitArmedUntil) {
      exitArmedUntil = 0;
      if (moveAppToBackground()) {
        writeHistory(LAYER.HOME, 'replace');
        return true;
      }
      applying = true;
      try {
        history.back();
      } catch (_) {}
      applying = false;
      return true;
    }
    exitArmedUntil = now + EXIT_ARM_MS;
    showExitHint('לחיצה נוספת תסגור את הממשק');
    // משאירים מלכודת כדי שהלחיצה הבאה תגיע אלינו | HYPER CORE TECH
    ensureHomeTrap();
    return true;
  }

  function handleSystemBack() {
    if (applying) return true;

    if (isChatLightboxOpen()) {
      closeChatLightboxLayer();
      exitArmedUntil = 0;
      return true;
    }

    if (isChatConversationOpen()) {
      closeConversationToList();
      return true;
    }

    if (isChatPanelOpen()) {
      closeChatToHome();
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

    if (isChatLightboxOpen()) {
      closeChatLightboxLayer();
      exitArmedUntil = 0;
      return;
    }

    const dest = history.state && history.state.sosBack ? history.state.sosBack : null;

    // עדיין בשיחה / ברשימה — מיישרים UI בלי הודעת יציאה | HYPER CORE TECH
    if (isChatConversationOpen()) {
      closeConversationToList();
      return;
    }

    if (isChatPanelOpen()) {
      closeChatToHome();
      return;
    }

    // כבר בבית — רק אז toast / יציאה כמו טיקטוק | HYPER CORE TECH
    if (dest === LAYER.HOME || dest == null) {
      handleHomeBack();
    }
  }

  function init() {
    if (ready) return;
    ready = true;
    try {
      ensureHomeTrap();
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
