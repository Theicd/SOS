(function initChatVoiceService(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קול (chat-voice-service.js) – הקלטת קול, P2P קודם כשזמין, אחרת inline/Blossom לריליי | HYPER CORE TECH

  // חלק E2EE (chat-voice-service.js) – סף inline ~40KB לתאימות NIP-44 כשאין P2P | HYPER CORE TECH
  const MAX_INLINE_BYTES = 40 * 1024;
  const MAX_SECONDS = 60;
  const P2P_SEED_TIMEOUT_MS = 5000;
  const P2P_CONNECT_WAIT_MS = 5000;

  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let micStream = null;

  function isAudioSupported(){
    return !!(navigator.mediaDevices && window.MediaRecorder);
  }

  function getSupportedMimeType() {
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
    return 'audio/webm';
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

  function getFileExtension(mimeType) {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    return 'webm';
  }

  function isP2PConnected(peerPubkey) {
    return !!(App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peerPubkey));
  }

  // חלק P2P קול (chat-voice-service.js) – חיבור DataChannel לפני שליחה כדי לא לעלות לשרת | HYPER CORE TECH
  async function ensureP2PConnected(peerPubkey) {
    if (isP2PConnected(peerPubkey)) return true;
    if (!App.dataChannel) return false;
    try {
      App.dataChannel.init?.();
      if (typeof App.dataChannel.forceConnect === 'function') {
        await App.dataChannel.forceConnect(peerPubkey);
      } else if (typeof App.dataChannel.connect === 'function') {
        App.dataChannel.connect(peerPubkey);
      }
      const started = Date.now();
      while (Date.now() - started < P2P_CONNECT_WAIT_MS) {
        if (isP2PConnected(peerPubkey)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      console.warn('[VOICE] P2P connect failed:', err?.message || err);
    }
    return isP2PConnected(peerPubkey);
  }

  // חלק ריליי קול (chat-voice-service.js) – רק כשאין P2P: inline קטן / Blossom גדול (בלי Toast) | HYPER CORE TECH
  async function buildAttachmentFromBlob(blob, duration, mimeType){
    const ext = getFileExtension(mimeType || 'audio/webm');
    const fileName = `voice-message.${ext}`;
    const finalMime = mimeType || 'audio/webm';
    
    if(blob.size <= MAX_INLINE_BYTES){
      const dataUrl = await new Promise((res,rej)=>{
        const r = new FileReader(); r.onload = ()=>res(String(r.result||'')); r.onerror = rej; r.readAsDataURL(blob);
      });
      return { id: 'audio-'+Date.now(), name: fileName, size: blob.size, type: finalMime, dataUrl, url: '', duration, voiceVia: 'relay', isVoice: true, hidePreview: true };
    }
    if(typeof App.uploadToBlossom !== 'function') throw new Error('blossom-missing');
    const url = await App.uploadToBlossom(new Blob([blob], { type: finalMime }));
    console.log('[VOICE] Uploaded to Blossom (no P2P):', url);
    return { id: 'audio-'+Date.now(), name: fileName, size: blob.size, type: finalMime, dataUrl: '', url, duration, voiceVia: 'blossom', isVoice: true, hidePreview: true };
  }

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

  // חלק שליחה (chat-voice-service.js) – P2P זמין = רק DataChannel/קבצים P2P, בלי שרת | HYPER CORE TECH
  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;

    const ext = getFileExtension(result.mimeType || 'audio/webm');
    const fileName = `voice-message.${ext}`;
    console.log('[VOICE] Finalize', { size: result.blob.size, mime: result.mimeType, peer: peerPubkey.slice(0, 8) });

    const p2pReady = await ensureP2PConnected(peerPubkey);
    if (p2pReady && typeof App.sendP2PFile === 'function') {
      const file = new File([result.blob], fileName, { type: result.mimeType || 'audio/webm' });
      if (!App._pendingVoiceMeta) App._pendingVoiceMeta = new Map();
      App._pendingVoiceMeta.set(String(peerPubkey).toLowerCase(), {
        duration: result.duration,
        name: fileName,
        mimeType: result.mimeType || 'audio/webm',
      });
      console.log('[VOICE] ⚡ P2P available — sending voice via sendP2PFile (no server)');
      const fileId = await App.sendP2PFile(peerPubkey, file);
      if (fileId) {
        return { sentViaP2P: true, fileId, duration: result.duration, name: fileName };
      }
      console.warn('[VOICE] sendP2PFile returned empty — falling back to relay path');
    }

    // אין P2P — מסלול ריליי (inline / Blossom) + magnet אופציונלי | HYPER CORE TECH
    const [attachment, magnetURI] = await Promise.all([
      buildAttachmentFromBlob(result.blob, result.duration, result.mimeType),
      seedVoiceForP2P(result.blob, result.mimeType).catch(() => null),
    ]);

    if (!attachment || (!attachment.url && !attachment.dataUrl)) {
      throw new Error('voice-attachment-missing-src');
    }

    if (magnetURI) {
      attachment.magnetURI = magnetURI;
    }

    attachment.hidePreview = true;
    attachment.isVoice = true;
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
