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
import { HIGHLIGHT_GROUP_GAP_RE, HIGHLIGHT_SCAN_RE } from "../panels/highlights-panel.js?v=__BUILD__";
import { MARK_CLOSE_TAG, markOpenTag } from "./highlight.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Set by main.js so the Highlights tab can refresh itself after an edit made
// in the note, without this module importing the panel that owns it.
let onHighlightsChanged = () => {};

export function setHighlightsChangedHandler(fn) {
  onHighlightsChanged = typeof fn === "function" ? fn : () => {};
}

//
// Both of these find the mark by counting <mark> opens in the source, which is
// the same ordinal collectDeckHighlights already reports — so the row and the
// span it edits cannot disagree. Deliberately NOT locateSelectionInSource: that
// searches for text, and the text of a highlight is frequently repeated
// elsewhere in a note.
export function markSpanAt(source, markIndex) {
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  let i = 0;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    if (i === markIndex) {
      const inner = m[2];
      const openLength = m[0].length - inner.length - MARK_CLOSE_TAG.length;
      return { start: m.index, end: m.index + m[0].length, inner, openLength };
    }
    i += 1;
  }
  return null;
}

// A highlight the reader made in one action can be several adjacent <mark>s —
// wrapAcrossBlocks emits one per block, list item and table cell. Editing only
// the first would recolour a third of a bulleted passage, so the whole GROUP
// moves together, using exactly the adjacency rule the panel groups rows by.
export function markGroupSpanAt(source, markIndex) {
  const first = markSpanAt(source, markIndex);
  if (!first) return null;
  let last = first;
  let i = markIndex + 1;
  for (;;) {
    const next = markSpanAt(source, i);
    if (!next) break;
    if (!HIGHLIGHT_GROUP_GAP_RE.test(source.slice(last.end, next.start))) break;
    last = next;
    i += 1;
  }
  return { start: first.start, end: last.end, count: i - markIndex };
}

function rewriteHighlightGroup(markIndex, rewrite) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, markIndex);
  if (!span) {
    showToast("That highlight is no longer in the note", "error");
    return;
  }
  pushNotesUndo("highlight");
  state.notes = source.slice(0, span.start) + rewrite(source.slice(span.start, span.end)) + source.slice(span.end);
  renderNotesViewPinned();
  scheduleDeckAutosave();
  onHighlightsChanged();
}

export function recolourHighlightAt(markIndex, color) {
  rewriteHighlightGroup(markIndex, (slice) =>
    slice.replace(HIGHLIGHT_SCAN_RE, (_all, _c, inner) => markOpenTag(color) + inner + MARK_CLOSE_TAG));
  showToast("Highlight recoloured");
}

export function removeHighlightAt(markIndex) {
  rewriteHighlightGroup(markIndex, (slice) => slice.replace(HIGHLIGHT_SCAN_RE, (_all, _c, inner) => inner));
  showToast("Highlight removed");
}

