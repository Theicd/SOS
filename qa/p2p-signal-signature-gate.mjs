#!/usr/bin/env node
/**
 * Phase 3: fail-closed signature gate for Nostr DataChannel signaling (kind 25055).
 * Run: node qa/p2p-signal-signature-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DC_PATH = path.join(ROOT, 'chat-p2p-datachannel.js');
const SIG_KIND = 25055;

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function hostVerifyEvent(event) {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: Array.isArray(event.tags)
      ? event.tags.map((tag) => (Array.isArray(tag) ? tag.map((value) => String(value)) : tag))
      : event.tags,
    content: event.content,
    sig: event.sig,
  });
}

function flipSig(event) {
  const copy = cloneEvent(event);
  const sig = String(copy.sig || '');
  copy.sig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  return copy;
}

function loadHarness() {
  const selfSk = generateSecretKey();
  const peerSk = generateSecretKey();
  const otherSk = generateSecretKey();
  const selfPk = getPublicKey(selfSk);
  const peerPk = getPublicKey(peerSk);
  const otherPk = getPublicKey(otherSk);
  const warnings = [];
  const nip04 = { decryptCalls: 0, encryptCalls: 0, decryptPayload: JSON.stringify({ type: 'offer', sdp: 'v=0' }) };
  let rtcCreated = 0;
  let onevent = null;

  const App = {
    publicKey: selfPk,
    privateKey: selfSk,
    guestMode: false,
    relayUrls: ['wss://example.invalid'],
    RTC_ICE_SERVERS: [{ urls: 'stun:stun.l.google.com:19302' }],
    finalizeEvent,
  };

  App.pool = {
    subscribeMany(_relays, _filters, handlers) {
      onevent = handlers && handlers.onevent;
      return { close() {}, unsub() {} };
    },
    publish() {
      return [];
    },
  };

  function RTCPeerConnection() {
    rtcCreated += 1;
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.createDataChannel = () => ({
      label: 'sos-chat',
      readyState: 'connecting',
      binaryType: 'arraybuffer',
      send() {},
      close() {},
    });
    this.createOffer = async () => ({ type: 'offer', sdp: 'v=0' });
    this.createAnswer = async () => ({ type: 'answer', sdp: 'v=0' });
    this.setLocalDescription = async (desc) => { this.localDescription = desc; };
    this.setRemoteDescription = async (desc) => { this.remoteDescription = desc; };
    this.addIceCandidate = async () => {};
    this.close = () => { this.connectionState = 'closed'; };
  }

  const documentElement = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] || null; },
  };

  const context = {
    console: {
      log() {},
      warn(...args) { warnings.push(args.map((value) => String(value)).join(' ')); },
      error() {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { search: '' },
    RTCPeerConnection,
    RTCIceCandidate: function RTCIceCandidate(init) { Object.assign(this, init || {}); },
    document: {
      readyState: 'complete',
      hidden: false,
      documentElement,
      getElementById() { return null; },
      querySelector() { return null; },
      addEventListener() {},
    },
    navigator: { onLine: true },
  };
  context.window = context;
  context.NostrApp = App;
  context.NostrTools = {
    verifyEvent: (ev) => hostVerifyEvent(JSON.parse(JSON.stringify(ev))),
    getEventHash: (ev) => getEventHash(JSON.parse(JSON.stringify(ev))),
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    nip04: {
      async encrypt() {
        nip04.encryptCalls += 1;
        return 'enc';
      },
      async decrypt() {
        nip04.decryptCalls += 1;
        return nip04.decryptPayload;
      },
    },
  };
  context.window.NostrApp = App;
  context.window.NostrTools = context.NostrTools;
  context.window.NostrRTC_ICE = App.RTC_ICE_SERVERS;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nostr-event-integrity.js'), 'utf8'), context, {
    filename: 'nostr-event-integrity.js',
  });
  vm.runInContext(fs.readFileSync(DC_PATH, 'utf8'), context, { filename: 'chat-p2p-datachannel.js' });
  if (!App.dataChannel || typeof App.dataChannel.init !== 'function') {
    throw new Error('dataChannel module did not load');
  }
  App.dataChannel.init();
  if (typeof onevent !== 'function') {
    throw new Error('subscribeMany did not capture onevent');
  }

  async function deliver(event) {
    try {
      const result = onevent(event);
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      warnings.push('onevent-threw ' + (err && err.message ? err.message : String(err)));
    }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    App,
    context,
    selfPk,
    peerPk,
    otherPk,
    selfSk,
    peerSk,
    otherSk,
    warnings,
    nip04,
    get rtcCreated() { return rtcCreated; },
    deliver,
  };
}

function signSignal(sk, recipientPk, type, extraTags) {
  const tags = [['type', type], ['p', String(recipientPk).toLowerCase()], ['r', 'qa']];
  if (Array.isArray(extraTags)) tags.push(...extraTags);
  return cloneEvent(finalizeEvent({
    kind: SIG_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'enc',
  }, sk));
}

function securityRejected(warnings) {
  return warnings.some((line) => line.includes('[SO-CALL SECURITY] rejected invalid P2P signal kind=25055'));
}

function peerCount(App) {
  const peers = App.dataChannel && App.dataChannel._peers;
  if (!peers || typeof peers.size !== 'number' || typeof peers.has !== 'function') return -1;
  return peers.size;
}

function seenSize(App, peerPk) {
  const peers = App.dataChannel && App.dataChannel._peers;
  const state = peers && peers.get(String(peerPk || '').toLowerCase());
  return state && state.seen ? state.seen.size : 0;
}

async function main() {
  const source = fs.readFileSync(DC_PATH, 'utf8');
  const handleIdx = source.indexOf('async function handleSig(event)');
  const verifyIdx = source.indexOf('verifyIncomingP2pRelayEvent(event)', handleIdx);
  const pTagCandidates = [source.indexOf("t[0]==='p'", handleIdx), source.indexOf("t[0] === 'p'", handleIdx)].filter(
    (i) => i >= handleIdx,
  );
  const pTagIdx = pTagCandidates.length ? Math.min(...pTagCandidates) : -1;
  const ingestIdx = source.indexOf('function ingestLocalSignal');
  const ingestEnd = source.indexOf('function hookMeshReceiver', ingestIdx);
  const ingestBody = ingestIdx >= 0 ? source.slice(ingestIdx, ingestEnd > ingestIdx ? ingestEnd : ingestIdx + 800) : '';
  record(
    'source cheap recipient/type filters before verify in handleSig',
    handleIdx >= 0 && pTagIdx > handleIdx && verifyIdx > pTagIdx,
  );
  record(
    'source does not require Nostr signatures on ingestLocalSignal',
    ingestIdx >= 0 && !ingestBody.includes('verifyIncomingP2pRelayEvent'),
  );

  const h = loadHarness();
  const valid = signSignal(h.peerSk, h.selfPk, 'dc-offer');
  const beforePeers = peerCount(h.App);
  const beforeDecrypt = h.nip04.decryptCalls;
  const beforeRtc = h.rtcCreated;
  await h.deliver(valid);
  record(
    'A valid signed 25055 dc-offer ACCEPT',
    h.App.dataChannel.verifyIncomingRelayEvent(cloneEvent(valid)) === true &&
      !securityRejected(h.warnings) &&
      peerCount(h.App) === beforePeers + 1 &&
      h.App.dataChannel._peers.has(h.peerPk.toLowerCase()),
    'peers=' + peerCount(h.App),
  );

  const peersAfterA = peerCount(h.App);
  const decryptAfterA = h.nip04.decryptCalls;
  const rtcAfterA = h.rtcCreated;
  const seenAfterA = seenSize(h.App, h.peerPk);

  const tampered = cloneEvent(valid);
  tampered.content = 'tampered-sdp';
  await h.deliver(tampered);
  record(
    'B tampered content REJECT',
    h.App.dataChannel.verifyIncomingRelayEvent(tampered) === false &&
      securityRejected(h.warnings) &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
  );

  const forgedPk = cloneEvent(valid);
  forgedPk.pubkey = h.otherPk;
  await h.deliver(forgedPk);
  record(
    'C tampered pubkey REJECT',
    h.App.dataChannel.verifyIncomingRelayEvent(forgedPk) === false &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
  );

  const tamperedP = cloneEvent(valid);
  tamperedP.tags = tamperedP.tags.map((tag) => (tag[0] === 'p' ? ['p', h.otherPk] : tag));
  await h.deliver(tamperedP);
  record(
    'D tampered p tag REJECT',
    h.App.dataChannel.verifyIncomingRelayEvent(tamperedP) === false &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
  );

  const tamperedType = cloneEvent(valid);
  tamperedType.tags = tamperedType.tags.map((tag) => (tag[0] === 'type' ? ['type', 'dc-answer'] : tag));
  await h.deliver(tamperedType);
  record(
    'E tampered type tag REJECT',
    h.App.dataChannel.verifyIncomingRelayEvent(tamperedType) === false &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
  );

  const badSig = flipSig(valid);
  await h.deliver(badSig);
  record(
    'F invalid signature REJECT',
    h.App.dataChannel.verifyIncomingRelayEvent(badSig) === false &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
  );

  const warnBeforeG = h.warnings.length;
  await h.deliver(null);
  await h.deliver({});
  await h.deliver({ kind: SIG_KIND });
  record(
    'G malformed event REJECT without throw',
    !h.warnings.some((line) => line.startsWith('onevent-threw')) &&
      peerCount(h.App) === peersAfterA &&
      seenSize(h.App, h.peerPk) === seenAfterA &&
      h.nip04.decryptCalls === decryptAfterA &&
      h.rtcCreated === rtcAfterA,
    // cheap structural drop may skip verify log for events without p/self; no throw / no state is required
  );

  const missing = loadHarness();
  const missingValid = signSignal(missing.peerSk, missing.selfPk, 'dc-offer');
  missing.context.NostrTools.verifyEvent = undefined;
  const warnBeforeH = missing.warnings.length;
  await missing.deliver(missingValid);
  record(
    'H verifier unavailable FAIL CLOSED',
    missing.App.dataChannel.verifyIncomingRelayEvent(cloneEvent(missingValid)) === false &&
      missing.warnings.slice(warnBeforeH).some((line) => line.includes('[SO-CALL SECURITY] rejected invalid P2P signal kind=25055')) &&
      peerCount(missing.App) === 0 &&
      missing.nip04.decryptCalls === 0 &&
      missing.rtcCreated === 0 &&
      !missing.warnings.some((line) => line.startsWith('onevent-threw')),
  );

  const throwing = loadHarness();
  const throwValid = signSignal(throwing.peerSk, throwing.selfPk, 'dc-offer');
  throwing.context.NostrTools.verifyEvent = () => {
    throw new Error('verify-boom');
  };
  await throwing.deliver(throwValid);
  const recovered = signSignal(throwing.peerSk, throwing.selfPk, 'dc-need-offer');
  throwing.context.NostrTools.verifyEvent = hostVerifyEvent;
  await throwing.deliver(recovered);
  record(
    'H2 verifyEvent throw drops event and subscription recovers',
    !throwing.warnings.some((line) => line.startsWith('onevent-threw')) &&
      peerCount(throwing.App) === 1 &&
      throwing.App.dataChannel._peers.has(throwing.peerPk.toLowerCase()),
  );

  const poison = loadHarness();
  const poisonValid = signSignal(poison.peerSk, poison.selfPk, 'dc-offer');
  await poison.deliver(poisonValid);
  const seenBeforeInvalid = seenSize(poison.App, poison.peerPk);
  const poisonInvalid = flipSig(signSignal(poison.peerSk, poison.selfPk, 'dc-candidates'));
  await poison.deliver(poisonInvalid);
  record(
    'I invalid event seen-set unchanged',
    seenBeforeInvalid === 1 && seenSize(poison.App, poison.peerPk) === 1 && peerCount(poison.App) === 1,
  );

  const fresh = loadHarness();
  await fresh.deliver(flipSig(signSignal(fresh.peerSk, fresh.selfPk, 'dc-offer')));
  record(
    'J invalid event no peer state creation',
    peerCount(fresh.App) === 0 && fresh.rtcCreated === 0 && fresh.nip04.decryptCalls === 0,
  );

  const mesh = loadHarness();
  const warnBeforeMesh = mesh.warnings.length;
  mesh.App.dataChannel.ingestSignal('10.0.0.2', {
    type: 'dc-need-offer',
    fromPubkey: mesh.peerPk,
  }, mesh.peerPk);
  const meshPeer = mesh.App.dataChannel._peers.get(mesh.peerPk.toLowerCase());
  record(
    'K local/MESH signal unchanged and no Nostr verification',
    meshPeer && meshPeer.sigTransport === 'MESH' &&
      mesh.warnings.slice(warnBeforeMesh).every((line) => !line.includes('[SO-CALL SECURITY]')),
  );

  const wrongDest = signSignal(h.peerSk, h.otherPk, 'dc-offer');
  const warnBeforeWrongDest = h.warnings.length;
  await h.deliver(wrongDest);
  record(
    'existing recipient filter unchanged for valid 25055',
    h.App.dataChannel.verifyIncomingRelayEvent(cloneEvent(wrongDest)) === true &&
      peerCount(h.App) === peersAfterA &&
      h.warnings.slice(warnBeforeWrongDest).every((line) => !line.includes('[SO-CALL SECURITY]')),
  );

  const dup = loadHarness();
  const dupEvent = signSignal(dup.peerSk, dup.selfPk, 'dc-offer');
  await dup.deliver(dupEvent);
  const seen1 = dup.App.dataChannel._peers.get(dup.peerPk.toLowerCase()).seen.size;
  await dup.deliver(cloneEvent(dupEvent));
  const seen2 = dup.App.dataChannel._peers.get(dup.peerPk.toLowerCase()).seen.size;
  const stale = signSignal(dup.peerSk, dup.selfPk, 'dc-answer');
  stale.created_at = Math.floor(Date.now() / 1000) - 4000;
  const signedStale = cloneEvent(finalizeEvent({
    kind: SIG_KIND,
    created_at: stale.created_at,
    tags: stale.tags,
    content: 'enc',
  }, dup.peerSk));
  const decryptBeforeStale = dup.nip04.decryptCalls;
  await dup.deliver(signedStale);
  record(
    'existing duplicate + freshness handling unchanged',
    seen1 === 1 && seen2 === 1 && dup.nip04.decryptCalls === decryptBeforeStale,
    'seen=' + seen1 + '/' + seen2,
  );

  const staleFirst = loadHarness();
  const staleFirstEv = cloneEvent(finalizeEvent({
    kind: SIG_KIND,
    created_at: Math.floor(Date.now() / 1000) - 4000,
    tags: [['type', 'dc-offer'], ['p', staleFirst.selfPk], ['r', 'qa']],
    content: 'enc',
  }, staleFirst.peerSk));
  await staleFirst.deliver(staleFirstEv);
  record(
    '7 stale valid 25055 rejected without peer state',
    peerCount(staleFirst.App) === 0 &&
      staleFirst.nip04.decryptCalls === 0 &&
      staleFirst.rtcCreated === 0,
  );

  const freshP2p = loadHarness();
  const freshP2pEv = signSignal(freshP2p.peerSk, freshP2p.selfPk, 'dc-offer');
  await freshP2p.deliver(freshP2pEv);
  record(
    '7 fresh valid 25055 accepted',
    peerCount(freshP2p.App) === 1 &&
      freshP2p.App.dataChannel._peers.has(freshP2p.peerPk.toLowerCase()),
    'peers=' + peerCount(freshP2p.App),
  );

  const badSdpP2p = loadHarness();
  badSdpP2p.nip04.decryptPayload = JSON.stringify({ nope: true });
  await badSdpP2p.deliver(signSignal(badSdpP2p.peerSk, badSdpP2p.selfPk, 'dc-offer'));
  record(
    '8 malformed SDP container rejected without peer state',
    peerCount(badSdpP2p.App) === 0 &&
      badSdpP2p.rtcCreated === 0,
  );

  const hugeSdpP2p = loadHarness();
  hugeSdpP2p.nip04.decryptPayload = JSON.stringify({ type: 'offer', sdp: 'v=' + '0'.repeat(70000) });
  await hugeSdpP2p.deliver(signSignal(hugeSdpP2p.peerSk, hugeSdpP2p.selfPk, 'dc-offer'));
  record(
    '8 oversized SDP rejected without peer state',
    peerCount(hugeSdpP2p.App) === 0 &&
      hugeSdpP2p.rtcCreated === 0,
  );

  const candOkP2p = loadHarness();
  candOkP2p.nip04.decryptPayload = JSON.stringify([{ candidate: 'candidate:1 1 udp 1 1.1.1.1 9 typ host' }]);
  await candOkP2p.deliver(signSignal(candOkP2p.peerSk, candOkP2p.selfPk, 'dc-candidates'));
  record(
    '8 valid ICE candidates accepted',
    peerCount(candOkP2p.App) === 1 &&
      candOkP2p.App.dataChannel._peers.has(candOkP2p.peerPk.toLowerCase()),
  );

  const hugeCandP2p = loadHarness();
  hugeCandP2p.nip04.decryptPayload = JSON.stringify(new Array(300).fill({ candidate: 'x' }));
  await hugeCandP2p.deliver(signSignal(hugeCandP2p.peerSk, hugeCandP2p.selfPk, 'dc-candidates'));
  record(
    '8 absurd candidate array rejected without peer state',
    peerCount(hugeCandP2p.App) === 0 &&
      hugeCandP2p.rtcCreated === 0,
  );

  record(
    'invalid signaling caused zero extra WebRTC/decrypt work',
    h.nip04.decryptCalls === decryptAfterA && h.rtcCreated === rtcAfterA,
  );
  record(
    'security warnings omit SDP and payloads',
    h.warnings.every((line) => !line.includes('tampered-sdp') && !line.includes('v=0')),
  );

  console.log(results.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
