// Putting a stashed notes body back, without eating the highlight notes.
//
// A conflict stash (see NOTES_CONFLICT_SUFFIX) holds the WHOLE notes string of
// the copy that lost — fenced highlight-note block included. That is deliberate:
// the pull mines the stash's TAIL to recover annotations stranded on a device
// that has been diverging since before the document merge existed (see
// `extraTails` in src/sync/reconcile.js).
//
// The resolver in src/sync/notes-conflict.js then has to put the stash back, and
// it treated the whole string as prose — concatenating it for "Keep both",
// assigning it wholesale for "Keep mine". Both are wrong for the same reason:
//
//   • highlightNotesBlockSpan takes the LAST opening marker, so appending a
//     stash that carries its own block makes the stash's OLDER tail the live one
//     and demotes the merged tail into the body, where it renders as prose and
//     is then pushed to every other device in that state;
//   • "Keep mine" replaces the merged tail with whatever the stash happened to
//     hold when it was written, discarding every highlight note that has merged
//     in since.
//
// So "Keep both", the button that promises "Nothing is lost", lost the merged
// highlight note and left a raw fence marker stranded mid-prose.
//
// The rule both resolvers need is the same one the sync itself follows: the BODY
// is the thing in conflict, and the TAIL is merged per entry and never replaced.
// So the stash contributes its body only, and the tail already on the deck — the
// merged one — is the tail that survives.
//
// ── Why this is a module of its own ────────────────────────────────────────
//
// src/sync/notes-conflict.js reaches the DOM, the deck store, the library index
// and the toast layer, so it cannot be driven from Node. These two functions are
// pure string work over notes-fence.js, which imports nothing — the same split
// src/sync/document-sync.js makes for the same reason, and what lets
// tools/sync-reconcile-check.mjs test them with no browser.

import { joinHighlightNotesTail, splitHighlightNotesTail } from "../format/notes-fence.js?v=__BUILD__";

// The heading the restored copy is filed under. One definition, because the
// resolver writes it and the check reads it.
export function restoredNotesHeading(when) {
  return `## Your notes from before ${when || "an earlier sync"}`;
}

// "Keep both": the stash's prose appended below what the deck now holds, under a
// dated heading, with the deck's CURRENT highlight-note block re-attached at the
// end where it belongs. Nothing is discarded — which is what the button says.
export function mergeRestoredNotes(currentNotes, stashNotes, when) {
  const current = splitHighlightNotesTail(String(currentNotes || ""));
  const stashedBody = splitHighlightNotesTail(String(stashNotes || "")).body;
  // A stash that was only ever annotations has no prose to bring back; its tail
  // has already been folded in by the pull, so there is nothing left to do here.
  if (!stashedBody.trim()) return String(currentNotes || "");
  const body = `${current.body}\n\n---\n\n${restoredNotesHeading(when)}\n\n${stashedBody}\n`;
  return joinHighlightNotesTail(body, current.tail);
}

// "Keep mine": the stash's prose becomes the notes body, and the deck's current
// highlight-note block rides along untouched. The stash's own tail is
// deliberately dropped — it is a strictly older copy of a block that is merged
// entry by entry, and the pull has already taken anything it uniquely held.
export function promoteStashedNotes(currentNotes, stashNotes) {
  const currentTail = splitHighlightNotesTail(String(currentNotes || "")).tail;
  const stashedBody = splitHighlightNotesTail(String(stashNotes || "")).body;
  return joinHighlightNotesTail(stashedBody, currentTail);
}

// ── One clashing paragraph, answered ────────────────────────────────────────
//
// A partial merge (src/sync/merge3.js) applies every change from both sides and
// keeps, in each region the two changed differently, THIS side's text; the
// other side's text for that region is filed as a hunk { kept, other }. These
// are the three answers to one hunk:
//
//   "current"  keep what the note holds — nothing to change
//   "other"    put the other version in its place
//   "both"     keep both, this one first
//
// The paragraph is found by its text. If it has been edited since (so `kept`
// is no longer in the note), nothing is guessed: the other version is added at
// the end under a heading saying where it came from, which loses nothing and
// asks nothing more of the reader.
export function applyConflictHunk(notes, hunk, choice) {
  const current = String(notes || "");
  if (choice === "current") return { notes: current, placed: true };
  const { body, tail } = splitHighlightNotesTail(current);
  const kept = String(hunk?.kept ?? "");
  const other = String(hunk?.other ?? "");
  const at = kept ? body.indexOf(kept) : -1;
  if (at === -1) {
    if (!other.trim()) return { notes: current, placed: false };
    const from = hunk?.otherFrom || "another device";
    const appended = `${body.replace(/\s+$/, "")}\n\n---\n\n## Version from ${from}\n\n${other}\n`;
    return { notes: joinHighlightNotesTail(appended, tail), placed: false };
  }
  const replacement = choice === "other" ? other : `${kept}\n\n${other}`;
  const nextBody = body.slice(0, at) + replacement + body.slice(at + kept.length);
  return { notes: joinHighlightNotesTail(nextBody, tail), placed: true };
}

// ── One clashing card field, answered ──────────────────────────────────────
//
// The card counterpart of applyConflictHunk: two devices changed the same
// field of one card in ways the word merge could not settle, the card kept
// this device's text, and the other device's waits in the hunk. Returns the
// snapshot with that field set, and the card marked as edited so the answer is
// what the next sync sends — or the snapshot unchanged for "current", or when
// the card no longer exists.
export function applyCardConflictHunk(snapshot, hunk, choice, stampIso = new Date().toISOString()) {
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards : [];
  const index = cards.findIndex((card) => String(card.id) === String(hunk?.cardId));
  if (choice === "current" || index === -1) return { snapshot, changed: false, found: index !== -1 };
  const field = hunk.field === "question" ? "question" : "answer";
  const current = String(cards[index][field] ?? "");
  const other = String(hunk.other ?? "");
  const next = choice === "other" ? other : (current.includes(other) ? current : `${current}\n\n${other}`);
  if (next === current) return { snapshot, changed: false, found: true };
  const nextCards = cards.slice();
  nextCards[index] = { ...cards[index], [field]: next, dirty: true, updatedAt: stampIso };
  return { snapshot: { ...snapshot, cards: nextCards }, changed: true, found: true };
}
