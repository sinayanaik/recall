// Where a page's connectors go: which side each tied end leaves by, where on
// that side, and — for one with square corners — the way round whatever is in
// the way.
//
// "The arrows are not very adaptive, the waypoints are almost the same for each
// arrow, and they look different each time I open." Three things were true:
//
//   • every end on one side of a box left from the middle of that side, so
//     three arrows out of the right of a box were one arrow drawn three times
//     until they parted somewhere further on;
//   • an elbow's side was "whichever side faces the other end", worked out
//     from the two middles alone, and its corners were always halfway — so
//     a route went straight through any box between the two, and every elbow
//     between two rows of boxes turned at the same place;
//   • and that "facing" side flipped between two answers whenever the two
//     middles were near a diagonal — which a block's height settling by a point
//     after its fonts arrived was enough to tip. The same diagram, opened twice,
//     came up routed two ways.
//
// So this works out every connector on a page TOGETHER (layoutConnectors):
//
//   1. Sides. An end the reader tied to a side keeps it. An "auto" end of a
//      straight connector still floats — it leaves along the line between the
//      two middles, which already parts arrows going to different places. An
//      "auto" end of an elbow or a curve tries all four sides and takes the
//      one whose route is shortest, turns least and crosses nothing; the side
//      it took last time (the record's `exits`) is kept unless another is
//      clearly better, so a point either way does not flip it.
//   2. Ports. An end pinned to a spot on its side (its `at`, set by letting it
//      go there — anywhere on the outline, as draw.io's) stays on that spot,
//      as the same fraction of the side however the box is moved or sized.
//      The other ends that leave one side of one box share that side out
//      between them, in the order of where they are going, so they do not
//      cross.
//   3. Routes. An elbow whose plain route crosses a box on the page goes round
//      it: the shortest path with the fewest turns over a sparse grid of the
//      boxes' edges (orthogonalRoute). Its corners are stored as `via`, so
//      every renderer and every export draws the same line from the record.
//
// Everything is decided by the page alone, in a fixed order, with ties broken
// by id — every device draws the same diagram, and so does every opening.
//
// Pure: no DOM, no state. tools/diagram-geometry-check.mjs asserts it in Node.

import { CONNECTOR_STUB, ROUTE_TURN_COST, elbowPath, freeExits, normalizeShape, pathLength, pathTurns, simplifyPath } from "./annot-shapes.js?v=__BUILD__";
import { NODE_SIDES, SIDE_VECTORS, polygonCentre, polygonPerimeterPoint, polygonRayExit, sideFacing } from "./node-outlines.js?v=__BUILD__";

// How far short of the outline a tied end stops, so its head is never under
// the box it points at (a block is drawn over every shape).
export const CONNECTOR_END_GAP = 2;

// How far a route keeps from a box it goes round, in points.
export const ROUTE_CLEARANCE = 10;

// What a corner costs, in points of length: enough that a route takes a few
// points' detour rather than an extra turn.
const TURN_COST = ROUTE_TURN_COST;
// What crossing a box costs a route being scored for its sides.
const CROSS_COST = 600;
// How much better another side has to be before an end leaves the side it
// left by last time.
const KEEP_SIDE = 0.8;
// The most grid lines a route search uses on either axis, so a crowded page
// costs a bounded amount per connector.
const GRID_MAX = 48;

const DIRS = { n: [0, 1], e: [1, 0], s: [0, -1], w: [-1, 0] };
const SIDE_ORDER = NODE_SIDES;

const round2 = (n) => Math.round(n * 100) / 100;
const roundPoint = (p) => [round2(p[0]), round2(p[1])];

function inflateRect(rect, by) {
  return [rect[0] - by, rect[1] - by, rect[2] + by, rect[3] + by];
}

function insideOpen(rect, [x, y]) {
  return x > rect[0] + 1e-6 && x < rect[2] - 1e-6 && y > rect[1] + 1e-6 && y < rect[3] - 1e-6;
}

// Does the axis-aligned (or any) segment a→b pass through the open inside of
// `rect`? Liang–Barsky against the rectangle shrunk by a hair, so running
// along an edge is not a crossing.
export function segmentCrossesRect(a, b, rect) {
  const [x0, y0, x1, y1] = [rect[0] + 1e-6, rect[1] + 1e-6, rect[2] - 1e-6, rect[3] - 1e-6];
  if (x0 >= x1 || y0 >= y1) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q > 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a[0] - x0) || !clip(dx, x1 - a[0]) || !clip(-dy, a[1] - y0) || !clip(dy, y1 - a[1])) return false;
  return t1 - t0 > 1e-9;
}

// The part of a route between its two stubs' ends: [a1, …, b1]. The stubs
// themselves run out of the boxes the route joins, so they cross those boxes'
// clearance by design. Each end's first stretch is cut back by a stub — or by
// all of it when it is shorter, as it is between two boxes too close for whole
// stubs (src/render/annot-shapes.js, elbowPath): there the middle run is
// squeezed into the gap, and is not going THROUGH either box.
function betweenStubs(points) {
  if (points.length < 2) return points.slice();
  const cut = (p, q) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-9) return p.slice();
    const t = Math.min(CONNECTOR_STUB, len) / len;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const n = points.length;
  return [cut(points[0], points[1]), ...points.slice(1, -1), cut(points[n - 1], points[n - 2])];
}

function pathCrossings(points, rects) {
  let count = 0;
  rects.forEach((rect) => {
    for (let i = 1; i < points.length; i += 1) {
      if (segmentCrossesRect(points[i - 1], points[i], rect)) { count += 1; return; }
    }
  });
  return count;
}

// ── Where on a side an end goes ───────────────────────────────────────────
//
// `offset` is along the side, from its middle, in points. Straight out from
// that point on the box's middle line, to the outline — on a box, a point on
// the edge; on a diamond, on its slope. A turned box's sides are the page's
// (up, right, down, left), measured on the box round its turned outline, as
// everywhere here.
function sideOutlinePoint(node, side, offset = 0) {
  const v = SIDE_VECTORS[side];
  const centre = polygonCentre(node.poly);
  const along = v[0] === 0 ? [1, 0] : [0, 1];
  const from = [centre[0] + along[0] * offset, centre[1] + along[1] * offset];
  return polygonRayExit(node.poly, from, [from[0] + v[0], from[1] + v[1]]) || polygonRayExit(node.poly, centre, [centre[0] + v[0], centre[1] + v[1]]) || centre;
}

export function sidePort(node, side, offset = 0) {
  const v = SIDE_VECTORS[side];
  const hit = sideOutlinePoint(node, side, offset);
  return [hit[0] + v[0] * CONNECTOR_END_GAP, hit[1] + v[1] * CONNECTOR_END_GAP];
}

// How long a side is: the width of the box round the outline for its top and
// bottom, its height for its left and right. An end's `at` is a fraction of it.
export function sideLength(node, side) {
  const [x0, y0, x1, y1] = node.rect;
  return side === "n" || side === "s" ? x1 - x0 : y1 - y0;
}

// The offset from the side's middle that an `at` (0…1 along it) stands for.
export function atOffset(node, side, at) {
  return (at - 0.5) * sideLength(node, side);
}

// The point on the outline an end pinned at `at` along `side` touches — the
// spot shown while it is being let go (the port itself stands a hair off it).
export function outlineAnchorPoint(node, side, at = 0.5) {
  return sideOutlinePoint(node, side, atOffset(node, side, at));
}

// A point on the outline as a side and a fraction along it: the inverse of
// outlineAnchorPoint, so an end let go there is drawn exactly there. The side facing
// the point is tried first; on an outline where that side's straight-out line
// meets the edge somewhere else (a turned thin box near a corner), the side
// that comes back nearest to the point wins.
export function outlineAnchorAt(node, q) {
  const [x0, y0, x1, y1] = node.rect;
  const facing = sideFacing(node.rect, q);
  const order = [facing, ...NODE_SIDES.filter((side) => side !== facing)];
  let best = null;
  for (const side of order) {
    const length = sideLength(node, side);
    if (length <= 1e-9) continue;
    const raw = side === "n" || side === "s" ? (q[0] - x0) / (x1 - x0) : (q[1] - y0) / (y1 - y0);
    const at = Math.min(1, Math.max(0, raw));
    const back = outlineAnchorPoint(node, side, at);
    const miss = Math.hypot(back[0] - q[0], back[1] - q[1]);
    if (!best || miss < best.miss - 1e-9) best = { side, at, miss };
    if (miss < 0.5) break;
  }
  return best ? { side: best.side, at: Math.round(best.at * 10000) / 10000 } : null;
}

// How far apart the ports on one side may spread: the side's length, less a
// margin at each corner.
function sideSpan(node, side) {
  const [x0, y0, x1, y1] = node.rect;
  const length = side === "n" || side === "s" ? x1 - x0 : y1 - y0;
  return Math.max(0, length - 6);
}

// ── Square corners, round what is in the way ───────────────────────────────
//
// From `a` leaving `da` to `b` arriving against `db` (each end runs straight
// out for CONNECTOR_STUB first), avoiding every rectangle in `rects`. A
// Dijkstra over the grid the rectangles' edges, the two stubs and the midway
// lines make, whose cost is length plus TURN_COST per corner. Null when the
// plain elbow (elbowPath) crosses nothing — the common case, which keeps a
// simple diagram exactly as it was drawn before — or when no way round is
// found.
//
// `rects` carry ROUTE_CLEARANCE round each box (layoutConnectors). The plain
// elbow is held to that clearance for every box but the two it joins: for
// those it only has to stay out of the box itself. Two boxes closer than
// twice the clearance leave no room to keep it from either, and the plain
// elbow squeezed into the gap between them beats a loop all the way round.
const routeMemo = new Map();
const ROUTE_MEMO_MAX = 300;

export function orthogonalRoute(a, da, b, db, rects) {
  const va = DIRS[da] || [1, 0];
  const vb = DIRS[db] || [-1, 0];
  const a1 = [a[0] + va[0] * CONNECTOR_STUB, a[1] + va[1] * CONNECTOR_STUB];
  const b1 = [b[0] + vb[0] * CONNECTOR_STUB, b[1] + vb[1] * CONNECTOR_STUB];
  // A box the route has to start or finish inside is not one it can avoid.
  const blocks = rects.filter((rect) => !insideOpen(rect, a1) && !insideOpen(rect, b1));
  const plain = elbowPath(a, da, b, db);
  const held = blocks.map((rect) => (insideOpen(rect, a) || insideOpen(rect, b) ? inflateRect(rect, -ROUTE_CLEARANCE) : rect));
  if (!pathCrossings(betweenStubs(plain), held)) return null;
  const key = [a, b, da, db].flat().join(",") + "|" + blocks.map((r) => r.map(round2).join(",")).join(";");
  if (routeMemo.has(key)) return routeMemo.get(key);
  const found = searchRoute(a, a1, va, b, b1, vb, blocks);
  if (routeMemo.size >= ROUTE_MEMO_MAX) routeMemo.delete(routeMemo.keys().next().value);
  routeMemo.set(key, found);
  return found;
}

function gridLines(values, keep) {
  const sorted = [...new Set(values.map(round2))].sort((m, n) => m - n);
  if (sorted.length <= GRID_MAX) return sorted;
  // Too many: the ones the route must be able to reach, and the rest thinned.
  const must = new Set(keep.map(round2));
  const step = Math.ceil(sorted.length / GRID_MAX);
  return sorted.filter((value, i) => must.has(value) || i % step === 0);
}

function searchRoute(a, a1, va, b, b1, vb, blocks) {
  // Only the boxes near the way between the ends shape the grid; a box far off
  // to the side adds lines no shortest route would use.
  const pad = 120;
  const near = [Math.min(a1[0], b1[0]) - pad, Math.min(a1[1], b1[1]) - pad, Math.max(a1[0], b1[0]) + pad, Math.max(a1[1], b1[1]) + pad];
  const local = blocks.filter((r) => r[2] >= near[0] && r[0] <= near[2] && r[3] >= near[1] && r[1] <= near[3]);
  const xs = gridLines([a1[0], b1[0], (a1[0] + b1[0]) / 2, ...local.flatMap((r) => [r[0], r[2]])], [a1[0], b1[0]]);
  const ys = gridLines([a1[1], b1[1], (a1[1] + b1[1]) / 2, ...local.flatMap((r) => [r[1], r[3]])], [a1[1], b1[1]]);
  const ix = (x) => xs.indexOf(round2(x));
  const iy = (y) => ys.indexOf(round2(y));
  const start = [ix(a1[0]), iy(a1[1])];
  const goal = [ix(b1[0]), iy(b1[1])];
  if (start.includes(-1) || goal.includes(-1)) return null;
  const free = (i, j) => !local.some((r) => insideOpen(r, [xs[i], ys[j]]));
  const passable = (i, j, k, l) => !local.some((r) => segmentCrossesRect([xs[i], ys[j]], [xs[k], ys[l]], r));
  // States: grid point × the direction arrived in (0 n, 1 e, 2 s, 3 w).
  const dirIndex = (v) => (v[1] > 0 ? 0 : v[0] > 0 ? 1 : v[1] < 0 ? 2 : 3);
  const steps = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const W = xs.length;
  const H = ys.length;
  const id = (i, j, d) => ((j * W) + i) * 4 + d;
  const dist = new Float64Array(W * H * 4).fill(Infinity);
  const prev = new Int32Array(W * H * 4).fill(-1);
  const heap = [];
  const push = (cost, state) => {
    heap.push([cost, state]);
    let n = heap.length - 1;
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (heap[parent][0] < heap[n][0] || (heap[parent][0] === heap[n][0] && heap[parent][1] <= heap[n][1])) break;
      [heap[parent], heap[n]] = [heap[n], heap[parent]];
      n = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        const less = (p, q) => heap[p][0] < heap[q][0] || (heap[p][0] === heap[q][0] && heap[p][1] < heap[q][1]);
        if (l < heap.length && less(l, m)) m = l;
        if (r < heap.length && less(r, m)) m = r;
        if (m === n) break;
        [heap[m], heap[n]] = [heap[n], heap[m]];
        n = m;
      }
    }
    return top;
  };
  const first = id(start[0], start[1], dirIndex(va));
  dist[first] = 0;
  push(0, first);
  // Arriving at b1 heading the way the stub then runs into b (against vb).
  const wantArrive = dirIndex([-vb[0], -vb[1]]);
  let best = -1;
  let bestCost = Infinity;
  let budget = W * H * 16;
  while (heap.length && budget > 0) {
    budget -= 1;
    const [cost, state] = pop();
    if (cost > dist[state] || cost >= bestCost) continue;
    const d = state % 4;
    const cell = (state - d) / 4;
    const i = cell % W;
    const j = (cell - i) / W;
    if (i === goal[0] && j === goal[1]) {
      // Arriving head-on to the way in would run back along the last stretch
      // into the head: not an arrival.
      if (d === (wantArrive + 2) % 4) continue;
      const total = cost + (d === wantArrive ? 0 : TURN_COST);
      if (total < bestCost) { bestCost = total; best = state; }
      continue;
    }
    steps.forEach(([si, sj], nd) => {
      // Never straight back the way it came.
      if (nd === (d + 2) % 4) return;
      const k = i + si;
      const l = j + sj;
      if (k < 0 || l < 0 || k >= W || l >= H) return;
      if (!free(k, l) || !passable(i, j, k, l)) return;
      const step = Math.abs(xs[k] - xs[i]) + Math.abs(ys[l] - ys[j]);
      const next = id(k, l, nd);
      const nextCost = cost + step + (nd === d ? 0 : TURN_COST);
      if (nextCost < dist[next]) {
        dist[next] = nextCost;
        prev[next] = state;
        push(nextCost, next);
      }
    });
  }
  if (best < 0) return null;
  const cells = [];
  for (let state = best; state >= 0; state = prev[state]) {
    const cell = (state - (state % 4)) / 4;
    const i = cell % W;
    cells.push([xs[i], ys[(cell - i) / W]]);
  }
  cells.reverse();
  return simplifyPath([a, a1, ...cells, b1, b]);
}

// ── Scoring a pair of sides ───────────────────────────────────────────────
function scoreRoute(points, obstacles, own) {
  // A route back through one of its own boxes (out of the right side to a
  // box on the left) crosses that box, which is what makes it lose.
  const inner = betweenStubs(points);
  return pathLength(points) + TURN_COST * pathTurns(points)
    + CROSS_COST * pathCrossings(inner, obstacles)
    + CROSS_COST * pathCrossings(inner, own);
}

// ── All of a page's connectors at once ─────────────────────────────────────
//
// `entries` is [{ id, shape }], `nodes` a Map of what can be tied to (src/
// documents/pdf-connectors.js, diagramNodes): { id, rect, poly, z }. Answers a
// Map of id → the shape with its ends, exits and corners where they go now.
// A shape with no ties, or ties to nothing on the page, comes back as it was.
export function layoutConnectors(entries, nodes) {
  const out = new Map();
  const rects = [...nodes.values()].map((node) => ({ id: node.id, rect: inflateRect(node.rect, ROUTE_CLEARANCE) }));
  const items = [];
  [...entries].sort((m, n) => (m.id < n.id ? -1 : m.id > n.id ? 1 : 0)).forEach(({ id, shape }) => {
    const s = normalizeShape(shape);
    if (!s || (s.type !== "line" && s.type !== "arrow") || !s.ends) { out.set(id, s); return; }
    const found = s.ends.map((end) => (end ? nodes.get(end.id) || null : null));
    if (!found.some(Boolean)) { out.set(id, s); return; }
    items.push({ id, s, found });
  });

  // 1. Sides.
  items.forEach((item) => {
    const { s, found } = item;
    const routed = Boolean(s.route);
    item.sides = [0, 1].map((i) => {
      if (!found[i]) return null;
      const side = s.ends[i].side;
      if (side !== "auto") return side;
      return routed ? undefined : "float";
    });
    if (!item.sides.includes(undefined)) return;
    const candidates = (i) => {
      if (item.sides[i] !== undefined) return [item.sides[i]];
      return SIDE_ORDER;
    };
    const obstacles = rects.filter((r) => !found.some((node) => node?.id === r.id)).map((r) => r.rect);
    const own = found.filter(Boolean).map((node) => node.rect);
    let best = null;
    candidates(0).forEach((sa) => {
      candidates(1).forEach((sb) => {
        const a = sa ? sidePort(found[0], sa) : s.p[0];
        const b = sb ? sidePort(found[1], sb) : s.p[1];
        const guess = freeExits(a, b);
        const da = sa || guess[0];
        const db = sb || guess[1];
        const path = elbowPath(a, da, b, db);
        let cost = scoreRoute(path, obstacles, own);
        // The sides it left by last time, kept unless another is clearly
        // better — see the header.
        if (s.exits && (s.exits[0] || null) === sa && (s.exits[1] || null) === sb) cost *= KEEP_SIDE;
        if (!best || cost < best.cost - 1e-9) best = { cost, sides: [sa, sb] };
      });
    });
    item.sides = best.sides;
  });

  // 2. Ports: each side's ends, spread along it in the order of where they go.
  const bySide = new Map();
  items.forEach((item) => {
    item.offsets = [0, 0];
    [0, 1].forEach((i) => {
      const side = item.sides[i];
      if (!item.found[i] || !SIDE_VECTORS[side]) return;
      // Pinned to its spot: not one of the ends the side is shared out between.
      if (Number.isFinite(item.s.ends[i]?.at)) return;
      const key = `${item.found[i].id}|${side}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push({ item, i, side, node: item.found[i] });
    });
  });
  bySide.forEach((ends) => {
    if (ends.length < 2) return;
    const { side, node } = ends[0];
    const along = side === "n" || side === "s" ? 0 : 1;
    const towards = ({ item, i }) => {
      const other = item.found[1 - i];
      return other ? polygonCentre(other.poly) : item.s.p[1 - i];
    };
    ends.sort((m, n) => (towards(m)[along] - towards(n)[along]) || (m.item.id < n.item.id ? -1 : m.item.id > n.item.id ? 1 : m.i - n.i));
    const span = sideSpan(node, side);
    ends.forEach((end, k) => {
      end.item.offsets[end.i] = ((k + 1) / (ends.length + 1) - 0.5) * span;
    });
  });

  // 3. The ends, and the way between them.
  items.forEach((item) => {
    const { s, found, sides, offsets } = item;
    const p = s.p.map((point) => point.slice());
    const exits = [null, null];
    const centreOf = (i) => (found[i] ? polygonCentre(found[i].poly) : s.p[i]);
    [0, 1].forEach((i) => {
      const node = found[i];
      if (!node) return;
      if (sides[i] === "float") {
        const centre = polygonCentre(node.poly);
        const edge = polygonPerimeterPoint(node.poly, centreOf(1 - i));
        const len = Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) || 1;
        p[i] = [edge[0] + ((edge[0] - centre[0]) / len) * CONNECTOR_END_GAP, edge[1] + ((edge[1] - centre[1]) / len) * CONNECTOR_END_GAP];
        return;
      }
      const at = s.ends[i]?.at;
      p[i] = sidePort(node, sides[i], Number.isFinite(at) ? atOffset(node, sides[i], at) : offsets[i]);
      exits[i] = sides[i];
    });
    p[0] = roundPoint(p[0]);
    p[1] = roundPoint(p[1]);
    // A bend the reader set follows the ends that moved, by how far they
    // moved on average — it stays where it was on the line, not on the page.
    if (s.p[2]) {
      const dx = ((p[0][0] - s.p[0][0]) + (p[1][0] - s.p[1][0])) / 2;
      const dy = ((p[0][1] - s.p[0][1]) + (p[1][1] - s.p[1][1])) / 2;
      p[2] = roundPoint([s.p[2][0] + dx, s.p[2][1] + dy]);
    }
    const next = { ...s, p };
    delete next.exits;
    delete next.via;
    if (s.route && exits.some(Boolean)) next.exits = exits;
    if (s.route === "elbow" && !p[2]) {
      const guess = freeExits(p[0], p[1]);
      const da = exits[0] || guess[0];
      const db = exits[1] || guess[1];
      const route = orthogonalRoute(p[0], da, p[1], db, rects.map((r) => r.rect));
      if (route && route.length > 2) next.via = route.slice(1, -1).map(roundPoint);
    }
    out.set(item.id, normalizeShape(next));
  });
  return out;
}
