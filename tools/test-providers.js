'use strict';
/**
 * Provider layer smoke test — hits the real upstream APIs.
 *   node tools/test-providers.js
 */
require('../src/main/providers/mojang');
require('../src/main/providers/fill');
require('../src/main/providers/purpur');
require('../src/main/providers/fabric');
require('../src/main/providers/forge');
require('../src/main/providers/spigot');

const registry = require('../src/main/providers');
const javaruntime = require('../src/main/java/runtime');
const { setDataRoot, ensureDirs } = require('../src/main/core/paths');

setDataRoot(process.env.MCSERVERSMITH_DATA || './.devdata');
ensureDirs();

const failures = [];

async function check(label, fn, { slow = false } = {}) {
  const t0 = Date.now();
  try {
    const value = await fn();
    console.log(`  OK   ${label} (${Date.now() - t0}ms)`);
    return value;
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    failures.push(`${label}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('\n=== Provider registry ===');
  for (const p of registry.list()) {
    console.log(`  ${p.id.padEnd(10)} ${p.kind.padEnd(8)} ${p.advanced ? '[advanced] ' : ''}${p.label}`);
  }

  console.log('\n=== Version lists ===');
  const versionsByProvider = {};
  for (const p of registry.list()) {
    const prov = registry.get(p.id);
    const vs = await check(`${p.id}.listMcVersions`, () => prov.listMcVersions({ includeSnapshots: false }));
    if (vs) {
      versionsByProvider[p.id] = vs;
      console.log(`       -> ${vs.length} versions, newest: ${vs.slice(0, 3).map((v) => v.id).join(', ')}`);
    }
  }

  console.log('\n=== Loaders ===');
  for (const id of ['fabric', 'forge', 'neoforge']) {
    const prov = registry.get(id);
    const vs = versionsByProvider[id] || [];
    const mc = vs[0] && vs[0].id;
    if (!mc) continue;
    const ls = await check(`${id}.listLoaders(${mc})`, () => prov.listLoaders(mc));
    if (ls) console.log(`       -> ${ls.length} builds, newest: ${ls.slice(0, 3).map((l) => l.id).join(', ')}`);
  }

  console.log('\n=== resolve() — every provider must produce a real artifact ===');
  const pick = (id) => {
    const vs = versionsByProvider[id] || [];
    return vs[0] ? vs[0].id : null;
  };

  for (const p of registry.list()) {
    const prov = registry.get(p.id);
    const mc = pick(p.id);
    if (!mc) { console.log(`  SKIP ${p.id} (no versions)`); continue; }
    const art = await check(`${p.id}.resolve(${mc})`, () => prov.resolve({ mcVersion: mc }));
    if (art) {
      console.log(`       mode=${art.mode} file=${art.filename}`);
      console.log(`       url=${art.url}`);
      const hashes = Object.entries(art.hashes || {}).filter(([, v]) => v);
      console.log(`       hashes=${hashes.length ? hashes.map(([k, v]) => `${k}:${String(v).slice(0, 12)}…`).join(' ') : '(none — no upstream checksum published)'}`);
    }
  }

  console.log('\n=== Java requirement heuristic ===');
  for (const mc of ['1.8.9', '1.12.2', '1.16.5', '1.17.1', '1.19.4', '1.20.4', '1.20.6', '1.21.4', '26.1', '26.3']) {
    const { feature, source } = javaruntime.requiredJava({ mcVersion: mc });
    console.log(`  ${mc.padEnd(8)} -> Java ${String(feature).padStart(2)}   (${source})`);
  }

  console.log(`\n${failures.length === 0 ? 'ALL PROVIDER CHECKS PASSED' : `FAILURES (${failures.length}):\n  ${failures.join('\n  ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(2);
});
