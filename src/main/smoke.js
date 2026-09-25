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

    // ---- settings: checkboxes + language dropdown -----------------------
    const settingsBtn = document.querySelector('[data-action="goto"][data-view="settings"]');
    if (settingsBtn) settingsBtn.click();
    await sleep(900);

    const cbSel = '#content input[data-setting="closeToTray"]';
    const cb0 = $(cbSel);
    ok('settings checkbox present', !!cb0);
    if (cb0) {
      const before = cb0.checked;
      cb0.click();
      await sleep(800);
      const cb1 = $(cbSel);
      const after = cb1 ? cb1.checked : null;
      ok('settings checkbox toggles on click', after === !before, String(before) + ' -> ' + String(after) + (cb1 ? '' : ' (element gone)'));
      const stored = (await window.mcss.app.getSettings()).data.closeToTray;
      ok('settings checkbox persists', stored === after, 'stored=' + stored + ' dom=' + after);
      if (cb1) { cb1.click(); await sleep(600); }   // put it back
    }

    ok('disclaimer shown in settings', document.body.textContent.includes('NOT AN OFFICIAL MINECRAFT PRODUCT'));
    const ipBox = $('#content input[data-setting="showPublicIp"]');
    ok('public-ip privacy toggle present', !!ipBox);
    if (ipBox) {
      const before = ipBox.checked;
      ipBox.click();
      await sleep(700);
      const after = (await window.mcss.app.getSettings()).data.showPublicIp;
      ok('public-ip toggle persists', after === !before, String(before) + ' -> ' + String(after));
      const back = $('#content input[data-setting="showPublicIp"]');
      if (back) { back.click(); await sleep(500); }
    }

    const langSel = $('#setting-language');
    ok('settings language dropdown present', !!langSel);
    if (langSel) {
      const before = langSel.value;
      langSel.value = 'de';
      langSel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1000);
      const title = ($('#view-title') || {}).textContent || '';
      const stored = (await window.mcss.app.getSettings()).data.language;
      ok('settings language dropdown switches UI', stored === 'de' && !/server, in about/i.test(title), 'stored=' + stored + ' title="' + title.slice(0, 40) + '"');
      // and back
      const back = $('#setting-language');
      if (back) {
        back.value = 'en';
        back.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(900);
      }
      ok('language reverts to english', ((await window.mcss.app.getSettings()).data.language) === 'en', before + ' -> ' + ((await window.mcss.app.getSettings()).data.language));
    }

    // ---- wizard checkboxes: the bug that made the wizard unusable -------
    // Spigot is an "advanced" provider: step 1 refuses to continue until the
    // user ticks the acknowledgement box, so this exercises both the checkbox
    // toggle itself and the button it gates.
    const newBtn2 = document.querySelector('[data-action="new-server"]');
    if (newBtn2) { newBtn2.click(); await sleep(800); }
    const name2 = $('#wz-name');
    if (name2) {
      name2.value = 'checkbox-test';
      name2.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(200);
    const spigotCard = [...document.querySelectorAll('.type-card')].find((c) => /Spigot/i.test(c.textContent));
    ok('spigot type card present', !!spigotCard);
    if (spigotCard) { spigotCard.click(); await sleep(2600); }

    const advBox = $('#wz-advanced');
    ok('advanced acknowledgement checkbox shown', !!advBox);
    const nextBefore = document.querySelector('[data-action="wizard-next"]');
    ok('next blocked until acknowledged', !!nextBefore && nextBefore.disabled === true, nextBefore ? String(nextBefore.disabled) : 'no button');
    if (advBox) {
      advBox.click();
      await sleep(500);
      const advAfter = $('#wz-advanced');
      ok('wizard checkbox toggles', !!advAfter && advAfter.checked === true, advAfter ? String(advAfter.checked) : 'gone');
      const nextAfter = document.querySelector('[data-action="wizard-next"]');
      ok('next unblocks after acknowledging', !!nextAfter && nextAfter.disabled === false, nextAfter ? String(nextAfter.disabled) : 'no button');
    }

    // walk to the last step and confirm the EULA box enables "Create and install"
    let step = 1;
    for (;;) {
      const btn = document.querySelector('[data-action="wizard-next"]');
      if (!btn || btn.disabled) break;
      btn.click();
      await sleep(step === 1 ? 2600 : 900);
      step += 1;
      if (step > 4) break;
    }
    ok('wizard reached the final step', step >= 4, 'step ' + step);
    const eulaBox = $('#wz-eula');
    ok('eula checkbox present on the final step', !!eulaBox);
    const createBefore = document.querySelector('[data-action="wizard-create"]');
    ok('create blocked before eula is accepted', !!createBefore && createBefore.disabled === true, createBefore ? String(createBefore.disabled) : 'no button');
    if (eulaBox) {
      eulaBox.click();
      await sleep(500);
      const createAfter = document.querySelector('[data-action="wizard-create"]');
      ok('create unblocks after accepting the eula', !!createAfter && createAfter.disabled === false, createAfter ? String(createAfter.disabled) : 'no button');
    }
    const cancel3 = document.querySelector('[data-action="wizard-cancel"]');
    if (cancel3) cancel3.click();
    await sleep(300);

    // ---- files tab ------------------------------------------------------
    const made = await window.mcss.instances.create({
      name: 'files-smoke', provider: 'paper', mcVersion: '1.21.4',
      port: 25577, rconPort: 26577, acceptEula: true, memoryMB: 1024,
      confirmedAdvanced: true
    });
    const instId = made && made.ok ? made.data.id : null;
    ok('test instance created for the files tab', !!instId, instId || (made && made.error));

    if (instId) {
      state.instances = (await window.mcss.instances.list()).data || [];
      state.activeId = instId;
      state.settings.filesAdvanced = false;
      state.view = 'server';
      state.tab = 'files';
      await refreshFiles();
      await sleep(600);   // rerender() is coalesced through setTimeout

      const simpleRows = document.querySelectorAll('#content table tbody tr');
      ok('files: simple view lists entries', simpleRows.length > 0, simpleRows.length + ' rows');
      const simpleText = $('#content').textContent;
      ok('files: simple view shows server.properties', simpleText.includes('server.properties'));
      ok('files: simple view explains itself', !!$('#content .muted') && /Einfach|Simple|touch|anfasst/i.test(simpleText));

      // switch to the advanced view through the real button
      const advBtn = document.querySelector('[data-action="files-mode"][data-mode="advanced"]');
      ok('files: view switch present', !!advBtn);
      if (advBtn) { advBtn.click(); await sleep(900); }
      ok('files: advanced mode is persisted', (await window.mcss.app.getSettings()).data.filesAdvanced === true);
      const advText = $('#content').textContent;
      ok('files: advanced view lists the folder', advText.includes('server.properties'), advText.length + ' chars');

      // navigate + create + delete through the IPC the UI uses
      const inside = await window.mcss.files.list(instId, '');
      ok('files: list IPC returns entries', Array.isArray(inside.data.entries) && inside.data.entries.length > 0,
        inside.data && inside.data.entries ? inside.data.entries.length + ' entries' : 'none');
      await window.mcss.files.mkdir(instId, '', 'smoke-dir');
      const afterMkdir = await window.mcss.files.list(instId, '');
      ok('files: folder created', afterMkdir.data.entries.some((e) => e.name === 'smoke-dir' && e.dir));
      const inSmoke = await window.mcss.files.list(instId, 'smoke-dir');
      ok('files: can enter the new folder', inSmoke.data.path === 'smoke-dir', inSmoke.data.path);
      ok('files: traversal is refused', !(await window.mcss.files.list(instId, '../../..')).ok);
      ok('files: can delete the folder', (await window.mcss.files.remove(instId, 'smoke-dir')).ok);
      const afterDelete = await window.mcss.files.list(instId, '');
      ok('files: folder is gone', !afterDelete.data.entries.some((e) => e.name === 'smoke-dir'));

      // back to simple, then clean up the test instance
      const simpleBtn = document.querySelector('[data-action="files-mode"][data-mode="simple"]');
      if (simpleBtn) { simpleBtn.click(); await sleep(900); }
      ok('files: back to simple mode', (await window.mcss.app.getSettings()).data.filesAdvanced === false);

      // a plugin server must offer "Plugins", not "Mods", and the world folder
      // must appear as soon as it exists
      await window.mcss.files.mkdir(instId, '', 'world');
      await window.mcss.files.mkdir(instId, '', 'plugins');
      await refreshFiles();
      await sleep(700);
      const filled = $('#content').textContent;
      const pluginRows = document.querySelectorAll('#content table tbody tr').length;
      ok('files: plugin server shows a Plugins entry', filled.includes('Plugins'), pluginRows + ' rows');
      ok('files: world appears once it exists', /Welt|World/.test(filled));
      ok('files: mods entry is not shown for a plugin server', !/Mod-Konfigurationen|Mod configs/.test(filled));

      await window.mcss.instances.remove(instId, true);
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
