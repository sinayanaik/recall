// Gives each page of a finished PDF its own height, as an incremental update —
// the same technique as pdf-info.js: Chrome's bytes stay exactly as they are,
// and a new copy of each page object, an xref section and a trailer pointing
// back at the old one (/Prev) are appended (lib/pdf-objects.js).
//
// Smart pages print every page on paper as tall as the tallest one (Chrome
// prints a document on one paper size). The page's content starts at the top,
// so a shorter page is the same page with its MediaBox raised from the
// bottom: [x0, y1 − h, x1, y1]. Nothing drawn on the page moves.
//
// How tall each page's content really is comes from the PDF itself where it
// can: content/prepare.js leaves an empty marker where each page's content
// ends (recall-end-N), linked from a hidden list, and Chrome writes a named
// destination with the marker's printed position (pageHeightsFromMarkers).
// The heights measured on screen are the fallback.
//
// Plain ES module: used by pdf-job.js, and by the app's checks under Node.

import { readDoc, readPagesOf, readDestsOf, appendObjects } from "./pdf-objects.js";

/** The page objects in reading order: [{ num, gen, dict, mediaBox }]. Null if unreadable. */
export function readPages(bytes) {
  const doc = readDoc(bytes);
  return doc ? readPagesOf(doc) : null;
}

/** Named destinations: name → { page, x, y, array } (see pdf-objects.js). */
export function readDests(bytes) {
  const doc = readDoc(bytes);
  return doc ? readDestsOf(doc) : new Map();
}

const num = (n) => String(Math.round(n * 1000) / 1000);

/**
 * Each PRINTED page's height in points, read from the end-of-content markers
 * (`${prefix}N`), plus the bottom margin and `padPt` — one entry per page of
 * the PDF, null for a page with no marker on it.
 *
 * A marker counts for the page Chrome actually printed it on, which is not
 * always the page planned: a cut Chrome ignored (one made with Alt before a
 * flex item, say) puts two pages' ends on one page, and a page too tall for
 * the paper spills onto one more. A page with two ends ends at the lower one.
 * `count` is no longer needed and is ignored.
 */
export function pageHeightsFromMarkers(bytes, count, { prefix = "recall-end-", bottomPt = 0, padPt = 4 } = {}) {
  const doc = readDoc(bytes);
  if (!doc) return new Array(count || 0).fill(null);
  const pages = readPagesOf(doc);
  if (!pages) return new Array(count || 0).fill(null);
  const out = new Array(pages.length).fill(null);
  for (const [name, d] of readDestsOf(doc, pages)) {
    if (!name.startsWith(prefix) || d.y == null || !pages[d.page]) continue;
    const [, y0, , y1] = pages[d.page].mediaBox;
    if (d.y < y0 || d.y > y1) continue;
    const h = (y1 - d.y) + bottomPt + padPt;
    if (out[d.page] == null || h > out[d.page]) out[d.page] = h;
  }
  return out;
}

/**
 * Returns new bytes in which page i is `heightsPt[i]` points tall, keeping its
 * top. A height of 0, or one no shorter than the page, leaves that page alone.
 * Returns `bytes` itself when nothing could (or needed to) change.
 * @param {Uint8Array} bytes
 * @param {number[]} heightsPt
 */
export function trimPageHeights(bytes, heightsPt) {
  const doc = readDoc(bytes);
  const pages = doc && readPagesOf(doc);
  if (!pages || pages.length !== heightsPt.length) return bytes;
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
    changed.push({ num: page.num, gen: page.gen, body: dict });
  });
  if (!changed.length) return bytes;
  return appendObjects(bytes, doc, changed);
}
