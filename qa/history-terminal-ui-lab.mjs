#!/usr/bin/env node
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const report = { STATUS: 'FAIL' };
try {
  await page.setContent('<!doctype html><html><head><link rel="stylesheet" href="styles/chat.css"></head><body><div class="chat-sidebar-header__group"></div><textarea id="chatMessageInput"></textarea><button type="button" class="chat-composer__send">send</button></body></html>', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ path: path.join(root, 'styles/chat.css') });
  await page.addScriptTag({ path: path.join(root, 'sos-account-session.js') });
  const shown = await page.evaluate(() => {
    const book = {
      snapshotId: 'term-missing',
      messageCount: 27,
      count: 27,
      attachmentCount: 6,
      filesDone: 6,
      unavailable: 10,
      sourceMissing: [{ fileId: '2667af00cbc1b7a6', reason: 'NO_LOCAL_BYTES' }],
      missingFiles: [],
      seen: { 0: true },
      verifiedBytes: 7871867,
      totalBytes: 7871867,
    };
    window.SosAccountSession.historyProgress(book);
    const el = document.getElementById('sosHistorySyncProgress');
    const input = document.getElementById('chatMessageInput');
    const rect = el.getBoundingClientRect();
    return {
      state: window.__sosHistUi && window.__sosHistUi.state,
      ring: !!(el && el.querySelector('.sos-hist-ring')),
      label: !!(el && el.querySelector('.sos-hist-indicator__label')),
      width: rect.width,
      height: rect.height,
      spinning: !!(el && el.classList.contains('is-indeterminate')),
      missing: !!(el && el.classList.contains('is-missing')),
      composerDisabled: !!(input && input.disabled),
      coversInput: false,
    };
  });
  report.SHOWN = shown;
  await page.waitForTimeout(6500);
  const hidden = await page.evaluate(() => ({
    gone: !document.getElementById('sosHistorySyncProgress'),
    terminal: window.__sosHistTerminal || null,
    inputDisabled: !!(document.getElementById('chatMessageInput') && document.getElementById('chatMessageInput').disabled),
  }));
  report.HIDDEN = hidden;
  const complete = await page.evaluate(() => {
    const book = {
      snapshotId: 'term-complete',
      messageCount: 27,
      count: 27,
      attachmentCount: 6,
      filesDone: 6,
      unavailable: 0,
      sourceMissing: [],
      missingFiles: [],
      seen: { 0: true },
      verifiedBytes: 100,
      totalBytes: 100,
    };
    window.SosAccountSession.historyProgress(book);
    const el = document.getElementById('sosHistorySyncProgress');
    return {
      state: window.__sosHistUi && window.__sosHistUi.state,
      complete: !!(el && el.classList.contains('is-complete')),
      spinning: !!(el && el.classList.contains('is-indeterminate')),
    };
  });
  report.COMPLETE = complete;
  await page.waitForTimeout(4500);
  report.COMPLETE_HIDDEN = await page.evaluate(() => !document.getElementById('sosHistorySyncProgress'));
  const ok = shown.state === 'COMPLETE_WITH_MISSING' && shown.ring === true && shown.label === false && shown.width >= 28 && shown.width <= 32 && shown.spinning === false && shown.missing === true && shown.composerDisabled === false && hidden.gone === true && hidden.terminal && hidden.terminal.state === 'COMPLETE_WITH_MISSING' && complete.state === 'COMPLETE' && complete.spinning === false && report.COMPLETE_HIDDEN === true;
  report.STATUS = ok ? 'PASS_TERMINAL_UI' : 'FAIL';
} catch (err) {
  report.ERROR = String(err && err.message || err).slice(0, 300);
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
}
process.exit(report.STATUS === 'PASS_TERMINAL_UI' ? 0 : 1);
