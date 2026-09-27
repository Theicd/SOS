/**
 * Package 898 — exact 404 / failed-resource audit (production 897 vs local 898 RC).
 * Records every response >= 400 with its URL, resource type and initiator, for guest and logged-in sessions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package898-404-audit-report.json');
const TARGETS = {
  PRODUCTION_897: 'https://sos010.com/videos.html',
  LOCAL_898: process.env.SOS_404_LOCAL || 'http://127.0.0.1:8794/videos.html',
};
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function audit(browser, url, loggedIn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (res) => {
    if (res.status() >= 400) {
      const req = res.request();
      bad.push({ status: res.status(), url: res.url(), type: req.resourceType(), frame: req.frame() === page.mainFrame() ? 'main' : 'sub' });
    }
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (/^https?:/.test(u)) bad.push({ status: 'FAILED', url: u, type: req.resourceType(), error: (req.failure() || {}).errorText || '' });
  });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /404|Failed to load resource/.test(m.text())) consoleErrors.push({ text: m.text().slice(0, 160), loc: m.location() && m.location().url });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, null, { timeout: 120000 }).catch(() => {});
  if (loggedIn) {
    await page.evaluate((k) => {
      const App = window.NostrApp;
      const c = App.createNewIdentityExplicit({ privateKeyHex: k });
      App.guestMode = false;
      App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
      try {
        window.dispatchEvent(new CustomEvent('sos-identity-ready'));
      } catch (_e) {}
    }, hex(generateSecretKey()));
  }
  await sleep(30000);
  await ctx.close();
  return { bad, consoleErrors };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const report = { gate: 'PACKAGE898_404_AUDIT', ts: new Date().toISOString(), runs: {} };
  for (const [name, url] of Object.entries(TARGETS)) {
    for (const loggedIn of [false, true]) {
      const key = name + (loggedIn ? '_LOGGED_IN' : '_GUEST');
      try {
        report.runs[key] = await audit(browser, url, loggedIn);
      } catch (e) {
        report.runs[key] = { error: String(e.message || e) };
      }
      const r = report.runs[key];
      const n404 = (r.bad || []).filter((b) => b.status === 404);
      console.log(key, '404s:', n404.length, 'console404:', (r.consoleErrors || []).length);
      n404.forEach((b) => console.log('  ', b.status, b.type, b.url.slice(0, 160)));
    }
  }
  await browser.close();
  const uniq = new Map();
  Object.entries(report.runs).forEach(([run, r]) =>
    (r.bad || [])
      .filter((b) => b.status === 404)
      .forEach((b) => {
        const k = b.url.replace(/[?#].*$/, '');
        const row = uniq.get(k) || { url: k, type: b.type, runs: [] };
        if (!row.runs.includes(run)) row.runs.push(run);
        uniq.set(k, row);
      })
  );
  report.unique404 = Array.from(uniq.values());
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('UNIQUE_404', report.unique404.length);
}

main();
