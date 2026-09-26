/**
 * "הפיד שלי" — select which communities contribute to the aggregated feed.
 * Feed selection does NOT change membership / admin / invites.
 */
(function initCommunityFeedSelection(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  function CC() {
    return App.CommunityContext || window.SosCommunityContext;
  }

  function ensureStyles() {
    if (document.getElementById('sosFeedSelStyles')) return;
    const s = document.createElement('style');
    s.id = 'sosFeedSelStyles';
    s.textContent =
      '#sosFeedSelBtn{position:fixed;bottom:236px;inset-inline-end:12px;z-index:9000;padding:10px 14px;border-radius:999px;border:0;background:#1f6feb;color:#fff;cursor:pointer;font-size:13px}' +
      '#sosFeedSelPanel{position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}' +
      '#sosFeedSelPanel.is-open{display:flex}' +
      '#sosFeedSelPanel .fs-box{background:#12151c;color:#eee;border-radius:14px;padding:16px;width:min(420px,92vw);max-height:80vh;overflow:auto}' +
      '#sosFeedSelPanel h3{margin:0 0 10px;font-size:16px}' +
      '#sosFeedSelPanel label{display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #2a3142;font-size:14px}' +
      '#sosFeedSelPanel .fs-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}' +
      '#sosFeedSelPanel button{padding:8px 12px;border-radius:8px;border:0;cursor:pointer}' +
      '#sosFeedSelPanel .primary{background:#3d7eff;color:#fff}' +
      '.feed-post__community{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.9;margin-top:2px}' +
      '.feed-post__community img{width:16px;height:16px;border-radius:50%;object-fit:cover}';
    document.head.appendChild(s);
  }

  function openPanel() {
    const cc = CC();
    if (!cc) return;
    ensureStyles();
    let panel = document.getElementById('sosFeedSelPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sosFeedSelPanel';
      panel.innerHTML =
        '<div class="fs-box" role="dialog" aria-modal="true">' +
        '<h3>הפיד שלי</h3>' +
        '<p style="font-size:12px;opacity:.8;margin:0 0 8px">בחירת קהילות לפיד בלבד — לא משנה חברות.</p>' +
        '<div id="sosFeedSelList"></div>' +
        '<div class="fs-actions">' +
        '<button type="button" class="primary" id="sosFeedSelSave">שמירה</button>' +
        '<button type="button" id="sosFeedSelClose">סגור</button>' +
        '</div></div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', (ev) => {
        if (ev.target === panel) closePanel();
      });
      panel.querySelector('#sosFeedSelClose').addEventListener('click', closePanel);
      panel.querySelector('#sosFeedSelSave').addEventListener('click', saveFromPanel);
    }
    const list = panel.querySelector('#sosFeedSelList');
    const selected = new Set(cc.getFeedSelection());
    const communities = cc.listCommunities();
    list.innerHTML = communities
      .map((c) => {
        const checked = selected.has(c.communityId) ? ' checked' : '';
        return (
          '<label><input type="checkbox" data-cid="' +
          c.communityId +
          '"' +
          checked +
          '> ' +
          (c.logoRef
            ? '<img src="' +
              c.logoRef.replace(/"/g, '') +
              '" width="18" height="18" alt="" style="border-radius:50%">'
            : '') +
          ' <span>' +
          String(c.name || c.communityId).replace(/</g, '') +
          '</span></label>'
        );
      })
      .join('');
    panel.classList.add('is-open');
  }

  function closePanel() {
    const panel = document.getElementById('sosFeedSelPanel');
    if (panel) panel.classList.remove('is-open');
  }

  function saveFromPanel() {
    const cc = CC();
    if (!cc) return;
    const panel = document.getElementById('sosFeedSelPanel');
    if (!panel) return;
    const ids = [];
    panel.querySelectorAll('input[type=checkbox][data-cid]').forEach((inp) => {
      if (inp.checked) ids.push(inp.getAttribute('data-cid'));
    });
    cc.setFeedSelection(ids);
    closePanel();
    try {
      if (typeof App.refreshHomeFeed === 'function') App.refreshHomeFeed();
      else if (typeof App.loadFeed === 'function') App.loadFeed();
    } catch (_e) {}
  }

  function ensureButton() {
    ensureStyles();
    let btn = document.getElementById('sosFeedSelBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'sosFeedSelBtn';
      btn.type = 'button';
      btn.textContent = 'הפיד שלי';
      btn.addEventListener('click', openPanel);
      document.body.appendChild(btn);
    }
  }

  function communityAttributionHtml(event) {
    const cc = CC();
    if (!cc || !event || !Array.isArray(event.tags)) return '';
    const tTag = event.tags.find((t) => Array.isArray(t) && t[0] === 't' && t[1]);
    if (!tTag) return '';
    const networkTag = String(tTag[1]);
    const meta = cc.getByNetworkTag(networkTag);
    if (!meta || meta.communityId === 'sos010') {
      return '<div class="feed-post__community" data-community-id="sos010" data-network-tag="' +
        networkTag.replace(/"/g, '') +
        '"><span>SOS010</span></div>';
    }
    const logo = meta.logoRef
      ? '<img src="' + meta.logoRef.replace(/"/g, '') + '" alt="">'
      : '';
    return (
      '<div class="feed-post__community" data-community-id="' +
      meta.communityId.replace(/"/g, '') +
      '" data-network-tag="' +
      networkTag.replace(/"/g, '') +
      '">' +
      logo +
      '<span>' +
      String(meta.name || meta.communityId).replace(/</g, '') +
      '</span></div>'
    );
  }

  function boot() {
    ensureButton();
  }

  const api = Object.freeze({
    openPanel,
    closePanel,
    ensureButton,
    communityAttributionHtml,
    FEED_SELECTION_DOES_NOT_CHANGE_MEMBERSHIP: true,
  });
  App.CommunityFeedSelection = api;
  window.SosCommunityFeedSelection = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
