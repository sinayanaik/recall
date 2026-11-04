// Shapes on a page: lines, arrows, rectangles, ellipses, callouts, typed text
// and sticky notes — as geometry, and nothing else.
//
// A LEAF. It imports nothing, so a pure-Node check (tools/annot-shapes-check.mjs)
// can drive every rule in it, and so the four places a shape is drawn — the live
// page (src/documents/pdf-shapes.js), a picture of the page (pdf-region-marks.js),
// the printed export (pdf-export.js) and the file saved with its annotations
// (pdf-annot-export.js) — all draw the SAME shape. They differ only in where the
// points go: each hands its own point transform to shapePrimitives' output.
//
// ── What a shape is ────────────────────────────────────────────────────────
//
// A record in meta.pdfHighlights with `kind: "shape"` and a `shape` object:
//
//   type      line | arrow | rect | ellipse | callout | text | sticky
//   p         points in PDF user space (y UP, as the file is):
//               line, arrow           [start, end]
//               rect, ellipse, text   [corner, opposite corner]
//               callout               [box corner, opposite corner, target, knee?]
//               sticky                [top-left corner of the icon]
//   stroke    #rrggbb      the line's colour (and a sticky's, and text's default)
//   width     points       the line's width
//   opacity   0.1 … 1      the line's
//   dash      solid | dash | dot
//   fill      #rrggbb | null, drawn at fillOpacity
//   heads     [start, end] each none | open | filled | dot | bar
//   text      callout and text: what was typed
//   font      { size (pt), bold, align: left|center|right, color }
//
// It is a live object and not ink: dragging its end moves its end, and a
// restyle changes the one field. That is the whole reason it is not a stroke.

export const SHAPE_TYPES = ["line", "arrow", "rect", "ellipse", "callout", "text", "sticky"];

export const SHAPE_LABELS = {
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  ellipse: "Ellipse",
  callout: "Callout",
  text: "Text",
  sticky: "Sticky note"
};

export const SHAPE_HEADS = ["none", "open", "filled", "dot", "bar"];
export const SHAPE_DASHES = ["solid", "dash", "dot"];
export const SHAPE_ALIGNS = ["left", "center", "right"];

export const SHAPE_WIDTH_RANGE = Object.freeze({ min: 0.3, max: 24 });
export const SHAPE_FONT_RANGE = Object.freeze({ min: 5, max: 96 });
export const SHAPE_FILL_OPACITY_DEFAULT = 0.25;

// A sticky note's icon, in points: big enough to find on a page, small enough
// to sit in a margin.
export const STICKY_SIZE = 20;

// A text box made with a tap rather than a drag, in points.
export const TEXT_BOX_DEFAULT = Object.freeze({ width: 160, height: 28 });

// Below this a drag made nothing: a tap, or a hand that slipped.
export const SHAPE_MIN_DRAG = 3;

export const SHAPE_DEFAULTS = Object.freeze({
  stroke: "#dc2626",
  width: 1.6,
  opacity: 1,
  dash: "solid",
  fill: null,
  fillOpacity: SHAPE_FILL_OPACITY_DEFAULT,
  heads: ["none", "none"],
  text: "",
  font: Object.freeze({ size: 11, bold: false, align: "left", color: null })
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeShapeHex(hex) {
  const text = String(hex || "").trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(text);
  return long ? `#${long[1]}` : null;
}

function shapePoint(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const x = Number(point[0]);
  const y = Number(point[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x * 100) / 100, Math.round(y * 100) / 100] : null;
}

// How many points each type carries, at least and at most.
const SHAPE_POINT_COUNTS = {
  line: [2, 2], arrow: [2, 2], rect: [2, 2], ellipse: [2, 2], text: [2, 2], callout: [3, 4], sticky: [1, 1]
};

// A shape as this build can draw it, or null for one it cannot. Every field is
// clamped to what the controls can set, so a record from a newer build or a
// hand-edited backup draws as something sensible rather than as nothing.
export function normalizeShape(shape) {
  if (!shape || typeof shape !== "object") return null;
  const type = SHAPE_TYPES.includes(shape.type) ? shape.type : null;
  if (!type) return null;
  const [least, most] = SHAPE_POINT_COUNTS[type];
  const points = (Array.isArray(shape.p) ? shape.p : []).map(shapePoint);
  if (points.length < least || points.some((point) => !point)) return null;
  const heads = Array.isArray(shape.heads) ? shape.heads : [];
  const font = shape.font && typeof shape.font === "object" ? shape.font : {};
  const fill = normalizeShapeHex(shape.fill);
  return {
    type,
    p: points.slice(0, most),
    stroke: normalizeShapeHex(shape.stroke) || SHAPE_DEFAULTS.stroke,
    width: clampNumber(shape.width, SHAPE_WIDTH_RANGE.min, SHAPE_WIDTH_RANGE.max, SHAPE_DEFAULTS.width),
    opacity: Math.round(clampNumber(shape.opacity, 0.1, 1, 1) * 100) / 100,
    dash: SHAPE_DASHES.includes(shape.dash) ? shape.dash : "solid",
    fill,
    fillOpacity: Math.round(clampNumber(shape.fillOpacity, 0.05, 1, SHAPE_FILL_OPACITY_DEFAULT) * 100) / 100,
    heads: [0, 1].map((i) => (SHAPE_HEADS.includes(heads[i]) ? heads[i] : "none")),
    text: typeof shape.text === "string" ? shape.text.slice(0, 20000) : "",
    font: {
      size: clampNumber(font.size, SHAPE_FONT_RANGE.min, SHAPE_FONT_RANGE.max, SHAPE_DEFAULTS.font.size),
      bold: font.bold === true,
      align: SHAPE_ALIGNS.includes(font.align) ? font.align : "left",
      color: normalizeShapeHex(font.color)
    }
  };
}

// The defaults a NEW shape of this type starts from, before the reader's own
// settings are laid over them: an arrow has a head, a callout a border and a
// pale fill, free text no border at all.
export function shapeTypeDefaults(type) {
  if (type === "arrow") return { heads: ["none", "filled"] };
  if (type === "callout") return { heads: ["none", "filled"], fill: "#fffbe6", fillOpacity: 1 };
  if (type === "text") return { width: 0.3, heads: ["none", "none"] };
  if (type === "sticky") return { stroke: "#e0b400" };
  return {};
}

// Does this type draw a border round a box? Free text only does when it has a
// fill to put one round; a callout always does.
export function shapeHasBorder(shape) {
  if (shape.type === "text") return false;
  return true;
}

// ── Boxes ─────────────────────────────────────────────────────────────────

// [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1, in the space the points are in.
export function rectFromPoints(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// The box of a callout or text shape, or a sticky's icon, in PDF space.
export function shapeTextRect(shape) {
  if (shape.type === "sticky") {
    const [x, y] = shape.p[0];
    return [x, y - STICKY_SIZE, x + STICKY_SIZE, y];
  }
  return rectFromPoints(shape.p[0], shape.p[1]);
}

// How far an arrowhead reaches back from its tip, in points.
export function arrowHeadLength(width) {
  return Math.max(7.5, width * 4.2);
}

// Everything the shape covers, padded by half its line and its heads, in PDF
// space — what the record's `quads` carry, so a thumbnail can be cropped to it
// and the badge can sit on its corner.
export function shapeBounds(shape) {
  const s = normalizeShape(shape);
  if (!s) return null;
  const xs = [];
  const ys = [];
  s.p.forEach(([x, y]) => { xs.push(x); ys.push(y); });
  if (s.type === "sticky") {
    const [x0, y0, x1, y1] = shapeTextRect(s);
    xs.push(x0, x1); ys.push(y0, y1);
  }
  const pad = s.width / 2 + (s.heads.some((h) => h !== "none") ? arrowHeadLength(s.width) * 0.6 : 0) + 1;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

// ── Primitives: what any renderer draws ───────────────────────────────────
//
// A flat list, in PDF space:
//   { kind: "poly", pts: [[x, y], …], closed, stroke, width, opacity, dash,
//     fill, fillOpacity }
//   { kind: "text", rect: [x0, y0, x1, y1], text, size, bold, align, color }
//   { kind: "sticky", rect, color }      the note icon, drawn by each renderer
//
// Everything that is a curve is sampled into a polyline here, once, so that a
// rotated page (whose transform turns an ellipse into some other ellipse) and a
// PDF content stream (which has no ellipse operator) need nothing special.

const ELLIPSE_SAMPLES = 72;

function ellipsePoints(rect) {
  const [x0, y0, x1, y1] = rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const pts = [];
  for (let i = 0; i < ELLIPSE_SAMPLES; i += 1) {
    const t = (i / ELLIPSE_SAMPLES) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

function circlePoints(cx, cy, r, samples = 20) {
  const pts = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i / samples) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return pts;
}

// The head at `tip`, pointing away from `from`.
export function arrowHeadPrimitives(tip, from, style, line) {
  if (!style || style === "none") return [];
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = arrowHeadLength(line.width);
  const base = { stroke: line.stroke, width: line.width, opacity: line.opacity, dash: "solid", fill: null, fillOpacity: 1 };
  if (style === "dot") {
    return [{ kind: "poly", ...base, pts: circlePoints(tip[0], tip[1], size * 0.32), closed: true, fill: line.stroke, fillOpacity: line.opacity }];
  }
  if (style === "bar") {
    const half = size * 0.45;
    return [{ kind: "poly", ...base, pts: [[tip[0] - uy * half, tip[1] + ux * half], [tip[0] + uy * half, tip[1] - ux * half]], closed: false }];
  }
  const spread = style === "open" ? 0.5 : 0.42;
  const backX = tip[0] - ux * size;
  const backY = tip[1] - uy * size;
  const wing = size * spread;
  const left = [backX - uy * wing, backY + ux * wing];
  const right = [backX + uy * wing, backY - ux * wing];
  if (style === "open") return [{ kind: "poly", ...base, pts: [left, tip, right], closed: false }];
  return [{ kind: "poly", ...base, pts: [left, tip, right], closed: true, fill: line.stroke, fillOpacity: line.opacity }];
}

// A filled head covers the last stretch of the shaft; ending the shaft at the
// head's base keeps a thick line from poking out past a sharp tip.
function shaftEnd(tip, from, style, width) {
  if (style !== "filled") return tip;
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const back = Math.min(len * 0.5, arrowHeadLength(width) * 0.8);
  return [tip[0] - (dx / len) * back, tip[1] - (dy / len) * back];
}

// Where a callout's leader leaves its box: the point on the box's edge nearest
// the knee (or the target, with no knee).
export function calloutLeaderStart(rect, toward) {
  const [x0, y0, x1, y1] = rect;
  const x = Math.min(x1, Math.max(x0, toward[0]));
  const y = Math.min(y1, Math.max(y0, toward[1]));
  if (x > x0 && x < x1 && y > y0 && y < y1) {
    // Inside the box: out through the nearest edge.
    const d = [x - x0, x1 - x, y - y0, y1 - y];
    const i = d.indexOf(Math.min(...d));
    return [[x0, y], [x1, y], [x, y0], [x, y1]][i];
  }
  return [x, y];
}

export function shapePrimitives(shape) {
  const s = normalizeShape(shape);
  if (!s) return [];
  const line = { stroke: s.stroke, width: s.width, opacity: s.opacity, dash: s.dash };
  const out = [];
  if (s.type === "line" || s.type === "arrow") {
    const [a, b] = s.p;
    const start = shaftEnd(a, b, s.heads[0], s.width);
    const end = shaftEnd(b, a, s.heads[1], s.width);
    out.push({ kind: "poly", ...line, pts: [start, end], closed: false, fill: null, fillOpacity: 1 });
    out.push(...arrowHeadPrimitives(a, b, s.heads[0], line));
    out.push(...arrowHeadPrimitives(b, a, s.heads[1], line));
    return out;
  }
  if (s.type === "rect" || s.type === "ellipse") {
    const rect = rectFromPoints(s.p[0], s.p[1]);
    const pts = s.type === "rect"
      ? [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]]
      : ellipsePoints(rect);
    out.push({ kind: "poly", ...line, pts, closed: true, fill: s.fill, fillOpacity: s.fillOpacity });
    return out;
  }
  if (s.type === "sticky") {
    out.push({ kind: "sticky", rect: shapeTextRect(s), color: s.stroke });
    return out;
  }
  // callout and text: the leader first, so the box is drawn over its root.
  const rect = shapeTextRect(s);
  if (s.type === "callout") {
    const target = s.p[2];
    const knee = s.p[3] || null;
    const start = calloutLeaderStart(rect, knee || target);
    const pts = knee ? [start, knee, target] : [start, target];
    const prev = pts[pts.length - 2];
    const end = shaftEnd(target, prev, s.heads[1], s.width);
    out.push({ kind: "poly", ...line, pts: [...pts.slice(0, -1), end], closed: false, fill: null, fillOpacity: 1 });
    out.push(...arrowHeadPrimitives(target, prev, s.heads[1], line));
  }
  const border = shapeHasBorder(s);
  if (border || s.fill) {
    out.push({
      kind: "poly", ...line,
      width: border ? s.width : 0,
      pts: [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]],
      closed: true, fill: s.fill, fillOpacity: s.fillOpacity
    });
  }
  out.push({
    kind: "text", rect, text: s.text, size: s.font.size, bold: s.font.bold, align: s.font.align,
    color: s.font.color || (s.type === "text" ? s.stroke : "#16181d")
  });
  return out;
}

// The padding inside a text box, in points, on every side.
export const SHAPE_TEXT_PAD = 4;

// A sticky note's icon as polys, for renderers with no icon of their own: the
// square with its corner folded, and three lines of "writing".
export function stickyIconPolys(rect, color) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const fold = w * 0.3;
  const base = { stroke: "#5b4a00", width: Math.max(0.6, w * 0.04), opacity: 1, dash: "solid", fillOpacity: 1 };
  const polys = [
    { kind: "poly", ...base, closed: true, fill: color, pts: [[x0, y0], [x1, y0], [x1, y1 - fold], [x1 - fold, y1], [x0, y1]] },
    { kind: "poly", ...base, closed: false, fill: null, pts: [[x1 - fold, y1], [x1 - fold, y1 - fold], [x1, y1 - fold]] }
  ];
  for (let i = 0; i < 3; i += 1) {
    const y = y1 - h * (0.42 + i * 0.18);
    polys.push({ kind: "poly", ...base, closed: false, fill: null, pts: [[x0 + w * 0.18, y], [x1 - w * (i === 0 ? 0.42 : 0.18), y]] });
  }
  return polys;
}

// ── Hit-testing, in PDF space ──────────────────────────────────────────────

export function distanceToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function distanceToPoly(px, py, pts, closed) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i += 1) best = Math.min(best, distanceToSegment(px, py, pts[i], pts[i + 1]));
  if (closed && pts.length > 2) best = Math.min(best, distanceToSegment(px, py, pts[pts.length - 1], pts[0]));
  return best;
}

function insideRect(px, py, rect) {
  return px >= rect[0] && px <= rect[2] && py >= rect[1] && py <= rect[3];
}

// Is (px, py) on the shape, to within `slack` points? An outline is hit on its
// line; its inside only when it is filled — so a box drawn round a paragraph
// does not swallow every tap meant for the words in it. A text box, a callout's
// box and a sticky note are hit anywhere inside: they are things.
export function shapeHitsPoint(shape, px, py, slack = 4) {
  const s = normalizeShape(shape);
  if (!s) return false;
  const reach = slack + s.width / 2;
  if (s.type === "sticky" || s.type === "text") return insideRect(px, py, padRect(shapeTextRect(s), slack));
  if (s.type === "callout") {
    if (insideRect(px, py, padRect(shapeTextRect(s), slack))) return true;
  }
  return shapePrimitives(s).some((prim) => {
    if (prim.kind !== "poly") return false;
    if (prim.closed && prim.fill && pointInPolygon(px, py, prim.pts)) return true;
    return distanceToPoly(px, py, prim.pts, prim.closed) <= reach;
  });
}

function padRect(rect, by) {
  return [rect[0] - by, rect[1] - by, rect[2] + by, rect[3] + by];
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Does the shape touch the segment a→b (an eraser's path), in PDF space?
export function shapeCrossesSegment(shape, a, b, slack = 2) {
  const s = normalizeShape(shape);
  if (!s) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (shapeHitsPoint(s, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, slack)) return true;
  }
  return false;
}

// ── Handles: the points a selected shape can be dragged by ────────────────
//
// [{ id, x, y }] in PDF space. A line or an arrow has its two ends; a box has its
// four corners and four edge midpoints; a callout has its box's corners, its
// target and its knee (a midpoint of the leader when there is none, which
// creates one when dragged); a sticky note has none (it is moved whole).
export function shapeHandles(shape) {
  const s = normalizeShape(shape);
  if (!s) return [];
  if (s.type === "line" || s.type === "arrow") return s.p.map(([x, y], i) => ({ id: `p${i}`, x, y }));
  if (s.type === "sticky") return [];
  const [x0, y0, x1, y1] = shapeTextRect(s);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const box = [
    { id: "nw", x: x0, y: y1 }, { id: "n", x: mx, y: y1 }, { id: "ne", x: x1, y: y1 },
    { id: "e", x: x1, y: my }, { id: "se", x: x1, y: y0 }, { id: "s", x: mx, y: y0 },
    { id: "sw", x: x0, y: y0 }, { id: "w", x: x0, y: my }
  ];
  if (s.type !== "callout") return box;
  const target = s.p[2];
  const knee = s.p[3] || null;
  const start = calloutLeaderStart([x0, y0, x1, y1], knee || target);
  const kneeAt = knee || [(start[0] + target[0]) / 2, (start[1] + target[1]) / 2];
  return [...box, { id: "target", x: target[0], y: target[1] }, { id: "knee", x: kneeAt[0], y: kneeAt[1] }];
}

// The shape with one handle moved to (x, y), in PDF space.
export function moveShapeHandle(shape, handleId, x, y) {
  const s = normalizeShape(shape);
  if (!s) return shape;
  const p = s.p.map((point) => point.slice());
  if (/^p\d$/.test(handleId)) {
    const i = Number(handleId.slice(1));
    if (p[i]) p[i] = [x, y];
    return { ...s, p };
  }
  if (handleId === "target" && s.type === "callout") { p[2] = [x, y]; return { ...s, p }; }
  if (handleId === "knee" && s.type === "callout") { p[3] = [x, y]; return { ...s, p }; }
  let [x0, y0, x1, y1] = shapeTextRect(s);
  if (handleId.includes("w")) x0 = x;
  if (handleId.includes("e")) x1 = x;
  if (handleId.includes("s")) y0 = y;
  if (handleId.includes("n")) y1 = y;
  p[0] = [x0, y0];
  p[1] = [x1, y1];
  return { ...s, p };
}

// The shape moved by (dx, dy) points, every point with it.
export function translateShape(shape, dx, dy) {
  const s = normalizeShape(shape);
  if (!s) return shape;
  return { ...s, p: s.p.map(([x, y]) => [x + dx, y + dy]) };
}

// ── Drawing aids ──────────────────────────────────────────────────────────

// `to` moved so the line from `from` runs at a multiple of `stepDeg`.
export function snapShapeAngle(from, to, stepDeg = 15) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (!len) return to.slice();
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + Math.cos(angle) * len, from[1] + Math.sin(angle) * len];
}

// `to` moved so the box from `from` is a square (and an ellipse a circle).
export function snapShapeSquare(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * side, from[1] + Math.sign(dy || 1) * side];
}

// What a drag from `from` to `to` makes, for a type — or null when it was too
// short to mean anything. Points in PDF space; `snap` constrains it.
export function shapeFromDrag(type, from, to, { snap = false, base = {} } = {}) {
  let end = to;
  if (snap) end = (type === "line" || type === "arrow") ? snapShapeAngle(from, to) : snapShapeSquare(from, to);
  const far = Math.hypot(end[0] - from[0], end[1] - from[1]) >= SHAPE_MIN_DRAG;
  const merged = { ...SHAPE_DEFAULTS, ...shapeTypeDefaults(type), ...base, type };
  if (type === "sticky") return normalizeShape({ ...merged, p: [[from[0] - STICKY_SIZE / 2, from[1] + STICKY_SIZE / 2]] });
  if (type === "text") {
    const corner = far ? end : [from[0] + TEXT_BOX_DEFAULT.width, from[1] - TEXT_BOX_DEFAULT.height];
    return normalizeShape({ ...merged, p: [from, corner] });
  }
  if (!far) return null;
  if (type === "callout") {
    // Dragged FROM the thing pointed at TO where the words go: the box sits
    // past the end of the drag, on the side away from the target.
    const w = TEXT_BOX_DEFAULT.width;
    const h = TEXT_BOX_DEFAULT.height + 8;
    const leftward = end[0] < from[0];
    const below = end[1] < from[1];
    const bx0 = leftward ? end[0] - w : end[0];
    const by0 = below ? end[1] - h : end[1];
    return normalizeShape({ ...merged, p: [[bx0, by0], [bx0 + w, by0 + h], from] });
  }
  return normalizeShape({ ...merged, p: [from, end] });
}

// ── Into a coordinate space with y DOWN (a screen, a canvas) ──────────────
//
// `toPoint([x, y])` maps a PDF point to the target space. Dash lengths and
// widths are scaled by `scale` (target units per point).

export function shapeDashArray(dash, width, scale = 1) {
  const w = Math.max(width, 0.5) * scale;
  if (dash === "dash") return [w * 4, w * 2.6];
  if (dash === "dot") return [w * 0.01, w * 2.2];
  return [];
}

// The SVG path data for a poly, in target space.
export function polyPathData(prim, toPoint) {
  const pts = prim.pts.map(toPoint);
  if (!pts.length) return "";
  const body = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join("");
  return prim.closed ? `${body}Z` : body;
}

// Lines of text that fit `maxWidth`, measured by `measure(text) → width`. A
// typed line break always breaks; a word too long for the box is broken where
// it overflows rather than spilling out of it.
export function wrapShapeText(text, maxWidth, measure) {
  const lines = [];
  String(text || "").split("\n").forEach((paragraph) => {
    const words = paragraph.split(/(\s+)/);
    let line = "";
    words.forEach((word) => {
      const next = line + word;
      if (!line || measure(next) <= maxWidth) { line = next; return; }
      lines.push(line.trimEnd());
      line = word.trimStart();
      while (line && measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    });
    lines.push(line.trimEnd());
  });
  return lines;
}

// Every primitive onto a 2D canvas context. `toPoint` maps PDF → canvas pixels
// and `scale` is canvas pixels per point. Text is drawn with fillText, wrapped
// to its box; on a rotated page it is drawn upright in the box's screen
// rectangle, as the live page shows it.
export function paintShapeOnCanvas(ctx, shape, toPoint, scale = 1) {
  const prims = shapePrimitives(shape);
  const polys = [];
  prims.forEach((prim) => {
    if (prim.kind === "sticky") polys.push(...stickyIconPolys(prim.rect, prim.color));
    else polys.push(prim);
  });
  polys.forEach((prim) => {
    if (prim.kind === "text") { paintShapeText(ctx, prim, toPoint, scale); return; }
    const pts = prim.pts.map(toPoint);
    if (!pts.length) return;
    ctx.save();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (prim.closed) ctx.closePath();
    if (prim.fill) {
      ctx.globalAlpha = prim.fillOpacity;
      ctx.fillStyle = prim.fill;
      ctx.fill();
    }
    if (prim.width > 0) {
      ctx.globalAlpha = prim.opacity;
      ctx.strokeStyle = prim.stroke;
      ctx.lineWidth = prim.width * scale;
      ctx.lineJoin = "round";
      ctx.lineCap = prim.dash === "dot" ? "round" : "butt";
      ctx.setLineDash(shapeDashArray(prim.dash, prim.width, scale));
      ctx.stroke();
    }
    ctx.restore();
  });
}

function paintShapeText(ctx, prim, toPoint, scale) {
  if (!prim.text || typeof ctx.fillText !== "function") return;
  const a = toPoint([prim.rect[0], prim.rect[3]]);
  const b = toPoint([prim.rect[2], prim.rect[1]]);
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const width = Math.abs(b[0] - a[0]);
  const pad = SHAPE_TEXT_PAD * scale;
  const size = prim.size * scale;
  ctx.save();
  ctx.fillStyle = prim.color;
  ctx.font = `${prim.bold ? "700" : "400"} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textBaseline = "top";
  const lines = wrapShapeText(prim.text, Math.max(1, width - pad * 2), (t) => ctx.measureText(t).width);
  const lineHeight = size * 1.3;
  lines.forEach((text, i) => {
    let x = left + pad;
    if (prim.align === "center") { ctx.textAlign = "center"; x = left + width / 2; }
    else if (prim.align === "right") { ctx.textAlign = "right"; x = left + width - pad; }
    else ctx.textAlign = "left";
    ctx.fillText(text, x, top + pad + i * lineHeight);
  });
  ctx.restore();
}

// A word for the shape, for the Highlights pane and the mark's label.
export function shapeLabel(shape) {
  const s = normalizeShape(shape);
  if (!s) return "Shape";
  if ((s.type === "callout" || s.type === "text") && s.text.trim()) return s.text.trim();
  return SHAPE_LABELS[s.type];
}
