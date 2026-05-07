#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { getPublicKey, utils } from 'nostr-tools';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [k, v] = arg.slice(2).split('=');
    if (v !== undefined) {
      out[k] = v;
      continue;
    }
    out[k] = argv[i + 1];
    i += 1;
  }
  return out;
}

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required --${key}`);
  }
  return args[key];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAppReady(page, label) {
  await page.waitForFunction(() => {
    const app = window.NostrApp;
    return !!(app && app.publicKey && app.pool && typeof app.publishChatMessage === 'function');
  }, { timeout: 60000 });
  const appState = await page.evaluate(() => ({
    publicKey: window.NostrApp?.publicKey || '',
    relayCount: Array.isArray(window.NostrApp?.relayUrls) ? window.NostrApp.relayUrls.length : 0,
  }));
  console.log(`[${label}] app ready`, { pub: appState.publicKey.slice(0, 12), relayCount: appState.relayCount });
  return appState.publicKey;
}

async function openChat(page, label) {
  await page.waitForLoadState('domcontentloaded');
  const selectors = ['#messagesToggle', '#chatLauncherButton', '#chatToggle', '#chatNavChats'];
  for (const sel of selectors) {
    const handle = await page.$(sel);
    if (handle) {
      await handle.click({ force: true }).catch(() => {});
      console.log(`[${label}] opened chat using ${sel}`);
      break;
    }
  }
  await page.waitForTimeout(1200);
}

async function ensureDataChannel(page, peerPub, label) {
  const ok = await page.evaluate(async (peer) => {
    const app = window.NostrApp;
    if (!app?.dataChannel) return false;
    app.dataChannel.init?.();
    app.dataChannel.connect?.(peer);
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (app.dataChannel.isConnected?.(peer)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }, peerPub);
  console.log(`[${label}] datachannel connected=${ok}`);
  return ok;
}

async function prepareCallHooks(page) {
  await page.evaluate(() => {
    window.__qaVoiceIncoming = null;
    window.__qaVideoIncoming = null;
    const app = window.NostrApp;
    if (!app) return;
    const oldVoiceIncoming = app.onVoiceCallIncoming;
    app.onVoiceCallIncoming = (peer, offer) => {
      window.__qaVoiceIncoming = { peer, offer };
      if (typeof oldVoiceIncoming === 'function') oldVoiceIncoming(peer, offer);
    };
    const oldVideoIncoming = app.onVideoCallIncoming;
    app.onVideoCallIncoming = (peer, offer) => {
      window.__qaVideoIncoming = { peer, offer };
      if (typeof oldVideoIncoming === 'function') oldVideoIncoming(peer, offer);
    };
  });
}

async function sendText(page, peerPub, text) {
  return page.evaluate(async ({ peer, content }) => {
    const app = window.NostrApp;
    return app.publishChatMessage(peer, content);
  }, { peer: peerPub, content: text });
}

async function waitForIncomingText(page, fromPeer, token, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate(({ peer, marker }) => {
      const app = window.NostrApp;
      const msgs = app?.getChatMessages?.(peer) || [];
      const found = msgs.find((m) => m.direction === 'incoming' && typeof m.content === 'string' && m.content.includes(marker));
      if (!found) return null;
      return { id: found.id, createdAt: found.createdAt || 0, p2p: !!found.p2p };
    }, { peer: fromPeer, marker: token });
    if (hit) return { ok: true, ...hit };
    await sleep(400);
  }
  return { ok: false };
}

async function sendSmallAttachment(page, peerPub, token) {
  return page.evaluate(async ({ peer, marker }) => {
    const app = window.NostrApp;
    const payload = btoa(`qa-file-${marker}`);
    const attachment = {
      id: `qa-att-${Date.now()}`,
      name: `qa-${marker}.txt`,
      size: payload.length,
      type: 'text/plain',
      dataUrl: `data:text/plain;base64,${payload}`,
      url: '',
      isTorrent: false,
    };
    app.setChatFileAttachment?.(peer, attachment);
    return app.publishChatMessage(peer, `qa-file:${marker}`);
  }, { peer: peerPub, marker: token });
}

async function sendLargeAttachmentViaUi(page, peerPub, token, sizeMb = 5) {
  return page.evaluate(async ({ peer, marker, mb }) => {
    const app = window.NostrApp;
    if (typeof app.handleChatFileSelection !== 'function') {
      return { ok: false, error: 'handleChatFileSelection-missing' };
    }
    const bytes = mb * 1024 * 1024;
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 1) arr[i] = i % 251;
    const blob = new Blob([arr], { type: 'image/jpeg' });
    const file = new File([blob], `qa-${marker}-${mb}mb.jpg`, { type: 'image/jpeg' });
    await app.handleChatFileSelection(peer, file);
    return { ok: true, marker, fileName: file.name, fileSize: file.size };
  }, { peer: peerPub, marker: token, mb: sizeMb });
}

async function waitForIncomingAttachment(page, fromPeer, token, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate(({ peer, marker }) => {
      const app = window.NostrApp;
      const msgs = app?.getChatMessages?.(peer) || [];
      const found = msgs.find((m) => m.direction === 'incoming' && typeof m.content === 'string' && m.content.includes(marker));
      if (!found) return null;
      return {
        id: found.id,
        hasAttachment: !!found.attachment,
        attachmentName: found.attachment?.name || '',
        p2p: !!found.p2p,
      };
    }, { peer: fromPeer, marker: `qa-file:${token}` });
    if (hit) return { ok: true, ...hit };
    await sleep(400);
  }
  return { ok: false };
}

async function waitForIncomingLarge(page, fromPeer, token, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate(({ peer, marker }) => {
      const app = window.NostrApp;
      const msgs = app?.getChatMessages?.(peer) || [];
      const found = msgs.find((m) => m.direction === 'incoming' && (m.attachment?.name || '').includes(marker));
      if (!found) return null;
      return {
        id: found.id,
        hasAttachment: !!found.attachment,
        p2p: !!found.p2p,
        isTorrent: !!found.attachment?.isTorrent,
        hasMagnet: !!found.attachment?.magnetURI,
        attachmentSize: found.attachment?.size || 0,
        attachmentName: found.attachment?.name || '',
      };
    }, { peer: fromPeer, marker: token });
    if (hit) return { ok: true, ...hit };
    await sleep(500);
  }
  return { ok: false };
}

async function runVoiceCall(localA, localB, pubA, pubB) {
  const out = { attempted: false, connected: false, error: '' };
  const supported = await Promise.all([
    localA.evaluate(() => !!window.NostrApp?.voiceCall?.isSupported?.()),
    localB.evaluate(() => !!window.NostrApp?.voiceCall?.isSupported?.()),
  ]);
  if (!supported[0] || !supported[1]) return out;
  out.attempted = true;
  try {
    await localA.evaluate(async (peer) => window.NostrApp.voiceCall.start(peer), pubB);
    const incoming = await localB.waitForFunction(() => !!window.__qaVoiceIncoming, { timeout: 20000 });
    const incomingData = await incoming.jsonValue();
    await localB.evaluate(async ({ peer, offer }) => window.NostrApp.voiceCall.accept(peer, offer), incomingData);
    const okA = await localA.waitForFunction(() => window.NostrApp?.voiceCall?.getState?.()?.isCallActive === true, { timeout: 30000 }).then(() => true).catch(() => false);
    const okB = await localB.waitForFunction(() => window.NostrApp?.voiceCall?.getState?.()?.isCallActive === true, { timeout: 30000 }).then(() => true).catch(() => false);
    out.connected = okA && okB;
    await localA.evaluate(() => window.NostrApp?.voiceCall?.end?.());
    await localB.evaluate(() => window.NostrApp?.voiceCall?.end?.());
  } catch (err) {
    out.error = err.message || String(err);
    await localA.evaluate(() => window.NostrApp?.voiceCall?.end?.()).catch(() => {});
    await localB.evaluate(() => window.NostrApp?.voiceCall?.end?.()).catch(() => {});
  }
  return out;
}

async function runVideoCall(localA, localB, pubA, pubB) {
  const out = { attempted: false, connected: false, error: '' };
  const supported = await Promise.all([
    localA.evaluate(() => !!window.NostrApp?.videoCall?.isSupported?.()),
    localB.evaluate(() => !!window.NostrApp?.videoCall?.isSupported?.()),
  ]);
  if (!supported[0] || !supported[1]) return out;
  out.attempted = true;
  try {
    await localA.evaluate(async (peer) => window.NostrApp.videoCall.start(peer), pubB);
    const incoming = await localB.waitForFunction(() => !!window.__qaVideoIncoming, { timeout: 20000 });
    const incomingData = await incoming.jsonValue();
    await localB.evaluate(async ({ peer, offer }) => window.NostrApp.videoCall.accept(peer, offer), incomingData);
    const okA = await localA.waitForFunction(() => window.NostrApp?.videoCall?.getState?.()?.isActive === true, { timeout: 30000 }).then(() => true).catch(() => false);
    const okB = await localB.waitForFunction(() => window.NostrApp?.videoCall?.getState?.()?.isActive === true, { timeout: 30000 }).then(() => true).catch(() => false);
    out.connected = okA && okB;
    await localA.evaluate(() => window.NostrApp?.videoCall?.end?.());
    await localB.evaluate(() => window.NostrApp?.videoCall?.end?.());
  } catch (err) {
    out.error = err.message || String(err);
    await localA.evaluate(() => window.NostrApp?.videoCall?.end?.()).catch(() => {});
    await localB.evaluate(() => window.NostrApp?.videoCall?.end?.()).catch(() => {});
  }
  return out;
}

async function runScenario(pageA, pageB, pubA, pubB, scenarioName) {
  const report = {
    scenario: scenarioName,
    text: {},
    attachmentSmall: {},
    attachmentLarge: {},
    dataChannel: {},
    timingsMs: {},
    p2pStats: { textP2P: false, smallAttachmentP2P: false, largeAttachmentP2P: false },
  };

  const [dcAB, dcBA] = await Promise.all([
    ensureDataChannel(pageA, pubB, `${scenarioName} A->B`),
    ensureDataChannel(pageB, pubA, `${scenarioName} B->A`),
  ]);
  report.dataChannel = { aToB: dcAB, bToA: dcBA };

  const textToken = `qa-text-${scenarioName}-${Date.now()}`;
  const t0 = performance.now();
  report.text.sendResult = await sendText(pageA, pubB, `HELLO ${textToken}`);
  report.text.receiveResult = await waitForIncomingText(pageB, pubA, textToken);
  report.timingsMs.textAToB = Math.round(performance.now() - t0);
  report.p2pStats.textP2P = !!report.text.receiveResult?.p2p;

  const smallToken = `qa-small-${scenarioName}-${Date.now()}`;
  const t1 = performance.now();
  report.attachmentSmall.sendResult = await sendSmallAttachment(pageB, pubA, smallToken);
  report.attachmentSmall.receiveResult = await waitForIncomingAttachment(pageA, pubB, smallToken);
  report.timingsMs.attachmentSmallBToA = Math.round(performance.now() - t1);
  report.p2pStats.smallAttachmentP2P = !!report.attachmentSmall.receiveResult?.p2p;

  const largeToken = `qa-large-${scenarioName}-${Date.now()}`;
  const t2 = performance.now();
  report.attachmentLarge.sendResult = await sendLargeAttachmentViaUi(pageA, pubB, largeToken, 5);
  report.attachmentLarge.receiveResult = await waitForIncomingLarge(pageB, pubA, largeToken);
  report.timingsMs.attachmentLargeAToB = Math.round(performance.now() - t2);
  report.p2pStats.largeAttachmentP2P = !!report.attachmentLarge.receiveResult?.p2p;

  report.ok = Boolean(
    report.text.sendResult?.ok &&
    report.text.receiveResult?.ok &&
    report.attachmentSmall.sendResult?.ok &&
    report.attachmentSmall.receiveResult?.ok &&
    report.attachmentSmall.receiveResult?.hasAttachment &&
    report.attachmentLarge.sendResult?.ok &&
    report.attachmentLarge.receiveResult?.ok
  );

  return report;
}

function attachConsole(page, name) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[DC]') || t.includes('voice') || t.includes('video')) {
      console.log(`[${name} console] ${t}`);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const localUrl = args.localUrl || 'http://localhost:3000/videos.html';
  const remoteUrl = args.remoteUrl || 'https://sos010.com/videos.html';
  const keyA = requireArg(args, 'keyA');
  const keyB = requireArg(args, 'keyB');
  const headless = args.headless !== 'false';

  const pubA = getPublicKey(utils.hexToBytes(keyA));
  const pubB = getPublicKey(utils.hexToBytes(keyB));

  console.log('QA start', { localUrl, remoteUrl, headless, pubA: pubA.slice(0, 12), pubB: pubB.slice(0, 12) });

  const browser = await chromium.launch({
    headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctxA = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ['microphone', 'camera'],
  });
  const ctxB = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ['microphone', 'camera'],
  });
  const ctxLocal1 = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ['microphone', 'camera'],
  });
  const ctxLocal2 = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ['microphone', 'camera'],
  });

  for (const [ctx, key] of [[ctxA, keyA], [ctxB, keyB], [ctxLocal1, keyA], [ctxLocal2, keyB]]) {
    await ctx.addInitScript((k) => window.localStorage.setItem('nostr_private_key', k), key);
  }

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageLocalA = await ctxLocal1.newPage();
  const pageLocalB = await ctxLocal2.newPage();
  [ [pageA, 'A-remote'], [pageB, 'B-remote'], [pageLocalA, 'A-local'], [pageLocalB, 'B-local'] ].forEach(([p, n]) => attachConsole(p, n));

  const report = {
    ok: false,
    remoteScenario: {},
    localScenario: {},
    voiceCallLocal: {},
    videoCallLocal: {},
    optimizationHints: [],
    errors: [],
  };

  try {
    await Promise.all([
      pageA.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }),
      pageB.goto(remoteUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }),
      pageLocalA.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }),
      pageLocalB.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }),
    ]);

    await Promise.all([openChat(pageA, 'A-remote'), openChat(pageB, 'B-remote'), openChat(pageLocalA, 'A-local'), openChat(pageLocalB, 'B-local')]);
    const [appPubA, appPubB, appLocalPubA, appLocalPubB] = await Promise.all([
      waitForAppReady(pageA, 'A-remote'),
      waitForAppReady(pageB, 'B-remote'),
      waitForAppReady(pageLocalA, 'A-local'),
      waitForAppReady(pageLocalB, 'B-local'),
    ]);
    if (appPubA !== pubA || appPubB !== pubB || appLocalPubA !== pubA || appLocalPubB !== pubB) {
      throw new Error('Loaded user keys do not match provided private keys');
    }

    report.remoteScenario = await runScenario(pageA, pageB, pubA, pubB, 'local-vs-remote');
    report.localScenario = await runScenario(pageLocalA, pageLocalB, pubA, pubB, 'local-vs-local');

    await Promise.all([prepareCallHooks(pageLocalA), prepareCallHooks(pageLocalB)]);
    report.voiceCallLocal = await runVoiceCall(pageLocalA, pageLocalB, pubA, pubB);
    report.videoCallLocal = await runVideoCall(pageLocalA, pageLocalB, pubA, pubB);

    if (!report.remoteScenario?.dataChannel?.aToB || !report.remoteScenario?.dataChannel?.bToA) {
      report.optimizationHints.push('Remote scenario did not establish DataChannel. This path still relies mostly on relays.');
    }
    if (!report.localScenario?.p2pStats?.textP2P) {
      report.optimizationHints.push('Local scenario text stayed on relay. Check relay-first fallback timing and DC bootstrap.');
    }
    if (!report.localScenario?.p2pStats?.largeAttachmentP2P && !report.localScenario?.attachmentLarge?.receiveResult?.hasMagnet) {
      report.optimizationHints.push('Large attachment was not marked P2P/torrent on receive side.');
    }

    report.ok = Boolean(
      report.remoteScenario?.ok &&
      report.localScenario?.ok &&
      report.localScenario?.p2pStats?.textP2P &&
      (report.voiceCallLocal?.attempted ? report.voiceCallLocal?.connected : true) &&
      (report.videoCallLocal?.attempted ? report.videoCallLocal?.connected : true)
    );
  } catch (err) {
    report.errors.push(err.message || String(err));
  } finally {
    await pageA.screenshot({ path: 'qa-user-a-final.png', fullPage: true }).catch(() => {});
    await pageB.screenshot({ path: 'qa-user-b-final.png', fullPage: true }).catch(() => {});
    await pageLocalA.screenshot({ path: 'qa-user-a-local-final.png', fullPage: true }).catch(() => {});
    await pageLocalB.screenshot({ path: 'qa-user-b-local-final.png', fullPage: true }).catch(() => {});
    await browser.close();
  }

  fs.mkdirSync('qa', { recursive: true });
  fs.writeFileSync('qa/last-report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('QA report:\n' + JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal QA harness error:', err);
  process.exit(1);
});
