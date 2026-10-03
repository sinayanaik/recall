// A highlighter that knows whether there are words under it.
//
// "The text highlighter is a one-time tool — it should be reusable until
// released, and smart enough to distinguish: where there is actual text,
// highlight it as text; where there is none, only a scanned page, highlight it
// as a region."
//
// Two tools ask that question, and both ask it here:
//
//   ▣ (src/documents/pdf-region.js) — a mode that stays on until it is turned
//      off. A drag that starts on words highlights those words, snapped to
//      whole words, with nothing to press in between; a drag that starts
//      anywhere else draws a region box, as it always did.
//   the pen bar's highlighter (src/documents/pdf-ink.js, claimStroke) — a sweep
//      along a line of real text becomes a text highlight of those words; over
//      a scan, a figure, handwriting or blank paper it stays the translucent
//      band it was.
//
// A text highlight is worth more than a band over the same words: it carries
// the words, so it is searchable, it exports as a quotation and a card made
// from it has them on its face. A band carries none of that. So wherever the
// words are THERE to be had, they are taken.
//
// ── Hit-testing without hit-testing ───────────────────────────────────────
//
// While ▣ is on, the text layer takes no pointer events (it must not: the
// drag is the mode's, not a native selection's — styles/37-document-chrome.css),
// so document.caretRangeFromPoint and elementFromPoint walk straight through
// the words. Everything below is therefore GEOMETRY: each span's box, and
// within a span each character's box, from getBoundingClientRect on a Range.
// Those are layout questions and are answered whatever pointer-events says. A
// span's box already includes the scaleX that fits it to the glyphs under it.
//
// ── Undo ──────────────────────────────────────────────────────────────────
//
// Every highlight made here goes on the pen's undo ring (pushAction in
// src/render/ink-engine.js), so the bar's ↶ and Ctrl+Z take it back in order
// with the ink drawn beside it. This module cannot import pdf-ink.js — that
// file imports pdf-region.js, which imports this — so pdf-ink hands its
// pushInkHistoryAction in at start-up (setSmartHlUndoSink).

import { wordSpanAtChar } from "../core/word-bounds.js?v=__BUILD__";
import { inkFilingColor } from "../format/ink-colors.js?v=__BUILD__";
import { closeMarkMenu } from "../notes/mark-menu.js?v=__BUILD__";
import {
  addDocumentHighlight, documentHighlightById, documentHighlightNote, documentHighlightsCovering,
  flashDocumentHighlight, recolourDocumentHighlight, reinstateDocumentHighlight, removeDocumentHighlight,
  setDocumentHighlightNote
} from "./pdf-highlights.js?v=__BUILD__";
import {
  TEXT_ITEM_ATTR, captureDocumentRange, mergeQuads, pageNumberForRect, quadToPageBox, rectToPdfQuad, textItemBox
} from "./pdf-selection.js?v=__BUILD__";
import { pdfMarkLayer, pdfPageElement, pdfPageTextItems, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const SMART_HL_PREVIEW_CLASS = "pdf-smart-preview-band";

// How far off a word a press may land and still be ON it — wider for a finger,
// whose contact point is a guess, than for a mouse or a nib, which are exact.
export const SMART_HL_PRESS_SLOP = { x: 3, y: 2 };
export const SMART_HL_PRESS_SLOP_TOUCH = { x: 6, y: 4 };

// Two spans on one line are one run of prose if the gap between them is no
// wider than this many line heights — an ordinary word space, or the gap pdf.js
// leaves between two runs of one sentence. A two-column gutter is far wider,
// so a press in the gutter is not "on words".
const SMART_HL_LINE_GAP = 1.5;

// The stylus rule — see smartHlClaimInkStroke for what each is for.
const SMART_HL_SAMPLE_STEP = 2;
const SMART_HL_ON_TEXT_RATIO = 0.6;
const SMART_HL_V_SLACK = 0.25;
const SMART_HL_H_SLACK = 0.6;
const SMART_HL_MAX_SPREAD = 1.25;

let smartHlUndoSink = () => {};

export function setSmartHlUndoSink(fn) {
  smartHlUndoSink = typeof fn === "function" ? fn : () => {};
}

// Whether a page has words at all: true, false, or null when its text layer
// has not been built yet (a page still rendering) — which callers treat as "no
// words", because a press cannot wait for it. OCR'd scans carry an invisible
// text layer and count as text, which is right: their words can be had.
export function smartHlPageHasText(page) {
  const items = pdfPageTextItems(page);
  if (!items) return null;
  return items.some((item) => typeof item?.str === "string" && item.str.trim() !== "");
}

// ── The spans of a page, measured ─────────────────────────────────────────

// Every text span on the page with its box in CLIENT coordinates, measured
// now. Not cached across presses: the layer's --pdf-span-scale lands a frame
// after the layer is built, and a page scrolls between one press and the next.
// A rotated span is left out — a vertical run of text has no left-to-right to
// snap along, and the boxes below assume one.
export function smartHlSpans(page) {
  const pageEl = pdfPageElement(page);
  if (!pageEl) return [];
  const spans = [];
  pageEl.querySelectorAll(`[${TEXT_ITEM_ATTR}]`).forEach((span) => {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue) return;
    if (/rotate\(/.test(span.style.transform || "")) return;
    const box = span.getBoundingClientRect();
    if (box.width < 0.5 || box.height < 0.5) return;
    spans.push({ span, node, left: box.left, right: box.right, top: box.top, bottom: box.bottom, h: box.height });
  });
  return spans;
}

// One Range, reused for every character measured — made on first use rather
// than at import, so nothing about loading this file needs a document.
let smartHlCharRange = null;

function smartHlCharBox(node, index) {
  if (!smartHlCharRange) smartHlCharRange = document.createRange();
  smartHlCharRange.setStart(node, index);
  smartHlCharRange.setEnd(node, index + 1);
  return smartHlCharRange.getBoundingClientRect();
}

// The character of one span under x — clamped to the first or last when x is
// past either end. A binary search over the characters' own boxes, which run
// left to right; a span whose last character sits LEFT of its first is
// right-to-left text and is searched one character at a time instead.
function smartHlCharAt(entry, x) {
  const { node } = entry;
  const n = node.nodeValue.length;
  if (n === 1) {
    const box = smartHlCharBox(node, 0);
    return { index: 0, after: x > (box.left + box.right) / 2 };
  }
  const first = smartHlCharBox(node, 0);
  const last = smartHlCharBox(node, n - 1);
  if (last.left + 0.5 < first.left) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i += 1) {
      const box = smartHlCharBox(node, i);
      const distance = x < box.left ? box.left - x : (x > box.right ? x - box.right : 0);
      if (distance < bestDistance) { best = i; bestDistance = distance; }
    }
    const box = smartHlCharBox(node, best);
    return { index: best, after: x < (box.left + box.right) / 2 };
  }
  if (x <= first.left) return { index: 0, after: false };
  if (x >= last.right) return { index: n - 1, after: true };
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (smartHlCharBox(node, mid).right <= x) lo = mid + 1;
    else hi = mid;
  }
  const box = smartHlCharBox(node, lo);
  return { index: lo, after: x > (box.left + box.right) / 2 };
}

function smartHlPosition(page, entry, x) {
  const { index, after } = smartHlCharAt(entry, x);
  return { page, span: entry.span, node: entry.node, index, after };
}

// The character under a point on a page, or null.
//
// STRICT is the question a press asks — "did this land on words?" — and it is
// asked tightly: inside a span's box grown by `slop`, or in the gap between two
// spans of one line no wider than SMART_HL_LINE_GAP line heights (a word space
// that pdf.js split two items across). Anything else is not on words, and the
// press draws a box instead.
//
// LOOSE is the question the moving end of a drag asks, and a stylus's ends:
// "which character is this nearest?" — the line nearest the point, the span on
// that line nearest it, the character nearest within that.
export function smartHlCaretAt(page, clientX, clientY, { strict = false, slop = SMART_HL_PRESS_SLOP, spans = null } = {}) {
  const list = spans || smartHlSpans(page);
  if (!list.length) return null;
  if (strict) {
    let hit = null;
    let hitDistance = Infinity;
    list.forEach((entry) => {
      if (clientX < entry.left - slop.x || clientX > entry.right + slop.x) return;
      if (clientY < entry.top - slop.y || clientY > entry.bottom + slop.y) return;
      const cx = (entry.left + entry.right) / 2;
      const cy = (entry.top + entry.bottom) / 2;
      const distance = Math.hypot((clientX - cx) / Math.max(1, entry.right - entry.left), clientY - cy);
      if (distance < hitDistance) { hit = entry; hitDistance = distance; }
    });
    if (hit) return smartHlPosition(page, hit, clientX);
    // Between two spans of one line.
    const onLine = list.filter((entry) => clientY >= entry.top - slop.y && clientY <= entry.bottom + slop.y);
    let before = null;
    let after = null;
    onLine.forEach((entry) => {
      if (entry.right <= clientX && (!before || entry.right > before.right)) before = entry;
      if (entry.left >= clientX && (!after || entry.left < after.left)) after = entry;
    });
    if (before && after && after.left - before.right <= SMART_HL_LINE_GAP * Math.max(before.h, after.h)) {
      return smartHlPosition(page, after, after.left);
    }
    return null;
  }
  // Loose: the nearest line first, so a point a little above or below a line
  // still means that line rather than whichever span is closest diagonally.
  let line = list.filter((entry) => clientY >= entry.top && clientY <= entry.bottom);
  if (!line.length) {
    let nearest = null;
    let nearestDistance = Infinity;
    list.forEach((entry) => {
      const distance = clientY < entry.top ? entry.top - clientY : clientY - entry.bottom;
      if (distance < nearestDistance) { nearest = entry; nearestDistance = distance; }
    });
    const mid = (nearest.top + nearest.bottom) / 2;
    line = list.filter((entry) => Math.abs((entry.top + entry.bottom) / 2 - mid) <= nearest.h / 2);
  }
  let best = null;
  let bestDistance = Infinity;
  line.forEach((entry) => {
    const distance = clientX < entry.left ? entry.left - clientX : (clientX > entry.right ? clientX - entry.right : 0);
    if (distance < bestDistance) { best = entry; bestDistance = distance; }
  });
  return best ? smartHlPosition(page, best, clientX) : null;
}

// ── From two characters to a run of whole words ───────────────────────────

function smartHlBefore(a, b) {
  if (a.node === b.node) return a.index < b.index || (a.index === b.index && !a.after);
  return Boolean(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

const SMART_HL_SPACE = /\s/;

// Where a run starting at this character really starts: the start of its word,
// or — on a space — the next character that is not one.
function smartHlStartOffset(node, index) {
  const text = node.nodeValue || "";
  let at = index;
  while (at < text.length && SMART_HL_SPACE.test(text[at])) at += 1;
  if (at >= text.length) return text.length;
  const word = wordSpanAtChar(text, at);
  return word ? word.start : at;
}

// ...and where one ending at this character really ends: the end of its word,
// just past a mark of punctuation, or — on a space — just after the last
// character that was not one.
function smartHlEndOffset(node, index) {
  const text = node.nodeValue || "";
  let at = Math.min(index, text.length - 1);
  while (at >= 0 && SMART_HL_SPACE.test(text[at])) at -= 1;
  if (at < 0) return 0;
  const word = wordSpanAtChar(text, at);
  return word ? word.end : at + 1;
}

// A Range over whole words from one character to another, in reading order
// whichever way the drag went. Null when there is nothing in it but space.
export function smartHlRangeBetween(a, b) {
  if (!a || !b) return null;
  const [from, to] = smartHlBefore(a, b) ? [a, b] : [b, a];
  const range = document.createRange();
  try {
    range.setStart(from.node, smartHlStartOffset(from.node, from.index));
    range.setEnd(to.node, smartHlEndOffset(to.node, to.index));
  } catch (_) {
    return null;
  }
  if (range.collapsed || !range.toString().trim()) return null;
  return range;
}

// What addDocumentHighlight takes, and the rects the covering test reads.
export function smartHlCapture(range) {
  const capture = captureDocumentRange(range);
  if (!capture) return null;
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width >= 0.5 && rect.height >= 0.5);
  return { capture, rects };
}

// ── The preview ───────────────────────────────────────────────────────────
//
// What a drag WILL highlight, drawn while it is under way: the same quads, in
// the same colour, through the same conversion the stored record will go
// through — so what is shown is exactly what lands. In the mark layer, under
// the words, as a highlight is; but not as a .pdf-mark, which other code
// queries. Not the native selection either: setting one would raise the
// selection bar at every frame of the drag.
export function smartHlPaintPreview(range, color, pages) {
  smartHlClearPreview();
  if (!range) return;
  const quads = [];
  Array.from(range.getClientRects()).forEach((rect) => {
    if (rect.width < 0.5 || rect.height < 0.5) return;
    const page = pageNumberForRect(rect, pages[0], pages[pages.length - 1]);
    const quad = page ? rectToPdfQuad(rect, page) : null;
    if (quad) quads.push(quad);
  });
  mergeQuads(quads).forEach((quad) => {
    const layer = pdfMarkLayer(quad.page);
    const box = quadToPageBox(quad);
    if (!layer || !box) return;
    const band = document.createElement("div");
    band.className = SMART_HL_PREVIEW_CLASS;
    band.dataset.color = color;
    band.style.left = `${box.left}px`;
    band.style.top = `${box.top}px`;
    band.style.width = `${box.width}px`;
    band.style.height = `${box.height}px`;
    layer.appendChild(band);
  });
}

export function smartHlClearPreview() {
  document.querySelectorAll(`.${SMART_HL_PREVIEW_CLASS}`).forEach((band) => band.remove());
}

// ── Making the highlight ──────────────────────────────────────────────────

// Taken back by the pen's ↶, and put back by its ↷ — the same id, colour,
// anchors and note. A note written on the highlight in between is kept too:
// the record and the note are read at the moment of the undo, not the moment
// of the highlight.
export function smartHlRememberAdd(record) {
  if (!record?.id) return;
  let kept = record;
  let note = "";
  smartHlUndoSink({
    undo: () => {
      const live = documentHighlightById(kept.id);
      if (!live) return false;
      kept = live;
      note = documentHighlightNote(kept.id);
      closeMarkMenu();
      removeDocumentHighlight(kept.id, { undo: false });
      return true;
    },
    redo: () => {
      if (documentHighlightById(kept.id)) return false;
      if (!reinstateDocumentHighlight(kept)) return false;
      if (note) setDocumentHighlightNote(kept.id, note, { undo: false });
      return true;
    }
  });
}

// The words a drag or a sweep ran along, highlighted — by the selection bar's
// own rule (applyPillHighlight, src/format/selection-tools.js): words that are
// ALL highlighted already are recoloured rather than highlighted twice, and a
// run that adds anything new is a new highlight. Words already wearing this
// very colour are left as they are, with a flash to say so.
export function smartHlApply(capture, rects, color) {
  if (!capture) return { kind: "none", id: null };
  const covering = documentHighlightsCovering(rects, { textOnly: true });
  if (covering.length) {
    if (covering.every((record) => record.color === color)) {
      flashDocumentHighlight(covering[0].id);
      return { kind: "none", id: covering[0].id };
    }
    const before = covering.map((record) => ({ id: record.id, color: record.color }));
    before.forEach(({ id }) => recolourDocumentHighlight(id, color));
    smartHlUndoSink({
      undo: () => {
        let changed = false;
        before.forEach(({ id, color: was }) => {
          if (!documentHighlightById(id)) return;
          recolourDocumentHighlight(id, was);
          changed = true;
        });
        return changed;
      },
      redo: () => {
        let changed = false;
        before.forEach(({ id }) => {
          if (!documentHighlightById(id)) return;
          recolourDocumentHighlight(id, color);
          changed = true;
        });
        return changed;
      }
    });
    return { kind: "recolour", id: covering[0].id };
  }
  const record = addDocumentHighlight(capture, color);
  if (!record) return { kind: "none", id: null };
  smartHlRememberAdd(record);
  return { kind: "add", id: record.id };
}

// ── The stylus ────────────────────────────────────────────────────────────
//
// A highlighter sweep, offered here before it is committed as ink (claimStroke
// in src/render/ink-engine.js). It becomes a text highlight only when it is
// unmistakably a sweep ALONG ONE LINE OF WORDS:
//
//   1. the page has words;
//   2. resampled every SMART_HL_SAMPLE_STEP points, at least
//      SMART_HL_ON_TEXT_RATIO of the samples lie on text — inside a text item's
//      box grown by SMART_HL_H_SLACK line heights either side and
//      SMART_HL_V_SLACK above and below;
//   3. those samples are on ONE line — grouped by baseline, the largest group
//      holds that share on its own;
//   4. the stroke is no taller than SMART_HL_MAX_SPREAD line heights.
//
// So a circle round a paragraph, a loop round a word, a diagonal across two
// lines, a bar in the margin and a sweep half over a figure all stay bands —
// each of those is a drawing, and turning it into a highlight of some words
// would be the app deciding it knew better. A scrub back and forth along one
// line, or a sweep that underlines the words rather than covering them, means
// "these words", and becomes them.
//
// Anything that fails, or throws, keeps the band: the reader's stroke is never
// lost to this.
function smartHlResample(points, step) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 3) out.push({ x: points[i], y: points[i + 1] });
  if (out.length < 2) return out;
  const samples = [out[0]];
  let carry = 0;
  for (let i = 1; i < out.length; i += 1) {
    const a = out[i - 1];
    const b = out[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let at = step - carry;
    while (at <= length) {
      const t = at / length;
      samples.push({ x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t) });
      at += step;
    }
    carry = length - (at - step);
  }
  samples.push(out[out.length - 1]);
  return samples;
}

export function smartHlClaimInkStroke(page, { points, token } = {}) {
  if (smartHlPageHasText(page) !== true) return false;
  if (!Array.isArray(points) || points.length < 6) return false;
  const viewport = pdfPageViewport(page);
  const pageEl = pdfPageElement(page);
  if (!viewport || !pageEl) return false;

  const raw = [];
  for (let i = 0; i + 1 < points.length; i += 3) raw.push({ x: points[i], y: points[i + 1] });
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  raw.forEach(({ x, y }) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });

  // The page's unrotated words near the stroke, each with its box in PDF space.
  const boxes = [];
  (pdfPageTextItems(page) || []).forEach((item) => {
    if (typeof item?.str !== "string" || !item.str.trim() || !Array.isArray(item.transform)) return;
    const t = item.transform;
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3) return;
    const h = item.height || Math.hypot(t[2], t[3]) || 0;
    if (h <= 0) return;
    const box = textItemBox(item);
    if (box.x1 < minX - (2 * h) || box.x0 > maxX + (2 * h) || box.y1 < minY - (2 * h) || box.y0 > maxY + (2 * h)) return;
    boxes.push({ box, h, base: t[5] });
  });
  if (!boxes.length) return false;

  const samples = smartHlResample(points, SMART_HL_SAMPLE_STEP);
  if (samples.length < 3) return false;
  const groups = [];
  samples.forEach((sample) => {
    const hit = boxes.find(({ box, h }) => sample.x >= box.x0 - (SMART_HL_H_SLACK * h) && sample.x <= box.x1 + (SMART_HL_H_SLACK * h)
      && sample.y >= box.y0 - (SMART_HL_V_SLACK * h) && sample.y <= box.y1 + (SMART_HL_V_SLACK * h));
    if (!hit) return;
    let group = groups.find((entry) => Math.abs(entry.base - hit.base) <= 0.5 * hit.h);
    if (!group) { group = { base: hit.base, samples: [], hits: [] }; groups.push(group); }
    group.samples.push(sample);
    group.hits.push(hit);
  });
  if (!groups.length) return false;
  const line = groups.reduce((best, group) => (group.samples.length > best.samples.length ? group : best));
  if (line.samples.length < SMART_HL_ON_TEXT_RATIO * samples.length) return false;
  const heights = line.hits.map((hit) => hit.h).sort((a, b) => a - b);
  const h = heights[heights.length >> 1];
  if (maxY - minY > SMART_HL_MAX_SPREAD * h) return false;

  // The line's own vertical extent, and its two ends along the sweep — each
  // clamped into the item it was over, so a sweep that ran a little past the
  // last word ends ON the last word.
  const lineTop = Math.max(...line.hits.map((hit) => hit.box.y1));
  const lineBottom = Math.min(...line.hits.map((hit) => hit.box.y0));
  const midY = (lineTop + lineBottom) / 2;
  let first = 0;
  let last = 0;
  line.samples.forEach((sample, i) => {
    if (sample.x < line.samples[first].x) first = i;
    if (sample.x > line.samples[last].x) last = i;
  });
  const clampInto = (i) => {
    const { box } = line.hits[i];
    return Math.min(box.x1 - 0.5, Math.max(box.x0 + 0.5, line.samples[i].x));
  };
  const pageBox = pageEl.getBoundingClientRect();
  const toClient = (x) => {
    const [vx, vy] = viewport.convertToViewportPoint(x, midY);
    return { x: pageBox.left + vx, y: pageBox.top + vy };
  };
  const spans = smartHlSpans(page);
  const startPoint = toClient(clampInto(first));
  const endPoint = toClient(clampInto(last));
  const a = smartHlCaretAt(page, startPoint.x, startPoint.y, { spans });
  const b = smartHlCaretAt(page, endPoint.x, endPoint.y, { spans });
  const range = smartHlRangeBetween(a, b);
  if (!range) return false;
  const made = smartHlCapture(range);
  if (!made) return false;
  // A last look at what the Range actually covers: one line, on this page. A
  // multi-column page can order its text so that "from here to there" in the
  // document is not "from here to there" on the glass, and a highlight that
  // wandered onto another line is worse than the band the reader drew.
  const sane = made.capture.quads.every((quad) => quad.page === page
    && Math.abs(((quad.rect[1] + quad.rect[3]) / 2) - midY) <= 0.6 * h);
  if (!sane) return false;
  smartHlApply(made.capture, made.rects, inkFilingColor(token));
  return true;
}
