'use strict';
/**
 * Instance file browser.
 *
 * Every path coming from the renderer is resolved inside the instance's server
 * directory and rejected if it escapes it — the renderer is untrusted input as
 * far as this module is concerned.
 *
 * Two layers:
 *   - list()/simple()  "simple" view: the handful of places a server owner
 *                      actually edits (world, mods/plugins, config, logs, the
 *                      important root files)
 *   - list(rel)        "advanced" view: any subdirectory of the server folder
 */
const fs = require('fs');
const path = require('path');

const instances = require('./instances');
const props = require('./props');

const MAX_ENTRIES = 2000;

/** Resolve `rel` inside the instance server dir, refusing to escape it. */
function safePath(id, rel = '') {
  const root = path.resolve(instances.instancePaths(id).server);
  const abs = path.resolve(root, String(rel || '.'));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path outside the server directory');
  }
  return { root, abs };
}

function relOf(id, abs) {
  const root = path.resolve(instances.instancePaths(id).server);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

function statEntry(parentAbs, name) {
  const full = path.join(parentAbs, name);
  let st = null;
  try { st = fs.lstatSync(full); } catch { return null; }
  return {
    name,
    dir: st.isDirectory(),
    link: st.isSymbolicLink(),
    size: st.isDirectory() ? null : st.size,
    mtime: st.mtimeMs
  };
}

function sortEntries(entries) {
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
}

function list(id, rel = '') {
  const { root, abs } = safePath(id, rel);
  if (!fs.existsSync(abs)) return { path: relOf(id, abs), parent: null, entries: [], missing: true };
  if (!fs.statSync(abs).isDirectory()) throw new Error('Not a directory');
  const entries = sortEntries(
    fs.readdirSync(abs).slice(0, MAX_ENTRIES).map((n) => statEntry(abs, n)).filter(Boolean)
  );
  const current = relOf(id, abs);
  return {
    path: current,
    absPath: abs,
    parent: current === '' ? null : (path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current)),
    root,
    entries
  };
}

/**
 * The curated view. Each row is { key, rel, dir, size, exists } where `key`
 * maps to an i18n string in the renderer, so nothing here is hard-coded English.
 */
function simple(id) {
  const meta = instances.read(id);
  const p = instances.instancePaths(id);
  const rows = [];
  const push = (key, rel, dir = true) => {
    const full = path.join(p.server, rel);
    let exists = false;
    let size = null;
    try {
      const st = fs.statSync(full);
      exists = true;
      size = st.isDirectory() ? null : st.size;
    } catch { /* not created yet */ }
    rows.push({ key, rel, dir, exists, size });
  };

  // world(s) — the name is configurable in server.properties
  let levelName = 'world';
  try {
    levelName = String(props.get(p.properties, 'level-name', 'world') || 'world');
  } catch { /* use the default */ }
  push('world', levelName);
  if (fs.existsSync(path.join(p.server, `${levelName}_nether`))) push('worldNether', `${levelName}_nether`);
  if (fs.existsSync(path.join(p.server, `${levelName}_the_end`))) push('worldEnd', `${levelName}_the_end`);

  if (meta.kind === 'modded') push('mods', 'mods');
  else push('plugins', 'plugins');

  if (meta.kind === 'modded') push('config', 'config');
  push('logs', 'logs');

  for (const rel of ['server.properties', 'eula.txt', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'user_jvm_args.txt']) {
    push(`file.${rel}`, rel, false);
  }
  const jar = (meta.launch && meta.launch.jar) || (fs.existsSync(path.join(p.server, 'server.jar')) ? 'server.jar' : null);
  if (jar) push('file.jar', jar, false);

  return { rows, root: p.server, levelName };
}

function mkdir(id, rel, name) {
  const clean = String(name || '').replace(/[\\/]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid folder name');
  const { abs } = safePath(id, path.posix.join(rel || '', clean));
  if (fs.existsSync(abs)) throw new Error('Already exists');
  fs.mkdirSync(abs, { recursive: true });
  return relOf(id, abs);
}

function rename(id, rel, to) {
  const clean = String(to || '').replace(/[\\/]/g, '').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid name');
  const { root, abs } = safePath(id, rel);
  if (!rel || abs === root) throw new Error('Cannot rename the server folder');
  if (!fs.existsSync(abs)) throw new Error('Not found');
  const target = path.join(path.dirname(abs), clean);
  if (fs.existsSync(target)) throw new Error('Already exists');
  fs.renameSync(abs, target);
  return relOf(id, target);
}

function remove(id, rel) {
  const { root, abs } = safePath(id, rel);
  if (!rel || abs === root) throw new Error('Cannot delete the server folder');
  if (!fs.existsSync(abs)) throw new Error('Not found');
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}

/** Copy files the user picked in the OS dialog into `rel`. */
function importFiles(id, rel, sources) {
  const { abs } = safePath(id, rel);
  const out = [];
  for (const src of sources || []) {
    const from = String(src);
    if (!fs.existsSync(from)) continue;
    const name = path.basename(from);
    if (/^(server\.properties|eula\.txt)$/i.test(name)) throw new Error(`${name} cannot be replaced — edit it in the Config tab`);
    let target = path.join(abs, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      const stem = path.basename(name, ext);
      target = path.join(abs, `${stem}-${Date.now()}${ext}`);
    }
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      fs.cpSync(from, target, { recursive: true });
    } else {
      fs.copyFileSync(from, target);
    }
    out.push(path.basename(target));
  }
  return out;
}

/** Absolute path, for "show in file manager" / "open with default app". */
function absolute(id, rel) {
  return safePath(id, rel).abs;
}

/** Human-readable folder size, capped so it stays fast. */
function folderSize(id, rel, limit = 20000) {
  const { abs } = safePath(id, rel);
  if (!fs.existsSync(abs)) return 0;
  if (!fs.statSync(abs).isDirectory()) return fs.statSync(abs).size;
  let total = 0;
  let seen = 0;
  const walk = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (seen++ > limit) return;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(abs);
  return total;
}

module.exports = { list, simple, mkdir, rename, remove, importFiles, absolute, folderSize };
