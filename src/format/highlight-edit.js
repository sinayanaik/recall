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
import { applyHighlightRange, markGroupSpanAt, markOpenTag, rewriteMarkTags, settleHighlightSource, snapToWholeCharacters } from "./highlight.js?v=__BUILD__";
import { locateSelectionInSource } from "./locate-selection.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";
import { pruneOrphanHighlightNotes, resolveHighlightRef } from "./highlight-notes.js?v=__BUILD__";

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
function rewriteHighlightGroup(markRef, open, { pruneNotes = false } = {}) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, resolveHighlightRef(source, markRef));
  if (!span) {
    showToast("That highlight is no longer in the note", "error");
    // The press came from a note that no longer matches its source — repaint
    // it, so the next press is made on what is really there.
    renderNotesViewPinned();
    return false;
  }
  pushNotesUndo("highlight");
  // By position, tag by tag (rewriteMarkTags): the words between the tags —
  // and anything unusual in them — are never touched.
  const rewritten = rewriteMarkTags(source, span.pieces, open);
  // Removing a highlight leaves its entry in the note's "Highlight Notes"
  // section with nothing pointing at it — pruned here rather than left to
  // accumulate at the end of the note forever.
  state.notes = pruneNotes ? pruneOrphanHighlightNotes(rewritten) : rewritten;
  renderNotesViewPinned();
  scheduleDeckAutosave();
  onHighlightsChanged();
  return true;
}

// A recolour preserves whatever note reference (data-note) each piece already
// carried — only the colour in each open tag changes.
export function recolourHighlightAt(markRef, color) {
  return rewriteHighlightGroup(markRef, (piece) => markOpenTag(color, piece.note));
}

export function removeHighlightAt(markRef) {
  return rewriteHighlightGroup(markRef, () => "", { pruneNotes: true });
}

// ── Resizing a highlight ───────────────────────────────────────────────────
//
// The mark menu's "Adjust": the highlight's words are selected with handles,
// the reader drags either end, and this moves the highlight to what is
// selected now — the same colour, the same note — whether that is more words
// or fewer.
//
// The old highlight's tags come out FIRST and the selection is found in the
// source without them. Found with them, a selection that reached past one end
// of the old highlight would be widened by the text search to swallow the
// whole of it (expandToBalancedBounds), and a highlight could only ever grow.
// With them gone the search sees plain words, and [idx, end) is exactly what
// was selected.
export function adjustHighlightAt(markRef, sel) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, resolveHighlightRef(source, markRef));
  if (!span) {
    showToast("That highlight is no longer in the note", "error");
    renderNotesViewPinned();
    return false;
  }
  const first = span.pieces[0];
  const bare = rewriteMarkTags(source, span.pieces, () => "");
  const loc = sel ? locateSelectionInSource(bare, sel, { fuzzy: true }) : null;
  if (!loc) {
    showToast("Couldn't match that selection in the source — try selecting whole words.", "error");
    return false;
  }
  const { idx, end } = snapToWholeCharacters(bare, loc.idx, loc.end);
  const note = span.pieces.find((piece) => piece.note)?.note || null;
  const result = applyHighlightRange(bare, idx, end, first.color, { note, force: true });
  if (!result || result.action === "already") {
    showToast("Select at least one word to keep highlighted.", "error");
    return false;
  }
  const settled = settleHighlightSource(result);
  pushNotesUndo("highlight");
  state.notes = pruneOrphanHighlightNotes(settled.text);
  renderNotesViewPinned(settled.idx);
  scheduleDeckAutosave();
  onHighlightsChanged();
  return true;
}
