/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TIKTOK.JS - TikTok-Style Vertical Video Feed
 * Handles swipe navigation, 100vh fix, double-tap like, and touch interactions
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function() {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // iOS SAFARI 100vh BUG FIX
    // ─────────────────────────────────────────────────────────────────────────
    
    const setAppHeight = () => {
        const vh = window.innerHeight;
        document.documentElement.style.setProperty('--app-height', `${vh}px`);
        document.documentElement.style.setProperty('--safe-top', 'env(safe-area-inset-top, 0px)');
        document.documentElement.style.setProperty('--safe-bottom', 'env(safe-area-inset-bottom, 0px)');
    };

    setAppHeight();
    window.addEventListener('resize', setAppHeight);
    window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 100));

    // ─────────────────────────────────────────────────────────────────────────
    // VIDEO FEED CONTROLLER
    // ─────────────────────────────────────────────────────────────────────────
    
    const VideoFeed = {
        container: null,
        items: [],
        currentIndex: 0,
        isScrolling: false,
        
        init() {
            this.container = document.getElementById('videoFeed');
            if (!this.container) return;
            
            this.items = Array.from(document.querySelectorAll('.video-item'));
            
            // Set up scroll snap behavior
            this.container.addEventListener('scroll', this.onScroll.bind(this), { passive: true });
            this.container.addEventListener('scrollend', this.onScrollEnd.bind(this), { passive: true });
            
            // Fallback for browsers without scrollend
            let scrollTimeout;
            this.container.addEventListener('scroll', () => {
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => this.onScrollEnd(), 150);
            }, { passive: true });
            
            // Double-tap to like
            this.setupDoubleTap();
            
            // Initialize first video
            this.updateActiveVideo(0);
        },
        
        onScroll() {
            this.isScrolling = true;
        },
        
        onScrollEnd() {
            this.isScrolling = false;
            
            // Calculate which video is most visible
            const scrollTop = this.container.scrollTop;
            const itemHeight = this.items[0]?.offsetHeight || window.innerHeight;
            const newIndex = Math.round(scrollTop / itemHeight);
            
            if (newIndex !== this.currentIndex && newIndex >= 0 && newIndex < this.items.length) {
                this.updateActiveVideo(newIndex);
            }
        },
        
        updateActiveVideo(index) {
            // Remove active from previous
            this.items[this.currentIndex]?.classList.remove('active');
            
            // Set new active
            this.currentIndex = index;
            this.items[index]?.classList.add('active');
            
            // Pause music disc animation on inactive videos
            this.items.forEach((item, i) => {
                const disc = item.querySelector('.music-disc');
                if (disc) {
                    disc.style.animationPlayState = i === index ? 'running' : 'paused';
                }
            });
        },
        
        goToVideo(index) {
            if (index < 0 || index >= this.items.length) return;
            
            const itemHeight = this.items[0]?.offsetHeight || window.innerHeight;
            this.container.scrollTo({
                top: index * itemHeight,
                behavior: 'smooth'
            });
        },
        
        nextVideo() {
            this.goToVideo(this.currentIndex + 1);
        },
        
        prevVideo() {
            this.goToVideo(this.currentIndex - 1);
        },
        
        setupDoubleTap() {
            let lastTap = 0;
            let tapTimeout;
            
            this.container.addEventListener('click', (e) => {
                const currentTime = new Date().getTime();
                const tapLength = currentTime - lastTap;
                
                clearTimeout(tapTimeout);
                
                if (tapLength < 300 && tapLength > 0) {
                    // Double tap detected
                    this.handleDoubleTap(e);
                    e.preventDefault();
                } else {
                    // Single tap - could toggle play/pause
                    tapTimeout = setTimeout(() => {
                        // Single tap action (optional)
                    }, 300);
                }
                
                lastTap = currentTime;
            });
        },
        
        handleDoubleTap(e) {
            const videoItem = e.target.closest('.video-item');
            if (!videoItem) return;
            
            // Find the like button and toggle it
            const likeBtn = videoItem.querySelector('.action-btn');
            if (likeBtn) {
                likeBtn.classList.toggle('liked');
            }
            
            // Show heart animation at tap position
            this.showLikeAnimation(e.clientX, e.clientY, videoItem);
        },
        
        showLikeAnimation(x, y, container) {
            // Create heart element
            const heart = document.createElement('div');
            heart.className = 'like-animation show';
            heart.innerHTML = `
                <svg viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
            `;
            
            // Position at tap location
            heart.style.left = x + 'px';
            heart.style.top = y + 'px';
            heart.style.position = 'fixed';
            
            document.body.appendChild(heart);
            
            // Remove after animation
            setTimeout(() => heart.remove(), 800);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // LIKE BUTTON HANDLER
    // ─────────────────────────────────────────────────────────────────────────
    
    const setupLikeButtons = () => {
        document.querySelectorAll('.action-btn').forEach((btn, index) => {
            // Only first button in each group is the like button
            if (index % 3 === 0) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    btn.classList.toggle('liked');
                    
                    // Update count (demo)
                    const countEl = btn.querySelector('span');
                    if (countEl) {
                        const isLiked = btn.classList.contains('liked');
                        // Simple demo toggle
                        if (isLiked) {
                            countEl.textContent = countEl.textContent.replace('K', '.1K');
                        }
                    }
                });
            }
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // TAB SWITCHING
    // ─────────────────────────────────────────────────────────────────────────
    
    const setupTabs = () => {
        const tabs = document.querySelectorAll('.tab-btn');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
            });
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // BOTTOM NAV
    // ─────────────────────────────────────────────────────────────────────────
    
    const setupBottomNav = () => {
        const navItems = document.querySelectorAll('.tiktok-nav .nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                if (item.classList.contains('create-btn')) {
                    // Create button action
                    e.preventDefault();
                    alert('יצירת סרטון חדש');
                    return;
                }
                
                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');
            });
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // FOLLOW BUTTON
    // ─────────────────────────────────────────────────────────────────────────
    
    const setupFollowButtons = () => {
        document.querySelectorAll('.follow-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.textContent === '+') {
                    btn.textContent = '✓';
                    btn.style.background = '#28a745';
                } else {
                    btn.textContent = '+';
                    btn.style.background = '#fe2c55';
                }
            });
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // KEYBOARD NAVIGATION (for testing on desktop)
    // ─────────────────────────────────────────────────────────────────────────
    
    const setupKeyboardNav = () => {
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowDown':
                case 'j':
                    VideoFeed.nextVideo();
                    break;
                case 'ArrowUp':
                case 'k':
                    VideoFeed.prevVideo();
                    break;
                case 'l':
                    // Like current video
                    const currentItem = VideoFeed.items[VideoFeed.currentIndex];
                    const likeBtn = currentItem?.querySelector('.action-btn');
                    likeBtn?.click();
                    break;
            }
        });
    };

    // ─────────────────────────────────────────────────────────────────────────
    // INITIALIZE
    // ─────────────────────────────────────────────────────────────────────────
    
    const init = () => {
        VideoFeed.init();
        setupLikeButtons();
        setupTabs();
        setupBottomNav();
        setupFollowButtons();
        setupKeyboardNav();
        
        console.log('TikTok Feed initialized', {
            videos: VideoFeed.items.length,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
