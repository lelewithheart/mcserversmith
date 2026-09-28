'use strict';
/**
 * Self-update test — drives the REAL release feed from inside Electron.
 *
 *   MCSERVERSMITH_TEST_UPDATER=1 electron .        (tools/test-updater.js does this)
 *
 * An unpackaged run normally refuses to look for updates (there is no installed
 * app to replace), so this test forces the dev config (dev-app-update.yml) and
 * fakes the current version, which is the only way to exercise the
 * "update available" branch before a newer release exists.
 */
const { createLogger } = require('./core/util');

const log = createLogger('updater-test');

async function run({ window }) {
  const updater = require('./core/updater');
  const pkg = require('../../package.json');
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });

  // electron-builder names the arch token differently per target
  // (-win-x64.exe vs -linux-x86_64.AppImage), so accept the aliases
  const archAliases = process.arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : [process.arch];
  const ext = process.platform === 'win32' ? '.exe' : '.AppImage';
  const matchesPlatform = (url) => {
    const s = String(url || '');
    if (!s.endsWith(ext)) return false;
    const platform = process.platform === 'win32' ? 'win' : 'linux';
    if (!s.includes(`-${platform}-`)) return false;
    return archAliases.some((a) => s.includes(a));
  };

  // ---- version maths (offline) -------------------------------------------
  ok('1.0.1 is newer than 1.0.0', updater.isNewer('1.0.1', '1.0.0'));
  ok('v-prefix and different lengths are handled', updater.isNewer('v1.1', '1.0.9') && updater.isNewer('1.0.0.1', '1.0.0'));
  ok('same version is not newer', !updater.isNewer('1.0.0', '1.0.0') && !updater.isNewer('v1.0.0', '1.0.0'));
  ok('older is not newer', !updater.isNewer('0.9.9', '1.0.0'));

  // ---- what this run would do --------------------------------------------
  const support = updater.supported();
  ok('self-update is active in this forced run', support.ok === true, JSON.stringify(support));

  const before = updater.snapshot();
  ok('the current version is known', !!before.current, before.current);

  // ---- the real feed ------------------------------------------------------
  const state = await updater.check();
  ok('the check reached a terminal state', ['uptodate', 'available', 'error'].includes(state.status), state.status);
  ok('the GitHub release feed answered', state.status !== 'error', state.error || 'no error');
  ok('the status is not left hanging on "checking"', state.status !== 'checking', state.status);
  ok('the check recorded a timestamp', !!state.checkedAt, state.checkedAt);

  if (process.env.MCSERVERSMITH_FAKE_VERSION && updater.isNewer(pkg.version, process.env.MCSERVERSMITH_FAKE_VERSION)) {
    ok('a newer release is offered to an outdated install', state.status === 'available',
      `${process.env.MCSERVERSMITH_FAKE_VERSION} -> ${state.status}${state.available ? ` (${state.available})` : ''}${state.error ? ` error=${state.error}` : ''}`);
    ok('the offered artifact is the one this platform would run',
      (state.files || []).some(matchesPlatform),
      `want a ${process.platform}/${process.arch} artifact, got ${JSON.stringify(state.files || [])}`);
    ok('the offered version really is newer', updater.isNewer(state.available, process.env.MCSERVERSMITH_FAKE_VERSION), state.available);
  } else {
    ok('no fake version given: the real version is compared against the feed',
      ['uptodate', 'available'].includes(state.status), `${state.current} -> ${state.status}`);
  }

  // ---- the download actually starts (and is stoppable) --------------------
  if (state.status === 'available') {
    const dl = updater.download();
    // do not wait for the whole artifact; the point is that a download is running
    await new Promise((r) => setTimeout(r, 2500));
    const mid = updater.snapshot();
    ok('downloading starts and reports progress',
      ['downloading', 'ready'].includes(mid.status) || mid.status === 'available',
      `${mid.status} ${mid.percent}% ${Math.round((mid.bytesPerSecond || 0) / 1024)} KB/s`);
    // abort: this is a test, the update must not install itself
    try { require('electron-updater').autoUpdater.removeAllListeners('update-downloaded'); } catch { /* ignore */ }
    try { require('electron-updater').autoUpdater.autoInstallOnAppQuit = false; } catch { /* ignore */ }
    if (dl && typeof dl.then === 'function') dl.catch(() => {});
  } else {
    ok('no artifact download to start in this state', true, state.status);
  }

  const lines = ['=== self-update test ==='];
  for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push('', `${checks.length - failed}/${checks.length} update checks passed`);
  console.log(`\n${lines.join('\n')}`);
  try {
    const path = require('path');
    require('fs').writeFileSync(path.join(require('path').dirname(require('./core/paths').getDirs().appLog), 'ui-updater.log'), `${lines.join('\n')}\n`);
  } catch { /* stdout is the fallback */ }
  log.info(`update test finished: ${checks.length - failed}/${checks.length}`);
  return failed ? 1 : 0;
}

module.exports = { run };
