// Where a box being dragged or resized snaps to, and the guides that say why —
// as geometry and nothing else.
//
// "Seamless, like draw.io" is, more than anything, things lining up without
// being made to: a box dragged near another's edge or middle settles onto it,
// a thin line shows the two are now in line, and on squared paper a box that
// is near nothing settles onto the squares. This works that out; the page's
// own module (src/documents/pdf-guides.js) asks it on every frame of a drag
// and draws the lines.
//
// A LEAF: it imports nothing, so tools/diagram-geometry-check.mjs drives every
// rule here from Node.
//
// ── Space ──────────────────────────────────────────────────────────────────
//
// Rects are [x0, y0, x1, y1] in PDF space (y UP) and every distance is in
// points; the caller turns its threshold from screen pixels into points, so a
// snap feels the same at every zoom.
//
// A guide is { axis: "x" | "y", at, from, to }: a line at x = `at` (or y) from
// `from` to `to` along the other axis — long enough to touch the box being
// moved and every box it lines up with.

// The three places on a box a guide can run through, along one axis.
function snapAnchors(rect, axis) {
  const lo = rect[axis];
  const hi = rect[axis + 2];
  return [lo, (lo + hi) / 2, hi];
}

// The best snap along one axis for the anchors `mine` (positions on the box
// being moved), or null: the smallest move, within `threshold`, that puts one
// of them on one of another box's anchors.
function nearestAnchor(mine, others, axis, threshold) {
  let best = null;
  others.forEach((other) => {
    snapAnchors(other, axis).forEach((theirs) => {
      mine.forEach((at) => {
        const delta = theirs - at;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta) - 1e-9)) best = { delta, at: theirs };
      });
    });
  });
  return best;
}

// The guide along `axis` at `at`: from the box moved to the farthest box that
// has an anchor there.
function guideAt(axis, at, moved, others) {
  const across = axis === 0 ? 1 : 0;
  let from = moved[across];
  let to = moved[across + 2];
  others.forEach((other) => {
    if (!snapAnchors(other, axis).some((value) => Math.abs(value - at) < 0.01)) return;
    from = Math.min(from, other[across]);
    to = Math.max(to, other[across + 2]);
  });
  return { axis: axis === 0 ? "x" : "y", at, from, to };
}

// On squared paper: the nearest line of the grid to `value`.
function onGrid(value, grid, axis) {
  const origin = grid.origin?.[axis] || 0;
  return origin + Math.round((value - origin) / grid.pitch) * grid.pitch;
}

function shiftRect(rect, dx, dy) {
  return [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
}

// A whole box moved. Each axis snaps on its own: to another box's edge or
// middle within `threshold`, and failing that — on squared paper — its
// low edge onto the grid. Returns the extra move { dx, dy } and the guides.
export function snapMove(rect, others = [], { threshold = 4, grid = null } = {}) {
  const result = { dx: 0, dy: 0, guides: [] };
  [0, 1].forEach((axis) => {
    const best = nearestAnchor(snapAnchors(rect, axis), others, axis, threshold);
    if (best) {
      result[axis === 0 ? "dx" : "dy"] = best.delta;
      return;
    }
    if (grid?.pitch > 0) {
      const delta = onGrid(rect[axis], grid, axis) - rect[axis];
      if (Math.abs(delta) <= grid.pitch / 2) result[axis === 0 ? "dx" : "dy"] = delta;
    }
  });
  const moved = shiftRect(rect, result.dx, result.dy);
  [0, 1].forEach((axis) => {
    const best = nearestAnchor(snapAnchors(moved, axis), others, axis, 0.01);
    if (best) result.guides.push(guideAt(axis, best.at, moved, others));
  });
  return result;
}

// A box resized by some of its edges: `edges` names which — [x, y], each 0
// (the low edge moves), 2 (the high edge moves) or null (that axis is still).
// Only a moving edge snaps, to another box's edges and middle and then to the
// grid. Returns the snapped rect and the guides.
export function snapEdges(rect, edges, others = [], { threshold = 4, grid = null } = {}) {
  const out = rect.slice();
  const guides = [];
  [0, 1].forEach((axis) => {
    const which = edges?.[axis];
    if (which !== 0 && which !== 2) return;
    const index = axis + which;
    const best = nearestAnchor([rect[index]], others, axis, threshold);
    if (best) {
      out[index] = best.at;
      guides.push(guideAt(axis, best.at, out, others));
      return;
    }
    if (grid?.pitch > 0) out[index] = onGrid(rect[index], grid, axis);
  });
  // An edge snapped past its opposite one is no box: leave that axis alone.
  if (out[2] - out[0] < 1) { out[0] = rect[0]; out[2] = rect[2]; }
  if (out[3] - out[1] < 1) { out[1] = rect[1]; out[3] = rect[3]; }
  return { rect: out, guides: guides.filter((guide) => (guide.axis === "x" ? out[2] > out[0] : out[3] > out[1])) };
}

// Which edges a resize handle moves, as snapEdges takes them, from its compass
// name (n, ne, e, se, s, sw, w, nw) — with y UP, north is the HIGH edge.
export function edgesForHandle(handle) {
  const name = String(handle || "");
  const x = name.includes("e") ? 2 : name.includes("w") ? 0 : null;
  const y = name.includes("n") ? 2 : name.includes("s") ? 0 : null;
  return [x, y];
}
