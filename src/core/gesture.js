// Is a finger in the middle of a selection gesture on a reading surface?
//
// A LEAF module — it imports NOTHING, for the reason src/core/constants.js
// states at length: everything else may import from core/*, so an import back
// out of here would close a cycle.
//
// ── Why this one value could not live where the others do ──────────────────
//
// src/notes/selection.js already owns the gesture flags the app reads
// (touchSelectionDragActive, isSelectionAdjusting) and src/notes/touch-selection.js
// already sets them. Two modules now need to ask the same question from the
// OTHER side of an existing edge:
//
//   • src/render/block-cache.js, so the viewport renderer does not lex and build
//     a span inside the gesture (see notesLazyBuildObserver).
//   • src/notes/notes-view.js, so settleNotesPin does not write scrollTop while
//     a press is still resolving.
//
// selection.js imports measureNotesChunkEstimate FROM block-cache.js, so
// block-cache.js importing the flag back out of selection.js would close a
// cycle around a module pair that both evaluate real work at load. The
// documented answer to that in this codebase is a module that imports nothing,
// and this is it.
//
// ── Wider than "dragging" on purpose ───────────────────────────────────────
//
// touchSelectionDragActive() means a selection is being ADJUSTED — the press has
// already fired and a boundary is moving. This flag also covers the 240ms press
// window before that, which is the half both callers above actually needed: a
// press is cancelled if the content under the resting finger moves more than
// PRESS_SCROLL_TOLERANCE_PX (src/notes/touch-selection.js), so a pin correction
// or a span build landing inside that window cancels a press the reader was in
// the middle of making. That is the "I have to press again and again" report,
// arriving by a route the drag flag cannot see because the drag has not started.

// ── Telling the holders the gesture is over ────────────────────────────────
//
// Work deferred while the flag was up has to be paid back the moment it drops,
// and the deferring module is the one that knows what it deferred. A listener
// here rather than a direct call from touch-selection.js keeps the direction of
// the edge honest: render/ does not import notes/, and notes/touch-selection.js
// does not have to know which subsystems are currently standing down for it.
//
// Declared ahead of the setter that reads it: this is a `const` in a module,
// and a call that reached it before this line ran would be a dead-zone read.
// Nothing does — the setter only runs on a touch — but the ordering is the
// discipline core/ is for.
const releaseListeners = new Set();

// One boolean rather than a count: the controller refuses a second finger
// outright (onRootTouchStart cancels the press on `touches.length !== 1`), so
// there is never more than one gesture in flight.
let holdsSurface = false;

// Cleared by every path that ends a touch — cancelPress(), endDrag(),
// clearTouchSelection() and the touchend handler itself. It must never be left
// set: a stuck `true` would silently switch the viewport renderer's promotion
// off for the rest of the session, which is a worse bug than the one this is
// fixing. The touchend handler is the backstop that makes that impossible.
export function setTouchGestureHoldsSurface(active) {
  const next = Boolean(active);
  if (next === holdsSurface) return;
  holdsSurface = next;
  if (holdsSurface) return;
  releaseListeners.forEach((listener) => {
    // One listener throwing must not strand the others — a span left unbuilt is
    // a blank screenful of a book.
    try { listener(); } catch (_) { /* the next release tries again */ }
  });
}

export function touchGestureHoldsSurface() {
  return holdsSurface;
}

export function onTouchGestureRelease(listener) {
  if (typeof listener === "function") releaseListeners.add(listener);
}

// ── Is a pen on the glass? ─────────────────────────────────────────────────
//
// A second flag rather than a second meaning for the one above, because the two
// answer different questions and one caller reads each: touchGestureHoldsSurface
// means "a finger is part-way through making a selection", and this means "a
// stylus is in contact and everything else should keep out of its way".
//
// It lives here for the same reason that one does, and for one more that is
// specific to it. A stylus on Android and an Apple Pencil on iPadOS both fire
// COMPATIBILITY TOUCH EVENTS alongside their pointer events, so the touch
// selection controller sees a pen as a finger and starts its press timer under
// a stroke the reader is drawing. The controller cannot tell the two apart from
// a TouchEvent: Safari has Touch.touchType, Android has nothing standard, and
// radius and force are not reliable enough to bet a reading surface on.
//
// What IS reliable is that the pen's own pointerdown handler knows perfectly
// well that it is a pen. So it says so here, and the controller asks. That is a
// fact one side has and the other needs, which is what this module is for.
//
// Deliberately set for EVERY pen contact and not only for strokes — including
// the press that turns out to be a tap. A tap is over in under 150ms and
// nothing is lost by the controller ignoring it; a press timer allowed to run
// under a pen that has not yet decided is a selection appearing mid-stroke.
let penIsDown = false;

export function setInkPenDown(active) {
  penIsDown = Boolean(active);
}

export function inkPenIsDown() {
  return penIsDown;
}

// ── Was the last thing that touched the paper a pen, and how long ago did it
//    stop drawing? ────────────────────────────────────────────────────────
//
// The flag above answers "is a nib on the glass RIGHT NOW", and that is the
// wrong question for the fault these two are here for. Writing a sentence is a
// shower of contacts that are each over in well under the 150ms
// src/documents/pdf-ink.js calls a TAP — an i-dot, a comma, a tick, an accent,
// a retouch of the letter before — and a tap deliberately commits no ink and
// deliberately lets the browser's click through, which is what lets a pen press
// a numbered note badge or a button at all. The click then lands on the page,
// within six PDF points of ink already on it, and opens that stroke's highlight
// menu. Reported as "the more menu keeps popping up while I am writing", and it
// is one of these per dotted i.
//
// So two more facts, and they are deliberately different shapes:
//
//   • WHICH instrument last touched the surface. A refusal aimed at the pen must
//     not cost a finger or a mouse anything — touch never draws (that is the
//     palm rejection), so a finger tap stays the route to a stroke's menu on a
//     tablet, and a mouse does not write words so it never produces the shower.
//   • WHEN a stroke last ended, so the refusal can widen to text highlights for
//     as long as somebody is actually writing. Writing in the margin of a
//     highlighted paragraph puts every i-dot inside a text mark's quad, which
//     the instrument test alone cannot see; and a reader who pauses and then
//     taps a mark deliberately is past the window and gets their menu.
//
// Here rather than in pdf-ink.js for the reason inkPenIsDown is here, stated
// once more because it is the whole argument for this module: pdf-ink.js
// imports pdf-highlights.js, so pdf-highlights.js — which owns the menu and
// therefore owns the refusal — cannot import the file that knows about the pen.
// A leaf both sides may read is the answer, and this is the leaf.
let lastContactWasInkingPen = false;

let lastInkStrokeAt = 0;

// Called for EVERY contact the ink layer sees, taken or refused, and that is
// load-bearing rather than tidy. A refused contact (the `text` tool is armed, a
// press that landed on a markdown block, a finger) must CLEAR the flag, or the
// previous stroke's answer stands and a finger tap inherits the pen's refusal.
export function noteInkContact(pointerType, took) {
  lastContactWasInkingPen = pointerType === "pen" && Boolean(took);
}

export function lastInkContactWasPen() {
  return lastContactWasInkingPen;
}

// Stamped where the stroke ENDS rather than where it begins: the window this
// feeds measures the gap between one mark and the next, and a stroke that took
// two seconds to draw has not left a two-second gap behind it.
export function noteInkStrokeCommitted() {
  lastInkStrokeAt = Date.now();
}

export function msSinceLastInkStroke() {
  return lastInkStrokeAt ? Date.now() - lastInkStrokeAt : Infinity;
}

// ── ...and is the pen being used as a pen at all? ──────────────────────────
//
// The pen's rail has a fourth tool, "text" (src/format/ink-colors.js), and it
// means the stylus stops drawing and starts selecting words instead — which is
// the only way a stylus can reach the highlighter, the cloze and the rest of
// what the selection pill already offers on a paper.
//
// The flag lives here for the same reason inkPenIsDown does, and for one more.
// The pen gesture is in src/notes/touch-selection.js, because every private it
// needs — setSelectionPoints, beginDrag, extendTo, the one-pass-per-frame
// scheduler — is already in that file and exporting four drag internals to a
// second controller would be two controllers answering to one name. But that
// file must not import the document subtree: its own comment above the region
// check in onRootTouchStart says so, and asks the DOM rather than
// isRegionSelectArmed for exactly that reason. So the ink layer STATES which
// tool is armed, here, where a leaf can be read from either side.
//
// Deliberately a fact about the TOOL and not about the rail. A stylus draws
// whether the rail is open or shut — src/ui/ink-rail.js's header calls that the
// whole promise of the feature — so a stylus must select whether it is open or
// shut too, and refreshInkRail returns early on a closed rail.
let penTextTool = false;

export function setPenTextMode(active) {
  penTextTool = Boolean(active);
}

export function penTextMode() {
  return penTextTool;
}
