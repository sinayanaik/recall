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

// ── ...on every deck, including a PDF one ─────────────────────────────────
//
// There used to be an exception here. On a PDF deck the body is empty — the
// paper is the document — so cutting the block left the raw editor with nothing
// in it at all, and every note the reader had taken on the paper existed, was
// stored, was exported, and could not be opened as text anywhere in the app.
// The answer at the time was to hand that deck's editor the whole source,
// markers and all.
//
// It is gone, because its premise is. The Highlights tab is a continuous editor
// of every highlight and its note now (src/panels/highlights-editor.js), which
// is what "visible as continuous, easily editable text" was asking for — and it
// is a better answer than a raw editor full of `<!--hn:…-->` markers. So a PDF
// deck's Notes tab is what its name says: the reader's own writing, empty until
// they write something, with the machine-managed block sliced off it exactly as
// it is on every other deck.

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
