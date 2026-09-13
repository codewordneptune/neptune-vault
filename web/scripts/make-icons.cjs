// Placeholder app icons: a navy rounded square with a cyan ring, no text, so
// no font is needed. Written as PNG with Node's zlib only.
const fs = require('fs');
const zlib = require('zlib');
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, cy = size / 2, r = size * 0.32, w = size * 0.07, corner = size * 0.18;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(corner - x, 0, x - (size - 1 - corner)), dy = Math.max(corner - y, 0, y - (size - 1 - corner));
      const outside = dx * dx + dy * dy > corner * corner;
      const d = Math.hypot(x - cx, y - cy);
      let [R, G, B, A] = [11, 27, 43, 255];
      if (outside) A = 0;
      else if (Math.abs(d - r) < w / 2) [R, G, B] = [34, 211, 238];
      else if (d < r - w / 2 && Math.abs(x - cx) < w / 2 && y > cy - r * 0.55 && y < cy + r * 0.55) [R, G, B] = [34, 211, 238];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = A;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) fs.writeFileSync(`public/icons/icon-${s}.png`, png(s));
console.log('icons written');
