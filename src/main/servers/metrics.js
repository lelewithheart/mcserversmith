'use strict';
/**
 * Process metrics without native dependencies.
 *  linux   -> /proc/<pid>/stat + statm
 *  darwin  -> ps -o rss=,%cpu=
 *  windows -> powershell Get-Process (WorkingSet64, TotalProcessorTime)
 */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) is 100 on every mainstream Linux
const PAGE_SIZE = 4096;

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout));
    });
  });
}

class MetricsSampler {
  constructor(pid) {
    this.pid = pid;
    this.prev = null;   // { cpuMillis, at }
  }

  async sample() {
    const now = Date.now();
    let raw = null;
    if (process.platform === 'linux') raw = await this._linux();
    else if (process.platform === 'darwin') raw = await this._darwin();
    else raw = await this._win();

    if (!raw) return { rssBytes: null, cpuPercent: null, cpuMillis: null };

    let cpuPercent = null;
    if (raw.cpuMillis != null && this.prev) {
      const dt = Math.max(1, now - this.prev.at);
      const dCpu = Math.max(0, raw.cpuMillis - this.prev.cpuMillis);
      cpuPercent = Math.round((dCpu / dt) * 100 * 10) / 10;
    }
    if (raw.cpuMillis != null) this.prev = { cpuMillis: raw.cpuMillis, at: now };

    return { rssBytes: raw.rssBytes, cpuPercent, cpuMillis: raw.cpuMillis };
  }

  async _linux() {
    try {
      const stat = fs.readFileSync(`/proc/${this.pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      // after comm: state(0) ppid(1) ... utime(11) stime(12) ... rss(21)
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      const statm = fs.readFileSync(`/proc/${this.pid}/statm`, 'utf8').split(' ');
      const resident = Number(statm[1]);
      return {
        rssBytes: resident * PAGE_SIZE,
        cpuMillis: ((utime + stime) / CLK_TCK) * 1000
      };
    } catch {
      return null;
    }
  }

  async _darwin() {
    const out = await run('ps', ['-o', 'rss=,%cpu=', '-p', String(this.pid)]);
    if (!out) return null;
    const [rss, cpu] = out.trim().split(/\s+/);
    return { rssBytes: Number(rss) * 1024, cpuMillis: null, cpuPercentDirect: Number(cpu) };
  }

  async _win() {
    const ps = await run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${this.pid} -ErrorAction SilentlyContinue; if ($p) { "$($p.WorkingSet64)|$([int]$p.TotalProcessorTime.TotalMilliseconds)" }`
    ], 6000);
    if (ps && ps.includes('|')) {
      const [ws, cpu] = ps.trim().split('|');
      return { rssBytes: Number(ws), cpuMillis: Number(cpu) };
    }
    // fallback: tasklist gives memory only
    const tl = await run('tasklist', ['/FI', `PID eq ${this.pid}`, '/FO', 'CSV', '/NH']);
    if (tl) {
      const m = tl.match(/"[^"]*","[^"]*","[^"]*","[^"]*","([\d.,]+) K"/);
      if (m) return { rssBytes: Number(m[1].replace(/[.,]/g, '')) * 1024, cpuMillis: null };
    }
    return null;
  }
}

function totalMemBytes() {
  return os.totalmem();
}

module.exports = { MetricsSampler, totalMemBytes };
