/**
 * ROOT-only account disable/re-enable and directory hide/restore.
 * Signs via typed AdminSigningPolicy (39005 / 39006) + Admin 2FA attestation.
 * Re-enable does NOT restore membership, capabilities, or blocklist.
 */
(function initAccountDirectoryOps(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const GROUP_ID = 'israel-network';

  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function ASS() {
    return App.AccountStatusState || window.SosAccountStatusState || null;
  }
  function DHS() {
    return App.DirectoryHygieneState || window.SosDirectoryHygieneState || null;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function fail(code, extra) {
    return Object.assign({ ok: false, code }, extra || {});
  }

  function controlOk() {
    const g = GCS();
    if (!g) return fail('NO_GCS');
    try {
      if (typeof g.syncFromSharedCache === 'function') g.syncFromSharedCache();
    } catch (_e) {}
    if (typeof g.mutationsBlockedByConflict === 'function' && g.mutationsBlockedByConflict()) {
      return fail('CONTROL_CONFLICT');
    }
    if (typeof g.getStatus === 'function' && g.getStatus() !== 'VERIFIED') return fail('INVALID_CONTROL');
    const live = g.getVerifiedControlState();
    if (!live || live.verified !== true) return fail('INVALID_CONTROL');
    return { ok: true, control: live, gcs: g };
  }

  function attestPrivileged(event, extra) {
    const C = App.Admin2faClient;
    if (C && typeof C.attest === 'function') return C.attest(event, extra);
    const A = App.Admin2faProtocol;
    return Promise.resolve(A && A.isEnforced() ? fail('ADMIN_2FA_SERVICE_UNAVAILABLE') : { ok: true, skipped: true });
  }

  async function signPublishIngest(operation, targetPubkey, opts) {
    const options = opts || {};
    const ctrl = controlOk();
    if (!ctrl.ok) return ctrl;
    const actor = normalizePubkey(App.publicKey);
    const target = normalizePubkey(targetPubkey);
    if (!actor) return fail('NO_IDENTITY');
    if (!target) return fail('BAD_PUBKEY');
    if (actor !== normalizePubkey(ctrl.control.rootAdminPubkey)) return fail('ROOT_ONLY');
    if (target === actor || target === normalizePubkey(ctrl.control.rootAdminPubkey)) return fail('ROOT_PROTECTED');

    const S = App.SosCryptoSigner;
    if (!S || typeof S.signTypedAdminOperation !== 'function') return fail('SIGNER_MISSING');
    const baseEvent = ctrl.gcs.getVerifiedControlEvent ? ctrl.gcs.getVerifiedControlEvent() : null;
    if (!baseEvent) return fail('NO_BASE_EVENT');

    const isAccount = operation === 'DISABLE_ACCOUNT' || operation === 'REENABLE_ACCOUNT';
    const isDir = operation === 'HIDE_DIRECTORY' || operation === 'RESTORE_DIRECTORY';
    if (!isAccount && !isDir) return fail('UNKNOWN_OP');

    const tip =
      isAccount && ASS()
        ? ASS().tipOf(target)
        : isDir && DHS()
          ? DHS().tipOf(target)
          : null;

    const req = {
      version: 1,
      operation,
      groupId: GROUP_ID,
      baseEvent,
      targetPubkey: target,
      controlConflict:
        typeof ctrl.gcs.mutationsBlockedByConflict === 'function' &&
        ctrl.gcs.mutationsBlockedByConflict() === true,
    };
    if (options.reasonCode) req.reasonCode = options.reasonCode;
    if (tip && Number.isInteger(tip.revision)) req.priorRevision = tip.revision;
    if (isAccount && tip && tip.event) req.accountStatusTipEvent = tip.event;
    if (isDir && tip && tip.event) req.directoryHygieneTipEvent = tip.event;

    let signed;
    try {
      signed = await Promise.resolve(S.signTypedAdminOperation(req));
    } catch (e) {
      return fail('SIGN_FAILED', { error: e && e.message });
    }

    const att = await attestPrivileged(signed, {
      expectedOperations: [operation],
      controlEpoch: ctrl.control.controlEpoch,
    });
    if (!att.ok) return fail(att.code || 'ADMIN_2FA_REQUIRED', { event: signed });

    if (!options.skipPublish) {
      if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
        return fail('NO_RELAYS', { event: signed });
      }
      try {
        if (att.attestation) await App.pool.publish(App.relayUrls, att.attestation);
        await App.pool.publish(App.relayUrls, signed);
      } catch (e) {
        return fail('PUBLISH_FAILED', { error: e && e.message, event: signed });
      }
    }

    if (isAccount && ASS()) {
      const root = normalizePubkey(ctrl.control.rootAdminPubkey);
      ASS().setRoot(root);
      const ing = ASS().ingest(signed);
      if (!ing.ok) return fail(ing.code || 'INGEST_FAILED', { event: signed });
      ASS().enforceLiveSession();
    }
    // Mirror account disable/enable into GLOBAL authority (39008 / Worker). Community capability alone is not enough.
    if (isAccount) {
      try {
        const GA = App.GlobalAdmission || window.SosGlobalAdmission;
        const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
        const status =
          operation === 'DISABLE_ACCOUNT' ? 'ACCOUNT_DISABLED' : operation === 'REENABLE_ACCOUNT' ? 'ACTIVE' : '';
        if (status && GA && typeof GA.setGlobalAccountStatus === 'function') {
          const authEvent = signed; // root-signed privileged op — Worker verifies ROOT_PUBKEY
          const g = await GA.setGlobalAccountStatus({
            targetPubkey: normalizePubkey(targetPubkey),
            status,
            reasonCode: (options && options.reasonCode) || 'ADMIN_DISABLED',
            authEvent,
          });
          if (g && g.result === 'OK' && g.event && GAS && typeof GAS.ingest === 'function') {
            if (g.issuerPubkey || (g.event && g.event.pubkey)) {
              try {
                GAS.setIssuerAllowlist([g.event.pubkey, ctrl.control.rootAdminPubkey]);
              } catch (_e) {}
            }
            GAS.ingest(g.event);
            GAS.enforceLiveSession();
          }
        }
      } catch (_globalMirror) {}
    }
    if (isDir && DHS()) {
      DHS().setRoot(normalizePubkey(ctrl.control.rootAdminPubkey));
      const ing = DHS().ingest(signed);
      if (!ing.ok) return fail(ing.code || 'INGEST_FAILED', { event: signed });
    }

    return {
      ok: true,
      code: 'APPLIED',
      event: signed,
      attestation: att.attestation || null,
      // Explicit non-claims for re-enable / hide
      REENABLE_RESTORES_MEMBERSHIP: false,
      REENABLE_RESTORES_CAPABILITIES: false,
      REENABLE_RESTORES_BLOCKLIST: false,
      DIRECTORY_HIDE_IS_CRYPTOGRAPHIC_DELETION: false,
      DIRECTORY_HIDE_ERASES_RELAY_HISTORY: false,
    };
  }

  async function disableAccount(targetPubkey, opts) {
    const ass = ASS();
    const target = normalizePubkey(targetPubkey);
    if (ass && ass.isDisabled(target)) return fail('ALREADY_DISABLED');
    return signPublishIngest('DISABLE_ACCOUNT', target, opts);
  }

  async function reenableAccount(targetPubkey, opts) {
    const ass = ASS();
    const target = normalizePubkey(targetPubkey);
    if (!ass || !ass.isDisabled(target)) return fail('NOT_DISABLED');
    return signPublishIngest('REENABLE_ACCOUNT', target, opts);
  }

  async function hideFromDirectory(targetPubkey, opts) {
    const dhs = DHS();
    const target = normalizePubkey(targetPubkey);
    if (dhs && dhs.isHidden(target)) return fail('ALREADY_HIDDEN');
    return signPublishIngest('HIDE_DIRECTORY', target, opts);
  }

  async function restoreToDirectory(targetPubkey, opts) {
    const dhs = DHS();
    const target = normalizePubkey(targetPubkey);
    if (!dhs || !dhs.isHidden(target)) return fail('NOT_HIDDEN');
    return signPublishIngest('RESTORE_DIRECTORY', target, opts);
  }

  const api = Object.freeze({
    disableAccount,
    reenableAccount,
    hideFromDirectory,
    restoreToDirectory,
    REENABLE_RESTORES_MEMBERSHIP: false,
    REENABLE_RESTORES_CAPABILITIES: false,
    REENABLE_RESTORES_BLOCKLIST: false,
    DIRECTORY_HIDE_IS_CRYPTOGRAPHIC_DELETION: false,
    DIRECTORY_HIDE_ERASES_RELAY_HISTORY: false,
  });

  App.AccountDirectoryOps = api;
  window.SosAccountDirectoryOps = api;
})(window);
