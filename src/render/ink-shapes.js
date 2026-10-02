// Holding still at the end of a stroke, and getting the shape you meant.
//
// A LEAF — it imports nothing, so a pure-Node check can drive every threshold
// in it without a browser. That matters more here than anywhere else in this
// feature: a straightener is all thresholds, and a threshold nothing tests is a
// number someone guessed.
//
// ── The rule this is built around ──────────────────────────────────────────
//
// A straightener that guesses wrong is worse than no straightener. Someone who
// draws a wobbling circle round a term and gets a circle is delighted; someone
// who writes the letter O and gets a circle has had their handwriting taken
// away, and will not trust the pen again. So every test here is a REFUSAL by
// default: a fit has to be good, not merely best, and fitInkShape returns null
// far more often than it returns a shape.
//
// The gesture guards the rest. This only ever runs on a stroke the nib has been
// holding still at the end of for INK_SHAPE_HOLD_MS — a deliberate act, not
// something that can happen mid-word.

// How long the nib must rest before a shape is offered. Long enough that it
// cannot happen during writing, short enough not to feel like waiting.
export const INK_SHAPE_HOLD_MS = 600;

// The residual a point may have from the fitted shape, as a fraction of the
// shape's own longest side. Six per cent lets a freehand circle be a circle and
// still refuses an oval scribble. Floored in model units so that a very small
// shape does not get an impossibly tight tolerance.
export const INK_SHAPE_TOLERANCE_RATIO = 0.06;
export const INK_SHAPE_TOLERANCE_MIN = 2;

// Below this the stroke has no shape worth finding. Set at 18 points — about
// 6mm — for one specific reason: at 12 a well-drawn letter O fits an ellipse,
// and turning someone's handwriting into a circle is the single worst thing
// this file could do. Handwriting on a paper runs 8-12 points tall, so this
// sits above it while leaving a deliberate ring round one symbol in an equation
// (which nobody draws smaller than about 20) still on offer.
//
// The hold gesture is the real guard — nobody finishes a letter and then rests
// the nib for 600ms — but a threshold that also refuses is worth having, because
// the cost of being wrong here is a reader who stops trusting the pen.
export const INK_SHAPE_MIN_SIZE = 18;

// A stroke whose ends are closer together than this fraction of its own length
// was meant to close. Below it, the stroke is open and only a line or an arrow
// is on offer.
export const INK_SHAPE_CLOSE_RATIO = 0.2;

// How many samples a fitted ellipse is emitted with. Enough that the quadratic
// smoothing in ink-paint.js has nothing to round off.
const INK_ELLIPSE_SAMPLES = 64;

// The head of an arrow, as a fraction of the shaft, and the angle it opens at.
const INK_ARROW_HEAD_RATIO = 0.18;
const INK_ARROW_HEAD_MAX = 24;
const INK_ARROW_SPREAD = 0.42;

function inkShapeMeanPressure(points) {
  let sum = 0;
  let count = 0;
  for (let i = 2; i < points.length; i += 3) { sum += points[i]; count += 1; }
  return count ? sum / count : 0.5;
}

function inkShapeBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 3) {
    if (points[i] < minX) minX = points[i];
    if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minY) minY = points[i + 1];
    if (points[i + 1] > maxY) maxY = points[i + 1];
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function inkShapeRun(coords, pressure) {
  const out = [];
  for (let i = 0; i + 1 < coords.length; i += 2) out.push(coords[i], coords[i + 1], pressure);
  return out;
}

// ── Line ───────────────────────────────────────────────────────────────────

// Least squares in whichever axis the stroke is longer in, so a vertical line
// is not a division by a near-zero slope. Returns the worst perpendicular
// residual and the two endpoints projected onto the fit.
function inkFitLine(points) {
  const count = Math.floor(points.length / 3);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < count; i += 1) { sx += points[i * 3]; sy += points[(i * 3) + 1]; }
  const mx = sx / count;
  const my = sy / count;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < count; i += 1) {
    const dx = points[i * 3] - mx;
    const dy = points[(i * 3) + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // The principal axis of the point cloud — the direction of least residual,
  // which is the right line whatever the stroke's orientation.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(angle);
  let uy = Math.sin(angle);
  // ...pointed the way the pen WENT. The axis above has no direction of its own —
  // atan2 of a doubled angle always lands it in the right half-plane — so `from`
  // and `to` below came out left-to-right whatever the hand did, and an arrow
  // drawn right-to-left, or upwards, got its head on the end it started from.
  // Orienting it from the first sample towards the last makes `to` the end the
  // stroke finished at, which is what the arrow, and the straightened
  // highlighter, both mean by it.
  const towardX = points[(count - 1) * 3] - points[0];
  const towardY = points[((count - 1) * 3) + 1] - points[1];
  if ((towardX * ux) + (towardY * uy) < 0) {
    ux = -ux;
    uy = -uy;
  }
  let worst = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const dx = points[i * 3] - mx;
    const dy = points[(i * 3) + 1] - my;
    const t = (dx * ux) + (dy * uy);
    const perp = Math.abs((dx * -uy) + (dy * ux));
    if (perp > worst) worst = perp;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  return {
    worst,
    from: [mx + (ux * minT), my + (uy * minT)],
    to: [mx + (ux * maxT), my + (uy * maxT)],
    ux,
    uy
  };
}

// ── Closed shapes ──────────────────────────────────────────────────────────

function inkRectResidual(points, box) {
  let worst = 0;
  for (let i = 0; i + 1 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    // Distance to the nearest of the four edges. A point well inside the box is
    // far from every edge, which is what disqualifies a filled-in scribble.
    const d = Math.min(
      Math.abs(x - box.minX), Math.abs(x - box.maxX),
      Math.abs(y - box.minY), Math.abs(y - box.maxY)
    );
    if (d > worst) worst = d;
  }
  return worst;
}

function inkEllipseResidual(points, box) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) return Infinity;
  const scale = Math.max(rx, ry);
  let worst = 0;
  for (let i = 0; i + 1 < points.length; i += 3) {
    const nx = (points[i] - cx) / rx;
    const ny = (points[i + 1] - cy) / ry;
    // Radial error in normalised space, taken back into model units so it can be
    // compared against one tolerance with everything else.
    const d = Math.abs(Math.sqrt((nx * nx) + (ny * ny)) - 1) * scale;
    if (d > worst) worst = d;
  }
  return worst;
}

// ── The entry point ────────────────────────────────────────────────────────

// `points` is a flat [x, y, pressure, …] run in model units. Returns
// { kind, runs: [[x, y, pressure, …], …] } or null. Several runs because an
// arrow is a shaft and a head, and one polyline cannot draw both without
// retracing itself.
export function fitInkShape(points) {
  const count = Math.floor((points?.length || 0) / 3);
  if (count < 4) return null;
  const box = inkShapeBounds(points);
  const longest = Math.max(box.width, box.height);
  if (longest < INK_SHAPE_MIN_SIZE) return null;
  const tolerance = Math.max(INK_SHAPE_TOLERANCE_MIN, longest * INK_SHAPE_TOLERANCE_RATIO);
  const pressure = inkShapeMeanPressure(points);

  let length = 0;
  for (let i = 0; i + 4 < points.length; i += 3) {
    const dx = points[i + 3] - points[i];
    const dy = points[i + 4] - points[i + 1];
    length += Math.sqrt((dx * dx) + (dy * dy));
  }
  if (!length) return null;
  const gapX = points[(count - 1) * 3] - points[0];
  const gapY = points[((count - 1) * 3) + 1] - points[1];
  const closed = Math.sqrt((gapX * gapX) + (gapY * gapY)) < (length * INK_SHAPE_CLOSE_RATIO);

  if (closed) {
    const rect = inkRectResidual(points, box);
    const ellipse = inkEllipseResidual(points, box);
    // Neither fits: a closed scribble stays a closed scribble.
    if (rect > tolerance && ellipse > tolerance) return null;
    if (ellipse <= rect) {
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      const rx = box.width / 2;
      const ry = box.height / 2;
      const coords = [];
      for (let i = 0; i <= INK_ELLIPSE_SAMPLES; i += 1) {
        const t = (i / INK_ELLIPSE_SAMPLES) * Math.PI * 2;
        coords.push(cx + (Math.cos(t) * rx), cy + (Math.sin(t) * ry));
      }
      return { kind: "ellipse", runs: [inkShapeRun(coords, pressure)] };
    }
    return {
      kind: "rect",
      runs: [inkShapeRun([
        box.minX, box.minY, box.maxX, box.minY,
        box.maxX, box.maxY, box.minX, box.maxY,
        box.minX, box.minY
      ], pressure)]
    };
  }

  const line = inkFitLine(points);
  if (line.worst > tolerance) {
    // Not a line as a whole — but it may be a line with an arrowhead on it,
    // which by construction breaks a whole-stroke line fit. Try the shaft alone.
    const arrow = inkFitArrow(points, tolerance, pressure);
    if (arrow) return arrow;
    return null;
  }
  return { kind: "line", runs: [inkShapeRun([line.from[0], line.from[1], line.to[0], line.to[1]], pressure)] };
}

// ── A highlighter swept along a line ───────────────────────────────────────
//
// The highlighter is for marking a line of somebody else's text — on a scan,
// usually, where there is no text layer to drag a highlight across — and a
// band drawn freehand along a line wobbles in exactly the way the line of type
// under it does not. So, with the highlighter's Straight switch on, a stroke
// that WAS a line is redrawn as one when the pen lifts, levelled flat when it
// was within a few degrees of flat, the way a ruler-guided marker would be.
//
// Not the hold gesture fitInkShape answers, and with a different tolerance,
// because a highlighter is a different tool: it is wide (the wobble that matters
// is relative to that width, not to the stroke's length), it is almost always
// meant to be straight, and it is never handwriting — there is no letter O to
// protect. What it does have to refuse is the reader who scribbles back and
// forth to fill a block, or follows a line round a corner, and both of those
// fail the fit or the progress test below.

// How far a sample may wander off the fitted line, as a fraction of the nib —
// a band whose wobble stays inside most of its own width reads as straight
// already — floored for a narrow nib.
export const INK_HL_STRAIGHT_RATIO = 0.6;
export const INK_HL_STRAIGHT_MIN = 6;

// Within this of horizontal (or vertical) it is levelled: a line of text is
// level, and a highlight two degrees off it looks like a mistake.
export const INK_HL_LEVEL_RADIANS = (4 * Math.PI) / 180;

// The stroke must cover at least this many times its own width along the line
// — below it, the "line" is a dab and has no direction worth straightening —
// and its path may be at most this many times the span it covers, which is
// what refuses a back-and-forth fill.
const INK_HL_STRAIGHT_MIN_SPAN = 1.5;
const INK_HL_STRAIGHT_MAX_TRAVEL = 1.35;

// `points` is the flat [x, y, pressure, …] run; returns the replacement run (the
// two ends of the line, at the stroke's mean pressure) or null to leave the
// stroke as drawn.
export function straightenInkHighlight(points, width) {
  const count = Math.floor((points?.length || 0) / 3);
  if (count < 2) return null;
  const nib = Math.max(1, Number(width) || 1);
  const line = inkFitLine(points);
  const tolerance = Math.max(INK_HL_STRAIGHT_MIN, nib * INK_HL_STRAIGHT_RATIO);
  if (line.worst > tolerance) return null;
  const span = Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]);
  if (span < nib * INK_HL_STRAIGHT_MIN_SPAN) return null;
  let travel = 0;
  for (let i = 0; i + 4 < points.length; i += 3) {
    travel += Math.hypot(points[i + 3] - points[i], points[i + 4] - points[i + 1]);
  }
  if (travel > span * INK_HL_STRAIGHT_MAX_TRAVEL) return null;

  let [x0, y0] = line.from;
  let [x1, y1] = line.to;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const offHorizontal = Math.abs(Math.sin(angle));
  const offVertical = Math.abs(Math.cos(angle));
  if (offHorizontal < Math.sin(INK_HL_LEVEL_RADIANS)) {
    const y = (y0 + y1) / 2;
    y0 = y;
    y1 = y;
  } else if (offVertical < Math.sin(INK_HL_LEVEL_RADIANS)) {
    const x = (x0 + x1) / 2;
    x0 = x;
    x1 = x;
  }
  return inkShapeRun([x0, y0, x1, y1], inkShapeMeanPressure(points));
}

// An arrow is a stroke that was a good line right up until the hand turned
// round and came back. So: find the sample where the direction reverses, ask
// whether everything before it is a line, and if so redraw the tail as a proper
// head rather than keeping whatever the hand actually did.
function inkFitArrow(points, tolerance, pressure) {
  const count = Math.floor(points.length / 3);
  if (count < 8) return null;
  const headStart = Math.floor(count * 0.6);
  let turnAt = -1;
  for (let i = headStart; i < count - 1; i += 1) {
    const ax = points[i * 3] - points[(i - 1) * 3];
    const ay = points[(i * 3) + 1] - points[((i - 1) * 3) + 1];
    const bx = points[(i + 1) * 3] - points[i * 3];
    const by = points[((i + 1) * 3) + 1] - points[(i * 3) + 1];
    const dot = (ax * bx) + (ay * by);
    const mag = Math.sqrt(((ax * ax) + (ay * ay)) * ((bx * bx) + (by * by)));
    // A reversal of more than ninety degrees. Anything gentler is a curve, and
    // a curve is not an arrowhead.
    if (mag && (dot / mag) < 0) { turnAt = i; break; }
  }
  if (turnAt < 4) return null;

  const shaft = points.slice(0, turnAt * 3);
  if (Math.floor(shaft.length / 3) < 4) return null;
  const line = inkFitLine(shaft);
  if (line.worst > tolerance) return null;

  const shaftLength = Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]);
  if (shaftLength < INK_SHAPE_MIN_SIZE) return null;
  const head = Math.min(INK_ARROW_HEAD_MAX, shaftLength * INK_ARROW_HEAD_RATIO);
  // The head opens back along the shaft, symmetrically, whatever lopsided thing
  // the hand drew — the point of snapping is that it comes out even.
  const back = Math.atan2(line.from[1] - line.to[1], line.from[0] - line.to[0]);
  const left = back - INK_ARROW_SPREAD;
  const right = back + INK_ARROW_SPREAD;
  return {
    kind: "arrow",
    runs: [
      inkShapeRun([line.from[0], line.from[1], line.to[0], line.to[1]], pressure),
      inkShapeRun([
        line.to[0] + (Math.cos(left) * head), line.to[1] + (Math.sin(left) * head),
        line.to[0], line.to[1],
        line.to[0] + (Math.cos(right) * head), line.to[1] + (Math.sin(right) * head)
      ], pressure)
    ]
  };
}
