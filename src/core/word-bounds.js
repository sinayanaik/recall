// Where a word starts and ends.
//
// Moved here from src/notes/touch-selection.js, which snaps a long press to the
// word under it, so that the document surface's highlighter can snap a drag to
// whole words with the same idea of what a word is — without a module about
// highlighting a PDF having to pull in the notes view's whole selection
// controller to get at three small functions.
//
// Intl.Segmenter rather than a regex because this app renders notes in whatever
// language they were written in, and a regex word boundary is an English
// assumption. The regex is the fallback for an engine without the segmenter.

const wordSegmenter = (() => {
  try {
    return new Intl.Segmenter(navigator.language || "en", { granularity: "word" });
  } catch (_) {
    return null;
  }
})();

const WORD_RE = /[\p{L}\p{N}_'’-]+/gu;

// The word around a CARET offset — the gap between two characters. A caret at
// the very end of a word belongs to that word, which is what a press on the
// last letter wants; see wordSpanAtChar for the question asked of a character.
export function wordBoundsAt(text, offset) {
  if (!text) return null;
  if (wordSegmenter) {
    let fallback = null;
    for (const segment of wordSegmenter.segment(text)) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (offset < start) break;
      if (offset > end) continue;
      if (segment.isWordLike) return { start, end };
      // A press that lands on the space between two words: remember it, but
      // keep looking — the word STARTING at this offset is the better answer.
      if (!fallback && offset > start && offset < end) fallback = { start, end };
    }
    if (fallback) return fallback;
  }
  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(text);
  let previous = null;
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return { start, end };
    if (end < offset) previous = { start, end };
    if (start > offset) break;
    match = WORD_RE.exec(text);
  }
  return previous;
}

// The word a CHARACTER belongs to: the one with start <= index < end, or null
// for a space or a mark of punctuation. Not wordBoundsAt with the index as an
// offset — at a word's last character + 1 that answers with the word BEFORE,
// which is right for a caret and wrong for "the character the pen was over".
export function wordSpanAtChar(text, index) {
  if (!text || index < 0 || index >= text.length) return null;
  if (wordSegmenter) {
    for (const segment of wordSegmenter.segment(text)) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (index < start) break;
      if (index >= end) continue;
      return segment.isWordLike ? { start, end } : null;
    }
    return null;
  }
  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(text);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (index >= start && index < end) return { start, end };
    if (start > index) break;
    match = WORD_RE.exec(text);
  }
  return null;
}
