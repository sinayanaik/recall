// How much of the browser's guess about where the pen is going is worth drawing.
//
// Chrome hands a pointermove a list of PREDICTED events — extrapolations of
// where the nib is about to be, a frame or two ahead. Drawing them is most of
// what makes a stroke feel like it is under the nib rather than behind it, and
// src/render/ink-engine.js has drawn them on the live layer for as long as there
// has been a live layer.
//
// It drew all of them, and that is what this file is for.
//
// ── What an unbounded guess looks like ─────────────────────────────────────
//
// Reported as "I'm seeing the tail of the strokes staying unnecessarily". The
// tail is real ink, drawn ahead of where the hand actually is, and the predictor
// is at its worst in exactly the places handwriting is made of: the end of a
// letter, where the nib decelerates and the extrapolation carries straight on
// past it; the turn at the bottom of an 'n', where it carries on through the
// corner; and a nib held still, where there is no motion to extrapolate from and
// the guess is invention.
//
// It is not that the guess outlives its frame — the engine repaints the live
// layer whole every frame and schedules one more to expire the last prediction,
// which is correct and stays. It is the SIZE of the overshoot, plus the fact
// that a dropped frame leaves whatever was last drawn on the glass until the
// next one. Every other thing in this branch is about not dropping frames; this
// is about what is drawn in them.
//
// ── Why this is its own file, and pure ────────────────────────────────────
//
// It imports nothing, so tools/ink-check.mjs can drive it in plain Node the way
// it drives ink-shapes.js and ink-strokes.js. That is not tidiness: headless
// Chrome does not synthesise predicted events for a dispatched PointerEvent, so
// a browser check cannot reach this code at all. A pure function over numbers is
// the only instrument that can ask whether the bound is right.
//
// Everything here is in MODEL units and milliseconds — the coordinates the
// engine has already converted to — so none of it changes with zoom, with page
// rotation or with the device.

// How far ahead of the last real sample a guess may be drawn. Two frames at
// 60Hz. The predictor will happily offer more, and past this it is guessing
// about a hand that has had time to change its mind — which, in handwriting, it
// does several times a letter.
export const INK_PREDICT_MAX_MS = 24;

// Below this much movement between the last two real samples, the nib is
// standing still and there is nothing to extrapolate FROM. This is the case the
// overshoot is most visible in, because the ink sits there rather than being
// overtaken by the hand a moment later.
export const INK_PREDICT_MIN_STEP = 0.35;

// How far the whole guess may reach, as a multiple of the last real step. The
// hand cannot have travelled much further in the next frame than it did in the
// last one, so a guess that does is not a guess about this hand.
export const INK_PREDICT_MAX_LEAD = 2.5;

// How sharply the guess may turn away from the direction the pen was actually
// going, as the cosine of the angle between them. cos 50° ≈ 0.64: a prediction
// that bends further than this is the predictor curling round a corner the hand
// has already taken, which is the whisker at the bottom of every 'n'.
export const INK_PREDICT_MAX_TURN_COS = 0.64;

// How many predicted samples to keep when the browser gives no usable timestamps
// to bound them by. Small on purpose: without a clock the only honest thing is
// to draw about one frame's worth and stop.
export const INK_PREDICT_FALLBACK_MAX = 2;

// `run` and `predicted` are both flat [x, y, pressure, …] in model units —
// `run` the real samples about to be painted, `predicted` the browser's guesses
// mapped through the same transform. `aheadMs[i]` is how far after the last real
// sample the i-th guess claims to be, or null where the browser did not say.
//
// Returns how many of the guesses to draw, always a prefix: a prediction is a
// path, and keeping the third point of one whose second point was wrong would
// draw a line to somewhere the predictor never claimed the pen would pass.
export function boundInkPrediction(run, predicted, aheadMs = null) {
  const guesses = Math.floor((predicted?.length || 0) / 3);
  if (!guesses) return 0;
  const real = Math.floor((run?.length || 0) / 3);
  // One real sample is a dot, and a dot has no direction. There is nothing here
  // to check a guess against, so none is drawn.
  if (real < 2) return 0;

  const lastX = run[((real - 1) * 3)];
  const lastY = run[((real - 1) * 3) + 1];
  const prevX = run[((real - 2) * 3)];
  const prevY = run[((real - 2) * 3) + 1];
  let dirX = lastX - prevX;
  let dirY = lastY - prevY;
  const step = Math.sqrt((dirX * dirX) + (dirY * dirY));
  if (step < INK_PREDICT_MIN_STEP) return 0;
  dirX /= step;
  dirY /= step;

  const reach = step * INK_PREDICT_MAX_LEAD;
  let atX = lastX;
  let atY = lastY;
  let travelled = 0;
  let kept = 0;
  for (let i = 0; i < guesses; i += 1) {
    if (!aheadMs && kept >= INK_PREDICT_FALLBACK_MAX) break;
    const ahead = aheadMs ? aheadMs[i] : null;
    if (Number.isFinite(ahead) && ahead > INK_PREDICT_MAX_MS) break;
    const x = predicted[i * 3];
    const y = predicted[(i * 3) + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    let dx = x - atX;
    let dy = y - atY;
    const length = Math.sqrt((dx * dx) + (dy * dy));
    // A guess that lands where the pen already is adds nothing and has no
    // direction to test. Kept — it cannot draw a whisker — and stepped over.
    if (length > 0) {
      // Against the direction the pen was ACTUALLY going, for every guess rather
      // than only the first. A prediction that curls does so gradually, and
      // comparing each step with its predecessor would follow it round.
      if (((dx / length) * dirX) + ((dy / length) * dirY) < INK_PREDICT_MAX_TURN_COS) break;
      if (travelled + length > reach) break;
      travelled += length;
    }
    atX = x;
    atY = y;
    kept += 1;
  }
  return kept;
}
