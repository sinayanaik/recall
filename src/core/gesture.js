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
