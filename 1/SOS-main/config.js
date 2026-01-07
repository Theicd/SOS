(function initConfig(window) {
  if (!window.NostrTools) {
    console.error('NostrTools not loaded before config.js');
    return;
  }

  const { utils } = window.NostrTools;

  const bytesToHex =
    utils?.bytesToHex ||
    ((arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(''));

  const hexToBytes =
    utils?.hexToBytes ||
    ((hex) => {
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
      if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < clean.length; i += 2) {
        out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
      }
      return out;
    });

  const defaultProfile = {
    name: 'משתמש אנונימי',
    bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
    avatarInitials: 'AN',
    picture: '',
  };

  const storedProfile = window.localStorage.getItem('nostr_profile');
  let profile;
  try {
    profile = storedProfile ? JSON.parse(storedProfile) : defaultProfile;
  } catch (err) {
    console.warn('Failed to parse stored profile, using default', err);
    profile = defaultProfile;
  }

  const App = window.NostrApp || {};
  const SAFE_DEFAULT_RELAYS = [
    'wss://relay.snort.social',
    'wss://nos.lol',
    'wss://nostr-relay.xbytez.io',
    'wss://nostr-02.uid.ovh',
  ];
  const SAFE_DEFAULT_P2P_RELAYS = [
    'wss://relay.snort.social',
    'wss://nos.lol',
    'wss://nostr-relay.xbytez.io',
    'wss://nostr.0x7e.xyz',
  ];
  const UNSAFE_RELAY_PATTERNS = new Set([
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://premium.primal.net',
    'wss://relay.damus.io/',
    'wss://inbox.relays.land',
    'wss://trending.relays.land',
    'wss://gnostr.com',
    'wss://fiatjaf.com',
    'wss://nostr-verif.slothy.win',
    'wss://cfrelay.puhcho.workers.dev',
    'wss://echo.websocket.org',
  ]);
  const RELAY_STORAGE_KEY = 'nostr_relay_urls';
  const P2P_RELAY_STORAGE_KEY = 'nostr_p2p_relays';
  const pendingRelayWarnings = [];

  function loadRelaysFromStorage(storageKey, fallback) {
    if (!storageKey) {
      return Array.isArray(fallback) ? [...fallback] : [];
    }
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      return Array.isArray(fallback) ? [...fallback] : [];
    }
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed;
      }
    } catch (err) {
      console.warn('Invalid relay list in storage', storageKey, err);
    }
    return Array.isArray(fallback) ? [...fallback] : [];
  }

  function persistRelays(storageKey, relays) {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(relays));
    } catch (err) {
      console.warn('Failed to persist relay list', storageKey, err);
    }
  }

  function sanitizeRelayList(relays, { storageKey, context, fallback }) {
    const sanitized = [];
    const flagged = [];
    (Array.isArray(relays) ? relays : []).forEach((relay) => {
      const trimmed = typeof relay === 'string' ? relay.trim() : '';
      if (!trimmed || !trimmed.startsWith('wss://')) {
        return;
      }
      if (UNSAFE_RELAY_PATTERNS.has(trimmed)) {
        flagged.push(trimmed);
      } else if (!sanitized.includes(trimmed)) {
        sanitized.push(trimmed);
      }
    });
    const finalList = sanitized.length ? sanitized : [...(fallback || SAFE_DEFAULT_RELAYS)];
    persistRelays(storageKey, finalList);
    if (flagged.length) {
      queueUnsafeRelayWarning({ context, flagged, storageKey, safeList: finalList });
    }
    return finalList;
  }

  function queueUnsafeRelayWarning({ context, flagged, storageKey, safeList }) {
    pendingRelayWarnings.push({ context, flagged, storageKey, safeList });
    scheduleRelayWarningRender();
  }

  function scheduleRelayWarningRender() {
    if (typeof document === 'undefined') {
      return;
    }
    const render = () => {
      if (!pendingRelayWarnings.length) {
        return;
      }
      pendingRelayWarnings.splice(0).forEach((warning) => {
        const banner = document.createElement('div');
        banner.style.position = 'fixed';
        banner.style.bottom = '16px';
        banner.style.left = '16px';
        banner.style.right = '16px';
        banner.style.zIndex = '9999';
        banner.style.background = '#2b2b2b';
        banner.style.border = '1px solid #ff9800';
        banner.style.borderRadius = '8px';
        banner.style.boxShadow = '0 4px 12px rgba(0,0,0,0.35)';
        banner.style.padding = '12px 16px';
        banner.style.color = '#fff';
        banner.style.fontFamily = 'system-ui, sans-serif';

        const title = document.createElement('div');
        title.textContent = `⚠️ נמצאו ריליים בעייתיים (${warning.context})`;
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';
        banner.appendChild(title);

        const list = document.createElement('div');
        list.textContent = warning.flagged.join(', ');
        list.style.fontSize = '13px';
        list.style.direction = 'ltr';
        list.style.marginBottom = '10px';
        banner.appendChild(list);

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';

        const persistBtn = document.createElement('button');
        persistBtn.textContent = 'נקה מהרשימה השמורה';
        persistBtn.style.background = '#ff9800';
        persistBtn.style.border = 'none';
        persistBtn.style.borderRadius = '4px';
        persistBtn.style.padding = '6px 12px';
        persistBtn.style.cursor = 'pointer';
        persistBtn.onclick = () => {
          persistRelays(warning.storageKey, warning.safeList);
          banner.remove();
        };

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'סגור';
        dismissBtn.style.background = 'transparent';
        dismissBtn.style.color = '#fff';
        dismissBtn.style.border = '1px solid #fff';
        dismissBtn.style.borderRadius = '4px';
        dismissBtn.style.padding = '6px 12px';
        dismissBtn.style.cursor = 'pointer';
        dismissBtn.onclick = () => banner.remove();

        actions.appendChild(persistBtn);
        actions.appendChild(dismissBtn);
        banner.appendChild(actions);

        document.body.appendChild(banner);
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
      window.setTimeout(render, 0);
    }
  }

  const initialRelayList = loadRelaysFromStorage(RELAY_STORAGE_KEY, SAFE_DEFAULT_RELAYS);
  App.relayUrls = sanitizeRelayList(initialRelayList, {
    storageKey: RELAY_STORAGE_KEY,
    context: 'ריליים כלליים',
    fallback: SAFE_DEFAULT_RELAYS,
  });

  const BLOCKED_RELAYS_KEY = 'nostr_blocked_relays';
  let blockedRelayList = [];
  const storedBlockedRelays = window.localStorage.getItem(BLOCKED_RELAYS_KEY);
  if (storedBlockedRelays) {
    try {
      blockedRelayList = JSON.parse(storedBlockedRelays);
    } catch (err) {
      console.warn('Invalid nostr_blocked_relays, resetting', err);
      blockedRelayList = [];
    }
  }
  if (!Array.isArray(blockedRelayList)) {
    blockedRelayList = [];
  }
  App.blockedRelays = new Set(
    blockedRelayList.filter((relay) => typeof relay === 'string' && relay.startsWith('wss://'))
  );
  App._blockedRelayStorageKey = BLOCKED_RELAYS_KEY;
  App.persistBlockedRelays = () => {
    try {
      window.localStorage.setItem(
        BLOCKED_RELAYS_KEY,
        JSON.stringify(Array.from(App.blockedRelays || new Set()))
      );
    } catch (err) {
      console.warn('Failed to persist blocked relays', err);
    }
  };
  App.getWritableRelays = () => {
    if (!Array.isArray(App.relayUrls)) {
      return [];
    }
    return App.relayUrls.filter((relay) => !(App.blockedRelays || new Set()).has(relay));
  };
  const initialP2PRelays = loadRelaysFromStorage(P2P_RELAY_STORAGE_KEY, SAFE_DEFAULT_P2P_RELAYS);
  App.p2pRelayUrls = sanitizeRelayList(initialP2PRelays, {
    storageKey: P2P_RELAY_STORAGE_KEY,
    context: 'ריליים ל-P2P',
    fallback: SAFE_DEFAULT_P2P_RELAYS,
  });
  App.NETWORK_TAG = 'israel-network';
  // חלק קונפיגורציה (config.js) – כתובת בסיס ל-API של כלי הסנכרון המקומי לצורך סטטיסטיקות ובקרת מנהל
  App.syncApiBase = 'http://localhost:4300';
  // חלק קונפיגורציה (config.js) – מזהי ריליי לרישום אימיילים מבוזר (ניתן להחליף דרך localStorage)
  App.EMAIL_REGISTRY_KIND = Number(window.localStorage.getItem('nostr_email_registry_kind')) || 37377;
  App.EMAIL_REGISTRY_TAG = window.localStorage.getItem('nostr_email_registry_tag') || 'email-registry';
  App.EMAIL_REGISTRY_HASH_TAG = (window.localStorage.getItem('nostr_email_registry_hash_tag') || 'h').slice(0, 1);
  App.identityAdminPrivateKey = window.localStorage.getItem('nostr_identity_admin_key') || '';
  // חלק קונפיגורציה (config.js) – מגבלת אורך נתוני תמונה המוטמעת (Data URL) עבור resize ב-utils
  // יישור למגבלת המדיה הכללית כדי למנוע כיווץ יתר שגורם לתמונות "קטנות" לאחר העלאה
  App.MAX_INLINE_PICTURE_LENGTH = 150000;
  App.MAX_METADATA_CONTENT_LENGTH = 60000;
  App.MAX_INLINE_MEDIA_LENGTH = 150000;
  // חלק קונפיגורציה (config.js) – מגבלת אורך טקסט בלבד (ללא מדיה) עבור compose
  // מאפשר למדיה איכותית (Data URL) להיות ארוכה בלי לחסום פרסום
  App.MAX_TEXT_CONTENT_LENGTH = Number(window.localStorage.getItem('nostr_max_text_length')) || 8000;
  // חלק קונפיגורציה (config.js) – ברירת מחדל: לא מפרסמים מטא-דאטה עד שהמשתמש יעדכן פרופיל
  App.metadataPublishQueued = false;
  App.profile = profile;
  App.profileCache = App.profileCache || new Map();
  App.privateKey = window.localStorage.getItem('nostr_private_key');
  App.communityKeyBase64 = window.localStorage.getItem('nostr_community_key') || '';
  App.communityPassphrase =
    window.localStorage.getItem('nostr_community_passphrase') || App.COMMUNITY_CONTEXT;
  App.pool = null;

  let rtcServers = [];
  const storedIce = window.localStorage.getItem('nostr_rtc_ice');
  if (storedIce) {
    try {
      rtcServers = JSON.parse(storedIce);
    } catch (err) {
      console.warn('Invalid nostr_rtc_ice, using default', err);
    }
  }
  if (!Array.isArray(rtcServers) || !rtcServers.length) {
    rtcServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
  }
  window.NostrRTC_ICE = rtcServers;
  App.RTC_ICE_SERVERS = rtcServers;
  const defaultP2PTimeout = Number(window.localStorage.getItem('nostr_p2p_timeout')) || 45000;
  window.NostrP2P_DOWNLOAD_TIMEOUT = defaultP2PTimeout;
  const defaultPeerDiscoveryTimeout =
    Number(window.localStorage.getItem('nostr_peer_discovery_timeout')) || 15000;
  window.NostrP2P_PEER_DISCOVERY_TIMEOUT = defaultPeerDiscoveryTimeout;
  App.bytesToHex = bytesToHex;
  App.hexToBytes = hexToBytes;
  App.finalizeEvent = window.NostrTools?.finalizeEvent;
  App.generateSecretKey = window.NostrTools?.generateSecretKey;
  App.getPublicKey = window.NostrTools?.getPublicKey;
  App.ENCRYPTED_CHANNEL_KIND = 4;
  App.COMMUNITY_CONTEXT = 'yalacommunity';

  // חלק קונפיגורציה (config.js) – מגדיר מפתחות מנהלים שיכולים למחוק פוסטים בכל הרשת מתוך הלקוח
  const adminSourceKeys = ['8c60929899e0009f199b3865a7a5e7ba483fec60ff3c926169d0a4588ada256a'];
  App.adminPublicKeys = App.adminPublicKeys || new Set();
  adminSourceKeys.forEach((rawKey) => {
    if (typeof rawKey !== 'string') {
      return;
    }
    const trimmed = rawKey.trim().toLowerCase();
    if (!trimmed) {
      return;
    }
    // חלק קונפיגורציה (config.js) – אם התקבל מפתח פרטי, מפיקים ממנו את המפתח הציבורי לצורך הרשאות
    if (trimmed.length === 64) {
      App.adminPublicKeys.add(trimmed);
      if (typeof App.getPublicKey === 'function') {
        try {
          const derived = App.getPublicKey(hexToBytes(trimmed));
          if (typeof derived === 'string' && derived.length === 64) {
            App.adminPublicKeys.add(derived.toLowerCase());
          }
        } catch (err) {
          console.warn('Admin key derivation failed', err);
        }
      }
    }
  });
  console.log('[CONFIG] adminPublicKeys:', Array.from(App.adminPublicKeys));

  window.NostrApp = App;
})(window);
