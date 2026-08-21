// What the raw editor is given, and what it hands back.
//
// The <textarea> used to hold state.notes verbatim, which meant it also held the
// highlight-notes block appended at the end of it. On a note with a body that is
// merely an annoyance — you scroll past your own writing and there it is. On a
// PDF DECK it is the whole editor: the PDF is the document, so the body is
// empty, and pressing ✎ showed the reader nothing but a machine-managed list of
// their own highlight notes with nothing separating them from the writing they
// came to do. That is the report this module exists for.
//
// So the editor gets the BODY, and the block is re-attached on the way back.
// Both directions go through here and nowhere else, because there are seven
// places that copy between state.notes and el.notesEdit.value — the live input
// listener in main.js, the commit and open in notes-view.js, the deck-swap
// guard in view-mode.js, the undo stack, the cloze panel and the raw formatting
// toolbar — and a single one of them left unrouted deletes every highlight note
// in the deck on the next keystroke.
//
// ── Stateless, deliberately ───────────────────────────────────────────────
//
// There is no stashed copy of the tail here. state.notes still holds the WHOLE
// source at all times — only the textarea sees a truncated view — so the tail is
// simply read back off state.notes whenever the editor commits. That is not just
// simpler, it is more correct: a highlight note edited from the Highlights panel
// or the note popup while the raw editor is open rewrites that tail, and a stash
// taken when the editor opened would put the old one back over it.

import { state } from "../core/state.js?v=__BUILD__";
import { joinHighlightNotesTail, splitHighlightNotesTail } from "../format/notes-fence.js?v=__BUILD__";

// The raw markdown for `source` with its highlight notes taken off the end.
export function rawEditorValueFor(source) {
  return splitHighlightNotesTail(source).body;
}

// A textarea value put back together with whatever highlight-notes block the
// deck currently has. Reads the tail from state.notes rather than from a
// remembered copy — see above.
export function sourceFromRawEditor(value) {
  return joinHighlightNotesTail(String(value ?? ""), splitHighlightNotesTail(state.notes || "").tail);
}
