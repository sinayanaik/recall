// The PDF teleprompter: a PDF that scrolls by itself, at a speed the reader
// sets, under a band that marks the line to read — and in the order the page
// is read in, not just top to bottom.
//
// The note's teleprompter (src/notes/teleprompter.js) only has to scroll down:
// a note is one column of text. A PDF is a picture of a page, and a page set in
// two columns is read down the left one, back UP to the top of the right one,
// and only then on to the next page. So this one moves a CURSOR through the
// page's reading order (src/documents/pdf-reading-path.js — from the text layer
// where there is one, from a small picture of the page where it is a scan) and
// points the view at it: the line under the cursor sits on the band, and the
// column it is in is centred.
//
// ── The cursor and the camera ──────────────────────────────────────────────
//
// The cursor is a page, a segment of that page's reading path, and how far
// through the segment (0–1). Each frame moves it on by the segment's share of
// a minute at the speed set — a segment of 90 words at 180 words a minute takes
// half a minute, however tall it is drawn — and the camera (scrollTop and
// scrollLeft) is worked out from it afresh. Between one segment and the next
// (the foot of a column to the head of the next, one page to the next, over a
// figure) the camera GLIDES, briefly, with the band stepped back.
//
// ── Zooming to the column ──────────────────────────────────────────────────
//
// A column of a two-column paper is half a phone's width at fit-width, which is
// type too small to read on the move. With "Zoom to the column" on, a column
// segment is read at the zoom that makes the column fill the width (never
// larger type than is comfortable, never smaller than the reader had), and a
// full-width segment — a title, an abstract, a wide figure — at the reader's
// own zoom. The zoom changes only between segments, through setDocumentScale,
// and leaving puts the reader's own zoom back with their line where it was.
//
// A glide that only carries on down — the foot of a page to the head of the
// next in a one-column book, or past a figure — starts at the speed the text
// was moving and ends at the speed of what comes next (a cubic Hermite curve),
// with the band kept: an ease from standing still was a stop and a lurch at
// every page. One that changes column or zoom still eases in and out, with
// the band stepped back, because the eye has somewhere new to go.
//
// A glide or a zoom passes no words, and a page of short segments has many of
// them: at the speed set, every one was time added to the reading, so the
// words that really passed the band ran under the words a minute set — by more
// on a screen where the glides are longer. The word clock
// (src/notes/teleprompter-pace.js) counts that time as owed, and the segments
// after it are read up to a quarter faster until it is made up.
//
// As in Notes, scrollTop and scrollLeft hold whole pixels only, and the part of
// a pixel they cannot is a `translate` on the scroller while the frames run
// (placePdfSubPixel) — see the header of src/notes/teleprompter.js.
//
// ── By hand ────────────────────────────────────────────────────────────────
//
// "By hand" in the sheet keeps the band, the dimming and the column the band
// is narrowed to, and moves nothing: the reader scrolls. The band follows the
// column under it as they do (followManualScroll), and the zoom is theirs —
// never changed to fit a column, and kept as it is on leaving.
//
// ── Interrupting it ────────────────────────────────────────────────────────
//
// As the note's: a press, a touch or a wheel anywhere but its own controls
// stops it in the same tick, and the PDF is then simply the PDF — select,
// highlight, draw, pinch. ▶ carries on from whatever line is under the band by
// then, re-finding its place in the reading order from there.

import { el, isDisplayed } from "../core/dom.js?v=__BUILD__";
import { readerTouchDown, setDocumentAutoScrolling, touchGestureHoldsSurface, inkPenIsDown } from "../core/gesture.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { formatDuration } from "../stats/combine.js?v=__BUILD__";
import { readingTimeLeft } from "../stats/reading-progress.js?v=__BUILD__";
import { isFocusModeActive, setFocusMode } from "../ui/chrome.js?v=__BUILD__";
import { anyModalOpen } from "../ui/overlays.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { onDeckSwap } from "../notes/notes-view.js?v=__BUILD__";
import { WHEEL_LINES, glideScrollTo, isNotchedWheel, pendingGlidePx, stopGlide, wheelNotches } from "../notes/band-steps.js?v=__BUILD__";
import { clampToRange, measuredTeleprompterWpm } from "../notes/teleprompter.js?v=__BUILD__";
import {
  TELEPROMPTER_AUTO_RESUMES, TELEPROMPTER_COLUMNS, TELEPROMPTER_COUNTDOWNS, TELEPROMPTER_RANGES, TELEPROMPTER_SCROLLS,
  closeTeleprompterSheet, ensureTeleprompterPanel, isTeleprompterSheetOpen, paintTeleprompterPanel,
  placeTeleprompterBand, removeTeleprompterPanel, teleprompterPanelContains, toggleTeleprompterSheet, wakeTeleprompterBar
} from "../notes/teleprompter-panel.js?v=__BUILD__";
import {
  FRAME_COUNT_MAX_S, FRAME_MOVE_MAX_S, PACE_MAX, measuredClockWpm, newWordClock, paceFactor, rebaseWordClock,
  wordsDone, wordsDueFor
} from "../notes/teleprompter-pace.js?v=__BUILD__";
import { isInkArmed } from "./pdf-ink.js?v=__BUILD__";
import { isRegionSelectArmed } from "./pdf-region.js?v=__BUILD__";
import { buildPathFromBoxes, buildPathFromInk } from "./pdf-reading-path.js?v=__BUILD__";
import { keptTextItem, textItemBox, textItemShadows } from "./pdf-selection.js?v=__BUILD__";
import {
  PDF_MAX_SCALE, currentDocumentAcross, currentDocumentPage, currentDocumentResidual, documentPinchEngaged, documentSurfaceHidden,
  fitWidthScale, openDocumentSlot, openPdf, pageOffsetLeft, pageOffsetTop, pdfPageTextItems, scrollToDocumentPage,
  setDocumentReaderZoomHook, setDocumentScale, whenPageDrawsIdle
} from "./pdf-view.js?v=__BUILD__";

// ── Settings ────────────────────────────────────────────────────────────────
//
// Per device, like the note's, and kept apart from them: a dense paper is
// read slower than an article in Notes, and a phone wants a different band
// from a desktop monitor. In a library backup (src/backup/archive-format.js).
export const PDF_TELEPROMPTER_SETTINGS_KEY = "recall:pdf-teleprompter-v1";

// wpm 0 means "not chosen yet": the reader's measured speed, until they pick
// one of their own.
const PDF_TELEPROMPTER_DEFAULTS = {
  wpm: 0,
  bandPos: 35,
  bandSize: 2,
  dim: 35,
  band: true,
  columns: "auto",
  zoomColumn: true,
  countdown: 3,
  autoResume: 0,
  focus: true,
  wake: true,
  scroll: "auto"
};

const PDF_TELEPROMPTER_RANGE_KEYS = ["wpm", "bandPos", "bandSize", "dim"];

const PDF_TELEPROMPTER_FALLBACK_WPM = 200;

// How long the text takes to come up to speed, and to stop when ❚❚ is pressed.
const PDF_TP_RAMP_IN_S = 0.5;
const PDF_TP_RAMP_OUT_S = 0.25;

// The glide from one segment to the next: long enough to see where the view
// went, short enough not to be a wait.
const GLIDE_MIN_MS = 260;
const GLIDE_MAX_MS = 700;

// Zoom to the column: the type is never made bigger than this many CSS px a
// line (so a desktop does not blow a column up to poster size), the zoom is
// left alone when the column already fits within this share of it, and the
// view keeps this much room either side of the column.
const COLUMN_MAX_LINE_PX = 30;
const COLUMN_ZOOM_SLACK = 0.08;
const COLUMN_SIDE_ROOM = 10;

// The scan of a page without text: drawn this wide, in grey.
const INK_PICTURE_WIDTH = 720;

const PDF_TP_WATCH_MS = 250;

// By hand, a page's reading path is built once the scroll has been still this
// long — not for every page a fling passes on its way.
const MANUAL_PATH_SETTLE_MS = 150;

// What a change of zoom costs the time left: the layout at the new size and
// the frame after it, before the band moves on.
const ZOOM_LANDING_MS = 250;

let pdfTpSettingsCache = null;

function normalisePdfTeleprompterSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const out = { ...PDF_TELEPROMPTER_DEFAULTS };
  PDF_TELEPROMPTER_RANGE_KEYS.forEach((key) => {
    if (!(key in input)) return;
    if (key === "wpm" && Number(input[key]) === 0) return;
    const value = clampToRange(key, input[key]);
    if (value !== null) out[key] = value;
  });
  if (TELEPROMPTER_COLUMNS.some(([value]) => value === input.columns)) out.columns = input.columns;
  if (TELEPROMPTER_COUNTDOWNS.includes(Number(input.countdown))) out.countdown = Number(input.countdown);
  if (TELEPROMPTER_AUTO_RESUMES.includes(Number(input.autoResume))) out.autoResume = Number(input.autoResume);
  if (TELEPROMPTER_SCROLLS.some(([value]) => value === input.scroll)) out.scroll = input.scroll;
  ["band", "focus", "wake", "zoomColumn"].forEach((key) => {
    if (typeof input[key] === "boolean") out[key] = input[key];
  });
  return out;
}

export function readPdfTeleprompterSettings() {
  if (!pdfTpSettingsCache) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(PDF_TELEPROMPTER_SETTINGS_KEY) || "null"); } catch { raw = null; }
    pdfTpSettingsCache = normalisePdfTeleprompterSettings(raw);
  }
  return { ...pdfTpSettingsCache };
}

function writePdfTeleprompterSettings(next) {
  pdfTpSettingsCache = normalisePdfTeleprompterSettings(next);
  try { localStorage.setItem(PDF_TELEPROMPTER_SETTINGS_KEY, JSON.stringify(pdfTpSettingsCache)); } catch { /* this session only */ }
  return { ...pdfTpSettingsCache };
}

// ── Reading paths, one per page ─────────────────────────────────────────────
//
// Built on demand and kept for as long as the PDF is open (a WeakMap on the
// open document, so a different PDF starts afresh): the page the cursor is on
// first, the next one while it is being read.

const pathCaches = new WeakMap();

function pathCache(pdf) {
  let cache = pathCaches.get(pdf);
  if (!cache) {
    cache = new Map();
    pathCaches.set(pdf, cache);
  }
  return cache;
}

// The text items of a page as boxes in its own viewport at scale 1 (y down),
// with overprinted copies left out exactly as the text layer leaves them out.
function textBoxes(items, viewport) {
  const shadows = textItemShadows(items);
  const boxes = [];
  items.forEach((source, index) => {
    if (!source?.str || !source.transform) return;
    const item = keptTextItem(items, index, shadows);
    if (!item) return;
    const [a, b, c, d] = item.transform;
    // Text set on a slant or up the margin is not part of the reading order.
    if (Math.abs(b) > Math.abs(a) * 0.2 || Math.abs(c) > Math.abs(d) * 0.2) return;
    const words = (item.str.match(/\S+/g) || []).length;
    if (!words) return;
    const box = textItemBox(item);
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([box.x0, box.y0, box.x1, box.y1]);
    boxes.push({
      x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1),
      words, size: Math.abs(y1 - y0) || Math.hypot(c, d) || 10
    });
  });
  return boxes;
}

async function inkPicture(page, viewport) {
  const scale = INK_PICTURE_WIDTH / Math.max(1, viewport.width);
  const small = page.getViewport({ scale });
  const width = Math.max(1, Math.round(small.width));
  const height = Math.max(1, Math.round(small.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: context, viewport: small }).promise;
  const rgba = context.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) gray[j] = (rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11) | 0;
  canvas.width = 0;
  canvas.height = 0;
  return { gray, width, height };
}

// The path from the page's text layer alone: null for a page with too little
// text to go by, which is read from its picture instead.
async function buildTextPath(pdf, pageNumber, columns) {
  const page = await pdf.doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const items = pdfPageTextItems(pageNumber) || (await page.getTextContent()).items || [];
  return { page, viewport, path: buildPathFromBoxes(textBoxes(items, viewport), viewport.width, viewport.height, { columns }) };
}

async function buildPagePath(pdf, pageNumber, columns) {
  const { page, viewport, path: fromText } = await buildTextPath(pdf, pageNumber, columns);
  if (fromText) return fromText;
  const picture = await inkPicture(page, viewport);
  return buildPathFromInk(picture.gray, picture.width, picture.height, { columns })
    || { segments: [], columns: 1, gutter: null, source: "ink" };
}

// The path if it is ready, or undefined while it is being built (which asks
// for a frame when it is). A page that cannot be read at all has an empty path,
// and is skipped.
function pathFor(pageNumber) {
  if (!pdfSession) return undefined;
  const { pdf } = pdfSession;
  const key = `${pageNumber}:${pdfSession.settings.columns}`;
  const cache = pathCache(pdf);
  const known = cache.get(key);
  if (known && !known.then) return known;
  if (!known) {
    const columns = pdfSession.settings.columns;
    const pending = buildPagePath(pdf, pageNumber, columns)
      .catch(() => ({ segments: [], columns: 1, gutter: null, source: "none" }))
      .then((path) => {
        if (cache.get(key) === pending) cache.set(key, path);
        if (pdfSession?.pdf === pdf) {
          if (pdfSession.phase === "manual") followManualScroll();
          else schedulePdfFrame();
          paintPdfTeleprompter();
        }
        return path;
      });
    cache.set(key, pending);
  }
  return undefined;
}

// The path if it is already built, without asking for it.
function builtPath(pageNumber) {
  if (!pdfSession) return null;
  const known = pathCache(pdfSession.pdf).get(`${pageNumber}:${pdfSession.settings.columns}`);
  return known && !known.then ? known : null;
}

// ── The pages ahead, read in the background ─────────────────────────────────
//
// For the time left, which has to know how much is on every page still to
// come — not guess it from the one or two being read, where a title page or a
// page of figures threw it out by half. A page with a text layer gets its real
// path, put in the same cache the loop reads (so it is ready when the band
// gets there, too); one without is only marked as a scan, because its path is
// a picture to draw and that is not worth doing for a number.
//
// One page per idle moment, from the cursor on, never ahead of a page that is
// waiting to be drawn (whenPageDrawsIdle), and only while a session is open.
// The text itself is pulled out by pdf.js in its own worker.

const scanCaches = new WeakMap();

// "page:columns" for every page found to have no text layer worth reading.
function scanPagesOf(pdf) {
  let scans = scanCaches.get(pdf);
  if (!scans) {
    scans = new Set();
    scanCaches.set(pdf, scans);
  }
  return scans;
}

function readAheadWhenIdle() {
  const session = pdfSession;
  if (!session || session.readingAhead) return;
  session.readingAhead = true;
  const next = async () => {
    if (pdfSession !== session || openPdf !== session.pdf) return;
    const from = Math.max(1, session.cursor?.page || currentDocumentPage() || 1);
    const columns = session.settings.columns;
    const cache = pathCache(session.pdf);
    const scans = scanPagesOf(session.pdf);
    let pageNumber = 0;
    for (let n = from; n <= openPdf.pageCount; n += 1) {
      if (!cache.has(`${n}:${columns}`) && !scans.has(`${n}:${columns}`)) {
        pageNumber = n;
        break;
      }
    }
    if (!pageNumber) {
      session.readingAhead = false;
      return;
    }
    await whenPageDrawsIdle();
    if (pdfSession !== session || session.settings.columns !== columns) {
      if (pdfSession === session) session.readingAhead = false;
      if (pdfSession === session) readAheadWhenIdle();
      return;
    }
    try {
      const { path } = await buildTextPath(session.pdf, pageNumber, columns);
      const key = `${pageNumber}:${columns}`;
      if (path) {
        if (!cache.has(key)) cache.set(key, path);
      } else {
        scans.add(key);
      }
    } catch {
      scans.add(`${pageNumber}:${columns}`);
    }
    schedule();
  };
  const schedule = () => {
    if (pdfSession !== session) return;
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => { next(); }, { timeout: 3000 });
    else setTimeout(next, 50);
  };
  schedule();
}

// ── The session ─────────────────────────────────────────────────────────────

// null when there is none. Phases as the note's: "countdown" → "playing" ⇄
// "paused", and "ended" at the foot of the last page; or "manual" while the
// reader scrolls by hand.
let pdfSession = null;

let pdfTeleprompterChangedHook = null;

export function setPdfTeleprompterChangedHook(fn) {
  pdfTeleprompterChangedHook = typeof fn === "function" ? fn : null;
}

export function pdfTeleprompterActive() {
  return Boolean(pdfSession);
}

export function pdfTeleprompterOnScreen() {
  return Boolean(pdfSession) && surfaceShowsSession();
}

// For tools/pdf-teleprompter-check.mjs, and for nothing that changes behaviour.
export function pdfTeleprompterSnapshot() {
  if (!pdfSession) return null;
  const segment = currentSegment();
  return {
    phase: pdfSession.phase,
    wpm: pdfSession.wpm,
    pauseReason: pdfSession.pauseReason,
    cursor: pdfSession.cursor ? { ...pdfSession.cursor } : null,
    segment: segment ? { ...segment } : null,
    gliding: Boolean(pdfSession.glide),
    carrying: Boolean(pdfSession.glide?.carry),
    holding: pdfSession.holding,
    subPixel: { ...pdfSession.subPixel },
    pace: paceFactor(pdfSession.clock, pdfSession.wpm),
    wordsDue: pdfSession.clock.due,
    wordsDone: pdfSession.clock.done,
    measuredWpm: measuredClockWpm(pdfSession.clock),
    leftMs: pdfTimeLeftMs(),
    scale: openPdf?.scale || 0,
    baseScale: pdfSession.baseScale,
    settings: { ...pdfSession.settings }
  };
}

// For the same check: the reading path of a page, once it is built.
export function pdfTeleprompterPath(pageNumber) {
  return pdfSession ? pathFor(pageNumber) || null : null;
}

let pdfTpReducedMotionQuery = null;

function pdfTpReducedMotion() {
  if (!pdfTpReducedMotionQuery && typeof matchMedia === "function") pdfTpReducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  return Boolean(pdfTpReducedMotionQuery?.matches);
}

function surfaceShowsSession() {
  return state.viewMode === "document" && openDocumentSlot() === "doc" && !documentSurfaceHidden() && isDisplayed(el.documentView);
}

function sessionStillOpen() {
  return Boolean(pdfSession) && openPdf === pdfSession.pdf && currentDeckKey() === pdfSession.deckKey;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function tpPageBox(pageNumber) {
  const entry = openPdf?.pages?.get(pageNumber);
  if (!entry?.el) return null;
  return {
    top: pageOffsetTop(entry.el),
    left: pageOffsetLeft(entry.el),
    width: entry.el.offsetWidth,
    height: entry.el.offsetHeight
  };
}

// The page's size in PDF units, at scale 1.
function pageUnits(pageNumber) {
  const entry = openPdf?.pages?.get(pageNumber);
  const viewport = entry?.viewport;
  if (viewport) return { width: viewport.width / (viewport.scale || 1), height: viewport.height / (viewport.scale || 1) };
  return { width: openPdf?.baseWidth || 612, height: openPdf?.baseHeight || 792 };
}

function bandLine(view) {
  return Math.round(view.clientHeight * (pdfSession.settings.bandPos / 100));
}

function segmentAt(cursor) {
  if (!cursor) return null;
  const path = pathFor(cursor.page);
  return path?.segments?.[cursor.index] || null;
}

function currentSegment() {
  return pdfSession ? segmentAt(pdfSession.cursor) : null;
}

// The heights the band travels between in a segment: the middle of its first
// line to the middle of its last.
function segmentSpan(segment) {
  const half = segment.linePitch / 2;
  const start = Math.min(segment.y0 + half, (segment.y0 + segment.y1) / 2);
  const end = Math.max(start, segment.y1 - half);
  return { start, end };
}

function cursorY(cursor, segment) {
  const { start, end } = segmentSpan(segment);
  return start + (end - start) * cursor.t;
}

// Where the scroller must be for the cursor's line to sit on the band, with
// its column centred (or, for one wider than the window, its left edge in view).
function cameraFor(cursor) {
  const view = el.documentView;
  const segment = segmentAt(cursor);
  const box = tpPageBox(cursor.page);
  if (!view || !segment || !box) return null;
  const top = box.top + cursorY(cursor, segment) * box.height - bandLine(view);
  const columnLeft = box.left + segment.x0 * box.width;
  const columnWidth = (segment.x1 - segment.x0) * box.width;
  const left = columnWidth + COLUMN_SIDE_ROOM * 2 <= view.clientWidth
    ? columnLeft + columnWidth / 2 - view.clientWidth / 2
    : columnLeft - COLUMN_SIDE_ROOM;
  return {
    top: Math.max(0, Math.min(view.scrollHeight - view.clientHeight, top)),
    left: Math.max(0, Math.min(view.scrollWidth - view.clientWidth, left))
  };
}

// The zoom a segment is read at.
function targetScale(segment, pageNumber) {
  const current = openPdf?.scale || 1;
  const base = pdfSession.baseScale || current;
  if (!pdfSession.settings.zoomColumn || segment.kind !== "column") return base;
  if (pdfSession.columnScale) return pdfSession.columnScale;
  const view = el.documentView;
  const units = pageUnits(pageNumber);
  const columnUnits = Math.max(1, (segment.x1 - segment.x0) * units.width);
  const lineUnits = Math.max(1, segment.linePitch * units.height);
  const fit = (view.clientWidth - COLUMN_SIDE_ROOM * 2) / columnUnits;
  const comfortable = COLUMN_MAX_LINE_PX / lineUnits;
  return Math.max(base, Math.min(PDF_MAX_SCALE, fit, comfortable));
}

function scaleDiffers(next) {
  const current = openPdf?.scale || 1;
  return Math.abs(next - current) / current > COLUMN_ZOOM_SLACK;
}

// ── The cursor, from where the view is ──────────────────────────────────────

function pageUnderLine(view, y) {
  if (!openPdf) return 0;
  const guess = currentDocumentPage() || 1;
  const fits = (n) => {
    const box = tpPageBox(n);
    return box && y >= box.top - 8 && y < box.top + box.height + 8;
  };
  for (let n = Math.max(1, guess - 1); n <= Math.min(openPdf.pageCount, guess + 4); n += 1) if (fits(n)) return n;
  for (let n = 1; n <= openPdf.pageCount; n += 1) if (fits(n)) return n;
  // In the gap below the last page, or above the first.
  const first = tpPageBox(1);
  return first && y < first.top ? 1 : openPdf.pageCount;
}

// The segment of `path` a point on the page (fractions) is in, or the next one
// in reading order after it. null when the point is past the page's last.
function cursorOnPage(pageNumber, path, fx, fy) {
  const segments = path.segments;
  const inside = (segment) => fy >= segment.y0 && fy <= segment.y1;
  const across = (segment) => fx >= segment.x0 && fx <= segment.x1;
  let index = segments.findIndex((segment) => inside(segment) && across(segment));
  if (index < 0) index = segments.findIndex(inside);
  if (index < 0) index = segments.findIndex((segment) => segment.y0 > fy && across(segment));
  if (index < 0) index = segments.findIndex((segment) => segment.y0 >= fy);
  if (index < 0) return null;
  const { start, end } = segmentSpan(segments[index]);
  const t = end > start ? Math.max(0, Math.min(1, (fy - start) / (end - start))) : 0;
  return { page: pageNumber, index, t };
}

// The cursor for the line under the band now. undefined while the page's path
// is still being built; null past the end of the PDF.
function cursorFromView() {
  const view = el.documentView;
  if (!view || !openPdf) return null;
  const y = view.scrollTop + bandLine(view);
  const pageNumber = pageUnderLine(view, y);
  const box = tpPageBox(pageNumber);
  const path = pathFor(pageNumber);
  if (!box || !path) return undefined;
  const fy = (y - box.top) / Math.max(1, box.height);
  const fx = (view.scrollLeft + view.clientWidth / 2 - box.left) / Math.max(1, box.width);
  return cursorOnPage(pageNumber, path, fx, fy) || firstCursorFrom(pageNumber + 1);
}

// The first segment on this page or any after it. undefined while a page on
// the way is still being built; null when there is none to the end.
function firstCursorFrom(pageNumber) {
  if (!openPdf) return null;
  for (let n = pageNumber; n <= openPdf.pageCount; n += 1) {
    const path = pathFor(n);
    if (!path) return undefined;
    if (path.segments.length) return { page: n, index: 0, t: 0 };
  }
  return null;
}

function nextCursor(cursor) {
  const path = pathFor(cursor.page);
  if (path && cursor.index + 1 < path.segments.length) return { page: cursor.page, index: cursor.index + 1, t: 0 };
  return firstCursorFrom(cursor.page + 1);
}

// ── The band and the runway ─────────────────────────────────────────────────

function placePdfBand() {
  const view = el.documentView;
  if (!pdfSession || !view || !view.clientHeight) return;
  const segment = currentSegment();
  const box = pdfSession.cursor ? tpPageBox(pdfSession.cursor.page) : null;
  const line = segment && box ? segment.linePitch * box.height : 24;
  const bandHeight = Math.round(Math.min(view.clientHeight, Math.max(12, line * pdfSession.settings.bandSize)));
  const centre = bandLine(view);
  const bandTop = Math.round(Math.max(0, Math.min(view.clientHeight - bandHeight, centre - bandHeight / 2)));
  let bandLeft = null;
  let bandWidth = null;
  if (segment && box) {
    // By hand the view is wherever the reader put it, not where the camera
    // would; otherwise where the camera is going, so the band is there first.
    const camera = pdfSession.phase === "manual" ? null : cameraFor(pdfSession.cursor);
    const scrollLeft = camera ? camera.left : view.scrollLeft;
    const left = box.left + segment.x0 * box.width - scrollLeft - COLUMN_SIDE_ROOM;
    const right = box.left + segment.x1 * box.width - scrollLeft + COLUMN_SIDE_ROOM;
    bandLeft = Math.max(0, Math.round(left));
    bandWidth = Math.max(0, Math.round(Math.min(view.clientWidth, right) - bandLeft));
  }
  placeTeleprompterBand({
    top: view.offsetTop,
    left: view.offsetLeft,
    width: view.clientWidth,
    height: view.clientHeight,
    bandTop,
    bandHeight,
    bandLeft,
    bandWidth,
    dim: pdfSession.settings.dim,
    showBand: pdfSession.settings.band
  });
}

// Room above the first page and below the last, so the first line can start
// on the band and the last can reach it. Adding it moves every page down by
// the same amount, and scrollTop takes the same change so nothing on screen
// moves.
function sizeRunway() {
  const view = el.documentView;
  const first = openPdf?.pages?.get(1)?.el;
  if (!pdfSession || !view || !first) return;
  const before = pageOffsetTop(first);
  const line = bandLine(view);
  view.style.setProperty("--tp-lead", `${line}px`);
  view.style.setProperty("--tp-runout", `${Math.max(0, view.clientHeight - line)}px`);
  const delta = pageOffsetTop(first) - before;
  if (delta && view.scrollTop > 0) writeScroll(view, view.scrollTop + delta, view.scrollLeft);
}

function clearRunway(view) {
  const first = openPdf?.pages?.get(1)?.el;
  const before = first ? pageOffsetTop(first) : 0;
  view.style.removeProperty("--tp-lead");
  view.style.removeProperty("--tp-runout");
  view.classList.remove("is-teleprompter");
  const delta = first ? pageOffsetTop(first) - before : 0;
  if (delta) view.scrollTop = Math.max(0, view.scrollTop + delta);
}

function setGliding(on) {
  const tpOverlay = el.documentStage?.querySelector(":scope > .tp-overlay");
  tpOverlay?.classList.toggle("is-gliding", Boolean(on));
}

// `fine`: the loop moving the view, which puts the whole pixels in the scroll
// and the rest in placePdfSubPixel. Every other write — a jump, a landing, a
// runway — is whole, and takes any fraction away.
function writeScroll(view, top, left, { fine = false } = {}) {
  const wholeTop = fine ? Math.floor(top) : top;
  const wholeLeft = fine ? Math.floor(left) : left;
  view.scrollTop = wholeTop;
  view.scrollLeft = wholeLeft;
  if (pdfSession) {
    pdfSession.lastTop = view.scrollTop;
    pdfSession.lastLeft = view.scrollLeft;
  }
  if (fine && pdfSession && !pdfTpReducedMotion()) {
    placePdfSubPixel(view,
      view.scrollTop === wholeTop ? top - wholeTop : 0,
      view.scrollLeft === wholeLeft ? left - wholeLeft : 0);
  } else {
    clearPdfSubPixel(view);
  }
}

// ── The part of a pixel ─────────────────────────────────────────────────────
//
// As the note's (src/notes/teleprompter.js): the `translate` property on the
// scroller, with `will-change` so the compositor moves the pages it has rather
// than drawing them again. A transformed box is the offsetParent of the pages
// inside it, which pageOffsetTop and pageOffsetLeft (pdf-view.js) allow for.

function placePdfSubPixel(view, fractionTop, fractionLeft) {
  const top = Math.round(fractionTop * 100) / 100;
  const left = Math.round(fractionLeft * 100) / 100;
  const shown = pdfSession.subPixel;
  if (shown.on && shown.top === top && shown.left === left) return;
  if (!shown.on) view.style.willChange = "translate";
  pdfSession.subPixel = { on: true, top, left };
  view.style.translate = `${-left}px ${-top}px`;
}

function clearPdfSubPixel(view) {
  if (!pdfSession?.subPixel.on || !view) return;
  pdfSession.subPixel = { on: false, top: 0, left: 0 };
  view.style.translate = "";
  view.style.willChange = "";
}

function viewMovedByOther(view) {
  return Math.abs(view.scrollTop - pdfSession.lastTop) > 2 || Math.abs(view.scrollLeft - pdfSession.lastLeft) > 2;
}

// ── Zoom ────────────────────────────────────────────────────────────────────

// Changes the zoom for the segment the cursor is now in, and lands the cursor's
// line on the band at the new size. The loop stands still meanwhile.
function zoomForCursor(scale) {
  const owner = pdfSession;
  owner.holding += 1;
  setGliding(true);
  setDocumentAutoScrolling(false);
  setDocumentScale(scale, {
    afterLayout: () => {
      if (pdfSession !== owner) return;
      sizeRunway();
      const camera = cameraFor(owner.cursor);
      if (camera) writeScroll(el.documentView, camera.top, camera.left);
      owner.appliedScale = openPdf?.scale || scale;
      requestAnimationFrame(() => {
        if (pdfSession !== owner) return;
        // A second look once the pages have their new sizes for certain.
        const again = cameraFor(owner.cursor);
        if (again) writeScroll(el.documentView, again.top, again.left);
        owner.holding = Math.max(0, owner.holding - 1);
        setGliding(false);
        placePdfBand();
        schedulePdfFrame();
      });
    }
  });
}

// How fast the camera goes down through a segment at full speed, in px a ms:
// its span over the time its words take, at the word clock's pace.
function segmentVelocity(cursor) {
  const segment = segmentAt(cursor);
  const box = cursor ? tpPageBox(cursor.page) : null;
  if (!segment || !box) return 0;
  const { start, end } = segmentSpan(segment);
  return ((end - start) * box.height * paceFactor(pdfSession.clock, pdfSession.wpm)) / (segmentSeconds(segment) * 1000);
}

function segmentSeconds(segment) {
  return Math.max(0.5, (segment.words / Math.max(1, pdfSession.wpm)) * 60);
}

function glideMs(distance, view) {
  return Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, (distance / Math.max(1, view.clientHeight)) * 450));
}

// Moves the cursor to `next` and the camera after it: a zoom if the segment
// wants one, a glide if the camera has somewhere to go, or nothing.
function moveCursorTo(next, { glide = true } = {}) {
  const view = el.documentView;
  const previous = pdfSession.cursor;
  pdfSession.cursor = next;
  pathFor(next.page + 1);
  const segment = segmentAt(next);
  if (!segment) return;
  const scale = targetScale(segment, next.page);
  if (scaleDiffers(scale)) {
    pdfSession.glide = null;
    zoomForCursor(scale);
    return;
  }
  const camera = cameraFor(next);
  if (!camera) return;
  const distance = Math.hypot(camera.top - view.scrollTop, camera.left - view.scrollLeft);
  if (!glide || distance < 4 || pdfTpReducedMotion()) {
    pdfSession.glide = null;
    writeScroll(view, camera.top, camera.left, { fine: true });
    placePdfBand();
    return;
  }
  const ms = glideMs(distance, view);
  const fromTop = view.scrollTop + pdfSession.subPixel.top;
  const fromLeft = view.scrollLeft + pdfSession.subPixel.left;
  // Carrying on down the same column: leave at the speed the text was going
  // and arrive at the speed of what comes next, the band kept up.
  const rise = camera.top - fromTop;
  if (previous && rise > 0 && Math.abs(camera.left - fromLeft) < 4) {
    // Held where a cubic Hermite curve cannot overshoot (α² + β² ≤ 9).
    const limit = (2 * rise) / ms;
    pdfSession.glide = {
      fromTop, fromLeft, start: performance.now(), ms, carry: true,
      v0: Math.min(limit, segmentVelocity(previous) * pdfSession.ease),
      v1: Math.min(limit, segmentVelocity(next))
    };
    return;
  }
  pdfSession.glide = { fromTop, fromLeft, start: performance.now(), ms };
  setGliding(true);
}

function easeInOut(x) {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

// Where a glide has the view at `progress` (0–1) of the way.
function glideTop(glide, to, progress) {
  if (!glide.carry) return glide.fromTop + (to - glide.fromTop) * easeInOut(progress);
  const p = progress;
  const p2 = p * p;
  const p3 = p2 * p;
  return (2 * p3 - 3 * p2 + 1) * glide.fromTop + (p3 - 2 * p2 + p) * glide.ms * glide.v0
    + (-2 * p3 + 3 * p2) * to + (p3 - p2) * glide.ms * glide.v1;
}

// ── The frame ───────────────────────────────────────────────────────────────

function schedulePdfFrame() {
  if (!pdfSession || pdfSession.frame) return;
  pdfSession.frame = requestAnimationFrame(pdfFrame);
}

function stopFrames() {
  if (pdfSession?.frame) cancelAnimationFrame(pdfSession.frame);
  if (pdfSession) {
    pdfSession.frame = 0;
    pdfSession.lastFrameAt = 0;
    clearPdfSubPixel(el.documentView);
  }
  setDocumentAutoScrolling(false);
}

function stepGlide(view, now) {
  const glide = pdfSession.glide;
  const camera = cameraFor(pdfSession.cursor);
  const progress = Math.min(1, (now - glide.start) / glide.ms);
  if (camera) {
    writeScroll(view,
      glideTop(glide, camera.top, progress),
      glide.fromLeft + (camera.left - glide.fromLeft) * easeInOut(progress),
      { fine: true });
  }
  if (progress >= 1) {
    pdfSession.glide = null;
    setGliding(false);
    placePdfBand();
  }
}

function pdfFrame(now) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  pdfSession.frame = 0;
  if (!sessionStillOpen() || !surfaceShowsSession() || document.hidden) {
    clearPdfSubPixel(view);
    setDocumentAutoScrolling(false);
    watchPdfTeleprompter();
    return;
  }
  // The time the view moves by, and the time the word clock counts — see
  // src/notes/teleprompter-pace.js.
  const elapsed = pdfSession.lastFrameAt ? (now - pdfSession.lastFrameAt) / 1000 : 0;
  const dt = Math.min(FRAME_MOVE_MAX_S, elapsed);
  const counted = Math.min(FRAME_COUNT_MAX_S, elapsed);
  pdfSession.lastFrameAt = now;
  const target = pdfSession.phase === "playing" ? 1 : 0;
  if (pdfTpReducedMotion()) pdfSession.ease = target;
  else if (target > pdfSession.ease) pdfSession.ease = Math.min(target, pdfSession.ease + dt / PDF_TP_RAMP_IN_S);
  else pdfSession.ease = Math.max(target, pdfSession.ease - dt / PDF_TP_RAMP_OUT_S);
  if (!target && pdfSession.ease <= 0) {
    stopFrames();
    return;
  }
  const playing = pdfSession.phase === "playing";
  // A zoom is landing, or a pinch is under way: stand still. The landing is
  // the loop's own doing, and its time is owed; a pinch is the reader's.
  if (pdfSession.holding || documentPinchEngaged()) {
    if (playing && pdfSession.holding && !documentPinchEngaged()) wordsDueFor(pdfSession.clock, pdfSession.wpm, pdfSession.ease, counted);
    clearPdfSubPixel(view);
    setDocumentAutoScrolling(false);
    schedulePdfFrame();
    return;
  }
  // Somebody else moved the view (the reader while paused, a jump from the
  // contents, a re-fit): carry on from the line that is under the band now.
  if (!pdfSession.cursor || (viewMovedByOther(view) && !pdfSession.glide)) {
    const found = cursorFromView();
    if (found === undefined) {
      setDocumentAutoScrolling(false);
      schedulePdfFrame();
      return;
    }
    if (found === null) {
      finishPdfTeleprompter();
      return;
    }
    pdfSession.lastTop = view.scrollTop;
    pdfSession.lastLeft = view.scrollLeft;
    pdfSession.landing = false;
    // Carrying on from somewhere new: nothing before this is owed.
    rebaseWordClock(pdfSession.clock);
    moveCursorTo(found);
    if (pdfSession.holding) {
      schedulePdfFrame();
      return;
    }
  }
  const segment = currentSegment();
  if (!segment) {
    setDocumentAutoScrolling(false);
    schedulePdfFrame();
    return;
  }
  // The first frame after ▶: the cursor's line is brought to the band (a zoom
  // or a glide, if it is not there already) before anything moves on.
  if (pdfSession.landing) {
    pdfSession.landing = false;
    moveCursorTo(pdfSession.cursor);
    schedulePdfFrame();
    return;
  }
  setDocumentAutoScrolling(true);
  if (pdfSession.glide) {
    if (playing) wordsDueFor(pdfSession.clock, pdfSession.wpm, pdfSession.ease, counted);
    stepGlide(view, now);
    schedulePdfFrame();
    return;
  }
  // Through the segment at the speed set: its words at so many a minute, and
  // a little faster while the word clock is owed a glide's time. Not owed:
  // the wait at a segment's end while the next page's path is being built.
  const seconds = segmentSeconds(segment);
  const fromT = pdfSession.cursor.t;
  if (playing && fromT < 1) wordsDueFor(pdfSession.clock, pdfSession.wpm, pdfSession.ease, counted);
  pdfSession.cursor.t = Math.min(1, fromT + (pdfSession.ease * paceFactor(pdfSession.clock, pdfSession.wpm) * dt) / seconds);
  if (playing) wordsDone(pdfSession.clock, (pdfSession.cursor.t - fromT) * segment.words, pdfSession.ease >= 1);
  if (pdfSession.cursor.t >= 1 && pdfSession.phase === "playing") {
    const next = nextCursor(pdfSession.cursor);
    if (next === null) {
      const camera = cameraFor(pdfSession.cursor);
      if (camera) writeScroll(view, camera.top, camera.left);
      finishPdfTeleprompter();
      return;
    }
    if (next) {
      moveCursorTo(next);
      // A glide's first step is taken in this frame, on the frame's own clock,
      // as though it had begun with it: a frame that stood still here was a
      // stop at every page turn.
      if (pdfSession.glide && !pdfSession.holding) {
        pdfSession.glide.start = now - dt * 1000;
        stepGlide(view, now);
      }
      schedulePdfFrame();
      return;
    }
    // The next page's path is still being built: wait at the end of this one.
  }
  const camera = cameraFor(pdfSession.cursor);
  if (camera) writeScroll(view, camera.top, camera.left, { fine: true });
  schedulePdfFrame();
}

// ── The screen, kept on ─────────────────────────────────────────────────────

async function holdPdfScreenAwake() {
  if (!pdfSession || !pdfSession.settings.wake || pdfSession.wakeLock || pdfSession.wakeRequested) return;
  if (typeof navigator === "undefined" || !navigator.wakeLock?.request) return;
  const owner = pdfSession;
  owner.wakeRequested = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    owner.wakeRequested = false;
    if (pdfSession !== owner || (owner.phase !== "playing" && owner.phase !== "manual") || !owner.settings.wake) {
      lock.release?.().catch?.(() => {});
      return;
    }
    owner.wakeLock = lock;
    lock.addEventListener?.("release", () => {
      if (owner.wakeLock === lock) owner.wakeLock = null;
    });
  } catch {
    owner.wakeRequested = false;
  }
}

function letPdfScreenSleep() {
  const lock = pdfSession?.wakeLock;
  if (pdfSession) pdfSession.wakeLock = null;
  try { lock?.release?.()?.catch?.(() => {}); } catch { /* already released */ }
}

// ── Painting ────────────────────────────────────────────────────────────────

const PDF_TP_STATUS_TEXT = {
  countdown: "Starting",
  paused: "Paused",
  ended: "End of the PDF",
  manual: "Scrolling by hand"
};

// ── The time left ───────────────────────────────────────────────────────────
//
// What the loop will spend from here, worked out the way it spends it: each
// segment its words at the speed set, never under half a second; each move
// from one segment to the next the glide it takes; each change between a
// column and the full width, a zoom. Every page ahead is counted from its own
// reading path — read in the background (readAheadWhenIdle) — and only a page
// not read yet, or a scan whose path is a picture not drawn yet, is taken at
// the average of the pages that are.

// The room between two pages (.pdf-pages' gap).
const PAGE_GAP_PX = 16;

function transitionMs(from, to, box, view, nextPage) {
  if (pdfSession.settings.zoomColumn && (from.kind === "column") !== (to.kind === "column")) return ZOOM_LANDING_MS;
  const leave = segmentSpan(from).end;
  const arrive = segmentSpan(to).start;
  const dy = nextPage ? (1 - leave + arrive) * box.height + PAGE_GAP_PX : Math.abs(arrive - leave) * box.height;
  const dx = Math.abs((from.x0 + from.x1 - to.x0 - to.x1) / 2) * box.width;
  const distance = Math.hypot(dx, dy);
  return distance < 4 || pdfTpReducedMotion() ? 0 : glideMs(distance, view);
}

// A path from segment `fromIndex`, `fromT` of the way through it, to its end:
// the time its words take to read, and the time spent moving between them.
function pathMs(path, fromIndex, fromT, box, view) {
  const segments = path.segments;
  let read = 0;
  let move = 0;
  for (let index = fromIndex; index < segments.length; index += 1) {
    read += segmentSeconds(segments[index]) * 1000 * (index === fromIndex ? 1 - fromT : 1);
    if (index + 1 < segments.length) move += transitionMs(segments[index], segments[index + 1], box, view, false);
  }
  return { read, move };
}

function pdfTimeLeftMs() {
  const session = pdfSession;
  if (!session || session.phase === "ended") return null;
  // By hand: the reader's own speed, as the progress row reckons it.
  if (session.phase === "manual") return readingTimeLeft()?.leftMs ?? null;
  const cursor = session.cursor;
  const view = el.documentView;
  if (!cursor || !openPdf || !view || !session.wpm) return null;
  const path = builtPath(cursor.page);
  const box = tpPageBox(cursor.page);
  if (!path || !box || !path.segments.length) return null;
  // A page's time at this speed and this size, kept until either changes.
  const key = `${session.wpm}|${session.settings.columns}|${session.settings.zoomColumn}|${Math.round(box.height)}|${view.clientHeight}`;
  if (session.pageMsKey !== key) {
    session.pageMsKey = key;
    session.pageMs = new Map();
  }
  let { read, move } = pathMs(path, cursor.index, Math.max(0, Math.min(1, cursor.t)), box, view);
  if (session.glide) move += Math.max(0, session.glide.ms - (performance.now() - session.glide.start));
  const known = [pathMs(path, 0, 0, box, view)];
  let last = path.segments[path.segments.length - 1];
  let unknown = 0;
  for (let n = cursor.page + 1; n <= openPdf.pageCount; n += 1) {
    const ahead = builtPath(n);
    if (!ahead) {
      unknown += 1;
      last = null;
      continue;
    }
    if (!ahead.segments.length) continue;
    let pageMs = session.pageMs.get(n);
    if (pageMs === undefined) {
      pageMs = pathMs(ahead, 0, 0, box, view);
      session.pageMs.set(n, pageMs);
    }
    read += pageMs.read;
    move += pageMs.move + (last ? transitionMs(last, ahead.segments[0], box, view, true) : 0);
    known.push(pageMs);
    last = ahead.segments[ahead.segments.length - 1];
  }
  if (unknown) {
    const average = (key) => known.reduce((sum, value) => sum + value[key], 0) / known.length;
    read += unknown * average("read");
    move += unknown * (average("move") + glideMs(box.height * 0.15, view));
  }
  // The word clock reads the words faster to make up the moves, by as much as
  // PACE_MAX allows: the moves cost nothing until they are more than that.
  return Math.max(read, (read + move) / PACE_MAX);
}

function pdfTimeLeftText() {
  const ms = pdfTimeLeftMs();
  if (!(ms > 0)) return "";
  return `≈ ${formatDuration(ms, { short: true })} left`;
}

function paintPdfTeleprompter() {
  if (!pdfSession) return;
  paintTeleprompterPanel({
    phase: pdfSession.phase,
    wpm: pdfSession.wpm,
    leftText: pdfSession.phase === "ended" ? "" : pdfTimeLeftText(),
    countdown: pdfSession.countdownLeft,
    tucked: pdfSession.tucked,
    resumeProgress: pdfSession.resumeProgress,
    settings: pdfSession.settings,
    measuredWpm: measuredTeleprompterWpm(),
    statusText: pdfSession.phase === "playing" ? `Playing, ${pdfSession.wpm} words a minute` : PDF_TP_STATUS_TEXT[pdfSession.phase] || ""
  });
}

export function paintPdfTeleprompterToggles() {
  const on = Boolean(pdfSession);
  const button = el.documentTeleprompterBtn;
  if (button) {
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on
      ? "Leave the teleprompter — back to the PDF as it was"
      : "Teleprompter — the PDF scrolls by itself, column by column, at the speed you set; touch it to pause";
  }
  pdfTeleprompterChangedHook?.();
}

// ── Starting and leaving ────────────────────────────────────────────────────

const pdfPanelHandlers = {
  action: (name) => onPdfTeleprompterAction(name),
  setting: (key, value, options) => setPdfTeleprompterSetting(key, value, options),
  evict: () => exitPdfTeleprompter({ land: false })
};

export function startPdfTeleprompter() {
  const view = el.documentView;
  const stage = el.documentStage;
  if (pdfSession || !view || !stage || !openPdf) return false;
  if (!surfaceShowsSession()) return false;
  // The PDF is on screen, so a restore still waiting for it has nothing to do
  // that this session's own start does not do better.
  applyPendingRestore();
  dropPendingRestore();
  const settings = readPdfTeleprompterSettings();
  const atTop = view.scrollTop <= 1;
  pdfSession = {
    phase: "paused",
    pdf: openPdf,
    deckKey: currentDeckKey(),
    settings,
    wpm: settings.wpm || measuredTeleprompterWpm() || PDF_TELEPROMPTER_FALLBACK_WPM,
    baseScale: openPdf.scale,
    baseFitWidth: Boolean(openPdf.fitWidth),
    appliedScale: openPdf.scale,
    columnScale: 0,
    focusSetByUs: false,
    cursor: null,
    glide: null,
    lastTop: view.scrollTop,
    lastLeft: view.scrollLeft,
    ease: 0,
    frame: 0,
    lastFrameAt: 0,
    holding: 0,
    landing: false,
    pauseReason: null,
    lastInputAt: performance.now(),
    countdownLeft: 0,
    countdownTimer: 0,
    watchTimer: 0,
    resumeProgress: null,
    tucked: false,
    wakeLock: null,
    wakeRequested: false,
    resizeObserver: null,
    subPixel: { on: false, top: 0, left: 0 },
    clock: newWordClock(),
    pageMs: new Map(),
    pageMsKey: "",
    readingAhead: false,
    manualFrame: 0,
    manualSettle: 0,
    wasAway: false
  };
  ensureTeleprompterPanel(stage, pdfPanelHandlers, "pdf");
  stage.classList.add("is-teleprompter");
  view.classList.add("is-teleprompter");
  sizeRunway();
  // From the very top, the first line of the PDF; from anywhere else, the line
  // under the band, which the first frame finds.
  if (atTop) {
    const first = firstCursorFrom(1);
    if (first) pdfSession.cursor = first;
  }
  pathFor(Math.max(1, currentDocumentPage() || 1));
  placePdfBand();
  if (settings.focus && !isFocusModeActive()) {
    setFocusMode(true);
    pdfSession.focusSetByUs = true;
  }
  if (typeof ResizeObserver === "function") {
    pdfSession.resizeObserver = new ResizeObserver(() => onViewResized());
    pdfSession.resizeObserver.observe(view);
  }
  pdfSession.watchTimer = setInterval(watchPdfTeleprompter, PDF_TP_WATCH_MS);
  view.addEventListener("wheel", onPdfTeleprompterWheel, { passive: false });
  paintPdfTeleprompterToggles();
  readAheadWhenIdle();
  if (settings.scroll === "manual") enterPdfManual();
  else beginCountdown();
  return true;
}

function onViewResized() {
  if (!pdfSession) return;
  sizeRunway();
  placePdfBand();
  // The column's zoom was for the old width.
  pdfSession.columnScale = 0;
  if (pdfSession.phase === "playing" && pdfSession.cursor) {
    const camera = cameraFor(pdfSession.cursor);
    if (camera) writeScroll(el.documentView, camera.top, camera.left);
  }
}

// ── Putting the reader's zoom back on a PDF nobody can see ──────────────────
//
// A session ended from behind another tab (the Notes teleprompter taking the
// panel) used to put the reader's zoom back there and then, under display:none.
// Every offset reads 0 in there, so nothing could be measured, and the browser
// then restored the old scrollTop — taken at the column's zoom and with the
// lead-in still in it — onto pages half the size: the reader came back pages
// further on, and the next scroll saved that as their place. So the restore
// waits until the PDF is on screen again, and lands on the place it was last
// seen at (the hidden readings answer with openPdf.settled).
let pendingRestore = null;
let pendingRestoreObserver = null;

function dropPendingRestore() {
  pendingRestore = null;
  pendingRestoreObserver?.disconnect();
  pendingRestoreObserver = null;
}

function applyPendingRestore() {
  const restore = pendingRestore;
  if (!restore) return;
  if (openPdf !== restore.pdf) {
    dropPendingRestore();
    return;
  }
  if (documentSurfaceHidden()) return;
  dropPendingRestore();
  const { page, ratio, across } = restore.place;
  const putBack = () => scrollToDocumentPage(page, ratio, { smooth: false, across });
  const scale = restore.fitWidth ? fitWidthScale() : restore.scale;
  if (Math.abs((openPdf.scale || scale) - scale) > 0.001 || Boolean(openPdf.fitWidth) !== restore.fitWidth) {
    setDocumentScale(scale, { fitWidth: restore.fitWidth, afterLayout: putBack });
  } else {
    putBack();
  }
}

function restoreWhenShown(ending) {
  dropPendingRestore();
  pendingRestore = {
    pdf: ending.pdf,
    scale: ending.baseScale,
    fitWidth: ending.baseFitWidth,
    place: { page: currentDocumentPage(), ratio: currentDocumentResidual(), across: currentDocumentAcross() }
  };
  const view = el.documentView;
  if (!view || typeof ResizeObserver !== "function") return;
  // A scroller coming back from display:none changes size from 0, which is
  // the one moment this needs; a frame later, so the restore's own layout is
  // not inside the observer's callback.
  pendingRestoreObserver = new ResizeObserver(() => requestAnimationFrame(applyPendingRestore));
  pendingRestoreObserver.observe(view);
}

// The zoom the position save writes down is the reader's, not the column's —
// see setDocumentReaderZoomHook in pdf-view.js.
function readerZoomFor(pdf) {
  if (pdfSession && pdfSession.pdf === pdf) {
    return pdfSession.phase === "manual" ? null : { scale: pdfSession.baseScale, fitWidth: pdfSession.baseFitWidth };
  }
  if (pendingRestore && pendingRestore.pdf === pdf) return { scale: pendingRestore.scale, fitWidth: pendingRestore.fitWidth };
  return null;
}

// `land`: put the reader's own zoom back, with the line on the band where it
// is. Not when the PDF on screen is no longer the one that was read.
export function exitPdfTeleprompter({ land = true } = {}) {
  if (!pdfSession) return;
  const view = el.documentView;
  const ending = pdfSession;
  clearInterval(ending.watchTimer);
  clearInterval(ending.countdownTimer);
  stopFrames();
  stopFollowingManualScroll();
  letPdfScreenSleep();
  ending.resizeObserver?.disconnect();
  view?.removeEventListener("wheel", onPdfTeleprompterWheel);
  if (view) stopGlide(view);
  // By hand, the zoom on screen is the reader's own, and it stays.
  if (ending.phase === "manual" && openPdf === ending.pdf) {
    ending.baseScale = openPdf.scale;
    ending.baseFitWidth = Boolean(openPdf.fitWidth);
  }
  // The line on the band, as a point on its page, before anything moves.
  let anchor = null;
  const canLand = land && view && openPdf === ending.pdf && surfaceShowsSession();
  if (canLand) {
    const y = view.scrollTop + bandLine(view);
    const pageNumber = pageUnderLine(view, y);
    const box = tpPageBox(pageNumber);
    if (box) {
      anchor = {
        page: pageNumber,
        fy: (y - box.top) / Math.max(1, box.height),
        fx: (view.scrollLeft + view.clientWidth / 2 - box.left) / Math.max(1, box.width),
        screenY: bandLine(view)
      };
    }
  }
  // Read before the session goes: the hidden readings are the place it was
  // last seen at, which is where the reader comes back to.
  const restoreLater = Boolean(view) && openPdf === ending.pdf && !canLand && documentSurfaceHidden();
  if (restoreLater) restoreWhenShown(ending);
  pdfSession = null;
  closeTeleprompterSheet();
  removeTeleprompterPanel();
  el.documentStage?.classList.remove("is-teleprompter");
  if (view) clearRunway(view);
  // The reader's own zoom comes back whenever this is still their PDF — also
  // when the session is ended from behind Cards or Notes, so the column's zoom
  // is not what they find on coming back. Their line is put back only where it
  // is on screen to be put back.
  if (view && openPdf === ending.pdf && !restoreLater) {
    const putBack = () => {
      if (!anchor) return;
      const box = tpPageBox(anchor.page);
      if (!box) return;
      view.scrollTop = Math.max(0, box.top + anchor.fy * box.height - anchor.screenY);
      view.scrollLeft = Math.max(0, box.left + anchor.fx * box.width - view.clientWidth / 2);
    };
    // fitWidthScale answers with the scale the page has when the scroller is
    // not on screen to be measured, which here is the column's.
    const scale = ending.baseFitWidth && view.clientWidth ? fitWidthScale() : ending.baseScale;
    if (Math.abs((openPdf.scale || scale) - scale) > 0.001 || Boolean(openPdf.fitWidth) !== ending.baseFitWidth) {
      setDocumentScale(scale, { fitWidth: ending.baseFitWidth, afterLayout: putBack });
    } else {
      putBack();
    }
  }
  if (ending.focusSetByUs && isFocusModeActive()) setFocusMode(false);
  paintPdfTeleprompterToggles();
}

export function togglePdfTeleprompter() {
  if (pdfSession) exitPdfTeleprompter();
  else startPdfTeleprompter();
}

// ── Playing, pausing, the countdown and the end ─────────────────────────────

function beginCountdown() {
  if (!pdfSession) return;
  clearInterval(pdfSession.countdownTimer);
  const seconds = pdfSession.settings.countdown;
  if (!seconds) {
    playPdfTeleprompter();
    return;
  }
  pdfSession.phase = "countdown";
  pdfSession.countdownLeft = seconds;
  pdfSession.resumeProgress = null;
  pdfSession.countdownTimer = setInterval(() => {
    if (!pdfSession) return;
    pdfSession.countdownLeft -= 1;
    if (pdfSession.countdownLeft <= 0) playPdfTeleprompter();
    else paintPdfTeleprompter();
  }, 1000);
  paintPdfTeleprompter();
}

// A zoom the reader made while it was paused is theirs to keep: for the
// columns if they were reading a column, for the rest if not.
function adoptReaderZoom() {
  const scale = openPdf?.scale;
  if (!scale || !pdfSession.appliedScale || Math.abs(scale - pdfSession.appliedScale) / pdfSession.appliedScale < 0.02) return;
  const segment = currentSegment();
  if (segment?.kind === "column" && pdfSession.settings.zoomColumn) pdfSession.columnScale = scale;
  else pdfSession.baseScale = scale;
  pdfSession.appliedScale = scale;
}

function playPdfTeleprompter() {
  if (!pdfSession) return;
  clearInterval(pdfSession.countdownTimer);
  pdfSession.countdownTimer = 0;
  adoptReaderZoom();
  pdfSession.phase = "playing";
  pdfSession.pauseReason = null;
  pdfSession.resumeProgress = null;
  pdfSession.tucked = false;
  pdfSession.lastFrameAt = 0;
  rebaseWordClock(pdfSession.clock, { measure: true });
  // Where to start from: the cursor it had, put back under the band — unless
  // the reader has moved the view since, in which case the first frame finds
  // the line that is under it now.
  const view = el.documentView;
  pdfSession.landing = Boolean(pdfSession.cursor && view && !viewMovedByOther(view));
  holdPdfScreenAwake();
  schedulePdfFrame();
  paintPdfTeleprompter();
}

// `reason` as the note's: "button" eases to a stop; "reader", "away" and
// "hidden" stop dead. Only "reader" may carry on by itself.
export function pausePdfTeleprompter(reason = "button") {
  if (!pdfSession || (pdfSession.phase !== "playing" && pdfSession.phase !== "countdown")) return;
  clearInterval(pdfSession.countdownTimer);
  pdfSession.countdownTimer = 0;
  pdfSession.phase = "paused";
  pdfSession.pauseReason = reason;
  pdfSession.lastInputAt = performance.now();
  pdfSession.resumeProgress = null;
  // Mid-glide it stops dead too: there is no line under the band to ease to.
  if (reason !== "button" || pdfTpReducedMotion() || pdfSession.glide) {
    stopFrames();
    pdfSession.ease = 0;
  }
  // A glide cut short leaves the view between two places; the next ▶ finds
  // its line from wherever it stopped.
  if (pdfSession.glide) {
    pdfSession.glide = null;
    pdfSession.cursor = null;
    setGliding(false);
  }
  letPdfScreenSleep();
  paintPdfTeleprompter();
}

export function resumePdfTeleprompter() {
  if (!pdfSession || pdfSession.phase === "manual") return;
  if (pdfSession.phase === "ended") {
    restartPdfTeleprompter();
    return;
  }
  if (pdfSession.phase === "playing") return;
  playPdfTeleprompter();
}

function restartPdfTeleprompter() {
  if (!pdfSession) return;
  const view = el.documentView;
  const first = firstCursorFrom(1);
  pdfSession.cursor = first || null;
  if (view) writeScroll(view, 0, 0);
  beginCountdown();
}

function finishPdfTeleprompter() {
  if (!pdfSession) return;
  pdfSession.phase = "ended";
  pdfSession.pauseReason = null;
  stopFrames();
  letPdfScreenSleep();
  paintPdfTeleprompter();
}

function togglePlay() {
  if (!pdfSession || pdfSession.phase === "manual") return;
  if (pdfSession.phase === "playing") pausePdfTeleprompter("button");
  else resumePdfTeleprompter();
}

// ── By hand ─────────────────────────────────────────────────────────────────

function enterPdfManual() {
  const session = pdfSession;
  if (!session) return;
  clearInterval(session.countdownTimer);
  session.countdownTimer = 0;
  stopFrames();
  session.ease = 0;
  session.landing = false;
  if (session.glide) {
    session.glide = null;
    setGliding(false);
  }
  session.phase = "manual";
  session.pauseReason = null;
  session.resumeProgress = null;
  el.documentView?.addEventListener("scroll", followManualScroll, { passive: true });
  followManualScroll();
  holdPdfScreenAwake();
  paintPdfTeleprompter();
}

// Back to "By itself", paused, from the line under the band: ▶ to press, and
// the column zoom only once it plays.
function leavePdfManual() {
  const session = pdfSession;
  if (!session || session.phase !== "manual") return;
  stopFollowingManualScroll();
  session.phase = "paused";
  session.pauseReason = "button";
  session.cursor = null;
  session.appliedScale = openPdf?.scale || session.appliedScale;
  session.baseScale = openPdf?.scale || session.baseScale;
  session.baseFitWidth = Boolean(openPdf?.fitWidth);
  session.columnScale = 0;
  session.lastInputAt = performance.now();
  letPdfScreenSleep();
  paintPdfTeleprompter();
}

function applyPdfScrollMode() {
  if (!pdfSession) return;
  if (pdfSession.settings.scroll === "manual") {
    if (pdfSession.phase !== "manual") enterPdfManual();
  } else {
    leavePdfManual();
  }
}

function stopFollowingManualScroll() {
  el.documentView?.removeEventListener("scroll", followManualScroll);
  if (!pdfSession) return;
  if (pdfSession.manualFrame) cancelAnimationFrame(pdfSession.manualFrame);
  clearTimeout(pdfSession.manualSettle);
  pdfSession.manualFrame = 0;
  pdfSession.manualSettle = 0;
}

// The band onto the column under it, once a frame at most. A page whose path
// is not built yet keeps the band as it was until the scroll has settled.
function followManualScroll() {
  const session = pdfSession;
  if (!session || session.phase !== "manual" || session.manualFrame) return;
  session.manualFrame = requestAnimationFrame(() => {
    session.manualFrame = 0;
    if (pdfSession !== session || session.phase !== "manual") return;
    const view = el.documentView;
    if (!view || !openPdf || !surfaceShowsSession()) return;
    const y = view.scrollTop + bandLine(view);
    const pageNumber = pageUnderLine(view, y);
    const box = tpPageBox(pageNumber);
    const path = builtPath(pageNumber);
    clearTimeout(session.manualSettle);
    if (!path) {
      session.manualSettle = setTimeout(() => {
        if (pdfSession === session && session.phase === "manual") pathFor(pageNumber);
      }, MANUAL_PATH_SETTLE_MS);
      return;
    }
    if (!box) return;
    const fy = (y - box.top) / Math.max(1, box.height);
    const fx = (view.scrollLeft + view.clientWidth / 2 - box.left) / Math.max(1, box.width);
    const found = cursorOnPage(pageNumber, path, fx, fy);
    if (found) session.cursor = found;
    placePdfBand();
  });
}

// ── While it is open ────────────────────────────────────────────────────────

function readerBusy() {
  return readerTouchDown()
    || touchGestureHoldsSurface()
    || inkPenIsDown()
    || documentPinchEngaged()
    || isInkArmed()
    || isRegionSelectArmed()
    || Boolean(el.selectionFloat && !el.selectionFloat.hidden)
    || Boolean(document.getSelection?.()?.toString())
    || anyModalOpen();
}

function watchPdfTeleprompter() {
  if (!pdfSession) return;
  // A different file or a different PDF: the place this session was keeping
  // is not on screen any more.
  if (!sessionStillOpen()) {
    exitPdfTeleprompter({ land: false });
    return;
  }
  if (pdfSession.phase === "manual") {
    if (!surfaceShowsSession() || document.hidden) {
      if (!pdfSession.wasAway) letPdfScreenSleep();
      pdfSession.wasAway = true;
      return;
    }
    // Back from another tab or the background, where the browser let go of
    // the screen lock: asked for once again.
    if (pdfSession.wasAway) {
      pdfSession.wasAway = false;
      holdPdfScreenAwake();
      followManualScroll();
    }
    pdfSession.tucked = readerBusy();
    paintPdfTeleprompter();
    return;
  }
  if (!surfaceShowsSession()) {
    pausePdfTeleprompter("away");
    return;
  }
  if (document.hidden) {
    pausePdfTeleprompter("hidden");
    return;
  }
  if (pdfSession.phase !== "paused") {
    if (pdfSession.phase === "playing") paintPdfTeleprompter();
    return;
  }
  const busy = readerBusy();
  pdfSession.tucked = busy;
  const wait = pdfSession.settings.autoResume * 1000;
  if (pdfSession.pauseReason === "reader" && wait > 0 && !isTeleprompterSheetOpen()) {
    const now = performance.now();
    if (busy) pdfSession.lastInputAt = now;
    pdfSession.resumeProgress = Math.min(1, (now - pdfSession.lastInputAt) / wait);
    if (pdfSession.resumeProgress >= 1) {
      playPdfTeleprompter();
      return;
    }
  } else {
    pdfSession.resumeProgress = null;
  }
  paintPdfTeleprompter();
}

// ── The bar and the sheet ───────────────────────────────────────────────────

function changeSpeed(delta) {
  if (!pdfSession) return;
  setPdfTeleprompterSetting("wpm", pdfSession.wpm + delta, { commit: true });
}

// ── Steps by the line ───────────────────────────────────────────────────────
//
// ↑ ↓ ← →, the page keys and a mouse wheel's clicks, as the note's
// (src/notes/band-steps.js) — but a PDF's lines are known without looking:
// the reading path has where each segment starts and how far apart its lines
// are. A step lands a line of it on the band; one that would leave the
// segment goes by the line pitch, and the next lands on the first line of the
// next segment.

function clampTop(view, top) {
  return Math.max(0, Math.min(view.scrollHeight - view.clientHeight, top));
}

// The middles of the lines of the column under the band, in the scroller's
// own px, on this page and the pages either side whose paths are built — down
// the column the band is on (the cursor's segment), or, before there is one,
// the middle of the view. In the order they are on screen, which on a page of
// two columns is not the reading order: a key or a wheel moves the view up or
// down what is there.
function pdfLineMiddles(view, pageNumber) {
  const segment = currentSegment();
  const middles = [];
  for (let n = Math.max(1, pageNumber - 1); n <= Math.min(openPdf.pageCount, pageNumber + 1); n += 1) {
    const box = tpPageBox(n);
    const path = builtPath(n);
    if (!box || !path?.segments.length) continue;
    const fx = segment && pdfSession.cursor?.page === n
      ? (segment.x0 + segment.x1) / 2
      : (view.scrollLeft + view.clientWidth / 2 - box.left) / Math.max(1, box.width);
    let column = path.segments.filter((each) => fx >= each.x0 && fx <= each.x1);
    if (!column.length) column = path.segments;
    column.forEach((each) => {
      const { start, end } = segmentSpan(each);
      const count = Math.round((end - start) / Math.max(1e-6, each.linePitch));
      for (let k = 0; k <= count; k += 1) middles.push(box.top + (start + k * each.linePitch) * box.height);
    });
  }
  return middles.sort((a, b) => a - b);
}

// The scrollTop that puts the `lines`-th line after (negative: before) the one
// on the band onto it, counted from where a glide under way is going; 0 is the
// nearest line. Without a path to go by, it is the line pitch.
function pdfStepTarget(view, lines) {
  const pending = pendingGlidePx(view);
  const line = bandLine(view);
  const y = view.scrollTop + pending + line;
  const middles = pdfLineMiddles(view, pageUnderLine(view, y));
  let to = null;
  if (lines > 0) to = middles.filter((middle) => middle > y + 1)[lines - 1];
  else if (lines < 0) {
    const above = middles.filter((middle) => middle < y - 1);
    to = above[above.length + lines];
  } else if (middles.length) {
    to = middles.reduce((best, middle) => (Math.abs(middle - y) < Math.abs(best - y) ? middle : best));
  }
  if (to != null) return clampTop(view, to - line);
  return lines ? clampTop(view, view.scrollTop + pending + lines * pdfPitchPx(view)) : view.scrollTop + pending;
}

function pdfPitchPx(view) {
  const segment = currentSegment();
  const box = pdfSession.cursor ? tpPageBox(pdfSession.cursor.page) : null;
  return segment && box ? segment.linePitch * box.height : 24;
}

// Playing, the view moves at once and the cursor follows it on the next frame
// as it follows any other move; otherwise it glides.
function nudge(lines) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  const target = pdfStepTarget(view, lines);
  if (pdfSession.phase === "playing" || pdfSession.phase === "countdown") {
    stopGlide(view);
    view.scrollTop = target;
  } else {
    glideScrollTo(view, target);
  }
  if (pdfSession.phase === "ended" && lines < 0) {
    pdfSession.phase = "paused";
    pdfSession.pauseReason = "button";
  }
  paintPdfTeleprompter();
}

function alignPdfToBand() {
  const view = el.documentView;
  if (!pdfSession || !view || pdfSession.phase === "playing") return;
  const target = pdfStepTarget(view, 0);
  if (Math.abs(target - view.scrollTop) >= 1) glideScrollTo(view, target);
}

// A screen less two lines, set onto the band once it lands.
function pagePdf(direction) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  if (pdfSession.phase === "playing" || pdfSession.phase === "countdown") pausePdfTeleprompter("reader");
  const jump = Math.max(24, view.clientHeight - 2 * pdfPitchPx(view));
  glideScrollTo(view, view.scrollTop + pendingGlidePx(view) + direction * jump, { done: alignPdfToBand });
}

function jumpPdfTo(end) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  if (pdfSession.phase === "playing" || pdfSession.phase === "countdown") pausePdfTeleprompter("reader");
  stopGlide(view);
  view.scrollTop = end ? view.scrollHeight - view.clientHeight : 0;
}

// A click of a mouse wheel over the PDF: whole lines onto the band. Ctrl and
// a pinch stay the zoom's; a trackpad scrolls as the browser does.
function onPdfTeleprompterWheel(event) {
  if (!pdfSession || !isNotchedWheel(event) || teleprompterPanelContains(event.target)) return;
  event.preventDefault();
  nudge(wheelNotches(event) * WHEEL_LINES);
}

function onPdfTeleprompterAction(name) {
  if (!pdfSession) return;
  if (name === "play") togglePlay();
  else if (name === "again") restartPdfTeleprompter();
  else if (name === "exit") exitPdfTeleprompter();
  else if (name === "slower") changeSpeed(-TELEPROMPTER_RANGES.wpm.step);
  else if (name === "faster") changeSpeed(TELEPROMPTER_RANGES.wpm.step);
  else if (name === "settings") toggleTeleprompterSheet();
  else if (name === "sheet-close") closeTeleprompterSheet();
  else if (name === "use-my-speed") {
    const mine = measuredTeleprompterWpm();
    if (mine) setPdfTeleprompterSetting("wpm", mine, { commit: true });
  } else if (name === "reset") resetPdfTeleprompterSettings();
  paintPdfTeleprompter();
}

function setPdfTeleprompterSetting(key, value, { commit = true } = {}) {
  if (!pdfSession) return;
  let next = value;
  if (PDF_TELEPROMPTER_RANGE_KEYS.includes(key)) {
    next = clampToRange(key, value);
    if (next === null) return;
  }
  if (key === "wpm") {
    if (next !== pdfSession.wpm) rebaseWordClock(pdfSession.clock, { measure: true });
    pdfSession.wpm = next;
  } else {
    const before = pdfSession.settings[key];
    pdfSession.settings = { ...pdfSession.settings, [key]: next };
    if (key === "bandPos") sizeRunway();
    if (key === "columns" && before !== next) {
      // A different reading of every page: found again from the line under
      // the band.
      pdfSession.cursor = null;
      pdfSession.glide = null;
      pathFor(Math.max(1, currentDocumentPage() || 1));
      readAheadWhenIdle();
      if (pdfSession.phase === "manual") followManualScroll();
      else schedulePdfFrame();
    }
    if (key === "scroll" && before !== next) applyPdfScrollMode();
    // By hand the zoom is the reader's: the setting waits for "By itself".
    if (key === "zoomColumn" && before !== next && pdfSession.phase !== "manual") {
      pdfSession.columnScale = 0;
      const segment = currentSegment();
      if (segment && pdfSession.cursor) {
        const scale = targetScale(segment, pdfSession.cursor.page);
        if (scaleDiffers(scale)) zoomForCursor(scale);
      }
    }
    if (key === "focus") {
      if (next && !isFocusModeActive()) {
        setFocusMode(true);
        pdfSession.focusSetByUs = true;
      } else if (!next && pdfSession.focusSetByUs && isFocusModeActive()) {
        setFocusMode(false);
        pdfSession.focusSetByUs = false;
      }
    }
    if (key === "wake") {
      if (!next) letPdfScreenSleep();
      else if (pdfSession.phase === "playing") holdPdfScreenAwake();
    }
    placePdfBand();
  }
  if (commit) {
    const stored = { ...pdfSession.settings };
    if (key === "wpm") stored.wpm = pdfSession.wpm;
    pdfSession.settings = writePdfTeleprompterSettings({ ...readPdfTeleprompterSettings(), ...stored });
  }
  paintPdfTeleprompter();
}

function resetPdfTeleprompterSettings() {
  if (!pdfSession) return;
  const before = pdfSession.settings;
  pdfSession.settings = writePdfTeleprompterSettings({});
  pdfSession.wpm = measuredTeleprompterWpm() || PDF_TELEPROMPTER_FALLBACK_WPM;
  rebaseWordClock(pdfSession.clock, { measure: true });
  if (before.columns !== pdfSession.settings.columns) {
    pdfSession.cursor = null;
    pdfSession.glide = null;
  }
  pdfSession.columnScale = 0;
  sizeRunway();
  placePdfBand();
  readAheadWhenIdle();
  applyPdfScrollMode();
  if (pdfSession.phase !== "manual") schedulePdfFrame();
}

// ── Input ───────────────────────────────────────────────────────────────────

function onPdfReaderPress(event) {
  if (!pdfSession) return;
  pdfSession.lastInputAt = performance.now();
  if (teleprompterPanelContains(event.target)) {
    wakeTeleprompterBar();
    return;
  }
  if (pdfSession.phase === "playing" || pdfSession.phase === "countdown") pausePdfTeleprompter("reader");
}

function onPdfReaderWheel(event) {
  if (!pdfSession) return;
  pdfSession.lastInputAt = performance.now();
  if (teleprompterPanelContains(event.target)) return;
  if (el.documentStage?.contains(event.target)) onPdfReaderPress(event);
}

// Keys as the note's: only while it is on screen, never in a field, never
// with a modifier, never over a dialog. Escape goes through the Back stack
// (src/ui/back-gesture.js), except out of the sheet's own fields.
function onPdfTeleprompterKey(event) {
  if (!pdfSession || !pdfTeleprompterOnScreen()) return;
  const target = event.target;
  if (event.key === "Escape") {
    if (isTeleprompterSheetOpen() && teleprompterPanelContains(target)) {
      event.preventDefault();
      event.stopPropagation();
      closeTeleprompterSheet();
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (anyModalOpen()) return;
  pdfSession.lastInputAt = performance.now();
  const act = (fn) => {
    event.preventDefault();
    fn();
  };
  const manual = pdfSession.phase === "manual";
  // The keys move the PDF whatever has the focus, as the note's do.
  switch (event.key) {
    case " ":
    case "Spacebar":
      if (target?.closest?.("button, a, [role='button']")) return;
      if (manual) act(() => pagePdf(event.shiftKey ? -1 : 1));
      else act(togglePlay);
      return;
    // ↑ ↓ a line; with Shift, the speed.
    case "ArrowUp":
      if (!event.shiftKey) act(() => nudge(-1));
      else if (!manual) act(() => changeSpeed(TELEPROMPTER_RANGES.wpm.step));
      return;
    case "ArrowDown":
      if (!event.shiftKey) act(() => nudge(1));
      else if (!manual) act(() => changeSpeed(-TELEPROMPTER_RANGES.wpm.step));
      return;
    case "ArrowLeft": act(() => nudge(-2)); return;
    case "ArrowRight": act(() => nudge(2)); return;
    case "PageUp": act(() => pagePdf(-1)); return;
    case "PageDown": act(() => pagePdf(1)); return;
    case "Home": act(() => jumpPdfTo(false)); return;
    case "End": act(() => jumpPdfTo(true)); return;
    default:
  }
}

export function initPdfTeleprompter() {
  setDocumentReaderZoomHook(readerZoomFor);
  onDeckSwap(() => exitPdfTeleprompter({ land: false }));
  // Capture phase, so the stop lands before any surface's own handler — the
  // text selection's press timer and the pen's first point among them.
  document.addEventListener("pointerdown", onPdfReaderPress, { capture: true, passive: true });
  document.addEventListener("touchstart", onPdfReaderPress, { capture: true, passive: true });
  document.addEventListener("wheel", onPdfReaderWheel, { capture: true, passive: true });
  document.addEventListener("keydown", onPdfTeleprompterKey, { capture: true });
  document.addEventListener("selectionchange", () => {
    if (pdfSession) pdfSession.lastInputAt = performance.now();
  });
  document.addEventListener("visibilitychange", () => {
    if (pdfSession && document.hidden) pausePdfTeleprompter("hidden");
  });
  el.documentTeleprompterBtn?.addEventListener("click", () => togglePdfTeleprompter());
  paintPdfTeleprompterToggles();
}
