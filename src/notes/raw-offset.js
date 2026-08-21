// Mapping a point in the RENDERED note back to an offset in its markdown.
//
// There is no source map — the rendered DOM is matched back to the source by
// its text. Matching is bounded on purpose: an unbounded scan over a large note
// is quadratic and froze the tab for tens of seconds.

import { ensureNotesLazyOffsetBuilt, isTopLevelBlockParent, notesLazyBlockIndexFor, notesLazySpanAt, notesLazySpanStarts, renderedBlockCache } from "../render/block-cache.js?v=__BUILD__";

// ── Triple-click a rendered block → raw edit mode, cursor at that spot ──────
// marked/the DOM give no source-position map back to the raw markdown, so this
// is a best-effort text match: grab a short snippet of plain text immediately
// before/after the click inside its block (paragraph/heading/list item/...),
// then locate that snippet in state.notes with a regex tolerant of the
// markdown syntax (**, `, [text](url), etc.) the renderer stripped out around
// it. Returns null on no confident match — the caller just skips the cursor
// hint rather than guessing wrong.
export const NOTES_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd";

export function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

// Character offset of (node, offset) within root's flattened text — Range
// accepts either a text node + character offset or an element + child index,
// so this works for both kinds of caret target.
export function textOffsetWithin(root, node, offset) {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch (_) {
    return null;
  }
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// How far either side of the hint the windowed search below looks. Wide enough
// to absorb the error in a proportional block-position estimate on a large
// note, narrow enough that a phrase repeated every few hundred characters can't
// be confused across it. A hinted search that misses this window gives up
// rather than widening — see the note at the miss below.
export const SNIPPET_SEARCH_WINDOW_CHARS = 20000;

// ── Why this search is bounded three separate ways ─────────────────────────
// The pattern below used to turn every run of punctuation/whitespace in the
// snippet into its own lazy bounded gap. Chained bounded lazy quantifiers backtrack
// combinatorially when the overall match FAILS, and failing is the common case:
// this runs while you scroll, against whatever block happens to be near the top
// of the viewport, including tables and code fences whose rendered text doesn't
// survive into the raw source verbatim. Measured on a real note shape (an
// indented list, allowNewline on, the 40KB window): ONE call took 9,945ms. That
// is the "scrolling freezes and Chrome offers to exit the site" report — the
// unresponsive-page dialog, not an OOM.
//
// The fix is structural: the gaps are made non-backtracking, so the engine can
// no longer explore anything. A gap is written as a *tempered* run —
//
//     (?:(?!word)[^\n]){0,60}word
//
// — which can only consume characters that do not begin the next word, and so
// stops dead at that word's first occurrence. There is exactly one way for it to
// match, which means adjacent gaps have nothing to negotiate over and the whole
// pattern runs in linear time. Semantically this is first-fit rather than
// full backtracking, which is what we wanted anyway: locate the nearest
// occurrence of these words in this order, within this distance of each other.
//
// Two cheaper bounds sit in front of it: an indexOf prefilter that proves
// impossibility before the engine is involved at all, and a wall-clock budget
// on the scan loop. A snippet that can't be located yields null, and every
// caller already handles null by falling back to a coarser position.
//
// Measured on the case that reproduced the freeze (an indented list, newlines
// allowed, the 40KB window): 9,897ms before, 0.5ms after, with identical
// results on the snippet-matching cases this has to keep getting right.
export const SNIPPET_GAP_MAX_CHARS = 60;

export const SNIPPET_SEARCH_BUDGET_MS = 8;

// Runs shorter than this are too common to be worth an indexOf (a one-letter
// word appears everywhere, so the prefilter would never reject on it).
export const SNIPPET_PREFILTER_MIN_RUN = 3;

// The alphanumeric runs of a snippet, which are what the pattern anchors on.
// Whitespace and punctuation between them is deliberately discarded: the
// rendered text a snippet is taken from has already had markdown syntax
// stripped out of it, so the raw source is expected to differ there — that is
// the entire reason for the gaps.
export function snippetWordRuns(snippet) {
  return (snippet || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
}

// A tempered gap that ends where `next` begins. For prose the gap excludes
// newlines so a short generic fragment can't bridge into an unrelated block;
// inside code we must allow them so a snippet straddling two code lines still
// matches.
export function snippetGap(next, allowNewline) {
  const unit = allowNewline ? "[\\s\\S]" : "[^\\n]";
  return `(?:(?!${escapeRe(next)})${unit}){0,${SNIPPET_GAP_MAX_CHARS}}`;
}

// words joined by tempered gaps: word1 GAP word2 GAP word3 …
export function snippetSequencePattern(runs, allowNewline) {
  if (!runs.length) return null;
  let pattern = escapeRe(runs[0]);
  for (let i = 1; i < runs.length; i += 1) {
    pattern += snippetGap(runs[i], allowNewline) + escapeRe(runs[i]);
  }
  return pattern;
}

// Every word run appears in the pattern verbatim, so if any one of them is
// absent from the text being searched, no match is possible — and indexOf can
// prove that in microseconds.
export function snippetLiteralRuns(snippet) {
  return snippetWordRuns(snippet).filter((run) => run.length >= SNIPPET_PREFILTER_MIN_RUN);
}

export function snippetCannotMatch(text, runs) {
  for (const run of runs) {
    if (text.indexOf(run) === -1) return true;
  }
  return false;
}

// Locate `before`+`after` snippets (either may be empty) inside state.notes and
// return the character offset of the seam between them. `allowNewline` lets the
// gap and fuzzified whitespace cross line breaks — essential inside fenced code
// blocks, whose raw markdown keeps the newlines the click snippet spans.
//
// `hint` is roughly where in the source the caller believes the snippet lives,
// and it is what makes this usable on a repetitive document. The match is
// otherwise simply the FIRST one in the whole note, which is wrong whenever the
// same words appear more than once: an endnote chapter repeats "GO TO NOTE
// REFERENCE IN TEXT" once per note and body prose repeats ordinary phrases all
// the time, so leaving the rendered view for raw mode 600 paragraphs down
// resolved to paragraph 1 and dumped the reader at the top of the note. With a
// hint, the search runs over a window around it and takes the match nearest the
// hint; without one it takes the first match in the document.
export function matchSnippetInSource(source, before, after, allowNewline, hint = null) {
  if (!source || (!before && !after)) return null;
  const beforeRuns = snippetWordRuns(before);
  const afterRuns = snippetWordRuns(after);
  const beforePattern = snippetSequencePattern(beforeRuns, allowNewline);
  const afterPattern = snippetSequencePattern(afterRuns, allowNewline);
  let pattern;
  if (beforePattern && afterPattern) {
    // The seam gap is tempered against the first word on the far side, so it
    // stops at that word rather than negotiating with the gaps around it.
    pattern = `(${beforePattern})${snippetGap(afterRuns[0], allowNewline)}(${afterPattern})`;
  } else if (beforePattern || afterPattern) {
    pattern = `(${beforePattern || afterPattern})`;
  } else {
    // A snippet with no word characters at all (pure punctuation) — nothing to
    // anchor on, so match it literally or not at all.
    pattern = `(${escapeRe(before || after)})`;
  }
  const literalRuns = snippetLiteralRuns(before).concat(snippetLiteralRuns(after));

  try {
    const seam = (match, base) => (before ? match.index + match[1].length : match.index) + base;
    const deadline = performance.now() + SNIPPET_SEARCH_BUDGET_MS;

    if (Number.isFinite(hint)) {
      const start = Math.max(0, Math.floor(hint) - SNIPPET_SEARCH_WINDOW_CHARS);
      const end = Math.min(source.length, Math.floor(hint) + SNIPPET_SEARCH_WINDOW_CHARS);
      if (end > start) {
        // Every match in the window is considered and the one NEAREST the hint
        // wins. Taking the window's first match instead would just move the
        // original bug rather than fix it: on text that repeats every few dozen
        // characters the first hit in the window is its left edge, which is
        // wrong by however wide the window is.
        const slice = source.slice(start, end);
        // Cheap proof of impossibility before the engine is involved at all.
        if (snippetCannotMatch(slice, literalRuns)) return null;
        const scan = new RegExp(pattern, "g");
        let best = null;
        let bestDistance = Infinity;
        let match;
        while ((match = scan.exec(slice)) !== null) {
          const position = seam(match, start);
          const distance = Math.abs(position - hint);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = position;
          }
          // A pattern that can match empty would never advance lastIndex.
          if (match.index === scan.lastIndex) scan.lastIndex += 1;
          if (performance.now() > deadline) break;
        }
        if (best != null) return best;
        // A hint that missed its own ±20,000-char window is not going to produce
        // a trustworthy answer from the rest of the note, only a slow wrong one:
        // the whole reason the hint exists (see the header comment) is that the
        // first match elsewhere in a repetitive document is the WRONG match. So
        // a hinted miss is a miss, and the caller falls back to block-level
        // positioning rather than paying for a full-document scan.
        return null;
      }
    }

    if (snippetCannotMatch(source, literalRuns)) return null;
    const match = new RegExp(pattern).exec(source);
    if (!match) return null;
    return seam(match, 0);
  } catch (_) {
    return null;
  }
}

// Roughly where in `source` a given rendered block begins, for use as a search
// hint (never as an answer). The incremental renderer already keeps this
// container's blocks in document order with each one's own prepared source as
// its cache key, so the share of the document lying before a block is just the
// share of those key lengths — no measuring and no re-lexing. It is a ratio
// rather than a raw character sum because preprocessSpecialBlocks changes
// lengths on its way to the prepared text (math, cloze and code protection),
// so prepared offsets and raw offsets differ by a factor that a proportion
// cancels out. Returns null when there's no cache to read, and the caller
// simply searches without a hint.
// The total length of every cached block's source key, memoized on the cache
// entry itself.
//
// Both of the functions below need it, and both used to add it up from scratch
// on every call — 24,000 string reads per call on a book, and
// findRenderedNoteRange asks once per block inside its search window, which made
// one anchor jump O(window x note). The entry is a fresh object per render (see
// renderedBlockCache.set), so there is nothing to invalidate.
export function blockKeyLengthTotal(cached) {
  if (cached.totalKeyLength == null) {
    let total = 0;
    for (const entry of cached.blocks) total += (entry.key || "").length;
    cached.totalKeyLength = total;
  }
  return cached.totalKeyLength;
}

// The rendered block a raw-markdown offset falls in, by the same proportion
// approximateRawOffsetForBlock works in — its exact inverse.
//
// This is how a reading position is restored, and it is deliberately not a
// pixel calculation. A note's HEIGHT is mostly guesses until the reader has
// been there (content-visibility hands every unvisited chunk an estimate), so
// "scroll to 40% of scrollHeight" can be tens of thousands of pixels from 40%
// of the TEXT — measured on a 2.6MB book: the reader's real position was at
// scrollTop 179,543 and the proportional guess was 690,550. Block keys are the
// source itself, so this answer does not move as the layout settles.
// ── The same question, asked of a note that is built as it is read ─────────
//
// A lazily-rendered note knows something better than a proportion of block-key
// lengths: it knows, exactly, which slice of the PREPARED text every span
// covers. So the mapping goes through the span index instead — offset -> its
// share of the prepared text -> the span holding it -> that span's blocks.
//
// And because the answer has to be a real element, the span is BUILT if it is
// not built already. That is the whole point of the call: a reading-position
// restore or a highlight jump landing in chapter 30 has to have chapter 30 in
// the document to land on. The build is one span — size-bounded, a frame's
// work — not the note.
export function notesLazyBlockForRawOffset(root, cached, source, offset) {
  const plan = cached.lazy;
  const want = Math.max(0, Math.min(1, offset / source.length)) * plan.prepared.length;
  const index = notesLazySpanAt(plan, want);
  ensureNotesLazyOffsetBuilt(root, want);
  const chunk = plan.chunks[index];
  if (!chunk) return null;
  const span = plan.spans[index];
  const groups = plan.groups[index];
  const starts = notesLazySpanStarts(plan, index);
  // Exactly which block, from the span's own measured block offsets. A
  // proportion of the span would be up to forty blocks out, and on a resume
  // that is the difference between the paragraph the reader left and the
  // section heading a screen above it.
  if (groups && starts && starts.length) {
    const local = Math.max(0, Math.min(span.end - span.start, want - span.start));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= local) lo = mid;
      else hi = mid - 1;
    }
    for (let n = lo; n >= 0; n -= 1) {
      const node = (groups[n] || []).find((child) => child && child.nodeType === 1 && child.isConnected);
      if (node) return node;
    }
  }
  const blocks = Array.from(chunk.children).filter((node) => node.nodeType === 1);
  if (!blocks.length) return chunk.isConnected ? chunk : null;
  const through = span.end > span.start ? (want - span.start) / (span.end - span.start) : 0;
  const at = Math.max(0, Math.min(blocks.length - 1, Math.floor(through * blocks.length)));
  return blocks[at];
}

export function notesBlockForRawOffset(root, source, offset) {
  const cached = renderedBlockCache.get(root);
  if (!cached || !source) return null;
  if (!Number.isFinite(offset)) return null;
  if (cached.lazy) return notesLazyBlockForRawOffset(root, cached, source, offset);
  if (!Array.isArray(cached.blocks) || !cached.blocks.length) return null;
  const total = blockKeyLengthTotal(cached);
  if (!total) return null;
  const want = Math.max(0, Math.min(1, offset / source.length)) * total;
  let seen = 0;
  let last = null;
  for (const entry of cached.blocks) {
    const node = (entry.nodes || []).find((n) => n && n.nodeType === 1 && n.isConnected);
    if (node) last = node;
    seen += (entry.key || "").length;
    if (seen >= want && node) return node;
  }
  return last;
}

export function approximateRawOffsetForBlock(root, source, node) {
  const cached = renderedBlockCache.get(root);
  if (!cached || !source) return null;
  // Lazily built: the span index already knows where this block's chunk starts
  // in the prepared text, which is a far better hint than a proportion over
  // "whatever has been built so far" — that denominator grows as the reader
  // scrolls, so the same block would answer differently at different times.
  if (cached.lazy) return lazyRawOffsetForBlock(cached, source, node, root);
  if (!Array.isArray(cached.blocks) || !cached.blocks.length) return null;

  // Walk up to the top-level block. "Top level" is a direct child of root OR of
  // one of its chunks — stopping only at root would climb past the block to the
  // chunk, which is never in entry.nodes, so this returned null for every block
  // of a chunked note. That costs the caller its position hint, and without the
  // hint matchSnippetInSource falls back to the first match in the whole
  // document: triple-clicking paragraph 600 lands you at paragraph 1.
  let topLevel = node;
  while (topLevel?.parentElement && !isTopLevelBlockParent(topLevel.parentElement, root)) {
    topLevel = topLevel.parentElement;
  }
  if (!topLevel || !isTopLevelBlockParent(topLevel.parentElement, root)) return null;

  // Stops at the block it was asked about. The total comes from the memo above,
  // so there is no reason to keep walking past the answer — which on a book is
  // the difference between reading 24,000 keys and reading as far as the
  // reader has got.
  let before = 0;
  let found = false;
  for (const entry of cached.blocks) {
    if (Array.isArray(entry.nodes) && entry.nodes.includes(topLevel)) {
      found = true;
      break;
    }
    before += (entry.key || "").length;
  }
  const total = blockKeyLengthTotal(cached);
  if (!found || !total) return null;
  return (before / total) * source.length;
}

// `root` is the rendered container (notes view, or a card's question/answer
// `.rendered`) and `source` its raw markdown — the mapping is identical for
// both, so notes and cards share this one resolver.
export function findRawOffsetForRenderedPoint(root, source, clientX, clientY) {
  if (!root) return null;
  const caret = caretFromPoint(clientX, clientY);
  // Widgets (rendered code fences, cloze/math, images) can swallow the caret or
  // sit outside a text block — fall back to the element under the pointer so the
  // block lookup below can still land us in the right region of the raw source.
  const anchorNode = caret && root.contains(caret.node)
    ? caret.node
    : document.elementFromPoint(clientX, clientY);
  if (!anchorNode || !root.contains(anchorNode)) return null;

  const startEl = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
  const block = startEl?.closest?.(NOTES_BLOCK_SELECTOR);
  if (!block || !root.contains(block)) return null;

  // Code fences render verbatim, so their raw markdown keeps the exact newlines
  // and punctuation the click snippet spans — match across lines for those.
  const isCode = block.tagName === "PRE" || Boolean(startEl.closest("pre, code"));
  const blockText = block.textContent || "";
  // Which region of the source to prefer. Without this the snippet search takes
  // the first match in the note, so any phrase that recurs resolves to its
  // earliest occurrence instead of the one under the pointer.
  const hint = approximateRawOffsetForBlock(root, source, block);

  // Precise hit: match the text on both sides of the exact click point.
  const localOffset = caret && root.contains(caret.node)
    ? textOffsetWithin(block, caret.node, caret.offset)
    : null;
  if (localOffset != null) {
    const before = blockText.slice(Math.max(0, localOffset - 24), localOffset).trim();
    const after = blockText.slice(localOffset, localOffset + 24).trim();
    // Only when there is text on BOTH sides of the caret. With `before` empty
    // the caret is at the very start of the block — which is what a probe
    // landing in the MARGIN above a block gives you, because the caret snaps to
    // offset 0 of the nearest text node, and margins are where the reading line
    // spends much of its time. The seam is then simply "the start of this
    // block", and the block resolver below answers exactly that question from
    // the block's first 40 characters instead of guessing it from 24.
    //
    // Guessing it from 24 was actively wrong, not merely weaker. With no left
    // context the pattern is just the right-hand word runs, and a run is
    // matched verbatim with no word boundary around it — so an `after` of
    // "Interaction paragraph 1" matches inside "Interaction paragraph 100",
    // and the hint picks whichever match is NEAREST, which on a hint that
    // drifts low is the earlier, wrong one. Measured on a 12.8M-char book: the
    // captured reading position landed 4 and 16 blocks before the paragraph the
    // reader was actually on, which the resume then faithfully restored.
    if (before) {
      const hit = matchSnippetInSource(source, before, after, isCode, hint);
      if (hit != null) return hit;
    }
  }

  // Fallback: we know which block was clicked but not the precise seam (widget,
  // failed fuzzy match, …). Land at the start of that block rather than leaving
  // the caret to snap to the very end of the source.
  return rawOffsetForRenderedBlock(root, source, block, { isCode, hint });
}

// Where a whole rendered block begins in the raw source — block-level precision,
// no click point involved. Split out of findRawOffsetForRenderedPoint's own
// fallback so the reading-line resolver below can reach it directly, for the case
// where there is no usable caret at all (the reading line sitting in the gap
// between two blocks, or under a floating overlay).
// `hint` is passed in when the caller already has it: approximateRawOffsetForBlock
// walks the whole block cache, and this sits on the scroll-settle path (see
// captureCurrentReadingAnchor), so it must not be computed twice.
export function rawOffsetForRenderedBlock(root, source, block, { isCode = null, hint } = {}) {
  if (!root || !block || !source) return null;
  const code = isCode == null
    ? block.tagName === "PRE" || Boolean(block.querySelector?.("pre, code"))
    : isCode;
  const blockStart = (block.textContent || "").replace(/^\s+/, "").slice(0, 40).trim();
  if (!blockStart) return null;
  const at = hint === undefined ? approximateRawOffsetForBlock(root, source, block) : hint;
  return matchSnippetInSource(source, blockStart, "", code, at);
}

// Where a rendered block begins in the raw source, for a note whose spans are
// built on demand. The exact inverse of notesLazyBlockForRawOffset: find the
// chunk the node sits in, take its span's start (plus the node's share of the
// span), and express that as a ratio of the prepared text — which
// preprocessSpecialBlocks makes a different length from the raw markdown, so
// the ratio rather than the offset is what carries across.
export function lazyRawOffsetForBlock(cached, source, node, root) {
  const plan = cached.lazy;
  if (!plan.prepared.length) return null;
  let chunk = node;
  while (chunk && chunk.parentNode && chunk.parentNode !== root) chunk = chunk.parentNode;
  if (!chunk || chunk.parentNode !== root) return null;
  const index = plan.chunks.indexOf(chunk);
  if (index === -1) return null;
  const span = plan.spans[index];
  const at = notesLazyBlockIndexFor(plan, index, node);
  const starts = at >= 0 ? notesLazySpanStarts(plan, index) : null;
  // The block's real offset in the prepared text where the span knows it, and
  // the span's own start where it does not (a node the groups no longer own —
  // an enhancement wrapper added after the build). Never a proportion of the
  // span: this is a search HINT, and a hint that is forty blocks out sends
  // matchSnippetInSource to the wrong copy of a repeated phrase.
  const offset = starts && at < starts.length ? span.start + starts[at] : span.start;
  return (offset / plan.prepared.length) * source.length;
}
