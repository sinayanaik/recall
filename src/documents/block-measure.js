// The widest a Block on a Canvas grows to by itself, as a share of the page's
// width — ◐ Canvas → Blocks → Widest a Block grows. Its own module, holding one
// number, so applyStyleSettings (src/ui/style-settings.js) can set it without
// importing the whole Block machinery; src/documents/pdf-blocks.js and the
// paste in src/handwriting/board.js read it.
//
// Why there is one at all: a Block that follows its words grows with its
// longest line, and a pasted paragraph IS one long line — it grew to the
// page's right edge, a strip across the whole page that had to be dragged
// narrower by hand every time.

export const CANVAS_BLOCK_MEASURE_DEFAULT = 62;

let measurePercent = CANVAS_BLOCK_MEASURE_DEFAULT;

// Anything that is not a percentage from 10 to 100 means the default ("auto",
// an empty box, a typo).
export function setCanvasBlockMeasure(value) {
  const percent = parseFloat(String(value ?? "").replace("%", ""));
  measurePercent = Number.isFinite(percent) && percent >= 10 && percent <= 100 ? percent : CANVAS_BLOCK_MEASURE_DEFAULT;
}

export function canvasBlockMeasurePercent() {
  return measurePercent;
}

// How a Block on a Canvas that follows its words takes its width once its
// words are longer than one line — ◐ Canvas → Blocks → Block width.
//
// "longest" is the rule this file began with: as wide as the longest line, up
// to the measure, so every paragraph came out a strip the measure wide.
// "balanced" wraps words longer than a comfortable line (BALANCED_MIN_LINE_EM)
// at that line, and lays more of them out in a box near 3:2 — wider as there
// are more words, by their square root rather than by the length of a line —
// then draws the box in to its widest line. A label shorter than that line
// keeps its own width. The same rule while a Block is typed in. See
// balancedWidthPx below, and blockNaturalWidth / blockTypingWidth in
// ./pdf-blocks.js.
export const CANVAS_BLOCK_WIDTH_BALANCED = "balanced";
export const CANVAS_BLOCK_WIDTH_LONGEST = "longest";

let widthRule = CANVAS_BLOCK_WIDTH_BALANCED;

export function setCanvasBlockWidthMode(value) {
  widthRule = String(value ?? "").trim().toLowerCase() === CANVAS_BLOCK_WIDTH_LONGEST
    ? CANVAS_BLOCK_WIDTH_LONGEST
    : CANVAS_BLOCK_WIDTH_BALANCED;
}

export function canvasBlockWidthMode() {
  return widthRule;
}

// The shape a balanced Block aims at, width over height.
export const BALANCED_BLOCK_ASPECT = 1.6;

// The shortest line a balanced Block wraps its words at, in ems of its own
// type — about 30 to 35 characters. A line shorter than this is a label and
// keeps its own width; words longer than it wrap at it.
//
// Why there is one: the balanced rule used to start only once a line ran past
// the measure, so a whole sentence just short of it was a strip as wide as the
// line — and one more word turned it into three short lines. With this floor
// the width is a continuous, never-shrinking function of how much is written:
// one line out to here, then wrapped at here while the lines pile up, then
// widening with the square root of the words, up to the measure. Typed, the
// width hardly moves, so lines are not rewrapped under the caret.
export const BALANCED_MIN_LINE_EM = 16;

// The balanced width of an element's words, in its own CSS pixels — the one
// rule both a Block's rendered words (blockNaturalWidth in ./pdf-blocks.js)
// and the words being typed in one (src/documents/pdf-block-inline.js) are
// laid out by, so the box typed in is the box put down.
//
// One line no longer than `minLinePx` keeps its width. Otherwise the narrowest
// width from `minLinePx` (never under the longest word) to `capPx` at which
// the words are at least `aspect` times as wide as they are tall, found by
// laying them out — a list, a heading or a hard line break is measured as it
// is, not guessed from a count of characters. The element's inline width,
// height and flex are put back. `single` is returned too: the width of the
// words unwrapped, so a caller can tell a wrapped Block from a one-line one.
export function balancedWidthPx(el, { capPx, minLinePx, aspect = BALANCED_BLOCK_ASPECT } = {}) {
  const saved = { width: el.style.width, height: el.style.height, flex: el.style.flex };
  el.style.flex = "none";
  el.style.height = "auto";
  const widthAt = (value) => { el.style.width = typeof value === "number" ? `${value}px` : value; };
  try {
    widthAt("max-content");
    const single = el.scrollWidth;
    widthAt("min-content");
    const least = el.scrollWidth;
    const cap = Math.max(1, capPx);
    if (single <= Math.min(minLinePx, cap)) return { width: single, single };
    let lo = Math.min(cap, Math.max(least, minLinePx));
    let hi = Math.max(lo, Math.min(cap, single));
    const wideEnough = (w) => { widthAt(w); return w >= aspect * el.scrollHeight; };
    if (wideEnough(lo)) return { width: Math.ceil(lo), single };
    if (!wideEnough(hi)) return { width: Math.ceil(hi), single };
    for (let i = 0; i < 12 && hi - lo > 0.5; i += 1) {
      const mid = (lo + hi) / 2;
      if (wideEnough(mid)) hi = mid; else lo = mid;
    }
    return { width: Math.ceil(hi), single };
  } finally {
    el.style.width = saved.width;
    el.style.height = saved.height;
    el.style.flex = saved.flex;
  }
}

// A first guess at a balanced width in points, from the words alone — for a
// Block put down before it can be measured (a paste, src/handwriting/board.js).
// `pointsPerChar` and `linePoints` are the Block's type, roughly: the same
// rule as balancedWidthPx, with the area counted instead of laid out.
export function balancedWidthGuess(text, { cap, min = 120, pointsPerChar = 5.6, linePoints = 18 } = {}) {
  const lines = String(text || "").split("\n");
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0) * pointsPerChar;
  // An average character is about half an em.
  const minLine = Math.min(cap, BALANCED_MIN_LINE_EM * pointsPerChar * 2);
  if (!(longest > minLine)) return Math.max(min, Math.min(cap, longest));
  const chars = lines.reduce((sum, line) => sum + line.length, 0);
  const area = chars * pointsPerChar * linePoints;
  const balanced = Math.max(minLine, Math.sqrt(area * BALANCED_BLOCK_ASPECT));
  return Math.round(Math.max(min, Math.min(cap, longest, balanced)));
}

// How wide a thing put on a Canvas from elsewhere lands, by its kind, as a
// percent of the page — ◐ Canvas → Blocks → Pictures land at / Tables and code
// land at. Words keep the measure above. Its size where it came from (a
// picture's width in the Notes, a site's own sizes) is taken off first
// (canvasSizedMarkdown, ./canvas-sizing.js), so this is what decides.
export const CANVAS_DROP_PICTURE_DEFAULT = 40;
export const CANVAS_DROP_WIDE_DEFAULT = 80;

let dropPicturePercent = CANVAS_DROP_PICTURE_DEFAULT;
let dropWidePercent = CANVAS_DROP_WIDE_DEFAULT;

function dropPercent(value, fallback) {
  const percent = parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(percent) && percent >= 5 && percent <= 100 ? percent : fallback;
}

export function setCanvasDropWidths({ picture, wide } = {}) {
  dropPicturePercent = dropPercent(picture, CANVAS_DROP_PICTURE_DEFAULT);
  dropWidePercent = dropPercent(wide, CANVAS_DROP_WIDE_DEFAULT);
}

// `kind` is canvasItemKind's: "picture", "code", "table", "diagram" or "text".
export function canvasDropWidthPercent(kind) {
  if (kind === "picture") return dropPicturePercent;
  if (kind === "code" || kind === "table" || kind === "diagram") return dropWidePercent;
  return measurePercent;
}
