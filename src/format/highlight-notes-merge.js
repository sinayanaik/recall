// Reading, writing and MERGING the fenced highlight-note block, with nothing
// else attached.
//
// src/format/highlight-notes.js owns the block, but it reaches `state`, the
// deck store, the undo stack and the toast layer to do it. The sync path needs
// the same parser and cannot have any of that: src/sync/document-sync.js runs
// against two strings handed to it by a network round trip, on decks that are
// not open, and tools/document-sync-check.mjs drives it straight from Node.
// So the three functions that are only about the STRING live here — the same
// argument, and the same answer, as src/format/notes-fence.js, which this
// module's only import is.
//
// highlight-notes.js imports these back, so there is exactly one parser and one
// writer for the format. It keeps everything that needs a surface: minting an
// id, rewriting a <mark>, migrating the two legacy forms, the toasts.
//
// ── Why a highlight's note needs merging at all ───────────────────────────
//
// A deck's CARDS have been merged per row for a long time: each card carries
// its own id and updated_at, the pull merges by id, the push reconciles against
// the cloud's real rows first, and a deletion is a tombstone both sides honour.
// A highlight's note had none of it. Its text lives in this block at the end of
// `notes`, and `notes` was whole-column last-write-wins on BOTH sides — cloud
// text replaced local text on the pull, local text replaced cloud text on the
// push. Two devices annotating the same paper therefore destroyed each other's
// notes on every sync, and — because on a PDF deck the notes body is essentially
// ONLY this block — raised a notes conflict every time as well.
//
// mergeHighlightNoteTails is the missing per-record merge. Union by id, exactly
// as the card merge is a union by id, with a per-entry timestamp settling a
// genuine conflict and a tombstone making a deletion stick.

import {
  HIGHLIGHT_NOTES_CLOSE,
  HIGHLIGHT_NOTES_OPEN,
  highlightNotesBlockSpan,
  joinHighlightNotesTail
} from "./notes-fence.js?v=__BUILD__";

// ── The block's own syntax ────────────────────────────────────────────────
// One line per entry: the id, and a human label that is regenerated on every
// save and never parsed back.
export const HIGHLIGHT_NOTE_ENTRY_RE = /^<!--hn:(hn-[a-z0-9]+)(?:[ \t]+([^]*?))?-->[ \t]*$/;

// The heading form the fence replaced. Still parsed (an older deck, a note
// restored from a backup, a .md someone hand-wrote) and still EMITTED by the
// exporters, so the format stays something a person can read outside this app.
export const HIGHLIGHT_NOTES_HEADING = "Highlight Notes";

const HIGHLIGHT_NOTES_HEADING_RE = /^##[ \t]+Highlight Notes[ \t]*$/gm;

const HIGHLIGHT_NOTE_HEADING_ENTRY_RE = /^###[ \t]+\[(hn-[a-z0-9]+)\][ \t]*(.*)$/;

// ── Reading the block ─────────────────────────────────────────────────────

// The legacy heading section, for a note written before the fence existed.
export function legacyHighlightNotesStart(source) {
  HIGHLIGHT_NOTES_HEADING_RE.lastIndex = 0;
  let start = -1;
  let m;
  while ((m = HIGHLIGHT_NOTES_HEADING_RE.exec(source))) start = m.index;
  return start;
}

// { id, label, text, start, textStart, end } of every entry inside a span, in
// document order. `end` is where the next entry (or the span) ends, so a body
// keeps whatever blank lines the reader put in it. `markerRe` is what tells the
// two formats apart; everything else about the walk is identical, which is the
// point of passing it in.
export function parseHighlightNoteEntriesBetween(source, bodyStart, bodyEnd, markerRe) {
  const entries = [];
  const lineRe = /^.*$/gm;
  lineRe.lastIndex = bodyStart;
  let line;
  while ((line = lineRe.exec(source)) && line.index < bodyEnd) {
    const match = markerRe.exec(line[0]);
    if (match) {
      if (entries.length) entries[entries.length - 1].end = line.index;
      entries.push({
        id: match[1],
        label: (match[2] || "").trim(),
        start: line.index,
        textStart: line.index + line[0].length,
        end: bodyEnd
      });
    }
    if (lineRe.lastIndex === line.index) lineRe.lastIndex += 1; // zero-length match on a blank line
  }
  entries.forEach((entry) => { entry.text = source.slice(entry.textStart, entry.end).trim(); });
  return entries;
}

export function parseFencedHighlightNoteEntries(source, span) {
  if (!span) return [];
  return parseHighlightNoteEntriesBetween(source, span.bodyStart, span.end, HIGHLIGHT_NOTE_ENTRY_RE);
}

export function parseLegacyHighlightNoteEntries(source, sectionStart) {
  if (sectionStart < 0) return [];
  const headEnd = source.indexOf("\n", sectionStart);
  const bodyStart = headEnd === -1 ? source.length : headEnd + 1;
  return parseHighlightNoteEntriesBetween(source, bodyStart, source.length, HIGHLIGHT_NOTE_HEADING_ENTRY_RE);
}

// Every entry in `source`, whichever form it is in. The fence wins when both are
// present, which is what a half-finished migration looks like.
//
// ── Memoized on its last input, one entry deep ────────────────────────────
//
// The same memo, for the same reason, as readerNotesBody in notes-fence.js: a
// caller that asks about MANY highlights against ONE unchanged note would
// otherwise pay a full regex walk of the whole fenced block per question, and
// the block grows with the number of highlights — so the cost is quadratic in
// how heavily a paper has been annotated. Measured on a 4-page paper: 3.9ms to
// paint one page's note badges at 25 annotated highlights, 312ms at 300. That
// runs from the page-painted hook, on every page, as the reader scrolls.
//
// The callers are expected to hoist a single parse where they can (see
// annotatedDocumentHighlights, collectHighlightEntries and
// documentHighlightEntries, which all do) — this is the floor under the ones
// that cannot, and under the next one somebody forgets.
//
// Safe to share because nothing mutates what this returns: the two writers that
// DO edit entries in place (setHighlightNoteInSource, pruneOrphanHighlightNotes)
// go through parseFencedHighlightNoteEntries, which is deliberately not cached,
// and mergeHighlightNoteTails copies every entry it keeps before returning it.
// Keep it that way — a caller that edits one of these objects would corrupt
// every later read of the same note.
let lastNoteEntriesSource = null;
let lastNoteEntries = [];

export function parseHighlightNoteEntries(source) {
  const text = String(source || "");
  if (text === lastNoteEntriesSource) return lastNoteEntries;
  const span = highlightNotesBlockSpan(text);
  const entries = span
    ? parseFencedHighlightNoteEntries(text, span)
    : parseLegacyHighlightNoteEntries(text, legacyHighlightNotesStart(text));
  lastNoteEntriesSource = text;
  lastNoteEntries = entries;
  return entries;
}

// ── Writing the block ─────────────────────────────────────────────────────

export function highlightNoteEntryBlock(id, label, text) {
  const marker = label ? `<!--hn:${id} ${label}-->` : `<!--hn:${id}-->`;
  return `${marker}\n\n${String(text).trim()}\n`;
}

// Anything the reader wrote inside the block but before the first entry (a note
// to themselves about the block, say) is carried through rather than rewritten
// away — writeHighlightNoteEntries rebuilds the whole thing from `entries`, so
// text that isn't in one has to be preserved explicitly.
export function highlightNoteBlockPreamble(source, span, entries) {
  if (!span) return "";
  const stop = entries.length ? entries[0].start : span.end;
  return source.slice(span.bodyStart, stop).trim();
}

// Rebuilds the block from `entries`. `span` is where the existing one is, or
// null to append a new one at the end of `source`.
//
// When nothing is left to write the block goes entirely — heading, fence and
// the `---` rule above it — rather than leaving an empty container behind in a
// note that no longer has any highlight notes at all.
export function writeHighlightNoteEntries(source, span, entries, preamble = "") {
  const head = span ? source.slice(0, span.start) : source;
  const kept = entries.filter((entry) => String(entry.text || "").trim());
  if (!kept.length) {
    if (!span) return source;
    return head.replace(/\s+$/, "").replace(/\n*(?:^|\n)-{3,}[ \t]*$/, "");
  }
  const body = kept.map((entry) => highlightNoteEntryBlock(entry.id, entry.label, entry.text)).join("\n");
  const block = `${HIGHLIGHT_NOTES_OPEN}\n${preamble ? `${preamble}\n\n` : "\n"}${body}${HIGHLIGHT_NOTES_CLOSE}\n`;
  if (span) return `${head}${block}${source.slice(span.after).replace(/^[ \t]*\n/, "")}`;
  return joinHighlightNotesTail(source, block.replace(/\n$/, ""));
}

// ── Merging two copies of the block ───────────────────────────────────────

// What a kept-both entry is separated by. A blockquote, so it reads as a quoted
// aside in the rendered note rather than as part of the sentence above it.
export const OTHER_DEVICE_NOTE_MARKER = "> Also written on another device";

// The two texts as one, when nothing can say which of them is newer.
//
// NEVER drops either — the same principle the notes stash exists for, and the
// only correct answer for a <mark> note in an ordinary deck, which has no record
// anywhere to carry a timestamp.
//
// Deterministic, and that is not a detail: the two devices computing this are
// merging the SAME pair in the opposite order, so anything order-dependent
// (cloud first, local first, "now") gives them two different strings and the
// next sync merges those, and the one after that, forever. Containment is
// checked first so a device that already holds the combined text recognises it
// instead of nesting it, then the pair is ordered lexicographically, and the
// date — present only when both sides carry the SAME stamp, since an unequal
// pair is settled by it instead — is written as a plain ISO day.
export function combineHighlightNoteTexts(a, b, whenIso = "") {
  const first = String(a || "").trim();
  const second = String(b || "").trim();
  if (!first) return second;
  if (!second) return first;
  if (first.includes(second)) return first;
  if (second.includes(first)) return second;
  const [top, bottom] = first <= second ? [first, second] : [second, first];
  const marker = whenIso ? `${OTHER_DEVICE_NOTE_MARKER} on ${whenIso}` : OTHER_DEVICE_NOTE_MARKER;
  return `${top}\n\n${marker}\n\n${bottom}`;
}

// Is this the same note text, allowing for the whitespace a hand-edit or a
// round trip through the legacy heading form can leave behind?
//
// Byte equality is the wrong test and its failure mode is loud: two texts that
// differ by one trailing space read as a genuine conflict, and with no stamp to
// settle it the keep-both rule then prints the note twice. Deliberately a local
// two-line normalisation rather than normalizeSyncText from src/sync/diff.js —
// that would make this module import the sync tree, and importing nothing but
// notes-fence.js is the whole reason it exists.
function sameHighlightNoteText(a, b) {
  const flatten = (text) => String(text || "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return flatten(a) === flatten(b);
}

function isoDay(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

// The merge itself: two tails in, one tail out. Pure, string-only, and the only
// place the rules live.
//
//   id on one side only        → keep it
//   both sides, same text      → keep it
//   both sides, different text → the newer stamp wins
//   both sides, no stamp to
//     settle it                → KEEP BOTH (see combineHighlightNoteTexts)
//   tombstoned newer than both → drop it
//
// `stamps` is { cloud: { [id]: ms }, local: { [id]: ms } } — a highlight's own
// `noteAt`, stamped by setDocumentHighlightNote and by nothing else, so a
// recolour cannot out-rank a note. `tombstones` is { [id]: ms }, the union of
// what both sides have deleted.
//
// Entry ORDER follows the cloud's, with local-only entries appended in their own
// order — the same rule mergeCloudCardsIntoSnapshot follows for cards, and for
// the same reason: both devices then converge on one arrangement.
export function mergeHighlightNoteTails(cloudSource, localSource, { stamps = {}, tombstones = {} } = {}) {
  const cloudText = String(cloudSource || "");
  const localText = String(localSource || "");
  const cloudEntries = parseHighlightNoteEntries(cloudText);
  const localEntries = parseHighlightNoteEntries(localText);
  // Anything the reader wrote inside the block but above the first entry is
  // carried through, because the block is rebuilt from `entries` and text that
  // is not in one would otherwise be rewritten away. It also has to be carried
  // for a duller reason: without it the rebuilt tail differs from the one on
  // disk by exactly that paragraph, so every sync would look like a change and
  // rewrite the snapshot for nothing.
  const preamble = highlightNoteBlockPreamble(cloudText, highlightNotesBlockSpan(cloudText), cloudEntries)
    || highlightNoteBlockPreamble(localText, highlightNotesBlockSpan(localText), localEntries);
  const cloudStamps = stamps.cloud || {};
  const localStamps = stamps.local || {};

  const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
  const cloudById = new Map(cloudEntries.map((entry) => [entry.id, entry]));
  const merged = [];
  let mergedCount = 0;

  const resolve = (id, cloudEntry, localEntry) => {
    const cloudText = String(cloudEntry?.text || "").trim();
    const localText = String(localEntry?.text || "").trim();
    const cloudAt = Number(cloudStamps[id] || 0);
    const localAt = Number(localStamps[id] || 0);
    const buried = Number(tombstones[id] || 0);
    // A deletion only wins over text it is actually newer than. A note written
    // AFTER the delete on the other device is a new note, not a resurrection.
    if (buried && buried >= cloudAt && buried >= localAt) return null;
    if (!cloudText) return localEntry ? { ...localEntry } : null;
    if (!localText) return cloudEntry ? { ...cloudEntry } : null;
    if (sameHighlightNoteText(cloudText, localText)) return { ...cloudEntry };
    mergedCount += 1;
    if (cloudAt !== localAt) {
      return cloudAt > localAt ? { ...cloudEntry } : { ...localEntry };
    }
    return {
      ...cloudEntry,
      label: cloudEntry.label || localEntry.label,
      text: combineHighlightNoteTexts(cloudText, localText, isoDay(cloudAt))
    };
  };

  for (const entry of cloudEntries) {
    const kept = resolve(entry.id, entry, localById.get(entry.id) || null);
    if (kept) merged.push(kept);
  }
  for (const entry of localEntries) {
    if (cloudById.has(entry.id)) continue;
    const kept = resolve(entry.id, null, entry);
    if (kept) merged.push(kept);
  }

  const tail = writeHighlightNoteEntries("", null, merged.map((entry) => ({
    id: entry.id, label: entry.label || "", text: entry.text
  })), preamble);
  return {
    // Shaped exactly as splitHighlightNotesTail returns a tail — markers
    // included, no trailing newline — so joinHighlightNotesTail is its inverse.
    tail: tail.replace(/\n$/, ""),
    entries: merged,
    // How many entries this device did NOT already hold in the form it now
    // holds them, for the sync report. Counted as "notes merged", since that is
    // what the reader sees: their annotations arriving from the other device.
    merged: mergedCount,
    adopted: merged.filter((entry) => !localById.has(entry.id)).length
  };
}
