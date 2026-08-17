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

export function blockStartsChapter(block, level) {
  if (!level) return false;
  const first = block.split("\n").find((line) => line.trim());
  if (!first) return false;
  const heading = CHAPTER_HEADING_RE.exec(first);
  return Boolean(heading) && heading[1].length === level;
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

  return chapters.length ? chapters : [{ title: "", blockStart: 0, blockEnd: blocks.length }];
}

export function chapterIndexFor(source) {
  const text = String(source || "");
  if (cachedSource === text && cachedIndex) return cachedIndex;
  const split = splitPreparedBlocks(preprocessSpecialBlocks(text));
  const blocks = split ? split.blocks : [];
  cachedIndex = blocks.length ? chapterIndexForBlocks(blocks) : [{ title: "", blockStart: 0, blockEnd: 0 }];
  cachedSource = text;
  return cachedIndex;
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
}
