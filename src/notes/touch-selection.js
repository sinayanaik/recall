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
// ── Owning the gesture is not the same as it feeling steady ────────────────
//
// The report after the takeover landed: "it somehow worked but ... a unstable
// visual behaviour, all functionality works but it only feels a little
// unstable — also it is not persistent, like when I am selecting and scroll to
// select more it forgets the previous selections, also it feels a little
// flickering."
//
// Four separate causes, all of them ours and all of them in this file:
//
//   • The dismissal was decided on the TOUCHSTART — a touch outside the
//     selection cleared it. A scroll begins with exactly that touch, so
//     scrolling to reach the rest of the passage threw the selection away
//     before the finger had moved a pixel, and a near-miss on a handle did the
//     same. It is decided on the touchEND now, where a tap and a scroll can be
//     told apart. See onRootTouchStart / onRootTouchEnd.
//
//   • A handle whose boundary had scrolled off the surface was hidden, so past
//     one screenful there was nothing left to grab. It parks at the edge
//     instead, and dragging a parked grip brings that boundary to the finger.
//     See placeHandle.
//
//   • The handles are on a fixed overlay moved by JavaScript, while the
//     reading surface scrolls on the compositor — they cannot be in step, so
//     they swam behind the text on every fling. They fade out while the surface
//     is moving and are placed again once it settles. The painted selection is
//     not affected by any of this and never was: ::highlight() is laid out by
//     the same pass as the text. See onRootScroll.
//
//   • extendTo() ran straight off every touchmove — up to twice a frame on a
//     120Hz phone — with layout-forcing rect reads interleaved with the class
//     writes of the containment pass. That is layout thrash. The event records
//     the point; one rAF does the work and places the handles in the same pass.
//     See runFrame / scheduleFrame.
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
import { NOTES_BLOCK_SELECTOR, caretFromPoint } from "./raw-offset.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS } from "../render/block-cache.js?v=__BUILD__";
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
// 240ms, against Android's own ~500ms, deliberately: the whole complaint is
// that selection takes too long to arrive, and we are not paying a main-thread
// round trip on top of it. This is under the ~250ms where a slow scroll start
// begins to register as a press, which used to be the floor — what buys the
// extra 80ms is the escape below, which takes the gesture back when a press
// that fired this early turns out to have been the start of a scroll.
export const LONG_PRESS_MS = 240;

// How far the finger may wander in that time and still be pressing. A real
// touch slop — a thumb resting on glass moves several pixels — and the same
// value swipe.js settled on for its own dwell test (dwellSlopPx).
export const PRESS_SLOP_PX = 10;

// The escape. For this long after a press fires, a finger that leaves in a
// hurry is a scroll that we called too early, not a reader extending their
// selection: the word is unselected again and the gesture is let go. Past the
// window a fast slide is just a fast slide and the selection stands.
//
// The two numbers are a pair. The window has to outlast the gap between the
// press firing and the reader's finger reacting to it (~a frame or two), and
// stay well inside the time a deliberate press-and-slide spends on its first
// word. The distance has to sit above PRESS_SLOP_PX — everything under that
// never became a press at all — and above the drift of a thumb rolling on
// glass, which is most of that 10px already.
export const PRESS_ESCAPE_MS = 120;
export const PRESS_ESCAPE_PX = 18;

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

// How long after the last scroll event the handles are placed again and faded
// back in. They are drawn on a fixed overlay and moved by JavaScript, while the
// reading surface scrolls on the compositor — so during a fling they can only
// ever trail the words they mark. Hiding them for the duration and restoring
// them once the view is still is the difference between a grip that swims and
// one that is simply not there yet. The painted selection is unaffected: the
// Custom Highlight API lays it out in the same pass as the text.
export const SCROLL_SETTLE_MS = 120;

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
// When the press fired, so the escape window can be measured from it. Only read
// while pressDragging — a handle drag never sets it.
let pressFiredAt = 0;
// { root, x, y } while an escaped gesture is being scrolled by us instead of by
// the browser, null the rest of the time. See beginEscapeScroll.
let escapeScroll = null;
// Where the finger first landed, and where the surface was scrolled to at that
// moment. The slop test is measured against the ORIGIN while pressX/pressY
// follow the finger, so a press that fires after a few pixels of thumb drift
// hit-tests where the finger actually is rather than where it started.
let pressOriginX = 0;
let pressOriginY = 0;
let pressRoot = null;
let pressScrollTop = 0;
let pressScrollLeft = 0;
// The block that was under the finger when it landed, and where it was on the
// GLASS at that moment. This is what "has the page moved" is measured against —
// see scrollDrift.
let pressAnchor = null;
let pressAnchorTop = 0;
let pressAnchorLeft = 0;
// A touch that landed outside the current selection MIGHT be a dismissal — but
// only if it turns out to be a tap. Deciding at touchstart is what threw a
// selection away the instant a reader put a finger down to scroll, which is the
// "it forgets the previous selection" half of the report.
let dismissPending = false;

let draggingHandle = "";   // "" | "start" | "end"
// How far the finger is below the caret it is choosing, measured at the grab.
// Zero for a press-drag, where the finger IS the caret.
let grabOffsetY = 0;
let edgeFrame = 0;
let edgeVector = 0;
let edgePoint = null;

// ── One pass per frame ─────────────────────────────────────────────────────
//
// A touchmove arrives up to twice a frame on a 120Hz phone, and extendTo() is
// not cheap: a hit-test, a binary search whose every step forces layout to read
// a caret rect, and a containment pass that writes classes. Running it straight
// off the event interleaved those reads with those writes — read, write, read —
// which is layout thrash, and it is what made a drag feel like it was
// stuttering rather than tracking.
//
// So the event only records WHERE the finger is. One rAF does the work, at most
// once per frame, and places the handles in the same pass — the handle update
// used to schedule a second frame of its own.
let framePoint = null;      // the finger, viewport coords, latest value wins
let frameHandle = 0;
let frameWantsExtend = false;
let lastExtendX = NaN;
let lastExtendY = NaN;

// The Range currently registered with the Highlight. The registration survives
// every mutation of that Range — it is live, and the highlight is repainted from
// it — so clear()+add() belongs to a NEW range and not to every drag frame.
let paintedRange = null;

let scrollSettleTimer = 0;

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
// A CHUNK is not an answer. On a note past NOTES_CHUNK_MIN_BLOCKS the reading
// surface's children are wrappers of forty blocks (src/render/block-cache.js),
// and a probe that lands in the margin between two of them resolves to the
// wrapper. Handing that to closestCaretIn means walking up to 400 text nodes and
// taking a rect off each — per drag frame, on a note where forty blocks is a lot
// of text. The nearest block INSIDE it is both the cheaper answer and the one the
// reader meant; picking it by vertical distance is the same rule closestCaretIn
// uses one level down.
function narrowToBlock(hit, y) {
  if (!hit?.classList?.contains(NOTES_CHUNK_CLASS)) return hit;
  let best = null;
  let bestDistance = Infinity;
  for (const child of hit.children) {
    const rect = child.getBoundingClientRect();
    if (!rect.height && !rect.width) continue;
    const distance = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = child;
    }
  }
  return best || hit;
}

function elementNear(x, y, root) {
  for (const dy of [0, -6, 6, -16, 16, -28, 28]) {
    const hit = document.elementFromPoint(x, y + dy);
    if (!hit || !root.contains(hit) || hit === root) continue;
    return narrowToBlock(hit, y);
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
    ? narrowToBlock(direct.node, cy)
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
  handleStart.className = "touch-select-handle is-start is-hidden";
  handleStart.innerHTML = '<i class="touch-select-bulb"></i>';
  handleEnd = document.createElement("span");
  handleEnd.className = "touch-select-handle is-end is-hidden";
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

// A boundary that has scrolled out of the reading surface does NOT lose its
// handle. It keeps one, PARKED against the edge it went off — flattened, so it
// reads as "the rest of this is up there" rather than as a grip sitting on the
// word beside it.
//
// Hiding it outright was the obvious thing and it is what made "scroll down and
// keep selecting" impossible: past one screenful there was no grip left on
// screen to grab, and the only way to extend was to scroll back to the one that
// had gone. Grabbing a parked handle drags from wherever the finger is (see
// grabOffsetY in bindHandle), which is what the reader means by grabbing it.
function hideHandle(handle) {
  handle.classList.add("is-hidden");
  // Parked is a claim about WHERE a visible grip is; leaving it set on a hidden
  // one leaves the claim standing for the next placement to trip over.
  handle.classList.remove("is-parked");
  handle.dataset.parked = "";
}

function placeHandle(handle, rect, box, horizontal) {
  if (!handle) return;
  if (!rect) {
    hideHandle(handle);
    return;
  }
  let left = rect.left;
  let top = rect.top;
  let parked = false;
  if (top < box.top) { top = box.top; parked = true; }
  else if (top + rect.height > box.bottom) { top = box.bottom - rect.height; parked = true; }
  // Paged mode scrolls sideways, so a boundary leaves by the left or right edge
  // rather than the top or bottom and the parking axis follows the mode.
  if (horizontal) {
    if (left < box.left) { left = box.left; parked = true; }
    else if (left > box.right) { left = box.right; parked = true; }
  } else if (left < box.left - 24 || left > box.right + 24) {
    // Off the side in a vertically scrolling view is not a scroll position, it
    // is a boundary in something laid out off to one side. Nothing to park to.
    hideHandle(handle);
    return;
  }
  handle.classList.remove("is-hidden");
  handle.classList.toggle("is-parked", parked);
  handle.dataset.parked = parked ? "1" : "";
  // transform rather than left/top: the handle is written on every frame of a
  // drag and on every scroll settle, and a transform is the one way to move a
  // box that costs no layout.
  handle.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  handle.style.height = `${Math.max(Math.round(rect.height), 12)}px`;
}

export function updateHandles() {
  if (!overlay) return;
  if (!rangeStillLive()) {
    if (liveRange) clearTouchSelection({ keepDocumentSelection: true });
    return;
  }
  // Read once for both handles: this runs on every frame of a drag, and
  // contentBox() is a rect read plus a computed-style read.
  const box = contentBox(liveRoot);
  const horizontal = edgeAxisIsHorizontal(liveRoot);
  placeHandle(handleStart, edgeRect(liveRange, true), box, horizontal);
  placeHandle(handleEnd, edgeRect(liveRange, false), box, horizontal);
}

function hideHandles() {
  if (handleStart) hideHandle(handleStart);
  if (handleEnd) hideHandle(handleEnd);
}

// The single frame callback. `extendTo` is only run when a drag asked for it;
// the handles are placed either way, because a scroll settling is a reason to
// move them and not a reason to move the selection.
function runFrame() {
  const wantsExtend = frameWantsExtend;
  frameWantsExtend = false;
  if (wantsExtend && framePoint && touchSelectionIsDragging()) extendTo(framePoint.x, framePoint.y);
  updateHandles();
}

function scheduleFrame(wantsExtend = false) {
  if (wantsExtend) frameWantsExtend = true;
  // The edge-scroll loop already runs exactly one pass per frame, and it runs
  // the same body — a second rAF alongside it would double the work and land a
  // frame late.
  if (frameHandle || edgeFrame) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = 0;
    runFrame();
  });
}

function scheduleHandleUpdate() {
  scheduleFrame(false);
}

// A scroll with a selection on screen: take the handles off the glass for the
// duration rather than letting them chase the text a frame behind it, and place
// them again once the view has been still for SCROLL_SETTLE_MS.
//
// Not during a drag. There the surface is being scrolled BY the gesture (the
// edge auto-scroll), the reader is holding the handle they are watching, and it
// has to stay under their thumb.
function onRootScroll(event) {
  // Only the surface the finger is actually on. Another view scrolling — a card
  // face behind the note, say — has a scroll offset this baseline knows nothing
  // about, and comparing against it would cancel a press for no reason.
  if (pressActive && event.currentTarget === pressRoot
      && scrollDrift(pressRoot) > PRESS_SCROLL_TOLERANCE_PX) {
    cancelPress();
  }
  if (touchSelectionIsDragging()) {
    scheduleFrame(false);
    return;
  }
  if (!liveRange) return;
  // The class alone, not is-hidden: the handles keep their boxes and fade,
  // which means the settle below can place them at their NEW positions and let
  // them fade back in there. Removing them from the layout and putting them
  // back is what a blink is.
  document.body.classList.add("is-touch-scrolling");
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
  scrollSettleTimer = setTimeout(() => {
    scrollSettleTimer = 0;
    document.body.classList.remove("is-touch-scrolling");
    updateHandles();
  }, SCROLL_SETTLE_MS);
}

function endScrollFade() {
  if (scrollSettleTimer) {
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = 0;
  }
  document.body.classList.remove("is-touch-scrolling");
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

// Registration, not painting: what is painted comes out of the Range, and the
// Range is LIVE. Re-registering it on every drag frame — clear() then add() of
// the same object — invalidated the whole highlight sixty times a second to
// arrive at the registration it already had. The new-range case is the only one
// that has to touch the set.
function paintTouchHighlight() {
  if (!liveRange) return;
  if (!touchHighlight) {
    touchHighlight = new window.Highlight();
    window.CSS.highlights.set(HIGHLIGHT_NAME, touchHighlight);
  }
  if (paintedRange === liveRange) return;
  touchHighlight.clear();
  touchHighlight.add(liveRange);
  paintedRange = liveRange;
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
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  frameWantsExtend = false;
  framePoint = null;
  lastExtendX = NaN;
  lastExtendY = NaN;
  dismissPending = false;
  endScrollFade();
  liveRange = null;
  liveRoot = null;
  anchorPoint = null;
  focusPoint = null;
  draggingHandle = "";
  pressDragging = false;
  grabOffsetY = 0;
  setTouchSelectionDragging(false);
  if (touchHighlight) touchHighlight.clear();
  paintedRange = null;
  document.body.classList.remove("is-touch-selecting");
  document.body.classList.remove("is-touch-dragging");
  hideHandles();
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
    // The finger has not moved — the CONTENT has — so the same point resolves
    // to a new caret every frame and the "did the point change" guard in
    // extendTo must not apply. runFrame() extends and places the handles in one
    // pass, which is the same body scheduleFrame() runs.
    framePoint = edgePoint;
    frameWantsExtend = true;
    lastExtendX = NaN;
    lastExtendY = NaN;
    runFrame();
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
  // A finger that has not moved a whole pixel since the last frame resolves to
  // the same caret, and the work of proving that is the expensive part: a
  // hit-test plus a binary search that forces layout at every step.
  if (Math.abs(x - lastExtendX) < 1 && Math.abs(y - lastExtendY) < 1) return;
  lastExtendX = x;
  lastExtendY = y;
  const caret = caretInRoot(x, y, liveRoot);
  if (!caret) return;
  const next = pointsToRange(anchorPoint, caret);
  if (!next || next.collapsed) return;
  focusPoint = caret;
  liveRange.setStart(next.startContainer, next.startOffset);
  liveRange.setEnd(next.endContainer, next.endOffset);
  // The Range is live and already registered with the Highlight, so this is an
  // identity check on a drag frame — the repaint follows the mutation above.
  paintTouchHighlight();
  mirrorToSelection();
  // Re-marked on every step, not once at the start of the drag: the chunk that
  // matters is the one being dragged INTO, and it is not known until the
  // boundary reaches it. Cheap to repeat — markSelectionStableRegion() compares
  // the wanted set against the marked one and touches no DOM when they match,
  // which is the overwhelmingly common case within a single paragraph.
  //
  // growOnly, because this is a drag: a chunk the selection has moved OFF is
  // handed its containment back at the end of the gesture and not in the middle
  // of one, where re-containing it is a style invalidation over everything
  // inside it on the frame the reader is dragging in.
  markSelectionStableRegion({ growOnly: true });
}

function beginDrag() {
  setTouchSelectionDragging(true);
  // A drag that starts mid-fling inherits the faded handles; the reader is
  // holding one, so it comes back now rather than on the settle timer.
  endScrollFade();
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
  markSelectionStableRegion({ growOnly: true });
}

function endDrag() {
  stopEdgeScroll();
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  frameWantsExtend = false;
  framePoint = null;
  lastExtendX = NaN;
  lastExtendY = NaN;
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
    //
    // Except for a PARKED handle, whose caret is off screen: there the offset
    // would be the distance to a boundary somewhere above the fold, and the
    // reader means "bring the boundary here". The finger is the caret.
    const touch = event.touches[0];
    const rect = edgeRect(liveRange, which === "start");
    grabOffsetY = handle.dataset.parked
      ? 0
      : ((touch && rect) ? touch.clientY - (rect.top + rect.height / 2) : HANDLE_GRAB_OFFSET_PX);
    beginDrag();
  }, { passive: false });

  handle.addEventListener("touchmove", (event) => {
    if (draggingHandle !== which) return;
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    const y = touch.clientY - grabOffsetY;
    framePoint = { x: touch.clientX, y };
    scheduleFrame(true);
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
  // Dropped rather than left behind: a note re-renders by replacing its blocks,
  // and holding the old one would keep a detached subtree alive for no reason.
  pressAnchor = null;
}

// Hand a mistaken press back to the reader as the scroll they meant.
//
// Dropping the selection is only half of it. By the time the escape fires we
// have already called preventDefault on a move or two of this gesture, and
// Chrome does not give a gesture back once that has happened — the browser's
// own scroller is out for the rest of the touch, however passive we go now. So
// the finger would sit on a surface that had stopped responding, which reads as
// a freeze rather than as a correction.
//
// We scroll it ourselves instead, one delta per move, until the finger lifts.
// No fling at the end of it — a rescued scroll is a short deliberate drag, and
// the next flick gets the browser's own scroller back with all of its momentum.
// Both axes, because the paged reading mode scrolls sideways; the axis a
// surface cannot scroll ignores the assignment.
function beginEscapeScroll(root, touch) {
  clearTouchSelection();
  hideNotesSelectionButton();
  escapeScroll = { root, x: touch.clientX, y: touch.clientY };
}

// The slop around the selection that still counts as "on it". Generous on
// purpose: the reader aiming here is reaching for a handle, and a miss used to
// throw the whole selection away.
export const SELECTION_HIT_SLOP_PX = 12;

function pointInSelection(x, y) {
  if (!rangeStillLive()) return false;
  // The union first. getClientRects() on a selection spanning a screenful of
  // prose is one rect per line FRAGMENT, and this runs on every touchstart —
  // including the one that starts an ordinary scroll. The union is a single rect
  // and rejects the overwhelming majority of points outright.
  const union = liveRange.getBoundingClientRect();
  if (x < union.left - SELECTION_HIT_SLOP_PX || x > union.right + SELECTION_HIT_SLOP_PX
      || y < union.top - SELECTION_HIT_SLOP_PX || y > union.bottom + SELECTION_HIT_SLOP_PX) {
    return false;
  }
  const rects = liveRange.getClientRects();
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (x >= r.left - SELECTION_HIT_SLOP_PX && x <= r.right + SELECTION_HIT_SLOP_PX
        && y >= r.top - SELECTION_HIT_SLOP_PX && y <= r.bottom + SELECTION_HIT_SLOP_PX) return true;
  }
  return false;
}

// How far the reading surface may move under a resting finger and still leave
// the press standing. Not zero, deliberately: a note's own layout settles while
// it is being read — a chunk's estimated height resolving, a deferred table
// laying itself out, the browser's scroll anchoring compensating for either —
// and cancelling on those would put back the "I have to fight the long press"
// bug that two commits have now been spent on. Past this the page is visibly
// moving, and a reader watching it move is not making a selection.
export const PRESS_SCROLL_TOLERANCE_PX = 10;

// The block under a point, for use as a drift reference. Deliberately a BLOCK
// rather than whatever `elementFromPoint` answered: an inline <em> or a <mark>
// can be replaced by a repaint while the paragraph around it survives, and a
// reference that vanishes costs us the measurement.
export function driftAnchorAt(x, y, root) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === root || !root.contains(hit)) return null;
  return hit.closest?.(NOTES_BLOCK_SELECTOR) || hit;
}

// ── "Has the page moved under this finger?" ────────────────────────────────
//
// This used to be `|scrollTop − scrollTop at touchstart|`, and scrollTop is the
// wrong quantity. The question the tolerance is asking is whether the reader is
// watching the page move, and on a note big enough to be chunked scrollTop moves
// precisely when the content does NOT: the browser's scroll anchoring adjusts it
// to hold the visible content still whenever something above the viewport
// changes height. Which is what measureNotesChunkEstimate does to every chunk
// that enters its runway, what a chunk laying out for the first time does
// anyway, and what pinChunkHeights (src/notes/selection.js) now does more of.
//
// So a finger resting on a perfectly still page had its press cancelled, over
// and over, on exactly the notes where the press is hardest to land. That is the
// "I have to press again and again" half of the report, and it cannot happen on
// a note too small to have chunks — which is why no small-fixture check ever saw
// it.
//
// Measuring the reference block's position on the glass answers the real
// question directly: scroll anchoring reads as zero movement, because zero
// movement is what it achieves. The scrollTop delta stays as the fallback for a
// gesture that never captured a reference (a press on the padding below the last
// block) or whose reference has been detached by a repaint.
function scrollDrift(root) {
  if (!root) return 0;
  if (pressAnchor && pressAnchor.isConnected && root.contains(pressAnchor)) {
    const rect = pressAnchor.getBoundingClientRect();
    return Math.abs(rect.top - pressAnchorTop) + Math.abs(rect.left - pressAnchorLeft);
  }
  return Math.abs(root.scrollTop - pressScrollTop) + Math.abs(root.scrollLeft - pressScrollLeft);
}

function firePress(root, x, y) {
  pressTimer = null;
  pressActive = false;
  if (!canTouchSelect()) return;
  // The surface moved under the finger during the press window, so the reader
  // is watching the page move rather than choosing a word on a still one. The
  // scroll listener normally cancels the press before this runs; this is for
  // the frame where the two race.
  if (scrollDrift(root) > PRESS_SCROLL_TOLERANCE_PX) { pressAnchor = null; return; }
  pressAnchor = null;
  // Whatever was selected is about to be replaced, so there is nothing left to
  // dismiss on the way up.
  dismissPending = false;
  // Stamped before the selection is made rather than after, so the escape
  // window covers the word snap and the first paint too — the reader's finger
  // starts leaving from the moment they feel the buzz, not from the moment we
  // finish drawing.
  pressFiredAt = performance.now();

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
  // Any new finger ends a rescued scroll: the one that was doing it has lifted,
  // or a second has joined it to pinch.
  escapeScroll = null;
  if (!canTouchSelect()) return;
  // A second finger. Not a press, and not a tap either — a pinch must not
  // dismiss the selection it is being zoomed over.
  if (event.touches.length !== 1) { cancelPress(); dismissPending = false; return; }
  const root = event.currentTarget;
  const touch = event.touches[0];

  // A touch that lands inside the current selection is a grab, not a new
  // selection — leave it alone so the reader can reach for a handle.
  //
  // A touch outside it MIGHT be a dismissal, and this is where that used to be
  // decided: `clearTouchSelection()`, on the touchstart, before anything was
  // known about the gesture. But a scroll begins with exactly this touch, and
  // scrolling to reach the rest of the passage you are selecting is the most
  // ordinary thing a reader does — so the selection was gone before their
  // finger had moved a pixel, which is "when I scroll to select more it forgets
  // the previous selections". A near-miss on a handle went the same way.
  //
  // So the decision is deferred to the touchEND, where the gesture is known: a
  // tap dismisses, a scroll does not. Chrome's own behaviour, and the reason
  // this was not simply a missing feature — a native selection survives a
  // scroll too.
  dismissPending = Boolean(liveRange) && !pointInSelection(touch.clientX, touch.clientY);

  pressOriginX = touch.clientX;
  pressOriginY = touch.clientY;
  pressX = touch.clientX;
  pressY = touch.clientY;
  pressRoot = root;
  pressScrollTop = root.scrollTop;
  pressScrollLeft = root.scrollLeft;
  // ...and the same baseline in content space, which is the one scrollDrift
  // actually prefers. Read once here rather than per scroll event: the rect is
  // only ever compared against itself.
  pressAnchor = driftAnchorAt(touch.clientX, touch.clientY, root);
  if (pressAnchor) {
    const rect = pressAnchor.getBoundingClientRect();
    pressAnchorTop = rect.top;
    pressAnchorLeft = rect.left;
  }
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
  // The rescued scroll, before anything else: this finger has already been
  // taken off a selection it never meant to make, and the surface is ours to
  // move until it lifts.
  if (escapeScroll) {
    const touch = event.touches[0];
    if (!touch) return;
    event.preventDefault();
    escapeScroll.root.scrollTop -= touch.clientY - escapeScroll.y;
    escapeScroll.root.scrollLeft -= touch.clientX - escapeScroll.x;
    escapeScroll.x = touch.clientX;
    escapeScroll.y = touch.clientY;
    return;
  }
  if (pressDragging) {
    const touch = event.touches[0];
    if (!touch) return;
    // The escape. A press that fires at 240ms sometimes catches a reader who
    // was only ever starting a scroll, and the way that reader tells us so is
    // by leaving immediately and fast. Take the selection back off them and
    // scroll instead of dragging a selection across the passage they wanted to
    // scroll past. A press-and-slide is slower off the mark than this and keeps
    // its selection; so does any slide that starts after the window.
    if (performance.now() - pressFiredAt < PRESS_ESCAPE_MS
        && Math.hypot(touch.clientX - pressOriginX, touch.clientY - pressOriginY) > PRESS_ESCAPE_PX) {
      beginEscapeScroll(event.currentTarget, touch);
      event.preventDefault();
      return;
    }
    event.preventDefault();
    // No offset on this one, deliberately. The finger that pressed is already
    // ON the word it selected, and moving the caret away from it would make
    // press-and-slide feel like it had missed. Offsetting is for a handle, which
    // is grabbed by a bulb that hangs below the line.
    framePoint = { x: touch.clientX, y: touch.clientY };
    scheduleFrame(true);
    updateEdgeScroll(touch.clientX, touch.clientY);
    return;
  }
  if (!pressActive && !dismissPending) return;
  const touch = event.touches[0];
  if (!touch) { cancelPress(); return; }
  const travelled = Math.hypot(touch.clientX - pressOriginX, touch.clientY - pressOriginY);
  if (travelled > PRESS_SLOP_PX) {
    // Moving is scrolling, and scrolling is not a dismissal.
    dismissPending = false;
    cancelPress();
    return;
  }
  // Inside the slop the press stands, but the finger has still drifted — aim
  // where it is now rather than where it landed, or a thumb that rolls a few
  // pixels selects the word next door.
  pressX = touch.clientX;
  pressY = touch.clientY;
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
  // A rescued scroll ends here, and it keeps the preventDefault a drag gets:
  // the finger travelled across the text, so the compatibility click that a
  // plain touchend would synthesise would land on whatever it finished over.
  if (escapeScroll) {
    escapeScroll = null;
    cancelPress();
    event.preventDefault();
    dismissPending = false;
    return;
  }
  const wasSelecting = pressDragging || Boolean(draggingHandle);
  const dismiss = dismissPending && !wasSelecting;
  dismissPending = false;
  cancelPress();
  if (pressDragging) endDrag();
  if (wasSelecting) event.preventDefault();
  // The gesture that landed outside the selection turned out to be a tap. THIS
  // is the dismissal — see onRootTouchStart for why it is not the touchstart.
  // A cancelled touch (the scroller taking the gesture over) is a scroll by
  // definition and never gets here with the flag still set, because the move
  // past the slop cleared it.
  if (dismiss && event.type !== "touchcancel") clearTouchSelection();
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
  // A scroll is three things at once here: the press timer's cancellation
  // (Android's own signal, and exact where the 10px slop test is a guess), the
  // reason to take the handles off the glass while the text is moving, and the
  // reason to put them back when it stops.
  root.addEventListener("scroll", onRootScroll, { passive: true });
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
  document.body.classList.remove("is-touch-scrolling");
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
  // The layout viewport is not the visual one on a phone. Android's URL bar
  // collapsing on a scroll, and the software keyboard opening, both move the
  // origin of a `position: fixed` layer without firing a window resize — so the
  // handles quietly drifted off their boundaries and stayed there.
  window.visualViewport?.addEventListener?.("resize", scheduleHandleUpdate, { passive: true });
  window.visualViewport?.addEventListener?.("scroll", scheduleHandleUpdate, { passive: true });
}
