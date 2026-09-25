'use strict';
/**
 * HTTP helpers built on node:https/http (no fetch), so they behave identically
 * in the Electron main process and in the plain-node headless harness.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { ensureDir, rmrf, isFile, createLogger, which } = require('./util');
const pkg = require('../../../package.json');

const log = createLogger('http');

const USER_AGENT = `MCServerSmith/${pkg.version} (contact: leonhardyvon@gmx.net)`;

function requestOnce(url, { method = 'GET', headers = {}, timeout = 60000, agent } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error(`Bad URL: ${url}`)); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
        agent
      },
      (res) => resolve(res)
    );
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Timeout after ${timeout}ms: ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET with redirect following. Returns the raw IncomingMessage stream for the
 * caller to consume (must be consumed, otherwise the socket leaks).
 */
async function get(url, { headers = {}, timeout = 60000, maxRedirects = 8, acceptStatus = [200] } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const res = await requestOnce(current, { method: 'GET', headers, timeout });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (!acceptStatus.includes(res.statusCode)) {
      const body = await readStream(res, 4096).catch(() => Buffer.from(''));
      throw new Error(`HTTP ${res.statusCode} for ${current}${body.length ? `: ${body.toString('utf8').slice(0, 200)}` : ''}`);
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects for ${url}`);
}

function readStream(stream, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new Error(`Response larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function fetchJSON(url, { headers = {}, timeout = 30000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { res } = await get(url, { headers: { Accept: 'application/json', ...headers }, timeout });
      const buf = await readStream(res);
      const text = buf.toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      lastErr = err;
      log.warn(`fetchJSON attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}) {
  const { res } = await get(url, opts);
  return (await readStream(res)).toString('utf8');
}

function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function sha256File(file) {
  return hashFile(file, 'sha256');
}

/** Normalise checksum options into an { algo: value } map. */
function normalizeHashes({ sha256, sha1, md5, hashes }) {
  const out = {};
  const add = (k, v) => { if (v) out[String(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = String(v).trim().toLowerCase(); };
  add('sha256', sha256); add('sha1', sha1); add('md5', md5);
  for (const [k, v] of Object.entries(hashes || {})) add(k, v);
  return out;
}

/**
 * Download a file. Verifies every provided checksum, writes atomically via .part.
 * onProgress({ received, total, percent, bytesPerSecond, cached? })
 */
async function download(url, dest, {
  sha256 = null,
  sha1 = null,
  md5 = null,
  hashes = null,
  onProgress = null,
  headers = {},
  timeout = 120000,
  retries = 3
} = {}) {
  const expect = normalizeHashes({ sha256, sha1, md5, hashes });
  const expectAlgos = Object.keys(expect);

  const matches = async (file) => {
    for (const algo of expectAlgos) {
      const have = await hashFile(file, algo);
      if (have !== expect[algo]) return false;
    }
    return true;
  };

  if (isFile(dest) && expectAlgos.length && await matches(dest)) {
    log.info(`cache hit ${path.basename(dest)}`);
    if (onProgress) onProgress({ received: 1, total: 1, percent: 100, bytesPerSecond: 0, cached: true });
    return { path: dest, bytes: fs.statSync(dest).size, cached: true };
  }

  ensureDir(path.dirname(dest));
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const part = `${dest}.part`;
    try {
      const { res } = await get(url, { headers, timeout });
      const total = Number(res.headers['content-length'] || 0);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        let received = 0;
        const started = Date.now();
        let lastTick = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) {
            const now = Date.now();
            if (now - lastTick > 250) {
              lastTick = now;
              const elapsed = Math.max(1, now - started) / 1000;
              onProgress({
                received,
                total,
                percent: total ? Math.round((received / total) * 100) : null,
                bytesPerSecond: received / elapsed
              });
            }
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      });

      if (expectAlgos.length && !(await matches(part))) {
        const detail = [];
        for (const algo of expectAlgos) detail.push(`${algo} expected ${expect[algo]} got ${await hashFile(part, algo)}`);
        rmrf(part);
        throw new Error(`Checksum mismatch for ${url}\n  ${detail.join('\n  ')}`);
      }
      rmrf(dest);
      fs.renameSync(part, dest);
      const bytes = fs.statSync(dest).size;
      if (onProgress) onProgress({ received: bytes, total: bytes, percent: 100, bytesPerSecond: 0 });
      log.info(`downloaded ${path.basename(dest)} (${bytes} bytes)`);
      return { path: dest, bytes, cached: false };
    } catch (err) {
      lastErr = err;
      rmrf(`${dest}.part`);
      log.warn(`download attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

function runCmd(cmd, args, { cwd, timeout = 300000 } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    const timer = timeout
      ? setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out after ${timeout}ms`)); }, timeout)
      : null;
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/**
 * Extract a .zip / .tar.gz / .tar.xz using OS tooling (bsdtar ships with
 * Windows 10+, GNU tar + unzip on Linux). No npm dependencies.
 */
async function extractArchive(archive, destDir) {
  ensureDir(destDir);
  const lower = archive.toLowerCase();
  const candidates = [];
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
      candidates.push(['powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`]]);
    } else {
      candidates.push(['unzip', ['-oq', archive, '-d', destDir]]);
      candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
      candidates.push(['python3', ['-m', 'zipfile', '-e', archive, destDir]]);
    }
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    candidates.push(['tar', ['-xzf', archive, '-C', destDir]]);
    candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
  } else if (lower.endsWith('.tar.xz')) {
    candidates.push(['tar', ['-xJf', archive, '-C', destDir]]);
    candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
  } else if (lower.endsWith('.tar')) {
    candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
  } else if (lower.endsWith('.jar')) {
    // jars are zips; used for BuildTools-less fallbacks only
    candidates.push(['unzip', ['-oq', archive, '-d', destDir]]);
    candidates.push(['tar', ['-xf', archive, '-C', destDir]]);
  } else {
    throw new Error(`Unsupported archive type: ${archive}`);
  }

  const errors = [];
  for (const [cmd, args] of candidates) {
    const exe = which(cmd);
    if (!exe) { errors.push(`${cmd}: not found`); continue; }
    try {
      const { code, stderr } = await runCmd(exe, args);
      if (code === 0) {
        log.info(`extracted ${path.basename(archive)} with ${cmd}`);
        return flattenSingleRoot(destDir);
      }
      errors.push(`${cmd}: exit ${code} ${stderr.slice(0, 200)}`);
    } catch (err) {
      errors.push(`${cmd}: ${err.message}`);
    }
  }
  throw new Error(`Could not extract ${archive}. Tried:\n${errors.join('\n')}`);
}

/** Adoptium (and friends) wrap everything in a single top-level folder. */
function flattenSingleRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(dir, entries[0].name);
    const innerEntries = fs.readdirSync(inner);
    if (innerEntries.some((n) => n === 'bin' || n === 'jre' || n === 'lib')) {
      for (const n of innerEntries) {
        fs.renameSync(path.join(inner, n), path.join(dir, n));
      }
      fs.rmdirSync(inner);
    }
  }
  return dir;
}

module.exports = {
  USER_AGENT,
  get,
  fetchJSON,
  fetchText,
  readStream,
  download,
  hashFile,
  sha256File,
  normalizeHashes,
  extractArchive,
  runCmd,
  flattenSingleRoot
};
