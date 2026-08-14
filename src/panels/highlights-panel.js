// Every highlight in the deck, grouped and shown with its sentence.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { LIST_MARKER_RE, MARK_CLOSE_TAG, markOpenTag } from "../format/highlight.js?v=__BUILD__";
import { notesAnchorPlainText, scheduleNoteJump } from "../notes/anchors.js?v=__BUILD__";
import { clozeCleanUnit, clozeUnitAt, clozeUnitIndex } from "./cloze-panel.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";

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
export const HIGHLIGHT_SCAN_RE = /<mark(?:\s+data-color="([a-z]+)")?>([\s\S]+?)<\/mark>/g;

// What can legally sit between two adjacent <mark>s that wrapAcrossBlocks
// produced from ONE highlight action: nothing but the block boundary itself —
// a blank line, or a newline plus the next list item's own "- "/"1. " marker.
// Real note content between two marks (including a non-highlighted list item)
// is always more than this, so it never matches and those stay separate rows.
export const HIGHLIGHT_GROUP_GAP_RE = /^\n+(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?$/;

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

// A highlight is usually a FRAGMENT of a sentence — a phrase mid-clause, not a
// whole line — and showing only the marked words left the panel full of rows
// that read as gibberish out of context ("eigenvalue problem", "treating a song
// as a list of air pressure readings"). Every part of a row is therefore widened
// to whole sentences: the highlight is shown inside the complete sentence it
// lives in, between the sentence before and the sentence after.
//
// The unit index is the cloze panel's (clozeUnitIndex / clozeUnitAt, which split
// on sentence ends AND newlines and drop table rules): built once per panel
// render rather than per highlight, and searched by bisection. Reusing it keeps
// one definition of "a sentence" for both panels, including the awkward parts —
// a cloze's own punctuation never splits a unit, and a lone |---|---| row is
// never offered as context.
//
// Returns null when no unit covers the highlight (all-whitespace, or a dropped
// table rule), and the caller falls back to the bare marked fragment.
// clozeUnitIndex drops table rules but not code-fence markers, and a lone "```js"
// offered as context opens a block that never closes — swallowing the rest of the
// row into a code block. Neighbours therefore step outward past any unit that
// isn't showable on its own.
export const HIGHLIGHT_CONTEXT_FENCE_RE = /^\s*(?:```|~~~)/;

export function highlightContextUnit(units, index, step) {
  for (let i = index + step; i >= 0 && i < units.length; i += step) {
    const text = clozeCleanUnit(units[i].text);
    if (text && !HIGHLIGHT_CONTEXT_FENCE_RE.test(text)) return text;
  }
  return "";
}

export function highlightSentenceParts(units, source, group) {
  const first = clozeUnitAt(units, group.pieces[0].start);
  if (first === -1) return null;
  // A highlight can run past the end of its own sentence (a drag across two of
  // them, or across a block boundary), so the closing unit is looked up
  // separately and everything between the two is kept.
  const lastFrom = clozeUnitAt(units, Math.max(group.pieces[0].start, group.end - 1));
  const last = lastFrom === -1 ? first : Math.max(first, lastFrom);
  const cur = source.slice(units[first].start, units[last].end);
  // A slice that ends between a <mark> and its </mark> would render as an
  // element the browser closes at the end of the row, highlighting all the
  // context after it. Only reachable if the closing tag's own unit was dropped
  // (a table rule), so the cheap answer is to decline and let the caller fall
  // back to the bare fragment rather than to widen and guess.
  if ((cur.match(/<mark\b/g) || []).length !== (cur.match(/<\/mark>/g) || []).length) return null;
  return {
    // Raw source, not a rebuilt fragment: the <mark> tags keep their colours and
    // each line keeps its own list marker / quote / heading prefix, so a
    // highlighted bullet still renders as a bullet here.
    cur,
    // Neighbours are normalised the way the cloze panel normalises its side
    // context — a lone table row becomes "a · b", a heading loses its hashes —
    // because a fragment of a construct is not valid standalone markdown.
    prev: highlightContextUnit(units, first, -1),
    next: highlightContextUnit(units, last, 1)
  };
}

// One entry per highlight: the complete sentence it sits in (rendered as-is in
// the Highlights tab, not flattened to plain text or cropped — see
// renderHighlightsPanel), the sentences either side of it, and a
// trimNoteAnchor-shaped anchor (offset + exact source span + plain text) so
// "Go to →" can reuse scheduleNoteJump/revealNoteAnchor exactly as the
// note-origin and cloze-jump features already do — no separate jump logic.
//
// `markIndex`/`markCount` are what make the jump EXACT: see revealNoteMark. The
// anchor is still carried for the raw editor and as the fallback.
//
// Highlighting a selection that crosses a paragraph or list-item boundary
// (wrapAcrossBlocks, see makeHighlightFromSelection) leaves several adjacent
// <mark> tags behind — one per block, because a single one can't legally span
// a boundary. Without the grouping pass below, that ONE highlight action
// showed up here as three separate rows. Adjacent same-colour matches
// separated by nothing but boundary syntax (HIGHLIGHT_GROUP_GAP_RE) are
// merged back into one entry, matching what the user actually did — and each
// piece's own list marker (if it had one) is restored so a highlighted list
// still LOOKS like a list here, not three plain-text lines.
export function collectDeckHighlights() {
  const source = state.notes || "";
  const raw = [];
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    const color = m[1] || MARK_HIGHLIGHT_DEFAULT;
    const inner = m[2];
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

  // One pass for the whole note, shared by every row below — see
  // highlightSentenceParts, and clozeUnitIndex's own comment for why this is
  // built once rather than per highlight.
  const units = clozeUnitIndex(source);

  const items = [];
  groups.forEach((group) => {
    const parts = highlightSentenceParts(units, source, group);
    // Fallback only: no sentence unit covers this highlight. Marks are reapplied
    // (not just the bare inner text) so a highlight's own colour still shows
    // here, and each piece's list marker is restored so a highlighted list still
    // LOOKS like a list rather than three plain-text lines.
    const markdown = parts ? parts.cur : group.pieces.reduce((acc, piece, i) => {
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
    items.push({
      markdown,
      prevSentence: parts ? parts.prev : "",
      nextSentence: parts ? parts.next : "",
      markIndex: group.pieces[0].markIndex,
      markCount: raw.length,
      anchor: trimNoteAnchor({ offset: group.offset, source: group.pieces[0].inner, text, deckId: state.deckId, deckTitle: state.deckTitle })
    });
  });
  return items;
}

// Redraws the Highlights tab from scratch — cheap enough to just always
// rebuild (same choice collectDeckClozes/renderClozePanel already make)
// rather than diffing, and it only runs when that tab is actually opened.
// Each row renders its markdown fragment exactly like the notes view does —
// bold/links/images/lists intact, nothing flattened to plain text or cropped
// with an ellipsis — via the same synchronous safe-HTML pass renderMarkdown
// itself is built on (markdownToSafeHtml), since a highlight preview is
// always short enough not to need that function's viewport-deferral machinery.
// The neighbouring source lines are rendered the same way, dimmed and clamped by
// CSS (never truncated as a string — cutting markdown mid-syntax renders broken
// output), so a row can be recognised without opening the note.
// The markdown each pending context node is waiting to render, keyed by the node
// so nothing large ends up in a dataset attribute.
export const pendingHighlightContext = new WeakMap();

export let highlightContextObserver = null;

// A context line, left EMPTY until it is near the viewport.
//
// Each of these is a full marked + DOMPurify pass, and there are two per
// highlight on top of the preview — so a note with a couple of hundred
// highlights paid six hundred parses on the single tap that opens this panel,
// nearly all of them for rows nobody had scrolled to yet.
export function highlightContextNode(markdown) {
  const node = document.createElement("div");
  node.className = "highlight-ctx is-side rendered";
  if (!highlightContextObserver && typeof IntersectionObserver !== "undefined") {
    highlightContextObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        renderPendingHighlightContext(entry.target);
      });
    }, { rootMargin: "600px 0px" });
  }
  if (!highlightContextObserver) {
    node.innerHTML = markdownToSafeHtml(markdown);
    return node;
  }
  pendingHighlightContext.set(node, markdown);
  highlightContextObserver.observe(node);
  return node;
}

export function renderPendingHighlightContext(node) {
  const markdown = pendingHighlightContext.get(node);
  if (markdown == null) return;
  pendingHighlightContext.delete(node);
  node.innerHTML = markdownToSafeHtml(markdown);
}

export function renderHighlightsPanel() {
  const list = el.highlightsList;
  if (!list) return;
  // Rows from the previous render are about to be discarded; drop their
  // observations rather than leaving the observer holding detached nodes.
  highlightContextObserver?.disconnect();
  list.innerHTML = "";
  const items = collectDeckHighlights();
  if (el.highlightsEmpty) el.highlightsEmpty.hidden = items.length > 0;
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "highlight-row";
    // The three stacked lines share one column so the jump button still sits
    // BESIDE the highlight rather than under the context below it.
    const body = document.createElement("div");
    body.className = "highlight-body";
    const preview = document.createElement("div");
    preview.className = "highlight-preview rendered";
    preview.innerHTML = markdownToSafeHtml(item.markdown);
    if (item.prevSentence) body.appendChild(highlightContextNode(item.prevSentence));
    body.appendChild(preview);
    if (item.nextSentence) body.appendChild(highlightContextNode(item.nextSentence));
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "highlight-jump-btn";
    jumpBtn.title = "Go to this highlight in the notes";
    jumpBtn.setAttribute("aria-label", "Go to this highlight in the notes");
    jumpBtn.textContent = "Go to →";
    jumpBtn.addEventListener("click", () =>
      scheduleNoteJump(item.anchor, undefined, { markIndex: item.markIndex, markCount: item.markCount })
    );
    row.append(body, jumpBtn);
    list.appendChild(row);
  });
}
