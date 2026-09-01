// חלק שידור חי (live-stream.js) – ליבה: שידור/צפייה מרובים מעל תשתית Nostr + WebRTC
// שייך: מודול לוגי מרכזי, תפקידים: 'broadcaster' (משדר), 'relay' (צופה-מגשר), 'viewer' (צופה)
// מגבלות: קוד עד 350 שורות, הערות ברורות, מינימום תלות בשרתים – שימוש ברשת הקיימת
(function initLiveStream(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const NT = window.NostrTools;

  // חלק הגדרות – עץ Live: משדר → עד 2 ישירים; עודפים דרך צופים-מגשרים | HYPER CORE TECH
  const MAX_DIRECT_CHILDREN = 2; // כמה צופים המשדר מחזיק ישירות
  const MAX_RELAY_CHILDREN = 1; // מגשר מובייל: ילד אחד ליציבות | HYPER CORE TECH // כמה ילדים כל מגשר מחזיק
  let nextRelayPick = 0; // round-robin לבחירת מגשר
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
    backupPeer: null,                // הורה גיבוי למעבר מהיר בנפילה | HYPER CORE TECH
    directChildren: new Set(),       // ילדים ישירים (כשהננו מקור)
    relays: new Set(),               // רשימת רילייז פומבית
    pcMap: new Map(),                // peerPubkey -> RTCPeerConnection
    localStream: null,               // וידאו+אודיו כשאנחנו משדרים (או captureStream במצב relay)
    incomingRemoteStream: null,      // סטרים לתצוגה בלבד (לא ל־relay)
    relayOutStream: null,            // סטרים נפרד לשליחה הלאה (clones) | HYPER CORE TECH
    hiddenVideoEl: null,             // וידאו חבוי ללכידת stream כשאנחנו relay
    ending: false,
    slug: 'live',
    title: '',
    hostName: '',
    hostPicture: ''
  };

  let statusHeartbeatTimer = null;
  const chatDcMap = new Map(); // peer -> RTCDataChannel (היסטוריית צ'אט ב־P2P) | HYPER CORE TECH

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
  let failoverWatchTimer = null; // אם גיבוי מת — קופצים למשדר | HYPER CORE TECH
  const FAILOVER_CONNECT_MS = 7000;
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

  // PC באמת חי עם מדיה — לא "connected" גוסס / connecting תקוע | HYPER CORE TECH
  function isPcHealthy(pc){
    if (!pc || !isPcAlive(pc)) return false;
    const cs = pc.connectionState;
    const ice = pc.iceConnectionState;
    if (cs !== 'connected') return false;
    return ice === 'connected' || ice === 'completed' || ice === 'checking';
  }

  function wireLiveChatDc(peer, dc){
    if (!peer || !dc) return;
    const peerKey = peer;
    chatDcMap.set(peerKey, dc);
    dc.onopen = () => {
      if (state.role !== 'broadcaster' || dc.readyState !== 'open') return;
      try {
        const messages = (typeof App.getLiveChatHistorySnapshot === 'function')
          ? (App.getLiveChatHistorySnapshot() || [])
          : [];
        if (!messages.length) return;
        dc.send(JSON.stringify({
          type: 'live-chat-history',
          roomId: state.roomId,
          messages
        }));
        console.log('LIVE: chat history sent via DC', String(peerKey).slice(0, 8), messages.length);
      } catch (err) {
        console.warn('LIVE: chat history send failed', err);
      }
    };
    dc.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data || ''));
        if (!data || data.type !== 'live-chat-history') return;
        if (typeof App.onLiveChatHistoryFromPeer === 'function') {
          App.onLiveChatHistoryFromPeer(data);
        }
      } catch (_) {}
    };
    dc.onclose = () => {
      try {
        if (chatDcMap.get(peerKey) === dc) chatDcMap.delete(peerKey);
      } catch (_) {}
    };
  }

  // יצירת RTCPeerConnection עבור peer מסוים
  function createPC(peer, opts){
    const peerKey = peer;
    const options = (opts && typeof opts === 'object') ? opts : {};
    const pc = new RTCPeerConnection(RTC_CONFIG);
    // outbound רק למשדר / ילד-מגשר — לא ל־PC של ההורה | HYPER CORE TECH
    const outbound = options.outboundStream
      || (state.role === 'broadcaster' ? state.localStream : null);
    if (outbound) {
      outbound.getTracks().forEach((t) => pc.addTrack(t, outbound));
    }
    pc.onicecandidate = e => { queueCandidate(peerKey, e.candidate||null); };
    // משדר מקבל DC מהצופה — שולח היסטוריית צ'אט ב־P2P (לא ריליי) | HYPER CORE TECH
    pc.ondatachannel = (e) => {
      const ch = e && e.channel;
      if (!ch || ch.label !== 'sos-live-chat') return;
      wireLiveChatDc(peerKey, ch);
    };
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
      // לא בונים relay-out בכל ontrack — רק כשמקבלים ילד | HYPER CORE TECH
    };
    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState; console.log('LIVE PC', String(peerKey).slice(0,8), cs);
      if (cs === 'connected') {
        iceFailRetries = 0;
        connectingParent = null;
        if (normKey(peerKey) === normKey(state.parentPeer)) {
          state._failoverTries = 0;
          clearFailoverWatch();
          console.log('LIVE parent stable', String(peerKey).slice(0, 8), 'backup', String(state.backupPeer || '').slice(0, 8));
        }
        return;
      }
      // failed/closed — ניקוי מיידי; disconnected — שחרור מקום אצל משדר/מגשר | HYPER CORE TECH
      if (cs === 'failed' || cs === 'closed') {
        const wasParent = normKey(peerKey) === normKey(state.parentPeer);
        tryEndChild(peerKey);
        if (!state.ending && state.role !== 'broadcaster' && wasParent) {
          failoverFromParent(peerKey).catch(() => {});
        }
      } else if (cs === 'disconnected') {
        setTimeout(() => {
          try {
            const pc2 = getPc(peerKey);
            if (!pc2 || state.ending) return;
            const cs2 = pc2.connectionState;
            if (cs2 === 'connected' || cs2 === 'connecting') return;
            // משדר/מגשר: משחררים סלוט כדי שצופה 3 יוכל live-join | HYPER CORE TECH
            if (state.role === 'broadcaster' || state.role === 'relay') {
              console.log('LIVE child disconnect prune', String(peerKey).slice(0, 8), cs2);
              tryEndChild(peerKey);
              try { announceStatus(); } catch (_) {}
              return;
            }
            if (cs2 === 'disconnected' && normKey(peerKey) === normKey(state.parentPeer)) {
              failoverFromParent(peerKey).catch(() => {});
            }
          } catch (_) {}
        }, 2500);
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

  // Relay out נפרד מהתצוגה — clones בלבד, בלי לגעת ב־PC של ההורה | HYPER CORE TECH
  function prepareRelayOutStream(){
    if (state.role === 'broadcaster') return state.localStream;
    if (state.relayOutStream) {
      const live = state.relayOutStream.getTracks().filter((t) => t.readyState === 'live');
      if (live.length) return state.relayOutStream;
    }
    if (!state.incomingRemoteStream || !state.incomingRemoteStream.getTracks().length) return null;
    const out = new MediaStream();
    state.incomingRemoteStream.getTracks().forEach((t) => {
      try {
        out.addTrack(t.clone());
      } catch (_) {
        try { out.addTrack(t); } catch (__) {}
      }
    });
    if (!out.getTracks().length) return null;
    state.relayOutStream = out;
    console.log('LIVE relay-out ready', out.getTracks().map((t) => t.kind + ':' + t.readyState).join(','));
    return out;
  }

  // תאימות לשם הישן — לא מוסיפים tracks להורה | HYPER CORE TECH
  function ensureRelayCapture(){
    return prepareRelayOutStream();
  }

  // בחירת מגשר מבין הילדים הישירים המחוברים (round-robin) | HYPER CORE TECH
  function pickRelayParent(){
    const candidates = [];
    for (const pk of state.directChildren) {
      const pc = getPc(pk);
      // רק מגשר healthy — לא connecting גוסס | HYPER CORE TECH
      if (pc && isPcHealthy(pc)) {
        candidates.push(pk);
      }
    }
    if (!candidates.length) return null;
    const pick = candidates[nextRelayPick % candidates.length];
    nextRelayPick += 1;
    return pick;
  }


  // בחירת גיבוי: שכן ישיר אחר, אחרת המשדר | HYPER CORE TECH
  function pickBackupPeer(primaryParent){
    const primary = normKey(primaryParent);
    for (const pk of state.directChildren) {
      if (normKey(pk) === primary) continue;
      const pc = getPc(pk);
      if (pc && isPcAlive(pc) && pc.connectionState === 'connected') return pk;
    }
    return App.publicKey;
  }

  // הודיעו לילדים שההורה (אנחנו) נעלם — שיעברו לגיבוי | HYPER CORE TECH
  async function notifyChildrenParentGone(){
    const kids = Array.from(state.directChildren);
    for (const child of kids) {
      try {
        await sendSignal(child, 'live-parent-gone', {
          from: App.publicKey,
          backup: state.broadcaster || App.publicKey
        });
      } catch (_) {}
    }
  }

  function clearFailoverWatch(){
    if (failoverWatchTimer) {
      try { clearTimeout(failoverWatchTimer); } catch (_) {}
      failoverWatchTimer = null;
    }
  }

  // ניקוי וידאו מת — מונע מסך שחור עם tracks ended | HYPER CORE TECH
  function clearIncomingVideo(){
    try {
      state.incomingRemoteStream?.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    } catch (_) {}
    state.incomingRemoteStream = null;
    try {
      state.relayOutStream?.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
    } catch (_) {}
    state.relayOutStream = null;
    try {
      const media = App._p2pLiveActiveMedia;
      const videoEl = media && media.querySelector('video');
      if (videoEl) videoEl.srcObject = null;
    } catch (_) {}
  }

  // אם אין connected תוך X — קופצים למשדר (גיבוי מת) | HYPER CORE TECH
  function armFailoverWatch(expectedParent){
    clearFailoverWatch();
    const hint = String(expectedParent || '').slice(0, 8);
    failoverWatchTimer = setTimeout(() => {
      failoverWatchTimer = null;
      try {
        if (state.ending || state.role === 'broadcaster') return;
        const parent = state.parentPeer;
        const pc = parent ? getPc(parent) : null;
        if (pc && isPcAlive(pc) && pc.connectionState === 'connected') return;
        console.warn('LIVE failover timeout', hint || String(parent || '').slice(0, 8), pc && pc.connectionState);
        state.backupPeer = state.broadcaster;
        failoverFromParent(parent || expectedParent).catch(() => {});
      } catch (_) {}
    }, FAILOVER_CONNECT_MS);
  }

  async function requestBroadcasterRejoin(){
    if (!state.broadcaster) return;
    state.backupPeer = state.broadcaster;
    clearFailoverWatch();
    console.log('LIVE rejoin broadcaster', String(state.broadcaster).slice(0, 8));
    await sendSignal(state.broadcaster, 'live-join', { roomId: state.roomId, failover: true });
  }

  // מעבר אוטומטי להורה גיבוי / משדר כשההורה הפעיל נופל | HYPER CORE TECH
  async function failoverFromParent(failedParent){
    if (state.ending || state.role === 'broadcaster') return;
    if (state._failoverBusy) return;
    if ((state._failoverTries || 0) >= 4) {
      console.warn('LIVE failover gave up');
      try {
        if (typeof App.onLiveIceFailed === 'function') App.onLiveIceFailed(state.roomId, state.broadcaster);
        else if (typeof App.onLiveStreamLost === 'function') App.onLiveStreamLost(state.roomId);
      } catch (_) {}
      return;
    }
    state._failoverBusy = true;
    state._failoverTries = (state._failoverTries || 0) + 1;
    const failed = normKey(failedParent || state.parentPeer);
    console.log('LIVE failover from', String(failedParent || '').slice(0, 8), 'try', state._failoverTries);
    try {
      clearFailoverWatch();
      clearIncomingVideo();
      // סגירת PC של ההורה שנפל (בלי למחוק ילדים שלנו עדיין)
      const pKey = findPcKey(failedParent || state.parentPeer);
      if (pKey) {
        try { state.pcMap.get(pKey)?.close(); } catch (_) {}
        state.pcMap.delete(pKey);
      }
      state.parentPeer = null;
      connectingParent = null;

      // אם היינו מגשר — הילדים צריכים גם לעבור
      if (state.role === 'relay' && state.directChildren.size) {
        await notifyChildrenParentGone();
        state.directChildren.clear();
        state.role = 'viewer';
      }

      let next = state.backupPeer;
      if (!next || normKey(next) === failed) next = state.broadcaster;
      // ניסיון 2+ — live-join למשדר (לא offer ישיר; משחרר מקום מילדים מתים) | HYPER CORE TECH
      if (state._failoverTries >= 2 || !next || normKey(next) === normKey(App.publicKey)) {
        await requestBroadcasterRejoin();
        armFailoverWatch(state.broadcaster);
        return;
      }
      if (normKey(next) === failed) {
        await requestBroadcasterRejoin();
        armFailoverWatch(state.broadcaster);
        return;
      }

      // אחרי קפיצה — גיבוי אולטימטיבי הוא המשדר
      state.backupPeer = state.broadcaster || next;
      // אם היעד הוא המשדר — live-join אחרי prune עדיף על offer ישיר | HYPER CORE TECH
      if (state.broadcaster && normKey(next) === normKey(state.broadcaster)) {
        console.log('LIVE failover → broadcaster via live-join', String(next).slice(0, 8));
        await requestBroadcasterRejoin();
        armFailoverWatch(state.broadcaster);
        return;
      }
      console.log('LIVE failover connect →', String(next).slice(0, 8), 'backup', String(state.backupPeer || '').slice(0, 8));
      await connectToParent(next);
      // אם next הוא לא המשדר — שעון קצר; timeout → ניסיון 2 למשדר | HYPER CORE TECH
      armFailoverWatch(next);
    } catch (err) {
      console.warn('LIVE failover failed', err);
      try { await requestBroadcasterRejoin(); } catch (_) {}
    } finally {
      state._failoverBusy = false;
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
    state.role = 'viewer'; state._fullRetries = 0; state._failoverTries = 0; state.backupPeer = roomOwner; state.broadcaster = roomOwner; state.roomId = getRoomId(roomOwner, slug);
    // נבקש מיפוי למקור: המשדר יענה ברשימת relays + ספירת ישירים
    await sendSignal(roomOwner, 'live-join', { roomId: state.roomId });
  }

  // המשדר: אחרי prune — מקום פנוי / failover מקבלים invite ישיר | HYPER CORE TECH
  async function handleJoin(peer, data){
    if(state.role !== 'broadcaster') return;
    const peerKey = normKey(peer);
    if (!peerKey || peerKey === normKey(App.publicKey)) return;
    pruneStaleChildren();
    const isFailover = !!(data && (data.failover || data.retry));

    const existingPc = getPc(peer);
    // רק PC בריא באמת — לא מתעלמים מ־join כשה־PC גוסס (מרוץ מהלוגים) | HYPER CORE TECH
    if (!isFailover && existingPc && isPcHealthy(existingPc)) {
      console.log('LIVE: join ignored, already connected', peerKey.slice(0,8), existingPc.connectionState);
      return;
    }
    if (existingPc && !isPcHealthy(existingPc)) {
      console.log('LIVE: join replaces unhealthy PC', peerKey.slice(0,8), existingPc.connectionState);
      tryEndChild(peer);
    }

    let alreadyChild = false;
    for (const c of state.directChildren) {
      if (normKey(c) === peerKey) { alreadyChild = true; break; }
    }

    if (state.directChildren.size < MAX_DIRECT_CHILDREN || alreadyChild) {
      console.log('LIVE: invite direct', peerKey.slice(0, 8), isFailover ? 'failover' : 'join');
      await inviteDirect(peer);
    } else {
      // מלא — מנתבים למגשר חי בלבד; ב־failover בלי מגשר חי → full כדי שהצופה ינסה שוב | HYPER CORE TECH
      const relayParent = pickRelayParent();
      if (relayParent && !isFailover) {
        console.log('LIVE: redirect join via relay', String(relayParent).slice(0, 8), 'for', peerKey.slice(0, 8));
        state.relays.add(relayParent);
        // גיבוי תמיד המשדר — לא אח שעלול ליפול יחד | HYPER CORE TECH
        await sendSignal(peer, 'live-invite', { parent: relayParent, backup: App.publicKey, role: 'viewer' });
      } else if (relayParent && isFailover) {
        // failover: עדיף ישיר אם אפשר; אחרת מגשר עם backup=משדר
        console.log('LIVE: failover still full, relay', String(relayParent).slice(0, 8), 'for', peerKey.slice(0, 8));
        await sendSignal(peer, 'live-invite', { parent: relayParent, backup: App.publicKey, role: 'viewer' });
      } else {
        console.warn('LIVE: no relay parent ready, room full', MAX_DIRECT_CHILDREN);
        try { await sendSignal(peer, 'live-full', { max: MAX_DIRECT_CHILDREN }); } catch (_) {}
      }
    }
    announceStatus();
  }

  // הזמנת חיבור ישיר למשדר
  async function inviteDirect(viewer){
    const backup = pickBackupPeer(App.publicKey);
    await sendSignal(viewer, 'live-invite', { parent: App.publicKey, backup: backup, role: 'viewer' });
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
        console.log('LIVE: skip reconnect, PC state', String(parent).slice(0,8), cs);
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
    console.log('LIVE connectToParent', String(parent).slice(0, 8));
    const pc = createPC(parent);
    // צופה פותח DC להיסטוריית צ'אט מהמשדר (אחרי חיבור) | HYPER CORE TECH
    try {
      const dc = pc.createDataChannel('sos-live-chat');
      wireLiveChatDc(parent, dc);
    } catch (_) {}
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
    // מכסה לפני יצירת PC — כולל disconnected | HYPER CORE TECH
    if (state.role === 'broadcaster' || state.role === 'relay') pruneStaleChildren();
    let found = false;
    for (const c of state.directChildren) {
      if (normKey(c) === normKey(childPubkey)) { found = true; break; }
    }
    const existingEarly = getPc(childPubkey);
    if (existingEarly && !isPcHealthy(existingEarly)) {
      console.log('LIVE: offer replaces unhealthy child PC', String(childPubkey).slice(0,8), existingEarly.connectionState);
      tryEndChild(childPubkey);
      found = false;
    }
    const maxKids = state.role === 'broadcaster' ? MAX_DIRECT_CHILDREN : MAX_RELAY_CHILDREN;
    if (!found && state.directChildren.size >= maxKids) {
      pruneStaleChildren();
    }
    if (!found && state.directChildren.size >= maxKids) {
      console.warn('LIVE: relay/broadcaster full, reject child', String(childPubkey).slice(0, 8));
      try { await sendSignal(childPubkey, 'live-full', { max: maxKids }); } catch (_) {}
      return;
    }

    let outbound = null;
    if (state.role === 'broadcaster') {
      outbound = state.localStream;
    } else {
      outbound = prepareRelayOutStream();
      if (!outbound) {
        console.warn('LIVE: relay-out not ready, reject child', String(childPubkey).slice(0, 8));
        try { await sendSignal(childPubkey, 'live-full', { max: 0 }); } catch (_) {}
        return;
      }
      state.role = 'relay';
      console.log('LIVE parent PC untouched', String(state.parentPeer || '').slice(0, 8));
    }

    const existing = getPc(childPubkey);
    if (existing && isPcHealthy(existing)) {
      console.log('LIVE: ignore duplicate offer', String(childPubkey).slice(0,8), existing.connectionState);
      return;
    }
    if (existing && isPcAlive(existing)) {
      const cs = existing.connectionState;
      if (cs === 'connecting' && existing.remoteDescription) {
        console.log('LIVE: ignore offer, negotiation in progress', String(childPubkey).slice(0,8));
        return;
      }
    }
    if (existing) {
      try { existing.close(); } catch (_) {}
      const oldKey = findPcKey(childPubkey);
      if (oldKey) state.pcMap.delete(oldKey);
    }

    const pc = createPC(childPubkey, { outboundStream: outbound });
    console.log('LIVE child accepted', String(childPubkey).slice(0, 8), 'via', state.role);
    await pc.setRemoteDescription(offer);
    const early = pendingRemoteIce.get(childPubkey) || pendingRemoteIce.get(normKey(childPubkey)) || [];
    pendingRemoteIce.delete(childPubkey);
    pendingRemoteIce.delete(normKey(childPubkey));
    for (const c of early) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    if (!found) state.directChildren.add(childPubkey);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
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
    try {
      const dcKey = chatDcMap.has(pubkey) ? pubkey : findPcKey(pubkey);
      if (dcKey && chatDcMap.has(dcKey)) {
        try { chatDcMap.get(dcKey).close(); } catch (_) {}
        chatDcMap.delete(dcKey);
      }
      for (const k of Array.from(chatDcMap.keys())) {
        if (normKey(k) === normKey(pubkey)) {
          try { chatDcMap.get(k).close(); } catch (_) {}
          chatDcMap.delete(k);
        }
      }
    } catch (_) {}
    const want = normKey(pubkey);
    for (const c of Array.from(state.directChildren)) {
      if (normKey(c) === want) state.directChildren.delete(c);
    }
  }

  // משחרר מקומות של ילדים מתים לפני invite חדש | HYPER CORE TECH
  function pruneStaleChildren(){
    for (const c of Array.from(state.directChildren)) {
      const pc = getPc(c);
      if (!pc || !isPcAlive(pc) || pc.connectionState === 'disconnected') {
        console.log('LIVE prune stale child', String(c).slice(0, 8), pc && pc.connectionState);
        tryEndChild(c);
      }
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
    if(type === 'live-status'){ return; }
    if(type === 'live-full'){
      // מגשר מלא / אין מקום — מבקשים מהמשדר הורה אחר | HYPER CORE TECH
      if (state.role !== 'broadcaster' && state.broadcaster && (state._fullRetries || 0) < 2) {
        state._fullRetries = (state._fullRetries || 0) + 1;
        try { await sendSignal(state.broadcaster, 'live-join', { roomId: state.roomId, retry: true }); } catch (_) {}
      }
      return;
    }
    let data = null; if(ev.content){ try{ const dec = await NT.nip04.decrypt(App.privateKey, from, ev.content); data = dec? JSON.parse(dec):null; }catch{} }
    switch(type){
      case 'live-join': if(state.role==='broadcaster' && normKey(from)!==normKey(App.publicKey)) await handleJoin(from, data); break;
      case 'live-invite': if(normKey(from)===normKey(state.broadcaster) || (data && data.parent)){
        if (data && data.backup) state.backupPeer = data.backup;
        else state.backupPeer = state.broadcaster || from;
        state._failoverTries = 0;
        clearFailoverWatch();
        console.log('LIVE invite parent', String((data && data.parent) || from).slice(0,8), 'backup', String(state.backupPeer||'').slice(0,8));
        await connectToParent((data && data.parent) || from);
        armFailoverWatch((data && data.parent) || from);
      } break;
      case 'live-offer': {
        if(normKey(from)!==normKey(App.publicKey)){ await acceptChildOffer(from, data); }
        break;
      }
      case 'live-answer': if(normKey(from)===normKey(state.parentPeer)){ await setParentAnswer(from, data); } break;
      case 'live-candidates': await addCandidates(from, data); break;
      case 'live-parent-gone':
        if (normKey(from) === normKey(state.parentPeer)) {
          if (data && data.backup) state.backupPeer = data.backup;
          await failoverFromParent(from);
        }
        break;
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
      try {
        chatDcMap.forEach((dc) => { try { dc.close(); } catch (_) {} });
        chatDcMap.clear();
      } catch (_) {}
      pendingRemoteIce.clear();
      state.incomingRemoteStream = null;
      await joinLive(state.broadcaster, 'live');
      return true;
    },
    // סיום
    async end(){
      state.ending = true;
      clearFailoverWatch();
      if (state.role === 'relay' && state.directChildren.size) {
        try { await notifyChildrenParentGone(); } catch (_) {}
      }
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
      try {
        chatDcMap.forEach((dc) => { try { dc.close(); } catch (_) {} });
        chatDcMap.clear();
      } catch (_) {}
      state.pcMap.forEach((pc)=>{ try{pc.close();}catch{} });
      state.pcMap.clear();
      try{ state.localStream?.getTracks().forEach(t=>t.stop()); }catch{}
      try{ state.incomingRemoteStream?.getTracks().forEach(t=>t.stop()); }catch{}
      try{ state.relayOutStream?.getTracks().forEach(t=>{ try{t.stop();}catch(_){} }); }catch{}
      state.relayOutStream = null;
      if(state.hiddenVideoEl){ try{state.hiddenVideoEl.remove();}catch{} state.hiddenVideoEl=null; }
      state.role=null; state.roomId=null; state.parentPeer=null; state.backupPeer=null; state.directChildren.clear(); state.relays.clear();
      state.slug='live'; state.title=''; state.hostName=''; state.hostPicture='';
      if(typeof App.onLiveEnded==='function') App.onLiveEnded({ roomId: endedRoom, wasBroadcaster });
    },
    getState(){ return { role:state.role, roomId:state.roomId, parent:state.parentPeer, backup:state.backupPeer, relays:Array.from(state.relays), direct:Array.from(state.directChildren) }; }
  };

  console.log('Live stream core initialized');
})(window);
