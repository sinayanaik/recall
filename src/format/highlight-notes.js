// A note attached to a highlight (Kindle-style "note over a highlight").
//
// No new storage: the note rides inside the SAME <mark> tag data-color
// already lives in, as data-note — base64 of the note's own markdown, so it
// survives HTML-attribute escaping of quotes/newlines untouched. A highlight
// that wrapAcrossBlocks split into several adjacent <mark>s (a paragraph or
// list-item drag) is still ONE annotation, so only the group's FIRST piece
// ever carries data-note — see rewriteFirstMarkNote.

import { state } from "../core/state.js?v=__BUILD__";
import { MARK_CLOSE_TAG, markGroupSpanAt, markOpenTag, markSpanAt } from "./highlight.js?v=__BUILD__";
import { notifyHighlightsChanged } from "./highlight-edit.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// btoa/atob only handle Latin1, so the note's UTF-8 bytes are routed through
// them one byte at a time rather than the raw string — an emoji or accented
// character in a note would otherwise throw "characters outside of the
// Latin1 range" and the note would silently fail to save.
export function encodeHighlightNote(markdown) {
  const bytes = new TextEncoder().encode(markdown);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export function decodeHighlightNote(encoded) {
  if (!encoded) return "";
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // A hand-edited or corrupted data-note attribute: fail soft to "no note"
    // rather than breaking the highlight it's attached to.
    return "";
  }
}

// Rewrites ONLY the group's first <mark> open tag — every other piece (if
// wrapAcrossBlocks split this highlight across blocks/list items) is copied
// through unchanged, note and all (a piece other than the first never has
// one by construction).
function rewriteFirstMarkNote(markIndex, noteB64) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, markIndex);
  const first = markSpanAt(source, markIndex);
  if (!span || !first) {
    showToast("That highlight is no longer in the note", "error");
    return false;
  }
  const rewrittenFirst = markOpenTag(first.color, noteB64 || undefined) + first.inner + MARK_CLOSE_TAG;
  pushNotesUndo("highlight");
  state.notes = source.slice(0, first.start) + rewrittenFirst + source.slice(first.end, span.end) + source.slice(span.end);
  renderNotesViewPinned();
  scheduleDeckAutosave();
  notifyHighlightsChanged();
  return true;
}

export function setHighlightNoteAt(markIndex, markdownText) {
  const text = String(markdownText || "").trim();
  if (!text) return clearHighlightNoteAt(markIndex);
  return rewriteFirstMarkNote(markIndex, encodeHighlightNote(text));
}

export function clearHighlightNoteAt(markIndex) {
  return rewriteFirstMarkNote(markIndex, null);
}
