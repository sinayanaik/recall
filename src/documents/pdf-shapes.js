// Shapes on a page: the Shapes tool, and the shapes it leaves.
//
// The pen could already make a line, a box, a ring or an arrow — by holding
// still at the end of a stroke and having the stroke straightened
// (src/render/ink-shapes.js). What it made was ink: a perfect stroke that could
// never be anything but that stroke again. Reported as annotations that are
// "very much s-pen based", with nothing for the basic geometry everybody marks a
// paper with — an arrow from a claim to its figure, a box round a result, a
// callout saying why. So this is a tool that draws THOSE, as objects:
//
//   line · arrow · rectangle · ellipse · callout · text · sticky note
//
// each a record in meta.pdfHighlights with `kind: "shape"` (the geometry is
// src/render/annot-shapes.js). Being a highlight is what gives it, for nothing,
// a note, a card, a row in the Highlights pane, a merge by id across devices, a
// tombstone when it goes and a place in the backup — the argument pdf-ink.js
// makes for ink, made again.
//
// ── Live, not drawn once ───────────────────────────────────────────────────
//
// A shape is kept as what it IS — two ends and a head, a box and a fill — so a
// press on it selects it, its handles move its ends or corners, a drag on its
// body moves it, and the panel under the rail's chip restyles it. Every change
// is one step on the pen's own undo ring (pushInkHistoryAction), so ↶ and Ctrl+Z
// take shapes back in order with the ink drawn beside them.
//
// ── Who draws ─────────────────────────────────────────────────────────────
//
// The pen's rule, unchanged (src/documents/pdf-ink.js): with the Shapes tool
// armed a stylus draws shapes, a mouse draws them while the rail is open, and a
// finger never does — it goes on scrolling, pinching and selecting. A finger can
// still open a shape's menu with a tap, which is how a shape is reached with no
// tool armed at all (initDocumentMarkMenu, pdf-highlights.js).
//
// ── Where it is drawn ─────────────────────────────────────────────────────
//
// One layer per page, `.pdf-shape-layer`, over the ink and under the note
// badges (styles/88-annotations.css): an SVG for everything that is a line, and
// a positioned box for typed text and a sticky note's icon. It takes no pointer
// events — the text layer under it has to keep every one, or selecting words
// stops working beside a shape — so presses are routed from a capture-phase
// listener on the scroller and hit-tested against the geometry, exactly as ink
// and highlights are.

import { el } from "../core/dom.js?v=__BUILD__";
import { DOC_SLOT_NOTEBOOK, activeDocSlot } from "./doc-slot.js?v=__BUILD__";
import { setInkPenDown } from "../core/gesture.js?v=__BUILD__";
import { inkFilingColor } from "../format/ink-colors.js?v=__BUILD__";
import { isEraserEvent } from "../render/ink-engine.js?v=__BUILD__";
import {
  SHAPE_DEFAULTS, SHAPE_HEADS, SHAPE_TEXT_PAD, SHAPE_TYPES, moveShapeHandle, normalizeShape, normalizeShapeHex,
  polyPathData, shapeBounds, shapeCrossesSegment, shapeDashArray, shapeFromDrag, shapeHandles, shapeHitsPoint, shapeLabel, shapePrimitives,
  shapeTypeDefaults, snapShapeAngle, stickyIconPolys, translateShape
} from "../render/annot-shapes.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import {
  QUAD_GEOMETRY_VERSION, documentHighlightById, documentHighlights, freshDocumentHighlightId, reinstateDocumentHighlight,
  removeDocumentHighlight, setDocumentShapePainter, updateDocumentHighlight
} from "./pdf-highlights.js?v=__BUILD__";
import { inkEraseTarget, inkTool, isInkArmed, pushInkHistoryAction } from "./pdf-ink.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";

export const PDF_SHAPE_LAYER_CLASS = "pdf-shape-layer";
export const PDF_SHAPE_CLASS = "pdf-shape";

// How near a press has to land to take a handle, in CSS pixels — a fingertip's
// worth, because a nib is not always where the reader is looking.
export const SHAPE_HANDLE_REACH = 12;

// How near a press has to land to take the shape itself, in CSS pixels.
export const SHAPE_HIT_REACH = 6;

// A press that moved less than this, in CSS pixels, was a tap.
export const SHAPE_TAP_SLOP = 4;

// ── The tool's settings ────────────────────────────────────────────────────
//
// Per device, beside the pen's (src/storage/ink-prefs.js `shape`): which shape
// is armed, and how a new one looks. Heads are kept per type, because "an arrow
// has a head" and "a line does not" are both true at once.

const SHAPE_SETTING_TYPES = ["line", "arrow", "rect", "ellipse", "callout", "text", "sticky"];

function defaultShapeSettings() {
  return {
    type: "arrow",
    stroke: SHAPE_DEFAULTS.stroke,
    width: SHAPE_DEFAULTS.width,
    opacity: 1,
    dash: "solid",
    fill: null,
    fillOpacity: SHAPE_DEFAULTS.fillOpacity,
    heads: {
      line: ["none", "none"],
      arrow: ["none", "filled"],
      callout: ["none", "filled"]
    },
    snap: false,
    fontSize: SHAPE_DEFAULTS.font.size,
    bold: false,
    align: "left",
    // Typed text and a sticky note have colours of their own: the arrow's red
    // is no reason for the next words typed to be red, or yellow for a note.
    textColor: "#16181d",
    stickyColor: "#e0b400",
    // The last shape that is not typed text — what the Shapes button wears and
    // goes back to while the Text button has the typewriter armed.
    lastShape: "arrow"
  };
}

export function normalizeShapeSettings(raw) {
  const base = defaultShapeSettings();
  if (!raw || typeof raw !== "object") return base;
  const heads = { ...base.heads };
  Object.keys(heads).forEach((type) => {
    const pair = raw.heads?.[type];
    if (Array.isArray(pair)) heads[type] = [0, 1].map((i) => (SHAPE_HEADS.includes(pair[i]) ? pair[i] : heads[type][i]));
  });
  const shape = normalizeShape({
    type: "rect", p: [[0, 0], [1, 1]], stroke: raw.stroke, width: raw.width, opacity: raw.opacity,
    dash: raw.dash, fill: raw.fill, fillOpacity: raw.fillOpacity,
    font: { size: raw.fontSize, bold: raw.bold, align: raw.align }
  });
  return {
    type: SHAPE_SETTING_TYPES.includes(raw.type) ? raw.type : base.type,
    stroke: shape.stroke,
    width: shape.width,
    opacity: shape.opacity,
    dash: shape.dash,
    fill: shape.fill,
    fillOpacity: shape.fillOpacity,
    heads,
    snap: raw.snap === true,
    fontSize: shape.font.size,
    bold: shape.font.bold,
    align: shape.font.align,
    textColor: normalizeShapeHex(raw.textColor) || base.textColor,
    stickyColor: normalizeShapeHex(raw.stickyColor) || base.stickyColor,
    lastShape: SHAPE_SETTING_TYPES.includes(raw.lastShape) && raw.lastShape !== "text" ? raw.lastShape : base.lastShape
  };
}

// Per tab: a PDF's shapes and a Canvas's are set apart, as the pen is
// (src/storage/ink-prefs.js, INK_SURFACES).
const shapeSettingsBySurface = new Map();

function shapeSurface() {
  return activeDocSlot() === DOC_SLOT_NOTEBOOK ? "notebook" : "doc";
}

export function currentShapeSettings() {
  const key = shapeSurface();
  if (!shapeSettingsBySurface.has(key)) shapeSettingsBySurface.set(key, normalizeShapeSettings(inkPreferences(key).shape));
  return shapeSettingsBySurface.get(key);
}

let shapeChangedHandler = () => {};

// The rail repaints its chip and panel when the tool's settings or the selection
// change. Registered rather than imported: src/ui/ink-rail.js imports this.
export function setShapeChangedHandler(fn) {
  shapeChangedHandler = typeof fn === "function" ? fn : () => {};
}

// A patch of settings. With a shape selected it restyles that shape as well —
// "make THIS that", as a press on a swatch with a lasso selection does — and the
// next shape carries on in the same style.
export function setShapeSettings(patch = {}) {
  const before = currentShapeSettings();
  const next = { ...before, ...patch };
  if (patch.heads) next.heads = { ...before.heads, ...patch.heads };
  const shapeSettings = normalizeShapeSettings(next);
  shapeSettingsBySurface.set(shapeSurface(), shapeSettings);
  writeInkPreferences({ shape: shapeSettings }, shapeSurface());
  const selected = selectedShapeRecord();
  if (selected) {
    const restyle = {};
    ["stroke", "width", "opacity", "dash", "fill", "fillOpacity"].forEach((key) => {
      if (key in patch) restyle[key] = shapeSettings[key];
    });
    if (patch.heads?.[selected.shape.type]) restyle.heads = shapeSettings.heads[selected.shape.type];
    const font = {};
    if ("fontSize" in patch) font.size = shapeSettings.fontSize;
    if ("bold" in patch) font.bold = shapeSettings.bold;
    if ("align" in patch) font.align = shapeSettings.align;
    if ("textColor" in patch && selected.shape.type === "text") font.color = shapeSettings.textColor;
    if ("stickyColor" in patch && selected.shape.type === "sticky") restyle.stroke = shapeSettings.stickyColor;
    if (Object.keys(font).length) restyle.font = { ...selected.shape.font, ...font };
    if (Object.keys(restyle).length) updateShape(selected.id, { ...selected.shape, ...restyle });
  }
  shapeChangedHandler();
}

export function shapeType() {
  return currentShapeSettings().type;
}

export function setShapeType(type) {
  if (!SHAPE_TYPES.includes(type)) return;
  setShapeSettings(type === "text" ? { type } : { type, lastShape: type });
}

// The shape the Shapes button stands for: the armed one, or — while the Text
// button has the typewriter — the last one drawn.
export function shapeButtonType() {
  const s = currentShapeSettings();
  return s.type === "text" ? s.lastShape : s.type;
}

// The look a new shape of `type` is drawn with.
function newShapeBase(type) {
  const s = currentShapeSettings();
  const base = {
    ...shapeTypeDefaults(type),
    stroke: s.stroke,
    width: s.width,
    opacity: s.opacity,
    dash: s.dash,
    font: { size: s.fontSize, bold: s.bold, align: s.align, color: null }
  };
  if (s.heads[type]) base.heads = s.heads[type];
  // A fill is the reader's for a box; a callout keeps its pale paper unless the
  // reader has chosen one, so its words stay readable over the page.
  if (type === "rect" || type === "ellipse" || type === "text" || s.fill) {
    if (s.fill || type !== "callout") {
      base.fill = s.fill;
      base.fillOpacity = s.fillOpacity;
    }
  }
  if (type === "text") {
    base.width = 0.3;
    base.fit = true;
    base.font = { ...base.font, color: s.textColor };
  }
  if (type === "sticky") base.stroke = s.stickyColor;
  return base;
}

// ── The records ───────────────────────────────────────────────────────────

export function documentShapes(pageNumber = null) {
  return documentHighlights().filter((record) => record?.kind === "shape"
    && normalizeShape(record.shape)
    && (pageNumber === null || Number(record.page) === Number(pageNumber)));
}

// The fields a shape record carries besides its id, derived from the shape:
// the bounding box (for the thumbnail, the badge and the export), the colour it
// is filed under, and the words — a callout's or a text box's — so the pane, a
// search and a card have something to show.
function shapeRecordFields(pageNumber, shape) {
  const s = normalizeShape(shape);
  const box = shapeBounds(s);
  const words = (s.type === "callout" || s.type === "text") ? s.text.trim() : "";
  return {
    page: pageNumber,
    color: inkFilingColor(`x${s.stroke.slice(1)}`),
    text: words,
    quads: box ? [{ page: pageNumber, rect: box }] : [],
    kind: "shape",
    shape: s
  };
}

export function addDocumentShape(pageNumber, shape, { undo = true } = {}) {
  const s = normalizeShape(shape);
  if (!s) return null;
  const record = {
    id: freshDocumentHighlightId(),
    anchor: null,
    focus: null,
    ...shapeRecordFields(pageNumber, s),
    qv: QUAD_GEOMETRY_VERSION,
    at: Date.now()
  };
  const made = reinstateDocumentHighlight(record);
  if (!made) return null;
  if (undo) {
    pushInkHistoryAction({
      undo: () => { if (!documentHighlightById(made.id)) return false; removeDocumentHighlight(made.id, { undo: false }); return true; },
      redo: () => Boolean(reinstateDocumentHighlight(made))
    });
  }
  return made;
}

// The shape of a record replaced, as one undo step unless told otherwise.
export function updateShape(id, shape, { undo = true } = {}) {
  const record = documentHighlightById(id);
  const s = normalizeShape(shape);
  if (!record || record.kind !== "shape" || !s) return false;
  const before = record.shape;
  if (JSON.stringify(before) === JSON.stringify(s)) return false;
  const page = Number(record.page);
  updateDocumentHighlight(id, shapeRecordFields(page, s));
  if (undo) {
    pushInkHistoryAction({
      undo: () => updateDocumentHighlight(id, shapeRecordFields(page, before)),
      redo: () => updateDocumentHighlight(id, shapeRecordFields(page, s))
    });
  }
  return true;
}

export function deleteShape(id = selectedShapeId) {
  const record = documentHighlightById(id);
  if (!record || record.kind !== "shape") return false;
  if (id === selectedShapeId) selectShape(null);
  removeDocumentHighlight(id, { undo: false });
  pushInkHistoryAction({
    undo: () => Boolean(reinstateDocumentHighlight(record)),
    redo: () => { if (!documentHighlightById(id)) return false; removeDocumentHighlight(id, { undo: false }); return true; }
  });
  return true;
}

export function duplicateShape(id = selectedShapeId) {
  const record = documentHighlightById(id);
  if (!record || record.kind !== "shape") return null;
  const made = addDocumentShape(Number(record.page), translateShape(record.shape, 12, -12));
  if (made) selectShape(made.id);
  return made;
}

export function nudgeShape(dx, dy, id = selectedShapeId) {
  const record = documentHighlightById(id);
  if (!record || record.kind !== "shape") return false;
  return updateShape(id, translateShape(record.shape, dx, dy));
}

// ── Selection ─────────────────────────────────────────────────────────────

let selectedShapeId = null;

export function selectedShapeRecord() {
  if (!selectedShapeId) return null;
  const record = documentHighlightById(selectedShapeId);
  if (!record || record.kind !== "shape") { selectedShapeId = null; return null; }
  return record;
}

export function selectShape(id) {
  const next = id && documentHighlightById(id)?.kind === "shape" ? id : null;
  if (next === selectedShapeId) return;
  const before = selectedShapeId ? documentHighlightById(selectedShapeId) : null;
  selectedShapeId = next;
  if (before) paintDocumentShapes(Number(before.page));
  if (next) paintDocumentShapes(Number(documentHighlightById(next).page));
  shapeChangedHandler();
}

// What the panel shows: the selected shape's own style when one is selected —
// so a change made there is a change to IT rather than a guess at it — and the
// tool's otherwise. Selecting a shape does not change the tool: the next shape
// is drawn the way the reader set the tool, not the way the last one they
// picked up happened to look.
export function displayedShapeSettings() {
  const tool = currentShapeSettings();
  const selected = selectedShapeRecord();
  const s = normalizeShape(selected?.shape);
  if (!s) return tool;
  const heads = { ...tool.heads };
  if (heads[s.type]) heads[s.type] = s.heads;
  return normalizeShapeSettings({
    ...tool, stroke: s.stroke, width: s.width, opacity: s.opacity, dash: s.dash,
    fill: s.fill, fillOpacity: s.fillOpacity, heads, fontSize: s.font.size, bold: s.font.bold, align: s.font.align,
    textColor: s.type === "text" ? (s.font.color || s.stroke) : tool.textColor,
    stickyColor: s.type === "sticky" ? s.stroke : tool.stickyColor
  });
}

// ── Painting ──────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

function shapeLayer(pageNumber, create = true) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return null;
  let layer = pageEl.querySelector(`:scope > .${PDF_SHAPE_LAYER_CLASS}`);
  if (!layer && create) {
    layer = document.createElement("div");
    layer.className = PDF_SHAPE_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  return layer;
}

// PDF points onto the page's CSS pixels, through the page's own transform.
function viewportMapper(viewport) {
  return ([x, y]) => viewport.convertToViewportPoint(x, y);
}

// The screen rectangle of a PDF-space box.
function screenRect(viewport, rect) {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

function svgPathFor(prim, toPoint, scale) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", polyPathData(prim, toPoint));
  path.setAttribute("fill", prim.fill || "none");
  if (prim.fill) path.setAttribute("fill-opacity", String(prim.fillOpacity));
  if (prim.width > 0) {
    path.setAttribute("stroke", prim.stroke);
    path.setAttribute("stroke-width", String(Math.max(0.5, prim.width * scale)));
    path.setAttribute("stroke-opacity", String(prim.opacity));
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", prim.dash === "dot" ? "round" : "butt");
    const dash = shapeDashArray(prim.dash, prim.width, scale);
    if (dash.length) path.setAttribute("stroke-dasharray", dash.map((n) => n.toFixed(2)).join(" "));
  } else {
    path.setAttribute("stroke", "none");
  }
  return path;
}

// One shape onto an SVG group and, for words, a positioned box beside it.
function buildShapeNodes(record, shape, viewport, { preview = false } = {}) {
  const toPoint = viewportMapper(viewport);
  const scale = viewport.scale || 1;
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", `${PDF_SHAPE_CLASS}${preview ? " is-preview" : ""}`);
  if (record?.id) group.dataset.highlightId = record.id;
  group.dataset.shapeType = shape.type;
  const boxes = [];
  shapePrimitives(shape).forEach((prim) => {
    if (prim.kind === "poly") group.appendChild(svgPathFor(prim, toPoint, scale));
    else if (prim.kind === "sticky") stickyIconPolys(prim.rect, prim.color).forEach((poly) => group.appendChild(svgPathFor(poly, toPoint, scale)));
    else if (prim.kind === "text") {
      const box = document.createElement("div");
      box.className = "pdf-shape-text";
      if (record?.id) box.dataset.highlightId = record.id;
      const at = screenRect(viewport, prim.rect);
      box.style.left = `${at.left}px`;
      box.style.top = `${at.top}px`;
      // Typewriter text is as wide as its longest line, on screen as in the
      // editor it was typed in, so the two cannot wrap differently.
      if (prim.fit) box.dataset.fit = "";
      else box.style.width = `${at.width}px`;
      box.style.minHeight = `${at.height}px`;
      box.style.padding = `${SHAPE_TEXT_PAD * scale}px`;
      box.style.fontSize = `${prim.size * scale}px`;
      box.style.fontWeight = prim.bold ? "700" : "400";
      box.style.textAlign = prim.align;
      box.style.color = prim.color;
      box.textContent = prim.text;
      boxes.push(box);
    }
  });
  return { group, boxes };
}

function buildHandles(layer, viewport, record, put = (node) => layer.appendChild(node)) {
  const toPoint = viewportMapper(viewport);
  const bounds = shapeBounds(record.shape);
  if (bounds) {
    const at = screenRect(viewport, bounds);
    const frame = document.createElement("div");
    frame.className = "pdf-shape-frame";
    frame.style.left = `${at.left}px`;
    frame.style.top = `${at.top}px`;
    frame.style.width = `${at.width}px`;
    frame.style.height = `${at.height}px`;
    put(frame);
  }
  shapeHandles(record.shape).forEach((handle) => {
    const [x, y] = toPoint([handle.x, handle.y]);
    const node = document.createElement("div");
    node.className = "pdf-shape-handle";
    node.dataset.handle = handle.id;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    put(node);
  });
}

// Every shape on one page, rebuilt. Called as the page paints (through
// paintDocumentHighlights, which every CRUD on the records already repaints)
// and as the selection or a drag changes.
export function paintDocumentShapes(pageNumber, { preview = null } = {}) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return;
  const shapes = documentShapes(pageNumber);
  const existing = shapeLayer(pageNumber, false);
  if (!shapes.length && !preview && !existing) return;
  const layer = existing || shapeLayer(pageNumber);
  if (!layer) return;
  // Everything but an open text editor, which must not lose its focus (and with
  // it the words being typed) to a repaint — the new nodes go in under it.
  const editor = layer.querySelector(":scope > .pdf-shape-editor");
  [...layer.children].forEach((node) => { if (node !== editor) node.remove(); });
  const put = (node) => (editor ? layer.insertBefore(node, editor) : layer.appendChild(node));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "pdf-shape-svg");
  svg.setAttribute("width", String(viewport.width));
  svg.setAttribute("height", String(viewport.height));
  svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
  svg.setAttribute("aria-hidden", "true");
  put(svg);
  const boxes = [];
  shapes.forEach((record) => {
    // The shape being dragged is drawn where the drag has it, not where it is.
    const shape = preview && preview.id === record.id ? preview.shape : normalizeShape(record.shape);
    const built = buildShapeNodes(record, shape, viewport);
    svg.appendChild(built.group);
    boxes.push(...built.boxes);
  });
  if (preview && !preview.id) {
    const built = buildShapeNodes(null, preview.shape, viewport, { preview: true });
    svg.appendChild(built.group);
    boxes.push(...built.boxes);
  }
  boxes.forEach((box) => put(box));
  const selected = selectedShapeRecord();
  if (selected && Number(selected.page) === Number(pageNumber) && !editingShapeId) {
    const shape = preview && preview.id === selected.id ? preview.shape : selected.shape;
    buildHandles(layer, viewport, { ...selected, shape }, put);
  }
  shapePaintedHook(pageNumber, layer);
}

let shapePaintedHook = () => {};

// The text editor (src/documents/pdf-shape-text.js) re-mounts itself over a
// repaint. Registered, as everything that this module's painting is told about.
export function setShapePaintedHook(fn) {
  shapePaintedHook = typeof fn === "function" ? fn : () => {};
}

export function repaintDocumentShapes() {
  document.querySelectorAll(`.pdf-page[data-page-number]`).forEach((pageEl) => {
    const pageNumber = Number(pageEl.dataset.pageNumber);
    if (pageNumber) paintDocumentShapes(pageNumber);
  });
}

// ── Where a press is ──────────────────────────────────────────────────────

function shapePageAt(clientX, clientY) {
  const pages = document.elementsFromPoint(clientX, clientY);
  for (const node of pages) {
    const pageEl = node.closest?.(".pdf-page[data-page-number]");
    if (pageEl && el.documentView?.contains(pageEl)) return pageEl;
  }
  return null;
}

function pdfPointOn(pageNumber, pageEl, clientX, clientY) {
  const viewport = pdfPageViewport(pageNumber);
  if (!viewport) return null;
  const box = pageEl.getBoundingClientRect();
  return viewport.convertToPdfPoint(clientX - box.left, clientY - box.top);
}

// The topmost shape under a point on a page, if any — the last drawn is on top.
export function shapeAtPoint(pageNumber, x, y, reachPx = SHAPE_HIT_REACH) {
  const viewport = pdfPageViewport(pageNumber);
  const slack = reachPx / (viewport?.scale || 1);
  const shapes = documentShapes(pageNumber);
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (shapeHitsPoint(shapes[i].shape, x, y, slack)) return shapes[i];
  }
  return null;
}

function handleAt(record, pageEl, clientX, clientY) {
  const viewport = pdfPageViewport(Number(record.page));
  if (!viewport) return null;
  const box = pageEl.getBoundingClientRect();
  const toPoint = viewportMapper(viewport);
  let best = null;
  shapeHandles(record.shape).forEach((handle) => {
    const [sx, sy] = toPoint([handle.x, handle.y]);
    const d = Math.hypot(box.left + sx - clientX, box.top + sy - clientY);
    if (d <= SHAPE_HANDLE_REACH && (!best || d < best.d)) best = { id: handle.id, d };
  });
  return best?.id || null;
}

// ── Placed, not drawn ─────────────────────────────────────────────────────
//
// Text and a sticky note from the bar's + menu: put at `at` (a point in PDF
// space, the middle of the page in view) and opened straight away, the same as
// a tap with the tool. The way in for a reader with no pen and no mouse — a
// finger, which never draws.
export function placeShapeInView(type, pageNumber, at) {
  if ((type !== "text" && type !== "sticky") || !pdfPageViewport(pageNumber) || !at) return null;
  const from = type === "text" ? [at.x - 80, at.y + 14] : [at.x, at.y];
  const shape = shapeFromDrag(type, from, from, { base: newShapeBase(type) });
  const record = shape && addDocumentShape(pageNumber, shape);
  if (record) shapeOpenedHandler(record);
  return record;
}

// ── The gesture ───────────────────────────────────────────────────────────

let shapePress = null;
let suppressShapeClickUntil = 0;
let editingShapeId = null;

// The text editor says which shape it is writing in, so no handles are drawn
// over the words and a press inside it is the editor's.
export function setEditingShapeId(id) {
  editingShapeId = id || null;
}

export function isShapeToolArmed() {
  return inkTool() === "shape";
}

function shapeTakesPointer(event) {
  if (!isShapeToolArmed() || isEraserEvent(event)) return false;
  if (event.pointerType === "pen") return true;
  if (event.pointerType === "mouse") return isInkArmed();
  return false;
}

// Presses that belong to something else on the page.
const SHAPE_PRESS_EXCLUDED = "button, a[href], input, textarea, select, label, .pdf-note-badge, .pdf-block, .pdf-shape-editor, .ink-rail-popover";

let shapeOpenedHandler = () => {};
let shapeTextEditHandler = () => {};

// A tap on a callout or a text box that is already selected opens its words
// for editing (src/documents/pdf-shape-text.js, which imports this module and
// so registers itself).
export function setShapeTextEditHandler(fn) {
  shapeTextEditHandler = typeof fn === "function" ? fn : () => {};
}

// What a new callout, text box or sticky note opens straight after it is made —
// the text editor, or the note editor. Registered by src/main.js.
export function setShapeCreatedHandler(fn) {
  shapeOpenedHandler = typeof fn === "function" ? fn : () => {};
}

// A finger never draws — it scrolls — but a finger's TAP with Text or Sticky
// note armed is not a scroll, and is the one way a reader with no pen can put
// either on the page with the tool. Watched without taking the press, so a
// finger that moves is a scroll as it always was.
let shapeFingerTap = null;
export const SHAPE_FINGER_TAP_MS = 350;
export const SHAPE_FINGER_TAP_SLOP = 8;

function fingerPlacesShape(event) {
  if (event.pointerType !== "touch" || !event.isPrimary || !isShapeToolArmed()) return false;
  const type = shapeType();
  return type === "text" || type === "sticky";
}

function onShapeFingerDown(event) {
  shapeFingerTap = null;
  if (!fingerPlacesShape(event) || event.target?.closest?.(SHAPE_PRESS_EXCLUDED)) return;
  const pageEl = shapePageAt(event.clientX, event.clientY);
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page || !pdfPageViewport(page)) return;
  const point = pdfPointOn(page, pageEl, event.clientX, event.clientY);
  if (!point) return;
  // On a shape, a tap is for the shape (its menu), not for a new one — except
  // typed text with the typewriter armed, which a tap opens to type in.
  const hit = shapeAtPoint(page, point[0], point[1]);
  if (hit && !(hit.shape.type === "text" && shapeType() === "text")) return;
  shapeFingerTap = { pointerId: event.pointerId, page, point, x: event.clientX, y: event.clientY, at: Date.now(), edit: hit || null };
}

function onShapeFingerMove(event) {
  if (!shapeFingerTap || event.pointerId !== shapeFingerTap.pointerId) return;
  if (Math.hypot(event.clientX - shapeFingerTap.x, event.clientY - shapeFingerTap.y) > SHAPE_FINGER_TAP_SLOP) shapeFingerTap = null;
}

function onShapeFingerUp(event) {
  const tap = shapeFingerTap;
  shapeFingerTap = null;
  if (!tap || event.pointerId !== tap.pointerId || Date.now() - tap.at > SHAPE_FINGER_TAP_MS) return;
  suppressShapeClickUntil = Date.now() + 500;
  if (tap.edit) { shapeTextEditHandler(tap.edit); return; }
  if (selectedShapeId && shapeType() !== "text") { selectShape(null); return; }
  const type = shapeType();
  const shape = shapeFromDrag(type, tap.point, tap.point, { base: newShapeBase(type) });
  const record = shape && addDocumentShape(tap.page, shape);
  if (record) shapeOpenedHandler(record);
}

function onShapePointerDown(event) {
  if (shapePress) return;
  if (!shapeTakesPointer(event)) {
    // A press anywhere else, by anything, puts a selected shape down — unless it
    // is on the rail, whose panel is restyling it.
    if (selectedShapeId && !event.target?.closest?.(".document-ink-rail") && event.pointerType !== "pen") {
      const pageEl = shapePageAt(event.clientX, event.clientY);
      const page = Number(pageEl?.dataset.pageNumber);
      const point = page ? pdfPointOn(page, pageEl, event.clientX, event.clientY) : null;
      const hit = point ? shapeAtPoint(page, point[0], point[1]) : null;
      if (!hit || hit.id !== selectedShapeId) selectShape(null);
    }
    return;
  }
  if (event.button !== undefined && event.button > 0) return;
  if (event.target?.closest?.(SHAPE_PRESS_EXCLUDED)) return;
  const pageEl = shapePageAt(event.clientX, event.clientY);
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page || !pdfPageViewport(page)) return;
  const point = pdfPointOn(page, pageEl, event.clientX, event.clientY);
  if (!point) return;

  const selected = selectedShapeRecord();
  let mode = "create";
  let target = null;
  let handle = null;
  if (selected && Number(selected.page) === page) handle = handleAt(selected, pageEl, event.clientX, event.clientY);
  if (handle) {
    mode = "handle";
    target = selected;
  } else {
    const hit = shapeAtPoint(page, point[0], point[1]);
    if (hit) {
      mode = "move";
      target = hit;
    }
  }
  event.preventDefault();
  event.stopPropagation();
  setInkPenDown(true);
  try { el.documentView?.setPointerCapture?.(event.pointerId); } catch (_) { /* synthetic */ }
  el.documentView?.addEventListener("touchmove", onShapeTouchMove, { passive: false });
  shapePress = {
    pointerId: event.pointerId,
    page,
    pageEl,
    mode,
    target,
    handle,
    from: point,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    type: shapeType(),
    preview: null,
    // A press on bare paper while a shape was selected puts it down and
    // makes nothing — a tap to deselect is not a request for a text box.
    deselected: mode === "create" && Boolean(selectedShapeId) && shapeType() !== "text"
  };
  // Whether this shape was ALREADY the selected one — a second tap on a text
  // box is a request to type in it, the first only picks it up.
  shapePress.wasSelected = mode !== "create" && selectedShapeId === target.id;
  if (mode !== "create") selectShape(target.id);
  else if (selectedShapeId) selectShape(null);
}

function onShapeTouchMove(event) {
  if (shapePress) event.preventDefault();
}

function pressShape(drag, event) {
  const point = pdfPointOn(drag.page, drag.pageEl, event.clientX, event.clientY);
  if (!point) return null;
  const snap = currentShapeSettings().snap || event.shiftKey;
  if (drag.mode === "create") {
    return shapeFromDrag(drag.type, drag.from, point, { snap, base: newShapeBase(drag.type) });
  }
  if (drag.mode === "move") {
    return translateShape(drag.target.shape, point[0] - drag.from[0], point[1] - drag.from[1]);
  }
  // A line's end, with Shift, swings round its other end in 15° steps.
  const shape = drag.target.shape;
  let to = point;
  if (snap && /^p\d$/.test(drag.handle) && shape.p.length === 2) {
    const other = shape.p[drag.handle === "p0" ? 1 : 0];
    to = snapShapeAngle(other, point);
  }
  return moveShapeHandle(shape, drag.handle, to[0], to[1]);
}

function onShapePointerMove(event) {
  const drag = shapePress;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < SHAPE_TAP_SLOP) return;
  drag.moved = true;
  const shape = pressShape(drag, event);
  drag.preview = shape;
  if (!shape) { paintDocumentShapes(drag.page); return; }
  paintDocumentShapes(drag.page, { preview: { id: drag.mode === "create" ? null : drag.target.id, shape } });
}

function endShapePress() {
  const drag = shapePress;
  shapePress = null;
  setInkPenDown(false);
  el.documentView?.removeEventListener("touchmove", onShapeTouchMove, { passive: false });
  try { el.documentView?.releasePointerCapture?.(drag?.pointerId); } catch (_) { /* gone */ }
  return drag;
}

function onShapePointerUp(event) {
  const drag = shapePress;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  endShapePress();
  if (drag.mode === "create") {
    // A tap makes a text box or a sticky note where it lands; for anything
    // else a tap makes nothing (and puts a selection down, above).
    suppressShapeClickUntil = Date.now() + 400;
    if (!drag.moved && drag.deselected) return;
    const shape = drag.moved ? (drag.preview || pressShape(drag, event)) : shapeFromDrag(drag.type, drag.from, drag.from, { base: newShapeBase(drag.type) });
    if (!shape) { paintDocumentShapes(drag.page); return; }
    const record = addDocumentShape(drag.page, shape);
    if (!record) return;
    if (record.shape.type === "callout" || record.shape.type === "text" || record.shape.type === "sticky") {
      shapeOpenedHandler(record);
    } else {
      selectShape(record.id);
    }
    return;
  }
  if (!drag.moved) {
    const type = drag.target?.shape?.type;
    // With the typewriter armed, one tap on typed text is enough to type in it.
    if ((drag.wasSelected && (type === "callout" || type === "text")) || (type === "text" && shapeType() === "text")) {
      suppressShapeClickUntil = Date.now() + 400;
      shapeTextEditHandler(drag.target);
      return;
    }
    // A tap on a shape: it is selected (above), and the click that follows is
    // let through so its menu opens — the note, the card, Remove.
    paintDocumentShapes(drag.page);
    return;
  }
  suppressShapeClickUntil = Date.now() + 400;
  const shape = drag.preview || pressShape(drag, event);
  if (shape) updateShape(drag.target.id, shape);
  else paintDocumentShapes(drag.page);
}

function onShapePointerCancel(event) {
  const drag = shapePress;
  if (!drag || event.pointerId !== drag.pointerId) return;
  endShapePress();
  paintDocumentShapes(drag.page);
}

// The click a drag or a creation leaves behind is not a press on what is under
// it: no menu opens for the highlight under a shape that was just moved.
function onShapeClick(event) {
  if (Date.now() < suppressShapeClickUntil) {
    suppressShapeClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }
}

function typingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

// Delete, the arrows, Ctrl+D and Escape mean the selected shape. Capture, and
// only when one is selected and nothing is being typed into, so every other
// surface's keys are untouched.
function onShapeKeyDown(event) {
  if (!selectedShapeId || editingShapeId || typingTarget(event.target)) return;
  if (el.documentStage?.hidden) return;
  const key = event.key;
  const step = event.shiftKey ? 10 : 1;
  let handled = true;
  if (key === "Delete" || key === "Backspace") deleteShape();
  else if (key === "Escape") selectShape(null);
  else if (key === "ArrowLeft") nudgeShape(-step, 0);
  else if (key === "ArrowRight") nudgeShape(step, 0);
  else if (key === "ArrowUp") nudgeShape(0, step);
  else if (key === "ArrowDown") nudgeShape(0, -step);
  else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "d") duplicateShape();
  else handled = false;
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

// ── The eraser, crossing a shape ──────────────────────────────────────────
//
// The ink engine rubs out strokes; a shape is not a stroke, so it is crossed
// here, from the same press: with the eraser armed (or a stylus turned over),
// the path the eraser takes is tested against every shape on the page, and a
// shape it touches goes — one undo step each, on the same ring. Only when the
// eraser takes everything: set to the pen's ink or the highlighter's bands
// alone, it leaves shapes be, as it leaves the other kind of stroke.
let shapeEraser = null;

function eraserTakesShapes(event) {
  const erasing = isEraserEvent(event) || inkTool() === "eraser";
  if (!erasing || inkEraseTarget() !== "all") return false;
  if (event.pointerType === "pen") return true;
  return event.pointerType === "mouse" && isInkArmed();
}

function eraseShapesAlong(event) {
  const eraser = shapeEraser;
  const point = pdfPointOn(eraser.page, eraser.pageEl, event.clientX, event.clientY);
  if (!point) return;
  const from = eraser.last || point;
  eraser.last = point;
  const viewport = pdfPageViewport(eraser.page);
  const slack = SHAPE_HIT_REACH / (viewport?.scale || 1);
  documentShapes(eraser.page).forEach((record) => {
    if (shapeCrossesSegment(record.shape, from, point, slack)) deleteShape(record.id);
  });
}

function onShapeEraserDown(event) {
  if (!eraserTakesShapes(event)) return;
  const pageEl = shapePageAt(event.clientX, event.clientY);
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page || !documentShapes(page).length) return;
  shapeEraser = { pointerId: event.pointerId, page, pageEl, last: null };
  eraseShapesAlong(event);
}

function onShapeEraserMove(event) {
  if (!shapeEraser || event.pointerId !== shapeEraser.pointerId) return;
  const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  (samples.length ? samples : [event]).forEach(eraseShapesAlong);
}

function onShapeEraserUp(event) {
  if (shapeEraser && event.pointerId === shapeEraser.pointerId) shapeEraser = null;
}

// Whether a press would start or move a shape — for the toast that lets a pen
// pass through it (src/ui/feedback.js), and for checks.
export function shapeClaimsPointer(event) {
  return shapeTakesPointer(event);
}

export function initDocumentShapes() {
  setDocumentShapePainter(paintDocumentShapes);
  const view = el.documentView;
  if (!view) return;
  view.addEventListener("pointerdown", onShapePointerDown, true);
  // Passive, and not capture-stopped: the ink layer owns the eraser's press,
  // and this only watches where it goes.
  view.addEventListener("pointerdown", onShapeEraserDown, { capture: true, passive: true });
  view.addEventListener("pointermove", onShapeEraserMove, { capture: true, passive: true });
  window.addEventListener("pointerup", onShapeEraserUp, { passive: true });
  window.addEventListener("pointercancel", onShapeEraserUp, { passive: true });
  view.addEventListener("pointermove", onShapePointerMove, true);
  view.addEventListener("pointerup", onShapePointerUp, true);
  view.addEventListener("pointercancel", onShapePointerCancel, true);
  view.addEventListener("click", onShapeClick, true);
  view.addEventListener("pointerdown", onShapeFingerDown, { capture: true, passive: true });
  view.addEventListener("pointermove", onShapeFingerMove, { capture: true, passive: true });
  view.addEventListener("pointerup", onShapeFingerUp, { capture: true, passive: true });
  view.addEventListener("pointercancel", () => { shapeFingerTap = null; }, { capture: true, passive: true });
  view.addEventListener("lostpointercapture", (event) => {
    if (shapePress && event.pointerId === shapePress.pointerId) onShapePointerCancel(event);
  });
  document.addEventListener("keydown", onShapeKeyDown, true);
}

// The label a shape is listed under — re-exported for the pane, which names a
// record without importing the geometry.
export function documentShapeLabel(record) {
  return shapeLabel(record?.shape);
}
