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
  SHAPE_DEFAULTS, SHAPE_HEADS, SHAPE_ROTATABLE, SHAPE_TYPES, moveShapeHandle, normalizeShape, normalizeShapeHex,
  normalizeShapeRotation, polyPathData, positiveNumber, shapeBounds, shapeCrossesSegment, shapeDashArray, shapeFromDrag, shapeHandles, shapeHitsPoint, shapeLabel, shapePrimitives,
  shapeTextRect, shapeTypeDefaults, snapShapeAngle, stickyIconPolys, translateShape
} from "../render/annot-shapes.js?v=__BUILD__";
import { inkPreferences, writeInkPreferences } from "../storage/ink-prefs.js?v=__BUILD__";
import { PDF_SHAPE_TEXT_CLASS } from "../core/constants.js?v=__BUILD__";
import { mountShapeTextBody, setShapeTextRenderedHandler, shapeTextBodyState, styleShapeTextBox } from "./pdf-shape-markdown.js?v=__BUILD__";
import { notePdfGesture } from "./pdf-timing.js?v=__BUILD__";
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
    // Typed text: whether its words wrap at the box's width (or grow with
    // them, a line per Enter), and whether the box has an outline — of its
    // own colour and width, apart from an arrow's.
    wrap: false,
    textBorder: false,
    textBorderColor: "#16181d",
    textBorderWidth: 1,
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
    wrap: raw.wrap === true,
    textBorder: raw.textBorder === true,
    textBorderColor: normalizeShapeHex(raw.textBorderColor) || base.textBorderColor,
    textBorderWidth: positiveNumber(raw.textBorderWidth, base.textBorderWidth),
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

// A patch of settings. With a shape selected — or its words open to type in —
// it restyles that shape as well: "make THIS that", as a press on a swatch with
// a lasso selection does, and the next shape carries on in the same style.
export function setShapeSettings(patch = {}) {
  const before = currentShapeSettings();
  const next = { ...before, ...patch };
  if (patch.heads) next.heads = { ...before.heads, ...patch.heads };
  const shapeSettings = normalizeShapeSettings(next);
  shapeSettingsBySurface.set(shapeSurface(), shapeSettings);
  writeInkPreferences({ shape: shapeSettings }, shapeSurface());
  const selected = targetShapeRecord();
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
    if (selected.shape.type === "text") Object.assign(restyle, textRestyle(selected, patch, shapeSettings, font));
    if (Object.keys(font).length) restyle.font = { ...selected.shape.font, ...font };
    if (Object.keys(restyle).length) updateShape(selected.id, { ...selected.shape, ...restyle });
  }
  shapeChangedHandler();
}

// Wrap, border and the border's look, for one piece of typed text. A border is
// drawn in the shape's `stroke` — which older text also took its words' colour
// from — so the words' colour is pinned first, and an outline never recolours
// the text inside it. Turning the border on gives it the tool's border colour
// and width, rather than the hairline a borderless text box is stored with.
function textRestyle(selected, patch, settings, font) {
  const restyle = {};
  const shape = normalizeShape(selected.shape);
  if ("wrap" in patch) {
    restyle.fit = !settings.wrap;
    // Measured to its words on the next frame, plain or not: back to growing,
    // the box is the words; wrapping, it is as tall as the lines they now take.
    shapeTextRefitIds.add(selected.id);
  }
  const drawsBorder = ("textBorder" in patch) ? settings.textBorder : shape.border === true;
  if ("textBorder" in patch) restyle.border = settings.textBorder;
  if ("textBorderColor" in patch || ("textBorder" in patch && drawsBorder)) restyle.stroke = settings.textBorderColor;
  if ("textBorderWidth" in patch || ("textBorder" in patch && drawsBorder)) restyle.width = settings.textBorderWidth;
  if (restyle.stroke && !shape.font.color && !("color" in font)) font.color = shape.stroke;
  return restyle;
}

// ── Turning a box ─────────────────────────────────────────────────────────
//
// A turn is the shape's own, not the tool's: the next box is drawn upright
// whatever the last one was turned to. One undo step each.
export function setShapeRotation(deg, id = targetShapeRecord()?.id) {
  const record = id ? documentHighlightById(id) : null;
  const shape = normalizeShape(record?.shape);
  if (!record || record.kind !== "shape" || !shape || !SHAPE_ROTATABLE.includes(shape.type)) return false;
  const next = { ...shape, rot: normalizeShapeRotation(deg) };
  if (!next.rot) delete next.rot;
  const changed = updateShape(id, next);
  shapeChangedHandler();
  return changed;
}

export function rotateShapeBy(delta, id = targetShapeRecord()?.id) {
  const record = id ? documentHighlightById(id) : null;
  return setShapeRotation((normalizeShape(record?.shape)?.rot || 0) + Number(delta || 0), id);
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
    base.fit = !s.wrap;
    base.border = s.textBorder;
    base.stroke = s.textBorderColor;
    base.width = s.textBorder ? s.textBorderWidth : 0.3;
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

// The shape a style change is about: the one selected, or the one whose words
// are open in the text editor (which deselects it, so no handles sit over the
// words being typed — but a press on A+ mid-sentence still means THAT text).
export function targetShapeRecord() {
  const selected = selectedShapeRecord();
  if (selected) return selected;
  if (!editingShapeId) return null;
  const record = documentHighlightById(editingShapeId);
  return record?.kind === "shape" ? record : null;
}

// Where a shape is on screen, in client pixels — what a popover about it is
// placed against. From its geometry and its page's box, not from its painted
// nodes, so it is right mid-repaint and while its words are being edited.
export function shapeScreenRect(record) {
  const page = Number(record?.page);
  const viewport = page ? pdfPageViewport(page) : null;
  const pageEl = page ? pdfPageElement(page) : null;
  const bounds = record?.shape ? shapeBounds(normalizeShape(record.shape)) : null;
  if (!viewport || !pageEl || !bounds) return null;
  const box = pageEl.getBoundingClientRect();
  const at = screenRect(viewport, bounds);
  const left = box.left + at.left;
  const top = box.top + at.top;
  return { left, top, right: left + at.width, bottom: top + at.height, width: at.width, height: at.height };
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
  const selected = targetShapeRecord();
  const s = normalizeShape(selected?.shape);
  if (!s) return tool;
  const heads = { ...tool.heads };
  if (heads[s.type]) heads[s.type] = s.heads;
  return normalizeShapeSettings({
    ...tool, stroke: s.stroke, width: s.width, opacity: s.opacity, dash: s.dash,
    fill: s.fill, fillOpacity: s.fillOpacity, heads, fontSize: s.font.size, bold: s.font.bold, align: s.font.align,
    textColor: s.type === "text" ? (s.font.color || s.stroke) : tool.textColor,
    stickyColor: s.type === "sticky" ? s.stroke : tool.stickyColor,
    wrap: s.type === "text" ? !s.fit : tool.wrap,
    textBorder: s.type === "text" ? s.border === true : tool.textBorder,
    textBorderColor: s.type === "text" && s.border ? s.stroke : tool.textBorderColor,
    textBorderWidth: s.type === "text" && s.border ? s.width : tool.textBorderWidth
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
      // The words, as MARKDOWN (src/documents/pdf-shape-markdown.js): styled
      // from the shape's font by the same function the static copy in a
      // picture uses, and filled with a body rendered once per text — adopted
      // from the cache on every repaint after the first, so a drag moves a
      // rendered node and renders nothing.
      const box = document.createElement("div");
      box.className = PDF_SHAPE_TEXT_CLASS;
      if (record?.id) box.dataset.highlightId = record.id;
      box.dataset.shapeType = shape.type;
      styleShapeTextBox(box, prim, viewport);
      mountShapeTextBody(box, preview ? null : record?.id, prim.text);
      boxes.push(box);
    }
  });
  return { group, boxes };
}

// How far above a box's top edge its turning handle sits, in CSS pixels.
export const SHAPE_ROTATE_HANDLE_GAP = 24;

// The handles of a selected shape, with the turning handle placed a fixed
// distance from the box on screen whatever the zoom.
function selectedShapeHandles(shape, viewport) {
  return shapeHandles(shape, { rotateReach: SHAPE_ROTATE_HANDLE_GAP / (viewport?.scale || 1) });
}

function buildHandles(layer, viewport, record, put = (node) => layer.appendChild(node)) {
  const toPoint = viewportMapper(viewport);
  const s = normalizeShape(record.shape);
  // A turned box is framed by its own outline, turned with it; anything else
  // by the box round everything it covers.
  const turned = Boolean(s?.rot);
  const pad = turned ? s.width / 2 + 1 : 0;
  const frameRect = turned ? (([x0, y0, x1, y1]) => [x0 - pad, y0 - pad, x1 + pad, y1 + pad])(shapeTextRect(s)) : shapeBounds(record.shape);
  if (frameRect) {
    const at = screenRect(viewport, frameRect);
    const frame = document.createElement("div");
    frame.className = "pdf-shape-frame";
    frame.style.left = `${at.left}px`;
    frame.style.top = `${at.top}px`;
    frame.style.width = `${at.width}px`;
    frame.style.height = `${at.height}px`;
    if (turned) frame.style.transform = `rotate(${-s.rot}deg)`;
    put(frame);
  }
  const handles = selectedShapeHandles(record.shape, viewport);
  const turn = handles.find((handle) => handle.id === "rot");
  const top = handles.find((handle) => handle.id === "n");
  if (turn && top) {
    // The stem from the top edge to the turning handle.
    const [ax, ay] = toPoint([top.x, top.y]);
    const [bx, by] = toPoint([turn.x, turn.y]);
    const stem = document.createElement("div");
    stem.className = "pdf-shape-rotate-stem";
    stem.style.left = `${ax}px`;
    stem.style.top = `${ay}px`;
    stem.style.width = `${Math.hypot(bx - ax, by - ay)}px`;
    stem.style.transform = `rotate(${Math.atan2(by - ay, bx - ax)}rad)`;
    put(stem);
  }
  handles.forEach((handle) => {
    const [x, y] = toPoint([handle.x, handle.y]);
    const node = document.createElement("div");
    node.className = `pdf-shape-handle${handle.id === "rot" ? " is-rotate" : ""}`;
    node.dataset.handle = handle.id;
    if (handle.id === "rot") node.title = "Turn — drag round; Shift for 15° steps";
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
  // Never mid-drag: the box being dragged is a preview, and measuring every
  // frame is a forced layout per frame for an answer the drop will repeat.
  if (!shapePress) scheduleShapeTextFit(pageNumber);
}

// ── A text box is as big as its rendered words ─────────────────────────────
//
// The record stores the box's rectangle, and that rectangle is what a press is
// hit-tested against (shapeHitsPoint), what the Highlights pane crops to and
// what a picture or an export draws the words into. For plain text it was set
// once, from the editor the words were typed in, and the box shows the same
// words the same way — so they agree. RENDERED markdown does not: "**bold**"
// shows four characters narrower, a heading or a formula a different height. So
// once a box's markdown has rendered, its size is measured and, if it disagrees
// with the record by more than a point, written back — typewriter text to its
// exact size (top-left fixed, as the reader tapped it), a sized box only ever
// downwards, never cropping what the reader chose.
//
// Not an undo step: this is the record agreeing with its own words, not a
// change the reader made (the same rule as queueFit in pdf-blocks.js). Batched
// per page and a frame away, because it is called from inside a paint and the
// write repaints.
const SHAPE_TEXT_FIT_SLACK = 1;

const shapeTextFitPages = new Set();
let shapeTextFitFrame = 0;

// Text switched back to growing with its words, measured on the next pass even
// if its words are plain (whose size is otherwise the one they were typed at).
const shapeTextRefitIds = new Set();

// A node's box on screen as laid out, BEFORE any CSS turn: a turned node's
// getBoundingClientRect is the upright box round the turned one, which is not
// the box the record stores. Measured from offsets (scaled by however the page
// itself is scaled on screen); an unturned node is measured as it always was.
export function untransformedClientRect(node, pageEl) {
  const plain = node.getBoundingClientRect();
  if (!node.style.transform || !pageEl) return plain;
  const pageBox = pageEl.getBoundingClientRect();
  const k = pageEl.offsetWidth ? pageBox.width / pageEl.offsetWidth : 1;
  let left = 0;
  let top = 0;
  let at = node;
  while (at && at !== pageEl) {
    left += at.offsetLeft;
    top += at.offsetTop;
    at = at.offsetParent;
  }
  if (at !== pageEl) return plain;
  const width = node.offsetWidth * k;
  const height = node.offsetHeight * k;
  const x = pageBox.left + left * k;
  const y = pageBox.top + top * k;
  return { left: x, top: y, right: x + width, bottom: y + height, width, height };
}

function scheduleShapeTextFit(pageNumber) {
  if (!pageNumber) return;
  shapeTextFitPages.add(Number(pageNumber));
  if (shapeTextFitFrame) return;
  shapeTextFitFrame = requestAnimationFrame(() => {
    shapeTextFitFrame = 0;
    const pages = [...shapeTextFitPages];
    shapeTextFitPages.clear();
    pages.forEach(fitShapeTextBoxes);
  });
}

setShapeTextRenderedHandler((id) => {
  const record = documentHighlightById(id);
  if (record) scheduleShapeTextFit(Number(record.page));
});

function fitShapeTextBoxes(pageNumber) {
  if (shapePress) return;
  const layer = shapeLayer(pageNumber, false);
  const viewport = pdfPageViewport(pageNumber);
  const pageEl = pdfPageElement(pageNumber);
  if (!layer || !viewport || !pageEl) return;
  const pageBox = pageEl.getBoundingClientRect();
  if (!pageBox.width || !pageBox.height) return;
  const writes = [];
  layer.querySelectorAll(`:scope > .${PDF_SHAPE_TEXT_CLASS}[data-highlight-id]`).forEach((box) => {
    const id = box.dataset.highlightId;
    if (!id || id === editingShapeId) return;
    // Only a box whose markdown has FINISHED: a plain one that grows with its
    // words keeps the size it was typed at (exactly as before markdown), and a
    // pending one is showing a placeholder that is about to be replaced.
    const state = shapeTextBodyState(id);
    const record = documentHighlightById(id);
    const shape = normalizeShape(record?.shape);
    if (!shape || (shape.type !== "text" && shape.type !== "callout")) return;
    // Plain words in a box that WRAPS are measured too: such a box only ever
    // grows down to its lines (shapeFittedToBox), and words spilling out of
    // the bottom of a border are plainly wrong.
    const plainOk = state === "plain" && (shapeTextRefitIds.has(id) || (shape.type === "text" && !shape.fit));
    if (state !== "rendered" && state !== "failed" && !plainOk) return;
    shapeTextRefitIds.delete(id);
    const next = shapeFittedToBox(shape, untransformedClientRect(box, pageEl), pageBox, viewport);
    if (next) writes.push({ id, shape: next });
  });
  writes.forEach(({ id, shape }) => {
    notePdfGesture("text", "fitted to its words", { id, page: pageNumber });
    updateShape(id, shape, { undo: false });
  });
}

// The shape with its box brought to the measured one, or null when they agree.
function shapeFittedToBox(shape, measured, pageBox, viewport) {
  if (!measured.width || !measured.height) return null;
  const [x0, y0, x1, y1] = [Math.min(shape.p[0][0], shape.p[1][0]), Math.min(shape.p[0][1], shape.p[1][1]),
    Math.max(shape.p[0][0], shape.p[1][0]), Math.max(shape.p[0][1], shape.p[1][1])];
  if (shape.fit) {
    const [ax, ay] = viewport.convertToPdfPoint(measured.left - pageBox.left, measured.top - pageBox.top);
    const [bx, by] = viewport.convertToPdfPoint(measured.right - pageBox.left, measured.bottom - pageBox.top);
    const fitted = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    const same = [x0, y0, x1, y1].every((value, i) => Math.abs(value - fitted[i]) <= SHAPE_TEXT_FIT_SLACK);
    if (same) return null;
    return { ...shape, p: [[fitted[0], fitted[1]], [fitted[2], fitted[3]], ...shape.p.slice(2)] };
  }
  const needed = measured.height / (viewport.scale || 1);
  if (needed <= (y1 - y0) + SHAPE_TEXT_FIT_SLACK) return null;
  // Down, never up: the box's top edge is where the reader put it.
  const p = shape.p.map((point) => point.slice());
  const lowIndex = p[0][1] <= p[1][1] ? 0 : 1;
  p[lowIndex][1] = y1 - needed;
  return { ...shape, p };
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
  selectedShapeHandles(record.shape, viewport).forEach((handle) => {
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
  const next = id || null;
  if (next === editingShapeId) return;
  editingShapeId = next;
  // The style popover follows the text being typed in, as it follows a
  // selection (src/documents/pdf-shape-style-popover.js).
  shapeChangedHandler();
}

// Which shape's words are open in the text editor, if any — said by the
// editor (setEditingShapeId) before its own state is set up, so this is the
// earliest truthful answer to "is the reader typing in a shape".
export function editingShapeTextId() {
  return editingShapeId;
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
  // A press that picked a text box up (onShapePointerDown, which runs first)
  // is that gesture's — its tap is answered by onShapePointerUp, and answering
  // it here too would open the editor twice.
  if (shapePress) return;
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
  // One box per press of T — see onShapePointerDown.
  if (!hit && editingShapeId && shapeType() === "text") return;
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

// ── Picked up with no tool armed ────────────────────────────────────────────
//
// "The text elements written on top of PDFs are too difficult to move once
// written." They were: a shape answered a press only with the Shapes or Text
// tool armed, and then only for a stylus — or a mouse with the pen's bar open —
// so a finger could never move one, and with the tool put away nothing could.
// The words typed with the Text button are a thing the reader PUT on the page,
// like a text block or a picture, and they are picked up the same way: a press
// on the box, with any pointer, whatever is armed.
//
//   press and drag   moves it (clamped so it cannot be lost off the page)
//   tap              selects it — its handles, and the small Style bar
//   tap again        types in it (a double-click, the same)
//   a handle of the selected shape, dragged, resizes it — with any pointer too
//
// `.pdf-shape-text` takes the press (styles/88-annotations.css), so the press's
// target says which box; the ink, the selection controller and region select
// stand down for it (PDF_PICKUP_SELECTOR, src/core/constants.js). The eraser is
// the one exception: rubbing across a box still rubs it out.
function pickupAt(event) {
  if (isEraserEvent(event) || inkTool() === "eraser") return null;
  if (event.button !== undefined && event.button > 0) return null;
  if (event.pointerType === "touch" && event.isPrimary === false) return null;
  const box = event.target?.closest?.(`.${PDF_SHAPE_TEXT_CLASS}[data-highlight-id]:not(.is-static)`);
  const pageEl = (box || event.target)?.closest?.(".pdf-page[data-page-number]") || null;
  const page = Number(pageEl?.dataset.pageNumber);
  if (!page || !el.documentView?.contains(pageEl)) return null;
  const selected = selectedShapeRecord();
  if (selected && Number(selected.page) === page) {
    const handle = handleAt(selected, pageEl, event.clientX, event.clientY);
    if (handle) return { mode: "handle", target: selected, handle, page, pageEl };
  }
  if (!box) return null;
  const record = documentHighlightById(box.dataset.highlightId);
  if (!record || record.kind !== "shape" || !normalizeShape(record.shape)) return null;
  return { mode: "move", target: record, handle: null, page, pageEl };
}

function onShapePointerDown(event) {
  if (shapePress) return;
  const pickup = shapeTakesPointer(event) ? null : pickupAt(event);
  if (pickup) {
    beginShapePress(event, pickup);
    return;
  }
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
  // Text is one box per press of T. A press on bare paper while those words are
  // still being typed puts them down (the editor's blur commits them, and that
  // puts the Text tool away — src/ui/ink-rail.js) and starts nothing new: it is
  // the reader saying they have finished, not asking for a second box.
  if (mode === "create" && editingShapeId && shapeType() === "text") return;
  beginShapePress(event, { mode, target, handle, page, pageEl, point });
}

// The press, claimed: the pointer captured, the page told a pen is down (so it
// does not scroll or select under it), and the gesture's state set up. Shared
// by the tool's own presses and by a pick-up with no tool (pickupAt).
function beginShapePress(event, { mode, target = null, handle = null, page, pageEl, point = null }) {
  const from = point || pdfPointOn(page, pageEl, event.clientX, event.clientY);
  if (!from) return;
  event.preventDefault();
  event.stopPropagation();
  setInkPenDown(true);
  try { el.documentView?.setPointerCapture?.(event.pointerId); } catch (_) { /* synthetic */ }
  el.documentView?.addEventListener("touchmove", onShapeTouchMove, { passive: false });
  shapePress = {
    pointerId: event.pointerId,
    pointerType: event.pointerType || "",
    page,
    pageEl,
    mode,
    target,
    handle,
    from,
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
  if (mode !== "create") notePdfGesture("shape", `press (${mode})`, { id: target.id, pointer: shapePress.pointerType, page });
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
    const [dx, dy] = clampShapeMove(drag.target.shape, drag.page, point[0] - drag.from[0], point[1] - drag.from[1]);
    return translateShape(drag.target.shape, dx, dy);
  }
  // A line's end, with Shift, swings round its other end in 15° steps.
  const shape = drag.target.shape;
  let to = point;
  if (snap && /^p\d$/.test(drag.handle) && shape.p.length === 2) {
    const other = shape.p[drag.handle === "p0" ? 1 : 0];
    to = snapShapeAngle(other, point);
  }
  return moveShapeHandle(shape, drag.handle, to[0], to[1], { snap });
}

// ── Never off the page ─────────────────────────────────────────────────────
//
// A box dragged past the edge of the page is gone: nothing is drawn outside the
// page, so there is nothing left to press to bring it back. A move is held so
// at least this many points of the shape stay on the paper.
export const SHAPE_KEEP_ON_PAGE = 16;

function clampShapeMove(shape, pageNumber, dx, dy) {
  const viewport = pdfPageViewport(pageNumber);
  const bounds = shapeBounds(normalizeShape(shape));
  if (!viewport || !bounds) return [dx, dy];
  const [vx0, vy0, vx1, vy1] = viewport.viewBox;
  const keep = SHAPE_KEEP_ON_PAGE;
  const clamp = (value, low, high) => (low > high ? value : Math.min(high, Math.max(low, value)));
  return [
    clamp(dx, (vx0 + keep) - bounds[2], (vx1 - keep) - bounds[0]),
    clamp(dy, (vy0 + keep) - bounds[3], (vy1 - keep) - bounds[1])
  ];
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
  if (drag.mode !== "create") notePdfGesture("shape", drag.moved ? `${drag.mode === "move" ? "moved" : "reshaped"}` : "tapped", { id: drag.target?.id, pointer: drag.pointerType });
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
    // ARMED, not merely remembered: shapeType() stays "text" after Text is put
    // down, and a press picked up with the pen in hand (pickupAt) is a select.
    const typewriterArmed = isShapeToolArmed() && shapeType() === "text";
    if ((drag.wasSelected && (type === "callout" || type === "text")) || (type === "text" && typewriterArmed)) {
      suppressShapeClickUntil = Date.now() + 400;
      shapeTextEditHandler(drag.target);
      return;
    }
    // A tap on a shape: it is selected (above), and its style popover is up
    // at it (src/documents/pdf-shape-style-popover.js) — colour, size, line —
    // with its note, Delete and ⋯ for the rest of its menu. The click that
    // follows is swallowed, so the menu does not open on top of it. A sticky
    // note IS its note, so for one the click goes through and opens it.
    if (type !== "sticky") suppressShapeClickUntil = Date.now() + 400;
    paintDocumentShapes(drag.page);
    return;
  }
  suppressShapeClickUntil = Date.now() + 400;
  const shape = drag.preview || pressShape(drag, event);
  // Typed text given a new width wraps differently: its height is measured
  // again, plain words or not.
  if (shape && drag.mode === "handle" && shape.type === "text" && drag.handle !== "rot") shapeTextRefitIds.add(drag.target.id);
  if (shape) updateShape(drag.target.id, shape);
  else paintDocumentShapes(drag.page);
}

// The browser took the pointer back — a pan won, a system gesture, the capture
// lost. A move or a reshape that had already gone somewhere is KEPT where it
// got to, rather than snapped back: what the reader saw under their finger is
// where they left it, and a drag that silently undid itself is exactly "almost
// impossible to move". A shape being drawn is dropped, as it always was.
// Noted for ☰ → Diagnostics, because a cut-off drag is otherwise invisible.
function onShapePointerCancel(event) {
  const drag = shapePress;
  if (!drag || event.pointerId !== drag.pointerId) return;
  endShapePress();
  notePdfGesture("shape", "cancelled", { id: drag.target?.id, mode: drag.mode, pointer: drag.pointerType, cause: event.type, moved: drag.moved ? "yes" : "no" });
  if (drag.mode !== "create" && drag.moved && drag.preview) {
    suppressShapeClickUntil = Date.now() + 400;
    if (updateShape(drag.target.id, drag.preview)) return;
  }
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
  // The scroller's OWN capture, lost — not one bubbling up from inside it: a
  // finger's press is captured implicitly by what it landed on (a text box),
  // and taking the capture to the scroller is heard there as a lost capture.
  view.addEventListener("lostpointercapture", (event) => {
    if (event.target !== view) return;
    if (shapePress && event.pointerId === shapePress.pointerId) onShapePointerCancel(event);
  });
  document.addEventListener("keydown", onShapeKeyDown, true);
}

// The label a shape is listed under — re-exported for the pane, which names a
// record without importing the geometry.
export function documentShapeLabel(record) {
  return shapeLabel(record?.shape);
}
