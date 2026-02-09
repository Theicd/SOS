(function initChatVoiceService(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קול (chat-voice-service.js) – הקלטת קול בדפדפן, דחיסה ל-webm, העלאה ל-Blossom עם Fallback, ושילוב כמצורף בצ'אט
  // הערות: הקובץ קצר (<350 שורות) ומסביר לעצמו. שייך למודול SOS2 צ'אט קול.

  const MAX_INLINE_BYTES = 90 * 1024; // שמרני כדי לא לעבור מגבלות הודעה
  const MAX_SECONDS = 60; // בדומה ל-yakbak
  const P2P_SEED_TIMEOUT_MS = 5000; // חלק P2P קול (chat-voice-service.js) – timeout ליצירת טורנט קולי | HYPER CORE TECH

  // חלק פינג (chat-voice-service.js) – קבועים למנגנון בדיקת נוכחות peer לפני שליחת P2P | HYPER CORE TECH
  const VOICE_PING_KIND = 25050;  // ephemeral (20000-29999) – לא נשמר בריליי, רק מועבר
  const VOICE_PONG_KIND = 25051;  // ephemeral – תשובת פונג
  const PING_TIMEOUT_MS = 7000;   // 7 שניות להמתין לפונג
  const PING_TAG = 'voice-ping';

  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let micStream = null;

  function isAudioSupported(){
    return !!(navigator.mediaDevices && window.MediaRecorder);
  }

  // חלק פורמט הקלטה (chat-voice-service.js) – בחירת פורמט תואם לכל הדפדפנים | HYPER CORE TECH
  function getSupportedMimeType() {
    // סדר עדיפות: ogg (opus) > webm > mp4
    const types = [
      'audio/ogg; codecs=opus',
      'audio/ogg',
      'audio/webm; codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/mpeg'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return 'audio/webm'; // fallback
  }
  
  let activeMimeType = 'audio/webm';

  async function startVoiceRecording(){
    if(!isAudioSupported()) throw new Error('media-not-supported');
    const stream = micStream && micStream.active ? micStream : (micStream = await navigator.mediaDevices.getUserMedia({ audio: true }));
    chunks = [];
    activeMimeType = getSupportedMimeType();
    console.log('[VOICE] Using MIME type:', activeMimeType);
    const mr = new MediaRecorder(stream, { mimeType: activeMimeType });
    recorder = mr;
    startedAt = Date.now();
    mr.ondataavailable = (e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
    mr.start();
    return true;
  }

  function stopTracks(){
    try{ recorder?.stream?.getTracks?.().forEach(t=>t.stop()); }catch{}
  }

  async function stopVoiceRecording(){
    return new Promise((resolve)=>{
      if(!recorder){ resolve(null); return; }
      const mr = recorder; recorder = null;
      mr.onstop = async ()=>{
        // חלק פורמט (chat-voice-service.js) – שימוש בפורמט שנבחר בהקלטה | HYPER CORE TECH
        const blob = new Blob(chunks, { type: activeMimeType });
        const durationSec = Math.max(1, Math.round((Date.now()-startedAt)/1000));
        stopTracks();
        console.log('[VOICE] Recording stopped, blob size:', blob.size, 'type:', activeMimeType);
        resolve({ blob, duration: durationSec, mimeType: activeMimeType });
      };
      mr.stop();
    });
  }

  function cancelVoiceRecording(){
    if(!recorder) return false;
    try{
      const mr = recorder; recorder = null;
      chunks = []; startedAt = 0;
      mr.ondataavailable = null;
      mr.onstop = null;
      mr.stop();
    }catch{}
    return true;
  }

  // חלק שם קובץ (chat-voice-service.js) – קביעת סיומת לפי MIME | HYPER CORE TECH
  function getFileExtension(mimeType) {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    return 'webm';
  }

  async function buildAttachmentFromBlob(blob, duration, mimeType){
    const ext = getFileExtension(mimeType || 'audio/webm');
    const fileName = `voice-message.${ext}`;
    const finalMime = mimeType || 'audio/webm';
    
    if(blob.size <= MAX_INLINE_BYTES){
      const dataUrl = await new Promise((res,rej)=>{
        const r = new FileReader(); r.onload = ()=>res(String(r.result||'')); r.onerror = rej; r.readAsDataURL(blob);
      });
      return { id: 'audio-'+Date.now(), name: fileName, size: blob.size, type: finalMime, dataUrl, url: '', duration };
    }
    // העלאה ל-Blossom
    try{
      if(typeof App.uploadToBlossom !== 'function') throw new Error('blossom-missing');
      // חלק העלאה (chat-voice-service.js) – העלאה עם MIME type נכון | HYPER CORE TECH
      const url = await App.uploadToBlossom(new Blob([blob], { type: finalMime }));
      console.log('[VOICE] Uploaded to Blossom:', url);
      return { id: 'audio-'+Date.now(), name: fileName, size: blob.size, type: finalMime, dataUrl: '', url, duration };
    }catch(err){
      console.error('[VOICE] Blossom upload failed:', err);
      // Fallback: אם העלאה נכשלה נחזור ל-inline אם אפשר, אחרת נדווח שגיאה
      if (blob.size <= MAX_INLINE_BYTES * 1.2){
        const dataUrl = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result||'')); r.onerror=rej; r.readAsDataURL(blob); });
        return { id: 'audio-'+Date.now(), name: fileName, size: blob.size, type: finalMime, dataUrl, url: '', duration };
      }
      throw err;
    }
  }

  // חלק P2P קול (chat-voice-service.js) – זריעת קובץ קול בטורנט כדי לאפשר הורדה P2P ישירה | HYPER CORE TECH
  async function seedVoiceForP2P(blob, mimeType) {
    try {
      if (!App.torrentTransfer || typeof App.torrentTransfer.init !== 'function') return null;
      const wt = App.torrentTransfer.init();
      if (!wt) return null;

      const ext = getFileExtension(mimeType || 'audio/webm');
      const fileName = `voice-${Date.now()}.${ext}`;
      const file = new File([blob], fileName, { type: mimeType || 'audio/webm' });

      return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(null); }, P2P_SEED_TIMEOUT_MS);
        try {
          wt.seed(file, {
            name: fileName,
            announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
          }, (torrent) => {
            clearTimeout(timer);
            console.log('[VOICE/P2P] ✅ Voice seeded, magnetURI:', torrent.magnetURI.slice(0, 50));

            // חלק P2P קול (chat-voice-service.js) – לוגים למעקב אחרי הורדת הצד השני | HYPER CORE TECH
            let totalUploaded = 0;
            torrent.on('wire', (wire) => {
              console.log('[VOICE/P2P] 🔗 Peer התחבר לטורנט הקולי! peer:', wire.remoteAddress || 'WebRTC');
            });
            torrent.on('upload', (bytes) => {
              totalUploaded += bytes;
              const pct = Math.min(100, Math.round((totalUploaded / (torrent.length || 1)) * 100));
              console.log(`[VOICE/P2P] 📤 מעלה לצד השני: ${pct}% (${totalUploaded}/${torrent.length} bytes)`);
              if (totalUploaded >= torrent.length) {
                console.log('[VOICE/P2P] ✅✅ הצד השני קיבל את ההודעה הקולית דרך P2P בהצלחה!');
              }
            });

            resolve(torrent.magnetURI);
          });
        } catch (err) {
          clearTimeout(timer);
          console.warn('[VOICE/P2P] Seed failed:', err);
          resolve(null);
        }
      });
    } catch {
      return null;
    }
  }

  // חלק פינג (chat-voice-service.js) – שליחת פינג ל-peer והמתנה לפונג. אם הpeer עונה – הוא אונליין ונשלח P2P | HYPER CORE TECH
  async function isPeerOnline(peerPubkey) {
    const pool = App.pool;
    if (!pool || !App.publicKey || !App.privateKey || typeof App.finalizeEvent !== 'function') {
      console.log('[VOICE/PING] ⚠️ pool/keys לא זמינים');
      return false;
    }

    const normalizedPeer = peerPubkey.toLowerCase();
    const pingId = 'vp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const nowSec = Math.floor(Date.now() / 1000);

    // בניית אירוע פינג ephemeral (kind 25050) – לא נשמר בריליי
    const draft = {
      kind: VOICE_PING_KIND,
      pubkey: App.publicKey,
      created_at: nowSec,
      tags: [['p', normalizedPeer], ['t', PING_TAG], ['ping-id', pingId]],
      content: JSON.stringify({ type: 'voice-ping', id: pingId })
    };
    const event = App.finalizeEvent(draft, App.privateKey);

    return new Promise((resolve) => {
      let sub = null;
      const timer = setTimeout(() => {
        if (sub) try { sub.close(); } catch {}
        console.log('[VOICE/PING] ⏱️ Peer לא ענה תוך 7 שניות – לא אונליין');
        resolve(false);
      }, PING_TIMEOUT_MS);

      // האזנה לפונג מהצד השני
      try {
        sub = pool.subscribeMany(App.relayUrls, [{
          kinds: [VOICE_PONG_KIND],
          '#p': [App.publicKey.toLowerCase()],
          '#t': [PING_TAG],
          since: nowSec - 5
        }], {
          onevent: (pongEvent) => {
            try {
              const content = JSON.parse(pongEvent.content);
              if (content.pingId === pingId && pongEvent.pubkey.toLowerCase() === normalizedPeer) {
                clearTimeout(timer);
                if (sub) try { sub.close(); } catch {}
                console.log('[VOICE/PING] ✅ Peer אונליין! ענה תוך', Date.now() - (nowSec * 1000), 'ms');
                resolve(true);
              }
            } catch {}
          }
        });
      } catch (err) {
        clearTimeout(timer);
        console.warn('[VOICE/PING] Subscribe נכשל:', err);
        resolve(false);
      }

      // שליחת הפינג
      try {
        const pubResult = pool.publish(App.relayUrls, event);
        if (Array.isArray(pubResult)) Promise.allSettled(pubResult).catch(() => {});
      } catch (e) { console.warn('[VOICE/PING] Publish נכשל:', e); }
      console.log('[VOICE/PING] 📡 שולח פינג ל-peer:', normalizedPeer.slice(0, 8));
    });
  }

  // חלק פונג (chat-voice-service.js) – מאזין לפינגים נכנסים ועונה אוטומטית בפונג | HYPER CORE TECH
  let pingListenerStarted = false;

  function startVoicePingListener() {
    if (pingListenerStarted) return;
    const pool = App.pool;
    if (!pool || !App.publicKey || typeof App.finalizeEvent !== 'function') return;
    pingListenerStarted = true;

    const selfKey = App.publicKey.toLowerCase();
    pool.subscribeMany(App.relayUrls, [{
      kinds: [VOICE_PING_KIND],
      '#p': [selfKey],
      '#t': [PING_TAG],
      since: Math.floor(Date.now() / 1000) - 5
    }], {
      onevent: (pingEvent) => {
        try {
          const content = JSON.parse(pingEvent.content);
          if (content.type !== 'voice-ping') return;

          const senderPubkey = pingEvent.pubkey.toLowerCase();
          console.log('[VOICE/PONG] 📡 קיבלתי פינג מ:', senderPubkey.slice(0, 8));

          // שליחת פונג חזרה
          const pongDraft = {
            kind: VOICE_PONG_KIND,
            pubkey: App.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', senderPubkey], ['t', PING_TAG]],
            content: JSON.stringify({ type: 'voice-pong', pingId: content.id })
          };
          const pongEvent = App.finalizeEvent(pongDraft, App.privateKey);
          try {
            const pubResult = pool.publish(App.relayUrls, pongEvent);
            if (Array.isArray(pubResult)) Promise.allSettled(pubResult).catch(() => {});
          } catch (e) { console.warn('[VOICE/PONG] Publish נכשל:', e); }
          console.log('[VOICE/PONG] ✅ שלחתי פונג ל:', senderPubkey.slice(0, 8));
        } catch {}
      }
    });
    console.log('[VOICE/PING] 🎧 מאזין לפינגים נכנסים');
  }

  // חלק פונג (chat-voice-service.js) – אתחול אוטומטי של המאזין כשהpool מוכן | HYPER CORE TECH
  const _pingListenerCheck = setInterval(() => {
    if (App.pool && App.publicKey && typeof App.finalizeEvent === 'function') {
      startVoicePingListener();
      clearInterval(_pingListenerCheck);
    }
  }, 3000);

  // חלק P2P קול (chat-voice-service.js) – finalizeVoiceToChat משודרג: פינג לפני בחירת מסלול | HYPER CORE TECH
  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;

    // חלק פינג+seed (chat-voice-service.js) – בדיקת נוכחות + זריעת טורנט במקביל לחיסכון זמן | HYPER CORE TECH
    console.log('[VOICE/P2P] 📡 בודק אם הצד השני אונליין...');
    const [peerOnline, magnetURI] = await Promise.all([
      isPeerOnline(peerPubkey),
      seedVoiceForP2P(result.blob, result.mimeType)
    ]);

    let attachment;

    if (peerOnline && magnetURI) {
      // חלק P2P בלבד (chat-voice-service.js) – peer אונליין וטורנט נזרע: שליחה P2P בלבד ללא Blossom | HYPER CORE TECH
      const ext = getFileExtension(result.mimeType || 'audio/webm');
      attachment = {
        id: 'voice-p2p-' + Date.now(),
        name: `voice-message.${ext}`,
        size: result.blob.size,
        type: result.mimeType || 'audio/webm',
        dataUrl: '',
        url: '',
        magnetURI: magnetURI,
        duration: result.duration
      };
      console.log('[VOICE/P2P] ✅✅ שליחה P2P בלבד! (אפס Blossom, אפס עומס על שרת)');
    } else {
      // חלק Blossom fallback (chat-voice-service.js) – peer לא אונליין או seed נכשל: שליחה דרך Blossom כרגיל | HYPER CORE TECH
      console.log('[VOICE/P2P] ⬇️ Peer לא אונליין – שולח דרך Blossom');
      attachment = await buildAttachmentFromBlob(result.blob, result.duration, result.mimeType);
      // אם הטורנט נזרע בכל זאת, נוסיף את ה-magnetURI כאופציה נוספת
      if (magnetURI) attachment.magnetURI = magnetURI;
    }

    console.log('[VOICE] Final attachment:', attachment);
    if(typeof App.setChatFileAttachment === 'function'){
      App.setChatFileAttachment(peerPubkey, attachment);
    }
    return attachment;
  }

  Object.assign(App, {
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    finalizeVoiceToChat,
  });
})(window);
