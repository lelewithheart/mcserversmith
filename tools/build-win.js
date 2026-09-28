#!/usr/bin/env node
'use strict';
/**
 * Builds both Windows architectures as TWO separate electron-builder runs.
 *
 *   npm run dist:win          # arm64 first, then x64 (the default channel)
 *   npm run dist:win -- --x64 # only the x64 installer
 *   node tools/build-win.js --arm64
 *
 * Why not one run with `arch: [x64, arm64]`: electron-builder then also emits a
 * third, combined installer (216 MB instead of 111 MB) and that combined file is
 * the one its single `latest.yml` points at — so every self-update would pull
 * 216 MB and the two real installers would exist only for manual downloads.
 *
 * Two runs produce two installers and two feeds:
 *   latest.yml      -> MCServerSmith-<v>-win-x64.exe    (the default channel)
 *   win-arm64.yml   -> MCServerSmith-<v>-win-arm64.exe  (requested on Windows on ARM)
 * The app picks the feed by architecture (src/main/core/updater.js).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));

const args = process.argv.slice(2);
const only = args.includes('--x64') ? 'x64' : args.includes('--arm64') ? 'arm64' : null;
const arches = only ? [only] : ['arm64', 'x64'];   // arm64 first: the x64 run leaves latest.yml

const cli = require.resolve('electron-builder/out/cli/cli.js', { paths: [root] });

function run(arch) {
  console.log(`\n=== electron-builder --win --${arch} ===`);
  const res = spawnSync(process.execPath, [cli, '--win', `--${arch}`, '--publish', 'never'], {
    cwd: root, stdio: 'inherit', env: process.env
  });
  if (res.status !== 0) {
    console.error(`electron-builder failed for ${arch} (exit ${res.status})`);
    process.exit(res.status || 1);
  }
}

function exists(name) {
  return fs.existsSync(path.join(dist, name));
}

/** the artifact electron-builder just produced for this arch */
function artifactFor(arch) {
  const files = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  return files.find((f) => new RegExp(`-win-${arch}\\.exe$`).test(f) && f.includes(pkg.version)) || null;
}

console.log(`MCServerSmith ${pkg.version} — Windows build (${arches.join(' + ')})`);

for (const arch of arches) {
  run(arch);

  const artifact = artifactFor(arch);
  if (!artifact) {
    console.error(`no -win-${arch}.exe for version ${pkg.version} appeared in dist/`);
    process.exit(1);
  }
  console.log(`  ${arch}: ${artifact}`);

  const feed = path.join(dist, 'latest.yml');
  if (!exists('latest.yml')) {
    console.error(`electron-builder did not write dist/latest.yml for ${arch} — the app would have no update feed`);
    process.exit(1);
  }

  if (arch === 'arm64') {
    // keep the arm64 feed under the name the app asks for on Windows on ARM
    fs.copyFileSync(feed, path.join(dist, 'win-arm64.yml'));
    console.log('  feed: latest.yml -> win-arm64.yml (arm64 channel)');
  } else {
    console.log('  feed: latest.yml (x64 / default channel)');
  }
}

// A combined installer would mean the single feed points at 216 MB instead of the
// per-arch installers — the thing this script exists to avoid.
const combined = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((f) => new RegExp(`-win\\.exe$`).test(f) && f.includes(pkg.version))
  : [];
if (combined.length) {
  console.error(`unexpected combined installer(s): ${combined.join(', ')}`);
  console.error('the per-arch feeds would be unused — check the win target in electron-builder.yml');
  process.exit(1);
}

if (only !== 'arm64') {
  const feed = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  console.log(`\nlatest.yml points at: ${(feed.match(/^path: (.+)$/m) || [, '?'])[1]}`);
}
if (fs.existsSync(path.join(dist, 'win-arm64.yml'))) {
  const feed = fs.readFileSync(path.join(dist, 'win-arm64.yml'), 'utf8');
  console.log(`win-arm64.yml points at: ${(feed.match(/^path: (.+)$/m) || [, '?'])[1]}`);
}
console.log('\nWindows build done.');
