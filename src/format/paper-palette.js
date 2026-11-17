// The theme's own colours, made to read on the paper they are shown on.
//
// A near-leaf beside ./paper-tones.js, and importing nothing else: the Document
// surface, the region pictures, the export and the Block style panel all read
// it, and the diagram renderer (src/render/enhance.js) reaches it from the
// markdown pipeline, which must not drag the Document surface in behind it.
//
// ── Why a palette and not just a paper ─────────────────────────────────────
//
// styles/94-paper-tones.css rebinds the theme's NEUTRAL tokens inside a page —
// the card, the text, the lines — to the paper's, so a Block on White under a
// dark theme is a light card with dark words. The ACCENTS were left as the
// theme's, and they are what a heading, a link, a quote bar, a table's header,
// inline code and a Block's border are drawn in: AMOLED's pale cyan h1 on White
// paper is a heading nobody can read, and Snow's dark blue link on Black the
// same the other way round. "Only certain parts of the blocks change with the
// theme" was exactly that split.
//
// So each accent is kept in the theme's own HUE and moved in lightness until it
// reads on the paper (readableOnPaper — the rule a reader's own pen colour has
// always been drawn by). On "Match theme" the page IS the theme, every accent
// already reads, and nothing moves.
//
// The values are written as inline custom properties on the stage (and copied
// onto the off-screen host a page's picture is drawn in), and the rebinding
// itself — --accent: var(--paper-accent, …) — is CSS, in 94-paper-tones.css.
// Computed once per theme or paper change; nothing here runs per paint.

import { PAPER_TEXT, contrastRatio, mixHex, parseHex, readableOnPaper, rgbToHex } from "./paper-tones.js?v=__BUILD__";

// [the theme's token, the property written, the contrast it must reach on the
// paper]. 4.5 for the two that are WORDS — a heading or a link in the strong
// accent, inline code in the review colour — and 3 for what is drawn as a line,
// a bar or a tint.
export const PAPER_PALETTE_TOKENS = [
  ["--accent", "--paper-accent", 3],
  ["--accent-strong", "--paper-accent-strong", 4.5],
  ["--review", "--paper-review", 4.5],
  ["--known", "--paper-known", 3],
  ["--danger", "--paper-danger", 3]
];

// Every property applyPaperPalette writes, and so every one copyPaperPalette
// carries — the paper's own two included.
export const PAPER_PALETTE_PROPERTIES = [
  "--paper-bg",
  "--paper-text",
  "--paper-accent-contrast",
  ...PAPER_PALETTE_TOKENS.map(([, property]) => property)
];

// What a theme token holds, as a hex: the tokens are hex in styles/01-tokens.css,
// and a browser may hand back rgb() for one somebody writes differently.
export function colourToHex(value) {
  const text = String(value || "").trim();
  if (parseHex(text)) return rgbToHex(parseHex(text));
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(text);
  return rgb ? rgbToHex([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]) : null;
}

// The theme in force, read off <html> — the one place every theme's tokens are
// resolved. Anything unreadable is left out, and its property is then not
// written, so the CSS falls back to the theme's own value.
export function readThemeTokens(root = typeof document !== "undefined" ? document.documentElement : null) {
  const tokens = {};
  if (!root || typeof getComputedStyle !== "function") return tokens;
  const style = getComputedStyle(root);
  PAPER_PALETTE_TOKENS.forEach(([token]) => {
    const hex = colourToHex(style.getPropertyValue(token));
    if (hex) tokens[token] = hex;
  });
  return tokens;
}

// { property: value } for a tone ({ bg, dark, text } from resolvePaperTone) and
// the theme's tokens. Pure, so tools/paper-tones-check.mjs can hold every theme
// against every paper.
export function paperPalette(tone, tokens = {}) {
  const bg = colourToHex(tone?.bg) || "#ffffff";
  const dark = Boolean(tone?.dark);
  const text = colourToHex(tone?.text) || (dark ? PAPER_TEXT.dark : PAPER_TEXT.light);
  const out = { "--paper-bg": bg, "--paper-text": text };
  PAPER_PALETTE_TOKENS.forEach(([token, property, min]) => {
    const hex = colourToHex(tokens[token]);
    if (hex) out[property] = readableOnPaper(hex, bg, min);
  });
  // Words ON the accent (a pressed control, a filled badge): whichever of the
  // two neutrals stands out more from the accent as it is on this paper.
  const accent = out["--paper-accent"];
  if (accent) {
    out["--paper-accent-contrast"] = contrastRatio("#ffffff", accent) >= contrastRatio(PAPER_TEXT.light, accent)
      ? "#ffffff"
      : PAPER_TEXT.light;
  }
  return out;
}

// Puts the palette on a node — a stage, or a host a page is pictured in.
export function applyPaperPalette(node, tone, tokens = readThemeTokens()) {
  if (!node?.style) return;
  const palette = paperPalette(tone, tokens);
  PAPER_PALETTE_PROPERTIES.forEach((property) => {
    if (palette[property]) node.style.setProperty(property, palette[property]);
    else node.style.removeProperty(property);
  });
}

// The same palette on another node: what a stage says, said again where a copy
// of its page is drawn (the region picture's host, the export's, the Block style
// panel's chips). The stage's polarity goes with it, as the class the paper's
// dark rules answer to off the stage.
export function copyPaperPalette(from, to) {
  if (!to?.style) return;
  const source = from && typeof getComputedStyle === "function" ? getComputedStyle(from) : null;
  PAPER_PALETTE_PROPERTIES.forEach((property) => {
    const value = (from?.style?.getPropertyValue(property) || source?.getPropertyValue(property) || "").trim();
    if (value) to.style.setProperty(property, value);
    else to.style.removeProperty(property);
  });
  to.classList?.toggle("is-dark-paper", Boolean(from?.classList?.contains("is-pdf-inverted")));
}

// The page number's grey: the paper's words at 60% on the paper. White comes out
// at about rgb(115 116 119), which is the grey the numbers have always been; a
// tinted or dark paper gets the same strength of its own words rather than a
// grey that was chosen for white.
export function paperNumberColor(tone) {
  const bg = colourToHex(tone?.bg) || "#ffffff";
  const text = colourToHex(tone?.text) || (tone?.dark ? PAPER_TEXT.dark : PAPER_TEXT.light);
  return mixHex(text, bg, 0.4);
}

// ── Diagrams ──────────────────────────────────────────────────────────────
//
// mermaid and nomnoml take their colours as values at render time, and neither
// can be handed a var() or a color-mix() — which is what getComputedStyle gives
// back for the page's --panel-2, --muted and --line. So the page's colours are
// worked out here, from the three hexes the page holds, with the same mixes
// styles/94-paper-tones.css uses. null for a diagram that is not on a page: the
// notes and the cards keep the theme-wide configuration they have always had.
const PAGE_HOSTS = ".document-stage .pdf-page, .paper-tokens, .region-block-host";

export function diagramPaletteFor(node) {
  const host = node?.closest?.(PAGE_HOSTS);
  if (!host || typeof getComputedStyle !== "function") return null;
  const style = getComputedStyle(host);
  const bg = colourToHex(style.getPropertyValue("--paper-bg"));
  if (!bg) return null;
  const text = colourToHex(style.getPropertyValue("--paper-text")) || PAPER_TEXT.light;
  const accent = colourToHex(style.getPropertyValue("--paper-accent"))
    || colourToHex(style.getPropertyValue("--accent"))
    || text;
  return {
    bg,
    card: bg,
    panel: bg,
    panel2: mixHex(bg, text, 0.06),
    text,
    muted: mixHex(bg, text, 0.62),
    line: mixHex(bg, text, 0.18),
    accent,
    dark: contrastRatio("#ffffff", bg) > contrastRatio("#000000", bg)
  };
}
