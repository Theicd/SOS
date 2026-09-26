/**
 * Community branding switch — replaces primary SOS010 top-bar brand when
 * active community is not the global network. Metadata only; no authority.
 */
(function initCommunityBrandingUi(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const SOS_LOGO = 'icons/sos-logo.PNG';
  const SOS_LOGO_MOBILE = 'icons/sos-logo-mobile.png';

  function CC() {
    return App.CommunityContext || window.SosCommunityContext;
  }

  function applyBranding(snap) {
    const meta = snap || (CC() && CC().snapshot && CC().snapshot()) || null;
    const isGlobal = !meta || meta.communityId === 'sos010';
    const logoRef = isGlobal ? SOS_LOGO : meta.logoRef || SOS_LOGO;
    const mobileLogo = isGlobal ? SOS_LOGO_MOBILE : meta.logoRef || SOS_LOGO_MOBILE;
    const name = isGlobal ? 'SOS010' : meta.name || meta.communityId || 'Community';

    const logoImgs = document.querySelectorAll('.top-bar__logo-img, .app-logo img, .sidebar-logo img');
    logoImgs.forEach((img) => {
      if (!(img instanceof HTMLImageElement)) return;
      img.dataset.sosBrandScope = isGlobal ? 'network' : 'community';
      img.alt = name + ' Logo';
      if (img.classList.contains('top-bar__logo-img') || img.closest('.app-logo')) {
        img.src = mobileLogo || logoRef;
      } else {
        img.src = logoRef;
      }
    });

    const sources = document.querySelectorAll('.app-logo source[media]');
    sources.forEach((src) => {
      if (src instanceof HTMLSourceElement) {
        src.srcset = mobileLogo || logoRef;
      }
    });

    let titleEl = document.getElementById('sosCommunityBrandTitle');
    if (!titleEl) {
      const host =
        document.querySelector('.app-logo') ||
        document.querySelector('.top-bar') ||
        document.body;
      if (host) {
        titleEl = document.createElement('span');
        titleEl.id = 'sosCommunityBrandTitle';
        titleEl.style.cssText =
          'font-weight:700;font-size:14px;margin-inline-start:8px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;';
        host.appendChild(titleEl);
      }
    }
    if (titleEl) {
      titleEl.textContent = isGlobal ? '' : name;
      titleEl.hidden = isGlobal;
      titleEl.dataset.communityId = isGlobal ? 'sos010' : meta.communityId || '';
    }

    document.documentElement.dataset.activeCommunityId = isGlobal ? 'sos010' : meta.communityId || '';
    document.documentElement.dataset.communityBrandMode = isGlobal ? 'network' : 'community';
  }

  function onSwitch(ev) {
    const next = ev && ev.detail && ev.detail.next;
    applyBranding(next);
  }

  function boot() {
    applyBranding();
    window.addEventListener('sos-community-switch', onSwitch);
    window.addEventListener('sos-group-created', function () {
      applyBranding();
    });
  }

  const api = Object.freeze({
    applyBranding,
    SOS_LOGO,
    SOS_LOGO_MOBILE,
  });
  App.CommunityBrandingUi = api;
  window.SosCommunityBrandingUi = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
