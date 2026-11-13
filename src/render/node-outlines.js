// The outline of a box on a page, as geometry and nothing else.
//
// "Use blocks, connect the blocks — like draw.io." A diagram is boxes of
// different SHAPES joined by lines, and the shape is what says what a box is: a
// diamond is a decision, a pill a start or an end, a cylinder a store, a
// parallelogram what goes in or comes out. A Block (src/documents/pdf-blocks.js)
// is the box — it already holds markdown, maths and pictures, which is more
// than any diagram tool's label does — so this is what lets one be a diamond.
//
// A LEAF. It imports nothing, so tools/diagram-geometry-check.mjs can drive
// every rule in it from Node, and so the three places an outline is needed all
// agree: the block's own SVG on the page (paintBlockOutline), the static copy a
// picture or an export is drawn from (the same function), and the connector
// that has to stop exactly where the outline is (src/documents/pdf-connectors.js).
//
// ── Two coordinate spaces ──────────────────────────────────────────────────
//
// LOCAL: a box `w` × `h` with its origin top-left and y DOWN — what an SVG
// inside the block is drawn in. The block's own size in points is used as the
// viewBox, so a stroke width given in points scales with the page like the
// type inside it does.
//
// PDF: a rect [x0, y0, x1, y1] in PDF user space with y UP, the space every
// record on a page is stored in.
//
// Every outline is defined once, in local space, and turned into the other.

export const NODE_OUTLINES = ["rect", "rounded", "pill", "ellipse", "diamond", "hexagon", "parallelogram", "cylinder", "document"];

export const NODE_OUTLINE_DEFAULT = "rect";

export const NODE_OUTLINE_LABELS = {
  rect: "Rectangle",
  rounded: "Rounded",
  pill: "Pill",
  ellipse: "Ellipse",
  diamond: "Diamond",
  hexagon: "Hexagon",
  parallelogram: "Parallelogram",
  cylinder: "Cylinder",
  document: "Document"
};

export function normalizeNodeOutline(kind) {
  return NODE_OUTLINES.includes(String(kind || "")) ? String(kind) : NODE_OUTLINE_DEFAULT;
}

// How many straight pieces a curve is drawn with. Enough that a 300pt ellipse
// does not look faceted at 3× zoom, few enough that a page of them is cheap.
const ARC_STEPS = 10;
const ELLIPSE_STEPS = 72;

function outlineArc(cx, cy, rx, ry, fromDeg, toDeg, steps = ARC_STEPS) {
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

// The corner radius of a rounded box, in the box's own units. A tenth of the
// short side, as draw.io's own rounded rectangle, and never more than 14pt —
// past that a box stops reading as rounded and starts reading as a pill.
export function roundedRadius(w, h) {
  return Math.min(14, Math.min(w, h) * 0.18);
}

// The sizes the slanted and curved outlines are built from, so the outline and
// the room it leaves for the words (outlineInsets) are worked out from the same
// numbers.
function hexagonCut(w, h) { return Math.min(w * 0.2, h * 0.5); }
function parallelogramSkew(w, h) { return Math.min(w * 0.2, h * 0.6); }
function cylinderRim(w, h) { return Math.min(h * 0.12, w * 0.25, 18); }
function documentWave(w, h) { return Math.min(h * 0.1, 10); }

// The outline as a closed polygon in LOCAL space (y down), clockwise on screen.
export function outlineLocalPoints(kind, w, h) {
  const k = normalizeNodeOutline(kind);
  const W = Math.max(0, Number(w) || 0);
  const H = Math.max(0, Number(h) || 0);
  if (k === "rounded" || k === "pill") {
    const r = k === "pill" ? Math.min(W, H) / 2 : roundedRadius(W, H);
    if (r <= 0) return [[0, 0], [W, 0], [W, H], [0, H]];
    return [
      ...outlineArc(W - r, r, r, r, -90, 0),
      ...outlineArc(W - r, H - r, r, r, 0, 90),
      ...outlineArc(r, H - r, r, r, 90, 180),
      ...outlineArc(r, r, r, r, 180, 270)
    ];
  }
  if (k === "ellipse") return outlineArc(W / 2, H / 2, W / 2, H / 2, 0, 360, ELLIPSE_STEPS).slice(0, -1);
  if (k === "diamond") return [[W / 2, 0], [W, H / 2], [W / 2, H], [0, H / 2]];
  if (k === "hexagon") {
    const c = hexagonCut(W, H);
    return [[c, 0], [W - c, 0], [W, H / 2], [W - c, H], [c, H], [0, H / 2]];
  }
  if (k === "parallelogram") {
    const s = parallelogramSkew(W, H);
    return [[s, 0], [W, 0], [W - s, H], [0, H]];
  }
  if (k === "cylinder") {
    const ry = cylinderRim(W, H);
    // The silhouette: the far half of the top rim, down the right side, the near
    // half of the bottom rim, up the left. The near half of the top rim is a
    // line drawn INSIDE it (outlineLocalDecorations), not part of the edge.
    return [
      ...outlineArc(W / 2, ry, W / 2, ry, 180, 360, ARC_STEPS * 2),
      ...outlineArc(W / 2, H - ry, W / 2, ry, 0, 180, ARC_STEPS * 2)
    ];
  }
  if (k === "document") {
    const a = documentWave(W, H);
    const wave = [];
    const steps = ARC_STEPS * 2;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      wave.push([W * (1 - t), H - a + a * Math.sin(2 * Math.PI * t)]);
    }
    return [[0, 0], [W, 0], ...wave];
  }
  return [[0, 0], [W, 0], [W, H], [0, H]];
}

// Lines drawn inside an outline that are not its edge: a cylinder's near rim.
// Open polylines, LOCAL space.
export function outlineLocalDecorations(kind, w, h) {
  if (normalizeNodeOutline(kind) !== "cylinder") return [];
  const W = Math.max(0, Number(w) || 0);
  const H = Math.max(0, Number(h) || 0);
  const ry = cylinderRim(W, H);
  return [outlineArc(W / 2, ry, W / 2, ry, 180, 0, ARC_STEPS * 2)];
}

// Points onto an SVG path, closed or not.
function pathData(points, closed) {
  if (!points.length) return "";
  const body = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
  return closed ? `${body}Z` : body;
}

// The SVG path of an outline in a w × h box, drawn `inset` in from the edge —
// half the stroke's width, so a thick border stays inside a block that clips
// its overflow. Returns { edge, marks }: the closed outline and the open lines
// inside it.
export function outlineSvgPaths(kind, w, h, inset = 0) {
  const pad = Math.max(0, Math.min(Number(inset) || 0, Math.min(w, h) / 2 - 0.5));
  const iw = Math.max(0, w - pad * 2);
  const ih = Math.max(0, h - pad * 2);
  const shift = ([x, y]) => [x + pad, y + pad];
  return {
    edge: pathData(outlineLocalPoints(kind, iw, ih).map(shift), true),
    marks: outlineLocalDecorations(kind, iw, ih).map((line) => pathData(line.map(shift), false)).join("")
  };
}

// How much of the box the words must keep clear of, per side, in the box's own
// units — so a diamond's text stays inside the diamond rather than spilling over
// its corners. The largest box that fits each outline, near enough: a diamond's
// is half its width and height, centred; an ellipse's leaves (1 − 1/√2)/2 of
// each side.
export function outlineInsets(kind, w, h) {
  const k = normalizeNodeOutline(kind);
  const W = Math.max(0, Number(w) || 0);
  const H = Math.max(0, Number(h) || 0);
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  if (k === "ellipse") {
    const x = W * 0.146;
    const y = H * 0.146;
    return { top: y, right: x, bottom: y, left: x };
  }
  if (k === "diamond") return { top: H * 0.25, right: W * 0.25, bottom: H * 0.25, left: W * 0.25 };
  if (k === "pill") {
    const x = Math.min(W * 0.25, Math.min(W, H) * 0.3);
    return { ...none, left: x, right: x };
  }
  if (k === "hexagon") {
    const x = hexagonCut(W, H) * 0.75;
    return { ...none, left: x, right: x };
  }
  if (k === "parallelogram") {
    const x = parallelogramSkew(W, H) * 0.75;
    return { ...none, left: x, right: x };
  }
  if (k === "cylinder") {
    const ry = cylinderRim(W, H);
    return { ...none, top: ry * 2, bottom: ry };
  }
  if (k === "document") return { ...none, bottom: documentWave(W, H) * 2 };
  return none;
}

// ── In PDF space ──────────────────────────────────────────────────────────

export function rectFromBox(x, y, w, h) {
  return [x, y, x + w, y + h];
}

// The outline of a box placed at `rect` (PDF space, y up), as a closed polygon.
export function outlinePolygon(kind, rect) {
  const [x0, y0, x1, y1] = rect;
  return outlineLocalPoints(kind, x1 - x0, y1 - y0).map(([lx, ly]) => [x0 + lx, y1 - ly]);
}

export function polygonCentre(points) {
  if (!points?.length) return [0, 0];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  points.forEach(([x, y]) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  });
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

// Where a ray from `from` through `toward` first leaves the closed polygon
// `points`, or null when it never crosses an edge (a degenerate polygon, or a
// `from` outside it looking away). `from` is normally the middle of the shape,
// which is inside every outline here.
export function polygonRayExit(points, from, toward) {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  if (Math.hypot(dx, dy) < 1e-9 || !points?.length) return null;
  let best = null;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    // from + t·d = a + u·e
    const t = ((a[0] - from[0]) * ey - (a[1] - from[1]) * ex) / denom;
    const u = ((a[0] - from[0]) * dy - (a[1] - from[1]) * dx) / denom;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      // The FARTHEST crossing, not the nearest: a cylinder's and a document's
      // edges are not quite convex, and the point a line should stop at is
      // where it meets the shape's outside, not a dip in it.
      if (!best || t > best.t) best = { t, point: [from[0] + dx * t, from[1] + dy * t] };
    }
  }
  return best ? best.point : null;
}

// The four sides a line can leave a box by, as a direction in PDF space.
export const NODE_SIDES = ["n", "e", "s", "w"];

export const SIDE_VECTORS = Object.freeze({ n: [0, 1], e: [1, 0], s: [0, -1], w: [-1, 0] });

export function oppositeSide(side) {
  return { n: "s", s: "n", e: "w", w: "e" }[side] || null;
}

// Where on a polygon's outline its `side` is: straight out from the middle of
// the box that way. On a diamond the north side is its top corner; on an
// ellipse it is the top of the curve; on a box, the middle of the top edge.
export function polygonSidePoint(points, side) {
  const v = SIDE_VECTORS[side];
  if (!v) return null;
  const centre = polygonCentre(points);
  return polygonRayExit(points, centre, [centre[0] + v[0], centre[1] + v[1]]) || centre;
}

// ...and where a straight line toward `toward` leaves it.
export function polygonPerimeterPoint(points, toward) {
  const centre = polygonCentre(points);
  return polygonRayExit(points, centre, toward) || centre;
}

// Which side of a box faces a point: the one whose direction is closest to the
// direction from the middle to it, weighed by the box's own shape — a wide box
// is left by its ends only for a point well off to the side.
export function sideFacing(rect, point) {
  const [x0, y0, x1, y1] = rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = Math.max(1e-6, (x1 - x0) / 2);
  const hh = Math.max(1e-6, (y1 - y0) / 2);
  const nx = (point[0] - cx) / hw;
  const ny = (point[1] - cy) / hh;
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? "e" : "w";
  return ny >= 0 ? "n" : "s";
}

// Is a point inside the closed polygon?
export function pointInOutline(points, px, py) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// The shortest distance from a point to a polygon's outline.
export function distanceToOutline(points, px, py) {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)));
  }
  return best;
}
