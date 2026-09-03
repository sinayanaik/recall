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
export const INK_PEN_HEX = {
  ink: "#16181d",
  red: "#dc2626",
  blue: "#2563eb",
  green: "#15803d",
  amber: "#d97706"
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

// ── Nib widths ─────────────────────────────────────────────────────────────
//
// In PDF points, because that is the space a stroke is stored in and a width
// that meant CSS pixels would change thickness with the zoom it was drawn at.
// Four sizes rather than a slider: a slider invites a decision nobody wants to
// make mid-sentence, and the useful range for handwriting on a paper is narrow.
// 1.2 is a fineliner in a margin, 6 is a marker round a figure.
export const INK_WIDTHS = [1.2, 2, 3.4, 6];

export const INK_WIDTH_DEFAULT = 2;

export function normalizeInkWidth(width) {
  const value = Number(width);
  if (!Number.isFinite(value)) return INK_WIDTH_DEFAULT;
  // Snapped to the offered set rather than clamped: a width that arrived from a
  // device with a different palette should become one of ours, not a fifth size
  // that no button on the rail is ever shown as selected for.
  let best = INK_WIDTHS[0];
  let bestGap = Math.abs(value - best);
  INK_WIDTHS.forEach((candidate) => {
    const gap = Math.abs(value - candidate);
    if (gap < bestGap) { best = candidate; bestGap = gap; }
  });
  return best;
}

// ── Tools ──────────────────────────────────────────────────────────────────
//
// "pen" draws, "eraser" removes whole strokes, "lasso" selects them. There is
// deliberately no highlighter: this app already has a highlighter, it marks the
// words you selected, and a second one that paints a band wherever the nib went
// would be two features answering to one name.
export const INK_TOOLS = ["pen", "eraser", "lasso"];

export const INK_TOOL_DEFAULT = "pen";

export function normalizeInkTool(tool) {
  return INK_TOOLS.includes(String(tool || "")) ? String(tool) : INK_TOOL_DEFAULT;
}
