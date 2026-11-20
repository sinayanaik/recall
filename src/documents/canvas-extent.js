// How far a Canvas page reaches, worked out from what is on it.
//
// Pure — numbers in, numbers out, no DOM and no state — so the same answers
// write the page's box (src/documents/notebook.js), let a drag go past an edge
// (src/documents/pdf-blocks.js, pdf-shapes.js, canvas-selection.js), cut a
// Boundless page's PDF to what is on it (src/documents/pdf-export.js), draw the
// page in the web page export, and are checked in Node
// (tools/canvas-extent-check.mjs).
//
// ── Three ways a page can be sized ────────────────────────────────────────
//
// Every page **grows as needed** ("grow", and what a page with no `fit` does):
// it is the size it is set up at, at least, and longer or wider when what is
// on it comes near its right edge or its foot — just enough room past it to
// keep going, never smaller than it was set up at. A page set to its size
// ("set": Grows as needed switched off) is that size, as every page once was.
// A **Boundless** page ("boundless") has no size: it is what is on it with room
// round it on every side, its own w × h only where it starts.
//
// ── Why nothing on a page moves when it grows ─────────────────────────────
//
// Everything on a page is stored in the page's PDF user space, and a page's
// box is only a window onto that space (src/documents/canvas-setup.js). A page
// that grows has the same top-left corner, (0, 842), and a box reaching further
// right or down; a Boundless page's box can reach left of 0 and above 842 too —
// negative numbers are as good a place as any, the way a PDF's margins already
// grow its pages outward (src/documents/pdf-margins-core.js). Not one stored
// coordinate changes.
//
// ── Why the box is worked out, not kept ───────────────────────────────────
//
// The box is a function of what is on the page and the box it has now, so an
// undo that takes a Block back off the edge takes the room back too, and two
// devices that hold the same page reach the same box and draw the same bytes.
// The current box is an input only so the page does not change at every
// stroke: it grows once what is on it is closer than EXTENT_ROOM_MIN to its
// edge, by a whole EXTENT_STEP past EXTENT_ROOM, and shrinks only once there is
// more room than that — a hand writing down the last lines of a page rewrites
// it every few lines, not every line.

import { normalizeShapeRotation, rotatePoint, shapeBounds } from "../render/annot-shapes.js?v=__BUILD__";
import { CANVAS_SHEET_TOP, normalizeSheetSetup, sheetBox, sheetFit, sheetRound, sheetSetupForPage, validPageBox } from "./canvas-setup.js?v=__BUILD__";

// Clear paper kept past what is on a page that grows, in points: an inch.
export const EXTENT_ROOM = 72;
// ...and how close what is on it may come to the edge before it grows.
export const EXTENT_ROOM_MIN = 36;
// A Boundless page keeps more, on every side: room to keep drawing.
export const BOUNDLESS_ROOM = 144;
export const BOUNDLESS_ROOM_MIN = 72;
// The step every grown edge lands on, from the page's corner — an inch.
export const EXTENT_STEP = 72;
// The most a page reaches across or down: 200 inches, the largest page a PDF
// reader is held to show (and the largest the export can write).
export const EXTENT_MAX = 14400;
// Round what is on a Boundless page when its PDF is cut to it.
export const EXPORT_PAD = 24;

function finiteRect(rect) {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const n = rect.slice(0, 4).map(Number);
  if (!n.every(Number.isFinite)) return null;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

// Every rect joined into one, or null for none.
export function unionRects(rects) {
  let out = null;
  (rects || []).forEach((raw) => {
    const r = finiteRect(raw);
    if (!r) return;
    out = out ? [Math.min(out[0], r[0]), Math.min(out[1], r[1]), Math.max(out[2], r[2]), Math.max(out[3], r[3])] : r;
  });
  return out;
}

// A Block's box on its page, turned with it (`rot`, degrees counter-clockwise
// about its middle) — the box its corners reach.
export function blockBounds(block) {
  const x = Number(block?.x) || 0;
  const y = Number(block?.y) || 0;
  const w = Number(block?.w) || 0;
  const h = Number(block?.h) || 0;
  const rect = [x, y, x + w, y + h];
  const rot = normalizeShapeRotation(block?.rot);
  if (!rot) return rect;
  const centre = [x + w / 2, y + h / 2];
  const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map((p) => rotatePoint(p, centre, rot));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// A mark's box on its page: a shape's own bounds (a connector's route, a
// turned box's corners), else the quads it is filed under — a stroke's quad is
// the box round its handwriting.
export function markBounds(record) {
  if (record?.kind === "shape" && record.shape) {
    try {
      const box = shapeBounds(record.shape);
      if (box) return box;
    } catch (_) { /* the quads below */ }
  }
  return unionRects((Array.isArray(record?.quads) ? record.quads : []).map((quad) => quad?.rect));
}

// Every box on a page, from its marks and its Blocks.
export function pageContentRects(marks = [], blocks = []) {
  const out = [];
  (marks || []).forEach((record) => {
    const r = markBounds(record);
    if (r) out.push(r);
  });
  (blocks || []).forEach((block) => {
    if (block && Number(block.w) > 0 && Number(block.h) > 0) out.push(blockBounds(block));
  });
  return out;
}

// One edge, measured OUTWARD from the page (right: x; left: −x; top: y − 842;
// foot: 842 − y), from where it is set up to reach (`base`), where it reaches
// now (`current`), and how far out what is on the page goes (`content`, or
// null for nothing there).
function fittedEdge({ base, current, content, room, roomMin }) {
  const now = Math.max(base, Number.isFinite(current) ? current : base);
  if (content === null || !Number.isFinite(content)) return base;
  const target = Math.max(base, Math.ceil((content + room) / EXTENT_STEP) * EXTENT_STEP);
  if (now < content + roomMin) return target;
  // Shrinking: back to where it was set up once what is on it is clear of
  // that edge by as much as a page that has not grown needs; otherwise to
  // the room past what is on it.
  const least = content + roomMin <= base ? base : target;
  return now > least ? least : now;
}

// Two opposite edges held to EXTENT_MAX between them, taking the overrun off
// whichever has grown further past where it was set up.
function holdSpan(near, far, baseNear, baseFar) {
  let over = near + far - EXTENT_MAX;
  if (over <= 0) return [near, far];
  const grownNear = Math.max(0, near - baseNear);
  const grownFar = Math.max(0, far - baseFar);
  const cut = (value, room) => {
    const by = Math.min(over, room);
    over -= by;
    return value - by;
  };
  if (grownFar >= grownNear) {
    const f = cut(far, grownFar);
    return [cut(near, grownNear), f];
  }
  const n = cut(near, grownNear);
  return [n, cut(far, grownFar)];
}

// The box page `setup` reaches with `rects` on it, given the box it reaches
// now (`current`, or null for the size it is set up at). `past` asks only
// whether something is PAST an edge, not merely near it — for a change the
// reader did not make on the page (a new page setup), which must not grow a
// page because something was written close to its foot.
export function neededPageBox(setup, rects, current = null, { past = false } = {}) {
  const s = normalizeSheetSetup(setup);
  const base = sheetBox(s);
  const fit = sheetFit(s);
  if (fit === "set") return base;
  const content = unionRects(rects);
  const now = validPageBox(current) || base;
  const top = CANVAS_SHEET_TOP;
  if (fit === "grow") {
    // Right and down only: the corner where writing starts stays put.
    const roomMin = past ? 0 : EXTENT_ROOM_MIN;
    const right = fittedEdge({ base: base[2], current: now[2], content: content ? content[2] : null, room: EXTENT_ROOM, roomMin });
    const foot = fittedEdge({ base: top - base[1], current: top - now[1], content: content ? top - content[1] : null, room: EXTENT_ROOM, roomMin });
    return [base[0], sheetRound(top - Math.min(EXTENT_MAX, foot)), sheetRound(Math.min(base[0] + EXTENT_MAX, right)), top];
  }
  // Boundless: every side, from where it starts.
  const edge = (baseEdge, nowEdge, contentEdge) => fittedEdge({
    base: baseEdge, current: nowEdge, content: contentEdge, room: BOUNDLESS_ROOM, roomMin: past ? 0 : BOUNDLESS_ROOM_MIN
  });
  let right = edge(base[2], now[2], content ? content[2] : null);
  let left = edge(-base[0], -now[0], content ? -content[0] : null);
  let upper = edge(base[3] - top, now[3] - top, content ? content[3] - top : null);
  let foot = edge(top - base[1], top - now[1], content ? top - content[1] : null);
  [left, right] = holdSpan(left, right, -base[0], base[2]);
  [upper, foot] = holdSpan(upper, foot, base[3] - top, top - base[1]);
  return [sheetRound(-left), sheetRound(top - foot), sheetRound(right), sheetRound(top + upper)];
}

// The part of a page its PDF is: a Boundless page cut to what is on it (with a
// little room round it), or the page's starting size when nothing is; any
// other page whole.
export function exportPageBox(setup, box, rects) {
  const page = validPageBox(box) || sheetBox(normalizeSheetSetup(setup));
  if (sheetFit(setup) !== "boundless") return page;
  const content = unionRects(rects);
  if (!content) return sheetBox(normalizeSheetSetup(setup));
  const cut = [
    Math.max(page[0], content[0] - EXPORT_PAD),
    Math.max(page[1], content[1] - EXPORT_PAD),
    Math.min(page[2], content[2] + EXPORT_PAD),
    Math.min(page[3], content[3] + EXPORT_PAD)
  ];
  if (!(cut[2] - cut[0] >= 1) || !(cut[3] - cut[1] >= 1)) return page;
  return cut.map((v) => Math.round(v * 100) / 100);
}

// How far a drag may carry something on a page of this fit, as a box in the
// page's points: past the right edge and the foot on a page that grows (every
// page, unless set to its size); anywhere (up to EXTENT_MAX) on a Boundless
// page; the page itself on a page set to its size. The page grows to it once
// it is let go.
export function canvasDragLimits(fit, box) {
  const b = validPageBox(box);
  if (!b || fit === "set") return b;
  if (fit !== "boundless") return [b[0], b[3] - EXTENT_MAX, b[0] + EXTENT_MAX, b[3]];
  return [b[2] - EXTENT_MAX, b[3] - EXTENT_MAX, b[0] + EXTENT_MAX, b[1] + EXTENT_MAX];
}

// The same, for page `page` of a Canvas record (`meta.notebook`) — or `box`
// itself with no record: a PDF's pages never grow.
export function pageDragLimits(record, page, box) {
  if (!record) return validPageBox(box) || box;
  return canvasDragLimits(sheetFit(sheetSetupForPage(record, Number(page) || 1)), box) || box;
}

// Two boxes the same, to a hundredth of a point.
export function samePageBox(a, b) {
  const x = validPageBox(a);
  const y = validPageBox(b);
  if (!x || !y) return !x && !y;
  return x.every((v, i) => Math.abs(v - y[i]) < 0.01);
}
