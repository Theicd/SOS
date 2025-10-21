// חלק משחק טריוויה – מודול רשת בסגנון math_new עבור "יאללה תקשורת"
;(function initTriviaGame(window, document) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק קבועים – מזהי אירועים, טיימרים והגדרות משחק
  const CFG = {
    TAG: 'yalla_trivia_v1',
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
    fx: null
  };

  // חלק עזר – פונקציות קצרות לשימוש פנימי
  const now = () => Math.floor(Date.now() / 1000);
  const setText = (el, txt) => el && (el.textContent = txt);
  const addClass = (el, cls) => el && el.classList.add(cls);
  const removeClass = (el, cls) => el && el.classList.remove(cls);
  const toggleBodyLock = (lock) => document.body.classList[lock ? 'add' : 'remove']('trivia-open');

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

  // חלק UI – יצירת הכפתור הצף והמודאל בסגנון math_new
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
        <header class="trivia-topbar">
          <div class="trivia-topbar__brand">🎲 טריוויה ברשת • יאללה תקשורת</div>
          <div class="trivia-topbar__actions">
            <button id="triviaReturnHome">חזרה לרשת</button>
            <button id="triviaCloseOverlay" class="trivia-topbar__primary">סגור משחק</button>
          </div>
        </header>
        <section class="trivia-scorestrip">
          <div class="trivia-strip__item"><span class="trivia-strip__label">סבב</span><span class="trivia-strip__value" id="triviaRound">0/10</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">הניקוד שלך</span><span class="trivia-strip__value" id="triviaScoreSelf">0</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">ניקוד יריב</span><span class="trivia-strip__value" id="triviaScoreOpp">0</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">טיימר</span><span class="trivia-strip__value" id="triviaTimer">--</span></div>
          <div class="trivia-strip__item"><span class="trivia-strip__label">דיוק</span><span class="trivia-strip__value" id="triviaAccuracy">0%</span></div>
        </section>
        <section class="trivia-stage">
          <div class="trivia-layer" id="triviaLobbyLayer">
            <div class="trivia-lobby-headline">
              <div>
                <h2>לובי משחקים בזמן אמת</h2>
                <p id="triviaLobbyStatus">מתחבר ללובי... אנא המתן.</p>
              </div>
              <div class="trivia-lobby-cta">
                <button id="triviaSeekButton" class="trivia-btn-primary">חפש שותף</button>
                <button id="triviaCancelButton" class="trivia-btn-secondary" hidden>בטל המתנה</button>
              </div>
            </div>
            <div class="trivia-lobby-grid">
              <article class="trivia-lobby-card">
                <h3>שחקנים זמינים</h3>
                <div class="trivia-player-list" id="triviaPeers"></div>
                <p class="trivia-lobby-note" id="triviaPeersEmpty">אין כרגע שחקנים זמינים. הזמינו חברים!</p>
              </article>
              <article class="trivia-lobby-card">
                <h3>שחקנים שממתינים למשחק</h3>
                <div class="trivia-player-list" id="triviaWaiting"></div>
                <p class="trivia-lobby-note" id="triviaWaitingEmpty">אף אחד עדיין לא מחפש שותף.</p>
              </article>
            </div>
          </div>
          <div class="trivia-layer" id="triviaGameLayer">
            <div class="trivia-game-panel">
              <div class="trivia-versus">
                <div class="trivia-playercard">
                  <span class="trivia-playercard__title">המשחק שלך</span>
                  <span class="trivia-playercard__name" id="triviaSelfName">אתה</span>
                  <div class="trivia-playercard__score"><span>ניקוד:</span><span id="triviaSelfScoreCard">0</span></div>
                </div>
                <div class="trivia-playercard">
                  <span class="trivia-playercard__title">היריב שלך</span>
                  <span class="trivia-playercard__name" id="triviaOpponentName">---</span>
                  <div class="trivia-playercard__score"><span>ניקוד:</span><span id="triviaOppScoreCard">0</span></div>
                </div>
              </div>
              <div class="trivia-question-box" id="triviaQuestion">המשחק יתחיל ברגע ששני שחקנים יצטרפו.</div>
              <div class="trivia-answer-grid" id="triviaAnswers"></div>
              <div class="trivia-feedback" id="triviaFeedback"></div>
              <div class="trivia-game-actions"><button id="triviaLeaveButton">חזרה ללובי</button></div>
              <div class="trivia-banner" id="triviaBanner">ברוכים הבאים לזירה! מצאו שותף והתחילו להתחרות.</div>
            </div>
          </div>
        </section>
      </div>
    `;
    document.body.append(overlay);
    state.ui = {
      overlay,
      lobbyLayer: overlay.querySelector('#triviaLobbyLayer'),
      gameLayer: overlay.querySelector('#triviaGameLayer'),
      lobbyStatus: overlay.querySelector('#triviaLobbyStatus'),
      seekBtn: overlay.querySelector('#triviaSeekButton'),
      cancelBtn: overlay.querySelector('#triviaCancelButton'),
      peersList: overlay.querySelector('#triviaPeers'),
      peersEmpty: overlay.querySelector('#triviaPeersEmpty'),
      waitingList: overlay.querySelector('#triviaWaiting'),
      waitingEmpty: overlay.querySelector('#triviaWaitingEmpty'),
      roundValue: overlay.querySelector('#triviaRound'),
      scoreSelfValue: overlay.querySelector('#triviaScoreSelf'),
      scoreOppValue: overlay.querySelector('#triviaScoreOpp'),
      timerValue: overlay.querySelector('#triviaTimer'),
      accuracyValue: overlay.querySelector('#triviaAccuracy'),
      questionBox: overlay.querySelector('#triviaQuestion'),
      answersGrid: overlay.querySelector('#triviaAnswers'),
      feedback: overlay.querySelector('#triviaFeedback'),
      banner: overlay.querySelector('#triviaBanner'),
      leaveBtn: overlay.querySelector('#triviaLeaveButton'),
      selfName: overlay.querySelector('#triviaSelfName'),
      oppName: overlay.querySelector('#triviaOpponentName'),
      selfScoreCard: overlay.querySelector('#triviaSelfScoreCard'),
      oppScoreCard: overlay.querySelector('#triviaOppScoreCard'),
      closeBtn: overlay.querySelector('#triviaCloseOverlay'),
      returnBtn: overlay.querySelector('#triviaReturnHome')
    };
    state.fx = createGameShowFX({
      backgroundEl: overlay.querySelector('.trivia-background'),
      bannerEl: state.ui.banner,
      timerEl: state.ui.timerValue,
      roundEl: state.ui.roundValue,
      accuracyEl: state.ui.accuracyValue,
      scoreElements: {
        stripSelf: state.ui.scoreSelfValue,
        stripOpp: state.ui.scoreOppValue,
        cardSelf: state.ui.selfScoreCard,
        cardOpp: state.ui.oppScoreCard
      }
    });
    state.ui.closeBtn.addEventListener('click', closeOverlay);
    state.ui.returnBtn.addEventListener('click', closeOverlay);
    state.ui.seekBtn.addEventListener('click', startSeeking);
    state.ui.cancelBtn.addEventListener('click', cancelSeeking);
    state.ui.leaveBtn.addEventListener('click', leaveMatch);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeOverlay(); });
  }

  // חלק פתיחה – הצגת המודאל, נעילת גלילה ושליחת נוכחות
  function openOverlay() {
    buildUI();
    if (!state.ui.overlay) return;
    state.ui.overlay.classList.add('is-open');
    state.ui.overlay.setAttribute('aria-hidden', 'false');
    toggleBodyLock(true);
    setText(state.ui.lobbyStatus, 'מתחבר ללובי... אנא המתן.');
    switchToLobby();
    refreshLobby();
    ensurePresenceLoop();
    publishStatus('presence');
    state.fx?.onOverlayOpen();
  }

  // חלק סגירה – שחרור נעילת גלילה וביטול חיפוש אם יש
  function closeOverlay() {
    if (!state.ui.overlay) return;
    state.ui.overlay.classList.remove('is-open');
    state.ui.overlay.setAttribute('aria-hidden', 'true');
    toggleBodyLock(false);
    if (state.seeking) cancelSeeking();
  }

  // חלק תצוגה – מעבר בין הלובי לזירה
  const switchToLobby = () => {
    state.matchActive = false;
    addClass(state.ui.lobbyLayer, 'is-active');
    removeClass(state.ui.gameLayer, 'is-active');
    state.fx?.onLobby();
  };
  const switchToGame = () => {
    addClass(state.ui.gameLayer, 'is-active');
    removeClass(state.ui.lobbyLayer, 'is-active');
    state.fx?.onStage();
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
    const payload = { type, name: App.profile?.name || 'שחקן', seeking: state.seeking, room: state.roomId, timestamp, ...extra };
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

  // חלק לובי – הצטרפות לשחקן שמחפש יריב
  function joinWaiting(pubkey, roomId, name) {
    if (!App.publicKey || !roomId) return;
    state.seeking = false;
    state.isHost = false;
    state.roomId = roomId;
    state.opponentPubkey = pubkey;
    state.opponentName = name || 'יריב';
    state.ui.seekBtn.disabled = false;
    state.ui.cancelBtn.hidden = true;
    setText(state.ui.lobbyStatus, `הזמנה נשלחה אל ${state.opponentName}. ממתינים לאישור...`);
    publishMatch('invite', { target: pubkey });
  }

  // חלק משחק – כניסה לזירה מול היריב
  function enterMatch(roomId, opponentPubkey, opponentName, asHost) {
    state.matchActive = true;
    state.roomId = roomId;
    state.opponentPubkey = opponentPubkey;
    state.opponentName = opponentName || 'יריב';
    state.isHost = asHost;
    state.round = 0;
    state.order = shuffleQuestions();
    state.answers.clear();
    state.metrics = { correct: 0, total: 0, streak: 0, best: 0 };
    switchToGame();
    updateScores();
    setText(state.ui.selfName, App.profile?.name || 'אתה');
    setText(state.ui.oppName, state.opponentName);
    setText(state.ui.banner, '🔥 המשחק התחיל! ענו מהר והובילו בניקוד.');
    setText(state.ui.feedback, '');
    state.fx?.onMatchStart({ opponent: state.opponentName });
    if (state.isHost) {
      publishStatus('match');
      sendQuestion(0);
    } else {
      publishStatus('playing');
      setText(state.ui.questionBox, 'מחכים לשאלה הראשונה מהמארח...');
    }
  }

  // חלק משחק – חזרה ללובי וסיום הסשן
  function leaveMatch() {
    clearTimers();
    state.matchActive = false;
    state.roomId = null;
    state.opponentPubkey = null;
    state.round = 0;
    state.ui.answersGrid.innerHTML = '';
    setText(state.ui.questionBox, 'המשחק יתחיל ברגע ששני שחקנים יצטרפו.');
    setText(state.ui.feedback, '');
    setText(state.ui.banner, 'חזרתם ללובי. פתחו משחק חדש או הצטרפו לחברים.');
    publishStatus('idle');
    switchToLobby();
    refreshLobby();
    state.fx?.onLobby();
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
    setText(state.ui.questionBox, `${round + 1}/${totalRounds} • ${data.q}`);
    state.ui.answersGrid.innerHTML = '';
    setText(state.ui.feedback, '');
    data.answers.forEach((text, idx) => {
      const btn = Object.assign(document.createElement('button'), { className: 'trivia-answer-btn', type: 'button', textContent: text });
      btn.dataset.option = String(idx);
      btn.addEventListener('click', () => submitAnswer(idx, data.correct));
      state.ui.answersGrid.appendChild(btn);
    });
    updateRound(round, totalRounds);
    runTimer(startedAt, timeLimit);
    state.fx?.onQuestion({ question: data.q, round, totalRounds });
  }

  // חלק תשובות – שליחת הבחירה לריליי והצגת פידבק
  function submitAnswer(optionIdx, correctIdx) {
    if (!state.matchActive || !state.roomId) return;
    markAnswer(optionIdx, correctIdx);
    disableAnswers();
    const isCorrect = optionIdx === correctIdx;
    rememberAnswer(App.publicKey, state.round, isCorrect);
    publishMatch('answer', { option: optionIdx, correct: isCorrect });
    setText(state.ui.feedback, isCorrect ? '🎉 תשובה נכונה! המשיכו כך.' : '❗ פספוס קטן, יש עוד סיבובים.');
    updateScores();
    updatePlayerMetrics(isCorrect);
    state.fx?.onAnswer({ correct: isCorrect, streak: state.metrics.streak, total: state.metrics.total, accuracy: getAccuracy() });
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

  // חלק ניקוד – עידכון לוח הניקוד ודיוק התשובות
  function updateScores() {
    const selfEntry = state.answers.get(App.publicKey) || { answers: {}, score: 0 };
    const oppEntry = state.answers.get(state.opponentPubkey) || { answers: {}, score: 0 };
    const selfScore = selfEntry.score || 0;
    const oppScore = oppEntry.score || 0;
    const answered = Object.keys(selfEntry.answers).length;
    const accuracy = answered ? Math.round((selfScore / answered) * 100) : 0;
    setText(state.ui.scoreSelfValue, String(selfScore));
    setText(state.ui.scoreOppValue, String(oppScore));
    setText(state.ui.selfScoreCard, String(selfScore));
    setText(state.ui.oppScoreCard, String(oppScore));
    setText(state.ui.accuracyValue, `${accuracy}%`);
    state.fx?.scoreboard.update({ selfScore, oppScore, accuracy, answered });
  }

  // חלק סיום – סיום המשחק ושליחת הודעת final לרשת
  function finishMatch() {
    clearTimers();
    publishMatch('final');
    setText(state.ui.banner, '🎊 המשחק הסתיים! חזרו ללובי לדו-קרב נוסף.');
    setText(state.ui.feedback, '');
    setText(state.ui.timerValue, '--');
    state.isHost = false;
    state.fx?.onMatchEnd({ selfScore: state.answers.get(App.publicKey)?.score || 0, oppScore: state.answers.get(state.opponentPubkey)?.score || 0 });
  }

  // חלק טיימר – שעון משותף לשאלה הנוכחית
  function runTimer(startedAt, timeLimit) {
    clearInterval(state.timers.interval);
    const end = (startedAt || now()) + (timeLimit || CFG.QUESTION_TIME);
    state.fx?.timer.start(timeLimit || CFG.QUESTION_TIME);
    const tick = () => {
      const remaining = Math.max(0, end - now());
      setText(state.ui.timerValue, remaining.toString().padStart(2, '0'));
      state.fx?.timer.tick(remaining);
      if (!remaining) {
        clearInterval(state.timers.interval);
        disableAnswers();
        state.fx?.onTimeout();
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
    state.fx?.timer.stop();
  }

  // חלק סבב – עדכון פס הסבבים בהתאם להתקדמות
  const updateRound = (round, total) => setText(state.ui.roundValue, `${round + 1}/${total}`);

  // חלק לובי – רענון רשימות השחקנים המחוברים והמחכים
  function refreshLobby() {
    const currentTime = now();
    const peers = [];
    const waiting = [];
    for (const player of state.players.values()) {
      if (player.updatedAt + CFG.LOBBY_TTL < currentTime) {
        state.players.delete(player.pubkey);
        continue;
      }
      (player.seeking ? waiting : peers).push(player);
    }
    renderPlayerList(state.ui.peersList, state.ui.peersEmpty, peers, false);
    renderPlayerList(state.ui.waitingList, state.ui.waitingEmpty, waiting, true);
  }

  // חלק לובי – ציור כרטיסי שחקנים בסגנון math_new
  function renderPlayerList(container, emptyLabel, list, joinable) {
    container.innerHTML = '';
    if (!list.length) {
      emptyLabel.hidden = false;
      return;
    }
    emptyLabel.hidden = true;
    list.forEach((player) => {
      const row = document.createElement('div');
      row.className = 'trivia-player-row';
      const meta = document.createElement('div');
      meta.className = 'trivia-player-meta';
      const name = document.createElement('span');
      name.textContent = player.name || 'שחקן';
      const status = document.createElement('span');
      status.textContent = joinable ? 'ממתין למשחק' : 'זמין כעת';
      meta.append(name, status);
      row.appendChild(meta);
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = joinable ? 'הצטרף למשחק' : 'פרטים';
      action.disabled = !joinable;
      if (joinable) action.addEventListener('click', () => joinWaiting(player.pubkey, player.room, player.name));
      row.appendChild(action);
      container.appendChild(row);
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
        if (!isSelf && payload.target?.toLowerCase?.() === App.publicKey?.toLowerCase?.() && state.seeking) {
          state.opponentPubkey = sender;
          state.opponentName = state.players.get(sender)?.name || 'שחקן';
          publishMatch('accept', { opponent: sender });
          enterMatch(state.roomId, sender, state.opponentName, true);
        }
        break;
      case 'accept':
        if (!isSelf && state.opponentPubkey && sender === state.opponentPubkey) enterMatch(state.roomId, sender, state.opponentName, false);
        break;
      case 'question':
        if (!state.matchActive) switchToGame();
        renderQuestion(payload.questionIndex, payload.round || 0, payload.totalRounds || CFG.MAX_ROUNDS, payload.startedAt, payload.timeLimit || CFG.QUESTION_TIME);
        break;
      case 'answer':
        if (!isSelf && state.opponentPubkey === sender) {
          rememberAnswer(sender, state.round, Boolean(payload.correct));
          updateScores();
        }
        break;
      case 'final':
        setText(state.ui.banner, '🎊 המשחק הסתיים! פתיחת דו-קרב חוזר זמינה בלובי.');
        setText(state.ui.timerValue, '--');
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
    buildUI();
    hookPoolReady();
    if (App.pool) {
      subscribe();
      publishStatus('presence');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();

  // חלק משחק טריוויה – מאפשר לפתוח את המשחק מהתפריט הראשי של האפליקציה
  App.openTriviaGame = function openTriviaGame() {
    openOverlay();
  };

  // חלק אפקטים – קריינות, צלילים ורקע מתחלף בסגנון math_new
  function createGameShowFX(ctx) {
    const background = createBackgroundEngine(ctx.backgroundEl);
    const audio = {
      tick: null,
      correct: null,
      wrong: null,
      fanfare: null
    };
    let tickInterval = null;
    let speechLock = false;

    function speak(text, opts = {}) {
      if (!('speechSynthesis' in window) || !text) return;
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = opts.lang || 'he-IL';
        utter.rate = opts.rate || 0.95;
        utter.pitch = opts.pitch || 1;
        utter.volume = opts.volume || 0.85;
        speechLock = true;
        utter.onend = () => { speechLock = false; };
        window.speechSynthesis.speak(utter);
      } catch (err) {
        console.warn('speech failed', err);
      }
    }

    function playOnce(el) {
      if (!el) return;
      try {
        el.currentTime = 0;
        void el.play();
      } catch (err) {
        console.warn('audio play failed', err);
      }
    }

    function stopTickLoop() {
      clearInterval(tickInterval);
      tickInterval = null;
    }

    return {
      onOverlayOpen() {
        speak('ברוכים הבאים לאתגר הטריוויה של יאללה תקשורת! בחרו יריב והזניקו את המשחק.');
        if (ctx.bannerEl) ctx.bannerEl.textContent = '🎤 מוכנים לזירה? מצאו יריב או הזמינו חברים.';
      },
      onLobby() {
        stopTickLoop();
        if (!speechLock) speak('חזרה ללובי. סמנו יריב ופיתחו משחק חדש.');
      },
      onStage() {
        if (ctx.bannerEl) ctx.bannerEl.textContent = '🎬 מתכוננים לשאלה הבאה...';
      },
      onMatchStart({ opponent }) {
        speak(`המשחק יוצא לדרך מול ${opponent || 'היריב'}. בהצלחה!`);
        if (ctx.bannerEl) ctx.bannerEl.textContent = `🎯 דו-קרב מול ${opponent || 'היריב'}. הבמה שלכם!`;
      },
      onQuestion({ question, round, totalRounds }) {
        background.update(question, round);
        speak(`שאלה מספר ${round + 1} מתוך ${totalRounds}. ${question}`);
        if (ctx.bannerEl) ctx.bannerEl.textContent = `❓ שאלה ${round + 1}/${totalRounds} – ריכוז מלא!`;
      },
      onAnswer({ correct, streak, accuracy }) {
        if (correct) {
          if (audio.correct) playOnce(audio.correct);
          if (streak >= 3 && audio.fanfare) playOnce(audio.fanfare);
          speak(streak >= 3 ? `מדהים! ${streak} תשובות רצופות.` : 'תשובה נכונה!');
          if (ctx.bannerEl) ctx.bannerEl.textContent = streak >= 3 ? `🔥 רצף של ${streak} תשובות! המשיכו כך.` : '✅ תשובה מצוינת. השתלטו על הבמה.';
        } else {
          if (audio.wrong) playOnce(audio.wrong);
          speak('טעות קטנה, נסו שוב בשאלה הבאה.');
          if (ctx.bannerEl) ctx.bannerEl.textContent = '⚠️ לא נורא, קחו נשימה וננסה שוב.';
        }
        if (ctx.accuracyEl) {
          ctx.accuracyEl.classList.add('trivia-accuracy-flash');
          setTimeout(() => ctx.accuracyEl.classList.remove('trivia-accuracy-flash'), 600);
          if (typeof accuracy === 'number') ctx.accuracyEl.textContent = `${accuracy}%`;
        }
      },
      onTimeout() {
        stopTickLoop();
        if (audio.wrong) playOnce(audio.wrong);
        speak('הזמן הסתיים! היו מוכנים לשאלה הבאה.');
        if (ctx.bannerEl) ctx.bannerEl.textContent = '⏳ נגמר הזמן. השאלה הבאה מגיעה מיד.';
      },
      onMatchEnd({ selfScore, oppScore }) {
        stopTickLoop();
        const verdict = selfScore === oppScore ? 'שוויון מרתק!' : selfScore > oppScore ? 'ניצחון מהדהד!' : 'הפעם היריב הוביל.';
        speak(`${verdict} תוצאה ${selfScore} מול ${oppScore}.`);
        if (ctx.bannerEl) ctx.bannerEl.textContent = `🏁 ${verdict} • חזרו ללובי לאתגר נוסף.`;
      },
      timer: {
        start(limit) {
          stopTickLoop();
          if (!limit) return;
          if (audio.tick) {
            tickInterval = setInterval(() => playOnce(audio.tick), 1000);
          }
        },
        tick(remaining) {
          if (!ctx.timerEl) return;
          if (remaining <= 5) ctx.timerEl.classList.add('trivia-timer-alert');
          else ctx.timerEl.classList.remove('trivia-timer-alert');
        },
        stop() {
          stopTickLoop();
          ctx.timerEl?.classList.remove('trivia-timer-alert');
        }
      },
      scoreboard: {
        update({ selfScore, oppScore, accuracy }) {
          if (ctx.scoreElements.stripSelf) ctx.scoreElements.stripSelf.textContent = selfScore;
          if (ctx.scoreElements.cardSelf) ctx.scoreElements.cardSelf.textContent = selfScore;
          if (ctx.scoreElements.stripOpp) ctx.scoreElements.stripOpp.textContent = oppScore;
          if (ctx.scoreElements.cardOpp) ctx.scoreElements.cardOpp.textContent = oppScore;
          if (typeof accuracy === 'number' && ctx.accuracyEl) ctx.accuracyEl.textContent = `${accuracy}%`;
        }
      }
    };
  }

  // חלק רקעים – חיפוש תמונות בסגנון setAmbientByTopic מהמשחק המקורי
  function createBackgroundEngine(targetEl) {
    const cache = new Map();
    let currentToken = 0;

    // מילון בסיסי לתרגום מילות מפתח בעברית -> אנגלית בדומה ל-TOPIC_MAP המקורי
    const WORD_MAP = {
      'חשבון': 'math kids',
      'מספר': 'numbers challenge',
      'ישראל': 'israel history',
      'בירה': 'capital city',
      'חיה': 'animal trivia',
      'מדע': 'science facts',
      'טבע': 'nature landscape',
      'ים': 'ocean seascape',
      'חלל': 'space stars',
      'תולדות': 'history world'
    };

    function buildQueryFromQuestion(question, round) {
      const base = String(question || '')
        .replace(/["׳",.\-\[\]\(\)!?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!base) return `kids quiz show background ${round + 1}`;
      for (const [he, en] of Object.entries(WORD_MAP)) {
        if (base.includes(he)) return en;
      }
      // נ fallback פשוט: קח את שתי המילים הראשונות ותוסיף רקע
      const tokens = base.split(' ').slice(0, 3).join(' ');
      return `${tokens} background`;
    }

    async function searchImage(query) {
      const apiKey = '25540812-faf2b76d586c1787d2dd02736';
      const url = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=18&safe_search=true`;
      const res = await fetch(url);
      const data = await res.json();
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      const pick = hits[Math.floor(Math.random() * Math.max(1, hits.length))];
      return pick?.largeImageURL || pick?.webformatURL || '';
    }

    async function updateBackground(question, round) {
      if (!targetEl) return;
      const query = buildQueryFromQuestion(question, round);
      const cacheKey = `${round}:${query}`;
      if (cache.has(cacheKey)) {
        targetEl.style.backgroundImage = cache.get(cacheKey);
        return;
      }
      const token = ++currentToken;
      const imageUrl = await searchImage(query);
      if (!imageUrl || token !== currentToken) return;
      const composed = `linear-gradient(180deg, rgba(24,36,82,0.55), rgba(8,12,26,0.85)), url('${imageUrl}') center/cover`;
      cache.set(cacheKey, composed);
      targetEl.style.backgroundImage = composed;
    }

    return {
      update(question, round) {
        void updateBackground(question, round).catch((err) => console.warn('background fetch failed', err));
      }
    };
  }
})(window, document);
