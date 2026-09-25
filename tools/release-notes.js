#!/usr/bin/env node
'use strict';
/**
 * Prints the release notes for a version: the matching CHANGELOG.md section plus
 * a download table. The CI release job pipes this into `gh release create
 * --notes-file`, so a release body is never written or edited by hand and cannot
 * drift from the changelog.
 *
 *   node tools/release-notes.js              # version from package.json
 *   node tools/release-notes.js v0.2.5       # explicit tag
 *   npm run notes > RELEASE_NOTES.md
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(process.argv[2] || pkg.version).replace(/^v/, '');

const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
let section = '';
if (start !== -1) {
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end === -1) end = lines.length;
  // the heading is dropped: the release title already carries the version
  section = lines.slice(start, end).join('\n').replace(/^##\s*\[[^\]]+\][^\n]*\n?/, '').trim();
} else {
  console.error(`warning: CHANGELOG.md has no "## [${version}]" section — ` +
    'the release notes fall back to a placeholder. Add the entry and re-run.');
}

const files = [
  ['Windows 64-bit', `MCServerSmith-${version}-win-x64.exe`],
  ['Windows ARM64', `MCServerSmith-${version}-win-arm64.exe`],
  ['Windows (either)', `MCServerSmith-${version}-win.exe`],
  ['Linux x86_64 (portable)', `MCServerSmith-${version}-linux-x86_64.AppImage`],
  ['Linux ARM64 (portable)', `MCServerSmith-${version}-linux-arm64.AppImage`],
  ['Debian/Ubuntu', `MCServerSmith-${version}-linux-amd64.deb`]
];

const out = [
  section || `Release ${version}. See [CHANGELOG.md](https://github.com/lelewithheart/mcserversmith/blob/master/CHANGELOG.md) for what changed.`,
  '',
  '## Downloads',
  '',
  '| Platform | File |',
  '|---|---|'
];
for (const [label, file] of files) out.push(`| ${label} | \`${file}\` |`);
out.push(
  '',
  '```',
  `chmod +x MCServerSmith-${version}-linux-x86_64.AppImage && ./MCServerSmith-${version}-linux-x86_64.AppImage`,
  `sudo apt install ./MCServerSmith-${version}-linux-amd64.deb`,
  `sha256sum -c MCServerSmith-${version}-linux-x86_64.AppImage.sha256`,
  '```',
  '',
  'Every file has a `.sha256` next to it.',
  '',
  '## Notes',
  '- Windows installers are unsigned, so SmartScreen warns on first run ("More info" -> "Run anyway").',
  '- The Linux builds come from CI on ubuntu-latest and are not started on a Linux machine — please report anything that breaks.',
  '',
  'Full history: https://github.com/lelewithheart/mcserversmith/blob/master/CHANGELOG.md'
);

console.log(out.join('\n'));
