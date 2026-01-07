(function initBlossomClient(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק העלאות (blossom.js) – לקוח Blossom קל משקל עם נפילות חן ורב-שרתים, נכתב עבור פרויקט SOS2
  // מבוסס רעיונית על yakbak/src/lib/blossom.ts אך מותאם JS פשוט וללא תלות חיצונית

  const DEFAULT_SERVERS = [
    { url: 'https://blossom.band', pubkey: 'npub1blossomserver' },
  ];

  function fixUrl(u){
    return typeof u === 'string' && u.includes('/net/') ? u.replace('/net/', '.net/') : u;
  }

  function isValidUrl(u){
    try { new URL(fixUrl(u)); return true; } catch { return false; }
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

  // חלק העלאות (blossom.js) – ניסיון העלאה לכמה שרתים עד הצלחה. במקרה כישלון – נזרוק שגיאה וניתן לשכבות גבוהות לבצע fallback
  async function uploadToBlossom(blob){
    const servers = await getServers();
    const hash = await sha256Hex(blob);
    const auth = await createAuthEvent('upload', 'Upload voice-message.webm', hash);
    const header = 'Nostr ' + btoa(JSON.stringify(auth));

    for(const s of servers){
      try{
        const url = new URL('/upload', s.url).toString();
        const res = await fetch(url, {
          method: 'PUT',
          body: blob,
          headers: {
            'Content-Type': blob.type || 'application/octet-stream',
            'Content-Length': String(blob.size||0),
            'Accept': 'application/json',
            'Authorization': header,
            'Origin': window.location.origin,
          },
          mode: 'cors',
          credentials: 'omit',
        });
        if(!res.ok){
          // ננסה ללקט סיבת כשל אך נתקדם לשרת הבא
          try { await res.text(); } catch {}
          continue;
        }
        const data = await res.json();
        if(!data?.url || data?.sha256 && data.sha256 !== hash){
          continue;
        }
        return fixUrl(data.url);
      }catch(e){
        // נמשיך לשרת הבא
      }
    }
    throw new Error('blossom-upload-failed');
  }

  Object.assign(App, { uploadToBlossom, getBlossomServers: getServers });
})(window);
