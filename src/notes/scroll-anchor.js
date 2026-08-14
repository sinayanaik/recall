// Where you were reading, so the note reopens there — on this device and,
// through the deck's meta bag, on the others.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { approximateRawOffsetForBlock, findRawOffsetForRenderedPoint, rawOffsetForRenderedBlock } from "./raw-offset.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";

// A representative raw-markdown offset for whatever's currently at the top of
// the visible #notesView. Unlike the triple-click path, the "Edit notes"
// toolbar button has no click point to hand findRawOffsetForRenderedPoint —
// synthesize one near the top of the viewport instead, so leaving rendered
// mode via the button still lands raw-edit mode near where you were reading
// instead of always at the top.
// How far below the top of the notes viewport "where you are reading" is taken
// to be. THE one definition: the sampler below reads from this line and every
// restore (scrollNotesBlockToReadingLine, scrollTextareaToOffset) puts the
// target back on it, which is what makes a raw<->rendered round trip land you
// on the line you left rather than drifting each time.
// Takes the height explicitly because the two sides are never both on screen:
// in raw mode #notesView is hidden and reports clientHeight 0, so the editor
// has to measure against the textarea that replaced it.
export const NOTES_READING_LINE_MAX_PX = 64;

export function notesReadingLineOffset(viewportHeight) {
  const height = viewportHeight || el.notesView?.clientHeight || 0;
  return Math.min(NOTES_READING_LINE_MAX_PX, height / 3);
}

// The top-level block the reading line falls on, found GEOMETRICALLY rather than
// by hit-testing.
//
// blockAtNotesReadingLine (further down) asks elementFromPoint, which answers
// nothing useful in two very ordinary situations: the reading line resting in the
// margin gap between two blocks (elementFromPoint returns #notesView itself,
// which is not one of its own children) and the line sitting under a floating
// overlay, where the topmost element isn't inside the view at all. Both used to
// make the raw-mode toggle land at offset 0.
//
// Binary searched, not swept: these are `content-visibility: auto` blocks, so
// reading a rect forces the browser to lay one out — the same reason
// findRenderedNoteRange searches for its window's first member this way instead
// of testing every block from the top.
export function notesBlockAtReadingLineGeometric() {
  const view = el.notesView;
  if (!view || view.hidden) return null;
  const blocks = view.children;
  if (!blocks.length) return null;
  const y = view.getBoundingClientRect().top + notesReadingLineOffset(view.clientHeight);
  let low = 0;
  let high = blocks.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom < y) {
      low = mid + 1;
    } else {
      found = blocks[mid];
      high = mid - 1;
    }
  }
  // Scrolled past the last block (the scroll-past-end padding) — that block is
  // still where the reader is.
  return found || blocks[blocks.length - 1];
}

// Nudge an approximate offset onto the start of a line, so the caret lands at a
// line boundary rather than mid-word. Forward, because an offset derived from a
// block's own position is a lower bound on where its text begins.
export function snapOffsetToLineStart(source, offset) {
  if (!Number.isFinite(offset)) return null;
  const at = Math.max(0, Math.min(Math.round(offset), source.length));
  const next = source.indexOf("\n", at);
  return next === -1 ? at : next + 1;
}

// A representative raw-markdown offset for what the reader is currently looking
// at, resolved in four layers of decreasing precision. The layering is the fix
// for "switching to raw mode takes me to the very beginning": every one of these
// steps used to be a single all-or-nothing attempt whose failure returned null,
// and enterNotesEditing(null) means offset 0 — the top of the note. A miss now
// costs precision, never the reader's place.
export function rawOffsetForCurrentNotesScroll() {
  const view = el.notesView;
  if (!view || view.hidden) return null;
  const notes = state.notes || "";
  if (!notes) return null;
  const rect = view.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + notesReadingLineOffset(rect.height);

  // 1. Exact: the caret under the reading line, matched by the text either side.
  const precise = findRawOffsetForRenderedPoint(view, notes, x, y);
  if (precise != null) return precise;

  const block = notesBlockAtReadingLineGeometric();
  if (block) {
    const hint = approximateRawOffsetForBlock(view, notes, block);
    // 2. Block-level: no usable caret, but we know which block it is.
    const atBlock = rawOffsetForRenderedBlock(view, notes, block, { hint });
    if (atBlock != null) return atBlock;
    // 3. The hint itself. Coarse — it's a proportion of the block cache's key
    // lengths — but it puts the reader in the right region of the note, which is
    // the whole point.
    const snapped = snapOffsetToLineStart(notes, hint);
    if (snapped != null) return snapped;
  }

  // 4. Nothing measurable at all (no block cache yet): the scroll fraction.
  const range = view.scrollHeight - view.clientHeight;
  if (range <= 0) return 0;
  return snapOffsetToLineStart(notes, (view.scrollTop / range) * notes.length);
}

// ── Cross-device reading-position resume ────────────────────────────────
// currentReadingAnchor is tracked in memory ONLY — no IndexedDB/localStorage
// write here, no debounce/timer. It's folded into deckSnapshot()'s meta bag
// (see the `readingPosition` line there) purely as a piggyback on whatever
// save is already about to happen for some other reason (a notes edit, a
// card change, the pagehide flush) — the user's explicit "no advanced/costly
// logic, just sync the current location whenever the sync happens" call.
export let currentReadingAnchor = null;

// Setter: an imported binding is read-only, and cards/study.js clears this when
// the study deck resets.
export function setCurrentReadingAnchor(value) {
  currentReadingAnchor = value;
}

// Which deck the anchor above was captured for — a scroll captured in deck A
// must never ride into deck B's meta after switching decks without any
// intervening scroll in B. Compared against currentDeckKey() in deckSnapshot.
export let currentReadingAnchorDeckKey = null;

// Setter: an imported binding is read-only, and cards/study.js clears this when
// the study deck resets.
export function setCurrentReadingAnchorDeckKey(value) {
  currentReadingAnchorDeckKey = value;
}

export function currentDeckKey() {
  // The folder path is part of the identity, because a folder open as one
  // document has NEITHER id — both are null by construction, which is exactly
  // the key an unattached working deck also has. Without the path, reading a
  // folder and then starting a new deck would look like the same place, and the
  // anchor captured in one would be attached to the other.
  return JSON.stringify([state.deckId || null, state.localDeckId || null, state.folderDeck?.path || null]);
}

export function captureCurrentReadingAnchor() {
  if (!el.notesView || el.notesView.hidden || state.viewMode !== "notes") return;
  const offset = rawOffsetForCurrentNotesScroll();
  if (offset == null) return;
  const notes = state.notes || "";
  const text = notes.slice(offset, offset + 80).trim() || notes.slice(Math.max(0, offset - 80), offset).trim();
  if (!text) return;
  setCurrentReadingAnchor(trimNoteAnchor({ offset, source: notes.slice(offset, offset + 80), text }));
  setCurrentReadingAnchorDeckKey(currentDeckKey());
}

// Deliberately a TRAILING debounce rather than the rAF coalescing this used to
// use. rAF coalescing still means "once per frame", i.e. ~60 hit-tests per
// second for as long as a fling lasts — and each one is a
// caretPositionFromPoint, a Range.toString() over the block, a walk of the
// block cache and up to two snippet searches. That was the single most
// expensive thing happening while reading.
//
// Nothing needs this mid-scroll. The anchor is memory-only (see above) and is
// read when some *other* save happens, so the only moment it has to be right is
// after you stop moving. requestIdleCallback keeps it off the critical path
// even then.
export const READING_ANCHOR_IDLE_MS = 150;

export let readingAnchorCaptureTimer = 0;

export let readingAnchorIdleHandle = 0;

export function scheduleReadingAnchorCapture() {
  if (readingAnchorCaptureTimer) clearTimeout(readingAnchorCaptureTimer);
  readingAnchorCaptureTimer = setTimeout(() => {
    readingAnchorCaptureTimer = 0;
    if (typeof requestIdleCallback !== "function") {
      captureCurrentReadingAnchor();
      return;
    }
    if (readingAnchorIdleHandle) cancelIdleCallback(readingAnchorIdleHandle);
    readingAnchorIdleHandle = requestIdleCallback(() => {
      readingAnchorIdleHandle = 0;
      captureCurrentReadingAnchor();
    }, { timeout: 1000 });
  }, READING_ANCHOR_IDLE_MS);
}
