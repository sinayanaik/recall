// Finding math in markdown, and protecting it from the markdown renderer.
//
// Ported near-verbatim into recall-clipper/content/recall-math.js so the
// extension and the app agree on what counts as a formula — tools/port-sync.mjs
// fails on any drift. Keep the formatting; the comparison is strict so that
// anything it reports is real.

import { encodeAttribute } from "../core/text.js?v=__BUILD__";

export function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

// Whitespace that is not a line break — i.e. a line's own indentation and
// trailing spaces.
export const LINE_SPACE_RE = /[^\S\n]/;

export function isSingleDollarLine(source, index) {
  if (source[index] !== "$" || source[index - 1] === "$" || source[index + 1] === "$" || isEscaped(source, index)) {
    return false;
  }

  // "Is this line just a $" answered by stepping out over the line's own
  // spaces, rather than lastIndexOf("\n") + indexOf("\n") + slice + trim.
  // That BACKWARD search scans to the start of the document whenever the note
  // has no newline above this point — and a note written as one very long line
  // (an imported book paragraph is exactly that) makes every "$" in it pay a
  // full scan back to character zero. Quadratic: 2MB of prose that merely
  // mentions prices took ~10 seconds here, on every render that isn't a
  // block-cache hit. Stepping over spaces is O(indentation) and answers the
  // identical question.
  let before = index - 1;
  while (before >= 0 && LINE_SPACE_RE.test(source[before])) before -= 1;
  if (before >= 0 && source[before] !== "\n") return false;

  let after = index + 1;
  while (after < source.length && LINE_SPACE_RE.test(source[after])) after += 1;
  return after >= source.length || source[after] === "\n";
}

export function findSingleDollarLine(source, start) {
  for (let index = source.indexOf("$", start); index !== -1; index = source.indexOf("$", index + 1)) {
    if (isSingleDollarLine(source, index)) return index;
  }
  return -1;
}

export function findUnescaped(source, token, start) {
  for (let index = source.indexOf(token, start); index !== -1; index = source.indexOf(token, index + token.length)) {
    if (!isEscaped(source, index)) return index;
  }
  return -1;
}

export function canOpenInlineDollar(source, index) {
  const next = source[index + 1];
  return next && next !== "$" && !/\s/.test(next) && !isEscaped(source, index);
}

// How far an inline $…$ span may reach. Real inline math is a formula inside a
// sentence — tens of characters, not thousands — so this only ever rules out
// things that were never math.
//
// Unbounded, this is quadratic on ordinary prose. An opening "$" with no valid
// partner scans to the END of the note before giving up, and text that merely
// mentions money ("it cost $5 for one and $10 for two") has such a "$" every
// few words: each one is rejected as a closer because the character before it
// is a space, so every one of them pays a full-document scan. Measured on a 2MB
// note of exactly that shape: 38 SECONDS inside preprocessSpecialBlocks, on
// every render that isn't a block-cache hit. With the bound, 2MB of the same
// text is a few milliseconds.
export const INLINE_MATH_MAX_SPAN = 1000;

export function findInlineDollarClose(source, start) {
  let limit = Math.min(source.length, start + INLINE_MATH_MAX_SPAN);
  // Inline math lives inside ONE paragraph, so a blank line ends the search.
  // Without this, prose that mentions money is silently eaten: in
  //
  //     It cost $5 for one and $10 for two.
  //
  //     A real formula $a + b = c$ sits here.
  //
  // the "$" before 5 opens (next char isn't whitespace) and "$10" is rejected
  // as a closer (the char before it IS whitespace) — so the scan runs on into
  // the NEXT paragraph and closes on the "$" after "c". Three paragraphs
  // collapse into one math span and the prose between them vanishes from the
  // rendered note. The comment on the KaTeX safety-net pass claims protectMath
  // declines two dollar amounts on a line; it only actually does so when no
  // later "$" happens to qualify.
  // Scanned with a bounded loop, not indexOf: indexOf("\n\n") would search to
  // the end of the document when there is no blank line at all, which is the
  // very quadratic this bound exists to prevent.
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

// Undoes Markdown backslash-escaping that got baked into a formula.
//
// htmlToMarkdown now protects math on the way in, but notes captured before it
// learned to are stored with the damage already in their text: "x_k" saved as
// "x\_k" (KaTeX prints a literal underscore) and "\int"/"\frac" saved as
// "\\int"/"\\frac" (KaTeX reads "\\" as a line break, then the words "int" and
// "frac"). Repairing on the way out means those notes come good on their next
// render instead of having to be pasted again — and the note text itself is
// left alone, so nothing is rewritten behind the author's back.
//
// Two tells, each sound on its own; anything else is passed through untouched.
export function healEscapedTex(tex) {
  if (!tex.includes("\\")) return tex;

  // A command written with ONE backslash. Its presence is proof the span was
  // not run through an escaper: an escaper doubles every backslash without
  // exception, so a surviving single one means nothing was doubled.
  //
  // This guard is what makes test 1 safe. Test 1's premise — "a real \\ is a
  // line break, always followed by whitespace, [ or end of line, never by a
  // command name" — is not true inside an environment, where \\ ends a row and
  // is followed directly by the next row's content:
  //
  //     {\begin{aligned}E_{\text{rel}}^{2}&=m_{0}^{2}c^{4}\\E_{\text{rel}}…
  //                                                       ^^ then a letter
  //
  // Wikipedia writes every multi-line equation that way, and pasting one used
  // to halve every backslash in it — "\begin{aligned}" became "begin{aligned}"
  // and the formula was destroyed rather than repaired.
  const hasSingleBackslashCommand = /(^|[^\\])\\[a-zA-Z]/.test(tex);

  // 1. "\\" followed by a LETTER, and no single-backslash command anywhere. Then
  //    this span went through an escaper, which doubled EVERY backslash in it.
  //    That makes the inverse exact: "\\" is one original backslash, and a lone
  //    "\" can only be one the escaper inserted.
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

  // 2. No command anywhere in the span ("\" before a letter), so there is no
  //    command a stripped backslash could damage — and a backslash sitting in
  //    front of punctuation only Markdown escapes can only have come from an
  //    escaper. This is the "P(x\_k | x\_{k-1}, u\_k)" case: subscripts
  //    escaped, with no "\\int" alongside them to give it away.
  if (hasSingleBackslashCommand || /\\[a-zA-Z]/.test(tex)) return tex;
  return tex.replace(/\\([_*[\]+=.>~#`-])/g, "$1");
}

export function mathNode(tex, displayMode) {
  const tag = displayMode ? "div" : "span";
  const className = displayMode ? "math-display" : "math-inline";
  return `<${tag} class="${className}" data-tex="${encodeAttribute(healEscapedTex(tex.trim()))}"></${tag}>`;
}

export function normalizeDisplayMathIndentation(markdown) {
  return markdown
    .replace(/(^|\n)[ \t]{4,}\$\$[ \t]*\n([\s\S]*?)\n[ \t]{4,}\$\$[ \t]*(?=\n|$)/g, (match, prefix, tex) => {
      const normalizedTex = tex
        .split("\n")
        .map((line) => line.replace(/^[ \t]{4}/, ""))
        .join("\n");
      return `${prefix}$$\n${normalizedTex}\n$$`;
    })
    .replace(/(^|\n)[ \t]{4,}\$\$([^\n]+?)\$\$[ \t]*(?=\n|$)/g, "$1$$$$$2$$$$");
}

export function protectMath(markdown) {
  let output = "";
  let index = 0;
  const source = normalizeDisplayMathIndentation(markdown);

  while (index < source.length) {
    if (source.startsWith("$$", index) && !isEscaped(source, index)) {
      const close = findUnescaped(source, "$$", index + 2);
      if (close !== -1) {
        // Surround display math with blank lines so marked exits HTML-block mode
        // and correctly parses any markdown (headings, paragraphs) that follows.
        const node = mathNode(source.slice(index + 2, close), true);
        const needsLeading = output.length > 0 && !output.endsWith("\n\n");
        output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        index = close + 2;
        // Skip any trailing newlines that were already part of $$...$$
        while (index < source.length && source[index] === "\n") index++;
        continue;
      }
    }

    if (isSingleDollarLine(source, index)) {
      const openLineEnd = source.indexOf("\n", index);
      const contentStart = openLineEnd === -1 ? index + 1 : openLineEnd + 1;
      const close = findSingleDollarLine(source, contentStart);
      if (close !== -1) {
        const closeLineStart = source.lastIndexOf("\n", close - 1) + 1;
        const node = mathNode(source.slice(contentStart, closeLineStart), true);
        const needsLeading = output.length > 0 && !output.endsWith("\n\n");
        output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        const closeLineEnd = source.indexOf("\n", close);
        index = closeLineEnd === -1 ? close + 1 : closeLineEnd + 1;
        while (index < source.length && source[index] === "\n") index++;
        continue;
      }
    }

    // A literal "[" immediately before "\[" (or "\(") is Markdown's escaped-bracket
    // syntax for bracket characters inside link text — e.g. Turndown emits
    // "[\[1\]](url)" for a link whose visible text is "[1]" (citation markers).
    // That's never a real LaTeX delimiter someone typed, so don't swallow it as math.
    const precededByLinkBracket = index > 0 && source[index - 1] === "[" && !isEscaped(source, index - 1);
    if (!precededByLinkBracket && (source.startsWith("\\[", index) || source.startsWith("\\(", index)) && !isEscaped(source, index)) {
      const displayMode = source[index + 1] === "[";
      const closeToken = displayMode ? "\\]" : "\\)";
      const close = findUnescaped(source, closeToken, index + 2);
      // "\[text\](url)" is Markdown's escaped-bracket link syntax — the ONE
      // shape relaxEscapedBrackets deliberately leaves escaped on paste,
      // because bare brackets there would conjure a link the source never had.
      // Display math is never immediately followed by "(", so declining it
      // costs nothing and keeps the two sides in agreement.
      const followsAsLink = close !== -1 && displayMode && source[close + 2] === "(";
      if (close !== -1 && !followsAsLink) {
        const node = mathNode(source.slice(index + 2, close), displayMode);
        if (displayMode) {
          const needsLeading = output.length > 0 && !output.endsWith("\n\n");
          output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        } else {
          output += node;
        }
        index = close + 2;
        continue;
      }
    }

    if (source[index] === "$" && canOpenInlineDollar(source, index)) {
      const close = findInlineDollarClose(source, index + 1);
      if (close !== -1) {
        output += mathNode(source.slice(index + 1, close), false);
        index = close + 1;
        continue;
      }
    }

    // Nothing at `index` opens math. Every branch above requires a "$" or a "\"
    // right here ($$…$$, a lone-$ line, \[…\], \(…\), inline $…$), so the next
    // one of those two characters is the soonest anything can happen — copy the
    // whole run up to it in one go.
    //
    // This used to append ONE CHARACTER per iteration, and since ordinary prose
    // is almost entirely not-math, that loop ran once per character of the
    // whole note on every render that isn't a block-cache hit. Measured on a
    // 2MB note: the scanning is ~6ms and the per-character append was ~250ms of
    // it. Starting the search at index + 1 is safe because `source[index]`
    // itself has just failed every branch.
    let next = index + 1;
    while (next < source.length && source[next] !== "$" && source[next] !== "\\") next += 1;
    output += source.slice(index, next);
    index = next;
  }

  return output;
}

// The math span opening at `index` as [start, end), or null. Uses the same
// delimiters and the same open/close rules protectMath() applies when
// rendering, so "what counts as math" means one thing everywhere: on the way in
// (paste), when repairing stored text, and on the way out (render).
export function mathSpanAt(text, index) {
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
export function findMathRanges(text) {
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
// A "$" inside code is not a delimiter and its backslashes belong to the
// author, so the repair below has to step over code rather than into it.
export function codeRegionEnd(source, index) {
  if (source.startsWith("```", index)) {
    const close = source.indexOf("```", index + 3);
    return close === -1 ? source.length : close + 3;
  }
  if (source[index] === "`") {
    let ticks = 0;
    while (source[index + ticks] === "`") ticks += 1;
    // CommonMark closes an inline span on a backtick run of exactly the same
    // length, which is how a literal backtick can sit inside ``a ` b``.
    const close = source.indexOf("`".repeat(ticks), index + ticks);
    return close === -1 ? index + ticks : close + ticks;
  }
  return -1;
}

// Rewrites every math span in `markdown` through healEscapedTex, so the fix
// lands in the stored text itself — what the ✎ raw view shows, what gets
// exported and backed up, and what syncs to the cloud. Prose keeps its own
// legitimate escapes ("snake\_case" stays escaped, because it is not math) and
// code is stepped over untouched.
//
// Returns the input string unchanged when there was nothing to repair, so
// callers can use identity to decide whether a write is needed at all.
export function repairEscapedMathMarkdown(markdown) {
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
      // "$$"/"\[" delimiters are two characters, a bare "$" is one.
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
