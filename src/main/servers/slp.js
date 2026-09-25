'use strict';
/** Minecraft Server List Ping (status protocol) — no server config needed. */
const net = require('net');

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let value = 0;
  let size = 0;
  let b;
  do {
    if (offset + size >= buf.length || size > 5) throw new Error('varint overrun');
    b = buf[offset + size];
    value |= (b & 0x7f) << (7 * size);
    size += 1;
  } while (b & 0x80);
  return { value: value >>> 0, size };
}

function writeString(str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

function packet(payload) {
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

/** Flatten a chat component (string or object tree) into plain text. */
function flattenChat(node, depth = 0) {
  if (node == null || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => flattenChat(n, depth + 1)).join('');
  if (typeof node === 'object') {
    let out = node.text != null ? String(node.text) : '';
    if (node.translate) out += String(node.translate);
    if (Array.isArray(node.with)) out += node.with.map((n) => flattenChat(n, depth + 1)).join('');
    if (Array.isArray(node.extra)) out += node.extra.map((n) => flattenChat(n, depth + 1)).join('');
    return out;
  }
  return '';
}

/**
 * @returns {Promise<{online:boolean, latency:number, players?:{online:number,max:number,sample:string[]}, version?:string, protocol?:number, motd?:string, favicon?:string|null, error?:string}>}
 */
function ping(host = '127.0.0.1', port = 25565, { timeout = 5000, protocolVersion = 767 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(payload);
    };

    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let stage = 'handshake';
    let sentPingAt = 0;

    socket.setTimeout(timeout, () => {
      done({ online: false, latency: Date.now() - started, error: `timeout after ${timeout}ms` });
    });
    socket.on('error', (err) => {
      done({ online: false, latency: Date.now() - started, error: err.code || err.message });
    });
    socket.on('close', () => {
      done({ online: false, latency: Date.now() - started, error: 'connection closed' });
    });

    socket.on('connect', () => {
      const handshakeBody = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(protocolVersion),
        writeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1)
      ]);
      socket.write(packet(handshakeBody));
      socket.write(packet(writeVarInt(0x00)));   // status request
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'handshake') {
        try {
          const len = readVarInt(buffer, 0);
          if (buffer.length < len.size + len.value) return;
          const body = buffer.subarray(len.size, len.size + len.value);
          const id = readVarInt(body, 0);
          if (id.value !== 0x00) throw new Error('unexpected packet id');
          const strLen = readVarInt(body, id.size);
          const jsonStr = body.toString('utf8', id.size + strLen.size, id.size + strLen.size + strLen.value);
          const json = JSON.parse(jsonStr);
          stage = 'ping';
          buffer = buffer.subarray(len.size + len.value);

          const players = json.players || {};
          const sample = Array.isArray(players.sample)
            ? players.sample.map((s) => String((s && s.name) || '').replace(/^§.|§./g, '').trim()).filter(Boolean)
            : [];

          // send ping for RTT measurement, but answer already usable
          const pingPayload = Buffer.concat([writeVarInt(0x01), (() => {
            const b = Buffer.alloc(8);
            b.writeBigInt64BE(BigInt(Date.now()));
            return b;
          })()]);
          sentPingAt = Date.now();
          socket.write(packet(pingPayload));
          socket.__status = {
            online: true,
            latency: Date.now() - started,
            players: {
              online: Number(players.online || 0),
              max: Number(players.max || 0),
              sample
            },
            version: (json.version && json.version.name) || null,
            protocol: (json.version && json.version.protocol) || null,
            motd: flattenChat(json.description).replace(/§./g, '').trim() || null,
            favicon: json.favicon || null
          };
        } catch (err) {
          done({ online: false, latency: Date.now() - started, error: `bad status response: ${err.message}` });
        }
      } else if (stage === 'ping') {
        const status = socket.__status || { online: true, latency: Date.now() - started };
        status.latency = Date.now() - (sentPingAt || started);
        done(status);
      }
    });
  });
}

module.exports = { ping, flattenChat, writeVarInt, readVarInt };
