// Connectors: lines and arrows that join the things on a page, and follow them.
//
// "Use blocks, connect the blocks — like draw.io." A diagram is boxes and the
// lines between them, and a line that stays where it was drawn when its box is
// moved is not a diagram, it is a drawing of one. So a line or an arrow (the
// Shapes tool's own, src/documents/pdf-shapes.js) can have its ends TIED: to a
// block (src/documents/pdf-blocks.js) or to a box drawn with the Shapes tool —
// a rectangle, an ellipse, a text box, a callout. Tied, an end sits on the
// outline of what it is tied to, wherever that goes.
//
// ── The tie is the truth; the points are a copy ───────────────────────────
//
// A connector is an ordinary shape record (src/render/annot-shapes.js says
// what it stores): `ends` say what each end is tied to and by which side, and
// `p` keeps where those ends were last worked out to be. Every renderer and
// export draws `p`, so all of them are right without knowing what a block is;
// a build that predates connectors still draws an arrow in the right place.
//
// Two things keep `p` true:
//   • the page DRAWS a connector from its ties, every paint — so it follows a
//     block being dragged this very frame (setShapeResolver);
//   • and after anything moves, the stored copy is brought up to date
//     (relinkConnectors), with no undo step — it is the record agreeing with
//     what it is tied to, not a change the reader made. Worked out the same way
//     on every device, so two of them cannot argue about it.
//
// A tied thing that is gone — deleted, or on another device not yet synced —
// leaves its end where it last was, still tied: an undo that brings the box
// back brings the line back onto it.
//
// ── Making one ────────────────────────────────────────────────────────────
//
//   • A box picked up wears four arrows, one off each side (draw.io's blue
//     ones). Dragged, an arrow draws a connector from that side to wherever it
//     is let go — tied to a box let go on, loose on bare paper. Tapped, it makes
//     a COPY of the box beside it, joined to it, and opens it to type in.
//   • The Shapes tool's line or arrow, drawn onto a box, ties to it; an end of
//     one already drawn, dragged onto a box, ties to it, and dragged off, comes
//     free. The box an end would tie to is lit while it is over it, with a dot
//     on each side: let go on a dot and that end keeps to that side.
//   • Alt held never ties anything.

import { clearDiagramPart, diagramLayer, diagramPathData, diagramSvg, diagramSvgNode, setDiagramPart } from "./pdf-diagram-layer.js?v=__BUILD__";
import {
  blockStyle, documentBlocks, editBlock, freshDocumentBlockId, isEditingBlock, isInDiagramEdit, liveBlockGesture, nextBlockZ,
  runDiagramEdit, selectBlock, selectedBlockId, setBlockGestureFrameHook, setBlocksPaintedHook, writeDocumentBlocks
} from "./pdf-blocks.js?v=__BUILD__";
import {
  SHAPE_ROTATE_HANDLE_GAP, documentShapes, editingShapeTextId, newConnectorBase, newShapeRecord, paintDocumentShapes, selectShape, selectedShapeRecord,
  setConnectorLabelEditor, setShapeBindingHooks, setShapeDeleteAllHandler, setShapeOverlayHook, setShapeResolver, updateShape, updateShapesQuietly
} from "./pdf-shapes.js?v=__BUILD__";
import { applyDocumentRecordChanges, documentHighlightById } from "./pdf-highlights.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { connectorLabelRect, normalizeShape, pathMidpoint, connectorPath, shapeBoxCorners, shapePrimitives, translateShape } from "../render/annot-shapes.js?v=__BUILD__";
import {
  NODE_SIDES, SIDE_VECTORS, distanceToOutline, oppositeSide, outlinePolygon, pointInOutline, polygonCentre, polygonPerimeterPoint,
  polygonSidePoint, sideFacing
} from "../render/node-outlines.js?v=__BUILD__";

// ── What a connector can be tied to ───────────────────────────────────────
//
// A NODE: { id, kind: "block" | "shape", rect, poly, z } in PDF space, where
// `poly` is its outline — a diamond's diamond, an ellipse's ellipse, a turned
// box turned — and `z` says which of two overlapping ones is on top (a block is
// always over a shape; see styles/53-handwriting.css).
const BOX_SHAPES = new Set(["rect", "ellipse", "text", "callout"]);

function nodeRectOf(points) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  points.forEach(([x, y]) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  });
  return [x0, y0, x1, y1];
}

export function blockNode(block) {
  const rect = [block.x, block.y, block.x + block.w, block.y + block.h];
  return { id: block.id, kind: "block", rect, poly: outlinePolygon(blockStyle(block).shape, rect), z: 1e6 + (Number(block.z) || 0) };
}

export function shapeNode(id, shape, z = 0) {
  const s = normalizeShape(shape);
  if (!s || !BOX_SHAPES.has(s.type)) return null;
  const poly = s.type === "ellipse"
    ? shapePrimitives(s).find((prim) => prim.kind === "poly" && prim.closed)?.pts
    : shapeBoxCorners(s);
  if (!poly?.length) return null;
  return { id, kind: "shape", rect: nodeRectOf(poly), poly, z };
}

// Where the things on the page are NOW: a block being dragged where the drag
// has it, a box shape being dragged where its preview is, and anything a group
// move (src/documents/canvas-selection.js) is carrying where it carries it.
let nodeOverrides = new Map();

export function setDiagramNodeOverrides(map) {
  nodeOverrides = map instanceof Map ? map : new Map();
}

export function diagramNodes(page, { preview = null } = {}) {
  const nodes = new Map();
  const live = liveBlockGesture();
  documentBlocks(page).forEach((block) => {
    const now = live && live.id === block.id ? live.block : (nodeOverrides.get(block.id)?.block || block);
    nodes.set(block.id, blockNode(now));
  });
  documentShapes(page).forEach((record, index) => {
    const shape = preview && preview.id === record.id ? preview.shape : (nodeOverrides.get(record.id)?.shape || record.shape);
    const node = shapeNode(record.id, shape, index);
    if (node) nodes.set(record.id, node);
  });
  return nodes;
}

// One look at the page per paint, not one per connector on it: a paint asks
// for every shape in turn, synchronously, and the answer cannot change inside
// it. Let go of as soon as the paint's task is over.
let nodeCache = null;

function cachedNodes(page) {
  if (nodeCache && nodeCache.page === page) return nodeCache.nodes;
  nodeCache = { page, nodes: diagramNodes(page) };
  queueMicrotask(() => { nodeCache = null; });
  return nodeCache.nodes;
}

// ── Where a tied end goes ─────────────────────────────────────────────────
//
// A straight connector tied to no side in particular leaves along the line
// between the two middles, from the outline — the "floating" end draw.io
// draws by default. One routed round corners or in a curve leaves by a SIDE:
// the one it was told, or the one facing the other end. Either way it stops
// CONNECTOR_END_GAP short of the outline, so its head is never under the block
// it points at (a block is drawn above every shape).
export const CONNECTOR_END_GAP = 2;

export function resolveConnector(shape, nodes) {
  const s = normalizeShape(shape);
  if (!s || (s.type !== "line" && s.type !== "arrow") || !s.ends) return s;
  const found = s.ends.map((end) => (end ? nodes.get(end.id) || null : null));
  if (!found.some(Boolean)) return s;
  const towards = (i) => (found[i] ? polygonCentre(found[i].poly) : s.p[i]);
  const p = s.p.map((point) => point.slice());
  const exits = [null, null];
  [0, 1].forEach((i) => {
    const node = found[i];
    if (!node) return;
    const other = towards(1 - i);
    let side = s.ends[i].side;
    if (side === "auto" && !s.route) {
      const centre = polygonCentre(node.poly);
      const edge = polygonPerimeterPoint(node.poly, other);
      const len = Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) || 1;
      p[i] = [edge[0] + ((edge[0] - centre[0]) / len) * CONNECTOR_END_GAP, edge[1] + ((edge[1] - centre[1]) / len) * CONNECTOR_END_GAP];
      return;
    }
    if (side === "auto") side = sideFacing(node.rect, other);
    const at = polygonSidePoint(node.poly, side);
    const v = SIDE_VECTORS[side];
    p[i] = [at[0] + v[0] * CONNECTOR_END_GAP, at[1] + v[1] * CONNECTOR_END_GAP];
    exits[i] = side;
  });
  const out = { ...s, p };
  delete out.exits;
  if (s.route && exits.some(Boolean)) out.exits = exits;
  return normalizeShape(out);
}

function resolveForPaint(record, shape, page, { preview = null } = {}) {
  const s = normalizeShape(shape);
  if (!s?.ends) return s;
  const nodes = preview?.id ? diagramNodes(Number(page), { preview }) : cachedNodes(Number(page));
  return resolveConnector(s, nodes);
}

// ── Keeping the stored ends where the things they join are ────────────────
let relinkFrame = 0;

export function scheduleConnectorRelink() {
  if (relinkFrame || typeof requestAnimationFrame !== "function") return;
  relinkFrame = requestAnimationFrame(() => {
    relinkFrame = 0;
    relinkConnectors();
  });
}

// Every tied connector on the open surface whose stored ends are not where its
// ties put them, rewritten in one write. Returns how many. Not mid-gesture or
// mid-edit: the drop or the end of the edit writes, and asks again.
export function relinkConnectors() {
  if (liveBlockGesture() || isInDiagramEdit()) return 0;
  const pages = new Map();
  const changes = [];
  documentShapes().forEach((record) => {
    const s = normalizeShape(record.shape);
    if (!s?.ends) return;
    const page = Number(record.page);
    if (!pages.has(page)) pages.set(page, diagramNodes(page));
    const next = resolveConnector(s, pages.get(page));
    if (JSON.stringify(next) !== JSON.stringify(s)) changes.push({ id: record.id, shape: next });
  });
  return changes.length ? updateShapesQuietly(changes) : 0;
}

// The connectors tied to `id`, as records.
export function connectorsTiedTo(id) {
  return documentShapes().filter((record) => normalizeShape(record.shape)?.ends?.some((end) => end?.id === id));
}

// ── What an end let go of HERE would be tied to ───────────────────────────
//
// The topmost box whose outline the point is inside, or within a fingertip of
// — and, near enough to one of its four side dots, that side.
const BIND_REACH_PX = 10;
const SIDE_REACH_PX = 12;

export function connectorTargetAt(page, point, { exclude = null, altKey = false } = {}) {
  if (altKey || !point) return null;
  const viewport = pdfPageViewport(page);
  if (!viewport) return null;
  const scale = viewport.scale || 1;
  const reach = BIND_REACH_PX / scale;
  let best = null;
  diagramNodes(page).forEach((node) => {
    if (node.id === exclude) return;
    const inside = pointInOutline(node.poly, point[0], point[1]);
    if (!inside && distanceToOutline(node.poly, point[0], point[1]) > reach) return;
    if (!best || node.z > best.z) best = node;
  });
  if (!best) return null;
  let side = "auto";
  let nearest = SIDE_REACH_PX / scale;
  NODE_SIDES.forEach((candidate) => {
    const at = polygonSidePoint(best.poly, candidate);
    const d = Math.hypot(at[0] - point[0], at[1] - point[1]);
    if (d <= nearest) { nearest = d; side = candidate; }
  });
  return { id: best.id, side, node: best };
}

// The box lit while an end is over it: its outline, and a dot on each side,
// the one it would keep to drawn larger.
function showConnectTarget(page, hit) {
  clearDiagramPart("target");
  const viewport = pdfPageViewport(page);
  if (!hit || !viewport) return;
  const svg = diagramSvg(viewport, "pdf-connect-target");
  svg.appendChild(diagramSvgNode("path", { d: diagramPathData(hit.node.poly, viewport, true), class: "pdf-connect-target-outline" }));
  NODE_SIDES.forEach((side) => {
    const at = polygonSidePoint(hit.node.poly, side);
    const [x, y] = viewport.convertToViewportPoint(at[0], at[1]);
    svg.appendChild(diagramSvgNode("circle", {
      cx: x.toFixed(1), cy: y.toFixed(1), r: side === hit.side ? 5 : 3.5,
      class: `pdf-connect-target-dot${side === hit.side ? " is-chosen" : ""}`
    }));
  });
  setDiagramPart(page, "target", [svg]);
}

function bindConnectorEnd({ page, point, event, exclude, show }) {
  const hit = connectorTargetAt(page, point, { exclude, altKey: Boolean(event?.altKey) });
  if (show) showConnectTarget(page, hit);
  return hit ? { id: hit.id, side: hit.side } : null;
}

// ── The arrows a picked-up box wears ──────────────────────────────────────
const CONNECT_ARROW_GAP_PX = 18;
// A box drawn with the Shapes tool has its turning handle above its middle
// (SHAPE_ROTATE_HANDLE_GAP, src/documents/pdf-shapes.js), exactly where its top
// arrow would sit — so that one arrow stands further out, past the handle.
const CONNECT_ARROW_PAST_TURN_PX = SHAPE_ROTATE_HANDLE_GAP + 26;
const SIDE_WORDS = { n: "top", e: "right", s: "bottom", w: "left" };

let connectDrag = null;
let arrowsSuppressed = () => false;

// Several things picked up at once (src/documents/canvas-selection.js) is not
// one box to connect from.
export function setConnectArrowsSuppressed(fn) {
  arrowsSuppressed = typeof fn === "function" ? fn : () => false;
}

function connectSource() {
  if (connectDrag || isEditingBlock() || liveBlockGesture() || editingShapeTextId() || arrowsSuppressed()) return null;
  const blockId = selectedBlockId();
  if (blockId) {
    const block = documentBlocks().find((entry) => entry.id === blockId);
    return block ? { id: block.id, page: Number(block.page), kind: "block" } : null;
  }
  const record = selectedShapeRecord();
  const s = normalizeShape(record?.shape);
  if (record && s && BOX_SHAPES.has(s.type)) return { id: record.id, page: Number(record.page), kind: "shape" };
  return null;
}

function paintConnectArrows(page) {
  const source = connectSource();
  if (!source || source.page !== Number(page)) { setDiagramPart(page, "connect", []); return; }
  const viewport = pdfPageViewport(page);
  const node = viewport ? diagramNodes(Number(page)).get(source.id) : null;
  if (!node) { setDiagramPart(page, "connect", []); return; }
  const [x0, y0, x1, y1] = node.rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const middles = { n: [cx, y1], e: [x1, cy], s: [cx, y0], w: [x0, cy] };
  const buttons = NODE_SIDES.map((side) => {
    const v = SIDE_VECTORS[side];
    const gap = source.kind === "shape" && side === "n" ? CONNECT_ARROW_PAST_TURN_PX : CONNECT_ARROW_GAP_PX;
    const reach = gap / (viewport.scale || 1);
    const at = [middles[side][0] + v[0] * reach, middles[side][1] + v[1] * reach];
    const [sx, sy] = viewport.convertToViewportPoint(at[0], at[1]);
    const [tx, ty] = viewport.convertToViewportPoint(at[0] + v[0], at[1] + v[1]);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-connect-arrow";
    button.dataset.side = side;
    button.dataset.source = source.id;
    button.dataset.page = String(page);
    const label = `Connect from the ${SIDE_WORDS[side]} — drag to another box, or press for a connected copy`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.style.left = `${sx.toFixed(1)}px`;
    button.style.top = `${sy.toFixed(1)}px`;
    // Pointing away from the box on screen, whichever way the page is turned.
    const angle = Math.atan2(ty - sy, tx - sx);
    button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" style="transform: rotate(${angle.toFixed(3)}rad)"><path d="M7 4.5l6 5.5-6 5.5"/></svg>`;
    return button;
  });
  setDiagramPart(page, "connect", buttons);
}

// Everything drawn over a page about what is on it, repainted together. Other
// modules add theirs (the frame round several things picked up, the guides).
const overlayPainters = [paintConnectArrows];

export function addDiagramOverlayPainter(fn) {
  if (typeof fn === "function" && !overlayPainters.includes(fn)) overlayPainters.push(fn);
}

export function paintDiagramOverlay(page) {
  overlayPainters.forEach((paint) => {
    try { paint(Number(page)); } catch (error) { console.warn("Could not paint the diagram overlay", error); }
  });
}

export function repaintDiagramOverlay() {
  document.querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
    const page = Number(pageEl.dataset.pageNumber);
    if (page) paintDiagramOverlay(page);
  });
}

// ── A block being dragged carries its lines with it ────────────────────────
let lastGestureId = null;

function onBlockGestureFrame(page, live) {
  const id = live?.id || lastGestureId;
  lastGestureId = live?.id || null;
  if (id && connectorsTiedTo(id).some((record) => Number(record.page) === Number(page))) paintDocumentShapes(page);
  paintDiagramOverlay(page);
}

// ── Dragging, or pressing, a connect arrow ─────────────────────────────────
function pdfPointOnPage(page, clientX, clientY) {
  const pageEl = pdfPageElement(page);
  const viewport = pdfPageViewport(page);
  if (!pageEl || !viewport) return null;
  const box = pageEl.getBoundingClientRect();
  return viewport.convertToPdfPoint(clientX - box.left, clientY - box.top);
}

function connectorFrom(drag, point, event) {
  const target = connectorTargetAt(drag.page, point, { exclude: drag.source, altKey: Boolean(event?.altKey) });
  showConnectTarget(drag.page, target);
  const raw = {
    ...newConnectorBase(),
    type: "arrow",
    p: [point, point],
    ends: [{ id: drag.source, side: drag.side }, target ? { id: target.id, side: target.side } : null]
  };
  return resolveConnector(raw, diagramNodes(drag.page));
}

const CONNECT_TAP_SLOP = 5;

function onDiagramControlDown(event) {
  const target = event.target;
  // A press in a connector's label editor is the editor's: the page's own
  // handlers (the pen, the shapes, a block put down) must not hear it.
  if (target?.closest?.(".pdf-connector-label-editor")) { event.stopPropagation(); return; }
  const arrow = target?.closest?.(".pdf-connect-arrow");
  if (!arrow) return;
  if (event.button !== undefined && event.button > 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (connectDrag) return;
  connectDrag = {
    pointerId: event.pointerId,
    page: Number(arrow.dataset.page),
    side: arrow.dataset.side,
    source: arrow.dataset.source,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    shape: null
  };
  diagramLayer(connectDrag.page, false)?.classList.add("is-connecting");
  document.addEventListener("pointermove", onConnectMove, true);
  document.addEventListener("pointerup", onConnectUp, true);
  document.addEventListener("pointercancel", onConnectCancel, true);
}

function onConnectMove(event) {
  const drag = connectDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CONNECT_TAP_SLOP) return;
  drag.moved = true;
  const point = pdfPointOnPage(drag.page, event.clientX, event.clientY);
  if (!point) return;
  drag.shape = connectorFrom(drag, point, event);
  paintDocumentShapes(drag.page, { preview: { id: null, shape: drag.shape } });
}

function endConnectDrag() {
  const drag = connectDrag;
  connectDrag = null;
  document.removeEventListener("pointermove", onConnectMove, true);
  document.removeEventListener("pointerup", onConnectUp, true);
  document.removeEventListener("pointercancel", onConnectCancel, true);
  clearDiagramPart("target");
  if (drag) diagramLayer(drag.page, false)?.classList.remove("is-connecting");
  return drag;
}

function onConnectUp(event) {
  if (!connectDrag || event.pointerId !== connectDrag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const drag = endConnectDrag();
  suppressControlClickUntil = Date.now() + 400;
  if (!drag.moved) { connectCopy(drag.source, drag.side, drag.page); return; }
  const point = pdfPointOnPage(drag.page, event.clientX, event.clientY);
  const shape = point ? connectorFrom(drag, point, event) : drag.shape;
  clearDiagramPart("target");
  if (!shape) { paintDocumentShapes(drag.page); return; }
  createConnector(drag.page, shape);
}

function onConnectCancel(event) {
  if (!connectDrag || event.pointerId !== connectDrag.pointerId) return;
  const drag = endConnectDrag();
  paintDocumentShapes(drag.page);
  paintDiagramOverlay(drag.page);
}

// The click a press on an arrow leaves behind is not a press on the page (no
// highlight menu opens under it) — and the keyboard's own press, a click with
// no pointer behind it, is the tap: a connected copy.
let suppressControlClickUntil = 0;

function onDiagramControlClick(event) {
  const arrow = event.target?.closest?.(".pdf-connect-arrow");
  if (!arrow) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.detail === 0 && Date.now() >= suppressControlClickUntil) {
    connectCopy(arrow.dataset.source, arrow.dataset.side, Number(arrow.dataset.page));
  }
}

// One connector, written as one step, and picked up.
export function createConnector(page, shape) {
  let made = null;
  runDiagramEdit(() => {
    made = newShapeRecord(page, shape);
    if (made) applyDocumentRecordChanges({ put: [made] });
  });
  if (!made) return null;
  selectBlock(null);
  selectShape(made.id);
  return made;
}

// ── A connected copy ──────────────────────────────────────────────────────
//
// Draw.io's other half of the blue arrow: press it and the box is copied
// beside itself, that way, joined to it — which is how a flowchart is
// actually typed: box, press, words, press, words. The copy has the box's
// shape, size and look and none of its words; a picture's copy is an empty
// block of the same size, since a second copy of a photograph is never the
// next step of a diagram.
const COPY_GAP = 48;

function rectsOverlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function placeCopy(page, rect, side, takenIds) {
  const viewport = pdfPageViewport(page);
  const [vx0, vy0, vx1, vy1] = viewport ? viewport.viewBox : [-Infinity, -Infinity, Infinity, Infinity];
  const v = SIDE_VECTORS[side];
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const others = [...diagramNodes(page).values()].filter((node) => !takenIds.has(node.id)).map((node) => node.rect);
  let x = rect[0];
  let y = rect[1];
  for (let step = 1; step <= 6; step += 1) {
    x = rect[0] + v[0] * (w + COPY_GAP) * step;
    y = rect[1] + v[1] * (h + COPY_GAP) * step;
    x = Math.min(Math.max(x, vx0 + 12), vx1 - w - 12);
    y = Math.min(Math.max(y, vy0 + 12), vy1 - h - 12);
    const candidate = [x, y, x + w, y + h];
    if (!others.some((other) => rectsOverlap(other, candidate)) && !rectsOverlap(rect, candidate)) break;
  }
  return [Math.round(x), Math.round(y)];
}

export function connectCopy(sourceId, side, page) {
  const nodes = diagramNodes(page);
  const node = nodes.get(sourceId);
  if (!node || !SIDE_VECTORS[side]) return null;
  let made = null;
  if (node.kind === "block") {
    const block = documentBlocks().find((entry) => entry.id === sourceId);
    if (!block) return null;
    const picture = block.kind === "image";
    const w = picture ? 160 : block.w;
    const h = picture ? 64 : block.h;
    const [x, y] = placeCopy(page, [block.x, block.y, block.x + w, block.y + h], side, new Set([sourceId]));
    runDiagramEdit(() => {
      const id = freshDocumentBlockId();
      const copy = {
        id, page: Number(page), x, y, w, h, z: nextBlockZ(), kind: "text", md: "", at: Date.now(),
        ...(!picture && block.style ? { style: { ...block.style } } : {})
      };
      writeDocumentBlocks([...documentBlocks(), copy]);
      const shape = resolveConnector({
        ...newConnectorBase(), type: "arrow", p: [[0, 0], [1, 1]],
        ends: [{ id: sourceId, side }, { id, side: oppositeSide(side) }]
      }, diagramNodes(page));
      const record = newShapeRecord(page, shape);
      if (record) applyDocumentRecordChanges({ put: [record] });
      made = { id, kind: "block" };
    });
    if (made) {
      selectShape(null);
      selectBlock(made.id);
      editBlock(made.id);
    }
    return made;
  }
  const record = documentHighlightById(sourceId);
  const s = normalizeShape(record?.shape);
  if (!s) return null;
  const [x, y] = placeCopy(page, node.rect, side, new Set([sourceId]));
  const copyShape = { ...translateShape(s, x - node.rect[0], y - node.rect[1]), text: "" };
  runDiagramEdit(() => {
    const copy = newShapeRecord(page, copyShape);
    if (!copy) return;
    const links = diagramNodes(page);
    const copyNode = shapeNode(copy.id, copy.shape, Infinity);
    if (copyNode) links.set(copy.id, copyNode);
    const shape = resolveConnector({
      ...newConnectorBase(), type: "arrow", p: [[0, 0], [1, 1]],
      ends: [{ id: sourceId, side }, { id: copy.id, side: oppositeSide(side) }]
    }, links);
    const connector = newShapeRecord(page, shape);
    applyDocumentRecordChanges({ put: connector ? [copy, connector] : [copy] });
    made = { id: copy.id, kind: "shape" };
  });
  if (made) {
    selectBlock(null);
    selectShape(made.id);
  }
  return made;
}

// ── Deleting a box with its lines ──────────────────────────────────────────
//
// Delete leaves a box's connectors where they were, still tied, so an undo
// brings the box back onto them. Ctrl+Delete takes them with it, as draw.io's
// "Delete All" does — one step.
export function deleteWithConnectors(id) {
  const block = documentBlocks().find((entry) => entry.id === id);
  const record = block ? null : documentHighlightById(id);
  if (!block && record?.kind !== "shape") return false;
  const tied = connectorsTiedTo(id).map((entry) => entry.id);
  if (block) selectBlock(null);
  else selectShape(null);
  runDiagramEdit(() => {
    if (block) writeDocumentBlocks(documentBlocks().filter((entry) => entry.id !== id), { removed: [id] });
    const remove = block ? tied : [...tied, id];
    if (remove.length) applyDocumentRecordChanges({ remove });
  });
  return true;
}

// ── A connector's words ───────────────────────────────────────────────────
//
// Typed where they will sit — beside the middle of the line — in a small box
// of their own: Enter puts them down, Shift+Enter is a new line, Escape leaves
// them as they were. One undo step on the pen's ring, as any restyle of a
// shape is.
let labelEditor = null;

export function isEditingConnectorLabel() {
  return Boolean(labelEditor);
}

export function commitConnectorLabel({ cancel = false } = {}) {
  const editor = labelEditor;
  if (!editor) return false;
  labelEditor = null;
  const text = String(editor.node.value || "").replace(/\r/g, "").replace(/\s+$/, "");
  editor.node.remove();
  const record = documentHighlightById(editor.id);
  const shape = normalizeShape(record?.shape);
  if (!cancel && shape && text !== shape.text) updateShape(editor.id, { ...shape, text });
  else paintDocumentShapes(editor.page);
  return true;
}

export function openConnectorLabelEditor(recordOrId) {
  const record = typeof recordOrId === "string" ? documentHighlightById(recordOrId) : recordOrId;
  const raw = normalizeShape(record?.shape);
  if (!record || !raw || (raw.type !== "line" && raw.type !== "arrow")) return false;
  commitConnectorLabel();
  const page = Number(record.page);
  const viewport = pdfPageViewport(page);
  const layer = diagramLayer(page);
  if (!viewport || !layer) return false;
  const shape = resolveConnector(raw, diagramNodes(page));
  // Where the words go: the label's own box, or — with none yet — the box a
  // short word would have.
  const rect = connectorLabelRect({ ...shape, text: shape.text || "Label" });
  const { point } = pathMidpoint(connectorPath(shape));
  const corner = rect ? [rect[0], rect[3]] : point;
  const [left, top] = viewport.convertToViewportPoint(corner[0], corner[1]);
  const node = document.createElement("textarea");
  node.className = "pdf-connector-label-editor";
  node.setAttribute("aria-label", "Words on this line");
  node.placeholder = "Label";
  node.rows = Math.max(1, shape.text.split("\n").length);
  node.value = shape.text;
  node.spellcheck = true;
  node.style.left = `${Math.max(0, left).toFixed(1)}px`;
  node.style.top = `${Math.max(0, top).toFixed(1)}px`;
  node.style.fontSize = `${(shape.font.size * (viewport.scale || 1)).toFixed(1)}px`;
  layer.appendChild(node);
  labelEditor = { node, id: record.id, page };
  selectShape(null);
  node.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); commitConnectorLabel({ cancel: true }); }
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitConnectorLabel(); }
  });
  node.addEventListener("input", () => { node.rows = Math.max(1, node.value.split("\n").length); });
  node.addEventListener("blur", () => { if (labelEditor?.node === node) commitConnectorLabel(); });
  requestAnimationFrame(() => { node.focus({ preventScroll: true }); node.select(); });
  return true;
}

// ── Wiring ────────────────────────────────────────────────────────────────
export function initConnectors() {
  setShapeResolver(resolveForPaint);
  setShapeBindingHooks({ bindAt: bindConnectorEnd, clear: () => clearDiagramPart("target") });
  setShapeOverlayHook(paintDiagramOverlay);
  setBlocksPaintedHook(paintDiagramOverlay);
  setBlockGestureFrameHook(onBlockGestureFrame);
  setConnectorLabelEditor(openConnectorLabelEditor);
  setShapeDeleteAllHandler(deleteWithConnectors);
  // Capture on the DOCUMENT, so a press on a connect arrow is the arrow's
  // before the page's own capture listeners (the pen, the shapes, the blocks
  // — all on #documentView, under this) ever hear it.
  document.addEventListener("pointerdown", onDiagramControlDown, true);
  document.addEventListener("click", onDiagramControlClick, true);
}
