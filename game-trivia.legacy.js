// חלק משחק טריוויה – יוצר משחק רשת מבוסס Nostr בין שני שחקנים
;(function initTriviaGame(window, document) {
  const App = window.NostrApp || (window.NostrApp = {});

  // קבועים של המשחק – מזהי אירועים וטאגים ברשת Nostr
  const TRIVIA_TAG = 'sos_trivia_v1';
  const KIND_STATUS = 33051;
  const KIND_MATCH = 33052;
  const QUESTION_TIME_SEC = 18;
  const MAX_ROUNDS = 10;
  const LOBBY_EVENT_TTL = 120; // שניות שמידע בלובי נשמר

  // בנק שאלות בסיסי – 10 שאלות פשוטות בעברית
  const QUESTIONS = [
    { id: 'math-add-5', question: 'כמה זה 7 + 5?', options: ['10', '11', '12', '13'], answer: 2 },
    { id: 'math-sub-4', question: 'כמה זה 9 - 4?', options: ['3', '4', '5', '6'], answer: 2 },
    { id: 'geo-capital', question: 'מהי בירת ישראל?', options: ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'], answer: 1 },
    { id: 'sci-water', question: 'איזו נוסחה כימית מתארת מים?', options: ['CO2', 'H2O', 'O2', 'NaCl'], answer: 1 },
    { id: 'history-year', question: 'באיזו שנה הוכרזה מדינת ישראל?', options: ['1946', '1948', '1950', '1952'], answer: 1 },
    { id: 'lang-syn', question: 'מהי המילה הנרדפת ל"מהיר"?', options: ['זריז', 'כבד', 'עמוס', 'רחב'], answer: 0 },
    { id: 'math-mult', question: 'כמה זה 6 × 3?', options: ['12', '15', '18', '20'], answer: 2 },
    { id: 'animals', question: 'איזה בעל חיים נחשב ליונק?', options: ['תנין', 'כריש', 'דולפין', 'צפרדע'], answer: 2 },
    { id: 'tech-invent', question: 'מי המציא את הנורה החשמלית?', options: ['אדיסון', 'ניוטון', 'בל', 'מרקוני'], answer: 0 },
    { id: 'math-div', question: 'כמה זה 21 ÷ 3?', options: ['6', '7', '8', '9'], answer: 1 }
  ];

  // ממשק משתמש ומצבי משחק – מאוחסן באובייקט יחיד
  const state = {
    ui: {
      fab: null,
      modal: null,
      status: null,
      peersList: null,
      peersEmpty: null,
      waitingList: null,
      waitingEmpty: null,
      seekBtn: null,
      cancelBtn: null,
      closeBtn: null,
      matchSection: null,
      lobbySection: null,
      answersWrap: null,
      questionBox: null,
      feedback: null,
      timer: null,
      scoreSelf: null,
      scoreOpponent: null,
      nameSelf: null,
      nameOpponent: null,
      leaveBtn: null
    },
    seeking: false,
    roomId: null,
    opponentPubkey: null,
    opponentName: 'יריב',
    isHost: false,
    matchActive: false,
    round: 0,
    questionOrder: [],
    answersByPlayer: new Map(),
    timerInterval: null,
    questionTimeout: null,
    processedEvents: new Set(),
    lobbyPlayers: new Map(),
    subscriptions: [],
    presenceInterval: null
  };

  // פונקציית עזר – ייבוא stylesheet פעם אחת בלבד
  function ensureStylesheet() {
    if (document.getElementById('triviaStylesheet')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = 'triviaStylesheet';
    link.href = './styles/game-trivia.css';
    document.head.appendChild(link);
  }

  // פונקציית עזר – יוצר HTML לכפתור ולמודאל המשחק
  function buildUI() {
    if (state.ui.fab) return;

    const fab = document.createElement('button');
    fab.className = 'trivia-fab';
    fab.id = 'triviaFabButton';
    fab.type = 'button';
    fab.title = 'שחקו יחד בטריוויה';
    fab.innerText = '🎲';

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
            <h3>שחקנים שמחפשים שותף</h3>
            <div class="trivia-lobby__list" id="triviaWaiting"></div>
            <p class="trivia-controls__note" id="triviaWaitingEmpty">אף אחד עדיין לא ממתין למשחק.</p>
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

    state.ui.fab = fab;
    state.ui.modal = modal;
    state.ui.status = modal.querySelector('#triviaStatus');
    state.ui.peersList = modal.querySelector('#triviaPeers');
    state.ui.peersEmpty = modal.querySelector('#triviaPeersEmpty');
    state.ui.waitingList = modal.querySelector('#triviaWaiting');
    state.ui.waitingEmpty = modal.querySelector('#triviaWaitingEmpty');
    state.ui.seekBtn = modal.querySelector('#triviaSeek');
    state.ui.cancelBtn = modal.querySelector('#triviaCancel');
    state.ui.closeBtn = modal.querySelector('#triviaClose');
    state.ui.matchSection = modal.querySelector('#triviaMatch');
    state.ui.lobbySection = modal.querySelector('#triviaLobby');
    state.ui.answersWrap = modal.querySelector('#triviaAnswers');
    state.ui.questionBox = modal.querySelector('#triviaQuestion');
    state.ui.feedback = modal.querySelector('#triviaFeedback');
    state.ui.timer = modal.querySelector('#triviaTimer');
    state.ui.scoreSelf = modal.querySelector('#triviaScoreSelf [data-role="value"]');
    state.ui.scoreOpponent = modal.querySelector('#triviaScoreOpponent [data-role="value"]');
    state.ui.nameSelf = modal.querySelector('#triviaScoreSelf [data-role="name"]');
    state.ui.nameOpponent = modal.querySelector('#triviaScoreOpponent [data-role="name"]');
    state.ui.leaveBtn = modal.querySelector('#triviaLeave');

    fab.addEventListener('click', openModal);
    state.ui.closeBtn.addEventListener('click', closeModal);
    state.ui.seekBtn.addEventListener('click', startSeekingPartner);
    state.ui.cancelBtn.addEventListener('click', cancelSeekingPartner);
    state.ui.leaveBtn.addEventListener('click', leaveMatchToLobby);
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) closeModal();
    });
  }

  // פונקציה לפתיחת החלון והפעלת נוכחות בלובי
  function openModal() {
    if (!state.ui.modal) return;
    state.ui.modal.classList.add('is-open');
    state.ui.modal.setAttribute('aria-hidden', 'false');
    state.ui.status.textContent = 'מתחבר ללובי...';
    updateLobbyViews();
    ensurePresenceLoop();
    publishStatus('presence');
  }

  // פונקציה לסגירה, כולל הפסקת חיפוש אם יש
  function closeModal() {
    if (!state.ui.modal) return;
    state.ui.modal.classList.remove('is-open');
    state.ui.modal.setAttribute('aria-hidden', 'true');
    if (state.seeking) cancelSeekingPartner();
  }

  // הפעלת לולאת נוכחות – מוודאת שליחת אירוע כל חצי דקה
  function ensurePresenceLoop() {
    if (state.presenceInterval) return;
    state.presenceInterval = setInterval(() => publishStatus('presence'), 30000);
  }

  // פרסום סטטוס לריליי Nostr
  function publishStatus(type, extra = {}) {
    if (!App.pool || typeof App.finalizeEvent !== 'function') return;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      type,
      name: App.profile?.name || 'משתמש',
      seeking: state.seeking,
      room: state.roomId || null,
      timestamp: now,
      ...extra
    };
    const event = App.finalizeEvent(
      {
        kind: KIND_STATUS,
        created_at: now,
        tags: [['t', TRIVIA_TAG]],
        content: JSON.stringify(payload)
      },
      App.privateKey
    );
    App.pool.publish(App.relayUrls, event).catch((err) => console.warn('trivia status publish failed', err));
  }

  // פרסום אירוע משחק (התאמה, שאלה, תשובה)
  function publishMatch(type, extra = {}) {
    if (!App.pool || typeof App.finalizeEvent !== 'function') return;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      type,
      room: state.roomId,
      round: state.round,
      ...extra
    };
    const event = App.finalizeEvent(
      {
        kind: KIND_MATCH,
        created_at: now,
        tags: [['t', TRIVIA_TAG], ['room', state.roomId]],
        content: JSON.stringify(payload)
      },
      App.privateKey
    );
    App.pool.publish(App.relayUrls, event).catch((err) => console.warn('trivia match publish failed', err));
  }

  // התחלת חיפוש שותף
  function startSeekingPartner() {
    if (state.seeking || !App.publicKey) return;
    state.seeking = true;
    state.roomId = generateRoomId();
    state.isHost = true;
    state.ui.seekBtn.textContent = 'מחפש... נא להמתין';
    state.ui.seekBtn.disabled = true;
    state.ui.cancelBtn.hidden = false;
    publishStatus('seek');
    updateLobbyViews();
  }

  // ביטול חיפוש – מחזיר לסטטוס רגיל
  function cancelSeekingPartner() {
    state.seeking = false;
    state.isHost = false;
    state.roomId = null;
    state.ui.seekBtn.textContent = 'חפש שותף';
    state.ui.seekBtn.disabled = false;
    state.ui.cancelBtn.hidden = true;
    publishStatus('idle');
    updateLobbyViews();
  }

  // הצטרפות למשחק קיים מתוך רשימת ממתינים
  function joinWaitingPlayer(targetPubkey, roomId, targetName) {
    if (!App.publicKey || !roomId || !targetPubkey) return;
    state.seeking = false;
    state.isHost = false;
    state.roomId = roomId;
    state.opponentPubkey = targetPubkey;
    state.opponentName = targetName || 'יריב';
    state.ui.seekBtn.textContent = 'חפש שותף';
    state.ui.seekBtn.disabled = false;
    state.ui.cancelBtn.hidden = true;
    publishMatch('invite', { target: targetPubkey });
    state.ui.status.textContent = 'שלחנו הזמנה לשחקן. ממתינים לאישור...';
  }

  // התחלת משחק בפועל לאחר שהצד השני אישר
  function enterMatch(roomId, opponentPubkey, opponentName, asHost) {
    state.matchActive = true;
    state.roomId = roomId;
    state.opponentPubkey = opponentPubkey;
    state.opponentName = opponentName || 'יריב';
    state.isHost = asHost;
    state.round = 0;
    state.questionOrder = buildQuestionOrder();
    state.answersByPlayer.clear();
    updateScoreboard();

    state.ui.lobbySection.hidden = true;
    state.ui.matchSection.hidden = false;
    state.ui.matchSection.classList.add('is-active');
    state.ui.nameSelf.textContent = App.profile?.name || 'אתה';
    state.ui.nameOpponent.textContent = state.opponentName;
    state.ui.feedback.textContent = '';

    if (state.isHost) {
      publishStatus('match');
      sendQuestion(0);
    } else {
      publishStatus('playing');
      state.ui.status.textContent = 'מחכים לשאלה הראשונה...';
    }
  }

  // חזרה מהמשחק ללובי
  function leaveMatchToLobby() {
    clearQuestionTimers();
    state.matchActive = false;
    state.roomId = null;
    state.opponentPubkey = null;
    state.round = 0;
    state.ui.matchSection.classList.remove('is-active');
    state.ui.matchSection.hidden = true;
    state.ui.lobbySection.hidden = false;
    state.ui.questionBox.textContent = 'המשחק יתחיל עם הצטרפות שני שחקנים.';
    state.ui.answersWrap.innerHTML = '';
    state.ui.feedback.textContent = '';
    state.ui.timer.textContent = '--';
    publishStatus('idle');
    updateLobbyViews();
  }

  // בניית סדר שאלות אקראי מתוך הבנק
  function buildQuestionOrder() {
    const indices = QUESTIONS.map((_, idx) => idx);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const swapIdx = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[swapIdx]] = [indices[swapIdx], indices[i]];
    }
    return indices.slice(0, MAX_ROUNDS);
  }

  // שליחת שאלה חדשה מהצד המארח
  function sendQuestion(roundIndex) {
    if (!state.isHost || !state.matchActive) return;
    if (roundIndex >= state.questionOrder.length) {
      finishMatch();
      return;
    }
    state.round = roundIndex;
    const questionIndex = state.questionOrder[roundIndex];
    publishMatch('question', {
      questionIndex,
      totalRounds: state.questionOrder.length,
      startedAt: Math.floor(Date.now() / 1000),
      timeLimit: QUESTION_TIME_SEC
    });
    scheduleNextQuestion();
  }

  // תזמון השאלה הבאה – אחרי הזמן שהוקצב
  function scheduleNextQuestion() {
    clearQuestionTimers();
    if (!state.isHost) return;
    state.questionTimeout = setTimeout(() => {
      sendQuestion(state.round + 1);
    }, QUESTION_TIME_SEC * 1000 + 500);
  }

  // ניקוי טיימרים
  function clearQuestionTimers() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    if (state.questionTimeout) {
      clearTimeout(state.questionTimeout);
      state.questionTimeout = null;
    }
  }

  // הצגת שאלה באינטרפייס המקומי
  function renderQuestion(questionIndex, round, totalRounds, startedAt, timeLimit) {
    const data = QUESTIONS[questionIndex];
    if (!data) return;
    state.round = round;
    state.ui.questionBox.textContent = `${round + 1}/${totalRounds} • ${data.question}`;
    state.ui.answersWrap.innerHTML = '';
    state.ui.feedback.textContent = '';

    data.options.forEach((text, optionIdx) => {
      const btn = document.createElement('button');
      btn.className = 'trivia-answer';
      btn.type = 'button';
      btn.textContent = text;
      btn.dataset.option = String(optionIdx);
      btn.addEventListener('click', () => submitAnswer(optionIdx, data.answer));
      state.ui.answersWrap.appendChild(btn);
    });

    runQuestionTimer(startedAt, timeLimit);
  }

  // הפעלת טיימר שאלה משותף לשני השחקנים
  function runQuestionTimer(startedAt, timeLimit) {
    const deadline = startedAt + timeLimit;
    const updateTimer = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, deadline - now);
      state.ui.timer.textContent = remaining.toString().padStart(2, '0');
      if (remaining <= 0) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
        disableAnswers();
      }
    };
    updateTimer();
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateTimer, 1000);
  }

  // שליחת תשובה
  function submitAnswer(optionIdx, correctIdx) {
    if (!state.matchActive || !state.roomId) return;
    disableAnswers();
    const chosenBtn = state.ui.answersWrap.querySelector(`[data-option="${optionIdx}"]`);
    if (chosenBtn) {
      chosenBtn.classList.add(optionIdx === correctIdx ? 'is-correct' : 'is-wrong');
    }
    highlightCorrectAnswer(correctIdx);
    const isCorrect = optionIdx === correctIdx;
    recordAnswer(App.publicKey, state.round, isCorrect);
    publishMatch('answer', { option: optionIdx, correct: isCorrect });
    state.ui.feedback.textContent = isCorrect ? 'כל הכבוד! תשובה נכונה.' : 'ננסה יותר טוב בשאלה הבאה.';
    updateScoreboard();
  }

  // סימון תשובה נכונה על המסך
  function highlightCorrectAnswer(correctIdx) {
    const correctButton = state.ui.answersWrap.querySelector(`[data-option="${correctIdx}"]`);
    if (correctButton) correctButton.classList.add('is-correct');
  }

  // נטרול כפתורים לאחר בחירת תשובה
  function disableAnswers() {
    state.ui.answersWrap.querySelectorAll('.trivia-answer').forEach((btn) => {
      btn.disabled = true;
    });
  }

  // שמירת תשובה בטבלת הניקוד
  function recordAnswer(pubkey, round, isCorrect) {
    if (!pubkey) return;
    const current = state.answersByPlayer.get(pubkey) || { score: 0, answers: {} };
    current.answers[round] = isCorrect;
    current.score = Object.values(current.answers).filter(Boolean).length;
    state.answersByPlayer.set(pubkey, current);
  }

  // עדכון תצוגת הניקוד
  function updateScoreboard() {
    const self = state.answersByPlayer.get(App.publicKey) || { score: 0 };
    const opponent = state.answersByPlayer.get(state.opponentPubkey) || { score: 0 };
    state.ui.scoreSelf.textContent = String(self.score || 0);
    state.ui.scoreOpponent.textContent = String(opponent.score || 0);
  }

  // סיום המשחק לאחר כל הסבבים
  function finishMatch() {
    clearQuestionTimers();
    publishMatch('final');
    state.ui.feedback.textContent = 'המשחק הסתיים! אפשר לחזור ללובי או להפעיל משחק חדש.';
    state.ui.timer.textContent = '--';
    state.isHost = false;
  }

  // האזנה לאירועי סטטוס מהלובי
  function handleStatusEvent(event) {
    if (!validateEvent(event)) return;
    const sender = event.pubkey?.toLowerCase?.();
    if (!sender || sender === App.publicKey?.toLowerCase?.()) return;

    try {
      const payload = JSON.parse(event.content || '{}');
      if (!payload || typeof payload !== 'object') return;
      const createdAt = event.created_at || Math.floor(Date.now() / 1000);
      if (createdAt + LOBBY_EVENT_TTL < Math.floor(Date.now() / 1000)) return;

      state.lobbyPlayers.set(sender, {
        pubkey: sender,
        name: payload.name || 'שחקן',
        seeking: Boolean(payload.seeking),
        room: payload.room || null,
        updatedAt: createdAt
      });
      updateLobbyViews();
    } catch (err) {
      console.warn('trivia status parse failed', err);
    }
  }

  // האזנה לאירועי משחק
  function handleMatchEvent(event) {
    if (!validateEvent(event)) return;
    const sender = event.pubkey?.toLowerCase?.();
    const isSelf = sender === App.publicKey?.toLowerCase?.();

    let payload;
    try {
      payload = JSON.parse(event.content || '{}');
    } catch (err) {
      console.warn('trivia match parse failed', err);
      return;
    }
    if (!payload || payload.room && state.roomId && payload.room !== state.roomId) return;

    switch (payload.type) {
      case 'invite':
        if (!isSelf && payload.target?.toLowerCase?.() === App.publicKey?.toLowerCase?.() && state.seeking) {
          state.opponentPubkey = sender;
          state.opponentName = resolvePlayerName(sender);
          publishMatch('accept', { opponent: sender });
          enterMatch(state.roomId, sender, state.opponentName, true);
        }
        break;
      case 'accept':
        if (isSelf) break;
        if (state.opponentPubkey && sender === state.opponentPubkey) {
          enterMatch(state.roomId, sender, state.opponentName, false);
        }
        break;
      case 'question':
        if (!state.matchActive && state.opponentPubkey && sender !== App.publicKey?.toLowerCase?.()) {
          // מבטיחים שהמשחק התחיל אצל האורח
          state.matchActive = true;
          state.ui.lobbySection.hidden = true;
          state.ui.matchSection.hidden = false;
          state.ui.matchSection.classList.add('is-active');
        }
        renderQuestion(payload.questionIndex, payload.round || 0, payload.totalRounds || MAX_ROUNDS, payload.startedAt || Math.floor(Date.now() / 1000), payload.timeLimit || QUESTION_TIME_SEC);
        break;
      case 'answer':
        if (!isSelf && state.opponentPubkey === sender) {
          recordAnswer(sender, state.round, Boolean(payload.correct));
          updateScoreboard();
        }
        break;
      case 'final':
        state.ui.feedback.textContent = 'המשחק הסתיים! אפשר לחזור ללובי או להתחיל סשן חדש.';
        break;
      default:
        break;
    }
  }

  // ווידוא שאירוע לא טופל בעבר ושייך למשחק
  function validateEvent(event) {
    if (!event || !event.id || state.processedEvents.has(event.id)) return false;
    state.processedEvents.add(event.id);
    return true;
  }

  // חידוש רשימות הלובי על בסיס המפה
  function updateLobbyViews() {
    const now = Math.floor(Date.now() / 1000);
    const peers = [];
    const waiting = [];
    for (const entry of state.lobbyPlayers.values()) {
      if (entry.updatedAt + LOBBY_EVENT_TTL < now) {
        state.lobbyPlayers.delete(entry.pubkey);
        continue;
      }
      if (entry.seeking) waiting.push(entry);
      else peers.push(entry);
    }

    renderPlayerList(state.ui.peersList, state.ui.peersEmpty, peers, false);
    renderPlayerList(state.ui.waitingList, state.ui.waitingEmpty, waiting, true);
  }

  // ציור רשימת השחקנים בדום
  function renderPlayerList(container, emptyLabel, players, enableJoin) {
    container.innerHTML = '';
    if (!players.length) {
      emptyLabel.hidden = false;
      return;
    }
    emptyLabel.hidden = true;
    players.forEach((player) => {
      const row = document.createElement('div');
      row.className = 'trivia-player';
      const info = document.createElement('div');
      info.className = 'trivia-player__info';
      const nameEl = document.createElement('span');
      nameEl.className = 'trivia-player__name';
      nameEl.textContent = player.name || 'שחקן';
      const statusEl = document.createElement('span');
      statusEl.className = 'trivia-player__status';
      statusEl.textContent = enableJoin ? 'ממתין לשותף' : 'זמין למשחק';
      info.appendChild(nameEl);
      info.appendChild(statusEl);
      row.appendChild(info);

      const actionBtn = document.createElement('button');
      actionBtn.className = 'trivia-player__action';
      actionBtn.type = 'button';
      actionBtn.textContent = enableJoin ? 'הצטרף' : 'הזן פרטים';
      actionBtn.disabled = !enableJoin;
      if (enableJoin) {
        actionBtn.addEventListener('click', () => joinWaitingPlayer(player.pubkey, player.room, player.name));
      }
      row.appendChild(actionBtn);
      container.appendChild(row);
    });
  }

  // השגת שם שחקן מתוך הלובי במקרה של הזמנה
  function resolvePlayerName(pubkey) {
    const entry = state.lobbyPlayers.get(pubkey);
    return entry?.name || 'שחקן';
  }

  // יצירת מזהה חדר אקראי
  function generateRoomId() {
    return `trivia-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  // הרשמה לאירועים מהריליים
  function subscribeToEvents() {
    if (!App.pool || !App.relayUrls) return;
    unsubscribeAll();
    const since = Math.floor(Date.now() / 1000) - LOBBY_EVENT_TTL;
    const filters = [
      { kinds: [KIND_STATUS], '#t': [TRIVIA_TAG], since },
      { kinds: [KIND_MATCH], '#t': [TRIVIA_TAG], since }
    ];
    const sub = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        if (event.kind === KIND_STATUS) handleStatusEvent(event);
        else if (event.kind === KIND_MATCH) handleMatchEvent(event);
      },
      oneose: () => {
        state.ui.status.textContent = 'הלובי מעודכן. ניתן לבחור יריב או לחפש שותף.';
        updateLobbyViews();
      }
    });
    state.subscriptions.push(sub);
  }

  // ביטול רישומים קיימים
  function unsubscribeAll() {
    if (!state.subscriptions.length) return;
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

  // קשירת notifyPoolReady כדי להבטיח טעינה לאחר שה־pool קיים
  function hookPoolReady() {
    const previousNotify = App.notifyPoolReady;
    App.notifyPoolReady = function triviaNotify(pool) {
      if (typeof previousNotify === 'function') {
        try {
          previousNotify(pool);
        } catch (err) {
          console.warn('trivia previous notify failed', err);
        }
      }
      if (pool) {
        App.pool = pool;
        subscribeToEvents();
        publishStatus('presence');
      }
    };
  }

  // אתחול ראשוני – נטען כש־DOM מוכן
  function bootstrap() {
    ensureStylesheet();
    buildUI();
    hookPoolReady();
    if (App.pool) {
      subscribeToEvents();
      publishStatus('presence');
    }
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})(window, document);
