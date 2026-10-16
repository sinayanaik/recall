// How fast THIS device's reader reads — the half of "about 1 h 10 min left"
// that is about the person rather than the file.
//
// Deliberately per device and never synced: someone reading a paper on a phone
// on the train and the same paper at a desk are two different speeds, and an
// average of the two is right for neither. The amount left to read IS shared
// (src/stats/combine.js); the rate it is divided by is always this device's own.
//
// Two rates, one per kind of reading, both kept as milliseconds per UNIT:
//   pdf    ms per page
//   notes  ms per word
// plus one per file and part, which takes over from the device rate as the
// reader spends time in that file — a dense chapter of maths reads slower than
// a novel, and after ten minutes in it the estimate should know.
//
// Each rate is an exponentially weighted moving average, stepped once per
// MINUTE of reading in the sample rather than once per sample: a 15-second
// window and a 4-minute one should not move the average by the same amount.

export const READING_SPEED_KEY = "recall:reading-speed-v1";

export const DEFAULT_MS_PER_PAGE = 2 * 60 * 1000;
export const DEFAULT_WORDS_PER_MINUTE = 230;
export const DEFAULT_MS_PER_WORD = 60000 / DEFAULT_WORDS_PER_MINUTE;

// The weight of one minute of reading in the average.
export const READING_SPEED_ALPHA = 0.2;

// Reading time before a rate is trusted over the one beneath it: the device's
// rate over the defaults, and a file's over the device's.
export const DEVICE_TRUST_MS = 5 * 60 * 1000;
export const FILE_TRUST_MS = 10 * 60 * 1000;

export const READING_SPEED_MAX_FILES = 200;

// What a plausible sample looks like. Anything outside is somebody skimming to
// find a page, or reading something else with the file left open.
export const SPEED_BOUNDS = {
  pdf: { min: 5 * 1000, max: 15 * 60 * 1000 },
  notes: { min: 60000 / 1000, max: 60000 / 50 }
};

// The most a single move may cover and still be reading rather than a jump —
// a contents entry, a search hit, a link, a resume landing.
export const SPEED_JUMP_UNITS = { pdf: 3, notes: 1500 };

export function defaultMsPerUnit(kind) {
  return kind === "pdf" ? DEFAULT_MS_PER_PAGE : DEFAULT_MS_PER_WORD;
}

export function emptySpeedModel() {
  return { v: 1, pdf: null, notes: null, files: {} };
}

// Folds one sample into one rate. Pure; `rate` may be null for a first sample.
export function stepSpeedRate(rate, msPerUnit, sampleMs, at = Date.now()) {
  const steps = Math.max(0.05, sampleMs / 60000);
  const weight = 1 - Math.pow(1 - READING_SPEED_ALPHA, steps);
  const previous = rate && Number.isFinite(rate.ms) ? rate.ms : null;
  const ms = previous == null ? msPerUnit : previous + weight * (msPerUnit - previous);
  return { ms, sampleMs: (rate?.sampleMs || 0) + sampleMs, at };
}

// Is this sample reading? `units` is how far the reader moved forward in the
// window and `ms` the active time it took.
export function acceptableSpeedSample(kind, units, ms) {
  const bounds = SPEED_BOUNDS[kind];
  if (!bounds || !(units > 0) || !(ms > 0)) return false;
  const perUnit = ms / units;
  return perUnit >= bounds.min && perUnit <= bounds.max;
}

// Folds a sample into the device rate and the file's own. Returns the model
// unchanged when the sample is not reading.
export function addSpeedSample(model, { kind, fileRateKey = "", units, ms, at = Date.now() }) {
  if (!acceptableSpeedSample(kind, units, ms)) return model;
  const perUnit = ms / units;
  const next = { ...model, files: { ...(model.files || {}) } };
  next[kind] = stepSpeedRate(model[kind], perUnit, ms, at);
  if (fileRateKey) {
    next.files[fileRateKey] = { ...stepSpeedRate(model.files?.[fileRateKey], perUnit, ms, at), kind };
    const keys = Object.keys(next.files);
    if (keys.length > READING_SPEED_MAX_FILES) {
      keys.sort((a, b) => (next.files[a].at || 0) - (next.files[b].at || 0));
      for (const key of keys.slice(0, keys.length - READING_SPEED_MAX_FILES)) delete next.files[key];
    }
  }
  return next;
}

function blendSpeedRate(base, rate, trustMs) {
  if (!rate || !Number.isFinite(rate.ms)) return base;
  const weight = Math.min(1, (rate.sampleMs || 0) / trustMs);
  return base * (1 - weight) + rate.ms * weight;
}

// Milliseconds per unit for this file and part on this device: the defaults,
// leaning toward the device's measured rate, leaning toward the file's own.
export function speedFor(model, kind, fileRateKey = "") {
  const device = blendSpeedRate(defaultMsPerUnit(kind), model?.[kind], DEVICE_TRUST_MS);
  const file = fileRateKey ? model?.files?.[fileRateKey] : null;
  return blendSpeedRate(device, file && file.kind === kind ? file : null, FILE_TRUST_MS);
}

export function estimateRemainingMs(model, kind, fileRateKey, remainingUnits) {
  if (!(remainingUnits > 0)) return 0;
  return remainingUnits * speedFor(model, kind, fileRateKey);
}

// "230 words a minute", "2.1 min a page": how the Home page names the rate.
export function describeSpeed(model, kind) {
  const ms = speedFor(model, kind);
  if (kind === "pdf") return `${(ms / 60000).toFixed(ms < 600000 ? 1 : 0)} min a page`;
  return `${Math.round(60000 / ms)} words a minute`;
}

export function speedMeasured(model, kind) {
  return (model?.[kind]?.sampleMs || 0) >= DEVICE_TRUST_MS;
}

// ── This device's copy ──────────────────────────────────────────────────────

let speedModel = null;

export function readSpeedModel() {
  if (speedModel) return speedModel;
  speedModel = emptySpeedModel();
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_SPEED_KEY) || "null");
    if (parsed && typeof parsed === "object") speedModel = { ...emptySpeedModel(), ...parsed, files: parsed.files || {} };
  } catch { /* unreadable or blocked: start from the defaults */ }
  return speedModel;
}

export function recordSpeedSample(sample) {
  const before = readSpeedModel();
  const after = addSpeedSample(before, sample);
  if (after === before) return false;
  speedModel = after;
  try {
    localStorage.setItem(READING_SPEED_KEY, JSON.stringify(after));
  } catch { /* full or private mode: this session only */ }
  return true;
}

export function forgetSpeedModel() {
  speedModel = null;
  try { localStorage.removeItem(READING_SPEED_KEY); } catch { /* nothing stored */ }
}
