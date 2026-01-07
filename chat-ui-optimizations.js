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
  
  // חלק Input Optimization (chat-ui-optimizations.js) – אופטימיזציה להקלדה | HYPER CORE TECH
  function optimizeMessageInput(inputElement) {
    if (!inputElement) return;
    
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
    
    // אופטימיזציה לגובה דינמי
    inputElement.addEventListener('input', function() {
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
          App.openImageLightbox(src, alt);
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
