#!/usr/bin/env node
'use strict';
/**
 * Checks the file browser against a real, fully installed instance.
 *   node tools/test-files.js --data=.devdata-inspect-forge
 *   node tools/test-files.js --data=.devdata-spigot
 */
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const DATA = path.resolve(args.data || path.join(__dirname, '..', '.devdata-inspect-forge'));
process.env.MCSERVERSMITH_DATA = DATA;

const { setDataRoot, ensureDirs } = require('../src/main/core/paths');
setDataRoot(DATA);
ensureDirs();

const files = require('../src/main/servers/files');
const instances = require('../src/main/servers/instances');

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const all = instances.list();
if (!all.length) { console.error(`No instance in ${DATA}`); process.exit(2); }
const meta = all[0];
console.log(`\n=== ${meta.id} (${meta.provider} ${meta.mcVersion}, kind=${meta.kind}) ===\n`);

// --- simple view ---
const simple = files.simple(meta.id);
const visible = simple.rows.filter((r) => r.exists);
console.log('simple view shows:');
for (const r of visible) console.log(`  ${r.dir ? 'dir ' : 'file'}  ${r.rel.padEnd(28)} ${r.dir ? '' : r.size + ' B'}`);
console.log('');

record('simple view is not empty', visible.length > 0, `${visible.length} of ${simple.rows.length} rows exist`);
record('world detected', visible.some((r) => r.key === 'world'), `level-name = ${simple.levelName}`);
const expectDir = meta.kind === 'modded' ? 'mods' : 'plugins';
record(`${expectDir} folder detected`, visible.some((r) => r.key === (meta.kind === 'modded' ? 'mods' : 'plugins')));
record('logs detected', visible.some((r) => r.key === 'logs'));
record('server.properties detected', visible.some((r) => r.rel === 'server.properties'));
record('simple view has no deep paths', visible.every((r) => !r.rel.includes('/') || r.rel.split('/').length <= 1),
  visible.map((r) => r.rel).filter((r) => r.includes('/')).join(',') || 'none');

// --- advanced view ---
const root = files.list(meta.id, '');
record('advanced: root lists files', root.entries.length > 0, `${root.entries.length} entries`);
record('advanced: dirs sort first', root.entries.length < 2 || root.entries[0].dir === true);
const jars = root.entries.filter((e) => e.name.endsWith('.jar'));
record('advanced: server jar visible at root', jars.length > 0, jars.map((j) => j.name).join(', '));

const modsDir = files.list(meta.id, meta.kind === 'modded' ? 'mods' : 'plugins');
record('advanced: can list the mods/plugins folder', Array.isArray(modsDir.entries), `${modsDir.entries.length} entries`);

// --- safety ---
let refused = 0;
for (const bad of ['../..', '../../../../etc', '..\\..', '/etc', 'libraries/../../..']) {
  try { files.list(meta.id, bad); } catch { refused += 1; }
}
record('traversal attempts all refused', refused === 5, `${refused}/5`);
let rootDeleteRefused = false;
try { files.remove(meta.id, ''); } catch { rootDeleteRefused = true; }
record('deleting the server root is refused', rootDeleteRefused);

// --- size ---
const size = files.folderSize(meta.id, meta.kind === 'modded' ? 'mods' : 'plugins');
record('folder size measurable', size >= 0, `${size} B`);

console.log(`\n=== ${results.filter(Boolean).length}/${results.length} checks passed ===`);
process.exit(results.every(Boolean) ? 0 : 1);
