// What the library's search box matches, and how well.
//
// It used to be `title.toLowerCase().includes(term)`: one typo, words in a
// different order, an accent, or remembering the FOLDER rather than the name —
// all of those found nothing. And what it did find was handed to the folder
// view unchanged, so a match two folders deep showed up as the folder it was
// in. The renderer side of that is in my-decks-render.js
// (renderMyDecksSearchResults); this is the matching side.
//
// The rules, in the order a result ranks:
//   - every word typed has to be found somewhere (any order: "rule chain"
//     finds "Chain Rule");
//   - in the title as typed (a prefix or the start of a word ranks highest),
//   - else in the file's folder path ("calculus" finds every file in
//     Math/Calculus),
//   - else in the title with a typo ("calculsu"), or with letters left out
//     ("chnrl") — the weakest kind of hit, and never for one- or two-letter
//     words, which would match half the library.
// Case and accents never matter ("resume" finds "Résumé").
//
// Pure: no DOM, no state. tools/library-search-check.mjs runs it in Node.
//
// A folder that matches is the same test against its own path, substring
// only — which keeps one promise the selection code depends on: if a folder
// matches, every file inside it matches too (its path contains the folder's),
// so ticking a folder in the results selects exactly what the results show
// under it. See myDeckMatchesSearch in my-decks-selection.js.

import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { fuzzyMatch, isWordStart, mergeMatchRanges } from "../notes/link-fuzzy.js?v=__BUILD__";
import { normalizeDeckCategory } from "./folders.js?v=__BUILD__";

// Lowercase with accents stripped, ONE output character per input code unit,
// so an offset found in the folded text is the same offset in the original —
// which is what lets the title be highlighted where it matched. A character
// whose folded form is not a single code unit (a ligature, "İ") is left as it
// was rather than allowed to shift everything after it.
export function foldForSearch(value) {
  const text = String(value ?? "");
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    let folded = char;
    try {
      folded = char.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    } catch (_) { folded = char; }
    if (folded.length !== 1) {
      const lower = char.toLowerCase();
      folded = lower.length === 1 ? lower : char;
    }
    out += folded;
  }
  return out;
}

// The query, folded and split into words. Duplicates are dropped ("rule rule"
// is one requirement, not two). `phrase` is the whole thing with its spacing
// collapsed, for the bonus a title gets for containing it verbatim.
export function parseLibraryQuery(text) {
  const phrase = foldForSearch(text).replace(/\s+/g, " ").trim();
  const tokens = phrase ? Array.from(new Set(phrase.split(" "))) : [];
  return { phrase, tokens };
}

// parseLibraryQuery's result as is; anything else (a raw string, or junk) parsed.
function asQuery(query) {
  if (query && typeof query === "object" && Array.isArray(query.tokens) && typeof query.phrase === "string") return query;
  return parseLibraryQuery(typeof query === "string" ? query : "");
}

// Restricted edit distance (insert, delete, substitute, swap two neighbours),
// giving up as soon as it is over `max`. Small on purpose: the strings are one
// typed word against one title word.
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows[i] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      if (i === 0) { rows[i][j] = j; rowMin = Math.min(rowMin, j); continue; }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (i > 0 && rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

// The words of a folded title with where each starts.
function wordsOf(folded) {
  const words = [];
  const re = /[^\s/›_\-.,:;()[\]{}"'!?]+/g;
  let m;
  while ((m = re.exec(folded))) words.push({ text: m[0], at: m.index });
  return words;
}

// How many typos a word of this length may carry and still count.
// Two only for long words: at eight letters, two slips turn "calculus" into
// "calculat(or)", which is a different word rather than a misspelt one.
function typoAllowance(length) {
  if (length >= 9) return 2;
  if (length >= 4) return 1;
  return 0;
}

// The best place for one typed word in a folded string: a word start beats
// the first occurrence mid-word ("rule" in "Prerule Rule" is the second one).
// `original` is the unfolded text at the same offsets, so a capital in the
// middle of a word ("PageRank") still counts as the start of one.
function bestSubstring(haystack, token, original = haystack) {
  let first = -1;
  let at = haystack.indexOf(token);
  let guard = 0;
  while (at !== -1 && guard < 50) {
    if (first === -1) first = at;
    if (isWordStart(original, at)) return { at, wordStart: true };
    at = haystack.indexOf(token, at + 1);
    guard += 1;
  }
  return first === -1 ? null : { at: first, wordStart: false };
}

// Score of one typed word against a title and a folder path, with the title
// ranges it lit up. null when it is found in neither.
function scoreToken(token, title, path, rawTitle) {
  const inTitle = bestSubstring(title, token, rawTitle);
  if (inTitle) {
    let score = 100;
    if (inTitle.at === 0) score += 60;
    else if (inTitle.wordStart) score += 40;
    return { score, ranges: [[inTitle.at, inTitle.at + token.length]] };
  }

  if (path) {
    const inPath = bestSubstring(path, token);
    if (inPath) return { score: 40 + (inPath.wordStart ? 15 : 0), ranges: [] };
  }

  if (token.length < 3) return null;

  // A typo in one word: compare against each title word, and against the
  // same-length start of it so a half-typed word with a slip still lands
  // ("calcl" → "Calculus"). Then the same against the folder's words, for
  // less. The first letter has to be right: people rarely miss it, and
  // without that "test" finds every title with "best" in it.
  const allowed = typoAllowance(token.length);
  if (allowed) {
    const typoIn = (text, base, step, withRanges) => {
      let best = null;
      for (const word of wordsOf(text)) {
        if (word.text[0] !== token[0]) continue;
        const whole = editDistance(token, word.text, allowed);
        const prefix = word.text.length > token.length ? editDistance(token, word.text.slice(0, token.length), allowed) : allowed + 1;
        const d = Math.min(whole, prefix);
        if (d > allowed) continue;
        const end = word.at + (whole <= prefix ? word.text.length : token.length);
        const score = base - d * step;
        if (!best || score > best.score) best = { score, ranges: withRanges ? [[word.at, end]] : [] };
      }
      return best;
    };
    const hit = typoIn(title, 30, 6, true) || (path ? typoIn(path, 18, 4, false) : null);
    if (hit) return hit;
  }

  // Letters left out ("chnrl" → "Chain Rule"). Held to the shape of an
  // abbreviation — starts at a word, does not wander across the whole title,
  // and most of its letters either start a word or follow the letter before —
  // so a four-letter word does not match every long title that happens to
  // contain its letters in order somewhere ("test" in "The best").
  const fuzzy = fuzzyMatch(token, title);
  if (fuzzy && fuzzy.ranges.length) {
    const start = fuzzy.ranges[0][0];
    const end = fuzzy.ranges[fuzzy.ranges.length - 1][1];
    let anchored = 0;
    let letters = 0;
    for (const [from, to] of fuzzy.ranges) {
      for (let i = from; i < to; i += 1) {
        letters += 1;
        if (i > from || isWordStart(rawTitle, i)) anchored += 1;
      }
    }
    if (isWordStart(rawTitle, start) && end - start <= token.length * 2.5 + 2 && anchored >= letters * 0.6) {
      return { score: 10 + Math.max(0, Math.min(10, fuzzy.score / 20)), ranges: fuzzy.ranges };
    }
  }
  return null;
}

// The folder path a file is matched against: "" for a file at the top level,
// so typing "uncategorized" does not match everything that has no folder.
function deckPathForSearch(category) {
  const path = normalizeDeckCategory(category);
  return path === defaultDeckCategory ? "" : foldForSearch(path);
}

// `query` is parseLibraryQuery's result (or a raw string). Returns
// { score, ranges } — ranges are [start, end) offsets into the deck's title —
// or null when the file does not match. An empty query matches everything with
// a score of 0.
export function scoreLibraryDeck(deck, query) {
  const q = asQuery(query);
  if (!q.tokens.length) return { score: 0, ranges: [] };
  const rawTitle = String(deck?.title ?? "");
  const title = foldForSearch(rawTitle);
  const path = deckPathForSearch(deck?.category);

  let score = 0;
  const positions = [];
  for (const token of q.tokens) {
    const hit = scoreToken(token, title, path, rawTitle);
    if (!hit) return null;
    score += hit.score;
    for (const [start, end] of hit.ranges) for (let i = start; i < end; i += 1) positions.push(i);
  }

  // The whole thing as typed, verbatim, is the strongest signal there is.
  const whole = bestSubstring(title, q.phrase, rawTitle);
  if (whole) {
    score += 80;
    if (whole.at === 0) score += 40;
    if (title.trim() === q.phrase) score += 100;
    for (let i = whole.at; i < whole.at + q.phrase.length; i += 1) positions.push(i);
  }
  score -= Math.min(rawTitle.length, 80) / 10; // shorter titles win a tie

  const sorted = Array.from(new Set(positions)).sort((a, b) => a - b);
  return { score, ranges: mergeMatchRanges(sorted) };
}

// A folder by its own path, substring only (see the note at the top). The
// folder's own name matching ranks above a match only on a parent's name.
export function scoreLibraryFolder(path, query) {
  const q = asQuery(query);
  if (!q.tokens.length) return null;
  const normalized = normalizeDeckCategory(path);
  if (normalized === defaultDeckCategory) return null;
  const folded = foldForSearch(normalized);
  const nameAt = folded.lastIndexOf("/") + 1;
  // At least one word has to be in the folder's OWN name: "math" is the Math
  // folder, not also every folder inside it, which only contain the word in
  // their parent's name. (Stricter still keeps the promise above.)
  const name = folded.slice(nameAt);
  if (!q.tokens.some((token) => name.includes(token))) return null;
  let score = 0;
  for (const token of q.tokens) {
    const hit = bestSubstring(folded, token, normalized);
    if (!hit) return null;
    score += hit.at >= nameAt ? 60 : 20;
    if (hit.at === nameAt) score += 30;
    else if (hit.wordStart) score += 10;
  }
  if (folded.slice(nameAt) === q.phrase) score += 100;
  score -= Math.min(normalized.length, 80) / 10;
  return { score };
}

// The one test the renderer and the selection code share. Memoises the parsed
// query, since it is asked once per file per paint.
let lastTerm = null;
let lastQuery = null;
export function libraryDeckMatches(deck, term) {
  if (term !== lastTerm) { lastTerm = term; lastQuery = parseLibraryQuery(term); }
  return scoreLibraryDeck(deck, lastQuery);
}
