// חלק שידור חי (live-stream.js) – ליבה: שידור/צפייה מרובים מעל תשתית Nostr + WebRTC
// שייך: מודול לוגי מרכזי, תפקידים: 'broadcaster' (משדר), 'relay' (צופה-מגשר), 'viewer' (צופה)
// מגבלות: קוד עד 350 שורות, הערות ברורות, מינימום תלות בשרתים – שימוש ברשת הקיימת
(function initLiveStream(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const NT = window.NostrTools;

  // חלק הגדרות – Fanout קטן למשדר, שדרוג דרך רילייז (Tree Mesh)
  const MAX_DIRECT_CHILDREN = 3; // כמה צופים המשדר מחזיק ישירות
  const MAX_RELAY_CHILDREN = 4;  // כמה צופים ריליי יחיד מחזיק

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
    ending: false
  };

  // קונפיג ICE – משתמש בקיים (כולל TURN אם קיים)
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // עזר: roomId דטרמיניסטי
  function getRoomId(owner, slug){
    const a = (owner||'').toLowerCase(); const s = (slug||'').toLowerCase();
    return `${a}::live::${s}`;
  }

  // עזר: שליחת אותות דרך Nostr kind 25050
  async function sendSignal(to, type, data){
    if(!App.pool || !App.publicKey || !App.privateKey) return;
    const payload = data ? JSON.stringify(data) : '';
    const content = payload ? await NT.nip04.encrypt(App.privateKey, to, payload) : '';
    const ev = { kind: 25050, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [ ['type', type], ['p', to], ['r', state.roomId||''] ], content };
    const signed = App.finalizeEvent(ev, App.privateKey);
    await App.pool.publish(App.relayUrls, signed);
  }

  // יצירת RTCPeerConnection עבור peer מסוים
  function createPC(peer){
    const pc = new RTCPeerConnection(RTC_CONFIG);
    // הוספת מסלולים מקומיים אם קיימים
    if(state.localStream){ state.localStream.getTracks().forEach(t=>pc.addTrack(t, state.localStream)); }
    pc.onicecandidate = e => { queueCandidate(peer, e.candidate||null); };
    pc.ontrack = e => {
      // קבלת סטרים מרוחק כשאנחנו viewer/relay
      if(!state.incomingRemoteStream) state.incomingRemoteStream = new MediaStream();
      e.streams[0].getTracks().forEach(t=> state.incomingRemoteStream.addTrack(t));
      if(typeof App.onLiveRemoteStream === 'function') App.onLiveRemoteStream(state.incomingRemoteStream);
      // אם אנחנו relay – נכין captureStream מהווידאו החבוי ונוכל לשדר לילדים
      if(state.role !== 'broadcaster') ensureRelayCapture();
    };
    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState; console.log('LIVE PC', peer.slice(0,8), cs);
      if(['disconnected','failed','closed'].includes(cs)){ tryEndChild(peer); }
    };
    state.pcMap.set(peer, pc);
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

  // התחלת שידור – המשדר
  async function startBroadcast(slug){
    state.role = 'broadcaster'; state.broadcaster = App.publicKey; state.roomId = getRoomId(App.publicKey, slug||('room-'+Date.now()));
    state.relays.clear(); state.directChildren.clear();
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:true });
    if(typeof App.onLiveLocalStream === 'function') App.onLiveLocalStream(state.localStream);
    announceStatus();
    // פרסום 'live-post' כדי שהפיד יצייר פוסט צפייה
    try {
      if(App.pool && App.publicKey){
        const content = JSON.stringify({ roomId: state.roomId, owner: App.publicKey, slug });
        const ev = { kind: 25051, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [['type','live-post'], ['r', state.roomId]], content };
        const signed = App.finalizeEvent(ev, App.privateKey); await App.pool.publish(App.relayUrls, signed);
      }
    } catch {}
  }

  // הצטרפות לצפייה – קובע אם viewer או relay לפי עומס
  async function joinLive(roomOwner, slug){
    state.role = 'viewer'; state.broadcaster = roomOwner; state.roomId = getRoomId(roomOwner, slug);
    // נבקש מיפוי למקור: המשדר יענה ברשימת relays + ספירת ישירים
    await sendSignal(roomOwner, 'live-join', { roomId: state.roomId });
  }

  // המשדר: החלטה היכן לשכן צופה חדש
  async function handleJoin(peer){
    if(state.role !== 'broadcaster') return;
    // אם יש מקום ישיר – נחבר ישיר; אחרת נבחר ריליי זמין או נקדם את המצטרף לריליי
    if(state.directChildren.size < MAX_DIRECT_CHILDREN){
      await inviteDirect(peer);
    } else {
      const relay = pickRelayWithCapacity() || promoteToRelay(peer);
      await inviteViaRelay(peer, relay);
    }
    announceStatus();
  }

  // הזמנת חיבור ישיר למשדר
  async function inviteDirect(viewer){
    await sendSignal(viewer, 'live-invite', { parent: App.publicKey, role: 'viewer' });
  }

  function pickRelayWithCapacity(){
    for(const r of state.relays){ const count = countChildrenOf(r); if(count < MAX_RELAY_CHILDREN) return r; }
    return null;
  }
  function countChildrenOf(pubkey){ let n=0; state.pcMap.forEach((pc,k)=>{ if(k.startsWith(pubkey+':child:')) n++; }); return n; }

  // קידום צופה לריליי
  function promoteToRelay(pubkey){ state.relays.add(pubkey); return pubkey; }

  // הזמנה דרך ריליי
  async function inviteViaRelay(viewer, relay){ await sendSignal(viewer, 'live-invite', { parent: relay, role: 'viewer' }); }

  // התחברות ל-parent שנבחר
  async function connectToParent(parentPubkey){
    state.parentPeer = parentPubkey;
    const pc = createPC(parentPubkey);
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    await sendSignal(parentPubkey, 'live-offer', offer);
  }

  // parent מקבל offer מצופה/ילד
  async function acceptChildOffer(childPubkey, offer){
    const pc = createPC(childPubkey);
    await pc.setRemoteDescription(offer);
    if(state.role === 'broadcaster'){
      // למשדר יש סטרים מקומי מהמצלמה
      if(state.directChildren.size < MAX_DIRECT_CHILDREN){ state.directChildren.add(childPubkey); }
    } else {
      // אנחנו ריליי – ודא שיש לנו localStream מה-capture
      ensureRelayCapture();
    }
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    await sendSignal(childPubkey, 'live-answer', ans);
  }

  // קבלת תשובה מה-parent
  async function setParentAnswer(parent, answer){ const pc = state.pcMap.get(parent); if(pc) await pc.setRemoteDescription(answer); }

  // מועמדי ICE
  async function addCandidates(from, list){
    const pc = state.pcMap.get(from);
    if(pc && Array.isArray(list)){
      for(const c of list){
        try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch{}
      }
    }
  }

  // ניקוי ילד שהתנתק
  function tryEndChild(pubkey){
    if(state.pcMap.has(pubkey)){ try{ state.pcMap.get(pubkey).close(); }catch{} state.pcMap.delete(pubkey); }
    state.directChildren.delete(pubkey);
  }

  // הודעת סטטוס לצופים (רילייז קיימים, עומס)
  async function announceStatus(){
    const payload = { roomId: state.roomId, relays: Array.from(state.relays), direct: Array.from(state.directChildren) };
    // משודר לציבור – סוג כללי, ללא p ספציפי
    if(!App.pool || !App.publicKey) return;
    const ev = { kind: 25051, pubkey: App.publicKey, created_at: Math.floor(Date.now()/1000), tags: [['type','live-status'], ['r', state.roomId]], content: JSON.stringify(payload) };
    const signed = App.finalizeEvent(ev, App.privateKey); await App.pool.publish(App.relayUrls, signed);
  }

  // האזנה לאירועי live
  async function onSignalEvent(ev){
    const typeTag = ev.tags.find(t=>t[0]==='type'); if(!typeTag) return; const type = typeTag[1];
    const rTag = ev.tags.find(t=>t[0]==='r'); if(!rTag || rTag[1] !== state.roomId) return;
    const from = ev.pubkey;
    if(type === 'live-status'){ return; }
    let data = null; if(ev.content){ try{ const dec = await NT.nip04.decrypt(App.privateKey, from, ev.content); data = dec? JSON.parse(dec):null; }catch{} }
    switch(type){
      case 'live-join': if(state.role==='broadcaster' && from!==App.publicKey) await handleJoin(from); break;
      case 'live-invite': if(from===state.broadcaster){ await connectToParent(data.parent); } break;
      case 'live-offer': {
        // ההצעה נשלחת ל-parent המיועד (משדר או ריליי). לכן נקבל תמיד ונחזיר תשובה.
        if(from!==App.publicKey){ await acceptChildOffer(from, data); }
        break;
      }
      case 'live-answer': if(from===state.parentPeer){ await setParentAnswer(from, data); } break;
      case 'live-candidates': await addCandidates(from, data); break;
    }
  }

  // הרשמה
  function subscribe(roomId){
    if(!App.pool || !App.publicKey){ setTimeout(()=>subscribe(roomId), 400); return; }
    const filters = [ { kinds:[25050,25051], '#r':[roomId], since: Math.floor(Date.now()/1000)-2 } ];
    App.pool.subscribeMany(App.relayUrls, filters, { onevent:onSignalEvent, oneose:()=>console.log('LIVE: ready', roomId) });
  }

  // חשיפה ל-App
  App.live = {
    // התחלת שידור: יוצר roomId, מתחיל מצלמה ומפרסם סטטוס
    async start(slug){ await startBroadcast(slug||'live'); subscribe(state.roomId); if(typeof App.onLiveStarted==='function') App.onLiveStarted(state.roomId); },
    // הצטרפות לצפייה: יבקש parent, יתחבר אליו
    async watch(ownerPubkey, slug){ subscribe(getRoomId(ownerPubkey, slug)); await joinLive(ownerPubkey, slug); if(typeof App.onLiveWatchStarted==='function') App.onLiveWatchStarted(); },
    // סיום
    async end(){ state.ending = true; state.pcMap.forEach((pc)=>{ try{pc.close();}catch{} }); state.pcMap.clear(); try{ state.localStream?.getTracks().forEach(t=>t.stop()); }catch{} try{ state.incomingRemoteStream?.getTracks().forEach(t=>t.stop()); }catch{} if(state.hiddenVideoEl){ try{state.hiddenVideoEl.remove();}catch{} state.hiddenVideoEl=null; } state.role=null; state.roomId=null; state.parentPeer=null; state.directChildren.clear(); state.relays.clear(); if(typeof App.onLiveEnded==='function') App.onLiveEnded(); },
    getState(){ return { role:state.role, roomId:state.roomId, relays:Array.from(state.relays), direct:Array.from(state.directChildren) }; }
  };

  console.log('Live stream core initialized');
})(window);
