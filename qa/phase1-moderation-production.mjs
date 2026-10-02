/**
 * Phase 1 — production moderation acceptance (https://sos010.com), disposable identities and content only.
 *
 * Stages (run in order; owner actions in between):
 *   setup <inviteUrl>  M (moderator candidate) redeems the owner's invite -> ACTIVE member, sets a profile name.
 *                      B (author) publishes two disposable posts and a comment. M deletes its OWN post (no cap).
 *                      M tries to delete B's post -> must be DENIED (no MODERATE_CONTENT).
 *   moderate           after ROOT grants MODERATE_CONTENT to M: M enrolls its own disposable Admin PIN (kept in
 *                      memory only), deletes B's post and B's comment through feed.js; a fresh guest browser must
 *                      hide both.
 *   revoked            after ROOT revokes: M tries to delete B's second post -> DENIED, nothing published.
 *
 * Identities live in persistent browser profiles under %TEMP%\sos-p1-mod (outside the repo). The state file
 * holds only public data (pubkeys, event ids). Nothing secret is printed or written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = 'https://sos010.com';
const GROUP = 'israel-network';
const RELAYS = ['wss://relay.snort.social', 'wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh'];
const WORK = path.join(os.tmpdir(), 'sos-p1-mod');
const STATE = path.join(WORK, 'state.json');
const STAGE = process.argv[2] || '';
const MODP = process.env.P1_MOD === 'M2' ? 'M2' : 'M';
const OUT = path.join(ROOT, 'qa', `phase1-moderation-production-${STAGE || 'none'}-report.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));

const report = { gate: 'PHASE1_MODERATION_PRODUCTION', stage: STAGE, status: 'FAIL', ts: new Date().toISOString(), results: {} };
const SECRET_SHAPE = /nsec1[a-z0-9]{20,}/i;
const set = (k, ok, detail) => {
  let d = detail === undefined ? null : detail;
  if (d !== null && SECRET_SHAPE.test(JSON.stringify(d))) d = '[redacted]';
  report.results[k] = { ok: !!ok, detail: d };
  console.log(ok ? 'PASS' : 'FAIL', k, d === null ? '' : JSON.stringify(d).slice(0, 300));
};

function queryRelay(url, filter, ms = 8000) {
  return new Promise((resolve) => {
    const out = [];
    let ws;
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch (_e) {}
      resolve(out);
    };
    try {
      ws = new WebSocket(url);
    } catch (_e) {
      return resolve(out);
    }
    const t = setTimeout(fin, ms);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'q', filter]));
    ws.onmessage = (m) => {
      try {
        const a = JSON.parse(String(m.data));
        if (a[0] === 'EVENT') out.push(a[2]);
        if (a[0] === 'EOSE') {
          clearTimeout(t);
          fin();
        }
      } catch (_e) {}
    };
    ws.onerror = () => {
      clearTimeout(t);
      fin();
    };
  });
}
let viaPage = null;
async function onRelays(filter) {
  const per = await Promise.all(RELAYS.map((r) => queryRelay(r, filter)));
  if (viaPage && !viaPage.isClosed()) {
    const fromApp = await viaPage
      .evaluate(async (f) => {
        const App = window.NostrApp;
        const r = await App.pool.querySync(App.relayUrls, f, { maxWait: 8000 });
        return Array.isArray(r) ? r : [];
      }, filter)
      .catch(() => []);
    per.push(fromApp);
  }
  const byId = new Map();
  per.flat().forEach((e) => byId.set(e.id, e));
  return Array.from(byId.values());
}

async function openProfile(name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, name), { headless: true, ...devices['Pixel 7'] });
  ctx.on('dialog', (d) => d.accept().catch(() => {}));
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${MAIN}/videos.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.pool && !!window.SosCryptoWorkerVault && !!window.NostrApp?.ModerationPolicy, null, { polling: 300, timeout: 120000 });
  return { ctx, page };
}

async function ensureIdentity(page) {
  return page.evaluate(async () => {
    const App = window.NostrApp;
    const ok = () => /^[0-9a-f]{64}$/.test(String(App.publicKey || '')) && App.guestMode !== true && App.SosCryptoSigner?.hasIdentityKey?.() === true;
    for (let i = 0; i < 40 && !ok(); i++) await new Promise((r) => setTimeout(r, 250));
    if (ok()) return { pk: String(App.publicKey).toLowerCase(), created: false };
    localStorage.setItem('SOS_CRYPTO_WORKER_AUTHORITATIVE', '1');
    window.SOS_CRYPTO_WORKER_AUTHORITATIVE = true;
    window.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ = true;
    const c = await window.SosCryptoWorkerVault.createBrowserIdentity({ createNonce: 'c' + Date.now() + '-qa' });
    if (!c || !c.ok) return { pk: '', created: false };
    App.privateKey = null;
    App.publicKey = c.meta.pubkey;
    App.guestMode = false;
    App.identityState = 'IDENTITY_OK';
    await window.SosCryptoWorkerVault.tryActivateAuthoritative();
    if (typeof App.ensureKeys === 'function') App.ensureKeys();
    return { pk: String(App.publicKey).toLowerCase(), created: true };
  });
}

async function setName(page, name) {
  return page.evaluate(async (n) => {
    const App = window.NostrApp;
    App.profile = Object.assign({}, App.profile || {}, { name: n, bio: 'QA disposable test identity' });
    const r = await App.publishProfileMetadata();
    return { ok: !!(r && r.ok), acks: r && r.acks };
  }, name);
}

async function publishNote(page, content, parentId) {
  return page.evaluate(
    async ({ content, parentId, group }) => {
      const App = window.NostrApp;
      const tags = [['t', group]];
      if (parentId) {
        tags.unshift(['e', parentId, App.relayUrls?.[0] || '', 'reply']);
        tags.unshift(['e', parentId, App.relayUrls?.[0] || '', 'root']);
      }
      const ev = await App.SosCryptoSigner.signFeedEvent({ kind: 1, pubkey: App.publicKey, created_at: Math.floor(Date.now() / 1000), tags, content });
      const list = App.pool.publish(App.relayUrls, ev);
      const settled = await Promise.allSettled((Array.isArray(list) ? list : [list]).map((p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('T')), 10000))])));
      return { id: ev.id, ev, acks: settled.filter((s) => s.status === 'fulfilled').length };
    },
    { content, parentId: parentId || '', group: GROUP }
  );
}

/** Loads the target into this page's feed state (as the feed would) and runs the real feed.js delete path. */
async function deleteAs(page, target, isComment) {
  return page.evaluate(
    async ({ target, isComment }) => {
      const App = window.NostrApp;
      const MP = App.ModerationPolicy;
      if (isComment) {
        const parent = (target.tags.find((t) => t[0] === 'e') || [])[1];
        if (!(App.commentsByParent instanceof Map)) App.commentsByParent = new Map();
        if (!App.commentsByParent.has(parent)) App.commentsByParent.set(parent, new Map());
        App.commentsByParent.get(parent).set(target.id, target);
      } else {
        if (!(App.postsById instanceof Map)) App.postsById = new Map();
        App.postsById.set(target.id, target);
      }
      if (App.eventAuthorById instanceof Map) App.eventAuthorById.set(target.id, target.pubkey);
      await App.FirstGroupNetworkAuthority?.reconcile?.('moderation-test');
      const policy = MP.canViewerRemoveContent(App.publicKey, target.pubkey, 1);
      const before = Date.now();
      if (isComment) {
        const parent = (target.tags.find((t) => t[0] === 'e') || [])[1];
        await App.deleteComment(target.id, parent);
      } else {
        await App.deletePost(target.id);
      }
      await new Promise((r) => setTimeout(r, 4000));
      const tomb = App.deletionTombstones instanceof Map ? App.deletionTombstones.get(target.id) : null;
      return { policy: policy.code, policyOk: policy.ok, publishState: tomb ? tomb.publishState : '', deletionEventId: tomb ? tomb.deletionEventId || '' : '', ms: Date.now() - before };
    },
    { target, isComment: !!isComment }
  );
}

async function guestSeesRemoved(browser, ids) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(`${MAIN}/videos.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.pool && !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.(), null, { polling: 500, timeout: 120000 });
  const res = await page.evaluate(async (ids) => {
    const App = window.NostrApp;
    const end = Date.now() + 45000;
    const removed = () => ids.map((id) => (App.deletedEventIds instanceof Set && App.deletedEventIds.has(id)) || (App.deletionTombstones instanceof Map && App.deletionTombstones.has(id)));
    while (Date.now() < end && !removed().every(Boolean)) await new Promise((r) => setTimeout(r, 1000));
    return removed();
  }, ids);
  await ctx.close();
  return res;
}

async function stageSetup(browser, inviteUrl) {
  const code = String(new URL(inviteUrl).searchParams.get('invite') || '').trim().toUpperCase();
  set('INVITE_URL_PARSED', !!code, { hasCode: !!code });
  const M = await openProfile('M');
  viaPage = M.page;
  const idM = await ensureIdentity(M.page);
  st.M = idM.pk;
  const nameM = 'QA Moderator ' + st.M.slice(0, 4);
  st.nameM = nameM;
  set('M_IDENTITY', /^[0-9a-f]{64}$/.test(idM.pk), { created: idM.created, pk8: idM.pk.slice(0, 8) });
  set('M_PROFILE_NAME_PUBLISHED', (await setName(M.page, nameM)).ok, { name: nameM });
  const red = await M.page.evaluate(async (code) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('redeem');
    const v = await App.validateInvite({ code });
    if (!v.ok) return { ok: false, stage: 'validate', code: v.code, error: v.error };
    const m = await App.markInviteUsed({ code, inviterPubkey: v.inviterPubkey, inviteEventId: v.inviteEvent.id });
    return { ok: !!m.ok, stage: 'mark', inviter8: String(v.inviterPubkey || '').slice(0, 8), error: m.error || null };
  }, code);
  set('INVITE_REDEEM_PRODUCTION', red.ok, red);
  const active = await M.page.evaluate(async (pk) => {
    const App = window.NostrApp;
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      await App.FirstGroupNetworkAuthority.reconcile('readback');
      const s = App.MembershipState.getMemberSnapshot(pk);
      if (s && s.status === 'ACTIVE') {
        const st2 = App.GroupControlState.getVerifiedControlState();
        const caps = (st2.capabilities || {})[s.record.issuerPubkey] || [];
        return { status: s.status, issuer8: String(s.record.issuerPubkey || '').slice(0, 8), issuerCaps: caps, transition: s.record.transition };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { status: 'NOT_ACTIVE' };
  }, st.M);
  set('ADMISSION_FINALIZATION_PRODUCTION', active.status === 'ACTIVE' && active.issuerCaps.join() === 'FINALIZE_MEMBERSHIP_ADMISSION', active);
  await M.ctx.close();
  await stageContent(code);
}

async function stageContent(code) {
  const M = await openProfile('M');
  viaPage = M.page;
  const idM = await ensureIdentity(M.page);
  set('M_SAME_IDENTITY', idM.pk === st.M, { same: idM.pk === st.M });
  viaPage = M.page;
  const B = await openProfile('B');
  const idB = await ensureIdentity(B.page);
  st.B = idB.pk;
  set('B_IDENTITY', /^[0-9a-f]{64}$/.test(idB.pk), { pk8: idB.pk.slice(0, 8) });
  await setName(B.page, 'QA Author ' + st.B.slice(0, 4));
  if (code) {
    const reuse = await B.page.evaluate(async (code) => {
      await window.NostrApp.FirstGroupNetworkAuthority.reconcile('reuse');
      const v = await window.NostrApp.validateInvite({ code });
      return { ok: v.ok, code: v.code === code ? '' : v.code || '', error: v.error || '' };
    }, code);
    set('INVITE_REUSE_REJECTED', reuse.ok === false && reuse.code === 'ALREADY_REDEEMED', reuse);
  }
  const tag = crypto.randomBytes(3).toString('hex');
  const p1 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — פוסט לבדיקת מחיקה על ידי מנהל תוכן.`);
  const c1 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — תגובה לבדיקת מחיקה.`, p1.id);
  const p2 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — פוסט שני לבדיקת ביטול הרשאה.`);
  const p3 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — פוסט לבדיקת דיווח.`);
  Object.assign(st, { post1: p1.id, comment1: c1.id, post2: p2.id, post3: p3.id });
  set('B_DISPOSABLE_CONTENT_PUBLISHED', p1.acks > 0 && c1.acks > 0 && p2.acks > 0 && p3.acks > 0, { acks: [p1.acks, c1.acks, p2.acks, p3.acks] });
  await B.ctx.close();
  await sleep(3000);
  const mPost = await publishNote(M.page, `בדיקת QA זמנית (${tag}) — פוסט של משתמש לבדיקת חסימה.`);
  const mComment = await publishNote(M.page, `בדיקת QA זמנית (${tag}) — תגובה של משתמש לבדיקת חסימה.`, p2.id);
  Object.assign(st, { mPost: mPost.id, mComment: mComment.id });
  set('M_BLOCK_TEST_CONTENT_PUBLISHED', mPost.acks > 0 && mComment.acks > 0, { acks: [mPost.acks, mComment.acks] });
  st.events = Object.fromEntries([p1, c1, p2, p3, mPost, mComment].map((x) => [x.id, x.ev]));
  saveState();
  await sleep(2000);
  const evs = await onRelays({ ids: [st.post1, st.comment1, st.post2, st.post3, st.mPost, st.mComment] });
  set('DISPOSABLE_CONTENT_ON_RELAYS', evs.length === 6, { found: evs.length });

  const own = await publishNote(M.page, `בדיקת QA זמנית (${tag}) — פוסט של המשתמש עצמו.`);
  await sleep(2000);
  const ownEv = own.ev;
  const ownDel = ownEv ? await deleteAs(M.page, ownEv, false) : { policy: 'NO_EVENT' };
  await sleep(2000);
  const kind5 = await onRelays({ kinds: [5], authors: [st.M], '#e': [own.id] });
  set('USER_CAN_DELETE_OWN_CONTENT', ownDel.policy === 'OWN_CONTENT' && ownDel.publishState === 'confirmed' && kind5.length > 0, { policy: ownDel.policy, publish: ownDel.publishState, kind5: kind5.length });

  const denied = await deleteAs(M.page, st.events[st.post1], false);
  await sleep(2000);
  const mod = await onRelays({ kinds: [39002], authors: [st.M] });
  set('MODERATE_DENIED_WITHOUT_CAP', denied.policyOk === false && denied.policy === 'NO_MODERATE_CAP' && mod.length === 0, { policy: denied.policy, moderationEvents: mod.length });
  await M.ctx.close();
}

async function stageModerate(browser) {
  const M = await openProfile(MODP);
  viaPage = M.page;
  const id = await ensureIdentity(M.page);
  set('M_SAME_IDENTITY', id.pk === st[MODP], { same: id.pk === st[MODP] });
  const view = await M.page.evaluate(async (pk) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('grant-check');
    const s = App.GroupControlState.getVerifiedControlState();
    return { epoch: s.controlEpoch, caps: (s.capabilities || {})[pk] || [] };
  }, st[MODP]);
  set('MODERATE_CONTENT_GRANT', view.caps.indexOf('MODERATE_CONTENT') !== -1, view);
  const pin = await M.page.evaluate(async () => {
    const C = window.NostrApp.Admin2faClient;
    for (;;) {
      const p = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      if (!C.isTrivialPin(p)) {
        const e = await C.enroll(p, p);
        if (e && e.ok) return { ok: true, active: C.isActive() };
        if (e && e.code === 'ALREADY_ENROLLED') return { ok: false, code: e.code };
        return { ok: false, code: e && e.code };
      }
    }
  });
  set('M_ADMIN_PIN_ENROLLED', pin.ok && pin.active, pin);
  const diag = await M.page.evaluate(async (t) => {
    const App = window.NostrApp;
    const MP = App.ModerationPolicy;
    const draft = MP.buildModerationDraft(t, MP.ACTION_HIDE);
    const ev = await App.SosCryptoSigner.signModerationAction(draft);
    const r = await App.Admin2faClient.attest(ev, { target: t });
    return { ok: !!(r && r.ok), code: r && r.code, reason: r && r.reason, detail: r && r.detail, local: MP.canModerateContent(App.publicKey, t.pubkey, 1).code };
  }, st.events[st.post1]);
  set('MODERATION_ATTEST_DIAG', diag.ok, diag);
  const post = await deleteAs(M.page, st.events[st.post1], false);
  const comment = await deleteAs(M.page, st.events[st.comment1], true);
  await sleep(3000);
  const modPost = await onRelays({ kinds: [39002], authors: [st[MODP]], '#d': [st.post1] });
  const modComment = await onRelays({ kinds: [39002], authors: [st[MODP]], '#d': [st.comment1] });
  set('MODERATE_POST_DELETE_PUBLISHED', post.policy === 'MODERATE_CONTENT' && post.publishState === 'confirmed' && modPost.length > 0, { policy: post.policy, publish: post.publishState, onRelays: modPost.length });
  set('MODERATE_COMMENT_DELETE_PUBLISHED', comment.policy === 'MODERATE_CONTENT' && comment.publishState === 'confirmed' && modComment.length > 0, { policy: comment.policy, publish: comment.publishState, onRelays: modComment.length });

  // private report: a fresh logged-in reporter R reports B's post3; the moderator M reads and resolves it
  const R = await openProfile('R');
  const idR = await ensureIdentity(R.page);
  st.R = idR.pk;
  const target = st.events[st.post3];
  const submit = await R.page.evaluate(async (t) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('report');
    const G = App.GroupReports;
    const tgt = { id: t.id, pubkey: t.pubkey, kind: 1, preview: t.content };
    const first = await G.submitReport(tgt, 'SPAM', '');
    const again = await G.submitReport(tgt, 'SPAM', '');
    return { code: first.code, delivered: first.delivered || 0, recipients: first.recipients || 0, again: again.code };
  }, target);
  await R.ctx.close();
  if (submit.code === 'DELIVERED') st.reportDelivered = { delivered: submit.delivered, recipients: submit.recipients };
  const priorDelivery = submit.code === 'ALREADY_REPORTED' && !!st.reportDelivered;
  set('REPORT_SUBMIT', ((submit.code === 'DELIVERED' && submit.delivered >= 1) || priorDelivery) && submit.again === 'ALREADY_REPORTED', Object.assign({ priorDelivery: st.reportDelivered || null }, submit));
  await sleep(4000);
  const wraps = await onRelays({ kinds: [39010], '#p': [st[MODP]], since: Math.floor(Date.now() / 1000) - 3 * 86400 });
  const blob = JSON.stringify(wraps);
  const privacy = {
    wrapsToModerator: wraps.length,
    reporterVisible: blob.includes(st.R),
    targetVisible: blob.includes(st.post3) || blob.includes(st.B),
    reasonVisible: /SPAM|ספאם/.test(blob),
    wrapAuthorsEphemeral: wraps.every((w) => w.pubkey !== st.R),
  };
  set('REPORT_PRIVATE_STORAGE', privacy.wrapsToModerator >= 1 && !privacy.reporterVisible && !privacy.targetVisible && !privacy.reasonVisible && privacy.wrapAuthorsEphemeral, privacy);
  const inbox = await M.page.evaluate(async (id) => {
    const App = window.NostrApp;
    const G = App.GroupReports;
    let s = await G.loadInbox();
    for (let i = 0; i < 6 && !s.rows.some((r) => r.targetId === id); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      s = await G.loadInbox();
    }
    const row = s.rows.find((r) => r.targetId === id);
    App.GroupAdminProductUi.ensureMenuEntry();
    await new Promise((r) => setTimeout(r, 500));
    const badge = document.querySelector('#sosGroupControlMenuItem .sos-report-badge');
    return { ok: s.ok, unresolved: s.unresolved, row: row ? { status: row.status, count: row.reportCount, reasons: row.reasons.map((x) => x.id), verified: row.authorVerified } : null, badge: badge ? badge.textContent : '' };
  }, st.post3);
  set('MODERATION_INBOX', inbox.ok && !!inbox.row && inbox.row.status === 'NEW' && inbox.row.reasons.includes('SPAM') && inbox.row.count === 1, inbox);
  set('REPORT_BADGE', inbox.unresolved >= 1 && /\d/.test(inbox.badge), { unresolved: inbox.unresolved, badge: inbox.badge });
  const resolve = await M.page.evaluate(async (t) => {
    const App = window.NostrApp;
    const rm = await App.moderateRemoveEvent(t);
    const stRes = rm && rm.ok ? await App.GroupReports.setStatus(t.id, 'RESOLVED') : null;
    await new Promise((r) => setTimeout(r, 3000));
    const s = await App.GroupReports.loadInbox();
    const row = s.rows.find((r) => r.targetId === t.id);
    return { remove: rm && rm.code, removeOk: !!(rm && rm.ok), status: row ? row.status : '', setStatus: stRes && (stRes.code || stRes.ok), audit: App.GroupReports.resolutionAudit().map((a) => a.action) };
  }, target);
  set('REPORT_RESOLUTION', resolve.removeOk && resolve.status === 'RESOLVED' && resolve.audit.includes('REPORT_RESOLVED'), resolve);
  await M.ctx.close();
  const seen = await guestSeesRemoved(browser, [st.post1, st.comment1, st.post3]);
  set('MODERATE_POST_DELETE', seen[0] === true, { guestHides: seen[0] });
  set('MODERATE_COMMENT_DELETE', seen[1] === true, { guestHides: seen[1] });
  set('REPORTED_CONTENT_REMOVED_FOR_GUEST', seen[2] === true, { guestHides: seen[2] });
}

async function memberView(page, pk) {
  return page.evaluate(async (pk) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('member-view');
    const MS = App.MembershipState;
    const s = App.GroupControlState.getVerifiedControlState();
    return {
      member: MS.getMemberState(pk),
      listed: MS.inBlockedPubkeys(pk),
      suppressed: App.ModerationPolicy.isAuthorSuppressed(pk),
      post: MS.canPerformMemberAction(pk, 'post_create').code,
      comment: MS.canPerformMemberAction(pk, 'comment_reply').code,
      reaction: MS.canPerformMemberAction(pk, 'reaction').code,
      p2p: MS.canPerformMemberAction(pk, 'group_p2p_signal').code,
      assigned: ((s.capabilities || {})[pk] || []).slice(),
      scope: App.FeatureFlags.accessControlV2Scope(),
    };
  }, pk);
}

async function guestFeedView(browser, pk, ids) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto(`${MAIN}/videos.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.pool && !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.(), null, { polling: 500, timeout: 120000 });
  const res = await page.evaluate(async ({ pk, ids, events }) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('guest-view');
    for (const ev of events) {
      if (ev.tags.some((t) => t[0] === 'e')) {
        const parent = ev.tags.find((t) => t[0] === 'e')[1];
        App.registerComment?.(ev, parent);
      } else if (!App.isAuthorSuppressed(ev.pubkey)) {
        App.postsById.set(ev.id, ev);
      }
    }
    const parentOf = (ev) => (ev.tags.find((t) => t[0] === 'e') || [])[1];
    return {
      suppressed: App.isAuthorSuppressed(pk),
      visible: events.map((ev) => (parentOf(ev) ? App.listVisibleComments(parentOf(ev)).some((c) => c.id === ev.id) : App.postsById.has(ev.id))),
      ids,
    };
  }, { pk, ids, events: ids.map((id) => st.events[id]).filter(Boolean) });
  await ctx.close();
  return res;
}

async function stageBlocked(browser) {
  const M = await openProfile('M');
  viaPage = M.page;
  await ensureIdentity(M.page);
  const v = await memberView(M.page, st.M);
  const self = await M.page.evaluate(async () => {
    const App = window.NostrApp;
    const inv = await App.FirstGroupAdmin.createInvite().catch((e) => ({ code: String(e.message || e) }));
    return { invite: inv && inv.code, menu: App.FirstGroupAdmin.canSeeAdminMenu(), groupControl: App.GroupAdminProductUi.canSeeGroupAdminMenu() };
  });
  await M.ctx.close();
  set('BLOCK_USER_PRODUCTION', v.member === 'BLOCKED' && v.listed && v.scope === 'CONTROL_PLANE', v);
  set('BLOCKED_USER_CAN_POST', v.post === 'BLOCKED', { post: v.post });
  set('BLOCKED_USER_CAN_COMMENT', v.comment === 'BLOCKED' && v.reaction === 'BLOCKED', { comment: v.comment, reaction: v.reaction });
  set('BLOCKED_USER_P2P_DENIED', v.p2p === 'BLOCKED', { p2p: v.p2p });
  set('BLOCKED_USER_CAN_INVITE', !/CREATED|^OK$/.test(String(self.invite)), { invite: self.invite });
  set('BLOCKED_USER_CAN_USE_GROUP_CONTROL', self.menu === false && self.groupControl === false, self);
  const g = await guestFeedView(browser, st.M, [st.mPost, st.mComment]);
  set('BLOCKED_USER_CONTENT_VISIBLE_IN_SOS', g.suppressed === true && g.visible.every((x) => x === false), g);
}

async function stageUnblocked(browser) {
  const M = await openProfile('M');
  viaPage = M.page;
  await ensureIdentity(M.page);
  const v = await memberView(M.page, st.M);
  await M.ctx.close();
  set(
    'UNBLOCK_USER_PRODUCTION',
    v.member === 'ACTIVE' && !v.listed && !v.suppressed && v.post !== 'BLOCKED' && v.comment !== 'BLOCKED' && v.assigned.indexOf('MODERATE_CONTENT') === -1,
    v
  );
  const g = await guestFeedView(browser, st.M, [st.mPost]);
  set('UNBLOCKED_USER_CONTENT_VISIBLE_AGAIN', g.suppressed === false && g.visible[0] === true, g);
}

async function stageRemoved(browser) {
  const M = await openProfile('M');
  viaPage = M.page;
  await ensureIdentity(M.page);
  const v = await memberView(M.page, st.M);
  await M.ctx.close();
  set('REMOVE_MEMBER_PRODUCTION', v.member === 'REMOVED' && !v.listed && v.post === 'REMOVED' && v.assigned.length === 0, v);
}

async function stageRevoked(browser) {
  const M = await openProfile(MODP);
  viaPage = M.page;
  await ensureIdentity(M.page);
  const view = await M.page.evaluate(async (pk) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('revoke-check');
    const s = App.GroupControlState.getVerifiedControlState();
    return { epoch: s.controlEpoch, caps: (s.capabilities || {})[pk] || [] };
  }, st[MODP]);
  set('MODERATE_CONTENT_REVOKE', view.caps.indexOf('MODERATE_CONTENT') === -1, view);
  const denied = await deleteAs(M.page, st.events[st.post2], false);
  await sleep(3000);
  const mod = await onRelays({ kinds: [39002], authors: [st[MODP]], '#d': [st.post2] });
  set('MODERATE_DENIED_AFTER_REVOKE', denied.policyOk === false && denied.policy === 'NO_MODERATE_CAP' && mod.length === 0, { policy: denied.policy, moderationEvents: mod.length });
  await M.ctx.close();
  const seen = await guestSeesRemoved(browser, [st.post1]);
  set('EARLIER_REMOVAL_AFTER_REVOKE_STILL_HIDDEN', seen[0] === true, { guestHides: seen[0] });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    if (STAGE === 'setup') await stageSetup(browser, process.argv[3] || '');
    else if (STAGE === 'prep2') {
      const M2 = await openProfile('M2');
      const id2 = await ensureIdentity(M2.page);
      st.M2 = id2.pk;
      st.nameM2 = 'QA Moderator2 ' + id2.pk.slice(0, 4);
      set('M2_IDENTITY', /^[0-9a-f]{64}$/.test(id2.pk), { pk8: id2.pk.slice(0, 8) });
      set('M2_PROFILE_NAME_PUBLISHED', (await setName(M2.page, st.nameM2)).ok, { name: st.nameM2 });
      await M2.ctx.close();
    } else if (STAGE === 'content') await stageContent(String(process.env.P1_REUSE_CODE || '').trim().toUpperCase());
    else if (STAGE === 'moderate') await stageModerate(browser);
    else if (STAGE === 'revoked') await stageRevoked(browser);
    else if (STAGE === 'blocked') await stageBlocked(browser);
    else if (STAGE === 'unblocked') await stageUnblocked(browser);
    else if (STAGE === 'removed') await stageRemoved(browser);
    else set('USAGE', false, 'node qa/phase1-moderation-production.mjs setup <inviteUrl> | moderate | revoked | blocked | unblocked | removed');
  } catch (e) {
    set('EXCEPTION', false, String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').slice(0, 300));
  } finally {
    saveState();
    await browser.close().catch(() => {});
  }
  const all = Object.values(report.results);
  report.passed = all.filter((r) => r.ok).length;
  report.failed = all.filter((r) => !r.ok).length;
  report.status = report.failed === 0 && report.passed > 0 ? 'PASS' : 'FAIL';
  report.public = { M8: (st.M || '').slice(0, 8), nameM: st.nameM || '' };
  const raw = JSON.stringify(report, null, 2);
  if (SECRET_SHAPE.test(raw)) process.exit(1);
  fs.writeFileSync(OUT, raw);
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, M8: report.public.M8, nameM: report.public.nameM }));
  process.exit(report.status === 'PASS' ? 0 : 1);
}
main();
