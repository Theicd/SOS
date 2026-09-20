/**
 * Executable gate: session-scoped secure call signals + cold-start call identity.
 * Runs production chat-voice-call.js / chat-video-call.js / chat-state.js / call UIs.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = '11'.repeat(32);
const PEER = 'e6b68de5' + 'cd'.repeat(28);
const SESSION_A = 'a1'.repeat(16);
const SESSION_B = 'b2'.repeat(16);
const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
const CAND = { candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 54400 typ host', sdpMid: '0', sdpMLineIndex: 0 };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function memStore() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

function stream() {
  const track = { kind: 'audio', enabled: true, stop() {}, addEventListener() {} };
  const vtrack = { kind: 'video', enabled: true, stop() {}, getSettings() { return {}; }, addEventListener() {} };
  return {
    getTracks() { return [track, vtrack]; },
    getAudioTracks() { return [track]; },
    getVideoTracks() { return [vtrack]; },
    addTrack() {},
  };
}

function makePc(box) {
  return class RTCPeerConnection {
    constructor() {
      this.iceConnectionState = 'new';
      this.connectionState = 'new';
      this.remoteSet = 0;
      this.iceAdded = 0;
      this.closed = false;
      box.pcs.push(this);
    }
    close() {
      this.closed = true;
      this.iceConnectionState = 'closed';
      box.closes += 1;
    }
    addTrack() {}
    setRemoteDescription() { this.remoteSet += 1; return Promise.resolve(); }
    setLocalDescription() { return Promise.resolve(); }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    addIceCandidate() { this.iceAdded += 1; return Promise.resolve(); }
  };
}

function bootCall(which) {
  const box = { logs: [], publishes: [], poolPublishes: [], pcs: [], closes: 0, uiCloses: 0, nip04: 0 };
  const ctx = {
    console: {
      log: (...a) => { box.logs.push(a.map(String).join(' ')); },
      warn: (...a) => { box.logs.push(a.map(String).join(' ')); },
      error: (...a) => { box.logs.push('ERR ' + a.map(String).join(' ')); },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: memStore(),
    sessionStorage: memStore(),
    crypto: { getRandomValues(buf) { buf.fill(7); return buf; } },
    navigator: {
      onLine: true,
      mediaDevices: { getUserMedia: async () => stream() },
    },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
    },
    RTCIceCandidate: class RTCIceCandidate { constructor(o) { Object.assign(this, o || {}); } },
    RTCSessionDescription: class RTCSessionDescription { constructor(o) { Object.assign(this, o || {}); } },
    MediaStream: class MediaStream { constructor() { this._t = []; } addTrack(t) { this._t.push(t); } getTracks() { return this._t; } },
    NostrTools: { nip04: { decrypt: async () => null, encrypt: async () => { box.nip04 += 1; throw new Error('nip04'); } } },
  };
  ctx.window = ctx;
  ctx.RTCPeerConnection = makePc(box);
  ctx.NostrApp = {
    publicKey: SELF,
    privateKey: '22'.repeat(32),
    relayUrls: ['wss://relay.example'],
    pool: {
      publish() { box.poolPublishes.push('pool'); return []; },
      subscribeMany() { return { close() {} }; },
    },
    CallSignalE2ee: {
      createSessionId() { return SESSION_B; },
      publishCallSignal: async (payload) => {
        box.publishes.push({
          type: payload && payload.type,
          media: payload && payload.media,
          transport: 'giftwrap1059',
        });
        return { transport: 'giftwrap1059' };
      },
    },
    onVoiceCallIncoming() {},
    onVoiceCallStarted() {},
    onVoiceCallEnded() { box.uiCloses += 1; },
    onVideoCallIncoming() {},
    onVideoCallStarted() {},
    onVideoCallEnded() { box.uiCloses += 1; },
    onVideoCallConnected() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('call-signal-e2ee.js'), ctx, { filename: 'call-signal-e2ee.js' });
  const realPublish = ctx.NostrApp.CallSignalE2ee.publishCallSignal;
  ctx.NostrApp.CallSignalE2ee.publishCallSignal = async (payload) => {
    box.publishes.push({
      type: payload && payload.type,
      media: payload && payload.media,
    });
    return { transport: 'giftwrap1059' };
  };
  ctx.NostrApp.CallSignalE2ee._realPublish = realPublish;
  vm.runInContext(read(which === 'video' ? 'chat-video-call.js' : 'chat-voice-call.js'), ctx, { filename: which });
  box.App = ctx.NostrApp;
  box.ctx = ctx;
  return box;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function signal(media, action, sessionId, extra) {
  const wire = media === 'video'
    ? (action === 'offer' ? 'v-offer'
      : action === 'answer' ? 'v-answer'
      : action === 'candidate' ? 'v-candidate'
      : action === 'candidates' ? 'v-candidates'
      : 'v-disconnect')
    : action;
  return Object.assign({
    media,
    sender: PEER,
    recipient: SELF,
    action,
    wireType: wire,
    sessionId,
    signalId: wire + '-' + sessionId.slice(0, 4) + '-' + Math.random().toString(16).slice(2, 8),
    sentAt: nowSec(),
    wrapId: 'w' + Math.random().toString(16).slice(2, 10),
    data: action === 'offer' ? OFFER
      : action === 'answer' ? { type: 'answer', sdp: 'v=0\r\n' }
      : action === 'candidate' ? CAND
      : action === 'candidates' ? [CAND]
      : null,
  }, extra || {});
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
}

function disconnectPublishes(box) {
  return box.publishes.filter((p) => p.type === 'disconnect' || p.type === 'v-disconnect');
}

function countLog(box, needle) {
  return box.logs.filter((l) => l.includes(needle)).length;
}

async function seedVoice(box, sessionId) {
  await box.App.voiceCall.handleSecureSignal(signal('voice', 'offer', sessionId));
  const before = box.App.voiceCall.getState();
  if (before.callSessionId !== sessionId) throw new Error('voice session not set');
  await box.App.voiceCall.accept(PEER, OFFER);
  const pc = box.pcs[box.pcs.length - 1];
  pc.iceConnectionState = 'connected';
  pc.connectionState = 'connected';
  pc.oniceconnectionstatechange();
  box.publishes.length = 0;
  box.uiCloses = 0;
  box.closes = 0;
  pc.closed = false;
  return pc;
}

async function seedVideo(box, sessionId) {
  box.App.videoCall.handleSecureSignal(signal('video', 'offer', sessionId));
  await flush();
  const before = box.App.videoCall.getState();
  if (before.callSessionId !== sessionId) throw new Error('video session not set: ' + before.callSessionId);
  await box.App.videoCall.accept(PEER, OFFER, { createdAt: nowSec() });
  const pc = box.pcs[box.pcs.length - 1];
  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange();
  box.publishes.length = 0;
  box.uiCloses = 0;
  box.closes = 0;
  pc.closed = false;
  return pc;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    id: '',
    children: [],
    attrs: {},
    style: {},
    parentNode: null,
    _text: '',
  };
  el.classList = {
    add(...xs) { el.className = (el.className + ' ' + xs.join(' ')).trim(); },
    remove() {},
    contains(c) { return String(el.className).split(/\s+/).includes(c); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = v == null ? '' : String(v); },
  });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.hasAttribute = (k) => k in el.attrs;
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.appendChild = (c) => { el.children.push(c); c.parentNode = el; return c; };
  el.remove = () => {};
  el.addEventListener = () => {};
  el.cloneNode = () => makeEl(tag);
  el.querySelector = (sel) => findSel(el, sel);
  el.querySelectorAll = () => [];
  Object.defineProperty(el, 'innerHTML', {
    set(html) {
      el.children = [];
      const re = /<([a-zA-Z0-9]+)([^>]*)>/g;
      let m;
      while ((m = re.exec(String(html)))) {
        const child = makeEl(m[1]);
        const cls = /class="([^"]*)"/.exec(m[2]);
        if (cls) child.className = cls[1];
        const id = /\bid="([^"]*)"/.exec(m[2]);
        if (id) child.id = id[1];
        const da = /data-action="([^"]*)"/.exec(m[2]);
        if (da) child.attrs['data-action'] = da[1];
        el.appendChild(child);
      }
      const textRe = /<([a-zA-Z0-9]+)([^>]*class="([^"]*)"[^>]*)>([^<]*)<\/\1>/g;
      let t;
      const src = String(html);
      while ((t = textRe.exec(src))) {
        const found = el.children.find((c) => c.className === t[3]);
        if (found) found._text = t[4];
      }
    },
  });
  return el;
}

function findSel(root, sel) {
  const all = [];
  const walk = (n) => { all.push(n); (n.children || []).forEach(walk); };
  walk(root);
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return all.find((n) => String(n.className || '').split(/\s+/).includes(cls)) || null;
  }
  if (sel.startsWith('#')) return all.find((n) => n.id === sel.slice(1)) || null;
  const dm = String(sel).match(/^\[([^=]+)="([^"]+)"\]$/);
  if (dm) return all.find((n) => n.attrs && n.attrs[dm[1]] === dm[2]) || null;
  return null;
}

function bootUi() {
  const body = makeEl('body');
  const doc = {
    readyState: 'loading',
    hidden: false,
    visibilityState: 'visible',
    body,
    documentElement: makeEl('html'),
    addEventListener() {},
    createElement: (tag) => makeEl(tag),
    getElementById(id) { return findSel(body, '#' + id); },
    querySelector(sel) { return findSel(body, sel); },
    hasFocus() { return true; },
  };
  body.contains = (node) => {
    const walk = (n) => n === node || (n.children || []).some(walk);
    return walk(body);
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: doc,
    localStorage: memStore(),
    sessionStorage: memStore(),
    navigator: { onLine: true },
    location: { origin: 'https://sos010.com' },
    Audio: function Audio() {
      return { play() { return Promise.resolve(); }, pause() {}, volume: 1, currentTime: 0, paused: true };
    },
    isSecureContext: false,
  };
  ctx.window = ctx;
  ctx.NostrApp = {
    fetchProfile: async () => ({ name: 'Yael Rozen', picture: 'https://example.com/a.jpg' }),
  };
  vm.createContext(ctx);
  vm.runInContext(read('chat-state.js'), ctx, { filename: 'chat-state.js' });
  return ctx;
}

async function main() {
  const dropBox = bootCall('voice');
  const drop = dropBox.App.CallSignalE2ee.shouldDropOldSessionDisconnect;
  record('helper drops different session', drop(SESSION_B, SESSION_A, false) === true);
  record('helper keeps matching session', drop(SESSION_B, SESSION_B, false) === false);
  record('helper drops tombstone', drop(SESSION_B, SESSION_A, true) === true);

  try {
    const voice = bootCall('voice');
    const pcA = await seedVoice(voice, SESSION_B);
    const sidBefore = voice.App.voiceCall.getState().callSessionId;
    const activeBefore = voice.App.voiceCall.getState().isCallActive;
    await voice.App.voiceCall.handleSecureSignal(signal('voice', 'disconnect', SESSION_A));
    const st = voice.App.voiceCall.getState();
    const skipLogs = voice.logs.filter((l) => l.startsWith('CALL_SIGNAL_SKIP') || l.startsWith('CALL_OLD_SESSION'));
    record('A old disconnect leaves session B connected',
      st.callSessionId === sidBefore
      && st.isCallActive === true
      && activeBefore === true
      && pcA.closed === false
      && voice.closes === 0
      && voice.uiCloses === 0
      && disconnectPublishes(voice).length === 0
      && countLog(voice, 'CALL_ENDING') === 0
      && countLog(voice, 'CALL_SIGNAL_SKIP session_mismatch_disconnect') === 1
      && countLog(voice, 'CALL_OLD_SESSION_DISCONNECT_DROP') === 1
      && skipLogs.every((l) => !l.includes(SESSION_A) && !l.includes(SESSION_B)));

    const matched = bootCall('voice');
    await seedVoice(matched, SESSION_B);
    await matched.App.voiceCall.handleSecureSignal(signal('voice', 'disconnect', SESSION_B));
    await flush();
    record('B matched disconnect ends once',
      countLog(matched, 'CALL_ENDING reason=remote_disconnect') === 1
      && countLog(matched, 'CALL_END_ONCE') >= 1
      && matched.App.voiceCall.getState().isCallActive === false);
    record('C remote disconnect echo zero', disconnectPublishes(matched).length === 0 && matched.nip04 === 0);

    const localEnd = bootCall('voice');
    await seedVoice(localEnd, SESSION_B);
    await localEnd.App.voiceCall.end({ reason: 'user_end' });
    record('D local end one encrypted disconnect',
      disconnectPublishes(localEnd).length === 1
      && countLog(localEnd, 'CALL_ENDING reason=user_end') === 1
      && localEnd.poolPublishes.length === 0
      && localEnd.nip04 === 0);

    const decline = bootCall('voice');
    await decline.App.voiceCall.handleSecureSignal(signal('voice', 'offer', SESSION_B));
    await decline.App.voiceCall.rejectIncoming(PEER);
    record('E local decline one encrypted disconnect',
      disconnectPublishes(decline).length === 1
      && countLog(decline, 'CALL_ENDING reason=decline') === 1
      && decline.poolPublishes.length === 0);

    const wrong = bootCall('voice');
    const pcW = await seedVoice(wrong, SESSION_B);
    const remoteBefore = pcW.remoteSet;
    const iceBefore = pcW.iceAdded;
    const pendBefore = JSON.stringify(wrong.App.voiceCall.getState().pendingRemoteCandidates);
    await wrong.App.voiceCall.handleSecureSignal(signal('voice', 'answer', SESSION_A));
    await wrong.App.voiceCall.handleSecureSignal(signal('voice', 'candidate', SESSION_A));
    await wrong.App.voiceCall.handleSecureSignal(signal('voice', 'candidates', SESSION_A));
    const stW = wrong.App.voiceCall.getState();
    record('F wrong-session answer/candidate/candidates ignored',
      stW.callSessionId === SESSION_B
      && stW.isCallActive === true
      && pcW.remoteSet === remoteBefore
      && pcW.iceAdded === iceBefore
      && JSON.stringify(stW.pendingRemoteCandidates) === pendBefore
      && pcW.closed === false
      && countLog(wrong, 'CALL_SIGNAL_SKIP session_mismatch_answer') === 1
      && countLog(wrong, 'CALL_SIGNAL_SKIP session_mismatch_candidate') === 2);
    record('G voice session scope',
      countLog(voice, 'CALL_OLD_SESSION_DISCONNECT_DROP') === 1
      && st.callSessionId === SESSION_B
      && stW.callSessionId === SESSION_B);
  } catch (err) {
    record('voice executable scenarios', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  }

  try {
    const video = bootCall('video');
    const vpc = await seedVideo(video, SESSION_B);
    video.App.videoCall.handleSecureSignal(signal('video', 'disconnect', SESSION_A));
    await flush();
    const vst = video.App.videoCall.getState();
    record('H video old disconnect dropped',
      vst.callSessionId === SESSION_B
      && vst.isActive === true
      && vpc.closed === false
      && video.closes === 0
      && video.uiCloses === 0
      && disconnectPublishes(video).length === 0
      && countLog(video, 'CALL_ENDING') === 0
      && countLog(video, 'CALL_SIGNAL_SKIP session_mismatch_disconnect') === 1);

    const vmatch = bootCall('video');
    await seedVideo(vmatch, SESSION_B);
    vmatch.App.videoCall.handleSecureSignal(signal('video', 'disconnect', SESSION_B));
    await flush();
    record('H video matched disconnect once no echo',
      countLog(vmatch, 'CALL_ENDING reason=remote_disconnect') === 1
      && disconnectPublishes(vmatch).length === 0
      && vmatch.App.videoCall.getState().isActive === false);

    const vwrong = bootCall('video');
    const vpc2 = await seedVideo(vwrong, SESSION_B);
    const rs = vpc2.remoteSet;
    const ia = vpc2.iceAdded;
    vwrong.App.videoCall.handleSecureSignal(signal('video', 'answer', SESSION_A));
    vwrong.App.videoCall.handleSecureSignal(signal('video', 'candidate', SESSION_A));
    vwrong.App.videoCall.handleSecureSignal(signal('video', 'candidates', SESSION_A));
    await flush();
    record('H video wrong-session signals ignored',
      vwrong.App.videoCall.getState().callSessionId === SESSION_B
      && vwrong.App.videoCall.getState().isActive === true
      && vpc2.closed === false
      && vpc2.remoteSet === rs
      && vpc2.iceAdded === ia
      && countLog(vwrong, 'CALL_SIGNAL_SKIP session_mismatch_answer') === 1
      && countLog(vwrong, 'CALL_SIGNAL_SKIP session_mismatch_candidate') === 2);

    const vend = bootCall('video');
    await seedVideo(vend, SESSION_B);
    await vend.App.videoCall.end({ reason: 'user_end' });
    record('H video local end one disconnect',
      disconnectPublishes(vend).length === 1
      && countLog(vend, 'CALL_ENDING reason=user_end') === 1
      && vend.poolPublishes.length === 0);

    const vdec = bootCall('video');
    vdec.App.videoCall.handleSecureSignal(signal('video', 'offer', SESSION_B));
    await flush();
    await vdec.App.videoCall.rejectIncoming(PEER);
    record('H video decline one disconnect',
      disconnectPublishes(vdec).length === 1
      && countLog(vdec, 'CALL_ENDING reason=decline') === 1);
  } catch (err) {
    record('video executable scenarios', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  }

  try {
    const ui = bootUi();
    const pc = { id: 'same-pc', close() { this.closed = true; } };
    ui.NostrApp.voiceCall = {
      isSupported() { return true; },
      getState: () => ({ peerConnection: pc, currentPeer: PEER, isCallActive: false, isIncoming: false }),
    };
    vm.runInContext(read('chat-voice-call-ui.js'), ui, { filename: 'chat-voice-call-ui.js' });
    ui.NostrApp.onVoiceCallIncoming(PEER, OFFER);
    const dialog = ui.document.getElementById('voiceCallDialog');
    const nameEl = dialog && dialog.querySelector('.voice-call-dialog__name');
    const initial = nameEl ? nameEl.textContent : '';
    record('I cold dialog renders fallback',
      !!dialog && initial.includes('משתמש') && initial.includes(PEER.slice(0, 8)));
    await flush();
    await flush();
    const nameAfter = dialog.querySelector('.voice-call-dialog__name');
    const avatar = dialog.querySelector('.voice-call-dialog__avatar');
    const img = avatar && avatar.children && avatar.children.find((c) => c.tagName === 'IMG');
    const sameDialog = ui.document.getElementById('voiceCallDialog') === dialog;
    record('I profile updates same dialog',
      sameDialog
      && nameAfter && nameAfter.textContent === 'Yael Rozen'
      && img && img.src === 'https://example.com/a.jpg'
      && ui.NostrApp.voiceCall.getState().peerConnection === pc
      && !pc.closed);
    record('J voice name', nameAfter && nameAfter.textContent === 'Yael Rozen');
    record('J voice avatar', !!(img && img.src === 'https://example.com/a.jpg'));

    const vui = bootUi();
    const vpc = { id: 'video-pc', close() { this.closed = true; } };
    vui.NostrApp.videoCall = {
      isSupported() { return true; },
      getState: () => ({ currentPeer: PEER, isActive: false, isIncoming: false, pc: vpc }),
    };
    vm.runInContext(read('chat-video-call-ui.js'), vui, { filename: 'chat-video-call-ui.js' });
    vui.NostrApp.onVideoCallIncoming(PEER, OFFER);
    const vdialog = vui.document.body.children.find((c) => String(c.className).includes('video-call-dialog'));
    const vname0 = vdialog && vdialog.querySelector('.video-call-dialog__name');
    record('J video cold fallback', !!(vname0 && String(vname0.textContent).includes('משתמש')));
    await flush();
    await flush();
    const vname = vdialog.querySelector('.video-call-dialog__name');
    const vavatar = vdialog.querySelector('.video-call-dialog__avatar');
    const vimg = vavatar && vavatar.children && vavatar.children.find((c) => c.tagName === 'IMG');
    record('J video name', vname && vname.textContent === 'Yael Rozen' && vdialog === vui.document.body.children.find((c) => String(c.className).includes('video-call-dialog')));
    record('J video avatar', !!(vimg && vimg.src === 'https://example.com/a.jpg') && vui.NostrApp.videoCall.getState().pc === vpc && !vpc.closed);
  } catch (err) {
    record('identity hydration', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err));
  }

  const apk = JSON.parse(read('apk-version.json'));
  const app = JSON.parse(read('app-version.json'));
  record('APK pointer unchanged 1.0.122/123', apk.version === '1.0.122' && Number(apk.versionCode) === 123);
  record('web version call-drain1', app.version === '2026.09.20-call-drain1');
  record('SW v866', /sos-cache-v866/.test(read('service-worker.js')));
  record('security flags frozen',
    app.callSignalGiftWrapRequired === true
    && app.minSecureChatEpoch === 2
    && app.e2eeSendRequired === true
    && app.mediaServerE2eeRequired === true);
  record('hebrew videos intact', read('videos.html').includes('בית'));

  let names = '';
  try {
    names = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  } catch (err) {
    names = '';
    record('git diff readable', false, String(err.message || err));
  }
  const forbidden = /blossom|webtorrent|torrent|PeerExchange|SosNativeP2p|chat-datachannel|25055|30078/i;
  const p2pTouched = names.split(/\r?\n/).filter(Boolean).filter((n) => forbidden.test(n));
  record('P2P/Blossom files untouched', p2pTouched.length === 0, p2pTouched.join(','));
  record('apk-version.json not in diff', !names.split(/\r?\n/).includes('apk-version.json'));
  const nativeTouched = names.split(/\r?\n/).filter((n) => /SosNativeCallVerifier|SosNostrCrypto|IncomingCallActivity|NotificationHelper|SosRelayWatcher|SosPendingCallStore|SosSecureCallSessionStore/.test(n));
  record('native call screen untouched', nativeTouched.length === 0);

  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
