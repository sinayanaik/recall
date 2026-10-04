// Highlighting as <mark data-color>, in both the raw and rendered views.
//
// A highlight that spans blocks has to be wrapped per block — one <mark> across
// a paragraph boundary does not survive re-rendering — and list/table prefixes
// have to stay outside the mark or the markup breaks.

import { MARK_HIGHLIGHT_COLORS, MARK_HIGHLIGHT_DEFAULT } from "./highlight-colors.js?v=__BUILD__";
// A cycle — highlight-edit.js imports markGroupSpanAt and markOpenTag from here
// — and the same one highlight-notes.js already crosses for the same binding.
// Safe for the reason given there: notifyHighlightsChanged is a hoisted
// `function` declaration called at runtime, never a top-level `const` read while
// either module body is still evaluating.
import { notifyHighlightsChanged } from "./highlight-edit.js?v=__BUILD__";
// Another cycle of the same kind: code-highlight.js takes markOpenTag and
// MARK_CLOSE_TAG from here, and every binding either side uses is read inside a
// call, never while a module body is evaluating.
import { codeFenceAt, codeFences, highlightCodeSelectionInSource } from "./code-highlight.js?v=__BUILD__";
import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { renderFormatDefaults } from "./render-toolbar.js?v=__BUILD__";
import { ensurePillSelectionCapture, pillSelectionCapture, selectionTargets } from "../notes/selection.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// The raw-editor toolbar's Highlight dropdown reuses the .color-menu circular-
// swatch styling (see styles.css) via data-highlight instead of data-color, so
// it needs its own button markup rather than renderSplitControlHtml's (which
// is shaped for the rendered-view split button, not a plain dropdown).
export function markHighlightSwatchButtonsHtml() {
  return MARK_HIGHLIGHT_COLORS.map(
    (c) => `<button type="button" data-highlight="${c.value}" style="--btn-bg: ${c.swatch};" title="${c.name}"></button>`
  ).join("");
}

// A <mark>, optionally coloured via data-color (see MARK_HIGHLIGHT_COLORS —
// omitted entirely for the default token, so plain old <mark> highlights from
// before colour existed keep matching this and still toggle/recolour fine)
// and optionally carrying a note (data-note — a short "hn-…" id pointing at
// an entry in the note's own "Highlight Notes" section, or, for annotations
// made before that format existed, the old inline base64; see
// format/highlight-notes.js) in that fixed order. The attribute's character
// class allows "-" for the id form as well as base64's own alphabet, so both
// keep matching. A raw <mark> hand-typed
// with the attributes the other way round won't match — same accepted
// limitation as every other canonical-form assumption already made about a
// hand-typed mark (see e.g. Turndown's own canonicalisation, noted in the
// highlight-mark-system history).
export const MARK_OPEN_RE = /<mark(?:\s+data-color="([a-z]+)")?(?:\s+data-note="([A-Za-z0-9+/=-]*)")?>$/;

export const MARK_CLOSE_TAG = "</mark>";

export function markOpenTag(color, note) {
  const attrs = [];
  if (color && color !== MARK_HIGHLIGHT_DEFAULT) attrs.push(` data-color="${color}"`);
  if (note) attrs.push(` data-note="${note}"`); // an id, or a legacy blob being copied through
  return attrs.length ? `<mark${attrs.join("")}>` : "<mark>";
}

// A selection spanning a block boundary can't be wrapped in ONE <mark>: each
// block (see splitPreparedBlocks) is parsed by marked independently, and —
// even setting that aside — inline HTML can't legally straddle two block-
// level elements at all. A <mark> left open at the end of one paragraph gets
// force-closed there by the browser's own HTML parser, and nothing carries it
// into the next one — the back half of the selection silently rendered
// unhighlighted (the "multiline highlight does nothing" bug). Worse for a
// list: a <mark> opened BEFORE a line's "- "/"1. " marker stops marked
// recognising that line as a list item at all — confirmed against real marked
// output — which can turn a bulleted item into a stray paragraph and split
// the list in two, not just fail to highlight it (the "multi-bulletpoint
// highlighting is unreliable" bug). Turndown's list serialisation also means
// a selection starting mid-list can hand back the FIRST item's marker too
// (see asMarkdown in renderedSelectionStrings) — every marker has to be kept
// outside every mark, not just the ones after the first split.
//
// Splitting on blank lines (paragraph/block boundaries) and then, within each
// piece, on every "\n" that starts a new list item — keeping each item's own
// marker outside its mark — makes a highlight that LOOKS continuous across
// paragraphs and list items actually render that way; it's just several
// marks under the hood. Re-selecting that exact span later to toggle it off
// doesn't work yet: locateSelectionInSource's plain-text search can't see
// past the tags this leaves behind — clear each piece individually instead.
// A list marker is not the only line prefix that must stay outside the mark:
// a blockquote's "> " and a heading's "## " are read by marked at exactly the
// same point in exactly the same way, so a <mark> in front of either stops the
// line being a quote/heading at all. A selection that begins at a callout —
// the shape that reaches this code most often, since a whole-passage drag
// usually starts at one — turned the quote into a stray paragraph. Table rows
// get the same treatment for their leading "|".
export const LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

// Nested markers are stripped too ("- 1. text"): a mark opened in front of the
// inner "1. " stops it being a nested list and the marker shows up as text.
export const BLOCK_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:(?:[-*+]|\d+[.)])[ \t]+)*)/;

export const BLOCK_LINE_RE = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|\|)/;

export const HEADING_LINE_RE = /^[ \t]*(?:>[ \t]?)*#{1,6}[ \t]+/;

export const TABLE_ROW_RE = /^[ \t]*(?:>[ \t]?)*\|/;

// Lines that render no text of their own, so there is nothing to highlight and
// wrapping them only turns markup into visible characters: "---", a table's
// "| --- | :-: |" delimiter row, and a code fence.
//
// "=" is in the first alternative for setext headings. A run of "=" under a line
// is what makes that line an H1, and it renders nothing — but it was not matched
// here, so a drag across a setext heading wrapped the underline in a <mark>, the
// line stopped being a heading at all, and the "=" characters appeared as text.
// (Setext H2 uses "-", which the "---" alternative already covered.)
export const NO_TEXT_LINE_RE = /^[ \t]{0,3}(?:(?:[-*_=][ \t]*){3,}|\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?)[ \t]*$/;

// Four spaces (or a tab) of indent starts an indented code block, where marked
// escapes HTML — so a <mark> dropped in shows up as literal "<mark>" text in the
// rendered code, exactly like the fenced case FENCE_LINE_RE already guards. Only
// meaningful after a blank line: an indented CONTINUATION of a list item or a
// wrapped paragraph is ordinary prose and must stay highlightable.
export const INDENTED_CODE_RE = /^(?: {4}|\t)/;

export const FENCE_LINE_RE = /^[ \t]{0,3}(```+|~~~+)/;

export const CELL_TEXT_RE = /^([ \t]*)([\s\S]*?)([ \t]*)$/;

// Fenced code is walked line by line rather than split on blank lines: a fence
// with an empty line in the middle is ONE block that a blank-line split would
// cut in two. Code lines are left verbatim: a drag that runs from prose into a
// code block (or out of one) highlights the prose, and the code keeps its own
// highlights, made inside it (see src/format/code-highlight.js).
//
// `openFence` is the marker of a fence the slice STARTS inside. Without it the
// walk only knew it was in code if the slice held the opening line, so a drag
// from the middle of a block into the paragraph after it read the block's
// CLOSING line as an opener — and left the paragraph after it unhighlighted,
// as "code".
export function wrapAcrossBlocks(source, color, { openFence = null } = {}) {
  const out = [];
  let group = [];
  let fence = openFence;
  // Whether the NEXT indented line would open an indented code block, i.e.
  // whether we are at a block boundary. True at the very start of the slice,
  // and again after every blank line; any content line clears it, so an indented
  // continuation of a paragraph or list item is not mistaken for code.
  let atBlockStart = true;
  let indentedCode = false;
  // Indentation means two different things, and only one of them is code. Inside
  // a list, four spaces after a blank line is the ITEM'S OWN continuation — real
  // prose the reader expects to highlight — not a code block. Getting that
  // backwards would break the commonest selection there is to fix the rarest, so
  // once a list marker has been seen in this slice, indentation is never code.
  let sawListMarker = false;
  const flush = () => {
    if (!group.length) return;
    out.push(wrapKeepingPrefix(group.join("\n"), color));
    group = [];
  };
  source.split("\n").forEach((line) => {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (fence) {
      out.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      return;
    }
    if (fenceMatch) {
      flush();
      out.push(line);
      fence = fenceMatch[1];
      indentedCode = false;
      atBlockStart = false;
      return;
    }
    if (!line.trim() || NO_TEXT_LINE_RE.test(line)) {
      flush();
      out.push(line);
      // A blank line ends an indented code block and opens the next one's door.
      if (!line.trim()) {
        indentedCode = false;
        atBlockStart = true;
      }
      return;
    }
    // Inside an indented code block, or opening one: emit verbatim.
    if (!sawListMarker && INDENTED_CODE_RE.test(line) && (indentedCode || atBlockStart)) {
      flush();
      out.push(line);
      indentedCode = true;
      atBlockStart = false;
      return;
    }
    indentedCode = false;
    atBlockStart = false;
    if (LIST_MARKER_RE.test(line)) sawListMarker = true;
    if (TABLE_ROW_RE.test(line)) {
      // One mark per cell: a single mark spanning the row would swallow the
      // "|" separators that tell marked where the cells are.
      flush();
      out.push(wrapTableRow(line, color));
      return;
    }
    // A list item, heading or quote line starts a block of its own; ordinary
    // wrapped lines share the mark of the run they belong to.
    if (BLOCK_LINE_RE.test(line)) flush();
    group.push(line);
    if (HEADING_LINE_RE.test(line)) flush(); // and whatever follows is a block again
  });
  flush();
  return out.join("\n");
}

// A highlight is a literal <mark>…</mark> pair sitting in source — same regex
// collectDeckHighlights (src/panels/highlights-panel.js) and the mark-edit
// path (src/format/highlight-edit.js) both need, so it's owned here alongside
// the code that WRITES a <mark> open tag (markOpenTag) rather than duplicated.
// data-color/data-note make the open tag's length variable, which is why
// callers that need an offset measure it off the actual match rather than a
// fixed "<mark>".length constant. Capture groups: 1 = colour token, 2 = note
// (an "hn-…" id, or legacy base64 — see format/highlight-notes.js), 3 = inner
// text.
export const HIGHLIGHT_SCAN_RE = /<mark(?:\s+data-color="([a-z]+)")?(?:\s+data-note="([A-Za-z0-9+/=-]*)")?>([\s\S]+?)<\/mark>/g;

// What can legally sit between two adjacent <mark>s that wrapAcrossBlocks
// produced from ONE highlight action: nothing but the block boundary itself —
// a blank line, or a newline plus the next list item's own "- "/"1. " marker.
//
// ── ...and a single newline is NOT one ────────────────────────────────────
//
// This used to be /^\n+(marker)?$/, which accepts a lone "\n". marked runs with
// `breaks: true`, so a lone newline is a line break INSIDE a paragraph, and
// wrapAcrossBlocks never splits a mark there — every line of a paragraph shares
// one mark. So two marks with only "\n" between them were never one action:
// they were two highlights the reader made separately, one ending a line and the
// next starting the line under it. A poem or a mantra, one phrase per line, is
// nothing but that shape. Merged, the second highlight vanished from the
// Highlights pane and the export, its note went with it, and recolouring or
// removing either one did both. See continuesHighlightGroup for the one place a
// lone newline still is a boundary (after a heading).
export const HIGHLIGHT_GROUP_GAP_RE = /^(?:\n(?:[ \t]*\n)+(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?|\n[ \t]*(?:[-*+]|\d+[.)])[ \t]+)$/;

// Whether the mark `next` is a continuation piece of the highlight `prev` ends —
// the one rule every reader of groups shares (scanHighlightGroups, the panel and
// the exports; markGroupSpanAt, recolour, remove and the note writer), so a
// group cannot be one thing in a list and another under an edit.
//
// Both arguments carry { start, end, color } and the mark's raw data-note as
// `noteRef` (scan entries) or `note` (markSpanAt). Three tests:
//   • the same colour — one action writes one colour;
//   • `next` carries no note reference of its own — only a group's FIRST piece
//     ever carries the id (rewriteFirstMarkNote), so a later piece with one is
//     by construction a separate, annotated highlight, and absorbing it is
//     exactly how a note went missing;
//   • nothing between them but a block boundary (HIGHLIGHT_GROUP_GAP_RE), or a
//     lone newline after a HEADING, which wrapAcrossBlocks does flush on and
//     which needs no blank line before the paragraph under it.
export function continuesHighlightGroup(source, prev, next) {
  if (!prev || !next) return false;
  if ((prev.color || MARK_HIGHLIGHT_DEFAULT) !== (next.color || MARK_HIGHLIGHT_DEFAULT)) return false;
  const nextNote = next.noteRef !== undefined ? next.noteRef : next.note;
  if (nextNote) return false;
  const gap = source.slice(prev.end, next.start);
  if (HIGHLIGHT_GROUP_GAP_RE.test(gap)) return true;
  if (gap !== "\n") return false;
  const lineStart = source.lastIndexOf("\n", prev.start - 1) + 1;
  return HEADING_LINE_RE.test(source.slice(lineStart, prev.start));
}

// The mark at ordinal `markIndex` (how many <mark> opens precede it in the
// source) — the same ordinal collectDeckHighlights reports and the DOM
// `querySelectorAll("mark")` index (marked/DOMPurify preserve document
// order), so a caller with a DOM node's index can find its exact source span
// without a text search. `note` is the raw data-note attribute value (or
// null) — resolve it to text with highlightNoteText (format/highlight-notes.js).
export function markSpanAt(source, markIndex) {
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  let i = 0;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    if (i === markIndex) {
      const inner = m[3];
      const openLength = m[0].length - inner.length - MARK_CLOSE_TAG.length;
      return { start: m.index, end: m.index + m[0].length, inner, openLength, color: m[1] || MARK_HIGHLIGHT_DEFAULT, note: m[2] || null };
    }
    i += 1;
  }
  return null;
}

// A highlight the reader made in one action can be several adjacent <mark>s —
// wrapAcrossBlocks emits one per block, list item and table cell — so editing
// only the first would recolour/remove a fraction of it. The whole group
// moves together, using the same adjacency rule the Highlights panel groups
// rows by (continuesHighlightGroup). It used to test the gap alone — not the
// colour, not the note — so removing a yellow highlight also removed the green
// one that happened to start the next list item.
export function markGroupSpanAt(source, markIndex) {
  const first = markSpanAt(source, markIndex);
  if (!first) return null;
  let last = first;
  let i = markIndex + 1;
  for (;;) {
    const next = markSpanAt(source, i);
    if (!next) break;
    if (!continuesHighlightGroup(source, last, next)) break;
    last = next;
    i += 1;
  }
  return { start: first.start, end: last.end, count: i - markIndex };
}

export function wrapTableRow(line, color) {
  return line
    .split(/(?<!\\)\|/)
    .map((cell) => {
      if (!cell.trim()) return cell;
      const [, lead, core, trail] = CELL_TEXT_RE.exec(cell);
      return lead + markOpenTag(color) + core + MARK_CLOSE_TAG + trail;
    })
    .join("|");
}

export function wrapKeepingPrefix(text, color) {
  if (!text.trim()) return text;
  const prefix = BLOCK_PREFIX_RE.exec(text)[0];
  const rest = text.slice(prefix.length);
  return rest ? prefix + markOpenTag(color) + rest + MARK_CLOSE_TAG : text;
}

// Wrap the located occurrence in <mark[ data-color]></mark>, strip it if the
// selection is already exactly that colour, or recolour it in place if it's
// already highlighted a DIFFERENT colour than the one requested. Same shape
// as clozeToggleInSource. DOMPurify's default allowlist already permits
// <mark> (and, via ALLOW_DATA_ATTR, data-color on it), and the "keep-mark"
// Turndown rule (see htmlToMarkdown) round-trips both back out of a
// selection, so no render/sanitize change is needed for this to display or to
// survive being lifted into a card/cloze/quick-note.
// `literal` is for a selection the DOM says is code but that could not be
// matched to its fence by position (see makeHighlightFromSelection): wrap the
// hit in one mark, with none of wrapAcrossBlocks' prefix handling — in code a
// leading `# ` is a comment, not a heading.
export function highlightToggleInSource(source, sel, color, { literal = false } = {}) {
  const loc = locateSelectionInSource(source, sel, { fuzzy: true });
  if (!loc) return null;
  const { idx, end } = snapToWholeCharacters(source, loc.idx, loc.end);
  const needle = source.slice(idx, end);
  const openMatch = MARK_OPEN_RE.exec(source.slice(0, idx));
  const hasClose = source.slice(end, end + MARK_CLOSE_TAG.length) === MARK_CLOSE_TAG;
  if (openMatch && hasClose) {
    const existingColor = openMatch[1] || MARK_HIGHLIGHT_DEFAULT;
    const openStart = idx - openMatch[0].length;
    const closeEnd = end + MARK_CLOSE_TAG.length;
    if (color === "clear" || color === existingColor) {
      return { text: source.slice(0, openStart) + needle + source.slice(closeEnd), action: "removed", idx: openStart };
    }
    return {
      // Preserves any existing note (openMatch[2]) — recolouring an annotated
      // highlight this way must not silently drop its note.
      text: source.slice(0, openStart) + markOpenTag(color, openMatch[2]) + needle + MARK_CLOSE_TAG + source.slice(closeEnd),
      action: "recolored",
      idx: openStart
    };
  }
  if (color === "clear") return { text: source, action: "not-highlighted", idx };
  // Sub-selection inside a larger existing highlight (an unclosed <mark>
  // precedes the match, with a </mark> still to come): wrapping it would nest
  // <mark> tags rather than extend the existing highlight.
  const before = source.slice(0, idx);
  if (before.lastIndexOf("<mark") > before.lastIndexOf(MARK_CLOSE_TAG) && source.indexOf(MARK_CLOSE_TAG, end) !== -1) {
    return { text: source, action: "already", idx };
  }
  // Wholly inside one code block: one mark, exactly around the words. Starting
  // inside one: the walk has to be told, or it reads the closing fence as an
  // opener (see wrapAcrossBlocks).
  const fences = codeFences(source);
  const wrapped = literal || codeFenceAt(fences, idx, end)
    ? markOpenTag(color) + needle + MARK_CLOSE_TAG
    : wrapAcrossBlocks(needle, color, { openFence: codeFenceAt(fences, idx)?.marker || null });
  return { text: source.slice(0, idx) + wrapped + source.slice(end), action: "added", idx };
}

// ── A highlight never ends half-way through a letter ─────────────────────
//
// In Devanagari (and every other Indic script, and any text with combining
// accents) what a reader sees as one letter is a base character followed by
// marks: "त्" is त plus the virama ्. A selection snapped to the end of "तत"
// stopped before the virama, the <mark> closed there, and the mark left outside
// rendered on its own — as a dotted circle, "तत◌्" — in the note and in every
// export. The browser cannot shape a letter whose pieces sit in two elements.
//
// So both ends are moved outward over combining marks (\p{M}, which includes
// the viramas and the vowel signs) and the two joiners. Never across a tag or a
// line: the character on the far side of either is not part of this letter.
export const COMBINING_CHAR_RE = /[\p{M}\u200C\u200D]/u;

export function snapToWholeCharacters(source, idx, end) {
  let start = idx;
  let stop = end;
  while (stop < source.length && COMBINING_CHAR_RE.test(source[stop])) stop += 1;
  while (start > 0 && start < stop && COMBINING_CHAR_RE.test(source[start])
    && source[start - 1] !== ">" && source[start - 1] !== "\n") start -= 1;
  return { idx: start, end: stop };
}

export function highlightInfoMessage(action) {
  return action === "not-highlighted" ? "That text isn't highlighted" : "That text is already highlighted";
}

// Raw-editor counterpart to highlightToggleInSource: the textarea already
// gives an exact [start,end) selection, so there's no source-search step —
// just wrap, recolour, or strip the substring directly. Used by the raw
// notes/card editor's Highlight dropdown (handleToolbarClick's data-highlight
// branch), the edit-mode equivalent of the rendered-view highlight button.
//
// `inCode`: the selection lies inside one fence body — one mark, no prefix
// handling (a `# ` there is a comment). `openFence`: it starts inside one and
// runs out of it — see wrapAcrossBlocks. codeSelectionContext works out both.
export function toggleMarkColorInText(text, color, { inCode = false, openFence = null } = {}) {
  const whole = /^<mark(?:\s+data-color="([a-z]+)")?(?:\s+data-note="([A-Za-z0-9+/=-]*)")?>([\s\S]*)<\/mark>$/.exec(text);
  if (whole) {
    const existingColor = whole[1] || MARK_HIGHLIGHT_DEFAULT;
    if (color === "clear" || color === existingColor) return whole[3];
    // Preserves an existing note (whole[2]) across a recolour.
    return markOpenTag(color, whole[2]) + whole[3] + MARK_CLOSE_TAG;
  }
  if (color === "clear") return text;
  if (inCode) return markOpenTag(color) + text + MARK_CLOSE_TAG;
  return wrapAcrossBlocks(text, color, { openFence });
}

// Where a raw-editor selection [start, end) of `text` sits relative to code:
// the second argument toggleMarkColorInText wants.
export function codeSelectionContext(text, start, end) {
  const fences = codeFences(text);
  if (!fences.length) return {};
  return {
    inCode: Boolean(codeFenceAt(fences, start, end)),
    openFence: codeFenceAt(fences, start)?.marker || null
  };
}

// The selection an action should run against, in priority order: a snapshot the
// caller already holds, the live selection, then the pill's position-time
// capture.
//
// That last fallback is what makes the render toolbar usable on a touch screen.
// Tapping ▾ to open a colour menu ends the selection on touch, so by the time a
// swatch is tapped renderedSelectionStrings() has nothing to report — and
// picking a colour failed with "select some text first" for a selection the
// reader had only just made and could still see on screen. That is the "the
// highlight colour buttons don't work" report. pillSelectionCapture is taken
// when the pill is positioned, before any of that can happen; it is only
// trusted when it belongs to the view being acted on.
export function selectionForRenderTarget(view, selOverride = null) {
  if (selOverride) return selOverride;
  const live = renderedSelectionStrings(view);
  if (live) return live;
  // Deferred capture, resolved on demand — see pillActionTarget.
  ensurePillSelectionCapture();
  if (pillSelectionCapture && !pillSelectionCapture.editing && pillSelectionCapture.sel) {
    // selectionTargets(), not SELECTION_TARGETS: the second is the three fixed
    // surfaces, and a note written on a highlight is a fourth that comes and
    // goes — registered by whichever editor or card is showing (see
    // NOTE_EDITOR_TARGET). Looking the capture up in the fixed list alone could
    // never match "highlight-note", so on a touch screen — where the tap that
    // hits a pill button dissolves the live selection, which is exactly why this
    // fallback exists — formatting a phrase in a card resolved to nothing and
    // the button did nothing.
    const captured = selectionTargets().find((t) => t.name === pillSelectionCapture.targetName);
    if (captured && captured.view === view) return pillSelectionCapture.sel;
  }
  return null;
}

// The ordinal (DOM-index-among-<mark>s, same as collectDeckHighlights'
// markIndex) of the single EXISTING highlight the live selection overlaps, or
// -1 if there's no live selection in `view`, or it overlaps none/more than
// one. Range.intersectsNode is exact regardless of markup, which is what
// makes this route immune to every text-matching failure mode below.
export function overlappingMarkIndex(view) {
  if (!view) return -1;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return -1;
  const range = selection.getRangeAt(0);
  if (!view.contains(range.commonAncestorContainer)) return -1;
  const marks = view.querySelectorAll("mark");
  let hit = -1;
  for (let i = 0; i < marks.length; i += 1) {
    if (!range.intersectsNode(marks[i])) continue;
    if (!rangeCoversTextOf(range, marks[i])) continue;
    if (hit !== -1) return -1; // touches more than one — not a clean edit
    hit = i;
  }
  return hit;
}

// ── Touching is not overlapping ───────────────────────────────────────────
//
// intersectsNode is true for a range that merely ENDS where a mark begins, or
// begins at the very end of the text inside one — and a touch selection snapped
// to a word boundary lands there all the time, because the word next to a
// highlight starts exactly where the highlight's text node ends. So selecting
// the word beside an existing highlight was read as "re-select that highlight":
// the neighbour was recoloured, toggled off, or — through the highlight-and-note
// button — had the new note written into it. That is how two annotations ended
// up in one note.
//
// A mark counts only when the part of it the selection actually covers holds a
// visible character.
export function rangeCoversTextOf(range, mark) {
  const inner = document.createRange();
  inner.selectNodeContents(mark);
  if (range.compareBoundaryPoints(Range.START_TO_START, inner) > 0) inner.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, inner) < 0) inner.setEnd(range.endContainer, range.endOffset);
  if (inner.collapsed) return false;
  // Anything the badge pass put inside a mark is not the mark's text.
  const fragment = inner.cloneContents();
  fragment.querySelectorAll?.(".hl-note-badge").forEach((node) => node.remove());
  return /\S/.test(fragment.textContent || "");
}

// Re-selecting an existing highlight (to recolour or toggle it off) and
// having it addressed by ORDINAL instead of a text search — the search can't
// see past the <mark> tags already sitting in the match, which is worst for a
// highlight wrapAcrossBlocks split into several adjacent marks (a paragraph
// or list-item drag): that "Couldn't match that selection" was the single
// biggest source of the report, because re-highlighting/adjusting a highlight
// is routine. Same recolour/remove/toggle semantics as
// highlightToggleInSource's own mark-already-here branch, just reached
// without searching for text that's already uniquely addressable by
// position. Returns null when the selection doesn't cleanly overlap exactly
// one existing highlight, so the caller falls through to the normal path.
export function highlightToggleByOverlap(source, markIndex, color) {
  const span = markGroupSpanAt(source, markIndex);
  const first = markSpanAt(source, markIndex);
  if (!span || !first) return null;
  const remove = color === "clear" || color === first.color;
  // Preserves whichever piece's own note (each piece keeps its own capture —
  // only the first piece has one by construction, see highlight-notes.js).
  const rewritten = source.slice(span.start, span.end).replace(HIGHLIGHT_SCAN_RE, (_all, _c, note, inner) =>
    remove ? inner : markOpenTag(color, note) + inner + MARK_CLOSE_TAG);
  return {
    text: source.slice(0, span.start) + rewritten + source.slice(span.end),
    action: remove ? "removed" : "recolored",
    idx: span.start
  };
}

// The text search's view of a code selection: the code itself, as the block
// holds it. asMarkdown is dropped — Turndown escapes code as if it were prose
// (`\#`, `\*`), which is never what the fence says.
function codeFallbackSelection(sel) {
  const { text, start, end } = sel.code;
  return {
    asText: text.slice(start, end).replace(/^\n+|\n+$/g, ""),
    asMarkdown: "",
    view: sel.view,
    anchorNode: sel.anchorNode,
    get occurrence() {
      return sel.occurrence;
    }
  };
}

// Driver for the highlight button — same shape as makeClozeFromSelection.
// `color` defaults to the shared last-used swatch (renderFormatDefaults.highlight)
// so a plain tap of the floating pill applies/toggles that colour; the render
// toolbar's split-button menu passes a specific token instead.
//
// ── ...and what it hands back ──────────────────────────────────────────────
//
// It returned nothing at all, because until now nobody needed to know WHICH
// mark had just been made — every caller wanted the highlight and stopped
// there. "Highlight and annotate" wants the next thing after it: the note
// editor, open on this mark and no other. So the paths that changed the source
// return { action, idx, source }, where `idx` is the offset of the new mark's
// own `<mark` open tag in `source` — which is what lets a caller turn it into
// an ordinal (markOpenOffsets) without re-searching for the words. The refusals
// return null, and every existing caller ignores the value either way.
// `keepExisting` (the highlight-and-note button): a selection that is already
// one highlight is answered with that highlight, untouched — { action:
// "existing" } — rather than being toggled off or recoloured, so the note editor
// opens on the mark the reader pointed at.
export function makeHighlightFromSelection({ view, label, getSource, setSource, rerender }, color = renderFormatDefaults.highlight, selOverride = null, { keepExisting = false } = {}) {
  // Only for a LIVE selection — selOverride (the pill's position-time
  // snapshot) has no DOM range left to test overlap against by the time it's
  // used, so it always falls through to the text-search path below.
  const overlapIndex = selOverride ? -1 : overlappingMarkIndex(view);
  if (overlapIndex !== -1 && keepExisting) {
    const source = getSource();
    const span = markSpanAt(source, overlapIndex);
    if (span) {
      window.getSelection()?.removeAllRanges();
      return { action: "existing", idx: span.start, source };
    }
  }
  if (overlapIndex !== -1) {
    const result = highlightToggleByOverlap(getSource(), overlapIndex, color);
    if (result) {
      setSource(result.text);
      window.getSelection()?.removeAllRanges();
      rerender(result.idx);
      scheduleDeckAutosave();
      notifyHighlightsChanged();
      return { action: result.action, idx: result.idx, source: result.text };
    }
  }

  const sel = selectionForRenderTarget(view, selOverride);
  if (!sel) {
    showToast(`Select some text in the ${label} first, then tap the highlight button to mark it.`, "error");
    return null;
  }
  // Inside one code block, by position (see src/format/code-highlight.js).
  // When the block cannot be matched to its fence — one nested deep in a list
  // or a quote — the text search still runs, told that this is code.
  const result = (sel.code && highlightCodeSelectionInSource(getSource(), sel, color))
    || highlightToggleInSource(getSource(), sel.code ? codeFallbackSelection(sel) : sel, color, { literal: Boolean(sel.code) });
  if (!result) {
    showToast(sel.code
      ? "Couldn't place that highlight in this code block — try selecting within a single line."
      : "Couldn't match that selection in the source — try selecting whole words.", "error");
    return null;
  }
  if (keepExisting && result.action === "removed") {
    // The exact words of an existing highlight, in its own colour: the swatch
    // would toggle it off; this button means "annotate it".
    window.getSelection()?.removeAllRanges();
    return { action: "existing", idx: result.idx, source: getSource() };
  }
  if (result.action === "already" || result.action === "not-highlighted") {
    showToast(highlightInfoMessage(result.action), "info");
    return null;
  }
  setSource(result.text);
  window.getSelection()?.removeAllRanges();
  rerender(result.idx);
  scheduleDeckAutosave();
  // ── ...and everything else that lists this deck's highlights ─────────────
  //
  // This is THE verb behind every way of marking text in a note — the pill, the
  // render toolbar's swatch menu, the mark menu's recolour-by-reselect — and it
  // told nobody. `rerender` repaints the surface the mark is ON and nothing
  // else, so the side-by-side pane kept the list it had: a highlight made with
  // the pane open beside the note did not appear in it, and the "12 / 87"
  // counter did not move. "The highlight count is not real-time updating."
  //
  // The document surface never had this problem, because addDocumentHighlight
  // goes through commitDocumentHighlights, which notifies by default. This is
  // the notes side catching up with it.
  //
  // The import edge closes a cycle (highlight-edit.js imports from here), which
  // is the same cycle and the same shape highlight-notes.js already crosses:
  // notifyHighlightsChanged is a hoisted `function` called at runtime, never a
  // `const` read while a module body is still evaluating.
  notifyHighlightsChanged();
  return { action: result.action, idx: result.idx, source: result.text };
}
