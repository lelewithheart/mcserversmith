'use strict';
/**
 * Minimal Minecraft RCON client (no dependencies).
 * Packet: int32 length | int32 id | int32 type | body\0\0
 * Types: 3=login, 2=command / login-response, 0=response
 */
const net = require('net');

class Rcon {
  constructor({ host = '127.0.0.1', port = 25575, password = '', timeout = 8000 }) {
    Object.assign(this, { host, port, password, timeout });
    this.socket = null;
    this.id = 0;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setTimeout(this.timeout, () => reject(new Error('rcon timeout')));
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => this._onData(chunk));
      this.socket.once('connect', async () => {
        try {
          const res = await this._send(3, this.password);
          if (res.id === -1) reject(new Error('rcon auth failed'));
          else resolve(true);
        } catch (err) { reject(err); }
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < len + 4) return;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.toString('utf8', 12, len + 2);
      this.buffer = this.buffer.subarray(len + 4);
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.resolve({ id, type, body });
      }
    }
  }

  _send(type, body) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const payload = Buffer.from(body, 'utf8');
      const buf = Buffer.alloc(payload.length + 14);
      buf.writeInt32LE(payload.length + 10, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      payload.copy(buf, 12);
      buf.writeInt16LE(0, payload.length + 12);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('rcon response timeout'));
      }, this.timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject
      });
      this.socket.write(buf);
    });
  }

  exec(command) {
    return this._send(2, command).then((r) => r.body);
  }

  close() {
    if (this.socket) { try { this.socket.destroy(); } catch { /* ignore */ } this.socket = null; }
  }
}

/** Parse the output of `list` -> { online, max, players[] } */
function parseListOutput(text) {
  const out = { online: null, max: null, players: [] };
  if (!text) return out;
  const m = text.match(/There are (\d+) of a max(?:imum)? of (\d+)/i);
  if (m) { out.online = Number(m[1]); out.max = Number(m[2]); }
  const colon = text.indexOf(':');
  if (colon >= 0) {
    const names = text.slice(colon + 1).trim();
    if (names) out.players = names.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/** Parse `/tps` output -> [1m, 5m, 15m] or null */
function parseTpsOutput(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** One-shot helper. */
async function exec(opts, command) {
  const c = new Rcon(opts);
  try {
    await c.connect();
    return await c.exec(command);
  } finally {
    c.close();
  }
}

module.exports = { Rcon, exec, parseListOutput, parseTpsOutput };
