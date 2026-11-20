// A Canvas page's setup: its size, its paper and the lines printed on it.
//
// Pure — no DOM, no state, no imports — so the same numbers draw the page
// (src/documents/blank-pdf.js), lay it out before it renders
// (src/documents/pdf-view.js), snap a dragged box to its squares
// (src/documents/pdf-guides.js), paint the dialog's preview
// (src/documents/canvas-setup-dialog.js) and are checked in Node
// (tools/canvas-setup-check.mjs).
//
// ── Where a page sits, and why nothing written on it ever moves ────────────
//
// Everything on a Canvas page — ink, shapes, Blocks — is stored in the page's
// PDF user space, whose y runs UP from the bottom. A4 is the box
// [0 0 595 842]. A page of any other size is the box [0, 842−h, w, 842]: its
// TOP-LEFT corner is the same user-space point on every page, at every size.
// So a page made wider, taller, shorter or turned to landscape keeps every
// mark exactly where it was relative to the top-left corner, which is where
// writing starts; a page made smaller only hides what now falls past its edge,
// and making it bigger again brings that back.
//
// ── ...and why the lines do not move either ───────────────────────────────
//
// Ruled lines, grid lines and dots are laid on a lattice anchored at user
// point (0, 0) — every line is at a whole multiple of the spacing — and the
// page is a window onto it. That is exactly how the first papers were drawn
// (blank-pdf.js, paperStream), so the default grid and ruled setups put every
// line where it always was, a page resized keeps its lines under the words
// written on them, and a box dragged on grid paper snaps to squares whose
// origin is always [0, 0]. Only changing the spacing moves the lines.
//
// ── What is stored ─────────────────────────────────────────────────────────
//
// On the Canvas record (meta.notebook), and so synced and backed up with it:
//   setup       the setup of every page that has none of its own; absent, the
//               record's old `paper` (grid / ruled / blank) at A4
//   pageSetups  { "<page>": setup } for the pages set up on their own
// Every length is in PDF points. Line opacity is mixed into the colour before
// it is written (colour = paper + (line − paper) × opacity), so the file needs
// no transparency, renders the same everywhere, and two lines crossing do not
// darken where they meet. The first papers' greys are black at exactly 20%,
// 38% and 28%.

export const CANVAS_SHEET_TOP = 842;
export const SHEET_PT_PER_MM = 72 / 25.4;
export const SHEET_PT_PER_IN = 72;

export const SHEET_PATTERNS = ["blank", "ruled", "grid", "dots", "cornell"];
export const SHEET_PATTERN_LABEL = {
  blank: "Blank",
  ruled: "Ruled",
  grid: "Grid",
  dots: "Dot grid",
  cornell: "Cornell"
};

// The papers a Canvas had before it had a setup. Their names are still what
// `meta.notebook.paper` holds, for a build that knows nothing else.
const SHEET_LEGACY_KINDS = ["grid", "ruled", "blank"];

// The nearest of those for a pattern that is not one of them, written to
// `paper` beside a setup so an older build still shows lines of some kind.
const SHEET_LEGACY_NEAREST = { blank: "blank", ruled: "ruled", grid: "grid", dots: "grid", cornell: "ruled" };

// Portrait sizes in points. `landscape` presets are the ones that are almost
// always used turned (a slide, an index card); choosing one turns the page.
export const SHEET_SIZES = [
  { id: "a3", label: "A3", w: 842, h: 1191, note: "297 × 420 mm" },
  { id: "a4", label: "A4", w: 595, h: 842, note: "210 × 297 mm" },
  { id: "a5", label: "A5", w: 420, h: 595, note: "148 × 210 mm" },
  { id: "a6", label: "A6", w: 298, h: 420, note: "105 × 148 mm" },
  { id: "b5", label: "B5", w: 499, h: 709, note: "176 × 250 mm" },
  { id: "letter", label: "Letter", w: 612, h: 792, note: "8.5 × 11 in" },
  { id: "legal", label: "Legal", w: 612, h: 1008, note: "8.5 × 14 in" },
  { id: "tabloid", label: "Tabloid", w: 792, h: 1224, note: "11 × 17 in" },
  { id: "square", label: "Square", w: 595, h: 595, note: "210 × 210 mm" },
  { id: "slide169", label: "Slide 16:9", w: 540, h: 960, note: "13.3 × 7.5 in", landscape: true },
  { id: "slide43", label: "Slide 4:3", w: 540, h: 720, note: "10 × 7.5 in", landscape: true },
  { id: "index", label: "Index card", w: 216, h: 360, note: "5 × 3 in", landscape: true }
];
export const SHEET_SIZE_CUSTOM = "custom";
// One inch to the long side of A0.
export const SHEET_SIZE_MIN = 72;
export const SHEET_SIZE_MAX = 3370;

// Light papers only. A dark page is the paper tone's job (◐, src/format/
// paper-tones.js), which also turns the pens light; a dark sheet drawn into
// the file would leave dark ink on it.
export const SHEET_PAPER_COLORS = [
  { id: "white", label: "White", hex: "#ffffff" },
  { id: "ivory", label: "Ivory", hex: "#fffbf0" },
  { id: "yellow", label: "Yellow", hex: "#fff6c2" },
  { id: "blue", label: "Blue", hex: "#eaf2ff" },
  { id: "green", label: "Green", hex: "#eaf7ec" },
  { id: "pink", label: "Pink", hex: "#ffeef2" },
  { id: "grey", label: "Grey", hex: "#f2f2f2" }
];
export const SHEET_LINE_COLORS = [
  { id: "black", label: "Grey", hex: "#000000" },
  { id: "blue", label: "Blue", hex: "#1f5fd1" },
  { id: "green", label: "Green", hex: "#21865a" },
  { id: "red", label: "Red", hex: "#d0342c" },
  { id: "brown", label: "Brown", hex: "#8a5a2b" },
  { id: "purple", label: "Purple", hex: "#7444c4" }
];
export const SHEET_MARGIN_COLORS = [
  { id: "red", label: "Red", hex: "#db8c8c" },
  { id: "blue", label: "Blue", hex: "#8fb0e6" },
  { id: "grey", label: "Grey", hex: "#b8b8b8" }
];
export const SHEET_DASHES = ["solid", "dashed", "dotted"];

// How a page's size behaves (src/documents/canvas-extent.js):
//   grow       the size it is set up at, at least, and longer or wider when
//              what is on it reaches its right edge or its foot ("Grows as
//              needed") — every page's, unless it says otherwise
//   set        exactly the size it is set up at: "Grows as needed" switched
//              off in Page setup
//   boundless  no size: what is on it, and room round it, in every direction
//              ("Boundless"). Its own w × h is only where it starts.
// A record from a build that knew only one kind of page has no `fit`, and its
// pages grow; so does a "fixed", which a build of a day wrote for "not chosen".
// Growing changes no byte of a page until it has grown (sheetDrawKey).
export const SHEET_FITS = ["grow", "set", "boundless"];

function fitOf(value) {
  return value === "set" || value === "boundless" ? value : "grow";
}
export const SHEET_DASH_LABEL = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };

const sheetMmPt = (mm) => sheetRound(mm * SHEET_PT_PER_MM);

// The spacing a pattern is usually wanted at, in points, for the dialog's chips.
export const SHEET_SPACING_PRESETS = {
  ruled: [
    { label: "Narrow", pt: 18 },
    { label: "College", pt: 20.25 },
    { label: "Standard", pt: 24 },
    { label: "Wide", pt: sheetMmPt(10) }
  ],
  cornell: [
    { label: "Narrow", pt: 18 },
    { label: "College", pt: 20.25 },
    { label: "Standard", pt: 24 }
  ],
  grid: [
    { label: "4 mm", pt: sheetMmPt(4) },
    { label: "5 mm", pt: sheetMmPt(5) },
    { label: "5.6 mm", pt: 16 },
    { label: "¼ in", pt: 18 },
    { label: "1 cm", pt: sheetMmPt(10) }
  ],
  dots: [
    { label: "4 mm", pt: sheetMmPt(4) },
    { label: "5 mm", pt: sheetMmPt(5) },
    { label: "¼ in", pt: 18 },
    { label: "8 mm", pt: sheetMmPt(8) }
  ]
};

const SHEET_SPACING_MIN = { blank: sheetMmPt(2), ruled: sheetMmPt(3), grid: sheetMmPt(2), dots: sheetMmPt(3), cornell: sheetMmPt(3) };
const SHEET_SPACING_MAX = sheetMmPt(30);
// The most dots one page is drawn with. Each is a few dozen bytes of the file,
// and the file is uploaded again whenever a page is added, so a poster-sized
// page at 3mm is held to a wider spacing rather than a megabyte of dots.
const SHEET_MAX_DOTS = 12000;

const SHEET_ZERO_MARGINS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

// What a pattern starts at. Grid and ruled are the first papers' own numbers
// (blank-pdf.js): the 16pt grid with a heavier line every fourth square, and
// 24pt rules from a margin line 56pt in, stopping 32pt from the right and one
// rule from the top.
const SHEET_PATTERN_DEFAULTS = {
  blank: { pitch: 16, opacity: 0.2, width: 0.4, majorEvery: 0, majorOpacity: 0.38, margins: SHEET_ZERO_MARGINS, marginLine: { on: false, color: "#db8c8c" } },
  grid: { pitch: 16, opacity: 0.2, width: 0.4, majorEvery: 4, majorOpacity: 0.38, margins: SHEET_ZERO_MARGINS, marginLine: { on: false, color: "#db8c8c" } },
  ruled: { pitch: 24, opacity: 0.28, width: 0.6, majorEvery: 0, majorOpacity: 0.38, margins: { top: 24, right: 32, bottom: 0, left: 56 }, marginLine: { on: true, color: "#db8c8c" } },
  dots: { pitch: sheetMmPt(5), opacity: 0.45, width: 0.4, dot: 1.2, majorEvery: 0, majorOpacity: 0.38, margins: SHEET_ZERO_MARGINS, marginLine: { on: false, color: "#db8c8c" } },
  cornell: { pitch: 20.25, opacity: 0.28, width: 0.5, majorEvery: 0, majorOpacity: 0.6, margins: { top: sheetMmPt(15), right: 0, bottom: 0, left: 0 }, marginLine: { on: false, color: "#db8c8c" }, cue: sheetMmPt(63.5), summary: sheetMmPt(50.8) }
};

const SHEET_COMMON_DEFAULTS = {
  size: "a4",
  w: 595,
  h: 842,
  paper: "#ffffff",
  line: "#000000",
  dash: "solid",
  dot: 1.2,
  cue: sheetMmPt(63.5),
  summary: sheetMmPt(50.8)
};

export function sheetRound(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sheetClamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function sheetNumber(value, fallback, lo, hi) {
  const n = Number(value);
  return sheetRound(sheetClamp(Number.isFinite(n) && value !== null && value !== "" ? n : fallback, lo, hi));
}

function sheetHex(value, fallback) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? "").trim());
  if (!match) return fallback;
  let digits = match[1].toLowerCase();
  if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
  return `#${digits}`;
}

function sheetRgb(hex) {
  const h = sheetHex(hex, "#000000").slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function sheetRgbHex(rgb) {
  return `#${rgb.map((v) => Math.round(sheetClamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function sheetLuminance(rgb) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return (0.2126 * lin(rgb[0])) + (0.7152 * lin(rgb[1])) + (0.0722 * lin(rgb[2]));
}

// A paper colour, lifted toward white until it reads as paper.
export function lightSheetPaper(hex) {
  const rgb = sheetRgb(sheetHex(hex, "#ffffff"));
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const mixed = rgb.map((v) => v + ((1 - v) * t));
    if (sheetLuminance(mixed) >= 0.65) return sheetRgbHex(mixed);
  }
  return "#ffffff";
}

export function isLightSheetPaper(hex) {
  return sheetLuminance(sheetRgb(hex)) >= 0.65;
}

export function sheetSizeById(id) {
  return SHEET_SIZES.find((size) => size.id === id) || null;
}

// The preset a width and height are, in either orientation, or "custom".
export function sheetSizeIdFor(w, h) {
  const a = sheetRound(Math.min(w, h));
  const b = sheetRound(Math.max(w, h));
  const found = SHEET_SIZES.find((size) => Math.abs(size.w - a) < 0.6 && Math.abs(size.h - b) < 0.6);
  return found ? found.id : SHEET_SIZE_CUSTOM;
}

export function sheetIsLandscape(setup) {
  return Number(setup?.w) > Number(setup?.h);
}

// Every setting a pattern starts at, at A4 portrait.
export function sheetPatternDefaults(pattern) {
  const kind = SHEET_PATTERNS.includes(pattern) ? pattern : "grid";
  const own = SHEET_PATTERN_DEFAULTS[kind];
  return {
    ...SHEET_COMMON_DEFAULTS,
    pattern: kind,
    ...own,
    margins: { ...own.margins },
    marginLine: { ...own.marginLine }
  };
}

// The setup a Canvas page has when nothing was ever set: the first papers.
export function legacySheetSetup(kind) {
  return normalizeSheetSetup(sheetPatternDefaults(SHEET_LEGACY_KINDS.includes(kind) ? kind : "grid"));
}

export function legacyPaperKind(kind) {
  return SHEET_LEGACY_KINDS.includes(kind) ? kind : "grid";
}

export function nearestLegacyPaper(pattern) {
  return SHEET_LEGACY_NEAREST[pattern] || "grid";
}

// Anything into a complete setup: every field present, every number in range,
// every colour a hex. A field that is missing or nonsense takes the pattern's
// own default, so a record written by a later build with settings this one
// does not know still draws as the nearest thing this one can.
export function normalizeSheetSetup(raw, fallbackPattern = "grid") {
  const src = raw && typeof raw === "object" ? raw : {};
  const fit = fitOf(src.fit);
  let pattern = SHEET_PATTERNS.includes(src.pattern) ? src.pattern : (SHEET_PATTERNS.includes(fallbackPattern) ? fallbackPattern : "grid");
  // A page with no edges has no foot for a summary box nor a top for a title
  // band: Cornell paper on it is ruled paper.
  if (fit === "boundless" && pattern === "cornell") pattern = "ruled";
  const d = sheetPatternDefaults(pattern);
  const w = sheetNumber(src.w, d.w, SHEET_SIZE_MIN, SHEET_SIZE_MAX);
  const h = sheetNumber(src.h, d.h, SHEET_SIZE_MIN, SHEET_SIZE_MAX);
  const minPitch = pattern === "dots"
    ? Math.max(SHEET_SPACING_MIN.dots, Math.sqrt((w * h) / SHEET_MAX_DOTS))
    : SHEET_SPACING_MIN[pattern];
  // ...and no margins: the lines run to wherever the page reaches.
  const marginsIn = fit === "boundless" ? SHEET_ZERO_MARGINS : (src.margins && typeof src.margins === "object" ? src.margins : {});
  const margins = {
    top: sheetNumber(marginsIn.top, d.margins.top, 0, Math.max(0, (h / 2) - 10)),
    right: sheetNumber(marginsIn.right, d.margins.right, 0, Math.max(0, (w / 2) - 10)),
    bottom: sheetNumber(marginsIn.bottom, d.margins.bottom, 0, Math.max(0, (h / 2) - 10)),
    left: sheetNumber(marginsIn.left, d.margins.left, 0, Math.max(0, (w / 2) - 10))
  };
  const areaW = Math.max(0, w - margins.left - margins.right);
  const areaH = Math.max(0, h - margins.top - margins.bottom);
  const lineIn = src.marginLine && typeof src.marginLine === "object" ? src.marginLine : {};
  return {
    size: sheetSizeIdFor(w, h),
    w,
    h,
    pattern,
    paper: lightSheetPaper(sheetHex(src.paper, d.paper)),
    line: sheetHex(src.line, d.line),
    opacity: sheetNumber(src.opacity, d.opacity, 0.05, 1),
    width: sheetNumber(src.width, d.width, 0.1, 3),
    dash: SHEET_DASHES.includes(src.dash) ? src.dash : d.dash,
    pitch: sheetNumber(src.pitch, d.pitch, sheetRound(minPitch), SHEET_SPACING_MAX),
    majorEvery: Math.round(sheetNumber(src.majorEvery, d.majorEvery, 0, 20)),
    majorOpacity: sheetNumber(src.majorOpacity, d.majorOpacity, 0.05, 1),
    dot: sheetNumber(src.dot, d.dot, 0.3, 4),
    margins,
    marginLine: {
      on: typeof lineIn.on === "boolean" ? lineIn.on : d.marginLine.on,
      color: sheetHex(lineIn.color, d.marginLine.color)
    },
    cue: sheetNumber(src.cue, d.cue, 0, Math.max(0, areaW - 20)),
    summary: sheetNumber(src.summary, d.summary, 0, Math.max(0, areaH - 20)),
    fit
  };
}

// What a setup DRAWS, as a string: two setups with the same key are the same
// page, whatever else they carry (a dot size on ruled paper draws nothing). It
// is what pages share a content stream by, and what says a setup is one of the
// first papers.
export function sheetDrawKey(setup) {
  const s = normalizeSheetSetup(setup);
  const m = s.margins;
  const parts = [s.w, s.h, s.pattern, s.paper];
  if (s.pattern === "ruled") {
    parts.push(s.pitch, s.line, s.opacity, s.width, s.dash, m.top, m.right, m.bottom, m.left, s.marginLine.on ? s.marginLine.color : "-");
  } else if (s.pattern === "grid") {
    parts.push(s.pitch, s.line, s.opacity, s.width, s.dash, m.top, m.right, m.bottom, m.left, s.majorEvery, s.majorEvery ? s.majorOpacity : "-");
  } else if (s.pattern === "dots") {
    parts.push(s.pitch, s.line, s.opacity, s.dot, m.top, m.right, m.bottom, m.left);
  } else if (s.pattern === "cornell") {
    parts.push(s.pitch, s.line, s.opacity, s.width, s.dash, s.majorOpacity, m.top, m.right, m.bottom, m.left, s.cue, s.summary);
  }
  // Last, and only for a Boundless page — whose dots are drawn a row at a
  // time — so every other page, growing or not, keeps the key and the stream it
  // had until it actually grows (and then its box is in the key, blank-pdf.js).
  if (s.fit === "boundless") parts.push(s.fit);
  return JSON.stringify(parts);
}

// ...and set up alike: the same paper, and the same way of growing (a page
// that grows and one set to its size draw the same until the first grows).
export function sameSheet(a, b) {
  return sheetDrawKey(a) === sheetDrawKey(b) && sheetFit(a) === sheetFit(b);
}

// The first paper a setup draws exactly as, or null. A page whose setup is
// one is drawn by the first papers' own stream, so a Canvas whose pages are
// all of them is the very file it always was.
export function sheetLegacyKind(setup) {
  const s = normalizeSheetSetup(setup);
  if (!SHEET_LEGACY_KINDS.includes(s.pattern) || s.fit === "boundless") return null;
  return sameSheet(s, legacySheetSetup(s.pattern)) ? s.pattern : null;
}

// The page's box in PDF user space: its top-left corner always at (0, 842).
export function sheetBox(setup) {
  const s = normalizeSheetSetup(setup);
  return [0, sheetRound(CANVAS_SHEET_TOP - s.h), s.w, CANVAS_SHEET_TOP];
}

// ── Per page ───────────────────────────────────────────────────────────────

// The setup page `n` of a Canvas record is drawn with: its own, else the
// Canvas's, else the first paper the record names.
export function sheetSetupForPage(record, n) {
  const own = record?.pageSetups && typeof record.pageSetups === "object" ? record.pageSetups[String(n)] : null;
  const raw = own || (record?.setup && typeof record.setup === "object" ? record.setup : null);
  return raw ? normalizeSheetSetup(raw) : legacySheetSetup(legacyPaperKind(record?.paper));
}

// The setup every page without its own is drawn with.
export function canvasWideSheetSetup(record) {
  const raw = record?.setup && typeof record.setup === "object" ? record.setup : null;
  return raw ? normalizeSheetSetup(raw) : legacySheetSetup(legacyPaperKind(record?.paper));
}

// Every page's box, in order: what the page surface lays the Canvas out at
// before a page has rendered and said its own size.
export function canvasPageBoxes(record) {
  const count = Math.max(0, Math.round(Number(record?.pages) || 0));
  const boxes = [];
  for (let n = 1; n <= count; n += 1) boxes.push(canvasPageBox(record, n));
  return boxes;
}

// The setup's own fit: "grow", "set" or "boundless".
export function sheetFit(setup) {
  return fitOf(setup?.fit);
}

// A stored box, if it is one: four finite numbers, a real width and height.
export function validPageBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map(Number);
  if (!n.every(Number.isFinite) || !(n[2] - n[0] >= 1) || !(n[3] - n[1] >= 1)) return null;
  return n.map(sheetRound);
}

// Where page `n` reaches: the box it has grown to (`pageBoxes`, written by
// src/documents/notebook.js from what is on it), or the size it is set up at.
// A page set to its size has no box of its own — a stored box beside one (a
// setup changed on another device) is not read.
export function canvasPageBox(record, n) {
  const setup = sheetSetupForPage(record, n);
  const own = setup.fit !== "set" && record?.pageBoxes && typeof record.pageBoxes === "object"
    ? validPageBox(record.pageBoxes[String(n)])
    : null;
  return own || sheetBox(setup);
}

// The box page `n`'s size is MEASURED by — the widest a Block grows, the width
// a dropped picture lands at, the width the Canvas is fitted to the screen by:
// the size it is set up at, never the size it has grown to, so a page that
// grows does not widen its Blocks or zoom the Canvas out.
export function canvasMeasureBox(record, n) {
  return sheetBox(sheetSetupForPage(record, n));
}

// The page setups after the pages moved: `move` is the rule the Canvas's
// records are renumbered by (src/documents/notebook.js, remapNotebookPages) —
// a page number in, the page it is now out, or null for a page torn out.
export function remapPageSetups(map, move) {
  if (!map || typeof map !== "object") return null;
  const out = {};
  Object.keys(map).forEach((key) => {
    const to = move({ page: Number(key) });
    if (to && map[key] && typeof map[key] === "object") out[String(to)] = map[key];
  });
  return Object.keys(out).length ? out : null;
}

// The squares a dragged box settles onto, or null for paper without them.
export function canvasSnapGridFor(setup) {
  const s = normalizeSheetSetup(setup);
  if (s.pattern !== "grid" && s.pattern !== "dots") return null;
  return { pitch: s.pitch, origin: [0, 0] };
}

function sheetMmText(pt) {
  const mm = Math.round((pt / SHEET_PT_PER_MM) * 10) / 10;
  return String(mm);
}

// "A4 portrait · Ruled 8.5 mm", for the menu row that opens the dialog.
export function sheetSetupSummary(setup) {
  const s = normalizeSheetSetup(setup);
  const size = sheetSizeById(s.size);
  const name = size ? size.label : `${sheetMmText(s.w)} × ${sheetMmText(s.h)} mm`;
  const turn = s.w > s.h ? "landscape" : (s.w === s.h ? "" : "portrait");
  const paper = s.pattern === "blank" ? "Blank" : `${SHEET_PATTERN_LABEL[s.pattern]} ${sheetMmText(s.pitch)} mm`;
  if (s.fit === "boundless") return `Boundless · ${paper}`;
  return `${name}${turn ? ` ${turn}` : ""}${s.fit === "set" ? ", set size" : ""} · ${paper}`;
}

// ── Drawing ────────────────────────────────────────────────────────────────

// Whole multiples of the spacing strictly inside (lo, hi), with their index —
// the lattice every line and dot is on.
function sheetLattice(pitch, lo, hi) {
  const out = [];
  if (!(pitch > 0) || !(hi > lo)) return out;
  for (let k = Math.ceil(lo / pitch); k * pitch <= hi; k += 1) {
    const at = sheetRound(k * pitch);
    if (at > lo + 0.01 && at < hi - 0.01) out.push({ k, at });
  }
  return out;
}

function sheetMix(lineHex, paperHex, opacity) {
  const line = sheetRgb(lineHex);
  const paper = sheetRgb(paperHex);
  return line.map((v, i) => Math.round((paper[i] + ((v - paper[i]) * opacity)) * 1000) / 1000);
}

function sheetDashArray(dash, width) {
  if (dash === "dashed") return { dash: [sheetRound(Math.max(2, width * 6)), sheetRound(Math.max(1.5, width * 4))], cap: 0 };
  if (dash === "dotted") return { dash: [0.01, sheetRound(Math.max(1.5, width * 4))], cap: 1 };
  return { dash: null, cap: 0 };
}

// What a setup draws, as plain geometry: the page's box and paper colour, and
// groups of segments that share a colour, a width, a dash and a cap. The PDF
// stream and the dialog's preview are both written from this, so the preview
// is the page.
//
// `box` is where the page reaches when that is not the size it is set up at —
// a page grown longer or wider, or a Boundless page (src/documents/
// canvas-extent.js). The lines are the same lattice from (0, 0) whatever the
// box, and the margins are kept from its outer edges, so a page that grows
// keeps every line under the words already on it.
export function sheetOps(setup, boxIn = null) {
  const s = normalizeSheetSetup(setup);
  const box = validPageBox(boxIn) || sheetBox(s);
  const [x0, y0, x1, y1] = box;
  const m = s.margins;
  const area = [x0 + m.left, y0 + m.bottom, x1 - m.right, y1 - m.top];
  const groups = [];
  const lineGroup = (opacity, width, dashKind = s.dash) => {
    const { dash, cap } = sheetDashArray(dashKind, width);
    const group = { color: sheetMix(s.line, s.paper, opacity), width: sheetRound(width), dash, cap, segs: [] };
    groups.push(group);
    return group;
  };

  if (s.pattern === "ruled") {
    const rules = lineGroup(s.opacity, s.width);
    sheetLattice(s.pitch, area[1], area[3]).forEach(({ at }) => rules.segs.push([area[0], at, area[2], at]));
    // The margin line, down the whole page where the rules start — drawn at
    // full strength in its own colour, as the first ruled paper's was.
    if (s.marginLine.on && m.left > 0) {
      groups.push({ color: sheetMix(s.marginLine.color, s.paper, 1), width: sheetRound(s.width + 0.1), dash: null, cap: 0, segs: [[area[0], y0, area[0], y1]] });
    }
  } else if (s.pattern === "grid") {
    const minor = lineGroup(s.opacity, s.width);
    const major = s.majorEvery ? lineGroup(s.majorOpacity, s.width * 2) : null;
    const pick = (k) => (major && (((k % s.majorEvery) + s.majorEvery) % s.majorEvery === 0) ? major : minor);
    sheetLattice(s.pitch, area[0], area[2]).forEach(({ k, at }) => pick(k).segs.push([at, area[1], at, area[3]]));
    sheetLattice(s.pitch, area[1], area[3]).forEach(({ k, at }) => pick(k).segs.push([area[0], at, area[2], at]));
  } else if (s.pattern === "dots") {
    // A dot is a round-capped segment a hundredth of a point long: a
    // zero-length one is dropped by the canvas pdf.js draws on.
    const ys = sheetLattice(s.pitch, area[1], area[3]);
    const xs = sheetLattice(s.pitch, area[0], area[2]);
    if (s.fit === "boundless" || box.some((v, i) => Math.abs(v - sheetBox(s)[i]) >= 0.01)) {
      // A page that grows can be a poster, and a dot each is a megabyte of
      // them. So each row is ONE line whose dashes are the dots: a dash a
      // hundredth of a point long every `pitch`, round-capped — the dotted
      // line style's own trick — starting on the lattice. Rows, not dots: the
      // file grows with the page's length, not its area.
      const rows = { color: sheetMix(s.line, s.paper, s.opacity), width: s.dot, dash: [0.01, sheetRound(s.pitch - 0.01)], cap: 1, segs: [] };
      groups.push(rows);
      if (xs.length) {
        const first = xs[0].at;
        const last = xs[xs.length - 1].at;
        ys.forEach(({ at: y }) => rows.segs.push([first, y, sheetRound(last + 0.01), y]));
      }
    } else {
      const dots = { color: sheetMix(s.line, s.paper, s.opacity), width: s.dot, dash: null, cap: 1, segs: [] };
      groups.push(dots);
      xs.forEach(({ at: x }) => {
        ys.forEach(({ at: y }) => dots.segs.push([x, y, sheetRound(x + 0.01), y]));
      });
    }
  } else if (s.pattern === "cornell") {
    // The header band above the top margin, the summary box at the foot, the
    // cue column down the left, and rules across all of it on the lattice.
    const rules = lineGroup(s.opacity, s.width);
    const dividers = lineGroup(s.majorOpacity, s.width * 2, "solid");
    const summaryAt = s.summary > 0 ? sheetRound(area[1] + s.summary) : null;
    const cueAt = s.cue > 0 ? sheetRound(area[0] + s.cue) : null;
    sheetLattice(s.pitch, area[1], area[3]).forEach(({ at }) => {
      if (summaryAt !== null && Math.abs(at - summaryAt) < 1) return;
      rules.segs.push([area[0], at, area[2], at]);
    });
    if (m.top > 0) dividers.segs.push([x0, area[3], x1, area[3]]);
    if (summaryAt !== null) dividers.segs.push([x0, summaryAt, x1, summaryAt]);
    if (cueAt !== null) dividers.segs.push([cueAt, summaryAt ?? area[1], cueAt, area[3]]);
  }
  return { box, paper: sheetRgb(s.paper), groups: groups.filter((group) => group.segs.length) };
}

// A number as a content stream wants it — the same form blank-pdf.js writes.
function sheetPdfNumber(value) {
  return String(Number(Number(value).toFixed(2)));
}

function sheetPdfColor(rgb) {
  return rgb.map((v) => String(Number(Number(v).toFixed(3)))).join(" ");
}

// The page as a PDF content stream: ASCII operators and numbers only, so the
// one-byte-per-character file blank-pdf.js builds stays true.
export function sheetPdfStream(setup, pageBox = null) {
  const { box, paper, groups } = sheetOps(setup, pageBox);
  const n = sheetPdfNumber;
  const [x0, y0, x1, y1] = box;
  const out = [`${sheetPdfColor(paper)} rg`, `${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)} re`, "f"];
  groups.forEach((group) => {
    out.push("q", `${sheetPdfColor(group.color)} RG`, `${n(group.width)} w`);
    if (group.cap) out.push(`${group.cap} J`);
    if (group.dash) out.push(`[${group.dash.map(n).join(" ")}] 0 d`);
    group.segs.forEach(([ax, ay, bx, by]) => out.push(`${n(ax)} ${n(ay)} m ${n(bx)} ${n(by)} l`));
    out.push("S", "Q");
  });
  return out.join("\n");
}

// The page as SVG, for the dialog's preview. `crop` is a part of the page in
// user space to show instead of all of it; `minStroke` is the thinnest line
// worth drawing, in user units, so a whole page shrunk to a thumbnail still
// shows its lines rather than a blank.
export function sheetSvg(setup, { crop = null, minStroke = 0, box: pageBox = null } = {}) {
  const { box, paper, groups } = sheetOps(setup, pageBox);
  const [x0, y0, x1, y1] = crop || box;
  const w = x1 - x0;
  const h = y1 - y0;
  const n = sheetPdfNumber;
  // SVG's y runs down from the top, the page's up from the bottom.
  const px = (x) => n(x - x0);
  const py = (y) => n(y1 - y);
  const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  const [bx0, by0, bx1, by1] = box;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" preserveAspectRatio="xMidYMid meet">`,
    `<rect x="${px(bx0)}" y="${py(by1)}" width="${n(bx1 - bx0)}" height="${n(by1 - by0)}" fill="${rgb(paper)}"/>`
  ];
  groups.forEach((group) => {
    const d = group.segs.map(([ax, ay, bx, by]) => `M${px(ax)} ${py(ay)}L${px(bx)} ${py(by)}`).join("");
    const width = Math.max(group.width, minStroke);
    const dash = group.dash ? ` stroke-dasharray="${group.dash.map(n).join(" ")}"` : "";
    parts.push(`<path d="${d}" fill="none" stroke="${rgb(group.color)}" stroke-width="${n(width)}" stroke-linecap="${group.cap ? "round" : "butt"}"${dash}/>`);
  });
  parts.push("</svg>");
  return parts.join("");
}
