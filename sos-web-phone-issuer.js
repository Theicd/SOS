/**
 * MD3W-W1B — Mobile Web PhoneIssuer adapter (Primary).
 * MD2 pairing → W1A trusted signer approval → Worker AUTHORIZE_LINKED_DEVICE → AEAD deliver.
 * No camera QR in this slice (QA paste/input). No T1 fallback. Production issuance remains off.
 */
(function initSosWebPhoneIssuer(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const CHANNEL = 'SOS_ALD_APPROVAL';
  const DEFAULT_SIGNER_ORIGIN = 'https://signer.sos010.com';
  const DEV_SIGNER_ORIGINS = Object.freeze(['http://127.0.0.1:8787', 'http://localhost:8787']);

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }

  function randomHex(n) {
    const a = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function linkTrace(phase, extra) {
    try {
      const src = extra && typeof extra === 'object' ? extra : {};
      const row = { t: Date.now(), phase: String(phase || '') };
      if (src.pairingFp) row.pairingFp = String(src.pairingFp).slice(0, 12);
      if (src.accountFp) row.accountFp = String(src.accountFp).slice(0, 8);
      if (src.sessionFp) row.sessionFp = String(src.sessionFp).slice(0, 8);
      if (src.code) row.code = String(src.code).slice(0, 64);
      if (src.vaultState) row.vaultState = String(src.vaultState).slice(0, 32);
      window.__sosLdLinkTrace = window.__sosLdLinkTrace || [];
      window.__sosLdLinkTrace.push(row);
      const parts = ['[SOS-LD]', row.phase];
      if (row.pairingFp) parts.push('pairingFp=' + row.pairingFp);
      if (row.accountFp) parts.push('accountFp=' + row.accountFp);
      if (row.sessionFp) parts.push('sessionFp=' + row.sessionFp);
      if (row.code) parts.push('code=' + row.code);
      if (row.vaultState) parts.push('vaultState=' + row.vaultState);
      console.info(parts.join(' '));
    } catch (_e) {}
  }

  function b64urlEncodeJson(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlDecodeJson(text) {
    const pad = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function publishLinkStatus(result) {
    try {
      window.dispatchEvent(new CustomEvent('sos-ld-link-status', { detail: result }));
    } catch (_e) {}
  }

  const RESUME_KEY = 'sos_ld_same_tab_v1';
  const RESUME_TTL_MS = 240000;

  function featureEnabled() {
    const FF = App.SosFeatureFlags || window.SosFeatureFlags;
    if (FF && typeof FF.isMd3wT2SignerApprovalEnabled === 'function') {
      return FF.isMd3wT2SignerApprovalEnabled() === true;
    }
    // Owner PRODUCTION FIRST (2026-10-12): allow explicit runtime enable on sos010.com.
    if (window.__SOS_MD3W_T2_SIGNER_APPROVAL__ === true) return true;
    return false;
  }

  function signerCeremonyUrl() {
    const configured = App.SOS_SIGNER_ORIGIN || window.SOS_SIGNER_ORIGIN || '';
    let origin = configured || DEFAULT_SIGNER_ORIGIN;
    try {
      const h = String(location.hostname || '');
      if ((h === 'localhost' || h === '127.0.0.1') && DEV_SIGNER_ORIGINS.length) {
        origin = App.SOS_SIGNER_DEV_ORIGIN || 'http://127.0.0.1:8787';
      }
    } catch (_e) {}
    const ro = encodeURIComponent(location.origin);
    const sid = encodeURIComponent(randomHex(8));
    return { url: origin.replace(/\/$/, '') + '/authorize-linked-device.html?returnOrigin=' + ro + '&sessionId=' + sid, origin: origin, sessionId: sid };
  }

  /**
   * Open trusted signer ceremony and wait for verified approval artifact.
   */
  function requestTrustedApproval(request, timeoutMs) {
    return new Promise((resolve) => {
      const cer = signerCeremonyUrl();
      const accountFp = normHex(request && request.accountP).slice(0, 8);
      const pairingFp = normHex(request && request.pairingId).slice(0, 12);
      const sessionFp = String(cer.sessionId || '').slice(0, 8);
      let done = false;
      let requestPosted = false;
      let popup = null;
      const timer = setTimeout(() => {
        linkTrace('SIGNER_APPROVAL_ERROR', {
          pairingFp: pairingFp,
          accountFp: accountFp,
          sessionFp: sessionFp,
          code: 'SIGNER_TIMEOUT',
        });
        finish({ ok: false, code: 'SIGNER_TIMEOUT' });
      }, timeoutMs || 180000);

      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        try {
          if (popup && !popup.closed) popup.close();
        } catch (_e) {}
        resolve(result);
      }

      function onMsg(ev) {
        if (done) return;
        const d = ev.data;
        if (!d || d.channel !== CHANNEL) return;
        if (String(ev.origin) !== String(cer.origin)) return;
        if (!popup || ev.source !== popup) return;
        if (String(d.sessionId || '') !== String(cer.sessionId)) return;
        if (d.type === 'SOS_ALD_APPROVAL_READY') {
          if (requestPosted) return;
          requestPosted = true;
          linkTrace('SIGNER_APPROVAL_READY', {
            pairingFp: pairingFp,
            accountFp: accountFp,
            sessionFp: sessionFp,
          });
          try {
            popup.postMessage(
              {
                channel: CHANNEL,
                type: 'SOS_ALD_APPROVAL_REQUEST',
                sessionId: cer.sessionId,
                request: request,
              },
              cer.origin,
            );
            linkTrace('SIGNER_APPROVAL_REQUEST', {
              pairingFp: pairingFp,
              accountFp: accountFp,
              sessionFp: sessionFp,
            });
          } catch (_e) {
            linkTrace('SIGNER_APPROVAL_ERROR', {
              pairingFp: pairingFp,
              accountFp: accountFp,
              sessionFp: sessionFp,
              code: 'SIGNER_POST_FAIL',
            });
            finish({ ok: false, code: 'SIGNER_POST_FAIL' });
          }
          return;
        }
        if (d.type === 'SOS_ALD_APPROVAL_RESULT' && d.artifact) {
          finish({ ok: true, artifact: d.artifact, sessionId: d.sessionId });
          return;
        }
        if (d.type === 'SOS_ALD_APPROVAL_ERROR') {
          linkTrace('SIGNER_APPROVAL_ERROR', {
            pairingFp: pairingFp,
            accountFp: accountFp,
            sessionFp: sessionFp,
            code: d.code || 'SIGNER_ERROR',
            vaultState: d.vaultState || '',
          });
          finish({
            ok: false,
            code: d.code || 'SIGNER_ERROR',
            vaultState: d.vaultState || '',
          });
        }
      }

      window.addEventListener('message', onMsg);
      try {
        // Do not use noopener: many browsers return null from window.open(noopener)
        // even when the Signer tab opens, which incorrectly fails closed as POPUP_BLOCKED.
        popup = window.open(cer.url, 'sos_ald_approval', 'width=420,height=720');
      } catch (_e) {
        popup = null;
      }
      if (!popup) {
        linkTrace('SIGNER_APPROVAL_ERROR', {
          pairingFp: pairingFp,
          accountFp: accountFp,
          sessionFp: sessionFp,
          code: 'SIGNER_POPUP_BLOCKED',
        });
        finish({ ok: false, code: 'SIGNER_POPUP_BLOCKED' });
        return;
      }
      linkTrace('SIGNER_POPUP_OPEN', {
        pairingFp: pairingFp,
        accountFp: accountFp,
        sessionFp: sessionFp,
      });
    });
  }

  async function workerAuthorize(artifact, expectedRequest) {
    const v = App.SosCryptoWorkerVault || window.SosCryptoWorkerVault;
    if (!v || typeof v.rpc !== 'function') return { ok: false, code: 'WORKER_VAULT_UNAVAILABLE' };
    const admission =
      App.FIRST_GROUP_ADMISSION_URL || App.GLOBAL_ADMISSION_URL || window.SOS_ADMISSION_URL || '';
    try {
      const out = await v.rpc('AUTHORIZE_LINKED_DEVICE', {
        artifact: artifact,
        expectedRequest: expectedRequest,
        featureEnabled: true,
        admissionBaseUrl: admission,
        storageSecurityClass: 'SOFTWARE_ONLY',
      });
      return out;
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'AUTHORIZE_RPC_FAILED' };
    }
  }

  /**
   * Full Primary flow from SOSPAIR1 QR text (paste/QA — no optical claim).
   */
  async function issueFromPairingQr(qrText, opts) {
    const o = opts || {};
    if (!featureEnabled()) {
      return {
        ok: false,
        code: 'WEB_MD3_ISSUANCE_DISABLED',
        WEB_MD3_ISSUANCE: false,
        T1_FALLBACK_DISABLED: true,
      };
    }
    const me = normHex(App.publicKey || '');
    if (!me || App.guestMode) return { ok: false, code: 'NOT_AUTHENTICATED' };

    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    if (GAS && typeof GAS.assertLinkedDeviceBindAllowed === 'function') {
      const gate = GAS.assertLinkedDeviceBindAllowed(me);
      if (gate && gate.ok === false) return { ok: false, code: gate.code || 'ACCOUNT_DISABLED' };
    }

    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.beginPhoneResponder !== 'function') {
      return { ok: false, code: 'MD2_PHONE_RESPONDER_MISSING' };
    }

    const session = await Md2.beginPhoneResponder(qrText, {
      relays: o.relays,
      pool: o.pool || App.pool,
      publishSigned: o.publishSigned,
    });
    if (!session || session.ok === false) {
      return { ok: false, code: (session && session.code) || 'MD2_START_FAIL' };
    }

    const accountFp = me.slice(0, 8);
    let bound;
    try {
      bound = await session.waitChannelReady(o.pairingTimeoutMs || 120000);
    } catch (_e) {
      try {
        session.stop();
      } catch (_s) {}
      linkTrace('SIGNER_APPROVAL_ERROR', { accountFp: accountFp, code: 'MD2_CHANNEL_TIMEOUT' });
      return { ok: false, code: 'MD2_CHANNEL_TIMEOUT' };
    }
    const pairingFp = String((bound && bound.pairingId) || '').slice(0, 12);
    linkTrace('MD2_CHANNEL_READY', { pairingFp: pairingFp, accountFp: accountFp });

    const authorizationId = randomHex(32);
    const expiresAt = Date.now() + (o.authTtlMs || 7 * 24 * 3600 * 1000);
    const expectedRequest = {
      accountP: me,
      deviceId: bound.deviceId,
      D_sign_pub: bound.dSignPub,
      D_enc_pub: bound.dEncPub,
      pairingTranscriptHash: bound.transcriptHex,
      pairingId: bound.pairingId,
      authorizationId: authorizationId,
      authEpoch: 1,
      capabilities: (App.AuthorizeLinkedDevice && App.AuthorizeLinkedDevice.NORMAL_PROFILE) || [
        'DEVICE_CHAT',
        'DEVICE_CALLS',
        'DEVICE_P2P',
        'DEVICE_FILES',
        'DEVICE_RECEIPTS',
        'DEVICE_PRESENCE',
        'DEVICE_SETTINGS',
        'DEVICE_HISTORY_SYNC',
      ],
      expiresAt: expiresAt,
      requestNonce: randomHex(32),
    };

    // Android Chrome drops user activation during MD2. Do not window.open here.
    if (o.transport === 'popup') {
      const approval = await requestTrustedApproval(expectedRequest, o.signerTimeoutMs);
      if (!approval.ok) {
        try { session.stop(); } catch (_s) {}
        const vaultState = approval.vaultState || '';
        if (approval.code === 'NO_WEBAUTHN_CREDENTIAL' || approval.code === 'WEBAUTHN_REQUIRED') {
          return { ok: false, code: 'WEBAUTHN_ENROLLMENT_REQUIRED', vaultState: vaultState, ACCOUNTS_WITHOUT_WEBAUTHN: true };
        }
        if (approval.code === 'SIGNER_POPUP_BLOCKED' || approval.code === 'SIGNER_TIMEOUT') {
          return { ok: false, code: 'TRUSTED_SIGNER_UNAVAILABLE', vaultState: vaultState };
        }
        return { ok: false, code: approval.code || 'APPROVAL_FAILED', vaultState: vaultState };
      }
      return completeAuthorizedSession(session, expectedRequest, approval.artifact, {
        accountFp: accountFp,
        pairingFp: pairingFp,
        me: me,
        bound: bound,
        ackTimeoutMs: o.ackTimeoutMs,
      });
    }

    return handoffSameTabCeremony(session, expectedRequest, pairingFp, accountFp);
  }

  function handoffSameTabCeremony(session, expectedRequest, pairingFp, accountFp) {
    const resume = session && typeof session.exportChannelResume === 'function' ? session.exportChannelResume() : null;
    if (!resume || !resume.skHex || resume.skHex.length !== 64) {
      try { session.stop(); } catch (_s) {}
      return { ok: false, code: 'RESUME_EXPORT_FAIL' };
    }
    const cer = signerCeremonyUrl();
    const returnPath = '/videos.html?v=899s21';
    const record = {
      v: 1,
      exp: Date.now() + RESUME_TTL_MS,
      sessionId: cer.sessionId,
      accountP: expectedRequest.accountP,
      expectedRequest: expectedRequest,
      resume: resume,
    };
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(record));
    } catch (_e) {
      try { session.stop(); } catch (_s) {}
      return { ok: false, code: 'RESUME_STORE_FAIL' };
    }
    let packed = '';
    try {
      packed = b64urlEncodeJson({
        v: 1,
        returnOrigin: location.origin,
        returnPath: returnPath,
        sessionId: cer.sessionId,
        request: expectedRequest,
      });
    } catch (_e) {
      try { sessionStorage.removeItem(RESUME_KEY); } catch (_r) {}
      try { session.stop(); } catch (_s) {}
      return { ok: false, code: 'RESUME_STORE_FAIL' };
    }
    const url = String(cer.origin || '').replace(/\/$/, '') + '/authorize-linked-device#sosAldReq=' + packed;
    linkTrace('SAME_TAB_CEREMONY', { pairingFp: pairingFp, accountFp: accountFp, sessionFp: String(cer.sessionId).slice(0, 8) });
    try {
      location.assign(url);
    } catch (_e) {
      try { sessionStorage.removeItem(RESUME_KEY); } catch (_r) {}
      try { session.stop(); } catch (_s) {}
      return { ok: false, code: 'SAME_TAB_NAV_FAIL' };
    }
    return { ok: true, code: 'SAME_TAB_HANDOFF', pending: true, WEB_MD3_ISSUANCE: true };
  }

  async function completeAuthorizedSession(session, expectedRequest, artifact, ctx) {
    const accountFp = ctx.accountFp;
    const pairingFp = ctx.pairingFp;
    const me = ctx.me;
    const bound = ctx.bound;
    linkTrace('WORKER_ISSUANCE', { pairingFp: pairingFp, accountFp: accountFp });
    const signed = await workerAuthorize(artifact, expectedRequest);
    if (!signed || signed.ok !== true || !signed.authorization) {
      try {
        session.stop();
      } catch (_s) {}
      linkTrace('SIGNER_APPROVAL_ERROR', {
        pairingFp: pairingFp,
        accountFp: accountFp,
        code: (signed && signed.code) || 'WORKER_AUTHORIZE_FAILED',
      });
      return { ok: false, code: (signed && signed.code) || 'WORKER_AUTHORIZE_FAILED' };
    }
    linkTrace('MD3_AUTHORIZED', { pairingFp: pairingFp, accountFp: accountFp });

    let delivered;
    try {
      delivered = await session.deliverDeviceAuthorization(signed.authorization);
    } catch (_e) {
      delivered = { ok: false, code: 'DELIVER_FAIL' };
    }
    if (!delivered || delivered.ok !== true) {
      try {
        session.stop();
      } catch (_s) {}
      linkTrace('SIGNER_APPROVAL_ERROR', {
        pairingFp: pairingFp,
        accountFp: accountFp,
        code: (delivered && delivered.code) || 'DELIVER_FAIL',
      });
      return { ok: false, code: (delivered && delivered.code) || 'DELIVER_FAIL' };
    }
    linkTrace('MD3_DELIVERED', { pairingFp: pairingFp, accountFp: accountFp });

    let ack;
    try {
      ack = await session.waitAuthAck((ctx && ctx.ackTimeoutMs) || 60000);
    } catch (_e) {
      ack = null;
    }
    try {
      session.stop();
    } catch (_s) {}

    if (!ack || ack.ok !== true) {
      linkTrace('SIGNER_APPROVAL_ERROR', {
        pairingFp: pairingFp,
        accountFp: accountFp,
        code: 'DESKTOP_ACK_MISSING',
      });
      return { ok: false, code: 'DESKTOP_ACK_MISSING', authorization: signed.authorization };
    }
    if (normHex(ack.authorizationId) !== normHex(signed.authorization.authorizationId)) {
      linkTrace('SIGNER_APPROVAL_ERROR', {
        pairingFp: pairingFp,
        accountFp: accountFp,
        code: 'FORGED_DESKTOP_ACK',
      });
      return { ok: false, code: 'FORGED_DESKTOP_ACK' };
    }
    linkTrace('DESKTOP_VERIFY_STRICT', { pairingFp: pairingFp, accountFp: accountFp });
    linkTrace('DESKTOP_LINKED', { pairingFp: pairingFp, accountFp: accountFp });

    return {
      ok: true,
      code: 'LINKED',
      authorization: signed.authorization,
      bound: bound,
      WEB_MD3_ISSUANCE: true,
      MD3_ISSUANCE_PATH: 'WEB_PHONEISSUER_T2',
      SAME_GLOBAL_P: normHex(signed.authorization.accountP) === me,
      T1_FALLBACK_DISABLED: true,
      ROOT_K_RETURNED: false,
    };
  }

  function peekResumeRecord() {
    let raw = '';
    try { raw = sessionStorage.getItem(RESUME_KEY) || ''; } catch (_e) { raw = ''; }
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      if (!rec || rec.v !== 1 || !rec.sessionId || !rec.expectedRequest || !rec.resume) return null;
      if (!(rec.exp > Date.now())) return null;
      return rec;
    } catch (_e) {
      return null;
    }
  }

  function clearSameTabStorage() {
    try { sessionStorage.removeItem(RESUME_KEY); } catch (_e) {}
    try { sessionStorage.removeItem('sos_ld_ald_res_v1'); } catch (_e) {}
  }

  function markSameTab(code) {
    const c = String(code || '').slice(0, 80);
    try { sessionStorage.setItem('sos_ld_dbg', c); } catch (_e) {}
    linkTrace('SAME_TAB_RESULT', { code: c });
  }

  async function waitForActiveAccount(expected, timeoutMs) {
    const want = normHex(expected);
    const deadline = Date.now() + (timeoutMs || 20000);
    while (Date.now() < deadline) {
      const me = normHex(App.publicKey || '');
      if (me && me === want && !App.guestMode) return me;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    return '';
  }

  async function consumeSameTabReturn() {
    let packed = '';
    try { packed = sessionStorage.getItem('sos_ld_ald_res_v1') || ''; } catch (_e) { packed = ''; }
    const hash = String(location.hash || '');
    if (!packed && hash.indexOf('#sosAldRes=') === 0) packed = hash.slice('#sosAldRes='.length);
    if (!packed) return;
    let env = null;
    try { env = b64urlDecodeJson(packed); } catch (_e) { env = null; }
    const rec = peekResumeRecord();
    if (!env || !rec || String(env.sessionId || '') !== String(rec.sessionId)) {
      markSameTab(!env ? 'BAD_RETURN' : !rec ? 'NO_RESUME' : 'SESSION_MISMATCH');
      publishLinkStatus({ ok: false, code: 'APPROVAL_FAILED' });
      return;
    }
    clearSameTabStorage();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_e) {}
    if (env.type !== 'SOS_ALD_APPROVAL_RESULT' || !env.artifact) {
      markSameTab(env.code || 'APPROVAL_FAILED');
      publishLinkStatus({ ok: false, code: env.code || 'APPROVAL_FAILED', vaultState: env.vaultState || '' });
      return;
    }
    if (!featureEnabled()) {
      markSameTab('WEB_MD3_ISSUANCE_DISABLED');
      publishLinkStatus({ ok: false, code: 'WEB_MD3_ISSUANCE_DISABLED', WEB_MD3_ISSUANCE: false, T1_FALLBACK_DISABLED: true });
      return;
    }
    markSameTab('RETURN_ACCEPTED');
    publishLinkStatus({ pending: true });
    const me = await waitForActiveAccount(rec.accountP, 20000);
    if (!me) {
      publishLinkStatus({ ok: false, code: 'NOT_AUTHENTICATED' });
      return;
    }
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.resumePhoneChannel !== 'function') {
      publishLinkStatus({ ok: false, code: 'APPROVAL_FAILED' });
      return;
    }
    const accountFp = me.slice(0, 8);
    const pairingFp = String(rec.resume.pairingId || '').slice(0, 12);
    linkTrace('SAME_TAB_RETURN', { pairingFp: pairingFp, accountFp: accountFp, sessionFp: String(rec.sessionId).slice(0, 8) });
    let session;
    try {
      session = await Md2.resumePhoneChannel(rec.resume, { pool: App.pool });
    } catch (_e) {
      session = null;
    }
    try { rec.resume.skHex = ''; } catch (_z) {}
    if (!session || session.ok !== true) {
      publishLinkStatus({ ok: false, code: (session && session.code) || 'RESUME_EXPORT_FAIL' });
      return;
    }
    const done = await completeAuthorizedSession(session, rec.expectedRequest, env.artifact, {
      accountFp: accountFp,
      pairingFp: pairingFp,
      me: me,
      bound: session.bound,
      ackTimeoutMs: 90000,
    });
    publishLinkStatus(done);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { consumeSameTabReturn(); });
    } else {
      consumeSameTabReturn();
    }
  }

  App.WebPhoneIssuer = {
    featureEnabled: featureEnabled,
    requestTrustedApproval: requestTrustedApproval,
    issueFromPairingQr: issueFromPairingQr,
    WEB_MD3_ISSUANCE_DEFAULT: false,
    T1_FALLBACK_ENABLED: false,
  };
  window.SosWebPhoneIssuer = App.WebPhoneIssuer;
})(window);
