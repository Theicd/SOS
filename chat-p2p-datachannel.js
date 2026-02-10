// חלק DataChannel P2P (chat-p2p-datachannel.js) – WebRTC DataChannel להודעות טקסט P2P
// signaling דרך ריליי (kind 25055), אח"כ הכל P2P | HYPER CORE TECH
(function initChatP2PDataChannel(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const NostrTools = window.NostrTools;

  // חלק הגדרות (chat-p2p-datachannel.js) – קונפיגורציה | HYPER CORE TECH
  const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  const SIG_KIND = 25055;
  const DC_LABEL = 'sos-chat';
  const ICE_BATCH_MS = 800;
  const RECONN_MS = 5000;
  const MAX_RECONN = 3;
  const OFFER_RETRY_MS = 12000; // retry offer אם לא נענה תוך 12 שניות (סיגנלינג דרך ריליי איטי)
  const MAX_OFFER_RETRY = 4;
  const SIG_SINCE_SEC = 3600; // חלון since - שעה (סובלני להיסט זמן בין מכשירים)
  const SIG_MAX_AGE_SEC = 3600; // התעלם מסיגנלים ישנים מ-שעה (מכסה היסט זמן משמעותי)

  // חלק מצב (chat-p2p-datachannel.js) – per-peer connections | HYPER CORE TECH
  const peers = new Map();
  let sigSub = null, keepTimer = null, lastSigAt = 0;
  let subReady = false; // האם ה-subscription פעיל וקיבל eose

  // חלק מצב (chat-p2p-datachannel.js) – remoteCandsBuf: באפר ICE, gotAnswer: התקבלה תשובה, offerId/lastOfferId למניעת תשובות ישנות | HYPER CORE TECH
  function newPS() { return { pc:null, dc:null, status:'idle', iceQ:[], iceT:null, reconnT:null, reconnN:0, init:false, seen:new Set(), offerRetryT:null, offerRetryN:0, remoteCandsBuf:[], gotAnswer:false, lastOfferAt:0, offerId:null, lastOfferId:null }; }
  function getPS(k) { return peers.get(k.toLowerCase())||null; }
  function ensPS(k) { k=k.toLowerCase(); if(!peers.has(k)) peers.set(k,newPS()); return peers.get(k); }

  // חלק תפקידים (chat-p2p-datachannel.js) – pubkey נמוך = initiator (שולח offers), גבוה = responder (רק עונה) | HYPER CORE TECH
  function amInitiator(peer) { return (App.publicKey||'').toLowerCase() < peer.toLowerCase(); }

  // חלק ניקוי (chat-p2p-datachannel.js) – סגירת חיבור | HYPER CORE TECH
  function cleanup(k) {
    k=k.toLowerCase(); const s=peers.get(k); if(!s) return;
    if(s.iceT) clearTimeout(s.iceT); if(s.reconnT) clearTimeout(s.reconnT); if(s.offerRetryT) clearTimeout(s.offerRetryT);
    try{if(s.dc)s.dc.close();}catch{} try{if(s.pc)s.pc.close();}catch{}
    s.pc=null; s.dc=null; s.status='closed'; s.iceQ=[]; s.offerRetryT=null; s.gotAnswer=false; s.lastOfferAt=0; s.remoteCandsBuf=[]; s.offerId=null; s.lastOfferId=null;
  }

  // חלק signaling (chat-p2p-datachannel.js) – שליחת אותות דרך ריליי | HYPER CORE TECH
  function roomId(p) { const a=(App.publicKey||'').toLowerCase(),b=(p||'').toLowerCase(); return a<b?`dc:${a}:${b}`:`dc:${b}:${a}`; }

  async function sendSig(p, type, data) {
    if(!App.pool||!App.publicKey||!App.privateKey) return;
    try {
      const raw=data?JSON.stringify(data):'';
      const enc=raw?await NostrTools.nip04.encrypt(App.privateKey,p,raw):'';
      const ev={kind:SIG_KIND,pubkey:App.publicKey,created_at:Math.floor(Date.now()/1000),tags:[['type',type],['p',p.toLowerCase()],['r',roomId(p)]],content:enc};
      const signed=App.finalizeEvent(ev,App.privateKey);
      await new Promise(r=>setTimeout(r,80));
      const pub=App.pool.publish(App.relayUrls,signed);
      if(Array.isArray(pub)) Promise.allSettled(pub).catch(()=>{});
      console.log(`[DC] sent ${type} → ${p.slice(0,8)}`);
    } catch(e){ console.warn('[DC] sendSig:',e); }
  }

  // חלק ICE batch (chat-p2p-datachannel.js) – צבירת candidates | HYPER CORE TECH
  function flushICE(k){ const s=ensPS(k); const b=s.iceQ.splice(0); if(b.length) sendSig(k,'dc-candidates',b); if(s.iceT){clearTimeout(s.iceT);s.iceT=null;} }
  function qICE(k,c){ const s=ensPS(k); if(!c){flushICE(k);return;} s.iceQ.push(c); if(s.iceT)clearTimeout(s.iceT); s.iceT=setTimeout(()=>flushICE(k),ICE_BATCH_MS); }

  // חלק DataChannel (chat-p2p-datachannel.js) – חיבור אירועים לערוץ + בדיקת stale למניעת לולאת reconnect | HYPER CORE TECH
  function wireDC(k,dc) {
    k=k.toLowerCase(); const s=ensPS(k); s.dc=dc;
    dc.onopen=()=>{ if(s.dc!==dc) return; s.status='connected'; s.reconnN=0; s.offerRetryN=0; if(s.offerRetryT){clearTimeout(s.offerRetryT);s.offerRetryT=null;} console.log(`[DC] ✅ OPEN ${k.slice(0,8)}`); if(typeof App.onDataChannelStateChange==='function') App.onDataChannelStateChange(k,'open'); };
    dc.onclose=()=>{ if(s.dc!==dc) return; s.dc=null; s.status='closed'; console.log(`[DC] ❌ CLOSED ${k.slice(0,8)}`); if(typeof App.onDataChannelStateChange==='function') App.onDataChannelStateChange(k,'closed'); maybeReconn(k); };
    dc.onerror=(e)=>{ if(s.dc!==dc) return; console.warn(`[DC] ERR ${k.slice(0,8)}:`,e); };
    dc.onmessage=(ev)=>onMsg(k,ev.data);
  }

  // חלק PeerConnection (chat-p2p-datachannel.js) – יצירת RTCPeerConnection + בדיקת stale למניעת לולאת reconnect | HYPER CORE TECH
  function createPC(k) {
    k=k.toLowerCase(); const s=ensPS(k); if(s.pc) try{s.pc.close();}catch{}
    const pc=new RTCPeerConnection(RTC_CFG); s.pc=pc; s.status='connecting';
    pc.onicecandidate=(ev)=>{ if(s.pc!==pc) return; qICE(k,ev.candidate||null); };
    pc.ondatachannel=(ev)=>{ if(s.pc!==pc) return; console.log(`[DC] 📥 remote DC ${k.slice(0,8)}`); wireDC(k,ev.channel); };
    pc.oniceconnectionstatechange=()=>{ if(s.pc!==pc) return; if(['disconnected','failed','closed'].includes(pc.iceConnectionState)){cleanup(k);maybeReconn(k);} };
    pc.onconnectionstatechange=()=>{ if(s.pc!==pc) return; if(['disconnected','failed','closed'].includes(pc.connectionState)){cleanup(k);maybeReconn(k);} };
    return pc;
  }

  // חלק חיבור (chat-p2p-datachannel.js) – רק initiator שולח offers, responder ממתין ל-offer נכנס | HYPER CORE TECH
  async function connect(peer) {
    const k=peer.toLowerCase();
    if(!App.pool||!App.publicKey||!App.privateKey) return;
    const ex=getPS(k); if(ex&&(ex.status==='connected'||ex.status==='connecting'||ex.status==='waiting')) return;
    if(!amInitiator(k)){ const s=ensPS(k); s.status='waiting'; console.log(`[DC] אני responder, ממתין ל-offer מ ${k.slice(0,8)}`); return; }
    // וידוא שה-subscription פעיל לפני שליחת offer (ממתין עד 3 שניות)
    if(!subReady){
      for(let i=0;i<15;i++){await new Promise(r=>setTimeout(r,200));if(subReady) break;}
      if(!subReady) console.warn('[DC] sub not ready, connecting anyway');
    }
    await _sendOffer(k);
  }

  // חלק offer פנימי (chat-p2p-datachannel.js) – שליחת offer עם timer ל-retry | HYPER CORE TECH
  async function _sendOffer(k) {
    const s=ensPS(k); s.init=true; s.status='connecting'; s.gotAnswer=false;
    if(s.offerRetryT){clearTimeout(s.offerRetryT);s.offerRetryT=null;}
    // חלק ניתוק PC+DC ישן (chat-p2p-datachannel.js) – מנתק handlers לפני סגירה למנוע stale callbacks | HYPER CORE TECH
    if(s.dc){s.dc.onopen=null;s.dc.onclose=null;s.dc.onerror=null;s.dc.onmessage=null;}
    if(s.pc){s.pc.onconnectionstatechange=null;s.pc.oniceconnectionstatechange=null;s.pc.ondatachannel=null;try{s.pc.close();}catch{}}
    const pc=createPC(k); const dc=pc.createDataChannel(DC_LABEL,{ordered:true}); wireDC(k,dc);
    const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
    s.offerId=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    // חלק offerId (chat-p2p-datachannel.js) – מזהה ייחודי לשיוך answer/offer | HYPER CORE TECH
    await sendSig(k,'dc-offer',{type:offer.type,sdp:offer.sdp,oid:s.offerId});
    console.log(`[DC] 🔄 connecting ${k.slice(0,8)} (attempt ${s.offerRetryN+1})...`);
    // retry timer – אם לא התחבר תוך 8 שניות, שלח offer מחדש
    s.offerRetryT=setTimeout(()=>{
      s.offerRetryT=null;
      if(s.status==='connected'||s.gotAnswer) return;
      s.offerRetryN++;
      if(s.offerRetryN>=MAX_OFFER_RETRY){console.warn(`[DC] ❌ gave up on ${k.slice(0,8)} after ${MAX_OFFER_RETRY} retries`);s.status='idle';return;}
      console.log(`[DC] 🔁 retry offer ${k.slice(0,8)} (#${s.offerRetryN})`);
      _sendOffer(k);
    },OFFER_RETRY_MS);
  }

  // חלק offer נכנס (chat-p2p-datachannel.js) – רק responder מטפל ב-offers (אין עוד glare) | HYPER CORE TECH
  async function onOffer(peer,offer) {
    const k=peer.toLowerCase(), s=ensPS(k);
    if(s.status==='connected'&&s.dc&&s.dc.readyState==='open') return;
    if(amInitiator(k)) return; // אני initiator, לא עונה ל-offers
    // חלק סינון offers כפולים (chat-p2p-datachannel.js) – אם יש כבר חיבור/הצעה טרייה, מתעלם | HYPER CORE TECH
    const now=Date.now();
    if(s.status==='connecting'&&s.lastOfferAt&&(now-s.lastOfferAt)<8000) return;
    s.lastOfferAt=now;
    const oid=offer?.oid||offer?._oid||null;
    if(oid&&s.lastOfferId===oid) return; // כבר ענינו ל-offer הזה
    s.lastOfferId=oid||s.lastOfferId;
    // ניקוי PC+DC קודם ללא להפעיל maybeReconn
    if(s.dc){s.dc.onopen=null;s.dc.onclose=null;s.dc.onerror=null;s.dc.onmessage=null;}
    if(s.pc){s.pc.onconnectionstatechange=null;s.pc.oniceconnectionstatechange=null;try{s.pc.close();}catch{}}
    s.init=false; s.remoteCandsBuf=[]; const pc=createPC(k);
    await pc.setRemoteDescription({type:offer.type,sdp:offer.sdp});
    await flushRemoteCands(k);
    const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
    await sendSig(k,'dc-answer',{type:ans.type,sdp:ans.sdp,oid:oid});
    console.log(`[DC] 📨 answered offer from ${k.slice(0,8)}`);
  }

  async function onAnswer(peer,ans) {
    if(!amInitiator(peer)) return; // responder לא אמור לקבל answers
    const s=getPS(peer.toLowerCase()); if(!s||!s.pc) return;
    const oid=ans?.oid||ans?._oid||null;
    if(s.offerId&&oid&&oid!==s.offerId){ console.log(`[DC] ↩️ ignore stale answer ${peer.slice(0,8)}`); return; }
    s.gotAnswer=true; if(s.offerRetryT){clearTimeout(s.offerRetryT);s.offerRetryT=null;}
    console.log(`[DC] 📬 got answer from ${peer.slice(0,8)}`);
    await s.pc.setRemoteDescription({type:ans.type,sdp:ans.sdp});
    await flushRemoteCands(peer.toLowerCase()); // החלת candidates שהגיעו לפני ה-answer
  }

  // חלק ICE נכנס (chat-p2p-datachannel.js) – אם אין remote description, שומר בבאפר ומחיל אחרי setRemoteDescription | HYPER CORE TECH
  async function onCands(peer,cands) {
    const s=getPS(peer.toLowerCase()); if(!s||!s.pc) return;
    if(!s.pc.remoteDescription) { s.remoteCandsBuf.push(...cands.filter(Boolean)); return; }
    for(const c of cands){ if(!c) continue; try{await s.pc.addIceCandidate(new RTCIceCandidate(c));}catch(e){console.warn('[DC] ICE:',e);} }
  }

  // חלק flush באפר (chat-p2p-datachannel.js) – מחיל candidates שהצטברו אחרי שה-remote description נקבע | HYPER CORE TECH
  async function flushRemoteCands(k) {
    const s=getPS(k); if(!s||!s.pc||!s.pc.remoteDescription) return;
    const buf=s.remoteCandsBuf.splice(0);
    for(const c of buf){ try{await s.pc.addIceCandidate(new RTCIceCandidate(c));}catch{} }
  }

  // חלק signal handler (chat-p2p-datachannel.js) – טיפול באירועי signaling | HYPER CORE TECH
  async function handleSig(event) {
    if(!event||event.pubkey===App.publicKey) return;
    const selfKey=(App.publicKey||'').toLowerCase();
    const pTag=event.tags.find(t=>t[0]==='p'&&t[1]);
    if(!pTag||pTag[1].toLowerCase()!==selfKey) return; // חלק סינון יעד (chat-p2p-datachannel.js) – מטפל רק באירועים שמיועדים אליי | HYPER CORE TECH
    const tag=event.tags.find(t=>t[0]==='type'); if(!tag) return;
    const type=tag[1]; if(!type||!type.startsWith('dc-')) return;
    const peer=event.pubkey.toLowerCase(), s=ensPS(peer);
    if(event.id&&s.seen.has(event.id)) return;
    if(event.id){s.seen.add(event.id); if(s.seen.size>200){const a=[...s.seen];s.seen=new Set(a.slice(-100));}}
    lastSigAt=Date.now();
    // חלק סינון גיל (chat-p2p-datachannel.js) – התעלם מסיגנלים ישנים מ-30 שניות | HYPER CORE TECH
    const evAge=Math.floor(Date.now()/1000)-(event.created_at||0);
    if(evAge>SIG_MAX_AGE_SEC) return;
    let data=null;
    if(event.content){ try{ const d=await NostrTools.nip04.decrypt(App.privateKey,peer,event.content); data=d?JSON.parse(d):null; }catch(e){return;} }
    if(type==='dc-offer'&&data?.type&&data?.sdp) await onOffer(peer,data);
    else if(type==='dc-answer'&&data?.type&&data?.sdp) await onAnswer(peer,data);
    else if(type==='dc-candidates'&&Array.isArray(data)) await onCands(peer,data);
  }

  // חלק הודעות P2P (chat-p2p-datachannel.js) – קבלה ושליחה | HYPER CORE TECH
  function onMsg(peer,raw) {
    try {
      const m=JSON.parse(raw); if(m.type!=='chat-text') return;
      console.log(`[DC] 📩 P2P ← ${peer.slice(0,8)}`);
      if(typeof App.appendChatMessage==='function') App.appendChatMessage({
        id: m.id||('p2p-'+Date.now()+'-'+Math.random().toString(36).slice(2,6)),
        from:peer, to:App.publicKey, content:m.content||'', attachment:m.attachment||null,
        createdAt:m.createdAt||Math.floor(Date.now()/1000), direction:'incoming', p2p:true
      });
    } catch(e){ console.warn('[DC] parse:',e); }
  }

  function send(peer,msg) {
    const s=getPS(peer.toLowerCase());
    if(!s||!s.dc||s.dc.readyState!=='open') return false;
    try {
      s.dc.send(JSON.stringify({type:'chat-text',id:msg.id,content:msg.content,attachment:msg.attachment||null,createdAt:msg.createdAt}));
      console.log(`[DC] 📤 P2P → ${peer.slice(0,8)}`);
      return true;
    } catch(e){ console.warn('[DC] send:',e); return false; }
  }

  // חלק reconnect (chat-p2p-datachannel.js) – חיבור מחדש אוטומטי | HYPER CORE TECH
  function maybeReconn(k) {
    k=k.toLowerCase(); const s=ensPS(k);
    if(s.reconnT) return; if(s.reconnN>=MAX_RECONN) return;
    const active=typeof App.getActiveChatPeer==='function'?App.getActiveChatPeer():null;
    if(!active||active.toLowerCase()!==k) return;
    s.reconnT=setTimeout(()=>{ s.reconnT=null; s.reconnN++; s.status='idle'; connect(k); }, RECONN_MS*(s.reconnN+1));
  }

  // חלק subscription (chat-p2p-datachannel.js) – הרשמה ל-kind 25055 | HYPER CORE TECH
  function closeSub(sub){ if(!sub)return; try{sub.close();}catch{} try{sub.unsub();}catch{} }

  function subscribe() {
    if(sigSub||!App.pool||!App.publicKey||App.guestMode) return;
    try {
      // חלק subscribe (chat-p2p-datachannel.js) – מאזין לכל kind 25055 ומסנן ידנית לפי תג p כדי למנוע פספוס בריליי | HYPER CORE TECH
      sigSub=App.pool.subscribeMany(App.relayUrls,[{kinds:[SIG_KIND],since:Math.floor(Date.now()/1000)-SIG_SINCE_SEC}],{
        onevent:handleSig, oneose:()=>{lastSigAt=Date.now();subReady=true;console.log('[DC] ✅ sub ready');}
      }); lastSigAt=Date.now();
    } catch(e){ console.warn('[DC] sub fail:',e); }
  }

  function startKeep() {
    if(keepTimer) return;
    keepTimer=setInterval(()=>{
      if(App.guestMode||!App.pool||!App.publicKey||document.hidden) return;
      if(!sigSub){subscribe();return;}
      if(lastSigAt&&(Date.now()-lastSigAt)>120000){closeSub(sigSub);sigSub=null;subReady=false;subscribe();}
    },30000);
    try{document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!sigSub)subscribe();});}catch{}
  }

  // חלק API (chat-p2p-datachannel.js) – ממשק ציבורי | HYPER CORE TECH
  function isConn(p){ const s=getPS(p.toLowerCase()); return !!(s&&s.dc&&s.dc.readyState==='open'); }
  function status(p){ const s=getPS(p.toLowerCase()); return s?s.status:'idle'; }

  let initDone=false;
  function init(){ if(initDone||App.guestMode||!App.pool||!App.publicKey) return; initDone=true; subscribe(); startKeep(); console.log('[DC] ✅ initialized'); }

  let lazyDone=false;
  function lazyInit(){
    if(lazyDone) return; lazyDone=true;
    if(App.pool&&App.publicKey&&!App.guestMode){ init(); }
    else { const c=setInterval(()=>{ if(App.pool&&App.publicKey&&!App.guestMode){clearInterval(c);init();} },2000); }
  }

  App.dataChannel={ connect, send, isConnected:isConn, getStatus:status, init:lazyInit, _peers:peers };

  // חלק lazy trigger (chat-p2p-datachannel.js) – אתחול כשפותחים צ'אט | HYPER CORE TECH
  function setupLazy(){
    const btn=document.getElementById('chatToggle')||document.querySelector('[data-chat-toggle]');
    if(btn) btn.addEventListener('click',lazyInit,{once:true});
    if(App.pool&&App.publicKey&&!App.guestMode) setTimeout(lazyInit,15000);
  }
  try{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setupLazy); else setupLazy(); }catch{}
  console.log('[DC] module loaded (lazy)');
})(window);
