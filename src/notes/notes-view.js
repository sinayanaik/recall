// The notes view, and moving between reading it and editing it.
//
// Every repaint goes through renderNotesView() because #notesView is a REUSED
// scroll port: painting into it directly leaves the previous note's scroll
// position, so a note opens halfway down itself.

import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { resetClozeButton } from "../editor/toolbars.js?v=__BUILD__";
import { scrollRenderedNotesToRawOffset } from "./anchors.js?v=__BUILD__";
import { hideNotesCaretLine, revealNotesCaretAt } from "./caret-line.js?v=__BUILD__";
import { textareaOffsetFromScroll } from "./caret.js?v=__BUILD__";
import { applyNotesPagedLayout, isNotesPaged, revealInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { notesBlockAtReadingLineGeometric } from "./scroll-anchor.js?v=__BUILD__";
import { hideNotesSelectionButton } from "./selection.js?v=__BUILD__";
import { blockAtNotesReadingLine, closeNotesToc } from "./toc.js?v=__BUILD__";
import { renderMarkdown, setNotesBlockEstimateSource, syncNotesBlockEstimateSource, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
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
export function renderNotesView({ sameNote = false } = {}) {
  if (!el.notesView) return Promise.resolve();
  if (sameNote) {
    // Same document, so the existing estimate still describes it and the queued
    // work still points at live nodes. Both trackers are moved onto the new text
    // so the next ordinary render doesn't mistake this edit for a swap. Nodes
    // that DID get replaced are unobserved by releaseDetachedDeferredWork() on
    // the next deferral pass, so skipping the wholesale release leaks nothing.
    setNotesScrolledSource(state.notes);
    setNotesBlockEstimateSource(state.notes);
  } else {
    // A different note replaces every block, so everything queued against the old
    // one describes nodes that are about to be detached. Released here, while we
    // can still name the root, rather than left for the next render to notice.
    if (notesScrolledSource !== state.notes) releaseDeferredWork(el.notesView);
    setNotesScrolledSource(state.notes);
    syncNotesBlockEstimateSource();
  }
  return renderMarkdown(el.notesView, state.notes, true)
    .then(() => resetClozeButton(el.clozeToggleNotesBtn))
    // Every repaint of the rendered notes comes through here, so this is the
    // one place paged mode has to re-count its pages — the note may have grown
    // a paragraph, lost a block, or be a different note entirely. No-op when
    // the reader is on continuous mode.
    .then(() => applyNotesPagedLayout());
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
export const NOTES_PIN_SETTLE_PX = 2;

export const NOTES_PIN_SETTLE_MS = 110;

export const NOTES_PIN_BUDGET_MS = 400;

// A block's top edge, measured with its CHUNK forced to lay out. On a chunked
// note the containment sits on the wrapper, so a block inside a skipped chunk
// answers with its chunk's box — the same answer all 40 of its neighbours give.
// Comparing that against a real measurement taken after the render (when the
// chunk may well have realised) is comparing two different things, and the
// difference reads as drift that was never there.
export function notesAnchorTop(node, view) {
  return withChunkRendered(node, view, () => node.getBoundingClientRect().top);
}

export function renderNotesViewPinned() {
  const view = el.notesView;
  if (!view || view.hidden) return renderNotesView({ sameNote: true });

  // blockAtNotesReadingLine() asks elementFromPoint, which answers nothing
  // usable in two entirely ordinary situations: the reading line resting in the
  // margin gap between two blocks (it returns #notesView itself, whose
  // closest(NOTES_TOP_LEVEL_SELECTOR) is null) and the line sitting under a
  // floating overlay. Both left `anchors` empty — and an empty `anchors` means
  // NO drift correction at all, so the repaint moved the reader by however much
  // the edit changed the layout. That is the "highlighting jumps the note"
  // report. The geometric search cannot answer null while the note has blocks;
  // see its own comment in scroll-anchor.js for why it was written.
  const at = blockAtNotesReadingLine() || notesBlockAtReadingLineGeometric();
  const anchors = [];
  [at, at?.previousElementSibling].forEach((node) => {
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
  const until = performance.now() + NOTES_PIN_BUDGET_MS;
  let settleMs = 0;
  let best = Infinity;
  let stalled = 0;
  for (;;) {
    // The first pass is a bare frame — exactly what this did before — so the
    // common case (nothing below the fold to settle) still corrects immediately
    // and returns. Later passes wait for lazily-arriving content.
    await new Promise((resolve) =>
      requestAnimationFrame(() => (settleMs ? setTimeout(resolve, settleMs) : resolve())));
    settleMs = NOTES_PIN_SETTLE_MS;
    const anchor = anchors.find((entry) => entry.node.isConnected && view.contains(entry.node));
    if (!anchor) return;
    // Paged mode pins by PAGE. Correcting `scrollTop` there is meaningless —
    // the note runs sideways and scrollTop is pinned at 0 — and this path is
    // reached by making a highlight or a cloze, so getting it wrong moves the
    // reader every time they mark something up.
    if (isNotesPaged()) {
      revealInPagedNotes(anchor.node);
      return;
    }
    const drift = notesAnchorTop(anchor.node, view) - anchor.top;
    const residual = Math.abs(drift);
    if (residual <= NOTES_PIN_SETTLE_PX) return;
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
  state.notes = el.notesEdit.value;
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
  el.notesEdit.value = state.notes;
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
