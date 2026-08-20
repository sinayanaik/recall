// Selecting text with a FINGER, implemented by the app instead of the browser.
//
// ── Why this exists at all ─────────────────────────────────────────────────
//
// The previous attempt (commit 960ec1e) fixed five real bugs by getting OUT of
// the native gesture's way: touch-action back to `auto` on every reading
// surface, content-visibility suspended under a live selection, the paged snap
// held off, the pill's expensive capture deferred, the card swipe standing down
// for a dwelling finger. Every one of those was worth doing and all of them are
// still here. But the approach has a ceiling, and the report after that push is
// exactly the ceiling:
//
//   • "there is at least a 3-4s gap after I hard press and then only selection
//     starts". Android's long-press-to-select is MAIN-THREAD GATED. The
//     compositor hands the touch to the renderer and the press only becomes a
//     selection once the renderer acks it, so every long task in the app — a
//     chunk render, a reading-position pass, an IntersectionObserver batch — is
//     added to that delay. An app can make its own work smaller. It cannot make
//     that number deterministic, because it does not own the timer.
//
//   • "the start and end indicators for the text selection is entirely
//     incorrect". The native highlight and the two native handles are drawn
//     from a layout snapshot taken when the gesture began. Every
//     contain-intrinsic-size ESTIMATE that resolves to a real height during the
//     drag desyncs them from the text. Suspending containment narrows that
//     window; it cannot close it.
//
//   • "more error when I am starting selection from the very start of a
//     corner". caretPositionFromPoint at the left edge of a first line
//     hit-tests into the block's PADDING and resolves to the container element
//     rather than to a text node, so the anchor lands in a neighbouring block.
//
// So this module stops negotiating. On a touch screen the native selection
// gesture is suppressed outright (user-select: none, see
// styles/32-touch-select.css) and press → select → drag → act is implemented
// here: our own timer, our own hit-testing, our own handles, and the selection
// painted by the CSS Custom Highlight API — which is drawn by the same layout
// pass as the text and therefore CANNOT desync from it the way the screenshot
// shows.
//
// ── What made this affordable ──────────────────────────────────────────────
//
// Measured in headless Chrome before a line of this was written, because the
// answer decides the whole design: over `user-select: none` content,
// Selection.toString() returns "" — but Range.toString(), cloneContents(),
// intersectsNode(), getClientRects() and the selection's own anchorNode /
// focusNode / isCollapsed / rangeCount are all completely correct.
//
// Every reader in this app goes through getRangeAt(0) plus Range operations:
// activeRenderedTarget(), notesSelectionRange(), renderedSelectionStrings(),
// overlappingMarkIndex(), notesSelectionIsLive(). So the range we own is
// MIRRORED into the real Selection and the rest of the app carries on exactly
// as before, with one single exception — src/notes/mark-menu.js, which called
// Selection.toString() and now reads its range instead.
//
// ── Desktop never reaches any of this ──────────────────────────────────────
//
// Three independent fences, any one of which is enough on its own:
//
//   1. canTouchSelect() below — `(pointer: coarse) and (hover: none)` describes
//      the PRIMARY pointer, so a touchscreen laptop, whose primary pointer is a
//      cursor, reports `(pointer: fine) and (hover: hover)` and stays on the
//      native path despite having a digitiser.
//   2. Only touchstart / touchmove / touchend are ever bound. A mouse cannot
//      produce a touchstart, so even under devtools device emulation a mouse
//      drag cannot enter this code.
//   3. Every rule in styles/32-touch-select.css sits under
//      `body.has-touch-select`, and that class is added only by arm() below. A
//      stylesheet cannot switch selection off on a machine whose JavaScript
//      never took it over.

import { el } from "../core/dom.js?v=__BUILD__";
import { resetCardDrag } from "../cards/swipe.js?v=__BUILD__";
import { caretFromPoint } from "./raw-offset.js?v=__BUILD__";
import {
  clearSelectionStableRegion,
  hideNotesSelectionButton,
  markSelectionStableRegion,
  positionNotesSelectionButton,
  setTouchSelectionArmed,
  setTouchSelectionDragging,
} from "./selection.js?v=__BUILD__";

// The name the highlight is registered under with CSS.highlights, and the same
// name styles/32-touch-select.css paints with ::highlight().
export const HIGHLIGHT_NAME = "recall-touch-selection";

// How long a finger has to rest before it is a press rather than a scroll.
// 320ms, against Android's own ~500ms, deliberately: the whole complaint is
// that selection takes too long to arrive, and we are not paying a main-thread
// round trip on top of it. Below ~250ms a slow scroll start begins to register
// as a press.
export const LONG_PRESS_MS = 320;

// How far the finger may wander in that time and still be pressing. A real
// touch slop — a thumb resting on glass moves several pixels — and the same
// value swipe.js settled on for its own dwell test (dwellSlopPx).
export const PRESS_SLOP_PX = 10;

// A handle is grabbed by its bulb, which hangs BELOW the line it marks, so the
// caret being chosen sits above the finger. The real offset is MEASURED at the
// moment of the grab — see grabOffsetY — because it depends on the line's height
// and on where in the bulb the thumb actually landed, and a constant that is
// wrong by half a line puts the caret on the wrong row. This is only the
// fallback for a grab whose boundary rect could not be read.
export const HANDLE_GRAB_OFFSET_PX = 34;

// How close to the edge of the reading surface a drag has to get before the
// view starts scrolling itself, and how fast it does so at the very edge.
export const EDGE_PX = 64;
export const EDGE_MAX_SPEED_PX = 16;

// ── The gate ───────────────────────────────────────────────────────────────

export const touchSelectMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(pointer: coarse) and (hover: none)")
  : null;

export function canTouchSelect() {
  if (!touchSelectMedia?.matches) return false;
  if (!(navigator.maxTouchPoints > 0)) return false;
  // The takeover is only safe if we can paint what we took over. Without the
  // Custom Highlight API a selection would be invisible, which is worse than
  // the bug being fixed — so an older browser keeps the native gesture and
  // everything styles/31-touch-selection.css does for it.
  return Boolean(window.CSS && window.CSS.highlights && typeof window.Highlight === "function");
}

// ── State ──────────────────────────────────────────────────────────────────
//
// One Range is the source of truth, and it is the SAME object handed to the
// Highlight — Ranges are live, so mutating it repaints the selection with no
// per-frame paint work of our own. The two boundaries are tracked separately
// because a drag that crosses its own start has to swap them, exactly as the
// native handles do.

let armed = false;
let overlay = null;
let handleStart = null;
let handleEnd = null;
let touchHighlight = null;

let liveRoot = null;
let liveRange = null;
let anchorPoint = null; // { node, offset } — the end that stays put
let focusPoint = null;  // { node, offset } — the end being dragged

let pressTimer = null;
let pressX = 0;
let pressY = 0;
let pressActive = false;   // a finger is down and might still become a press
let pressDragging = false; // the press fired and that same finger is extending

let draggingHandle = "";   // "" | "start" | "end"
// How far the finger is below the caret it is choosing, measured at the grab.
// Zero for a press-drag, where the finger IS the caret.
let grabOffsetY = 0;
let edgeFrame = 0;
let edgeVector = 0;
let edgePoint = null;
let handleFrame = 0;

export function touchSelectionRoots() {
  return [el.notesView, el.questionView, el.answerView].filter(Boolean);
}

// The range the reader currently has selected with a finger, or null. Exported
// for the pill's Copy / Share / Web search buttons, which want the text and not
// the markdown serialisation the other buttons work from.
export function touchSelectionRange() {
  if (!rangeStillLive()) return null;
  return liveRange.collapsed ? null : liveRange;
}

// A note re-renders by replacing its blocks, and a range whose nodes have been
// detached still answers questions — with nonsense. Chrome does fire
// selectionchange when a mutation destroys the selection, and the listener in
// initTouchSelection cleans up on it; this is the belt to that braces, checked
// wherever the range is about to be trusted. Two `contains` calls, so it is
// affordable on a drag frame.
function rangeStillLive() {
  if (!liveRange || !liveRoot) return false;
  if (!liveRoot.isConnected) return false;
  if (!liveRoot.contains(liveRange.startContainer) || !liveRoot.contains(liveRange.endContainer)) return false;
  return true;
}

export function touchSelectionIsDragging() {
  return Boolean(draggingHandle || pressDragging);
}

// ── Hit-testing that survives the edges of a block ─────────────────────────
//
// caretFromPoint() (src/notes/raw-offset.js) wraps the two spellings of the
// platform API. It is correct in the middle of a paragraph and unreliable
// everywhere else, and "everywhere else" is where readers actually aim: the
// gutter left of the first character, the space above the first line, the
// margin between two blocks. In all of those it resolves to the CONTAINING
// ELEMENT rather than to a text node, and an element boundary used as a
// selection anchor lands on whichever child index the browser picked — a
// neighbouring block, usually.
//
// This is the "especially when starting from the very start of a corner" bug.

function usableCaret(pos, root) {
  return Boolean(pos && pos.node && pos.node.nodeType === Node.TEXT_NODE && root.contains(pos.node));
}

// The reading surface's own content box — inside its padding, which on the
// notes view is substantial (styles/12-notes.css gives it --notes-padding plus
// the stage bleed) and is exactly the strip a caret hit-test falls through.
function contentBox(root) {
  const rect = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  return {
    left: rect.left + parseFloat(cs.paddingLeft || 0) + 1,
    right: rect.right - parseFloat(cs.paddingRight || 0) - 1,
    top: rect.top + 1,
    bottom: rect.bottom - 1,
  };
}

// The deepest element at a point, probing a few nearby rows first. The probes
// are what cover the vertical GAPS — a point in the margin between two
// paragraphs belongs to neither, and elementFromPoint answers with the scroller
// itself, which is useless as an anchor.
function elementNear(x, y, root) {
  for (const dy of [0, -6, 6, -16, 16, -28, 28]) {
    const hit = document.elementFromPoint(x, y + dy);
    if (!hit || !root.contains(hit) || hit === root) continue;
    return hit;
  }
  return null;
}

// Is this caret position before the point, in reading order? Used as the
// comparator of the binary search below, so it has to be a total order over the
// offsets of one text node — which it is, because a text node's caret
// rectangles run left to right within a line and top to bottom between lines.
function caretIsBefore(rect, x, y) {
  if (rect.bottom <= y) return true;   // the caret's line is entirely above
  if (rect.top >= y) return false;     // ...entirely below
  return rect.left <= x;               // same line: compare horizontally
}

function boundaryRectIn(node, offset) {
  const probe = document.createRange();
  probe.setStart(node, offset);
  probe.setEnd(node, offset);
  return probe.getBoundingClientRect();
}

// The offset in `node` closest to (x, y), by binary search over its length.
// Eleven rect measurements for a 2,000-character node instead of 2,000 — which
// matters because this runs on every frame of a handle drag.
function offsetNear(node, x, y) {
  const length = node.nodeValue ? node.nodeValue.length : 0;
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (caretIsBefore(boundaryRectIn(node, mid), x, y)) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(Math.max(lo, 0), length);
}

// Every text node under `host`, in document order, skipping the furniture that
// styles/14-selection.css already declares is not text (the code block's
// language badge, an image's size badge and resize grip) plus anything with no
// rendered box at all.
function textNodesIn(host, limit = 400) {
  const out = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".code-lang-badge, .notes-img-size-badge, .notes-img-resize-handle")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode() && out.length < limit) out.push(walker.currentNode);
  return out;
}

function closestCaretIn(host, x, y) {
  const nodes = textNodesIn(host);
  if (!nodes.length) return null;
  let best = null;
  let bestDistance = Infinity;
  const probe = document.createRange();
  nodes.forEach((node) => {
    probe.selectNodeContents(node);
    const rect = probe.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    // Vertical distance dominates: a reader aiming at a line wants THAT line,
    // even when their finger is well left or right of the words on it.
    const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
    const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0);
    const distance = dy * 4 + dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  });
  if (!best) return null;
  return { node: best, offset: offsetNear(best, x, y) };
}

// The repaired hit-test. Tried in order of how much it costs.
export function caretInRoot(x, y, root) {
  if (!root) return null;
  const box = contentBox(root);
  const cy = Math.min(Math.max(y, box.top), box.bottom);

  const direct = caretFromPoint(x, cy);
  if (usableCaret(direct, root)) return direct;

  // 1. Clamp into the content box. This alone fixes the left-gutter case, which
  //    is the one the report named.
  const cx = Math.min(Math.max(x, box.left), box.right);
  for (const tryX of [cx, box.left, box.right]) {
    const repaired = caretFromPoint(tryX, cy);
    if (usableCaret(repaired, root)) return repaired;
  }

  // 2. Still an element — the point is in a margin, or on an atomic block. Find
  //    the block it belongs to and take the closest caret inside it.
  const elementHost = (direct && direct.node && direct.node.nodeType === Node.ELEMENT_NODE && root.contains(direct.node))
    ? direct.node
    : elementNear(cx, cy, root);
  if (elementHost) {
    const inside = closestCaretIn(elementHost, x, cy);
    if (inside) return inside;
  }
  return null;
}

// ── Word snapping ──────────────────────────────────────────────────────────
//
// A press selects a WORD, like every other platform. Intl.Segmenter rather than
// a regex because this app renders notes in whatever language they were written
// in, and a regex word boundary is an English assumption.

const wordSegmenter = (() => {
  try {
    return new Intl.Segmenter(navigator.language || "en", { granularity: "word" });
  } catch (_) {
    return null;
  }
})();

const WORD_RE = /[\p{L}\p{N}_'’-]+/gu;

function wordBoundsAt(text, offset) {
  if (!text) return null;
  if (wordSegmenter) {
    let fallback = null;
    for (const segment of wordSegmenter.segment(text)) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (offset < start) break;
      if (offset > end) continue;
      if (segment.isWordLike) return { start, end };
      // A press that lands on the space between two words: remember it, but
      // keep looking — the word STARTING at this offset is the better answer.
      if (!fallback && offset > start && offset < end) fallback = { start, end };
    }
    if (fallback) return fallback;
  }
  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(text);
  let previous = null;
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return { start, end };
    if (end < offset) previous = { start, end };
    if (start > offset) break;
    match = WORD_RE.exec(text);
  }
  return previous;
}

// The image, equation or diagram a press landed on, when there is no text to
// snap to. Selecting one is meaningful in this app — rangeHasImage() in
// selection.js exists precisely so the pill offers itself for a picture.
function atomicAt(x, y, root) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !root.contains(hit)) return null;
  return hit.closest("img, .math-inline[data-tex], .math-display[data-tex], [data-diagram]");
}

// ── The overlay and the two handles ────────────────────────────────────────
//
// Appended to <body>, NOT into the reading surface. `.notes-rendered > *` is the
// incremental renderer's block-cache key (src/render/block-cache.js, and the
// comment at the top of styles/18-paged-notes.css), so a child of the notes view
// would invalidate every cached block on every render — the exact cost that
// cache exists to avoid.

function buildOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "touch-select-layer";
  overlay.setAttribute("aria-hidden", "true");
  handleStart = document.createElement("span");
  handleStart.className = "touch-select-handle is-start";
  handleStart.innerHTML = '<i class="touch-select-bulb"></i>';
  handleEnd = document.createElement("span");
  handleEnd.className = "touch-select-handle is-end";
  handleEnd.innerHTML = '<i class="touch-select-bulb"></i>';
  overlay.append(handleStart, handleEnd);
  document.body.appendChild(overlay);
  bindHandle(handleStart, "start");
  bindHandle(handleEnd, "end");
}

function destroyOverlay() {
  overlay?.remove();
  overlay = null;
  handleStart = null;
  handleEnd = null;
}

// The caret rectangle at one end of the range. A COLLAPSED clone rather than
// getClientRects()[0] / [n-1]: a collapsed range costs one rect no matter how
// much text is selected, where getClientRects() on a selection spanning a
// screenful of prose costs one per line fragment — and this runs every frame of
// a drag and on every scroll while a selection is up.
function edgeRect(range, atStart) {
  const probe = range.cloneRange();
  probe.collapse(atStart);
  const rect = probe.getBoundingClientRect();
  if (rect.height || rect.width) return rect;
  const rects = range.getClientRects();
  if (!rects.length) return null;
  return atStart ? rects[0] : rects[rects.length - 1];
}

function placeHandle(handle, rect, root) {
  if (!handle) return;
  if (!rect) {
    handle.style.display = "none";
    return;
  }
  // A handle for a boundary that has scrolled out of the reading surface is not
  // drawn — a grip floating over the toolbar belongs to nothing.
  const bounds = root.getBoundingClientRect();
  if (rect.bottom < bounds.top || rect.top > bounds.bottom
      || rect.right < bounds.left || rect.left > bounds.right) {
    handle.style.display = "none";
    return;
  }
  handle.style.display = "";
  handle.style.left = `${rect.left}px`;
  handle.style.top = `${rect.top}px`;
  handle.style.height = `${Math.max(rect.height, 12)}px`;
}

export function updateHandles() {
  if (!overlay) return;
  if (!rangeStillLive()) {
    if (liveRange) clearTouchSelection({ keepDocumentSelection: true });
    return;
  }
  placeHandle(handleStart, edgeRect(liveRange, true), liveRoot);
  placeHandle(handleEnd, edgeRect(liveRange, false), liveRoot);
}

function scheduleHandleUpdate() {
  if (handleFrame) return;
  handleFrame = requestAnimationFrame(() => {
    handleFrame = 0;
    updateHandles();
  });
}

// ── Committing a range ─────────────────────────────────────────────────────

function pointsToRange(a, b) {
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(a.node, a.offset);
    const other = document.createRange();
    other.setStart(b.node, b.offset);
    // Which of the two comes first in the document decides which is the range's
    // start. A drag that crosses its own anchor flips this every frame, which is
    // exactly the behaviour the native handles have.
    if (range.compareBoundaryPoints(Range.START_TO_START, other) <= 0) {
      range.setEnd(b.node, b.offset);
    } else {
      range.setStart(b.node, b.offset);
      range.setEnd(a.node, a.offset);
    }
  } catch (_) {
    return null;
  }
  return range;
}

// Push our range into the real Selection. Everything downstream — the pill, the
// highlight tools, the cloze driver, the paged-snap guard — reads the selection
// and its range, and all of that keeps working over user-select: none content.
// Only Selection.toString() does not, which is why nothing in this app calls it
// any more.
function mirrorToSelection() {
  if (!liveRange || !anchorPoint || !focusPoint) return;
  const selection = window.getSelection();
  if (!selection) return;
  try {
    selection.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset);
  } catch (_) {
    try {
      selection.removeAllRanges();
      selection.addRange(liveRange.cloneRange());
    } catch (_) { /* the DOM moved under us; the next update repairs it */ }
  }
}

function paintTouchHighlight() {
  if (!liveRange) return;
  if (!touchHighlight) {
    touchHighlight = new window.Highlight();
    window.CSS.highlights.set(HIGHLIGHT_NAME, touchHighlight);
  }
  touchHighlight.clear();
  touchHighlight.add(liveRange);
}

function setSelectionPoints(anchor, focus, root) {
  const range = pointsToRange(anchor, focus);
  if (!range || range.collapsed) return false;
  liveRoot = root;
  liveRange = range;
  anchorPoint = anchor;
  focusPoint = focus;
  paintTouchHighlight();
  mirrorToSelection();
  buildOverlay();
  document.body.classList.add("is-touch-selecting");
  updateHandles();
  return true;
}

export function clearTouchSelection({ keepDocumentSelection = false } = {}) {
  stopEdgeScroll();
  if (handleFrame) {
    cancelAnimationFrame(handleFrame);
    handleFrame = 0;
  }
  liveRange = null;
  liveRoot = null;
  anchorPoint = null;
  focusPoint = null;
  draggingHandle = "";
  pressDragging = false;
  grabOffsetY = 0;
  setTouchSelectionDragging(false);
  if (touchHighlight) touchHighlight.clear();
  document.body.classList.remove("is-touch-selecting");
  document.body.classList.remove("is-touch-dragging");
  if (handleStart) handleStart.style.display = "none";
  if (handleEnd) handleEnd.style.display = "none";
  clearSelectionStableRegion();
  if (!keepDocumentSelection) {
    try { window.getSelection()?.removeAllRanges(); } catch (_) { /* nothing selected */ }
  }
}

// ── Edge auto-scroll ───────────────────────────────────────────────────────
//
// Extending a selection past the bottom of the screen is done by dragging a
// handle there and letting the view come to you. The native controller does
// this; without it a selection can never be longer than one screenful.
//
// Paged mode scrolls sideways (src/notes/paged-view.js drives it with
// scrollLeft), so the axis follows the mode rather than being assumed.

function edgeAxisIsHorizontal(root) {
  return root.classList.contains("is-paged");
}

function startEdgeScroll() {
  if (edgeFrame) return;
  const step = () => {
    edgeFrame = 0;
    if (!edgeVector || !liveRoot || !edgePoint) return;
    if (edgeAxisIsHorizontal(liveRoot)) liveRoot.scrollLeft += edgeVector;
    else liveRoot.scrollTop += edgeVector;
    extendTo(edgePoint.x, edgePoint.y);
    edgeFrame = requestAnimationFrame(step);
  };
  edgeFrame = requestAnimationFrame(step);
}

function stopEdgeScroll() {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = 0;
  edgeVector = 0;
  edgePoint = null;
}

function updateEdgeScroll(x, y) {
  if (!liveRoot) return;
  const bounds = liveRoot.getBoundingClientRect();
  const horizontal = edgeAxisIsHorizontal(liveRoot);
  const near = horizontal ? bounds.left : bounds.top;
  const far = horizontal ? bounds.right : bounds.bottom;
  const along = horizontal ? x : y;
  let vector = 0;
  if (along < near + EDGE_PX) vector = -EDGE_MAX_SPEED_PX * Math.min(1, (near + EDGE_PX - along) / EDGE_PX);
  else if (along > far - EDGE_PX) vector = EDGE_MAX_SPEED_PX * Math.min(1, (along - (far - EDGE_PX)) / EDGE_PX);
  edgeVector = Math.round(vector);
  edgePoint = { x, y };
  if (edgeVector) startEdgeScroll();
  else stopEdgeScroll();
}

// ── Extending ──────────────────────────────────────────────────────────────

function extendTo(x, y) {
  if (!anchorPoint || !rangeStillLive()) return;
  const caret = caretInRoot(x, y, liveRoot);
  if (!caret) return;
  const next = pointsToRange(anchorPoint, caret);
  if (!next || next.collapsed) return;
  focusPoint = caret;
  liveRange.setStart(next.startContainer, next.startOffset);
  liveRange.setEnd(next.endContainer, next.endOffset);
  paintTouchHighlight();
  mirrorToSelection();
  // Re-marked on every step, not once at the start of the drag: the chunk that
  // matters is the one being dragged INTO, and it is not known until the
  // boundary reaches it. Cheap to repeat — markSelectionStableRegion() compares
  // the wanted set against the marked one and touches no DOM when they match,
  // which is the overwhelmingly common case within a single paragraph.
  markSelectionStableRegion();
  scheduleHandleUpdate();
}

function beginDrag() {
  setTouchSelectionDragging(true);
  // The class that locks the surface. Distinct from `is-touch-selecting`, which
  // means only that a selection EXISTS: a reader who has selected something and
  // wants to scroll down to see the rest of it must be able to, and keying the
  // touch-action lock to the selection rather than to the drag took that away —
  // the note simply stopped scrolling until the selection was dismissed.
  document.body.classList.add("is-touch-dragging");
  hideNotesSelectionButton();
  // The same containment suspension 960ec1e added, driven from the gesture
  // instead of guessed at from a burst of selectionchange events: we know
  // exactly when a drag starts now.
  markSelectionStableRegion();
}

function endDrag() {
  stopEdgeScroll();
  draggingHandle = "";
  pressDragging = false;
  grabOffsetY = 0;
  setTouchSelectionDragging(false);
  document.body.classList.remove("is-touch-dragging");
  clearSelectionStableRegion();
  updateHandles();
  // Straight to the real thing: the 300ms quiet window in selection.js was only
  // ever a way of guessing that a native handle had been let go, and a handle we
  // drew tells us directly.
  positionNotesSelectionButton();
}

// ── The handles' own gestures ──────────────────────────────────────────────
//
// Touch events are delivered to the element the touch STARTED on for the whole
// gesture, so a listener on the handle keeps receiving moves after the finger
// has left it — which is what a drag is. Non-passive, because preventDefault
// here is what stops the reading surface scrolling under the drag.

function bindHandle(handle, which) {
  handle.addEventListener("touchstart", (event) => {
    if (!rangeStillLive()) return;
    event.preventDefault();
    event.stopPropagation();
    draggingHandle = which;
    // Grabbing a handle pins the OTHER end. Recomputed from the range rather
    // than trusting anchorPoint, because the previous drag may have swapped
    // them.
    anchorPoint = which === "start"
      ? { node: liveRange.endContainer, offset: liveRange.endOffset }
      : { node: liveRange.startContainer, offset: liveRange.startOffset };
    // Measure the grab rather than assuming it: the distance from the fingertip
    // to the caret this handle marks depends on the line's height and on where
    // in the bulb the thumb landed. A constant that is out by half a line is
    // exactly the "indicators are wrong" complaint, reintroduced by us.
    const touch = event.touches[0];
    const rect = edgeRect(liveRange, which === "start");
    grabOffsetY = (touch && rect)
      ? touch.clientY - (rect.top + rect.height / 2)
      : HANDLE_GRAB_OFFSET_PX;
    beginDrag();
  }, { passive: false });

  handle.addEventListener("touchmove", (event) => {
    if (draggingHandle !== which) return;
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    const y = touch.clientY - grabOffsetY;
    extendTo(touch.clientX, y);
    updateEdgeScroll(touch.clientX, y);
  }, { passive: false });

  ["touchend", "touchcancel"].forEach((type) => {
    handle.addEventListener(type, (event) => {
      if (draggingHandle !== which) return;
      event.preventDefault();
      endDrag();
    }, { passive: false });
  });
}

// ── The press ──────────────────────────────────────────────────────────────

function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = null;
  pressActive = false;
}

function pointInSelection(x, y) {
  if (!rangeStillLive()) return false;
  const rects = liveRange.getClientRects();
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) return true;
  }
  return false;
}

function firePress(root, x, y) {
  pressTimer = null;
  pressActive = false;
  if (!canTouchSelect()) return;

  // The card swipe recogniser stands down EXPLICITLY now. Its own dwell timer
  // (swipe.js, longPressGraceMs) still exists for the native fallback path, but
  // when we own the gesture there is nothing to infer — we know a press just
  // became a selection, and updateSwipe's preventDefault must not run again for
  // this finger.
  resetCardDrag();

  const atomic = atomicAt(x, y, root);
  if (atomic) {
    const range = document.createRange();
    try { range.selectNode(atomic); } catch (_) { return; }
    if (setSelectionPoints(
      { node: range.startContainer, offset: range.startOffset },
      { node: range.endContainer, offset: range.endOffset },
      root
    )) {
      navigator.vibrate?.(8);
      pressDragging = true;
      beginDrag();
    }
    return;
  }

  const caret = caretInRoot(x, y, root);
  if (!caret) return;
  const bounds = wordBoundsAt(caret.node.nodeValue || "", caret.offset);
  const start = bounds ? bounds.start : Math.max(0, caret.offset - 1);
  const end = bounds ? bounds.end : Math.min((caret.node.nodeValue || "").length, caret.offset + 1);
  if (start === end) return;
  if (!setSelectionPoints({ node: caret.node, offset: start }, { node: caret.node, offset: end }, root)) return;

  navigator.vibrate?.(8);
  // The finger that pressed keeps extending, exactly as it does natively:
  // press, then slide without lifting.
  pressDragging = true;
  anchorPoint = { node: caret.node, offset: start };
  focusPoint = { node: caret.node, offset: end };
  beginDrag();
}

function onRootTouchStart(event) {
  if (!canTouchSelect()) return;
  if (event.touches.length !== 1) { cancelPress(); return; }
  const root = event.currentTarget;
  const touch = event.touches[0];

  // A press that lands inside the current selection is a grab, not a new
  // selection — leave it alone so the reader can reach for a handle. Anything
  // else outside it dismisses.
  if (liveRange && !pointInSelection(touch.clientX, touch.clientY)) clearTouchSelection();

  pressX = touch.clientX;
  pressY = touch.clientY;
  pressActive = true;
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = setTimeout(() => firePress(root, pressX, pressY), LONG_PRESS_MS);
}

// Non-passive, and it early-returns in two property reads when there is no
// gesture of ours in flight. The cost of a non-passive touchmove listener is a
// main-thread round trip on the FIRST move of a scroll, which this surface
// already pays — every reading surface here has a non-passive scroll consumer
// somewhere. The benefit is press-and-slide: without preventDefault the page
// scrolls out from under a selection the reader is still making, which is the
// single most common way a native selection gets lost.
function onRootTouchMove(event) {
  if (pressDragging) {
    const touch = event.touches[0];
    if (!touch) return;
    event.preventDefault();
    // No offset on this one, deliberately. The finger that pressed is already
    // ON the word it selected, and moving the caret away from it would make
    // press-and-slide feel like it had missed. Offsetting is for a handle, which
    // is grabbed by a bulb that hangs below the line.
    extendTo(touch.clientX, touch.clientY);
    updateEdgeScroll(touch.clientX, touch.clientY);
    return;
  }
  if (!pressActive) return;
  const touch = event.touches[0];
  if (!touch) { cancelPress(); return; }
  if (Math.hypot(touch.clientX - pressX, touch.clientY - pressY) > PRESS_SLOP_PX) cancelPress();
}

// preventDefault here is not optional, and it is not about scrolling.
//
// A touchend that is allowed its default action synthesises the compatibility
// mouse sequence — mousedown, mouseup, click — and Chrome answers a mousedown on
// the page by COLLAPSING the selection to a caret at that point. Natively that
// never happens, because the browser owns both halves and knows the press it
// just resolved was a selection. Here the two halves are ours and the browser's,
// so lifting the finger at the end of a press-drag threw the selection away
// roughly 50ms after making it: the pill flashed up and vanished, and the note
// looked like the press had done nothing at all.
//
// Only for a gesture that actually became a selection. An ordinary tap keeps its
// mouse events — every link, cloze, image control and highlight in a note is
// reached by one.
function onRootTouchEnd(event) {
  const wasSelecting = pressDragging || Boolean(draggingHandle);
  cancelPress();
  if (pressDragging) endDrag();
  if (wasSelecting) event.preventDefault();
}

// ── Arming and disarming ───────────────────────────────────────────────────

const boundRoots = new Set();

function bindRoot(root) {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener("touchstart", onRootTouchStart, { passive: true });
  root.addEventListener("touchmove", onRootTouchMove, { passive: false });
  // Non-passive, because the whole job of the touchend handler is a
  // preventDefault — see the comment above it.
  root.addEventListener("touchend", onRootTouchEnd, { passive: false });
  root.addEventListener("touchcancel", onRootTouchEnd, { passive: false });
  root.addEventListener("scroll", scheduleHandleUpdate, { passive: true });
  // Long press over a link or an image would otherwise open Chrome's own
  // context menu on top of the selection we just made. A link is still followed
  // by an ordinary tap; this only refuses the menu.
  root.addEventListener("contextmenu", (event) => {
    if (!canTouchSelect()) return;
    event.preventDefault();
  });
}

function arm() {
  if (armed) return;
  armed = true;
  // Tell selection.js the gesture has an owner. Everything it inferred about a
  // native handle from a burst of selectionchange events is now a fact somebody
  // reports, and running both at once is a race — see setTouchSelectionArmed.
  setTouchSelectionArmed(true);
  document.body.classList.add("has-touch-select");
  touchSelectionRoots().forEach(bindRoot);
  buildOverlay();
}

function disarm() {
  if (!armed) return;
  armed = false;
  setTouchSelectionArmed(false);
  clearTouchSelection();
  document.body.classList.remove("has-touch-select");
  destroyOverlay();
  // Leaving a registered highlight behind would paint nothing (its range is
  // gone) but would still be visible to anything enumerating CSS.highlights, and
  // the desktop check asserts it is absent.
  try { window.CSS?.highlights?.delete(HIGHLIGHT_NAME); } catch (_) { /* never registered */ }
  touchHighlight = null;
}

function syncGate() {
  if (canTouchSelect()) arm();
  else disarm();
}

export function initTouchSelection() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  syncGate();
  // Live, so plugging a mouse into a tablet — or toggling devtools device
  // emulation — hands native selection straight back rather than leaving the
  // reader on a surface where user-select is off and nothing has replaced it.
  touchSelectMedia?.addEventListener?.("change", syncGate);

  // Anything that drops the document selection drops ours with it. Every pill
  // action ends in removeAllRanges(), so this is the one listener that keeps the
  // painted highlight and the app's own idea of the selection in step, instead
  // of a clearTouchSelection() call bolted onto each of them.
  document.addEventListener("selectionchange", () => {
    if (!liveRange || !liveRoot) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
      clearTouchSelection({ keepDocumentSelection: true });
      return;
    }
    if (!liveRoot.contains(selection.anchorNode) || !liveRoot.contains(selection.focusNode)) {
      clearTouchSelection({ keepDocumentSelection: true });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && liveRange) clearTouchSelection();
  });

  window.addEventListener("resize", scheduleHandleUpdate, { passive: true });
}
