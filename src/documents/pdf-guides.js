// Guides and the grid: what a box being dragged on a page settles onto.
//
// The geometry is src/render/snap-guides.js; this is where it meets the page.
// A block dragged or resized (src/documents/pdf-blocks.js), a shape moved or
// its box resized (pdf-shapes.js), several things moved together
// (canvas-selection.js) — each asks, on every frame of its drag, where what it
// is moving should be, and gets back the same thing a little moved: onto the
// edge or the middle of the nearest box within a few pixels, and — on a
// Canvas's grid paper, near nothing — onto the squares. A thin line over the
// page says what it lined up with, and goes when the drag does.
//
// Alt held skips it for one drag; ⋯ → Snap to guides and grid turns it off
// until it is turned back on (diagramSnapPreference, src/storage/ink-prefs.js).
// The arrow keys never snap: a nudge is a point, exactly.

import { setBlockGestureAdjuster } from "./pdf-blocks.js?v=__BUILD__";
import { setShapeMoveAdjuster } from "./pdf-shapes.js?v=__BUILD__";
import { setPickedMoveAdjuster } from "./canvas-selection.js?v=__BUILD__";
import { diagramNodes } from "./pdf-connectors.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { notebookPaper } from "./notebook.js?v=__BUILD__";
import { CANVAS_GRID_PITCH } from "./blank-pdf.js?v=__BUILD__";
import { pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { clearDiagramPart, diagramSvg, diagramSvgNode, setDiagramPart } from "./pdf-diagram-layer.js?v=__BUILD__";
import { diagramSnapPreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { normalizeShape, rectFromPoints, shapeBounds, translateShape } from "../render/annot-shapes.js?v=__BUILD__";
import { edgesForHandle, snapEdges, snapMove } from "../render/snap-guides.js?v=__BUILD__";

// How near, on screen, an edge has to come to another to settle onto it.
export const SNAP_REACH_PX = 6;

const GUIDE_BOX_TYPES = new Set(["rect", "ellipse", "text", "callout"]);

function snapping(event) {
  return diagramSnapPreference() && !event?.altKey;
}

// The squares, on a Canvas ruled in them; nothing on a PDF or other paper.
function gridForPage() {
  if (activeDocSlot() !== DOC_SLOT_NOTEBOOK || notebookPaper() !== "grid") return null;
  return { pitch: CANVAS_GRID_PITCH, origin: [0, 0] };
}

// Every box on the page but the ones being moved, as rects.
function othersOn(page, moving) {
  return [...diagramNodes(page).values()].filter((node) => !moving.has(node.id)).map((node) => node.rect);
}

function drawGuides(page, guides, viewport) {
  if (!guides.length || !viewport) { clearDiagramPart("guides"); return; }
  const svg = diagramSvg(viewport, "pdf-guides");
  guides.forEach((guide) => {
    const a = guide.axis === "x" ? [guide.at, guide.from] : [guide.from, guide.at];
    const b = guide.axis === "x" ? [guide.at, guide.to] : [guide.to, guide.at];
    const [x1, y1] = viewport.convertToViewportPoint(a[0], a[1]);
    const [x2, y2] = viewport.convertToViewportPoint(b[0], b[1]);
    svg.appendChild(diagramSvgNode("line", { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), class: "pdf-guide" }));
  });
  clearDiagramPart("guides");
  setDiagramPart(page, "guides", [svg]);
}

function reachOn(viewport) {
  return SNAP_REACH_PX / (viewport?.scale || 1);
}

// ── A block ───────────────────────────────────────────────────────────────
function adjustBlock(info) {
  if (!info) { clearDiagramPart("guides"); return null; }
  const { page, id, mode, edge, live, event, viewport, keepRatio, widthOnly } = info;
  if (!snapping(event) || keepRatio) { clearDiagramPart("guides"); return null; }
  const rect = [live.x, live.y, live.x + live.w, live.y + live.h];
  const others = othersOn(page, new Set([id]));
  const options = { threshold: reachOn(viewport), grid: gridForPage() };
  if (mode === "drag") {
    const snapped = snapMove(rect, others, options);
    drawGuides(page, snapped.guides, viewport);
    return { ...live, x: live.x + snapped.dx, y: live.y + snapped.dy };
  }
  const edges = edgesForHandle(edge);
  // The words set a fitted block's height: only its sides are the reader's.
  if (widthOnly) edges[1] = null;
  const snapped = snapEdges(rect, edges, others, options);
  drawGuides(page, snapped.guides, viewport);
  const [x0, y0, x1, y1] = snapped.rect;
  return { ...live, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ── A shape ───────────────────────────────────────────────────────────────
function adjustShape(info) {
  if (!info) { clearDiagramPart("guides"); return null; }
  const { page, id, mode, handle, shape, event } = info;
  const s = normalizeShape(shape);
  const viewport = pdfPageViewport(page);
  if (!s || !viewport || !snapping(event)) { clearDiagramPart("guides"); return null; }
  const box = GUIDE_BOX_TYPES.has(s.type) && !s.rot;
  const options = { threshold: reachOn(viewport), grid: gridForPage() };
  const others = othersOn(page, new Set([id]));
  if (mode === "move") {
    const rect = box ? rectFromPoints(s.p[0], s.p[1]) : shapeBounds(s);
    if (!rect) return null;
    const snapped = snapMove(rect, others, options);
    drawGuides(page, snapped.guides, viewport);
    return translateShape(s, snapped.dx, snapped.dy);
  }
  if (mode === "handle" && box && /^(n|ne|e|se|s|sw|w|nw)$/.test(handle || "")) {
    const snapped = snapEdges(rectFromPoints(s.p[0], s.p[1]), edgesForHandle(handle), others, options);
    drawGuides(page, snapped.guides, viewport);
    const [x0, y0, x1, y1] = snapped.rect;
    return { ...s, p: [[x0, y0], [x1, y1], ...s.p.slice(2)] };
  }
  clearDiagramPart("guides");
  return null;
}

// ── Several moved together ────────────────────────────────────────────────
function adjustPicked(info) {
  if (!info) { clearDiagramPart("guides"); return null; }
  const { page, ids, box, dx, dy, event, viewport } = info;
  if (!snapping(event)) { clearDiagramPart("guides"); return null; }
  const rect = [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
  const snapped = snapMove(rect, othersOn(page, new Set(ids)), { threshold: reachOn(viewport), grid: gridForPage() });
  drawGuides(page, snapped.guides, viewport);
  return { dx: dx + snapped.dx, dy: dy + snapped.dy };
}

export function initGuides() {
  setBlockGestureAdjuster(adjustBlock);
  setShapeMoveAdjuster(adjustShape);
  setPickedMoveAdjuster(adjustPicked);
}
