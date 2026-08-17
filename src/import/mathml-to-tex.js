// MathML -> LaTeX, for the <math> elements an EPUB (or a pasted page) ships
// WITHOUT a TeX <annotation> — Nougat-OCR books leave dozens of formulas as
// bare presentation MathML, and Turndown's default handling would serialize
// the glyph run as if it were prose ("τ¯˙=(τ¯g+δ𝐠)⏟gravity+…"): the formula
// destroyed on the way in. Converting the MathML tree back to TeX keeps it a
// real formula the app's KaTeX pipeline renders like the book did.
//
// Scope is deliberately the presentation-MathML subset real books emit (the
// tag census over the test corpus: mrow/mi/mo/mn/msub/msup/msubsup/mover/
// munder/mfrac/msqrt/mspace/mtext/mtable). Anything unrecognised degrades to
// its children rather than to "" so text is never silently lost.

// ── character maps ─────────────────────────────────────────────────────────
// Keys are built from codepoints so this file stays plain ASCII.

const fromCodepoints = (entries) =>
  Object.fromEntries(entries.map(([cp, tex]) => [String.fromCodePoint(cp), tex]));

// Greek letters with no dedicated macro (identical to Latin) map to the Latin
// letter directly, exactly as TeX authors write them.
const GREEK = fromCodepoints([
  [0x3b1, "\\alpha"], [0x3b2, "\\beta"], [0x3b3, "\\gamma"], [0x3b4, "\\delta"],
  [0x3b5, "\\varepsilon"], [0x3b6, "\\zeta"], [0x3b7, "\\eta"], [0x3b8, "\\theta"],
  [0x3b9, "\\iota"], [0x3ba, "\\kappa"], [0x3bb, "\\lambda"], [0x3bc, "\\mu"],
  [0x3bd, "\\nu"], [0x3be, "\\xi"], [0x3bf, "o"], [0x3c0, "\\pi"],
  [0x3c1, "\\rho"], [0x3c2, "\\varsigma"], [0x3c3, "\\sigma"], [0x3c4, "\\tau"],
  [0x3c5, "\\upsilon"], [0x3c6, "\\phi"], [0x3c7, "\\chi"], [0x3c8, "\\psi"],
  [0x3c9, "\\omega"],
  [0x393, "\\Gamma"], [0x394, "\\Delta"], [0x398, "\\Theta"], [0x39b, "\\Lambda"],
  [0x39e, "\\Xi"], [0x3a0, "\\Pi"], [0x3a3, "\\Sigma"], [0x3a5, "\\Upsilon"],
  [0x3a6, "\\Phi"], [0x3a8, "\\Psi"], [0x3a9, "\\Omega"],
  [0x391, "A"], [0x392, "B"], [0x395, "E"], [0x396, "Z"], [0x397, "H"],
  [0x399, "I"], [0x39a, "K"], [0x39c, "M"], [0x39d, "N"], [0x39f, "O"],
  [0x3a1, "P"], [0x3a4, "T"], [0x3a7, "X"],
  [0x3d1, "\\vartheta"], [0x3d5, "\\varphi"], [0x3d6, "\\varpi"], [0x3f1, "\\varrho"],
  [0x3f5, "\\epsilon"], [0x3f0, "\\varkappa"],
  [0x2202, "\\partial"], [0x2207, "\\nabla"]
]);

// Standalone letter-like symbols that appear directly (not via the math plane).
const LETTERLIKE = fromCodepoints([
  [0x211d, "\\mathbb{R}"], [0x2115, "\\mathbb{N}"], [0x2124, "\\mathbb{Z}"],
  [0x211a, "\\mathbb{Q}"], [0x2102, "\\mathbb{C}"], [0x2119, "\\mathbb{P}"],
  [0x210d, "\\mathbb{H}"], [0x210f, "\\hbar"], [0x210e, "h"], [0x2113, "\\ell"],
  [0x2135, "\\aleph"], [0x210b, "\\mathcal{H}"], [0x2112, "\\mathcal{L}"],
  [0x2118, "\\wp"], [0x211c, "\\mathfrak{R}"], [0x2111, "\\mathfrak{I}"],
  [0x2130, "\\mathcal{E}"], [0x2131, "\\mathcal{F}"], [0x210c, "\\mathfrak{H}"],
  [0x2128, "\\mathfrak{Z}"], [0x212d, "\\mathfrak{C}"], [0x212c, "\\mathcal{B}"],
  [0x2110, "\\mathcal{I}"], [0x2133, "\\mathcal{M}"], [0x211b, "\\mathcal{R}"],
  [0x2134, "o"], [0x210a, "g"]
]);

const OPERATORS = fromCodepoints([
  [0x28, "("], [0x29, ")"], [0x5b, "["], [0x5d, "]"], [0x7b, "\\{"], [0x7d, "\\}"],
  [0x7c, "|"], [0x2016, "\\|"], [0x2223, "|"],
  [0x2212, "-"], [0x2013, "-"], [0x2014, "-"], [0x2b, "+"], [0xb1, "\\pm"], [0x2213, "\\mp"],
  [0xd7, "\\times"], [0x22c5, "\\cdot"], [0xb7, "\\cdot"], [0x2a, "*"], [0x2217, "\\ast"],
  [0x2f, "/"], [0xf7, "\\div"], [0x5c, "\\backslash"],
  [0x3d, "="], [0x2260, "\\neq"], [0x3c, "<"], [0x3e, ">"], [0x2264, "\\leq"], [0x2265, "\\geq"],
  [0x226a, "\\ll"], [0x226b, "\\gg"], [0x2248, "\\approx"], [0x223c, "\\sim"],
  [0x2243, "\\simeq"], [0x2261, "\\equiv"], [0x2245, "\\cong"], [0x221d, "\\propto"],
  [0x2208, "\\in"], [0x2209, "\\notin"], [0x220b, "\\ni"],
  [0x2282, "\\subset"], [0x2286, "\\subseteq"], [0x2283, "\\supset"], [0x2287, "\\supseteq"],
  [0x2288, "\\nsubseteq"], [0x2284, "\\not\\subset"],
  [0x222a, "\\cup"], [0x2229, "\\cap"], [0x2216, "\\setminus"], [0x2205, "\\emptyset"],
  [0x2200, "\\forall"], [0x2203, "\\exists"], [0x2204, "\\nexists"], [0xac, "\\neg"],
  [0x2227, "\\wedge"], [0x2228, "\\vee"], [0x22a4, "\\top"], [0x22a5, "\\perp"],
  [0x221e, "\\infty"],
  [0x2211, "\\sum"], [0x220f, "\\prod"], [0x2210, "\\coprod"],
  [0x222b, "\\int"], [0x222c, "\\iint"], [0x222d, "\\iiint"], [0x222e, "\\oint"],
  [0x221a, "\\surd"],
  [0x2192, "\\to"], [0x2190, "\\leftarrow"], [0x2194, "\\leftrightarrow"],
  [0x21a6, "\\mapsto"], [0x21d2, "\\Rightarrow"], [0x21d0, "\\Leftarrow"],
  [0x21d4, "\\Leftrightarrow"], [0x2191, "\\uparrow"], [0x2193, "\\downarrow"],
  [0x2026, "\\ldots"], [0x22ef, "\\cdots"], [0x22ee, "\\vdots"], [0x22f1, "\\ddots"],
  [0x2032, "'"], [0x2033, "''"], [0x2034, "'''"], [0x2035, "\\backprime"],
  [0xb0, "\\circ"], [0x2218, "\\circ"], [0x2295, "\\oplus"], [0x2296, "\\ominus"],
  [0x2297, "\\otimes"], [0x2298, "\\oslash"], [0x2299, "\\odot"],
  [0x2020, "\\dagger"], [0x2021, "\\ddagger"], [0x25, "\\%"], [0x26, "\\&"],
  [0x23, "\\#"], [0x5f, "\\_"], [0xa7, "\\S"], [0xb6, "\\P"],
  [0x22c2, "\\bigcap"], [0x22c3, "\\bigcup"], [0x2a00, "\\bigodot"],
  [0x2a01, "\\bigoplus"], [0x2a02, "\\bigotimes"], [0x2a06, "\\bigsqcup"],
  [0x2a04, "\\biguplus"], [0x2a05, "\\bigsqcap"],
  [0x227a, "\\prec"], [0x227b, "\\succ"], [0x2aaf, "\\preceq"], [0x2ab0, "\\succeq"],
  [0x224d, "\\asymp"], [0x2250, "\\doteq"],
  [0x230a, "\\lfloor"], [0x230b, "\\rfloor"], [0x2308, "\\lceil"], [0x2309, "\\rceil"],
  [0x27e8, "\\langle"], [0x27e9, "\\rangle"], [0x2322, "\\smile"], [0x2323, "\\frown"]
]);

// Combining/standalone accent marks seen inside <mover>/<munder> scripts.
const OVER_ACCENTS = fromCodepoints([
  [0x302, "\\hat"], [0x2c6, "\\hat"], [0x5e, "\\hat"],
  [0x303, "\\tilde"], [0x2dc, "\\tilde"], [0x7e, "\\tilde"],
  [0x307, "\\dot"], [0x2d9, "\\dot"],
  [0x308, "\\ddot"], [0xa8, "\\ddot"],
  [0x20d7, "\\vec"], [0x301, "\\acute"], [0xb4, "\\acute"],
  [0x300, "\\grave"], [0x60, "\\grave"], [0x306, "\\breve"], [0x2d8, "\\breve"],
  [0x30a, "\\mathring"], [0x2da, "\\mathring"],
  [0x30c, "\\check"], [0x2c7, "\\check"]
]);

// ── the math alphanumeric plane (U+1D400–U+1D7FF) ─────────────────────────
// A "styled letter" is a distinct codepoint there; KaTeX wants the base
// letter plus a font command. Latin blocks are ~26 contiguous letters with
// occasional holes where the letterlike block already held the glyph — those
// hole codepoints map back explicitly. Greek series are 58-codepoint runs:
// 24 capitals, nabla, 25 smalls (final sigma included), partial, then 6
// letter variants, then digamma.
//
// [capStart, smallStart, variant, holes?] — holes: codepoint -> base letter.
const PLANE_LATIN = [
  [0x1d400, 0x1d41a, "bold"],
  [0x1d434, 0x1d44e, "italic", { 0x1d455: "h" }],
  [0x1d468, 0x1d482, "bold-italic"],
  [0x1d49c, 0x1d4b6, "script", {
    0x1d49d: "B", 0x1d4a0: "E", 0x1d4a1: "F", 0x1d4a3: "H", 0x1d4a4: "I",
    0x1d4a7: "L", 0x1d4a8: "M", 0x1d4ad: "R", 0x1d4ba: "e", 0x1d4bc: "g", 0x1d4c4: "o"
  }],
  [0x1d4d0, 0x1d4ea, "bold-script"],
  [0x1d504, 0x1d51e, "fraktur", {
    0x1d506: "C", 0x1d50b: "H", 0x1d50c: "I", 0x1d515: "R", 0x1d51d: "Z"
  }],
  [0x1d56c, 0x1d586, "bold-fraktur"],
  [0x1d538, 0x1d552, "double-struck", {
    0x1d53a: "C", 0x1d53f: "H", 0x1d544: "N", 0x1d546: "P",
    0x1d547: "Q", 0x1d548: "R", 0x1d54a: "Z"
  }],
  [0x1d5a0, 0x1d5ba, "sans"],
  [0x1d5d4, 0x1d5ee, "sans-bold"],
  [0x1d608, 0x1d622, "sans-italic"],
  [0x1d63c, 0x1d656, "sans-bold-italic"],
  [0x1d670, 0x1d68a, "monospace"]
];

const PLANE_GREEK_SERIES = [
  [0x1d6a8, "bold"], [0x1d6e2, "italic"], [0x1d71c, "bold-italic"],
  [0x1d756, "sans-bold"], [0x1d790, "sans-bold-italic"]
];
// 24 capitals (U+0391–U+03A9 minus the U+03A2 hole), then the 25 smalls.
const GREEK_CAPS = [
  ...Array.from({ length: 0x11 }, (_, i) => String.fromCodePoint(0x391 + i)),
  ...Array.from({ length: 7 }, (_, i) => String.fromCodePoint(0x3a3 + i))
];
const GREEK_SMALL = Array.from({ length: 25 }, (_, i) => String.fromCodePoint(0x3b1 + i));
const GREEK_VARIANTS = [0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6].map((cp) => String.fromCodePoint(cp));

function decodePlaneLatin(cp) {
  for (let b = 0; b < PLANE_LATIN.length; b++) {
    const [capStart, smallStart, variant, holes] = PLANE_LATIN[b];
    const regionEnd = b + 1 < PLANE_LATIN.length ? PLANE_LATIN[b + 1][0] : 0x1d6a8;
    if (cp < capStart || cp >= regionEnd) continue;
    if (holes && holes[cp]) return { base: holes[cp], variant };
    if (cp < smallStart) {
      let idx = cp - capStart;
      if (holes) for (const h of Object.keys(holes)) if (Number(h) < smallStart && Number(h) < cp) idx -= 1;
      if (idx >= 0 && idx < 26) return { base: String.fromCharCode(65 + idx), variant };
      return null;
    }
    let idx = cp - smallStart;
    if (holes) for (const h of Object.keys(holes)) if (Number(h) >= smallStart && Number(h) < cp) idx -= 1;
    if (idx >= 0 && idx < 26) return { base: String.fromCharCode(97 + idx), variant };
    return null;
  }
  return null;
}

function decodePlaneGreek(cp) {
  for (const [start, variant] of PLANE_GREEK_SERIES) {
    const off = cp - start;
    if (off < 0 || off > 57) continue;
    if (off < 24) return { base: GREEK_CAPS[off], variant };
    if (off === 24) return { base: String.fromCodePoint(0x2207), variant }; // nabla
    if (off < 50) return { base: GREEK_SMALL[off - 25], variant };
    if (off === 50) return { base: String.fromCodePoint(0x2202), variant }; // partial
    if (off < 57) return { base: GREEK_VARIANTS[off - 51], variant };
    return { base: String.fromCodePoint(off === 57 ? 0x3dc : 0x3dd), variant }; // digamma
  }
  return null;
}

// One math-plane codepoint -> { base, variant } or null.
function decodeMathPlane(cp) {
  if (cp >= 0x1d400 && cp < 0x1d6a8) return decodePlaneLatin(cp);
  if (cp >= 0x1d6a8 && cp < 0x1d7ce) return decodePlaneGreek(cp);
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) {
    const off = cp - 0x1d7ce;
    const variant = ["bold", "double-struck", "sans", "sans-bold", "monospace"][Math.floor(off / 10)] || "normal";
    return { base: String(off % 10), variant };
  }
  return null;
}

const GREEK_LETTER_RE = /^[\u0391-\u03a9\u03b1-\u03c9\u03d0-\u03f5]$/;

// Wraps a base glyph in the command its style calls for. Greek letters and
// digits have no bold/mathcal/mathbb glyphs in KaTeX's roman fonts, so they
// take the widest-supported route that still shows styling rather than
// failing the whole formula.
function wrapVariant(base, variant) {
  const isGreek = GREEK_LETTER_RE.test(base);
  const isUpperLatin = /^[A-Z]$/.test(base);
  const isLatin = /^[a-zA-Z]$/.test(base);
  switch (variant) {
    case "bold":
      if (isLatin || /^\d$/.test(base)) return `\\mathbf{${base}}`;
      return `\\boldsymbol{${base}}`;
    case "bold-italic":
      return `\\boldsymbol{${base}}`;
    case "italic":
      return base; // math italic is the default
    case "script":
      return isUpperLatin ? `\\mathcal{${base}}` : base;
    case "bold-script":
      return isUpperLatin ? `\\boldsymbol{\\mathcal{${base}}}` : `\\boldsymbol{${base}}`;
    case "fraktur":
      return isLatin ? `\\mathfrak{${base}}` : base;
    case "bold-fraktur":
      return isLatin ? `\\mathfrak{${base}}` : base;
    case "double-struck":
      return isUpperLatin ? `\\mathbb{${base}}` : base;
    case "sans":
      return isLatin ? `\\mathsf{${base}}` : base;
    case "sans-bold":
      return isLatin || /^\d$/.test(base) ? `\\mathsf{${base}}` : `\\boldsymbol{${base}}`;
    case "sans-italic":
    case "sans-bold-italic":
      return isLatin ? `\\mathsf{${base}}` : base;
    case "monospace":
      return isLatin || /^\d$/.test(base) ? `\\mathtt{${base}}` : base;
    case "normal":
      // Greek is upright already; an existing command needs no wrapper.
      if (isGreek || base.startsWith("\\")) return base;
      return `\\mathrm{${base}}`;
    default:
      return base;
  }
}

// One character of an <mi>/<mo> run -> TeX.
function charToTex(ch, upright) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    const decoded = decodeMathPlane(cp);
    if (decoded) {
      const base = GREEK[decoded.base] || decoded.base;
      return wrapVariant(base, decoded.variant);
    }
  }
  if (LETTERLIKE[ch]) return LETTERLIKE[ch];
  if (GREEK[ch]) return upright ? wrapVariant(GREEK[ch], "normal") : GREEK[ch];
  // OCR noise leaves stray braces and markup specials inside identifiers
  // (<mi>}</mi> where a set's \langle was meant): raw, they would unbalance
  // the surrounding TeX and fail the WHOLE formula — escaped, they render
  // as the literal character the book shows.
  if ("{}$%&#_".includes(ch)) return "\\" + ch;
  if (ch === "^") return "\\hat{\\;}";
  return ch;
}

// A run of text (an <mi> body) -> TeX.
function runToTex(text, { upright = false } = {}) {
  return Array.from(text).map((ch) => charToTex(ch, upright)).join("");
}

// A TeX command run into a following letter silently merges (alpha + x =
// "alphax", an unknown command — formula lost). Insert the one space that
// keeps them apart; everywhere else TeX tokenises unambiguously.
function joinTex(parts) {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(part)) out += " ";
    out += part;
  }
  return out;
}

// Script positions always get braces: "x_{i+1}" stays right whether or not
// the body is a single token, at the cost of a few harmless extra pairs.
function grp(tex) {
  return `{${tex}}`;
}

function elementChildren(el) {
  return Array.from(el.children || []);
}

// <mi mathvariant="normal">RNEA</mi> and friends: multi-char or explicitly
// upright identifiers are \mathrm, anything else goes through the char run.
function miToTex(el) {
  const text = (el.textContent || "").trim();
  if (!text) return "";
  const chars = Array.from(text);
  const variant = (el.getAttribute("mathvariant") || "").toLowerCase();
  if (variant === "normal" || (chars.length > 1 && !variant)) {
    const allPlane = chars.every((ch) => {
      const cp = ch.codePointAt(0);
      return cp >= 0x1d400 && cp <= 0x1d7ff;
    });
    if (!allPlane && !/[\u0370-\u03ff\u{1d400}-\u{1d7ff}]/u.test(text)) {
      return `\\mathrm{${text.replace(/\s+/g, " ")}}`;
    }
  }
  if (variant && variant !== "italic") {
    // mathvariant on plain-Unicode letters: apply the style around the base.
    const base = chars.map((ch) => GREEK[ch] || LETTERLIKE[ch] || ch).join("");
    return wrapVariant(base, variant);
  }
  return runToTex(text);
}

function moToTex(el) {
  const text = (el.textContent || "").trim();
  if (!text) return "";
  // Sized fences: Nougat writes a big bracket as <mo minsize="1.2" …>.
  const sized = el.hasAttribute("minsize") || el.hasAttribute("maxsize");
  const mapped = OPERATORS[text] ?? (/^[a-zA-Z]{2,}$/.test(text) ? `\\mathrm{${text}}` : runToTex(text));
  if (sized && /^(\(|\)|\[|\]|\\\{|\\\}|\|)$/.test(mapped)) {
    const form = el.getAttribute("form");
    const side = form === "prefix" ? "\\bigl" : form === "postfix" ? "\\bigr" : "\\big";
    return side + mapped;
  }
  return mapped;
}

function mspaceToTex(el) {
  const width = (el.getAttribute("width") || "").trim();
  const named = {
    veryverythinmathspace: "\\!", verythinmathspace: "\\!", thinmathspace: "\\,",
    mediummathspace: "\\:", thickmathspace: "\\;",
    verythickmathspace: "\\;", veryverythickmathspace: "\\;"
  };
  const hit = named[width.toLowerCase()];
  if (hit) return hit;
  const em = parseFloat(width);
  if (!Number.isFinite(em) || !width.endsWith("em")) return " ";
  if (em < 0) return "\\!";
  if (em <= 0.18) return "\\,";
  if (em <= 0.23) return "\\:";
  if (em <= 0.3) return "\\;";
  if (em >= 1.9) return "\\qquad";
  if (em >= 0.9) return "\\quad";
  return " ";
}

function mtextToTex(el) {
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `\\text{${text.replace(/([{}%&#_$^])/g, "\\$1")}}`;
}

// <mrow> whose children are all single upright letters (<mi mathvariant=
// "normal">p</mi> four times) is one word: \mathrm{phys}, not four commands.
function mrowToTex(el) {
  const kids = elementChildren(el);
  if (kids.length > 1 && kids.every((k) =>
    (k.localName || "").toLowerCase() === "mi" &&
    (k.getAttribute("mathvariant") || "").toLowerCase() === "normal" &&
    /^[a-zA-Z]$/.test((k.textContent || "").trim())
  )) {
    return `\\mathrm{${kids.map((k) => k.textContent.trim()).join("")}}`;
  }
  return joinTex(kids.map(nodeToTex));
}

function scriptBase(el) {
  const tex = nodeToTex(el);
  return (el.localName || "").toLowerCase() === "mrow" ? grp(tex) : tex;
}

// <mover> with an accent mark. The overline accent picks \bar for a single
// letter and \overline for anything longer, matching the author's intent.
function moverToTex(el) {
  const [base, over] = elementChildren(el);
  if (!base || !over) return joinTex(elementChildren(el).map(nodeToTex));
  const baseTex = nodeToTex(base);
  const mark = (over.textContent || "").trim();
  if (mark === "\u203e" || mark === "\xaf" || mark === "\u2015" || mark === "\u02c9") {
    const single = (base.localName || "").toLowerCase() === "mi" &&
      Array.from((base.textContent || "").trim()).length === 1;
    return `${single ? "\\bar" : "\\overline"}{${baseTex}}`;
  }
  if (mark === "\u23de") return `\\overbrace{${baseTex}}`;
  const accent = OVER_ACCENTS[mark];
  if (accent) return `${accent}{${baseTex}}`;
  return `\\overset{${nodeToTex(over)}}{${baseTex}}`;
}

// <munder>: an underbrace marker makes it \underbrace; anything else is a
// limit/script below the base (a sum with limits arrives as munderover).
function munderToTex(el) {
  const [base, under] = elementChildren(el);
  if (!base || !under) return joinTex(elementChildren(el).map(nodeToTex));
  const mark = (under.textContent || "").trim();
  if (mark === "\u23df") return `\\underbrace{${nodeToTex(base)}}`;
  if (mark === "\u23b4") return `\\overbrace{${nodeToTex(base)}}`;
  return `${scriptBase(base)}_${grp(nodeToTex(under))}`;
}

function mtableToTex(el) {
  const rows = [];
  for (const tr of elementChildren(el)) {
    const name = (tr.localName || "").toLowerCase();
    if (name !== "mtr" && name !== "mlabeledtr") continue;
    const cells = elementChildren(tr)
      .filter((td) => (td.localName || "").toLowerCase() === "mtd")
      .map((td) => joinTex(elementChildren(td).map(nodeToTex)));
    if (name === "mlabeledtr") cells.shift(); // the label is an equation number
    rows.push(cells.join(" & "));
  }
  if (!rows.length) return "";
  return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
}

function mencloseToTex(el) {
  const notation = el.getAttribute("notation") || "";
  const inner = joinTex(elementChildren(el).map(nodeToTex));
  if (/updiagonalstrike|downdiagonalstrike/.test(notation)) return `\\cancel{${inner}}`;
  if (/box/.test(notation)) return `\\boxed{${inner}}`;
  return inner;
}

// <mmultiscripts>: a base with tensor pre/post script pairs. Only the plain
// pair form is handled; <none> keeps a slot empty.
function mmultiscriptsToTex(el) {
  const kids = elementChildren(el);
  if (!kids.length) return "";
  let out = nodeToTex(kids[0]);
  let inPre = false;
  const post = [];
  const pre = [];
  for (let i = 1; i < kids.length; i++) {
    const name = (kids[i].localName || "").toLowerCase();
    if (name === "mprescripts") { inPre = true; continue; }
    (inPre ? pre : post).push(name === "none" ? null : nodeToTex(kids[i]));
  }
  for (let j = 0; j + 1 < post.length; j += 2) {
    out += `_${grp(post[j] || "")}^${grp(post[j + 1] || "")}`;
  }
  let preOut = "";
  for (let j = 0; j + 1 < pre.length; j += 2) {
    preOut += `_${grp(pre[j] || "")}^${grp(pre[j + 1] || "")}`;
  }
  return preOut ? `${preOut}${grp(out)}` : out;
}

function nodeToTex(node) {
  if (!node) return "";
  if (node.nodeType === 3) {
    // Stray text inside math markup: whitespace only, in practice. Anything
    // else is escaped so it can't break the surrounding formula.
    const text = node.textContent || "";
    if (!text.trim()) return "";
    return text.trim().replace(/([{}%&#_$])/g, "\\$1");
  }
  if (node.nodeType !== 1) return "";
  const name = (node.localName || node.nodeName).toLowerCase();
  const kids = () => elementChildren(node);
  switch (name) {
    case "math":
      return joinTex(kids().map(nodeToTex));
    case "semantics": {
      const real = kids().find((k) => {
        const n = (k.localName || "").toLowerCase();
        return n !== "annotation" && n !== "annotation-xml";
      });
      return real ? nodeToTex(real) : "";
    }
    case "annotation":
    case "annotation-xml":
      return "";
    case "mrow":
      return mrowToTex(node);
    case "mi":
      return miToTex(node);
    case "mn":
      return (node.textContent || "").trim().replace(/\s+/g, "");
    case "mo":
      return moToTex(node);
    case "mtext":
    case "ms":
      return mtextToTex(node);
    case "mspace":
      return mspaceToTex(node);
    case "msub": {
      const [base, sub] = kids();
      return base && sub ? `${scriptBase(base)}_${grp(nodeToTex(sub))}` : joinTex(kids().map(nodeToTex));
    }
    case "msup": {
      const [base, sup] = kids();
      return base && sup ? `${scriptBase(base)}^${grp(nodeToTex(sup))}` : joinTex(kids().map(nodeToTex));
    }
    case "msubsup": {
      const [base, sub, sup] = kids();
      return base && sub && sup
        ? `${scriptBase(base)}_${grp(nodeToTex(sub))}^${grp(nodeToTex(sup))}`
        : joinTex(kids().map(nodeToTex));
    }
    case "mover":
      return moverToTex(node);
    case "munder":
      return munderToTex(node);
    case "munderover": {
      const [base, under, over] = kids();
      if (!base || !under || !over) return joinTex(kids().map(nodeToTex));
      const mark = (under.textContent || "").trim();
      const baseTex = mark === "\u23df" ? `\\underbrace{${nodeToTex(base)}}` : scriptBase(base);
      return `${baseTex}_${grp(nodeToTex(under))}^${grp(nodeToTex(over))}`;
    }
    case "mfrac": {
      const [num, den] = kids();
      return num && den ? `\\frac{${nodeToTex(num)}}{${nodeToTex(den)}}` : joinTex(kids().map(nodeToTex));
    }
    case "msqrt":
      return `\\sqrt{${joinTex(kids().map(nodeToTex))}}`;
    case "mroot": {
      const [radicand, index] = kids();
      return radicand && index
        ? `\\sqrt[${nodeToTex(index)}]{${nodeToTex(radicand)}}`
        : joinTex(kids().map(nodeToTex));
    }
    case "mtable":
      return mtableToTex(node);
    case "mtr":
    case "mtd":
    case "mlabeledtr":
      return joinTex(kids().map(nodeToTex)); // reached only outside mtableToTex
    case "mfenced": {
      const open = node.getAttribute("open") || "(";
      const close = node.getAttribute("close") || ")";
      const sep = node.getAttribute("separators") || ",";
      const openTex = OPERATORS[open] || open;
      const closeTex = OPERATORS[close] || close;
      return `${openTex}${kids().map(nodeToTex).join(sep + " ")}${closeTex}`;
    }
    case "menclose":
      return mencloseToTex(node);
    case "mphantom":
      return `\\phantom{${joinTex(kids().map(nodeToTex))}}`;
    case "mmultiscripts":
      return mmultiscriptsToTex(node);
    case "mstyle":
    case "mpadded":
    case "merror":
      return joinTex(kids().map(nodeToTex));
    case "mglyph":
    case "malignmark":
    case "maligngroup":
      return "";
    default:
      return joinTex(kids().map(nodeToTex));
  }
}

// The exported entry: a whole <math> element -> LaTeX source, or "" when the
// tree carries nothing convertible (the caller then keeps its glyph text).
export function mathmlToTex(mathEl) {
  try {
    return nodeToTex(mathEl).replace(/[ \t]+/g, " ").trim();
  } catch (error) {
    console.warn("MathML conversion failed", error);
    return "";
  }
}

// Cleans the TeX an <annotation>/alttext hands us before it enters the notes.
// Two real-world faults, both seen in Nougat books:
//  - leftover HTML entities (a double-escaped &amp;lt;) — textContent already
//    decodes single-escaped ones, so only genuinely doubled ones reach here;
//  - \left without a matching \right (or vice versa) — KaTeX hard-fails
//    the WHOLE formula on that, where a human reader just sees a plain
//    delimiter. When they don't balance, the sizing commands go and the
//    delimiters stay.
export function sanitizeMathTex(tex) {
  let out = String(tex || "");
  if (/&(lt|gt|amp|quot|#39);/i.test(out)) {
    out = out
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&");
  }
  const lefts = (out.match(/\\left\b/g) || []).length;
  const rights = (out.match(/\\right\b/g) || []).length;
  if (lefts !== rights) {
    // A \left. / \right. vanishes whole (the dot was the null delimiter,
    // not a full stop); the rest drop their sizing command and keep the fence.
    out = out.replace(/\\(?:left|right)\s*\./g, "").replace(/\\(?:left|right)\s*/g, "");
  }
  return out.trim();
}
