// חלק נגן אודיו (chat-audio-player.js) – נגן אודיו משודרג לצ'אט עם waveform, seek, buffering, נגישות | HYPER CORE TECH
(function initChatAudioPlayer(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
  // חלק עיצוב (chat-audio-player.js) – HTML משודרג לנגן אודיו בסגנון וואטסאפ | HYPER CORE TECH
  function createEnhancedAudioPlayer(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const dur = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : null;
    const mm = dur !== null ? Math.floor(dur / 60) : null;
    const ss = dur !== null ? String(dur % 60).padStart(2, '0') : null;
    const durationLabel = dur !== null ? `${mm}:${ss}` : '0:00';
    
    return `
      <div class="chat-message__audio chat-audio-enhanced" data-audio>
        <audio preload="metadata" class="chat-message__audio-el" src="${src}" type="${attachment.type || 'audio/webm'}"></audio>
        <div class="chat-audio-whatsapp">
          <button type="button" class="chat-audio-whatsapp__play" aria-label="נגן הודעה קולית">
            <i class="fa-solid fa-play"></i>
          </button>
          <div class="chat-audio-whatsapp__content">
            <div class="chat-audio-whatsapp__track">
              <div class="chat-audio-whatsapp__progress" style="width:0%"></div>
              <div class="chat-audio-whatsapp__seeker" style="left:0%"></div>
            </div>
            <span class="chat-audio-whatsapp__time">${durationLabel}</span>
          </div>
        </div>
      </div>
    `;
  }
  
  // חלק waveform (chat-audio-player.js) – ציור גלי קול פשוט | HYPER CORE TECH
  function drawWaveform(canvas, audio) {
    if (!canvas || !audio) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const bars = 40;
    const barWidth = width / bars;
    const gap = 1;
    
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    
    // Generate pseudo-random waveform based on duration
    const seed = audio.duration || 30;
    for (let i = 0; i < bars; i++) {
      const random = Math.sin(i * seed * 0.1) * 0.5 + 0.5;
      const barHeight = Math.max(4, random * height * 0.8);
      const x = i * barWidth;
      const y = (height - barHeight) / 2;
      
      ctx.fillRect(x, y, barWidth - gap, barHeight);
    }
  }
  
  // חלק אינטראקציה (chat-audio-player.js) – חיבור אירועים לנגן בסגנון וואטסאפ | HYPER CORE TECH
  function wireAudioPlayer(container) {
    if (!container) return;
    
    // מניעת propagation על כל הקונטיינר | HYPER CORE TECH
    container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    
    const audio = container.querySelector('.chat-message__audio-el');
    // תמיכה בשני סוגי נגנים - ישן וחדש
    const btn = container.querySelector('.chat-audio-whatsapp__play') || container.querySelector('.chat-audio__play');
    const progressBar = container.querySelector('.chat-audio-whatsapp__progress');
    const seeker = container.querySelector('.chat-audio-whatsapp__seeker');
    const timeEl = container.querySelector('.chat-audio-whatsapp__time');
    const track = container.querySelector('.chat-audio-whatsapp__track');
    
    if (!audio || !btn) return;
    
    const format = (sec) => {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    
    let isPlaying = false;
    
    // חלק טעינה (chat-audio-player.js) – עדכון זמן בטעינת מטאדאטה | HYPER CORE TECH
    audio.addEventListener('loadedmetadata', () => {
      if (timeEl) {
        timeEl.textContent = format(audio.duration || 0);
      }
    });
    
    // חלק ניגון (chat-audio-player.js) – toggle play/pause | HYPER CORE TECH
    const toggle = () => {
      if (audio.paused) {
        audio.play().catch((err) => {
          console.warn('Audio play failed', err);
        });
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        isPlaying = true;
      } else {
        audio.pause();
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        isPlaying = false;
      }
    };
    
    // חלק לחיצה (chat-audio-player.js) – מניעת propagation | HYPER CORE TECH
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle();
    });
    
    // חלק התקדמות (chat-audio-player.js) – עדכון פס התקדמות והזמן | HYPER CORE TECH
    audio.addEventListener('timeupdate', () => {
      const d = Math.max(1, audio.duration || 1);
      const p = Math.min(100, (audio.currentTime / d) * 100);
      
      if (progressBar) {
        progressBar.style.width = p + '%';
      }
      if (seeker) {
        seeker.style.left = p + '%';
      }
      if (timeEl && isPlaying) {
        timeEl.textContent = format(audio.currentTime);
      }
    });
    
    // חלק סיום (chat-audio-player.js) – איפוס כפתור בסיום | HYPER CORE TECH
    audio.addEventListener('ended', () => {
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      isPlaying = false;
      if (progressBar) {
        progressBar.style.width = '0%';
      }
      if (seeker) {
        seeker.style.left = '0%';
      }
      if (timeEl) {
        timeEl.textContent = format(audio.duration || 0);
      }
    });
    
    // חלק seek (chat-audio-player.js) – קפיצה בפס התקדמות בלחיצה | HYPER CORE TECH
    if (track) {
      track.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * (audio.duration || 0);
      }
      audio.currentTime = 0;
    });
    
    // חלק seek (chat-audio-player.js) – קפיצה בפס התקדמות | HYPER CORE TECH
    if (waveformContainer) {
      waveformContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (hasError) return;
        
        const rect = waveformContainer.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * (audio.duration || 0);
      });
      
      // נגישות מקלדת
      waveformContainer.setAttribute('role', 'slider');
      waveformContainer.setAttribute('aria-label', 'מיקום בהודעה קולית');
      waveformContainer.setAttribute('aria-valuemin', '0');
      waveformContainer.setAttribute('aria-valuemax', '100');
      waveformContainer.setAttribute('tabindex', '0');
      
      waveformContainer.addEventListener('keydown', (e) => {
        if (hasError) return;
        
        let delta = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          delta = 5; // 5 seconds forward
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          delta = -5; // 5 seconds backward
          e.preventDefault();
        } else if (e.key === 'Home') {
          audio.currentTime = 0;
          e.preventDefault();
          return;
        } else if (e.key === 'End') {
          audio.currentTime = audio.duration || 0;
          e.preventDefault();
          return;
        }
        
        if (delta !== 0) {
          audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
        }
      });
      
      audio.addEventListener('timeupdate', () => {
        const d = Math.max(1, audio.duration || 1);
        const p = Math.round((audio.currentTime / d) * 100);
        waveformContainer.setAttribute('aria-valuenow', String(p));
      });
    }
    
    // חלק ניקוי (chat-audio-player.js) – עצירה בעת הסרת אלמנט | HYPER CORE TECH
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node === container || node.contains(container)) {
            if (!audio.paused) {
              audio.pause();
            }
            observer.disconnect();
          }
        });
      });
    });
    
    if (container.parentElement) {
      observer.observe(container.parentElement, { childList: true, subtree: true });
    }
  }
  
  // חלק API ציבורי (chat-audio-player.js) – חשיפת פונקציות ליצירת נגן | HYPER CORE TECH
  Object.assign(App, {
    createEnhancedAudioPlayer,
    wireEnhancedAudioPlayer: wireAudioPlayer
  });
})(window);
