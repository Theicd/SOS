# UI Kit Mobile - 100% Mobile Compatible

מערכת עיצוב מותאמת במלואה למובייל (Android + iPhone) לכל גדלי המסכים (320px עד 4K).

## תכונות

### 🔒 Safe Areas
- תמיכה מלאה ב-Notch (iPhone X+)
- תמיכה ב-Home Indicator
- תמיכה ב-Android Cutouts
- טוקנים: `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left`

### 📱 100vh Bug Fix (iOS Safari)
- תיקון אוטומטי לבעיית ה-100vh באייפון
- JavaScript שמעדכן `--app-height` בזמן אמת
- תמיכה ב-`100dvh` כאשר נתמך

### 👆 Touch Optimization
- יעדי מגע מינימום 44px (WCAG 2.1 AAA)
- הסרת tap highlight
- מניעת zoom בזמן פוקוס על input
- גלילה חלקה (`-webkit-overflow-scrolling: touch`)
- מניעת overscroll bounce

### 📐 Breakpoints
| טווח | תיאור |
|------|-------|
| 320-359px | מכשירים קטנים (iPhone SE) |
| 360-479px | רוב מכשירי Android |
| 480-767px | טלפונים גדולים / טאבלטים קטנים |
| 768-1023px | טאבלטים (iPad) |
| 1024-1439px | דסקטופ קטן / טאבלטים גדולים |
| 1440px+ | דסקטופ |

### ♿ נגישות
- תמיכה ב-`prefers-reduced-motion`
- תמיכה ב-`prefers-color-scheme`
- Focus states נגישים
- יעדי מגע מתאימים

## מבנה הקבצים

```
ui-kit-mobile/
├── index.html          # דף דמו עם כל הרכיבים
├── css/
│   ├── tokens.css      # Design tokens (Safe Areas, Touch, Colors, Spacing)
│   ├── base.css        # Reset & iOS/Android fixes
│   ├── layout.css      # App Shell, Header, Bottom Nav, Feed
│   ├── components.css  # UI Components (Buttons, Cards, Forms)
│   └── responsive.css  # Breakpoints & Media Queries
├── js/
│   └── ui.js           # 100vh fix, Theme, Toast, Scroll utilities
└── README.md
```

## שימוש

### הוספה לפרויקט

```html
<!DOCTYPE html>
<html dir="rtl" lang="he" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#000000">
    <meta name="color-scheme" content="dark light">
    
    <link rel="stylesheet" href="css/tokens.css">
    <link rel="stylesheet" href="css/base.css">
    <link rel="stylesheet" href="css/layout.css">
    <link rel="stylesheet" href="css/components.css">
    <link rel="stylesheet" href="css/responsive.css">
</head>
<body>
    <div class="app-shell">
        <!-- Header -->
        <header class="app-header">...</header>
        
        <!-- Main Content -->
        <main class="app-main">
            <div class="feed-container">
                <!-- Your content -->
            </div>
        </main>
        
        <!-- Bottom Navigation -->
        <nav class="bottom-nav">...</nav>
    </div>
    
    <script src="js/ui.js"></script>
</body>
</html>
```

### CSS Variables חשובים

```css
/* Safe Areas */
padding-top: calc(var(--space-4) + var(--safe-top));
padding-bottom: calc(var(--space-4) + var(--safe-bottom));

/* Touch Target */
min-height: var(--tap-min); /* 44px */

/* Dynamic Viewport Height */
height: var(--app-height);
```

### JavaScript API

```javascript
// Theme
ThemeManager.toggle();
ThemeManager.setTheme('dark');
ThemeManager.getTheme(); // 'dark' | 'light'

// Scroll
ScrollManager.scrollTo(element, offset);
ScrollManager.scrollToTop();
ScrollManager.lock();   // For modals
ScrollManager.unlock();

// Toast
Toast.success('הצלחה!');
Toast.error('שגיאה');
Toast.warning('אזהרה');
Toast.info('מידע');

// Utilities
debounce(func, wait);
throttle(func, limit);
```

## דפדפנים נתמכים

- ✅ iOS Safari 13+
- ✅ Chrome for Android 80+
- ✅ Samsung Internet 12+
- ✅ Chrome 80+
- ✅ Firefox 75+
- ✅ Safari 13+
- ✅ Edge 80+

## רישיון

MIT License
