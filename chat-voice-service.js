(function initChatVoiceService(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קול (chat-voice-service.js) – הקלטת קול בדפדפן, דחיסה ל-webm, העלאה ל-Blossom עם Fallback, ושילוב כמצורף בצ'אט
  // הערות: הקובץ קצר (<350 שורות) ומסביר לעצמו. שייך למודול SOS2 צ'אט קול.

  const MAX_INLINE_BYTES = 256 * 1024; // תואם מגבלת inline בצ'אט – הודעות קול ארוכות יותר | HYPER CORE TECH
  const MAX_SECONDS = 60; // בדומה ל-yakbak
  const P2P_SEED_TIMEOUT_MS = 5000; // חלק P2P קול (chat-voice-service.js) – timeout ליצירת טורנט קולי | HYPER CORE TECH


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


  // חלק P2P קול (chat-voice-service.js) – finalize: תמיד מקור ניגון (dataUrl/Blossom) + magnet אופציונלי | HYPER CORE TECH
  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;

    // מקור playable חובה לשני הצדדים; magnet רק כבונוס P2P (לא במקום URL) | HYPER CORE TECH
    console.log('[VOICE] Building playable attachment + optional P2P seed in parallel', {
      size: result.blob.size,
      mime: result.mimeType,
    });
    const [attachment, magnetURI] = await Promise.all([
      buildAttachmentFromBlob(result.blob, result.duration, result.mimeType),
      seedVoiceForP2P(result.blob, result.mimeType).catch(() => null),
    ]);

    if (!attachment || (!attachment.url && !attachment.dataUrl)) {
      throw new Error('voice-attachment-missing-src');
    }

    if (magnetURI) {
      attachment.magnetURI = magnetURI;
      console.log('[VOICE] Hybrid ready: playable src + magnetURI');
    } else {
      console.log('[VOICE] Playable src ready (no magnet)');
    }

    if (typeof App.setChatFileAttachment === 'function') {
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
