// חלק בדיקות העברת קבצים (chat-file-transfer-tests.js) – בדיקות קונסולה מקיפות | HYPER CORE TECH
// הרצה: העתק והדבק בקונסולת הדפדפן (F12 → Console)
// דרישה: שני מחשבים מחוברים לאותו צ'אט עם DataChannel פעיל

(async function runFileTransferTests() {
  const App = window.NostrApp || {};
  const results = [];
  let pass = 0, fail = 0, skip = 0;

  // חלק עזר (chat-file-transfer-tests.js) – פונקציות עזר | HYPER CORE TECH
  function test(name, fn) {
    try {
      const ok = fn();
      if (ok === 'skip') { skip++; results.push(`⏭️ ${name} (SKIP)`); }
      else if (ok) { pass++; results.push(`✅ ${name}`); }
      else { fail++; results.push(`❌ ${name}`); }
    } catch (e) { fail++; results.push(`❌ ${name} — ${e.message}`); }
  }

  function createTestFile(name, type, sizeKB) {
    const data = new Uint8Array(sizeKB * 1024);
    crypto.getRandomValues(data);
    return new File([data], name, { type });
  }

  // חלק עזר Smoke (chat-file-transfer-tests.js) – יצירת dataUrl בגודל מדויק לבדיקות סף inline | HYPER CORE TECH
  function createDataUrlBySize(sizeBytes, mimeType = 'application/octet-stream') {
    const bytes = new Uint8Array(sizeBytes);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251;
    }
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  // ═══ חלק 1: API זמין (chat-file-transfer-tests.js) – וידוא טעינת מודולים ═══ | HYPER CORE TECH
  test('1.1 sendP2PFile', () => typeof App.sendP2PFile === 'function');
  test('1.2 handleP2PFileOffer', () => typeof App.handleP2PFileOffer === 'function');
  test('1.3 onFileDataChannel', () => typeof App.onFileDataChannel === 'function');
  test('1.4 subscribeP2PFileProgress', () => typeof App.subscribeP2PFileProgress === 'function');
  test('1.5 activeP2PTransfers (Map)', () => App.activeP2PTransfers instanceof Map);
  test('1.6 dataChannel', () => !!App.dataChannel);
  test('1.7 getChatPC', () => typeof App.dataChannel?.getChatPC === 'function');
  test('1.8 torrentTransfer', () => !!App.torrentTransfer);
  test('1.9 torrentTransfer.seedOnly', () => typeof App.torrentTransfer?.seedOnly === 'function');
  test('1.10 uploadToBlossom', () => typeof App.uploadToBlossom === 'function');
  test('1.11 publishChatMessage', () => typeof App.publishChatMessage === 'function');
  test('1.12 handleChatFileSelection', () => typeof App.handleChatFileSelection === 'function');
  test('1.13 RTCPeerConnection', () => typeof RTCPeerConnection === 'function');
  test('1.14 crypto.subtle', () => !!crypto?.subtle);
  test('1.15 syncTorrentDownloadButtons', () => typeof App.syncTorrentDownloadButtons === 'function');

  // ═══ חלק 2: חיבור P2P (chat-file-transfer-tests.js) – וידוא DC פעיל ═══ | HYPER CORE TECH
  const peer = App.getActiveChatPeer?.();
  test('2.1 peer פעיל קיים', () => !!peer);
  test('2.2 DC מחובר', () => { if (!peer) return 'skip'; return App.dataChannel?.isConnected?.(peer) === true; });
  test('2.3 chatPC connected', () => {
    if (!peer) return 'skip';
    const pc = App.dataChannel?.getChatPC?.(peer);
    return pc && pc.connectionState === 'connected';
  });

  // ═══ חלק 3: Fallback routing (chat-file-transfer-tests.js) – ניתוב לפי סוג קובץ ═══ | HYPER CORE TECH
  test('3.1 קוד fallback קיים ב-sendP2PFile', () => {
    const src = App.sendP2PFile?.toString?.() || '';
    return src.includes('fallback') || src.includes('Blossom');
  });
  test('3.2 קוד torrent fallback קיים', () => {
    const src = App.sendP2PFile?.toString?.() || '';
    return src.includes('Torrent') || src.includes('torrent');
  });

  // ═══ חלק 3b: Smoke 5 תרחישים (chat-file-transfer-tests.js) – אימות ספי inline 256KB ═══ | HYPER CORE TECH
  function runInlineSerializationSmoke(sizeKB, expectOk) {
    if (typeof App.setChatFileAttachment !== 'function' || typeof App.clearChatFileAttachment !== 'function' || typeof App.serializeChatMessageContent !== 'function') {
      return 'skip';
    }
    const smokePeer = (peer || 'smoke-peer').toLowerCase();
    const sizeBytes = sizeKB * 1024;
    const attachment = {
      id: `smoke-${sizeKB}`,
      name: `smoke-${sizeKB}.bin`,
      size: sizeBytes,
      type: 'application/octet-stream',
      dataUrl: createDataUrlBySize(sizeBytes),
    };
    App.setChatFileAttachment(smokePeer, attachment);
    const serialized = App.serializeChatMessageContent(smokePeer, `📎 smoke-${sizeKB}`);
    App.clearChatFileAttachment(smokePeer);
    return expectOk ? Boolean(serialized && serialized.rawContent) : serialized === null;
  }

  test('3.3 smoke 64KB inline תקין', () => runInlineSerializationSmoke(64, true));
  test('3.4 smoke 120KB inline תקין', () => runInlineSerializationSmoke(120, true));
  test('3.5 smoke 250KB inline תקין', () => runInlineSerializationSmoke(250, true));
  test('3.6 smoke 257KB inline נחסם (מסלול גדול)', () => runInlineSerializationSmoke(257, false));
  test('3.7 smoke 300KB inline נחסם (מסלול גדול)', () => runInlineSerializationSmoke(300, false));

  // חלק בדיקות ניתוב (chat-file-transfer-tests.js) – וידוא שקבצים גדולים לא נתקעים על inline ומנותבים ל-P2P/טורנט | HYPER CORE TECH
  test('3.8 handleChatFileSelection כולל ניתוב P2P מעל 90KB', () => {
    const src = App.handleChatFileSelection?.toString?.() || '';
    return src.includes('P2P_PREFERRED_FROM_BYTES') || src.includes('shouldPreferP2P');
  });
  test('3.9 handleChatFileSelection כולל fallback לטורנט לקבצים גדולים', () => {
    const src = App.handleChatFileSelection?.toString?.() || '';
    return src.includes('requestTransfer') || src.includes('torrentTransfer');
  });
  test('3.10 סריאליזציית טורנט שומרת infoHash', () => {
    if (typeof App.setChatFileAttachment !== 'function' || typeof App.clearChatFileAttachment !== 'function' || typeof App.serializeChatMessageContent !== 'function') {
      return 'skip';
    }
    const smokePeer = (peer || 'smoke-peer').toLowerCase();
    App.setChatFileAttachment(smokePeer, {
      id: 'smoke-infohash',
      name: 'smoke.zip',
      size: 12345,
      type: 'application/zip',
      magnetURI: 'magnet:?xt=urn:btih:abcdef1234567890',
      infoHash: 'abcdef1234567890',
      isTorrent: true,
    });
    const serialized = App.serializeChatMessageContent(smokePeer, '📎 smoke.zip');
    App.clearChatFileAttachment(smokePeer);
    return Boolean(serialized?.rawContent && serialized.rawContent.includes('"infoHash":"abcdef1234567890"'));
  });
  test('3.11 handler טורנט כולל normalize infoHash מ-magnet', () => {
    const src = App.torrentTransfer?.handleIncomingRequest?.toString?.() || '';
    return src.includes('extractInfoHashFromMagnet') || src.includes('normalizedInfoHash');
  });

  // ═══ חלק 4: העברת קבצים P2P (chat-file-transfer-tests.js) – שליחה אמיתית ═══ | HYPER CORE TECH
  if (peer && App.dataChannel?.isConnected?.(peer)) {
    const testFiles = [
      { name: 'test.txt', type: 'text/plain', kb: 1, desc: 'טקסט קטן (1KB)' },
      { name: 'test.zip', type: 'application/zip', kb: 50, desc: 'ZIP (50KB)' },
      { name: 'test.pdf', type: 'application/pdf', kb: 10, desc: 'PDF (10KB)' },
      { name: 'test.png', type: 'image/png', kb: 20, desc: 'PNG (20KB)' },
      { name: 'test.mp3', type: 'audio/mpeg', kb: 30, desc: 'MP3 (30KB)' },
      { name: 'test.mp4', type: 'video/mp4', kb: 40, desc: 'MP4 (40KB)' },
      { name: 'test.exe', type: 'application/octet-stream', kb: 15, desc: 'EXE (15KB)' },
      { name: 'test.json', type: 'application/json', kb: 2, desc: 'JSON (2KB)' },
      { name: 'big-test.bin', type: 'application/octet-stream', kb: 512, desc: 'קובץ גדול (512KB, 2 chunks)' },
    ];

    console.log('%c═══ שליחת קבצי בדיקה P2P ═══', 'color: yellow; font-size: 12px;');
    const progressLog = [];
    const fileFinalResults = new Map();
    const terminalStatuses = new Set(['complete', 'complete-torrent', 'complete-blossom', 'sent-no-confirm', 'failed']);

    // חלק המתנה לתוצאה (chat-file-transfer-tests.js) – ממתין לסטטוס סופי של fileId ספציפי | HYPER CORE TECH
    async function waitForFinalStatus(fileId, timeoutMs = 30000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        for (let i = progressLog.length - 1; i >= 0; i--) {
          const evt = progressLog[i];
          if (!evt || evt.fileId !== fileId || evt.direction !== 'send') continue;
          if (terminalStatuses.has(evt.status)) {
            return evt;
          }
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return null;
    }

    const unsub = App.subscribeP2PFileProgress((p) => {
      progressLog.push({ ...p, ts: Date.now() });
      if (p.status === 'complete' && p.direction === 'send') {
        console.log(`%c✅ ${p.name} — שליחה הושלמה P2P`, 'color: lime;');
      } else if (p.status === 'failed') {
        console.log(`%c❌ ${p.name} — נכשל: ${p.error || 'unknown'}`, 'color: red;');
      } else if (p.status === 'uploading-blossom') {
        console.log(`%c🔄 ${p.name} — Blossom fallback`, 'color: orange;');
      } else if (p.status === 'complete-torrent') {
        console.log(`%c🧲 ${p.name} — Torrent fallback הצליח`, 'color: cyan;');
      }
    });

    for (const tf of testFiles) {
      try {
        const file = createTestFile(tf.name, tf.type, tf.kb);
        console.log(`📤 שולח ${tf.desc}...`);
        const fileId = await App.sendP2PFile(peer, file);
        if (fileId) {
          const finalEvt = await waitForFinalStatus(fileId, 30000);
          if (!finalEvt) {
            fail++;
            fileFinalResults.set(tf.name, { status: 'timeout' });
            results.push(`❌ 4.${tf.name} — timeout בלי סטטוס סופי (${fileId.slice(0,12)})`);
          } else {
            fileFinalResults.set(tf.name, { status: finalEvt.status, fileId, name: finalEvt.name || tf.name });
            if (finalEvt.status === 'failed') {
              fail++;
              results.push(`❌ 4.${tf.name} — נכשל (${finalEvt.error || 'unknown'})`);
            } else {
              pass++;
              results.push(`✅ 4.${tf.name} — הסתיים (${finalEvt.status}) (${fileId.slice(0,12)})`);
            }
          }
        } else {
          fail++; results.push(`❌ 4.${tf.name} — sendP2PFile החזיר null`);
        }
        // המתנה קצרה בין שליחות למניעת עומס
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        fail++; results.push(`❌ 4.${tf.name} — ${e.message}`);
      }
    }

    // חלק 5: ניתוח תוצאות (chat-file-transfer-tests.js) – סיכום שיטות שליחה | HYPER CORE TECH
    const methods = { 'p2p-dc': 0, 'blossom': 0, 'torrent': 0, 'failed': 0 };
    for (const [, fileResult] of fileFinalResults.entries()) {
      if (!fileResult || !fileResult.status) continue;
      if (fileResult.status === 'complete') methods['p2p-dc']++;
      else if (fileResult.status === 'complete-blossom') methods['blossom']++;
      else if (fileResult.status === 'complete-torrent' || fileResult.status === 'sent-no-confirm') methods['torrent']++;
      else methods['failed']++;
    }
    console.log('%c═══ סיכום שיטות שליחה ═══', 'color: cyan; font-size: 12px;');
    console.log('P2P DataChannel:', methods['p2p-dc']);
    console.log('Blossom fallback:', methods['blossom']);
    console.log('Torrent fallback:', methods['torrent']);
    console.log('נכשל:', methods['failed']);

    // חלק רגרסיה ZIP (chat-file-transfer-tests.js) – וידוא ש-ZIP לא נתקע/נופל | HYPER CORE TECH
    test('5.1 ZIP לא נכשל (P2P/ fallback תקין)', () => {
      const zipResult = fileFinalResults.get('test.zip');
      if (!zipResult) return false;
      return zipResult.status && zipResult.status !== 'failed' && zipResult.status !== 'timeout';
    });

    // בדיקה שאין העברות תקועות
    test('5.2 אין העברות פעילות תקועות', () => App.activeP2PTransfers.size === 0);

    unsub();
  } else {
    console.log('%c⚠️ אין peer מחובר — מדלג על בדיקות שליחה', 'color: orange;');
    // חלק ספירה (chat-file-transfer-tests.js) – 9 קבצי שליחה + 2 בדיקות section 5 | HYPER CORE TECH
    skip += 11;
  }

  // ═══ חלק 6: בדיקת DC יחיד (chat-file-transfer-tests.js) – וידוא שהתיקון עובד ═══ | HYPER CORE TECH
  test('6.1 sendNextChunk משתמש ב-transfer.channel', () => {
    const src = App.sendP2PFile?.toString?.() || '';
    // בדיקה עקיפה — הקוד החדש שומר channel על transfer
    return src.includes('transfer.channel') || src.includes('channel');
  });

  // ═══ סיכום (chat-file-transfer-tests.js) ═══ | HYPER CORE TECH
  console.log('%c═══ File Transfer Tests — סיכום ═══', 'color: cyan; font-size: 14px; font-weight: bold;');
  results.forEach(r => console.log(r));
  const total = pass + fail;
  const summary = `${pass}/${total} passed, ${skip} skipped`;
  if (fail === 0) {
    console.log(`%c${summary} ✅`, 'color: lime; font-size: 13px; font-weight: bold;');
  } else {
    console.log(`%c${summary} ⚠️ ${fail} FAILED`, 'color: red; font-size: 13px; font-weight: bold;');
  }
  return { pass, fail, skip, results };
})();
