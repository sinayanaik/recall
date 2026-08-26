// Several decks' notes as ONE document, and the way back out of it.
//
// Two things in this app read N decks and show them as a single note: "read
// this folder as one deck" (src/library/folder-deck.js) and loading several
// decks at once from My Decks. Both need the same document format, and both
// need to cut the result back into the decks it came from when it is edited —
// so the format, and the parser that undoes it, live here, once.
//
// Each deck's notes are introduced by an HTML-comment marker carrying its local
// id, then a `# Title` heading:
//
//     <!-- recall-section:local-1a2b3c -->
//     # Ancient Rome
//
//     …that deck's own notes…
//
// The comment survives markdown → DOMPurify as a comment node, so it is
// invisible in the reading view and visible (and therefore editable) only in
// the raw editor. The heading is a real heading, which is what puts each deck
// at the top of the table of contents, and renaming it renames the deck.
//
// ── Why this is a module of its own, and why it imports so little ─────────
//
// The same argument src/format/notes-fence.js and src/format/highlight-notes-
// merge.js make in their own headers. folder-deck.js reaches the card view, the
// study deck, the deck store, the toast layer and the view switcher; nothing
// that is purely a fact about a STRING should have to drag that along, and
// tools/merged-notes-check.mjs drives these functions straight from Node, where
// none of it would load. So everything here takes a string (or a plain object)
// and returns one, and the only imports it may ever take are the two leaf
// modules that own the highlight-notes block.
//
// Everything that needs `state`, the deck store or a surface — opening a merged
// document, planning the write-back, saving it — stays in folder-deck.js.

import {
  highlightNotesBlockSpan,
  joinHighlightNotesTail,
  splitHighlightNotesTail
} from "./notes-fence.js?v=__BUILD__";
import {
  fenceLegacySection,
  highlightNoteBlockPreamble,
  parseFencedHighlightNoteEntries,
  parseHighlightNoteEntries,
  writeHighlightNoteEntries
} from "./highlight-notes-merge.js?v=__BUILD__";

// One capture group: the member deck's local id. Anchored to a whole line, so a
// marker mentioned mid-sentence in prose is not one.
export const MERGED_SECTION_RE = /^<!--\s*recall-section:([^\s>]+)\s*-->$/;

export function mergedSectionMarker(localId) {
  return `<!-- recall-section:${localId} -->`;
}

// Cut a merged document back into its sections.
//
// The highlight-notes block comes off FIRST and is returned alongside them. It
// belongs to no section — it is the merge of every deck's — and leaving it in
// would attach it, and the `---` rule above it, to whichever deck happens to be
// last. It also means a section marker quoted inside a highlight's note cannot
// be read as a marker, which is one fewer way to break a document by writing
// about it.
//
// Fence-aware, the way scanPreparedHeadings is: inside ``` or ~~~ a line that
// looks like a marker is code, not a marker. Returns the sections in
// document order plus anything before the first marker, which a save must keep
// (it is where a stray edit above the first heading would land).
export function splitMergedNotes(markdown) {
  const { body, tail } = splitHighlightNotesTail(String(markdown || ""));
  const lines = body.split("\n");
  const sections = [];
  const preamble = [];
  let current = null;
  let inFence = false;
  let fenceChar = "";

  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
    } else if (!inFence) {
      const marker = line.trim().match(MERGED_SECTION_RE);
      if (marker) {
        current = { localId: marker[1], title: null, lines: [] };
        sections.push(current);
        continue;
      }
    }
    if (!current) { preamble.push(line); continue; }
    // The first non-blank line of a section is its `# Title`. Consumed rather
    // than kept, because it is generated on the way in and would otherwise be
    // saved into the member deck's own notes and then duplicated next time.
    if (current.title === null && line.trim()) {
      const heading = line.match(/^#\s+(.*)$/);
      current.title = heading ? heading[1].trim() : "";
      if (heading) continue;
    }
    current.lines.push(line);
  }
  return { preamble, sections, tail };
}

export function mergedSectionBody(section) {
  // Trim the blank lines the join added, not the note's own leading structure.
  return section.lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

// ── The highlight-notes block, N decks at a time ──────────────────────────
//
// Every deck's notes may END with the fenced block src/format/highlight-notes.js
// owns — one entry per highlight, keyed by an `hn-…` id that also sits on the
// <mark> in the body. The block is defined to be LAST (see notes-fence.js), and
// highlightNotesBlockSpan finds it by taking the last opening marker.
//
// Concatenating N notes gives N of those blocks, of which only the final one is
// still findable. The other N-1 stop being a machine-managed tail and become
// ordinary text in the middle of the document: their entries render as prose
// under the deck they belong to, the Highlights pane scans them as body
// content, and the raw editor — which is handed readerNotesBody — shows them.
//
// So the tails come off on the way in, their entries are unioned into ONE block
// at the end of the merged document, and splitMemberNoteTails puts each entry
// back on its own deck on the way out. That is a per-record merge of exactly
// the shape mergeHighlightNoteTails already does for two devices' copies of one
// deck, done here across many decks' single copies.

// The id on a highlight in the body. A private copy: the shared HIGHLIGHT_SCAN_RE
// lives in src/format/highlight.js, which reaches the deck store and the toast
// layer and would poison this leaf. It reads only the note id, which is all
// placement needs.
const NOTE_ID_IN_BODY_RE = /data-note="(hn-[a-z0-9]+)"/g;

function noteIdsIn(text) {
  const ids = new Set();
  NOTE_ID_IN_BODY_RE.lastIndex = 0;
  let m;
  while ((m = NOTE_ID_IN_BODY_RE.exec(text))) ids.add(m[1]);
  return ids;
}

// Unique against every id spoken for anywhere in the merge: the ones already
// claimed by an entry or a <mark>, and the ones a paper's own highlights hold.
function freshMergedNoteId(claimed, reserved) {
  for (;;) {
    const id = `hn-${Math.random().toString(36).slice(2, 6)}`;
    if (!claimed.has(id) && !reserved.has(id)) return id;
  }
}

// Each member's body without its tail, plus every entry in the merge with the
// deck it came from. Mutates nothing: the caller gets back a parallel array of
// { localId, title, body, preamble } and the two maps the write-back needs.
//
// A `## Highlight Notes` heading — the form the fence replaced — is normalized
// first, so a deck written before the fence contributes its entries like any
// other. fenceLegacySection returns the same string identity when there is
// nothing to convert, which is every note written since, and it deliberately
// leaves a heading with no `### [hn-…]` entries under it alone: that heading is
// the reader's own.
export function unionMemberNoteTails(members) {
  // Ids in use in the merged document: entries kept so far, and the <mark>s in
  // the bodies they came with.
  const claimed = new Set();
  // Ids a PDF deck's own highlights hold. Spoken for even though they appear in
  // no body — but only against the OTHER decks: an id its own deck reserved is
  // the very id its own entry carries, and reminting a paper's entry away from
  // meta.pdfHighlights would cut the note off from the highlight it is on.
  const reserved = new Map();
  const prepared = [];
  const entries = [];
  const noteOwner = {};
  const originalNoteId = {};

  members.forEach((member) => {
    (member.documentNoteIds || []).forEach((id) => {
      if (!reserved.has(id)) reserved.set(id, member.localId);
    });
  });

  members.forEach((member) => {
    const source = fenceLegacySection(String(member.notes || ""));
    const span = highlightNotesBlockSpan(source);
    const { body } = splitHighlightNotesTail(source);
    const own = parseFencedHighlightNoteEntries(source, span);
    const reminted = new Map();
    let text = body;

    own.forEach((entry) => {
      let id = entry.id;
      const heldElsewhere = reserved.has(id) && reserved.get(id) !== member.localId;
      if (claimed.has(id) || heldElsewhere) {
        // Two decks minted the same id independently — 4 base-36 characters are
        // unique within ONE note by construction and no further (see
        // freshHighlightNoteId). Reminted exactly as a colliding CARD id is,
        // and remembered so the deck gets its own id back on the way out.
        id = freshMergedNoteId(claimed, reserved);
        text = text.split(`data-note="${entry.id}"`).join(`data-note="${id}"`);
        originalNoteId[id] = entry.id;
        reminted.set(entry.id, id);
      }
      claimed.add(id);
      noteOwner[id] = member.localId;
      entries.push({ id, label: entry.label, text: entry.text });
    });
    noteIdsIn(text).forEach((id) => claimed.add(id));

    prepared.push({
      localId: member.localId,
      title: member.title,
      body: text,
      // Under whatever id this merge is using for it, so the prune guard in
      // pruneOrphanHighlightNotes protects the entry that is actually in the
      // document rather than the one the deck knows by that name.
      documentNoteIds: (member.documentNoteIds || []).map((id) => reminted.get(id) || id),
      // Anything the reader wrote inside their own block above its first entry.
      // Kept PER DECK rather than unioned: concatenating N readers' asides into
      // one paragraph is the prose-leak this whole scheme is about.
      preamble: highlightNoteBlockPreamble(source, span, own)
    });
  });

  return { prepared, entries, noteOwner, originalNoteId };
}

// Build the merged document. Members are already in the order they will appear.
// Returns the document and the two maps that put its highlight notes back where
// they came from; the maps ride on state.folderDeck until the write-back.
export function buildMergedNotes(members) {
  const { prepared, entries, noteOwner, originalNoteId } = unionMemberNoteTails(members);
  const preambleById = {};
  prepared.forEach((member) => { if (member.preamble) preambleById[member.localId] = member.preamble; });

  const document = prepared
    // A heading, always: the table of contents matches these against the member
    // titles in order to work out where each deck's own headings begin (see
    // applyFolderSectionDepths), and a bare `#` matches nothing.
    .map((member) => `${mergedSectionMarker(member.localId)}\n# ${member.title || "Untitled deck"}\n\n${member.body}`.replace(/\s+$/, ""))
    .join("\n\n") + "\n";

  // The tail is written in the exact shape mergeHighlightNoteTails produces, so
  // a device that syncs one of these decks does not read a differently-spelled
  // block as a change and merge it against itself.
  const notes = entries.length
    ? joinHighlightNotesTail(document, writeHighlightNoteEntries("", null, entries, "").replace(/\n$/, ""))
    : document;

  return {
    notes,
    noteOwner,
    originalNoteId,
    preambleById,
    protectedNoteIds: prepared.flatMap((member) => member.documentNoteIds)
  };
}

// The inverse: what each member's half of the merged block is, and any id in
// its section body that has to be spelled the way that deck spells it.
//
// Placement, in order: the section whose body still carries the id; failing
// that the deck it arrived from (a PDF deck's entries are never in any body —
// its highlights live in meta.pdfHighlights — and a reader may have deleted the
// <mark> while leaving the note); failing that the first member, which is the
// same honest answer planFolderDeckWrite already gives an ownerless card. An
// entry is never dropped: sweeping an orphan is pruneOrphanHighlightNotes's job
// and it makes that decision against one deck at a time.
//
// A remint is undone only for an entry going back to the deck it CAME from. If
// the reader moved the highlighted passage into another deck, the merged id
// travels with it: it is unique across the whole merge, so it is unique in its
// new deck — where the id it was reminted away from may well already be taken,
// which is why it was reminted in the first place.
//
// `tail` is the merged block as splitMergedNotes returned it. Passed rather than
// re-derived because the caller has it already — and because parsing it alone
// lets the one-deep memo in parseHighlightNoteEntries actually HIT: the tail is
// unchanged by ordinary typing, where the whole document is not, and this runs
// on every autosave.
export function splitMemberNoteTails(tail, sections, folder) {
  const entries = tail ? parseHighlightNoteEntries(tail) : [];
  const fallback = folder.members[0]?.localId;

  const ownerBySection = new Map();
  sections.forEach((section) => {
    noteIdsIn(section.lines.join("\n")).forEach((id) => ownerBySection.set(id, section.localId));
  });

  const byOwner = new Map(folder.members.map((member) => [member.localId, { entries: [], renames: [] }]));
  entries.forEach((entry) => {
    const owner = ownerBySection.get(entry.id) || folder.noteOwner?.[entry.id] || fallback;
    const share = byOwner.get(owner) || byOwner.get(fallback);
    if (!share) return;
    const original = folder.originalNoteId?.[entry.id];
    const restore = original && owner === folder.noteOwner?.[entry.id];
    if (restore) share.renames.push([entry.id, original]);
    share.entries.push(restore ? { ...entry, id: original } : entry);
  });

  const shareById = new Map();
  byOwner.forEach((share, localId) => {
    shareById.set(localId, {
      tail: share.entries.length
        ? writeHighlightNoteEntries("", null, share.entries, folder.preambleById?.[localId] || "").replace(/\n$/, "")
        : "",
      renames: share.renames
    });
  });
  return shareById;
}

// A member's notes as they should be written back: its section body — with any
// reminted id spelled back the way this deck spells it — and its own share of
// the merged block re-attached, in the form it arrived in.
export function memberNotesFromMerged(body, share) {
  const renamed = (share?.renames || []).reduce(
    (text, [from, to]) => text.split(`data-note="${from}"`).join(`data-note="${to}"`),
    String(body || "")
  );
  return share?.tail ? joinHighlightNotesTail(renamed, share.tail) : renamed;
}

// The reason a save was refused, or "" when the document is intact. Split out
// so the refusal can be tested without driving a save.
export function mergedSplitProblem(markdown, members) {
  const { sections } = splitMergedNotes(markdown);
  const expected = members.map((member) => member.localId);
  const seen = sections.map((section) => section.localId);
  if (seen.length !== expected.length) {
    return `expected ${expected.length} section marker${expected.length === 1 ? "" : "s"}, found ${seen.length}`;
  }
  const missing = expected.filter((id) => !seen.includes(id));
  if (missing.length) return `${missing.length} section marker${missing.length === 1 ? "" : "s"} no longer match a deck`;
  if (new Set(seen).size !== seen.length) return "a section marker appears more than once";
  return "";
}

// Which section does a newly created card's source text live in? Cards made
// from a selection carry a noteAnchor into the merged markdown; the section
// holding that text is the deck that should own the card.
export function ownerForNewCard(card, sections) {
  const needle = String(card.noteAnchor?.text || card.question || "").trim().slice(0, 60);
  if (!needle) return null;
  const match = sections.find((section) => section.lines.join("\n").includes(needle));
  return match ? match.localId : null;
}
