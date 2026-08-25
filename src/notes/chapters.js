// Where a note's chapters begin and end, worked out from the MARKDOWN.
//
// The app already has a notion of a note's structure — buildNotesToc walks the
// rendered headings — but that one is derived from the DOM, which is useless
// for deciding what to render or what to lay out. This one is derived from the
// source, so it can be asked before anything exists on screen.
//
// It exists for paged reading. Multi-column layout has to measure every block
// it is given in order to know where the columns break, which is why
// content-visibility has to be switched off there and why paged mode used to
// refuse outright above 250,000 characters ("Note too long for pages — scrolling
// instead"). Laying out ONE chapter costs what one chapter costs no matter how
// long the book is, so paging per chapter is what removes that ceiling.

import { preprocessSpecialBlocks } from "../render/preprocess.js?v=__BUILD__";
import { splitPreparedBlocks } from "../render/block-cache.js?v=__BUILD__";

// A heading line in prepared markdown: "## Title". Fences are skipped by the
// walk below, so a "#" inside a code block cannot open a chapter.
export const CHAPTER_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;

export const CHAPTER_FENCE_RE = /^[ \t]{0,3}(```+|~~~+)/;

// A note with no headings at all — an imported wall of text — still has to be
// paged in bounded pieces, so it falls back to fixed runs of blocks. Also the
// ceiling for a single enormous chapter, for the same reason: one chapter is
// the unit of layout, so one chapter has to stay affordable.
export const CHAPTER_MAX_BLOCKS = 400;

// One cached answer, keyed on the source string. Every caller asks per render
// and the work is a scan of the whole note; the block cache and the estimate
// cache are keyed the same way for the same reason.
let cachedSource = null;
let cachedIndex = null;

// The heading level a chapter breaks at: the shallowest one the note actually
// uses. Same rule buildNotesToc applies for indentation (its `minLevel`), so a
// note that starts at "##" chapters on "##" rather than never chaptering at all.
export function chapterHeadingLevel(blocks) {
  let min = 7;
  let fence = null;
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const fenceMatch = CHAPTER_FENCE_RE.exec(line);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
        continue;
      }
      if (fenceMatch) { fence = fenceMatch[1]; continue; }
      const heading = CHAPTER_HEADING_RE.exec(line);
      if (heading) min = Math.min(min, heading[1].length);
    }
  }
  return min === 7 ? 0 : min;
}

// ── Nearest heading for a raw offset ────────────────────────────────────────
// Unlike chapterHeadingLevel/blockStartsChapter above (built for pagination,
// which only cares about the SHALLOWEST heading level and works in block
// indices), this walks raw state.notes directly and remembers a heading of
// ANY level — for the highlights EXPORT feature's "which chapter/section did
// this highlight come from" label (src/export/pdf.js), which wants whatever
// heading is actually nearest, not just the top-level chapter break.
//
// Built once per export (headingIndexFor) and searched by bisection
// (headingForOffset) — same "index once, binary-search per item" shape
// clozeUnitIndex/clozeUnitAt already use for the same reason: a linear scan
// per highlight would be O(highlights × note length).
export function headingIndexFor(source) {
  const headings = [];
  let pos = 0;
  let fence = null;
  for (const line of String(source || "").split("\n")) {
    const start = pos;
    pos += line.length + 1; // +1 for the newline the split ate
    const fenceMatch = CHAPTER_FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    const heading = CHAPTER_HEADING_RE.exec(line);
    if (heading) headings.push({ start, level: heading[1].length, title: heading[2].trim() });
  }
  return headings;
}

// The last heading (of any level) starting at or before `offset`, or null
// when the highlight sits before the note's first heading.
export function headingForOffset(headings, offset) {
  let lo = 0;
  let hi = headings.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].start <= offset) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best === -1 ? null : headings[best];
}

export function blockStartsChapter(block, level) {
  if (!level) return false;
  const first = block.split("\n").find((line) => line.trim());
  if (!first) return false;
  const heading = CHAPTER_HEADING_RE.exec(first);
  return Boolean(heading) && heading[1].length === level;
}

// A chapter is a PAGE's worth of reading, so a section too thin to fill one
// does not get to be a chapter.
//
// Papers are the case this exists for. Their shallowest heading is usually
// "##", so every section became a chapter — including "Keywords", which is one
// line. That section then owned a whole page: 11% of a column used, the rest
// blank, and the reader turning a page to read a single line. Several of those
// in a row is what "the note looks discontinuous" describes.
//
// Measured against a two-column page at a typical reading width, which holds
// roughly 4,500 characters. A section below this is folded into the next one,
// keeping its heading exactly where it was — the text is unchanged, only the
// page boundaries move.
export const CHAPTER_MIN_CHARS = 1200;

// Merge each too-thin chapter into the one AFTER it (its heading belongs with
// what follows), or into the one before when it is last and has no `after`.
export function mergeThinChapters(chapters, blocks) {
  if (chapters.length < 2) return chapters;
  const weight = (chapter) => {
    let total = 0;
    for (let i = chapter.blockStart; i < chapter.blockEnd; i += 1) total += (blocks[i] || "").length;
    return total;
  };

  const out = [];
  for (const chapter of chapters) {
    const previous = out[out.length - 1];
    // Absorbed by the chapter being built when THAT one is still too thin —
    // which is what makes a run of one-line sections collapse into one page
    // rather than into pairs.
    if (previous && weight(previous) < CHAPTER_MIN_CHARS) {
      previous.blockEnd = chapter.blockEnd;
      // The merged chapter keeps the FIRST heading as its title: that is the
      // one the reader sees at the top of the page.
      continue;
    }
    out.push({ ...chapter });
  }

  // The last chapter can have nothing after it to join, so it goes backwards.
  const last = out[out.length - 1];
  if (out.length > 1 && weight(last) < CHAPTER_MIN_CHARS) {
    out[out.length - 2].blockEnd = last.blockEnd;
    out.pop();
  }
  return out;
}

// [{ title, blockStart, blockEnd }] — blockEnd exclusive, covering every block
// exactly once and in order, so `blocks.slice(start, end)` is the chapter.
export function chapterIndexForBlocks(blocks) {
  const level = chapterHeadingLevel(blocks);
  const chapters = [];
  const open = (index, title) => chapters.push({ title, blockStart: index, blockEnd: index + 1 });

  blocks.forEach((block, index) => {
    const last = chapters[chapters.length - 1];
    const starts = blockStartsChapter(block, level);
    // A chapter that has run past the ceiling is closed here even without a
    // heading. Without this a 4MB note whose author used one "#" would be a
    // single chapter, i.e. exactly the whole-book layout this exists to avoid.
    const tooLong = last && last.blockEnd - last.blockStart >= CHAPTER_MAX_BLOCKS;
    if (!last || starts || tooLong) {
      open(index, starts ? CHAPTER_HEADING_RE.exec(block.split("\n").find((l) => l.trim()))[2].trim() : "");
      return;
    }
    last.blockEnd = index + 1;
  });

  if (!chapters.length) return [{ title: "", blockStart: 0, blockEnd: blocks.length }];
  return mergeThinChapters(chapters, blocks);
}

export function chapterIndexFor(source) {
  const text = String(source || "");
  if (cachedSource === text && cachedIndex) return cachedIndex;
  const split = splitPreparedBlocks(preprocessSpecialBlocks(text));
  const blocks = split ? split.blocks : [];
  cachedIndex = blocks.length ? chapterIndexForBlocks(blocks) : [{ title: "", blockStart: 0, blockEnd: 0 }];
  cachedSource = text;
  cachedBlockChars = blocks.map((block) => block.length);
  return cachedIndex;
}

// ── Spans: what the columns are actually given ──────────────────────────────
//
// A chapter was the unit of layout, and that is what put a page break after
// every heading: only one chunk is in the multi-column flow at a time, so a
// chapter that IS the flow necessarily ends partway down some column and the
// next one restarts at page 1. On a paper — six "##" sections — that is a
// half-empty column between every pair of sections, which is the whole of "the
// notes feel discontinuous".
//
// A SPAN is a run of CONSECUTIVE chapters laid out together. Chapters inside one
// span flow into each other exactly as they would in a single continuous
// document, because they genuinely are one flow. A paper is one span and has no
// break in it at all.
//
// The budget is what keeps the original property: the reason for chaptering was
// that multi-column layout has to measure every block it is given (see the
// content-visibility note in styles/18-paged-notes.css), so the flow must stay
// bounded no matter how long the note is. A span is bounded; a book is many
// spans. Where a span DOES end, fitPagedSpanSeam in src/notes/paged-view.js
// moves the boundary onto a page boundary, so even that seam is invisible.

// Roughly thirteen two-column pages at a typical reading width (a page holds
// about 4,500 characters — the same measurement CHAPTER_MIN_CHARS is drawn
// from). Comfortably under the 250,000-character ceiling paged mode used to
// refuse outright, and the one knob to turn if laying a span out ever costs too
// much.
export const SPAN_MAX_CHARS = 60000;

// The block ceiling as well as the character one, because "600 one-line list
// items" and "60,000 characters of prose" cost multi-column layout very
// different amounts. Same value as the per-chapter ceiling, so a span is never
// more blocks than a single chapter already could be.
export const SPAN_MAX_BLOCKS = CHAPTER_MAX_BLOCKS;

let cachedBlockChars = null;
let cachedSpanSource = null;
let cachedSpanStarts = null;

// Seams the layout has MEASURED — see fitPagedSpanSeam. Keyed by span index,
// holding the block index that span starts at. They are geometry-dependent (a
// resize re-flows every column), so they are dropped rather than recomputed
// whenever the columns change shape.
//
// `measuredSource` is which note they were measured on. Nothing calls
// resetChapterIndexCache — every cache here is keyed on the source string
// instead — so without this a seam measured in one note would be replayed into
// the next one opened, cutting a span at a block index that means nothing there.
const measuredSpanStarts = new Map();
let measuredSource = null;

function seamsFor(text) {
  if (measuredSource !== text) {
    measuredSpanStarts.clear();
    measuredSource = text;
  }
  return measuredSpanStarts;
}

// [0, ...] — the block index each span begins at, covering the note in order.
// Chapters are added to the open span while both budgets hold; a span always
// takes at least one chapter, so a single over-budget chapter still gets a span
// of its own (and is already capped at CHAPTER_MAX_BLOCKS by the index above).
//
// `blockChars` is the per-block character count, passed in rather than measured
// here: the caller already has the split blocks, and a span's cost is the sum of
// what its blocks hold.
export function spanStartsForChapters(chapters, blockChars) {
  if (!chapters.length) return [0];
  const chars = blockChars || [];
  const weigh = (chapter) => {
    let total = 0;
    for (let i = chapter.blockStart; i < chapter.blockEnd; i += 1) total += chars[i] || 0;
    return total;
  };
  const starts = [chapters[0].blockStart];
  let held = 0;
  let blocks = 0;
  chapters.forEach((chapter) => {
    const ownChars = weigh(chapter);
    const ownBlocks = chapter.blockEnd - chapter.blockStart;
    if (blocks > 0 && (held + ownChars > SPAN_MAX_CHARS || blocks + ownBlocks > SPAN_MAX_BLOCKS)) {
      starts.push(chapter.blockStart);
      held = 0;
      blocks = 0;
    }
    held += ownChars;
    blocks += ownBlocks;
  });
  return starts;
}

// Re-pack from `fromSpan` onwards. Everything before it is left exactly as it
// is: those spans are already on screen or already fitted, and re-deriving them
// would move boundaries the reader has been reading against.
function packSpansFrom(starts, fromSpan, chapters, blockChars) {
  const out = starts.slice(0, fromSpan);
  const at = starts[fromSpan];
  if (at == null) return out;
  const rest = chapters.filter((chapter) => chapter.blockEnd > at)
    .map((chapter) => ({ ...chapter, blockStart: Math.max(chapter.blockStart, at) }));
  return out.concat(spanStartsForChapters(rest, blockChars));
}

// Where each span begins, for `source`. Memoised the same way the chapter index
// is — every caller asks per render and the work is a scan of the whole note.
export function pagedSpanStarts(source) {
  const text = String(source || "");
  if (cachedSpanSource === text && cachedSpanStarts) return cachedSpanStarts;
  // Fills cachedBlockChars for this exact source as a side effect, which is why
  // it is read only after this call.
  const chapters = chapterIndexFor(text);
  const chars = cachedBlockChars;
  const seams = seamsFor(text);
  let starts = spanStartsForChapters(chapters, chars);
  // Measured seams are replayed in order, so a re-render reproduces exactly the
  // boundaries the reader is looking at rather than snapping back to the packed
  // ones and re-flowing the page under them.
  [...seams.keys()].sort((a, b) => a - b).forEach((spanIndex) => {
    const block = seams.get(spanIndex);
    if (spanIndex <= 0 || spanIndex >= starts.length) return;
    if (block <= starts[spanIndex - 1]) return;
    starts = packSpansFrom([...starts.slice(0, spanIndex), block], spanIndex, chapters, chars);
  });
  cachedSpanStarts = starts;
  cachedSpanSource = text;
  return cachedSpanStarts;
}

// Record a measured seam and rebuild from it. Returns whether anything moved,
// which is how the caller knows whether a re-chunk is worth doing.
export function refinePagedSpanStart(source, spanIndex, blockIndex) {
  if (!(spanIndex > 0) || !(blockIndex > 0)) return false;
  const text = String(source || "");
  const seams = seamsFor(text);
  if (seams.get(spanIndex) === blockIndex) return false;
  if (cachedSpanSource === text && cachedSpanStarts?.[spanIndex] === blockIndex) return false;
  seams.set(spanIndex, blockIndex);
  cachedSpanStarts = null;
  cachedSpanSource = null;
  return true;
}

// A resize, a rotate, a font change or a column-count change re-flows every
// column, so every measured seam is an answer to a question nobody is asking any
// more. Dropped rather than recomputed; the span on screen is re-fitted.
export function resetPagedSpanSeams() {
  if (!measuredSpanStarts.size) return false;
  measuredSpanStarts.clear();
  measuredSource = null;
  cachedSpanStarts = null;
  cachedSpanSource = null;
  return true;
}

// Which chapter a given top-level BLOCK INDEX belongs to.
export function chapterForBlockIndex(chapters, blockIndex) {
  for (let i = 0; i < chapters.length; i += 1) {
    if (blockIndex < chapters[i].blockEnd) return i;
  }
  return Math.max(0, chapters.length - 1);
}

export function resetChapterIndexCache() {
  cachedSource = null;
  cachedIndex = null;
  cachedBlockChars = null;
  cachedSpanSource = null;
  cachedSpanStarts = null;
  measuredSpanStarts.clear();
  measuredSource = null;
}
