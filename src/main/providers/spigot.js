'use strict';
/**
 * Spigot via BuildTools.
 *
 * Honest caveat: Spigot has NO download API on purpose. The only legitimate way
 * to obtain a Spigot jar is compiling it locally with BuildTools, which
 *   - needs git on PATH,
 *   - needs a JDK,
 *   - takes 5-30 minutes,
 *   - and can fail when upstream decompile mappings break.
 * Therefore this provider is marked advanced and the UI warns before using it.
 * Bukkit is deliberately NOT offered: it has been discontinued since 1.13.
 */
const { register } = require('./index');
const { fetchText, fetchJSON } = require('../core/http');
const { compareVersions } = require('../core/util');
const { ruleBasedFeature } = require('../java/runtime');

const BUILD_TOOLS = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';

register({
  id: 'spigot',
  label: 'Spigot',
  kind: 'plugin',
  advanced: true,
  description: 'The original plugin server. Still works, but Paper/Purpur are faster, drop-in compatible and much easier to install.',
  warnings: [
    'Spigot must be COMPILED on your machine (BuildTools). Expect 5-30 minutes and a few hundred MB of disk.',
    'Requires git to be installed and available on PATH.',
    'If it fails, use Paper instead — it runs every Spigot plugin.'
  ],
  supportsLoaders: false,

  async listMcVersions({ includeSnapshots = false } = {}) {
    // BuildTools can compile any release Mojang has published.
    const { manifest } = require('./mojang');
    const m = await manifest();
    const wanted = includeSnapshots ? ['release', 'snapshot'] : ['release'];
    const out = (m.versions || [])
      .filter((v) => wanted.includes(v.type))
      .map((v) => ({ id: v.id, type: v.type === 'snapshot' ? 'snapshot' : 'release' }));
    out.sort((a, b) => compareVersions(b.id, a.id));
    return out;
  },

  async resolve({ mcVersion }) {
    return {
      url: BUILD_TOOLS,
      filename: 'BuildTools.jar',
      hashes: {},
      mode: 'buildtools',
      buildArgs: ['--rev', mcVersion, '--compile', 'spigot'],
      buildToolsJava: ruleBasedFeature(mcVersion),
      launch: { mode: 'jar', jar: `spigot-${mcVersion}.jar` },
      notes: `Spigot ${mcVersion} (compiled locally with BuildTools)`
    };
  },

  /** Latest BuildTools revision, handy for the UI. */
  async buildToolsJar() {
    return BUILD_TOOLS;
  }
});

module.exports = { BUILD_TOOLS };
