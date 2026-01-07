/**
 * ═══════════════════════════════════════════════════════════════════════════
 * UI.JS - Mobile Utilities & 100vh Bug Fix
 * Handles iOS Safari viewport height, touch interactions, and mobile UX
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function() {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // iOS SAFARI 100vh BUG FIX
    // Safari on iOS reports 100vh including the address bar, causing content
    // to be hidden. This fix measures the actual viewport and sets a CSS variable.
    // ─────────────────────────────────────────────────────────────────────────
    
    const setAppHeight = () => {
        // Get the actual visible viewport height
        const vh = window.innerHeight;
        
        // Set CSS custom property
        document.documentElement.style.setProperty('--app-height', `${vh}px`);
        
        // Also set individual vh unit for calculations
        document.documentElement.style.setProperty('--vh', `${vh * 0.01}px`);
    };

    // Set initial height
    setAppHeight();

    // Update on resize (includes orientation change)
    window.addEventListener('resize', setAppHeight);
    
    // Update on orientation change (some browsers need this separately)
    window.addEventListener('orientationchange', () => {
        // Delay to allow browser to complete orientation change
        setTimeout(setAppHeight, 100);
    });

    // Update when page becomes visible (fixes issues after tab switch)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            setAppHeight();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PREVENT OVERSCROLL/BOUNCE ON iOS
    // Prevents the rubber-band scrolling effect on iOS Safari
    // ─────────────────────────────────────────────────────────────────────────
    
    const preventOverscroll = () => {
        let startY = 0;
        
        document.addEventListener('touchstart', (e) => {
            startY = e.touches[0].pageY;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const scrollableElements = document.querySelectorAll('.app-main, .modal-body, .feed-container, .scroll-container');
            
            // Check if we're inside a scrollable element
            let isInScrollable = false;
            let scrollableParent = null;
            
            for (const el of scrollableElements) {
                if (el.contains(e.target)) {
                    isInScrollable = true;
                    scrollableParent = el;
                    break;
                }
            }
            
            if (!isInScrollable) {
                // Not in a scrollable area, prevent default
                if (e.cancelable) {
                    e.preventDefault();
                }
                return;
            }
            
            // Check if at scroll boundaries
            const currentY = e.touches[0].pageY;
            const isAtTop = scrollableParent.scrollTop <= 0;
            const isAtBottom = scrollableParent.scrollTop + scrollableParent.clientHeight >= scrollableParent.scrollHeight;
            const isScrollingUp = currentY > startY;
            const isScrollingDown = currentY < startY;
            
            // Prevent overscroll at boundaries
            if ((isAtTop && isScrollingUp) || (isAtBottom && isScrollingDown)) {
                if (e.cancelable) {
                    e.preventDefault();
                }
            }
        }, { passive: false });
    };

    // Only apply on iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        preventOverscroll();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // THEME TOGGLE
    // Handles dark/light mode switching with system preference detection
    // ─────────────────────────────────────────────────────────────────────────
    
    const ThemeManager = {
        STORAGE_KEY: 'ui-kit-theme',
        
        init() {
            // Check for saved preference, then system preference
            const savedTheme = localStorage.getItem(this.STORAGE_KEY);
            
            if (savedTheme) {
                this.setTheme(savedTheme);
            } else {
                // Use system preference
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                this.setTheme(prefersDark ? 'dark' : 'light');
            }
            
            // Listen for system preference changes
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (!localStorage.getItem(this.STORAGE_KEY)) {
                    this.setTheme(e.matches ? 'dark' : 'light');
                }
            });
        },
        
        setTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            
            // Update meta theme-color for browser chrome
            const metaThemeColor = document.querySelector('meta[name="theme-color"]');
            if (metaThemeColor) {
                metaThemeColor.setAttribute('content', theme === 'dark' ? '#0a0a0f' : '#f8fafc');
            }
        },
        
        toggle() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            this.setTheme(newTheme);
            localStorage.setItem(this.STORAGE_KEY, newTheme);
        },
        
        getTheme() {
            return document.documentElement.getAttribute('data-theme') || 'dark';
        }
    };

    // Initialize theme
    ThemeManager.init();
    
    // Expose to global scope
    window.ThemeManager = ThemeManager;

    // ─────────────────────────────────────────────────────────────────────────
    // TOUCH FEEDBACK
    // Adds visual feedback for touch interactions
    // ─────────────────────────────────────────────────────────────────────────
    
    const TouchFeedback = {
        init() {
            // Add active state class on touch for better feedback
            const interactiveElements = document.querySelectorAll('.btn, .icon-btn, .card-interactive, .nav-item, .list-item, .chip');
            
            interactiveElements.forEach(el => {
                el.addEventListener('touchstart', () => {
                    el.classList.add('touch-active');
                }, { passive: true });
                
                el.addEventListener('touchend', () => {
                    el.classList.remove('touch-active');
                }, { passive: true });
                
                el.addEventListener('touchcancel', () => {
                    el.classList.remove('touch-active');
                }, { passive: true });
            });
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // BOTTOM NAV ACTIVE STATE
    // Handles navigation item activation
    // ─────────────────────────────────────────────────────────────────────────
    
    const BottomNav = {
        init() {
            const navItems = document.querySelectorAll('.nav-item');
            
            navItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    // Remove active from all
                    navItems.forEach(nav => nav.classList.remove('active'));
                    // Add active to clicked
                    item.classList.add('active');
                });
            });
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // SAFE AREA DETECTION
    // Detects if device has safe areas (notch, home indicator)
    // ─────────────────────────────────────────────────────────────────────────
    
    const SafeAreaDetector = {
        init() {
            // Check if device has safe areas
            const hasSafeArea = CSS.supports('padding-top: env(safe-area-inset-top)');
            
            if (hasSafeArea) {
                document.documentElement.classList.add('has-safe-area');
            }
            
            // Detect notch position (for future use)
            const isLandscape = window.innerWidth > window.innerHeight;
            document.documentElement.setAttribute('data-orientation', isLandscape ? 'landscape' : 'portrait');
            
            window.addEventListener('resize', () => {
                const isLandscape = window.innerWidth > window.innerHeight;
                document.documentElement.setAttribute('data-orientation', isLandscape ? 'landscape' : 'portrait');
            });
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // REDUCED MOTION DETECTION
    // Respects user's motion preferences
    // ─────────────────────────────────────────────────────────────────────────
    
    const MotionManager = {
        init() {
            const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
            
            const updateMotionPreference = () => {
                if (prefersReducedMotion.matches) {
                    document.documentElement.classList.add('reduced-motion');
                } else {
                    document.documentElement.classList.remove('reduced-motion');
                }
            };
            
            updateMotionPreference();
            prefersReducedMotion.addEventListener('change', updateMotionPreference);
        },
        
        isReduced() {
            return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // SCROLL UTILITIES
    // Smooth scroll and scroll position management
    // ─────────────────────────────────────────────────────────────────────────
    
    const ScrollManager = {
        // Scroll to element with offset for header
        scrollTo(element, offset = 0) {
            if (!element) return;
            
            const headerHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 56;
            const top = element.getBoundingClientRect().top + window.pageYOffset - headerHeight - offset;
            
            if (MotionManager.isReduced()) {
                window.scrollTo({ top });
            } else {
                window.scrollTo({ top, behavior: 'smooth' });
            }
        },
        
        // Scroll to top
        scrollToTop() {
            if (MotionManager.isReduced()) {
                window.scrollTo({ top: 0 });
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        },
        
        // Lock scroll (for modals)
        lock() {
            const scrollY = window.scrollY;
            document.body.style.position = 'fixed';
            document.body.style.top = `-${scrollY}px`;
            document.body.style.width = '100%';
            document.body.dataset.scrollY = scrollY;
        },
        
        // Unlock scroll
        unlock() {
            const scrollY = document.body.dataset.scrollY || 0;
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            window.scrollTo(0, parseInt(scrollY));
            delete document.body.dataset.scrollY;
        }
    };

    // Expose to global scope
    window.ScrollManager = ScrollManager;

    // ─────────────────────────────────────────────────────────────────────────
    // TOAST NOTIFICATIONS
    // Simple toast notification system
    // ─────────────────────────────────────────────────────────────────────────
    
    const Toast = {
        container: null,
        
        init() {
            // Create toast container if it doesn't exist
            if (!this.container) {
                this.container = document.createElement('div');
                this.container.className = 'toast-container';
                document.body.appendChild(this.container);
            }
        },
        
        show(message, type = 'info', duration = 3000) {
            this.init();
            
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            toast.textContent = message;
            
            this.container.appendChild(toast);
            
            // Remove after duration
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(20px)';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        },
        
        success(message, duration) {
            this.show(message, 'success', duration);
        },
        
        error(message, duration) {
            this.show(message, 'error', duration);
        },
        
        warning(message, duration) {
            this.show(message, 'warning', duration);
        },
        
        info(message, duration) {
            this.show(message, 'info', duration);
        }
    };

    // Expose to global scope
    window.Toast = Toast;

    // ─────────────────────────────────────────────────────────────────────────
    // FORM UTILITIES
    // Prevents zoom on input focus for iOS
    // ─────────────────────────────────────────────────────────────────────────
    
    const FormUtils = {
        init() {
            // iOS Safari zooms in when focusing inputs with font-size < 16px
            // This is handled in CSS, but we can also dynamically adjust
            const inputs = document.querySelectorAll('input, select, textarea');
            
            inputs.forEach(input => {
                // Ensure minimum font size on focus (backup for CSS)
                input.addEventListener('focus', () => {
                    const computedSize = parseFloat(getComputedStyle(input).fontSize);
                    if (computedSize < 16) {
                        input.style.fontSize = '16px';
                    }
                });
            });
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // INITIALIZE ALL MODULES
    // ─────────────────────────────────────────────────────────────────────────
    
    const init = () => {
        SafeAreaDetector.init();
        MotionManager.init();
        TouchFeedback.init();
        BottomNav.init();
        FormUtils.init();
        
        // Log initialization
        console.log('UI Kit initialized', {
            theme: ThemeManager.getTheme(),
            reducedMotion: MotionManager.isReduced(),
            isIOS: isIOS,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight
            }
        });
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITY FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────
    
    // Debounce function for resize handlers
    window.debounce = (func, wait) => {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    };

    // Throttle function for scroll handlers
    window.throttle = (func, limit) => {
        let inThrottle;
        return function executedFunction(...args) {
            if (!inThrottle) {
                func(...args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    };

})();
