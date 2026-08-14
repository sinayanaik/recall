// The highlight palette, as a LEAF module — it imports nothing.
//
// It has to be a leaf because other modules read these at module-evaluation
// time: render-toolbar.js seeds its persisted default from MARK_HIGHLIGHT_HEX
// in a top-level initialiser. While these lived in highlight.js, which takes
// part in an import cycle, that initialiser ran before highlight.js had been
// evaluated and threw "Cannot access 'MARK_HIGHLIGHT_HEX' before
// initialization" — the app did not boot.
//
// Anything read by a top-level initialiser in another module belongs in a leaf.

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
