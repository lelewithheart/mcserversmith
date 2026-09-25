'use strict';
/** Turn raw server stdout lines into structured events for the dashboard. */

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(line) {
  return String(line).replace(ANSI, '');
}

const PATTERNS = [
  { type: 'ready', re: /Done \(([\d.]+)s\)! For help, type "help"/i, data: (m) => ({ seconds: Number(m[1]) }) },
  { type: 'starting', re: /Starting minecraft server version\s+(\S+)/i, data: (m) => ({ version: m[1] }) },
  { type: 'join', re: /\]:\s*([A-Za-z0-9_]{1,16})\s+joined the game/i, data: (m) => ({ player: m[1] }) },
  { type: 'leave', re: /\]:\s*([A-Za-z0-9_]{1,16})\s+lost connection: (.*)$/i, data: (m) => ({ player: m[1], reason: m[2] }) },
  { type: 'leave', re: /\]:\s*([A-Za-z0-9_]{1,16})\s+left the game/i, data: (m) => ({ player: m[1] }) },
  { type: 'worldgen', re: /Preparing (start region|spawn area)/i, data: () => ({}) },
  { type: 'stopping', re: /Stopping (the )?server/i, data: () => ({}) },
  { type: 'eula', re: /You need to agree to the EULA|eula\.txt/i, data: () => ({}) },
  { type: 'javaTooOld', re: /UnsupportedClassVersionError|Unsupported class file major version|no longer supported|requires Java (\d+)/i, data: (m) => ({ hint: m[0] }) },
  { type: 'portInUse', re: /Address already in use|FAILED TO BIND TO PORT|Perhaps a server is already running/i, data: () => ({}) },
  { type: 'tps', re: /TPS from last 1m, 5m, 15m:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i, data: (m) => ({ tps: [Number(m[1]), Number(m[2]), Number(m[3])] }) },
  { type: 'saveStarted', re: /Saving the game|Saving worlds/i, data: () => ({}) },
  { type: 'saveDone', re: /Saved the game|Saved the world/i, data: () => ({}) },
  { type: 'backupWarn', re: /Server is still saving|worlds are being saved/i, data: () => ({}) }
];

function levelOf(line) {
  if (/\/(ERROR|FATAL)\]/.test(line) || /Exception in thread|Caused by:/i.test(line)) return 'error';
  if (/\/WARN\]/.test(line) || /WARNING:/i.test(line)) return 'warn';
  if (/\/(INFO)\]/.test(line)) return 'info';
  if (/^\[.*?\/(DEBUG)\]/.test(line)) return 'debug';
  return 'plain';
}

/**
 * @returns {{ line:string, level:string, event:{type:string, data:object}|null }}
 */
function analyze(rawLine) {
  const line = stripAnsi(String(rawLine).replace(/\r$/, ''));
  if (!line.trim()) return null;

  let event = null;
  for (const p of PATTERNS) {
    const m = line.match(p.re);
    if (m) {
      event = { type: p.type, data: p.data(m) };
      break;
    }
  }
  return { line, level: levelOf(line), event };
}

/** Multi-line chunk ("data" can split lines any way) -> array of analyses. */
function makeLineSplitter() {
  let carry = '';
  return (chunk) => {
    carry += chunk.toString('utf8');
    const parts = carry.split(/\r?\n/);
    carry = parts.pop();
    return parts.map(analyze).filter(Boolean);
  };
}

module.exports = { analyze, makeLineSplitter, stripAnsi };
