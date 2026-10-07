// Two grips on the ends of a highlight, dragged to make it longer or shorter.
//
// "The highlight adjust in notes does not work, I am not seeing any handles."
// Adjust used to borrow the touch selection controller's handles
// (src/notes/touch-selection.js) — which only exist on a phone, where that
// controller is armed. Everywhere else (a desktop, a tablet with a trackpad, a
// touchscreen laptop) it fell back to a plain native selection: a blue run of
// words with nothing on it to drag, under a bar that said "drag the handles".
//
// So the grips are the app's own, on POINTER events: a mouse, a finger and a pen
// all drag them the same way, on every device, and on both reading surfaces —
// a note (src/notes/highlight-adjust.js) and a paper
// (src/documents/pdf-highlight-adjust.js). Each surface hands in how to hit-test
// a point and how to paint the preview; everything else is here:
//
//   • the grips, on a fixed overlay on <body> — never inside #notesView, whose
//     children are the block cache's keys (see "The overlay" in
//     touch-selection.js);
//   • the drag: the grip keeps the offset it was grabbed at, so the caret moves
//     with the finger rather than jumping under it, and dragging one end past
//     the other swaps them, as a selection does;
//   • whole words — an end lands on a word's edge, never inside one;
//   • the surface scrolling itself while a grip is held near its edge;
//   • a click or tap on the text moves the NEARER end there — the quickest way
//     to say "up to here" with a mouse;
//   • the ✕ / ✓ Apply bar, Escape and Enter.
//
// Nothing is written until Apply. Cancel, Escape, or the words going away under
// the grips (a re-render) leave the highlight exactly as it was.

import { wordSpanAtChar } from "../core/word-bounds.js?v=__BUILD__";

export const ADJUSTING_CLASS = "is-adjusting-highlight";
export const ADJUST_DRAGGING_CLASS = "is-adjust-dragging";

// How close to the edge of the surface a held grip has to be before the surface
// scrolls itself, and how fast it goes right at the edge.
export const ADJUST_EDGE_PX = 48;
export const ADJUST_EDGE_MAX_SPEED_PX = 14;

let adjSession = null;
let adjBarEl = null;
let adjOverlay = null;
let adjGrips = null;

export function isAdjustHandlesOpen() {
  return adjSession != null;
}

// ── Whole words ─────────────────────────────────────────────────────────────
//
// The same rule the document highlighter snaps a drag by (smartHlStartOffset /
// smartHlEndOffset in src/documents/pdf-smart-highlight.js): a start on a word
// moves back to that word's start, a start on a space moves forward to the next
// word; an end moves forward to its word's end, or back past the spaces before
// it. Asked of the CHARACTER either side of the boundary, not of the caret, so
// an end just after "three" stays after "three" rather than reaching into the
// next word.
const ADJ_SPACE = /\s/;

function adjSnapStart(node, offset) {
  if (node?.nodeType !== Node.TEXT_NODE) return offset;
  const text = node.nodeValue || "";
  let at = offset;
  while (at < text.length && ADJ_SPACE.test(text[at])) at += 1;
  if (at >= text.length) return at;
  const word = wordSpanAtChar(text, at);
  return word ? word.start : at;
}

function adjSnapEnd(node, offset) {
  if (node?.nodeType !== Node.TEXT_NODE) return offset;
  const text = node.nodeValue || "";
  let at = Math.min(offset, text.length) - 1;
  while (at >= 0 && ADJ_SPACE.test(text[at])) at -= 1;
  if (at < 0) return 0;
  const word = wordSpanAtChar(text, at);
  return word ? word.end : at + 1;
}

// A Range over whole words between two boundary points, whichever comes first.
// Answers which of the two ended up as the start, so a drag that crossed the
// other end knows it is now holding the other grip.
function adjWordRangeBetween(fixed, moving) {
  const a = document.createRange();
  const b = document.createRange();
  try {
    a.setStart(fixed.node, fixed.offset);
    b.setStart(moving.node, moving.offset);
  } catch (_) {
    return null;
  }
  const movingFirst = a.compareBoundaryPoints(Range.START_TO_START, b) > 0;
  const [from, to] = movingFirst ? [moving, fixed] : [fixed, moving];
  const range = document.createRange();
  try {
    range.setStart(from.node, adjSnapStart(from.node, from.offset));
    range.setEnd(to.node, adjSnapEnd(to.node, to.offset));
  } catch (_) {
    return null;
  }
  if (range.collapsed || !range.toString().trim()) return null;
  return { range, movingIsStart: movingFirst };
}

function adjBoundary(range, atStart) {
  return atStart
    ? { node: range.startContainer, offset: range.startOffset }
    : { node: range.endContainer, offset: range.endOffset };
}

// The caret rectangle at one end — a collapsed clone first (one rect, however
// much is covered), the first or last line fragment when that has no box.
function adjEdgeRect(range, atStart) {
  const probe = range.cloneRange();
  probe.collapse(atStart);
  const rect = probe.getBoundingClientRect();
  if (rect.height) return rect;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width || r.height);
  if (!rects.length) return null;
  const line = atStart ? rects[0] : rects[rects.length - 1];
  return { left: atStart ? line.left : line.right, top: line.top, height: line.height, bottom: line.bottom };
}

function adjRangeIsLive(range, scroller) {
  return Boolean(range && scroller?.isConnected
    && scroller.contains(range.startContainer) && scroller.contains(range.endContainer));
}

// ── The bar ─────────────────────────────────────────────────────────────────

function adjEnsureBar() {
  if (adjBarEl?.isConnected) return adjBarEl;
  adjBarEl = document.createElement("div");
  adjBarEl.className = "highlight-adjust-bar";
  adjBarEl.hidden = true;
  adjBarEl.setAttribute("role", "toolbar");
  adjBarEl.setAttribute("aria-label", "Adjust the highlight");
  adjBarEl.innerHTML = '<span class="highlight-adjust-hint">Drag the handles or tap a word</span>'
    + '<button type="button" class="highlight-adjust-cancel" data-adjust="cancel" aria-label="Cancel">&#10005;</button>'
    + '<button type="button" class="highlight-adjust-apply" data-adjust="apply">&#10003; Apply</button>';
  // pointerdown + preventDefault, like every floating control over the words:
  // a click would first land on the page under it.
  adjBarEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.target.closest("[data-adjust]");
    if (!button) return;
    if (button.dataset.adjust === "apply") applyAdjustHandles();
    else closeAdjustHandles();
  });
  document.body.appendChild(adjBarEl);
  return adjBarEl;
}

// ── The grips ───────────────────────────────────────────────────────────────

function adjEnsureGrips() {
  if (adjOverlay?.isConnected) return adjGrips;
  adjOverlay = document.createElement("div");
  adjOverlay.className = "adjust-handle-layer";
  adjOverlay.setAttribute("aria-hidden", "true");
  const make = (end) => {
    const grip = document.createElement("span");
    grip.className = `adjust-handle is-${end}`;
    grip.dataset.end = end;
    grip.innerHTML = '<i class="adjust-handle-bar"></i><i class="adjust-handle-bulb"></i>';
    grip.addEventListener("pointerdown", adjOnGripDown);
    // A long press on a grip must not open the page's context menu.
    grip.addEventListener("contextmenu", (event) => event.preventDefault());
    adjOverlay.appendChild(grip);
    return grip;
  };
  adjGrips = { start: make("start"), end: make("end") };
  document.body.appendChild(adjOverlay);
  return adjGrips;
}

function adjPlaceGrip(grip, rect, box) {
  if (!rect || rect.top + rect.height < box.top - 1 || rect.top > box.bottom + 1
      || rect.left < box.left - 24 || rect.left > box.right + 24) {
    grip.hidden = true;
    return;
  }
  grip.hidden = false;
  grip.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
  grip.style.setProperty("--adjust-caret-h", `${Math.max(Math.round(rect.height), 12)}px`);
}

function adjPlaceGrips() {
  if (!adjSession) return;
  if (!adjRangeIsLive(adjSession.range, adjSession.scroller) || !adjSession.scroller.getClientRects().length) {
    // The words were re-rendered away, or the surface was closed: there is
    // nothing left to adjust, and nothing has been written.
    closeAdjustHandles();
    return;
  }
  const { start, end } = adjEnsureGrips();
  const box = adjSession.scroller.getBoundingClientRect();
  adjPlaceGrip(start, adjEdgeRect(adjSession.range, true), box);
  adjPlaceGrip(end, adjEdgeRect(adjSession.range, false), box);
}

function adjSchedulePlace() {
  if (!adjSession || adjSession.frame) return;
  adjSession.frame = requestAnimationFrame(() => {
    if (!adjSession) return;
    adjSession.frame = 0;
    if (adjSession.drag) adjDragFrame();
    adjPlaceGrips();
  });
}

function adjSetRange(range) {
  adjSession.range = range;
  adjSession.preview(range);
}

// ── Dragging ────────────────────────────────────────────────────────────────

function adjOnGripDown(event) {
  if (!adjSession || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  event.stopPropagation();
  const atStart = event.currentTarget.dataset.end === "start";
  const rect = adjEdgeRect(adjSession.range, atStart);
  adjSession.drag = {
    pointerId: event.pointerId,
    atStart,
    // Where on the grip it was taken, relative to the caret's own middle — kept
    // for the whole drag, so the caret stays where it was relative to the
    // finger instead of jumping up under it.
    dx: rect ? event.clientX - rect.left : 0,
    dy: rect ? event.clientY - (rect.top + rect.height / 2) : 0,
    x: event.clientX,
    y: event.clientY
  };
  document.body.classList.add(ADJUST_DRAGGING_CLASS);
  window.addEventListener("pointermove", adjOnDragMove, { passive: false });
  window.addEventListener("pointerup", adjOnDragEnd);
  window.addEventListener("pointercancel", adjOnDragEnd);
}

function adjOnDragMove(event) {
  const drag = adjSession?.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  drag.x = event.clientX;
  drag.y = event.clientY;
  adjUpdateEdgeScroll();
  adjSchedulePlace();
}

function adjOnDragEnd(event) {
  const drag = adjSession?.drag;
  if (drag && event.pointerId !== drag.pointerId) return;
  if (adjSession) {
    if (drag) adjDragFrame();
    adjSession.drag = null;
  }
  adjStopEdgeScroll();
  document.body.classList.remove(ADJUST_DRAGGING_CLASS);
  window.removeEventListener("pointermove", adjOnDragMove);
  window.removeEventListener("pointerup", adjOnDragEnd);
  window.removeEventListener("pointercancel", adjOnDragEnd);
  adjSchedulePlace();
}

// Move the held end to the point under the grip's caret.
function adjDragFrame() {
  const drag = adjSession?.drag;
  if (!drag) return;
  adjMoveEndTo(drag.atStart, drag.x - drag.dx, drag.y - drag.dy);
}

function adjMoveEndTo(atStart, x, y) {
  const point = adjSession.pointAt(x, y);
  if (!point) return false;
  const made = adjWordRangeBetween(adjBoundary(adjSession.range, !atStart), point);
  if (!made) return false;
  adjSetRange(made.range);
  if (adjSession.drag) adjSession.drag.atStart = made.movingIsStart;
  return true;
}

// ── The surface scrolls itself under a held grip ──────────────────────────

function adjUpdateEdgeScroll() {
  const drag = adjSession?.drag;
  if (!drag) return;
  const box = adjSession.scroller.getBoundingClientRect();
  const horizontal = adjSession.horizontal();
  const at = horizontal ? drag.x : drag.y;
  const lo = horizontal ? box.left : box.top;
  const hi = horizontal ? box.right : box.bottom;
  let vector = 0;
  if (at < lo + ADJUST_EDGE_PX) vector = -Math.ceil(ADJUST_EDGE_MAX_SPEED_PX * Math.min(1, (lo + ADJUST_EDGE_PX - at) / ADJUST_EDGE_PX));
  else if (at > hi - ADJUST_EDGE_PX) vector = Math.ceil(ADJUST_EDGE_MAX_SPEED_PX * Math.min(1, (at - (hi - ADJUST_EDGE_PX)) / ADJUST_EDGE_PX));
  adjSession.edgeVector = vector;
  if (vector && !adjSession.edgeFrame) adjEdgeStep();
}

function adjEdgeStep() {
  adjSession.edgeFrame = requestAnimationFrame(() => {
    if (!adjSession) return;
    adjSession.edgeFrame = 0;
    if (!adjSession.drag || !adjSession.edgeVector) return;
    adjSession.beforeScroll?.();
    if (adjSession.horizontal()) adjSession.scroller.scrollLeft += adjSession.edgeVector;
    else adjSession.scroller.scrollTop += adjSession.edgeVector;
    adjDragFrame();
    adjPlaceGrips();
    if (adjSession) adjEdgeStep();
  });
}

function adjStopEdgeScroll() {
  if (!adjSession) return;
  adjSession.edgeVector = 0;
  if (adjSession.edgeFrame) cancelAnimationFrame(adjSession.edgeFrame);
  adjSession.edgeFrame = 0;
}

// ── A tap on the text moves the nearer end there ──────────────────────────

function adjOnScrollerClick(event) {
  if (!adjSession || adjSession.drag) return;
  // The surface's own controls still work — a link, a cloze, a note badge.
  if (event.target.closest?.("a, button, input, textarea, select, .cloze")) return;
  event.preventDefault();
  event.stopPropagation();
  const point = adjSession.pointAt(event.clientX, event.clientY);
  if (!point) return;
  // The word that was clicked, whole — not the caret between two of its
  // letters, which would snap to the word before it at the end.
  const word = adjWordAtPoint(point);
  const probe = document.createRange();
  try { probe.setStart(point.node, point.offset); } catch (_) { return; }
  const range = adjSession.range;
  let atStart;
  if (probe.compareBoundaryPoints(Range.START_TO_START, range) < 0) atStart = true;
  else if (probe.compareBoundaryPoints(Range.START_TO_END, range) > 0) atStart = false;
  else {
    // Inside the highlight: whichever end is nearer on the screen.
    const s = adjEdgeRect(range, true);
    const e = adjEdgeRect(range, false);
    const d = (r) => (r ? Math.hypot(r.left - event.clientX, r.top + r.height / 2 - event.clientY) : Infinity);
    atStart = d(s) <= d(e);
  }
  const fixed = adjBoundary(range, !atStart);
  const made = adjWordRangeBetween(fixed, word ? { node: point.node, offset: atStart ? word.start : word.end } : point);
  if (made) adjSetRange(made.range);
  adjPlaceGrips();
}

function adjWordAtPoint(point) {
  if (point.node?.nodeType !== Node.TEXT_NODE) return null;
  const text = point.node.nodeValue || "";
  return wordSpanAtChar(text, point.offset) || wordSpanAtChar(text, point.offset - 1);
}

function adjOnScroll() {
  adjSchedulePlace();
}

function adjOnKey(event) {
  if (!adjSession) return;
  // Typing somewhere else — a note's editor, a search box — is not an answer.
  if (event.target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeAdjustHandles();
  } else if (event.key === "Enter") {
    event.preventDefault();
    applyAdjustHandles();
  }
}

// ── Open / apply / close ───────────────────────────────────────────────────
//
//   scroller      the reading surface the words are in
//   range         the highlight's words now
//   color         its colour token, for the grips
//   pointAt(x, y) the {node, offset} under a point, or null
//   preview(range)  paint what Apply would make; preview(null) clears it
//   apply(range)  write it — called once, after the grips are gone
//   cancel()      put back anything start-up changed (optional)
//   horizontal()  true when the surface scrolls sideways (optional)
//   beforeScroll() announce an app-made scroll (optional)
export function openAdjustHandles(options) {
  closeAdjustHandles();
  const { scroller, range } = options || {};
  if (!scroller || !range || range.collapsed) return false;
  adjSession = {
    scroller,
    range,
    pointAt: options.pointAt,
    preview: options.preview || (() => {}),
    apply: options.apply || (() => {}),
    cancel: options.cancel || (() => {}),
    horizontal: options.horizontal || (() => false),
    beforeScroll: options.beforeScroll || null,
    drag: null,
    frame: 0,
    edgeFrame: 0,
    edgeVector: 0,
    resizeObserver: null
  };
  const { start, end } = adjEnsureGrips();
  [start, end].forEach((grip) => { grip.dataset.color = options.color || "yellow"; });
  adjOverlay.hidden = false;
  document.body.classList.add(ADJUSTING_CLASS);
  adjEnsureBar().hidden = false;
  scroller.addEventListener("scroll", adjOnScroll, { passive: true });
  scroller.addEventListener("click", adjOnScrollerClick, true);
  window.addEventListener("resize", adjOnScroll, { passive: true });
  document.addEventListener("keydown", adjOnKey, true);
  // Leaving the surface (another tab, a view switch) fires no scroll, but it
  // does take the surface's box away — and the grips must not outlive it.
  if (typeof ResizeObserver === "function") {
    adjSession.resizeObserver = new ResizeObserver(() => adjSchedulePlace());
    adjSession.resizeObserver.observe(scroller);
  }
  adjSession.preview(range);
  adjPlaceGrips();
  return true;
}

function adjTeardown() {
  const was = adjSession;
  if (!was) return null;
  if (was.drag) adjOnDragEnd({ pointerId: was.drag.pointerId });
  adjStopEdgeScroll();
  if (was.frame) cancelAnimationFrame(was.frame);
  adjSession = null;
  was.scroller.removeEventListener("scroll", adjOnScroll);
  was.scroller.removeEventListener("click", adjOnScrollerClick, true);
  window.removeEventListener("resize", adjOnScroll);
  document.removeEventListener("keydown", adjOnKey, true);
  was.resizeObserver?.disconnect();
  document.body.classList.remove(ADJUSTING_CLASS);
  document.body.classList.remove(ADJUST_DRAGGING_CLASS);
  if (adjBarEl) adjBarEl.hidden = true;
  if (adjOverlay) adjOverlay.hidden = true;
  try { was.preview(null); } catch (_) { /* the surface went away */ }
  return was;
}

export function applyAdjustHandles() {
  if (!adjSession) return false;
  // The last frame of a drag still in flight counts.
  if (adjSession.drag) adjDragFrame();
  const range = adjRangeIsLive(adjSession.range, adjSession.scroller) ? adjSession.range.cloneRange() : null;
  const was = adjTeardown();
  if (!range) {
    was.cancel();
    return false;
  }
  return was.apply(range) !== false;
}

export function closeAdjustHandles() {
  const was = adjTeardown();
  if (was) was.cancel();
}

// The Range the grips are on now, for tests and diagnostics.
export function adjustHandlesRange() {
  return adjSession ? adjSession.range : null;
}
