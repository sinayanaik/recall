// Every highlight in the deck, grouped and shown with its sentence.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { HIGHLIGHT_GROUP_GAP_RE, HIGHLIGHT_SCAN_RE, LIST_MARKER_RE, MARK_CLOSE_TAG, markOpenTag } from "../format/highlight.js?v=__BUILD__";
import { highlightNoteResolver, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { renderTargetConfig } from "../format/render-toolbar.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { notesAnchorPlainText, scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { headingForOffset, headingIndexFor } from "../notes/chapters.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { clozeCleanUnit, clozeUnitAt, clozeUnitIndex } from "./cloze-panel.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
import { renderHighlightsEditor } from "./highlights-editor.js?v=__BUILD__";
import { DOCUMENT_NOTE_HANDLERS, documentExcerptLabel, documentHighlightLabel, documentHighlightNote, documentHighlightsInReadingOrder, isPdfDeck, sameDocumentLine, setDocumentHighlightNote } from "../documents/pdf-highlights.js?v=__BUILD__";
import { currentPdfDocument, renderRegionThumbnail } from "../documents/pdf-view.js?v=__BUILD__";

// ── Highlights view ────────────────────────────────────────────────────────
// A highlight is a literal <mark>…</mark> pair sitting in state.notes — same
// authored-in-source approach as {{cloze}}, which is what already makes it
// render correctly (DOMPurify's default allowlist includes <mark>, no
// SANITIZE_CONFIG change needed) and round-trip out of a selection (the
// existing "keep-mark" Turndown rule). There is deliberately no separate
// stored list: collectDeckHighlights, like collectDeckClozes above, is fully
// derived from state.notes on every call, so an edit made in the raw editor
// (typing <mark> by hand, or deleting one) can never drift out of sync with
// what the Highlights tab shows.
// data-color (see MARK_HIGHLIGHT_COLORS) makes the open tag's length variable,
// so the offset below is measured off the actual match rather than a fixed
// "<mark>".length constant — a coloured highlight would otherwise report an
// anchor that starts a few characters into its own text. Colour is captured
// (not just detected) so adjacent matches can be compared when grouping below.
// HIGHLIGHT_SCAN_RE/HIGHLIGHT_GROUP_GAP_RE now live in format/highlight.js,
// alongside markOpenTag (the code that WRITES a <mark> open tag) — imported
// above rather than duplicated, since format/highlight-edit.js needs the same
// pair to address a mark by ordinal.

// wrapAcrossBlocks always keeps a list item's own marker OUTSIDE the mark
// (see its comment for why one inside breaks marked's list parsing), so a
// mark's captured `inner` text never knows it was ever a bullet — rendering
// `inner` alone would show plain text where the note shows a list. If the
// mark starts exactly where its line's own marker ends (nothing else on the
// line before it), that marker is captured here so the preview can put the
// bullet back. Returns null for a highlight that's a sub-span of a line
// (marker, if any, isn't immediately adjacent) — those render as plain text,
// which is correct: they were never "the whole item" to begin with.
export function precedingListMarker(source, start) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  const match = LIST_MARKER_RE.exec(prefix);
  return match && match[0].length === prefix.length ? prefix : null;
}

// A highlight is usually a FRAGMENT of a line — a phrase mid-clause, not the
// whole thing — and showing only the marked words left the panel full of rows
// that read as gibberish out of context ("eigenvalue problem", "treating a song
// as a list of air pressure readings"). Each row is therefore widened to the
// whole LINE it lives in (just the line — no sentence-before/sentence-after
// context; that used to double as export context, which is now the export
// dialog's own, opt-in "lines before/after" setting — see src/export/pdf.js).
//
// The unit index is the cloze panel's (clozeUnitIndex / clozeUnitAt, which
// split on sentence ends AND newlines and drop table rules): built once per
// panel render rather than per highlight, and searched by bisection. Reusing
// it keeps one definition of "a line/sentence" for both panels.
//
// Returns null when no unit covers the highlight (all-whitespace, or a
// dropped table rule), and the caller falls back to the bare marked fragment.
export function highlightUnitSpan(units, source, group) {
  const first = clozeUnitAt(units, group.pieces[0].start);
  if (first === -1) return null;
  // A highlight can run past the end of its own line (a drag across two of
  // them, or across a block boundary), so the closing unit is looked up
  // separately and everything between the two is kept.
  const lastFrom = clozeUnitAt(units, Math.max(group.pieces[0].start, group.end - 1));
  const last = lastFrom === -1 ? first : Math.max(first, lastFrom);
  const cur = source.slice(units[first].start, units[last].end);
  // A slice that ends between a <mark> and its </mark> would render as an
  // element the browser closes at the end of the row, highlighting all the
  // text after it. Only reachable if the closing tag's own unit was dropped
  // (a table rule), so the cheap answer is to decline and let the caller fall
  // back to the bare fragment rather than to widen and guess.
  if ((cur.match(/<mark\b/g) || []).length !== (cur.match(/<\/mark>/g) || []).length) return null;
  // Raw source, not a rebuilt fragment: the <mark> tags keep their colours and
  // the line keeps its own list marker / quote / heading prefix, so a
  // highlighted bullet still renders as a bullet here — including every OTHER
  // highlight already sitting in the same line/unit, which is exactly what
  // lets collectDeckHighlights merge same-line highlights into one row below
  // instead of rendering that line twice.
  //
  // rawStart/rawEnd (the exact [start,end) `cur` was sliced from) are what
  // let an image inside a row be resized in place — see the image-resize
  // surface built in renderHighlightsPanel, which splices a commit straight
  // back into state.notes at this span.
  return { cur, first, last, rawStart: units[first].start, rawEnd: units[last].end };
}

// Kept for the highlights EXPORT feature (src/export/pdf.js /
// src/export/run.js), which offers pre/post context as an opt-in,
// user-sized setting rather than something every row always carries. Steps
// outward from a unit past anything that can't stand alone (a lone fence
// marker would open a code block that never closes).
export const HIGHLIGHT_CONTEXT_FENCE_RE = /^\s*(?:```|~~~)/;

export function highlightContextUnit(units, index, step) {
  for (let i = index + step; i >= 0 && i < units.length; i += step) {
    const text = clozeCleanUnit(units[i].text);
    if (text && !HIGHLIGHT_CONTEXT_FENCE_RE.test(text)) return text;
  }
  return "";
}

// One entry per ROW — usually one highlight, but see the same-line merge
// below. `marks` carries one { markIndex, markCount, anchor } per underlying
// highlight in the row, so "Go to →" still reaches each one individually
// even when several are shown as a single line.
//
// `markIndex`/`markCount` are what make the jump EXACT: see revealNoteMark.
// The anchor is still carried for the raw editor and as the text-search
// fallback.
//
// Highlighting a selection that crosses a paragraph or list-item boundary
// (wrapAcrossBlocks, see makeHighlightFromSelection) leaves several adjacent
// <mark> tags behind — one per block, because a single one can't legally span
// a boundary. Without the grouping pass below, that ONE highlight action
// showed up as three separate rows. Adjacent same-colour matches separated by
// nothing but boundary syntax (HIGHLIGHT_GROUP_GAP_RE) are merged back into
// one GROUP first (one highlight action, however many <mark>s it left behind)
// — and each piece's own list marker (if it had one) is restored so a
// highlighted list still LOOKS like a list, not several plain-text lines.
//
// A SECOND pass then merges adjacent groups into one ROW when they land in
// the same source unit (line/sentence) — two separately-made highlights that
// both happen to sit on one line no longer render that line twice.
//
// Shared by collectDeckHighlights (the panel) and collectDeckHighlightsForExport
// (src/export/pdf.js) — the scan-and-adjacency-group pass is the same for
// both; they differ only in what they do with a group afterwards (the panel
// additionally merges groups that land on the same line into one row; export
// wants every highlight as its own entry, with its own configurable amount of
// surrounding context).
// `noteSource` is where the NOTES are looked up, and it is a separate argument
// because it has to be a different string from the one being scanned.
//
// Every caller scans readerNotesBody(state.notes) — the note with its
// `<!--recall:highlight-notes-->` tail sliced off — and it must: a <mark> a
// reader typed inside a highlight's own note is not a highlight of the document,
// and counting it breaks the exact-ordinal jump for every other row (see
// collectNoteHighlightRows). But the tail is also where every note's TEXT lives,
// so resolving a mark's data-note id against that same sliced string found
// nothing, every time. `note` came back null for every highlight in a markdown
// deck: the Highlights panel showed the reader none of their own notes, and its
// ✎ opened an empty editor over a note that was really there.
//
// Defaulting to `source` keeps a caller that has only one string honest — it is
// asking about a note whose tail is still attached.
export function scanHighlightGroups(source, noteSource = source) {
  const raw = [];
  // Parsed at most once for the whole scan — see highlightNoteResolver.
  const noteTextFor = highlightNoteResolver(noteSource);
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    const color = m[1] || MARK_HIGHLIGHT_DEFAULT;
    const noteRef = m[2] || null;
    const inner = m[3];
    const openTagLength = m[0].length - inner.length - MARK_CLOSE_TAG.length;
    const start = m.index;
    raw.push({
      // Ordinal among ALL marks in the source, which is also this mark's
      // position among the rendered <mark> elements (revealNoteMark).
      markIndex: raw.length,
      start,
      end: start + m[0].length,
      offset: start + openTagLength,
      color,
      inner,
      // Only ever set on a group's FIRST piece (see format/highlight-notes.js).
      // The attribute is a reference — an "hn-…" id resolved against the note's
      // own "Highlight Notes" section (or, for an old annotation, inline
      // base64) — so it is looked up here rather than read as text.
      note: noteRef ? noteTextFor(noteRef) || null : null,
      marker: precedingListMarker(source, start)
    });
  }

  const groups = [];
  raw.forEach((entry) => {
    const last = groups[groups.length - 1];
    if (last && last.color === entry.color && HIGHLIGHT_GROUP_GAP_RE.test(source.slice(last.end, entry.start))) {
      last.end = entry.end;
      last.pieces.push(entry);
    } else {
      groups.push({ offset: entry.offset, end: entry.end, color: entry.color, pieces: [entry] });
    }
  });

  // One pass for the whole note, shared by every group below — see
  // highlightUnitSpan, and clozeUnitIndex's own comment for why this is built
  // once rather than per highlight.
  const units = clozeUnitIndex(source);

  return { source, raw, groups, units };
}

// ── A PDF deck's highlights, as the same rows ───────────────────────────────
//
// The panel, the exports and the highlights view all consume ONE row shape, and
// they consume it from this function — so a document highlight becomes a row
// here rather than becoming a second panel. Every one of those consumers then
// works untouched.
//
// The differences from the markdown branch are the two that are real: there is
// no source unit to slice (a PDF has no markdown, so `span` is null and
// `markdown` is the highlight's own captured text), and the mark is addressed
// by id rather than by ordinal.
// The picture for one region row, appended synchronously as a placeholder and
// filled in when the render resolves. Asynchronous by necessity — rasterising a
// page is a promise — and deliberately not awaited by the panel: forty rows
// would otherwise appear one page-render at a time.
//
// The label is not a loading state; it is the ANSWER whenever there is no open
// document to render from, and it is replaced only if a picture actually
// arrives. So an offloaded deck's highlights list reads correctly and never
// flickers through an empty box.
export function addRegionPreview(body, record) {
  const label = document.createElement("span");
  label.className = "highlight-region-label";
  // Always "Region · page N", never the record's text: whatever words the box
  // happened to cover are already the row's own preview directly below this, and
  // saying them twice makes the row read as two highlights.
  // The same glyph the region-select button in the control row wears, and from
  // the same Unicode block as the Cards tab's ▢ — a dotted-square character
  // would have read better and is not reliably drawn.
  label.textContent = `▣ Region · page ${record.page}`;
  body.appendChild(label);
  if (!currentPdfDocument()) return;
  renderRegionThumbnail(record).then((url) => {
    if (!url || !label.isConnected) return;
    const img = document.createElement("img");
    img.className = "highlight-region-thumb";
    img.src = url;
    img.alt = `Region highlighted on page ${record.page}`;
    label.replaceWith(img);
  }).catch(() => { /* the label stays, which is a correct answer on its own */ });
}

export function collectDocumentHighlightRows() {
  const rows = [];
  documentHighlightsInReadingOrder().forEach((record) => {
    const row = documentRowFor(record);
    // ── One line, one row, one "Go to" ──────────────────────────────────────
    //
    // Every PDF record used to become its own row, because the merge test below
    // (in collectNoteHighlightRows) requires a markdown `span` on both rows and
    // a document highlight has none. So three highlights on one line of a paper
    // were three rows, three previews of overlapping fragments and three "Go
    // to" buttons that all scrolled to the same place — which is what "if there
    // are multiple highlights in a single line then one goto is sufficient"
    // was about.
    //
    // Merged on the geometry the file already carries (sameDocumentLine), so a
    // "line" here means a line of the paper rather than anything this panel had
    // to guess. Deliberately a LINE and not a paragraph: a paragraph of a
    // two-column paper is a dozen lines and half a screen, and collapsing that
    // far would hide which of them was actually marked.
    //
    // Unconditional, unlike the markdown path, which splits a merged row again
    // the moment either highlight has a note. That rule exists there because
    // its rows label notes positionally ("Note on highlight 2") and two notes
    // under one line are then ambiguous. These rows label each note with its
    // own excerpt instead, so there is nothing to be ambiguous about and no
    // reason to duplicate the line.
    const previous = rows[rows.length - 1];
    if (previous?.lineRecord && sameDocumentLine(previous.lineRecord, record)) {
      previous.marks.push(row.marks[0]);
      // The row's own text grows to cover the line's whole marked run, so the
      // preview is not just the first highlight's words with two more "Go to"s
      // beside it.
      if (row.markdown && !previous.markdown.includes(row.markdown)) {
        previous.markdown = `${previous.markdown} … ${row.markdown}`;
      }
      // A region keeps its picture even when it shares a line with a text
      // highlight — the thumbnail is the row's most useful content.
      if (!previous.region && row.region) previous.region = row.region;
      return;
    }
    rows.push(row);
  });
  return rows;
}

// One row for one record, before any same-line merging.
function documentRowFor(record) {
  {
    // A region drawn round a photograph has no words in it at all, and a blank
    // row in a list of highlights is indistinguishable from a bug — so it is
    // named by where it is. (A region round a boxed equation or a table usually
    // DOES pick up text, and is then listed by that text like anything else.)
    const text = String(record.text || "").trim() || documentHighlightLabel(record);
    return {
      region: record.kind === "area" ? record : null,
      // Rendered as plain text: it came out of a PDF, so there is no markdown
      // in it to interpret, and a paper containing "*" or "_" must not turn
      // half a sentence italic in the panel.
      markdown: text.replace(/([\\`*_{}[\]()#+\-.!])/g, "\\$1"),
      span: null,
      page: record.page,
      // The record this row's line band is measured from, so the caller can ask
      // whether the next highlight shares its line. Not read anywhere else.
      lineRecord: record,
      marks: [{
        // The panel keys a row's actions on `markIndex`; for a document
        // highlight the id IS the key, and every consumer that acts on it goes
        // through the handler sets in src/documents/pdf-highlights.js.
        markIndex: record.id,
        highlightId: record.id,
        markCount: 0,
        page: record.page,
        color: record.color,
        note: documentHighlightNote(record.id) || null,
        // What to CALL this highlight when its note is listed under a row that
        // holds several. A positional "Note on highlight 2" renumbers whenever
        // a neighbour is added or deleted, and on a merged row it is the only
        // thing saying which highlight a note belongs to — so it is the words
        // themselves, which cannot drift.
        excerpt: documentExcerptLabel(text),
        anchor: {
          pdf: record.anchor || { page: record.page, item: 0, ch: 0 },
          quads: record.quads,
          page: record.page,
          text,
          deckId: state.deckId,
          deckTitle: state.deckTitle
        }
      }]
    };
  }
}

export function collectDeckHighlights() {
  // A PDF deck's highlights are coordinates in the file, not <mark>s in the
  // note — but its Notes tab is still an ordinary note the reader may have
  // highlighted too, so both sources are collected rather than one replacing
  // the other.
  if (isPdfDeck()) {
    return [...collectDocumentHighlightRows(), ...collectNoteHighlightRows()];
  }
  return collectNoteHighlightRows();
}

// ── The panel reads the same string the reader is looking at ──────────────
//
// readerNotesBody, not state.notes. The rendered notes view is fed
// readerNotesBody(state.notes) — the note with its `<!--recall:highlight-notes-->`
// tail sliced off (src/notes/notes-view.js, src/format/notes-fence.js) — and
// this panel scanned the whole string, tail included. That was fine for exactly
// as long as the tail could not contain a `<mark>`, and it can: the highlight
// note popup ships the full formatting toolbar, whose Highlight dropdown writes
// a literal <mark> into whatever the reader is typing.
//
// One highlighted word inside one note and the panel goes wrong in three ways
// at once. The mark in the tail becomes a row of its own — a highlight of a
// highlight's note, listed as if it were in the document. `markCount`
// (raw.length) exceeds the number of <mark>s the rendered view actually has,
// which is the exact equality revealNoteMark tests before it will use the fast
// path, so "Go to →" silently degrades to a fuzzy text search for EVERY row in
// the panel, not just the phantom one. And pressing ✎ on the phantom row
// rewrites a <mark> inside the tail, which is how a note ends up attached to
// something that is not a highlight at all.
//
// This is a regression rather than an oversight: the commit that introduced the
// fence moved the rendered view and the raw editor onto readerNotesBody and
// left this file reading state.notes.
export function collectNoteHighlightRows() {
  const notes = state.notes || "";
  const { source, raw, groups, units } = scanHighlightGroups(readerNotesBody(notes), notes);
  const rows = [];
  groups.forEach((group) => {
    const span = highlightUnitSpan(units, source, group);
    // Fallback only: no line unit covers this highlight. Marks are reapplied
    // (not just the bare inner text) so a highlight's own colour still shows
    // here, and each piece's list marker is restored so a highlighted list
    // still LOOKS like a list rather than several plain-text lines.
    const markdown = span ? span.cur : group.pieces.reduce((acc, piece, i) => {
      const markedPiece = markOpenTag(group.color) + piece.inner + MARK_CLOSE_TAG;
      const rendered = piece.marker ? piece.marker + markedPiece : markedPiece;
      if (i === 0) return rendered;
      return acc + (piece.marker ? "\n" : "\n\n") + rendered;
    }, "");
    // The needle is the FIRST piece's own inner text, not the preview markdown:
    // the preview carries <mark> tags and a restored list marker, neither of
    // which appears in the rendered notes, so an anchor built from it could
    // never be found again (that was the "Go to takes me somewhere else" bug —
    // every match failed and the retry loop's proportional estimate is what the
    // reader saw). The first piece is also the right place to land for a
    // highlight that spans several blocks.
    const text = notesAnchorPlainText(group.pieces[0].inner);
    if (!text) return;
    const mark = {
      markIndex: group.pieces[0].markIndex,
      markCount: raw.length,
      note: group.pieces[0].note,
      anchor: trimNoteAnchor({ offset: group.offset, source: group.pieces[0].inner, text, deckId: state.deckId, deckTitle: state.deckTitle })
    };
    const prevRow = rows[rows.length - 1];
    // Same source unit as the row just built (both resolved to a real unit,
    // and it's the SAME one) → this is a second highlight on a line already
    // shown; its <mark> is already part of `markdown` (the unit slice
    // includes every mark inside it), so only the jump target is new.
    //
    // ...UNLESS either highlight carries a note. Merging was only ever about
    // not showing the same bare line twice for no reason — once one of them
    // has its own commentary attached, showing it under a shared "which
    // highlight is this about?" row would be ambiguous, and collapsing two
    // notes under one line reads as one. So a noted highlight always gets its
    // own row (the line renders again, once per instance — duplicated text,
    // but no longer duplicated NOTHING, which is what merging exists to
    // avoid). A highlight without a note still merges into a neighbour that
    // does, since it's the row identity that needs to split, not any
    // particular highlight's content.
    const merges = span && prevRow?.span && prevRow.span.first === span.first && prevRow.span.last === span.last;
    const eitherHasNote = mark.note || prevRow?.marks?.some((m) => m.note);
    if (merges && !eitherHasNote) {
      prevRow.marks.push(mark);
      return;
    }
    rows.push({ markdown, span, marks: [mark] });
  });
  return rows;
}

// Like highlightContextUnit, but collects up to `count` units stepping
// outward instead of just the nearest one — the highlights EXPORT feature
// (src/export/pdf.js/run.js) offers a user-configurable "lines of context"
// size, unlike the panel above (which shows none — see #3/#4's history).
// Returned in natural reading order regardless of which direction it walked.
export function highlightContextUnits(units, index, step, count) {
  const found = [];
  let i = index;
  while (found.length < count) {
    i += step;
    if (i < 0 || i >= units.length) break;
    const text = clozeCleanUnit(units[i].text);
    if (text && !HIGHLIGHT_CONTEXT_FENCE_RE.test(text)) found.push(text);
  }
  return step < 0 ? found.reverse() : found;
}

// One entry per highlight (never merged, unlike collectDeckHighlights' rows —
// export wants every highlight listed, each with its own surrounding
// context) with `before`/`after` arrays of `contextLines` source units
// either side. `contextLines` of 0 (the default, matching what the panel
// itself shows) yields no context at all.
//
// `includeChapter`/`includeNotes` are the export dialog's own keep-or-drop
// toggles (src/export/run.js) — each entry still carries `chapter`/`note` as
// null when its toggle is off, rather than the caller having to know to
// omit them, so every export builder (Markdown/HTML/PDF) reads one shape.
//
// `annotatedOnly` drops every highlight that has no note on it. That is what
// the Document view's "the notes, as one PDF" export means — a reading of what
// you WROTE about the paper, rather than a list of every sentence you happened
// to colour — and it is deliberately independent of `includeNotes`: the filter
// reads the note before that toggle is applied, or asking for "annotated
// highlights, without their notes" would quietly return nothing at all.
export function collectDeckHighlightsForExport({ contextLines = 0, includeChapter = true, includeNotes = true, annotatedOnly = false } = {}) {
  // readerNotesBody for the same reason collectNoteHighlightRows uses it: a
  // <mark> a reader typed into a highlight's own note is not a highlight of the
  // document, and exporting it as one puts a note's fragment in a list of
  // passages from the paper.
  const notes = state.notes || "";
  const { source, groups, units } = scanHighlightGroups(readerNotesBody(notes), notes);
  const headings = includeChapter ? headingIndexFor(source) : null;
  const items = [];
  // A PDF deck's highlights come first, in reading order, and carry their page
  // instead of a chapter — which is what an exported list of passages from a
  // paper has to say to be useful at all. Every export builder reads the same
  // entry shape, so `page` is simply a field they can print.
  if (isPdfDeck()) {
    documentHighlightsInReadingOrder().forEach((record) => {
      const note = documentHighlightNote(record.id) || null;
      if (annotatedOnly && !note) return;
      items.push({
        // documentHighlightLabel, so a region round a figure exports as
        // "Region · page 12" rather than as a blank bullet with a colour on it.
        markdown: documentHighlightLabel(record),
        color: record.color,
        note: includeNotes ? note : null,
        before: [],
        after: [],
        chapter: null,
        page: record.page || null
      });
    });
  }
  groups.forEach((group) => {
    const span = highlightUnitSpan(units, source, group);
    const markdown = span ? span.cur : group.pieces.reduce((acc, piece, i) => {
      const markedPiece = markOpenTag(group.color) + piece.inner + MARK_CLOSE_TAG;
      const rendered = piece.marker ? piece.marker + markedPiece : markedPiece;
      if (i === 0) return rendered;
      return acc + (piece.marker ? "\n" : "\n\n") + rendered;
    }, "");
    const before = span && contextLines > 0 ? highlightContextUnits(units, span.first, -1, contextLines) : [];
    const after = span && contextLines > 0 ? highlightContextUnits(units, span.last, 1, contextLines) : [];
    const chapter = headings ? headingForOffset(headings, group.offset) : null;
    const note = group.pieces[0].note || null;
    if (annotatedOnly && !note) return;
    items.push({
      markdown,
      color: group.color,
      note: includeNotes ? note : null,
      before,
      after,
      chapter: chapter?.title || null
    });
  });
  return items;
}

// ── The Highlights tab's own entries ────────────────────────────────────────
//
// One entry per HIGHLIGHT, never merged — which is the one place this differs
// from collectDeckHighlights' rows, and it differs because the tab is an editor
// now (src/panels/highlights-editor.js). Rows merge two highlights that landed
// on one line so that line is not shown twice; two highlights that each need
// their own note field cannot share a row at all, and a merged one would offer
// a single box for two annotations.
//
// Everything else is the row collection's own machinery, reused rather than
// re-derived: the same scan, the same line-widening, the same anchors, so a
// jump from this tab lands exactly where a jump from anywhere else does.
//
// `group` is what the surface puts a sticky heading on: the page for a
// document highlight, the chapter for a <mark>. A note with no headings in it
// yields "" and the entries simply run on, which is correct — there is nothing
// to group by.
export function collectHighlightEntries() {
  const entries = [];
  if (isPdfDeck()) {
    documentHighlightsInReadingOrder().forEach((record) => {
      const text = String(record.text || "").trim() || documentHighlightLabel(record);
      entries.push({
        highlightId: record.id,
        color: record.color,
        group: record.page ? `Page ${record.page}` : "The document",
        region: record.kind === "area" ? record : null,
        // Rendered as plain text: it came out of a PDF, so there is no markdown
        // in it to interpret, and a paper containing "*" or "_" must not turn
        // half a sentence italic here.
        markdown: text.replace(/([\\`*_{}[\]()#+\-.!])/g, "\\$1"),
        span: null,
        note: documentHighlightNote(record.id) || "",
        anchor: {
          pdf: record.anchor || { page: record.page, item: 0, ch: 0 },
          quads: record.quads,
          page: record.page,
          text,
          deckId: state.deckId,
          deckTitle: state.deckTitle
        },
        locator: { highlightId: record.id }
      });
    });
  }
  const notes = state.notes || "";
  const { source, raw, groups, units } = scanHighlightGroups(readerNotesBody(notes), notes);
  const headings = headingIndexFor(source);
  groups.forEach((group) => {
    const span = highlightUnitSpan(units, source, group);
    const markdown = span ? span.cur : group.pieces.reduce((acc, piece, i) => {
      const markedPiece = markOpenTag(group.color) + piece.inner + MARK_CLOSE_TAG;
      const rendered = piece.marker ? piece.marker + markedPiece : markedPiece;
      if (i === 0) return rendered;
      return acc + (piece.marker ? "\n" : "\n\n") + rendered;
    }, "");
    const text = notesAnchorPlainText(group.pieces[0].inner);
    if (!text) return;
    const heading = headingForOffset(headings, group.offset);
    entries.push({
      markIndex: group.pieces[0].markIndex,
      color: group.color,
      group: heading?.title || "",
      region: null,
      markdown,
      span,
      note: group.pieces[0].note || "",
      anchor: trimNoteAnchor({ offset: group.offset, source: group.pieces[0].inner, text, deckId: state.deckId, deckTitle: state.deckTitle }),
      locator: { markIndex: group.pieces[0].markIndex, markCount: raw.length }
    });
  });
  return entries;
}

// Redraws the Highlights tab.
//
// It used to be a list of rows, each with a "Go to →" and a ✎ that opened a
// popup — so every note took a window to read and a second one to write, and a
// reader working down a paper they had annotated opened and closed forty of
// them. It is a continuous editor now: the highlighted line, then its note
// under it, editable where it sits, grouped by page or by chapter. See
// src/panels/highlights-editor.js, which is src/documents/pdf-notes-view.js
// generalised — that module had already solved this and had put the answer in
// the Notes tab, which is where the reader's own writing belongs.
//
// Cheap enough to just always rebuild (the same choice renderClozePanel makes)
// rather than diffing, and it only runs when this tab is actually open — but
// the editor's own signature guard stops a rebuild that would change nothing,
// which matters now that a note being typed HERE is what triggers the rebuild.
export function renderHighlightsPanel() {
  const list = el.highlightsList;
  if (!list) return;
  const entries = collectHighlightEntries();
  if (el.highlightsEmpty) el.highlightsEmpty.hidden = entries.length > 0;
  renderHighlightsEditor(entries);
}
