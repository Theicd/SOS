// חלק Deep Link (chat-deeplink.js) – פתיחה ישירה לשיחה/שיחה נכנסת כמו וואטסאפ | HYPER CORE TECH
(function initChatDeepLink(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const HEX64 = /^[0-9a-f]{64}$/i;

  let lastHandledKey = '';
  let lastHandledAt = 0;
  let retryTimer = null;
  let pending = null;

  function normalizePeer(raw) {
    const peer = String(raw || '').trim().toLowerCase();
    return HEX64.test(peer) ? peer : '';
  }

  function normalizeCallType(raw) {
    const t = String(raw || '').trim().toLowerCase();
    if (t === 'video' || t === 'v' || t === 'v-offer') return 'video';
    if (t === 'voice' || t === 'audio' || t === 'offer' || t === '1') return 'voice';
    return '';
  }

  function parseFromLocation() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      return {
        chat: normalizePeer(params.get('chat')),
        incomingCall: normalizeCallType(params.get('incomingCall')),
      };
    } catch (_) {
      return { chat: '', incomingCall: '' };
    }
  }

  function suppressLoadingOverChat() {
    try {
      document.documentElement.setAttribute('data-sos-deeplink', '1');
      document.body.classList.add('sos-deeplink-chat');
      document.body.classList.remove('videos-boot-loading');
    } catch (_) {}
    try {
      if (typeof App.releaseBootForDeepLink === 'function') {
        App.releaseBootForDeepLink('chat-deeplink');
      } else if (typeof App.hideLoadingAnimation === 'function') {
        App.hideLoadingAnimation({ force: true });
      }
    } catch (_) {}
    try {
      const overlay = document.getElementById('videosLoadingOverlay');
      if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
      }
      const soft = document.getElementById('videosSoftLoading');
      if (soft) {
        soft.hidden = true;
        soft.style.display = 'none';
      }
      const nug = document.getElementById('sosLoadNugOverlay');
      if (nug) nug.remove();
    } catch (_) {}
  }

  function releaseBootIfNeeded() {
    suppressLoadingOverChat();
  }

  // חלק Deep Link (chat-deeplink.js) – מנקה דגלים כדי שהתפריט התחתון יחזור ברשימת שיחות | HYPER CORE TECH
  function clearDeepLinkFlags() {
    try {
      document.documentElement.removeAttribute('data-sos-deeplink');
      document.body.classList.remove('sos-deeplink-chat');
    } catch (_) {}
  }

  function stripChatParamFromUrl() {
    try {
      if (typeof history.replaceState !== 'function') return;
      const url = new URL(window.location.href);
      if (!url.searchParams.has('chat') && !url.searchParams.has('incomingCall')) return;
      url.searchParams.delete('chat');
      url.searchParams.delete('incomingCall');
      const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
      history.replaceState(null, '', next);
    } catch (_) {}
  }

  App.clearSosDeepLinkFlags = function clearSosDeepLinkFlags() {
    clearDeepLinkFlags();
    stripChatParamFromUrl();
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.clearPendingDeepLink === 'function') {
        bridge.clearPendingDeepLink();
      }
      if (bridge && typeof bridge.clearRememberedChatUrl === 'function') {
        bridge.clearRememberedChatUrl();
      } else if (bridge && typeof bridge.rememberWebUrl === 'function') {
        bridge.rememberWebUrl(String(window.location.href || ''));
      }
    } catch (_) {}
  };

  function openConversation(peer) {
    if (!peer) return false;
    suppressLoadingOverChat();
    try {
      if (typeof App.ensureChatContact === 'function') {
        App.ensureChatContact(peer);
      } else if (typeof App.addChatContact === 'function') {
        App.addChatContact(peer);
      }
    } catch (_) {}

    if (typeof App.showChatConversation === 'function') {
      App.showChatConversation(peer);
      suppressLoadingOverChat();
      // אחרי שהשיחה פתוחה – CSS של #chatPanel מסתיר טעינה; מנקים דגלי deep-link | HYPER CORE TECH
      setTimeout(clearDeepLinkFlags, 1500);
      return true;
    }
    return false;
  }

  function focusIncomingCall(peer, callType, pendingOffer, opts) {
    try {
      if (callType === 'video' && typeof App.resumeIncomingVideoCallFromDeepLink === 'function') {
        return !!App.resumeIncomingVideoCallFromDeepLink(peer, pendingOffer, opts);
      }
      if (typeof App.resumeIncomingVoiceCallFromDeepLink === 'function') {
        return !!App.resumeIncomingVoiceCallFromDeepLink(peer, pendingOffer, opts);
      }
    } catch (err) {
      console.warn('[DEEPLINK] incoming call focus failed', err);
    }
    return false;
  }

  function stripDeepLinkParams() {
    try {
      if (typeof history.replaceState !== 'function') return;
      const url = new URL(window.location.href);
      // משאירים chat ב־URL לסימון שיחה פעילה; מסירים רק incomingCall אחרי טיפול
      if (url.searchParams.has('incomingCall')) {
        url.searchParams.delete('incomingCall');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch (_) {}
  }

  function attemptOpen(detail, attempt) {
    const chat = normalizePeer(detail?.chat);
    const incomingCall = normalizeCallType(detail?.incomingCall);
    const pendingOffer = detail?.pendingOffer || null;
    const pendingRawEvent = detail?.pendingRawEvent || null;
    const autoAccept = !!detail?.autoAccept;
    if (!chat && !incomingCall) return true;

    const key = `${chat}|${incomingCall}|${autoAccept ? '1' : '0'}`;
    const now = Date.now();
    if (key === lastHandledKey && now - lastHandledAt < 1200 && attempt === 0) {
      return true;
    }

    releaseBootIfNeeded();

    let opened = false;
    // שיחה נכנסת: קודם מסך ענה, בלי לפתוח צ'אט שמסתיר אותו | HYPER CORE TECH
    if (incomingCall) {
      window.__sosIncomingCallActive = true;
      // init חד־פעמי בלבד – retries של deeplink לא מריצים force שוב | HYPER CORE TECH
      if (attempt === 0) {
        try {
          if (typeof App.initVoiceCall === 'function') App.initVoiceCall({});
          if (typeof App.initVideoCall === 'function') App.initVideoCall({});
        } catch (_) {}
      }
      // לפני UI – מסמנים pending answer כדי שלא יופיע כפתור ענה שני | HYPER CORE TECH
      if (autoAccept && chat) {
        try {
          window.__sosNativePendingAnswer = {
            peer: chat,
            callType: incomingCall || 'voice',
            until: Date.now() + 60000,
            pendingRawEvent: pendingRawEvent || null,
          };
        } catch (_) {}
        try {
          document.documentElement.setAttribute('data-sos-deeplink', '1');
          document.body.classList.add('sos-call-active');
          if (typeof App.closeChatPanel === 'function') App.closeChatPanel();
        } catch (_) {}
      }
      const callFocused = focusIncomingCall(chat, incomingCall, pendingOffer, {
        autoAnswering: autoAccept,
      });
      opened = callFocused || !!chat;
      if (opened && autoAccept && attempt === 0) {
        setTimeout(() => {
          try {
            const App = window.NostrApp || {};
            if (typeof App.acceptIncomingCallFromNative === 'function') {
              App.acceptIncomingCallFromNative(chat, incomingCall, pendingRawEvent);
            }
          } catch (err) {
            console.warn('[DEEPLINK] autoAccept failed', err);
          }
        }, 300);
      }
    } else if (chat) {
      opened = openConversation(chat);
    }

    if (opened) {
      lastHandledKey = key;
      lastHandledAt = now;
      pending = null;
      // מנקים chat=/incomingCall מה-URL – דגלי שיחה (sos-call-active) נשארים עד סיום שיחה | HYPER CORE TECH
      stripChatParamFromUrl();
      if (!incomingCall) clearDeepLinkFlags();
      try {
        const bridge = window.SosNativeShell;
        if (bridge && typeof bridge.rememberWebUrl === 'function') {
          bridge.rememberWebUrl(String(window.location.href || ''));
        }
      } catch (_) {}
      console.log('[DEEPLINK] opened', { chat: chat.slice(0, 8), incomingCall, autoAccept, attempt });
      return true;
    }

    return false;
  }

  function scheduleRetries(detail) {
    pending = {
      chat: normalizePeer(detail?.chat),
      incomingCall: normalizeCallType(detail?.incomingCall),
      pendingOffer: detail?.pendingOffer || null,
      pendingRawEvent: detail?.pendingRawEvent || null,
      autoAccept: !!detail?.autoAccept,
    };
    if (!pending.chat && !pending.incomingCall) return;

    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }

    let attempt = 0;
    const maxAttempts = 40; // ~20s
    if (attemptOpen(pending, attempt)) return;

    retryTimer = setInterval(() => {
      attempt += 1;
      if (attemptOpen(pending, attempt) || attempt >= maxAttempts) {
        clearInterval(retryTimer);
        retryTimer = null;
        if (attempt >= maxAttempts) {
          console.warn('[DEEPLINK] gave up after retries', pending);
        }
      }
    }, 500);
  }

  function handleDeepLink(detail) {
    const chat = normalizePeer(detail?.chat);
    const incomingCall = normalizeCallType(detail?.incomingCall);
    if (!chat && !incomingCall) return;
    console.log('[DEEPLINK] received', {
      chat: chat.slice(0, 8),
      incomingCall,
      autoAccept: !!detail?.autoAccept,
    });
    // חשוב: לא לקצוץ autoAccept / pendingRawEvent – בלי זה ענה ממסך נעילה לא מתקבל | HYPER CORE TECH
    scheduleRetries({
      chat,
      incomingCall,
      pendingOffer: detail?.pendingOffer || null,
      pendingRawEvent: detail?.pendingRawEvent || null,
      autoAccept: !!detail?.autoAccept,
    });
  }

  App.openFromDeepLink = function openFromDeepLink(detail) {
    handleDeepLink(detail || {});
  };

  App.consumeUrlDeepLink = function consumeUrlDeepLink() {
    handleDeepLink(parseFromLocation());
  };

  window.addEventListener('sos-native-deeplink', (event) => {
    handleDeepLink(event?.detail || {});
  });

  window.addEventListener('sos-native-resume', () => {
    if (pending && (pending.chat || pending.incomingCall)) {
      scheduleRetries(pending);
      return;
    }
    const fromUrl = parseFromLocation();
    if (fromUrl.chat || fromUrl.incomingCall) {
      handleDeepLink(fromUrl);
    }
  });

  window.addEventListener('sos-native-ready', () => {
    const fromUrl = parseFromLocation();
    if (fromUrl.chat || fromUrl.incomingCall) {
      handleDeepLink(fromUrl);
    }
  });

  // חלק Deep Link (chat-deeplink.js) – לחיצה על התראת דפדפן/PWA דרך Service Worker | HYPER CORE TECH
  function handleServiceWorkerDeepLink(event) {
    const data = event && event.data ? event.data : null;
    if (!data) return;
    if (data.type === 'sos-deeplink') {
      handleDeepLink({
        chat: data.chat || data.peerPubkey,
        incomingCall: data.incomingCall,
        pendingOffer: data.pendingOffer || null,
      });
      return;
    }
    if (data.type === 'chat-message-notification-action' || data.type === 'missed-call-notification-action') {
      handleDeepLink({ chat: data.peerPubkey || data.chat, incomingCall: '' });
      return;
    }
    if (data.type === 'voice-call-notification-action') {
      handleDeepLink({ chat: data.peerPubkey || data.chat, incomingCall: 'voice' });
      return;
    }
    if (data.type === 'video-call-notification-action') {
      handleDeepLink({ chat: data.peerPubkey || data.chat, incomingCall: 'video' });
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerDeepLink);
    } catch (_) {}
  }

  function bootFromUrl() {
    const fromUrl = parseFromLocation();
    if (fromUrl.chat || fromUrl.incomingCall) {
      // מסמן מוקדם כדי שהפיד לא יחסום את ה־UI | HYPER CORE TECH
      try { document.documentElement.setAttribute('data-sos-deeplink', '1'); } catch (_) {}
      handleDeepLink(fromUrl);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootFromUrl, { once: true });
  } else {
    bootFromUrl();
  }
  // chat-ui נטען ב־defer – ניסיון נוסף אחרי load
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (pending) scheduleRetries(pending);
      else bootFromUrl();
    }, 300);
  });
})(window);
