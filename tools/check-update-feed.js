#!/usr/bin/env node
'use strict';
/**
 * Update-feed contract check — no Electron, safe for CI.
 *   node tools/check-update-feed.js
 *
 * The deep test (npm run test:updater) drives a real Electron app against the
 * feed; this one answers the cheaper question the release job depends on:
 * "does the newest GitHub release actually carry what electron-updater needs",
 * plus the version-comparison maths, in a second and without a display.
 */
const pkg = require('../package.json');
const updater = require('../src/main/core/updater');
const { fetchJSON } = require('../src/main/core/http');

const failures = [];
let passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const REPO = 'https://api.github.com/repos/lelewithheart/mcserversmith';

async function main() {
  console.log('\n=== version comparison (offline) ===');
  ok('patch bump is newer', updater.isNewer('1.0.1', '1.0.0'));
  ok('minor bump is newer', updater.isNewer('1.1.0', '1.0.99'));
  ok('major bump is newer', updater.isNewer('2.0.0', '1.99.99'));
  ok('v-prefix ignored', updater.isNewer('v1.2.0', '1.1.0'));
  ok('different segment counts', updater.isNewer('1.0.0.1', '1.0.0'));
  ok('equal is not newer', !updater.isNewer('1.0.0', '1.0.0') && !updater.isNewer('v1.0.0', '1.0.0'));
  ok('older is not newer', !updater.isNewer('0.9.9', '1.0.0'));
  ok('nothing offered is not newer', !updater.isNewer(null, '1.0.0') && !updater.isNewer('', '1.0.0'));

  console.log('\n=== channel policy (offline) ===');
  ok('a normal install may update itself', updater.disabledReason('C:/Program Files/MCServerSmith/MCServerSmith.exe') === null);
  ok('an itch-installed copy does not', updater.disabledReason('C:/Users/x/AppData/Roaming/itch/apps/mcserversmith/MCServerSmith.exe') === 'itch');
  ok('a store build does not', (() => {
    process.env.MCSERVERSMITH_STORE = '1';
    const r = updater.disabledReason('C:/Program Files/WindowsApps/MCServerSmith.exe');
    delete process.env.MCSERVERSMITH_STORE;
    return r === 'store';
  })());

  console.log('\n=== update feeds per platform (offline) ===');
  ok('Windows x64 reads latest.yml (no channel override)', updater.feedChannel('win32', 'x64') === null);
  ok('Windows on ARM reads win-arm64.yml', updater.feedChannel('win32', 'arm64') === 'win-arm64');
  ok('Linux lets electron-updater pick latest-linux*.yml', updater.feedChannel('linux', 'x64') === null && updater.feedChannel('linux', 'arm64') === null);
  ok('macOS uses the default feed', updater.feedChannel('darwin', 'arm64') === null);

  console.log('\n=== the release feed (live) ===');
  let release = null;
  try {
    release = await fetchJSON(`${REPO}/releases/latest`);
  } catch (err) {
    ok('the release feed answers', false, err.message.slice(0, 160));
  }
  if (release) {
    ok('the feed answers', true, `${release.tag_name} (${release.assets ? release.assets.length : 0} assets)`);
    const names = (release.assets || []).map((a) => a.name);
    ok('the tag is a version', /^v?\d+\.\d+\.\d+/.test(String(release.tag_name || '')), release.tag_name);

    const feedVersion = String(release.tag_name || '').replace(/^v/, '');
    const isCurrent = feedVersion === pkg.version;
    if (!isCurrent) {
      // At tag time the feed still points at the previous release, so judging its
      // shape would fail for the wrong reason and block the release. The release
      // job runs this check again *after* publishing, when the versions match.
      console.log(`  note the newest release is v${feedVersion}, package.json says ${pkg.version}`);
      console.log('       its shape is therefore not judged here — the release job re-runs this after publishing');
    }
    const shape = (name, cond, detail) => {
      if (!isCurrent) { console.log(`  skip ${name}`); return; }
      ok(name, cond, detail);
    };

    shape('update metadata is attached (latest.yml)', names.includes('latest.yml'), names.filter((n) => n.startsWith('latest')).join(', ') || 'none');
    shape('a Windows artifact is attached', names.some((n) => /\.exe$/.test(n)), names.filter((n) => /\.exe$/.test(n)).join(', '));
    shape('a Linux artifact is attached', names.some((n) => /\.AppImage$/.test(n)), names.filter((n) => /\.AppImage$/.test(n)).join(', '));
    shape('checksums are attached', names.some((n) => /^SHA256SUMS/i.test(n) || /\.sha256$/.test(n)));

    // the two must travel together: an arm64 installer with no win-arm64.yml means
    // every Windows-on-ARM update asks for a feed that does not exist
    const hasArmExe = names.some((n) => /-win-arm64\.exe$/.test(n));
    if (hasArmExe) {
      shape('the arm64 installer has its own feed (win-arm64.yml)', names.includes('win-arm64.yml'), names.filter((n) => /arm/i.test(n)).join(', '));
    }
    // one installer per architecture: a combined multi-arch installer would dwarf
    // them and be the only file the updater ever uses
    shape('no combined multi-arch installer is attached',
      !names.some((n) => /-win\.exe$/.test(n) && !/-win-(x64|arm64)\.exe$/.test(n)),
      names.filter((n) => /-win\.exe$/.test(n)).join(', '));
    // a release page with 15 files is the thing this check exists to prevent
    shape('the release stays small enough to read', names.length <= 12, `${names.length} assets`);

    if (isCurrent) ok('the newest release is this version', true, `v${feedVersion}`);
  }

  console.log('');
  if (failures.length) {
    console.log(`${passed} checks passed, ${failures.length} FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`all ${passed} update-feed checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`check crashed: ${err.stack || err.message}`);
  process.exit(2);
});
