// Fuzzy title matching for the `[[` picker.
//
// The picker used to filter on `title.toLowerCase().includes(needle)`, which is
// exact enough to be useless the moment you are not sure of the name: one typo,
// one skipped word, "chain rule" for "The Chain Rule" — all of them return
// nothing, and the only way out is to remember harder. That is the friction
// this file exists to remove.
//
// What this is NOT: fuzzyWhitespaceMatch in src/format/locate-selection.js is a
// source locator (find this rendered selection back in the markdown), not a
// ranker. There is no scoring utility in the tree and no npm to pull one from,
// so this is the whole of it — deliberately small: a subsequence test plus a
// score, no index, no cache, over a list that is at most a few thousand titles.

// A run of matched characters, so the row can show WHERE it matched. Returned
// as [start, end) pairs over the haystack rather than as marked-up text: the
// caller escapes, this only measures.
export function mergeMatchRanges(positions) {
  const ranges = [];
  for (const at of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}

// Is this haystack position the start of a word? Used for the bonus that makes
// "cr" rank "Chain Rule" above "Concrete", which is the single biggest
// difference between a fuzzy matcher that feels psychic and one that feels
// random.
export function isWordStart(text, at) {
  if (at === 0) return true;
  const prev = text[at - 1];
  if (/[\s/›_\-.,:(\[]/.test(prev)) return true;
  // camelCase and TitleCase boundaries.
  return prev === prev.toLowerCase() && text[at] !== text[at].toLowerCase();
}

// Greedy left-to-right subsequence match with a score, or null when the needle
// is not a subsequence of the haystack at all.
//
// Greedy, not optimal: finding the best-scoring alignment is a dynamic program,
// and for titles this short the difference never showed up in practice while
// the cost of running it per keystroke over the whole library would. The one
// place greed is corrected is the contiguity check below — having matched a
// character, a run continuing from it is always preferred to a later isolated
// hit, which is the case greed actually gets wrong.
export function fuzzyMatch(needle, haystack) {
  const text = String(haystack || "");
  const query = String(needle || "").trim();
  if (!query) return { score: 0, ranges: [] };
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // A plain substring hit is both the common case and the best one, so it is
  // answered directly rather than falling out of the general path with a score
  // that would have to be tuned to beat scattered matches.
  const direct = lowerText.indexOf(lowerQuery);
  if (direct !== -1) {
    let score = 1000;
    if (direct === 0) score += 400;              // a prefix: almost always the one meant
    else if (isWordStart(lowerText, direct)) score += 200;
    score -= Math.min(direct, 60);               // earlier beats later
    score -= Math.min(text.length - query.length, 60); // shorter beats longer
    return { score, ranges: [[direct, direct + query.length]], contiguous: true };
  }

  const positions = [];
  let at = 0;
  let score = 0;
  let run = 0;
  for (const char of lowerQuery) {
    // Whitespace in the query is a separator, not something to find: typing
    // "chain rule" must still match "Chain-Rule" and "Chain › Rule".
    if (/\s/.test(char)) { run = 0; continue; }
    const found = lowerText.indexOf(char, at);
    if (found === -1) return null;
    if (found === at && at > 0) { run += 1; score += 15 + run * 5; }
    else run = 0;
    if (isWordStart(lowerText, found)) score += 30;
    if (found === 0) score += 40;
    score -= Math.min(found - at, 20); // characters skipped over cost something
    positions.push(found);
    at = found + 1;
  }
  if (!positions.length) return { score: 0, ranges: [] };
  score -= Math.min(text.length, 80) / 2; // shorter titles win a tie
  return { score, ranges: mergeMatchRanges(positions), contiguous: false };
}

// Score an index entry the way the picker wants it ranked: the title is what
// was typed at, and the folder path is a fallback so "calc/chain" can reach
// Math/Calculus › Chain Rule. A path hit is worth strictly less than a title
// hit, so a note actually called "Calculus" always outranks one merely filed
// under it.
export function scoreNoteEntry(entry, needle) {
  const title = fuzzyMatch(needle, entry?.title || "");
  if (title) return { score: title.score, ranges: title.ranges };
  const path = fuzzyMatch(needle, `${entry?.category || ""}/${entry?.title || ""}`);
  if (path) return { score: path.score - 600, ranges: [] };
  return null;
}
