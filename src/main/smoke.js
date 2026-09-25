'use strict';
/**
 * Automated UI smoke test.
 *
 *   MCSERVERSMITH_SMOKE=1 electron .
 *
 * Loads the real renderer, waits for the IPC round trips in boot() to finish,
 * then drives the UI (open wizard, switch views, switch language) and prints a
 * JSON report. Exits non-zero if a check fails. Used by CI and by hand.
 */
const { createLogger } = require('./core/util');

const log = createLogger('smoke');

const READY_DELAY_MS = Number(process.env.MCSERVERSMITH_SMOKE_DELAY || 5000);

function script() {
  return `(async () => {
    const out = { checks: [], consoleErrors: [] };
    const ok = (name, cond, detail) => out.checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
    const $ = (s) => document.querySelector(s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // capture anything the renderer throws from here on
    window.onerror = (msg) => out.consoleErrors.push(String(msg));
    window.addEventListener('unhandledrejection', (e) => out.consoleErrors.push('unhandled: ' + (e.reason && e.reason.message)));

    // ---- initial render -------------------------------------------------
    ok('preload bridge present', typeof window.mcss === 'object' && !!window.mcss.instances);
    ok('app version rendered', /^v\\d/.test(($('#brand-version') || {}).textContent || ''), ($('#brand-version') || {}).textContent);
    ok('licence badge rendered', !!(($('#license-badge') || {}).textContent || '').trim(), ($('#license-badge') || {}).textContent);
    ok('sidebar instance list exists', !!$('#instance-list'));
    ok('content has markup', (($('#content') || {}).innerHTML || '').length > 200, (($('#content') || {}).innerHTML || '').length + ' chars');
    ok('welcome hero visible (no servers yet)', !!$('.hero'));
    ok('language select populated', (($('#language-select') || {}).options || []).length >= 2, (($('#language-select') || {}).options || []).length + ' options');
    ok('no error toasts on boot', document.querySelectorAll('.toast.error').length === 0,
      [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));

    // ---- i18n actually applies ------------------------------------------
    const enTitle = ($('#view-title') || {}).textContent || '';
    const deDict = await window.mcss.i18n.get('de');
    ok('i18n IPC returns German', !!(deDict && deDict.ok && deDict.data && String(deDict.data['welcome.title'] || '').startsWith('Dein')),
      deDict && deDict.data ? String(deDict.data['welcome.title'] || '').slice(0, 40) : ('error: ' + (deDict && deDict.error)));
    const sel = $('#language-select');
    if (sel) {
      sel.value = 'de';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1200);
      const deTitle = ($('#view-title') || {}).textContent || '';
      ok('language switch changes UI text', deTitle !== enTitle && deTitle.length > 0, enTitle + ' -> ' + deTitle);
      sel.value = 'en';
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
    }

    // ---- wizard ---------------------------------------------------------
    const newBtn = document.querySelector('[data-action="new-server"]');
    newBtn.click();
    await sleep(900);
    ok('wizard modal opens', !!$('.modal'));
    const typeCards = document.querySelectorAll('.type-card');
    ok('server types listed in wizard', typeCards.length >= 7, typeCards.length + ' types');
    const typeNames = [...typeCards].map((c) => (c.querySelector('.t-name') || {}).textContent || '').join(',').trim();
    ok('type labels are translated', typeNames.length > 20 && !typeNames.includes('.desc'), typeNames.slice(0, 90));

    // type the name first (before touching a type card) — the Next button must
    // enable itself live, otherwise step 1 is a dead end
    const nextBtn0 = document.querySelector('[data-action="wizard-next"]');
    ok('next is disabled before a name is given', !!nextBtn0 && nextBtn0.disabled === true, nextBtn0 ? String(nextBtn0.disabled) : 'no button');
    const nameInput = $('#wz-name');
    if (nameInput) {
      nameInput.value = 'smoke-test';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(300);
    const nextBtn = document.querySelector('[data-action="wizard-next"]');
    ok('next enables live while typing', !!nextBtn && nextBtn.disabled === false, nextBtn ? String(nextBtn.disabled) : 'no button');

    // now pick Paper
    const target = [...typeCards].find((c) => /Paper/i.test(c.textContent)) || typeCards[1];
    const picked = target ? target.textContent.trim().slice(0, 20) : '?';
    if (target) target.click();
    await sleep(2200);
    ok('wizard type click selected a type', !!target, picked);

    const nameStillThere = $('#wz-name');
    ok('name survives the re-render', !!nameStillThere && nameStillThere.value === 'smoke-test', nameStillThere ? nameStillThere.value : 'gone');

    // diagnostics: does the version IPC itself work?
    let ipcVersions = null;
    try {
      const res = await window.mcss.providers.versions('paper', false);
      ipcVersions = res && res.ok ? res.data.length : ('error: ' + (res && res.error));
    } catch (e) { ipcVersions = 'throw: ' + e.message; }
    ok('providers.versions IPC works', typeof ipcVersions === 'number' && ipcVersions > 5, String(ipcVersions));

    const nextBtn2 = document.querySelector('[data-action="wizard-next"]');
    if (nextBtn2) { nextBtn2.click(); await sleep(2500); }
    const versionButtons = document.querySelectorAll('[data-action="wizard-version"]');
    ok('wizard step 2 lists versions', versionButtons.length > 3, versionButtons.length + ' versions');
    const firstVersion = versionButtons[0] ? versionButtons[0].textContent.trim() : '';
    if (versionButtons[0]) versionButtons[0].click();
    await sleep(1500);
    ok('version selectable', !!firstVersion, firstVersion ? ('newest ' + firstVersion) : 'no versions');

    // live filter must hide non-matching entries without losing the list
    const filter = $('#wz-filter');
    if (filter && versionButtons.length) {
      filter.value = '1.21';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(400);
      const visible = [...document.querySelectorAll('[data-action="wizard-version"]')].filter((b) => b.style.display !== 'none').length;
      ok('version filter works', visible > 0 && visible < versionButtons.length, visible + ' of ' + versionButtons.length + ' visible');
    }

    // close the wizard again (do not actually install in the smoke test)
    const cancel = document.querySelector('[data-action="wizard-cancel"]');
    if (cancel) cancel.click();
    await sleep(400);
    ok('wizard closes', !$('.modal'));

    // ---- other views ----------------------------------------------------
    const views = [
      ['settings', 'Settings'],
      ['runtimes', 'Java'],
      ['cloud', '24/7'],
      ['license', 'Supporter']
    ];
    for (const [view, needle] of views) {
      const btn = document.querySelector('[data-action="goto"][data-view="' + view + '"]');
      if (!btn) { ok('nav ' + view + ' exists', false); continue; }
      btn.click();
      await sleep(700);
      const html = ($('#content') || {}).innerHTML || '';
      ok('view ' + view + ' renders', html.length > 150 && html.toLowerCase().includes(needle.toLowerCase().slice(0, 4)), html.length + ' chars');
    }

    ok('no uncaught renderer errors', out.consoleErrors.length === 0, out.consoleErrors.join(' | '));
    return out;
  })()`;
}

async function run({ window }) {
  const wc = window.webContents;
  await new Promise((resolve) => {
    if (!wc.isLoading()) resolve();
    else wc.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, READY_DELAY_MS));

  let report;
  try {
    report = await wc.executeJavaScript(script(), true);
  } catch (err) {
    console.log('SMOKE_CRASH ' + err.message);
    return 2;
  }

  const failed = (report.checks || []).filter((c) => !c.ok);
  console.log('\n=== UI smoke test ===');
  for (const c of report.checks || []) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${(report.checks || []).length - failed.length}/${(report.checks || []).length} UI checks passed`);
  log.info(`smoke test finished: ${(report.checks || []).length - failed.length}/${(report.checks || []).length}`);
  return failed.length ? 1 : 0;
}

module.exports = { run };
