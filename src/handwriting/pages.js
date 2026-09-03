// A page of paper, and what you can do to a stack of them.
//
// A LEAF, deliberately: it imports the stroke wire format and nothing else. Two
// very different surfaces are built on it — the drawing sheet that drops a
// picture into a note (src/notes/ink-sheet.js) and the notebook that IS a deck
// (src/handwriting/board.js) — and the thing they have to agree about is the
// paper, not each other. Keeping it a leaf is also what lets a Node check drive
// it with no browser, the same argument src/format/ink-strokes.js makes at
// greater length.
//
// ── Why a page has a fixed size in model units ─────────────────────────────
//
// The sheet used to draw in the CSS pixels of whatever host it happened to be
// laid out at, which had three consequences and all of them were bugs: a
// drawing made on a phone re-opened on a laptop was a small drawing in the
// middle of a large sheet; a window resized mid-drawing left the ink where the
// pixels used to be; and a drawing larger than the current host was silently
// clipped by `overflow: hidden`, because nothing else could be done with it.
//
// A page is 794 x 1123 — A4 at 96dpi — whatever it is being shown at. The
// surface scales it to fit and hands the engine that scale as its matrix, so the
// strokes stored are the strokes drawn, on every device and at every zoom. It is
// the same decision pdf-ink.js made for the same reason when it chose to store
// in PDF user space rather than in screen pixels.

import { decodeInkStrokes, encodeInkStrokes, inkStrokesBounds, transformInkStroke } from "../format/ink-strokes.js?v=__BUILD__";

// A4 at 96dpi, which is also what the print pipeline lays a page out at
// (installPdfPrintStyle), so an exported notebook page is 1:1 rather than
// rescaled.
export const HW_PAGE_WIDTH = 794;
export const HW_PAGE_HEIGHT = 1123;

// The three papers, and why there are three rather than one. Ruled lines suit
// writing and suit a diagram badly; blank suits a diagram and gives handwriting
// nothing to sit straight on; a grid is the compromise that gets in neither's
// way, which is why it is the default and why the drawing sheet has always used
// one. All three are drawn in CSS from the text colour at low alpha, so a paper
// works on all ten themes with no second definition.
export const HW_PAPERS = ["grid", "ruled", "blank"];
export const HW_PAPER_DEFAULT = "grid";

// Model units between two ruled lines, and between two grid lines. The ruled
// pitch is the one a hand actually writes at — a 10-12pt hand needs about 28
// units of clearance — and the grid is the sheet's existing 24.
export const HW_RULE_PITCH = 28;
export const HW_GRID_PITCH = 24;

// How much of the page a new text box takes, and the smallest it can be dragged
// to. A box smaller than this cannot show a line of text and cannot be grabbed.
export const HW_BOX_MIN_WIDTH = 120;
export const HW_BOX_MIN_HEIGHT = 44;

export function normalizeHandwritingPaper(kind) {
  return HW_PAPERS.includes(kind) ? kind : HW_PAPER_DEFAULT;
}

// Ids are minted the same shape the highlight ids are, and for the same reason:
// they are compared and never parsed. `taken` is whatever set of ids the caller
// already holds, so a page and a box minted in the same tick cannot collide.
export function freshHandwritingId(prefix, taken = null) {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!taken || !taken.has(id)) return id;
  }
}

export function makeHandwritingPage({ kind = HW_PAPER_DEFAULT, taken = null } = {}) {
  return {
    id: freshHandwritingId("hp", taken),
    w: HW_PAGE_WIDTH,
    h: HW_PAGE_HEIGHT,
    paper: normalizeHandwritingPaper(kind),
    ink: [],
    at: Date.now()
  };
}

// Every page a deck's meta carries, in reading order, with anything malformed
// dropped rather than half-read — the rule decodeInkStroke keeps for a stroke,
// kept here for the record around it. A record with no id is not a page: it is
// something that got into the bag, and it has nowhere to be filed.
export function readHandwritingPages(meta) {
  const list = Array.isArray(meta?.pages) ? meta.pages : [];
  return list
    .filter((page) => page && typeof page === "object" && page.id)
    .map((page, index) => ({
      id: String(page.id),
      order: Number.isFinite(Number(page.order)) ? Number(page.order) : index,
      w: Number(page.w) > 0 ? Number(page.w) : HW_PAGE_WIDTH,
      h: Number(page.h) > 0 ? Number(page.h) : HW_PAGE_HEIGHT,
      paper: normalizeHandwritingPaper(page.paper),
      ink: Array.isArray(page.ink) ? page.ink.filter((s) => typeof s === "string") : [],
      at: Number(page.at) || 0
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((page, index) => ({ ...page, order: index }));
}

export function readHandwritingBoxes(meta) {
  const list = Array.isArray(meta?.textBoxes) ? meta.textBoxes : [];
  return list
    .filter((box) => box && typeof box === "object" && box.id && box.page)
    .map((box) => ({
      id: String(box.id),
      page: String(box.page),
      x: Number(box.x) || 0,
      y: Number(box.y) || 0,
      w: Math.max(HW_BOX_MIN_WIDTH, Number(box.w) || HW_BOX_MIN_WIDTH),
      h: Math.max(HW_BOX_MIN_HEIGHT, Number(box.h) || HW_BOX_MIN_HEIGHT),
      z: Number(box.z) || 0,
      md: typeof box.md === "string" ? box.md : "",
      at: Number(box.at) || 0
    }));
}

// ── Editing the stack ──────────────────────────────────────────────────────
//
// All three return a NEW array and never mutate the one handed in, so a caller
// can compare the two to decide whether anything actually changed — which is
// what keeps an autosave from being scheduled for a press that did nothing.

export function addHandwritingPage(pages, { after = null, kind = null } = {}) {
  const taken = new Set(pages.map((page) => page.id));
  // A new page takes the paper of the one it follows rather than the default:
  // somebody who set a notebook to ruled meant the notebook, not that page.
  const previous = after ? pages.find((page) => page.id === after) : pages[pages.length - 1];
  const page = makeHandwritingPage({ kind: kind || previous?.paper || HW_PAPER_DEFAULT, taken });
  const at = after ? pages.findIndex((p) => p.id === after) : pages.length - 1;
  const next = pages.slice();
  next.splice(at < 0 ? pages.length : at + 1, 0, page);
  return { pages: next.map((p, index) => ({ ...p, order: index })), page };
}

export function removeHandwritingPage(pages, id) {
  const next = pages.filter((page) => page.id !== id);
  if (next.length === pages.length) return null;
  return next.map((page, index) => ({ ...page, order: index }));
}

export function moveHandwritingPage(pages, id, delta) {
  const from = pages.findIndex((page) => page.id === id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(pages.length - 1, from + delta));
  if (to === from) return null;
  const next = pages.slice();
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page);
  return next.map((p, index) => ({ ...p, order: index }));
}

// ── Ink on a page ──────────────────────────────────────────────────────────

export function handwritingPageStrokes(page) {
  return decodeInkStrokes(page?.ink);
}

export function handwritingPageWithStrokes(page, strokes) {
  return { ...page, ink: encodeInkStrokes(strokes), at: Date.now() };
}

// Put a drawing made in some other coordinate space onto a page.
//
// Every drawing made before pages existed is in the CSS pixels of the device
// that drew it, and an SVG's own viewBox is only ever the bounding box of what
// is in it — so "what units is this in" has no answer and the honest thing to do
// is fit it. Uniform scale, and never UP: a small deliberate sketch blown up to
// fill A4 is not what anybody drew. Centred horizontally and parked at the top,
// because a re-opened drawing is usually about to be added to.
export function fitHandwritingStrokesToPage(strokes, page, { margin = 32 } = {}) {
  const list = Array.isArray(strokes) ? strokes : [];
  if (!list.length) return [];
  const box = inkStrokesBounds(list);
  if (!box) return list;
  const width = Math.max(1e-3, box.maxX - box.minX);
  const height = Math.max(1e-3, box.maxY - box.minY);
  const room = { w: (page.w || HW_PAGE_WIDTH) - (margin * 2), h: (page.h || HW_PAGE_HEIGHT) - (margin * 2) };
  const scale = Math.min(1, room.w / width, room.h / height);
  // The transform is applied about the drawing's own top-left, so the two steps
  // are a translate to the origin, the scale, and a translate to where it goes.
  const placedX = margin + Math.max(0, (room.w - (width * scale)) / 2);
  // One transform, not two: transformInkStroke scales about (originX, originY)
  // and THEN adds the delta, so subtracting the origin out of the delta lands
  // the drawing's top-left exactly where it is wanted. Two calls would apply the
  // nib scaling twice.
  return list.map((stroke) => transformInkStroke(stroke, {
    scale,
    originX: box.minX,
    originY: box.minY,
    dx: placedX - box.minX,
    dy: margin - box.minY
  }));
}
