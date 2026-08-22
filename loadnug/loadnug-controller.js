/* ============================================================
   SOS · LOADNUG — Controller
   Static cyber-city background (same image as chat desktop).
   Progress + story beats keep original DURATION timing.
   No WebGL / Canvas2D animation (lower CPU load).
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
function bgHref() {
  try { return new URL('../icons/chat-desktop-cyber-bg.png', import.meta.url).href; }
  catch (e) { return './icons/chat-desktop-cyber-bg.png'; }
}
function queryFlag() {
  try { return new URLSearchParams(location.search).get('loadnug'); }
  catch (e) { return null; }
}

/** Same progress/phase contract as LoadNugScene, without GPU animation. */
class StaticLoadTicker {
  constructor(opts) {
    this.duration = opts.duration || DURATION;
    this._onProgress = opts.onProgress || (() => {});
    this._onPhase = opts.onPhase || (() => {});
    this._running = false;
    this._raf = 0;
    this._resolve = null;
    this._holdSignaled = false;
    this._tStart = 0;
  }

  play() {
    if (this._running) return Promise.resolve();
    this._running = true;
    this._tStart = performance.now();
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._loop();
    });
  }

  complete() { this._finish(false); }

  dispose() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._resolve = null;
  }

  _finish() {
    if (!this._running && !this._holdSignaled) return;
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._onPhase('done');
    this._onProgress(1);
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r();
    }
  }

  _loop = () => {
    if (!this._running) return;
    let t = (performance.now() - this._tStart) / 1000;
    if (t >= this.duration) t = this.duration;
    this._onProgress(clamp(t / this.duration, 0, 1));
    if (t >= this.duration) {
      if (!this._holdSignaled) {
        this._holdSignaled = true;
        this._onPhase('loading');
      }
      return;
    }
    this._raf = requestAnimationFrame(this._loop);
  };
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
    const bg = bgHref();
    const crit = document.createElement('style');
    crit.id = 'sos-loadnug-critical';
    // דף טעינה מלא מסך מעל הפיד – לא כרטיס ריק בתוך הסטרים | HYPER CORE TECH
    crit.textContent = [
      'body:has(.videos-feed) .top-bar{position:fixed!important;z-index:3000!important;left:0!important;right:0!important;top:0!important;width:100%!important;display:flex!important;visibility:visible!important;opacity:1!important;transform:none!important;pointer-events:auto!important}',
      'body:has(.videos-feed) .primary-nav{position:fixed!important;z-index:3000!important;display:flex!important;visibility:visible!important;opacity:1!important;transform:none!important;pointer-events:auto!important}',
      `#sosLoadNugOverlay,#sosLoadNugOverlay.videos-feed__card,#sosLoadNugOverlay.videos-feed__card--loadnug{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:calc(56px + var(--safe-bottom, 0px))!important;inset:auto!important;z-index:2950!important;width:100%!important;height:auto!important;min-height:calc(100dvh - 56px - var(--safe-bottom, 0px))!important;max-width:none!important;margin:0!important;flex-shrink:0!important;overflow:hidden!important;background:#070b19 url('${bg}') center / cover no-repeat!important;scroll-snap-align:none!important}`,
      '#sosLoadNugOverlay.sos-loadnug--leaving{opacity:0;pointer-events:none}',
      '#sosLoadNugBg{position:absolute;inset:0;z-index:1;pointer-events:none;background:transparent}',
    ].join('');
    const oldCrit = document.getElementById('sos-loadnug-critical');
    if (oldCrit) oldCrit.remove();
    document.head.appendChild(crit);

    if (!document.querySelector('link[data-sos-loadnug-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssHref();
      link.setAttribute('data-sos-loadnug-css', '1');
      document.head.appendChild(link);
    }

    const ov = document.createElement('div');
    ov.id = 'sosLoadNugOverlay';
    ov.className = 'videos-feed__card videos-feed__card--loadnug';
    ov.setAttribute('role', 'status');
    ov.setAttribute('aria-label', 'SOS loading');
    ov.setAttribute('aria-busy', 'true');
    ov.innerHTML = `
      <div id="sosLoadNugBg" aria-hidden="true"></div>
      <div class="sos-loadnug__loader">
        <div class="sos-loadnug__logo" aria-label="SOS"><span class="ln-s1">S</span><span class="ln-o">O</span><span class="ln-s2">S</span></div>
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

    const bootShell = document.getElementById('feedBootShell');
    if (bootShell) {
      try { bootShell.remove(); } catch (_) {}
    }
    // תמיד על body – דף טעינה מלא, לא כרטיס בפיד | HYPER CORE TECH
    document.body.appendChild(ov);

    this.overlay = ov;
    this.canvas = null;
    this._statusEl = ov.querySelector('.sos-loadnug__status');
    this._storyTitle = ov.querySelector('.sos-loadnug__explain-title');
    this._storySub = ov.querySelector('.sos-loadnug__explain-sub');
    this._barEls = Array.from(ov.querySelectorAll('.sos-loadnug__bar'));
    this._pctEls = Array.from(ov.querySelectorAll('.sos-loadnug__pct'));
    this._progressEls = Array.from(ov.querySelectorAll('.sos-loadnug__progress'));

    this._applyStoryBeat(STORY_BEATS[0], 0);
    this._setBar(0);
    return ov;
  }

  async start() {
    if (this._done) return;
    if (queryFlag() === 'skip' || queryFlag() === '0') return;

    this._mount();
    this._wireIntegration();

    const opts = {
      duration: DURATION,
      onProgress: (p) => {
        const v = p * 90;
        if (v > this._barVal) this._setBar(v);
        this._updateStoryFromTime(p * DURATION);
      },
      onPhase: (ph) => {
        if (ph === 'finale' || ph === 'loading') this._onCinematicDone();
      },
    };

    this.renderer = new StaticLoadTicker(opts);

    if (this._done) { this._disposeOverlay(); return; }

    this.renderer.play().then(() => this._onSceneResolved());
  }

  _unbindResize() {
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
    // סגירה מיידית — מסונכרן עם הפוסט הראשון, בלי השהייה מלאכותית | HYPER CORE TECH
    try { this.renderer && this.renderer.complete && this.renderer.complete(); } catch (e) {}
    this._complete();
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
      // בזמן רענון בית — לא סוגרים LoadNug לפי hook ישן | HYPER CORE TECH
      try {
        if (document.body && document.body.classList.contains('videos-boot-loading')) return false;
      } catch (e) {}
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
    try {
      if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    } catch (e) {}
    // אחרי הסרת כרטיס הטעינה – חזרה לראש הפיד (פוסט ראשון) | HYPER CORE TECH
    try {
      const vp = document.querySelector('.videos-feed__viewport');
      if (vp) vp.scrollTop = 0;
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
