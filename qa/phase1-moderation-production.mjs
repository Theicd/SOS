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
async function onRelays(filter) {
  const per = await Promise.all(RELAYS.map((r) => queryRelay(r, filter)));
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
      return { id: ev.id, acks: settled.filter((s) => s.status === 'fulfilled').length };
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
  const reuse = await M.page.evaluate(async (code) => {
    const v = await window.NostrApp.validateInvite({ code });
    return { ok: v.ok, code: v.code || '', error: v.error || '' };
  }, code);
  set('INVITE_REUSE_REJECTED', reuse.ok === false, reuse);

  const B = await openProfile('B');
  const idB = await ensureIdentity(B.page);
  st.B = idB.pk;
  set('B_IDENTITY', /^[0-9a-f]{64}$/.test(idB.pk), { pk8: idB.pk.slice(0, 8) });
  await setName(B.page, 'QA Author ' + st.B.slice(0, 4));
  const tag = crypto.randomBytes(3).toString('hex');
  const p1 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — פוסט לבדיקת מחיקה על ידי מנהל תוכן.`);
  const c1 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — תגובה לבדיקת מחיקה.`, p1.id);
  const p2 = await publishNote(B.page, `בדיקת QA זמנית (${tag}) — פוסט שני לבדיקת ביטול הרשאה.`);
  Object.assign(st, { post1: p1.id, comment1: c1.id, post2: p2.id });
  set('B_DISPOSABLE_CONTENT_PUBLISHED', p1.acks > 0 && c1.acks > 0 && p2.acks > 0, { acks: [p1.acks, c1.acks, p2.acks] });
  await B.ctx.close();
  await sleep(3000);
  const evs = await onRelays({ ids: [st.post1, st.comment1, st.post2] });
  st.events = Object.fromEntries(evs.map((e) => [e.id, e]));
  saveState();

  const own = await publishNote(M.page, `בדיקת QA זמנית (${tag}) — פוסט של המשתמש עצמו.`);
  await sleep(2000);
  const ownEv = (await onRelays({ ids: [own.id] }))[0];
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
  const M = await openProfile('M');
  const id = await ensureIdentity(M.page);
  set('M_SAME_IDENTITY', id.pk === st.M, { same: id.pk === st.M });
  const view = await M.page.evaluate(async (pk) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('grant-check');
    const s = App.GroupControlState.getVerifiedControlState();
    return { epoch: s.controlEpoch, caps: (s.capabilities || {})[pk] || [] };
  }, st.M);
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
  const post = await deleteAs(M.page, st.events[st.post1], false);
  const comment = await deleteAs(M.page, st.events[st.comment1], true);
  await sleep(3000);
  const modPost = await onRelays({ kinds: [39002], authors: [st.M], '#d': [st.post1] });
  const modComment = await onRelays({ kinds: [39002], authors: [st.M], '#d': [st.comment1] });
  set('MODERATE_POST_DELETE_PUBLISHED', post.policy === 'MODERATE_CONTENT' && post.publishState === 'confirmed' && modPost.length > 0, { policy: post.policy, publish: post.publishState, onRelays: modPost.length });
  set('MODERATE_COMMENT_DELETE_PUBLISHED', comment.policy === 'MODERATE_CONTENT' && comment.publishState === 'confirmed' && modComment.length > 0, { policy: comment.policy, publish: comment.publishState, onRelays: modComment.length });
  await M.ctx.close();
  const seen = await guestSeesRemoved(browser, [st.post1, st.comment1]);
  set('MODERATE_POST_DELETE', seen[0] === true, { guestHides: seen[0] });
  set('MODERATE_COMMENT_DELETE', seen[1] === true, { guestHides: seen[1] });
}

async function stageRevoked(browser) {
  const M = await openProfile('M');
  await ensureIdentity(M.page);
  const view = await M.page.evaluate(async (pk) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('revoke-check');
    const s = App.GroupControlState.getVerifiedControlState();
    return { epoch: s.controlEpoch, caps: (s.capabilities || {})[pk] || [] };
  }, st.M);
  set('MODERATE_CONTENT_REVOKE', view.caps.indexOf('MODERATE_CONTENT') === -1, view);
  const denied = await deleteAs(M.page, st.events[st.post2], false);
  await sleep(3000);
  const mod = await onRelays({ kinds: [39002], authors: [st.M], '#d': [st.post2] });
  set('MODERATE_DENIED_AFTER_REVOKE', denied.policyOk === false && denied.policy === 'NO_MODERATE_CAP' && mod.length === 0, { policy: denied.policy, moderationEvents: mod.length });
  await M.ctx.close();
  const seen = await guestSeesRemoved(browser, [st.post1]);
  set('EARLIER_REMOVAL_AFTER_REVOKE_STILL_HIDDEN', seen[0] === true, { guestHides: seen[0] });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    if (STAGE === 'setup') await stageSetup(browser, process.argv[3] || '');
    else if (STAGE === 'moderate') await stageModerate(browser);
    else if (STAGE === 'revoked') await stageRevoked(browser);
    else set('USAGE', false, 'node qa/phase1-moderation-production.mjs setup <inviteUrl> | moderate | revoked');
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
