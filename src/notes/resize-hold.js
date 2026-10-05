// Keeping the reader on the line they were reading when the note changes width.
//
// "Jumping from landscape to portrait, both in PDF and notes, I'm seeing
// significant content jump." Turning the phone re-wraps every line of the note,
// and nothing used to keep the reader's place through it. A continuous note had
// only the browser's own scroll anchoring, which works one whole block at a
// time, and which the browser itself switches off when the padding changes in
// the same update. A paged note re-measured its place inside a ResizeObserver,
// after the new columns were already laid out, and so looked the old scrollLeft
// up in the new layout. Then the scrolls the re-flow set off were saved as the
// reader's position, so even a reload did not bring them back.
//
// The cure is the same on both surfaces, and the same as the PDF reader's (see
// relayoutDocumentHoldingReader in src/documents/pdf-view.js). Remember where
// the reader is as of the last SETTLED layout. When the size changes, put them
// back THERE instead of measuring again, and let nothing the re-flow does write
// over it until it is done.
//
//   • Remembered: the block on the reading line and how far down it the line
//     falls (continuous), or the first block on the page (paged), plus the size
//     of the view it was measured in. Taken when scrolling stops, including the
//     app's own scrolls (a resume landing, a jump), since those also put the
//     reader somewhere.
//   • Not remembered while the view is a different size from the last record
//     and no hold has run yet: that is a re-flow this module has not heard about
//     yet, and the scroll it caused is not the reader's.
//   • Held: a width change (any size change in paged mode, where the height
//     cuts the columns too) starts a hold on the remembered block. Every
//     further resize in the same turn (full screen, the rotation itself, the
//     URL bar, the chrome re-measuring) re-aims at that SAME block and never at
//     an intermediate layout. The hold ends once the size has been still for a
//     moment.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
import { convergeNotesScroll } from "./anchors.js?v=__BUILD__";
import { isNotesEditing } from "./notes-view.js?v=__BUILD__";
import { firstVisibleNotesBlock, isNotesPaged, notesCurrentPage, notesPageForElement, setPagedResizeAnchorSource } from "./paged-view.js?v=__BUILD__";
import {
  isResumeLanding,
  notesBlockAtReadingLineGeometric,
  notesReadingLineOffset,
  scheduleReadingAnchorCapture,
  setReflowHolding
} from "./scroll-anchor.js?v=__BUILD__";

// How long after scrolling stops the position is taken. Shorter than the
// reading-anchor capture (150ms), so the one in memory when a turn begins is
// never older than the one being saved.
const SETTLE_CAPTURE_MS = 120;

// How long the size has to stay put before a hold lets go. A turn arrives as
// several resizes over a few hundred milliseconds (full screen, the rotation,
// the URL bar, the chrome re-measuring a frame later), and each must re-aim at
// the block from BEFORE the first of them.
const HOLD_QUIET_MS = 320;

// How long each aim keeps correcting while tables refit, diagrams redraw and
// chunks swap estimated heights for real ones at the new width.
const HOLD_CONVERGE_MS = 1000;

let lastSettled = null;
let captureTimer = 0;
let hold = null;

function notesViewMeasurable(view) {
  return Boolean(view && !view.hidden && view.clientWidth && state.viewMode === "notes" && !isNotesEditing());
}

// The view is a different size from the one the remembered position was taken
// in. Height only counts in paged mode: a continuous note re-wraps on width
// alone, and on a phone the height changes every time the URL bar moves.
function sizeDiffers(record, view, paged) {
  if (!record) return false;
  if (view.clientWidth !== record.width) return true;
  return paged && view.clientHeight !== record.height;
}

function readingLineTop(view) {
  return view.getBoundingClientRect().top + notesReadingLineOffset(view.clientHeight);
}

function measureSettledPosition(view) {
  const paged = isNotesPaged();
  const size = { width: view.clientWidth, height: view.clientHeight, paged };
  if (paged) {
    const block = firstVisibleNotesBlock();
    return block ? { ...size, block, fraction: 0 } : null;
  }
  // At the very top there is nothing to hold: the top of the note stays the
  // top at any width, and aiming a re-wrapped first block back at the reading
  // line would scroll a reader who had not moved.
  if (view.scrollTop <= 0) return null;
  const block = notesBlockAtReadingLineGeometric();
  if (!block) return null;
  const rect = withChunkRendered(block, view, () => block.getBoundingClientRect());
  const fraction = rect.height ? (readingLineTop(view) - rect.top) / rect.height : 0;
  return { ...size, block, fraction };
}

// Record where the reader is now, unless a re-flow is in progress or pending.
// `afterHold`: the record in hand is the one a hold has just put the reader
// back on, and the new size is the settled one — not a re-flow still pending.
export function noteSettledNotesPosition({ afterHold = false } = {}) {
  clearTimeout(captureTimer);
  captureTimer = 0;
  const view = el.notesView;
  if (hold || !notesViewMeasurable(view)) return;
  if (!afterHold && lastSettled?.block?.isConnected && sizeDiffers(lastSettled, view, isNotesPaged())) return;
  const measured = measureSettledPosition(view);
  // Paged: a block held through a turn stays the anchor for as long as it is on
  // the page shown — see endHold. Only turning the page replaces it.
  const kept = lastSettled?.paged && measured?.paged && lastSettled.block?.isConnected
    && notesPageForElement(lastSettled.block) === notesCurrentPage();
  lastSettled = kept ? { ...measured, block: lastSettled.block } : measured;
}

export function scheduleSettledNotesCapture() {
  if (hold) return;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => noteSettledNotesPosition(), SETTLE_CAPTURE_MS);
}

// Signed pixels from where the held line is now to the reading line, or null
// when the block has left the document (a re-render, a deck swap).
function holdResidual(view, anchor, generation) {
  if (!hold || hold.generation !== generation) return null;
  const { block, fraction } = anchor;
  if (!block.isConnected || !view.contains(block)) return null;
  const rect = withChunkRendered(block, view, () => block.getBoundingClientRect());
  return rect.top + fraction * rect.height - readingLineTop(view);
}

function aimContinuous(view) {
  hold.generation += 1;
  const generation = hold.generation;
  const anchor = hold.anchor;
  hold.converging = convergeNotesScroll(() => holdResidual(view, anchor, generation), HOLD_CONVERGE_MS, { smooth: false })
    .catch(() => {});
}

function endHold() {
  if (!hold) return;
  const current = hold;
  const { converging, timer } = current;
  // Not while an aim is still correcting: the next resize of the same turn can
  // still be on its way, and letting go mid-aim would let it be measured. A
  // resize that arrives meanwhile re-aims and re-arms the timer, and it is that
  // later timer's call that lets go — never this one.
  Promise.resolve(converging).then(() => {
    if (hold !== current || current.converging !== converging || current.timer !== timer) return;
    hold = null;
    setReflowHolding(false);
    // Re-taken at the new size, from the held record rather than from nothing.
    // A page shows several blocks, and the first of them at the new size is
    // usually not the one that was held — a paragraph that started on the page
    // before now ends on this one. Re-measuring from scratch would make that
    // paragraph the anchor for the NEXT turn, and every turn and back would
    // walk the reader one block further towards the start.
    lastSettled = current.anchor;
    noteSettledNotesPosition({ afterHold: true });
    // The reader's saved position is re-taken from where the hold put them, so
    // nothing the re-flow did in between is the last word.
    scheduleReadingAnchorCapture();
  });
}

function onNotesViewResize() {
  const view = el.notesView;
  // A hidden view reports no size. It is measured again when it comes back,
  // against the record from before it went — so a phone turned while the
  // reader was on Cards or the PDF still comes back to the right line.
  if (!view || !view.clientWidth) return;
  const paged = isNotesPaged();
  if (!hold) {
    if (!lastSettled || !sizeDiffers(lastSettled, view, paged)) return;
    const anchor = lastSettled;
    // Anything that owns the scroller already, or a record that no longer
    // describes this note: drop the record rather than hold, so the next settle
    // can take a fresh one.
    if (!notesViewMeasurable(view) || isResumeLanding() || anchor.paged !== paged || !anchor.block.isConnected) {
      lastSettled = null;
      return;
    }
    hold = { anchor, generation: 0, converging: null, timer: 0 };
    setReflowHolding(true);
  }
  clearTimeout(hold.timer);
  hold.timer = setTimeout(endHold, HOLD_QUIET_MS);
  // Paged mode's own observer re-paginates and asks pagedResizeAnchor() below
  // which block to turn to; only the continuous note is aimed from here.
  if (!hold.anchor.paged) aimContinuous(view);
}

// What repaginateNotesPreservingPlace turns to after a resize: the held block,
// or — when its observer runs before this module's has started the hold, as it
// does, being the older of the two — the settled one, as long as the view has
// changed size since it was taken.
function pagedResizeAnchor() {
  const view = el.notesView;
  const record = hold?.anchor || lastSettled;
  if (!view || !record?.paged || !record.block?.isConnected) return null;
  if (!hold && !sizeDiffers(record, view, true)) return null;
  return record.block;
}

export function initNotesResizeHold() {
  const view = el.notesView;
  if (!view) return;
  setPagedResizeAnchorSource(pagedResizeAnchor);
  if (typeof ResizeObserver === "function") new ResizeObserver(onNotesViewResize).observe(view);
}
