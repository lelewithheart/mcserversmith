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
    ok('update metadata is attached (latest.yml)', names.includes('latest.yml'), names.filter((n) => n.startsWith('latest')).join(', ') || 'none');
    ok('a Windows artifact is attached', names.some((n) => /\.exe$/.test(n)), names.filter((n) => /\.exe$/.test(n)).join(', '));
    ok('a Linux artifact is attached', names.some((n) => /\.AppImage$/.test(n)), names.filter((n) => /\.AppImage$/.test(n)).join(', '));
    ok('checksums are attached', names.some((n) => /\.sha256$/.test(n)));

    const feedVersion = String(release.tag_name || '').replace(/^v/, '');
    if (feedVersion === pkg.version) {
      ok('the newest release is this version', true, `v${feedVersion}`);
    } else {
      // not a failure: the release for a fresh tag only exists after the release job
      console.log(`  note the newest release is v${feedVersion}, package.json says ${pkg.version} (expected before the release job runs)`);
    }
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
