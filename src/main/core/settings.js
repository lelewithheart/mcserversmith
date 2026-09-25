'use strict';
/** Persistent app settings (settings.json in the data root). */
const { getDirs } = require('./paths');
const { readJSON, writeJSON, createLogger } = require('./util');

const log = createLogger('settings');

const DEFAULTS = {
  language: 'en',
  theme: 'dark',
  closeToTray: true,
  launchOnStartup: false,
  autoUpdate: true,
  maxConcurrentDownloads: 2,
  defaultMemoryMB: 4096,
  defaultProvider: 'paper',
  defaultMcVersion: null,
  acceptEula: false,
  eulaAcceptedAt: null,
  showUpsellCards: true,
  showSupporterNudge: true,
  showPublicIp: true,
  filesAdvanced: false,
  autoPortForward: true,
  telemetry: false,
  lastInstanceId: null,
  firstRun: true,
  instanceCountStarted: 0
};

let cache = null;

function load() {
  if (cache) return cache;
  const { settings } = getDirs();
  cache = { ...DEFAULTS, ...(readJSON(settings, {}) || {}) };
  return cache;
}

function all() {
  return { ...load() };
}

function get(key, fallback) {
  const v = load()[key];
  return v === undefined ? fallback : v;
}

function set(patch) {
  cache = { ...load(), ...patch };
  writeJSON(getDirs().settings, cache);
  log.info(`settings updated: ${Object.keys(patch).join(', ')}`);
  return all();
}

function reset() {
  cache = { ...DEFAULTS };
  writeJSON(getDirs().settings, cache);
  return all();
}

module.exports = { DEFAULTS, load, all, get, set, reset };
