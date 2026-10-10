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

  function featureEnabled() {
    const FF = App.SosFeatureFlags || window.SosFeatureFlags;
    if (FF && typeof FF.isMd3wT2SignerApprovalEnabled === 'function') {
      return FF.isMd3wT2SignerApprovalEnabled() === true;
    }
    if (window.__SOS_MD3W_T2_SIGNER_APPROVAL__ === true) {
      try {
        const h = String(location.hostname || '').toLowerCase();
        if (h === 'sos010.com' || h === 'www.sos010.com') return false;
      } catch (_e) {
        return false;
      }
      return true;
    }
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
      let done = false;
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, code: 'SIGNER_TIMEOUT' });
      }, timeoutMs || 180000);

      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        try {
          if (popup && !popup.closed) popup.close();
        } catch (_e) {}
      }

      function onMsg(ev) {
        const d = ev.data;
        if (!d || d.channel !== CHANNEL) return;
        if (String(ev.origin) !== String(cer.origin)) return;
        if (d.type === 'SOS_ALD_APPROVAL_READY') {
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
          } catch (_e) {
            cleanup();
            resolve({ ok: false, code: 'SIGNER_POST_FAIL' });
          }
          return;
        }
        if (d.type === 'SOS_ALD_APPROVAL_RESULT' && d.artifact) {
          cleanup();
          resolve({ ok: true, artifact: d.artifact, sessionId: d.sessionId });
          return;
        }
        if (d.type === 'SOS_ALD_APPROVAL_ERROR') {
          cleanup();
          resolve({ ok: false, code: d.code || 'SIGNER_ERROR' });
        }
      }

      window.addEventListener('message', onMsg);
      let popup = null;
      try {
        popup = window.open(cer.url, 'sos_ald_approval', 'noopener,noreferrer,width=420,height=720');
      } catch (_e) {
        popup = null;
      }
      if (!popup) {
        cleanup();
        resolve({ ok: false, code: 'SIGNER_POPUP_BLOCKED' });
      }
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

    let bound;
    try {
      bound = await session.waitChannelReady(o.pairingTimeoutMs || 120000);
    } catch (_e) {
      try {
        session.stop();
      } catch (_s) {}
      return { ok: false, code: 'MD2_CHANNEL_TIMEOUT' };
    }

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

    const approval = await requestTrustedApproval(expectedRequest, o.signerTimeoutMs);
    if (!approval.ok) {
      try {
        session.stop();
      } catch (_s) {}
      if (approval.code === 'NO_WEBAUTHN_CREDENTIAL' || approval.code === 'WEBAUTHN_REQUIRED') {
        return { ok: false, code: 'WEBAUTHN_ENROLLMENT_REQUIRED', ACCOUNTS_WITHOUT_WEBAUTHN: true };
      }
      if (approval.code === 'SIGNER_POPUP_BLOCKED' || approval.code === 'SIGNER_TIMEOUT') {
        return { ok: false, code: 'TRUSTED_SIGNER_UNAVAILABLE' };
      }
      return { ok: false, code: approval.code || 'APPROVAL_FAILED' };
    }

    const signed = await workerAuthorize(approval.artifact, expectedRequest);
    if (!signed || signed.ok !== true || !signed.authorization) {
      try {
        session.stop();
      } catch (_s) {}
      return { ok: false, code: (signed && signed.code) || 'WORKER_AUTHORIZE_FAILED' };
    }

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
      return { ok: false, code: (delivered && delivered.code) || 'DELIVER_FAIL' };
    }

    let ack;
    try {
      ack = await session.waitAuthAck(o.ackTimeoutMs || 60000);
    } catch (_e) {
      ack = null;
    }
    try {
      session.stop();
    } catch (_s) {}

    if (!ack || ack.ok !== true) {
      return { ok: false, code: 'DESKTOP_ACK_MISSING', authorization: signed.authorization };
    }
    if (normHex(ack.authorizationId) !== normHex(signed.authorization.authorizationId)) {
      return { ok: false, code: 'FORGED_DESKTOP_ACK' };
    }

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

  App.WebPhoneIssuer = {
    featureEnabled: featureEnabled,
    requestTrustedApproval: requestTrustedApproval,
    issueFromPairingQr: issueFromPairingQr,
    WEB_MD3_ISSUANCE_DEFAULT: false,
    T1_FALLBACK_ENABLED: false,
  };
  window.SosWebPhoneIssuer = App.WebPhoneIssuer;
})(window);
