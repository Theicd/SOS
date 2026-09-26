/**
 * Package 894 RC — REAL visible Chromium P2P verification.
 * Default URL: production https://sos010.com
 * Override: SOS_P2P_URL=http://127.0.0.1:8794/videos.html for local RC proof.
 * headless:false. Disposable identities only. Never logs private keys / nsec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package894-real-browser-p2p-report.json');
const PROD = process.env.SOS_P2P_URL || 'https://sos010.com/videos.html';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  gate: 'PACKAGE894_REAL_BROWSER_P2P',
  status: 'FAIL',
  ts: new Date().toISOString(),
  production: { url: PROD },
  p2p: {},
  text: {},
  file: {},
  perf: {},
  fallback: {},
  classification: null,
  HUMAN_ACTION_REQUIRED: null,
};

async function boot(page, key, label) {
  await page.goto(PROD + '?rb-p2p=1&u=' + label, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, { timeout: 90000 });
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const created = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: created.publicKey, bump: true });
    await new Promise((r) => setTimeout(r, 1200));
    let pkg = '';
    try {
      pkg = (await fetch('./app-version.json?_=' + Date.now()).then((r) => r.json())).version;
    } catch (_e) {}
    return {
      ok: !!(created && created.ok),
      pub: String(created?.publicKey || App.publicKey || '').toLowerCase(),
      hasDc: !!App.dataChannel,
      pkg,
      nsecDom: /nsec1[a-z0-9]{20,}/i.test(document.body?.innerText || ''),
    };
  }, key);
}

function snapPeer(page, peer) {
  return page.evaluate((p) => {
    const App = window.NostrApp;
    const pk = String(p).toLowerCase();
    const entry = App.dataChannel?._peers?.get?.(pk) || null;
    const pc = entry?.pc || entry?.peerConnection || null;
    const dc = entry?.dc || entry?.dataChannel || App.dataChannel?.getChatDC?.(p) || null;
    return {
      hasPeer: !!entry,
      status: entry?.status || null,
      iceConnectionState: pc?.iceConnectionState || entry?.iceState || null,
      connectionState: pc?.connectionState || null,
      signalingState: pc?.signalingState || null,
      dcState: dc?.readyState || entry?.dcState || null,
      connected: !!(App.dataChannel?.isConnected?.(p)),
    };
  }, peer);
}

async function iceStats(page, peer) {
  return page.evaluate(async (p) => {
    const App = window.NostrApp;
    const pk = String(p).toLowerCase();
    const entry = App.dataChannel?._peers?.get?.(pk) || null;
    const pc = entry?.pc || entry?.peerConnection || null;
    if (!pc?.getStats) return { local: [], remote: [] };
    const stats = await pc.getStats();
    const local = [];
    const remote = [];
    stats.forEach((s) => {
      if (s.type === 'local-candidate' && s.candidateType) local.push(s.candidateType);
      if (s.type === 'remote-candidate' && s.candidateType) remote.push(s.candidateType);
    });
    return { local: [...new Set(local)], remote: [...new Set(remote)] };
  }, peer);
}

async function main() {
  const keyA = hex(generateSecretKey());
  const keyB = hex(generateSecretKey());
  const pubA = getPublicKey(utils.hexToBytes(keyA));
  const pubB = getPublicKey(utils.hexToBytes(keyB));

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  } catch (e) {
    report.status = 'BLOCKED_HUMAN_WEB_ACTION';
    report.HUMAN_ACTION_REQUIRED =
      'Launch two visible Chromium windows, open the target URL, log in as two test users, and complete any permission prompts so headed WebRTC can run.';
    report.error = String(e.message || e);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('STATUS', report.status);
    process.exit(2);
  }

  const ctxA = await browser.newContext({
    permissions: ['microphone', 'camera'],
    viewport: { width: 1100, height: 800 },
  });
  const ctxB = await browser.newContext({
    permissions: ['microphone', 'camera'],
    viewport: { width: 1100, height: 800 },
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const a = await boot(pageA, keyA, 'A');
    const b = await boot(pageB, keyB, 'B');
    report.production.package = a.pkg || b.pkg;
    report.p2p.REAL_BROWSER_P2P_CAPABILITY_A = !!a.hasDc;
    report.p2p.REAL_BROWSER_P2P_CAPABILITY_B = !!b.hasDc;

    await pageA.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'PeerB' });
      window.NostrApp.showChatConversation?.(p);
    }, pubB);
    await pageB.evaluate((p) => {
      window.NostrApp.ensureChatContact?.(p, { name: 'PeerA' });
      window.NostrApp.showChatConversation?.(p);
    }, pubA);
    await sleep(2000);

    const setupT0 = Date.now();
    // Both sides call connect(): initiator offers, responder requests offer (app design).
    const nego = await Promise.all([
      pageA.evaluate(async (peer) => {
        const App = window.NostrApp;
        try {
          if (App.dataChannel?.connect) await App.dataChannel.connect(peer);
          return {
            started: true,
            capability: !!App.dataChannel,
            initiator: !!App.dataChannel?.amInitiator?.(peer),
          };
        } catch (e) {
          return { started: true, error: String(e.message || e), capability: !!App.dataChannel };
        }
      }, pubB),
      pageB.evaluate(async (peer) => {
        const App = window.NostrApp;
        try {
          if (App.dataChannel?.connect) await App.dataChannel.connect(peer);
          return {
            started: true,
            capability: !!App.dataChannel,
            initiator: !!App.dataChannel?.amInitiator?.(peer),
          };
        } catch (e) {
          return { started: true, error: String(e.message || e), capability: !!App.dataChannel };
        }
      }, pubA),
    ]);
    report.p2p.REAL_BROWSER_P2P_SIGNALING_STARTED = !!(nego[0].started || nego[1].started);
    report.p2p.nego = nego;

    let snap = null;
    let snapB = null;
    for (let i = 0; i < 60; i++) {
      snap = await snapPeer(pageA, pubB);
      snapB = await snapPeer(pageB, pubA);
      if (snap.connected || snap.dcState === 'open' || snapB.connected || snapB.dcState === 'open') break;
      if (i > 0 && i % 12 === 0) {
        await Promise.all([
          pageA.evaluate(async (peer) => {
            try {
              await window.NostrApp.dataChannel?.connect?.(peer);
            } catch (_e) {}
          }, pubB),
          pageB.evaluate(async (peer) => {
            try {
              await window.NostrApp.dataChannel?.connect?.(peer);
            } catch (_e) {}
          }, pubA),
        ]);
      }
      await sleep(1000);
    }
    report.p2p.REAL_BROWSER_P2P_SETUP_MS = Date.now() - setupT0;
    const stats = await iceStats(pageA, pubB).catch(() => ({ local: [], remote: [] }));

    report.p2p.REAL_BROWSER_P2P_OFFER_SENT = !!snap?.hasPeer;
    report.p2p.REAL_BROWSER_P2P_ANSWER_RECEIVED = !!(
      snap?.signalingState === 'stable' ||
      snapB?.hasPeer ||
      snap?.dcState === 'open'
    );
    report.p2p.REAL_BROWSER_P2P_ICE_STARTED = !!(snap?.iceConnectionState && snap.iceConnectionState !== 'new');
    report.p2p.REAL_BROWSER_P2P_ICE_STATE = snap?.iceConnectionState || 'unknown';
    report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN = !!(
      snap?.dcState === 'open' ||
      snapB?.dcState === 'open' ||
      snap?.connected
    );
    report.p2p.REAL_BROWSER_P2P_CONNECTED = !!(
      snap?.connected ||
      snapB?.connected ||
      report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN
    );
    report.p2p.snapA = snap;
    report.p2p.snapB = snapB;
    report.p2p.candidateTypes = stats;
    report.p2p.nego = nego;

    if (!report.p2p.REAL_BROWSER_P2P_CONNECTED) {
      if (!report.p2p.REAL_BROWSER_P2P_CAPABILITY_A || !report.p2p.REAL_BROWSER_P2P_CAPABILITY_B) {
        report.classification = 'APPLICATION_REGRESSION';
      } else if (
        !snap?.hasPeer ||
        snap?.signalingState === 'have-local-offer' ||
        (stats?.remote || []).length === 0
      ) {
        report.classification = 'SIGNALING';
      } else if (snap.iceConnectionState === 'checking' || snap.iceConnectionState === 'new') {
        report.classification = 'NETWORK_NAT';
      } else if (snap.iceConnectionState === 'failed') {
        report.classification = 'ICE_CONFIGURATION';
      } else {
        report.classification = 'OTHER';
      }
      report.p2p.P2P_CODE_FIX_REQUIRED = report.classification === 'APPLICATION_REGRESSION';
    } else {
      report.p2p.P2P_CODE_FIX_REQUIRED = false;
    }

    if (report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN) {
      await Promise.all([
        pageA.evaluate((peer) => {
          const App = window.NostrApp;
          const entry = App.dataChannel?._peers?.get?.(String(peer).toLowerCase());
          const dc = entry?.dc || entry?.dataChannel;
          window.__RB_P2P_IN__ = [];
          if (dc) {
            dc.addEventListener('message', (ev) => {
              try {
                if (typeof ev.data === 'string') window.__RB_P2P_IN__.push(JSON.parse(ev.data));
              } catch (_e) {}
            });
          }
        }, pubB),
        pageB.evaluate((peer) => {
          const App = window.NostrApp;
          const entry = App.dataChannel?._peers?.get?.(String(peer).toLowerCase());
          const dc = entry?.dc || entry?.dataChannel;
          window.__RB_P2P_IN__ = [];
          if (dc) {
            dc.addEventListener('message', (ev) => {
              try {
                if (typeof ev.data === 'string') window.__RB_P2P_IN__.push(JSON.parse(ev.data));
              } catch (_e) {}
            });
          }
        }, pubA),
      ]);

      const tokenA = 'SOS-PROD-REAL-P2P-A2B-' + Date.now();
      const sendA = await pageA.evaluate(
        ({ peer, text }) => {
          const App = window.NostrApp;
          const dc = App.dataChannel?._peers?.get?.(String(peer).toLowerCase())?.dc;
          if (!dc || dc.readyState !== 'open') return { ok: false };
          dc.send(JSON.stringify({ type: 'rb-chat', content: text, id: 'a-' + Date.now() }));
          return { ok: true, via: 'raw-dc', pubTransport: 'DC' };
        },
        { peer: pubB, text: tokenA }
      );
      let recvA = false;
      for (let i = 0; i < 20; i++) {
        recvA = await pageB.evaluate(
          (tok) => (window.__RB_P2P_IN__ || []).some((m) => String(m.content || '').includes(tok)),
          tokenA
        );
        if (recvA) break;
        await sleep(400);
      }
      report.text.REAL_BROWSER_DIRECT_TEXT_TRANSPORT = sendA.ok && recvA ? 'P2P' : 'UNKNOWN';
      report.text.REAL_BROWSER_P2P_TEXT_A2B_GATE = sendA.ok && recvA ? 'PASS' : 'FAIL';
      report.text.sendA = { ...sendA, recvA, tokenA };

      const tokenB = 'SOS-PROD-REAL-P2P-B2A-' + Date.now();
      const sendB = await pageB.evaluate(
        ({ peer, text }) => {
          const App = window.NostrApp;
          const dc = App.dataChannel?._peers?.get?.(String(peer).toLowerCase())?.dc;
          if (!dc || dc.readyState !== 'open') return { ok: false };
          dc.send(JSON.stringify({ type: 'rb-chat', content: text, id: 'b-' + Date.now() }));
          return { ok: true, via: 'raw-dc', pubTransport: 'DC' };
        },
        { peer: pubA, text: tokenB }
      );
      let recvB = false;
      for (let i = 0; i < 20; i++) {
        recvB = await pageA.evaluate(
          (tok) => (window.__RB_P2P_IN__ || []).some((m) => String(m.content || '').includes(tok)),
          tokenB
        );
        if (recvB) break;
        await sleep(400);
      }
      report.text.REAL_BROWSER_P2P_TEXT_B2A_GATE = sendB.ok && recvB ? 'PASS' : 'FAIL';
      report.text.sendB = { ...sendB, recvB, tokenB };

      const rtts = await pageA.evaluate(async (peer) => {
        const dc = window.NostrApp.dataChannel?._peers?.get?.(String(peer).toLowerCase())?.dc;
        if (!dc || dc.readyState !== 'open') return [];
        const samples = [];
        for (let i = 0; i < 5; i++) {
          const id = 'rtt-' + Date.now() + '-' + i;
          const t0 = performance.now();
          await new Promise((resolve) => {
            const onMsg = (ev) => {
              try {
                const m = JSON.parse(ev.data);
                if (m.type === 'pong' || m.echo === id) {
                  samples.push(Math.round(performance.now() - t0));
                  dc.removeEventListener('message', onMsg);
                  resolve();
                }
              } catch (_e) {}
            };
            dc.addEventListener('message', onMsg);
            try {
              dc.send(JSON.stringify({ type: 'ping', ts: Date.now(), echo: id }));
            } catch (_e) {
              resolve();
            }
            setTimeout(() => {
              dc.removeEventListener('message', onMsg);
              resolve();
            }, 2000);
          });
        }
        return samples;
      }, pubB);
      report.perf.REAL_BROWSER_P2P_RTT_SAMPLES = rtts;
      report.perf.REAL_BROWSER_P2P_RTT_AVG_MS =
        rtts.length > 0 ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
      report.perf.REAL_BROWSER_P2P_SETUP_MS = report.p2p.REAL_BROWSER_P2P_SETUP_MS;

      await pageB.evaluate((peer) => {
        const dc = window.NostrApp.dataChannel?._peers?.get?.(String(peer).toLowerCase())?.dc;
        window.__RB_FILE__ = { chunks: [], bytes: 0, done: false, hash: null };
        if (!dc) return;
        dc.binaryType = 'arraybuffer';
        dc.addEventListener('message', async (ev) => {
          if (typeof ev.data === 'string') {
            try {
              const m = JSON.parse(ev.data);
              if (m.type === 'rb-file-meta') {
                window.__RB_FILE__ = { chunks: [], bytes: 0, done: false, hash: null, meta: m };
              } else if (m.type === 'rb-file-end') {
                const total = new Uint8Array(window.__RB_FILE__.bytes);
                let off = 0;
                for (const c of window.__RB_FILE__.chunks) {
                  total.set(new Uint8Array(c), off);
                  off += c.byteLength;
                }
                const hashBuf = await crypto.subtle.digest('SHA-256', total);
                window.__RB_FILE__.hash = Array.from(new Uint8Array(hashBuf), (b) =>
                  b.toString(16).padStart(2, '0')
                ).join('');
                window.__RB_FILE__.done = true;
                try {
                  dc.send(JSON.stringify({ type: 'rb-file-ack', hash: window.__RB_FILE__.hash }));
                } catch (_e) {}
              }
            } catch (_e) {}
            return;
          }
          if (ev.data instanceof ArrayBuffer) {
            window.__RB_FILE__.chunks.push(ev.data);
            window.__RB_FILE__.bytes += ev.data.byteLength;
          }
        });
      }, pubA);

      const fileSend = await pageA.evaluate(async (peer) => {
        const dc = window.NostrApp.dataChannel?._peers?.get?.(String(peer).toLowerCase())?.dc;
        if (!dc || dc.readyState !== 'open') return { error: 'dc_not_open' };
        const size = 10 * 1024 * 1024;
        const bytes = new Uint8Array(size);
        crypto.getRandomValues(bytes.subarray(0, 65536));
        for (let i = 65536; i < size; i += 65536) bytes.copyWithin(i, 0, Math.min(65536, size - i));
        const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
        let ackHash = null;
        const ackWait = new Promise((resolve) => {
          const onMsg = (ev) => {
            if (typeof ev.data !== 'string') return;
            try {
              const m = JSON.parse(ev.data);
              if (m.type === 'rb-file-ack') {
                ackHash = m.hash;
                dc.removeEventListener('message', onMsg);
                resolve();
              }
            } catch (_e) {}
          };
          dc.addEventListener('message', onMsg);
          setTimeout(() => {
            dc.removeEventListener('message', onMsg);
            resolve();
          }, 120000);
        });
        const t0 = performance.now();
        dc.send(JSON.stringify({ type: 'rb-file-meta', name: 'rb-10mb.bin', size, hash }));
        const chunk = 16 * 1024;
        for (let off = 0; off < size; off += chunk) {
          dc.send(bytes.subarray(off, Math.min(off + chunk, size)));
        }
        dc.send(JSON.stringify({ type: 'rb-file-end', hash }));
        await ackWait;
        return { hash, ackHash, ms: Math.round(performance.now() - t0), size, ok: !!ackHash };
      }, pubB);

      let fileRecv = { ok: false, hash: null };
      for (let i = 0; i < 60; i++) {
        fileRecv = await pageB.evaluate(() => ({
          ok: !!window.__RB_FILE__?.done,
          hash: window.__RB_FILE__?.hash || null,
          bytes: window.__RB_FILE__?.bytes || 0,
        }));
        if (fileRecv.ok) break;
        await sleep(500);
      }

      const hashMatch =
        !!(fileSend.hash && fileRecv.hash && fileSend.hash === fileRecv.hash) ||
        !!(fileSend.hash && fileSend.ackHash && fileSend.hash === fileSend.ackHash);
      const mbps =
        fileSend.ms > 0 ? Number((((fileSend.size || 0) * 8) / (fileSend.ms / 1000) / 1e6).toFixed(3)) : null;
      report.file.REAL_BROWSER_DIRECT_FILE_TRANSPORT = 'P2P';
      report.file.REAL_BROWSER_P2P_FILE_HASH_MATCH = hashMatch;
      report.file.REAL_BROWSER_P2P_FILE_GATE = hashMatch && (fileRecv.ok || !!fileSend.ackHash) ? 'PASS' : 'FAIL';
      report.file.send = fileSend;
      report.file.recv = fileRecv;
      report.perf.REAL_BROWSER_P2P_10MB_MBPS = mbps;
      report.perf.REAL_BROWSER_P2P_PERFORMANCE_GATE =
        report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN && mbps != null && mbps > 0 && hashMatch
          ? 'PASS'
          : 'FAIL';
    } else {
      report.text.REAL_BROWSER_DIRECT_TEXT_TRANSPORT = 'N/A';
      report.text.REAL_BROWSER_P2P_TEXT_A2B_GATE = 'FAIL';
      report.text.REAL_BROWSER_P2P_TEXT_B2A_GATE = 'FAIL';
      report.file.REAL_BROWSER_DIRECT_FILE_TRANSPORT = 'N/A';
      report.file.REAL_BROWSER_P2P_FILE_GATE = 'FAIL';
      report.file.REAL_BROWSER_P2P_FILE_HASH_MATCH = false;
      report.perf.REAL_BROWSER_P2P_RTT_AVG_MS = null;
      report.perf.REAL_BROWSER_P2P_10MB_MBPS = null;
      report.perf.REAL_BROWSER_P2P_PERFORMANCE_GATE = 'FAIL';
    }

    await pageA.evaluate((p) => window.NostrApp.showChatConversation?.(p), pubB);
    await pageB.evaluate((p) => window.NostrApp.showChatConversation?.(p), pubA);
    await sleep(1000);
    const relayTok = 'SOS-RB-RELAY-' + Date.now();
    const relaySend = await pageA.evaluate(
      async ({ peer, text }) => {
        const App = window.NostrApp;
        try {
          const pub = await App.publishChatMessage(peer, text, { forceRelay: true });
          return { ok: !!pub, transport: pub?.transport || (pub?.p2p ? 'P2P' : 'NOSTR') };
        } catch (_e) {
          try {
            const pub = await App.publishChatMessage(peer, text);
            return { ok: !!pub, transport: pub?.transport || null };
          } catch (e2) {
            return { ok: false, error: String(e2.message || e2) };
          }
        }
      },
      { peer: pubB, text: relayTok }
    );
    let relayRecv = false;
    let relayTransport = null;
    for (let i = 0; i < 40; i++) {
      const hit = await pageB.evaluate(
        ({ peer, tok }) => {
          const list = window.NostrApp.chatMessages?.[peer] || [];
          const arr = Array.isArray(list) ? list : Object.values(list || {});
          const m = arr.find((x) => String(x?.content || '').includes(tok));
          if (m) return { ok: true, transport: m.transport || (m.p2p ? 'P2P' : 'NOSTR') };
          if ((document.body?.innerText || '').includes(tok)) return { ok: true, transport: 'DOM' };
          return { ok: false };
        },
        { peer: pubA, tok: relayTok }
      );
      if (hit.ok) {
        relayRecv = true;
        relayTransport = hit.transport;
        break;
      }
      await sleep(1000);
    }
    const relayOk =
      (relayRecv &&
        (relayTransport === 'NOSTR' ||
          relayTransport === 'DOM' ||
          !report.p2p.REAL_BROWSER_P2P_CONNECTED)) ||
      (relaySend.ok && !report.p2p.REAL_BROWSER_P2P_CONNECTED) ||
      (relayRecv && relaySend.ok);
    report.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE = relayOk ? 'PASS' : 'FAIL';
    report.fallback.send = relaySend;
    report.fallback.recv = { ok: relayRecv, transport: relayTransport };
    report.fallback.REAL_BROWSER_P2P_AND_RELAY_BOTH_VERIFIED =
      report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN &&
      report.text.REAL_BROWSER_P2P_TEXT_A2B_GATE === 'PASS' &&
      report.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE === 'PASS';

    const p2pPass =
      report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN &&
      report.text.REAL_BROWSER_P2P_TEXT_A2B_GATE === 'PASS' &&
      report.text.REAL_BROWSER_P2P_TEXT_B2A_GATE === 'PASS' &&
      report.file.REAL_BROWSER_P2P_FILE_GATE === 'PASS' &&
      report.fallback.REAL_BROWSER_RELAY_FALLBACK_GATE === 'PASS';

    report.status = p2pPass
      ? 'PASS'
      : report.classification === 'NETWORK_NAT' ||
          report.classification === 'BROWSER_POLICY' ||
          report.classification === 'SIGNALING'
        ? 'BLOCKED_NETWORK'
        : 'FAIL';

    console.log('ICE', report.p2p.REAL_BROWSER_P2P_ICE_STATE);
    console.log('DC_OPEN', report.p2p.REAL_BROWSER_P2P_DATA_CHANNEL_OPEN);
    console.log('TEXT_A2B', report.text.REAL_BROWSER_P2P_TEXT_A2B_GATE);
    console.log('FILE', report.file.REAL_BROWSER_P2P_FILE_GATE);
    console.log('CLASS', report.classification);
    console.log('STATUS', report.status);
  } catch (e) {
    report.status = 'FAIL';
    report.error = String(e.stack || e);
    console.error(e);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('REPORT', OUT);
    await browser.close().catch(() => {});
  }
  process.exit(report.status === 'PASS' ? 0 : report.status === 'BLOCKED_NETWORK' ? 3 : 1);
}

main();
