// Where a note's own text stops and its highlight notes begin.
//
// A deck's markdown carries two things in one string: what the reader wrote,
// and — appended at the very end — the notes they attached to highlights, in
// the fenced block src/format/highlight-notes.js owns:
//
//     <!--recall:highlight-notes-->
//     …
//     <!--/recall:highlight-notes-->
//
// Two surfaces must not show the second half, and both of them said so in use:
//
//   • the RENDERED view, which used to print the whole "## Highlight Notes"
//     section under everything the reader wrote (and needed a backwards DOM walk
//     to hide it again when the inline-notes mode was on);
//   • the RAW EDITOR, where — on a PDF deck, whose body is empty because the PDF
//     is the document — opening the editor showed nothing BUT highlight notes,
//     with no separation from the reader's own writing because there was none to
//     have.
//
// ── Why this is a module of its own, and why it imports nothing ───────────
//
// Both of those surfaces sit at opposite ends of the graph: src/notes/notes-
// view.js is high in it, and src/render/block-cache.js — which has to agree with
// notes-view about exactly which string it rendered, or its estimate cache
// misses on every pass — is about as low as it goes. highlight-notes.js reaches
// state, the deck store, the undo stack and the toast layer, so neither of them
// could import it without dragging that whole subtree along (block-cache would
// close a cycle outright). These four functions touch nothing but the string
// they are handed, so they can be imported from anywhere.
//
// ── Why slicing a tail is safe ────────────────────────────────────────────
//
// The block is always LAST. Every raw-markdown offset in this app — raw-offset
// .js, locate-selection.js, anchors.js, toc.js, the caret the raw editor
// resumes at — is an index measured from the START of the source, so removing a
// suffix moves none of them. The only offsets that would break are ones
// pointing INTO the block, which is exactly the region being removed.

export const HIGHLIGHT_NOTES_OPEN = "<!--recall:highlight-notes-->";

export const HIGHLIGHT_NOTES_CLOSE = "<!--/recall:highlight-notes-->";

const OPEN_RE = /^<!--recall:highlight-notes-->[ \t]*$/gm;

const CLOSE_RE = /^<!--\/recall:highlight-notes-->[ \t]*$/m;

// Where the block starts, where its entries start, where they end, and where the
// whole thing finishes (closing marker included) — or null when there is none.
//
// The LAST opening marker wins. That rule mattered a great deal in the heading
// form this replaced, where a book whose own text contained "## Highlight Notes"
// was indistinguishable from the app's section; it matters much less now, since
// nothing writes this marker but highlight-notes.js. It is kept because a note
// that somehow carries two is one that was appended to, and the later one is
// the one this app wrote.
//
// A missing closing marker (a hand-edit that deleted it, a file cut short) reads
// as "the block runs to the end", which is what the heading form always meant
// and is the safe answer: it can lose a paste made below the block, but it can
// never mistake the reader's own writing for note text.
export function highlightNotesBlockSpan(source) {
  const text = String(source || "");
  if (!text.includes(HIGHLIGHT_NOTES_OPEN)) return null;
  OPEN_RE.lastIndex = 0;
  let start = -1;
  let m;
  while ((m = OPEN_RE.exec(text))) start = m.index;
  if (start < 0) return null;
  const headEnd = text.indexOf("\n", start);
  const bodyStart = headEnd === -1 ? text.length : headEnd + 1;
  const close = CLOSE_RE.exec(text.slice(bodyStart));
  return {
    start,
    bodyStart,
    end: close ? bodyStart + close.index : text.length,
    after: close ? bodyStart + close.index + close[0].length : text.length
  };
}

// { body, tail }. The blank lines and the `---` rule written above the block go
// with the TAIL — they are its separator, not the body's trailing whitespace,
// and leaving them behind would grow the note by one horizontal rule every time
// the raw editor was opened and committed.
export function splitHighlightNotesTail(source) {
  const text = String(source || "");
  const span = highlightNotesBlockSpan(text);
  if (!span) return { body: text, tail: "" };
  return {
    body: text.slice(0, span.start).replace(/\s*\n-{3,}[ \t]*\n?\s*$/, "\n").replace(/\s+$/, ""),
    tail: text.slice(span.start, span.after)
  };
}

// The inverse. Re-attaches with exactly the separator splitHighlightNotesTail
// takes away, so split → join is the identity on anything this app wrote.
export function joinHighlightNotesTail(body, tail) {
  const head = String(body || "");
  if (!tail) return head;
  const trimmed = head.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n---\n\n${tail}\n` : `${tail}\n`;
}

// Just the reader's half, for a caller that has no use for the other one.
//
// Named readerNotesBody rather than the obvious notesBody because
// src/import/analyze.js already owns that name for a field on its parsed-deck
// shape, and a symbol name means one thing across this whole tree
// (tools/module-symbols.mjs enforces it — the flat-scope collisions that rule
// exists to prevent are why the app once shipped two fetchText).
//
// Memoized on its last input, one entry deep. Two callers depend on getting the
// SAME STRING back for the same note and not merely an equal one: renderNotesView
// compares its result against notesScrolledSource, and syncNotesBlockEstimate-
// Source against notesBlockEstimateSource — both to decide "is this the same
// document I last painted?", both on every repaint, and both on a string that
// can be a couple of megabytes. Without the memo each of those becomes a full
// character-by-character compare of a book, plus a fresh slice and two regex
// passes over it, on every paint.
//
// A note with no block at all — every note written before a highlight was
// annotated — never reaches the memo: it returns its own input, which is already
// the identity these callers want.
let lastBodySource = null;
let lastBody = "";

export function readerNotesBody(source) {
  const text = String(source || "");
  if (!text.includes(HIGHLIGHT_NOTES_OPEN)) return text;
  if (text === lastBodySource) return lastBody;
  lastBodySource = text;
  lastBody = splitHighlightNotesTail(text).body;
  return lastBody;
}
