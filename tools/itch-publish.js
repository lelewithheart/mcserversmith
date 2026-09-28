#!/usr/bin/env node
'use strict';
/**
 * Upload the built artifacts to itch.io with butler.
 *
 *   npm run publish:itch                     # windows + linux channels
 *   npm run publish:itch -- --all            # + windows-arm64, + .deb
 *   npm run publish:itch -- --dry-run        # show the commands only
 *   npm run publish:itch -- --status         # what is on itch right now
 *   npm run publish:itch -- --target=user/game
 *
 * Where the target comes from (first hit wins):
 *   --target=user/game   |   MCSERVERSMITH_ITCH_TARGET=user/game   |   private/itch.json {"target": "user/game"}
 *
 * Auth: `butler login` once on this machine, or BUTLER_API_KEY (CI). The key is
 * never printed.
 *
 * Channels: one build per channel, and each push replaces that channel's build.
 * A user who installed through the itch app is updated by the itch client; a user
 * who downloaded the file updates through the app's own updater (GitHub feed).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

// ---------------------------------------------------------------- butler path
function findButler() {
  const candidates = [
    process.env.BUTLER_PATH,
    process.platform === 'win32' ? path.join(process.env.USERPROFILE || process.env.HOME || '', 'bin', 'butler.exe') : null,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'butler', 'butler.exe') : null,
    path.join(process.env.HOME || '', '.local', 'bin', 'butler'),
    '/usr/local/bin/butler',
    '/usr/bin/butler'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['butler'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function findTarget() {
  if (args.target && typeof args.target === 'string') return args.target;
  if (process.env.MCSERVERSMITH_ITCH_TARGET) return process.env.MCSERVERSMITH_ITCH_TARGET;
  const cfg = path.join(root, 'private', 'itch.json');
  if (fs.existsSync(cfg)) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (j && j.target) return j.target;
    } catch (err) {
      console.error(`private/itch.json exists but is not valid JSON: ${err.message}`);
    }
  }
  return null;
}

// ------------------------------------------------------------------- channels
/**
 * Resolve a channel to a real file in dist/.
 *
 * electron-builder is not consistent about the architecture token in artifact
 * names (`-win-x64.exe`, `-linux-x86_64.AppImage`, `-linux-amd64.deb`), so the
 * files are matched by pattern instead of assembled from a template.
 */
function channelFiles() {
  const files = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  const find = (re, notRe) => {
    const candidates = files.filter((f) => re.test(f) && !(notRe && notRe.test(f)));
    // prefer a build of the current version; older leftovers in dist/ are only a fallback
    const current = candidates.find((f) => f.includes(pkg.version));
    return { file: current || candidates[0] || null, stale: !!current ? false : candidates.length > 0 };
  };
  const win = find(/\.exe$/i, /arm64|blockmap/i);
  const lin = find(/\.AppImage$/i, /arm64|aarch64/i);
  const deb = find(/\.deb$/i, /arm64|aarch64/i);
  return [
    { name: 'windows', always: true, file: win.file, stale: win.stale },
    { name: 'linux', always: true, file: lin.file, stale: lin.stale },
    {
      name: 'windows-arm64',
      always: false,
      file: files.filter((f) => /\.exe$/i.test(f) && /arm64/i.test(f)).find((f) => f.includes(pkg.version))
        || files.find((f) => /\.exe$/i.test(f) && /arm64/i.test(f)) || null
    },
    { name: 'linux-deb', always: false, file: deb.file, stale: deb.stale }
  ].filter((c) => c.always || args.all);
}

function run(butler, argv, { quiet = false } = {}) {
  const res = spawnSync(butler, argv, { encoding: 'utf8', env: process.env });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (!quiet && out) console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
  return { code: res.status, out };
}

// ----------------------------------------------------------------------- main
function main() {
  const butler = findButler();
  const target = findTarget();
  const dry = !!args['dry-run'];

  console.log(`MCServerSmith ${pkg.version} → itch.io`);
  console.log(`  butler: ${butler || 'NOT FOUND'}`);
  console.log(`  target: ${target || 'NOT SET'}`);
  console.log(`  dist:   ${dist}`);

  if (args.status) {
    if (!butler) { console.error('\nbutler is not installed (see README → itch.io).'); process.exit(2); }
    if (!target) { console.error('\nNo itch target. Pass --target=user/game or create private/itch.json.'); process.exit(2); }
    console.log('\n### butler status');
    const st = run(butler, ['status', target]);
    process.exit(st.code === 0 ? 0 : 1);
  }

  const list = channelFiles();
  const present = list.filter((c) => c.file);
  const missing = list.filter((c) => !c.file);

  console.log('\n### channels');
  for (const c of present) console.log(`  push   ${c.name.padEnd(14)} ${c.file}${c.stale ? '   ⚠ not version ' + pkg.version : ''}`);
  for (const c of missing) console.log(`  skip   ${c.name.padEnd(14)} (no artifact in dist/)`);

  if (dry) {
    console.log('\n### dry run — nothing is uploaded');
    for (const c of present) {
      console.log(`  butler push dist/${c.file} ${target || '<target>'}:${c.name} --userversion ${pkg.version}`);
    }
    process.exit(0);
  }

  if (!butler) {
    console.error('\nbutler is not installed. Download it (one file, no installer):');
    console.error('  https://broth.itch.zone/butler/windows-amd64/LATEST/archive/default   (Windows)');
    console.error('  https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default     (Linux)');
    console.error('then put it on PATH, or set BUTLER_PATH.');
    process.exit(2);
  }
  if (!target) {
    console.error('\nNo itch target. Create the project page on itch.io first, then either');
    console.error('  pass --target=<username>/<project> , set MCSERVERSMITH_ITCH_TARGET, or write');
    console.error('  private/itch.json  →  { "target": "<username>/<project>" }');
    process.exit(2);
  }
  if (!present.length) {
    console.error(`\nNothing to push: no matching artifacts in ${dist}. Run "npm run dist:win" / "npm run dist:linux" first.`);
    process.exit(2);
  }

  console.log('\n### upload');
  let failed = 0;
  for (const c of present) {
    console.log(`  → ${target}:${c.name}`);
    const res = run(butler, ['push', path.join('dist', c.file), `${target}:${c.name}`, '--userversion', pkg.version]);
    if (res.code !== 0) {
      failed += 1;
      if (/401|403|invalid api key|unauthorized/i.test(res.out)) {
        console.error('    …butler is not authenticated. Run `butler login` once, or set BUTLER_API_KEY.');
      }
    }
  }

  console.log('\n### butler status');
  run(butler, ['status', target]);

  if (failed) {
    console.error(`\n${failed} of ${present.length} channels failed.`);
    process.exit(1);
  }
  console.log(`\n${present.length} channel(s) uploaded as version ${pkg.version}.`);
  process.exit(0);
}

main();
