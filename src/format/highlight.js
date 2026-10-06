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
// A third cycle of the same kind: highlight-notes.js builds on markSpanAt and
// scanMarks from here, and these three are hoisted functions called at runtime.
import { foldHighlightNotes, normalizeHighlightSource, pruneOrphanHighlightNotes } from "./highlight-notes.js?v=__BUILD__";

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

// ── Every <mark> in a source, counted the way the DOM counts them ─────────
//
// "Which highlight is this?" is answered by ordinal everywhere — the mark menu,
// the note editor, the Highlights pane, a jump — and there used to be three
// different counters behind that one number:
//
//   • the DOM's querySelectorAll("mark"), which counts every element;
//   • markOpenOffsets (src/notes/anchors.js), which counts every open TAG;
//   • HIGHLIGHT_SCAN_RE, a lazy <mark>…</mark> regex, which every EDIT used.
//
// The regex disagrees with the other two whenever a mark is nested in another
// (it ends the outer one at the inner one's close, and never sees the inner
// open at all) or is empty (`[\s\S]+?` cannot match nothing, so it runs on and
// swallows the NEXT highlight). One nested mark anywhere in a note shifted every
// ordinal after it by one: ✕ removed the highlight before the one tapped, a note
// was written onto the wrong highlight, and the last highlight in the note
// answered "That highlight is no longer in the note". Nested marks were not
// exotic either — extending a highlight on a phone produced them (see
// mergeHighlightRange).
//
// So there is one counter now, and it is this one: every open tag in source
// order, paired with its close by depth. Its ordinals are markOpenOffsets'
// ordinals (which is built on it) and the DOM's, because marked and DOMPurify
// keep raw inline HTML in document order.
//
// Each entry: { index, start, openEnd, closeStart, end, inner, color, note,
// depth, canonical }. An unclosed open tag (closeStart -1) still counts — the
// browser makes an element of it — and spans its own open tag only.
export const MARK_TAG_SCAN_RE = /<mark\b[^>]*>|<\/mark\s*>/gi;

const MARK_COLOR_ATTR_RE = /\sdata-color="([a-z]+)"/;

const MARK_NOTE_ATTR_RE = /\sdata-note="([A-Za-z0-9+/=-]*)"/;

// Two, because two strings are asked about in turn: the note (state.notes)
// and, on a note built as it is read, its prepared text (src/notes/anchors.js).
let scanMemo = [];

export function scanMarks(source) {
  const text = String(source || "");
  // Every caller in one gesture (the menu's open, its press, the rewrite, the
  // group walk) scans the same string, so the last answers are kept.
  const hit = scanMemo.find((memo) => memo.source === text);
  if (hit) return hit.entries;
  const entries = [];
  const stack = [];
  if (text.includes("<mark") || text.includes("<MARK")) {
    const scan = new RegExp(MARK_TAG_SCAN_RE.source, "gi");
    let m;
    while ((m = scan.exec(text))) {
      if (m[0][1] === "/") {
        const open = stack.pop();
        if (!open) continue; // a stray close: the browser ignores it, so do we
        open.closeStart = m.index;
        open.end = m.index + m[0].length;
        open.inner = text.slice(open.openEnd, m.index);
        continue;
      }
      const tag = m[0];
      const entry = {
        index: entries.length,
        start: m.index,
        openEnd: m.index + tag.length,
        openLength: tag.length,
        closeStart: -1,
        end: m.index + tag.length,
        inner: "",
        color: MARK_COLOR_ATTR_RE.exec(tag)?.[1] || MARK_HIGHLIGHT_DEFAULT,
        note: MARK_NOTE_ATTR_RE.exec(tag)?.[1] || null,
        depth: stack.length,
        canonical: MARK_OPEN_RE.test(tag)
      };
      entries.push(entry);
      stack.push(entry);
    }
  }
  scanMemo = [{ source: text, entries }, ...scanMemo].slice(0, 2);
  return entries;
}

// The mark at ordinal `markIndex` — see scanMarks for what the ordinal counts.
// `note` is the raw data-note attribute value (or null) — resolve it to text
// with highlightNoteText (format/highlight-notes.js).
export function markSpanAt(source, markIndex) {
  if (!Number.isInteger(markIndex) || markIndex < 0) return null;
  const entry = scanMarks(source)[markIndex];
  if (!entry) return null;
  return { ...entry };
}

// The visible words of a stretch of source: tags out, markdown emphasis and
// escapes out, whitespace collapsed. Only ever used to ask "are these the same
// words?" — of a tapped mark against its source entry, or of a stretch beside a
// selection ("is there anything visible here?") — never to place anything.
export function plainMarkText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A highlight the reader made in one action can be several adjacent <mark>s —
// wrapAcrossBlocks emits one per block, list item and table cell — so editing
// only the first would recolour/remove a fraction of it. The whole group
// moves together, using the same adjacency rule the Highlights panel groups
// rows by (continuesHighlightGroup). It used to test the gap alone — not the
// colour, not the note — so removing a yellow highlight also removed the green
// one that happened to start the next list item.
//
// `pieces` are the group's own entries. A mark nested inside one of them is not
// a piece (it is not adjacent to anything — it is inside), and is skipped by
// the walk rather than ending it.
export function markGroupSpanAt(source, markIndex) {
  const entries = scanMarks(source);
  const first = Number.isInteger(markIndex) ? entries[markIndex] : null;
  if (!first) return null;
  const pieces = [first];
  let last = first;
  for (let i = markIndex + 1; i < entries.length; i += 1) {
    const next = entries[i];
    if (next.start < last.end) continue; // inside the piece before it
    if (next.depth !== first.depth || !continuesHighlightGroup(source, last, next)) break;
    pieces.push(next);
    last = next;
  }
  return { start: first.start, end: last.end, count: pieces.length, pieces };
}

// Rewrites the TAGS of `entries` and nothing else: `open(entry)` returns the
// new open tag ("" to drop it), and a dropped open drops its close as well.
// Positional, from the last tag backwards, so no offset is invalidated by an
// earlier edit — which is what a regex replace over a slice could not promise
// the moment a slice held a nested or an unclosed mark.
export function rewriteMarkTags(source, entries, open) {
  const edits = [];
  entries.forEach((entry) => {
    const tag = open(entry);
    edits.push({ at: entry.start, to: entry.openEnd, text: tag });
    if (!tag && entry.closeStart !== -1) edits.push({ at: entry.closeStart, to: entry.end, text: "" });
  });
  edits.sort((a, b) => b.at - a.at);
  let out = source;
  edits.forEach((edit) => {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.to);
  });
  return out;
}

// ── Repairing what earlier versions wrote ─────────────────────────────────
//
// Two shapes the scanner above can count but no reader wants: a mark with
// nothing visible in it (it highlights nothing and used to swallow the next
// highlight whole), and a mark inside another mark (a highlight inside a
// highlight is one highlight — the outer one already covers the words). Both
// were written by this app; neither can be produced any more (mergeHighlightRange
// and the guard in makeHighlightFromSelection). This takes the ones already
// sitting in people's notes out, before the note is rendered, so the DOM is
// never built from a source the edit paths would read differently.
//
// Only marks in the app's own canonical form are touched: a `<mark class=…>`
// pasted from elsewhere, or a mark written inside an inline code span (where it
// is text, not a highlight), is left exactly as it was.
//
// Returns { text, notes } — `notes` lists [keptId, foldedId] pairs, where an
// inner mark's note had to be folded into the outer mark's. The note TEXT lives
// in format/highlight-notes.js's block, which this module cannot write;
// normalizeHighlightSource there applies them.
export function normalizeMarks(source) {
  const text = String(source || "");
  const entries = scanMarks(text);
  if (!entries.length) return { text: source, notes: [] };
  const drop = new Set();
  const retag = new Map();
  const notes = [];
  // Which entry each nested one is ultimately inside — the outermost canonical
  // mark, since a mark may be nested two deep.
  const stack = [];
  entries.forEach((entry) => {
    while (stack.length && stack[stack.length - 1].end <= entry.start) stack.pop();
    // Cheapest tests first: this runs before every render of every note, and
    // for a healthy one the answer is "nothing to do" for every mark in it.
    const suspect = entry.canonical && entry.closeStart !== -1
      && (entry.depth > 0 || !/[^\s]/.test(entry.inner) || !plainMarkText(entry.inner));
    const usable = suspect && !insideInlineCode(text, entry.start);
    if (usable && !plainMarkText(entry.inner) && !/<(?:img|svg)\b/i.test(entry.inner)) {
      drop.add(entry);
      return; // an empty mark holds nothing to be nested in
    }
    const outer = usable && entry.depth > 0 ? stack.find((candidate) => candidate.canonical && !drop.has(candidate)) : null;
    if (usable && outer) {
      drop.add(entry);
      if (entry.note) {
        const kept = retag.get(outer) ?? outer.note;
        if (!kept) retag.set(outer, entry.note);
        else if (kept !== entry.note) notes.push([kept, entry.note]);
      }
      return;
    }
    stack.push(entry);
  });
  if (!drop.size) return { text: source, notes: [] };
  const targets = [...drop, ...retag.keys()];
  const out = rewriteMarkTags(text, targets, (entry) => (drop.has(entry) ? "" : markOpenTag(entry.color, retag.get(entry))));
  return { text: out, notes };
}

// Whether `at` sits inside an inline code span on its own line — an odd number
// of backtick runs before it. Cheap and line-local, which is all a mark tag
// needs: a code span cannot hold a newline-separated paragraph anyway.
function insideInlineCode(text, at) {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, at);
  return ((before.match(/`+/g) || []).length % 2) === 1;
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
export function highlightToggleInSource(source, sel, color, { literal = false, keepExisting = false } = {}) {
  const loc = locateSelectionInSource(source, sel, { fuzzy: true });
  if (!loc) return null;
  const { idx, end } = snapToWholeCharacters(source, loc.idx, loc.end);
  return applyHighlightRange(source, idx, end, color, { literal, keepExisting });
}

// ── What a selection does to the highlights it touches ────────────────────
//
// The text search hands back [idx, end) in the source. What happens next used
// to depend only on whether a <mark> sat immediately either side of it — and
// everything else, a selection reaching past an existing highlight above all,
// fell through to "wrap it", with the existing highlight still inside. That is
// how a highlight came to be nested in a highlight (see scanMarks for what that
// did to every edit after it), and it is why "extend a highlight" never worked:
// the attempt either toggled the old one off or buried it.
//
// The rule now, decided against the scanner rather than against the bytes
// beside the hit:
//
//   no highlight shares a visible character with the selection
//       → add one (clear: "isn't highlighted")
//   the selection is exactly one highlight
//       → toggle it off in its own colour, recolour it in another
//   the selection is inside one highlight
//       → clear: ERASE those words from it, keeping the rest either side
//       → another colour: recolour it; its own colour: "already highlighted"
//   the selection reaches past the highlights it touches
//       → clear: erase the selected part of each
//       → a colour: EXTEND — one highlight over the union, in that colour,
//         keeping the first note it covered and folding any others into it
//
// Returns { text, action, idx, notes? } — `idx` is the offset of the resulting
// highlight's own <mark> open tag where there is one (what main.js turns into
// an ordinal), and `notes` lists [keptId, foldedId] pairs for
// foldHighlightNotes (format/highlight-notes.js) to merge.
export function applyHighlightRange(source, rawIdx, rawEnd, color, { literal = false, note = null, keepExisting = false, force = false } = {}) {
  const entries = scanMarks(source);
  let idx = rawIdx;
  let end = rawEnd;
  const visible = (from, to) => to > from && Boolean(plainMarkText(source.slice(from, to)));
  const shared = (e) => (idx <= e.start && end >= e.end) || visible(Math.max(idx, e.openEnd), Math.min(end, e.closeStart));
  const top = entries.filter((e) => e.depth === 0 && e.closeStart !== -1 && e.start < end && e.end > idx);
  const overlapping = top.filter(shared);

  // A mark the hit only GRAZES (it shares whitespace or a tag with it, no
  // word) is not touched — and the hit is pulled back off it, so a new mark
  // can never open inside one and close outside it.
  top.filter((e) => !overlapping.includes(e)).forEach((e) => {
    if (e.start < idx && idx < e.end) idx = e.end;
    if (e.start < end && end < e.end) end = e.start;
  });

  if (!overlapping.length) {
    if (color === "clear") return { text: source, action: "not-highlighted", idx };
    if (end <= idx || !visible(idx, end)) return { text: source, action: "already", idx };
    return wrapRange(source, idx, end, color, { literal, note, action: "added", strip: [] });
  }

  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  const reachesOut = visible(idx, first.start) || visible(last.end, end) || overlapping.some((e, i) => i > 0 && visible(overlapping[i - 1].end, e.start));

  // `force` (an Adjust): the range IS the highlight now, whatever it touches —
  // never a toggle, never "already". It goes straight to the union below.
  if (overlapping.length === 1 && !reachesOut && !force) {
    // "Highlight and annotate" over words already highlighted means "annotate
    // THAT one" — the highlight is left exactly as it is.
    if (keepExisting) return { text: source, action: "existing", idx: first.start };
    const insideBefore = visible(first.openEnd, idx);
    const insideAfter = visible(end, first.closeStart);
    if (!insideBefore && !insideAfter) {
      const group = markGroupSpanAt(source, first.index);
      if (color === "clear" || color === first.color) {
        return { text: rewriteMarkTags(source, group.pieces, () => ""), action: "removed", idx: first.start };
      }
      return {
        // Every piece keeps its own note reference — a recolour must not drop one.
        text: rewriteMarkTags(source, group.pieces, (piece) => markOpenTag(color, piece.note)),
        action: "recolored",
        idx: first.start
      };
    }
    if (color === "clear") return eraseRange(source, idx, end, overlapping);
    if (color === first.color) return { text: source, action: "already", idx };
    const group = markGroupSpanAt(source, first.index);
    return { text: rewriteMarkTags(source, group.pieces, (piece) => markOpenTag(color, piece.note)), action: "recolored", idx: first.start };
  }

  if (color === "clear") return eraseRange(source, idx, end, overlapping);

  // EXTEND. The union, widened over any other mark straddling either of its
  // edges so that no tag is left half in and half out.
  let uStart = Math.min(idx, first.start);
  let uEnd = Math.max(end, last.end);
  for (let changed = true; changed;) {
    changed = false;
    entries.forEach((e) => {
      if (e.start < uStart && e.end > uStart) { uStart = e.start; changed = true; }
      if (e.start < uEnd && e.end > uEnd) { uEnd = e.end; changed = true; }
    });
  }
  const inside = entries.filter((e) => e.start >= uStart && e.end <= uEnd);
  const ids = [];
  inside.forEach((e) => { if (e.note && !ids.includes(e.note)) ids.push(e.note); });
  const kept = note || ids[0] || null;
  const notes = ids.filter((id) => id !== kept).map((id) => [kept, id]);
  return { ...wrapRange(source, uStart, uEnd, color, { literal, note: kept, action: "extended", strip: inside }), notes };
}

// Wraps [from, to) — after taking the tags of `strip` out of it — the way a new
// highlight is always wrapped: one mark inside a code block, a mark per block
// everywhere else (wrapAcrossBlocks). `note` goes on the first mark.
function wrapRange(source, from, to, color, { literal, note, action, strip }) {
  const local = strip.map((e) => ({ ...e, start: e.start - from, openEnd: e.openEnd - from, closeStart: e.closeStart === -1 ? -1 : e.closeStart - from, end: e.end - from }));
  const needle = rewriteMarkTags(source.slice(from, to), local, () => "");
  const fences = codeFences(source);
  let wrapped = literal || codeFenceAt(fences, from, to)
    ? markOpenTag(color) + needle + MARK_CLOSE_TAG
    : wrapAcrossBlocks(needle, color, { openFence: codeFenceAt(fences, from)?.marker || null });
  const at = wrapped.indexOf("<mark");
  if (at === -1) return { text: source, action: "already", idx: from };
  if (note) {
    const close = wrapped.indexOf(">", at) + 1;
    wrapped = wrapped.slice(0, at) + markOpenTag(color, note) + wrapped.slice(close);
  }
  return { text: source.slice(0, from) + wrapped + source.slice(to), action, idx: from + at };
}

// ERASE [idx, end) from every highlight in `overlapping`: what is left of each
// either side stays highlighted in its own colour, and its note rides on the
// first piece that is left. A highlight erased whole hands its note on to the
// next piece of its own group, so annotating a two-paragraph highlight and then
// clearing the first paragraph does not orphan the note.
function eraseRange(source, idx, end, overlapping) {
  const edits = [];
  let carry = null;
  let carryGroup = null;
  overlapping.forEach((e) => {
    const before = idx > e.openEnd ? source.slice(e.openEnd, Math.min(idx, e.closeStart)) : "";
    const after = end < e.closeStart ? source.slice(Math.max(end, e.openEnd), e.closeStart) : "";
    const middle = source.slice(Math.max(idx, e.openEnd), Math.min(end, e.closeStart));
    let note = e.note;
    if (!note && carry && carryGroup?.includes(e)) {
      note = carry;
      carry = null;
    }
    const wrap = (text) => {
      if (!plainMarkText(text)) return text;
      const out = markOpenTag(e.color, note) + text + MARK_CLOSE_TAG;
      note = null;
      return out;
    };
    const replacement = wrap(before) + middle + wrap(after);
    if (note) {
      carry = note;
      carryGroup = markGroupSpanAt(source, e.index)?.pieces || [];
    }
    edits.push({ at: e.start, to: e.end, text: replacement });
  });
  // A note still being carried goes to the next surviving piece of its group
  // that the selection did not reach.
  if (carry && carryGroup) {
    const heir = carryGroup.find((piece) => piece.start >= end && !overlapping.includes(piece));
    if (heir) edits.push({ at: heir.start, to: heir.openEnd, text: markOpenTag(heir.color, heir.note || carry) });
  }
  edits.sort((a, b) => b.at - a.at);
  let text = source;
  edits.forEach((edit) => { text = text.slice(0, edit.at) + edit.text + text.slice(edit.to); });
  return { text, action: "removed", idx: overlapping[0].start };
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
  const marks = scanMarks(text);
  const opens = marks.length;
  const closes = (text.match(/<\/mark\s*>/gi) || []).length;
  const whole = marks[0];
  if (whole && whole.start === 0 && whole.end === text.length && opens === 1 && closes === 1) {
    if (color === "clear" || color === whole.color) return whole.inner;
    // Preserves an existing note across a recolour.
    return markOpenTag(color, whole.note) + whole.inner + MARK_CLOSE_TAG;
  }
  // A selection with highlights INSIDE it (an extend, or a clear over several)
  // works on its words: the tags in it come out first, so wrapping can never
  // put a highlight inside a highlight. One that cuts a highlight in half — an
  // open tag without its close, or the other way round — is left alone: there
  // is no way to take half a pair out and leave the note balanced.
  let words = text;
  if (opens || closes) {
    if (opens !== closes || marks.some((m) => m.closeStart === -1)) return text;
    words = rewriteMarkTags(text, marks, () => "");
  }
  if (color === "clear") return words;
  if (inCode) return markOpenTag(color) + words + MARK_CLOSE_TAG;
  return wrapAcrossBlocks(words, color, { openFence });
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

// The single EXISTING highlight the live selection overlaps, as
// { mark, index } — `index` its ordinal in the SOURCE (see scanMarks) — or
// null if there's no live selection in `view`, or it overlaps none/more than
// one. Range.intersectsNode is exact regardless of markup, which is what
// makes this route immune to every text-matching failure mode below.
export function overlappingMark(view) {
  if (!view) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!view.contains(range.commonAncestorContainer)) return null;
  const marks = view.querySelectorAll("mark");
  let hit = null;
  for (let i = 0; i < marks.length; i += 1) {
    if (!range.intersectsNode(marks[i])) continue;
    if (!rangeCoversTextOf(range, marks[i])) continue;
    if (hit) return null; // touches more than one — not a clean edit
    hit = marks[i];
  }
  if (!hit) return null;
  const index = markOrdinalFor(view, hit);
  return index < 0 ? null : { mark: hit, index, range };
}

// Kept for its callers: the ordinal alone, -1 for none.
export function overlappingMarkIndex(view) {
  return overlappingMark(view)?.index ?? -1;
}

// ── From a rendered <mark> to its ordinal in the source ───────────────────
//
// The DOM index is the source ordinal only while the DOM holds every mark the
// source has. A note long enough to be built as it is read does not, and
// src/notes/anchors.js (sourceMarkIndexFor) is what maps between the two — a
// module this one cannot import without a cycle through the renderer, so
// src/main.js registers it, the same idiom as setHighlightsChangedHandler.
// The default is right for every surface that renders its whole source at
// once (a card face, a note's own editor).
let markOrdinalFor = (view, mark) => [...view.querySelectorAll("mark")].indexOf(mark);

export function setMarkOrdinalResolver(fn) {
  if (typeof fn === "function") markOrdinalFor = fn;
}

// Whether a rendered mark's words are the words of a source entry — the check
// that stands between "the Nth mark" and editing it. Letters and digits only,
// and containment rather than equality: the source carries what the DOM does
// not show (a link's URL, emphasis markers, an escaped bracket), never the
// other way round.
export function markTextMatches(sourceInner, renderedText) {
  const norm = (text) => String(text || "").replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  const rendered = norm(renderedText);
  const source = norm(sourceInner);
  if (!rendered) return !source || !renderedText.trim();
  return source.includes(rendered);
}

// A mark's own text, without the fold the badge pass puts inside it.
export function renderedMarkText(mark) {
  if (!mark) return "";
  const clone = mark.cloneNode(true);
  clone.querySelectorAll?.(".hl-note-badge").forEach((node) => node.remove());
  return clone.textContent || "";
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
  if (!span) return null;
  const first = span.pieces[0];
  const remove = color === "clear" || color === first.color;
  // Each piece keeps its own note reference — only the first piece has one by
  // construction, see highlight-notes.js — and is rewritten by position, so a
  // piece holding anything unusual cannot throw the rewrite out of step.
  return {
    text: rewriteMarkTags(source, span.pieces, (piece) => (remove ? "" : markOpenTag(color, piece.note))),
    action: remove ? "removed" : "recolored",
    idx: span.start
  };
}

// Whether the live selection reaches any VISIBLE text outside `mark` — the
// difference between re-selecting a highlight (recolour or toggle it) and
// selecting past it (extend it). The overlap path below answers the first; the
// second has to go through applyHighlightRange, or an attempt to extend a
// highlight turns it off.
export function rangeReachesOutside(range, mark) {
  const outer = document.createRange();
  outer.selectNode(mark);
  const part = (setUp) => {
    const piece = document.createRange();
    try { setUp(piece); } catch (_) { return false; }
    if (piece.collapsed) return false;
    const fragment = piece.cloneContents();
    fragment.querySelectorAll?.(".hl-note-badge").forEach((node) => node.remove());
    return /\S/.test(fragment.textContent || "");
  };
  const before = range.compareBoundaryPoints(Range.START_TO_START, outer) < 0
    && part((piece) => { piece.setStart(range.startContainer, range.startOffset); piece.setEnd(outer.startContainer, outer.startOffset); });
  if (before) return true;
  return range.compareBoundaryPoints(Range.END_TO_END, outer) > 0
    && part((piece) => { piece.setStart(outer.endContainer, outer.endOffset); piece.setEnd(range.endContainer, range.endOffset); });
}

// Whether the live selection covers every visible character of `mark` — a
// clear over PART of a highlight erases those words (applyHighlightRange), and
// only a clear over all of it removes the highlight by ordinal.
export function rangeCoversWholeMark(range, mark) {
  const inner = document.createRange();
  inner.selectNodeContents(mark);
  const startsInside = range.compareBoundaryPoints(Range.START_TO_START, inner) > 0;
  const endsInside = range.compareBoundaryPoints(Range.END_TO_END, inner) < 0;
  const text = (setUp) => {
    const piece = document.createRange();
    try { setUp(piece); } catch (_) { return ""; }
    const fragment = piece.cloneContents();
    fragment.querySelectorAll?.(".hl-note-badge").forEach((node) => node.remove());
    return (fragment.textContent || "").trim();
  };
  if (startsInside && text((piece) => { piece.setStart(inner.startContainer, inner.startOffset); piece.setEnd(range.startContainer, range.startOffset); })) return false;
  if (endsInside && text((piece) => { piece.setStart(range.endContainer, range.endOffset); piece.setEnd(inner.endContainer, inner.endOffset); })) return false;
  return true;
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
  //
  // ...and only for a selection that is ABOUT that one highlight: one reaching
  // visible words outside it is an extend, and a clear over part of it is an
  // erase — both are applyHighlightRange's, through the text path. This path
  // used to take them too, and toggled the highlight off.
  const hit = selOverride ? null : overlappingMark(view);
  const source0 = getSource();
  const usable = hit
    && markTextMatches(markSpanAt(source0, hit.index)?.inner, renderedMarkText(hit.mark))
    && !rangeReachesOutside(hit.range, hit.mark)
    && (color !== "clear" || rangeCoversWholeMark(hit.range, hit.mark));
  if (usable && keepExisting) {
    const span = markSpanAt(source0, hit.index);
    if (span) {
      window.getSelection()?.removeAllRanges();
      return { action: "existing", idx: span.start, source: source0 };
    }
  }
  if (usable) {
    const result = highlightToggleByOverlap(source0, hit.index, color);
    if (result) {
      const text = result.action === "removed" ? pruneOrphanHighlightNotes(result.text) : result.text;
      setSource(text);
      window.getSelection()?.removeAllRanges();
      rerender(result.idx);
      scheduleDeckAutosave();
      notifyHighlightsChanged();
      return { action: result.action, idx: result.idx, source: text };
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
    || highlightToggleInSource(getSource(), sel.code ? codeFallbackSelection(sel) : sel, color, { literal: Boolean(sel.code), keepExisting });
  if (!result) {
    showToast(sel.code
      ? "Couldn't place that highlight in this code block — try selecting within a single line."
      : "Couldn't match that selection in the source — try selecting whole words.", "error");
    return null;
  }
  if (keepExisting && (result.action === "removed" || result.action === "existing")) {
    // The exact words of an existing highlight (or some of them): the swatch
    // would toggle it off; this button means "annotate it".
    window.getSelection()?.removeAllRanges();
    return { action: "existing", idx: result.idx, source: getSource() };
  }
  if (result.action === "already" || result.action === "not-highlighted") {
    showToast(highlightInfoMessage(result.action), "info");
    return null;
  }
  const settled = settleHighlightSource(result);
  setSource(settled.text);
  window.getSelection()?.removeAllRanges();
  rerender(settled.idx);
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
  return { action: result.action, idx: settled.idx, source: settled.text };
}

// The last step before any highlight edit is written: notes the edit merged
// are folded into the one it kept, notes whose highlight is gone are pruned,
// and — the guard — the result is put through normalizeHighlightSource, so that
// whatever path produced it, a highlight inside a highlight is never written.
// `idx` follows its mark if the guard had anything to do.
export function settleHighlightSource(result) {
  let text = result.text;
  if (result.notes?.length) text = foldHighlightNotes(text, result.notes);
  if (result.action === "removed") text = pruneOrphanHighlightNotes(text);
  const guarded = normalizeHighlightSource(text);
  if (guarded === text) return { text, idx: result.idx };
  const before = scanMarks(text).find((e) => e.start === result.idx);
  const after = before ? scanMarks(guarded)[before.index] : null;
  return { text: guarded, idx: after ? after.start : result.idx };
}
