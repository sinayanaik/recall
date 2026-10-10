// Two devices edited the same note. Put the two edits together.
//
// ── Why this is not last-write-wins with a stash ──────────────────────────
//
// It was, and for free markdown that was a defensible answer: merging two
// people's prose is a different problem, and src/sync/notes-conflict.js is a
// careful resolver for it — the losing copy is kept, the reader is asked, and
// nothing is thrown away without an answer.
//
// What made it the wrong default is how often it fired for no reason. The gates
// that decide "did both sides edit this?" used to ask about the DECK, so one ink
// stroke on one device raised a conflict about a note nobody had touched (see
// syncTextFingerprint in ./diff.js, which fixed that half). Once they ask about
// the BODY, what is left is the real case: two devices that genuinely both typed.
// And for that, "keep one and file the other under a question" is a poor answer
// when the two edits are three paragraphs apart, which is what they usually are.
//
// So: a three-way merge. With the body as it stood when the two devices last
// agreed, an edit here and an edit there are two independent changes to a common
// ancestor, and applying both is not a guess — it is the only reading that loses
// nothing. Only where they touched the SAME lines is there a question, and there
// the resolver is still exactly what happens.
//
// ── Why lines, and why no library ─────────────────────────────────────────
//
// A line is the unit a person edits markdown in — a paragraph is a line here,
// because a blank line separates them — and it is the unit every three-way merge
// that has ever worked in practice uses. Character-level merging of prose
// produces text nobody wrote, which is the one outcome worse than asking.
//
// No dependency, because this repo has none and is not about to gain one for
// ~80 lines of Myers-adjacent bookkeeping. What is here is a plain LCS over
// lines, which is O(n·m) in the worst case and fine at the size involved: the
// common prefix and suffix are trimmed first, so the matrix only ever covers the
// part that actually differs, and two devices' edits to one note differ by
// paragraphs and not by books. A body large enough to make even that expensive
// bails out to "no merge" and the caller keeps its stash-and-ask.
//
// ── Where it lives, and why it imports nothing ────────────────────────────
//
// The same position, and the same argument, as
// src/format/highlight-notes-merge.js: the sync path needs this on decks that
// are not open, against two strings handed to it by a network round trip, and
// tools/sync-reconcile-check.mjs drives it straight from Node. So it is a leaf
// that knows about strings and nothing else — no state, no store, no DOM.

// The engine lives in ./merge3.js, shared with the deck-level merges; this is
// the notes-body face of it, kept under its old name because two sync paths and
// tools/sync-reconcile-check.mjs call it.
//
// ── What changed, and why ─────────────────────────────────────────────────
//
// This used to be all-or-nothing: one clash anywhere in the note and the whole
// merge was refused, so two devices that each fixed a different typo in the
// same paragraph — or edited two neighbouring lines — had one of their edits
// filed away under a question. That is not how merging works anywhere else. Now
// every change that CAN be applied is applied (down to the word, inside a
// paragraph both edited), and only the regions the two genuinely changed in
// different ways are reported, one by one, in `conflictHunks`.

import { mergeText } from "./merge3.js?v=__BUILD__";

// Merge `local` and `remote`, both derived from `base`.
//
// Returns { merged, conflicts, ok, conflictHunks, insertedBoth }:
//   ok             false when the merge declined (no base, or too large to
//                  reason about) — `merged` is then `local` and the caller falls
//                  back to keeping a whole copy, as before.
//   merged         every change from both sides; in a conflicting region, the
//                  LOCAL side's text.
//   conflicts      how many regions clashed (0 means a clean merge).
//   conflictHunks  [{ base, local, remote, line }] for each of those regions —
//                  `remote` is the text the merge did not keep there.
export function mergeNoteBodies(base, local, remote) {
  const result = mergeText(base, local, remote);
  return {
    merged: result.merged,
    conflicts: result.conflicts.length,
    ok: result.ok,
    conflictHunks: result.conflicts,
    insertedBoth: result.insertedBoth
  };
}
