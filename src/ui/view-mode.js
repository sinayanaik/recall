// Switching between the cards view and the notes view.

import { showCard } from "../cards/card-view.js?v=__BUILD__";
// The one definition of "is a deck open", rather than a second reading of the
// three state fields it is made of. card-status.js imports setViewMode back, so
// this is a cycle — an EXISTING one: view-mode → card-view → card-status →
// view-mode has been in the graph since the split. It is safe for the same
// reason that one is: both sides export nothing but function declarations, which
// are hoisted and initialised before any module body runs, and card-status.js
// has no top-level statements at all. Do not add one.
import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { rawEditorValueFor } from "../notes/notes-edit-split.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { deckTabKey, rememberDeckTab } from "../storage/deck-tab.js?v=__BUILD__";
import { closeHighlightsEditor } from "../panels/highlights-editor.js?v=__BUILD__";
import { currentInkSurface } from "../storage/ink-prefs.js?v=__BUILD__";
import { openDocumentView } from "../documents/pdf-view.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { enterNotesEditing, isNotesEditing, markProgrammaticNotesScroll, notesScrolledSource, quizPanel, renderNotesView, resetNotesEditingUI } from "../notes/notes-view.js?v=__BUILD__";
import { applyNotesPagedLayout } from "../notes/paged-view.js?v=__BUILD__";
import { flushReadingPositionSave } from "../notes/reading-position.js?v=__BUILD__";
// anchors.js imports this module (setViewMode), so this closes a cycle. Safe for
// the reason the others are: scheduleNoteJump is a hoisted function declaration,
// called at runtime inside setViewMode, never read while a module body runs.
import { scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { currentDeckKey, takeDeferredNotesResume } from "../notes/scroll-anchor.js?v=__BUILD__";
import { hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { measureChromeHeights } from "./chrome.js?v=__BUILD__";
import { DOC_SLOT_DOC } from "../documents/doc-slot.js?v=__BUILD__";
import { SPLIT_PART_MODES, documentPartInFocus, isDocumentPartMode, isNotesShown } from "./split-parts.js?v=__BUILD__";
import { SPLIT_STACK_QUERY, applySplitRatio, readSplitRatio, releaseSplitLayout, scheduleSplitRelayout, setSplitLayoutOwner, splitStacked } from "./split-layout.js?v=__BUILD__";

// `options.deferRender` yields one frame between flipping the toggle's own
// classes and doing the work behind them. Only the user-facing toggle passes
// it: renderNotesView() runs a full marked parse + DOMPurify sanitize of the
// whole note before its first await, so on a cold switch into a large note the
// `is-active` pill could not reach the screen until that finished — the button
// with the heaviest synchronous work in the app looked like it had missed the
// press. Every programmatic caller (deck load, import, scheduleNoteJump, …)
// keeps the original synchronous ordering, because several of them read the
// rendered DOM straight afterwards.
// ── Side by side, told where the reader went ───────────────────────────────
//
// Registered by src/main.js rather than imported. src/panels/highlight-cycle.js
// reaches scheduleNoteJump, which imports setViewMode from here — so importing
// it back would deepen the view-mode ↔ anchors cycle this file's header already
// warns about. One hook, called with the mode being switched TO, and the split
// decides for itself whether that is a surface it can be beside.
let splitViewHook = null;

export function setSplitViewHook(fn) {
  splitViewHook = fn;
}

// The time log and the reading tracker (src/stats/activity.js), told BEFORE the
// switch lands, so the seconds already spent are filed under the part they were
// spent in. A hook for the same reason as the one above.
let viewSwitchHook = null;

export function setViewSwitchHook(fn) {
  viewSwitchHook = typeof fn === "function" ? fn : null;
}

// The Write tab's own paint step. A hook rather than an import, and for the
// reason setDocumentAttachHandler is one: src/handwriting/board.js reaches
// card-status, which reaches this module, and pulling it in here would close
// that circle around the function every deck load calls.
let handwritingViewHook = null;

export function setHandwritingViewHook(fn) {
  handwritingViewHook = typeof fn === "function" ? fn : null;
}

// Anything a leaving view has open and unsaved. A block being typed into on the
// Write tab commits on the way out, exactly as the note in the highlights pane
// does two lines below — leaving a view is not a reason to lose a sentence.
let blockEditFlushHook = null;

export function setBlockEditFlushHook(fn) {
  blockEditFlushHook = typeof fn === "function" ? fn : null;
}

// ── The view before this one ───────────────────────────────────────────────
//
// What Ctrl Ctrl (src/main.js) goes back to: the reader flips Notes ↔ PDF, or
// whichever two they were last between, without reaching for the tabs.
// Recorded on every real switch, programmatic ones included — a deck opening on
// its remembered tab is still a place the reader was.
let previousViewMode = null;

function viewTabAvailable(mode) {
  const button = el.viewModeToggle?.querySelector(`[data-view-mode="${mode}"]`);
  return Boolean(button && !button.hidden);
}

export function switchToPreviousView() {
  if (!hasActiveDeck()) return false;
  // Side by side, the view before this one is the pane beside it.
  if (state.splitPart) return focusPart(state.splitPart);
  const current = state.viewMode;
  let target = previousViewMode && previousViewMode !== current && viewTabAvailable(previousViewMode)
    ? previousViewMode
    : null;
  // Nothing to go back to yet (or it is a tab this deck no longer has): the
  // pair the shortcut exists for, Notes and the paper.
  if (!target) target = current === "notes" && viewTabAvailable("document") ? "document" : "notes";
  if (target === current) return false;
  setViewMode(target, { deferRender: true });
  return true;
}

// ── Leaving the PDF tab without throwing its layout away ────────────────────
//
// A hidden stage is display:none, which discards the layout of everything in
// it — and a rendered page carries a text layer of several hundred absolutely
// positioned spans. Coming back to the tab then laid every one of them out
// again from nothing: measured on a phone-throttled CPU, most of the 0.8s a
// Notes → PDF switch took, with the page already drawn the whole time.
//
// So a stage that is hidden after having been on screen is marked `kept`, and
// styles/36-document.css keeps it laid out — in flow, at zero height, with
// `content-visibility: hidden` so none of it is painted or reachable — for as
// long as the reader stays on Notes. The document's own observers stand down
// while it is hidden (documentSurfaceHidden in src/documents/pdf-view.js), so
// being kept is never mistaken for the reader having scrolled or resized.
function keepDocumentStageLaidOut(stage) {
  if (!("kept" in stage.dataset)) stage.dataset.kept = "";
}

export function setViewMode(mode, options = {}) {
  // "highlights" is deliberately not a mode any more, and deliberately not
  // special-cased into an error either: it falls through to "cards" like any
  // other unknown string. A nav-history entry recorded while the tab existed
  // (src/ui/nav-history.js) replays into the cards view rather than into a
  // stage that is no longer in the document.
  // The Document surface is on every open deck now (refreshDocumentTab), and on
  // one with no PDF it opens to the offer of attaching one. This used to fall
  // back to "cards" unless state.meta.pdf was set, which was right while there
  // was no tab and nothing behind it — and would now bounce the reader straight
  // back out of the tab they just pressed.
  //
  // The guard that remains is the one that always mattered: no deck, no
  // surface. A stale nav-history entry replayed against a closed deck must not
  // open a document panel with no toggle to leave it by.
  // "handwriting" is the same #documentStage as "document", showing the deck's
  // other document (src/documents/doc-slot.js) — which is why it is a view mode
  // and not a panel: there is one surface, one render loop, one zoom and one
  // coordinate system, and the tab chooses which paper is in it.
  const next = mode === "notes" ? "notes"
    : mode === "document" ? (hasActiveDeck() ? "document" : "cards")
      : mode === "handwriting" ? (hasActiveDeck() ? "handwriting" : "cards")
        : "cards";
  if (!el.notesStage || !el.viewModeToggle) {
    state.viewMode = next;
    return;
  }
  // ── Side by side: is this a switch at all? ──────────────────────────────
  //
  // A press on the part that is already BESIDE the focused one moves the focus
  // there and changes nothing on screen. Every jump in the app — a card's "Go to
  // notes", a highlight's page, scheduleNoteJump — comes through here, so each
  // of them lands in the pane that is already showing its target rather than
  // closing the split to show it again.
  if (state.splitPart) {
    // A different file closes it — but not a sync rewriting THIS file in place
    // (`keepPlace`), during which loadDeckSnapshot has the local id cleared
    // for a moment and the key would read as some other file's.
    if (!hasActiveDeck() || (!options.keepPlace && partsSplitDeckKey !== currentSplitDeckKey())) {
      closeSplitPart();
    } else if (next === state.splitPart) {
      focusPart(next);
      return;
    } else if (next !== state.viewMode && !splitPairAllowed(next, state.splitPart)) {
      closeSplitPart();
    } else if (next !== state.viewMode && splitLeftPart === state.viewMode) {
      // Any other tab replaces the FOCUSED pane's part, in that pane's column.
      splitLeftPart = next;
    }
  }
  if (next === "cards" && state.splitPart !== "notes") resetNotesEditingUI();
  blockEditFlushHook?.();
  // A note being typed in the highlights pane commits on the way out, exactly
  // as the note popup flushes in closeHighlightNoteEditor: leaving a view is not
  // a reason to lose a sentence. A no-op when nothing is open.
  closeHighlightsEditor();
  const changed = state.viewMode !== next;
  // Read before it is overwritten. The deferred paint at the foot of this
  // function needs to know whether the reader is arriving at the document stage
  // or merely swapping which paper is on it — see staysOnDocument.
  const previous = state.viewMode;
  if (changed) previousViewMode = previous;
  if (changed) viewSwitchHook?.(previous, next);
  state.viewMode = next;
  // Before the stages are shown and hidden below: the split's own layout is a
  // class on the panel that decides which of them gets a column, and setting it
  // after the visibility flip would lay the panel out twice.
  splitViewHook?.(next);
  const notesActive = next === "notes";
  const handwritingActive = next === "handwriting";
  // Both tabs that put a document on the stage. Everything below that asks "is
  // the document surface up?" has to mean either of them, or the Write tab gets
  // the cards layout with a PDF viewer inside it.
  const documentActive = next === "document" || handwritingActive;
  applyPartStages();
  paintViewTabs();
  paintViewExportMenu();
  paintViewStyleButton();
  hideNotesSelectionButton();
  // Leaving the notes is the moment the reading position is final — write out
  // an armed-but-unfired save now rather than letting its timer fire against a
  // view the reader has already left. (The save carries the deck key it was
  // captured with, so this is safe even mid-deck-swap.)
  //
  // On ANY real switch, not only into Cards. Notes -> Document left an armed
  // save pending for up to two seconds, and the next capture (on the paper, or
  // on the next deck) used to overwrite it — the last place read in the note was
  // lost and the note reopened somewhere older. (A save pending for another
  // deck is also written through now rather than replaced — see
  // scheduleReadingPositionSave — but a switch is still the moment the position
  // is final.)
  if (changed) flushReadingPositionSave();
  // ...and remembered, so the deck opens here next time. Only on a real switch
  // and only with a deck open: documentTabForOpenDeck answers from the deck's
  // CONTENTS, which is right the first time and wrong every time after — a
  // reader studying the cards of a paper deck was put back on the paper on every
  // open. A keepPlace refresh passes the mode it is already on, so `changed` is
  // false and this records nothing, which is correct by construction.
  if (changed && hasActiveDeck()) rememberDeckTab(deckTabKey(state.deckId, state.localDeckId), next);
  // The appbar is a different height in each view — the card counters are
  // hidden on a phone while reading — and its own ResizeObserver cannot see it
  // GROW, because the box that observer watches is clamped to the last height
  // recorded (`.appbar { max-height: var(--appbar-h) }`). So a height measured
  // in Notes view was still in force in Cards and Highlights, where the meta row
  // then spilled out over the tabs below it. This is the one place that knows
  // the view just changed.
  if (changed) measureChromeHeights();
  if (notesActive) prepareNotesArrival(options, changed);

  const token = ++viewModePaintToken;
  const paint = () => paintPart(next, options, changed);

  // ── ...except between the two papers, where the frame is pure cost ────────
  //
  // The defer above is about renderNotesView. A switch between PDF and Write is
  // not that: both are `documentActive`, so #documentStage never hides — it is
  // already up and already laid out — and the work behind it is an appendChild
  // of a subtree that is still rasterised, out of the park in pdf-view.js.
  //
  // What the frame bought instead was a mismatch. data-doc-slot is flipped in
  // the synchronous block above, and styles/53-handwriting.css swaps whole
  // control sets on that attribute with display, no transition — so for one
  // whole frame the reader saw the INCOMING tab's chrome, at its new height,
  // over the OUTGOING tab's pages: the pen's rail sitting on the paper they
  // just left. The `is-active` pill is flipped in that same block either way,
  // so painting here rather than a frame later shows it sooner, never later.
  //
  // This closes the Write → PDF direction, which is the one the switch is
  // reported jumpy in. PDF → Write still crosses a microtask whatever happens
  // here: enterHandwritingView awaits ensureNotebookDocument() before it opens
  // the notebook (src/handwriting/board.js). Making THAT synchronous in the
  // already-made case is a different change and is deliberately not this one.
  const staysOnDocument = documentActive && (previous === "document" || previous === "handwriting");
  if (options.deferRender && !staysOnDocument) {
    requestAnimationFrame(() => {
      if (token !== viewModePaintToken) return;
      paint();
    });
  } else {
    paint();
  }
  // A part replaced inside an open split changes what the other pane is beside
  // and, for a document or paged notes, the width it has to fit.
  if (state.splitPart && changed) scheduleSplitRelayout();
}

// ── Which stages are up ─────────────────────────────────────────────────────
//
// From BOTH parts on screen — the focused one and, side by side, the one beside
// it — never from state.viewMode alone. Every stage is a sibling in
// .quiz-panel's grid and none is ever moved; showing two is a matter of which
// are not [hidden] and which column styles/99-split-parts.css gives each.
function applyPartStages() {
  const notesShown = isNotesShown();
  const documentPart = documentPartInFocus();
  const documentShown = Boolean(documentPart);
  const leavingDocument = Boolean(el.documentStage && !el.documentStage.hidden) && !documentShown;
  // The three reading surfaces share the notes-mode layout: deck and controls
  // give way to a full-height stage. Document wants it most of all — a page of a
  // paper needs every pixel of height the chrome is not using. Side by side
  // with the cards, styles/99-split-parts.css gives the cards their rows back.
  quizPanel?.classList.toggle("notes-mode", notesShown || documentShown);
  el.notesStage.hidden = !notesShown;
  if (leavingDocument) keepDocumentStageLaidOut(el.documentStage);
  if (el.documentStage) el.documentStage.hidden = !documentShown;
  // Which of the deck's two documents is on the stage, published for CSS: the
  // notebook's controls come up on one and the paper's on the other, and both
  // sets live in the same row.
  el.documentStage?.setAttribute("data-doc-slot", documentPart === "handwriting" ? "notebook" : "doc");
  applyPartsLayout();
}

// Both containers, explicitly. The reading rail carries a second set of
// [data-view-mode] buttons for focus mode (src/ui/reading-rail.js) and it must
// never be a second opinion about where the reader is — but this is emphatically
// NOT a document.querySelectorAll: an attribute selector cannot be answered
// from an index, so on a book-sized note that would be a full tree walk on
// every tab press.
function paintViewTabs() {
  [el.viewModeToggle, el.readingRailTray].forEach((container) => {
    container?.querySelectorAll("[data-view-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.viewMode === state.viewMode);
      button.classList.toggle("is-beside", button.dataset.viewMode === state.splitPart);
    });
  });
}

// Arriving at the notes: the work that has to happen BEFORE their render, for
// a tab press and for the notes opened beside another part alike.
function prepareNotesArrival(options, changed) {
  if (changed) {
    // A deck opened on Cards has its reading position held back rather than
    // dragged onto the Notes tab to land it (see deferNotesResume); the reader
    // coming here is the moment to use it. After the reset below has run, so it
    // lands on the note rather than being zeroed out from under it.
    const deferred = takeDeferredNotesResume(currentDeckKey());
    if (deferred) queueMicrotask(() => scheduleNoteJump(deferred, { flash: false, smooth: false, resume: true }));
  }
  // A note you haven't been reading opens at its first line. Done BEFORE the
  // render rather than after it: scheduleNoteJump() calls setViewMode() and
  // then scrolls to the anchor a couple of frames later, and resetting on the
  // render's promise would yank that jump back to the top.
  // scrollLeft too: in paged mode the note runs sideways, so "the first line"
  // is page 0, and leaving scrollLeft where the previous note ended would
  // open a different note somewhere in its middle.
  // Compared against the reader-facing body, not the raw source: a note with
  // an annotated highlight carries a trailing highlight-notes fenced block
  // that notesScrolledSource never holds (see readerNotesBody), so comparing
  // the raw string here made this condition true on every switch into Notes
  // for any such deck — zeroing the scroll even when it's the same note.
  //
  // NOT on a sync's in-place reload (`keepPlace`). The sync rewrote the note
  // under somebody reading it — a highlight or an edit made on another device
  // — so the body differs, and this used to throw them to the top before
  // renderNotesViewPinned (the reload's own repaint, which pins the block they
  // were reading) could measure where they were. It then pinned the top, and
  // the scroll listener wrote "the top" down as their reading position and
  // synced it to every other device. "Randomly I'm going to some place and
  // then randomly to some other place."
  //
  // Marked as the app's own scroll when it does run: the top of a note just
  // opened is not a place anyone read, and captured as one it was stamped
  // newer than the real position the resume was about to land on.
  if (el.notesView && !options.keepPlace && readerNotesBody(state.notes) !== notesScrolledSource) {
    markProgrammaticNotesScroll();
    el.notesView.scrollTop = 0;
    el.notesView.scrollLeft = 0;
  }
  // Last-resort net for the deck-swap hazard described on
  // discardNotesEditingForDeckSwap. The two deck loaders discard the editor
  // explicitly and before the swap, which is strictly better — but several
  // other paths replace state.notes wholesale too (import, "new deck",
  // combine, delete-active-deck), and every one of them lands here. If the
  // editor somehow survived holding different text, it is showing a note
  // that is no longer open: re-seed it rather than let the next keystroke
  // write it back. Normally an O(1) identity compare — the input listener
  // makes these the very same string object.
  // Compared against the EDITOR's view of the note, not the whole source:
  // the textarea never holds the highlight-notes block, so a raw compare
  // would differ on every note that has one and re-seed the editor (losing
  // the caret) on every view change.
  const editorValue = rawEditorValueFor(state.notes);
  if (isNotesEditing() && el.notesEdit.value !== editorValue) {
    el.notesEdit.value = editorValue;
    refreshHighlightBackdrop(el.notesEdit);
    el.notesEdit.setSelectionRange(0, 0);
  }
}

// The paint behind a part arriving on screen — pressed as a tab, or opened
// beside another. Only the ARRIVING part: a pane that stays where it was beside
// it is not repainted, so a split costs what a tab press costs.
function paintPart(mode, options = {}, changed = true) {
  if (mode === "notes") {
    // A sync's in-place reload repaints the note itself, pinned to the block
    // the reader is on (deckReloadedInPlace -> renderNotesViewPinned). A
    // plain render here as well would be a second, unpinned repaint racing it.
    if (options.keepPlace) {
      if (!rawEditorValueFor(state.notes).trim()) enterNotesEditing();
      return;
    }
    renderNotesView();
    // After the render, so the columns are laid out against the note that is
    // actually on screen — and so the page indicator can count its pages.
    applyNotesPagedLayout();
    // rawEditorValueFor, not state.notes: on a PDF deck the note is the
    // highlight-notes block and nothing else, so the raw string is not empty
    // while the surface the reader is looking at is. Testing the wrong one
    // leaves that deck with a blank Notes tab that will not open its editor —
    // a panel you cannot write in and cannot see why.
    if (!rawEditorValueFor(state.notes).trim()) enterNotesEditing();
  } else if (mode === "document" || mode === "handwriting") {
    // Idempotent for the document already on screen — this runs on every
    // switch into the tab, and re-parsing a 40MB paper because someone glanced
    // at their cards is not a thing to do. The slot is part of what "already
    // on screen" means, so switching between Document and Write is a real
    // reopen and switching back into the one you were on is free. Unawaited:
    // the stage is already visible and shows its own "Opening…" line.
    //
    // ...except on a sync's in-place reload (`keepDocument`), where the
    // document is the one thing this must not touch — see loadDeckSnapshot.
    if (options.keepDocument) return;
    if (mode === "handwriting") handwritingViewHook?.();
    else openDocumentView({ slot: DOC_SLOT_DOC });
  } else if (changed) {
    showCard();
  }
}

// The document part on screen, painted as its tab would paint it — what a sync
// that lands with no paper on the stage asks for, whether the document is the
// focused part or the one beside it.
export function repaintDocumentPart() {
  const mode = documentPartInFocus();
  if (mode) paintPart(mode, {}, false);
}

// ── Side by side parts ──────────────────────────────────────────────────────
//
// Two parts of the open file at once: the focused one (state.viewMode) and one
// beside it (state.splitPart). See src/ui/split-parts.js for the model and
// styles/99-split-parts.css for the layout. The divider, the ratio and the
// re-fit after a drag are src/ui/split-layout.js's, shared with the Highlights
// pane — which uses the same column, so opening one closes the other.

// Which of the two parts is in the left column. The focused part does not move
// when the other is opened; it stays where the reader was looking.
let splitLeftPart = null;

// The file the split was opened on. A different file closes it: it is a pair of
// parts of THIS file.
let partsSplitDeckKey = "";

// Whether the deck's two documents can be side by side — the PDFs beside the
// Canvas. They share one document surface unless src/documents/pdf-view.js says
// it can show two (registered from src/main.js, for the reason the hooks at the
// top of this file are).
let dualDocumentSplitHook = () => false;

export function setDualDocumentSplitHook(fn) {
  dualDocumentSplitHook = typeof fn === "function" ? fn : () => false;
}

// Told when the focus moves from one document part to the other, so the shared
// document tools can follow it (src/documents/pdf-view.js).
let documentFocusHook = null;

export function setDocumentFocusHook(fn) {
  documentFocusHook = typeof fn === "function" ? fn : null;
}

function currentSplitDeckKey() {
  return hasActiveDeck() ? deckTabKey(state.deckId, state.localDeckId) : "";
}

function splitPairAllowed(a, b) {
  if (a === b) return false;
  if (isDocumentPartMode(a) && isDocumentPartMode(b)) return Boolean(dualDocumentSplitHook());
  return true;
}

// For tools/split-parts-check.mjs, which asks whether the PDFs and the Canvas
// can be side by side before it tries the pair.
export function splitPairAllowedForCheck(a, b) {
  return splitPairAllowed(a, b);
}

// The parts this file can put beside the focused one, in tab order.
export function splitPartChoices() {
  if (!hasActiveDeck()) return [];
  return SPLIT_PART_MODES.filter((mode) => mode !== state.viewMode
    && viewTabAvailable(mode)
    && splitPairAllowed(state.viewMode, mode));
}

// The box a part occupies in the grid. The cards are several rows of one
// column; the deck is the tallest of them and as wide as the column.
function splitPaneElement(mode) {
  if (mode === "notes") return el.notesStage;
  if (mode === "cards") return el.deck;
  return el.documentStage;
}

const partsSplitLayout = {
  box: () => {
    const right = splitLeftPart === state.viewMode ? state.splitPart : state.viewMode;
    const a = splitPaneElement(splitLeftPart)?.getBoundingClientRect();
    const b = splitPaneElement(right)?.getBoundingClientRect();
    return a && b ? { start: a.left, end: b.right } : null;
  },
  release: () => closeSplitPart()
};

// The panel's layout attributes. Written only when they change: each is
// observed (src/ui/chrome.js mirrors the focused part onto <body>), and every
// write of an observed attribute is a callback.
function setPanelAttr(name, value) {
  if (!quizPanel) return;
  if (value == null) {
    if (quizPanel.hasAttribute(name)) quizPanel.removeAttribute(name);
  } else if (quizPanel.getAttribute(name) !== value) {
    quizPanel.setAttribute(name, value);
  }
}

function applyPartsLayout() {
  const open = Boolean(state.splitPart);
  if (!quizPanel) return;
  if (quizPanel.classList.contains("is-parts-split") !== open) quizPanel.classList.toggle("is-parts-split", open);
  const right = open ? (splitLeftPart === state.viewMode ? state.splitPart : state.viewMode) : null;
  setPanelAttr("data-split-left", open ? splitLeftPart : null);
  setPanelAttr("data-split-right", right);
  setPanelAttr("data-focus-part", open ? state.viewMode : null);
}

export function openSplitPart(mode) {
  if (!SPLIT_PART_MODES.includes(mode) || mode === state.viewMode) return false;
  if (!hasActiveDeck() || splitStacked() || !viewTabAvailable(mode)) return false;
  if (!splitPairAllowed(state.viewMode, mode)) return false;
  if (state.splitPart === mode) return true;
  if (!el.notesStage || !quizPanel) return false;
  // Takes the column from the Highlights pane if that is open.
  setSplitLayoutOwner(partsSplitLayout);
  const replacing = state.splitPart;
  // A part leaving the screen takes what it has open with it, as a tab press
  // would: a block being typed in on a page, a note in the highlights editor.
  if (replacing) {
    if (isDocumentPartMode(replacing)) blockEditFlushHook?.();
    flushReadingPositionSave();
  } else {
    splitLeftPart = state.viewMode;
    partsSplitDeckKey = currentSplitDeckKey();
  }
  closeHighlightsEditor();
  state.splitPart = mode;
  if (el.splitDivider) {
    el.splitDivider.hidden = false;
    el.splitDivider.setAttribute("aria-orientation", "vertical");
  }
  applySplitRatio(readSplitRatio());
  applyPartStages();
  paintViewTabs();
  measureChromeHeights();
  if (mode === "notes") prepareNotesArrival({}, true);
  paintPart(mode, {}, true);
  scheduleSplitRelayout();
  return true;
}

export function closeSplitPart() {
  const leaving = state.splitPart;
  if (!leaving) return;
  if (isDocumentPartMode(leaving)) blockEditFlushHook?.();
  if (leaving === "notes") hideNotesSelectionButton();
  flushReadingPositionSave();
  state.splitPart = null;
  splitLeftPart = null;
  partsSplitDeckKey = "";
  releaseSplitLayout(partsSplitLayout);
  if (el.splitDivider) el.splitDivider.hidden = true;
  applyPartStages();
  paintViewTabs();
  // The focused document is the one on the stage again, whichever it is.
  if (isDocumentPartMode(state.viewMode) && isDocumentPartMode(leaving)) documentFocusHook?.(state.viewMode);
  measureChromeHeights();
  scheduleSplitRelayout();
}

// Move the focus to the part beside. Nothing is shown, hidden or rendered: both
// panes stay exactly as they are, and only what follows the focused part — the
// tab pills, the tools in the tab row, ⇓ and ◐, the keyboard, the time log —
// moves over.
export function focusPart(mode) {
  if (!state.splitPart || mode !== state.splitPart) return false;
  const previous = state.viewMode;
  previousViewMode = previous;
  viewSwitchHook?.(previous, mode);
  state.splitPart = previous;
  state.viewMode = mode;
  splitViewHook?.(mode);
  if (isDocumentPartMode(mode) && isDocumentPartMode(previous)) documentFocusHook?.(mode);
  applyPartsLayout();
  // The same attribute the tab row's document tools are swapped on, for the
  // paper now in focus — only different when both papers are up.
  el.documentStage?.setAttribute("data-doc-slot", documentPartInFocus() === "handwriting" ? "notebook" : "doc");
  paintViewTabs();
  paintViewExportMenu();
  paintViewStyleButton();
  if (hasActiveDeck()) rememberDeckTab(deckTabKey(state.deckId, state.localDeckId), mode);
  measureChromeHeights();
  return true;
}

// The pane under a pointer or a focus, or null outside both.
function splitPartAt(target) {
  if (!state.splitPart || !target?.closest) return null;
  for (const mode of [state.viewMode, state.splitPart]) {
    if (mode === "cards") {
      if (target.closest(".deck, .controls, .deck-utility-actions, .replay-actions, .progress-track")) return mode;
    } else if (mode === "notes") {
      if (el.notesStage?.contains(target)) return mode;
    } else if (el.documentStage?.contains(target)) {
      return mode;
    }
  }
  return null;
}

// Focus follows the hand: a press, a wheel or keyboard focus inside the pane
// that is not focused moves the focus there before anything inside the pane
// sees the event. Capture phase on the panel, which is an ancestor of every
// pane, so the pane's own listeners — the pen, a card's flip, the note's
// selection — all run with the focus already where they are.
export function initSplitPartsFocus() {
  if (!quizPanel || quizPanel.dataset.splitFocusWired) return;
  quizPanel.dataset.splitFocusWired = "";
  const follow = (event) => {
    if (!state.splitPart) return;
    const mode = splitPartAt(event.target);
    if (mode && mode !== state.viewMode) focusPart(mode);
  };
  quizPanel.addEventListener("pointerdown", follow, { capture: true, passive: true });
  quizPanel.addEventListener("focusin", follow, { capture: true });
  quizPanel.addEventListener("wheel", follow, { capture: true, passive: true });
  // Below the 720px boundary there is not room for two parts; the focused one
  // takes the panel back.
  window.matchMedia(SPLIT_STACK_QUERY).addEventListener?.("change", (event) => {
    if (event.matches) closeSplitPart();
  });
}

export function swapSplitSides() {
  if (!state.splitPart) return false;
  splitLeftPart = splitLeftPart === state.viewMode ? state.splitPart : state.viewMode;
  applyPartsLayout();
  scheduleSplitRelayout();
  return true;
}

// The menu behind the ⫿ button beside the tabs, and the reading rail's row of
// the same name. Rebuilt from the file and the parts on screen each time it
// opens, like the export menu beside it, so there is one menu in the DOM and
// no row in it for a part this file does not have.
const SPLIT_PART_LABELS = { cards: "Cards", notes: "Notes", document: "PDFs", handwriting: "Canvas" };

export function paintSplitPartsMenu(menu = el.splitPartsMenu) {
  if (!menu) return;
  menu.innerHTML = "";
  const head = document.createElement("div");
  head.className = "md-menu-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = "Open beside";
  head.appendChild(headLabel);
  menu.appendChild(head);
  const row = (action, label, hint, { checked = null, aside = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-menu-item";
    button.dataset.splitAction = action;
    if (aside) button.classList.add("is-view-export-aside");
    if (checked != null) button.setAttribute("aria-pressed", checked ? "true" : "false");
    const text = document.createElement("span");
    text.textContent = label;
    if (hint) {
      const small = document.createElement("span");
      small.className = "nhm-hint";
      small.textContent = hint;
      text.appendChild(small);
    }
    button.appendChild(text);
    menu.appendChild(button);
  };
  const choices = splitPartChoices();
  choices.forEach((mode) => row(`open:${mode}`, SPLIT_PART_LABELS[mode], "", { checked: state.splitPart === mode }));
  if (!choices.length) {
    const empty = document.createElement("p");
    empty.className = "split-parts-empty";
    empty.textContent = "This file has no other part to show beside this one.";
    menu.appendChild(empty);
  }
  if (state.splitPart) {
    row("swap", "Swap sides", "", { aside: true });
    row("close", "Close side by side", `Keep ${SPLIT_PART_LABELS[state.viewMode]} only`);
  }
}

// One press in that menu. Returns whether it did something.
export function runSplitPartsAction(action) {
  if (action === "swap") return swapSplitSides();
  if (action === "close") {
    closeSplitPart();
    return true;
  }
  if (action?.startsWith("open:")) return openSplitPart(action.slice(5));
  return false;
}

export function closeSplitPartsMenu() {
  if (el.splitPartsMenu) el.splitPartsMenu.hidden = true;
  el.splitPartsBtn?.setAttribute("aria-expanded", "false");
}

export function isSplitPartsMenuOpen() {
  return Boolean(el.splitPartsMenu && !el.splitPartsMenu.hidden);
}

// Rebuilt on every open, so it always lists what this file has now.
export function toggleSplitPartsMenu(force) {
  const menu = el.splitPartsMenu;
  if (!menu) return;
  const open = typeof force === "boolean" ? force : menu.hidden;
  if (open) {
    closeViewExportMenu();
    paintSplitPartsMenu(menu);
  }
  menu.hidden = !open;
  el.splitPartsBtn?.setAttribute("aria-expanded", String(open));
}

// ── Reading room: collapsing the chrome ─────────────────────────────
// On a phone the appbar (file title, category, score, sync) ate a large slice
// of the viewport before a single word of the note. Focus mode folds it away
// via `body.chrome-collapsed` — the title bar ONLY: the tab row below it, with
// the tabs and the file's tools, stays on screen (styles/67-focus-fold.css).
// It is pinned by the reader (⤢ in the ⋯ menu, Ctrl+., the rail) and works at
// every width; nothing folds it on scroll any more (see src/ui/chrome.js).
export const FOCUS_MODE_KEY = "recall:focusMode";

// Bumped on every deferred switch so a superseded paint (two fast taps on the
// toggle) is dropped rather than rendering a view that is no longer chosen.
export let viewModePaintToken = 0;


// ── The export button beside the tabs ─────────────────────────────────────
//
// One control that means "export what I am looking at". Its rows are rebuilt
// from the active view rather than shown and hidden, so there is exactly one
// menu in the DOM and no chance of a Cards row being reachable from the
// Document view.
//
// Every row is a (label, hint, dataset) triple and nothing more — the handlers
// live in src/main.js, keyed off data-view-export, and each one calls an export
// function that already existed. This file deliberately imports none of them:
// src/export/run.js reaches most of the app, and view-mode.js is imported by
// half of it.
const VIEW_EXPORT_MENUS = {
  cards: {
    head: "Export cards",
    rows: [
      ["pdf", "Cornell PDF", "The two-column study layout"],
      ["html", "Standalone HTML", ""],
      ["doc", "Word (.docx)", ""],
      ["markdown", "Markdown", ""],
      ["json", "JSON", "A Recall file, re-importable"],
      ["sql", "SQL", ""]
    ]
  },
  notes: {
    head: "Export notes",
    rows: [
      ["notes:pdf", "PDF", ""],
      ["notes:html", "Standalone HTML", ""],
      ["notes:doc", "Word (.docx)", ""],
      ["notes:markdown", "Markdown", "Highlight notes ride along as a section"],
      // ── The row the ☰ drawer used to hold ────────────────────────────────
      // "Export Highlights…" was a drawer entry, three rows deep and nowhere
      // near the thing being exported — the same complaint that put this ⇓
      // beside the tabs for the other two. It is not a fourth FORMAT of the
      // notes: it opens #exportHighlightsModal, which asks its own questions
      // (context lines, chapter headings, whether the notes come too) and then
      // exports in whichever format is chosen there. Hence the separator ahead
      // of it and the sentence under it, rather than a fifth peer of PDF/HTML.
      ["hl:open", "Highlights…", "Every line you marked, with its note"]
    ]
  },
  document: {
    head: "Export PDF",
    rows: [
      ["doc:annotated-pdf", "Annotated pages + notes", "Only the pages you wrote something about"],
      ["doc:pages-pdf", "The whole document + notes", "Every page, marked, notes underneath"],
      ["doc:notes-pdf", "The notes on their own", "Every note, grouped by page"],
      ["doc:original", "The original PDF", "Byte for byte, as it arrived"],
      // The marks as real PDF annotations (src/documents/pdf-annot-export.js),
      // for a reader who will go on working on the file in another PDF app.
      ["doc:native", "With annotations", "Your marks as real PDF annotations, editable in other PDF apps"],
      // Same row, same dialog, on the surface a reader marking up a paper is
      // actually standing on. The side-by-side pane's own ⇓
      // (#highlightCycleExportBtn) still opens it too — that one is reachable
      // without leaving the split.
      ["hl:open", "Highlights…", "Every line you marked, with its note"]
    ]
  },
  // The same rows, because it is the same machinery pointed at the deck's other
  // document — every one of these already exports "the pages on the stage", and
  // the stage is the notebook here. Only the words change, and only where "the
  // original PDF" would have been a lie: nobody handed us this file, this app
  // wrote it.
  handwriting: {
    head: "Export Canvas pages",
    rows: [
      ["doc:annotated-pdf", "Pages you wrote on", "Only the pages that have something on them"],
      ["doc:pages-pdf", "The whole canvas", "Every page, with your handwriting on it"],
      ["doc:notes-pdf", "The notes on their own", "Every note, grouped by page"],
      ["doc:original", "The blank paper", "The pages with nothing on them"],
      ["doc:native", "With annotations", "Your marks as real PDF annotations, editable in other PDF apps"],
      ["hl:open", "Highlights…", "Every mark, with its note"]
    ]
  }
  // Still no `highlights` entry keyed by view: there is no Highlights VIEW, and
  // this table is keyed by state.viewMode. The highlights export is a row on
  // the two views that can have highlights instead — see "hl:open" above.
};

export function paintViewExportMenu() {
  const menu = el.viewExportMenu;
  if (!menu) return;
  const spec = VIEW_EXPORT_MENUS[state.viewMode] || VIEW_EXPORT_MENUS.cards;
  menu.innerHTML = "";
  const head = document.createElement("div");
  head.className = "md-menu-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = spec.head;
  head.appendChild(headLabel);
  menu.appendChild(head);
  spec.rows.forEach(([action, label, hint]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-menu-item";
    button.dataset.viewExport = action;
    // The highlights row is not a format of the view above it — it opens a
    // dialog that asks its own questions — so it is set off from the run of
    // formats rather than reading as the last of them. A class, so the rule
    // lives in styles/48-reading-chrome.css with the rest of this work.
    if (action === "hl:open") button.classList.add("is-view-export-aside");
    const text = document.createElement("span");
    text.textContent = label;
    if (hint) {
      const small = document.createElement("span");
      small.className = "nhm-hint";
      small.textContent = hint;
      text.appendChild(small);
    }
    button.appendChild(text);
    menu.appendChild(button);
  });
}

export function closeViewExportMenu() {
  if (el.viewExportMenu) el.viewExportMenu.hidden = true;
  el.viewExportBtn?.setAttribute("aria-expanded", "false");
}

// ── The ◐ beside ⇓: this view's own style ──────────────────────────────────
//
// Which section it opens follows the tab the reader is on, by the same rule the
// pen's per-tab settings use (src/storage/ink-prefs.js, currentInkSurface) —
// not state.viewMode alone, because the document view can be showing a
// Canvas. The section ids are the style schema's (src/ui/style-schema.js).
const VIEW_STYLE_SCOPES = {
  cards: { scope: "cards", label: "Cards" },
  notes: { scope: "notes", label: "Notes" },
  doc: { scope: "document", label: "PDFs" },
  notebook: { scope: "handwriting", label: "Canvas" }
};

export function currentViewStyleScope() {
  return (VIEW_STYLE_SCOPES[currentInkSurface()] || VIEW_STYLE_SCOPES.cards).scope;
}

export function paintViewStyleButton() {
  const button = el.viewStyleBtn;
  if (!button) return;
  const { scope, label } = VIEW_STYLE_SCOPES[currentInkSurface()] || VIEW_STYLE_SCOPES.cards;
  button.dataset.styleScopeBtn = scope;
  button.title = `Style ${label} — text sizes, spacing and layout`;
  button.setAttribute("aria-label", `Style ${label}`);
}

