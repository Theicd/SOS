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
        chunks = [];
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

  // Wire schema: type is MIME essence only (audio/webm). Recorder may still use codecs=opus. | HYPER CORE TECH
  function canonicalVoiceMime(mimeType) {
    if (typeof mimeType !== 'string' || !mimeType) return 'audio/webm';
    return mimeType.split(';')[0].trim() || 'audio/webm';
  }

  function voiceSecureError(code) {
    const err = new Error(code);
    err.code = code;
    return err;
  }

  // Voice never takes a plaintext server path: encrypted Blossom descriptor or E2EE-safe inline only. | HYPER CORE TECH
  async function buildAttachmentFromBlob(blob, duration, mimeType, peerPubkey){
    const ext = getFileExtension(mimeType || 'audio/webm');
    const fileName = `voice-message.${ext}`;
    const finalMime = canonicalVoiceMime(mimeType || 'audio/webm');
    const peer =
      peerPubkey ||
      (typeof App.getActiveChatPeer === 'function' && App.getActiveChatPeer()) ||
      (App.chatState && App.chatState.activeContact) ||
      '';
    const messageId =
      typeof App.ensureLogicalMessageIdForMedia === 'function'
        ? App.ensureLogicalMessageIdForMedia()
        : ('cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

    async function uploadSecureVoice() {
      if (typeof App.uploadMediaForServerFallback !== 'function') {
        throw voiceSecureError('VOICE_E2EE_UNAVAILABLE');
      }
      const uploadBlob = new Blob([blob], { type: finalMime });
      const uploaded = await App.uploadMediaForServerFallback(uploadBlob, {
        messageId,
        sender: App.publicKey,
        recipient: peer,
        mimeType: finalMime,
        fileName,
        duration,
        requireEncryption: true,
      });
      if (!uploaded || typeof uploaded !== 'object' || uploaded.type !== 'encrypted-media') {
        throw voiceSecureError('VOICE_E2EE_UPLOAD_NOT_ENCRYPTED');
      }
      uploaded.id = uploaded.attachmentId || ('audio-' + Date.now());
      uploaded.name = (uploaded.media && uploaded.media.filename) || fileName;
      uploaded.size =
        (uploaded.media && typeof uploaded.media.originalSize === 'number'
          ? uploaded.media.originalSize
          : blob.size);
      uploaded.duration = duration;
      uploaded.isVoice = true;
      uploaded.clientMessageId = messageId;
      uploaded.logicalMessageId = messageId;
      console.log('[VOICE] Uploaded encrypted Blossom descriptor');
      return uploaded;
    }

    async function tryInlineVoice() {
      const dataUrl = await new Promise((res,rej)=>{
        const r = new FileReader(); r.onload = ()=>res(String(r.result||'')); r.onerror = rej; r.readAsDataURL(blob);
      });
      const inlineAtt = {
        id: 'audio-'+Date.now(),
        name: fileName,
        size: blob.size,
        type: finalMime,
        dataUrl,
        url: '',
        duration,
        isVoice: true,
        clientMessageId: messageId,
        logicalMessageId: messageId,
      };
      if (typeof App.resolveInlineAttachmentForE2ee !== 'function') {
        return inlineAtt;
      }
      const resolved = await App.resolveInlineAttachmentForE2ee({
        attachment: inlineAtt,
        blob,
        file: blob,
        messageId,
        sender: App.publicKey,
        recipient: peer,
        text: '',
        mimeType: finalMime,
        fileName,
        duration,
        requireEncryption: true,
      });
      if (resolved.route === 'INLINE_E2EE_SAFE') {
        return resolved.attachment;
      }
      if (resolved.route === 'SECURE_BLOB_REQUIRED' && resolved.attachment) {
        if (resolved.attachment.type !== 'encrypted-media') {
          throw voiceSecureError('VOICE_E2EE_UPLOAD_NOT_ENCRYPTED');
        }
        return resolved.attachment;
      }
      // GENERIC should not happen for voice MIME; fall through to secure upload.
      return null;
    }
    
    if(blob.size <= MAX_INLINE_BYTES){
      try {
        const inlineOrSecure = await tryInlineVoice();
        if (inlineOrSecure) return inlineOrSecure;
      } catch (preErr) {
        // Prefer secure Blossom over impossible inline when preflight rejects.
        if (preErr && preErr.code === 'MEDIA_E2EE_TOO_LARGE') throw preErr;
        console.warn('[VOICE] inline E3B preflight failed, trying secure server fallback', preErr?.code || preErr?.message);
      }
      // SECURE_BLOB_REQUIRED without descriptor (or classifier miss) → encrypted Blossom path
      try {
        return await uploadSecureVoice();
      } catch (err) {
        console.error('[VOICE] Blossom upload failed after inline overflow:', err);
        if (typeof App.isMediaServerE2eeRequired === 'function' && App.isMediaServerE2eeRequired()) {
          throw err;
        }
        throw err;
      }
    }
    // העלאה ל-Blossom (M4: when server-E2EE gate ON → ciphertext only; transport choice unchanged)
    try{
      return await uploadSecureVoice();
    }catch(err){
      console.error('[VOICE] Encrypted Blossom upload failed:', err?.code || err?.message);
      // Never a plaintext Blossom/dataUrl downgrade; only a classifier-approved E2EE inline (ENCRYPT_FAILURE otherwise).
      if (blob.size <= MAX_INLINE_BYTES * 1.2 && typeof App.resolveInlineAttachmentForE2ee === 'function') {
        try {
          const emergency = await tryInlineVoice();
          if (emergency) return emergency;
        } catch (_e) {}
      }
      throw err;
    }
  }

  function isEncryptedVoiceDescriptor(att) {
    return !!(
      att &&
      att.type === 'encrypted-media' &&
      att.resource &&
      att.resource.transport === 'blossom' &&
      att.resource.url
    );
  }

  // חלק P2P קול (chat-voice-service.js) – זריעת ה-ciphertext בלבד (אותם bytes ו-hash כמו ב-Blossom), לעולם לא WebM גלוי | HYPER CORE TECH
  const VOICE_P2P_MARKER_VERSION = 1;
  const VOICE_P2P_CONTENT = 'sos-media-e2ee-v2-ciphertext';
  const VOICE_P2P_TORRENT_NAME = 'data.bin';

  async function seedVoiceForP2P(descriptor) {
    try {
      const prepared = descriptor && descriptor._prepared;
      const ciphertext = prepared && prepared.ciphertextBytes;
      if (!isEncryptedVoiceDescriptor(descriptor) || !(ciphertext instanceof Uint8Array)) return null;
      if (
        !descriptor.cipher ||
        ciphertext.byteLength !== descriptor.cipher.size ||
        prepared.ciphertextSha256 !== descriptor.cipher.sha256 ||
        typeof App.hashMediaCiphertext !== 'function' ||
        (await App.hashMediaCiphertext(ciphertext)) !== descriptor.cipher.sha256
      ) {
        console.warn('[VOICE/P2P] VOICE_P2P_SEED_REFUSED ciphertext does not match descriptor');
        return null;
      }
      if (!App.torrentTransfer || typeof App.torrentTransfer.init !== 'function') return null;
      const wt = App.torrentTransfer.init();
      if (!wt) return null;

      const fileName = VOICE_P2P_TORRENT_NAME;
      const file = new File([ciphertext], fileName, { type: 'application/octet-stream' });

      return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(null); }, P2P_SEED_TIMEOUT_MS);
        try {
          wt.seed(file, {
            name: fileName,
            announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
          }, (torrent) => {
            clearTimeout(timer);
            console.log('[VOICE/P2P] ✅ Voice seeded', typeof App.diagSafeMagnet === 'function' ? App.diagSafeMagnet(torrent.magnetURI) : { infoHash: String(torrent.infoHash || '').slice(0, 12) });

            // חלק P2P קול (chat-voice-service.js) – לוגים למעקב אחרי הורדת הצד השני | HYPER CORE TECH
            let totalUploaded = 0;
            torrent.on('wire', (wire) => {
              console.log('[VOICE/P2P] 🔗 Peer התחבר לטורנט הקולי');
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


  // חלק P2P קול (chat-voice-service.js) – finalize: descriptor מוצפן (Blossom) + אותו ciphertext ב-P2P תחת סימון p2p v1 | HYPER CORE TECH
  async function sendVoiceBlobToChat(peerPubkey, result){
    if(!peerPubkey) throw new Error('missing-peer');
    if(!result || !result.blob) return null;

    console.log('[VOICE] Building encrypted attachment', {
      size: result.blob.size,
      mime: result.mimeType,
    });
    const attachment = await buildAttachmentFromBlob(result.blob, result.duration, result.mimeType, peerPubkey);

    const hasEncryptedBlossom = isEncryptedVoiceDescriptor(attachment);
    if (!attachment || (!attachment.url && !attachment.dataUrl && !hasEncryptedBlossom)) {
      throw new Error('voice-attachment-missing-src');
    }

    if (hasEncryptedBlossom) {
      const magnetURI = await seedVoiceForP2P(attachment).catch(() => null);
      delete attachment._prepared;
      if (magnetURI) {
        attachment.p2p = {
          v: VOICE_P2P_MARKER_VERSION,
          transport: 'webtorrent',
          content: VOICE_P2P_CONTENT,
          magnetURI,
        };
        console.log('[VOICE] Hybrid ready: encrypted Blossom + encrypted P2P');
      } else {
        console.log('[VOICE] Encrypted Blossom ready (no P2P)');
      }
    }

    // hidePreview: אין שורת שם-קובץ מתחת לקומפוזר בזמן שליחת הודעה קולית | HYPER CORE TECH
    attachment.hidePreview = true;
    attachment.isVoice = true;
    if (typeof App.setChatFileAttachment === 'function') {
      App.setChatFileAttachment(peerPubkey, attachment);
    }
    return attachment;
  }

  async function finalizeVoiceToChat(peerPubkey){
    if(!peerPubkey) throw new Error('missing-peer');
    const result = await stopVoiceRecording();
    if(!result) return null;
    return sendVoiceBlobToChat(peerPubkey, result);
  }

  Object.assign(App, {
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    finalizeVoiceToChat,
    sendVoiceBlobToChat,
  });
})(window);
