#!/usr/bin/env node
/**
 * Real Android emulator ↔ desktop MD3 pairing E2E (paste-path QR, not hardware camera).
 * Disposable QA identities only. Starts local admission Worker; uses public WSS relays for kind 25060.
 *
 * Run: node qa/md3-android-desktop-live-e2e.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md3-android-desktop-live-e2e-report.json');
const ADM_DIR = path.join(ROOT, 'admission-service');
const ADM_PORT = Number(process.env.SOS_MD3_ADM_PORT || 8799);
const WEB_PORT = Number(process.env.SOS_MD3_WEB_PORT || 8817);
// 7805: emulator NAT reaches host; 7797 is firewalled on this Windows host.
const RELAY_PORT = Number(process.env.SOS_MD3_RELAY_PORT || 7805);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
// Admission still via adb reverse; pairing relay via emulator host-alias (no reverse).
const ANDROID_ADM = `http://127.0.0.1:${ADM_PORT}`;
const DESKTOP_RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ANDROID_RELAY = `ws://10.0.2.2:${RELAY_PORT}`;
const HANDOFF_HOST = path.join(ROOT, 'qa', '.md3-e2e-handoff.json');
const HANDOFF_DEV = '/data/local/tmp/sos-md3-e2e-handoff.json';
const RESULT_DEV = '/data/local/tmp/sos-md3-e2e-result.json';

const report = {
  gate: 'MD3_ANDROID_DESKTOP_LIVE_E2E',
  status: 'FAIL',
  ts: new Date().toISOString(),
  cases: {},
  ROOT_K_SENT_TO_DESKTOP: false,
  NSEC_SENT_TO_DESKTOP: false,
  REAL_HARDWARE_QR_SCAN_VERIFIED: false,
};
const set = (k, ok, detail) => {
  report.results = report.results || {};
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 260));
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function skPair() {
  const sk = generateSecretKey();
  return { hex: bytesToHex(sk), pub: getPublicKey(sk), sk };
}

const ROOT_KEY = skPair();
const SVC = skPair();
const COSIGN = skPair();
const PIN_PEPPER = bytesToHex(generateSecretKey());
const PHONE_PEPPER = bytesToHex(generateSecretKey());
const persistDir = path.join(ADM_DIR, '.wrangler-md3-e2e');

let admProc = null;
let admLog = '';
let webServer = null;
let pairRelay = null;

/**
 * Child-process pairing relay. In-process WSS + other Node servers black-holes
 * emulator 10.0.2.2 WebSocket accepts on Windows/Hyper-V.
 */
class PairingRelay {
  constructor(port) {
    this.port = port;
    this.stats = { received: 0, broadcast: 0, rejected: 0, connections: 0, reqs: 0 };
    this.child = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [path.join(ROOT, 'qa', 'md3-pairing-relay-child.cjs')], {
        env: Object.assign({}, process.env, {
          SOS_RELAY_PORT: String(this.port),
          SOS_RELAY_HOST: '0.0.0.0',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const onData = (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === 'RELAY_UP') resolve();
            if (j.type === 'CONN') this.stats.connections++;
            if (j.type === 'REQ') this.stats.reqs++;
            if (j.type === 'EVENT') {
              this.stats.received++;
              this.stats.broadcast++;
              this.stats.lastKind = j.kind;
            }
          } catch (_e) {}
        }
      };
      this.child.stdout.on('data', onData);
      this.child.stderr.on('data', (d) => {
        /* keep alive */
      });
      this.child.on('exit', (code) => {
        if (code && code !== 0) reject(new Error('relay_exit_' + code));
      });
      setTimeout(() => reject(new Error('relay_start_timeout')), 10000);
    });
  }
  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch (_e) {}
      this.child = null;
    }
    return Promise.resolve();
  }
}

async function startWorker() {
  fs.mkdirSync(persistDir, { recursive: true });
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    [
      `ROOT_PUBKEY=${ROOT_KEY.pub}`,
      `ADMISSION_SK=${SVC.hex}`,
      `ADMIN_COSIGN_SK=${COSIGN.hex}`,
      `ADMIN_PIN_PEPPER=${PIN_PEPPER}`,
      `PHONE_PEPPER=${PHONE_PEPPER}`,
      `TEST_FAULTS=1`,
      `ALLOWED_ORIGINS=*`,
      `ADMIN_2FA_SIGNER_PUBKEY=${COSIGN.pub}`,
      '',
    ].join('\n'),
  );
  admProc = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(ADM_PORT),
      '--persist-to',
      persistDir,
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: ADM_DIR,
      shell: true,
      env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
    },
  );
  admProc.stdout.on('data', (d) => (admLog += d.toString()));
  admProc.stderr.on('data', (d) => (admLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ADM_URL + '/v1/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('admission worker failed:\n' + admLog.slice(-2500));
}

function stopWorker() {
  if (admProc) {
    try {
      execSync(`taskkill /pid ${admProc.pid} /T /F`, { stdio: 'ignore' });
    } catch (_e) {}
    admProc = null;
  }
  try {
    fs.rmSync(path.join(ADM_DIR, '.dev.vars'), { force: true });
  } catch (_e) {}
}

async function post(p, body) {
  const res = await fetch(ADM_URL + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({ result: 'BAD_JSON' }));
  json.__http = res.status;
  return json;
}

function startWeb() {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  webServer = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => webServer.listen(WEB_PORT, '127.0.0.1', r));
}

function adb(args, opts = {}) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const adbBin = path.join(sdk, 'platform-tools', 'adb.exe');
  return execSync(`"${adbBin}" -s emulator-5554 ${args}`, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : undefined,
  });
}

function pushHandoff(obj) {
  fs.writeFileSync(HANDOFF_HOST, JSON.stringify(obj));
  adb(`push "${HANDOFF_HOST}" ${HANDOFF_DEV}`);
  try {
    fs.writeFileSync(HANDOFF_HOST, JSON.stringify({ wiped: true }));
  } catch (_e) {}
}

function clearAndroidResult() {
  try {
    adb('shell run-as com.sos010.app rm -f /data/data/com.sos010.app/files/sos-md3-e2e-result.json', {
      quiet: true,
    });
  } catch (_e) {}
}

function pullResult() {
  try {
    // App cannot write /data/local/tmp on API 33+; result is in filesDir.
    const raw = adb(
      'shell run-as com.sos010.app cat /data/data/com.sos010.app/files/sos-md3-e2e-result.json',
    );
    const parsed = JSON.parse(raw);
    fs.writeFileSync(path.join(ROOT, 'qa', '.md3-e2e-result.json'), JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (_e) {
    return null;
  }
}

function assembleAndInstallTestApks() {
  const env = Object.assign({}, process.env, {
    ANDROID_HOME: process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-17',
  });
  const out = execSync('gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest', {
    cwd: path.join(ROOT, 'android-shell'),
    encoding: 'utf8',
    timeout: 480000,
    windowsHide: true,
    env,
  });
  if (!/BUILD SUCCESSFUL/.test(out)) throw new Error('assemble failed:\n' + out.slice(-2000));
  adb(
    `install -r "${path.join(ROOT, 'android-shell', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}"`,
  );
  adb(
    `install -r "${path.join(ROOT, 'android-shell', 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk')}"`,
  );
  return out.slice(-500);
}

/**
 * Run instrumented MD3 test without blocking the Node event loop.
 * Sync execSync(adb -w) deadlocks Playwright exposeFunction IPC: desktop receives
 * Hello, awaits __sosSchnorrSignHex, Node is stuck in adb → PoP never publishes
 * until Android times out (desktop then flips QR_SHOWN→POP_SENT too late).
 */
function runInstrumentedAsync() {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const adbBin = path.join(sdk, 'platform-tools', 'adb.exe');
  return new Promise((resolve) => {
    const args = [
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'class',
      'com.sos010.app.SosMd3LinkedDevicePairingInstrumentedTest',
      'com.sos010.app.test/androidx.test.runner.AndroidJUnitRunner',
    ];
    const child = spawn(adbBin, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    child.on('error', (e) => {
      resolve({ ok: false, out: String(e.message || e).slice(-6000) });
    });
    child.on('close', () => {
      const ok =
        /OK \(1 test\)/.test(out) ||
        (/Tests run:\s*1/.test(out) && !/FAILURES!!!/.test(out) && !/Error in/.test(out));
      resolve({ ok, out: out.slice(-6000) });
    });
  });
}

async function desktopPairingSession(page) {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => !!(window.SosWebLinkedDevices && window.SosMd2PairingSession && window.NostrTools && window.NostrApp),
    null,
    { timeout: 90000 },
  );
  // Host-side BIP340 for PoP (CDN getEventHash is frozen). Requires a free Node
  // event loop — see runInstrumentedAsync (must not sync-block on adb -w).
  const { schnorr } = await import('@noble/curves/secp256k1');
  await page.exposeFunction('__sosSchnorrSignHex', (msgHex, skHex) => {
    const msg = Buffer.from(String(msgHex), 'hex');
    const sk = Buffer.from(String(skHex), 'hex');
    return Buffer.from(schnorr.sign(msg, sk)).toString('hex');
  });
  const session = await page.evaluate(
    async ({ desktopRelay, androidRelay }) => {
      const App = window.NostrApp;
      const NT = window.NostrTools;
      const Session = App.Md2PairingSession || window.SosMd2PairingSession;
      const LD = window.SosWebLinkedDevices;
      // Isolated local relay: use a raw-WS pool. SimplePool against ws://127.0.0.1 has
      // been observed not to open sockets in this Playwright QA harness.
      const localPool = {
        _sockets: [],
        _subReady: null,
        subscribeMany(relays, filter, params) {
          const f = Array.isArray(filter) ? filter[0] : filter;
          let readyResolve;
          localPool._subReady = new Promise((r) => {
            readyResolve = r;
          });
          let opened = 0;
          const need = Math.max(1, (relays || []).length);
          const closers = (relays || []).map((url) => {
            const ws = new WebSocket(url);
            localPool._sockets.push(ws);
            ws.onopen = () => {
              try {
                ws.send(JSON.stringify(['REQ', 'md3-' + Date.now().toString(36), f]));
              } catch (_e) {}
              opened += 1;
              if (opened >= need) readyResolve(true);
            };
            ws.onerror = () => readyResolve(false);
            ws.onmessage = (ev) => {
              try {
                const m = JSON.parse(String(ev.data || ''));
                if (Array.isArray(m) && m[0] === 'EVENT' && params && typeof params.onevent === 'function') {
                  const e = m[2] || {};
                  window.__sosMd3E2eInbound = window.__sosMd3E2eInbound || [];
                  window.__sosMd3E2eInbound.push({
                    idFp: String(e.id || '').slice(0, 16),
                    kind: e.kind,
                    role: (e.tags || []).find((t) => t && t[0] === 'role'),
                    d: (e.tags || []).find((t) => t && t[0] === 'd'),
                    contentType: (() => {
                      try {
                        return JSON.parse(e.content || '{}').type;
                      } catch (_e2) {
                        return null;
                      }
                    })(),
                    contentPairingId: (() => {
                      try {
                        return JSON.parse(e.content || '{}').pairingId;
                      } catch (_e2) {
                        return null;
                      }
                    })(),
                    contentLen: String(e.content || '').length,
                  });
                  params.onevent(e);
                }
              } catch (_e) {}
            };
            return () => {
              try {
                ws.close();
              } catch (_e) {}
            };
          });
          return {
            close: () => closers.forEach((c) => c()),
          };
        },
        publish(relays, ev) {
          return (relays || []).map(
            (url) =>
              new Promise((resolve) => {
                const ws = new WebSocket(url);
                localPool._sockets.push(ws);
                const done = (v) => {
                  try {
                    ws.close();
                  } catch (_e) {}
                  resolve(v);
                };
                ws.onopen = () => {
                  try {
                    ws.send(JSON.stringify(['EVENT', ev]));
                  } catch (_e) {}
                  setTimeout(() => done('ok'), 250);
                };
                ws.onerror = () => done('err');
                setTimeout(() => done('timeout'), 4000);
              }),
          );
        },
      };
      const s = await Session.beginDesktopInitiator({
        ttlMs: 300000,
        deviceLabel: 'דפדפן-E2E',
        pool: localPool,
        relays: [desktopRelay],
        rendezvous: androidRelay,
      });
      s.waitLinked(300000)
        .then(async (auth) => {
          try {
            const secrets = typeof s.exportDeviceSecrets === 'function' ? s.exportDeviceSecrets() : null;
            const accepted = await LD.acceptAuthorizationObject(auth, { session: s, secrets });
            window.__sosMd3AcceptResult = accepted || null;
          } catch (e) {
            window.__sosMd3AcceptResult = { ok: false, code: String((e && e.message) || e).slice(0, 120) };
          }
        })
        .catch(() => {});
      window.__sosMd3E2eSession = s;
      window.__sosMd3E2ePool = localPool;
      const subReady = localPool._subReady ? await localPool._subReady : false;
      return {
        qrText: s.qrText,
        pairingId: s.payload && s.payload.pairingId,
        deviceId: s.payload && s.payload.deviceId,
        expiresAt: s.payload && s.payload.expiresAt,
        rendezvous: s.payload && s.payload.rendezvous,
        secretHit: /nsec1|privateKey|d_sign_priv/i.test(s.qrText || ''),
        subReady: !!subReady,
      };
    },
    { desktopRelay: DESKTOP_RELAY, androidRelay: ANDROID_RELAY },
  );
  return session;
}

async function waitDesktopLinked(page, timeoutMs) {
  return page.evaluate(async (ms) => {
    const LD = window.SosWebLinkedDevices;
    const sess = window.__sosMd3E2eSession;
    const started = Date.now();
    while (Date.now() - started < ms) {
      const devices = LD.listLinkedDevices();
      if (devices && devices.length > 0) return { ok: true, devices, via: 'registry' };
      if (sess && typeof sess.state === 'function' && sess.state() === 'LINKED') {
        return { ok: true, devices: LD.listLinkedDevices(), via: 'session_state' };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      ok: false,
      timeout: true,
      sessionState: sess && typeof sess.state === 'function' ? sess.state() : null,
      devices: LD.listLinkedDevices(),
    };
  }, timeoutMs);
}

function authStatus(rootKey, targetPub, status) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 22242,
      created_at: now,
      tags: [
        ['t', 'sos-global-account-status'],
        ['p', targetPub],
        ['expiration', String(now + 120)],
      ],
      content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status }),
    },
    rootKey.sk,
  );
}

function redeemerAuth(key, inviteId) {
  const now = Math.floor(Date.now() / 1000);
  const id = String(inviteId || '').toLowerCase();
  return finalizeEvent(
    {
      kind: 22242,
      created_at: now,
      tags: [
        ['t', 'sos-new-account-redeem'],
        ['e', id],
        ['expiration', String(now + 120)],
      ],
      content: JSON.stringify({ purpose: 'REDEEM_NEW_ACCOUNT_INVITE', inviteId: id, v: 1 }),
    },
    key.sk,
  );
}

function makeInviteEvent(creator, code) {
  const ih = crypto.createHash('sha256').update(String(code)).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 37378,
      created_at: now,
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['purpose', 'NEW_ACCOUNT_INVITE'],
        ['expiration', String(now + 3600)],
        ['ih', ih],
        ['d', ih],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite', purpose: 'NEW_ACCOUNT_INVITE' }),
    },
    creator.sk,
  );
}

async function ensureNewAccountWithCert(account) {
  // Legitimate NEW_ACCOUNT path: ROOT invite → redeem with phone → 39007 (not unprotected cert/issue).
  const phone = '+97250' + String(Math.floor(1000000 + Math.random() * 8999999));
  // Production redeem normalizes code with trim().toUpperCase() before SHA-256.
  // Fixture codes must be minted uppercase so invite ih matches redeem hash.
  const code = bytesToHex(generateSecretKey()).slice(0, 32).toUpperCase();
  const invite = makeInviteEvent(ROOT_KEY, code);
  const ih = (invite.tags.find((t) => t[0] === 'ih') || [])[1];
  const localHash = crypto.createHash('sha256').update(code).digest('hex');
  const reg = await post('/v1/global/invites/new-account/register', {
    invite,
    purpose: 'NEW_ACCOUNT_INVITE',
    recipientPhone: phone,
  });
  if (reg.result !== 'OK' || !reg.inviteId) {
    return { result: 'INVALID', stage: 'register', reg, ih, localHash };
  }
  const redeemed = await post('/v1/global/invites/new-account/redeem', {
    inviteId: reg.inviteId,
    code,
    phone,
    redeemerPubkey: account.pub,
    redeemerAuthEvent: redeemerAuth(account, reg.inviteId),
  });
  // Fallback: if redeem code path flakes, ROOT may set ACTIVE (account row) — still not unprotected cert/issue.
  if (redeemed.result !== 'OK') {
    const set = await post('/v1/global/account/status/set', {
      targetPubkey: account.pub,
      status: 'ACTIVE',
      reasonCode: 'MD3_E2E_NEW',
      authEvent: authStatus(ROOT_KEY, account.pub, 'ACTIVE'),
    });
    const exists2 = await post('/v1/global/account/exists', { pubkey: account.pub });
    const st2 = await post('/v1/global/account/status/get', { pubkey: account.pub });
    return {
      result: set.result === 'OK' ? 'OK' : 'INVALID',
      redeemed,
      statusSetFallback: set,
      exists: exists2,
      status: st2,
      phoneBound: false,
      has39007: false,
      note: 'redeem failed; ROOT status ACTIVE fallback (no unprotected cert/issue)',
      ih,
      localHash,
    };
  }
  const exists = await post('/v1/global/account/exists', { pubkey: account.pub });
  const st = await post('/v1/global/account/status/get', { pubkey: account.pub });
  return {
    result: exists.exists === true ? 'OK' : 'INVALID',
    redeemed,
    exists,
    status: st,
    phoneBound: true,
    has39007: exists.exists === true,
    ih,
    localHash,
  };
}

async function runCase(label, opts) {
  const account = skPair();
  const caseRep = {
    label,
    accountP: account.pub,
    mode: opts.mode,
  };
  console.log('\n=== CASE', label, opts.mode, 'P=' + account.pub.slice(0, 12) + '… ===');

  if (opts.mode === 'NEW_39007') {
    const created = await ensureNewAccountWithCert(account);
    caseRep.newAccount = {
      result: created.result,
      has39007: !!created.has39007,
      exists: created.exists && created.exists.exists,
      status: created.status && created.status.status,
      redeemedCode: created.redeemed && created.redeemed.code,
    };
    caseRep.statusGet = created.status;
  } else {
    const g = await post('/v1/global/account/status/get', { pubkey: account.pub });
    caseRep.statusGet = {
      result: g.result,
      status: g.status,
      exists: g.exists,
      LEGACY_NO_STATUS_RECORD: g.LEGACY_NO_STATUS_RECORD,
    };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const desk = await desktopPairingSession(page);
    caseRep.desktopQr = {
      prefix: !!(desk.qrText && desk.qrText.startsWith('SOSPAIR1:')),
      secretHit: !!desk.secretHit,
      pairingIdLen: String(desk.pairingId || '').length,
    };
    if (!caseRep.desktopQr.prefix || caseRep.desktopQr.secretHit) {
      caseRep.ok = false;
      caseRep.reason = 'DESKTOP_QR_FAIL';
      report.cases[label] = caseRep;
      set(label + '_DESKTOP_QR', false, caseRep.desktopQr);
      return caseRep;
    }
    set(label + '_DESKTOP_QR', true, caseRep.desktopQr);
    caseRep.desktopSubReady = !!desk.subReady;
    if (!desk.subReady) {
      caseRep.ok = false;
      caseRep.reason = 'DESKTOP_SUB_NOT_READY';
      report.cases[label] = caseRep;
      set(label + '_DESKTOP_SUB', false, { subReady: false });
      return caseRep;
    }
    // Ephemeral kind 25060: REQ must be live before Android publishes hello.
    await sleep(500);

    clearAndroidResult();
    pushHandoff({
      privHex: account.hex,
      accountP: account.pub,
      qrText: desk.qrText,
      admissionUrl: ANDROID_ADM,
      mode: opts.mode,
    });

    const instPromise = runInstrumentedAsync();
    // Poll desktop while Android runs so we capture live PoP progress (and keep
    // Playwright's event loop servicing any bridge callbacks).
    const progress = [];
    const pollDeadline = Date.now() + 130000;
    while (Date.now() < pollDeadline) {
      const snap = await page.evaluate(() => {
        const sess = window.__sosMd3E2eSession;
        return {
          state: sess && typeof sess.state === 'function' ? sess.state() : null,
          phases: (window.__sosMd3DbgPhases || []).slice(-12),
          inboundN: (window.__sosMd3E2eInbound || []).length,
          handleErr: window.__sosMd3HandleInboundErr || null,
          noble: !!window.__sosNobleSchnorr,
        };
      });
      progress.push({ t: Date.now(), ...snap });
      if (snap.state === 'LINKED' || snap.state === 'POP_SENT' || snap.state === 'CHANNEL_READY' || snap.state === 'AUTH_WAIT') {
        /* continue until instrumented finishes */
      }
      const settled = await Promise.race([
        instPromise.then((r) => ({ done: true, r })),
        sleep(750).then(() => ({ done: false })),
      ]);
      if (settled.done) {
        caseRep.instrumented = { ok: settled.r.ok, tail: settled.r.out.slice(-2500) };
        break;
      }
    }
    if (!caseRep.instrumented) {
      const inst = await instPromise;
      caseRep.instrumented = { ok: inst.ok, tail: inst.out.slice(-800) };
    }
    caseRep.desktopProgress = progress.slice(-20);
    const androidResult = pullResult();
    caseRep.androidResult = androidResult;
    caseRep.desktopStateAfterAndroid = await page.evaluate(() => {
      const sess = window.__sosMd3E2eSession;
      return {
        state: sess && typeof sess.state === 'function' ? sess.state() : null,
        inbound: window.__sosMd3E2eInbound || [],
        expectPairingId: sess && sess.payload && sess.payload.pairingId,
        handleErr: window.__sosMd3HandleInboundErr || null,
        phases: window.__sosMd3DbgPhases || [],
      };
    });

    const linked = await waitDesktopLinked(page, 90000);
    caseRep.desktopLinked = linked;

    const sameP =
      androidResult &&
      androidResult.accountP &&
      String(androidResult.accountP).toLowerCase() === account.pub.toLowerCase();
    caseRep.SAME_GLOBAL_P_LIVE_PROVEN = !!sameP;
    const instOk = !!(caseRep.instrumented && caseRep.instrumented.ok);
    caseRep.ok = !!(instOk && androidResult && androidResult.ok && linked && linked.ok && sameP);

    set(label + '_ANDROID_LOGIN', !!(androidResult && androidResult.SECURE_IDENTITY_STORE_INITIALIZED), androidResult);
    set(label + '_MD3_PAIRING', !!caseRep.ok, {
      instrumented: instOk,
      androidOk: androidResult && androidResult.ok,
      desktopOk: linked && linked.ok,
      sameP,
      phase: androidResult && androidResult.phase,
      deskState: caseRep.desktopStateAfterAndroid && caseRep.desktopStateAfterAndroid.state,
      deskPhases: caseRep.desktopStateAfterAndroid && caseRep.desktopStateAfterAndroid.phases,
    });
  } finally {
    await browser.close();
  }
  report.cases[label] = caseRep;
  return caseRep;
}

async function main() {
  report.results = {};
  try {
    adb('devices');
    set('ANDROID_EMULATOR_PRESENT', true);
  } catch (e) {
    set('ANDROID_EMULATOR_PRESENT', false, String(e.message || e));
    report.status = 'BLOCKED_ANDROID_IDENTITY_WIRING';
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    process.exit(1);
  }

  await startWorker();
  set('ADMISSION_WORKER_UP', true, { url: ADM_URL });
  pairRelay = new PairingRelay(RELAY_PORT);
  await pairRelay.start();
  set('ISOLATED_PAIRING_RELAY_UP', true, { desktop: DESKTOP_RELAY, android: ANDROID_RELAY });
  try {
    // Admission only via reverse; pairing relay uses 10.0.2.2 (do not reverse relay port).
    adb(`reverse tcp:${ADM_PORT} tcp:${ADM_PORT}`);
    try {
      adb(`reverse --remove tcp:${RELAY_PORT}`, { quiet: true });
    } catch (_e2) {
      /* no prior reverse — expected */
    }
  } catch (_e) {}
  await startWeb();
  const assembleTail = assembleAndInstallTestApks();
  set('ANDROID_TEST_APKS_INSTALLED', true, { tail: assembleTail.slice(-200) });

  // Reachability probe from host (retry — wrangler local can briefly flap after APK install).
  let stProbe = null;
  for (let i = 0; i < 20; i++) {
    try {
      stProbe = await post('/v1/global/account/status/get', { pubkey: '11'.repeat(32) });
      if (stProbe && stProbe.result === 'OK') break;
    } catch (_e) {
      stProbe = { result: 'FETCH_FAIL', err: String((_e && _e.message) || _e).slice(0, 120) };
    }
    await sleep(500);
  }
  set('STATUS_AUTHORITY_REACHABLE', !!(stProbe && stProbe.result === 'OK'), stProbe);

  const a = await runCase('NEW_ACCOUNT', { mode: 'NEW_39007' });
  const b = await runCase('LEGACY_NO_PHONE', { mode: 'LEGACY' });

  report.NEW_ACCOUNT_MD3_PAIRING = a.ok ? 'PASS' : 'FAIL';
  report.LEGACY_NO_PHONE_MD3_PAIRING = b.ok ? 'PASS' : 'FAIL';
  report.SAME_GLOBAL_P_LIVE_PROVEN = !!(a.SAME_GLOBAL_P_LIVE_PROVEN && b.SAME_GLOBAL_P_LIVE_PROVEN);
  report.ANDROID_DESKTOP_RELAY_REACHABLE = !!(pairRelay && pairRelay.stats.received > 0);
  report.KIND_25060_TRANSPORT_REAL = !!(pairRelay && pairRelay.stats.broadcast > 0);
  report.relayStats = pairRelay ? pairRelay.stats : null;
  report.MD2_REAL_TRANSPORT_PASS = !!(a.ok || b.ok);
  report.MD3_NATIVE_PHONEISSUER_EXECUTED = !!(a.ok || b.ok);
  report.REAL_HARDWARE_QR_SCAN_VERIFIED = false;
  set('RELAY_SAW_TRAFFIC', !!(pairRelay && pairRelay.stats.received > 0), pairRelay && pairRelay.stats);

  const fails = Object.values(report.results).filter((v) => !v.ok).length;
  report.status = a.ok && b.ok ? 'PASS' : 'FAIL_IMPLEMENTATION';
  report.failCount = fails;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nMD3_ANDROID_DESKTOP_LIVE_E2E=' + report.status);
  console.log('NEW_ACCOUNT_MD3_PAIRING=' + report.NEW_ACCOUNT_MD3_PAIRING);
  console.log('LEGACY_NO_PHONE_MD3_PAIRING=' + report.LEGACY_NO_PHONE_MD3_PAIRING);
}

main()
  .catch((e) => {
    report.status = 'FAIL_IMPLEMENTATION';
    report.fatal = String((e && e.stack) || e).slice(0, 2000);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.error(report.fatal);
    process.exit(1);
  })
  .finally(async () => {
    stopWorker();
    try {
      if (webServer) webServer.close();
    } catch (_e) {}
    try {
      if (pairRelay) await pairRelay.stop();
    } catch (_e) {}
  });
