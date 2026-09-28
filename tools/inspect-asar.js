#!/usr/bin/env node
'use strict';
/**
 * Look inside a packaged app.asar — the fastest way to answer "why does the
 * packaged build behave differently from the dev run?".
 *
 *   node tools/inspect-asar.js                        # dist/win-unpacked/resources/app.asar
 *   node tools/inspect-asar.js <path/to/app.asar> [--grep=<substr>]
 *
 * Prints the file count, the total size, and whether the things a packaged run
 * needs are actually in there: every runtime dependency from package.json, the
 * renderer files, the locales. A dependency listed in package.json but missing
 * from the asar is the classic "works in dev, crashes in the installer" bug.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const target = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const grepArg = process.argv.find((a) => a.startsWith('--grep='));
const grep = grepArg ? grepArg.split('=')[1] : null;

if (!fs.existsSync(target)) {
  console.error(`not found: ${target}`);
  process.exit(2);
}

/** asar = 16-byte pickle header + JSON directory + file payloads */
function readDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, rel, out);
    else out.push({ path: rel, size: entry.size || 0, unpacked: !!entry.unpacked });
  }
  return out;
}

const dir = readDirectory(target);
const files = walk(dir, '', []);
const total = files.reduce((a, f) => a + f.size, 0);
const stat = fs.statSync(target);

console.log(`archive: ${target}`);
console.log(`size on disk: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`entries: ${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB unpacked\n`);

// ---- runtime dependencies ---------------------------------------------------
const pkg = require(path.join(root, 'package.json'));
const deps = Object.keys(pkg.dependencies || {});
console.log(`### runtime dependencies (${deps.length})`);
for (const dep of deps) {
  const inside = files.filter((f) => f.path.startsWith(`node_modules/${dep}/`));
  const bytes = inside.reduce((a, f) => a + f.size, 0);
  console.log(`  ${inside.length ? 'OK  ' : 'MISS'} ${dep.padEnd(24)} ${inside.length} files, ${(bytes / 1024).toFixed(0)} KB`);
}

// ---- the files a packaged run needs ----------------------------------------
const wanted = [
  'package.json',
  'src/main/index.js',
  'src/main/core/updater.js',
  'src/preload.js',
  'src/renderer/index.html',
  'src/renderer/app.js',
  'src/renderer/styles.css',
  'src/renderer/locales/en.json',
  'src/renderer/locales/de.json',
  'resources/monetization.json'
];
console.log('\n### expected app files');
for (const w of wanted) console.log(`  ${files.some((f) => f.path === w) ? 'OK  ' : 'MISS'} ${w}`);

// ---- what leaked in that should not ----------------------------------------
const leaks = files.filter((f) => /^(tools|keys|private)\//.test(f.path) || /\.md$/.test(f.path) || /\.map$/.test(f.path));
console.log(`\n### leaks (${leaks.length})`);
for (const l of leaks.slice(0, 10)) console.log(`  ${l.path}`);
if (leaks.length > 10) console.log(`  … ${leaks.length - 10} more`);

// ---- biggest entries --------------------------------------------------------
console.log('\n### biggest files');
for (const f of [...files].sort((a, b) => b.size - a.size).slice(0, 8)) {
  console.log(`  ${(f.size / 1024).toFixed(0).padStart(6)} KB  ${f.path}`);
}

if (grep) {
  console.log(`\n### matching "${grep}"`);
  for (const f of files.filter((f) => f.path.includes(grep))) console.log(`  ${f.path}`);
}

// the app-update.yml sits NEXT to the asar, not inside it
const updateYml = path.join(path.dirname(target), 'app-update.yml');
console.log(`\n### app-update.yml (${fs.existsSync(updateYml) ? 'present' : 'MISSING'})`);
if (fs.existsSync(updateYml)) console.log(fs.readFileSync(updateYml, 'utf8').split('\n').map((l) => `  ${l}`).join('\n'));
