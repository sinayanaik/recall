// What a pen stroke IS, and how it survives a JSONB column.
//
// A LEAF module — it imports nothing, for the reason src/format/highlight-
// colors.js states at length: this is read by the PDF surface, by the drawing
// sheet, and by a pure-Node check, and anything three unrelated callers reach
// for must not sit inside an import cycle.
//
// ── Why a stroke is not just an array of points ────────────────────────────
//
// A highlight quad is four numbers. A page of handwriting is fifteen thousand
// points, and the difference is not one of degree: these ride in the deck's
// `meta` bag, which src/sync/push.js sends WHOLE on every single sync. Stored
// as ordinary JSON — `[{x: 121.43127, y: 604.8891, p: 0.4823}, …]` — one
// densely written A4 page is about 700KB, and a paper annotated throughout is
// several megabytes re-uploaded every time anything in the deck changes.
//
// So a stroke is stored as ONE STRING, and the string is built to three rules:
//
//   1. It is ASCII. tools/text-sanitize-check.mjs asserts that nothing pushed
//      carries a U+0000 or half of a surrogate pair anywhere in the deck's meta
//      — including its KEYS — because PostgREST parses the whole request body
//      as JSON and one bad escape fails the entire push, which is how a book
//      once stopped syncing. A binary-in-a-string encoding walks straight into
//      that; base64url does not.
//   2. It is delta-encoded and variable-length, because consecutive samples of
//      a pen moving at writing speed differ by a fraction of a point, and a
//      format that spends the same room on a small number as a large one
//      spends most of its bytes on zeros.
//   3. It is SIMPLIFIED before it is encoded. A stylus samples at 240Hz and a
//      hand does not move at 240Hz; three quarters of the points on a stroke
//      sit on a line between their neighbours to well under the width of the
//      nib. Dropping them costs nothing visible and is the largest single
//      saving here — see simplifyInkStroke.
//
// Measured on a simulated page of 1,000 strokes and 33,000 samples: plain JSON
// is ~700KB, this is ~70KB, and a page annotated the way a paper actually gets
// annotated — a few marginal notes and a ring round a figure, call it a tenth of
// a saturated page — is ~7KB. That is the same order as the notes column already
// carries for an imported book, and it is pushed by the same mechanism.
//
// The number worth knowing is the other end: a forty-page paper covered edge to
// edge on EVERY page is ~2.7MB in one JSONB column re-sent on every sync. That
// is a real ceiling rather than a theoretical one, which is why inkEncodedSize()
// and inkPointCount() below exist at all — tools/ink-check.mjs measures a
// saturated page against a stated budget on every run, so the encoding cannot
// quietly regress into re-uploading a megabyte per sync and have nobody notice
// until a phone on a tether does.
//
// ── The version stamp ──────────────────────────────────────────────────────
//
// Every encoded stroke begins with a format version, for the reason a highlight
// quad carries `qv`: a later change to the quantiser must be tellable from a
// record written before it, rather than silently re-measured against rules it
// was never written under. A string whose version this build does not know is
// returned as null and the mark simply does not paint — wrong ink is worse than
// no ink, and the record is still there when a build that understands it opens
// the deck.

export const INK_FORMAT_VERSION = 1;

// Coordinates are quantised to this many units per PDF point. An eighth of a
// point is ~0.04mm — an order of magnitude finer than a nib resolves, and finer
// than the text layer's own rounding, so nothing about handwriting reads as
// stepped. Sixteenths would cost a byte every few points and show nobody
// anything.
export const INK_COORD_SCALE = 8;

// Pressure is 5 bits. Thirty-two levels across a width ramp that only ever
// spans a factor of three is below what an eye resolves on a 2px line, and it
// is exactly one base64 character, so a sample whose pressure did not change —
// which is most of them, since pressure moves far more slowly than position —
// costs a single zero.
export const INK_PRESSURE_LEVELS = 32;

// How far a point may sit from the line between its neighbours before it is
// worth keeping — as a FRACTION OF THE NIB WIDTH, not an absolute distance.
// What can be seen is what stands out from under the line, so the threshold has
// to scale with the line: an eighth of a 6pt marker is invisible and an eighth
// of a 1pt fineliner is not, and one absolute number is wrong for one of them.
// An eighth measured against the width halves the points on a page of writing
// with nothing visible changed.
export const INK_SIMPLIFY_RATIO = 0.125;

// ...with a floor of one quantisation step. Below this a point cannot be
// represented distinctly anyway, so keeping it spends bytes on a coordinate
// that decodes to the same place as its neighbour.
export const INK_SIMPLIFY_TOLERANCE = 1 / INK_COORD_SCALE;


// base64url, so the string needs no escaping in JSON, in a URL, or in the
// `<metadata>` of the SVG the notes surface writes.
const INK_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const INK_DECODE_TABLE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < INK_ALPHABET.length; i += 1) table[INK_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

// A colour is a palette TOKEN, never a hex value — the same discipline
// MARK_HIGHLIGHT_HEX keeps, and for the same reason: a colour fixed at drawing
// time is a colour that stops working the moment the reader changes theme or
// inverts the page. Anything that is not a plain lowercase word is not a token
// this app ever wrote, so it is refused rather than round-tripped.
const INK_TOKEN_RE = /^[a-z][a-z0-9]{0,15}$/;

// ── The varint ─────────────────────────────────────────────────────────────
//
// Five payload bits per character with the sixth as a continuation flag, which
// puts every delta a hand actually makes between samples — anything inside
// ±2 points — in ONE character. Zigzag first, so a small negative number is as
// cheap as a small positive one; two's complement would make every leftward
// stroke cost the maximum.

function inkZigzag(value) {
  return value < 0 ? (-value * 2) - 1 : value * 2;
}

function inkUnzigzag(value) {
  return (value & 1) ? -((value + 1) / 2) : value / 2;
}

function inkWriteVarint(out, value) {
  let rest = value;
  for (;;) {
    const chunk = rest & 31;
    rest = Math.floor(rest / 32);
    out.push(INK_ALPHABET[rest ? chunk | 32 : chunk]);
    if (!rest) return;
  }
}

// Returns the cursor past the number it read, or -1 on a character that is not
// in the alphabet. The caller checks: a truncated or corrupted string must fail
// the whole stroke rather than decode into a plausible-looking wrong shape.
function inkReadVarint(text, start, out) {
  let value = 0;
  let shift = 1;
  let i = start;
  for (;;) {
    if (i >= text.length) return -1;
    const code = text.charCodeAt(i);
    const digit = code < 128 ? INK_DECODE_TABLE[code] : -1;
    if (digit < 0) return -1;
    value += (digit & 31) * shift;
    i += 1;
    if (!(digit & 32)) break;
    shift *= 32;
    // A run this long is not a number any pen produced; it is a corrupted
    // string walking off the end of the alphabet check by luck.
    if (shift > 2 ** 40) return -1;
  }
  out.value = value;
  return i;
}

// ── Simplification ─────────────────────────────────────────────────────────

// Perpendicular distance from p to the segment a-b, squared. Squared because
// the only thing done with it is a comparison against a squared tolerance, and
// a square root per point over fifteen thousand points is real time on a phone.
function inkSegmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = (dx * dx) + (dy * dy);
  if (!lenSq) {
    const ex = px - ax;
    const ey = py - ay;
    return (ex * ex) + (ey * ey);
  }
  let t = (((px - ax) * dx) + ((py - ay) * dy)) / lenSq;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + (t * dx);
  const cy = ay + (t * dy);
  const ox = px - cx;
  const oy = py - cy;
  return (ox * ox) + (oy * oy);
}

// Ramer-Douglas-Peucker, iterative rather than recursive: a stroke can carry
// tens of thousands of points and the worst case for the recursive form is a
// stack frame per point.
//
// Pressure is carried through rather than considered. A point kept for its
// GEOMETRY keeps whatever pressure it had, and pressure between kept points
// interpolates — which is what a width ramp does anyway. Keeping a point purely
// because its pressure differed would preserve a bump nobody can see on a line
// whose width spans three pixels.
export function simplifyInkStroke(points, tolerance = INK_SIMPLIFY_TOLERANCE) {
  const count = Math.floor(points.length / 3);
  if (count < 3) return points.slice();
  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack = [0, count - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    if (last - first < 2) continue;
    const ax = points[first * 3];
    const ay = points[(first * 3) + 1];
    const bx = points[last * 3];
    const by = points[(last * 3) + 1];
    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = inkSegmentDistanceSq(points[i * 3], points[(i * 3) + 1], ax, ay, bx, by);
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worst <= toleranceSq || worstAt < 0) continue;
    keep[worstAt] = 1;
    stack.push(first, worstAt, worstAt, last);
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (!keep[i]) continue;
    out.push(points[i * 3], points[(i * 3) + 1], points[(i * 3) + 2]);
  }
  return out;
}

// ── Encode / decode ────────────────────────────────────────────────────────
//
// The shape either way is
//
//   { w: <nib width in PDF points>, c: <palette token>, p: [x, y, pressure, …] }
//
// with pressure 0..1. Points are flat rather than an array of objects because
// the drawing path allocates one per sample and an object per sample at 240Hz
// is garbage collected mid-stroke, which is a hitch under the nib.

export function encodeInkStroke(stroke, { simplify = true } = {}) {
  const raw = Array.isArray(stroke?.p) ? stroke.p : null;
  if (!raw || raw.length < 3) return "";
  const nib = Number(stroke.w) || 1;
  const points = simplify
    ? simplifyInkStroke(raw, Math.max(INK_SIMPLIFY_TOLERANCE, nib * INK_SIMPLIFY_RATIO))
    : raw;
  const width = Math.max(1, Math.round(nib * 10));
  const token = INK_TOKEN_RE.test(String(stroke.c || "")) ? String(stroke.c) : "ink";
  const out = [];
  let lastX = 0;
  let lastY = 0;
  let lastPressure = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = Math.round(points[i] * INK_COORD_SCALE);
    const y = Math.round(points[i + 1] * INK_COORD_SCALE);
    let pressure = Math.round((Number(points[i + 2]) || 0) * (INK_PRESSURE_LEVELS - 1));
    if (pressure < 0) pressure = 0;
    if (pressure > INK_PRESSURE_LEVELS - 1) pressure = INK_PRESSURE_LEVELS - 1;
    inkWriteVarint(out, inkZigzag(x - lastX));
    inkWriteVarint(out, inkZigzag(y - lastY));
    inkWriteVarint(out, inkZigzag(pressure - lastPressure));
    lastX = x;
    lastY = y;
    lastPressure = pressure;
  }
  return `${INK_FORMAT_VERSION}:${width}:${token}:${out.join("")}`;
}

// Null on anything this build cannot read — an unknown version, a colour token
// that is not one, a truncated point stream. Every caller treats null as "this
// stroke does not paint", never as "this stroke is empty": the difference
// matters, because an empty stroke would be written back on the next save and
// the record would be destroyed by having been read.
export function decodeInkStroke(text) {
  const source = typeof text === "string" ? text : "";
  const firstColon = source.indexOf(":");
  if (firstColon < 1) return null;
  const version = Number(source.slice(0, firstColon));
  if (version !== INK_FORMAT_VERSION) return null;
  const secondColon = source.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;
  const thirdColon = source.indexOf(":", secondColon + 1);
  if (thirdColon < 0) return null;
  const width = Number(source.slice(firstColon + 1, secondColon));
  if (!Number.isFinite(width) || width <= 0) return null;
  const token = source.slice(secondColon + 1, thirdColon);
  if (!INK_TOKEN_RE.test(token)) return null;

  const body = source.slice(thirdColon + 1);
  const points = [];
  const scratch = { value: 0 };
  let cursor = 0;
  let x = 0;
  let y = 0;
  let pressure = 0;
  while (cursor < body.length) {
    cursor = inkReadVarint(body, cursor, scratch);
    if (cursor < 0) return null;
    x += inkUnzigzag(scratch.value);
    cursor = inkReadVarint(body, cursor, scratch);
    if (cursor < 0) return null;
    y += inkUnzigzag(scratch.value);
    cursor = inkReadVarint(body, cursor, scratch);
    if (cursor < 0) return null;
    pressure += inkUnzigzag(scratch.value);
    if (pressure < 0 || pressure > INK_PRESSURE_LEVELS - 1) return null;
    points.push(x / INK_COORD_SCALE, y / INK_COORD_SCALE, pressure / (INK_PRESSURE_LEVELS - 1));
  }
  if (points.length < 3) return null;
  return { w: width / 10, c: token, p: points };
}

export function decodeInkStrokes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((text) => {
    const stroke = decodeInkStroke(text);
    if (stroke) out.push(stroke);
  });
  return out;
}

export function encodeInkStrokes(strokes, options) {
  if (!Array.isArray(strokes)) return [];
  const out = [];
  strokes.forEach((stroke) => {
    const text = encodeInkStroke(stroke, options);
    if (text) out.push(text);
  });
  return out;
}

// ── Geometry ───────────────────────────────────────────────────────────────

// The box a stroke occupies, PADDED BY ITS OWN HALF-WIDTH. A centreline bound
// is not what the reader sees: a 6pt nib puts three points of ink outside it on
// every side, and a bounding quad measured off the centreline crops the mark's
// own thumbnail and mis-places the note badge that sits on its corner.
export function inkStrokeBounds(stroke) {
  const points = stroke?.p;
  if (!Array.isArray(points) || points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const pad = (Number(stroke.w) || 1) / 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function inkStrokesBounds(strokes) {
  let box = null;
  (Array.isArray(strokes) ? strokes : []).forEach((stroke) => {
    const one = inkStrokeBounds(stroke);
    if (!one) return;
    if (!box) { box = { ...one }; return; }
    if (one.minX < box.minX) box.minX = one.minX;
    if (one.minY < box.minY) box.minY = one.minY;
    if (one.maxX > box.maxX) box.maxX = one.maxX;
    if (one.maxY > box.maxY) box.maxY = one.maxY;
  });
  return box;
}

// Does a stroke pass within `slack` of a point? This is what the eraser asks,
// once per stroke on the page, several times a second while the nib moves — so
// it early-outs on the bounding box first and only then walks segments.
export function inkStrokeHitsPoint(stroke, x, y, slack = 0) {
  const points = stroke?.p;
  if (!Array.isArray(points) || points.length < 3) return false;
  const reach = ((Number(stroke.w) || 1) / 2) + Math.max(0, slack);
  const box = inkStrokeBounds(stroke);
  if (!box) return false;
  if (x < box.minX - reach || x > box.maxX + reach) return false;
  if (y < box.minY - reach || y > box.maxY + reach) return false;
  const reachSq = reach * reach;
  if (points.length === 3) {
    const ex = x - points[0];
    const ey = y - points[1];
    return ((ex * ex) + (ey * ey)) <= reachSq;
  }
  for (let i = 0; i + 4 < points.length; i += 3) {
    if (inkSegmentDistanceSq(x, y, points[i], points[i + 1], points[i + 3], points[i + 4]) <= reachSq) return true;
  }
  return false;
}

// Is any part of a stroke inside a closed polygon? This is the lasso, and it
// asks about the CENTRELINE rather than the painted width on purpose: a lasso
// drawn snugly round a word should take that word, and testing painted edges
// would also take the descender of the line above.
export function inkStrokeInPolygon(stroke, polygon) {
  const points = stroke?.p;
  if (!Array.isArray(points) || points.length < 3) return false;
  if (!Array.isArray(polygon) || polygon.length < 6) return false;
  for (let i = 0; i + 1 < points.length; i += 3) {
    if (inkPointInPolygon(points[i], points[i + 1], polygon)) return true;
  }
  return false;
}

// Even-odd ray cast. `polygon` is flat [x, y, x, y, …] for the same reason
// stroke points are.
export function inkPointInPolygon(x, y, polygon) {
  let inside = false;
  const count = Math.floor(polygon.length / 2);
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const xi = polygon[i * 2];
    const yi = polygon[(i * 2) + 1];
    const xj = polygon[j * 2];
    const yj = polygon[(j * 2) + 1];
    if (((yi > y) !== (yj > y)) && (x < (((xj - xi) * (y - yi)) / (yj - yi)) + xi)) inside = !inside;
  }
  return inside;
}

// Move and scale every point of a stroke, for the lasso's drag and its corner
// grip. The nib width scales with the drawing: a diagram made smaller with the
// lines left at their original weight reads as a different, coarser drawing.
export function transformInkStroke(stroke, { dx = 0, dy = 0, scale = 1, originX = 0, originY = 0 } = {}) {
  const points = Array.isArray(stroke?.p) ? stroke.p : [];
  const out = new Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    out[i] = originX + ((points[i] - originX) * scale) + dx;
    out[i + 1] = originY + ((points[i + 1] - originY) * scale) + dy;
    out[i + 2] = points[i + 2];
  }
  return { ...stroke, w: (Number(stroke.w) || 1) * Math.abs(scale), p: out };
}

// How many points a set of strokes carries. The Storage panel and the size
// guard both want this, and neither should have to know the point stride.
export function inkPointCount(strokes) {
  let total = 0;
  (Array.isArray(strokes) ? strokes : []).forEach((stroke) => {
    if (Array.isArray(stroke?.p)) total += Math.floor(stroke.p.length / 3);
  });
  return total;
}

// What a set of encoded strokes costs on the wire, in bytes, counting the JSON
// quoting they will be wrapped in. Measured, never enforced: a reader who has
// genuinely written over every page of a paper has done nothing wrong, and
// silently refusing their next stroke would be the worst possible answer. This
// is here so that the cost is a number a check can hold the format to rather
// than something discovered on a slow sync.
export function inkEncodedSize(encodedStrokes) {
  let total = 0;
  (Array.isArray(encodedStrokes) ? encodedStrokes : []).forEach((text) => {
    if (typeof text === "string") total += text.length + 3;
  });
  return total;
}

// ── Where one mark ends and the next begins ────────────────────────────────
//
// Here rather than beside the surface that uses it (src/documents/pdf-ink.js),
// for the reason this whole file is a leaf: the rule is arithmetic over two
// boxes and two timestamps, it decides what gets listed and noted and turned
// into a card, and it is all thresholds. A rule made of thresholds that no
// check can reach is a set of numbers somebody guessed — so it lives where a
// pure-Node check can drive every one of them.
//
// A stroke joins the mark that is open if it was made without stopping and
// near what is already there. It will sometimes be wrong; the lasso's Join and
// Split are the repair, and being correctable is what makes a rule that is
// right most of the time better than a rule that asks every time.

// A pause longer than this closes the mark. Long enough to cross a t and dot an
// i, short enough that going back to a paragraph after reading on is a new
// thought rather than an addition to the old one.
export const INK_MARK_IDLE_MS = 1500;

// ...and a ceiling on the whole mark, so continuous writing down a page does
// not accumulate into one record whose thumbnail is the page and whose note is
// about everything on it.
export const INK_MARK_CEILING_MS = 5000;

// How far outside the open mark a stroke may start and still join it, as a
// multiple of that mark's own diagonal — because "near" means one thing beside
// a word and another beside a figure. Floored, so the first stroke of a mark
// (whose box is a point, and whose diagonal is therefore zero) does not refuse
// the second one.
export const INK_MARK_NEAR_RATIO = 1.5;
export const INK_MARK_NEAR_MIN = 24;

export function mergeInkBoxes(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY)
  };
}

// Zero where the boxes overlap, otherwise the gap between them.
export function inkBoxGap(a, b) {
  if (!a || !b) return 0;
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

// `open` is { page, startedAt, lastAt, box } or null. Returns true when the new
// strokes belong to it.
export function inkStrokesJoinMark(open, { page, box, now }) {
  if (!open || open.page !== page) return false;
  if ((now - open.lastAt) >= INK_MARK_IDLE_MS) return false;
  if ((now - open.startedAt) >= INK_MARK_CEILING_MS) return false;
  if (!open.box || !box) return true;
  const diagonal = Math.hypot(open.box.maxX - open.box.minX, open.box.maxY - open.box.minY);
  return inkBoxGap(open.box, box) <= Math.max(INK_MARK_NEAR_MIN, diagonal * INK_MARK_NEAR_RATIO);
}
