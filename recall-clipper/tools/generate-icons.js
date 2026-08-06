// Standalone icon generator — no dependencies beyond Node's built-in zlib.
// Renders a rounded teal tile with three white "note lines" and a small
// down-arrow (evokes "clip page -> notes"). Run: node tools/generate-icons.js
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const TEAL = [0x1a, 0xc4, 0xb8];      // tile background
const WHITE = [0xff, 0xff, 0xff];     // marks

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  // pixels: Uint8 RGBA array, length size*size*4
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4); // transparent
  const s = size;
  const radius = s * 0.22;
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return;
    const i = (y * s + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const inRounded = (x, y) => {
    const nx = Math.min(x, s - 1 - x);
    const ny = Math.min(y, s - 1 - y);
    if (nx >= radius || ny >= radius) return true;
    const dx = radius - nx, dy = radius - ny;
    return dx * dx + dy * dy <= radius * radius;
  };
  // Tile
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (inRounded(x, y)) put(x, y, TEAL);
  // Three note lines (top two-thirds), decreasing width
  const lineH = Math.max(1, Math.round(s * 0.09));
  const left = Math.round(s * 0.26);
  const widths = [0.48, 0.38, 0.30];
  const tops = [0.28, 0.44, 0.60];
  widths.forEach((w, idx) => {
    const x0 = left;
    const x1 = left + Math.round(s * w);
    const y0 = Math.round(s * tops[idx]);
    for (let y = y0; y < y0 + lineH; y++) for (let x = x0; x < x1; x++) put(x, y, WHITE);
  });
  return encodePng(s, px);
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), draw(size));
  console.log(`icon-${size}.png written`);
}
