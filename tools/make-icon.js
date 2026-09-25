#!/usr/bin/env node
'use strict';
/**
 * Generates resources/icon.png (512x512) — a pixel-art pickaxe on a gradient
 * tile — using a tiny hand-rolled PNG encoder (zlib + CRC32, no dependencies).
 *
 *   node tools/make-icon.js
 *
 * electron-builder converts this single PNG into the platform icons.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const GRID = 16;           // 16x16 pixel-art grid scaled up
const CELL = SIZE / GRID;

// . = transparent, # = dark outline, s = steel, h = handle wood, l = light steel
const ART = [
  '................',
  '.....####.......',
  '...##ssss##.....',
  '..#sslllssss#...',
  '.#sslllllsss#...',
  '.#sl###llss#....',
  '..#s#hh##ss#....',
  '...##hhh#ss#....',
  '....#hhh#s#.....',
  '.....#hhh#......',
  '.....#hhh#......',
  '......#hh#......',
  '......#hh#......',
  '.......##.......',
  '................',
  '................'
];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

const COLORS = {
  '#': [12, 15, 22, 255],
  s: [140, 150, 170, 255],
  l: [225, 232, 245, 255],
  h: [150, 105, 60, 255]
};

// raw image: filter byte 0 + RGBA per row
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  const gy = Math.floor(y / CELL);
  for (let x = 0; x < SIZE; x += 1) {
    const gx = Math.floor(x / CELL);
    const ch = (ART[gy] || '')[gx] || '.';
    const off = rowStart + 1 + x * 4;
    if (ch === '.') { raw[off + 3] = 0; continue; }
    const col = COLORS[ch] || COLORS['#'];
    raw[off] = col[0]; raw[off + 1] = col[1]; raw[off + 2] = col[2]; raw[off + 3] = col[3];
  }
}

// gradient background behind the glyph
const bg = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  bg[rowStart] = 0;
  for (let x = 0; x < SIZE; x += 1) {
    const t = (x + y) / (SIZE * 2);
    const r = lerp(91, 160, t);
    const g = lerp(140, 107, t);
    const b = lerp(255, 255, t);
    // rounded corners
    const cx = Math.min(x, SIZE - 1 - x);
    const cy = Math.min(y, SIZE - 1 - y);
    const r16 = 96;
    let alpha = 255;
    if (cx < r16 && cy < r16) {
      const dx = r16 - cx;
      const dy = r16 - cy;
      if (Math.sqrt(dx * dx + dy * dy) > r16) alpha = 0;
    }
    const off = rowStart + 1 + x * 4;
    bg[off] = r; bg[off + 1] = g; bg[off + 2] = b; bg[off + 3] = alpha;
  }
}

// composite glyph over background
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const off = y * (SIZE * 4 + 1) + 1 + x * 4;
    const a = raw[off + 3] / 255;
    if (a === 0) continue;
    bg[off] = Math.round(raw[off] * a + bg[off] * (1 - a));
    bg[off + 1] = Math.round(raw[off + 1] * a + bg[off + 1] * (1 - a));
    bg[off + 2] = Math.round(raw[off + 2] * a + bg[off + 2] * (1 - a));
    bg[off + 3] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(bg, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.resolve(__dirname, '..', 'resources', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
