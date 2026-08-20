// Changing or removing a highlight that already exists.
//
// Separate from the panel that lists them, because this is not a panel concern:
// the controls live on the mark itself in the note (see src/notes/mark-menu.js),
// where you notice a wrong colour, and the panel only jumps.
//
// Both operations address the mark by its ORDINAL — how many <mark> opens
// precede it in the source — rather than by its text. Deliberately not
// locateSelectionInSource: that searches for words, and the words of a
// highlight are very often repeated elsewhere in the same note, so a text
// search is a coin flip about which one gets edited.

import { state } from "../core/state.js?v=__BUILD__";
import { HIGHLIGHT_SCAN_RE, MARK_CLOSE_TAG, markGroupSpanAt, markOpenTag } from "./highlight.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { pruneOrphanHighlightNotes } from "./highlight-notes.js?v=__BUILD__";

// Set by main.js so the Highlights tab can refresh itself after an edit made
// in the note, without this module importing the panel that owns it.
// format/highlight-notes.js (the note-over-highlight feature) reuses the same
// handler via notifyHighlightsChanged rather than registering its own, so the
// panel only ever needs one wire-up.
let onHighlightsChanged = () => {};

export function setHighlightsChangedHandler(fn) {
  onHighlightsChanged = typeof fn === "function" ? fn : () => {};
}

export function notifyHighlightsChanged() {
  onHighlightsChanged();
}

//
// Both of these find the mark by counting <mark> opens in the source (see
// markGroupSpanAt in format/highlight.js), which is the same ordinal
// collectDeckHighlights already reports — so the row and the span it edits
// cannot disagree. Deliberately NOT locateSelectionInSource: that searches
// for text, and the text of a highlight is frequently repeated elsewhere in
// a note.
function rewriteHighlightGroup(markIndex, rewrite, { pruneNotes = false } = {}) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, markIndex);
  if (!span) {
    showToast("That highlight is no longer in the note", "error");
    return;
  }
  pushNotesUndo("highlight");
  const rewritten = source.slice(0, span.start) + rewrite(source.slice(span.start, span.end)) + source.slice(span.end);
  // Removing a highlight leaves its entry in the note's "Highlight Notes"
  // section with nothing pointing at it — pruned here rather than left to
  // accumulate at the end of the note forever.
  state.notes = pruneNotes ? pruneOrphanHighlightNotes(rewritten) : rewritten;
  renderNotesViewPinned();
  scheduleDeckAutosave();
  onHighlightsChanged();
}

// A recolour preserves whatever note reference (data-note) each piece already
// carried — the replace callback only ever touches colour, and the note
// capture (see HIGHLIGHT_SCAN_RE in format/highlight.js) rides straight
// through to markOpenTag unchanged.
export function recolourHighlightAt(markIndex, color) {
  rewriteHighlightGroup(markIndex, (slice) =>
    slice.replace(HIGHLIGHT_SCAN_RE, (_all, _c, note, inner) => markOpenTag(color, note) + inner + MARK_CLOSE_TAG));
}

export function removeHighlightAt(markIndex) {
  rewriteHighlightGroup(
    markIndex,
    (slice) => slice.replace(HIGHLIGHT_SCAN_RE, (_all, _c, _note, inner) => inner),
    { pruneNotes: true }
  );
}

