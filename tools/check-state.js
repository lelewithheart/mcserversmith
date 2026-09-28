#!/usr/bin/env node
'use strict';
/**
 * State-cache check: every `state.<key>` the renderer touches must exist in the
 * `state` literal.
 *   node tools/check-state.js
 *
 * Why: `state.props` was used (and written to) while the literal never declared
 * it, so `state.props[id] = ...` threw "Cannot set properties of undefined" —
 * inside a try/catch, so the Server → settings tab just rendered blank fields
 * and saving silently failed. The readers all used the `state.x && state.x[id]`
 * guard, which is exactly why nobody noticed. A missing key is always a bug, so
 * this check is exact rather than heuristic.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rel = process.argv[2] || path.join('src', 'renderer', 'app.js');
const appJsPath = path.isAbsolute(rel) ? rel : path.join(root, rel);
const src = fs.readFileSync(appJsPath, 'utf8');

const literal = src.match(/const state = \{[\s\S]*?\n\};/);
if (!literal) {
  console.error('could not find the `const state = { ... }` literal in src/renderer/app.js');
  process.exit(2);
}

const declared = [];
for (const m of literal[0].matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)) declared.push(m[1]);
const known = new Set(declared);

/** line number of a character offset */
const lineAt = (idx) => src.slice(0, idx).split('\n').length;

const problems = [];
const seen = new Set();
const pattern = /(?<![\w$])state\.([A-Za-z_$][\w$]*)/g;
for (const m of src.matchAll(pattern)) {
  const key = m[1];
  if (src[m.index + m[0].length] === '{') continue; // `state.${expr}` template key
  if (known.has(key)) continue;
  const line = lineAt(m.index);
  const lineText = src.split('\n')[line - 1].trim();
  const id = `${key}:${line}`;
  if (seen.has(id)) continue;
  seen.add(id);
  // a write into a container is the crash this check exists for
  const assigning = new RegExp(`state\\.${key}\\s*\\[`).test(lineText) && /\]\s*=/.test(lineText);
  problems.push({ key, line, assigning, text: lineText.slice(0, 120) });
}

console.log(`state keys declared: ${declared.length}`);
console.log(`renderer file:       src/renderer/app.js\n`);

if (!problems.length) {
  console.log('OK — every state.<key> access has a matching entry in the state literal.');
  process.exit(0);
}

console.log(`undocumented state accesses: ${problems.length}\n`);
for (const p of problems) {
  console.log(`${p.assigning ? 'WRITE' : 'read '}  ${path.relative(root, appJsPath)}:${p.line}  state.${p.key}`);
  console.log(`        ${p.text}`);
}
console.log('\nAdd the key to the `const state = { ... }` literal (an empty {} / [] / null is enough).');
process.exit(1);
