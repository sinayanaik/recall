// WOFF 1.0 → a plain TrueType file that fontkit and pdf-lib handle.
//
// Two repairs, both found by drawing the fonts this feature uses:
//
// 1. Unwrapped. @fontsource ships .woff (and .woff2); fontkit reads a .woff
//    itself, but its reader runs past the end of a decompressed table on some
//    glyphs — JetBrains Mono's ligatures, Noto Sans Math's arrows — and throws
//    "Trying to access beyond buffer length" while measuring a line. The same
//    font as a plain sfnt reads correctly. WOFF 1 is only that sfnt with each
//    table zlib-compressed, so it is undone here.
//
// 2. Unhinted. Noto Sans Math (the → ≤ ∑ fallback) still carries TrueType
//    hinting instructions in its glyphs and a `maxp` that promises 141 hinting
//    functions, while the file has no `fpgm` to define them. A subset of it is
//    a valid font that both pdf.js and FreeType draw as NOTHING. Hinting does
//    nothing for a PDF read at any zoom, so it is taken out: every glyph's
//    instructions are dropped and maxp's hinting limits zeroed. The other fonts
//    are unhinted already and pass through untouched.
//
// `inflate(bytes) → Promise<Uint8Array>` is the zlib decoder: the browser's
// DecompressionStream("deflate") (md-pdf/fonts.js), or node:zlib in the checks.

export function isWoff(bytes) {
  return bytes && bytes.length > 44 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46;
}

const tagName = (n) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const tagNumber = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

// { flavor, tables: Map tag → Uint8Array } from a WOFF or an sfnt.
async function readTables(bytes, inflate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  if (isWoff(bytes)) {
    const numTables = view.getUint16(12);
    for (let i = 0; i < numTables; i += 1) {
      const at = 44 + i * 20;
      const offset = view.getUint32(at + 4);
      const compLength = view.getUint32(at + 8);
      const origLength = view.getUint32(at + 12);
      const slice = bytes.subarray(offset, offset + compLength);
      const data = compLength < origLength ? await inflate(slice) : slice;
      if (data.length !== origLength) throw new Error("woff: a table did not inflate to its stated size");
      tables.set(tagName(view.getUint32(at)), data);
    }
    return { flavor: view.getUint32(4), tables };
  }
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    tables.set(tagName(view.getUint32(at)), bytes.subarray(offset, offset + length));
  }
  return { flavor: view.getUint32(0), tables };
}

function sfntTableChecksum(data) {
  let sum = 0;
  const padded = data.length % 4 ? (() => { const p = new Uint8Array((data.length + 3) & ~3); p.set(data); return p; })() : data;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

function writeSfnt(flavor, tables) {
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) { searchRange *= 2; entrySelector += 1; }
  searchRange *= 16;
  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  for (const tag of tags) total += (tables.get(tag).length + 3) & ~3;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, flavor);
  ov.setUint16(4, numTables);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, entrySelector);
  ov.setUint16(10, numTables * 16 - searchRange);
  let offset = headerSize;
  tags.forEach((tag, i) => {
    const data = tables.get(tag);
    const at = 12 + i * 16;
    ov.setUint32(at, tagNumber(tag));
    ov.setUint32(at + 4, sfntTableChecksum(data));
    ov.setUint32(at + 8, offset);
    ov.setUint32(at + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

// One glyph's bytes without its instructions.
function glyphWithoutInstructions(g) {
  if (g.length < 10) return g;
  const view = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const contours = view.getInt16(0);
  if (contours >= 0) {
    const at = 10 + contours * 2;
    if (at + 2 > g.length) return g;
    const length = view.getUint16(at);
    if (!length) return g;
    const out = new Uint8Array(g.length - length);
    out.set(g.subarray(0, at));
    // instructionLength 0, then the flags and coordinates as they were.
    out.set(g.subarray(at + 2 + length), at + 2);
    return out;
  }
  // Composite: walk the components to the last; its "we have instructions"
  // flag is cleared and everything after it (the instructions) cut off.
  let at = 10;
  let lastFlagsAt = -1;
  for (let guard = 0; guard < 256; guard += 1) {
    if (at + 4 > g.length) return g;
    const flags = view.getUint16(at);
    lastFlagsAt = at;
    at += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) at += 2;
    else if (flags & 0x0040) at += 4;
    else if (flags & 0x0080) at += 8;
    if (!(flags & 0x0020)) break;
  }
  if (lastFlagsAt < 0 || at > g.length) return g;
  const out = g.slice(0, at);
  const ov = new DataView(out.buffer);
  ov.setUint16(lastFlagsAt, ov.getUint16(lastFlagsAt) & ~0x0100);
  return out;
}

function unhint(tables) {
  const maxp = tables.get("maxp");
  const head = tables.get("head");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  if (!maxp || maxp.length < 32 || !head || !loca || !glyf) return false;
  const mv = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength);
  const hinted = mv.getUint16(18) > 0 || tables.has("fpgm") || tables.has("prep");
  if (!hinted) return false;
  const numGlyphs = mv.getUint16(4);
  const longLoca = new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(50) === 1;
  const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const offsetOf = (i) => (longLoca ? lv.getUint32(i * 4) : lv.getUint16(i * 2) * 2);
  const glyphs = [];
  let size = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    const start = offsetOf(i);
    const end = offsetOf(i + 1);
    const glyph = end > start ? glyphWithoutInstructions(glyf.subarray(start, end)) : new Uint8Array(0);
    glyphs.push(glyph);
    size += (glyph.length + 3) & ~3;
  }
  const newGlyf = new Uint8Array(size);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const nl = new DataView(newLoca.buffer);
  let offset = 0;
  glyphs.forEach((glyph, i) => {
    nl.setUint32(i * 4, offset);
    newGlyf.set(glyph, offset);
    offset += (glyph.length + 3) & ~3;
  });
  nl.setUint32(numGlyphs * 4, offset);
  const newHead = head.slice();
  new DataView(newHead.buffer).setInt16(50, 1);
  // checkSumAdjustment is left as it was: no reader this file is for checks it.
  const newMaxp = maxp.slice();
  const nm = new DataView(newMaxp.buffer);
  nm.setUint16(14, 1); // maxZones
  for (const at of [16, 18, 20, 22, 24, 26]) nm.setUint16(at, 0); // twilight, storage, fdefs, idefs, stack, instructions
  tables.set("glyf", newGlyf);
  tables.set("loca", newLoca);
  tables.set("head", newHead);
  tables.set("maxp", newMaxp);
  tables.delete("fpgm");
  tables.delete("prep");
  tables.delete("cvt ");
  tables.delete("hdmx");
  tables.delete("LTSH");
  return true;
}

// The font as fontkit and pdf-lib should get it.
export async function woffToSfnt(bytes, inflate) {
  if (!bytes || bytes.length < 12) return bytes;
  const { flavor, tables } = await readTables(bytes, inflate);
  const changed = unhint(tables);
  if (!changed && !isWoff(bytes)) return bytes;
  return writeSfnt(flavor, tables);
}
