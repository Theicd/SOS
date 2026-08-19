/*!
 * חלק לוח תפעול (ops-panel.js) – רשימות פשוטות + זמין/לא זמין ליד כל שרת | HYPER CORE TECH
 */
(function (window, document) {
  'use strict';

  const DEFAULTS = {
    relays: [
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://nostr-relay.xbytez.io',
      'wss://nostr-02.uid.ovh',
    ],
    p2pRelays: [
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://nostr-relay.xbytez.io',
    ],
    blossom: [
      'https://files.sovbit.host',
      'https://blossom.band',
      'https://blossom.primal.net',
      'https://blossom.nostr.build',
      'https://nostr.build',
    ],
    ice: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
    trackers: [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.btorrent.xyz',
      'wss://tracker.webtorrent.dev',
    ],
    androidRelays: [
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://nostr-relay.xbytez.io',
      'wss://nostr-02.uid.ovh',
    ],
    fcm: 'https://sos-fcm-push.vercel.app',
  };

  const KEYS = {
    relays: 'nostr_relay_urls',
    p2p: 'nostr_p2p_relays',
    blossom: 'sos_blossom_servers',
    ice: 'nostr_rtc_ice',
    fcm: 'fcm_push_url',
  };

  const state = {
    relays: [],
    p2p: [],
    blossom: [],
    ice: [],
    fcm: '',
  };

  // מצב אחרון לכל כתובת: ok / bad / wait / skip
  const live = Object.create(null);

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    const el = $('opsToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('is-on'), 1800);
  }

  function readJsonArray(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback.slice();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length ? parsed : fallback.slice();
    } catch (_) {
      return fallback.slice();
    }
  }

  function normalizeUrlList(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((item) => {
      const u = typeof item === 'string' ? item.trim() : (item && item.url ? String(item.url).trim() : '');
      if (!u || out.includes(u)) return;
      out.push(u);
    });
    return out;
  }

  function iceToLines(list) {
    return (Array.isArray(list) ? list : []).map((entry) => {
      if (!entry) return '';
      if (typeof entry === 'string') return entry;
      const urls = Array.isArray(entry.urls) ? entry.urls.join(',') : String(entry.urls || '');
      if (entry.username) return urls + '|' + entry.username + '|' + (entry.credential || '');
      return urls;
    }).filter(Boolean);
  }

  function linesToIce(lines) {
    return lines.map((line) => {
      const parts = String(line).split('|');
      const urls = parts[0].trim();
      if (!urls) return null;
      if (parts.length >= 2) return { urls, username: parts[1], credential: parts[2] || '' };
      return { urls };
    }).filter(Boolean);
  }

  function loadState() {
    state.relays = normalizeUrlList(readJsonArray(KEYS.relays, DEFAULTS.relays));
    state.p2p = normalizeUrlList(readJsonArray(KEYS.p2p, DEFAULTS.p2pRelays));
    state.blossom = normalizeUrlList(readJsonArray(KEYS.blossom, DEFAULTS.blossom.map((u) => ({ url: u }))));
    if (!state.blossom.length) state.blossom = DEFAULTS.blossom.slice();
    state.ice = readJsonArray(KEYS.ice, DEFAULTS.ice);
    if (!state.ice.length) state.ice = DEFAULTS.ice.slice();
    state.fcm = (localStorage.getItem(KEYS.fcm) || DEFAULTS.fcm).trim() || DEFAULTS.fcm;
  }

  function persist() {
    const fcmInput = $('opsFcmInput');
    if (fcmInput) state.fcm = fcmInput.value.trim() || DEFAULTS.fcm;
    localStorage.setItem(KEYS.relays, JSON.stringify(state.relays));
    localStorage.setItem(KEYS.p2p, JSON.stringify(state.p2p));
    localStorage.setItem(KEYS.blossom, JSON.stringify(state.blossom.map((url) => ({ url }))));
    localStorage.setItem(KEYS.ice, JSON.stringify(state.ice));
    localStorage.setItem(KEYS.fcm, state.fcm);
    toast('נשמר');
  }

  function stateLabel(mode) {
    if (mode === 'ok') return { cls: 'ops-state--ok', text: 'זמין' };
    if (mode === 'bad') return { cls: 'ops-state--bad', text: 'לא זמין' };
    if (mode === 'wait') return { cls: 'ops-state--wait', text: 'בודק…' };
    return { cls: 'ops-state--skip', text: 'לא נבדק' };
  }

  function setLive(key, mode) {
    live[key] = mode;
    const badge = document.querySelector('[data-live="' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
    // fallback: iterate
    const all = document.querySelectorAll('[data-live]');
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].getAttribute('data-live') !== key) continue;
      const info = stateLabel(mode);
      all[i].className = 'ops-state ' + info.cls;
      all[i].textContent = info.text;
      break;
    }
  }

  function pingWs(url) {
    return new Promise((resolve) => {
      let done = false;
      let ws;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { if (ws) ws.close(); } catch (_) {}
        resolve(ok);
      };
      const t = setTimeout(() => finish(false), 4500);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => { clearTimeout(t); finish(true); };
        ws.onerror = () => { clearTimeout(t); finish(false); };
      } catch (_) {
        clearTimeout(t);
        finish(false);
      }
    });
  }

  async function pingHttp(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, { method: 'GET', mode: 'cors', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      return res.ok || res.status === 404 || res.status === 401 || res.status === 405;
    } catch (_) {
      clearTimeout(t);
      try {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 4000);
        await fetch(url, { method: 'GET', mode: 'no-cors', signal: ctrl2.signal, cache: 'no-store' });
        clearTimeout(t2);
        return true;
      } catch (__) {
        return false;
      }
    }
  }

  function makeRow(url, key, editable, group, index) {
    const li = document.createElement('li');
    li.className = 'ops-row';
    const mode = live[key] || (group === 'ice' || group === 'android' ? 'skip' : 'wait');
    const info = stateLabel(mode);

    const badge = document.createElement('span');
    badge.className = 'ops-state ' + info.cls;
    badge.setAttribute('data-live', key);
    badge.textContent = info.text;

    const main = document.createElement('div');
    main.className = 'ops-row__main';
    const urlEl = document.createElement('div');
    urlEl.className = 'ops-url';
    urlEl.textContent = url;
    main.appendChild(urlEl);

    li.appendChild(badge);
    li.appendChild(main);

    if (editable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ops-icon-btn';
      del.title = 'הסר';
      del.innerHTML = '<i class="fa-solid fa-trash"></i>';
      del.addEventListener('click', () => {
        if (group === 'relays') state.relays.splice(index, 1);
        if (group === 'p2p') state.p2p.splice(index, 1);
        if (group === 'blossom') state.blossom.splice(index, 1);
        if (group === 'ice') state.ice.splice(index, 1);
        persist();
        renderAll();
      });
      li.appendChild(del);
    }
    return li;
  }

  function fillList(id, urls, group, editable) {
    const root = $(id);
    if (!root) return;
    root.innerHTML = '';
    if (!urls.length) {
      root.innerHTML = '<li class="ops-row"><span class="ops-state ops-state--skip">—</span><div class="ops-row__main"><div class="ops-url">אין שרתים</div></div></li>';
      return;
    }
    urls.forEach((url, index) => {
      root.appendChild(makeRow(url, group + ':' + url, editable, group, index));
    });
  }

  function setCount(id, n, ok, bad) {
    const el = $(id);
    if (!el) return;
    if (typeof ok === 'number') el.textContent = n + ' שרתים · זמינים ' + ok + ' · לא זמינים ' + bad;
    else el.textContent = n + ' שרתים';
  }

  function renderAll() {
    fillList('opsRelayList', state.relays, 'relays', true);
    fillList('opsP2pList', state.p2p, 'p2p', true);
    fillList('opsBlossomList', state.blossom, 'blossom', true);
    fillList('opsIceList', iceToLines(state.ice), 'ice', true);
    fillList('opsTrackerList', DEFAULTS.trackers, 'trackers', false);
    fillList('opsAndroidList', DEFAULTS.androidRelays, 'android', false);

    const fcmRoot = $('opsFcmList');
    if (fcmRoot) {
      fcmRoot.innerHTML = '';
      fcmRoot.appendChild(makeRow(state.fcm, 'fcm:' + state.fcm, false, 'fcm', 0));
    }
    const fcmInput = $('opsFcmInput');
    if (fcmInput && document.activeElement !== fcmInput) fcmInput.value = state.fcm;

    setCount('count-relays', state.relays.length);
    setCount('count-p2p', state.p2p.length);
    setCount('count-blossom', state.blossom.length);
    setCount('count-ice', state.ice.length);
    setCount('count-trackers', DEFAULTS.trackers.length);
  }

  async function checkGroup(group) {
    const jobs = [];
    const mark = (key, promise) => {
      setLive(key, 'wait');
      jobs.push(promise.then((ok) => setLive(key, ok ? 'ok' : 'bad')));
    };

    if (group === 'relays') {
      state.relays.forEach((url) => mark('relays:' + url, pingWs(url)));
    }
    if (group === 'p2p') {
      state.p2p.forEach((url) => mark('p2p:' + url, pingWs(url)));
    }
    if (group === 'blossom') {
      state.blossom.forEach((url) => mark('blossom:' + url, pingHttp(url)));
    }
    if (group === 'trackers') {
      DEFAULTS.trackers.forEach((url) => mark('trackers:' + url, pingWs(url)));
    }
    if (group === 'fcm') {
      const fcmInput = $('opsFcmInput');
      if (fcmInput) state.fcm = fcmInput.value.trim() || state.fcm;
      mark('fcm:' + state.fcm, pingHttp(state.fcm));
    }

    await Promise.all(jobs);

    // סיכום קצר ליד הכותרת
    const tally = (prefix, list) => {
      let ok = 0;
      let bad = 0;
      list.forEach((url) => {
        const m = live[prefix + ':' + url];
        if (m === 'ok') ok += 1;
        if (m === 'bad') bad += 1;
      });
      return { ok, bad };
    };
    if (group === 'relays') {
      const t = tally('relays', state.relays);
      setCount('count-relays', state.relays.length, t.ok, t.bad);
    }
    if (group === 'p2p') {
      const t = tally('p2p', state.p2p);
      setCount('count-p2p', state.p2p.length, t.ok, t.bad);
    }
    if (group === 'blossom') {
      const t = tally('blossom', state.blossom);
      setCount('count-blossom', state.blossom.length, t.ok, t.bad);
    }
    if (group === 'trackers') {
      const t = tally('trackers', DEFAULTS.trackers);
      setCount('count-trackers', DEFAULTS.trackers.length, t.ok, t.bad);
    }
    toast('בדיקה הסתיימה');
  }

  function addUrl(group, inputId) {
    const input = $(inputId);
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    if (group === 'relays' || group === 'p2p') {
      if (!value.startsWith('wss://')) return toast('צריך wss://');
      const list = group === 'relays' ? state.relays : state.p2p;
      if (!list.includes(value)) list.push(value);
    } else if (group === 'blossom') {
      if (!/^https?:\/\//i.test(value)) return toast('צריך https://');
      const clean = value.replace(/\/$/, '');
      if (!state.blossom.includes(clean)) state.blossom.push(clean);
    } else if (group === 'ice') {
      const parsed = linesToIce([value]);
      if (!parsed.length) return toast('פורמט לא תקין');
      state.ice.push(parsed[0]);
    }
    input.value = '';
    persist();
    renderAll();
  }

  function exportConfig() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      relays: state.relays,
      p2pRelays: state.p2p,
      blossom: state.blossom,
      ice: state.ice,
      fcm: state.fcm,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sos-ops-config-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('קובץ הורד');
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        if (Array.isArray(data.relays)) state.relays = normalizeUrlList(data.relays);
        if (Array.isArray(data.p2pRelays)) state.p2p = normalizeUrlList(data.p2pRelays);
        if (Array.isArray(data.blossom)) state.blossom = normalizeUrlList(data.blossom);
        if (Array.isArray(data.ice)) state.ice = data.ice;
        if (typeof data.fcm === 'string' && data.fcm.trim()) state.fcm = data.fcm.trim();
        persist();
        renderAll();
        toast('שוחזר');
      } catch (_) {
        toast('קובץ לא תקין');
      }
    };
    reader.readAsText(file);
  }

  function resetDefaults() {
    if (!window.confirm('להחזיר הכל לברירת מחדל?')) return;
    state.relays = DEFAULTS.relays.slice();
    state.p2p = DEFAULTS.p2pRelays.slice();
    state.blossom = DEFAULTS.blossom.slice();
    state.ice = DEFAULTS.ice.slice();
    state.fcm = DEFAULTS.fcm;
    Object.keys(live).forEach((k) => { delete live[k]; });
    persist();
    renderAll();
  }

  function switchTab(name) {
    document.querySelectorAll('.ops-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.ops-pane').forEach((pane) => {
      const on = pane.id === 'pane-' + name;
      pane.classList.toggle('is-active', on);
      if (on) pane.removeAttribute('hidden');
      else pane.setAttribute('hidden', '');
    });
    // גלילה לראש התוכן
    const main = document.querySelector('.ops-main');
    if (main) main.scrollTop = 0;
    // בדיקה אוטומטית כשנכנסים ללשונית עם שרתים
    if (name === 'relays' || name === 'p2p' || name === 'blossom' || name === 'trackers' || name === 'fcm') {
      checkGroup(name);
    }
  }

  function bind() {
    document.querySelectorAll('.ops-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
    });
    document.querySelectorAll('[data-check]').forEach((btn) => {
      btn.addEventListener('click', () => checkGroup(btn.getAttribute('data-check')));
    });
    document.querySelectorAll('[data-save]').forEach((btn) => {
      btn.addEventListener('click', () => { persist(); renderAll(); });
    });
    $('opsExport')?.addEventListener('click', exportConfig);
    $('opsImportBtn')?.addEventListener('click', () => $('opsImportFile')?.click());
    $('opsImportFile')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importConfig(file);
      e.target.value = '';
    });
    $('opsReset')?.addEventListener('click', resetDefaults);
    $('opsAddRelay')?.addEventListener('click', () => addUrl('relays', 'opsRelayInput'));
    $('opsAddP2p')?.addEventListener('click', () => addUrl('p2p', 'opsP2pInput'));
    $('opsAddBlossom')?.addEventListener('click', () => addUrl('blossom', 'opsBlossomInput'));
    $('opsAddIce')?.addEventListener('click', () => addUrl('ice', 'opsIceInput'));
  }

  function boot() {
    loadState();
    renderAll();
    bind();
    switchTab('home');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window, document);
