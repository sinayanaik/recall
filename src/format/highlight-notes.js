// A note attached to a highlight (Kindle-style "note over a highlight").
//
// The note's TEXT lives in a plain-markdown section at the very end of the
// same note, and the <mark> in the body only carries a short id pointing at
// it (data-note="hn-3f2a"). Notes used to ride inside the mark itself as
// base64 (data-note="VGhpcyBpcyBh…"), which meant the raw markdown of an
// annotated book was littered with unreadable blobs you could neither read
// nor hand-edit. The section below is the same information in a form anyone
// can open in any editor and change:
//
//     ---
//
//     ## Highlight Notes
//
//     ### [hn-3f2a] “the highlighted words…”
//
//     Whatever the reader wrote, as ordinary markdown.
//
//     ### [hn-9c1b] “another highlight…”
//
//     A second note.
//
// Only the `[id]` in each heading is machine-read; the quoted excerpt after
// it is a human label (regenerated on every save) and the body is free-form
// markdown for as many paragraphs, lists or images as you like. Editing,
// reordering or rewriting a body by hand is a supported thing to do — the
// only rule is: keep the `### [id]` line, since that is what ties the note to
// its highlight.
//
// A highlight that wrapAcrossBlocks split into several adjacent <mark>s (a
// paragraph or list-item drag) is still ONE annotation, so only the group's
// FIRST piece ever carries the id — see rewriteFirstMarkNote.
//
// Legacy base64 notes still read correctly (see highlightNoteText) and are
// converted to the section form on their first edit, or in bulk by
// migrateLegacyHighlightNotes when the raw editor is opened.

import { state } from "../core/state.js?v=__BUILD__";
import { HIGHLIGHT_SCAN_RE, MARK_CLOSE_TAG, markGroupSpanAt, markOpenTag, markSpanAt } from "./highlight.js?v=__BUILD__";
import { notifyHighlightsChanged } from "./highlight-edit.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// ── The section's own syntax ──────────────────────────────────────────────
// Deliberately ordinary markdown: a level-2 heading anyone can see in the
// rendered note, and one level-3 heading per note. Nothing here is a private
// encoding, so a reader who has never seen this file can still work it out.
export const HIGHLIGHT_NOTES_HEADING = "Highlight Notes";
const SECTION_HEADING_RE = /^##[ \t]+Highlight Notes[ \t]*$/gm;
const ENTRY_HEADING_RE = /^###[ \t]+\[(hn-[a-z0-9]+)\][ \t]*(.*)$/;
const NOTE_ID_RE = /^hn-[a-z0-9]+$/;

// btoa/atob only handle Latin1, so the note's UTF-8 bytes are routed through
// them one byte at a time rather than the raw string — an emoji or accented
// character in a note would otherwise throw "characters outside of the
// Latin1 range" and the note would silently fail to save.
export function encodeHighlightNote(markdown) {
  const bytes = new TextEncoder().encode(markdown);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export function decodeHighlightNote(encoded) {
  if (!encoded) return "";
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // A hand-edited or corrupted data-note attribute: fail soft to "no note"
    // rather than breaking the highlight it's attached to.
    return "";
  }
}

export function isHighlightNoteId(value) {
  return Boolean(value) && NOTE_ID_RE.test(value);
}

// An id is never derived from the text it annotates: the text can be edited,
// recoloured or re-highlighted, and the note has to survive all of that. It
// only has to be unique within THIS note, and short enough not to be noise in
// the middle of a sentence.
// `taken` covers ids handed out during a batch that hasn't been written back
// into `source` yet (migrateLegacyHighlightNotes) — the source scan alone
// cannot see those, and two highlights sharing an id would share a note.
function freshHighlightNoteId(source, taken = null) {
  for (;;) {
    const id = `hn-${Math.random().toString(36).slice(2, 6)}`;
    if (taken?.has(id)) continue;
    if (!source.includes(`[${id}]`) && !source.includes(`"${id}"`)) return id;
  }
}

// The quoted excerpt on an entry's heading — a label for humans only, never
// parsed back. Marks/HTML/newlines are flattened out so the heading stays one
// readable line whatever the highlight actually contained.
function excerptLabel(inner) {
  const flat = String(inner || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const clipped = flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
  return `“${clipped}”`;
}

// ── Reading the section ───────────────────────────────────────────────────

// Where the notes section starts, or -1. The LAST heading wins: a book whose
// own text happens to contain the words "## Highlight Notes" somewhere in the
// middle must not have that mistaken for the app's section, and this one is
// always appended at the very end.
function sectionStartIn(source) {
  SECTION_HEADING_RE.lastIndex = 0;
  let start = -1;
  let m;
  while ((m = SECTION_HEADING_RE.exec(source))) start = m.index;
  return start;
}

// { start, end } of every entry inside the section, in document order. `end`
// is where the next entry (or the source) begins, so a body keeps whatever
// blank lines the reader put in it.
function parseEntries(source, sectionStart) {
  if (sectionStart < 0) return [];
  const headEnd = source.indexOf("\n", sectionStart);
  const bodyStart = headEnd === -1 ? source.length : headEnd + 1;
  const entries = [];
  const lineRe = /^.*$/gm;
  lineRe.lastIndex = bodyStart;
  let line;
  while ((line = lineRe.exec(source))) {
    const match = ENTRY_HEADING_RE.exec(line[0]);
    if (match) {
      if (entries.length) entries[entries.length - 1].end = line.index;
      entries.push({
        id: match[1],
        label: match[2].trim(),
        start: line.index,
        textStart: line.index + line[0].length,
        end: source.length
      });
    }
    if (lineRe.lastIndex === line.index) lineRe.lastIndex += 1; // zero-length match on a blank line
  }
  entries.forEach((entry) => { entry.text = source.slice(entry.textStart, entry.end).trim(); });
  return entries;
}

// Every note in `source`, keyed by id. Cheap enough to call per read (one
// regex scan of the tail), and always derived from the text rather than
// cached, so a hand-edit in the raw editor takes effect immediately.
export function readHighlightNotes(source) {
  const map = new Map();
  parseEntries(source, sectionStartIn(source)).forEach((entry) => {
    if (entry.text) map.set(entry.id, entry.text);
  });
  return map;
}

// The note text for whatever a <mark>'s data-note attribute holds: an id
// pointing into the section, or — for a note written before this format
// existed, or one pasted in from another deck — the old inline base64. An id
// with no entry (its section text was deleted by hand, or the mark was copied
// into a different note) reads as "no note" rather than as an error.
export function highlightNoteText(source, attrValue) {
  if (!attrValue) return "";
  if (isHighlightNoteId(attrValue)) return readHighlightNotes(source).get(attrValue) || "";
  return decodeHighlightNote(attrValue);
}

// The same lookup for a caller resolving MANY marks against one source (the
// Highlights panel scans every mark in the note): the section is parsed once
// and the returned function is a map read, rather than re-scanning the tail
// of a book-sized note per highlight.
export function highlightNoteResolver(source) {
  let map = null;
  return (attrValue) => {
    if (!attrValue) return "";
    if (!isHighlightNoteId(attrValue)) return decodeHighlightNote(attrValue);
    if (!map) map = readHighlightNotes(source);
    return map.get(attrValue) || "";
  };
}

export function highlightNoteTextAt(markIndex) {
  const source = state.notes || "";
  const span = markSpanAt(source, markIndex);
  return span ? highlightNoteText(source, span.note) : "";
}

// ── Writing the section ───────────────────────────────────────────────────

function entryBlock(id, label, text) {
  const heading = label ? `### [${id}] ${label}` : `### [${id}]`;
  return `${heading}\n\n${text.trim()}\n`;
}

// Drops the section entirely when its last entry goes, rather than leaving an
// empty "## Highlight Notes" heading (and the rule above it) behind in a note
// that no longer has any.
function removeSection(source, sectionStart) {
  const head = source.slice(0, sectionStart).replace(/\s+$/, "");
  return head.replace(/\n*(?:^|\n)-{3,}[ \t]*$/, "");
}

// Anything the reader wrote under the section heading but before the first
// entry (a note to themselves about the section, say) is carried through
// rather than rewritten away — this rebuilds the whole section from `entries`,
// so text that isn't in one has to be preserved explicitly.
function sectionPreamble(source, sectionStart, entries) {
  if (sectionStart < 0) return "";
  const headEnd = source.indexOf("\n", sectionStart);
  if (headEnd === -1) return "";
  const stop = entries.length ? entries[0].start : source.length;
  return source.slice(headEnd + 1, stop).trim();
}

function writeEntries(source, sectionStart, entries, preamble = "") {
  const kept = entries.filter((entry) => entry.text.trim());
  if (!kept.length) return sectionStart < 0 ? source : removeSection(source, sectionStart);
  const body = kept.map((entry) => entryBlock(entry.id, entry.label, entry.text)).join("\n");
  const section = `## ${HIGHLIGHT_NOTES_HEADING}\n\n${preamble ? `${preamble}\n\n` : ""}${body}`;
  if (sectionStart >= 0) return `${source.slice(0, sectionStart)}${section}`;
  const head = source.replace(/\s+$/, "");
  return head ? `${head}\n\n---\n\n${section}` : section;
}

// Upserts one note, keeping every other entry (and any hand-editing done to
// it) byte-for-byte. An empty text removes the entry.
export function setHighlightNoteInSource(source, id, text, label) {
  const sectionStart = sectionStartIn(source);
  const entries = parseEntries(source, sectionStart);
  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    existing.text = String(text || "").trim();
    // The excerpt is refreshed from the highlight it now points at, but never
    // invented: a caller with nothing to say leaves whatever label is there.
    if (label != null) existing.label = label;
  } else if (String(text || "").trim()) {
    entries.push({ id, label: label || "", text: String(text).trim() });
  }
  return writeEntries(source, sectionStart, entries, sectionPreamble(source, sectionStart, entries));
}

// Entries whose highlight is gone (the mark was removed, or its text deleted
// in the raw editor) would otherwise pile up at the end of the note forever.
//
// ── The second source of live ids ─────────────────────────────────────────
//
// A <mark> in the body is no longer the only thing that can own a note. A PDF
// deck's highlights live in meta.pdfHighlights and use ids from this very
// namespace — that is the point, and it is what lets the note editor, the
// section format and the Highlights panel be reused verbatim for them. But it
// means a scan of the body alone sees none of them: every note taken on a paper
// would read as an orphan and be swept away the first time any highlight was
// edited.
//
// Read straight off `state` rather than through src/documents/pdf-highlights.js
// — that module imports this one, and a leaf like this one has no business
// importing back into a surface.
export function pruneOrphanHighlightNotes(source) {
  const sectionStart = sectionStartIn(source);
  if (sectionStart < 0) return source;
  const body = source.slice(0, sectionStart);
  const live = new Set();
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(body))) {
    if (isHighlightNoteId(m[2])) live.add(m[2]);
  }
  const pdfHighlights = state.meta?.pdfHighlights;
  if (Array.isArray(pdfHighlights)) {
    pdfHighlights.forEach((record) => {
      if (isHighlightNoteId(record?.id)) live.add(record.id);
    });
  }
  const entries = parseEntries(source, sectionStart);
  if (entries.every((entry) => live.has(entry.id))) return source;
  const preamble = sectionPreamble(source, sectionStart, entries);
  return writeEntries(source, sectionStart, entries.filter((entry) => live.has(entry.id)), preamble);
}

// Rewrites ONLY the group's first <mark> open tag — every other piece (if
// wrapAcrossBlocks split this highlight across blocks/list items) is copied
// through unchanged, id and all (a piece other than the first never has one
// by construction) — and then updates the notes section to match.
//
// ── Why the two side effects are optional ─────────────────────────────────
//
// This used to repaint and snapshot unconditionally, which was right when the
// only caller was a Save button: one press, one edit, one undo step. The popup
// editor now saves as you type (see src/notes/highlight-note-editor.js), and
// under that caller both are actively wrong:
//
//   rerender — the note being written to is the SECTION at the end of the
//     document, not the paragraph the highlight is in. Nothing the reader can
//     see changes, and renderNotesViewPinned on a book-sized note is not a
//     thing to do between keystrokes. The popup repaints once, on close.
//   undo — a Ctrl+Z stack with one step per typing pause is not an undo stack.
//     The editor pushes ONE snapshot for the whole editing session, the same
//     shape applyFormatToTextarea uses for a formatting run.
//
// Both default to true, so every other caller is unchanged.
function rewriteFirstMarkNote(markIndex, makeNote, { rerender = true, undo = true } = {}) {
  const source = state.notes || "";
  const span = markGroupSpanAt(source, markIndex);
  const first = markSpanAt(source, markIndex);
  if (!span || !first) {
    showToast("That highlight is no longer in the note", "error");
    return false;
  }
  const { id, text } = makeNote(first, source);
  const rewrittenFirst = markOpenTag(first.color, id || undefined) + first.inner + MARK_CLOSE_TAG;
  // The mark is rewritten FIRST and the section written against that result,
  // so the section's own offsets are computed against the text it lands in —
  // the mark's open tag changes length here (an id is added or dropped), and
  // a section start measured before that would be stale by exactly that much.
  const withMark = source.slice(0, first.start) + rewrittenFirst + source.slice(first.end);
  if (undo) pushNotesUndo("highlight");
  state.notes = setHighlightNoteInSource(withMark, id || first.note, text, id ? excerptLabel(first.inner) : null);
  if (rerender) renderNotesViewPinned();
  // Not optional, either of them. The deck has changed on disk whether or not
  // anything was repainted, and the Highlights panel is a different surface
  // that may well be the one the edit was made from.
  scheduleDeckAutosave();
  notifyHighlightsChanged();
  return true;
}

export function setHighlightNoteAt(markIndex, markdownText, options = {}) {
  const text = String(markdownText || "").trim();
  if (!text) return clearHighlightNoteAt(markIndex, options);
  return rewriteFirstMarkNote(markIndex, (first, source) => ({
    // A highlight that already has an id keeps it, so a hand-written section
    // entry isn't orphaned by an edit made through the popup.
    id: isHighlightNoteId(first.note) ? first.note : freshHighlightNoteId(source),
    text
  }), options);
}

export function clearHighlightNoteAt(markIndex, options = {}) {
  return rewriteFirstMarkNote(markIndex, () => ({ id: null, text: "" }), options);
}

// One-shot conversion of the old inline-base64 form, run when the raw editor
// opens (src/notes/notes-view.js) — the moment the blobs would otherwise be
// staring the reader in the face. Returns the source unchanged (same string
// identity) when there is nothing to convert, which is the overwhelmingly
// common case and what keeps this off the hot path of opening a big note.
export function migrateLegacyHighlightNotes(source) {
  if (!source || !source.includes("data-note=")) return source;
  const pending = [];
  const taken = new Set();
  let changed = false;
  let out = "";
  let cursor = 0;
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    const [whole, color, note, inner] = m;
    if (!note || isHighlightNoteId(note)) continue;
    const text = decodeHighlightNote(note);
    // An undecodable blob is dropped rather than carried: it has no readable
    // form to migrate to, and leaving it would keep the note cryptic forever.
    const id = text ? freshHighlightNoteId(source, taken) : null;
    if (id) {
      taken.add(id);
      pending.push({ id, text, label: excerptLabel(inner) });
    }
    changed = true;
    out += source.slice(cursor, m.index) + markOpenTag(color, id || undefined) + inner + MARK_CLOSE_TAG;
    cursor = m.index + whole.length;
  }
  if (!changed) return source; // the common case: nothing legacy in this note
  out += source.slice(cursor);
  return pending.reduce((acc, p) => setHighlightNoteInSource(acc, p.id, p.text, p.label), out);
}
