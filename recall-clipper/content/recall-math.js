// Recall Clipper — math capture.
//
// Two jobs, in this order:
//
//   1. extractPageMath(root)  — walk the page's *rendered* math widgets (KaTeX,
//      MathJax 2 and 3, Wikipedia's mwe-math, bare MathML) and replace each one
//      with a single placeholder span carrying the original LaTeX. This has to
//      run BEFORE any scrubbing, because several of those widgets keep the real
//      TeX in a `display:none` subtree that the noise scrubber would delete.
//
//   2. protectMathInDom(root)  — for math that was never rendered at all (plain
//      "$x_k$" sitting in a paragraph), lift the formula out of its text node
//      into the same placeholder, so Turndown's escaper can never touch it.
//
// Both produce `<span data-recall-raw-math="$…$">`, which picker.js's `raw-math`
// rule emits verbatim. One placeholder shape, one rule.
//
// Everything in the "ported" section below is copied from Recall's app.js so
// that what the clipper emits and what a deck accepts are decided by the same
// code. Line anchors are against app.js at the time of writing:
//
//   isEscaped 8405 · findUnescaped 8447 · canOpenInlineDollar 8454
//   INLINE_MATH_MAX_SPAN / findInlineDollarClose 8471 · healEscapedTex 8518
//   mathSpanAt 8664 · findMathRanges 8685 · codeRegionEnd 8705
//   repairEscapedMathMarkdown 8729 · RAW_MATH_ATTR … MATH_BLOCK_LEVEL 25904
//   flattenTextForMath 25923 · protectMathInDom 25962 · relaxEscapedBrackets 26038
//
// If you change any of them here, change them there too — and vice versa.
// `node tools/port-sync.mjs` diffs every one of them against app.js and fails
// on anything that has drifted.
//
// ONE function diverges on purpose: protectMathInDom additionally declines an
// inline "$…$" span whose content does not read as a formula (see looksLikeMath).
// The clipper meets raw web prose, where two currency amounts in a sentence are
// ordinary; app.js only ever sees text a user already chose to keep. The
// divergence is registered in tools/port-sync.mjs so it doesn't read as drift.
(function () {
  "use strict";
  if (window.__recallMath) return; // idempotent — re-injection is a no-op

  // ===========================================================================
  // Ported from app.js — markdown-level math scanning
  // ===========================================================================

  const RAW_MATH_ATTR = "data-recall-raw-math";

  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    return slashes % 2 === 1;
  }

  function findUnescaped(source, token, start) {
    for (let index = source.indexOf(token, start); index !== -1; index = source.indexOf(token, index + token.length)) {
      if (!isEscaped(source, index)) return index;
    }
    return -1;
  }

  function canOpenInlineDollar(source, index) {
    const next = source[index + 1];
    return next && next !== "$" && !/\s/.test(next) && !isEscaped(source, index);
  }

  // How far an inline $…$ span may reach — see the long note in app.js. Real
  // inline math is a formula inside a sentence, so this only ever rules out
  // things that were never math, and it keeps the scan from going quadratic on
  // prose that merely mentions money.
  const INLINE_MATH_MAX_SPAN = 1000;

  function findInlineDollarClose(source, start) {
    let limit = Math.min(source.length, start + INLINE_MATH_MAX_SPAN);
    // Inline math lives inside ONE paragraph, so a blank line ends the search.
    for (let at = start; at < limit - 1; at += 1) {
      if (source[at] === "\n" && source[at + 1] === "\n") {
        limit = at;
        break;
      }
    }
    for (let index = source.indexOf("$", start); index !== -1 && index < limit; index = source.indexOf("$", index + 1)) {
      const previous = source[index - 1];
      if (source[index + 1] !== "$" && previous && !/\s/.test(previous) && !isEscaped(source, index)) {
        return index;
      }
    }
    return -1;
  }

  // Undoes Markdown backslash-escaping that got baked into a formula. Two tells,
  // each sound on its own; anything else is passed through untouched.
  function healEscapedTex(tex) {
    if (!tex.includes("\\")) return tex;

    // A command written with ONE backslash. Its presence is proof the span was
    // not run through an escaper: an escaper doubles every backslash without
    // exception, so a surviving single one means nothing was doubled.
    //
    // This guard is what makes test 1 safe. Its premise — "a real \\ is a line
    // break, always followed by whitespace, [ or end of line, never by a
    // command name" — is not true inside an environment, where \\ ends a row
    // and is followed directly by the next row's content:
    //
    //     {\begin{aligned}E_{\text{rel}}^{2}&=m_{0}^{2}c^{4}\\E_{\text{rel}}…
    //                                                       ^^ then a letter
    //
    // Wikipedia writes every multi-line equation that way. Without this check
    // the span looks doubled, every backslash gets halved, and "\begin{aligned}"
    // becomes "begin{aligned}" — the formula is destroyed rather than repaired.
    const hasSingleBackslashCommand = /(^|[^\\])\\[a-zA-Z]/.test(tex);

    // 1. "\\" followed by a LETTER, and no single-backslash command anywhere.
    //    Then this span went through an escaper, which doubled EVERY backslash
    //    in it. That makes the inverse exact: "\\" is one original backslash,
    //    and a lone "\" can only be one the escaper inserted.
    if (!hasSingleBackslashCommand && /\\\\[a-zA-Z]/.test(tex)) {
      let output = "";
      for (let index = 0; index < tex.length; index += 1) {
        if (tex[index] !== "\\") {
          output += tex[index];
          continue;
        }
        output += tex[index + 1] === "\\" ? "\\" : (tex[index + 1] || "");
        index += 1;
      }
      return output;
    }

    // 2. No command anywhere in the span, so there is no command a stripped
    //    backslash could damage — "P(x\_k | x\_{k-1})" with no "\int" alongside.
    if (hasSingleBackslashCommand || /\\[a-zA-Z]/.test(tex)) return tex;
    return tex.replace(/\\([_*[\]+=.>~#`-])/g, "$1");
  }

  // The math span starting exactly at `index`, as [start, end), or null.
  function mathSpanAt(text, index) {
    if (text.startsWith("$$", index) && !isEscaped(text, index)) {
      const close = findUnescaped(text, "$$", index + 2);
      if (close !== -1) return [index, close + 2];
    }

    if ((text.startsWith("\\[", index) || text.startsWith("\\(", index)) && !isEscaped(text, index)) {
      const closeToken = text[index + 1] === "[" ? "\\]" : "\\)";
      const close = findUnescaped(text, closeToken, index + 2);
      if (close !== -1) return [index, close + 2];
    }

    if (text[index] === "$" && canOpenInlineDollar(text, index)) {
      const close = findInlineDollarClose(text, index + 1);
      if (close !== -1) return [index, close + 1];
    }

    return null;
  }

  // [start, end) ranges of every math span in `text`.
  function findMathRanges(text) {
    const ranges = [];
    let index = 0;
    while (index < text.length) {
      const span = mathSpanAt(text, index);
      if (span) {
        ranges.push(span);
        index = span[1];
        continue;
      }
      index += 1;
    }
    return ranges;
  }

  // The end of the code region starting at `index`, or -1 if none starts there.
  // A "$" inside code is not a delimiter, so every scan has to step over code
  // rather than into it.
  function codeRegionEnd(source, index) {
    if (source.startsWith("```", index)) {
      const close = source.indexOf("```", index + 3);
      return close === -1 ? source.length : close + 3;
    }
    if (source[index] === "`") {
      let ticks = 0;
      while (source[index + ticks] === "`") ticks += 1;
      const close = source.indexOf("`".repeat(ticks), index + ticks);
      return close === -1 ? index + ticks : close + ticks;
    }
    return -1;
  }

  // Rewrites every math span in `markdown` through healEscapedTex. Prose keeps
  // its own legitimate escapes ("snake\_case" stays escaped, because it is not
  // math) and code is stepped over untouched.
  function repairEscapedMathMarkdown(markdown) {
    const source = String(markdown ?? "");
    if (!source.includes("\\")) return source;

    let output = "";
    let index = 0;
    let changed = false;

    while (index < source.length) {
      const codeEnd = codeRegionEnd(source, index);
      if (codeEnd !== -1) {
        output += source.slice(index, codeEnd);
        index = codeEnd;
        continue;
      }

      const span = mathSpanAt(source, index);
      if (span) {
        const raw = source.slice(span[0], span[1]);
        const width = raw.startsWith("$$") || raw.startsWith("\\") ? 2 : 1;
        const healed = healEscapedTex(raw.slice(width, raw.length - width));
        const repaired = raw.slice(0, width) + healed + raw.slice(raw.length - width);
        if (repaired !== raw) changed = true;
        output += repaired;
        index = span[1];
        continue;
      }

      output += source[index];
      index += 1;
    }

    return changed ? output : source;
  }

  // Turndown escapes every literal "[" and "]" in prose so a bracket can never
  // be re-read as link syntax. That is one bracket too many for us: "\[…\]" is
  // also KaTeX's display-math delimiter, so pasted prose like "[citation
  // needed]" came out escaped and then RENDERED AS MATH. Only a bracket pair
  // immediately followed by "(" actually needs the escape; everything else is
  // relaxed back to a bare bracket.
  function relaxEscapedBrackets(text) {
    const marks = [];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "\\") continue;
      const next = text[index + 1];
      if (next === "[" || next === "]") marks.push({ index, kind: next });
      // Whatever followed the backslash was consumed by it, so it can never be
      // an escape itself — this keeps "\\\[" from being misread.
      index += 1;
    }
    if (!marks.length) return text;

    const keep = new Set();
    const open = [];
    marks.forEach((mark) => {
      if (mark.kind === "[") {
        open.push(mark);
        return;
      }
      const start = open.pop();
      if (!start) return;
      if (text[mark.index + 2] === "(") {
        keep.add(start.index);
        keep.add(mark.index);
      }
    });

    const drop = new Set(marks.map((mark) => mark.index).filter((index) => !keep.has(index)));
    if (!drop.size) return text;

    let output = "";
    for (let index = 0; index < text.length; index += 1) {
      if (!drop.has(index)) output += text[index];
    }
    return output;
  }

  // ===========================================================================
  // Ported from app.js — DOM-level math protection
  // ===========================================================================

  // Stands in for an opaque subtree in the flat text: a character no pasted
  // document contains, so it can never be mistaken for part of a formula.
  const MATH_OPAQUE_MARK = "\u0000";

  // Subtrees the math scan must not look inside: their text is either code
  // (where "$" is not a delimiter) or math that already has its own rule.
  // `[data-recall-raw-math]` is ours — extractPageMath has already claimed those
  // and their text is a finished "$…$", which this pass would otherwise wrap a
  // second time.
  const MATH_OPAQUE_SELECTOR =
    "code, pre, script, style, .katex, .MathJax, .MathJax_Preview, .MathJax_Display, mjx-container, math, [" + RAW_MATH_ATTR + "]";

  // Elements Turndown renders as their own block — the boundary between two of
  // them is a line break in the markdown, so it has to be one in the flat text.
  const MATH_BLOCK_LEVEL = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

  // Flattens `root`'s text the way Turndown will end up reading it — <br> and
  // block edges become newlines, opaque subtrees become a single character that
  // can never open a delimiter — while recording which node backs each offset.
  function flattenTextForMath(root) {
    const segments = [];
    let flat = "";

    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const start = flat.length;
          flat += child.nodeValue;
          segments.push({ kind: "text", node: child, start, end: flat.length });
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;

        if (child.nodeName === "BR") {
          const start = flat.length;
          flat += "\n";
          segments.push({ kind: "break", node: child, start, end: flat.length });
          continue;
        }
        if (child.matches && child.matches(MATH_OPAQUE_SELECTOR)) {
          flat += MATH_OPAQUE_MARK;
          continue;
        }

        const isBlock = MATH_BLOCK_LEVEL.test(child.nodeName);
        if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
        walk(child);
        if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
      }
    };

    walk(root);
    return { flat, segments };
  }

  // Replaces every LaTeX span under `root` with a single placeholder element
  // carrying its exact source text.
  function protectMathInDom(root) {
    const { flat, segments } = flattenTextForMath(root);

    const ranges = findMathRanges(flat).filter(([start, end]) => {
      const tex = flat.slice(start, end);
      // An opaque subtree fell inside the span, so the text is not what the
      // markdown will say — leave it to the rules that own those nodes.
      if (tex.includes(MATH_OPAQUE_MARK)) return false;
      // Inline "$…$" is never multi-line. Without this, two dollar AMOUNTS in
      // different paragraphs would swallow every line between them.
      if (tex.startsWith("$") && !tex.startsWith("$$") && tex.includes("\n")) return false;
      // Same idea, one paragraph down: an inline span whose content reads as a
      // sentence rather than a formula is money or prose, not math.
      if (tex.startsWith("$") && !tex.startsWith("$$") && !looksLikeMath(tex.slice(1, -1))) return false;
      return true;
    });

    // Back to front: cutting a later span can't shift the offsets of an earlier one.
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      const [start, end] = ranges[i];
      const covered = segments.filter((segment) => segment.start < end && segment.end > start);
      if (!covered.length) continue;

      const tex = flat.slice(start, end);
      const placeholder = document.createElement("span");
      placeholder.setAttribute(RAW_MATH_ATTR, tex);
      // Also the placeholder's text: Turndown deletes any node whose textContent
      // is blank BEFORE consulting the rules, so an empty span would vanish.
      placeholder.textContent = tex;

      covered.forEach((segment, index) => {
        if (segment.kind === "break") {
          if (index === 0) segment.node.parentNode.insertBefore(placeholder, segment.node);
          segment.node.remove();
          return;
        }
        const node = segment.node;
        const value = node.nodeValue;
        const from = Math.max(start, segment.start) - segment.start;
        const to = Math.min(end, segment.end) - segment.start;
        if (index === 0) {
          const parent = node.parentNode;
          const next = node.nextSibling;
          node.nodeValue = value.slice(0, from);
          parent.insertBefore(placeholder, next);
          const suffix = value.slice(to);
          if (suffix) parent.insertBefore(document.createTextNode(suffix), next);
          return;
        }
        node.nodeValue = value.slice(0, from) + value.slice(to);
      });
    }

    return root;
  }

  // ===========================================================================
  // Is this "$…$" span actually a formula?
  // ===========================================================================
  //
  // Recall's protectMath closes an inline span on any later "$" that is preceded
  // by a non-space character, and scans up to INLINE_MATH_MAX_SPAN to find one.
  // On a clipped article that means "…raised $100 million… priced at US$50…"
  // collapses the whole sentence between the two amounts into one math span and
  // the prose disappears from the note. We can't change how the app scans, so we
  // decide here whether a span it *would* claim deserves to be math, and escape
  // the delimiters when it doesn't.
  //
  // Deliberately biased towards "yes": a false negative only costs a pair of
  // visible backslashes in the raw view, while a false positive eats a sentence.
  function looksLikeMath(inner) {
    const tex = String(inner || "");
    if (!tex.trim()) return false;
    // Positive signals first, and they are decisive. A price never contains
    // "\theta" or "x_1", so anything carrying LaTeX syntax is math no matter
    // what it starts with. Testing the currency shape ahead of these was wrong:
    // "2\pi - \epsilon" opens with a digit and has a space in it, and got its
    // delimiters escaped — a formula the page rendered, broken by the guard
    // meant to protect prose.
    if (/\\[a-zA-Z]/.test(tex)) return true;          // a TeX command
    if (/[_^{}]/.test(tex)) return true;              // sub/superscript, groups
    // Money opening the span, with prose running on after it.
    if (/^\s*\d/.test(tex) && /\s/.test(tex.trim())) return false;
    if (/^[^a-zA-Z]*$/.test(tex)) return true;        // pure symbols/numbers
    // Four or more whitespace-separated words is a sentence, not a formula.
    if (tex.trim().split(/\s+/).length >= 4) return false;
    return tex.length <= 60;
  }

  // Escape the delimiters of every inline "$…$" span that does not look like a
  // formula, so Recall renders the dollars as the currency symbols they are.
  // Code regions are stepped over; "$$…$$", "\[…\]" and "\(…\)" are left alone
  // because they are unambiguous.
  function escapeStrayDollars(markdown) {
    const source = String(markdown ?? "");
    if (!source.includes("$")) return source;

    let output = "";
    let index = 0;

    while (index < source.length) {
      const codeEnd = codeRegionEnd(source, index);
      if (codeEnd !== -1) {
        output += source.slice(index, codeEnd);
        index = codeEnd;
        continue;
      }

      const span = mathSpanAt(source, index);
      if (span) {
        const raw = source.slice(span[0], span[1]);
        const isInlineDollar = raw.startsWith("$") && !raw.startsWith("$$");
        if (isInlineDollar && !looksLikeMath(raw.slice(1, -1))) {
          output += "\\$" + raw.slice(1, -1) + "\\$";
        } else {
          output += raw;
        }
        index = span[1];
        continue;
      }

      output += source[index];
      index += 1;
    }

    return output;
  }

  // ===========================================================================
  // MathML → LaTeX
  // ===========================================================================
  //
  // Used when a page renders math but exposes no LaTeX of its own: bare MathML
  // (MDN, Word/Docs exports), and MathJax 3's assistive-MathML tree. Covers the
  // presentation elements that carry ~all real-world formulas and gives up —
  // returning "" — the moment it meets something it cannot express, so the
  // caller can fall back rather than emit a plausible-looking wrong formula.

  const FAIL = Symbol("mathml-unsupported");

  // Unicode the browser renders directly but LaTeX needs a command for.
  const TEX_CHAR = {
    // invisible operators MathML uses for implied multiplication / f(x)
    "\u2061": "", "\u2062": "", "\u2063": "", "\u2064": "", "\u2060": "",
    "\u00a0": "\\ ", "\u2009": "\\,", "\u2005": "\\;", "\u200b": "",
    "\u2212": "-", "\u2018": "`", "\u2019": "'", "\u201c": "``", "\u201d": "''",
    // Greek
    "\u03b1": "\\alpha", "\u03b2": "\\beta", "\u03b3": "\\gamma", "\u03b4": "\\delta",
    "\u03b5": "\\epsilon", "\u03f5": "\\epsilon", "\u03b6": "\\zeta", "\u03b7": "\\eta",
    "\u03b8": "\\theta", "\u03d1": "\\vartheta", "\u03b9": "\\iota", "\u03ba": "\\kappa",
    "\u03bb": "\\lambda", "\u03bc": "\\mu", "\u03bd": "\\nu", "\u03be": "\\xi",
    "\u03c0": "\\pi", "\u03d6": "\\varpi", "\u03c1": "\\rho", "\u03f1": "\\varrho",
    "\u03c3": "\\sigma", "\u03c2": "\\varsigma", "\u03c4": "\\tau", "\u03c5": "\\upsilon",
    "\u03c6": "\\varphi", "\u03d5": "\\phi", "\u03c7": "\\chi", "\u03c8": "\\psi",
    "\u03c9": "\\omega",
    "\u0393": "\\Gamma", "\u0394": "\\Delta", "\u0398": "\\Theta", "\u039b": "\\Lambda",
    "\u039e": "\\Xi", "\u03a0": "\\Pi", "\u03a3": "\\Sigma", "\u03a5": "\\Upsilon",
    "\u03a6": "\\Phi", "\u03a8": "\\Psi", "\u03a9": "\\Omega",
    // big operators
    "\u2211": "\\sum", "\u220f": "\\prod", "\u2210": "\\coprod",
    "\u222b": "\\int", "\u222c": "\\iint", "\u222d": "\\iiint", "\u222e": "\\oint",
    "\u22c3": "\\bigcup", "\u22c2": "\\bigcap", "\u2295": "\\oplus", "\u2297": "\\otimes",
    // relations
    "\u2264": "\\le", "\u2265": "\\ge", "\u2260": "\\ne", "\u2248": "\\approx",
    "\u2261": "\\equiv", "\u223c": "\\sim", "\u2245": "\\cong", "\u221d": "\\propto",
    "\u226a": "\\ll", "\u226b": "\\gg", "\u2250": "\\doteq", "\u2254": ":=",
    // operators
    "\u00b1": "\\pm", "\u2213": "\\mp", "\u00d7": "\\times", "\u00f7": "\\div",
    "\u22c5": "\\cdot", "\u2218": "\\circ", "\u2217": "\\ast", "\u2219": "\\bullet",
    "\u221a": "\\surd", "\u221e": "\\infty", "\u2202": "\\partial", "\u2207": "\\nabla",
    "\u2032": "'", "\u2033": "''", "\u00b0": "^\\circ",
    // arrows
    "\u2192": "\\to", "\u2190": "\\leftarrow", "\u2194": "\\leftrightarrow",
    "\u21d2": "\\Rightarrow", "\u21d0": "\\Leftarrow", "\u21d4": "\\Leftrightarrow",
    "\u21a6": "\\mapsto", "\u21c0": "\\rightharpoonup",
    // sets & logic
    "\u2208": "\\in", "\u2209": "\\notin", "\u220b": "\\ni", "\u2282": "\\subset",
    "\u2286": "\\subseteq", "\u2283": "\\supset", "\u2287": "\\supseteq",
    "\u222a": "\\cup", "\u2229": "\\cap", "\u2205": "\\emptyset", "\u2216": "\\setminus",
    "\u2200": "\\forall", "\u2203": "\\exists", "\u00ac": "\\neg",
    "\u2227": "\\wedge", "\u2228": "\\vee", "\u22a5": "\\perp", "\u2225": "\\parallel",
    "\u2234": "\\therefore", "\u2235": "\\because",
    // blackboard / misc letters
    "\u211d": "\\mathbb{R}", "\u2115": "\\mathbb{N}", "\u2124": "\\mathbb{Z}",
    "\u211a": "\\mathbb{Q}", "\u2102": "\\mathbb{C}", "\u210f": "\\hbar", "\u2113": "\\ell",
    // dots & fences
    "\u2026": "\\ldots", "\u22ef": "\\cdots", "\u22ee": "\\vdots", "\u22f1": "\\ddots",
    "\u27e8": "\\langle", "\u27e9": "\\rangle", "\u2016": "\\|",
    "\u2308": "\\lceil", "\u2309": "\\rceil", "\u230a": "\\lfloor", "\u230b": "\\rfloor",
    "\u2220": "\\angle", "\u25b3": "\\triangle", "\u2020": "\\dagger", "\u2021": "\\ddagger"
  };

  // Characters LaTeX reads as syntax when they appear as literal content.
  const TEX_ESCAPE = { "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "$": "\\$", "_": "\\_", "^": "\\^{}", "~": "\\sim", "\\": "\\backslash" };

  const FUNCTION_NAMES = new Set([
    "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth",
    "arcsin", "arccos", "arctan", "log", "ln", "lg", "exp", "lim", "limsup",
    "liminf", "max", "min", "sup", "inf", "det", "dim", "deg", "gcd", "hom",
    "ker", "arg", "Pr"
  ]);

  // Operators that take their munder/mover scripts as limits (x_i^n), rather
  // than as an accent or an \overset.
  const LIMIT_OPS = /^\\(?:sum|prod|coprod|int|iint|iiint|oint|bigcup|bigcap|bigoplus|bigotimes|lim|limsup|liminf|max|min|sup|inf)$/;

  const MATHVARIANT_CMD = {
    bold: "\\mathbf", "bold-italic": "\\boldsymbol", italic: "", normal: "\\mathrm",
    "double-struck": "\\mathbb", script: "\\mathcal", "bold-script": "\\mathcal",
    fraktur: "\\mathfrak", "sans-serif": "\\mathsf", monospace: "\\mathtt"
  };

  // Accents recognised on <mover>, keyed by the over-script's rendered text.
  const ACCENTS = {
    "\u00af": "\\overline", "\u203e": "\\overline", "\u0304": "\\bar",
    "^": "\\hat", "\u0302": "\\hat", "\u02c6": "\\hat",
    "~": "\\tilde", "\u0303": "\\tilde", "\u02dc": "\\tilde",
    "\u2192": "\\vec", "\u20d7": "\\vec",
    ".": "\\dot", "\u02d9": "\\dot", "\u00a8": "\\ddot", "\u0308": "\\ddot",
    "\u02c7": "\\check", "\u02d8": "\\breve"
  };

  function texChars(text) {
    let out = "";
    for (const ch of String(text)) {
      if (Object.prototype.hasOwnProperty.call(TEX_CHAR, ch)) out += TEX_CHAR[ch];
      else if (Object.prototype.hasOwnProperty.call(TEX_ESCAPE, ch)) out += TEX_ESCAPE[ch];
      else out += ch;
    }
    return out;
  }

  // Wrap in braces unless it is already a single token LaTeX will bind whole.
  function group(tex) {
    const t = tex.trim();
    if (t.length === 1) return t;
    if (/^\\[a-zA-Z]+$/.test(t)) return t;
    return `{${t}}`;
  }

  function elementChildren(node) {
    return Array.from(node.children).filter((child) => {
      const name = child.nodeName.toLowerCase().replace(/^m:/, "");
      return name !== "annotation" && name !== "annotation-xml";
    });
  }

  // Join sibling conversions, keeping a command from swallowing what follows it.
  // "\alpha" + "x" concatenated is "\alphax", an undefined control sequence —
  // and MathML writes exactly that shape, one <mi> per symbol, all the time.
  function convertAll(nodes) {
    let out = "";
    for (const node of nodes) {
      const piece = convertNode(node);
      if (!piece) continue;
      if (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(piece)) out += " ";
      out += piece;
    }
    return out;
  }

  function convertNode(node) {
    const name = node.nodeName.toLowerCase().replace(/^m:/, "");
    const kids = elementChildren(node);
    const text = (node.textContent || "").trim();

    switch (name) {
      case "math":
      case "semantics":
      case "mrow":
      case "mstyle":
      case "mpadded":
      case "menclose":
      case "merror":
      case "mtd": {
        const inner = convertAll(kids.length ? kids : []);
        const body = kids.length ? inner : texChars(text);
        const variant = MATHVARIANT_CMD[node.getAttribute("mathvariant")];
        return variant ? `${variant}{${body}}` : body;
      }

      case "mi": {
        if (!text) return "";
        if (FUNCTION_NAMES.has(text)) return `\\${text} `;
        const variant = node.getAttribute("mathvariant");
        const body = texChars(text);
        if (variant && MATHVARIANT_CMD[variant]) return `${MATHVARIANT_CMD[variant]}{${body}}`;
        // A multi-letter identifier is a name, not a product of variables.
        if (text.length > 1 && /^[A-Za-z]+$/.test(text)) return `\\mathrm{${body}}`;
        return body;
      }

      case "mn":
      case "mo":
        return texChars(text);

      case "mtext":
        return text ? `\\text{${text.replace(/([{}\\$&#%_])/g, "\\$1")}}` : "";

      case "ms":
        return `\\text{"${text.replace(/([{}\\$&#%_])/g, "\\$1")}"}`;

      case "mspace":
        return "\\ ";

      case "mphantom":
        return `\\phantom{${convertAll(kids)}}`;

      case "mfrac": {
        if (kids.length !== 2) throw FAIL;
        const thin = (node.getAttribute("linethickness") || "").trim();
        const cmd = /^0(?:px|em|pt)?$/.test(thin) ? "\\binom" : "\\frac";
        return `${cmd}{${convertNode(kids[0])}}{${convertNode(kids[1])}}`;
      }

      case "msqrt":
        return `\\sqrt{${convertAll(kids)}}`;

      case "mroot": {
        if (kids.length !== 2) throw FAIL;
        return `\\sqrt[${convertNode(kids[1])}]{${convertNode(kids[0])}}`;
      }

      case "msub": {
        if (kids.length !== 2) throw FAIL;
        return `${group(convertNode(kids[0]))}_${group(convertNode(kids[1]))}`;
      }

      case "msup": {
        if (kids.length !== 2) throw FAIL;
        return `${group(convertNode(kids[0]))}^${group(convertNode(kids[1]))}`;
      }

      case "msubsup": {
        if (kids.length !== 3) throw FAIL;
        return `${group(convertNode(kids[0]))}_${group(convertNode(kids[1]))}^${group(convertNode(kids[2]))}`;
      }

      case "munder": {
        if (kids.length !== 2) throw FAIL;
        const base = convertNode(kids[0]);
        const under = convertNode(kids[1]);
        if (LIMIT_OPS.test(base.trim())) return `${base}_${group(under)}`;
        if (/^\\overline$/.test(ACCENTS[kids[1].textContent.trim()] || "")) return `\\underline{${base}}`;
        return `\\underset{${under}}{${base}}`;
      }

      case "mover": {
        if (kids.length !== 2) throw FAIL;
        const base = convertNode(kids[0]);
        const overText = (kids[1].textContent || "").trim();
        const accent = ACCENTS[overText];
        if (accent) return `${accent}{${base}}`;
        const over = convertNode(kids[1]);
        if (LIMIT_OPS.test(base.trim())) return `${base}^${group(over)}`;
        return `\\overset{${over}}{${base}}`;
      }

      case "munderover": {
        if (kids.length !== 3) throw FAIL;
        const base = convertNode(kids[0]);
        const under = convertNode(kids[1]);
        const over = convertNode(kids[2]);
        if (LIMIT_OPS.test(base.trim())) return `${base}_${group(under)}^${group(over)}`;
        return `\\underset{${under}}{\\overset{${over}}{${base}}}`;
      }

      case "mfenced": {
        const open = node.getAttribute("open") ?? "(";
        const close = node.getAttribute("close") ?? ")";
        const sep = node.getAttribute("separators") ?? ",";
        const parts = kids.map(convertNode);
        const joined = parts.join(sep ? `${texChars(sep[0] || ",")} ` : "");
        return `\\left${fenceTex(open)}${joined}\\right${fenceTex(close)}`;
      }

      case "mtable": {
        const rows = kids.filter((k) => k.nodeName.toLowerCase().replace(/^m:/, "") === "mtr" ||
                                        k.nodeName.toLowerCase().replace(/^m:/, "") === "mlabeledtr");
        if (!rows.length) throw FAIL;
        const body = rows
          .map((row) => elementChildren(row).map(convertNode).join(" & "))
          .join(" \\\\ ");
        return `\\begin{matrix} ${body} \\end{matrix}`;
      }

      case "mtr":
      case "mlabeledtr":
        return elementChildren(node).map(convertNode).join(" & ");

      case "maction":
        return kids.length ? convertNode(kids[0]) : "";

      default:
        throw FAIL;
    }
  }

  function fenceTex(ch) {
    if (!ch) return ".";
    if (ch === "{" || ch === "}") return `\\${ch}`;
    if (ch === "|") return "|";
    return texChars(ch) || ".";
  }

  // A <math> element as LaTeX, or "" when it uses something we cannot express.
  function mathmlToTex(mathEl) {
    if (!mathEl) return "";
    try {
      const tex = convertNode(mathEl)
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      return tex && /[^\s]/.test(tex) ? tex : "";
    } catch (err) {
      return "";
    }
  }

  // ===========================================================================
  // Page math extraction
  // ===========================================================================

  // Every shape of rendered math we know how to read, in document order. The
  // list is scanned once and each hit is replaced in place, so a widget nested
  // inside another (MathJax's assistive <math>, KaTeX's .katex-mathml) is
  // already detached by the time the walk reaches it.
  const MATH_ISLAND_SELECTOR = [
    "[data-recall-tex]",
    "mjx-container",
    "script[type^='math/tex']",
    ".MathJax_Display",
    ".MathJax",
    ".MathJax_Preview",
    ".katex-display",
    ".katex",
    "span.mwe-math-element",
    "math",
    "img.mwe-math-fallback-image-inline",
    "img.mwe-math-fallback-image-display"
  ].join(",");

  function annotationTex(el) {
    const annotation = el.querySelector && el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    return annotation ? (annotation.textContent || "").trim() : "";
  }

  // Wikipedia (and MathJax's own alttext) wraps everything in {\displaystyle …}.
  // KaTeX renders that literally as an unknown command, so unwrap it.
  function stripDisplaystyle(tex) {
    const trimmed = String(tex || "").trim();
    const match = trimmed.match(/^\{\s*\\(?:display|text|script)style\s+([\s\S]*)\}$/);
    return match ? match[1].trim() : trimmed;
  }

  function isDisplayIsland(el) {
    if (!el || !el.closest) return false;
    // MathJax told us outright (see content/mathjax-source.js).
    if (el.hasAttribute && el.hasAttribute(TEX_DISPLAY_ATTR)) return true;
    if (el.querySelector && el.querySelector(`[${TEX_DISPLAY_ATTR}]`)) return true;
    if (el.classList && (el.classList.contains("katex-display") ||
      el.classList.contains("MathJax_Display") ||
      el.classList.contains("mwe-math-fallback-image-display"))) return true;
    if (el.getAttribute) {
      if (el.getAttribute("display") === "block") return true;
      if (el.getAttribute("mode") === "display") return true;
      // MathJax 3 marks block math on the container.
      if (el.nodeName === "MJX-CONTAINER" && el.getAttribute("display") === "true") return true;
    }
    if (el.querySelector && el.querySelector('math[display="block"], .mwe-math-mathml-display, .mwe-math-fallback-image-display')) return true;
    return Boolean(el.closest(".katex-display, .MathJax_Display, .mwe-math-mathml-display, mjx-container[display='true']"));
  }

  // Stamped by content/mathjax-source.js from the page's own MathJax state.
  const TEX_ATTR = "data-recall-tex";
  const TEX_DISPLAY_ATTR = "data-recall-tex-display";

  // The LaTeX behind one rendered math widget, or "" if we cannot recover it.
  function texFromIsland(el) {
    // 0. The author's literal source, lifted out of MathJax before we started.
    //    Nothing below can beat this — every other route reconstructs the LaTeX
    //    from a rendering of it, and a reconstruction of `\left[…\right]` is
    //    `[…]`: the same equation, drawn wrong.
    const stamped = el.getAttribute && el.getAttribute(TEX_ATTR);
    if (stamped && stamped.trim()) return stamped.trim();
    const stampedChild = el.querySelector && el.querySelector(`[${TEX_ATTR}]`);
    if (stampedChild) {
      const nested = (stampedChild.getAttribute(TEX_ATTR) || "").trim();
      if (nested) return nested;
    }

    // 1. A TeX annotation anywhere inside — KaTeX, MathJax's MathML output and
    //    Wikipedia all provide one, and it is the author's exact source.
    const annotated = annotationTex(el);
    if (annotated) return annotated;

    // 2. MathJax 3 keeps a copy-paste source in <mjx-copytext>; failing that its
    //    assistive MathML tree is a faithful translation of the same formula.
    if (el.localName === "mjx-container") {
      const copytext = el.querySelector("mjx-copytext");
      if (copytext && copytext.textContent.trim()) {
        return copytext.textContent.trim().replace(/^\\\((.*)\\\)$/s, "$1").replace(/^\\\[(.*)\\\]$/s, "$1");
      }
      const assistive = el.querySelector("mjx-assistive-mml math, math");
      if (assistive) {
        const fromMathml = mathmlToTex(assistive);
        if (fromMathml) return fromMathml;
      }
    }

    // 3. MathJax 2 stores the source in a sibling script tag.
    if (el.localName === "script") return (el.textContent || "").trim();
    const script = mathJaxScriptFor(el);
    if (script) return (script.textContent || "").trim();

    // 4. Wikipedia's alttext / fallback image alt — "{\displaystyle E=mc^{2}}".
    const alt = el.getAttribute && (el.getAttribute("alttext") || el.getAttribute("alt"));
    if (alt && alt.trim()) return alt.trim();
    const altEl = el.querySelector && el.querySelector("math[alttext], img[alt]");
    if (altEl) {
      const nested = altEl.getAttribute("alttext") || altEl.getAttribute("alt") || "";
      if (nested.trim()) return nested.trim();
    }

    // 5. Bare MathML. `localName`, not `nodeName`: <math> is parsed into the
    // MathML namespace, where nodeName keeps the lowercase qualified name and
    // an uppercase comparison silently never matches.
    const mathEl = el.localName === "math" ? el : (el.querySelector && el.querySelector("math"));
    if (mathEl) {
      const fromMathml = mathmlToTex(mathEl);
      if (fromMathml) return fromMathml;
    }

    return "";
  }

  // MathJax 2 emits `<span class="MathJax">…rendered…</span><script type="math/tex">TeX</script>`
  // (with a `MathJax_Preview` span ahead of them). Find the script that belongs
  // to a rendered span, so the pair can be replaced as one unit.
  function mathJaxScriptFor(el) {
    for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (sib.nodeName === "SCRIPT" && /^math\/tex/.test(sib.getAttribute("type") || "")) return sib;
      if (!/^(SPAN|DIV)$/.test(sib.nodeName)) break;
      if (!/MathJax/.test(sib.className || "")) break;
    }
    return null;
  }

  // Delete the widget's other halves once one of them has been claimed.
  function removeCompanions(el) {
    const script = mathJaxScriptFor(el);
    if (script) script.remove();
    for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
      if (sib && sib.classList && (sib.classList.contains("MathJax_Preview") || sib.classList.contains("MathJax"))) {
        sib.remove();
      }
    }
  }

  // Trimming a formula can strip the space out of a trailing "\ " (LaTeX's
  // explicit space), leaving a lone backslash that escapes nothing — KaTeX
  // rejects the whole span with "Unexpected character: '\'". Real source does
  // end that way: "2\pi - \epsilon\ ". Drop the orphaned backslash; the space it
  // was producing is exactly what we just trimmed off anyway. An even run is a
  // "\\" line break and is left alone.
  function dropDanglingEscape(tex) {
    let slashes = 0;
    for (let i = tex.length - 1; i >= 0 && tex[i] === "\\"; i -= 1) slashes += 1;
    return slashes % 2 === 1 ? tex.slice(0, -1) : tex;
  }

  function wrapTex(tex, display) {
    const body = dropDanglingEscape(healEscapedTex(stripDisplaystyle(tex)).trim());
    if (!body) return "";
    // A LaTeX environment is only recognised by Recall inside display math.
    const isDisplay = display || /\\begin\{/.test(body) || body.includes("\n");
    return isDisplay ? `$$\n${body}\n$$` : `$${body}$`;
  }

  function placeholderFor(text) {
    const span = document.createElement("span");
    span.setAttribute(RAW_MATH_ATTR, text);
    span.textContent = text;
    return span;
  }

  // What to show when a widget exposes no LaTeX at all. KaTeX built with
  // `output:"html"` renders readable glyphs into `.katex-html` and no MathML
  // anywhere, so its own text is a decent consolation prize — but that subtree
  // is `aria-hidden`, which the noise scrubber deletes moments after this runs,
  // so it has to be taken now or not at all. MathJax 3's CHTML output paints its
  // glyphs with CSS `content` on empty <mjx-c> elements, so its textContent is
  // blank and this correctly falls through to the marker.
  function fallbackText(el) {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) return "";
    // Glyph soup: no letters, digits or recognisable operators.
    if (!/[\w+\-=<>()[\]/]/.test(text)) return "";
    return text;
  }

  // Replace every rendered math widget under `root` with a placeholder carrying
  // its LaTeX. MUST run before any scrubbing pass — Wikipedia and MathJax both
  // park the real TeX in a `display:none` subtree that stripHidden would delete.
  //
  // Returns { captured, missed } so the UI can say how the clip went.
  function extractPageMath(root) {
    if (!root || !root.querySelectorAll) return { captured: 0, missed: 0 };
    let captured = 0;
    let missed = 0;

    for (const el of Array.from(root.querySelectorAll(MATH_ISLAND_SELECTOR))) {
      // Already swallowed by an earlier (outer) island.
      if (!root.contains(el)) continue;
      // A nested part of an island we are about to reach from the outside.
      if (el.closest(`[${RAW_MATH_ATTR}]`)) continue;

      const display = isDisplayIsland(el);
      const tex = texFromIsland(el);
      const wrapped = tex ? wrapTex(tex, display || /mode=display/.test(el.getAttribute?.("type") || "")) : "";

      let node;
      if (wrapped) {
        node = placeholderFor(wrapped);
        captured += 1;
      } else {
        // Nothing recoverable. Leave the rendered text, or a visible marker —
        // never a hole. Silently dropping is how an equation used to vanish
        // from a clip with nothing to show it had ever been there.
        node = document.createElement("code");
        node.textContent = fallbackText(el) || "[math]";
        missed += 1;
      }

      removeCompanions(el);
      el.replaceWith(node);
    }

    return { captured, missed };
  }

  window.__recallMath = {
    RAW_MATH_ATTR,
    extractPageMath,
    protectMathInDom,
    repairEscapedMathMarkdown,
    relaxEscapedBrackets,
    escapeStrayDollars,
    healEscapedTex,
    mathmlToTex,
    looksLikeMath,
    findMathRanges,
    codeRegionEnd
  };
})();
