// Moving rows of a contents around — the arithmetic only, with no DOM and no
// state, so it can be checked on its own (tools/pdf-toc-arrange-check.mjs).
//
// A contents here is a FLAT list of rows, each with a `depth`: a row's children
// are the rows straight after it that are deeper than it, up to the first that
// is not. That is the shape the drawer already draws (src/notes/toc-tree.js
// reads the tree back out of the depths), and it is the shape the rows are
// stored in, so every move below is "take a row and the block of rows under
// it, put the block somewhere else, and shift every depth in it by the same
// amount" — a branch keeps its own shape wherever it is dropped.

// One past the last row of the branch that starts at `index`.
export function subtreeEnd(entries, index) {
  const depth = entries[index]?.depth ?? 0;
  let end = index + 1;
  while (end < entries.length && entries[end].depth > depth) end += 1;
  return end;
}

// The depths a row may take when it is put in front of `rest[at]` (or at the
// end), in a list `rest` that no longer contains it:
//
//   - no deeper than one under the row above it — a row cannot be a
//     grandchild of something with no child;
//   - no shallower than the row below it — or that row, and the rest of its
//     siblings, would silently become the moved row's children.
export function allowedDepths(rest, at, maxDepth = Infinity) {
  const above = at > 0 ? rest[at - 1] : null;
  const below = at < rest.length ? rest[at] : null;
  const max = Math.min(maxDepth, above ? above.depth + 1 : 0);
  const min = Math.min(max, below ? below.depth : 0);
  return { min, max };
}

function clampDepth(depth, min, max) {
  return Math.max(min, Math.min(max, depth));
}

// Move the branch at `from` so it sits in front of what is now `before` (an
// index into `entries` as it is, or entries.length for the end), with its top
// row at `depth` — clamped to what is allowed there. Returns a new array, and
// the index the branch's top row ended up at; `entries` is not touched. A
// `before` inside the branch itself is not a move and gives the list back as
// it was.
export function moveSubtree(entries, from, before, depth, maxDepth = Infinity) {
  const end = subtreeEnd(entries, from);
  if (before > from && before < end) return { entries: entries.slice(), index: from };
  const block = entries.slice(from, end);
  const rest = entries.slice(0, from).concat(entries.slice(end));
  const at = before > from ? before - block.length : before;
  const { min, max } = allowedDepths(rest, at, maxDepth);
  const top = clampDepth(depth, min, max);
  const shift = top - block[0].depth;
  const moved = block.map((entry) => (shift ? { ...entry, depth: clampDepth(entry.depth + shift, 0, maxDepth) } : entry));
  return { entries: rest.slice(0, at).concat(moved, rest.slice(at)), index: at };
}

// The sibling before the row at `index`, or -1: the nearest row above it at its
// own depth, with nothing shallower in between.
export function previousSibling(entries, index) {
  const depth = entries[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (entries[at].depth < depth) return -1;
    if (entries[at].depth === depth) return at;
  }
  return -1;
}

export function nextSibling(entries, index) {
  const end = subtreeEnd(entries, index);
  return end < entries.length && entries[end].depth === entries[index].depth ? end : -1;
}

// The row's parent, or -1 for a row at the top level.
export function parentOf(entries, index) {
  const depth = entries[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    if (entries[at].depth < depth) return at;
  }
  return -1;
}

// One place up among its siblings, its branch with it.
export function moveUp(entries, index, maxDepth = Infinity) {
  const previous = previousSibling(entries, index);
  if (previous < 0) return null;
  return moveSubtree(entries, index, previous, entries[index].depth, maxDepth);
}

export function moveDown(entries, index, maxDepth = Infinity) {
  const next = nextSibling(entries, index);
  if (next < 0) return null;
  return moveSubtree(entries, index, subtreeEnd(entries, next), entries[index].depth, maxDepth);
}

// Into the sibling above it, as that sibling's last child.
export function indent(entries, index, maxDepth = Infinity) {
  if (previousSibling(entries, index) < 0) return null;
  if (entries[index].depth + 1 > maxDepth) return null;
  return moveSubtree(entries, index, index, entries[index].depth + 1, maxDepth);
}

// Out of its parent, to sit straight after it — after the parent's whole
// branch, so the siblings that followed it stay where they were rather than
// becoming its children.
export function outdent(entries, index, maxDepth = Infinity) {
  const parent = parentOf(entries, index);
  if (parent < 0) return null;
  return moveSubtree(entries, index, subtreeEnd(entries, parent), entries[parent].depth, maxDepth);
}

// Remove one row. Its children are not removed with it: they move up a level
// to take its place, so deleting a heading never deletes what was under it.
export function removeEntry(entries, index) {
  if (index < 0 || index >= entries.length) return entries.slice();
  const end = subtreeEnd(entries, index);
  return entries.slice(0, index)
    .concat(entries.slice(index + 1, end).map((entry) => ({ ...entry, depth: Math.max(0, entry.depth - 1) })))
    .concat(entries.slice(end));
}

// Where a new row for a place in the document belongs: after the last row
// whose own place is at or before it, one level under that row (a bookmark
// made inside a section is in that section). Rows without a page are skipped
// over.
export function insertionFor(entries, page, ratio, maxDepth = Infinity) {
  let after = -1;
  entries.forEach((entry, index) => {
    if (!entry.page) return;
    const entryRatio = Number(entry.ratio) || 0;
    if (entry.page < page || (entry.page === page && entryRatio <= ratio)) after = index;
  });
  if (after < 0) return { index: 0, depth: 0 };
  // Straight after the row, not after its branch: the branch's rows are
  // later in the document (or the reader put them there), and the bookmark is
  // the first thing in this section past the heading's own place.
  const index = after + 1;
  const { min, max } = allowedDepths(entries, index, maxDepth);
  return { index, depth: clampDepth(entries[after].depth + 1, min, max) };
}
