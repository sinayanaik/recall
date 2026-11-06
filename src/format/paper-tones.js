// The papers a PDF or a Canvas can be shown on, and how a colour is kept
// readable on whichever one is under it.
//
// A near-leaf: it imports the theme catalog, which imports nothing, and nothing
// else — the Document surface, the ink painter, the shape painter and the ink
// sheet all read it, and src/render/annot-shapes.js and src/format/ink-colors.js
// must stay leaves themselves, so the colour arithmetic lives here and is handed
// to them as a function.
//
// ── Why tones and not "dark page on/off" ───────────────────────────────────
//
// The page used to have two looks: white, and white inverted onto #030303. The
// Canvas followed the theme by POLARITY only, so Navy, Forest and Bronze all
// wrote on the same pure-black sheet, and a reader who wanted a sepia page for a
// long read had nothing to ask for. A tone is a polarity (which pen set, which
// blend for the highlighter, whether the pixels are inverted) plus a paper
// colour — the colour the page's white becomes on a light tone, or the floor its
// black is lifted to on a dark one.
//
// White and Black are the two looks that already existed, and they keep the
// keys ("light", "dark") that every kept picture on every device was written
// under, so nothing has to be drawn again for a reader who never picks another.

import { themeAliases, themeCatalog } from "../ui/theme-catalog.js?v=__BUILD__";

export const PAPER_TONE_THEME = "theme";

// The floor a dark page is lifted to. Never pure black: canvasLostItsPixels
// (src/documents/pdf-view.js) reads "pure black at every probe point" as a
// bitmap the browser cleared.
export const PAPER_DARK_FLOOR = "#030303";

export const PAPER_WHITE = "#ffffff";

export const PAPER_TONES = [
  { id: "white", label: "White", dark: false, bg: PAPER_WHITE },
  { id: "sepia", label: "Sepia", dark: false, bg: "#f4ecd8" },
  { id: "dim", label: "Dim", dark: true, bg: "#26282d" },
  { id: "black", label: "Black", dark: true, bg: PAPER_DARK_FLOOR },
  { id: PAPER_TONE_THEME, label: "Match theme", dark: null, bg: null }
];

export const PAPER_TONE_IDS = PAPER_TONES.map((tone) => tone.id);

// The words on a page of each polarity: the `ink` pen of each set
// (INK_PEN_HEX / INK_PEN_HEX_DARK in ./ink-colors.js), restated because that
// file is a leaf and this one must not make it anything else.
export const PAPER_TEXT = { light: "#16181d", dark: "#e8eaed" };

export function normalizePaperToneId(id, fallback = "white") {
  const value = String(id || "");
  return PAPER_TONE_IDS.includes(value) ? value : fallback;
}

// ── Colour arithmetic ──────────────────────────────────────────────────────

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!match) return null;
  let digits = match[1].toLowerCase();
  if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
}

export function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function channelLuminance(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return (0.2126 * channelLuminance(rgb[0])) + (0.7152 * channelLuminance(rgb[1])) + (0.0722 * channelLuminance(rgb[2]));
}

// WCAG contrast ratio, 1 … 21.
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d) + (gn < bn ? 6 : 0);
  else if (max === gn) h = ((bn - rn) / d) + 2;
  else h = ((rn - gn) / d) + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - (l * s);
  const p = (2 * l) - q;
  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + ((q - p) * 6 * x);
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + ((q - p) * ((2 / 3) - x) * 6);
    return p;
  };
  return [hue(h + (1 / 3)) * 255, hue(h) * 255, hue(h - (1 / 3)) * 255];
}

function mixHex(a, b, amountOfB) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return rgbToHex(x.map((v, i) => v + ((y[i] - v) * amountOfB)));
}

export function isDarkColor(hex) {
  return relativeLuminance(hex) < 0.18;
}

// ── Keeping a colour readable on the paper under it ────────────────────────
//
// A colour the reader picked themselves — a custom pen, a shape's line, a text
// box's words and border — is stored as the hex they picked, on whatever paper
// they happened to be looking at. On another paper it can be the colour of the
// page: black text on Black, a pale yellow on White. The stored value is never
// touched; what is PAINTED is, and only when it would not read: a colour that
// already clears the bar is drawn exactly as picked.
//
// The twin is the colour with its lightness flipped and its hue and saturation
// kept — a dark red becomes a light red, black becomes white — which is what
// the page's own content does under the dark page's invert-and-rotate, so a
// reader's mark and the print beside it change the same way. A mid-grey has no
// useful twin (flipping 50% lands on 50%), so if the flip still does not read,
// it is pulled toward the paper's own text colour until it does.
export const PAPER_MIN_CONTRAST = 2.2;

const readableCache = new Map();
const READABLE_CACHE_MAX = 1024;

export function readableOnPaper(hex, paperBg, min = PAPER_MIN_CONTRAST) {
  const colour = parseHex(hex);
  const bg = parseHex(paperBg);
  if (!colour || !bg) return hex;
  const key = `${hex}|${paperBg}|${min}`;
  const cached = readableCache.get(key);
  if (cached) return cached;
  let out = hex;
  if (contrastRatio(hex, paperBg) < min) {
    const [h, s, l] = rgbToHsl(colour);
    out = rgbToHex(hslToRgb([h, s, 1 - l]));
    if (contrastRatio(out, paperBg) < min) {
      const text = isDarkColor(paperBg) ? PAPER_TEXT.dark : PAPER_TEXT.light;
      let step = 0.2;
      let mixed = out;
      while (step <= 1 && contrastRatio(mixed, paperBg) < min) {
        mixed = mixHex(out, text, step);
        step += 0.2;
      }
      out = contrastRatio(mixed, paperBg) >= min ? mixed : text;
    }
  }
  if (readableCache.size >= READABLE_CACHE_MAX) readableCache.clear();
  readableCache.set(key, out);
  return out;
}

// A recolour function for a paper, in the shape src/render/annot-shapes.js
// takes: anything that is not a hex (none, transparent, a CSS variable) is
// passed through untouched.
export function paperRecolor(paperBg) {
  if (!parseHex(paperBg)) return null;
  return (colour) => (parseHex(colour) ? readableOnPaper(colour, paperBg) : colour);
}

// ── Resolving a tone ───────────────────────────────────────────────────────

function themeFor(themeId) {
  const id = String(themeId || "");
  return themeCatalog.find((theme) => theme.id === (themeAliases[id] || id)) || null;
}

export function activeThemeId() {
  return typeof document !== "undefined" ? (document.documentElement?.dataset?.theme || "") : "";
}

function clampDarkFloor(hex) {
  const rgb = parseHex(hex) || parseHex(PAPER_DARK_FLOOR);
  const floor = parseHex(PAPER_DARK_FLOOR);
  return rgbToHex(rgb.map((v, i) => Math.max(v, floor[i])));
}

// Within this many steps of the plain paper on every channel is the plain
// paper: AMOLED's #050606 panel is black, Snow's #ffffff is white, and neither
// should cost every kept picture a second copy for a tint nobody can see.
const UNTINTED_SLACK = 3;

function nearly(hex, base) {
  const a = parseHex(hex);
  const b = parseHex(base);
  return Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) <= UNTINTED_SLACK);
}

// { id, dark, bg, tint, key } for a tone id under a theme.
//
//   dark   which polarity: the pen set, the highlighter's blend, whether the
//          page's pixels are inverted
//   bg     the paper's colour, as the eye sees it
//   tint   null for plain white and plain black — the two looks there have
//          always been — else the colour baked into the pixels (multiplied
//          into a light page, the floor a dark one is lifted to)
//   key    "light" / "dark" for those two, "light~f4ecd8" / "dark~26282d"
//          otherwise: what a kept picture is filed under, and what a canvas's
//          pixels are compared against to tell whether they are for this paper
export function resolvePaperTone(id, themeId = activeThemeId()) {
  const toneId = normalizePaperToneId(id);
  let dark;
  let bg;
  if (toneId === PAPER_TONE_THEME) {
    const theme = themeFor(themeId);
    // No theme attribute yet is the app's own default, a dark one.
    dark = theme ? theme.mode === "dark" : true;
    bg = theme?.colors?.panel || (dark ? PAPER_DARK_FLOOR : PAPER_WHITE);
  } else {
    const tone = PAPER_TONES.find((entry) => entry.id === toneId);
    dark = tone.dark;
    bg = tone.bg;
  }
  bg = dark ? clampDarkFloor(bg) : (rgbToHex(parseHex(bg) || parseHex(PAPER_WHITE)));
  const plain = dark ? PAPER_DARK_FLOOR : PAPER_WHITE;
  const tint = nearly(bg, plain) ? null : bg;
  if (!tint) bg = plain;
  return { id: toneId, dark, bg, tint, key: paperKey(dark, tint) };
}

// The key for pixels that are `dark` (inverted) and carry `tint` (or none).
export function paperKey(dark, tint = null) {
  const polarity = dark ? "dark" : "light";
  const rgb = tint ? parseHex(tint) : null;
  return rgb ? `${polarity}~${rgbToHex(rgb).slice(1)}` : polarity;
}

// The other direction: what a paper key says about the pixels filed under it.
export function paperKeyParts(key) {
  const text = String(key || "light");
  const [polarity, tint] = text.split("~");
  return { dark: polarity === "dark", tint: /^[0-9a-f]{6}$/.test(tint || "") ? `#${tint}` : null };
}

export function paperKeyBg(key) {
  const parts = paperKeyParts(key);
  return parts.tint || (parts.dark ? PAPER_DARK_FLOOR : PAPER_WHITE);
}
