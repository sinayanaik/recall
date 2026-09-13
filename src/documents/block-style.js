// What a block LOOKS like, as a small bag of tokens.
//
// A block on a page of working is markdown in a rectangle, and until this it was
// markdown in a rectangle and nothing else: one type size, one card, one colour,
// left-aligned, at whatever height the reader dragged the box to. The formatting
// strip in its editor styles runs INSIDE the markdown — a bold word, a coloured
// phrase — and there was no control anywhere over the block itself. "No dedicated
// text styling options for the text block" is that gap, and the missing half of it
// is the half a reader means by making a heading big, a warning red, a caption
// small, or a sticky note yellow.
//
// ── Why tokens and not the colours themselves ──────────────────────────────
//
// The same reason INK_PEN_HEX gives, and it applies harder here. A block sits on
// paper that follows the theme, on a surface that ALSO has an inverted-paper mode,
// in an app with ten themes. A hex chosen while writing on a light theme is a
// colour picked against a background the reader may never see again. So a fill is
// a NAME, resolved per theme to a custom property (--block-fill-<token>, defined
// in styles/58-block-style.css), and the ink is one of the pen tokens the handwriting
// beside it already uses — so a typed note and a written one can be the same
// colour, and stay the same colour on every theme and both papers.
//
// ── Why the sizes are multipliers ──────────────────────────────────────────
//
// The block's type is already sized against the page: `0.82rem * --pdf-block-scale`
// (styles/53-handwriting.css), so a pinch moves the words with the paper. A size
// chosen here must therefore be a factor of that and never a rem of its own, or
// the one property a reader picked would be the one property that stops following
// the zoom.
//
// This module is a leaf in the sense that matters: everything it imports is itself
// a leaf, and nothing here is read by another module's top-level initialiser.

import { INK_PEN_TOKENS, inkPenVar, normalizeInkPen } from "../format/ink-colors.js?v=__BUILD__";

// ── Fill ───────────────────────────────────────────────────────────────────
//
// `paper` is the card the block has always been, and it is the default so that
// every block already written looks exactly as it did. `clear` is the other end:
// no fill, no border, no shadow — type straight on the page, which is what a
// label beside a diagram wants and what the card was always in the way of.
// The six between are tints, and they are tints rather than solid colours for the
// reason MARK_HIGHLIGHT_HEX gives: an alpha over whatever is actually behind it
// reads correctly on a light page and a dark one, and a solid does not.
export const BLOCK_FILL_DEFAULT = "paper";

export const BLOCK_FILLS = ["paper", "clear", "yellow", "green", "blue", "pink", "violet", "grey"];

// The picker's own preview chips only — never written into a block, exactly as
// MARK_HIGHLIGHT_HEX is never written into a note. What lands on the page is the
// custom property.
export const BLOCK_FILL_HEX = {
  paper: "#f4f4f5",
  clear: "transparent",
  yellow: "#fde68a",
  green: "#bbf7d0",
  blue: "#bfdbfe",
  pink: "#fbcfe8",
  violet: "#ddd6fe",
  grey: "#d4d4d8"
};

export function normalizeBlockFill(token) {
  return BLOCK_FILLS.includes(String(token || "")) ? String(token) : BLOCK_FILL_DEFAULT;
}

// The custom property a fill token resolves against. Named here rather than built
// at each call site, for the reason inkPenVar is: styles/01-tokens.css and this
// file cannot then drift about what the property is called.
export function blockFillVar(token) {
  return `--block-fill-${normalizeBlockFill(token)}`;
}

// ── Ink ────────────────────────────────────────────────────────────────────
//
// "default" is the theme's own text colour and is not a pen: a block that has not
// been coloured must follow the theme, not be pinned to whatever near-black the
// pen palette calls `ink`. Everything else is a pen token, so the eight colours a
// reader can write in are the eight they can type in.
export const BLOCK_INK_DEFAULT = "default";

export const BLOCK_INKS = [BLOCK_INK_DEFAULT, ...INK_PEN_TOKENS];

export function normalizeBlockInk(token) {
  const value = String(token || "");
  if (value === BLOCK_INK_DEFAULT) return BLOCK_INK_DEFAULT;
  // Through the pen's own normaliser, so an unknown token lands on the pen
  // default rather than on a property that resolves to nothing and paints the
  // words the colour of the page.
  return INK_PEN_TOKENS.includes(value) ? normalizeInkPen(value) : BLOCK_INK_DEFAULT;
}

// null for the default, which is what tells the painter to leave `color` alone.
export function blockInkVar(token) {
  const value = normalizeBlockInk(token);
  return value === BLOCK_INK_DEFAULT ? null : inkPenVar(value);
}

// ── Size ───────────────────────────────────────────────────────────────────
//
// Five steps rather than a slider. A slider on a surface driven by a stylus is a
// gesture that competes with the pen, it needs a number beside it to mean
// anything, and the answer a reader actually wants is one of about five — the
// same argument INK_WIDTHS makes for four nibs instead of a thickness field.
export const BLOCK_SIZE_DEFAULT = "m";

// `m` is 1, and 1 is exactly the size every block on every page is today. That is
// the whole reason the ladder is centred rather than starting at the current size
// and going up: this is a bag of tokens that gets NORMALISED onto every block ever
// written, including the ones nobody has opened since. A default that meant
// anything but "leave it alone" would reflow every notebook in the library the
// first time this shipped — and a block whose box was dragged to fit its text at
// the old size would clip it at the new one.
//
// The steps are not linear: the gap that matters is between body text and a
// heading, so the top two are further apart than the bottom two.
export const BLOCK_SIZE_SCALE = { xs: 0.75, s: 0.875, m: 1, l: 1.35, xl: 1.8 };

export const BLOCK_SIZES = Object.keys(BLOCK_SIZE_SCALE);

export function normalizeBlockSize(token) {
  return Object.prototype.hasOwnProperty.call(BLOCK_SIZE_SCALE, String(token || ""))
    ? String(token)
    : BLOCK_SIZE_DEFAULT;
}

export function blockSizeScale(token) {
  return BLOCK_SIZE_SCALE[normalizeBlockSize(token)];
}

// ── Font ───────────────────────────────────────────────────────────────────
//
// Four, against the sixteen in the editor's own font menu, and the difference is
// what each is FOR. That menu wraps a run of markdown in a face chosen for its
// own sake; this says what kind of thing the whole block is — prose, a quotation,
// a fragment of code, or a hand. Sixteen names in a popover over a page would be a
// scroller inside a control that has to fit beside a picture.
export const BLOCK_FONT_DEFAULT = "sans";

export const BLOCK_FONTS = ["sans", "serif", "mono", "hand"];

export function normalizeBlockFont(token) {
  return BLOCK_FONTS.includes(String(token || "")) ? String(token) : BLOCK_FONT_DEFAULT;
}

// ── Alignment ──────────────────────────────────────────────────────────────
export const BLOCK_ALIGN_DEFAULT = "left";

export const BLOCK_ALIGNS = ["left", "center", "right"];

export function normalizeBlockAlign(token) {
  return BLOCK_ALIGNS.includes(String(token || "")) ? String(token) : BLOCK_ALIGN_DEFAULT;
}

// ── Frame ──────────────────────────────────────────────────────────────────
//
// Deliberately separate from the fill, because they answer different questions and
// a reader wants them in every combination: a yellow sticky with no border, a
// clear block with a hairline around it, a white card with a shadow. Folding the
// two into one "look" would have been fewer controls and a picker that cannot say
// what half of its results are.
export const BLOCK_FRAME_DEFAULT = "card";

export const BLOCK_FRAMES = ["card", "outline", "none"];

export function normalizeBlockFrame(token) {
  return BLOCK_FRAMES.includes(String(token || "")) ? String(token) : BLOCK_FRAME_DEFAULT;
}

// ── The bag ────────────────────────────────────────────────────────────────
//
// One object on the record rather than seven keys beside `md`. The merge carries
// keys it does not know about straight through and a whole block wins its merge by
// `at` (src/sync/document-sync.js), so nesting costs the sync nothing — and it
// keeps the record's top level about what the block IS.
export const BLOCK_STYLE_DEFAULT = {
  fill: BLOCK_FILL_DEFAULT,
  ink: BLOCK_INK_DEFAULT,
  size: BLOCK_SIZE_DEFAULT,
  font: BLOCK_FONT_DEFAULT,
  align: BLOCK_ALIGN_DEFAULT,
  frame: BLOCK_FRAME_DEFAULT,
  fit: false
};

export function normalizeBlockStyle(style) {
  const from = style && typeof style === "object" ? style : {};
  return {
    fill: normalizeBlockFill(from.fill),
    ink: normalizeBlockInk(from.ink),
    size: normalizeBlockSize(from.size),
    font: normalizeBlockFont(from.font),
    align: normalizeBlockAlign(from.align),
    frame: normalizeBlockFrame(from.frame),
    fit: Boolean(from.fit)
  };
}

// Whether a normalised style says anything at all.
//
// What this is FOR: a block that has never been styled must not grow a `style` key
// (see writeBlockStyle in ./pdf-blocks.js). Every block in every deck lives in one
// `meta.pdfBlocks` array that is re-sent whole on every push, so a default bag
// written onto records nobody touched is bytes on every sync of every device, for
// ever, saying nothing.
export function isDefaultBlockStyle(style) {
  const it = normalizeBlockStyle(style);
  return Object.keys(BLOCK_STYLE_DEFAULT).every((key) => it[key] === BLOCK_STYLE_DEFAULT[key]);
}
