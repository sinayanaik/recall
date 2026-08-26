// Where you were reading, so the note silently reopens there on THIS device.
// It no longer pushes itself to the cloud on its own — see src/notes/bookmark.js
// for the manual, cross-device equivalent (a deliberate bookmark, not an
// ambient scroll position).

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { firstVisibleNotesBlock, isNotesPaged, notesCurrentPage, notesPageCount, notesPagedProbeX } from "./paged-view.js?v=__BUILD__";
import { approximateRawOffsetForBlock, findRawOffsetForRenderedPoint, rawOffsetForRenderedBlock } from "./raw-offset.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { scheduleReadingPositionSave } from "./reading-position.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, notesTopLevelBlocks } from "../render/block-cache.js?v=__BUILD__";

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
  // The BLOCKS, not view.children — on a long enough note those are chunk
  // wrappers of 40, and the search would answer at 40-block granularity.
  const blocks = notesTopLevelBlocks(view);
  if (!blocks.length) return null;
  // Paged mode breaks the invariant this search rests on. Document order runs
  // along X there, so block `bottom` values are all inside one viewport height
  // and are not monotonic — the search converges on an essentially arbitrary
  // early block, in practice always something on page 0. The paged view already
  // knows how to answer "what is the reader looking at": it is the first block
  // on the current page.
  if (isNotesPaged()) return firstVisibleNotesBlock();
  const y = view.getBoundingClientRect().top + notesReadingLineOffset(view.clientHeight);
  // ── Chunked: find the CHUNK first, then the block inside it ──────────────
  //
  // The search below rests on the block rects being sorted, and on a chunked
  // note they are not. A block whose chunk's contents `content-visibility` has
  // skipped answers getBoundingClientRect() with a box belonging to the chunk
  // rather than to itself, and those boxes can be stale — so two blocks in two
  // different chunks can both claim to contain the reading line, in either
  // order, and a binary search over an unsorted sequence lands wherever it
  // happens to land. Measured on a 3.1MB book built as it is read: the block
  // named here was seven blocks away from the one the caret hit test found at
  // the same point, and since this is what the reading position falls back to,
  // that is a resume landing in the wrong part of the chapter.
  //
  // A CHUNK's own box is always real — it is in the flow whether or not its
  // contents were skipped — so the coarse search runs over the chunks, and the
  // fine one over the children of the one chunk that contains the reading line.
  // That chunk intersects the viewport by definition, so it is laid out and its
  // children answer honestly.
  const chunks = Array.from(view.querySelectorAll(`:scope > .${NOTES_CHUNK_CLASS}`));
  if (chunks.length) {
    const found = firstAtOrBelow(chunks, y) ?? chunks[chunks.length - 1];
    const inside = Array.from(found.children).filter((node) => node.nodeType === 1);
    if (inside.length) return firstAtOrBelow(inside, y) ?? inside[inside.length - 1];
    // A chunk whose span has not been built yet holds nothing to point at. The
    // nearest real block is the last one before it — the reader is between two
    // built regions, and the one they came from is the honest answer.
    const at = chunks.indexOf(found);
    for (let i = at - 1; i >= 0; i -= 1) {
      const kids = Array.from(chunks[i].children).filter((node) => node.nodeType === 1);
      if (kids.length) return kids[kids.length - 1];
    }
    for (let i = at + 1; i < chunks.length; i += 1) {
      const kids = Array.from(chunks[i].children).filter((node) => node.nodeType === 1);
      if (kids.length) return kids[0];
    }
    return null;
  }
  const found = firstAtOrBelow(blocks, y);
  // Scrolled past the last block (the scroll-past-end padding) — that block is
  // still where the reader is.
  return found || blocks[blocks.length - 1];
}

// The first element of `nodes` whose bottom has reached `y`, by binary search.
// `nodes` must be in document order and must really be sorted by their boxes —
// which is why the caller above searches chunks rather than blocks.
export function firstAtOrBelow(nodes, y) {
  let low = 0;
  let high = nodes.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom < y) {
      low = mid + 1;
    } else {
      found = nodes[mid];
      high = mid - 1;
    }
  }
  return found;
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
  const paged = isNotesPaged();
  // The horizontal middle of the view is the COLUMN GAP in two-column mode, so
  // the probe has to be moved inside a column or layer 1 can never hit text.
  const x = paged ? notesPagedProbeX(rect) : rect.left + rect.width / 2;
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
  //
  // Paged mode has no vertical scroll range — scrollHeight === clientHeight — so
  // this used to compute `range <= 0` and return a literal 0 on EVERY call. That
  // is not a harmless fallback: captureCurrentReadingAnchor stores the result as
  // the reader's position, deckSnapshot folds it into meta.readingPosition, and
  // it syncs to every device. Reading a note in paged mode saved "the top of the
  // note" and then restored the top of the note everywhere. The page number is
  // the paged equivalent of the scroll fraction.
  if (paged) {
    const pages = notesPageCount();
    if (pages <= 1) return 0;
    return snapOffsetToLineStart(notes, (notesCurrentPage() / (pages - 1)) * notes.length);
  }
  const range = view.scrollHeight - view.clientHeight;
  if (range <= 0) return 0;
  return snapOffsetToLineStart(notes, (view.scrollTop / range) * notes.length);
}

// ── Cross-device reading-position resume ────────────────────────────────
// currentReadingAnchor is the in-memory copy. It is folded into deckSnapshot()'s
// meta bag (see the `readingPosition` line there) as a piggyback on whatever
// save is already about to happen for some other reason (a notes edit, a card
// change, the pagehide flush), which is what carries it to the other devices.
//
// That piggyback used to be the ONLY way it was ever written down, and reading
// a book triggers none of those saves — so the position a reader had was lost
// on every reload. It is now also written to a small store of its own (see
// src/notes/reading-position.js), which costs nothing on the scroll path
// because it never touches the note itself.
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
  // The merged document's key is part of the identity, because several decks
  // open as one document have NEITHER id — both are null by construction, which
  // is exactly the key an unattached working deck also has. Without it, reading
  // a folder and then starting a new deck would look like the same place, and
  // the anchor captured in one would be attached to the other.
  return JSON.stringify([state.deckId || null, state.localDeckId || null, state.folderDeck?.key || null]);
}

export function captureCurrentReadingAnchor() {
  if (!el.notesView || el.notesView.hidden || state.viewMode !== "notes") return;
  const offset = rawOffsetForCurrentNotesScroll();
  if (offset == null) return;
  const notes = state.notes || "";
  const text = notes.slice(offset, offset + 80).trim() || notes.slice(Math.max(0, offset - 80), offset).trim();
  if (!text) return;
  // `at` is what lets a position from another device be compared with this
  // one's on open — see betterReadingPosition. It rides into meta.readingPosition
  // with the rest of the anchor, so the comparison works in both directions.
  const anchor = trimNoteAnchor({ offset, source: notes.slice(offset, offset + 80), text, at: Date.now() });
  const key = currentDeckKey();
  setCurrentReadingAnchor(anchor);
  setCurrentReadingAnchorDeckKey(key);
  // ...and write it down. The in-memory anchor above is still what a deck save
  // folds into meta, but a reader who only reads never triggers a deck save, and
  // that is exactly the reader this feature is for.
  scheduleReadingPositionSave(key, anchor);
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
