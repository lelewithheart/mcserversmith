'use strict';
/**
 * Purpur — a Paper fork with a big pile of toggles (riding, AFK, TPS bar...).
 *   GET /v2/purpur                       -> { metadata, versions }
 *   GET /v2/purpur/{version}             -> { builds: { latest, all } }
 *   GET /v2/purpur/{version}/{build}     -> { build, md5, timestamp }
 *   GET /v2/purpur/{version}/{build}/download
 */
const { fetchJSON } = require('../core/http');
const { compareVersions } = require('../core/util');
const { register, memo } = require('./index');

const BASE = 'https://api.purpurmc.org/v2/purpur';

register({
  id: 'purpur',
  label: 'Purpur',
  kind: 'plugin',
  recommended: true,
  description: 'Paper fork with tons of gameplay toggles. Great if you want to tune everything.',
  supportsLoaders: false,

  async listMcVersions({ includeSnapshots = false } = {}) {
    const data = await memo('purpur:versions', 15 * 60 * 1000, () => fetchJSON(BASE));
    const versions = (data && data.versions) || [];
    const out = versions
      .filter((v) => includeSnapshots || !/-(pre|rc|snapshot)/i.test(v))
      .map((v) => ({ id: v, type: /-(pre|rc|snapshot)/i.test(v) ? 'snapshot' : 'release' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async resolve({ mcVersion }) {
    const info = await memo(`purpur:v:${mcVersion}`, 5 * 60 * 1000, () => fetchJSON(`${BASE}/${mcVersion}`));
    const latest = info && info.builds && info.builds.latest;
    if (!latest) throw new Error(`Purpur has no build for ${mcVersion}`);
    let md5 = null;
    try {
      const b = await memo(`purpur:b:${mcVersion}:${latest}`, 30 * 60 * 1000,
        () => fetchJSON(`${BASE}/${mcVersion}/${latest}`));
      md5 = (b && b.md5) || null;
    } catch { /* md5 is a nice-to-have */ }
    return {
      url: `${BASE}/${mcVersion}/${latest}/download`,
      filename: `purpur-${mcVersion}-${latest}.jar`,
      hashes: { md5 },
      mode: 'jar',
      buildId: latest,
      notes: `Purpur ${mcVersion} build ${latest}`
    };
  }
});

module.exports = { BASE };
