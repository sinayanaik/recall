// A small bar over the words picked in a text box being typed in.
//
// ── Why ────────────────────────────────────────────────────────────────────
//
// "When I am writing in a text box, why does this text-select highlighter come
// up — selecting some words and changing the colour does not work." It was the
// highlight menu (src/notes/mark-menu.js): a click inside the editor reached the
// page's tap handler, which opened the BOX's menu, pinned to an empty SVG group
// in the corner of the window — and its swatches recoloured every word in the
// box, after first taking the focus away and putting the words down. That route
// is closed now (the editor keeps its clicks, src/documents/pdf-shape-text.js).
//
// What the reader was reaching for is real, though: these words, bolder, in
// red, highlighted. The box's words are markdown (src/documents/pdf-shape-
// markdown.js renders them into a `.rendered` body), so that is what this
// writes — the same syntax the Notes editor writes for the same press:
//
//   B  I          **…**  _…_               (toggleWrap, src/editor/text-transforms.js)
//   ● ● ● ●       <mark data-color="…">…</mark>   (the note's highlight tokens)
//   A A A  ⊘      <span style="color: …;">…</span> (applyInlineStyleProperty)
//
// ── Out of the way ─────────────────────────────────────────────────────────
//
// It is up only while there is a selection IN the editor: typing, a caret, a
// scroll, Escape or the box being put down all take it away. It never takes
// the focus (mousedown is refused here, and the editor's blur handler lets a
// press on it through), so the words stay open and the next key types on.
//
// ── How a press lands ──────────────────────────────────────────────────────
//
// The editor is plain text, so the selection is two character offsets into its
// text, the transform is a pure string function, and the change goes back in
// through execCommand("insertText") over exactly the span it touched — which
// keeps the editor's own undo (Ctrl+Z) and fires `input` like typing does. The
// same words are selected again afterwards, so B and then a colour stack.

import { MARK_HIGHLIGHT_COLORS, MARK_HIGHLIGHT_DEFAULT } from "../format/highlight-colors.js?v=__BUILD__";
import { INK_PEN_HEX } from "../format/ink-colors.js?v=__BUILD__";
import { applyInlineStyleProperty, clearInlineStyleProperty, matchWholeStyleSpan, parseInlineStyle, serializeInlineStyle, toggleWrap } from "../editor/text-transforms.js?v=__BUILD__";

export const SHAPE_TEXT_FORMAT_BAR_CLASS = "shape-text-format-bar";

// The same prefix src/format/highlight.js keeps outside a highlight — a list
// marker, a heading's #s, a quote's > — so a wrapped line is still that list
// item. Copied rather than imported: highlight.js reaches the notes editor and
// the deck store, which a module on the PDF's text box has no business loading.
const FORMAT_LINE_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:(?:[-*+]|\d+[.)])[ \t]+)*)/;
const FORMAT_MARK_WHOLE_RE = /^<mark(?:\s+data-color="([a-z]+)")?>([\s\S]*)<\/mark>$/;
const FORMAT_MARK_CLOSE = "</mark>";
const FORMAT_SPAN_CLOSE = "</span>";

const FORMAT_TEXT_COLOURS = [
  { name: "red", hex: INK_PEN_HEX.red },
  { name: "blue", hex: INK_PEN_HEX.blue },
  { name: "green", hex: INK_PEN_HEX.green }
];

let formatBar = null;
let formatEditorNode = null;
let formatBarFrame = 0;

function formatMarkTag(color) {
  return color && color !== MARK_HIGHLIGHT_DEFAULT ? `<mark data-color="${color}">` : "<mark>";
}

// ── Offsets in the editor's text ──────────────────────────────────────────
//
// What the editor's words are, as putShapeTextDown reads them (innerText): its
// text nodes, with a <br> — or a block a non-plaintext contenteditable wraps a
// new line in — as a "\n".
function walkEditorNodes(node, visit) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) visit(child, child.data.length);
    else if (child.nodeName === "BR") visit(child, 1);
    else if (child.nodeType === Node.ELEMENT_NODE) {
      if (/^(DIV|P)$/.test(child.nodeName) && child.previousSibling) visit(child, 1, true);
      walkEditorNodes(child, visit);
    }
  }
}

export function editorText(node) {
  let out = "";
  walkEditorNodes(node, (child) => {
    out += child.nodeType === Node.TEXT_NODE ? child.data : "\n";
  });
  return out;
}

// The offset of a DOM boundary (container, offset) in editorText(node): the
// text from the editor's start up to it, read the same way.
function editorOffsetOf(node, container, offset) {
  const probe = document.createRange();
  probe.selectNodeContents(node);
  try { probe.setEnd(container, offset); } catch (_) { return null; }
  const holder = document.createElement("div");
  holder.appendChild(probe.cloneContents());
  return editorText(holder).length;
}

// The DOM boundary for an offset in editorText(node).
function editorPointAt(node, target) {
  let remaining = target;
  let found = null;
  walkEditorNodes(node, (child, length, isBlockBreak) => {
    if (found) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if (remaining <= length) { found = [child, remaining]; return; }
      remaining -= length;
      return;
    }
    if (remaining === 0) {
      found = isBlockBreak ? [child, 0] : [child.parentNode, [...child.parentNode.childNodes].indexOf(child)];
      return;
    }
    remaining -= 1;
  });
  return found || [node, node.childNodes.length];
}

export function editorSelectionOffsets(node) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!node.contains(range.startContainer) || !node.contains(range.endContainer)) return null;
  const start = editorOffsetOf(node, range.startContainer, range.startOffset);
  const end = editorOffsetOf(node, range.endContainer, range.endOffset);
  if (start == null || end == null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function selectEditorOffsets(node, start, end) {
  const range = document.createRange();
  const [sc, so] = editorPointAt(node, start);
  const [ec, eo] = editorPointAt(node, end);
  range.setStart(sc, so);
  range.setEnd(ec, eo);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// ── The transforms ────────────────────────────────────────────────────────
//
// Each takes the editor's text and the selection and answers what span to
// replace ([from, to)), with what, and which part of the replacement to select
// afterwards (`pick`, relative to `from`).

function isEditorLineStart(value, index) {
  return index === 0 || value[index - 1] === "\n";
}

// A selection over several lines is wrapped a line at a time — inline markup
// cannot cross a line break in markdown — with each line's list marker or #s
// left outside. Pressed again over lines that are all wrapped, it unwraps them.
function wrapEachLine(value, start, end, wrap, unwrap, isWrapped) {
  const lines = value.slice(start, end).split("\n");
  const parts = lines.map((line, i) => {
    const prefix = i > 0 || isEditorLineStart(value, start) ? FORMAT_LINE_PREFIX_RE.exec(line)[0] : "";
    return [prefix, line.slice(prefix.length)];
  });
  const filled = parts.filter(([, rest]) => rest.trim());
  const off = filled.length > 0 && filled.every(([, rest]) => isWrapped(rest));
  const text = parts.map(([prefix, rest]) => {
    if (!rest.trim()) return prefix + rest;
    return prefix + (off ? unwrap(rest) : wrap(rest));
  }).join("\n");
  return { from: start, to: end, text, pick: [0, text.length] };
}

// ── What already wraps the picked words ──────────────────────────────────
//
// Pressed twice, a button takes off what it put on — but by the second press
// the words may have something else round them too: bold, then a colour, puts
// the colour's <span> between the words and the **. So a wrapper counts as
// "round these words" with any other inline markup in between (`fill`), and is
// taken off, or changed, there — leaving that markup where it is.
const FORMAT_LOOK_AROUND = 400;

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrapperAround(value, start, end, openSource, close, fill) {
  const before = new RegExp(`${openSource}(${fill})$`).exec(value.slice(Math.max(0, start - FORMAT_LOOK_AROUND), start));
  if (!before) return null;
  const after = new RegExp(`^(${fill})${escapeForRegExp(close)}`).exec(value.slice(end, end + FORMAT_LOOK_AROUND));
  if (!after) return null;
  const innerBefore = before[before.length - 1];
  return {
    from: start - before[0].length,
    to: end + after[0].length,
    groups: before.slice(1, -1),
    innerBefore,
    innerAfter: after[1]
  };
}

function emphasiseWords(value, start, end, marker) {
  if (value.slice(start, end).includes("\n")) {
    return wrapEachLine(value, start, end,
      (rest) => marker + rest + marker,
      (rest) => rest.slice(marker.length, rest.length - marker.length),
      (rest) => rest.length > marker.length * 2 && rest.startsWith(marker) && rest.endsWith(marker));
  }
  const words = value.slice(start, end);
  // Tags, and the OTHER emphasis markers, may sit between.
  const others = ["\\*\\*", "_", "~~"].filter((m) => m !== escapeForRegExp(marker)).join("|");
  const round = wrapperAround(value, start, end, escapeForRegExp(marker), marker, `(?:<[^<>]*>|${others})*`);
  if (round) {
    const text = round.innerBefore + words + round.innerAfter;
    return { from: round.from, to: round.to, text, pick: [round.innerBefore.length, round.innerBefore.length + words.length] };
  }
  const result = toggleWrap(value, start, end, marker);
  const at = result.text.indexOf(words);
  // Wrapped: the words inside the markers. Unwrapped: all that is left.
  const inner = at >= 0 ? [at, at + words.length] : [0, result.text.length];
  return { from: result.rangeStart, to: result.rangeEnd, text: result.text, pick: inner };
}

const FORMAT_FILL_BUT_MARK = String.raw`(?:<(?!\/?mark\b)[^<>]*>|\*\*|_|~~)*`;
const FORMAT_FILL_BUT_SPAN = String.raw`(?:<(?!\/?span\b)[^<>]*>|\*\*|_|~~)*`;

function highlightWords(value, start, end, color) {
  const open = formatMarkTag(color);
  if (value.slice(start, end).includes("\n")) {
    return wrapEachLine(value, start, end,
      (rest) => open + rest.replace(/^<mark[^>]*>/, "").replace(/<\/mark>$/, "") + FORMAT_MARK_CLOSE,
      (rest) => rest.replace(/^<mark[^>]*>/, "").replace(/<\/mark>$/, ""),
      (rest) => rest.startsWith(open) && rest.endsWith(FORMAT_MARK_CLOSE));
  }
  // Already inside a highlight — round the selection, or the selection is
  // exactly one: the same colour takes it off, another one recolours it.
  let from = start;
  let to = end;
  let words = value.slice(start, end);
  let lead = 0;
  let current = null;
  const round = wrapperAround(value, start, end, String.raw`<mark(?:\s+data-color="([a-z]+)")?>`, FORMAT_MARK_CLOSE, FORMAT_FILL_BUT_MARK);
  if (round) {
    from = round.from;
    to = round.to;
    lead = round.innerBefore.length;
    current = round.groups[0] || MARK_HIGHLIGHT_DEFAULT;
    words = round.innerBefore + words + round.innerAfter;
  } else {
    const whole = FORMAT_MARK_WHOLE_RE.exec(words);
    if (whole && !whole[2].includes("<mark")) {
      current = whole[1] || MARK_HIGHLIGHT_DEFAULT;
      words = whole[2];
    }
  }
  const picked = round ? end - start : words.length;
  if (current === color) return { from, to, text: words, pick: [lead, lead + picked] };
  const text = open + words + FORMAT_MARK_CLOSE;
  return { from, to, text, pick: [open.length + lead, open.length + lead + picked] };
}

function colourWords(value, start, end, hex) {
  if (value.slice(start, end).includes("\n")) {
    return wrapEachLine(value, start, end,
      (rest) => hex ? applyInlineStyleProperty(rest, "color", hex) : clearInlineStyleProperty(rest, "color"),
      (rest) => rest,
      () => false);
  }
  const words = value.slice(start, end);
  // A colour already on these words is merged into, not nested inside.
  const round = wrapperAround(value, start, end, String.raw`<span style="([^"]*)">`, FORMAT_SPAN_CLOSE, FORMAT_FILL_BUT_SPAN);
  if (round) {
    const props = parseInlineStyle(round.groups[0]);
    if (hex) props.color = hex;
    else delete props.color;
    const inner = round.innerBefore + words + round.innerAfter;
    const open = Object.keys(props).length ? `<span style="${serializeInlineStyle(props)}">` : "";
    const text = open ? open + inner + FORMAT_SPAN_CLOSE : inner;
    const at = open.length + round.innerBefore.length;
    return { from: round.from, to: round.to, text, pick: [at, at + words.length] };
  }
  const text = hex ? applyInlineStyleProperty(words, "color", hex) : clearInlineStyleProperty(words, "color");
  const inner = matchWholeStyleSpan(text)?.inner ?? text;
  const at = text.lastIndexOf(inner);
  return { from: start, to: end, text, pick: [Math.max(0, at), Math.max(0, at) + inner.length] };
}

export function formatShapeText(value, start, end, action) {
  if (!(end > start)) return null;
  if (action.kind === "bold") return emphasiseWords(value, start, end, "**");
  if (action.kind === "italic") return emphasiseWords(value, start, end, "_");
  if (action.kind === "highlight") return highlightWords(value, start, end, action.color);
  if (action.kind === "color") return colourWords(value, start, end, action.hex || null);
  return null;
}

// Apply one press to the editor's current selection.
export function applyShapeTextFormat(node, action) {
  const offsets = editorSelectionOffsets(node);
  if (!offsets || offsets.end <= offsets.start) return false;
  const change = formatShapeText(editorText(node), offsets.start, offsets.end, action);
  if (!change) return false;
  selectEditorOffsets(node, change.from, change.to);
  // Through the editing pipeline, not a textContent write: the editor's undo
  // keeps the step and `input` fires as it does for a key.
  const inserted = document.execCommand("insertText", false, change.text);
  if (!inserted) {
    const value = editorText(node);
    node.textContent = value.slice(0, change.from) + change.text + value.slice(change.to);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  selectEditorOffsets(node, change.from + change.pick[0], change.from + change.pick[1]);
  queueFormatBarPlace();
  return true;
}

// ── The bar ───────────────────────────────────────────────────────────────

function formatButtonHtml(attrs, label, inner, extraClass = "") {
  const data = Object.entries(attrs).map(([k, v]) => ` data-${k}="${v}"`).join("");
  return `<button type="button" class="stf-btn${extraClass}"${data} title="${label}" aria-label="${label}">${inner}</button>`;
}

function buildFormatBar() {
  const root = document.createElement("div");
  root.className = SHAPE_TEXT_FORMAT_BAR_CLASS;
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Format the selected words");
  root.hidden = true;
  root.innerHTML = [
    formatButtonHtml({ format: "bold" }, "Bold (Ctrl+B)", "<b>B</b>"),
    formatButtonHtml({ format: "italic" }, "Italic (Ctrl+I)", "<i>I</i>"),
    '<span class="stf-sep" aria-hidden="true"></span>',
    ...MARK_HIGHLIGHT_COLORS.map((c) => formatButtonHtml({ format: "highlight", color: c.value }, `Highlight ${c.name.toLowerCase()}`, "", ` stf-hl" style="--sw: ${c.swatch};`)),
    '<span class="stf-sep" aria-hidden="true"></span>',
    ...FORMAT_TEXT_COLOURS.map((c) => formatButtonHtml({ format: "color", hex: c.hex }, `Text colour ${c.name}`, "A", ` stf-color" style="--sw: ${c.hex};`)),
    formatButtonHtml({ format: "color", hex: "" }, "Clear text colour", "&#8856;", " stf-clear")
  ].join("");
  // Never the focus: the words being typed keep it.
  root.addEventListener("mousedown", (event) => event.preventDefault());
  root.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target.closest("[data-format]");
    if (!target || !formatEditorNode) return;
    pressFormatButton(target);
  });
  // The keyboard's own press — a click with no pointer behind it.
  root.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const target = event.target.closest("[data-format]");
    if (target && formatEditorNode) pressFormatButton(target);
  });
  document.body.appendChild(root);
  return root;
}

function pressFormatButton(target) {
  const { format, color, hex } = target.dataset;
  if (!formatEditorNode) return;
  if (document.activeElement !== formatEditorNode) formatEditorNode.focus({ preventScroll: true });
  applyShapeTextFormat(formatEditorNode, { kind: format, color, hex });
}

function hideFormatBar() {
  if (formatBar) formatBar.hidden = true;
}

function placeFormatBar() {
  formatBarFrame = 0;
  if (!formatBar || !formatEditorNode || !formatEditorNode.isConnected) { hideFormatBar(); return; }
  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || range.collapsed || !formatEditorNode.contains(range.commonAncestorContainer)
      || !range.toString().length) {
    hideFormatBar();
    return;
  }
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
  const first = rects[0] || range.getBoundingClientRect();
  formatBar.hidden = false;
  const size = formatBar.getBoundingClientRect();
  const margin = 8;
  let top = first.top - size.height - 6;
  if (top < margin) {
    const last = rects[rects.length - 1] || first;
    top = Math.min(last.bottom + 6, window.innerHeight - size.height - margin);
  }
  const left = Math.min(Math.max(margin, first.left), Math.max(margin, window.innerWidth - size.width - margin));
  formatBar.style.top = `${Math.round(Math.max(margin, top))}px`;
  formatBar.style.left = `${Math.round(left)}px`;
}

function queueFormatBarPlace() {
  if (formatBarFrame) return;
  formatBarFrame = requestAnimationFrame(placeFormatBar);
}

function onFormatSelectionChange() {
  if (formatEditorNode) queueFormatBarPlace();
}

function onFormatBarScroll(event) {
  if (formatBar && event.target && formatBar.contains?.(event.target)) return;
  hideFormatBar();
}

// While the words of a box are open: the bar follows the selection in them.
export function attachShapeTextFormatBar(node) {
  detachShapeTextFormatBar();
  formatEditorNode = node;
  formatBar = formatBar?.isConnected ? formatBar : buildFormatBar();
  document.addEventListener("selectionchange", onFormatSelectionChange);
  document.addEventListener("scroll", onFormatBarScroll, true);
  node.addEventListener("keydown", onFormatKey);
}

export function detachShapeTextFormatBar() {
  if (formatEditorNode) formatEditorNode.removeEventListener("keydown", onFormatKey);
  formatEditorNode = null;
  document.removeEventListener("selectionchange", onFormatSelectionChange);
  document.removeEventListener("scroll", onFormatBarScroll, true);
  if (formatBarFrame) { cancelAnimationFrame(formatBarFrame); formatBarFrame = 0; }
  hideFormatBar();
}

export function isShapeTextFormatBarOpen() {
  return Boolean(formatBar && !formatBar.hidden);
}

// Ctrl/Cmd+B and +I do in the box what they do in a note.
function onFormatKey(event) {
  if (!formatEditorNode) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key !== "b" && key !== "i") return;
  event.preventDefault();
  applyShapeTextFormat(formatEditorNode, { kind: key === "b" ? "bold" : "italic" });
}
