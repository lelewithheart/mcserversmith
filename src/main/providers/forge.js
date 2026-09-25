'use strict';
/**
 * Forge (maven.minecraftforge.net) and NeoForge (maven.neoforged.net).
 *
 * Neither ships a runnable jar. The flow is:
 *   java -jar <installer>.jar --installServer
 * which produces run.sh / run.bat, libraries/ and user_jvm_args.txt.
 * Memory must then be set inside user_jvm_args.txt — command line flags are
 * ignored by the generated scripts. That is why mode 'installer' declares
 * launch.mode === 'script'.
 */
const { fetchJSON, fetchText } = require('../core/http');
const { compareVersions, createLogger } = require('../core/util');
const { register, memo } = require('./index');

const log = createLogger('provider:forge');

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

async function forgeVersions() {
  return memo('forge:versions', 30 * 60 * 1000, async () => {
    const xml = await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`);
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    // "1.20.1-47.2.0" -> mc 1.20.1, forge 47.2.0
    const rows = [];
    for (const v of versions) {
      const idx = v.lastIndexOf('-');
      if (idx <= 0) continue;
      const mc = v.slice(0, idx);
      const forge = v.slice(idx + 1);
      if (!/^\d+\.\d+/.test(mc) || !/^\d+\./.test(forge)) continue;
      rows.push({ mc, forge });
    }
    return rows;
  });
}

async function forgePromotions() {
  return memo('forge:promos', 30 * 60 * 1000, async () => {
    try {
      const data = await fetchJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      return data.promos || {};
    } catch { return {}; }
  });
}

async function neoforgeVersions() {
  return memo('neoforge:versions', 30 * 60 * 1000, async () => {
    const data = await fetchJSON(NEOFORGE_API);
    const raw = (data && data.versions) || [];
    const rows = [];
    for (const v of raw) {
      if (/craftmine/i.test(v) || v.startsWith('0.')) continue;
      const parts = v.split('.');
      const major = Number(parts[0]);
      const minor = Number(parts[1]);
      if (!Number.isFinite(major) || !Number.isFinite(minor) || major < 20) continue;
      // 21.1.66 -> MC 1.21.1   |   26.3.0.16 -> MC 26.3
      const mc = major >= 25 ? `${major}.${minor}` : `1.${major}.${minor}`;
      rows.push({ mc, neo: v, stable: !/-(beta|alpha|rc)/i.test(v) });
    }
    return rows;
  });
}

function groupByMc(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.mc)) map.set(r.mc, []);
    map.get(r.mc).push(r);
  }
  for (const list of map.values()) {
    list.sort((a, b) => compareVersions(b[key], a[key]));
  }
  return map;
}

// ---------------------------------------------------------------------------
register({
  id: 'forge',
  label: 'Forge',
  kind: 'modded',
  description: 'The classic mod loader. Needed for most older modpacks and many big mods.',
  supportsLoaders: true,

  async listMcVersions({ includeSnapshots = false } = {}) {
    const rows = await forgeVersions();
    const out = [...groupByMc(rows, 'forge').keys()].map((mc) => ({ id: mc, type: 'release' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async listLoaders(mcVersion) {
    const rows = (await forgeVersions()).filter((r) => r.mc === mcVersion);
    const promos = await forgePromotions();
    const rec = promos[`${mcVersion}-recommended`];
    const latest = promos[`${mcVersion}-latest`];
    return rows.map((r) => ({
      id: r.forge,
      stable: r.forge === rec || r.forge === latest,
      note: r.forge === rec ? 'recommended' : (r.forge === latest ? 'latest' : undefined)
    }));
  },

  async resolve({ mcVersion, loaderVersion }) {
    const rows = (await forgeVersions()).filter((r) => r.mc === mcVersion);
    if (!rows.length) throw new Error(`Forge has no build for ${mcVersion}`);
    const promos = await forgePromotions();
    const rec = promos[`${mcVersion}-recommended`];
    const forge = loaderVersion || rec || rows[0].forge;
    const base = `${FORGE_MAVEN}/${mcVersion}-${forge}`;
    const url = `${base}/forge-${mcVersion}-${forge}-installer.jar`;

    // Forge publishes a .sha1 sidecar file next to each artifact.
    let sha1 = null;
    try {
      const txt = await fetchText(`${url}.sha1`, { timeout: 15000 });
      const m = txt.match(/\b([0-9a-fA-F]{40})\b/);
      if (m) sha1 = m[1].toLowerCase();
    } catch (err) {
      log.warn(`no sha1 sidecar for forge ${mcVersion}-${forge}: ${err.message}`);
    }

    return {
      url,
      filename: `forge-${mcVersion}-${forge}-installer.jar`,
      hashes: { sha1 },
      mode: 'installer',
      installArgs: ['--installServer'],
      launch: { mode: 'script' },
      notes: `Forge ${mcVersion} ${forge}`
    };
  }
});

// ---------------------------------------------------------------------------
register({
  id: 'neoforge',
  label: 'NeoForge',
  kind: 'modded',
  recommended: true,
  description: 'Modern Forge fork, the default for Minecraft 1.20.2+ modpacks.',
  supportsLoaders: true,

  async listMcVersions({ includeSnapshots = false } = {}) {
    const rows = await neoforgeVersions();
    const out = [...groupByMc(rows, 'neo').keys()].map((mc) => ({ id: mc, type: 'release' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async listLoaders(mcVersion) {
    const rows = (await neoforgeVersions()).filter((r) => r.mc === mcVersion);
    return rows.map((r) => ({ id: r.neo, stable: r.stable }));
  },

  async resolve({ mcVersion, loaderVersion }) {
    const rows = (await neoforgeVersions()).filter((r) => r.mc === mcVersion);
    if (!rows.length) throw new Error(`NeoForge has no build for ${mcVersion}`);
    const stable = rows.find((r) => r.stable);
    const neo = loaderVersion || (stable || rows[0]).neo;
    return {
      url: `${NEOFORGE_MAVEN}/${neo}/neoforge-${neo}-installer.jar`,
      filename: `neoforge-${neo}-installer.jar`,
      hashes: {},
      mode: 'installer',
      installArgs: ['--installServer'],
      launch: { mode: 'script' },
      notes: `NeoForge ${mcVersion} ${neo}`
    };
  }
});

module.exports = { forgeVersions, neoforgeVersions, forgePromotions };
