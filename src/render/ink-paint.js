// Turning a list of points into something that looks like a pen.
//
// Split out of the engine, and a near-leaf on purpose: this is the half a
// print/export path needs — src/documents/pdf-export.js paints ink onto a page
// canvas with no engine, no pointer and no host element anywhere — and dragging
// the whole input state machine in to draw forty static pages would be absurd.
// It imports the palette and nothing else.
//
// ── Why a filled outline and not a stroked polyline ────────────────────────
//
// ctx.stroke() has ONE lineWidth for the whole path. A pen does not: it is thin
// where the nib was moving fast or barely touching and thick where it pressed,
// and that ramp along the length of a single letter is most of what separates
// handwriting from a mouse drawing. So the centreline is offset by half the
// local width on each side, the two offset curves are joined end to end into
// one closed path, and the path is FILLED.
//
// Nonzero winding is what makes that safe. A variable-width outline round a
// sharp corner self-intersects — the inner offset crosses itself — and nonzero
// fills the union, which is exactly the right answer and is the default. Even-
// odd would punch a hole at every corner.
//
// ── Why the curve is quadratic through midpoints ───────────────────────────
//
// A stroke is stored simplified (src/format/ink-strokes.js), so a gentle arc
// that arrived as 60 samples is redrawn from 12. Joined with straight segments
// that reads as a polygon, which is the tell of a cheap drawing tool. Taking
// consecutive midpoints as the on-curve points and the original points as the
// control points gives a C1-continuous curve through the same shape at one
// quadratic per point and no fitting pass — the standard trick, and the reason
// simplification can be as aggressive as it is without anything looking faceted.

import { INK_PEN_HEX, inkPenVar, normalizeInkPen } from "../format/ink-colors.js?v=__BUILD__";

// How much of the nib a zero-pressure sample still puts down, and how much of it
// pressure controls. A pen that tapers to nothing looks like a dying felt tip;
// a pen that does not taper at all looks like a mouse. 0.35/0.65 is where a
// downstroke reads as deliberate and an upstroke reads as light.
export const INK_PRESSURE_FLOOR = 0.35;
export const INK_PRESSURE_SPAN = 0.65;

// Pressure is averaged over this many samples. A digitiser reports pressure in
// steps and a step lands as a visible knuckle in the width; three samples is
// enough to hide that and short enough that a deliberate press still shows
// within a letter.
export const INK_PRESSURE_WINDOW = 3;

// How far either side of a sample its own width depends on. The engine paints a
// live stroke in frame-sized runs rather than whole, and a run is only allowed
// to draw the samples whose width it can compute CORRECTLY — otherwise the same
// sample is one width this frame and another when the finished stroke is
// repainted, which is the beading you see along a line as you write it.
//
// Backwards it is INK_PRESSURE_WINDOW - 1 for the pressure average, and 1 for
// inkSmoothWidths' neighbour on the speed path: two covers both. Forwards it is
// one, for inkSmoothWidths' other neighbour and for the tangent inkStrokeOutline
// takes between i-1 and i+1. A sample with no successor yet has neither, so the
// engine holds it back and paints it on the tip layer, which is wiped and
// redrawn every frame anyway.
export const INK_WIDTH_LOOKBACK = INK_PRESSURE_WINDOW - 1;
export const INK_WIDTH_LOOKAHEAD = 1;

// A pointer that reports exactly this for every sample is reporting nothing —
// it is the value the spec tells a mouse to send. Ink from such a device gets
// its width from speed instead, so a trackpad sketch still tapers.
const INK_FLAT_PRESSURE = 0.5;

// Model units per second above which a speed-derived nib is at its thinnest.
// Handwriting runs at roughly 100-400 points/second; this is the top of that.
const INK_SPEED_FULL = 900;

// ── Colour ─────────────────────────────────────────────────────────────────

// A canvas cannot be handed a custom property, so the token is resolved against
// the live computed style and only falls back to the table when there is no
// style to read — a detached node, or the print document, which has its own
// inlined copy of the app's stylesheet but may be measured before it applies.
//
// Cached per token per resolved value: this is called once per stroke on a
// repaint of a page carrying hundreds, and getComputedStyle is a style
// recalculation each time it is asked something new.
const inkColorCache = new Map();

export function resolveInkColor(token, root = null) {
  const pen = normalizeInkPen(token);
  const scope = root || (typeof document !== "undefined" ? document.documentElement : null);
  if (!scope || typeof getComputedStyle !== "function") return INK_PEN_HEX[pen];
  // The theme is IN the key, and that is the whole of the bug this once was.
  //
  // A pen is a token that resolves to a CSS custom property, and the property is
  // defined per theme (styles/52-ink.css) precisely so that ink made on a dark
  // page is legible on a light one. Cached under the token alone, the first
  // answer of the session was the only answer of the session: switch from a dark
  // theme to a light one and every stroke kept being painted the near-white it
  // had been, on a page that was now white. "My notes are gone" is what that
  // looks like, and the notes were never gone.
  //
  // The scope is in it too. pdf-export.js and the SVG writer resolve against a
  // detached print document, and one of those asking first used to decide the
  // colour for the live page as well.
  const key = `${scope === document.documentElement ? (document.documentElement.dataset.theme || "") : "detached"}|${pen}`;
  const cached = inkColorCache.get(key);
  if (cached) return cached;
  let value = "";
  try {
    value = getComputedStyle(scope).getPropertyValue(inkPenVar(pen)).trim();
  } catch (_) {
    value = "";
  }
  const resolved = value || INK_PEN_HEX[pen];
  inkColorCache.set(key, resolved);
  return resolved;
}

// Called when the theme changes — from setTheme (src/ui/theme.js), which is the
// only caller and for a long time was not a caller at all. The key above makes
// this belt-and-braces rather than load-bearing, and it is kept because a theme
// whose pens are changed WITHOUT changing data-theme (a style edit, a
// preference) would otherwise be invisible to the key.
//
// Clearing this is only half the fix, and the smaller half: the dry canvas is a
// bitmap, so nothing changes on screen until something repaints it. See
// repaintDocumentInk.
export function forgetInkColors() {
  inkColorCache.clear();
}

// ── Width ──────────────────────────────────────────────────────────────────

// Per-point full width, in model units. Exported because the eraser wants to
// know how wide a stroke actually is where it was hit, and the export path
// wants the same numbers the screen used.
export function inkStrokeWidths(stroke) {
  const points = Array.isArray(stroke?.p) ? stroke.p : [];
  const count = Math.floor(points.length / 3);
  const nib = Number(stroke?.w) || 1;
  const widths = new Array(count);
  if (!count) return widths;

  let reportsPressure = false;
  for (let i = 0; i < count; i += 1) {
    const value = points[(i * 3) + 2];
    if (value > 0 && Math.abs(value - INK_FLAT_PRESSURE) > 0.001) { reportsPressure = true; break; }
  }

  if (!reportsPressure) {
    // No digitiser behind this one. Width from speed: the faster the nib was
    // travelling between two samples the lighter it is taken to have been,
    // which is what a hand actually does and what makes a mouse line taper at
    // the ends of a flick instead of stopping dead.
    for (let i = 0; i < count; i += 1) {
      const j = Math.max(1, i);
      const dx = points[j * 3] - points[(j - 1) * 3];
      const dy = points[(j * 3) + 1] - points[((j - 1) * 3) + 1];
      const speed = Math.sqrt((dx * dx) + (dy * dy)) * 60;
      const eased = 1 - Math.min(1, speed / INK_SPEED_FULL);
      widths[i] = nib * (INK_PRESSURE_FLOOR + (INK_PRESSURE_SPAN * eased));
    }
    return inkSmoothWidths(widths, nib);
  }

  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    let taken = 0;
    for (let k = i - (INK_PRESSURE_WINDOW - 1); k <= i; k += 1) {
      if (k < 0) continue;
      sum += points[(k * 3) + 2];
      taken += 1;
    }
    const pressure = taken ? sum / taken : 0;
    widths[i] = nib * (INK_PRESSURE_FLOOR + (INK_PRESSURE_SPAN * Math.max(0, Math.min(1, pressure))));
  }
  return widths;
}

// A second pass over the speed-derived widths only. Speed between two adjacent
// samples is noisy in a way pressure is not — one slow sample in a fast run is
// a bead on the line — and the averaging above cannot see it because it happens
// before this runs.
function inkSmoothWidths(widths, nib) {
  if (widths.length < 3) return widths;
  const out = new Array(widths.length);
  for (let i = 0; i < widths.length; i += 1) {
    const a = widths[Math.max(0, i - 1)];
    const b = widths[i];
    const c = widths[Math.min(widths.length - 1, i + 1)];
    out[i] = Math.max(nib * INK_PRESSURE_FLOOR * 0.6, (a + b + c) / 3);
  }
  return out;
}

// ── The path ───────────────────────────────────────────────────────────────

// Builds the closed outline of one stroke into `ctx`, in MODEL coordinates —
// the caller has already put the model-to-screen matrix on the context, so
// nothing here knows about zoom, device pixels or page rotation.
//
// Returns false when there was nothing to draw, so a caller painting a list can
// tell an empty stroke from one it drew.
export function inkStrokeOutline(ctx, stroke) {
  const points = Array.isArray(stroke?.p) ? stroke.p : [];
  const count = Math.floor(points.length / 3);
  if (!count) return false;
  const widths = inkStrokeWidths(stroke);

  // A single sample is a dot, and a dot is what a pen tapped on paper leaves.
  // Without this branch the outline of a one-point stroke is empty and the
  // full stop at the end of a margin note silently does not exist.
  if (count === 1) {
    ctx.beginPath();
    ctx.arc(points[0], points[1], Math.max(widths[0], 0.1) / 2, 0, Math.PI * 2);
    return true;
  }

  const left = new Array(count * 2);
  const right = new Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(count - 1, i + 1);
    let tx = points[next * 3] - points[prev * 3];
    let ty = points[(next * 3) + 1] - points[(prev * 3) + 1];
    let length = Math.sqrt((tx * tx) + (ty * ty));
    if (!length) {
      // Two samples in the same place — a hand holding still. Borrow the
      // previous tangent rather than emitting a zero normal, which would
      // collapse the outline to the centreline and leave a notch in the line.
      if (i > 0) {
        tx = left[(i - 1) * 2] - right[(i - 1) * 2];
        ty = left[((i - 1) * 2) + 1] - right[((i - 1) * 2) + 1];
        length = Math.sqrt((tx * tx) + (ty * ty)) || 1;
        const half = widths[i] / 2 / length;
        left[i * 2] = points[i * 3] + (tx * half);
        left[(i * 2) + 1] = points[(i * 3) + 1] + (ty * half);
        right[i * 2] = points[i * 3] - (tx * half);
        right[(i * 2) + 1] = points[(i * 3) + 1] - (ty * half);
        continue;
      }
      tx = 1; ty = 0; length = 1;
    }
    const half = widths[i] / 2 / length;
    const nx = -ty * half;
    const ny = tx * half;
    left[i * 2] = points[i * 3] + nx;
    left[(i * 2) + 1] = points[(i * 3) + 1] + ny;
    right[i * 2] = points[i * 3] - nx;
    right[(i * 2) + 1] = points[(i * 3) + 1] - ny;
  }

  ctx.beginPath();
  inkQuadRun(ctx, left, count, false);
  // The far cap. A round join between the two offset curves, drawn as an arc
  // about the last centreline point — a straight line across would give every
  // stroke a guillotined end.
  ctx.arc(
    points[(count - 1) * 3],
    points[((count - 1) * 3) + 1],
    Math.max(widths[count - 1], 0.1) / 2,
    Math.atan2(left[((count - 1) * 2) + 1] - points[((count - 1) * 3) + 1], left[(count - 1) * 2] - points[(count - 1) * 3]),
    Math.atan2(right[((count - 1) * 2) + 1] - points[((count - 1) * 3) + 1], right[(count - 1) * 2] - points[(count - 1) * 3])
  );
  inkQuadRun(ctx, right, count, true);
  ctx.arc(
    points[0],
    points[1],
    Math.max(widths[0], 0.1) / 2,
    Math.atan2(right[1] - points[1], right[0] - points[0]),
    Math.atan2(left[1] - points[1], left[0] - points[0])
  );
  ctx.closePath();
  return true;
}

// One side of the outline, forwards or backwards, as quadratics through the
// midpoints of consecutive offset points.
function inkQuadRun(ctx, side, count, reverse) {
  const at = (i) => (reverse ? count - 1 - i : i);
  const first = at(0);
  if (reverse) ctx.lineTo(side[first * 2], side[(first * 2) + 1]);
  else ctx.moveTo(side[first * 2], side[(first * 2) + 1]);
  for (let i = 1; i < count - 1; i += 1) {
    const a = at(i);
    const b = at(i + 1);
    ctx.quadraticCurveTo(
      side[a * 2], side[(a * 2) + 1],
      (side[a * 2] + side[b * 2]) / 2,
      (side[(a * 2) + 1] + side[(b * 2) + 1]) / 2
    );
  }
  const last = at(count - 1);
  ctx.lineTo(side[last * 2], side[(last * 2) + 1]);
}

// Paint one stroke, colour and all. `root` scopes the colour lookup so the print
// document resolves its own theme rather than the app's.
export function paintInkStroke(ctx, stroke, { root = null, color = null } = {}) {
  if (!inkStrokeOutline(ctx, stroke)) return;
  ctx.fillStyle = color || resolveInkColor(stroke?.c, root);
  ctx.fill();
}

export function paintInkStrokes(ctx, strokes, options) {
  (Array.isArray(strokes) ? strokes : []).forEach((stroke) => paintInkStroke(ctx, stroke, options));
}
