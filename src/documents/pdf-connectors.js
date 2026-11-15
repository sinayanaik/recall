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
//   • A box picked up also wears small dots on its outline, a quarter of the
//     way in from each corner. Dragged, one draws a connector from that very
//     spot.
//   • The Shapes tool's line or arrow, drawn onto a box, ties to it; an end of
//     one already drawn, dragged onto a box, ties to it, and dragged off, comes
//     free. Where on the box it ties is where it is let go, as in draw.io:
//       – on one of the dots round the lit outline (a quarter, half and three
//         quarters along each side), that spot;
//       – anywhere else on or near the outline, that spot — an end can be
//         pinned anywhere round a box, not only to the middle of a side;
//       – well inside the box, nowhere in particular: the end FLOATS, leaving
//         by whichever side faces the other end (the whole outline is lit).
//     A pinned end keeps its place as a fraction of its side when the box is
//     moved or resized (src/render/connector-route.js).
//   • Alt held never ties anything.

import { el } from "../core/dom.js?v=__BUILD__";
import { clearDiagramPart, diagramLayer, diagramPathData, diagramSvg, diagramSvgNode, setDiagramPart } from "./pdf-diagram-layer.js?v=__BUILD__";
import {
  blockStyle, documentBlocks, editBlock, freshDocumentBlockId, isEditingBlock, isInDiagramEdit, liveBlockGesture, nextBlockZ,
  previewBlockRotation, rotateBlockBy, runDiagramEdit, selectBlock, selectedBlockId, setBlockGestureFrameHook, setBlockRotation, setBlocksPaintedHook,
  writeDocumentBlocks
} from "./pdf-blocks.js?v=__BUILD__";
import {
  SHAPE_ROTATE_HANDLE_GAP, documentShapes, editingShapeTextId, newConnectorBase, newShapeRecord, paintDocumentShapes, selectShape, selectedShapeRecord,
  setConnectorLabelEditor, setShapeBindingHooks, setShapeDeleteAllHandler, setShapeOverlayHook, setShapeResolver, updateShape, updateShapesQuietly
} from "./pdf-shapes.js?v=__BUILD__";
import { applyDocumentRecordChanges, documentHighlightById } from "./pdf-highlights.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import {
  SHAPE_ROTATE_MAGNET, connectorLabelRect, normalizeShape, normalizeShapeRotation, pathMidpoint, connectorPath, rotatePoint, shapeBoxCorners,
  shapePrimitives, translateShape
} from "../render/annot-shapes.js?v=__BUILD__";
import {
  CONNECT_POINTS, NODE_SIDES, SIDE_VECTORS, nearestOutlinePoint, oppositeSide, outlinePolygon, pointInOutline
} from "../render/node-outlines.js?v=__BUILD__";
import { CONNECTOR_END_GAP, outlineAnchorPoint, layoutConnectors, outlineAnchorAt } from "../render/connector-route.js?v=__BUILD__";

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
  let poly = outlinePolygon(blockStyle(block).shape, rect);
  // A turned block's outline turned with it, so a connector lands on the edge
  // that is drawn, and its box is the box round that.
  const rot = normalizeShapeRotation(block.rot);
  if (rot) {
    const centre = [block.x + block.w / 2, block.y + block.h / 2];
    poly = poly.map((point) => rotatePoint(point, centre, rot));
    return { id: block.id, kind: "block", rect: nodeRectOf(poly), poly, z: 1e6 + (Number(block.z) || 0), rot };
  }
  return { id: block.id, kind: "block", rect, poly, z: 1e6 + (Number(block.z) || 0) };
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
// Worked out for a whole page at once (src/render/connector-route.js): which
// side each end leaves by, where on that side when several share it, and the
// way round anything in between. A straight connector tied to no side in
// particular still leaves along the line between the two middles — the
// "floating" end draw.io draws by default. Either way an end stops
// CONNECTOR_END_GAP short of the outline, so its head is never under the block
// it points at (a block is drawn above every shape).
export { CONNECTOR_END_GAP };

// One connector on its own — one being drawn, or made beside a copy. With no
// page round it, it shares no side with anything.
export function resolveConnector(shape, nodes) {
  const s = normalizeShape(shape);
  if (!s || (s.type !== "line" && s.type !== "arrow") || !s.ends) return s;
  return layoutConnectors([{ id: "\u0000one", shape: s }], nodes).get("\u0000one") || s;
}

// Every tied connector on `page`, laid out together against `nodes`.
function pageLayout(page, nodes) {
  const entries = documentShapes(page)
    .filter((record) => normalizeShape(record.shape)?.ends)
    .map((record) => ({ id: record.id, shape: record.shape }));
  return layoutConnectors(entries, nodes);
}

// One layout per page per paint, as cachedNodes is one look at the nodes: a
// paint asks for every connector in turn, synchronously, and the answer cannot
// change inside it. A paint with a box being dragged (`preview`) has its own.
let layoutCache = null;

function cachedLayout(page, nodes, preview) {
  if (layoutCache && layoutCache.page === page && layoutCache.preview === preview) return layoutCache.layout;
  layoutCache = { page, preview, layout: pageLayout(page, nodes) };
  queueMicrotask(() => { layoutCache = null; });
  return layoutCache.layout;
}

function resolveForPaint(record, shape, page, { preview = null } = {}) {
  const s = normalizeShape(shape);
  if (!s?.ends) return s;
  const n = Number(page);
  const nodes = preview?.id ? diagramNodes(n, { preview }) : cachedNodes(n);
  // The connector being drawn or dragged itself, in its place among the rest.
  if (!record?.id || shape !== record.shape) {
    const entries = documentShapes(n)
      .filter((other) => other.id !== record?.id && normalizeShape(other.shape)?.ends)
      .map((other) => ({ id: other.id, shape: other.shape }));
    entries.push({ id: record?.id || "\u0000live", shape: s });
    return layoutConnectors(entries, nodes).get(record?.id || "\u0000live") || s;
  }
  return cachedLayout(n, nodes, preview?.id ? preview : null).get(record.id) || resolveConnector(s, nodes);
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
    if (!pages.has(page)) pages.set(page, pageLayout(page, diagramNodes(page)));
    const next = pages.get(page).get(record.id);
    if (next && JSON.stringify(next) !== JSON.stringify(s)) changes.push({ id: record.id, shape: next });
  });
  return changes.length ? updateShapesQuietly(changes) : 0;
}

// The connectors tied to `id`, as records.
export function connectorsTiedTo(id) {
  return documentShapes().filter((record) => normalizeShape(record.shape)?.ends?.some((end) => end?.id === id));
}

// ── What an end let go of HERE would be tied to ───────────────────────────
//
// The topmost box whose outline the point is inside, or within a fingertip of;
// and where on it:
//   • near one of its fixed points (CONNECT_POINTS on every side), that point.
//     The middle of a side is that side and no spot on it, so it is shared out
//     with the side's other ends, as it always was;
//   • otherwise near the outline, inside or out, the nearest spot on it;
//   • otherwise — well inside — nowhere in particular ("auto", a floating end).
const BIND_REACH_PX = 10;
const POINT_REACH_PX = 12;
const EDGE_REACH_PX = 10;
const MIDDLE = 0.5;

// Ends a hair either side of the middle of a side are the middle.
const sameAt = (a, b) => Math.abs(a - b) < 0.005;

// Every fixed point round a node: [{ side, at, point }] in PDF space.
export function connectPoints(node) {
  const out = [];
  NODE_SIDES.forEach((side) => {
    CONNECT_POINTS.forEach((at) => out.push({ side, at, point: outlineAnchorPoint(node, side, at) }));
  });
  return out;
}

export function connectorTargetAt(page, point, { exclude = null, altKey = false } = {}) {
  if (altKey || !point) return null;
  const viewport = pdfPageViewport(page);
  if (!viewport) return null;
  const scale = viewport.scale || 1;
  const reach = BIND_REACH_PX / scale;
  let best = null;
  let bestEdge = null;
  diagramNodes(page).forEach((node) => {
    if (node.id === exclude) return;
    const inside = pointInOutline(node.poly, point[0], point[1]);
    const edge = nearestOutlinePoint(node.poly, point[0], point[1]);
    const d = edge ? Math.hypot(edge[0] - point[0], edge[1] - point[1]) : Infinity;
    if (!inside && d > reach) return;
    if (!best || node.z > best.z) { best = node; bestEdge = { inside, edge, d }; }
  });
  if (!best) return null;
  const hit = { id: best.id, side: "auto", node: best };
  // 1. A fixed point.
  let nearest = POINT_REACH_PX / scale;
  connectPoints(best).forEach((candidate) => {
    const d = Math.hypot(candidate.point[0] - point[0], candidate.point[1] - point[1]);
    if (d <= nearest) {
      nearest = d;
      hit.side = candidate.side;
      hit.at = candidate.at;
      hit.point = candidate.point;
    }
  });
  if (hit.side === "auto" && bestEdge.edge) {
    // 2. Anywhere on the outline. Inside a small box the band round its edge
    // is narrower, so there is still a middle to let go in and float.
    const [x0, y0, x1, y1] = best.rect;
    const band = bestEdge.inside ? Math.min(EDGE_REACH_PX / scale, Math.min(x1 - x0, y1 - y0) / 4) : reach;
    if (bestEdge.d <= band) {
      const anchor = outlineAnchorAt(best, bestEdge.edge);
      if (anchor) {
        hit.side = anchor.side;
        hit.at = anchor.at;
        hit.point = outlineAnchorPoint(best, anchor.side, anchor.at);
      }
    }
  }
  // 3. Otherwise it floats: side "auto", no spot.
  if (hit.at !== undefined && sameAt(hit.at, MIDDLE)) delete hit.at;
  return hit;
}

// The end a hit makes: { id, side } and, pinned to a spot, its `at`.
export function connectorEndOf(hit) {
  if (!hit) return null;
  return Number.isFinite(hit.at) ? { id: hit.id, side: hit.side, at: hit.at } : { id: hit.id, side: hit.side };
}

// The box lit while an end is over it: its outline, a dot at each fixed point,
// and the spot the end would keep to drawn larger. A floating end lights the
// whole box instead — it is tied to the box, not to a spot on it.
function showConnectTarget(page, hit) {
  clearDiagramPart("target");
  const viewport = pdfPageViewport(page);
  if (!hit || !viewport) return;
  const svg = diagramSvg(viewport, "pdf-connect-target");
  const floating = hit.side === "auto";
  svg.appendChild(diagramSvgNode("path", {
    d: diagramPathData(hit.node.poly, viewport, true),
    class: `pdf-connect-target-outline${floating ? " is-floating" : ""}`
  }));
  const chosen = floating ? null : (hit.point || outlineAnchorPoint(hit.node, hit.side, Number.isFinite(hit.at) ? hit.at : MIDDLE));
  const dot = (at, big) => {
    const [x, y] = viewport.convertToViewportPoint(at[0], at[1]);
    svg.appendChild(diagramSvgNode("circle", {
      cx: x.toFixed(1), cy: y.toFixed(1), r: big ? 5 : 3,
      class: `pdf-connect-target-dot${big ? " is-chosen" : ""}`
    }));
  };
  connectPoints(hit.node).forEach((candidate) => {
    if (chosen && Math.hypot(candidate.point[0] - chosen[0], candidate.point[1] - chosen[1]) < 1e-6) return;
    dot(candidate.point, false);
  });
  if (chosen) dot(chosen, true);
  setDiagramPart(page, "target", [svg]);
}

function bindConnectorEnd({ page, point, event, exclude, show }) {
  const hit = connectorTargetAt(page, point, { exclude, altKey: Boolean(event?.altKey) });
  if (show) showConnectTarget(page, hit);
  return connectorEndOf(hit);
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
    const gap = side === "n" ? CONNECT_ARROW_PAST_TURN_PX : CONNECT_ARROW_GAP_PX;
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
  buttons.push(...connectPointDots(source, node, page, viewport));
  if (source.kind === "block") buttons.push(...blockTurnHandle(source.id, page, viewport));
  setDiagramPart(page, "connect", buttons);
}

// The dots round a picked-up box that a connector can be drawn from: its fixed
// points but the middles, where the arrow already is (and a resize handle may
// be). Each sits just outside the outline, so a press on the edge itself is
// still the edge's — a block's edges are its resize handles.
const CONNECT_POINT_OUT_PX = 4;

function connectPointDots(source, node, page, viewport) {
  const scale = viewport.scale || 1;
  return connectPoints(node)
    .filter((candidate) => !sameAt(candidate.at, MIDDLE))
    .map(({ side, at, point }) => {
      const v = SIDE_VECTORS[side];
      const out = CONNECT_POINT_OUT_PX / scale;
      const [x, y] = viewport.convertToViewportPoint(point[0] + v[0] * out, point[1] + v[1] * out);
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "pdf-connect-point";
      dot.dataset.side = side;
      dot.dataset.at = String(at);
      dot.dataset.source = source.id;
      dot.dataset.page = String(page);
      const label = "Connect from here — drag to another box";
      dot.title = label;
      dot.setAttribute("aria-label", `Connect from the ${SIDE_WORDS[side]}, ${Math.round(at * 100)}% along`);
      dot.style.left = `${x.toFixed(1)}px`;
      dot.style.top = `${y.toFixed(1)}px`;
      return dot;
    });
}

// ── The handle that turns a block ─────────────────────────────────────────
//
// Round, on a stem over the middle of the block's top — where a Shapes-tool
// box wears its own (src/documents/pdf-shapes.js) — and turned with the block.
// Drawn here, over the page, because a block clips everything inside it.
const BLOCK_TURN_GAP_PX = SHAPE_ROTATE_HANDLE_GAP;

function blockTurnGeometry(block, scale) {
  const rot = normalizeShapeRotation(block.rot);
  const centre = [block.x + block.w / 2, block.y + block.h / 2];
  const top = rotatePoint([centre[0], block.y + block.h], centre, rot);
  const knob = rotatePoint([centre[0], block.y + block.h + BLOCK_TURN_GAP_PX / (scale || 1)], centre, rot);
  return { centre, top, knob, rot };
}

function blockTurnHandle(id, page, viewport) {
  const block = documentBlocks().find((entry) => entry.id === id);
  if (!block) return [];
  const { top, knob } = blockTurnGeometry(block, viewport.scale);
  const [ax, ay] = viewport.convertToViewportPoint(top[0], top[1]);
  const [bx, by] = viewport.convertToViewportPoint(knob[0], knob[1]);
  const stem = document.createElement("span");
  stem.className = "pdf-shape-rotate-stem pdf-block-turn-stem";
  stem.style.left = `${ax.toFixed(1)}px`;
  stem.style.top = `${ay.toFixed(1)}px`;
  stem.style.width = `${Math.hypot(bx - ax, by - ay).toFixed(1)}px`;
  stem.style.transform = `rotate(${Math.atan2(by - ay, bx - ax)}rad)`;
  const knobNode = document.createElement("button");
  knobNode.type = "button";
  knobNode.className = "pdf-block-turn";
  knobNode.dataset.source = id;
  knobNode.dataset.page = String(page);
  const label = "Turn — drag round; Shift for 15° steps";
  knobNode.title = label;
  knobNode.setAttribute("aria-label", "Turn this block");
  knobNode.style.left = `${bx.toFixed(1)}px`;
  knobNode.style.top = `${by.toFixed(1)}px`;
  return [stem, knobNode];
}

// The turn the handle, dragged to `point`, gives the block: the handle sits
// straight over the middle at no turn, so the angle is measured from there —
// in 15° steps with Shift, and pulled onto a quarter turn within a few degrees
// otherwise (rotationFromHandle's rule for a Shapes-tool box).
function blockTurnAt(block, point, snap) {
  const centre = [block.x + block.w / 2, block.y + block.h / 2];
  if (Math.hypot(point[0] - centre[0], point[1] - centre[1]) < 1e-6) return normalizeShapeRotation(block.rot);
  let deg = (Math.atan2(point[1] - centre[1], point[0] - centre[0]) * 180) / Math.PI - 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  else {
    const quarter = Math.round(deg / 90) * 90;
    if (Math.abs(deg - quarter) <= SHAPE_ROTATE_MAGNET) deg = quarter;
  }
  return normalizeShapeRotation(deg);
}

let turnDrag = null;

function onTurnDown(event, knob) {
  if (event.button !== undefined && event.button > 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (turnDrag) return;
  const block = documentBlocks().find((entry) => entry.id === knob.dataset.source);
  if (!block) return;
  turnDrag = { pointerId: event.pointerId, page: Number(knob.dataset.page), block, rot: normalizeShapeRotation(block.rot) };
  document.addEventListener("pointermove", onTurnMove, true);
  document.addEventListener("pointerup", onTurnUp, true);
  document.addEventListener("pointercancel", onTurnUp, true);
}

function onTurnMove(event) {
  const drag = turnDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const point = pdfPointOnPage(drag.page, event.clientX, event.clientY);
  if (!point) return;
  drag.rot = blockTurnAt(drag.block, point, event.shiftKey);
  previewBlockRotation(drag.block.id, drag.rot);
}

function onTurnUp(event) {
  const drag = turnDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  turnDrag = null;
  document.removeEventListener("pointermove", onTurnMove, true);
  document.removeEventListener("pointerup", onTurnUp, true);
  document.removeEventListener("pointercancel", onTurnUp, true);
  previewBlockRotation(drag.block.id, null);
  if (event.type === "pointerup") setBlockRotation(drag.block.id, drag.rot);
  repaintDiagramOverlay();
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
  (el.documentView || document).querySelectorAll(".pdf-page[data-page-number]").forEach((pageEl) => {
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
    ends: [
      { id: drag.source, side: drag.side, ...(Number.isFinite(drag.at) ? { at: drag.at } : {}) },
      connectorEndOf(target)
    ]
  };
  return resolveConnector(raw, diagramNodes(drag.page));
}

const CONNECT_TAP_SLOP = 5;

function onDiagramControlDown(event) {
  const target = event.target;
  // A press in a connector's label editor is the editor's: the page's own
  // handlers (the pen, the shapes, a block put down) must not hear it.
  if (target?.closest?.(".pdf-connector-label-editor")) { event.stopPropagation(); return; }
  const knob = target?.closest?.(".pdf-block-turn");
  if (knob) { onTurnDown(event, knob); return; }
  const arrow = target?.closest?.(".pdf-connect-arrow, .pdf-connect-point");
  if (!arrow) return;
  if (event.button !== undefined && event.button > 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (connectDrag) return;
  connectDrag = {
    pointerId: event.pointerId,
    page: Number(arrow.dataset.page),
    side: arrow.dataset.side,
    // A dot is a spot on its side; an arrow is the side's middle.
    at: arrow.dataset.at !== undefined ? Number(arrow.dataset.at) : undefined,
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
  if (!drag.moved) {
    // A press on an arrow is a connected copy; on a dot, nothing.
    if (!Number.isFinite(drag.at)) connectCopy(drag.source, drag.side, drag.page);
    else paintDiagramOverlay(drag.page);
    return;
  }
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
  const knob = event.target?.closest?.(".pdf-block-turn");
  if (knob) {
    event.preventDefault();
    event.stopPropagation();
    // The keyboard's press (Enter, Space): a quarter turn.
    if (event.detail === 0) rotateBlockBy(knob.dataset.source, 90);
    return;
  }
  if (event.target?.closest?.(".pdf-connect-point")) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
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
