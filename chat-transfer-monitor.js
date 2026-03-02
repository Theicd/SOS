// chat-transfer-monitor.js
// חלק מוניטור העברות (chat-transfer-monitor.js) — רישום אירועים ל-localStorage
// ה-UI עבר לדף עצמאי transfer-monitor.html (חלק מה-Control Panel) | HYPER CORE TECH
(function initTransferMonitor(window) {
  'use strict';
  const App = window.NostrApp || (window.NostrApp = {});
  const MAX_EVENTS = 500;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const STORAGE_KEY = 'sos_transfer_events';
  const BC_CHANNEL = 'sos-monitor-live';

  // חלק מאגר אירועים (chat-transfer-monitor.js) — נטען מ-localStorage בהפעלה | HYPER CORE TECH
  let events = [];
  let evtN = 0;
  const fileEvtMap = new Map();

  // חלק BroadcastChannel (chat-transfer-monitor.js) — עדכון מיידי ל-transfer-monitor.html בלי polling | HYPER CORE TECH
  let bc = null;
  try { bc = new BroadcastChannel(BC_CHANNEL); } catch (_e) { /* fallback to localStorage polling */ }
  function broadcast(type, payload) {
    if (bc) try { bc.postMessage({ type, payload, ts: Date.now() }); } catch (_e) {}
  }

  // חלק מעקב מהירות (chat-transfer-monitor.js) — חישוב bytes/sec להעברות פעילות | HYPER CORE TECH
  const activeTransfers = new Map();

  function loadFromStorage() { try { const r = localStorage.getItem(STORAGE_KEY); if (r) events = JSON.parse(r); } catch { events = []; } evtN = events.length; }
  function saveToStorage() { try { const cut = Date.now() - ONE_HOUR_MS; const recent = events.filter(e => e.ts >= cut); if (recent.length !== events.length) events = recent; localStorage.setItem(STORAGE_KEY, JSON.stringify(events)); } catch {} }
  loadFromStorage();

  function addEvt(cat, dir, status, method, details) {
    const id = 'tm-'+(++evtN);
    const evt = { id, ts:Date.now(), category:cat, direction:dir, status, method:method||'unknown', details:details||{}, elapsed:null };
    events.push(evt);
    if (events.length > MAX_EVENTS) events.shift();
    console.log(`[MONITOR/${cat.toUpperCase()}] ${dir} via ${method||'unknown'}`, evt.details);
    saveToStorage();
    broadcast('evt-add', evt);
    return evt;
  }

  function updateEvt(id, upd) {
    const evt = events.find(e => e.id === id);
    if (!evt) return;
    Object.assign(evt, upd);
    if (evt.ts) evt.elapsed = Date.now() - evt.ts;
    saveToStorage();
    broadcast('evt-update', evt);
  }

  // חלק חישוב מהירות (chat-transfer-monitor.js) — מחשב speed בהתבסס על delta bytes ו-delta time | HYPER CORE TECH
  function calcSpeed(mapKey, currentBytes) {
    const now = Date.now();
    const prev = activeTransfers.get(mapKey);
    if (!prev) {
      activeTransfers.set(mapKey, { bytes: currentBytes || 0, ts: now, speed: 0 });
      return 0;
    }
    const dtMs = now - prev.ts;
    if (dtMs < 200) return prev.speed;
    const dBytes = Math.max(0, (currentBytes || 0) - prev.bytes);
    const speed = dtMs > 0 ? Math.round((dBytes / dtMs) * 1000) : 0;
    activeTransfers.set(mapKey, { bytes: currentBytes || 0, ts: now, speed });
    return speed;
  }

  function fmtSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '';
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  }

  // חלק hooks (chat-transfer-monitor.js) — עטיפת פונקציות קיימות לרישום אירועים | HYPER CORE TECH
  function hookAll() {
    hookText(); hookVoice(); hookFiles(); hookConnections(); hookIncoming();
    console.log('[MONITOR] ✅ hooks מחוברים (נתונים נשמרים ל-localStorage)');
  }

  // חלק hook טקסט (chat-transfer-monitor.js) — P2P DC או Relay | HYPER CORE TECH
  function hookText() {
    const orig = App.publishChatMessage;
    if (typeof orig !== 'function') return;
    App.publishChatMessage = async function(peer, text) {
      const preview = (typeof text==='string'?text:'').slice(0,60);
      const evt = addEvt('text','send','started','unknown',{ peer:peer?.slice(0,8), preview });
      try {
        const r = await orig.apply(this, arguments);
        if (r?.p2p) updateEvt(evt.id,{ status:'success', method:'p2p-dc' });
        else if (r?.ok) updateEvt(evt.id,{ status:'success', method:'relay' });
        else updateEvt(evt.id,{ status:'failed', method:'relay', details:{...evt.details, error:r?.error} });
        return r;
      } catch(e) { updateEvt(evt.id,{status:'failed',details:{...evt.details,error:e.message}}); throw e; }
    };
  }

  // חלק hook קול (chat-transfer-monitor.js) — Torrent/Blossom/Inline | HYPER CORE TECH
  function hookVoice() {
    const orig = App.finalizeVoiceToChat;
    if (typeof orig !== 'function') return;
    App.finalizeVoiceToChat = async function(peer) {
      const evt = addEvt('voice','send','started','unknown',{ peer:peer?.slice(0,8) });
      try {
        const r = await orig.apply(this, arguments);
        if (!r) { updateEvt(evt.id,{status:'failed'}); return r; }
        let method = 'unknown';
        if (r.magnetURI && r.url) method='p2p-torrent+blossom';
        else if (r.magnetURI) method='p2p-torrent';
        else if (r.url) method='blossom';
        else if (r.dataUrl) method='inline';
        updateEvt(evt.id,{ status:'success', method, details:{...evt.details, size:r.size, duration:r.duration} });
        return r;
      } catch(e) { updateEvt(evt.id,{status:'failed',details:{...evt.details,error:e.message}}); throw e; }
    };
  }

  // חלק hook קבצים (chat-transfer-monitor.js) — P2P DC/Blossom/WebTorrent + מעקב e2e + מהירות | HYPER CORE TECH
  function hookFiles() {
    if (typeof App.subscribeP2PFileProgress !== 'function') return;
    App.subscribeP2PFileProgress(function(p) {
      const fid = p.fileId; if (!fid) return;
      let method='unknown'; const s=p.status||'';
      if (s.includes('blossom')) method='blossom';
      else if (s.includes('torrent')) method='webtorrent';
      else if (s==='sending'||s==='complete'||s==='starting'||s==='verified'||s==='receiving'||s==='waiting') method='p2p-dc';
      let status='in-progress';
      if (s==='starting'||s==='waiting') status='started';
      else if (s==='verified') status='verified';
      else if (s.startsWith('complete')) status='success';
      else if (s==='failed') status='failed';

      // חלק מהירות (chat-transfer-monitor.js) — חישוב מהירות העברה בזמן אמת | HYPER CORE TECH
      const progressPct = Math.round((p.progress||0)*100);
      const currentBytes = p.size ? Math.round((p.progress||0) * p.size) : 0;
      const mapKey = fid + '_' + (p.direction||'send');
      const speed = calcSpeed(mapKey, currentBytes);
      const speedLabel = fmtSpeed(speed);

      const details = {
        name: p.name,
        size: p.size,
        peer: p.peerPubkey?.slice(0,8),
        progress: progressPct + '%',
        progressRaw: p.progress || 0,
        speed: speed,
        speedLabel: speedLabel,
        bytesTransferred: currentBytes,
        mimeType: p.mimeType || ''
      };
      if (p.error) details.error = p.error;

      const existing = fileEvtMap.get(mapKey);
      const prevEvt = existing ? events.find(e => e.id === existing) : null;
      const mergedDetails = Object.assign({}, prevEvt?.details||{}, details);
      if (!mergedDetails.startTs) {
        mergedDetails.startTs = Date.now();
      }
      // חלק חישוב זמן (chat-transfer-monitor.js) — משך העברה + מהירות ממוצעת | HYPER CORE TECH
      if (status === 'success' || status === 'verified' || status === 'failed') {
        const baseTs = mergedDetails.startTs || prevEvt?.ts || Date.now();
        const transferMs = Math.max(0, Date.now() - baseTs);
        mergedDetails.transferMs = transferMs;
        mergedDetails.transferLabel = `משך העברה ${(transferMs/1000).toFixed(1)}s`;
        const avgSpeed = transferMs > 0 && mergedDetails.size ? Math.round((mergedDetails.size / transferMs) * 1000) : 0;
        mergedDetails.avgSpeed = avgSpeed;
        mergedDetails.avgSpeedLabel = fmtSpeed(avgSpeed);
        activeTransfers.delete(mapKey);
      }
      if (!existing) {
        const evt=addEvt('file',p.direction||'send',status,method,mergedDetails);
        fileEvtMap.set(mapKey,evt.id);
      }
      else updateEvt(existing,{status,method,details:mergedDetails});

      // חלק עדכון מיידי (chat-transfer-monitor.js) — שולח עדכון progress ישיר ל-monitor UI | HYPER CORE TECH
      broadcast('file-progress', {
        fileId: fid, direction: p.direction||'send', status, method,
        name: p.name, size: p.size, progress: p.progress||0,
        progressPct, speed, speedLabel, peer: p.peerPubkey?.slice(0,8)
      });

      // חלק e2e (chat-transfer-monitor.js) — Toast + עדכון כרטיס שליחה כש-verified | HYPER CORE TECH
      if (s === 'verified') {
        showToast('✅ ' + (p.name||'קובץ') + ' הורד בהצלחה בצד השני!', 'success');
        const sendEvtId = fileEvtMap.get(fid + '_send');
        if (sendEvtId) {
          const orig = events.find(e => e.id === sendEvtId);
          updateEvt(sendEvtId, { status:'verified', details: Object.assign({}, orig?.details||{}, { e2e:'✅ אומת — הצד השני קיבל את הקובץ' }) });
        }
        const recvEvtId = fileEvtMap.get(fid + '_receive');
        if (recvEvtId) {
          updateEvt(recvEvtId, { status:'verified', details: Object.assign({}, events.find(e => e.id === recvEvtId)?.details||{}, { e2e:'✅ אומת — הקובץ התקבל בהצלחה' }) });
        }
        broadcast('file-verified', { fileId: fid, name: p.name, peer: p.peerPubkey?.slice(0,8) });
      }
    });
  }

  // חלק hook חיבורים (chat-transfer-monitor.js) — מצב DataChannel | HYPER CORE TECH
  function hookConnections() {
    const orig = App.onDataChannelStateChange;
    App.onDataChannelStateChange = function(peer, state) {
      const s = state==='open'?'connected':state==='closed'?'disconnected':state;
      addEvt('connection',s,s,'p2p-dc',{ peer:peer?.slice(0,8), state });
      if (typeof orig==='function') orig.apply(this,arguments);
    };
  }

  // חלק hook נכנסות (chat-transfer-monitor.js) — זיהוי P2P vs Relay בהודעות נכנסות | HYPER CORE TECH
  function hookIncoming() {
    const orig = App.appendChatMessage;
    if (typeof orig !== 'function') return;
    App.appendChatMessage = function(msg) {
      if (msg && msg.direction==='incoming') {
        const method = msg.p2p ? 'p2p-dc' : 'relay';
        const hasVoice = msg.attachment?.type?.startsWith('audio/');
        const hasFile = msg.attachment && !hasVoice;
        const cat = hasVoice?'voice':hasFile?'file':'text';
        const preview = hasVoice?'🎤 הודעה קולית':hasFile?('📎 '+(msg.attachment?.name||'קובץ')):(msg.content||'').slice(0,60);
        addEvt(cat,'receive','success',method,{ peer:(msg.from||'').slice(0,8), preview });
        // חלק תצוגה מקבל (chat-transfer-monitor.js) — רישום זמן הצגה מקומית של קובץ שהתקבל | HYPER CORE TECH
        if (hasFile && msg.attachment?.fileId) {
          const fid = msg.attachment.fileId;
          const recvEvtId = fileEvtMap.get(fid + '_receive');
          if (recvEvtId) {
            const prev = events.find(e => e.id === recvEvtId);
            const startTs = prev?.details?.startTs || prev?.ts || Date.now();
            const displayedMs = Date.now() - startTs;
            updateEvt(recvEvtId, { details: Object.assign({}, prev?.details||{}, { displayedMs, displayedLabel: `הוצג אחרי ${(displayedMs/1000).toFixed(1)}s` }) });
          }
        }
      }
      return orig.apply(this, arguments);
    };
  }

  // חלק Toast מינימלי (chat-transfer-monitor.js) — התראה צפה בממשק הראשי | HYPER CORE TECH
  function showToast(message, type) {
    let el = document.getElementById('tm-toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'tm-toast';
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100000;padding:10px 20px;border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:opacity .3s;pointer-events:none;direction:rtl;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.background = type==='success'?'#2e7d32':type==='warning'?'#e65100':'#1565c0';
    el.style.opacity = '1';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
  }

  // חלק אתחול (chat-transfer-monitor.js) — הפעלה אחרי שכל המודולים נטענו | HYPER CORE TECH
  function init() {
    setTimeout(hookAll, 1000);
    console.log('[MONITOR] 📊 Transfer Monitor loaded (headless — UI ב-transfer-monitor.html)');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  else setTimeout(init, 300);

  // חלק API ציבורי (chat-transfer-monitor.js) — חשיפה למודולים אחרים | HYPER CORE TECH
  App.transferMonitor = { addEvt, updateEvt, events, activeTransfers, fmtSpeed, calcSpeed, broadcast };
  App.showToast = showToast;
})(window);
