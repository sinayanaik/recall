// Highlighting as <mark data-color>, in both the raw and rendered views.
//
// A highlight that spans blocks has to be wrapped per block — one <mark> across
// a paragraph boundary does not survive re-rendering — and list/table prefixes
// have to stay outside the mark or the markup breaks.

import { locateSelectionInSource, renderedSelectionStrings } from "./locate-selection.js?v=__BUILD__";
import { renderFormatDefaults } from "./render-toolbar.js?v=__BUILD__";
import { SELECTION_TARGETS, pillSelectionCapture } from "../notes/selection.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// Highlighting is a literal <mark data-color="…"> in the markdown source —
// NOT an inline background-color <span>, which is what this used to be. A
// fixed, opaque background chosen at authoring time looked wrong the moment
// the reader switched themes (light text on a pale swatch in a dark theme, or
// vice versa) — that span carried no opinion about what was behind it.
// `data-color` is a small closed set of named tokens, and each one is styled
// with `color-mix(in srgb, <hue> N%, transparent)` (see .rendered mark[data-
// color] in styles.css) — an alpha tint over whatever surface is actually
// behind it, which is what makes it read correctly across every one of this
// app's light AND dark theme variants without a single theme-specific
// override. MARK_HIGHLIGHT_HEX is only the PICKER's own preview swatches (a
// normal opaque chip, the same idiom the text-colour picker uses) — it never
// reaches the note itself.
export const MARK_HIGHLIGHT_DEFAULT = "yellow";

export const MARK_HIGHLIGHT_HEX = {
  yellow: "#e0b400",
  green: "#22c55e",
  blue: "#3b82f6",
  pink: "#ec4899",
  orange: "#f97316",
  purple: "#8b5cf6",
};

export const MARK_HIGHLIGHT_COLORS = Object.entries(MARK_HIGHLIGHT_HEX).map(([token, hex]) => ({
  name: token[0].toUpperCase() + token.slice(1),
  value: token,
  swatch: hex,
}));

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
// before colour existed keep matching this and still toggle/recolour fine).
export const MARK_OPEN_RE = /<mark(?:\s+data-color="([a-z]+)")?>$/;

export const MARK_CLOSE_TAG = "</mark>";

export function markOpenTag(color) {
  return color && color !== MARK_HIGHLIGHT_DEFAULT ? `<mark data-color="${color}">` : "<mark>";
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
export const NO_TEXT_LINE_RE = /^[ \t]{0,3}(?:(?:[-*_][ \t]*){3,}|\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?)[ \t]*$/;

export const FENCE_LINE_RE = /^[ \t]{0,3}(```+|~~~+)/;

export const CELL_TEXT_RE = /^([ \t]*)([\s\S]*?)([ \t]*)$/;

// Fenced code is walked line by line rather than split on blank lines: a fence
// with an empty line in the middle is ONE block that a blank-line split would
// cut in two, and a <mark> dropped into the back half shows up as literal
// "<mark>" text in the rendered code (marked escapes HTML inside a fence, and
// no highlight is possible there at all).
export function wrapAcrossBlocks(source, color) {
  const out = [];
  let group = [];
  let fence = null;
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
      return;
    }
    if (!line.trim() || NO_TEXT_LINE_RE.test(line)) {
      flush();
      out.push(line);
      return;
    }
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
export function highlightToggleInSource(source, sel, color) {
  const loc = locateSelectionInSource(source, sel, { fuzzy: true });
  if (!loc) return null;
  const { idx, end, needle } = loc;
  const openMatch = MARK_OPEN_RE.exec(source.slice(0, idx));
  const hasClose = source.slice(end, end + MARK_CLOSE_TAG.length) === MARK_CLOSE_TAG;
  if (openMatch && hasClose) {
    const existingColor = openMatch[1] || MARK_HIGHLIGHT_DEFAULT;
    const openStart = idx - openMatch[0].length;
    const closeEnd = end + MARK_CLOSE_TAG.length;
    if (color === "clear" || color === existingColor) {
      return { text: source.slice(0, openStart) + needle + source.slice(closeEnd), action: "removed" };
    }
    return {
      text: source.slice(0, openStart) + markOpenTag(color) + needle + MARK_CLOSE_TAG + source.slice(closeEnd),
      action: "recolored"
    };
  }
  if (color === "clear") return { text: source, action: "not-highlighted" };
  // Sub-selection inside a larger existing highlight (an unclosed <mark>
  // precedes the match, with a </mark> still to come): wrapping it would nest
  // <mark> tags rather than extend the existing highlight.
  const before = source.slice(0, idx);
  if (before.lastIndexOf("<mark") > before.lastIndexOf(MARK_CLOSE_TAG) && source.indexOf(MARK_CLOSE_TAG, end) !== -1) {
    return { text: source, action: "already" };
  }
  return { text: source.slice(0, idx) + wrapAcrossBlocks(needle, color) + source.slice(end), action: "added" };
}

export function highlightToastMessage(action) {
  if (action === "removed") return "Highlight removed";
  if (action === "recolored") return "Highlight recoloured";
  return "Highlighted";
}

export function highlightInfoMessage(action) {
  return action === "not-highlighted" ? "That text isn't highlighted" : "That text is already highlighted";
}

// Raw-editor counterpart to highlightToggleInSource: the textarea already
// gives an exact [start,end) selection, so there's no source-search step —
// just wrap, recolour, or strip the substring directly. Used by the raw
// notes/card editor's Highlight dropdown (handleToolbarClick's data-highlight
// branch), the edit-mode equivalent of the rendered-view highlight button.
export function toggleMarkColorInText(text, color) {
  const whole = /^<mark(?:\s+data-color="([a-z]+)")?>([\s\S]*)<\/mark>$/.exec(text);
  if (whole) {
    const existingColor = whole[1] || MARK_HIGHLIGHT_DEFAULT;
    if (color === "clear" || color === existingColor) return whole[2];
    return markOpenTag(color) + whole[2] + MARK_CLOSE_TAG;
  }
  if (color === "clear") return text;
  return wrapAcrossBlocks(text, color);
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
  if (pillSelectionCapture && !pillSelectionCapture.editing && pillSelectionCapture.sel) {
    const captured = SELECTION_TARGETS.find((t) => t.name === pillSelectionCapture.targetName);
    if (captured && captured.view === view) return pillSelectionCapture.sel;
  }
  return null;
}

// Driver for the highlight button — same shape as makeClozeFromSelection.
// `color` defaults to the shared last-used swatch (renderFormatDefaults.highlight)
// so a plain tap of the floating pill applies/toggles that colour; the render
// toolbar's split-button menu passes a specific token instead.
export function makeHighlightFromSelection({ view, label, getSource, setSource, rerender }, color = renderFormatDefaults.highlight, selOverride = null) {
  const sel = selectionForRenderTarget(view, selOverride);
  if (!sel) {
    showToast(`Select some text in the ${label} first, then tap the highlight button to mark it.`, "error");
    return;
  }
  const result = highlightToggleInSource(getSource(), sel, color);
  if (!result) {
    showToast("Couldn't match that selection in the source — try selecting whole words.", "error");
    return;
  }
  if (result.action === "already" || result.action === "not-highlighted") {
    showToast(highlightInfoMessage(result.action), "info");
    return;
  }
  setSource(result.text);
  window.getSelection()?.removeAllRanges();
  rerender();
  scheduleDeckAutosave();
  showToast(highlightToastMessage(result.action));
}
