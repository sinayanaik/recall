// Markdown → PDF: which font file draws which character.
//
// The text in a PDF made from markdown is REAL text — selectable, searchable,
// highlightable in the PDFs tab like any paper's — so the letters have to be in
// a font embedded in the file. The standard fourteen PDF fonts would cost
// nothing to embed, but they stop at Western European: one α, → or ≤ in a note
// and the line is wrong. So the fonts are Noto (and JetBrains Mono for code),
// from the same @fontsource packages the Style panel's webfonts come from
// (FONT_CDN_BASE in src/core/lib-loader.js), and only the subsets a document
// actually uses are fetched — a page of English fetches one 17KB file — and
// only the glyphs it uses are embedded (pdf-lib's `subset: true`): a page of
// text is a few KB.
//
// `.woff`, not `.woff2`: @pdf-lib/fontkit reads a WOFF2 file but cannot SUBSET
// one (it throws while encoding), and an embedded whole font is 40× the size.
//
// Pure: no DOM, no fetch. The browser half is md-pdf/fonts.js; the Node check
// (tools/md-pdf-check.mjs) loads the same files from npm.

export const MD_FONT_VERSION = "5.3.0";

// Each package's own unicode-range per subset file, copied from its
// unicode.json (identical in the three packages for the subsets they share).
// A range is a CLAIM about which file to fetch; whether the font really has a
// glyph is asked of the loaded font (hasGlyph), and a miss falls through.
const MD_LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const MD_LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const MD_GREEK = "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF";
const MD_GREEK_EXT = "U+1F00-1FFF";
const MD_CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const MD_CYRILLIC_EXT = "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F";
const MD_VIETNAMESE = "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB";
// The symbol fallbacks, behind every family's own subsets: Noto Sans Math
// (5.1.0 — the last release whose "math" file holds the arrows, relations and
// operators; 5.3.0's is Latin only) for → ≤ ∑ ∞ ∈ and the rest of a formula
// typed as text, then Noto Sans Symbols 2 for ★ ✓ ☐ ■ ● ⚠ and the like. Big
// files (200-290KB), fetched only by a document that uses one of their
// characters, and only the glyphs used are embedded.
const MD_MATH = "U+0302-0303,U+0305,U+0307-0308,U+0330,U+0391-03A1,U+03A3-03A9,U+03B1-03C9,U+03D1,U+03D5-03D6,U+03F0-03F1,U+03F4-03F5,U+2034-2037,U+2057,U+20D0-20DC,U+20E1,U+20E5-20EF,U+2102,U+210A-210E,U+2110-2112,U+2115,U+2119-211D,U+2124,U+2128,U+212C-212D,U+212F-2131,U+2133-2138,U+213C-2140,U+2145-2149,U+2190,U+2192,U+2194-21AE,U+21B0-21E5,U+21F1-21F2,U+21F4-2211,U+2213-2214,U+2216-22FF,U+2308-230B,U+2310,U+2319,U+231C-2321,U+2336-237A,U+237C,U+2395,U+239B-23B6,U+23D0,U+23DC-23E1,U+2474-2475,U+25AF,U+25B3,U+25B7,U+25BD,U+25C1,U+25CA,U+25CC,U+25FB,U+266D-266F,U+27C0-27FF,U+2900-2AFF,U+2B0E-2B11,U+2B30-2B4C,U+2BFE,U+FF5B,U+FF5D,U+1D400-1D7FF,U+1EE00-1EEFF";
const MD_SYMBOLS = "U+20DD-20E0,U+20E2-20E4,U+2150-218F,U+2190,U+2192,U+2194-2199,U+21AF,U+21E6-21F0,U+21F3,U+2218-2219,U+2299,U+22C4-22C6,U+2300-243F,U+2440-244A,U+2460-24FF,U+25A0-27BF,U+2800-28FF,U+2921-2922,U+2981,U+29BF,U+29EB,U+2B00-2BFF,U+4DC0-4DFF,U+FFF9-FFFB,U+10140-1018E,U+10190-1019C,U+101A0,U+101D0-101FD,U+102E0-102FB,U+10E60-10E7E,U+1D2C0-1D2D3,U+1D2E0-1D37F,U+1F000-1F0FF,U+1F100-1F1AD,U+1F1E6-1F1FF,U+1F30D-1F30F,U+1F315,U+1F31C,U+1F31E,U+1F320-1F32C,U+1F336,U+1F378,U+1F37D,U+1F382,U+1F393-1F39F,U+1F3A7-1F3A8,U+1F3AC-1F3AF,U+1F3C2,U+1F3C4-1F3C6,U+1F3CA-1F3CE,U+1F3D4-1F3E0,U+1F3ED,U+1F3F1-1F3F3,U+1F3F5-1F3F7,U+1F408,U+1F415,U+1F41F,U+1F426,U+1F43F,U+1F441-1F442,U+1F444,U+1F446-1F449,U+1F44C-1F44E,U+1F453,U+1F46A,U+1F47D,U+1F4A3,U+1F4B0,U+1F4B3,U+1F4B9,U+1F4BB,U+1F4BF,U+1F4C8-1F4CB,U+1F4D6,U+1F4DA,U+1F4DF,U+1F4E3-1F4E6,U+1F4EA-1F4ED,U+1F4F7,U+1F4F9-1F4FB,U+1F4FD-1F4FE,U+1F503,U+1F507-1F50B,U+1F50D,U+1F512-1F513,U+1F53E-1F54A,U+1F54F-1F5FA,U+1F610,U+1F650-1F67F,U+1F687,U+1F68D,U+1F691,U+1F694,U+1F698,U+1F6AD,U+1F6B2,U+1F6B9-1F6BA,U+1F6BC,U+1F6C6-1F6CF,U+1F6D3-1F6D7,U+1F6E0-1F6EA,U+1F6F0-1F6F3,U+1F6F7-1F6FC,U+1F700-1F7FF,U+1F800-1F80B,U+1F810-1F847,U+1F850-1F859,U+1F860-1F887,U+1F890-1F8AD,U+1F8B0-1F8BB,U+1F8C0-1F8C1,U+1F900-1F90B,U+1F93B,U+1F946,U+1F984,U+1F996,U+1F9E9,U+1FA00-1FA6F,U+1FA70-1FA7C,U+1FA80-1FA89,U+1FA8F-1FAC6,U+1FACE-1FADC,U+1FADF-1FAE9,U+1FAF0-1FAF8,U+1FB00-1FBFF";

function parseRanges(text) {
  return text.split(",").map((part) => {
    const [a, b] = part.replace(/^U\+/, "").split("-");
    const from = parseInt(a, 16);
    return [from, b ? parseInt(b, 16) : from];
  });
}

const MD_FONT_RANGES = {
  latin: parseRanges(MD_LATIN),
  "latin-ext": parseRanges(MD_LATIN_EXT),
  greek: parseRanges(MD_GREEK),
  "greek-ext": parseRanges(MD_GREEK_EXT),
  cyrillic: parseRanges(MD_CYRILLIC),
  "cyrillic-ext": parseRanges(MD_CYRILLIC_EXT),
  vietnamese: parseRanges(MD_VIETNAMESE),
  math: parseRanges(MD_MATH),
  symbols: parseRanges(MD_SYMBOLS)
};

// Subsets in the order they are tried. Devanagari (Noto Sans has it) is left
// out on purpose: it needs shaping — conjuncts, reordered vowel signs — which
// pdf-lib does not do, so its words are drawn as pictures instead
// (unsupported characters, below), which a canvas DOES shape.
export const MD_FONT_FAMILIES = {
  sans: { pkg: "noto-sans", version: MD_FONT_VERSION, subsets: ["latin", "latin-ext", "greek", "cyrillic", "vietnamese", "greek-ext", "cyrillic-ext"] },
  serif: { pkg: "noto-serif", version: MD_FONT_VERSION, subsets: ["latin", "latin-ext", "greek", "cyrillic", "vietnamese", "greek-ext", "cyrillic-ext"] },
  mono: { pkg: "jetbrains-mono", version: MD_FONT_VERSION, subsets: ["latin", "latin-ext", "greek", "cyrillic", "vietnamese", "cyrillic-ext"] },
  // One weight and style each: bold or italic text falls back to the regular.
  math: { pkg: "noto-sans-math", version: "5.1.0", subsets: ["math"], regularOnly: true },
  symbols: { pkg: "noto-sans-symbols-2", version: MD_FONT_VERSION, subsets: ["symbols"], regularOnly: true }
};

// The fallbacks, in the order they are tried after a family's own subsets.
const MD_FONT_FALLBACKS = ["math", "symbols"];

// OpenType features for every face, in measuring AND in embedding (the two
// must agree, or a line measured to fit is drawn wider). Ligatures off:
// JetBrains Mono's coding ligatures (`//`, `=>`, `!=`) are glyphs fontkit
// cannot read the metrics of in these subset files — it throws — and a "fi"
// drawn as one glyph is a worse thing to select and search than two. A
// fresh object each call: fontkit writes its defaults into the one it is given.
export function mdFontFeatures() {
  return { liga: false, calt: false, dlig: false };
}

export function inRanges(cp, ranges) {
  for (const [a, b] of ranges) if (cp >= a && cp <= b) return true;
  return false;
}

// "sans|latin|700|italic" — the one name a face goes by everywhere: the font
// map, the layout's text ops, the writer's embedded-font cache.
export function faceKey(family, subset, bold, italic) {
  return `${family}|${subset}|${bold ? 700 : 400}|${italic ? "italic" : "normal"}`;
}

export function parseFaceKey(key) {
  const [family, subset, weight, style] = String(key).split("|");
  return { family, subset, bold: weight === "700", italic: style === "italic" };
}

// Where the face's file is, relative to the @fontsource CDN base
// (`${FONT_CDN_BASE}${facePath(key)}`), and equally the path inside the npm
// package for the Node check.
export function facePath(key) {
  const { family, subset, bold, italic } = parseFaceKey(key);
  const fam = MD_FONT_FAMILIES[family];
  if (!fam) return "";
  return `${fam.pkg}@${fam.version}/files/${fam.pkg}-${subset}-${bold ? 700 : 400}-${italic ? "italic" : "normal"}.woff`;
}

// The faces worth trying for one character, best first: the family's own
// subsets whose range claims it, then the symbol fallbacks.
export function candidateFaces(cp, family, bold, italic) {
  const famName = MD_FONT_FAMILIES[family] && !MD_FONT_FAMILIES[family].regularOnly ? family : "sans";
  const fam = MD_FONT_FAMILIES[famName];
  const out = [];
  for (const subset of fam.subsets) {
    if (inRanges(cp, MD_FONT_RANGES[subset])) out.push(faceKey(famName, subset, bold, italic));
  }
  for (const name of MD_FONT_FALLBACKS) {
    for (const subset of MD_FONT_FAMILIES[name].subsets) {
      if (inRanges(cp, MD_FONT_RANGES[subset])) out.push(faceKey(name, subset, false, false));
    }
  }
  return out;
}

// Characters that are never drawn as glyphs: controls, and the invisible
// format characters a paste carries (zero-width space, BOM, joiners).
export function isInvisible(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfeff || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064);
}

// Every face a piece of text could need — fetched before layout, so the layout
// can measure. Over-asks a little (a range claim the font then misses is still
// fetched), never under-asks.
export function facesNeeded(text, family, bold, italic, into = new Set()) {
  const seen = new Set();
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0);
    if (seen.has(cp) || isInvisible(cp)) continue;
    seen.add(cp);
    const faces = candidateFaces(cp, family, bold, italic);
    // The first two are enough: the family's subset, and the face behind it
    // for the rare glyph a subset's range claims and the font does not have.
    // A bold or italic face's regular twin too: a style a package lacks a
    // glyph in falls back to it (faceFor).
    faces.slice(0, 2).forEach((face) => {
      into.add(face);
      if (!/\|400\|normal$/.test(face)) into.add(face.replace(/\|\d+\|(normal|italic)$/, "|400|normal"));
    });
  }
  return into;
}

// The loaded fonts, as the layout and the writer use them.
//
// `fonts` is a Map faceKey → fontkit font (fontkit.create(bytes)). Measurement
// is fontkit's own layout — the same call pdf-lib's CustomFontEmbedder makes
// for widthOfTextAtSize — so a line measured here is the line drawn.
export function createFontSet(fonts) {
  const glyphCache = new Map();
  const widthCache = new Map();

  function hasGlyph(face, cp) {
    const key = `${face}:${cp}`;
    let answer = glyphCache.get(key);
    if (answer === undefined) {
      const font = fonts.get(face);
      answer = Boolean(font && font.hasGlyphForCodePoint(cp));
      glyphCache.set(key, answer);
    }
    return answer;
  }

  // The face that draws `cp` in this style, or null (draw it as a picture).
  function faceFor(cp, family, bold, italic) {
    for (const face of candidateFaces(cp, family, bold, italic)) {
      if (hasGlyph(face, cp)) return face;
      // The style's own file may be missing (a weight a package lacks): try the
      // regular face of the same subset before giving up on the subset.
      const plain = face.replace(/\|\d+\|(normal|italic)$/, "|400|normal");
      if (plain !== face && hasGlyph(plain, cp)) return plain;
    }
    return null;
  }

  // Width of `text` drawn in `face` at `size` points.
  function measure(text, face, size) {
    if (!text) return 0;
    const key = `${face}\u0000${text}`;
    let units = widthCache.get(key);
    if (units === undefined) {
      const font = fonts.get(face);
      if (!font) return 0;
      const run = font.layout(text, mdFontFeatures());
      units = run.advanceWidth / font.unitsPerEm;
      if (widthCache.size > 20000) widthCache.clear();
      widthCache.set(key, units);
    }
    return units * size;
  }

  // Ascent and descent of a face, as fractions of the size.
  function metrics(face) {
    const font = fonts.get(face);
    if (!font) return { ascent: 0.9, descent: 0.25 };
    return { ascent: font.ascent / font.unitsPerEm, descent: Math.abs(font.descent) / font.unitsPerEm };
  }

  // Split `text` into runs that one face can draw each; a run with face null is
  // characters no face has (drawn as a picture by the caller).
  function splitByFace(text, family, bold, italic) {
    const runs = [];
    let current = null;
    for (const ch of String(text || "")) {
      const cp = ch.codePointAt(0);
      if (isInvisible(cp)) continue;
      const face = faceFor(cp, family, bold, italic);
      if (current && current.face === face) current.text += ch;
      else {
        current = { text: ch, face };
        runs.push(current);
      }
    }
    return runs;
  }

  return { fonts, hasGlyph, faceFor, measure, metrics, splitByFace };
}
