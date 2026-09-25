'use strict';
/**
 * Fabric — lightweight mod loader.
 *   GET /v2/versions/game                       -> [ { version, stable } ]
 *   GET /v2/versions/loader/{game}              -> [ { loader: { version, stable } } ]
 *   GET /v2/versions/installer                  -> [ { version, url } ]
 *
 * We use the official installer flow (`fabric-installer.jar server -mcversion X
 * -downloadMinecraft`) because it produces a ready fabric-server-launch.jar AND
 * fetches the matching vanilla server jar — the officially documented path.
 * After install the server is launched as a plain jar.
 */
const { fetchJSON } = require('../core/http');
const { compareVersions } = require('../core/util');
const { register, memo } = require('./index');

const META = 'https://meta.fabricmc.net/v2';

register({
  id: 'fabric',
  label: 'Fabric',
  kind: 'modded',
  recommended: true,
  description: 'Lightweight mod loader. Best choice for performance mods (Sodium/Lithium on the client side, Lithium/C2ME on the server).',
  supportsLoaders: true,

  async listMcVersions({ includeSnapshots = false } = {}) {
    const games = await memo('fabric:games', 10 * 60 * 1000,
      () => fetchJSON(`${META}/versions/game`));
    const out = (games || [])
      .filter((g) => includeSnapshots || g.stable)
      .map((g) => ({ id: g.version, type: g.stable ? 'release' : 'snapshot' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async listLoaders(mcVersion) {
    const data = await memo(`fabric:loaders:${mcVersion}`, 10 * 60 * 1000,
      () => fetchJSON(`${META}/versions/loader/${mcVersion}`));
    return (data || []).map((row) => ({
      id: row.loader.version,
      stable: !!row.loader.stable
    }));
  },

  async resolve({ mcVersion, loaderVersion }) {
    const loaders = await this.listLoaders(mcVersion);
    if (!loaders.length) throw new Error(`Fabric has no loader for ${mcVersion}`);
    const loader = loaderVersion || (loaders.find((l) => l.stable) || loaders[0]).id;

    const installers = await memo('fabric:installers', 60 * 60 * 1000,
      () => fetchJSON(`${META}/versions/installer`));
    const installer = (installers || []).find((i) => i.stable) || (installers || [])[0];
    if (!installer) throw new Error('Fabric installer metadata unavailable');

    return {
      url: installer.url,
      filename: `fabric-installer-${installer.version}.jar`,
      hashes: {},
      mode: 'installer',
      installArgs: ['server', '-mcversion', mcVersion, '-loader', loader, '-downloadMinecraft'],
      launch: { mode: 'jar', jar: 'fabric-server-launch.jar' },
      notes: `Fabric ${mcVersion} + loader ${loader}`
    };
  }
});

module.exports = { META };
