// חלק אופטימיזציה (chat-ui-optimizations.js) – שיפור ביצועים לצ'אט UI | HYPER CORE TECH
(function initChatUIOptimizations(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
  // חלק debounce (chat-ui-optimizations.js) – מניעת ריצות מיותרות של פונקציות | HYPER CORE TECH
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
  
  // חלק throttle (chat-ui-optimizations.js) – הגבלת קצב ביצוע פונקציות | HYPER CORE TECH
  function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
  
  // חלק Virtual Scroll (chat-ui-optimizations.js) – רינדור חכם של הודעות | HYPER CORE TECH
  class VirtualMessageList {
    constructor(container, renderItem) {
      this.container = container;
      this.renderItem = renderItem;
      this.items = [];
      this.visibleRange = { start: 0, end: 20 };
      this.itemHeight = 80; // גובה משוער להודעה
      this.buffer = 5; // מספר פריטים נוספים מעל ומתחת
    }
    
    setItems(items) {
      this.items = items;
      this.render();
    }
    
    calculateVisibleRange() {
      if (!this.container) return;
      
      const scrollTop = this.container.scrollTop;
      const containerHeight = this.container.clientHeight;
      
      const start = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.buffer);
      const end = Math.min(
        this.items.length,
        Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.buffer
      );
      
      this.visibleRange = { start, end };
    }
    
    render() {
      if (!this.container) return;
      
      const fragment = document.createDocumentFragment();
      const visibleItems = this.items.slice(this.visibleRange.start, this.visibleRange.end);
      
      visibleItems.forEach((item, index) => {
        const element = this.renderItem(item, this.visibleRange.start + index);
        fragment.appendChild(element);
      });
      
      this.container.innerHTML = '';
      this.container.appendChild(fragment);
      
      // שמירת מיקום גלילה
      const shouldScrollToBottom = 
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 100;
      
      if (shouldScrollToBottom) {
        requestAnimationFrame(() => {
          this.container.scrollTop = this.container.scrollHeight;
        });
      }
    }
    
    onScroll() {
      this.calculateVisibleRange();
      this.render();
    }
  }
  
  function isDesktopChat() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(min-width: 769px)').matches && !window.matchMedia('(pointer: coarse)').matches;
  }

  function pastedFileName(file) {
    const given = String((file && file.name) || '').trim();
    if (given) return given;
    const type = String((file && file.type) || '');
    const rawExt = type.includes('/') ? type.split('/')[1] : 'bin';
    const ext = String(rawExt || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const prefix = type.startsWith('image/') ? 'צילום-מסך-' : 'קובץ-';
    return prefix + stamp + '.' + (ext === 'jpeg' ? 'jpg' : ext);
  }

  function asNamedClipboardFile(file) {
    if (!file) return null;
    if (file.name) return file;
    try {
      return new File([file], pastedFileName(file), { type: file.type || 'application/octet-stream', lastModified: Date.now() });
    } catch (_) {
      return file;
    }
  }

  function filesFromClipboard(clipboard) {
    const out = [];
    if (!clipboard) return out;
    const listed = clipboard.files;
    if (listed && listed.length) {
      for (let i = 0; i < listed.length; i++) {
        if (listed[i] && listed[i].size) out.push(asNamedClipboardFile(listed[i]));
      }
      return out;
    }
    const items = clipboard.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file && file.size) out.push(asNamedClipboardFile(file));
    }
    return out;
  }

  function deliverPastedFiles(files) {
    const file = files[0];
    if (!file) return;
    if (typeof App.openChatSendPreview === 'function') {
      App.openChatSendPreview(file);
      return;
    }
    if (typeof App.handleChatFileSelection === 'function') {
      App.handleChatFileSelection(file);
    }
  }

  // חלק Input Optimization (chat-ui-optimizations.js) – אופטימיזציה להקלדה | HYPER CORE TECH
  function optimizeMessageInput(inputElement) {
    if (!inputElement) return;
    // מונע האזנה כפולה (enhanced composer + DOMContentLoaded) | HYPER CORE TECH
    if (inputElement.dataset.heightOptimized === '1') return;
    inputElement.dataset.heightOptimized = '1';
    
    // מניעת reflow מיותר
    inputElement.style.willChange = 'contents';
    
    // debounce לאירועי input
    const debouncedInput = debounce((e) => {
      // כאן אפשר להוסיף לוגיקה כמו "מקליד..."
      if (typeof App.onChatInputChange === 'function') {
        App.onChatInputChange(e.target.value);
      }
    }, 300);
    
    inputElement.addEventListener('input', debouncedInput);

    // דסקטופ: Enter שולח, Shift+Enter שורה חדשה. מובייל נשאר עם שורה חדשה וכפתור שליחה | HYPER CORE TECH
    inputElement.addEventListener('keydown', (event) => {
      if (!isDesktopChat()) return;
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      const form = inputElement.form || inputElement.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // הדבקת צילום מסך או קובץ מהלוח פותחת את התצוגה המקדימה. טקסט נשאר הדבקה רגילה | HYPER CORE TECH
    inputElement.addEventListener('paste', (event) => {
      if (!isDesktopChat()) return;
      const files = filesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      deliverPastedFiles(files);
    });
    
    // גובה דינמי – בהקלדה גדל; מחיקה ידנית מאפסת (שליחה מאפסת ב-chat-ui.js) | HYPER CORE TECH
    inputElement.addEventListener('input', function() {
      if (!this.value) {
        this.style.height = '';
        return;
      }
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }
  
  // חלק Event Delegation (chat-ui-optimizations.js) – ניהול אירועים יעיל | HYPER CORE TECH
  function setupEfficientEventHandlers(container) {
    if (!container) return;
    
    // במקום listener לכל כפתור, listener אחד על הקונטיינר
    container.addEventListener('click', (e) => {
      const deleteBtn = e.target.closest('[data-chat-delete]');
      if (deleteBtn) {
        const messageId = deleteBtn.getAttribute('data-chat-delete');
        if (typeof App.handleChatMessageDelete === 'function') {
          App.handleChatMessageDelete(messageId);
        }
        return;
      }
      
      const playBtn = e.target.closest('.chat-audio__play');
      if (playBtn) {
        e.stopPropagation();
        return;
      }
      
      const image = e.target.closest('.chat-message__image');
      if (image) {
        const src = image.getAttribute('src');
        const alt = image.getAttribute('alt');
        if (typeof App.openImageLightbox === 'function') {
          App.openImageLightbox(src, alt, image);
        }
        return;
      }
    }, { passive: false });
  }
  
  // חלק Lazy Loading (chat-ui-optimizations.js) – טעינה עצלה לתמונות | HYPER CORE TECH
  function setupLazyLoading() {
    if ('IntersectionObserver' in window) {
      const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target;
            const src = img.getAttribute('data-src');
            if (src) {
              img.setAttribute('src', src);
              img.removeAttribute('data-src');
              observer.unobserve(img);
            }
          }
        });
      }, {
        rootMargin: '50px 0px',
        threshold: 0.01
      });
      
      return imageObserver;
    }
    return null;
  }
  
  // חלק Memory Management (chat-ui-optimizations.js) – ניהול זיכרון | HYPER CORE TECH
  function cleanupOldMessages(container, maxMessages = 100) {
    if (!container) return;
    
    const messages = container.querySelectorAll('.chat-message');
    if (messages.length > maxMessages) {
      const toRemove = messages.length - maxMessages;
      for (let i = 0; i < toRemove; i++) {
        const msg = messages[i];
        // ניקוי event listeners
        const audio = msg.querySelector('audio');
        if (audio) {
          audio.pause();
          audio.src = '';
        }
        const video = msg.querySelector('video');
        if (video) {
          video.pause();
          video.src = '';
        }
        msg.remove();
      }
    }
  }
  
  // חלק Render Batching (chat-ui-optimizations.js) – קיבוץ עדכוני DOM | HYPER CORE TECH
  class RenderBatcher {
    constructor() {
      this.pending = [];
      this.rafId = null;
    }
    
    schedule(callback) {
      this.pending.push(callback);
      
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(() => {
          const callbacks = this.pending.slice();
          this.pending = [];
          this.rafId = null;
          
          callbacks.forEach(cb => {
            try {
              cb();
            } catch (err) {
              console.error('Render batch error:', err);
            }
          });
        });
      }
    }
    
    cancel() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.pending = [];
    }
  }
  
  const renderBatcher = new RenderBatcher();
  
  // חלק API ציבורי (chat-ui-optimizations.js) – חשיפת כלי אופטימיזציה | HYPER CORE TECH
  Object.assign(App, {
    chatDebounce: debounce,
    chatThrottle: throttle,
    VirtualMessageList,
    optimizeMessageInput,
    setupEfficientEventHandlers,
    setupLazyLoading,
    cleanupOldMessages,
    chatRenderBatcher: renderBatcher
  });
  
  console.log('Chat UI optimizations loaded');
})(window);
