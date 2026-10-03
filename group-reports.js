/**
 * Group Reports — private content reports for the first group (Hebrew UI).
 * A report is never published in the clear: the reporter seals it (kind 13, own key, NIP-44) and an
 * ephemeral key wraps the seal once per current moderator (kind 39010, p-tagged). Only the addressed
 * moderator can read who reported what and why. Status changes travel the same way, moderator to moderators.
 */
(function initGroupReports(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const SCHEMA = 'sos-group-report-v1';
  const WRAP_KIND = 39010;
  const SEAL_KIND = 13;
  const RUMOR_KIND = 1984;
  const GROUP_ID = 'israel-network';
  const INBOX_WINDOW_SEC = 32 * 24 * 60 * 60;
  const INBOX_LIMIT = 300;
  const WRAP_TIME_JITTER_SEC = 2 * 24 * 60 * 60;
  const PREVIEW_MAX = 280;
  const NOTE_MAX = 300;
  const MAX_RECIPIENTS = 25;
  const CLIENT_RATE_PER_HOUR = 10;
  const INBOX_PER_REPORTER_PER_DAY = 20;
  const POLL_MS = 60000;
  const REPORT_CAPS = Object.freeze(['MODERATE_CONTENT']);

  const REASONS = Object.freeze([
    { id: 'INAPPROPRIATE', label: 'תוכן לא הולם' },
    { id: 'SPAM', label: 'ספאם' },
    { id: 'HARASSMENT', label: 'הטרדה או פגיעה' },
    { id: 'COPYRIGHT', label: 'זכויות יוצרים' },
    { id: 'IMPERSONATION', label: 'התחזות' },
    { id: 'OTHER', label: 'אחר' },
  ]);
  const STATUSES = Object.freeze({
    NEW: 'חדש',
    IN_PROGRESS: 'בטיפול',
    RESOLVED: 'טופל',
    REJECTED: 'נדחה',
  });
  const REPORT_STORAGE_MODEL =
    'PRIVATE_SEALED_WRAP_PER_MODERATOR: reporter-signed kind-13 seal (NIP-44) inside an ephemeral-key kind-' +
    WRAP_KIND + ' wrap p-tagged to each current moderator; no public report, reporter, target or reason on relays';

  const opened = new Map(); // wrap id -> parsed rumor or null
  let inbox = { ok: false, rows: [], unresolved: 0, loadedAt: 0 };
  let loading = null;
  let pollTimer = null;

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(String(v || ''));
  }
  function norm(v) {
    const s = String(v || '').trim().toLowerCase();
    return isHex64(s) ? s : '';
  }
  function me() {
    return norm(App.publicKey);
  }
  function FGA() {
    return App.FirstGroupAdmin || window.SosFirstGroupAdmin || null;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function signer() {
    return App.SosCryptoSigner || null;
  }
  function relays() {
    return Array.isArray(App.relayUrls) ? App.relayUrls.filter((r) => typeof r === 'string' && /^wss?:\/\//.test(r)) : [];
  }
  function verify(ev) {
    try {
      if (typeof App.strictVerifyNostrEvent === 'function') return App.strictVerifyNostrEvent(ev) === true;
      const I = window.NostrEventIntegrity;
      if (I && typeof I.strictVerifyNostrEvent === 'function') return I.strictVerifyNostrEvent(ev) === true;
    } catch (_e) {}
    return false;
  }
  function randomHex(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function jitteredPast() {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return Math.floor(Date.now() / 1000) - (b[0] % WRAP_TIME_JITTER_SEC);
  }
  function clip(s, n) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  }

  /** Effective (verified, ACTIVE, not blocked) holders of a report capability, plus the root. */
  function authorityHasReportCap(pk) {
    const f = FGA();
    if (!f || !pk) return false;
    const a = f.authorityFor(pk);
    if (!a || !a.verified) return false;
    if (a.isRoot) return true;
    return REPORT_CAPS.some((c) => a.caps.indexOf(c) !== -1);
  }

  function moderatorRecipients(excludePk) {
    const g = GCS();
    const st = g && typeof g.getVerifiedControlState === 'function' ? g.getVerifiedControlState(GROUP_ID) : null;
    if (!st || !st.verified) return [];
    const out = [];
    const root = norm(st.rootAdminPubkey);
    if (root) out.push(root);
    Object.keys(st.capabilities || {}).forEach((pk) => {
      const p = norm(pk);
      if (p && out.indexOf(p) === -1 && authorityHasReportCap(p)) out.push(p);
    });
    return out.filter((p) => p !== excludePk).slice(0, MAX_RECIPIENTS);
  }

  function canModerateReports() {
    const f = FGA();
    if (!f || App.guestMode === true || !me()) return false;
    if (typeof f.canSeeModeration === 'function' && !f.canSeeModeration()) return false;
    return authorityHasReportCap(me());
  }

  // ---------------------------------------------------------------- transport

  function nip44() {
    const n = window.NostrTools && window.NostrTools.nip44;
    const v2 = n && n.v2;
    const getKey = v2 && ((v2.utils && v2.utils.getConversationKey) || n.getConversationKey);
    if (!v2 || typeof v2.encrypt !== 'function' || typeof getKey !== 'function') return null;
    return { encrypt: v2.encrypt.bind(v2), getKey };
  }

  async function sealFor(rumor, recipient) {
    const s = signer();
    const content = await Promise.resolve(s.nip44P2pEncrypt(JSON.stringify(rumor), recipient));
    const seal = await Promise.resolve(
      s.signCallSeal({ kind: SEAL_KIND, created_at: jitteredPast(), tags: [], content, pubkey: rumor.pubkey })
    );
    if (!verify(seal)) throw Object.assign(new Error('seal'), { code: 'SEAL_INVALID' });
    return seal;
  }

  function wrapSeal(seal, recipient) {
    const NT = window.NostrTools;
    const n = nip44();
    if (!NT || !n || typeof NT.generateSecretKey !== 'function' || typeof NT.finalizeEvent !== 'function') {
      throw Object.assign(new Error('nip44'), { code: 'CRYPTO_UNAVAILABLE' });
    }
    const sk = NT.generateSecretKey();
    const content = n.encrypt(JSON.stringify(seal), n.getKey(sk, recipient));
    const wrap = NT.finalizeEvent(
      { kind: WRAP_KIND, created_at: jitteredPast(), tags: [['d', randomHex(16)], ['p', recipient]], content },
      sk
    );
    sk.fill(0);
    return wrap;
  }

  async function publish(ev) {
    const list = relays();
    if (!App.pool || !list.length) throw Object.assign(new Error('pool'), { code: 'NO_RELAYS' });
    const r = App.pool.publish(list, ev);
    if (Array.isArray(r)) {
      await Promise.any(r.map((p) => Promise.resolve(p)));
    } else {
      await r;
    }
  }

  async function sendToModerators(body, excludePk) {
    const s = signer();
    const self = me();
    if (!self || !s || typeof s.signCallSeal !== 'function' || typeof s.nip44P2pEncrypt !== 'function') {
      return { ok: false, code: 'NO_IDENTITY' };
    }
    const recipients = moderatorRecipients(excludePk);
    if (!recipients.length) return { ok: false, code: 'NO_MODERATORS' };
    const rumorBase = { kind: RUMOR_KIND, pubkey: self, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(body) };
    const rumor = Object.assign({ id: window.NostrTools.getEventHash(rumorBase) }, rumorBase);
    let delivered = 0;
    for (const pk of recipients) {
      try {
        const seal = await sealFor(rumor, pk);
        await publish(wrapSeal(seal, pk));
        delivered += 1;
      } catch (_e) {}
    }
    return delivered ? { ok: true, code: 'DELIVERED', delivered, recipients: recipients.length } : { ok: false, code: 'PUBLISH_FAILED' };
  }

  // ---------------------------------------------------------------- submit (reporter)

  function rateKey() {
    return 'sos_group_reports_sent_v1:' + me();
  }
  function readSent() {
    try {
      const v = JSON.parse(localStorage.getItem(rateKey()) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && typeof x.t === 'number' && Date.now() - x.t < 7 * 864e5) : [];
    } catch (_e) {
      return [];
    }
  }
  function rateCheck(targetId) {
    const sent = readSent();
    if (sent.some((x) => x.id === targetId)) return 'ALREADY_REPORTED';
    if (sent.filter((x) => Date.now() - x.t < 3600e3).length >= CLIENT_RATE_PER_HOUR) return 'RATE_LIMITED';
    return '';
  }
  function rememberSent(targetId) {
    const sent = readSent();
    sent.push({ id: targetId, t: Date.now() });
    try {
      localStorage.setItem(rateKey(), JSON.stringify(sent.slice(-200)));
    } catch (_e) {}
  }

  /** target: { id, pubkey, kind, parentId, preview } */
  async function submitReport(target, reasonId, note) {
    if (App.guestMode === true || !me()) return { ok: false, code: 'LOGIN_REQUIRED' };
    const t = target || {};
    const id = norm(t.id);
    const author = norm(t.pubkey);
    if (!id || !author) return { ok: false, code: 'BAD_TARGET' };
    if (author === me()) return { ok: false, code: 'SELF_REPORT' };
    if (!REASONS.some((r) => r.id === reasonId)) return { ok: false, code: 'BAD_REASON' };
    const limited = rateCheck(id);
    if (limited) return { ok: false, code: limited };
    const body = {
      schema: SCHEMA,
      type: 'REPORT',
      groupId: GROUP_ID,
      reportId: randomHex(16),
      target: {
        id,
        pubkey: author,
        kind: Number(t.kind) || 1,
        parentId: norm(t.parentId),
        preview: clip(t.preview, PREVIEW_MAX),
      },
      reason: reasonId,
      note: reasonId === 'OTHER' ? clip(note, NOTE_MAX) : '',
    };
    const res = await sendToModerators(body, author);
    if (res.ok) rememberSent(id);
    return res;
  }

  // ---------------------------------------------------------------- inbox (moderators)

  async function query(filter) {
    const list = relays();
    if (!App.pool || !list.length) return [];
    try {
      if (typeof App.pool.querySync === 'function') {
        const r = await App.pool.querySync(list, filter, { maxWait: 6000 });
        return Array.isArray(r) ? r : (r && r.events) || [];
      }
      if (typeof App.pool.list === 'function') return (await App.pool.list(list, [filter])) || [];
    } catch (_e) {}
    return [];
  }

  async function openWrap(wrap) {
    if (opened.has(wrap.id)) return opened.get(wrap.id);
    let out = null;
    try {
      const s = signer();
      if (wrap.kind !== WRAP_KIND || !verify(wrap)) throw new Error('wrap');
      const p = (wrap.tags || []).find((t) => Array.isArray(t) && t[0] === 'p');
      if (!p || norm(p[1]) !== me()) throw new Error('p');
      const seal = JSON.parse(await Promise.resolve(s.nip44P2pDecrypt(wrap.content, wrap.pubkey)));
      if (!seal || seal.kind !== SEAL_KIND || !verify(seal)) throw new Error('seal');
      const rumor = JSON.parse(await Promise.resolve(s.nip44P2pDecrypt(seal.content, seal.pubkey)));
      if (!rumor || rumor.kind !== RUMOR_KIND || norm(rumor.pubkey) !== norm(seal.pubkey)) throw new Error('rumor');
      const body = JSON.parse(String(rumor.content || ''));
      if (!body || body.schema !== SCHEMA || body.groupId !== GROUP_ID) throw new Error('schema');
      out = { from: norm(seal.pubkey), createdAt: Number(rumor.created_at) || 0, body };
    } catch (_e) {
      out = null;
    }
    opened.set(wrap.id, out);
    return out;
  }

  function contentOf(ev) {
    return clip(ev && ev.content, PREVIEW_MAX);
  }

  async function loadInbox() {
    if (!canModerateReports()) {
      inbox = { ok: false, code: 'UNAUTHORIZED', rows: [], unresolved: 0, loadedAt: Date.now() };
      return inbox;
    }
    if (loading) return loading;
    const self = me();
    loading = (async () => {
      const wraps = await query({ kinds: [WRAP_KIND], '#p': [self], since: Math.floor(Date.now() / 1000) - INBOX_WINDOW_SEC, limit: INBOX_LIMIT });
      const items = [];
      for (const w of wraps) {
        const o = await openWrap(w);
        if (o) items.push(o);
      }
      items.sort((a, b) => a.createdAt - b.createdAt);
      const byTarget = new Map();
      const perReporterDay = new Map();
      const statusUpdates = [];
      items.forEach((it) => {
        const b = it.body;
        if (b.type === 'STATUS') {
          statusUpdates.push(it);
          return;
        }
        if (b.type !== 'REPORT' || !b.target || !isHex64(b.target.id) || !REASONS.some((r) => r.id === b.reason)) return;
        const dayKey = it.from + ':' + Math.floor(it.createdAt / 86400);
        const n = (perReporterDay.get(dayKey) || 0) + 1;
        perReporterDay.set(dayKey, n);
        if (n > INBOX_PER_REPORTER_PER_DAY) return;
        let row = byTarget.get(b.target.id);
        if (!row) {
          row = {
            targetId: b.target.id,
            claimedAuthor: norm(b.target.pubkey),
            kind: Number(b.target.kind) || 1,
            parentId: norm(b.target.parentId),
            preview: clip(b.target.preview, PREVIEW_MAX),
            reporters: new Set(),
            reasons: {},
            notes: [],
            firstAt: it.createdAt,
            lastAt: it.createdAt,
            status: 'NEW',
            statusBy: '',
            statusAt: 0,
          };
          byTarget.set(b.target.id, row);
        }
        if (row.reporters.has(it.from)) return;
        row.reporters.add(it.from);
        row.reasons[b.reason] = (row.reasons[b.reason] || 0) + 1;
        if (b.note) row.notes.push(clip(b.note, NOTE_MAX));
        row.lastAt = Math.max(row.lastAt, it.createdAt);
      });
      statusUpdates.forEach((it) => {
        const b = it.body;
        const row = byTarget.get(norm(b.targetId));
        if (!row || !STATUSES[b.status] || !authorityHasReportCap(it.from)) return;
        if (it.createdAt >= row.statusAt) {
          row.status = b.status;
          row.statusBy = it.from;
          row.statusAt = it.createdAt;
        }
      });
      const ids = Array.from(byTarget.keys());
      const actual = new Map();
      if (ids.length) {
        (await query({ ids: ids.slice(0, 200) })).forEach((ev) => {
          if (ev && ids.indexOf(ev.id) !== -1 && verify(ev)) actual.set(ev.id, ev);
        });
      }
      const deleted = App.deletedEventIds instanceof Set ? App.deletedEventIds : new Set();
      const rows = ids.map((id) => {
        const r = byTarget.get(id);
        const ev = actual.get(id) || (App.postsById instanceof Map ? App.postsById.get(id) : null);
        return {
          targetId: id,
          reportedPubkey: ev ? norm(ev.pubkey) : r.claimedAuthor,
          authorVerified: !!ev,
          event: ev || null,
          kind: ev ? ev.kind : r.kind,
          parentId: r.parentId,
          preview: ev ? contentOf(ev) : r.preview,
          removed: deleted.has(id),
          reportCount: r.reporters.size,
          reasons: Object.keys(r.reasons).map((k) => ({ id: k, count: r.reasons[k] })),
          notes: r.notes.slice(0, 5),
          firstAt: r.firstAt,
          lastAt: r.lastAt,
          status: r.status,
          statusBy: r.statusBy,
          statusAt: r.statusAt,
        };
      });
      rows.sort((a, b) => b.lastAt - a.lastAt);
      const unresolved = rows.filter((r) => r.status === 'NEW' || r.status === 'IN_PROGRESS').length;
      inbox = { ok: true, code: 'OK', rows, unresolved, loadedAt: Date.now() };
      try {
        window.dispatchEvent(new CustomEvent('sos-group-reports-updated', { detail: { unresolved } }));
      } catch (_e) {}
      return inbox;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function setStatus(targetId, status) {
    if (!canModerateReports()) return { ok: false, code: 'UNAUTHORIZED' };
    const id = norm(targetId);
    if (!id || !STATUSES[status]) return { ok: false, code: 'BAD_STATUS' };
    const res = await sendToModerators({ schema: SCHEMA, type: 'STATUS', groupId: GROUP_ID, targetId: id, status }, '');
    if (res.ok) {
      const row = inbox.rows.find((r) => r.targetId === id);
      if (row) {
        row.status = status;
        row.statusBy = me();
        row.statusAt = Math.floor(Date.now() / 1000);
      }
      inbox.unresolved = inbox.rows.filter((r) => r.status === 'NEW' || r.status === 'IN_PROGRESS').length;
      try {
        window.dispatchEvent(new CustomEvent('sos-group-reports-updated', { detail: { unresolved: inbox.unresolved } }));
      } catch (_e) {}
    }
    return res;
  }

  /** Resolution rows for the admin activity log (moderators only; no reporter or reason). */
  function resolutionAudit() {
    if (!canModerateReports()) return [];
    return inbox.rows
      .filter((r) => r.statusBy && (r.status === 'RESOLVED' || r.status === 'REJECTED'))
      .map((r) => ({ action: 'REPORT_' + r.status, actor: r.statusBy, target: r.reportedPubkey, createdAt: r.statusAt, detail: '' }));
  }

  function snapshot() {
    return inbox;
  }

  function startPolling() {
    if (pollTimer) return;
    const tick = () => {
      if (canModerateReports() && document.visibilityState !== 'hidden') loadInbox().catch(() => {});
    };
    pollTimer = setInterval(tick, POLL_MS);
    setTimeout(tick, 4000);
  }

  // ---------------------------------------------------------------- report dialog

  function ensureDialogStyles() {
    if (document.getElementById('sos-group-report-style')) return;
    const st = document.createElement('style');
    st.id = 'sos-group-report-style';
    st.textContent =
      '#sosReportDialog{position:fixed;inset:0;z-index:12400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);direction:rtl;}' +
      '#sosReportDialog .srd-box{background:#161a23;color:#f2f2f2;border-radius:14px;padding:16px;width:min(380px,92vw);border:1px solid rgba(255,255,255,.12);}' +
      '#sosReportDialog h3{margin:0 0 10px;font-size:1.05rem;}' +
      '#sosReportDialog label{display:flex;gap:8px;align-items:center;padding:7px 4px;cursor:pointer;}' +
      '#sosReportDialog textarea{width:100%;box-sizing:border-box;background:#1b1e27;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px;font:inherit;margin-top:6px;}' +
      '#sosReportDialog .srd-actions{display:flex;gap:8px;margin-top:12px;}' +
      '#sosReportDialog button{border:0;border-radius:8px;padding:8px 14px;background:#2a3142;color:#fff;cursor:pointer;font:inherit;}' +
      '#sosReportDialog button.primary{background:#a83a3a;}' +
      '#sosReportDialog button[disabled]{opacity:.5;cursor:not-allowed;}' +
      '#sosReportDialog .srd-msg{min-height:1.2em;font-size:.88rem;margin-top:8px;}';
    document.head.appendChild(st);
  }

  const SUBMIT_ERRORS = {
    ALREADY_REPORTED: 'כבר דיווחת על התוכן הזה.',
    RATE_LIMITED: 'יותר מדי דיווחים בזמן קצר. נסו שוב מאוחר יותר.',
    SELF_REPORT: 'אי אפשר לדווח על תוכן שלך.',
    NO_MODERATORS: 'אין כרגע מנהלי תוכן זמינים לקבלת דיווחים.',
    LOGIN_REQUIRED: 'יש להתחבר כדי לדווח.',
  };

  /** Opens the reasons dialog for a post / video / comment. Guests are asked to log in first. */
  function openReportDialog(target) {
    if (App.guestMode === true || !me()) {
      if (typeof App.requireAuth === 'function') App.requireAuth('כדי לדווח על תוכן יש להתחבר');
      return { ok: false, code: 'LOGIN_REQUIRED' };
    }
    if (norm(target && target.pubkey) === me()) return { ok: false, code: 'SELF_REPORT' };
    ensureDialogStyles();
    const old = document.getElementById('sosReportDialog');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'sosReportDialog';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="srd-box"><h3>דיווח על תוכן</h3>' +
      '<div class="srd-reasons">' +
      REASONS.map((r) => '<label><input type="radio" name="sosReportReason" value="' + r.id + '"> <span>' + r.label + '</span></label>').join('') +
      '</div><textarea id="sosReportNote" rows="2" maxlength="' + NOTE_MAX + '" placeholder="פרטים נוספים (לא חובה)" hidden></textarea>' +
      '<div class="srd-msg" id="sosReportMsg" role="status"></div>' +
      '<div class="srd-actions"><button type="button" class="primary" id="sosReportSend" disabled>שליחת דיווח</button>' +
      '<button type="button" id="sosReportCancel">ביטול</button></div>' +
      '<p style="font-size:.78rem;opacity:.7;margin:10px 0 0">הדיווח נשלח באופן פרטי למנהלי הקבוצה בלבד.</p></div>';
    document.body.appendChild(el);
    const send = el.querySelector('#sosReportSend');
    const note = el.querySelector('#sosReportNote');
    const msg = el.querySelector('#sosReportMsg');
    const closeDialog = () => el.remove();
    el.addEventListener('click', (ev) => {
      if (ev.target === el) closeDialog();
    });
    el.querySelector('#sosReportCancel').addEventListener('click', closeDialog);
    el.addEventListener('change', () => {
      const pick = el.querySelector('input[name="sosReportReason"]:checked');
      send.disabled = !pick;
      note.hidden = !(pick && pick.value === 'OTHER');
    });
    send.addEventListener('click', async () => {
      const pick = el.querySelector('input[name="sosReportReason"]:checked');
      if (!pick) return;
      send.disabled = true;
      msg.textContent = 'שולח…';
      let res;
      try {
        res = await submitReport(target, pick.value, note.value);
      } catch (_e) {
        res = { ok: false, code: 'PUBLISH_FAILED' };
      }
      if (res.ok) {
        msg.textContent = 'תודה. הדיווח נשלח למנהלי הקבוצה.';
        setTimeout(closeDialog, 1400);
      } else {
        msg.textContent = SUBMIT_ERRORS[res.code] || 'שליחת הדיווח נכשלה. נסו שוב.';
        send.disabled = res.code === 'ALREADY_REPORTED' || res.code === 'SELF_REPORT';
      }
    });
    return { ok: true, code: 'DIALOG_OPEN' };
  }

  const api = Object.freeze({
    SCHEMA,
    WRAP_KIND,
    REASONS,
    STATUSES,
    REPORT_STORAGE_MODEL,
    moderatorRecipients,
    canModerateReports,
    submitReport,
    openReportDialog,
    loadInbox,
    setStatus,
    snapshot,
    resolutionAudit,
  });
  App.GroupReports = api;
  window.SosGroupReports = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPolling);
  else startPolling();
})(typeof window !== 'undefined' ? window : globalThis);
