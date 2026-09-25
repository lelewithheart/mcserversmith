'use strict';
/**
 * Java runtime provisioning via the Adoptium (Eclipse Temurin) API.
 * Every instance gets exactly the JVM it needs, downloaded once, cached forever.
 */
const path = require('path');
const fs = require('fs');
const { getDirs } = require('../core/paths');
const { ensureDir, exists, readJSON, writeJSON, rmrf, createLogger, which } = require('../core/util');
const { fetchJSON, download, extractArchive } = require('../core/http');
const { detectRequiredJava } = require('./detect');

const log = createLogger('java');

const ADOPTIUM = 'https://api.adoptium.net/v3';
// Feature releases that actually exist on Adoptium and are relevant for MC servers.
const KNOWN_FEATURES = [8, 11, 16, 17, 21, 25];

function apiOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function apiArch() {
  const a = process.arch;
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'aarch64';
  if (a === 'ia32') return 'x86';
  return 'x64';
}

function runtimeDir(feature, kind) {
  return path.join(getDirs().runtimes, `temurin-${feature}-${kind}`);
}

function javaBinary(feature, kind) {
  const dir = runtimeDir(feature, kind);
  const candidates = process.platform === 'win32'
    ? [path.join(dir, 'bin', 'java.exe'), path.join(dir, 'jre', 'bin', 'java.exe')]
    : [path.join(dir, 'bin', 'java'), path.join(dir, 'jre', 'bin', 'java')];
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

function installed() {
  const out = [];
  for (const feature of KNOWN_FEATURES) {
    for (const kind of ['jre', 'jdk']) {
      const bin = javaBinary(feature, kind);
      if (bin) out.push({ feature, kind, javaPath: bin, dir: runtimeDir(feature, kind) });
    }
  }
  return out;
}

async function resolveAsset(feature, kind) {
  const url = `${ADOPTIUM}/assets/latest/${feature}/hotspot?os=${apiOs()}&architecture=${apiArch()}&image_type=${kind}`;
  const json = await fetchJSON(url);
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(`Adoptium has no ${kind} for Java ${feature} on ${apiOs()}/${apiArch()}`);
  }
  const pkg = json[0].binary.package;
  return {
    url: pkg.link,
    sha256: (pkg.checksum || '').toLowerCase() || null,
    name: pkg.name,
    semver: json[0].version && json[0].version.semver,
    releaseName: json[0].release_name
  };
}

/**
 * Download + extract a runtime if it is not present yet.
 * @returns {Promise<{feature:number, kind:string, javaPath:string, version?:string, cached:boolean}>}
 */
async function ensure(feature, { kind = 'jre', onProgress = null } = {}) {
  const already = javaBinary(feature, kind);
  if (already) {
    return { feature, kind, javaPath: already, cached: true };
  }

  const asset = await resolveAsset(feature, kind);
  const dir = runtimeDir(feature, kind);
  const archive = path.join(getDirs().cache, asset.name || `temurin-${feature}-${kind}.archive`);

  log.info(`provisioning Java ${feature} ${kind} (${asset.name})`);
  await download(asset.url, archive, { sha256: asset.sha256, onProgress });

  rmrf(dir);
  ensureDir(dir);
  await extractArchive(archive, dir);

  const bin = javaBinary(feature, kind);
  if (!bin) throw new Error(`Java ${feature} ${kind} extracted but no java binary found in ${dir}`);

  // record metadata for the runtimes UI
  const metaFile = path.join(dir, 'mcserversmith-runtime.json');
  writeJSON(metaFile, {
    feature,
    kind,
    version: asset.semver,
    release: asset.releaseName,
    source: asset.url,
    installedAt: new Date().toISOString()
  });

  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

  log.info(`Java ${feature} ${kind} ready at ${bin}`);
  return { feature, kind, javaPath: bin, version: asset.semver, cached: false };
}

/**
 * Rule-based fallback when bytecode detection is impossible (e.g. Forge
 * installers that are not plain jars yet).
 */
function ruleBasedFeature(mcVersion) {
  const v = String(mcVersion || '');
  const parts = v.split(/[.\-]/).map((p) => Number(p));
  const major = parts[0];
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;
  // Mojang switched to a year.release scheme (26.1, 26.3, ...) in 2026.
  if (major >= 26) return 21;
  if (major === 1) {
    if (minor <= 16) return 8;
    if (minor === 17) return 17;
    if (minor <= 20 && (minor < 20 || patch <= 4)) return 17;
    return 21;
  }
  return 21;
}

/**
 * Best-effort required Java for a server artifact.
 *
 * Two independent signals are combined with max():
 *   - bytecode scan of the actual jar (ground truth for plain jars)
 *   - version rules (ground truth for bootstraps like Paperclip, which is
 *     compiled for 17 but needs a Java 21 JVM to patch a 1.21.4 server)
 * A too-low result is never fatal: ProcessSupervisor detects
 * UnsupportedClassVersionError and escalates to the next feature release.
 *
 * @param {{jarPath?:string, mcVersion?:string, providerMin?:number}} opts
 */
function requiredJava({ jarPath = null, mcVersion = null, providerMin = 0 } = {}) {
  const signals = {};
  if (jarPath && exists(jarPath)) {
    const d = detectRequiredJava(jarPath);
    if (d) signals.bytecode = d;
  }
  if (mcVersion) signals.rule = ruleBasedFeature(mcVersion);

  let target = Math.max(providerMin || 0, ...Object.values(signals));
  let source = Object.entries(signals).map(([k, v]) => `${k}=${v}`).join('+') || 'default';
  if (!Number.isFinite(target) || target <= 0) { target = 21; source = 'default'; }

  const snapped = KNOWN_FEATURES.find((f) => f >= target) || KNOWN_FEATURES[KNOWN_FEATURES.length - 1];
  return { feature: snapped, detected: target, source };
}

/** Next sane feature release to try after an UnsupportedClassVersionError. */
function nextFeature(feature) {
  return KNOWN_FEATURES.find((f) => f > feature) || null;
}

/** A java binary for *running* the launcher itself is never needed — but we
 *  expose the system java for the Spigot BuildTools flow if available. */
function systemJava() {
  return which('java');
}

module.exports = {
  KNOWN_FEATURES,
  ADOPTIUM,
  runtimeDir,
  javaBinary,
  installed,
  resolveAsset,
  ensure,
  requiredJava,
  nextFeature,
  ruleBasedFeature,
  systemJava,
  detect: detectRequiredJava
};
