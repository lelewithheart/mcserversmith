'use strict';
/**
 * Bytecode-based Java requirement detection.
 *
 * Instead of guessing "1.20.5 needs Java 21" from a hardcoded table, we read the
 * class-file version straight out of the server jar (a zip). For Mojang's modern
 * "bundler" jar we recurse into META-INF/versions/<v>/*.jar.
 *
 * class file major version -> java feature release:  feature = major - 44
 *   52 -> 8, 61 -> 17, 65 -> 21, 69 -> 25
 *
 * Zero dependencies: we parse the zip central directory and inflate with zlib.
 */
const fs = require('fs');
const zlib = require('zlib');
const { createLogger } = require('../core/util');

const log = createLogger('java-detect');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function zipEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total && off + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry, maxBytes = 4 * 1024 * 1024) {
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const comp = buf.subarray(start, start + entry.compSize);
  if (entry.uncompSize > maxBytes) return null;
  if (entry.method === 0) return Buffer.from(comp);
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(comp, { maxOutputLength: maxBytes }); } catch { return null; }
  }
  return null;
}

function classFeatureFromBytes(classBuf) {
  if (!classBuf || classBuf.length < 8) return null;
  if (classBuf.readUInt32BE(0) !== 0xCAFEBABE) return null;
  const major = classBuf.readUInt16BE(6);
  if (major < 45 || major > 80) return null;
  return major - 44;
}

/**
 * Scan a jar buffer for the required class-file feature release.
 *
 * The requirement is the HIGHEST base-level class version in the jar: some
 * bundled/shaded dependencies are compiled for older targets, so sampling a
 * single "first" class understates the requirement (Paper ships its own classes
 * at 21 while vendored libs sit at 17). We take the maximum over a strided
 * sample of base-level classes, excluding META-INF/versions/ (multi-release
 * entries are ignored by older JVMs, so they must not raise the bar).
 */
function scanJar(buf, depth = 0, sampleSize = 200) {
  const entries = zipEntries(buf);
  if (!entries) return null;

  const base = entries.filter(
    (e) => e.name.endsWith('.class')
      && !e.name.startsWith('META-INF/versions/')
      && e.uncompSize > 0
      && e.uncompSize <= 256 * 1024
  );

  let max = null;
  const stride = Math.max(1, Math.floor(base.length / sampleSize));
  for (let i = 0; i < base.length; i += stride) {
    const f = classFeatureFromBytes(readEntry(buf, base[i], 256 * 1024));
    if (f !== null && (max === null || f > max)) max = f;
  }

  // Mojang bundler jar: nested jars under META-INF/versions/<mcVersion>/
  if (depth < 2) {
    const nested = entries.filter(
      (e) => e.name.toLowerCase().endsWith('.jar') && e.name.startsWith('META-INF/versions/')
    );
    for (const e of nested) {
      const inner = readEntry(buf, e, 512 * 1024 * 1024);
      if (!inner) continue;
      const f = scanJar(inner, depth + 1, sampleSize);
      if (f !== null && (max === null || f > max)) max = f;
    }
  }
  return max;
}

/**
 * @returns {number|null} required Java feature release (8, 17, 21, 25, ...)
 */
function detectRequiredJava(jarPath) {
  try {
    const buf = fs.readFileSync(jarPath);
    const feature = scanJar(buf);
    if (feature) log.info(`detected java feature ${feature} from ${jarPath}`);
    else log.warn(`could not detect java requirement from ${jarPath}`);
    return feature;
  } catch (err) {
    log.warn(`java detection failed for ${jarPath}: ${err.message}`);
    return null;
  }
}

module.exports = { detectRequiredJava };
