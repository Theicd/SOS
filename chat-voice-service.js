(function initChatVoiceService(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קול (chat-voice-service.js) – הקלטת קול בדפדפן, דחיסה ל-webm, העלאה ל-Blossom עם Fallback, ושילוב כמצורף בצ'אט
  // הערות: הקובץ קצר (<350 שורות) ומסביר לעצמו. שייך למודול SOS2 צ'אט קול.

  const MAX_INLINE_BYTES = 90 * 1024; // שמרני כדי לא לעבור מגבלות הודעה
  const MAX_SECONDS = 60; // בדומה ל-yakbak

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

  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;
    // חלק attachment (chat-voice-service.js) – העברת MIME type לבניית ה-attachment | HYPER CORE TECH
    const attachment = await buildAttachmentFromBlob(result.blob, result.duration, result.mimeType);
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
