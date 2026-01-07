// חלק לוח גידול (market-dashboard.js) – אחראי על פתיחה, סגירה וטעינת נתוני גידול מהרשת המקומית
(function initMarketDashboard(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const CALL_METRIC_KIND = App.CALL_METRIC_KIND || 25060; // חלק מדדי שיחה (market-dashboard.js) – kind עבור אירועי משך שיחות | HYPER CORE TECH
  const CORE_METRIC_KINDS = {
    profile: 0,
    post: 1,
    repost: 6,
    reaction: 7,
    login: 1050,
    videoCall: 1051,
    voiceCall: 1052,
    gameOpen: 1053,
    callMetric: CALL_METRIC_KIND,
  }; // חלק מדדי רשת (market-dashboard.js) – מגדיר קינד נדרש לכל פרמטר מדיד שנשלף מהריליי | HYPER CORE TECH
  const MIN_GROWTH_DATE = '2025-09-25';
  const MIN_GROWTH_TIMESTAMP = Math.floor(Date.parse(`${MIN_GROWTH_DATE}T00:00:00Z`) / 1000);
  const GROWTH_FETCH_LIMIT = 20000;
  let metricKindCoverageLogged = false;

  // חלק לוח גידול (market-dashboard.js) – פונקציות אלו הוסרו כי האתר לא משתמש בשירות מקומי אלא קורא ישירות מהריליים | HYPER CORE TECH

  function ensureMetricKindCoverage(filter) {
    // חלק מדדי רשת (market-dashboard.js) – מוסיף למסנן כל kind נדרש ומתריע במקרה של השלמות | HYPER CORE TECH
    if (filter && filter._skipMetricEnsure) {
      delete filter._skipMetricEnsure;
      return filter;
    }
    if (!filter || !Array.isArray(filter.kinds)) {
      return filter;
    }
    const requiredKinds = Object.values(CORE_METRIC_KINDS);
    const addedKinds = [];
    requiredKinds.forEach((kind) => {
      if (!filter.kinds.includes(kind)) {
        filter.kinds.push(kind);
        addedKinds.push(kind);
      }
    });
    filter.kinds = Array.from(new Set(filter.kinds));
    if (addedKinds.length && !metricKindCoverageLogged) {
      console.info('המסנן עודכן עם kind חסר למדדים המצטברים', addedKinds);
      metricKindCoverageLogged = true;
    }
    return filter;
  }

  function buildGrowthFilters() {
    // חלק לוח גידול (market-dashboard.js) – מיישר את מסנני השאילתה מול הפיד הראשי כדי למנוע פערי ספירת פוסטים | HYPER CORE TECH
    const filters = [];
    const networkTag = typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG ? App.NETWORK_TAG : null;

    const postsFilter = {
      kinds: [1],
      limit: GROWTH_FETCH_LIMIT,
      since: MIN_GROWTH_TIMESTAMP,
    };
    if (networkTag) {
      postsFilter['#t'] = [networkTag];
    }
    filters.push(ensureMetricKindCoverage(postsFilter));

    if (typeof App.publicKey === 'string' && App.publicKey) {
      filters.push({
        kinds: [1],
        authors: [App.publicKey],
        limit: Math.max(2000, GROWTH_FETCH_LIMIT / 2),
        since: MIN_GROWTH_TIMESTAMP,
        _skipMetricEnsure: true,
      });
    }

    const deletionAuthors = new Set();
    if (typeof App.publicKey === 'string' && App.publicKey) {
      deletionAuthors.add(App.publicKey.toLowerCase());
    }
    if (App.adminPublicKeys instanceof Set) {
      App.adminPublicKeys.forEach((key) => {
        if (typeof key === 'string' && key) {
          deletionAuthors.add(key.toLowerCase());
        }
      });
    }
    if (deletionAuthors.size) {
      filters.push({
        kinds: [5],
        authors: Array.from(deletionAuthors),
        limit: Math.max(2000, GROWTH_FETCH_LIMIT / 2),
        since: MIN_GROWTH_TIMESTAMP,
        _skipMetricEnsure: true,
      });
    } else {
      const deletionFilter = {
        kinds: [5],
        limit: Math.max(2000, GROWTH_FETCH_LIMIT / 2),
        since: MIN_GROWTH_TIMESTAMP,
        _skipMetricEnsure: true,
      };
      if (networkTag) {
        deletionFilter['#t'] = [networkTag];
      }
      filters.push(deletionFilter);
    }

    const reactionsFilter = {
      kinds: [6, 7],
      limit: GROWTH_FETCH_LIMIT,
      since: MIN_GROWTH_TIMESTAMP,
    };
    if (networkTag) {
      reactionsFilter['#t'] = [networkTag];
    }
    filters.push(reactionsFilter);

    const loginFilter = {
      kinds: [1050],
      limit: GROWTH_FETCH_LIMIT,
      since: MIN_GROWTH_TIMESTAMP,
      _skipMetricEnsure: true,
    };
    if (networkTag) {
      loginFilter['#t'] = [networkTag, 'login'];
    } else {
      loginFilter['#t'] = ['login'];
    }
    filters.push(loginFilter);

    const metricKindsFilter = {
      kinds: [CALL_METRIC_KIND, 1051, 1052, 1053],
      limit: GROWTH_FETCH_LIMIT,
      since: MIN_GROWTH_TIMESTAMP,
    };
    if (networkTag) {
      metricKindsFilter['#t'] = [networkTag];
    }
    filters.push(metricKindsFilter);

    const metadataFilter = {
      kinds: [0],
      limit: Math.max(2000, GROWTH_FETCH_LIMIT / 2),
      since: MIN_GROWTH_TIMESTAMP,
    };
    if (networkTag) {
      metadataFilter['#t'] = [networkTag];
    }
    filters.push(metadataFilter);

    return filters.map((filter) => ensureMetricKindCoverage(filter));
  }

  const growthSelectors = {
    root: document.getElementById('growthDashboard'),
    backdrop: document.querySelector('#growthDashboard .growth-dashboard__backdrop'),
    tabs: Array.from(document.querySelectorAll('#growthDashboard .growth-dashboard__tab')),
    panes: Array.from(document.querySelectorAll('#growthDashboard .growth-dashboard__section')),
    metrics: document.getElementById('growthMetrics'),
    activity: document.getElementById('growthActivity'),
    leaders: document.getElementById('growthLeaders'),
    status: document.getElementById('growthStatus'),
    autoRefresh: document.getElementById('growthAutoRefresh'),
    refreshButton: document.querySelector('#growthDashboard .growth-dashboard__refresh'),
    chartCanvas: document.getElementById('growthChart'),
    panel: document.querySelector('#growthDashboard .growth-dashboard__panel'),
    rangesContainer: document.querySelector('#growthChartContainer .growth-chart__ranges'),
  };

  growthSelectors.rangeButtons = Array.from(
    (growthSelectors.rangesContainer || document).querySelectorAll?.('.growth-chart__range-button') || []
  );

  const growthState = {
    chart: null,
    autoInterval: null,
    lastStats: null,
    isLoading: false,
    timelineRange: '1m',
    filteredTimeline: [],
  };
  const growthListeners = new Set();

  // חלק דיאגנוסטיקה (market-dashboard.js) – בודק אילו אירועים קשורים לשיחות קיימים ומה הנתונים הנלווים | HYPER CORE TECH
  function analyzeCallEventsDiagnostics(events) {
    if (!Array.isArray(events) || !events.length) {
      return null;
    }

    const diagnostics = {
      kindCounts: {},
      tagMatches: {
        't:video-call': 0,
        't:voice-call': 0,
        durationTags: 0,
      },
      durationHints: [],
    };

    events.forEach((event) => {
      const kindKey = typeof event?.kind === 'number' ? event.kind : 'unknown';
      diagnostics.kindCounts[kindKey] = (diagnostics.kindCounts[kindKey] || 0) + 1;

      if (Array.isArray(event?.tags)) {
        event.tags.forEach((tag) => {
          if (!Array.isArray(tag)) {
            return;
          }
          const [type, value] = tag;
          if (type === 't' && value === 'video-call') {
            diagnostics.tagMatches['t:video-call'] += 1;
          }
          if (type === 't' && value === 'voice-call') {
            diagnostics.tagMatches['t:voice-call'] += 1;
          }
          if (typeof type === 'string' && type.toLowerCase() === 'duration') {
            diagnostics.tagMatches.durationTags += 1;
            diagnostics.durationHints.push({
              source: 'tag',
              value,
              kind: event.kind,
              id: event.id,
            });
          }
        });
      }

      if (typeof event?.content === 'string' && /duration/i.test(event.content)) {
        const matches = event.content.match(/duration\s*[:=\-]?\s*(\d+(?:\.\d+)?)/i);
        diagnostics.durationHints.push({
          source: 'content',
          value: matches ? matches[1] : event.content.slice(0, 120),
          kind: event.kind,
          id: event.id,
        });
      }
    });

    return diagnostics;
  }

  // חלק לוח גידול (market-dashboard.js) – כלי עזר לעיצוב מספרים בעברית
  function formatNumber(value) {
    const number = Number(value) || 0;
    return number.toLocaleString('he-IL');
  }

  // חלק לוח גידול (market-dashboard.js) – מחשב שינוי יומי להדגשת מגמה
  function computeDailyDelta(series, key) {
    if (!Array.isArray(series) || series.length === 0) {
      return { value: 0, trend: 'neutral' };
    }
    const today = series[series.length - 1]?.[key] || 0;
    const yesterday = series[series.length - 2]?.[key] || 0;
    const diff = today - yesterday;
    const trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral';
    return { value: diff, trend };
  }

  // חלק לוח גידול (market-dashboard.js) – מחשב מגמת אחוזים בין שתי נקודות
  function computePercentChange(current, previous) {
    if (!previous) {
      return 0;
    }
    return ((current - previous) / previous) * 100;
  }

  // חלק לוח גידול (market-dashboard.js) – בונה את כרטיסי המדדים בלשונית סקירה
  function renderMetrics(stats) {
    if (!growthSelectors.metrics) {
      return;
    }
    const timeline = stats.timeline || [];
    const postsDelta = computeDailyDelta(timeline.map((item) => ({ posts: item.kinds?.[1] || 0 })), 'posts');
    const repliesDelta = computeDailyDelta(timeline.map((item) => ({ replies: item.replies || 0 })), 'replies');
    const likesDelta = computeDailyDelta(timeline.map((item) => ({ likes: item.kinds?.[7] || 0 })), 'likes');
    const loginsDelta = computeDailyDelta(timeline.map((item) => ({ logins: item.logins || 0 })), 'logins');
    const activeDelta = computeDailyDelta(
      timeline.map((item) => ({ users: item.participantsCount || (Array.isArray(item.participants) ? item.participants.length : 0) })),
      'users'
    );
    const totalDelta = computeDailyDelta(timeline, 'total');
    const todaysBucket = timeline[timeline.length - 1] || {};
    const todaysActiveUsers = Number(stats.dailyActiveUsers) || todaysBucket.participantsCount || 0;
    const todaysLogins = todaysBucket.logins || 0;
    const todaysPosts = todaysBucket.posts || 0;
    const uniqueLogins = stats.uniqueLoginsCount || 0;

    const cards = [
      {
        label: 'שווי רשת משוער',
        value: stats.totalEvents || 0,
        trend: totalDelta.trend,
        trendLabel: `${totalDelta.value > 0 ? '+' : ''}${formatNumber(totalDelta.value)} אירועים מאתמול`,
      },
      {
        label: 'משתמשים פעילים במערכת',
        value: stats.uniquePubkeys || 0,
        trend: activeDelta.trend,
        trendLabel: `${formatNumber(todaysActiveUsers)} משתמשים היום`,
      },
      {
        label: 'פוסטים מצטברים',
        value: stats.postsCount || stats.posts || 0,
        trend: postsDelta.trend,
        trendLabel: `${formatNumber(todaysPosts)} פוסטים היום`,
      },
      {
        label: 'מחזור תגובות',
        value: stats.repliesCount || 0,
        trend: repliesDelta.trend,
        trendLabel: `${formatNumber(stats.repliesToday || 0)} תגובות היום`,
      },
      {
        label: 'תנועת לייקים נטו',
        value: stats.likesCount || 0,
        trend: likesDelta.trend,
        trendLabel: `${likesDelta.value > 0 ? '+' : ''}${formatNumber(likesDelta.value)} מאתמול`,
      },
      {
        label: 'סך כניסות (לא ייחודיות)',
        value: stats.loginsCount || stats.logins || 0,
        trend: loginsDelta.trend,
        trendLabel: `${formatNumber(todaysLogins)} כניסות היום`,
      },
      {
        label: 'כניסות ייחודיות',
        value: uniqueLogins,
        trend: activeDelta.trend,
        trendLabel: `${formatNumber(uniqueLogins)} משתמשים שונים`,
      },
    ];

    const metricsHtml = cards
      .map((card) => {
        return `
          <article class="growth-metric">
            <span class="growth-metric__label">${card.label}</span>
            <span class="growth-metric__value">${formatNumber(card.value)}</span>
            <span class="growth-metric__trend" data-trend="${card.trend}">
              <i class="fa-solid ${card.trend === 'down' ? 'fa-arrow-trend-down' : card.trend === 'up' ? 'fa-arrow-trend-up' : 'fa-minus'}"></i>
              ${card.trendLabel}
            </span>
          </article>
        `;
      })
      .join('');

    growthSelectors.metrics.innerHTML = metricsHtml;
  }

  // חלק לוח גידול (market-dashboard.js) – מעדכן את טבלת הפעילות בזמן אמת
  function renderActivity(stats, relays) {
    if (!growthSelectors.activity) {
      return;
    }
    const timeline = stats.timeline || [];
    const today = timeline[timeline.length - 1] || { total: 0, kinds: {}, replies: 0 };
    const yesterday = timeline[timeline.length - 2] || { total: 0, kinds: {}, replies: 0 };
    const totalChange = computePercentChange(today.total || 0, yesterday.total || 0);
    const replyChange = computePercentChange(today.replies || 0, yesterday.replies || 0);

    const prominentRelays = (relays || [])
      .slice()
      .sort((a, b) => (b.total || 0) - (a.total || 0))
      .slice(0, 3)
      .map((relay) => `
        <div class="growth-activity__item">
          <span class="growth-activity__label">${relay.relayUrl}</span>
          <span class="growth-activity__value">${formatNumber(relay.total || 0)} אירועים</span>
        </div>
      `)
      .join('');

    const activityHtml = `
      <div class="growth-activity__item">
        <span class="growth-activity__label">קצב פעילות יומי</span>
        <span class="growth-activity__value">${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(1)}%</span>
      </div>
      <div class="growth-activity__item">
        <span class="growth-activity__label">שיעור תגובות היום</span>
        <span class="growth-activity__value">${replyChange >= 0 ? '+' : ''}${replyChange.toFixed(1)}%</span>
      </div>
      <div class="growth-activity__item">
        <span class="growth-activity__label">פוסטים חדשים</span>
        <span class="growth-activity__value">${formatNumber(today.kinds?.[1] || 0)}</span>
      </div>
      ${prominentRelays}
    `;

    growthSelectors.activity.innerHTML = activityHtml;
  }

  // חלק לוח גידול (market-dashboard.js) – מציג רשימת מובילי רשת לפי תרומה
  function renderLeaders(stats) {
    if (!growthSelectors.leaders) {
      return;
    }
    const topPubkeys = (stats.pubkeys || []).slice(0, 5);
    const leadersHtml = topPubkeys
      .map((entry, index) => {
        const displayName = entry.name || entry.pubkey.slice(0, 8).concat('…');
        const likes = entry.likesGiven || 0;
        const posts = entry.counts?.[1] || 0;
        const reactions = entry.counts?.[7] || 0;
        const initials = (displayName || '').trim().slice(0, 2).toUpperCase() || entry.pubkey.slice(0, 2).toUpperCase();
        const avatar = entry.picture
          ? `<img src="${entry.picture}" alt="${displayName}" />`
          : `<span class="growth-leader__avatar-fallback">${initials}</span>`;
        return `
          <article class="growth-leader">
            <span class="growth-leader__badge">${index + 1}</span>
            <div class="growth-leader__avatar" aria-hidden="true">${avatar}</div>
            <div class="growth-leader__meta">
              <h4>${displayName}</h4>
              <span>${entry.pubkey.slice(0, 16)}…</span>
            </div>
            <div class="growth-leader__stat">
              <div>פוסטים: ${formatNumber(posts)}</div>
              <div>אינטראקציות: ${formatNumber(reactions + likes)}</div>
            </div>
          </article>
        `;
      })
      .join('');

    growthSelectors.leaders.innerHTML = leadersHtml || '<div class="growth-activity__item">אין נתונים להצגה</div>';
  }

  // חלק לוח גידול (market-dashboard.js) – משרטט גרף מגמת פעילות עם Chart.js
  function renderChart(stats) {
    if (!growthSelectors.chartCanvas) {
      return;
    }
    const timeline = filterTimelineByRange(stats.timeline || []);
    const labels = timeline.map((item) => item.date);
    const totals = timeline.map((item) => item.total || 0);
    const replies = timeline.map((item) => item.replies || 0);

    if (growthState.chart && typeof growthState.chart.destroy === 'function') {
      growthState.chart.destroy();
    }

    const context = growthSelectors.chartCanvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 0, growthSelectors.chartCanvas.height);
    gradient.addColorStop(0, 'rgba(79, 209, 197, 0.35)');
    gradient.addColorStop(1, 'rgba(79, 209, 197, 0.05)');

    growthState.chart = new Chart(context, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'סה"כ פעילות',
            data: totals,
            borderColor: '#4fd1c5',
            backgroundColor: gradient,
            tension: 0.35,
            fill: true,
            pointRadius: 0,
          },
          {
            label: 'תגובות',
            data: replies,
            borderColor: '#8f9bff',
            borderWidth: 2,
            tension: 0.4,
            fill: false,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: {
              color: '#f8fafc',
            },
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.dataset.label}: ${formatNumber(context.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#9ba3be', maxRotation: 0 },
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
          },
          y: {
            ticks: { color: '#9ba3be', callback: (value) => formatNumber(value) },
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
          },
        },
      },
    });

    applyChartRevealAnimation();
  }

  function applyChartRevealAnimation() {
    if (growthSelectors.chartCanvas) {
      growthSelectors.chartCanvas.classList.remove('growth-chart__canvas-reveal');
      // force reflow for restart animation
      void growthSelectors.chartCanvas.offsetWidth;
      growthSelectors.chartCanvas.classList.add('growth-chart__canvas-reveal');
    }
  }

  function filterTimelineByRange(timeline = []) {
    if (!Array.isArray(timeline) || timeline.length === 0) {
      growthState.filteredTimeline = [];
      return [];
    }
    const normalizedTimeline = timeline.filter((entry) => entry?.date && entry.date >= MIN_GROWTH_DATE);
    if (normalizedTimeline.length === 0) {
      growthState.filteredTimeline = [];
      return [];
    }
    const rangeMap = {
      '1d': 1,
      '1w': 7,
      '1m': 30,
      '3m': 90,
      '1y': 365,
    };
    const days = rangeMap[growthState.timelineRange] || normalizedTimeline.length;
    let filtered;
    if (days >= normalizedTimeline.length) {
      filtered = normalizedTimeline.slice();
    } else {
      filtered = normalizedTimeline.slice(-days);
    }
    growthState.filteredTimeline = filtered;
    return filtered;
  }

  function updateRangeButtons() {
    if (!Array.isArray(growthSelectors.rangeButtons)) {
      return;
    }
    growthSelectors.rangeButtons.forEach((button) => {
      const range = button.getAttribute('data-range');
      button.classList.toggle('is-active', range === growthState.timelineRange);
    });
  }

  function bindRangeButtons() {
    if (!Array.isArray(growthSelectors.rangeButtons) || growthSelectors.rangeButtons.length === 0) {
      return;
    }
    growthSelectors.rangeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const range = button.getAttribute('data-range');
        if (!range || range === growthState.timelineRange) {
          return;
        }
        growthState.timelineRange = range;
        updateRangeButtons();
        if (growthState.lastStats) {
          renderChart(growthState.lastStats);
        }
      });
    });
    updateRangeButtons();
  }

  // חלק לוח גידול (market-dashboard.js) – מציג סטטוס טעינה או שגיאה למשתמש
  function setStatus(message, type = 'info') {
    if (!growthSelectors.status) {
      return;
    }
    growthSelectors.status.dataset.type = type;
    growthSelectors.status.textContent = message;
  }

  // חלק לוח גידול (market-dashboard.js) – מבצע שאילתות לריליים ומעבד נתונים בצד לקוח
  async function fetchGrowthDataFromRelays() {
    if (!window.NostrTools?.SimplePool) {
      throw new Error('NostrTools לא נטען בדפדפן');
    }
    if (!Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      throw new Error('לא הוגדרו ריליים לטעינה');
    }

    const pool = new window.NostrTools.SimplePool();
    const filters = buildGrowthFilters();

    setStatus('מושך אירועים מהריליים...');
    const events = await collectEventsFromPool(pool, App.relayUrls, filters);
    pool.close(App.relayUrls);

    const byId = new Map();
    events.forEach((event) => {
      if (event?.id && !byId.has(event.id)) {
        byId.set(event.id, event);
      }
    });

    const deletedIds = new Set();
    byId.forEach((event, id) => {
      if (event?.kind === 5 && Array.isArray(event.tags)) {
        event.tags.forEach((tag) => {
          if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string') {
            deletedIds.add(tag[1]);
          }
        });
        byId.delete(id);
      }
    });
    deletedIds.forEach((targetId) => {
      byId.delete(targetId);
    });

    const intermediateEvents = Array.from(byId.values());
    const callDiagnostics = analyzeCallEventsDiagnostics(intermediateEvents);
    if (callDiagnostics && window.DEBUG_GROWTH_DIAGNOSTICS) {
      console.groupCollapsed('[GrowthDiagnostics] call events snapshot');
      console.info('kindCounts', callDiagnostics.kindCounts);
      console.info('tagMatches', callDiagnostics.tagMatches);
      if (callDiagnostics.durationHints.length) {
        console.table(callDiagnostics.durationHints.slice(0, 10));
      }
      console.groupEnd();
    }

    const stats = buildClientStats(intermediateEvents);
    const relaysReport = App.relayUrls.map((relayUrl) => {
      const relayEvents = events.filter((event) => event?.relay === relayUrl);
      const totalsByKind = {};
      relayEvents.forEach((event) => {
        if (typeof event?.kind === 'number') {
          totalsByKind[event.kind] = (totalsByKind[event.kind] || 0) + 1;
        }
      });
      return {
        relayUrl,
        total: relayEvents.length,
        kinds: totalsByKind,
      };
    });
    growthState.lastStats = stats;
    notifyGrowthListeners(stats);
    setStatus(`עודכן לאחרונה: ${new Date().toLocaleTimeString('he-IL')}`);
    return { stats, relays: relaysReport };
  }

  // חלק לוח גידול (market-dashboard.js) – איסוף אירועים מ-SimplePool גם בגרסאות ללא list
  function collectEventsFromPool(pool, relays, filters) {
    if (typeof pool.list === 'function') {
      return pool.list(relays, filters);
    }
    if (typeof pool.querySync === 'function') {
      const primaryFilter = Array.isArray(filters) ? filters[0] : filters;
      return pool.querySync(relays, primaryFilter, { maxWait: 15000 }).catch((error) => {
        console.warn('pool.querySync failed', error);
        return [];
      });
    }

    return new Promise((resolve) => {
      const collected = [];
      const pending = new Set(relays);
      let settled = false;
      const subscription = pool.subscribeMany(relays, filters, {
        onevent: (event) => collected.push(event),
        oneose: (_relay, url) => {
          if (url) {
            pending.delete(url);
          }
          if (!pending.size && !settled) {
            settled = true;
            subscription.close();
            resolve(collected);
          }
        },
        onclose: () => {
          if (!settled) {
            settled = true;
            resolve(collected);
          }
        },
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          subscription.close();
          resolve(collected);
        }
      }, 20000);
    });
  }

  // חלק לוח גידול (market-dashboard.js) – עיבוד אירועים למדדי הדשבורד
  function buildClientStats(events) {
    const countsByKind = {};
    const uniquePubkeys = new Set();
    const timelineMap = new Map();
    const pubkeyStats = new Map();
    const metadataByPubkey = new Map();
    const likeLedger = new Map();
    const postsOnly = new Set();
    const replies = new Set();
    const postMeta = new Map();
    const responseIntervals = [];
    const imagePostIds = new Set();
    const videoPostIds = new Set();
    const todayKey = new Date().toISOString().slice(0, 10);
    let repliesToday = 0;
    let loginsCount = 0;
    const loginUsers = new Set();
    let videoCallsCount = 0;
    let voiceCallsCount = 0;
    let gameOpensCount = 0;
    let videoCallDurationSecondsTotal = 0;
    let voiceCallDurationSecondsTotal = 0;
    const MAX_RESPONSE_WINDOW_SECONDS = 12 * 60 * 60; // חלק מדדי תגובה (market-dashboard.js) – מגביל חלון תגובה רלוונטי ל-12 שעות | HYPER CORE TECH

    const mediaPatterns = {
      imageUrl: /(https?:\/\/\S+\.(png|jpe?g|gif|webp|avif))/i,
      videoUrl: /(https?:\/\/\S+\.(mp4|mov|webm|mkv|avi))/i,
      imageDataUri: /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/i,
      videoDataUri: /data:video\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/i,
    };

    const hasTagValue = (event, type, value) =>
      Array.isArray(event?.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === type && tag[1] === value);

    const tagIndicatesMedia = (event, predicate) => {
      if (!Array.isArray(event?.tags)) {
        return false;
      }
      return event.tags.some((tag) => {
        if (!Array.isArray(tag)) {
          return false;
        }
        const [type, value] = tag;
        if (typeof value !== 'string') {
          return false;
        }
        return predicate(type, value);
      });
    };

    const detectMediaType = (event) => {
      const content = typeof event?.content === 'string' ? event.content : '';
      const contentHasImage = mediaPatterns.imageUrl.test(content) || mediaPatterns.imageDataUri.test(content);
      const contentHasVideo = mediaPatterns.videoUrl.test(content) || mediaPatterns.videoDataUri.test(content);

      const hasImageTag =
        hasTagValue(event, 'm', 'image') ||
        hasTagValue(event, 'image', '1') ||
        tagIndicatesMedia(event, (type, value) => {
          if (type === 'thumb' || type === 'picture') {
            return true;
          }
          if (['media', 'image', 'imeta', 'url', 'attachment'].includes(type)) {
            return (
              mediaPatterns.imageUrl.test(value) ||
              mediaPatterns.imageDataUri.test(value) ||
              value.includes('m=image')
            );
          }
          return false;
        });

      const hasVideoTag =
        hasTagValue(event, 'm', 'video') ||
        hasTagValue(event, 'video', '1') ||
        tagIndicatesMedia(event, (type, value) => {
          if (['media', 'video', 'imeta', 'url', 'attachment'].includes(type)) {
            return (
              mediaPatterns.videoUrl.test(value) ||
              mediaPatterns.videoDataUri.test(value) ||
              value.includes('m=video')
            );
          }
          return false;
        });

      return {
        isImage: Boolean(contentHasImage || hasImageTag),
        isVideo: Boolean(contentHasVideo || hasVideoTag),
      };
    };

    const extractParentIds = (event) => {
      if (!Array.isArray(event?.tags)) {
        return [];
      }
      return event.tags
        .filter((tag) => Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string')
        .map((tag) => tag[1]);
    };

    const ensureBucket = (dayKey) => {
      if (!timelineMap.has(dayKey)) {
        timelineMap.set(dayKey, {
          date: dayKey,
          total: 0,
          kinds: {},
          replies: 0,
          participants: new Set(),
          posts: 0,
          comments: 0,
          likes: 0,
          images: 0,
          videos: 0,
          logins: 0,
          videoCalls: 0,
          voiceCalls: 0,
          gameOpens: 0,
          videoCallDurationSeconds: 0,
          voiceCallDurationSeconds: 0,
        });
      }
      return timelineMap.get(dayKey);
    };

    events.forEach((event) => {
      if (!event) {
        return;
      }
      if (typeof event?.created_at === 'number' && event.created_at < MIN_GROWTH_TIMESTAMP) {
        return;
      }
      const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : null;
      const isReply =
        event.kind === 1 && Array.isArray(event.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'e');

      if (normalizedPubkey) {
        uniquePubkeys.add(normalizedPubkey);
        if (!pubkeyStats.has(normalizedPubkey)) {
          pubkeyStats.set(normalizedPubkey, {
            pubkey: normalizedPubkey,
            total: 0,
            counts: {},
            firstSeen: event.created_at || null,
            lastSeen: event.created_at || null,
          });
        }
        const entry = pubkeyStats.get(normalizedPubkey);
        entry.total += 1;
        if (typeof event.kind === 'number') {
          entry.counts[event.kind] = (entry.counts[event.kind] || 0) + 1;
        }
        if (typeof event.created_at === 'number') {
          if (!entry.firstSeen || event.created_at < entry.firstSeen) {
            entry.firstSeen = event.created_at;
          }
          if (!entry.lastSeen || event.created_at > entry.lastSeen) {
            entry.lastSeen = event.created_at;
          }
        }
      }

      let bucket = null;
      let bucketKey = null;
      if (typeof event.created_at === 'number') {
        bucketKey = new Date(event.created_at * 1000).toISOString().slice(0, 10);
        bucket = ensureBucket(bucketKey);
        bucket.total += 1;
        bucket.kinds[event.kind] = (bucket.kinds[event.kind] || 0) + 1;
        if (normalizedPubkey) {
          bucket.participants.add(normalizedPubkey);
        }
      }

      if (event.kind === CALL_METRIC_KIND) {
        const callSummary = (() => {
          const summary = {
            mode: null,
            durationSeconds: 0,
          };
          if (Array.isArray(event?.tags)) {
            event.tags.forEach((tag) => {
              if (!Array.isArray(tag)) return;
              const [type, value] = tag;
              if (type === 't' && typeof value === 'string') {
                if (value === 'video-call') {
                  summary.mode = summary.mode || 'video';
                } else if (value === 'voice-call') {
                  summary.mode = summary.mode || 'voice';
                }
              }
              if (typeof type === 'string' && type.toLowerCase() === 'duration') {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                  summary.durationSeconds = Math.max(summary.durationSeconds, parsed);
                }
              }
            });
          }
          if (!summary.mode) {
            if (Array.isArray(event?.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'metric' && tag[1] === 'call')) {
              summary.mode = 'voice';
            }
          }
          if (typeof event?.content === 'string') {
            try {
              const parsedContent = JSON.parse(event.content);
              if (typeof parsedContent?.mode === 'string') {
                summary.mode = parsedContent.mode;
              }
              if (Number.isFinite(parsedContent?.durationSeconds)) {
                summary.durationSeconds = Math.max(summary.durationSeconds, Number(parsedContent.durationSeconds));
              }
            } catch (error) {
              // אין צורך בלוג – תוכן שאינו JSON
            }
          }
          return summary;
        })();

        const durationSeconds = Number.isFinite(callSummary.durationSeconds) ? Math.max(0, callSummary.durationSeconds) : 0;
        if (durationSeconds > 0) {
          if (callSummary.mode === 'video') {
            videoCallsCount += 1;
            videoCallDurationSecondsTotal += durationSeconds;
          } else if (callSummary.mode === 'voice') {
            voiceCallsCount += 1;
            voiceCallDurationSecondsTotal += durationSeconds;
          }
          if (bucket) {
            if (callSummary.mode === 'video') {
              bucket.videoCallDurationSeconds = (bucket.videoCallDurationSeconds || 0) + durationSeconds;
            } else if (callSummary.mode === 'voice') {
              bucket.voiceCallDurationSeconds = (bucket.voiceCallDurationSeconds || 0) + durationSeconds;
            } else {
              bucket.voiceCallDurationSeconds = (bucket.voiceCallDurationSeconds || 0) + durationSeconds;
            }
          }
        }
        return;
      }

      if (event.kind === 5) {
        return;
      }

      if (typeof event.kind === 'number') {
        countsByKind[event.kind] = (countsByKind[event.kind] || 0) + 1;
      }

      if (event.kind === 1) {
        if (isReply) {
          replies.add(event.id);
          if (bucket) {
            bucket.comments += 1;
            bucket.replies += 1;
          }
          if (bucketKey === todayKey) {
            repliesToday += 1;
          }
        } else {
          postsOnly.add(event.id);
          if (bucket) {
            bucket.posts += 1;
          }
          const mediaFlags = detectMediaType(event);
          if (mediaFlags.isImage) {
            imagePostIds.add(event.id);
            if (bucket) {
              bucket.images += 1;
            }
          }
          if (mediaFlags.isVideo) {
            videoPostIds.add(event.id);
            if (bucket) {
              bucket.videos += 1;
            }
          }
          if (typeof event.created_at === 'number') {
            postMeta.set(event.id, { created_at: event.created_at, pubkey: normalizedPubkey });
          }
        }
      }

      if (event.kind === 7 && Array.isArray(event.tags)) {
        const liker = normalizedPubkey;
        const isUnlike = typeof event.content === 'string' && event.content.trim() === '-';
        event.tags.forEach((tag) => {
          if (!Array.isArray(tag)) return;
          const [type, value] = tag;
          if ((type === 'e' || type === 'a') && value) {
            if (!likeLedger.has(value)) {
              likeLedger.set(value, new Map());
            }
            const ledger = likeLedger.get(value);
            if (liker) {
              if (isUnlike) {
                ledger.delete(liker);
              } else {
                ledger.set(liker, event.created_at || 0);
              }
            }
          }
        });
        if (bucket) {
          bucket.likes += 1;
        }
      }

      if (event.kind === 0 && typeof event.content === 'string') {
        try {
          const metadata = JSON.parse(event.content);
          if (normalizedPubkey) {
            metadataByPubkey.set(normalizedPubkey, {
              name: metadata.name || '',
              about: metadata.about || '',
              picture: metadata.picture || '',
            });
          }
        } catch (error) {
          console.warn('metadata parse failed', event?.id, error.message);
        }
      }

      const bumpMetric = (condition, counterKey) => {
        if (!condition) {
          return;
        }
        switch (counterKey) {
          case 'logins':
            loginsCount += 1;
            if (normalizedPubkey) {
              loginUsers.add(normalizedPubkey);
            }
            break;
          case 'videoCalls':
            videoCallsCount += 1;
            break;
          case 'voiceCalls':
            voiceCallsCount += 1;
            break;
          case 'gameOpens':
            gameOpensCount += 1;
            break;
          default:
            break;
        }
        if (bucket) {
          bucket[counterKey] += 1;
        }
      };

      bumpMetric(event.kind === 1050 || hasTagValue(event, 't', 'login'), 'logins');
      bumpMetric(event.kind === 1051 || hasTagValue(event, 't', 'video-call'), 'videoCalls');
      bumpMetric(event.kind === 1052 || hasTagValue(event, 't', 'voice-call'), 'voiceCalls');
      bumpMetric(event.kind === 1053 || hasTagValue(event, 't', 'game-open'), 'gameOpens');

      const parentIds = extractParentIds(event);
      if (parentIds.length && typeof event.created_at === 'number') {
        const parentMeta = postMeta.get(parentIds[0]);
        if (parentMeta?.created_at != null) {
          const delta = Math.max(0, event.created_at - parentMeta.created_at);
          if (delta && delta <= MAX_RESPONSE_WINDOW_SECONDS) {
            const parentDayKey = new Date(parentMeta.created_at * 1000).toISOString().slice(0, 10);
            if (bucketKey === todayKey && parentDayKey === todayKey) {
              responseIntervals.push(delta);
            }
          }
        }
      }
    });

    const sortedKeys = Array.from(timelineMap.keys()).sort();
    const timelineKeys = sortedKeys.filter((key) => key >= MIN_GROWTH_DATE);
    const timeline = timelineKeys.map((key) => {
      const bucket = timelineMap.get(key);
      return {
        date: bucket.date,
        total: bucket.total,
        kinds: bucket.kinds,
        replies: bucket.replies,
        participants: Array.from(bucket.participants || []),
        participantsCount: bucket.participants ? bucket.participants.size : 0,
        posts: bucket.posts,
        comments: bucket.comments,
        likes: bucket.likes,
        images: bucket.images,
        videos: bucket.videos,
        logins: bucket.logins,
        videoCalls: bucket.videoCalls,
        voiceCalls: bucket.voiceCalls,
        gameOpens: bucket.gameOpens,
        videoCallDurationSeconds: bucket.videoCallDurationSeconds || 0,
        voiceCallDurationSeconds: bucket.voiceCallDurationSeconds || 0,
        dailyTotals: {
          posts: bucket.posts,
          comments: bucket.comments,
          likes: bucket.likes,
          images: bucket.images,
          videos: bucket.videos,
          logins: bucket.logins,
          videoCalls: bucket.videoCalls,
          voiceCalls: bucket.voiceCalls,
          gameOpens: bucket.gameOpens,
          videoCallDurationSeconds: bucket.videoCallDurationSeconds || 0,
          voiceCallDurationSeconds: bucket.voiceCallDurationSeconds || 0,
          totalCallDurationSeconds: (bucket.videoCallDurationSeconds || 0) + (bucket.voiceCallDurationSeconds || 0),
          dailyActiveUsers: bucket.participants ? bucket.participants.size : 0,
          totalEvents: bucket.total,
          uniquePubkeys: bucket.participants ? bucket.participants.size : 0,
        },
      };
    });

    const likesNet = Array.from(likeLedger.values()).reduce((sum, ledger) => sum + ledger.size, 0);
    const totalCallDurationSeconds = videoCallDurationSecondsTotal + voiceCallDurationSecondsTotal;
    const pubkeys = Array.from(pubkeyStats.values())
      .map((entry) => {
        const metadata = metadataByPubkey.get(entry.pubkey) || {};
        const likesGiven = Array.from(likeLedger.values()).reduce(
          (sum, ledger) => sum + (ledger.has(entry.pubkey) ? 1 : 0),
          0,
        );
        return {
          pubkey: entry.pubkey,
          total: entry.total,
          counts: entry.counts,
          firstSeen: entry.firstSeen,
          lastSeen: entry.lastSeen,
          name: metadata.name || '',
          about: metadata.about || '',
          picture: metadata.picture || '',
          likesGiven,
        };
      })
      .sort((a, b) => b.total - a.total);

    const todayBucketKey = timelineKeys[timelineKeys.length - 1] || null;
    const todayBucket = todayBucketKey ? timelineMap.get(todayBucketKey) : null;
    const todayParticipants = todayBucket?.participants || new Set();
    const yesterdayBucketKey = timelineKeys.length > 1 ? timelineKeys[timelineKeys.length - 2] : null;
    const yesterdayParticipants = yesterdayBucketKey
      ? timelineMap.get(yesterdayBucketKey)?.participants || new Set()
      : new Set();
    const returningDaily = todayParticipants.size
      ? Array.from(todayParticipants).filter((participant) => yesterdayParticipants.has(participant)).length
      : 0;
    const retentionDaily = todayParticipants.size ? returningDaily / todayParticipants.size : 0;

    const pastWeekSet = new Set();
    for (let idx = Math.max(0, timelineKeys.length - 8); idx < timelineKeys.length - 1; idx += 1) {
      timelineMap.get(timelineKeys[idx])?.participants?.forEach((participant) => pastWeekSet.add(participant));
    }
    const returningWeekly = todayParticipants.size
      ? Array.from(todayParticipants).filter((participant) => pastWeekSet.has(participant)).length
      : 0;
    const retentionWeekly = todayParticipants.size ? returningWeekly / todayParticipants.size : 0;

    const todayStartTimestamp = todayBucketKey
      ? Math.floor(new Date(`${todayBucketKey}T00:00:00Z`).getTime() / 1000)
      : 0;
    const newUsersCount = todayStartTimestamp
      ? Array.from(pubkeyStats.values()).filter(
          (entry) => typeof entry.firstSeen === 'number' && entry.firstSeen >= todayStartTimestamp,
        ).length
      : 0;

    const avgResponseSeconds = responseIntervals.length
      ? responseIntervals.reduce((sum, val) => sum + val, 0) / responseIntervals.length
      : 0;
    const avgResponseMinutes = avgResponseSeconds / 60;

    const imagesCount = imagePostIds.size;
    const videosCount = videoPostIds.size;
    const textPostsCount = Math.max(0, postsOnly.size - imagesCount - videosCount);
    const totalContentCount = imagesCount + videosCount + textPostsCount;
    const contentMix = totalContentCount
      ? {
          images: imagesCount / totalContentCount,
          videos: videosCount / totalContentCount,
          text: textPostsCount / totalContentCount,
        }
      : { images: 0, videos: 0, text: 0 };

    const totalInteractions = likesNet + replies.size + (countsByKind[1050] || 0);
    const engagementPerUser = uniquePubkeys.size ? totalInteractions / uniquePubkeys.size : 0;

    const postsToday = todayBucket ? todayBucket.posts : 0;
    const commentsToday = todayBucket ? todayBucket.comments : 0;
    const likesToday = todayBucket ? todayBucket.likes : 0;
    const imagesToday = todayBucket ? todayBucket.images : 0;
    const videosToday = todayBucket ? todayBucket.videos : 0;
    const loginsToday = todayBucket ? todayBucket.logins : 0;
    const videoCallsToday = todayBucket ? todayBucket.videoCalls : 0;
    const voiceCallsToday = todayBucket ? todayBucket.voiceCalls : 0;
    const videoCallDurationTodaySeconds = todayBucket ? todayBucket.videoCallDurationSeconds || 0 : 0;
    const voiceCallDurationTodaySeconds = todayBucket ? todayBucket.voiceCallDurationSeconds || 0 : 0;
    const totalCallDurationTodaySeconds = videoCallDurationTodaySeconds + voiceCallDurationTodaySeconds;
    const gameOpensToday = todayBucket ? todayBucket.gameOpens : 0;
    const dailyActiveUsers = todayParticipants.size;

    const dailyTotals = {
      posts: postsToday,
      comments: commentsToday,
      likes: likesToday,
      images: imagesToday,
      videos: videosToday,
      logins: loginsToday,
      videoCalls: videoCallsToday,
      voiceCalls: voiceCallsToday,
      gameOpens: gameOpensToday,
      videoCallDurationSeconds: videoCallDurationTodaySeconds,
      voiceCallDurationSeconds: voiceCallDurationTodaySeconds,
      totalCallDurationSeconds,
      dailyActiveUsers,
      totalEvents: todayBucket ? todayBucket.total : 0,
      uniquePubkeys: todayBucket ? todayBucket.participants?.size || 0 : 0,
    }; // חלק מדדי יומיים (market-dashboard.js) – לוכד את נתוני היום האחרון להצגה ייעודית | HYPER CORE TECH

    return {
      totalEvents: events.length,
      uniquePubkeys: uniquePubkeys.size,
      uniqueLoginsCount: loginUsers.size,
      countsByKind,
      profilesCount: countsByKind[0] || 0,
      postsCount: postsOnly.size,
      repliesCount: replies.size,
      repostsCount: countsByKind[6] || 0,
      likesCount: likesNet,
      chatsCount: countsByKind[1050] || 0,
      imagesCount,
      videosCount,
      gameOpensCount,
      loginsCount,
      videoCallsCount,
      voiceCallsCount,
      videoCallDurationSeconds: videoCallDurationSecondsTotal,
      voiceCallDurationSeconds: voiceCallDurationSecondsTotal,
      totalCallDurationSeconds,
      timeline,
      pubkeys,
      repliesToday,
      newUsersCount,
      retentionDaily,
      retentionWeekly,
      avgResponseSeconds,
      avgResponseMinutes,
      engagementPerUser,
      contentMix,
      totalInteractions,
      responseSampleSize: responseIntervals.length,
      postsToday,
      commentsToday,
      likesToday,
      imagesToday,
      videosToday,
      loginsToday,
      videoCallsToday,
      voiceCallsToday,
      gameOpensToday,
      dailyActiveUsers,
      videoCallDurationTodaySeconds,
      voiceCallDurationTodaySeconds,
      totalCallDurationTodaySeconds,
      dailyTotals,
    };
  }

  // חלק לוח גידול (market-dashboard.js) – קישור טאבים ומאזיני UI
  function bindTabs() {
    growthSelectors.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        growthSelectors.tabs.forEach((btn) => btn.classList.toggle('is-active', btn === tab));
        growthSelectors.panes.forEach((pane) => pane.classList.toggle('is-hidden', pane.dataset.pane !== target));
      });
    });
  }

  // חלק לוח גידול (market-dashboard.js) – רענון אוטומטי
  function bindAutoRefreshToggle() {
    if (!growthSelectors.autoRefresh) {
      return;
    }
    growthSelectors.autoRefresh.addEventListener('change', (event) => {
      if (event.target.checked) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    });
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    growthState.autoInterval = window.setInterval(() => refreshGrowthDashboard({ silent: true }), 120000);
  }

  function stopAutoRefresh() {
    if (growthState.autoInterval) {
      clearInterval(growthState.autoInterval);
      growthState.autoInterval = null;
    }
  }

  // חלק לוח גידול (market-dashboard.js) – רענון נתוני הדשבורד
  async function refreshGrowthDashboard(options = {}) {
    if (growthState.isLoading) {
      return;
    }
    growthState.isLoading = true;
    if (!options.silent) {
      setStatus('טוען נתוני רשת...');
    }
    try {
      const data = await fetchGrowthDataFromRelays();
      growthState.lastStats = data.stats;
      renderMetrics(data.stats);
      renderChart(data.stats);
      renderActivity(data.stats, data.relays);
      renderLeaders(data.stats);
      notifyGrowthListeners(data.stats);
      if (!options.silent) {
        setStatus(`עודכן בהצלחה: ${new Date().toLocaleTimeString('he-IL')}`);
      }
    } catch (error) {
      console.error('refreshGrowthDashboard failed', error);
      if (!options.silent) {
        setStatus(`טעינת מידע נכשלה: ${error.message}`, 'error');
      }
    } finally {
      growthState.isLoading = false;
    }
  }

  // חלק לוח גידול (market-dashboard.js) – פתיחת הדשבורד למשתמש
  function openGrowthDashboard() {
    if (!growthSelectors.root) {
      return;
    }
    growthSelectors.root.classList.add('is-open');
    growthSelectors.backdrop?.classList.add('is-visible');
    if (!growthState.lastStats) {
      refreshGrowthDashboard();
    } else {
      renderMetrics(growthState.lastStats);
      renderChart(growthState.lastStats);
      renderActivity(
        growthState.lastStats,
        App.relayUrls?.map((relayUrl) => ({ relayUrl, total: 0 })) || []
      );
      renderLeaders(growthState.lastStats);
    }
    if (growthSelectors.autoRefresh?.checked) {
      startAutoRefresh();
    }
  }

  // חלק לוח גידול (market-dashboard.js) – סגירת הדשבורד
  function closeGrowthDashboard() {
    if (!growthSelectors.root) {
      return;
    }
    growthSelectors.root.classList.remove('is-open');
    growthSelectors.backdrop?.classList.remove('is-visible');
    stopAutoRefresh();
  }

  // חלק לוח גידול (market-dashboard.js) – מגדיר אובייקטי API לשימוש מהאפליקציה
  App.initializeGrowthDashboard = function initializeGrowthDashboard() {
    bindTabs();
    bindAutoRefreshToggle();
    bindRangeButtons();
    if (growthSelectors.refreshButton) {
      growthSelectors.refreshButton.addEventListener('click', () => refreshGrowthDashboard());
    }
  };

  // חלק לוח גידול (market-dashboard.js) – רענון growthSelectors עבור דפים שטוענים את market-dashboard.js אחרי ה-DOM | HYPER CORE TECH
  App.refreshGrowthSelectors = function refreshGrowthSelectors() {
    growthSelectors.root = document.getElementById('growthDashboard');
    growthSelectors.backdrop = document.querySelector('#growthDashboard .growth-dashboard__backdrop');
    growthSelectors.tabs = Array.from(document.querySelectorAll('#growthDashboard .growth-dashboard__tab'));
    growthSelectors.panes = Array.from(document.querySelectorAll('#growthDashboard .growth-dashboard__section'));
    growthSelectors.metrics = document.getElementById('growthMetrics');
    growthSelectors.activity = document.getElementById('growthActivity');
    growthSelectors.leaders = document.getElementById('growthLeaders');
    growthSelectors.status = document.getElementById('growthStatus');
    growthSelectors.autoRefresh = document.getElementById('growthAutoRefresh');
    growthSelectors.refreshButton = document.querySelector('#growthDashboard .growth-dashboard__refresh');
    growthSelectors.chartCanvas = document.getElementById('growthChart');
    growthSelectors.panel = document.querySelector('#growthDashboard .growth-dashboard__panel');
    growthSelectors.rangesContainer = document.querySelector('#growthChartContainer .growth-chart__ranges');
    growthSelectors.rangeButtons = Array.from(
      (growthSelectors.rangesContainer || document).querySelectorAll?.('.growth-chart__range-button') || []
    );
    console.log('[GROWTH] Selectors refreshed:', growthSelectors.root ? 'root found' : 'root NOT found');
  };

  App.openGrowthDashboard = openGrowthDashboard;
  App.closeGrowthDashboard = closeGrowthDashboard;
  App.refreshGrowthDashboard = refreshGrowthDashboard;
  App.getLatestGrowthStats = function getLatestGrowthStats() {
    return growthState.lastStats;
  };
  App.registerGrowthStatsListener = function registerGrowthStatsListener(listener) {
    if (typeof listener === 'function') {
      growthListeners.add(listener);
    }
    return () => {
      growthListeners.delete(listener);
    };
  };

  function notifyGrowthListeners(stats) {
    growthListeners.forEach((listener) => {
      try {
        listener(stats);
      } catch (error) {
        console.warn('growth listener failed', error);
      }
    });
  }
})(window);

