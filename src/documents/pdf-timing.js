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
const pdfTimingSamples = { render: [], text: [] };

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
export function expectPdfPagePaint(kind, startedAt = pdfTimingNow(), detail = "") {
  pdfTimingPending = { kind, startedAt, detail };
}

export function firstPdfPagePainted() {
  if (!pdfTimingPending) return;
  const { kind, startedAt, detail } = pdfTimingPending;
  pdfTimingPending = null;
  recordPdfTiming(kind, pdfTimingNow() - startedAt, detail);
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
  text: "make a page selectable"
};

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
  lines.push(`pdf.js: ${lib?.version || "not loaded"}`);
  ["render", "text"].forEach((kind) => {
    const s = pdfTimingStats(pdfTimingSamples[kind]);
    lines.push(s
      ? `${PDF_TIMING_LABELS[kind]}: median ${s.median}ms · p90 ${s.p90}ms · worst ${s.worst}ms (${s.count} pages)`
      : `${PDF_TIMING_LABELS[kind]}: no pages yet`);
  });
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
