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

// One capture group: the member deck's local id. Anchored to a whole line, so a
// marker mentioned mid-sentence in prose is not one.
export const MERGED_SECTION_RE = /^<!--\s*recall-section:([^\s>]+)\s*-->$/;

export function mergedSectionMarker(localId) {
  return `<!-- recall-section:${localId} -->`;
}

// Cut a merged document back into its sections.
//
// Fence-aware, the way scanPreparedHeadings is: inside ``` or ~~~ a line that
// looks like a marker is code, not a marker. Returns the sections in
// document order plus anything before the first marker, which a save must keep
// (it is where a stray edit above the first heading would land).
export function splitMergedNotes(markdown) {
  const lines = String(markdown || "").split("\n");
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
  return { preamble, sections };
}

export function mergedSectionBody(section) {
  // Trim the blank lines the join added, not the note's own leading structure.
  return section.lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

// Build the merged document. Members are already in the order they will appear.
export function buildMergedNotes(members) {
  return members
    .map((member) => `${mergedSectionMarker(member.localId)}\n# ${member.title}\n\n${member.notes}`.replace(/\s+$/, ""))
    .join("\n\n") + "\n";
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
