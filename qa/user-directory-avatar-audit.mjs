/**
 * Read-only production audit (https://sos010.com) of avatars in "כל המשתמשים".
 * For every known israel-network identity it compares the picture the 899p directory shows (newest kind 0 tagged
 * #t=israel-network, taken before the shared profile cache) with the newest kind 0 of that author (what the shared
 * resolver App.fetchProfile uses), and checks whether each picture URL actually loads.
 * Guest browser, no identity, no publishing. Reports short public keys, public profile names and picture hosts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, '..'), 'qa', 'user-directory-avatar-audit-report.json');

const live = await (await fetch('https://sos010.com/app-version.json?qa=' + Date.now())).json();
const browser = await chromium.launch({ headless: true });
const report = { gate: 'USER_DIRECTORY_AVATAR_AUDIT', ts: new Date().toISOString(), mutations: 0, liveVersion: live.version };

function describePicture(p) {
  const s = String(p || '');
  if (!s) return '';
  if (s.startsWith('data:')) return s.slice(0, s.indexOf(',') > 0 ? Math.min(s.indexOf(','), 40) : 30) + ';len=' + s.length;
  try {
    const u = new URL(s);
    return u.protocol + '//' + u.host + u.pathname.slice(0, 60);
  } catch (_e) {
    return 'INVALID_URL';
  }
}

/** Same acceptance rule as the 899p directory (safeLogoSrc). */
function directoryAccepts(p) {
  const s = String(p || '');
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s) || /^https:\/\/[^\s"'<>()\\`]{1,500}$/.test(s);
}

async function loadResult(p) {
  const s = String(p || '');
  if (!s) return 'NO_PICTURE';
  if (s.startsWith('data:')) return directoryAccepts(s) ? 'DATA_URL_OK' : 'DATA_URL_REJECTED_BY_DIRECTORY';
  if (!/^https?:\/\//i.test(s)) return 'NOT_HTTP';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(s, { method: 'GET', redirect: 'follow', signal: ctl.signal });
    clearTimeout(t);
    const type = String(r.headers.get('content-type') || '');
    try {
      await r.body?.cancel();
    } catch (_e) {}
    if (!r.ok) return 'HTTP_' + r.status;
    return /^image\//i.test(type) ? 'HTTP_200_IMAGE' : 'HTTP_200_NOT_IMAGE:' + type.slice(0, 30);
  } catch (e) {
    return 'FETCH_ERROR:' + String((e && e.name) || 'error');
  }
}

try {
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://sos010.com/videos.html?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.FirstGroupNetworkAuthority?.isSynced?.() && !!window.NostrApp?.pool, null, { polling: 500, timeout: 180000 });
  const rows = await page.evaluate(async () => {
    const App = window.NostrApp;
    const MS = App.MembershipState;
    const st = App.GroupControlState.getVerifiedControlState();
    const tag = 'israel-network';
    const relays = Array.from(new Set([...(App.relayUrls || []), ...(App.EMAIL_REGISTRY_RELAYS || [])]));
    const q = async (f) => {
      try {
        return await App.pool.querySync(relays, f, { maxWait: 15000 });
      } catch (_e) {
        return [];
      }
    };
    const verify = (e) => typeof App.strictVerifyNostrEvent === 'function' && App.strictVerifyNostrEvent(e) === true;
    const parse = (e) => {
      try {
        const c = JSON.parse(e.content || '{}');
        return { name: String(c.display_name || c.name || '').trim().slice(0, 40), picture: String(c.picture || '').trim() };
      } catch (_e) {
        return { name: '', picture: '' };
      }
    };
    const newestBy = (events) => {
      const m = new Map();
      events
        .filter(verify)
        .sort((a, b) => b.created_at - a.created_at)
        .forEach((e) => {
          if (!m.has(e.pubkey)) m.set(e.pubkey, e);
        });
      return m;
    };
    const reg = await q({ kinds: [37377], '#t': ['email-registry'], limit: 5000 });
    const tagged = newestBy(await q({ kinds: [0], '#t': [tag], limit: 5000 }));
    const known = new Set([st.rootAdminPubkey, ...Object.keys(st.capabilities || {}), ...(MS.getKnownMemberPubkeys ? MS.getKnownMemberPubkeys() : []), ...(st.blockedPubkeys || []), ...tagged.keys()]);
    reg.filter((e) => verify(e) && (e.tags || []).some((t) => t[0] === 't' && t[1] === tag)).forEach((e) => known.add(e.pubkey));
    const all = Array.from(known).filter((pk) => /^[0-9a-f]{64}$/.test(pk));
    const newest = new Map();
    const history = new Map();
    for (let i = 0; i < all.length; i += 40) {
      const batch = (await q({ kinds: [0], authors: all.slice(i, i + 40), limit: 2000 })).concat(await q({ kinds: [0], '#t': [tag], authors: all.slice(i, i + 40), limit: 2000 }));
      newestBy(batch).forEach((e, pk) => newest.set(pk, e));
      batch.filter(verify).forEach((e) => {
        const list = history.get(e.pubkey) || [];
        if (!list.some((x) => x.id === e.id)) list.push(e);
        history.set(e.pubkey, list);
      });
    }
    return all.map((pk) => {
      const t = tagged.get(pk);
      const n = newest.get(pk);
      const tp = t ? parse(t) : { name: '', picture: '' };
      const np = n ? parse(n) : { name: '', picture: '' };
      return {
        pk: pk.slice(0, 8) + '…' + pk.slice(-4),
        directoryEventId: t ? t.id.slice(0, 8) : '',
        directoryName: tp.name,
        directoryPicture: tp.picture,
        canonicalEventId: n ? n.id.slice(0, 8) : '',
        canonicalName: np.name,
        canonicalPicture: np.picture,
        canonicalNewer: !!(t && n && n.id !== t.id && n.created_at >= t.created_at),
        olderPictures: (history.get(pk) || [])
          .filter((e) => !n || e.id !== n.id)
          .sort((a, b) => b.created_at - a.created_at)
          .map((e) => ({ id: e.id.slice(0, 8), name: parse(e).name, picture: parse(e).picture }))
          .filter((x) => x.picture && x.picture !== np.picture),
      };
    });
  });
  // Real browser load on sos010.com (same CSP / referrer policy as the directory <img>).
  const pics = Array.from(new Set(rows.flatMap((r) => [r.directoryPicture, r.canonicalPicture, ...r.olderPictures.map((o) => o.picture)]).filter(Boolean)));
  const browserLoads = await page.evaluate(async (list) => {
    const one = (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        const t = setTimeout(() => resolve('IMG_TIMEOUT'), 12000);
        img.onload = () => {
          clearTimeout(t);
          resolve(img.naturalWidth > 0 ? 'IMG_LOAD_OK' : 'IMG_ZERO_SIZE');
        };
        img.onerror = () => {
          clearTimeout(t);
          resolve('IMG_ERROR');
        };
        img.src = src;
      });
    const out = {};
    for (const s of list) out[s] = await one(s);
    return out;
  }, pics);
  const out = [];
  for (const r of rows) {
    const dirLoad = (await loadResult(r.directoryPicture)) + (r.directoryPicture ? ' / ' + browserLoads[r.directoryPicture] : '');
    const canonLoad = r.canonicalPicture === r.directoryPicture ? dirLoad : await loadResult(r.canonicalPicture);
    const brokenInDirectory = !!r.directoryPicture && (!directoryAccepts(r.directoryPicture) || browserLoads[r.directoryPicture] !== 'IMG_LOAD_OK');
    out.push({
      pk: r.pk,
      DISPLAY_NAME: r.canonicalName || r.directoryName,
      PROFILE_EVENT_ID: r.directoryEventId,
      PICTURE_VALUE: describePicture(r.directoryPicture),
      PICTURE_SOURCE_URL: describePicture(r.directoryPicture),
      HTTP_LOAD_RESULT: dirLoad,
      PROFILE_RESOLVER_SOURCE: 'listKnownUsers: newest kind0 with #t=israel-network (not the shared resolver)',
      CACHE_SOURCE: 'directory row.avatar preferred over App.profileCache',
      CANONICAL_EVENT_ID: r.canonicalEventId,
      CANONICAL_PICTURE: describePicture(r.canonicalPicture),
      CANONICAL_LOAD_RESULT: canonLoad,
      CANONICAL_NEWER_THAN_DIRECTORY: r.canonicalNewer,
      brokenInDirectory,
    });
  }
  report.identities = out.length;
  report.withDirectoryPicture = out.filter((r) => r.PICTURE_VALUE).length;
  report.brokenExamples = out.filter((r) => r.brokenInDirectory);
  report.staleInDirectory = out.filter((r) => r.CANONICAL_NEWER_THAN_DIRECTORY && r.CANONICAL_PICTURE !== r.PICTURE_VALUE).map((r) => ({ pk: r.pk, dir: r.PICTURE_VALUE, canonical: r.CANONICAL_PICTURE, canonicalLoad: r.CANONICAL_LOAD_RESULT }));
  report.canonicalPictureFailures = rows
    .filter((r) => r.canonicalPicture && browserLoads[r.canonicalPicture] !== 'IMG_LOAD_OK')
    .map((r) => ({ pk: r.pk, DISPLAY_NAME: r.canonicalName, PROFILE_EVENT_ID: r.canonicalEventId, PICTURE_VALUE: describePicture(r.canonicalPicture), HTTP_LOAD_RESULT: browserLoads[r.canonicalPicture], directoryAccepts: directoryAccepts(r.canonicalPicture) }));
  report.canonicalOnlyPictures = rows.filter((r) => r.canonicalPicture && !r.directoryPicture).map((r) => ({ pk: r.pk, PICTURE_VALUE: describePicture(r.canonicalPicture), load: browserLoads[r.canonicalPicture], directoryAccepts: directoryAccepts(r.canonicalPicture) }));
  report.staleProfilePicturesThatFail = rows.flatMap((r) =>
    r.olderPictures
      .filter((o) => browserLoads[o.picture] !== 'IMG_LOAD_OK')
      .map((o) => ({
        pk: r.pk,
        DISPLAY_NAME: o.name || r.canonicalName,
        PROFILE_EVENT_ID: o.id,
        PICTURE_VALUE: describePicture(o.picture),
        PICTURE_SOURCE_URL: describePicture(o.picture),
        HTTP_LOAD_RESULT: browserLoads[o.picture],
        PROFILE_RESOLVER_SOURCE: 'older kind0 (superseded)',
        CACHE_SOURCE: 'App.profileCache entry (directory row.avatar) can hold a superseded picture until the shared resolver refreshes it',
        NEWEST_EVENT_ID: r.canonicalEventId,
        NEWEST_PICTURE: describePicture(r.canonicalPicture),
        NEWEST_LOAD_RESULT: r.canonicalPicture ? browserLoads[r.canonicalPicture] : 'NO_PICTURE',
      }))
  );
  report.loadSummary = out.reduce((m, r) => ((m[r.HTTP_LOAD_RESULT] = (m[r.HTTP_LOAD_RESULT] || 0) + 1), m), {});
  report.status = 'OK';
} catch (e) {
  report.status = 'ERROR';
  report.error = String((e && e.message) || e).slice(0, 300);
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, identities: report.identities, withPicture: report.withDirectoryPicture, broken: (report.brokenExamples || []).length, stale: (report.staleInDirectory || []).length, staleFail: (report.staleProfilePicturesThatFail || []).length, loads: report.loadSummary }));
await browser.close().catch(() => {});
process.exit(0);
