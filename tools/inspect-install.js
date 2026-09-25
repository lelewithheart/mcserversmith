#!/usr/bin/env node
'use strict';
/**
 * Dumps what an install actually produced — for debugging provider flows.
 *   node tools/inspect-install.js --provider=forge --mc=1.20.1
 *   node tools/inspect-install.js --provider=fabric --mc=1.21.4
 */
const path = require('path');
const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

const PROVIDER = args.provider || 'forge';
const MC = args.mc || '1.20.1';
const DATA = path.resolve(args.data || path.join(__dirname, '..', `.devdata-inspect-${PROVIDER}`));

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

function listing(dir, depth = 0, prefix = '') {
  if (!fs.existsSync(dir)) return ['(missing)'];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const size = e.isFile() ? ` ${fs.statSync(full).size}B` : '/';
    out.push(`${prefix}${e.name}${size}`);
    if (e.isDirectory() && depth < 1 && e.name !== 'libraries' && e.name !== 'world') {
      out.push(...listing(full, depth + 1, `${prefix}  `));
    }
  }
  return out;
}

async function main() {
  console.log(`\n=== inspecting ${PROVIDER} ${MC} ===`);
  console.log(`data: ${DATA}\n`);

  const manager = new ServerManager();
  manager.init();
  manager.on('event', (ev) => {
    if (ev.type === 'progress') console.log(`  [${String(ev.payload.percent).padStart(3)}%] ${ev.payload.message}`);
    if (ev.type === 'log' && !/Downloading|Download completed|Checksum/.test(ev.payload.line)) {
      console.log(`  | ${ev.payload.line}`);
    }
  });

  const meta = manager.createInstance({
    name: `inspect ${PROVIDER}`, provider: PROVIDER, mcVersion: MC, memoryMB: 2048,
    port: 25699, rconPort: 25699 + 10, acceptEula: true
  });
  const installed = await manager.installInstance(meta.id);
  const p = instances.instancePaths(meta.id);

  console.log('\n--- install result ---');
  console.log(JSON.stringify({
    installed: installed.installed,
    installState: installed.installState,
    java: `${installed.javaFeature} ${installed.javaKind}`,
    launch: installed.launch,
    artifact: installed.artifact
  }, null, 2));

  console.log('\n--- server/ ---');
  console.log(listing(p.server).join('\n'));

  console.log('\n--- manifest.json ---');
  console.log(fs.readFileSync(p.manifest, 'utf8'));

  for (const f of ['user_jvm_args.txt', 'run.bat', 'run.sh']) {
    const file = path.join(p.server, f);
    console.log(`\n--- ${f} ---`);
    if (!fs.existsSync(file)) { console.log('(not present)'); continue; }
    const text = fs.readFileSync(file, 'utf8');
    console.log(text.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n'));
  }

  // what would the supervisor actually run?
  const { ProcessSupervisor } = require('../src/main/servers/supervisor');
  const javaruntime = require('../src/main/java/runtime');
  const sup = new ProcessSupervisor({
    meta: instances.read(meta.id),
    serverDir: p.server,
    logFile: p.latestLog,
    javaPath: javaruntime.javaBinary(installed.javaFeature, installed.javaKind),
    launch: installed.launch
  });
  try {
    const cmd = sup._buildCommand();
    console.log('\n--- launch command the supervisor would use ---');
    console.log(`  ${cmd.cmd} ${cmd.args.join(' ')}`);
  } catch (err) {
    console.log(`\n--- launch command FAILED: ${err.message}`);
  }

  console.log(`\ninstance kept at ${p.dir}`);
  manager.stopPolling();
  process.exit(0);
}

main().catch((err) => { console.error('CRASH:', err); process.exit(2); });
