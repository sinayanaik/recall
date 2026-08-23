// Every highlight in the deck as a jump target: the words, and where they are.
//
// ── Why this is not collectDeckHighlights ─────────────────────────────────
//
// The Highlights panel widens every row to the whole LINE its highlight sits
// in, renders that line's markdown, restores its list marker and merges rows
// that landed on the same line. All of that is right for a panel you read and
// wrong for a list you scan: a contents drawer wants the words that were
// actually marked, one row each, in reading order, and it wants them as plain
// text — a drawer that calls renderMarkdown once per row is a book's worth of
// marked+DOMPurify passes for a list nobody is reading closely.
//
// So this is the same underlying scan (scanHighlightGroups, and the document
// records in reading order) with a different, much smaller shape taken off it.
// Deliberately NOT a second scan: the panel, the two drawer sections and the
// exports all still resolve a highlight the same way, because they all still
// start from the same two functions.
//
// ── One shape, two sources ────────────────────────────────────────────────
//
//   text     the highlighted words, as plain text
//   color    the mark's / record's colour token, for the row's colour chip
//   note     whether something is written about it
//   noteText ...and the first DRAWER_NOTE_CHARS of it, as plain text
//   where    the chapter it is under, or the page it is on
//   anchor   what scheduleNoteJump searches for
//   locator  the exact-target shortcut scheduleNoteJump prefers over the
//            search: a <mark>'s ordinal in the note, or a record's id
//
// `locator` and `anchor` are built exactly as the Highlights panel builds them,
// because a jump that lands somewhere else is the one failure a list of
// highlights cannot survive — see the "Go to takes me somewhere else" history
// on collectNoteHighlightRows.

import { state } from "../core/state.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { readHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { headingForOffset, headingIndexFor } from "../notes/chapters.js?v=__BUILD__";
import { notesAnchorPlainText } from "../notes/anchors.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { scanHighlightGroups } from "./highlights-panel.js?v=__BUILD__";
import { documentHighlightLabel, documentHighlightsInReadingOrder } from "../documents/pdf-highlights.js?v=__BUILD__";

// ── Why the note is carried, and why only the first of it ─────────────────
//
// The drawer used to say a highlight had a note by showing a "✎" and nothing
// else, on the argument that "a note is said, not shown" — read it in the
// Highlights tab or by pressing the number on the mark. On a PAPER that
// argument does not survive contact: the reader is on page 40, the note is in a
// different tab, and the one question the drawer is being asked is "which of
// these did I write something about, and what". So the note is shown.
//
// Clipped HERE rather than in CSS, and that is the load-bearing half. A book
// with five hundred annotated highlights would otherwise hold five hundred
// notes in full in the row DOM — several megabytes of text laid out and
// line-clamped down to two lines — for a list being scanned rather than read.
// Two lines of a 300px drawer is about 70 characters; this is twice that, so a
// clamp still has something to clamp.
export const DRAWER_NOTE_CHARS = 140;

export function clipDrawerNote(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > DRAWER_NOTE_CHARS ? `${flat.slice(0, DRAWER_NOTE_CHARS).trimEnd()}…` : flat;
}

// The note's own <mark>s, in reading order.
//
// readerNotesBody, not state.notes, for the reason collectNoteHighlightRows
// gives at length: the "Highlight Notes" tail can itself contain a <mark> — the
// note popup ships the full formatting toolbar — and a highlight of a highlight's
// note is not a highlight of the document. Reading the whole string would list
// it as one AND break every OTHER row's exact-ordinal jump, because markCount
// would no longer equal the number of <mark>s the rendered view has.
export function noteHighlightEntries() {
  const notes = state.notes || "";
  const source = readerNotesBody(notes);
  // Scanned over the body, resolved against the whole note — the notes live in
  // the tail the body has just had sliced off it. See scanHighlightGroups.
  const { raw, groups } = scanHighlightGroups(source, notes);
  const headings = headingIndexFor(source);
  const entries = [];
  groups.forEach((group) => {
    // The FIRST piece's inner text, not the group's. A selection dragged across
    // a paragraph boundary leaves one <mark> per block (wrapAcrossBlocks), and
    // the first is both what the reader recognises and where a jump should
    // land.
    const text = notesAnchorPlainText(group.pieces[0].inner);
    if (!text) return;
    const heading = headingForOffset(headings, group.offset);
    entries.push({
      key: `mark-${group.pieces[0].markIndex}`,
      text,
      color: group.color,
      note: Boolean(group.pieces[0].note),
      noteText: clipDrawerNote(group.pieces[0].note),
      where: heading?.title || "",
      anchor: trimNoteAnchor({
        offset: group.offset,
        source: group.pieces[0].inner,
        text,
        deckId: state.deckId,
        deckTitle: state.deckTitle
      }),
      // markCount is what revealNoteMark tests before it will use the exact
      // path: if the rendered view holds a different number of marks than the
      // source does, the ordinal cannot be trusted and it falls back to a text
      // search. So it is carried, not recomputed by the caller.
      locator: { markIndex: group.pieces[0].markIndex, markCount: raw.length }
    });
  });
  return entries;
}

// The PDF's own highlights, in reading order — page first, then down the page,
// then left to right within a line (documentHighlightsInReadingOrder).
//
// Not merged by line, unlike the panel's rows. The panel merges because three
// highlights on one line of a paper made three previews of overlapping
// fragments and three "Go to" buttons that all scrolled to the same place; a
// drawer row is one line of text with one colour chip, so the same three read
// as three things you marked, which is what they are.
export function documentHighlightEntries() {
  // One parse for the whole list, not one per record — see the same note in
  // collectHighlightEntries. documentHighlightNote() re-reads the fenced block
  // out of state.notes each time it is called, which turns listing a paper's
  // highlights into quadratic work in how many there are.
  const notes = readHighlightNotes(state.notes || "");
  return documentHighlightsInReadingOrder().map((record) => ({
    key: `doc-${record.id}`,
    // documentHighlightLabel, so a region drawn round a figure is listed as
    // "Region · page 12" rather than as a blank row — which in a list is
    // indistinguishable from a bug.
    text: documentHighlightLabel(record),
    color: record.color,
    note: Boolean(notes.get(record.id)),
    noteText: clipDrawerNote(notes.get(record.id)),
    where: record.page ? `p. ${record.page}` : "",
    anchor: {
      pdf: record.anchor || { page: record.page, item: 0, ch: 0 },
      quads: record.quads,
      page: record.page,
      text: documentHighlightLabel(record),
      deckId: state.deckId,
      deckTitle: state.deckTitle
    },
    locator: { highlightId: record.id }
  }));
}
