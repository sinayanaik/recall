// Draws the toolbar icons for Recall Page Cleaner and Recall Web to PDF.
// No dependencies beyond Node's zlib — the same approach as
// recall-clipper/tools/generate-icons.js, with 4× supersampling for smooth edges.
//
//   node tools/extension-icons.mjs
//
// Writes <extension>/icons/icon-{16,48,128}.png. Re-run only to change a design.

import zlib from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// shade(u, v) → [r, g, b, a] or null, with u, v in 0..1.
function render(size, shade) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          const ca = c[3] / 255;
          r += c[0] * ca; g += c[1] * ca; b += c[2] * ca; a += ca;
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return encodePng(size, px);
}

const inRounded = (u, v, radius = 0.22) => {
  const nx = Math.min(u, 1 - u);
  const ny = Math.min(v, 1 - v);
  if (nx >= radius || ny >= radius) return true;
  const dx = radius - nx; const dy = radius - ny;
  return dx * dx + dy * dy <= radius * radius;
};
const inRect = (u, v, x0, y0, x1, y1) => u >= x0 && u <= x1 && v >= y0 && v <= y1;
const nearSegment = (u, v, ax, ay, bx, by, w) => {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
  const px = ax + t * dx - u; const py = ay + t * dy - v;
  return px * px + py * py <= w * w;
};

const WHITE = [255, 255, 255, 255];

// Page Cleaner: a coral tile, three text lines, the middle one struck out and
// blurred-red, and a sweeping slash.
function cleaner(u, v) {
  if (!inRounded(u, v)) return null;
  const TILE = [229, 83, 61, 255];
  if (inRect(u, v, 0.22, 0.26, 0.74, 0.34)) return WHITE;
  if (inRect(u, v, 0.22, 0.46, 0.62, 0.54)) return [255, 205, 196, 255];
  if (inRect(u, v, 0.22, 0.66, 0.68, 0.74)) return WHITE;
  if (nearSegment(u, v, 0.18, 0.62, 0.70, 0.38, 0.035)) return [120, 24, 12, 255];
  return TILE;
}

// Web to PDF: an indigo tile with a white page (folded corner) and a down arrow.
function webToPdf(u, v) {
  if (!inRounded(u, v)) return null;
  const TILE = [79, 91, 213, 255];
  const x0 = 0.26; const y0 = 0.18; const x1 = 0.74; const y1 = 0.82; const fold = 0.16;
  const inPage = inRect(u, v, x0, y0, x1, y1) && !(u > x1 - fold && v < y0 + fold && (u - (x1 - fold)) > (v - y0));
  if (inPage) {
    if (u > x1 - fold && v < y0 + fold) return [200, 206, 245, 255];
    // arrow: shaft and head
    if (inRect(u, v, 0.465, 0.34, 0.535, 0.58)) return TILE;
    if (v >= 0.52 && v <= 0.70 && Math.abs(u - 0.5) <= (0.70 - v) * 0.95) return TILE;
    return WHITE;
  }
  return TILE;
}

for (const [folder, shade] of [["recall-page-cleaner", cleaner], ["recall-web-to-pdf", webToPdf]]) {
  const out = path.join(ROOT, folder, "icons");
  mkdirSync(out, { recursive: true });
  for (const size of [16, 48, 128]) {
    writeFileSync(path.join(out, `icon-${size}.png`), render(size, shade));
  }
  console.log(`${folder}/icons written`);
}
