/**
 * Package 899f — First-group admin control PIN (Hebrew UI), backed by the authoritative Admin 2FA service.
 * This module is only the dialog and a thin facade over Admin2faClient: enrollment, verification, lockout and
 * sessions are decided by the server. No local verifier is read, written or trusted; any older local PIN data is
 * ignored (not uploaded, not migrated). The PIN is never stored, logged, placed in URLs or sent in plaintext.
 * The admin session lives in memory only, bound to identity + session generation, 15 min inactivity TTL.
 */
(function initAdminPinLock(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  function C() {
    return App.Admin2faClient || window.SosAdmin2faClient || null;
  }

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
  const unavailable = () => fail('ADMIN_2FA_SERVICE_UNAVAILABLE');

  function isTrivialPin(pin) {
    const c = C();
    return c ? c.isTrivialPin(pin) : true;
  }

  /** Display only; the server applies the same schedule: 1-3 free, 30s, 60s, then 5 min doubling capped at 1h. */
  function delayForFailures(n) {
    if (n <= 3) return 0;
    if (n === 4) return 30 * 1000;
    if (n === 5) return 60 * 1000;
    return Math.min(5 * 60 * 1000 * Math.pow(2, n - 6), 60 * 60 * 1000);
  }

  // ---------------------------------------------------------------- facade

  async function hasPin(pubkey) {
    const c = C();
    const pk = pubkey == null ? actor() : normalizePubkey(pubkey);
    if (!c || !pk || pk !== actor()) return false;
    const s = await c.state().catch(() => null);
    return !!s && (s.state === c.STATE.PIN_CONFIGURED_LOCKED || s.state === c.STATE.ADMIN_SESSION_ACTIVE);
  }

  function setupPin(pin, confirmPin) {
    const c = C();
    return c ? c.enroll(pin, confirmPin) : Promise.resolve(unavailable());
  }

  function verifyPin(pin) {
    const c = C();
    return c ? c.verify(pin) : Promise.resolve(unavailable());
  }

  function isUnlocked(pubkey) {
    const c = C();
    return !!c && c.isActive(pubkey);
  }

  function touch() {
    const c = C();
    if (c) c.touch();
  }

  function lock(reason) {
    const c = C();
    if (c) c.lock(reason);
  }

  function remainingMs() {
    const c = C();
    return c ? c.remainingMs() : 0;
  }

  function lockoutState() {
    const c = C();
    return c ? c.lockoutState() : Promise.resolve({ failures: 0, retryAfterMs: 0 });
  }

  // ---------------------------------------------------------------- dialog

  const ERR = {
    PIN_MISMATCH: 'הקודים אינם זהים',
    PIN_FORMAT: 'יש להזין 6 ספרות',
    PIN_TOO_SIMPLE: 'הקוד פשוט מדי. בחרו קוד אחר',
    PIN_WRONG: 'קוד שגוי',
    PIN_LOCKED: 'יותר מדי ניסיונות. נסו שוב בעוד',
    PIN_RATE_LIMITED: 'יותר מדי ניסיונות. נסו שוב בעוד',
    PIN_ALREADY_SET: 'קוד מנהל כבר הוגדר',
    PIN_NOT_SET: 'עדיין לא הוגדר קוד מנהל',
    NO_IDENTITY: 'יש להתחבר מחדש',
    SESSION_REVOKED: 'ההתחברות אינה בתוקף. התחברו מחדש',
    ADMIN_SESSION_EXPIRED: 'פג תוקף אימות המנהל. הזינו שוב את קוד המנהל',
    ADMIN_2FA_SERVICE_UNAVAILABLE: 'שירות אימות המנהל אינו זמין כרגע',
    ADMIN_2FA_DENIED: 'השרת לא אישר את הפעולה',
    UNAUTHORIZED: 'אין הרשאה לפעולה הזו',
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

  /**
   * mode: 'setup' | 'entry' | 'stepup'. submit(values) resolves { ok } or a failure code shown in Hebrew.
   * Resolves { ok:true } on success, { ok:false, code:'CANCELLED' } on cancel.
   */
  function openDialog(mode, submitFn, initialLockMs) {
    ensureStyles();
    const box = document.createElement('div');
    box.id = 'sosAdminPinDialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const body =
      mode === 'setup'
        ? '<h2 id="sosAdminPinTitle">הגדרת קוד מנהל</h2><p>בחרו קוד בן 6 ספרות. הקוד נבדק בשרת אימות המנהל ונדרש לכל פעולת ניהול.</p>' +
          pinInput('sosAdminPinNew', 'קוד חדש') + pinInput('sosAdminPinConfirm', 'אימות קוד')
        : mode === 'stepup'
          ? '<h2 id="sosAdminPinTitle">קוד מנהל</h2><p>פעולה רגישה. הזינו שוב את קוד המנהל בן 6 הספרות.</p>' + pinInput('sosAdminPinInput', 'קוד מנהל')
          : '<h2 id="sosAdminPinTitle">קוד מנהל</h2><p>הזינו את קוד המנהל בן 6 הספרות.</p>' + pinInput('sosAdminPinInput', 'קוד מנהל');
    box.innerHTML =
      '<div class="pin-box">' +
      body +
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
    if (initialLockMs > 0) showLock(initialLockMs);
    return new Promise((resolve) => {
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
        const values = inputs.map((i) => i.value);
        inputs.forEach((i) => (i.value = ''));
        let r;
        try {
          r = await submitFn(values);
        } catch (_e) {
          r = unavailable();
        }
        if (r && r.ok) {
          finish({ ok: true, code: r.code });
          return;
        }
        okBtn.disabled = false;
        if (r && r.retryAfterMs > 0) showLock(r.retryAfterMs);
        else errEl.textContent = ERR[r && r.code] || 'הפעולה נכשלה';
        if (r && (r.code === 'NO_IDENTITY' || r.code === 'SESSION_REVOKED')) {
          finish(fail(r.code));
          return;
        }
        inputs[0].focus();
      };
      okBtn.addEventListener('click', submit);
      q('sosAdminPinCancel').addEventListener('click', () => finish(fail('CANCELLED')));
      box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit();
        else if (ev.key === 'Escape') finish(fail('CANCELLED'));
      });
    });
  }

  function single(fn) {
    if (dialogPromise) return dialogPromise;
    dialogPromise = fn().finally(() => {
      dialogPromise = null;
    });
    return dialogPromise;
  }

  /** Resolves { ok:true } once the server reports an active admin session (setup or entry), { ok:false } otherwise. */
  function requestUnlock() {
    if (isUnlocked()) return Promise.resolve({ ok: true, code: 'ALREADY_UNLOCKED' });
    if (!actor() || App.guestMode === true) return Promise.resolve(fail('NO_IDENTITY'));
    const c = C();
    if (!c) return Promise.resolve(unavailable());
    return single(async () => {
      const st = await c.state().catch(() => ({ state: c.STATE.SERVICE_UNAVAILABLE }));
      if (st.state === c.STATE.ADMIN_SESSION_ACTIVE) return { ok: true, code: 'ALREADY_UNLOCKED' };
      if (st.state === c.STATE.NO_IDENTITY) return fail('NO_IDENTITY');
      if (st.state === c.STATE.NOT_ADMIN) return fail('UNAUTHORIZED');
      if (st.state === c.STATE.SERVICE_UNAVAILABLE) return unavailable();
      if (st.state === c.STATE.PIN_NOT_CONFIGURED) {
        return openDialog('setup', (v) => c.enroll(v[0], v[1]), 0);
      }
      return openDialog('entry', (v) => c.verify(v[0]), st.retryAfterMs || 0);
    });
  }

  /** Sensitive re-auth: collects the PIN once more and hands it to onPin (which performs the server step-up). */
  function requestStepUp(onPin) {
    if (!actor() || App.guestMode === true) return Promise.resolve(fail('NO_IDENTITY'));
    if (typeof onPin !== 'function') return Promise.resolve(fail('BAD_REQUEST'));
    return single(() => openDialog('stepup', (v) => onPin(v[0]), 0));
  }

  const api = Object.freeze({
    UNLOCK_TTL_MINUTES: 15,
    PBKDF2_ITERATIONS: 600000,
    PIN_ONLY_ADMIN_AUTHORIZATION: false,
    SERVER_PIN_AUTHORITATIVE: true,
    LOCAL_UI_PIN_ONLY: false,
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
    requestStepUp,
    ERROR_TEXT: ERR,
  });

  App.AdminPinLock = api;
  window.SosAdminPinLock = api;
})(typeof window !== 'undefined' ? window : globalThis);
