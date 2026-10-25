// The word clock both teleprompters keep (src/notes/teleprompter.js and
// src/documents/pdf-teleprompter.js): the words the speed set says should have
// reached the band by now, against the words that have.
//
// Words a minute is a promise about words, and neither teleprompter can move
// words directly — the note's moves pixels at a measured words-per-pixel, the
// PDF's moves a cursor through segments and glides from one to the next. Some
// of the time that passes moves no words: a glide between two columns, a zoom
// landing, a frame so long on a slow phone that only part of it is moved (a
// whole one at once would be a jump). Small, but always the same way and
// different on every screen — the same 200 wpm read slower on a phone than on
// a desktop. So the words due are counted on the real clock and the words done
// as the text moves, and the speed is nudged, by at most a quarter, until the
// two agree. Over any minute of playing, the words that pass the band are the
// words a minute set.
//
// Only while it plays and nothing holds it: a pause, a hold while the type
// changes, a move the reader made — each starts the count afresh
// (rebaseWordClock), because none of them is time to be made up.

// How long a gap takes to close: long enough that the nudge is never seen as a
// change of speed, short enough that a glide's words are made up within the
// next paragraph or two.
const PACE_CATCHUP_S = 8;

const PACE_MIN = 0.8;
export const PACE_MAX = 1.25;

// More behind or ahead than this is not carried: a page whose reading path
// took a while to build, or a stall the frame clock could not see past, is
// forgiven rather than rushed through for the next half-minute.
const PACE_LAG_CAP_S = 4;

// The most of one frame the text is MOVED by: a longer frame (a long note's
// span being laid out, a slow phone) moves this much, and the clock makes up
// the rest over the next few seconds rather than in one jump.
export const FRAME_MOVE_MAX_S = 0.25;

// The most of one frame the clock COUNTS. Longer is not a slow frame but a
// stall — a tab all but hidden, a debugger — and is not owed.
export const FRAME_COUNT_MAX_S = 2;

// After this long at full speed the words counted are a measure worth showing.
const MEASURE_MIN_S = 3;

export function newWordClock() {
  return { due: 0, done: 0, seconds: 0, counted: 0 };
}

// A frame's worth of time at `ease` (0–1) of the speed set.
export function wordsDueFor(clock, wpm, ease, dt) {
  if (!(wpm > 0) || !(dt > 0)) return;
  clock.due += (wpm / 60) * ease * dt;
  if (ease >= 1) clock.seconds += dt;
  const cap = (wpm / 60) * PACE_LAG_CAP_S;
  clock.due = Math.min(clock.done + cap, Math.max(clock.done - cap, clock.due));
}

// Words that reached the band this frame. `full`: the frame was at full speed,
// so the words go in the measure too.
export function wordsDone(clock, words, full) {
  if (!(words > 0)) return;
  clock.done += words;
  if (full) clock.counted += words;
}

// The factor on the speed set that closes the gap.
export function paceFactor(clock, wpm) {
  const rate = wpm / 60;
  if (!(rate > 0)) return 1;
  const lag = clock.due - clock.done;
  return Math.min(PACE_MAX, Math.max(PACE_MIN, 1 + lag / (rate * PACE_CATCHUP_S)));
}

// Nothing owed and nothing ahead; the measure, too, when `measure`.
export function rebaseWordClock(clock, { measure = false } = {}) {
  clock.due = clock.done;
  if (measure) {
    clock.seconds = 0;
    clock.counted = 0;
  }
}

// The words a minute that really passed the band since the measure began, or
// null until it has run long enough to say.
export function measuredClockWpm(clock) {
  return clock.seconds >= MEASURE_MIN_S ? (clock.counted / clock.seconds) * 60 : null;
}
