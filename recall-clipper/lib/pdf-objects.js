// Reading the objects of a finished PDF, and appending new versions of them as
// an incremental update. Shared by lib/pdf-pages.js (each smart page its own
// height) and lib/pdf-outline.js (bookmarks): Chrome's bytes always stay
// exactly as they are, and new objects, an xref section and a trailer pointing
// back at the old one (/Prev) are appended.
//
// Only classic xref tables are read — what Chrome's PDF backend (Skia) writes.
// Anything else reads as null, and every caller then leaves the bytes alone.
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

import { readTrailer } from "./pdf-info.js";

const latin1 = new TextDecoder("latin1");

// The dictionary that begins at `text[start]` ("<<"), balanced.
export function dictAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") { depth += 1; i += 1; }
    else if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1; i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Object number → byte offset, from the classic xref table at `startxref`
// (and the ones before it, through /Prev). Null when it is not a classic table.
function readXref(text, startxref) {
  const offsets = new Map();
  let at = startxref;
  const seen = new Set();
  while (at != null && !seen.has(at)) {
    seen.add(at);
    if (!text.startsWith("xref", at)) return null;
    const re = /(\d+)\s+(\d+)\s*[\r\n]+/y;
    let i = at + 4;
    while (/\s/.test(text[i])) i += 1;
    while (!text.startsWith("trailer", i)) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m) return null;
      const first = Number(m[1]);
      const count = Number(m[2]);
      i = re.lastIndex;
      for (let k = 0; k < count; k += 1) {
        const line = text.slice(i, i + 20);
        const e = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
        if (!e) return null;
        if (e[3] === "n" && !offsets.has(first + k)) offsets.set(first + k, { offset: Number(e[1]), gen: Number(e[2]) });
        i += 20;
        while (i < text.length && /[\r\n ]/.test(text[i]) && !/\d|t/.test(text[i])) i += 1;
      }
    }
    const trailer = dictAt(text, text.indexOf("<<", i));
    const prev = trailer && /\/Prev\s+(\d+)/.exec(trailer);
    at = prev ? Number(prev[1]) : null;
  }
  return offsets;
}

/**
 * The parts of a PDF the readers below need, or null when its xref is not a
 * classic table: { text, trailer, offsets }.
 */
export function readDoc(bytes) {
  try {
    const text = latin1.decode(bytes);
    const trailer = readTrailer(bytes);
    const offsets = readXref(text, trailer.startxref);
    return offsets ? { text, trailer, offsets } : null;
  } catch {
    return null;
  }
}

/** Object `num`'s dictionary: { dict, gen, isStream }, or null. */
export function objectDict(doc, num) {
  const { text, offsets } = doc;
  const where = offsets.get(num);
  if (!where) return null;
  if (!new RegExp(`^\\s*${num}\\s+${where.gen}\\s+obj\\b`).test(text.slice(where.offset, where.offset + 64))) return null;
  const open = text.indexOf("<<", where.offset);
  if (open < 0 || open - where.offset > 64) return null;
  const dict = dictAt(text, open);
  if (!dict) return null;
  // A stream object is not a page; and a page is never a stream.
  const after = text.slice(open + dict.length, open + dict.length + 32);
  return { dict, gen: where.gen, isStream: /^\s*stream/.test(after) };
}

export const refOf = (dict, key) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

export const boxOf = (dict, key) => {
  const m = new RegExp(`/${key}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s*\\]`).exec(dict);
  return m ? m.slice(1, 5).map(Number) : null;
};

export function catalogOf(doc) {
  const num = Number(doc.trailer.root.split(" ")[0]);
  const obj = objectDict(doc, num);
  return obj ? { num, ...obj } : null;
}

/** The page objects in reading order: [{ num, gen, dict, mediaBox }]. Null if unreadable. */
export function readPagesOf(doc) {
  const root = catalogOf(doc);
  const pagesNum = root && refOf(root.dict, "Pages");
  if (pagesNum == null) return null;
  const pages = [];
  const visit = (num, inheritedBox, depth) => {
    if (depth > 32 || pages.length > 10000) return false;
    const obj = objectDict(doc, num);
    if (!obj || obj.isStream) return false;
    const box = boxOf(obj.dict, "MediaBox") || inheritedBox;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
      if (!kids) return false;
      for (const m of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) if (!visit(Number(m[1]), box, depth + 1)) return false;
      return true;
    }
    if (/\/Type\s*\/Page\b/.test(obj.dict)) {
      if (!box) return false;
      pages.push({ num, gen: obj.gen, dict: obj.dict, mediaBox: box });
      return true;
    }
    return false;
  };
  return visit(pagesNum, null, 0) ? pages : null;
}

const decodeName = (name) => name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * The document's named destinations, from the catalog's /Dests dictionary —
 * where Chrome puts one for every element an in-page link points at:
 * name → { page (0-based), pageNum, x, y, array }. `array` is the destination
 * as written, ready to reuse. Empty when there are none.
 */
export function readDestsOf(doc, pages = readPagesOf(doc)) {
  const out = new Map();
  const root = catalogOf(doc);
  if (!root || !pages) return out;
  let dict = null;
  const ref = refOf(root.dict, "Dests");
  if (ref != null) dict = objectDict(doc, ref)?.dict || null;
  else {
    const at = root.dict.search(/\/Dests\s*<</);
    if (at >= 0) dict = dictAt(root.dict, root.dict.indexOf("<<", at));
  }
  if (!dict) return out;
  const pageIndex = new Map(pages.map((p, i) => [p.num, i]));
  const re = /\/([^\s/[\]<>()]+)\s*(?:<<\s*\/D\s*)?(\[\s*(\d+)\s+\d+\s+R\s*\/XYZ\s+([-\d.]+|null)\s+([-\d.]+|null)[^\]]*\])/g;
  for (const m of dict.matchAll(re)) {
    const page = pageIndex.get(Number(m[3]));
    if (page == null) continue;
    out.set(decodeName(m[1]), {
      page, pageNum: Number(m[3]), array: m[2],
      x: m[4] === "null" ? null : Number(m[4]),
      y: m[5] === "null" ? null : Number(m[5])
    });
  }
  return out;
}

/**
 * Appends `objects` ([{ num, gen, body }], `body` being what goes between
 * "obj" and "endobj", latin1) as an incremental update. `size` is the new
 * trailer /Size (at least the old one). Returns the new bytes.
 */
export function appendObjects(bytes, doc, objects, size = doc.trailer.size) {
  const { trailer } = doc;
  const lead = bytes[bytes.length - 1] === 0x0a ? "" : "\n";
  let body = lead;
  const entries = [];
  for (const obj of objects) {
    entries.push({ num: obj.num, gen: obj.gen || 0, offset: bytes.length + body.length });
    body += `${obj.num} ${obj.gen || 0} obj\n${obj.body}\nendobj\n`;
  }
  const xrefStart = bytes.length + body.length;
  const sorted = entries.sort((a, b) => a.num - b.num);
  // Consecutive numbers share a subsection, as the format allows.
  let sections = "";
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].num === sorted[j].num + 1) j += 1;
    sections += `${sorted[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k += 1) sections += `${String(sorted[k].offset).padStart(10, "0")} ${String(sorted[k].gen).padStart(5, "0")} n \n`;
    i = j + 1;
  }
  const trailerDict = [
    `/Size ${Math.max(size, trailer.size)}`,
    `/Root ${trailer.root}`,
    trailer.info ? `/Info ${trailer.info}` : "",
    `/Prev ${trailer.startxref}`,
    trailer.id ? `/ID ${trailer.id}` : ""
  ].filter(Boolean).join(" ");
  const tail = `xref\n${sections}trailer\n<< ${trailerDict} >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Dictionaries were read as latin1, so writing them back one byte per
  // character reproduces them exactly.
  const extra = body + tail;
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes, 0);
  for (let i = 0; i < extra.length; i += 1) out[bytes.length + i] = extra.charCodeAt(i) & 0xff;
  return out;
}
