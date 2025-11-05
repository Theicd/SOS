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
    termsList: document.getElementById('contractV2TermsList'),
    forecastCanvas: document.getElementById('contractV2ForecastChart'),
    forecastLegend: document.getElementById('contractV2ForecastLegend'),
    forecastNotes: document.getElementById('contractV2ForecastNotes'),
    investmentInput: document.getElementById('contractV2InvestmentInput'),
    ownershipValue: document.getElementById('contractV2Ownership'),
    buybackValue: document.getElementById('contractV2Buyback'),
    capacityImpact: document.getElementById('contractV2CapacityImpact'),
  };

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – אחסון מצב הלוח ונתונים אחרונים
  const passwordModal = document.getElementById('contractPasswordModal');
  const passwordInput = document.getElementById('contractPasswordInput');
  const passwordError = document.getElementById('contractPasswordError');
  const passwordSubmit = document.getElementById('contractPasswordSubmit');
  const passwordCancel = document.getElementById('contractPasswordCancel');

  const CONTRACT_ACCESS_CODE = '2048';

  const contractV2State = {
    chart: null,
    forecastChart: null,
    latestStats: null,
    model: null,
    detailsOpen: false,
    contractUnlocked: false,
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
    targetNetworkValueUSD: 50_000_000, // יעד שווי לטכנולוגיה המבוזרת
    targetMonthlyRevenueUSD: 25_000,
    targetUserCount: 1_000_000,
  };

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – תנאי חוזה בסיסיים המוצגים ברשימה
  const DEFAULT_TERMS = [
    { title: 'זכויות בטכנולוגיה', text: 'כל יחידה מעניקה חלק יחסי בטכנולוגיית SPEAR ONE ובקניין הרוחני הנלווה לה.' },
    { title: 'התנהלות מבוזרת', text: 'אין שרת מרכזי או בסיס נתונים – השליטה נשארת בידי המשתמשים ובעלי היחידות.' },
    { title: 'Buyback מובנה', text: '80% מערך היחידה מומר לקרדיטים פנימיים לשימוש בפלטפורמה (קידום, אחסון, שירותים).' },
    { title: 'שקיפות בזמן אמת', text: 'גרף השווי מחובר לפעילות הרשת (Relays, משתמשים, מעורבות) ומתעדכן אוטומטית.' },
    { title: 'הרחבה מיידית', text: 'כל השקעה מתורגמת לפתיחת Relay או הרחבת קיבולת – ללא הוצאות ענן נוספות.' },
  ];

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
        text: `SPEAR ONE פועל על שרת סטטי יחיד ומדגים תפעול מלא של רשת מבוזרת בשווי של ${formatCurrencyUSD(model.networkValueUSD, 0)}.`,
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

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – הצגת תנאי החוזה
  function renderTerms() {
    if (!selectors.termsList) {
      return;
    }
    selectors.termsList.innerHTML = DEFAULT_TERMS.map((term) => `<li><strong>${term.title}:</strong> ${term.text}</li>`).join('');
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

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – בניית נתונים לתחזית צמיחה
  function buildForecastData(stats, model) {
    const timeline = Array.isArray(stats?.timeline) ? stats.timeline : [];
    if (!timeline.length || typeof Chart === 'undefined') {
      return null;
    }
    const baseActivity = timeline.map((bucket) => Math.max(bucket.total || 0, 0));
    const labels = timeline.map((bucket) => bucket.date);
    const lastActivity = baseActivity[baseActivity.length - 1] || 1;
    const firstActivity = baseActivity[0] || lastActivity;
    const rawGrowth = baseActivity.length > 1 ? (lastActivity - firstActivity) / Math.max(firstActivity, 1) / (baseActivity.length - 1) : 0.15;
    const monthlyGrowth = Math.min(Math.max(rawGrowth, 0.08), 0.3);
    const optimisticGrowth = Math.min(monthlyGrowth + 0.07, 0.38);
    const conservativeGrowth = Math.max(monthlyGrowth - 0.04, 0.06);
    const months = 12;
    const activityOptimistic = [];
    const activityConservative = [];
    const valueOptimistic = [];
    const valueConservative = [];
    const baseValue = model?.networkValueUSD || 1_500_000;
    const monthlyValueGrowth = Math.min(Math.max(monthlyGrowth + 0.04, 0.1), 0.35);
    const optimisticValueGrowth = Math.min(monthlyValueGrowth + 0.06, 0.42);
    const conservativeValueGrowth = Math.max(monthlyValueGrowth - 0.05, 0.08);

    for (let i = 1; i <= months; i += 1) {
      activityOptimistic.push(Math.round(lastActivity * Math.pow(1 + optimisticGrowth, i)));
      activityConservative.push(Math.round(lastActivity * Math.pow(1 + conservativeGrowth, i)));
      valueOptimistic.push(Math.round(baseValue * Math.pow(1 + optimisticValueGrowth, i)));
      valueConservative.push(Math.round(baseValue * Math.pow(1 + conservativeValueGrowth, i)));
    }

    const forecastLabels = [];
    for (let i = 1; i <= months; i += 1) {
      const date = new Date();
      date.setMonth(date.getMonth() + i);
      forecastLabels.push(date.toISOString().split('T')[0]);
    }

    return {
      labels: [...labels, ...forecastLabels],
      activityBase: [...baseActivity, ...Array(months).fill(lastActivity)],
      activityOptimistic: [...baseActivity.slice(-3), ...activityOptimistic],
      activityConservative: [...baseActivity.slice(-3), ...activityConservative],
      valueOptimistic: [...Array(baseActivity.length).fill(baseValue), ...valueOptimistic],
      valueConservative: [...Array(baseActivity.length).fill(baseValue), ...valueConservative],
    };
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – ציור גרף התחזית
  function renderForecast(stats, model) {
    if (!selectors.forecastCanvas) {
      return;
    }
    const data = buildForecastData(stats, model);
    if (!data) {
      selectors.forecastNotes && (selectors.forecastNotes.textContent = 'ממתין למדדי פעילות כדי לחשב תחזית.');
      return;
    }
    if (contractV2State.forecastChart?.destroy) {
      contractV2State.forecastChart.destroy();
    }
    const ctx = selectors.forecastCanvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, selectors.forecastCanvas.height);
    gradient.addColorStop(0, 'rgba(111, 125, 255, 0.28)');
    gradient.addColorStop(1, 'rgba(111, 125, 255, 0.05)');
    contractV2State.forecastChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          { label: 'פעילות ממוצעת', data: data.activityBase, borderColor: '#6f7dff', backgroundColor: gradient, fill: true, borderWidth: 2, tension: 0.35, yAxisID: 'activity' },
          { label: 'פעילות – תרחיש אופטימי', data: data.activityOptimistic, borderColor: '#63e6be', borderDash: [6, 4], fill: false, tension: 0.32, yAxisID: 'activity' },
          { label: 'פעילות – תרחיש שמרני', data: data.activityConservative, borderColor: '#ffb347', borderDash: [4, 6], fill: false, tension: 0.32, yAxisID: 'activity' },
          { label: 'שווי רשת – אופטימי (USD)', data: data.valueOptimistic, borderColor: '#f472b6', fill: false, tension: 0.28, yAxisID: 'value' },
          { label: 'שווי רשת – שמרני (USD)', data: data.valueConservative, borderColor: '#9f7aea', fill: false, borderDash: [2, 3], tension: 0.28, yAxisID: 'value' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#f8f9ff' } },
          tooltip: {
            callbacks: {
              label(context) {
                if (context.dataset.yAxisID === 'value') {
                  return `${context.dataset.label}: ${formatCurrencyUSD(context.parsed.y, 0)}`;
                }
                return `${context.dataset.label}: ${formatNumber(context.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#9aa2c1' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          activity: { position: 'left', ticks: { color: '#9aa2c1', callback: (value) => formatNumber(value) }, grid: { color: 'rgba(255,255,255,0.05)' } },
          value: { position: 'right', ticks: { color: '#f8f9ff', callback: (value) => formatCurrencyUSD(value, 0) }, grid: { drawOnChartArea: false } },
        },
      },
    });

    if (selectors.forecastLegend) {
      selectors.forecastLegend.innerHTML = `
        <span><i class="fa-solid fa-circle" style="color:#6f7dff"></i> פעילות ממוצעת</span>
        <span><i class="fa-solid fa-circle" style="color:#63e6be"></i> תרחיש פעילות אופטימי</span>
        <span><i class="fa-solid fa-circle" style="color:#ffb347"></i> תרחיש פעילות שמרני</span>
        <span><i class="fa-solid fa-circle" style="color:#f472b6"></i> שווי רשת אופטימי</span>
        <span><i class="fa-solid fa-circle" style="color:#9f7aea"></i> שווי רשת שמרני</span>
      `;
    }

    if (selectors.forecastNotes) {
      selectors.forecastNotes.innerHTML = `
        <span><i class="fa-solid fa-chart-line"></i> הנתונים נשענים על פעילות Relay ומעורבות בפוסטים בזמן אמת.</span>
        <span><i class="fa-solid fa-bolt"></i> תרחיש אופטימי כולל שילוב שותפויות ושדרוגי מולטימדיה.</span>
        <span><i class="fa-solid fa-shield"></i> תרחיש שמרני מניח צמיחה אורגנית בלבד ותחזוקת קיבולת נוכחית.</span>
      `;
    }
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – עדכון מחשבון ההשקעה
  function updateCalculator(amount) {
    if (!selectors.ownershipValue || !contractV2State.model) {
      return;
    }
    const safeAmount = Math.max(Number(amount) || FINANCIAL_CONSTANTS.baseUnitPriceUSD, FINANCIAL_CONSTANTS.baseUnitPriceUSD);
    const model = contractV2State.model;
    const ownership = Math.min((safeAmount / Math.max(model.networkValueUSD, FINANCIAL_CONSTANTS.targetNetworkValueUSD)) * 100, 100);
    const buybackUSD = safeAmount * FINANCIAL_CONSTANTS.buybackRate;
    const addedCapacity = Math.round((safeAmount / FINANCIAL_CONSTANTS.baseUnitPriceUSD) * (FINANCIAL_CONSTANTS.relayCapacityPerNode / 50));
    selectors.ownershipValue.textContent = `${ownership.toFixed(4)}%`;
    selectors.buybackValue.textContent = formatCurrencyUSD(buybackUSD, 0);
    selectors.capacityImpact.textContent = formatNumber(addedCapacity);
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – חיבור קלט המחשבון
  function attachCalculator() {
    if (!selectors.investmentInput) {
      return;
    }
    selectors.investmentInput.addEventListener('input', (event) => {
      updateCalculator(event.target.value);
    });
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – חיבור כפתורי גלילה פנימיים
  function attachScrollTargets() {
    selectors.panel?.querySelectorAll('[data-scroll-target]')?.forEach((button) => {
      button.addEventListener('click', () => {
        const targetId = button.getAttribute('data-scroll-target');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  // חלק חוזה חכם 2 (contract-dashboard-v2.js) – פתיחת דף/פאנל רכישת אופציות של SPEAR ONE
  function openOptionPurchase() {
    if (typeof window.openOptionsLanding === 'function') {
      window.openOptionsLanding();
      return;
    }

    const purchaseHandler = typeof window.purchaseOption === 'function' ? window.purchaseOption : null;
    if (typeof purchaseHandler === 'function') {
      purchaseHandler('custom', FINANCIAL_CONSTANTS.baseUnitPriceUSD);
      return;
    }

    const optionsPanel = document.getElementById('optionsPanel');
    if (optionsPanel) {
      optionsPanel.hidden = false;
      optionsPanel.classList.add('is-open');
      optionsPanel.setAttribute('aria-hidden', 'false');
      return;
    }

    alert('מסך הרכישה ייפתח בגרסת הנחיתה. אם אינך מנותב אוטומטית, בקר ב-options-landing.html');
    window.location.href = './options-landing.html';
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
    renderTerms();
    renderForecast(stats, model);
    updateCalculator(selectors.investmentInput?.value || FINANCIAL_CONSTANTS.baseUnitPriceUSD);
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
    if (contractV2State.contractUnlocked) {
      openDashboard(contractV2State.latestStats || (typeof App.getLatestGrowthStats === 'function' ? App.getLatestGrowthStats() : null));
      return;
    }
    showPasswordModal();
  };

  App.closeContractDashboardV2 = function closeContractDashboardV2() {
    closeDashboard();
  };

  App.openOptionPurchase = openOptionPurchase;
  window.openOptionPurchase = openOptionPurchase;

  window.closeContractDashboardV2 = App.closeContractDashboardV2;
  window.openContractDashboardV2 = App.openContractDashboardV2;

  function showPasswordModal() {
    if (!passwordModal) {
      return;
    }
    passwordModal.hidden = false;
    passwordModal.setAttribute('aria-hidden', 'false');
    passwordInput?.focus();
    passwordInput && (passwordInput.value = '');
    if (passwordError) {
      passwordError.hidden = true;
    }
    document.body.style.overflow = 'hidden';
  }

  function hidePasswordModal() {
    if (!passwordModal) {
      return;
    }
    passwordModal.hidden = true;
    passwordModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function handlePasswordSubmit() {
    if (!passwordInput) {
      return;
    }
    const value = (passwordInput.value || '').trim();
    if (value === CONTRACT_ACCESS_CODE) {
      contractV2State.contractUnlocked = true;
      hidePasswordModal();
      openDashboard(contractV2State.latestStats || (typeof App.getLatestGrowthStats === 'function' ? App.getLatestGrowthStats() : null));
      return;
    }
    if (passwordError) {
      passwordError.hidden = false;
    }
    passwordInput.focus();
    passwordInput.select();
  }

  function attachPasswordModalHandlers() {
    if (!passwordModal) {
      return;
    }
    passwordSubmit?.addEventListener('click', handlePasswordSubmit);
    passwordCancel?.addEventListener('click', () => {
      hidePasswordModal();
    });
    passwordInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handlePasswordSubmit();
      }
      if (event.key === 'Escape') {
        hidePasswordModal();
      }
    });
    passwordModal.addEventListener('click', (event) => {
      if (event.target === passwordModal) {
        hidePasswordModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !passwordModal.hidden && !contractV2State.contractUnlocked) {
        hidePasswordModal();
      }
    });
  }

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
    attachScrollTargets();
    attachCalculator();
    attachDismissListeners();
    attachPasswordModalHandlers();
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
