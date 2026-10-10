#!/usr/bin/env node
/**
 * Isolate desktop Hello → PoP transition (no Android).
 * Synthetic phone hello → desktop must reach POP_SENT and publish AEAD.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { WebSocket } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { chromium } from 'playwright';
import { schnorr } from '@noble/curves/secp256k1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELAY_PORT = 7805;
const WEB_PORT = 8821;
const OUT = path.join(ROOT, 'qa', 'md3-desktop-hello-pop-probe-report.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (_e) {}
}

async function main() {
  freePort(RELAY_PORT);
  freePort(WEB_PORT);
  await sleep(300);

  const relay = spawn(process.execPath, [path.join(ROOT, 'qa', 'md3-pairing-relay-child.cjs')], {
    env: { ...process.env, SOS_RELAY_PORT: String(RELAY_PORT), SOS_RELAY_HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const relayLines = [];
  relay.stdout.on('data', (d) => {
    relayLines.push(String(d));
    process.stdout.write('[relay] ' + d);
  });
  await new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('relay_timeout')), 8000);
    relay.stdout.on('data', (d) => {
      if (String(d).includes('RELAY_UP')) {
        clearTimeout(t);
        r();
      }
    });
  });

  const web = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const ext = path.extname(fp);
    const mime =
      { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[
        ext
      ] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => web.listen(WEB_PORT, '127.0.0.1', r));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (String(msg.text()).includes('MD3DBG')) console.log('[page]', msg.text());
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => !!(window.SosMd2PairingSession && window.NostrTools && window.NostrApp),
    null,
    { timeout: 90000 },
  );

  await page.exposeFunction('__sosSchnorrSignHex', (msgHex, skHex) => {
    console.log('[bridge] sign len', String(msgHex).length, String(skHex).length);
    const msg = Buffer.from(String(msgHex), 'hex');
    const sk = Buffer.from(String(skHex), 'hex');
    return Buffer.from(schnorr.sign(msg, sk)).toString('hex');
  });

  const deskRelay = `ws://127.0.0.1:${RELAY_PORT}`;
  const androidRelay = `ws://10.0.2.2:${RELAY_PORT}`;

  const sess = await page.evaluate(
    async ({ deskRelay, androidRelay }) => {
      const App = window.NostrApp;
      const Session = App.Md2PairingSession || window.SosMd2PairingSession;
      const phases = [];
      const localPool = {
        _subReady: null,
        subscribeMany(relays, filter, params) {
          const f = Array.isArray(filter) ? filter[0] : filter;
          let readyResolve;
          localPool._subReady = new Promise((r) => (readyResolve = r));
          const ws = new WebSocket(relays[0]);
          ws.onopen = () => {
            ws.send(JSON.stringify(['REQ', 'probe', f]));
            readyResolve(true);
            phases.push({ t: Date.now(), phase: 'DESK_SUB_OPEN' });
          };
          ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data || ''));
            if (Array.isArray(m) && m[0] === 'EVENT') {
              phases.push({
                t: Date.now(),
                phase: 'DESK_GOT_EVENT',
                role: (m[2].tags || []).find((x) => x[0] === 'role'),
                contentType: (() => {
                  try {
                    return JSON.parse(m[2].content).type;
                  } catch (_e) {
                    return null;
                  }
                })(),
              });
              params.onevent(m[2]);
            }
          };
          return { close: () => ws.close() };
        },
        publish(relays, ev) {
          phases.push({ t: Date.now(), phase: 'DESK_PUBLISH', kind: ev.kind, role: (ev.tags || []).find((x) => x[0] === 'role') });
          return relays.map(
            (url) =>
              new Promise((resolve) => {
                const ws = new WebSocket(url);
                ws.onopen = () => {
                  ws.send(JSON.stringify(['EVENT', ev]));
                  setTimeout(() => {
                    ws.close();
                    resolve('ok');
                  }, 200);
                };
                ws.onerror = () => resolve('err');
              }),
          );
        },
      };
      window.__sosMd3DbgPhases = phases;
      const hasBridge = typeof window.__sosSchnorrSignHex === 'function';
      phases.push({ t: Date.now(), phase: 'BRIDGE_PRESENT', hasBridge });
      const s = await Session.beginDesktopInitiator({
        ttlMs: 300000,
        deviceLabel: 'probe',
        pool: localPool,
        relays: [deskRelay],
        rendezvous: androidRelay,
      });
      window.__sosMd3E2eSession = s;
      await localPool._subReady;
      phases.push({ t: Date.now(), phase: 'SESSION_READY', state: s.state(), pairingId: s.payload.pairingId });
      return {
        qrText: s.qrText,
        pairingId: s.payload.pairingId,
        eDesktop: s.payload.E_ephemeral_pub,
        dSign: s.payload.D_sign_pub,
        hasBridge,
      };
    },
    { deskRelay, androidRelay },
  );

  // Synthetic phone hello using X25519
  const phonePriv = x25519.utils.randomPrivateKey();
  const phonePub = x25519.getPublicKey(phonePriv);
  const hello = {
    type: 'hello',
    pairingId: sess.pairingId,
    E_phone_pub: bytesToHex(phonePub),
  };
  const sk = generateSecretKey();
  const ev = finalizeEvent(
    {
      kind: 25060,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', 'sos-pair-v1'],
        ['d', sess.pairingId],
        ['role', 'phone'],
      ],
      content: JSON.stringify(hello),
    },
    sk,
  );

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(deskRelay);
    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', ev]));
      setTimeout(() => {
        ws.close();
        resolve();
      }, 300);
    });
    ws.on('error', reject);
  });
  console.log('SYNTH_HELLO_SENT', sess.pairingId.slice(0, 12));

  await sleep(3000);

  const after = await page.evaluate(() => {
    const s = window.__sosMd3E2eSession;
    return {
      state: s && s.state(),
      phases: window.__sosMd3DbgPhases || [],
      handleErr: window.__sosMd3HandleInboundErr || null,
      bridgeStill: typeof window.__sosSchnorrSignHex === 'function',
    };
  });

  const report = {
    status: after.state === 'POP_SENT' || after.state === 'CHANNEL_READY' || after.state === 'LINKED' ? 'PASS' : 'FAIL',
    FIRST_FAILED_TRANSITION:
      after.state === 'QR_SHOWN' ? 'DESKTOP_HELLO_TO_POP_SENT' : after.state === 'POP_SENT' ? null : after.state,
    deskState: after.state,
    handleErr: after.handleErr,
    bridgeStill: after.bridgeStill,
    phases: after.phases,
    relayTail: relayLines.join('').slice(-800),
    hasBridgeAtStart: sess.hasBridge,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  web.close();
  relay.kill();
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
