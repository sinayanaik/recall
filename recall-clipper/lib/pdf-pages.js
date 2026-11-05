// Gives each page of a finished PDF its own height, as an incremental update —
// the same technique as pdf-info.js: Chrome's bytes stay exactly as they are,
// and a new copy of each page object, an xref section and a trailer pointing
// back at the old one (/Prev) are appended.
//
// Smart pages print every page on paper as tall as the tallest one (Chrome
// prints a document on one paper size). The page's content starts at the top,
// so a shorter page is the same page with its MediaBox raised from the
// bottom: [x0, y1 − h, x1, y1]. Nothing drawn on the page moves.
//
// Only classic xref tables are read — what Chrome's PDF backend (Skia) writes.
// Anything else comes back untouched, which is always a valid answer: the
// pages are merely all the same height.
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

import { readTrailer } from "./pdf-info.js";

const latin1 = new TextDecoder("latin1");

// The dictionary that begins at `text[start]` ("<<"), balanced.
function dictAt(text, start) {
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

function objectDict(text, offsets, num) {
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

const refOf = (dict, key) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

const boxOf = (dict, key) => {
  const m = new RegExp(`/${key}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s*\\]`).exec(dict);
  return m ? m.slice(1, 5).map(Number) : null;
};

/** The page objects in reading order: [{ num, gen, dict, mediaBox }]. Null if unreadable. */
export function readPages(bytes) {
  const text = latin1.decode(bytes);
  const trailer = readTrailer(bytes);
  const offsets = readXref(text, trailer.startxref);
  if (!offsets) return null;
  const rootNum = Number(trailer.root.split(" ")[0]);
  const root = objectDict(text, offsets, rootNum);
  const pagesNum = root && refOf(root.dict, "Pages");
  if (pagesNum == null) return null;
  const pages = [];
  const visit = (num, inheritedBox, depth) => {
    if (depth > 32 || pages.length > 10000) return false;
    const obj = objectDict(text, offsets, num);
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

const num = (n) => String(Math.round(n * 1000) / 1000);

/**
 * Returns new bytes in which page i is `heightsPt[i]` points tall, keeping its
 * top. A height of 0, or one no shorter than the page, leaves that page alone.
 * Returns `bytes` itself when nothing could (or needed to) change.
 * @param {Uint8Array} bytes
 * @param {number[]} heightsPt
 */
export function trimPageHeights(bytes, heightsPt) {
  let pages;
  try { pages = readPages(bytes); } catch { return bytes; }
  if (!pages || pages.length !== heightsPt.length) return bytes;
  const trailer = readTrailer(bytes);
  const changed = [];
  pages.forEach((page, i) => {
    const [x0, y0, x1, y1] = page.mediaBox;
    const h = Number(heightsPt[i]);
    if (!Number.isFinite(h) || h <= 0 || h >= (y1 - y0) - 0.5) return;
    const box = `/MediaBox [${num(x0)} ${num(y1 - h)} ${num(x1)} ${num(y1)}]`;
    let dict = page.dict.replace(/\/MediaBox\s*\[[^\]]*\]/, box);
    if (dict === page.dict) dict = dict.replace(/^<</, `<< ${box}`);
    // A crop or bleed box of the old height would undo the trim in some viewers.
    dict = dict.replace(/\/(CropBox|BleedBox|TrimBox|ArtBox)\s*\[[^\]]*\]/g, "");
    changed.push({ num: page.num, gen: page.gen, dict });
  });
  if (!changed.length) return bytes;

  const lead = bytes[bytes.length - 1] === 0x0a ? "" : "\n";
  let body = lead;
  const entries = [];
  for (const obj of changed) {
    entries.push({ num: obj.num, gen: obj.gen, offset: bytes.length + body.length });
    body += `${obj.num} ${obj.gen} obj\n${obj.dict}\nendobj\n`;
  }
  const xrefStart = bytes.length + body.length;
  const sections = entries
    .sort((a, b) => a.num - b.num)
    .map((e) => `${e.num} 1\n${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n \n`)
    .join("");
  const trailerDict = [
    `/Size ${trailer.size}`,
    `/Root ${trailer.root}`,
    trailer.info ? `/Info ${trailer.info}` : "",
    `/Prev ${trailer.startxref}`,
    trailer.id ? `/ID ${trailer.id}` : ""
  ].filter(Boolean).join(" ");
  const tail = `xref\n${sections}trailer\n<< ${trailerDict} >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // The page dictionaries were read as latin1, so writing them back one byte
  // per character reproduces them exactly.
  const extra = body + tail;
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes, 0);
  for (let i = 0; i < extra.length; i += 1) out[bytes.length + i] = extra.charCodeAt(i) & 0xff;
  return out;
}
