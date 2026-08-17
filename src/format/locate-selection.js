// Finding a rendered selection's exact span in the markdown source.
//
// The rendered text and the source differ by every piece of markup, so an exact
// match is tried first, then a whitespace-tolerant one, then a markup-tolerant
// one — each bounded, because an unbounded fuzzy scan over a large note is
// quadratic.

import { htmlToMarkdown } from "../import/html-to-markdown.js?v=__BUILD__";
import { cleanedSelectionFragment, textWithLineBreaks } from "../notes/selection.js?v=__BUILD__";

// The current selection inside `view`, captured both as markdown (so inline
// bold/math/etc. survive) and as plain text — either may be the string that
// appears verbatim in the source. Returns null when there's no live selection
// inside this rendered view.
export function renderedSelectionStrings(view) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!view || view.hidden) return null;
  const range = selection.getRangeAt(0);
  if (!view.contains(range.commonAncestorContainer)) return null;
  const fragment = cleanedSelectionFragment(range);
  const asText = textWithLineBreaks(fragment).trim();
  let asMarkdown = "";
  try {
    asMarkdown = htmlToMarkdown(fragment.innerHTML, { preserveInlineStyles: true }).trim();
  } catch { asMarkdown = ""; }
  if (!asText && !asMarkdown) return null;
  // Which occurrence of the plain-text selection this is within the rendered
  // view — i.e. how many identical copies precede it. Without this a repeated
  // word (e.g. "the") would always cloze the FIRST copy in the source, not the
  // one you highlighted, so the toast says "Cloze added" while your selection
  // visibly stays put. 0 = first occurrence, so a match is still found even if
  // this measurement is off.
  let occurrence = 0;
  if (asText) {
    try {
      const pre = document.createRange();
      pre.setStart(view, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      // textWithLineBreaks, not Range.toString() — the native stringifier
      // drops <br> the same way .textContent does, which would make this
      // count come up short (or zero) against an asText that now legitimately
      // contains "\n" from a wrapped line, for the same reason described above.
      occurrence = countOccurrences(textWithLineBreaks(pre.cloneContents()), asText);
    } catch { occurrence = 0; }
  }
  return { asText, asMarkdown, occurrence };
}

// Non-overlapping count of `needle` in `haystack`.
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// Index of the n-th (0-based) occurrence of `needle`, or -1 if there are fewer.
export function nthIndexOf(haystack, needle, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

// Turndown's list-item rule pads every marker to a fixed width ("-   text",
// not the single-space "- text" this app's own bullet toggle writes) so
// continuation lines line up — a real Turndown behavior, not a bug, but it
// means an asMarkdown needle reconstructed from a selection spanning list
// items can be byte-perfect CONTENT and still never match the source via a
// plain indexOf, because the marker spacing genuinely differs. Escaping the
// needle and turning every run of whitespace in it into `\s+` before
// searching absorbs exactly that kind of incidental reformatting (also covers
// any other whitespace marked/Turndown might not round-trip identically).
// Returns the ACTUAL matched text from source — never the needle's — so
// whatever locates the match downstream (wrapAcrossBlocks etc.) works with
// real spacing, not what was searched for.
// `occurrence` targets the SAME copy sel.occurrence already identifies for the
// exact-match stage above — without it this always took the first hit in the
// whole note, so on a note where the dragged wording (or similar wording)
// repeats earlier, the highlight landed on that earlier copy instead of the
// one actually selected: a mark appearing somewhere else on screen while the
// real selection stayed unmarked, which reads as an unwanted jump.
export function fuzzyWhitespaceMatch(source, needle, occurrence = 0) {
  if (!needle) return null;
  // A line-initial list marker in the needle (Turndown always serializes
  // "-   " / "1.  ") stands for whatever marker the source line actually
  // uses: this app's own bullet toggle writes "- ", an imported note might
  // use "*" or "+", and an ordered selection's numbers don't have to equal
  // the source's own ("9. " when the list restarts). Match any of them —
  // whitespace-only flexibility can't bridge a marker-CHARACTER difference,
  // which is why "*"-lists and ordered lists never matched before this.
  const MARKER = "\u0001";
  const markedNeedle = needle.replace(/(^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+/g, (_m, br) => br + MARKER);
  const markerPattern = "(?:[ \\t]*(?:[-*+]|\\d+[.)])[ \\t]+)";
  let pattern = markedNeedle
    .split(MARKER)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join(markerPattern);
  // A needle that STARTS with a marker may carry one the restored list wrapper
  // synthesized for a selection that began MID-item ("-   ha beta" for a drag
  // that started at "ha"): the source's own "- " then sits BEFORE the match,
  // not inside it, so a mandatory leading marker never matches. Optional it.
  if (markedNeedle.startsWith(MARKER)) {
    pattern = `${markerPattern}?${pattern.slice(markerPattern.length)}`;
  }
  let re;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return null;
  }
  let m = null;
  for (let i = 0; i <= occurrence; i += 1) {
    m = re.exec(source);
    if (!m) break;
    // A pattern that can match empty would never advance lastIndex.
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (!m) {
    // occurrence miscounted (or this copy simply isn't the Nth) → first match,
    // same fallback nthIndexOf's caller uses for the exact-match stage.
    re.lastIndex = 0;
    m = re.exec(source);
  }
  return m ? { idx: m.index, end: m.index + m[0].length, needle: m[0] } : null;
}

// ── Markup-tolerant matching: the last resort ──────────────────────────────
// fuzzyWhitespaceMatch only bends WHITESPACE, so it fails the moment needle
// and source disagree about a single markup CHARACTER — which they routinely
// do, none of it the reader's doing:
//   • Turndown ESCAPES the punctuation it re-emits, so a rendered
//     `joint_state_publisher` comes back as "joint\_state\_publisher" and a
//     "*-Config.cmake" as "\*-Config.cmake" — backslashes the source has no
//     reason to contain. One such word anywhere in the drag and the whole
//     markdown needle is unfindable.
//   • The plain-text needle carries no markup at all, so it can't match a
//     source span containing `code`, **bold** or a [link](…) either — and it
//     is the ONLY needle when Turndown's own output is the thing that's off.
//   • Style markers round-trip to a canonical form rather than the authored
//     one: __x__ comes back as **x**, <mark data-color="yellow"> as <mark>.
// Any one of those turned an ordinary multi-paragraph highlight into
// "Couldn't match that selection in the source — try selecting whole words",
// with no wording of the selection that could have worked.
//
// So: project BOTH sides through the same normaliser — drop the syntax
// characters, keep the words, collapse whitespace — match there, and map the
// hit back to real source offsets. Dropping a character that was genuinely
// content (a literal * in prose) is harmless precisely because the needle
// loses it too; the cost is a looser match, and these needles are whole
// selections rather than single words.
export const NORMALIZE_TAG_RE = /<\/?(?:mark|u|kbd|span|b|i|em|strong|sub|sup|br|del|ins|small)\b[^>]*>/iy;

// Consumed one at a time, repeatedly: "> - item" is a marker inside a quote.
export const NORMALIZE_LINE_PREFIX_RE = /(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+|#{1,6}[ \t]+)/y;

export const NORMALIZE_THEMATIC_BREAK_RE = /([-*_])[ \t]*(?:\1[ \t]*){2,}(?=\n|$)/y;

// A table's "| --- | :-: |" row renders nothing, and turndown-gfm rewrites its
// dashes to its own width, so it can never match the source verbatim anyway.
export const NORMALIZE_TABLE_DELIM_RE = /\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?(?=\n|$)/y;

export const NORMALIZE_LINK_TARGET_RE = /\]\([^)\n]*\)/y;

// Markdown punctuation that carries no rendered text of its own. Both sides
// lose it, so the projections still line up.
export const NORMALIZE_DROP_CHARS = new Set(["`", "*", "_", "~", "|", "{", "}", "[", "]"]);

export const NORMALIZE_ESCAPABLE_RE = /[!-/:-@[-`{-~]/;

// { text, map } — map[k] is the index in `str` of normalized character k, so a
// hit in `text` can be turned back into a real source range.
export function normalizeMarkupForMatch(str) {
  const chars = [];
  const map = [];
  let pendingSpace = false;
  let atLineStart = true;
  let i = 0;
  const emit = (ch, at) => {
    if (pendingSpace) {
      pendingSpace = false;
      // Never leading: a normalized string starts at its first real character.
      if (chars.length) {
        chars.push(" ");
        map.push(at);
      }
    }
    chars.push(ch);
    map.push(at);
  };
  const stickyAt = (re, at) => {
    re.lastIndex = at;
    return re.exec(str);
  };
  while (i < str.length) {
    const ch = str[i];
    if (ch === "\n" || ch === "\r") {
      pendingSpace = true;
      atLineStart = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (atLineStart) {
      atLineStart = false;
      if (stickyAt(NORMALIZE_THEMATIC_BREAK_RE, i)) {
        // An <hr> renders no text, so neither needle has one to match.
        i = NORMALIZE_THEMATIC_BREAK_RE.lastIndex;
        continue;
      }
      if (stickyAt(NORMALIZE_TABLE_DELIM_RE, i)) {
        i = NORMALIZE_TABLE_DELIM_RE.lastIndex;
        continue;
      }
      let prefix = stickyAt(NORMALIZE_LINE_PREFIX_RE, i);
      while (prefix) {
        i += prefix[0].length;
        prefix = stickyAt(NORMALIZE_LINE_PREFIX_RE, i);
      }
      continue;
    }
    if (ch === "\\" && i + 1 < str.length && NORMALIZE_ESCAPABLE_RE.test(str[i + 1])) {
      emit(str[i + 1], i + 1); // the escape Turndown added; the source has the bare character
      i += 2;
      continue;
    }
    if (ch === "<" && stickyAt(NORMALIZE_TAG_RE, i)) {
      i = NORMALIZE_TAG_RE.lastIndex;
      continue;
    }
    // [[Note|id]] renders as "Note" — the id is invisible, so drop it (see
    // the note-reference link format) rather than leaving it to mismatch.
    if (ch === "[" && str[i + 1] === "[") {
      const close = str.indexOf("]]", i + 2);
      if (close !== -1) {
        const pipe = str.indexOf("|", i + 2);
        const labelEnd = pipe !== -1 && pipe < close ? pipe : close;
        for (let k = i + 2; k < labelEnd; k += 1) {
          if (!NORMALIZE_DROP_CHARS.has(str[k])) emit(str[k], k);
        }
        i = close + 2;
        continue;
      }
    }
    // ](target) — only the label is rendered.
    if (ch === "]" && str[i + 1] === "(" && stickyAt(NORMALIZE_LINK_TARGET_RE, i)) {
      i = NORMALIZE_LINK_TARGET_RE.lastIndex;
      continue;
    }
    if (NORMALIZE_DROP_CHARS.has(ch)) {
      i += 1;
      continue;
    }
    emit(ch, i);
    i += 1;
  }
  return { text: chars.join(""), map };
}

// Inline constructs a match must not be allowed to start or end HALFWAY
// through. The normalized projection has no markup left in it, so a hit can
// legitimately land between a code span's backticks or inside a **bold** run —
// and wrapping THAT in <mark> yields `<mark>foo</mark>` (tags shown as literal
// code) or "**foo <mark>bar** baz</mark>" (tags crossing the emphasis they
// were opened inside). Widening the range to swallow the whole construct keeps
// the markup balanced. Long/multi-block regions are ignored: a mispaired lone
// `*` or `_` must not be able to drag a highlight across half the note.
export const INLINE_REGION_MAX_CHARS = 400;

// `literal: true` marks a construct whose CONTENTS are not markdown — a code
// span, a formula. Nothing may be inserted inside one, so a hit landing wholly
// within it still has to be widened to swallow the whole thing, or wrapping it
// produces `<mark>foo</mark>` shown as literal code.
//
// Everything else is a container: markup nests inside it perfectly well, so a
// hit that sits wholly INSIDE one is already balanced and must be left exactly
// where it is. That distinction is load-bearing rather than cosmetic —
// highlightToggleInSource recognises an existing highlight by finding <mark>
// immediately BEFORE the hit and </mark> immediately after, so widening a hit
// that already sits inside a mark hides the very tags the toggle looks for, and
// re-highlighting the same words nested a second mark instead of removing the
// first. Straddling one edge of a container is still widened: that is the
// "**foo <mark>bar** baz</mark>" case this whole mechanism exists for.
export const INLINE_REGION_PATTERNS = [
  { re: /(`+)[^\n]*?\1/g, literal: true },
  { re: /<(mark|u|kbd|span|b|i|em|strong|sub|sup|del|ins|small)\b[^>]*>[\s\S]*?<\/\1>/gi },
  { re: /\*\*[^\n]+?\*\*/g },
  { re: /__[^\n]+?__/g },
  { re: /~~[^\n]+?~~/g },
  { re: /\{\{[^\n]*?\}\}/g },
  { re: /!?\[[^\]\n]*\]\([^)\n]*\)/g },
  { re: /\$\$[\s\S]*?\$\$/g, literal: true },
  { re: /\$[^\n$]+?\$/g, literal: true },
  { re: /(^|[^*\w])(\*[^\s*][^\n*]*?\*)/g },
  { re: /(^|[^_\w])(_[^\s_][^\n_]*?_)/g }
];

export function inlineRegionsIn(source) {
  const regions = [];
  for (const { re: pattern, literal } of INLINE_REGION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(source)) !== null) {
      if (m[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      // Patterns with a leading guard group report the construct in m[2].
      const body = m[2] !== undefined ? m[2] : m[0];
      const start = m.index + m[0].indexOf(body);
      if (body.length <= INLINE_REGION_MAX_CHARS) regions.push({ start, end: start + body.length, literal: Boolean(literal) });
    }
  }
  return regions;
}

// Only the two EDGES of a hit can be unbalanced, and no region this cares about
// is longer than INLINE_REGION_MAX_CHARS — so a region that could widen an edge
// must begin within that many characters of it. Scanning a window around each
// edge instead of the whole note is what makes this affordable on the fast path:
// eleven regexes over a 4MB note, on every highlight, is not.
//
// The window is padded by a full four widening passes' worth so a chain of
// nested constructs (a link inside bold inside a quote) still resolves the same
// way it would have against the whole document. Lines are never crossed by these
// patterns anyway, apart from the two multi-line ones, which the padding covers.
export const INLINE_REGION_WINDOW_CHARS = INLINE_REGION_MAX_CHARS * 4;

// Spread, never rebuilt field by field: a region carries `literal` as well as
// its bounds, and a `{ start, end }` literal here silently dropped it — which
// turned every code span and formula back into a container and undid the
// containment rule below.
export function shiftRegions(regions, offset) {
  return regions.map((r) => ({ ...r, start: r.start + offset, end: r.end + offset }));
}

export function inlineRegionsNear(source, start, end) {
  const from = Math.max(0, start - INLINE_REGION_WINDOW_CHARS);
  const to = Math.min(source.length, end + INLINE_REGION_WINDOW_CHARS);
  // One window when the edges are close enough to share it, which is the common
  // case — a selection is usually far shorter than the padding.
  if (to - from <= INLINE_REGION_WINDOW_CHARS * 3) {
    return shiftRegions(inlineRegionsIn(source.slice(from, to)), from);
  }
  const headTo = Math.min(source.length, start + INLINE_REGION_WINDOW_CHARS);
  const tailFrom = Math.max(headTo, end - INLINE_REGION_WINDOW_CHARS);
  return [
    ...shiftRegions(inlineRegionsIn(source.slice(from, headTo)), from),
    ...shiftRegions(inlineRegionsIn(source.slice(tailFrom, to)), tailFrom)
  ];
}

export function expandToBalancedBounds(source, start, end) {
  const regions = inlineRegionsNear(source, start, end);
  let s = start;
  let e = end;
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const region of regions) {
      const startsInside = region.start < s && s < region.end;
      const endsInside = region.start < e && e < region.end;
      // Wholly inside a container (markup nests there) — already balanced, and
      // widening would hide the tags highlightToggleInSource reads. Literals
      // still widen: nothing can be inserted inside a code span or a formula.
      if (!region.literal && startsInside && endsInside) continue;
      if (startsInside) {
        s = region.start;
        changed = true;
      }
      if (endsInside) {
        e = region.end;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { start: s, end: e };
}

// Locate `needle` in `source` through the normalized projection above.
// `normalizedSource` is passed in so both needles reuse one pass over what can
// be a very long note. Returns the same { idx, end, needle } shape as the other
// matchers, with `needle` read back out of the SOURCE (never the projection).
export function looseMarkupMatch(source, normalizedSource, needle, occurrence, bounded) {
  const target = normalizeMarkupForMatch(needle).text;
  if (target.length < 3) return null; // too short to be sure it's the right copy
  const { text, map } = normalizedSource;
  let pos = nthIndexOf(text, target, occurrence || 0);
  if (pos === -1) pos = text.indexOf(target);
  if (pos === -1) return null;
  const rawStart = map[pos];
  const rawEnd = map[pos + target.length - 1] + 1;
  const bounds = expandToBalancedBounds(source, rawStart, rawEnd);
  // The eraser DELETES the match, so it doesn't get to lose much more than was
  // selected to keeping the markup balanced (see boundedFuzzy).
  if (bounded && (rawStart - bounds.start) + (bounds.end - rawEnd) > FUZZY_OVERMATCH_SLACK_CHARS) return null;
  return { idx: bounds.start, end: bounds.end, needle: source.slice(bounds.start, bounds.end) };
}

// Locate the SELECTED occurrence of a rendered selection inside the markdown
// source. Targets `sel.occurrence` (the copy the user actually highlighted)
// rather than blindly the first match, so repeated words act in place. Tries
// the plain text first (occurrence-aware); falls back to the markdown
// serialization (so a selected image / math / bold run that isn't present
// verbatim as plain text still matches). Returns { idx, end, needle } or null
// when the selection can't be located at all (e.g. it spans block boundaries).
//
// `fuzzy: true` adds a third retry, tolerant of whitespace and list-marker
// differences (see fuzzyWhitespaceMatch) — needed for a selection spanning
// list items, where Turndown's padded "-   " markers never equal this app's
// own single-space "- ". Opt-in, not the default: a caller that just wraps
// the match in a simple pair (clozeToggleInSource, the bold/italic/colour
// text formatters) would corrupt a multi-item list the same way a bare
// <mark> across block boundaries used to — wrapAcrossBlocks exists so
// highlightToggleInSource can ask for this safely, and eraseSelectionFrom-
// Source opts in because REMOVING the whole match is marker-safe; the
// wrapping callers that aren't block-boundary-safe still don't opt in.
// `boundedFuzzy: true` additionally rejects a fuzzy match that came back much
// longer than what was searched for. fuzzyWhitespaceMatch turns every run of
// whitespace in the needle into `\s+`, and across a paragraph gap that is
// greedy enough to swallow whole blocks the reader never selected. Harmless
// when the caller only wraps the match; not harmless for the eraser, which
// DELETES it — so the one destructive caller asks for the check.
export const FUZZY_OVERMATCH_SLACK_CHARS = 40;

export const FUZZY_OVERMATCH_SLACK_RATIO = 1.15;

// Widen a hit so it cannot start or end halfway through an inline construct.
//
// looseMarkupMatch has done this since it was written (its projection drops the
// syntax characters, so a hit landing between a code span's backticks is its
// normal failure mode) — but the exact and whitespace-fuzzy stages never did,
// and they can land the same way: the rendered text of `**bold text**` is
// "bold text", so selecting "old te" finds that substring verbatim in the
// source and wrapping it yields "**b<mark>old te</mark>xt**"… which is fine,
// while selecting from mid-bold to past the closing "**" yields tags crossing
// the emphasis they were opened inside. Same widening, same slack budget, so
// the eraser still refuses a match that grew far beyond what was selected.
export function balancedHit(source, hit, bounded) {
  if (!hit) return null;
  const bounds = expandToBalancedBounds(source, hit.idx, hit.end);
  if (bounds.start === hit.idx && bounds.end === hit.end) return hit;
  if (bounded && (hit.idx - bounds.start) + (bounds.end - hit.end) > FUZZY_OVERMATCH_SLACK_CHARS) return null;
  return { idx: bounds.start, end: bounds.end, needle: source.slice(bounds.start, bounds.end) };
}

export function locateSelectionInSource(source, sel, { fuzzy = false, boundedFuzzy = false } = {}) {
  const attempts = [];
  if (sel.asText) attempts.push({ needle: sel.asText, occurrence: sel.occurrence || 0 });
  // asMarkdown has no occurrence count of its own, but repeats of the same
  // markdown are highly correlated with repeats of the same plain text, so
  // sel.occurrence (computed against asText) is a far better guess than
  // always assuming the first copy in the note — which is what a flat 0 did.
  if (sel.asMarkdown && sel.asMarkdown !== sel.asText) attempts.push({ needle: sel.asMarkdown, occurrence: sel.occurrence || 0 });

  for (const { needle, occurrence } of attempts) {
    let idx = nthIndexOf(source, needle, occurrence);
    if (idx === -1) idx = source.indexOf(needle); // occurrence miscounted → first match
    if (idx === -1) continue;
    const hit = balancedHit(source, { idx, end: idx + needle.length, needle }, boundedFuzzy);
    if (hit) return hit;
  }
  if (fuzzy) {
    for (const { needle, occurrence } of attempts) {
      const match = fuzzyWhitespaceMatch(source, needle, occurrence);
      if (!match) continue;
      if (boundedFuzzy) {
        const budget = Math.max(needle.length * FUZZY_OVERMATCH_SLACK_RATIO, needle.length + FUZZY_OVERMATCH_SLACK_CHARS);
        if (match.needle.length > budget) continue;
      }
      const hit = balancedHit(source, match, boundedFuzzy);
      if (hit) return hit;
    }
    // Still nothing: needle and source disagree about markup, not whitespace.
    const normalizedSource = normalizeMarkupForMatch(source);
    for (const { needle, occurrence } of attempts) {
      const match = looseMarkupMatch(source, normalizedSource, needle, occurrence, boundedFuzzy);
      if (match) return match;
    }
  }
  return null;
}
