/**
 * Group Admin Product UI — Package 897 first-group control center (Hebrew).
 * Visibility follows signed effective authority from FirstGroupAdmin; it is never authority itself.
 * Every action goes through the FirstGroupAdmin gateway (session + context + signed state + typed signer).
 * New-group creation / multi-community is deferred in this phase (not exposed).
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
    { id: 'qr', label: 'QR' },
    { id: 'settings', label: 'הגדרות' },
    { id: 'security', label: 'אבטחה ופעילות ניהולית' },
  ]);

  const LABELS = Object.freeze({
    ADD_ADMIN: 'הוספת מנהל',
    REMOVE_ADMIN: 'הסרת מנהל',
    REMOVE_MEMBER: 'הסרת חבר',
    CREATE_INVITE: 'יצירת הזמנה',
    COPY_LINK: 'העתקת קישור',
    SHOW_QR: 'הצגת QR',
    REVOKE_INVITE: 'ביטול הזמנה',
    SAVE_PERMISSIONS: 'שמירת הרשאות',
    SAVE_DETAILS: 'שמירת פרטים',
    APPROVE_JOIN: 'אישור הצטרפות',
    CONFIRM: 'אישור',
    CANCEL: 'ביטול',
  });

  const POLICY_LABELS = Object.freeze({
    EVERYONE: 'כל חבר מחובר',
    AUTHORIZED_USERS_ONLY: 'רק בעלי הרשאת הזמנה',
    ADMINS_ONLY: 'מנהלים בלבד',
  });

  const STATUS_LABELS = Object.freeze({
    ACTIVE: 'פעיל',
    REMOVED: 'הוסר',
    BLOCKED: 'חסום',
    CONFLICT: 'במחלוקת',
    UNKNOWN: 'לא ידוע',
    ROOT: 'פעיל',
  });

  let shellEl = null;
  let activeTab = 'home';
  let selectedMember = '';
  let rolesTarget = '';
  let lastInvite = null;
  let busy = false;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function FGA() {
    return App.FirstGroupAdmin || window.SosFirstGroupAdmin || null;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function actor() {
    return typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shortPk(pk) {
    const s = String(pk || '');
    return s ? s.slice(0, 8) + '…' + s.slice(-4) : '—';
  }

  function safeLogoSrc(ref) {
    const s = String(ref || '');
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
    if (/^https:\/\/[^\s"'<>()\\`]{1,500}$/.test(s)) return s;
    return '';
  }

  function needsBootstrap() {
    const f = FGA();
    if (!f || !isV2() || !actor() || App.guestMode) return false;
    // Only after relays confirmed there is no control chain yet (never while authority is still loading).
    const n = App.FirstGroupNetworkAuthority;
    const s = n ? n.status() : null;
    if (!s || s.relaysOk === 0 || s.lastError !== 'NO_VERIFIED_CONTROL') return false;
    const a = f.myAuthority();
    return !a.verified && f.isConfiguredRoot(actor()) && f.contextCheck().ok;
  }

  function canSeeGroupAdminMenu() {
    const f = FGA();
    if (!f || !isV2() || App.guestMode) return false;
    return f.canSeeAdminMenu() || needsBootstrap();
  }

  function PIN() {
    return App.AdminPinLock || window.SosAdminPinLock || null;
  }

  function pinUnlocked() {
    const p = PIN();
    return !!(p && p.isUnlocked(actor()));
  }

  /** V2 on: signed authority (existing rule). V2 off: only the configured first-group root sees the read-only panel. */
  function canSeeGroupControl() {
    const f = FGA();
    if (!f || !actor() || App.guestMode) return false;
    if (isV2()) return canSeeGroupAdminMenu();
    return f.isConfiguredRoot(actor()) === true;
  }

  function controlStatus() {
    return isV2() ? 'ACTIVE_PATH' : 'CONTROL_PLANE_NOT_ACTIVE';
  }

  function isActiveMember() {
    const ms = MS();
    const pk = actor();
    if (!pk || !ms) return false;
    if (typeof ms.membershipAccessAllowed === 'function') return ms.membershipAccessAllowed(pk) === true;
    return false;
  }

  function sections() {
    const f = FGA();
    return f ? f.visibleSections() : {};
  }

  function tabAllowed(tabId, s) {
    const v = s || sections();
    if (tabId === 'home') return canSeeGroupAdminMenu();
    if (tabId === 'details') return !!v.details;
    if (tabId === 'members') return !!v.members;
    if (tabId === 'admins') return !!v.admins;
    if (tabId === 'roles') return !!v.roles;
    if (tabId === 'invites') return !!v.invites || !!v.createInvite;
    if (tabId === 'qr') return !!v.qr;
    if (tabId === 'settings') return !!v.settings;
    if (tabId === 'security') return !!v.security;
    return false;
  }

  // ---------------------------------------------------------------- styles

  function ensureStyles() {
    if (document.getElementById('sos-group-admin-product-style')) return;
    const style = document.createElement('style');
    style.id = 'sos-group-admin-product-style';
    style.textContent =
      '#sosGroupAdminShell{position:fixed;inset:0;z-index:12100;display:none;align-items:stretch;justify-content:center;background:rgba(0,0,0,.55);direction:rtl;}' +
      '#sosGroupAdminShell.is-open{display:flex;}' +
      '#sosGroupAdminShell .gap-panel{width:min(860px,96vw);max-height:92vh;margin:auto;background:#12141a;color:#f2f2f2;border-radius:14px;border:1px solid rgba(255,255,255,.12);display:flex;flex-direction:column;overflow:hidden;position:relative;}' +
      '#sosGroupAdminShell .gap-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '#sosGroupAdminShell .gap-head h2{margin:0;font-size:1.1rem;}' +
      '#sosGroupAdminShell .gap-brand{display:flex;align-items:center;gap:10px;min-width:0;}' +
      '#sosGroupAdminShell .gap-brand img{width:36px;height:36px;border-radius:8px;object-fit:cover;background:#222;}' +
      '#sosGroupAdminShell .gap-role{font-size:.78rem;background:#243049;border-radius:999px;padding:3px 9px;white-space:nowrap;}' +
      '#sosGroupAdminShell .gap-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '#sosGroupAdminShell .gap-tabs button{border:0;border-radius:999px;padding:7px 12px;background:#222836;color:#fff;cursor:pointer;font-size:.85rem;}' +
      '#sosGroupAdminShell .gap-tabs button.active{background:#3d7eff;}' +
      '#sosGroupAdminShell .gap-body{padding:14px 16px 18px;overflow:auto;flex:1;}' +
      '#sosGroupAdminShell .gap-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}' +
      '#sosGroupAdminShell button.gap-btn{border:0;border-radius:8px;padding:8px 12px;background:#2a3142;color:#fff;cursor:pointer;font-size:.9rem;}' +
      '#sosGroupAdminShell button.gap-btn.primary{background:#3d7eff;}' +
      '#sosGroupAdminShell button.gap-btn.danger{background:#a83a3a;}' +
      '#sosGroupAdminShell button.gap-btn[disabled]{opacity:.45;cursor:not-allowed;}' +
      '#sosGroupAdminShell .gap-row{display:flex;flex-direction:column;gap:6px;margin:8px 0;}' +
      '#sosGroupAdminShell input,#sosGroupAdminShell textarea,#sosGroupAdminShell select{background:#1b1e27;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px 10px;font:inherit;}' +
      '#sosGroupAdminShell .gap-list{display:flex;flex-direction:column;gap:6px;margin-top:10px;}' +
      '#sosGroupAdminShell .gap-item{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;background:#1a1e29;}' +
      '#sosGroupAdminShell .gap-item.sel{outline:2px solid #3d7eff;}' +
      '#sosGroupAdminShell .gap-sub{font-size:.8rem;opacity:.75;}' +
      '#sosGroupAdminShell .gap-mono{font-family:ui-monospace,monospace;font-size:.8rem;word-break:break-all;}' +
      '#sosGroupAdminShell .gap-caps{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;margin-top:8px;}' +
      '#sosGroupAdminShell .gap-caps label{display:flex;gap:8px;align-items:center;background:#1a1e29;border-radius:8px;padding:6px 8px;}' +
      '#sosGroupAdminShell .gap-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;}' +
      '#sosGroupAdminShell .gap-card{background:#1a1e29;border-radius:10px;padding:10px;}' +
      '#sosGroupAdminShell .gap-card b{display:block;font-size:1.2rem;}' +
      '#sosGroupAdminShell table{width:100%;border-collapse:collapse;font-size:.8rem;}' +
      '#sosGroupAdminShell td,#sosGroupAdminShell th{border-bottom:1px solid rgba(255,255,255,.08);padding:5px;text-align:start;}' +
      '#sosGroupAdminShell canvas{background:#fff;border-radius:8px;}' +
      '#sosGroupAdminShell .gap-msg{min-height:1.2em;padding:6px 16px 10px;font-size:.85rem;}' +
      '#sosGroupAdminShell .gap-msg.err{color:#ff8f8f;}' +
      '#sosGroupAdminShell .gap-msg.ok{color:#8dffb0;}' +
      '#sosGapConfirm{position:absolute;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:2;}' +
      '#sosGapConfirm.is-open{display:flex;}' +
      '#sosGapConfirm .gap-confirm-box{background:#1b1f2b;border-radius:12px;padding:16px;width:min(420px,90%);}' +
      '#sosGroupAdminMenuEntry{display:none;}' +
      '#sosGroupAdminMenuEntry.is-visible{display:block;}' +
      '@media (max-width:640px){#sosGroupAdminShell .gap-panel{width:100vw;max-height:100vh;height:100vh;border-radius:0;}' +
      '#sosGroupAdminShell .gap-tabs{flex-wrap:nowrap;overflow-x:auto;}' +
      '#sosGroupAdminShell .gap-tabs button{flex:0 0 auto;}' +
      '#sosGroupAdminShell .gap-item{flex-direction:column;align-items:stretch;}' +
      '#sosGroupAdminShell .gap-actions button{flex:1 1 auto;}}';
    document.head.appendChild(style);
  }

  function setMsg(text, cls) {
    const el = document.getElementById('sosGapMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gap-msg' + (cls ? ' ' + cls : '');
  }

  const ERROR_TEXT = {
    UNAUTHORIZED: 'אין הרשאה לפעולה זו',
    SESSION_REVOKED: 'ההתחברות אינה בתוקף. התחברו מחדש.',
    SESSION_ACCOUNT_MISMATCH: 'החשבון השתנה. רעננו את הדף.',
    STALE_BASE: 'המצב התעדכן בלשונית אחרת. נסו שוב.',
    SELF_GRANT_FORBIDDEN: 'אי אפשר להעניק הרשאות לעצמכם',
    DELEGATION_ESCALATION: 'אין הרשאה להעניק הרשאה זו',
    ROOT_IMMUTABLE: 'המנהל הראשי מוגן',
    ROOT_PROTECTED: 'המנהל הראשי מוגן',
    ROOT_TARGET_FORBIDDEN: 'המנהל הראשי מוגן',
    TARGET_NOT_ACTIVE_MEMBER: 'המשתמש אינו חבר פעיל',
    TARGET_NOT_REMOVABLE: 'לא ניתן להסיר משתמש זה',
    FIRST_GROUP_CONTEXT_MISMATCH: 'הניהול זמין לקבוצה הראשית בלבד',
    NO_VERIFIED_CONTROL: 'מצב הניהול החתום לא נטען',
    CONTROL_CONFLICT: 'קיימת מחלוקת במצב הניהול',
    LOGO_TOO_LARGE: 'הלוגו גדול מדי',
    BAD_LOGO_REF: 'קובץ לוגו לא נתמך',
    NO_CHANGES: 'אין שינויים לשמירה',
    CONTROL_PLANE_NOT_ACTIVE: 'מערכת השליטה על הקבוצה עדיין לא הופעלה',
    V2_REQUIRED: 'מערכת השליטה על הקבוצה עדיין לא הופעלה',
    ADMIN_PIN_REQUIRED: 'נדרש קוד מנהל',
  };

  function errText(res) {
    const code = (res && res.code) || 'ERROR';
    return (ERROR_TEXT[code] || 'הפעולה נכשלה') + ' (' + code + ')';
  }

  // ---------------------------------------------------------------- confirm

  function confirmAction(text) {
    return new Promise((resolve) => {
      const box = document.getElementById('sosGapConfirm');
      if (!box) {
        resolve(false);
        return;
      }
      box.querySelector('#sosGapConfirmText').textContent = text;
      box.classList.add('is-open');
      const ok = box.querySelector('#sosGapConfirmOk');
      const cancel = box.querySelector('#sosGapConfirmCancel');
      const finish = (v) => {
        box.classList.remove('is-open');
        ok.onclick = null;
        cancel.onclick = null;
        resolve(v);
      };
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
    });
  }

  async function run(label, fn, confirmText) {
    if (busy) return { ok: false, code: 'BUSY' };
    const p = PIN();
    const unlocked = p ? await p.requestUnlock() : { ok: false };
    if (!unlocked.ok) {
      setMsg(errText({ code: 'ADMIN_PIN_REQUIRED' }), 'err');
      return { ok: false, code: 'ADMIN_PIN_REQUIRED' };
    }
    if (!isV2()) {
      setMsg(errText({ code: 'CONTROL_PLANE_NOT_ACTIVE' }), 'err');
      return { ok: false, code: 'CONTROL_PLANE_NOT_ACTIVE' };
    }
    if (confirmText) {
      const yes = await confirmAction(confirmText);
      if (!yes) {
        setMsg('הפעולה בוטלה', '');
        return { ok: false, code: 'CANCELLED' };
      }
    }
    busy = true;
    setMsg(label + '…', '');
    let res;
    try {
      res = await fn();
    } catch (e) {
      res = { ok: false, code: (e && e.code) || 'ERROR', error: String((e && e.message) || e) };
    }
    busy = false;
    if (res && res.ok && p) p.touch();
    if (res && res.ok) setMsg(label + ' — בוצע', 'ok');
    else setMsg(errText(res), 'err');
    refreshChrome();
    renderTab(activeTab);
    return res;
  }

  // ---------------------------------------------------------------- render

  function groupInfo() {
    const g = GCS();
    const s = g && typeof g.getGroupSettings === 'function' ? g.getGroupSettings('israel-network') : null;
    const st = g && g.getVerifiedControlState ? g.getVerifiedControlState('israel-network') : null;
    return {
      displayName: (s && s.displayName) || 'SOS',
      description: (s && s.description) || '',
      logoRef: (s && s.logoRef) || '',
      invitePolicy: st && st.verified ? st.invitePolicy : '',
      epoch: st && st.verified ? st.controlEpoch : null,
      root: st && st.verified ? st.rootAdminPubkey : '',
    };
  }

  function refreshChrome() {
    if (!shellEl) return;
    const f = FGA();
    const info = groupInfo();
    const a = f ? f.myAuthority() : null;
    const title = shellEl.querySelector('#sosGapTitle');
    if (title) title.textContent = 'ניהול קבוצה — ' + info.displayName;
    const logo = shellEl.querySelector('#sosGapLogo');
    const src = safeLogoSrc(info.logoRef);
    if (logo) {
      logo.style.display = src ? '' : 'none';
      if (src) logo.src = src;
    }
    const role = shellEl.querySelector('#sosGapRole');
    if (role) role.textContent = a && a.verified ? f.roleLabel(a.role) : 'לא מאומת';
    const s = sections();
    shellEl.querySelectorAll('#sosGapTabs button').forEach((b) => {
      const allowed = tabAllowed(b.dataset.tab, s);
      b.hidden = !allowed;
      b.style.display = allowed ? '' : 'none';
      b.classList.toggle('active', b.dataset.tab === activeTab);
    });
  }

  function renderHome(body) {
    const f = FGA();
    const info = groupInfo();
    if (needsBootstrap()) {
      body.innerHTML =
        '<p>ניהול הקבוצה הראשית טרם הופעל. אתם המנהל הראשי המוגדר.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="bootstrap">הפעלת ניהול הקבוצה</button></div>';
      return;
    }
    const a = f.myAuthority();
    const dir = f.directory('');
    const active = dir.filter((r) => r.status === 'ACTIVE').length;
    const adminsN = f.admins().length;
    const invitesN = f.listMyInvites().filter((r) => r.status === 'ACTIVE').length;
    body.innerHTML =
      '<p><strong>' + escapeHtml(info.displayName) + '</strong></p>' +
      (info.description ? '<p class="gap-sub">' + escapeHtml(info.description) + '</p>' : '') +
      '<div class="gap-cards">' +
      '<div class="gap-card">התפקיד שלי<b>' + escapeHtml(f.roleLabel(a.role)) + '</b></div>' +
      '<div class="gap-card">חברים פעילים<b>' + active + '</b></div>' +
      '<div class="gap-card">מנהלים<b>' + adminsN + '</b></div>' +
      '<div class="gap-card">הזמנות פעילות שלי<b>' + invitesN + '</b></div>' +
      '</div>' +
      '<p class="gap-sub">ההרשאות שלי: ' +
      escapeHtml(a.isRoot ? 'כל ההרשאות (מנהל ראשי)' : a.caps.map((c) => f.CAP_LABELS[c] || c).join(', ') || '—') +
      '</p>';
  }

  function renderDetails(body) {
    const info = groupInfo();
    const s = sections();
    const src = safeLogoSrc(info.logoRef);
    let html =
      '<div class="gap-row"><label>שם הקבוצה</label><div id="sosGapViewName">' + escapeHtml(info.displayName) + '</div></div>' +
      '<div class="gap-row"><label>תיאור</label><div id="sosGapViewDesc">' + escapeHtml(info.description || '—') + '</div></div>' +
      '<div class="gap-row"><label>לוגו</label><div>' +
      (src ? '<img id="sosGapViewLogo" alt="לוגו הקבוצה" style="max-height:64px;border-radius:8px" src="' + escapeHtml(src) + '">' : '—') +
      '</div></div>' +
      '<div class="gap-row"><label>מזהה קבוצה</label><div class="gap-mono">israel-network</div></div>' +
      '<div class="gap-row"><label>מנהל ראשי</label><div class="gap-mono">' + escapeHtml(shortPk(info.root)) + '</div></div>';
    if (s.editDetails) {
      html +=
        '<hr><div class="gap-row"><label for="sosGapName">עריכת שם</label><input id="sosGapName" maxlength="80" value="' + escapeHtml(info.displayName) + '"></div>' +
        '<div class="gap-row"><label for="sosGapDesc">עריכת תיאור</label><textarea id="sosGapDesc" rows="3" maxlength="280">' + escapeHtml(info.description) + '</textarea></div>' +
        '<div class="gap-row"><label for="sosGapLogoFile">החלפת לוגו</label><input id="sosGapLogoFile" type="file" accept="image/png,image/jpeg,image/webp">' +
        '<div id="sosGapLogoPreview"></div></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="save-details">' + LABELS.SAVE_DETAILS + '</button>' +
        (src ? '<button type="button" class="gap-btn" data-act="remove-logo">הסרת לוגו</button>' : '') +
        '</div>';
    }
    body.innerHTML = html;
    const file = document.getElementById('sosGapLogoFile');
    if (file) {
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        const prev = document.getElementById('sosGapLogoPreview');
        window.__SOS_GAP_LOGO_DATA__ = '';
        if (!f) return;
        const data = await compressLogo(f).catch(() => '');
        if (!data) {
          setMsg(ERROR_TEXT.BAD_LOGO_REF, 'err');
          return;
        }
        window.__SOS_GAP_LOGO_DATA__ = data;
        if (prev) prev.innerHTML = '<img alt="תצוגה מקדימה" style="max-height:64px;border-radius:8px" src="' + escapeHtml(data) + '">';
      });
    }
  }

  function compressLogo(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) {
        reject(new Error('type'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode'));
        img.onload = () => {
          const max = 128;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const P = App.AdminSigningPolicy || window.SosAdminSigningPolicy;
          const limit = (P && P.LOGO_REF_MAX) || 24576;
          for (const q of [0.85, 0.7, 0.5, 0.35]) {
            let d = c.toDataURL('image/webp', q);
            if (!/^data:image\/webp/.test(d)) d = c.toDataURL('image/jpeg', q);
            if (d.length <= limit) {
              resolve(d);
              return;
            }
          }
          reject(new Error('too_large'));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  function memberRowHtml(r, selectable) {
    return (
      '<div class="gap-item' + (r.pubkey === selectedMember ? ' sel' : '') + '" data-member="' + escapeHtml(r.pubkey) + '">' +
      '<div><div>' + escapeHtml(r.displayName || shortPk(r.pubkey)) + '</div>' +
      '<div class="gap-sub gap-mono">' + escapeHtml(shortPk(r.pubkey)) + '</div></div>' +
      '<div class="gap-sub">' + escapeHtml(r.roleLabel) + ' · ' + escapeHtml(STATUS_LABELS[r.status] || r.status) + '</div>' +
      (selectable ? '<button type="button" class="gap-btn" data-act="select-member" data-pk="' + escapeHtml(r.pubkey) + '">פרטים</button>' : '') +
      '</div>'
    );
  }

  function renderMembers(body) {
    const f = FGA();
    const s = sections();
    const q = (document.getElementById('sosGapSearch') || {}).value || '';
    const rows = f.directory(q);
    let html =
      '<div class="gap-row"><label for="sosGapSearch">חיפוש חבר</label><input id="sosGapSearch" placeholder="שם או מפתח ציבורי" value="' + escapeHtml(q) + '"></div>' +
      '<div class="gap-list" id="sosGapMemberList">' + (rows.map((r) => memberRowHtml(r, true)).join('') || '<div class="gap-sub">אין חברים להצגה</div>') + '</div>';
    const sel = rows.find((r) => r.pubkey === selectedMember) || f.directory('').find((r) => r.pubkey === selectedMember);
    if (sel) {
      html +=
        '<div class="gap-card" id="sosGapMemberDetail" style="margin-top:12px">' +
        '<div><strong>' + escapeHtml(sel.displayName || 'חבר') + '</strong></div>' +
        '<div class="gap-mono">' + escapeHtml(sel.pubkey) + '</div>' +
        '<div class="gap-sub">תפקיד: ' + escapeHtml(sel.roleLabel) + ' · מצב: ' + escapeHtml(STATUS_LABELS[sel.status] || sel.status) + '</div>' +
        '<div class="gap-sub">הרשאות: ' + escapeHtml(sel.isRoot ? 'כל ההרשאות' : sel.caps.map((c) => f.CAP_LABELS[c] || c).join(', ') || '—') + '</div>' +
        '<div class="gap-actions">' +
        (s.removeMembers && !sel.isRoot && sel.status === 'ACTIVE' && sel.pubkey !== actor()
          ? '<button type="button" class="gap-btn danger" data-act="remove-member" data-pk="' + escapeHtml(sel.pubkey) + '">' + LABELS.REMOVE_MEMBER + '</button>'
          : '') +
        (s.roles && !sel.isRoot && sel.status === 'ACTIVE'
          ? '<button type="button" class="gap-btn" data-act="edit-perms" data-pk="' + escapeHtml(sel.pubkey) + '">עריכת הרשאות</button>'
          : '') +
        '</div></div>';
    }
    if (s.removeMembers) {
      html +=
        '<h3 style="margin-top:16px">בקשות הצטרפות</h3>' +
        '<div class="gap-actions"><button type="button" class="gap-btn" data-act="load-joins">רענון בקשות</button></div>' +
        '<div class="gap-list" id="sosGapJoinList"></div>';
    }
    body.innerHTML = html;
    const search = document.getElementById('sosGapSearch');
    if (search) {
      search.addEventListener('input', () => {
        const list = document.getElementById('sosGapMemberList');
        if (list) list.innerHTML = f.directory(search.value).map((r) => memberRowHtml(r, true)).join('') || '<div class="gap-sub">אין תוצאות</div>';
      });
    }
  }

  async function loadJoins() {
    const f = FGA();
    const list = document.getElementById('sosGapJoinList');
    if (!list) return;
    list.innerHTML = '<div class="gap-sub">טוען…</div>';
    const res = await f.listPendingJoins();
    if (!res.ok) {
      list.innerHTML = '<div class="gap-sub">' + escapeHtml(errText(res)) + '</div>';
      return;
    }
    list.innerHTML =
      res.rows
        .map(
          (r) =>
            '<div class="gap-item"><div class="gap-mono">' + escapeHtml(shortPk(r.memberPubkey)) + '</div>' +
            '<button type="button" class="gap-btn primary" data-act="approve-join" data-pk="' + escapeHtml(r.memberPubkey) + '" data-invite="' + escapeHtml(r.inviteEventId) + '">' + LABELS.APPROVE_JOIN + '</button></div>'
        )
        .join('') || '<div class="gap-sub">אין בקשות ממתינות</div>';
  }

  function renderAdmins(body) {
    const f = FGA();
    const s = sections();
    const admins = f.admins();
    const candidates = f.directory('').filter((r) => !r.isRoot && r.status === 'ACTIVE' && r.caps.indexOf('MANAGE_MEMBERS') === -1 && r.pubkey !== actor());
    let html =
      '<div class="gap-list" id="sosGapAdminList">' +
      admins
        .map(
          (r) =>
            '<div class="gap-item" data-admin="' + escapeHtml(r.pubkey) + '"><div><div>' + escapeHtml(r.displayName || shortPk(r.pubkey)) + '</div>' +
            '<div class="gap-sub">' + escapeHtml(r.roleLabel) + '</div></div>' +
            (s.manageAdmins && !r.isRoot && r.pubkey !== actor()
              ? '<button type="button" class="gap-btn danger" data-act="demote" data-pk="' + escapeHtml(r.pubkey) + '">' + LABELS.REMOVE_ADMIN + '</button>'
              : r.isRoot
                ? '<span class="gap-sub">מוגן</span>'
                : '') +
            '</div>'
        )
        .join('') +
      '</div>';
    if (s.manageAdmins) {
      html +=
        '<div class="gap-row" style="margin-top:12px"><label for="sosGapPromoteSel">בחירת חבר לקידום</label><select id="sosGapPromoteSel">' +
        candidates.map((r) => '<option value="' + escapeHtml(r.pubkey) + '">' + escapeHtml((r.displayName || shortPk(r.pubkey)) + ' · ' + r.roleLabel) + '</option>').join('') +
        '</select></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="promote"' + (candidates.length ? '' : ' disabled') + '>' + LABELS.ADD_ADMIN + '</button></div>';
    }
    body.innerHTML = html;
  }

  function renderRoles(body) {
    const f = FGA();
    const me = f.myAuthority();
    const targets = f.directory('').filter((r) => !r.isRoot && r.status === 'ACTIVE');
    if (!rolesTarget || !targets.some((t) => t.pubkey === rolesTarget)) rolesTarget = targets.length ? targets[0].pubkey : '';
    const target = targets.find((t) => t.pubkey === rolesTarget);
    const grantable = target ? f.grantableCapsFor(me, target.pubkey) : [];
    const allCaps = Object.keys(f.CAP_LABELS);
    let html =
      '<p class="gap-sub">תפקידים הם תצוגה של הרשאות קנוניות. הענקת הרשאה אחת אינה הופכת למנהל מלא.</p>' +
      '<table><thead><tr><th>תפקיד</th><th>הרשאות</th></tr></thead><tbody>' +
      f.ROLES.map(
        (r) =>
          '<tr><td>' + escapeHtml(r.label) + '</td><td>' +
          escapeHtml(r.id === 'ROOT' ? 'כל ההרשאות (לא ניתן להעברה)' : r.preset ? r.preset.map((c) => f.CAP_LABELS[c]).join(', ') : r.id === 'MEMBER' ? 'חברות פעילה' : 'שילוב הרשאות') +
          '</td></tr>'
      ).join('') +
      '</tbody></table>';
    if (!target) {
      body.innerHTML = html + '<p class="gap-sub">אין חברים פעילים להגדרת הרשאות</p>';
      return;
    }
    html +=
      '<div class="gap-row" style="margin-top:12px"><label for="sosGapRoleTarget">חבר</label><select id="sosGapRoleTarget">' +
      targets.map((t) => '<option value="' + escapeHtml(t.pubkey) + '"' + (t.pubkey === rolesTarget ? ' selected' : '') + '>' + escapeHtml((t.displayName || shortPk(t.pubkey)) + ' · ' + t.roleLabel) + '</option>').join('') +
      '</select></div>' +
      '<div class="gap-caps" id="sosGapCaps">' +
      allCaps
        .map((c) => {
          const checked = target.assigned.indexOf(c) !== -1;
          const can = grantable.indexOf(c) !== -1;
          return (
            '<label><input type="checkbox" data-cap="' + c + '"' + (checked ? ' checked' : '') + (can ? '' : ' disabled') + '> ' +
            escapeHtml(f.CAP_LABELS[c]) + '</label>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="save-perms">' + LABELS.SAVE_PERMISSIONS + '</button>' +
      f.ROLES.filter((r) => r.preset && r.preset.every((c) => grantable.indexOf(c) !== -1))
        .map((r) => '<button type="button" class="gap-btn" data-act="assign-role" data-role="' + r.id + '">הגדרה כ' + escapeHtml(r.label) + '</button>')
        .join('') +
      '</div>';
    body.innerHTML = html;
    const sel = document.getElementById('sosGapRoleTarget');
    if (sel) {
      sel.addEventListener('change', () => {
        rolesTarget = sel.value;
        renderTab('roles');
      });
    }
  }

  function renderInvites(body) {
    const f = FGA();
    const s = sections();
    const rows = f.listMyInvites();
    let html = '<p class="gap-sub">קישור ההזמנה כולל קוד הזמנה בלבד — ללא מפתחות פרטיים.</p>';
    html +=
      '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="create-invite"' + (s.createInvite ? '' : ' disabled') + '>' + LABELS.CREATE_INVITE + '</button></div>';
    if (lastInvite) {
      html +=
        '<div class="gap-row"><label for="sosGapInviteUrl">קישור הזמנה</label><input readonly id="sosGapInviteUrl" value="' + escapeHtml(lastInvite.inviteUrl) + '"></div>' +
        '<div class="gap-actions">' +
        '<button type="button" class="gap-btn" data-act="copy-invite">' + LABELS.COPY_LINK + '</button>' +
        '<button type="button" class="gap-btn" data-act="show-qr">' + LABELS.SHOW_QR + '</button></div>';
    }
    html +=
      '<div class="gap-list" id="sosGapInviteList">' +
      rows
        .map(
          (r, i) =>
            '<div class="gap-item"><div class="gap-mono">' + escapeHtml(r.code) + '</div><div class="gap-sub">' + (r.status === 'ACTIVE' ? 'פעילה' : 'בוטלה') + '</div>' +
            (r.status === 'ACTIVE' && s.revokeInvites
              ? '<button type="button" class="gap-btn danger" data-act="revoke-invite" data-idx="' + i + '">' + LABELS.REVOKE_INVITE + '</button>'
              : '') +
            '</div>'
        )
        .join('') +
      '</div>';
    body.innerHTML = html;
  }

  function renderQr(body) {
    body.innerHTML =
      '<p class="gap-sub">ה-QR נוצר מקישור ההזמנה הקנוני בלבד.</p>' +
      (lastInvite
        ? '<canvas id="sosGapQrCanvas" width="240" height="240" aria-label="קוד QR להזמנה"></canvas><p class="gap-mono" id="sosGapQrCode">' + escapeHtml(lastInvite.code) + '</p>'
        : '<p>צרו הזמנה תחילה.</p><div class="gap-actions"><button type="button" class="gap-btn primary" data-act="create-invite">' + LABELS.CREATE_INVITE + '</button></div>') +
      '<div class="gap-row" style="margin-top:12px"><label for="sosGapQrParse">בדיקת קישור / קוד שנסרק</label><input id="sosGapQrParse" placeholder="הדביקו קישור הזמנה"></div>' +
      '<div class="gap-actions"><button type="button" class="gap-btn" data-act="parse-qr">בדיקה</button></div>' +
      '<div id="sosGapQrParseOut" class="gap-sub"></div>';
    if (lastInvite) {
      const canvas = document.getElementById('sosGapQrCanvas');
      FGA()
        .renderInviteQr(canvas, lastInvite.inviteUrl)
        .then((r) => {
          if (!r.ok) setMsg(errText(r), 'err');
        });
    }
  }

  function renderSettings(body) {
    const info = groupInfo();
    body.innerHTML =
      '<div class="gap-row"><label for="sosGapPolicy">מי יכול ליצור הזמנות</label><select id="sosGapPolicy">' +
      Object.keys(POLICY_LABELS)
        .map((k) => '<option value="' + k + '"' + (k === info.invitePolicy ? ' selected' : '') + '>' + escapeHtml(POLICY_LABELS[k]) + '</option>')
        .join('') +
      '</select></div>' +
      '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="save-policy">שמירת הגדרות</button></div>' +
      '<p class="gap-sub">יצירת קבוצות נוספות ורשת קהילות — בשלב הבא.</p>';
  }

  function renderSecurity(body) {
    const f = FGA();
    const rows = f.auditLog().slice().reverse();
    const actionLabel = {
      BOOTSTRAP: 'הפעלת ניהול',
      GRANT_CAPABILITY: 'הענקת הרשאה',
      REVOKE_CAPABILITY: 'הסרת הרשאה',
      SET_INVITE_POLICY: 'שינוי מדיניות הזמנות',
      SET_GROUP_METADATA: 'עריכת פרטי הקבוצה',
      BLOCKLIST_CHANGED: 'שינוי רשימת חסימה',
      MEMBER_ACTIVE: 'חבר אושר',
      MEMBER_REMOVED: 'חבר הוסר',
      MEMBER_BLOCKED: 'חבר נחסם',
    };
    body.innerHTML =
      '<p class="gap-sub">יומן זה נבנה מאירועים חתומים ומאומתים בלבד (שרשרת בקרה + אירועי חברות).</p>' +
      '<table id="sosGapAudit"><thead><tr><th>זמן</th><th>פעולה</th><th>מבצע</th><th>יעד</th><th>פרט</th></tr></thead><tbody>' +
      rows
        .map(
          (r) =>
            '<tr><td>' + escapeHtml(r.createdAt ? new Date(r.createdAt * 1000).toLocaleString('he-IL') : '') + '</td>' +
            '<td>' + escapeHtml(actionLabel[r.action] || r.action) + '</td>' +
            '<td class="gap-mono">' + escapeHtml(shortPk(r.actor)) + '</td>' +
            '<td class="gap-mono">' + escapeHtml(r.target ? shortPk(r.target) : '') + '</td>' +
            '<td>' + escapeHtml(f.CAP_LABELS[r.detail] || r.detail || '') + '</td></tr>'
        )
        .join('') +
      '</tbody></table>';
  }

  /** Control plane (V2 + signed control chain) not active: read-only view, every mutation fails closed. */
  function renderInactive(body) {
    const f = FGA();
    const g = GCS();
    const roots = g && typeof g.configuredRootPubkeys === 'function' ? g.configuredRootPubkeys() : [];
    const root = roots[0] || '';
    const info = groupInfo();
    body.innerHTML =
      '<div class="gap-card" id="sosGapControlStatus" data-status="CONTROL_PLANE_NOT_ACTIVE" style="margin-bottom:12px">' +
      '<strong>מצב שליטה: לא פעיל</strong>' +
      '<div class="gap-sub">מערכת השליטה החתומה על הקבוצה עדיין לא הופעלה. אי אפשר לבצע שינויים עד להפעלתה (CONTROL_PLANE_NOT_ACTIVE).</div></div>' +
      '<div class="gap-cards">' +
      '<div class="gap-card">שם הקבוצה<b id="sosGapViewName">' + escapeHtml(info.displayName) + '</b></div>' +
      '<div class="gap-card">מזהה<b class="gap-mono">' + escapeHtml(f.FIRST_GROUP_ID) + '</b></div>' +
      '<div class="gap-card">חברים<b id="sosGapMemberCount">—</b></div>' +
      '<div class="gap-card">מנהלים<b>' + (root ? 1 : 0) + '</b></div>' +
      '<div class="gap-card">הזמנות<b>—</b></div>' +
      '</div>' +
      '<h3 style="margin-top:14px">מנהל ראשי</h3>' +
      '<div class="gap-list"><div class="gap-item" id="sosGapRootCard" data-root="1"><div><div>' + escapeHtml(f.roleLabel('ROOT')) + '</div>' +
      '<div class="gap-sub gap-mono">' + escapeHtml(root) + '</div></div><span class="gap-sub">מוגן — לא ניתן לשנות או להסיר</span></div></div>' +
      '<h3 style="margin-top:14px">תפקידים</h3>' +
      '<table><thead><tr><th>תפקיד</th><th>הרשאות</th></tr></thead><tbody>' +
      f.ROLES.map(
        (r) =>
          '<tr><td>' + escapeHtml(r.label) + '</td><td>' +
          escapeHtml(r.id === 'ROOT' ? 'כל ההרשאות (לא ניתן להעברה)' : r.preset ? r.preset.map((c) => f.CAP_LABELS[c]).join(', ') : r.id === 'MEMBER' ? 'חברות פעילה' : 'שילוב הרשאות') +
          '</td></tr>'
      ).join('') +
      '</tbody></table>' +
      '<h3 style="margin-top:14px">הרשאות</h3>' +
      '<div class="gap-caps" id="sosGapCapsCatalog">' +
      Object.keys(f.CAP_LABELS)
        .map((c) => '<label><input type="checkbox" data-cap="' + c + '" disabled> ' + escapeHtml(f.CAP_LABELS[c]) + '</label>')
        .join('') +
      '</div>' +
      '<div class="gap-actions">' +
      '<button type="button" class="gap-btn" disabled>' + LABELS.SAVE_DETAILS + '</button>' +
      '<button type="button" class="gap-btn" disabled>' + LABELS.ADD_ADMIN + '</button>' +
      '<button type="button" class="gap-btn" disabled>' + LABELS.CREATE_INVITE + '</button></div>';
  }

  function renderTab(tabId) {
    if (!shellEl) return;
    const body0 = document.getElementById('sosGapBody');
    if (!pinUnlocked()) {
      if (body0) body0.innerHTML = '';
      close();
      return;
    }
    if (!isV2()) {
      activeTab = 'home';
      refreshChrome();
      shellEl.querySelectorAll('#sosGapTabs button').forEach((b) => {
        const on = b.dataset.tab === 'home';
        b.hidden = !on;
        b.style.display = on ? '' : 'none';
      });
      const role = shellEl.querySelector('#sosGapRole');
      if (role) role.textContent = 'מנהל ראשי · לא פעיל';
      if (body0) renderInactive(body0);
      return;
    }
    const s = sections();
    let tab = tabId;
    if (!tabAllowed(tab, s)) tab = 'home';
    activeTab = tab;
    renderedFingerprint = stateFingerprint();
    refreshChrome();
    const body = document.getElementById('sosGapBody');
    if (!body) return;
    if (!canSeeGroupAdminMenu()) {
      body.innerHTML = '<p>אין לכם הרשאות ניהול בקבוצה.</p>';
      return;
    }
    if (tab === 'home') renderHome(body);
    else if (tab === 'details') renderDetails(body);
    else if (tab === 'members') renderMembers(body);
    else if (tab === 'admins') renderAdmins(body);
    else if (tab === 'roles') renderRoles(body);
    else if (tab === 'invites') renderInvites(body);
    else if (tab === 'qr') renderQr(body);
    else if (tab === 'settings') renderSettings(body);
    else if (tab === 'security') renderSecurity(body);
  }

  // ---------------------------------------------------------------- actions

  async function onAction(act, el) {
    const f = FGA();
    const pk = el.getAttribute('data-pk') || '';
    if (act === 'bootstrap') return run('הפעלת ניהול', () => f.bootstrapFirstGroup({}));
    if (act === 'save-details') {
      const name = (document.getElementById('sosGapName') || {}).value;
      const desc = (document.getElementById('sosGapDesc') || {}).value;
      const logo = String(window.__SOS_GAP_LOGO_DATA__ || '');
      const info = groupInfo();
      const fields = {};
      if (name != null && name.trim() !== info.displayName) fields.displayName = name;
      if (desc != null && desc.trim() !== info.description) fields.description = desc;
      if (logo) fields.logoRef = logo;
      const res = await run(LABELS.SAVE_DETAILS, () => f.updateMetadata(fields));
      if (res.ok) window.__SOS_GAP_LOGO_DATA__ = '';
      return res;
    }
    if (act === 'remove-logo') return run('הסרת לוגו', () => f.updateMetadata({ logoRef: '' }), 'להסיר את לוגו הקבוצה?');
    if (act === 'select-member') {
      selectedMember = pk;
      return renderTab('members');
    }
    if (act === 'remove-member') {
      return run(LABELS.REMOVE_MEMBER, () => f.removeMember(pk), 'להסיר את החבר מהקבוצה? כל ההרשאות שלו יבוטלו.');
    }
    if (act === 'edit-perms') {
      rolesTarget = pk;
      return renderTab('roles');
    }
    if (act === 'load-joins') return loadJoins();
    if (act === 'approve-join') {
      return run(LABELS.APPROVE_JOIN, () => f.approveJoin(pk, el.getAttribute('data-invite')), 'לאשר את הצטרפות המשתמש לקבוצה?');
    }
    if (act === 'promote') {
      const sel = document.getElementById('sosGapPromoteSel');
      const target = sel && sel.value;
      if (!target) return null;
      return run(LABELS.ADD_ADMIN, () => f.promoteAdmin(target), 'להפוך את החבר למנהל (ניהול חברים)?');
    }
    if (act === 'demote') {
      return run(LABELS.REMOVE_ADMIN, () => f.demoteAdmin(pk), 'להסיר את הרשאות הניהול של המשתמש?');
    }
    if (act === 'save-perms') {
      const caps = Array.from(document.querySelectorAll('#sosGapCaps input[type=checkbox]'))
        .filter((c) => c.checked)
        .map((c) => c.getAttribute('data-cap'));
      const target = rolesTarget;
      const before = f.authorityFor(target).assigned;
      const removing = before.some((c) => caps.indexOf(c) === -1);
      return run(LABELS.SAVE_PERMISSIONS, () => f.setPermissions(target, caps), removing ? 'לשמור הרשאות? חלק מההרשאות יוסרו.' : null);
    }
    if (act === 'assign-role') {
      const role = el.getAttribute('data-role');
      return run('הגדרת תפקיד', () => f.assignRole(rolesTarget, role));
    }
    if (act === 'create-invite') {
      const res = await run(LABELS.CREATE_INVITE, () => f.createInvite());
      if (res && res.ok) {
        lastInvite = res.invite;
        renderTab(activeTab === 'qr' ? 'qr' : 'invites');
      }
      return res;
    }
    if (act === 'copy-invite') {
      const url = lastInvite && lastInvite.inviteUrl;
      if (!url) return null;
      try {
        await navigator.clipboard.writeText(url);
        setMsg('הקישור הועתק', 'ok');
      } catch (_e) {
        const inp = document.getElementById('sosGapInviteUrl');
        if (inp) {
          inp.select();
          try {
            document.execCommand('copy');
          } catch (_e2) {}
        }
        setMsg('הקישור מסומן להעתקה', 'ok');
      }
      window.__SOS_GAP_LAST_COPIED__ = url;
      return { ok: true };
    }
    if (act === 'show-qr') return renderTab('qr');
    if (act === 'revoke-invite') {
      const row = f.listMyInvites()[Number(el.getAttribute('data-idx'))];
      if (!row) return null;
      const res = await run(LABELS.REVOKE_INVITE, () => f.revokeInvite(row), 'לבטל את ההזמנה? הקישור יפסיק לעבוד.');
      if (res && res.ok && lastInvite && lastInvite.eventId === row.eventId) lastInvite = null;
      renderTab('invites');
      return res;
    }
    if (act === 'parse-qr') {
      const val = (document.getElementById('sosGapQrParse') || {}).value || '';
      const r = f.parseInviteQr(val);
      const out = document.getElementById('sosGapQrParseOut');
      if (out) out.textContent = r.ok ? 'קוד הזמנה תקין: ' + r.code : 'קישור לא תקין (' + r.code + ')';
      return r;
    }
    if (act === 'save-policy') {
      const v = (document.getElementById('sosGapPolicy') || {}).value;
      return run('שמירת הגדרות', () => f.setInvitePolicy(v));
    }
    return null;
  }

  function ensureShell() {
    if (shellEl) return;
    ensureStyles();
    shellEl = document.createElement('div');
    shellEl.id = 'sosGroupAdminShell';
    shellEl.innerHTML =
      '<div class="gap-panel" role="dialog" aria-modal="true" aria-labelledby="sosGapTitle">' +
      '<div class="gap-head"><div class="gap-brand"><img id="sosGapLogo" alt="" style="display:none"><h2 id="sosGapTitle">ניהול קבוצה</h2>' +
      '<span class="gap-role" id="sosGapRole"></span></div>' +
      '<button type="button" class="gap-btn" id="sosGapClose">סגור</button></div>' +
      '<div class="gap-tabs" id="sosGapTabs" role="tablist"></div>' +
      '<div class="gap-body" id="sosGapBody"></div>' +
      '<div class="gap-msg" id="sosGapMsg" role="status"></div>' +
      '<div id="sosGapConfirm" role="alertdialog" aria-modal="true"><div class="gap-confirm-box"><p id="sosGapConfirmText"></p>' +
      '<div class="gap-actions"><button type="button" class="gap-btn danger" id="sosGapConfirmOk">' + LABELS.CONFIRM + '</button>' +
      '<button type="button" class="gap-btn" id="sosGapConfirmCancel">' + LABELS.CANCEL + '</button></div></div></div>' +
      '</div>';
    document.body.appendChild(shellEl);
    const tabs = shellEl.querySelector('#sosGapTabs');
    TABS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      b.textContent = t.label;
      b.addEventListener('click', () => renderTab(t.id));
      tabs.appendChild(b);
    });
    shellEl.querySelector('#sosGapClose').addEventListener('click', close);
    shellEl.addEventListener('click', (ev) => {
      const p = PIN();
      if (p) p.touch();
      const t = ev.target instanceof HTMLElement ? ev.target.closest('[data-act]') : null;
      if (!t || t.hasAttribute('disabled')) return;
      onAction(t.getAttribute('data-act'), t);
    });
  }

  /** Every open requires an unlocked admin PIN session for the current identity. */
  async function open(tab) {
    ensureMenuEntry();
    if (!canSeeGroupControl()) return { ok: false, code: 'UNAUTHORIZED' };
    const p = PIN();
    if (!p) return { ok: false, code: 'ADMIN_PIN_REQUIRED' };
    const who = actor();
    const u = await p.requestUnlock();
    if (!u.ok || actor() !== who || !canSeeGroupControl()) return { ok: false, code: u.ok ? 'UNAUTHORIZED' : 'ADMIN_PIN_REQUIRED' };
    ensureShell();
    shellEl.classList.add('is-open');
    renderTab(tab || 'home');
    return { ok: true, code: controlStatus() };
  }

  /** New-group creation is deferred to the multi-community phase. */
  function openCreate() {
    return { ok: false, code: 'MULTI_COMMUNITY_DEFERRED' };
  }

  async function createGroupFromForm() {
    return { ok: false, code: 'MULTI_COMMUNITY_DEFERRED' };
  }

  function close() {
    if (!shellEl) return;
    shellEl.classList.remove('is-open');
  }

  function isOpen() {
    return !!(shellEl && shellEl.classList.contains('is-open'));
  }

  function stateFingerprint() {
    const f = FGA();
    const gid = f && f.FIRST_GROUP ? f.FIRST_GROUP.groupId : 'israel-network';
    const g = GCS();
    const c = f && f.verifiedControl ? f.verifiedControl() : null;
    const m = MS();
    const ev = m && m.exportMembershipEvents ? m.exportMembershipEvents(gid) : [];
    const n = App.FirstGroupNetworkAuthority;
    return [
      actor(),
      g && g.getStatus ? g.getStatus(gid) : '',
      c ? c.controlEpoch : '',
      ev.length,
      ev.length ? ev[ev.length - 1].id : '',
      n && n.isSynced() ? 'net' : 'nonet',
    ].join('|');
  }

  let chromeOwner = '';
  let renderedFingerprint = '';
  function ensureMenuEntry() {
    ensureStyles();
    if (chromeOwner !== actor()) {
      chromeOwner = actor();
      lastInvite = null;
      selectedMember = '';
      rolesTarget = '';
      window.__SOS_GAP_LOGO_DATA__ = '';
      if (isOpen()) close();
    }
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
    let more = document.getElementById('sosGroupAdminMoreItem');
    if (!more) {
      const drawer = document.querySelector('#moreOptionsPanel, .more-options, #moreMenu, [data-more-options]') || null;
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
    btn.classList.toggle('is-visible', showAdmin);
    btn.style.display = showAdmin ? 'inline-flex' : 'none';
    if (more) more.style.display = showAdmin ? '' : 'none';
    const showControl = canSeeGroupControl();
    let item = document.getElementById('sosGroupControlMenuItem');
    const menu = document.getElementById('topBarProfileMenu');
    if (!item && menu) {
      item = document.createElement('button');
      item.type = 'button';
      item.id = 'sosGroupControlMenuItem';
      item.className = 'top-bar__dropdown-item';
      item.innerHTML = '<i class="fa-solid fa-shield-halved"></i><span>שליטה על הקבוצה</span>';
      item.addEventListener('click', () => {
        menu.hidden = true;
        const pb = document.getElementById('topBarProfileButton');
        if (pb) pb.setAttribute('aria-expanded', 'false');
        open('home');
      });
      const invite = document.getElementById('topBarInviteFriend');
      if (invite && invite.parentNode) invite.parentNode.insertBefore(item, invite.nextSibling);
      else menu.appendChild(item);
    }
    if (item) {
      item.hidden = !showControl;
      item.style.display = showControl ? '' : 'none';
    }
    const createBtn = document.getElementById('sosGroupCreateMenuEntry');
    if (createBtn) createBtn.remove();
    const legacy = document.getElementById('sosAdminSettingsEntry');
    if (legacy) legacy.style.display = 'none';
    if ((!showControl || !pinUnlocked()) && isOpen()) close();
    else if (isOpen()) {
      const fp = stateFingerprint();
      if (fp === renderedFingerprint) return;
      const focused = document.activeElement;
      const editing = focused && shellEl.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName);
      if (!editing && !busy) renderTab(activeTab);
      else refreshChrome();
    }
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    ensureMenuEntry();
    window.addEventListener('sos-admin-pin-locked', () => {
      const body = document.getElementById('sosGapBody');
      if (body) body.innerHTML = '';
      close();
    });
    window.addEventListener('sos-identity-ready', ensureMenuEntry);
    window.addEventListener('sos-access-control-v2-local', ensureMenuEntry);
    window.addEventListener('sos-first-group-state-changed', ensureMenuEntry);
    setTimeout(ensureMenuEntry, 1200);
    setInterval(ensureMenuEntry, 15000);
  }

  const api = Object.freeze({
    TABS,
    LABELS,
    canSeeGroupAdminMenu,
    canSeeGroupControl,
    controlStatus,
    isActiveMember,
    tabAllowed,
    open,
    openCreate,
    close,
    isOpen,
    createGroupFromForm,
    ensureMenuEntry,
    renderTab,
    GROUP_ADMIN_MENU_LABEL: 'ניהול קבוצה',
    GROUP_CONTROL_MENU_LABEL: 'שליטה על הקבוצה',
    NEW_GROUP_CREATION: 'DEFERRED_TO_MULTI_COMMUNITY_PHASE',
  });

  App.GroupAdminProductUi = api;
  window.SosGroupAdminProductUi = api;

  window.addEventListener('sos-feature-flags-ready', boot);
  window.addEventListener('sos-access-control-v2-local', boot);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
