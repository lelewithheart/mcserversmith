'use strict';
/** Small fs / string / logging helpers shared by every backend module. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

function writeText(p, text) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
  return p;
}

function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyRecursive(src, dst) {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function uid() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Total size of a directory tree in bytes (async, tolerant to locked files). */
async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += (await fs.promises.stat(p)).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

/** Sanitise a user supplied name into something safe for a folder name. */
function slugify(name, fallback = 'server') {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/** Compare two Minecraft version strings. Returns -1 / 0 / 1. */
function compareVersions(a, b) {
  const split = (v) => String(v).split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const A = split(a);
  const B = split(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i += 1) {
    let x = A[i];
    let y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) { if (x !== y) return x < y ? -1 : 1; continue; }
    if (xn !== yn) {
      // numeric segments sort above pre-release tags (1.21 > 1.21-pre1)
      const numSide = xn ? x : y;
      if (numSide > 0 || yn === false) {
        // when comparing "1.21" vs "1.21-pre1": numeric wins
        return xn ? 1 : -1;
      }
      return xn ? 1 : -1;
    }
    const sx = String(x);
    const sy = String(y);
    if (sx !== sy) return sx < sy ? -1 : 1;
  }
  return 0;
}

/** Find an executable in PATH (respects PATHEXT on Windows). */
function which(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const candidate = path.join(d, cmd + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let logSink = null;         // (entry) => void  — set by the app to broadcast
const logRing = [];         // in-memory tail
const LOG_RING_MAX = 5000;

function setLogSink(fn) { logSink = fn; }

function logWrite(level, scope, message, meta) {
  const entry = {
    t: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    meta: meta === undefined ? undefined : meta
  };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  if (level === 'error') console.error(`[${scope}] ${message}`);
  else if (level === 'warn') console.warn(`[${scope}] ${message}`);
  else console.log(`[${scope}] ${message}`);
  if (logSink) { try { logSink(entry); } catch { /* ignore */ } }
  return entry;
}

function createLogger(scope) {
  return {
    debug: (m, meta) => logWrite('debug', scope, m, meta),
    info: (m, meta) => logWrite('info', scope, m, meta),
    warn: (m, meta) => logWrite('warn', scope, m, meta),
    error: (m, meta) => logWrite('error', scope, m, meta)
  };
}

function getLogRing(limit = 500) {
  return logRing.slice(Math.max(0, logRing.length - limit));
}

module.exports = {
  ensureDir, exists, isDir, isFile,
  readJSON, writeJSON, writeText, readText,
  rmrf, copyRecursive, uid, sleep,
  humanBytes, dirSize, slugify, compareVersions, which,
  createLogger, setLogSink, getLogRing
};
