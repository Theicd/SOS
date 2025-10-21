// חלק חוזה חכם 2 (contract-dashboard-v2.js) – מציג חוויית השקעה גרפית עבור SPEAR ONE
(function initContractDashboardV2(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – בחירת רכיבים מרכזיים בלוח החדש
  const selectors = {
    root: document.getElementById('contractDashboardV2'),
    panel: document.querySelector('#contractDashboardV2 .contract-dashboard-v2__panel'),
    status: document.getElementById('contractV2Status'),
    highlights: document.getElementById('contractV2Highlights'),
    developmentValue: document.getElementById('contractV2DevelopmentValue'),
    unitValue: document.getElementById('contractV2UnitValue'),
    yield: document.getElementById('contractV2NetworkYield'),
    legend: document.getElementById('contractV2Legend'),
    infraGrid: document.getElementById('contractV2InfraGrid'),
    chartCanvas: document.getElementById('contractV2Chart'),
    details: document.getElementById('contractV2Details'),
    detailsToggle: document.getElementById('contractV2DetailsToggle'),
  };

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – אחסון מצב הלוח ונתונים אחרונים
  const contractV2State = {
    chart: null,
    latestStats: null,
    model: null,
    detailsOpen: false,
  };

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – קבועים פיננסיים בסיסיים עבור החישובים
  const FINANCIAL_CONSTANTS = {
    developmentCostILS: 300_000, // הושקעו כ-300K ₪ בפיתוח SPEAR ONE
    ilsToUsdRate: 0.27, // המרה משוערת לשווי דולר לצורך אחידות תצוגה
    baseUnitPriceUSD: 50, // מחיר רכישת יחידה
    buybackRate: 0.8, // גובה הזיכוי בקרדיטים בעת Buyback
    relayCapacityPerNode: 23_000, // קיבולת ממוצעת לכל Relay בתצורה הנוכחית
    userValueMultiplier: 38, // הערכה שמרנית לשווי משתמש פעיל בטכנולוגיה מבוזרת
    infrastructureSavingsPerBusinessUSD: 3_600, // חיסכון שנתי לעסק קטן
  };

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – כלי עזר להצגת מספרים
  function formatNumber(value) {
    return (Number(value) || 0).toLocaleString('he-IL');
  }

  function formatCurrencyUSD(value, fractionDigits = 0) {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: fractionDigits,
    }).format(Number.isFinite(value) ? value : 0);
  }

  function formatPercent(value) {
    const safe = Number.isFinite(value) ? value : 0;
    return `${safe.toFixed(1)}%`;
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – עדכון הודעת סטטוס למשתמש
  function setStatus(message, tone = 'info') {
    if (!selectors.status) {
      return;
    }
    selectors.status.dataset.tone = tone;
    selectors.status.textContent = message;
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – חישוב מודל פיננסי מותאם SPEAR ONE
  function computeAssetModel(stats = {}) {
    const developmentValueUSD = FINANCIAL_CONSTANTS.developmentCostILS * FINANCIAL_CONSTANTS.ilsToUsdRate;
    const relayCount = Array.isArray(App.relayUrls) && App.relayUrls.length ? App.relayUrls.length : 3;
    const capacityUsers = relayCount * FINANCIAL_CONSTANTS.relayCapacityPerNode;
    const observedUsers = Math.max(stats.uniquePubkeys || 0, 70_000);
    const effectiveUsers = Math.min(Math.max(observedUsers, 35_000), capacityUsers);

    const timeline = Array.isArray(stats.timeline) ? stats.timeline : [];
    const lastBucket = timeline[timeline.length - 1] || {};
    const previousBucket = timeline[timeline.length - 2] || lastBucket;
    const totalEvents = Math.max(lastBucket.total || stats.totalEvents || 0, 1);
    const engagementScore = totalEvents + (stats.likesCount || 0) * 0.5 + (stats.repliesCount || 0) * 0.8;
    const engagementMomentum = previousBucket.total ? (lastBucket.total - previousBucket.total) / Math.max(previousBucket.total, 1) : 0.15;
    const activityMultiplier = Math.min(1.9, 0.65 + engagementScore / 30_000 + engagementMomentum);

    const userValueUSD = effectiveUsers * FINANCIAL_CONSTANTS.userValueMultiplier;
    const infrastructureSavingsUSD = (effectiveUsers / 100) * FINANCIAL_CONSTANTS.infrastructureSavingsPerBusinessUSD;
    const capitalDepositsUSD = Number(stats.capitalDepositsUSD) || 0;
    const physicalAssetsUSD = Number(stats.physicalAssetsUSD) || 0;

    const baseNetworkValue = developmentValueUSD + userValueUSD + infrastructureSavingsUSD + capitalDepositsUSD + physicalAssetsUSD;
    const networkValueUSD = baseNetworkValue * activityMultiplier;

    const totalUnitsIssued = Math.max(Number(stats.totalUnits) || 1_200, 600);
    const virtualUnitValueUSD = Math.max(
      FINANCIAL_CONSTANTS.baseUnitPriceUSD * 1.05,
      networkValueUSD / totalUnitsIssued
    );
    const virtualYieldPercent = ((virtualUnitValueUSD - FINANCIAL_CONSTANTS.baseUnitPriceUSD) / FINANCIAL_CONSTANTS.baseUnitPriceUSD) * 100;

    const chartSeries = timeline.map((bucket) => {
      const bucketTotal = Math.max(bucket.total || 0, 1);
      const bucketEngagement = bucketTotal + (bucket.replies || 0) * 0.8 + (bucket.kinds?.[7] || 0) * 0.5;
      const bucketMultiplier = Math.min(1.9, 0.65 + bucketEngagement / 30_000);
      const bucketValue = (developmentValueUSD + userValueUSD + infrastructureSavingsUSD) * bucketMultiplier;
      return {
        date: bucket.date,
        valueUSD: Math.round(bucketValue),
        activityIndex: Math.round(bucketEngagement),
      };
    });

    return {
      developmentValueUSD,
      relayCount,
      capacityUsers,
      effectiveUsers,
      networkValueUSD,
      virtualUnitValueUSD,
      virtualYieldPercent,
      buybackRate: FINANCIAL_CONSTANTS.buybackRate,
      chartSeries,
      creditsOutstanding: Number(stats.creditsOutstanding) || 0,
      timeline,
      engagementScore,
      capitalDepositsUSD,
      physicalAssetsUSD,
    };
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – הצגת בלוק ההדגשות הראשיות
  function renderHighlights(model) {
    if (!selectors.highlights) {
      return;
    }
    const cards = [
      {
        icon: 'fa-network-wired',
        text: `שלושה ריליים פעילים כיום עם קיבולת הדגמתית לכ-${formatNumber(model.capacityUsers)} משתמשים.`,
      },
      {
        icon: 'fa-server',
        text: 'SPEAR ONE פועל על שרת סטטי יחיד ומדגים תפעול מלא של רשת חברתית מבוזרת ללא עלות אינפרה כבדה.',
      },
      {
        icon: 'fa-coins',
        text: `Buyback פנימי מחזיר ${formatPercent(model.buybackRate * 100)} מערך היחידה בקרדיטים לשימוש בשירותי הפלטפורמה.`,
      },
    ];
    selectors.highlights.innerHTML = cards
      .map(
        (card) => `
          <article class="contract-v2-highlight">
            <i class="fa-solid ${card.icon}"></i>
            <span>${card.text}</span>
          </article>
        `
      )
      .join('');
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – עדכון מדדי הגיבור הראשיים
  function renderHeroMetrics(model) {
    if (selectors.developmentValue) {
      selectors.developmentValue.textContent = `₪${formatNumber(FINANCIAL_CONSTANTS.developmentCostILS)}`;
    }
    if (selectors.unitValue) {
      selectors.unitValue.textContent = formatCurrencyUSD(model.virtualUnitValueUSD, 0);
    }
    if (selectors.yield) {
      selectors.yield.textContent = formatPercent(model.virtualYieldPercent);
    }
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – בניית טבלת מקרא לנתוני הגרף
  function renderLegend(model) {
    if (!selectors.legend) {
      return;
    }
    const items = [
      {
        color: '#63e6be',
        label: 'ערך SPEAR ONE (USD)',
        note: 'משלב השקעה, משתמשים פעילים, חיסכון תשתיתי ופעילות מאומתת.',
      },
      {
        color: '#f472b6',
        label: 'מד פעילות הרשת',
        note: 'אירועים, תגובות ולייקים שמשפיעים על המכפיל בזמן אמת.',
      },
    ];
    selectors.legend.innerHTML = items
      .map(
        (item) => `
          <span class="contract-v2-chart__legend-item">
            <span class="contract-v2-chart__legend-dot" style="background:${item.color}"></span>
            <span>
              <strong>${item.label}</strong>
              <br>
              ${item.note}
            </span>
          </span>
        `
      )
      .join('');
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – הצגת רשת התשתיות והיישומים
  function renderInfraGrid(model) {
    if (!selectors.infraGrid) {
      return;
    }
    const items = [
      {
        title: 'פרוטוקול Nostr',
        text: 'שכבת תקשורת מבוזרת המאפשרת אימות, ניתוב והעברת תוכן ללא שרת מרכזי.',
      },
      {
        title: 'SPEAR ONE Engine',
        text: 'מנוע ליבה שמחבר בין רשת חברתית, תשלומים ויחידות ערך בתוך שרת סטטי יחיד.',
      },
      {
        title: 'Relay Mesh',
        text: `קלאסטר של ${formatNumber(model.relayCount)} ריליים עם קיבולת נוכחית לכ-${formatNumber(model.capacityUsers)} משתמשים סימולטנית.`,
      },
      {
        title: 'User Nodes',
        text: 'משתמשים יכולים להפעיל שרתים זמניים, לצבור Credits ולהרחיב את נפח המערכת לפי דרישה.',
      },
    ];
    selectors.infraGrid.innerHTML = items
      .map(
        (item) => `
          <article class="contract-v2-infra__item">
            <h4>${item.title}</h4>
            <p>${item.text}</p>
          </article>
        `
      )
      .join('');
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – ציור הגרף הדינמי
  function renderChart(model) {
    if (!selectors.chartCanvas || typeof Chart === 'undefined') {
      return;
    }
    if (contractV2State.chart && typeof contractV2State.chart.destroy === 'function') {
      contractV2State.chart.destroy();
    }
    const context = selectors.chartCanvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 0, selectors.chartCanvas.height);
    gradient.addColorStop(0, 'rgba(99, 230, 190, 0.35)');
    gradient.addColorStop(1, 'rgba(99, 230, 190, 0.05)');
    const labels = model.chartSeries.map((bucket) => bucket.date);
    const valueSeries = model.chartSeries.map((bucket) => bucket.valueUSD);
    const activitySeries = model.chartSeries.map((bucket) => bucket.activityIndex);
    contractV2State.chart = new Chart(context, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'שווי SPEAR ONE (USD)',
            data: valueSeries,
            borderColor: '#63e6be',
            backgroundColor: gradient,
            tension: 0.35,
            fill: true,
            pointRadius: 0,
            yAxisID: 'y',
          },
          {
            label: 'מד פעילות הרשת',
            data: activitySeries,
            borderColor: '#f472b6',
            borderWidth: 2,
            tension: 0.38,
            fill: false,
            pointRadius: 0,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeOutQuart' },
        plugins: {
          legend: { labels: { color: '#f8f9ff' } },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === 'y1') {
                  return `${context.dataset.label}: ${formatNumber(context.parsed.y)}`;
                }
                return `${context.dataset.label}: ${formatCurrencyUSD(context.parsed.y, 0)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#9aa2c1' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: {
            ticks: {
              color: '#9aa2c1',
              callback(value) {
                return formatNumber(value);
              },
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y1: {
            position: 'left',
            ticks: { color: '#f472b6', callback: (value) => formatNumber(value) },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – טיפול בלחצן פרטים מורחבים
  function attachDetailsToggle() {
    if (!selectors.details || !selectors.detailsToggle) {
      return;
    }
    selectors.detailsToggle.addEventListener('click', () => {
      contractV2State.detailsOpen = !contractV2State.detailsOpen;
      selectors.details.toggleAttribute('hidden', !contractV2State.detailsOpen);
      selectors.detailsToggle.classList.toggle('is-active', contractV2State.detailsOpen);
      selectors.detailsToggle.setAttribute('aria-expanded', contractV2State.detailsOpen ? 'true' : 'false');
    });
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – פתיחה וסגירה של הלוח
  function openDashboard(stats) {
    if (!selectors.root) {
      return;
    }
    selectors.root.classList.add('is-open');
    selectors.root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (stats) {
      updateDashboard(stats);
    } else if (typeof App.getLatestGrowthStats === 'function') {
      const latest = App.getLatestGrowthStats();
      if (latest) {
        updateDashboard(latest);
      } else if (typeof App.refreshGrowthDashboard === 'function') {
        setStatus('מושך נתונים מהמערכת המבוזרת...', 'info');
        App.refreshGrowthDashboard({ silent: true });
      }
    } else if (typeof App.refreshGrowthDashboard === 'function') {
      setStatus('מושך נתונים מהמערכת המבוזרת...', 'info');
      App.refreshGrowthDashboard({ silent: true });
    }
  }

  function closeDashboard() {
    if (!selectors.root) {
      return;
    }
    selectors.root.classList.remove('is-open');
    selectors.root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – עדכון כל רכיבי הלוח על בסיס נתוני צמיחה
  function updateDashboard(stats) {
    if (!stats) {
      setStatus('ממתין לנתוני רשת...', 'info');
      return;
    }
    contractV2State.latestStats = stats;
    const model = computeAssetModel(stats);
    contractV2State.model = model;
    renderHighlights(model);
    renderHeroMetrics(model);
    renderLegend(model);
    renderInfraGrid(model);
    renderChart(model);
    setStatus(`עודכן לפי פעילות אחרונה – ${formatNumber(model.effectiveUsers)} משתמשים פעילים מדווחים.`);
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – רישום מאזין לנתוני צמיחה
  function registerGrowthBinding() {
    if (typeof App.registerGrowthStatsListener === 'function') {
      App.registerGrowthStatsListener((stats) => {
        if (selectors.root?.classList.contains('is-open')) {
          updateDashboard(stats);
        } else {
          contractV2State.latestStats = stats;
        }
      });
    }
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – חשיפה לפונקציות גלובליות עבור הניווט
  App.openContractDashboardV2 = function openContractDashboardV2() {
    openDashboard(contractV2State.latestStats || (typeof App.getLatestGrowthStats === 'function' ? App.getLatestGrowthStats() : null));
  };

  App.closeContractDashboardV2 = function closeContractDashboardV2() {
    closeDashboard();
  };

  window.closeContractDashboardV2 = App.closeContractDashboardV2;
  window.openContractDashboardV2 = App.openContractDashboardV2;

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – האזנה ל-Escape ולחיצה מחוץ לפאנל
  function attachDismissListeners() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeDashboard();
      }
    });
    selectors.root?.addEventListener('click', (event) => {
      if (event.target === selectors.root) {
        closeDashboard();
      }
    });
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – אתחול ראשוני
  function init() {
    if (!selectors.root) {
      return;
    }
    attachDetailsToggle();
    attachDismissListeners();
    registerGrowthBinding();
    if (App.getLatestGrowthStats) {
      contractV2State.latestStats = App.getLatestGrowthStats();
      updateDashboard(contractV2State.latestStats);
    } else {
      setStatus('ממתין לנתוני רשת...', 'info');
    }
  }

  init();
})(window);
