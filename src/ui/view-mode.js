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
import { closeHighlightsEditor } from "../panels/highlights-editor.js?v=__BUILD__";
import { openDocumentView } from "../documents/pdf-view.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { enterNotesEditing, isNotesEditing, notesScrolledSource, quizPanel, renderNotesView, resetNotesEditingUI } from "../notes/notes-view.js?v=__BUILD__";
import { applyNotesPagedLayout } from "../notes/paged-view.js?v=__BUILD__";
import { flushReadingPositionSave } from "../notes/reading-position.js?v=__BUILD__";
import { hideNotesSelectionButton } from "../notes/selection.js?v=__BUILD__";
import { renderHighlightsPanel } from "../panels/highlights-panel.js?v=__BUILD__";
import { measureChromeHeights, resetChromeAutoHide } from "./chrome.js?v=__BUILD__";

// `options.deferRender` yields one frame between flipping the toggle's own
// classes and doing the work behind them. Only the user-facing toggle passes
// it: renderNotesView() runs a full marked parse + DOMPurify sanitize of the
// whole note before its first await, so on a cold switch into a large note the
// `is-active` pill could not reach the screen until that finished — the button
// with the heaviest synchronous work in the app looked like it had missed the
// press. Every programmatic caller (deck load, import, scheduleNoteJump, …)
// keeps the original synchronous ordering, because several of them read the
// rendered DOM straight afterwards.
export function setViewMode(mode, options = {}) {
  const next = mode === "notes" ? "notes"
    : mode === "highlights" ? "highlights"
      // The Document surface is on every open deck now (refreshDocumentTab), and
      // on one with no PDF it opens to the offer of attaching one. This used to
      // fall back to "cards" unless state.meta.pdf was set, which was right while
      // there was no tab and nothing behind it — and would now bounce the reader
      // straight back out of the tab they just pressed.
      //
      // The guard that remains is the one that always mattered: no deck, no
      // surface. A stale nav-history entry replayed against a closed deck must
      // not open a document panel with no toggle to leave it by.
      : mode === "document" ? (hasActiveDeck() ? "document" : "cards")
        : "cards";
  if (!el.notesStage || !el.viewModeToggle) {
    state.viewMode = next;
    return;
  }
  if (next === "cards") resetNotesEditingUI();
  // A note being typed into the Highlights tab commits on the way out, exactly
  // as the note popup flushes in closeHighlightNoteEditor: leaving a view is not
  // a reason to lose a sentence. A no-op when nothing is open.
  closeHighlightsEditor();
  const changed = state.viewMode !== next;
  state.viewMode = next;
  const notesActive = next === "notes";
  const highlightsActive = next === "highlights";
  const documentActive = next === "document";
  // Highlights reuses the notes-mode layout (deck/controls give way to a
  // full-height stage) — it's a notes-adjacent view, not a card view. Document
  // wants the same layout for the same reason, and more so: a page of a paper
  // needs every pixel of height the chrome is not using.
  quizPanel?.classList.toggle("notes-mode", notesActive || highlightsActive || documentActive);
  el.notesStage.hidden = !notesActive;
  if (el.highlightsStage) el.highlightsStage.hidden = !highlightsActive;
  if (el.documentStage) el.documentStage.hidden = !documentActive;
  // Both containers, explicitly. The reading rail carries a second set of
  // [data-view-mode] buttons for focus mode (src/ui/reading-rail.js) and it must
  // never be a second opinion about where the reader is — but this is emphatically
  // NOT a document.querySelectorAll: an attribute selector cannot be answered
  // from an index, so on a book-sized note that would be a full tree walk on
  // every tab press.
  [el.viewModeToggle, el.readingRailTray].forEach((container) => {
    container?.querySelectorAll("[data-view-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.viewMode === next);
    });
  });
  paintViewExportMenu();
  hideNotesSelectionButton();
  // Leaving the notes is the moment the reading position is final — write out
  // an armed-but-unfired save now rather than letting its timer fire against a
  // view the reader has already left. (The save carries the deck key it was
  // captured with, so this is safe even mid-deck-swap.)
  if (changed && !notesActive && !documentActive) flushReadingPositionSave();
  // Switching views is navigation, not reading — start with the header visible.
  if (changed) resetChromeAutoHide();
  // The appbar is a different height in each view — the card counters are
  // hidden on a phone while reading — and its own ResizeObserver cannot see it
  // GROW, because the box that observer watches is clamped to the last height
  // recorded (`.appbar { max-height: var(--appbar-h) }`). So a height measured
  // in Notes view was still in force in Cards and Highlights, where the meta row
  // then spilled out over the tabs below it. This is the one place that knows
  // the view just changed.
  if (changed) measureChromeHeights();
  if (notesActive) {
    // A note you haven't been reading opens at its first line. Done BEFORE the
    // render rather than after it: scheduleNoteJump() calls setViewMode() and
    // then scrolls to the anchor a couple of frames later, and resetting on the
    // render's promise would yank that jump back to the top.
    // scrollLeft too: in paged mode the note runs sideways, so "the first line"
    // is page 0, and leaving scrollLeft where the previous note ended would
    // open a different note somewhere in its middle.
    if (el.notesView && state.notes !== notesScrolledSource) {
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

  const token = ++viewModePaintToken;
  const paint = () => {
    if (notesActive) {
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
    } else if (highlightsActive) {
      renderHighlightsPanel();
    } else if (documentActive) {
      // Idempotent for the deck already on screen — this runs on every switch
      // into the tab, and re-parsing a 40MB paper because someone glanced at
      // their cards is not a thing to do. Unawaited: the stage is already
      // visible and shows its own "Opening the document…" line.
      openDocumentView();
    } else if (changed) {
      showCard();
    }
  };

  if (options.deferRender) {
    requestAnimationFrame(() => {
      if (token !== viewModePaintToken) return;
      paint();
    });
  } else {
    paint();
  }
}

// ── Reading room: collapsing the chrome ─────────────────────────────
// On a phone the appbar (deck title, category, score, sync) plus the
// Cards/Notes toggle ate 103px of a 757px viewport before a single word of
// the note. Both fold away together via `body.chrome-collapsed`, driven two
// ways that share one piece of state so they can never disagree:
//
//   • pinned — the ⤢ button in the notes header keeps them hidden, so a long
//     note isn't interrupted by chrome reappearing every time you scroll up
//     to re-read a paragraph. Works at EVERY width: a laptop gives up the same
//     ~130px to chrome nobody is reading, and Esc / Ctrl+. exit it there.
//   • auto — scrolling down through the notes or a card face hides them; a
//     nudge back up (or reaching the top) brings them back, like a mobile
//     browser's URL bar. Costs the user nothing, but it stays PHONE-ONLY: a
//     mouse wheel flicking the header in and out on a large screen reads as a
//     bug rather than a feature, and desktop has the room to spare.
//
// Only the auto layer listens to scrolling; pinning short-circuits it, which
// is what makes "pinned" mean pinned.
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
      ["json", "JSON", "A Recall deck, re-importable"],
      ["sql", "SQL", ""]
    ]
  },
  notes: {
    head: "Export notes",
    rows: [
      ["notes:pdf", "PDF", ""],
      ["notes:html", "Standalone HTML", ""],
      ["notes:doc", "Word (.docx)", ""],
      ["notes:markdown", "Markdown", "Highlight notes ride along as a section"]
    ]
  },
  document: {
    head: "Export document",
    rows: [
      ["doc:annotated-pdf", "Annotated pages + notes", "Only the pages you wrote something about"],
      ["doc:pages-pdf", "The whole document + notes", "Every page, marked, notes underneath"],
      ["doc:notes-pdf", "The notes on their own", "Every note, grouped by page"],
      ["doc:original", "The original PDF", "Byte for byte, as it arrived"]
    ]
  },
  highlights: {
    head: "Export highlights",
    rows: [
      ["highlights:open", "Export highlights…", "Choose context, chapters and notes"]
    ]
  }
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
