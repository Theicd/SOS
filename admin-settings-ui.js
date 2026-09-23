/**
 * AC6 — Admin settings / permissions UI foundation.
 * Visibility is NOT authority. Mutations go through GroupControlMutations + SIGN_GROUP_CONTROL.
 * V2 OFF: hidden (no production mutations). No member directory / block-remove UI (AC7).
 */
(function initAdminSettingsUi(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const ADMIN_UI_ENTRY_POINT = '#moreOptionsToggle → Admin Settings (V2 QA)';
  const ADMIN_UI_V2_OFF_BEHAVIOR = 'hidden';
  const ROOT_ADMIN_DISPLAY_AUTHORITY_SOURCE = 'pubkey';
  const MANAGE_ADMINS_SEMANTICS =
    'AC1/AC2: MANAGE_ADMINS shares GRANT/REVOKE_ADMIN_CAPABILITY with MANAGE_PERMISSIONS; ' +
    'both may only grant/revoke DELEGABLE_BY_PERMISSION_MANAGER (not ROOT/MANAGE_ADMINS/MANAGE_PERMISSIONS). ' +
    'Treated equivalently for capability map mutations in current model.';
  const MANAGE_PERMISSIONS_SEMANTICS = MANAGE_ADMINS_SEMANTICS;
  const CAPABILITY_GRANT_TARGET_POLICY =
    'Target must be valid 64-hex pubkey, not root; membership status must not be BLOCKED/REMOVED/CONFLICT; ACTIVE preferred.';

  const VISIBILITY_CAPS = Object.freeze([
    'ROOT_ADMIN',
    'MANAGE_ADMINS',
    'MANAGE_PERMISSIONS',
    'MANAGE_GROUP_SETTINGS',
    'MANAGE_INVITES',
    'MANAGE_MEMBERS',
    'MANAGE_BLOCKLIST',
    'VIEW_AUDIT_LOG',
  ]);

  let modalEl = null;
  let formBase = null; // { eventId, controlEpoch } snapshot when form opened
  let pendingHighRisk = null;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }

  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function AC() {
    return App.AccessControl || window.SosAccessControl || null;
  }
  function MUT() {
    return App.GroupControlMutations || window.SosGroupControlMutations || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }

  function fp(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) return '';
    return pk.slice(0, 8) + '…' + pk.slice(-8);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function actorPubkey() {
    return typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
  }

  function canSeeAdminEntry() {
    if (!isV2()) return false;
    if (App.guestMode) return false;
    const pk = actorPubkey();
    if (!pk) return false;
    const ac = AC();
    if (!ac || typeof ac.hasCapability !== 'function') return false;
    for (let i = 0; i < VISIBILITY_CAPS.length; i++) {
      if (ac.hasCapability(pk, VISIBILITY_CAPS[i])) return true;
    }
    return false;
  }

  function ensureStyles() {
    if (document.getElementById('sos-admin-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'sos-admin-settings-style';
    style.textContent =
      '#sosAdminSettingsModal{position:fixed;inset:0;z-index:12000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}' +
      '#sosAdminSettingsModal.is-open{display:flex;}' +
      '#sosAdminSettingsModal .sos-admin-panel{width:min(560px,94vw);max-height:88vh;overflow:auto;background:#12141a;color:#f2f2f2;border-radius:14px;padding:16px 18px 20px;border:1px solid rgba(255,255,255,.12);font-family:inherit;}' +
      '#sosAdminSettingsModal h2{margin:0 0 8px;font-size:1.15rem;}' +
      '#sosAdminSettingsModal h3{margin:16px 0 8px;font-size:.95rem;opacity:.9;}' +
      '#sosAdminSettingsModal .sos-admin-row{display:flex;flex-direction:column;gap:6px;margin:8px 0;}' +
      '#sosAdminSettingsModal label{font-size:.8rem;opacity:.75;}' +
      '#sosAdminSettingsModal input,#sosAdminSettingsModal select{background:#1b1e27;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px 10px;}' +
      '#sosAdminSettingsModal .sos-admin-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}' +
      '#sosAdminSettingsModal button{border:0;border-radius:8px;padding:8px 12px;cursor:pointer;background:#2a3142;color:#fff;}' +
      '#sosAdminSettingsModal button.primary{background:#3d7eff;}' +
      '#sosAdminSettingsModal button:disabled{opacity:.45;cursor:not-allowed;}' +
      '#sosAdminSettingsModal .sos-admin-status{font-size:.85rem;margin-top:10px;min-height:1.2em;}' +
      '#sosAdminSettingsModal .sos-admin-status.err{color:#ff8f8f;}' +
      '#sosAdminSettingsModal .sos-admin-status.ok{color:#8dffb0;}' +
      '#sosAdminSettingsModal .sos-admin-mono{font-family:ui-monospace,monospace;font-size:.8rem;word-break:break-all;}' +
      '#sosAdminSettingsModal .sos-admin-badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#333;font-size:.75rem;margin-inline-start:6px;}' +
      '#sosAdminSettingsModal .sos-admin-badge.conflict{background:#7a2e2e;}' +
      '#sosAdminSettingsEntry{display:none;}' +
      '#sosAdminConfirmOverlay{position:fixed;inset:0;z-index:12001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.65);}' +
      '#sosAdminConfirmOverlay.is-open{display:flex;}' +
      '#sosAdminConfirmOverlay .sos-admin-confirm{width:min(420px,92vw);background:#1a1d26;color:#fff;border-radius:12px;padding:16px;border:1px solid rgba(255,255,255,.14);}';
    document.head.appendChild(style);
  }

  function ensureDom() {
    if (modalEl) return;
    ensureStyles();
    modalEl = document.createElement('div');
    modalEl.id = 'sosAdminSettingsModal';
    modalEl.setAttribute('aria-hidden', 'true');
    modalEl.innerHTML =
      '<div class="sos-admin-panel" role="dialog" aria-modal="true" aria-labelledby="sosAdminTitle">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
      '<h2 id="sosAdminTitle">הגדרות קבוצה / הרשאות</h2>' +
      '<button type="button" id="sosAdminCloseBtn" aria-label="סגור">סגור</button></div>' +
      '<div id="sosAdminStatusPanel"></div>' +
      '<div id="sosAdminConflictPanel" hidden></div>' +
      '<h3>שם תצוגה</h3>' +
      '<div class="sos-admin-row"><label for="sosAdminDisplayName">displayName</label>' +
      '<input id="sosAdminDisplayName" maxlength="80" autocomplete="off"></div>' +
      '<div class="sos-admin-actions"><button type="button" class="primary" id="sosAdminSaveName">שמור שם</button></div>' +
      '<h3>מדיניות הזמנות</h3>' +
      '<div class="sos-admin-row"><label for="sosAdminInvitePolicy">invitePolicy</label>' +
      '<select id="sosAdminInvitePolicy">' +
      '<option value="EVERYONE">EVERYONE</option>' +
      '<option value="AUTHORIZED_USERS_ONLY">AUTHORIZED_USERS_ONLY</option>' +
      '<option value="ADMINS_ONLY">ADMINS_ONLY</option></select></div>' +
      '<div class="sos-admin-actions"><button type="button" class="primary" id="sosAdminSavePolicy">שמור מדיניות</button></div>' +
      '<h3>יכולות (לפי pubkey)</h3>' +
      '<div id="sosAdminCapList" class="sos-admin-mono"></div>' +
      '<div class="sos-admin-row"><label for="sosAdminTargetPk">target pubkey</label>' +
      '<input id="sosAdminTargetPk" spellcheck="false" autocomplete="off" placeholder="64-hex"></div>' +
      '<div class="sos-admin-row"><label for="sosAdminCapSelect">capability</label>' +
      '<select id="sosAdminCapSelect"></select></div>' +
      '<div class="sos-admin-row"><label>member status</label><div id="sosAdminTargetStatus" class="sos-admin-mono">—</div></div>' +
      '<div class="sos-admin-actions">' +
      '<button type="button" class="primary" id="sosAdminGrantCap">הענק יכולת</button>' +
      '<button type="button" id="sosAdminRevokeCap">בטל יכולת</button></div>' +
      '<div class="sos-admin-status" id="sosAdminMsg" role="status"></div>' +
      '</div>';
    document.body.appendChild(modalEl);

    const confirm = document.createElement('div');
    confirm.id = 'sosAdminConfirmOverlay';
    confirm.innerHTML =
      '<div class="sos-admin-confirm" role="alertdialog" aria-modal="true">' +
      '<h3 style="margin-top:0;">אישור פעולה</h3>' +
      '<div id="sosAdminConfirmBody" class="sos-admin-mono"></div>' +
      '<div class="sos-admin-actions" style="margin-top:12px;">' +
      '<button type="button" class="primary" id="sosAdminConfirmOk">אשר</button>' +
      '<button type="button" id="sosAdminConfirmCancel">בטל</button></div></div>';
    document.body.appendChild(confirm);

    modalEl.querySelector('#sosAdminCloseBtn').addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });
    modalEl.querySelector('#sosAdminSaveName').addEventListener('click', onSaveName);
    modalEl.querySelector('#sosAdminSavePolicy').addEventListener('click', onSavePolicy);
    modalEl.querySelector('#sosAdminGrantCap').addEventListener('click', () => onCap('GRANT'));
    modalEl.querySelector('#sosAdminRevokeCap').addEventListener('click', () => onCap('REVOKE'));
    modalEl.querySelector('#sosAdminTargetPk').addEventListener('input', refreshTargetStatus);
    confirm.querySelector('#sosAdminConfirmCancel').addEventListener('click', () => hideConfirm(false));
    confirm.querySelector('#sosAdminConfirmOk').addEventListener('click', () => hideConfirm(true));
  }

  function setMsg(text, kind) {
    const el = document.getElementById('sosAdminMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sos-admin-status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  }

  function refreshTargetStatus() {
    const mut = MUT();
    const input = document.getElementById('sosAdminTargetPk');
    const out = document.getElementById('sosAdminTargetStatus');
    if (!input || !out) return;
    const pk = mut ? mut.normalizePubkey(input.value) : '';
    if (!pk) {
      out.textContent = 'INVALID';
      return;
    }
    const st = mut ? mut.memberStatus(pk) : 'UNKNOWN';
    out.textContent = st + ' · ' + fp(pk);
  }

  function fillCapSelect() {
    const gcs = GCS();
    const sel = document.getElementById('sosAdminCapSelect');
    if (!sel || !gcs) return;
    sel.innerHTML = '';
    (gcs.MAP_CAPABILITIES || []).forEach((c) => {
      // ROOT_ADMIN never rendered as grantable
      if (c === 'ROOT_ADMIN') return;
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  }

  function snapshotBase() {
    const gcs = GCS();
    const st = gcs && gcs.getVerifiedControlState && gcs.getVerifiedControlState();
    if (!st) {
      formBase = null;
      return null;
    }
    formBase = { eventId: st.eventId, controlEpoch: st.controlEpoch };
    return st;
  }

  function renderStatus() {
    const gcs = GCS();
    const panel = document.getElementById('sosAdminStatusPanel');
    const conflictPanel = document.getElementById('sosAdminConflictPanel');
    if (!panel || !gcs) return;
    const status = gcs.getStatus();
    const st = gcs.getVerifiedControlState && gcs.getVerifiedControlState();
    const badgeClass = status === 'CONTROL_CONFLICT' || status === 'CONFLICT' ? ' conflict' : '';
    const displayName = st ? escapeHtml(st.groupSettings.displayName) : '—';
    const epoch = st ? st.controlEpoch : '—';
    const memEpoch = st ? st.membershipEpoch : '—';
    const policy = st ? escapeHtml(st.invitePolicy) : '—';
    const root = st ? escapeHtml(fp(st.rootAdminPubkey)) : '—';
    const groupId = st ? escapeHtml(st.groupId) : escapeHtml(gcs.resolveGroupId());
    panel.innerHTML =
      '<div>status <span class="sos-admin-badge' +
      badgeClass +
      '">' +
      escapeHtml(status) +
      '</span></div>' +
      '<div class="sos-admin-mono">groupId: ' +
      groupId +
      '</div>' +
      '<div>displayName: <span id="sosAdminLiveDisplayName">' +
      displayName +
      '</span></div>' +
      '<div>controlEpoch: <strong id="sosAdminLiveEpoch">' +
      escapeHtml(String(epoch)) +
      '</strong> · membershipEpoch: ' +
      escapeHtml(String(memEpoch)) +
      '</div>' +
      '<div>invitePolicy: ' +
      policy +
      '</div>' +
      '<div>root: <span class="sos-admin-mono">' +
      root +
      '</span></div>';

    const conflicted = status === 'CONTROL_CONFLICT' || status === 'CONFLICT';
    if (conflictPanel) {
      if (conflicted) {
        conflictPanel.hidden = false;
        const cands = gcs.getConflictCandidates ? gcs.getConflictCandidates() : [];
        conflictPanel.innerHTML =
          '<h3>CONTROL_CONFLICT</h3><p>פעולות מואצלות חסומות. רק ROOT יכול לפתור.</p>' +
          '<div class="sos-admin-mono">' +
          cands
            .map((c) => escapeHtml(c.eventId) + ' · ' + escapeHtml(fp(c.issuerPubkey)))
            .join('<br>') +
          '</div>' +
          '<div class="sos-admin-actions"><button type="button" class="primary" id="sosAdminResolveConflict">פתרון ROOT</button></div>';
        const btn = conflictPanel.querySelector('#sosAdminResolveConflict');
        if (btn) btn.addEventListener('click', onResolveConflict);
      } else {
        conflictPanel.hidden = true;
        conflictPanel.innerHTML = '';
      }
    }

    // Disable delegated mutation buttons while conflicted
    ['sosAdminSaveName', 'sosAdminSavePolicy', 'sosAdminGrantCap', 'sosAdminRevokeCap'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = conflicted;
    });

    if (st) {
      const nameInput = document.getElementById('sosAdminDisplayName');
      const pol = document.getElementById('sosAdminInvitePolicy');
      if (nameInput && document.activeElement !== nameInput) nameInput.value = st.groupSettings.displayName || '';
      if (pol) pol.value = st.invitePolicy || 'EVERYONE';
      const list = document.getElementById('sosAdminCapList');
      if (list) {
        const lines = Object.keys(st.capabilities || {})
          .sort()
          .map((pk) => fp(pk) + ' → ' + (st.capabilities[pk] || []).join(', '));
        list.textContent = lines.length ? lines.join('\n') : '(אין יכולות מואצלות)';
      }
    }
  }

  function showConfirm(summaryText) {
    return new Promise((resolve) => {
      pendingHighRisk = resolve;
      const overlay = document.getElementById('sosAdminConfirmOverlay');
      const body = document.getElementById('sosAdminConfirmBody');
      if (body) body.textContent = summaryText;
      if (overlay) {
        overlay.classList.add('is-open');
      }
    });
  }

  function hideConfirm(ok) {
    const overlay = document.getElementById('sosAdminConfirmOverlay');
    if (overlay) overlay.classList.remove('is-open');
    const fn = pendingHighRisk;
    pendingHighRisk = null;
    if (typeof fn === 'function') fn(!!ok);
  }

  async function runMutation(mutation, confirmText) {
    const mut = MUT();
    if (!mut) {
      setMsg('mutations module missing', 'err');
      return;
    }
    if (confirmText) {
      const ok = await showConfirm(confirmText);
      if (!ok) {
        setMsg('בוטל', '');
        return;
      }
    }
    // Fresh base check — no auto-rebase
    const live = GCS().getVerifiedControlState();
    if (mutation.type !== 'RESOLVE_CONTROL_CONFLICT') {
      if (!formBase || !live || live.eventId !== formBase.eventId) {
        setMsg('המצב השתנה — רענון נדרש (STALE). לא נחתם.', 'err');
        renderStatus();
        snapshotBase();
        return;
      }
    }
    setMsg('שולח...', '');
    const result = await mut.applyControlMutation(mutation, actorPubkey(), {
      baseState: formBase ? { eventId: formBase.eventId, controlEpoch: formBase.controlEpoch, verified: true } : null,
    });
    if (!result.ok) {
      setMsg('נכשל: ' + (result.code || 'ERROR'), 'err');
      renderStatus();
      snapshotBase();
      return;
    }
    setMsg('עודכן · epoch ' + (result.accept && result.accept.record && result.accept.record.controlEpoch), 'ok');
    snapshotBase();
    renderStatus();
  }

  function onSaveName() {
    const name = document.getElementById('sosAdminDisplayName').value;
    runMutation({ type: 'SET_GROUP_DISPLAY_NAME', displayName: name });
  }

  function onSavePolicy() {
    const invitePolicy = document.getElementById('sosAdminInvitePolicy').value;
    runMutation({ type: 'SET_INVITE_POLICY', invitePolicy });
  }

  function onCap(kind) {
    const targetPubkey = document.getElementById('sosAdminTargetPk').value;
    const capability = document.getElementById('sosAdminCapSelect').value;
    const live = GCS().getVerifiedControlState();
    const nextEpoch = live ? live.controlEpoch + 1 : '?';
    const summary =
      (kind === 'GRANT' ? 'GRANT' : 'REVOKE') +
      ' ' +
      capability +
      '\ntarget: ' +
      targetPubkey.trim().toLowerCase() +
      '\ncurrentEpoch: ' +
      (live ? live.controlEpoch : '?') +
      '\nnextEpoch: ' +
      nextEpoch;
    runMutation(
      {
        type: kind === 'GRANT' ? 'GRANT_CAPABILITY' : 'REVOKE_CAPABILITY',
        targetPubkey,
        capability,
      },
      summary
    );
  }

  function onResolveConflict() {
    const live = GCS().getVerifiedControlState();
    const summary =
      'ROOT RESOLVE_CONTROL_CONFLICT\nbaseEpoch: ' +
      (live ? live.controlEpoch : '?') +
      '\nresolveEpoch: ' +
      (live ? live.controlEpoch + 2 : '?');
    runMutation(
      {
        type: 'RESOLVE_CONTROL_CONFLICT',
        canonical: live
          ? {
              displayName: live.groupSettings.displayName,
              invitePolicy: live.invitePolicy,
              capabilities: live.capabilities,
            }
          : {},
      },
      summary
    );
  }

  function open() {
    if (!isV2()) return;
    if (!canSeeAdminEntry()) {
      console.warn('Admin settings: no visibility capability');
      return;
    }
    ensureDom();
    fillCapSelect();
    snapshotBase();
    renderStatus();
    refreshTargetStatus();
    modalEl.classList.add('is-open');
    modalEl.setAttribute('aria-hidden', 'false');
    setMsg('', '');
  }

  function close() {
    if (!modalEl) return;
    modalEl.classList.remove('is-open');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  function ensureEntryButton() {
    if (!isV2() || !canSeeAdminEntry()) {
      const existing = document.getElementById('sosAdminSettingsEntry');
      if (existing) existing.style.display = 'none';
      return;
    }
    ensureStyles();
    let btn = document.getElementById('sosAdminSettingsEntry');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'sosAdminSettingsEntry';
      btn.type = 'button';
      btn.textContent = 'הגדרות קבוצה';
      btn.style.cssText =
        'position:fixed;bottom:88px;inset-inline-end:12px;z-index:9000;padding:10px 12px;border-radius:999px;border:0;background:#2a3142;color:#fff;cursor:pointer;';
      btn.addEventListener('click', open);
      document.body.appendChild(btn);
    }
    btn.style.display = 'inline-flex';
  }

  function boot() {
    // V2-off: no functional admin UI
    if (!isV2()) return;
    ensureEntryButton();
    // Re-check on identity changes
    window.addEventListener('sos-identity-ready', ensureEntryButton);
    setTimeout(ensureEntryButton, 1500);
  }

  const api = {
    ADMIN_UI_ENTRY_POINT,
    ADMIN_UI_V2_OFF_BEHAVIOR,
    ROOT_ADMIN_DISPLAY_AUTHORITY_SOURCE,
    MANAGE_ADMINS_SEMANTICS,
    MANAGE_PERMISSIONS_SEMANTICS,
    CAPABILITY_GRANT_TARGET_POLICY,
    ADMIN_UI_VISIBILITY_IS_AUTHORITY: false,
    MEMBER_DIRECTORY_UI_IMPLEMENTED: false,
    BLOCK_REMOVE_ADMIN_UI_IMPLEMENTED: false,
    open,
    close,
    canSeeAdminEntry,
    ensureEntryButton,
    /** Test helper: render display name safely */
    escapeHtml,
  };

  Object.freeze(api);
  App.AdminSettingsUi = api;
  window.SosAdminSettingsUi = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
