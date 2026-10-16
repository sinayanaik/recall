// The arithmetic behind the reading-progress line, with nothing to import: where
// a chapter breaks, which chapter a position is in, how many are done, and how
// many words come before a point in a note. Pure, so
// tools/reading-stats-check.mjs runs it under Node.
//
// Units are whatever the caller measures in — pages (fractional) for a PDF,
// words for a note. A chapter is the shallowest heading level the file uses
// more than once: a book's outline usually opens with one entry for the book
// itself, and counting that as "Ch 1/1" would say nothing.

// ── Chapters ────────────────────────────────────────────────────────────────

// [{ start, level, title }] → the entries a chapter breaks at, in reading order.
export function pickChapterLevel(entries) {
  const usable = (entries || []).filter((entry) => Number.isFinite(entry.start) && entry.start >= 0);
  if (!usable.length) return [];
  const levels = [...new Set(usable.map((entry) => entry.level))].sort((a, b) => a - b);
  let level = levels[0];
  if (usable.filter((entry) => entry.level === level).length <= 1 && levels.length > 1) level = levels[1];
  const picked = usable.filter((entry) => entry.level === level).sort((a, b) => a.start - b.start);
  return picked.filter((entry, index) => index === 0 || entry.start > picked[index - 1].start);
}

// Where `pos` sits among `chapters`, and how many of them `furthest` has
// finished. A chapter is finished once the reader has reached the start of the
// next one, or — for the last — the end of the file.
export function chapterProgress(chapters, pos, furthest, total) {
  if (!chapters?.length || !(total > 0)) return null;
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].start <= pos + 1e-9) index = i; else break;
  }
  const endOf = (i) => (i + 1 < chapters.length ? chapters[i + 1].start : total);
  let done = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    if (endOf(i) <= furthest + 1e-6) done += 1;
  }
  const at = Math.max(0, index);
  const start = index === -1 ? 0 : chapters[at].start;
  const end = index === -1 ? chapters[0].start : endOf(at);
  return {
    chIndex: index,
    chTotal: chapters.length,
    chTitle: index === -1 ? "" : chapters[at].title || "",
    chDone: done,
    chLeftUnits: Math.max(0, end - pos),
    chPct: end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1
  };
}

// ── Words in a note ─────────────────────────────────────────────────────────
//
// A word count at every 1024th character, built once per note body, so "how
// many words come before this offset" is one lookup and a scan of at most one
// stretch — not a pass over a four-megabyte book every five seconds.

const WORD_STEP = 1024;
const STATS_WORD_RE = /\S+/g;

export function buildWordIndex(source) {
  const text = String(source || "");
  const checkpoints = [0];
  let count = 0;
  let boundary = WORD_STEP;
  STATS_WORD_RE.lastIndex = 0;
  let match;
  while ((match = STATS_WORD_RE.exec(text))) {
    while (match.index >= boundary) {
      checkpoints.push(count);
      boundary += WORD_STEP;
    }
    count += 1;
  }
  while (boundary <= text.length) {
    checkpoints.push(count);
    boundary += WORD_STEP;
  }
  return { text, checkpoints, total: count };
}

// Words that START before `offset`.
export function wordsBeforeOffset(index, offset) {
  const text = index.text;
  const at = Math.max(0, Math.min(text.length, Math.floor(Number(offset) || 0)));
  const slot = Math.min(index.checkpoints.length - 1, Math.floor(at / WORD_STEP));
  const from = slot * WORD_STEP;
  let count = index.checkpoints[slot];
  const re = /\S+/g;
  re.lastIndex = from;
  let match;
  while ((match = re.exec(text)) && match.index < at) {
    // A word that began before `from` is already counted in the checkpoint.
    if (!(match.index === from && from > 0 && /\S/.test(text[from - 1]))) count += 1;
  }
  return count;
}

// ── Active time ─────────────────────────────────────────────────────────────

// How much of the stretch (from, to] the reader was active for: all of it up to
// `idleMs` after their last input, and none after.
export function activeSpan(from, to, inputAt, idleMs) {
  if (!(to > from)) return 0;
  return Math.max(0, Math.min(to, inputAt + idleMs) - from);
}

// ── Reading, or moving through the file? ────────────────────────────────────

// The most a single move may cover and still be reading: a contents entry, a
// search hit, a link or a resume landing is bigger than this.
export const READING_JUMP_UNITS = { pdf: 3, notes: 1500 };

// The fastest anyone reads, in units a second — a page a second, three thousand
// words a minute. Position is tracked every frame now, so a fling arrives as
// many small moves; it is caught by how FAST the place moves, over a stretch of
// at least a quarter of a second, not only by how far a single move goes.
export const READING_JUMP_RATE = { pdf: 1, notes: 50 };
export const READING_JUMP_MIN_SPAN_MS = 250;

export function isReadingJump(kind, delta, dtMs) {
  const limit = READING_JUMP_UNITS[kind];
  const rate = READING_JUMP_RATE[kind];
  if (!limit || !rate || !Number.isFinite(delta)) return false;
  if (Math.abs(delta) > limit) return true;
  return Math.abs(delta) / (Math.max(dtMs || 0, READING_JUMP_MIN_SPAN_MS) / 1000) > rate;
}

// ── Notes between two exact readings ────────────────────────────────────────
//
// The exact place in a note (a caret hit test under the reading line) is too
// expensive to take on every frame, so it is taken when scrolling settles. In
// between, the place follows the scroll: words move with pixels at the rate
// the last two exact readings measured, or — before there are two — at the
// note's average. `calibration` is { scrollTop, words, wordsPerPx }.
export function interpolateNotesWords(calibration, scrollTop, total, fallbackWordsPerPx) {
  if (!calibration || !(total > 0)) return null;
  const rate = calibration.wordsPerPx > 0 ? calibration.wordsPerPx : fallbackWordsPerPx;
  if (!(rate > 0)) return calibration.words;
  const words = calibration.words + (scrollTop - calibration.scrollTop) * rate;
  return Math.max(0, Math.min(total, words));
}

// The local rate from two exact readings, when they are far enough apart to
// say anything — and only when it is within a factor of four of the average,
// since a figure or a code block between them is not what the next screen is.
export function calibrateWordsPerPx(previous, next, averageWordsPerPx) {
  if (!previous || !next) return 0;
  const pixels = next.scrollTop - previous.scrollTop;
  const words = next.words - previous.words;
  if (Math.abs(pixels) < 200 || words === 0 || Math.sign(words) !== Math.sign(pixels)) return 0;
  const rate = words / pixels;
  if (averageWordsPerPx > 0 && (rate > averageWordsPerPx * 4 || rate < averageWordsPerPx / 4)) return 0;
  return rate;
}
