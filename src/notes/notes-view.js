// The notes view, and moving between reading it and editing it.
//
// Every repaint goes through renderNotesView() because #notesView is a REUSED
// scroll port: painting into it directly leaves the previous note's scroll
// position, so a note opens halfway down itself.

import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { touchGestureHoldsSurface } from "../core/gesture.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { migrateLegacyHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { rawEditorValueFor, sourceFromRawEditor } from "./notes-edit-split.js?v=__BUILD__";
import { resetClozeButton } from "../editor/toolbars.js?v=__BUILD__";
import { scrollRenderedNotesToRawOffset } from "./anchors.js?v=__BUILD__";
import { refreshBookmarkButtonUI } from "./bookmark.js?v=__BUILD__";
import { hideNotesCaretLine, revealNotesCaretAt } from "./caret-line.js?v=__BUILD__";
import { refreshHighlightBadges } from "./highlight-badges.js?v=__BUILD__";
// notes-history.js imports renderNotesViewPinned from here — a cycle whose only
// crossing bindings are hoisted function declarations. See the note there.
import { clearNotesHistory, syncNotesHistoryBaseline } from "./notes-history.js?v=__BUILD__";
import { textareaOffsetFromScroll } from "./caret.js?v=__BUILD__";
import { applyNotesPagedLayout, firstVisibleNotesBlock, isNotesPaged, notesPageCount, revealInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { notesBlockForRawOffset } from "./raw-offset.js?v=__BUILD__";
import { notesBlockAtReadingLineGeometric } from "./scroll-anchor.js?v=__BUILD__";
import { hideNotesSelectionButton, touchSelectionDragActive } from "./selection.js?v=__BUILD__";
import { blockAtNotesReadingLine, closeNotesToc } from "./toc.js?v=__BUILD__";
import { releaseNotesChunkEstimateObserver, releaseNotesLazyBuildObserver, renderMarkdown, setNotesBlockEstimateSource, syncNotesBlockEstimateSource, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
import { releaseDeferredWork } from "../render/deferred-work.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";

// ── Deck study notes view ──────────────────────────────────────────
// Notes and Cards are two complementary views of the same deck: study/write
// notes first, then distill them into flashcards (or skip notes entirely).
export const quizPanel = document.querySelector(".quiz-panel");

export function isNotesEditing() {
  return Boolean(el.notesEdit && !el.notesEdit.hidden);
}

// The notes markdown the rendered view is currently laid out for. #notesView is
// its own scroll port and is never re-created — it's reused for every deck — so
// its scrollTop survives a content swap. Opening a DIFFERENT note therefore
// used to land wherever you happened to be reading in the previous one, tens of
// screens down a document you've never seen. Comparing the source (rather than
// a deck id) means every route in — web deck, saved deck, import, restore —
// gets the same answer without each having to remember to ask.
export let notesScrolledSource = null;

// Setter: an imported binding is read-only, and main.js clears it when the open note changes.
export function setNotesScrolledSource(value) {
  notesScrolledSource = value;
}

// ── Telling our own scrolling apart from the reader's ──────────────────────
// #notesView carries several scroll listeners that derive "where is the reader"
// from the scroll position. When the APP scrolls — restoring a position across
// the raw<->rendered toggle, jumping to a heading or a highlight — those
// listeners would fire and re-derive a position we were in the middle of
// setting, which is both wasteful and a source of drift. Same shape as the
// chromeSettleUntil guard further down: a short window, checked rather than
// unwound, so no code path can leave the flag stuck on.
export const NOTES_PROGRAMMATIC_SCROLL_MS = 250;

export let notesProgrammaticScrollUntil = 0;

export function markProgrammaticNotesScroll(ms = NOTES_PROGRAMMATIC_SCROLL_MS) {
  notesProgrammaticScrollUntil = Math.max(notesProgrammaticScrollUntil, performance.now() + ms);
}

export function isProgrammaticNotesScroll() {
  return performance.now() < notesProgrammaticScrollUntil;
}

// ── Telling our own SELECTION apart from the reader's ──────────────────────
// Same shape, same reasoning, for the other thing the app does on the reader's
// behalf: every jump that lands on a known span selects it, so the browser's
// own highlight shows exactly where you were sent (see revealRenderedNoteRange).
// That is a real Selection, so it fires `selectionchange`, and the floating
// formatting pill dutifully appeared over a selection nobody made — reported as
// "when I press go to in highlights the text formatting options come up
// unnecessarily". Long enough to outlast the jump's own retry loop, which can
// re-aim for over a second on a paged note.
export const NOTES_PROGRAMMATIC_SELECTION_MS = 1500;

export let notesProgrammaticSelectionUntil = 0;

export function markProgrammaticNotesSelection(ms = NOTES_PROGRAMMATIC_SELECTION_MS) {
  notesProgrammaticSelectionUntil = Math.max(notesProgrammaticSelectionUntil, performance.now() + ms);
}

export function isProgrammaticNotesSelection() {
  return performance.now() < notesProgrammaticSelectionUntil;
}

// The reader touching anything ends it early: a jump's selection is theirs to
// act on the moment they reach for it, and waiting out the rest of the window
// would make the pill feel broken instead of merely quiet.
export function clearProgrammaticNotesSelection() {
  notesProgrammaticSelectionUntil = 0;
}

// Every path that repaints the rendered notes goes through here, so the "is
// this a different note?" bookkeeping can't drift out of step with what's on
// screen. Re-rendering the SAME note (an edit commit, a cloze toggle, an image
// finishing its upload) deliberately leaves the scroll alone — you get put back
// where you were reading.
//
// `sameNote` says so explicitly, and it matters. The bookkeeping below used the
// SOURCE STRING as a stand-in for note identity, which cannot tell "a different
// note opened" from "this note was just edited in place" — every edit read as a
// swap. That is what made highlighting jump: the measured block estimate was
// thrown away and re-derived, which re-sized every off-screen block, including
// the ones ABOVE the viewport, and the content the reader was looking at slid
// out from under them (see the note on measureNotesBlockEstimate). Callers that
// mutate the open note pass sameNote so the estimate and the deferred-work queue
// survive an edit that changed one block out of hundreds.
// What actually gets rendered: the note WITHOUT its highlight-notes block.
//
// That block used to be real markdown — a "## Highlight Notes" heading and a
// "### [id]" per note — so the rendered view printed the reader's own notes
// twice, once where they belong and once in a heap at the foot of the document,
// and the note-badge pass had to walk the rendered blocks BACKWARDS to
// find that heading and hide it again. It is a fenced block of HTML comments
// now (src/format/notes-fence.js) and it simply is not rendered.
//
// The SAME string has to reach renderMarkdown and both source trackers, or the
// block cache's estimate misses on every pass and re-measures a book-sized note
// for nothing.
export function renderNotesView({ sameNote = false } = {}) {
  if (!el.notesView) return Promise.resolve();
  const source = readerNotesBody(state.notes);
  if (sameNote) {
    // Same document, so the existing estimate still describes it and the queued
    // work still points at live nodes. Both trackers are moved onto the new text
    // so the next ordinary render doesn't mistake this edit for a swap. Nodes
    // that DID get replaced are unobserved by releaseDetachedDeferredWork() on
    // the next deferral pass, so skipping the wholesale release leaks nothing.
    setNotesScrolledSource(source);
    setNotesBlockEstimateSource(source);
  } else {
    // A different note replaces every block, so everything queued against the old
    // one describes nodes that are about to be detached. Released here, while we
    // can still name the root, rather than left for the next render to notice.
    if (notesScrolledSource !== source) {
      releaseDeferredWork(el.notesView);
      releaseNotesChunkEstimateObserver(el.notesView);
      // Same reasoning, one stage earlier: the span observer holds every chunk
      // of the previous note as a target, and an IntersectionObserver's hold on
      // its targets is strong. The plan itself is keyed on the container in a
      // WeakMap and is replaced by the next render, so only the observer needs
      // saying out loud.
      releaseNotesLazyBuildObserver(el.notesView);
    }
    setNotesScrolledSource(source);
    syncNotesBlockEstimateSource();
  }
  // Every deck, including a PDF one. That surface used to be handed over to
  // src/documents/pdf-notes-view.js, which rendered the paper's highlights and
  // their notes here — so the Notes tab held the reader's annotations instead of
  // the reader's own writing. Those live in the Highlights tab now, which is a
  // continuous editor of them, and this tab is a note like any other note.
  return renderMarkdown(el.notesView, source, true)
    .then(() => resetClozeButton(el.clozeToggleNotesBtn))
    // Every repaint of the rendered notes comes through here, so this is the
    // one place paged mode has to re-count its pages — the note may have grown
    // a paragraph, lost a block, or be a different note entirely. No-op when
    // the reader is on continuous mode.
    .then(() => applyNotesPagedLayout())
    // Highlight badges: the "this highlight is annotated" underline and the
    // number that opens its note.
    // Here rather than at each of the half-dozen callers that can change one
    // (the mark menu, the note popup, an undo, a raw edit, a sync pull) because
    // every one of them repaints through this function. It costs a pointer
    // compare and a string compare when nothing about the notes changed, which
    // is every repaint but the ones that did — see refreshHighlightBadges.
    .then(() => refreshHighlightBadges())
    // Also the one reliable place to keep the bookmark button in step with
    // state.meta?.bookmark: renderMarkdown's own cache-hit fast path (same
    // source, nothing to redo) returns before finalizeRenderedSurface ever
    // runs, but every entry into notes view — cache hit or not — comes
    // through here.
    .then(() => refreshBookmarkButtonUI());
}

// Repaint the open note without the reader appearing to move at all.
//
// Distinct from preserveNotesReadingPosition, which pulls its anchor TO the
// reading line — right for a width change, wrong here: highlighting a sentence
// must not also scroll the sentence to a different part of the screen. So this
// measures where an anchor block sits, lets the render happen, and corrects
// scrollTop by however far that same block moved. If nothing moved, nothing is
// written.
//
// Two anchors are captured because the block under the reading line may be the
// very one being edited, and an edited block is rebuilt rather than reused (see
// patchRenderedBlocks) — its node is detached and its position unmeasurable
// afterwards. The preceding sibling is unchanged by definition and stands in.
// How close the anchor has to land before the settle loop is satisfied, the
// pause between re-measurements, and how long it is willing to keep correcting.
// The cadence matches scrollNotesHeadingIntoView, for the same reason: one frame
// is enough for the patched blocks, and nothing else.
// 6px, not the 2px this started at. Every correction below is a WRITE to
// scrollTop that the reader can see, and at 2px the loop kept firing on
// sub-pixel churn that nobody could have noticed if it had been left alone —
// so the cure was more visible than the disease. Six is under half a line of
// body text: a drift small enough to leave is a drift small enough not to
// correct. See also the mark-padding rule in styles/23-highlight-marks.css,
// which removed the thing that was generating most of the churn.
export const NOTES_PIN_SETTLE_PX = 6;

export const NOTES_PIN_SETTLE_MS = 110;

export const NOTES_PIN_BUDGET_MS = 400;

// A very long note has more content-visibility chunks settling late (images,
// diagrams, table refits below the fold) than the base budget assumes, so the
// settle loop can still time out with a residual left uncorrected. Only
// scaled up past a real book-sized note — the base budget already covers
// everything shorter, and a longer window costs nothing when nothing is left
// to correct (the loop still exits the moment two passes agree).
export const NOTES_PIN_LARGE_NOTE_CHARS = 500000;

export const NOTES_PIN_LARGE_NOTE_BUDGET_MS = 1200;

// A drift has to be there twice running before it is corrected. Content
// arriving above the reader (a diagram drawing, a table refitting, a chunk
// swapping its estimate for a real height) moves the note and then moves it
// back as the next thing lands; correcting each intermediate state wrote
// scrollTop three or four times for a net displacement of nothing, which is
// what "severe shivering" describes. Waiting one cadence costs 110ms and skips
// every transient.
export const NOTES_PIN_CONFIRM_PASSES = 2;

// How many times the loop may actually MOVE the reader before it gives up.
//
// Every correction is a visible jump, so a loop that keeps finding drift is a
// loop the reader experiences as the page shaking — which is the report this
// whole file's settle machinery keeps orbiting. The stalemate test below ends a
// loop that has stopped improving; this ends one that improves a little every
// time and never arrives, which on a note with a lot of late-settling content
// below the fold is the shape that actually occurred. Three corrections is more
// than any real repaint needs now that the note is patched rather than rebuilt;
// past that, being 20px out is better than being moved for the fourth time.
export const NOTES_PIN_MAX_CORRECTIONS = 3;

// A block's top edge, measured with its CHUNK forced to lay out. On a chunked
// note the containment sits on the wrapper, so a block inside a skipped chunk
// answers with its chunk's box — the same answer all 40 of its neighbours give.
// Comparing that against a real measurement taken after the render (when the
// chunk may well have realised) is comparing two different things, and the
// difference reads as drift that was never there.
export function notesAnchorTop(node, view) {
  return withChunkRendered(node, view, () => node.getBoundingClientRect().top);
}

// `offsetHint`: the raw markdown offset of the edit that's about to be
// repainted, when the caller already knows it (makeHighlightFromSelection
// does — see format/highlight.js). Resolving the anchor from THAT is more
// reliable than the reading-line hit-test below ever can be: elementFromPoint
// answers nothing when the reading line rests in the margin gap between two
// blocks or under a floating overlay, which left `anchors` empty and meant NO
// drift correction ran at all (the "highlighting jumps the note" report).
// Knowing exactly where the edit happened removes the guess entirely for the
// case that matters most here.
export function renderNotesViewPinned(offsetHint) {
  const view = el.notesView;
  if (!view || view.hidden) return renderNotesView({ sameNote: true });

  // ── Paged mode pins by SCROLL POSITION, not by anchor block ──────────────
  //
  // The anchor approach is actively wrong here, and it is the bug behind "when
  // I highlight in the first column the page jumps, but in the second column it
  // doesn't". In paged mode both anchor resolvers answer
  // firstVisibleNotesBlock() — the block at the top of column ONE. Highlighting
  // that block rebuilds it (patchRenderedBlocks replaces an edited block), so
  // it is detached by the time the pin looks for it and the fallback is its
  // previous sibling: the last block of the PREVIOUS page. Paging to that is a
  // page backwards. Highlight in column two and the column-one anchor survives,
  // so nothing moves — which is exactly the asymmetry that was reported, right
  // down to being intermittent, because whether the sibling is on the previous
  // page depends on where the column break happened to fall.
  //
  // An edit in place cannot change which page the reader is on. So remember
  // where they were and put them back, and only fall back to re-deriving a page
  // if the note's LENGTH changed under them.
  if (isNotesPaged()) {
    const scrollLeft = view.scrollLeft;
    const pages = notesPageCount();
    return renderNotesView({ sameNote: true }).then(() => {
      if (!isNotesPaged()) return;
      if (notesPageCount() === pages) {
        if (Math.abs(view.scrollLeft - scrollLeft) > 1) {
          markProgrammaticNotesScroll();
          view.scrollLeft = scrollLeft;
        }
        return;
      }
      // The note grew or shrank by a page. The reader's position is no longer
      // the same number of pixels in, so aim at the block they were reading.
      const block = firstVisibleNotesBlock();
      if (block) revealInPagedNotes(block);
    });
  }

  // Prefer the block the edit is actually IN (see the function comment)
  // before falling back to the reading-line hit-test. blockAtNotesReadingLine()
  // asks elementFromPoint, which answers nothing usable in two entirely
  // ordinary situations: the reading line resting in the margin gap between
  // two blocks (it returns #notesView itself, whose
  // closest(NOTES_TOP_LEVEL_SELECTOR) is null) and the line sitting under a
  // floating overlay. Both left `anchors` empty — and an empty `anchors` means
  // NO drift correction at all, so the repaint moved the reader by however much
  // the edit changed the layout. The geometric search cannot answer null while
  // the note has blocks; see its own comment in scroll-anchor.js for why it
  // was written.
  const at = (offsetHint != null && notesBlockForRawOffset(view, state.notes || "", offsetHint))
    || blockAtNotesReadingLine()
    || notesBlockAtReadingLineGeometric();
  const anchors = [];
  // Both siblings, not just the previous one. The block under the reading line
  // is very often the one being edited, and an edited block is rebuilt rather
  // than reused — so the pin falls through to a neighbour. One neighbour is a
  // single point of failure (it can itself have been rebuilt, or be the last
  // block of a previous page); taking the block on either side means the
  // correction still has something real to measure against.
  [at, at?.previousElementSibling, at?.nextElementSibling].forEach((node) => {
    if (node && view.contains(node)) anchors.push({ node, top: notesAnchorTop(node, view) });
  });

  const done = renderNotesView({ sameNote: true });
  if (!anchors.length) return done;
  return done.then(() => settleNotesPin(view, anchors));
}

// Put the anchor back where it was, then keep checking that it stayed there.
//
// One frame is not enough on a long note. The patched blocks lay out on the next
// frame, but a diagram drawing, a table refitting and a content-visibility chunk
// swapping its estimate for a real height all land later still — and each one
// that arrives above the reader moves the text again, after the single
// correction this used to make had already run. So the residual is re-measured
// on a settle cadence and re-corrected while it is still shrinking.
export async function settleNotesPin(view, anchors) {
  const budget = (state.notes || "").length > NOTES_PIN_LARGE_NOTE_CHARS
    ? NOTES_PIN_LARGE_NOTE_BUDGET_MS
    : NOTES_PIN_BUDGET_MS;
  const until = performance.now() + budget;
  let settleMs = 0;
  let best = Infinity;
  let stalled = 0;
  // How many consecutive passes have seen a drift worth correcting, and in
  // which direction. A drift that flips sign between passes is content settling,
  // not the reader being in the wrong place, and resets the count.
  let confirmed = 0;
  let confirmedSign = 0;
  let corrections = 0;
  for (;;) {
    // The first pass is a bare frame — exactly what this did before — so the
    // common case (nothing below the fold to settle) still corrects immediately
    // and returns. Later passes wait for lazily-arriving content.
    await new Promise((resolve) =>
      requestAnimationFrame(() => (settleMs ? setTimeout(resolve, settleMs) : resolve())));
    settleMs = NOTES_PIN_SETTLE_MS;
    const anchor = anchors.find((entry) => entry.node.isConnected && view.contains(entry.node));
    if (!anchor) return;
    // Never move the page out from under a finger. A touch selection is live
    // while this runs whenever the reader highlights and then reaches straight
    // back to the text, and a scrollTop write during a drag moves the words
    // under the handle they are holding — the exact thing markSelectionStableRegion
    // exists to prevent, arriving from the other direction. Their gesture is
    // worth more than six pixels of drift.
    //
    // Asked of selection.js rather than of touch-selection.js directly: it
    // already holds the flag (setTouchSelectionDragging reports into it) and
    // this module already imports from it, so there is no new module edge to
    // reason about.
    //
    // ── ...and of the PRESS as well as the drag ──────────────────────────
    //
    // A drag is not the only gesture a scrollTop write can ruin. A press is
    // cancelled outright if the content under the resting finger moves more
    // than PRESS_SCROLL_TOLERANCE_PX (src/notes/touch-selection.js), and a
    // correction landing inside those 240ms does exactly that — silently, so
    // the reader sees a long press that did nothing and presses again. That is
    // half of "I have to press again and again", and the drag flag cannot see
    // it because the drag has not started yet.
    //
    // touchGestureHoldsSurface() covers both, and lives in core/ so that
    // block-cache.js can ask the same question without closing a cycle. See
    // src/core/gesture.js.
    if (touchSelectionDragActive() || touchGestureHoldsSurface()) return;
    // Paged mode never gets here: renderNotesViewPinned handles it by restoring
    // scrollLeft directly, because re-deriving a page from a block anchor is
    // what made a highlight in the first column turn the page backwards. If the
    // mode changed mid-settle there is nothing meaningful left to correct —
    // scrollTop is pinned at 0 in a sideways note.
    if (isNotesPaged()) return;
    const drift = notesAnchorTop(anchor.node, view) - anchor.top;
    const residual = Math.abs(drift);
    if (residual <= NOTES_PIN_SETTLE_PX) return;
    // Seen once is not enough — see NOTES_PIN_CONFIRM_PASSES. A drift that has
    // reversed direction since the last pass is content settling both ways, so
    // the count starts again rather than continuing toward a correction.
    const sign = Math.sign(drift);
    confirmed = sign === confirmedSign ? confirmed + 1 : 1;
    confirmedSign = sign;
    if (confirmed < NOTES_PIN_CONFIRM_PASSES) {
      if (performance.now() >= until) return;
      continue;
    }
    // Not improving: the scroller is clamped at one end and cannot give back
    // the drift, or heights that will not settle. One more correction is worth
    // trying, two in a row is a stalemate — spinning out the whole budget just
    // burns frames on a note that has already stopped moving.
    if (residual >= best - 1) {
      stalled += 1;
      if (stalled >= 2) return;
    } else {
      stalled = 0;
    }
    best = Math.min(best, residual);
    markProgrammaticNotesScroll();
    view.scrollTop += drift;
    corrections += 1;
    if (corrections >= NOTES_PIN_MAX_CORRECTIONS) return;
    if (performance.now() >= until) return;
  }
}

// UI-only exit from notes edit mode. Deliberately does NOT copy the textarea
// into state.notes — the textarea's input listener keeps state in sync while
// typing, so by the time anything calls this the two already agree.
//
// It also does NOT clear the textarea, because commitNotesEditIfActive reads
// .value immediately before calling this. A deck swap needs the value gone as
// well and must call discardNotesEditingForDeckSwap instead.
export function resetNotesEditingUI() {
  if (!isNotesEditing()) return;
  el.notesEdit.hidden = true;
  el.notesView.hidden = false;
  el.notesEditToolbar.hidden = true;
  hideNotesCaretLine();
  el.editNotesBtn.classList.remove("is-editing");
  el.editNotesBtn.title = "Edit notes";
  hideNotesSelectionButton();
}

// Leave raw edit mode because the note underneath is being REPLACED, not
// because the user finished editing.
//
// A deck swap reassigns state.notes wholesale, but the <textarea> is not part
// of `state` and nothing else resets it: setViewMode only calls
// resetNotesEditingUI on the way to the CARDS view, and enterNotesEditing
// returns immediately when the editor is already open, so the incoming note
// never reaches the textarea. That left the editor showing the note being left
// while state.localDeckId already pointed at the new deck — and the very next
// keystroke (`state.notes = el.notesEdit.value`) copied the old note's whole
// body into the new deck, which the autosave then made permanent. Clearing
// .value is the load-bearing half: resetNotesEditingUI only hides the element.
export function discardNotesEditingForDeckSwap() {
  // Whatever is on the stack belongs to the note being left. Carrying it across
  // would make Ctrl+Z paste the previous deck's note into this one — the same
  // class of mistake the `startedIn` guard in extractSelectionToNote exists for.
  clearNotesHistory();
  if (!isNotesEditing()) return;
  el.notesEdit.value = "";
  // The mirror holds its own copy of the text (see refreshHighlightBackdrop);
  // left alone it keeps painting the old note behind the empty textarea.
  refreshHighlightBackdrop(el.notesEdit);
  resetNotesEditingUI();
}

export function commitNotesEditIfActive() {
  if (!isNotesEditing()) return;
  // Capture BEFORE overwriting state.notes / hiding the textarea — both the
  // scroll position and the value it's measured against have to be the
  // pre-commit ones. The caret (selectionStart) is the reader's position and
  // is O(1) to read — far cheaper than reconstructing an offset from the
  // scroll position, which on a huge note meant scanning the whole document.
  const resumeOffset = el.notesEdit.selectionStart ?? textareaOffsetFromScroll(el.notesEdit);
  // The editor holds the BODY; sourceFromRawEditor puts the highlight-notes
  // block back on the end. The resume offset above needs no adjusting for that:
  // the block is a tail, so an offset into the body means the same thing in
  // both strings.
  state.notes = sourceFromRawEditor(el.notesEdit.value);
  resetNotesEditingUI();
  // #notesView's own stale scrollTop (it's never destroyed, just hidden) is
  // what used to make this look like it "worked" for a same-source re-render
  // — an incidental side effect, not a real position match. Explicitly aim
  // at the offset we just left, once the re-render settles.
  // sameNote, because it IS the same note — you were editing it, not opening
  // another one. A bare renderNotesView() re-derives the measured block-height
  // estimate and releases the deferred-work queue, which re-sizes every
  // off-screen block INCLUDING the ones above the viewport, so the position
  // this line then restores is computed against a document that changes height
  // underneath it. Measured on a 390px phone before this: coming back from raw
  // mode landed 32 paragraphs early, every time, at every scroll position.
  renderNotesView({ sameNote: true }).then(() => scrollRenderedNotesToRawOffset(resumeOffset, { smooth: false }));
  scheduleDeckAutosave();
  updateMeta();
}

// `cursorOffset` (raw-markdown character index), when given, places the caret
// there instead of the textarea's default start-of-text position — used by the
// triple-click-to-edit handler below so switching to raw mode doesn't lose your
// place.
export function enterNotesEditing(cursorOffset = null) {
  if (!el.notesEdit || isNotesEditing()) return;
  // Normalised BEFORE the textarea sees it, because a <textarea> silently
  // rewrites \r\n to \n in its own .value. Without this, the first raw toggle
  // of any CRLF-containing import (a Windows-authored .md, most EPUB
  // conversions) made commitNotesEditIfActive write back a value that differs
  // from state.notes — which misses the render cache, rebuilds every block, and
  // marks the deck dirty for an "edit" the reader never made.
  if (state.notes && state.notes.includes("\r")) state.notes = state.notes.replace(/\r\n?/g, "\n");
  // Notes attached to highlights used to live inside the <mark> tag as base64,
  // which is exactly the unreadable thing the raw editor is about to show. They
  // now live as plain markdown in a "Highlight Notes" section at the end of the
  // note (src/format/highlight-notes.js); an old note is converted here, at the
  // one moment the difference is visible, rather than on load — this returns
  // the same string untouched when there is nothing legacy to convert, which is
  // every note written since.
  const migrated = migrateLegacyHighlightNotes(state.notes);
  if (migrated !== state.notes) {
    state.notes = migrated;
    scheduleDeckAutosave();
  }
  // The body only. This is the other half of the report the fence came from:
  // on a PDF deck the body is empty — the PDF is the document — so pressing ✎
  // used to open an editor containing nothing but the reader's own highlight
  // notes, with no separation from the writing they came to do because there
  // was none to have. Now the editor is the note, and a note attached to a
  // highlight is edited from that highlight.
  el.notesEdit.value = rawEditorValueFor(state.notes);
  // Adopted, not recorded: opening the editor is not an edit, but the history
  // needs to know what the text is now so the first real keystroke has a
  // previous value to push. The WHOLE source, since that is what a snapshot
  // restores.
  syncNotesHistoryBaseline(state.notes);
  el.notesView.hidden = true;
  el.notesEdit.hidden = false;
  el.notesEditToolbar.hidden = false;
  el.editNotesBtn.classList.add("is-editing");
  el.editNotesBtn.title = "Back to preview";
  if (el.notesTocDrawer?.classList.contains("is-open")) closeNotesToc();
  hideNotesSelectionButton();
  // Paint the highlight mirror directly rather than faking an "input": the text
  // hasn't changed, and the input listener would mark the deck dirty and queue a
  // full autosave just for opening the editor.
  refreshHighlightBackdrop(el.notesEdit);
  // Assigning .value leaves the caret at the very end in most browsers, so
  // always place it explicitly — a matched offset when we have one, otherwise
  // the top of the notes. Never let a failed match silently dump you at the end.
  const pos = cursorOffset != null
    ? Math.max(0, Math.min(cursorOffset, el.notesEdit.value.length))
    : 0;
  // Caret BEFORE focus. Focusing first made the browser reveal the caret at the
  // END of the note and then reveal it again on setSelectionRange — two native
  // scrolls to override instead of one, both landing after our own.
  el.notesEdit.setSelectionRange(pos, pos);
  el.notesEdit.focus();
  // Scroll to the caret and draw its line from ONE measurement, then correct
  // once after the layout settles. Arriving from the rendered view, "did the
  // jump land where I was reading?" is the first question, and a 1px blinking
  // bar in a wall of markdown is not an answer you can find quickly.
  revealNotesCaretAt(pos, { flash: true });
}
