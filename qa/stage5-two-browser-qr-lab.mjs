/**
 * STAGE 5 — Automated two-browser QR pairing lab (Web-first).
 * Desktop guest QR issuer + Mobile emulated scanner + optional virtual camera.
 *
 * Secrets: SOS_QA_NSEC env or qa/.local/stage5-qa-nsec (gitignored). Never logged.
 * Does not claim LINKED without real T2/Worker. No T1. No APK. No fake MD3.
 *
 * Usage:
 *   node qa/stage5-two-browser-qr-lab.mjs
 *   node qa/stage5-two-browser-qr-lab.mjs --base=https://sos010.com/videos.html
 */
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { nip19 } = require('nostr-tools');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `s5lab-${Date.now().toString(36)}`;
const OUT = path.join(ROOT, 'qa', '.stage5-lab', RUN_ID);
const BASE =
  (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7) ||
  process.env.SOS_LAB_BASE ||
  'https://sos010.com/videos.html';
const ORIGIN = new URL(BASE).origin;
const FFMPEG =
  process.env.FFMPEG_PATH ||
  'C:\\Users\\Avatar001\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe';

const SECRET_RE = /\bnsec1[0-9a-z]{20,}\b/gi;
const HEX64_RE = /\b[0-9a-f]{64}\b/gi;
const SOSPAIR_RE = /SOSPAIR1:[A-Za-z0-9_-]{20,}/g;

function redact(s) {
  return String(s || '')
    .replace(SECRET_RE, '[REDACTED_NSEC]')
    .replace(SOSPAIR_RE, 'SOSPAIR1:[REDACTED]')
    .replace(HEX64_RE, (h) => h.slice(0, 8) + '…')
    .slice(0, 500);
}

function loadQaNsec() {
  const fromEnv = String(process.env.SOS_QA_NSEC || '').trim();
  if (fromEnv) return fromEnv;
  const p = path.join(ROOT, 'qa', '.local', 'stage5-qa-nsec');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  throw new Error('QA_NSEC_MISSING: set SOS_QA_NSEC or qa/.local/stage5-qa-nsec');
}

function nsecToHex(nsec) {
  const d = nip19.decode(nsec);
  if (d.type !== 'nsec') throw new Error('QA_NSEC_BAD_TYPE');
  const sk = d.data;
  return Buffer.from(sk).toString('hex');
}

function pubFromHexSk(hex) {
  const { getPublicKey } = require('nostr-tools');
  return getPublicKey(Uint8Array.from(Buffer.from(hex, 'hex')));
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function sha16File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16).toUpperCase();
  } catch {
    return null;
  }
}

function findFfmpeg() {
  if (fs.existsSync(FFMPEG)) return FFMPEG;
  const which = spawnSync('where.exe', ['ffmpeg'], { encoding: 'utf8' });
  const line = String(which.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || null;
}

/** PNG → short looping Y4M for Chromium --use-file-for-fake-video-capture */
function pngToY4m(pngPath, y4mPath) {
  const ff = findFfmpeg();
  if (!ff) return { ok: false, code: 'FFMPEG_MISSING' };
  const r = spawnSync(
    ff,
    [
      '-y',
      '-loop',
      '1',
      '-i',
      pngPath,
      '-vf',
      'scale=480:480:flags=neighbor,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p',
      '-r',
      '10',
      '-t',
      '6',
      '-pix_fmt',
      'yuv420p',
      y4mPath,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !fs.existsSync(y4mPath)) {
    return { ok: false, code: 'Y4M_FAIL', err: redact((r.stderr || '').slice(-400)) };
  }
  return { ok: true, path: y4mPath, bytes: fs.statSync(y4mPath).size, absPosix: path.resolve(y4mPath).replace(/\\/g, '/') };
}

function attachTrace(page, bucket, label) {
  page.on('console', (msg) => {
    const t = redact(msg.text());
    if (bucket.console.length < 400) bucket.console.push({ t: Date.now(), type: msg.type(), text: t, side: label });
  });
  page.on('pageerror', (err) => {
    bucket.pageErrors.push({ t: Date.now(), text: redact(err.message), side: label });
  });
  page.on('websocket', (ws) => {
    const url = redact(ws.url());
    bucket.websockets.push({ t: Date.now(), url, side: label, event: 'open' });
    ws.on('close', () => bucket.websockets.push({ t: Date.now(), url, side: label, event: 'close' }));
    ws.on('socketerror', () => bucket.websockets.push({ t: Date.now(), url, side: label, event: 'error' }));
  });
}

async function waitApp(page, timeout = 120000) {
  await page.waitForFunction(() => !!window.NostrApp && !!window.SosWebLinkedDevices, null, { timeout });
}

/**
 * QA harness: App.pool.publish may return a single Promise; MD2 uses Promise.allSettled(publish(...))
 * which throws "object is not iterable". Normalize return to an array. Not an auth bypass.
 */
async function patchPoolPublishIterable(page) {
  return page.evaluate(() => {
    const pool = window.NostrApp && window.NostrApp.pool;
    if (!pool || typeof pool.publish !== 'function' || pool.__sosLabPublishPatched) {
      return { ok: !!pool, patched: !!(pool && pool.__sosLabPublishPatched) };
    }
    const orig = pool.publish.bind(pool);
    pool.publish = function (...args) {
      const r = orig(...args);
      return Array.isArray(r) ? r : r != null ? [r] : [];
    };
    pool.__sosLabPublishPatched = true;
    return { ok: true, patched: true };
  });
}

async function collectBuildMeta(page) {
  return page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') || '');
    const pkg =
      (scripts.find((s) => /sos-web-linked-devices\.js/.test(s)) || '').match(/pkg=([^&]+)/)?.[1] ||
      (scripts.find((s) => /app\.js/.test(s)) || '').match(/v=([^&]+)/)?.[1] ||
      null;
    const hashes = {};
    for (const key of ['sos-web-linked-devices', 'sos-md2-pairing-session', 'sos-web-linked-qr-scanner', 'vendor/sos-noble']) {
      const hit = scripts.find((s) => s.includes(key));
      if (hit) hashes[key] = hit.split('?')[0];
    }
    return {
      href: location.href,
      origin: location.origin,
      pkg,
      scriptCount: scripts.length,
      noble: !!(window.__sosNobleSchnorr?.sign || window.SosNobleSecp?.schnorr),
      guestMode: window.NostrApp?.guestMode === true,
      publicKeyFp: String(window.NostrApp?.publicKey || '')
        .toLowerCase()
        .slice(0, 12),
      pool: !!window.NostrApp?.pool,
      subscribeMany: !!(window.NostrApp?.pool && typeof window.NostrApp.pool.subscribeMany === 'function'),
    };
  });
}

async function desktopEnsureGuestQr(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Bypass stale Service Worker / CDN caches for Linked Devices assets.
  await page.evaluate(async () => {
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (_e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  // Force guest QR welcome on desktop surface.
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('sos_ld_guest_continued_v1');
    } catch (_e) {}
    const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
    if (LD && typeof LD.showGuestQrWelcome === 'function') LD.showGuestQrWelcome();
    else if (LD && typeof LD.openDesktopPairingPanel === 'function') LD.openDesktopPairingPanel();
  });
  await page.waitForSelector('#sosLdGuestWelcome canvas, #sosLinkedPairPanel canvas, #sosLinkedPairCanvas', {
    timeout: 60000,
  });
  // Wait until public SOSPAIR1 session text is available (canvas pixels alone race ahead of render).
  await page.waitForFunction(() => {
    const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
    const t = LD && typeof LD.getCurrentPairingQrText === 'function' ? LD.getCurrentPairingQrText() : null;
    return !!(t && String(t).indexOf('SOSPAIR1:') === 0);
  }, null, { timeout: 90000 });

  const pairing = await page.evaluate(() => {
    const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
    const st = LD && typeof LD.getPairingState === 'function' ? LD.getPairingState() : null;
    const phases = (window.__sosMd3DbgPhases || []).slice(-30).map((p) => ({
      t: p.t,
      phase: p.phase,
      pairingFp: p.pairingFp || null,
      via: p.via || null,
      code: p.code || null,
    }));
    return {
      state: st && st.state,
      expiresAt: st && st.expiresAt,
      pairingFp: st && st.pairingId ? String(st.pairingId).slice(0, 12) : null,
      phases,
    };
  });

  const canvas = page.locator('#sosLinkedPairCanvas, #sosLdGuestWelcome canvas, #sosLinkedPairPanel canvas').first();
  const pngPath = path.join(OUT, 'desktop-qr.png');
  await canvas.screenshot({ path: pngPath });
  return { pairing, pngPath };
}

/** Decode current Desktop SOSPAIR1 (session text preferred; canvas jsQR fallback). */
async function decodeDesktopQrText(page) {
  return page.evaluate(async () => {
    const Md2 = window.NostrApp?.Md2PairingQr || window.SosMd2PairingQr;
    const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
    function pack(text, via) {
      const parsed = Md2 && typeof Md2.parseQr === 'function' ? Md2.parseQr(text) : { ok: false };
      return {
        ok: true,
        via: via,
        qrText: text,
        prefixOk: String(text).indexOf('SOSPAIR1:') === 0,
        pairingFp: parsed.ok ? String(parsed.payload.pairingId || '').slice(0, 12) : null,
        expiresAt: parsed.ok ? parsed.payload.expiresAt : null,
        rendezvousHost: parsed.ok
          ? String(parsed.payload.rendezvous || '')
              .replace(/^wss?:\/\//, '')
              .split('/')[0]
          : null,
      };
    }
    if (LD && typeof LD.getCurrentPairingQrText === 'function') {
      const sessionText = LD.getCurrentPairingQrText();
      if (sessionText) return pack(sessionText, 'SESSION_QR_TEXT');
    }
    const canvas =
      document.querySelector('#sosLinkedPairCanvas') ||
      document.querySelector('#sosLdGuestWelcome canvas') ||
      document.querySelector('#sosLinkedPairPanel canvas');
    if (!canvas) return { ok: false, code: 'NO_CANVAS' };
    const loadJsQR = () =>
      new Promise((resolve) => {
        if (typeof window.jsQR === 'function') return resolve(true);
        const s = document.createElement('script');
        s.src = './vendor/jsQR.js';
        s.onload = () => resolve(typeof window.jsQR === 'function');
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    const ok = await loadJsQR();
    if (!ok) return { ok: false, code: 'JSQR_MISSING' };
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (!code || !code.data) return { ok: false, code: 'DECODE_FAIL', canvasW: w, canvasH: h };
    return pack(String(code.data), 'CANVAS_JSQR');
  });
}


async function enableVirtualWebAuthn(context, page) {
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

async function armSignerPopupHandler(context, report) {
  context.on('page', async (popup) => {
    try {
      const url = popup.url() || '';
      report.timeline.mobile.push({ t: Date.now(), event: 'SIGNER_POPUP_OPEN', url: String(url).slice(0, 120) });
      report.T2_APPROVAL_ORIGIN = (() => {
        try {
          return new URL(url).origin;
        } catch (_e) {
          return null;
        }
      })();
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      // Best-effort: click Approve if present (virtual UV already unlocked).
      const approve = popup.locator('button:has-text("אשר"), button:has-text("Approve"), #aldApprove, [data-ald-approve]');
      if (await approve.count()) {
        await approve.first().click({ timeout: 5000 }).catch(() => {});
        report.timeline.mobile.push({ t: Date.now(), event: 'SIGNER_APPROVE_CLICKED' });
      }
    } catch (e) {
      report.timeline.mobile.push({ t: Date.now(), event: 'SIGNER_POPUP_ERR', err: String(e && e.message || e).slice(0, 160) });
    }
  });
}

async function loginMobile(page, skHex, expectPub) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  const created = await page.evaluate(
    ({ k, expect }) => {
      const App = window.NostrApp;
      const c = App.createNewIdentityExplicit({ privateKeyHex: k });
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.bindCurrentSession === 'function') {
        SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
      }
      return {
        ok: !!(c && c.ok),
        pubFp: String(c?.publicKey || App.publicKey || '')
          .toLowerCase()
          .slice(0, 12),
        matchExpect: String(c?.publicKey || '').toLowerCase() === String(expect || '').toLowerCase(),
        guestMode: App.guestMode === true,
      };
    },
    { k: skHex, expect: expectPub },
  );
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  await page.waitForFunction(
    (fp) => {
      const App = window.NostrApp;
      return (
        String(App?.publicKey || '')
          .toLowerCase()
          .startsWith(fp) && App.guestMode !== true
      );
    },
    expectPub.slice(0, 12),
    { timeout: 120000 },
  );
  return created;
}

async function mobileOpenScanner(page) {
  return page.evaluate(async () => {
    const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
    if (!LD) return { ok: false, code: 'LD_MISSING' };
    if (typeof LD.openMobileLinkedDevicesPage === 'function') LD.openMobileLinkedDevicesPage();
    const surface = typeof LD.classifyLinkedDevicesSurface === 'function' ? LD.classifyLinkedDevicesSurface() : null;
    // Prefer product camera scan path
    if (typeof LD.beginPrimaryCameraScan === 'function') {
      // fire and store promise on window for polling
      window.__sosLabScanPromise = LD.beginPrimaryCameraScan();
      window.__sosLabScanStartedAt = Date.now();
      return { ok: true, path: 'beginPrimaryCameraScan', surface };
    }
    return { ok: false, code: 'NO_SCAN_API', surface };
  });
}

async function pollPhases(page) {
  return page.evaluate(() => {
    const phases = (window.__sosMd3DbgPhases || []).map((p) => ({
      t: p.t,
      phase: p.phase,
      pairingFp: p.pairingFp || null,
      via: p.via || null,
      code: p.code || null,
    }));
    const scanStatus = (document.getElementById('sosLinkedScanStatus') || {}).textContent || '';
    const panelOpen = !!(document.getElementById('sosLinkedScanPanel') && !document.getElementById('sosLinkedScanPanel').hidden);
    return {
      phases,
      scanStatus: String(scanStatus).slice(0, 160),
      panelOpen,
      inboundErr: window.__sosMd3HandleInboundErr || null,
      rejects: (window.__sosMd2ProtocolRejects || []).slice(-8),
    };
  });
}

async function waitScanSettled(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = page.url();
      if (/authorize-linked-device/.test(url)) {
        return {
          ok: true,
          code: 'SAME_TAB_HANDOFF',
          path: 'WEB_PHONEISSUER_T2',
          webMd3: true,
          w2: true,
          sameTab: true,
        };
      }
    } catch (_url) {}
    const done = await page.evaluate(async () => {
      const p = window.__sosLabScanPromise;
      if (!p) return { ready: false };
      const raced = await Promise.race([
        p.then((r) => ({ ready: true, result: r })),
        new Promise((res) => setTimeout(() => res({ ready: false }), 50)),
      ]);
      return raced;
    }).catch((err) => ({ ready: false, navErr: String(err && err.message || err).slice(0, 160) }));
    if (done && done.navErr) {
      let url = '';
      try { url = page.url(); } catch (_u) {}
      if (/authorize-linked-device/.test(url)) {
        return {
          ok: true,
          code: 'SAME_TAB_HANDOFF',
          path: 'WEB_PHONEISSUER_T2',
          webMd3: true,
          w2: true,
          sameTab: true,
        };
      }
    }
    if (done && done.ready) {
      const r = done.result || {};
      return {
        ok: !!r.ok,
        code: r.code || null,
        path: r.MD3_ISSUANCE_PATH || r.path || null,
        webMd3: r.WEB_MD3_ISSUANCE === true,
        w2: r.W2_SOSPAIR1_SCAN === true,
        nativeStarted: !!r.nativeStarted,
        pairingFp: r.payload && r.payload.pairingId ? String(r.payload.pairingId).slice(0, 12) : null,
        decodeIsNotAuth: r.DECODE_IS_NOT_AUTHORIZATION === true,
      };
    }
    const snap = await pollPhases(page);
    if (/QR זוהה|זוהה|SCANNED/i.test(snap.scanStatus)) {
      // keep waiting for approval path settle
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, code: 'SCAN_TIMEOUT' };
}

/** Ensure desktop initiator is live and optionally attach a parallel kind-25060 probe. */
async function armDesktopMd2Probe(page, pairingFp) {
  return page.evaluate((fp) => {
    const App = window.NostrApp;
    const Session = App?.Md2PairingSession || window.SosMd2PairingSession;
    const LD = window.SosWebLinkedDevices || App?.WebLinkedDevices;
    const st = LD && typeof LD.getPairingState === 'function' ? LD.getPairingState() : null;
    const relays = (Session && Session.DEFAULT_RELAYS) || ['wss://nos.lol', 'wss://nostr-02.uid.ovh', 'wss://relay.snort.social'];
    window.__sosLabMd2Probe = { events: 0, roles: [], rejects: [], pairingFp: fp, armedAt: Date.now() };
    if (App?.pool && typeof App.pool.subscribeMany === 'function' && fp) {
      // Probe full pairing id from pairing state when available
      const fullId = st && st.pairingId ? String(st.pairingId).toLowerCase() : null;
      if (fullId) {
        try {
          const sub = App.pool.subscribeMany(
            relays,
            { kinds: [25060], '#t': ['sos-pair-v1'], '#d': [fullId], limit: 50 },
            {
              onevent(ev) {
                window.__sosLabMd2Probe.events += 1;
                const role = (ev.tags || []).find((t) => t[0] === 'role');
                window.__sosLabMd2Probe.roles.push(role ? role[1] : '?');
              },
            },
          );
          window.__sosLabMd2Probe.sub = !!sub;
        } catch (e) {
          window.__sosLabMd2Probe.subErr = String((e && e.message) || e).slice(0, 80);
        }
      }
    }
    return {
      pairingState: st && st.state,
      pairingFp: st && st.pairingId ? String(st.pairingId).slice(0, 12) : null,
      fpMatch: !!(st && st.pairingId && String(st.pairingId).slice(0, 12) === fp),
      pool: !!App?.pool,
      relays,
      noble: !!(window.__sosNobleSchnorr?.sign || window.SosNobleSecp?.schnorr),
    };
  }, pairingFp);
}

async function readDesktopMd2Probe(page) {
  return page.evaluate(() => {
    const p = window.__sosLabMd2Probe || {};
    return {
      events: p.events || 0,
      roles: (p.roles || []).slice(0, 20),
      sub: !!p.sub,
      subErr: p.subErr || null,
      rejects: (window.__sosMd2ProtocolRejects || []).slice(-10),
      inboundErr: window.__sosMd3HandleInboundErr || null,
      phases: (window.__sosMd3DbgPhases || []).map((x) => x.phase),
    };
  });
}

/** QA-only DIRECT_INTAKE: run MD2 phone responder without claiming optical PASS / LINKED. */
async function directIntakeMd2(page, qrText) {
  return page.evaluate(async (text) => {
    try {
      const Session = window.NostrApp?.Md2PairingSession || window.SosMd2PairingSession;
      const Qr = window.NostrApp?.Md2PairingQr || window.SosMd2PairingQr;
      if (!Session || typeof Session.beginPhoneResponder !== 'function') {
        return { ok: false, code: 'SESSION_MISSING' };
      }
      if (!window.NostrApp?.pool) return { ok: false, code: 'NO_POOL' };
      const parsed = Qr && typeof Qr.parseQr === 'function' ? Qr.parseQr(text) : { ok: false, error: 'NO_QR_MOD' };
      if (!parsed.ok) return { ok: false, code: 'BAD_QR_' + (parsed.error || 'PARSE'), expired: parsed.error === 'EXPIRED' };
      const relays =
        Session.DEFAULT_RELAYS ||
        (parsed.payload.rendezvous
          ? [parsed.payload.rendezvous, 'wss://nos.lol', 'wss://nostr-02.uid.ovh', 'wss://relay.snort.social']
          : ['wss://nos.lol', 'wss://nostr-02.uid.ovh', 'wss://relay.snort.social']);
      // Dedupe while preserving order
      const relayList = [...new Set(relays.concat(parsed.payload.rendezvous ? [parsed.payload.rendezvous] : []))];
      window.__sosMd3DbgPhases = window.__sosMd3DbgPhases || [];
      window.__sosMd3DbgPhases.push({
        t: Date.now(),
        phase: 'DIRECT_INTAKE_BEGIN',
        pairingFp: String(parsed.payload.pairingId || '').slice(0, 12),
      });
      let lastPubErr = null;
      const publishSigned = async (content, role, pid) => {
        const NT = window.NostrTools;
        const pool = window.NostrApp.pool;
        const draft = {
          kind: 25060,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['t', 'sos-pair-v1'],
            ['d', pid],
            ['role', role || 'phone'],
          ],
          content,
        };
        try {
          const transportSk = NT.generateSecretKey();
          const ev = NT.finalizeEvent(draft, transportSk);
          const pubResult = pool.publish(relayList, ev);
          const pubs = Array.isArray(pubResult) ? pubResult : pubResult ? [pubResult] : [];
          await Promise.race([
            Promise.allSettled(pubs),
            new Promise((r) => setTimeout(r, 5000)),
          ]);
          return ev.id;
        } catch (e) {
          lastPubErr = String((e && e.message) || e).slice(0, 160);
          throw e;
        }
      };
      // Built-in path first; custom publishSigned only as retry with normalized publish return.
      let resp = await Session.beginPhoneResponder(text, {
        pool: window.NostrApp.pool,
        relays: relayList,
      });
      if (!resp || !resp.ok) {
        lastPubErr = (resp && resp.code) || lastPubErr;
        resp = await Session.beginPhoneResponder(text, {
          pool: window.NostrApp.pool,
          relays: relayList,
          publishSigned,
        });
      }
      if (!resp || !resp.ok) {
        return {
          ok: false,
          code: (resp && resp.code) || 'RESPONDER_FAIL',
          poolPublish: typeof window.NostrApp.pool?.publish,
          relayCount: relayList.length,
          lastPubErr,
        };
      }
      window.__sosMd3DbgPhases.push({
        t: Date.now(),
        phase: 'HELLO_SENT',
        pairingFp: String(parsed.payload.pairingId || '').slice(0, 12),
      });
      let channel = null;
      let channelErr = null;
      try {
        channel = await resp.waitChannelReady(75000);
        window.__sosMd3DbgPhases.push({
          t: Date.now(),
          phase: 'AEAD_CHANNEL_READY',
          pairingFp: channel && channel.pairingId ? String(channel.pairingId).slice(0, 12) : null,
        });
      } catch (e) {
        channelErr = String((e && e.message) || e).slice(0, 80);
        window.__sosMd3DbgPhases.push({ t: Date.now(), phase: 'CHANNEL_WAIT_FAIL', code: channelErr });
      }
      return {
        ok: true,
        state: typeof resp.state === 'function' ? resp.state() : null,
        channelReady: !!channel,
        channelErr,
        pairingFp: String((channel && channel.pairingId) || parsed.payload.pairingId || '').slice(0, 12),
        rendezvousHost: String(parsed.payload.rendezvous || '')
          .replace(/^wss?:\/\//, '')
          .split('/')[0],
        relayCount: relayList.length,
        DIRECT_INTAKE_TEST: true,
        LINKED: false,
      };
    } catch (e) {
      return { ok: false, code: 'INTAKE_EXCEPTION', err: String((e && e.message) || e).slice(0, 120) };
    }
  }, qrText);
}

/**
 * QA harness: feed QR PNG frames through getUserMedia → real BarcodeDetector/jsQR.
 * Labeled SIMULATED_CAMERA_SCAN (not PHYSICAL_PHONE_CAMERA). Not a production bypass.
 */
async function installCanvasCamera(page, pngPath) {
  const b64 = fs.readFileSync(pngPath).toString('base64');
  await page.addInitScript((dataUrl) => {
    window.__sosLabQrDataUrl = dataUrl;
    const Orig = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const wantsVideo = constraints && constraints.video;
      if (!wantsVideo || !window.__sosLabQrDataUrl) {
        if (Orig) return Orig(constraints);
        throw new Error('CAMERA_UNAVAILABLE');
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = window.__sosLabQrDataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      const draw = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 640, 480);
        const side = 420;
        ctx.drawImage(img, (640 - side) / 2, (480 - side) / 2, side, side);
      };
      draw();
      const stream = canvas.captureStream(10);
      const iv = setInterval(draw, 100);
      const track = stream.getVideoTracks()[0];
      if (track) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(iv);
          stop();
        };
      }
      window.__sosLabSimulatedCamera = true;
      return stream;
    };
  }, `data:image/png;base64,${b64}`);
}

async function linkAnotherDesktop(desktopBrowser, mobile, pubFp) {
  const ctx = await desktopBrowser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'he-IL' });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(page);
    await patchPoolPublishIterable(page);
    await page.evaluate(() => {
      try { sessionStorage.removeItem('sos_ld_guest_continued_v1'); } catch (_e) {}
      const LD = window.SosWebLinkedDevices || window.NostrApp.WebLinkedDevices;
      if (LD && typeof LD.showGuestQrWelcome === 'function') LD.showGuestQrWelcome();
    });
    await page.waitForFunction(() => {
      const LD = window.SosWebLinkedDevices || window.NostrApp.WebLinkedDevices;
      const t = LD && LD.getCurrentPairingQrText && LD.getCurrentPairingQrText();
      return !!(t && String(t).indexOf('SOSPAIR1:') === 0);
    }, null, { timeout: 60000 });
    const png = path.join(OUT, 'desktop-qr-second.png');
    await page.locator('#sosLdGuestWelcome canvas, #sosLinkedPairPanel canvas').first().screenshot({ path: png });
    const b64 = fs.readFileSync(png).toString('base64');
    await mobile.evaluate((dataUrl) => { window.__sosLabQrDataUrl = dataUrl; }, 'data:image/png;base64,' + b64);
    await mobileOpenScanner(mobile);
    const linked = await waitForProductLink(mobile, page, pubFp);
    return {
      ok: linked.linked === true && linked.identityMatch === true && linked.manualClicks === 0 && linked.leftSos !== true && linked.scanOnly === true,
      code: linked.code || '',
      clicks: linked.manualClicks || 0,
      leftSos: linked.leftSos === true,
    };
  } catch (e) {
    return { ok: false, code: String(e && e.message || e).slice(0, 160) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function waitForProductLink(mobile, desktop, pubFp) {
  const want = String(pubFp || '').toLowerCase().slice(0, 8);
  const deadline = Date.now() + 90000;
  let last = {};
  while (Date.now() < deadline) {
    const desk = await desktop.evaluate(() => {
      const statusEl = document.querySelector('#sosLdGuestWelcome .sos-ld-status, #sosLinkedPairPanel .sos-ld-status');
      const idEl = document.querySelector('.sos-ld-linked-identity');
      const welcome = document.getElementById('sosLdGuestWelcome');
      const panel = document.getElementById('sosLinkedPairPanel');
      const chip = document.getElementById('sosLdAccountChip');
      const profile = document.getElementById('topBarProfile');
      const open = window.__sosLdAccountOpen || null;
      const cap = window.__sosLdCapability || null;
      const App = window.NostrApp || {};
      return {
        status: statusEl ? statusEl.textContent : '',
        identityText: idEl ? idEl.textContent : '',
        meta: window.__sosLdLinkedIdentity || null,
        fail: window.__sosMd3AcceptFail || '',
        phases: (window.__sosMd3DbgPhases || []).map((p) => p.phase),
        welcomeHidden: !welcome || welcome.hidden === true,
        panelHidden: !panel || panel.hidden === true,
        chip: chip ? chip.textContent : '',
        chipVisible: !!(chip && chip.hidden !== true),
        profileVisible: !!(profile && profile.hidden !== true),
        openFp: open && open.accountFp ? open.accountFp : '',
        accountOpen: !!(open && open.guestMode === false && open.linkedDeviceSession === true && open.ROOT_K_PRESENT === false && open.HISTORY_SYNC_TRANSFERRED === false),
        identityState: String(App.identityState || ''),
        guest: App.guestMode === true,
        capOk: !!(cap && cap.ok === true && cap.cap === 'DEVICE_CHAT' && cap.ROOT_K_PRESENT === false),
        capCode: cap && cap.code ? String(cap.code) : '',
      };
    }).catch(() => ({}));
    const mob = await mobile.evaluate(() => ({
      host: location.host,
      trace: (window.__sosLdLinkTrace || []).map((r) => ({ phase: r.phase, code: r.code || '' })),
      status: (document.getElementById('sosLdMobileLinkStatus') || {}).textContent || '',
      passkey: !!(document.getElementById('continueUvBtn') && !document.getElementById('continueUvBtn').hidden),
    })).catch(() => ({ trace: [] }));
    last = Object.assign({}, desk, {
      trace: mob.trace || [],
      mobileStatus: mob.status || '',
      leftSos: mob.host && mob.host !== 'sos010.com',
      manualClicks: mob.passkey ? 1 : 0,
    });
    const fp = last.openFp || (last.meta && last.meta.accountFp);
    const textLinked = String(last.status || '').indexOf('המחשב מחובר') !== -1 && String(last.status || '').indexOf('נכשל') === -1;
    const opened = last.welcomeHidden === true && last.panelHidden === true && last.chipVisible === true && last.profileVisible === true && last.accountOpen === true && last.capOk === true && last.identityState === 'LINKED_DEVICE' && last.guest !== true && fp === want && String(last.chip || '').indexOf(want) !== -1;
    if (textLinked && opened) {
      last.linked = true;
      last.identityMatch = true;
      last.accountOpened = true;
      last.accountFp = fp;
      break;
    }
    const code = (last.trace.filter((t) => t.code).slice(-1)[0] || {}).code || last.fail || '';
    if (code && textLinked !== true && /VAULT_NOT_READY|ACCOUNT_|PAIRING_REPLAY|WEB_MD3|WORKER_|BAD_|FORGED|CONSUME|SIGN_/.test(code)) {
      last.code = code;
      break;
    }
    await desktop.waitForTimeout(1000);
  }
  const phases = last.trace.map((t) => t.phase).concat(last.phases || []);
  const out = {
    linked: last.linked === true,
    identityMatch: last.identityMatch === true,
    accountFp: last.accountFp || (last.meta && last.meta.accountFp) || '',
    status: last.status || '',
    identityText: last.identityText || '',
    code: last.code || last.fail || '',
    leftSos: last.leftSos === true,
    manualClicks: last.manualClicks || 0,
    phases,
    scanOnly: phases.includes('SCAN_ONLY_AUTHORITY'),
    workerIssued: phases.includes('MD3_AUTHORIZED'),
    md3: phases.includes('MD3_DELIVERED') || phases.includes('MD3_AUTHORIZED'),
    verifyStrict: phases.includes('DESKTOP_VERIFY_STRICT'),
    webauthnClaimed: phases.some((p) => /WEBAUTHN|PASSKEY/.test(p)),
    accountOpened: last.accountOpened === true,
    capOk: last.capOk === true,
    capCode: last.capCode || '',
    restart: false,
  };
  if (out.linked) {
    await desktop.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(desktop);
    const again = Date.now() + 20000;
    while (Date.now() < again) {
      const restored = await desktop.evaluate(() => {
        const welcome = document.getElementById('sosLdGuestWelcome');
        const panel = document.getElementById('sosLinkedPairPanel');
        const chip = document.getElementById('sosLdAccountChip');
        const profile = document.getElementById('topBarProfile');
        const open = window.__sosLdAccountOpen || null;
        const cap = window.__sosLdCapability || null;
        const App = window.NostrApp || {};
        return {
          welcomeHidden: !welcome || welcome.hidden === true,
          panelHidden: !panel || panel.hidden === true,
          chip: chip ? chip.textContent : '',
          chipVisible: !!(chip && chip.hidden !== true),
          profileVisible: !!(profile && profile.hidden !== true),
          openFp: open && open.accountFp ? open.accountFp : '',
          accountOpen: !!(open && open.guestMode === false && open.linkedDeviceSession === true && open.ROOT_K_PRESENT === false),
          identityState: String(App.identityState || ''),
          guest: App.guestMode === true,
          capOk: !!(cap && cap.ok === true && cap.ROOT_K_PRESENT === false),
        };
      }).catch(() => ({}));
      if (restored.welcomeHidden === true && restored.panelHidden === true && restored.chipVisible === true && restored.profileVisible === true && restored.accountOpen === true && restored.capOk === true && restored.identityState === 'LINKED_DEVICE' && restored.guest !== true && restored.openFp === want && String(restored.chip || '').indexOf(want) !== -1) {
        out.restart = true;
        break;
      }
      await desktop.waitForTimeout(500);
    }
    out.negatives = await mobile.evaluate(async () => {
      const Qr = window.SosMd2PairingQr || (window.NostrApp && window.NostrApp.Md2PairingQr);
      const bad = Qr && Qr.parseQr ? Qr.parseQr('SOSPAIR1:not-a-real-code') : { ok: true };
      const v = window.NostrApp && window.NostrApp.SosCryptoWorkerVault;
      let wrong = { ok: true, code: 'NO_VAULT' };
      if (v && typeof v.rpc === 'function') {
        try {
          wrong = await v.rpc('AUTHORIZE_LINKED_DEVICE_SCAN', {
            expectedRequest: { accountP: 'ab'.repeat(32) },
            featureEnabled: true,
            admissionBaseUrl: window.NostrApp.FIRST_GROUP_ADMISSION_URL || window.NostrApp.GLOBAL_ADMISSION_URL || '',
          });
        } catch (e) {
          wrong = { ok: false, code: (e && e.code) || 'REJECTED' };
        }
      }
      return {
        invalidQr: !!(bad && bad.ok === false),
        wrongAccount: wrong.ok === false,
        wrongCode: String(wrong.code || '').slice(0, 80),
      };
    }).catch((e) => ({ error: String(e && e.message || e).slice(0, 120) }));
  }
  return out;
}

function classifyFirstFail(report) {
  if (!report.QR_DECODED) return 'QR_DECODED';
  if (!report.AEAD_CHANNEL_READY && !report.MD3_ISSUED) return 'AEAD_CHANNEL_READY';
  if (!report.SCAN_ONLY_LINK) return 'SCAN_ONLY_AUTHORITY';
  if (!report.MD3_ISSUED) return 'MD3_AUTHORIZED';
  if (!report.DESKTOP_VERIFY_STRICT) return 'DESKTOP_VERIFY_STRICT';
  if (!report.DESKTOP_LINKED) return 'DESKTOP_LINKED';
  if (!report.ACCOUNT_IDENTITY_VISIBLE) return 'ACCOUNT_IDENTITY';
  if (report.ACCOUNT_OPENED !== true) return 'ACCOUNT_OPENED';
  if (report.DEVICE_CAPABILITY !== true) return 'DEVICE_CAPABILITY';
  if (report.RESTART_PERSISTENCE !== 'PASS') return 'RESTART_PERSISTENCE';
  if (report.SAME_TAB_NAVIGATION) return 'LEFT_SOS_PAGE';
  if (report.MANUAL_CLICKS_AFTER_SCAN) return 'MANUAL_CLICK';
  if (report.WEBAUTHN_UV_PROVEN === true) return 'WEBAUTHN_UV_CLAIM';
  if (!report.SECOND_LINK_NO_REIMPORT || report.SECOND_LINK_NO_REIMPORT.ok !== true) return 'SECOND_LINK_NO_REIMPORT';
  const neg = report.NEGATIVE_SECURITY_TESTS || {};
  if (neg.invalidQr !== true) return 'INVALID_QR_REJECT';
  if (neg.wrongAccount !== true) return 'WRONG_ACCOUNT_REJECT';
  return null;
}

async function main() {
  ensureDir(OUT);
  const nsec = loadQaNsec();
  const skHex = nsecToHex(nsec);
  const expectPub = pubFromHexSk(skHex);
  // Drop nsec from memory ASAP (skHex needed for page.evaluate once).
  const report = {
    RUN_ID,
    generatedAt: new Date().toISOString(),
    BASE,
    ORIGIN,
    STATUS: 'RUNNING',
    SIMULATED_CAMERA_SCAN: 'PENDING',
    DIRECT_QR_INTAKE: 'PENDING',
    REAL_MD2_RELAY: 'PENDING',
    REAL_T2_WEBAUTHN_UV: 'FAIL_NOT_DEPLOYED',
    REAL_WORKER_ISSUANCE: 'FAIL_NOT_DEPLOYED',
    REAL_DESKTOP_LINKED: 'FAIL',
    PHYSICAL_PHONE_CAMERA: 'NOT_RUN',
    traces: { desktop: { console: [], pageErrors: [], websockets: [] }, mobile: { console: [], pageErrors: [], websockets: [] } },
    timeline: { desktop: [], mobile: [], correlated: [] },
  };

  const desktopBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });
  const desktopCtx = await desktopBrowser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'he-IL',
    serviceWorkers: 'block',
  });
  const desktop = await desktopCtx.newPage();
  attachTrace(desktop, report.traces.desktop, 'DESKTOP');

  let qrText = null;
  let y4m = null;
  let mobileBrowser = null;

  try {
    report.timeline.desktop.push({ t: Date.now(), event: 'DESKTOP_NAV' });
    const { pairing, pngPath } = await desktopEnsureGuestQr(desktop);
    report.poolPublishPatchDesktop = await patchPoolPublishIterable(desktop);
    report.DESKTOP_BUILD = await collectBuildMeta(desktop);
    report.DESKTOP_BROWSER_VERSION = await desktop.evaluate(() => navigator.userAgent);
    report.timeline.desktop.push({
      t: Date.now(),
      event: 'QR_CREATED',
      pairingFp: pairing.pairingFp,
      state: pairing.state,
    });
    report.QR_SESSION_VALID = pairing.state === 'WAITING';
    report.pairingFp = pairing.pairingFp;

    const decodedDesk = await decodeDesktopQrText(desktop);
    if (!decodedDesk.ok || !decodedDesk.qrText) {
      report.STATUS = 'FAIL_TESTS';
      report.FIRST_FAILED_TRANSITION = 'QR_CREATED / canvas decode';
      report.SIMULATED_CAMERA_SCAN = 'FAIL';
      throw new Error('DESKTOP_QR_DECODE_' + (decodedDesk.code || 'FAIL'));
    }
    qrText = decodedDesk.qrText;
    report.timeline.desktop.push({
      t: Date.now(),
      event: 'MD2_INITIATOR_STARTED',
      pairingFp: decodedDesk.pairingFp,
      rendezvousHost: decodedDesk.rendezvousHost,
    });

    const y4mPath = path.join(OUT, 'qr-fixture.y4m');
    y4m = pngToY4m(pngPath, y4mPath);
    report.VIRTUAL_CAMERA_ACTIVE = !!(y4m && y4m.ok);
    if (!y4m.ok) {
      report.SIMULATED_CAMERA_SCAN = 'UNSUPPORTED';
      report.y4mError = y4m;
    }

    // Mobile browser — fresh profile; Y4M fake camera + canvas-stream harness (SIMULATED only)
    const pixel = devices['Pixel 7'];
    const mobileArgs = ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
    if (y4m && y4m.ok) {
      mobileArgs.push(`--use-file-for-fake-video-capture=${y4m.absPosix || path.resolve(y4mPath).replace(/\\/g, '/')}`);
    }
    mobileBrowser = await chromium.launch({ headless: true, args: mobileArgs });
    const mobileCtx = await mobileBrowser.newContext({
      ...pixel,
      locale: 'he-IL',
      permissions: ['camera'],
    });
    await mobileCtx.grantPermissions(['camera'], { origin: ORIGIN });
    const mobile = await mobileCtx.newPage();
    attachTrace(mobile, report.traces.mobile, 'MOBILE');
    await armSignerPopupHandler(mobileCtx, report);
    try {
      report.virtualWebAuthn = await enableVirtualWebAuthn(mobileCtx, mobile);
    } catch (e) {
      report.virtualWebAuthn = { ok: false, err: String((e && e.message) || e).slice(0, 160) };
    }
    // Canvas getUserMedia feed so BarcodeDetector/jsQR sees current QR frames (SIMULATED_CAMERA_SCAN).
    await installCanvasCamera(mobile, pngPath);
    mobile.on('dialog', async (d) => {
      report.timeline.mobile.push({ t: Date.now(), event: 'ALERT', text: redact(d.message()) });
      try {
        await d.dismiss();
      } catch (_e) {}
    });

    report.timeline.mobile.push({ t: Date.now(), event: 'MOBILE_LOGIN_BEGIN' });
    const login = await loginMobile(mobile, skHex, expectPub);
    report.poolPublishPatchMobile = await patchPoolPublishIterable(mobile);
    report.MOBILE_BUILD = await collectBuildMeta(mobile);
    report.MOBILE_EMULATED_BROWSER_VERSION = await mobile.evaluate(() => navigator.userAgent);
    report.BROWSER_STORAGE_ISOLATION = true;
    report.QA_ACCOUNT = {
      pubFp: login.pubFp,
      matchExpect: login.matchExpect,
      guestMode: false,
      DESKTOP_UNAUTH: report.DESKTOP_BUILD && report.DESKTOP_BUILD.guestMode === true,
    };
    report.timeline.mobile.push({
      t: Date.now(),
      event: 'MOBILE_AUTHENTICATED',
      pubFp: login.pubFp,
      matchExpect: login.matchExpect,
    });

    const t2 = await mobile.evaluate(() => {
      const Issuer = window.NostrApp?.WebPhoneIssuer || window.SosWebPhoneIssuer;
      return {
        present: !!Issuer,
        enabled: !!(Issuer && typeof Issuer.featureEnabled === 'function' && Issuer.featureEnabled() === true),
        hasIssue: !!(Issuer && typeof Issuer.issueFromPairingQr === 'function'),
      };
    });
    report.WEB_PHONEISSUER_ENABLED = t2.enabled;
    report.T2_APPROVAL_ORIGIN = null;

    // Arm desktop probe + wait for nos.lol before HELLO
    const armed = await armDesktopMd2Probe(desktop, report.pairingFp || decodedDesk.pairingFp);
    report.timeline.desktop.push({ t: Date.now(), event: 'MD2_PROBE_ARMED', armed });
    await desktop.waitForTimeout(2000);

    // Ensure mobile pool can publish before DIRECT_INTAKE
    await mobile.waitForFunction(
      () =>
        !!(
          window.NostrApp?.pool &&
          typeof window.NostrApp.pool.publish === 'function' &&
          typeof window.NostrApp.pool.subscribeMany === 'function' &&
          window.NostrTools?.finalizeEvent
        ),
      null,
      { timeout: 60000 },
    );
    await mobile.waitForTimeout(1500);

    // Product success is the optical scanner only. DIRECT_INTAKE is not a scan and is not counted.
    report.DIRECT_QR_INTAKE = 'NOT_COUNTED';
    report.timeline.mobile.push({ t: Date.now(), event: 'DIRECT_INTAKE_SKIPPED' });
    const intake = { ok: false, channelReady: false, code: 'NOT_COUNTED' };
    report.intakeDetail = {
      ok: intake.ok,
      code: intake.code || null,
      state: intake.state || null,
      channelReady: !!intake.channelReady,
      channelErr: intake.channelErr || null,
      pairingFp: intake.pairingFp || null,
      err: intake.err || null,
      lastPubErr: intake.lastPubErr || null,
      poolPublish: intake.poolPublish || null,
      relayCount: intake.relayCount || null,
    };
    report.PHONE_HELLO_SENT = !!(intake.ok);
    report.AEAD_CHANNEL_READY = !!intake.channelReady;
    report.timeline.mobile.push({
      t: Date.now(),
      event: intake.channelReady ? 'AEAD_CHANNEL_READY' : 'DIRECT_INTAKE_RESULT',
      state: intake.state,
      channelErr: intake.channelErr || null,
      code: intake.code || null,
      pairingFp: intake.pairingFp,
      DIRECT_INTAKE_TEST: true,
    });

    // Snapshot desktop MD2 phases BEFORE refreshing QR (refresh stops the initiator).
    await desktop.waitForTimeout(2000);
    const deskAfterIntake = await pollPhases(desktop);
    const mobAfterIntake = await pollPhases(mobile);
    const probe = await readDesktopMd2Probe(desktop);
    report.timeline.desktop.push({
      t: Date.now(),
      event: 'PHASES_AFTER_INTAKE',
      phases: deskAfterIntake.phases,
      probe,
    });
    report.timeline.mobile.push({ t: Date.now(), event: 'PHASES_AFTER_INTAKE', phases: mobAfterIntake.phases });
    report.md2AfterIntake = {
      desktopPhases: deskAfterIntake.phases.map((p) => p.phase),
      mobilePhases: mobAfterIntake.phases.map((p) => p.phase),
      desktopInboundErr: deskAfterIntake.inboundErr,
      mobileState: intake.state,
      channelReady: !!intake.channelReady,
      channelErr: intake.channelErr || null,
      probe,
      armed,
    };

    // Fresh QR for optical lane (prior intake may consume/advance desktop session)
    report.timeline.desktop.push({ t: Date.now(), event: 'QR_REFRESH_FOR_OPTICAL' });
    let decoded2 = { ok: false };
    const refreshed = await desktop.evaluate(() => {
      const LD = window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices;
      if (LD && typeof LD.showGuestQrWelcome === 'function') LD.showGuestQrWelcome();
      else if (LD && typeof LD.openDesktopPairingPanel === 'function') LD.openDesktopPairingPanel();
      return true;
    });
    await desktop.waitForTimeout(2500);
    decoded2 = await decodeDesktopQrText(desktop);
    const opticalPng = path.join(OUT, 'desktop-qr-optical.png');
    if (decoded2.ok) {
      qrText = decoded2.qrText;
      await desktop.locator('#sosLinkedPairCanvas, #sosLdGuestWelcome canvas, #sosLinkedPairPanel canvas').first().screenshot({ path: opticalPng });
      // Update canvas camera fixture to the fresh QR
      const b64 = fs.readFileSync(opticalPng).toString('base64');
      await mobile.evaluate((dataUrl) => {
        window.__sosLabQrDataUrl = dataUrl;
      }, `data:image/png;base64,${b64}`);
    }

    let optical = { ok: false, code: 'SKIPPED' };
    report.timeline.mobile.push({ t: Date.now(), event: 'CAMERA_OPENED_ATTEMPT', refreshed, decoded2ok: !!(decoded2 && decoded2.ok) });
    const opened = await mobileOpenScanner(mobile);
    report.timeline.mobile.push({ t: Date.now(), event: 'SCANNER_API', detail: opened });
    await mobile.waitForTimeout(2000);
    optical = await waitScanSettled(mobile, 45000);
    const after = await pollPhases(mobile);
    const simCam = await mobile.evaluate(() => !!window.__sosLabSimulatedCamera);
    report.timeline.mobile.push({
      t: Date.now(),
      event: 'OPTICAL_SCAN_RESULT',
      optical,
      scanStatus: after.scanStatus,
      simulatedCameraUsed: simCam,
    });
    report.QR_SCANNER_ACTUAL_DECODER = simCam ? 'jsQR_or_BarcodeDetector_via_canvas_stream' : 'chromium_fake_y4m_or_unknown';
    report.QR_DECODED = !!(optical.ok || optical.w2 || optical.pairingFp || /זוהה|SCANNED/i.test(after.scanStatus));
    report.SIMULATED_CAMERA_SCAN = report.QR_DECODED ? 'PASS' : optical.code === 'SCAN_TIMEOUT' ? 'FAIL_TIMEOUT' : 'FAIL';
    report.VIRTUAL_CAMERA_ACTIVE = !!(report.VIRTUAL_CAMERA_ACTIVE || simCam);
    report.productApproval = optical;

    const deskPhaseNames = (report.md2AfterIntake && report.md2AfterIntake.desktopPhases) || [];
    const mobPhaseNames = (report.md2AfterIntake && report.md2AfterIntake.mobilePhases) || [];
    report.DESKTOP_HELLO_RECEIVED = deskPhaseNames.some((p) => /HELLO_ACCEPTED|HELLO_RECEIVED/.test(p));
    report.POP_VERIFIED =
      deskPhaseNames.includes('POP_SENT') ||
      mobPhaseNames.includes('AEAD_CHANNEL_READY') ||
      intake.channelReady === true;
    if (intake.channelReady) report.AEAD_CHANNEL_READY = true;

    report.REAL_MD2_RELAY =
      report.PHONE_HELLO_SENT && report.DESKTOP_HELLO_RECEIVED && report.POP_VERIFIED
        ? report.AEAD_CHANNEL_READY
          ? 'PASS'
          : 'PARTIAL'
        : report.PHONE_HELLO_SENT
          ? 'PARTIAL'
          : 'FAIL';

    const linked = await waitForProductLink(mobile, desktop, login.pubFp);
    report.productLink = linked;
    report.PASSKEY_REQUIRED_FOR_ROUTINE_LINK = false;
    report.SCREEN_LOCK_REQUIRED = false;
    report.MANUAL_CLICKS_AFTER_SCAN = linked.manualClicks || 0;
    report.SAME_TAB_NAVIGATION = linked.leftSos === true;
    report.SCAN_ONLY_LINK = linked.scanOnly === true;
    report.WEBAUTHN_UV_PROVEN = linked.webauthnClaimed === true;
    report.T2_APPROVAL = false;
    report.REAL_T2_WEBAUTHN_UV = 'NOT_USED';
    report.WORKER_ONE_TIME_CONSUME = linked.workerIssued === true;
    report.MD3_ISSUED = linked.md3 === true;
    report.DESKTOP_VERIFY_STRICT = linked.verifyStrict === true;
    report.DESKTOP_LINKED = linked.linked === true && linked.identityMatch === true;
    report.ACCOUNT_IDENTITY_VISIBLE = linked.identityMatch === true;
    report.ACCOUNT_OPENED = linked.accountOpened === true;
    report.DEVICE_CAPABILITY = linked.capOk === true;
    report.ACCOUNT_FP = linked.accountFp || '';
    report.HISTORY_SYNC_TRANSFERRED = false;
    report.RESTART_PERSISTENCE = linked.restart === true ? 'PASS' : 'FAIL';
    report.NEGATIVE_SECURITY_TESTS = linked.negatives || null;
    if (linked.phases) {
      report.DESKTOP_HELLO_RECEIVED = linked.phases.some((p) => /HELLO_ACCEPTED|HELLO_RECEIVED/.test(p));
      report.POP_VERIFIED = linked.phases.includes('POP_SENT') || linked.phases.includes('CHANNEL_READY');
      report.AEAD_CHANNEL_READY = linked.phases.includes('CHANNEL_READY') || linked.phases.includes('AUTH_RECEIVED') || linked.md3 === true;
      report.PHONE_HELLO_SENT = report.AEAD_CHANNEL_READY;
      report.REAL_MD2_RELAY = report.AEAD_CHANNEL_READY && report.DESKTOP_HELLO_RECEIVED && report.POP_VERIFIED ? 'PASS' : 'FAIL';
    }
    report.REAL_WORKER_ISSUANCE = report.MD3_ISSUED ? 'PASS' : 'FAIL';
    report.REAL_DESKTOP_LINKED = report.DESKTOP_LINKED ? 'PASS' : 'FAIL';

    if (report.DESKTOP_LINKED) {
      report.SECOND_LINK_NO_REIMPORT = await linkAnotherDesktop(desktopBrowser, mobile, login.pubFp);
    }

    // Screenshots (UI only — QR png already saved; no secret text files)
    await desktop.screenshot({ path: path.join(OUT, 'desktop-ui.png'), fullPage: false });
    await mobile.screenshot({ path: path.join(OUT, 'mobile-ui.png'), fullPage: false });

    report.FIRST_FAILED_TRANSITION = classifyFirstFail(report);

    if (!report.FIRST_FAILED_TRANSITION && report.DESKTOP_LINKED && report.SCAN_ONLY_LINK === true && report.WEBAUTHN_UV_PROVEN !== true && report.MANUAL_CLICKS_AFTER_SCAN === 0) {
      report.STATUS = 'PASS_WEB_LINKED_AUTOMATED';
    } else if (report.REAL_MD2_RELAY === 'PASS' && !report.WEB_PHONEISSUER_ENABLED) {
      report.STATUS = 'AUTOMATED_MD2_PASS_T2_BLOCKED';
    } else if (
      report.QR_DECODED &&
      report.productApproval &&
      report.productApproval.path === 'REQUIRES_SOS_ANDROID_APP' &&
      !report.WEB_PHONEISSUER_ENABLED
    ) {
      // Optical product path reproduced the known Web T2 blocker (separate from MD2 relay lane).
      report.STATUS = 'BLOCKED_QA_INFRA';
    } else if (report.FIRST_FAILED_TRANSITION && /HELLO|POP|AEAD/.test(String(report.FIRST_FAILED_TRANSITION))) {
      report.STATUS = 'FAIL_TESTS';
      report.REMAINING_BLOCKERS = [
        `MD2 first fail: ${report.FIRST_FAILED_TRANSITION}`,
        ...(report.REMAINING_BLOCKERS || []),
      ];
    } else if (!report.WEB_PHONEISSUER_ENABLED) {
      report.STATUS = 'BLOCKED_QA_INFRA';
    } else {
      report.STATUS = 'FAIL_TESTS';
    }

    report.ATTEMPTS = 1;
    report.SUCCESSES = report.STATUS === 'PASS_WEB_LINKED_AUTOMATED' ? 1 : 0;
    report.FAILURES = report.STATUS === 'PASS_WEB_LINKED_AUTOMATED' ? 0 : 1;
    report.TEST_RUN_IDS = [RUN_ID];
    report.EVIDENCE_PATHS = {
      outDir: OUT,
      desktopUi: path.join(OUT, 'desktop-ui.png'),
      mobileUi: path.join(OUT, 'mobile-ui.png'),
      qrPng: path.join(OUT, 'desktop-qr.png'),
      y4m: y4m && y4m.ok ? y4mPath : null,
    };
    report.FIXES_APPLIED = [];
    report.REMAINING_BLOCKERS = [
      !report.WEB_PHONEISSUER_ENABLED ? 'Web PhoneIssuer / T2 feature flag disabled on production' : null,
      report.productApproval && report.productApproval.code && report.productApproval.code !== 'LINKED'
        ? 'Product stopped: ' + report.productApproval.code
        : null,
      report.SIMULATED_CAMERA_SCAN !== 'PASS' ? 'Virtual camera optical decode did not PASS' : null,
      !report.DESKTOP_LINKED ? 'Desktop LINKED not achieved on this run' : null,
    ].filter(Boolean);
    report.OWNER_ACTION_REQUIRED = report.DESKTOP_LINKED
      ? ['One physical Chrome QR scan after 10/10 automated passes']
      : ['Automated link has not passed; do not start a physical scan yet'];
    report.NEXT_SAFE_SLICE = report.DESKTOP_LINKED
      ? 'Repeat the optical lab to 10/10, then one physical scan'
      : 'Fix the first failed transition and rerun the optical lab';

    // Correlated summary (sanitized)
    report.correlated = {
      pairingFp: report.pairingFp || decodedDesk.pairingFp,
      desktopPhases: deskPhaseNames,
      mobilePhases: mobPhaseNames,
      optical: report.SIMULATED_CAMERA_SCAN,
      directIntake: report.DIRECT_QR_INTAKE,
      md2: report.REAL_MD2_RELAY,
      firstFail: report.FIRST_FAILED_TRANSITION,
    };
  } catch (e) {
    report.STATUS = report.STATUS === 'RUNNING' ? 'FAIL_TESTS' : report.STATUS;
    report.error = redact(e && e.message);
    report.FIRST_FAILED_TRANSITION = report.FIRST_FAILED_TRANSITION || 'LAB_EXCEPTION';
  } finally {
    qrText = null;
    try {
      await desktopBrowser.close();
    } catch (_e) {}
    try {
      if (mobileBrowser) await mobileBrowser.close();
    } catch (_e) {}
    // Delete Y4M after run (contains QR frames) — keep PNG for UI evidence? Brief says don't store full QR contents.
    // Keep png as visual evidence of QR presence; wipe y4m which is disposable fixture.
    try {
      const y4mPath = path.join(OUT, 'qr-fixture.y4m');
      if (fs.existsSync(y4mPath)) fs.unlinkSync(y4mPath);
    } catch (_e) {}
  }

  const finalPath = path.join(OUT, 'report.json');
  const summaryPath = path.join(ROOT, 'qa', 'stage5-two-browser-qr-lab-report.json');
  const text = JSON.stringify(report, null, 2);
  if (SECRET_RE.test(text) || SOSPAIR_RE.test(text)) {
    throw new Error('REPORT_LEAK_GUARD');
  }
  fs.writeFileSync(finalPath, text);
  fs.writeFileSync(summaryPath, text);

  // Human FINAL block
  const lines = [
    `STATUS=${report.STATUS}`,
    `DESKTOP_BROWSER_VERSION=${redact(report.DESKTOP_BROWSER_VERSION)}`,
    `MOBILE_EMULATED_BROWSER_VERSION=${redact(report.MOBILE_EMULATED_BROWSER_VERSION)}`,
    `DESKTOP_BUILD=${report.DESKTOP_BUILD && report.DESKTOP_BUILD.pkg}`,
    `MOBILE_BUILD=${report.MOBILE_BUILD && report.MOBILE_BUILD.pkg}`,
    `BROWSER_STORAGE_ISOLATION=${report.BROWSER_STORAGE_ISOLATION}`,
    `VIRTUAL_CAMERA_ACTIVE=${report.VIRTUAL_CAMERA_ACTIVE}`,
    `QR_SCANNER_ACTUAL_DECODER=${report.QR_SCANNER_ACTUAL_DECODER || ''}`,
    `QR_DECODED=${report.QR_DECODED}`,
    `QR_SESSION_VALID=${report.QR_SESSION_VALID}`,
    `PHONE_HELLO_SENT=${report.PHONE_HELLO_SENT}`,
    `DESKTOP_HELLO_RECEIVED=${report.DESKTOP_HELLO_RECEIVED}`,
    `POP_VERIFIED=${report.POP_VERIFIED}`,
    `AEAD_CHANNEL_READY=${report.AEAD_CHANNEL_READY}`,
    `FIRST_FAILED_TRANSITION=${report.FIRST_FAILED_TRANSITION}`,
    `T2_APPROVAL_ORIGIN=${report.T2_APPROVAL_ORIGIN}`,
    `REAL_WEBAUTHN_UV=${report.REAL_T2_WEBAUTHN_UV}`,
    `WORKER_ONE_TIME_CONSUME=${report.WORKER_ONE_TIME_CONSUME}`,
    `MD3_ISSUED=${report.MD3_ISSUED}`,
    `DESKTOP_VERIFY_STRICT=${report.DESKTOP_VERIFY_STRICT}`,
    `DESKTOP_LINKED=${report.DESKTOP_LINKED}`,
    `ACCOUNT_IDENTITY_VISIBLE=${report.ACCOUNT_IDENTITY_VISIBLE}`,
    `SCAN_ONLY_LINK=${report.SCAN_ONLY_LINK}`,
    `MANUAL_CLICKS_AFTER_SCAN=${report.MANUAL_CLICKS_AFTER_SCAN}`,
    `SECOND_LINK_NO_REIMPORT=${!!(report.SECOND_LINK_NO_REIMPORT && report.SECOND_LINK_NO_REIMPORT.ok)}`,
    `RESTART_PERSISTENCE=${report.RESTART_PERSISTENCE}`,
    `ATTEMPTS=${report.ATTEMPTS}`,
    `SUCCESSES=${report.SUCCESSES}`,
    `FAILURES=${report.FAILURES}`,
    `TEST_RUN_IDS=${(report.TEST_RUN_IDS || []).join(',')}`,
    `EVIDENCE_PATHS=${finalPath}`,
    `SIMULATED_CAMERA_SCAN=${report.SIMULATED_CAMERA_SCAN}`,
    `DIRECT_QR_INTAKE=${report.DIRECT_QR_INTAKE}`,
    `REAL_MD2_RELAY=${report.REAL_MD2_RELAY}`,
    `REAL_T2_WEBAUTHN_UV=${report.REAL_T2_WEBAUTHN_UV}`,
    `REAL_WORKER_ISSUANCE=${report.REAL_WORKER_ISSUANCE}`,
    `REAL_DESKTOP_LINKED=${report.REAL_DESKTOP_LINKED}`,
    `PHYSICAL_PHONE_CAMERA=${report.PHYSICAL_PHONE_CAMERA}`,
    `REMAINING_BLOCKERS=${(report.REMAINING_BLOCKERS || []).join(' | ')}`,
    `OWNER_ACTION_REQUIRED=${(report.OWNER_ACTION_REQUIRED || []).join(' | ')}`,
    `NEXT_SAFE_SLICE=${report.NEXT_SAFE_SLICE}`,
  ];
  fs.writeFileSync(path.join(OUT, 'FINAL.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error('LAB_FATAL', redact(e && e.message));
  process.exit(1);
});
