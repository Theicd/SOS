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
  App.relayUrls = [
    'wss://relay.damus.io',
    'wss://relay.snort.social',
    'wss://nos.lol',
    'wss://purplerelay.com',
    'wss://relay.nostr.band'
  ];
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

    let candidate = trimmed;
    // חלק קונפיגורציה (config.js) – אם התקבל מפתח פרטי, מפיקים ממנו את המפתח הציבורי לצורך הרשאות
    if (trimmed.length === 64 && typeof App.getPublicKey === 'function') {
      try {
        candidate = App.getPublicKey(trimmed) || trimmed;
      } catch (err) {
        console.warn('Admin key derivation failed', err);
      }
    }

    if (typeof candidate === 'string' && candidate.length === 64) {
      App.adminPublicKeys.add(candidate.toLowerCase());
    }
  });

  window.NostrApp = App;
})(window);
