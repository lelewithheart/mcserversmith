'use strict';
/**
 * server.properties reader/writer that preserves comments and key order,
 * plus a sane default template for freshly created instances.
 */
const fs = require('fs');
const path = require('path');
const { readText, ensureDir } = require('../core/util');

function readProperties(file) {
  const text = readText(file, '');
  const lines = text.split(/\r?\n/);
  const entries = lines.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      return { comment: true, raw };
    }
    const idx = trimmed.indexOf('=');
    if (idx < 0) return { comment: true, raw };
    return { key: trimmed.slice(0, idx), value: trimmed.slice(idx + 1), raw };
  });
  return entries;
}

function toObject(entries) {
  const obj = {};
  for (const e of entries) if (e.key) obj[e.key] = e.value;
  return obj;
}

function get(file, key, fallback = null) {
  const obj = toObject(readProperties(file));
  return obj[key] === undefined ? fallback : obj[key];
}

function writeProperties(file, changes) {
  ensureDir(path.dirname(file));
  const entries = readProperties(file);
  const remaining = { ...changes };
  for (const e of entries) {
    if (e.key && Object.prototype.hasOwnProperty.call(remaining, e.key)) {
      e.value = String(remaining[e.key]);
      delete remaining[e.key];
    }
  }
  for (const [k, v] of Object.entries(remaining)) {
    entries.push({ key: k, value: String(v), raw: `${k}=${v}` });
  }
  const out = entries
    .map((e) => (e.key ? `${e.key}=${e.value}` : e.raw))
    .join('\n');
  fs.writeFileSync(file, `${out}\n`);
  return toObject(readProperties(file));
}

function randomPassword(len = 16) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Default config for a new instance.
 * RCON is enabled on purpose: it is what gives the dashboard an accurate player
 * list, TPS and console command execution without screen-scraping.
 */
function defaultProperties({
  motd = 'A MCServerSmith Server',
  port = 25565,
  maxPlayers = 20,
  difficulty = 'normal',
  gamemode = 'survival',
  onlineMode = true,
  viewDistance = 10,
  rconPort = 25575,
  rconPassword = randomPassword(),
  pvp = true,
  levelName = 'world',
  levelSeed = '',
  whitelist = false,
  enableQuery = true,
  queryPort = null
} = {}) {
  const props = {
    'enable-jmx-monitoring': 'false',
    'rcon.port': rconPort,
    'level-seed': levelSeed,
    gamemode,
    'enable-command-block': 'false',
    'enable-query': enableQuery ? 'true' : 'false',
    'generator-settings': '{}',
    'enforce-secure-profile': 'true',
    'level-name': levelName,
    motd,
    'query.port': queryPort || port,
    pvp: pvp ? 'true' : 'false',
    'generate-structures': 'true',
    'max-chained-neighbor-updates': '1000000',
    difficulty,
    'network-compression-threshold': '256',
    'max-tick-time': '60000',
    'require-resource-pack': 'false',
    'use-native-transport': 'true',
    'max-players': maxPlayers,
    'online-mode': onlineMode ? 'true' : 'false',
    'enable-status': 'true',
    'allow-flight': 'false',
    'broadcast-rcon-to-ops': 'true',
    'view-distance': viewDistance,
    'server-ip': '',
    'resource-pack-prompt': '',
    'allow-nether': 'true',
    'server-port': port,
    'enable-rcon': 'true',
    'sync-chunk-writes': 'true',
    'op-permission-level': '4',
    'prevent-proxy-connections': 'false',
    'hide-online-players': 'false',
    'resource-pack': '',
    'entity-broadcast-range-percentage': '100',
    'simulation-distance': Math.min(12, viewDistance),
    'rcon.password': rconPassword,
    'player-idle-timeout': '0',
    'force-gamemode': 'false',
    'rate-limit': '0',
    'hardcore': 'false',
    'white-list': whitelist ? 'true' : 'false',
    'broadcast-console-to-ops': 'true',
    'spawn-npcs': 'true',
    'spawn-animals': 'true',
    'log-ips': 'true',
    'function-permission-level': '2',
    'initial-disabled-packs': '',
    'level-type': 'minecraft\\:normal',
    'text-filtering-config': '',
    'spawn-monsters': 'true',
    'enforce-whitelist': 'false',
    'spawn-protection': '16',
    'resource-pack-sha1': '',
    'max-world-size': '29999984'
  };
  return props;
}

module.exports = {
  readProperties,
  writeProperties,
  toObject,
  get,
  defaultProperties,
  randomPassword
};
