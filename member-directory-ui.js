/**
 * AC7 — Verified member directory + management UI (inside Admin Settings).
 * Visibility ≠ authority. All actions via MemberAdminOperations.
 * V2 OFF: hidden.
 */
(function initMemberDirectoryUi(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const MEMBER_DIRECTORY_ENTRY_POINT =
    '#sosAdminSettingsModal → Members tab (Admin Settings / V2 QA)';
  const MEMBER_DIRECTORY_V2_OFF_BEHAVIOR = 'hidden';
  const DIRECTORY_RENDERING_MODEL = 'client_filter + pageSize pagination (default 25)';
  const PAGE_SIZE = 25;

  const MEMBER_COUNT_FIELDS = Object.freeze([
    'active',
    'blocked',
    'removed',
    'conflict',
    'known',
  ]);
  const MEMBER_COUNT_SEMANTICS =
    'active=verified ACTIVE∧∉blockedPubkeys; blocked=tip BLOCKED; removed=tip REMOVED; ' +
    'conflict=tip CONFLICT; known=membership store size; UNKNOWN not counted';

  let filter = 'ALL';
  let searchQ = '';
  let page = 0;
  let selectedPk = '';
  let pendingAction = null;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function Ops() {
    return App.MemberAdminOperations || window.SosMemberAdminOperations || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function AdminUi() {
    return App.AdminSettingsUi || window.SosAdminSettingsUi || null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fp(pk) {
    const s = String(pk || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(s)) return '';
    return s.slice(0, 8) + '…' + s.slice(-8);
  }

  function actorPubkey() {
    return typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
  }

  function ensureMounted() {
    const panel = document.querySelector('#sosAdminSettingsModal .sos-admin-panel');
    if (!panel || document.getElementById('sosMemberDirectorySection')) return;

    const style = document.getElementById('sos-admin-settings-style');
    if (style && style.textContent.indexOf('sos-md-') === -1) {
      style.textContent +=
        '#sosMemberDirectorySection{margin-top:16px;border-top:1px solid rgba(255,255,255,.1);padding-top:12px;}' +
        '#sosMemberDirectorySection .sos-md-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}' +
        '#sosMemberDirectorySection .sos-md-tabs button.active{background:#3d7eff;}' +
        '#sosMemberDirectorySection .sos-md-counts{font-size:.8rem;opacity:.85;margin:6px 0;}' +
        '#sosMemberDirectorySection .sos-md-list{max-height:240px;overflow:auto;border:1px solid rgba(255,255,255,.1);border-radius:8px;}' +
        '#sosMemberDirectorySection .sos-md-row{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;font-size:.82rem;}' +
        '#sosMemberDirectorySection .sos-md-row:hover,#sosMemberDirectorySection .sos-md-row.selected{background:#1b1e27;}' +
        '#sosMemberDirectorySection .sos-md-detail{margin-top:10px;font-size:.82rem;}' +
        '#sosMemberDirectorySection .sos-md-warn{color:#ffb086;}' +
        '#sosMemberDirectorySection .sos-md-danger{color:#ff8f8f;}';
    }

    const sec = document.createElement('div');
    sec.id = 'sosMemberDirectorySection';
    sec.innerHTML =
      '<h3>חברים (Member Directory)</h3>' +
      '<div class="sos-md-counts" id="sosMdCounts"></div>' +
      '<div class="sos-md-tabs" id="sosMdTabs"></div>' +
      '<div class="sos-admin-row"><label for="sosMdSearch">חיפוש (pubkey / שם)</label>' +
      '<input id="sosMdSearch" autocomplete="off" spellcheck="false"></div>' +
      '<div class="sos-md-list" id="sosMdList" role="listbox"></div>' +
      '<div class="sos-admin-actions">' +
      '<button type="button" id="sosMdPrev">הקודם</button>' +
      '<button type="button" id="sosMdNext">הבא</button>' +
      '<button type="button" id="sosMdRefresh">רענון</button></div>' +
      '<div class="sos-md-detail" id="sosMdDetail"></div>' +
      '<div class="sos-admin-status" id="sosMdMsg" role="status"></div>';
    panel.appendChild(sec);

    const tabs = [
      ['ALL', 'הכל'],
      ['ACTIVE', 'ACTIVE'],
      ['BLOCKED', 'BLOCKED'],
      ['REMOVED', 'REMOVED'],
      ['CONFLICT', 'CONFLICT'],
    ];
    const tabHost = sec.querySelector('#sosMdTabs');
    tabs.forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.filter = id;
      b.textContent = label;
      b.addEventListener('click', () => {
        filter = id;
        page = 0;
        render();
      });
      tabHost.appendChild(b);
    });

    sec.querySelector('#sosMdSearch').addEventListener('input', (e) => {
      searchQ = String(e.target.value || '');
      page = 0;
      render();
    });
    sec.querySelector('#sosMdPrev').addEventListener('click', () => {
      if (page > 0) {
        page -= 1;
        render();
      }
    });
    sec.querySelector('#sosMdNext').addEventListener('click', () => {
      page += 1;
      render();
    });
    sec.querySelector('#sosMdRefresh').addEventListener('click', () => {
      selectedPk = '';
      render();
    });
  }

  function setMsg(text, kind) {
    const el = document.getElementById('sosMdMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sos-admin-status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  }

  function filteredRows() {
    const ops = Ops();
    if (!ops) return [];
    let rows = ops.buildDirectoryRows(filter === 'ALL' ? 'ALL' : filter);
    const q = searchQ.trim().toLowerCase().replace(/[<>]/g, '');
    if (q) {
      rows = rows.filter((r) => {
        const name = String(r.displayName || '').toLowerCase();
        return r.memberPubkey.indexOf(q) === 0 || r.memberPubkey.indexOf(q) !== -1 || name.indexOf(q) !== -1;
      });
    }
    // Sort presentation-only: status then pubkey
    rows.sort((a, b) => {
      if (a.status !== b.status) return String(a.status).localeCompare(String(b.status));
      return a.memberPubkey.localeCompare(b.memberPubkey);
    });
    return rows;
  }

  function renderCounts() {
    const el = document.getElementById('sosMdCounts');
    const ms = MS();
    if (!el || !ms) return;
    const c = ms.getMemberCounts();
    el.textContent =
      'active=' +
      c.active +
      ' · blocked=' +
      c.blocked +
      ' · removed=' +
      c.removed +
      ' · conflict=' +
      c.conflict +
      ' · known=' +
      c.known;
  }

  function renderList(rows) {
    const host = document.getElementById('sosMdList');
    if (!host) return;
    const start = page * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    if (start >= rows.length && page > 0) {
      page = Math.max(0, Math.floor((rows.length - 1) / PAGE_SIZE));
      return render();
    }
    host.innerHTML = '';
    if (!slice.length) {
      host.innerHTML = '<div class="sos-md-row">אין רשומות</div>';
      return;
    }
    slice.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'sos-md-row' + (r.memberPubkey === selectedPk ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.dataset.pubkey = r.memberPubkey;
      const name = escapeHtml(r.displayName || '(no name)');
      row.innerHTML =
        '<span><strong>' +
        name +
        '</strong> · <span class="sos-admin-mono">' +
        escapeHtml(fp(r.memberPubkey)) +
        '</span></span>' +
        '<span>' +
        escapeHtml(r.status) +
        (r.consistency && r.consistency !== 'CONSISTENT' && r.consistency !== 'N_A'
          ? ' · <span class="sos-md-warn">' + escapeHtml(r.consistency) + '</span>'
          : '') +
        (r.isRoot ? ' · ROOT' : '') +
        '</span>';
      row.addEventListener('click', () => {
        selectedPk = r.memberPubkey;
        render();
      });
      host.appendChild(row);
    });
  }

  function renderDetail(rows) {
    const host = document.getElementById('sosMdDetail');
    if (!host) return;
    const ops = Ops();
    const row = rows.find((r) => r.memberPubkey === selectedPk);
    if (!row || !ops) {
      host.innerHTML = '<em>בחר חבר מהרשימה</em>';
      return;
    }
    const assigned = (row.assignedCapabilities || []).join(', ') || '—';
    const effective = (row.effectiveCapabilities || []).join(', ') || '—';
    let html =
      '<div class="sos-admin-mono">pubkey: ' +
      escapeHtml(row.memberPubkey) +
      ' <button type="button" id="sosMdCopyPk">העתק</button></div>' +
      '<div>status: <strong>' +
      escapeHtml(row.status) +
      '</strong> · consistency: ' +
      escapeHtml(row.consistency) +
      '</div>' +
      '<div>revision: ' +
      escapeHtml(String(row.memberRevision)) +
      ' · membershipEpoch: ' +
      escapeHtml(String(row.membershipEpoch)) +
      ' · controlEpoch: ' +
      escapeHtml(String(row.controlEpoch)) +
      '</div>' +
      '<div>ASSIGNED: ' +
      escapeHtml(assigned) +
      '</div>' +
      '<div>EFFECTIVE: ' +
      escapeHtml(effective) +
      (row.status === 'REMOVED' && (row.assignedCapabilities || []).length
        ? ' <span class="sos-md-warn">INACTIVE CAPABILITIES — CLEANUP PENDING</span>'
        : '') +
      '</div>';

    if (row.status === 'CONFLICT') {
      html += '<div class="sos-md-danger">MEMBERSHIP CONFLICT</div><ul>';
      (row.conflictCandidates || []).forEach((c) => {
        html +=
          '<li class="sos-admin-mono">' +
          escapeHtml(String(c.eventId || c.id || '')) +
          ' · issuer ' +
          escapeHtml(fp(c.issuerPubkey || c.pubkey || '')) +
          ' · rev ' +
          escapeHtml(String(c.memberRevision || '')) +
          ' · ' +
          escapeHtml(String(c.status || '')) +
          '</li>';
      });
      html += '</ul>';
    }

    html += '<div class="sos-admin-actions" id="sosMdActions"></div>';
    host.innerHTML = html;

    const copyBtn = host.querySelector('#sosMdCopyPk');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(row.memberPubkey);
          setMsg('הועתק pubkey', 'ok');
        } catch (_e) {
          setMsg('copy failed', 'err');
        }
      });
    }

    const actions = host.querySelector('#sosMdActions');
    const ctrl = ops.controlOkForMemberMutation();
    const controlBlocked = !ctrl.ok;

    function addBtn(label, id, disabled, onClick, cls) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.textContent = label;
      if (cls) b.className = cls;
      b.disabled = !!disabled;
      if (!disabled) b.addEventListener('click', onClick);
      actions.appendChild(b);
    }

    if (row.isRoot) {
      // Root protection: no block/remove buttons
    } else if (row.status === 'UNKNOWN') {
      // no management actions
    } else if (row.status === 'CONFLICT') {
      addBtn(
        'Root resolve → ACTIVE',
        'sosMdResolveActive',
        controlBlocked || !isRootActor(),
        () => confirmAndRun('RESOLVE', 'ACTIVE', row),
        'primary'
      );
      addBtn('→ BLOCKED', 'sosMdResolveBlocked', controlBlocked || !isRootActor(), () =>
        confirmAndRun('RESOLVE', 'BLOCKED', row)
      );
      addBtn('→ REMOVED', 'sosMdResolveRemoved', controlBlocked || !isRootActor(), () =>
        confirmAndRun('RESOLVE', 'REMOVED', row)
      );
    } else {
      if (row.status === 'ACTIVE' && row.consistency === 'CONSISTENT') {
        addBtn('BLOCK', 'sosMdBlock', controlBlocked, () => confirmAndRun('BLOCK', null, row), 'primary');
        addBtn('REMOVE', 'sosMdRemove', controlBlocked, () => confirmAndRun('REMOVE', null, row));
        addBtn('יכולות (AC6)', 'sosMdCaps', false, () => handoffCaps(row.memberPubkey));
      }
      if (row.status === 'BLOCKED') {
        addBtn('UNBLOCK', 'sosMdUnblock', controlBlocked, () => confirmAndRun('UNBLOCK', null, row), 'primary');
        addBtn('REMOVE', 'sosMdRemove', controlBlocked, () => confirmAndRun('REMOVE', null, row));
      }
      if (row.consistency === 'PARTIAL_BLOCK') {
        addBtn(
          'Resume Block',
          'sosMdResumeBlock',
          controlBlocked,
          () => confirmAndRun('RESUME_BLOCK', null, row),
          'primary'
        );
        if (row.status === 'ACTIVE') {
          addBtn('Resume Unblock', 'sosMdResumeUnblock', controlBlocked, () =>
            confirmAndRun('RESUME_UNBLOCK', null, row)
          );
        }
        htmlNote(actions, 'PARTIAL BLOCK / UNBLOCK — RECOVERY REQUIRED');
      }
      if (row.consistency === 'PARTIAL_UNBLOCK') {
        addBtn(
          'Resume Unblock',
          'sosMdResumeUnblock2',
          controlBlocked,
          () => confirmAndRun('RESUME_UNBLOCK', null, row),
          'primary'
        );
        htmlNote(actions, 'PARTIAL UNBLOCK — RECOVERY REQUIRED');
      }
      if (row.status === 'REMOVED' && (row.assignedCapabilities || []).length) {
        addBtn('Cleanup caps', 'sosMdCleanup', controlBlocked, () => confirmAndRun('CLEANUP', null, row));
      }
    }
  }

  function htmlNote(parent, text) {
    const d = document.createElement('div');
    d.className = 'sos-md-warn';
    d.textContent = text;
    parent.appendChild(d);
  }

  function isRootActor() {
    const g = GCS();
    const live = g && g.getVerifiedControlState();
    const ops = Ops();
    if (!live || !ops) return false;
    return ops.normalizePubkey(actorPubkey()) === ops.normalizePubkey(live.rootAdminPubkey);
  }

  function handoffCaps(pk) {
    const input = document.getElementById('sosAdminTargetPk');
    if (input) {
      input.value = pk;
      input.dispatchEvent(new Event('input'));
    }
    setMsg('יעד יכולות עודכן — השתמש במנוע AC6 למעלה', 'ok');
    try {
      input && input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_e) {}
  }

  function confirmAndRun(action, resolveStatus, row) {
    const expected = Ops().snapshotTarget(row.memberPubkey);
    const body =
      'action: ' +
      action +
      (resolveStatus ? ' → ' + resolveStatus : '') +
      '\nname: ' +
      (row.displayName || '') +
      '\npubkey: ' +
      row.memberPubkey +
      '\nstatus: ' +
      row.status +
      '\nmemberRevision: ' +
      row.memberRevision +
      '\ncontrolEpoch: ' +
      row.controlEpoch +
      (action === 'REMOVE'
        ? '\n\nNOTE: identity and historical content are NOT deleted.'
        : '');

    pendingAction = { action, resolveStatus, row, expected };
    // Reuse AC6 confirm overlay if present
    const overlay = document.getElementById('sosAdminConfirmOverlay');
    const confirmBody = document.getElementById('sosAdminConfirmBody');
    if (overlay && confirmBody) {
      confirmBody.textContent = body;
      overlay.classList.add('is-open');
      const ok = document.getElementById('sosAdminConfirmOk');
      const cancel = document.getElementById('sosAdminConfirmCancel');
      const onOk = async () => {
        cleanup();
        await runPending();
      };
      const onCancel = () => {
        cleanup();
        pendingAction = null;
      };
      function cleanup() {
        overlay.classList.remove('is-open');
        ok && ok.removeEventListener('click', onOk);
        cancel && cancel.removeEventListener('click', onCancel);
      }
      ok && ok.addEventListener('click', onOk);
      cancel && cancel.addEventListener('click', onCancel);
    } else if (window.confirm(body)) {
      runPending();
    }
  }

  async function runPending() {
    const p = pendingAction;
    pendingAction = null;
    if (!p) return;
    const ops = Ops();
    const actor = actorPubkey();
    const opts = { expected: p.expected, skipPublish: false };
    let res;
    try {
      if (p.action === 'BLOCK') res = await ops.blockMember(p.row.memberPubkey, actor, opts);
      else if (p.action === 'RESUME_BLOCK') res = await ops.resumeBlock(p.row.memberPubkey, actor, opts);
      else if (p.action === 'UNBLOCK') res = await ops.unblockMember(p.row.memberPubkey, actor, opts);
      else if (p.action === 'RESUME_UNBLOCK') res = await ops.resumeUnblock(p.row.memberPubkey, actor, opts);
      else if (p.action === 'REMOVE') res = await ops.removeMember(p.row.memberPubkey, actor, opts);
      else if (p.action === 'RESOLVE')
        res = await ops.resolveMembershipConflict(p.row.memberPubkey, p.resolveStatus, actor, {
          expected: p.expected,
          expectedCandidateIds: (p.row.conflictCandidates || []).map((c) => c.eventId || c.id),
          skipPublish: false,
        });
      else if (p.action === 'CLEANUP') {
        const mut = App.GroupControlMutations;
        res = await mut.applyControlMutation(
          { type: 'CLEAR_MEMBER_CAPABILITIES', targetPubkey: p.row.memberPubkey },
          actor,
          {}
        );
      } else res = { ok: false, code: 'UNKNOWN_ACTION' };
    } catch (e) {
      res = { ok: false, code: e && e.code ? e.code : 'ERROR', error: e && e.message };
    }
    if (res && res.ok) setMsg(res.code || 'OK', 'ok');
    else setMsg((res && (res.code || res.error)) || 'failed', 'err');
    render();
  }

  function render() {
    if (!isV2()) return;
    ensureMounted();
    const sec = document.getElementById('sosMemberDirectorySection');
    if (!sec) return;
    const ops = Ops();
    if (!ops || !ops.canViewDirectory(actorPubkey())) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    document.querySelectorAll('#sosMdTabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    renderCounts();
    const rows = filteredRows();
    renderList(rows);
    renderDetail(rows);
  }

  function onAdminOpen() {
    if (!isV2()) return;
    ensureMounted();
    render();
  }

  // Hook Admin Settings open
  function boot() {
    if (!isV2()) return;
    // Do not mutate frozen AdminSettingsUi API — observe modal open instead.
    try {
      const ui = AdminUi();
      if (ui) {
        // flags are frozen; directory module exposes its own MEMBER_DIRECTORY_UI_IMPLEMENTED
      }
    } catch (_e) {}
    const mo = new MutationObserver(() => {
      const modal = document.getElementById('sosAdminSettingsModal');
      if (modal && modal.classList.contains('is-open')) onAdminOpen();
    });
    if (document.body) {
      mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  const api = {
    MEMBER_DIRECTORY_ENTRY_POINT,
    MEMBER_DIRECTORY_V2_OFF_BEHAVIOR,
    DIRECTORY_RENDERING_MODEL,
    MEMBER_COUNT_FIELDS,
    MEMBER_COUNT_SEMANTICS,
    MEMBER_DIRECTORY_VISIBILITY_IS_AUTHORITY: false,
    MEMBER_DIRECTORY_SECRET_EXPOSURE: false,
    MEMBER_ACTION_AUTHORITY_SOURCE: 'pubkey',
    DIRECTORY_UNBOUNDED_DOM_RENDER: false,
    MEMBER_CAPABILITY_UI_REUSES_AC6: true,
    MEMBER_DIRECTORY_UI_IMPLEMENTED: true,
    BLOCK_REMOVE_ADMIN_UI_IMPLEMENTED: true,
    render,
    escapeHtml,
  };

  Object.freeze(api);
  App.MemberDirectoryUi = api;
  window.SosMemberDirectoryUi = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
