// Generates simple placeholder icon PNGs (16, 48, 128) into src/icons/.
// Draws a filled rounded square with a small record dot using the Canvas-free
// trick: build a raw RGBA buffer and encode with minimal PNG via pngjs-lite
// wouldn't be worth the dep — we write a tiny deflate+CRC encoder inline.
//
// Simpler path: write an uncompressed-RGBA PNG using the standard chunk layout.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  const table = (crc32._t ??= (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const td = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rowBytes = size * 4;
  const filtered = Buffer.alloc(size * (rowBytes + 1));
  for (let y = 0; y < size; y++) {
    filtered[y * (rowBytes + 1)] = 0;
    pixels.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(filtered);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [0x0b, 0x0b, 0x0b, 0xff];
  const dot = [0xdc, 0x26, 0x26, 0xff];
  const radius = Math.floor(size * 0.18);
  const cx = size / 2, cy = size / 2;
  const dotR = Math.max(2, Math.floor(size * 0.28));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded square background
      const inX = (x >= 0 && x < size);
      const inY = (y >= 0 && y < size);
      const cornerDist = (xx, yy) => Math.hypot(x - xx, y - yy);
      let bgOn = inX && inY;
      if (x < radius && y < radius && cornerDist(radius, radius) > radius) bgOn = false;
      if (x >= size - radius && y < radius && cornerDist(size - radius - 1, radius) > radius) bgOn = false;
      if (x < radius && y >= size - radius && cornerDist(radius, size - radius - 1) > radius) bgOn = false;
      if (x >= size - radius && y >= size - radius && cornerDist(size - radius - 1, size - radius - 1) > radius) bgOn = false;
      const c = bgOn ? bg : [0, 0, 0, 0];
      const dist = Math.hypot(x - cx, y - cy);
      const use = bgOn && dist <= dotR ? dot : c;
      px[i] = use[0]; px[i+1] = use[1]; px[i+2] = use[2]; px[i+3] = use[3];
    }
  }
  return px;
}

mkdirSync('src/icons', { recursive: true });
for (const s of [16, 48, 128]) {
  const buf = encodePNG(s, draw(s));
  writeFileSync(`src/icons/icon-${s}.png`, buf);
  console.log(`wrote src/icons/icon-${s}.png (${buf.length}B)`);
}
