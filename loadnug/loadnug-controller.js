/* ============================================================
   SOS · LOADNUG — Controller
   Real WebGL 3D city fly-through (full page).
   Big captions + SOS/bar overlaid on top.
   Always replays on refresh. Canvas2D fallback if WebGL fails.
   ============================================================ */

// זמנים מקוריים מ-LOADNUG – לא לשנות | HYPER CORE TECH
const DURATION = 90;
const SAFETY_HOLD = 20;

const STORY_BEATS = [
  {
    t: 0,
    title: 'רשת חברתית מבוזרת',
    sub: 'האנשים הם הרשת — בלי שרת מרכזי אחד',
  },
  {
    t: 12,
    title: 'חופש ממעקב',
    sub: 'הנתונים שלך נשארים אצלך — לא נמכרים ולא נאספים',
  },
  {
    t: 26,
    title: 'חיבור ישיר בין אנשים',
    sub: 'כל משתמש מדבר עם משתמשים אחרים ברשת',
  },
  {
    t: 42,
    title: 'שיתוף מבוזר ומהיר',
    sub: 'פוסטים ומדיה עוברים ברחבי הרשת בלי צוואר בקבוק',
  },
  {
    t: 58,
    title: 'קידמה בלי שליטה מרכזית',
    sub: 'ממסרים ואחסון פתוחים — הרשת נשארת חיה בידיים שלך',
  },
  {
    t: 74,
    title: 'טוענים את הפיד שלך',
    sub: 'התוכן עולה מהרשת המבוזרת — פרטי, חופשי, שלך',
  },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function cssHref() {
  try { return new URL('loadnug-animation.css', import.meta.url).href; }
  catch (e) { return 'loadnug-animation.css'; }
}
function sceneHref() {
  try { return new URL('loadnug-scene.js', import.meta.url).href; }
  catch (e) { return 'loadnug-scene.js'; }
}
function fallbackHref() {
  try { return new URL('loadnug-fallback.js', import.meta.url).href; }
  catch (e) { return 'loadnug-fallback.js'; }
}
function iconHref() {
  try { return new URL('loadnug-icon.png', import.meta.url).href; }
  catch (e) { return 'loadnug-icon.png'; }
}
function queryFlag() {
  try { return new URLSearchParams(location.search).get('loadnug'); }
  catch (e) { return null; }
}
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (e) { return false; }
}
function isMobile() {
  try { return matchMedia('(max-width: 820px), (pointer: coarse)').matches; }
  catch (e) { return false; }
}

export class LoadNugController {
  constructor() {
    this.overlay = null;
    this.canvas = null;
    this.renderer = null;
    this._observer = null;
    this._onResize = null;
    this._done = false;
    this._appReady = false;
    this._cinematicDone = false;
    this._barVal = 0;
    this._holdInt = null;
    this._safetyTO = null;
    this._statusEl = null;
    this._storyTitle = null;
    this._storySub = null;
    this._lastBeat = -1;
    this._barEls = [];
    this._pctEls = [];
    this._progressEls = [];
  }

  _mount() {
    const crit = document.createElement('style');
    crit.id = 'sos-loadnug-critical';
    // Critical CSS: בין ההדר לתפריט התחתון בלבד – תחת z-index של הכרום | HYPER CORE TECH
    crit.textContent = 'body.sos-loadnug-active .top-bar{position:fixed!important;z-index:3000!important;left:0;right:0;top:0}body.sos-loadnug-active .primary-nav{z-index:3000!important}#sosLoadNugOverlay{position:fixed;top:calc(44px + var(--safe-top,0px));bottom:calc(56px + var(--safe-bottom,0px));left:0;right:0;background:#070b19;z-index:100;opacity:1;transition:opacity .7s ease;pointer-events:auto}#sosLoadNugOverlay.sos-loadnug--leaving{opacity:0;pointer-events:none}#sosLoadNugCanvas{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1}';
    if (!document.getElementById('sos-loadnug-critical')) document.head.appendChild(crit);

    if (!document.querySelector('link[data-sos-loadnug-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssHref();
      link.setAttribute('data-sos-loadnug-css', '1');
      document.head.appendChild(link);
    }

    const ov = document.createElement('div');
    ov.id = 'sosLoadNugOverlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'SOS loading');
    ov.setAttribute('aria-busy', 'true');
    ov.innerHTML = `
      <canvas id="sosLoadNugCanvas" aria-hidden="true"></canvas>

      <div class="sos-loadnug__loader">
        <img class="sos-loadnug__icon" alt="" referrerpolicy="no-referrer" />
        <div class="sos-loadnug__logo" aria-label="SOS"><span class="ln-s">S</span><span class="ln-o">O</span><span class="ln-s">S</span></div>
        <div class="sos-loadnug__loading">Loading</div>
        <div class="sos-loadnug__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="sos-loadnug__bar"></div>
        </div>
        <div class="sos-loadnug__pct">0%</div>
        <p class="sos-loadnug__status">מתחבר לרשת...</p>
        <div class="sos-loadnug__explain" aria-live="polite">
          <p class="sos-loadnug__explain-title">רשת חברתית מבוזרת</p>
          <p class="sos-loadnug__explain-sub">האנשים הם הרשת — בלי שרת מרכזי אחד</p>
        </div>
      </div>`;
    // body + class כדי להבטיח שההדר והתפריט התחתון מעל המד | HYPER CORE TECH
    document.body.classList.add('sos-loadnug-active');
    document.body.appendChild(ov);

    this.overlay = ov;
    this.canvas = ov.querySelector('#sosLoadNugCanvas');
    this.iconEl = ov.querySelector('.sos-loadnug__icon');
    this._statusEl = ov.querySelector('.sos-loadnug__status');
    this._storyTitle = ov.querySelector('.sos-loadnug__explain-title');
    this._storySub = ov.querySelector('.sos-loadnug__explain-sub');
    this._barEls = Array.from(ov.querySelectorAll('.sos-loadnug__bar'));
    this._pctEls = Array.from(ov.querySelectorAll('.sos-loadnug__pct'));
    this._progressEls = Array.from(ov.querySelectorAll('.sos-loadnug__progress'));

    this.iconEl.src = iconHref();
    this.iconEl.onerror = () => { try { this.iconEl.style.display = 'none'; } catch (e) {} };

    this._applyStoryBeat(STORY_BEATS[0], 0);
    this._setBar(0);
    return ov;
  }

  _freshCanvas() {
    const fresh = document.createElement('canvas');
    fresh.id = 'sosLoadNugCanvas';
    fresh.setAttribute('aria-hidden', 'true');
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.replaceChild(fresh, this.canvas);
    }
    this.canvas = fresh;
    return fresh;
  }

  async start() {
    if (this._done) return;
    if (queryFlag() === 'skip' || queryFlag() === '0') return;

    this._mount();
    this._wireIntegration();

    const mobile = isMobile();
    const force = queryFlag();
    const opts = {
      quality: mobile ? 0.7 : 1.05,
      duration: DURATION,
      mobile,
      onProgress: (p) => {
        const v = p * 90;
        if (v > this._barVal) this._setBar(v);
        this._updateStoryFromTime(p * DURATION);
      },
      onPhase: (ph) => {
        if (ph === 'finale' || ph === 'loading') this._onCinematicDone();
      },
    };

    let ok = false;
    if (force !== 'fallback' && hasWebGL()) {
      try {
        const { LoadNugScene } = await import(sceneHref());
        this.renderer = new LoadNugScene(this.canvas, opts);
        ok = true;
      } catch (e) {
        console.warn('[SOS-LOADNUG] 3D failed, using 2D fallback:', e);
        ok = false;
      }
    }

    if (!ok) {
      this._freshCanvas();
      const { LoadNugFallback } = await import(fallbackHref());
      this.renderer = new LoadNugFallback(this.canvas, opts);
    }

    if (this._done) { this._disposeOverlay(); return; }

    this._bindResize();
    this.renderer.play().then(() => this._onSceneResolved());
  }

  _bindResize() {
    this._onResize = () => { if (this.renderer && this.renderer._resize) this.renderer._resize(); };
    try {
      window.addEventListener('resize', this._onResize, { passive: true });
      window.addEventListener('orientationchange', this._onResize, { passive: true });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    } catch (e) {}
  }

  _unbindResize() {
    if (!this._onResize) return;
    try {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('orientationchange', this._onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onResize);
    } catch (e) {}
    this._onResize = null;
  }

  _onCinematicDone() {
    if (this._cinematicDone) return;
    this._cinematicDone = true;
    // אם הפיד עדיין לא מוכן – ממשיכים לזחול על הבר עד ש-videos.js סוגר | HYPER CORE TECH
    if (!this._holdInt) this._holdInt = setInterval(() => this._creepBar(), 320);
    if (this._appReady) this._dismissSoon();
  }

  _onAppReady() {
    if (this._appReady) return;
    this._appReady = true;
    // כמו מד הטעינה הישן: נסגר מיד כשהפיד מוכן (מטמון=קצר, רשת=ארוך) – בלי לחכות לקולנוע | HYPER CORE TECH
    this._dismissSoon();
  }

  signalReady() { this._onAppReady(); }

  _dismissSoon() {
    if (this._done) return;
    if (this._holdInt) { clearInterval(this._holdInt); this._holdInt = null; }
    this._setBar(100);
    if (this._statusEl) this._statusEl.textContent = 'הכל מוכן!';
    setTimeout(() => {
      try { this.renderer && this.renderer.complete && this.renderer.complete(); } catch (e) {}
      this._complete();
    }, 500);
  }

  _onSceneResolved() {
    if (!this._cinematicDone) this._onCinematicDone();
  }

  _setBar(p) {
    this._barVal = clamp(p, 0, 100);
    const rounded = Math.round(this._barVal);
    for (const el of this._barEls) el.style.width = this._barVal + '%';
    for (const el of this._pctEls) el.textContent = rounded + '%';
    for (const el of this._progressEls) el.setAttribute('aria-valuenow', String(rounded));
    if (this._statusEl && this._barVal < 100) this._statusEl.textContent = 'מתחבר לרשת...';
  }

  _applyStoryBeat(beat, idx) {
    this._lastBeat = idx;
    if (this._storyTitle) this._storyTitle.textContent = beat.title;
    if (this._storySub) this._storySub.textContent = beat.sub;
  }

  _updateStoryFromTime(seconds) {
    let idx = 0;
    for (let i = 0; i < STORY_BEATS.length; i++) {
      if (seconds >= STORY_BEATS[i].t) idx = i;
    }
    if (idx !== this._lastBeat) this._applyStoryBeat(STORY_BEATS[idx], idx);
  }

  _creepBar() {
    if (this._barVal < 88) this._setBar(this._barVal + 0.3);
    else if (this._barVal < 95) this._setBar(this._barVal + 0.08);
  }

  _wireIntegration() {
    const existing = document.getElementById('videosLoadingOverlay');
    const isReady = () => {
      if (!existing) return false;
      if (existing.classList.contains('hidden')) return true;
      if ((existing.style && existing.style.display) === 'none') return true;
      try {
        const cs = getComputedStyle(existing);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
      } catch (e) {}
      return false;
    };
    const check = () => {
      if (!existing) return;
      if (isReady()) {
        this._onAppReady();
        this._disconnectObserver();
      }
    };
    if (existing) {
      try {
        this._observer = new MutationObserver(check);
        this._observer.observe(existing, { attributes: true, attributeFilter: ['class', 'style'] });
        check();
      } catch (e) {}
    }
    this._safetyTO = setTimeout(() => this._onAppReady(), (DURATION + SAFETY_HOLD) * 1000);
  }

  _disconnectObserver() {
    try { this._observer && this._observer.disconnect(); } catch (e) {}
    this._observer = null;
    if (this._safetyTO) { clearTimeout(this._safetyTO); this._safetyTO = null; }
  }

  _complete() {
    if (this._done) return;
    this._done = true;
    this._disconnectObserver();
    if (this._holdInt) { clearInterval(this._holdInt); this._holdInt = null; }
    this._unbindResize();
    const ov = this.overlay;
    if (ov) {
      ov.setAttribute('aria-busy', 'false');
      ov.classList.add('sos-loadnug--leaving');
      setTimeout(() => {
        try { this.renderer && this.renderer.dispose && this.renderer.dispose(); } catch (e) {}
        this._disposeOverlay();
      }, 760);
    }
  }

  _disposeOverlay() {
    try { document.body.classList.remove('sos-loadnug-active'); } catch (e) {}
    try {
      if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    } catch (e) {}
    this.overlay = null;
    this.canvas = null;
    this._statusEl = null;
    this._storyTitle = null;
    this._storySub = null;
    this._barEls = [];
    this._pctEls = [];
    this._progressEls = [];
    try {
      const crit = document.getElementById('sos-loadnug-critical');
      if (crit) crit.remove();
    } catch (e) {}
  }

  replay() {
    this._done = false;
    this._appReady = false;
    this._cinematicDone = false;
    this._barVal = 0;
    this._lastBeat = -1;
    try { this.renderer && this.renderer.dispose && this.renderer.dispose(); } catch (e) {}
    this._disposeOverlay();
    this._disconnectObserver();
    this._unbindResize();
    if (this._holdInt) { clearInterval(this._holdInt); this._holdInt = null; }
    this.start();
  }

  get isPlaying() { return !this._done && !!this.overlay; }
}

if (typeof window !== 'undefined') {
  try {
    const ctrl = new LoadNugController();
    window.SOSLoadNug = {
      replay: () => ctrl.replay(),
      signalReady: () => ctrl.signalReady(),
      get isPlaying() { return ctrl.isPlaying; },
      _ctrl: ctrl,
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => ctrl.start(), { once: true });
    } else {
      ctrl.start();
    }
  } catch (e) {
    console.warn('[SOS-LOADNUG] bootstrap failed:', e);
  }
}
