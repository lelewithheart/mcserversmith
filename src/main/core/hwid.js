'use strict';
/**
 * Machine identifier — what a licence key can be bound to.
 *
 * How it works: the OS value is read (Windows: the MachineGuid of the installed
 * system, Linux: /etc/machine-id, macOS: the IOPlatformUUID), hashed with SHA-256
 * and shortened to 16 hex characters. The raw OS value never leaves the machine and
 * the shown ID is one-way, so publishing it (the buyer mails it to you) reveals
 * nothing about the machine beyond the ID itself.
 *
 * Honest limits, so nobody builds a business on a wrong assumption:
 *  - It survives hardware swaps (GPU, RAM, disks, network card) but NOT a reinstall
 *    of the OS: a fresh Windows gives a new MachineGuid. The buyer then needs a
 *    re-issue — per-component IDs would change far more often, which is worse.
 *  - This is a client-side check. It stops casual key sharing. It does not stop a
 *    determined user from patching the app. Nothing that works offline does.
 *  - If every OS source fails, the fallback is hostname+user+platform, which is
 *    weaker (renaming the machine changes it). `source()` reports which was used so
 *    the app can say so instead of pretending.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { createLogger } = require('./util');

const log = createLogger('hwid');

const SALT = 'MCServerSmith/machine-id/v1';

let cache = null;

function tryRead(fn) {
  try {
    const value = fn();
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function regQuery(pathArg, value) {
  const out = execFileSync('reg', ['query', pathArg, '/v', value], { encoding: 'utf8', windowsHide: true });
  const m = out.match(new RegExp(`${value}\\s+REG_SZ\\s+(\\S+)`, 'i'));
  return m ? m[1] : null;
}

/** The strongest per-installation value this platform offers, or null. */
function readRaw() {
  if (process.platform === 'win32') {
    // per Windows installation: stable across hardware changes, gone after a reinstall
    const guid = tryRead(() => regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid'));
    if (guid) return { value: guid, source: 'windows-machine-guid' };
    const product = tryRead(() => regQuery('HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', 'SystemProductName'));
    return product ? { value: product, source: 'windows-bios' } : null;
  }
  if (process.platform === 'darwin') {
    const out = tryRead(() => execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }));
    const m = out && out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? { value: m[1], source: 'macos-platform-uuid' } : null;
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const id = tryRead(() => fs.readFileSync(file, 'utf8'));
    if (id) return { value: id, source: `linux-${file}` };
  }
  return null;
}

function compute() {
  if (cache) return cache;
  const raw = readRaw();
  let source = raw ? raw.source : 'fallback-hostname';
  let value = raw ? raw.value : `${os.hostname()}|${os.platform()}|${os.arch()}|${(os.userInfo().username || '')}`;
  if (!raw) log.warn('no OS machine id available — falling back to hostname/user, which is weaker');
  const digest = crypto.createHash('sha256').update(`${SALT}|${value}`).digest('hex').slice(0, 16).toUpperCase();
  const id = `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`;
  cache = { id, source, weak: !raw };
  return cache;
}

/** The identifier to show the user and to put into a key: XXXX-XXXX-XXXX-XXXX. */
function machineId() {
  return compute().id;
}

/** Which OS value the ID was derived from (diagnostics, and the weak-fallback hint). */
function source() {
  return compute().source;
}

/** True when no OS machine id was readable and the weak fallback is in use. */
function isWeak() {
  return compute().weak;
}

/** Compare two IDs regardless of case, spaces, dashes or how they were copied. */
function normalize(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when `id` (as stored in a key) belongs to this machine. */
function matches(id) {
  return !!id && normalize(id) === normalize(machineId());
}

/** Everything the UI and the diagnostics report need. */
function info() {
  const c = compute();
  return { machineId: c.id, source: c.source, weakFallback: c.weak };
}

/** Forget the cached value — tests only. */
function reset() {
  cache = null;
}

module.exports = { machineId, source, isWeak, normalize, matches, info, reset };
