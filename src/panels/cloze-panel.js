// Finding every cloze in the deck, with enough surrounding text to recognise
// it out of context.

import { state } from "../main.js?v=__BUILD__";

export const CLOZE_SCAN_RE = /\{\{([\s\S]+?)\}\}/g;

// A lone table row / heading / list item isn't valid standalone markdown, so
// normalise it to readable inline text before rendering the context snippet.
export function clozeCleanUnit(unit) {
  let s = String(unit).trim();
  if (s.includes("|") && /\|/.test(s.replace(/^\||\|$/g, ""))) {
    s = s
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

// Table delimiter rows (|---|---|) are dropped so a cloze inside a table gets
// the header row as its "before" context instead of a row of dashes.
export const CLOZE_TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

export const CLOZE_UNIT_SPLIT_RE = /(?<=[.!?])\s+|\n+/g;

export const CLOZE_MASK_CHAR = "";

// A copy of `source` the SAME LENGTH, with every cloze's hidden text blanked
// out. Equal length is the point: unit boundaries found in here are offsets
// into the original, so units can be described as spans instead of rebuilt as
// strings. Blanking also stops a cloze's own punctuation ("{{Rome. Then
// Ravenna}}") from splitting the sentence it is buried in, which is right on
// its own terms: a cloze is one opaque blank, not a sentence boundary.
export function clozeMaskSource(source) {
  const scan = new RegExp(CLOZE_SCAN_RE.source, "g");
  let masked = "";
  let at = 0;
  let m;
  while ((m = scan.exec(source))) {
    const innerLength = m[0].length - 4; // minus the "{{" and "}}"
    masked += source.slice(at, m.index + 2) + CLOZE_MASK_CHAR.repeat(innerLength);
    at = m.index + m[0].length - 2;
  }
  return masked + source.slice(at);
}

// -- Why the unit list is built once per source -----------------------------
// This used to be done per cloze, inside clozeContextParts: rebuild the whole
// document with this one cloze replaced by a marker, split it into lines,
// filter every line, join it back, split THAT into sentence units, then scan
// the units for the marker. Roughly five full copies of the note plus two big
// arrays, once per {{...}} -- O(clozes x note). Opening the cloze panel on a
// long note was not merely slow, it was fatal: measured 161ms at 100KB,
// 2,270ms at 400KB, and at 1MB it exhausted a 4GB heap outright.
//
// The same information, computed once: split the masked source into units and
// remember each one's span. Locating any cloze is then a binary search.
export function clozeUnitIndex(source) {
  const masked = clozeMaskSource(source);
  CLOZE_UNIT_SPLIT_RE.lastIndex = 0;
  const bounds = [];
  let from = 0;
  let m;
  while ((m = CLOZE_UNIT_SPLIT_RE.exec(masked))) {
    bounds.push([from, m.index]);
    from = m.index + m[0].length;
  }
  bounds.push([from, masked.length]);

  const units = [];
  for (const [rawStart, rawEnd] of bounds) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(source[start])) start += 1;
    while (end > start && /\s/.test(source[end - 1])) end -= 1;
    if (start >= end) continue;
    const text = source.slice(start, end);
    if (CLOZE_TABLE_DELIMITER_RE.test(text)) continue;
    units.push({ start, end, text });
  }
  return units;
}

// The index of the unit containing `offset`, or -1.
export function clozeUnitAt(units, offset) {
  let low = 0;
  let high = units.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (units[mid].end <= offset) low = mid + 1;
    else if (units[mid].start > offset) high = mid - 1;
    else return mid;
  }
  return -1;
}

// Build {prev, cur, next} context around one cloze occurrence. `cur` keeps the
// {{...}} braces so it renders as a live redaction span; neighbours are plain.
export function clozeContextParts(units, source, start, end) {
  const index = clozeUnitAt(units, start);
  if (index === -1) {
    // No unit covers this offset (a dropped delimiter row, or pure whitespace)
    // -- show the cloze on its own rather than losing the row entirely.
    return { prev: "", cur: clozeCleanUnit(source.slice(start, end)), next: "" };
  }
  return {
    prev: index > 0 ? clozeCleanUnit(units[index - 1].text) : "",
    cur: clozeCleanUnit(units[index].text),
    next: index < units.length - 1 ? clozeCleanUnit(units[index + 1].text) : "",
  };
}

// Gather clozes from every source in the deck, grouped by where they live.
export function collectDeckClozes() {
  const groups = [];
  const pushGroup = (label, source) => {
    if (!source || source.indexOf("{{") === -1) return;
    const items = [];
    // A sentence with several clozes yields the SAME context snippet for each
    // (every blank in that sentence is already shown), so collapse duplicates:
    // list each sentence once instead of once per cloze. Keyed on the unit
    // itself rather than on the assembled text, so a sentence with twenty
    // blanks costs one row's work instead of twenty.
    const seen = new Set();
    const units = clozeUnitIndex(source);
    CLOZE_SCAN_RE.lastIndex = 0;
    let m;
    while ((m = CLOZE_SCAN_RE.exec(source))) {
      const unitIndex = clozeUnitAt(units, m.index);
      const key = unitIndex === -1 ? "@" + m.index : "u" + unitIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(clozeContextParts(units, source, m.index, m.index + m[0].length));
    }
    if (items.length) groups.push({ label, items });
  };
  pushGroup("Study Notes", state.notes || "");
  (state.masterCards || []).forEach((card, i) => {
    pushGroup(`Card ${i + 1} · Question`, card.question || "");
    pushGroup(`Card ${i + 1} · Answer`, card.answer || "");
  });
  return groups;
}
