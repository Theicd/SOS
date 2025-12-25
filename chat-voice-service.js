(function initChatVoiceService(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קול (chat-voice-service.js) – הקלטת קול בדפדפן, דחיסה ל-webm, העלאה ל-Blossom עם Fallback, ושילוב כמצורף בצ'אט
  // הערות: הקובץ קצר (<350 שורות) ומסביר לעצמו. שייך למודול SOS2 צ'אט קול.

  // חלק תיקון קול ארוך (chat-voice-service.js) – מודל Blossom בלבד ללא inline | HYPER CORE TECH
  const MAX_INLINE_BYTES = 200 * 1024; // ערך היסטורי; לא נשתמש ב-inline עוד

  const MAX_SECONDS = 60; // בדומה ל-yakbak

  let recorder = null;
  let chunks = [];
  let startedAt = 0;

  function isAudioSupported(){
    return !!(navigator.mediaDevices && window.MediaRecorder);
  }

  async function startVoiceRecording(){
    if(!isAudioSupported()) throw new Error('media-not-supported');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
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
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const durationSec = Math.max(1, Math.round((Date.now()-startedAt)/1000));
        stopTracks();
        resolve({ blob, duration: durationSec });
      };
      mr.stop();
    });
  }

  async function buildAttachmentFromBlob(blob, duration){
    // העלאה ל-Blossom בלבד (ללא inline) כדי להבטיח מקור URL תקין לנגן | HYPER CORE TECH
    if(typeof App.uploadToBlossom !== 'function') {
      throw new Error('blossom-missing');
    }

    try{
      // שליחה כ-audio/webm כדי שהצד המקבל יזהה כהודעה קולית
      const url = await App.uploadToBlossom(new Blob([blob], { type: 'audio/webm' }));
      return { id: 'audio-'+Date.now(), name: 'voice-message.webm', size: blob.size, type: 'audio/webm', dataUrl: '', url, duration };
    }catch(err){
      console.error('[VOICE] Blossom upload failed', err);
      // העברה שגיאה הלאה – לא שולחים הודעה בלי URL
      throw err;
    }
  }

  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;
    const attachment = await buildAttachmentFromBlob(result.blob, result.duration);
    if(typeof App.setChatFileAttachment === 'function'){
      App.setChatFileAttachment(peerPubkey, attachment);
    }
    return attachment;
  }

  Object.assign(App, {
    startVoiceRecording,
    stopVoiceRecording,
    finalizeVoiceToChat,
  });
})(window);
