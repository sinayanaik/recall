// A contents for a PDF that does not carry one.
//
// ── Why this has to exist ──────────────────────────────────────────────────
//
// src/documents/pdf-outline.js reads the file's outline dictionary, which is
// what a well-made book carries and what almost no PAPER does: a preprint off
// arXiv, a scan, a slide deck exported from Keynote, a chapter someone printed
// to PDF — none of them has one. So the contents drawer on the Document surface
// was honest and empty for most of what people actually read on it, and "I click
// the hamburger and see nothing" is as true of an empty list as of a drawer that
// never came on screen (it was both — see the CSS note in styles/36-document.css).
//
// The information IS on the page: a heading is set in larger type than the
// paragraph under it, and in a numbered paper it is announced outright
// ("3.1 Method"). That is what this reads. (Bolder type would be the third
// signal and is not available — see the note on it below.)
//
// ── What it is careful about ───────────────────────────────────────────────
//
// Inferred, and never passed off as the author's own — the drawer says so above
// the list. The failure mode of a heuristic contents is not a missing row, it is
// a CONFIDENT wrong one, so every rule here is written to decline rather than to
// guess: a line that is too long is not a heading, a line that repeats on a
// third of the pages is a running head and not a heading, and a line in the top
// or bottom band of the page that repeats at all is furniture.
//
// ── ...and what it costs ───────────────────────────────────────────────────
//
// getTextContent() is a round trip to the pdf.js worker, per page. A 600-page
// book is 600 of them, which is not something to spend on the way into a
// document. So:
//
//   • it runs off the critical path, in the background, after the pages are on
//     screen (the same place buildDocumentOutline is called from);
//   • it yields to the main thread every PDF_TOC_YIELD_PAGES pages, so a phone
//     stays scrollable while it runs;
//   • it renders as it goes, rather than after;
//   • it is capped, in pages scanned and in entries kept;
//   • and the result is CACHED ON THE DECK. The file never changes — its sha256
//     is checked on re-attach — so a contents derived from it is as permanent as
//     the anchors are, and a reader pays for the scan once ever rather than once
//     per session and once per device.

import { state } from "../core/state.js?v=__BUILD__";
import { stripInvalidUnicode } from "../core/text.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { cleanPdfItemText, textItemGap } from "./pdf-selection.js?v=__BUILD__";

// Bumped when the rules below change enough that an old cached list would be
// worse than a fresh scan. A cache from a different version is ignored and
// rebuilt, not migrated: it is derived data, and re-deriving it is the whole
// thing this module does.
export const PDF_TOC_VERSION = 1;

// How many pages are read to establish what BODY TEXT looks like in this file.
// The answer is a property of the document, not of the page, so a couple of
// dozen pages is as good an answer as six hundred — and it has to be known
// before a single line can be judged, which is why it is its own short pass.
export const PDF_TOC_SAMPLE_PAGES = 24;

// ...and how many are read in full. Past this the scan stops and the contents
// covers the front of the book — which is where a reader navigating by contents
// is overwhelmingly looking, and is a great deal better than no contents at all.
export const PDF_TOC_SCAN_PAGES = 600;

// How many pages are read before the scan hands the main thread back. Low enough
// that a flick during the scan still scrolls; high enough that the yields are
// not most of the cost.
export const PDF_TOC_YIELD_PAGES = 16;

// The most rows kept. A textbook can have two thousand numbered subsections, and
// a drawer is not an index.
export const PDF_TOC_MAX_ENTRIES = 400;

// How much larger than body text a line has to be set to count as a heading.
// 1.12 is deliberately low: many papers set a subsection head one point up from
// the body, and the other filters (length, repetition, position) are what keep
// the false positives out. Raising this instead would lose exactly the headings
// that a paper's own outline dictionary is most likely to be missing.
export const PDF_TOC_HEADING_RATIO = 1.12;

// A line longer than this is a sentence, whatever it is set in. Two lines of a
// 260px drawer column, roughly — past it the row stops being scannable anyway.
export const PDF_TOC_TITLE_MAX_CHARS = 120;

// A "Chapter 4" / "Appendix B" line at body size has to be short to be a
// heading rather than a sentence that happens to start with the word.
export const PDF_TOC_SHORT_MAX_CHARS = 80;

// ── The rule that is NOT here, and why ────────────────────────────────────
//
// The obvious third signal is WEIGHT: a subsection head set bold at body size,
// which is how a great many papers do it. It is not read here because pdf.js
// does not hand it over. A text item's `fontName` is a generated id
// ("g_d0_f1"), and the styles map it indexes carries
// `{ fontFamily, ascent, descent, vertical }` where fontFamily is the FALLBACK
// name the worker computed — "serif", "sans-serif" or "monospace", nothing
// more (pdf.js 3.11, Font#fallbackName). Testing any of that for /bold/ is
// code that reads as if it works and can never fire once, which is worse than
// not having it: the next person to touch this would trust it.
//
// What is left is size, numbering and the named forms below, all of which are
// asserted against a real document in tools/pdf-preview-check.mjs. A paper
// whose only cue is boldness gets its top-level headings (those are set larger
// too, essentially always) and not its subsections, which is the honest
// outcome and is still a contents where there was none.

// Two text items are on the same line when their baselines are within this
// fraction of the taller one's height. A superscript, a footnote marker and an
// inline formula all sit on one line to a reader and differ by a point or two
// here — the same argument LINE_BAND_OVERLAP makes in pdf-highlights.js.
export const PDF_TOC_BASELINE_RATIO = 0.4;

// A line whose words repeat on this share of the scanned pages is a running head
// or a footer, not a heading. A book's chapter title genuinely does repeat on
// every page of that chapter, which is exactly the thing being excluded.
export const PDF_TOC_RUNNING_SHARE = 0.3;

// ...and the floor under it, so the share is never read off a sample too small
// to mean anything. See the filter that uses it.
export const PDF_TOC_RUNNING_MIN_PAGES = 3;

// The bands at the top and bottom of a page where a repeat of ANY kind is
// furniture. Page numbers, journal names, DOIs and "Preprint. Under review."
// all live here.
export const PDF_TOC_EDGE_BAND = 0.06;

// "3", "3.1", "3.1.2" — optionally followed by a dot or a bracket — then real
// words. The trailing `\S` is what stops "2011." (a bare year at the top of a
// preprint) and "1." (a list marker) being read as sections.
export const PDF_TOC_NUMBERED_RE = /^(\d+(?:\.\d+){0,3})[.)]?\s+(\S.*)$/;

// Chapter/appendix/part announcements that carry no size cue at all in some
// producers. Matched on the whole line so "Chapter and verse" is not one.
export const PDF_TOC_NAMED_RE = /^(chapter|section|part|appendix|annex)\b[\s.:—-]*([ivxlcdm\d]+)?\b/i;

// Lines that are never a heading whatever they are set in.
export const PDF_TOC_JUNK_RE = /^[\s\d.,;:()[\]{}·•—–-]*$/;

// ── The cache on the deck ──────────────────────────────────────────────────

export function readCachedPdfContents(pageCount) {
  const cached = state.meta?.pdfToc;
  if (!cached || cached.v !== PDF_TOC_VERSION) return null;
  // The page count is the cheap proof that this cache belongs to this file. A
  // re-attach already checks the sha256, so a document that is the same length
  // is the same document.
  if (pageCount && cached.pages !== pageCount) return null;
  if (!Array.isArray(cached.entries) || !cached.entries.length) return null;
  return cached.entries.map((entry) => ({
    title: String(entry.t || ""),
    page: Number(entry.p) || 0,
    depth: Number(entry.d) || 0,
    derived: true
  })).filter((entry) => entry.title && entry.page);
}

export function cachePdfContents(entries, pageCount) {
  if (!state.meta || typeof state.meta !== "object") return;
  // Stored with one-letter keys, deliberately. This rides in the deck's JSONB
  // meta and is synced with it; four hundred rows of { title, page, depth } is
  // about three times the size of the same rows as { t, p, d }, for a bag that
  // every other field in is a handful of bytes.
  state.meta = {
    ...state.meta,
    pdfToc: {
      v: PDF_TOC_VERSION,
      pages: pageCount,
      // Stripped as it is written, not only where the titles are built: this is
      // the point at which contents entries become part of the deck's synced
      // meta, and a title from the file's own outline dictionary comes through
      // pdf.js's string decoder, which is where the NULs come from.
      entries: entries.map((entry) => ({ t: stripInvalidUnicode(entry.title), p: entry.page, d: entry.depth }))
    }
  };
  scheduleDeckAutosave();
}

// ── Lines ──────────────────────────────────────────────────────────────────

// One text item's type size, in PDF user space. The same expression
// textItemBox() uses in pdf-selection.js, for the same reason: `height` is not
// always populated, and the transform always is.
export function pdfItemSize(item) {
  return item.height || Math.hypot(item.transform?.[2] || 0, item.transform?.[3] || 0) || 0;
}

// A page's text items, grouped into lines in reading order.
//
// Each line is { text, size, y, page } — `y` being the baseline in PDF
// user space, where a LARGER y is higher up the page.
//
// The join is textItemGap(), which is the same function buildTextLayer uses to
// decide what goes between two spans. That is not tidiness: it means a heading
// derived here reads exactly as it would if the reader had selected it, rather
// than as the welded-together string that a bare concatenation gives (see the
// repairDocumentHighlightText history in pdf-highlights.js).
export function pdfTocLinesFrom(items, pageNumber) {
  const lines = [];
  let current = null;
  let previous = null;
  (items || []).forEach((item) => {
    if (!item || !item.str) { if (item?.hasEOL) current = null; return; }
    const size = pdfItemSize(item);
    const y = item.transform?.[5] ?? 0;
    const sameLine = current
      && Math.abs(current.y - y) <= Math.max(1, Math.max(size, current.size) * PDF_TOC_BASELINE_RATIO);
    if (!sameLine) {
      current = { text: "", size, chars: 0, y, page: pageNumber };
      lines.push(current);
      previous = null;
    }
    current.text += textItemGap(previous, item) + item.str;
    // The line's size is whichever covers the most CHARACTERS: a heading with a
    // footnote marker on it is still a heading, and a paragraph whose first
    // three words are set large is still a paragraph.
    const chars = item.str.length;
    if (chars > current.chars) {
      current.chars = chars;
      current.size = size;
    }
    current.y = Math.max(current.y, y);
    previous = item;
    if (item.hasEOL) current = null;
  });
  return lines
    .map((line) => ({ ...line, text: cleanPdfItemText(line.text) }))
    .filter((line) => line.text);
}

// The type size body text is set in: the size holding the most CHARACTERS, not
// the most lines. Weighting by lines would let a title page of six large words
// outvote the paragraph it introduces.
export function pdfTocBodySize(lines) {
  const weights = new Map();
  lines.forEach((line) => {
    const key = Math.round(line.size * 2) / 2;
    if (!key) return;
    weights.set(key, (weights.get(key) || 0) + line.text.length);
  });
  let best = 0;
  let bestWeight = -1;
  weights.forEach((weight, size) => {
    if (weight <= bestWeight) return;
    bestWeight = weight;
    best = size;
  });
  return best;
}

// What a line says, with the parts that vary page to page taken out, so that
// "Chapter 4 · 87" and "Chapter 4 · 88" are recognised as the same furniture.
export function pdfTocRunningKey(text) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

// ── Which lines are headings ───────────────────────────────────────────────

export function pdfTocLineKind(line, bodySize) {
  const text = line.text;
  if (!text || text.length > PDF_TOC_TITLE_MAX_CHARS) return null;
  if (PDF_TOC_JUNK_RE.test(text)) return null;
  const big = bodySize > 0 && line.size >= bodySize * PDF_TOC_HEADING_RATIO;
  if (big) return { kind: "size", size: Math.round(line.size * 2) / 2 };
  const numbered = PDF_TOC_NUMBERED_RE.exec(text);
  if (numbered) return { kind: "numbered", size: Math.round(line.size * 2) / 2, number: numbered[1] };
  if (PDF_TOC_NAMED_RE.test(text) && text.length <= PDF_TOC_SHORT_MAX_CHARS) {
    return { kind: "named", size: Math.round(line.size * 2) / 2 };
  }
  return null;
}

// Everything that survives the per-line test, before the cross-page ones.
export function pdfTocCandidatesFrom(lines, bodySize, pageBox) {
  const out = [];
  lines.forEach((line) => {
    const kind = pdfTocLineKind(line, bodySize);
    if (!kind) return;
    const height = pageBox ? pageBox.height : 0;
    const fromTop = height ? (pageBox.top - line.y) / height : 1;
    const fromBottom = height ? (line.y - pageBox.bottom) / height : 1;
    out.push({
      ...kind,
      text: line.text,
      page: line.page,
      y: line.y,
      edge: fromTop <= PDF_TOC_EDGE_BAND || fromBottom <= PDF_TOC_EDGE_BAND,
      key: pdfTocRunningKey(line.text)
    });
  });
  return out;
}

// Drop the furniture, assign a depth to what is left, and cap it.
export function pdfTocEntriesFrom(candidates, scannedPages) {
  if (!candidates.length) return [];

  // ── Running heads ────────────────────────────────────────────────────────
  const pagesByKey = new Map();
  candidates.forEach((candidate) => {
    if (!pagesByKey.has(candidate.key)) pagesByKey.set(candidate.key, new Set());
    pagesByKey.get(candidate.key).add(candidate.page);
  });
  const share = Math.max(1, scannedPages);
  const kept = candidates.filter((candidate) => {
    const pages = pagesByKey.get(candidate.key)?.size || 1;
    // Three pages before the share test bites, whatever the share works out to.
    // On a four-page paper one repeat is 50% and is not evidence of anything —
    // two sections can legitimately share a name ("Results") in a way that a
    // running head, which is on every page of its chapter, never does.
    if (pages >= PDF_TOC_RUNNING_MIN_PAGES && pages / share >= PDF_TOC_RUNNING_SHARE) return false;
    // In the top or bottom band, ANY repeat is furniture: a page number, a
    // journal name, a "Preprint. Under review." — none of which repeats often
    // enough to trip the share test on a short document.
    if (candidate.edge && pages > 1) return false;
    return true;
  });
  if (!kept.length) return [];

  // ── Depth, from the type-size ladder ─────────────────────────────────────
  //
  // The distinct sizes among what survived, largest first. The top three become
  // depths 0-2; anything smaller is folded into 2, which is what
  // OUTLINE_MAX_DEPTH already promises for the file's own outline.
  const sizes = [...new Set(kept.map((entry) => entry.size))].sort((a, b) => b - a);
  const rankOf = new Map(sizes.map((size, index) => [size, Math.min(index, 2)]));

  const entries = [];
  let last = null;
  kept
    .sort((a, b) => (a.page - b.page) || (b.y - a.y))
    .forEach((candidate) => {
      // A numbered heading says its own depth outright, and says it better than
      // the type ladder can: "3.1" is one level under "3" whether or not the
      // producer set them at different sizes.
      const depth = candidate.number
        ? Math.min(candidate.number.split(".").length - 1, 2)
        : (rankOf.get(candidate.size) ?? 2);
      // The same words twice in a row is one heading the producer emitted as two
      // items, or a heading repeated on a continuation page.
      if (last && last.title === candidate.text && last.page === candidate.page) return;
      last = { title: candidate.text, page: candidate.page, depth, derived: true };
      entries.push(last);
    });

  if (entries.length <= PDF_TOC_MAX_ENTRIES) return entries;
  // Over the cap: keep the shallowest levels, which is the outline a reader
  // navigates by, rather than the first N rows — that would be the front of the
  // book in full detail and the rest of it not at all.
  for (let limit = 0; limit <= 2; limit += 1) {
    const trimmed = entries.filter((entry) => entry.depth <= limit);
    if (trimmed.length && trimmed.length <= PDF_TOC_MAX_ENTRIES) return trimmed;
  }
  return entries.slice(0, PDF_TOC_MAX_ENTRIES);
}

// ── The scan ───────────────────────────────────────────────────────────────

function pageBoxOf(page) {
  const view = page?.view;
  if (!Array.isArray(view) || view.length < 4) return null;
  return { bottom: view[1], top: view[3], height: Math.abs(view[3] - view[1]) };
}

// Hand the main thread back. A macrotask rather than a microtask, deliberately:
// a promise chain would run every page in one task and yield nothing at all.
function pdfTocBreathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Read a contents out of the pages.
//
// `alive()` is asked before every page and before every publish, so a deck
// swapped while a six-hundred-page scan is in flight drops it rather than
// painting into a document that is no longer there — the same guard shape
// pdfOpenToken gives every render in pdf-view.js.
//
// `onProgress(entries)` is called as the scan advances, so the drawer fills in
// rather than sitting empty until the last page lands.
export async function derivePdfContents(doc, { alive = () => true, onProgress = () => {} } = {}) {
  if (!doc?.numPages) return [];
  const pageCount = doc.numPages;
  const scanTo = Math.min(pageCount, PDF_TOC_SCAN_PAGES);

  // Pass one: what does body text look like here?
  const sample = [];
  const sampled = new Map();
  const sampleTo = Math.min(scanTo, PDF_TOC_SAMPLE_PAGES);
  for (let pageNumber = 1; pageNumber <= sampleTo; pageNumber += 1) {
    if (!alive()) return [];
    const page = await doc.getPage(pageNumber);
    const lines = pdfTocLinesFrom((await page.getTextContent()).items, pageNumber);
    sampled.set(pageNumber, { lines, box: pageBoxOf(page) });
    lines.forEach((line) => sample.push(line));
    if (pageNumber % PDF_TOC_YIELD_PAGES === 0) await pdfTocBreathe();
  }
  const bodySize = pdfTocBodySize(sample);

  // Pass two: every page, keeping only what could be a heading. Nothing else is
  // retained — a book's body text is tens of megabytes of strings and none of it
  // is an answer to this question.
  const candidates = [];
  for (let pageNumber = 1; pageNumber <= scanTo; pageNumber += 1) {
    if (!alive()) return [];
    let lines;
    let box;
    const cached = sampled.get(pageNumber);
    if (cached) {
      ({ lines, box } = cached);
      sampled.delete(pageNumber);
    } else {
      const page = await doc.getPage(pageNumber);
      box = pageBoxOf(page);
      lines = pdfTocLinesFrom((await page.getTextContent()).items, pageNumber);
    }
    pdfTocCandidatesFrom(lines, bodySize, box).forEach((candidate) => candidates.push(candidate));
    if (pageNumber % PDF_TOC_YIELD_PAGES === 0) {
      await pdfTocBreathe();
      if (!alive()) return [];
      onProgress(pdfTocEntriesFrom(candidates, pageNumber));
    }
  }
  if (!alive()) return [];
  return pdfTocEntriesFrom(candidates, scanTo);
}
