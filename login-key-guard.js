;(function initLoginKeyGuard(window) {
  // חלק התחברות (login-key-guard.js) – חוסם מפתחות זמניים/אורח; מאשר רק מפתח עם הוכחת רישום | HYPER CORE TECH
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
    if (guest && guest.isGuest === true && normalizeHexKey(guest.privateKey) === hex) return true;

    return false;
  }

  function derivePublicKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return '';
    try {
      if (typeof window.NostrTools?.getPublicKey === 'function') {
        const pk = window.NostrTools.getPublicKey(hex);
        return typeof pk === 'string' ? pk.toLowerCase() : '';
      }
    } catch (_) {}
    return '';
  }

  async function queryHasEvent(filters) {
    const pool = App.pool;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (!pool || !relays.length) return null; // null = לא ניתן לבדוק
    try {
      if (typeof pool.list === 'function') {
        const events = await pool.list(relays, filters);
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

  async function hasRegistrationProof(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!pk || pk.length !== 64) return false;

    const emailKind = Number(App.EMAIL_REGISTRY_KIND) || 37377;
    const inviteUsedKind = Number(App.INVITE_USED_KIND) || 37379;

    const emailHit = await queryHasEvent([
      { kinds: [emailKind], authors: [pk], limit: 1 },
    ]);
    if (emailHit === true) return true;

    const inviteHit = await queryHasEvent([
      { kinds: [inviteUsedKind], authors: [pk], limit: 1 },
    ]);
    if (inviteHit === true) return true;

    // אם שתי הבדיקות נכשלו בגלל רשת — מחזירים null דרך assert
    if (emailHit === null && inviteHit === null) return null;
    return false;
  }

  async function assertLoginPrivateKeyAllowed(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) {
      return { ok: false, error: 'המפתח לא תקין' };
    }

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

    const proof = await hasRegistrationProof(pubkey);
    if (proof === null) {
      return {
        ok: false,
        error: 'אין חיבור לריליים לאימות המפתח. נסו שוב בעוד רגע.',
      };
    }
    if (!proof) {
      return {
        ok: false,
        error: 'המפתח לא מזוהה כמפתח רישום במערכת. השתמשו במפתח המקורי מהרישום.',
      };
    }

    return { ok: true, pubkey, privateKey: hex };
  }

  Object.assign(App, {
    rememberTemporaryPrivateKey,
    isTemporaryPrivateKey,
    assertLoginPrivateKeyAllowed,
  });
})(window);
