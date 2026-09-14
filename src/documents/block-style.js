// What a block LOOKS like, as a small bag of values.
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
// ── Why the colours are tokens and the sizes are not ──────────────────────
//
// A fill is a NAME. The reason is INK_PEN_HEX's, and it applies harder here: a
// block sits on paper that follows the theme, on a surface that ALSO has an
// inverted-paper mode, in an app with ten themes, so a hex chosen while writing
// on a light one is a colour picked against a background the reader may never
// see again. Each token resolves per theme to a custom property
// (--block-fill-<token>, styles/58-block-style.css), and the ink tokens are the
// pen's own — so a typed note and a written one can be the same colour and stay
// the same colour on every theme and both papers.
//
// A SIZE has no such argument, and the first version of this file pretended it
// did: five named steps, xs to xl, which is five sizes and no sixth. It is a
// number now, in points, typed. That is the rule the app's own Style panel
// states above styleControlGroups — "every numeric control is a plain textbox,
// no sliders and no min/max clamps: whatever you type is what gets applied" —
// and points are the unit x, y, w, h and the pen's nib already use, so a size
// chosen here means the same thing at every zoom and in an export.
//
// Absent is not zero: a block with no size is the size a block has always been,
// which is what keeps every notebook already written exactly as it was.
//
// ── ...and why the FACE is a key rather than a family ─────────────────────
//
// src/ui/theme-catalog.js already carries thirty-two faces in six groups, the
// loader fetches any of them on demand, and the Style panel's two font pickers
// are drawn from that one list. A block picking from the same list costs no new
// table and no new machinery; the four hardcoded families this used to offer
// were a fifth of what the app already had.

import { INK_PEN_TOKENS, inkPenVar, normalizeInkPen } from "../format/ink-colors.js?v=__BUILD__";
import { fontFamilyChoices } from "../ui/theme-catalog.js?v=__BUILD__";

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

export const BLOCK_FILL_LABEL = {
  paper: "Paper",
  clear: "No fill",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  violet: "Violet",
  grey: "Grey"
};

export function normalizeBlockFill(token) {
  return BLOCK_FILLS.includes(String(token || "")) ? String(token) : BLOCK_FILL_DEFAULT;
}

// The custom property a fill token resolves against. Named here rather than built
// at each call site, for the reason inkPenVar is: styles/58-block-style.css and
// this file cannot then drift about what the property is called.
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

// ── Sizes, in points, typed ────────────────────────────────────────────────
//
// One parser for all three of them (the block's type, the code inside it, and a
// picture's width as a percent). null means "not set", which is the default and
// is a different thing from a number the reader typed.
//
// No clamping and no rounding to a step, per the Style panel's rule. The only
// judgements are that a size is a POSITIVE, FINITE number — 0, -4, "abc" and an
// empty box are all a reader saying "no size", not a reader asking for invisible
// type — and a ceiling far above any real answer, because a stray keystroke in a
// box that previews live should not paint a single letter a mile high while the
// second digit is still being typed.
export const BLOCK_SIZE_MAX = 400;

export function normalizeBlockNumber(value, max = BLOCK_SIZE_MAX) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(max, Math.round(number * 10) / 10);
}

// The five named steps this shipped with before it was a number, in the points
// they worked out to against the 13-point body they multiplied. Read only —
// nothing writes a token any more — so a block styled while the ladder existed
// keeps the size it was given.
const LEGACY_SIZE_POINTS = { xs: 10, s: 11, m: 13, l: 18, xl: 23 };

export function normalizeBlockSize(value) {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_SIZE_POINTS, value)) {
    return LEGACY_SIZE_POINTS[value];
  }
  return normalizeBlockNumber(value);
}

// ── Face ───────────────────────────────────────────────────────────────────
//
// A key of fontFamilyChoices, or "inherit" — the app font, which is what a block
// has always been set in. Validated against the table rather than against the
// PICKER's list (fontFamilyOptionGroups), for the reason that table's own comment
// gives: a face missing from every group still works, it is just unreachable from
// a dropdown, and a stored value must not be thrown away for that.
export const BLOCK_FONT_DEFAULT = "inherit";

export function normalizeBlockFont(key) {
  const value = String(key || "");
  return Object.prototype.hasOwnProperty.call(fontFamilyChoices, value) ? value : BLOCK_FONT_DEFAULT;
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
//
// Three named values and no number, unlike the sizes above — this is a genuinely
// closed set and not a ladder standing in for one.
export const BLOCK_FRAME_DEFAULT = "card";

export const BLOCK_FRAMES = ["card", "outline", "none"];

export const BLOCK_FRAME_LABEL = { card: "Card", outline: "Outline", none: "None" };

export function normalizeBlockFrame(token) {
  return BLOCK_FRAMES.includes(String(token || "")) ? String(token) : BLOCK_FRAME_DEFAULT;
}

// ── The bag ────────────────────────────────────────────────────────────────
//
// One object on the record rather than nine keys beside `md`. The merge carries
// keys it does not know about straight through and a whole block wins its merge by
// `at` (src/sync/document-sync.js), so nesting costs the sync nothing — and it
// keeps the record's top level about what the block IS.
//
// The last three are about what is INSIDE the block rather than about the block:
// a fenced code listing and a picture are the two pieces of markdown with a knob
// worth having on a page of working, and both are drawn by rules the app already
// has (see paintBlockStyle). They are in the same bag because they are the same
// kind of statement — how this one block should read — and a second bag would be
// a second thing to merge, migrate and forget.
// `fit` used to default to false — a block held whatever height it was dragged
// to, and a reader who typed past the bottom of it got an `overflow: auto`
// scrollbar inside a rectangle on a page nobody scrolls. "Instead of having a
// predefined size, dynamically set the size so it encompasses all the text
// inside" is that fault stated as the fix: the height a block starts at should
// be the height of what is written in it, not a guess made before anything was
// typed. `fitBlockHeight` already did this correctly on request; the only
// change is that no request should be needed. A block that has been
// deliberately resized carries an explicit `fit: false` in its own stored
// style (see writeBlockStyle) and keeps the height it was given — this default
// only reaches a block nobody has touched.
export const BLOCK_STYLE_DEFAULT = {
  fill: BLOCK_FILL_DEFAULT,
  ink: BLOCK_INK_DEFAULT,
  size: null,
  font: BLOCK_FONT_DEFAULT,
  align: BLOCK_ALIGN_DEFAULT,
  frame: BLOCK_FRAME_DEFAULT,
  fit: true,
  codeSize: null,
  codeWrap: false,
  imageWidth: null
};

// `fit` and `codeWrap` are the only two boolean fields in the bag, and unlike
// every field above — which falls back to its own named `_DEFAULT` when the
// key is missing — a bare `Boolean(from.x)` treats "missing" as `false`
// unconditionally, whatever `BLOCK_STYLE_DEFAULT` actually says. That was
// invisible for as long as both defaults WERE false: `Boolean(undefined)` and
// `BLOCK_STYLE_DEFAULT.fit` agreed by coincidence, not by construction. The
// moment `fit` stopped being false by default (see the comment on
// BLOCK_STYLE_DEFAULT), the coincidence broke: a block with no key at all
// normalised to `fit: false` here while `isDefaultBlockStyle` — which compares
// against `BLOCK_STYLE_DEFAULT.fit` directly — called that same absence
// "default", i.e. `fit: true`. Two functions disagreeing about what "no key"
// means is exactly the contract this whole file states at the top: "absent is
// not zero, it is whatever a block has always been" — and only the DEFAULT
// constant is allowed to say what that is.
function normalizeBlockFlag(value, fallback) {
  return value === undefined || value === null ? Boolean(fallback) : Boolean(value);
}

export function normalizeBlockStyle(style) {
  const from = style && typeof style === "object" ? style : {};
  return {
    fill: normalizeBlockFill(from.fill),
    ink: normalizeBlockInk(from.ink),
    size: normalizeBlockSize(from.size),
    font: normalizeBlockFont(from.font),
    align: normalizeBlockAlign(from.align),
    frame: normalizeBlockFrame(from.frame),
    fit: normalizeBlockFlag(from.fit, BLOCK_STYLE_DEFAULT.fit),
    codeSize: normalizeBlockSize(from.codeSize),
    codeWrap: normalizeBlockFlag(from.codeWrap, BLOCK_STYLE_DEFAULT.codeWrap),
    // A percent of the block's width, so its ceiling is not the type ceiling.
    imageWidth: normalizeBlockNumber(from.imageWidth, 100)
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
