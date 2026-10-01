/**
 * F5B6-W — Worker Vault → isolated signer recovery handoff (main page side).
 * The page only relays the signer's one-time ECDH public key to the Worker and the sealed envelope back.
 * It never receives K. Recovery reveal happens only on the signer origin (F5B5).
 * Design: docs/security/F5B6_WEB_WORKER_TO_SIGNER_HANDOFF_DESIGN.md
 */
(function initF5b6wHandoffClient(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const PROTOCOL = 1;
  const PRODUCTION_SIGNER_ORIGIN = 'https://signer.sos010.com';
  const LOCAL_SIGNER_ORIGIN = 'http://localhost:8787';
  const STATE_PREFIX = 'sos_recovery_backup_v1:';
  const DESTROY_PHRASE = 'מחק לצמיתות';

  let active = null;

  function normalizePubkey(p) {
    const s = String(p || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(s) ? s : '';
  }

  function currentPubkey() {
    return normalizePubkey(App.publicKey);
  }

  /** Localhost signer only for a localhost page; production pages always use the production signer. */
  function signerOrigin() {
    const host = String(window.location.hostname || '');
    if (host === 'localhost' || host === '127.0.0.1') return LOCAL_SIGNER_ORIGIN;
    return PRODUCTION_SIGNER_ORIGIN;
  }

  function isWorkerIdentity() {
    const S = App.SosCryptoSigner;
    return !!(S && typeof S.isWorkerAuthoritative === 'function' && S.isWorkerAuthoritative() && currentPubkey());
  }

  function readState(pubkey) {
    const pk = normalizePubkey(pubkey);
    if (!pk) return null;
    try {
      const raw = window.localStorage.getItem(STATE_PREFIX + pk);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.pubkey === pk ? parsed : null;
    } catch (_e) {
      return null;
    }
  }

  function isBackupConfirmed(pubkey) {
    const st = readState(pubkey);
    return !!(st && st.confirmed === true);
  }

  function needsBackup() {
    return isWorkerIdentity() && !isBackupConfirmed(currentPubkey());
  }

  function emit(state, extra) {
    try {
      window.dispatchEvent(
        new CustomEvent('sos-recovery-backup-state', { detail: Object.assign({ state, pubkey: active ? active.pubkey : currentPubkey() }, extra || {}) })
      );
    } catch (_e) {}
  }

  function post(msg) {
    if (!active || !active.win || active.win.closed) return;
    try {
      active.win.postMessage(Object.assign({ protocol: PROTOCOL }, msg), active.origin);
    } catch (_e) {}
  }

  function start() {
    const pk = currentPubkey();
    if (!pk) return { ok: false, code: 'NO_IDENTITY' };
    if (!isWorkerIdentity()) return { ok: false, code: 'NOT_WORKER_IDENTITY' };
    const origin = signerOrigin();
    const q = new URLSearchParams({ protocol: String(PROTOCOL), expectedPubkey: pk, returnOrigin: window.location.origin });
    let win = null;
    try {
      // A live window reference is required for the sealed-envelope channel (no noopener).
      win = window.open(origin + '/handoff?' + q.toString(), 'sos_signer_handoff', 'width=520,height=760');
    } catch (_e) {
      win = null;
    }
    if (!win) return { ok: false, code: 'POPUP_BLOCKED' };
    active = { win, origin, pubkey: pk, sealed: new Set(), acked: new Set() };
    emit('OPENED');
    return { ok: true, signerOrigin: origin };
  }

  async function handleOffer(d) {
    const sessionId = String(d.sessionId || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(sessionId)) return;
    if (normalizePubkey(d.expectedPubkey) !== active.pubkey || currentPubkey() !== active.pubkey) {
      post({ type: 'SOS_F5B6W_ERROR', sessionId, code: 'ACCOUNT_MISMATCH' });
      emit('ERROR', { code: 'ACCOUNT_MISMATCH' });
      return;
    }
    const V = App.SosCryptoWorkerVault || window.SosCryptoWorkerVault;
    if (!V || typeof V.rpc !== 'function') {
      post({ type: 'SOS_F5B6W_ERROR', sessionId, code: 'WORKER_VAULT_UNAVAILABLE' });
      emit('ERROR', { code: 'WORKER_VAULT_UNAVAILABLE' });
      return;
    }
    try {
      const envelope = await V.rpc('SEAL_IDENTITY_FOR_SIGNER', {
        sessionId,
        expectedPubkey: active.pubkey,
        recipientPub: String(d.recipientPub || ''),
        exp: Number(d.exp),
      });
      active.sealed.add(sessionId);
      post({ type: 'SOS_F5B6W_ENVELOPE', sessionId, envelope });
      emit('SEALED', { sealsRemaining: envelope && envelope.sealsRemaining });
    } catch (err) {
      const code = (err && err.code) || 'SEAL_FAILED';
      post({ type: 'SOS_F5B6W_ERROR', sessionId, code });
      emit('ERROR', { code });
    }
  }

  function writeConfirmed(sessionId) {
    try {
      window.localStorage.setItem(
        STATE_PREFIX + active.pubkey,
        JSON.stringify({ pubkey: active.pubkey, confirmed: true, keyFileExported: true, confirmedAt: Date.now(), sessionId, signerOrigin: active.origin })
      );
    } catch (_e) {}
  }

  function onMessage(ev) {
    if (!active || !ev || ev.origin !== active.origin || ev.source !== active.win) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.protocol !== PROTOCOL) return;
    const sessionId = String(d.sessionId || '').toLowerCase();
    if (d.type === 'SOS_F5B6W_OFFER') {
      handleOffer(d);
    } else if (d.type === 'SOS_F5B6W_ACK') {
      if (d.ok !== true || normalizePubkey(d.pubkey) !== active.pubkey) {
        emit('ERROR', { code: String(d.code || 'SIGNER_IMPORT_FAILED') });
        return;
      }
      if (!active.sealed.has(sessionId) && d.sameIdentity !== true) return;
      active.acked.add(sessionId);
      emit('IN_SIGNER');
    } else if (d.type === 'SOS_F5B6W_KEY_EXPORTED') {
      if (normalizePubkey(d.pubkey) !== active.pubkey || !active.acked.has(sessionId)) return;
      writeConfirmed(sessionId);
      emit('CONFIRMED');
    }
  }

  window.addEventListener('message', onMessage);

  // ------------------------------------------------------------------ logout guard UI

  function el(tag, attrs, text) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    if (text != null) n.textContent = text;
    return n;
  }

  function closeLogoutGuard() {
    const old = document.getElementById('sosRecoveryLogoutGuard');
    if (old) old.remove();
  }

  /** Severe warning before a Worker identity without a confirmed backup is removed from this browser. */
  function openLogoutGuard(logoutOptions) {
    closeLogoutGuard();
    const overlay = el('div', {
      id: 'sosRecoveryLogoutGuard',
      role: 'alertdialog',
      'aria-modal': 'true',
      dir: 'rtl',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;',
    });
    const box = el('div', {
      style: 'background:#1a1a2e;border:2px solid #f44336;border-radius:12px;max-width:440px;width:100%;padding:20px;color:#fff;text-align:right;font-size:15px;line-height:1.6;',
    });
    box.appendChild(el('h2', { style: 'margin:0 0 12px;color:#f44336;font-size:20px;' }, 'אזהרה: התנתקות תמחק את הגישה לחשבון'));
    box.appendChild(
      el(
        'p',
        { style: 'margin:0 0 10px;' },
        'המפתח האישי של החשבון הזה נשמר רק במנגנון האבטחה של הדפדפן הזה, ועדיין לא שמרת אותו כקובץ.'
      )
    );
    box.appendChild(
      el('p', { style: 'margin:0 0 16px;font-weight:bold;' }, 'התנתקות או מחיקת נתוני האתר יסירו לצמיתות את הגישה לזהות הזו. לא ניתן יהיה לשחזר אותה.')
    );
    const status = el('p', { id: 'sosRecoveryLogoutGuardStatus', style: 'min-height:20px;margin:0 0 10px;color:#ffc107;' }, '');
    const primary = el('button', { type: 'button', class: 'button-primary', id: 'sosRecoveryGuardBackup', style: 'width:100%;padding:12px;margin-bottom:8px;' }, 'קבלת המפתח האישי');
    primary.addEventListener('click', () => {
      const r = start();
      status.textContent = r.ok ? 'המשיכו בחלון המאובטח (signer.sos010.com).' : r.code === 'POPUP_BLOCKED' ? 'הדפדפן חסם את החלון המאובטח.' : 'לא ניתן לפתוח את החלון המאובטח.';
    });
    const cancel = el('button', { type: 'button', class: 'button-secondary', id: 'sosRecoveryGuardCancel', style: 'width:100%;padding:12px;margin-bottom:14px;' }, 'ביטול — הישאר מחובר');
    cancel.addEventListener('click', closeLogoutGuard);
    box.appendChild(status);
    box.appendChild(primary);
    box.appendChild(cancel);

    const details = el('details', { style: 'border-top:1px solid #444;padding-top:10px;' });
    details.appendChild(el('summary', { style: 'cursor:pointer;color:#f44336;' }, 'מחיקת החשבון מהדפדפן לצמיתות'));
    details.appendChild(el('p', { style: 'margin:8px 0;' }, 'כדי להתנתק בלי לשמור את המפתח, הקלידו: ' + DESTROY_PHRASE));
    const input = el('input', { type: 'text', id: 'sosRecoveryGuardPhrase', autocomplete: 'off', style: 'width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;' });
    const destroy = el('button', { type: 'button', id: 'sosRecoveryGuardDestroy', disabled: 'disabled', style: 'width:100%;padding:10px;background:#b71c1c;color:#fff;border:none;border-radius:6px;' }, 'התנתק ומחק לצמיתות');
    input.addEventListener('input', () => {
      destroy.disabled = input.value.trim() !== DESTROY_PHRASE;
    });
    destroy.addEventListener('click', () => {
      if (input.value.trim() !== DESTROY_PHRASE) return;
      closeLogoutGuard();
      if (typeof App.logoutIdentity === 'function') {
        App.logoutIdentity(Object.assign({}, logoutOptions || {}, { destroyIdentityConfirmed: true }));
      }
    });
    details.appendChild(input);
    details.appendChild(destroy);
    box.appendChild(details);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    window.addEventListener('sos-recovery-backup-state', function onState(ev) {
      if (!document.getElementById('sosRecoveryLogoutGuard')) {
        window.removeEventListener('sos-recovery-backup-state', onState);
        return;
      }
      const st = ev && ev.detail && ev.detail.state;
      if (st === 'CONFIRMED') {
        status.textContent = 'המפתח נשמר בהצלחה. כעת ניתן להתנתק בבטחה.';
        status.style.color = '#4caf50';
        primary.hidden = true;
      } else if (st === 'ERROR') {
        status.textContent = 'קבלת המפתח נכשלה: ' + ((ev.detail && ev.detail.code) || 'שגיאה');
      }
    });
    return { ok: true };
  }

  const api = Object.freeze({
    PROTOCOL,
    DESTROY_PHRASE,
    signerOrigin,
    start,
    isWorkerIdentity,
    isBackupConfirmed,
    isPersonalKeyExported: isBackupConfirmed,
    needsBackup,
    openLogoutGuard,
    closeLogoutGuard,
  });
  App.RecoveryBackup = api;
  window.SosRecoveryBackup = api;
})(window);
