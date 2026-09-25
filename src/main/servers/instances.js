'use strict';
/** Instance store: metadata + on-disk layout. No process handling here. */
const path = require('path');
const fs = require('fs');
const { getDirs } = require('../core/paths');
const { ensureDir, readJSON, writeJSON, rmrf, uid, slugify, exists } = require('../core/util');
const props = require('./props');

const META_VERSION = 1;

function instancesRoot() {
  return getDirs().instances;
}

function instanceDir(id) {
  return path.join(instancesRoot(), id);
}

function instancePaths(id) {
  const dir = instanceDir(id);
  return {
    dir,
    meta: path.join(dir, 'meta.json'),
    manifest: path.join(dir, 'manifest.json'),
    server: path.join(dir, 'server'),
    logs: path.join(dir, 'logs'),
    latestLog: path.join(dir, 'logs', 'latest.log'),
    archive: path.join(dir, 'logs', 'archive'),
    backups: path.join(dir, 'backups'),
    tmp: path.join(dir, 'tmp'),
    properties: path.join(dir, 'server', 'server.properties'),
    eula: path.join(dir, 'server', 'eula.txt'),
    runSh: path.join(dir, 'server', 'run.sh'),
    runBat: path.join(dir, 'server', 'run.bat'),
    userJvmArgs: path.join(dir, 'server', 'user_jvm_args.txt')
  };
}

function createDirs(id) {
  const p = instancePaths(id);
  for (const key of ['dir', 'server', 'logs', 'archive', 'backups', 'tmp']) ensureDir(p[key]);
  return p;
}

function list() {
  const root = instancesRoot();
  if (!exists(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const metaFile = path.join(root, name, 'meta.json');
    const meta = readJSON(metaFile, null);
    if (meta && meta.id) out.push(meta);
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return out;
}

function read(id) {
  const meta = readJSON(instancePaths(id).meta, null);
  if (!meta) throw new Error(`Instance ${id} not found`);
  return meta;
}

function write(meta) {
  const p = instancePaths(meta.id);
  ensureDir(p.dir);
  meta.updatedAt = new Date().toISOString();
  writeJSON(p.meta, meta);
  return meta;
}

function update(id, patch) {
  const meta = { ...read(id), ...patch };
  return write(meta);
}

/**
 * Create a new instance record (no downloads yet).
 */
function create({
  name,
  provider,
  kind,
  mcVersion,
  loaderVersion = null,
  memoryMB = 4096,
  port = 25565,
  rconPort = 25575,
  motd,
  maxPlayers = 20,
  difficulty = 'normal',
  gamemode = 'survival',
  onlineMode = true,
  viewDistance = 10,
  acceptEula = false
}) {
  const id = `${slugify(name, 'server')}-${uid().slice(0, 8)}`;
  const rconPassword = props.randomPassword();
  const p = createDirs(id);

  const meta = {
    metaVersion: META_VERSION,
    id,
    name: name || `Server ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider,
    kind,
    mcVersion,
    loaderVersion,
    javaFeature: null,
    javaKind: 'jre',
    memoryMB,
    jvmArgs: [],
    port,
    rconPort,
    rconPassword,
    motd: motd || `${name || 'Minecraft'} — powered by MCServerSmith`,
    maxPlayers,
    difficulty,
    gamemode,
    onlineMode,
    viewDistance,
    launch: null,
    artifact: null,
    eulaAccepted: !!acceptEula,
    installState: 'new',
    installed: false,
    lastError: null,
    autoRestart: false,
    scheduledRestart: null,
    scheduleRestarts: false,
    backup: { enabled: false, intervalHours: 6, keep: 7, lastRunAt: null },
    tunnel: { provider: 'none', subdomain: null, remotePort: null, host: null, token: null },
    stats: { totalStarts: 0, lastStartedAt: null, totalPlaytimeMs: 0 }
  };

  write(meta);

  // seed server.properties + eula so the user can inspect/edit before first run
  props.writeProperties(p.properties, props.defaultProperties({
    motd: meta.motd,
    port,
    maxPlayers,
    difficulty,
    gamemode,
    onlineMode,
    viewDistance,
    rconPort,
    rconPassword
  }));
  fs.writeFileSync(p.eula, `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=${acceptEula ? 'true' : 'false'}\n`);

  return meta;
}

function remove(id) {
  rmrf(instanceDir(id));
}

function setEula(id, accepted) {
  const meta = read(id);
  meta.eulaAccepted = !!accepted;
  write(meta);
  const p = instancePaths(id);
  fs.writeFileSync(p.eula, `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=${accepted ? 'true' : 'false'}\n`);
  return meta;
}

function manifestPath(id) {
  return instancePaths(id).manifest;
}

function readManifest(id) {
  return readJSON(manifestPath(id), null);
}

function writeManifest(id, manifest) {
  writeJSON(manifestPath(id), manifest);
  return manifest;
}

module.exports = {
  META_VERSION,
  instancesRoot,
  instanceDir,
  instancePaths,
  createDirs,
  list,
  read,
  write,
  update,
  create,
  remove,
  setEula,
  readManifest,
  writeManifest
};
