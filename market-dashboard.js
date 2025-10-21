// חלק לוח גידול (market-dashboard.js) – אחראי על פתיחה, סגירה וטעינת נתוני גידול מהרשת המקומית
(function initMarketDashboard(window) {
  const App = window.NostrApp || (window.NostrApp = {});

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
  };

  const growthState = {
    chart: null,
    autoInterval: null,
    lastStats: null,
    isLoading: false,
  };
  const growthListeners = new Set();

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
    const totalDelta = computeDailyDelta(timeline, 'total');

    const cards = [
      {
        label: 'שווי רשת משוער',
        value: stats.totalEvents || 0,
        trend: totalDelta.trend,
        trendLabel: `${totalDelta.value > 0 ? '+' : ''}${formatNumber(totalDelta.value)} אירועים מאתמול`,
      },
      {
        label: 'הון אנושי פעיל',
        value: stats.uniquePubkeys || 0,
        trend: postsDelta.trend,
        trendLabel: `${postsDelta.value > 0 ? '+' : ''}${formatNumber(postsDelta.value)} פוסטים חדשים`,
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
    const timeline = stats.timeline || [];
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
    const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
    const filters = [
      {
        kinds: [0, 1, 5, 6, 7, 1050],
        '#t': [App.NETWORK_TAG],
        since: fourteenDaysAgo,
        limit: 2000,
      },
    ];

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

    const stats = buildClientStats(Array.from(byId.values()));
    const relaysReport = App.relayUrls.map((relayUrl) => ({ relayUrl }));
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
        onevent: (event) => {
          collected.push(event);
        },
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

  // חלק לוח גידול (market-dashboard.js) – מעבד אירועים לסיכומים בדומה לשרת
  function buildClientStats(events) {
    const countsByKind = {};
    const uniquePubkeys = new Set();
    const timelineMap = new Map();
    const pubkeyStats = new Map();
    const metadataByPubkey = new Map();
    const likeLedger = new Map();
    const postsOnly = new Set();
    const replies = new Set();
    const todayKey = new Date().toISOString().slice(0, 10);
    let repliesToday = 0;

    events.forEach((event) => {
      if (!event) return;
      const isReply = event.kind === 1 && Array.isArray(event.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'e');
      if (event.pubkey) {
        const normalized = event.pubkey.toLowerCase();
        uniquePubkeys.add(normalized);
        if (!pubkeyStats.has(normalized)) {
          pubkeyStats.set(normalized, {
            pubkey: normalized,
            total: 0,
            counts: {},
            firstSeen: event.created_at || null,
            lastSeen: event.created_at || null,
          });
        }
        const entry = pubkeyStats.get(normalized);
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
      if (event.kind === 5) {
        return;
      }
      if (typeof event.kind === 'number') {
        countsByKind[event.kind] = (countsByKind[event.kind] || 0) + 1;
      }
      if (event.kind === 1) {
        if (isReply) {
          replies.add(event.id);
        } else {
          postsOnly.add(event.id);
        }
      }
      if (event.kind === 7 && Array.isArray(event.tags)) {
        const liker = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : null;
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
      }
      if (event.kind === 0 && typeof event.content === 'string') {
        try {
          const metadata = JSON.parse(event.content);
          if (event.pubkey) {
            metadataByPubkey.set(event.pubkey.toLowerCase(), {
              name: metadata.name || '',
              about: metadata.about || '',
              picture: metadata.picture || '',
            });
          }
        } catch (error) {
          console.warn('metadata parse failed', event.id, error.message);
        }
      }
      if (typeof event.created_at === 'number') {
        const timestampMs = event.created_at * 1000;
        const dayKey = new Date(timestampMs).toISOString().slice(0, 10);
        if (!timelineMap.has(dayKey)) {
          timelineMap.set(dayKey, { date: dayKey, total: 0, kinds: {}, replies: 0 });
        }
        const bucket = timelineMap.get(dayKey);
        bucket.total += 1;
        bucket.kinds[event.kind] = (bucket.kinds[event.kind] || 0) + 1;
        if (isReply) {
          bucket.replies = (bucket.replies || 0) + 1;
          if (dayKey === todayKey) {
            repliesToday += 1;
          }
        }
      }
    });

    const timeline = Array.from(timelineMap.values()).sort((a, b) => (a.date > b.date ? 1 : -1));
    const likesNet = Array.from(likeLedger.values()).reduce((sum, ledger) => sum + ledger.size, 0);
    const pubkeys = Array.from(pubkeyStats.values())
      .map((entry) => {
        const metadata = metadataByPubkey.get(entry.pubkey) || {};
        const userLikes = Array.from(likeLedger.values()).reduce((sum, ledger) => {
          return sum + (ledger.has(entry.pubkey) ? 1 : 0);
        }, 0);
        return {
          pubkey: entry.pubkey,
          total: entry.total,
          counts: entry.counts,
          firstSeen: entry.firstSeen,
          lastSeen: entry.lastSeen,
          name: metadata.name || '',
          about: metadata.about || '',
          picture: metadata.picture || '',
          likesGiven: userLikes,
        };
      })
      .sort((a, b) => b.total - a.total);

    return {
      totalEvents: events.length,
      uniquePubkeys: uniquePubkeys.size,
      countsByKind,
      profilesCount: countsByKind[0] || 0,
      postsCount: postsOnly.size,
      repliesCount: replies.size,
      repostsCount: countsByKind[6] || 0,
      likesCount: likesNet,
      chatsCount: countsByKind[1050] || 0,
      timeline,
      pubkeys,
      repliesToday,
    };
  }

  // חלק לוח גידול (market-dashboard.js) – מנהל מצבי לשוניות בלוח הגידול
  function bindTabs() {
    growthSelectors.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        growthSelectors.tabs.forEach((btn) => btn.classList.toggle('is-active', btn === tab));
        growthSelectors.panes.forEach((pane) => {
          pane.classList.toggle('is-hidden', pane.dataset.pane !== target);
        });
      });
    });
  }

  // חלק לוח גידול (market-dashboard.js) – פותח את הלוח עם אנימציה
  function openGrowthDashboard() {
    if (!growthSelectors.root) {
      return;
    }
    growthSelectors.root.classList.add('is-open');
    growthSelectors.root.setAttribute('aria-hidden', 'false');
    growthSelectors.panel?.focus?.();
    if (!growthState.lastStats) {
      refreshGrowthDashboard();
    }
  }

  // חלק לוח גידול (market-dashboard.js) – סוגר את הלוח ומנקה סטטוסים
  function closeGrowthDashboard() {
    if (!growthSelectors.root) {
      return;
    }
    growthSelectors.root.classList.remove('is-open');
    growthSelectors.root.setAttribute('aria-hidden', 'true');
  }

  // חלק לוח גידול (market-dashboard.js) – מפעיל או עוצר רענון אוטומטי
  function updateAutoRefresh() {
    if (growthState.autoInterval) {
      clearInterval(growthState.autoInterval);
      growthState.autoInterval = null;
    }
    if (growthSelectors.autoRefresh?.checked) {
      growthState.autoInterval = setInterval(() => {
        refreshGrowthDashboard({ silent: true });
      }, 60_000);
    }
  }

  // חלק לוח גידול (market-dashboard.js) – מאזין לשינויים בבורר הרענון האוטומטי
  function bindAutoRefreshToggle() {
    if (!growthSelectors.autoRefresh) {
      return;
    }
    growthSelectors.autoRefresh.addEventListener('change', updateAutoRefresh);
    updateAutoRefresh();
  }

  // חלק לוח גידול (market-dashboard.js) – מרענן נתונים ויזואלית לפי הצורך
  async function refreshGrowthDashboard(options = {}) {
    if (growthState.isLoading) {
      return;
    }
    try {
      growthState.isLoading = true;
      if (!options.silent) {
        setStatus('מרענן נתונים מהרשת המבוזרת...');
      }
      const data = await fetchGrowthDataFromRelays();
      renderMetrics(data.stats);
      renderChart(data.stats);
      renderActivity(data.stats, data.relays);
      renderLeaders(data.stats);
      notifyGrowthListeners(data.stats);
      if (typeof App?.onGrowthStatsUpdated === 'function') {
        App.onGrowthStatsUpdated(data.stats);
      }
    } catch (error) {
      if (!options.silent) {
        setStatus(`טעינת מידע נכשלה: ${error.message}`, 'error');
      }
    } finally {
      growthState.isLoading = false;
    }
  }

  // חלק לוח גידול (market-dashboard.js) – מגדיר אובייקטי API לשימוש מהאפליקציה
  App.initializeGrowthDashboard = function initializeGrowthDashboard() {
    bindTabs();
    bindAutoRefreshToggle();
    if (growthSelectors.refreshButton) {
      growthSelectors.refreshButton.addEventListener('click', () => refreshGrowthDashboard());
    }
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
