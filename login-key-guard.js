;(function initLoginKeyGuard(window) {
  // חלק התחברות (login-key-guard.js) – חוסם מפתחות זמניים/אורח בלבד; מאפשר מנהל + מפתחות עם זהות רשת | HYPER CORE TECH
  const App = window.NostrApp || (window.NostrApp = {});
  const GUEST_KEY_STORAGE = 'p2p_guest_keys';
  const TEMP_KEY_BLOCKLIST = 'sos_temp_login_blocklist';

  function normalizeHexKey(hex) {
    if (!hex || typeof hex !== 'string') return '';
    const trimmed = hex.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : '';
  }

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function rememberTemporaryPrivateKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return;
    const list = Array.isArray(readJson(TEMP_KEY_BLOCKLIST, [])) ? readJson(TEMP_KEY_BLOCKLIST, []) : [];
    if (!list.includes(hex)) {
      list.push(hex);
      writeJson(TEMP_KEY_BLOCKLIST, list.slice(-50));
    }
  }

  function isTemporaryPrivateKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return false;

    const blocklist = readJson(TEMP_KEY_BLOCKLIST, []);
    if (Array.isArray(blocklist) && blocklist.includes(hex)) return true;

    const guest = readJson(GUEST_KEY_STORAGE, null);
    if (guest && normalizeHexKey(guest.privateKey) === hex) return true;

    return false;
  }

  function hexToBytesLocal(hex) {
    const h = normalizeHexKey(hex);
    if (!h) return null;
    if (typeof App.hexToBytes === 'function') {
      try {
        return App.hexToBytes(h);
      } catch (_) {}
    }
    if (typeof window.NostrTools?.utils?.hexToBytes === 'function') {
      try {
        return window.NostrTools.utils.hexToBytes(h);
      } catch (_) {}
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function derivePublicKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return '';
    const getPk = App.getPublicKey || window.NostrTools?.getPublicKey;
    if (typeof getPk !== 'function') return '';
    try {
      const bytes = hexToBytesLocal(hex);
      const pk = bytes ? getPk(bytes) : getPk(hex);
      return typeof pk === 'string' ? pk.toLowerCase() : '';
    } catch (err) {
      try {
        const pk2 = getPk(hex);
        return typeof pk2 === 'string' ? pk2.toLowerCase() : '';
      } catch (_) {
        console.warn('[LOGIN-GUARD] derivePublicKey failed', err);
        return '';
      }
    }
  }

  function isAdminPrivateOrPublic(privateKeyHex, pubkey) {
    const hex = normalizeHexKey(privateKeyHex);
    const pk = String(pubkey || '').toLowerCase();
    if (App.adminPublicKeys instanceof Set) {
      if (pk && App.adminPublicKeys.has(pk)) return true;
      // ב-config יש גם הוספת מפתח פרטי גולמי לסט — תמיכה בשני המקרים | HYPER CORE TECH
      if (hex && App.adminPublicKeys.has(hex)) return true;
    }
    const adminPriv = normalizeHexKey(App.identityAdminPrivateKey || '');
    if (adminPriv && adminPriv === hex) return true;
    return false;
  }

  async function queryHasEvent(filters) {
    const pool = App.pool;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (!pool || !relays.length) return null;
    try {
      if (typeof pool.list === 'function') {
        const events = await pool.list(relays, filters);
        return Array.isArray(events) && events.length > 0;
      }
      if (typeof pool.listMany === 'function') {
        const events = await pool.listMany(relays, filters);
        return Array.isArray(events) && events.length > 0;
      }
      if (typeof pool.querySync === 'function') {
        const events = await pool.querySync(relays, filters[0]);
        return Array.isArray(events) && events.length > 0;
      }
      if (typeof pool.get === 'function') {
        const event = await pool.get(relays, filters[0]);
        return Boolean(event);
      }
    } catch (err) {
      console.warn('[LOGIN-GUARD] registry lookup failed', err);
      return null;
    }
    return null;
  }

  async function hasNetworkIdentityProof(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!pk || pk.length !== 64) return false;

    const emailKind = Number(App.EMAIL_REGISTRY_KIND) || 37377;
    const inviteUsedKind = Number(App.INVITE_USED_KIND) || 37379;

    const checks = [
      queryHasEvent([{ kinds: [emailKind], authors: [pk], limit: 1 }]),
      queryHasEvent([{ kinds: [inviteUsedKind], authors: [pk], limit: 1 }]),
      // פרופיל kind:0 — משתמשים ותיקים לפני registry | HYPER CORE TECH
      queryHasEvent([{ kinds: [0], authors: [pk], limit: 1 }]),
    ];

    const results = await Promise.all(checks);
    if (results.some((r) => r === true)) return true;
    if (results.every((r) => r === null)) return null;
    return false;
  }

  async function assertLoginPrivateKeyAllowed(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) {
      return { ok: false, error: 'המפתח לא תקין' };
    }

    // חסימה היחידה הקשיחה: מפתחות זמניים/אורח | HYPER CORE TECH
    if (isTemporaryPrivateKey(hex)) {
      return {
        ok: false,
        error: 'מפתח זמני לא מתאים להתחברות. השתמשו במפתח שקיבלתם ברישום.',
      };
    }

    const pubkey = derivePublicKey(hex);
    if (!pubkey) {
      return { ok: false, error: 'לא ניתן לחשב מפתח ציבורי מהמפתח שהוזן' };
    }

    if (isAdminPrivateOrPublic(hex, pubkey)) {
      return { ok: true, pubkey, privateKey: hex, reason: 'admin' };
    }

    const proof = await hasNetworkIdentityProof(pubkey);
    if (proof === true) {
      return { ok: true, pubkey, privateKey: hex, reason: 'registered' };
    }

    // כשל רשת: לא נועלים מפתח שאינו זמני | HYPER CORE TECH
    if (proof === null) {
      console.warn('[LOGIN-GUARD] network proof unavailable — allowing non-temporary key');
      return { ok: true, pubkey, privateKey: hex, reason: 'network-fallback' };
    }

    return {
      ok: false,
      error: 'המפתח לא מזוהה במערכת. השתמשו במפתח המקורי מהרישום.',
    };
  }

  Object.assign(App, {
    rememberTemporaryPrivateKey,
    isTemporaryPrivateKey,
    assertLoginPrivateKeyAllowed,
  });
})(window);
