#!/usr/bin/env node
'use strict';
/**
 * Parses the YAML config files before you push them. A typo in a workflow file
 * costs you a whole CI round-trip; this costs a second.
 *   npm run check:yaml
 */
const fs = require('fs');
const path = require('path');

let yaml;
try {
  // eslint-disable-next-line global-require
  yaml = require('js-yaml');
} catch {
  console.error('js-yaml not found — run: npm install');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const files = [
  '.github/workflows/build.yml',
  'electron-builder.yml'
];

let failed = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.log(`SKIP  ${rel} (missing)`); continue; }
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    const keys = doc && typeof doc === 'object' ? Object.keys(doc).join(', ') : String(doc);
    console.log(`OK    ${rel}`);
    console.log(`      ${keys}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${rel}: ${err.message.split('\n')[0]}`);
  }
}

// a few checks that a bare parse cannot catch
try {
  const wf = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8'));
  const push = wf.on && wf.on.push;
  const hasPerm = !!(wf.permissions && wf.permissions.contents === 'write');
  const report = (name, ok, hint = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${hint && !ok ? ` — ${hint}` : ''}`);
  };
  report('workflow triggers on version tags', !!(push && push.tags && push.tags.includes('v*')));
  report('workflow may write releases (permissions.contents)', hasPerm,
    'without this electron-builder gets "403 Resource not accessible by integration"');
  const jobs = wf.jobs || {};
  report('build job waits for verify', !!(jobs.build && jobs.build.needs));
  report('build matrix is serialised (max-parallel)', !!(jobs.build && jobs.build.strategy && jobs.build.strategy['max-parallel'] === 1),
    'one slow matrix job at a time keeps the free runner budget predictable');
  const releaseJob = jobs.release || {};
  const releaseSteps = (releaseJob.steps || []).map((step) => String((step && step.run) || '')).join('\n');
  report('a release job attaches the binaries to the release',
    !!(releaseJob.needs && /gh release upload/.test(releaseSteps)),
    'without it CI only stores workflow artifacts and the GitHub release stays empty or Windows-only');
  report('the release job only runs for tags', typeof releaseJob.if === 'string' && releaseJob.if.includes('refs/tags/'));
  report('the release job refuses a run without every platform',
    /compgen -G/.test(releaseSteps),
    'a release missing .AppImage/.deb is exactly the bug this guards against');
  report('the release job downloads both platforms into one folder',
    /merge-multiple/.test(JSON.stringify(releaseJob.steps || [])));
  const matrixScripts = ((((jobs.build || {}).strategy || {}).matrix || {}).include || [])
    .map((entry) => String((entry && entry.script) || ''));
  report('build matrix appends no publish flag',
    matrixScripts.length > 0 && matrixScripts.every((s) => !s.includes('--publish')),
    'a second --publish never reaches electron-builder as ["never","never"]; it accepts that without a word and publishes anyway');
  report('build jobs carry no GH_TOKEN',
    !JSON.stringify((jobs.build || {}).steps || []).includes('GH_TOKEN'),
    'token + enabled publish policy is all electron-builder needs to create its own release');
  report('the release job runs exactly one upload',
    (releaseSteps.match(/gh release upload/g) || []).length === 1);
  const pkgForWorkflow = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const distScripts = ['dist', 'dist:win', 'dist:linux'].map((name) => String((pkgForWorkflow.scripts || {})[name] || ''));
  report('every npm dist script disables publishing once',
    distScripts.every((s) => (s.match(/--publish/g) || []).length === 1 && s.includes('--publish never')),
    'exactly one --publish never per script, and no "-- --publish" appended on the command line');
} catch (err) {
  failed += 1;
  console.log(`FAIL  workflow sanity checks: ${err.message.split('\n')[0]}`);
}

try {
  const eb = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const report = (name, ok, hint = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${hint && !ok ? ` — ${hint}` : ''}`);
  };
  report('publish provider is set', !!(eb.publish && eb.publish.provider), 'needed for app-update.yml');
  report('appId set', !!eb.appId);
  report('linux target includes AppImage', JSON.stringify(eb.linux && eb.linux.target || '').includes('AppImage'));
  report('windows target includes nsis', JSON.stringify(eb.win && eb.win.target || '').includes('nsis'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  report('package.json desktopName matches linux.syncDesktopName', !(eb.linux && eb.linux.syncDesktopName) || !!pkg.desktopName,
    'syncDesktopName without desktopName in package.json has no effect');
} catch (err) {
  failed += 1;
  console.log(`FAIL  electron-builder sanity checks: ${err.message.split('\n')[0]}`);
}

console.log(failed ? `\n${failed} problem(s) found` : '\nAll config files look good');
process.exit(failed ? 1 : 0);
