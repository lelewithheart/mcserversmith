'use strict';
/**
 * Self-update (electron-updater + the GitHub Releases feed of this repo).
 *
 * Policy per distribution channel — the same rule the packaging docs state:
 * only the "download it from the release page" build updates itself.
 *   - GitHub Releases / itch download      -> self-update ON (this module)
 *   - itch desktop app (it manages installs and updates them itself) -> OFF
 *   - Microsoft Store / winget / Scoop / Flathub / Snap -> OFF (MCSERVERSMITH_STORE=1)
 *   - an unpackaged dev run                -> OFF (unless forced, see below)
 *
 * Nothing here runs silently: an available update is downloaded in the background
 * and installed on the next quit (autoInstallOnAppQuit), and the Settings tab always
 * shows what is going on — including *why* updates are off in a given build.
 *
 * Test hooks (used by tools/test-updater.js, harmless in production):
 *   MCSERVERSMITH_TEST_UPDATER=1   run a check on start and exit with a JSON report
 *   MCSERVERSMITH_FAKE_VERSION=x   pretend to be on version x (makes the
 *                                  "update available" path testable before 2.0.0 exists)
 *   MCSERVERSMITH_UPDATE_DELAY_MS  delay before the automatic start-up check
 */
const settings = require('./settings');
const { createLogger } = require('./util');

const log = createLogger('updater');

const DEFAULT_DELAY_MS = 8000;

const state = {
  status: 'idle',        // idle | checking | uptodate | available | downloading | ready | error | disabled
  current: null,
  available: null,
  files: [],             // artifact URLs the feed offers for this platform
  percent: 0,
  bytesPerSecond: 0,
  error: null,
  checkedAt: null,
  releaseUrl: null,
  reason: null           // why updates are off, when status === 'disabled'
};

let updater = null;
let emit = () => {};
let timer = null;

// ---------------------------------------------------------------------------
// version maths — pure, so it can be tested without Electron
function parse(v) {
  return String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => Number(n) || 0);
}

/** true when `candidate` is a newer version than `current` */
function isNewer(candidate, current) {
  const a = parse(candidate);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Why this build does not update itself, or null when it does. */
function disabledReason(execPath) {
  if (process.env.MCSERVERSMITH_STORE === '1') return 'store';
  // normalise separators: the same check has to work for C:\…\itch\… and /home/…/itch/…
  const p = String(execPath || '').toLowerCase().replace(/\\/g, '/');
  // itch installs live under its own apps folder and are updated by the itch client
  if (p.includes('/itch/') || p.includes('itchio')) return 'itch';
  return null;
}

function supported() {
  const { app } = require('electron');
  const reason = disabledReason(process.execPath);
  if (reason) return { ok: false, reason };
  if (!app.isPackaged && process.env.MCSERVERSMITH_UPDATE_DEV !== '1') return { ok: false, reason: 'dev' };
  return { ok: true, reason: null };
}

function snapshot() {
  return { ...state };
}

function setState(patch) {
  Object.assign(state, patch);
  try { emit(snapshot()); } catch { /* a dead window must not break the updater */ }
  return snapshot();
}

function currentVersion() {
  if (process.env.MCSERVERSMITH_FAKE_VERSION) return process.env.MCSERVERSMITH_FAKE_VERSION;
  try { return require('electron').app.getVersion(); } catch { return require('../../../package.json').version; }
}

/**
 * Test hook: electron-updater does its own version comparison against
 * app.getVersion(), so faking only *our* copy of the number would leave the real
 * updater thinking "not available" and the download path untestable
 * ("Please check update first"). Only ever active for the test run.
 */
function applyFakeVersion() {
  const fake = process.env.MCSERVERSMITH_FAKE_VERSION;
  if (!fake) return false;
  const { app } = require('electron');
  if (app.isPackaged && process.env.MCSERVERSMITH_TEST_UPDATER !== '1') return false;
  try {
    app.getVersion = () => String(fake);
    log.info(`version reported as ${fake} (test hook)`);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
let loadError = null;

function loadUpdater() {
  if (updater) return updater;
  // required lazily: electron-updater pulls in electron, and this module is also
  // imported by plain-node tooling (version comparison lives above). A build
  // that shipped without the dependency must degrade, not take the app down —
  // that is exactly what a `files` list without node_modules used to cause.
  // eslint-disable-next-line global-require
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    loadError = err.message;
    log.error(`electron-updater is not available in this build: ${err.message}`);
    return null;
  }
  autoUpdater.autoDownload = false;               // we download explicitly, once
  autoUpdater.autoInstallOnAppQuit = true;        // …and finish on the next quit
  autoUpdater.logger = { info: (m) => log.info(String(m)), warn: (m) => log.warn(String(m)), error: (m) => log.error(String(m)), debug: () => {} };
  // an unsigned build cannot verify a signature; the checksum in latest.yml still applies
  autoUpdater.allowDowngrade = false;
  if (process.env.MCSERVERSMITH_UPDATE_DEV === '1' && !require('electron').app.isPackaged) {
    // lets a dev run check the real feed against dev-app-update.yml
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setState({
    status: 'available',
    available: info && info.version,
    // which artifact this platform would actually pull — a mismatch here is a
    // packaging bug (arm64 build on an x64 machine, missing AppImage, …)
    files: ((info && info.files) || []).map((f) => f && f.url).filter(Boolean),
    releaseUrl: 'https://github.com/lelewithheart/mcserversmith/releases/latest',
    error: null
  }));
  autoUpdater.on('update-not-available', () => setState({ status: 'uptodate', available: null, error: null, checkedAt: new Date().toISOString() }));
  autoUpdater.on('download-progress', (p) => setState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))),
    bytesPerSecond: (p && p.bytesPerSecond) || 0
  }));
  autoUpdater.on('update-downloaded', (info) => setState({
    status: 'ready', available: (info && info.version) || state.available, percent: 100, checkedAt: new Date().toISOString()
  }));
  autoUpdater.on('error', (err) => setState({ status: 'error', error: (err && err.message) || String(err), checkedAt: new Date().toISOString() }));

  updater = autoUpdater;
  return updater;
}

/**
 * Wire the updater up. `onState` receives the state after every change.
 * Returns { supported, reason } so the UI can explain a disabled updater.
 */
function init({ onState } = {}) {
  if (typeof onState === 'function') emit = onState;
  applyFakeVersion();
  const { ok, reason } = supported();
  state.current = currentVersion();
  if (!ok) {
    state.reason = reason;
    setState({ status: 'disabled', reason });
    log.info(`self-update off (${reason})`);
    return { supported: false, reason };
  }
  if (!loadUpdater()) {
    // the app was packaged without the module (see electron-builder.yml `files`)
    state.reason = 'missing';
    setState({ status: 'disabled', reason: 'missing' });
    return { supported: false, reason: 'missing' };
  }
  setState({ status: 'idle', reason: null });
  return { supported: true, reason: null };
}

async function check() {
  const { ok, reason } = supported();
  if (!ok) return setState({ status: 'disabled', reason });
  const u = loadUpdater();
  if (!u) return setState({ status: 'disabled', reason: 'missing' });
  try {
    setState({ status: 'checking', error: null });
    const res = await u.checkForUpdates();
    const version = res && res.updateInfo && res.updateInfo.version;
    if (version && isNewer(version, currentVersion())) {
      return setState({ status: 'available', available: version, error: null, checkedAt: new Date().toISOString() });
    }
    return setState({ status: 'uptodate', available: null, error: null, checkedAt: new Date().toISOString() });
  } catch (err) {
    log.warn(`update check failed: ${err.message}`);
    return setState({ status: 'error', error: err.message, checkedAt: new Date().toISOString() });
  }
}

async function download() {
  const u = loadUpdater();
  if (!u) return setState({ status: 'disabled', reason: 'missing' });
  try {
    if (state.status !== 'available') await check();
    if (state.status !== 'available') return snapshot();
    setState({ status: 'downloading', percent: 0, error: null });
    await u.downloadUpdate();
    // 'update-downloaded' sets status 'ready'
    return snapshot();
  } catch (err) {
    log.warn(`update download failed: ${err.message}`);
    return setState({ status: 'error', error: err.message });
  }
}

function install() {
  const u = loadUpdater();
  if (!u) return setState({ status: 'disabled', reason: 'missing' });
  // isSilent on Windows (NSIS /S), per-user install — no wizard, then the app restarts
  setImmediate(() => { try { u.quitAndInstall(true, true); } catch (err) { log.error(`install failed: ${err.message}`); } });
  return snapshot();
}

/** Automatic start-up check: only when the user wants it, and only when supported. */
function scheduleAutoCheck({ delayMs = Number(process.env.MCSERVERSMITH_UPDATE_DELAY_MS || DEFAULT_DELAY_MS) } = {}) {
  clearTimeout(timer);
  if (!supported().ok) return false;
  if (!settings.get('autoUpdate', true)) return false;
  timer = setTimeout(() => {
    check().then((s) => {
      if (s.status === 'available' && settings.get('autoUpdate', true)) download().catch(() => {});
    }).catch(() => {});
  }, Math.max(0, delayMs));
  if (timer.unref) timer.unref();
  return true;
}

function stop() { clearTimeout(timer); }

module.exports = {
  init,
  check,
  download,
  install,
  scheduleAutoCheck,
  stop,
  snapshot,
  isNewer,
  disabledReason,
  supported,
  state
};
