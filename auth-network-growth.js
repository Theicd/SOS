// קובץ: auth-network-growth.js
// תיאור: גרף מגמות גידול הרשת בדף ההתחברות – מציג פעילות, משתמשים ושווי רשת | HYPER CORE TECH

(function initAuthGrowthChart(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const canvas = document.getElementById('authGrowthChart');

  if (!canvas || typeof window.Chart === 'undefined') {
    return;
  }

  const ctx = canvas.getContext('2d');
  const state = {
    growthSeries: null,
    creditSeries: null,
  };
  let growthChart = null;

  // חלק עזר (auth-network-growth.js) – המרת תאריך לייצוג יומי עבור צירי הגרף | HYPER CORE TECH
  const toDateKey = (value) => {
    if (!value) {
      return '';
    }
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toISOString().slice(0, 10);
  };

  // חלק עזר (auth-network-growth.js) – בניית סדרות צמיחה מתוך נתוני הריליי | HYPER CORE TECH
  const buildGrowthSeries = (stats) => {
    if (!stats || !Array.isArray(stats.timeline)) {
      return null;
    }
    const trimmedTimeline = stats.timeline.slice(-60);
    const labels = trimmedTimeline.map((bucket) => bucket?.date || bucket?.day || bucket?.bucketKey || '');
    const totals = trimmedTimeline.map((bucket) => Number(bucket?.total) || 0);
    const participants = trimmedTimeline.map((bucket) => {
      if (typeof bucket?.participantsCount === 'number') {
        return Math.max(0, bucket.participantsCount);
      }
      if (Array.isArray(bucket?.participants)) {
        return bucket.participants.length;
      }
      if (bucket?.dailyTotals && typeof bucket.dailyTotals.dailyActiveUsers === 'number') {
        return Math.max(0, bucket.dailyTotals.dailyActiveUsers);
      }
      return 0;
    });
    const replies = trimmedTimeline.map((bucket) => Number(bucket?.replies) || Number(bucket?.comments) || 0);
    return { labels, totals, participants, replies };
  };

  // חלק עזר (auth-network-growth.js) – בניית סדרות ערך USD מתוך מנוע הקרדיטים | HYPER CORE TECH
  const buildCreditSeries = (graph) => {
    if (!graph || !Array.isArray(graph.timeline)) {
      return null;
    }
    const entries = graph.timeline.slice(-90);
    const byDate = new Map();
    entries.forEach((entry) => {
      const dateKey = toDateKey(entry?.date || entry?.timestamp);
      if (!dateKey) {
        return;
      }
      const valueUSD = Number(entry?.valueUSD);
      if (!Number.isFinite(valueUSD)) {
        return;
      }
      byDate.set(dateKey, valueUSD);
    });
    return byDate.size ? byDate : null;
  };

  // חלק גרף (auth-network-growth.js) – יוצר תרשים משולב של פעילות, משתמשים ושווי רשת | HYPER CORE TECH
  const ensureChart = () => {
    if (growthChart) {
      return growthChart;
    }
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, 'rgba(99, 230, 190, 0.55)');
    gradient.addColorStop(1, 'rgba(99, 230, 190, 0.05)');

    growthChart = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            type: 'bar',
            label: 'סה"כ אירועים',
            data: [],
            backgroundColor: gradient,
            borderRadius: 6,
            maxBarThickness: 18,
            yAxisID: 'events',
          },
          {
            type: 'line',
            label: 'משתמשים פעילים',
            data: [],
            borderColor: '#8f9bff',
            backgroundColor: 'rgba(143, 155, 255, 0.20)',
            tension: 0.35,
            fill: false,
            pointRadius: 0,
            yAxisID: 'users',
          },
          {
            type: 'line',
            label: 'שווי רשת (USD)',
            data: [],
            borderColor: '#f472b6',
            backgroundColor: 'rgba(244, 114, 182, 0.18)',
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            yAxisID: 'value',
          },
          {
            type: 'line',
            label: 'תגובות ביום',
            data: [],
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.18)',
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            borderDash: [6, 4],
            yAxisID: 'users',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#d8deff',
            },
          },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === 'value') {
                  return `${context.dataset.label}: ${Number(context.parsed.y || 0).toLocaleString('he-IL', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                  })}`;
                }
                return `${context.dataset.label}: ${Number(context.parsed.y || 0).toLocaleString('he-IL')}`;
              },
            },
          },
        },
        scales: {
          events: {
            position: 'left',
            grid: { color: 'rgba(148, 163, 184, 0.12)' },
            ticks: {
              color: '#cdd9ff',
              callback(value) {
                return Number(value || 0).toLocaleString('he-IL');
              },
            },
          },
          users: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: '#a5b4fc',
              callback(value) {
                return Number(value || 0).toLocaleString('he-IL');
              },
            },
          },
          value: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: '#fbcfe8',
              callback(value) {
                return Number(value || 0).toLocaleString('he-IL', {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 0,
                });
              },
            },
          },
          x: {
            ticks: {
              color: '#c7d2fe',
              maxRotation: 0,
              callback(value, index, ticks) {
                if (!ticks || ticks.length <= 8) {
                  return this.getLabelForValue(value);
                }
                return index % Math.ceil(ticks.length / 8) === 0 ? this.getLabelForValue(value) : '';
              },
            },
            grid: { color: 'rgba(148, 163, 184, 0.10)' },
          },
        },
      },
    });
    return growthChart;
  };

  // חלק גרף (auth-network-growth.js) – עדכון הגרף בכל קבלת נתונים חדשים | HYPER CORE TECH
  const updateChart = () => {
    if (!state.growthSeries) {
      return;
    }
    const chartInstance = ensureChart();
    const labels = state.growthSeries.labels;

    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = state.growthSeries.totals;
    chartInstance.data.datasets[1].data = state.growthSeries.participants;
    chartInstance.data.datasets[3].data = state.growthSeries.replies;

    if (state.creditSeries) {
      chartInstance.data.datasets[2].data = labels.map((label) => {
        const value = state.creditSeries.get(label);
        return Number.isFinite(value) ? value : null;
      });
    } else {
      chartInstance.data.datasets[2].data = labels.map(() => null);
    }

    chartInstance.update('none');
  };

  // חלק הרשמה (auth-network-growth.js) – רישום מאזינים לנתוני צמיחה וקרדיטים | HYPER CORE TECH
  const wireGrowthListeners = () => {
    if (typeof App.registerGrowthStatsListener === 'function') {
      App.registerGrowthStatsListener((stats) => {
        state.growthSeries = buildGrowthSeries(stats);
        updateChart();
      });
    }
    if (typeof App.getLatestGrowthStats === 'function') {
      const latest = App.getLatestGrowthStats();
      if (latest) {
        state.growthSeries = buildGrowthSeries(latest);
        updateChart();
      } else if (typeof App.refreshGrowthDashboard === 'function') {
        App.refreshGrowthDashboard({ silent: true });
      }
    }
  };

  const wireCreditListeners = () => {
    if (typeof App.subscribeCreditUpdates === 'function') {
      App.subscribeCreditUpdates((payload) => {
        const graph = payload?.graph || (typeof App.getCreditGraphSeries === 'function' ? App.getCreditGraphSeries() : null);
        state.creditSeries = buildCreditSeries(graph);
        updateChart();
      });
    }
    if (!state.creditSeries && typeof App.getCreditGraphSeries === 'function') {
      const graph = App.getCreditGraphSeries();
      state.creditSeries = buildCreditSeries(graph);
      updateChart();
    }
  };

  wireGrowthListeners();
  wireCreditListeners();
})(window);
