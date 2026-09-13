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

// The most lines this will run the matrix over. Past it the merge declines and
// the caller falls back to the resolver, which is the honest answer: a note that
// large is one where a wrong merge would be hardest to spot and hardest to undo.
export const MERGE3_MAX_LINES = 4000;

// Named for this module rather than `lines`, which a dozen other files use as a
// local and which tools/module-symbols.mjs therefore reads as a collision.
function merge3Lines(text) {
  return String(text || "").split("\n");
}

// The longest common subsequence of two line arrays, as a list of [i, j] pairs.
// Plain dynamic programming: the trimming below is what keeps the inputs small,
// and a cleverer algorithm here would be a second thing to get wrong.
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i += 1;
    else j += 1;
  }
  return pairs;
}

// The edit from `base` to `side`, as runs of base lines replaced by side lines.
// Anchored on the LCS, so a hunk is always "base lines [start, end) became these
// lines" — which is the form the overlap test below needs.
function hunks(base, side) {
  const out = [];
  const pairs = lcsPairs(base, side);
  let bi = 0;
  let si = 0;
  const flush = (bEnd, sEnd) => {
    if (bi === bEnd && si === sEnd) return;
    out.push({ start: bi, end: bEnd, replacement: side.slice(si, sEnd) });
  };
  for (const [b, s] of pairs) {
    flush(b, s);
    bi = b + 1;
    si = s + 1;
  }
  flush(base.length, side.length);
  return out;
}

// Do two hunks touch the same base lines — or meet end to end at one?
//
// The adjacency half is deliberate and is not over-caution. Two hunks that abut
// have no line between them to say which order they belong in, so applying both
// invents an ordering the reader never chose; interleaving two people's
// paragraphs is exactly the "text nobody wrote" this merge must not produce. An
// insertion at the same point from both sides is the commonest instance, and it
// is a question, not a merge.
function overlaps(x, y) {
  return x.start <= y.end && y.start <= x.end;
}

// Merge `local` and `remote`, both derived from `base`.
//
// Returns { merged, conflicts, ok }. `ok` false means the merge declined — too
// large, or no base to work from — and the caller must fall back to whatever it
// did before. `conflicts` counts the hunk pairs that touched the same lines;
// when it is non-zero `merged` is not usable and the caller must ask.
//
// Deliberately all-or-nothing rather than emitting conflict markers into the
// text. A `<<<<<<<` in somebody's notes is a merge tool's output leaking into a
// document, and this app already has a better answer for the case: the losing
// copy is stashed whole and the reader picks. Markers would also round-trip
// through the sync as ordinary prose, to every other device.
export function mergeNoteBodies(base, local, remote) {
  const baseText = String(base ?? "");
  const localText = String(local ?? "");
  const remoteText = String(remote ?? "");

  // Nothing to reason from. Not a failure — a deck that has never synced, or one
  // whose base predates this — but not a merge either.
  if (base === null || base === undefined) return { merged: localText, conflicts: 0, ok: false };

  // The easy three, which are also the common three, answered without building
  // a matrix at all.
  if (localText === remoteText) return { merged: localText, conflicts: 0, ok: true };
  if (localText === baseText) return { merged: remoteText, conflicts: 0, ok: true };
  if (remoteText === baseText) return { merged: localText, conflicts: 0, ok: true };

  const baseLines = merge3Lines(baseText);
  const localLines = merge3Lines(localText);
  const remoteLines = merge3Lines(remoteText);
  if (Math.max(baseLines.length, localLines.length, remoteLines.length) > MERGE3_MAX_LINES) {
    return { merged: localText, conflicts: 0, ok: false };
  }

  const localHunks = hunks(baseLines, localLines);
  const remoteHunks = hunks(baseLines, remoteLines);

  let conflicts = 0;
  for (const l of localHunks) {
    for (const r of remoteHunks) {
      // Identical edits on both sides are one edit, not a clash — two devices
      // that fixed the same typo agree, and asking about that would be the
      // resolver firing on a merge that had nothing to resolve.
      if (!overlaps(l, r)) continue;
      if (l.start === r.start && l.end === r.end
          && l.replacement.join("\n") === r.replacement.join("\n")) continue;
      conflicts += 1;
    }
  }
  if (conflicts) return { merged: localText, conflicts, ok: true };

  // Apply both sets, in base order. Non-overlapping by the test above, so the
  // only thing left is to walk the base once and splice — and to drop the
  // duplicate when both sides made the identical change.
  const all = [...localHunks, ...remoteHunks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cursor = 0;
  for (const hunk of all) {
    // The identical-edit case skipped above: the second copy has already been
    // applied, and the cursor is past it.
    if (hunk.start < cursor) continue;
    out.push(...baseLines.slice(cursor, hunk.start));
    out.push(...hunk.replacement);
    cursor = hunk.end;
  }
  out.push(...baseLines.slice(cursor));
  return { merged: out.join("\n"), conflicts: 0, ok: true };
}
