// Switching between the cards view and the notes view.

import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { refreshHighlightBackdrop } from "../editor/highlight-mirror.js?v=__BUILD__";
import { enterNotesEditing, isNotesEditing, notesScrolledSource, quizPanel, renderNotesView, resetNotesEditingUI } from "../notes/notes-view.js?v=__BUILD__";
import { applyNotesPagedLayout } from "../notes/paged-view.js?v=__BUILD__";
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
  const next = mode === "notes" ? "notes" : mode === "highlights" ? "highlights" : "cards";
  if (!el.notesStage || !el.viewModeToggle) {
    state.viewMode = next;
    return;
  }
  if (next === "cards") resetNotesEditingUI();
  const changed = state.viewMode !== next;
  state.viewMode = next;
  const notesActive = next === "notes";
  const highlightsActive = next === "highlights";
  // Highlights reuses the notes-mode layout (deck/controls give way to a
  // full-height stage) — it's a notes-adjacent view, not a card view.
  quizPanel?.classList.toggle("notes-mode", notesActive || highlightsActive);
  el.notesStage.hidden = !notesActive;
  if (el.highlightsStage) el.highlightsStage.hidden = !highlightsActive;
  el.viewModeToggle.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewMode === next);
  });
  hideNotesSelectionButton();
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
    if (isNotesEditing() && el.notesEdit.value !== state.notes) {
      el.notesEdit.value = state.notes;
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
      if (!state.notes.trim()) enterNotesEditing();
    } else if (highlightsActive) {
      renderHighlightsPanel();
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
