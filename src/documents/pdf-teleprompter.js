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
import { isFocusModeActive, setFocusMode } from "../ui/chrome.js?v=__BUILD__";
import { anyModalOpen } from "../ui/overlays.js?v=__BUILD__";
import { currentDeckKey } from "../notes/scroll-anchor.js?v=__BUILD__";
import { onDeckSwap } from "../notes/notes-view.js?v=__BUILD__";
import { clampToRange, measuredTeleprompterWpm } from "../notes/teleprompter.js?v=__BUILD__";
import {
  TELEPROMPTER_AUTO_RESUMES, TELEPROMPTER_COLUMNS, TELEPROMPTER_COUNTDOWNS, TELEPROMPTER_RANGES,
  closeTeleprompterSheet, ensureTeleprompterPanel, isTeleprompterSheetOpen, paintTeleprompterPanel,
  placeTeleprompterBand, removeTeleprompterPanel, teleprompterPanelContains, toggleTeleprompterSheet, wakeTeleprompterBar
} from "../notes/teleprompter-panel.js?v=__BUILD__";
import { isInkArmed } from "./pdf-ink.js?v=__BUILD__";
import { isRegionSelectArmed } from "./pdf-region.js?v=__BUILD__";
import { buildPathFromBoxes, buildPathFromInk, pathWords } from "./pdf-reading-path.js?v=__BUILD__";
import { keptTextItem, textItemBox, textItemShadows } from "./pdf-selection.js?v=__BUILD__";
import {
  PDF_MAX_SCALE, currentDocumentAcross, currentDocumentPage, currentDocumentResidual, documentPinchEngaged, documentSurfaceHidden,
  fitWidthScale, openDocumentSlot, openPdf, pageOffsetLeft, pageOffsetTop, pdfPageTextItems, scrollToDocumentPage,
  setDocumentReaderZoomHook, setDocumentScale
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
  wake: true
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

async function buildPagePath(pdf, pageNumber, columns) {
  const page = await pdf.doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const items = pdfPageTextItems(pageNumber) || (await page.getTextContent()).items || [];
  const fromText = buildPathFromBoxes(textBoxes(items, viewport), viewport.width, viewport.height, { columns });
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
          schedulePdfFrame();
          paintPdfTeleprompter();
        }
        return path;
      });
    cache.set(key, pending);
  }
  return undefined;
}

// ── The session ─────────────────────────────────────────────────────────────

// null when there is none. Phases as the note's: "countdown" → "playing" ⇄
// "paused", and "ended" at the foot of the last page.
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
    holding: pdfSession.holding,
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
    const camera = cameraFor(pdfSession.cursor);
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

function writeScroll(view, top, left) {
  view.scrollTop = top;
  view.scrollLeft = left;
  if (pdfSession) {
    pdfSession.lastTop = view.scrollTop;
    pdfSession.lastLeft = view.scrollLeft;
  }
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

// Moves the cursor to `next` and the camera after it: a zoom if the segment
// wants one, a glide if the camera has somewhere to go, or nothing.
function moveCursorTo(next, { glide = true } = {}) {
  const view = el.documentView;
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
    writeScroll(view, camera.top, camera.left);
    placePdfBand();
    return;
  }
  const ms = Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, (distance / Math.max(1, view.clientHeight)) * 450));
  pdfSession.glide = { fromTop: view.scrollTop, fromLeft: view.scrollLeft, start: performance.now(), ms };
  setGliding(true);
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
  }
  setDocumentAutoScrolling(false);
}

function easeInOut(x) {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

function pdfFrame(now) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  pdfSession.frame = 0;
  if (!sessionStillOpen() || !surfaceShowsSession() || document.hidden) {
    setDocumentAutoScrolling(false);
    watchPdfTeleprompter();
    return;
  }
  const dt = pdfSession.lastFrameAt ? Math.min(100, now - pdfSession.lastFrameAt) / 1000 : 0;
  pdfSession.lastFrameAt = now;
  const target = pdfSession.phase === "playing" ? 1 : 0;
  if (pdfTpReducedMotion()) pdfSession.ease = target;
  else if (target > pdfSession.ease) pdfSession.ease = Math.min(target, pdfSession.ease + dt / PDF_TP_RAMP_IN_S);
  else pdfSession.ease = Math.max(target, pdfSession.ease - dt / PDF_TP_RAMP_OUT_S);
  if (!target && pdfSession.ease <= 0) {
    stopFrames();
    return;
  }
  // A zoom is landing, or a pinch is under way: stand still.
  if (pdfSession.holding || documentPinchEngaged()) {
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
    const glide = pdfSession.glide;
    const camera = cameraFor(pdfSession.cursor);
    const progress = Math.min(1, (now - glide.start) / glide.ms);
    const eased = easeInOut(progress);
    if (camera) {
      writeScroll(view,
        glide.fromTop + (camera.top - glide.fromTop) * eased,
        glide.fromLeft + (camera.left - glide.fromLeft) * eased);
    }
    if (progress >= 1) {
      pdfSession.glide = null;
      setGliding(false);
      placePdfBand();
    }
    schedulePdfFrame();
    return;
  }
  // Through the segment at the speed set: its words at so many a minute.
  const seconds = Math.max(0.5, (segment.words / Math.max(1, pdfSession.wpm)) * 60);
  pdfSession.cursor.t = Math.min(1, pdfSession.cursor.t + (pdfSession.ease * dt) / seconds);
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
      schedulePdfFrame();
      return;
    }
    // The next page's path is still being built: wait at the end of this one.
  }
  const camera = cameraFor(pdfSession.cursor);
  if (camera) writeScroll(view, camera.top, camera.left);
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
    if (pdfSession !== owner || owner.phase !== "playing" || !owner.settings.wake) {
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
  ended: "End of the PDF"
};

// The words still to come: the rest of this page's path, and every page after
// it at the average of the pages whose paths are known.
function wordsLeft() {
  const cursor = pdfSession?.cursor;
  if (!cursor || !openPdf) return 0;
  const path = pathFor(cursor.page);
  if (!path) return 0;
  let words = 0;
  path.segments.forEach((segment, index) => {
    if (index > cursor.index) words += segment.words;
    else if (index === cursor.index) words += segment.words * (1 - cursor.t);
  });
  const known = [];
  pathCache(pdfSession.pdf).forEach((value, key) => {
    if (!value.then && key.endsWith(`:${pdfSession.settings.columns}`)) known.push(pathWords(value));
  });
  const average = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 0;
  return words + average * Math.max(0, openPdf.pageCount - cursor.page);
}

function pdfTimeLeftText() {
  const words = wordsLeft();
  if (!(words > 0) || !pdfSession.wpm) return "";
  return `≈ ${formatDuration((words / pdfSession.wpm) * 60000, { short: true })} left`;
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
    resizeObserver: null
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
  paintPdfTeleprompterToggles();
  beginCountdown();
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
  if (pdfSession && pdfSession.pdf === pdf) return { scale: pdfSession.baseScale, fitWidth: pdfSession.baseFitWidth };
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
  letPdfScreenSleep();
  ending.resizeObserver?.disconnect();
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
  if (!pdfSession) return;
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
  if (!pdfSession) return;
  if (pdfSession.phase === "playing") pausePdfTeleprompter("button");
  else resumePdfTeleprompter();
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

// Back or on by a couple of lines: the view moves, and the cursor follows it
// on the next frame as it follows any other move.
function nudge(lines) {
  const view = el.documentView;
  if (!pdfSession || !view) return;
  const segment = currentSegment();
  const box = pdfSession.cursor ? tpPageBox(pdfSession.cursor.page) : null;
  const line = segment && box ? segment.linePitch * box.height : 24;
  view.scrollTop = Math.max(0, view.scrollTop + lines * line);
  if (pdfSession.phase === "ended" && lines < 0) {
    pdfSession.phase = "paused";
    pdfSession.pauseReason = "button";
  }
  paintPdfTeleprompter();
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
      schedulePdfFrame();
    }
    if (key === "zoomColumn" && before !== next) {
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
  if (before.columns !== pdfSession.settings.columns) {
    pdfSession.cursor = null;
    pdfSession.glide = null;
  }
  pdfSession.columnScale = 0;
  sizeRunway();
  placePdfBand();
  schedulePdfFrame();
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
  switch (event.key) {
    case " ":
    case "Spacebar":
      if (target?.closest?.("button, a, [role='button']")) return;
      act(togglePlay);
      return;
    case "ArrowUp": act(() => changeSpeed(TELEPROMPTER_RANGES.wpm.step)); return;
    case "ArrowDown": act(() => changeSpeed(-TELEPROMPTER_RANGES.wpm.step)); return;
    case "ArrowLeft": act(() => nudge(-2)); return;
    case "ArrowRight": act(() => nudge(2)); return;
    case "PageUp":
    case "PageDown":
    case "Home":
    case "End":
      if (pdfSession.phase === "playing" || pdfSession.phase === "countdown") pausePdfTeleprompter("reader");
      return;
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
