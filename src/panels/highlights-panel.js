// Every highlight in the deck, grouped and shown with its sentence.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { HIGHLIGHT_GROUP_GAP_RE, HIGHLIGHT_SCAN_RE, LIST_MARKER_RE, MARK_CLOSE_TAG, markOpenTag } from "../format/highlight.js?v=__BUILD__";
import { highlightNoteResolver, setHighlightNoteAt } from "../format/highlight-notes.js?v=__BUILD__";
import { renderTargetConfig } from "../format/render-toolbar.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls } from "../images/surface-controls.js?v=__BUILD__";
import { notesAnchorPlainText, scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { headingForOffset, headingIndexFor } from "../notes/chapters.js?v=__BUILD__";
import { openHighlightNoteEditor } from "../notes/highlight-note-editor.js?v=__BUILD__";
import { clozeCleanUnit, clozeUnitAt, clozeUnitIndex } from "./cloze-panel.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";

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
export function scanHighlightGroups(source) {
  const raw = [];
  // Parsed at most once for the whole scan — see highlightNoteResolver.
  const noteTextFor = highlightNoteResolver(source);
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

export function collectDeckHighlights() {
  const { source, raw, groups, units } = scanHighlightGroups(state.notes || "");
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
export function collectDeckHighlightsForExport({ contextLines = 0, includeChapter = true, includeNotes = true } = {}) {
  const { source, groups, units } = scanHighlightGroups(state.notes || "");
  const headings = includeChapter ? headingIndexFor(source) : null;
  const items = [];
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
    items.push({
      markdown,
      color: group.color,
      note: includeNotes ? group.pieces[0].note : null,
      before,
      after,
      chapter: chapter?.title || null
    });
  });
  return items;
}

// Redraws the Highlights tab from scratch — cheap enough to just always
// rebuild (same choice collectDeckClozes/renderClozePanel already make)
// rather than diffing, and it only runs when that tab is actually opened.
// Each row renders its markdown fragment through the FULL pipeline
// (renderMarkdown), not the bare marked+DOMPurify pass markdownToSafeHtml
// gives you — bold/links/lists round-trip through either, but LaTeX and
// images do not: KaTeX rendering and swapping a queued-offline image's
// recall-img: placeholder for a loadable blob: URL both happen in
// enhanceRenderedMarkdown/hydrateLocalImages, which markdownToSafeHtml never
// runs (it's only the marked+DOMPurify half renderMarkdown itself is BUILT
// on, not the whole pipeline — a highlight containing math or a
// still-uploading image rendered as a raw "$…$" or a broken image icon
// without this). renderMarkdown is async and every non-notes/card container
// it's given (this one included) is treated as uncached — see
// isCachedRenderSurface — so this is the same call the Quick Notes board and
// the paste preview already make for exactly this reason.
// No pre/post context line any more — see collectDeckHighlights/
// highlightUnitSpan: the highlighted line is enough, and export (with its own
// opt-in context-size setting) is where surrounding lines belong now.
export function renderHighlightsPanel() {
  const list = el.highlightsList;
  if (!list) return;
  list.innerHTML = "";
  const rows = collectDeckHighlights();
  if (el.highlightsEmpty) el.highlightsEmpty.hidden = rows.length > 0;
  // Every preview/note body is rendered AFTER the whole list is in the
  // document (below), not inline as each row is built — a mermaid diagram
  // inside a highlight needs real layout to size itself against, which a
  // still-detached node doesn't have.
  const toRender = [];
  rows.forEach((item) => {
    const row = document.createElement("div");
    row.className = "highlight-row";
    const body = document.createElement("div");
    body.className = "highlight-body";
    const preview = document.createElement("div");
    preview.className = "highlight-preview rendered";
    body.appendChild(preview);
    toRender.push([preview, item, "preview"]);
    // Any attached note (see format/highlight-notes.js) renders under the
    // highlight, distinguished as commentary rather than the highlighted
    // text itself — labelled with an ordinal only when the row holds more
    // than one highlight (see the same-line merge in collectDeckHighlights).
    item.marks.forEach((mark, i) => {
      if (!mark.note) return;
      const noteBlock = document.createElement("div");
      noteBlock.className = "highlight-note";
      if (item.marks.length > 1) {
        const label = document.createElement("div");
        label.className = "highlight-note-label";
        label.textContent = `Note on highlight ${i + 1}`;
        noteBlock.appendChild(label);
      }
      const noteBody = document.createElement("div");
      noteBody.className = "highlight-note-body rendered";
      noteBlock.appendChild(noteBody);
      body.appendChild(noteBlock);
      toRender.push([noteBody, mark, "note"]);
    });
    // Usually one mark, one pair of buttons. A row that merged several
    // same-line highlights (see collectDeckHighlights) gets one "Go to" +
    // "Note" pair per mark so each is still individually reachable.
    const jumps = document.createElement("div");
    jumps.className = "highlight-jumps";
    item.marks.forEach((mark, i) => {
      const actions = document.createElement("div");
      actions.className = "highlight-mark-actions";
      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.className = "highlight-jump-btn";
      const jumpLabel = item.marks.length > 1 ? `Go to highlight ${i + 1} of ${item.marks.length} in the notes` : "Go to this highlight in the notes";
      jumpBtn.title = jumpLabel;
      jumpBtn.setAttribute("aria-label", jumpLabel);
      jumpBtn.textContent = item.marks.length > 1 ? `Go to → (${i + 1})` : "Go to →";
      jumpBtn.addEventListener("click", () =>
        scheduleNoteJump(mark.anchor, { patient: true }, { markIndex: mark.markIndex, markCount: mark.markCount })
      );
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      noteBtn.className = "highlight-note-btn";
      noteBtn.classList.toggle("has-note", Boolean(mark.note));
      const noteLabel = mark.note ? "Edit the note on this highlight" : "Add a note to this highlight";
      noteBtn.title = noteLabel;
      noteBtn.setAttribute("aria-label", noteLabel);
      noteBtn.innerHTML = "&#9998;";
      noteBtn.addEventListener("click", () =>
        openHighlightNoteEditor(mark.markIndex, noteBtn.getBoundingClientRect(), mark.note)
      );
      actions.append(jumpBtn, noteBtn);
      jumps.appendChild(actions);
    });
    row.append(body, jumps);
    list.appendChild(row);
  });
  toRender.forEach(([container, payload, kind]) => {
    if (kind === "preview") renderRowPreviewWithImageResize(container, payload);
    else if (kind === "note") renderNoteBodyWithImageResize(container, payload);
    else renderMarkdown(container, payload);
  });
}

// A highlight preview's image is a real image in state.notes (item.markdown
// is a literal slice of it — see highlightUnitSpan), so it gets the same
// corner-drag resize/delete grip the main notes editor gives one, committing
// straight back into state.notes at the slice's own [rawStart, rawEnd) — not
// just a read-only summary. Only when the row resolved to a real line/unit
// (item.span, which carries rawStart/rawEnd): the no-line-unit fallback
// markdown (see collectDeckHighlights) isn't a literal source slice, so
// there is nowhere well-defined to write a resize back to and the row is
// left as a plain (Zoom-only) preview.
//
// enhanceSurfaceImageControls/enhanceSurfaceDiagramControls only need
// something shaped like a render target — view + getSource/setSource/
// rerender — not one of the app's three hardcoded surfaces (see the same
// pattern in notes/highlight-note-editor.js). Scoping BOTH the surface's
// view (this row's own preview container, holding only its own image(s))
// AND its source (item.markdown, not the whole note) to the same slice is
// what makes the shell↔image-token matching inside
// enhanceSurfaceImageControls valid: that matching assumes its `view` and
// its `getSource()` describe the same document walked in the same order,
// which a lone row's container and the FULL state.notes would not.
function renderRowPreviewWithImageResize(preview, item) {
  if (!item.span) {
    renderMarkdown(preview, item.markdown);
    return;
  }
  const notesConfig = renderTargetConfig("notes");
  const rowSurface = {
    view: preview,
    getSource: () => item.markdown,
    setSource: (newSlice) => {
      const notes = state.notes || "";
      const updated = notes.slice(0, item.span.rawStart) + newSlice + notes.slice(item.span.rawEnd);
      notesConfig.setSource(updated); // pushNotesUndo + state.notes write + raw-editor/history sync
      item.span.rawEnd = item.span.rawStart + newSlice.length;
      item.markdown = newSlice;
    },
    rerender: () => {
      notesConfig.rerender(); // keeps the actual Notes tab in sync even while it's off-screen
      renderRowPreviewWithImageResize(preview, item);
    }
  };
  renderMarkdown(preview, item.markdown).then(() => {
    enhanceSurfaceImageControls(rowSurface);
    enhanceSurfaceDiagramControls(rowSurface);
  });
}

// The note-over-highlight popup already gets this (src/notes/
// highlight-note-editor.js) — this is the SAME resize/delete for the exact
// same note text, just reached from its read-only-looking summary in the
// panel instead of opening the popup first. `mark.note` is this note's own
// self-contained markdown (not a slice of anything else), so — same
// reasoning as renderRowPreviewWithImageResize — scoping the surface's view
// to just this noteBody and its source to just this note text keeps
// enhanceSurfaceImageControls' shell↔token matching valid.
//
// setSource commits through setHighlightNoteAt, which (like any highlight
// edit) calls notifyHighlightsChanged() and rebuilds the WHOLE panel — so by
// the time rebuildSurfaceFromTokens's own rerender() call would run, this
// noteBody has already been discarded in favour of a freshly rendered one.
// rerender is therefore a deliberate no-op here; the real refresh already
// happened.
function renderNoteBodyWithImageResize(noteBody, mark) {
  const noteSurface = {
    view: noteBody,
    getSource: () => mark.note || "",
    setSource: (newText) => {
      setHighlightNoteAt(mark.markIndex, newText);
      mark.note = newText;
    },
    rerender: () => {}
  };
  renderMarkdown(noteBody, mark.note).then(() => {
    enhanceSurfaceImageControls(noteSurface);
    enhanceSurfaceDiagramControls(noteSurface);
  });
}
