/**
 * Group Admin Product UI — Hebrew management shell on top of AC1–AC10.
 * Visibility ≠ authority. Mutations use existing GroupControl* / MemberAdmin* APIs.
 * Requires SOS_ACCESS_CONTROL_V2 (local test mode only in this phase).
 */
(function initGroupAdminProductUi(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const TABS = Object.freeze([
    { id: 'home', label: 'ניהול קבוצה' },
    { id: 'details', label: 'פרטי הקבוצה' },
    { id: 'members', label: 'חברים' },
    { id: 'admins', label: 'מנהלים' },
    { id: 'roles', label: 'תפקידים והרשאות' },
    { id: 'invites', label: 'הזמנות' },
    { id: 'qr', label: 'קוד QR' },
    { id: 'settings', label: 'הגדרות' },
    { id: 'create', label: 'יצירת קבוצה' },
  ]);

  let shellEl = null;
  let activeTab = 'home';

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function AC() {
    return App.AccessControl || window.SosAccessControl || null;
  }
  function AdminUi() {
    return App.AdminSettingsUi || window.SosAdminSettingsUi || null;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function CC() {
    return App.CommunityContext || window.SosCommunityContext || null;
  }
  function actor() {
    return typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function canSeeGroupAdminMenu() {
    if (!isV2()) return false;
    if (App.guestMode) return false;
    const pk = actor();
    if (!pk) return false;
    const admin = AdminUi();
    if (admin && typeof admin.canSeeAdminEntry === 'function') {
      return admin.canSeeAdminEntry() === true;
    }
    const ac = AC();
    if (!ac || typeof ac.hasCapability !== 'function') return false;
    const caps = [
      'ROOT_ADMIN',
      'MANAGE_ADMINS',
      'MANAGE_PERMISSIONS',
      'MANAGE_GROUP_SETTINGS',
      'MANAGE_INVITES',
      'MANAGE_MEMBERS',
      'MANAGE_BLOCKLIST',
      'VIEW_AUDIT_LOG',
      'MODERATE_CONTENT',
      'INVITE_USERS',
    ];
    return caps.some((c) => ac.hasCapability(pk, c) === true);
  }

  function isActiveMember() {
    const ms = MS();
    const pk = actor();
    if (!pk || !ms) return false;
    if (typeof ms.isActiveMember === 'function') return ms.isActiveMember(pk) === true;
    if (typeof ms.membershipAccessAllowed === 'function') return ms.membershipAccessAllowed(pk) === true;
    return false;
  }

  function ensureStyles() {
    if (document.getElementById('sos-group-admin-product-style')) return;
    const style = document.createElement('style');
    style.id = 'sos-group-admin-product-style';
    style.textContent =
      '#sosGroupAdminShell{position:fixed;inset:0;z-index:12100;display:none;align-items:stretch;justify-content:center;background:rgba(0,0,0,.55);}' +
      '#sosGroupAdminShell.is-open{display:flex;}' +
      '#sosGroupAdminShell .gap-panel{width:min(720px,96vw);max-height:92vh;margin:auto;background:#12141a;color:#f2f2f2;border-radius:14px;border:1px solid rgba(255,255,255,.12);display:flex;flex-direction:column;overflow:hidden;}' +
      '#sosGroupAdminShell .gap-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '#sosGroupAdminShell .gap-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '#sosGroupAdminShell .gap-tabs button{border:0;border-radius:999px;padding:7px 12px;background:#222836;color:#fff;cursor:pointer;font-size:.85rem;}' +
      '#sosGroupAdminShell .gap-tabs button.active{background:#3d7eff;}' +
      '#sosGroupAdminShell .gap-body{padding:14px 16px 18px;overflow:auto;flex:1;}' +
      '#sosGroupAdminShell .gap-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}' +
      '#sosGroupAdminShell button.gap-btn{border:0;border-radius:8px;padding:8px 12px;background:#2a3142;color:#fff;cursor:pointer;}' +
      '#sosGroupAdminShell button.gap-btn.primary{background:#3d7eff;}' +
      '#sosGroupAdminShell .gap-row{display:flex;flex-direction:column;gap:6px;margin:8px 0;}' +
      '#sosGroupAdminShell input,textarea,select{background:#1b1e27;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px 10px;}' +
      '#sosGroupAdminShell .gap-msg{min-height:1.2em;margin-top:10px;font-size:.85rem;}' +
      '#sosGroupAdminShell .gap-msg.err{color:#ff8f8f;}' +
      '#sosGroupAdminShell .gap-msg.ok{color:#8dffb0;}' +
      '#sosGroupAdminMenuEntry{display:none;}' +
      '#sosGroupAdminMenuEntry.is-visible{display:block;}';
    document.head.appendChild(style);
  }

  function setMsg(text, cls) {
    const el = document.getElementById('sosGapMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gap-msg' + (cls ? ' ' + cls : '');
  }

  function controlSummary() {
    const g = GCS();
    const st = g && typeof g.getVerifiedControlState === 'function' ? g.getVerifiedControlState() : null;
    const settings = g && typeof g.getGroupSettings === 'function' ? g.getGroupSettings() : null;
    const cc = CC() && CC().snapshot ? CC().snapshot() : null;
    return {
      status: g && g.getStatus ? g.getStatus() : 'NONE',
      displayName: (settings && settings.displayName) || (cc && cc.name) || '',
      groupId: (settings && settings.groupId) || (cc && cc.networkTag) || App.NETWORK_TAG || '',
      root: st && st.rootAdminPubkey ? st.rootAdminPubkey : '',
      epoch: st && st.controlEpoch != null ? st.controlEpoch : null,
      invitePolicy: st && st.invitePolicy ? st.invitePolicy : '',
    };
  }

  function renderTab(tabId) {
    activeTab = tabId;
    const body = document.getElementById('sosGapBody');
    const tabs = document.getElementById('sosGapTabs');
    if (tabs) {
      Array.from(tabs.querySelectorAll('button')).forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tabId);
      });
    }
    if (!body) return;
    const sum = controlSummary();
    if (tabId === 'home') {
      body.innerHTML =
        '<p>ברוכים הבאים לניהול הקבוצה. בחרו קטגוריה מהתפריט.</p>' +
        '<p><strong>' +
        escapeHtml(sum.displayName || sum.groupId) +
        '</strong></p>' +
        '<p class="gap-mono">מזהה: ' +
        escapeHtml(sum.groupId) +
        '</p>' +
        '<div class="gap-actions">' +
        '<button type="button" class="gap-btn primary" data-open-legacy>פתיחת מסך הרשאות מלא</button>' +
        '<button type="button" class="gap-btn" data-tab-jump="create">יצירת קבוצה</button></div>';
    } else if (tabId === 'details') {
      body.innerHTML =
        '<div class="gap-row"><label>שם הקבוצה</label><div>' +
        escapeHtml(sum.displayName || '—') +
        '</div></div>' +
        '<div class="gap-row"><label>מזהה רשת</label><div>' +
        escapeHtml(sum.groupId) +
        '</div></div>' +
        '<div class="gap-row"><label>מנהל ראשי</label><div>' +
        escapeHtml(sum.root ? sum.root.slice(0, 12) + '…' : '—') +
        '</div></div>' +
        '<div class="gap-row"><label>מצב בקרה</label><div>' +
        escapeHtml(String(sum.status)) +
        '</div></div>';
    } else if (tabId === 'members') {
      body.innerHTML =
        '<p>חברי הקבוצה מנוהלים דרך מדריך החברים המאומת.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-open-legacy>פתח חברים</button></div>';
    } else if (tabId === 'admins') {
      body.innerHTML =
        '<p>מנהלים מוגדרים לפי יכולות MANAGE_ADMINS / ROOT_ADMIN במצב הבקרה החתום.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-open-legacy>ניהול מנהלים והרשאות</button></div>';
    } else if (tabId === 'roles') {
      body.innerHTML =
        '<p>תפקידים במוצר ממופים ליכולות קנוניות (לא שמות מקבילים):</p>' +
        '<ul><li>מנהל ראשי → ROOT_ADMIN</li><li>מנהל → MANAGE_ADMINS / MANAGE_PERMISSIONS / MANAGE_MEMBERS</li>' +
        '<li>מפקח תוכן → MODERATE_CONTENT</li><li>חבר → membership ACTIVE</li></ul>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-open-legacy>הענקת / ביטול יכולת</button></div>';
    } else if (tabId === 'invites') {
      body.innerHTML =
        '<p>יצירת הזמנה, העתקה, ומצב פעיל/פג תוקף לפי שירות ההזמנות הקיים.</p>' +
        '<div class="gap-actions">' +
        '<button type="button" class="gap-btn primary" id="sosGapCreateInvite">יצירת הזמנה</button>' +
        '<button type="button" class="gap-btn" data-tab-jump="qr">קוד QR</button></div>' +
        '<div id="sosGapInviteOut" class="gap-row"></div>';
    } else if (tabId === 'qr') {
      body.innerHTML =
        '<p>הצגת QR להזמנה (ללא מפתחות פרטיים).</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" id="sosGapShowQr">הצג QR להזמנה אחרונה</button></div>';
    } else if (tabId === 'settings') {
      body.innerHTML =
        '<p>הגדרות קבוצה (שם תצוגה, מדיניות הזמנות) דרך ממשק ההרשאות.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-open-legacy>פתח הגדרות</button></div>';
    } else if (tabId === 'create') {
      body.innerHTML =
        '<p>יצירת קבוצה/קהילה חדשה. היוצר הופך למנהל הסמכותי הראשוני.</p>' +
        '<div class="gap-row"><label for="sosGapName">שם הקבוצה</label><input id="sosGapName" maxlength="80"></div>' +
        '<div class="gap-row"><label for="sosGapDesc">תיאור</label><textarea id="sosGapDesc" rows="2" maxlength="240"></textarea></div>' +
        '<div class="gap-row"><label for="sosGapSlug">מזהה (slug)</label><input id="sosGapSlug" maxlength="48" placeholder="my-group"></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" id="sosGapCreateBtn">יצירת קבוצה</button></div>';
    }
    setMsg('', '');
  }

  async function createGroupFromForm() {
    const name = (document.getElementById('sosGapName') || {}).value || '';
    const desc = (document.getElementById('sosGapDesc') || {}).value || '';
    let slug = String((document.getElementById('sosGapSlug') || {}).value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    if (!name.trim()) {
      setMsg('נא להזין שם קבוצה', 'err');
      return { ok: false, code: 'NAME_REQUIRED' };
    }
    if (!slug) slug = 'g-' + Date.now().toString(36);
    const pk = actor();
    if (!pk) {
      setMsg('נדרשת זהות מחוברת', 'err');
      return { ok: false, code: 'NO_IDENTITY' };
    }
    if (!isV2()) {
      setMsg('מצב Access Control V2 כבוי (בדיקה מקומית בלבד)', 'err');
      return { ok: false, code: 'V2_OFF' };
    }
    const cc = CC();
    const gcs = GCS();
    if (!cc || !gcs) {
      setMsg('רכיבי קהילה/בקרה חסרים', 'err');
      return { ok: false, code: 'DEPS_MISSING' };
    }
    const networkTag = 'community-' + slug;
    const communityId = slug;
    try {
      cc.register({
        communityId,
        networkTag,
        groupId: networkTag,
        slug,
        name: name.trim(),
        logoRef: '',
        description: desc,
      });
      cc.setActive(communityId);
    } catch (e) {
      setMsg('רישום קהילה נכשל: ' + (e.code || e.message || e), 'err');
      return { ok: false, code: String(e.code || e.message || e) };
    }

    let record;
    try {
      record = gcs.buildBootstrapRecord({
        groupId: networkTag,
        rootAdminPubkey: pk,
        creatorPubkey: pk,
        displayName: name.trim(),
        invitePolicy: 'EVERYONE',
      });
    } catch (e2) {
      setMsg('בניית בקרה נכשלה: ' + (e2.code || e2.message || e2), 'err');
      return { ok: false, code: String(e2.code || e2.message || e2) };
    }

    let event;
    try {
      event = await gcs.signControlRecord(record);
    } catch (e3) {
      setMsg('חתימת בקרה נכשלה: ' + (e3.code || e3.message || e3), 'err');
      return { ok: false, code: String(e3.code || e3.message || e3) };
    }

    try {
      gcs.acceptControlEvent(event, { persist: true, groupId: networkTag, networkTag });
    } catch (e4) {
      setMsg('קבלת בקרה נכשלה: ' + (e4.code || e4.message || e4), 'err');
      return { ok: false, code: String(e4.code || e4.message || e4) };
    }

    // Creator membership bootstrap via typed admin op when available
    try {
      const S = App.SosCryptoSigner;
      const ms = MS();
      const control = gcs.getVerifiedControlState && gcs.getVerifiedControlState();
      if (S && typeof S.signTypedAdminOperation === 'function' && ms) {
        const memEv = await S.signTypedAdminOperation({
          version: 1,
          operation: 'BOOTSTRAP_MEMBER_ACTIVE',
          groupId: networkTag,
          targetPubkey: pk,
        });
        if (typeof ms.acceptMembershipEvent === 'function') {
          ms.acceptMembershipEvent(memEv, control, { groupId: networkTag, persist: true });
        } else if (typeof ms.ingestMembershipEvents === 'function') {
          ms.ingestMembershipEvents([memEv], control);
        }
      }
    } catch (_memErr) {
      // Control tip is authoritative for root; membership tip best-effort
    }

    setMsg('הקבוצה נוצרה. אתם המנהלים הראשונים.', 'ok');
    try {
      window.dispatchEvent(
        new CustomEvent('sos-group-created', {
          detail: { groupId: networkTag, communityId, name: name.trim(), rootAdminPubkey: pk },
        })
      );
    } catch (_e) {}
    ensureMenuEntry();
    renderTab('details');
    return { ok: true, groupId: networkTag, communityId, rootAdminPubkey: pk };
  }

  async function createInviteFlow() {
    try {
      const svc = App.createInvite || (App.InviteService && App.InviteService.createInvite);
      if (typeof svc === 'function') {
        const inv = await svc.call(App);
        const url =
          inv && (inv.url || inv.inviteUrl || inv.link || (inv.code ? location.origin + '/?invite=' + inv.code : ''));
        const out = document.getElementById('sosGapInviteOut');
        if (out) {
          out.innerHTML =
            '<label>קישור הזמנה</label><input readonly id="sosGapInviteUrl" value="' +
            escapeHtml(url || '') +
            '">' +
            '<div class="gap-actions"><button type="button" class="gap-btn" id="sosGapCopyInvite">העתקת הזמנה</button></div>';
          window.__SOS_LAST_INVITE__ = { ...inv, url, inviteUrl: url, code: inv.code || inv.inviteCode };
        }
        setMsg('הזמנה נוצרה', 'ok');
        return { ok: true, invite: inv };
      }
      setMsg('יצירת הזמנה אינה זמינה', 'err');
      return { ok: false, code: 'NO_CREATE_INVITE' };
    } catch (e) {
      setMsg(String(e.message || e), 'err');
      return { ok: false, error: String(e.message || e) };
    }
  }

  function showQrFlow() {
    const inv = window.__SOS_LAST_INVITE__;
    const url = inv && (inv.url || inv.inviteUrl);
    const code = inv && (inv.code || inv.inviteCode);
    if (!url) {
      setMsg('צרו הזמנה תחילה', 'err');
      return { ok: false };
    }
    if (typeof window.openInviteQrModal === 'function') {
      window.openInviteQrModal(url, code);
      return { ok: true };
    }
    if (App.InviteQrUi && typeof App.InviteQrUi.open === 'function') {
      App.InviteQrUi.open(url, code);
      return { ok: true };
    }
    setMsg('רכיב QR לא נטען', 'err');
    return { ok: false };
  }

  function ensureShell() {
    if (shellEl) return;
    ensureStyles();
    shellEl = document.createElement('div');
    shellEl.id = 'sosGroupAdminShell';
    shellEl.innerHTML =
      '<div class="gap-panel" role="dialog" aria-modal="true" aria-labelledby="sosGapTitle">' +
      '<div class="gap-head"><h2 id="sosGapTitle">ניהול קבוצה</h2>' +
      '<button type="button" class="gap-btn" id="sosGapClose">סגור</button></div>' +
      '<div class="gap-tabs" id="sosGapTabs"></div>' +
      '<div class="gap-body" id="sosGapBody"></div>' +
      '<div class="gap-msg" id="sosGapMsg" role="status"></div></div>';
    document.body.appendChild(shellEl);
    const tabs = shellEl.querySelector('#sosGapTabs');
    TABS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tab = t.id;
      b.textContent = t.label;
      b.addEventListener('click', () => renderTab(t.id));
      tabs.appendChild(b);
    });
    shellEl.querySelector('#sosGapClose').addEventListener('click', close);
    shellEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.id === 'sosGapCreateBtn') createGroupFromForm();
      if (t.id === 'sosGapCreateInvite') createInviteFlow();
      if (t.id === 'sosGapShowQr') showQrFlow();
      if (t.id === 'sosGapCopyInvite') {
        const inp = document.getElementById('sosGapInviteUrl');
        if (inp && navigator.clipboard) navigator.clipboard.writeText(inp.value);
      }
      if (t.hasAttribute('data-open-legacy')) {
        const admin = AdminUi();
        if (admin && admin.open) admin.open();
      }
      if (t.hasAttribute('data-tab-jump')) renderTab(t.getAttribute('data-tab-jump'));
    });
  }

  function open(tab) {
    if (!isV2()) return;
    if (!canSeeGroupAdminMenu() && tab !== 'create') {
      // Allow create entry for authenticated users in V2 local test even before admin caps
      if (tab !== 'create' || !actor()) return;
    }
    ensureShell();
    shellEl.classList.add('is-open');
    renderTab(tab || 'home');
  }

  function openCreate() {
    if (!isV2()) return;
    if (!actor()) return;
    ensureShell();
    shellEl.classList.add('is-open');
    renderTab('create');
  }

  function close() {
    if (!shellEl) return;
    shellEl.classList.remove('is-open');
  }

  function ensureMenuEntry() {
    ensureStyles();
    let btn = document.getElementById('sosGroupAdminMenuEntry');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'sosGroupAdminMenuEntry';
      btn.type = 'button';
      btn.textContent = 'ניהול קבוצה';
      btn.className = 'gap-btn';
      btn.style.cssText =
        'position:fixed;bottom:140px;inset-inline-end:12px;z-index:9000;padding:10px 14px;border-radius:999px;border:0;background:#3d7eff;color:#fff;cursor:pointer;';
      btn.addEventListener('click', () => open('home'));
      document.body.appendChild(btn);
    }
    // Also mirror into more-options drawer if present
    let more = document.getElementById('sosGroupAdminMoreItem');
    if (!more) {
      const drawer =
        document.querySelector('#moreOptionsPanel, .more-options, #moreMenu, [data-more-options]') || null;
      if (drawer) {
        more = document.createElement('button');
        more.id = 'sosGroupAdminMoreItem';
        more.type = 'button';
        more.textContent = 'ניהול קבוצה';
        more.className = 'nav-item';
        more.addEventListener('click', () => open('home'));
        drawer.appendChild(more);
      }
    }
    const showAdmin = canSeeGroupAdminMenu();
    const showCreate = isV2() && !!actor();
    btn.classList.toggle('is-visible', showAdmin);
    btn.style.display = showAdmin ? 'inline-flex' : 'none';
    if (more) more.style.display = showAdmin ? '' : 'none';

    // Create-group shortcut for authenticated V2 users without admin yet
    let createBtn = document.getElementById('sosGroupCreateMenuEntry');
    if (!createBtn && showCreate) {
      createBtn = document.createElement('button');
      createBtn.id = 'sosGroupCreateMenuEntry';
      createBtn.type = 'button';
      createBtn.textContent = 'יצירת קבוצה';
      createBtn.style.cssText =
        'position:fixed;bottom:188px;inset-inline-end:12px;z-index:9000;padding:10px 14px;border-radius:999px;border:0;background:#2a3142;color:#fff;cursor:pointer;';
      createBtn.addEventListener('click', openCreate);
      document.body.appendChild(createBtn);
    }
    if (createBtn) createBtn.style.display = showCreate ? 'inline-flex' : 'none';

    // Keep legacy floating entry label aligned
    const legacy = document.getElementById('sosAdminSettingsEntry');
    if (legacy && showAdmin) {
      legacy.textContent = 'ניהול קבוצה';
    }
  }

  function boot() {
    if (!isV2()) return;
    ensureMenuEntry();
    window.addEventListener('sos-identity-ready', ensureMenuEntry);
    window.addEventListener('sos-access-control-v2-local', ensureMenuEntry);
    window.addEventListener('sos-group-created', ensureMenuEntry);
    setTimeout(ensureMenuEntry, 1200);
  }

  const api = Object.freeze({
    TABS,
    canSeeGroupAdminMenu,
    isActiveMember,
    open,
    openCreate,
    close,
    createGroupFromForm,
    createInviteFlow,
    showQrFlow,
    ensureMenuEntry,
    GROUP_ADMIN_MENU_LABEL: 'ניהול קבוצה',
  });

  App.GroupAdminProductUi = api;
  window.SosGroupAdminProductUi = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
