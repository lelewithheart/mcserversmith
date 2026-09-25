#!/usr/bin/env node
'use strict';
/**
 * Runs the in-app UI smoke test.
 *   npm run test:ui
 *
 * It spawns the real Electron binary (resolved from the electron npm package,
 * NOT the node_modules/.bin shim — on Windows/MSYS that shim detaches, so the
 * child keeps running and the exit code/output are lost), waits for the
 * renderer to report, and forwards everything to stdout.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// `require('electron')` returns the path to the platform binary
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
const dataDir = process.env.MCSERVERSMITH_DATA || path.join(root, '.devdata-ui');

const env = {
  ...process.env,
  MCSERVERSMITH_SMOKE: '1',
  MCSERVERSMITH_DATA: dataDir,
  MCSERVERSMITH_SMOKE_DELAY: process.env.MCSERVERSMITH_SMOKE_DELAY || '6000'
};

console.log(`running UI smoke test with ${electronPath}`);
console.log(`data dir: ${dataDir}\n`);

const child = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`failed to launch electron: ${err.message}`);
  process.exit(2);
});

child.on('close', (code) => {
  if (code !== 0 && process.platform === 'win32') {
    console.error('\n(If the UI checks passed but the exit code is odd, check for leftover electron.exe processes.)');
  }
  process.exit(code === null ? 1 : code);
});

// be polite about Ctrl+C
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(); } catch { /* ignore */ } });
}
