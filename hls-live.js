// חלק ערוץ חי HLS (hls-live.js) – זיהוי, בדיקה, ניגון וטעינת רקע ללינקי m3u8 | HYPER CORE TECH
(function initHlsLive(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const healthCache = new Map(); // url -> { ok, checkedAt, reason, meta }
  const HEALTH_TTL_MS = 5 * 60 * 1000;
  const hlsInstances = new WeakMap(); // videoEl -> Hls instance
  const epgCache = new Map(); // guideUrl -> { fetchedAt, programmes: Map(channelId -> [{start,stop,title}]) }
  const EPG_TTL_MS = 30 * 60 * 1000;

  const HLS_URL_RE = /\.m3u8(\?|#|$)/i;
  const HLS_HINT_RE = /(mediatailor|amagi\.tv|\/hls\/|\/playlist\.m3u8|mpegurl|LINEAR-)/i;

  // מיפוי רמזים לערוצים ישראליים → מקור EPG של iptv-org | HYPER CORE TECH
  const IL_EPG_GUIDES = [
    {
      guide: 'https://iptv-org.github.io/epg/guides/il/mako.co.il.epg.xml',
      match: /(קשת|keshet|mako|ערוץ\s*12|channel\s*12)/i,
      channelIds: ['Keshet12.il', 'Channel12.il', 'keshet12.il'],
      displayName: 'קשת 12',
    },
    {
      guide: 'https://iptv-org.github.io/epg/guides/il/kan.org.il.epg.xml',
      match: /(כאן\s*11|kan\s*11|makan|ערוץ\s*11|channel\s*11)/i,
      channelIds: ['Kan11.il', 'Makan33.il', 'KanEducational.il', 'kan11.il'],
      displayName: 'כאן 11',
    },
    {
      guide: 'https://iptv-org.github.io/epg/guides/il/i24news.tv.epg.xml',
      match: /i24/i,
      channelIds: ['i24NewsEnglish.il', 'i24NewsFrench.il', 'i24NewsArabic.il', 'i24news.tv'],
      displayName: 'i24NEWS',
    },
    {
      guide: 'https://iptv-org.github.io/epg/guides/il/9tv.co.il.epg.xml',
      match: /(ערוץ\s*9|channel\s*9|9tv)/i,
      channelIds: ['Channel9.il', '9tv.co.il'],
      displayName: 'ערוץ 9',
    },
  ];

  function decodeSafe(str) {
    try { return decodeURIComponent(String(str || '')); } catch (_) { return String(str || ''); }
  }

  function stripStreamQualityLabel(raw) {
    return String(raw || '')
      .replace(/\s*[\(\[\{]\s*(?:\d{3,4}\s*[pi]|4k|8k|uhd|fhd|hd|sd|hq)\s*[\)\]\}]/gi, '')
      .replace(/\s*[-–—]\s*(?:\d{3,4}\s*[pi]|4k|8k|uhd|fhd|hd|sd)\s*$/i, '')
      .replace(/\s+(?:\d{3,4}p|4k|8k)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isJunkChannelLabel(raw) {
    const t = String(raw || '').trim().toLowerCase();
    if (!t) return true;
    if (/^(english|hebrew|arabic|spanish|french|german|russian|portuguese|italian|chinese|japanese|korean|eng|heb|ara|spa|fre|deu|ger|rus|por|ita|chi|jpn|kor|und|unknown|null|undefined)$/i.test(t)) return true;
    if (/^(audio|video|subtitle|subtitles|subs|default|none|auto|track|group|stereo|aac|mp4a)$/i.test(t)) return true;
    if (/^(index|playlist|master|live|hls|chunk|segment|manifest|livehls|livx|cdn|abr|stream|streams|media|play|video|oil)$/i.test(t)) return true;
    if (/\.livx$/i.test(t) || /\.(m3u8|ts|mpd|mp4)$/i.test(t)) return true;
    if (/^(kancdn-live|medonecdn|cdn-redge)$/i.test(t)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(t)) return true;
    if (/^[a-f0-9]{24,}$/i.test(t)) return true;
    return false;
  }

  function cleanMetaLabel(raw) {
    let s = decodeSafe(raw).replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = stripStreamQualityLabel(s);
    if (!s || s.length < 2 || s.length > 80) return '';
    if (isJunkChannelLabel(s)) return '';
    if (/^\d+$/.test(s)) return '';
    return s;
  }

  function formatChannelDisplayName(raw) {
    return cleanMetaLabel(raw);
  }

  function extractChannelNameFromUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const qKeys = ['channel', 'channelName', 'name', 'title', 'ch', 'station', 'tvg-name'];
      for (let i = 0; i < qKeys.length; i += 1) {
        const v = cleanMetaLabel(u.searchParams.get(qKeys[i]) || '');
        if (v) return v;
      }
      const parts = u.pathname.split('/').filter(Boolean);
      // מחפשים מקטע משמעותי לפני הקובץ — מדלגים על מקטעי CDN/טכניים | HYPER CORE TECH
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const raw = decodeSafe(parts[j]);
        if (/\.m3u8$/i.test(raw)) continue;
        if (/\./.test(raw) && !/\s/.test(raw)) continue; // live.livx / file-like
        const p = cleanMetaLabel(raw);
        if (!p) continue;
        if (/^(hls|live|stream|streams|playlist|play|media|cdn|video|livehls|oil)$/i.test(p)) continue;
        if (p.length >= 2) return p;
      }
    } catch (_) {}
    return '';
  }

  function extractMetaFromPlaylist(text) {
    const meta = { channelName: '', programTitle: '' };
    if (!text) return meta;
    const sessionTitle = text.match(/#EXT-X-SESSION-DATA:[^\n]*DATA-ID="[^"]*title[^"]*"[^\n]*VALUE="([^"]+)"/i)
      || text.match(/#EXT-X-SESSION-DATA:[^\n]*VALUE="([^"]+)"[^\n]*DATA-ID="[^"]*title[^"]*"/i);
    if (sessionTitle && sessionTitle[1]) meta.channelName = cleanMetaLabel(sessionTitle[1]);

    // NAME מ־EXT-X-MEDIA הוא לרוב שפת אודיו (english) — לא שם ערוץ | HYPER CORE TECH
    const mediaName = text.match(/#EXT-X-MEDIA:[^\n]*NAME="([^"]+)"/i);
    if (!meta.channelName && mediaName && mediaName[1]) {
      const mediaLabel = cleanMetaLabel(mediaName[1]);
      if (mediaLabel && !isJunkChannelLabel(mediaName[1])) meta.channelName = mediaLabel;
    }

    const extinf = text.match(/#EXTINF:[^\n]*,\s*([^\n]+)/i);
    if (extinf && extinf[1]) {
      const label = cleanMetaLabel(extinf[1].split(/tvg-name=/i)[0]);
      if (label) {
        if (!meta.channelName) meta.channelName = label;
        else if (label !== meta.channelName) meta.programTitle = label;
      }
    }

    const tvgName = text.match(/tvg-name="([^"]+)"/i);
    if (tvgName && tvgName[1]) meta.channelName = cleanMetaLabel(tvgName[1]) || meta.channelName;

    if (meta.channelName && isJunkChannelLabel(meta.channelName)) meta.channelName = '';
    if (meta.programTitle && isJunkChannelLabel(meta.programTitle)) meta.programTitle = '';
    return meta;
  }

  function extractChannelNameFromContent(content) {
    if (!content) return '';
    const lines = String(content).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^https?:\/\//i.test(line)) continue;
      if (isHlsLiveUrl(line)) continue;
      const cleaned = cleanMetaLabel(line.replace(/^#\s*/, ''));
      if (cleaned) return cleaned;
    }
    return '';
  }

  function resolveLiveMeta(options = {}) {
    const locked = formatChannelDisplayName(options.lockedName || '');
    const fromContent = extractChannelNameFromContent(options.content || '');
    const fromPlaylist = options.playlistMeta || {};
    const playlistName = formatChannelDisplayName(fromPlaylist.channelName || '');
    const fromUrl = extractChannelNameFromUrl(options.url || '');
    // שם ידוע מהקטלוג/כיתוב תמיד מנצח — לא נדרסים ע"י live.livx / english | HYPER CORE TECH
    const channelName = locked || fromContent || playlistName || fromUrl || '';
    const programTitle = formatChannelDisplayName(fromPlaylist.programTitle || '');
    return {
      channelName,
      programTitle,
      source: locked || fromContent
        ? 'content'
        : (playlistName ? 'playlist' : (fromUrl ? 'url' : '')),
    };
  }

  function ensureLiveMetaOverlay(mediaDiv) {
    if (!mediaDiv) return null;
    ensureLiveBadge(mediaDiv);
    const top = ensureLiveTopbar(mediaDiv);
    let box = top.querySelector('.videos-live-meta') || mediaDiv.querySelector('.videos-live-meta');
    if (!box) {
      box = document.createElement('div');
      box.className = 'videos-live-meta';
      box.hidden = true;
      box.innerHTML = [
        '<div class="videos-live-meta__channel" data-live-channel></div>',
        '<div class="videos-live-meta__program" data-live-program></div>',
      ].join('');
    }
    if (box.parentElement !== top) top.appendChild(box);
    return box;
  }

  function setLiveMetaOverlay(mediaDiv, meta) {
    if (!mediaDiv) return;
    const box = ensureLiveMetaOverlay(mediaDiv);
    if (!box) return;
    const locked = mediaDiv.dataset.liveChannelLocked === '1'
      ? formatChannelDisplayName(mediaDiv.dataset.liveCaption || '')
      : '';
    let channel = locked || formatChannelDisplayName((meta && meta.channelName) || '');
    if (isJunkChannelLabel(channel)) channel = locked || '';
    let program = formatChannelDisplayName((meta && meta.programTitle) || '');
    if (isJunkChannelLabel(program) || (channel && program.toLowerCase() === channel.toLowerCase())) {
      program = '';
    }
    const channelEl = box.querySelector('[data-live-channel]');
    const programEl = box.querySelector('[data-live-program]');
    // לא מחליפים שם טוב בזבל / ריק | HYPER CORE TECH
    if (!channel && channelEl && channelEl.textContent && !isJunkChannelLabel(channelEl.textContent)) {
      channel = channelEl.textContent.trim();
    }
    if (channelEl) channelEl.textContent = channel;
    if (programEl) {
      programEl.textContent = program ? ('עכשיו: ' + program) : '';
      programEl.hidden = !program;
    }
    box.hidden = !(channel || program);
    box.classList.toggle('videos-live-meta--channel-only', !!(channel && !program));
    if (channel) mediaDiv.dataset.liveChannel = channel;
    if (program) mediaDiv.dataset.liveProgram = program;
  }

  function xmltvToDate(raw) {
    // 20240101120000 +0300 / 20240101120000
    const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  async function loadEpgGuide(guideUrl) {
    const cached = epgCache.get(guideUrl);
    if (cached && Date.now() - cached.fetchedAt < EPG_TTL_MS) return cached;
    const res = await fetch(guideUrl, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) throw new Error('epg-http-' + res.status);
    const xmlText = await res.text();
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const programmes = new Map();
    doc.querySelectorAll('programme').forEach((node) => {
      const ch = node.getAttribute('channel') || '';
      const start = xmltvToDate(node.getAttribute('start'));
      const stop = xmltvToDate(node.getAttribute('stop'));
      const title = (node.querySelector('title') && node.querySelector('title').textContent) || '';
      if (!ch || !start || !stop || !title) return;
      if (!programmes.has(ch)) programmes.set(ch, []);
      programmes.get(ch).push({ start, stop, title: title.trim() });
    });
    const entry = { fetchedAt: Date.now(), programmes };
    epgCache.set(guideUrl, entry);
    return entry;
  }

  function progressFromWindow(start, stop, now = new Date()) {
    if (!(start instanceof Date) || !(stop instanceof Date)) {
      return { progressPct: 0, minutesLeft: 0, durationMinutes: 0 };
    }
    const span = stop.getTime() - start.getTime();
    const elapsed = now.getTime() - start.getTime();
    const progressPct = span > 0 ? Math.min(100, Math.max(0, (elapsed / span) * 100)) : 0;
    const minutesLeft = Math.max(0, Math.round((stop.getTime() - now.getTime()) / 60000));
    const durationMinutes = Math.max(1, Math.round(span / 60000));
    return { progressPct, minutesLeft, durationMinutes };
  }

  function formatOsdClock(d = new Date()) {
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function formatOsdDate(d = new Date()) {
    try {
      return new Intl.DateTimeFormat('he-IL', {
        weekday: 'short',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Jerusalem',
      }).format(d);
    } catch (_) {
      return d.toLocaleDateString('he-IL');
    }
  }

  function formatOsdTime(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function findNowInProgrammeList(list, nowMs = Date.now()) {
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      if (p.start.getTime() <= nowMs && nowMs < p.stop.getTime()) return p;
    }
    return null;
  }

  async function fetchNowPlayingByTvgId(tvgId) {
    const raw = String(tvgId || '').trim();
    if (!raw) return null;
    const base = raw.includes('@') ? raw.split('@')[0].trim() : raw;
    const keys = [raw, base, base.toLowerCase(), raw.toLowerCase()];
    for (let i = 0; i < IL_EPG_GUIDES.length; i += 1) {
      const g = IL_EPG_GUIDES[i];
      try {
        const guide = await loadEpgGuide(g.guide);
        const idList = Array.from(new Set([...(g.channelIds || []), ...keys]));
        for (let j = 0; j < idList.length; j += 1) {
          const list = guide.programmes.get(idList[j])
            || guide.programmes.get(String(idList[j]).toLowerCase())
            || [];
          const hit = findNowInProgrammeList(list);
          if (hit) {
            return {
              channelName: g.displayName,
              programTitle: hit.title,
              start: hit.start,
              stop: hit.stop,
              source: 'epg-tvg',
            };
          }
        }
        // התאמה רכה לפי מפתחות ב־XML | HYPER CORE TECH
        for (const [chId, list] of guide.programmes.entries()) {
          if (!keys.some((k) => String(chId).toLowerCase() === String(k).toLowerCase())) continue;
          const hit = findNowInProgrammeList(list);
          if (hit) {
            return {
              channelName: g.displayName,
              programTitle: hit.title,
              start: hit.start,
              stop: hit.stop,
              source: 'epg-tvg',
            };
          }
        }
      } catch (_) {}
    }
    return null;
  }

  async function fetchNowPlayingForHints(hintText) {
    const blob = String(hintText || '');
    if (!blob) return null;
    for (let i = 0; i < IL_EPG_GUIDES.length; i += 1) {
      const g = IL_EPG_GUIDES[i];
      if (!g.match.test(blob)) continue;
      try {
        const guide = await loadEpgGuide(g.guide);
        const ids = g.channelIds;
        for (let j = 0; j < ids.length; j += 1) {
          const list = guide.programmes.get(ids[j]) || [];
          const hit = findNowInProgrammeList(list);
          if (hit) {
            return {
              channelName: g.displayName,
              programTitle: hit.title,
              start: hit.start,
              stop: hit.stop,
              source: 'epg',
            };
          }
        }
        return { channelName: g.displayName, programTitle: '', start: null, stop: null, source: 'epg-name' };
      } catch (_) {}
    }
    return null;
  }

  async function resolveNowPlayingForMedia(mediaDiv, options = {}) {
    const tvgId = options.tvgId || mediaDiv.dataset.liveTvgId || '';
    const content = options.content != null ? options.content : (mediaDiv.dataset.liveCaption || '');
    const channel = mediaDiv.dataset.liveChannel || content || '';
    const url = options.url || mediaDiv.dataset.liveUrl || '';
    let epg = null;
    if (tvgId) {
      try { epg = await fetchNowPlayingByTvgId(tvgId); } catch (_) {}
    }
    if (!epg || !epg.programTitle) {
      const hint = [channel, content, tvgId, url].filter(Boolean).join(' ');
      try {
        const byHint = await fetchNowPlayingForHints(hint);
        if (byHint && (byHint.programTitle || !epg)) epg = byHint;
      } catch (_) {}
    }
    return epg;
  }

  async function enrichLiveCardMeta(mediaDiv, options = {}) {
    if (!mediaDiv) return null;
    const url = options.url || mediaDiv.dataset.liveUrl || mediaDiv.dataset.videoUrl || '';
    const content = options.content != null ? options.content : (mediaDiv.dataset.liveCaption || '');
    if (options.content != null && String(options.content || '').trim()) {
      mediaDiv.dataset.liveCaption = String(options.content || '').trim();
    }
    const lockedName = mediaDiv.dataset.liveChannelLocked === '1'
      ? (mediaDiv.dataset.liveCaption || content || '')
      : (options.lockedName || '');
    let playlistMeta = options.playlistMeta || null;
    if (!playlistMeta && options.playlistText) {
      playlistMeta = extractMetaFromPlaylist(options.playlistText);
    }
    let meta = resolveLiveMeta({ url, content, playlistMeta, lockedName });

    try {
      const epg = await resolveNowPlayingForMedia(mediaDiv, {
        url,
        content,
        tvgId: mediaDiv.dataset.liveTvgId || options.tvgId || '',
      });
      if (epg) {
        meta = {
          channelName: meta.channelName || epg.channelName,
          programTitle: epg.programTitle || meta.programTitle,
          source: epg.source || meta.source,
          start: epg.start || null,
          stop: epg.stop || null,
        };
      }
    } catch (_) {}

    if (lockedName) {
      const lockedClean = formatChannelDisplayName(lockedName);
      if (lockedClean) meta.channelName = lockedClean;
    }

    if (meta.start instanceof Date) mediaDiv.dataset.liveProgramStart = meta.start.toISOString();
    if (meta.stop instanceof Date) mediaDiv.dataset.liveProgramStop = meta.stop.toISOString();
    if (meta.programTitle) mediaDiv.dataset.liveProgram = meta.programTitle;

    setLiveMetaOverlay(mediaDiv, meta);
    if (mediaDiv.classList.contains('is-live-fullscreen')) {
      updateCableOsd(mediaDiv);
    }
    return meta;
  }

  function isHlsLiveUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return HLS_URL_RE.test(trimmed) || HLS_HINT_RE.test(trimmed);
  }

  function extractHlsUrlFromText(text) {
    if (!text) return '';
    const lines = String(text).split(/\s+/);
    for (let i = 0; i < lines.length; i += 1) {
      const token = String(lines[i] || '').trim();
      if (isHlsLiveUrl(token)) return token;
    }
    const match = String(text).match(/https?:\/\/[^\s]+/gi);
    if (!match) return '';
    for (let j = 0; j < match.length; j += 1) {
      if (isHlsLiveUrl(match[j])) return match[j];
    }
    return '';
  }

  function canNativeHls(videoEl) {
    try {
      return !!(videoEl && videoEl.canPlayType && videoEl.canPlayType('application/vnd.apple.mpegurl'));
    } catch (_) {
      return false;
    }
  }

  function getCachedHealth(url) {
    const entry = healthCache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > HEALTH_TTL_MS) {
      healthCache.delete(url);
      return null;
    }
    return entry;
  }

  async function checkHlsHealth(url, options = {}) {
    const force = !!options.force;
    if (!url) return { ok: false, reason: 'empty', checkedAt: Date.now() };
    if (!force) {
      const cached = getCachedHealth(url);
      if (cached) return cached;
    }

    let result = { ok: false, reason: 'unknown', checkedAt: Date.now() };
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => {
        try { controller.abort(); } catch (_) {}
      }, options.timeoutMs || 8000) : null;

      const res = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);

      if (!res.ok) {
        result = { ok: false, reason: 'http-' + res.status, checkedAt: Date.now() };
      } else {
        const text = await res.text();
        if (/#EXTM3U/i.test(text)) {
          result = {
            ok: true,
            reason: 'playlist',
            checkedAt: Date.now(),
            playlistMeta: extractMetaFromPlaylist(text),
          };
        } else {
          result = { ok: false, reason: 'not-m3u8', checkedAt: Date.now() };
        }
      }
    } catch (err) {
      // CORS / network — ננסה לנגן בכל זאת (חלק מה־CDN מאפשרים ל־MSE)
      result = {
        ok: true,
        unverified: true,
        reason: (err && err.name === 'AbortError') ? 'timeout' : 'cors-or-network',
        checkedAt: Date.now(),
      };
    }

    healthCache.set(url, result);
    return result;
  }

  function destroyHls(videoEl) {
    if (!videoEl) return;
    const inst = hlsInstances.get(videoEl);
    if (inst) {
      try { inst.destroy(); } catch (_) {}
      hlsInstances.delete(videoEl);
    }
    try {
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (_) {}
  }

  function ensureLiveTopbar(mediaDiv) {
    if (!mediaDiv) return null;
    let top = mediaDiv.querySelector('.videos-live-topbar');
    if (!top) {
      top = document.createElement('div');
      top.className = 'videos-live-topbar';
      mediaDiv.appendChild(top);
    }
    return top;
  }

  function ensureLiveBadge(mediaDiv) {
    if (!mediaDiv) return null;
    const top = ensureLiveTopbar(mediaDiv);
    let badge = top.querySelector('.videos-live-badge') || mediaDiv.querySelector('.videos-live-badge');
    if (badge) {
      if (badge.parentElement !== top) top.insertBefore(badge, top.firstChild);
      ensureFullscreenControls(mediaDiv);
      return badge;
    }
    badge = document.createElement('div');
    badge.className = 'videos-live-badge';
    badge.setAttribute('aria-label', 'שידור חי IPTV');
    badge.innerHTML = '<span class="videos-live-badge__dot" aria-hidden="true"></span><span class="videos-live-badge__text">LIVE IPTV</span>';
    top.insertBefore(badge, top.firstChild);
    ensureFullscreenControls(mediaDiv);
    return badge;
  }

  function ensureTuningOverlay(mediaDiv) {
    if (!mediaDiv) return null;
    let overlay = mediaDiv.querySelector('.videos-live-tuning');
    // אם יש overlay ישן בלי canvas שלג – בונים מחדש | HYPER CORE TECH
    if (overlay && !overlay.querySelector('canvas.videos-live-tuning__snow')) {
      stopTuningFx(overlay);
      overlay.remove();
      overlay = null;
    }
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'videos-live-tuning';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<canvas class="videos-live-tuning__snow" aria-hidden="true"></canvas>',
      '<div class="videos-live-tuning__vignette" aria-hidden="true"></div>',
      '<div class="videos-live-tuning__center">',
      '  <div class="videos-live-tuning__label">מחפש ערוץ...</div>',
      '  <div class="videos-live-tuning__meter" aria-hidden="true">',
      '    <div class="videos-live-tuning__meter-track">',
      '      <div class="videos-live-tuning__meter-fill" data-live-meter></div>',
      '    </div>',
      '  </div>',
      '  <div class="videos-live-tuning__pct"><span data-live-pct>0</span>%</div>',
      '</div>',
    ].join('');
    mediaDiv.appendChild(overlay);
    return overlay;
  }

  function setTuningVisible(mediaDiv, visible, label) {
    const overlay = ensureTuningOverlay(mediaDiv);
    if (!overlay) return;
    overlay.hidden = !visible;
    mediaDiv.classList.toggle('is-live-tuning', !!visible);
    if (label) {
      const labelEl = overlay.querySelector('.videos-live-tuning__label');
      if (labelEl) labelEl.textContent = label;
    }
    if (visible) {
      startTuningFx(overlay);
    } else {
      stopTuningFx(overlay);
      const fill = overlay.querySelector('[data-live-meter]');
      const pct = overlay.querySelector('[data-live-pct]');
      if (fill) fill.style.width = '100%';
      if (pct) pct.textContent = '100';
    }
  }

  // שלג TV אנלוגי – רעש אפור אקראי (לא נקודות CSS) | HYPER CORE TECH
  function drawTvStatic(canvas) {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(160, Math.floor((parent && parent.clientWidth) || window.innerWidth || 320));
    const h = Math.max(160, Math.floor((parent && parent.clientHeight) || window.innerHeight || 480));
    const cw = Math.min(220, Math.max(120, Math.floor(w / 3)));
    const ch = Math.min(400, Math.max(180, Math.floor(h / 3)));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const imageData = ctx.createImageData(cw, ch);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 220) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function startTuningFx(overlay) {
    if (!overlay) return;
    stopTuningFx(overlay);
    const fill = overlay.querySelector('[data-live-meter]');
    const pctEl = overlay.querySelector('[data-live-pct]');
    const snow = overlay.querySelector('.videos-live-tuning__snow');
    let progress = 8;
    if (fill) fill.style.width = progress + '%';
    if (pctEl) pctEl.textContent = String(progress);

    const paintSnow = () => {
      drawTvStatic(snow);
      overlay._snowTimer = setTimeout(paintSnow, 45);
    };
    paintSnow();

    overlay._freqTimer = setInterval(() => {
      const bump = 2 + Math.random() * 7;
      progress = Math.min(92, progress + bump);
      if (fill) fill.style.width = progress.toFixed(0) + '%';
      if (pctEl) pctEl.textContent = String(Math.round(progress));
    }, 180);
  }

  function stopTuningFx(overlay) {
    if (!overlay) return;
    if (overlay._freqTimer) {
      clearInterval(overlay._freqTimer);
      overlay._freqTimer = null;
    }
    if (overlay._snowTimer) {
      clearTimeout(overlay._snowTimer);
      overlay._snowTimer = null;
    }
  }

  function clearFsChromeTimer(mediaDiv) {
    if (!mediaDiv || !mediaDiv._fsChromeTimer) return;
    clearTimeout(mediaDiv._fsChromeTimer);
    mediaDiv._fsChromeTimer = null;
  }

  function stopCableOsdTimers(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv._osdClockTimer) {
      clearInterval(mediaDiv._osdClockTimer);
      mediaDiv._osdClockTimer = null;
    }
  }

  function lockFeedScrollForLiveFs() {
    const vp = document.querySelector('.videos-feed__viewport');
    if (!vp) return;
    vp.dataset.liveFsScrollTop = String(vp.scrollTop || 0);
    vp.style.overflow = 'hidden';
    vp.style.touchAction = 'none';
  }

  function unlockFeedScrollForLiveFs() {
    const vp = document.querySelector('.videos-feed__viewport');
    if (!vp) return;
    vp.style.overflow = '';
    vp.style.touchAction = '';
    const y = Number(vp.dataset.liveFsScrollTop || 0);
    try { vp.scrollTop = y; } catch (_) {}
    delete vp.dataset.liveFsScrollTop;
  }

  function ensureCableOsd(mediaDiv) {
    if (!mediaDiv) return null;
    let osd = mediaDiv.querySelector('.videos-live-cable-osd');
    if (osd) return osd;
    osd = document.createElement('div');
    osd.className = 'videos-live-cable-osd';
    osd.hidden = true;
    osd.innerHTML = [
      '<div class="videos-live-cable-osd__toolbar">',
      '  <button type="button" class="videos-live-cable-osd__tool" data-osd-mute aria-label="השתק">',
      '    <i class="fa-solid fa-volume-high" data-osd-mute-icon></i><span>שמע</span>',
      '  </button>',
      '  <button type="button" class="videos-live-cable-osd__tool videos-live-cable-osd__tool--back" data-osd-back aria-label="חזרה">',
      '    <i class="fa-solid fa-arrow-right"></i><span>חזרה</span>',
      '  </button>',
      '</div>',
      '<div class="videos-live-cable-osd__panel">',
      '  <div class="videos-live-cable-osd__row-top">',
      '    <div class="videos-live-cable-osd__ch-num" data-osd-num>—</div>',
      '    <div class="videos-live-cable-osd__ch-name" data-osd-channel>ערוץ חי</div>',
      '  </div>',
      '  <div class="videos-live-cable-osd__program">',
      '    <span class="videos-live-cable-osd__now-badge">עכשיו</span>',
      '    <div class="videos-live-cable-osd__now-title" data-osd-title>שידור חי</div>',
      '  </div>',
      '  <div class="videos-live-cable-osd__timing">',
      '    <div class="videos-live-cable-osd__timing-meta">',
      '      <span data-osd-duration></span>',
      '      <span class="videos-live-cable-osd__left" data-osd-left></span>',
      '      <span data-osd-range></span>',
      '    </div>',
      '    <div class="videos-live-cable-osd__bar" aria-hidden="true"><span class="videos-live-cable-osd__fill" data-osd-fill></span></div>',
      '  </div>',
      '  <div class="videos-live-cable-osd__status">',
      '    <span class="videos-live-cable-osd__weather" data-osd-weather></span>',
      '    <span class="videos-live-cable-osd__date" data-osd-date></span>',
      '    <span class="videos-live-cable-osd__clock" data-osd-clock></span>',
      '  </div>',
      '</div>',
    ].join('');
    mediaDiv.appendChild(osd);

    const muteBtn = osd.querySelector('[data-osd-mute]');
    const backBtn = osd.querySelector('[data-osd-back]');
    if (muteBtn) {
      muteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const videoEl = mediaDiv.querySelector('video');
        if (!videoEl) return;
        videoEl.muted = !videoEl.muted;
        updateCableOsdMuteIcon(mediaDiv);
        showFsChrome(mediaDiv);
      });
    }
    if (backBtn) {
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        exitLiveFullscreen(mediaDiv);
      });
    }
    return osd;
  }

  function updateCableOsdMuteIcon(mediaDiv) {
    const videoEl = mediaDiv && mediaDiv.querySelector('video');
    const icon = mediaDiv && mediaDiv.querySelector('[data-osd-mute-icon]');
    if (!icon || !videoEl) return;
    icon.className = videoEl.muted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
  }

  function updateCableOsd(mediaDiv) {
    if (!mediaDiv) return;
    const osd = ensureCableOsd(mediaDiv);
    if (!osd) return;
    const channel = mediaDiv.dataset.liveChannel
      || formatChannelDisplayName(mediaDiv.dataset.liveCaption || '')
      || 'ערוץ חי';
    const title = mediaDiv.dataset.liveProgram || 'שידור חי';
    const num = mediaDiv.dataset.liveChannelNumber || '';
    const startIso = mediaDiv.dataset.liveProgramStart || '';
    const stopIso = mediaDiv.dataset.liveProgramStop || '';
    const start = startIso ? new Date(startIso) : null;
    const stop = stopIso ? new Date(stopIso) : null;
    const now = new Date();
    const prog = (start && stop && !Number.isNaN(start.getTime()) && !Number.isNaN(stop.getTime()))
      ? progressFromWindow(start, stop, now)
      : null;

    const numEl = osd.querySelector('[data-osd-num]');
    const chEl = osd.querySelector('[data-osd-channel]');
    const titleEl = osd.querySelector('[data-osd-title]');
    const durEl = osd.querySelector('[data-osd-duration]');
    const leftEl = osd.querySelector('[data-osd-left]');
    const rangeEl = osd.querySelector('[data-osd-range]');
    const fillEl = osd.querySelector('[data-osd-fill]');
    const clockEl = osd.querySelector('[data-osd-clock]');
    const dateEl = osd.querySelector('[data-osd-date]');
    const weatherEl = osd.querySelector('[data-osd-weather]');

    if (numEl) numEl.textContent = num || '•';
    if (chEl) chEl.textContent = channel;
    if (titleEl) titleEl.textContent = title || 'שידור חי';
    if (clockEl) clockEl.textContent = formatOsdClock(now);
    if (dateEl) dateEl.textContent = formatOsdDate(now);
    if (weatherEl && mediaDiv.dataset.liveWeather) weatherEl.textContent = mediaDiv.dataset.liveWeather;

    if (prog) {
      if (durEl) durEl.textContent = 'דק\' ' + prog.durationMinutes;
      if (leftEl) leftEl.textContent = 'נותרו ' + prog.minutesLeft + ' דק';
      if (rangeEl) rangeEl.textContent = formatOsdTime(start) + ' – ' + formatOsdTime(stop);
      if (fillEl) fillEl.style.width = prog.progressPct.toFixed(1) + '%';
      osd.classList.remove('videos-live-cable-osd--no-epg');
    } else {
      if (durEl) durEl.textContent = '';
      if (leftEl) leftEl.textContent = '';
      if (rangeEl) rangeEl.textContent = '';
      if (fillEl) fillEl.style.width = '0%';
      osd.classList.add('videos-live-cable-osd--no-epg');
    }
    updateCableOsdMuteIcon(mediaDiv);
  }

  async function refreshCableOsdWeather(mediaDiv) {
    if (!mediaDiv || mediaDiv.dataset.liveWeather) return;
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=32.08&longitude=34.78&current=temperature_2m,weather_code&timezone=Asia%2FJerusalem');
      if (!res.ok) return;
      const data = await res.json();
      const temp = data && data.current && data.current.temperature_2m;
      if (temp == null) return;
      mediaDiv.dataset.liveWeather = Math.round(temp) + '°';
      updateCableOsd(mediaDiv);
    } catch (_) {}
  }

  function showFsChrome(mediaDiv) {
    if (!mediaDiv || !mediaDiv.classList.contains('is-live-fullscreen')) return;
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const osd = ensureCableOsd(mediaDiv);
    if (closeBtn) {
      closeBtn.hidden = false;
      closeBtn.classList.remove('is-fs-chrome-hidden');
    }
    if (osd) {
      osd.hidden = false;
      osd.classList.remove('is-fs-chrome-hidden');
    }
    mediaDiv.classList.add('is-fs-chrome-visible');
    updateCableOsd(mediaDiv);
    clearFsChromeTimer(mediaDiv);
    mediaDiv._fsChromeTimer = setTimeout(() => {
      hideFsChrome(mediaDiv);
    }, 5500);
  }

  function hideFsChrome(mediaDiv) {
    if (!mediaDiv) return;
    clearFsChromeTimer(mediaDiv);
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const osd = mediaDiv.querySelector('.videos-live-cable-osd');
    if (closeBtn) closeBtn.classList.add('is-fs-chrome-hidden');
    if (osd) osd.classList.add('is-fs-chrome-hidden');
    mediaDiv.classList.remove('is-fs-chrome-visible');
  }

  function ensureFullscreenControls(mediaDiv) {
    if (!mediaDiv) return;
    ensureCableOsd(mediaDiv);
    if (mediaDiv.querySelector('.videos-live-fs-btn')) return;

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'videos-live-fs-btn';
    fsBtn.setAttribute('aria-label', 'מסך מלא');
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterLiveFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(fsBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'videos-live-fs-close';
    closeBtn.setAttribute('aria-label', 'סגור מסך מלא');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.hidden = true;
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exitLiveFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(closeBtn);

    const revealChrome = (e) => {
      if (!mediaDiv.classList.contains('is-live-fullscreen')) return;
      if (e.target && e.target.closest && e.target.closest('.videos-live-fs-close, .videos-live-cable-osd__tool')) return;
      e.preventDefault();
      e.stopPropagation();
      showFsChrome(mediaDiv);
    };
    mediaDiv.addEventListener('click', revealChrome);
    mediaDiv.addEventListener('touchend', revealChrome, { passive: false });
  }

  function resumeLiveFullscreenPlayback(mediaDiv) {
    if (!mediaDiv || !mediaDiv.classList.contains('is-live-fullscreen')) return;
    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) return;
    const tryPlay = () => {
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      }
    };
    tryPlay();
    setTimeout(tryPlay, 250);
  }

  function enterLiveFullscreen(mediaDiv) {
    if (!mediaDiv) return;
    const existing = document.querySelector('.videos-feed__media.is-live-fullscreen');
    if (existing && existing !== mediaDiv) exitLiveFullscreen(existing);
    mediaDiv.classList.add('is-live-fullscreen');
    document.body.classList.add('live-channel-fullscreen');
    lockFeedScrollForLiveFs();
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
    if (fsBtn) fsBtn.hidden = true;
    ensureCableOsd(mediaDiv);
    showFsChrome(mediaDiv);
    updateCableOsd(mediaDiv);
    refreshCableOsdWeather(mediaDiv);
    enrichLiveCardMeta(mediaDiv, {
      url: mediaDiv.dataset.liveUrl || '',
      content: mediaDiv.dataset.liveCaption || '',
      lockedName: mediaDiv.dataset.liveCaption || '',
      tvgId: mediaDiv.dataset.liveTvgId || '',
    }).catch(() => {});

    stopCableOsdTimers(mediaDiv);
    mediaDiv._osdClockTimer = setInterval(() => {
      if (!mediaDiv.classList.contains('is-live-fullscreen')) {
        stopCableOsdTimers(mediaDiv);
        return;
      }
      updateCableOsd(mediaDiv);
    }, 1000);

    try {
      if (mediaDiv.requestFullscreen) mediaDiv.requestFullscreen().catch(() => {});
      else if (mediaDiv.webkitRequestFullscreen) mediaDiv.webkitRequestFullscreen();
    } catch (_) {}

    resumeLiveFullscreenPlayback(mediaDiv);
  }

  function exitLiveFullscreen(mediaDiv) {
    if (!mediaDiv) {
      document.body.classList.remove('live-channel-fullscreen');
      unlockFeedScrollForLiveFs();
      return;
    }
    clearFsChromeTimer(mediaDiv);
    stopCableOsdTimers(mediaDiv);
    mediaDiv.classList.remove('is-live-fullscreen', 'is-fs-chrome-visible');
    document.body.classList.remove('live-channel-fullscreen');
    unlockFeedScrollForLiveFs();
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
    const osd = mediaDiv.querySelector('.videos-live-cable-osd');
    if (closeBtn) {
      closeBtn.hidden = true;
      closeBtn.classList.remove('is-fs-chrome-hidden');
    }
    if (fsBtn) fsBtn.hidden = false;
    if (osd) {
      osd.hidden = true;
      osd.classList.remove('is-fs-chrome-hidden');
    }

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (_) {}
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      document.querySelectorAll('.videos-feed__media.is-live-fullscreen').forEach((el) => {
        // יציאה ממסך מלא של הדפדפן – סוגרים OSD אבל לא מחליפים ערוץ | HYPER CORE TECH
        clearFsChromeTimer(el);
        stopCableOsdTimers(el);
        el.classList.remove('is-live-fullscreen', 'is-fs-chrome-visible');
        const closeBtn = el.querySelector('.videos-live-fs-close');
        const fsBtn = el.querySelector('.videos-live-fs-btn');
        const osd = el.querySelector('.videos-live-cable-osd');
        if (closeBtn) {
          closeBtn.hidden = true;
          closeBtn.classList.remove('is-fs-chrome-hidden');
        }
        if (fsBtn) fsBtn.hidden = false;
        if (osd) {
          osd.hidden = true;
          osd.classList.remove('is-fs-chrome-hidden');
        }
      });
      document.body.classList.remove('live-channel-fullscreen');
      unlockFeedScrollForLiveFs();
    }
  });

  // סיבוב מסך במסך מלא – שומרים ערוץ ומחדשים ניגון | HYPER CORE TECH
  const onOrientationOrResize = () => {
    const open = document.querySelector('.videos-feed__media.is-live-fullscreen');
    if (!open) return;
    resumeLiveFullscreenPlayback(open);
    updateCableOsd(open);
    showFsChrome(open);
  };
  window.addEventListener('orientationchange', () => {
    setTimeout(onOrientationOrResize, 120);
    setTimeout(onOrientationOrResize, 450);
  });
  window.addEventListener('resize', () => {
    if (!document.body.classList.contains('live-channel-fullscreen')) return;
    clearTimeout(window._liveFsResizeTimer);
    window._liveFsResizeTimer = setTimeout(onOrientationOrResize, 180);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.videos-feed__media.is-live-fullscreen');
      if (open) exitLiveFullscreen(open);
    }
  });

  function attachHlsToVideo(videoEl, url, options = {}) {
    return new Promise((resolve, reject) => {
      if (!videoEl || !url) {
        reject(new Error('missing video/url'));
        return;
      }

      destroyHls(videoEl);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(videoEl);
      };

      const onPlaying = () => done();
      const onError = () => done(new Error('hls play error'));

      videoEl.addEventListener('playing', onPlaying, { once: true });
      videoEl.addEventListener('loadeddata', onPlaying, { once: true });
      videoEl.addEventListener('error', onError, { once: true });

      const HlsCtor = window.Hls;
      if (HlsCtor && HlsCtor.isSupported && HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 20,
        });
        hlsInstances.set(videoEl, hls);
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
          if (options.autoplay) {
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
          done();
        });
        hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
          if (data && data.fatal) {
            try { hls.destroy(); } catch (_) {}
            hlsInstances.delete(videoEl);
            done(new Error(data.type || 'hls fatal'));
          }
        });
        return;
      }

      if (canNativeHls(videoEl)) {
        videoEl.src = url;
        videoEl.load();
        if (options.autoplay) {
          const p = videoEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return;
      }

      done(new Error('hls unsupported'));
    });
  }

  async function prepareLiveMedia(mediaDiv, options = {}) {
    if (!mediaDiv) return { ok: false };
    const url = mediaDiv.dataset.liveUrl || mediaDiv.dataset.videoUrl || '';
    if (!url) return { ok: false, reason: 'no-url' };

    ensureLiveBadge(mediaDiv);
    ensureLiveMetaOverlay(mediaDiv);
    setTuningVisible(mediaDiv, true, options.tuningLabel || 'מחפש ערוץ...');

    if (options.content != null) {
      mediaDiv.dataset.liveCaption = String(options.content || '');
    }
    enrichLiveCardMeta(mediaDiv, {
      url,
      content: mediaDiv.dataset.liveCaption || options.content || '',
    }).catch(() => {});

    const health = await checkHlsHealth(url);
    if (health && health.playlistMeta) {
      enrichLiveCardMeta(mediaDiv, {
        url,
        content: mediaDiv.dataset.liveCaption || options.content || '',
        playlistMeta: health.playlistMeta,
      }).catch(() => {});
    }
    if (health && health.ok === false && !health.unverified) {
      setTuningVisible(mediaDiv, true, 'ערוץ לא זמין');
      return { ok: false, health };
    }

    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) {
      setTuningVisible(mediaDiv, false);
      return { ok: false, reason: 'no-video' };
    }

    try {
      await attachHlsToVideo(videoEl, url, { autoplay: !!options.autoplay });
      setTuningVisible(mediaDiv, false);
      mediaDiv.classList.add('videos-feed__media--ready');
      mediaDiv.dataset.livePrepared = '1';
      return { ok: true, health };
    } catch (err) {
      setTuningVisible(mediaDiv, true, 'לא מצליח לתפוס ערוץ');
      return { ok: false, error: err, health };
    }
  }

  async function prefetchLiveUrl(url) {
    if (!url || !isHlsLiveUrl(url)) return;
    await checkHlsHealth(url);
    // חימום קל של playlist בלבד — הניגון עצמו על הכרטיס
  }

  function buildComposeLivePreview(url, content) {
    const wrap = document.createElement('div');
    wrap.className = 'compose-live-preview';
    const meta = resolveLiveMeta({ url, content: content || '' });
    wrap.innerHTML = [
      '<div class="compose-live-preview__badge"><span class="videos-live-badge__dot"></span>LIVE IPTV</div>',
      '<div class="compose-live-preview__title"></div>',
      '<div class="compose-live-preview__url"></div>',
      '<div class="compose-live-preview__hint">יפורסם כפוסט שידור חי בפיד — הוסיפו שם ערוץ בטקסט כדי שיוצג על הכרטיס</div>',
    ].join('');
    const titleEl = wrap.querySelector('.compose-live-preview__title');
    if (titleEl) titleEl.textContent = meta.channelName || 'ערוץ חי מזוהה';
    const urlEl = wrap.querySelector('.compose-live-preview__url');
    if (urlEl) urlEl.textContent = url;
    return wrap;
  }

  Object.assign(App, {
    isHlsLiveUrl,
    extractHlsUrlFromText,
    checkHlsHealth,
    prepareLiveMedia,
    prefetchLiveUrl,
    attachHlsToVideo,
    destroyHls,
    ensureLiveBadge,
    ensureLiveTopbar,
    ensureLiveMetaOverlay,
    setLiveMetaOverlay,
    enrichLiveCardMeta,
    resolveLiveMeta,
    formatChannelDisplayName,
    ensureTuningOverlay,
    ensureFullscreenControls,
    enterLiveFullscreen,
    exitLiveFullscreen,
    setTuningVisible,
    buildComposeLivePreview,
  });

  window.SosHlsLive = {
    isHlsLiveUrl,
    extractHlsUrlFromText,
    checkHlsHealth,
    prepareLiveMedia,
    prefetchLiveUrl,
    attachHlsToVideo,
    destroyHls,
    ensureLiveBadge,
    ensureLiveTopbar,
    ensureLiveMetaOverlay,
    setLiveMetaOverlay,
    formatChannelDisplayName,
    enrichLiveCardMeta,
    resolveLiveMeta,
    ensureFullscreenControls,
    enterLiveFullscreen,
    exitLiveFullscreen,
    setTuningVisible,
    buildComposeLivePreview,
  };
})(window);
