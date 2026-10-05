// How long the PDF reader is actually taking, on the device it is running on.
//
// "Everything is slow on my phone" — opening, switching tabs, switching PDFs,
// scrolling, zooming — and nothing in the app could say how slow, or which
// part. tools/pdf-perf.mjs measures the same flows on a desktop CPU throttled
// to look like a phone, which is the best a machine without the phone can do;
// this is the other half. The document surface reports what it did and how
// long it took, and ☰ → ℹ App Info prints it with a button to copy it, so a
// number from the real device can replace a guess.
//
// In memory only, and small: the last few events and a rolling window of
// per-page samples. Nothing is stored, nothing is sent anywhere, and recording
// is a push onto an array — cheap enough to leave on for everyone.
//
// Imports nothing, deliberately: pdf-view.js reports into it and
// src/pwa/app-info.js reads out of it, and neither should pull the other in.

export const PDF_TIMING_EVENTS_MAX = 20;

export const PDF_TIMING_SAMPLES_MAX = 60;

const pdfTimingEvents = [];
// `worker` and `draw` split `render` in two: waiting for the worker to have
// something to draw (the page parsed, its fonts and images decoded) and the
// drawing itself. `annotate` is the page-painted hook — highlights repaired,
// ink, blocks and note badges — which ran on every page paint unmeasured.
// `bake` is dark page drawn into a page's pixels (bakePagePaper).
// `swap` is what a page drawn in the page renderer's worker costs the main
// thread: showing the finished bitmap.
const pdfTimingSamples = { render: [], worker: [], draw: [], swap: [], text: [], annotate: [], bake: [] };

// Renders cancelled before they finished, and renders that finished for a zoom
// or a position that had already gone — work that showed the reader nothing.
let pdfTimingWasted = { cancelled: 0, dropped: 0 };

export function notePdfWastedRenders(counts) {
  if (counts && typeof counts === "object") pdfTimingWasted = { ...pdfTimingWasted, ...counts };
}

// ── Where a slow frame went ────────────────────────────────────────────────
//
// The readout that came back after the main-thread work was taken out said 20
// frames over 34ms and one of 1.2s, with ONE long task in two minutes: the
// time was not in script any more, and nothing here could say where it was.
// The Long Animation Frames API (Chrome 123+) can: for every frame of 50ms or
// more it reports how much of it was script and when style and layout began.
// A slow frame seen by the touch rAF loop with no long animation frame over it
// was slow somewhere the main thread cannot see — raster, the GPU, the
// compositor. Silent where the API is missing.
const pdfTimingLoafs = [];

export function notePdfAnimationFrame(frame) {
  if (!frame || !Number.isFinite(frame.duration)) return;
  pdfTimingLoafs.push({ ...frame, at: Date.now() });
  const at = Date.now();
  while (pdfTimingLoafs.length && at - pdfTimingLoafs[0].at > PDF_TIMING_JANK_WINDOW_MS) pdfTimingLoafs.shift();
  if (pdfTimingLoafs.length > 500) pdfTimingLoafs.splice(0, pdfTimingLoafs.length - 500);
}

// A flow that ends when the next page is drawn — an open, a PDF switch, a
// zoom. At most one at a time: whichever was asked for last is what the
// reader is now waiting on.
let pdfTimingPending = null;

function pdfTimingNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function recordPdfTiming(kind, ms, detail = "") {
  if (!Number.isFinite(ms) || ms < 0) return;
  pdfTimingEvents.push({ kind, ms: Math.round(ms), detail, at: Date.now() });
  if (pdfTimingEvents.length > PDF_TIMING_EVENTS_MAX) pdfTimingEvents.splice(0, pdfTimingEvents.length - PDF_TIMING_EVENTS_MAX);
}

export function samplePdfTiming(kind, ms) {
  const list = pdfTimingSamples[kind];
  if (!list || !Number.isFinite(ms) || ms < 0) return;
  list.push(ms);
  if (list.length > PDF_TIMING_SAMPLES_MAX) list.splice(0, list.length - PDF_TIMING_SAMPLES_MAX);
}

// The reader is waiting for a page: an open, a switch or a zoom has started
// and is over when firstPdfPagePainted() is next called.
// ── What the reader FEELS: the main thread blocked under their finger ──────
//
// Durations say how long a page took; they do not say whether panning
// stuttered while it did. That is a long task (50ms or more on the main
// thread, from the Long Tasks API) that ran while the reader was touching,
// scrolling or zooming — pdf-view.js decides which ones those were and
// reports them here. Kept for the last two minutes, so the readout describes
// what the reader just did rather than the whole session.
export const PDF_TIMING_JANK_WINDOW_MS = 2 * 60 * 1000;

const pdfTimingJank = [];

// The longest frame seen while a finger was on the paper, in the same window:
// the stutter itself, where a long task is only one of its causes (a frame can
// also be lost to style, layout or a raster upload).
const pdfTimingFrames = [];

// How pages are being drawn on this device — reported by pdf-view.js, so this
// module can stay free of imports.
let pdfTimingCanvas = null;

export function notePdfCanvasSetup(info) {
  pdfTimingCanvas = info && typeof info === "object" ? { ...info } : null;
}

// `end` is the frame's rAF timestamp, on the performance clock, so a slow frame
// can be matched against the long animation frames that overlapped it.
export function notePdfInteractionFrame(ms, end = pdfTimingNow()) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const at = Date.now();
  pdfTimingFrames.push({ ms, at, end });
  while (pdfTimingFrames.length && at - pdfTimingFrames[0].at > PDF_TIMING_JANK_WINDOW_MS) pdfTimingFrames.shift();
  if (pdfTimingFrames.length > 4000) pdfTimingFrames.splice(0, pdfTimingFrames.length - 4000);
}

export function notePdfInteractionLongTask(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const at = Date.now();
  pdfTimingJank.push({ ms, at });
  while (pdfTimingJank.length && at - pdfTimingJank[0].at > PDF_TIMING_JANK_WINDOW_MS) pdfTimingJank.shift();
  if (pdfTimingJank.length > 500) pdfTimingJank.splice(0, pdfTimingJank.length - 500);
}

export function expectPdfPagePaint(kind, startedAt = pdfTimingNow(), detail = "") {
  pdfTimingPending = { kind, startedAt, detail };
}

// `extra` is what the page that ended the wait was drawn as — its canvas size.
export function firstPdfPagePainted(extra = "") {
  if (!pdfTimingPending) return;
  const { kind, startedAt, detail } = pdfTimingPending;
  pdfTimingPending = null;
  recordPdfTiming(kind, pdfTimingNow() - startedAt, [detail, extra].filter(Boolean).join(" · "));
}

// A flow that is over once the browser has painted what it changed: two
// frames, because the first runs before the style and layout work that the
// change caused, and that work is the part being measured.
export function recordPdfTimingAfterPaint(kind, startedAt, detail = "") {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => requestAnimationFrame(() => recordPdfTiming(kind, pdfTimingNow() - startedAt, detail)));
}

function pdfTimingStats(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const pick = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  return { count: sorted.length, median: pick(0.5), p90: pick(0.9), worst: Math.round(sorted[sorted.length - 1]) };
}

const PDF_TIMING_LABELS = {
  open: "open a PDF",
  switch: "switch PDF",
  tab: "back to PDF tab",
  zoom: "zoom",
  render: "draw one page",
  worker: "  waiting for the worker",
  draw: "  drawing",
  swap: "  on the main thread",
  text: "make a page selectable",
  annotate: "put highlights and notes on a page",
  bake: "draw dark page into a page"
};

// The slow frames (over 34ms) seen while touching, split by where the time
// went. `script` and `layout` come from the long animation frames that
// overlapped them; whatever part of a slow frame no long animation frame
// covers is "off the main thread".
function pdfTimingSlowFrameBreakdown(frames) {
  const slow = frames.filter((f) => f.ms > 34 && Number.isFinite(f.end));
  if (!slow.length) return null;
  const loafs = pdfTimingLoafs.filter((l) => Date.now() - l.at <= PDF_TIMING_JANK_WINDOW_MS);
  const counted = new Set();
  let script = 0;
  let layout = 0;
  let otherMain = 0;
  let waitingForFrame = 0;
  let offMain = 0;
  slow.forEach((frame) => {
    const start = frame.end - frame.ms;
    let covered = 0;
    loafs.forEach((loaf) => {
      const loafEnd = loaf.startTime + loaf.duration;
      const overlap = Math.min(frame.end, loafEnd) - Math.max(start, loaf.startTime);
      if (overlap <= 0) return;
      covered += overlap;
      if (counted.has(loaf)) return;
      counted.add(loaf);
      script += loaf.script;
      layout += loaf.layout;
      // What is left of a long frame once its script and its style/layout are
      // taken out is one of two things. If the frame BLOCKED (a long task in
      // it), the main thread was busy with something else — garbage, parsing,
      // a canvas call. If it did not, the main thread sat idle inside the frame,
      // waiting for the compositor to ask for the next one: the GPU or raster
      // was what was slow. The readout used to call both "other main-thread",
      // which sent the eye to the wrong thread.
      const rest = Math.max(0, loaf.duration - loaf.script - loaf.layout);
      if ((loaf.blocking || 0) >= 1) otherMain += rest;
      else waitingForFrame += rest;
    });
    offMain += Math.max(0, frame.ms - covered);
  });
  return { count: slow.length, script, layout, otherMain, waitingForFrame, offMain, observed: pdfTimingLoafsObserved };
}

let pdfTimingLoafsObserved = false;

export function notePdfAnimationFramesObserved(on) {
  pdfTimingLoafsObserved = Boolean(on);
}

function pdfTimingAgo(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

// Plain text, so it can be copied into a message as it is.
export function pdfTimingReport() {
  const lines = [];
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const lib = typeof window !== "undefined" ? window.pdfjsLib : null;
  lines.push(`device: dpr ${typeof window !== "undefined" ? window.devicePixelRatio || 1 : "?"}`
    + ` · ${nav.hardwareConcurrency || "?"} cores`
    + (nav.deviceMemory ? ` · ${nav.deviceMemory}GB` : "")
    + (typeof window !== "undefined" ? ` · ${window.innerWidth}×${window.innerHeight}` : ""));
  if (pdfTimingCanvas) {
    if (pdfTimingCanvas.drawn) lines.push(`pages drawn: ${pdfTimingCanvas.drawn}`);
    lines.push(`canvas: ${pdfTimingCanvas.cpu ? "CPU" : "GPU"} · budget ${(pdfTimingCanvas.budget / 1e6).toFixed(1)}MP a page`
      + ` · ${pdfTimingCanvas.slots} at a time`
      + (pdfTimingCanvas.dark ? ` · dark page ${pdfTimingCanvas.dark}` : ""));
  }
  lines.push(`pdf.js: ${lib?.version || "not loaded"}${pdfTimingCanvas?.build ? ` (${pdfTimingCanvas.build} build)` : ""}`);
  ["render", "worker", "draw", "swap", "text", "annotate", "bake"].forEach((kind) => {
    const s = pdfTimingStats(pdfTimingSamples[kind]);
    // The parts of a page's draw only say anything once there is one, and the
    // dark page line only once a dark page has been drawn on the main thread.
    if (!s && (kind === "worker" || kind === "draw" || kind === "swap" || kind === "bake")) return;
    lines.push(s
      ? `${PDF_TIMING_LABELS[kind]}: median ${s.median}ms · p90 ${s.p90}ms · worst ${s.worst}ms (${s.count} pages)`
      : `${PDF_TIMING_LABELS[kind]}: no pages yet`);
  });
  lines.push(`wasted renders: ${pdfTimingWasted.cancelled} stopped part-way · ${pdfTimingWasted.dropped} finished and thrown away`);
  const recentJank = pdfTimingJank.filter((j) => Date.now() - j.at <= PDF_TIMING_JANK_WINDOW_MS);
  lines.push(recentJank.length
    ? `while touching (last 2 min): ${recentJank.length} long tasks · worst ${Math.round(Math.max(...recentJank.map((j) => j.ms)))}ms`
      + ` · total ${Math.round(recentJank.reduce((a, j) => a + j.ms, 0))}ms`
    : "while touching (last 2 min): no long tasks");
  const recentFrames = pdfTimingFrames.filter((f) => Date.now() - f.at <= PDF_TIMING_JANK_WINDOW_MS);
  if (recentFrames.length) {
    const sorted = recentFrames.map((f) => f.ms).sort((a, b) => a - b);
    const slow = sorted.filter((ms) => ms > 34).length;
    lines.push(`frames while touching (last 2 min): ${sorted.length} · p90 ${Math.round(sorted[Math.floor(sorted.length * 0.9)])}ms`
      + ` · longest ${Math.round(sorted[sorted.length - 1])}ms · ${slow} over 34ms`);
    const split = pdfTimingSlowFrameBreakdown(recentFrames);
    if (split?.observed) {
      lines.push(`  where the slow frames went: script ${Math.round(split.script)}ms · style/layout ${Math.round(split.layout)}ms`
        + ` · other main-thread ${Math.round(split.otherMain)}ms`
        + ` · waiting for a frame (GPU/compositor) ${Math.round(split.waitingForFrame + split.offMain)}ms`);
    } else if (split) {
      lines.push("  where the slow frames went: not measurable in this browser");
    }
  } else {
    lines.push("frames while touching (last 2 min): none yet");
  }
  if (!pdfTimingEvents.length) {
    lines.push("No PDF opened since the app started.");
  } else {
    lines.push("recent:");
    [...pdfTimingEvents].reverse().forEach((event) => {
      lines.push(`  ${PDF_TIMING_LABELS[event.kind] || event.kind}: ${event.ms}ms${event.detail ? ` (${event.detail})` : ""} · ${pdfTimingAgo(event.at)}`);
    });
  }
  return lines.join("\n");
}
