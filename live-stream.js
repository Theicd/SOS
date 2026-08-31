// חלק שידור חי (live-stream.js) – ליבה: שידור/צפייה מרובים מעל תשתית Nostr + WebRTC
// שייך: מודול לוגי מרכזי, תפקידים: 'broadcaster' (משדר), 'relay' (צופה-מגשר), 'viewer' (צופה)
// מגבלות: קוד עד 350 שורות, הערות ברורות, מינימום תלות בשרתים – שימוש ברשת הקיימת
(function initLiveStream(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const NT = window.NostrTools;

  // חלק הגדרות – MVP יציב: רק חיבורים ישירים למשדר (בלי mesh/relay) | HYPER CORE TECH
  const MAX_DIRECT_CHILDREN = 3; // כמה צופים המשדר מחזיק ישירות
  // אותות WebRTC לשידור חי — מופרדים משיחות קול (25050) כדי לא לשבור P2P/DC | HYPER CORE TECH
  const LIVE_SIGNAL_KIND = 25056;
  // heartbeat מטא בלבד (25051) — לא 25050/30078, לא נוגע בשיחות/צ'אט/P2P | HYPER CORE TECH
  const STATUS_HEARTBEAT_MS = 50000;

  // מצב גלובלי לשידור חי לחדר יחיד בכל פעם (MVP)
  const state = {
    role: null,                      // 'broadcaster' | 'relay' | 'viewer'
    roomId: null,                    // מזהה חדר: נגזר מזוג (משדר, slug)
    broadcaster: null,               // pubkey של המשדר
    parentPeer: null,                // pubkey של המקור ממנו נצרוך וידאו (משדר/ריליי)
    directChildren: new Set(),       // ילדים ישירים (כשהננו מקור)
    relays: new Set(),               // רשימת רילייז פומבית
    pcMap: new Map(),                // peerPubkey -> RTCPeerConnection
    localStream: null,               // וידאו+אודיו כשאנחנו משדרים (או captureStream במצב relay)
    incomingRemoteStream: null,      // סטרים שמגיע מהמקור (לריליי/צופה)
    hiddenVideoEl: null,             // וידאו חבוי ללכידת stream כשאנחנו relay
    ending: false,
    slug: 'live',
    title: '',
    hostName: '',
    hostPicture: ''
  };

  let statusHeartbeatTimer = null;

  // קונפיג ICE – כמו P2P (כולל TURN) כדי למנוע מסך שחור מאחורי NAT | HYPER CORE TECH
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      };

  let signalSub = null;
  let connectingParent = null;
  let iceFailRetries = 0;
  const pendingRemoteIce = new Map(); // peer -> RTCIceCandidateInit[]

  // עזר: roomId דטרמיניסטי
  function getRoomId(owner, slug){
    const a = (owner||'').toLowerCase(); const s = (slug||'').toLowerCase();
    return `${a}::live::${s}`;
  }

  // עזר: שליחת אותות דרך Nostr kind 25056 (ייעודי ל־Live) | HYPER CORE TECH
  async function sendSignal(to, type, data){
    if(!App.pool || !App.publicKey || !App.privateKey) return;
    const payload = data ? JSON.stringify(data) : '';
    const content = payload ? await NT.nip04.encrypt(App.privateKey, to, payload) : '';
    const ev = { kind: LIVE_SIGNAL_KIND, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [ ['type', type], ['p', to], ['r', state.roomId||''] ], content };
    const signed = App.finalizeEvent(ev, App.privateKey);
    await App.pool.publish(App.relayUrls, signed);
  }

  function normKey(k){ return String(k || '').toLowerCase(); }

  function findPcKey(peer){
    const want = normKey(peer);
    if (!want) return null;
    if (state.pcMap.has(peer)) return peer;
    for (const k of state.pcMap.keys()) {
      if (normKey(k) === want) return k;
    }
    return null;
  }

  function getPc(peer){
    const k = findPcKey(peer);
    return k ? state.pcMap.get(k) : null;
  }

  function isPcAlive(pc){
    if (!pc) return false;
    const cs = pc.connectionState;
    return cs !== 'failed' && cs !== 'closed';
  }

  // יצירת RTCPeerConnection עבור peer מסוים
  function createPC(peer){
    const peerKey = peer;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    // הוספת מסלולים מקומיים אם קיימים
    if(state.localStream){ state.localStream.getTracks().forEach(t=>pc.addTrack(t, state.localStream)); }
    pc.onicecandidate = e => { queueCandidate(peerKey, e.candidate||null); };
    pc.ontrack = e => {
      // קבלת סטרים מרוחק — תומך גם כשאין e.streams[0] (Chrome/Safari) | HYPER CORE TECH
      if(!state.incomingRemoteStream) state.incomingRemoteStream = new MediaStream();
      try {
        if (e.track) {
          const exists = state.incomingRemoteStream.getTracks().some((t) => t.id === e.track.id);
          if (!exists) state.incomingRemoteStream.addTrack(e.track);
        } else if (e.streams && e.streams[0]) {
          e.streams[0].getTracks().forEach((t) => {
            if (!state.incomingRemoteStream.getTracks().some((x) => x.id === t.id)) {
              state.incomingRemoteStream.addTrack(t);
            }
          });
        }
      } catch (err) {
        console.warn('LIVE ontrack merge failed', err);
      }
      iceFailRetries = 0;
      if(typeof App.onLiveRemoteStream === 'function') App.onLiveRemoteStream(state.incomingRemoteStream);
      if(state.role !== 'broadcaster') ensureRelayCapture();
    };
    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState; console.log('LIVE PC', String(peerKey).slice(0,8), cs);
      if (cs === 'connected') {
        iceFailRetries = 0;
        connectingParent = null;
        return;
      }
      // disconnected זמני ב-ICE — לא סוגרים מיד | HYPER CORE TECH
      if (cs === 'failed' || cs === 'closed') {
        const wasParent = normKey(peerKey) === normKey(state.parentPeer);
        tryEndChild(peerKey);
        if (!state.ending && state.role !== 'broadcaster' && wasParent) {
          try {
            if (typeof App.onLiveIceFailed === 'function') App.onLiveIceFailed(state.roomId, state.broadcaster);
            else if (typeof App.onLiveStreamLost === 'function') App.onLiveStreamLost(state.roomId);
          } catch (_) {}
        }
      } else if (cs === 'disconnected') {
        setTimeout(() => {
          try {
            const pc2 = getPc(peerKey);
            if (!pc2 || state.ending) return;
            if (pc2.connectionState === 'failed' || pc2.connectionState === 'closed') return;
            if (pc2.connectionState === 'disconnected' && state.role !== 'broadcaster' && normKey(peerKey) === normKey(state.parentPeer)) {
              if (typeof App.onLiveIceFailed === 'function') App.onLiveIceFailed(state.roomId, state.broadcaster);
            }
          } catch (_) {}
        }, 10000);
      }
    };
    // מפתח אחיד — מונע כפילות PC לאותו peer | HYPER CORE TECH
    const prevKey = findPcKey(peerKey);
    if (prevKey && prevKey !== peerKey) {
      try { state.pcMap.get(prevKey)?.close(); } catch (_) {}
      state.pcMap.delete(prevKey);
    }
    state.pcMap.set(peerKey, pc);
    return pc;
  }

  // צבירת ICE candidates
  const candQueue = new Map(); const candTimer = new Map();
  function queueCandidate(peer, cand){
    if(!candQueue.has(peer)) candQueue.set(peer, []);
    const arr = candQueue.get(peer);
    if(cand) arr.push(cand);
    if(!cand){ flushCandidates(peer); return; }
    if(candTimer.has(peer)) clearTimeout(candTimer.get(peer));
    candTimer.set(peer, setTimeout(()=>flushCandidates(peer), 1000));
  }
  function flushCandidates(peer){
    const arr = candQueue.get(peer)||[]; candQueue.delete(peer);
    if(arr.length) sendSignal(peer, 'live-candidates', arr);
    if(candTimer.has(peer)) { clearTimeout(candTimer.get(peer)); candTimer.delete(peer); }
  }

  // ניהול Relay Capture: לוכדים את הסטרים המרוחק ומייצרים סטרים מקומי לשליחה הלאה
  function ensureRelayCapture(){
    if(state.role === 'broadcaster') return;
    if(!state.hiddenVideoEl){
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true; v.style.display = 'none';
      document.body.appendChild(v); state.hiddenVideoEl = v;
    }
    if(state.incomingRemoteStream && !state.localStream){
      state.hiddenVideoEl.srcObject = state.incomingRemoteStream;
      const cap = typeof state.hiddenVideoEl.captureStream === 'function' ? state.hiddenVideoEl.captureStream() : null;
      if(cap){ state.localStream = cap; // עכשיו נוכל לשלוח לילדים
        // לכל חיבור קיים שאין בו מסלולים – נצרף
        state.pcMap.forEach((pc, peer)=>{
          if(pc.getSenders().length===0 && state.localStream){ state.localStream.getTracks().forEach(t=>pc.addTrack(t, state.localStream)); }
        });
      }
    }
  }

  function stopStatusHeartbeat(){
    if (statusHeartbeatTimer) {
      try { clearInterval(statusHeartbeatTimer); } catch (_) {}
      statusHeartbeatTimer = null;
    }
  }

  function startStatusHeartbeat(){
    stopStatusHeartbeat();
    if (state.role !== 'broadcaster' || !state.roomId) return;
    statusHeartbeatTimer = setInterval(() => {
      if (state.ending || state.role !== 'broadcaster' || !state.roomId) {
        stopStatusHeartbeat();
        return;
      }
      try { if (typeof document !== 'undefined' && document.hidden) return; } catch (_) {}
      announceStatus().catch(() => {});
    }, STATUS_HEARTBEAT_MS);
  }

  // התחלת שידור – המשדר (תומך ב־title / stream קיים / יחס 9:16) | HYPER CORE TECH
  async function startBroadcast(opts){
    const options = (opts && typeof opts === 'object') ? opts : { slug: opts };
    const slug = options.slug || 'live';
    const title = String(options.title || '').trim() || 'שידור חי';
    state.role = 'broadcaster'; state.broadcaster = App.publicKey; state.roomId = getRoomId(App.publicKey, slug||('room-'+Date.now()));
    state.slug = slug;
    state.title = title;
    state.relays.clear(); state.directChildren.clear();
    if (options.stream && typeof options.stream.getTracks === 'function') {
      state.localStream = options.stream;
    } else {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: options.facingMode || 'user',
          aspectRatio: { ideal: 9 / 16 },
          width: { ideal: 720 },
          height: { ideal: 1280 }
        }
      });
    }
    if(typeof App.onLiveLocalStream === 'function') App.onLiveLocalStream(state.localStream);
    // פרסום 'live-post' כדי שהפיד יצייר כרטיס צפייה + באנר "התחיל לשדר" | HYPER CORE TECH
    try {
      if(App.pool && App.publicKey){
        const prof = App.profile || {};
        const name = String(prof.name || '').trim().slice(0, 48);
        const pictureRaw = String(prof.picture || '').trim();
        const picture = (/^https?:\/\//i.test(pictureRaw) && pictureRaw.length < 500) ? pictureRaw : '';
        state.hostName = name;
        state.hostPicture = picture;
        const content = JSON.stringify({ roomId: state.roomId, owner: App.publicKey, slug, title, name, picture });
        const ev = { kind: 25051, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [['type','live-post'], ['r', state.roomId], ['title', title.slice(0, 80)]], content };
        const signed = App.finalizeEvent(ev, App.privateKey); await App.pool.publish(App.relayUrls, signed);
      }
    } catch {}
    await announceStatus();
    startStatusHeartbeat();
  }

  // הצטרפות לצפייה – קובע אם viewer או relay לפי עומס
  async function joinLive(roomOwner, slug){
    state.role = 'viewer'; state.broadcaster = roomOwner; state.roomId = getRoomId(roomOwner, slug);
    // נבקש מיפוי למקור: המשדר יענה ברשימת relays + ספירת ישירים
    await sendSignal(roomOwner, 'live-join', { roomId: state.roomId });
  }

  // המשדר: חיבור ישיר בלבד (mesh/relay כבוי עד ייצוב) | HYPER CORE TECH
  async function handleJoin(peer){
    if(state.role !== 'broadcaster') return;
    const peerKey = normKey(peer);
    if (!peerKey || peerKey === normKey(App.publicKey)) return;

    const existingPc = getPc(peer);
    if (existingPc && isPcAlive(existingPc)) {
      const cs = existingPc.connectionState;
      if (cs === 'connected' || cs === 'connecting') {
        console.log('LIVE: join ignored, already connected', peerKey.slice(0,8), cs);
        return;
      }
    }

    // כבר ברשימת ילדים — שלח invite שוב רק אם אין PC חי (idempotent לצופה) | HYPER CORE TECH
    let alreadyChild = false;
    for (const c of state.directChildren) {
      if (normKey(c) === peerKey) { alreadyChild = true; break; }
    }
    if (alreadyChild && existingPc && isPcAlive(existingPc)) {
      console.log('LIVE: join ignored, child PC alive', peerKey.slice(0,8));
      return;
    }

    if (state.directChildren.size < MAX_DIRECT_CHILDREN || alreadyChild) {
      await inviteDirect(peer);
    } else {
      console.warn('LIVE: room full, max direct viewers', MAX_DIRECT_CHILDREN);
      try { await sendSignal(peer, 'live-full', { max: MAX_DIRECT_CHILDREN }); } catch (_) {}
    }
    announceStatus();
  }

  // הזמנת חיבור ישיר למשדר
  async function inviteDirect(viewer){
    await sendSignal(viewer, 'live-invite', { parent: App.publicKey, role: 'viewer' });
  }

  // התחברות ל-parent — לא שוברים PC חי על invite חוזר | HYPER CORE TECH
  async function connectToParent(parentPubkey){
    const parent = parentPubkey || state.broadcaster;
    if (!parent) return;
    const existing = getPc(parent);
    if (existing && isPcAlive(existing)) {
      const cs = existing.connectionState;
      if (cs === 'connected' || cs === 'connecting' || connectingParent === parent) {
        console.log('LIVE: skip reconnect, PC alive', String(parent).slice(0,8), cs);
        state.parentPeer = parent;
        return;
      }
      // disconnected ממושך — נחליף רק אז | HYPER CORE TECH
      if (cs !== 'disconnected') {
        state.parentPeer = parent;
        return;
      }
    }
    if (existing) {
      try { existing.close(); } catch (_) {}
      const oldKey = findPcKey(parent);
      if (oldKey) state.pcMap.delete(oldKey);
    }
    connectingParent = parent;
    state.parentPeer = parent;
    const pc = createPC(parent);
    // צופה: recvonly — מבטיח מסלולי וידאו/אודיו ב־SDP | HYPER CORE TECH
    try {
      if (!state.localStream || state.role === 'viewer') {
        const hasVideoRecv = pc.getTransceivers().some((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
        if (!hasVideoRecv) {
          pc.addTransceiver('video', { direction: 'recvonly' });
          pc.addTransceiver('audio', { direction: 'recvonly' });
        }
      }
    } catch (_) {}
    // flush מועמדים מוקדמים אם הגיעו לפני יצירת PC | HYPER CORE TECH
    const early = pendingRemoteIce.get(parent) || pendingRemoteIce.get(normKey(parent)) || [];
    pendingRemoteIce.delete(parent);
    pendingRemoteIce.delete(normKey(parent));
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    await sendSignal(parent, 'live-offer', offer);
    for (const c of early) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }

  // parent מקבל offer מצופה — לא סוגרים PC חי על offer כפול | HYPER CORE TECH
  async function acceptChildOffer(childPubkey, offer){
    if (!offer || !offer.type || !offer.sdp) {
      console.warn('LIVE: invalid offer from', String(childPubkey||'').slice(0,8));
      return;
    }
    const existing = getPc(childPubkey);
    if (existing && isPcAlive(existing)) {
      const cs = existing.connectionState;
      if (cs === 'connected' || cs === 'connecting') {
        console.log('LIVE: ignore duplicate offer', String(childPubkey).slice(0,8), cs);
        return;
      }
      // PC קיים אבל לא מחובר — רק אז מחליפים | HYPER CORE TECH
      if (cs === 'new' && existing.signalingState !== 'stable' && existing.remoteDescription) {
        console.log('LIVE: ignore offer, negotiation in progress', String(childPubkey).slice(0,8));
        return;
      }
    }
    if (existing) {
      try { existing.close(); } catch (_) {}
      const oldKey = findPcKey(childPubkey);
      if (oldKey) state.pcMap.delete(oldKey);
    }
    const pc = createPC(childPubkey);
    await pc.setRemoteDescription(offer);
    const early = pendingRemoteIce.get(childPubkey) || pendingRemoteIce.get(normKey(childPubkey)) || [];
    pendingRemoteIce.delete(childPubkey);
    pendingRemoteIce.delete(normKey(childPubkey));
    for (const c of early) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    if(state.role === 'broadcaster'){
      let found = false;
      for (const c of state.directChildren) {
        if (normKey(c) === normKey(childPubkey)) { found = true; break; }
      }
      if (!found && state.directChildren.size < MAX_DIRECT_CHILDREN) {
        state.directChildren.add(childPubkey);
      } else if (!found) {
        // מעל המכסה — עדיין נענה אם כבר התחלנו (נדיר) | HYPER CORE TECH
        state.directChildren.add(childPubkey);
      }
    } else {
      ensureRelayCapture();
    }
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    await sendSignal(childPubkey, 'live-answer', ans);
  }

  // קבלת תשובה מה-parent
  async function setParentAnswer(parent, answer){
    const pc = getPc(parent);
    if(!pc || !answer) return;
    try { await pc.setRemoteDescription(answer); } catch (e) { console.warn('LIVE setRemote answer failed', e); }
    const early = pendingRemoteIce.get(parent) || pendingRemoteIce.get(normKey(parent)) || [];
    pendingRemoteIce.delete(parent);
    pendingRemoteIce.delete(normKey(parent));
    for (const c of early) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }

  // מועמדי ICE
  async function addCandidates(from, list){
    if(!Array.isArray(list) || !list.length) return;
    const pc = getPc(from);
    if(!pc || !pc.remoteDescription){
      const key = from;
      const arr = pendingRemoteIce.get(key) || [];
      list.forEach((c) => { if (c) arr.push(c); });
      pendingRemoteIce.set(key, arr);
      return;
    }
    for(const c of list){
      try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch{}
    }
  }

  // ניקוי ילד שהתנתק
  function tryEndChild(pubkey){
    const key = findPcKey(pubkey);
    if(key){ try{ state.pcMap.get(key).close(); }catch{} state.pcMap.delete(key); }
    const want = normKey(pubkey);
    for (const c of Array.from(state.directChildren)) {
      if (normKey(c) === want) state.directChildren.delete(c);
    }
  }

  // סטטוס ציבורי (25051) — גילוי לצופים מאוחרים + מונה צופים; לא סיגנל שיחות | HYPER CORE TECH
  async function announceStatus(){
    if (!state.roomId || state.role !== 'broadcaster') return;
    const payload = {
      roomId: state.roomId,
      owner: App.publicKey,
      slug: state.slug || 'live',
      title: state.title || 'שידור חי',
      name: state.hostName || '',
      picture: state.hostPicture || '',
      alive: true,
      relays: Array.from(state.relays),
      direct: Array.from(state.directChildren)
    };
    try {
      if (typeof App.onLiveStatusUpdate === 'function') {
        App.onLiveStatusUpdate({
          roomId: state.roomId,
          direct: payload.direct.length,
          relays: payload.relays.length,
          viewersApprox: Math.max(1, payload.direct.length + payload.relays.length)
        });
      }
    } catch (_) {}
    // ללא #p — מטא בלבד; לא 25050 / לא 30078 | HYPER CORE TECH
    if(!App.pool || !App.publicKey || !App.privateKey) return;
    const ev = { kind: 25051, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [['type','live-status'], ['r', state.roomId]], content: JSON.stringify(payload) };
    const signed = App.finalizeEvent(ev, App.privateKey); await App.pool.publish(App.relayUrls, signed);
  }

  // האזנה לאירועי live — רק אירועים שמיועדים אלינו (#p) | HYPER CORE TECH
  async function onSignalEvent(ev){
    const typeTag = ev.tags.find(t=>t[0]==='type'); if(!typeTag) return; const type = typeTag[1];
    const rTag = ev.tags.find(t=>t[0]==='r'); if(!rTag || rTag[1] !== state.roomId) return;
    const pTag = ev.tags.find(t=>t[0]==='p');
    if (!pTag || normKey(pTag[1]) !== normKey(App.publicKey)) return;
    const from = ev.pubkey;
    if(type === 'live-status' || type === 'live-full'){ return; }
    let data = null; if(ev.content){ try{ const dec = await NT.nip04.decrypt(App.privateKey, from, ev.content); data = dec? JSON.parse(dec):null; }catch{} }
    switch(type){
      case 'live-join': if(state.role==='broadcaster' && normKey(from)!==normKey(App.publicKey)) await handleJoin(from); break;
      case 'live-invite': if(normKey(from)===normKey(state.broadcaster)){ await connectToParent((data && data.parent) || from); } break;
      case 'live-offer': {
        if(normKey(from)!==normKey(App.publicKey)){ await acceptChildOffer(from, data); }
        break;
      }
      case 'live-answer': if(normKey(from)===normKey(state.parentPeer)){ await setParentAnswer(from, data); } break;
      case 'live-candidates': await addCandidates(from, data); break;
    }
  }

  // הרשמה — סינון לפי נמען (#p) + חדר (#r) כדי שצופה לא יקבל invite של אחר | HYPER CORE TECH
  function subscribe(roomId){
    if(!App.pool || !App.publicKey){ setTimeout(()=>subscribe(roomId), 400); return; }
    try {
      if (signalSub) {
        if (typeof signalSub.close === 'function') signalSub.close();
        else if (typeof signalSub.unsub === 'function') signalSub.unsub();
      }
    } catch (_) {}
    const filters = [ {
      kinds: [LIVE_SIGNAL_KIND],
      '#p': [App.publicKey],
      '#r': [roomId],
      since: Math.floor(Date.now()/1000)-2
    } ];
    signalSub = App.pool.subscribeMany(App.relayUrls, filters, { onevent:onSignalEvent, oneose:()=>console.log('LIVE: ready', roomId) });
  }

  // חשיפה ל-App
  App.live = {
    // התחלת שידור: יוצר roomId, מתחיל מצלמה ומפרסם סטטוס (אובייקט או slug) | HYPER CORE TECH
    async start(slugOrOpts){
      state.ending = false;
      iceFailRetries = 0;
      connectingParent = null;
      const opts = (slugOrOpts && typeof slugOrOpts === 'object') ? slugOrOpts : { slug: slugOrOpts || 'live' };
      await startBroadcast(opts);
      subscribe(state.roomId);
      if(typeof App.onLiveStarted==='function') App.onLiveStarted(state.roomId);
    },
    // הצטרפות לצפייה: יבקש parent, יתחבר אליו
    async watch(ownerPubkey, slug){
      state.ending = false;
      iceFailRetries = 0;
      connectingParent = null;
      subscribe(getRoomId(ownerPubkey, slug));
      await joinLive(ownerPubkey, slug);
      if(typeof App.onLiveWatchStarted==='function') App.onLiveWatchStarted();
    },
    async retryWatch(){
      if (!state.broadcaster || state.role === 'broadcaster') return false;
      if (iceFailRetries >= 2) return false;
      iceFailRetries += 1;
      console.log('LIVE: retry watch', iceFailRetries, String(state.broadcaster).slice(0,8));
      connectingParent = null;
      state.parentPeer = null;
      state.pcMap.forEach((pc)=>{ try{pc.close();}catch{} });
      state.pcMap.clear();
      pendingRemoteIce.clear();
      state.incomingRemoteStream = null;
      await joinLive(state.broadcaster, 'live');
      return true;
    },
    // סיום
    async end(){
      state.ending = true;
      stopStatusHeartbeat();
      const endedRoom = state.roomId;
      const wasBroadcaster = state.role === 'broadcaster';
      // מודיעים לצופים שהשידור נגמר — לפני ניקוי החדר | HYPER CORE TECH
      if (wasBroadcaster && endedRoom && App.pool && App.publicKey && App.privateKey) {
        try {
          const payload = { roomId: endedRoom, ended: true, owner: App.publicKey };
          const ev = {
            kind: 25051,
            pubkey: App.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['type', 'live-end'], ['r', endedRoom]],
            content: JSON.stringify(payload)
          };
          const signed = App.finalizeEvent(ev, App.privateKey);
          await App.pool.publish(App.relayUrls, signed);
        } catch (_) {}
      }
      try {
        if (signalSub) {
          if (typeof signalSub.close === 'function') signalSub.close();
          else if (typeof signalSub.unsub === 'function') signalSub.unsub();
        }
      } catch (_) {}
      signalSub = null;
      connectingParent = null;
      iceFailRetries = 0;
      pendingRemoteIce.clear();
      state.pcMap.forEach((pc)=>{ try{pc.close();}catch{} });
      state.pcMap.clear();
      try{ state.localStream?.getTracks().forEach(t=>t.stop()); }catch{}
      try{ state.incomingRemoteStream?.getTracks().forEach(t=>t.stop()); }catch{}
      if(state.hiddenVideoEl){ try{state.hiddenVideoEl.remove();}catch{} state.hiddenVideoEl=null; }
      state.role=null; state.roomId=null; state.parentPeer=null; state.directChildren.clear(); state.relays.clear();
      state.slug='live'; state.title=''; state.hostName=''; state.hostPicture='';
      if(typeof App.onLiveEnded==='function') App.onLiveEnded({ roomId: endedRoom, wasBroadcaster });
    },
    getState(){ return { role:state.role, roomId:state.roomId, relays:Array.from(state.relays), direct:Array.from(state.directChildren) }; }
  };

  console.log('Live stream core initialized');
})(window);
