#!/usr/bin/env node
'use strict';
/**
 * i18n coverage check: every key used by the renderer must exist in every locale.
 *   node tools/check-i18n.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const localesDir = path.join(root, 'src', 'renderer', 'locales');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

const used = new Set();
// t('key') / t("key") / t(`key`)
for (const m of appJs.matchAll(/\bt\(\s*['"`]([a-zA-Z][\w.]*)['"`]/g)) used.add(m[1]);

// dynamic keys built at runtime
for (const id of ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge', 'spigot', 'velocity']) used.add(`type.${id}.desc`);
for (const s of ['offline', 'starting', 'online', 'stopping', 'crashed']) used.add(`state.${s}`);
for (const x of ['none', 'frp', 'playit', 'custom']) used.add(`tunnel.${x}`);
for (let i = 1; i <= 4; i += 1) used.add(`wizard.step${i}`);
for (const f of ['cloud', 'tunnel']) { used.add(`upsell.${f}.headline`); used.add(`upsell.${f}.body`); }
for (let i = 1; i <= 3; i += 1) used.add(`license.free.${i}`);
for (let i = 1; i <= 5; i += 1) used.add(`license.pro.${i}`);

const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
let problems = 0;

console.log(`keys used by the renderer: ${used.size}\n`);

for (const file of files) {
  const code = file.replace(/\.json$/, '');
  const dict = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
  const entries = Object.keys(dict).filter((k) => k !== '_meta');
  const missing = [...used].filter((k) => !(k in dict));
  const extra = entries.filter((k) => !used.has(k));
  const empty = entries.filter((k) => typeof dict[k] === 'string' && !dict[k].trim());
  const untranslated = entries.filter((k) => {
    const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    return code !== 'en' && dict[k] === en[k] && typeof dict[k] === 'string' && dict[k].length > 12;
  });

  console.log(`${code.padEnd(4)} ${String(entries.length).padStart(4)} keys | missing ${missing.length} | extra ${extra.length} | empty ${empty.length} | identical-to-en ${untranslated.length}`);
  if (missing.length) { console.log(`     missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`); problems += missing.length; }
  if (empty.length) { console.log(`     empty: ${empty.slice(0, 20).join(', ')}`); problems += empty.length; }
  if (untranslated.length) console.log(`     still English: ${untranslated.slice(0, 8).join(', ')}${untranslated.length > 8 ? ' …' : ''}`);
  if (extra.length) console.log(`     unused keys (harmless): ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`);
}

console.log(`\n${problems === 0 ? 'OK — no missing or empty strings' : `${problems} problem(s) found`}`);
process.exit(problems ? 1 : 0);
