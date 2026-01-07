(function () {
  if (typeof FEED_CACHE_LIMIT === 'undefined') window.FEED_CACHE_LIMIT = 60;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
 
  document.addEventListener('DOMContentLoaded', () => {
    if (isIOS && typeof window.removeVideoCard === 'function' && !window.removeVideoCard.__iosPatched) {
      window.removeVideoCard = function (eventId) {
        if (!eventId) return;
        const viewport = document.querySelector('.videos-feed__viewport');
        const stream = document.querySelector('.videos-feed__stream');
        const card = stream?.querySelector(`.videos-feed__card[data-event-id="${eventId}"]`);
        if (!card) return;

        if (viewport) {
          const cardRect = card.getBoundingClientRect();
          const viewportRect = viewport.getBoundingClientRect();
          if (cardRect.bottom <= viewportRect.top) {
            const prevTop = viewport.scrollTop;
            const h = cardRect.height || card.offsetHeight || 0;
            card.remove();
            if (h) {
              requestAnimationFrame(() => {
                viewport.style.scrollBehavior = 'auto';
                viewport.scrollTop = Math.max(0, prevTop - h);
                viewport.style.scrollBehavior = '';
              });
            }
            return;
          }
        }

        card.remove();
      };
      window.removeVideoCard.__iosPatched = true;
    }

    if (typeof window.setupInfiniteLoop === 'function' && !window.setupInfiniteLoop.__sosPatched) {
      window.setupInfiniteLoop = function () {
        const viewport = document.querySelector('.videos-feed__viewport');
        const stream = document.querySelector('.videos-feed__stream');
        if (!viewport || !stream) return;
        if (viewport.__sosInfiniteLoopBound) return;
        viewport.__sosInfiniteLoopBound = true;

        let currentIndex = 0;
        const getCards = () => document.querySelectorAll('.videos-feed__card:not(.clone)');
        const getCardCount = () => getCards().length;
        const canLoop = () => {
          const n = getCardCount();
          return n > 0 && n <= 20;
        };

        let scrollTimeout = null;
        let lastScrollTop = 0;
        let isJumping = false;

        const jumpToEnd = () => {
          if (!canLoop() || isJumping) return;
          isJumping = true;
          const cards = getCards();
          const maxScroll = viewport.scrollHeight - viewport.clientHeight;
          viewport.style.scrollBehavior = 'auto';
          viewport.scrollTop = maxScroll;
          viewport.style.scrollBehavior = '';
          currentIndex = cards.length - 1;
          lastScrollTop = maxScroll;
          setTimeout(() => { isJumping = false; }, 200);
        };

        const jumpToStart = () => {
          if (!canLoop() || isJumping) return;
          isJumping = true;
          viewport.style.scrollBehavior = 'auto';
          viewport.scrollTop = 0;
          viewport.style.scrollBehavior = '';
          currentIndex = 0;
          lastScrollTop = 0;
          setTimeout(() => { isJumping = false; }, 200);
        };

        viewport.addEventListener('wheel', (e) => {
          if (!canLoop()) return;
          const maxScroll = viewport.scrollHeight - viewport.clientHeight;
          if (viewport.scrollTop <= 5 && e.deltaY < 0) {
            e.preventDefault();
            jumpToEnd();
            return;
          }
          if (viewport.scrollTop >= maxScroll - 5 && e.deltaY > 0) {
            e.preventDefault();
            jumpToStart();
          }
        }, { passive: false });

        let touchStartY = 0;
        let touchStartAtTop = false;
        let touchStartAtBottom = false;
        viewport.addEventListener('touchstart', (e) => {
          touchStartY = e.touches[0].clientY;
          const maxScroll = viewport.scrollHeight - viewport.clientHeight;
          touchStartAtTop = viewport.scrollTop <= 5;
          touchStartAtBottom = viewport.scrollTop >= maxScroll - 5;
        }, { passive: true });

        viewport.addEventListener('touchend', (e) => {
          if (!canLoop()) return;
          const touchEndY = e.changedTouches[0].clientY;
          const deltaY = touchStartY - touchEndY;
          if (touchStartAtTop && deltaY < -30) {
            jumpToEnd();
            return;
          }
          if (touchStartAtBottom && deltaY > 30) {
            jumpToStart();
          }
        }, { passive: true });

        viewport.addEventListener('scroll', () => {
          if (scrollTimeout) clearTimeout(scrollTimeout);
          if (isJumping) return;

          scrollTimeout = setTimeout(() => {
            const cards = getCards();
            const cardCount = cards.length;
            if (cardCount === 0) return;

            const viewportTop = viewport.scrollTop;
            lastScrollTop = viewportTop;

            const safeTop = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-top') || '0', 10);
            const headerOffset = 44 + safeTop;
            for (let i = 0; i < cardCount; i++) {
              const card = cards[i];
              const cardTop = card.offsetTop - headerOffset;
              if (cardTop >= viewportTop - 50 && cardTop <= viewportTop + 50) {
                currentIndex = i;
                break;
              }
            }
          }, 100);
        }, { passive: true });

        document.addEventListener('keydown', (e) => {
          if (!document.querySelector('.videos-feed')) return;

          const cards = getCards();
          const cardCount = cards.length;
          if (cardCount === 0) return;

          if (e.key === 'ArrowDown' || e.key === 'j') {
            e.preventDefault();
            currentIndex = canLoop() ? (currentIndex + 1) % cardCount : Math.min(currentIndex + 1, cardCount - 1);
            cards[currentIndex]?.scrollIntoView({ behavior: 'auto', block: 'start' });
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            e.preventDefault();
            currentIndex = canLoop() ? (currentIndex - 1 + cardCount) % cardCount : Math.max(currentIndex - 1, 0);
            cards[currentIndex]?.scrollIntoView({ behavior: 'auto', block: 'start' });
          }
        });

        window.videoFeedNav = { getCurrentIndex: () => currentIndex, getCardCount };
      };

      window.setupInfiniteLoop.__sosPatched = true;
    }
  }, { once: true });
})();
