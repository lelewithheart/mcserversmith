'use strict';
/** Vanilla Minecraft — Mojang's own server jar (piston-meta / piston-data). */
const { fetchJSON } = require('../core/http');
const { compareVersions, createLogger } = require('../core/util');
const { register, memo } = require('./index');

const log = createLogger('provider:vanilla');

const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

async function manifest() {
  return memo('mojang:manifest', 10 * 60 * 1000, () => fetchJSON(MANIFEST));
}

async function versionJson(id) {
  const m = await manifest();
  const entry = (m.versions || []).find((v) => v.id === id);
  if (!entry) throw new Error(`Minecraft version ${id} not found in Mojang manifest`);
  return memo(`mojang:vj:${id}`, 60 * 60 * 1000, () => fetchJSON(entry.url));
}

register({
  id: 'vanilla',
  label: 'Vanilla',
  kind: 'vanilla',
  recommended: false,
  description: 'Official Mojang server. Most stable, no plugins, no optimisations.',
  supportsLoaders: false,

  async listMcVersions({ includeSnapshots = false } = {}) {
    const m = await manifest();
    const wanted = includeSnapshots ? ['release', 'snapshot'] : ['release'];
    const out = (m.versions || [])
      .filter((v) => wanted.includes(v.type))
      .map((v) => ({ id: v.id, type: v.type === 'snapshot' ? 'snapshot' : 'release' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async resolve({ mcVersion }) {
    const vj = await versionJson(mcVersion);
    const d = vj.downloads && vj.downloads.server;
    if (!d) throw new Error(`Vanilla ${mcVersion} has no server download (too old?)`);
    return {
      url: d.url,
      filename: 'server.jar',
      hashes: { sha1: d.sha1 },
      size: d.size,
      mode: 'jar',
      javaFloor: vj.javaVersion && vj.javaVersion.majorVersion,
      notes: `Mojang ${mcVersion}`
    };
  }
});

module.exports = { manifest, versionJson };
