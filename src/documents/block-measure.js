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
// "balanced" lays a paragraph out in a box near 3:2 instead — wider as there
// are more words, by their square root rather than by the length of a line —
// and then draws the box in to its widest line. A line that fits keeps its
// own width under either rule. See blockNaturalWidth in ./pdf-blocks.js.
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

// A first guess at a balanced width in points, from the words alone — for a
// Block put down before it can be measured (a paste, src/handwriting/board.js).
// `pointsPerChar` and `linePoints` are the Block's type, roughly.
export function balancedWidthGuess(text, { cap, min = 120, pointsPerChar = 5.6, linePoints = 18 } = {}) {
  const lines = String(text || "").split("\n");
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0) * pointsPerChar;
  if (!(longest > cap)) return Math.max(min, Math.min(cap, longest));
  const chars = lines.reduce((sum, line) => sum + line.length, 0);
  const area = chars * pointsPerChar * linePoints;
  return Math.round(Math.max(min, Math.min(cap, Math.sqrt(area * BALANCED_BLOCK_ASPECT))));
}
