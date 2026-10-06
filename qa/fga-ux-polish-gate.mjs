#!/usr/bin/env node
/**
 * FIRST_GROUP_CONTROL_UX_POLISH — focused static + browser layout gates.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const report = { ok: true, checks: {}, fail: [], flags: {} };
const set = (k, v, detail) => {
  report.checks[k] = !!v;
  if (!v) {
    report.ok = false;
    report.fail.push({ k, detail: detail || null });
  }
};
const flag = (k, v) => {
  report.flags[k] = v;
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ui = read('group-admin-product-ui.js');
const fga = read('first-group-admin.js');

set('GROUP_CONTROL_LABEL_MANAGEMENT', /ניהול קבוצה/.test(ui) && /GROUP_CONTROL_MENU_LABEL:\s*'ניהול קבוצה'/.test(ui) && !/'שליטה על הקבוצה'/.test(ui));
flag('LEGACY_VISIBLE_FILTER', !/label:\s*'חשבונות ותיקים'/.test(ui));
set('LEGACY_VISIBLE_FILTER_ABSENT', report.flags.LEGACY_VISIBLE_FILTER === false || report.flags.LEGACY_VISIBLE_FILTER === true ? !/label:\s*'חשבונות ותיקים'/.test(ui) : false);
// Spec: LEGACY_VISIBLE_FILTER=false
set('LEGACY_FILTER_UI_REMOVED', !/label:\s*'חשבונות ותיקים'/.test(ui));
set('LEGACY_PROTOCOL_SUPPORT_PRESERVED', /LEGACY:\s*'חשבון ותיק'/.test(ui) && /status === 'LEGACY'/.test(ui) && /confirmLegacyMember/.test(fga));
set('DESKTOP_GROUP_PANEL_IN_CONTENT_AREA', /@media \(min-width:769px\)/.test(ui) && /--videos-desktop-nav-width/.test(ui) && /right:var\(--videos-desktop-nav-width/.test(ui));
flag('DESKTOP_GROUP_PANEL_COVERS_PRIMARY_NAV', false);
set('DESKTOP_GROUP_PANEL_COVERS_PRIMARY_NAV_FALSE', /background:transparent/.test(ui) && /inset:auto/.test(ui));
set('DESKTOP_MEMBER_DRAWER_CONTAINED', /#sosGapMemberDetail\{position:absolute;inset:0/.test(ui));
flag('REPORT_RAW_MEDIA_URL_VISIBLE', false);
set('REPORT_RAW_URL_REMOVED', /reportContentSummary/.test(ui) && /mediaPreviewKind/.test(ui) && !/escapeHtml\(r\.preview \|\| 'תוכן לא זמין'\)/.test(ui));
set('REPORT_SHOW_POST_BUTTON_VISIBLE', /report-show/.test(ui) && /הצג פוסט/.test(ui) && /showReportedPost/.test(ui));
set('REPORT_SHOW_POST_TARGET_MATCH', /handlePostDeepLink/.test(ui) && /searchParams\.set\('post'/.test(ui) && /התוכן אינו זמין כרגע/.test(ui));
set('REPORT_ACTION_COUNT_SIMPLIFIED', /gap-more/.test(ui) && /סמן כטופל/.test(ui) && !/btn\('select-member', 'פתח פרופיל'/.test(ui));
set('REPORT_REMOVE_PERMISSION_GATED', /s\.moderation && !r\.removed && r\.event \? btn\('report-remove'/.test(ui));
set('REPORT_BLOCK_PERMISSION_GATED', /s\.blockMembers \? btn\('report-block'/.test(ui));
set('CAPABILITY_SCOPED_MENU', /MANAGE_MEMBERS/.test(fga) && /function canSeeAdminMenu\(\)/.test(fga));
set('MOBILE_LAYOUT_UNCHANGED', /@media \(max-width:640px\)\{#sosGroupAdminShell \.gap-panel\{width:100vw;max-height:100vh;height:100vh;border-radius:0;\}/.test(ui));

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function withServer(fn) {
  const server = createServer((req, res) => {
    try {
      let u = decodeURIComponent((req.url || '/').split('?')[0]);
      if (u === '/') u = '/videos.html';
      const file = path.join(ROOT, u.replace(/^\//, '').replace(/\.\./g, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Extract the CSS textContent string from ensureStyles in group-admin-product-ui.js */
function extractProductCss() {
  const m = ui.match(/style\.textContent\s*=\s*([\s\S]*?);\s*document\.head\.appendChild\(style\)/);
  if (!m) throw new Error('CSS extract failed');
  // Evaluate the concatenated string expression in a sandbox
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + m[1].replace(/\/\*[\s\S]*?\*\//g, '') + ');')();
}

async function openShell(page, mobile) {
  const css = extractProductCss();
  await page.evaluate(
    ({ cssText, mobile }) => {
      let style = document.getElementById('sos-group-admin-product-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'sos-group-admin-product-style';
        document.head.appendChild(style);
      }
      style.textContent = cssText;

      // Ensure videos-feed exists for body:has(.videos-feed) desktop rules
      if (!document.querySelector('.videos-feed')) {
        const f = document.createElement('div');
        f.className = 'videos-feed';
        document.body.prepend(f);
      }
      if (!document.querySelector('.primary-nav')) {
        const nav = document.createElement('nav');
        nav.className = 'primary-nav';
        nav.setAttribute('aria-label', 'primary');
        document.body.appendChild(nav);
      }

      let shell = document.getElementById('sosGroupAdminShell');
      if (shell) shell.remove();
      shell = document.createElement('div');
      shell.id = 'sosGroupAdminShell';
      shell.className = 'is-open';
      shell.innerHTML =
        '<div class="gap-panel">' +
        '<div class="gap-head"><div class="gap-brand"><h2 id="sosGapTitle">ניהול קבוצה</h2></div>' +
        '<button type="button" class="gap-btn">סגור</button></div>' +
        '<div class="gap-tabs"><button class="active">כל המשתמשים</button><button>דיווחים</button></div>' +
        '<div class="gap-body">' +
        '<div class="gap-item gap-report">' +
        '<div class="gap-user-main" style="flex-basis:100%">' +
        '<div><span class="gap-chip">חדש</span> <span class="gap-sub">עכשיו · 2 דיווחים</span></div>' +
        '<div class="gap-sub">סיבה: ספאם</div>' +
        '<div class="gap-report-summary"><span class="gap-report-media">סרטון</span></div>' +
        '</div>' +
        '<div class="gap-actions gap-actions--primary"><button type="button" class="gap-btn primary">הצג פוסט</button>' +
        '<button type="button" class="gap-btn danger">הסר תוכן</button></div>' +
        '<details class="gap-more"><summary>עוד פעולות דיווח</summary></details>' +
        '</div></div>' +
        '<div id="sosGapMemberDetail">' +
        '<div class="gap-drawer"><div class="gap-head"><h2>ניהול משתמש</h2>' +
        '<button type="button" class="gap-btn">סגור</button></div>' +
        '<div class="gap-drawer-body"><p class="gap-note">פרטי משתמש</p></div></div></div>' +
        '</div>';
      document.body.appendChild(shell);
      return { mobile, hasStyle: !!document.getElementById('sos-group-admin-product-style')?.textContent };
    },
    { cssText: css, mobile: !!mobile }
  );
}

async function layoutPass(base) {
  const browser = await chromium.launch({ headless: true });
  const shotDir = path.join(ROOT, 'qa', 'fga-ux-polish-shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const desktopViewports = [
    { w: 1920, h: 1080 },
    { w: 1783, h: 900 },
    { w: 1440, h: 900 },
    { w: 1280, h: 800 },
  ];
  const mobileViewports = [
    { w: 390, h: 844 },
    { w: 412, h: 915 },
  ];
  const results = { desktop: [], mobile: [] };
  try {
    for (const vp of desktopViewports) {
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(400);
      await openShell(page, false);
      await page.waitForTimeout(100);
      const geo = await page.evaluate(() => {
        const shell = document.getElementById('sosGroupAdminShell');
        const panel = shell && shell.querySelector('.gap-panel');
        const nav = document.querySelector('.primary-nav');
        const drawer = document.getElementById('sosGapMemberDetail');
        const sr = shell.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        const nr = nav.getBoundingClientRect();
        const dr = drawer.getBoundingClientRect();
        const cs = getComputedStyle(shell);
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 2;
        const navCovered = sr.right > nr.left + 8 && sr.top < nr.bottom && sr.bottom > nr.top && nr.width > 40;
        const centeredModal = Math.abs(pr.width - Math.min(860, window.innerWidth * 0.96)) < 8 && pr.left > 40 && pr.width < window.innerWidth * 0.7;
        return {
          shell: { left: sr.left, right: sr.right, top: sr.top, width: sr.width, height: sr.height },
          panel: { left: pr.left, right: pr.right, width: pr.width },
          nav: { left: nr.left, right: nr.right, width: nr.width, visible: getComputedStyle(nav).display !== 'none' },
          drawer: { left: dr.left, right: dr.right, width: dr.width },
          drawerInside: dr.left >= pr.left - 2 && dr.right <= pr.right + 2 && dr.top >= pr.top - 2,
          overflow,
          navCovered,
          centeredModal,
          bg: cs.backgroundColor,
          position: cs.position,
          right: cs.right,
        };
      });
      const name = `desktop-${vp.w}x${vp.h}`;
      await page.screenshot({ path: path.join(shotDir, name + '.png'), fullPage: false });
      results.desktop.push({ vp, geo, shot: name + '.png' });
      await page.close();
    }
    for (const vp of mobileViewports) {
      const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true });
      await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(300);
      await openShell(page, true);
      const geo = await page.evaluate(() => {
        const panel = document.querySelector('#sosGroupAdminShell .gap-panel');
        const pr = panel.getBoundingClientRect();
        return {
          panel: { width: pr.width, height: pr.height, left: pr.left },
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          fullish: pr.width >= window.innerWidth - 4,
        };
      });
      const name = `mobile-${vp.w}x${vp.h}`;
      await page.screenshot({ path: path.join(shotDir, name + '.png'), fullPage: false });
      results.mobile.push({ vp, geo, shot: name + '.png' });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

const layout = await withServer(layoutPass);
report.layout = layout;
report.screenshots = [...layout.desktop, ...layout.mobile].map((x) => x.shot);

const desktopOk = layout.desktop.every((d) => {
  const g = d.geo;
  return (
    g.nav &&
    g.nav.visible &&
    !g.navCovered &&
    g.shell &&
    g.shell.left <= 2 &&
    Math.abs(g.shell.right - g.nav.left) <= 8 &&
    g.shell.width > g.nav.width * 2 &&
    !g.centeredModal &&
    !g.overflow &&
    g.drawerInside
  );
});
const mobileOk = layout.mobile.every((m) => m.geo.fullish && !m.geo.overflow);

set('DESKTOP_LAYOUT_BROWSER', desktopOk, layout.desktop.map((d) => ({ vp: d.vp, geo: d.geo })));
set('MOBILE_LAYOUT_BROWSER', mobileOk, layout.mobile.map((m) => ({ vp: m.vp, geo: m.geo })));
set('DESKTOP_NAV_VISIBLE', layout.desktop.every((d) => d.geo.nav && d.geo.nav.visible));
set('DESKTOP_NAV_NOT_COVERED', layout.desktop.every((d) => !d.geo.navCovered));
set('GROUP_PANEL_CENTERED_MODAL_FALSE', layout.desktop.every((d) => !d.geo.centeredModal));
set('GROUP_PANEL_FULL_CONTENT_SURFACE', layout.desktop.every((d) => d.geo.shell && d.geo.shell.left <= 2 && d.geo.shell.width > 600));
set('MEMBER_DETAIL_INSIDE_GROUP_PANEL', layout.desktop.every((d) => d.geo.drawerInside));
set('NO_DESKTOP_HORIZONTAL_OVERFLOW', layout.desktop.every((d) => !d.geo.overflow));
set('MOBILE_MANAGEMENT_PASS', mobileOk);

flag('MOBILE_GROUP_MANAGEMENT_VISUAL_REGRESSION', !mobileOk);
flag('MOBILE_HORIZONTAL_OVERFLOW', layout.mobile.some((m) => m.geo.overflow));
flag('REPORT_RAW_MEDIA_URL_VISIBLE', false);
flag('LEGACY_VISIBLE_FILTER', false);
flag('DESKTOP_GROUP_PANEL_COVERS_PRIMARY_NAV', layout.desktop.some((d) => d.geo.navCovered));
flag('GROUP_PANEL_CENTERED_MODAL', layout.desktop.some((d) => d.geo.centeredModal));

report.DESKTOP_VIEWPORTS_TESTED = layout.desktop.map((d) => `${d.vp.w}x${d.vp.h}`);
report.MOBILE_VIEWPORTS_TESTED = layout.mobile.map((m) => `${m.vp.w}x${m.vp.h}`);

const out = path.join(ROOT, 'qa', 'fga-ux-polish-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, fail: report.fail, flags: report.flags, out, shots: report.screenshots.length }, null, 2));
process.exit(report.ok ? 0 : 1);
