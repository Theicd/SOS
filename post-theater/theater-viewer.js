// מודול: Post Theater Viewer
// מימוש עצמאי לפתיחת פוסט במצב "תיאטרון" בדסקטופ, ללא תלות בקוד קיים
// API ציבורי: window.PostTheaterViewer.open(post), .close(), .isOpen()

(function(){
  'use strict';

  // חלק תיאטרון (theater-viewer.js) – שמירת מזהה הפוסט הפעיל ונתוני המטמון
  let currentPostId = '';
  let cachedPost = null;
  let resizeHandler = null;

  // חלק תיאטרון (theater-viewer.js) – קיצור דרך ל- App הראשי
  function getApp(){
    return window.NostrApp || {};
  }

  // חלק תיאטרון (theater-viewer.js) – התאמת פריסה למובייל לפי רוחב החלון
  function applyResponsiveLayout(){
    const overlay = document.querySelector('.ptv-overlay');
    if (!overlay) return;
    const viewport = window.innerWidth || document.documentElement.clientWidth || 0;
    const isMobile = viewport <= 900;
    overlay.classList.toggle('ptv-mobile', isMobile);
  }

  // חלק תיאטרון (theater-viewer.js) – שמירת מאזין resize יחיד כדי לעדכן את מצב הפריסה
  function ensureResponsiveWatcher(){
    if (resizeHandler) return;
    resizeHandler = () => applyResponsiveLayout();
    window.addEventListener('resize', resizeHandler);
  }

  // חלק תיאטרון (theater-viewer.js) – פורמט טקסט למספרים (0/1/רבים)
  function formatCount(value, singularLabel, pluralLabel){
    const n = Number(value) || 0;
    if (n === 1) return `1 ${singularLabel}`;
    return `${n} ${pluralLabel}`;
  }

  // חלק תיאטרון (theater-viewer.js) – הפעלת לייק דרך NostrApp
  async function triggerLike(postId, button){
    const App = getApp();
    if (!postId || typeof App.likePost !== 'function') return;
    try {
      button.disabled = true;
      await Promise.resolve(App.likePost(postId));
    } catch (err) {
      console.error('ptv like failed', err);
    } finally {
      button.disabled = false;
      refreshFromFeedCard(postId);
    }
  }

  // חלק תיאטרון (theater-viewer.js) – הפעלת שיתוף דרך NostrApp
  async function triggerShare(postId, button){
    const App = getApp();
    if (!postId || typeof App.sharePost !== 'function') return;
    try {
      button.disabled = true;
      await Promise.resolve(App.sharePost(postId));
    } catch (err) {
      console.error('ptv share failed', err);
    } finally {
      button.disabled = false;
    }
  }

  // חלק תיאטרון (theater-viewer.js) – פרסום תגובה דרך NostrApp
  async function submitComment(postId, inputEl, button){
    const App = getApp();
    if (!postId || typeof App.postComment !== 'function') return;
    const text = (inputEl.value || '').trim();
    if (!text) {
      inputEl.focus();
      return;
    }
    try {
      button.disabled = true;
      await App.postComment(postId, text);
      inputEl.value = '';
      refreshFromFeedCard(postId);
    } catch (err) {
      console.error('ptv comment failed', err);
    } finally {
      button.disabled = false;
      inputEl.focus();
    }
  }

  // חלק תיאטרון (theater-viewer.js) – רענון נתוני שכבת התיאטרון מהכרטיס המקורי
  function refreshFromFeedCard(postId){
    if (!postId || !isOpen()) return;
    const overlay = document.querySelector('.ptv-overlay');
    if (!overlay || overlay.dataset.postId !== postId) return;
    const App = getApp();
    const builder = typeof App.buildTheaterSnapshot === 'function' ? App.buildTheaterSnapshot : null;
    const card = document.querySelector(`.home-feed__card[data-feed-card="${postId}"]`);
    if (builder && card) {
      try {
        const nextData = builder(card);
        cachedPost = nextData;
        renderPost(overlay, nextData);
        return;
      } catch (err) {
        console.warn('ptv refreshFromFeedCard failed', err);
      }
    }
    if (cachedPost && cachedPost.id === postId) {
      renderPost(overlay, cachedPost);
    }
  }

  // --- עזרי זמן בסגנון פייסבוק ---
  function formatFbTime(ts){
    try{
      const now = Date.now();
      const diff = Math.max(0, now - ts);
      const s = Math.floor(diff/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
      if(s<60) return 'עכשיו';
      if(m<60) return m+'ד';
      if(h<24) return h+'ש';
      if(d<7) return d+'י';
      const dt = new Date(ts);
      const months = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
      const label = months[dt.getMonth()] + ' ' + dt.getDate();
      const y = dt.getFullYear();
      const thisYear = new Date().getFullYear();
      return thisYear===y ? label : (label+`, ${y}`);
    }catch(e){ return ''; }
  }

  // --- יצירת דום לשכבה ---
  function ensureOverlay(){
    let el = document.querySelector('.ptv-overlay');
    if(el) return el;
    el = document.createElement('div');
    el.className = 'ptv-overlay';
    el.innerHTML = `
      <div class="ptv-layout" role="dialog" aria-modal="true">
        <div class="ptv-side">
          <div class="ptv-header">
            <img class="ptv-avatar" alt="" />
            <div>
              <div class="ptv-name"></div>
              <div class="ptv-time"></div>
            </div>
          </div>
          <div class="ptv-text"></div>
          <div class="ptv-stats">
            <div class="ptv-likes"></div>
            <div class="ptv-counts"></div>
          </div>
          <div class="ptv-actions">
            <button class="ptv-action" data-act="comment" title="תגובה">💬 תגובה</button>
            <button class="ptv-action" data-act="like" title="אהבתי">👍 אהבתי</button>
            <button class="ptv-action" data-act="share" title="שתף">↗️ שיתוף</button>
          </div>
          <div class="ptv-comments" aria-label="תגובות"></div>
          <div class="ptv-reply">
            <input type="text" placeholder="כתוב/כתבי תגובה..." />
            <button type="button">פרסום</button>
          </div>
        </div>
        <div class="ptv-media"></div>
      </div>
      <button class="ptv-close" aria-label="סגירה">✕</button>
    `;
    document.body.appendChild(el);
    el.dataset.postId = '';
    ensureResponsiveWatcher();
    applyResponsiveLayout();

    // סגירה ב-ESC ובכפתור
    el.querySelector('.ptv-close').addEventListener('click', () => close());
    document.addEventListener('keydown', (ev)=>{
      if(ev.key==='Escape' && isOpen()) close();
    });

    // סגירה בלחיצה מחוץ לפריסה
    el.addEventListener('mousedown', (e)=>{
      const layout = el.querySelector('.ptv-layout');
      if(!layout.contains(e.target)) close();
    });

    return el;
  }

  // --- רינדור פוסט לשכבה ---
  function renderPost(el, post){
    cachedPost = post;
    currentPostId = post?.id || '';
    el.dataset.postId = currentPostId;

    const App = getApp();
    const currentUser = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    const likeSet = App.likesByEventId?.get?.(currentPostId) || null;
    const isLiked = likeSet && currentUser ? likeSet.has(currentUser) : false;

    // כותרת
    const avatar = el.querySelector('.ptv-avatar');
    const name = el.querySelector('.ptv-name');
    const time = el.querySelector('.ptv-time');
    avatar.src = post.author?.avatarUrl || '';
    avatar.alt = post.author?.name || '';
    name.textContent = post.author?.name || '';
    time.textContent = formatFbTime(post.timestamp);

    // טקסט
    el.querySelector('.ptv-text').textContent = post.text || '';

    // סטטיסטיקות
    const likes = post.counts?.likes ?? 0;
    const comments = post.counts?.comments ?? 0;
    const shares = post.counts?.shares ?? 0;
    el.querySelector('.ptv-likes').textContent = formatCount(likes, 'אהב', 'אהבו');
    el.querySelector('.ptv-counts').textContent = `${formatCount(comments, 'תגובה', 'תגובות')} · ${formatCount(shares, 'שיתוף', 'שיתופים')}`;

    // פעולות – חיבור לפונקציות הפיד
    const actions = el.querySelectorAll('.ptv-action');
    actions.forEach(btn=>{
      btn.onclick = (ev)=>{ ev.preventDefault(); ev.stopPropagation(); };
    });
    const commentAction = el.querySelector('.ptv-action[data-act="comment"]');
    const likeAction = el.querySelector('.ptv-action[data-act="like"]');
    const shareAction = el.querySelector('.ptv-action[data-act="share"]');

    if (commentAction) {
      commentAction.disabled = false;
    }
    if (likeAction) {
      likeAction.disabled = false;
      likeAction.classList.toggle('ptv-action--liked', Boolean(isLiked));
    }
    if (shareAction) {
      shareAction.disabled = false;
    }

    const input = el.querySelector('.ptv-reply input');
    const publishBtn = el.querySelector('.ptv-reply button');

    if (commentAction && input) {
      commentAction.onclick = (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        input.focus();
      };
    }
    if (likeAction) {
      likeAction.onclick = (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        triggerLike(currentPostId, likeAction);
      };
    }
    if (shareAction) {
      shareAction.onclick = (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        triggerShare(currentPostId, shareAction);
      };
    }

    if (publishBtn && input) {
      publishBtn.onclick = (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        submitComment(currentPostId, input, publishBtn);
      };
      input.onkeydown = (ev)=>{
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          submitComment(currentPostId, input, publishBtn);
        }
      };
    }

    // תגובות
    const list = el.querySelector('.ptv-comments');
    list.innerHTML = '';
    const commentsList = Array.isArray(post.comments) ? post.comments : [];
    if (!commentsList.length) {
      const empty = document.createElement('div');
      empty.className = 'ptv-comments__empty';
      empty.textContent = 'אין תגובות עדיין.';
      list.appendChild(empty);
    } else {
      commentsList.forEach(c=>{
        const item = document.createElement('div');
        item.className = 'ptv-comment';
        item.innerHTML = `
          <img class="ptv-comment-avatar" src="${c.avatarUrl||''}" alt="" />
          <div class="ptv-comment-bubble">
            <div class="ptv-comment-name">${c.authorName||''}</div>
            <div class="ptv-comment-text">${(c.text||'')}</div>
            <div class="ptv-comment-time">${formatFbTime(c.timestamp)}</div>
          </div>
        `;
        list.appendChild(item);
      });
    }

    // הוספת מדיה (תמונה/וידאו)
    const mediaWrap = el.querySelector('.ptv-media');
    mediaWrap.innerHTML = '';
    const first = (post.media||[])[0];
    if(first){
      if(first.type==='youtube'){
        const iframe = document.createElement('iframe');
        iframe.src = first.src || '';
        iframe.title = 'YouTube video player';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.allowFullscreen = true;
        iframe.style.width = '100%';
        iframe.style.aspectRatio = '16 / 9';
        iframe.style.height = 'auto';
        iframe.style.maxWidth = '100%';
        iframe.style.border = '0';
        mediaWrap.appendChild(iframe);
      } else if(first.type==='video'){
        const v = document.createElement('video');
        v.src = first.src; v.controls = true; v.playsInline = true; v.poster = first.poster||'';
        mediaWrap.appendChild(v);
      } else { // image ברירת מחדל
        const img = document.createElement('img');
        img.src = first.src; img.alt = '';
        mediaWrap.appendChild(img);
      }
    }
  }

  // --- API ---
  function open(post){
    const el = ensureOverlay();
    renderPost(el, post||{});
    el.classList.add('ptv-open');
    applyResponsiveLayout();
    document.documentElement.style.overflow = 'hidden';
    // אם סימנו focusComment, העבר פוקוס לשדה התגובה
    if (post && post.focusComment) {
      setTimeout(() => {
        const input = el.querySelector('.ptv-reply input');
        if (input) {
          input.focus();
        }
      }, 100);
    }
  }
  function close(){
    const el = document.querySelector('.ptv-overlay');
    if(!el) return;
    el.classList.remove('ptv-open');
    document.documentElement.style.overflow = '';
  }
  function isOpen(){
    return !!document.querySelector('.ptv-overlay.ptv-open');
  }

  // חשיפה גלובלית
  window.PostTheaterViewer = { open, close, isOpen, refreshFromFeedCard };
})();
