(function initBlossomClient(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק העלאות (blossom.js) – לקוח Blossom קל משקל עם נפילות חן ורב-שרתים, נכתב עבור פרויקט SOS2
  // מבוסס רעיונית על yakbak/src/lib/blossom.ts אך מותאם JS פשוט וללא תלות חיצונית

  // חלק העלאות (blossom.js) – שרתי Blossom עם תמיכה ב-CORS
  // files.sovbit.host ירד לסוף — ERR_CERT_DATE_INVALID שובר אורחים | HYPER CORE TECH
  const DEFAULT_SERVERS = [
    { url: 'https://blossom.band', pubkey: 'npub1blossomserver' },
    { url: 'https://blossom.nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://blossom.primal.net', pubkey: 'npub1primal' },
    { url: 'https://files.sovbit.host' }, // SSL שבור כרגע — רק fallback אחרון
  ];

  function fixUrl(u){
    return typeof u === 'string' && u.includes('/net/') ? u.replace('/net/', '.net/') : u;
  }

  function isSafeBlossomResultUrl(u){
    if (typeof u !== 'string' || !u.trim()) return false;
    try {
      const parsed = new URL(fixUrl(u.trim()));
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  function isValidUrl(u){
    return isSafeBlossomResultUrl(u);
  }

  async function sha256Hex(blob){
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  // חלק העלאות (blossom.js) – יצירת ארוע הרשאה בסיסי (NIP-24242) באמצעות חותם קיים על האפליקציה
  async function createAuthEvent(verb, content, sha256){
    if(!App.publicKey || typeof App.finalizeEvent !== 'function'){
      throw new Error('missing-signer');
    }
    const now = Math.floor(Date.now()/1000);
    const tags = [['t', verb], ['expiration', String(now + 24*3600)]];
    if(sha256 && (verb === 'upload' || verb === 'delete')) tags.push(['x', sha256]);
    const draft = { kind: 24242, content, tags, created_at: now, pubkey: App.publicKey };
    return App.finalizeEvent(draft, App.privateKey);
  }

  async function getServers(){
    const fromApp = Array.isArray(App.blossomServers) ? App.blossomServers : [];
    const list = (fromApp.length ? fromApp : DEFAULT_SERVERS).map(s=>({ url: fixUrl(s.url), pubkey: s.pubkey||'' }))
      .filter(s=>isValidUrl(s.url));
    return list.length ? list : DEFAULT_SERVERS;
  }

  function diagUrl(u) {
    try {
      if (typeof App.diagSafeUrl === 'function') return App.diagSafeUrl(u);
      const parsed = new URL(String(u || ''));
      const last = (parsed.pathname.split('/').filter(Boolean).pop() || '').slice(0, 12);
      return parsed.hostname + (last ? '/' + last : '');
    } catch (_) {
      return '[url]';
    }
  }

  // חלק העלאות (blossom.js) – ניסיון העלאה לכמה שרתים עד הצלחה
  async function uploadToBlossom(blob){
    console.log('[BLOSSOM] uploadToBlossom called:', {
      blobType: blob?.type,
      blobSize: blob?.size,
      isBlob: blob instanceof Blob,
      isFile: blob instanceof File
    });
    
    // בדיקת תנאים מוקדמת
    if (!App.publicKey) {
      console.error('[BLOSSOM] ❌ חסר publicKey');
      throw new Error('missing-publicKey');
    }
    if (!App.privateKey) {
      console.error('[BLOSSOM] missing signer');
      throw new Error('missing-privateKey');
    }
    if (typeof App.finalizeEvent !== 'function') {
      console.error('[BLOSSOM] ❌ חסר finalizeEvent');
      throw new Error('missing-finalizeEvent');
    }
    
    const servers = await getServers();
    console.log('[BLOSSOM] servers:', servers.map(s => s.url));
    
    let hash;
    try {
      hash = await sha256Hex(blob);
      console.log('[BLOSSOM] hash:', hash.slice(0, 16) + '...');
    } catch (hashErr) {
      console.error('[BLOSSOM] ❌ שגיאה בחישוב hash:', hashErr);
      throw hashErr;
    }
    
    let auth;
    try {
      auth = await createAuthEvent('upload', 'Upload media file', hash);
      console.log('[BLOSSOM] auth event created');
    } catch (authErr) {
      console.error('[BLOSSOM] ❌ שגיאה ביצירת auth event:', authErr);
      throw authErr;
    }
    
    const header = 'Nostr ' + btoa(JSON.stringify(auth));
    const errors = [];
    
    console.log('[BLOSSOM] Starting upload:', {
      size: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
      type: blob.type,
      hash: hash.slice(0, 16) + '...',
      servers: servers.length
    });

    for(const s of servers){
      // נסה נתיבי העלאה שונים לפי סוג השרת
      const uploadPaths = ['/upload', '/api/v1/upload', '/api/upload', '/media'];
      
      for(const path of uploadPaths){
        try{
          const url = new URL(path, s.url).toString();
          console.log('[BLOSSOM] Trying:', diagUrl(url));
          
          // ניסיון עם PUT ואז POST
          for (const method of ['PUT', 'POST']) {
            try {
              const res = await fetch(url, {
                method,
                body: blob,
                headers: {
                  'Content-Type': blob.type || 'application/octet-stream',
                  'Accept': 'application/json',
                  'Authorization': header,
                },
                mode: 'cors',
                credentials: 'omit',
              });
              
              if(!res.ok){
                await res.text().catch(() => '');
                console.log('[BLOSSOM] Failed:', method, res.status);
                continue;
              }
              
              const data = await res.json();
              console.log('[BLOSSOM] Response:', { ok: true, hasUrl: !!(data?.url || data?.data?.url) });
              
              // תמיכה בפורמטים שונים של תשובה
              const resultUrl = data?.url || data?.data?.url || data?.nip94_event?.tags?.find(t => t[0] === 'url')?.[1];
              if(resultUrl){
                if (!isSafeBlossomResultUrl(resultUrl)) {
                  console.warn('[SECURITY/PARSE_REJECT] kind=blossom reason=bad_result_url');
                  continue;
                }
                console.log('[BLOSSOM] Success! URL:', diagUrl(resultUrl));
                return fixUrl(resultUrl);
              }
            } catch(fetchErr) {
              errors.push(`${s.url}${path} ${method}: ${fetchErr.message}`);
            }
          }
        }catch(e){
          errors.push(`${s.url}: ${e.message}`);
        }
      }
    }
    
    console.error('[BLOSSOM] All servers failed:', errors);
    throw new Error('blossom-upload-failed');
  }

  Object.assign(App, { uploadToBlossom, getBlossomServers: getServers });
})(window);
