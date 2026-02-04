import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Tiny PNG encoder (RGBA, no interlace). Enough for simple icons.

function crc32(buf) {
  // CRC-32 (IEEE 802.3)
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      const m = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & m);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const d = Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
  return Buffer.concat([len, t, d, crc]);
}

function pngRGBA(width, height, rgba /* Uint8Array */) {
  // Prepend filter byte 0 for each row
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [5, 10, 18, 255];
  const ring = [16, 185, 129, 255];
  const inner = [5, 10, 18, 255];

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.48;
  const rInner = size * 0.34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let c = bg;
      if (d <= rOuter) c = ring;
      if (d <= rInner) c = inner;
      const i = (y * size + x) * 4;
      rgba[i + 0] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = c[3];
    }
  }
  return rgba;
}

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'packages/extension/static/icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const buf = pngRGBA(size, size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
}

console.log('Wrote icons to', outDir);
