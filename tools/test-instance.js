#!/usr/bin/env node
'use strict';
/**
 * Start an already-installed instance, wait for "Done", report, stop it.
 * Handy to verify a kept instance after code changes.
 *
 *   node tools/test-instance.js --data=.devdata-inspect-forge
 *   node tools/test-instance.js --data=.devdata-inspect-forge --timeout=300
 */
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const DATA = path.resolve(args.data || path.join(__dirname, '..', '.devdata-e2e'));
const TIMEOUT = Number(args.timeout || 300) * 1000;
process.env.MCSERVERSMITH_DATA = DATA;

const { setDataRoot, ensureDirs } = require('../src/main/core/paths');
setDataRoot(DATA);
ensureDirs();
require('../src/main/providers/mojang');
require('../src/main/providers/fill');
require('../src/main/providers/purpur');
require('../src/main/providers/fabric');
require('../src/main/providers/forge');
require('../src/main/providers/spigot');

const { ServerManager } = require('../src/main/servers/manager');
const instances = require('../src/main/servers/instances');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const all = instances.list();
  if (!all.length) { console.error(`No instance in ${DATA}`); process.exit(2); }
  const meta = all[0];
  console.log(`\n=== starting ${meta.id} (${meta.provider} ${meta.mcVersion}, launch=${meta.launch.mode}) ===\n`);

  const manager = new ServerManager();
  manager.init();
  manager.on('event', (ev) => {
    if (ev.type === 'log') console.log(`  | ${ev.payload.line}`);
    if (ev.type === 'state') console.log(`  [state] ${ev.payload.state}`);
    if (ev.type === 'error') console.log(`  [error] ${ev.payload.message}`);
  });

  // what command will be used?
  const { ProcessSupervisor } = require('../src/main/servers/supervisor');
  const javaruntime = require('../src/main/java/runtime');
  const p = instances.instancePaths(meta.id);
  const probe = new ProcessSupervisor({
    meta, serverDir: p.server, logFile: p.latestLog,
    javaPath: javaruntime.javaBinary(meta.javaFeature, meta.javaKind || 'jre'),
    launch: meta.launch
  });
  try {
    const cmd = probe._buildCommand();
    console.log(`launch: ${cmd.cmd} ${cmd.args.join(' ')}${cmd.viaArgsFiles ? '  (argfiles)' : ''}\n`);
    record('launch command resolvable', true, path.basename(cmd.cmd));
    if (meta.launch.mode === 'script') {
      record('script mode resolves java argfiles instead of run.bat', !!cmd.viaArgsFiles, cmd.viaArgsFiles ? 'yes' : 'fell back to the script');
    }
  } catch (err) {
    record('launch command resolvable', false, err.message);
  }

  const t0 = Date.now();
  await manager.startInstance(meta.id);

  let online = false;
  try {
    const deadline = Date.now() + TIMEOUT;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const st = await manager.status(meta.id);
      if (st.state === 'online') { online = true; break; }
      if (st.state === 'crashed' || st.state === 'offline') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) { /* fall through */ }
  record('server reached "Done"', online, `${Math.round((Date.now() - t0) / 1000)}s`);

  if (online) {
    const st = await manager.status(meta.id);
    record('players queryable', st.players.max > 0, `${st.players.online}/${st.players.max}`);
    // the status ping needs a moment after the listening socket opens
    let motd = null;
    const motdDeadline = Date.now() + 30000;
    while (Date.now() < motdDeadline && !motd) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500));
      // eslint-disable-next-line no-await-in-loop
      const s = await manager.status(meta.id);
      if (s.server && s.server.motd) motd = s.server.motd;
    }
    record('motd visible', !!motd, String(motd || '').slice(0, 50));
    record('java feature correct for version', st.jvm.javaFeature >= 8, `Java ${st.jvm.javaFeature}`);
  }

  const tStop = Date.now();
  await manager.stopInstance(meta.id);
  const stopped = !manager.runtime.get(meta.id).supervisor.child;
  record('graceful stop', stopped, `${Math.round((Date.now() - tStop) / 1000)}s`);
  record('stop was fast (no lingering wrapper)', Date.now() - tStop < 45000, `${Math.round((Date.now() - tStop) / 1000)}s`);

  manager.stopPolling();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('CRASH:', err); process.exit(2); });
