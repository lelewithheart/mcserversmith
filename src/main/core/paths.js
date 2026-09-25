'use strict';
/**
 * Cross-platform data locations. Deliberately does NOT import electron so that
 * the headless test harness (tools/headless-test.js) can reuse the whole backend
 * outside of an Electron process.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_DIR_NAME = 'MCServerSmith';

let _dataRoot = null;

function defaultDataRoot() {
  if (process.env.MCSERVERSMITH_DATA) return path.resolve(process.env.MCSERVERSMITH_DATA);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'mcserversmith');
}

/**
 * Override the data root (used by --portable, tests and the CLI).
 */
function setDataRoot(dir) {
  _dataRoot = path.resolve(dir);
  delete module.exports.__cachedDirs;
  return getDirs();
}

function getDataRoot() {
  if (!_dataRoot) _dataRoot = defaultDataRoot();
  return _dataRoot;
}

let _dirs = null;
function getDirs() {
  const root = getDataRoot();
  return {
    root,
    runtimes: path.join(root, 'runtimes'),
    cache: path.join(root, 'cache'),
    instances: path.join(root, 'instances'),
    logs: path.join(root, 'logs'),
    locales: path.join(root, 'locales'),
    backups: path.join(root, 'backups'),
    tmp: path.join(root, 'tmp'),
    tools: path.join(root, 'tools'),
    settings: path.join(root, 'settings.json'),
    licenses: path.join(root, 'licenses.json'),
    monetization: path.join(root, 'monetization.json'),
    appLog: path.join(root, 'logs', 'app.log'),
    serversJson: path.join(root, 'servers.json')
  };
}

function ensureDirs() {
  const d = getDirs();
  for (const key of ['root', 'runtimes', 'cache', 'instances', 'logs', 'locales', 'backups', 'tmp', 'tools']) {
    fs.mkdirSync(d[key], { recursive: true });
  }
  return d;
}

/** Directory of the running app (src/), used to find bundled assets. */
function appRoot() {
  return path.resolve(__dirname, '..', '..');
}

function bundledLocalesDir() {
  return path.join(appRoot(), 'renderer', 'locales');
}

function bundledResourcesDir() {
  return path.resolve(appRoot(), '..', 'resources');
}

module.exports = {
  APP_DIR_NAME,
  defaultDataRoot,
  setDataRoot,
  getDataRoot,
  getDirs,
  ensureDirs,
  appRoot,
  bundledLocalesDir,
  bundledResourcesDir
};
