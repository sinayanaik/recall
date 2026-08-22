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

// ── ...except on a document deck, where the block IS the note ─────────────
//
// The paragraph above is the case this module was written for: a markdown deck,
// where the block is machine-managed text sitting under the reader's own
// writing with nothing between them.
//
// A PDF deck is the opposite case, and it turned the same slice into the
// problem: the body is empty because the paper is the document, so cutting the
// block left the raw editor with nothing in it at all. Every note the reader had
// taken on the paper existed, was stored, was exported — and could not be opened
// as text anywhere in the app. "The highlighted notes are not visible anywhere
// as continuous, easily editable text."
//
// So on such a deck the editor is handed the whole source, markers and all. That
// is not a private encoding leaking out: the fence is plain text in the same
// file, and src/format/highlight-notes.js states outright that rewriting a body
// by hand is a supported thing to do — the only rule being to keep the
// `<!--hn:id-->` line that ties a note to its highlight.
//
// Read off state.meta directly rather than through isPdfDeck(), which lives in
// src/documents/pdf-highlights.js: this module is imported by src/ui/view-mode
// .js and the undo stack, and pulling the document subtree in behind them for
// one boolean is the reordering the notes on selection.js warn about. The two
// predicates are the same test.
function documentDeck() {
  return Boolean(state.meta?.pdf);
}

// The raw markdown for `source` with its highlight notes taken off the end.
export function rawEditorValueFor(source) {
  if (documentDeck()) return String(source ?? "");
  return splitHighlightNotesTail(source).body;
}

// A textarea value put back together with whatever highlight-notes block the
// deck currently has. Reads the tail from state.notes rather than from a
// remembered copy — see above.
export function sourceFromRawEditor(value) {
  // The editor already holds the tail on a document deck, so re-attaching one
  // would give the deck two of them — and the second would win every later read
  // (highlightNotesBlockSpan takes the LAST opening marker), quietly stranding
  // everything in the first.
  if (documentDeck()) return String(value ?? "");
  return joinHighlightNotesTail(String(value ?? ""), splitHighlightNotesTail(state.notes || "").tail);
}
