// Moving a teleprompter's text by whole lines, onto its reading band — for the
// keys and a mouse wheel on a desktop (src/notes/teleprompter.js and
// src/documents/pdf-teleprompter.js).
//
// The browser's own answers were wrong for a reading band. A wheel notch is
// 100px whatever the type, which at the teleprompter's size is a line and a
// half: every notch left the line to read part in and part out of the band.
// And ↑ ↓ only scroll the element the keyboard happens to be on, which after a
// press on the bar or a drag of a slider is that button or that slider — so
// they did nothing, or changed the type. Here a step is counted in the note's
// own lines, found where they are drawn, and ends with one of them on the band.
//
// The glide is the reader's own scroll, not the app's: it is not announced as
// programmatic, so their place is saved as for any other scroll.

import { caretFromPoint } from "./raw-offset.js?v=__BUILD__";

// ── Lines, where they are drawn ─────────────────────────────────────────────

// The line box a caret at (x, y) sits on, in viewport px; null where there is
// no text to put one.
function lineBoxAt(x, y) {
  const caret = caretFromPoint(x, y);
  if (!caret?.node) return null;
  const range = document.createRange();
  let rect = null;
  try {
    range.setStart(caret.node, caret.offset);
    range.collapse(true);
    rect = range.getClientRects()[0] || null;
    // A caret between two elements, or at the very end of a line, has no box of
    // its own: one character of the text either side of it has.
    if ((!rect || !rect.height) && caret.node.nodeType === 3 && caret.node.length) {
      const at = Math.min(caret.offset, caret.node.length - 1);
      range.setStart(caret.node, at);
      range.setEnd(caret.node, at + 1);
      rect = range.getClientRects()[0] || null;
    }
  } catch {
    return null;
  }
  return rect && rect.height ? { top: rect.top, bottom: rect.bottom } : null;
}

// The middles of the lines of text between two heights of the viewport, in
// order, read down a vertical at `x`. Middles, not tops: a caret's box is the
// type's height, not the line's, and the leading is shared above and below. A
// picture or a table, where a caret has no line, is stepped over a third of a
// line at a time; never more than a few dozen hit-tests, and only of what is
// on screen.
export function lineMiddlesBetween(x, fromY, toY, lineHeight) {
  const middles = [];
  const step = Math.max(4, lineHeight / 3);
  let y = fromY;
  for (let probes = 0; probes < 80 && y <= toY; probes += 1) {
    const box = lineBoxAt(x, y);
    const usable = box && box.bottom > y - 0.5 && box.bottom - box.top < lineHeight * 2.5;
    if (!usable) {
      y += step;
      continue;
    }
    const middle = (box.top + box.bottom) / 2;
    if (middle >= fromY && middle <= toY && !middles.some((seen) => Math.abs(seen - middle) < 2)) middles.push(middle);
    y = Math.max(y + 1, box.bottom + 1);
  }
  return middles.sort((a, b) => a - b);
}

// ── The glide ───────────────────────────────────────────────────────────────

// Long enough to see which way the text went, short enough that holding ↓
// reads as a steady scroll.
const GLIDE_MS = 110;

const glides = new WeakMap();

let glideReducedMotionQuery = null;

function glideReducedMotion() {
  if (!glideReducedMotionQuery && typeof matchMedia === "function") glideReducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  return Boolean(glideReducedMotionQuery?.matches);
}

// Where a glide still has to take the view: added to a step asked for while
// one is under way, so presses in quick succession add up rather than each
// starting from wherever the last had got to.
export function pendingGlidePx(view) {
  const glide = glides.get(view);
  return glide ? glide.to - view.scrollTop : 0;
}

export function stopGlide(view) {
  const glide = glides.get(view);
  if (!glide) return;
  cancelAnimationFrame(glide.frame);
  glides.delete(view);
}

// Eases the view's scrollTop to `top`. `done` runs once it is there (not if
// something else moved the view meanwhile — a reader's own scroll wins).
export function glideScrollTo(view, top, { done = null } = {}) {
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  const to = Math.max(0, Math.min(max, top));
  stopGlide(view);
  if (glideReducedMotion() || Math.abs(to - view.scrollTop) < 1) {
    view.scrollTop = to;
    done?.();
    return;
  }
  const glide = { from: view.scrollTop, to, start: performance.now(), written: view.scrollTop, frame: 0 };
  const frame = (now) => {
    if (glides.get(view) !== glide) return;
    // Moved by something else since the last frame: theirs.
    if (Math.abs(view.scrollTop - glide.written) > 1.5) {
      glides.delete(view);
      return;
    }
    const progress = Math.min(1, (now - glide.start) / GLIDE_MS);
    const eased = 1 - (1 - progress) ** 3;
    view.scrollTop = glide.from + (glide.to - glide.from) * eased;
    glide.written = view.scrollTop;
    if (progress < 1) {
      glide.frame = requestAnimationFrame(frame);
      return;
    }
    glides.delete(view);
    done?.();
  };
  glides.set(view, glide);
  glide.frame = requestAnimationFrame(frame);
}

// ── The wheel ───────────────────────────────────────────────────────────────

// A mouse wheel that clicks, as against a trackpad or a free-spinning wheel,
// which scroll by the pixel and must be left alone. Lines are a click
// (Firefox); in pixels, Chrome and Safari still say what the legacy event
// would have — 120 a click — and a trackpad gives itself away by reporting
// exactly three times its pixels there. Anything in doubt is left to the
// browser.
export function isNotchedWheel(event) {
  if (!event.deltaY || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (Math.abs(event.deltaX || 0) > Math.abs(event.deltaY) / 2) return false;
  if (event.deltaMode === 1) return true;
  if (event.deltaMode !== 0) return false;
  const legacy = Math.abs(event.wheelDeltaY || 0);
  if (!legacy || legacy % 120 !== 0) return false;
  return Math.abs(Math.abs(event.deltaY) * 3 - legacy) > 1;
}

// How many clicks one wheel event is: a fast spin can fold several into one.
export function wheelNotches(event) {
  const sign = Math.sign(event.deltaY);
  if (event.deltaMode === 1) return sign * Math.max(1, Math.round(Math.abs(event.deltaY) / 3));
  return sign * Math.max(1, Math.round(Math.abs(event.wheelDeltaY || 120) / 120));
}

// Whole lines a wheel click moves.
export const WHEEL_LINES = 2;
