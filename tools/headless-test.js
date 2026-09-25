#!/usr/bin/env node
'use strict';
/**
 * End-to-end headless test: really downloads a server + a JVM, really starts it,
 * really pings it, really stops it. This is the proof that the whole backend
 * works outside of Electron.
 *
 *   node tools/headless-test.js                 # paper 1.21.4, port 25599
 *   node tools/headless-test.js --mc=26.3       # newest (may need Java 25)
 *   node tools/headless-test.js --provider=fabric
 *   node tools/headless-test.js --keep          # leave the instance on disk
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const MC = args.mc || '1.21.4';
const PROVIDER = args.provider || 'paper';
const PORT = Number(args.port || 25599);
const MEMORY = Number(args.memory || 1024);
const DATA_ROOT = path.resolve(args.data || path.join(__dirname, '..', '.devdata-e2e'));
const KEEP = !!args.keep;
const READY_TIMEOUT_MS = Number(args.timeout || 480000);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function waitFor(fn, { timeoutMs = 30000, intervalMs = 1000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      let ok = false;
      let value;
      try { value = await fn(); ok = !!value; } catch { ok = false; }
      if (ok) { clearInterval(iv); resolve(value); return; }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label} after ${Math.round((Date.now() - t0) / 1000)}s`));
      }
    }, intervalMs);
  });
}

async function main() {
  console.log(`\n=== MCServerSmith headless end-to-end test ===`);
  console.log(`provider=${PROVIDER} mc=${MC} port=${PORT} memory=${MEMORY}MB`);
  console.log(`data root: ${DATA_ROOT}\n`);

  process.env.MCSERVERSMITH_DATA = DATA_ROOT;

  const { setDataRoot, getDirs, ensureDirs } = require('../src/main/core/paths');
  require('../src/main/providers/mojang');
  require('../src/main/providers/fill');
  require('../src/main/providers/purpur');
  require('../src/main/providers/fabric');
  require('../src/main/providers/forge');
  require('../src/main/providers/spigot');
  const javaruntime = require('../src/main/java/runtime');
  const { ServerManager } = require('../src/main/servers/manager');
  const instances = require('../src/main/servers/instances');
  const slp = require('../src/main/servers/slp');
  const backup = require('../src/main/servers/backup');

  setDataRoot(DATA_ROOT);
  ensureDirs();

  const manager = new ServerManager();
  manager.init();

  // stream interesting events
  manager.on('event', (ev) => {
    if (ev.type === 'log' && /Download|Java ready|Installed|Done \(|Scheduled|backup|Backup|tunnel|Auto-restart/i.test(ev.payload.line)) {
      console.log(`   [${ev.id.split('-').pop()}] ${ev.payload.line}`);
    }
    if (ev.type === 'state') console.log(`   [state] ${ev.payload.state} (pid ${ev.payload.pid || '-'})`);
    if (ev.type === 'progress' && ev.payload.message) console.log(`   [install ${String(ev.payload.percent).padStart(3)}%] ${ev.payload.message}`);
    if (ev.type === 'error') console.log(`   [error] ${ev.payload.message}`);
  });

  // ---------------------------------------------------------------------
  const providerList = require('../src/main/providers').list();
  record('provider registry', providerList.length >= 7, providerList.map((p) => p.id).join(', '));

  const meta = manager.createInstance({
    name: `e2e ${PROVIDER}`,
    provider: PROVIDER,
    mcVersion: MC,
    memoryMB: MEMORY,
    port: PORT,
    rconPort: PORT + 1000,
    acceptEula: true,
    maxPlayers: 5
  });
  record('instance created', !!meta.id, meta.id);
  record('directory layout', fs.existsSync(instances.instancePaths(meta.id).server), instances.instancePaths(meta.id).dir);
  record('server.properties seeded', /server-port=/.test(fs.readFileSync(instances.instancePaths(meta.id).properties, 'utf8')));

  const tInstall = Date.now();
  const installed = await manager.installInstance(meta.id);
  record('install pipeline', installed.installed === true, `${Math.round((Date.now() - tInstall) / 1000)}s, Java ${installed.javaFeature}, launch=${installed.launch.mode}`);
  record('manifest written', !!instances.readManifest(meta.id));
  if (installed.launch.mode === 'jar') {
    record('launch jar present', fs.existsSync(path.join(instances.instancePaths(meta.id).server, installed.launch.jar)), installed.launch.jar);
  }
  record('java runtime on disk', !!javaruntime.javaBinary(installed.javaFeature, installed.javaKind), javaruntime.javaBinary(installed.javaFeature, installed.javaKind));

  // ---------------------------------------------------------------------
  const tStart = Date.now();
  await manager.startInstance(meta.id);
  record('process spawned', !!manager.runtime.get(meta.id).supervisor.pid, `pid ${manager.runtime.get(meta.id).supervisor.pid}`);

  let online = false;
  try {
    await waitFor(async () => {
      const st = await manager.status(meta.id);
      return st.state === 'online' ? st : null;
    }, { timeoutMs: READY_TIMEOUT_MS, intervalMs: 2000, label: 'server ready ("Done (...)!")' });
    online = true;
  } catch (err) {
    record('server reached "Done"', false, err.message);
    const sup = manager.runtime.get(meta.id).supervisor;
    console.log('\n--- last console lines ---');
    console.log(sup.consoleTail(40).map((l) => l.line).join('\n'));
  }
  if (online) {
    record('server reached "Done"', true, `${Math.round((Date.now() - tStart) / 1000)}s`);

    const status = await manager.status(meta.id);
    record('status: state online', status.state === 'online');
    record('status: players reported', status.players.max === 5, `online=${status.players.online} max=${status.players.max}`);
    // the internal status ping can still be one tick behind the listening socket
    let motd = null;
    try {
      motd = await waitFor(async () => {
        const s = await manager.status(meta.id);
        return s.server && s.server.motd ? s.server.motd : null;
      }, { timeoutMs: 20000, intervalMs: 1000, label: 'MOTD from status ping' });
    } catch (err) {
      record('status: motd from ping', false, err.message);
    }
    if (motd) record('status: motd from ping', true, String(motd).slice(0, 40));
    record('status: join address', !!status.address.joinAddress, status.address.joinAddress);
    record('status: java feature', status.jvm.javaFeature >= 8, `Java ${status.jvm.javaFeature}`);

    const direct = await slp.ping('127.0.0.1', PORT, { timeout: 6000 });
    record('server list ping (direct)', direct.online === true, `latency ${direct.latency}ms, version ${direct.version}`);

    // console command through stdin
    manager.sendCommand(meta.id, 'say hello from MCServerSmith');
    await new Promise((r) => setTimeout(r, 1500));
    const logText = manager.getConsole(meta.id, 200).map((l) => l.line).join('\n')
      + fs.readFileSync(instances.instancePaths(meta.id).latestLog, 'utf8');
    record('console command executed', /\[Server\] hello from MCServerSmith|hello from MCServerSmith/i.test(logText));

    // RCON round trip
    try {
      const listOut = await manager.rconCommand(meta.id, 'list');
      record('rcon round trip', /There are \d+ of a max/i.test(listOut), listOut.trim().slice(0, 60));
    } catch (err) {
      record('rcon round trip', false, err.message);
    }

    // CPU/RAM sampling
    await new Promise((r) => setTimeout(r, 3500));
    const st2 = await manager.status(meta.id);
    record('metrics: rss sampled', st2.metrics.rssBytes > 0, `rss=${Math.round((st2.metrics.rssBytes || 0) / 1048576)}MB cpu=${st2.metrics.cpuPercent}%`);

    // backup while running
    try {
      const b = await backup.createBackup(manager, meta.id, { label: 'e2e' });
      record('backup created', fs.existsSync(b.path), `${b.name} (${Math.round(b.bytes / 1024)} KB)`);
      const list = backup.listBackups(meta.id);
      record('backup listed', list.length >= 1, list.map((x) => x.name).join(', '));
    } catch (err) {
      record('backup created', false, err.message);
    }

    // world size shows up after the world exists
    try {
      await waitFor(async () => {
        const st = await manager.status(meta.id);
        return st.worldSizeBytes > 0;
      }, { timeoutMs: 90000, intervalMs: 5000, label: 'world size' });
      const st3 = await manager.status(meta.id);
      record('world size measured', st3.worldSizeBytes > 0, `${Math.round(st3.worldSizeBytes / 1024)} KB`);
    } catch (err) {
      record('world size measured', false, err.message);
    }
  }

  // ---------------------------------------------------------------------
  const tStop = Date.now();
  await manager.stopInstance(meta.id);
  const stopOk = await waitFor(async () => {
    const rt = manager.runtime.get(meta.id);
    return !rt.supervisor || !rt.supervisor.child;
  }, { timeoutMs: 90000, intervalMs: 1000, label: 'graceful shutdown' }).then(() => true).catch(() => false);
  record('graceful stop', stopOk, `${Math.round((Date.now() - tStop) / 1000)}s`);
  const final = await manager.status(meta.id);
  record('state offline after stop', final.state === 'offline', final.state);

  // ---------------------------------------------------------------------
  // licence gating (no key installed -> free tier)
  const license = require('../src/main/licensing/license');
  const monetize = require('../src/main/licensing/monetize');
  record('licence tier without key', license.tier() === 'free', `tier=${license.tier()}`);
  let gated = false;
  try { license.requireFeature('tunnel'); } catch (err) { gated = err.code === 'LICENSE_REQUIRED'; }
  record('paid feature is gated', gated);
  const mi = monetize.info();
  record('monetisation config', mi.hosters.length >= 3, `${mi.hosters.length} hosters, ${mi.hosters.filter((h) => h.isAffiliate).length} with affiliate id`);

  manager.stopPolling();

  if (!KEEP) {
    await manager.deleteInstance(meta.id, { deleteFiles: true });
    console.log('\n(instance deleted — use --keep to inspect it)');
  } else {
    console.log(`\n(instance kept at ${instances.instancePaths(meta.id).dir})`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nHARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(2);
});
