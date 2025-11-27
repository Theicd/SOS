(function initBlossomClient(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק העלאות (blossom.js) – לקוח Blossom קל משקל עם נפילות חן ורב-שרתים, נכתב עבור פרויקט SOS2
  // מבוסס רעיונית על yakbak/src/lib/blossom.ts אך מותאם JS פשוט וללא תלות חיצונית

  const DEFAULT_SERVERS = [
    { url: 'https://blossom.band', pubkey: 'npub1blossomserver' },
    { url: 'https://nostr.net' },
    { url: 'https://nostr.net/' },
    { url: 'https://github.com/nostr-protocol/nostr' },
    { url: 'https://github.com/hzrd149/blossom' },
    { url: 'https://blossom.primal.net', pubkey: 'npub1primal' },
    { url: 'https://blossom.nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://nostrify.dev' },
    { url: 'https://nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://gitlab.com/soapbox-pub/nostrify-docs/-/blob/main/:path' },
    { url: 'https://gitlab.com/soapbox-pub/nostrify-docs/-/blob/main/upload/blossom.md' },
    { url: 'https://how-nostr-works.pages.dev/' },
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
        // חלק העלאות (blossom.js) – ניסיון עם PUT ואז POST כדי לעקוף מגבלות חלק מהדפדפנים במובייל
        const methods = ['PUT','POST'];
        for (const method of methods) {
          const res = await fetch(url, {
            method,
            body: blob,
            headers: {
              // הימנעות מכותרות שמפעילות preflight/נחסמות (Origin/Content-Length)
              'Content-Type': blob.type || 'application/octet-stream',
              'Accept': 'application/json',
              'Authorization': header,
            },
            mode: 'cors',
            credentials: 'omit',
          });
          if(!res.ok){
            try { await res.text(); } catch {}
            continue; // נסה שיטה הבאה או שרת הבא
          }
          const data = await res.json();
          if(!data?.url || (data?.sha256 && data.sha256 !== hash)){
            continue;
          }
          return fixUrl(data.url);
        }
      }catch(e){
        // נמשיך לשרת הבא
      }
    }
    throw new Error('blossom-upload-failed');
  }

  Object.assign(App, { uploadToBlossom, getBlossomServers: getServers });
})(window);
