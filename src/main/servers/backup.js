'use strict';
/**
 * Backups: tar.gz snapshots of the world (+ configs) with rotation.
 * Uses the system tar (bsdtar on Windows 10+, GNU tar elsewhere) — no deps.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createLogger, which, isFile, exists, humanBytes, rmrf } = require('../core/util');
const { ensureDir } = require('../core/util');
const instances = require('./instances');
const props = require('./props');

const log = createLogger('backup');

function tarBin() {
  return which('tar');
}

function backupStamp(label) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return label ? `mcss-${stamp}-${label}.tar.gz` : `mcss-${stamp}.tar.gz`;
}

function listBackups(id) {
  const dir = instances.instancePaths(id).backups;
  if (!exists(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (f.endsWith('.tar.gz')) {
      out.push({ name: f, path: full, bytes: st.size, createdAt: st.mtime.toISOString(), kind: 'tar' });
    } else if (st.isDirectory() && f.endsWith('.dir')) {
      out.push({ name: f, path: full, bytes: 0, createdAt: st.mtime.toISOString(), kind: 'folder' });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(tarBin(), args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tar failed: ${err.message}${stderr ? `\n${stderr.slice(0, 400)}` : ''}`));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Files a running server keeps locked. GNU tar aborts on them, so they are
 * always excluded from backups (they are recreated on the next start).
 */
const EXCLUDES = ['--exclude=session.lock', '--exclude=*.lock', '--exclude=logs/latest.log'];

/** Copy a tree without the files that are locked while the server runs. */
function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (p) => !/(session\.lock|\.lock)$/.test(path.basename(p))
  });
}

/**
 * @param {object} manager
 * @param {string} id
 * @param {{label?:string, includeConfigs?:boolean, includePlugins?:boolean}} opts
 */
async function createBackup(manager, id, { label = null, includeConfigs = true, includePlugins = false } = {}) {
  const meta = instances.read(id);
  const p = instances.instancePaths(id);
  ensureDir(p.backups);

  const serverDir = p.server;
  const levelName = props.get(p.properties, 'level-name', 'world');

  const members = [];
  const push = (rel) => { if (rel && exists(path.join(serverDir, rel))) members.push(rel); };
  push(levelName);
  push('world_nether');
  push('world_the_end');
  if (includeConfigs) {
    for (const f of ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json',
      'banned-ips.json', 'eula.txt', 'bukkit.yml', 'spigot.yml', 'paper.yml',
      'config/paper-global.yml', 'config/paper-world-defaults.yml']) push(f);
  }
  if (includePlugins) {
    for (const f of ['plugins', 'mods', 'config', 'datapacks']) push(f);
  }
  if (!members.length) throw new Error('Nothing to back up yet (no world folder found).');

  const onLog = (line) => manager && manager._emit && manager._emit('log', id, { line, level: 'plain', event: { type: 'backup' } });
  const stamp = backupStamp(label);

  // 1) preferred: compressed tar, run with cwd=serverDir and a RELATIVE archive
  //    path. Absolute "C:\..." paths make GNU tar think "C" is a remote host.
  const tarOk = tarBin();
  if (tarOk) {
    const archive = path.join(p.backups, stamp);
    const relArchive = path.relative(serverDir, archive);
    if (onLog) onLog(`Creating backup ${stamp} (${members.join(', ')})`);
    try {
      await runTar(['-czf', relArchive, ...EXCLUDES, ...members], serverDir);
      const bytes = fs.statSync(archive).size;
      if (onLog) onLog(`Backup done: ${stamp} (${humanBytes(bytes)})`);
      const meta2 = instances.read(id);
      instances.update(id, { backup: { ...meta2.backup, lastRunAt: new Date().toISOString() } });
      log.info(`backup ${archive} (${bytes} bytes)`);
      return { name: stamp, path: archive, bytes, createdAt: new Date().toISOString(), kind: 'tar' };
    } catch (err) {
      log.warn(`tar backup failed, falling back to folder copy: ${err.message}`);
      if (onLog) onLog(`tar failed (${err.message.split('\n')[0]}) — falling back to a folder backup.`);
      rmrf(archive);
    }
  }

  // 2) fallback: uncompressed folder copy (always works, even with locked files)
  const dirName = backupStamp(label).replace(/\.tar\.gz$/, '.dir');
  const dest = path.join(p.backups, dirName);
  rmrf(dest);
  ensureDir(dest);
  for (const member of members) {
    const src = path.join(serverDir, member);
    const target = path.join(dest, member);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyTree(src, target);
    else fs.copyFileSync(src, target);
  }
  const bytes = await dirSizeOf(dest);
  if (onLog) onLog(`Folder backup done: ${dirName} (${humanBytes(bytes)})`);
  const meta2 = instances.read(id);
  instances.update(id, { backup: { ...meta2.backup, lastRunAt: new Date().toISOString() } });
  return { name: dirName, path: dest, bytes, createdAt: new Date().toISOString(), kind: 'folder' };
}

async function dirSizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += (await fs.promises.stat(full)).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

async function restoreBackup(manager, id, name) {
  const rt = manager._runtimeFor(id);
  if (rt.supervisor && rt.supervisor.online) {
    throw new Error('Stop the server before restoring a backup.');
  }
  const p = instances.instancePaths(id);
  const file = path.join(p.backups, name);
  if (!exists(file)) throw new Error(`Backup ${name} not found`);

  if (name.endsWith('.tar.gz')) {
    if (!tarBin()) throw new Error('No tar binary found — cannot restore a compressed backup.');
    // relative path + cwd keeps GNU tar from treating "C:" as a remote host
    await runTar(['-xzf', path.relative(p.server, file)], p.server);
  } else {
    // folder backup: copy every top level member back
    ensureDir(p.server);
    for (const member of fs.readdirSync(file)) {
      const src = path.join(file, member);
      const target = path.join(p.server, member);
      const st = fs.statSync(src);
      rmrf(target);
      if (st.isDirectory()) copyTree(src, target);
      else fs.copyFileSync(src, target);
    }
  }
  manager._emit('log', id, { line: `Restored backup ${name}`, level: 'warn', event: { type: 'backup' } });
  return { restored: name };
}

/** Keep the newest `keep` backups. */
function pruneBackups(id, keep = 7) {
  const list = listBackups(id);
  const doomed = list.slice(Math.max(0, keep));
  for (const b of doomed) {
    try { rmrf(b.path); log.info(`pruned backup ${b.name}`); } catch { /* ignore */ }
  }
  return { removed: doomed.length, kept: Math.min(keep, list.length) };
}

function deleteBackup(id, name) {
  const p = instances.instancePaths(id);
  rmrf(path.join(p.backups, name));
  return true;
}

/** Rough space usage of the backup folder. */
function backupUsage(id) {
  const list = listBackups(id);
  return { count: list.length, bytes: list.reduce((a, b) => a + b.bytes, 0) };
}

module.exports = { createBackup, restoreBackup, listBackups, pruneBackups, deleteBackup, backupUsage };
