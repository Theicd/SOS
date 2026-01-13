// חלק משחק טריוויה – מודול רשת מבוזר עבור SOS Network
;(function initTriviaGame(window, document) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קבועים – מזהי אירועים, טיימרים והגדרות משחק
  const CFG = {
    TAG: 'sos_trivia_v1',
    KIND_STATUS: 33051,
    KIND_MATCH: 33052,
    QUESTION_TIME: 18,
    MAX_ROUNDS: 10,
    LOBBY_TTL: 120
  };

  // חלק שאלות – מאגר בסיסי של 10 שאלות בעברית
  const QUESTIONS = [
    { q: 'כמה זה 7 + 5?', answers: ['10', '11', '12', '13'], correct: 2 },
    { q: 'כמה זה 9 - 4?', answers: ['3', '4', '5', '6'], correct: 2 },
    { q: 'מהי בירת ישראל?', answers: ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'], correct: 1 },
    { q: 'איזו נוסחה מתארת מים?', answers: ['CO2', 'H2O', 'O2', 'NaCl'], correct: 1 },
    { q: 'באיזו שנה הוכרזה מדינת ישראל?', answers: ['1946', '1948', '1950', '1952'], correct: 1 },
    { q: 'מה נרדף למילה "מהיר"?', answers: ['זריז', 'כבד', 'עמוס', 'רחב'], correct: 0 },
    { q: 'כמה זה 6 × 3?', answers: ['12', '15', '18', '20'], correct: 2 },
    { q: 'איזה בעל חיים הוא יונק?', answers: ['תנין', 'כריש', 'דולפין', 'צפרדע'], correct: 2 },
    { q: 'מי המציא את הנורה?', answers: ['אדיסון', 'ניוטון', 'בל', 'מרקוני'], correct: 0 },
    { q: 'כמה זה 21 ÷ 3?', answers: ['6', '7', '8', '9'], correct: 1 }
  ];

  // חלק מצב – אוגד את ה-UI, נתוני הלובי והמשחק והאזנות נדרשות
  const state = {
    ui: {},
    seeking: false,
    roomId: null,
    opponentPubkey: null,
    opponentName: 'יריב',
    isHost: false,
    matchActive: false,
    round: 0,
    order: [],
    answers: new Map(),
    players: new Map(),
    processed: new Set(),
    subscriptions: [],
    timers: { interval: null, question: null },
    presenceInterval: null,
    metrics: { correct: 0, total: 0, streak: 0, best: 0 },
    inTrivia: false
  };

  // חלק עזר – פונקציות קצרות לשימוש פנימי
  const now = () => Math.floor(Date.now() / 1000);
  const setText = (el, txt) => el && (el.textContent = txt);
  const addClass = (el, cls) => el && el.classList.add(cls);
  const removeClass = (el, cls) => el && el.classList.remove(cls);
  const toggleBodyLock = (lock) => document.body.classList[lock ? 'add' : 'remove']('trivia-open');

  // ========== חלק קול – מערכת אודיו מלאה למשחק ==========
  const SoundSystem = {
    enabled: true,
    bgMusic: null,
    currentSpeech: null,
    volume: { master: 0.7, music: 0.3, effects: 0.8, speech: 1.0 },
    
    // אתחול מערכת הקול
    init() {
      this.createBgMusic();
    },
    
    // יצירת מוזיקת רקע באמצעות Web Audio API
    createBgMusic() {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        this.audioCtx = new AudioContext();
      } catch (e) {
        console.warn('Audio context not available');
      }
    },
    
    // הפעלת מוזיקת רקע
    playBgMusic() {
      if (!this.enabled || !this.audioCtx) return;
      try {
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        // יצירת לופ רקע פשוט
        this.stopBgMusic();
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 220;
        gain.gain.value = 0.02 * this.volume.music * this.volume.master;
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
        this.bgMusic = { osc, gain };
        // פעימות עדינות
        this.bgInterval = setInterval(() => {
          if (this.bgMusic?.gain) {
            const t = this.audioCtx.currentTime;
            this.bgMusic.gain.gain.setTargetAtTime(0.015 * this.volume.music * this.volume.master, t, 0.5);
            setTimeout(() => {
              if (this.bgMusic?.gain) this.bgMusic.gain.gain.setTargetAtTime(0.025 * this.volume.music * this.volume.master, this.audioCtx.currentTime, 0.5);
            }, 1000);
          }
        }, 2000);
      } catch (e) {
        console.warn('Background music error:', e);
      }
    },
    
    // עצירת מוזיקת רקע
    stopBgMusic() {
      try {
        if (this.bgInterval) clearInterval(this.bgInterval);
        if (this.bgMusic?.osc) {
          this.bgMusic.osc.stop();
          this.bgMusic = null;
        }
      } catch (e) {}
    },
    
    // אפקט קולי קצר
    playEffect(type) {
      if (!this.enabled || !this.audioCtx) return;
      try {
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        gain.gain.value = 0.15 * this.volume.effects * this.volume.master;
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        
        switch (type) {
          case 'correct':
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523, this.audioCtx.currentTime);
            osc.frequency.setValueAtTime(659, this.audioCtx.currentTime + 0.1);
            osc.frequency.setValueAtTime(784, this.audioCtx.currentTime + 0.2);
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.3, 0.1);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.5);
            break;
          case 'wrong':
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, this.audioCtx.currentTime);
            osc.frequency.setValueAtTime(150, this.audioCtx.currentTime + 0.15);
            gain.gain.value = 0.08 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.2, 0.1);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.4);
            break;
          case 'tick':
            osc.type = 'square';
            osc.frequency.value = 800;
            gain.gain.value = 0.05 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.03, 0.01);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.05);
            break;
          case 'start':
            osc.type = 'sine';
            osc.frequency.setValueAtTime(392, this.audioCtx.currentTime);
            osc.frequency.setValueAtTime(523, this.audioCtx.currentTime + 0.15);
            osc.frequency.setValueAtTime(659, this.audioCtx.currentTime + 0.3);
            osc.frequency.setValueAtTime(784, this.audioCtx.currentTime + 0.45);
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.6, 0.1);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.8);
            break;
          case 'win':
            osc.type = 'sine';
            [523, 659, 784, 1047].forEach((freq, i) => {
              osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime + i * 0.15);
            });
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.8, 0.2);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 1.2);
            break;
          case 'lose':
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(392, this.audioCtx.currentTime);
            osc.frequency.setValueAtTime(330, this.audioCtx.currentTime + 0.3);
            osc.frequency.setValueAtTime(262, this.audioCtx.currentTime + 0.6);
            gain.gain.value = 0.1 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.8, 0.2);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 1.0);
            break;
          case 'countdown':
            osc.type = 'sine';
            osc.frequency.value = 440;
            gain.gain.value = 0.12 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.1, 0.05);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.15);
            break;
          case 'coins':
            // צליל מטבעות זהב - רצף צלילים גבוהים מנצנצים
            osc.type = 'sine';
            const coinFreqs = [1200, 1400, 1600, 1800, 2000];
            coinFreqs.forEach((freq, i) => {
              osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime + i * 0.08);
            });
            gain.gain.value = 0.12 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.5, 0.1);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.6);
            break;
          case 'streak':
            // צליל רצף - פנפרה קצרה ומרשימה
            osc.type = 'square';
            [784, 988, 1175, 1319].forEach((freq, i) => {
              osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime + i * 0.1);
            });
            gain.gain.value = 0.1 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.5, 0.15);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.7);
            break;
          case 'encourage':
            // צליל עידוד - נעים ומרגיע
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(330, this.audioCtx.currentTime);
            osc.frequency.setValueAtTime(392, this.audioCtx.currentTime + 0.15);
            gain.gain.value = 0.08 * this.volume.effects * this.volume.master;
            gain.gain.setTargetAtTime(0, this.audioCtx.currentTime + 0.3, 0.1);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.4);
            break;
        }
      } catch (e) {
        console.warn('Sound effect error:', e);
      }
    },
    
    // הקראת טקסט בעברית באמצעות Web Speech API
    speak(text, options = {}) {
      if (!this.enabled || !window.speechSynthesis) return;
      try {
        // עצירת הקראה קודמת
        this.stopSpeech();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'he-IL';
        utterance.rate = options.rate || 1.0;
        utterance.pitch = options.pitch || 1.0;
        utterance.volume = this.volume.speech * this.volume.master;
        
        // ניסיון למצוא קול עברי
        const voices = speechSynthesis.getVoices();
        const hebrewVoice = voices.find(v => v.lang.includes('he') || v.lang.includes('iw'));
        if (hebrewVoice) utterance.voice = hebrewVoice;
        
        this.currentSpeech = utterance;
        speechSynthesis.speak(utterance);
        
        return new Promise(resolve => {
          utterance.onend = resolve;
          utterance.onerror = resolve;
        });
      } catch (e) {
        console.warn('Speech error:', e);
      }
    },
    
    // הקראת שאלה בלבד (ללא התשובות)
    async speakQuestion(questionText) {
      if (!this.enabled) return;
      await this.speak(questionText, { rate: 0.95 });
    },
    
    // עצירת הקראה
    stopSpeech() {
      try {
        if (window.speechSynthesis) speechSynthesis.cancel();
        this.currentSpeech = null;
      } catch (e) {}
    },
    
    // הפעלה/כיבוי קול
    toggle(enabled) {
      this.enabled = enabled;
      if (!enabled) {
        this.stopBgMusic();
        this.stopSpeech();
      }
    },
    
    // ניקוי משאבים
    cleanup() {
      this.stopBgMusic();
      this.stopSpeech();
      if (this.audioCtx) {
        try { this.audioCtx.close(); } catch (e) {}
      }
    }
  };

  // אתחול מערכת הקול
  SoundSystem.init();

  // חלק UI – דואג לטעינת ה-CSS והקמת מבנה המשחק
  function ensureStyles() {
    if (!document.getElementById('triviaStylesheet')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.id = 'triviaStylesheet';
      link.href = './styles/game-trivia.css';
      document.head.appendChild(link);
    }
  }

  // חלק UI – יצירת המודאל בעיצוב שלבים פרימיום
  function buildUI() {
    if (state.ui.overlay) return;
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.id = 'triviaOverlay';
    overlay.className = 'trivia-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="trivia-frame">
        <div class="trivia-background"></div>
        <!-- פס עליון קומפקטי -->
        <header class="trivia-topbar">
          <button id="triviaBackBtn" class="trivia-topbar__back" hidden>←</button>
          <div class="trivia-topbar__brand">🎲 SOS Trivia</div>
          <div class="trivia-topbar__actions">
            <button id="triviaCloseOverlay">סגור</button>
          </div>
        </header>
        <!-- פס מדדים – מוצג רק במשחק פעיל -->
        <section class="trivia-scorestrip" id="triviaScorestrip">
          <div class="trivia-strip__item"><span class="trivia-strip__label">סבב</span><span class="trivia-strip__value" id="triviaRound">0/10</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">אתה</span><span class="trivia-strip__value" id="triviaScoreSelf">0</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">יריב</span><span class="trivia-strip__value" id="triviaScoreOpp">0</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">⏱️</span><span class="trivia-strip__value" id="triviaTimer">--</span></div>
        </section>
        <!-- אזור תוכן מרכזי – שלבים -->
        <section class="trivia-stage">
          <!-- שלב 1: מסך פתיחה -->
          <div class="trivia-layer is-active" id="triviaWelcomeLayer">
            <div class="trivia-welcome">
              <div class="trivia-welcome__icon">🎲</div>
              <h1 class="trivia-welcome__title">SOS Trivia Challenge</h1>
              <p class="trivia-welcome__subtitle">בחנו את הידע שלכם מול חברים בזמן אמת</p>
              <button id="triviaStartBtn" class="trivia-welcome__cta">התחל משחק</button>
            </div>
          </div>
          <!-- שלב 2: בחירת אופן משחק -->
          <div class="trivia-layer" id="triviaModeLayer">
            <div class="trivia-mode">
              <h2 class="trivia-mode__title">איך תרצה לשחק?</h2>
              <div class="trivia-mode__options">
                <button class="trivia-mode__btn" id="triviaModeRandom">
                  <span class="trivia-mode__btn-icon">🔍</span>
                  <span class="trivia-mode__btn-label">חפש יריב אקראי</span>
                </button>
                <button class="trivia-mode__btn" id="triviaModeList">
                  <span class="trivia-mode__btn-icon">📋</span>
                  <span class="trivia-mode__btn-label">בחר מרשימה</span>
                </button>
              </div>
            </div>
          </div>
          <!-- שלב 3א: המתנה ליריב -->
          <div class="trivia-layer" id="triviaWaitingLayer">
            <div class="trivia-waiting">
              <div class="trivia-waiting__spinner"></div>
              <div class="trivia-waiting__text" id="triviaWaitingText">מחפש יריב...</div>
              <button id="triviaCancelSearch" class="trivia-waiting__cancel">בטל חיפוש</button>
            </div>
          </div>
          <!-- שלב 3ב: בחירת יריב מרשימה -->
          <div class="trivia-layer" id="triviaListLayer">
            <div class="trivia-list">
              <h2 class="trivia-list__title">בחר יריב</h2>
              <div class="trivia-list__stats" id="triviaLobbyStats">טוען...</div>
              <div class="trivia-list__container" id="triviaPlayerList"></div>
              <p class="trivia-list__empty" id="triviaListEmpty">אין שחקנים פנויים כרגע</p>
            </div>
          </div>
          <!-- שלב 4: משחק פעיל -->
          <div class="trivia-layer" id="triviaGameLayer">
            <div class="trivia-game-panel">
              <div class="trivia-versus">
                <div class="trivia-playercard">
                  <div class="trivia-playercard__info">
                    <span class="trivia-playercard__title">אתה</span>
                    <span class="trivia-playercard__name" id="triviaSelfName">שחקן</span>
                  </div>
                  <span class="trivia-playercard__score" id="triviaSelfScoreCard">0</span>
                </div>
                <div class="trivia-playercard">
                  <div class="trivia-playercard__info">
                    <span class="trivia-playercard__title">יריב</span>
                    <span class="trivia-playercard__name" id="triviaOpponentName">---</span>
                  </div>
                  <span class="trivia-playercard__score" id="triviaOppScoreCard">0</span>
                </div>
              </div>
              <div class="trivia-question-box" id="triviaQuestion">מחכים לשאלה...</div>
              <div class="trivia-answer-grid" id="triviaAnswers"></div>
              <div class="trivia-feedback" id="triviaFeedback"></div>
              <div class="trivia-game-actions"><button id="triviaLeaveButton">יציאה</button></div>
            </div>
          </div>
        </section>
      </div>
    `;
    document.body.append(overlay);
    // אחסון רפרנסים לאלמנטים
    state.ui = {
      overlay,
      backBtn: overlay.querySelector('#triviaBackBtn'),
      closeBtn: overlay.querySelector('#triviaCloseOverlay'),
      scorestrip: overlay.querySelector('#triviaScorestrip'),
      // שלבים
      welcomeLayer: overlay.querySelector('#triviaWelcomeLayer'),
      modeLayer: overlay.querySelector('#triviaModeLayer'),
      waitingLayer: overlay.querySelector('#triviaWaitingLayer'),
      listLayer: overlay.querySelector('#triviaListLayer'),
      gameLayer: overlay.querySelector('#triviaGameLayer'),
      // כפתורי ניווט
      startBtn: overlay.querySelector('#triviaStartBtn'),
      modeRandomBtn: overlay.querySelector('#triviaModeRandom'),
      modeListBtn: overlay.querySelector('#triviaModeList'),
      cancelSearchBtn: overlay.querySelector('#triviaCancelSearch'),
      leaveBtn: overlay.querySelector('#triviaLeaveButton'),
      // רשימת שחקנים
      playerList: overlay.querySelector('#triviaPlayerList'),
      listEmpty: overlay.querySelector('#triviaListEmpty'),
      lobbyStats: overlay.querySelector('#triviaLobbyStats'),
      waitingText: overlay.querySelector('#triviaWaitingText'),
      // מדדים
      roundValue: overlay.querySelector('#triviaRound'),
      scoreSelfValue: overlay.querySelector('#triviaScoreSelf'),
      scoreOppValue: overlay.querySelector('#triviaScoreOpp'),
      timerValue: overlay.querySelector('#triviaTimer'),
      // משחק
      questionBox: overlay.querySelector('#triviaQuestion'),
      answersGrid: overlay.querySelector('#triviaAnswers'),
      feedback: overlay.querySelector('#triviaFeedback'),
      selfName: overlay.querySelector('#triviaSelfName'),
      oppName: overlay.querySelector('#triviaOpponentName'),
      selfScoreCard: overlay.querySelector('#triviaSelfScoreCard'),
      oppScoreCard: overlay.querySelector('#triviaOppScoreCard')
    };
    // אירועי ניווט
    state.ui.closeBtn.addEventListener('click', closeOverlay);
    state.ui.backBtn.addEventListener('click', goBack);
    state.ui.startBtn.addEventListener('click', () => {
      // סימון שהשחקן נכנס למשחק הטריוויה
      state.inTrivia = true;
      publishStatus('ready');
      goToStep('list');
      refreshLobby();
    });
    state.ui.modeRandomBtn.addEventListener('click', () => { startSeeking(); goToStep('waiting'); });
    state.ui.modeListBtn.addEventListener('click', () => { goToStep('list'); refreshLobby(); });
    state.ui.cancelSearchBtn.addEventListener('click', () => { cancelSeeking(); goToStep('mode'); });
    state.ui.leaveBtn.addEventListener('click', leaveMatch);
  }

  // חלק ניווט – מעבר בין שלבים
  let currentStep = 'welcome';
  const stepHistory = [];
  
  function goToStep(step) {
    // הסתרת כל השלבים
    state.ui.welcomeLayer?.classList.remove('is-active');
    state.ui.modeLayer?.classList.remove('is-active');
    state.ui.waitingLayer?.classList.remove('is-active');
    state.ui.listLayer?.classList.remove('is-active');
    state.ui.gameLayer?.classList.remove('is-active');
    // הצגת פס מדדים רק במשחק פעיל
    state.ui.scorestrip?.classList.remove('is-visible');
    // שמירת היסטוריה
    if (currentStep !== step) stepHistory.push(currentStep);
    currentStep = step;
    // הצגת השלב הנוכחי
    switch (step) {
      case 'welcome':
        state.ui.welcomeLayer?.classList.add('is-active');
        state.ui.backBtn.hidden = true;
        break;
      case 'mode':
        state.ui.modeLayer?.classList.add('is-active');
        state.ui.backBtn.hidden = false;
        break;
      case 'waiting':
        state.ui.waitingLayer?.classList.add('is-active');
        state.ui.backBtn.hidden = false;
        break;
      case 'list':
        state.ui.listLayer?.classList.add('is-active');
        state.ui.backBtn.hidden = false;
        break;
      case 'game':
        state.ui.gameLayer?.classList.add('is-active');
        state.ui.scorestrip?.classList.add('is-visible');
        state.ui.backBtn.hidden = true;
        break;
    }
  }
  
  function goBack() {
    if (state.seeking) cancelSeeking();
    const prev = stepHistory.pop() || 'welcome';
    goToStep(prev);
  }

  // חלק פתיחה – הצגת המודאל, נעילת גלילה ושליחת נוכחות
  function openOverlay() {
    buildUI();
    if (!state.ui.overlay) return;
    state.ui.overlay.classList.add('is-open');
    state.ui.overlay.setAttribute('aria-hidden', 'false');
    toggleBodyLock(true);
    // איפוס לשלב פתיחה
    currentStep = 'welcome';
    stepHistory.length = 0;
    goToStep('welcome');
    ensurePresenceLoop();
    publishStatus('presence');
  }

  // חלק סגירה – שחרור נעילת גלילה וביטול חיפוש אם יש
  function closeOverlay() {
    if (!state.ui.overlay) return;
    state.ui.overlay.classList.remove('is-open');
    state.ui.overlay.setAttribute('aria-hidden', 'true');
    toggleBodyLock(false);
    if (state.seeking) cancelSeeking();
  }

  // חלק תצוגה – מעבר בין הלובי לזירה (תאימות לאחור)
  const switchToLobby = () => {
    state.matchActive = false;
    goToStep('welcome');
  };
  const switchToGame = () => {
    goToStep('game');
  };

  // חלק נוכחות – שליחת heartbeat קבועה לריליים
  function ensurePresenceLoop() {
    if (!state.presenceInterval) state.presenceInterval = setInterval(() => publishStatus('presence'), 30000);
  }

  // חלק פרסום – הודעות סטטוס ללובי Nostr
  function publishStatus(type, extra = {}) {
    if (!App.pool || typeof App.finalizeEvent !== 'function' || !App.privateKey) return;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls.filter(Boolean) : [];
    if (relays.length === 0) return;
    const timestamp = now();
    const payload = { type, name: App.profile?.name || 'שחקן', seeking: state.seeking, room: state.roomId, inTrivia: state.inTrivia || false, playing: state.matchActive || false, timestamp, ...extra };
    const event = App.finalizeEvent({ kind: CFG.KIND_STATUS, created_at: timestamp, tags: [['t', CFG.TAG]], content: JSON.stringify(payload) }, App.privateKey);
    try {
      const result = App.pool.publish(relays, event);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.warn('trivia status publish failed (async)', err);
        });
      }
    } catch (err) {
      console.warn('trivia status publish failed', err);
    }
  }

  // חלק פרסום – הודעות משחק בין היריבים
  function publishMatch(type, extra = {}) {
    if (!App.pool || !state.roomId || typeof App.finalizeEvent !== 'function' || !App.privateKey) return;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls.filter(Boolean) : [];
    if (relays.length === 0) return;
    const timestamp = now();
    const payload = { type, room: state.roomId, round: state.round, ...extra };
    const event = App.finalizeEvent({ kind: CFG.KIND_MATCH, created_at: timestamp, tags: [['t', CFG.TAG], ['room', state.roomId]], content: JSON.stringify(payload) }, App.privateKey);
    try {
      const result = App.pool.publish(relays, event);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.warn('trivia match publish failed (async)', err);
        });
      }
    } catch (err) {
      console.warn('trivia match publish failed', err);
    }
  }

  // חלק חיפוש – התחלת המתנה ליריב חדש
  function startSeeking() {
    if (state.seeking || !App.publicKey) return;
    state.seeking = true;
    state.roomId = createRoomId();
    state.isHost = true;
    state.ui.seekBtn.disabled = true;
    state.ui.cancelBtn.hidden = false;
    setText(state.ui.lobbyStatus, 'אתם ממתינים ליריב שיעלה לזירה...');
    setText(state.ui.banner, 'נמתין ליריב שיצטרף. הזמינו חברים כדי להאיץ את המשחק.');
    publishStatus('seek');
    refreshLobby();
  }

  // חלק חיפוש – ביטול המתנה וחזרה למצב Idle
  function cancelSeeking() {
    state.seeking = false;
    state.isHost = false;
    state.roomId = null;
    state.ui.seekBtn.disabled = false;
    state.ui.cancelBtn.hidden = true;
    setText(state.ui.lobbyStatus, 'המתנה בוטלה. בחרו יריב מהרשימה או התחילו שוב.');
    publishStatus('idle');
    refreshLobby();
  }

  // חלק לובי – שליחת הזמנה לשחקן אחר
  function joinWaiting(pubkey, roomId, name) {
    if (!App.publicKey) return;
    // מניעת כניסה למשחק אם כבר במשחק פעיל
    if (state.matchActive) {
      console.log('already in active match, ignoring join request');
      return;
    }
    state.opponentPubkey = pubkey;
    state.opponentName = name || 'יריב';
    
    // אם לשחקן יש חדר פתוח - מצטרפים אליו ומתחילים משחק
    if (roomId) {
      state.roomId = roomId;
      state.isHost = false;
      // שולחים אישור הצטרפות למארח
      publishMatch('accept', { opponent: pubkey, room: roomId });
      enterMatch(roomId, pubkey, name, false);
    } else {
      // יוצרים חדר חדש, שולחים הזמנה וממתינים לאישור
      state.roomId = createRoomId();
      state.isHost = true;
      state.seeking = true;
      publishMatch('invite', { target: pubkey, room: state.roomId });
      goToStep('waiting');
      setText(state.ui.waitingText, `ממתינים ל${name || 'יריב'}...`);
    }
  }

  // חלק משחק – כניסה לזירה מול היריב
  function enterMatch(roomId, opponentPubkey, opponentName, asHost) {
    // מניעת כניסה כפולה למשחק
    if (state.matchActive) {
      console.log('already in match, ignoring enter request');
      return;
    }
    state.matchActive = true;
    state.roomId = roomId;
    state.opponentPubkey = opponentPubkey;
    state.opponentName = opponentName || 'יריב';
    state.isHost = asHost;
    state.round = 0;
    state.order = shuffleQuestions();
    state.answers.clear();
    state.metrics = { correct: 0, total: 0, streak: 0, best: 0 };
    FeedbackSystem.reset();
    // קול - התחלת משחק
    SoundSystem.playEffect('start');
    SoundSystem.playBgMusic();
    SoundSystem.speak(`המשחק מתחיל! משחקים נגד ${opponentName || 'יריב'}`);
    // מעבר לשלב המשחק
    goToStep('game');
    updateScores();
    setText(state.ui.selfName, App.profile?.name || 'אתה');
    setText(state.ui.oppName, state.opponentName);
    setText(state.ui.feedback, '');
    if (state.isHost) {
      publishStatus('match');
      sendQuestion(0);
    } else {
      publishStatus('playing');
      setText(state.ui.questionBox, 'מחכים לשאלה הראשונה...');
    }
  }

  // חלק משחק – חזרה ללובי וסיום הסשן
  function leaveMatch() {
    // קול - עצירת מוזיקה ודיבור
    SoundSystem.stopBgMusic();
    SoundSystem.stopSpeech();
    // שליחת הודעה ליריב שעזבנו
    if (state.matchActive && state.roomId) {
      publishMatch('leave', { reason: 'user_left' });
    }
    clearTimers();
    state.matchActive = false;
    state.roomId = null;
    state.opponentPubkey = null;
    state.round = 0;
    if (state.ui.answersGrid) state.ui.answersGrid.innerHTML = '';
    setText(state.ui.questionBox, 'מחכים לשאלה...');
    setText(state.ui.feedback, '');
    state.inTrivia = false;
    publishStatus('idle');
    // חזרה למסך פתיחה
    stepHistory.length = 0;
    goToStep('welcome');
  }

  // חלק משחק – טיפול בעזיבת יריב
  function handleOpponentLeft() {
    // קול - עצירת מוזיקה והודעה
    SoundSystem.stopBgMusic();
    SoundSystem.stopSpeech();
    SoundSystem.speak('היריב עזב את המשחק');
    clearTimers();
    state.matchActive = false;
    state.roomId = null;
    state.opponentPubkey = null;
    state.round = 0;
    if (state.ui.answersGrid) state.ui.answersGrid.innerHTML = '';
    setText(state.ui.questionBox, 'היריב עזב את המשחק');
    setText(state.ui.feedback, 'המשחק הסתיים. חוזרים ללובי...');
    state.inTrivia = false;
    publishStatus('idle');
    // המתנה קצרה וחזרה ללובי
    setTimeout(() => {
      stepHistory.length = 0;
      goToStep('welcome');
      refreshLobby();
    }, 2000);
  }

  // חלק שאלות – שליחת שאלה חדשה מהמארח
  function sendQuestion(index) {
    if (!state.isHost || !state.matchActive) return;
    if (index >= state.order.length) return finishMatch();
    state.round = index;
    const questionIndex = state.order[index];
    publishMatch('question', { questionIndex, totalRounds: state.order.length, startedAt: now(), timeLimit: CFG.QUESTION_TIME });
    armNextQuestion();
  }

  // חלק שאלות – תזמון שאלה הבאה
  function armNextQuestion() {
    clearTimeout(state.timers.question);
    if (state.isHost) state.timers.question = setTimeout(() => sendQuestion(state.round + 1), CFG.QUESTION_TIME * 1000 + 600);
  }

  // חלק שאלות – הצגת השאלה ותשובות אפשריות בתצוגת המשחק
  function renderQuestion(questionIndex, round, totalRounds, startedAt, timeLimit) {
    const data = QUESTIONS[questionIndex];
    if (!data) return;
    state.round = round;
    setText(state.ui.questionBox, data.q);
    if (state.ui.answersGrid) state.ui.answersGrid.innerHTML = '';
    setText(state.ui.feedback, '');
    state.ui.feedback?.classList.remove('is-correct', 'is-wrong');
    data.answers.forEach((text, idx) => {
      const btn = Object.assign(document.createElement('button'), { className: 'trivia-answer-btn', type: 'button', textContent: text });
      btn.dataset.option = String(idx);
      btn.addEventListener('click', () => submitAnswer(idx, data.correct));
      state.ui.answersGrid?.appendChild(btn);
    });
    updateRound(round, totalRounds);
    runTimer(startedAt, timeLimit);
    // קול - הקראת השאלה בלבד
    SoundSystem.speakQuestion(data.q);
  }

  // חלק תשובות – שליחת הבחירה לריליי והצגת פידבק
  function submitAnswer(optionIdx, correctIdx) {
    if (!state.matchActive || !state.roomId) return;
    // קול - עצירת הקראה
    SoundSystem.stopSpeech();
    markAnswer(optionIdx, correctIdx);
    disableAnswers();
    const isCorrect = optionIdx === correctIdx;
    // עדכון מדדים לפני קבלת פידבק (כדי לדעת את הרצף)
    updatePlayerMetrics(isCorrect);
    // קבלת פידבק מותאם עם מחמאות/הערות בונות
    const feedback = FeedbackSystem.getFeedback(isCorrect, state.metrics.streak);
    // קול - אפקט מותאם לסוג הפידבק
    SoundSystem.playEffect(feedback.effect);
    // הקראת הפידבק אם נדרש (רצפים מיוחדים או עידוד)
    if (feedback.speak) {
      setTimeout(() => SoundSystem.speak(feedback.text.replace(/[🔥⭐🏆👑💪✓✗]/g, '')), 300);
    }
    rememberAnswer(App.publicKey, state.round, isCorrect);
    publishMatch('answer', { option: optionIdx, correct: isCorrect });
    setText(state.ui.feedback, feedback.text);
    state.ui.feedback?.classList.remove('is-correct', 'is-wrong');
    state.ui.feedback?.classList.add(isCorrect ? 'is-correct' : 'is-wrong');
    updateScores();
  }

  // חלק תשובות – סימון חזותי של תשובות נכונות ושגויות
  function markAnswer(optionIdx, correctIdx) {
    const chosen = state.ui.answersGrid.querySelector(`[data-option="${optionIdx}"]`);
    if (chosen) chosen.classList.add(optionIdx === correctIdx ? 'is-correct' : 'is-wrong');
    const correct = state.ui.answersGrid.querySelector(`[data-option="${correctIdx}"]`);
    if (correct) correct.classList.add('is-correct');
  }

  // חלק תשובות – נטרול כפתורי התשובות לאחר בחירה
  function disableAnswers() {
    state.ui.answersGrid.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
  }

  // חלק ניקוד – שמירת תשובות לעדכון ניקוד ודיוק
  function rememberAnswer(pubkey, round, isCorrect) {
    if (!pubkey) return;
    const entry = state.answers.get(pubkey) || { answers: {}, score: 0 };
    entry.answers[round] = isCorrect;
    entry.score = Object.values(entry.answers).filter(Boolean).length;
    state.answers.set(pubkey, entry);
  }

  // חלק מדדים – ניהול ניקוד, רצף ודיוק של השחקן המקומי
  function updatePlayerMetrics(wasCorrect) {
    state.metrics.total += 1;
    if (wasCorrect) {
      state.metrics.correct += 1;
      state.metrics.streak += 1;
      state.metrics.best = Math.max(state.metrics.best, state.metrics.streak);
    } else {
      state.metrics.streak = 0;
    }
  }

  function getAccuracy() {
    return state.metrics.total ? Math.round((state.metrics.correct / state.metrics.total) * 100) : 0;
  }

  // ========== חלק מחמאות – מערכת פידבק חיובי והערות בונות ==========
  const FeedbackSystem = {
    // מחמאות לרצפים של תשובות נכונות
    streakMessages: {
      3: ['🔥 שלוש ברצף!', 'יופי! אתה על גלגל!', '3 נכונות רצוף! מדהים!'],
      5: ['⭐ חמש ברצף!', 'וואו! בלתי ניתן לעצירה!', 'חמישייה מנצחת!'],
      7: ['🏆 שבע ברצף!', 'גאון טהור!', 'מכונת תשובות!'],
      10: ['👑 עשר ברצף!', 'אלוף העולם!', 'פשוט מושלם!']
    },
    
    // מחמאות לתשובה נכונה בודדת
    correctMessages: [
      'נכון!', 'יפה מאוד!', 'מצוין!', 'בול!', 'נהדר!', 'כל הכבוד!', 'מדויק!'
    ],
    
    // הערות בונות לתשובה שגויה
    wrongMessages: [
      'לא נורא, בפעם הבאה!', 'קרוב! נסה שוב', 'טעות קטנה, ממשיכים!', 
      'לא הפעם, אבל אל תוותר!', 'קורה לכולם!'
    ],
    
    // עידוד אחרי מספר טעויות ברצף
    encourageMessages: [
      'אל תוותר!', 'אתה יכול!', 'תתרכז, תצליח!', 'נשים הכל מאחור ומתחילים מחדש!'
    ],
    
    // ספירת טעויות ברצף לעידוד
    wrongStreak: 0,
    
    // קבלת פידבק מותאם לתשובה
    getFeedback(isCorrect, streak) {
      if (isCorrect) {
        this.wrongStreak = 0;
        // בדיקת רצף מיוחד
        if (this.streakMessages[streak]) {
          const msgs = this.streakMessages[streak];
          return { 
            text: msgs[Math.floor(Math.random() * msgs.length)], 
            effect: streak >= 5 ? 'coins' : 'streak',
            speak: true 
          };
        }
        // תשובה נכונה רגילה
        return { 
          text: '✓ ' + this.correctMessages[Math.floor(Math.random() * this.correctMessages.length)], 
          effect: 'correct',
          speak: false 
        };
      } else {
        this.wrongStreak += 1;
        // עידוד אחרי 3 טעויות ברצף
        if (this.wrongStreak >= 3) {
          this.wrongStreak = 0;
          return { 
            text: '💪 ' + this.encourageMessages[Math.floor(Math.random() * this.encourageMessages.length)], 
            effect: 'encourage',
            speak: true 
          };
        }
        // טעות רגילה
        return { 
          text: '✗ ' + this.wrongMessages[Math.floor(Math.random() * this.wrongMessages.length)], 
          effect: 'wrong',
          speak: false 
        };
      }
    },
    
    // איפוס בתחילת משחק חדש
    reset() {
      this.wrongStreak = 0;
    }
  };

  // חלק ניקוד – עידכון לוח הניקוד
  function updateScores() {
    const selfEntry = state.answers.get(App.publicKey) || { answers: {}, score: 0 };
    const oppEntry = state.answers.get(state.opponentPubkey) || { answers: {}, score: 0 };
    const selfScore = selfEntry.score || 0;
    const oppScore = oppEntry.score || 0;
    setText(state.ui.scoreSelfValue, String(selfScore));
    setText(state.ui.scoreOppValue, String(oppScore));
    setText(state.ui.selfScoreCard, String(selfScore));
    setText(state.ui.oppScoreCard, String(oppScore));
  }

  // חלק סיום – סיום המשחק ושליחת הודעת final לרשת
  function finishMatch() {
    clearTimers();
    // קול - עצירת מוזיקה והקראה
    SoundSystem.stopBgMusic();
    SoundSystem.stopSpeech();
    publishMatch('final');
    const selfScore = state.answers.get(App.publicKey)?.score || 0;
    const oppScore = state.answers.get(state.opponentPubkey)?.score || 0;
    const isWin = selfScore > oppScore;
    const isDraw = selfScore === oppScore;
    // קול - אפקט ניצחון/הפסד והכרזת תוצאה
    SoundSystem.playEffect(isWin ? 'win' : isDraw ? 'start' : 'lose');
    const resultText = isWin ? 'ניצחת!' : isDraw ? 'תיקו!' : 'הפסדת';
    SoundSystem.speak(`המשחק הסתיים. ${resultText} התוצאה ${selfScore} ל ${oppScore}`);
    const result = isWin ? '🎉 ניצחת!' : isDraw ? '🤝 תיקו!' : '😔 הפסדת';
    setText(state.ui.feedback, `${result} הניקוד: ${selfScore} - ${oppScore}`);
    state.ui.feedback?.classList.add(selfScore >= oppScore ? 'is-correct' : 'is-wrong');
    setText(state.ui.timerValue, '--');
    state.isHost = false;
  }

  // חלק טיימר – שעון משותף לשאלה הנוכחית
  function runTimer(startedAt, timeLimit) {
    clearInterval(state.timers.interval);
    const end = (startedAt || now()) + (timeLimit || CFG.QUESTION_TIME);
    let lastRemaining = -1;
    const tick = () => {
      const remaining = Math.max(0, end - now());
      setText(state.ui.timerValue, remaining.toString().padStart(2, '0'));
      // קול - אפקט קונטדאון בשלוש השניות האחרונות
      if (remaining <= 3 && remaining > 0 && remaining !== lastRemaining) {
        SoundSystem.playEffect('countdown');
      }
      lastRemaining = remaining;
      if (!remaining) {
        clearInterval(state.timers.interval);
        disableAnswers();
        setText(state.ui.feedback, '⏱️ נגמר הזמן!');
        SoundSystem.playEffect('wrong');
      }
    };
    tick();
    state.timers.interval = setInterval(tick, 1000);
  }

  // חלק טיימר – ניקוי כל הטיימרים הפעילים
  function clearTimers() {
    clearInterval(state.timers.interval);
    clearTimeout(state.timers.question);
    state.timers.interval = null;
    state.timers.question = null;
  }

  // חלק סבב – עדכון פס הסבבים בהתאם להתקדמות
  const updateRound = (round, total) => setText(state.ui.roundValue, `${round + 1}/${total}`);

  // חלק לובי – רענון רשימת השחקנים
  function refreshLobby() {
    const currentTime = now();
    const availablePlayers = [];
    let totalConnected = 0;
    let inGame = 0;
    
    for (const player of state.players.values()) {
      if (player.updatedAt + CFG.LOBBY_TTL < currentTime) {
        state.players.delete(player.pubkey);
        continue;
      }
      // ספירת כל המחוברים לטריוויה
      if (player.inTrivia) {
        totalConnected++;
        // ספירת שחקנים במשחק פעיל
        if (player.playing) {
          inGame++;
        } else {
          // רק שחקנים פנויים (לא במשחק) מוצגים ברשימה
          availablePlayers.push(player);
        }
      }
    }
    
    // עדכון תצוגת סטטוס
    updateLobbyStats(totalConnected, inGame, availablePlayers.length);
    renderPlayerList(availablePlayers);
  }
  
  // חלק לובי – עדכון תצוגת סטטיסטיקות
  function updateLobbyStats(total, playing, available) {
    if (state.ui.lobbyStats) {
      if (total === 0) {
        state.ui.lobbyStats.textContent = 'אין שחקנים מחוברים כרגע';
      } else {
        const parts = [];
        parts.push(`${total} מחוברים`);
        if (playing > 0) parts.push(`${playing} במשחק`);
        if (available > 0) parts.push(`${available} פנויים`);
        state.ui.lobbyStats.textContent = parts.join(' • ');
      }
    }
  }

  // חלק לובי – ציור רשימת שחקנים אחת פשוטה
  function renderPlayerList(list) {
    if (!state.ui.playerList) return;
    state.ui.playerList.innerHTML = '';
    if (!list.length) {
      if (state.ui.listEmpty) state.ui.listEmpty.hidden = false;
      return;
    }
    if (state.ui.listEmpty) state.ui.listEmpty.hidden = true;
    list.forEach((player) => {
      const row = document.createElement('div');
      row.className = 'trivia-player-row';
      const meta = document.createElement('div');
      meta.className = 'trivia-player-meta';
      const name = document.createElement('span');
      name.textContent = player.name || 'שחקן';
      const status = document.createElement('span');
      status.textContent = player.seeking ? '🟢 מחפש יריב' : '⚪ זמין';
      meta.append(name, status);
      row.appendChild(meta);
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = 'שחק איתו';
      action.addEventListener('click', () => {
        // התחלת משחק ישירות עם השחקן הנבחר
        joinWaiting(player.pubkey, player.room, player.name);
      });
      row.appendChild(action);
      state.ui.playerList.appendChild(row);
    });
  }

  // חלק עזר – יצירת מזהה חדר ייחודי וערבוב שאלות
  const createRoomId = () => `trivia-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const shuffleQuestions = () => {
    const arr = QUESTIONS.map((_, idx) => idx);
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, CFG.MAX_ROUNDS);
  };

  // חלק אירועים – עיבוד הודעות סטטוס מהלובי
  function onStatusEvent(evt) {
    if (!shouldHandle(evt)) return;
    const sender = evt.pubkey?.toLowerCase?.();
    if (!sender || sender === App.publicKey?.toLowerCase?.()) return;
    try {
      const payload = JSON.parse(evt.content || '{}');
      const created = evt.created_at || now();
      if (!payload || created + CFG.LOBBY_TTL < now()) return;
      state.players.set(sender, {
        pubkey: sender,
        name: payload.name || 'שחקן',
        seeking: Boolean(payload.seeking),
        room: payload.room || null,
        inTrivia: Boolean(payload.inTrivia),
        playing: Boolean(payload.playing),
        updatedAt: created
      });
      refreshLobby();
    } catch (err) {
      console.warn('trivia status parse failed', err);
    }
  }

  // חלק אירועים – עיבוד הודעות משחק (הזמנה, שאלה, תשובה)
  function onMatchEvent(evt) {
    if (!shouldHandle(evt)) return;
    const sender = evt.pubkey?.toLowerCase?.();
    const isSelf = sender === App.publicKey?.toLowerCase?.();
    let payload = null;
    try {
      payload = JSON.parse(evt.content || '{}');
    } catch (err) {
      console.warn('trivia match parse failed', err);
      return;
    }
    if (!payload || (payload.room && state.roomId && payload.room !== state.roomId)) return;
    switch (payload.type) {
      case 'invite':
        // הזמנה מיועדת אלינו ואנחנו לא במשחק פעיל
        if (!isSelf && payload.target?.toLowerCase?.() === App.publicKey?.toLowerCase?.() && !state.matchActive && payload.room) {
          // מישהו רוצה לשחק איתנו - מצטרפים ומתחילים משחק
          state.opponentPubkey = sender;
          state.opponentName = state.players.get(sender)?.name || 'שחקן';
          state.roomId = payload.room;
          publishMatch('accept', { opponent: sender, room: payload.room });
          enterMatch(payload.room, sender, state.opponentName, false);
        }
        break;
      case 'accept':
        // היריב אישר - מתחילים משחק כמארח
        if (!isSelf && state.opponentPubkey === sender && !state.matchActive && payload.room) {
          state.seeking = false;
          enterMatch(payload.room, sender, state.opponentName, true);
        }
        break;
      case 'question':
        // רק אם אנחנו במשחק פעיל ובאותו חדר - מניעת כניסה של שחקן 3
        if (!state.matchActive || !state.roomId) break;
        if (payload.room && payload.room !== state.roomId) break;
        renderQuestion(payload.questionIndex, payload.round || 0, payload.totalRounds || CFG.MAX_ROUNDS, payload.startedAt, payload.timeLimit || CFG.QUESTION_TIME);
        break;
      case 'answer':
        // רק אם אנחנו במשחק פעיל וזו תשובה מהיריב שלנו
        if (!state.matchActive || !state.roomId) break;
        if (!isSelf && state.opponentPubkey === sender) {
          rememberAnswer(sender, state.round, Boolean(payload.correct));
          updateScores();
        }
        break;
      case 'final':
        setText(state.ui.feedback, '🎊 המשחק הסתיים!');
        setText(state.ui.timerValue, '--');
        break;
      case 'leave':
        // היריב עזב את המשחק
        if (!isSelf && state.matchActive && sender === state.opponentPubkey) {
          handleOpponentLeft();
        }
        break;
      default:
        break;
    }
  }

  // חלק אירועים – מנגנון למניעת עיבוד כפול של אירועים
  function shouldHandle(evt) {
    if (!evt || !evt.id || state.processed.has(evt.id)) return false;
    state.processed.add(evt.id);
    return true;
  }

  // חלק רישום – רישום לריליי עם SimplePool ברגע שהוא מוכן
  function subscribe() {
    if (!App.pool || !App.relayUrls) return;
    unsubscribe();
    const since = now() - CFG.LOBBY_TTL;
    const filters = [
      { kinds: [CFG.KIND_STATUS], '#t': [CFG.TAG], since },
      { kinds: [CFG.KIND_MATCH], '#t': [CFG.TAG], since }
    ];
    const subscription = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        if (event.kind === CFG.KIND_STATUS) onStatusEvent(event);
        else if (event.kind === CFG.KIND_MATCH) onMatchEvent(event);
      },
      oneose: () => {
        setText(state.ui.lobbyStatus, 'הלובי מוכן. בחרו יריב או פתחו משחק חדש.');
        refreshLobby();
      }
    });
    state.subscriptions.unshift(subscription);
  }

  // חלק רישום – ביטול רישומים קודמים כדי למנוע דליפות
  function unsubscribe() {
    state.subscriptions.forEach((sub) => {
      try {
        if (typeof sub.unsub === 'function') sub.unsub();
        else if (typeof App.pool?.unsubscribe === 'function') App.pool.unsubscribe(sub);
      } catch (err) {
        console.warn('trivia unsubscribe failed', err);
      }
    });
    state.subscriptions = [];
  }

  // חלק bootstrap – הרחבת notifyPoolReady כך שגם המשחק יירשם
  function hookPoolReady() {
    const prev = App.notifyPoolReady;
    App.notifyPoolReady = function patchedNotify(pool) {
      if (typeof prev === 'function') {
        try { prev(pool); } catch (err) { console.warn('notifyPoolReady failed', err); }
      }
      if (pool) {
        App.pool = pool;
        subscribe();
        publishStatus('presence');
      }
    };
  }

  // חלק bootstrap – אתחול המודול לאחר טעינת ה-DOM
  function bootstrap() {
    hookPoolReady();
    if (App.pool) {
      subscribe();
    }
    publishStatus('presence');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();

  // חלק משחק טריוויה – מאפשר לפתוח את המשחק מהתפריט הראשי של האפליקציה
  App.openTriviaGame = function openTriviaGame() {
    openOverlay();
  };
})(window, document);
