// A note attached to a highlight (Kindle-style "note over a highlight").
//
// The note's TEXT lives in a fenced block at the very end of the same note, and
// the <mark> in the body only carries a short id pointing at it
// (data-note="hn-3f2a"):
//
//     <!--recall:highlight-notes-->
//     <!--hn:hn-3f2a “the highlighted words…”-->
//
//     Whatever the reader wrote, as ordinary markdown.
//
//     <!--hn:hn-9c1b “another highlight…”-->
//
//     A second note.
//     <!--/recall:highlight-notes-->
//
// Only the id in each `<!--hn:…-->` line is machine-read; the quoted excerpt
// after it is a human label (regenerated on every save) and the body is
// free-form markdown for as many paragraphs, lists or images as you like.
//
// ── Why comments, and not the headings this used to use ───────────────────
//
// The first version of this was ordinary markdown — `## Highlight Notes` with a
// `### [hn-3f2a] “excerpt”` per entry — on the argument that nothing here
// should be a private encoding a reader could not work out for themselves. It
// is still readable in that form; that is what notesForExport() emits. But as
// the CONTAINER a heading was wrong in three ways, and all three were reported:
//
//   • It is not a boundary. A document whose own text contains the words
//     "## Highlight Notes" is indistinguishable from the app's section, which is
//     why sectionStartIn had to take the LAST match and hope. A comment nobody
//     types by accident needs no such rule.
//   • It renders. The section was real markdown at the end of the note, so the
//     rendered view printed an H2 and a run of H3s under everything the reader
//     wrote, and the note-badge pass had to walk the rendered blocks
//     BACKWARDS looking for an H2 whose text was "Highlight Notes" in order to
//     hide it again. Comments are stripped by DOMPurify (SANITIZE_CONFIG does
//     not set ALLOW_COMMENTS), so there is nothing to hide.
//   • It has no end. "Everything after the heading" meant the section could only
//     ever be the tail, with no way to say where it stopped — so a paste below
//     it was swallowed into the last entry. The fence closes.
//
// The fence is still, deliberately, plain text in the same file: opening the
// deck's markdown in any editor and rewriting a body by hand is a supported
// thing to do. The only rule is: keep the `<!--hn:id-->` line, since that is
// what ties the note to its highlight.
//
// ── Where it is, and what that buys ───────────────────────────────────────
//
// The block is always the LAST thing in the note. Every raw-markdown offset in
// this app — raw-offset.js, locate-selection.js, anchors.js, toc.js, the caret
// the raw editor resumes at — is an index from the START of the source, so a
// tail can be sliced off without moving any of them. That is what lets
// splitHighlightNotesTail() hand the rendered view and the raw editor a body
// with no highlight notes in it at all, which is the other half of the report
// this format came from: on a PDF deck the body is empty, so opening the raw
// editor used to show the reader nothing but their own highlight notes.
//
// A highlight that wrapAcrossBlocks split into several adjacent <mark>s (a
// paragraph or list-item drag) is still ONE annotation, so only the group's
// FIRST piece ever carries the id — see rewriteFirstMarkNote.
//
// Two older forms still read correctly and are converted on first edit (or in
// bulk by migrateLegacyHighlightNotes when the raw editor is opened): the
// `## Highlight Notes` section above, and — older still — base64 riding inside
// the mark itself (data-note="VGhpcyBpcyBh…").

import { state } from "../core/state.js?v=__BUILD__";
import {
  HIGHLIGHT_NOTES_CLOSE,
  HIGHLIGHT_NOTES_OPEN,
  highlightNotesBlockSpan,
  joinHighlightNotesTail,
  splitHighlightNotesTail
} from "./notes-fence.js?v=__BUILD__";
import {
  HIGHLIGHT_NOTES_HEADING,
  highlightNoteBlockPreamble,
  legacyHighlightNotesStart,
  parseFencedHighlightNoteEntries,
  parseHighlightNoteEntries,
  parseLegacyHighlightNoteEntries,
  writeHighlightNoteEntries
} from "./highlight-notes-merge.js?v=__BUILD__";
import { HIGHLIGHT_SCAN_RE, MARK_CLOSE_TAG, markGroupSpanAt, markOpenTag, markSpanAt } from "./highlight.js?v=__BUILD__";
import { notifyHighlightsChanged } from "./highlight-edit.js?v=__BUILD__";
import { renderNotesViewPinned } from "../notes/notes-view.js?v=__BUILD__";
import { pushNotesUndo } from "../notes/notes-history.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// ── The block's own syntax ────────────────────────────────────────────────
// Two markers the app owns and nobody types by accident, plus one per entry.
// Both are HTML comments, so they are invisible in the rendered note and inert
// in every markdown tool that will ever open this file.
// The two markers live in src/format/notes-fence.js, with the tail-slicing this
// file's callers need, because block-cache.js and notes-view.js both have to
// find the same boundary and neither can import THIS module — see that file's
// header. Re-exported here so "where do highlight notes live" still has one
// answer to read.
export { HIGHLIGHT_NOTES_CLOSE, HIGHLIGHT_NOTES_OPEN, joinHighlightNotesTail, splitHighlightNotesTail };
// The entry markers, the two legacy forms, the parser and the writer all live in
// src/format/highlight-notes-merge.js now, alongside the merge that has to agree
// with them byte for byte — see that file's header for why the sync path could
// not import THIS one. Re-exported here so "where do highlight notes live" still
// has one answer to read.
export { HIGHLIGHT_NOTES_HEADING };
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
    // Three places an id can already be spoken for, and all three have to be
    // checked or two highlights would share a note: the entry marker
    // (`<!--hn:id`), a legacy heading entry (`[id]`), and the data-note
    // attribute on the mark itself (`"id"`).
    if (source.includes(`hn:${id}`)) continue;
    if (source.includes(`[${id}]`) || source.includes(`"${id}"`)) continue;
    return id;
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
  return `“${commentSafe(clipped)}”`;
}

// The label rides inside an HTML comment now, and a comment cannot contain
// "--": a paper with an em-dash typed as "--" in the highlighted sentence would
// otherwise close the marker early and take the id with it. ">" is fenced off
// for the same reason. Only the LABEL goes through this — the note body sits
// between markers, not inside one, so it is left exactly as written.
function commentSafe(text) {
  return String(text).replace(/-{2,}/g, "–").replace(/[<>]/g, "");
}

// ── Reading the block ─────────────────────────────────────────────────────
//
// parseHighlightNoteEntries (both forms), parseFencedHighlightNoteEntries and
// legacyHighlightNotesStart are imported from highlight-notes-merge.js: the sync
// merge has to read exactly the entries this file writes, and two parsers that
// have to agree are one parser.

// Every note in `source`, keyed by id. Cheap enough to call per read (one
// regex scan of the tail), and always derived from the text rather than
// cached, so a hand-edit in the raw editor takes effect immediately.
export function readHighlightNotes(source) {
  const map = new Map();
  parseHighlightNoteEntries(source).forEach((entry) => {
    if (entry.text) map.set(entry.id, entry.text);
  });
  return map;
}

// The block rewritten as the `## Highlight Notes` markdown it used to be — for
// the exporters, so a note taken out of this app still reads as prose in any
// editor. Returns "" when there is nothing to say.
export function highlightNotesSectionMarkdown(source) {
  const entries = parseHighlightNoteEntries(source).filter((entry) => entry.text.trim());
  if (!entries.length) return "";
  const body = entries
    .map((entry) => `${entry.label ? `### [${entry.id}] ${entry.label}` : `### [${entry.id}]`}\n\n${entry.text.trim()}\n`)
    .join("\n");
  return `## ${HIGHLIGHT_NOTES_HEADING}\n\n${body}`;
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

// ── Writing the block ─────────────────────────────────────────────────────

// Upserts one note, keeping every other entry (and any hand-editing done to
// it) byte-for-byte. An empty text removes the entry.
//
// A note still in the legacy heading form is converted here, on the spot: the
// entries are read out of it, the section is cut, and the whole lot is written
// back as a fence. That is the migration for every deck that is edited rather
// than opened in the raw editor, and it means there is exactly one writer.
export function setHighlightNoteInSource(source, id, text, label) {
  const upgraded = fenceLegacySection(String(source || ""));
  const span = highlightNotesBlockSpan(upgraded);
  const entries = parseFencedHighlightNoteEntries(upgraded, span);
  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    existing.text = String(text || "").trim();
    // The excerpt is refreshed from the highlight it now points at, but never
    // invented: a caller with nothing to say leaves whatever label is there.
    if (label != null) existing.label = label;
  } else if (String(text || "").trim()) {
    entries.push({ id, label: label || "", text: String(text).trim() });
  }
  return writeHighlightNoteEntries(upgraded, span, entries, highlightNoteBlockPreamble(upgraded, span, entries));
}

// A `## Highlight Notes` section rewritten as a fence, in place. Returns the
// same string identity when there is nothing to convert, which is every note
// written since — so this is free to call on any write path.
export function fenceLegacySection(source) {
  if (!source || highlightNotesBlockSpan(source)) return source;
  const sectionStart = legacyHighlightNotesStart(source);
  if (sectionStart < 0) return source;
  const entries = parseLegacyHighlightNoteEntries(source, sectionStart);
  // A heading with no `### [hn-…]` under it is a heading the READER wrote, not
  // this app's section. Leave it exactly where it is.
  if (!entries.length) return source;
  const headEnd = source.indexOf("\n", sectionStart);
  const preamble = headEnd === -1 ? "" : source.slice(headEnd + 1, entries[0].start).trim();
  const head = source.slice(0, sectionStart).replace(/\s+$/, "").replace(/\n*(?:^|\n)-{3,}[ \t]*$/, "");
  return writeHighlightNoteEntries(head, null, entries, preamble);
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
  const upgraded = fenceLegacySection(String(source || ""));
  const span = highlightNotesBlockSpan(upgraded);
  if (!span) return source;
  const body = upgraded.slice(0, span.start);
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
  const entries = parseFencedHighlightNoteEntries(upgraded, span);
  if (entries.every((entry) => live.has(entry.id))) return upgraded;
  const preamble = highlightNoteBlockPreamble(upgraded, span, entries);
  return writeHighlightNoteEntries(upgraded, span, entries.filter((entry) => live.has(entry.id)), preamble);
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
//   notify — telling the surfaces that LIST highlights (the side-by-side pane
//     and its counter, the drawers, the badges) that one changed. A DIFFERENT
//     question from `rerender`, which is about repainting the surface the
//     highlight is ON, and the two were conflated on the document side of this
//     pair: setDocumentHighlightNote passed `rerender` straight through as its
//     notify, so { rerender: false } meant "and tell nobody" there while it
//     meant "but tell everybody" here. One option per question, same name on
//     both verbs, so a caller can ask for either without knowing which kind of
//     highlight it is holding.
//
// All three default to true, so every other caller is unchanged.
function rewriteFirstMarkNote(markIndex, makeNote, { rerender = true, undo = true, notify = true } = {}) {
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
  // Not optional: the deck has changed on disk whether or not anything was
  // repainted.
  scheduleDeckAutosave();
  // ...whereas this one is, for one caller: an editor saving on every typing
  // pause rebuilds the pane it is being typed into once per pause, and notifies
  // once at the end instead. Everyone else takes the default — the Highlights
  // pane is a different surface and may well be the one the edit was made from.
  if (notify) notifyHighlightsChanged();
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
  // The newer of the two legacy forms first, and on its own path: a note can be
  // in the heading form without a single base64 blob in it (every note written
  // between the two formats is), and the base64 walk below would return early
  // and leave the section un-fenced forever.
  const fenced = fenceLegacySection(String(source || ""));
  if (!fenced.includes("data-note=")) return fenced;
  const pending = [];
  const taken = new Set();
  let changed = false;
  let out = "";
  let cursor = 0;
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(fenced))) {
    const [whole, color, note, inner] = m;
    if (!note || isHighlightNoteId(note)) continue;
    const text = decodeHighlightNote(note);
    // An undecodable blob is dropped rather than carried: it has no readable
    // form to migrate to, and leaving it would keep the note cryptic forever.
    const id = text ? freshHighlightNoteId(fenced, taken) : null;
    if (id) {
      taken.add(id);
      pending.push({ id, text, label: excerptLabel(inner) });
    }
    changed = true;
    out += fenced.slice(cursor, m.index) + markOpenTag(color, id || undefined) + inner + MARK_CLOSE_TAG;
    cursor = m.index + whole.length;
  }
  if (!changed) return fenced; // the common case: nothing base64 left in this note
  out += fenced.slice(cursor);
  return pending.reduce((acc, p) => setHighlightNoteInSource(acc, p.id, p.text, p.label), out);
}
