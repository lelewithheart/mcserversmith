#!/usr/bin/env node
'use strict';
/**
 * Watch the GitHub Actions run for a tag (or the newest run) until it finishes.
 *   node tools/ci-watch.js                # newest run
 *   node tools/ci-watch.js v1.0.0         # the run for that tag
 *   node tools/ci-watch.js v1.0.0 --once  # one status line, no polling
 *
 * Uses the public API (no token needed for a public repo), so it also works while
 * a release is in flight. Exit code 0 = success, 1 = failure/cancelled.
 */
const { fetchJSON } = require('../src/main/core/http');

const arg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const once = process.argv.includes('--once');
const REPO = 'lelewithheart/mcserversmith';
const API = `https://api.github.com/repos/${REPO}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runs() {
  const data = await fetchJSON(`${API}/actions/runs?per_page=10`);
  return (data.workflow_runs || []);
}

function pick(list) {
  if (!arg) return list[0];
  return list.find((r) => r.head_branch === arg || String(r.head_branch || '').includes(arg))
    || list.find((r) => String(r.name || '').includes(arg))
    || null;
}

function line(run) {
  const when = run.created_at ? new Date(run.created_at).toISOString().slice(11, 19) : '';
  return `${when}  ${run.head_branch || run.display_title}  ${run.status}${run.conclusion ? ' / ' + run.conclusion : ''}  ${run.html_url}`;
}

async function main() {
  let seen = null;
  for (let i = 0; i < 90; i += 1) {
    const list = await runs().catch((err) => { console.error(`api error: ${err.message}`); return []; });
    const run = pick(list);
    if (!run) {
      if (once) { console.error('no workflow run found'); process.exit(2); }
      await sleep(15000);
      continue;
    }
    if (run.id !== (seen && seen.id)) { console.log(line(run)); seen = run; } else if (run.status !== 'completed') { process.stdout.write('.'); }
    if (run.status === 'completed') {
      console.log(`\n${line(run)}`);
      try {
        const jobs = await fetchJSON(`${API}/actions/runs/${run.id}/jobs`);
        for (const j of jobs.jobs || []) {
          console.log(`  ${(j.conclusion || j.status).padEnd(10)} ${j.name}`);
          for (const s of j.steps || []) {
            if (s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped') {
              console.log(`      ↳ ${s.conclusion}: ${s.name}`);
            }
          }
        }
      } catch { /* job list is a bonus */ }
      process.exit(run.conclusion === 'success' ? 0 : 1);
    }
    if (once) process.exit(0);
    await sleep(20000);
  }
  console.error('gave up waiting');
  process.exit(3);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
