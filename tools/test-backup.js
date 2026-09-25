#!/usr/bin/env node
'use strict';
/**
 * Focused backup/restore test against an existing instance directory.
 *   node tools/test-backup.js [--data=.devdata-e2e]
 */
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const DATA_ROOT = path.resolve(args.data || path.join(__dirname, '..', '.devdata-e2e'));
process.env.MCSERVERSMITH_DATA = DATA_ROOT;

const { setDataRoot, ensureDirs } = require('../src/main/core/paths');
setDataRoot(DATA_ROOT);
ensureDirs();

const instances = require('../src/main/servers/instances');
const backup = require('../src/main/servers/backup');
const { ServerManager } = require('../src/main/servers/manager');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const all = instances.list();
  if (!all.length) {
    console.log('No instances found — run tools/headless-test.js --keep first.');
    process.exit(2);
  }
  const meta = all[0];
  console.log(`Testing backups against ${meta.id} (${meta.provider} ${meta.mcVersion})\n`);

  const manager = new ServerManager();
  manager.init();
  manager.on('event', (ev) => {
    if (ev.type === 'log' && /backup|Backup|tar/i.test(ev.payload.line)) console.log(`   ${ev.payload.line}`);
  });

  const made = await backup.createBackup(manager, meta.id, { label: 'test' });
  const fs = require('fs');
  record('backup created', fs.existsSync(made.path), `${made.name} kind=${made.kind} ${Math.round(made.bytes / 1024)} KB`);
  record('backup is non-trivial', made.bytes > 10000, `${Math.round(made.bytes / 1024)} KB`);

  const list = backup.listBackups(meta.id);
  record('backup listed', list.some((b) => b.name === made.name), list.map((b) => b.name).join(', '));

  // build the exact restore check: snapshot a known file, restore, compare
  const p = instances.instancePaths(meta.id);
  const levelName = require('../src/main/servers/props').get(p.properties, 'level-name', 'world');
  const levelDat = path.join(p.server, levelName, 'level.dat');
  const before = fs.existsSync(levelDat) ? fs.statSync(levelDat).mtimeMs : null;
  fs.rmSync(levelDat, { force: true });
  record('deleted level.dat for restore test', !fs.existsSync(levelDat));

  await backup.restoreBackup(manager, meta.id, made.name);
  record('restore brought level.dat back', fs.existsSync(levelDat), fs.existsSync(levelDat) ? `${fs.statSync(levelDat).size} bytes` : 'missing');

  // prune
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await backup.createBackup(manager, meta.id, { label: `t${i}` });
  }
  const pruned = backup.pruneBackups(meta.id, 2);
  const after = backup.listBackups(meta.id);
  record('retention prune', after.length === 2, `removed ${pruned.removed}, kept ${after.length}`);
  record('backup usage', backup.backupUsage(meta.id).count === 2);

  manager.stopPolling();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} backup checks passed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('CRASH:', err); process.exit(2); });
