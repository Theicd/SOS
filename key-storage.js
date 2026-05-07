/**
 * אחסון מפתח Nostr — שכבה דקה להקשחת אבטחה בלי לשבור את שאר הממשק.
 * - referrer / CSP לא כאן — ב-meta ב-HTML.
 * - sos_session_only_key=1 ב-localStorage: המפתח נשמר רק ב-sessionStorage (נמחק בסגירת לשונית).
 */
(function initSOSKeyStorage(window) {
  const LS = 'nostr_private_key';
  const SS = 'nostr_private_key_ephemeral';
  const FLAG = 'sos_session_only_key';

  function isHex64(s) {
    if (typeof s !== 'string') return false;
    return /^[0-9a-f]{64}$/i.test(s.trim());
  }

  /** ערך גולמי כמו localStorage.getItem (כולל פורמטים ישנים לפני נרמול ב-keys.js) */
  function readPrivateKeyRaw() {
    try {
      if (window.localStorage.getItem(FLAG) === '1') {
        return window.sessionStorage.getItem(SS) || '';
      }
      return (
        window.localStorage.getItem(LS) ||
        window.sessionStorage.getItem(SS) ||
        ''
      );
    } catch (_e) {
      return '';
    }
  }

  /** רק hex-64 תקין (לוולידציה אחרי התחברות) */
  function readPrivateKeyHex() {
    const raw = readPrivateKeyRaw();
    return isHex64(raw) ? raw.trim().toLowerCase() : '';
  }

  function writePrivateKeyRaw(str) {
    if (str == null || typeof str !== 'string') return false;
    try {
      if (window.localStorage.getItem(FLAG) === '1') {
        window.sessionStorage.setItem(SS, str);
        try {
          window.localStorage.removeItem(LS);
        } catch (_e) {}
        return true;
      }
      window.localStorage.setItem(LS, str);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function writePrivateKeyHex(hex) {
    if (!isHex64(hex)) return false;
    return writePrivateKeyRaw(hex.trim().toLowerCase());
  }

  function clearPrivateKey() {
    try {
      window.localStorage.removeItem(LS);
      window.sessionStorage.removeItem(SS);
    } catch (_e) {}
  }

  window.SOSKeyStorage = {
    readPrivateKeyRaw,
    readPrivateKeyHex,
    writePrivateKeyRaw,
    writePrivateKeyHex,
    clearPrivateKey,
    SESSION_ONLY_FLAG: FLAG,
  };
})(window);
