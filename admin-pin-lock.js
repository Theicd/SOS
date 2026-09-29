/**
 * Package 899f — First-group admin control PIN lock (Hebrew UI).
 * A 6-digit PIN is a UI/session lock layered on top of the authenticated admin identity. It is never authority:
 * every mutation still needs identity + session + signed control-chain capability + typed signer (FirstGroupAdmin).
 * Storage: PBKDF2-SHA256 verifier (random salt) sealed with a non-extractable AES-GCM key, both in IndexedDB,
 * per identity. The PIN itself is never stored, logged, placed in URLs or sent over the network.
 * Unlock state lives in memory only, bound to identity + session generation, 15 min inactivity TTL.
 */
(function initAdminPinLock(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const DB_NAME = 'sos-admin-pin-v1';
  const DB_VERSION = 1;
  const PIN_STORE = 'pin';
  const KEY_STORE = 'wrap';
  const WRAP_ID = 'wrap-v1';
  const PBKDF2_ITERATIONS = 600000;
  const UNLOCK_TTL_MS = 15 * 60 * 1000;
  const PIN_RE = /^[0-9]{6}$/;
  const DENY = new Set([
    '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
    '123456', '234567', '345678', '456789', '567890', '012345', '654321', '543210', '987654', '876543',
    '765432', '098765', '123123', '321321', '121212', '112233', '123321', '101010', '696969', '159753',
    '147258', '789456', '102030', '111222', '000001', '100000', '999000', '000999', '420420', '131313',
  ]);

  let unlock = null;
  let verifyInFlight = false;

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }
  function actor() {
    return normalizePubkey(App.publicKey);
  }
  function fail(code, extra) {
    return Object.assign({ ok: false, code }, extra || {});
  }
  function now() {
    return Date.now();
  }

  function isTrivialPin(pin) {
    const p = String(pin || '');
    if (!PIN_RE.test(p)) return true;
    if (DENY.has(p)) return true;
    if (/^(\d)\1{5}$/.test(p) || /^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p)) return true;
    const d = p.split('').map(Number);
    let asc = true;
    let desc = true;
    for (let i = 1; i < d.length; i++) {
      if ((d[i] - d[i - 1] + 10) % 10 !== 1) asc = false;
      if ((d[i - 1] - d[i] + 10) % 10 !== 1) desc = false;
    }
    return asc || desc;
  }

  /** 1-3 failures: no delay; 4: 30s; 5: 60s; 6+: 5min doubling, capped at 1h. Never permanent. */
  function delayForFailures(n) {
    if (n <= 3) return 0;
    if (n === 4) return 30 * 1000;
    if (n === 5) return 60 * 1000;
    return Math.min(5 * 60 * 1000 * Math.pow(2, n - 6), 60 * 60 * 1000);
  }

  // ---------------------------------------------------------------- session binding

  function sessionState() {
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (!SA || typeof SA.checkSessionForSensitiveOp !== 'function') return { ok: false };
    const s = SA.checkSessionForSensitiveOp('ADMIN_PIN_LOCK');
    if (!s || s.ok !== true) return { ok: false };
    if (s.account && normalizePubkey(s.account) && normalizePubkey(s.account) !== actor()) return { ok: false };
    return { ok: true, generation: s.generation };
  }

  function lock(reason) {
    const was = !!unlock;
    unlock = null;
    if (was) {
      try {
        window.dispatchEvent(new CustomEvent('sos-admin-pin-locked', { detail: { reason: String(reason || 'lock') } }));
      } catch (_e) {}
    }
  }

  function isUnlocked(pubkey) {
    if (!unlock) return false;
    const me = actor();
    const want = pubkey == null ? me : normalizePubkey(pubkey);
    const s = sessionState();
    if (!me || me !== unlock.pubkey || want !== unlock.pubkey || !s.ok || s.generation !== unlock.generation || App.guestMode === true) {
      lock('identity');
      return false;
    }
    if (now() - unlock.lastActivity > UNLOCK_TTL_MS) {
      lock('timeout');
      return false;
    }
    return true;
  }

  function touch() {
    if (isUnlocked()) unlock.lastActivity = now();
  }

  function remainingMs() {
    return isUnlocked() ? Math.max(0, UNLOCK_TTL_MS - (now() - unlock.lastActivity)) : 0;
  }

  // ---------------------------------------------------------------- storage

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(Object.assign(new Error('no idb'), { code: 'PIN_STORAGE_UNAVAILABLE' }));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PIN_STORE)) db.createObjectStore(PIN_STORE);
        if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(Object.assign(new Error('idb open'), { code: 'PIN_STORAGE_UNAVAILABLE' }));
    });
  }

  async function idb(storeName, mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let out;
        const req = fn(store);
        if (req) req.onsuccess = () => (out = req.result);
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(Object.assign(new Error('idb tx'), { code: 'PIN_STORAGE_UNAVAILABLE' }));
        tx.onabort = tx.onerror;
      });
    } finally {
      db.close();
    }
  }

  async function wrapKey() {
    let key = await idb(KEY_STORE, 'readonly', (s) => s.get(WRAP_ID));
    if (key) return key;
    key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb(KEY_STORE, 'readwrite', (s) => s.put(key, WRAP_ID));
    return (await idb(KEY_STORE, 'readonly', (s) => s.get(WRAP_ID))) || key;
  }

  function aad(pubkey) {
    return new TextEncoder().encode('sos-admin-pin-v1|' + pubkey);
  }

  async function derive(pin, salt, iterations) {
    const base = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await window.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function readRecord(pubkey) {
    return (await idb(PIN_STORE, 'readonly', (s) => s.get(pubkey))) || null;
  }

  async function writeRecord(pubkey, rec) {
    await idb(PIN_STORE, 'readwrite', (s) => s.put(rec, pubkey));
  }

  async function sealVerifier(pubkey, verifier) {
    const key = await wrapKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const plain = new Uint8Array(verifier.salt.length + verifier.hash.length);
    plain.set(verifier.salt, 0);
    plain.set(verifier.hash, verifier.salt.length);
    const ct = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(pubkey) }, key, plain));
    plain.fill(0);
    return { iv, ct, saltLength: verifier.salt.length, iterations: verifier.iterations };
  }

  async function openVerifier(pubkey, rec) {
    const key = await wrapKey();
    const plain = new Uint8Array(await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv, additionalData: aad(pubkey) }, key, rec.ct));
    return { salt: plain.slice(0, rec.saltLength), hash: plain.slice(rec.saltLength), iterations: rec.iterations };
  }

  // ---------------------------------------------------------------- API

  async function hasPin(pubkey) {
    const pk = normalizePubkey(pubkey == null ? actor() : pubkey);
    if (!pk) return false;
    try {
      const rec = await readRecord(pk);
      return !!(rec && rec.sealed);
    } catch (_e) {
      return false;
    }
  }

  function startUnlock(pk) {
    const s = sessionState();
    unlock = { pubkey: pk, generation: s.generation, lastActivity: now() };
  }

  async function setupPin(pin, confirmPin) {
    const pk = actor();
    if (!pk || App.guestMode === true) return fail('NO_IDENTITY');
    if (!sessionState().ok) return fail('SESSION_REVOKED');
    if (String(pin) !== String(confirmPin)) return fail('PIN_MISMATCH');
    if (!PIN_RE.test(String(pin))) return fail('PIN_FORMAT');
    if (isTrivialPin(pin)) return fail('PIN_TOO_SIMPLE');
    if (await hasPin(pk)) return fail('PIN_ALREADY_SET');
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(String(pin), salt, PBKDF2_ITERATIONS);
    const sealed = await sealVerifier(pk, { salt, hash, iterations: PBKDF2_ITERATIONS });
    hash.fill(0);
    await writeRecord(pk, { v: 1, sealed, failures: 0, lockUntil: 0, createdAt: now() });
    startUnlock(pk);
    return { ok: true, code: 'PIN_SET' };
  }

  async function verifyPin(pin) {
    const pk = actor();
    if (!pk || App.guestMode === true) return fail('NO_IDENTITY');
    if (!sessionState().ok) return fail('SESSION_REVOKED');
    if (verifyInFlight) return fail('PIN_BUSY');
    verifyInFlight = true;
    try {
      const rec = await readRecord(pk);
      if (!rec || !rec.sealed) return fail('PIN_NOT_SET');
      const t = now();
      if (rec.lockUntil && t < rec.lockUntil) return fail('PIN_LOCKED', { retryAfterMs: rec.lockUntil - t, failures: rec.failures || 0 });
      let ok = false;
      if (PIN_RE.test(String(pin))) {
        const v = await openVerifier(pk, rec.sealed);
        const h = await derive(String(pin), v.salt, v.iterations);
        ok = equalBytes(h, v.hash);
        h.fill(0);
        v.hash.fill(0);
      }
      if (ok) {
        rec.failures = 0;
        rec.lockUntil = 0;
        await writeRecord(pk, rec);
        startUnlock(pk);
        return { ok: true, code: 'UNLOCKED' };
      }
      rec.failures = (rec.failures || 0) + 1;
      const delay = delayForFailures(rec.failures);
      rec.lockUntil = delay ? now() + delay : 0;
      await writeRecord(pk, rec);
      return fail('PIN_WRONG', { failures: rec.failures, retryAfterMs: delay });
    } catch (e) {
      return fail((e && e.code) || 'PIN_VERIFY_FAILED');
    } finally {
      verifyInFlight = false;
    }
  }

  async function lockoutState() {
    const pk = actor();
    if (!pk) return { failures: 0, retryAfterMs: 0 };
    const rec = await readRecord(pk).catch(() => null);
    const t = now();
    return { failures: (rec && rec.failures) || 0, retryAfterMs: rec && rec.lockUntil && t < rec.lockUntil ? rec.lockUntil - t : 0 };
  }

  // ---------------------------------------------------------------- dialog

  const ERR = {
    PIN_MISMATCH: 'הקודים אינם זהים',
    PIN_FORMAT: 'יש להזין 6 ספרות',
    PIN_TOO_SIMPLE: 'הקוד פשוט מדי. בחרו קוד אחר',
    PIN_WRONG: 'קוד שגוי',
    PIN_LOCKED: 'יותר מדי ניסיונות. נסו שוב בעוד',
    NO_IDENTITY: 'יש להתחבר מחדש',
    SESSION_REVOKED: 'ההתחברות אינה בתוקף. התחברו מחדש',
    PIN_STORAGE_UNAVAILABLE: 'אחסון מקומי אינו זמין בדפדפן זה',
  };

  function fmtWait(ms) {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? Math.ceil(s / 60) + ' דק׳' : s + ' שנ׳';
  }

  function ensureStyles() {
    if (document.getElementById('sos-admin-pin-style')) return;
    const st = document.createElement('style');
    st.id = 'sos-admin-pin-style';
    st.textContent =
      '#sosAdminPinDialog{position:fixed;inset:0;z-index:12200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);direction:rtl;}' +
      '#sosAdminPinDialog .pin-box{background:#12141a;color:#f2f2f2;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:18px;width:min(360px,92vw);font-family:inherit;}' +
      '#sosAdminPinDialog h2{margin:0 0 6px;font-size:1.15rem;}' +
      '#sosAdminPinDialog p{margin:0 0 10px;font-size:.85rem;opacity:.8;}' +
      '#sosAdminPinDialog input{width:100%;box-sizing:border-box;margin:6px 0;padding:10px;font-size:1.4rem;letter-spacing:.5em;text-align:center;direction:ltr;background:#1b1e27;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:10px;}' +
      '#sosAdminPinDialog .pin-actions{display:flex;gap:8px;margin-top:10px;}' +
      '#sosAdminPinDialog button{flex:1;border:0;border-radius:8px;padding:10px;font-size:1rem;cursor:pointer;background:#2a3142;color:#fff;}' +
      '#sosAdminPinDialog button.primary{background:#3d7eff;}' +
      '#sosAdminPinDialog button[disabled]{opacity:.45;cursor:not-allowed;}' +
      '#sosAdminPinDialog .pin-err{min-height:1.3em;color:#ff8f8f;font-size:.85rem;margin-top:6px;}';
    document.head.appendChild(st);
  }

  function pinInput(id, label) {
    return (
      '<input id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" ' +
      'autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="' + label + '" name="' + id + '-' + Math.random().toString(36).slice(2) + '">'
    );
  }

  let dialogPromise = null;

  /** Resolves { ok:true } once the current identity is unlocked (setup or entry), { ok:false } on cancel. */
  function requestUnlock() {
    if (isUnlocked()) return Promise.resolve({ ok: true, code: 'ALREADY_UNLOCKED' });
    if (!actor() || App.guestMode === true) return Promise.resolve(fail('NO_IDENTITY'));
    if (dialogPromise) return dialogPromise;
    dialogPromise = (async () => {
      const setup = !(await hasPin());
      ensureStyles();
      const box = document.createElement('div');
      box.id = 'sosAdminPinDialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML =
        '<div class="pin-box">' +
        (setup
          ? '<h2 id="sosAdminPinTitle">הגדרת קוד מנהל</h2><p>בחרו קוד בן 6 ספרות. הקוד נועל את ממשק הניהול במכשיר זה בלבד.</p>' +
            pinInput('sosAdminPinNew', 'קוד חדש') + pinInput('sosAdminPinConfirm', 'אימות קוד')
          : '<h2 id="sosAdminPinTitle">קוד מנהל</h2><p>הזינו את קוד המנהל בן 6 הספרות.</p>' + pinInput('sosAdminPinInput', 'קוד מנהל')) +
        '<div class="pin-err" id="sosAdminPinErr" role="alert"></div>' +
        '<div class="pin-actions"><button type="button" class="primary" id="sosAdminPinOk">אישור</button>' +
        '<button type="button" id="sosAdminPinCancel">ביטול</button></div></div>';
      document.body.appendChild(box);
      const q = (id) => box.querySelector('#' + id);
      const inputs = Array.from(box.querySelectorAll('input'));
      inputs.forEach((inp) =>
        inp.addEventListener('input', () => {
          inp.value = inp.value.replace(/[^0-9]/g, '').slice(0, 6);
        })
      );
      inputs[0].focus();
      const errEl = q('sosAdminPinErr');
      const okBtn = q('sosAdminPinOk');
      let timer = null;
      const showLock = (ms) => {
        clearInterval(timer);
        const until = now() + ms;
        okBtn.disabled = true;
        const tick = () => {
          const left = until - now();
          if (left <= 0) {
            clearInterval(timer);
            okBtn.disabled = false;
            errEl.textContent = '';
            return;
          }
          errEl.textContent = ERR.PIN_LOCKED + ' ' + fmtWait(left);
        };
        tick();
        timer = setInterval(tick, 1000);
      };
      if (!setup) {
        const ls = await lockoutState();
        if (ls.retryAfterMs > 0) showLock(ls.retryAfterMs);
      }
      const result = await new Promise((resolve) => {
        const finish = (r) => {
          clearInterval(timer);
          inputs.forEach((i) => (i.value = ''));
          box.remove();
          resolve(r);
        };
        const submit = async () => {
          if (okBtn.disabled) return;
          okBtn.disabled = true;
          errEl.textContent = '';
          let r;
          if (setup) r = await setupPin(q('sosAdminPinNew').value, q('sosAdminPinConfirm').value);
          else r = await verifyPin(q('sosAdminPinInput').value);
          inputs.forEach((i) => (i.value = ''));
          if (r.ok) {
            finish({ ok: true, code: r.code });
            return;
          }
          okBtn.disabled = false;
          if (r.retryAfterMs > 0) showLock(r.retryAfterMs);
          else errEl.textContent = ERR[r.code] || 'הפעולה נכשלה';
          inputs[0].focus();
        };
        okBtn.addEventListener('click', submit);
        q('sosAdminPinCancel').addEventListener('click', () => finish(fail('CANCELLED')));
        box.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') submit();
          else if (ev.key === 'Escape') finish(fail('CANCELLED'));
        });
      });
      return result;
    })().finally(() => {
      dialogPromise = null;
    });
    return dialogPromise;
  }

  // ---------------------------------------------------------------- lifecycle

  let lastActor = '';
  function watch() {
    const me = actor();
    if (lastActor && me !== lastActor) lock('identity');
    lastActor = me;
    if (unlock) isUnlocked();
  }
  window.addEventListener('sos-identity-ready', watch);
  window.addEventListener('storage', watch);
  window.addEventListener('pagehide', () => lock('pagehide'));
  setInterval(watch, 5000);

  const api = Object.freeze({
    UNLOCK_TTL_MINUTES: UNLOCK_TTL_MS / 60000,
    PBKDF2_ITERATIONS,
    PIN_ONLY_ADMIN_AUTHORIZATION: false,
    isTrivialPin,
    delayForFailures,
    hasPin,
    setupPin,
    verifyPin,
    isUnlocked,
    touch,
    lock,
    remainingMs,
    lockoutState,
    requestUnlock,
  });

  App.AdminPinLock = api;
  window.SosAdminPinLock = api;
})(typeof window !== 'undefined' ? window : globalThis);
