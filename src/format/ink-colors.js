// The pen palette, as a LEAF module — it imports nothing.
//
// Same reason src/format/highlight-colors.js is one: the drawing sheet, the PDF
// surface and the tool rail all read these, one of them from a top-level
// initialiser, and a palette that took part in an import cycle would be read
// before it was evaluated. That has already cost this app a boot once.
//
// ── Why ink does not use the four highlight colours ────────────────────────
//
// A highlight is a TINT UNDER TEXT: `color-mix(in srgb, <hue> N%, transparent)`
// over whatever surface is behind it, which is what lets one token read
// correctly on all ten themes without a single theme-specific override. Ink is
// the opposite thing — opaque, on top, and the mark itself rather than a wash
// over someone else's mark. The four highlighter tints make weak, low-contrast
// handwriting; a yellow that is right at 30% alpha under a serif is unreadable
// as a 2pt line on a cream page.
//
// So ink gets pens. Five, which is the number that fits a rail on a phone
// without a disclosure, and they are the five a person actually reaches for:
// the default, a red for corrections, a blue and a green for two kinds of
// annotation, and one warm high-contrast tone.
//
// ── Why a token and not a colour ───────────────────────────────────────────
//
// What is STORED is the token. The token resolves to a CSS custom property, and
// the property is defined once per theme in styles/01-tokens.css — so a drawing
// made in a light theme is legible in a dark one, and stays legible when a
// theme is added. A hex value chosen at drawing time is a hex value that is
// wrong the moment the reader changes theme, which is the exact fault the
// highlight <span> had before it became a <mark data-color>.
//
// INK_PEN_HEX is the picker's own preview swatch and the fallback a canvas
// falls back TO — a canvas needs a real colour and cannot be handed a custom
// property — but the resolver reads the live property first and only lands here
// when there is no computed style to read (a print document, a detached node).
// It is never what a stroke records.

export const INK_PEN_DEFAULT = "ink";

// "ink" rather than "black": on a dark theme this token resolves to a near-white
// and calling it black in the source would make the next person fix the wrong
// thing. It is the pen you write with, whatever the page is.
// Eight rather than the five it started with. "The pen options are very limited"
// is a fair reading of a palette that could not tell a correction from a heading
// from a second worked example — three uses that a page of working has all at
// once. The three added are chosen to be told apart from the five that were
// already here AND from each other on a dark page, which is what ruled out a
// second blue and a second green.
export const INK_PEN_HEX = {
  ink: "#16181d",
  red: "#dc2626",
  blue: "#2563eb",
  green: "#15803d",
  amber: "#d97706",
  violet: "#7c3aed",
  teal: "#0d9488",
  pink: "#db2777"
};

export const INK_PEN_TOKENS = Object.keys(INK_PEN_HEX);

export const INK_PEN_COLORS = INK_PEN_TOKENS.map((token) => ({
  name: token === "ink" ? "Ink" : token[0].toUpperCase() + token.slice(1),
  value: token,
  swatch: INK_PEN_HEX[token]
}));

// The custom property a token resolves against. Kept here rather than built at
// each call site so that renaming one is a single edit, and so styles/52-ink.css
// and this file cannot drift about what the property is called.
export function inkPenVar(token) {
  return `--ink-pen-${normalizeInkPen(token)}`;
}

export function normalizeInkPen(token) {
  const value = String(token || "");
  return Object.prototype.hasOwnProperty.call(INK_PEN_HEX, value) ? value : INK_PEN_DEFAULT;
}

// The same pens on a DARK page. The table above is what a pen looks like on
// white paper, and styles/52-ink.css carries both sets as custom properties for
// the swatches; this is the canvas's copy of the dark set, for the surfaces that
// decide the paper themselves rather than taking the theme's word for it (see
// resolveInkPaint, src/render/ink-paint.js). tools/ink-check.mjs holds the two
// files to the same values, so they cannot drift.
export const INK_PEN_HEX_DARK = {
  ink: "#e8eaed",
  red: "#f87171",
  blue: "#7aa7ff",
  green: "#4ade80",
  amber: "#fbbf24",
  violet: "#c4a2ff",
  teal: "#5eead4",
  pink: "#f9a8d4"
};

// ── The highlighter's own colours ──────────────────────────────────────────
//
// The four this app has always highlighted in — the same hexes as
// MARK_HIGHLIGHT_HEX (./highlight-colors.js) and the `.pdf-mark` rules, so a
// band drawn over a scanned line is the same yellow as a highlight dragged
// across a line of text beside it — plus the two the notes surface already
// knows (styles/12-notes.css carries orange and purple marks). Restated rather
// than imported because this file is a leaf and must stay one.
//
// These are hues, not tints. A highlighter stroke is painted at its own opacity
// onto a layer that MULTIPLIES with the page (styles/72-ink-paper.css), which is
// what leaves the scanned words under it legible — the colour has to be the
// full hue for that arithmetic to come out as the familiar wash.
export const INK_HL_HEX = {
  yellow: "#e0b400",
  green: "#22c55e",
  blue: "#3b82f6",
  pink: "#ec4899",
  orange: "#f97316",
  purple: "#8b5cf6"
};

export const INK_HL_TOKENS = Object.keys(INK_HL_HEX);

export const INK_HL_COLORS = INK_HL_TOKENS.map((token) => ({
  name: token[0].toUpperCase() + token.slice(1),
  value: token,
  swatch: INK_HL_HEX[token]
}));

export const INK_HL_DEFAULT = "yellow";

// ── What a stroke's colour token can say ───────────────────────────────────
//
// A stroke stores ONE short word for its colour (src/format/ink-strokes.js:
// `^[a-z][a-z0-9]{0,15}$`), and for a long time that word was only ever one of
// the eight pens above. It now has to say three more things — that the stroke
// is a highlighter, that its colour is one the reader picked rather than a pen,
// and how opaque it is — and it says them INSIDE the same word, not in a new
// field:
//
//   red            a pen from the palette, fully opaque (what every stroke
//                  written before this was, and still reads the same)
//   x1e90ff        a pen in a colour of the reader's own: `x` and six hex digits
//   hyellow        a highlighter in one of INK_HL_HEX
//   hx1e90ff       a highlighter in a colour of the reader's own
//   …q35           any of the above at 35% — `q` and two digits, 10 to 99.
//                  No suffix is 100%, for both kinds, so there is no default
//                  hiding in the parser that a later build could disagree with.
//
// Why not a new field, or a new format version: a build that cannot read a
// stroke drops it from the page it is drawing, and the next time that build
// commits the page (src/documents/pdf-ink.js → setDocumentInkForPage, which
// replaces every ink mark on it) the stroke it could not read is tombstoned —
// on every device. A word this build does not understand, by contrast, still
// DECODES on an older one: it paints as the default pen, which is wrong for a
// few minutes until the service worker hands that device this build, and the
// record is never at risk.
//
// So palette names may never start with `h` or `x`, and may never contain `q`.
// That is the whole of what keeps this unambiguous, and ink-check holds every
// name in both palettes to it.
const INK_TOKEN_PARTS_RE = /^(h)?(?:x([0-9a-f]{6})|([a-z]+?))(?:q([1-9][0-9]))?$/;

export const INK_OPACITY_MIN = 0.1;

// Parses are memoised: this is asked once per stroke on every repaint of a page
// that may carry hundreds, and the answer for a given word never changes. A
// reader's palette is a handful of words, so the cap is only there for a page
// written in a thousand custom colours.
const inkTokenCache = new Map();
const INK_TOKEN_CACHE_MAX = 512;

// { kind: "pen" | "highlighter", name, hex, opacity } or null for a word this
// build does not understand. `name` is the palette entry (null for a custom
// colour) and `hex` is the colour of a custom one (null for a palette pen, whose
// colour depends on the paper and is resolved where the paper is known).
export function parseInkToken(token) {
  const text = String(token || "");
  if (inkTokenCache.has(text)) return inkTokenCache.get(text);
  let parsed = null;
  const match = INK_TOKEN_PARTS_RE.exec(text);
  if (match) {
    const kind = match[1] ? "highlighter" : "pen";
    const hex = match[2] ? `#${match[2]}` : null;
    const name = match[3] || null;
    const palette = kind === "highlighter" ? INK_HL_HEX : INK_PEN_HEX;
    const opacity = match[4] ? Number(match[4]) / 100 : 1;
    if (hex || (name && Object.prototype.hasOwnProperty.call(palette, name))) {
      parsed = Object.freeze({ kind, name: hex ? null : name, hex, opacity });
    }
  }
  if (inkTokenCache.size >= INK_TOKEN_CACHE_MAX) inkTokenCache.clear();
  inkTokenCache.set(text, parsed);
  return parsed;
}

export function isHighlighterToken(token) {
  return parseInkToken(token)?.kind === "highlighter";
}

// The other direction, and the ONLY place a token is spelled — so every writer
// produces the canonical form (lowercase hex, an opacity rounded to a whole
// percent, no suffix at 100%) and two strokes that look the same are the same
// word.
export function formatInkToken({ kind = "pen", name = null, hex = null, opacity = 1 } = {}) {
  const highlighter = kind === "highlighter";
  const palette = highlighter ? INK_HL_HEX : INK_PEN_HEX;
  const custom = normalizeInkHex(hex);
  let body;
  if (!custom && name && Object.prototype.hasOwnProperty.call(palette, name)) body = name;
  else if (custom) body = `x${custom.slice(1)}`;
  else body = highlighter ? INK_HL_DEFAULT : INK_PEN_DEFAULT;
  const percent = Math.round(normalizeInkOpacity(opacity) * 100);
  return `${highlighter ? "h" : ""}${body}${percent < 100 ? `q${percent}` : ""}`;
}

// A colour the reader typed or picked, as `#rrggbb`, or null. Three-digit hex is
// widened rather than refused — it is what a colour input may hand back on some
// engines and what anybody typing a colour by hand reaches for.
export function normalizeInkHex(hex) {
  const text = String(hex || "").trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(text);
  return long ? `#${long[1]}` : null;
}

export function normalizeInkOpacity(opacity) {
  const value = Number(opacity);
  if (!Number.isFinite(value)) return 1;
  // Rounded to the whole percent the token can carry, so what the slider shows
  // and what the stroke stores are the same number.
  return Math.round(Math.min(1, Math.max(INK_OPACITY_MIN, value)) * 100) / 100;
}

// The token a pen or highlighter is SET to — the rail, the preferences. Unlike
// a stroke's own token, which is kept as written whatever it says, this has to
// be one this build can draw with, so a word it cannot read becomes the kind's
// default rather than a pen nobody can see selected.
export function normalizeInkToken(token, kind = "pen") {
  const parsed = parseInkToken(token);
  if (parsed && parsed.kind === kind) return formatInkToken(parsed);
  return kind === "highlighter" ? INK_HL_TOKEN_DEFAULT : INK_PEN_DEFAULT;
}

// The highlighter as it comes out of the box: yellow, at the 35% a text
// highlight's yellow is mixed at (styles/36-document.css), so a band drawn over a
// scan and a highlight dragged over text read as the same mark.
export const INK_HL_OPACITY_DEFAULT = 0.35;

export const INK_HL_TOKEN_DEFAULT = formatInkToken({ kind: "highlighter", name: INK_HL_DEFAULT, opacity: INK_HL_OPACITY_DEFAULT });

// ── The colour a mark is FILED under ───────────────────────────────────────
//
// An ink mark sits in the Highlights panel beside text highlights, and every row
// there wears one of the four highlight tokens — so whatever the stroke was
// drawn in has to be mapped to the nearest of them. It was a five-entry table
// for the five pens it started with, and three pens and every custom colour
// since fell through to yellow: a reader who marks questions in violet could not
// sort them out from the corrections.
//
// Named colours keep a stated answer (what a reader means by a red pen is a
// correction, and that files as pink however the hues measure); a custom colour
// is placed by its hue, and anything too grey to have one — black ink, a pencil
// grey — files where the plain pen always has.
const INK_FILING_BY_NAME = {
  ink: "yellow", red: "pink", blue: "blue", green: "green", amber: "yellow",
  violet: "pink", teal: "green", pink: "pink",
  yellow: "yellow", orange: "yellow", purple: "pink"
};

export function inkFilingColor(token) {
  const parsed = parseInkToken(token);
  if (!parsed) return "yellow";
  if (parsed.name) return INK_FILING_BY_NAME[parsed.name] || "yellow";
  const hex = parsed.hex || "#000000";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.15) return "yellow";
  let hue;
  if (max === r) hue = ((g - b) / (max - min)) % 6;
  else if (max === g) hue = ((b - r) / (max - min)) + 2;
  else hue = ((r - g) / (max - min)) + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 285) return "pink";
  if (hue < 75) return "yellow";
  if (hue < 180) return "green";
  return "blue";
}

// ── Nib widths ─────────────────────────────────────────────────────────────
//
// In PDF points, because that is the space a stroke is stored in and a width
// that meant CSS pixels would change thickness with the zoom it was drawn at.
//
// This was four sizes and a refusal: "a slider invites a decision nobody wants
// to make mid-sentence". It was reported back as the thing it is — "I'm only
// seeing some preset pen sizes without any continuous customisation" — and the
// argument was never true of a reader who chooses their pen ONCE and then
// writes for an hour with it. So the width is continuous now, from a hairline to
// a marker, and the four sizes stay as one-tap presets beside the slider for the
// reader who does want to switch mid-sentence.
//
// The stored width was always tenths of a point (ink-strokes.js writes
// `round(w * 10)`), so nothing about the wire format moves: a 2.7pt stroke was
// representable all along and only the rail would not make one. An older build
// that meets one snaps its OWN pen preference to its nearest preset and paints
// the stroke at exactly the width it says.
export const INK_WIDTHS = [1.2, 2, 3.4, 6];

export const INK_WIDTH_DEFAULT = 2;

export const INK_WIDTH_RANGE = Object.freeze({ min: 0.3, max: 24 });

// Clamped and rounded to the tenth the format stores, rather than snapped to the
// presets — a width from the slider is meant exactly.
function normalizeInkRanged(value, range, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(range.max, Math.max(range.min, number)) * 10) / 10;
}

export function normalizeInkWidth(width) {
  return normalizeInkRanged(width, INK_WIDTH_RANGE, INK_WIDTH_DEFAULT);
}

// The highlighter's nib. Broad by default — 14pt covers a line of body text set
// at 10-12pt, which is the job — and wide enough at the top to sweep a heading
// or a whole line of a scanned table in one pass.
export const INK_HL_WIDTHS = [8, 14, 22, 32];

export const INK_HL_WIDTH_DEFAULT = 14;

export const INK_HL_WIDTH_RANGE = Object.freeze({ min: 4, max: 40 });

export function normalizeInkHlWidth(width) {
  return normalizeInkRanged(width, INK_HL_WIDTH_RANGE, INK_HL_WIDTH_DEFAULT);
}

// ── The slider's scale ─────────────────────────────────────────────────────
//
// Logarithmic, because the difference that matters is a RATIO: 0.5 to 1pt is as
// visible a change as 10 to 20pt, and a linear slider over 0.3-24 would spend
// its first sixteenth on every width a reader actually writes with. Here, at
// any point along the track, an equal movement is an equal proportional change.
//
// Positions are integers 0..INK_SLIDER_STEPS so an <input type=range> can carry
// them without floating point drift, and the round trip lands back on the same
// tenth of a point the stroke will store.
export const INK_SLIDER_STEPS = 1000;

export function inkWidthFromSlider(position, range = INK_WIDTH_RANGE) {
  const t = Math.min(1, Math.max(0, Number(position) / INK_SLIDER_STEPS)) || 0;
  return normalizeInkRanged(range.min * ((range.max / range.min) ** t), range, range.min);
}

export function inkSliderFromWidth(width, range = INK_WIDTH_RANGE) {
  const value = Math.min(range.max, Math.max(range.min, Number(width) || range.min));
  return Math.round((Math.log(value / range.min) / Math.log(range.max / range.min)) * INK_SLIDER_STEPS);
}

// ── Tools ──────────────────────────────────────────────────────────────────
//
// "pen" draws, "eraser" removes whole strokes, "lasso" selects them. There is
// deliberately no highlighter: this app already has a highlighter, it marks the
// words you selected, and a second one that paints a band wherever the nib went
// would be two features answering to one name.
//
// Which left that highlighter unreachable with the very thing most people would
// reach for it with. A stylus took every pointer it was given
// (inkTakesPointer, src/documents/pdf-ink.js), so on a paper it could draw and
// could not select — no highlight, no cloze, no copy, no phrase lifted out into
// a note, all of which the Document surface has had all along and only a finger
// or a mouse could get to.
//
// So "text" is the fourth, and it is deliberately not a fourth way of MARKING
// the page. It is the statement that the pen is not marking it: the ink layer
// stands down and the stylus drives the selection controller instead, which is
// how it reaches the highlighter the paragraph above says this app already has.
// It belongs in this list rather than in a mode flag of its own because the
// pen's rail is where a reader already goes to say what the pen does — and
// because everything that already reads a tool (the rail's pressed state, the
// per-device preference, the engine's own switch) then needs no new concept.
//
// Split in two because two surfaces ask different questions of this list. The
// three that MARK the page are every tool a surface with no text can offer: the
// drawing sheet inside a note (src/notes/ink-sheet.js) is blank paper for
// handwriting, and "select the words" there would be a button with nothing to
// act on. A paper and a notebook have text under the nib, so they carry all four
// — and their rail is markup rather than a loop, which is why the count is
// stated here and checked against what is on screen (tools/note-editor-check.mjs).
export const INK_DRAW_TOOLS = ["pen", "eraser", "lasso"];

export const INK_TOOLS = [...INK_DRAW_TOOLS, "text"];

export const INK_TOOL_DEFAULT = "pen";

export function normalizeInkTool(tool) {
  return INK_TOOLS.includes(String(tool || "")) ? String(tool) : INK_TOOL_DEFAULT;
}

// ── How the eraser works, and how big it is ────────────────────────────────
//
// "stroke" is what the eraser has always done: cross a mark anywhere and the
// whole mark goes. It is the right answer for crossing out a word and the wrong
// one for a single letter in the middle of a line of working written without
// lifting — there, "cross it and it all goes" means redoing the sentence.
//
// "part" rubs out only what the nib passed over and leaves the rest standing,
// splitting the stroke where it was cut (eraseFromInkStroke, ./ink-strokes.js).
// Both halves keep the mark id, so a cut word still has one note and one card.
//
// Stroke-whole stays the DEFAULT because it is the one that cannot surprise
// anybody: it removes exactly the thing you crossed.
export const INK_ERASE_MODES = ["stroke", "part"];

export const INK_ERASE_MODE_DEFAULT = "stroke";

export function normalizeInkEraseMode(mode) {
  return INK_ERASE_MODES.includes(String(mode || "")) ? String(mode) : INK_ERASE_MODE_DEFAULT;
}

// The eraser's own radius, in PDF points, on top of each stroke's half width —
// the same units and the same reasoning as INK_WIDTHS. There was no size at all
// before: a fixed 3 points of slack, chosen so that a stroke-eraser did not have
// to be aimed, which is generous for crossing out a word and far too coarse to
// rub out one letter now that "part" can.
//
// 3 stays the default so nothing changes for anyone who never opens the row.
// Continuous now, like the pen's nib and for the same reason; the four sizes stay
// as presets beside the slider.
export const INK_ERASER_SIZES = [1.5, 3, 7, 14];

export const INK_ERASER_SIZE_DEFAULT = 3;

export const INK_ERASER_RANGE = Object.freeze({ min: 0.5, max: 30 });

export function normalizeInkEraserSize(size) {
  return normalizeInkRanged(size, INK_ERASER_RANGE, INK_ERASER_SIZE_DEFAULT);
}

// ── ...and what it rubs out ────────────────────────────────────────────────
//
// A highlighter band laid over a line of handwriting is two marks in one place,
// and an eraser that takes both is an eraser that cannot take the highlight off
// a correction without taking the correction with it. So the eraser can be told
// which kind to touch. "all" is the default because it is what an eraser is.
export const INK_ERASE_TARGETS = ["all", "pen", "highlighter"];

export const INK_ERASE_TARGET_DEFAULT = "all";

export function normalizeInkEraseTarget(target) {
  return INK_ERASE_TARGETS.includes(String(target || "")) ? String(target) : INK_ERASE_TARGET_DEFAULT;
}
