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
