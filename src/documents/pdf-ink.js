// Writing on the paper.
//
// The Document surface could already mark what an author wrote — a run of
// glyphs, or a box round a figure. It had nothing to say about the other half
// of reading a paper with a pen in your hand: the arrow from one column to the
// other, the question mark beside a step, the correction over a wrong sign, the
// two words in the margin that are the whole reason you will remember the page.
// None of those is a selection of anything, so none of them existed here.
//
// ── Ink is a highlight ─────────────────────────────────────────────────────
//
// A mark made here comes out the other end as an ordinary document highlight
// with `kind: "ink"`, in meta.pdfHighlights beside every other mark on the
// paper — the same argument pdf-region.js makes for `kind: "area"`, and for the
// same payoff. The Highlights pane lists it with a picture of what you drew,
// pressing it opens its note, the note is written into the same fenced block,
// the numbered badge on the page is the same badge, "+ Make card" is the same
// card, the annotated-PDF export paints it, mergePdfHighlights merges it by id
// across two devices, the tombstone bag remembers it was deleted, and the
// backup carries it. Not one of those needed teaching: a new field on a record
// rides along untouched, and `ink` is that field.
//
// What is stored is STROKES IN PDF USER SPACE, compactly encoded (see
// src/format/ink-strokes.js). That is what makes handwriting survive a zoom, a
// refit, a rotation, a reload and a different device with a different screen —
// the same reason a highlight is stored as quads and not as a box on the glass.
// The `quads` on the record are the bounding box of the strokes and nothing
// more: something for the thumbnail to crop to, the badge to sit on, and the
// export to find.
//
// ── The pen draws and the finger scrolls, with no mode to forget ───────────
//
// pdf-region.js is one-shot precisely because an inkRailArmed drawing mode is a
// surface you cannot scroll or select on, and it says so at length. Ink cannot
// be one-shot — you do not write one stroke — so it does the other thing: it is
// never inkRailArmed at all, and the pointer type decides.
//
//   pen    always draws. There is nothing to press first.
//   touch  never draws. Scrolling, pinching and press-and-slide to select are
//          exactly what they were, on every surface, untouched.
//   mouse  draws only while the ink rail is open, because a mouse has no other
//          way to say which it meant, and a laptop with no stylus should still
//          be able to draw.
//
// Palm rejection falls out of that for free: a hand resting on the glass is
// `touch`, and touch is a scroll gesture the app already understands rather
// than a smear across the page.
//
// ── A tap passes through ───────────────────────────────────────────────────
//
// A pen that always draws can no longer press a numbered note badge, open a
// highlight's menu or hit a button. So a press that ends within INK_TAP_SLOP
// pixels in under INK_TAP_MS is a TAP: the samples are thrown away, no ink is
// committed, and the browser's own click is allowed to happen. Nothing is
// synthesised and nothing is dispatched by hand — not calling preventDefault on
// the pointerdown is the whole mechanism, and it means a pen tap reaches every
// existing handler by the ordinary route rather than by a route this file would
// have to keep in step with them.
//
// ── The compatibility touch events, which are the hard part ────────────────
//
// A stylus on Android and an Apple Pencil on iPadOS both fire touch events
// alongside their pointer events. Two consequences, and neither is optional:
//
//   1. src/notes/touch-selection.js owns press-and-slide on this very element
//      and would see a pen as a finger, arming a text selection 240ms into a
//      stroke. Told to stand down through setInkPenDown in src/core/gesture.js
//      — a flag rather than a guess at touch radius, because the pen's own
//      pointerdown is the only place in the app that KNOWS it is a pen.
//   2. The scroller would scroll under the stroke. `touch-action` cannot fix
//      this: it is latched from the hit-tested element when the touch sequence
//      begins, so a class switched on at pointerdown is already too late, and
//      putting `touch-action: none` on the scroller permanently would take
//      flicking through the paper away from every finger. What DOES work is a
//      non-passive touchmove that calls preventDefault while a stroke is live —
//      the same lever touch-selection.js pulls for press-and-slide, for the
//      same reason.
//
// Deliberately not relying on the ORDER those two families arrive in. Chrome
// fires pointerdown before touchstart today; that is a detail of one engine's
// implementation, it could not be verified in this repo's headless harness, and
// this file works either way — the flag is set for the whole time the pen is in
// contact, and the touchmove guard reads the same flag.

import { PDF_INK_LAYER_CLASS } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { setInkPenDown } from "../core/gesture.js?v=__BUILD__";
import { QUAD_GEOMETRY_VERSION, documentInkMarks, freshDocumentHighlightId, setDocumentInkForPage } from "./pdf-highlights.js?v=__BUILD__";
import { REGION_CLASS } from "./pdf-region.js?v=__BUILD__";
import { pdfPageElement, pdfPageViewport } from "./pdf-view.js?v=__BUILD__";
import { INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkPen, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";
import { INK_FORMAT_VERSION, INK_MARK_IDLE_MS, decodeInkStrokes, encodeInkStrokes, inkStrokesBounds, inkStrokesJoinMark, mergeInkBoxes } from "../format/ink-strokes.js?v=__BUILD__";
import { inkSvgFile } from "../format/ink-svg.js?v=__BUILD__";
import { storeImageOrQueue } from "../images/outbox.js?v=__BUILD__";
import { createInkEngine } from "../render/ink-engine.js?v=__BUILD__";

// A press shorter and stiller than both of these was a tap, not a stroke.
// 150ms is under the 240ms the touch controller waits for a press, so the two
// decisions can never both be true; 4px is a hand that did not mean to move.
export const INK_TAP_MS = 150;
export const INK_TAP_SLOP = 4;

// On the stage while a stroke is being drawn, so the rail can get out from
// under the hand drawing it (styles/52-ink.css). Set when the press becomes a
// stroke rather than when the pen lands — a tap must not make the rail flinch.
export const INK_ACTIVE_CLASS = "is-inking";

// The filing colour an ink mark takes in the Highlights pane. Ink is drawn in
// pen colours and a mark can hold several of them, but the row beside the paper
// wears one of the four highlight tokens like every other row — so the pen is
// mapped to the nearest of them. Not cosmetic: a reader who marks corrections
// in red and questions in blue can still sort the list by what they meant.
const INK_FILING_COLOR = { ink: "yellow", red: "pink", blue: "blue", green: "green", amber: "yellow" };

let engine = null;
let press = null;
let inkRailArmed = false;
let activeRect = null;
let openMark = null;
let openMarkTimer = 0;
let swallowClickUntil = 0;
let onInkChanged = () => {};

export function setInkChangedHandler(fn) {
  onInkChanged = typeof fn === "function" ? fn : () => {};
}

// ── The engine ─────────────────────────────────────────────────────────────

function ensureEngine() {
  if (engine) return engine;
  engine = createInkEngine({
    // pdf.js's own page transform, which is the model-to-viewport matrix
    // already — scale, rotation and origin in one, so nothing in the engine or
    // the painter has to know a page can be turned on its side.
    getMatrix: (page) => pdfPageViewport(page)?.transform || null,
    getHostSize: (page) => {
      const viewport = pdfPageViewport(page);
      return viewport ? { width: viewport.width, height: viewport.height } : null;
    },
    // The page rect is measured ONCE, at pointerdown, and read from here for
    // every sample of the stroke. Measuring per sample is a forced layout per
    // sample on a path that runs at 240Hz, which is the thrash
    // src/notes/touch-selection.js had to take out of its own drag.
    toModel: (page, clientX, clientY) => {
      const viewport = pdfPageViewport(page);
      if (!viewport || !activeRect) return null;
      const [x, y] = viewport.convertToPdfPoint(clientX - activeRect.left, clientY - activeRect.top);
      return { x, y };
    },
    onCommit: (page, strokes, meta) => commitInkPage(page, strokes, meta),
    onSelectionChange: () => onInkChanged(),
    className: "pdf-ink-canvas"
  });
  return engine;
}

// ── Painting a page ────────────────────────────────────────────────────────

// The layer, the host and the strokes on it — the one place a page is made
// ready to be drawn on.
//
// Split out from paintDocumentInk because that function must NOT create a layer
// for a page with no ink (a three-hundred-page thesis with a note on page four
// would otherwise carry two hundred and ninety-nine canvases nobody asked for),
// and the pen must be able to draw on exactly such a page. Held together in one
// function, that was a chicken and egg with a very simple answer: the first
// stroke on any page could never start, because the host it needed did not
// exist until there was already ink on it.
//
// The strokes are re-read from the records every time. They are the source of
// truth, and there is never a live stroke at either call site — one runs as a
// page paints, the other as the nib lands — so this cannot overwrite work in
// progress. Without it a page whose marks had not been painted yet would begin
// with an empty engine, and the first commit would write that emptiness back
// over every mark already on the page.
function ensureInkLayer(pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return false;
  let layer = pageEl.querySelector(`.${PDF_INK_LAYER_CLASS}`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = PDF_INK_LAYER_CLASS;
    pageEl.appendChild(layer);
  }
  const active = ensureEngine();
  active.attachHost(pageNumber, layer);
  active.setStrokes(pageNumber, strokesForPage(pageNumber));
  return true;
}

// Called as each page finishes painting, through the page-painted hook — the
// same route the note badges take, and for the same reason: pdf-view.js must
// not import this module back.
export function paintDocumentInk(pageNumber) {
  const pageEl = pdfPageElement(pageNumber);
  if (!pageEl) return;
  // A page with no ink on it and no layer yet is left alone. A canvas is a
  // bitmap however empty it is, and the pen makes its own layer when it needs
  // one (see ensureInkLayer).
  if (!documentInkMarks(pageNumber).length && !pageEl.querySelector(`.${PDF_INK_LAYER_CLASS}`)) return;
  ensureInkLayer(pageNumber);
}

// Every stroke on a page, in record order, each tagged with the mark it belongs
// to. The tag is what makes the engine's flat array reversible: a lasso can
// move strokes and an eraser can take one out of the middle of a mark, and
// afterwards the groups are read back off the strokes themselves rather than
// reconstructed from indices that have since moved.
function strokesForPage(pageNumber) {
  const out = [];
  documentInkMarks(pageNumber).forEach((record) => {
    decodeInkStrokes(record.ink?.s).forEach((stroke) => out.push({ ...stroke, m: record.id }));
  });
  return out;
}

// ── Grouping ───────────────────────────────────────────────────────────────

function closeOpenMark() {
  openMark = null;
  if (openMarkTimer) { clearTimeout(openMarkTimer); openMarkTimer = 0; }
}

function markIdForNewStrokes(pageNumber, added) {
  const now = Date.now();
  const box = inkStrokesBounds(added);
  if (inkStrokesJoinMark(openMark, { page: pageNumber, box, now })) {
    openMark.lastAt = now;
    openMark.box = mergeInkBoxes(openMark.box, box);
  } else {
    openMark = { page: pageNumber, id: freshDocumentHighlightId(), startedAt: now, lastAt: now, box };
  }
  if (openMarkTimer) clearTimeout(openMarkTimer);
  // The timer only closes the mark; the rule above is what decides whether a
  // stroke joins it. Both, because a stroke can arrive before the timer fires
  // and still be too far away, and the timer has to close a mark nothing
  // follows at all.
  openMarkTimer = setTimeout(closeOpenMark, INK_MARK_IDLE_MS);
  return openMark.id;
}

// ── The write path ─────────────────────────────────────────────────────────

function commitInkPage(pageNumber, strokes, meta) {
  if (meta?.reason === "draw" && Array.isArray(meta.added) && meta.added.length) {
    const id = markIdForNewStrokes(pageNumber, meta.added);
    meta.added.forEach((stroke) => { stroke.m = id; });
  }
  // An undo or a restore can hand back strokes whose mark no longer exists, and
  // a stroke that arrived without a tag has nowhere to be filed. Both become
  // their own mark rather than being dropped: ink on screen that is in no
  // record is ink the reader loses on reload.
  let orphanId = "";
  strokes.forEach((stroke) => {
    if (stroke.m) return;
    if (!orphanId) orphanId = freshDocumentHighlightId();
    stroke.m = orphanId;
  });
  setDocumentInkForPage(pageNumber, buildInkRecords(pageNumber, strokes));
  onInkChanged();
}

function buildInkRecords(pageNumber, strokes) {
  const existing = new Map(documentInkMarks(pageNumber).map((record) => [record.id, record]));
  const order = [];
  const groups = new Map();
  strokes.forEach((stroke) => {
    if (!groups.has(stroke.m)) { groups.set(stroke.m, []); order.push(stroke.m); }
    groups.get(stroke.m).push(stroke);
  });

  return order.map((id) => {
    const group = groups.get(id);
    const encoded = encodeInkStrokes(group);
    if (!encoded.length) return null;
    const previous = existing.get(id);
    // Unchanged marks are returned BY REFERENCE. Every commit rebuilds every
    // mark on the page, and a new object with a new `at` for a mark nobody
    // touched would let one stroke on page 7 out-rank the same mark edited on
    // another device — which is the failure the two-clock work was about.
    if (previous && sameEncoding(previous.ink?.s, encoded)) return previous;
    const box = inkStrokesBounds(group);
    const record = {
      id,
      color: previous?.color || INK_FILING_COLOR[normalizeInkPen(group[group.length - 1]?.c)] || "yellow",
      page: pageNumber,
      // No anchor and no focus: ink is not a position in a run of glyphs, and
      // resolveDocumentAnchor already falls back to the quads for a record that
      // has none — which is how a region gets a "Go to" without one either.
      anchor: null,
      focus: null,
      text: "",
      quads: box ? [{ page: pageNumber, rect: [box.minX, box.minY, box.maxX, box.maxY] }] : [],
      kind: "ink",
      ink: { v: INK_FORMAT_VERSION, s: encoded },
      qv: QUAD_GEOMETRY_VERSION,
      at: Date.now()
    };
    if (previous?.noteAt) record.noteAt = previous.noteAt;
    return record;
  }).filter(Boolean);
}

function sameEncoding(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) { if (a[i] !== b[i]) return false; }
  return true;
}

// ── Pointer plumbing ───────────────────────────────────────────────────────

function inkTakesPointer(event) {
  if (event.pointerType === "pen") return true;
  // A mouse only draws when the reader has opened the rail, because a mouse has
  // no way of saying which it meant and a click that inked instead of selecting
  // would be a surprise on every desktop. A finger never draws.
  if (event.pointerType === "mouse") return inkRailArmed;
  return false;
}

function onInkPointerDown(event) {
  if (press || !inkTakesPointer(event)) return;
  if (event.button !== undefined && event.button > 0 && event.button !== 5) return;
  // The marquee is a drag of its own, and it is inkRailArmed deliberately. Asked of
  // the DOM rather than by calling isRegionSelectArmed so this file does not
  // have to be evaluated before that one.
  if (el.documentStage?.classList.contains(REGION_CLASS)) return;
  const pageEl = document.elementFromPoint(event.clientX, event.clientY)?.closest(".pdf-page");
  if (!pageEl) return;
  const page = Number(pageEl.dataset.pageNumber);
  if (!page || !pdfPageViewport(page)) return;

  // Set for the whole contact, tap included: a press timer allowed to run under
  // a pen that has not yet decided is a word selected mid-stroke.
  setInkPenDown(true);
  press = {
    pointerId: event.pointerId,
    page,
    pageEl,
    rect: pageEl.getBoundingClientRect(),
    startX: event.clientX,
    startY: event.clientY,
    startAt: Date.now(),
    samples: [event],
    live: false
  };
  // Deliberately no preventDefault. That is what leaves the browser free to
  // fire a click if this turns out to be a tap.
  try { el.documentView?.setPointerCapture?.(event.pointerId); } catch (_) { /* synthetic event */ }
}

function onInkPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  // A second contact is a pinch. The zoom handler in pdf-view.js is welcome to
  // it — the same concession pdf-region.js makes — and a stroke half drawn
  // while the page is scaling under it is not ink anyone wants kept.
  if (event.isPrimary === false) { cancelInkPress(); return; }

  if (press.live) { ensureEngine().move(event); return; }

  press.samples.push(event);
  const moved = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
  if (moved < INK_TAP_SLOP && (Date.now() - press.startAt) < INK_TAP_MS) return;

  activeRect = press.rect;
  // The page may never have been drawn on, in which case it has no layer yet.
  if (!ensureInkLayer(press.page)) { cancelInkPress(); return; }
  // Every sample taken while the app was still deciding is real ink and goes in
  // — without them a stroke visibly starts a few pixels after the nib landed.
  press.live = ensureEngine().begin(press.page, press.samples, event);
  if (!press.live) { cancelInkPress(); return; }
  // Only now, and not at pointerdown: a TAP must not make the rail flinch.
  el.documentStage?.classList.add(INK_ACTIVE_CLASS);
}

function onInkPointerUp(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (press.live) {
    const active = ensureEngine();
    active.move(event);
    active.end();
    // A stroke must not also press whatever it started on top of. A tap does
    // not reach here with `live` set, so its click is left alone.
    swallowClickUntil = Date.now() + 400;
  }
  releaseInkPress();
}

function onInkPointerCancel(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  cancelInkPress();
}

function cancelInkPress() {
  if (press?.live) ensureEngine().cancel();
  releaseInkPress();
}

function releaseInkPress() {
  el.documentStage?.classList.remove(INK_ACTIVE_CLASS);
  if (press) {
    try { el.documentView?.releasePointerCapture?.(press.pointerId); } catch (_) { /* already gone */ }
  }
  press = null;
  activeRect = null;
  setInkPenDown(false);
}

// The scroll guard. Non-passive, and it costs two property reads when there is
// no stroke of ours in flight — the same trade touch-selection.js makes on this
// very element for the same reason.
function onInkTouchMove(event) {
  if (!press?.live) return;
  if (event.cancelable) event.preventDefault();
}

function onInkClick(event) {
  if (Date.now() > swallowClickUntil) return;
  swallowClickUntil = 0;
  event.stopPropagation();
  event.preventDefault();
}

export function initDocumentInk() {
  const view = el.documentView;
  if (!view) return;
  // Capture, so the decision about who owns this pointer is made before any of
  // the handlers that would otherwise act on it.
  view.addEventListener("pointerdown", onInkPointerDown, true);
  view.addEventListener("pointermove", onInkPointerMove, true);
  view.addEventListener("pointerup", onInkPointerUp, true);
  view.addEventListener("pointercancel", onInkPointerCancel, true);
  view.addEventListener("touchmove", onInkTouchMove, { passive: false });
  view.addEventListener("click", onInkClick, true);
}

// ── What the rail drives ───────────────────────────────────────────────────

export function isInkArmed() { return inkRailArmed; }

export function setInkArmed(next) {
  inkRailArmed = Boolean(next);
  if (!inkRailArmed) {
    ensureEngine().setTool(INK_TOOL_DEFAULT);
    ensureEngine().clearSelection();
    closeOpenMark();
  }
  onInkChanged();
}

export function inkTool() { return engine ? engine.getTool() : INK_TOOL_DEFAULT; }
export function inkPen() { return engine ? engine.getPen() : INK_PEN_DEFAULT; }
export function inkWidth() { return engine ? engine.getWidth() : INK_WIDTH_DEFAULT; }

export function setInkTool(tool) {
  // A tool change closes the open mark. Switching to the eraser and back is a
  // deliberate break in what you were doing, and the strokes after it are about
  // something else.
  closeOpenMark();
  ensureEngine().setTool(normalizeInkTool(tool));
  onInkChanged();
}

export function setInkPen(pen) { ensureEngine().setPen(normalizeInkPen(pen)); onInkChanged(); }
export function setInkWidth(width) { ensureEngine().setWidth(normalizeInkWidth(width)); onInkChanged(); }

export function undoInk() { closeOpenMark(); return ensureEngine().undo(); }
export function redoInk() { closeOpenMark(); return ensureEngine().redo(); }
export function canUndoInk() { return Boolean(engine?.canUndo()); }
export function canRedoInk() { return Boolean(engine?.canRedo()); }
export function inkSelectionCount() { return engine ? engine.selectionIndices().length : 0; }
export function deleteInkSelection() { closeOpenMark(); return ensureEngine().deleteSelection(); }

// Join and Split are the repair for the grouping rule guessing wrong, and both
// work by retagging strokes and letting the rebuild do the rest.
//
// Join keeps the EARLIEST id in the selection rather than minting a new one, so
// whatever note was already written on that mark stays attached to it; the ids
// it absorbs vanish, and setDocumentInkForPage gives each of them a tombstone,
// which is what stops the other device putting them back.
export function joinInkSelection() {
  const active = ensureEngine();
  const key = active.selectionKey();
  const indices = active.selectionIndices();
  if (key === null || indices.length < 2) return false;
  const strokes = active.getStrokes(key);
  const chosen = indices.map((i) => strokes[i]).filter(Boolean);
  const ids = documentInkMarks(key).map((record) => record.id);
  const keep = ids.find((id) => chosen.some((stroke) => stroke.m === id)) || chosen[0].m;
  chosen.forEach((stroke) => { stroke.m = keep; });
  closeOpenMark();
  commitInkPage(key, strokes, { reason: "join" });
  active.repaint(key);
  return true;
}

// Split takes the selection out into a mark of its own with a fresh id. The
// parent keeps its id, its note and its `at`, so splitting a stroke off a mark
// somebody wrote a note on does not take the note with it.
export function splitInkSelection() {
  const active = ensureEngine();
  const key = active.selectionKey();
  const indices = active.selectionIndices();
  if (key === null || !indices.length) return false;
  const strokes = active.getStrokes(key);
  const fresh = freshDocumentHighlightId();
  indices.forEach((i) => { if (strokes[i]) strokes[i].m = fresh; });
  closeOpenMark();
  commitInkPage(key, strokes, { reason: "split" });
  active.repaint(key);
  return true;
}

// An ink mark as something a flashcard can hold.
//
// Every other mark on a paper makes a card out of its own words. Ink has none —
// documentHighlightLabel calls it "Ink · page 7", which is a fine name for a row
// in a list and a useless answer on a card. So the card gets the DRAWING: the
// mark's strokes as an SVG, through the same upload the notes sheet uses, and
// the same `![](…)` a pasted picture would have left.
//
// Which means the card inherits the whole image pipeline with it — offline it
// is queued and the card shows the local blob until the upload lands, the same
// as any other picture made without a connection.
//
// Returns "" when there is nothing to make a card from or the file could not be
// kept; the caller falls back to the label, which is honest rather than empty.
export async function inkMarkImageMarkdown(id) {
  const record = documentInkMarks().find((entry) => entry.id === id);
  if (!record) return "";
  const strokes = decodeInkStrokes(record.ink?.s);
  if (!strokes.length) return "";
  const file = inkSvgFile(strokes, { name: `ink-${id}`, title: `Ink from page ${record.page}` });
  if (!file) return "";
  const result = await storeImageOrQueue(file);
  if (result.error || !result.url) return "";
  return `![](${result.url})`;
}

export function isInkMarkId(id) {
  return documentInkMarks().some((record) => record.id === id);
}

// A deck swap. The engine holds decoded strokes for every page it has painted,
// and a page 7 from the last paper is not a page 7 of this one.
export function resetDocumentInk() {
  closeOpenMark();
  if (!engine) return;
  engine.destroy();
  engine = null;
  press = null;
  activeRect = null;
}
