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
