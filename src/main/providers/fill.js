'use strict';
/**
 * PaperMC "Fill" v3 API — Paper, Folia and Velocity.
 * The legacy api.papermc.io/v2 endpoint is deprecated; v3 is the supported one.
 *   GET /v3/projects/{project}                        -> { project, versions: { family: [version...] } }
 *   GET /v3/projects/{project}/versions/{v}/builds    -> [ { id, time, channel, downloads } ]
 */
const { fetchJSON } = require('../core/http');
const { compareVersions, createLogger } = require('../core/util');
const { register, memo } = require('./index');

const log = createLogger('provider:fill');
const BASE = 'https://fill.papermc.io/v3';

function classify(version) {
  return /-(pre|rc)\d*/i.test(version) ? 'snapshot' : 'release';
}

async function project(id) {
  return memo(`fill:project:${id}`, 15 * 60 * 1000, () => fetchJSON(`${BASE}/projects/${id}`));
}

async function builds(id, mcVersion) {
  return memo(`fill:builds:${id}:${mcVersion}`, 5 * 60 * 1000,
    () => fetchJSON(`${BASE}/projects/${id}/versions/${mcVersion}/builds`));
}

function makeProvider({ id, label, kind, description, recommended, model }) {
  return register({
    id,
    label,
    kind,
    recommended,
    description,
    supportsLoaders: false,
    model: model || 'plugin',
    apiBase: BASE,

    async listMcVersions({ includeSnapshots = false } = {}) {
      const p = await project(id);
      const families = (p.versions && typeof p.versions === 'object') ? p.versions : {};
      const flat = [];
      for (const list of Object.values(families)) {
        for (const v of (list || [])) flat.push(v);
      }
      const uniq = [...new Set(flat)];
      const out = uniq
        .filter((v) => includeSnapshots || classify(v) === 'release')
        .map((v) => ({ id: v, type: classify(v) }));
      out.sort((a, b) => compareVersions(b.id, a.id));
      return out;
    },

    async resolve({ mcVersion, experimental = false }) {
      let list = await builds(id, mcVersion);
      if (!Array.isArray(list)) list = (list && list.builds) || [];
      if (list.length === 0) throw new Error(`${label} has no builds for ${mcVersion}`);
      const sorted = [...list].sort((a, b) => b.id - a.id);
      const stable = sorted.find((b) => String(b.channel).toUpperCase() === 'STABLE');
      const pick = (!experimental && stable) ? stable : sorted[0];
      const dl = (pick.downloads && (pick.downloads['server:default'] || Object.values(pick.downloads)[0]));
      if (!dl || !dl.url) throw new Error(`${label} build ${pick.id} for ${mcVersion} exposes no server download`);
      const channel = String(pick.channel || 'UNKNOWN').toUpperCase();
      return {
        url: dl.url,
        filename: dl.name || `${id}-${mcVersion}-${pick.id}.jar`,
        hashes: { sha256: dl.checksums && dl.checksums.sha256 },
        size: dl.size,
        mode: 'jar',
        channel,
        buildId: pick.id,
        notes: channel === 'STABLE'
          ? `${label} ${mcVersion} build ${pick.id}`
          : `${label} ${mcVersion} build ${pick.id} (${channel} — experimental!)`
      };
    }
  });
}

makeProvider({
  id: 'paper',
  label: 'Paper',
  kind: 'plugin',
  recommended: true,
  description: 'Best default for survival/plugin servers: fast, well optimised, huge plugin ecosystem.'
});

makeProvider({
  id: 'folia',
  label: 'Folia',
  kind: 'plugin',
  description: 'Paper fork with regionised multithreading. Huge performance for big player counts, but many plugins are incompatible.',
  model: 'plugin'
});

makeProvider({
  id: 'velocity',
  label: 'Velocity',
  kind: 'proxy',
  description: 'Proxy server to link several backend servers behind one address. Not a game server itself.',
  model: 'proxy'
});

module.exports = { BASE };
