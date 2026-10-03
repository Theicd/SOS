/**
 * Group Admin Product UI — Package 897 first-group control center (Hebrew).
 * Visibility follows signed effective authority from FirstGroupAdmin; it is never authority itself.
 * Every action goes through the FirstGroupAdmin gateway (session + context + signed state + typed signer).
 * New-group creation / multi-community is deferred in this phase (not exposed).
 */
(function initGroupAdminProductUi(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  /** User-centric management: search a user, open the user panel, edit role + permissions, save. */
  const TABS = Object.freeze([
    { id: 'members', label: 'כל המשתמשים' },
    { id: 'admins', label: 'מנהלים' },
    { id: 'invites', label: 'הזמנות' },
    { id: 'reports', label: 'דיווחים' },
    { id: 'activity', label: 'פעילות ניהולית' },
  ]);
  // Older entry points (menu 'home', deep links) land on the matching new tab; group details live in advanced settings.
  const TAB_ALIASES = Object.freeze({ home: 'members', details: 'members', roles: 'members', settings: 'members', qr: 'invites', security: 'activity' });
  const EDITABLE_ROLES = Object.freeze(['MEMBER', 'INVITER', 'MODERATOR', 'ADMIN', 'SENIOR_ADMIN']);
  /** User-facing grouping only; the canonical capability set and its rules are unchanged. */
  const PRIMARY_CAPS = Object.freeze(['INVITE_USERS', 'MODERATE_CONTENT', 'MANAGE_MEMBERS', 'MANAGE_BLOCKLIST']);
  const CAP_HELP = Object.freeze({
    INVITE_USERS: 'מאפשר למשתמש ליצור הזמנות חדשות.',
    MODERATE_CONTENT: 'מאפשר להסיר פוסטים ותגובות של משתמשים אחרים.',
    MANAGE_MEMBERS: 'מאפשר להוסיף ולהסיר חברים קיימים מהקבוצה. לא מאפשר לשנות הרשאות.',
    MANAGE_BLOCKLIST: 'מאפשר לחסום ולשחרר חסימה של משתמשים בקבוצה.',
    MANAGE_ADMINS: 'מינוי והסרה של מנהלים.',
    MANAGE_PERMISSIONS: 'שינוי הרשאות של חברים.',
    MANAGE_GROUP_SETTINGS: 'שינוי שם, תיאור ולוגו של הקבוצה.',
    MANAGE_INVITES: 'יצירה וביטול של כל ההזמנות ושינוי מדיניות ההזמנות.',
    VIEW_AUDIT_LOG: 'צפייה ביומן הפעולות הניהוליות.',
  });
  const INACTIVE_STATUS_TEXT = 'מערכת הניהול עדיין לא הופעלה. ניתן לצפות ולהכין הרשאות, אך לא לשמור שינויים.';
  const SAVE_AFTER_ACTIVATION_TEXT = 'ניתן לשמור לאחר הפעלת מערכת הניהול';
  const ADMISSION_EXPLAIN_TEXT = 'שירות הקבלה יקבל הרשאה מוגבלת לצירוף חברים שהשתמשו בהזמנה בלבד.';
  const ACTIVE_WRITES_OFF_TEXT = 'מערכת הניהול הופעלה. שמירת שינויים תיפתח בשלב הבא.';
  const NO_DATA_TEXT = 'עדיין אין נתונים';

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
  let activeTab = 'members';
  let selectedMember = '';
  let draftCaps = null;
  let advancedCapsOpen = false;
  let lastInvite = null;
  let busy = false;
  let searchQuery = '';
  let searchSeq = 0;
  let searchTimer = null;
  let advancedOpen = false;
  let controlProbe = null;
  let probeBusy = false;
  let userContent = [];
  const profiles = new Map();

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

  /** V2 off: read-only relay probe of the control chain for the root, used by the status line and Gate 1.5. */
  function refreshControlProbe() {
    const f = FGA();
    if (isV2() || probeBusy || !f || typeof f.probeNetworkControl !== 'function' || !f.isConfiguredRoot(actor())) return;
    probeBusy = true;
    const who = actor();
    f.probeNetworkControl()
      .then((r) => {
        if (actor() === who) controlProbe = r;
      })
      .catch(() => {})
      .then(() => {
        probeBusy = false;
        if (isOpen() && actor() === who) renderTab(activeTab);
      });
  }

  function controlActiveWritesOff() {
    return !isV2() && !!controlProbe && controlProbe.status === 'VERIFIED';
  }

  function canActivateControl() {
    const f = FGA();
    const p = controlProbe;
    return !isV2() && !!p && p.ok === true && p.controlEvents === 0 && p.relaysOk >= 2 && !!f && f.isConfiguredRoot(actor());
  }

  /** Gate 2: chain verified from relays, no admission delegation yet, root only, V2 off. */
  function canActivateAdmission() {
    const f = FGA();
    const p = controlProbe;
    return (
      !isV2() &&
      !!p &&
      p.ok === true &&
      p.status === 'VERIFIED' &&
      p.relaysOk >= 2 &&
      Array.isArray(p.admissionDelegates) &&
      p.admissionDelegates.length === 0 &&
      Array.isArray(p.admissionServiceCaps) &&
      p.admissionServiceCaps.length === 0 &&
      !!f &&
      typeof f.activateAdmissionService === 'function' &&
      f.isConfiguredRoot(actor())
    );
  }

  function admissionServiceActive() {
    const p = controlProbe;
    return !!p && p.status === 'VERIFIED' && Array.isArray(p.admissionServiceCaps) && p.admissionServiceCaps.indexOf('FINALIZE_MEMBERSHIP_ADMISSION') !== -1;
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

  function canSeeModerationOnly() {
    const f = FGA();
    return !!f && typeof f.canSeeModeration === 'function' && f.canSeeModeration() === true;
  }

  /** Content moderators without group control: a separate "דיווחים" entry (reports + user content only). */
  function canSeeReportsEntry() {
    if (!isV2() || App.guestMode || !actor()) return false;
    return !canSeeGroupAdminMenu() && canSeeModerationOnly();
  }

  let reportsOnly = false;

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

  /** Every panel open and action needs a server admin session; only root / admin-tier principals can see the panel. */
  function adminSession() {
    const p = PIN();
    return p ? p.requestUnlock() : Promise.resolve({ ok: false });
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

  /** V2 off: every tab is read-only navigation for the root. V2 on: tabs follow signed authority. */
  function tabAllowed(tabId, s) {
    const id = TAB_ALIASES[tabId] || tabId;
    if (!isV2()) return id !== 'reports' && TABS.some((t) => t.id === id);
    const v = s || sections();
    const f = FGA();
    if (reportsOnly) return id === 'reports' && !!v.reports;
    if (id === 'members') return !!f && (f.canSeeAdminMenu() || needsBootstrap());
    if (id === 'admins') return !!v.admins;
    if (id === 'invites') return !!v.invites || !!v.createInvite;
    if (id === 'reports') return !!v.reports;
    if (id === 'activity') return !!v.security;
    return false;
  }

  function firstAllowedTab(s) {
    const t = TABS.find((x) => tabAllowed(x.id, s));
    return t ? t.id : 'members';
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
      '#sosGroupAdminShell .gap-caps label.gap-cap{align-items:flex-start;}' +
      '#sosGroupAdminShell .gap-cap-help{display:block;margin-top:2px;font-weight:normal;}' +
      '#sosGroupAdminShell .gap-caps-advanced{grid-column:1/-1;display:grid;gap:6px;margin-top:6px;}' +
      '#sosGroupAdminShell .gap-caps-advanced summary{cursor:pointer;padding:6px 2px;opacity:.85;}' +
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
      '#sosGroupAdminShell .gap-top{padding:10px 16px 4px;display:flex;flex-direction:column;gap:8px;}' +
      '#sosGroupAdminShell .gap-status{font-size:.86rem;line-height:1.4;background:#1d2332;border-radius:10px;padding:8px 10px;}' +
      '#sosGroupAdminShell .gap-status.inactive{background:#2a2518;color:#ffe3a3;}' +
      '#sosGroupAdminShell .gap-summary{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.85rem;opacity:.9;}' +
      '#sosGroupAdminShell .gap-summary b{font-weight:600;}' +
      '#sosGroupAdminShell .gap-search label{font-weight:600;font-size:.9rem;}' +
      '#sosGroupAdminShell .gap-search input{width:100%;box-sizing:border-box;font-size:1rem;padding:11px 14px;border-radius:12px;margin-top:4px;}' +
      '#sosGroupAdminShell .gap-results{display:flex;flex-direction:column;gap:6px;max-height:34vh;overflow:auto;}' +
      '#sosGroupAdminShell .gap-user{flex-wrap:nowrap;cursor:pointer;}' +
      '#sosGroupAdminShell .gap-user:hover,#sosGroupAdminShell .gap-user:focus{background:#222a3a;outline:none;}' +
      '#sosGroupAdminShell .gap-user-main{flex:1;min-width:0;}' +
      '#sosGroupAdminShell .gap-user-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '#sosGroupAdminShell .gap-avatar{flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:#2d3550;display:inline-flex;align-items:center;justify-content:center;font-weight:700;overflow:hidden;}' +
      '#sosGroupAdminShell .gap-avatar img{width:100%;height:100%;object-fit:cover;}' +
      '#sosGroupAdminShell .gap-avatar.lg{width:64px;height:64px;font-size:1.4rem;}' +
      '#sosGroupAdminShell .gap-chip{font-size:.75rem;background:#243049;border-radius:999px;padding:3px 9px;white-space:nowrap;}' +
      '#sosGroupAdminShell .gap-chip.root{background:#5a4412;color:#ffe3a3;}' +
      '#sosGroupAdminShell .gap-note{font-size:.84rem;opacity:.8;margin:8px 0;}' +
      '#sosGroupAdminShell details.gap-adv{margin-top:18px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px;}' +
      '#sosGroupAdminShell details.gap-adv summary{cursor:pointer;font-weight:600;}' +
      '#sosGroupAdminShell .gap-ref{margin:6px 0;padding-inline-start:18px;font-size:.82rem;}' +
      '#sosGapMemberDetail{position:absolute;inset:0;z-index:3;display:flex;justify-content:flex-start;background:rgba(0,0,0,.45);}' +
      '#sosGapMemberDetail .gap-drawer{width:min(440px,100%);height:100%;background:#161a23;display:flex;flex-direction:column;box-shadow:0 0 24px rgba(0,0,0,.5);}' +
      '#sosGapMemberDetail .gap-drawer-body{padding:14px 16px;overflow:auto;flex:1;}' +
      '#sosGapMemberDetail .gap-drawer-foot{padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,.08);}' +
      '#sosGapMemberDetail .gap-who{display:flex;gap:12px;align-items:center;margin-bottom:10px;}' +
      '#sosGapMemberDetail h3{font-size:.95rem;margin:14px 0 6px;}' +
      '#sosGapRoleOptions{display:flex;flex-wrap:wrap;gap:6px;}' +
      '#sosGapRoleOptions button{border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:6px 12px;background:#1b1e27;color:#fff;cursor:pointer;font-size:.85rem;}' +
      '#sosGapRoleOptions button.active{background:#3d7eff;border-color:#3d7eff;}' +
      '#sosGapRoleOptions button[disabled]{opacity:.45;cursor:not-allowed;}' +
      '#sosGapMemberDetail .gap-caps{grid-template-columns:1fr;}' +
      '@media (max-width:640px){#sosGroupAdminShell .gap-panel{width:100vw;max-height:100vh;height:100vh;border-radius:0;}' +
      '#sosGroupAdminShell .gap-tabs{flex-wrap:nowrap;overflow-x:auto;}' +
      '#sosGroupAdminShell .gap-tabs button{flex:0 0 auto;}' +
      '#sosGroupAdminShell .gap-item:not(.gap-user){flex-direction:column;align-items:stretch;}' +
      '#sosGapMemberDetail .gap-drawer{width:100%;}' +
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
    ALREADY_BOOTSTRAPPED: 'מערכת הניהול כבר הופעלה',
    DELEGATION_EXISTS: 'שירות קבלת החברים כבר הופעל',
    DELEGATION_NOT_ACTIVE: 'שירות קבלת החברים אינו פעיל',
    DELEGATE_HAS_OTHER_CAPABILITIES: 'למפתח השירות יש כבר הרשאות אחרות. הפעולה נעצרה.',
    ADMISSION_SERVICE_NOT_CONFIGURED: 'שירות הקבלה אינו מוגדר',
    ADMISSION_SERVICE_CONTROL_MISMATCH: 'שירות הקבלה עדיין לא רואה את מצב הניהול העדכני. נסו שוב בעוד דקה.',
    ADMISSION_SERVICE_KEY_MISMATCH: 'מפתח שירות הקבלה אינו תואם. הפעולה נעצרה.',
    NETWORK_AUTHORITY_UNVERIFIED: 'אין חיבור מספיק לשרתי הרשת. נסו שוב בעוד רגע.',
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
    CONTROL_PLANE_NOT_ACTIVE: SAVE_AFTER_ACTIVATION_TEXT,
    V2_REQUIRED: SAVE_AFTER_ACTIVATION_TEXT,
    TARGET_NOT_MEMBER: 'המשתמש עדיין לא חבר בקבוצה',
    ADMIN_PIN_REQUIRED: 'נדרש קוד מנהל',
    ADMIN_2FA_SERVICE_UNAVAILABLE: 'שירות אימות המנהל אינו זמין כרגע',
    ADMIN_SESSION_EXPIRED: 'פג תוקף אימות המנהל. הזינו שוב את קוד המנהל',
    ADMIN_STEP_UP_CANCELLED: 'פעולה רגישה דורשת הזנה חוזרת של קוד המנהל',
    ADMIN_STEP_UP_REQUIRED: 'פעולה רגישה דורשת הזנה חוזרת של קוד המנהל',
    ADMIN_2FA_DENIED: 'שרת אימות המנהל לא אישר את הפעולה',
    ALREADY_BLOCKED: 'המשתמש כבר חסום',
    ALREADY_MEMBER: 'המשתמש כבר חבר בקבוצה',
    TARGET_BLOCKED: 'המשתמש חסום. הסירו את החסימה לפני הוספה',
    TARGET_NOT_ADDABLE: 'אי אפשר להוסיף את המשתמש כרגע',
    NOT_DEFAULT_COMMUNITY: 'פעולה זו זמינה בקבוצה הראשית בלבד',
    NOTHING_TO_RECONCILE: 'אין משתמשים להשלמת חברות',
    RECONCILE_PARTIAL: 'השלמת החברות הושלמה חלקית. נסו שוב כדי להשלים',
    NOT_KNOWN_SOS_ACCOUNT: 'זה אינו חשבון SOS מוכר. מצטרפים לקבוצה רק דרך הזמנה.',
    TARGET_REMOVED: 'המשתמש הוסר מהקבוצה ולא יצורף מחדש אוטומטית',
    MEMBERSHIP_PENDING_READBACK: 'הצירוף נשלח וממתין לאישור הרשת. נסו לשמור את ההרשאות שוב בעוד רגע.',
    RELAY_QUERY_FAILED: 'אין חיבור לשרתי הרשת. נסו שוב בעוד רגע.',
    NO_MEMBER_OPS: 'מודול ניהול החברים לא נטען',
    NOT_BLOCKED: 'המשתמש אינו חסום',
    TARGET_NOT_BLOCKED: 'המשתמש אינו חסום',
    SELF_TARGET_FORBIDDEN: 'אי אפשר לבצע פעולה זו על עצמכם',
    SELF_UNBLOCK: 'אי אפשר לבצע פעולה זו על עצמכם',
    PARTIAL_BLOCK: 'החסימה הושלמה חלקית. נסו שוב כדי להשלים',
    PARTIAL_UNBLOCK: 'הסרת החסימה הושלמה חלקית. נסו שוב כדי להשלים',
    NO_MODERATORS: 'אין מנהלי תוכן זמינים',
    PIN_WRONG: 'קוד שגוי',
    PIN_LOCKED: 'יותר מדי ניסיונות. נסו שוב מאוחר יותר',
  };

  /** Short status line when the panel itself is not open (e.g. the admin service is unavailable). */
  function notice(text) {
    try {
      let el = document.getElementById('sosGapNotice');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sosGapNotice';
        el.setAttribute('role', 'status');
        el.style.cssText =
          'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:12300;background:#2a1d1d;color:#ffd7d7;padding:10px 14px;border-radius:10px;direction:rtl;font-size:.95rem;';
        document.body.appendChild(el);
      }
      el.textContent = text;
      clearTimeout(notice.timer);
      notice.timer = setTimeout(() => el.remove(), 5000);
    } catch (_e) {}
  }

  function errText(res) {
    const code = (res && res.code) || 'ERROR';
    return ERROR_TEXT[code] || 'הפעולה נכשלה (' + code + ')';
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
    const unlocked = await adminSession();
    if (!unlocked.ok) {
      const code = unlocked.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' ? unlocked.code : 'ADMIN_PIN_REQUIRED';
      setMsg(errText({ code }), 'err');
      return { ok: false, code };
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
    const p = PIN();
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

  function unresolvedReports() {
    const R = App.GroupReports || window.SosGroupReports;
    if (!R || !R.canModerateReports()) return 0;
    const snap = R.snapshot();
    return snap && snap.ok ? snap.unresolved : 0;
  }

  /** Unresolved-report count on the "שליטה על הקבוצה" menu item (existing in-app surface, no push). */
  function refreshReportBadge() {
    const control = document.getElementById('sosGroupControlMenuItem');
    const reports = document.getElementById('sosGroupReportsMenuItem');
    const other = control && !control.hidden ? reports : control;
    const stale = other && other.querySelector('.sos-report-badge');
    if (stale) stale.remove();
    const item = control && !control.hidden ? control : reports && !reports.hidden ? reports : null;
    if (!item) return;
    const n = unresolvedReports();
    let badge = item.querySelector('.sos-report-badge');
    if (!n) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sos-report-badge';
      badge.setAttribute('aria-label', 'דיווחים פתוחים');
      badge.style.cssText = 'margin-inline-start:auto;background:#d93838;color:#fff;border-radius:999px;padding:1px 7px;font-size:.75rem;font-weight:700;';
      item.appendChild(badge);
    }
    badge.textContent = String(n);
  }

  function refreshChrome() {
    if (!shellEl) return;
    const f = FGA();
    const info = groupInfo();
    const title = shellEl.querySelector('#sosGapTitle');
    if (title) title.textContent = reportsOnly ? 'דיווחים' : 'ניהול הקבוצה';
    const logo = shellEl.querySelector('#sosGapLogo');
    const src = safeLogoSrc(info.logoRef);
    if (logo) {
      logo.style.display = src ? '' : 'none';
      if (src) logo.src = src;
    }
    const role = shellEl.querySelector('#sosGapRole');
    if (role) {
      if (!isV2()) role.textContent = f.roleLabel('ROOT');
      else {
        const a = f.myAuthority();
        role.textContent = a.verified ? f.roleLabel(a.role) : 'לא מאומת';
      }
    }
    const s = isV2() ? sections() : null;
    const unresolved = unresolvedReports();
    shellEl.querySelectorAll('#sosGapTabs button').forEach((b) => {
      if (b.dataset.tab === 'reports') b.textContent = 'דיווחים' + (unresolved ? ' (' + unresolved + ')' : '');
      const allowed = tabAllowed(b.dataset.tab, s);
      b.hidden = !allowed;
      b.style.display = allowed ? '' : 'none';
      b.classList.toggle('active', b.dataset.tab === activeTab);
      b.setAttribute('aria-selected', b.dataset.tab === activeTab ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------- users (profiles come from the shared profile cache)

  const USER_STATUS = Object.freeze({
    ROOT: 'בעלים של הקבוצה',
    ACTIVE: 'חבר פעיל',
    LEGACY: 'חשבון ותיק',
    REMOVED: 'הוסר',
    BLOCKED: 'חסום',
    CONFLICT: 'בבדיקה',
  });

  const DIR_FILTERS = Object.freeze([
    { id: 'ALL', label: 'הכל' },
    { id: 'ACTIVE', label: 'חברים פעילים' },
    { id: 'LEGACY', label: 'חשבונות ותיקים' },
    { id: 'BLOCKED', label: 'חסומים' },
    { id: 'REMOVED', label: 'הוסרו' },
  ]);
  const DIR_MAX_ROWS = 300;
  let knownUsers = null;
  let knownUsersLoading = false;
  let knownUsersError = '';
  let dirFilter = 'ALL';
  let dirQuery = '';
  let knownUsersGen = 0;
  const knownExtra = new Set();

  const ACTION_LABELS = Object.freeze({
    BOOTSTRAP: 'הפעלת ניהול',
    GRANT_CAPABILITY: 'הענקת הרשאה',
    REVOKE_CAPABILITY: 'הסרת הרשאה',
    SET_INVITE_POLICY: 'שינוי מדיניות הזמנות',
    SET_GROUP_METADATA: 'עריכת פרטי הקבוצה',
    BLOCKLIST_CHANGED: 'שינוי רשימת חסימה',
    MEMBER_ACTIVE: 'חבר צורף',
    MEMBER_REMOVED: 'חבר הוסר',
    MEMBER_BLOCKED: 'חבר נחסם',
    MEMBER_UNBLOCKED: 'חסימה הוסרה',
    CONTENT_REMOVED: 'הסרת תוכן של משתמש אחר',
    REPORT_RESOLVED: 'דיווח טופל',
    REPORT_REJECTED: 'דיווח נדחה',
  });
  const BLOCKLIST_DETAIL = Object.freeze({ ADDED: 'חסימה', REMOVED: 'הסרת חסימה' });

  function configuredRoot() {
    const g = GCS();
    const roots = g && typeof g.configuredRootPubkeys === 'function' ? g.configuredRootPubkeys() : [];
    const r = String(roots[0] || '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(r) ? r : '';
  }

  /** A pasted hex public key or npub selects that user directly. */
  function queryPubkey(q) {
    const t = String(q || '').trim();
    if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
    if (/^npub1[02-9ac-hj-np-z]{20,}$/i.test(t)) {
      try {
        const nip19 = window.NostrTools && window.NostrTools.nip19;
        const d = nip19 ? nip19.decode(t) : null;
        if (d && d.type === 'npub' && /^[0-9a-f]{64}$/.test(String(d.data))) return String(d.data);
      } catch (_e) {}
    }
    return '';
  }

  function avatarSrc(v) {
    const s = typeof App.safeProfilePictureUrl === 'function' ? App.safeProfilePictureUrl(String(v || '')) : String(v || '');
    return safeLogoSrc(s);
  }

  /** Name + picture from the shared profile resolver (App.fetchProfile / App.profileCache, newest kind 0 wins). */
  function profileOf(pk, row) {
    const r = row || {};
    const p = profiles.get(pk) || {};
    const c = App.profileCache instanceof Map ? App.profileCache.get(pk) : null;
    // follow-service caches a placeholder name ("משתמש <8 hex>") until the real kind-0 profile arrives.
    const real = (n) => {
      const s = String(n || '').trim();
      return s && s !== 'משתמש ' + String(pk).slice(0, 8) && s !== 'משתמש אנונימי' ? s : '';
    };
    return {
      name: real(p.name) || real(c && (c.name || c.display_name)) || String(r.displayName || '').trim(),
      picture: avatarSrc(p.picture) || avatarSrc(c && c.picture) || avatarSrc(r.avatar),
    };
  }

  const PROFILE_RECHECK_MS = 60000;
  function ensureProfile(pk) {
    if (!/^[0-9a-f]{64}$/.test(pk) || typeof App.fetchProfile !== 'function') return;
    const prev = profiles.get(pk);
    if (prev && Date.now() - (prev.at || 0) < PROFILE_RECHECK_MS) return;
    profiles.set(pk, Object.assign({}, prev, { at: Date.now() }));
    Promise.resolve()
      .then(() => App.fetchProfile(pk))
      .then((p) => {
        if (!p) return;
        profiles.set(pk, { name: String(p.name || p.display_name || ''), picture: String(p.picture || ''), at: Date.now() });
        refreshProfileNodes(pk);
      })
      .catch(() => {});
  }

  function displayName(pk, prof) {
    if (prof && prof.name) return prof.name;
    return pk && pk === configuredRoot() ? 'המנהל הראשי' : 'משתמש ללא שם';
  }

  function avatarHtml(pk, prof, large) {
    const initial = escapeHtml(((prof && prof.name) || '').trim().charAt(0) || '?');
    return (
      '<span class="gap-avatar' + (large ? ' lg' : '') + '" data-avatar-pk="' + escapeHtml(pk) + '" data-initial="' + initial + '" aria-hidden="true">' +
      (prof && prof.picture ? '<img alt="" loading="lazy" referrerpolicy="no-referrer" src="' + escapeHtml(prof.picture) + '">' : initial) +
      '</span>'
    );
  }

  /** A picture that fails to load falls back to the initial (display only; the profile itself is never changed). */
  function onAvatarError(e) {
    const img = e && e.target;
    if (!img || img.tagName !== 'IMG') return;
    const span = img.parentElement;
    if (!span || !span.classList || !span.classList.contains('gap-avatar')) return;
    span.setAttribute('data-avatar-fallback', '1');
    span.textContent = span.getAttribute('data-initial') || '?';
  }

  function refreshProfileNodes(pk) {
    if (!shellEl || !/^[0-9a-f]{64}$/.test(pk)) return;
    const prof = profileOf(pk);
    shellEl.querySelectorAll('[data-name-pk="' + pk + '"]').forEach((el) => {
      el.textContent = displayName(pk, prof);
    });
    shellEl.querySelectorAll('[data-avatar-pk="' + pk + '"]').forEach((el) => {
      el.outerHTML = avatarHtml(pk, prof, el.classList.contains('lg'));
    });
  }

  /** Role + status of any user from signed state (V2 on) or the configured root only (V2 off). */
  function knownRow(pk) {
    return knownUsers ? knownUsers.byPk.get(pk) || null : null;
  }

  /** Status in the selected community: signed membership first, then blocklist, then "known SOS account". */
  function userView(pk, rowIn) {
    const f = FGA();
    const isRoot = !!pk && pk === configuredRoot();
    const canon = rowIn || (isV2() ? f.directory('').find((r) => r.pubkey === pk) : null);
    const known = knownRow(pk);
    const a = f.authorityFor(pk);
    const canonStatus = canon ? canon.status : a.membership;
    let status = isRoot ? 'ROOT' : canonStatus;
    if (!isRoot && isV2() && status !== 'ACTIVE' && status !== 'REMOVED' && typeof f.blockStateOf === 'function' && f.blockStateOf(pk) !== 'NONE') {
      status = 'BLOCKED';
    } else if (!isRoot && isV2() && status === 'UNKNOWN' && (known || knownExtra.has(pk))) {
      status = 'LEGACY';
    }
    const row = {
      displayName: (canon && canon.displayName) || (known && known.displayName) || '',
      avatar: (canon && canon.avatar) || (known && known.avatar) || '',
    };
    const role = isRoot ? 'ROOT' : a.role;
    return {
      pubkey: pk,
      isRoot,
      role,
      roleLabel: f.roleLabel(role),
      assigned: isRoot ? [] : a.assigned.slice(),
      status,
      canonStatus,
      statusLabel: USER_STATUS[status] || (isV2() ? 'לא חבר בקבוצה' : 'עדיין אין נתוני חברות'),
      member: isRoot || status === 'ACTIVE',
      profile: profileOf(pk, row),
      lastActiveAt: (known && known.lastActiveAt) || 0,
    };
  }

  function byName(a, b) {
    return displayName(a.pubkey, a.profile).localeCompare(displayName(b.pubkey, b.profile), 'he');
  }

  function userRowHtml(u, opts) {
    const o = opts || {};
    ensureProfile(u.pubkey);
    const chip = u.isRoot
      ? '<span class="gap-chip root">' + escapeHtml(u.roleLabel) + '</span><span class="gap-sub">מוגן</span>'
      : '<span class="gap-chip">' + escapeHtml(u.member ? u.roleLabel : u.statusLabel) + '</span>';
    return (
      '<div class="gap-item gap-user' + (u.pubkey === selectedMember ? ' sel' : '') + '"' +
      (o.rootCard ? ' id="sosGapRootCard" data-root="1"' : '') +
      (o.admin ? ' data-admin="' + escapeHtml(u.pubkey) + '"' : '') +
      ' data-act="select-member" data-pk="' + escapeHtml(u.pubkey) + '" role="button" tabindex="0">' +
      avatarHtml(u.pubkey, u.profile) +
      '<div class="gap-user-main"><div class="gap-user-name" data-name-pk="' + escapeHtml(u.pubkey) + '">' +
      escapeHtml(displayName(u.pubkey, u.profile)) + '</div>' +
      '<div class="gap-sub gap-mono">' + escapeHtml(shortPk(u.pubkey)) + '</div></div>' +
      chip +
      (o.extra || '') +
      '<button type="button" class="gap-btn" tabindex="-1">ניהול</button></div>'
    );
  }

  // ---------------------------------------------------------------- top: status, summary, search

  function summaryCounts() {
    const f = FGA();
    if (!isV2()) return { members: null, admins: configuredRoot() ? 1 : null, invites: null };
    const dir = f.directory('');
    const active = dir.filter((r) => r.status === 'ACTIVE').length;
    const invites = f.listMyInvites().filter((r) => r.status === 'ACTIVE').length;
    return { members: active || null, admins: f.admins().length || null, invites };
  }

  function renderTop() {
    const top = document.getElementById('sosGapTop');
    if (!top) return;
    if (!document.getElementById('sosGapUserSearch')) {
      top.innerHTML =
        '<div class="gap-status" id="sosGapControlStatus" role="status"></div>' +
        '<div class="gap-summary" id="sosGapSummary"></div>' +
        '<div class="gap-search"><label for="sosGapUserSearch">חיפוש משתמש</label>' +
        '<input id="sosGapUserSearch" type="search" autocomplete="off" maxlength="120" placeholder="חפש לפי שם או מזהה משתמש"></div>' +
        '<div class="gap-results" id="sosGapSearchResults" aria-live="polite"></div>';
      const input = document.getElementById('sosGapUserSearch');
      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => doSearch(input.value), 300);
      });
    }
    const st = document.getElementById('sosGapControlStatus');
    const activeWritesOff = controlActiveWritesOff();
    st.setAttribute('data-status', activeWritesOff ? 'CONTROL_ACTIVE_WRITES_OFF' : controlStatus());
    st.className = 'gap-status' + (isV2() || activeWritesOff ? '' : ' inactive');
    if (!isV2()) st.textContent = activeWritesOff ? ACTIVE_WRITES_OFF_TEXT : INACTIVE_STATUS_TEXT;
    else if (needsBootstrap()) {
      st.innerHTML =
        'ניהול הקבוצה עדיין לא הופעל. אתם המנהל הראשי המוגדר. ' +
        '<button type="button" class="gap-btn primary" data-act="bootstrap" data-mutation="1">הפעלת ניהול הקבוצה</button>';
    } else st.textContent = 'מערכת הניהול פעילה. כל שינוי נשמר בחתימה ומאושר בקוד מנהל.';
    const c = summaryCounts();
    const metric = (label, id, v) => '<span>' + label + ': <b id="' + id + '">' + escapeHtml(v == null ? NO_DATA_TEXT : String(v)) + '</b></span>';
    document.getElementById('sosGapSummary').innerHTML =
      metric('חברים', 'sosGapMemberCount', c.members) + metric('מנהלים', 'sosGapAdminCount', c.admins) + metric('הזמנות פעילות', 'sosGapInviteCount', c.invites);
  }

  function localMatches(q) {
    const f = FGA();
    const out = [];
    const seen = new Set();
    const push = (u) => {
      if (!u || !u.pubkey || seen.has(u.pubkey)) return;
      seen.add(u.pubkey);
      out.push(u);
    };
    const direct = queryPubkey(q);
    if (direct) push(userView(direct));
    const lq = q.toLowerCase();
    const root = configuredRoot();
    if (root) {
      const ru = userView(root);
      if (root.indexOf(lq) !== -1 || displayName(root, ru.profile).toLowerCase().indexOf(lq) !== -1) push(ru);
    }
    if (isV2()) f.directory(q).forEach((r) => push(userView(r.pubkey, r)));
    return { out, push };
  }

  /** Same discovery as the chat "new conversation" search (profile cache + relay profile search). */
  async function doSearch(raw) {
    const seq = ++searchSeq;
    searchQuery = String(raw || '').trim().slice(0, 120);
    const box0 = document.getElementById('sosGapSearchResults');
    if (!box0) return;
    if (!searchQuery) {
      box0.innerHTML = '';
      return;
    }
    const m = localMatches(searchQuery);
    box0.innerHTML = m.out.map((u) => userRowHtml(u)).join('') + '<div class="gap-sub">מחפש…</div>';
    let remote = [];
    if (searchQuery.length >= 2 && typeof App.searchProfilesByName === 'function') {
      try {
        remote = (await App.searchProfilesByName(searchQuery, { limit: 20 })) || [];
      } catch (_e) {
        remote = [];
      }
    }
    const box = document.getElementById('sosGapSearchResults');
    if (seq !== searchSeq || !box) return;
    remote.forEach((p) => {
      const pk = String((p && p.pubkey) || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pk)) return;
      if (!(profiles.get(pk) || {}).name) profiles.set(pk, { name: String(p.name || ''), picture: String(p.picture || '') });
      m.push(userView(pk));
    });
    box.innerHTML = m.out.map((u) => userRowHtml(u)).join('') || '<div class="gap-sub">לא נמצאו משתמשים</div>';
  }

  // ---------------------------------------------------------------- tabs

  function renderMembers(body) {
    const f = FGA();
    const root = configuredRoot();
    if (!isV2()) {
      body.innerHTML =
        '<div class="gap-list" id="sosGapMemberList">' + (root ? userRowHtml(userView(root), { rootCard: true }) : '') + '</div>' +
        '<p class="gap-note">רשימת החברים המלאה תוצג לאחר הפעלת מערכת הניהול. בינתיים אפשר לחפש כל משתמש בשדה החיפוש ולפתוח את כרטיס הניהול שלו.</p>';
      return;
    }
    const s = sections();
    if (!knownUsers && !knownUsersLoading && !knownUsersError) loadKnownUsers();
    let html =
      '<div class="gap-dir-filters" id="sosGapDirFilters" role="group" aria-label="סינון משתמשים">' +
      DIR_FILTERS.map((x) =>
        '<button type="button" class="gap-btn' + (x.id === dirFilter ? ' primary' : '') + '" data-act="dir-filter" data-filter="' + x.id + '" aria-pressed="' + (x.id === dirFilter) + '">' + escapeHtml(x.label) + '</button>'
      ).join('') +
      '<button type="button" class="gap-btn" id="sosGapDirRefresh" data-act="dir-refresh">רענון</button>' +
      '</div>' +
      '<div class="gap-search"><label for="sosGapDirSearch">חיפוש ברשימה</label>' +
      '<input id="sosGapDirSearch" type="search" autocomplete="off" maxlength="120" placeholder="שם או מזהה משתמש"></div>' +
      '<div class="gap-sub" id="sosGapDirCount" aria-live="polite"></div>' +
      '<div class="gap-list" id="sosGapMemberList"></div>';
    if (s.removeMembers) {
      html +=
        '<h3 style="margin-top:16px">הצטרפויות ממתינות</h3>' +
        '<p class="gap-note">ההצטרפות מאושרת אוטומטית. משתמש שהצטרפותו הושלמה יופיע ברשימת החברים.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn" data-act="load-joins">רענון בקשות</button></div>' +
        '<div class="gap-list" id="sosGapJoinList"></div>';
    }
    body.innerHTML = html;
    const input = document.getElementById('sosGapDirSearch');
    input.value = dirQuery;
    input.addEventListener('input', () => {
      dirQuery = String(input.value || '').trim().slice(0, 120);
      renderDirList();
    });
    renderDirList();
  }

  const registrationLookups = new Set();
  const knownChecked = new Set();

  function formatActivity(ts) {
    if (!ts) return '';
    try {
      return 'פעילות אחרונה: ' + new Date(ts * 1000).toLocaleDateString('he-IL');
    } catch (_e) {
      return '';
    }
  }

  function dirRowHtml(u) {
    ensureProfile(u.pubkey);
    const badge = '<span class="gap-chip' + (u.isRoot ? ' root' : '') + '" data-status="' + escapeHtml(u.status) + '">' + escapeHtml(u.statusLabel) + '</span>';
    const roleChip = u.member && !u.isRoot && u.role !== 'MEMBER' ? '<span class="gap-chip">' + escapeHtml(u.roleLabel) + '</span>' : '';
    const act = formatActivity(u.lastActiveAt);
    return (
      '<div class="gap-item gap-user' + (u.pubkey === selectedMember ? ' sel' : '') + '"' +
      (u.isRoot ? ' id="sosGapRootCard" data-root="1"' : '') +
      ' data-dir-pk="' + escapeHtml(u.pubkey) + '" data-dir-status="' + escapeHtml(u.status) + '"' +
      ' data-act="select-member" data-pk="' + escapeHtml(u.pubkey) + '" role="button" tabindex="0">' +
      avatarHtml(u.pubkey, u.profile) +
      '<div class="gap-user-main"><div class="gap-user-name" data-name-pk="' + escapeHtml(u.pubkey) + '">' +
      escapeHtml(displayName(u.pubkey, u.profile)) + '</div>' +
      '<div class="gap-sub gap-mono">' + escapeHtml(shortPk(u.pubkey)) + '</div>' +
      (act ? '<div class="gap-sub gap-dir-activity">' + escapeHtml(act) + '</div>' : '') +
      '</div>' + badge + roleChip +
      '<button type="button" class="gap-btn" tabindex="-1">ניהול</button></div>'
    );
  }

  function dirFilterMatch(u) {
    if (dirFilter === 'ALL') return true;
    if (dirFilter === 'ACTIVE') return u.member;
    return u.status === dirFilter;
  }

  function dirQueryMatch(u) {
    if (!dirQuery) return true;
    const direct = queryPubkey(dirQuery);
    if (direct) return u.pubkey === direct;
    const q = dirQuery.toLowerCase();
    return u.pubkey.indexOf(q) !== -1 || displayName(u.pubkey, u.profile).toLowerCase().indexOf(q) !== -1;
  }

  /** Every identity known to SOS (global), with status in the selected community. */
  function renderDirList() {
    const list = document.getElementById('sosGapMemberList');
    const count = document.getElementById('sosGapDirCount');
    if (!list) return;
    const f = FGA();
    const root = configuredRoot();
    const canon = new Map(f.directory('').map((r) => [r.pubkey, r]));
    const pks = new Set(canon.keys());
    if (knownUsers) knownUsers.rows.forEach((r) => pks.add(r.pubkey));
    if (root) pks.add(root);
    const all = Array.from(pks).map((pk) => userView(pk, canon.get(pk) || null));
    const shown = all
      .filter((u) => dirFilterMatch(u) && dirQueryMatch(u))
      .sort((a, b) => (b.isRoot ? 1 : 0) - (a.isRoot ? 1 : 0) || (b.lastActiveAt || 0) - (a.lastActiveAt || 0) || byName(a, b));
    list.innerHTML = shown.slice(0, DIR_MAX_ROWS).map(dirRowHtml).join('') || '<div class="gap-sub">לא נמצאו משתמשים</div>';
    if (count) {
      let txt = shown.length + ' מתוך ' + all.length + ' משתמשים';
      if (shown.length > DIR_MAX_ROWS) txt += ' (מוצגים ' + DIR_MAX_ROWS + ' ראשונים – אפשר לחפש)';
      if (knownUsersLoading) txt += ' · טוען משתמשים…';
      else if (knownUsersError) txt += ' · ' + errText({ code: knownUsersError });
      count.textContent = txt;
      count.setAttribute('data-total', String(all.length));
      count.setAttribute('data-shown', String(shown.length));
      count.setAttribute('data-loaded', knownUsers ? '1' : '0');
    }
  }

  async function loadKnownUsers() {
    const gen = knownUsersGen;
    knownUsersLoading = true;
    knownUsersError = '';
    let res;
    try {
      res = await FGA().listKnownUsers();
    } catch (_e) {
      res = { ok: false, code: 'RELAY_QUERY_FAILED' };
    }
    if (gen !== knownUsersGen) return { ok: false, code: 'STALE' };
    knownUsersLoading = false;
    if (res && res.ok) {
      knownUsers = { rows: res.rows, byPk: new Map(res.rows.map((r) => [r.pubkey, r])) };
      res.rows.forEach((r) => {
        if ((r.displayName || r.avatar) && !(profiles.get(r.pubkey) || {}).name) {
          profiles.set(r.pubkey, { name: String(r.displayName || ''), picture: String(r.avatar || '') });
        }
      });
    } else knownUsersError = (res && res.code) || 'RELAY_QUERY_FAILED';
    if (activeTab === 'members') renderDirList();
    if (selectedMember) renderDrawer();
    return res;
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
        .map((r) => {
          const pk = String(r.memberPubkey || '');
          const prof = profileOf(pk);
          return (
            '<div class="gap-item" data-pending-pk="' + escapeHtml(pk) + '">' + avatarHtml(pk, prof) +
            '<div class="gap-user-main"><div class="gap-user-name">' + escapeHtml(displayName(pk, prof)) + '</div><div class="gap-sub gap-mono">' + escapeHtml(shortPk(pk)) + '</div></div>' +
            '<span class="gap-sub gap-join-status">ממתין לאישור אוטומטי</span></div>'
          );
        })
        .join('') || '<div class="gap-sub">אין בקשות ממתינות</div>';
  }

  function renderAdmins(body) {
    const f = FGA();
    const root = configuredRoot();
    const s = isV2() ? sections() : {};
    const me = actor();
    const list = isV2() ? f.admins().map((r) => userView(r.pubkey, r)) : [];
    if (root && !list.some((u) => u.isRoot)) list.unshift(userView(root));
    list.sort((a, b) => (b.isRoot ? 1 : 0) - (a.isRoot ? 1 : 0) || byName(a, b));
    body.innerHTML =
      '<div class="gap-list" id="sosGapAdminList">' +
      list
        .map((u) =>
          userRowHtml(u, {
            admin: true,
            extra:
              s.manageAdmins && !u.isRoot && u.pubkey !== me
                ? '<button type="button" class="gap-btn danger" data-act="demote" data-mutation="1" data-pk="' + escapeHtml(u.pubkey) + '">' + LABELS.REMOVE_ADMIN + '</button>'
                : '',
          })
        )
        .join('') +
      '</div>' +
      '<p class="gap-note">כדי למנות מנהל חדש: חפשו את המשתמש, פתחו את כרטיס הניהול שלו ובחרו תפקיד.</p>';
  }

  function renderInvites(body) {
    const f = FGA();
    if (!isV2()) {
      body.innerHTML =
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-mutation="1" disabled>' + LABELS.CREATE_INVITE + '</button></div>' +
        '<p class="gap-note">ניתן ליצור הזמנות מכאן לאחר הפעלת מערכת הניהול. בינתיים אפשר להזמין חברים דרך כפתור ההזמנה בתפריט הפרופיל.</p>';
      return;
    }
    const s = sections();
    let html =
      '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="create-invite" data-mutation="1"' + (s.createInvite ? '' : ' disabled') + '>' + LABELS.CREATE_INVITE + '</button></div>';
    if (lastInvite) {
      html +=
        '<div class="gap-row"><label for="sosGapInviteUrl">קישור הזמנה</label><input readonly id="sosGapInviteUrl" value="' + escapeHtml(lastInvite.inviteUrl) + '"></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn" data-act="copy-invite">' + LABELS.COPY_LINK + '</button></div>' +
        '<canvas id="sosGapQrCanvas" width="240" height="240" aria-label="קוד QR להזמנה"></canvas>' +
        '<p class="gap-note">שלחו את הקישור או את קוד ה-QR למשתמש. הקישור כולל קוד הזמנה בלבד.</p>';
    }
    html += '<p class="gap-note">הזמנה נועדה למי שעדיין לא משתמש ב-SOS. היא תקפה ל-24 שעות ולשימוש אחד בלבד.</p>';
    html += '<div id="sosGapInviteLifecycle">' + inviteLifecycleHtml(s) + '</div>';
    body.innerHTML = html;
    if (lastInvite) {
      f.renderInviteQr(document.getElementById('sosGapQrCanvas'), lastInvite.inviteUrl).then((r) => {
        if (!r.ok) setMsg(errText(r), 'err');
      });
    }
    if (!inviteLifecycle || Date.now() - inviteLifecycleAt > 30000) loadInviteLifecycle();
  }

  const INVITE_STATUS_LABEL = Object.freeze({ ACTIVE: 'פעילה', USED: 'נוצלה', EXPIRED: 'פגה', REVOKED: 'בוטלה' });
  let inviteLifecycle = null;
  let inviteLifecycleAt = 0;
  let inviteLifecycleLoading = false;

  function timeLeftText(sec) {
    if (sec <= 0) return 'פג';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? 'בתוקף לעוד ' + h + ' שעות' + (m ? ' ו-' + m + ' דקות' : '') : 'בתוקף לעוד ' + Math.max(1, m) + ' דקות';
  }

  function inviteRowHtml(r, s) {
    const when = (t) => (t ? new Date(t * 1000).toLocaleString('he-IL') : '');
    const now = Math.floor(Date.now() / 1000);
    const creator = r.creatorPubkey ? displayName(r.creatorPubkey, profileOf(r.creatorPubkey)) : '';
    let detail = 'נוצרה ' + when(r.createdAt);
    if (r.status === 'ACTIVE') detail += ' · ' + timeLeftText(r.expiresAt - now);
    if (r.status === 'EXPIRED') detail += ' · פגה ' + when(r.expiresAt);
    if (r.status === 'REVOKED' && r.revokedAt) detail += ' · בוטלה ' + when(r.revokedAt);
    if (r.status === 'USED') {
      if (r.usedBy) ensureProfile(r.usedBy);
      detail += ' · נוצלה' + (r.usedBy ? ' על ידי ' + escapeHtml(displayName(r.usedBy, profileOf(r.usedBy))) : '') + (r.usedAt ? ' ב-' + when(r.usedAt) : '');
    }
    return (
      '<div class="gap-item" data-invite-id="' + escapeHtml(r.inviteEventId) + '" data-invite-status="' + escapeHtml(r.status) + '">' +
      '<div class="gap-user-main"><div>הזמנה ' + escapeHtml(r.shortId) + ' <span class="gap-chip">' + escapeHtml(INVITE_STATUS_LABEL[r.status] || r.status) + '</span></div>' +
      '<div class="gap-sub">' + detail + (creator ? ' · יצר: ' + escapeHtml(creator) : '') + '</div></div>' +
      (r.status === 'ACTIVE' && s.revokeInvites
        ? '<button type="button" class="gap-btn danger" data-act="revoke-invite" data-mutation="1" data-invite-id="' + escapeHtml(r.inviteEventId) + '">' + LABELS.REVOKE_INVITE + '</button>'
        : '') +
      '</div>'
    );
  }

  function inviteLifecycleHtml(s) {
    if (!inviteLifecycle) return '<p class="gap-sub">טוען הזמנות…</p>';
    if (!inviteLifecycle.ok) return '<p class="gap-sub">' + escapeHtml(errText(inviteLifecycle)) + '</p>';
    const active = inviteLifecycle.rows.filter((r) => r.status === 'ACTIVE');
    const history = inviteLifecycle.rows.filter((r) => r.status !== 'ACTIVE');
    return (
      '<h3>הזמנות פעילות</h3><div class="gap-list" id="sosGapInviteList">' +
      (active.map((r) => inviteRowHtml(r, s)).join('') || '<p class="gap-note">אין הזמנות פעילות.</p>') +
      '</div>' +
      '<details id="sosGapInviteHistory" style="margin-top:12px"><summary>היסטוריית הזמנות (' + history.length + ')</summary>' +
      '<div class="gap-list">' + (history.map((r) => inviteRowHtml(r, s)).join('') || '<p class="gap-note">אין היסטוריה.</p>') + '</div></details>'
    );
  }

  async function loadInviteLifecycle() {
    const f = FGA();
    if (inviteLifecycleLoading || !f || typeof f.listInviteLifecycle !== 'function') return;
    inviteLifecycleLoading = true;
    try {
      inviteLifecycle = await f.listInviteLifecycle();
    } catch (e) {
      inviteLifecycle = { ok: false, code: (e && e.code) || 'RELAY_QUERY_FAILED' };
    } finally {
      inviteLifecycleLoading = false;
      inviteLifecycleAt = Date.now();
    }
    const box = document.getElementById('sosGapInviteLifecycle');
    if (box) box.innerHTML = inviteLifecycleHtml(isV2() ? sections() : {});
  }

  function GR() {
    return App.GroupReports || window.SosGroupReports || null;
  }

  function reasonLabel(id) {
    const r = GR() && GR().REASONS.find((x) => x.id === id);
    return r ? r.label : 'אחר';
  }

  function addMemberButtonHtml(u) {
    return (
      '<div class="gap-actions"><button type="button" class="gap-btn primary" id="sosGapAddMember" data-act="add-member" data-pk="' +
      escapeHtml(u.pubkey) + '" data-mutation="1">הוסף לקבוצה</button></div>'
    );
  }

  function reportRowHtml(r, s) {
    const R = GR();
    const pk = r.reportedPubkey;
    const prof = profileOf(pk);
    ensureProfile(pk);
    const when = r.lastAt ? new Date(r.lastAt * 1000).toLocaleString('he-IL') : '';
    const reasons = r.reasons.map((x) => reasonLabel(x.id) + (x.count > 1 ? ' ×' + x.count : '')).join(', ');
    const closed = r.status === 'RESOLVED' || r.status === 'REJECTED';
    const btn = (act, label, cls, extra) =>
      '<button type="button" class="gap-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-target="' + escapeHtml(r.targetId) + '" data-pk="' + escapeHtml(pk) + '"' + (extra || '') + '>' + label + '</button>';
    return (
      '<div class="gap-item gap-report" data-report-target="' + escapeHtml(r.targetId) + '" data-report-status="' + escapeHtml(r.status) + '">' +
      '<div class="gap-user-main" style="flex-basis:100%">' +
      '<div><span class="gap-chip">' + escapeHtml(R.STATUSES[r.status] || r.status) + '</span> ' +
      '<span class="gap-sub">' + escapeHtml(when) + ' · ' + r.reportCount + ' דיווחים</span></div>' +
      '<div class="gap-report-preview" style="margin:6px 0">' + (r.removed ? '<i>התוכן הוסר</i>' : escapeHtml(r.preview || 'תוכן לא זמין')) + '</div>' +
      '<div class="gap-sub">משתמש מדווח: <span data-name-pk="' + escapeHtml(pk) + '">' + escapeHtml(displayName(pk, prof)) + '</span> <span class="gap-mono">' + escapeHtml(shortPk(pk)) + '</span></div>' +
      '<div class="gap-sub">סיבה: ' + escapeHtml(reasons) + '</div>' +
      (r.notes.length ? '<div class="gap-sub">פרטים: ' + escapeHtml(r.notes.join(' | ')) + '</div>' : '') +
      '</div><div class="gap-actions" style="margin-top:6px">' +
      (s.moderation && !r.removed && r.event ? btn('report-remove', 'הסר תוכן', 'danger', ' data-mutation="1"') : '') +
      (s.blockMembers ? btn('report-block', 'חסום משתמש', 'danger', ' data-mutation="1"') : '') +
      btn('select-member', 'פתח פרופיל', '') +
      (r.status === 'NEW' ? btn('report-status', 'בטיפול', '', ' data-status="IN_PROGRESS"') : '') +
      (!closed ? btn('report-status', 'סגור דיווח', '', ' data-status="RESOLVED"') : '') +
      (!closed ? btn('report-status', 'דחה', '', ' data-status="REJECTED"') : '') +
      '</div></div>'
    );
  }

  function renderReports(body) {
    const R = GR();
    const s = isV2() ? sections() : {};
    if (!R) {
      body.innerHTML = '<p class="gap-note">מודול הדיווחים לא נטען.</p>';
      return;
    }
    const snap = R.snapshot();
    const head =
      '<div class="gap-summary"><span>דיווחים פתוחים: <b id="sosGapReportUnresolved">' + (snap.ok ? snap.unresolved : '—') + '</b></span></div>' +
      '<div class="gap-actions"><button type="button" class="gap-btn" data-act="reports-refresh">רענון</button></div>';
    const rows = snap.ok ? snap.rows : [];
    body.innerHTML =
      head +
      '<div class="gap-list" id="sosGapReportList">' +
      (snap.ok ? rows.map((r) => reportRowHtml(r, s)).join('') || '<p class="gap-note">אין דיווחים.</p>' : '<div class="gap-sub">טוען…</div>') +
      '</div>';
    if (!snap.ok || Date.now() - snap.loadedAt > 30000) {
      R.loadInbox()
        .then(() => {
          if (isOpen() && activeTab === 'reports' && !busy) renderTab('reports');
        })
        .catch(() => {});
    }
  }

  /** Recent posts/comments of one user from the group relays, for moderators. */
  async function loadUserContent(pk) {
    const box = document.getElementById('sosGapUserContent');
    if (!box || !/^[0-9a-f]{64}$/.test(pk)) return;
    box.innerHTML = '<div class="gap-sub">טוען…</div>';
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    let events = [];
    try {
      const filter = { kinds: [1], authors: [pk], limit: 30 };
      if (App.pool && typeof App.pool.querySync === 'function') events = (await App.pool.querySync(relays, filter, { maxWait: 6000 })) || [];
      else if (App.pool && typeof App.pool.list === 'function') events = (await App.pool.list(relays, [filter])) || [];
    } catch (_e) {
      events = [];
    }
    if (selectedMember !== pk || !document.getElementById('sosGapUserContent')) return;
    const deleted = App.deletedEventIds instanceof Set ? App.deletedEventIds : new Set();
    const seen = new Set();
    userContent = events
      .filter((e) => e && e.id && e.pubkey === pk && !seen.has(e.id) && seen.add(e.id) && !deleted.has(e.id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 30);
    const s = isV2() ? sections() : {};
    box.innerHTML =
      userContent
        .map((e) => {
          const isReply = (e.tags || []).some((t) => Array.isArray(t) && t[0] === 'e');
          return (
            '<div class="gap-item" data-content-id="' + escapeHtml(e.id) + '"><div class="gap-user-main">' +
            '<div class="gap-sub">' + (isReply ? 'תגובה' : 'פוסט') + ' · ' + escapeHtml(new Date(e.created_at * 1000).toLocaleString('he-IL')) + '</div>' +
            '<div>' + escapeHtml(String(e.content || '').slice(0, 200) || '—') + '</div></div>' +
            (s.moderation ? '<button type="button" class="gap-btn danger" data-act="remove-content" data-mutation="1" data-target="' + escapeHtml(e.id) + '">הסר תוכן</button>' : '') +
            '</div>'
          );
        })
        .join('') || '<div class="gap-sub">לא נמצא תוכן של המשתמש.</div>';
  }

  /** Moderator removal of another user's content (canonical moderation event + Admin 2FA). */
  async function removeContent(ev) {
    if (!ev || typeof App.moderateRemoveEvent !== 'function') return { ok: false, code: 'NO_TARGET' };
    return run('הסרת תוכן', () => App.moderateRemoveEvent(ev), 'להסיר את התוכן? הוא יוסתר לכל המשתמשים ב-SOS.');
  }

  function renderActivity(body) {
    const f = FGA();
    const extra = [];
    if (isV2()) {
      const tomb = App.deletionTombstones instanceof Map ? App.deletionTombstones : new Map();
      tomb.forEach((m, id) => {
        if (!m || m.source !== 'moderation') return;
        const author = m.author || (App.eventAuthorById instanceof Map ? App.eventAuthorById.get(id) : '');
        extra.push({ action: 'CONTENT_REMOVED', actor: m.deleter || '', target: author || '', createdAt: m.createdAt || 0, detail: '' });
      });
      const R = GR();
      if (R && typeof R.resolutionAudit === 'function') R.resolutionAudit().forEach((r) => extra.push(r));
    }
    const rows = isV2()
      ? f.auditLog().concat(extra).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).reverse().slice(0, 200)
      : [];
    if (!rows.length) {
      body.innerHTML = '<p class="gap-note">עדיין אין פעילות ניהולית.</p>';
      return;
    }
    const who = (pk) => (pk ? displayName(pk, profileOf(pk)) : '');
    body.innerHTML =
      '<div class="gap-list" id="sosGapAudit">' +
      rows
        .map((r) => {
          const detail = f.CAP_LABELS[r.detail] || POLICY_LABELS[r.detail] || BLOCKLIST_DETAIL[r.detail] || '';
          const action = r.action === 'MEMBER_ACTIVE' && /UNBLOCK/.test(String(r.detail || '')) ? 'MEMBER_UNBLOCKED' : r.action;
          return (
            '<div class="gap-item" data-audit-action="' + escapeHtml(action) + '"><div><div>' + escapeHtml(ACTION_LABELS[action] || 'פעולת ניהול') + (detail ? ' · ' + escapeHtml(detail) : '') + '</div>' +
            '<div class="gap-sub">' + escapeHtml(who(r.actor)) + (r.target ? ' ← ' + escapeHtml(who(r.target)) : '') + '</div></div>' +
            '<div class="gap-sub">' + escapeHtml(r.createdAt ? new Date(r.createdAt * 1000).toLocaleString('he-IL') : '') + '</div></div>'
          );
        })
        .join('') +
      '</div>';
  }

  // ---------------------------------------------------------------- advanced (technical / reference, collapsed)

  function advancedHtml() {
    const f = FGA();
    const g = GCS();
    const info = groupInfo();
    const s = isV2() ? sections() : {};
    const src = safeLogoSrc(info.logoRef);
    const n = App.FirstGroupNetworkAuthority;
    let html =
      '<details class="gap-adv" id="sosGapAdvanced"' + (advancedOpen ? ' open' : '') + '><summary>הגדרות מתקדמות</summary>' +
      '<h3>פרטי הקבוצה</h3>' +
      '<div class="gap-row"><label>שם הקבוצה</label><div id="sosGapViewName">' + escapeHtml(info.displayName) + '</div></div>' +
      '<div class="gap-row"><label>תיאור</label><div id="sosGapViewDesc">' + escapeHtml(info.description || 'אין תיאור') + '</div></div>' +
      '<div class="gap-row"><label>לוגו הקבוצה</label><div>' +
      (src ? '<img id="sosGapViewLogo" alt="לוגו הקבוצה" style="max-height:64px;border-radius:8px" src="' + escapeHtml(src) + '">' : 'אין לוגו') +
      '</div></div>';
    if (s.editDetails) {
      html +=
        '<div class="gap-row"><label for="sosGapName">עריכת שם</label><input id="sosGapName" maxlength="80" value="' + escapeHtml(info.displayName) + '"></div>' +
        '<div class="gap-row"><label for="sosGapDesc">עריכת תיאור</label><textarea id="sosGapDesc" rows="3" maxlength="280">' + escapeHtml(info.description) + '</textarea></div>' +
        '<div class="gap-row"><label for="sosGapLogoFile">החלפת לוגו</label><input id="sosGapLogoFile" type="file" accept="image/png,image/jpeg,image/webp">' +
        '<div id="sosGapLogoPreview"></div></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="save-details" data-mutation="1">' + LABELS.SAVE_DETAILS + '</button>' +
        (src ? '<button type="button" class="gap-btn" data-act="remove-logo" data-mutation="1">הסרת לוגו</button>' : '') +
        '</div>';
    }
    if (s.settings) {
      html +=
        '<div class="gap-row"><label for="sosGapPolicy">מי יכול ליצור הזמנות</label><select id="sosGapPolicy">' +
        Object.keys(POLICY_LABELS)
          .map((k) => '<option value="' + k + '"' + (k === info.invitePolicy ? ' selected' : '') + '>' + escapeHtml(POLICY_LABELS[k]) + '</option>')
          .join('') +
        '</select></div>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" data-act="save-policy" data-mutation="1">שמירת הגדרות</button></div>';
    }
    if (canActivateControl()) {
      html +=
        '<h3>הפעלת מערכת הניהול</h3>' +
        '<p class="gap-sub">פעולה חד־פעמית של המנהל הראשי: יוצרת את שרשרת הבקרה החתומה של הקבוצה, בלי מנהלים נוספים ובלי חברים. תתבקשו לאשר בקוד מנהל.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" id="sosGapActivateControl" data-act="activate-control" data-gate15="1">הפעלת מערכת הניהול</button></div>';
    }
    if (canActivateAdmission()) {
      html +=
        '<h3>שירות קבלת חברים</h3>' +
        '<p class="gap-sub" id="sosGapAdmissionExplain">' + escapeHtml(ADMISSION_EXPLAIN_TEXT) + ' תתבקשו לאשר בקוד מנהל.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn primary" id="sosGapActivateAdmission" data-act="activate-admission" data-gate2="1">הפעל שירות קבלת חברים</button></div>';
    } else if (!isV2() && admissionServiceActive() && f.isConfiguredRoot(actor())) {
      html +=
        '<h3>שירות קבלת חברים</h3>' +
        '<p class="gap-sub" id="sosGapAdmissionActive">שירות קבלת החברים פעיל. ההרשאה שלו מוגבלת לצירוף חברים שהשתמשו בהזמנה.</p>' +
        '<div class="gap-actions"><button type="button" class="gap-btn danger" id="sosGapDeactivateAdmission" data-act="deactivate-admission" data-gate2="1">השבת שירות קבלת חברים</button></div>';
    }
    const signerPk = controlProbe && controlProbe.admin2faSignerPubkey;
    html +=
      '<h3>מידע טכני</h3><ul class="gap-ref">' +
      (signerPk ? '<li>חותם אימות מנהל: <span class="gap-mono" id="sosGapAdmin2faSigner">' + escapeHtml(signerPk) + '</span></li>' : '') +
      (controlProbe && controlProbe.status === 'VERIFIED'
        ? '<li>שירות קבלת חברים: <span id="sosGapAdmissionState" data-active="' + (admissionServiceActive() ? '1' : '0') + '">' +
          (admissionServiceActive() ? 'פעיל' : 'לא פעיל') + '</span></li>'
        : '') +
      '<li>מזהה קבוצה: <span class="gap-mono">' + escapeHtml(f.FIRST_GROUP_ID) + '</span></li>' +
      '<li>מצב מערכת הניהול: <span class="gap-mono" id="sosGapControlCode">' + escapeHtml(controlStatus()) + '</span></li>' +
      '<li>מצב שרשרת הבקרה: <span class="gap-mono">' + escapeHtml(g && typeof g.getStatus === 'function' ? String(g.getStatus(f.FIRST_GROUP_ID) || '') : '') + '</span></li>' +
      '<li>גרסת בקרה: ' + escapeHtml(info.epoch != null ? String(info.epoch) : NO_DATA_TEXT) + '</li>' +
      '<li>סנכרון רשת: ' + (n && typeof n.isSynced === 'function' && n.isSynced() ? 'מסונכרן' : 'לא מסונכרן') + '</li>' +
      '<li>מפתח ציבורי של המנהל הראשי: <span class="gap-mono">' + escapeHtml(configuredRoot()) + '</span></li></ul>' +
      '<h3>תפקידים</h3><table><thead><tr><th>תפקיד</th><th>הרשאות</th></tr></thead><tbody>' +
      f.ROLES.map(
        (r) =>
          '<tr><td>' + escapeHtml(r.label) + '</td><td>' +
          escapeHtml(r.id === 'ROOT' ? 'כל ההרשאות (לא ניתן להעברה)' : r.preset ? r.preset.map((c) => f.CAP_LABELS[c]).join(', ') : r.id === 'MEMBER' ? 'חברות פעילה' : 'שילוב הרשאות') +
          '</td></tr>'
      ).join('') +
      '</tbody></table>' +
      '<h3>הרשאות</h3><ul class="gap-ref" id="sosGapCapsCatalog">' +
      Object.keys(f.CAP_LABELS)
        .map((c) => '<li data-cap="' + c + '">' + escapeHtml(f.CAP_LABELS[c]) + ' <span class="gap-mono gap-sub">' + c + '</span></li>')
        .join('') +
      '</ul></details>';
    return html;
  }

  function bindAdvanced() {
    const d = document.getElementById('sosGapAdvanced');
    if (d) d.addEventListener('toggle', () => (advancedOpen = d.open));
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

  // ---------------------------------------------------------------- user panel (role + permissions of one user)

  /** Same derivation as FirstGroupAdmin roles: a role is a view of the canonical capability set. */
  function roleForCaps(caps) {
    const c = caps || [];
    if (c.indexOf('MANAGE_ADMINS') !== -1 || c.indexOf('MANAGE_PERMISSIONS') !== -1) return 'SENIOR_ADMIN';
    if (c.indexOf('MANAGE_MEMBERS') !== -1) return 'ADMIN';
    if (c.indexOf('MODERATE_CONTENT') !== -1) return 'MODERATOR';
    if (c.indexOf('INVITE_USERS') !== -1 && c.length === 1) return 'INVITER';
    if (c.length) return 'DELEGATE';
    return 'MEMBER';
  }

  function rolePreset(id) {
    const r = FGA().ROLES.find((x) => x.id === id);
    return r && r.preset ? r.preset.slice() : [];
  }

  /** V2 off: preparation only (all toggles usable, save disabled). V2 on: what the signed policy lets me grant. */
  function grantableFor(pk) {
    const f = FGA();
    if (!isV2()) return Object.keys(f.CAP_LABELS);
    return f.grantableCapsFor(f.myAuthority(), pk);
  }

  function roleAllowed(id, current, grantable) {
    const next = rolePreset(id);
    const changed = next.filter((c) => current.indexOf(c) === -1).concat(current.filter((c) => next.indexOf(c) === -1));
    return changed.every((c) => grantable.indexOf(c) !== -1);
  }

  function updateRoleHighlight() {
    const role = roleForCaps(draftCaps || []);
    document.querySelectorAll('#sosGapRoleOptions [data-role]').forEach((b) => {
      const on = b.getAttribute('data-role') === role;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /** Primary permissions first; the rest inside a collapsed "advanced" section. All inputs stay in #sosGapCaps. */
  function capsEditorHtml(caps, isChecked, isEnabled, withIds) {
    const f = FGA();
    const item = (c) =>
      '<label class="gap-cap"><input type="checkbox"' + (withIds ? ' data-cap="' + c + '"' : '') +
      (isChecked(c) ? ' checked' : '') + (isEnabled(c) ? '' : ' disabled') + '> <span><b>' + escapeHtml(f.CAP_LABELS[c]) + '</b>' +
      (CAP_HELP[c] ? '<span class="gap-sub gap-cap-help">' + escapeHtml(CAP_HELP[c]) + '</span>' : '') + '</span></label>';
    const primary = PRIMARY_CAPS.filter((c) => caps.indexOf(c) !== -1);
    const advanced = caps.filter((c) => PRIMARY_CAPS.indexOf(c) === -1);
    return (
      '<div class="gap-caps"' + (withIds ? ' id="sosGapCaps"' : '') + '>' +
      primary.map(item).join('') +
      (advanced.length
        ? '<details class="gap-caps-advanced" id="sosGapAdvancedCaps"' + (advancedCapsOpen ? ' open' : '') + '><summary>הרשאות ניהול מתקדמות</summary>' +
          advanced.map(item).join('') + '</details>'
        : '') +
      '</div>'
    );
  }

  /** Remove / block / unblock / user content. ROOT and self never get these actions. */
  function userActionsHtml(u, s, me) {
    if (!isV2() || u.isRoot || u.pubkey === me) return '';
    const f = FGA();
    const blockState = typeof f.blockStateOf === 'function' ? f.blockStateOf(u.pubkey) : 'NONE';
    const pk = escapeHtml(u.pubkey);
    const btn = (act, label, cls) =>
      '<button type="button" class="gap-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-pk="' + pk + '"' + (cls === 'danger' || act === 'unblock-user' ? ' data-mutation="1"' : '') + '>' + label + '</button>';
    const btns = [];
    if (s.removeMembers && (u.canonStatus === 'ACTIVE' || u.canonStatus === 'BLOCKED')) btns.push(btn('remove-member', 'הסר משתמש', 'danger'));
    if (s.blockMembers && (blockState === 'NONE' || (blockState === 'LISTED' && u.status === 'ACTIVE'))) btns.push(btn('block-user', 'חסום משתמש', 'danger'));
    if (s.blockMembers && blockState !== 'NONE') btns.push(btn('unblock-user', 'הסר חסימה', ''));
    if (s.moderation || s.reports) btns.push(btn('user-content', 'תוכן המשתמש', ''));
    if (!btns.length) return '';
    return (
      '<h3>פעולות</h3><div class="gap-actions" id="sosGapUserActions" data-block-state="' + escapeHtml(blockState) + '">' + btns.join('') + '</div>' +
      '<div class="gap-list" id="sosGapUserContent"></div>'
    );
  }

  function renderDrawer() {
    if (!shellEl) return;
    let el = document.getElementById('sosGapMemberDetail');
    if (!selectedMember) {
      if (el) el.remove();
      return;
    }
    const f = FGA();
    const u = userView(selectedMember);
    const s = isV2() ? sections() : {};
    const me = actor();
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosGapMemberDetail';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'sosGapUserTitle');
      shellEl.querySelector('.gap-panel').appendChild(el);
    }
    el.setAttribute('data-pk', u.pubkey);
    ensureProfile(u.pubkey);
    const caps = Object.keys(f.CAP_LABELS);
    let body =
      '<div class="gap-who">' + avatarHtml(u.pubkey, u.profile, true) +
      '<div class="gap-user-main"><div class="gap-user-name" data-name-pk="' + escapeHtml(u.pubkey) + '">' + escapeHtml(displayName(u.pubkey, u.profile)) + '</div>' +
      '<div class="gap-sub gap-mono">' + escapeHtml(shortPk(u.pubkey)) + '</div>' +
      '<div class="gap-sub">' +
      (u.isRoot ? '<span class="gap-chip root">' + escapeHtml(u.roleLabel) + '</span>' : 'תפקיד נוכחי: ' + escapeHtml(u.member ? u.roleLabel : NO_DATA_TEXT)) +
      ' · ' + escapeHtml(u.statusLabel) + '</div></div></div>';
    let foot = '';
    if (u.isRoot) {
      body +=
        '<p class="gap-note" id="sosGapRootLocked">המנהל הראשי הוא הבעלים של הקבוצה. התפקיד וההרשאות שלו מוגנים ולא ניתן לשנות או להסיר אותם.</p>' +
        '<h3>הרשאות</h3>' + capsEditorHtml(caps, () => true, () => false, false);
    } else if (isV2() && (u.status === 'BLOCKED' || u.status === 'REMOVED')) {
      body +=
        '<p class="gap-note" id="sosGapUserStateNote">' +
        (u.status === 'BLOCKED'
          ? 'המשתמש חסום. הוא לא יכול לפרסם, להגיב, להזמין או לנהל, והתוכן שלו מוסתר ב-SOS.'
          : 'המשתמש הוסר מהקבוצה. הוא לא יצורף מחדש אוטומטית. אפשר להוסיף אותו שוב ידנית, בלי הרשאות.') +
        '</p>';
      if (u.status === 'REMOVED' && s.removeMembers) foot = addMemberButtonHtml(u);
    } else if (isV2() && u.status === 'UNKNOWN' && f.defaultMembershipApplies()) {
      const checking = !knownChecked.has(u.pubkey);
      if (checking && !registrationLookups.has(u.pubkey)) {
        registrationLookups.add(u.pubkey);
        Promise.resolve(typeof f.isKnownSosAccount === 'function' ? f.isKnownSosAccount(u.pubkey) : false)
          .catch(() => false)
          .then((known) => {
            if (known === true) knownExtra.add(u.pubkey);
            knownChecked.add(u.pubkey);
            if (selectedMember === u.pubkey) renderDrawer();
          });
      }
      body +=
        '<p class="gap-note" id="sosGapLegacyNote" data-known="' + (checking ? 'checking' : '0') + '">' +
        (checking ? 'בודק אם זה חשבון SOS…' : 'זה אינו חשבון SOS מוכר. מצטרפים לקבוצה רק דרך הזמנה.') +
        '</p>';
    } else if (isV2() && !u.member && u.status !== 'LEGACY') {
      body +=
        '<h3>הוספה לקבוצה</h3>' +
        '<p class="gap-note">המשתמש יצורף לקבוצה כחבר רגיל, בלי הרשאות. אחר כך תוכלו להעניק לו הרשאות.</p>';
      foot = s.removeMembers ? addMemberButtonHtml(u) : '<p class="gap-note">רק מי שיש לו הרשאת ניהול חברים יכול להוסיף לקבוצה.</p>';
    } else {
      const current = u.assigned;
      const draft = draftCaps || current;
      const grantable = grantableFor(u.pubkey);
      const draftRole = roleForCaps(draft);
      const legacy = isV2() && u.status === 'LEGACY';
      if (legacy) {
        body +=
          '<p class="gap-note" id="sosGapLegacyNote" data-known="1">חשבון SOS ותיק שעדיין לא צורף לקבוצה. אפשר לאשר אותו כחבר רגיל, בלי הרשאות, ' +
          'או לבחור הרשאות ולשמור – הצירוף לקבוצה ייעשה באותה פעולה. שום הרשאה לא ניתנת אוטומטית.</p>';
      } else if (!u.member) {
        body += '<p class="gap-note">המשתמש עדיין לא מופיע כחבר בקבוצה. לאחר הפעלת מערכת הניהול תוכלו להוסיף אותו ולהעניק לו תפקיד. כבר עכשיו אפשר להכין תפקיד והרשאות.</p>';
      }
      body +=
        '<h3>תפקיד</h3><div id="sosGapRoleOptions" role="radiogroup" aria-label="תפקיד">' +
        EDITABLE_ROLES.map((id) => {
          const on = draftRole === id;
          return (
            '<button type="button" role="radio" data-act="pick-role" data-role="' + id + '" aria-checked="' + (on ? 'true' : 'false') + '"' +
            (on ? ' class="active"' : '') + (roleAllowed(id, current, grantable) ? '' : ' disabled') + '>' + escapeHtml(f.roleLabel(id)) + '</button>'
          );
        }).join('') +
        '</div>' +
        '<h3>ניהול הרשאות</h3>' +
        capsEditorHtml(caps, (c) => draft.indexOf(c) !== -1, (c) => grantable.indexOf(c) !== -1, true);
      const canSave = isV2() && (u.member || (legacy && !!s.removeMembers));
      foot =
        (isV2() ? '' : '<p class="gap-note" id="sosGapSaveNote">' + SAVE_AFTER_ACTIVATION_TEXT + '</p>') +
        '<div class="gap-actions">' +
        '<button type="button" class="gap-btn primary" id="sosGapSaveUser" data-act="save-user" data-mutation="1"' + (canSave ? '' : ' disabled') + '>שמור שינויים</button>' +
        (legacy && s.removeMembers
          ? '<button type="button" class="gap-btn" id="sosGapConfirmMember" data-act="confirm-member" data-mutation="1" data-pk="' + escapeHtml(u.pubkey) + '">אישור כחבר</button>'
          : !u.member ? '<button type="button" class="gap-btn" data-mutation="1" disabled>הוסף לקבוצה</button>' : '') +
        '</div>';
    }
    body += userActionsHtml(u, s, me);
    el.innerHTML =
      '<div class="gap-drawer"><div class="gap-head"><h2 id="sosGapUserTitle">ניהול משתמש</h2>' +
      '<button type="button" class="gap-btn" data-act="close-user">סגור</button></div>' +
      '<div class="gap-drawer-body">' + body + '</div>' +
      (foot ? '<div class="gap-drawer-foot">' + foot + '</div>' : '') +
      '</div>';
    const adv = document.getElementById('sosGapAdvancedCaps');
    if (adv) adv.addEventListener('toggle', () => (advancedCapsOpen = adv.open));
  }

  function closeDrawer() {
    selectedMember = '';
    draftCaps = null;
    advancedCapsOpen = false;
    renderDrawer();
  }

  function renderTab(tabId) {
    if (!shellEl) return;
    const body = document.getElementById('sosGapBody');
    if (!pinUnlocked()) {
      if (body) body.innerHTML = '';
      close();
      return;
    }
    const s = isV2() ? sections() : null;
    let tab = TAB_ALIASES[tabId] || tabId;
    if (!tabAllowed(tab, s)) tab = firstAllowedTab(s);
    activeTab = tab;
    renderedFingerprint = stateFingerprint();
    refreshChrome();
    if (reportsOnly) {
      const top = document.getElementById('sosGapTop');
      if (top) top.innerHTML = '';
      if (!body) return;
      if (!canSeeReportsEntry() || tab !== 'reports') {
        body.innerHTML = '<p>אין לכם הרשאה לצפות בדיווחים.</p>';
        closeDrawer();
        return;
      }
      renderReports(body);
      renderDrawer();
      return;
    }
    renderTop();
    if (!body) return;
    if (isV2() && !canSeeGroupAdminMenu() && !needsBootstrap()) {
      body.innerHTML = '<p>אין לכם הרשאות ניהול בקבוצה.</p>';
      closeDrawer();
      return;
    }
    if (tab === 'admins') renderAdmins(body);
    else if (tab === 'invites') renderInvites(body);
    else if (tab === 'reports') renderReports(body);
    else if (tab === 'activity') renderActivity(body);
    else if (tabAllowed('members', s)) renderMembers(body);
    else body.innerHTML = '<p class="gap-note">חפשו משתמש כדי לראות את התוכן שלו.</p>';
    body.insertAdjacentHTML('beforeend', advancedHtml());
    bindAdvanced();
    renderDrawer();
  }

  // ---------------------------------------------------------------- actions

  /** Gate 1.5: the root publishes the attested genesis. Needs a server admin session; nothing else is written. */
  async function activateControl() {
    const f = FGA();
    if (busy || !canActivateControl() || typeof f.activateGroupControl !== 'function') return null;
    const unlocked = await adminSession();
    if (!unlocked.ok) {
      setMsg(errText({ code: unlocked.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' ? unlocked.code : 'ADMIN_PIN_REQUIRED' }), 'err');
      return unlocked;
    }
    const yes = await confirmAction('להפעיל את מערכת הניהול של הקבוצה? זו פעולה חד־פעמית: נוצרת שרשרת בקרה חתומה עם המנהל הראשי בלבד.');
    if (!yes) {
      setMsg('הפעולה בוטלה', '');
      return { ok: false, code: 'CANCELLED' };
    }
    busy = true;
    setMsg('הפעלת מערכת הניהול…', '');
    let res;
    try {
      res = await f.activateGroupControl();
    } catch (e) {
      res = { ok: false, code: (e && e.code) || 'ERROR' };
    }
    busy = false;
    if (res && res.ok) {
      const p = PIN();
      if (p) p.touch();
      setMsg('מערכת הניהול הופעלה', 'ok');
    } else setMsg(errText(res), 'err');
    controlProbe = null;
    renderTab(activeTab);
    refreshControlProbe();
    return res;
  }

  /** Gate 2: owner-only admission service delegation change (step-up PIN through the Admin 2FA dialog). */
  async function changeAdmission(activate) {
    const f = FGA();
    const fn = f && (activate ? f.activateAdmissionService : f.deactivateAdmissionService);
    if (busy || typeof fn !== 'function') return null;
    if (activate ? !canActivateAdmission() : !admissionServiceActive()) return null;
    const unlocked = await adminSession();
    if (!unlocked.ok) {
      setMsg(errText({ code: unlocked.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' ? unlocked.code : 'ADMIN_PIN_REQUIRED' }), 'err');
      return unlocked;
    }
    const yes = await confirmAction(
      activate
        ? ADMISSION_EXPLAIN_TEXT + ' להפעיל את שירות קבלת החברים?'
        : 'להשבית את שירות קבלת החברים? הצטרפויות חדשות דרך השירות ייעצרו.'
    );
    if (!yes) {
      setMsg('הפעולה בוטלה', '');
      return { ok: false, code: 'CANCELLED' };
    }
    busy = true;
    setMsg(activate ? 'הפעלת שירות קבלת חברים…' : 'השבתת שירות קבלת חברים…', '');
    let res;
    try {
      res = await fn.call(f);
    } catch (e) {
      res = { ok: false, code: (e && e.code) || 'ERROR' };
    }
    busy = false;
    if (res && res.ok) {
      const p = PIN();
      if (p) p.touch();
      setMsg(activate ? 'שירות קבלת החברים הופעל' : 'שירות קבלת החברים הושבת', 'ok');
    } else setMsg(errText(res), 'err');
    controlProbe = null;
    renderTab(activeTab);
    refreshControlProbe();
    return res;
  }

  async function onAction(act, el) {
    const f = FGA();
    const pk = el.getAttribute('data-pk') || '';
    if (act === 'select-member') {
      if (!/^[0-9a-f]{64}$/.test(pk)) return null;
      if (pk !== selectedMember) draftCaps = null;
      selectedMember = pk;
      renderDrawer();
      return { ok: true };
    }
    if (act === 'close-user') return closeDrawer();
    if (act === 'pick-role') {
      const role = el.getAttribute('data-role');
      draftCaps = rolePreset(role);
      renderDrawer();
      const again = document.querySelector('#sosGapRoleOptions [data-role="' + role + '"]');
      if (again) again.focus();
      return null;
    }
    if (act === 'bootstrap') return run('הפעלת ניהול', () => f.bootstrapFirstGroup({}));
    if (act === 'activate-control') return activateControl();
    if (act === 'activate-admission') return changeAdmission(true);
    if (act === 'deactivate-admission') return changeAdmission(false);
    if (act === 'save-user') {
      const target = selectedMember;
      if (!target) return null;
      const before = f.authorityFor(target).assigned;
      const caps = draftCaps ? draftCaps.slice() : before.slice();
      const removing = before.some((c) => caps.indexOf(c) === -1);
      const legacy = userView(target).status === 'LEGACY';
      const res = legacy
        ? await run(
            'שמירת שינויים',
            () => f.savePermissions(target, caps),
            caps.length
              ? 'לצרף את המשתמש לקבוצה ולהעניק לו את ההרשאות שנבחרו?'
              : 'לצרף את המשתמש לקבוצה כחבר רגיל, בלי הרשאות?'
          )
        : await run('שמירת שינויים', () => f.setPermissions(target, caps), removing ? 'לשמור את השינויים? חלק מההרשאות יוסרו.' : null);
      if (res && res.ok) draftCaps = null;
      renderDrawer();
      return res;
    }
    if (act === 'add-member') {
      const res = await run('הוספה לקבוצה', () => f.addMember(pk));
      draftCaps = null;
      if (selectedMember) renderDrawer();
      return res;
    }
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
    if (act === 'remove-member') {
      const res = await run(LABELS.REMOVE_MEMBER, () => f.removeMember(pk), 'להסיר את החבר מהקבוצה? כל ההרשאות שלו יבוטלו.');
      if (res && res.ok) closeDrawer();
      return res;
    }
    if (act === 'block-user' || act === 'report-block') {
      return run(
        'חסימת משתמש',
        () => f.blockMember(pk),
        'לחסום את המשתמש? הוא לא יוכל לפרסם, להגיב, להזמין או לנהל, וכל התוכן שלו יוסתר ב-SOS.'
      );
    }
    if (act === 'unblock-user') {
      return run('הסרת חסימה', () => f.unblockMember(pk), 'להסיר את החסימה? משתמש שהוסר מהקבוצה לא יחזור אליה, והרשאות שבוטלו לא יחזרו.');
    }
    if (act === 'user-content') return loadUserContent(pk);
    if (act === 'remove-content') {
      const id = el.getAttribute('data-target') || '';
      const ev = userContent.find((e) => e.id === id);
      const res = await removeContent(ev);
      if (res && res.ok && selectedMember) loadUserContent(selectedMember);
      return res;
    }
    if (act === 'reports-refresh') {
      const R = GR();
      if (R) await R.loadInbox();
      renderTab('reports');
      return { ok: true };
    }
    if (act === 'report-remove') {
      const R = GR();
      const row = R && R.snapshot().rows.find((r) => r.targetId === el.getAttribute('data-target'));
      const res = await removeContent(row && row.event);
      if (res && res.ok && R) await R.setStatus(row.targetId, 'RESOLVED');
      renderTab('reports');
      return res;
    }
    if (act === 'report-status') {
      const R = GR();
      if (!R || busy) return null;
      busy = true;
      setMsg('מעדכן דיווח…', '');
      let res;
      try {
        res = await R.setStatus(el.getAttribute('data-target'), el.getAttribute('data-status'));
      } catch (_e) {
        res = { ok: false, code: 'ERROR' };
      }
      busy = false;
      setMsg(res && res.ok ? 'הדיווח עודכן' : errText(res), res && res.ok ? 'ok' : 'err');
      renderTab('reports');
      return res;
    }
    if (act === 'load-joins') return loadJoins();
    if (act === 'dir-filter') {
      const want = String(el.getAttribute('data-filter') || 'ALL');
      dirFilter = DIR_FILTERS.some((x) => x.id === want) ? want : 'ALL';
      document.querySelectorAll('#sosGapDirFilters [data-filter]').forEach((b) => {
        const on = b.getAttribute('data-filter') === dirFilter;
        b.classList.toggle('primary', on);
        b.setAttribute('aria-pressed', String(on));
      });
      renderDirList();
      return null;
    }
    if (act === 'dir-refresh') {
      if (knownUsersLoading) return null;
      const p = loadKnownUsers();
      renderDirList();
      return p;
    }
    if (act === 'confirm-member') {
      const res = await run(
        'אישור כחבר',
        () => f.confirmLegacyMember(pk),
        'לאשר את המשתמש כחבר בקבוצה? הוא יצורף כחבר רגיל, בלי הרשאות.'
      );
      draftCaps = null;
      if (selectedMember) renderDrawer();
      return res;
    }
    if (act === 'demote') {
      return run(LABELS.REMOVE_ADMIN, () => f.demoteAdmin(pk), 'להסיר את הרשאות הניהול של המשתמש?');
    }
    if (act === 'create-invite') {
      const res = await run(LABELS.CREATE_INVITE, () => f.createInvite());
      if (res && res.ok) {
        lastInvite = res.invite;
        inviteLifecycle = null;
        renderTab('invites');
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
    if (act === 'show-qr') return renderTab('invites');
    if (act === 'revoke-invite') {
      const id = el.getAttribute('data-invite-id') || '';
      const lc = inviteLifecycle && inviteLifecycle.ok ? inviteLifecycle.rows.find((r) => r.inviteEventId === id) : null;
      if (!lc) return null;
      const row = { eventId: lc.inviteEventId, event: lc.event };
      const res = await run(LABELS.REVOKE_INVITE, () => f.revokeInvite(row), 'לבטל את ההזמנה? הקישור יפסיק לעבוד.');
      if (res && res.ok && lastInvite && lastInvite.eventId === row.eventId) lastInvite = null;
      inviteLifecycle = null;
      renderTab('invites');
      return res;
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
      '<div class="gap-head"><div class="gap-brand"><img id="sosGapLogo" alt="" style="display:none"><h2 id="sosGapTitle">ניהול הקבוצה</h2>' +
      '<span class="gap-role" id="sosGapRole"></span></div>' +
      '<button type="button" class="gap-btn" id="sosGapClose">סגור</button></div>' +
      '<div class="gap-top" id="sosGapTop"></div>' +
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
    shellEl.addEventListener('error', onAvatarError, true);
    shellEl.addEventListener('click', (ev) => {
      const p = PIN();
      if (p) p.touch();
      if (ev.target instanceof HTMLElement && ev.target.id === 'sosGapMemberDetail') {
        closeDrawer();
        return;
      }
      const t = ev.target instanceof HTMLElement ? ev.target.closest('[data-act]') : null;
      if (!t || t.hasAttribute('disabled')) return;
      onAction(t.getAttribute('data-act'), t);
    });
    shellEl.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement) || !t.closest('#sosGapCaps')) return;
      draftCaps = Array.from(document.querySelectorAll('#sosGapCaps input[data-cap]'))
        .filter((c) => c.checked)
        .map((c) => c.getAttribute('data-cap'));
      updateRoleHighlight();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && selectedMember && isOpen()) closeDrawer();
    });
    shellEl.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if ((ev.key === 'Enter' || ev.key === ' ') && t instanceof HTMLElement && t.classList.contains('gap-user')) {
        ev.preventDefault();
        t.click();
      }
    });
  }

  /** Every open requires an unlocked admin PIN session for the current identity. */
  /** Group control: management capabilities only. Content moderators use openReports(). */
  async function open(tab) {
    ensureMenuEntry();
    if (!canSeeGroupControl()) return { ok: false, code: 'UNAUTHORIZED' };
    const p = PIN();
    if (!p) return { ok: false, code: 'ADMIN_PIN_REQUIRED' };
    const who = actor();
    const u = await adminSession();
    if (!u.ok && u.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE') {
      notice(ERROR_TEXT.ADMIN_2FA_SERVICE_UNAVAILABLE);
      return { ok: false, code: u.code };
    }
    if (!u.ok || actor() !== who || !canSeeGroupControl()) return { ok: false, code: u.ok ? 'UNAUTHORIZED' : 'ADMIN_PIN_REQUIRED' };
    reportsOnly = false;
    ensureShell();
    shellEl.classList.add('is-open');
    renderTab(tab || 'home');
    refreshControlProbe();
    return { ok: true, code: controlStatus() };
  }

  async function openReports() {
    ensureMenuEntry();
    if (!canSeeReportsEntry()) return { ok: false, code: 'UNAUTHORIZED' };
    const p = PIN();
    if (!p) return { ok: false, code: 'ADMIN_PIN_REQUIRED' };
    const who = actor();
    const u = await adminSession();
    if (!u.ok && u.code === 'ADMIN_2FA_SERVICE_UNAVAILABLE') {
      notice(ERROR_TEXT.ADMIN_2FA_SERVICE_UNAVAILABLE);
      return { ok: false, code: u.code };
    }
    if (!u.ok || actor() !== who || !canSeeReportsEntry()) return { ok: false, code: u.ok ? 'UNAUTHORIZED' : 'ADMIN_PIN_REQUIRED' };
    reportsOnly = true;
    ensureShell();
    shellEl.classList.add('is-open');
    renderTab('reports');
    return { ok: true, code: 'REPORTS_ONLY' };
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
    closeDrawer();
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

  /** Top-bar "הזמן משתמש" exists only for principals who may create an invite (server still enforces). */
  function inviteMenuAllowed() {
    if (App.guestMode || !actor()) return false;
    const f = FGA();
    if (isV2()) return !!f && typeof f.visibleSections === 'function' && f.visibleSections().createInvite === true;
    return typeof App.canCreateInviteUi === 'function' && App.canCreateInviteUi() === true;
  }

  function syncInviteMenuItem() {
    const btn = document.getElementById('topBarInviteFriend');
    if (!btn) return;
    const show = inviteMenuAllowed();
    btn.hidden = !show;
    btn.style.display = show ? '' : 'none';
  }

  let chromeOwner = '';
  let renderedFingerprint = '';
  function ensureMenuEntry() {
    ensureStyles();
    if (chromeOwner !== actor()) {
      chromeOwner = actor();
      lastInvite = null;
      selectedMember = '';
      draftCaps = null;
      searchQuery = '';
      controlProbe = null;
      knownUsers = null;
      knownUsersLoading = false;
      knownUsersError = '';
      knownUsersGen++;
      dirQuery = '';
      dirFilter = 'ALL';
      knownExtra.clear();
      knownChecked.clear();
      registrationLookups.clear();
      const top = document.getElementById('sosGapTop');
      if (top) top.innerHTML = '';
      window.__SOS_GAP_LOGO_DATA__ = '';
      if (isOpen()) close();
    }
    // The only management entry is the profile-menu item "שליטה על הקבוצה".
    ['sosGroupAdminMenuEntry', 'sosGroupAdminMoreItem'].forEach((id) => {
      const stale = document.getElementById(id);
      if (stale) stale.remove();
    });
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
    const showReports = canSeeReportsEntry();
    let reportsItem = document.getElementById('sosGroupReportsMenuItem');
    if (!reportsItem && menu && showReports) {
      reportsItem = document.createElement('button');
      reportsItem.type = 'button';
      reportsItem.id = 'sosGroupReportsMenuItem';
      reportsItem.className = 'top-bar__dropdown-item';
      reportsItem.innerHTML = '<i class="fa-solid fa-flag"></i><span>דיווחים</span>';
      reportsItem.addEventListener('click', () => {
        menu.hidden = true;
        const pb = document.getElementById('topBarProfileButton');
        if (pb) pb.setAttribute('aria-expanded', 'false');
        openReports();
      });
      if (item && item.parentNode) item.parentNode.insertBefore(reportsItem, item.nextSibling);
      else menu.appendChild(reportsItem);
    }
    if (reportsItem) {
      reportsItem.hidden = !showReports;
      reportsItem.style.display = showReports ? '' : 'none';
    }
    refreshReportBadge();
    syncInviteMenuItem();
    const createBtn = document.getElementById('sosGroupCreateMenuEntry');
    if (createBtn) createBtn.remove();
    const legacy = document.getElementById('sosAdminSettingsEntry');
    if (legacy) legacy.style.display = 'none';
    const allowedNow = reportsOnly ? showReports : showControl;
    if ((!allowedNow || !pinUnlocked()) && isOpen()) close();
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
    window.addEventListener('sos-group-reports-updated', () => {
      refreshReportBadge();
      refreshChrome();
    });
    // A tab coming back to the foreground re-reads authority, so grants/revokes made meanwhile show up.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      ensureMenuEntry();
      const n = App.FirstGroupNetworkAuthority;
      if (isV2() && n && typeof n.reconcile === 'function') {
        Promise.resolve(n.reconcile('visible')).then(ensureMenuEntry, () => {});
      }
    });
    setTimeout(ensureMenuEntry, 1200);
    setInterval(ensureMenuEntry, 15000);
  }

  const api = Object.freeze({
    TABS,
    LABELS,
    canSeeGroupAdminMenu,
    canSeeGroupControl,
    canSeeReportsEntry,
    inviteMenuAllowed,
    openReports,
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
