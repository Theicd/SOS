// חלק משחק טריוויה – מודול לובי ושאלות מבוסס Nostr עבור "יאללה תקשורת"
;(function initTrivia(window, document) {
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

  // חלק בנק שאלות – 10 שאלות בסיסיות להדגמה
  const QUESTIONS = [
    { q: 'כמה זה 7 + 5?', answers: ['10', '11', '12', '13'], correct: 2 },
    { q: 'כמה זה 9 - 4?', answers: ['3', '4', '5', '6'], correct: 2 },
    { q: 'מהי בירת ישראל?', answers: ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'], correct: 1 },
    { q: 'איזו נוסחה כימית מתארת מים?', answers: ['CO2', 'H2O', 'O2', 'NaCl'], correct: 1 },
    { q: 'באיזו שנה הוכרזה מדינת ישראל?', answers: ['1946', '1948', '1950', '1952'], correct: 1 },
    { q: 'מהי המילה הנרדפת ל"מהיר"?', answers: ['זריז', 'כבד', 'עמוס', 'רחב'], correct: 0 },
    { q: 'כמה זה 6 × 3?', answers: ['12', '15', '18', '20'], correct: 2 },
    { q: 'איזה בעל חיים הוא יונק?', answers: ['תנין', 'כריש', 'דולפין', 'צפרדע'], correct: 2 },
    { q: 'מי המציא את הנורה החשמלית?', answers: ['אדיסון', 'ניוטון', 'בל', 'מרקוני'], correct: 0 },
    { q: 'כמה זה 21 ÷ 3?', answers: ['6', '7', '8', '9'], correct: 1 }
  ];

  // חלק מצב – מאחסן הפניות ל-UI ולמצב המשחק
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
    presenceInterval: null
  };

  // חלק UI – טוען stylesheet ומייצר את הכפתור הצף והמודאל
  function buildUI() {
    if (state.ui.modal) return;

    if (!document.getElementById('triviaStylesheet')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.id = 'triviaStylesheet';
      link.href = './styles/game-trivia.css';
      document.head.appendChild(link);
    }

    const fab = document.createElement('button');
    fab.className = 'trivia-fab';
    fab.id = 'triviaFab';
    fab.type = 'button';
    fab.innerText = '🎲';
    fab.title = 'שחקו יחד בטריוויה';

    const modal = document.createElement('div');
    modal.className = 'trivia-modal';
    modal.id = 'triviaModal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="trivia-panel" role="dialog" aria-modal="true" aria-labelledby="triviaTitle">
        <header class="trivia-header">
          <div>
            <h2 id="triviaTitle">שחקו יחד בטריוויה</h2>
            <div class="trivia-header__status" id="triviaStatus">מתחבר ללובי...</div>
          </div>
          <button class="trivia-header__close" id="triviaClose" aria-label="סגירת משחק">✕</button>
        </header>
        <section class="trivia-lobby" id="triviaLobby">
          <article class="trivia-lobby__card">
            <h3>שחקנים מחוברים</h3>
            <div class="trivia-lobby__list" id="triviaPeers"></div>
            <p class="trivia-controls__note" id="triviaPeersEmpty">אין כרגע שחקנים מחוברים נוספים.</p>
          </article>
          <article class="trivia-lobby__card">
            <h3>שחקנים שממתינים למשחק</h3>
            <div class="trivia-lobby__list" id="triviaWaiting"></div>
            <p class="trivia-controls__note" id="triviaWaitingEmpty">אף אחד עדיין לא מחפש שותף.</p>
            <div class="trivia-controls">
              <button class="trivia-button trivia-button--primary" id="triviaSeek">חפש שותף</button>
              <button class="trivia-button trivia-button--secondary" id="triviaCancel" hidden>בטל המתנה</button>
            </div>
          </article>
        </section>
        <section class="trivia-match" id="triviaMatch" hidden>
          <div class="trivia-scoreboard">
            <div class="trivia-score" id="triviaScoreSelf">
              <h4>הניקוד שלך</h4>
              <div class="trivia-score__value" data-role="value">0</div>
              <div class="trivia-controls__note" data-role="name">אתה</div>
            </div>
            <div class="trivia-score" id="triviaScoreOpponent">
              <h4>ניקוד היריב</h4>
              <div class="trivia-score__value" data-role="value">0</div>
              <div class="trivia-controls__note" data-role="name">---</div>
            </div>
          </div>
          <div class="trivia-question" id="triviaQuestion">המשחק יתחיל עם הצטרפות שני שחקנים.</div>
          <div class="trivia-answers" id="triviaAnswers"></div>
          <div class="trivia-feedback" id="triviaFeedback"></div>
          <footer class="trivia-footer">
            <div class="trivia-timer">
              <span>זמן שנותר לשאלה:</span>
              <span class="trivia-timer__circle" id="triviaTimer">--</span>
            </div>
            <button class="trivia-button trivia-button--secondary" id="triviaLeave">חזרה ללובי</button>
          </footer>
        </section>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(modal);

    state.ui = {
      fab,
      modal,
      status: modal.querySelector('#triviaStatus'),
      lobby: modal.querySelector('#triviaLobby'),
      peers: modal.querySelector('#triviaPeers'),
      peersEmpty: modal.querySelector('#triviaPeersEmpty'),
      waiting: modal.querySelector('#triviaWaiting'),
      waitingEmpty: modal.querySelector('#triviaWaitingEmpty'),
      seek: modal.querySelector('#triviaSeek'),
      cancel: modal.querySelector('#triviaCancel'),
      close: modal.querySelector('#triviaClose'),
      match: modal.querySelector('#triviaMatch'),
      question: modal.querySelector('#triviaQuestion'),
      answers: modal.querySelector('#triviaAnswers'),
      feedback: modal.querySelector('#triviaFeedback'),
      timer: modal.querySelector('#triviaTimer'),
      scoreSelf: modal.querySelector('#triviaScoreSelf [data-role="value"]'),
      scoreOpp: modal.querySelector('#triviaScoreOpponent [data-role="value"]'),
      nameSelf: modal.querySelector('#triviaScoreSelf [data-role="name"]'),
      nameOpp: modal.querySelector('#triviaScoreOpponent [data-role="name"]'),
      leave: modal.querySelector('#triviaLeave')
    };

    fab.addEventListener('click', openModal);
    state.ui.close.addEventListener('click', closeModal);
    state.ui.seek.addEventListener('click', startSeeking);
    state.ui.cancel.addEventListener('click', cancelSeeking);
    state.ui.leave.addEventListener('click', leaveMatch);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal(); });
  }

  // חלק פתיחה – הצגת המודאל ושליחת נוכחות לריליי
  function openModal() {
    if (!state.ui.modal) return;
    state.ui.modal.classList.add('is-open');
    state.ui.modal.setAttribute('aria-hidden', 'false');
    state.ui.status.textContent = 'מתחבר ללובי...';
    refreshLobby();
    ensurePresenceLoop();
    publishStatus('presence');
  }

  // חלק סגירה – מסתיר מודאל ומבטל חיפוש פעיל
  function closeModal() {
    if (!state.ui.modal) return;
    state.ui.modal.classList.remove('is-open');
    state.ui.modal.setAttribute('aria-hidden', 'true');
    if (state.seeking) cancelSeeking();
  }

  // חלק נוכחות – שליחת heartbeat כל חצי דקה
  function ensurePresenceLoop() {
    if (state.presenceInterval) return;
    state.presenceInterval = setInterval(() => publishStatus('presence'), 30000);
  }

  // חלק פרסום – הודעות סטטוס ללובי
  function publishStatus(type, extra = {}) {
    if (!App.pool || typeof App.finalizeEvent !== 'function') return;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      type,
      name: App.profile?.name || 'שחקן',
      seeking: state.seeking,
      room: state.roomId,
      timestamp: now,
      ...extra
    };
    const event = App.finalizeEvent({
      kind: CFG.KIND_STATUS,
      created_at: now,
      tags: [['t', CFG.TAG]],
      content: JSON.stringify(payload)
    }, App.privateKey);
    try {
      App.pool.publish(App.relayUrls, event);
    } catch (err) {
      console.warn('trivia status publish failed', err);
    }
  }

  // חלק פרסום – הודעות משחק בזמן אמת
  function publishMatch(type, extra = {}) {
    if (!App.pool || !state.roomId || typeof App.finalizeEvent !== 'function') return;
    const now = Math.floor(Date.now() / 1000);
    const event = App.finalizeEvent({
      kind: CFG.KIND_MATCH,
      created_at: now,
      tags: [['t', CFG.TAG], ['room', state.roomId]],
      content: JSON.stringify({ type, room: state.roomId, round: state.round, ...extra })
    }, App.privateKey);
    try {
      App.pool.publish(App.relayUrls, event);
    } catch (err) {
      console.warn('trivia match publish failed', err);
    }
  }

  // חלק חיפוש – התחלת המתנה לשותף
  function startSeeking() {
    if (state.seeking || !App.publicKey) return;
    state.seeking = true;
    state.roomId = createRoomId();
    state.isHost = true;
    state.ui.seek.textContent = 'מחפש... נא להמתין';
    state.ui.seek.disabled = true;
    state.ui.cancel.hidden = false;
    publishStatus('seek');
    refreshLobby();
  }

  // חלק חיפוש – ביטול המתנה
  function cancelSeeking() {
    state.seeking = false;
    state.isHost = false;
    state.roomId = null;
    state.ui.seek.textContent = 'חפש שותף';
    state.ui.seek.disabled = false;
    state.ui.cancel.hidden = true;
    publishStatus('idle');
    refreshLobby();
  }

  // חלק לובי – הצטרפות לשחקן שממתין
  function joinWaiting(pubkey, roomId, name) {
    if (!App.publicKey || !roomId) return;
    state.seeking = false;
    state.isHost = false;
    state.roomId = roomId;
    state.opponentPubkey = pubkey;
    state.opponentName = name || 'יריב';
    state.ui.seek.textContent = 'חפש שותף';
    state.ui.seek.disabled = false;
    state.ui.cancel.hidden = true;
    publishMatch('invite', { target: pubkey });
    state.ui.status.textContent = 'שלחנו הזמנה. ממתינים לאישור...';
  }

  // חלק משחק – כניסה למשחק דו-קרב
  function enterMatch(roomId, opponentPubkey, opponentName, asHost) {
    state.matchActive = true;
    state.roomId = roomId;
    state.opponentPubkey = opponentPubkey;
    state.opponentName = opponentName || 'יריב';
    state.isHost = asHost;
    state.round = 0;
    state.order = shuffleQuestions();
    state.answers.clear();
    updateScores();
    state.ui.lobby.hidden = true;
    state.ui.match.hidden = false;
    state.ui.match.classList.add('is-active');
    state.ui.nameSelf.textContent = App.profile?.name || 'אתה';
    state.ui.nameOpp.textContent = state.opponentName;
    state.ui.feedback.textContent = '';
    if (state.isHost) {
      publishStatus('match');
      sendQuestion(0);
    } else {
      publishStatus('playing');
      state.ui.status.textContent = 'מחכים לשאלה הראשונה...';
    }
  }

  // חלק משחק – חזרה ללובי וסיום סשן
  function leaveMatch() {
    clearTimers();
    state.matchActive = false;
    state.roomId = null;
    state.opponentPubkey = null;
    state.round = 0;
    state.ui.match.classList.remove('is-active');
    state.ui.match.hidden = true;
    state.ui.lobby.hidden = false;
    state.ui.question.textContent = 'המשחק יתחיל עם הצטרפות שני שחקנים.';
    state.ui.answers.innerHTML = '';
    state.ui.feedback.textContent = '';
    state.ui.timer.textContent = '--';
    publishStatus('idle');
    refreshLobby();
  }

  // חלק שאלות – שליחת שאלה חדשה על ידי המארח
  function sendQuestion(index) {
    if (!state.isHost || !state.matchActive) return;
    if (index >= state.order.length) {
      finishMatch();
      return;
    }
    state.round = index;
    const qIndex = state.order[index];
    publishMatch('question', {
      questionIndex: qIndex,
      totalRounds: state.order.length,
      startedAt: Math.floor(Date.now() / 1000),
      timeLimit: CFG.QUESTION_TIME
    });
    armNextQuestion();
  }

  // חלק שאלות – תזמון השאלה הבאה (מארח בלבד)
  function armNextQuestion() {
    clearTimeout(state.timers.question);
    if (!state.isHost) return;
    state.timers.question = setTimeout(() => sendQuestion(state.round + 1), CFG.QUESTION_TIME * 1000 + 400);
  }

  // חלק שאלות – הצגת השאלה ללקוח
  function renderQuestion(questionIndex, round, totalRounds, startedAt, timeLimit) {
    const data = QUESTIONS[questionIndex];
    if (!data) return;
    state.round = round;
    state.ui.question.textContent = `${round + 1}/${totalRounds} • ${data.q}`;
    state.ui.answers.innerHTML = '';
    state.ui.feedback.textContent = '';
    data.answers.forEach((text, idx) => {
      const btn = document.createElement('button');
      btn.className = 'trivia-answer';
      btn.type = 'button';
      btn.textContent = text;
      btn.dataset.option = String(idx);
      btn.addEventListener('click', () => submitAnswer(idx, data.correct));
      state.ui.answers.appendChild(btn);
    });
    runTimer(startedAt, timeLimit);
  }

  // חלק תשובות – שליחת בחירת המשתמש לריליי
  function submitAnswer(optionIdx, correctIdx) {
    if (!state.matchActive || !state.roomId) return;
    disableAnswers();
    markAnswer(optionIdx, correctIdx);
    const isCorrect = optionIdx === correctIdx;
    rememberAnswer(App.publicKey, state.round, isCorrect);
    publishMatch('answer', { option: optionIdx, correct: isCorrect });
    state.ui.feedback.textContent = isCorrect ? 'כל הכבוד! תשובה נכונה.' : 'ננסה יותר טוב בשאלה הבאה.';
    updateScores();
  }

  // חלק תשובות – סימון תשובה נבחרת ונכונה בממשק
  function markAnswer(optionIdx, correctIdx) {
    const chosen = state.ui.answers.querySelector(`[data-option="${optionIdx}"]`);
    if (chosen) chosen.classList.add(optionIdx === correctIdx ? 'is-correct' : 'is-wrong');
    const correct = state.ui.answers.querySelector(`[data-option="${correctIdx}"]`);
    if (correct) correct.classList.add('is-correct');
  }

  // חלק תשובות – נטרול כפתורים לאחר בחירה
  function disableAnswers() {
    state.ui.answers.querySelectorAll('.trivia-answer').forEach((btn) => { btn.disabled = true; });
  }

  // חלק ניקוד – שמירת תשובות עבור כל שחקן
  function rememberAnswer(pubkey, round, isCorrect) {
    if (!pubkey) return;
    const entry = state.answers.get(pubkey) || { score: 0, answers: {} };
    entry.answers[round] = isCorrect;
    entry.score = Object.values(entry.answers).filter(Boolean).length;
    state.answers.set(pubkey, entry);
  }

  // חלק ניקוד – עדכון התצוגה של הניקוד
  function updateScores() {
    const self = state.answers.get(App.publicKey) || { score: 0 };
    const opp = state.answers.get(state.opponentPubkey) || { score: 0 };
    state.ui.scoreSelf.textContent = String(self.score || 0);
    state.ui.scoreOpp.textContent = String(opp.score || 0);
  }

  // חלק סיום – שליחת אירוע סיום וחזרה לעמדת מארח פסיבי
  function finishMatch() {
    clearTimers();
    publishMatch('final');
    state.ui.feedback.textContent = 'המשחק הסתיים! אפשר לחזור ללובי או להתחיל סשן חדש.';
    state.ui.timer.textContent = '--';
    state.isHost = false;
  }

  // חלק טיימר – ניהול שעון שאלה משותף
  function runTimer(startedAt, timeLimit) {
    const end = startedAt + timeLimit;
    clearInterval(state.timers.interval);
    const tick = () => {
      const remaining = Math.max(0, end - Math.floor(Date.now() / 1000));
      state.ui.timer.textContent = remaining.toString().padStart(2, '0');
      if (remaining <= 0) {
        clearInterval(state.timers.interval);
        disableAnswers();
      }
    };
    tick();
    state.timers.interval = setInterval(tick, 1000);
  }

  // חלק טיימר – ניקוי כל הטיימרים הקיימים
  function clearTimers() {
    clearInterval(state.timers.interval);
    clearTimeout(state.timers.question);
    state.timers.interval = null;
    state.timers.question = null;
  }

  // חלק לובי – רענון רשימות שחקנים מחוברים וממתינים
  function refreshLobby() {
    if (!state.ui.peers) return;
    const now = Math.floor(Date.now() / 1000);
    const peers = [];
    const waiting = [];
    for (const entry of state.players.values()) {
      if (entry.updatedAt + CFG.LOBBY_TTL < now) {
        state.players.delete(entry.pubkey);
        continue;
      }
      if (entry.seeking) waiting.push(entry);
      else peers.push(entry);
    }
    renderPlayerList(state.ui.peers, state.ui.peersEmpty, peers, false);
    renderPlayerList(state.ui.waiting, state.ui.waitingEmpty, waiting, true);
  }

  // חלק לובי – בניית רשימת שחקנים בדום
  function renderPlayerList(container, emptyLabel, list, joinable) {
    container.innerHTML = '';
    if (!list.length) {
      emptyLabel.hidden = false;
      return;
    }
    emptyLabel.hidden = true;
    list.forEach((player) => {
      const row = document.createElement('div');
      row.className = 'trivia-player';
      const info = document.createElement('div');
      info.className = 'trivia-player__info';
      const name = document.createElement('span');
      name.className = 'trivia-player__name';
      name.textContent = player.name || 'שחקן';
      const status = document.createElement('span');
      status.className = 'trivia-player__status';
      status.textContent = joinable ? 'ממתין לשותף' : 'זמין במשחק';
      info.appendChild(name);
      info.appendChild(status);
      row.appendChild(info);
      const btn = document.createElement('button');
      btn.className = 'trivia-player__action';
      btn.type = 'button';
      btn.textContent = joinable ? 'הצטרף' : 'פרטים';
      btn.disabled = !joinable;
      if (joinable) btn.addEventListener('click', () => joinWaiting(player.pubkey, player.room, player.name));
      row.appendChild(btn);
      container.appendChild(row);
    });
  }

  // חלק עזר – מחזיר מזהה חדר ייחודי
  function createRoomId() {
    return `trivia-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  }

  // חלק עזר – ערבוב השאלות למשחק חדש
  function shuffleQuestions() {
    const indices = QUESTIONS.map((_, idx) => idx);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices.slice(0, CFG.MAX_ROUNDS);
  }

  // חלק אירועים – טיפול באירועי סטטוס לובי
  function onStatusEvent(evt) {
    if (!shouldHandle(evt)) return;
    const sender = evt.pubkey?.toLowerCase?.();
    if (!sender || sender === App.publicKey?.toLowerCase?.()) return;
    try {
      const payload = JSON.parse(evt.content || '{}');
      const created = evt.created_at || Math.floor(Date.now() / 1000);
      if (!payload || created + CFG.LOBBY_TTL < Math.floor(Date.now() / 1000)) return;
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

  // חלק אירועים – טיפול באירועי משחק
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
    if (!payload) return;
    if (payload.room && state.roomId && payload.room !== state.roomId) return;
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
        if (!isSelf && state.opponentPubkey && sender === state.opponentPubkey) {
          enterMatch(state.roomId, sender, state.opponentName, false);
        }
        break;
      case 'question':
        if (!state.matchActive) {
          state.matchActive = true;
          state.ui.lobby.hidden = true;
          state.ui.match.hidden = false;
          state.ui.match.classList.add('is-active');
          state.ui.nameSelf.textContent = App.profile?.name || 'אתה';
          state.ui.nameOpp.textContent = state.opponentName;
        }
        renderQuestion(
          payload.questionIndex,
          payload.round || 0,
          payload.totalRounds || CFG.MAX_ROUNDS,
          payload.startedAt || Math.floor(Date.now() / 1000),
          payload.timeLimit || CFG.QUESTION_TIME
        );
        break;
      case 'answer':
        if (!isSelf && state.opponentPubkey === sender) {
          rememberAnswer(sender, state.round, Boolean(payload.correct));
          updateScores();
        }
        break;
      case 'final':
        state.ui.feedback.textContent = 'המשחק הסתיים! ניתן לפתוח משחק חדש.';
        state.ui.timer.textContent = '--';
        break;
      default:
        break;
    }
  }

  // חלק אירועים – מנגנון מניעת כפילויות
  function shouldHandle(evt) {
    if (!evt || !evt.id || state.processed.has(evt.id)) return false;
    state.processed.add(evt.id);
    return true;
  }

  // חלק רישום – הרשמה לאירועי Nostr תוך שימוש ב-SimplePool
  function subscribe() {
    if (!App.pool || !App.relayUrls) return;
    unsubscribe();
    const since = Math.floor(Date.now() / 1000) - CFG.LOBBY_TTL;
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
        if (state.ui.status) state.ui.status.textContent = 'הלובי מוכן. מצאו שותף והתחילו לשחק.';
        refreshLobby();
      }
    });
    state.subscriptions.unshift(subscription);
  }

  // חלק רישום – ביטול רישומים קיימים בריליים
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

  // חלק bootstrap – חיבור ל-notifyPoolReady כדי להבטיח שהמודול יאזין ל-pool
  function hookPoolReady() {
    const previous = App.notifyPoolReady;
    App.notifyPoolReady = function patchedNotify(pool) {
      if (typeof previous === 'function') {
        try { previous(pool); } catch (err) { console.warn('notifyPoolReady failed', err); }
      }
      if (pool) {
        App.pool = pool;
        subscribe();
        publishStatus('presence');
      }
    };
  }

  // חלק bootstrap – הפעלת המודול בהתאם למצב טעינת ה-DOM
  function bootstrap() {
    buildUI();
    hookPoolReady();
    if (App.pool) {
      subscribe();
      publishStatus('presence');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(window, document);
