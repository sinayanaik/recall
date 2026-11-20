// Several things on a page picked up at once — and what can be done with them.
//
// A diagram is arranged, not only drawn: three boxes lined up, a row spaced
// evenly, a whole branch moved down to make room, a cluster copied to the next
// page. One block or one shape at a time (src/documents/pdf-blocks.js,
// pdf-shapes.js) cannot say any of that. So this keeps a PICK: blocks and
// shapes on one page, any mix, picked up together.
//
//   Shift- or Ctrl-click   adds a block or a shape to the pick, or takes it out
//   a drag on bare paper   on a Canvas, with the Select tool or the pen's bar
//                          shut: a box drawn round several picks what is in it
//   Ctrl+A                 everything on the page in view
//   a press on a grouped   picks its whole group; a second press on one thing
//   block or shape         already picked picks just that thing
//
// With several picked, a drag on any of them moves them all — and the lines
// tied to them follow (src/documents/pdf-connectors.js) — and a bar over them
// lines them up, spaces them, sizes them alike, groups them, copies or deletes
// them. Every one of those is ONE undo step (runDiagramEdit), blocks and shapes
// together. The keys: Delete, Ctrl+D, the arrows (Shift: ten points), Ctrl+C,
// Ctrl+X, Ctrl+V, Ctrl+G and Ctrl+Shift+G, Escape.
//
// On a Canvas only, with the Select tool (or the bar shut), a press on ANY
// shape picks it up and moves it — a box or an arrow, not only typed text. On
// a PDF the same press selects words, and is left to.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { pageDragLimits } from "./canvas-extent.js?v=__BUILD__";
import { documentViewOnly } from "./view-only.js?v=__BUILD__";
import { inkSelectionCount, inkTool, isInkArmed } from "./pdf-ink.js?v=__BUILD__";
import { isEraserEvent } from "../render/ink-engine.js?v=__BUILD__";
import {
  blockPageBounds, documentBlocks, freshDocumentBlockId, isEditingBlock, nextBlockZ, previewBlockGeometry, repaintDocumentBlocks,
  restackBlock, runDiagramEdit, selectBlock, selectedBlockId, setBlockClipboardHooks, writeDocumentBlocks
} from "./pdf-blocks.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import {
  documentShapes, editingShapeTextId, isShapeToolArmed, newShapeRecord, paintDocumentShapes, selectShape, selectedShapeHandleAt,
  selectedShapeRecord, shapeAtPoint, shapeRecordOnPage, updateShapesQuietly
} from "./pdf-shapes.js?v=__BUILD__";
import { applyDocumentRecordChanges, documentHighlightById, freshDocumentHighlightId } from "./pdf-highlights.js?v=__BUILD__";
import { claimPagePaste, noteInAppCopy } from "./page-clipboard.js?v=__BUILD__";
import { pagePointAtPointer } from "./page-pointer.js?v=__BUILD__";
import { currentDocumentPage, pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { normalizeShape, rectFromPoints, shapeBounds, translateShape } from "../render/annot-shapes.js?v=__BUILD__";
import {
  addDiagramOverlayPainter, connectorChangesForPageMove, connectorsTiedTo, keepTiesWithin, paintDiagramOverlay, repaintDiagramOverlay,
  setConnectArrowsSuppressed, setDiagramNodeOverrides
} from "./pdf-connectors.js?v=__BUILD__";
import { edgeScroller, mapPointBetweenPages, pointOnPage, pageUnderPointer, setCarrying } from "./page-handoff.js?v=__BUILD__";
import { clearDiagramPart, diagramSvg, diagramSvgNode, setDiagramPart } from "./pdf-diagram-layer.js?v=__BUILD__";
import { makeCardFromPageArea } from "./region-card.js?v=__BUILD__";
import { REGION_CLASS } from "./pdf-region.js?v=__BUILD__";

// ── What is picked ─────────────────────────────────────────────────────────
const pickState = { page: null, ids: new Set() };

export function pickedIds() {
  return [...pickState.ids];
}

export function isMultiPicked() {
  return pickState.ids.size >= 2;
}

const BOX_TYPES = new Set(["rect", "ellipse", "text", "callout"]);

// A block's frame, or — turned — the upright box round it, which is what a
// box drawn round several has to reach and what lining up goes by.
function blockFrameRect(block) {
  return blockPageBounds(block);
}

// One thing on the page, as this module handles it: its id, what it is, and
// the rectangle it is lined up by — a block's frame, a box's box, anything
// else's bounds — in PDF space.
function itemOf(id) {
  const block = documentBlocks().find((entry) => entry.id === id);
  if (block) {
    return { id, kind: "block", page: Number(block.page), block, rect: blockFrameRect(block) };
  }
  const record = documentHighlightById(id);
  const shape = record?.kind === "shape" ? normalizeShape(record.shape) : null;
  if (!shape) return null;
  const box = BOX_TYPES.has(shape.type) && !shape.rot;
  const rect = box ? rectFromPoints(shape.p[0], shape.p[1]) : shapeBounds(shape);
  return { id, kind: "shape", page: Number(record.page), record, shape, rect, isLine: shape.type === "line" || shape.type === "arrow", box };
}

function itemsOn(page) {
  const blocks = documentBlocks(page).map((block) => block.id);
  const shapes = documentShapes(page).map((record) => record.id);
  return [...blocks, ...shapes];
}

function groupOf(id) {
  const block = documentBlocks().find((entry) => entry.id === id);
  if (block) return block.group || null;
  return documentHighlightById(id)?.group || null;
}

// The ids, with every other member of any group one of them is in.
function withGroups(ids, page) {
  const groups = new Set(ids.map(groupOf).filter(Boolean));
  if (!groups.size) return ids;
  const out = new Set(ids);
  itemsOn(page).forEach((id) => { if (groups.has(groupOf(id))) out.add(id); });
  return [...out];
}

// What is picked up now, one thing or several: the pick, or the one block or
// shape selected the ordinary way.
function currentIds() {
  if (isMultiPicked()) return pickedIds();
  const block = selectedBlockId();
  if (block) return [block];
  const shape = selectedShapeRecord();
  return shape ? [shape.id] : [];
}

function selectOne(id) {
  const item = itemOf(id);
  if (!item) return;
  if (item.kind === "block") {
    selectShape(null);
    selectBlock(id);
  } else {
    selectBlock(null);
    selectShape(id);
  }
}

// Pick `ids` on `page`: one is the ordinary selection, two or more a pick.
export function pickIds(page, ids) {
  const valid = [...new Set(ids)].filter((id) => itemOf(id)?.page === Number(page));
  pickState.ids.clear();
  pickState.page = null;
  if (valid.length === 1) {
    selectOne(valid[0]);
  } else if (valid.length > 1) {
    pickState.page = Number(page);
    valid.forEach((id) => pickState.ids.add(id));
    selectBlock(null);
    selectShape(null);
  }
  repaintDiagramOverlay();
  syncArrangeBar();
}

export function clearPick() {
  if (!pickState.ids.size) return;
  pickState.ids.clear();
  pickState.page = null;
  repaintDiagramOverlay();
  syncArrangeBar();
}

function togglePicked(id, page) {
  const now = currentIds().filter((entry) => itemOf(entry)?.page === Number(page));
  const add = withGroups([id], page);
  const next = now.includes(id) ? now.filter((entry) => !add.includes(entry)) : [...now, ...add];
  pickIds(page, next);
}

// ── Drawn over the page: a dashed frame per thing, and one round them all ──
let dragView = null;

function pickedItems() {
  return pickedIds().map(itemOf).filter(Boolean);
}

function unionRect(rects) {
  return rects.reduce((box, r) => [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])],
    [Infinity, Infinity, -Infinity, -Infinity]);
}

function screenRectOn(viewport, rect) {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

// Anything picked that is gone now — deleted, undone, synced away — is let go.
function prunePick() {
  [...pickState.ids].forEach((id) => { if (itemOf(id)?.page !== pickState.page) pickState.ids.delete(id); });
  if (pickState.ids.size < 2) { pickState.ids.clear(); pickState.page = null; }
}

function paintPicked(page) {
  prunePick();
  // While carried over another page, the frames are drawn on that page — the
  // move (dragView) is in its points.
  const drawnOn = dragView?.page ?? pickState.page;
  if (!isMultiPicked() || drawnOn !== Number(page)) { setDiagramPart(page, "picked", []); return; }
  const viewport = pdfPageViewport(page);
  const items = pickedItems();
  if (!viewport || !items.length) { setDiagramPart(page, "picked", []); return; }
  const shift = dragView ? [dragView.dx, dragView.dy] : [0, 0];
  const rects = items.map((item) => [item.rect[0] + shift[0], item.rect[1] + shift[1], item.rect[2] + shift[0], item.rect[3] + shift[1]]);
  const svg = diagramSvg(viewport, "pdf-picked");
  rects.forEach((rect) => {
    const r = screenRectOn(viewport, rect);
    svg.appendChild(diagramSvgNode("rect", { x: r.x - 2, y: r.y - 2, width: r.w + 4, height: r.h + 4, class: "pdf-picked-item" }));
  });
  const all = screenRectOn(viewport, unionRect(rects));
  svg.appendChild(diagramSvgNode("rect", { x: all.x - 6, y: all.y - 6, width: all.w + 12, height: all.h + 12, class: "pdf-picked-all" }));
  setDiagramPart(page, "picked", [svg]);
}

// ── Pressing ──────────────────────────────────────────────────────────────
const TAP_SLOP = 4;
let pickPress = null;
let pickClickSuppressUntil = 0;

function pickOnCanvas() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK;
}

// The pointer picks things up rather than drawing: with the Select tool — or,
// for a mouse, with the pen's bar shut, when a mouse does not draw at all. A
// stylus draws whether the bar is open or not, so only Select turns it into
// this.
function selectMode(event) {
  if (isShapeToolArmed()) return false;
  if (inkTool() === "text") return true;
  return event.pointerType === "mouse" && !isInkArmed();
}

const pickPointOn = pointOnPage;

// Presses this module must never take: the page's own controls and editors,
// and anything floating over it.
const NOT_OURS = "button, a[href], input, textarea, select, label, [contenteditable='true'], [contenteditable='plaintext-only'], "
  + ".pdf-note-badge, .pdf-shape-editor, .pdf-shape-editor-grip, .pdf-connector-label-editor, .pdf-diagram-layer button, .document-ink-rail";

function onPickPress(event) {
  if (pickPress) {
    // A second finger while a finger carries the picked things is a pinch:
    // they go back where they were, nothing is written (abortPickMove).
    if (pickPress.kind === "move" && pickPress.pointerType === "touch"
        && event.pointerType === "touch" && event.pointerId !== pickPress.pointerId) {
      abortPickMove();
    }
    return;
  }
  if (event.button !== undefined && event.button > 0) return;
  // View only (src/documents/view-only.js): nothing is picked up or moved.
  if (documentViewOnly()) return;
  const target = event.target;
  if (!el.documentView?.contains(target) || target.closest?.(NOT_OURS)) return;
  if (isEraserEvent(event) || isEditingBlock() || editingShapeTextId()) return;
  const pageEl = target.closest?.(".pdf-page[data-page-number]");
  const page = Number(pageEl?.dataset.pageNumber);
  // The gap between pages, or the margin round them: nothing to pick up there,
  // but it is a press away from whatever several are picked — they go down,
  // and the Arrange bar with them.
  if (!page) { if (isMultiPicked()) clearPick(); return; }
  const point = pickPointOn(page, event.clientX, event.clientY);
  if (!point) return;
  const blockEl = target.closest(".pdf-block");
  const onHandle = Boolean(target.closest("[data-pdf-block-action]"));
  const textBox = target.closest(".pdf-shape-text");
  // A handle of the selected shape is the shape module's, always — even over
  // a block: a connector's end sits on its edge, and its handle is drawn above
  // it (src/documents/pdf-shapes.js).
  if (!onHandle && selectedShapeHandleAt(event.clientX, event.clientY)) { clearPick(); return; }
  let hitId = blockEl ? blockEl.dataset.pdfBlock : null;
  if (!hitId && textBox) hitId = textBox.dataset.highlightId || null;
  if (!hitId) hitId = shapeAtPoint(page, point[0], point[1])?.id || null;
  const toggling = event.shiftKey || event.ctrlKey || event.metaKey;
  const canvasSelect = pickOnCanvas() && event.pointerType !== "touch" && selectMode(event);

  // Shift- or Ctrl-click: in or out of the pick. Both surfaces.
  if (toggling && hitId && !onHandle) {
    claim(event);
    togglePicked(hitId, page);
    return;
  }
  // A press on something already picked, with several picked: they all move.
  if (hitId && !onHandle && isMultiPicked() && pickState.ids.has(hitId) && pickState.page === page) {
    claim(event);
    beginMove(event, page, pickedIds(), { narrowTo: hitId });
    return;
  }
  // A press on a grouped thing picks its group, and moves it.
  if (hitId && !onHandle && groupOf(hitId)) {
    claim(event);
    const group = withGroups([hitId], page);
    pickIds(page, group);
    beginMove(event, page, group.length > 1 ? group : [hitId]);
    return;
  }
  if (isMultiPicked()) clearPick();
  // On a Canvas with the Select tool: any shape is picked up and moved — a
  // typed text box is left to its own module, which also opens it to type in.
  if (canvasSelect && hitId && !blockEl && !textBox) {
    claim(event);
    selectOne(hitId);
    beginMove(event, page, [hitId]);
    return;
  }
  // ...and bare paper is where a box is drawn round several — unless ▣ is
  // armed, whose own box (src/documents/pdf-region.js) is the one being drawn.
  if (canvasSelect && !hitId && !blockEl && !el.documentStage?.classList.contains(REGION_CLASS)) {
    claim(event);
    selectBlock(null);
    selectShape(null);
    beginMarquee(event, page, point);
  }
}

// This press is this module's: nothing under it — the pen, the shapes, the
// blocks, a text selection — hears it, nor the click it leaves behind.
function claim(event) {
  event.preventDefault();
  event.stopPropagation();
  pickClickSuppressUntil = Date.now() + 500;
}

function onClick(event) {
  if (Date.now() >= pickClickSuppressUntil || !el.documentView?.contains(event.target)) return;
  pickClickSuppressUntil = 0;
  event.preventDefault();
  event.stopPropagation();
}

function listen(onMove, onUp) {
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerup", onUp, true);
  document.addEventListener("pointercancel", onUp, true);
  return () => {
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onUp, true);
  };
}

// ── Moving several together ────────────────────────────────────────────────
//
// Drawn where the drag has them every frame — blocks re-placed, shapes as
// previews, tied lines following through the connector module's overrides —
// and written once, on the drop, as one step.
const KEEP_ON_PAGE = 16;
let moveAdjuster = () => null;

// The guides (src/documents/pdf-guides.js) snap a group's box as it moves.
export function setPickedMoveAdjuster(fn) {
  moveAdjuster = typeof fn === "function" ? fn : () => null;
}

// Over another page, they go to that page (src/documents/page-handoff.js):
// `target` is the page the pointer is over, and `dx`, `dy` are the move in its
// points. Until they are let go they are still drawn by the page they came
// from (blocks past its edge, shapes clipped to it) and, the shapes, over the
// page they are carried to as well.
function beginMove(event, page, ids, { narrowTo = null } = {}) {
  const items = ids.map(itemOf).filter((item) => item && item.page === page);
  const viewport = pdfPageViewport(page);
  if (!items.length || !viewport) return;
  pickPress = {
    kind: "move", pointerId: event.pointerId, pointerType: event.pointerType || "", page, items, narrowTo,
    start: [event.clientX, event.clientY], perPixel: 1 / (viewport.scale || 1),
    startPoint: pointOnPage(page, event.clientX, event.clientY), target: page, ghostPage: null,
    box: unionRect(items.map((item) => item.rect)), moved: false, dx: 0, dy: 0
  };
  const scroll = edgeScroller(page, (last) => onMoveMove(last));
  pickPress.edgeScroll = scroll;
  const stop = listen(onMoveMove, onMoveUp);
  pickPress.stop = () => { scroll.stop(); stop(); };
}

// The preview moved from the target page's points into the source page's,
// for drawing it where it still is.
function shownOnSource(drag, preview) {
  if (drag.target === drag.page) return preview;
  const [ox, oy] = mapPointBetweenPages(drag.target, drag.page, [0, 0]);
  const blocks = new Map();
  const shapes = new Map();
  const overrides = new Map();
  preview.blocks.forEach((block, id) => {
    const shown = { ...block, x: block.x + ox, y: block.y + oy };
    blocks.set(id, shown);
    overrides.set(id, { block: shown });
  });
  preview.shapes.forEach((shape, id) => {
    const shown = translateShape(shape, ox, oy);
    shapes.set(id, shown);
    overrides.set(id, { shape: shown });
  });
  return { blocks, shapes, overrides };
}

// The carried shapes drawn over the page they are over, and taken off the one
// they were over a move ago.
function paintCarriedGhosts(drag, shapes) {
  const page = shapes && drag.target !== drag.page ? drag.target : null;
  if (drag.ghostPage && drag.ghostPage !== page) {
    paintDocumentShapes(drag.ghostPage);
    paintDiagramOverlay(drag.ghostPage);
  }
  drag.ghostPage = page;
  if (page) {
    paintDocumentShapes(page, { ghosts: [...shapes.values()] });
    paintDiagramOverlay(page);
  }
}

function movePreview(drag) {
  const blocks = new Map();
  const shapes = new Map();
  const overrides = new Map();
  drag.items.forEach((item) => {
    if (item.kind === "block") {
      const block = { ...item.block, x: item.block.x + drag.dx, y: item.block.y + drag.dy };
      blocks.set(item.id, block);
      overrides.set(item.id, { block });
    } else {
      const shape = translateShape(item.shape, drag.dx, drag.dy);
      shapes.set(item.id, shape);
      overrides.set(item.id, { shape });
    }
  });
  return { blocks, shapes, overrides };
}

function onMoveMove(event) {
  const drag = pickPress;
  if (!drag || drag.kind !== "move" || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved && Math.hypot(event.clientX - drag.start[0], event.clientY - drag.start[1]) < TAP_SLOP) return;
  drag.moved = true;
  drag.target = pageUnderPointer(drag.page, event.clientX, event.clientY, drag.target);
  const here = drag.startPoint ? pointOnPage(drag.target, event.clientX, event.clientY) : null;
  if (!here) drag.target = drag.page;
  let dx = here ? here[0] - drag.startPoint[0] : (event.clientX - drag.start[0]) * drag.perPixel;
  let dy = here ? here[1] - drag.startPoint[1] : -(event.clientY - drag.start[1]) * drag.perPixel;
  drag.edgeScroll?.update(event);
  const viewport = pdfPageViewport(drag.target);
  const snapped = moveAdjuster({ page: drag.target, ids: drag.items.map((item) => item.id), box: drag.box, dx, dy, event, viewport });
  if (snapped) ({ dx, dy } = snapped);
  // Never off the page: the group's box keeps KEEP_ON_PAGE points on it.
  if (viewport) {
    // ...or past the edges a Canvas page grows by, when it grows.
    const [vx0, vy0, vx1, vy1] = activeDocSlot() === DOC_SLOT_NOTEBOOK
      ? pageDragLimits(state.meta?.notebook, drag.target, viewport.viewBox)
      : viewport.viewBox;
    const clamp = (value, low, high) => (low > high ? value : Math.min(high, Math.max(low, value)));
    dx = clamp(dx, vx0 + KEEP_ON_PAGE - drag.box[2], vx1 - KEEP_ON_PAGE - drag.box[0]);
    dy = clamp(dy, vy0 + KEEP_ON_PAGE - drag.box[3], vy1 - KEEP_ON_PAGE - drag.box[1]);
  }
  drag.dx = dx;
  drag.dy = dy;
  const preview = movePreview(drag);
  const { blocks, shapes, overrides } = shownOnSource(drag, preview);
  setDiagramNodeOverrides(overrides);
  dragView = { dx, dy, page: drag.target };
  closeArrangeBar();
  setCarrying(drag.page, drag.target !== drag.page);
  previewBlockGeometry(drag.page, blocks);
  paintDocumentShapes(drag.page, { previews: shapes });
  paintCarriedGhosts(drag, preview.shapes);
  paintDiagramOverlay(drag.page);
}

function onMoveUp(event) {
  const drag = pickPress;
  if (!drag || drag.kind !== "move" || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  pickPress = null;
  drag.stop();
  dragView = null;
  moveAdjuster(null);
  setCarrying(drag.page, false);
  if (drag.moved && drag.target !== drag.page) { dropOnPage(drag); return; }
  if (!drag.moved) {
    // A tap on one of several picked: that one, alone.
    if (drag.narrowTo && event.type === "pointerup") pickIds(drag.page, [drag.narrowTo]);
    else { repaintDiagramOverlay(); syncArrangeBar(); }
    return;
  }
  const { blocks, shapes } = movePreview(drag);
  const now = Date.now();
  runDiagramEdit(() => {
    if (blocks.size) {
      writeDocumentBlocks(documentBlocks().map((block) => (blocks.has(block.id)
        ? { ...block, x: Math.round(blocks.get(block.id).x * 100) / 100, y: Math.round(blocks.get(block.id).y * 100) / 100, at: now }
        : block)));
    }
    if (shapes.size) updateShapesQuietly([...shapes].map(([id, shape]) => ({ id, shape })));
  });
  setDiagramNodeOverrides(new Map());
  repaintDocumentBlocks();
  paintDocumentShapes(drag.page);
  repaintDiagramOverlay();
  syncArrangeBar();
}

// ── ...let go of over another page ────────────────────────────────────────
//
// Everything carried is that page's now, in one step: the blocks on top of
// what is there in the order they were in, the shapes with their ties to one
// another kept and their ties to anything left behind let go of, and the lines
// on the page they left following them or letting go
// (connectorChangesForPageMove, src/documents/pdf-connectors.js).
function dropOnPage(drag) {
  const { blocks, shapes } = movePreview(drag);
  const ids = drag.items.map((item) => item.id);
  const moving = new Set(ids);
  const to = drag.target;
  const now = Date.now();
  let z = nextBlockZ();
  const raised = new Map([...blocks.keys()]
    .sort((a, b) => (Number(itemOf(a)?.block?.z) || 0) - (Number(itemOf(b)?.block?.z) || 0))
    .map((id) => [id, z++]));
  runDiagramEdit(() => {
    if (blocks.size) {
      writeDocumentBlocks(documentBlocks().map((block) => (blocks.has(block.id)
        ? {
          ...block, page: to, z: raised.get(block.id),
          x: Math.round(blocks.get(block.id).x * 100) / 100, y: Math.round(blocks.get(block.id).y * 100) / 100, at: now
        }
        : block)));
    }
    const put = drag.items.filter((item) => item.kind === "shape")
      .map((item) => shapeRecordOnPage(item.record, to, keepTiesWithin(shapes.get(item.id), moving)));
    put.push(...connectorChangesForPageMove({ ids, from: drag.page, to, dx: drag.dx, dy: drag.dy }));
    if (put.length) applyDocumentRecordChanges({ put });
  });
  if (drag.ghostPage) paintDocumentShapes(drag.ghostPage);
  setDiagramNodeOverrides(new Map());
  repaintDocumentBlocks();
  paintDocumentShapes(drag.page);
  paintDocumentShapes(to);
  pickIds(to, ids);
}

// ── ...called off by a second finger ──────────────────────────────────────
//
// A finger carrying a group when a second one lands is the start of a pinch,
// and the page is about to zoom under it (initDocumentPinchZoom,
// src/documents/pdf-view.js). What the first finger did on the way was not a
// move the reader meant: every picked thing is drawn back where it is stored,
// and nothing is written.
function abortPickMove() {
  const drag = pickPress;
  if (!drag || drag.kind !== "move") return;
  pickPress = null;
  drag.stop();
  dragView = null;
  moveAdjuster(null);
  setCarrying(drag.page, false);
  if (drag.ghostPage) paintDocumentShapes(drag.ghostPage);
  setDiagramNodeOverrides(new Map());
  repaintDocumentBlocks();
  paintDocumentShapes(drag.page);
  repaintDiagramOverlay();
  syncArrangeBar();
}

// ── A box drawn round several ─────────────────────────────────────────────
function beginMarquee(event, page, point) {
  pickPress = { kind: "marquee", pointerId: event.pointerId, page, from: point, start: [event.clientX, event.clientY], moved: false, rect: null };
  pickPress.stop = listen(onMarqueeMove, onMarqueeUp);
}

function onMarqueeMove(event) {
  const drag = pickPress;
  if (!drag || drag.kind !== "marquee" || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved && Math.hypot(event.clientX - drag.start[0], event.clientY - drag.start[1]) < TAP_SLOP) return;
  drag.moved = true;
  const point = pickPointOn(drag.page, event.clientX, event.clientY);
  if (!point) return;
  drag.rect = rectFromPoints(drag.from, point);
  const viewport = pdfPageViewport(drag.page);
  const r = screenRectOn(viewport, drag.rect);
  const svg = diagramSvg(viewport, "pdf-marquee");
  svg.appendChild(diagramSvgNode("rect", { x: r.x, y: r.y, width: r.w, height: r.h, class: "pdf-marquee-box" }));
  setDiagramPart(drag.page, "marquee", [svg]);
}

function onMarqueeUp(event) {
  const drag = pickPress;
  if (!drag || drag.kind !== "marquee" || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  pickPress = null;
  drag.stop();
  clearDiagramPart("marquee");
  if (!drag.moved || !drag.rect || event.type === "pointercancel") return;
  const [x0, y0, x1, y1] = drag.rect;
  const inside = itemsOn(drag.page).filter((id) => {
    const item = itemOf(id);
    const r = item?.kind === "shape" ? shapeBounds(item.shape) : item?.rect;
    return r && r[0] >= x0 && r[1] >= y0 && r[2] <= x1 && r[3] <= y1;
  });
  pickIds(drag.page, withGroups(inside, drag.page));
}

// ── Arranging ─────────────────────────────────────────────────────────────
//
// Each a move of whole things — a block's frame, a box's box — written as one
// step. Lines are left out of lining up and spacing (a tied one follows what
// it joins anyway), and sizes are matched to the FIRST thing picked, as a
// diagram tool does.
export const ARRANGE_ACTIONS = ["left", "centre", "right", "top", "middle", "bottom", "across", "down", "width", "height"];

function shifted(item, dx, dy) {
  if (item.kind === "block") return { ...item, block: { ...item.block, x: item.block.x + dx, y: item.block.y + dy } };
  return { ...item, shape: translateShape(item.shape, dx, dy) };
}

function pickResized(item, w, h) {
  if (item.kind === "block") {
    const block = item.block;
    // The top edge stays where it was: y runs up the page.
    return { ...item, block: { ...block, w, h, y: block.y + block.h - h } };
  }
  if (!item.box) return item;
  const [x0, , , y1] = item.rect;
  return { ...item, shape: { ...item.shape, p: [[x0, y1 - h], [x0 + w, y1], ...item.shape.p.slice(2)] } };
}

function writeItems(items, coalesce = "") {
  const now = Date.now();
  const blocks = new Map(items.filter((item) => item.kind === "block").map((item) => [item.id, item.block]));
  const shapes = items.filter((item) => item.kind === "shape");
  runDiagramEdit(() => {
    if (blocks.size) {
      writeDocumentBlocks(documentBlocks().map((block) => (blocks.has(block.id) ? { ...blocks.get(block.id), at: now } : block)));
    }
    if (shapes.length) updateShapesQuietly(shapes.map((item) => ({ id: item.id, shape: item.shape })));
  }, { coalesce });
  repaintDocumentBlocks();
  repaintDiagramOverlay();
  syncArrangeBar();
}

export function arrangePicked(action) {
  const items = pickedItems().filter((item) => !item.isLine);
  if (items.length < 2) return false;
  const box = unionRect(items.map((item) => item.rect));
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  let next;
  if (action === "left") next = items.map((item) => shifted(item, box[0] - item.rect[0], 0));
  else if (action === "right") next = items.map((item) => shifted(item, box[2] - item.rect[2], 0));
  else if (action === "centre") next = items.map((item) => shifted(item, cx - (item.rect[0] + item.rect[2]) / 2, 0));
  // Top is the HIGHEST y: PDF space runs up the page.
  else if (action === "top") next = items.map((item) => shifted(item, 0, box[3] - item.rect[3]));
  else if (action === "bottom") next = items.map((item) => shifted(item, 0, box[1] - item.rect[1]));
  else if (action === "middle") next = items.map((item) => shifted(item, 0, cy - (item.rect[1] + item.rect[3]) / 2));
  else if (action === "across" || action === "down") {
    if (items.length < 3) return false;
    const axis = action === "across" ? 0 : 1;
    const sorted = [...items].sort((a, b) => a.rect[axis] - b.rect[axis]);
    const span = box[axis + 2] - box[axis];
    const filled = sorted.reduce((sum, item) => sum + (item.rect[axis + 2] - item.rect[axis]), 0);
    const gap = (span - filled) / (sorted.length - 1);
    let at = box[axis];
    next = sorted.map((item) => {
      const delta = at - item.rect[axis];
      at += (item.rect[axis + 2] - item.rect[axis]) + gap;
      return axis === 0 ? shifted(item, delta, 0) : shifted(item, 0, delta);
    });
  } else if (action === "width" || action === "height") {
    const first = items[0];
    const w = first.rect[2] - first.rect[0];
    const h = first.rect[3] - first.rect[1];
    next = items.map((item) => (action === "width"
      ? pickResized(item, w, item.rect[3] - item.rect[1])
      : pickResized(item, item.rect[2] - item.rect[0], h)));
  } else return false;
  writeItems(next);
  return true;
}

// ── Removing, copying, grouping ───────────────────────────────────────────
export function deletePicked({ withConnectors = false } = {}) {
  const ids = currentIds();
  if (!ids.length) return false;
  const items = ids.map(itemOf).filter(Boolean);
  const blockIds = new Set(items.filter((item) => item.kind === "block").map((item) => item.id));
  const shapeIds = new Set(items.filter((item) => item.kind === "shape").map((item) => item.id));
  if (withConnectors) ids.forEach((id) => connectorsTiedTo(id).forEach((record) => shapeIds.add(record.id)));
  clearPick();
  selectBlock(null);
  selectShape(null);
  runDiagramEdit(() => {
    if (blockIds.size) writeDocumentBlocks(documentBlocks().filter((block) => !blockIds.has(block.id)), { removed: [...blockIds] });
    if (shapeIds.size) applyDocumentRecordChanges({ remove: [...shapeIds] });
  });
  return true;
}

// The clipboard: what was copied, as records, with the page it came from. In
// memory, and only for the file it was copied in — a block's pictures are
// that file's.
let clipboard = null;
let lastCopy = null;

function pickDeckKey() {
  return `${state.localDeckId || ""}:${activeDocSlot()}`;
}

function pickSnapshot(ids) {
  const items = ids.map(itemOf).filter(Boolean);
  if (!items.length) return null;
  return {
    page: items[0].page,
    deck: pickDeckKey(),
    box: unionRect(items.map((item) => item.rect)),
    blocks: items.filter((item) => item.kind === "block").map((item) => JSON.parse(JSON.stringify(item.block))),
    shapes: items.filter((item) => item.kind === "shape").map((item) => JSON.parse(JSON.stringify(item.record))),
    pastes: 0
  };
}

// The copy is kept here, and a token of it put on the system clipboard: the
// next paste is ours only if the system clipboard still holds that token — so
// a picture or words copied since, here or in another app, paste as they
// always did. Where the system clipboard cannot be written (no permission),
// the last copy made HERE decides instead — unless the reader has been in
// another window since and comes back with a picture to paste.
export function copyPicked({ cut = false } = {}) {
  const ids = currentIds();
  const copied = pickSnapshot(ids);
  if (!copied) return false;
  clipboard = copied;
  lastCopy = "objects";
  // The token, and which of the two clipboards a later Ctrl+V means, are
  // src/documents/page-clipboard.js's.
  noteInAppCopy("objects");
  if (cut) deletePicked();
  return true;
}

// Copy and Cut pressed rather than typed (a Block's strip, the bar over
// several): the same copy as Ctrl+C, and a word on where it can go, since a
// press on a tablet has no Ctrl+V to reach for.
export function copyPickedByButton({ cut = false } = {}) {
  const count = currentIds().length;
  if (!copyPicked({ cut })) return false;
  const what = count > 1 ? `${count} things` : "it";
  showToast(`${cut ? "Cut" : "Copied"} — paste ${what} on any page with Insert → Paste blocks (or Ctrl+V)`, "info");
  return true;
}

export function hasObjectClipboard() {
  return Boolean(clipboard) && lastCopy === "objects";
}

// Fresh ids for everything in `data`, ties between the copies moved onto the
// copies, ties to anything left behind cut loose, placed `dx`, `dy` away on
// `page` — and written as one step, and picked.
function placeCopies(data, page, dx, dy, { keepOutsideTies = false } = {}) {
  const ids = new Map();
  const takenBlocks = new Set(documentBlocks().map((block) => block.id));
  data.blocks.forEach((block) => {
    let id = freshDocumentBlockId();
    while (takenBlocks.has(id)) id = freshDocumentBlockId();
    takenBlocks.add(id);
    ids.set(block.id, id);
  });
  const takenShapes = new Set();
  data.shapes.forEach((record) => {
    let id = freshDocumentHighlightId();
    while (takenShapes.has(id)) id = freshDocumentHighlightId();
    takenShapes.add(id);
    ids.set(record.id, id);
  });
  const now = Date.now();
  let z = nextBlockZ();
  const blocks = data.blocks.map((block) => ({
    ...block, id: ids.get(block.id), page: Number(page), x: block.x + dx, y: block.y + dy, z: z++, at: now,
    ...(block.group ? { group: `${block.group}-${now.toString(36)}` } : {})
  }));
  const records = data.shapes.map((record) => {
    let shape = translateShape(normalizeShape(record.shape), dx, dy);
    if (shape.ends) {
      const ends = shape.ends.map((end) => {
        if (!end) return null;
        if (ids.has(end.id)) return { ...end, id: ids.get(end.id) };
        return keepOutsideTies ? end : null;
      });
      shape = { ...shape, ends };
      if (!ends.some(Boolean)) delete shape.ends;
    }
    const made = newShapeRecord(page, shape, ids.get(record.id));
    if (made && record.group) made.group = `${record.group}-${now.toString(36)}`;
    return made;
  }).filter(Boolean);
  runDiagramEdit(() => {
    if (blocks.length) writeDocumentBlocks([...documentBlocks(), ...blocks]);
    if (records.length) applyDocumentRecordChanges({ put: records });
  });
  pickIds(page, [...blocks.map((block) => block.id), ...records.map((record) => record.id)]);
  return true;
}

export function duplicatePicked() {
  const data = pickSnapshot(currentIds());
  if (!data) return false;
  return placeCopies(data, data.page, 14, -14, { keepOutsideTies: true });
}

// Where the mouse is, when it is over a page (`at`, from pagePointAtPointer):
// centred on it, on that page, kept on the paper — and a step further with
// each paste made without moving the mouse, so the copies do not stack into
// what looks like one. With no mouse over a page (a finger, a pen not
// hovering, Insert → Paste blocks pressed in its menu): onto the page in view,
// beside the original on its own page, a step further with each paste; on
// another page, in the middle of what is in view.
const PASTE_STEP = 16;

export function pastePicked(at = null) {
  if (!clipboard || clipboard.deck !== pickDeckKey()) return false;
  if (at && pdfPageViewport(at.page)) return pasteAtPoint(at);
  const page = Number(currentDocumentPage()) || clipboard.page;
  if (!pdfPageViewport(page)) return false;
  let dx;
  let dy;
  if (page === clipboard.page) {
    clipboard.pastes += 1;
    dx = 16 * clipboard.pastes;
    dy = -16 * clipboard.pastes;
  } else {
    const centre = viewCentre(page);
    const [x0, y0, x1, y1] = clipboard.box;
    dx = centre ? centre[0] - (x0 + x1) / 2 : 0;
    dy = centre ? centre[1] - (y0 + y1) / 2 : 0;
  }
  return placeCopies(clipboard, page, dx, dy);
}

function pasteAtPoint(at) {
  const page = Number(at.page);
  const last = clipboard.lastAt;
  const again = last && last.page === page && Math.abs(last.x - at.x) <= 1 && Math.abs(last.y - at.y) <= 1;
  clipboard.atPastes = again ? (clipboard.atPastes || 0) + 1 : 0;
  clipboard.lastAt = { page, x: at.x, y: at.y };
  const step = PASTE_STEP * clipboard.atPastes;
  const [x0, y0, x1, y1] = clipboard.box;
  let dx = at.x + step - (x0 + x1) / 2;
  let dy = at.y - step - (y0 + y1) / 2;
  const paper = pageBounds(page);
  if (paper) {
    dx = keepWithin(dx, x0, x1, paper[0], paper[2]);
    dy = keepWithin(dy, y0, y1, paper[1], paper[3]);
  }
  return placeCopies(clipboard, page, dx, dy);
}

// The page's paper, in its own points: [minX, minY, maxX, maxY].
function pageBounds(page) {
  const viewport = pdfPageViewport(page);
  if (!viewport?.convertToPdfPoint || !viewport.width || !viewport.height) return null;
  const [ax, ay] = viewport.convertToPdfPoint(0, 0);
  const [bx, by] = viewport.convertToPdfPoint(viewport.width, viewport.height);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

// A shift `d` for a span lo..hi, moved as little as it takes to keep the span
// inside min..max — or, for a span wider than that, its start at min.
function keepWithin(d, lo, hi, min, max) {
  if (hi - lo >= max - min) return min - lo;
  if (lo + d < min) return min - lo;
  if (hi + d > max) return max - hi;
  return d;
}

function viewCentre(page) {
  const viewport = pdfPageViewport(page);
  const pageEl = pdfPageElement(page);
  const view = el.documentView?.getBoundingClientRect();
  const box = pageEl?.getBoundingClientRect();
  if (!viewport || !view || !box) return null;
  const cx = Math.min(Math.max(view.left + view.width / 2, box.left), box.right) - box.left;
  const cy = Math.min(Math.max(view.top + view.height / 2, box.top), box.bottom) - box.top;
  return viewport.convertToPdfPoint(cx, cy);
}

function freshGroupId() {
  return `gp-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

// Group: the picked things are picked as one from now on. Ungroup: they are
// not. Both one step.
export function groupPicked(on = true) {
  const items = (on ? pickedItems() : currentIds().map(itemOf).filter(Boolean));
  if (on ? items.length < 2 : !items.some((item) => groupOf(item.id))) return false;
  const group = on ? freshGroupId() : null;
  const now = Date.now();
  const blockIds = new Set(items.filter((item) => item.kind === "block").map((item) => item.id));
  const shapes = items.filter((item) => item.kind === "shape");
  runDiagramEdit(() => {
    if (blockIds.size) {
      writeDocumentBlocks(documentBlocks().map((block) => {
        if (!blockIds.has(block.id)) return block;
        const { group: _drop, ...rest } = block;
        return group ? { ...rest, group, at: now } : { ...rest, at: now };
      }));
    }
    if (shapes.length) {
      applyDocumentRecordChanges({
        put: shapes.map((item) => {
          const { group: _drop, ...rest } = item.record;
          return group ? { ...rest, group } : rest;
        })
      });
    }
  });
  repaintDiagramOverlay();
  syncArrangeBar();
  return true;
}

export function restackPicked(direction) {
  const blocks = currentIds().map(itemOf).filter((item) => item?.kind === "block");
  if (!blocks.length) return false;
  const ordered = [...blocks].sort((a, b) => (a.block.z - b.block.z) * (direction > 0 ? 1 : -1));
  runDiagramEdit(() => ordered.forEach((item) => restackBlock(direction, item.id)));
  return true;
}

export function nudgePicked(dx, dy) {
  const items = pickedItems();
  if (!items.length) return false;
  writeItems(items.map((item) => shifted(item, dx, dy)), "nudge-picked");
  return true;
}

// Everything on the page in view.
export function pickAll() {
  const page = Number(currentDocumentPage());
  if (!page) return false;
  pickIds(page, itemsOn(page));
  return true;
}

// A card of everything picked: a live picture of the box round them all
// (src/documents/region-card.js) — lines tied to them, ink and anything else
// inside it come too, as they are on the page.
export function cardOfPicked() {
  const items = pickedItems();
  if (!items.length || pickState.page == null) return false;
  return makeCardFromPageArea({ page: pickState.page, rect: unionRect(items.map((item) => item.rect)) });
}

// ── The bar over several picked ───────────────────────────────────────────
let arrangeBar = null;

const ARRANGE_LABELS = {
  left: "Line up their left edges", centre: "Line up their middles, across", right: "Line up their right edges",
  top: "Line up their tops", middle: "Line up their middles, down", bottom: "Line up their bottoms",
  across: "Space them evenly across", down: "Space them evenly down", width: "Make them as wide as the first", height: "Make them as tall as the first"
};

const ARRANGE_ICONS = {
  left: "M4 3v18M8 7h10M8 15h6", centre: "M12 3v18M6 7h12M8 15h8", right: "M20 3v18M6 7h10M10 15h6",
  top: "M3 4h18M7 8v10M15 8v6", middle: "M3 12h18M7 6v12M15 8v8", bottom: "M3 20h18M7 6v10M15 10v6",
  across: "M3 6v12M21 6v12M9 9h6v6H9z", down: "M6 3h12M6 21h12M9 9h6v6H9z", width: "M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3", height: "M12 4v16M9 7l3-3 3 3M9 17l3 3 3-3"
};

function arrangeIcon(action) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ARRANGE_ICONS[action]}"/></svg>`;
}

function buildArrangeBar() {
  const root = document.createElement("div");
  root.className = "diagram-arrange-bar";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Arrange");
  const icons = ARRANGE_ACTIONS.map((action) => `<button type="button" class="diagram-arrange-btn" data-arrange="${action}" title="${ARRANGE_LABELS[action]}" aria-label="${ARRANGE_LABELS[action]}">${arrangeIcon(action)}</button>`).join("");
  const word = (action, label, title, extra = "") => `<button type="button" class="diagram-arrange-btn is-word${extra}" data-arrange="${action}" title="${title}" aria-label="${title}">${label}</button>`;
  root.innerHTML = `<div class="diagram-arrange-row">${icons}</div><div class="diagram-arrange-row">${[
    word("group", "Group", "Group — pick them up as one from now on (Ctrl+G)"),
    word("ungroup", "Ungroup", "Ungroup (Ctrl+Shift+G)"),
    word("duplicate", "Duplicate", "Duplicate (Ctrl+D)"),
    word("copy", "Copy", "Copy (Ctrl+C) — then paste them on any page with Insert → Paste blocks"),
    word("cut", "Cut", "Cut (Ctrl+X) — take them off this page, to paste on another"),
    word("card", "Card", "Make a card — a live picture of everything picked, where it is on the page"),
    word("front", "To front", "Blocks to the front"),
    word("back", "To back", "Blocks to the back"),
    word("delete", "Delete", "Delete (Delete) — Ctrl+Delete takes their lines too", " is-danger")
  ].join("")}</div>`;
  root.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-arrange]");
    event.preventDefault();
    event.stopPropagation();
    if (!button) return;
    const action = button.dataset.arrange;
    if (ARRANGE_ACTIONS.includes(action)) arrangePicked(action);
    else if (action === "group") groupPicked(true);
    else if (action === "ungroup") groupPicked(false);
    else if (action === "duplicate") duplicatePicked();
    else if (action === "copy") copyPickedByButton();
    else if (action === "cut") copyPickedByButton({ cut: true });
    else if (action === "card") cardOfPicked();
    else if (action === "front") restackPicked(Infinity);
    else if (action === "back") restackPicked(-Infinity);
    else if (action === "delete") deletePicked();
  });
  document.body.appendChild(root);
  const place = () => placeArrangeBar();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", place, true);
  return root;
}

function placeArrangeBar() {
  if (!arrangeBar || arrangeBar.hidden || !isMultiPicked()) return;
  const viewport = pdfPageViewport(pickState.page);
  const pageEl = pdfPageElement(pickState.page);
  const items = pickedItems();
  if (!viewport || !pageEl || !items.length) { arrangeBar.hidden = true; return; }
  const box = pageEl.getBoundingClientRect();
  const r = screenRectOn(viewport, unionRect(items.map((item) => item.rect)));
  const size = arrangeBar.getBoundingClientRect();
  const margin = 8;
  let top = box.top + r.y - size.height - 14;
  if (top < margin) top = box.top + r.y + r.h + 14;
  const left = Math.min(Math.max(margin, box.left + r.x), Math.max(margin, window.innerWidth - size.width - margin));
  arrangeBar.style.top = `${Math.round(Math.min(top, window.innerHeight - size.height - margin))}px`;
  arrangeBar.style.left = `${Math.round(left)}px`;
}

function closeArrangeBar() {
  if (arrangeBar) arrangeBar.hidden = true;
}

function syncArrangeBar() {
  prunePick();
  if (!isMultiPicked() || pickPress) { closeArrangeBar(); return; }
  if (!arrangeBar) arrangeBar = buildArrangeBar();
  const items = pickedItems();
  const boxes = items.filter((item) => !item.isLine).length;
  arrangeBar.querySelectorAll("[data-arrange]").forEach((button) => {
    const action = button.dataset.arrange;
    let off = false;
    if (ARRANGE_ACTIONS.includes(action)) off = boxes < ((action === "across" || action === "down") ? 3 : 2);
    else if (action === "ungroup") off = !items.some((item) => groupOf(item.id));
    else if (action === "front" || action === "back") off = !items.some((item) => item.kind === "block");
    button.disabled = off;
  });
  arrangeBar.hidden = false;
  placeArrangeBar();
}

export function isArrangeBarOpen() {
  return Boolean(arrangeBar && !arrangeBar.hidden);
}

// ── Keys ──────────────────────────────────────────────────────────────────
function pickTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']"));
}

const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

function onKey(event) {
  // View only: nothing is picked, pasted, grouped, nudged or deleted.
  if (documentViewOnly()) return;
  if (pickTypingTarget(event.target) || el.documentStage?.hidden || !el.documentView?.querySelector(".pdf-page")) return;
  if (isEditingBlock() || editingShapeTextId()) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = String(event.key || "").toLowerCase();
  const done = () => { event.preventDefault(); event.stopPropagation(); };
  // Everything on the page — on a Canvas; on a PDF, Ctrl+A is still the words.
  if (ctrl && !event.shiftKey && !event.altKey && key === "a" && !inkSelectionCount() && pickOnCanvas()) { if (pickAll()) done(); return; }
  if (ctrl && !event.shiftKey && (key === "c" || key === "x")) {
    if (inkSelectionCount()) { lastCopy = "ink"; return; }
    // Words picked out on the page are what a reader copying means.
    const words = window.getSelection?.();
    if (words && !words.isCollapsed && String(words).trim()) return;
    if (currentIds().length && copyPicked({ cut: key === "x" })) done();
    return;
  }
  if (ctrl && !event.shiftKey && key === "v" && hasObjectClipboard()) {
    // Claimed, not taken: the paste event says whether the system clipboard
    // holds something newer — a picture — which then pastes instead
    // (src/documents/page-clipboard.js). No other key handler may take this
    // press, and nothing may preventDefault it, or no paste event comes.
    // Where the mouse is when the paste runs, over a page: that is where the
    // reader is pasting (src/documents/page-pointer.js).
    claimPagePaste(() => pastePicked(pagePointAtPointer()));
    event.stopPropagation();
    return;
  }
  if (ctrl && event.shiftKey && key === "g") { if (groupPicked(false)) done(); return; }
  if (!isMultiPicked()) return;
  if (key === "escape") { clearPick(); done(); return; }
  if (key === "delete" || key === "backspace") { deletePicked({ withConnectors: ctrl }); done(); return; }
  if (ctrl && key === "d") { duplicatePicked(); done(); return; }
  if (ctrl && key === "g") { groupPicked(true); done(); return; }
  if (ctrl && event.shiftKey && (event.code === "BracketRight" || event.code === "BracketLeft")) {
    restackPicked(event.code === "BracketRight" ? Infinity : -Infinity);
    done();
    return;
  }
  if (!ctrl && !event.altKey && NUDGE[event.key]) {
    const step = event.shiftKey ? 10 : 1;
    nudgePicked(NUDGE[event.key][0] * step, NUDGE[event.key][1] * step);
    done();
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────
export function initCanvasSelection() {
  addDiagramOverlayPainter(paintPicked);
  setBlockClipboardHooks({
    copy: () => copyPickedByButton(),
    cut: () => copyPickedByButton({ cut: true })
  });
  setConnectArrowsSuppressed(() => isMultiPicked());
  // Capture on the document: ahead of the page's own listeners on
  // #documentView (the pen, the shapes, a block's own drag), which a press
  // this module takes must never reach.
  document.addEventListener("pointerdown", onPickPress, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  // Words copied here since are what the next Ctrl+V means, not the things
  // copied before them.
  document.addEventListener("copy", () => { if (lastCopy === "objects") lastCopy = "other"; });
}
