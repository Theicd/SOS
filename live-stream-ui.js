// חלק שידור חי (live-stream-ui.js) – UI: כפתור, דיאלוג שידור/צפייה, וכרטיס בפיד
(function initLiveStreamUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  let modal = null;
  let localVideo = null;
  let remoteVideo = null;

  // חלק שידור חי – יצירת דיאלוג
  function openModal(mode, roomMeta){
    closeModal();
    modal = doc.createElement('div');
    modal.className = 'live-modal';
    const title = mode === 'broadcast' ? 'שידור חי' : 'צפייה בשידור חי';
    modal.innerHTML = `
      <div class="live-modal__backdrop"></div>
      <div class="live-modal__content" role="dialog" aria-modal="true">
        <header class="live-modal__header">
          <h3>${title}</h3>
          <button class="live-modal__close" data-action="close" aria-label="סגור"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <main class="live-modal__body">
          <div class="live-modal__videos">
            <video id="liveRemote" class="live-video live-video--remote" autoplay playsinline controls></video>
            <video id="liveLocal" class="live-video live-video--local" autoplay muted playsinline></video>
          </div>
          <div class="live-modal__actions">
            ${mode==='broadcast' ? '<button class="button-primary" data-action="end">סיים שידור</button>' : '<button class="button-secondary" data-action="end">סגור</button>'}
          </div>
        </main>
      </div>`;
    doc.body.appendChild(modal);
    localVideo = modal.querySelector('#liveLocal');
    remoteVideo = modal.querySelector('#liveRemote');

    modal.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    modal.querySelector('[data-action="end"]').addEventListener('click', async ()=>{ try{ await App.live.end(); }catch{} closeModal(); });

    // התאמת מצב
    if (mode === 'broadcast') {
      if (typeof App.live?.start === 'function') App.live.start(roomMeta?.slug||'live');
    } else if (mode === 'watch' && roomMeta) {
      if (typeof App.live?.watch === 'function') App.live.watch(roomMeta.owner, roomMeta.slug||'live');
    }
  }

  function closeModal(){ if (modal){ try{ modal.remove(); }catch{} modal=null; } localVideo=null; remoteVideo=null; }

  // חלק שידור חי – callbacks מליבת live-stream.js
  App.onLiveLocalStream = function(stream){ if(localVideo) localVideo.srcObject = stream; };
  App.onLiveRemoteStream = function(stream){ if(remoteVideo) remoteVideo.srcObject = stream; };
  App.onLiveStarted = function(){ /* ניתן להציג סטטוס */ };
  App.onLiveEnded = function(){ closeModal(); };

  // חלק שידור חי – חשיפת API גלובלי לפתיחת שידור חי ממקומות אחרים בממשק
  App.openLiveBroadcast = function(roomMeta){
    try { openModal('broadcast', roomMeta || { slug: 'live' }); } catch(_) {}
  };

  // חלק שידור חי – כפתור בראש הדף
  function insertTopBarButton(){
    // מושבת בכוונה: אין הוספת כפתור שידור חי בסרגל העליון
    return;
  }

  // חלק שידור חי – מנוי לפוסטים מסוג live-post כדי לצייר כרטיס בפיד
  async function subscribeLivePosts(){
    if(!App.pool || !App.publicKey){ setTimeout(subscribeLivePosts, 500); return; }
    const since = Math.floor(Date.now()/1000) - 10;
    const filters = [ { kinds:[25051], since } ];
    App.pool.subscribeMany(App.relayUrls, filters, { onevent: renderLivePost, oneose: ()=>{} });
  }

  // חלק שידור חי – התראה קופצת על שידור חי
  function showLiveToast(owner, onWatch){
    try {
      // אל תציג לעצמנו (המשדר)
      if (owner && App.publicKey && owner.toLowerCase() === App.publicKey.toLowerCase()) return;
      const id = 'live-toast';
      if (doc.getElementById(id)) return;
      const el = doc.createElement('div');
      el.id = id;
      el.className = 'live-toast';
      el.innerHTML = `<div class="live-toast__inner"><i class="fa-solid fa-tower-broadcast"></i><span>יש שידור חי עכשיו</span><button class="button-primary" data-action="watch">צפה</button></div>`;
      doc.body.appendChild(el);
      const btn = el.querySelector('[data-action="watch"]');
      btn.addEventListener('click', ()=>{ try{ onWatch && onWatch(); }catch{} try{ el.remove(); }catch{} });
      setTimeout(()=>{ try{ el.remove(); }catch{} }, 8000);
    } catch {}
  }

  // חלק שידור חי – רינדור/עדכון פוסט צפייה בפיד
  function renderLivePost(ev){
    try{
      const tType = ev.tags.find(t=>t[0]==='type'); if(!tType) return;
      const tRoom = ev.tags.find(t=>t[0]==='r'); if(!tRoom) return;
      const type = tType[1];
      const meta = JSON.parse(ev.content||'{}');
      const owner = meta.owner || ev.pubkey; const slug = meta.slug || 'live'; const roomId = tRoom[1];
      const stream = doc.getElementById('homeFeedStream'); if(!stream) return;
      const cardId = `live-card-${roomId}`;

      if (type === 'live-post') {
        if (doc.getElementById(cardId)) return; // אל תכפיל
        const card = doc.createElement('article');
        card.className = 'live-card';
        card.id = cardId;
        card.dataset.roomId = roomId;
        card.innerHTML = `
          <header class="live-card__header">
            <i class="fa-solid fa-tower-broadcast"></i>
            <h4>שידור חי</h4>
            <span class="live-card__owner">${owner.slice(0,8)}</span>
          </header>
          <div class="live-card__body">
            <p>לחץ לצפייה בשידור</p>
            <div class="live-card__meta"><span class="live-card__viewers" id="${cardId}-viewers">0 צופים</span></div>
            <button class="button-primary" data-action="watch">צפה</button>
          </div>`;
        stream.prepend(card);
        const onWatch = ()=> openModal('watch', { owner, slug });
        card.querySelector('[data-action="watch"]').addEventListener('click', onWatch);
        // הצג התראה קופצת בכל לקוח (לא למשדר עצמו)
        showLiveToast(owner, onWatch);
        return;
      }

      if (type === 'live-status') {
        const card = doc.getElementById(cardId); if(!card) return;
        const viewersEl = doc.getElementById(`${cardId}-viewers`);
        try {
          const payload = JSON.parse(ev.content||'{}');
          const direct = Array.isArray(payload.direct) ? payload.direct.length : 0;
          const relays = Array.isArray(payload.relays) ? payload.relays.length : 0;
          const approx = Math.max(1, direct + relays); // קירוב מינימלי
          if (viewersEl) viewersEl.textContent = `${approx} צופים`;
        } catch {}
        return;
      }
    }catch(e){ console.warn('live post render failed', e); }
  }

  function init(){ insertTopBarButton(); subscribeLivePosts(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();

  console.log('Live stream UI initialized');
})(window);
