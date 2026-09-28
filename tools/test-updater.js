#!/usr/bin/env node
'use strict';
/**
 * Runs the self-update test inside Electron, against the REAL release feed.
 *
 *   npm run test:updater            # two passes: faked old version + real version
 *   npm run test:updater -- --fake=0.0.5
 *
 * Pass 1 pretends the app is on an old version so the "update available" branch,
 * the artifact names and the download start are exercised for real. Pass 2 uses the
 * real version and only asserts that the feed answers and the state settles.
 *
 * Same launch rules as tools/run-ui-test.js: the electron binary comes from the
 * electron package (the .bin shim detaches under MSYS), and the run gets its own
 * --user-data-dir so a running MCServerSmith cannot steal the single-instance lock.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

let electronPath;
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  electronPath = require('electron');
} catch {
  console.error('electron is not installed — run: npm install');
  process.exit(2);
}
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.error(`could not resolve the electron binary (got: ${electronPath})`);
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const dataDir = process.env.MCSERVERSMITH_DATA || path.join(root, '.devdata-updater');

function pass(label, extraEnv) {
  return new Promise((resolve) => {
    console.log(`\n### ${label}`);
    const env = {
      ...process.env,
      MCSERVERSMITH_TEST_UPDATER: '1',
      // an unpackaged run is not allowed to update itself; this flag is what makes
      // the real check path reachable without installing the app
      MCSERVERSMITH_UPDATE_DEV: '1',
      MCSERVERSMITH_DATA: dataDir,
      ...extraEnv
    };
    const child = spawn(electronPath, ['.', `--user-data-dir=${path.join(dataDir, 'userdata')}`], {
      cwd: root, env, stdio: 'inherit'
    });
    const killer = setTimeout(() => {
      console.error('updater test did not finish within 120s — killing it');
      try { child.kill(); } catch { /* ignore */ }
      setTimeout(() => resolve(3), 800);
    }, 120000);
    killer.unref?.();
    child.on('error', (err) => { clearTimeout(killer); console.error(`failed to launch electron: ${err.message}`); resolve(2); });
    child.on('close', (code) => { clearTimeout(killer); resolve(code === null ? 1 : code); });
  });
}

(async () => {
  const fake = args.fake || '0.0.1';
  const codes = [];
  codes.push(await pass(`faked old version (${fake}) — "update available" path`, { MCSERVERSMITH_FAKE_VERSION: String(fake) }));
  codes.push(await pass('real version — feed answers, state settles', {}));
  const failed = codes.filter((c) => c !== 0);
  console.log(`\npasses: ${codes.join(', ')} ${failed.length ? '— FAILED' : '— all green'}`);
  process.exit(failed.length ? 1 : 0);
})();
