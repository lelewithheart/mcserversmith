'use strict';
/**
 * Plugin/mod browser smoke test — hits the real Modrinth and Hangar APIs.
 *   node tools/test-plugins.js
 *
 * Covers the facet builder offline (the comma-joined category bug that made
 * every Modrinth search answer HTTP 400) and then walks search -> versions ->
 * download URL for every server type that has an addons tab.
 */
const path = require('path');
const { setDataRoot, ensureDirs } = require('../src/main/core/paths');
const plugins = require('../src/main/servers/plugins');

setDataRoot(process.env.MCSERVERSMITH_DATA || './.devdata');
ensureDirs();

const failures = [];
let passed = 0;

async function check(label, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    passed += 1;
    console.log(`  OK   ${label} (${Date.now() - t0}ms)`);
    return value;
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    failures.push(`${label}: ${err.message}`);
    return null;
  }
}

/** the meta shape instances.read() produces */
const meta = (provider, mcVersion = '1.21.4') => ({
  provider,
  mcVersion,
  kind: plugins.folderFor({ kind: 'plugin' }) ? 'plugin' : 'plugin',
  kindFor: provider
});

const types = [
  { provider: 'paper', meta: { provider: 'paper', kind: 'plugin', mcVersion: '1.21.4' }, query: 'worldedit' },
  { provider: 'purpur', meta: { provider: 'purpur', kind: 'plugin', mcVersion: '1.21.4' }, query: 'essentialsx' },
  { provider: 'folia', meta: { provider: 'folia', kind: 'plugin', mcVersion: '1.21.4' }, query: 'worldedit' },
  { provider: 'spigot', meta: { provider: 'spigot', kind: 'plugin', mcVersion: '1.21.4' }, query: 'vault' },
  { provider: 'velocity', meta: { provider: 'velocity', kind: 'proxy', mcVersion: '1.21.4' }, query: 'luckperms' },
  { provider: 'fabric', meta: { provider: 'fabric', kind: 'modded', mcVersion: '1.21.4' }, query: 'sodium' },
  { provider: 'forge', meta: { provider: 'forge', kind: 'modded', mcVersion: '1.21.4' }, query: 'jei' },
  { provider: 'neoforge', meta: { provider: 'neoforge', kind: 'modded', mcVersion: '1.21.4' }, query: 'jei' }
];

async function main() {
  console.log('\n=== facet builder (offline) ===');
  await check('every category is its own facet string (no commas)', () => {
    const f = plugins.facetGroups({ projectType: 'plugin', loaders: ['paper', 'bukkit', 'spigot'], gameVersion: '1.21.4' });
    const flat = JSON.stringify(f);
    if (flat.includes(',')) {
      const bad = f.find((g) => g.some((s) => s.includes(',')));
      if (bad) throw new Error(`comma inside a facet value: ${JSON.stringify(bad)}`);
    }
    if (f.length !== 3 || f[1].length !== 3) throw new Error(`unexpected shape: ${flat}`);
    return flat;
  });
  await check('no game version -> no versions group', () => {
    const f = plugins.facetGroups({ projectType: 'mod', loaders: ['fabric'] });
    if (f.length !== 2) throw new Error(JSON.stringify(f));
    return JSON.stringify(f);
  });

  console.log('\n=== Modrinth search + versions (live) ===');
  for (const t of types) {
    const hits = await check(`search ${t.provider} "${t.query}"`, () => plugins.search({
      source: 'modrinth', query: t.query, meta: t.meta, mcVersion: t.meta.mcVersion, limit: 5
    }));
    if (!hits) continue;
    console.log(`       -> ${hits.length} hits${hits[0] ? `, top: ${hits[0].name} (${hits[0].slug})` : ''}`);
    if (!hits.length) { failures.push(`search ${t.provider} "${t.query}": 0 hits`); continue; }
    const vs = await check(`versions ${t.provider} -> ${hits[0].slug}`, () => plugins.versions({
      source: 'modrinth', id: hits[0].id, meta: t.meta, mcVersion: t.meta.mcVersion, limit: 5
    }));
    if (!vs) continue;
    console.log(`       -> ${vs.length} versions${vs[0] ? `, newest: ${vs[0].name}` : ''}`);
    if (!vs.length) failures.push(`versions ${t.provider} ${hits[0].slug}: 0 versions`);
    else if (!vs[0].downloadUrl) failures.push(`versions ${t.provider} ${hits[0].slug}: no download URL`);
  }

  console.log('\n=== Modrinth without a game version (facet must stay optional) ===');
  await check('search paper "worldedit" without mcVersion', async () => {
    const hits = await plugins.search({ source: 'modrinth', query: 'worldedit', meta: types[0].meta, limit: 5 });
    if (!hits.length) throw new Error('0 hits');
    return `${hits.length} hits`;
  });

  console.log('\n=== a server with no addon support is refused ===');
  await check('vanilla is rejected', async () => {
    try {
      await plugins.search({ source: 'modrinth', query: 'worldedit', meta: { provider: 'vanilla', kind: 'vanilla', mcVersion: '1.21.4' } });
    } catch (err) {
      return err.message;
    }
    throw new Error('search did not refuse a vanilla server');
  });

  console.log('\n=== install into a real instance (search -> versions -> download) ===');
  const instances = require('../src/main/servers/instances');
  let instId = null;
  const created = await check('throwaway paper instance', () => {
    const m = instances.create({
      name: 'plugin-smoke', provider: 'paper', kind: 'plugin',
      mcVersion: '1.21.4', port: 25599, rconPort: 26599, acceptEula: true
    });
    instId = m.id;
    return m.id;
  });

  if (created) {
    const instMeta = instances.read(instId);
    const hits = await plugins.search({ source: 'modrinth', query: 'worldedit', meta: instMeta, mcVersion: instMeta.mcVersion, limit: 5 });
    const project = hits.find((h) => h.slug === 'worldedit') || hits[0];
    const vs = project ? await plugins.versions({ source: 'modrinth', id: project.id, meta: instMeta, mcVersion: instMeta.mcVersion, limit: 20 }) : [];
    // the smallest build keeps the test quick
    const pick = vs.filter((v) => v.downloadUrl).sort((a, b) => (a.size || 0) - (b.size || 0))[0];
    console.log(`       chosen: ${pick ? `${pick.name} (${Math.round((pick.size || 0) / 1024)} KB)` : 'none'}`);

    if (pick) {
      await check('download verifies the published checksum', async () => {
        const res = await plugins.install(null, instId, {
          downloadUrl: pick.downloadUrl, filename: pick.filename, hashes: pick.hashes
        });
        const listed = plugins.installedAddons(instId);
        if (!listed.files.some((f) => f.name === res.filename)) throw new Error(`not in plugins/: ${JSON.stringify(listed)}`);
        return `${res.filename} -> ${listed.folder}/`;
      });

      await check('a sha512 value labelled as sha256 is refused (the old handoff)', async () => {
        const wrong = { sha256: pick.hashes.sha512 || pick.hashes.sha1 };
        if (!wrong.sha256) return 'skipped: no sha512/sha1 published';
        const target = path.join(require('os').tmpdir(), `addon-wrong-hash-${Date.now()}.jar`);
        try {
          const { download } = require('../src/main/core/http');
          await download(pick.downloadUrl, target, { hashes: wrong });
        } catch (err) {
          if (!/Checksum mismatch/.test(err.message)) throw err;
          return 'refused with Checksum mismatch';
        } finally {
          require('fs').rmSync(target, { force: true });
          require('fs').rmSync(`${target}.part`, { force: true });
        }
        throw new Error('a wrongly labelled hash was accepted');
      });

      await check('remove takes it out again', () => {
        plugins.removeAddon(instId, pick.filename);
        const listed = plugins.installedAddons(instId);
        if (listed.files.length) throw new Error(JSON.stringify(listed.files));
        return 'plugins/ is empty again';
      });
    }

    instances.remove(instId);
    console.log(`       cleaned up ${instId}`);
  }

  console.log('\n=== Hangar (live) ===');
  const hangarHits = await check('search hangar "worldedit" (paper)', () => plugins.search({
    source: 'hangar', query: 'worldedit', meta: types[0].meta, mcVersion: types[0].meta.mcVersion, limit: 5
  }));
  if (hangarHits) {
    console.log(`       -> ${hangarHits.length} hits${hangarHits[0] ? `, top: ${hangarHits[0].name}` : ''}`);
    if (!hangarHits.length) failures.push('hangar search: 0 hits');
    else {
      const hv = await check(`versions hangar -> ${hangarHits[0].id}`, () => plugins.versions({
        source: 'hangar', id: hangarHits[0].id, meta: types[0].meta, mcVersion: types[0].meta.mcVersion, limit: 5
      }));
      if (hv && hv.length) console.log(`       -> ${hv.length} versions, newest: ${hv[0].name}`);
      else failures.push('hangar versions: empty');
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`${passed} checks passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`all ${passed} plugin-browser checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`test crashed: ${err.stack || err.message}`);
  process.exit(2);
});
