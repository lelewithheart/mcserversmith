'use strict';
/**
 * Provider registry.
 *
 * A provider knows how to enumerate Minecraft versions and how to obtain a
 * runnable server artifact for one of them.
 *
 * Contract
 * --------
 *   id                string, stable identifier used in instance metadata
 *   label             display name
 *   kind              'vanilla' | 'plugin' | 'modded' | 'proxy'
 *   description       i18n key or plain text
 *   advanced          true => UI shows a warning before use
 *   warnings          string[] of things the user must know
 *   supportsLoaders   true => listLoaders(mcVersion) is meaningful
 *   listMcVersions({ includeSnapshots })  -> [{ id, type }]      (newest first)
 *   listLoaders(mcVersion)                -> [{ id, stable }]    (optional)
 *
 *   resolve({ mcVersion, loaderVersion }) -> {
 *     url, filename,
 *     hashes: { sha256?, sha1?, md5? },
 *     mode: 'jar' | 'installer' | 'buildtools',
 *     installArgs?: string[],
 *     javaFloor?: number,
 *     size?: number,
 *     notes?: string
 *   }
 */
const providers = new Map();

function register(provider) {
  if (!provider || !provider.id) throw new Error('provider needs an id');
  providers.set(provider.id, provider);
  return provider;
}

function get(id) {
  const p = providers.get(id);
  if (!p) throw new Error(`Unknown server type: ${id}`);
  return p;
}

function has(id) {
  return providers.has(id);
}

/** Ordered list for the UI. */
function list() {
  const order = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge', 'spigot', 'velocity'];
  return order
    .filter((id) => providers.has(id))
    .map((id) => {
      const p = providers.get(id);
      return {
        id: p.id,
        label: p.label,
        kind: p.kind,
        description: p.description || '',
        advanced: !!p.advanced,
        warnings: p.warnings || [],
        supportsLoaders: !!p.supportsLoaders,
        recommended: !!p.recommended
      };
    });
}

// ---------------------------------------------------------------------------
// tiny TTL memory cache so the UI can re-query without hammering upstream APIs
// ---------------------------------------------------------------------------
const memoStore = new Map();

async function memo(key, ttlMs, fn) {
  const hit = memoStore.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await fn();
  memoStore.set(key, { t: now, v });
  return v;
}

function clearMemo() {
  memoStore.clear();
}

module.exports = { register, get, has, list, memo, clearMemo };
